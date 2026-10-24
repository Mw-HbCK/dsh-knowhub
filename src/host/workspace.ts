/**
 * 工作区适配层：只读取 DSH 官方的 workspaceRegistry 服务。
 * 事实依据（本机 0.2.1-rc.2 类型定义 dsh-workspace/lib/types/index.d.ts）：
 *   list(): Workspace[]（同步，durable 顺序）
 *   get(id): Workspace | undefined
 *   resolveByPath(path): Promise<Workspace | undefined>（realpath 后按字符串相等反查，不创建）
 * Workspace 字段：id / path(realpath，永不重写) / title / createdAt / updatedAt / sessionIds。
 */
import { normalizeForCompare } from './paths.js'

export interface WorkspaceInfo {
  id: string
  title: string
  path: string
  createdAt: string | null
  updatedAt: string | null
  sessionCount: number | null
  pathState: 'ok' | 'missing' | 'unknown'
}

export function getRegistry(ctx: any): any {
  try {
    return ctx?.get?.('workspaceRegistry')
  } catch {
    return undefined
  }
}

async function pathState(path: string): Promise<'ok' | 'missing' | 'unknown'> {
  try {
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(path)
    return stat.isDirectory() ? 'ok' : 'missing'
  } catch {
    return 'unknown'
  }
}

export async function listWorkspaces(ctx: any): Promise<{
  available: boolean
  error: string | null
  count: number
  workspaces: WorkspaceInfo[]
}> {
  const registry = getRegistry(ctx)
  if (!registry) {
    return { available: false, error: 'workspaceRegistry 服务不可用（本 DSH 版本未提供或尚未初始化）', count: 0, workspaces: [] }
  }
  let raw: any[] = []
  try {
    raw = registry.list() ?? []
  } catch (error) {
    return { available: true, error: 'workspaceRegistry.list() 调用失败：' + String(error), count: 0, workspaces: [] }
  }
  const workspaces: WorkspaceInfo[] = []
  for (const item of raw) {
    if (!item) continue
    workspaces.push({
      id: String(item.id ?? ''),
      title: String(item.title ?? ''),
      path: String(item.path ?? ''),
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : null,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null,
      sessionCount: Array.isArray(item.sessionIds) ? item.sessionIds.length : null,
      pathState: await pathState(String(item.path ?? '')),
    })
  }
  return { available: true, error: null, count: workspaces.length, workspaces }
}

export async function resolveWorkspace(ctx: any, targetPath: string): Promise<{
  path: string
  workspaceId: string | null
  title: string | null
  error: string | null
}> {
  const registry = getRegistry(ctx)
  const result = { path: targetPath, workspaceId: null as string | null, title: null as string | null, error: null as string | null }
  if (!registry) {
    result.error = 'workspaceRegistry 服务不可用'
    return result
  }
  try {
    const workspace = await registry.resolveByPath(targetPath)
    if (workspace) {
      result.workspaceId = String(workspace.id ?? '')
      result.title = String(workspace.title ?? '')
    }
    return result
  } catch (error) {
    result.error = 'resolveByPath 失败：' + String(error)
    return result
  }
}

export async function findWorkspaceByPath(ctx: any, targetPath: string): Promise<WorkspaceInfo | null> {
  const listed = await listWorkspaces(ctx)
  const target = normalizeForCompare(targetPath)
  for (const workspace of listed.workspaces) {
    if (normalizeForCompare(workspace.path) === target) return workspace
  }
  return null
}
