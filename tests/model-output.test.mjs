/**
 * 0.8.7 加固测试：模型输出被截断（finish=max-tokens）时识别 + 加倍 token 预算自动重试一次，
 * 以及持续截断时给出可操作的错误信息。
 * 进程内运行（沙箱禁止子进程管道）；llm 为真实契约的最小替身。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const { openDatabase, all } = await load('db/db.js')
const store = await load('kb/store.js')
const search = await load('search.js')
const { handleKbRequest } = await load('kb/route.js')
const { MAX_OUTPUT_ATTEMPTS, parseModelJson, retryTokenBudget } = await load('pipeline/model-output.js')

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

const rootPath = decodeURIComponent(new URL('../.build/test-data/model-output-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const storageRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
await mkdir(storageRoot, { recursive: true })
const ws = join(storageRoot, 'workspace')
await mkdir(join(ws, 'src'), { recursive: true })
await writeFile(join(ws, 'package.json'), JSON.stringify({ name: 'demo-project', version: '1.0.0', scripts: { build: 'tsc' }, dependencies: { react: '^18.0.0' }, devDependencies: { typescript: '^5.0.0' } }, null, 2))
await writeFile(join(ws, 'README.md'), '# Demo 项目\n\n用于 0.8.7 截断重试测试的示例仓库。\n')
await writeFile(join(ws, 'src', 'index.ts'), 'export function hello(name: string): string { return "你好，" + name }\n')

const registry = {
  list: () => [{ id: 'ws-out-uuid', title: '输出测试', path: ws, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: [] }],
  get: (id) => registry.list().find((item) => item.id === id),
  resolveByPath: async (path) => registry.list().find((item) => item.path === path),
}

const llmState = { mode: 'good', calls: [] }
const TRUNCATED_TEXT = '{"documents":[{"title":"项目总览","kind":"wiki","body":"该项目是用于模型输出截断测试的示例仓库，正文还没写完'

function goodPayload() {
  return JSON.stringify({
    documents: [{
      title: '项目总览',
      kind: 'wiki',
      tags: ['总览'],
      confidence: 0.8,
      sources: ['package.json', 'README.md'],
      body: '该项目是用于模型输出截断重试测试的示例仓库，包含 package.json、README.md 与 src/index.ts 三个文件。',
      uncertain: [],
    }],
  })
}

const llm = {
  listProviders: () => [{ id: 'amd', name: 'Amd' }],
  listModels: async (provider) => [{ provider, id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' }],
  stream: (options) => ({
    async *[Symbol.asyncIterator]() {
      const index = llmState.calls.length
      llmState.calls.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens })
      const truncated = llmState.mode === 'truncated-always' || (llmState.mode === 'truncated-once' && index === 0)
      if (truncated) {
        // 模拟推理模型：思考占满预算，正文 JSON 没写完就因 max-tokens 结束。
        yield { type: 'reasoning-delta', index: 0, text: '思考过程'.repeat(80) }
        yield { type: 'text-delta', index: 0, text: TRUNCATED_TEXT }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: goodPayload() }
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 300 } }
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
async function waitTask(taskId, timeoutMs = 30000) {
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

await test('纯函数：截断识别、可操作错误信息与预算加倍', async () => {
  assert.equal(MAX_OUTPUT_ATTEMPTS, 2, '首次 + 重试一次')
  assert.equal(retryTokenBudget(1600), 3200)
  assert.equal(retryTokenBudget(2200), 4400)
  assert.equal(retryTokenBudget(8000), 8192, '重试预算不超过 runModelCall 上限')

  const noJson = parseModelJson('抱歉，我无法输出 JSON。', { finishKind: 'stop', maxTokens: 1600, attempt: 1 })
  assert.equal(noJson.ok, false)
  assert.equal(noJson.code, 'MODEL_OUTPUT_INVALID')
  assert.match(noJson.message, /没有 JSON 对象/)

  const truncated = parseModelJson(TRUNCATED_TEXT, { finishKind: 'max-tokens', maxTokens: 1600, attempt: 1, reasoningChars: 320 })
  assert.equal(truncated.ok, false)
  assert.equal(truncated.code, 'MODEL_OUTPUT_TRUNCATED')
  assert.equal(truncated.truncated, true)
  assert.match(truncated.message, /1600 tokens 上限/)
  assert.match(truncated.message, /非推理模型/)
  assert.match(truncated.message, /思考过程 320 字符/)

  const fenced = parseModelJson('说明文字\n```json\n{"documents":[{"title":"A"}]}\n```\n结束', { finishKind: 'stop', maxTokens: 1600, attempt: 1 })
  assert.equal(fenced.ok, true)
  assert.equal(fenced.value.documents[0].title, 'A')

  const brokenJson = parseModelJson('{"documents": [}', { finishKind: 'max-tokens', maxTokens: 3200, attempt: 2 })
  assert.equal(brokenJson.ok, false)
  assert.equal(brokenJson.code, 'MODEL_OUTPUT_TRUNCATED')
  assert.match(brokenJson.message, /JSON 解析失败/)
})

await test('初始化：模型输出被截断时加倍预算自动重试一次并成功', async () => {
  const kb = await store.createKnowledgeBase(db, { name: '截断重试验证', scope: 'workspace', workspaceId: 'ws-out-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: ws, workspaceTitle: '输出测试' })
  llmState.mode = 'truncated-once'
  llmState.calls = []
  const started = await call('POST', '/kb/' + kb.id + '/initialize', { body: {} })
  assert.equal(started.status, 200)
  const task = await waitTask(started.body.value.task.id)
  assert.equal(task.status, 'succeeded', JSON.stringify(task.errorCode ?? '') + ' ' + JSON.stringify(task.errorDetail ?? ''))
  assert.equal(llmState.calls.length, 2, '应调用两次：首次截断 + 加倍预算重试')
  assert.equal(llmState.calls[0].maxTokens, 1600, 'economy 策略首次预算')
  assert.equal(llmState.calls[1].maxTokens, 3200, '截断后预算翻倍')
  const logs = (task.logs ?? []).map((item) => String(item.message)).join('\n')
  assert.match(logs, /截断/)
  const calls = all(db, 'SELECT * FROM llm_calls WHERE kb_id = ? ORDER BY rowid', [kb.id])
  assert.equal(calls.length, 2, '每次尝试都要写入 llm_calls')
  const docs = search.listDocuments(db, { kbIds: [kb.id] })
  assert.equal(docs.length, 1)
  assert.equal(docs[0].status, 'draft')
  assert.equal(store.getKnowledgeBase(db, kb.id).status, 'ready')
  llmState.mode = 'good'
})

await test('初始化：持续截断时任务失败，并给出换模型/调策略的可操作建议', async () => {
  const kb = await store.createKnowledgeBase(db, { name: '持续截断验证', scope: 'workspace', workspaceId: 'ws-out-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot, workspacePath: ws, workspaceTitle: '输出测试' })
  llmState.mode = 'truncated-always'
  llmState.calls = []
  const started = await call('POST', '/kb/' + kb.id + '/initialize', { body: {} })
  const task = await waitTask(started.body.value.task.id)
  assert.equal(task.status, 'failed')
  assert.equal(task.errorCode, 'MODEL_OUTPUT_TRUNCATED')
  assert.match(String(task.errorDetail ?? ''), /输出被截断/)
  assert.match(String(task.errorDetail ?? ''), /非推理模型/)
  assert.match(String(task.errorDetail ?? ''), /模型使用策略/)
  assert.equal(llmState.calls.length, 2, '最多尝试两次，不做无限重试')
  assert.deepEqual(llmState.calls.map((entry) => entry.maxTokens), [2200, 4400])
  assert.equal(search.listDocuments(db, { kbIds: [kb.id] }).length, 0, '失败时不应留下半成品知识')
  assert.equal(store.getKnowledgeBase(db, kb.id).status, 'error')
  llmState.mode = 'good'
})

console.log('')
console.log(failures.length === 0 ? 'ALL PASS（' + passed + ' 项）' : 'FAILED（' + failures.length + ' 项失败，' + passed + ' 项通过）')
if (failures.length > 0) {
  for (const failure of failures) {
    console.log('')
    console.log('FAIL: ' + failure.name)
    console.log(failure.error instanceof Error ? (failure.error.stack ?? failure.error.message) : String(failure.error))
  }
  process.exitCode = 1
}
