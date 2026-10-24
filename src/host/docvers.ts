/**
 * 版本层：知识正文的每一次落地都追加一个不可变版本，绝不静默覆盖。
 *
 * 一致性协议沿用 search.ts：
 *   1) 写 write_intents（写前日志）
 *   2) 原子写 Markdown（tmp → rename）
 *   3) BEGIN IMMEDIATE：UPDATE documents + INSERT doc_versions + 重建 doc_fts + 删 write_intents
 *   4) 事务失败：回滚数据库并把 Markdown 还原为旧版本内容
 */
import { all, get, run, transaction, type Db } from './db/db.js'
import { atomicWrite } from './kb/files.js'
import { contentHash } from './kb/store.js'
import { DocError, renderDocument, type DocRow } from './search.js'

export interface VersionRecord {
  version: number
  changeKind: string
  source: string | null
  actor: string | null
  reason: string | null
  contentHash: string
  createdAt: string
}

export interface VersionInput {
  body: string
  title?: string
  tags?: string[]
  status?: string
  verifyState?: string
  confidence?: number | null
  changeKind: 'create' | 'update' | 'restore' | 'stale' | 'merge'
  source: string
  actor?: string | null
  reason?: string | null
}

/** 追加一个新版本：更新 documents 当前值、写文件、写版本记录、刷新 FTS。 */
export async function appendVersion(db: Db, storageRoot: string, doc: DocRow, input: VersionInput): Promise<DocRow> {
  const body = typeof input.body === 'string' ? input.body : ''
  if (body.trim() === '') throw new DocError('DOC_INVALID_INPUT', 400, '知识正文不能为空')
  const title = (input.title ?? doc.title).trim()
  if (title === '') throw new DocError('DOC_INVALID_INPUT', 400, '知识标题不能为空')
  const nextVersion = doc.currentVersion + 1
  const hash = contentHash(body)
  const timestamp = Date.now()
  const tags = input.tags ?? doc.tags
  const updated: DocRow = {
    ...doc,
    title,
    body,
    tags,
    status: input.status ?? doc.status,
    verifyState: input.verifyState ?? doc.verifyState,
    confidence: input.confidence === undefined ? doc.confidence : input.confidence,
    contentHash: hash,
    currentVersion: nextVersion,
    updatedAt: new Date(timestamp).toISOString(),
  }

  run(db, 'INSERT INTO write_intents (doc_id, path, hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(doc_id) DO UPDATE SET path = excluded.path, hash = excluded.hash, created_at = excluded.created_at', [doc.id, doc.path, hash, timestamp])
  await atomicWrite(doc.path, renderDocument(updated))
  try {
    transaction(db, () => {
      run(db, 'UPDATE documents SET title = ?, body = ?, content_hash = ?, status = ?, verify_state = ?, confidence = ?, tags = ?, current_version = ?, updated_at = ?, reviewed_at = NULL, reviewed_by = NULL WHERE id = ?', [
        updated.title, updated.body, hash, updated.status, updated.verifyState, updated.confidence, JSON.stringify(updated.tags), nextVersion, timestamp, doc.id,
      ])
      run(db, 'INSERT INTO doc_versions (doc_id, version, content, content_hash, change_kind, source, actor, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [doc.id, nextVersion, body, hash, input.changeKind, input.source, input.actor ?? null, input.reason ?? null, timestamp])
      run(db, 'DELETE FROM doc_fts WHERE doc_id = ?', [doc.id])
      run(db, 'INSERT INTO doc_fts (doc_id, title, body, tags) VALUES (?, ?, ?, ?)', [doc.id, updated.title, updated.body, updated.tags.join(' ')])
      run(db, 'DELETE FROM write_intents WHERE doc_id = ?', [doc.id])
    })
  } catch (error) {
    // 回滚文件到旧内容
    await atomicWrite(doc.path, renderDocument(doc)).catch(() => undefined)
    throw error
  }
  return updated
}

export function listVersions(db: Db, docId: string): VersionRecord[] {
  return all(db, 'SELECT version, change_kind, source, actor, reason, content_hash, created_at FROM doc_versions WHERE doc_id = ? ORDER BY version DESC', [docId]).map((raw: any) => ({
    version: Number(raw.version),
    changeKind: String(raw.change_kind),
    source: raw.source === null ? null : String(raw.source),
    actor: raw.actor === null ? null : String(raw.actor),
    reason: raw.reason === null ? null : String(raw.reason),
    contentHash: String(raw.content_hash),
    createdAt: new Date(Number(raw.created_at)).toISOString(),
  }))
}

export function getVersionContent(db: Db, docId: string, version: number): { version: number; content: string; changeKind: string; contentHash: string; createdAt: string } | null {
  const raw = get(db, 'SELECT version, content, change_kind, content_hash, created_at FROM doc_versions WHERE doc_id = ? AND version = ?', [docId, version])
  if (!raw) return null
  return {
    version: Number(raw.version),
    content: String(raw.content ?? ''),
    changeKind: String(raw.change_kind),
    contentHash: String(raw.content_hash),
    createdAt: new Date(Number(raw.created_at)).toISOString(),
  }
}

/** 恢复历史版本：不覆盖当前内容，而是以旧内容追加一个新版本（change_kind='restore'）。 */
export async function restoreVersion(db: Db, storageRoot: string, doc: DocRow, version: number, options: { actor?: string | null; note?: string | null }): Promise<{ document: DocRow; restoredFrom: number }> {
  const target = getVersionContent(db, doc.id, version)
  if (!target) throw new DocError('VERSION_NOT_FOUND', 404, '历史版本不存在：第 ' + version + ' 版')
  const reason = '恢复自第 ' + version + ' 版' + (options.note ? '：' + options.note : '')
  const updated = await appendVersion(db, storageRoot, doc, {
    body: target.content,
    changeKind: 'restore',
    source: 'restore',
    actor: options.actor ?? null,
    reason,
  })
  return { document: updated, restoredFrom: version }
}

export interface DiffLine { type: 'equal' | 'add' | 'del'; text: string }

/** 行级差异（LCS）。用于人工审核对比新增 / 修改 / 删除内容。 */
export function diffLines(oldText: string, newText: string, maxLines = 1200): { lines: DiffLine[]; truncated: boolean } {
  const a = oldText.replace(/\r\n/g, '\n').split('\n')
  const b = newText.replace(/\r\n/g, '\n').split('\n')
  const truncated = a.length > maxLines || b.length > maxLines
  const aa = a.slice(0, maxLines)
  const bb = b.slice(0, maxLines)
  const n = aa.length
  const m = bb.length
  if (n * m > 4_000_000) {
    // 超大文档退化为整体替换，避免内存爆炸
    return {
      lines: [
        ...aa.map((text) => ({ type: 'del' as const, text })),
        ...bb.map((text) => ({ type: 'add' as const, text })),
      ],
      truncated: true,
    }
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = aa[i] === bb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (aa[i] === bb[j]) {
      lines.push({ type: 'equal', text: aa[i]! })
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ type: 'del', text: aa[i]! })
      i += 1
    } else {
      lines.push({ type: 'add', text: bb[j]! })
      j += 1
    }
  }
  while (i < n) { lines.push({ type: 'del', text: aa[i]! }); i += 1 }
  while (j < m) { lines.push({ type: 'add', text: bb[j]! }); j += 1 }
  return { lines, truncated }
}

/** 对比两个版本（缺省为「当前版本 vs 指定版本」）。 */
export function diffVersions(db: Db, doc: DocRow, fromVersion: number | null, toVersion: number | null): {
  documentId: string
  from: number
  to: number
  lines: DiffLine[]
  truncated: boolean
  stats: { added: number; removed: number; unchanged: number }
} {
  const to = toVersion ?? doc.currentVersion
  const from = fromVersion ?? Math.max(1, to - 1)
  if (to < 1 || from < 1) throw new DocError('VERSION_INVALID', 400, '版本号必须是正整数')
  const fromContent = from === to ? { content: doc.body } : getVersionContent(db, doc.id, from)
  if (!fromContent) throw new DocError('VERSION_NOT_FOUND', 404, '历史版本不存在：第 ' + from + ' 版')
  const toContent = to === doc.currentVersion
    ? { content: doc.body }
    : getVersionContent(db, doc.id, to)
  if (!toContent) throw new DocError('VERSION_NOT_FOUND', 404, '历史版本不存在：第 ' + to + ' 版')
  const result = diffLines(fromContent.content, toContent.content)
  const stats = { added: 0, removed: 0, unchanged: 0 }
  for (const line of result.lines) {
    if (line.type === 'add') stats.added += 1
    else if (line.type === 'del') stats.removed += 1
    else stats.unchanged += 1
  }
  return { documentId: doc.id, from, to, lines: result.lines, truncated: result.truncated, stats }
}
