/**
 * 项目索引器：安全扫描 + 语言/框架/依赖识别 + 文件哈希（增量更新的基础）。
 *
 * 安全边界（与 M0 扫描器一致）：
 * - 不跟随符号链接（防逃逸）；
 * - 默认排除 .git / node_modules / 构建输出 / 缓存目录；
 * - 默认排除密钥与凭据类文件（.env*、*.pem、id_rsa 等），不读取内容、不写入索引；
 * - 只读取授权工作区目录内部的文件；不执行仓库中的任何脚本。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { all, get, run, transaction, type Db } from '../db/db.js'
import { EXCLUDED_DIRS, SENSITIVE_FILE, isExcludedPath, normalizeExcludeDirs } from '../scan.js'

export const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.json': 'JSON', '.md': 'Markdown', '.mdx': 'Markdown',
  '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML', '.ini': 'INI',
  '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less', '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.hpp': 'C++', '.php': 'PHP', '.rb': 'Ruby', '.swift': 'Swift',
  '.sh': 'Shell', '.ps1': 'PowerShell', '.bat': 'Batch',
  '.sql': 'SQL', '.graphql': 'GraphQL', '.proto': 'Proto', '.xml': 'XML', '.txt': 'Text',
  '.gradle': 'Gradle', '.cmake': 'CMake', '.lock': 'Lock',
}

/** 参与内容哈希与全文索引的扩展名（二进制/大文件不读内容）。 */
const TEXT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.yml', '.yaml', '.toml', '.ini', '.css', '.scss', '.less', '.html', '.vue', '.svelte', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.c', '.h', '.cpp', '.hpp', '.php', '.rb', '.swift', '.sh', '.ps1', '.bat', '.sql', '.graphql', '.proto', '.xml', '.txt', '.gradle', '.cmake'])

const CONFIG_FILES = [
  'package.json', 'tsconfig.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock',
  'README.md', 'README.zh.md', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'settings.gradle', 'CMakeLists.txt', 'Makefile', 'Dockerfile',
  'docker-compose.yml', 'docker-compose.yaml', '.github/workflows',
  'vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.mjs', 'vue.config.js',
  'cordis.patch.yml', 'cordis.yml',
]

const FRAMEWORK_BY_DEP: Record<string, string> = {
  react: 'React', 'react-dom': 'React', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', 'next': 'Next.js',
  '@angular/core': 'Angular', express: 'Express', fastify: 'Fastify', koa: 'Koa', cordis: 'Cordis',
  '@deepseek-ai/cordis': 'Cordis', vite: 'Vite', webpack: 'Webpack', esbuild: 'esbuild',
  jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', 'node:test': 'node:test',
  tailwindcss: 'Tailwind CSS', typescript: 'TypeScript', zod: 'Zod', schemastery: 'Schemastery',
}

export interface IndexedFile {
  path: string
  size: number
  extension: string
  language: string
  hash: string | null
}

export interface ProjectStack {
  languages: string[]
  frameworks: string[]
  packageManagers: string[]
  configFiles: string[]
  entryHints: string[]
  scripts: string[]
}

export interface ProjectIndex {
  root: string
  files: IndexedFile[]
  fileCount: number
  textFileCount: number
  totalBytes: number
  byLanguage: Array<{ language: string; count: number; bytes: number }>
  byExtension: Array<{ extension: string; count: number }>
  excludedDirs: string[]
  skippedSensitive: number
  skippedSymlinks: number
  skippedExcluded: number
  oversizedFiles: number
  truncated: boolean
  elapsedMs: number
  stack: ProjectStack
  configSnippets: Array<{ path: string; text: string }>
  tree: string[]
}

export interface IndexOptions {
  maxFiles?: number
  maxDepth?: number
  maxContentBytes?: number
  maxHashes?: number
  timeoutMs?: number
  /** 用户设置的追加排除目录（工作区相对路径或目录名）。 */
  excludeDirs?: string[]
}

function isSensitive(name: string): boolean {
  return SENSITIVE_FILE.some((pattern) => pattern.test(name))
}

function toPosix(value: string): string {
  return value.split(sep).join('/')
}

export async function indexProject(rootInput: string, options: IndexOptions = {}): Promise<ProjectIndex> {
  const started = Date.now()
  const maxFiles = Math.max(100, Math.min(50000, options.maxFiles ?? 20000))
  const maxDepth = Math.max(1, Math.min(32, options.maxDepth ?? 12))
  const maxContentBytes = Math.max(4096, Math.min(4 * 1024 * 1024, options.maxContentBytes ?? 512 * 1024))
  const maxHashes = Math.max(0, Math.min(20000, options.maxHashes ?? 4000))
  const excludePatterns = normalizeExcludeDirs(options.excludeDirs)
  const timeoutMs = Math.max(1000, Math.min(120000, options.timeoutMs ?? 30000))

  const root = await fs.realpath(rootInput)
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error('项目路径不是目录：' + root)

  const files: IndexedFile[] = []
  const excludedDirs = new Set<string>()
  let skippedSensitive = 0
  let skippedSymlinks = 0
  let skippedExcluded = 0
  let oversizedFiles = 0
  const excludeDirNames = new Set<string>()
  let truncated = false
  let totalBytes = 0

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    if (files.length >= maxFiles || Date.now() - started > timeoutMs) { truncated = true; break }
    const current = stack.pop()
    if (!current) break
    let entries: any[]
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = join(current.dir, entry.name)
      if (entry.isSymbolicLink()) { skippedSymlinks += 1; continue }
      const relPosix = toPosix(relative(root, absolute))
      if (isExcludedPath(relPosix, excludePatterns)) { skippedExcluded += 1; excludeDirNames.add(entry.name); continue }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) { excludedDirs.add(entry.name); continue }
        if (current.depth + 1 > maxDepth) { truncated = true; continue }
        stack.push({ dir: absolute, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (isSensitive(entry.name)) { skippedSensitive += 1; continue }
      const extension = extname(entry.name).toLowerCase()
      const language = LANGUAGE_BY_EXT[extension] ?? 'Other'
      const relativePath = toPosix(relative(root, absolute))
      let size = 0
      try {
        const info = await fs.stat(absolute)
        size = info.size
      } catch {
        continue
      }
      if (size > maxContentBytes) { oversizedFiles += 1; files.push({ path: relativePath, size, extension, language, hash: null }); continue }
      totalBytes += size
      files.push({ path: relativePath, size, extension, language, hash: null })
      if (files.length >= maxFiles) { truncated = true; break }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  // 内容哈希：只对文本文件、且数量受 maxHashes 限制（增量更新的基础）
  let hashed = 0
  for (const file of files) {
    if (hashed >= maxHashes) break
    if (!TEXT_EXTS.has(file.extension)) continue
    if (file.size > maxContentBytes) continue
    try {
      const buffer = await fs.readFile(join(root, file.path))
      file.hash = createHash('sha256').update(buffer).digest('hex')
      hashed += 1
    } catch {
      file.hash = null
    }
  }

  const byLanguageMap = new Map<string, { count: number; bytes: number }>()
  const byExtensionMap = new Map<string, number>()
  for (const file of files) {
    const language = file.language
    const bucket = byLanguageMap.get(language) ?? { count: 0, bytes: 0 }
    bucket.count += 1
    bucket.bytes += file.size
    byLanguageMap.set(language, bucket)
    byExtensionMap.set(file.extension === '' ? '(无扩展名)' : file.extension, (byExtensionMap.get(file.extension === '' ? '(无扩展名)' : file.extension) ?? 0) + 1)
  }
  const byLanguage = [...byLanguageMap.entries()].map(([language, value]) => ({ language, count: value.count, bytes: value.bytes })).sort((a, b) => b.count - a.count)
  const byExtension = [...byExtensionMap.entries()].map(([extension, count]) => ({ extension, count })).sort((a, b) => b.count - a.count)

  const pathSet = new Set(files.map((file) => file.path))
  const stackInfo = await detectStack(root, files, pathSet)

  const configSnippets: Array<{ path: string; text: string }> = []
  for (const name of CONFIG_FILES) {
    const hit = files.find((file) => file.path === name)
    if (!hit) continue
    try {
      let text = await fs.readFile(join(root, hit.path), 'utf8')
      if (text.length > 6000) text = text.slice(0, 6000) + '\n…（已截断）'
      configSnippets.push({ path: hit.path, text })
    } catch { /* 读失败跳过 */ }
  }

  // 目录摘要（前 120 个目录，按文件数排序）
  const dirCounts = new Map<string, number>()
  for (const file of files) {
    const index = file.path.lastIndexOf('/')
    const dir = index < 0 ? '.' : file.path.slice(0, index)
    dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
  }
  const tree = [...dirCounts.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 120).map(([dir, count]) => dir + '/ (' + count + ' 个文件)')

  return {
    root,
    files,
    fileCount: files.length,
    textFileCount: files.filter((file) => TEXT_EXTS.has(file.extension)).length,
    totalBytes,
    byLanguage,
    byExtension,
    excludedDirs: [...excludedDirs, ...excludeDirNames].sort(),
    skippedSensitive,
    skippedSymlinks,
    skippedExcluded,
    oversizedFiles,
    truncated,
    elapsedMs: Date.now() - started,
    stack: stackInfo,
    configSnippets,
    tree,
  }
}

async function detectStack(root: string, files: IndexedFile[], pathSet: Set<string>): Promise<ProjectStack> {
  const languages = new Set<string>()
  for (const file of files) {
    if (file.language !== 'Other') languages.add(file.language)
  }
  const frameworks = new Set<string>()
  const packageManagers = new Set<string>()
  const configFiles = new Set<string>()
  const scripts: string[] = []
  const entryHints = new Set<string>()

  for (const name of CONFIG_FILES) {
    if (pathSet.has(name)) configFiles.add(name)
  }
  if (pathSet.has('pnpm-lock.yaml') || pathSet.has('pnpm-workspace.yaml')) packageManagers.add('pnpm')
  if (pathSet.has('package-lock.json')) packageManagers.add('npm')
  if (pathSet.has('yarn.lock')) packageManagers.add('yarn')
  if (pathSet.has('pyproject.toml') || pathSet.has('requirements.txt')) packageManagers.add('pip/poetry')
  if (pathSet.has('go.mod')) packageManagers.add('go modules')
  if (pathSet.has('Cargo.toml')) packageManagers.add('cargo')

  if (pathSet.has('package.json')) {
    try {
      const parsed = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'))
      const deps = { ...(parsed?.dependencies ?? {}), ...(parsed?.devDependencies ?? {}) }
      for (const dep of Object.keys(deps)) {
        const framework = FRAMEWORK_BY_DEP[dep]
        if (framework) frameworks.add(framework)
      }
      for (const name of Object.keys(parsed?.scripts ?? {})) scripts.push(name)
      for (const field of ['main', 'module', 'bin']) {
        const value = parsed?.[field]
        if (typeof value === 'string' && pathSet.has(toPosix(value))) entryHints.add(toPosix(value))
      }
    } catch { /* 损坏的 package.json 不致命 */ }
  }
  for (const file of files) {
    const base = basename(file.path, file.extension)
    const index = file.path.lastIndexOf('/')
    const dir = index < 0 ? '.' : file.path.slice(0, index)
    if (dir !== 'src' && dir !== 'src/host' && dir !== 'src/client' && dir !== '.' && dir !== 'apps' && dir !== 'packages') continue
    if (['index', 'main', 'app', 'server', 'cli', 'entry'].includes(base) && TEXT_EXTS.has(file.extension)) entryHints.add(file.path)
  }
  return {
    languages: [...languages].sort(),
    frameworks: [...frameworks].sort(),
    packageManagers: [...packageManagers].sort(),
    configFiles: [...configFiles].sort(),
    entryHints: [...entryHints].slice(0, 40),
    scripts: scripts.slice(0, 40),
  }
}

/** 把索引写入 project_files（M4 增量更新据此判断新增/修改/删除）。 */
export function saveProjectIndex(db: Db, kbId: string, files: IndexedFile[]): { inserted: number; updated: number; removed: number } {
  const now = Date.now()
  const existingRows = all(db, 'SELECT path FROM project_files WHERE kb_id = ?', [kbId]).map((raw: any) => String(raw.path))
  const existing = new Set(existingRows)
  const seen = new Set<string>()
  let inserted = 0
  let updated = 0
  transaction(db, () => {
    for (const file of files) {
      seen.add(file.path)
      const already = existing.has(file.path)
      run(
        db,
        'INSERT INTO project_files (kb_id, path, size, language, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kb_id, path) DO UPDATE SET size = excluded.size, language = excluded.language, content_hash = excluded.content_hash, indexed_at = excluded.indexed_at',
        [kbId, file.path, file.size, file.language, file.hash, now],
      )
      if (already) updated += 1
      else inserted += 1
    }
    for (const path of existingRows) {
      if (!seen.has(path)) run(db, 'DELETE FROM project_files WHERE kb_id = ? AND path = ?', [kbId, path])
    }
  })
  return { inserted, updated, removed: existingRows.filter((path) => !seen.has(path)).length }
}

export function indexSummary(db: Db, kbId: string): { fileCount: number; hashedCount: number; byLanguage: Array<{ language: string; count: number }>; lastIndexedAt: string | null } {
  const rows = all(db, 'SELECT language, content_hash, indexed_at FROM project_files WHERE kb_id = ?', [kbId])
  const map = new Map<string, number>()
  let hashedCount = 0
  let latest = 0
  for (const raw of rows as any[]) {
    const language = String(raw.language ?? 'Other')
    map.set(language, (map.get(language) ?? 0) + 1)
    if (raw.content_hash !== null && raw.content_hash !== undefined) hashedCount += 1
    const at = Number(raw.indexed_at ?? 0)
    if (at > latest) latest = at
  }
  return {
    fileCount: rows.length,
    hashedCount,
    byLanguage: [...map.entries()].map(([language, count]) => ({ language, count })).sort((a, b) => b.count - a.count),
    lastIndexedAt: latest > 0 ? new Date(latest).toISOString() : null,
  }
}

export function listIndexedFiles(db: Db, kbId: string, limit = 200): Array<{ path: string; size: number; language: string; hash: string | null }> {
  const rows = all(db, 'SELECT path, size, language, content_hash FROM project_files WHERE kb_id = ? ORDER BY path ASC LIMIT ?', [kbId, Math.max(1, Math.min(1000, limit))])
  return (rows as any[]).map((raw) => ({ path: String(raw.path), size: Number(raw.size), language: String(raw.language ?? 'Other'), hash: raw.content_hash === null || raw.content_hash === undefined ? null : String(raw.content_hash) }))
}
