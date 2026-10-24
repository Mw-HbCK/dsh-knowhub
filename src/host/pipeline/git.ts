/**
 * Git 变更检测（M4）：只读。只运行 git 的查询类子命令（rev-parse / status / diff），
 * 绝不执行仓库内脚本、绝不写工作区，也不修改索引。
 *
 * 兼容性说明：
 * - 宿主进程可能无法 spawn 子进程（例如被沙箱限制），此时 readGitState 返回 available=false，
 *   上层自动降级为文件哈希比对模式（见 changes.ts）。
 * - 工作区可能只是仓库的子目录：所有路径都会裁剪/重定位到工作区相对路径。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { relative, resolve, sep } from 'node:path'
import { EXCLUDED_DIRS, SENSITIVE_FILE } from '../scan.js'

const execFileAsync = promisify(execFile) as unknown as (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>

export interface GitCommandResult {
  ok: boolean
  stdout: string
  error: string | null
  code: string | null
}

/** 运行一条只读 git 命令；失败不抛错，返回结构化结果。 */
export async function runGit(root: string, args: string[], timeoutMs = 12000): Promise<GitCommandResult> {
  try {
    const result = await execFileAsync('git', args, {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
      },
    })
    return { ok: true, stdout: String(result.stdout ?? ''), error: null, code: null }
  } catch (error: any) {
    const code = error?.code === undefined || error?.code === null ? null : String(error.code)
    const message = error?.stderr ? String(error.stderr).trim().slice(0, 500) : String(error?.message ?? error).slice(0, 500)
    return { ok: false, stdout: '', error: message, code }
  }
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

function normalizedRelative(root: string, toplevel: string): string {
  const rel = toPosix(relative(resolve(root), resolve(toplevel)))
  return rel === '.' ? '' : rel.replace(/^\/+|\/+$/g, '')
}

/** 读一次仓库状态（不写任何东西）。 */
export async function readGitState(root: string): Promise<{
  available: boolean
  isRepo: boolean
  toplevel: string | null
  head: string | null
  branch: string | null
  dirtyCount: number
  subPath: string
  error: string | null
}> {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok) {
    return { available: false, isRepo: false, toplevel: null, head: null, branch: null, dirtyCount: 0, subPath: '', error: inside.error ?? 'git 不可用' }
  }
  if (inside.stdout.trim() !== 'true') {
    return { available: true, isRepo: false, toplevel: null, head: null, branch: null, dirtyCount: 0, subPath: '', error: '该目录不是 Git 工作区' }
  }
  const toplevelResult = await runGit(root, ['rev-parse', '--show-toplevel'])
  const toplevel = toplevelResult.ok ? toplevelResult.stdout.trim() : ''
  const headResult = await runGit(root, ['rev-parse', '--verify', 'HEAD'])
  const head = headResult.ok ? headResult.stdout.trim() : null
  const branchResult = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchResult.ok ? branchResult.stdout.trim() : null
  const statusResult = await runGit(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])
  const subPath = toplevel === '' ? '' : normalizedRelative(root, toplevel)
  const dirty = statusResult.ok ? filterAndRebase(parsePorcelainZ(statusResult.stdout), subPath) : []
  return {
    available: true,
    isRepo: true,
    toplevel: toplevel === '' ? null : toplevel,
    head,
    branch,
    dirtyCount: dirty.length,
    subPath,
    error: statusResult.ok ? null : statusResult.error,
  }
}

export interface FileChange {
  path: string
  change: 'added' | 'modified' | 'deleted'
}

function changeFromStatus(status: string): 'added' | 'modified' | 'deleted' | null {
  if (status === '??' || status.startsWith('A')) return 'added'
  if (status === 'D' || status.endsWith('D')) return 'deleted'
  if (status === '!' ) return null
  return 'modified'
}

/** 解析 `git diff --name-status -z --no-renames`。 */
export function parseNameStatusZ(output: string): FileChange[] {
  const tokens = output.split('\u0000')
  const changes: FileChange[] = []
  let index = 0
  while (index < tokens.length) {
    const status = (tokens[index] ?? '').trim()
    index += 1
    if (status === '') continue
    if (!/^[A-Z][0-9]*$/.test(status)) continue
    let path = tokens[index] ?? ''
    index += 1
    if (/^[RC]/.test(status)) {
      path = tokens[index] ?? ''
      index += 1
    }
    if (path === '') continue
    const change = changeFromStatus(status)
    if (change === null) continue
    changes.push({ path: toPosix(path), change })
  }
  return changes
}

/** 解析 `git status --porcelain=v1 -z --no-renames`。 */
export function parsePorcelainZ(output: string): FileChange[] {
  const tokens = output.split('\u0000')
  const changes: FileChange[] = []
  let index = 0
  while (index < tokens.length) {
    const entry = tokens[index] ?? ''
    index += 1
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    let path = entry.slice(3)
    if (status.startsWith('R') || status.startsWith('C')) {
      path = tokens[index] ?? path
      index += 1
    }
    if (path === '') continue
    const change = changeFromStatus(status)
    if (change === null) continue
    changes.push({ path: toPosix(path), change })
  }
  return changes
}

function isAllowedPath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  const segments = path.split('/')
  if (segments.includes('..') || segments.includes('')) return false
  for (const segment of segments) {
    if (EXCLUDED_DIRS.has(segment)) return false
    if (SENSITIVE_FILE.some((pattern) => pattern.test(segment))) return false
  }
  return true
}

/** 过滤排除项，并把仓库相对路径重定位为工作区相对路径。 */
export function filterAndRebase(changes: FileChange[], subPath: string): FileChange[] {
  const prefix = subPath === '' ? '' : subPath.replace(/^\/+|\/+$/g, '') + '/'
  const seen = new Map<string, FileChange>()
  for (const change of changes) {
    let path = toPosix(change.path).replace(/^\.\//, '')
    if (prefix !== '') {
      if (!path.startsWith(prefix)) continue
      path = path.slice(prefix.length)
    }
    if (!isAllowedPath(path)) continue
    const previous = seen.get(path)
    if (previous && previous.change === change.change) continue
    seen.set(path, { path, change: change.change })
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** 检测自 `sinceHead` 以来的提交变更 + 未提交变更；失败时 ok=false，由上层降级。 */
export async function gitChanges(root: string, sinceHead: string | null): Promise<{
  ok: boolean
  mode: 'git'
  head: string | null
  branch: string | null
  dirtyCount: number
  toplevel: string | null
  subPath: string
  changes: FileChange[]
  error: string | null
}> {
  const state = await readGitState(root)
  const base = { mode: 'git' as const, head: state.head, branch: state.branch, dirtyCount: state.dirtyCount, toplevel: state.toplevel, subPath: state.subPath }
  if (!state.available) return { ...base, ok: false, changes: [], error: state.error ?? 'git 不可用' }
  if (!state.isRepo) return { ...base, ok: false, changes: [], error: state.error ?? '不是 Git 工作区' }

  const collected: FileChange[] = []
  let diffError: string | null = null
  if (sinceHead !== null && state.head !== null && sinceHead !== state.head) {
    const diff = await runGit(root, ['diff', '--name-status', '-z', '--no-renames', sinceHead + '..HEAD'])
    if (diff.ok) collected.push(...parseNameStatusZ(diff.stdout))
    else diffError = diff.error
  }
  const status = await runGit(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])
  if (status.ok) collected.push(...parsePorcelainZ(status.stdout))
  else if (diffError === null) diffError = status.error

  const changes = filterAndRebase(collected, state.subPath)
  return { ...base, ok: true, changes, error: diffError }
}
