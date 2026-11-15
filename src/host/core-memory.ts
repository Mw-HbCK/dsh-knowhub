/**
 * 核心记忆层（Core Memory）口径 —— Memory 双层设计的派生视图，零数据库迁移。
 *
 * 双层划分（任务书 §5）：
 * - Archive 历史归档层 = 现有全部文档（含 stale/archived）+ doc_versions 版本历史
 *   + sources 来源 + distill_runs 提炼记录，已经持久化，本次不新建存储；
 *   注意系统不保存原始对话，归档层不包含对话原文，不得在文案中虚构这一能力。
 * - Core 核心记忆层 = 本模块定义的派生口径：已批准、验证状态不为 unverified、
 *   未过时的 memory / preference 文档。注入、面板筛选、提炼都按同一口径取数。
 */
import { all, type Db } from './db/db.js'

export const CORE_MEMORY_KINDS = ['memory', 'preference'] as const

export function isCoreMemory(doc: { kind: string; status: string; verifyState: string }): boolean {
  return (CORE_MEMORY_KINDS as readonly string[]).includes(doc.kind)
    && doc.status === 'approved'
    && doc.verifyState !== 'unverified'
}

export interface CoreMemoryRow {
  id: string
  kbId: string
  kind: string
  title: string
  body: string
  verifyState: string
  updatedAt: number
}

export function listCoreMemory(db: Db, kbIds: string[], limit = 50): CoreMemoryRow[] {
  if (kbIds.length === 0) return []
  const placeholders = kbIds.map(() => '?').join(',')
  return all<any>(db, "SELECT id, kb_id, kind, title, body, verify_state, updated_at FROM documents WHERE deleted_at IS NULL AND status = 'approved' AND verify_state != 'unverified' AND kind IN ('memory', 'preference') AND kb_id IN (" + placeholders + ') ORDER BY updated_at DESC LIMIT ?', [...kbIds, Math.max(1, limit)])
    .map((row: any) => ({
      id: String(row.id),
      kbId: String(row.kb_id),
      kind: String(row.kind),
      title: String(row.title),
      body: String(row.body ?? ''),
      verifyState: String(row.verify_state),
      updatedAt: Number(row.updated_at ?? 0),
    }))
}

/** 存在未决冲突的文档集合（注入与面板标注用）。 */
export function docsWithPendingConflicts(db: Db, kbIds: string[]): Set<string> {
  if (kbIds.length === 0) return new Set()
  const placeholders = kbIds.map(() => '?').join(',')
  return new Set(all<any>(db, "SELECT DISTINCT doc_id FROM conflicts WHERE status = 'pending' AND doc_id IS NOT NULL AND kb_id IN (" + placeholders + ')', kbIds).map((row: any) => String(row.doc_id)))
}
