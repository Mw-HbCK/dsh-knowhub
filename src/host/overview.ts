/**
 * 总览与跨库浏览（M5）：给中文知识中心的总览页、Repo Wiki 页、长期记忆页提供数据。
 *
 * 隔离原则：调用方只能传 scopeKeys（由服务端从当前工作区反查得出），本模块不接受任意 kbId 列表扩大范围。
 */
import { all, get, schemaVersion, type Db } from './db/db.js'
import { listKnowledgeBases } from './kb/store.js'
import { DOC_KINDS, DOC_STATUS, VERIFY_STATES } from './search.js'

function int(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function buildOverview(db: Db, storageRoot: string, scopeKeys: string[]): any {
  const kbs = listKnowledgeBases(db, scopeKeys)
  const kbIds = kbs.map((kb) => kb.id)
  const placeholders = kbIds.map(() => '?').join(',') || "''"
  const counts = {
    knowledgeBases: kbs.length,
    userKbs: kbs.filter((kb) => kb.scope === 'user').length,
    workspaceKbs: kbs.filter((kb) => kb.scope === 'workspace').length,
    readyKbs: kbs.filter((kb) => kb.status === 'ready').length,
    errorKbs: kbs.filter((kb) => kb.status === 'error').length,
  }
  const docs = kbIds.length === 0
    ? { approved: 0, draft: 0, stale: 0, archived: 0, total: 0 }
    : (get<any>(db, 'SELECT ' +
      "SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved, " +
      "SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS draft, " +
      "SUM(CASE WHEN status='stale' THEN 1 ELSE 0 END) AS stale, " +
      "SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END) AS archived, " +
      'COUNT(*) AS total FROM documents WHERE deleted_at IS NULL AND kb_id IN (' + placeholders + ')', kbIds) ?? {})
  const review = kbIds.length === 0
    ? { proposals: 0, conflicts: 0, drafts: 0, stale: 0 }
    : {
      proposals: int(get<any>(db, "SELECT COUNT(*) AS n FROM proposals WHERE status='pending' AND kb_id IN (" + placeholders + ')', kbIds)?.n),
      conflicts: int(get<any>(db, "SELECT COUNT(*) AS n FROM conflicts WHERE status='pending' AND kb_id IN (" + placeholders + ')', kbIds)?.n),
      drafts: int(get<any>(db, "SELECT COUNT(*) AS n FROM documents WHERE status='draft' AND deleted_at IS NULL AND kb_id IN (" + placeholders + ')', kbIds)?.n),
      stale: int(get<any>(db, "SELECT COUNT(*) AS n FROM documents WHERE status='stale' AND deleted_at IS NULL AND kb_id IN (" + placeholders + ')', kbIds)?.n),
    }
  const byKind = kbIds.length === 0 ? [] : all<any>(db, 'SELECT kind, COUNT(*) AS n FROM documents WHERE deleted_at IS NULL AND kb_id IN (' + placeholders + ') GROUP BY kind ORDER BY n DESC', kbIds)
    .map((row) => ({ kind: String(row.kind), count: int(row.n) }))
  const recentDocs = kbIds.length === 0 ? [] : all<any>(db, 'SELECT d.id, d.kb_id, d.kind, d.title, d.status, d.verify_state, d.updated_at, k.name AS kb_name FROM documents d JOIN knowledge_bases k ON k.id = d.kb_id WHERE d.deleted_at IS NULL AND d.kb_id IN (' + placeholders + ') ORDER BY d.updated_at DESC LIMIT 6', kbIds)
    .map((row) => ({ id: String(row.id), kbId: String(row.kb_id), kbName: String(row.kb_name), kind: String(row.kind), title: String(row.title), status: String(row.status), verifyState: String(row.verify_state), updatedAt: int(row.updated_at) }))
  const runningTasks = kbIds.length === 0 ? [] : all<any>(db, "SELECT id, kb_id, kind, status, progress, stage, created_at FROM tasks WHERE status IN ('queued','running') AND kb_id IN (" + placeholders + ') ORDER BY created_at DESC LIMIT 6', kbIds)
    .map((row) => ({ id: String(row.id), kbId: String(row.kb_id), kind: String(row.kind), status: String(row.status), progress: int(row.progress), stage: row.stage ?? null, createdAt: int(row.created_at) }))
  const recentActivity = all<any>(db, 'SELECT at, actor, action, item_kind, item_id, doc_id, kb_id, note FROM review_log ORDER BY at DESC LIMIT 10')
    .map((row) => ({ at: int(row.at), actor: row.actor ?? null, action: String(row.action), itemKind: String(row.item_kind), itemId: String(row.item_id), docId: row.doc_id ?? null, kbId: row.kb_id ?? null, note: row.note ?? null }))
  return {
    generatedAt: Date.now(),
    schemaVersion: schemaVersion(db),
    storageRoot,
    counts,
    documents: {
      approved: int(docs.approved), draft: int(docs.draft), stale: int(docs.stale),
      archived: int(docs.archived), total: int(docs.total), byKind,
    },
    review,
    pendingTotal: review.proposals + review.conflicts + review.drafts + review.stale,
    recentDocs,
    runningTasks,
    recentActivity,
    note: '总览只统计当前工作区可见的知识库（用户级 + 当前工作区级）',
  }
}

export interface DocumentFilterInput {
  kind?: string | null
  status?: string | null
  verifyState?: string | null
  query?: string | null
  limit?: number
  offset?: number
}

/** 跨库知识浏览（Repo Wiki / 长期记忆页）：只返回 scopeKeys 内的知识。 */
export function listDocumentsAcrossKbs(db: Db, kbIds: string[], input: DocumentFilterInput = {}): any {
  if (kbIds.length === 0) return { total: 0, documents: [], counts: { byKind: [], byStatus: [] }, limit: 0, offset: 0 }
  const placeholders = kbIds.map(() => '?').join(',')
  const where: string[] = ['d.deleted_at IS NULL', 'd.kb_id IN (' + placeholders + ')']
  const params: (string | number | null)[] = [...kbIds]
  const kind = typeof input.kind === 'string' ? input.kind.trim() : ''
  if (kind !== '') {
    // 支持逗号分隔的多值（Repo Wiki / 长期记忆页一次筛选多个类型），总数统计也随之准确。
    const kinds = kind.split(',').map((item) => item.trim()).filter((item) => item !== '')
    for (const item of kinds) {
      if (!DOC_KINDS.includes(item as any)) throw Object.assign(new Error('知识类型必须是 ' + DOC_KINDS.join(' / ') + ' 之一'), { code: 'DOC_FILTER_INVALID', status: 400 })
    }
    where.push('d.kind IN (' + kinds.map(() => '?').join(',') + ')')
    params.push(...kinds)
  }
  const status = typeof input.status === 'string' ? input.status.trim() : ''
  if (status !== '') {
    const statuses = status.split(',').map((item) => item.trim()).filter((item) => item !== '')
    for (const item of statuses) {
      if (!DOC_STATUS.includes(item as any)) throw Object.assign(new Error('知识状态必须是 ' + DOC_STATUS.join(' / ') + ' 之一'), { code: 'DOC_FILTER_INVALID', status: 400 })
    }
    where.push('d.status IN (' + statuses.map(() => '?').join(',') + ')')
    params.push(...statuses)
  }
  const verifyState = typeof input.verifyState === 'string' ? input.verifyState.trim() : ''
  if (verifyState !== '') {
    if (!VERIFY_STATES.includes(verifyState as any)) throw Object.assign(new Error('验证状态必须是 ' + VERIFY_STATES.join(' / ') + ' 之一'), { code: 'DOC_FILTER_INVALID', status: 400 })
    where.push('d.verify_state = ?')
    params.push(verifyState)
  }
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (query !== '') {
    where.push('(d.title LIKE ? OR d.body LIKE ? OR d.tags LIKE ?)')
    const like = '%' + query.replace(/[%_]/g, '') + '%'
    params.push(like, like, like)
  }
  const limit = Math.max(1, Math.min(200, int(input.limit) || 50))
  const offset = Math.max(0, int(input.offset))
  const from = ' FROM documents d JOIN knowledge_bases k ON k.id = d.kb_id WHERE ' + where.join(' AND ')
  const total = int(get<any>(db, 'SELECT COUNT(*) AS n' + from, params)?.n)
  const rows = all<any>(db, 'SELECT d.id, d.kb_id, d.kind, d.slug, d.title, d.body, d.status, d.verify_state, d.confidence, d.tags, d.current_version, d.updated_at, d.created_at, d.parent_id, k.name AS kb_name' + from + ' ORDER BY d.updated_at DESC LIMIT ? OFFSET ?', [...params, limit, offset])
  const documents = rows.map((row) => {
    let tags: string[] = []
    try { const parsed = JSON.parse(String(row.tags ?? '[]')); if (Array.isArray(parsed)) tags = parsed.map(String) } catch { /* ignore */ }
    const body = String(row.body ?? '')
    return {
      id: String(row.id), kbId: String(row.kb_id), kbName: String(row.kb_name), kind: String(row.kind), slug: String(row.slug),
      title: String(row.title), status: String(row.status), verifyState: String(row.verify_state),
      confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
      tags, currentVersion: int(row.current_version), updatedAt: int(row.updated_at), createdAt: int(row.created_at),
      parentId: row.parent_id === null || row.parent_id === undefined || String(row.parent_id) === '' ? null : String(row.parent_id),
      excerpt: body.replace(/\s+/g, ' ').slice(0, 240),
      sourceCount: int(get<any>(db, 'SELECT COUNT(*) AS n FROM sources WHERE doc_id = ?', [String(row.id)])?.n),
    }
  })
  const countsByKind = all<any>(db, 'SELECT d.kind, COUNT(*) AS n' + from + ' GROUP BY d.kind ORDER BY n DESC', params)
    .map((row) => ({ kind: String(row.kind), count: int(row.n) }))
  const countsByStatus = all<any>(db, 'SELECT d.status, COUNT(*) AS n' + from + ' GROUP BY d.status ORDER BY n DESC', params)
    .map((row) => ({ status: String(row.status), count: int(row.n) }))
  return { total, documents, counts: { byKind: countsByKind, byStatus: countsByStatus }, limit, offset }
}
