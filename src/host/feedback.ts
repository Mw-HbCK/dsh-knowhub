/**
 * 「是否有帮助」反馈。
 *
 * 设计要点：
 * - 只追加、不覆盖历史（同一个人可以对同一篇知识多次反馈，用于观察知识是否越改越好/越改越差）；
 * - 反馈只影响展示与统计，绝不自动改变知识状态（是否修订仍由人工审核决定）；
 * - 统计按 doc_id 聚合，返回有帮助/没帮助/合计与最近一条理由。
 */
import { all, get, run, transaction, type Db } from './db/db.js'
import { newId } from './utils/id.js'

export class FeedbackError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface FeedbackRow {
  id: string
  kbId: string
  docId: string
  helpful: boolean
  reason: string | null
  actor: string | null
  createdAt: string
}

export interface FeedbackSummary {
  docId: string
  helpful: number
  notHelpful: number
  total: number
  lastAt: string | null
  lastReason: string | null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toFeedback(raw: any): FeedbackRow {
  return {
    id: String(raw.id),
    kbId: String(raw.kb_id),
    docId: String(raw.doc_id),
    helpful: Number(raw.helpful) === 1,
    reason: raw.reason === null || raw.reason === undefined ? null : String(raw.reason),
    actor: raw.actor === null || raw.actor === undefined ? null : String(raw.actor),
    createdAt: new Date(Number(raw.created_at)).toISOString(),
  }
}

/** 解析 helpful 入参：接受 boolean / 1 / 0 / '1' / '0' / 'yes' / 'no'。 */
export function parseHelpful(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
  }
  const text = str(value).toLowerCase()
  if (text === 'true' || text === '1' || text === 'yes' || text === 'helpful') return true
  if (text === 'false' || text === '0' || text === 'no' || text === 'unhelpful') return false
  throw new FeedbackError('FEEDBACK_INVALID', 400, 'helpful 必须是 true / false')
}

export function addFeedback(db: Db, doc: { id: string; kbId: string }, input: { helpful?: unknown; reason?: unknown; actor?: unknown }): FeedbackRow {
  const helpful = parseHelpful(input.helpful)
  const reason = str(input.reason)
  if ([...reason].length > 500) throw new FeedbackError('FEEDBACK_INVALID', 400, '反馈理由最多 500 个字符')
  const actor = str(input.actor).slice(0, 80) || null
  const row: FeedbackRow = {
    id: newId('fb'),
    kbId: doc.kbId,
    docId: doc.id,
    helpful,
    reason: reason === '' ? null : reason,
    actor,
    createdAt: new Date().toISOString(),
  }
  const at = Date.now()
  transaction(db, () => {
    run(db, 'INSERT INTO doc_feedback (id, kb_id, doc_id, helpful, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      row.id, row.kbId, row.docId, helpful ? 1 : 0, row.reason, row.actor, at,
    ])
  })
  return row
}

export function feedbackSummary(db: Db, docId: string): FeedbackSummary {
  const row = get<any>(db,
    'SELECT COALESCE(SUM(CASE WHEN helpful = 1 THEN 1 ELSE 0 END), 0) AS helpful, ' +
    'COALESCE(SUM(CASE WHEN helpful = 0 THEN 1 ELSE 0 END), 0) AS not_helpful, ' +
    'COUNT(*) AS total, MAX(created_at) AS last_at FROM doc_feedback WHERE doc_id = ?', [docId])
  const last = get<any>(db, 'SELECT reason, created_at FROM doc_feedback WHERE doc_id = ? AND reason IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1', [docId])
  const helpful = Number(row?.helpful ?? 0)
  const notHelpful = Number(row?.not_helpful ?? 0)
  const lastAt = last?.created_at !== undefined ? Number(last.created_at) : Number(row?.last_at ?? 0)
  return {
    docId,
    helpful,
    notHelpful,
    total: helpful + notHelpful,
    lastAt: lastAt > 0 ? new Date(lastAt).toISOString() : null,
    lastReason: last?.reason === null || last?.reason === undefined ? null : String(last.reason),
  }
}

/** 批量统计（列表页用，避免 N+1 查询）。 */
export function feedbackSummaries(db: Db, docIds: string[]): Record<string, FeedbackSummary> {
  const ids = [...new Set(docIds.filter((id) => typeof id === 'string' && id !== ''))]
  if (ids.length === 0) return {}
  const rows = all<any>(db,
    'SELECT doc_id, COALESCE(SUM(CASE WHEN helpful = 1 THEN 1 ELSE 0 END), 0) AS helpful, ' +
    'COALESCE(SUM(CASE WHEN helpful = 0 THEN 1 ELSE 0 END), 0) AS not_helpful, MAX(created_at) AS last_at ' +
    'FROM doc_feedback WHERE doc_id IN (' + ids.map(() => '?').join(', ') + ') GROUP BY doc_id', ids)
  const result: Record<string, FeedbackSummary> = {}
  for (const id of ids) result[id] = { docId: id, helpful: 0, notHelpful: 0, total: 0, lastAt: null, lastReason: null }
  for (const row of rows) {
    const docId = String(row.doc_id)
    const helpful = Number(row.helpful ?? 0)
    const notHelpful = Number(row.not_helpful ?? 0)
    const lastAt = Number(row.last_at ?? 0)
    result[docId] = {
      docId, helpful, notHelpful, total: helpful + notHelpful,
      lastAt: lastAt > 0 ? new Date(lastAt).toISOString() : null,
      lastReason: result[docId]?.lastReason ?? null,
    }
  }
  return result
}

export function listFeedback(db: Db, docId: string, limit = 20): FeedbackRow[] {
  const size = Math.max(1, Math.min(100, Number(limit) || 20))
  return all(db, 'SELECT * FROM doc_feedback WHERE doc_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [docId, size]).map(toFeedback)
}
