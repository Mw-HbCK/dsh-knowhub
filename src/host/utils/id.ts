/** 稳定唯一 ID：前缀 + 时间戳 + 随机段（可排序、无外部依赖）。 */
import { randomUUID } from 'node:crypto'

export function newId(prefix: string): string {
  const time = Date.now().toString(36)
  const random = randomUUID().replace(/-/g, '').slice(0, 10)
  return prefix + '_' + time + random
}

export function nowIso(): string {
  return new Date().toISOString()
}
