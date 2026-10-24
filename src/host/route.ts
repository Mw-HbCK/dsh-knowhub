/** /knowhub HTTP 路由：前缀注册，原生 req/res，统一 {ok,value} / {ok,error} 信封。 */
import { errorMessage, readBody, writeError, writeOk } from './http.js'
import { buildDiagnose } from './diagnostics.js'
import { listWorkspaces, resolveWorkspace } from './workspace.js'
import { probeModel, readModelCatalog } from './model.js'
import { scanProject } from './scan.js'
import { normalizeForCompare } from './paths.js'
import { probeSqlite, storageProbe } from './storage.js'
import { handleKbRequest } from './kb/route.js'
import { handleReviewRequest } from './review/route.js'
import { readGitState } from './pipeline/git.js'
import { handleM5Request } from './m5/route.js'
import { openDatabase } from './db/db.js'
import { resolveStorageRoot } from './paths.js'
import { readSettings } from './settings.js'

async function authorizedRoots(ctx: any): Promise<string[]> {
  const listed = await listWorkspaces(ctx)
  const roots = listed.workspaces.map((workspace) => normalizeForCompare(workspace.path)).filter((value) => value !== '')
  roots.push(normalizeForCompare(process.cwd()))
  return roots
}

async function probeGit(path: string): Promise<any> {
  const state = await readGitState(path)
  return {
    path,
    git: state,
    note: state.available && state.isRepo
      ? '宿主进程可以执行只读 git 命令，增量更新将优先使用 Git 模式'
      : '宿主进程无法执行 git 或目录不是 Git 仓库，增量更新将使用哈希模式',
  }
}

export function createRouter(ctx: any, config: any): { handle: (req: any, res: any) => Promise<void> } {
  return {
    async handle(req: any, res: any): Promise<void> {
      const url = new URL(String(req.url ?? '/'), 'http://knowhub.internal')
      const suffix = url.pathname.startsWith('/knowhub') ? url.pathname.slice('/knowhub'.length) : url.pathname
      const path = suffix.replace(/^\/api/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()
      try {
        if (method === 'GET' && (path === '/ping' || path === '/')) {
          writeOk(res, { name: 'dsh-knowhub', time: new Date().toISOString(), endpoints: [
            'GET /knowhub/api/ping',
            'GET /knowhub/api/diagnose?section=all|runtime|storage|workspaces|models|sqlite|tools',
            'GET /knowhub/api/workspaces?path=',
            'GET /knowhub/api/models',
            'GET /knowhub/api/sqlite',
            'POST /knowhub/api/probe {provider,model,prompt?}',
            'POST /knowhub/api/scan {path?}',
            'POST /knowhub/api/storage-probe {value}',
            'GET /knowhub/api/current-workspace',
            'GET|POST /knowhub/api/kb',
            'GET|PATCH|DELETE /knowhub/api/kb/:id',
            'GET|POST /knowhub/api/kb/:id/docs',
            'GET /knowhub/api/search?q=&tag=&kbId=&kind=&status=&sort=',
            'POST /knowhub/api/kb/:id/initialize {workspaceId?}',
            'POST /knowhub/api/kb/:id/incremental {workspaceId?,dryRun?}',
            'GET /knowhub/api/kb/:id/git',
            'GET /knowhub/api/kb/:id/changes',
            'GET /knowhub/api/git-probe?path=',
            'GET /knowhub/api/kb/:id/tasks',
            'GET /knowhub/api/kb/:id/files',
            'GET /knowhub/api/kb/:id/llm-calls',
            'GET /knowhub/api/tasks/:id',
            'POST /knowhub/api/tasks/:id/cancel',
            'POST /knowhub/api/tasks/:id/retry',
            'GET /knowhub/api/review',
            'GET /knowhub/api/review/log',
            'GET /knowhub/api/review/proposals/:id',
            'GET /knowhub/api/review/proposals/:id/diff',
    'GET /knowhub/api/review/documents/:docId/diff',
            'GET /knowhub/api/review/conflicts/:id/diff',
            'POST /knowhub/api/review/proposals/:id/approve|reject',
            'POST /knowhub/api/review/conflicts/:id/resolve',
            'POST /knowhub/api/review/bulk {action,items}',
            'POST /knowhub/api/kb/:id/proposals',
            'GET /knowhub/api/kb/:id/docs/:docId/versions',
            'GET /knowhub/api/kb/:id/docs/:docId/versions/:version',
            'GET /knowhub/api/kb/:id/docs/:docId/diff?from=&to=',
            'PATCH /knowhub/api/kb/:id/docs/:docId',
            'POST /knowhub/api/kb/:id/docs/:docId/review',
            'POST /knowhub/api/kb/:id/docs/:docId/restore',
            'GET /knowhub/api/overview',
            'GET /knowhub/api/documents?kind=&status=&verifyState=&q=&kbId=&limit=&page=',
            'GET|PATCH /knowhub/api/settings',
            'POST /knowhub/api/settings/storage/migrate {target,dryRun?}',
            'GET|POST /knowhub/api/backups',
            'GET /knowhub/api/backups/stats',
            'POST /knowhub/api/backups/:id/restore {note?}',
            'POST /knowhub/api/distill {text,kbId?}',
            'GET /knowhub/api/distill/runs?limit=',
            'GET /knowhub/api/review?kbId=&kind=&q=&source=&order=&limit=&page=',
            'POST /knowhub/api/kb/:id/docs/:docId/parent {parentId}',
            'POST /knowhub/api/kb/:id/docs/:docId/feedback {helpful,reason?}',
            'GET /knowhub/api/kb/:id/docs/:docId/export',
            'GET /knowhub/api/kb/:id/export?format=json',
            'POST /knowhub/api/kb/:id/import {content}',
            'GET /knowhub/api/backups/:id/preview',
          ] })
          return
        }
        if (method === 'GET' && path === '/git-probe') {
          const target = url.searchParams.get('path')?.trim() || process.cwd()
          const probe = await probeGit(target)
          writeOk(res, probe)
          return
        }
        if (method === 'GET' && path === '/diagnose') {
          const value = await buildDiagnose(ctx, config, {
            section: url.searchParams.get('section'),
            path: url.searchParams.get('path'),
          })
          writeOk(res, value)
          return
        }
        if (method === 'GET' && path === '/workspaces') {
          const listed = await listWorkspaces(ctx)
          const target = url.searchParams.get('path')
          const resolved = await resolveWorkspace(ctx, target && target.trim() !== '' ? target.trim() : process.cwd())
          writeOk(res, { ...listed, target: resolved.path, resolved })
          return
        }
        if (method === 'GET' && path === '/models') {
          writeOk(res, await readModelCatalog(ctx))
          return
        }
        if (method === 'GET' && path === '/sqlite') {
          writeOk(res, await probeSqlite())
          return
        }
        if (method === 'POST' && (path === '/probe' || path === '/model-probe')) {
          const body = await readBody(req)
          writeOk(res, await probeModel(ctx, body ?? {}))
          return
        }
        if (method === 'POST' && path === '/scan') {
          const body = await readBody(req)
          const requested = typeof body?.path === 'string' && body.path.trim() !== '' ? body.path.trim() : process.cwd()
          const fs = await import('node:fs/promises')
          let real: string
          try {
            real = await fs.realpath(requested)
          } catch (error) {
            writeError(res, 400, 'SCAN_PATH_INVALID', '扫描路径不可访问：' + errorMessage(error))
            return
          }
          const authorized = await authorizedRoots(ctx)
          if (!authorized.includes(normalizeForCompare(real))) {
            writeError(res, 403, 'SCAN_PATH_NOT_AUTHORIZED', '拒绝扫描：该路径既不是当前工作区，也不是已注册的 DSH 工作区。请先在工作区列表中注册该目录。')
            return
          }
          const workspace = await resolveWorkspace(ctx, real)
          let excludeDirs: string[] = []
          try { excludeDirs = readSettings(openDatabase(resolveStorageRoot(config))).excludeDirs } catch { excludeDirs = [] }
          const scan = await scanProject(real, {
            maxFiles: typeof body?.maxFiles === 'number' ? Math.trunc(body.maxFiles) : undefined,
            maxDepth: typeof body?.maxDepth === 'number' ? Math.trunc(body.maxDepth) : undefined,
            excludeDirs,
          })
          writeOk(res, { workspace, scan })
          return
        }
        if (method === 'POST' && path === '/storage-probe') {
          const body = await readBody(req)
          writeOk(res, await storageProbe(config, body))
          return
        }
        if (await handleM5Request({ ctx, config, method, path, url, req, res })) return
        if (await handleKbRequest({ ctx, config, method, path, url, req, res })) return
        if (await handleReviewRequest({ ctx, config, method, path, url, req, res })) return
        writeError(res, 404, 'NOT_FOUND', '没有匹配的知枢接口：' + method + ' ' + url.pathname)
      } catch (error) {
        writeError(res, 500, 'INTERNAL_ERROR', errorMessage(error))
      }
    },
  }
}
