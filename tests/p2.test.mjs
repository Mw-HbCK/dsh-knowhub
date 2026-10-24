/**
 * P2 功能验收测试（进程内运行；沙箱禁止子进程管道，故不用 node --test runner）。
 * 覆盖：父级知识（层级/环/深度）、文档列表真实分页与计数、是否有帮助反馈、
 *       Markdown 导出与导入（落草稿/跳过同名/父级恢复）、备份恢复预览、审核队列排序、HTTP 路由层。
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const rootPath = decodeURIComponent(new URL('../.build/test-data/p2-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const testRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
const storageRoot = join(testRoot, 'storage')
const dshHome = join(testRoot, 'dsh-home')
await mkdir(storageRoot, { recursive: true })
await mkdir(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome

const { openDatabase, run } = await load('db/db.js')
const store = await load('kb/store.js')
const search = await load('search.js')
const feedback = await load('feedback.js')
const transfer = await load('transfer.js')
const backup = await load('backup.js')
const review = await load('review.js')
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
const expectReject = async (fn, code) => {
  try { await fn() } catch (error) {
    if (code) assert.equal(error.code, code, '期望错误码 ' + code + '，实际 ' + error.code + '（' + error.message + '）')
    return error
  }
  throw new Error('期望失败但成功了')
}

const db = openDatabase(storageRoot)
const kb = await store.createKnowledgeBase(db, { name: 'P2 验收知识库', scope: 'workspace', workspaceId: 'ws-ro-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot, workspacePath: join(testRoot, 'ws-ro'), workspaceTitle: 'P2 验收' })
const kbOther = await store.createKnowledgeBase(db, { name: '另一个知识库', scope: 'workspace', workspaceId: 'ws-other-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot, workspacePath: join(testRoot, 'ws-other'), workspaceTitle: '另一个' })
const kbIds = [kb.id]
const config = { storageRoot }

const mkDoc = (title, body, extra = {}) => search.createDocument(db, storageRoot, kb, Object.assign({ title, kind: 'memory', body, status: 'approved' }, extra))

console.log('P2 单测开始：' + testRoot)

await test('父级知识：创建时写入 parentId，列表可按顶层/父级过滤并真实计数', async () => {
  const parent = await mkDoc('父级知识', '# 父级知识\n\n顶层正文\n')
  const child = await mkDoc('子级知识', '# 子级知识\n\n下级正文\n', { parentId: parent.id })
  assert.equal(child.parentId, parent.id)
  const roots = search.listDocuments(db, { kbIds, parentId: null })
  assert.ok(roots.some((doc) => doc.id === parent.id))
  assert.ok(!roots.some((doc) => doc.id === child.id))
  const children = search.listDocuments(db, { kbIds, parentId: parent.id })
  assert.equal(children.length, 1)
  assert.equal(children[0].id, child.id)
  assert.equal(search.countDocumentList(db, { kbIds, parentId: null }), roots.length)
  assert.equal(search.countDocumentList(db, { kbIds, parentId: parent.id }), 1)
  assert.equal(search.documentDepth(db, parent.id), 1)
  assert.equal(search.documentDepth(db, child.id), 2)
})

await test('父级知识：非法上级（自己/不存在/跨库/成环/层级过深）全部拒绝', async () => {
  const selfErr = await expectReject(async () => {
    const doc = await mkDoc('自我引用', '# 自我引用\n\n正文\n')
    search.resolveParentId(db, kb.id, doc.id, doc.id)
  }, 'DOC_PARENT_INVALID')
  assert.match(selfErr.message, /不能把自己设为上级/)
  const missingErr = await expectReject(async () => {
    const doc = await mkDoc('上级不存在', '# 上级不存在\n\n正文\n')
    search.resolveParentId(db, kb.id, doc.id, 'doc_missing_parent')
  }, 'DOC_PARENT_INVALID')
  assert.match(missingErr.message, /上级知识不存在/)
  const foreign = await search.createDocument(db, storageRoot, kbOther, { title: '跨库知识', kind: 'memory', body: '# 跨库知识\n\n正文\n' })
  const crossErr = await expectReject(async () => {
    const doc = await mkDoc('跨库引用', '# 跨库引用\n\n正文\n')
    search.resolveParentId(db, kb.id, doc.id, foreign.id)
  }, 'DOC_PARENT_INVALID')
  assert.match(crossErr.message, /同一个知识库/)

  const chain = []
  let previous = null
  for (let index = 1; index <= search.MAX_DOC_DEPTH; index += 1) {
    previous = await search.createDocument(db, storageRoot, kb, { title: '层级 ' + index, kind: 'memory', body: '# 层级 ' + index + '\n\n正文\n', parentId: previous === null ? null : previous.id })
    chain.push(previous)
  }
  assert.equal(search.documentDepth(db, chain[chain.length - 1].id), search.MAX_DOC_DEPTH)
  const tooDeepErr = await expectReject(async () => { search.resolveParentId(db, kb.id, null, chain[chain.length - 1].id) }, 'DOC_PARENT_INVALID')
  assert.match(tooDeepErr.message, /父级层级过深/)
})

await test('父级知识：把上级设成自己的下级形成环时拒绝', async () => {
  const a = await mkDoc('环-A', '# 环-A\n\n正文\n')
  const b = await mkDoc('环-B', '# 环-B\n\n正文\n', { parentId: a.id })
  const c = await mkDoc('环-C', '# 环-C\n\n正文\n', { parentId: b.id })
  const error = await expectReject(async () => { search.resolveParentId(db, kb.id, a.id, c.id) }, 'DOC_PARENT_INVALID')
  assert.match(error.message, /不能把下级知识设为上级|存在环/)
})

await test('反馈：是否有帮助写入摘要，重复统计与最近理由正确', async () => {
  const doc = await mkDoc('反馈知识', '# 反馈知识\n\n正文\n', { kind: 'wiki' })
  assert.equal(feedback.feedbackSummary(db, doc.id).total, 0)
  feedback.addFeedback(db, { id: doc.id, kbId: doc.kbId }, { helpful: true, actor: 'web面板' })
  feedback.addFeedback(db, { id: doc.id, kbId: doc.kbId }, { helpful: true, reason: '正好用上', actor: 'web面板' })
  const added = feedback.addFeedback(db, { id: doc.id, kbId: doc.kbId }, { helpful: false, reason: '例子太旧', actor: 'web面板' })
  assert.equal(added.helpful, false)
  const summary = feedback.feedbackSummary(db, doc.id)
  assert.equal(summary.helpful, 2)
  assert.equal(summary.notHelpful, 1)
  assert.equal(summary.total, 3)
  assert.equal(summary.lastReason, '例子太旧')
  const batch = feedback.feedbackSummaries(db, [doc.id])
  assert.equal(batch[doc.id].total, 3)
  assert.equal(feedback.listFeedback(db, doc.id, 2).length, 2)
})

await test('反馈：helpful 与理由非法时返回 FEEDBACK_INVALID', async () => {
  const doc = await mkDoc('反馈校验', '# 反馈校验\n\n正文\n')
  await expectReject(async () => feedback.addFeedback(db, { id: doc.id, kbId: doc.kbId }, { helpful: 'maybe' }), 'FEEDBACK_INVALID')
  await expectReject(async () => feedback.addFeedback(db, { id: doc.id, kbId: doc.kbId }, { helpful: true, reason: '长'.repeat(501) }), 'FEEDBACK_INVALID')
  assert.equal(feedback.parseHelpful('yes'), true)
  assert.equal(feedback.parseHelpful(0), false)
})

await test('导出：Markdown 含格式头与每篇的元信息块', async () => {
  const parent = await mkDoc('导出父级', '# 导出父级\n\n正文一\n', { kind: 'wiki', tags: ['架构'] })
  await mkDoc('导出子级', '# 导出子级\n\n正文二\n', { parentId: parent.id })
  const exported = transfer.exportKbMarkdown(db, kb)
  assert.match(exported.filename, /\.md$/)
  assert.match(exported.filename, /^P2-验收知识库-\d{8}\.md$/)
  assert.match(exported.content, /<!-- knowhub:export version=1 kbId=/)
  assert.ok(exported.documentCount >= 2)
  const blocks = exported.content.match(/<!-- knowhub:doc/g) ?? []
  assert.equal(blocks.length, exported.documentCount)
  assert.match(exported.content, /title: "导出父级"/)
  assert.match(exported.content, /tags: \["架构"\]/)
})

await test('导入：导出内容再导入到新库，一律落草稿并恢复父级引用', async () => {
  const source = await mkDoc('往返父级', '# 往返父级\n\n正文甲\n', { kind: 'wiki' })
  await mkDoc('往返子级', '# 往返子级\n\n正文乙\n', { parentId: source.id })
  const exported = transfer.exportKbMarkdown(db, kb)
  const target = await store.createKnowledgeBase(db, { name: '导入目标库', scope: 'user', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot })
  const result = await transfer.importKbMarkdown(db, storageRoot, target, { content: exported.content, actor: 'tester' })
  assert.equal(result.failed.length, 0, JSON.stringify(result.failed))
  assert.ok(result.created.length >= 2)
  assert.ok(result.parentLinked >= 1)
  const imported = (await import('../lib/host/search.js')).listDocuments(db, { kbIds: [target.id] })
  assert.ok(imported.every((doc) => doc.status === 'draft'))
  const child = imported.find((doc) => doc.title === '往返子级')
  assert.ok(child && child.parentId !== null)
})

await test('导入：同名知识跳过、非法类型回落 memory、空内容与超限报错', async () => {
  const target = await store.createKnowledgeBase(db, { name: '导入校验库', scope: 'user', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot })
  const content = [
    '<!-- knowhub:export version=1 kbId="kb_x" kbName="测试" scope="user" exportedAt="2026-01-01T00:00:00.000Z" documentCount=1 -->',
    '',
    '# 知识库导出：测试',
    '',
    '<!-- knowhub:doc',
    'title: "陌生类型知识"',
    'kind: "not-a-kind"',
    'status: "approved"',
    'tags: ["导入"]',
    '-->',
    '# 陌生类型知识',
    '',
    '正文内容',
    '',
  ].join('\n')
  const first = await transfer.importKbMarkdown(db, storageRoot, target, { content, actor: 'tester' })
  assert.equal(first.created.length, 1)
  assert.equal(first.created[0].kind, 'memory')
  const stored = (await import('../lib/host/search.js')).listDocuments(db, { kbIds: [target.id] })
  assert.equal(stored[0].status, 'draft')
  const second = await transfer.importKbMarkdown(db, storageRoot, target, { content, actor: 'tester' })
  assert.equal(second.created.length, 0)
  assert.equal(second.skipped.length, 1)
  assert.match(second.skipped[0].reason, /同名知识已存在/)
  await expectReject(async () => transfer.importKbMarkdown(db, storageRoot, target, { content: '   ' }), 'IMPORT_EMPTY')
  await expectReject(async () => transfer.importKbMarkdown(db, storageRoot, target, { content: 'x'.repeat(transfer.IMPORT_MAX_CHARS + 5) }), 'IMPORT_TOO_LARGE')
})

await test('备份预览：只读解析出库数、文档数、状态分布与同名重叠', async () => {
  const created = backup.createBackup(db, storageRoot, { note: 'P2 预览验收' })
  const preview = backup.previewBackup(db, storageRoot, created.id)
  assert.equal(preview.backupId, created.id)
  assert.equal(preview.kbCount, created.kbCount)
  assert.equal(preview.docCount, created.docCount)
  assert.equal(preview.restoreIsMerge, true)
  assert.ok(preview.kbs.length >= 1)
  const self = preview.kbs.find((item) => item.id === kb.id)
  assert.ok(self)
  assert.equal(self.exists, true)
  assert.ok(self.documentCount >= 1)
  assert.ok(typeof self.statusBreakdown.approved === 'number')
  assert.ok(self.overlapCount >= 1)
  assert.ok(Array.isArray(self.sampleTitles))
  assert.match(preview.note2, /合并/)
  const missing = await expectReject(async () => backup.previewBackup(db, storageRoot, 'bkp_missing'), 'BACKUP_NOT_FOUND')
  assert.match(missing.message, /备份不存在/)
})

await test('审核队列：order=newest/oldest/updated 切换排序', async () => {
  const now = Date.now()
  const older = review.createProposal(db, kb, { kind: 'create', title: '排序候选-早', body: '排序正文-早' })
  const newer = review.createProposal(db, kb, { kind: 'create', title: '排序候选-晚', body: '排序正文-晚' })
  run(db, 'UPDATE proposals SET created_at = ? WHERE id = ?', [now - 50000, older.id])
  run(db, 'UPDATE proposals SET created_at = ? WHERE id = ?', [now - 10000, newer.id])
  const newestFirst = review.reviewQueue(db, kbIds, { limit: 100, order: 'newest' })
  assert.equal(newestFirst.filters.order, 'newest')
  const newestTitles = newestFirst.proposals.map((item) => item.title)
  assert.ok(newestTitles.indexOf('排序候选-晚') < newestTitles.indexOf('排序候选-早'))
  const oldestFirst = review.reviewQueue(db, kbIds, { limit: 100, order: 'oldest' })
  assert.equal(oldestFirst.filters.order, 'oldest')
  const oldestTitles = oldestFirst.proposals.map((item) => item.title)
  assert.ok(oldestTitles.indexOf('排序候选-早') < oldestTitles.indexOf('排序候选-晚'))
  const bogus = review.reviewQueue(db, kbIds, { limit: 10, order: 'bogus' })
  assert.equal(bogus.filters.order, 'newest')
  review.rejectProposal(db, older.id, { actor: 'tester' })
  review.rejectProposal(db, newer.id, { actor: 'tester' })
})

// ---- HTTP 路由层（最小替身，真实契约） ----
const registry = { resolveByPath: async (path) => ({ id: 'ws-ro-uuid', path, title: 'P2 验收' }) }
const httpCtx = { get: (name) => (name === 'workspaceRegistry' ? registry : undefined) }
function fakeReq(body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return { async *[Symbol.asyncIterator]() { if (text !== '') yield Buffer.from(text, 'utf8') } }
}
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
async function call(method, path, body) {
  const url = new URL('http://knowhub.internal' + path)
  const res = fakeRes()
  const handled = await handleKbRequest({ ctx: httpCtx, config, method, path: url.pathname.replace(/^\/api/, ''), url, req: fakeReq(body), res })
  assert.equal(handled, true, '路由未处理：' + method + ' ' + path)
  return res.out
}

await test('HTTP：文档列表支持 parentId/limit/offset 并返回真实 total 与反馈摘要', async () => {
  const parent = await mkDoc('HTTP 父级', '# HTTP 父级\n\n正文\n')
  await mkDoc('HTTP 子级一', '# HTTP 子级一\n\n正文\n', { parentId: parent.id })
  await mkDoc('HTTP 子级二', '# HTTP 子级二\n\n正文\n', { parentId: parent.id })
  const response = await call('GET', '/kb/' + kb.id + '/docs?parentId=' + parent.id + '&limit=1&offset=0')
  assert.equal(response.status, 200)
  const value = response.body.value
  assert.equal(value.parentId, parent.id)
  assert.equal(value.limit, 1)
  assert.equal(value.total, 2)
  assert.equal(value.documents.length, 1)
  assert.ok(value.feedback && typeof value.feedback === 'object')
  const roots = await call('GET', '/kb/' + kb.id + '/docs?parentId=root&limit=5')
  assert.equal(roots.status, 200)
  assert.equal(roots.body.value.parentId, null)
  assert.ok(roots.body.value.total >= 1)
})

await test('HTTP：设置/取消上级知识返回消息，详情带上级与下级', async () => {
  const parent = await mkDoc('HTTP 上级', '# HTTP 上级\n\n正文\n')
  const child = await mkDoc('HTTP 下级', '# HTTP 下级\n\n正文\n')
  const linked = await call('POST', '/kb/' + kb.id + '/docs/' + child.id + '/parent', { parentId: parent.id })
  assert.equal(linked.status, 200)
  assert.equal(linked.body.value.document.parentId, parent.id)
  assert.match(linked.body.value.message, /已设置上级知识/)
  const detail = await call('GET', '/kb/' + kb.id + '/docs/' + parent.id)
  assert.equal(detail.status, 200)
  assert.ok(detail.body.value.children.some((item) => item.id === child.id))
  assert.ok(detail.body.value.feedback && typeof detail.body.value.feedback.total === 'number')
  const cleared = await call('POST', '/kb/' + kb.id + '/docs/' + child.id + '/parent', { parentId: '' })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.value.document.parentId, null)
  assert.match(cleared.body.value.message, /已取消上级知识/)
  const invalid = await call('POST', '/kb/' + kb.id + '/docs/' + child.id + '/parent', { parentId: child.id })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.error.code, 'DOC_PARENT_INVALID')
})

await test('HTTP：反馈接口写入并返回摘要', async () => {
  const doc = await mkDoc('HTTP 反馈', '# HTTP 反馈\n\n正文\n')
  const response = await call('POST', '/kb/' + kb.id + '/docs/' + doc.id + '/feedback', { helpful: true, reason: '面板反馈', actor: 'web面板' })
  assert.equal(response.status, 200)
  assert.equal(response.body.value.summary.helpful, 1)
  assert.equal(response.body.value.summary.lastReason, '面板反馈')
  assert.match(response.body.value.message, /有帮助/)
  const bad = await call('POST', '/kb/' + kb.id + '/docs/' + doc.id + '/feedback', { helpful: 'nope' })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'FEEDBACK_INVALID')
})

await test('HTTP：导出单篇与整库返回 Markdown 附件', async () => {
  const doc = await mkDoc('HTTP 导出', '# HTTP 导出\n\n正文\n')
  const single = await call('GET', '/kb/' + kb.id + '/docs/' + doc.id + '/export')
  assert.equal(single.status, 200)
  assert.match(single.headers['content-type'], /text\/markdown/)
  assert.match(single.headers['content-disposition'], /attachment; filename="[\x20-\x7e]+\.md"/)
  // 回归：中文标题的文件名不能让 HTTP 头出现非 latin-1 字符（曾导致 500 Invalid character in header content）
  assert.match(single.headers['content-disposition'], /filename\*=UTF-8''/)
  assert.match(single.headers['content-disposition'], /^[\x20-\x7e]+$/, 'content-disposition 只能是 ASCII')
  assert.match(single.text, /<!-- knowhub:doc/)
  assert.match(single.text, /HTTP 导出/)
  const whole = await call('GET', '/kb/' + kb.id + '/export')
  assert.equal(whole.status, 200)
  assert.match(whole.headers['content-type'], /text\/markdown/)
  assert.match(whole.text, /<!-- knowhub:export version=1/)
  const asJson = await call('GET', '/kb/' + kb.id + '/export?format=json')
  assert.equal(asJson.status, 200)
  assert.ok(asJson.body.value.result.documentCount >= 1)
})

await test('HTTP：导入 Markdown 新建草稿并返回结果消息', async () => {
  const target = await store.createKnowledgeBase(db, { name: 'HTTP 导入库', scope: 'user', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot })
  const content = [
    '<!-- knowhub:doc',
    'title: "HTTP 导入知识"',
    'kind: "wiki"',
    'status: "approved"',
    'tags: []',
    '-->',
    '# HTTP 导入知识',
    '',
    '导入正文',
    '',
  ].join('\n')
  const response = await call('POST', '/kb/' + target.id + '/import', { content, actor: 'web面板' })
  assert.equal(response.status, 200)
  assert.equal(response.body.value.result.created.length, 1)
  assert.match(response.body.value.message, /草稿需人工审核/)
  const empty = await call('POST', '/kb/' + target.id + '/import', { content: '' })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.error.code, 'IMPORT_EMPTY')
})

await test('HTTP：GET /review 透传 order 并回显', async () => {
  const { handleReviewRequest } = await load('review/route.js')
  const url = new URL('http://knowhub.internal/review?limit=10&order=oldest')
  const res = fakeRes()
  const handled = await handleReviewRequest({ ctx: httpCtx, config, method: 'GET', path: '/review', url, req: fakeReq(undefined), res })
  assert.equal(handled, true)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.body.value.filters.order, 'oldest')
})

await test('HTTP：待审核知识对比以上一版为基线，单版知识全部视为新增', async () => {
  const { handleReviewRequest } = await load('review/route.js')
  const reviewCall = async (path) => {
    const url = new URL('http://knowhub.internal' + path)
    const res = fakeRes()
    const handled = await handleReviewRequest({ ctx: httpCtx, config, method: 'GET', path: url.pathname, url, req: fakeReq(undefined), res })
    assert.equal(handled, true, '路由未处理：GET ' + path)
    return res.out
  }

  // 只有一版历史：没有可比基线，正文全部算新增
  const single = await mkDoc('HTTP 对比单版', '# HTTP 对比单版\n\n只有一版正文\n')
  const one = await reviewCall('/review/documents/' + single.id + '/diff')
  assert.equal(one.status, 200)
  const singleValue = one.body.value
  assert.equal(singleValue.kind, 'document')
  assert.equal(singleValue.document.id, single.id)
  assert.equal(singleValue.kb.id, kb.id)
  assert.equal(singleValue.base.version, null)
  assert.equal(singleValue.base.body, '')
  assert.equal(singleValue.diff.stats.removed, 0)
  assert.ok(singleValue.diff.stats.added >= 2)
  assert.ok(singleValue.diff.lines.every((line) => line.type === 'add'), '单版知识不应出现 equal 行')

  // 两版：基线取上一版正文（而不是空行）
  const first = await mkDoc('HTTP 对比两版', '# HTTP 对比两版\n\n第一版正文\n第二版将被替换\n')
  const updated = await review.updateDocumentByHuman(db, storageRoot, first, { title: 'HTTP 对比两版', body: '# HTTP 对比两版\n\n第一版正文\n新的第二版正文\n' }, 'tester')
  assert.equal(updated.currentVersion, 2)
  const two = await reviewCall('/review/documents/' + updated.id + '/diff')
  assert.equal(two.status, 200)
  const twoValue = two.body.value
  assert.equal(twoValue.document.currentVersion, 2)
  assert.equal(twoValue.base.version, 1)
  assert.match(twoValue.base.body, /第二版将被替换/)
  assert.match(twoValue.target.body, /新的第二版正文/)
  assert.equal(twoValue.diff.stats.added, 1)
  assert.equal(twoValue.diff.stats.removed, 1)
  assert.ok(twoValue.diff.stats.unchanged >= 3)

  const missing = await reviewCall('/review/documents/doc_missing/diff')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'DOC_NOT_FOUND')

  const foreign = await search.createDocument(db, storageRoot, kbOther, { title: 'HTTP 越权知识', kind: 'memory', body: '越权正文', status: 'approved' })
  const forbidden = await reviewCall('/review/documents/' + foreign.id + '/diff')
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.body.error.code, 'KB_FORBIDDEN')
})

console.log('')
if (failures.length === 0) {
  console.log('P2 单测全部通过：' + passed + ' 项')
  process.exit(0)
}
console.log('P2 单测失败：' + failures.length + ' 项，通过 ' + passed + ' 项')
for (const failure of failures) console.log('  - ' + failure.name + '\n    ' + (failure.error instanceof Error ? failure.error.stack : String(failure.error)))
process.exit(1)
