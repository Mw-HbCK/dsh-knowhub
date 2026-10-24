/**
 * 变更检测与会影响面分析（M4）。
 *
 * 三种输入：
 * 1. Git 模式：git diff（提交）+ git status（未提交/未跟踪）→ 变更文件列表；
 * 2. 哈希模式（Git 不可用或不是仓库）：用 project_files 里上次扫描的 content_hash 与本次扫描比对；
 * 3. 结构性变更（package.json / tsconfig / 构建配置 / CI …）额外把 Wiki 类文档标记为“需要重新检查”，
 *    但不自动重写——对应规范 §5.3「涉及架构变更时标记相关文档需要重新检查」。
 */
import { all, get, run, type Db } from '../db/db.js'
import type { IndexedFile } from './index.js'
import { newId } from '../utils/id.js'

export interface FileChange {
  path: string
  change: 'added' | 'modified' | 'deleted'
}

export interface AffectedDoc {
  docId: string
  title: string
  status: string
  kind: string
  currentVersion: number
  matchedPaths: string[]
  matchedBy: 'source' | 'directory'
}

export interface ImpactAnalysis {
  affected: AffectedDoc[]
  unmatchedPaths: string[]
  structural: string[]
}

const STRUCTURAL_PATTERNS: RegExp[] = [
  /^package\.json$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.ya?ml$/i,
  /^yarn\.lock$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^Dockerfile$/i,
  /^docker-compose.*\.ya?ml$/i,
  /^\.github\/workflows\//i,
  /^\.gitlab-ci\.yml$/i,
  /^(vite|webpack|rollup|esbuild|tsup|next|nuxt|vitest|jest|playwright|tailwind|postcss|babel)\.config\.[cm]?[jt]s$/i,
  /^src\/index\.[cm]?[jt]sx?$/i,
  /^src\/main\.[cm]?[jt]sx?$/i,
]

/** 是否是「结构性」文件：这类变化会影响架构级文档，需要标记重新检查。 */
export function isStructuralChange(path: string): boolean {
  return STRUCTURAL_PATTERNS.some((pattern) => pattern.test(path))
}

function toPosix(value: string): string {
  return value.split('\\').join('/')
}

/** 哈希模式：把本次扫描结果与上次入库的 project_files 比对。 */
export function diffProjectIndex(db: Db, kbId: string, files: IndexedFile[]): FileChange[] {
  const previous = new Map<string, { hash: string | null; size: number }>()
  for (const row of all<{ path: string; content_hash: string | null; size: number }>(db, 'SELECT path, content_hash, size FROM project_files WHERE kb_id = ?', [kbId])) {
    previous.set(String(row.path), { hash: row.content_hash === null ? null : String(row.content_hash), size: Number(row.size) })
  }
  const current = new Map<string, { hash: string | null; size: number }>()
  for (const file of files) {
    current.set(toPosix(file.path), { hash: file.hash, size: file.size })
  }
  const changes: FileChange[] = []
  for (const [path, entry] of current) {
    const before = previous.get(path)
    if (!before) { changes.push({ path, change: 'added' }); continue }
    const hashChanged = before.hash !== null && entry.hash !== null && before.hash !== entry.hash
    const sizeChanged = (before.hash === null || entry.hash === null) && before.size !== entry.size
    if (hashChanged || sizeChanged) changes.push({ path, change: 'modified' })
  }
  for (const path of previous.keys()) {
    if (!current.has(path)) changes.push({ path, change: 'deleted' })
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

/** 用文档的来源文件（sources.kind='file'）反查受影响的文档。 */
export function mapAffectedDocs(db: Db, kbId: string, changes: FileChange[]): ImpactAnalysis {
  const rows = all(db, "SELECT s.ref AS ref, d.id AS doc_id, d.title AS title, d.status AS status, d.kind AS kind, d.current_version AS current_version FROM sources s JOIN documents d ON d.id = s.doc_id WHERE d.kb_id = ? AND d.deleted_at IS NULL AND s.kind = 'file'", [kbId])
  const index = rows.map((row: any) => ({
    docId: String(row.doc_id),
    title: String(row.title),
    status: String(row.status),
    kind: String(row.kind),
    currentVersion: Number(row.current_version),
    ref: toPosix(String(row.ref)).replace(/^\.\//, '').replace(/\/+$/, ''),
  }))
  const affected = new Map<string, AffectedDoc>()
  const unmatched: string[] = []
  for (const change of changes) {
    const path = toPosix(change.path)
    let matched = false
    for (const entry of index) {
      const ref = entry.ref
      if (ref === '') continue
      if (path === ref) {
        matched = true
        mergeAffected(affected, entry, path, 'source')
        continue
      }
      if (path.startsWith(ref + '/')) {
        matched = true
        mergeAffected(affected, entry, path, 'directory')
      }
    }
    if (!matched) unmatched.push(path)
  }
  const structural = changes.map((change) => toPosix(change.path)).filter(isStructuralChange)
  return { affected: [...affected.values()].sort((a, b) => a.title.localeCompare(b.title)), unmatchedPaths: unmatched.sort(), structural }
}

function mergeAffected(target: Map<string, AffectedDoc>, entry: { docId: string; title: string; status: string; kind: string; currentVersion: number }, path: string, matchedBy: 'source' | 'directory'): void {
  const existing = target.get(entry.docId)
  if (!existing) {
    target.set(entry.docId, {
      docId: entry.docId,
      title: entry.title,
      status: entry.status,
      kind: entry.kind,
      currentVersion: entry.currentVersion,
      matchedPaths: [path],
      matchedBy,
    })
    return
  }
  if (!existing.matchedPaths.includes(path)) existing.matchedPaths.push(path)
  if (matchedBy === 'source') existing.matchedBy = 'source'
}

export interface GitStateRow {
  kbId: string
  workspaceId: string | null
  root: string
  mode: 'git' | 'hash'
  head: string | null
  branch: string | null
  fileCount: number
  dirtyCount: number
  lastScanAt: number
  lastTaskId: string | null
  lastSummary: any
  updatedAt: number
}

export function readGitStateRow(db: Db, kbId: string): GitStateRow | null {
  const raw: any = get(db, 'SELECT * FROM kb_git_state WHERE kb_id = ?', [kbId])
  if (!raw) return null
  let summary: any = null
  try { summary = raw.last_summary === null ? null : JSON.parse(String(raw.last_summary)) } catch { summary = null }
  return {
    kbId: String(raw.kb_id),
    workspaceId: raw.workspace_id === null ? null : String(raw.workspace_id),
    root: String(raw.root),
    mode: String(raw.mode) === 'git' ? 'git' : 'hash',
    head: raw.head === null ? null : String(raw.head),
    branch: raw.branch === null ? null : String(raw.branch),
    fileCount: Number(raw.file_count),
    dirtyCount: Number(raw.dirty_count),
    lastScanAt: Number(raw.last_scan_at),
    lastTaskId: raw.last_task_id === null ? null : String(raw.last_task_id),
    lastSummary: summary,
    updatedAt: Number(raw.updated_at),
  }
}

export function saveGitState(db: Db, row: GitStateRow): void {
  run(
    db,
    'INSERT INTO kb_git_state (kb_id, workspace_id, root, mode, head, branch, file_count, dirty_count, last_scan_at, last_task_id, last_summary, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kb_id) DO UPDATE SET workspace_id = excluded.workspace_id, root = excluded.root, mode = excluded.mode, head = excluded.head, branch = excluded.branch, file_count = excluded.file_count, dirty_count = excluded.dirty_count, last_scan_at = excluded.last_scan_at, last_task_id = excluded.last_task_id, last_summary = excluded.last_summary, updated_at = excluded.updated_at',
    [row.kbId, row.workspaceId, row.root, row.mode, row.head, row.branch, row.fileCount, row.dirtyCount, row.lastScanAt, row.lastTaskId, row.lastSummary === null ? null : JSON.stringify(row.lastSummary).slice(0, 4000), row.updatedAt],
  )
}

export function recordFileChanges(db: Db, kbId: string, taskId: string | null, mode: string, changes: FileChange[]): void {
  const now = Date.now()
  for (const change of changes) {
    run(db, 'INSERT INTO file_changes (kb_id, task_id, path, change, mode, detected_at) VALUES (?, ?, ?, ?, ?, ?)', [kbId, taskId, change.path, change.change, mode, now])
  }
}

export function listFileChanges(db: Db, kbId: string, limit = 200): Array<{ path: string; change: string; mode: string; taskId: string | null; detectedAt: number }> {
  const bounded = Math.max(1, Math.min(1000, limit))
  return all(db, 'SELECT path, change, mode, task_id, detected_at FROM file_changes WHERE kb_id = ? ORDER BY detected_at DESC, id DESC LIMIT ?', [kbId, bounded]).map((raw: any) => ({
    path: String(raw.path),
    change: String(raw.change),
    mode: String(raw.mode),
    taskId: raw.task_id === null ? null : String(raw.task_id),
    detectedAt: Number(raw.detected_at),
  }))
}

export function flagRecheck(db: Db, kbId: string, docIds: string[], reason: string, taskId: string | null): number {
  let flagged = 0
  const now = Date.now()
  for (const docId of docIds) {
    run(db, 'INSERT INTO doc_recheck (kb_id, doc_id, reason, task_id, flagged_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(kb_id, doc_id) DO UPDATE SET reason = excluded.reason, task_id = excluded.task_id, flagged_at = excluded.flagged_at', [kbId, docId, reason.slice(0, 500), taskId, now])
    flagged += 1
  }
  return flagged
}

export function clearRecheck(db: Db, kbId: string, docId: string): void {
  run(db, 'DELETE FROM doc_recheck WHERE kb_id = ? AND doc_id = ?', [kbId, docId])
}

export function listRecheck(db: Db, kbId: string, limit = 200): Array<{ docId: string; title: string | null; reason: string; taskId: string | null; flaggedAt: number }> {
  const bounded = Math.max(1, Math.min(500, limit))
  return all(db, 'SELECT r.doc_id, r.reason, r.task_id, r.flagged_at, d.title FROM doc_recheck r LEFT JOIN documents d ON d.id = r.doc_id WHERE r.kb_id = ? ORDER BY r.flagged_at DESC LIMIT ?', [kbId, bounded]).map((raw: any) => ({
    docId: String(raw.doc_id),
    title: raw.title === null ? null : String(raw.title),
    reason: String(raw.reason),
    taskId: raw.task_id === null ? null : String(raw.task_id),
    flaggedAt: Number(raw.flagged_at),
  }))
}

/** 为文档追加新的来源文件（去重）。 */
export function ensureDocSources(db: Db, docId: string, kind: string, refs: string[], verified = 1): number {
  let added = 0
  const existing = new Set(all<{ ref: string }>(db, 'SELECT ref FROM sources WHERE doc_id = ? AND kind = ?', [docId, kind]).map((row) => String(row.ref)))
  const now = Date.now()
  for (const ref of refs) {
    const normalized = toPosix(ref)
    if (normalized === '' || existing.has(normalized)) continue
    run(db, 'INSERT INTO sources (id, doc_id, candidate_id, kind, ref, locator, excerpt_hash, verified, created_at) VALUES (?, ?, NULL, ?, ?, NULL, NULL, ?, ?)', [newId('src'), docId, kind, normalized, verified, now])
    existing.add(normalized)
    added += 1
  }
  return added
}
