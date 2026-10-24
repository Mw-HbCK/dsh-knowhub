/**
 * 受控文件扫描：只读、不执行、不跟随符号链接，默认排除敏感与无关内容。
 * M0 仅用于证明「能安全统计项目文件」，不做模型分析。
 */
import { promises as fs } from 'node:fs'
import { extname, join, sep } from 'node:path'

export const EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '.cache', '.turbo', '.parcel-cache', '.venv', 'venv', '__pycache__', 'target', '.idea', '.gradle',
  '.m2', '.pnpm-store', '.yarn', 'tmp', '.tmp', '.temp', '.DS_Store',
])

export const SENSITIVE_FILE = [
  /^\.env(\..+)?$/i,
  /^\.credentials(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|keystore|jks|crt|cer|der)$/i,
  /^secrets?(\.|-)/i,
  /\.(env|secret|secrets)$/i,
]

export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.yml', '.yaml', '.toml',
  '.css', '.scss', '.less', '.html', '.vue', '.svelte', '.py', '.go', '.rs', '.java', '.kt', '.cs',
  '.c', '.h', '.cpp', '.hpp', '.sh', '.ps1', '.sql', '.txt', '.xml', '.gradle',
])

export interface ScanOptions {
  /** 用户设置的追加排除目录（工作区相对路径或目录名）；默认排除名单仍然生效。 */
  excludeDirs?: string[]
  maxFiles?: number
  maxDepth?: number
  maxBytesContent?: number
  timeoutMs?: number
}

export interface ScanResult {
  root: string
  fileCount: number
  dirCount: number
  totalBytes: number
  byExtension: Array<{ extension: string; count: number; bytes: number }>
  excludedDirs: string[]
  skippedSymlinks: number
  skippedSensitive: number
  oversizedFiles: number
  skippedExcluded: number
  truncated: boolean
  elapsedMs: number
  sample: string[]
}

/** 规范化用户排除目录：去空白、反斜杠转正斜杠、拒绝绝对路径与 '..' 段；最多 40 条。 */
export function normalizeExcludeDirs(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const value = item.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
    if (value === '') continue
    if (value.startsWith('/') || /^[a-z]:/.test(value)) continue
    if (value.split('/').some((segment) => segment === '..' || segment === '.')) continue
    out.push(value)
  }
  return [...new Set(out)].slice(0, 40)
}

/** 判断工作区相对路径（posix）是否被用户排除目录命中：完全相等、位于其下、或目录名出现在任一层。 */
export function isExcludedPath(relPosix: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  const value = relPosix.replace(/\\/g, '/').toLowerCase()
  for (const pattern of patterns) {
    if (value === pattern) return true
    if (value.startsWith(pattern + '/')) return true
    if (!pattern.includes('/') && value.split('/').includes(pattern)) return true
  }
  return false
}

export async function scanProject(rootInput: string, options: ScanOptions = {}): Promise<ScanResult> {
  const excludePatterns = normalizeExcludeDirs(options.excludeDirs)
  const started = Date.now()
  const maxFiles = options.maxFiles ?? 20000
  const maxDepth = options.maxDepth ?? 12
  const timeoutMs = options.timeoutMs ?? 15000
  const rootReal = await fs.realpath(rootInput)
  const rootStat = await fs.stat(rootReal)
  if (!rootStat.isDirectory()) throw new Error('扫描目标不是目录：' + rootInput)

  const stats = new Map<string, { count: number; bytes: number }>()
  const excludedDirs = new Set<string>()
  const sample: string[] = []
  let fileCount = 0
  let dirCount = 0
  let totalBytes = 0
  let skippedSymlinks = 0
  let skippedSensitive = 0
  let skippedExcluded = 0
  let oversizedFiles = 0
  let truncated = false
  const excludeDirNames = new Set<string>()

  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootReal, depth: 0 }]
  while (stack.length > 0) {
    if (Date.now() - started > timeoutMs) { truncated = true; break }
    if (fileCount > maxFiles) { truncated = true; break }
    const current = stack.pop()!
    let entries: any[]
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current.dir, entry.name)
      if (entry.isSymbolicLink()) { skippedSymlinks += 1; continue }
      const relPosix = full.slice(rootReal.length + sep.length).replace(/\\/g, '/')
      if (isExcludedPath(relPosix, excludePatterns)) { skippedExcluded += 1; excludeDirNames.add(entry.name); continue }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) { excludedDirs.add(entry.name); continue }
        if (current.depth + 1 > maxDepth) { truncated = true; continue }
        dirCount += 1
        stack.push({ dir: full, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (SENSITIVE_FILE.some((pattern) => pattern.test(entry.name))) { skippedSensitive += 1; continue }
      let size = 0
      try {
        const stat = await fs.stat(full)
        size = stat.size
      } catch {
        continue
      }
      fileCount += 1
      totalBytes += size
      const extension = extname(entry.name).toLowerCase() || '(无扩展名)'
      const bucket = stats.get(extension) ?? { count: 0, bytes: 0 }
      bucket.count += 1
      bucket.bytes += size
      stats.set(extension, bucket)
      if (size > (options.maxBytesContent ?? 2 * 1024 * 1024)) { oversizedFiles += 1; continue }
      if (sample.length < 60 && TEXT_EXTENSIONS.has(extension)) {
        const relative = full.slice(rootReal.length + sep.length).replace(/\\/g, '/')
        sample.push(relative)
      }
    }
  }

  const byExtension = [...stats.entries()]
    .map(([extension, bucket]) => ({ extension, count: bucket.count, bytes: bucket.bytes }))
    .sort((a, b) => b.count - a.count)

  return {
    root: rootReal,
    fileCount,
    dirCount,
    totalBytes,
    byExtension,
    excludedDirs: [...excludedDirs, ...excludeDirNames].sort(),
    skippedSymlinks,
    skippedExcluded,
    skippedSensitive,
    oversizedFiles,
    truncated,
    elapsedMs: Date.now() - started,
    sample,
  }
}
