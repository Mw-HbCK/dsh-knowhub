/**
 * M4 验收测试（进程内运行；沙箱禁止子进程管道，故不用 node --test runner）。
 * 覆盖：Git 输出解析、结构性变更识别、哈希差分、影响面定位、基线检查点、
 *       零变更不调用模型、已批准文档只产生候选、草稿直接更新、来源删除→过时候选、
 *       结构性变更→需重新检查、跨知识库隔离。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const { openDatabase, all } = await load('db/db.js')
const store = await load('kb/store.js')
const search = await load('search.js')
const review = await load('review.js')
const changesLib = await load('pipeline/changes.js')
const gitLib = await load('pipeline/git.js')
const indexLib = await load('pipeline/index.js')
const incremental = await load('pipeline/incremental.js')

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

const rootPath = decodeURIComponent(new URL('../.build/test-data/m4-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const storageRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
await mkdir(storageRoot, { recursive: true })
const wsA = join(storageRoot, 'workspace-a')
const wsB = join(storageRoot, 'workspace-b')
await mkdir(join(wsA, 'src'), { recursive: true })
await mkdir(join(wsB, 'src'), { recursive: true })
await writeFile(join(wsA, 'package.json'), JSON.stringify({ name: 'demo-a', version: '1.0.0' }, null, 2))
await writeFile(join(wsA, 'src', 'a.ts'), 'export const a = 1\n')
await writeFile(join(wsA, 'src', 'b.ts'), 'export const b = 2\n')
await writeFile(join(wsB, 'src', 'z.ts'), 'export const z = 3\n')

const registry = {
  list: () => [
    { id: 'ws-a-uuid', title: '项目 A', path: wsA, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: [] },
    { id: 'ws-b-uuid', title: '项目 B', path: wsB, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: [] },
  ],
  get: (id) => registry.list().find((item) => item.id === id),
  resolveByPath: async (path) => registry.list().find((item) => item.path === path),
}

const modelCalls = []
let modelReply = (title) => JSON.stringify({
  document: {
    title,
    body: '# 架构说明（更新）\n\n本次变更调整了模块 A 的导出结构，新增常量 a 并保持向后兼容。\n\n## 影响\n\n- src/a.ts 的导出未破坏既有调用方\n- 无需调整构建配置\n',
    changeSummary: '补充模块 A 的导出说明',
    uncertain: [],
  },
})
const fakeLlm = {
  stream(options) {
    modelCalls.push({ provider: options.provider, model: options.model })
    const text = modelReply('架构说明（更新）')
    return (async function* () {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const fakeCtx = {
  get(name) {
    if (name === 'workspaceRegistry') return registry
    if (name === 'llm') return fakeLlm
    return undefined
  },
  on() { return () => undefined },
}

const db = openDatabase(storageRoot)
const kbA = await store.createKnowledgeBase(db, { name: '项目 A 知识库', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
const kbB = await store.createKnowledgeBase(db, { name: '项目 B 知识库', scope: 'workspace', workspaceId: 'ws-b-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: wsB, workspaceTitle: '项目 B' })

const longBody = '# 架构说明\n\n本项目的核心模块包括索引、检索与知识处理三层，模块之间通过服务层通信。\n\n## 关键点\n\n- 只读 Git 命令用于检测变更\n- 内容哈希作为权威判定\n'
const approvedDoc = await search.createDocument(db, storageRoot, kbA, { title: '架构说明', kind: 'wiki', body: longBody, status: 'approved', verifyState: 'observed' })
const draftDoc = await search.createDocument(db, storageRoot, kbA, { title: '模块说明', kind: 'wiki', body: longBody.replace('架构说明', '模块说明'), status: 'draft', verifyState: 'inferred' })
changesLib.ensureDocSources(db, approvedDoc.id, 'file', ['src/a.ts'], 1)
changesLib.ensureDocSources(db, draftDoc.id, 'file', ['src/b.ts'], 1)

const scan = await indexLib.indexProject(wsA)
indexLib.saveProjectIndex(db, kbA.id, scan.files)
const scanB = await indexLib.indexProject(wsB)
indexLib.saveProjectIndex(db, kbB.id, scanB.files)

const runOnce = async (taskId) => {
  const events = []
  const summary = await incremental.runIncremental({
    ctx: fakeCtx, db, storageRoot, kb: kbA, taskId,
    signal: new AbortController().signal,
    progress: (percent, stage) => events.push({ percent, stage }),
    log: (level, message) => events.push({ level, message }),
    workspaceId: 'ws-a-uuid',
  })
  return { summary, events }
}

await test('Git 输出解析：porcelain -z 与 name-status -z', async () => {
  const porcelain = gitLib.parsePorcelainZ(' M src/a.ts\0?? new.txt\0A  added.ts\0 D gone.ts\0')
  const byPath = new Map(porcelain.map((item) => [item.path, item.change]))
  assert.equal(byPath.get('src/a.ts'), 'modified')
  assert.equal(byPath.get('new.txt'), 'added')
  assert.equal(byPath.get('added.ts'), 'added')
  assert.equal(byPath.get('gone.ts'), 'deleted')
  const status = gitLib.parseNameStatusZ('M\0src/a.ts\0A\0src/c.ts\0D\0src/d.ts\0')
  assert.deepEqual(status.map((item) => item.change), ['modified', 'added', 'deleted'])
})

await test('仓库子路径重定位与排除敏感/无关文件', async () => {
  const filtered = gitLib.filterAndRebase([
    { path: 'packages/app/src/a.ts', change: 'modified' },
    { path: 'packages/app/node_modules/x.js', change: 'added' },
    { path: 'packages/app/.env', change: 'added' },
    { path: 'packages/app/../escape.ts', change: 'added' },
    { path: 'other/src/b.ts', change: 'modified' },
  ], 'packages/app')
  assert.deepEqual(filtered.map((item) => item.path), ['src/a.ts'])
})

await test('结构性变更识别', async () => {
  assert.equal(changesLib.isStructuralChange('package.json'), true)
  assert.equal(changesLib.isStructuralChange('pnpm-lock.yaml'), true)
  assert.equal(changesLib.isStructuralChange('tsconfig.json'), true)
  assert.equal(changesLib.isStructuralChange('.github/workflows/ci.yml'), true)
  assert.equal(changesLib.isStructuralChange('src/a.ts'), false)
})

await test('首次运行只建立基线检查点，不调用模型', async () => {
  const { summary, events } = await runOnce('t-baseline')
  assert.equal(summary.baseline, true)
  assert.equal(modelCalls.length, 0)
  assert.equal(summary.modelCalls, 0)
  const state = changesLib.readGitStateRow(db, kbA.id)
  assert.ok(state !== null)
  assert.equal(state.fileCount, scan.files.length)
  assert.ok(events.some((event) => String(event.message ?? '').includes('基线')))
})

await test('零变更时不调用模型、不产生候选', async () => {
  const before = all(db, 'SELECT COUNT(*) AS c FROM proposals')[0].c
  const { summary } = await runOnce('t-zero')
  assert.equal(summary.changeCount, 0)
  assert.equal(modelCalls.length, 0)
  assert.equal(all(db, 'SELECT COUNT(*) AS c FROM proposals')[0].c, before)
})

await test('修改源文件后影响面只定位相关文档，已批准文档只生成候选', async () => {
  await writeFile(join(wsA, 'src', 'a.ts'), 'export const a = 1\nexport const a2 = 2\n')
  const plan = await incremental.planIncremental({ ctx: fakeCtx, db, storageRoot, kb: kbA, workspaceId: 'ws-a-uuid' })
  assert.equal(plan.dryRun, true)
  assert.equal(plan.changeCount, 1)
  assert.equal(plan.affectedCount, 1)
  assert.equal(plan.planned[0].docId, approvedDoc.id)
  assert.equal(plan.planned[0].action, 'update-proposal')
  assert.equal(plan.plannedModelCalls, 1)
  assert.equal(modelCalls.length, 0, 'dryRun 不调用模型')

  const { summary } = await runOnce('t-update-approved')
  assert.equal(modelCalls.length, 1)
  assert.equal(modelCalls[0].provider, 'amd')
  assert.equal(modelCalls[0].model, 'DeepSeek-V4-Flash')
  assert.equal(summary.proposals, 1)
  const doc = search.getDocument(db, approvedDoc.id)
  assert.equal(doc.status, 'approved')
  assert.equal(doc.currentVersion, 1, '已批准文档未被自动覆盖')
  const proposals = all(db, "SELECT id, status, kind, doc_id FROM proposals WHERE kb_id = ? AND status = 'pending'", [kbA.id])
  assert.equal(proposals.length, 1)
  assert.equal(String(proposals[0].kind), 'update')
  assert.equal(String(proposals[0].doc_id), approvedDoc.id)
})

await test('草稿文档被直接追加版本（并记录 pipeline 来源）', async () => {
  await writeFile(join(wsA, 'src', 'b.ts'), 'export const b = 22\nexport const b2 = 23\n')
  const { summary } = await runOnce('t-update-draft')
  assert.equal(modelCalls.length, 2)
  assert.ok(summary.updatedDrafts >= 1)
  const doc = search.getDocument(db, draftDoc.id)
  assert.equal(doc.currentVersion, 2)
  const versions = all(db, 'SELECT change_kind, source FROM doc_versions WHERE doc_id = ? ORDER BY version DESC', [draftDoc.id])
  assert.equal(String(versions[0].change_kind), 'update')
  assert.equal(String(versions[0].source), 'pipeline:incremental')
})

await test('来源文件被删除时保留正文并生成过时候选', async () => {
  await rm(join(wsA, 'src', 'b.ts'))
  const { summary } = await runOnce('t-stale')
  assert.ok(summary.staleProposals >= 1)
  const doc = search.getDocument(db, draftDoc.id)
  assert.ok(doc !== null, '正文仍然保留')
  assert.ok(String(doc.body).length > 40)
  const stale = all(db, "SELECT id, kind, status FROM proposals WHERE doc_id = ? AND kind = 'stale'", [draftDoc.id])
  assert.ok(stale.length >= 1)
  assert.equal(String(stale[0].status), 'pending')
})

await test('结构性文件变更会把 Wiki 文档标记为需要重新检查', async () => {
  await writeFile(join(wsA, 'package.json'), JSON.stringify({ name: 'demo-a', version: '2.0.0', dependencies: { zod: '^4.0.0' } }, null, 2))
  const { summary } = await runOnce('t-structural')
  assert.ok(summary.structuralChanges >= 1)
  assert.ok(summary.recheckFlagged >= 1)
  const recheck = changesLib.listRecheck(db, kbA.id)
  assert.ok(recheck.some((item) => item.docId === approvedDoc.id))
})

await test('跨知识库隔离：A 的变更不会影响 B 的文档', async () => {
  const impact = changesLib.mapAffectedDocs(db, kbB.id, [{ path: 'src/a.ts', change: 'modified' }])
  assert.equal(impact.affected.length, 0)
  const changesB = changesLib.listFileChanges(db, kbB.id, 50)
  assert.equal(changesB.length, 0)
  const planB = await incremental.planIncremental({ ctx: fakeCtx, db, storageRoot, kb: kbB, workspaceId: 'ws-b-uuid' })
  assert.equal(planB.changeCount, 0)
  assert.equal(planB.affectedCount, 0)
})

await test('模型返回无效内容时不覆盖文档，记录失败而不崩溃', async () => {
  await writeFile(join(wsA, 'src', 'a.ts'), 'export const a = 9\n')
  const original = modelReply
  modelReply = () => '抱歉，我无法完成该任务。'
  const before = all(db, 'SELECT COUNT(*) AS c FROM proposals')[0].c
  let threw = null
  try {
    await runOnce('t-invalid')
  } catch (error) {
    threw = error
  }
  modelReply = original
  const doc = search.getDocument(db, approvedDoc.id)
  assert.equal(doc.currentVersion, 1)
  assert.equal(all(db, 'SELECT COUNT(*) AS c FROM proposals')[0].c, before)
  assert.ok(threw === null || String(threw.message).includes('MODEL_OUTPUT_INVALID') || String(threw.code ?? '') === 'MODEL_OUTPUT_INVALID')
})

console.log('')
if (failures.length === 0) {
  console.log('M4 单测全部通过：' + passed + '/' + (passed + failures.length))
  process.exit(0)
} else {
  console.log('M4 单测失败：' + failures.length + ' 项')
  for (const failure of failures) console.log(' - ' + failure.name + ' → ' + (failure.error?.stack ?? failure.error))
  process.exit(1)
}
