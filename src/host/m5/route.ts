/**
 * M5 产品化接口：总览、跨库浏览、设置与诊断、备份恢复、存储位置迁移、自动提炼。
 *
 * 隔离原则：作用域一律由服务端从当前进程工作目录反查工作区得出；
 * 客户端只能传筛选条件（kind/status/query），不能指定任意 kbId 列表。
 */
import { errorMessage, readBody, writeError, writeOk } from '../http.js'
import { openDatabase } from '../db/db.js'
import { resolveStorageRoot } from '../paths.js'
import { listKnowledgeBases } from '../kb/store.js'
import { buildOverview, listDocumentsAcrossKbs } from '../overview.js'
import { readSettings, settingsSnapshot, writeSettings } from '../settings.js'
import { backupStats, createBackup, listBackups, migrateStorage, previewBackup, restoreBackup } from '../backup.js'
import { distillText, listDistillRuns } from '../distill.js'
import { resolveScope } from '../scope.js'

interface RouteContext {
  ctx: any
  config: any
  method: string
  path: string
  url: URL
  req: any
  res: any
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function intOr(value: string | null, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}

/** 统一把业务错误码与状态码映射成 {ok:false,error:{code,message}}。 */
async function fail(res: any, run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error: any) {
    const status = typeof error?.status === 'number' ? error.status : 500
    const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'INTERNAL_ERROR'
    writeError(res, status, code, errorMessage(error))
  }
}

export async function handleM5Request(route: RouteContext): Promise<boolean> {
  const { ctx, config, method, path, url, req, res } = route
  const storageRoot = resolveStorageRoot(config)
  const db = () => openDatabase(storageRoot)

  if (method === 'GET' && path === '/overview') {
    await fail(res, async () => {
      const scope = await resolveScope(ctx, process.cwd())
      writeOk(res, { workspaceId: scope.workspaceId, workspacePath: scope.workspacePath, scopeKeys: scope.scopeKeys, ...buildOverview(db(), storageRoot, scope.scopeKeys) })
    })
    return true
  }

  if (method === 'GET' && path === '/documents') {
    await fail(res, async () => {
      const scope = await resolveScope(ctx, process.cwd())
      const kbId = str(url.searchParams.get('kbId'))
      const visible = listKnowledgeBases(db(), scope.scopeKeys)
      let kbIds = visible.map((kb) => kb.id)
      if (kbId !== '') {
        const target = visible.find((kb) => kb.id === kbId)
        if (!target) throw Object.assign(new Error('知识库不存在或当前作用域无权访问：' + kbId), { code: 'KB_FORBIDDEN', status: 403 })
        kbIds = [kbId]
      }
      const value = listDocumentsAcrossKbs(db(), kbIds, {
        kind: url.searchParams.get('kind'),
        status: url.searchParams.get('status'),
        verifyState: url.searchParams.get('verifyState'),
        query: url.searchParams.get('q'),
        limit: intOr(url.searchParams.get('limit'), 50),
        offset: Math.max(0, intOr(url.searchParams.get('page'), 1) - 1) * intOr(url.searchParams.get('limit'), 50),
      })
      writeOk(res, {
        workspaceId: scope.workspaceId,
        scopeKeys: scope.scopeKeys,
        knowledgeBases: visible.map((kb) => ({ id: kb.id, name: kb.name, scope: kb.scope, status: kb.status })),
        ...value,
      })
    })
    return true
  }

  if (method === 'GET' && path === '/settings') {
    await fail(res, async () => { writeOk(res, settingsSnapshot(db(), config)) })
    return true
  }

  if (method === 'PATCH' && path === '/settings') {
    await fail(res, async () => {
      const body = await readBody(req)
      writeSettings(db(), body ?? {}, str(body?.actor) || 'web')
      writeOk(res, settingsSnapshot(db(), config))
    })
    return true
  }

  if (method === 'POST' && path === '/settings/storage/migrate') {
    await fail(res, async () => {
      const body = await readBody(req)
      const target = str(body?.target)
      if (target === '') throw Object.assign(new Error('必须提供目标目录 target'), { code: 'STORAGE_TARGET_REQUIRED', status: 400 })
      const result = await migrateStorage(db(), config, { target, dryRun: body?.dryRun === true, actor: str(body?.actor) || 'web' })
      writeOk(res, result)
    })
    return true
  }

  if (method === 'GET' && path === '/backups') {
    await fail(res, async () => {
      writeOk(res, { backups: listBackups(db(), storageRoot), stats: backupStats(db(), storageRoot) })
    })
    return true
  }

  if (method === 'GET' && path === '/backups/stats') {
    await fail(res, async () => { writeOk(res, backupStats(db(), storageRoot)) })
    return true
  }

  if (method === 'GET' && path.startsWith('/backups/') && path.endsWith('/preview')) {
    const backupId = decodeURIComponent(path.slice('/backups/'.length, -'/preview'.length))
    await fail(res, async () => { writeOk(res, previewBackup(db(), storageRoot, backupId)) })
    return true
  }

  if (method === 'POST' && path === '/backups') {
    await fail(res, async () => {
      const body = await readBody(req)
      writeOk(res, createBackup(db(), storageRoot, {
        kbIds: Array.isArray(body?.kbIds) ? body.kbIds.map(String) : undefined,
        note: str(body?.note) || null,
        actor: str(body?.actor) || 'web',
        includeVersions: body?.includeVersions !== false,
      }))
    })
    return true
  }

  if (method === 'POST' && path.startsWith('/backups/') && path.endsWith('/restore')) {
    const backupId = path.slice('/backups/'.length, -'/restore'.length)
    await fail(res, async () => {
      const body = await readBody(req)
      const result = await restoreBackup(db(), storageRoot, backupId, { actor: str(body?.actor) || 'web', note: str(body?.note) || null })
      writeOk(res, result)
    })
    return true
  }

  if (method === 'POST' && path === '/distill') {
    await fail(res, async () => {
      const body = await readBody(req)
      const scope = await resolveScope(ctx, process.cwd())
      const result = await distillText(ctx, db(), config, {
        text: typeof body?.text === 'string' ? body.text : '',
        kbId: str(body?.kbId) || null,
        scope,
        source: str(body?.source) || 'manual',
        actor: str(body?.actor) || 'web',
      })
      writeOk(res, result)
    })
    return true
  }

  if (method === 'GET' && path === '/distill/runs') {
    await fail(res, async () => {
      const settings = readSettings(db())
      writeOk(res, { runs: listDistillRuns(db(), intOr(url.searchParams.get('limit'), 20)), autoDistill: settings.autoDistill, distillMinChars: settings.distillMinChars })
    })
    return true
  }

  return false
}
