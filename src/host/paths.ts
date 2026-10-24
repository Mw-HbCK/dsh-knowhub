/** DSH 全局数据目录解析：优先 DSH_HOME 环境变量，其次 ~/.dsh（与官方 dsh-home-paths 行为一致）。 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 存储位置指针对照文件（放在 DSH_HOME 根下，而不是知识中心内部，避免自指）。
 * 用户在「设置与诊断」里迁移存储位置后写入该文件；迁移只切指针，旧数据保留可回退。
 */
export function locationPointerFile(): string {
  return join(dshHome(), 'knowhub-location.json')
}

export function readLocationPointer(): string | null {
  try {
    const file = locationPointerFile()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { storageRoot?: unknown }
    const value = typeof parsed?.storageRoot === 'string' ? parsed.storageRoot.trim() : ''
    return value === '' ? null : value
  } catch {
    return null
  }
}

export interface StorageLocationInfo {
  storageRoot: string
  source: 'config' | 'pointer' | 'default'
  configStorageRoot: string | null
  pointerFile: string
  pointerStorageRoot: string | null
}

export function storageLocation(config: any): StorageLocationInfo {
  const configured = typeof config?.storageRoot === 'string' ? config.storageRoot.trim() : ''
  const pointer = readLocationPointer()
  if (configured !== '') {
    return { storageRoot: configured, source: 'config', configStorageRoot: configured, pointerFile: locationPointerFile(), pointerStorageRoot: pointer }
  }
  if (pointer) {
    return { storageRoot: pointer, source: 'pointer', configStorageRoot: null, pointerFile: locationPointerFile(), pointerStorageRoot: pointer }
  }
  return { storageRoot: join(dshHome(), 'knowledge-center'), source: 'default', configStorageRoot: null, pointerFile: locationPointerFile(), pointerStorageRoot: null }
}

/** 知识中心数据根目录：配置 storageRoot > 迁移指针 > 默认 <DSH_HOME>/knowledge-center。 */
export function resolveStorageRoot(config: any): string {
  return storageLocation(config).storageRoot
}

export function normalizeForCompare(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
