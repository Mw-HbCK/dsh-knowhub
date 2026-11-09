/** 组装 M0 诊断数据：运行时/工作区/模型/SQLite/存储/工具，全部来自真实调用。 */
import { promises as fs, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dshHome, resolveStorageRoot } from './paths.js'
import { errorMessage } from './http.js'
import { listWorkspaces, resolveWorkspace } from './workspace.js'
import { readModelCatalog } from './model.js'
import { probeSqlite, storageProbe } from './storage.js'

const PACKAGE_URL = new URL('../../package.json', import.meta.url)
const FALLBACK_PACKAGE = { name: 'dsh-knowhub', version: '0.0.0' }

function parsePackage(text: string): { name: string; version: string } {
  const parsed = JSON.parse(text)
  return { name: String(parsed.name ?? 'dsh-knowhub'), version: String(parsed.version ?? '0.0.0') }
}

export async function readOwnPackage(): Promise<{ name: string; version: string }> {
  try {
    return parsePackage(await fs.readFile(PACKAGE_URL, 'utf8'))
  } catch {
    return { ...FALLBACK_PACKAGE }
  }
}

/** 同步读磁盘 package.json；失败返回 null，把「读不到」与真实版本号区分开。 */
export function readOwnPackageSync(): { name: string; version: string } | null {
  try {
    return parsePackage(readFileSync(fileURLToPath(PACKAGE_URL), 'utf8'))
  } catch {
    return null
  }
}

/** 异步读磁盘 package.json；失败返回 null（对比时记为未知，不产生假阳性）。 */
export async function readInstalledPackage(): Promise<{ name: string; version: string } | null> {
  try {
    return parsePackage(await fs.readFile(PACKAGE_URL, 'utf8'))
  } catch {
    return null
  }
}

// ---- 运行版本（进程启动时定格）与安装版本（磁盘现读）的对比（C-3） ----

let runningVersion: string | null = null

/**
 * 插件 apply() 启动时调用一次：把当时磁盘上的版本定格为本进程的「运行版本」。
 * 升级只替换磁盘文件、宿主不重启时，运行版本仍是旧版——正是要提示的情形。
 * 重复调用不覆盖（进程内版本终身不变）；读取失败时保持 null。
 */
export function captureRunningVersion(): string | null {
  if (runningVersion === null) {
    runningVersion = readOwnPackageSync()?.version ?? null
  }
  return runningVersion
}

export function getRunningVersion(): string | null {
  return runningVersion
}

/** 仅供测试：直接指定运行版本（传 null 表示未捕获/读取失败）。 */
export function setRunningVersionForTest(version: string | null): void {
  runningVersion = version
}

export interface VersionCheck {
  running: string | null
  installed: string | null
  mismatch: boolean
}

/** 纯对比：只看字符串相等与否（磁盘回滚同样算不一致）；任一侧未知（null）一律不报不一致，宁可不提示也不误报。 */
export function compareVersions(running: string | null, installed: string | null): VersionCheck {
  return { running, installed, mismatch: running !== null && installed !== null && running !== installed }
}

/** 组装一次版本对比：运行版本用启动时定格值，安装版本现读磁盘。 */
export async function buildVersionCheck(): Promise<VersionCheck & { name: string }> {
  const pkg = await readInstalledPackage()
  const check = compareVersions(getRunningVersion(), pkg?.version ?? null)
  return { name: pkg?.name ?? FALLBACK_PACKAGE.name, ...check }
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
  const versionInfo = await buildVersionCheck()
  const result: any = {
    plugin: {
      name: versionInfo.name,
      // version 语义为「运行版本」；未捕获到时回退到安装版本，再不行回退 0.0.0（与旧行为一致）。
      version: versionInfo.running ?? versionInfo.installed ?? FALLBACK_PACKAGE.version,
      installedVersion: versionInfo.installed,
      versionMismatch: versionInfo.mismatch,
      route: '/knowhub/api/*', section,
    },
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
