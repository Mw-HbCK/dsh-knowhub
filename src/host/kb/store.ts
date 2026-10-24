/**
 * 知识库领域逻辑：校验、作用域键、CRUD、重名约束、软删除。
 *
 * 作用域键设计（与 docs/data-model.md 一致）：
 *   scope=user      → scope_key = 'user:*'
 *   scope=workspace → scope_key = 'ws:<workspaceId>'
 * 绝不使用目录路径作为键：工作区删除重建后 ID 会变，路径不变。
 */
import { createHash } from 'node:crypto'
import { all, get, run, transaction, type Db } from '../db/db.js'
import { ensureKbLayout, removeKbFiles } from './files.js'
import { newId, nowIso } from '../utils/id.js'

export const SCOPES = ['user', 'workspace'] as const
export const STRATEGIES = ['economy', 'balanced', 'quality'] as const
export type Scope = (typeof SCOPES)[number]
export type Strategy = (typeof STRATEGIES)[number]

export interface KbRow {
  id: string
  name: string
  scope: string
  scopeKey: string
  workspaceId: string | null
  modelProvider: string
  modelId: string
  modelStrategy: string
  status: string
  statusDetail: string | null
  createdAt: string
  updatedAt: string
  schemaVersion: number
  workspacePath?: string | null
  workspaceTitle?: string | null
}

export class KbError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface KbInput {
  name?: unknown
  scope?: unknown
  workspaceId?: unknown
  modelProvider?: unknown
  modelId?: unknown
  modelStrategy?: unknown
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 名称按 Unicode 码点计数（中文一个字算一个字符）。 */
export function nameLength(name: string): number {
  return [...name].length
}

export function validateKbInput(input: KbInput): string[] {
  const errors: string[] = []
  const name = str(input.name)
  if (name === '') errors.push('名称不能为空')
  else {
    if (/[\u0000-\u001f\u007f]/.test(name)) errors.push('名称不能包含控制字符')
    const length = nameLength(name)
    if (length > 50) errors.push('名称最多 50 个字符（当前 ' + length + ' 个）')
  }
  const scope = str(input.scope)
  if (!SCOPES.includes(scope as Scope)) errors.push('生效范围必须是「用户」或「工作区」')
  if (scope === 'workspace' && str(input.workspaceId) === '') errors.push('工作区级知识库必须选择工作区')
  if (str(input.modelProvider) === '') errors.push('必须选择知识处理模型（缺少模型提供方）')
  if (str(input.modelId) === '') errors.push('必须选择知识处理模型（缺少模型标识）')
  const strategy = str(input.modelStrategy)
  if (!STRATEGIES.includes(strategy as Strategy)) errors.push('模型使用策略必须是 economy / balanced / quality 之一')
  return errors
}

export function scopeKeyOf(scope: string, workspaceId: string | null): string {
  if (scope === 'user') return 'user:*'
  if (workspaceId === null || workspaceId === '') throw new KbError('KB_WORKSPACE_REQUIRED', 400, '工作区级知识库必须提供 workspaceId')
  return 'ws:' + workspaceId
}

function toRow(raw: any): KbRow {
  return {
    id: String(raw.id),
    name: String(raw.name),
    scope: String(raw.scope),
    scopeKey: String(raw.scope_key),
    workspaceId: raw.workspace_id === null ? null : String(raw.workspace_id),
    modelProvider: String(raw.model_provider),
    modelId: String(raw.model_id),
    modelStrategy: String(raw.model_strategy),
    status: String(raw.status),
    statusDetail: raw.status_detail === null ? null : String(raw.status_detail),
    createdAt: new Date(Number(raw.created_at)).toISOString(),
    updatedAt: new Date(Number(raw.updated_at)).toISOString(),
    schemaVersion: Number(raw.schema_version),
  }
}

const SELECT = 'SELECT * FROM knowledge_bases WHERE deleted_at IS NULL'

export function listKnowledgeBases(db: Db, scopeKeys: string[]): KbRow[] {
  if (scopeKeys.length === 0) return []
  const marks = scopeKeys.map(() => '?').join(', ')
  return all(db, SELECT + ' AND scope_key IN (' + marks + ') ORDER BY updated_at DESC', scopeKeys).map(toRow)
}

export function listAllKnowledgeBases(db: Db): KbRow[] {
  return all(db, SELECT + ' ORDER BY updated_at DESC').map(toRow)
}

export function getKnowledgeBase(db: Db, id: string): KbRow | null {
  const raw = get(db, SELECT + ' AND id = ?', [id])
  return raw ? toRow(raw) : null
}

function findByName(db: Db, scopeKey: string, name: string): KbRow | null {
  const raw = get(db, SELECT + ' AND scope_key = ? AND name = ?', [scopeKey, name])
  return raw ? toRow(raw) : null
}

export interface CreateKbOptions {
  storageRoot: string
  workspacePath?: string | null
  workspaceTitle?: string | null
}

export async function createKnowledgeBase(db: Db, input: KbInput, options: CreateKbOptions): Promise<KbRow> {
  const errors = validateKbInput(input)
  if (errors.length > 0) throw new KbError('KB_INVALID_INPUT', 400, errors.join('；'))
  const name = str(input.name)
  const scope = str(input.scope) as Scope
  const workspaceId = scope === 'workspace' ? str(input.workspaceId) : null
  const scopeKey = scopeKeyOf(scope, workspaceId)
  if (findByName(db, scopeKey, name)) {
    throw new KbError('KB_NAME_DUPLICATED', 409, '同一作用范围内已存在同名知识库：' + name)
  }
  const timestamp = Date.now()
  const row: KbRow = {
    id: newId('kb'),
    name,
    scope,
    scopeKey,
    workspaceId,
    modelProvider: str(input.modelProvider),
    modelId: str(input.modelId),
    modelStrategy: str(input.modelStrategy),
    status: 'created',
    statusDetail: null,
    createdAt: new Date(timestamp).toISOString(),
    updatedAt: new Date(timestamp).toISOString(),
    schemaVersion: 1,
    workspacePath: options.workspacePath ?? null,
    workspaceTitle: options.workspaceTitle ?? null,
  }
  try {
    transaction(db, () => {
      run(db, 'INSERT INTO knowledge_bases (id, name, scope, scope_key, workspace_id, model_provider, model_id, model_strategy, status, status_detail, created_at, updated_at, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        row.id, row.name, row.scope, row.scopeKey, row.workspaceId, row.modelProvider, row.modelId, row.modelStrategy, row.status, null, timestamp, timestamp, row.schemaVersion,
      ])
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/UNIQUE constraint failed/i.test(message)) {
      throw new KbError('KB_NAME_DUPLICATED', 409, '同一作用范围内已存在同名知识库：' + name)
    }
    throw error
  }
  await ensureKbLayout(options.storageRoot, row)
  return row
}

export interface PatchKbInput {
  name?: unknown
  modelProvider?: unknown
  modelId?: unknown
  modelStrategy?: unknown
}

export async function updateKnowledgeBase(db: Db, storageRoot: string, id: string, patch: PatchKbInput): Promise<KbRow> {
  const current = getKnowledgeBase(db, id)
  if (!current) throw new KbError('KB_NOT_FOUND', 404, '知识库不存在：' + id)
  const next: KbRow = { ...current }
  if (patch.name !== undefined) {
    const name = str(patch.name)
    if (name === '') throw new KbError('KB_INVALID_INPUT', 400, '名称不能为空')
    if (/[\u0000-\u001f\u007f]/.test(name)) throw new KbError('KB_INVALID_INPUT', 400, '名称不能包含控制字符')
    if (nameLength(name) > 50) throw new KbError('KB_INVALID_INPUT', 400, '名称最多 50 个字符（当前 ' + nameLength(name) + ' 个）')
    if (name !== current.name) {
      const existing = findByName(db, current.scopeKey, name)
      if (existing && existing.id !== id) throw new KbError('KB_NAME_DUPLICATED', 409, '同一作用范围内已存在同名知识库：' + name)
      next.name = name
    }
  }
  if (patch.modelProvider !== undefined || patch.modelId !== undefined) {
    const provider = str(patch.modelProvider)
    const model = str(patch.modelId)
    if (provider === '' || model === '') throw new KbError('KB_INVALID_INPUT', 400, '修改模型时必须同时提供模型提供方与模型标识')
    next.modelProvider = provider
    next.modelId = model
  }
  if (patch.modelStrategy !== undefined) {
    const strategy = str(patch.modelStrategy)
    if (!STRATEGIES.includes(strategy as Strategy)) throw new KbError('KB_INVALID_INPUT', 400, '模型使用策略必须是 economy / balanced / quality 之一')
    next.modelStrategy = strategy
  }
  const timestamp = Date.now()
  transaction(db, () => {
    run(db, 'UPDATE knowledge_bases SET name = ?, model_provider = ?, model_id = ?, model_strategy = ?, updated_at = ? WHERE id = ?', [
      next.name, next.modelProvider, next.modelId, next.modelStrategy, timestamp, id,
    ])
  })
  next.updatedAt = new Date(timestamp).toISOString()
  await ensureKbLayout(storageRoot, { ...next, workspacePath: current.workspacePath ?? null, workspaceTitle: current.workspaceTitle ?? null })
  return next
}

export async function deleteKnowledgeBase(db: Db, storageRoot: string, id: string, mode: 'config' | 'files' | 'all'): Promise<{ id: string; mode: string; rowDeleted: boolean; filesDeleted: boolean }> {
  const current = getKnowledgeBase(db, id)
  if (!current) throw new KbError('KB_NOT_FOUND', 404, '知识库不存在：' + id)
  let rowDeleted = false
  let filesDeleted = false
  if (mode === 'config' || mode === 'all') {
    transaction(db, () => {
      run(db, 'UPDATE knowledge_bases SET deleted_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), id])
    })
    rowDeleted = true
  }
  if (mode === 'files' || mode === 'all') {
    await removeKbFiles(storageRoot, id)
    filesDeleted = true
    if (mode === 'files') {
      transaction(db, () => {
        run(db, "UPDATE knowledge_bases SET status = 'disabled', updated_at = ? WHERE id = ?", [Date.now(), id])
      })
    }
  }
  return { id, mode, rowDeleted, filesDeleted }
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function timestampIso(value: number): string {
  return new Date(value).toISOString()
}

export { nowIso }
