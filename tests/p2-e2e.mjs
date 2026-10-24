/**
 * P2 功能真机端到端验收：对运行中的 dsh（knowhub-dev profile, 127.0.0.1:29961）验证
 * 父级知识、文档列表真实分页、是否有帮助反馈、Markdown 导出导入、备份恢复预览、审核队列排序。
 * 用法：node tests/p2-e2e.mjs [baseUrl]
 */
import assert from 'node:assert/strict'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:29961'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(path, options = {}) {
  const init = { method: options.method ?? 'GET', headers: { accept: 'application/json' } }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(baseUrl + '/knowhub/api' + path, init)
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { throw new Error('非 JSON 响应(' + response.status + ')：' + text.slice(0, 200)) }
  return { status: response.status, body: payload, headers: response.headers, text }
}
async function raw(path) {
  const response = await fetch(baseUrl + '/knowhub/api' + path, { headers: { accept: 'text/markdown, application/json' } })
  return { status: response.status, headers: response.headers, text: await response.text() }
}
function value(result, label) {
  if (!result.body || result.body.ok !== true) throw new Error(label + ' 失败：HTTP ' + result.status + ' ' + JSON.stringify(result.body))
  return result.body.value
}

console.log('P2 真机验收 → ' + baseUrl)

const ping = value(await api('/ping'), 'ping')
for (const expected of ['POST /knowhub/api/kb/:id/docs/:docId/parent {parentId}', 'POST /knowhub/api/kb/:id/docs/:docId/feedback {helpful,reason?}', 'GET /knowhub/api/kb/:id/export?format=json', 'POST /knowhub/api/kb/:id/import {content}', 'GET /knowhub/api/backups/:id/preview']) {
  assert.ok(ping.endpoints.includes(expected), 'ping 端点应包含：' + expected)
}
console.log('  ping 端点含父级/反馈/导出导入/备份预览（共 ' + ping.endpoints.length + ' 条）')

const catalog = value(await api('/models'), 'models')
const preferred = catalog.models.find((model) => model.provider === 'amd' && model.id === 'DeepSeek-V4-Flash') ?? catalog.models[0]
const stamp = Date.now().toString(36)
const kb = value(await api('/kb', { method: 'POST', body: { name: 'P2 e2e 知识库 ' + stamp, scope: 'user', modelProvider: preferred.provider, modelId: preferred.id, modelStrategy: 'economy' } }), '创建知识库').knowledgeBase
const kbTarget = value(await api('/kb', { method: 'POST', body: { name: 'P2 e2e 导入库 ' + stamp, scope: 'user', modelProvider: preferred.provider, modelId: preferred.id, modelStrategy: 'economy' } }), '创建导入目标库').knowledgeBase
console.log('  已创建知识库：' + kb.id + ' / ' + kbTarget.id)

try {
  // ---------- 1. 父级知识 ----------
  const parent = value(await api('/kb/' + kb.id + '/docs', { method: 'POST', body: { title: 'e2e 父级知识', kind: 'wiki', body: '# e2e 父级知识\n\n父级正文 ' + stamp + '\n', status: 'approved', verifyState: 'observed' } }), '创建父级知识').document
  const childA = value(await api('/kb/' + kb.id + '/docs', { method: 'POST', body: { title: 'e2e 子级甲', kind: 'memory', body: '# e2e 子级甲\n\n子级正文\n', status: 'approved', parentId: parent.id } }), '创建子级甲').document
  const childB = value(await api('/kb/' + kb.id + '/docs', { method: 'POST', body: { title: 'e2e 子级乙', kind: 'memory', body: '# e2e 子级乙\n\n子级正文\n', status: 'approved' } }), '创建子级乙').document
  assert.equal(childA.parentId, parent.id, '创建时 parentId 应落库')
  assert.equal(childB.parentId, null)

  const children = value(await api('/kb/' + kb.id + '/docs?parentId=' + parent.id + '&limit=1&offset=0'), '按父级查询')
  assert.equal(children.parentId, parent.id)
  assert.equal(children.total, 1, '该父级下应有 1 条下级知识')
  assert.equal(children.documents.length, 1)
  assert.equal(children.documents[0].id, childA.id)
  assert.ok(children.feedback && typeof children.feedback === 'object', '列表应带反馈摘要映射')
  const roots = value(await api('/kb/' + kb.id + '/docs?parentId=root&limit=50'), '按顶层查询')
  assert.equal(roots.parentId, null)
  assert.ok(roots.documents.some((doc) => doc.id === parent.id))
  assert.ok(!roots.documents.some((doc) => doc.id === childA.id), '下级知识不应出现在顶层列表')

  const linked = value(await api('/kb/' + kb.id + '/docs/' + childB.id + '/parent', { method: 'POST', body: { parentId: parent.id } }), '设置上级')
  assert.equal(linked.document.parentId, parent.id)
  assert.match(linked.message, /已设置上级知识/)
  const detail = value(await api('/kb/' + kb.id + '/docs/' + parent.id), '父级详情')
  assert.ok(detail.parent === null, '顶层知识 parent 应为 null')
  assert.equal(detail.children.length, 2, '父级应有 2 条下级知识')
  const selfLink = await api('/kb/' + kb.id + '/docs/' + parent.id + '/parent', { method: 'POST', body: { parentId: parent.id } })
  assert.equal(selfLink.status, 400)
  assert.equal(selfLink.body.error.code, 'DOC_PARENT_INVALID')
  const unlinked = value(await api('/kb/' + kb.id + '/docs/' + childB.id + '/parent', { method: 'POST', body: { parentId: '' } }), '取消上级')
  assert.equal(unlinked.document.parentId, null)
  assert.match(unlinked.message, /已取消上级知识/)
  console.log('  父级知识：建子级 / 设上级 / 取消上级 / 自己设自己 400 全部通过（父级 2 条下级）')

  // ---------- 2. 反馈 ----------
  const fb = value(await api('/kb/' + kb.id + '/docs/' + parent.id + '/feedback', { method: 'POST', body: { helpful: true, reason: 'e2e 正好用上', actor: 'web面板' } }), '提交有帮助反馈')
  assert.equal(fb.summary.helpful, 1)
  assert.equal(fb.summary.lastReason, 'e2e 正好用上')
  const fbBad = value(await api('/kb/' + kb.id + '/docs/' + parent.id + '/feedback', { method: 'POST', body: { helpful: false, reason: 'e2e 例子太旧', actor: 'web面板' } }), '提交没帮助反馈')
  assert.equal(fbBad.summary.notHelpful, 1)
  assert.equal(fbBad.summary.total, 2)
  assert.match(fbBad.message, /没帮上忙/)
  const fbInvalid = await api('/kb/' + kb.id + '/docs/' + parent.id + '/feedback', { method: 'POST', body: { helpful: 'maybe' } })
  assert.equal(fbInvalid.status, 400)
  assert.equal(fbInvalid.body.error.code, 'FEEDBACK_INVALID')
  const detailWithFb = value(await api('/kb/' + kb.id + '/docs/' + parent.id), '反馈后的详情')
  assert.equal(detailWithFb.feedback.total, 2)
  console.log('  反馈：有帮助 + 没帮上忙累计 2 条，非法值 400 FEEDBACK_INVALID')

  // ---------- 3. 导出 ----------
  const single = await raw('/kb/' + kb.id + '/docs/' + parent.id + '/export')
  assert.equal(single.status, 200)
  assert.match(single.headers.get('content-type') ?? '', /text\/markdown/)
  assert.match(single.headers.get('content-disposition') ?? '', /attachment; filename="[\x20-\x7e]+\.md"/)
  assert.match(single.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/, '中文文件名应带 RFC 5987 filename*')
  assert.match(single.text, /<!-- knowhub:doc/)
  assert.match(single.text, /e2e 父级知识/)
  const wholeJson = value(await api('/kb/' + kb.id + '/export?format=json'), '整库导出 JSON')
  assert.ok(wholeJson.result.documentCount >= 3, '整库导出应包含至少 3 篇知识')
  assert.match(wholeJson.result.filename, /\.md$/)
  assert.match(wholeJson.result.content, /<!-- knowhub:export version=1/)
  const wholeRaw = await raw('/kb/' + kb.id + '/export')
  assert.equal(wholeRaw.status, 200)
  assert.match(wholeRaw.headers.get('content-disposition') ?? '', /attachment/)
  console.log('  导出：单篇 + 整库（' + wholeJson.result.documentCount + ' 篇，' + wholeJson.result.characters + ' 字符）均返回 Markdown 附件')

  // ---------- 4. 导入 ----------
  const imported = value(await api('/kb/' + kbTarget.id + '/import', { method: 'POST', body: { content: wholeJson.result.content, actor: 'web面板' } }), '导入 Markdown')
  assert.equal(imported.result.failed.length, 0, JSON.stringify(imported.result.failed))
  assert.ok(imported.result.created.length >= 3, '导入应新建至少 3 篇草稿')
  assert.ok(imported.result.parentLinked >= 1, '导入应恢复父级引用')
  assert.match(imported.message, /草稿需人工审核/)
  const targetDocs = value(await api('/kb/' + kbTarget.id + '/docs?limit=50'), '导入目标库列表')
  assert.ok(targetDocs.documents.length >= 3)
  assert.ok(targetDocs.documents.every((doc) => doc.status === 'draft'), '导入内容一律为草稿')
  const duplicate = value(await api('/kb/' + kbTarget.id + '/import', { method: 'POST', body: { content: wholeJson.result.content, actor: 'web面板' } }), '重复导入')
  assert.equal(duplicate.result.created.length, 0)
  assert.ok(duplicate.result.skipped.length >= 3, '重复导入应逐条跳过')
  const emptyImport = await api('/kb/' + kbTarget.id + '/import', { method: 'POST', body: { content: '   ' } })
  assert.equal(emptyImport.status, 400)
  assert.equal(emptyImport.body.error.code, 'IMPORT_EMPTY')
  console.log('  导入：新建 ' + imported.result.created.length + ' 篇草稿、恢复父级 ' + imported.result.parentLinked + ' 条；重复导入全部跳过；空内容 400')

  // ---------- 5. 备份恢复预览 ----------
  const created = value(await api('/backups', { method: 'POST', body: { kbIds: [kb.id], note: 'P2 e2e 预览 ' + stamp, actor: 'e2e' } }), '创建备份')
  const preview = value(await api('/backups/' + created.id + '/preview'), '备份预览')
  assert.equal(preview.backupId, created.id)
  assert.equal(preview.kbCount, 1)
  assert.ok(preview.docCount >= 3)
  assert.equal(preview.restoreIsMerge, true)
  const previewKb = preview.kbs.find((item) => item.id === kb.id)
  assert.ok(previewKb, '预览应包含被备份的知识库')
  assert.equal(previewKb.exists, true)
  assert.ok(previewKb.documentCount >= 3)
  assert.ok(previewKb.overlapCount >= 3, '当前库同名知识重叠数应 ≥3')
  assert.ok(Array.isArray(previewKb.sampleTitles) && previewKb.sampleTitles.length >= 1)
  assert.match(preview.note2, /合并/)
  const missingPreview = await api('/backups/bkp_missing_e2e/preview')
  assert.equal(missingPreview.status, 404)
  assert.equal(missingPreview.body.error.code, 'BACKUP_NOT_FOUND')
  console.log('  备份预览：' + preview.kbCount + ' 库 / ' + preview.docCount + ' 篇 / ' + previewKb.versionCount + ' 个版本 / 同名重叠 ' + previewKb.overlapCount)

  // ---------- 6. 审核队列排序 ----------
  const firstProposal = value(await api('/kb/' + kb.id + '/proposals', { method: 'POST', body: { kind: 'create', title: 'e2e 排序-早', body: '排序正文-早 ' + stamp, source: 'e2e-order' } }), '候选一').proposal
  await sleep(15)
  const secondProposal = value(await api('/kb/' + kb.id + '/proposals', { method: 'POST', body: { kind: 'create', title: 'e2e 排序-晚', body: '排序正文-晚 ' + stamp, source: 'e2e-order' } }), '候选二').proposal
  const newest = value(await api('/review?kbId=' + kb.id + '&order=newest&limit=50'), '最新优先')
  assert.equal(newest.filters.order, 'newest')
  assert.ok(newest.proposals.findIndex((item) => item.id === secondProposal.id) < newest.proposals.findIndex((item) => item.id === firstProposal.id), '最新优先应把后创建的排前面')
  const oldest = value(await api('/review?kbId=' + kb.id + '&order=oldest&limit=50'), '最早优先')
  assert.equal(oldest.filters.order, 'oldest')
  assert.ok(oldest.proposals.findIndex((item) => item.id === firstProposal.id) < oldest.proposals.findIndex((item) => item.id === secondProposal.id), '最早优先应把先创建的排前面')
  const bogus = value(await api('/review?kbId=' + kb.id + '&order=bogus&limit=5'), '非法排序回退')
  assert.equal(bogus.filters.order, 'newest')
  console.log('  审核队列排序：newest / oldest 顺序正确，非法值回退 newest')
} finally {
  for (const target of [kb, kbTarget]) {
    const removed = await api('/kb/' + target.id + '?mode=all', { method: 'DELETE' })
    if (removed.status !== 200) console.log('  清理失败（' + target.id + '）：HTTP ' + removed.status + ' ' + JSON.stringify(removed.body))
  }
  console.log('  已清理测试知识库')
}

console.log('\nP2 真机验收全部通过')
