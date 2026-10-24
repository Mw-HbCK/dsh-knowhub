/**
 * 知识导出 / 导入（Markdown）。
 *
 * 为什么要 Markdown 而不是只给备份：
 * - 备份（backups/*.json.gz）是整库快照，只能整库恢复，不适合迁移单篇知识或做代码评审；
 * - Markdown 导出可读、可进 Git、可人工改完再导入，与「正文用 Markdown 文件存储」的设计一致。
 *
 * 格式（导出块）：
 *   <!-- knowhub:doc
 *   id: "doc_xxx"
 *   title: "项目总览"
 *   kind: "wiki"
 *   status: "approved"
 *   verifyState: "observed"
 *   tags: ["架构"]
 *   parentId: null
 *   updatedAt: "2026-..."
 *   -->
 *   正文 Markdown…
 *
 * 导入规则（保守优先）：
 * - 一律以「待审核草稿」落库，绝不因为文件里写了 approved 就直接变成已批准知识；
 * - 同名知识（同库、未删除）跳过，不覆盖已有内容；
 * - 父级引用按「导出 id → 本次新建 id，其次同库同 id，最后同标题」解析，解析不到只记警告。
 */
import { all, get, run, type Db } from './db/db.js'
import { createDocument, DOC_KINDS, DOC_STATUS, MAX_DOC_DEPTH, resolveParentId, VERIFY_STATES, type DocRow } from './search.js'
import { recordReviewLog } from './review.js'
import type { KbRow } from './kb/store.js'

export class TransferError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

export const EXPORT_FORMAT_VERSION = 1
export const IMPORT_MAX_DOCS = 200
export const IMPORT_MAX_CHARS = 2 * 1024 * 1024

export interface ExportedDocMeta {
  id?: string
  title: string
  kind: string
  status: string
  verifyState: string
  tags: string[]
  parentId: string | null
  updatedAt: string | null
}

function docHeader(doc: DocRow): string {
  return [
    '<!-- knowhub:doc',
    'id: ' + JSON.stringify(doc.id),
    'title: ' + JSON.stringify(doc.title),
    'kind: ' + JSON.stringify(doc.kind),
    'status: ' + JSON.stringify(doc.status),
    'verifyState: ' + JSON.stringify(doc.verifyState),
    'tags: ' + JSON.stringify(doc.tags),
    'parentId: ' + JSON.stringify(doc.parentId),
    'updatedAt: ' + JSON.stringify(doc.updatedAt),
    '-->',
  ].join('\n')
}

/** 单篇知识导出为 Markdown（带元信息头）。 */
export function renderDocMarkdown(doc: DocRow): string {
  return docHeader(doc) + '\n\n' + doc.body.trim() + '\n'
}

function allDocuments(db: Db, kbId: string): DocRow[] {
  const result: DocRow[] = []
  for (let offset = 0; ; offset += 200) {
    const page = all(db, 'SELECT d.*, b.name AS kb_name, b.scope, b.scope_key FROM documents d JOIN knowledge_bases b ON b.id = d.kb_id ' +
      'WHERE d.deleted_at IS NULL AND d.kb_id = ? ORDER BY d.updated_at DESC LIMIT 200 OFFSET ?', [kbId, offset])
    result.push(...page.map((raw: any) => ({
      id: String(raw.id), kbId: String(raw.kb_id), kbName: raw.kb_name, scope: raw.scope, scopeKey: raw.scope_key,
      kind: String(raw.kind), slug: String(raw.slug), title: String(raw.title), body: String(raw.body ?? ''),
      path: String(raw.path), contentHash: String(raw.content_hash), status: String(raw.status),
      verifyState: String(raw.verify_state), confidence: raw.confidence === null ? null : Number(raw.confidence),
      tags: (() => { try { const parsed = JSON.parse(String(raw.tags ?? '[]')); return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] } })(),
      currentVersion: Number(raw.current_version),
      sourceSessionId: raw.source_session_id ?? null,
      parentId: raw.parent_id ?? null,
      createdAt: new Date(Number(raw.created_at)).toISOString(),
      updatedAt: new Date(Number(raw.updated_at)).toISOString(),
    })))
    if (page.length < 200) break
  }
  return result
}

export function exportKbMarkdown(db: Db, kb: KbRow): { filename: string; content: string; documentCount: number; characters: number } {
  const docs = allDocuments(db, kb.id)
  const exportedAt = new Date().toISOString()
  const head = '<!-- knowhub:export version=' + EXPORT_FORMAT_VERSION + ' kbId=' + JSON.stringify(kb.id) +
    ' kbName=' + JSON.stringify(kb.name) + ' scope=' + JSON.stringify(kb.scope) +
    ' exportedAt=' + JSON.stringify(exportedAt) + ' documentCount=' + docs.length + ' -->'
  const body = docs.map((doc) => renderDocMarkdown(doc)).join('\n')
  const content = head + '\n\n# 知识库导出：' + kb.name + '\n\n' + body
  const stamp = exportedAt.slice(0, 10).replace(/-/g, '')
  const safeName = kb.name.replace(/[\s\/\\:*?"<>|]+/g, '-').slice(0, 60) || 'knowledge-base'
  return { filename: safeName + '-' + stamp + '.md', content, documentCount: docs.length, characters: content.length }
}

const DOC_BLOCK = /<!--\s*knowhub:doc\s*\r?\n([\s\S]*?)\r?\n-->/g

function parseMetaLine(line: string): { key: string; value: any } | null {
  const index = line.indexOf(':')
  if (index <= 0) return null
  const key = line.slice(0, index).trim()
  const raw = line.slice(index + 1).trim()
  if (key === '' || raw === '') return { key, value: null }
  try { return { key, value: JSON.parse(raw) } } catch { return { key, value: raw } }
}

export interface ParsedDoc {
  meta: ExportedDocMeta
  raw: string
  body: string
}

/** 解析导出格式；若没有任何 knowhub:doc 块，则把整段内容当作一篇普通 Markdown。 */
export function parseMarkdownExport(content: string, fallbackTitle = ''): ParsedDoc[] {
  const text = content.replace(/^\uFEFF/, '')
  const blocks: { start: number; end: number; meta: ExportedDocMeta }[] = []
  DOC_BLOCK.lastIndex = 0
  for (let match = DOC_BLOCK.exec(text); match !== null; match = DOC_BLOCK.exec(text)) {
    const headerText = match[1] ?? ''
    const meta: any = { tags: [], parentId: null, updatedAt: null }
    for (const line of headerText.split(/\r?\n/)) {
      const parsed = parseMetaLine(line)
      if (parsed === null) continue
      meta[parsed.key] = parsed.value
    }
    blocks.push({ start: match.index, end: match.index + match[0].length, meta })
  }
  if (blocks.length === 0) {
    const heading = /^#{1,3}\s+(.+)$/m.exec(text.trim())
    const title = fallbackTitle || (heading ? heading[1]!.trim() : '')
    return [{ meta: { title, kind: 'memory', status: 'draft', verifyState: 'unverified', tags: [], parentId: null, updatedAt: null }, raw: text, body: text.trim() }]
  }
  const docs: ParsedDoc[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    const next = blocks[index + 1]
    const segmentEnd = next ? next.start : text.length
    const body = text.slice(block.end, segmentEnd).trim()
    docs.push({ meta: block.meta, raw: text.slice(block.start, segmentEnd), body })
  }
  return docs
}

export interface ImportResult {
  created: { id: string; title: string; kind: string }[]
  skipped: { title: string; reason: string }[]
  failed: { title: string; message: string }[]
  parentLinked: number
  warnings: string[]
}

function normalizeKind(value: any): string {
  const kind = typeof value === 'string' ? value.trim() : ''
  return (DOC_KINDS as readonly string[]).includes(kind) ? kind : 'memory'
}

function normalizeVerifyState(value: any): string {
  const state = typeof value === 'string' ? value.trim() : ''
  return (VERIFY_STATES as readonly string[]).includes(state) ? state : 'unverified'
}

export async function importKbMarkdown(db: Db, storageRoot: string, kb: KbRow, input: { content: unknown; actor?: unknown }): Promise<ImportResult> {
  const content = typeof input.content === 'string' ? input.content : ''
  if (content.trim() === '') throw new TransferError('IMPORT_EMPTY', 400, '导入内容不能为空')
  if (content.length > IMPORT_MAX_CHARS) throw new TransferError('IMPORT_TOO_LARGE', 400, '导入内容超过 2MB 上限')
  const docs = parseMarkdownExport(content)
  if (docs.length > IMPORT_MAX_DOCS) throw new TransferError('IMPORT_TOO_MANY', 400, '单次最多导入 ' + IMPORT_MAX_DOCS + ' 篇知识（当前 ' + docs.length + ' 篇）')
  const actor = typeof input.actor === 'string' ? input.actor.trim().slice(0, 80) || null : null
  const result: ImportResult = { created: [], skipped: [], failed: [], parentLinked: 0, warnings: [] }
  const idMap = new Map<string, string>()
  const titleMap = new Map<string, string>()

  for (const doc of docs) {
    const title = typeof doc.meta.title === 'string' ? doc.meta.title.trim() : ''
    if (title === '') { result.failed.push({ title: '(无标题)', message: '缺少标题' }); continue }
    if (doc.body.trim() === '') { result.failed.push({ title, message: '正文为空' }); continue }
    const existing = get(db, 'SELECT id FROM documents WHERE kb_id = ? AND title = ? AND deleted_at IS NULL', [kb.id, title])
    if (existing) { result.skipped.push({ title, reason: '同名知识已存在，已跳过（不覆盖已有内容）' }); if (doc.meta.id) idMap.set(String(doc.meta.id), String(existing.id)); titleMap.set(title, String(existing.id)); continue }
    try {
      const created = await createDocument(db, storageRoot, kb, {
        title,
        body: doc.body,
        kind: normalizeKind(doc.meta.kind),
        // 导入一律落草稿：文件里写 approved 也不能绕过人工审核。
        status: 'draft',
        verifyState: normalizeVerifyState(doc.meta.verifyState),
        tags: Array.isArray(doc.meta.tags) ? doc.meta.tags.map(String) : [],
      })
      result.created.push({ id: created.id, title: created.title, kind: created.kind })
      titleMap.set(title, created.id)
      if (doc.meta.id) idMap.set(String(doc.meta.id), created.id)
    } catch (error) {
      result.failed.push({ title, message: error instanceof Error ? error.message : String(error) })
    }
  }

  // 第二遍：解析父级引用（新建 id → 同库 id → 同标题）。
  for (const doc of docs) {
    const parentRef = doc.meta.parentId === null || doc.meta.parentId === undefined ? '' : String(doc.meta.parentId).trim()
    if (parentRef === '') continue
    const selfTitle = typeof doc.meta.title === 'string' ? doc.meta.title.trim() : ''
    const selfId = (doc.meta.id ? idMap.get(String(doc.meta.id)) : undefined) ?? titleMap.get(selfTitle)
    if (!selfId) continue
    let targetId = idMap.get(parentRef) ?? null
    if (targetId === null) {
      const byId = get(db, 'SELECT id FROM documents WHERE id = ? AND kb_id = ? AND deleted_at IS NULL', [parentRef, kb.id])
      if (byId) targetId = String(byId.id)
    }
    if (targetId === null) {
      result.warnings.push('「' + selfTitle + '」的上级引用未找到（' + parentRef + '），已按顶层知识导入')
      continue
    }
    if (targetId === selfId) {
      result.warnings.push('「' + selfTitle + '」的上级引用指向自己，已忽略')
      continue
    }
    try {
      const parentId = resolveParentId(db, kb.id, selfId, targetId)
      if (parentId === null) continue
      run(db, 'UPDATE documents SET parent_id = ?, updated_at = ? WHERE id = ?', [parentId, Date.now(), selfId])
      result.parentLinked += 1
    } catch (error) {
      result.warnings.push('「' + selfTitle + '」的上级层级设置失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  if (result.created.length > 0) {
    recordReviewLog(db, {
      action: 'doc_import', itemKind: 'kb', itemId: kb.id, docId: null, kbId: kb.id, actor,
      note: '导入 Markdown：新建 ' + result.created.length + ' 篇草稿，跳过 ' + result.skipped.length + ' 篇，失败 ' + result.failed.length + ' 篇',
    })
  }
  return result
}
