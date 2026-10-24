/**
 * 审核层（M3）：候选知识、草稿、冲突与版本恢复。
 *
 * 安全原则：
 * - 所有自动生成的知识（模型提炼、Agent 提议）默认进入 pending，绝不直接成为已批准知识；
 * - 审核通过才写入正式库（status='approved'），每次落地都追加版本；
 * - 已批准文档不会被静默覆盖：版本不一致时生成冲突审核项。
 */
import { all, get, run, type Db } from './db/db.js'
import { contentHash, getKnowledgeBase, type KbRow } from './kb/store.js'
import { createDocument, DOC_KINDS, getDocument, VERIFY_STATES, type DocRow } from './search.js'
import { appendVersion, listVersions, restoreVersion, diffVersions, diffLines } from './docvers.js'
import { newId } from './utils/id.js'

export const PROPOSAL_KINDS = ['create', 'update', 'restore', 'stale'] as const
export const PROPOSAL_STATUS = ['pending', 'approved', 'rejected', 'superseded'] as const
export const CONFLICT_STATUS = ['pending', 'keep_current', 'use_proposed', 'merge'] as const
export const DOC_REVIEW_ACTIONS = ['approve', 'reject', 'mark_stale', 'archive'] as const

export class ReviewError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface ProposalRow {
  id: string
  kbId: string
  docId: string | null
  kind: string
  title: string
  body: string
  baseVersion: number | null
  docKind: string
  tags: string[]
  verifyState: string
  confidence: number | null
  sources: Array<{ kind: string; ref: string; locator: string | null }>
  source: string | null
  reason: string | null
  status: string
  createdBy: string | null
  createdAt: string
  reviewedAt: string | null
  reviewedBy: string | null
  reviewNote: string | null
}

export interface ConflictRow {
  id: string
  kbId: string
  docId: string
  baseVersion: number
  currentVersion: number
  proposedTitle: string | null
  proposedBody: string
  source: string | null
  status: string
  detectedAt: string
  resolvedAt: string | null
  resolvedBy: string | null
  note: string | null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseJsonArray(raw: unknown): any[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function toProposal(raw: any): ProposalRow {
  return {
    id: String(raw.id),
    kbId: String(raw.kb_id),
    docId: raw.doc_id === null || raw.doc_id === undefined ? null : String(raw.doc_id),
    kind: String(raw.kind),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    baseVersion: raw.base_version === null || raw.base_version === undefined ? null : Number(raw.base_version),
    docKind: String(raw.doc_kind ?? 'memory'),
    tags: parseJsonArray(raw.tags).map(String),
    verifyState: String(raw.verify_state ?? 'unverified'),
    confidence: raw.confidence === null || raw.confidence === undefined ? null : Number(raw.confidence),
    sources: parseJsonArray(raw.sources).map((item: any) => ({ kind: String(item?.kind ?? 'file'), ref: String(item?.ref ?? ''), locator: item?.locator ? String(item.locator) : null })),
    source: raw.source === null ? null : String(raw.source),
    reason: raw.reason === null ? null : String(raw.reason),
    status: String(raw.status),
    createdBy: raw.created_by === null ? null : String(raw.created_by),
    createdAt: new Date(Number(raw.created_at)).toISOString(),
    reviewedAt: raw.reviewed_at === null || raw.reviewed_at === undefined ? null : new Date(Number(raw.reviewed_at)).toISOString(),
    reviewedBy: raw.reviewed_by === null ? null : String(raw.reviewed_by),
    reviewNote: raw.review_note === null ? null : String(raw.review_note),
  }
}

function toConflict(raw: any): ConflictRow {
  return {
    id: String(raw.id),
    kbId: String(raw.kb_id),
    docId: String(raw.doc_id),
    baseVersion: Number(raw.base_version),
    currentVersion: Number(raw.current_version),
    proposedTitle: raw.proposed_title === null ? null : String(raw.proposed_title),
    proposedBody: String(raw.proposed_body ?? ''),
    source: raw.source === null ? null : String(raw.source),
    status: String(raw.status),
    detectedAt: new Date(Number(raw.detected_at)).toISOString(),
    resolvedAt: raw.resolved_at === null || raw.resolved_at === undefined ? null : new Date(Number(raw.resolved_at)).toISOString(),
    resolvedBy: raw.resolved_by === null ? null : String(raw.resolved_by),
    note: raw.note === null ? null : String(raw.note),
  }
}

export function recordReviewLog(db: Db, entry: { action: string; itemKind: string; itemId: string; docId?: string | null; kbId?: string | null; actor?: string | null; note?: string | null }): void {
  run(db, 'INSERT INTO review_log (at, actor, action, item_kind, item_id, doc_id, kb_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    Date.now(), entry.actor ?? null, entry.action, entry.itemKind, entry.itemId, entry.docId ?? null, entry.kbId ?? null, entry.note ?? null,
  ])
}

export function listReviewLog(db: Db, filters: { kbIds?: string[]; limit?: number }): any[] {
  const limit = Math.max(1, Math.min(200, filters.limit ?? 50))
  const kbIds = filters.kbIds ?? []
  const rows = kbIds.length === 0
    ? all(db, 'SELECT * FROM review_log ORDER BY id DESC LIMIT ?', [limit])
    : all(db, 'SELECT * FROM review_log WHERE kb_id IS NULL OR kb_id IN (' + kbIds.map(() => '?').join(', ') + ') ORDER BY id DESC LIMIT ?', [...kbIds, limit])
  return rows.map((raw: any) => ({
    id: Number(raw.id),
    at: new Date(Number(raw.at)).toISOString(),
    actor: raw.actor === null ? null : String(raw.actor),
    action: String(raw.action),
    itemKind: String(raw.item_kind),
    itemId: String(raw.item_id),
    docId: raw.doc_id === null ? null : String(raw.doc_id),
    kbId: raw.kb_id === null ? null : String(raw.kb_id),
    note: raw.note === null ? null : String(raw.note),
  }))
}

export interface CreateProposalInput {
  kind?: unknown
  title?: unknown
  body?: unknown
  docId?: unknown
  docKind?: unknown
  tags?: unknown
  verifyState?: unknown
  confidence?: unknown
  sources?: unknown
  source?: unknown
  reason?: unknown
  createdBy?: unknown
}

/** 创建待审核候选（Agent 提议 / 人工新增草稿都走这里）。默认 pending，绝不直接落正式库。 */
export function createProposal(db: Db, kb: KbRow, input: CreateProposalInput): ProposalRow {
  const docId = str(input.docId)
  const rawKind = str(input.kind)
  const kind = rawKind === '' ? (docId === '' ? 'create' : 'update') : rawKind
  if (!PROPOSAL_KINDS.includes(kind as any)) throw new ReviewError('PROPOSAL_INVALID_KIND', 400, '候选类型必须是 ' + PROPOSAL_KINDS.join(' / ') + ' 之一')
  const body = typeof input.body === 'string' ? input.body : ''
  if (body.trim() === '') throw new ReviewError('PROPOSAL_INVALID_INPUT', 400, '候选知识正文不能为空')

  let doc: DocRow | null = null
  if (kind !== 'create') {
    if (docId === '') throw new ReviewError('PROPOSAL_DOC_REQUIRED', 400, '候选类型 ' + kind + ' 必须提供 docId')
    doc = getDocument(db, docId)
    if (!doc) throw new ReviewError('DOC_NOT_FOUND', 404, '知识不存在：' + docId)
    if (doc.kbId !== kb.id) throw new ReviewError('DOC_KB_MISMATCH', 400, '该知识不属于当前知识库')
  }

  const title = str(input.title) || doc?.title || ''
  if (title === '') throw new ReviewError('PROPOSAL_INVALID_INPUT', 400, '候选知识标题不能为空')
  const docKind = str((input as any).docKind) || doc?.kind || 'memory'
  if (!DOC_KINDS.includes(docKind as any)) throw new ReviewError('PROPOSAL_INVALID_INPUT', 400, '知识类型必须是 ' + DOC_KINDS.join(' / ') + ' 之一')
  const verifyState = str(input.verifyState) || doc?.verifyState || 'unverified'
  if (!VERIFY_STATES.includes(verifyState as any)) throw new ReviewError('PROPOSAL_INVALID_INPUT', 400, '验证状态必须是 ' + VERIFY_STATES.join(' / ') + ' 之一')
  const tags = Array.isArray(input.tags) ? input.tags.map(String).filter((tag) => tag.trim() !== '') : (doc?.tags ?? [])
  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : (doc?.confidence ?? null)
  const sources = Array.isArray(input.sources)
    ? input.sources
      .map((item: any) => ({ kind: ['file', 'session', 'task', 'url', 'commit'].includes(String(item?.kind)) ? String(item.kind) : 'file', ref: String(item?.ref ?? ''), locator: item?.locator ? String(item.locator) : null }))
      .filter((item) => item.ref !== '')
    : []

  const dedupeDocId = doc?.id ?? null
  const duplicate = get<any>(db, "SELECT * FROM proposals WHERE status = 'pending' AND kb_id = ? AND doc_id IS ? AND kind = ? AND body = ? ORDER BY created_at DESC LIMIT 1", [kb.id, dedupeDocId, kind, body])
  if (duplicate) return toProposal(duplicate)

  const id = newId('prop')
  const timestamp = Date.now()
  run(db, 'INSERT INTO proposals (id, kb_id, doc_id, kind, title, body, base_version, doc_kind, tags, verify_state, confidence, sources, source, reason, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    id, kb.id, doc?.id ?? null, kind, title, body, doc?.currentVersion ?? null, docKind, JSON.stringify(tags), verifyState, confidence, JSON.stringify(sources), str(input.source) || 'agent', str(input.reason) || null, 'pending', str(input.createdBy) || null, timestamp,
  ])
  recordReviewLog(db, { action: 'propose', itemKind: 'proposal', itemId: id, docId: doc?.id ?? null, kbId: kb.id, actor: str(input.createdBy) || null, note: str(input.reason) || null })
  return getProposal(db, id)!
}

export function getProposal(db: Db, id: string): ProposalRow | null {
  const raw = get(db, 'SELECT * FROM proposals WHERE id = ?', [id])
  return raw ? toProposal(raw) : null
}

export function listProposals(db: Db, filters: { kbIds: string[]; status?: string; limit?: number; offset?: number }): ProposalRow[] {
  if (filters.kbIds.length === 0) return []
  const where = ['kb_id IN (' + filters.kbIds.map(() => '?').join(', ') + ')']
  const params: (string | number)[] = [...filters.kbIds]
  if (filters.status) { where.push('status = ?'); params.push(filters.status) }
  const limit = Math.max(1, Math.min(200, filters.limit ?? 50))
  const offset = Math.max(0, filters.offset ?? 0)
  params.push(limit, offset)
  return all(db, 'SELECT * FROM proposals WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', params).map(toProposal)
}

export function rejectProposal(db: Db, id: string, options: { actor?: string | null; note?: string | null }): ProposalRow {
  const proposal = getProposal(db, id)
  if (!proposal) throw new ReviewError('PROPOSAL_NOT_FOUND', 404, '候选不存在：' + id)
  if (proposal.status !== 'pending') throw new ReviewError('PROPOSAL_NOT_PENDING', 409, '该候选已经处理过（当前状态：' + proposal.status + '）')
  run(db, "UPDATE proposals SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?", [Date.now(), options.actor ?? null, options.note ?? null, id])
  recordReviewLog(db, { action: 'reject', itemKind: 'proposal', itemId: id, docId: proposal.docId, kbId: proposal.kbId, actor: options.actor ?? null, note: options.note ?? null })
  return getProposal(db, id)!
}

export function recordConflict(db: Db, input: { kbId: string; doc: DocRow; proposedBody: string; proposedTitle?: string | null; source?: string | null }): ConflictRow {
  const existing = get(db, "SELECT * FROM conflicts WHERE doc_id = ? AND status = 'pending' AND proposed_body = ?", [input.doc.id, input.proposedBody])
  if (existing) return toConflict(existing)
  const id = newId('cfl')
  run(db, "INSERT INTO conflicts (id, kb_id, doc_id, base_version, current_version, proposed_title, proposed_body, source, status, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)", [
    id, input.kbId, input.doc.id, input.doc.currentVersion, input.doc.currentVersion, input.proposedTitle ?? null, input.proposedBody, input.source ?? null, Date.now(),
  ])
  recordReviewLog(db, { action: 'conflict_detected', itemKind: 'conflict', itemId: id, docId: input.doc.id, kbId: input.kbId, note: input.source ?? null })
  return toConflict(get(db, 'SELECT * FROM conflicts WHERE id = ?', [id]))
}

export function getConflict(db: Db, id: string): ConflictRow | null {
  const raw = get(db, 'SELECT * FROM conflicts WHERE id = ?', [id])
  return raw ? toConflict(raw) : null
}

export function listConflicts(db: Db, filters: { kbIds: string[]; status?: string; limit?: number }): ConflictRow[] {
  if (filters.kbIds.length === 0) return []
  const where = ['kb_id IN (' + filters.kbIds.map(() => '?').join(', ') + ')']
  const params: (string | number)[] = [...filters.kbIds]
  if (filters.status) { where.push('status = ?'); params.push(filters.status) }
  params.push(Math.max(1, Math.min(200, filters.limit ?? 50)))
  return all(db, 'SELECT * FROM conflicts WHERE ' + where.join(' AND ') + ' ORDER BY detected_at DESC LIMIT ?', params).map(toConflict)
}

/** 审核通过候选：create → 新建已批准文档；update → 校验版本后追加版本；restore → 恢复；stale → 标记过时。 */
export async function approveProposal(db: Db, storageRoot: string, id: string, options: { actor?: string | null; note?: string | null; title?: string | null; body?: string | null }): Promise<{ proposal: ProposalRow; document: DocRow | null; conflict: ConflictRow | null }> {
  const proposal = getProposal(db, id)
  if (!proposal) throw new ReviewError('PROPOSAL_NOT_FOUND', 404, '候选不存在：' + id)
  if (proposal.status !== 'pending') throw new ReviewError('PROPOSAL_NOT_PENDING', 409, '该候选已经处理过（当前状态：' + proposal.status + '）')
  const kb = getKnowledgeBase(db, proposal.kbId)
  if (!kb) throw new ReviewError('KB_NOT_FOUND', 404, '知识库不存在：' + proposal.kbId)
  const title = (options.title ?? proposal.title).trim()
  const body = options.body ?? proposal.body
  const actor = options.actor ?? 'user'
  let document: DocRow | null = null
  let conflict: ConflictRow | null = null

  if (proposal.kind === 'create') {
    document = await createDocument(db, storageRoot, kb, {
      title, kind: proposal.docKind, body, tags: proposal.tags, status: 'approved',
      verifyState: proposal.verifyState, confidence: proposal.confidence,
    })
    for (const source of proposal.sources) {
      run(db, 'INSERT INTO sources (id, doc_id, candidate_id, kind, ref, locator, excerpt_hash, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)', [
        newId('src'), document.id, proposal.id, source.kind, source.ref, source.locator,
        contentHash(source.ref).slice(0, 16), Date.now(),
      ])
    }
  } else {
    if (!proposal.docId) throw new ReviewError('PROPOSAL_DOC_REQUIRED', 400, '该候选缺少目标文档')
    const doc = getDocument(db, proposal.docId)
    if (!doc) throw new ReviewError('DOC_NOT_FOUND', 404, '目标知识已不存在：' + proposal.docId)
    if (proposal.kind === 'update') {
      if (proposal.baseVersion !== null && doc.currentVersion !== proposal.baseVersion) {
        conflict = recordConflict(db, { kbId: proposal.kbId, doc, proposedBody: body, proposedTitle: title, source: 'proposal:' + proposal.id })
        run(db, "UPDATE proposals SET status = 'superseded', reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ?", [Date.now(), actor, '版本冲突，已生成冲突审核项 ' + conflict.id, id])
        recordReviewLog(db, { action: 'review_conflict', itemKind: 'proposal', itemId: id, docId: doc.id, kbId: proposal.kbId, actor, note: '版本冲突 ' + conflict.id })
        return { proposal: getProposal(db, id)!, document: null, conflict }
      }
      document = await appendVersion(db, storageRoot, doc, {
        body, title, tags: proposal.tags, status: 'approved', verifyState: proposal.verifyState,
        confidence: proposal.confidence, changeKind: 'update', source: 'review', actor,
        reason: options.note ?? proposal.reason ?? 'Agent 提议经审核通过',
      })
    } else if (proposal.kind === 'restore') {
      if (proposal.baseVersion === null) throw new ReviewError('PROPOSAL_INVALID_INPUT', 400, '恢复类候选必须记录目标版本号')
      const restored = await restoreVersion(db, storageRoot, doc, proposal.baseVersion, { actor, note: options.note ?? null })
      document = restored.document
    } else {
      run(db, "UPDATE documents SET status = 'stale', updated_at = ? WHERE id = ?", [Date.now(), doc.id])
      document = getDocument(db, doc.id)
    }
  }

  run(db, "UPDATE proposals SET status = 'approved', reviewed_at = ?, reviewed_by = ?, review_note = ?, doc_id = ? WHERE id = ?", [Date.now(), actor, options.note ?? null, document?.id ?? proposal.docId, id])
  recordReviewLog(db, { action: 'approve', itemKind: 'proposal', itemId: id, docId: document?.id ?? proposal.docId, kbId: proposal.kbId, actor, note: options.note ?? null })
  return { proposal: getProposal(db, id)!, document, conflict }
}

/** 审核一篇文档本身（草稿转正 / 拒绝 / 标记过时 / 归档）。 */
export function reviewDocument(db: Db, doc: DocRow, action: string, options: { actor?: string | null; note?: string | null }): DocRow {
  if (!DOC_REVIEW_ACTIONS.includes(action as any)) throw new ReviewError('DOC_REVIEW_INVALID_ACTION', 400, '审核动作必须是 ' + DOC_REVIEW_ACTIONS.join(' / ') + ' 之一')
  const actor = options.actor ?? 'user'
  const timestamp = Date.now()
  if (action === 'approve') {
    run(db, "UPDATE documents SET status = 'approved', reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?", [timestamp, actor, timestamp, doc.id])
  } else if (action === 'reject') {
    run(db, "UPDATE documents SET status = 'archived', reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?", [timestamp, actor, timestamp, doc.id])
  } else {
    run(db, "UPDATE documents SET status = 'stale', reviewed_at = ?, reviewed_by = ?, updated_at = ? WHERE id = ?", [timestamp, actor, timestamp, doc.id])
  }
  recordReviewLog(db, { action: 'doc_' + action, itemKind: 'doc', itemId: doc.id, docId: doc.id, kbId: doc.kbId, actor, note: options.note ?? null })
  return getDocument(db, doc.id)!
}

export function markDocumentStale(db: Db, doc: DocRow, options: { actor?: string | null; note?: string | null }): DocRow {
  return reviewDocument(db, doc, 'mark_stale', options)
}

/** 冲突处理：保留当前（keep_current）、采用新提议（use_proposed）或人工合并（merge，可带编辑后的正文）。 */
export async function resolveConflict(db: Db, storageRoot: string, id: string, options: { mode: string; actor?: string | null; note?: string | null; title?: string | null; body?: string | null }): Promise<{ conflict: ConflictRow; document: DocRow | null }> {
  const conflict = getConflict(db, id)
  if (!conflict) throw new ReviewError('CONFLICT_NOT_FOUND', 404, '冲突不存在：' + id)
  if (conflict.status !== 'pending') throw new ReviewError('CONFLICT_ALREADY_RESOLVED', 409, '该冲突已处理（当前状态：' + conflict.status + '）')
  if (options.mode !== 'keep_current' && options.mode !== 'use_proposed' && options.mode !== 'merge') {
    throw new ReviewError('CONFLICT_INVALID_MODE', 400, '处理方式必须是 keep_current / use_proposed / merge')
  }
  if (options.mode === 'merge' && typeof options.body !== 'string') {
    throw new ReviewError('CONFLICT_INVALID_INPUT', 400, '人工合并必须提供合并后的正文')
  }
  const actor = options.actor ?? 'user'
  let document: DocRow | null = null
  if (options.mode === 'use_proposed' || options.mode === 'merge') {
    const doc = getDocument(db, conflict.docId)
    if (!doc) throw new ReviewError('DOC_NOT_FOUND', 404, '目标知识已不存在：' + conflict.docId)
    const body = options.mode === 'merge' ? String(options.body ?? '') : conflict.proposedBody
    if (body.trim() === '') throw new ReviewError('CONFLICT_INVALID_INPUT', 400, '合并后的正文不能为空')
    document = await appendVersion(db, storageRoot, doc, {
      body, title: (options.mode === 'merge' ? str(options.title) : '') || conflict.proposedTitle || doc.title,
      changeKind: 'merge', source: 'conflict', actor,
      reason: options.note ?? (options.mode === 'merge' ? ('冲突处理：人工合并（冲突 ' + id + '）') : ('冲突处理：采用新提议（冲突 ' + id + '）')),
    })
  }
  run(db, 'UPDATE conflicts SET status = ?, resolved_at = ?, resolved_by = ?, note = ? WHERE id = ?', [options.mode, Date.now(), actor, options.note ?? null, id])
  recordReviewLog(db, { action: 'resolve_conflict', itemKind: 'conflict', itemId: id, docId: conflict.docId, kbId: conflict.kbId, actor, note: options.mode })
  return { conflict: getConflict(db, id)!, document }
}

/** 审核队列里的文档摘要（不含正文，避免一次返回过多内容）。 */
export interface ReviewDocSummary {
  id: string
  kbId: string
  kbName?: string
  kind: string
  slug?: string
  title: string
  status?: string
  verifyState?: string
  tags?: string[]
  path?: string
  currentVersion?: number
  updatedAt: string
  createdAt?: string
}

export interface ReviewQueueFilters {
  limit?: number
  offset?: number
  page?: number
  /** 候选类型：create / update / restore / stale（只作用于候选列表）。 */
  kind?: string | null
  /** 关键词：匹配候选标题/正文与草稿、过时文档标题。 */
  q?: string | null
  /** 候选来源：agent / pipeline / web / rule 等（只作用于候选列表）。 */
  source?: string | null
  /** 排序：newest（默认，按时间倒序）/ oldest（最早优先）/ updated（最近更新优先）。 */
  order?: string | null
}

/** 排序取值：只接受这三个，其他值按 newest 处理。 */
export const REVIEW_ORDERS = ['newest', 'oldest', 'updated'] as const

export interface ReviewQueueCounts {
  proposals: number
  conflicts: number
  drafts: number
  stale: number
  total: number
}

export interface ReviewQueuePagination {
  limit: number
  offset: number
  page: number
  totals: ReviewQueueCounts
}

export interface ReviewQueue {
  scopeKbIds: string[]
  /** 当前筛选条件下的各项数量（真实 SQL COUNT，不再用返回页长度推算）。 */
  counts: ReviewQueueCounts
  /** 当前作用域内全部待处理数量（不受筛选影响，用于页头徽标）。 */
  pendingTotal: number
  pagination: ReviewQueuePagination
  filters: { kind: string | null; q: string | null; source: string | null; order: string }
  proposals: ProposalRow[]
  conflicts: ConflictRow[]
  drafts: ReviewDocSummary[]
  staleDocuments: ReviewDocSummary[]
}

function queueOptions(input: number | ReviewQueueFilters | undefined): { limit: number; offset: number; kind: string | null; q: string | null; source: string | null; order: string } {
  if (typeof input === 'number') return { limit: Math.max(1, Math.min(200, input)), offset: 0, kind: null, q: null, source: null, order: 'newest' }
  const value = input ?? {}
  const limit = Math.max(1, Math.min(100, Number(value.limit) || 50))
  const page = Math.max(1, Number(value.page) || 1)
  const offset = value.offset !== undefined ? Math.max(0, Number(value.offset) || 0) : (page - 1) * limit
  const rawOrder = typeof value.order === 'string' ? value.order.trim() : ''
  const order = (REVIEW_ORDERS as readonly string[]).indexOf(rawOrder) >= 0 ? rawOrder : 'newest'
  return {
    limit, offset, order,
    kind: typeof value.kind === 'string' && value.kind.trim() !== '' ? value.kind.trim() : null,
    q: typeof value.q === 'string' && value.q.trim() !== '' ? value.q.trim() : null,
    source: typeof value.source === 'string' && value.source.trim() !== '' ? value.source.trim() : null,
  }
}

/** 按排序方向生成四类列表的 ORDER BY 片段（列名固定，值只来自 REVIEW_ORDERS，无 SQL 注入面）。 */
function orderByFor(order: string): { created: string; detected: string; updated: string } {
  if (order === 'oldest') return { created: 'p.created_at ASC', detected: 'c.detected_at ASC', updated: 'd.updated_at ASC' }
  if (order === 'updated') return { created: 'p.created_at ASC', detected: 'c.detected_at ASC', updated: 'd.updated_at DESC' }
  return { created: 'p.created_at DESC', detected: 'c.detected_at DESC', updated: 'd.updated_at DESC' }
}

function countRows(db: Db, sql: string, params: (string | number)[]): number {
  const row = get<any>(db, sql, params)
  return Number(row?.n ?? 0)
}

function docSummary(raw: any): ReviewDocSummary {
  return {
    id: String(raw.id), kbId: String(raw.kb_id), kbName: String(raw.kb_name ?? ''), kind: String(raw.kind), slug: String(raw.slug),
    title: String(raw.title), status: String(raw.status), verifyState: String(raw.verify_state), tags: parseJsonArray(raw.tags).map(String),
    path: String(raw.path), currentVersion: Number(raw.current_version),
    updatedAt: new Date(Number(raw.updated_at)).toISOString(), createdAt: new Date(Number(raw.created_at)).toISOString(),
  }
}

/** 待审核总览：候选 + 冲突 + 草稿 + 过时文档；支持类型/关键词/来源筛选与分页，计数为真实 SQL COUNT。 */
export function reviewQueue(db: Db, kbIds: string[], options?: number | ReviewQueueFilters): ReviewQueue {
  const opt = queueOptions(options)
  const orderBy = orderByFor(opt.order)
  const ids = kbIds
  const emptyCounts: ReviewQueueCounts = { proposals: 0, conflicts: 0, drafts: 0, stale: 0, total: 0 }
  const empty: ReviewQueue = {
    scopeKbIds: ids, counts: emptyCounts, pendingTotal: 0,
    pagination: { limit: opt.limit, offset: opt.offset, page: Math.floor(opt.offset / opt.limit) + 1, totals: emptyCounts },
    filters: { kind: opt.kind, q: opt.q, source: opt.source, order: opt.order },
    proposals: [], conflicts: [], drafts: [], staleDocuments: [],
  }
  if (ids.length === 0) return empty

  const inClause = ' IN (' + ids.map(() => '?').join(', ') + ')'
  const like = opt.q === null ? null : '%' + opt.q.replace(/[%_]/g, '') + '%'

  const proposalWhere: string[] = ['p.kb_id' + inClause, "p.status = 'pending'"]
  const proposalParams: (string | number)[] = [...ids]
  if (opt.kind !== null) { proposalWhere.push('p.kind = ?'); proposalParams.push(opt.kind) }
  if (opt.source !== null) { proposalWhere.push('p.source = ?'); proposalParams.push(opt.source) }
  if (like !== null) { proposalWhere.push('(p.title LIKE ? OR p.body LIKE ?)'); proposalParams.push(like, like) }
  const proposalFrom = ' FROM proposals p WHERE ' + proposalWhere.join(' AND ')
  const proposalTotal = countRows(db, 'SELECT COUNT(*) AS n' + proposalFrom, proposalParams)
  const proposals = all(db, 'SELECT p.*' + proposalFrom + ' ORDER BY ' + orderBy.created + ' LIMIT ? OFFSET ?', [...proposalParams, opt.limit, opt.offset]).map(toProposal)

  const conflictWhere: string[] = ['c.kb_id' + inClause, "c.status = 'pending'"]
  const conflictParams: (string | number)[] = [...ids]
  if (like !== null) { conflictWhere.push('(c.proposed_title LIKE ? OR c.proposed_body LIKE ?)'); conflictParams.push(like, like) }
  const conflictFrom = ' FROM conflicts c WHERE ' + conflictWhere.join(' AND ')
  const conflictTotal = countRows(db, 'SELECT COUNT(*) AS n' + conflictFrom, conflictParams)
  const conflicts = all(db, 'SELECT c.*' + conflictFrom + ' ORDER BY ' + orderBy.detected + ' LIMIT ? OFFSET ?', [...conflictParams, opt.limit, opt.offset]).map(toConflict)

  const docWhere: string[] = ['d.deleted_at IS NULL', "d.status = 'draft'", 'd.kb_id' + inClause]
  const docParams: (string | number)[] = [...ids]
  if (like !== null) { docWhere.push('(d.title LIKE ? OR d.body LIKE ?)'); docParams.push(like, like) }
  const docFrom = ' FROM documents d JOIN knowledge_bases b ON b.id = d.kb_id WHERE ' + docWhere.join(' AND ')
  const draftTotal = countRows(db, 'SELECT COUNT(*) AS n' + docFrom, docParams)
  const drafts = all(db, 'SELECT d.*, b.name AS kb_name' + docFrom + ' ORDER BY ' + orderBy.updated + ' LIMIT ? OFFSET ?', [...docParams, opt.limit, opt.offset]).map(docSummary)

  const staleWhere: string[] = ['d.deleted_at IS NULL', "d.status = 'stale'", 'd.kb_id' + inClause]
  const staleParams: (string | number)[] = [...ids]
  if (like !== null) { staleWhere.push('(d.title LIKE ? OR d.body LIKE ?)'); staleParams.push(like, like) }
  const staleFrom = ' FROM documents d JOIN knowledge_bases b ON b.id = d.kb_id WHERE ' + staleWhere.join(' AND ')
  const staleTotal = countRows(db, 'SELECT COUNT(*) AS n' + staleFrom, staleParams)
  const staleDocuments = all(db, 'SELECT d.*, b.name AS kb_name' + staleFrom + ' ORDER BY ' + orderBy.updated + ' LIMIT ? OFFSET ?', [...staleParams, opt.limit, opt.offset]).map(docSummary)

  const counts: ReviewQueueCounts = {
    proposals: proposalTotal, conflicts: conflictTotal, drafts: draftTotal, stale: staleTotal,
    total: proposalTotal + conflictTotal + draftTotal + staleTotal,
  }
  const pendingTotal =
    countRows(db, "SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending' AND kb_id" + inClause, [...ids]) +
    countRows(db, "SELECT COUNT(*) AS n FROM conflicts WHERE status = 'pending' AND kb_id" + inClause, [...ids]) +
    countRows(db, "SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL AND status = 'draft' AND kb_id" + inClause, [...ids]) +
    countRows(db, "SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL AND status = 'stale' AND kb_id" + inClause, [...ids])

  return {
    scopeKbIds: ids,
    counts,
    pendingTotal,
    pagination: { limit: opt.limit, offset: opt.offset, page: Math.floor(opt.offset / opt.limit) + 1, totals: counts },
    filters: { kind: opt.kind, q: opt.q, source: opt.source, order: opt.order },
    proposals, conflicts, drafts, staleDocuments,
  }
}

export interface BulkReviewItem { type: 'proposal' | 'doc'; id: string }
export interface BulkReviewResult { ok: boolean; type: string; id: string; status?: string; message?: string; conflictId?: string }

/** 批量审核：逐条处理，单条失败不影响其他条；返回每条结果与汇总。 */
export async function bulkReview(
  db: Db,
  storageRoot: string,
  items: BulkReviewItem[],
  action: 'approve' | 'reject',
  options: { actor?: string | null; note?: string | null },
): Promise<{ results: BulkReviewResult[]; approved: number; rejected: number; failed: number }> {
  if (action !== 'approve' && action !== 'reject') throw new ReviewError('BULK_INVALID_ACTION', 400, '批量动作必须是 approve 或 reject')
  if (!Array.isArray(items) || items.length === 0) throw new ReviewError('BULK_EMPTY', 400, '请至少选择一条待审核项')
  if (items.length > 50) throw new ReviewError('BULK_TOO_MANY', 400, '单次批量最多 50 条，请分批处理')
  const results: BulkReviewResult[] = []
  for (const item of items) {
    const type = item?.type === 'doc' ? 'doc' : item?.type === 'proposal' ? 'proposal' : ''
    const id = str(item?.id)
    if (type === '' || id === '') { results.push({ ok: false, type: String(item?.type ?? ''), id, message: '缺少 type（proposal/doc）或 id' }); continue }
    try {
      if (type === 'proposal') {
        if (action === 'approve') {
          const result = await approveProposal(db, storageRoot, id, { actor: options.actor ?? null, note: options.note ?? null })
          results.push({ ok: true, type, id, status: result.conflict ? 'conflict' : 'approved', conflictId: result.conflict?.id, message: result.conflict ? '版本冲突，已生成冲突项' : '已批准' })
        } else {
          const proposal = rejectProposal(db, id, { actor: options.actor ?? null, note: options.note ?? null })
          results.push({ ok: true, type, id, status: proposal.status, message: '已拒绝' })
        }
      } else {
        const doc = getDocument(db, id)
        if (!doc) throw new ReviewError('DOC_NOT_FOUND', 404, '知识不存在：' + id)
        const updated = reviewDocument(db, doc, action, { actor: options.actor ?? null, note: options.note ?? null })
        results.push({ ok: true, type, id, status: updated.status, message: action === 'approve' ? '已批准' : '已归档' })
      }
    } catch (error: any) {
      results.push({ ok: false, type, id, message: error?.message ?? String(error) })
    }
  }
  const approved = results.filter((item) => item.ok && action === 'approve').length
  const rejected = results.filter((item) => item.ok && action === 'reject').length
  if (results.some((item) => item.ok)) {
    recordReviewLog(db, { action: 'bulk_' + action, itemKind: 'bulk', itemId: 'bulk', actor: options.actor ?? null, note: '批量' + (action === 'approve' ? '批准' : '拒绝') + ' ' + (approved + rejected) + ' 条，失败 ' + results.filter((item) => !item.ok).length + ' 条' })
  }
  return { results, approved, rejected, failed: results.filter((item) => !item.ok).length }
}

export interface AutoApproveRules {
  enabled: boolean
  maxDiffLines?: number
  actor?: string | null
}

/** 自动批准低风险 wiki 更新：默认关闭；仅 update + wiki + 已批准基线一致 + 差异行数不超阈值时通过。 */
export async function autoApproveIfEligible(
  db: Db,
  storageRoot: string,
  proposal: ProposalRow,
  rules: AutoApproveRules,
): Promise<{ proposal: ProposalRow; autoApproved: boolean; reason?: string }> {
  if (!rules.enabled) return { proposal, autoApproved: false, reason: '自动批准未开启' }
  if (proposal.status !== 'pending') return { proposal, autoApproved: false, reason: '候选已处理' }
  if (proposal.kind !== 'update') return { proposal, autoApproved: false, reason: '仅 update 候选可自动批准' }
  if (proposal.docKind !== 'wiki') return { proposal, autoApproved: false, reason: '仅 wiki 类型可自动批准' }
  if (!proposal.docId) return { proposal, autoApproved: false, reason: '缺少目标文档' }
  const doc = getDocument(db, proposal.docId)
  if (!doc) return { proposal, autoApproved: false, reason: '目标文档不存在' }
  if (doc.status !== 'approved') return { proposal, autoApproved: false, reason: '目标文档不是已批准状态' }
  if (proposal.baseVersion !== null && doc.currentVersion !== proposal.baseVersion) return { proposal, autoApproved: false, reason: '基线版本已变化，需要人工审核' }
  const max = Math.max(1, Math.min(200, rules.maxDiffLines ?? 10))
  const diff = diffLines(doc.body, proposal.body)
  const changed = diff.lines.filter((line) => line.type !== 'equal').length
  if (changed > max) return { proposal, autoApproved: false, reason: '差异 ' + changed + ' 行超过阈值 ' + max }
  const actor = rules.actor ?? 'auto:rule'
  const note = '自动批准：低风险 wiki 更新（差异 ' + changed + ' 行 ≤ 阈值 ' + max + '）'
  const result = await approveProposal(db, storageRoot, proposal.id, { actor, note })
  recordReviewLog(db, { action: 'auto_approve', itemKind: 'proposal', itemId: proposal.id, docId: result.document?.id ?? proposal.docId, kbId: proposal.kbId, actor, note })
  return { proposal: result.proposal, autoApproved: true, reason: note }
}

/** 草稿「编辑后批准」：有改动时先追加 review 版本（status=approved），再走一次 approve 打审核标记。 */
export async function approveDocumentWithEdits(
  db: Db,
  storageRoot: string,
  doc: DocRow,
  input: { title?: unknown; body?: unknown; actor?: string | null; note?: string | null },
): Promise<DocRow> {
  const body = typeof input.body === 'string' && input.body.trim() !== '' ? input.body : doc.body
  const title = str(input.title) || doc.title
  const actor = input.actor ?? 'web'
  const changed = body !== doc.body || title !== doc.title
  let target = doc
  if (changed) {
    target = await appendVersion(db, storageRoot, doc, {
      body, title, changeKind: 'update', source: 'review', actor, status: 'approved',
      reason: input.note ?? '审核时编辑后批准',
    })
    recordReviewLog(db, { action: 'doc_edit', itemKind: 'doc', itemId: doc.id, docId: doc.id, kbId: doc.kbId, actor, note: input.note ?? '审核时编辑后批准' })
  }
  return reviewDocument(db, target, 'approve', { actor, note: input.note ?? null })
}

/** 文档 + 全部版本 + 差异（供审核 UI 使用）。 */
export function documentReviewDetail(db: Db, doc: DocRow): any {
  const versions = listVersions(db, doc.id)
  const previous = versions.length > 1 ? versions[1] : undefined
  const diff = previous ? diffVersions(db, doc, previous.version, doc.currentVersion) : { lines: [], stats: { added: 0, removed: 0, unchanged: 0 }, truncated: false }
  return { document: doc, versions, changesSincePrevious: diff, pendingProposals: listProposals(db, { kbIds: [doc.kbId], status: 'pending', limit: 50 }).filter((item) => item.docId === doc.id), pendingConflicts: listConflicts(db, { kbIds: [doc.kbId], status: 'pending', limit: 50 }).filter((item) => item.docId === doc.id) }
}

/** 人工编辑已批准文档：追加 update 版本（来源 manual），不静默覆盖。 */
export async function updateDocumentByHuman(db: Db, storageRoot: string, doc: DocRow, input: { title?: unknown; body?: unknown; tags?: unknown; verifyState?: unknown; note?: unknown }, actor: string | null): Promise<DocRow> {
  const body = typeof input.body === 'string' ? input.body : doc.body
  const title = str(input.title) || doc.title
  const tags = Array.isArray(input.tags) ? input.tags.map(String).filter((tag) => tag.trim() !== '') : doc.tags
  const verifyState = str(input.verifyState) || doc.verifyState
  if (!VERIFY_STATES.includes(verifyState as any)) throw new ReviewError('DOC_INVALID_INPUT', 400, '验证状态必须是 ' + VERIFY_STATES.join(' / ') + ' 之一')
  const updated = await appendVersion(db, storageRoot, doc, {
    body, title, tags, verifyState, changeKind: 'update', source: 'manual', actor,
    reason: str(input.note) || '人工编辑',
  })
  recordReviewLog(db, { action: 'doc_edit', itemKind: 'doc', itemId: doc.id, docId: doc.id, kbId: doc.kbId, actor, note: str(input.note) || null })
  return updated
}

export { restoreVersion }
