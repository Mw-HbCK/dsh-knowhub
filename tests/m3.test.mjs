/**
 * M3 验收测试（进程内运行；沙箱禁止子进程管道，故不用 node --test runner）。
 * 覆盖：候选知识默认待审核、批准入库、拒绝、编辑后批准、版本冲突检测与处理、
 *       版本历史/差异/恢复、人工编辑追加版本、审核日志、知识作用域隔离、
 *       7 个 Agent 工具（+diagnose）真实注册与作用域校验。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const { openDatabase, closeDatabase, all } = await load('db/db.js')
const store = await load('kb/store.js')
const search = await load('search.js')
const docvers = await load('docvers.js')
const review = await load('review.js')
const { registerKnowledgeTools } = await load('tool.js')

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

const rootPath = decodeURIComponent(new URL('../.build/test-data/m3-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const storageRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
await mkdir(storageRoot, { recursive: true })

const wsA = join(storageRoot, 'workspace-a')
const wsB = join(storageRoot, 'workspace-b')
await mkdir(wsA, { recursive: true })
await mkdir(wsB, { recursive: true })
await writeFile(join(wsA, 'package.json'), JSON.stringify({ name: 'demo-a', version: '1.0.0' }, null, 2))
await writeFile(join(wsB, 'main.py'), 'print("b")\n')

const registry = {
  list: () => [
    { id: 'ws-a-uuid', title: '项目 A', path: wsA, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: [] },
    { id: 'ws-b-uuid', title: '项目 B', path: wsB, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', sessionIds: [] },
  ],
  get: (id) => registry.list().find((item) => item.id === id),
  resolveByPath: async (path) => registry.list().find((item) => item.path === path),
}
const hostCtx = {
  get(name) {
    if (name === 'workspaceRegistry') return registry
    return undefined
  },
  on() { return () => undefined },
}

const db = openDatabase(storageRoot)
const kbA = await store.createKnowledgeBase(db, { name: '项目 A 知识库', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot, workspacePath: wsA, workspaceTitle: '项目 A' })
const kbB = await store.createKnowledgeBase(db, { name: '项目 B 知识库', scope: 'workspace', workspaceId: 'ws-b-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: wsB, workspaceTitle: '项目 B' })
const kbUser = await store.createKnowledgeBase(db, { name: '通用偏好', scope: 'user', modelProvider: 'deepseek-account', modelId: 'deepseek-flash', modelStrategy: 'economy' }, { storageRoot })
console.log('  已创建测试知识库：' + kbA.id + ' / ' + kbB.id + ' / ' + kbUser.id)

await test('候选知识默认 pending，不写入正式文档表', async () => {
  const proposal = review.createProposal(db, kbA, { title: '构建命令', docKind: 'convention', body: '本项目使用 npm run build 构建。', tags: ['构建'], verifyState: 'observed', sources: [{ kind: 'file', ref: 'package.json' }], source: 'test', reason: 'M3 单测' })
  assert.equal(proposal.status, 'pending')
  const docs = all(db, 'SELECT id FROM documents WHERE kb_id = ? AND deleted_at IS NULL', [kbA.id])
  assert.equal(docs.length, 0, '待审核候选不得直接生成正式文档')
})

let pendingCreate = null
let targetDocId = ''
await test('批准新增候选 → 正式文档 approved + 第 1 版 + 来源证据', async () => {
  pendingCreate = review.createProposal(db, kbA, { title: '测试命令', docKind: 'convention', body: '运行测试使用 node tests/smoke.test.mjs。', tags: ['测试'], verifyState: 'observed', sources: [{ kind: 'file', ref: 'package.json', locator: 'scripts.test' }], source: 'agent', reason: '提炼自会话' })
  const result = await review.approveProposal(db, storageRoot, pendingCreate.id, { actor: 'tester', note: '确认有效' })
  assert.equal(result.conflict, null)
  assert.equal(result.document.status, 'approved')
  assert.equal(result.document.currentVersion, 1)
  const versions = docvers.listVersions(db, result.document.id)
  assert.equal(versions[0].changeKind, 'create')
  const sources = all(db, 'SELECT kind, ref FROM sources WHERE doc_id = ?', [result.document.id])
  assert.equal(sources.length, 1)
  assert.equal(String(sources[0].ref), 'package.json')
  const logs = all(db, "SELECT action FROM review_log WHERE item_id = ? AND action = 'approve'", [pendingCreate.id])
  targetDocId = result.document.id
  assert.equal(logs.length, 1, '审核动作必须写入审核日志')
})

await test('批准更新候选（基础版本匹配）→ 追加第 2 版', async () => {
  const doc = search.getDocument(db, pendingCreate.docId ?? '')
  const current = all(db, 'SELECT id FROM documents WHERE kb_id = ? AND title = ? AND deleted_at IS NULL', [kbA.id, '测试命令'])[0]
  const target = search.getDocument(db, String(current.id))
  const proposal = review.createProposal(db, kbA, { kind: 'update', docId: target.id, title: target.title, body: '运行全部测试：build → smoke → m1 → m2 → m3。', source: 'agent', reason: '补充测试命令' })
  const result = await review.approveProposal(db, storageRoot, proposal.id, { actor: 'tester' })
  assert.equal(result.document.currentVersion, 2)
  assert.ok(result.document.body.includes('m3'))
  assert.equal(review.getProposal(db, proposal.id).status, 'approved')
})

await test('基础版本过期 → 生成冲突审核项，且不覆盖当前内容（proposal 置 superseded）', async () => {
  const doc = search.getDocument(db, targetDocId)
  const proposal = review.createProposal(db, kbA, { kind: 'update', docId: doc.id, body: '过期的修改：把测试命令写成 yarn test。', source: 'agent' })
  // 人工先改一版，让候选的基础版本失效
  await review.updateDocumentByHuman(db, storageRoot, doc, { body: '运行全部测试：build → smoke → m1 → m2 → m3 → m4。', note: '人工补充 m4' }, 'tester')
  const result = await review.approveProposal(db, storageRoot, proposal.id, { actor: 'tester' })
  assert.ok(result.conflict, '版本过期时必须生成冲突项')
  assert.equal(review.getProposal(db, proposal.id).status, 'superseded')
  assert.equal(result.document, null)
  const latest = search.getDocument(db, doc.id)
  assert.ok(latest.body.includes('m4'), '已批准内容不能被候选静默覆盖')
  assert.ok(!latest.body.includes('yarn test'))
})

await test('重复上报相同冲突内容 → 去重，不重复累积', async () => {
  const doc = search.getDocument(db, targetDocId)
  const first = review.recordConflict(db, { kbId: kbA.id, doc, proposedBody: '同样的冲突内容', source: 'test' })
  const second = review.recordConflict(db, { kbId: kbA.id, doc, proposedBody: '同样的冲突内容', source: 'test' })
  assert.equal(first.id, second.id)
})

await test('冲突处理：保留当前知识', async () => {
  const doc = search.getDocument(db, targetDocId)
  const conflict = review.recordConflict(db, { kbId: kbA.id, doc, proposedBody: '新的写法', source: 'test' })
  const result = await review.resolveConflict(db, storageRoot, conflict.id, { mode: 'keep_current', actor: 'tester', note: '仍按原约定' })
  assert.equal(result.conflict.status, 'keep_current')
  const after = search.getDocument(db, doc.id)
  assert.ok(after.body.includes('m4'), '保留当前知识时不得修改正文')
})

await test('冲突处理：采用新提议 → 追加 merge 版本', async () => {
  const doc = search.getDocument(db, targetDocId)
  const conflict = review.recordConflict(db, { kbId: kbA.id, doc, proposedBody: '采用新提议后的正文内容。', proposedTitle: '测试命令（新）', source: 'test' })
  const result = await review.resolveConflict(db, storageRoot, conflict.id, { mode: 'use_proposed', actor: 'tester' })
  assert.equal(result.conflict.status, 'use_proposed')
  assert.ok(result.document.body.includes('采用新提议'))
  const versions = docvers.listVersions(db, result.document.id)
  assert.equal(versions[0].changeKind, 'merge')
})

await test('草稿审核：批准草稿 → approved；标记过时 → stale；拒绝 → archived', async () => {
  const draft = await search.createDocument(db, storageRoot, kbA, { title: '待审核草稿', kind: 'memory', body: '这是一条草稿知识。', status: 'draft', verifyState: 'inferred' })
  assert.equal(draft.status, 'draft')
  const approved = review.reviewDocument(db, draft, 'approve', { actor: 'tester', note: '确认' })
  assert.equal(approved.status, 'approved')
  const staleDraft = await search.createDocument(db, storageRoot, kbA, { title: '即将过时的知识', kind: 'memory', body: '这条知识将被标记过时。', status: 'approved', verifyState: 'observed' })
  const stale = review.reviewDocument(db, staleDraft, 'mark_stale', { actor: 'tester', note: '实现已变更' })
  assert.equal(stale.status, 'stale')
  const rejectedDraft = await search.createDocument(db, storageRoot, kbA, { title: '将被拒绝的草稿', kind: 'memory', body: '这条草稿会被拒绝。', status: 'draft', verifyState: 'assumed' })
  const archived = review.reviewDocument(db, rejectedDraft, 'reject', { actor: 'tester' })
  assert.equal(archived.status, 'archived')
})

await test('版本差异：新增/删除行统计正确', async () => {
  const doc = search.getDocument(db, targetDocId)
  const diff = docvers.diffVersions(db, doc, 1, doc.currentVersion)
  assert.ok(diff.lines.length > 0)
  assert.ok(diff.stats.added > 0, '第二轮内容应包含新增行')
  assert.equal(diff.from, 1)
})

await test('恢复历史版本：以新版本记录 restore，正文回到旧版本且不静默覆盖', async () => {
  const doc = search.getDocument(db, targetDocId)
  const before = doc.currentVersion
  const result = await docvers.restoreVersion(db, storageRoot, doc, 1, { actor: 'tester', note: '回到最初约定' })
  assert.equal(result.document.currentVersion, before + 1)
  const versions = docvers.listVersions(db, doc.id)
  assert.equal(versions[0].changeKind, 'restore')
  assert.ok(String(versions[0].reason).includes('恢复自第 1 版'))
})

await test('人工编辑追加 manual 版本（来源可追溯）', async () => {
  const doc = search.getDocument(db, targetDocId)
  const updated = await review.updateDocumentByHuman(db, storageRoot, doc, { body: doc.body + '\n\n人工补充一行。', note: '人工修订' }, 'tester')
  assert.equal(updated.currentVersion, doc.currentVersion + 1)
  assert.equal(docvers.listVersions(db, doc.id)[0].source, 'manual')
})

await test('审核队列：统计候选/冲突/草稿/过时，且只含本作用域知识库', async () => {
  const queue = review.reviewQueue(db, [kbA.id], 50)
  assert.ok(queue.counts.total >= 1)
  assert.ok(queue.counts.stale >= 1, '刚标记过时的文档应出现在过时列表')
  const otherQueue = review.reviewQueue(db, [kbB.id], 50)
  assert.equal(otherQueue.counts.proposals, 0, '其他知识库的候选不得混入')
  assert.ok(!JSON.stringify(queue).includes(kbB.id), '队列不得包含其他知识库 ID')
})

await test('检索隔离：工作区知识库的文档不出现在其他工作区作用域', async () => {
  const inA = search.searchDocuments(db, { query: '测试命令', scopeKeys: ['user:*', 'ws:ws-a-uuid'], status: 'approved' })
  assert.ok(inA.total > 0, 'A 工作区应能检索到自己已批准的知识')
  const inB = search.searchDocuments(db, { query: '测试命令', scopeKeys: ['user:*', 'ws:ws-b-uuid'], status: 'approved' })
  assert.equal(inB.total, 0, 'B 工作区不得检索到 A 工作区的私有知识')
  const external = search.searchDocuments(db, { query: '测试命令', scopeKeys: ['ws:ws-b-uuid'], status: 'approved' })
  assert.equal(external.total, 0)
})

// ---- 工具层 ----
const captured = []
const toolsCtx = { tools: { register(definition) { captured.push(definition); return () => undefined } } }
registerKnowledgeTools(toolsCtx, hostCtx, { storageRoot })
const tool = (name) => captured.find((definition) => definition.name === name)
const execA = { agent: { session: { header: { cwd: wsA } } } }
const execB = { agent: { session: { header: { cwd: wsB } } } }

await test('注册 8 个 Agent 工具，参数均为原生 JSON Schema', async () => {
  const names = captured.map((definition) => definition.name).sort()
  assert.deepEqual(names, ['knowledge_diagnose', 'knowledge_get', 'knowledge_initialize', 'knowledge_list', 'knowledge_propose', 'knowledge_search', 'knowledge_update', 'knowledge_wiki_status'])
  for (const definition of captured) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.schema, 'object')
  }
})

await test('knowledge_search：默认只返回 approved 且带来源与作用域', async () => {
  const result = await tool('knowledge_search').execute({ query: '测试命令' }, execA)
  assert.equal(result.ok, true)
  assert.equal(result.workspaceId, 'ws-a-uuid')
  assert.ok(result.results.length > 0)
  assert.ok(result.results.every((item) => item.status === 'approved'))
  assert.ok(result.results.every((item) => item.scope !== undefined))
  const draftResult = await tool('knowledge_search').execute({ query: '即将过时', status: 'any' }, execA)
  assert.ok(draftResult.results.some((item) => item.status !== 'approved'), 'status=any 时应能显式看到未批准内容')
})

await test('knowledge_search：B 工作区查不到 A 的私有知识', async () => {
  const result = await tool('knowledge_search').execute({ query: '测试命令' }, execB)
  assert.equal(result.ok, true)
  assert.equal(result.total, 0)
})

await test('knowledge_get：读取正文与版本；跨作用域读取返回 403', async () => {
  const doc = search.getDocument(db, targetDocId)
  const ok = await tool('knowledge_get').execute({ docId: doc.id }, execA)
  assert.equal(ok.ok, true)
  assert.equal(ok.document.id, doc.id)
  assert.ok(Array.isArray(ok.versions))
  const forbidden = await tool('knowledge_get').execute({ docId: doc.id }, execB)
  assert.equal(forbidden.ok, false)
  assert.equal(forbidden.error.code, 'DOC_FORBIDDEN')
})

await test('knowledge_propose / knowledge_update：只创建待审核候选', async () => {
  const proposed = await tool('knowledge_propose').execute({ title: 'Agent 提议的约定', body: '所有提交必须通过类型检查。', kind: 'convention', reason: '来自工具调用' }, execA)
  assert.equal(proposed.ok, true)
  assert.equal(proposed.status, 'pending')
  assert.equal(proposed.knowledgeBaseId, kbA.id, '默认落在当前工作区绑定的知识库')
  assert.ok(proposed.proposalId)
  const target = search.getDocument(db, targetDocId)
  const update = await tool('knowledge_update').execute({ docId: target.id, body: '工具提议的新正文。', reason: '补充' }, execA)
  assert.equal(update.ok, true)
  assert.equal(update.status, 'pending')
  assert.ok(update.proposalId)
  assert.equal(update.baseVersion, target.currentVersion)
  const current = search.getDocument(db, target.id)
  assert.notEqual(current.body, '工具提议的新正文。', '提议不得直接改正式内容')
})

await test('knowledge_propose：B 工作区不能给 A 的知识库提交候选', async () => {
  const denied = await tool('knowledge_propose').execute({ title: '越权提议', body: '不应成功', kbId: kbA.id }, execB)
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'KB_FORBIDDEN')
})

await test('knowledge_list / knowledge_wiki_status / knowledge_initialize：作用域与参数校验', async () => {
  const listed = await tool('knowledge_list').execute({ limit: 10 }, execA)
  assert.equal(listed.ok, true)
  assert.ok(listed.count >= 1, 'knowledge_list 应返回本作用域知识')
  const statusResult = await tool('knowledge_wiki_status').execute({}, execA)
  assert.equal(statusResult.ok, true)
  assert.ok(Array.isArray(statusResult.knowledgeBases))
  const initB = await tool('knowledge_initialize').execute({ kbId: kbA.id }, execB)
  assert.equal(initB.ok, false)
  assert.equal(initB.error.code, 'KB_FORBIDDEN')
})

await test('用户级知识库对所有工作区可见，工作区级仅本工作区可见', async () => {
  await search.createDocument(db, storageRoot, kbUser, { title: '全局偏好：回答用中文', kind: 'preference', body: '用户偏好中文回答。', status: 'approved', verifyState: 'observed' })
  const inA = search.searchDocuments(db, { query: '全局偏好', scopeKeys: ['user:*', 'ws:ws-a-uuid'], status: 'approved' })
  const inB = search.searchDocuments(db, { query: '全局偏好', scopeKeys: ['user:*', 'ws:ws-b-uuid'], status: 'approved' })
  assert.ok(inA.total > 0)
  assert.ok(inB.total > 0)
  const visibleKbsA = store.listKnowledgeBases(db, ['user:*', 'ws:ws-a-uuid']).map((kb) => kb.id)
  assert.ok(visibleKbsA.includes(kbUser.id))
  assert.ok(!visibleKbsA.includes(kbB.id), 'A 工作区不得看到 B 的知识库')
})

closeDatabase(storageRoot)

console.log('')
if (failures.length > 0) {
  console.log('M3 单测失败：' + failures.length + ' 项（通过 ' + passed + ' 项）')
  for (const failure of failures) console.log('  - ' + failure.name + '：' + (failure.error instanceof Error ? failure.error.stack : String(failure.error)))
  process.exitCode = 1
} else {
  console.log('M3 单测全部通过：' + passed + '/' + passed)
}
