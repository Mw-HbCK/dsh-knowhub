/**
 * 审计补充测试（进程内运行；沙箱禁止子进程管道，不用 node --test runner）。
 * 覆盖审计缺口 A1（检索标签过滤 + 重复结果合并）与 A2（用户自定义排除目录真正生效）：
 *  - 标签过滤：AND 语义、大小写不敏感、最多 6 个；
 *  - 重复合并：内容哈希相同的命中只保留一条并记录被合并数量与来源库；
 *  - normalizeExcludeDirs / isExcludedPath 的合法化与拒绝规则；
 *  - 索引项目与扫描项目时 excludeDirs 真正生效（skippedExcluded 计数、文件不进入索引）；
 *  - 设置页写入的 excludeDirs 经 readSettings 读回后能被索引流程使用。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const { openDatabase } = await load('db/db.js')
const store = await load('kb/store.js')
const search = await load('search.js')
const settingsLib = await load('settings.js')
const scanLib = await load('scan.js')
const indexLib = await load('pipeline/index.js')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('  FAIL ' + name + ' → ' + (error instanceof Error ? error.message : String(error)))
  }
}

const rootPath = decodeURIComponent(new URL('../.build/test-data/refine-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const storageRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
await mkdir(storageRoot, { recursive: true })
const ws = join(storageRoot, 'workspace')
await mkdir(join(ws, 'src'), { recursive: true })
await mkdir(join(ws, 'generated'), { recursive: true })
await mkdir(join(ws, 'vendor', 'lib'), { recursive: true })
await writeFile(join(ws, 'src', 'a.ts'), 'export const a = 1\n')
await writeFile(join(ws, 'src', 'b.ts'), 'export const b = 2\n')
await writeFile(join(ws, 'generated', 'big.ts'), 'export const generated = true\n')
await writeFile(join(ws, 'vendor', 'lib', 'dep.ts'), 'export const dep = 1\n')

const db = openDatabase(storageRoot)
const kb = await store.createKnowledgeBase(db, { name: '排除目录与检索测试库', scope: 'workspace', workspaceId: 'ws-refine-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot, workspacePath: ws, workspaceTitle: 'Refine' })
const scopeKeys = ['user:*', 'ws:ws-refine-uuid']

const sharedBody = '# 重复内容哈希测试号\n\n这段正文用于验证内容哈希相同的多条知识在检索结果里被合并为一条，并记录被合并的数量。\n'
const taggedBody = '# 标签过滤测试\n\n这段正文带有一个英文标签，用于验证标签过滤大小写不敏感以及 AND 语义。\n'

const docOne = await search.createDocument(db, storageRoot, kb, { title: '重复条目一', kind: 'memory', body: sharedBody, status: 'approved', verifyState: 'observed' })
const docTwo = await search.createDocument(db, storageRoot, kb, { title: '重复条目二', kind: 'memory', body: sharedBody, status: 'approved', verifyState: 'observed' })
const tagged = await search.createDocument(db, storageRoot, kb, { title: '标签条目', kind: 'decision', body: taggedBody, status: 'approved', verifyState: 'observed', tags: ['Architecture', '自动提炼'] })
const untagged = await search.createDocument(db, storageRoot, kb, { title: '无标签条目', kind: 'memory', body: taggedBody.replace('标签过滤测试', '无标签测试'), status: 'approved', verifyState: 'observed' })

console.log('审计补充单测开始：' + storageRoot)

// ---------- A1：标签过滤 ----------
await test('标签过滤：单个标签命中，未带标签的文档被排除', () => {
  const result = search.searchDocuments(db, { query: '标签过滤', scopeKeys, tags: ['Architecture'], limit: 20 })
  const ids = result.hits.map((hit) => hit.id)
  assert.ok(ids.includes(tagged.id))
  assert.ok(!ids.includes(untagged.id))
})

await test('标签过滤：大小写不敏感', () => {
  const lower = search.searchDocuments(db, { query: '标签过滤', scopeKeys, tags: ['architecture'], limit: 20 })
  assert.deepEqual(lower.hits.map((hit) => hit.id), [tagged.id])
})

await test('标签过滤：AND 语义（多个标签必须同时命中）', () => {
  const both = search.searchDocuments(db, { query: '标签过滤', scopeKeys, tags: ['Architecture', '自动提炼'], limit: 20 })
  assert.deepEqual(both.hits.map((hit) => hit.id), [tagged.id])
  const missing = search.searchDocuments(db, { query: '标签过滤', scopeKeys, tags: ['Architecture', '不存在的标签'], limit: 20 })
  assert.equal(missing.hits.length, 0)
  assert.equal(missing.total, 0)
})

await test('标签过滤：最多 6 个标签，空标签被忽略', () => {
  const result = search.searchDocuments(db, { query: '标签过滤', scopeKeys, tags: ['', '  ', 'Architecture', '', '', '', '', ''], limit: 20 })
  assert.deepEqual(result.hits.map((hit) => hit.id), [tagged.id])
})

// ---------- A1：重复结果合并 ----------
await test('重复合并：内容哈希相同的两条知识只返回一条并记录合并数量', () => {
  assert.equal(docOne.contentHash, docTwo.contentHash)
  const result = search.searchDocuments(db, { query: '重复内容哈希', scopeKeys, limit: 20 })
  assert.equal(result.hits.length, 1, '合并后只应保留一条命中')
  assert.equal(result.duplicatesMerged, 1)
  const hit = result.hits[0]
  assert.ok(hit.id === docOne.id || hit.id === docTwo.id)
  assert.equal(hit.duplicates, 1)
  assert.deepEqual(hit.duplicateKbIds, [kb.id])
})

await test('重复合并：解析层都带 contentHash/duplicates 字段', () => {
  const result = search.searchDocuments(db, { query: '标签过滤', scopeKeys, limit: 20 })
  const hit = result.hits.find((item) => item.id === tagged.id)
  assert.ok(hit)
  assert.equal(typeof hit.contentHash, 'string')
  assert.equal(hit.duplicates, 0)
  assert.deepEqual(hit.duplicateKbIds, [])
  assert.equal(typeof result.duplicatesMerged, 'number')
})

// ---------- A2：排除目录规则 ----------
await test('normalizeExcludeDirs：合法化路径写法并去重', () => {
  const list = scanLib.normalizeExcludeDirs(['  Generated ', 'vendor\\lib', './cache/', 'docs/generated', 'generated', '', 42, null])
  assert.deepEqual(list, ['generated', 'vendor/lib', 'cache', 'docs/generated'])
})

await test('normalizeExcludeDirs：拒绝绝对路径、盘符、上跳与当前目录段', () => {
  assert.deepEqual(scanLib.normalizeExcludeDirs(['/etc', 'C:\\secret', '../escape', 'a/../b', '.', 'a/./b', 'ok']), ['ok'])
  assert.deepEqual(scanLib.normalizeExcludeDirs('not-an-array'), [])
  assert.equal(scanLib.normalizeExcludeDirs(new Array(60).fill('x')).length <= 40, true)
})

await test('isExcludedPath：目录名、子路径前缀，且不误伤同名文件', () => {
  assert.equal(scanLib.isExcludedPath('generated/big.ts', ['generated']), true)
  assert.equal(scanLib.isExcludedPath('vendor/lib/dep.ts', ['vendor']), true)
  assert.equal(scanLib.isExcludedPath('docs/generated/a.md', ['docs/generated']), true)
  assert.equal(scanLib.isExcludedPath('src/a.ts', ['generated']), false)
  assert.equal(scanLib.isExcludedPath('src/vendor.ts', ['vendor']), false)
})

// ---------- A2：索引与扫描真正生效 ----------
await test('扫描项目：excludeDirs 生效并计入 skippedExcluded', async () => {
  const plain = await scanLib.scanProject(ws)
  assert.ok(plain.sample.some((path) => path.includes('generated')))
  const filtered = await scanLib.scanProject(ws, { excludeDirs: ['generated'] })
  assert.equal(filtered.skippedExcluded, 1)
  assert.ok(!filtered.sample.some((path) => path.includes('generated')))
  assert.equal(filtered.fileCount, plain.fileCount - 1)
  assert.ok(filtered.excludedDirs.includes('generated'))
})

await test('索引项目：excludeDirs 生效，被排除文件不写入索引', async () => {
  const plain = await indexLib.indexProject(ws)
  const plainPaths = plain.files.map((file) => file.path)
  assert.ok(plainPaths.some((path) => path.includes('generated')))
  assert.ok(plainPaths.some((path) => path.includes('vendor')))
  const filtered = await indexLib.indexProject(ws, { excludeDirs: ['generated', 'vendor'] })
  const filteredPaths = filtered.files.map((file) => file.path)
  assert.ok(!filteredPaths.some((path) => path.includes('generated')))
  assert.ok(!filteredPaths.some((path) => path.includes('vendor')))
  assert.equal(filtered.skippedExcluded, 2)
  assert.ok(filtered.excludedDirs.includes('generated'))
  assert.ok(filtered.excludedDirs.includes('vendor'))
})

await test('设置页写入的 excludeDirs 经 readSettings 读回后能被索引流程使用', async () => {
  const written = settingsLib.writeSettings(db, { excludeDirs: ['vendor'] }, 'refine-test')
  assert.deepEqual(written.settings.excludeDirs, ['vendor'])
  const excludeDirs = settingsLib.readSettings(db).excludeDirs
  const filtered = await indexLib.indexProject(ws, { excludeDirs })
  assert.ok(!filtered.files.some((file) => file.path.includes('vendor')))
  assert.ok(filtered.files.some((file) => file.path.includes('generated')), '未列入设置的目录不应被排除')
  settingsLib.writeSettings(db, { excludeDirs: [] }, 'refine-test')
})

console.log('')
if (failures.length === 0) {
  console.log('审计补充单测全部通过：' + passed + ' 项')
  process.exit(0)
} else {
  console.error('失败 ' + failures.length + ' 项：')
  for (const failure of failures) console.error(' - ' + failure.name + '：' + (failure.error?.stack ?? failure.error))
  process.exit(1)
}
