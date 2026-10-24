/**
 * 作用域解析（M3）：把「当前会话 / 当前进程」映射到 KnowledgeHub 的 scope key。
 *
 * 硬约束（来自 M0 调研）：
 * - DSH 没有跨项目 ACL，隔离必须由本插件服务层强制；
 * - 会话头没有 workspaceId，只能 cwd → realpath → workspaceRegistry.resolveByPath 反查；
 * - 反查失败时只保留 user:* 作用域，绝不放宽到「所有工作区」。
 */
import { getKnowledgeBase, type KbRow } from './kb/store.js'
import { getDocument, type DocRow } from './search.js'
import { resolveWorkspace } from './workspace.js'
import type { Db } from './db/db.js'

export interface ScopeInfo {
  workspaceId: string | null
  workspacePath: string | null
  workspaceTitle: string | null
  scopeKeys: string[]
  cwd: string | null
}

export function scopeKeysFor(workspaceId: string | null): string[] {
  return workspaceId ? ['user:*', 'ws:' + workspaceId] : ['user:*']
}

export async function resolveScope(ctx: any, path: string | null): Promise<ScopeInfo> {
  const target = path && path.trim() !== '' ? path.trim() : null
  if (!target) return { workspaceId: null, workspacePath: null, workspaceTitle: null, scopeKeys: ['user:*'], cwd: null }
  try {
    const resolved = await resolveWorkspace(ctx, target)
    return {
      workspaceId: resolved.workspaceId,
      workspacePath: resolved.path,
      workspaceTitle: resolved.title,
      scopeKeys: scopeKeysFor(resolved.workspaceId),
      cwd: resolved.path,
    }
  } catch {
    return { workspaceId: null, workspacePath: null, workspaceTitle: null, scopeKeys: ['user:*'], cwd: target }
  }
}

/** 从工具执行上下文取会话 cwd（agent.session.header.cwd，创建会话时冻结）。 */
export function cwdFromExec(exec: any): string | null {
  const agent = exec?.agent
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : null
}

export async function scopeFromExec(ctx: any, exec: any): Promise<ScopeInfo> {
  return resolveScope(ctx, cwdFromExec(exec))
}

export function assertKbVisible(db: Db, kbId: string, scopeKeys: string[]): KbRow {
  const kb = getKnowledgeBase(db, kbId)
  if (!kb || !scopeKeys.includes(kb.scopeKey)) {
    const error: any = new Error('该知识库不在当前会话的授权作用域内：' + kbId)
    error.code = 'KB_FORBIDDEN'
    error.status = 403
    throw error
  }
  return kb
}

export function assertDocVisible(db: Db, docId: string, scopeKeys: string[]): DocRow {
  const doc = getDocument(db, docId)
  if (!doc) {
    const error: any = new Error('知识不存在：' + docId)
    error.code = 'DOC_NOT_FOUND'
    error.status = 404
    throw error
  }
  if (!doc.scopeKey || !scopeKeys.includes(doc.scopeKey)) {
    const error: any = new Error('该知识不在当前会话的授权作用域内：' + docId)
    error.code = 'DOC_FORBIDDEN'
    error.status = 403
    throw error
  }
  return doc
}
