/** 存储探针：验证 DSH 全局数据目录可写，并检测 SQLite FTS5 / trigram 能力。 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { dshHome, resolveStorageRoot } from './paths.js'
import { errorMessage } from './http.js'

export interface StorageProbeResult {
  dshHome: string
  storageRoot: string
  logFile: string
  writable: boolean
  bytes: number
  error: string | null
}

export async function storageProbe(config: any, payload: unknown): Promise<StorageProbeResult> {
  const root = resolveStorageRoot(config)
  const dir = join(root, 'logs')
  const file = join(dir, 'm0-storage-probe.jsonl')
  const base = { dshHome: dshHome(), storageRoot: root, logFile: file, writable: false, bytes: 0, error: null as string | null }
  try {
    await fs.mkdir(dir, { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, payload }) + '\n'
    await fs.appendFile(file, line, 'utf8')
    const stat = await fs.stat(file)
    return { ...base, writable: true, bytes: stat.size }
  } catch (error) {
    return { ...base, error: errorMessage(error) }
  }
}

export interface SqliteProbeResult {
  available: boolean
  version: string | null
  fts5: boolean
  trigram: boolean
  unicode61: boolean
  sample: { trigramMatch3: number | null; trigramMatch2: number | null; likeMatch2: number | null }
  error: string | null
}

export async function probeSqlite(): Promise<SqliteProbeResult> {
  const result: SqliteProbeResult = {
    available: false, version: null, fts5: false, trigram: false, unicode61: false,
    sample: { trigramMatch3: null, trigramMatch2: null, likeMatch2: null }, error: null,
  }
  try {
    const spec = 'node:sqlite'
    const mod: any = await import(spec)
    const DatabaseSync = mod?.DatabaseSync
    if (typeof DatabaseSync !== 'function') {
      result.error = 'node:sqlite 未导出 DatabaseSync'
      return result
    }
    const db = new DatabaseSync(':memory:')
    try {
      result.available = true
      const row = db.prepare('select sqlite_version() as v').get() as any
      result.version = row?.v ?? null
      const tryExec = (sql: string): boolean => {
        try { db.exec(sql); return true } catch { return false }
      }
      result.fts5 = tryExec("create virtual table probe_fts using fts5(body);")
      result.trigram = tryExec("create virtual table probe_tri using fts5(body, tokenize='trigram');")
      result.unicode61 = tryExec("create virtual table probe_uni using fts5(body, tokenize='unicode61');")
      const count = (sql: string): number | null => {
        try { const r = db.prepare(sql).get() as any; return typeof r?.n === 'number' ? r.n : null } catch { return null }
      }
      if (result.trigram) {
        db.exec("insert into probe_tri(body) values ('知枢 KnowHub 知识库 检索 FTS5 trigram 测试');")
        result.sample.trigramMatch3 = count("select count(*) as n from probe_tri where probe_tri match '知识库'")
        result.sample.trigramMatch2 = count("select count(*) as n from probe_tri where probe_tri match '知识'")
        result.sample.likeMatch2 = count("select count(*) as n from probe_tri where body like '%知识%'")
      }
    } finally {
      try { db.close() } catch { /* 关闭失败不影响结论 */ }
    }
  } catch (error) {
    result.error = errorMessage(error)
  }
  return result
}
