/**
 * 备份与恢复 / 存储位置迁移（M5）。
 *
 * 设计要点：
 * - 备份是自包含 JSON（gzip）：知识库行 + 文档正文 + 来源 + 历史版本 + 标签，人工可读、可离线保存；
 * - 恢复采用 merge 语义，**绝不静默覆盖**现有知识：文档不存在→按备份重建（正文与历史版本一起恢复，来源重新登记）；
 *   已存在且正文不同→生成 update 候选走审核流（M3），由人决定是否采用；
 * - 任何恢复前先自动做一次恢复点备份（settings.autoBackup 控制），失败可回退；
 * - 迁移存储位置先复制、比对校验，通过后才切换 DSH_HOME 下的指针文件；旧数据原样保留，可随时回退。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { all, get, openDatabase, run, schemaVersion, type Db } from './db/db.js'
import { getKnowledgeBase, listAllKnowledgeBases, scopeKeyOf, type KbRow } from './kb/store.js'
import { createDocument } from './search.js'
import { createProposal, recordReviewLog } from './review.js'
import { readSettings } from './settings.js'
import { locationPointerFile, normalizeForCompare, readLocationPointer, storageLocation } from './paths.js'

export const BACKUP_FORMAT = 'knowhub-backup'
export const BACKUP_VERSION = 1

export class BackupError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

function newId(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function backupDir(storageRoot: string): string {
  return join(storageRoot, 'backups')
}

interface BackupSource { kind: string; ref: string; locator: string | null; verified: number }
interface BackupVersion { version: number; content: string; changeKind: string; source: string; actor: string | null; reason: string | null; contentHash: string; createdAt: number }
interface BackupDoc {
  kind: string; slug: string; title: string; body: string; status: string; verifyState: string
  confidence: number | null; tags: string[]; currentVersion: number; sourceSessionId: string | null
  createdAt: number; updatedAt: number; reviewedAt: number | null; reviewedBy: string | null
  sources: BackupSource[]; versions: BackupVersion[]
}
interface BackupKb {
  id: string; name: string; scope: string; workspaceId: string | null; modelProvider: string; modelId: string
  modelStrategy: string; status: string; createdAt: string; updatedAt: string; documents: BackupDoc[]
}
export interface BackupBundle {
  format: string; version: number; createdAt: number; schemaVersion: number; storageRoot: string
  note: string | null; kbs: BackupKb[]
}

function readDocBundle(db: Db, kbId: string, includeVersions: boolean): BackupDoc[] {
  const docs = all<any>(db, 'SELECT * FROM documents WHERE kb_id = ? AND deleted_at IS NULL ORDER BY kind, slug', [kbId])
  return docs.map((doc) => {
    let tags: string[] = []
    try { const parsed = JSON.parse(String(doc.tags ?? '[]')); if (Array.isArray(parsed)) tags = parsed.map(String) } catch { /* ignore */ }
    const sources = all<any>(db, 'SELECT kind, ref, locator, verified FROM sources WHERE doc_id = ? ORDER BY created_at', [doc.id])
      .map((row) => ({ kind: String(row.kind), ref: String(row.ref), locator: row.locator ?? null, verified: Number(row.verified) }))
    const versions = includeVersions
      ? all<any>(db, 'SELECT version, content, change_kind, source, actor, reason, content_hash, created_at FROM doc_versions WHERE doc_id = ? ORDER BY version', [doc.id])
        .map((row) => ({ version: Number(row.version), content: String(row.content), changeKind: String(row.change_kind), source: String(row.source), actor: row.actor ?? null, reason: row.reason ?? null, contentHash: String(row.content_hash), createdAt: Number(row.created_at) }))
      : []
    return {
      kind: String(doc.kind), slug: String(doc.slug), title: String(doc.title), body: String(doc.body),
      status: String(doc.status), verifyState: String(doc.verify_state),
      confidence: doc.confidence === null || doc.confidence === undefined ? null : Number(doc.confidence),
      tags, currentVersion: Number(doc.current_version), sourceSessionId: doc.source_session_id ?? null,
      createdAt: Number(doc.created_at), updatedAt: Number(doc.updated_at),
      reviewedAt: doc.reviewed_at ?? null, reviewedBy: doc.reviewed_by ?? null,
      sources, versions,
    }
  })
}

export function buildBundle(db: Db, storageRoot: string, options: { kbIds?: string[]; note?: string | null; includeVersions?: boolean } = {}): BackupBundle {
  const includeVersions = options.includeVersions !== false
  const wanted = Array.isArray(options.kbIds) && options.kbIds.length > 0 ? new Set(options.kbIds.map(String)) : null
  const kbs = listAllKnowledgeBases(db).filter((kb) => (wanted ? wanted.has(kb.id) : true))
  if (wanted) {
    const found = new Set(kbs.map((kb) => kb.id))
    const missing = [...wanted].filter((id) => !found.has(id))
    if (missing.length > 0) throw new BackupError('BACKUP_KB_NOT_FOUND', 404, '备份目标知识库不存在：' + missing.join(', '))
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    schemaVersion: schemaVersion(db),
    storageRoot,
    note: options.note ?? null,
    kbs: kbs.map((kb) => ({
      id: kb.id, name: kb.name, scope: kb.scope, workspaceId: kb.workspaceId ?? null,
      modelProvider: kb.modelProvider, modelId: kb.modelId, modelStrategy: kb.modelStrategy,
      status: kb.status, createdAt: kb.createdAt, updatedAt: kb.updatedAt,
      documents: readDocBundle(db, kb.id, includeVersions),
    })),
  }
}

function pruneBackups(db: Db, storageRoot: string, keep: number): number {
  const rows = all<any>(db, 'SELECT id, file FROM backups ORDER BY created_at DESC')
  let removed = 0
  for (const row of rows.slice(keep)) {
    try { const target = join(backupDir(storageRoot), String(row.file)); if (existsSync(target)) rmSync(target) } catch { /* ignore */ }
    run(db, 'DELETE FROM backups WHERE id = ?', [String(row.id)])
    removed += 1
  }
  return removed
}

export interface CreateBackupOptions { kbIds?: string[]; note?: string | null; actor?: string | null; includeVersions?: boolean }
export interface BackupResult { id: string; file: string; bytes: number; kbCount: number; docCount: number; createdAt: number; pruned: number; note: string | null }

export function createBackup(db: Db, storageRoot: string, options: CreateBackupOptions = {}): BackupResult {
  const bundle = buildBundle(db, storageRoot, options)
  const dir = backupDir(storageRoot)
  mkdirSync(dir, { recursive: true })
  const id = newId('bkp_')
  const fileName = id + '.json.gz'
  const file = join(dir, fileName)
  const buffer = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 })
  writeFileSync(file, buffer)
  const docCount = bundle.kbs.reduce((sum, kb) => sum + kb.documents.length, 0)
  const createdAt = Date.now()
  run(db, 'INSERT INTO backups(id, file, format_version, kb_count, doc_count, bytes, note, actor, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [id, fileName, BACKUP_VERSION, bundle.kbs.length, docCount, buffer.byteLength, options.note ?? null, options.actor ?? null, createdAt])
  recordReviewLog(db, { action: 'backup_create', itemKind: 'backup', itemId: id, actor: options.actor ?? null, note: '备份 ' + bundle.kbs.length + ' 个知识库 / ' + docCount + ' 条知识' })
  const keep = readSettings(db).backupKeep
  const pruned = pruneBackups(db, storageRoot, keep)
  return { id, file: join('backups', fileName), bytes: buffer.byteLength, kbCount: bundle.kbs.length, docCount, createdAt, pruned, note: options.note ?? null }
}

export function listBackups(db: Db, storageRoot: string): any[] {
  return all<any>(db, 'SELECT * FROM backups ORDER BY created_at DESC').map((row) => {
    const file = join(backupDir(storageRoot), String(row.file))
    return {
      id: String(row.id), file: join('backups', String(row.file)), kbCount: Number(row.kb_count), docCount: Number(row.doc_count),
      bytes: Number(row.bytes), note: row.note ?? null, actor: row.actor ?? null, createdAt: Number(row.created_at),
      exists: existsSync(file), path: file,
    }
  })
}

function loadBundle(db: Db, storageRoot: string, backupId: string): { bundle: BackupBundle; file: string; bytes: number } {
  const row = get<any>(db, 'SELECT * FROM backups WHERE id = ?', [backupId])
  if (!row) throw new BackupError('BACKUP_NOT_FOUND', 404, '备份不存在：' + backupId)
  const file = join(backupDir(storageRoot), String(row.file))
  if (!existsSync(file)) throw new BackupError('BACKUP_FILE_MISSING', 410, '备份文件已不存在（可能被移动或清理）：' + String(row.file))
  let parsed: any
  try {
    parsed = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'))
  } catch (error) {
    throw new BackupError('BACKUP_CORRUPTED', 422, '备份文件无法解析：' + (error instanceof Error ? error.message : String(error)))
  }
  if (!parsed || parsed.format !== BACKUP_FORMAT) throw new BackupError('BACKUP_FORMAT_INVALID', 422, '不是知枢 KnowHub 备份文件（format 必须为 ' + BACKUP_FORMAT + '）')
  if (Number(parsed.version) > BACKUP_VERSION) throw new BackupError('BACKUP_VERSION_UNSUPPORTED', 422, '备份格式版本高于当前插件支持的版本：' + String(parsed.version))
  return { bundle: parsed as BackupBundle, file, bytes: statSync(file).size }
}

/**
 * 备份恢复预览：只读解析备份文件，不改动任何数据。
 * 用于回答「恢复之前我到底会得到什么」——每个知识库有多少篇知识、多少历史版本、
 * 状态分布如何，以及哪些知识标题当前库里已经存在（恢复是合并式，不会删除现有知识）。
 */
export function previewBackup(db: Db, storageRoot: string, backupId: string): any {
  const { bundle, bytes } = loadBundle(db, storageRoot, backupId)
  const currentKbIds = new Set(listAllKnowledgeBases(db).map((kb) => kb.id))
  const kbs = bundle.kbs.map((kb) => {
    const statusBreakdown: Record<string, number> = { approved: 0, draft: 0, stale: 0, archived: 0 }
    const kindBreakdown: Record<string, number> = {}
    let versionCount = 0
    for (const doc of kb.documents) {
      statusBreakdown[doc.status] = (statusBreakdown[doc.status] ?? 0) + 1
      kindBreakdown[doc.kind] = (kindBreakdown[doc.kind] ?? 0) + 1
      versionCount += doc.versions.length
    }
    const existingTitles = new Set(all<any>(db, 'SELECT title FROM documents WHERE kb_id = ? AND deleted_at IS NULL', [kb.id]).map((row) => String(row.title)))
    const overlap = kb.documents.filter((doc) => existingTitles.has(doc.title)).map((doc) => doc.title)
    return {
      id: kb.id,
      name: kb.name,
      scope: kb.scope,
      workspaceId: kb.workspaceId,
      modelProvider: kb.modelProvider,
      modelId: kb.modelId,
      modelStrategy: kb.modelStrategy,
      status: kb.status,
      exists: currentKbIds.has(kb.id),
      documentCount: kb.documents.length,
      versionCount,
      statusBreakdown,
      kindBreakdown,
      sampleTitles: kb.documents.slice(0, 5).map((doc) => doc.title),
      overlapTitles: overlap.slice(0, 20),
      overlapCount: overlap.length,
    }
  })
  return {
    backupId,
    file: join('backups', String(get<any>(db, 'SELECT file FROM backups WHERE id = ?', [backupId])?.file ?? '')),
    bytes,
    format: bundle.format,
    formatVersion: bundle.version,
    schemaVersion: bundle.schemaVersion,
    createdAt: bundle.createdAt,
    note: bundle.note,
    storageRoot: bundle.storageRoot,
    kbCount: kbs.length,
    docCount: kbs.reduce((total, kb) => total + kb.documentCount, 0),
    versionCount: kbs.reduce((total, kb) => total + kb.versionCount, 0),
    kbs,
    restoreIsMerge: true,
    note2: '恢复是合并且只读式重建：备份里有、当前库里没有的知识会按历史版本重建；当前库里已有的知识不会被删除或覆盖。',
  }
}

export interface RestoreOptions { actor?: string | null; note?: string | null }
export interface RestoreResult {
  backupId: string
  preBackupId: string | null
  createdKbs: string[]
  createdDocs: number
  proposals: number
  skipped: number
  notes: string[]
}

/** 合并式恢复：重建缺失知识库与文档；已存在且内容不同的文档只生成 update 候选，不覆盖。 */
export async function restoreBackup(db: Db, storageRoot: string, backupId: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const { bundle } = loadBundle(db, storageRoot, backupId)
  const settings = readSettings(db)
  const preBackupId = settings.autoBackup
    ? createBackup(db, storageRoot, { note: '恢复备份 ' + backupId + ' 前的自动恢复点', actor: options.actor ?? null }).id
    : null
  const result: RestoreResult = { backupId, preBackupId, createdKbs: [], createdDocs: 0, proposals: 0, skipped: 0, notes: [] }
  for (const kbBundle of bundle.kbs) {
    if (kbBundle.scope === 'workspace' && !kbBundle.workspaceId) {
      result.notes.push('跳过知识库 ' + kbBundle.name + '：工作区级备份缺少 workspaceId，无法安全恢复')
      continue
    }
    const rawKb = get<any>(db, 'SELECT * FROM knowledge_bases WHERE id = ?', [kbBundle.id])
    if (rawKb && rawKb.deleted_at !== null && rawKb.deleted_at !== undefined) {
      run(db, 'UPDATE knowledge_bases SET deleted_at = NULL, status = ?, status_detail = ?, model_provider = ?, model_id = ?, model_strategy = ?, updated_at = ? WHERE id = ?', [
        'created', '从备份恢复（原记录曾被删除）', String(kbBundle.modelProvider ?? ''), String(kbBundle.modelId ?? ''), String(kbBundle.modelStrategy ?? 'balanced'), Date.now(), kbBundle.id,
      ])
      result.notes.push('知识库 ' + kbBundle.name + ' 之前已被删除，已按备份恢复为可用状态')
      result.createdKbs.push(kbBundle.id)
    }
    let kb: KbRow | null = getKnowledgeBase(db, kbBundle.id)
    if (!kb) {
      let name = kbBundle.name
      const timestamp = Date.now()
      const scopeKey = scopeKeyOf(kbBundle.scope, kbBundle.workspaceId ?? null)
      for (let index = 2; ; index += 1) {
        const taken = get(db, 'SELECT id FROM knowledge_bases WHERE scope_key = ? AND name = ? AND deleted_at IS NULL', [scopeKey, name])
        if (!taken) break
        name = kbBundle.name + '（恢复 ' + index + '）'
      }
      run(db, 'INSERT INTO knowledge_bases (id, name, scope, scope_key, workspace_id, model_provider, model_id, model_strategy, status, status_detail, created_at, updated_at, schema_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        kbBundle.id, name, kbBundle.scope, scopeKey, kbBundle.workspaceId ?? null,
        String(kbBundle.modelProvider ?? ''), String(kbBundle.modelId ?? ''), String(kbBundle.modelStrategy ?? 'balanced'),
        'created', '从备份恢复', timestamp, timestamp, schemaVersion(db),
      ])
      kb = getKnowledgeBase(db, kbBundle.id)
      if (!kb) throw new BackupError('BACKUP_RESTORE_FAILED', 500, '重建知识库失败：' + kbBundle.name)
      result.createdKbs.push(kb.id)
    }
    for (const docBundle of kbBundle.documents) {
      const existing = get<any>(db, 'SELECT * FROM documents WHERE kb_id = ? AND slug = ? AND deleted_at IS NULL', [kb.id, docBundle.slug])
      if (!existing) {
        const status = ['draft', 'approved', 'stale'].includes(docBundle.status) ? docBundle.status : 'draft'
        const created = await createDocument(db, storageRoot, kb, {
          title: docBundle.title, kind: docBundle.kind, body: docBundle.body, tags: docBundle.tags,
          status, verifyState: docBundle.verifyState, confidence: docBundle.confidence ?? undefined,
          sourceSessionId: docBundle.sourceSessionId ?? undefined,
        })
        for (const version of docBundle.versions) {
          if (version.version <= 1) continue
          run(db, 'INSERT OR IGNORE INTO doc_versions (doc_id, version, content, content_hash, change_kind, source, actor, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
            created.id, version.version, version.content, version.contentHash, version.changeKind, version.source,
            version.actor ?? null, version.reason ?? null, version.createdAt,
          ])
        }
        const maxVersion = docBundle.versions.reduce((max, item) => Math.max(max, item.version), 1)
        if (maxVersion > 1) run(db, 'UPDATE documents SET current_version = ? WHERE id = ?', [maxVersion, created.id])
        for (const source of docBundle.sources) {
          run(db, 'INSERT INTO sources (id, doc_id, candidate_id, kind, ref, locator, excerpt_hash, verified, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
            newId('src'), created.id, null, ['file', 'session', 'task', 'url', 'commit'].includes(source.kind) ? source.kind : 'file',
            source.ref, source.locator ?? null, null, Number(source.verified) ? 1 : 0, Date.now(),
          ])
        }
        recordReviewLog(db, { action: 'backup_restore_doc', itemKind: 'document', itemId: created.id, docId: created.id, kbId: kb.id, actor: options.actor ?? null, note: '从备份 ' + backupId + ' 重建知识（含 ' + maxVersion + ' 个历史版本）' })
        result.createdDocs += 1
        continue
      }
      if (String(existing.body) === docBundle.body) {
        result.skipped += 1
        continue
      }
      createProposal(db, kb, {
        kind: 'update', docId: String(existing.id),
        title: docBundle.title, body: docBundle.body, docKind: docBundle.kind, tags: docBundle.tags,
        verifyState: docBundle.verifyState, source: 'backup:' + backupId, createdBy: options.actor ?? 'backup',
        reason: '备份恢复：该知识在当前库中已存在且内容不同，需人工确认是否采用备份版本',
        sources: docBundle.sources.map((source) => ({ kind: source.kind, ref: source.ref, locator: source.locator ?? undefined })),
      })
      result.proposals += 1
    }
    recordReviewLog(db, { action: 'backup_restore', itemKind: 'knowledge-base', itemId: kb.id, kbId: kb.id, actor: options.actor ?? null, note: options.note ?? ('从备份 ' + backupId + ' 合并恢复') })
  }
  return result
}

interface CopyStats { files: number; bytes: number }
function copyTree(source: string, target: string, stats: CopyStats, depth = 0): void {
  if (depth > 12) return
  if (!existsSync(source)) return
  const info = lstatSync(source)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source)) {
      if (entry === '-wal' || entry === '-shm') continue
      copyTree(join(source, entry), join(target, entry), stats, depth + 1)
    }
    return
  }
  if (!info.isFile()) return
  mkdirSync(join(target, '..'), { recursive: true })
  copyFileSync(source, target)
  stats.files += 1
  stats.bytes += info.size
}

export async function migrateStorage(db: Db, config: any, options: { target: unknown; dryRun?: boolean; actor?: string | null }): Promise<any> {
  const targetRaw = typeof options.target === 'string' ? options.target.trim() : ''
  if (targetRaw === '') throw new BackupError('STORAGE_TARGET_INVALID', 400, '目标存储目录不能为空')
  if (!isAbsolute(targetRaw)) throw new BackupError('STORAGE_TARGET_INVALID', 400, '目标存储目录必须是绝对路径：' + targetRaw)
  const target = normalize(resolve(targetRaw))
  const current = storageLocation(config)
  if (normalizeForCompare(target) === normalizeForCompare(current.storageRoot)) {
    throw new BackupError('STORAGE_TARGET_INVALID', 400, '目标目录与当前存储目录相同，无需迁移')
  }
  const currentNorm = normalizeForCompare(current.storageRoot)
  const targetNorm = normalizeForCompare(target)
  if (targetNorm.startsWith(currentNorm + '/') || currentNorm.startsWith(targetNorm + '/')) {
    throw new BackupError('STORAGE_TARGET_INVALID', 400, '目标目录不能位于当前存储目录内部（或反之），请选择独立目录')
  }
  const dryRun = options.dryRun === true
  try {
    mkdirSync(target, { recursive: true })
    const probeFile = join(target, '.knowhub-write-probe')
    writeFileSync(probeFile, 'ok')
    rmSync(probeFile, { force: true })
  } catch (error) {
    throw new BackupError('STORAGE_NOT_WRITABLE', 409, '目标目录不可写：' + (error instanceof Error ? error.message : String(error)))
  }
  const stats: CopyStats = { files: 0, bytes: 0 }
  if (dryRun) {
    const measure = { files: 0, bytes: 0 }
    walkMeasure(current.storageRoot, measure)
    return {
      dryRun: true,
      from: current.storageRoot,
      to: target,
      willCopy: measure,
      pointerFile: locationPointerFile(),
      note: '仅预览，不写任何文件；正式迁移会先自动备份、核对知识库与知识条数后才切换指针，旧数据保留',
    }
  }
  createBackup(db, current.storageRoot, { note: '迁移存储位置到 ' + target + ' 前的自动备份', actor: options.actor ?? null })
  try { db.raw.exec('PRAGMA wal_checkpoint(FULL)') } catch { /* ignore */ }
  mkdirSync(join(target, 'database'), { recursive: true })
  copyFileSync(join(current.storageRoot, 'database', 'knowledge.db'), join(target, 'database', 'knowledge.db'))
  copyTree(join(current.storageRoot, 'knowledge-bases'), join(target, 'knowledge-bases'), stats)
  const targetDb = openDatabase(target)
  const sourceKbs = Number(get<any>(db, 'SELECT COUNT(*) AS n FROM knowledge_bases WHERE deleted_at IS NULL')?.n ?? 0)
  const sourceDocs = Number(get<any>(db, 'SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL')?.n ?? 0)
  const targetKbs = Number(get<any>(targetDb, 'SELECT COUNT(*) AS n FROM knowledge_bases WHERE deleted_at IS NULL')?.n ?? 0)
  const targetDocs = Number(get<any>(targetDb, 'SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL')?.n ?? 0)
  if (sourceKbs !== targetKbs || sourceDocs !== targetDocs) {
    throw new BackupError('STORAGE_MIGRATE_VERIFY_FAILED', 409, '迁移校验失败：知识库 ' + sourceKbs + '→' + targetKbs + '、知识 ' + sourceDocs + '→' + targetDocs + '；指针未切换，原数据未改动')
  }
  const previous = readLocationPointer()
  writeFileSync(locationPointerFile(), JSON.stringify({ storageRoot: target, previous, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  recordReviewLog(db, { action: 'storage_migrate', itemKind: 'settings', itemId: 'knowhub', actor: options.actor ?? null, note: '存储位置 ' + current.storageRoot + ' → ' + target })
  return {
    dryRun: false,
    from: current.storageRoot,
    to: target,
    copied: stats,
    verified: { knowledgeBases: targetKbs, documents: targetDocs },
    pointerFile: locationPointerFile(),
    restartRequired: true,
    rollback: '删除 ' + locationPointerFile() + ' 或把其中的 storageRoot 改回 ' + current.storageRoot + '，重启实例即可回退；原目录数据未删除',
  }
}

function walkMeasure(root: string, stats: CopyStats, depth = 0): void {
  if (depth > 12 || !existsSync(root)) return
  const info = lstatSync(root)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    for (const entry of readdirSync(root)) {
      if (entry === '-wal' || entry === '-shm') continue
      walkMeasure(join(root, entry), stats, depth + 1)
    }
    return
  }
  stats.files += 1
  stats.bytes += info.size
}

export function backupStats(db: Db, storageRoot: string): any {
  const rows = listBackups(db, storageRoot)
  return {
    count: rows.length,
    latest: rows[0] ?? null,
    totalBytes: rows.reduce((sum, row) => sum + Number(row.bytes ?? 0), 0),
    dir: backupDir(storageRoot),
    keep: readSettings(db).backupKeep,
  }
}
