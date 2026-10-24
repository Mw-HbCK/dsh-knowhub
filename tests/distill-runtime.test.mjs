/**
 * 自动提炼运行时契约测试（进程内运行）。
 *
 * 依据 DSH 0.2.1 真实源码（dsh-agent-loop/lib/index.js:1032 dispatch.emit("agent/assistant-stream", { frame })
 * 与 :967 dispatch.serial("agent/turn-stopping", { turn, signal })；headless lib/index.js:74 消费 { agent, frame }）：
 * - assistant-stream 的 payload 形如 { agent, frame }，文本增量在 frame.chunk.type === 'text-delta' 的 frame.chunk.text；
 * - turn-stopping 的 payload 可能只有 { turn, signal }，需要用最近一次流事件的 agent 兜底；
 * - turn-stopping 是 serial 事件，监听器返回的 promise 会被 await —— 自动提炼必须在 await 结束时已落库。
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const rootPath = decodeURIComponent(new URL('../.build/test-data/distill-runtime-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const testRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
const storageRoot = join(testRoot, 'storage')
const dshHome = join(testRoot, 'dsh-home')
await mkdir(storageRoot, { recursive: true })
await mkdir(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome

const { openDatabase, get } = await load('db/db.js')
const store = await load('kb/store.js')
const settingsLib = await load('settings.js')
const { registerAutoDistill } = await load('distill.js')

const db = openDatabase(storageRoot)
const config = { storageRoot }
const kb = await store.createKnowledgeBase(db, { name: '自动提炼验证库', scope: 'user', workspaceId: null, modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot })

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

const CANDIDATE = JSON.stringify([{
  title: '自动提炼事件契约以 frame 为准',
  kind: 'decision',
  body: 'DSH 的 agent/assistant-stream 事件负载是 { agent, frame }，文本增量位于 frame.chunk.text；监听器必须从 frame 读取，否则永远拿不到助手输出，自动提炼会静默失效。',
  confidence: 0.86,
  evidence: [{ kind: 'session', ref: 'distill-runtime-test' }],
}])

function makeFakeCtx(state) {
  const handlers = new Map()
  return {
    handlers,
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      return () => {}
    },
    get(name) {
      if (name === 'llm') {
        return {
          stream: () => {
            state.streams += 1
            return (async function* () {
              yield { type: 'reasoning-delta', text: '先想一想' }
              yield { type: 'text-delta', text: CANDIDATE }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        }
      }
      return undefined
    },
    async emit(name, payload) {
      const list = handlers.get(name) ?? []
      return Promise.all(list.map((fn) => Promise.resolve().then(() => fn(payload))))
    },
  }
}

const longText = '这是一段足够长的助手输出，用于验证自动提炼会真正触发。'.repeat(6)
const runsCount = () => Number(get(db, 'SELECT COUNT(*) AS n FROM distill_runs').n)
const lastRun = () => get(db, 'SELECT * FROM distill_runs ORDER BY created_at DESC LIMIT 1')

console.log('自动提炼运行时契约测试开始：' + testRoot)

const state = { streams: 0 }
const ctx = makeFakeCtx(state)

await test('注册后只监听真实事件名，不监听自造事件', () => {
  registerAutoDistill(ctx, config)
  const names = [...ctx.handlers.keys()].sort()
  assert.deepEqual(names, ['agent/assistant-stream', 'agent/turn-stopping'])
})

await test('关闭自动提炼时 turn 收尾不产生提炼运行', async () => {
  settingsLib.writeSettings(db, { autoDistill: false, distillMinChars: 100 }, 'test')
  const before = runsCount()
  await ctx.emit('agent/assistant-stream', { agent: { id: 'agent-off', session: { header: { cwd: testRoot } } }, frame: { chunk: { type: 'text-delta', text: longText } } })
  await ctx.emit('agent/turn-stopping', { turn: {} })
  assert.equal(runsCount(), before, '关闭时不应写入 distill_runs')
  assert.equal(state.streams, 0, '关闭时不应调用模型')
})

await test('开启后：{agent,frame} 形状的文本被累积并触发提炼', async () => {
  settingsLib.writeSettings(db, { autoDistill: true, distillMinChars: 100 }, 'test')
  const agent = { id: 'agent-main', session: { header: { cwd: testRoot } } }
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start' } })
  await ctx.emit('agent/assistant-stream', { agent, frame: { chunk: { type: 'reasoning-delta', text: '不应被计入正文' } } })
  await ctx.emit('agent/assistant-stream', { agent, frame: { chunk: { type: 'text-delta', text: longText } } })
  await ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end' } })
  const before = runsCount()
  await ctx.emit('agent/turn-stopping', { turn: {}, signal: null })
  assert.equal(runsCount(), before + 1, '应当写入一条 distill_runs')
  const run = lastRun()
  assert.equal(run.source, 'auto:turn')
  assert.equal(run.status, 'success')
  assert.equal(Number(run.created_count), 1, '应生成 1 条候选')
  assert.equal(state.streams, 1, '应当恰好调用一次模型')
  const proposal = get(db, 'SELECT * FROM proposals WHERE kb_id = ? ORDER BY created_at DESC LIMIT 1', [kb.id])
  assert.ok(proposal, '应生成待审核候选')
  assert.equal(proposal.status, 'pending')
  assert.equal(proposal.title, '自动提炼事件契约以 frame 为准')
})

await test('turn-stopping 的 promise 被 await 后结果已落库（进程退出不丢工作）', async () => {
  settingsLib.writeSettings(db, { autoDistill: true, distillMinChars: 100 }, 'test')
  const agent = { id: 'agent-durable', session: { header: { cwd: testRoot } } }
  await ctx.emit('agent/assistant-stream', { agent, frame: { chunk: { type: 'text-delta', text: longText } } })
  const before = runsCount()
  await ctx.emit('agent/turn-stopping', { turn: {} })
  assert.equal(runsCount(), before + 1, 'await turn-stopping 之后 distill_runs 必须已存在')
})

await test('旧错误契约（payload.chunk 直接在顶层）不再被误读', async () => {
  settingsLib.writeSettings(db, { autoDistill: true, distillMinChars: 100 }, 'test')
  const before = runsCount()
  await ctx.emit('agent/assistant-stream', { chunk: { type: 'text-delta', text: longText }, agent: { id: 'agent-legacy' } })
  await ctx.emit('agent/turn-stopping', { turn: {} })
  assert.equal(runsCount(), before, '顶层 chunk 形状不应被当作真实文本增量')
})

await test('文本低于阈值时跳过提炼（不浪费模型调用）', async () => {
  settingsLib.writeSettings(db, { autoDistill: true, distillMinChars: 500 }, 'test')
  const agent = { id: 'agent-short', session: { header: { cwd: testRoot } } }
  const streamsBefore = state.streams
  await ctx.emit('agent/assistant-stream', { agent, frame: { chunk: { type: 'text-delta', text: '很短的输出' } } })
  const before = runsCount()
  await ctx.emit('agent/turn-stopping', { turn: {} })
  assert.equal(runsCount(), before, '低于阈值不应写入运行记录')
  assert.equal(state.streams, streamsBefore, '低于阈值不应调用模型')
})

await test('同一 agent 冷却期内不重复提炼', async () => {
  settingsLib.writeSettings(db, { autoDistill: true, distillMinChars: 100 }, 'test')
  const agent = { id: 'agent-cooldown', session: { header: { cwd: testRoot } } }
  await ctx.emit('agent/assistant-stream', { agent, frame: { chunk: { type: 'text-delta', text: longText } } })
  await ctx.emit('agent/turn-stopping', { turn: {} })
  const after = runsCount()
  await ctx.emit('agent/assistant-stream', { agent, frame: { chunk: { type: 'text-delta', text: longText } } })
  await ctx.emit('agent/turn-stopping', { turn: {} })
  assert.equal(runsCount(), after, '冷却期内不应重复提炼')
})

await test('事件异常不会抛给用户会话', async () => {
  settingsLib.writeSettings(db, { autoDistill: true, distillMinChars: 100 }, 'test')
  await ctx.emit('agent/assistant-stream', null)
  await ctx.emit('agent/assistant-stream', { frame: null })
  await ctx.emit('agent/turn-stopping', null)
  assert.ok(true, '异常负载被静默丢弃')
})

console.log('')
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
if (failures.length > 0) {
  for (const failure of failures) {
    console.error('FAILED: ' + failure.name)
    console.error(failure.error?.stack ?? failure.error)
  }
  process.exitCode = 1
}
