/**
 * M1 知识与知识库 HTTP 接口。
 *
 * 隔离原则：
 * - 检索（/search）的作用域只由服务端从当前进程工作目录反查工作区得出，客户端传参不能扩大范围；
 * - 知识库管理接口（/kb*）属于管理面，允许按 workspaceId 查看，但不参与上下文注入。
 */
import { errorMessage, readBody, writeError, writeOk, writeText } from '../http.js'
import { all, openDatabase } from '../db/db.js'
import { resolveStorageRoot } from '../paths.js'
import {
  createKnowledgeBase, deleteKnowledgeBase, getKnowledgeBase, KbError,
  listAllKnowledgeBases, listKnowledgeBases, updateKnowledgeBase,
} from './store.js'
import { countDocumentList, countDocuments, createDocument, DocError, getDocument, listDocuments, resolveParentId, searchDocuments } from '../search.js'
import { addFeedback, FeedbackError, feedbackSummary, feedbackSummaries } from '../feedback.js'
import { exportKbMarkdown, importKbMarkdown, renderDocMarkdown, TransferError } from '../transfer.js'
import { run } from '../db/db.js'
import { readModelCatalog } from '../model.js'
import { listWorkspaces, resolveWorkspace } from '../workspace.js'
import { cancelTask, getTask, listTasks, retryTask, TaskError } from '../tasks.js'
import { executeInitialization, startInitializeTask } from '../pipeline/initialize.js'
import { indexSummary, listIndexedFiles } from '../pipeline/index.js'
import { executeIncremental, incrementalStatus, planIncremental, startIncrementalTask } from '../pipeline/incremental.js'
import { ensureDocSources, listFileChanges, listRecheck, readGitStateRow } from '../pipeline/changes.js'

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

async function currentWorkspace(ctx: any): Promise<{ workspaceId: string | null; path: string; title: string | null }> {
  const resolved = await resolveWorkspace(ctx, process.cwd())
  return { workspaceId: resolved.workspaceId, path: resolved.path, title: resolved.title }
}

function scopeKeysFor(workspaceId: string | null): string[] {
  return workspaceId ? ['user:*', 'ws:' + workspaceId] : ['user:*']
}

async function assertWorkspace(ctx: any, id: string): Promise<{ path: string; title: string }> {
  const listed = await listWorkspaces(ctx)
  for (const workspace of listed.workspaces) {
    if (workspace.id !== id) continue
    if (workspace.pathState === 'missing') throw new KbError('WORKSPACE_PATH_MISSING', 409, '工作区目录不可访问（可能已被移动或删除）：' + workspace.path)
    return { path: workspace.path, title: workspace.title }
  }
  throw new KbError('WORKSPACE_NOT_FOUND', 400, '未找到该工作区，请刷新工作区列表后重试：' + id)
}

async function assertModel(ctx: any, provider: string, model: string): Promise<void> {
  const catalog = await readModelCatalog(ctx)
  if (!catalog.available) throw new KbError('MODEL_CATALOG_UNAVAILABLE', 409, '无法读取 DSH 模型配置，请先在 DSH 中配置模型：' + (catalog.error ?? ''))
  if (catalog.models.length === 0) throw new KbError('NO_MODEL_CONFIGURED', 409, '当前 DSH 没有已配置的可用模型，请先在 DSH 设置中配置模型后再创建知识库')
  const found = catalog.models.some((entry) => entry.provider === provider && entry.id === model)
  if (!found) throw new KbError('MODEL_NOT_AVAILABLE', 400, '所选模型不在当前 DSH 模型列表中（提供方 ' + provider + ' / 模型 ' + model + '），请刷新后重新选择')
}

function withWorkspaceInfo(row: any, workspaces: Array<{ id: string; title: string; path: string }>): any {
  if (!row || row.scope !== 'workspace' || !row.workspaceId) return row
  const workspace = workspaces.find((item) => item.id === row.workspaceId)
  return { ...row, workspacePath: workspace?.path ?? null, workspaceTitle: workspace?.title ?? null }
}

export interface KbRequest {
  ctx: any
  config: any
  method: string
  path: string
  url: URL
  req: any
  res: any
}

export async function handleKbRequest(request: KbRequest): Promise<boolean> {
  const { ctx, config, method, path, url, req, res } = request
  const db = () => openDatabase(resolveStorageRoot(config))

  try {
    if (method === 'GET' && path === '/current-workspace') {
      const workspace = await currentWorkspace(ctx)
      const dbHandle = db()
      writeOk(res, { ...workspace, scopeKeys: scopeKeysFor(workspace.workspaceId), knowledgeBaseCount: listKnowledgeBases(dbHandle, scopeKeysFor(workspace.workspaceId)).length })
      return true
    }

    if (method === 'GET' && path === '/kb') {
      const requested = str(url.searchParams.get('workspaceId'))
      const wantAll = ['1', 'true', 'yes'].includes(str(url.searchParams.get('all')).toLowerCase())
      let workspaceId: string | null
      if (requested !== '') {
        const listed = await listWorkspaces(ctx)
        if (!listed.workspaces.some((workspace) => workspace.id === requested)) {
          writeError(res, 400, 'WORKSPACE_NOT_FOUND', '未找到该工作区：' + requested)
          return true
        }
        workspaceId = requested
      } else {
        workspaceId = (await currentWorkspace(ctx)).workspaceId
      }
      const listed = await listWorkspaces(ctx)
      const workspaces = listed.workspaces.map((workspace) => ({ id: workspace.id, title: workspace.title, path: workspace.path }))
      // 管理面全量视图：知识库可能建在任意工作区，只按「当前工作区」过滤会导致刚建好的库看不见
      // （同名却报已存在）。all=1 返回所有未删除知识库，并带 workspaceTitle 便于辨认。
      const source = wantAll ? listAllKnowledgeBases(db()) : listKnowledgeBases(db(), scopeKeysFor(workspaceId))
      const rows = source.map((row) => ({
        ...withWorkspaceInfo(row, workspaces),
        documentCount: countDocuments(db(), row.id),
      }))
      writeOk(res, {
        all: wantAll,
        workspaceId,
        currentWorkspaceId: workspaceId,
        scopeKeys: scopeKeysFor(workspaceId),
        count: rows.length,
        knowledgeBases: rows,
      })
      return true
    }

    if (method === 'POST' && path === '/kb') {
      const body = (await readBody(req)) ?? {}
      const scope = str(body.scope)
      let workspacePath: string | null = null
      let workspaceTitle: string | null = null
      if (scope === 'workspace') {
        const workspace = await assertWorkspace(ctx, str(body.workspaceId))
        workspacePath = workspace.path
        workspaceTitle = workspace.title
      }
      await assertModel(ctx, str(body.modelProvider), str(body.modelId))
      const row = await createKnowledgeBase(db(), body, {
        storageRoot: resolveStorageRoot(config),
        workspacePath,
        workspaceTitle,
      })
      writeOk(res, {
        knowledgeBase: row,
        message: '知识库已创建。配置已保存，初始化（扫描项目并生成 Wiki）需要另外启动，不会自动执行。',
        nextAction: 'start-initialize',
      })
      return true
    }

    const initialize = /^\/kb\/([^/]+)\/initialize$/.exec(path)
    if (initialize && method === 'POST') {
      const id = decodeURIComponent(initialize[1] ?? '')
      const row = getKnowledgeBase(db(), id)
      if (!row) {
        writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + id)
        return true
      }
      const body = (await readBody(req)) ?? {}
      let workspaceId: string | null = row.workspaceId
      if (workspaceId === null || workspaceId === '') {
        workspaceId = str(body.workspaceId)
        if (workspaceId === '') {
          writeError(res, 400, 'WORKSPACE_REQUIRED', '用户级知识库初始化时必须指定要分析的工作区（body.workspaceId）')
          return true
        }
      }
      const workspace = await assertWorkspace(ctx, workspaceId)
      const started = startInitializeTask({ ctx, db: db(), storageRoot: resolveStorageRoot(config), kb: row, workspaceId })
      writeOk(res, {
        task: started.task,
        duplicate: started.duplicate,
        workspace: { id: workspaceId, path: workspace.path, title: workspace.title },
        message: started.duplicate ? '该知识库已有初始化任务在执行，未重复启动' : '初始化任务已启动：将扫描项目并按绑定模型生成 Wiki 候选',
      })
      return true
    }

    const kbIncremental = /^\/kb\/([^/]+)\/incremental$/.exec(path)
    if (kbIncremental && method === 'POST') {
      const id = decodeURIComponent(kbIncremental[1] ?? '')
      const row = getKnowledgeBase(db(), id)
      if (!row) {
        writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + id)
        return true
      }
      const body = (await readBody(req)) ?? {}
      let workspaceId: string | null = row.workspaceId
      if (workspaceId === null || workspaceId === '') {
        workspaceId = str(body.workspaceId)
        if (workspaceId === '') {
          writeError(res, 400, 'WORKSPACE_REQUIRED', '用户级知识库执行增量更新时必须指定工作区（body.workspaceId）')
          return true
        }
      }
      await assertWorkspace(ctx, workspaceId)
      if (body.dryRun === true) {
        const plan = await planIncremental({ ctx, db: db(), storageRoot: resolveStorageRoot(config), kb: row, workspaceId })
        writeOk(res, plan)
        return true
      }
      const started = startIncrementalTask({ ctx, db: db(), storageRoot: resolveStorageRoot(config), kb: row, workspaceId })
      writeOk(res, {
        task: started.task,
        duplicate: started.duplicate,
        workspaceId,
        message: started.duplicate ? '该知识库已有增量更新任务在执行，未重复启动' : '增量更新任务已启动：Git/哈希变更 → 受影响文档 → 绑定模型生成候选',
      })
      return true
    }

    const kbGit = /^\/kb\/([^/]+)\/git$/.exec(path)
    if (kbGit && method === 'GET') {
      const id = decodeURIComponent(kbGit[1] ?? '')
      const row = getKnowledgeBase(db(), id)
      if (!row) { writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + id); return true }
      writeOk(res, await incrementalStatus(ctx, db(), row))
      return true
    }

    const kbChanges = /^\/kb\/([^/]+)\/changes$/.exec(path)
    if (kbChanges && method === 'GET') {
      const id = decodeURIComponent(kbChanges[1] ?? '')
      if (!getKnowledgeBase(db(), id)) { writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + id); return true }
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 200) || 200))
      writeOk(res, {
        knowledgeBaseId: id,
        checkpoint: readGitStateRow(db(), id),
        changes: listFileChanges(db(), id, limit),
        recheck: listRecheck(db(), id, limit),
      })
      return true
    }

    const kbTasks = /^\/kb\/([^/]+)\/tasks$/.exec(path)
    if (kbTasks && method === 'GET') {
      const id = decodeURIComponent(kbTasks[1] ?? '')
      if (!getKnowledgeBase(db(), id)) { writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在'); return true }
      const rows = listTasks(db(), id, Number(url.searchParams.get('limit') ?? 20) || 20)
      const active = rows.find((task) => task.status === 'queued' || task.status === 'running') ?? null
      writeOk(res, { knowledgeBaseId: id, count: rows.length, active, tasks: rows })
      return true
    }

    const kbFiles = /^\/kb\/([^/]+)\/files$/.exec(path)
    if (kbFiles && method === 'GET') {
      const id = decodeURIComponent(kbFiles[1] ?? '')
      if (!getKnowledgeBase(db(), id)) { writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在'); return true }
      writeOk(res, {
        knowledgeBaseId: id,
        summary: indexSummary(db(), id),
        files: listIndexedFiles(db(), id, Number(url.searchParams.get('limit') ?? 200) || 200),
      })
      return true
    }

    const kbCalls = /^\/kb\/([^/]+)\/llm-calls$/.exec(path)
    if (kbCalls && method === 'GET') {
      const id = decodeURIComponent(kbCalls[1] ?? '')
      if (!getKnowledgeBase(db(), id)) { writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在'); return true }
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50))
      const rows = all(db(), 'SELECT id, kb_id, task_id, provider, model, purpose, prompt_tokens, completion_tokens, latency_ms, finish_kind, failure_code, created_at FROM llm_calls WHERE kb_id = ? ORDER BY created_at DESC LIMIT ?', [id, limit])
      writeOk(res, {
        knowledgeBaseId: id,
        count: rows.length,
        calls: rows.map((raw: any) => ({
          id: String(raw.id),
          taskId: raw.task_id === null ? null : String(raw.task_id),
          provider: String(raw.provider),
          model: String(raw.model),
          purpose: raw.purpose === null ? null : String(raw.purpose),
          promptTokens: raw.prompt_tokens === null ? null : Number(raw.prompt_tokens),
          completionTokens: raw.completion_tokens === null ? null : Number(raw.completion_tokens),
          latencyMs: raw.latency_ms === null ? null : Number(raw.latency_ms),
          finishKind: raw.finish_kind === null ? null : String(raw.finish_kind),
          failureCode: raw.failure_code === null ? null : String(raw.failure_code),
          createdAt: new Date(Number(raw.created_at)).toISOString(),
        })),
      })
      return true
    }

    const taskDetail = /^\/tasks\/([^/]+)$/.exec(path)
    if (taskDetail && method === 'GET') {
      const task = getTask(db(), decodeURIComponent(taskDetail[1] ?? ''))
      if (!task) {
        writeError(res, 404, 'TASK_NOT_FOUND', '任务不存在')
        return true
      }
      writeOk(res, { task })
      return true
    }

    const taskCancel = /^\/tasks\/([^/]+)\/cancel$/.exec(path)
    if (taskCancel && method === 'POST') {
      const task = cancelTask(db(), decodeURIComponent(taskCancel[1] ?? ''))
      writeOk(res, { task, message: '取消请求已提交，任务会在当前步骤结束时停止' })
      return true
    }

    const taskRetry = /^\/tasks\/([^/]+)\/retry$/.exec(path)
    if (taskRetry && method === 'POST') {
      const previous = getTask(db(), decodeURIComponent(taskRetry[1] ?? ''))
      if (!previous) {
        writeError(res, 404, 'TASK_NOT_FOUND', '任务不存在')
        return true
      }
      if (previous.kind !== 'initialize' && previous.kind !== 'incremental') {
        writeError(res, 400, 'TASK_KIND_UNSUPPORTED', '只支持重试初始化与增量更新任务')
        return true
      }
      const kbRow = getKnowledgeBase(db(), previous.kbId)
      if (!kbRow) {
        writeError(res, 404, 'KB_NOT_FOUND', '任务对应的知识库不存在')
        return true
      }
      const task = retryTask(db(), previous.id)
      const workspaceId = task.input?.workspaceId ?? kbRow.workspaceId ?? null
      if (workspaceId === null || workspaceId === '') {
        writeError(res, 400, 'WORKSPACE_REQUIRED', '用户级知识库重试任务时必须指定工作区')
        return true
      }
      await assertWorkspace(ctx, workspaceId)
      if (previous.kind === 'incremental') {
        executeIncremental({ ctx, db: db(), storageRoot: resolveStorageRoot(config), kb: kbRow, task, workspaceId })
      } else {
        executeInitialization({ ctx, db: db(), storageRoot: resolveStorageRoot(config), kb: kbRow, task, workspaceId })
      }
      writeOk(res, { task, message: '重试任务已启动' })
      return true
    }

    const detail = /^\/kb\/([^/]+)$/.exec(path)
    if (detail && method === 'GET') {
      const id = decodeURIComponent(detail[1] ?? '')
      const row = getKnowledgeBase(db(), id)
      if (!row) {
        writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + id)
        return true
      }
      const listed = await listWorkspaces(ctx)
      const workspaces = listed.workspaces.map((workspace) => ({ id: workspace.id, title: workspace.title, path: workspace.path }))
      writeOk(res, { knowledgeBase: withWorkspaceInfo(row, workspaces), documentCount: countDocuments(db(), id) })
      return true
    }

    if (detail && method === 'PATCH') {
      const id = decodeURIComponent(detail[1] ?? '')
      const body = (await readBody(req)) ?? {}
      if (body.modelProvider !== undefined || body.modelId !== undefined) {
        await assertModel(ctx, str(body.modelProvider), str(body.modelId))
      }
      const row = await updateKnowledgeBase(db(), resolveStorageRoot(config), id, body)
      writeOk(res, { knowledgeBase: row, message: '知识库配置已更新' })
      return true
    }

    if (detail && method === 'DELETE') {
      const id = decodeURIComponent(detail[1] ?? '')
      const mode = str(url.searchParams.get('mode')) || 'config'
      if (mode !== 'config' && mode !== 'files' && mode !== 'all') {
        writeError(res, 400, 'KB_INVALID_MODE', '删除模式只能是 config / files / all')
        return true
      }
      writeOk(res, { result: await deleteKnowledgeBase(db(), resolveStorageRoot(config), id, mode), message: '删除操作已执行' })
      return true
    }

    const docs = /^\/kb\/([^/]+)\/docs$/.exec(path)
    if (docs && method === 'GET') {
      const id = decodeURIComponent(docs[1] ?? '')
      const row = getKnowledgeBase(db(), id)
      if (!row) {
        writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + id)
        return true
      }
      const parentParam = url.searchParams.get('parentId')
      const parentId = parentParam === null ? undefined : str(parentParam) === '' || str(parentParam) === 'root' ? null : str(parentParam)
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 50) || 50))
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0)
      const filters = {
        kbIds: [id],
        kind: str(url.searchParams.get('kind')) || undefined,
        status: str(url.searchParams.get('status')) || undefined,
        parentId,
      }
      const items = listDocuments(db(), { ...filters, limit, offset })
      const total = countDocumentList(db(), filters)
      const feedback = feedbackSummaries(db(), items.map((item) => item.id))
      writeOk(res, {
        knowledgeBaseId: id, count: items.length, total, limit, offset, parentId: parentId === undefined ? null : parentId,
        documents: items, feedback,
      })
      return true
    }

    if (docs && method === 'POST') {
      const id = decodeURIComponent(docs[1] ?? '')
      const row = getKnowledgeBase(db(), id)
      if (!row) {
        writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + id)
        return true
      }
      const body = (await readBody(req)) ?? {}
      const doc = await createDocument(db(), resolveStorageRoot(config), row, body)
      const refs = (Array.isArray(body.sources) ? body.sources : [])
        .map((item: any) => (typeof item === 'string' ? item : item && typeof item.ref === 'string' ? item.ref : ''))
        .map((value: string) => value.trim().split('\\').join('/').replace(/^\.\//, ''))
        .filter((value: string) => value !== '' && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.split('/').includes('..'))
      let sourcesAdded = 0
      if (refs.length > 0) {
        const indexed = new Set(all(db(), 'SELECT path FROM project_files WHERE kb_id = ?', [row.id]).map((entry: any) => String(entry.path)))
        const known = refs.filter((ref: string) => indexed.has(ref))
        const unknown = refs.filter((ref: string) => !indexed.has(ref))
        sourcesAdded += ensureDocSources(db(), doc.id, 'file', known, 1)
        sourcesAdded += ensureDocSources(db(), doc.id, 'file', unknown, 0)
      }
      writeOk(res, { document: doc, sourcesAdded, message: doc.status === 'draft' ? '知识已保存为待审核草稿' : '知识已保存' })
      return true
    }

    const docDetail = /^\/kb\/([^/]+)\/docs\/([^/]+)$/.exec(path)
    if (docDetail && method === 'GET') {
      const kbId = decodeURIComponent(docDetail[1] ?? '')
      const docId = decodeURIComponent(docDetail[2] ?? '')
      const doc = getDocument(db(), docId)
      if (!doc || doc.kbId !== kbId) {
        writeError(res, 404, 'DOC_NOT_FOUND', '知识不存在：' + docId)
        return true
      }
      const sources = all(db(), 'SELECT id, kind, ref, locator, excerpt_hash, verified, created_at FROM sources WHERE doc_id = ? ORDER BY id', [docId]).map((raw: any) => ({
        id: raw.id, kind: raw.kind, ref: raw.ref, locator: raw.locator,
        excerptHash: raw.excerpt_hash, verified: Number(raw.verified) === 1,
        createdAt: new Date(Number(raw.created_at)).toISOString(),
      }))
      const versions = all(db(), 'SELECT version, change_kind, source, actor, reason, content_hash, created_at FROM doc_versions WHERE doc_id = ? ORDER BY version DESC', [docId]).map((raw: any) => ({
        version: Number(raw.version), changeKind: raw.change_kind, source: raw.source,
        actor: raw.actor, reason: raw.reason, contentHash: raw.content_hash,
        createdAt: new Date(Number(raw.created_at)).toISOString(),
      }))
      const children = listDocuments(db(), { kbIds: [kbId], parentId: docId, limit: 200 })
      const parent = doc.parentId === null ? null : getDocument(db(), doc.parentId)
      writeOk(res, {
        document: doc, sources, versions,
        feedback: feedbackSummary(db(), docId),
        parent: parent === null ? null : { id: parent.id, title: parent.title, kind: parent.kind },
        children: children.map((child) => ({ id: child.id, title: child.title, kind: child.kind, status: child.status })),
      })
      return true
    }

    // 设置 / 取消上级知识（结构性元数据，不改正文、不产生内容版本）
    const docParent = /^\/kb\/([^/]+)\/docs\/([^/]+)\/parent$/.exec(path)
    if (docParent && method === 'POST') {
      const kbId = decodeURIComponent(docParent[1] ?? '')
      const docId = decodeURIComponent(docParent[2] ?? '')
      const row = getKnowledgeBase(db(), kbId)
      if (!row) {
        writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + kbId)
        return true
      }
      const doc = getDocument(db(), docId)
      if (!doc || doc.kbId !== kbId) {
        writeError(res, 404, 'DOC_NOT_FOUND', '知识不存在：' + docId)
        return true
      }
      const body = (await readBody(req)) ?? {}
      const parentId = resolveParentId(db(), kbId, docId, body.parentId)
      run(db(), 'UPDATE documents SET parent_id = ?, updated_at = ? WHERE id = ?', [parentId, Date.now(), docId])
      writeOk(res, {
        document: getDocument(db(), docId),
        message: parentId === null ? '已取消上级知识，该知识变回顶层' : '已设置上级知识',
      })
      return true
    }

    // 单篇知识导出 Markdown
    const docExport = /^\/kb\/([^/]+)\/docs\/([^/]+)\/export$/.exec(path)
    if (docExport && method === 'GET') {
      const kbId = decodeURIComponent(docExport[1] ?? '')
      const docId = decodeURIComponent(docExport[2] ?? '')
      const doc = getDocument(db(), docId)
      if (!doc || doc.kbId !== kbId) {
        writeError(res, 404, 'DOC_NOT_FOUND', '知识不存在：' + docId)
        return true
      }
      const filename = (doc.slug || 'knowledge') + '.md'
      writeText(res, 200, renderDocMarkdown(doc), 'text/markdown; charset=utf-8', filename)
      return true
    }

    // 「是否有帮助」反馈
    const docFeedback = /^\/kb\/([^/]+)\/docs\/([^/]+)\/feedback$/.exec(path)
    if (docFeedback && method === 'POST') {
      const kbId = decodeURIComponent(docFeedback[1] ?? '')
      const docId = decodeURIComponent(docFeedback[2] ?? '')
      const doc = getDocument(db(), docId)
      if (!doc || doc.kbId !== kbId) {
        writeError(res, 404, 'DOC_NOT_FOUND', '知识不存在：' + docId)
        return true
      }
      const body = (await readBody(req)) ?? {}
      const created = addFeedback(db(), doc, { helpful: body.helpful, reason: body.reason, actor: body.actor })
      writeOk(res, {
        feedback: created,
        summary: feedbackSummary(db(), docId),
        message: created.helpful ? '已记录：这条知识有帮助' : '已记录：这条知识没帮上忙',
      })
      return true
    }

    // 整库导出 Markdown
    const kbExport = /^\/kb\/([^/]+)\/export$/.exec(path)
    if (kbExport && method === 'GET') {
      const kbId = decodeURIComponent(kbExport[1] ?? '')
      const row = getKnowledgeBase(db(), kbId)
      if (!row) {
        writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + kbId)
        return true
      }
      if (str(url.searchParams.get('format') ?? 'markdown') === 'json') {
        writeOk(res, { result: exportKbMarkdown(db(), row) })
        return true
      }
      const exported = exportKbMarkdown(db(), row)
      writeText(res, 200, exported.content, 'text/markdown; charset=utf-8', exported.filename)
      return true
    }

    // 导入 Markdown（一律落待审核草稿）
    const kbImport = /^\/kb\/([^/]+)\/import$/.exec(path)
    if (kbImport && method === 'POST') {
      const kbId = decodeURIComponent(kbImport[1] ?? '')
      const row = getKnowledgeBase(db(), kbId)
      if (!row) {
        writeError(res, 404, 'KB_NOT_FOUND', '知识库不存在：' + kbId)
        return true
      }
      const body = (await readBody(req, 4 * 1024 * 1024)) ?? {}
      const result = await importKbMarkdown(db(), resolveStorageRoot(config), row, { content: body.content, actor: body.actor })
      writeOk(res, {
        result,
        message: '导入完成：新建 ' + result.created.length + ' 篇草稿，跳过 ' + result.skipped.length + ' 篇，失败 ' + result.failed.length + ' 篇；草稿需人工审核后才会成为正式知识',
      })
      return true
    }

    if (method === 'GET' && path === '/search') {
      const workspace = await currentWorkspace(ctx)
      const query = str(url.searchParams.get('q') ?? url.searchParams.get('query') ?? '')
      const result = searchDocuments(db(), {
        query,
        scopeKeys: scopeKeysFor(workspace.workspaceId),
        kbId: str(url.searchParams.get('kbId')) || undefined,
        kind: str(url.searchParams.get('kind')) || undefined,
        status: str(url.searchParams.get('status')) || 'any',
        tags: [...url.searchParams.getAll('tag'), ...(url.searchParams.get('tags') ?? '').split(',')]
          .flatMap((item) => item.split(',')).map((item) => item.trim()).filter((item) => item !== '').slice(0, 6),
        sort: str(url.searchParams.get('sort')) === 'updated' ? 'updated' : 'relevance',
        limit: Number(url.searchParams.get('limit') ?? 20) || 20,
        offset: Number(url.searchParams.get('offset') ?? 0) || 0,
      })
      writeOk(res, { query, workspaceId: workspace.workspaceId, scopeKeys: scopeKeysFor(workspace.workspaceId), ...result })
      return true
    }

    return false
  } catch (error) {
    if (error instanceof KbError || error instanceof DocError || error instanceof TaskError || error instanceof FeedbackError || error instanceof TransferError) {
      writeError(res, error.status, error.code, error.message)
      return true
    }
    writeError(res, 500, 'INTERNAL_ERROR', errorMessage(error))
    return true
  }
}
