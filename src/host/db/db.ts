/**
 * SQLite 访问层（宿主运行时内建 node:sqlite，同步 API）。
 *
 * 设计要点：
 * - 每个 storageRoot 只打开一次（进程内缓存），WAL + busy_timeout 降低并发写冲突；
 * - 迁移幂等，版本记录在 settings.schema_version；
 * - 所有写操作走 transaction()（BEGIN IMMEDIATE），失败统一 rollback。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations.js'

export interface Db {
  raw: DatabaseSync
  path: string
}

const cache = new Map<string, Db>()

export function databaseFile(storageRoot: string): string {
  return join(storageRoot, 'database', 'knowledge.db')
}

export function openDatabase(storageRoot: string): Db {
  const path = databaseFile(storageRoot)
  const cached = cache.get(path)
  if (cached) return cached
  mkdirSync(join(storageRoot, 'database'), { recursive: true })
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA busy_timeout = 5000')
  migrate(raw)
  const handle: Db = { raw, path }
  cache.set(path, handle)
  return handle
}

/** 仅测试用：关闭并移出缓存。 */
export function closeDatabase(storageRoot: string): void {
  const path = databaseFile(storageRoot)
  const cached = cache.get(path)
  if (!cached) return
  try { cached.raw.close() } catch { /* ignore */ }
  cache.delete(path)
}

function readSchemaVersion(raw: DatabaseSync): number {
  try {
    const row = raw.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as { value?: string } | undefined
    const n = Number(row?.value ?? 0)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function migrate(raw: DatabaseSync): void {
  const current = readSchemaVersion(raw)
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    raw.exec('BEGIN IMMEDIATE')
    try {
      raw.exec(migration.sql)
      raw.prepare(
        "INSERT INTO settings(key, value, updated_at) VALUES('schema_version', ?, ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(String(migration.version), Date.now())
      raw.exec('COMMIT')
    } catch (error) {
      try { raw.exec('ROLLBACK') } catch { /* ignore */ }
      throw new Error('数据库迁移失败（' + migration.name + '）：' + (error instanceof Error ? error.message : String(error)))
    }
  }
}

export function schemaVersion(db: Db): number {
  return readSchemaVersion(db.raw)
}

export function latestSchemaVersion(): number {
  return LATEST_SCHEMA_VERSION
}

export type SqlParams = (string | number | null)[]

export function all<T = any>(db: Db, sql: string, params: SqlParams = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[]
}

export function get<T = any>(db: Db, sql: string, params: SqlParams = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined
}

export function run(db: Db, sql: string, params: SqlParams = []): void {
  db.raw.prepare(sql).run(...params)
}

/** 在 BEGIN IMMEDIATE 事务中执行，异常时回滚并原样抛出。 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.raw.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.raw.exec('COMMIT')
    return result
  } catch (error) {
    try { db.raw.exec('ROLLBACK') } catch { /* ignore */ }
    throw error
  }
}
