/** 组装 M0 诊断数据：运行时/工作区/模型/SQLite/存储/工具，全部来自真实调用。 */
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { dshHome, resolveStorageRoot } from './paths.js'
import { errorMessage } from './http.js'
import { listWorkspaces, resolveWorkspace } from './workspace.js'
import { readModelCatalog } from './model.js'
import { probeSqlite, storageProbe } from './storage.js'

export async function readOwnPackage(): Promise<{ name: string; version: string }> {
  try {
    const url = new URL('../../package.json', import.meta.url)
    const text = await fs.readFile(url, 'utf8')
    const parsed = JSON.parse(text)
    return { name: String(parsed.name ?? 'dsh-knowhub'), version: String(parsed.version ?? '0.0.0') }
  } catch {
    return { name: 'dsh-knowhub', version: '0.0.0' }
  }
}

function dshVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const path = require.resolve('@deepseek-ai/dsh/package.json')
    const parsed = JSON.parse(require('node:fs').readFileSync(path, 'utf8'))
    return String(parsed.version ?? '') || null
  } catch {
    return null
  }
}

export function runtimeInfo(): any {
  const versions = process.versions as any
  return {
    node: versions.node ?? null,
    electron: versions.electron ?? null,
    chrome: versions.chrome ?? null,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    cwd: process.cwd(),
    dshHome: dshHome(),
    dshVersion: dshVersion(),
    uptimeSec: Math.round(process.uptime()),
    time: new Date().toISOString(),
  }
}

function toolsInfo(ctx: any): any {
  const tools = (() => { try { return ctx?.get?.('tools') } catch { return undefined } })()
  return { serviceAvailable: tools !== undefined && tools !== null, registeredByPlugin: ['knowledge_diagnose'] }
}

export interface DiagnoseInput {
  section?: string | null
  path?: string | null
}

export async function buildDiagnose(ctx: any, config: any, input: DiagnoseInput = {}): Promise<any> {
  const section = typeof input.section === 'string' && input.section !== '' ? input.section : 'all'
  const want = (name: string): boolean => section === 'all' || section === name
  const pkg = await readOwnPackage()
  const result: any = {
    plugin: { name: pkg.name, version: pkg.version, route: '/knowhub/api/*', section },
  }
  if (want('runtime')) result.runtime = runtimeInfo()
  if (want('storage')) result.storage = await storageProbe(config, { kind: 'diagnose', section })
  if (want('workspaces')) {
    const listed = await listWorkspaces(ctx)
    const target = typeof input.path === 'string' && input.path.trim() !== '' ? input.path.trim() : process.cwd()
    const resolved = await resolveWorkspace(ctx, target)
    result.workspaces = { ...listed, target, resolved }
  }
  if (want('models')) result.models = await readModelCatalog(ctx)
  if (want('sqlite')) result.sqlite = await probeSqlite()
  if (want('tools')) result.tools = toolsInfo(ctx)
  return result
}

export async function summarizeError(error: unknown): Promise<string> {
  return errorMessage(error)
}

export { resolveStorageRoot }
