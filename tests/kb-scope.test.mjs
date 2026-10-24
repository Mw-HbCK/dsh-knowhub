/**
 * 知识库作用域回归测试（进程内运行）。
 * 背景：面板只按「宿主进程 cwd 反查出的当前工作区」列知识库，而创建时允许绑定任意工作区
 * → 建到别的工作区的知识库在列表里看不见，再用同名新建却报「已存在」。
 * 覆盖：GET /kb 默认按当前工作区、?all=1 管理面全量、?workspaceId= 指定工作区、
 *       同名冲突提示带上作用范围与既有 id、不同工作区同名允许、未知工作区 400。
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const rootPath = decodeURIComponent(new URL('../.build/test-data/kb-scope-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const testRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
const storageRoot = join(testRoot, 'storage')
const dshHome = join(testRoot, 'dsh-home')
await mkdir(storageRoot, { recursive: true })
await mkdir(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome

const { openDatabase } = await load('db/db.js')
const store = await load('kb/store.js')
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

const db = openDatabase(storageRoot)
const config = { storageRoot }

// 依赖注入替身：当前进程路径反查到 A 工作区，注册表里另有 B 工作区。
const workspaces = [
  { id: 'ws-a', path: testRoot + '/ws-a', title: 'A 工作区', sessionIds: [] },
  { id: 'ws-b', path: testRoot + '/ws-b', title: 'B 工作区', sessionIds: [] },
]
const registry = {
  list: () => workspaces,
  get: (id) => workspaces.find((item) => item.id === id),
  resolveByPath: async () => workspaces[0],
}
const ctx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }

function fakeRes() {
  const out = { status: 0, headers: {}, body: null, text: null }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers ?? {} },
    end(buffer) {
      const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
      out.text = text
      try { out.body = JSON.parse(text) } catch { out.body = null }
    },
  }
}
async function call(method, path) {
  const url = new URL('http://knowhub.internal' + path)
  const res = fakeRes()
  const handled = await handleKbRequest({ ctx, config, method, path: url.pathname.replace(/^\/api/, ''), url, req: { async *[Symbol.asyncIterator]() {} }, res })
  assert.equal(handled, true, '路由未处理：' + method + ' ' + path)
  return res.out
}

const kbA = await store.createKnowledgeBase(db, { name: 'A 项目知识库', scope: 'workspace', workspaceId: 'ws-a', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: workspaces[0].path, workspaceTitle: workspaces[0].title })
const kbB = await store.createKnowledgeBase(db, { name: 'B 项目知识库', scope: 'workspace', workspaceId: 'ws-b', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: workspaces[1].path, workspaceTitle: workspaces[1].title })
const kbUser = await store.createKnowledgeBase(db, { name: '跨项目通用知识库', scope: 'user', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot })

console.log('知识库作用域测试开始：' + testRoot)

await test('GET /kb 默认只返回 cwd 反查工作区 + 用户级的知识库', async () => {
  const response = await call('GET', '/kb')
  assert.equal(response.status, 200)
  const ids = response.body.value.knowledgeBases.map((item) => item.id)
  assert.ok(ids.includes(kbA.id), '应包含当前工作区 A 的库')
  assert.ok(ids.includes(kbUser.id), '应包含用户级库')
  assert.ok(!ids.includes(kbB.id), '不应包含别的工作区 B 的库')
  assert.equal(response.body.value.workspaceId, 'ws-a')
})

await test('GET /kb?all=1 管理面返回全部工作区的知识库并带工作区名', async () => {
  const response = await call('GET', '/kb?all=1')
  assert.equal(response.status, 200)
  const value = response.body.value
  assert.equal(value.all, true)
  assert.equal(value.count, 3)
  const ids = value.knowledgeBases.map((item) => item.id)
  assert.ok(ids.includes(kbA.id) && ids.includes(kbB.id) && ids.includes(kbUser.id))
  const rowB = value.knowledgeBases.find((item) => item.id === kbB.id)
  assert.equal(rowB.workspaceTitle, 'B 工作区')
  assert.equal(rowB.scope, 'workspace')
})

await test('GET /kb?workspaceId=ws-b 只返回该工作区与用户级', async () => {
  const response = await call('GET', '/kb?workspaceId=ws-b')
  assert.equal(response.status, 200)
  const ids = response.body.value.knowledgeBases.map((item) => item.id)
  assert.ok(ids.includes(kbB.id) && ids.includes(kbUser.id))
  assert.ok(!ids.includes(kbA.id))
})

await test('GET /kb?workspaceId=不存在 返回 400 WORKSPACE_NOT_FOUND', async () => {
  const response = await call('GET', '/kb?workspaceId=ws-missing')
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'WORKSPACE_NOT_FOUND')
})

await test('同名冲突提示带上作用范围与既有 id，不同工作区允许同名', async () => {
  let duplicated = null
  try {
    await store.createKnowledgeBase(db, { name: 'B 项目知识库', scope: 'workspace', workspaceId: 'ws-b', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspaceTitle: 'B 工作区' })
  } catch (error) {
    duplicated = error
  }
  assert.ok(duplicated, '同工作区同名应被拒绝')
  assert.equal(duplicated.code, 'KB_NAME_DUPLICATED')
  assert.match(duplicated.message, /工作区级 · B 工作区/)
  assert.match(duplicated.message, new RegExp(kbB.id))
  // 同名的用户级库与工作区库互不冲突
  const userSame = await store.createKnowledgeBase(db, { name: 'B 项目知识库', scope: 'user', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot })
  assert.ok(userSame.id)
  const againUser = await (async () => { try { await store.createKnowledgeBase(db, { name: 'B 项目知识库', scope: 'user', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot }) } catch (error) { return error } })()
  assert.equal(againUser.code, 'KB_NAME_DUPLICATED')
  assert.match(againUser.message, /用户级（所有工作区共享）/)
})

if (failures.length > 0) {
  console.log('\n失败 ' + failures.length + ' 项：')
  for (const item of failures) console.log(' - ' + item.name + ' → ' + (item.error instanceof Error ? item.error.stack : String(item.error)))
  process.exitCode = 1
} else {
  console.log('\nALL PASS（' + passed + ' 项）')
}
