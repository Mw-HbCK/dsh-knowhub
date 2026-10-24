/**
 * M1 验收测试（进程内运行，不使用 node --test：沙箱禁止子进程管道）。
 * 覆盖：知识库创建校验、持久化、重名、作用域、模型隔离、Markdown/SQLite 一致性、
 *       FTS5 trigram + LIKE 回退、检索作用域隔离、HTTP 路由层校验。
 */
import assert from 'node:assert/strict'
import { mkdir, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const { openDatabase, closeDatabase, schemaVersion, latestSchemaVersion } = await load('db/db.js')
const store = await load('kb/store.js')
const search = await load('search.js')
const { handleKbRequest } = await load('kb/route.js')

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

const root = new URL('../.build/test-data/m1-' + Date.now().toString(36) + '/', import.meta.url).pathname
const storageRoot = process.platform === 'win32' ? decodeURIComponent(root).replace(/^\//, '') : decodeURIComponent(root)
await mkdir(storageRoot, { recursive: true })

// ---- 模拟 DSH 服务（真实契约的最小替身，仅测试用） ----
const wsA = join(storageRoot, 'workspace-a')
const wsB = join(storageRoot, 'workspace-b')
await mkdir(wsA, { recursive: true })
await mkdir(wsB, { recursive: true })
const registry = {
  list: () => [
    { id: 'ws-a-uuid', title: '项目 A', path: wsA, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: [] },
    { id: 'ws-b-uuid', title: '项目 B', path: wsB, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: [] },
  ],
  get: (id) => registry.list().find((item) => item.id === id),
  resolveByPath: async (path) => registry.list().find((item) => item.path === path),
}
const llm = {
  listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }, { id: 'amd', name: 'Amd' }],
  listModels: async (provider) => provider === 'amd'
    ? [{ provider: 'amd', id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' }]
    : [{ provider, id: 'deepseek-flash', name: 'DeepSeek Flash' }, { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
}
const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : name === 'llm' ? llm : undefined) }
const config = { storageRoot }

function fakeReq(body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    async *[Symbol.asyncIterator]() {
      if (text !== '') yield Buffer.from(text, 'utf8')
    },
  }
}
function fakeRes() {
  const out = { status: 0, headers: null, body: null }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(buffer) { out.body = JSON.parse(String(buffer)) },
  }
}
async function call(method, path, { body, workspaceId } = {}) {
  const url = new URL('http://knowhub.internal' + path)
  if (workspaceId) url.searchParams.set('workspaceId', workspaceId)
  const res = fakeRes()
  const handled = await handleKbRequest({ ctx, config, method, path: url.pathname.replace(/^\/api/, ''), url, req: fakeReq(body), res })
  assert.equal(handled, true, '路由未处理：' + method + ' ' + path)
  return res.out
}

const db = openDatabase(storageRoot)
const userInput = { name: '团队通用规范', scope: 'user', modelProvider: 'deepseek-account', modelId: 'deepseek-flash', modelStrategy: 'balanced' }
const wsInput = { name: '项目 A 知识库', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'quality' }

await test('创建用户级知识库不需要工作区', async () => {
  const row = await store.createKnowledgeBase(db, userInput, { storageRoot })
  assert.equal(row.scope, 'user')
  assert.equal(row.workspaceId, null)
  assert.equal(row.scopeKey, 'user:*')
  assert.equal(row.status, 'created')
  const manifest = JSON.parse(await readFile(join(storageRoot, 'knowledge-bases', row.id, 'knowledge-base.json'), 'utf8'))
  assert.equal(manifest.modelId, 'deepseek-flash')
  assert.equal(manifest.scopeKey, 'user:*')
})

await test('名称必填且最多 50 个字符', async () => {
  assert.ok(store.validateKbInput({ ...userInput, name: '' }).includes('名称不能为空'))
  assert.ok(store.validateKbInput({ ...userInput, name: '带\u0007控制符' }).some((message) => message.includes('控制字符')))
  const fifty = '知'.repeat(50)
  assert.deepEqual(store.validateKbInput({ ...userInput, name: fifty }), [])
  assert.match(store.validateKbInput({ ...userInput, name: '知'.repeat(51) }).join('|'), /名称最多 50 个字符（当前 51 个）/)
  assert.equal(store.nameLength('知枢 KnowHub'), 10)
})

await test('工作区级知识库必须提供工作区 ID', async () => {
  assert.match(store.validateKbInput({ ...wsInput, workspaceId: '' }).join('|'), /必须选择工作区/)
  const row = await store.createKnowledgeBase(db, wsInput, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
  assert.equal(row.scopeKey, 'ws:ws-a-uuid')
  assert.equal(row.workspaceId, 'ws-a-uuid')
})

await test('同作用范围重名被拒绝，跨作用范围允许同名', async () => {
  await assert.rejects(() => store.createKnowledgeBase(db, userInput, { storageRoot }), (error) => error.code === 'KB_NAME_DUPLICATED')
  const other = await store.createKnowledgeBase(db, { ...userInput, name: '项目 A 知识库' }, { storageRoot })
  assert.equal(other.scope, 'user')
})

await test('两个知识库保存不同模型，修改其一不影响另一个', async () => {
  const rows = store.listAllKnowledgeBases(db)
  const userKb = rows.find((row) => row.scope === 'user' && row.name === '团队通用规范')
  const wsKb = rows.find((row) => row.scopeKey === 'ws:ws-a-uuid')
  assert.equal(userKb.modelId, 'deepseek-flash')
  assert.equal(wsKb.modelId, 'DeepSeek-V4-Flash')
  const updated = await store.updateKnowledgeBase(db, storageRoot, wsKb.id, { modelProvider: 'deepseek-account', modelId: 'deepseek-v4-pro', modelStrategy: 'economy' })
  assert.equal(updated.modelId, 'deepseek-v4-pro')
  const reloadedUser = store.getKnowledgeBase(db, userKb.id)
  assert.equal(reloadedUser.modelId, 'deepseek-flash')
  assert.equal(reloadedUser.modelStrategy, 'balanced')
  assert.equal(store.getKnowledgeBase(db, wsKb.id).modelStrategy, 'economy')
})

await test('重启（重新打开数据库）后配置仍在', async () => {
  closeDatabase(storageRoot)
  const reopened = openDatabase(storageRoot)
  const rows = store.listAllKnowledgeBases(reopened)
  assert.ok(rows.length >= 3)
  assert.equal(schemaVersion(reopened), latestSchemaVersion())
})

await test('Markdown 正文与数据库/FTS 一致（原子写 + 写前日志已清空）', async () => {
  const db2 = openDatabase(storageRoot)
  const kb = store.listAllKnowledgeBases(db2).find((row) => row.scopeKey === 'ws:ws-a-uuid')
  const doc = await search.createDocument(db2, storageRoot, kb, {
    title: '构建与测试方法',
    kind: 'wiki',
    body: '本项目使用 pnpm 构建，测试命令是 node tests/run-all.mjs。构建前需要先执行类型检查，避免类型错误进入产物。',
    tags: ['构建', '测试'],
    status: 'approved',
    verifyState: 'observed',
  })
  const fileText = await readFile(doc.path, 'utf8')
  assert.match(fileText, /^---\nid: doc_/)
  assert.match(fileText, /title: "构建与测试方法"/)
  assert.match(fileText, /pnpm 构建/)
  const intents = db2.raw.prepare('SELECT COUNT(*) AS n FROM write_intents WHERE doc_id = ?').get(doc.id)
  assert.equal(Number(intents.n), 0)
  const versionRow = db2.raw.prepare('SELECT COUNT(*) AS n FROM doc_versions WHERE doc_id = ?').get(doc.id)
  assert.equal(Number(versionRow.n), 1)
  const files = await readdir(join(storageRoot, 'knowledge-bases', kb.id, 'wiki'))
  assert.ok(files.some((name) => name.endsWith('.md')))
})

await test('全文检索：trigram 命中 3 字以上中文', async () => {
  const db3 = openDatabase(storageRoot)
  const result = search.searchDocuments(db3, { query: '构建与测试', scopeKeys: ['user:*', 'ws:ws-a-uuid'] })
  assert.equal(result.mode, 'fts')
  assert.ok(result.hits.length >= 1)
  assert.equal(result.hits[0].kbName !== undefined, true)
  assert.equal(result.hits[0].matchedBy, 'fts')
  assert.match(result.hits[0].snippet, /pnpm 构建/)
})

await test('全文检索：1–2 字回退 LIKE，且不越界到其他工作区', async () => {
  const db4 = openDatabase(storageRoot)
  const fallback = search.searchDocuments(db4, { query: '测试', scopeKeys: ['user:*', 'ws:ws-a-uuid'] })
  assert.equal(fallback.mode, 'like')
  assert.ok(fallback.hits.length >= 1)
  const isolated = search.searchDocuments(db4, { query: '构建', scopeKeys: ['ws:ws-b-uuid'] })
  assert.equal(isolated.hits.length, 0)
})

await test('检索可按知识库与类型过滤，且拒绝越权知识库', async () => {
  const db5 = openDatabase(storageRoot)
  const kb = store.listAllKnowledgeBases(db5).find((row) => row.scopeKey === 'ws:ws-a-uuid')
  const byKb = search.searchDocuments(db5, { query: '构建', scopeKeys: ['user:*', 'ws:ws-a-uuid'], kbId: kb.id, status: 'any' })
  assert.ok(byKb.hits.every((hit) => hit.kbId === kb.id))
  assert.throws(() => search.searchDocuments(db5, { query: '构建', scopeKeys: ['user:*'], kbId: kb.id, status: 'any' }), (error) => error.code === 'SEARCH_KB_FORBIDDEN')
})

await test('HTTP：创建知识库校验工作区、模型与重名', async () => {
  const badWs = await call('POST', '/kb', { body: { ...wsInput, workspaceId: 'not-exist' } })
  assert.equal(badWs.status, 400)
  assert.equal(badWs.body.error.code, 'WORKSPACE_NOT_FOUND')
  const badModel = await call('POST', '/kb', { body: { ...userInput, name: '非法模型库', modelId: 'not-a-model' } })
  assert.equal(badModel.status, 400)
  assert.equal(badModel.body.error.code, 'MODEL_NOT_AVAILABLE')
  const duplicate = await call('POST', '/kb', { body: userInput })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.body.error.code, 'KB_NAME_DUPLICATED')
  const created = await call('POST', '/kb', { body: { ...userInput, name: 'HTTP 创建的用户库' } })
  assert.equal(created.status, 200)
  assert.equal(created.body.ok, true)
  assert.equal(created.body.value.knowledgeBase.name, 'HTTP 创建的用户库')
  assert.equal(created.body.value.nextAction, 'start-initialize')
})

await test('HTTP：列表按作用域隔离，工作区级只出现当前工作区', async () => {
  const current = await call('GET', '/current-workspace')
  assert.equal(current.status, 200)
  assert.equal(current.body.value.workspaceId, null, '测试进程工作目录不属于任何模拟工作区')
  const listed = await call('GET', '/kb')
  assert.equal(listed.status, 200)
  assert.ok(listed.body.value.knowledgeBases.every((row) => row.scope === 'user'))
  const scoped = await call('GET', '/kb', { workspaceId: 'ws-a-uuid' })
  assert.ok(scoped.body.value.knowledgeBases.some((row) => row.scopeKey === 'ws:ws-a-uuid'))
})

await test('HTTP：PATCH 修改模型只影响目标知识库', async () => {
  const listed = await call('GET', '/kb', { workspaceId: 'ws-a-uuid' })
  const target = listed.body.value.knowledgeBases.find((row) => row.scopeKey === 'ws:ws-a-uuid')
  const patched = await call('PATCH', '/kb/' + target.id, { body: { modelId: 'deepseek-v4-pro', modelProvider: 'deepseek-account', modelStrategy: 'quality' } })
  assert.equal(patched.status, 200)
  const detail = await call('GET', '/kb/' + target.id)
  assert.equal(detail.body.value.knowledgeBase.modelId, 'deepseek-v4-pro')
  const badModelPatch = await call('PATCH', '/kb/' + target.id, { body: { modelProvider: 'amd', modelId: '不存在' } })
  assert.equal(badModelPatch.status, 400)
  assert.equal(badModelPatch.body.error.code, 'MODEL_NOT_AVAILABLE')
})

await test('HTTP：删除模式 config / files / all 语义不同', async () => {
  const created = await call('POST', '/kb', { body: { ...userInput, name: '待删除知识库' } })
  const id = created.body.value.knowledgeBase.id
  const configOnly = await call('DELETE', '/kb/' + id + '?mode=config')
  assert.equal(configOnly.status, 200)
  assert.equal(configOnly.body.value.result.rowDeleted, true)
  assert.equal(configOnly.body.value.result.filesDeleted, false)
  const gone = await call('GET', '/kb/' + id)
  assert.equal(gone.status, 404)
})

await rm(join(storageRoot, 'knowledge-bases'), { recursive: true, force: true }).catch(() => undefined)

console.log('')
console.log('M1 测试：' + passed + ' 通过，' + failures.length + ' 失败')
if (failures.length > 0) {
  for (const failure of failures) console.log('失败用例：' + failure.name + '\n' + (failure.error?.stack ?? String(failure.error)))
  process.exitCode = 1
}
