/**
 * M3 审核 HTTP 接口（前缀 /knowhub/api）。
 *
 * 作用域：审核是「人」对本地知识库的管理动作，因此队列、详情、差异、冲突与批量覆盖
 * 所有未删除的知识库（用户级 + 各工作区），不按当前工作区过滤——桌面版宿主进程的 cwd 是
 * 应用目录，反查不到工作区，按工作区过滤会让其它工作区的草稿/候选完全不可见。
 * 检索与上下文注入仍按工作区隔离（scope.ts / search.ts），不受本文件影响。
 */
import { errorMessage, readBody, writeError, writeOk } from '../http.js'
import { all, openDatabase } from '../db/db.js'
import { resolveStorageRoot } from '../paths.js'
import { getKnowledgeBase, KbError } from '../kb/store.js'
import { DocError, getDocument } from '../search.js'
import { diffLines, diffVersions, getVersionContent, listVersions, restoreVersion } from '../docvers.js'
import {
  approveDocumentWithEdits, approveProposal, autoApproveIfEligible, bulkReview, createProposal, getConflict, getProposal,
  listReviewLog, recordReviewLog, rejectProposal, resolveConflict, reviewDocument, reviewQueue, ReviewError, updateDocumentByHuman,
} from '../review.js'
import { readSettings } from '../settings.js'
import { resolveScope } from '../scope.js'

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 审核覆盖本地全部知识库，这里只校验存在性（没有工作区范围限制）。 */
function assertKb(db: any, id: string): any {
  const kb = getKnowledgeBase(db, id)
  if (!kb) throw new ReviewError('KB_NOT_FOUND', 404, '知识库不存在：' + id)
  return kb
}

/** 本地全部未删除知识库的 id：审核队列与日志的统计范围。 */
function allKbIds(db: any): string[] {
  return all(db, 'SELECT id FROM knowledge_bases WHERE deleted_at IS NULL').map((row: any) => String(row.id))
}

/** 组装「当前已批准内容 → 提议内容」的行级差异，供面板对比页直接渲染。 */
function buildDiffPayload(input: {
  baseTitle: string | null
  baseBody: string
  baseVersion: number | null
  baseStatus: string | null
  targetTitle: string | null
  targetBody: string
}) {
  // 新增知识没有基线正文：整体视为新增，避免与空行做 LCS 时出现「未变」的错觉。
  const result = input.baseBody === '' && input.baseVersion === null
    ? { lines: input.targetBody.replace(/\r\n/g, '\n').split('\n').map((text) => ({ type: 'add' as const, text })), truncated: false }
    : diffLines(input.baseBody, input.targetBody)
  const stats = { added: 0, removed: 0, unchanged: 0 }
  for (const line of result.lines) {
    if (line.type === 'add') stats.added += 1
    else if (line.type === 'del') stats.removed += 1
    else stats.unchanged += 1
  }
  return {
    base: { title: input.baseTitle, body: input.baseBody, version: input.baseVersion, status: input.baseStatus },
    target: { title: input.targetTitle, body: input.targetBody },
    diff: { lines: result.lines, truncated: result.truncated, stats },
  }
}

function assertDoc(db: any, kbId: string, docId: string): any {
  const doc = getDocument(db, docId)
  if (!doc || doc.kbId !== kbId) throw new ReviewError('DOC_NOT_FOUND', 404, '知识不存在：' + docId)
  return doc
}

/** 未显式传入审核人时使用设置里的 reviewerName（默认系统用户名）。 */
function resolveActor(handle: any, explicit: unknown): string {
  const value = str(explicit)
  if (value !== '') return value
  try {
    const name = readSettings(handle).reviewerName
    return name === '' ? 'web' : name
  } catch {
    return 'web'
  }
}

function autoApproveRules(handle: any): { enabled: boolean; maxDiffLines: number; actor: string } {
  const settings = readSettings(handle)
  return { enabled: settings.autoApprove, maxDiffLines: settings.autoApproveMaxDiffLines, actor: 'auto:rule' }
}

export interface ReviewRequest {
  ctx: any
  config: any
  method: string
  path: string
  url: URL
  req: any
  res: any
}

export async function handleReviewRequest(request: ReviewRequest): Promise<boolean> {
  const { ctx, config, method, path, url, req, res } = request
  const db = () => openDatabase(resolveStorageRoot(config))
  const storageRoot = () => resolveStorageRoot(config)
  try {
    if (method === 'GET' && path === '/review') {
      const scope = await resolveScope(ctx, process.cwd())
      const handle = db()
      const kbIds = allKbIds(handle)
      const kbId = str(url.searchParams.get('kbId'))
      let target = kbIds
      if (kbId !== '') {
        if (!kbIds.includes(kbId)) throw new ReviewError('KB_NOT_FOUND', 404, '知识库不存在：' + kbId)
        target = [kbId]
      }
      const queue = reviewQueue(handle, target, {
        limit: Number(url.searchParams.get('limit') ?? 50) || 50,
        page: Number(url.searchParams.get('page') ?? 1) || 1,
        kind: url.searchParams.get('kind'),
        q: url.searchParams.get('q'),
        source: url.searchParams.get('source'),
        order: url.searchParams.get('order'),
      })
      writeOk(res, { workspaceId: scope.workspaceId, scopeKeys: scope.scopeKeys, ...queue })
      return true
    }

    if (method === 'GET' && path === '/review/log') {
      const handle = db()
      const kbIds = allKbIds(handle)
      writeOk(res, { entries: listReviewLog(handle, { kbIds, limit: Number(url.searchParams.get('limit') ?? 50) || 50 }) })
      return true
    }

    const proposalDetail = /^\/review\/proposals\/([^/]+)$/.exec(path)
    if (proposalDetail && method === 'GET') {
      const handle = db()
      const id = decodeURIComponent(proposalDetail[1] ?? '')
      const proposal = getProposal(handle, id)
      if (!proposal) throw new ReviewError('PROPOSAL_NOT_FOUND', 404, '候选不存在：' + id)
      const kb = getKnowledgeBase(handle, proposal.kbId)
      if (!kb) throw new ReviewError('KB_NOT_FOUND', 404, '候选所属知识库不存在：' + proposal.kbId)
      const doc = proposal.docId ? getDocument(handle, proposal.docId) : null
      const currentDiff = doc ? diffVersions(handle, doc, null, null) : null
      writeOk(res, { proposal, document: doc, currentDiff })
      return true
    }

    const proposalDiff = /^\/review\/proposals\/([^/]+)\/diff$/.exec(path)
    if (proposalDiff && method === 'GET') {
      const handle = db()
      const id = decodeURIComponent(proposalDiff[1] ?? '')
      const proposal = getProposal(handle, id)
      if (!proposal) throw new ReviewError('PROPOSAL_NOT_FOUND', 404, '候选不存在：' + id)
      const kb = getKnowledgeBase(handle, proposal.kbId)
      if (!kb) throw new ReviewError('KB_NOT_FOUND', 404, '候选所属知识库不存在：' + proposal.kbId)
      const doc = proposal.docId ? getDocument(handle, proposal.docId) : null
      const payload = buildDiffPayload({
        baseTitle: doc ? doc.title : null,
        baseBody: doc ? doc.body : '',
        baseVersion: doc ? doc.currentVersion : null,
        baseStatus: doc ? doc.status : null,
        targetTitle: proposal.title,
        targetBody: proposal.body,
      })
      writeOk(res, {
        kind: 'proposal',
        proposal,
        document: doc ? { id: doc.id, title: doc.title, currentVersion: doc.currentVersion, status: doc.status, kind: doc.kind } : null,
        kb: { id: kb.id, name: kb.name, scopeKey: kb.scopeKey },
        ...payload,
      })
      return true
    }

    const proposalAction = /^\/review\/proposals\/([^/]+)\/(approve|reject)$/.exec(path)
    if (proposalAction && method === 'POST') {
      const handle = db()
      const id = decodeURIComponent(proposalAction[1] ?? '')
      const action = proposalAction[2] ?? ''
      const existing = getProposal(handle, id)
      if (!existing) throw new ReviewError('PROPOSAL_NOT_FOUND', 404, '候选不存在：' + id)
      const kb = getKnowledgeBase(handle, existing.kbId)
      if (!kb) throw new ReviewError('KB_NOT_FOUND', 404, '候选所属知识库不存在：' + existing.kbId)
      const body = (await readBody(req)) ?? {}
      if (action === 'reject') {
        const proposal = rejectProposal(handle, id, { actor: resolveActor(handle, body.actor), note: str(body.note) || null })
        writeOk(res, { proposal, message: '已拒绝该候选知识' })
        return true
      }
      const result = await approveProposal(handle, storageRoot(), id, {
        actor: resolveActor(handle, body.actor),
        note: str(body.note) || null,
        title: typeof body.title === 'string' ? body.title : null,
        body: typeof body.body === 'string' ? body.body : null,
      })
      writeOk(res, { ...result, message: result.conflict ? '检测到版本冲突，已生成冲突审核项，未覆盖当前知识' : '审核通过，已写入正式知识库' })
      return true
    }

    if (method === 'POST' && path === '/review/bulk') {
      const handle = db()
      const body = (await readBody(req)) ?? {}
      const rawItems = Array.isArray(body.items) ? body.items : []
      if (rawItems.length === 0) throw new ReviewError('BULK_EMPTY', 400, '请至少选择一条待审核项')
      if (rawItems.length > 50) throw new ReviewError('BULK_TOO_MANY', 400, '单次批量最多 50 条，请分批处理')
      const items: Array<{ type: 'proposal' | 'doc'; id: string }> = []
      for (const raw of rawItems) {
        const type = str(raw?.type)
        const id = str(raw?.id)
        if ((type !== 'proposal' && type !== 'doc') || id === '') throw new ReviewError('BULK_INVALID_ITEM', 400, '批量项必须是 {type:"proposal"|"doc", id}')
        // 不存在的 id 不在这里 404：交给 bulkReview 逐条记录失败，避免一条脏 id 让整批失败。
        // 审核覆盖全部知识库，这里只做「对象存在但所属知识库已不存在」的一致性校验。
        if (type === 'proposal') {
          const proposal = getProposal(handle, id)
          if (proposal && !getKnowledgeBase(handle, proposal.kbId)) throw new ReviewError('KB_NOT_FOUND', 404, '候选所属知识库不存在：' + id)
        } else {
          const doc = getDocument(handle, id)
          if (doc && !getKnowledgeBase(handle, doc.kbId)) throw new ReviewError('KB_NOT_FOUND', 404, '知识所属知识库不存在：' + id)
        }
        items.push({ type, id })
      }
      const action = str(body.action) === 'reject' ? 'reject' : 'approve'
      const result = await bulkReview(handle, storageRoot(), items, action, { actor: resolveActor(handle, body.actor), note: str(body.note) || null })
      writeOk(res, { ...result, action, message: '批量' + (action === 'approve' ? '批准' : '拒绝') + '完成：成功 ' + (result.approved + result.rejected) + ' 条，失败 ' + result.failed + ' 条' })
      return true
    }

    const conflictDiff = /^\/review\/conflicts\/([^/]+)\/diff$/.exec(path)
    if (conflictDiff && method === 'GET') {
      const handle = db()
      const id = decodeURIComponent(conflictDiff[1] ?? '')
      const conflict = getConflict(handle, id)
      if (!conflict) throw new ReviewError('CONFLICT_NOT_FOUND', 404, '冲突不存在：' + id)
      const kb = getKnowledgeBase(handle, conflict.kbId)
      if (!kb) throw new ReviewError('KB_NOT_FOUND', 404, '冲突所属知识库不存在：' + conflict.kbId)
      const doc = getDocument(handle, conflict.docId)
      const payload = buildDiffPayload({
        baseTitle: doc ? doc.title : conflict.proposedTitle,
        baseBody: doc ? doc.body : '',
        baseVersion: doc ? doc.currentVersion : conflict.currentVersion,
        baseStatus: doc ? doc.status : null,
        targetTitle: conflict.proposedTitle,
        targetBody: conflict.proposedBody,
      })
      writeOk(res, {
        kind: 'conflict',
        conflict,
        document: doc ? { id: doc.id, title: doc.title, currentVersion: doc.currentVersion, status: doc.status, kind: doc.kind } : null,
        kb: { id: kb.id, name: kb.name, scopeKey: kb.scopeKey },
        ...payload,
      })
      return true
    }

    // 草稿 / 过时知识没有「提议」对象，但同样需要一个可对比的页面：
    // 基线取上一版正文（只有一版时整体视为新增），目标取知识当前正文。
    const documentDiff = /^\/review\/documents\/([^/]+)\/diff$/.exec(path)
    if (documentDiff && method === 'GET') {
      const handle = db()
      const docId = decodeURIComponent(documentDiff[1] ?? '')
      const doc = getDocument(handle, docId)
      if (!doc) throw new ReviewError('DOC_NOT_FOUND', 404, '知识不存在：' + docId)
      const kb = getKnowledgeBase(handle, doc.kbId)
      if (!kb) throw new ReviewError('KB_NOT_FOUND', 404, '知识所属知识库不存在：' + doc.kbId)
      const previous = doc.currentVersion > 1 ? getVersionContent(handle, doc.id, doc.currentVersion - 1) : null
      const payload = buildDiffPayload({
        baseTitle: previous ? doc.title : null,
        baseBody: previous ? previous.content : '',
        baseVersion: previous ? doc.currentVersion - 1 : null,
        baseStatus: previous ? doc.status : null,
        targetTitle: doc.title,
        targetBody: doc.body,
      })
      writeOk(res, {
        kind: 'document',
        document: { id: doc.id, title: doc.title, currentVersion: doc.currentVersion, status: doc.status, kind: doc.kind, kbId: doc.kbId },
        kb: { id: kb.id, name: kb.name, scopeKey: kb.scopeKey },
        ...payload,
      })
      return true
    }

    const conflictAction = /^\/review\/conflicts\/([^/]+)\/resolve$/.exec(path)
    if (conflictAction && method === 'POST') {
      const handle = db()
      const id = decodeURIComponent(conflictAction[1] ?? '')
      const conflict = getConflict(handle, id)
      if (!conflict) throw new ReviewError('CONFLICT_NOT_FOUND', 404, '冲突不存在：' + id)
      const kb = getKnowledgeBase(handle, conflict.kbId)
      if (!kb) throw new ReviewError('KB_NOT_FOUND', 404, '冲突所属知识库不存在：' + conflict.kbId)
      const body = (await readBody(req)) ?? {}
      const mode = str(body.mode)
      const result = await resolveConflict(handle, storageRoot(), id, {
        mode,
        actor: resolveActor(handle, body.actor),
        note: str(body.note) || null,
        title: typeof body.title === 'string' ? body.title : null,
        body: typeof body.body === 'string' ? body.body : null,
      })
      const labels: Record<string, string> = { use_proposed: '已采用新提议并追加合并版本', merge: '已保存人工合并内容并追加合并版本', keep_current: '已保留当前知识，冲突关闭' }
      writeOk(res, { ...result, message: labels[mode] ?? '冲突已处理' })
      return true
    }

    const kbReview = /^\/kb\/([^/]+)\/review$/.exec(path)
    if (kbReview && method === 'GET') {
      const handle = db()
      const kbId = decodeURIComponent(kbReview[1] ?? '')
      assertKb(handle, kbId)
      writeOk(res, reviewQueue(handle, [kbId], Number(url.searchParams.get('limit') ?? 50) || 50))
      return true
    }

    const kbProposals = /^\/kb\/([^/]+)\/proposals$/.exec(path)
    if (kbProposals && method === 'POST') {
      const handle = db()
      const kbId = decodeURIComponent(kbProposals[1] ?? '')
      const kb = assertKb(handle, kbId)
      const body = (await readBody(req)) ?? {}
      const proposal = createProposal(handle, kb, { ...body, source: str(body.source) || 'web', createdBy: str(body.createdBy) || resolveActor(handle, null) })
      const auto = await autoApproveIfEligible(handle, storageRoot(), proposal, autoApproveRules(handle))
      writeOk(res, {
        proposal: auto.proposal,
        autoApproved: auto.autoApproved,
        autoApproveReason: auto.reason ?? null,
        message: auto.autoApproved ? (auto.reason ?? '已自动批准') : '候选知识已提交，等待审核',
      })
      return true
    }

    const versions = /^\/kb\/([^/]+)\/docs\/([^/]+)\/versions$/.exec(path)
    if (versions && method === 'GET') {
      const handle = db()
      const kbId = decodeURIComponent(versions[1] ?? '')
      assertKb(handle, kbId)
      const doc = assertDoc(handle, kbId, decodeURIComponent(versions[2] ?? ''))
      writeOk(res, { documentId: doc.id, currentVersion: doc.currentVersion, versions: listVersions(handle, doc.id) })
      return true
    }

    const versionContent = /^\/kb\/([^/]+)\/docs\/([^/]+)\/versions\/(\d+)$/.exec(path)
    if (versionContent && method === 'GET') {
      const handle = db()
      const kbId = decodeURIComponent(versionContent[1] ?? '')
      assertKb(handle, kbId)
      const doc = assertDoc(handle, kbId, decodeURIComponent(versionContent[2] ?? ''))
      const entry = getVersionContent(handle, doc.id, Number(versionContent[3]))
      if (!entry) throw new ReviewError('VERSION_NOT_FOUND', 404, '历史版本不存在：第 ' + versionContent[3] + ' 版')
      writeOk(res, { document: { id: doc.id, title: doc.title, currentVersion: doc.currentVersion }, version: entry })
      return true
    }

    const diff = /^\/kb\/([^/]+)\/docs\/([^/]+)\/diff$/.exec(path)
    if (diff && method === 'GET') {
      const handle = db()
      const kbId = decodeURIComponent(diff[1] ?? '')
      assertKb(handle, kbId)
      const doc = assertDoc(handle, kbId, decodeURIComponent(diff[2] ?? ''))
      const from = Number(url.searchParams.get('from') ?? '') || null
      const to = Number(url.searchParams.get('to') ?? '') || null
      writeOk(res, diffVersions(handle, doc, from, to))
      return true
    }

    const docReview = /^\/kb\/([^/]+)\/docs\/([^/]+)\/review$/.exec(path)
    if (docReview && method === 'POST') {
      const handle = db()
      const kbId = decodeURIComponent(docReview[1] ?? '')
      assertKb(handle, kbId)
      const doc = assertDoc(handle, kbId, decodeURIComponent(docReview[2] ?? ''))
      const body = (await readBody(req)) ?? {}
      const action = str(body.action)
      const actor = resolveActor(handle, body.actor)
      const note = str(body.note) || null
      if (action === 'approve' && (typeof body.body === 'string' || typeof body.title === 'string')) {
        const updated = await approveDocumentWithEdits(handle, storageRoot(), doc, { title: body.title, body: body.body, actor, note })
        writeOk(res, { document: updated, message: '已编辑并批准该知识（记录了新版本）' })
        return true
      }
      const updated = reviewDocument(handle, doc, action, { actor, note })
      const labels: Record<string, string> = { approve: '已批准该知识', reject: '已拒绝该知识（归档）', mark_stale: '已标记为过时', archive: '已归档' }
      writeOk(res, { document: updated, message: labels[action] ?? '审核动作已执行' })
      return true
    }

    const docRestore = /^\/kb\/([^/]+)\/docs\/([^/]+)\/restore$/.exec(path)
    if (docRestore && method === 'POST') {
      const handle = db()
      const kbId = decodeURIComponent(docRestore[1] ?? '')
      assertKb(handle, kbId)
      const doc = assertDoc(handle, kbId, decodeURIComponent(docRestore[2] ?? ''))
      const body = (await readBody(req)) ?? {}
      const version = Number(body.version)
      if (!Number.isInteger(version) || version < 1) throw new ReviewError('VERSION_INVALID', 400, 'version 必须是正整数')
      const restored = await restoreVersion(handle, storageRoot(), doc, version, { actor: str(body.actor) || null, note: str(body.note) || null })
      recordReviewLog(handle, { action: 'doc_restore', itemKind: 'doc', itemId: doc.id, docId: doc.id, kbId: doc.kbId, actor: str(body.actor) || null, note: '恢复自第 ' + version + ' 版' })
      writeOk(res, { document: restored.document, restoredFrom: version, message: '已恢复为第 ' + version + ' 版内容（以新版本方式记录，原内容未被静默覆盖）' })
      return true
    }

    const docEdit = /^\/kb\/([^/]+)\/docs\/([^/]+)$/.exec(path)
    if (docEdit && method === 'PATCH') {
      const handle = db()
      const kbId = decodeURIComponent(docEdit[1] ?? '')
      assertKb(handle, kbId)
      const doc = assertDoc(handle, kbId, decodeURIComponent(docEdit[2] ?? ''))
      const body = (await readBody(req)) ?? {}
      const updated = await updateDocumentByHuman(handle, storageRoot(), doc, body, resolveActor(handle, body.actor))
      writeOk(res, { document: updated, message: '已保存修改并记录新版本' })
      return true
    }

    return false
  } catch (error) {
    if (error instanceof ReviewError || error instanceof DocError || error instanceof KbError) {
      writeError(res, error.status, error.code, error.message)
      return true
    }
    writeError(res, 500, 'INTERNAL_ERROR', errorMessage(error))
    return true
  }
}
