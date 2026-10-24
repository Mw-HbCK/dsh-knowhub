/**
 * 待审核优化验收测试（进程内运行；沙箱禁止子进程管道，故不用 node --test runner）。
 * 覆盖：候选去重、审核队列真实计数/筛选/分页、批量审核（上限与逐条失败）、
 *       草稿编辑后批准、冲突人工合并、自动批准严格规则、设置项校验、HTTP 路由层。
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const rootPath = decodeURIComponent(new URL('../.build/test-data/review-opt-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const testRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
const storageRoot = join(testRoot, 'storage')
const dshHome = join(testRoot, 'dsh-home')
await mkdir(storageRoot, { recursive: true })
await mkdir(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome

const { openDatabase } = await load('db/db.js')
const store = await load('kb/store.js')
const search = await load('search.js')
const review = await load('review.js')
const settingsLib = await load('settings.js')
const docvers = await load('docvers.js')
const { handleReviewRequest } = await load('review/route.js')

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
const expectReject = async (fn, code) => {
  try { await fn() } catch (error) {
    if (code) assert.equal(error.code, code, '期望错误码 ' + code + '，实际 ' + error.code + '（' + error.message + '）')
    return error
  }
  throw new Error('期望失败但成功了')
}

const db = openDatabase(storageRoot)
const kb = await store.createKnowledgeBase(db, { name: '审核优化知识库', scope: 'workspace', workspaceId: 'ws-ro-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot, workspacePath: join(testRoot, 'ws-ro'), workspaceTitle: '审核优化' })
const kbOther = await store.createKnowledgeBase(db, { name: '其他工作区知识库', scope: 'workspace', workspaceId: 'ws-other-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: join(testRoot, 'ws-other'), workspaceTitle: '其他' })
const scopeKeys = [kb.scopeKey]
const kbIds = [kb.id]
const config = { storageRoot }

const wikiBody = ['# 架构 Wiki', '', '本项目采用适配层 + 核心层结构。', '', '- 内容哈希是增量判定权威', '- 已批准知识只生成候选', ''].join('\n')
const wikiDoc = await search.createDocument(db, storageRoot, kb, { title: '架构 Wiki', kind: 'wiki', body: wikiBody, status: 'approved', verifyState: 'observed' })
const memDoc = await search.createDocument(db, storageRoot, kb, { title: '存储选型记忆', kind: 'memory', body: '# 存储选型\n\n选择 node:sqlite + Markdown 混合存储。\n', status: 'approved', verifyState: 'observed' })

console.log('待审核优化单测开始：' + testRoot)

await test('设置项：自动批准默认关闭、差异阈值 10、审核人默认非空', async () => {
  const settings = settingsLib.readSettings(db)
  assert.equal(settings.autoApprove, false)
  assert.equal(settings.autoApproveMaxDiffLines, 10)
  assert.ok(settings.reviewerName.length > 0 && settings.reviewerName.length <= 40)
})

await test('设置项：阈值与审核人名称校验并持久化', async () => {
  await expectReject(() => settingsLib.validateSettingsPatch({ autoApproveMaxDiffLines: 0 }), 'SETTING_INVALID')
  await expectReject(() => settingsLib.validateSettingsPatch({ autoApproveMaxDiffLines: 201 }), 'SETTING_INVALID')
  await expectReject(() => settingsLib.validateSettingsPatch({ reviewerName: '   ' }), 'SETTING_INVALID')
  await expectReject(() => settingsLib.validateSettingsPatch({ reviewerName: '审'.repeat(41) }), 'SETTING_INVALID')
  await expectReject(() => settingsLib.validateSettingsPatch({ autoApprove: 'yes' }), 'SETTING_INVALID')
  const written = settingsLib.writeSettings(db, { autoApprove: true, autoApproveMaxDiffLines: 12, reviewerName: '测试审核员' }, 'tester')
  assert.equal(written.settings.autoApprove, true)
  assert.equal(written.settings.autoApproveMaxDiffLines, 12)
  assert.equal(written.settings.reviewerName, '测试审核员')
  settingsLib.writeSettings(db, { autoApprove: false, autoApproveMaxDiffLines: 10 }, 'tester')
  assert.equal(settingsLib.readSettings(db).autoApprove, false)
})

await test('候选去重：相同待审内容返回同一候选，不重复入队', async () => {
  const first = review.createProposal(db, kb, { kind: 'create', title: '去重候选', body: '同一段待审核正文', source: 'm-test' })
  const second = review.createProposal(db, kb, { kind: 'create', title: '去重候选', body: '同一段待审核正文', source: 'm-test' })
  assert.equal(second.id, first.id)
  const queue = review.reviewQueue(db, kbIds)
  const sameTitle = queue.proposals.filter((item) => item.title === '去重候选')
  assert.equal(sameTitle.length, 1)
  assert.equal(first.status, 'pending')
})

await test('审核队列：计数来自真实全量统计，分页只影响列表', async () => {
  const before = review.reviewQueue(db, kbIds)
  for (let index = 0; index < 60; index += 1) {
    review.createProposal(db, kb, { kind: 'create', title: '批量候选 ' + index, body: '批量候选正文 ' + index, source: 'pipeline' })
  }
  const page1 = review.reviewQueue(db, kbIds, { limit: 10, page: 1 })
  assert.equal(page1.counts.proposals, before.counts.proposals + 60)
  assert.equal(page1.proposals.length, 10)
  assert.equal(page1.pagination.limit, 10)
  assert.equal(page1.pagination.page, 1)
  assert.ok(page1.pendingTotal >= before.pendingTotal + 60)
  assert.equal(page1.pagination.totals.proposals, page1.counts.proposals)
  const page2 = review.reviewQueue(db, kbIds, { limit: 10, page: 2 })
  assert.equal(page2.pagination.page, 2)
  assert.equal(page2.proposals.length, 10)
  assert.notEqual(page2.proposals[0].id, page1.proposals[0].id)
  assert.equal(page2.counts.proposals, page1.counts.proposals)
  assert.equal(page2.pendingTotal, page1.pendingTotal)
})

await test('审核队列：kind / q / source 筛选返回真实计数且 pendingTotal 不受筛选影响', async () => {
  const updateProposal = review.createProposal(db, kb, { kind: 'update', docId: wikiDoc.id, title: '架构 Wiki', body: wikiBody + '\n- 新增一条约定', source: 'm-test' })
  review.createProposal(db, kb, { kind: 'create', title: '搜索命中候选', body: '正文包含 OPTQ-UNIQUE-标记 的内容', source: 'agent' })
  const all = review.reviewQueue(db, kbIds)
  const byKind = review.reviewQueue(db, kbIds, { kind: 'update' })
  assert.ok(byKind.proposals.length >= 1)
  assert.ok(byKind.proposals.every((item) => item.kind === 'update'))
  assert.ok(byKind.counts.proposals >= 1)
  assert.ok(byKind.counts.proposals < all.counts.proposals)
  const byQ = review.reviewQueue(db, kbIds, { q: 'OPTQ-UNIQUE' })
  assert.equal(byQ.counts.proposals, 1)
  assert.equal(byQ.proposals[0].title, '搜索命中候选')
  const bySource = review.reviewQueue(db, kbIds, { source: 'm-test' })
  assert.ok(bySource.counts.proposals >= 2)
  assert.ok(bySource.proposals.every((item) => item.source === 'm-test'))
  const withUpdate = review.reviewQueue(db, kbIds, { source: 'm-test', kind: 'update' })
  assert.ok(withUpdate.proposals.some((item) => item.id === updateProposal.id))
  assert.equal(byQ.pendingTotal, all.pendingTotal)
  assert.equal(byKind.pendingTotal, all.pendingTotal)
  assert.equal(all.filters.kind, null)
  assert.equal(bySource.filters.source, 'm-test')
})

await test('批量审核：逐条结果、单项失败不影响其他项、写入审核日志', async () => {
  const one = review.createProposal(db, kb, { kind: 'create', title: '批量批准一', body: '批量批准正文一' })
  const two = review.createProposal(db, kb, { kind: 'create', title: '批量批准二', body: '批量批准正文二' })
  const three = review.createProposal(db, kb, { kind: 'create', title: '批量拒绝', body: '批量拒绝正文' })
  const result = await review.bulkReview(db, storageRoot, [{ type: 'proposal', id: one.id }, { type: 'proposal', id: two.id }, { type: 'proposal', id: 'prop_missing' }], 'approve', { actor: '测试员', note: '批量验收' })
  assert.equal(result.results.length, 3)
  assert.equal(result.approved, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.results[2].ok, false)
  assert.match(result.results[2].message, /不存在/)
  assert.equal(review.getProposal(db, one.id).status, 'approved')
  assert.equal(review.getProposal(db, three.id).status, 'pending')
  const rejected = await review.bulkReview(db, storageRoot, [{ type: 'proposal', id: three.id }], 'reject', { actor: '测试员' })
  assert.equal(rejected.rejected, 1)
  assert.equal(review.getProposal(db, three.id).status, 'rejected')
  const log = review.listReviewLog(db, { kbIds, limit: 30 })
  assert.ok(log.some((entry) => entry.action === 'bulk_approve'))
  assert.ok(log.some((entry) => entry.action === 'bulk_reject'))
})

await test('批量审核：空列表 / 超过 50 条 / 非法动作被拒绝', async () => {
  await expectReject(() => review.bulkReview(db, storageRoot, [], 'approve', {}), 'BULK_EMPTY')
  const many = Array.from({ length: 51 }, (_, index) => ({ type: 'proposal', id: 'prop_' + index }))
  await expectReject(() => review.bulkReview(db, storageRoot, many, 'approve', {}), 'BULK_TOO_MANY')
  await expectReject(() => review.bulkReview(db, storageRoot, [{ type: 'proposal', id: 'x' }], 'delete', {}), 'BULK_INVALID_ACTION')
})

await test('批量审核：草稿可批量批准，状态与日志正确', async () => {
  const draftA = await search.createDocument(db, storageRoot, kb, { title: '草稿甲', kind: 'wiki', body: '# 草稿甲\n\n正文', status: 'draft' })
  const draftB = await search.createDocument(db, storageRoot, kb, { title: '草稿乙', kind: 'memory', body: '# 草稿乙\n\n正文', status: 'draft' })
  const result = await review.bulkReview(db, storageRoot, [{ type: 'doc', id: draftA.id }, { type: 'doc', id: draftB.id }], 'approve', { actor: '测试员' })
  assert.equal(result.approved, 2)
  assert.equal(search.getDocument(db, draftA.id).status, 'approved')
  assert.equal(search.getDocument(db, draftB.id).status, 'approved')
})

await test('草稿编辑后批准：追加 review 版本、正文落库并写 doc_edit 日志', async () => {
  const draft = await search.createDocument(db, storageRoot, kb, { title: '待编辑草稿', kind: 'wiki', body: '# 待编辑草稿\n\n原始正文', status: 'draft' })
  const approved = await review.approveDocumentWithEdits(db, storageRoot, draft, { title: '待编辑草稿（已编辑）', body: '# 待编辑草稿（已编辑）\n\n审核时补充的正文', actor: '测试员', note: '补充细节' })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.title, '待编辑草稿（已编辑）')
  assert.match(approved.body, /审核时补充的正文/)
  assert.equal(approved.currentVersion, 2)
  const versions = docvers.listVersions(db, draft.id)
  assert.equal(versions[0].changeKind, 'update')
  assert.equal(versions[0].source, 'review')
  assert.equal(versions[0].actor, '测试员')
  const log = review.listReviewLog(db, { kbIds, limit: 30 })
  assert.ok(log.some((entry) => entry.action === 'doc_edit' && entry.itemId === draft.id))
  assert.ok(log.some((entry) => entry.action === 'doc_approve' && entry.itemId === draft.id))
})

await test('草稿编辑后批准：未改动时不追加多余版本', async () => {
  const draft = await search.createDocument(db, storageRoot, kb, { title: '未改动草稿', kind: 'wiki', body: '# 未改动草稿\n\n正文', status: 'draft' })
  const approved = await review.approveDocumentWithEdits(db, storageRoot, draft, { actor: '测试员' })
  assert.equal(approved.status, 'approved')
  assert.equal(approved.currentVersion, 1)
  assert.equal(docvers.listVersions(db, draft.id).length, 1)
})

await test('冲突人工合并：merge 正文落库并追加 merge 版本，状态不可重复处理', async () => {
  const doc = await search.createDocument(db, storageRoot, kb, { title: '冲突文档', kind: 'wiki', body: '# 冲突文档\n\n当前版本正文', status: 'approved' })
  const proposal = review.createProposal(db, kb, { kind: 'update', docId: doc.id, title: '冲突文档', body: '# 冲突文档\n\n提议版本正文' })
  const bumped = await docvers.appendVersion(db, storageRoot, doc, { body: '# 冲突文档\n\n他人修改后的正文', changeKind: 'update', source: 'human', actor: 'other' })
  assert.equal(bumped.currentVersion, 2)
  const approved = await review.approveProposal(db, storageRoot, proposal.id, { actor: '测试员' })
  assert.ok(approved.conflict)
  assert.equal(approved.conflict.status, 'pending')
  assert.equal(review.getProposal(db, proposal.id).status, 'superseded')
  const mergeBody = '# 冲突文档\n\n当前版本正文\n\n提议版本正文（人工合并）'
  const resolved = await review.resolveConflict(db, storageRoot, approved.conflict.id, { mode: 'merge', title: '冲突文档（合并）', body: mergeBody, actor: '测试员', note: '人工合并' })
  assert.equal(resolved.conflict.status, 'merge')
  assert.ok(resolved.document)
  assert.equal(resolved.document.body, mergeBody)
  assert.equal(resolved.document.title, '冲突文档（合并）')
  assert.equal(resolved.document.status, 'approved')
  const versions = docvers.listVersions(db, doc.id)
  assert.equal(versions[0].changeKind, 'merge')
  assert.equal(versions[0].source, 'conflict')
  assert.equal(versions[0].actor, '测试员')
  await expectReject(() => review.resolveConflict(db, storageRoot, approved.conflict.id, { mode: 'merge', body: '再次合并' }), 'CONFLICT_ALREADY_RESOLVED')
})

await test('冲突处理：非法模式与缺失合并正文被拒绝', async () => {
  const doc = await search.createDocument(db, storageRoot, kb, { title: '冲突校验文档', kind: 'wiki', body: '# 冲突校验文档\n\n正文', status: 'approved' })
  const proposal = review.createProposal(db, kb, { kind: 'update', docId: doc.id, title: '冲突校验文档', body: '# 冲突校验文档\n\n新正文' })
  await docvers.appendVersion(db, storageRoot, doc, { body: '# 冲突校验文档\n\n被他人改动', changeKind: 'update', source: 'human', actor: 'other' })
  const approved = await review.approveProposal(db, storageRoot, proposal.id, { actor: '测试员' })
  assert.ok(approved.conflict)
  await expectReject(() => review.resolveConflict(db, storageRoot, approved.conflict.id, { mode: 'unknown' }), 'CONFLICT_INVALID_MODE')
  await expectReject(() => review.resolveConflict(db, storageRoot, approved.conflict.id, { mode: 'merge' }), 'CONFLICT_INVALID_INPUT')
  const kept = await review.resolveConflict(db, storageRoot, approved.conflict.id, { mode: 'keep_current', actor: '测试员' })
  assert.equal(kept.conflict.status, 'keep_current')
  assert.equal(kept.document, null)
})

await test('自动批准：默认关闭时不生效，候选保持待审', async () => {
  const doc = await search.createDocument(db, storageRoot, kb, { title: '自动批准 Wiki', kind: 'wiki', body: '# 自动批准 Wiki\n\n基线正文', status: 'approved' })
  const proposal = review.createProposal(db, kb, { kind: 'update', docId: doc.id, title: doc.title, body: '# 自动批准 Wiki\n\n基线正文\n\n新增一行' })
  const outcome = await review.autoApproveIfEligible(db, storageRoot, proposal, { enabled: false })
  assert.equal(outcome.autoApproved, false)
  assert.match(outcome.reason, /未开启/)
  assert.equal(review.getProposal(db, proposal.id).status, 'pending')
})

await test('自动批准：小差异 wiki 更新自动通过并写 auto_approve 日志', async () => {
  const doc = await search.createDocument(db, storageRoot, kb, { title: '自动批准命中', kind: 'wiki', body: '# 自动批准命中\n\n基线正文\n\n- 条目一', status: 'approved' })
  const body = '# 自动批准命中\n\n基线正文\n\n- 条目一\n- 条目二'
  const proposal = review.createProposal(db, kb, { kind: 'update', docId: doc.id, title: doc.title, body })
  const outcome = await review.autoApproveIfEligible(db, storageRoot, proposal, { enabled: true, maxDiffLines: 10, actor: 'auto:rule' })
  assert.equal(outcome.autoApproved, true)
  assert.equal(outcome.proposal.status, 'approved')
  const updated = search.getDocument(db, doc.id)
  assert.equal(updated.body, body)
  assert.equal(updated.currentVersion, 2)
  const log = review.listReviewLog(db, { kbIds, limit: 40 })
  assert.ok(log.some((entry) => entry.action === 'auto_approve' && entry.itemId === proposal.id && entry.actor === 'auto:rule'))
})

await test('自动批准：大差异、create、非 wiki、基线已变化都不自动通过', async () => {
  const doc = await search.createDocument(db, storageRoot, kb, { title: '自动批准拒绝', kind: 'wiki', body: '# 自动批准拒绝\n\n' + Array.from({ length: 20 }, (_, index) => '原始行 ' + index).join('\n'), status: 'approved' })
  const bigBody = '# 自动批准拒绝\n\n' + Array.from({ length: 20 }, (_, index) => '重写行 ' + index).join('\n')
  const bigProposal = review.createProposal(db, kb, { kind: 'update', docId: doc.id, title: doc.title, body: bigBody })
  const bigOutcome = await review.autoApproveIfEligible(db, storageRoot, bigProposal, { enabled: true, maxDiffLines: 10 })
  assert.equal(bigOutcome.autoApproved, false)
  assert.match(bigOutcome.reason, /超过阈值|基线版本/)
  const createProposal = review.createProposal(db, kb, { kind: 'create', title: '自动批准不适用', body: '# 新知识\n\n正文' })
  const createOutcome = await review.autoApproveIfEligible(db, storageRoot, createProposal, { enabled: true, maxDiffLines: 10 })
  assert.equal(createOutcome.autoApproved, false)
  assert.match(createOutcome.reason, /仅 update/)
  const memProposal = review.createProposal(db, kb, { kind: 'update', docId: memDoc.id, title: memDoc.title, body: memDoc.body + '\n补充一行' })
  const memOutcome = await review.autoApproveIfEligible(db, storageRoot, memProposal, { enabled: true, maxDiffLines: 10 })
  assert.equal(memOutcome.autoApproved, false)
  assert.match(memOutcome.reason, /仅 wiki/)
  const staleDoc = await search.createDocument(db, storageRoot, kb, { title: '自动批准基线', kind: 'wiki', body: '# 自动批准基线\n\n基线', status: 'approved' })
  const staleProposal = review.createProposal(db, kb, { kind: 'update', docId: staleDoc.id, title: staleDoc.title, body: '# 自动批准基线\n\n基线\n\n再加一行' })
  await docvers.appendVersion(db, storageRoot, staleDoc, { body: '# 自动批准基线\n\n基线（他人改动）', changeKind: 'update', source: 'human', actor: 'other' })
  const staleOutcome = await review.autoApproveIfEligible(db, storageRoot, staleProposal, { enabled: true, maxDiffLines: 10 })
  assert.equal(staleOutcome.autoApproved, false)
  assert.match(staleOutcome.reason, /基线版本已变化/)
})

// ---- HTTP 路由层（最小替身，真实契约） ----
const registry = { resolveByPath: async (path) => ({ id: 'ws-ro-uuid', path, title: '审核优化' }) }
const httpCtx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
function fakeReq(body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return { async *[Symbol.asyncIterator]() { if (text !== '') yield Buffer.from(text, 'utf8') } }
}
function fakeRes() {
  const out = { status: 0, body: null }
  return { out, writeHead(status) { out.status = status }, end(buffer) { out.body = JSON.parse(String(buffer)) } }
}
async function call(method, path, body) {
  const url = new URL('http://knowhub.internal' + path)
  const res = fakeRes()
  const handled = await handleReviewRequest({ ctx: httpCtx, config, method, path: url.pathname.replace(/^\/api/, ''), url, req: fakeReq(body), res })
  assert.equal(handled, true, '路由未处理：' + method + ' ' + path)
  return res.out
}

await test('HTTP：GET /review 返回真实计数、分页与筛选回显', async () => {
  const response = await call('GET', '/review?limit=5&page=2&kind=update')
  assert.equal(response.status, 200)
  assert.equal(response.body.value.pagination.limit, 5)
  assert.equal(response.body.value.pagination.page, 2)
  assert.equal(response.body.value.filters.kind, 'update')
  assert.ok(response.body.value.counts.proposals >= 1)
  assert.ok(response.body.value.proposals.length <= 5)
  assert.ok(response.body.value.proposals.every((item) => item.kind === 'update'))
  assert.ok(response.body.value.pendingTotal >= response.body.value.counts.total)
})

await test('HTTP：审核队列覆盖本地全部知识库，kbId 只用于缩小范围', async () => {
  const globalQueue = await call('GET', '/review?limit=100&page=1')
  assert.equal(globalQueue.status, 200)
  // 另一个工作区的知识库同样在队列范围内（修复前这里返回 403 且队列为空）
  const scoped = await call('GET', '/review?kbId=' + kbOther.id)
  assert.equal(scoped.status, 200)
  assert.ok(scoped.body.value.counts.total <= globalQueue.body.value.counts.total)
  const unknown = await call('GET', '/review?kbId=kb_missing')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.error.code, 'KB_NOT_FOUND')
  const clamped = await call('GET', '/review?limit=999&page=0')
  assert.equal(clamped.status, 200)
  assert.ok(clamped.body.value.pagination.limit <= 100)
  assert.ok(clamped.body.value.pagination.page >= 1)
})

await test('HTTP：POST /review/bulk 批量批准与上限校验', async () => {
  const one = review.createProposal(db, kb, { kind: 'create', title: 'HTTP 批量一', body: 'HTTP 批量正文一' })
  const two = review.createProposal(db, kb, { kind: 'create', title: 'HTTP 批量二', body: 'HTTP 批量正文二' })
  const response = await call('POST', '/review/bulk', { action: 'approve', items: [{ type: 'proposal', id: one.id }, { type: 'proposal', id: two.id }], note: 'HTTP 验收' })
  assert.equal(response.status, 200)
  assert.equal(response.body.value.approved, 2)
  assert.equal(response.body.value.failed, 0)
  const tooMany = await call('POST', '/review/bulk', { action: 'approve', items: Array.from({ length: 51 }, (_, index) => ({ type: 'proposal', id: 'prop_' + index })) })
  assert.equal(tooMany.status, 400)
  assert.equal(tooMany.body.error.code, 'BULK_TOO_MANY')
  const empty = await call('POST', '/review/bulk', { action: 'approve', items: [] })
  assert.equal(empty.status, 400)
  const badItem = await call('POST', '/review/bulk', { action: 'approve', items: [{ type: 'unknown', id: '' }] })
  assert.equal(badItem.status, 400)
  assert.equal(badItem.body.error.code, 'BULK_INVALID_ITEM')
})

await test('HTTP：GET /review/proposals/:id/diff 返回基线、候选与行级差异', async () => {
  const baseBody = ['# 对比文档', '', '- 第一行', '- 第二行', '- 第三行', ''].join('\n')
  const doc = await search.createDocument(db, storageRoot, kb, { title: '对比文档', kind: 'wiki', body: baseBody, status: 'approved' })
  const targetBody = ['# 对比文档', '', '- 第一行', '- 第二行已改写', '- 新增的行', '- 第三行', ''].join('\n')
  const proposal = review.createProposal(db, kb, { kind: 'update', docId: doc.id, title: '对比文档', body: targetBody, source: 'm-test' })
  const response = await call('GET', '/review/proposals/' + encodeURIComponent(proposal.id) + '/diff')
  assert.equal(response.status, 200)
  const value = response.body.value
  assert.equal(value.kind, 'proposal')
  assert.equal(value.proposal.id, proposal.id)
  assert.equal(value.base.version, doc.currentVersion)
  assert.equal(value.base.status, 'approved')
  assert.match(value.base.body, /第二行/)
  assert.equal(value.target.body, targetBody)
  assert.equal(value.target.title, '对比文档')
  assert.equal(value.document.currentVersion, doc.currentVersion)
  assert.equal(value.kb.name, kb.name)
  assert.ok(value.diff.stats.added >= 1)
  assert.ok(value.diff.stats.removed >= 1)
  assert.ok(Array.isArray(value.diff.lines) && value.diff.lines.length >= 3)
  assert.ok(value.diff.lines.some((line) => line.type === 'add'))
  assert.ok(value.diff.lines.some((line) => line.type === 'del'))
})

await test('HTTP：新增知识候选的 diff 全部为新增行且无基线文档', async () => {
  const proposal = review.createProposal(db, kb, { kind: 'create', title: '全新知识候选', body: '# 全新知识\n\n第一段\n\n第二段\n', source: 'm-test' })
  const response = await call('GET', '/review/proposals/' + encodeURIComponent(proposal.id) + '/diff')
  assert.equal(response.status, 200)
  const value = response.body.value
  assert.equal(value.document, null)
  assert.equal(value.base.body, '')
  assert.equal(value.base.version, null)
  assert.equal(value.diff.stats.removed, 0)
  assert.ok(value.diff.stats.added >= 3)
  assert.ok(value.diff.lines.every((line) => line.type === 'add'))
})

await test('HTTP：GET /review/conflicts/:id/diff 返回当前正文与冲突提议正文', async () => {
  const doc = await search.createDocument(db, storageRoot, kb, { title: '冲突对比文档', kind: 'wiki', body: '# 冲突对比文档\n\n当前正文', status: 'approved' })
  const proposal = review.createProposal(db, kb, { kind: 'update', docId: doc.id, title: '冲突对比文档', body: '# 冲突对比文档\n\n当前正文\n\n提议新增段落', source: 'm-test' })
  await docvers.appendVersion(db, storageRoot, doc, { body: '# 冲突对比文档\n\n当前正文（他人已改动）', changeKind: 'update', source: 'human', actor: 'other' })
  const approved = await review.approveProposal(db, storageRoot, proposal.id, { actor: '测试员' })
  assert.ok(approved.conflict)
  const response = await call('GET', '/review/conflicts/' + encodeURIComponent(approved.conflict.id) + '/diff')
  assert.equal(response.status, 200)
  const value = response.body.value
  assert.equal(value.kind, 'conflict')
  assert.equal(value.conflict.id, approved.conflict.id)
  assert.match(value.base.body, /他人已改动/)
  assert.match(value.target.body, /提议新增段落/)
  assert.equal(value.document.title, '冲突对比文档')
  assert.ok(value.diff.stats.added >= 1)
  assert.ok(value.diff.lines.length >= 1)
})

await test('HTTP：diff 端点对不存在对象返回 404，跨工作区对象可直接对比', async () => {
  const missing = await call('GET', '/review/proposals/prop_missing/diff')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'PROPOSAL_NOT_FOUND')
  const missingConflict = await call('GET', '/review/conflicts/conf_missing/diff')
  assert.equal(missingConflict.status, 404)
  assert.equal(missingConflict.body.error.code, 'CONFLICT_NOT_FOUND')
  const foreign = review.createProposal(db, kbOther, { kind: 'create', title: '跨工作区候选', body: '跨工作区正文' })
  const accessible = await call('GET', '/review/proposals/' + encodeURIComponent(foreign.id) + '/diff')
  assert.equal(accessible.status, 200)
  assert.equal(accessible.body.value.kb.id, kbOther.id)
  assert.equal(accessible.body.value.proposal.id, foreign.id)
})

await test('HTTP：跨工作区草稿在全局队列可见并可直接批准（桌面版 cwd 反查不到工作区）', async () => {
  const kbForeign = await store.createKnowledgeBase(db, { name: '桌面版跨工作区库', scope: 'workspace', workspaceId: 'ws-desktop-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: join(testRoot, 'ws-desktop'), workspaceTitle: '桌面' })
  const draft = await search.createDocument(db, storageRoot, kbForeign, { title: '跨工作区草稿', kind: 'wiki', body: '# 跨工作区草稿\n\n草稿正文\n', status: 'draft' })
  const queue = await call('GET', '/review?limit=100&page=1')
  assert.equal(queue.status, 200)
  assert.ok(queue.body.value.drafts.some((item) => item.id === draft.id), '跨工作区草稿应出现在待审核队列')
  assert.ok(queue.body.value.counts.drafts >= 1)
  const approve = await call('POST', '/kb/' + kbForeign.id + '/docs/' + draft.id + '/review', { action: 'approve', actor: '跨区审核员' })
  assert.equal(approve.status, 200)
  assert.equal(approve.body.value.document.status, 'approved')
})

console.log('')
if (failures.length === 0) {
  console.log('待审核优化单测全部通过：' + passed + ' 项')
  process.exit(0)
}
console.log('待审核优化单测失败：' + failures.length + ' 项，通过 ' + passed + ' 项')
for (const failure of failures) console.log('  - ' + failure.name + '\n    ' + (failure.error instanceof Error ? failure.error.stack : String(failure.error)))
process.exit(1)
