/**
 * M2 验收测试（进程内运行；沙箱禁止子进程管道，故不用 node --test 的 runner）。
 * 覆盖：项目索引与排除规则、初始化任务全链路、绑定模型真实调用（llm_calls 铁证）、
 *       模型隔离、非法模型输出回退、重复任务防护、取消、重试、已批准知识不被静默覆盖、模型失效不调用。
 * 说明：ctx/llm 为“真实契约的最小替身”，仅测试用；生产路径使用 DSH 真实 ctx.llm.stream。
 */
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const { openDatabase, closeDatabase, all, get, run } = await load('db/db.js')
const store = await load('kb/store.js')
const search = await load('search.js')
const pipeline = await load('pipeline/index.js')
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

const rootPath = decodeURIComponent(new URL('../.build/test-data/m2-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const storageRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
await mkdir(storageRoot, { recursive: true })

// ---- 构造一个真实的小项目目录（用于扫描/索引）----
const wsA = join(storageRoot, 'workspace-a')
await mkdir(join(wsA, 'src'), { recursive: true })
await mkdir(join(wsA, 'node_modules', 'left-pad'), { recursive: true })
await writeFile(join(wsA, 'package.json'), JSON.stringify({ name: 'demo-project', version: '1.0.0', scripts: { build: 'tsc', test: 'node test.mjs' }, dependencies: { react: '^18.0.0' }, devDependencies: { typescript: '^5.0.0' } }, null, 2))
await writeFile(join(wsA, 'package-lock.json'), JSON.stringify({ name: 'demo-project', lockfileVersion: 3 }, null, 2))
await writeFile(join(wsA, 'README.md'), '# Demo 项目\n\n用于 M2 初始化测试的示例仓库。\n')
await writeFile(join(wsA, 'src', 'index.ts'), 'export function hello(name: string): string { return "你好，" + name }\n')
await writeFile(join(wsA, 'src', 'router.ts'), 'export const routes = ["/home", "/about"]\n')
await writeFile(join(wsA, 'src', 'styles.css'), 'body { margin: 0 }\n')
await writeFile(join(wsA, '.env'), 'API_KEY=should-not-be-indexed\n')
await writeFile(join(wsA, 'node_modules', 'left-pad', 'index.js'), 'module.exports = () => {}\n')

const wsB = join(storageRoot, 'workspace-b')
await mkdir(wsB, { recursive: true })
await writeFile(join(wsB, 'main.py'), 'print("hello")\n')

const registry = {
  list: () => [
    { id: 'ws-a-uuid', title: '项目 A', path: wsA, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: [] },
    { id: 'ws-b-uuid', title: '项目 B', path: wsB, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: [] },
  ],
  get: (id) => registry.list().find((item) => item.id === id),
  resolveByPath: async (path) => registry.list().find((item) => item.path === path),
}

// ---- 可编程的 llm 替身：真实记录 provider/model/maxTokens 与是否被调用 ----
const llmState = { mode: 'good', delayMs: 0, calls: [] }

function documentsPayload() {
  return JSON.stringify({
    documents: [
      {
        title: '项目总览',
        kind: 'wiki',
        tags: ['总览', 'M2'],
        confidence: 0.82,
        sources: ['package.json', 'README.md'],
        body: '该项目是一个 React + TypeScript 的示例仓库，入口为 src/index.ts，包含路由与样式模块。',
        uncertain: ['未发现测试用例目录，测试覆盖情况待确认'],
      },
      {
        title: '核心模块说明',
        kind: 'wiki',
        tags: ['模块'],
        confidence: 0.6,
        sources: ['src/index.ts', '不存在的文件.ts'],
        body: 'src/index.ts 导出 hello 函数；src/router.ts 维护路由表；src/styles.css 提供基础样式。',
        uncertain: [],
      },
    ],
  })
}

function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); resolve(); return }
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    }
  })
}

const llm = {
  listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }, { id: 'amd', name: 'Amd' }],
  listModels: async (provider) => provider === 'amd'
    ? [{ provider: 'amd', id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' }]
    : [
        { provider, id: 'deepseek-flash', name: 'DeepSeek Flash' },
        { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
  stream: (options) => ({
    async *[Symbol.asyncIterator]() {
      llmState.calls.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens, system: options.system ?? '' })
      if (llmState.delayMs > 0) await abortableSleep(llmState.delayMs, options.signal)
      if (options.signal && options.signal.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '用户取消', code: 'ABORTED' } } }
        return
      }
      const text = llmState.mode === 'bad-json' ? '抱歉，我无法按要求输出 JSON。' : documentsPayload()
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'usage', usage: { inputTokens: 1000, outputTokens: 500 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }),
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
async function waitTask(taskId, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await call('GET', '/tasks/' + taskId)
    if (value.status === 200) {
      const task = value.body.value.task
      if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return task
    }
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error('等待任务超时：' + taskId)
}

const db = openDatabase(storageRoot)

await test('项目索引：排除 node_modules / .env，识别语言与包管理器', async () => {
  const index = await pipeline.indexProject(wsA)
  const paths = index.files.map((file) => file.path.replace(/\\/g, '/'))
  assert.ok(paths.includes('package.json'))
  assert.ok(paths.includes('src/index.ts'))
  assert.ok(!paths.some((path) => path.startsWith('node_modules/')), 'node_modules 不应被索引')
  assert.ok(!paths.some((path) => path.endsWith('.env')), '.env 不应被索引')
  assert.ok(index.stack.languages.includes('TypeScript'))
  assert.ok(index.stack.frameworks.includes('React'))
  assert.ok(index.stack.packageManagers.includes('npm'))
  const saved = pipeline.saveProjectIndex(db, 'kb-index-probe', index.files)
  assert.equal(saved.inserted, index.files.length)
  const summary = pipeline.indexSummary(db, 'kb-index-probe')
  assert.equal(summary.fileCount, index.files.length)
  assert.ok(summary.hashedCount > 0, '文本文件应计算内容哈希')
  assert.ok(index.files.every((file) => typeof file.path === 'string' && file.path.length > 0))
  const removed = pipeline.saveProjectIndex(db, 'kb-index-probe', index.files.filter((file) => file.path !== 'README.md'))
  assert.equal(removed.removed, 1)
})

const kbA = await store.createKnowledgeBase(db, { name: '项目 A 初始化', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
const kbB = await store.createKnowledgeBase(db, { name: '项目 A 第二模型', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'deepseek-account', modelId: 'deepseek-v4-pro', modelStrategy: 'economy' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })

await test('初始化成功：绑定模型被真实调用、生成草稿 Wiki、记录来源与 llm_calls', async () => {
  llmState.mode = 'good'; llmState.delayMs = 0; llmState.calls = []
  const started = await call('POST', '/kb/' + kbA.id + '/initialize', { body: {} })
  assert.equal(started.status, 200)
  const taskId = started.body.value.task.id
  const task = await waitTask(taskId)
  assert.equal(task.status, 'succeeded', JSON.stringify(task.errorDetail ?? task.errorCode))
  assert.equal(task.progress, 100)
  assert.ok(Array.isArray(task.logs) && task.logs.length > 0, '任务应有日志')
  const docs = search.listDocuments(db, { kbIds: [kbA.id] })
  assert.equal(docs.length, 2)
  assert.ok(docs.every((doc) => doc.status === 'draft'), '生成内容必须是待审核草稿')
  const overview = docs.find((doc) => doc.title === '项目总览')
  assert.ok(overview, '应生成项目总览')
  const sources = all(db, 'SELECT * FROM sources WHERE doc_id = ?', [overview.id])
  assert.ok(sources.length >= 2, 'Wiki 应关联来源文件')
  assert.ok(sources.every((source) => source.kind === 'file'))
  const calls = all(db, 'SELECT * FROM llm_calls WHERE kb_id = ? ORDER BY id', [kbA.id])
  assert.equal(calls.length, 2, 'balanced 策略应产生 2 次模型调用')
  assert.ok(calls.every((entry) => entry.provider === 'amd' && entry.model === 'DeepSeek-V4-Flash'))
  assert.ok(calls.every((entry) => entry.purpose === 'wiki-overview' || entry.purpose === 'wiki-architecture'))
  assert.ok(calls.every((entry) => entry.prompt_tokens === 1000 && entry.completion_tokens === 500))
  const kbRow = store.getKnowledgeBase(db, kbA.id)
  assert.equal(kbRow.status, 'ready')
  assert.ok(llmState.calls.length === 2 && llmState.calls.every((entry) => entry.provider === 'amd' && entry.model === 'DeepSeek-V4-Flash'))
})

await test('模型隔离：第二个知识库用另一个模型，互不影响', async () => {
  llmState.mode = 'good'; llmState.delayMs = 0; llmState.calls = []
  const started = await call('POST', '/kb/' + kbB.id + '/initialize', { body: {} })
  const taskId = started.body.value.task.id
  const task = await waitTask(taskId)
  assert.equal(task.status, 'succeeded')
  const calls = all(db, 'SELECT * FROM llm_calls WHERE kb_id = ? ORDER BY id', [kbB.id])
  assert.equal(calls.length, 1, 'economy 策略应只调用 1 次模型')
  assert.equal(calls[0].provider, 'deepseek-account')
  assert.equal(calls[0].model, 'deepseek-v4-pro')
  assert.ok(llmState.calls.every((entry) => entry.provider === 'deepseek-account' && entry.model === 'deepseek-v4-pro'))
  const first = all(db, 'SELECT * FROM llm_calls WHERE kb_id = ?', [kbA.id])
  assert.equal(first.length, 2)
  assert.ok(first.every((entry) => entry.model === 'DeepSeek-V4-Flash'))
})

await test('已批准的同主题知识不会被静默覆盖，只记为冲突', async () => {
  const kbConflict = await store.createKnowledgeBase(db, { name: '冲突验证', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
  const approved = await search.createDocument(db, storageRoot, kbConflict, { title: '项目总览', kind: 'wiki', body: '这是人工批准过的项目总览，必须保留。', status: 'approved', verifyState: 'observed', confidence: 1 })
  const before = search.getDocument(db, approved.id)
  llmState.mode = 'good'; llmState.delayMs = 0; llmState.calls = []
  const started = await call('POST', '/kb/' + kbConflict.id + '/initialize', { body: {} })
  const task = await waitTask(started.body.value.task.id)
  assert.equal(task.status, 'succeeded')
  const after = search.getDocument(db, approved.id)
  assert.equal(after.body, before.body)
  assert.equal(after.status, 'approved')
  assert.equal(after.currentVersion, before.currentVersion, '已批准内容不应产生新版本')
  const row = get(db, 'SELECT * FROM tasks WHERE id = ?', [task.id])
  assert.ok(String(row.cursor ?? '').includes('conflict'), '任务结果应记录冲突')
  const drafts = search.listDocuments(db, { kbIds: [kbConflict.id] })
  assert.ok(drafts.filter((doc) => doc.title === '项目总览' && doc.status === 'draft').length === 0, '不应再生成同名草稿')
})

await test('非法模型输出：任务失败、不写入任何知识、知识库状态置为 error', async () => {
  const kbC = await store.createKnowledgeBase(db, { name: '非法输出验证', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
  llmState.mode = 'bad-json'; llmState.delayMs = 0
  const started = await call('POST', '/kb/' + kbC.id + '/initialize', { body: {} })
  const task = await waitTask(started.body.value.task.id)
  assert.equal(task.status, 'failed')
  assert.equal(task.errorCode, 'MODEL_OUTPUT_INVALID')
  assert.equal(search.listDocuments(db, { kbIds: [kbC.id] }).length, 0)
  assert.equal(store.getKnowledgeBase(db, kbC.id).status, 'error')
  llmState.mode = 'good'
})

await test('重复任务防护：运行中再次启动返回 duplicate，不创建第二个任务', async () => {
  const kbDup = await store.createKnowledgeBase(db, { name: '重复任务验证', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
  llmState.mode = 'good'; llmState.delayMs = 800; llmState.calls = []
  const first = await call('POST', '/kb/' + kbDup.id + '/initialize', { body: {} })
  const second = await call('POST', '/kb/' + kbDup.id + '/initialize', { body: {} })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(second.body.value.duplicate, true)
  assert.equal(second.body.value.task.id, first.body.value.task.id)
  const task = await waitTask(first.body.value.task.id)
  assert.equal(task.status, 'succeeded')
  llmState.delayMs = 0
})

await test('取消运行中的初始化任务', async () => {
  const kbD = await store.createKnowledgeBase(db, { name: '取消验证', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
  llmState.mode = 'good'; llmState.delayMs = 3000
  const started = await call('POST', '/kb/' + kbD.id + '/initialize', { body: {} })
  const taskId = started.body.value.task.id
  await new Promise((resolve) => setTimeout(resolve, 200))
  const cancelled = await call('POST', '/tasks/' + taskId + '/cancel', { body: {} })
  assert.equal(cancelled.status, 200)
  const task = await waitTask(taskId)
  assert.equal(task.status, 'cancelled')
  assert.equal(search.listDocuments(db, { kbIds: [kbD.id] }).length, 0, '取消后不应留下半成品知识')
  assert.equal(store.getKnowledgeBase(db, kbD.id).status, 'created')
  llmState.delayMs = 0
})

await test('失败后重试：新任务 attempt+1 并成功生成知识', async () => {
  const kbE = await store.createKnowledgeBase(db, { name: '重试验证', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
  llmState.mode = 'bad-json'
  const bad = await call('POST', '/kb/' + kbE.id + '/initialize', { body: {} })
  const failedTask = await waitTask(bad.body.value.task.id)
  assert.equal(failedTask.status, 'failed')
  llmState.mode = 'good'
  const retried = await call('POST', '/tasks/' + failedTask.id + '/retry', { body: {} })
  assert.equal(retried.status, 200)
  const newTaskId = retried.body.value.task.id
  assert.notEqual(newTaskId, failedTask.id)
  const retryTask = await waitTask(newTaskId)
  assert.equal(retryTask.status, 'succeeded')
  assert.equal(retryTask.attempt, 2)
  assert.ok(search.listDocuments(db, { kbIds: [kbE.id] }).length > 0)
})

await test('模型失效：拒绝初始化且不产生任何模型调用', async () => {
  const kbF = await store.createKnowledgeBase(db, { name: '模型失效验证', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
  run(db, 'UPDATE knowledge_bases SET model_id = ? WHERE id = ?', ['no-such-model', kbF.id])
  llmState.calls = []
  const started = await call('POST', '/kb/' + kbF.id + '/initialize', { body: {} })
  const task = await waitTask(started.body.value.task.id)
  assert.equal(task.status, 'failed')
  assert.equal(task.errorCode, 'MODEL_NOT_AVAILABLE')
  assert.equal(llmState.calls.length, 0, '模型失效时不得调用任何模型（更不得静默切换）')
  assert.equal(search.listDocuments(db, { kbIds: [kbF.id] }).length, 0)
})

await test('用户级知识库初始化必须显式指定工作区', async () => {
  const kbUser = await store.createKnowledgeBase(db, { name: '用户级初始化', scope: 'user', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot })
  const missing = await call('POST', '/kb/' + kbUser.id + '/initialize', { body: {} })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'WORKSPACE_REQUIRED')
  llmState.mode = 'good'; llmState.delayMs = 0; llmState.calls = []
  const started = await call('POST', '/kb/' + kbUser.id + '/initialize', { body: { workspaceId: 'ws-a-uuid' } })
  assert.equal(started.status, 200)
  const task = await waitTask(started.body.value.task.id)
  assert.equal(task.status, 'succeeded')
  assert.ok(llmState.calls.length === 1)
})

await test('索引与模型调用可通过 HTTP 读取（供面板展示真实数据）', async () => {
  const files = await call('GET', '/kb/' + kbA.id + '/files')
  assert.equal(files.status, 200)
  assert.ok(files.body.value.summary.fileCount > 0)
  assert.ok(files.body.value.files.length > 0)
  const calls = await call('GET', '/kb/' + kbA.id + '/llm-calls')
  assert.equal(calls.status, 200)
  assert.ok(calls.body.value.calls.length >= 2)
  assert.equal(calls.body.value.calls[0].model, 'DeepSeek-V4-Flash')
  const tasks = await call('GET', '/kb/' + kbA.id + '/tasks')
  assert.equal(tasks.status, 200)
  assert.ok(tasks.body.value.count >= 1)
  const missing = await call('GET', '/kb/not-exist-id/tasks')
  assert.equal(missing.status, 404)
})

closeDatabase(storageRoot)
await rm(storageRoot, { recursive: true, force: true })

console.log('')
console.log('M2 测试：' + passed + ' 通过，' + failures.length + ' 失败')
for (const failure of failures) {
  console.log('--- ' + failure.name)
  console.log(failure.error && failure.error.stack ? failure.error.stack : String(failure.error))
}
process.exit(failures.length === 0 ? 0 : 1)
