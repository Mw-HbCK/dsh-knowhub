/**
 * DSH Agent 工具（M3）：知识检索、详情、提议、修改、列表、Wiki 状态、初始化。
 *
 * 作用域铁律：工具不接受调用方传入的「作用域」参数。作用域只由服务端根据
 * 执行上下文里的会话 cwd（agent.session.header.cwd → realpath → 工作区注册表）
 * 推导；伪造 docId / kbId 只会得到 403，不会跨项目泄漏。
 *
 * 注册形态与 dsh-ops/lib/tools.js 一致：直接传原生 JSON Schema 的 parameters
 * 与 { schema, render } 的 output；ctx.tools.register 返回 disposer。
 */
import { all, openDatabase } from './db/db.js'
import { buildDiagnose } from './diagnostics.js'
import { resolveStorageRoot } from './paths.js'
import { getKnowledgeBase, listKnowledgeBases } from './kb/store.js'
import { countDocuments, DOC_KINDS, getDocument, listDocuments, searchDocuments, type DocRow } from './search.js'
import { listVersions } from './docvers.js'
import { autoApproveIfEligible, listProposals, createProposal, ReviewError } from './review.js'
import { readSettings } from './settings.js'
import { listConflicts } from './review.js'
import { getTask, listTasks } from './tasks.js'
import { indexSummary } from './pipeline/index.js'
import { startInitializeTask } from './pipeline/initialize.js'
import { assertDocVisible, assertKbVisible, scopeFromExec, type ScopeInfo } from './scope.js'

type ToolResult = { ok: boolean; [key: string]: any }

function jsonText(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function toolDefinition(config: {
  name: string
  description: string
  parameters: Record<string, unknown>
  readOnly?: boolean
  execute: (args: any, exec: any) => Promise<ToolResult>
}): any {
  return {
    name: config.name,
    description: config.description,
    ...(config.readOnly ? { isConcurrencySafe: () => true } : {}),
    parameters: config.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: unknown) => jsonText(value),
    },
    execute: config.execute,
  }
}

function fail(error: unknown): ToolResult {
  if (error instanceof ReviewError) return { ok: false, error: { code: error.code, message: error.message } }
  const code = (error as any)?.code
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { code: typeof code === 'string' ? code : 'KNOWLEDGE_ERROR', message } }
}

/** 选取本次调用要操作的知识库：必须落在当前作用域内。 */
function pickKb(handle: any, scope: ScopeInfo, requested: string | null): any {
  if (requested) return assertKbVisible(handle, requested, scope.scopeKeys)
  const candidates = listKnowledgeBases(handle, scope.scopeKeys).filter((kb: any) => kb.status !== 'disabled')
  if (candidates.length === 0) {
    throw new ReviewError('NO_KNOWLEDGE_BASE', 409, '当前工作区没有可用的知识库：请先在知枢面板中创建知识库')
  }
  const workspaceKb = candidates.find((kb: any) => kb.scope === 'workspace' && kb.workspaceId === scope.workspaceId)
  return workspaceKb ?? candidates[0]
}

export function registerKnowledgeTools(toolsCtx: any, hostCtx: any, config: any): void {
  const db = () => openDatabase(resolveStorageRoot(config))

  toolsCtx.tools.register(toolDefinition({
    name: 'knowledge_diagnose',
    description: 'KnowHub 环境诊断（只读）：DSH 运行时、存储目录、工作区列表、模型目录、SQLite FTS5。不会调用模型、不会写知识。',
    readOnly: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        section: { type: 'string', enum: ['all', 'runtime', 'storage', 'workspaces', 'models', 'sqlite', 'tools'], description: '诊断区段，默认 all' },
        path: { type: 'string', description: '可选：要反查工作区的目录，默认进程 cwd' },
      },
    },
    async execute(args: any): Promise<ToolResult> {
      return { ok: true, diagnose: await buildDiagnose(hostCtx, config, { section: args?.section ?? 'all', path: args?.path ?? null }) }
    },
  }))

  toolsCtx.tools.register(toolDefinition({
    name: 'knowledge_search',
    description:
      '检索知枢知识库（当前工作区可见的已批准知识 + 用户级共享知识）。返回来源、作用域、审核状态、验证状态。'
      + '默认只检索已批准（approved）知识；待审核草稿不能作为权威结论。',
    readOnly: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '关键词或短语；中文不足 3 字时自动回退 LIKE 检索' },
        kind: { type: 'string', enum: [...DOC_KINDS], description: '可选：知识类型过滤' },
        status: { type: 'string', enum: ['approved', 'draft', 'stale', 'any'], description: '审核状态过滤，默认 approved' },
        limit: { type: 'number', description: '返回条数，1–50，默认 10' },
      },
      required: ['query'],
    },
    async execute(args: any, exec: any): Promise<ToolResult> {
      try {
        const scope = await scopeFromExec(hostCtx, exec)
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        if (query === '') return { ok: false, error: { code: 'INVALID_INPUT', message: 'query 不能为空' } }
        const status = typeof args?.status === 'string' ? args.status : 'approved'
        const result = searchDocuments(db(), {
          query,
          scopeKeys: scope.scopeKeys,
          kind: typeof args?.kind === 'string' ? args.kind : undefined,
          status: status === 'any' ? 'any' : status,
          limit: Number(args?.limit ?? 10) || 10,
        })
        return {
          ok: true,
          workspaceId: scope.workspaceId,
          scopeKeys: scope.scopeKeys,
          mode: result.mode,
          total: result.total,
          results: result.hits.map((hit) => ({
            id: hit.id, title: hit.title, kind: hit.kind, scope: hit.scope, kbName: hit.kbName,
            status: hit.status, verifyState: hit.verifyState, snippet: hit.snippet, path: hit.path, updatedAt: hit.updatedAt,
          })),
          note: '结果仅来自当前会话可见作用域；status=draft 的内容未经审核，不能当作事实依据。',
        }
      } catch (error) { return fail(error) }
    },
  }))

  toolsCtx.tools.register(toolDefinition({
    name: 'knowledge_get',
    description: '读取一条知枢知识的完整正文、来源证据与版本历史。只能读取当前作用域内的知识。',
    readOnly: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        docId: { type: 'string', description: '知识 ID（来自 knowledge_search / knowledge_list）' },
      },
      required: ['docId'],
    },
    async execute(args: any, exec: any): Promise<ToolResult> {
      try {
        const scope = await scopeFromExec(hostCtx, exec)
        const handle = db()
        const doc = assertDocVisible(handle, String(args?.docId ?? ''), scope.scopeKeys)
        const sources = all(handle, 'SELECT kind, ref, locator, verified, created_at FROM sources WHERE doc_id = ? ORDER BY id', [doc.id]).map((raw: any) => ({
          kind: String(raw.kind), ref: String(raw.ref), locator: raw.locator === null ? null : String(raw.locator),
          verified: Number(raw.verified) === 1, createdAt: new Date(Number(raw.created_at)).toISOString(),
        }))
        return {
          ok: true,
          workspaceId: scope.workspaceId,
          document: doc,
          sources,
          versions: listVersions(handle, doc.id),
          authoritative: doc.status === 'approved',
          note: doc.status === 'approved' ? '该知识已审核通过，可作为结论依据。' : '该知识状态为 ' + doc.status + '，尚未审核通过，请勿当作已确认事实。',
        }
      } catch (error) { return fail(error) }
    },
  }))

  toolsCtx.tools.register(toolDefinition({
    name: 'knowledge_propose',
    description:
      '提交一条候选知识（新的长期记忆 / 决策 / 约定 / 待办等）。默认写入待审核队列，不会直接成为正式知识；'
      + '必须尽量给出证据来源（文件路径、会话、任务）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: '知识标题（≤100 字）' },
        body: { type: 'string', description: '知识正文（Markdown）' },
        kind: { type: 'string', enum: [...DOC_KINDS], description: '知识类型，默认 memory' },
        tags: { type: 'array', description: '标签数组', items: { type: 'string' } },
        verifyState: { type: 'string', enum: ['observed', 'inferred', 'assumed', 'unverified'], description: '验证状态：observed=观察事实 inferred=基于证据推断 assumed=假设 unverified=未验证' },
        sources: { type: 'array', description: '证据来源数组 [{kind:file|session|task|url|commit, ref, locator?}]', items: { type: 'object', additionalProperties: true } },
        reason: { type: 'string', description: '为什么要沉淀这条知识' },
        kbId: { type: 'string', description: '可选：目标知识库 ID，默认当前工作区知识库' },
      },
      required: ['title', 'body'],
    },
    async execute(args: any, exec: any): Promise<ToolResult> {
      try {
        const scope = await scopeFromExec(hostCtx, exec)
        const handle = db()
        const kb = pickKb(handle, scope, typeof args?.kbId === 'string' ? args.kbId : null)
        const proposal = createProposal(handle, kb, {
          kind: 'create', title: args?.title, body: args?.body, tags: args?.tags,
          docKind: args?.kind, verifyState: args?.verifyState, sources: args?.sources,
          reason: args?.reason, source: 'agent', createdBy: 'agent',
        })
        return { ok: true, proposalId: proposal.id, status: proposal.status, knowledgeBaseId: kb.id, message: '候选知识已进入待审核队列，需人工批准后才会成为正式知识：' + proposal.id }
      } catch (error) { return fail(error) }
    },
  }))

  toolsCtx.tools.register(toolDefinition({
    name: 'knowledge_update',
    description:
      '对一条已存在的知识提出修改（不直接覆盖）。修改会作为待审核候选记录基线版本；'
      + '若审核时该知识已被他人修改，将自动生成冲突审核项，绝不会静默覆盖已批准内容。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        docId: { type: 'string', description: '要修改的知识 ID' },
        body: { type: 'string', description: '修改后的完整正文' },
        title: { type: 'string', description: '可选：修改后的标题' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选：修改后的标签' },
        reason: { type: 'string', description: '修改理由 / 依据' },
      },
      required: ['docId', 'body'],
    },
    async execute(args: any, exec: any): Promise<ToolResult> {
      try {
        const scope = await scopeFromExec(hostCtx, exec)
        const handle = db()
        const doc = assertDocVisible(handle, String(args?.docId ?? ''), scope.scopeKeys)
        const kb = getKnowledgeBase(handle, doc.kbId)
        if (!kb) return { ok: false, error: { code: 'KB_NOT_FOUND', message: '知识所属知识库不存在' } }
        const proposal = createProposal(handle, kb, {
          kind: 'update', docId: doc.id, body: args?.body, title: args?.title, tags: args?.tags,
          reason: args?.reason, source: 'agent', createdBy: 'agent',
        })
        const settings = readSettings(handle)
        const auto = await autoApproveIfEligible(handle, resolveStorageRoot(config), proposal, { enabled: settings.autoApprove, maxDiffLines: settings.autoApproveMaxDiffLines, actor: 'auto:rule' })
        return {
          ok: true, proposalId: auto.proposal.id, baseVersion: auto.proposal.baseVersion, status: auto.proposal.status,
          autoApproved: auto.autoApproved,
          message: auto.autoApproved ? ('修改提案已按自动批准规则通过并落库：' + auto.proposal.id + '（' + (auto.reason ?? '') + '）') : ('修改提案已进入待审核队列：' + auto.proposal.id),
        }
      } catch (error) { return fail(error) }
    },
  }))

  toolsCtx.tools.register(toolDefinition({
    name: 'knowledge_list',
    description: '列出当前作用域内的知识条目（可按类型 / 审核状态过滤），默认只列已批准知识。',
    readOnly: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: [...DOC_KINDS] },
        status: { type: 'string', enum: ['approved', 'draft', 'stale', 'archived', 'any'] },
        kbId: { type: 'string', description: '可选：限定某个知识库' },
        limit: { type: 'number', description: '1–100，默认 20' },
      },
    },
    async execute(args: any, exec: any): Promise<ToolResult> {
      try {
        const scope = await scopeFromExec(hostCtx, exec)
        const handle = db()
        const kbs = listKnowledgeBases(handle, scope.scopeKeys)
        let kbIds = kbs.map((kb: any) => String(kb.id))
        if (typeof args?.kbId === 'string' && args.kbId !== '') kbIds = [assertKbVisible(handle, args.kbId, scope.scopeKeys).id]
        const status = typeof args?.status === 'string' && args.status !== 'any' ? args.status : (typeof args?.status === 'string' ? undefined : 'approved')
        const documents = listDocuments(handle, {
          kbIds,
          kind: typeof args?.kind === 'string' ? args.kind : undefined,
          status,
          limit: Number(args?.limit ?? 20) || 20,
        }).map((doc: DocRow) => ({ id: doc.id, kbId: doc.kbId, kbName: doc.kbName, title: doc.title, kind: doc.kind, status: doc.status, verifyState: doc.verifyState, tags: doc.tags, updatedAt: doc.updatedAt, path: doc.path }))
        return { ok: true, workspaceId: scope.workspaceId, count: documents.length, documents, knowledgeBases: kbs.map((kb: any) => ({ id: kb.id, name: kb.name, scope: kb.scope, status: kb.status })) }
      } catch (error) { return fail(error) }
    },
  }))

  toolsCtx.tools.register(toolDefinition({
    name: 'knowledge_wiki_status',
    description: '查看当前作用域内各知识库的 Repo Wiki 状态：文档数量、待审核数量、初始化任务进度、索引文件数。',
    readOnly: true,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_args: any, exec: any): Promise<ToolResult> {
      try {
        const scope = await scopeFromExec(hostCtx, exec)
        const handle = db()
        const kbs = listKnowledgeBases(handle, scope.scopeKeys)
        const entries = kbs.map((kb: any) => {
          const tasks = listTasks(handle, kb.id, 5)
          const latest = tasks.length > 0 ? tasks[0]! : null
          const counts = {
            total: countDocuments(handle, kb.id),
            approved: Number(all(handle, "SELECT COUNT(*) AS n FROM documents WHERE kb_id = ? AND deleted_at IS NULL AND status = 'approved'", [kb.id])[0]?.n ?? 0),
            draft: Number(all(handle, "SELECT COUNT(*) AS n FROM documents WHERE kb_id = ? AND deleted_at IS NULL AND status = 'draft'", [kb.id])[0]?.n ?? 0),
            stale: Number(all(handle, "SELECT COUNT(*) AS n FROM documents WHERE kb_id = ? AND deleted_at IS NULL AND status = 'stale'", [kb.id])[0]?.n ?? 0),
          }
          const pendingCount = listProposals(handle, { kbIds: [kb.id], status: 'pending', limit: 100 }).length
          const conflictCount = listConflicts(handle, { kbIds: [kb.id], status: 'pending', limit: 100 }).length
          return {
            id: kb.id, name: kb.name, scope: kb.scope, workspaceId: kb.workspaceId, status: kb.status,
            model: { provider: kb.modelProvider, id: kb.modelId, strategy: kb.modelStrategy },
            documents: counts, pendingProposals: pendingCount, pendingConflicts: conflictCount,
            index: indexSummary(handle, kb.id),
            latestTask: latest ? { id: latest.id, kind: latest.kind, status: latest.status, progress: latest.progress, stage: latest.stage, errorCode: latest.errorCode } : null,
          }
        })
        return { ok: true, workspaceId: scope.workspaceId, count: entries.length, knowledgeBases: entries }
      } catch (error) { return fail(error) }
    },
  }))

  toolsCtx.tools.register(toolDefinition({
    name: 'knowledge_initialize',
    description:
      '为当前工作区的知识库启动项目初始化（扫描 → 索引 → 用知识库绑定的模型生成 Repo Wiki 候选草稿）。'
      + '候选默认进入待审核，不会自动成为正式知识。重复调用在已有运行中任务时返回 duplicate。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kbId: { type: 'string', description: '可选：知识库 ID，默认当前工作区知识库' },
      },
    },
    async execute(args: any, exec: any): Promise<ToolResult> {
      try {
        const scope = await scopeFromExec(hostCtx, exec)
        if (!scope.workspaceId) return { ok: false, error: { code: 'WORKSPACE_REQUIRED', message: '当前会话目录不是已注册的 DSH 工作区，无法启动初始化' } }
        const handle = db()
        const kb = pickKb(handle, scope, typeof args?.kbId === 'string' ? args.kbId : null)
        if (kb.scope === 'workspace' && kb.workspaceId !== scope.workspaceId) {
          return { ok: false, error: { code: 'KB_FORBIDDEN', message: '该知识库绑定的是其他工作区，不能在此工作区初始化' } }
        }
        const result = startInitializeTask({ ctx: hostCtx, db: handle, storageRoot: resolveStorageRoot(config), kb, workspaceId: scope.workspaceId })
        const task = getTask(handle, result.task.id)
        return {
          ok: true,
          duplicate: result.duplicate,
          taskId: result.task.id,
          status: task?.status ?? result.task.status,
          knowledgeBaseId: kb.id,
          model: { provider: kb.modelProvider, id: kb.modelId, strategy: kb.modelStrategy },
          message: result.duplicate ? '已有初始化任务正在执行，未重复启动' : '初始化任务已启动；进度可用 knowledge_wiki_status 查询',
        }
      } catch (error) { return fail(error) }
    },
  }))
}
