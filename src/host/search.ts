/**
 * 文档与检索层。
 *
 * 一致性协议（与 docs/data-model.md 一致）：
 *   1) 写 write_intents（写前日志）
 *   2) 原子写 Markdown 正文（tmp → rename）
 *   3) BEGIN IMMEDIATE 事务：insert documents + doc_versions + doc_fts，删除 write_intents
 *   4) 事务失败则回滚数据库并删除刚写入的 Markdown，保证不会「文件有、库无」
 *
 * 检索：SQLite FTS5（tokenize='trigram'）优先；查询不足 3 个字符时回退 LIKE
 * （trigram 无法匹配 1–2 字中文，这是 FTS5 trigram 的已知限制）。
 */
import { rm } from 'node:fs/promises'
import { all, get, run, transaction, type Db } from './db/db.js'
import { atomicWrite, docFilePath } from './kb/files.js'
import { contentHash, type KbRow } from './kb/store.js'
import { newId } from './utils/id.js'

export const DOC_KINDS = ['wiki', 'memory', 'decision', 'convention', 'issue', 'todo', 'preference'] as const
export const DOC_STATUS = ['draft', 'approved', 'stale', 'archived'] as const
export const VERIFY_STATES = ['observed', 'inferred', 'assumed', 'unverified'] as const

export interface DocRow {
  id: string
  kbId: string
  kbName?: string
  scope?: string
  scopeKey?: string
  kind: string
  slug: string
  title: string
  body: string
  path: string
  contentHash: string
  status: string
  verifyState: string
  confidence: number | null
  tags: string[]
  currentVersion: number
  sourceSessionId: string | null
  /** 上级知识 ID（父级知识层级）；null 表示顶层知识。 */
  parentId: string | null
  createdAt: string
  updatedAt: string
}

export class DocError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

function toDoc(raw: any): DocRow {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(String(raw.tags ?? '[]'))
    if (Array.isArray(parsed)) tags = parsed.map(String)
  } catch { /* 忽略损坏的 tags */ }
  return {
    id: String(raw.id),
    kbId: String(raw.kb_id),
    kbName: raw.kb_name === undefined ? undefined : String(raw.kb_name),
    scope: raw.scope === undefined ? undefined : String(raw.scope),
    scopeKey: raw.scope_key === undefined ? undefined : String(raw.scope_key),
    kind: String(raw.kind),
    slug: String(raw.slug),
    title: String(raw.title),
    body: String(raw.body ?? ''),
    path: String(raw.path),
    contentHash: String(raw.content_hash),
    status: String(raw.status),
    verifyState: String(raw.verify_state),
    confidence: raw.confidence === null || raw.confidence === undefined ? null : Number(raw.confidence),
    tags,
    currentVersion: Number(raw.current_version),
    sourceSessionId: raw.source_session_id === null || raw.source_session_id === undefined ? null : String(raw.source_session_id),
    parentId: raw.parent_id === null || raw.parent_id === undefined || raw.parent_id === '' ? null : String(raw.parent_id),
    createdAt: new Date(Number(raw.created_at)).toISOString(),
    updatedAt: new Date(Number(raw.updated_at)).toISOString(),
  }
}

export function slugify(title: string): string {
  const base = title.trim().toLowerCase()
    .replace(/[\s\/\\:*?"<>|]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_.]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  return base === '' ? 'doc' : base
}

export function renderDocument(doc: DocRow): string {
  return [
    '---',
    'id: ' + doc.id,
    'kbId: ' + doc.kbId,
    'kind: ' + doc.kind,
    'title: ' + JSON.stringify(doc.title),
    'status: ' + doc.status,
    'verifyState: ' + doc.verifyState,
    'tags: ' + JSON.stringify(doc.tags),
    ...(doc.parentId === null ? [] : ['parentId: ' + doc.parentId]),
    'updatedAt: ' + doc.updatedAt,
    '---',
    '',
    doc.body,
    '',
  ].join('\n')
}

export interface CreateDocInput {
  title?: unknown
  kind?: unknown
  body?: unknown
  tags?: unknown
  status?: unknown
  verifyState?: unknown
  confidence?: unknown
  sourceSessionId?: unknown
  parentId?: unknown
}

/** 父级知识最大层级（含顶层，最多 5 层），避免无限嵌套。 */
export const MAX_DOC_DEPTH = 5

/**
 * 取一条知识到顶层的深度（顶层 = 1）。
 * 遇到环或超过上限立刻停下，保证不会死循环。
 */
export function documentDepth(db: Db, docId: string): number {
  let depth = 1
  let current: string | null = docId
  const seen = new Set<string>()
  while (current !== null && depth <= MAX_DOC_DEPTH + 1) {
    if (seen.has(current)) return MAX_DOC_DEPTH + 1
    seen.add(current)
    const row: { parent_id: string | null } | undefined = get(db, 'SELECT parent_id FROM documents WHERE id = ?', [current])
    const parent: string | null = row?.parent_id ? String(row.parent_id) : null
    if (parent === null) break
    depth += 1
    current = parent
  }
  return depth
}

/**
 * 校验 parentId 是否可用：必须存在、属于同一知识库、不是自身、不形成环、且不会超过最大层级。
 * 返回规范化的父级 ID（空字符串视为取消父级，返回 null）。
 */
export function resolveParentId(db: Db, kbId: string, docId: string | null, rawParentId: unknown): string | null {
  const value = typeof rawParentId === 'string' ? rawParentId.trim() : ''
  if (value === '') return null
  if (docId !== null && value === docId) throw new DocError('DOC_PARENT_INVALID', 400, '知识不能把自己设为上级')
  const parent = get<{ kb_id: string; deleted_at: number | null }>(db, 'SELECT kb_id, deleted_at FROM documents WHERE id = ?', [value])
  if (!parent || parent.deleted_at !== null) throw new DocError('DOC_PARENT_INVALID', 400, '上级知识不存在：' + value)
  if (String(parent.kb_id) !== kbId) throw new DocError('DOC_PARENT_INVALID', 400, '上级知识必须属于同一个知识库')
  const parentDepth = documentDepth(db, value)
  if (parentDepth >= MAX_DOC_DEPTH) throw new DocError('DOC_PARENT_INVALID', 400, '父级层级过深：最多支持 ' + MAX_DOC_DEPTH + ' 层')
  if (docId !== null) {
    // 沿 value 的父链向上走：祖先里出现自己就说明会形成环。
    let cursor: string | null = value
    const seen = new Set<string>()
    let steps = 0
    while (cursor !== null && steps <= MAX_DOC_DEPTH + 2) {
      if (cursor === docId) throw new DocError('DOC_PARENT_INVALID', 400, '上级知识设置有环：不能把下级知识设为上级')
      if (seen.has(cursor)) throw new DocError('DOC_PARENT_INVALID', 400, '上级知识链存在环，无法设置父级')
      seen.add(cursor)
      const row: { parent_id: string | null } | undefined = get(db, 'SELECT parent_id FROM documents WHERE id = ?', [cursor])
      cursor = row?.parent_id ? String(row.parent_id) : null
      steps += 1
    }
    // 子树的最高高度：整个子树下移后不能超过最大层级。
    const rows = all<{ id: string; depth: number }>(db,
      'WITH RECURSIVE sub(id, depth) AS (' +
      'SELECT id, 1 FROM documents WHERE id = ? AND deleted_at IS NULL ' +
      'UNION ALL SELECT d.id, sub.depth + 1 FROM documents d JOIN sub ON d.parent_id = sub.id WHERE d.deleted_at IS NULL AND sub.depth < ?' +
      ') SELECT id, depth FROM sub',
      [docId, MAX_DOC_DEPTH + 1])
    const subtreeHeight = rows.reduce((max: number, row: any) => Math.max(max, Number(row.depth)), 1)
    if (parentDepth + subtreeHeight > MAX_DOC_DEPTH) {
      throw new DocError('DOC_PARENT_INVALID', 400, '父级层级过深：最多支持 ' + MAX_DOC_DEPTH + ' 层')
    }
  }
  return value
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function createDocument(db: Db, storageRoot: string, kb: KbRow, input: CreateDocInput): Promise<DocRow> {
  const title = str(input.title)
  const body = typeof input.body === 'string' ? input.body : ''
  const kind = str(input.kind) || 'memory'
  if (title === '') throw new DocError('DOC_INVALID_INPUT', 400, '知识标题不能为空')
  if (body.trim() === '') throw new DocError('DOC_INVALID_INPUT', 400, '知识正文不能为空')
  if (!DOC_KINDS.includes(kind as any)) throw new DocError('DOC_INVALID_INPUT', 400, '知识类型必须是 ' + DOC_KINDS.join(' / ') + ' 之一')
  const status = str(input.status) || 'draft'
  if (!DOC_STATUS.includes(status as any)) throw new DocError('DOC_INVALID_INPUT', 400, '知识状态必须是 ' + DOC_STATUS.join(' / ') + ' 之一')
  const verifyState = str(input.verifyState) || 'unverified'
  if (!VERIFY_STATES.includes(verifyState as any)) throw new DocError('DOC_INVALID_INPUT', 400, '验证状态必须是 ' + VERIFY_STATES.join(' / ') + ' 之一')
  const tags = Array.isArray(input.tags) ? input.tags.map(String).filter((tag) => tag.trim() !== '') : []
  const rawConfidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : null
  const parentId = resolveParentId(db, kb.id, null, input.parentId)

  let slug = slugify(title)
  for (let index = 2; ; index += 1) {
    const taken = get(db, 'SELECT id FROM documents WHERE kb_id = ? AND slug = ? AND deleted_at IS NULL', [kb.id, slug])
    if (!taken) break
    slug = slugify(title) + '-' + index
  }

  const timestamp = Date.now()
  const hash = contentHash(body)
  const doc: DocRow = {
    id: newId('doc'),
    kbId: kb.id,
    kbName: kb.name,
    scope: kb.scope,
    scopeKey: kb.scopeKey,
    kind,
    slug,
    title,
    body,
    path: docFilePath(storageRoot, kb.id, kind, slug),
    contentHash: hash,
    status,
    verifyState,
    confidence: rawConfidence,
    tags,
    currentVersion: 1,
    sourceSessionId: str(input.sourceSessionId) || null,
    parentId,
    createdAt: new Date(timestamp).toISOString(),
    updatedAt: new Date(timestamp).toISOString(),
  }

  run(db, 'INSERT INTO write_intents (doc_id, path, hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET path = excluded.path, hash = excluded.hash, created_at = excluded.created_at', [doc.id, doc.path, hash, timestamp])
  await atomicWrite(doc.path, renderDocument(doc))
  try {
    transaction(db, () => {
      run(db, 'INSERT INTO documents (id, kb_id, kind, slug, title, body, path, content_hash, status, verify_state, confidence, tags, current_version, source_session_id, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        doc.id, doc.kbId, doc.kind, doc.slug, doc.title, doc.body, doc.path, doc.contentHash, doc.status, doc.verifyState, doc.confidence, JSON.stringify(doc.tags), 1, doc.sourceSessionId, doc.parentId, timestamp, timestamp,
      ])
      run(db, 'INSERT INTO doc_versions (doc_id, version, content, content_hash, change_kind, source, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [doc.id, 1, doc.body, hash, 'create', 'manual', null, null, timestamp])
      run(db, 'INSERT INTO doc_fts (doc_id, title, body, tags) VALUES (?, ?, ?, ?)', [doc.id, doc.title, doc.body, doc.tags.join(' ')])
      run(db, 'DELETE FROM write_intents WHERE doc_id = ?', [doc.id])
    })
  } catch (error) {
    await rm(doc.path, { force: true }).catch(() => undefined)
    throw error
  }
  return doc
}

export interface DocumentListFilters {
  kbIds: string[]
  kind?: string
  status?: string
  /** 只看某个上级的知识；传 null 只看顶层知识；不传表示不限制层级。 */
  parentId?: string | null
  limit?: number
  offset?: number
}

function documentWhere(filters: DocumentListFilters): { sql: string; params: (string | number)[] } {
  const where: string[] = ['d.deleted_at IS NULL', 'd.kb_id IN (' + filters.kbIds.map(() => '?').join(', ') + ')']
  const params: (string | number)[] = [...filters.kbIds]
  if (filters.kind) { where.push('d.kind = ?'); params.push(filters.kind) }
  if (filters.status) { where.push('d.status = ?'); params.push(filters.status) }
  if (filters.parentId !== undefined) {
    if (filters.parentId === null) where.push('d.parent_id IS NULL')
    else { where.push('d.parent_id = ?'); params.push(filters.parentId) }
  }
  return { sql: where.join(' AND '), params }
}

/** 与 listDocuments 完全同条件的真实总数（分页用）。 */
export function countDocumentList(db: Db, filters: Omit<DocumentListFilters, 'limit' | 'offset'>): number {
  if (filters.kbIds.length === 0) return 0
  const where = documentWhere(filters)
  const row = get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM documents d WHERE ' + where.sql, where.params)
  return Number(row?.n ?? 0)
}

export function listDocuments(db: Db, filters: DocumentListFilters): DocRow[] {
  if (filters.kbIds.length === 0) return []
  const where = documentWhere(filters)
  const params = where.params.slice()
  const limit = Math.max(1, Math.min(200, filters.limit ?? 50))
  const offset = Math.max(0, filters.offset ?? 0)
  params.push(limit, offset)
  return all(db, 'SELECT d.*, b.name AS kb_name, b.scope, b.scope_key FROM documents d JOIN knowledge_bases b ON b.id = d.kb_id WHERE ' + where.sql + ' ORDER BY d.updated_at DESC LIMIT ? OFFSET ?', params).map(toDoc)
}

function escapeFts(token: string): string {
  return '"' + token.replace(/"/g, '""') + '"'
}

function buildMatchExpr(query: string): string {
  const tokens = query.split(/\s+/).filter((token) => [...token].length >= 1)
  return tokens.map(escapeFts).join(' AND ')
}

function snippet(body: string, query: string, radius = 70): string {
  const singleLine = body.replace(/\s+/g, ' ').trim()
  const index = singleLine.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return singleLine.slice(0, radius * 2)
  const start = Math.max(0, index - radius)
  const end = Math.min(singleLine.length, index + query.length + radius)
  return (start > 0 ? '…' : '') + singleLine.slice(start, end) + (end < singleLine.length ? '…' : '')
}

export interface SearchInput {
  query: string
  scopeKeys: string[]
  /** 标签过滤（AND 语义，最多 6 个，大小写不敏感）。 */
  tags?: string[]
  kbId?: string
  kind?: string
  status?: string
  sort?: 'relevance' | 'updated'
  limit?: number
  offset?: number
}

export interface SearchHit {
  id: string
  kbId: string
  kbName: string
  scope: string
  kind: string
  title: string
  snippet: string
  tags: string[]
  status: string
  verifyState: string
  confidence: number | null
  path: string
  updatedAt: string
  score: number
  matchedBy: 'fts' | 'like' | 'recent'
  contentHash?: string
  /** 内容哈希相同、被合并掉的重复结果数量。 */
  duplicates?: number
  /** 被合并掉的重复结果所属知识库。 */
  duplicateKbIds?: string[]
}

export function searchDocuments(db: Db, input: SearchInput): { hits: SearchHit[]; total: number; mode: 'fts' | 'like' | 'recent'; duplicatesMerged: number } {
  const limit = Math.max(1, Math.min(100, input.limit ?? 20))
  const offset = Math.max(0, input.offset ?? 0)
  const visible = input.scopeKeys.length === 0
    ? []
    : all(db, 'SELECT id, name, scope, scope_key FROM knowledge_bases WHERE deleted_at IS NULL AND scope_key IN (' + input.scopeKeys.map(() => '?').join(', ') + ')', input.scopeKeys) as any[]
  if (visible.length === 0) return { hits: [], total: 0, mode: 'recent', duplicatesMerged: 0 }
  const visibleIds = visible.map((row) => String(row.id))
  if (input.kbId) {
    if (!visibleIds.includes(input.kbId)) throw new DocError('SEARCH_KB_FORBIDDEN', 403, '该知识库不在当前作用域内，拒绝检索：' + input.kbId)
  }
  const kbIds = input.kbId ? [input.kbId] : visibleIds
  const baseWhere = ['d.deleted_at IS NULL', 'd.kb_id IN (' + kbIds.map(() => '?').join(', ') + ')']
  const baseParams: (string | number)[] = [...kbIds]
  if (input.kind) { baseWhere.push('d.kind = ?'); baseParams.push(input.kind) }
  const statusFilter = input.status ?? 'approved'
  if (statusFilter !== 'any') { baseWhere.push('d.status = ?'); baseParams.push(statusFilter) }
  const tags = (input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag !== '').slice(0, 6)
  for (const tag of tags) {
    baseWhere.push('EXISTS (SELECT 1 FROM json_each(d.tags) WHERE lower(json_each.value) = lower(?))')
    baseParams.push(tag)
  }

  const query = input.query.trim()
  const queryLength = [...query].length
  const sortRecent = input.sort === 'updated' || query === '' || queryLength < 3

  let rows: any[]
  let mode: SearchHit['matchedBy']
  if (query === '') {
    mode = 'recent'
    rows = all(db, 'SELECT d.*, b.name AS kb_name, b.scope, b.scope_key, 0 AS score FROM documents d JOIN knowledge_bases b ON b.id = d.kb_id WHERE ' + baseWhere.join(' AND ') + ' ORDER BY d.updated_at DESC LIMIT ? OFFSET ?', [...baseParams, limit, offset])
  } else if (queryLength >= 3) {
    mode = 'fts'
    const match = buildMatchExpr(query)
    rows = all(db, 'SELECT d.*, b.name AS kb_name, b.scope, b.scope_key, bm25(doc_fts) AS score FROM doc_fts JOIN documents d ON d.id = doc_fts.doc_id JOIN knowledge_bases b ON b.id = d.kb_id WHERE doc_fts MATCH ? AND ' + baseWhere.join(' AND ') + ' ORDER BY ' + (sortRecent ? 'd.updated_at DESC' : 'score ASC') + ' LIMIT ? OFFSET ?', [match, ...baseParams, limit, offset])
  } else {
    mode = 'like'
    const like = '%' + query.replace(/[%_]/g, '') + '%'
    rows = all(db, 'SELECT d.*, b.name AS kb_name, b.scope, b.scope_key, 1 AS score FROM documents d JOIN knowledge_bases b ON b.id = d.kb_id WHERE ' + baseWhere.join(' AND ') + ' AND (d.title LIKE ? OR d.body LIKE ?) ORDER BY ' + (sortRecent ? 'd.updated_at DESC' : 'CASE WHEN d.title LIKE ? THEN 0 ELSE 1 END ASC') + ' LIMIT ? OFFSET ?', [...baseParams, like, like, ...(sortRecent ? [] : [like]), limit, offset])
  }

  const hits: SearchHit[] = rows.map((row) => {
    const doc = toDoc(row)
    return {
      id: doc.id,
      kbId: doc.kbId,
      kbName: doc.kbName ?? '',
      scope: doc.scope ?? '',
      kind: doc.kind,
      title: doc.title,
      snippet: snippet(doc.body, query),
      tags: doc.tags,
      status: doc.status,
      verifyState: doc.verifyState,
      confidence: doc.confidence,
      path: doc.path,
      updatedAt: doc.updatedAt,
      score: Number(row.score ?? 0),
      matchedBy: mode,
      contentHash: doc.contentHash,
      duplicates: 0,
      duplicateKbIds: [],
    }
  })
  // 重复结果合并：内容哈希相同的命中只保留一条（优先已批准、再优先工作区级、再评分），并记录被合并的数量与来源库
  const merged: SearchHit[] = []
  const byContent = new Map<string, SearchHit>()
  const rank = (hit: SearchHit): number => (hit.status === 'approved' ? 0 : 10) + (hit.scope === 'workspace' ? 0 : 1)
  let duplicatesMerged = 0
  for (const hit of hits) {
    const key = hit.contentHash ? 'h:' + hit.contentHash : 'id:' + hit.id
    const prior = byContent.get(key)
    if (!prior) {
      const copy: SearchHit = { ...hit, duplicates: 0, duplicateKbIds: [] }
      byContent.set(key, copy)
      merged.push(copy)
      continue
    }
    duplicatesMerged += 1
    prior.duplicates = (prior.duplicates ?? 0) + 1
    if (!(prior.duplicateKbIds ?? []).includes(hit.kbId)) prior.duplicateKbIds = [...(prior.duplicateKbIds ?? []), hit.kbId]
    if (rank(hit) < rank(prior)) {
      const keepDuplicates = prior.duplicates
      const keepKbIds = prior.duplicateKbIds
      Object.assign(prior, hit, { duplicates: keepDuplicates, duplicateKbIds: keepKbIds })
    }
  }
  const totalRow = query === ''
    ? get(db, 'SELECT COUNT(*) AS n FROM documents d WHERE ' + baseWhere.join(' AND '), baseParams)
    : mode === 'fts'
      ? get(db, 'SELECT COUNT(*) AS n FROM doc_fts JOIN documents d ON d.id = doc_fts.doc_id WHERE doc_fts MATCH ? AND ' + baseWhere.join(' AND '), [buildMatchExpr(query), ...baseParams])
      : get(db, 'SELECT COUNT(*) AS n FROM documents d WHERE ' + baseWhere.join(' AND ') + ' AND (d.title LIKE ? OR d.body LIKE ?)', [...baseParams, '%' + query + '%', '%' + query + '%'])
  return { hits: merged, total: Number(totalRow?.n ?? hits.length), mode, duplicatesMerged }
}

export function getDocument(db: Db, id: string): DocRow | null {
  const raw = get(db, 'SELECT d.*, b.name AS kb_name, b.scope, b.scope_key FROM documents d JOIN knowledge_bases b ON b.id = d.kb_id WHERE d.id = ? AND d.deleted_at IS NULL', [id])
  return raw ? toDoc(raw) : null
}

export function countDocuments(db: Db, kbId: string): number {
  return Number(get(db, 'SELECT COUNT(*) AS n FROM documents WHERE kb_id = ? AND deleted_at IS NULL', [kbId])?.n ?? 0)
}
