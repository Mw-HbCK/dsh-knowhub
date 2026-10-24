/**
 * 待审核优化真机端到端验收：对运行中的 dsh（knowhub-dev profile, 127.0.0.1:29961）验证审核队列真实计数、
 * 筛选分页、候选去重、批量审核、草稿编辑后批准、候选/冲突的文档对比数据、冲突人工合并、自动批准规则与设置项。
 * 用法：node tests/review-e2e.mjs [baseUrl]
 */
import assert from 'node:assert/strict'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:29961'

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
  return { status: response.status, body: payload }
}
function value(result, label) {
  if (!result.body || result.body.ok !== true) throw new Error(label + ' 失败：HTTP ' + result.status + ' ' + JSON.stringify(result.body))
  return result.body.value
}

console.log('待审核优化真机验收 → ' + baseUrl)

const ping = value(await api('/ping'), 'ping')
assert.ok(ping.endpoints.includes('POST /knowhub/api/review/bulk {action,items}'), 'ping 端点应包含批量审核')
assert.ok(ping.endpoints.includes('GET /knowhub/api/review'), 'ping 端点应包含审核队列')
console.log('  ping 端点含批量审核与审核队列（共 ' + ping.endpoints.length + ' 条）')

const current = value(await api('/current-workspace'), 'current-workspace')
assert.ok(current.workspaceId, '必须能识别当前工作区')
const catalog = value(await api('/models'), 'models')
const preferred = catalog.models.find((model) => model.provider === 'amd' && model.id === 'DeepSeek-V4-Flash') ?? catalog.models[0]
const kb = value(await api('/kb', { method: 'POST', body: { name: '待审核优化 e2e ' + Date.now().toString(36), scope: 'workspace', workspaceId: current.workspaceId, modelProvider: preferred.provider, modelId: preferred.id, modelStrategy: 'economy' } }), '创建知识库').knowledgeBase
console.log('  已创建知识库：' + kb.id)

const wikiBody = '# 审核优化 Wiki\n\n本项目使用适配层 + 核心层结构。\n\n- 内容哈希是增量判定权威\n'
const wiki = value(await api('/kb/' + kb.id + '/docs', { method: 'POST', body: { title: '审核优化 Wiki', kind: 'wiki', body: wikiBody, status: 'approved', verifyState: 'observed' } }), '创建 wiki 文档').document
console.log('  已创建已批准 wiki 文档：' + wiki.id)

// ---------- 1. 候选去重 ----------
const dupBody = '# 去重候选\n\n同一段待审核正文 ' + Date.now()
const first = value(await api('/kb/' + kb.id + '/proposals', { method: 'POST', body: { kind: 'create', title: '去重候选', body: dupBody, source: 'e2e' } }), '创建候选一')
const second = value(await api('/kb/' + kb.id + '/proposals', { method: 'POST', body: { kind: 'create', title: '去重候选', body: dupBody, source: 'e2e' } }), '创建候选二')
assert.equal(second.proposal.id, first.proposal.id, '相同待审内容应复用同一候选')
assert.equal(second.autoApproved, false, 'create 候选不得自动批准')
console.log('  去重：重复提交返回同一候选 ' + first.proposal.id)

// ---------- 2. 队列真实计数 / 筛选 / 分页 ----------
const created = []
for (let index = 0; index < 5; index += 1) {
  const result = value(await api('/kb/' + kb.id + '/proposals', { method: 'POST', body: { kind: 'create', title: 'e2e 候选 ' + index, body: 'e2e 候选正文 ' + index + ' OPTQ-' + index, source: 'e2e-batch' } }), '批量候选 ' + index)
  created.push(result.proposal)
}
const allQueue = value(await api('/review?kbId=' + kb.id + '&limit=2&page=1'), '审核队列第一页')
assert.ok(allQueue.counts.proposals >= 6, '候选计数应为真实全量（≥6），实际 ' + allQueue.counts.proposals)
assert.equal(allQueue.proposals.length, 2, 'limit=2 时只返回 2 条')
assert.equal(allQueue.pagination.page, 1)
assert.ok(allQueue.pendingTotal >= allQueue.counts.total, 'pendingTotal 应覆盖当前筛选计数')
const page2 = value(await api('/review?kbId=' + kb.id + '&limit=2&page=2'), '审核队列第二页')
assert.equal(page2.pagination.page, 2)
assert.notEqual(page2.proposals[0].id, allQueue.proposals[0].id, '第二页内容应与第一页不同')
assert.equal(page2.counts.proposals, allQueue.counts.proposals, '分页不应影响计数')
const byKind = value(await api('/review?kbId=' + kb.id + '&kind=create&limit=50'), '按类型筛选')
assert.ok(byKind.proposals.length >= 6 && byKind.proposals.every((item) => item.kind === 'create'))
const byQ = value(await api('/review?kbId=' + kb.id + '&q=OPTQ-3'), '关键词筛选')
assert.equal(byQ.counts.proposals, 1, '关键词筛选应只有一个候选')
const bySource = value(await api('/review?kbId=' + kb.id + '&source=e2e-batch&limit=50'), '来源筛选')
assert.ok(bySource.proposals.length >= 5)
assert.equal(bySource.pendingTotal, allQueue.pendingTotal, 'pendingTotal 不应随筛选变化')
console.log('  队列：候选 ' + allQueue.counts.proposals + ' / 当前页 ' + allQueue.proposals.length + ' / pendingTotal ' + allQueue.pendingTotal + ' / 关键词命中 1')

// ---------- 3. 批量审核 ----------
const bulk = value(await api('/review/bulk', { method: 'POST', body: { action: 'approve', items: [{ type: 'proposal', id: created[0].id }, { type: 'proposal', id: created[1].id }], note: 'e2e 批量批准' } }), '批量批准')
assert.equal(bulk.approved, 2)
assert.equal(bulk.failed, 0)
assert.equal(bulk.results.length, 2)
const bulkFail = value(await api('/review/bulk', { method: 'POST', body: { action: 'reject', items: [{ type: 'proposal', id: created[2].id }, { type: 'proposal', id: 'prop_missing_e2e' }] } }), '批量拒绝含失败项')
assert.equal(bulkFail.rejected, 1)
assert.equal(bulkFail.failed, 1)
assert.match(bulkFail.results[1].message, /不存在/)
const tooMany = await api('/review/bulk', { method: 'POST', body: { action: 'approve', items: Array.from({ length: 51 }, (_, index) => ({ type: 'proposal', id: 'prop_' + index })) } })
assert.equal(tooMany.status, 400)
assert.equal(tooMany.body.error.code, 'BULK_TOO_MANY')
console.log('  批量审核：批准 2 / 拒绝 1 且单项失败不阻断 / 51 条被拒 BULK_TOO_MANY')

// ---------- 4. 草稿编辑后批准 ----------
const draft = value(await api('/kb/' + kb.id + '/docs', { method: 'POST', body: { title: 'e2e 草稿', kind: 'wiki', body: '# e2e 草稿\n\n原始正文', status: 'draft' } }), '创建草稿').document
const edited = value(await api('/kb/' + kb.id + '/docs/' + draft.id + '/review', { method: 'POST', body: { action: 'approve', title: 'e2e 草稿（已编辑）', body: '# e2e 草稿（已编辑）\n\n审核时补充的正文', note: 'e2e 编辑后批准' } }), '草稿编辑后批准')
assert.equal(edited.document.status, 'approved')
assert.equal(edited.document.title, 'e2e 草稿（已编辑）')
assert.match(edited.document.body, /审核时补充的正文/)
assert.equal(edited.document.currentVersion, 2, '有编辑时应追加版本')
const draftVersions = value(await api('/kb/' + kb.id + '/docs/' + draft.id + '/versions'), '草稿版本')
assert.equal(draftVersions.versions[0].changeKind, 'update')
assert.equal(draftVersions.versions[0].source, 'review')
console.log('  草稿编辑后批准：已批准 + 追加 review 版本 v' + edited.document.currentVersion)

// ---------- 5. 冲突人工合并 ----------
const conflictDoc = value(await api('/kb/' + kb.id + '/docs', { method: 'POST', body: { title: 'e2e 冲突文档', kind: 'wiki', body: '# e2e 冲突文档\n\n当前正文', status: 'approved' } }), '创建冲突文档').document
const conflictProposal = value(await api('/kb/' + kb.id + '/proposals', { method: 'POST', body: { kind: 'update', docId: conflictDoc.id, title: conflictDoc.title, body: '# e2e 冲突文档\n\n提议正文' } }), '创建更新候选').proposal
value(await api('/kb/' + kb.id + '/docs/' + conflictDoc.id, { method: 'PATCH', body: { body: '# e2e 冲突文档\n\n他人修改后的正文', note: 'e2e 模拟他人修改' } }), '他人修改文档')
// ---------- 4.5 文档对比页数据（候选 / 冲突 / 新增知识） ----------
const conflictProposalDiff = value(await api('/review/proposals/' + conflictProposal.id + '/diff'), '候选对比数据')
assert.equal(conflictProposalDiff.kind, 'proposal')
assert.equal(conflictProposalDiff.base.version, 2, '基线应取文档当前版本')
assert.match(conflictProposalDiff.base.body, /他人修改后的正文/)
assert.match(conflictProposalDiff.target.body, /提议正文/)
assert.ok(conflictProposalDiff.diff.stats.added >= 1 && conflictProposalDiff.diff.stats.removed >= 1, '修改候选应同时包含新增与删除行')
assert.ok(conflictProposalDiff.diff.lines.some((line) => line.type === 'add') && conflictProposalDiff.diff.lines.some((line) => line.type === 'del'))
assert.equal(conflictProposalDiff.kb.name, kb.name)
assert.equal(conflictProposalDiff.document.id, conflictDoc.id)
const createdDiff = value(await api('/review/proposals/' + created[3].id + '/diff'), '新增知识对比数据')
assert.equal(createdDiff.document, null)
assert.equal(createdDiff.base.body, '')
assert.equal(createdDiff.diff.stats.removed, 0)
assert.ok(createdDiff.diff.stats.added >= 1)
assert.ok(createdDiff.diff.lines.every((line) => line.type === 'add'), '新增知识应全部为新增行')
const diffMissing = await api('/review/proposals/prop_missing_e2e/diff')
assert.equal(diffMissing.status, 404)
assert.equal(diffMissing.body.error.code, 'PROPOSAL_NOT_FOUND')
const diffMissingConflict = await api('/review/conflicts/conf_missing_e2e/diff')
assert.equal(diffMissingConflict.status, 404)
assert.equal(diffMissingConflict.body.error.code, 'CONFLICT_NOT_FOUND')
console.log('  对比页数据：修改候选 +' + conflictProposalDiff.diff.stats.added + '/-' + conflictProposalDiff.diff.stats.removed + ' 行，新增候选全为新增行，缺失对象返回 404')

const conflictOutcome = value(await api('/review/proposals/' + conflictProposal.id + '/approve', { method: 'POST', body: { note: 'e2e 批准冲突候选' } }), '批准冲突候选')
assert.ok(conflictOutcome.conflict && conflictOutcome.conflict.status === 'pending', '基线变化应生成冲突项')
const conflictDiff = value(await api('/review/conflicts/' + conflictOutcome.conflict.id + '/diff'), '冲突对比数据')
assert.equal(conflictDiff.kind, 'conflict')
assert.match(conflictDiff.base.body, /他人修改后的正文/)
assert.match(conflictDiff.target.body, /提议正文/)
assert.equal(conflictDiff.document.id, conflictDoc.id)
assert.ok(conflictDiff.diff.lines.length >= 1)
console.log('  冲突对比页数据：当前正文 vs 冲突提议正文，共 ' + conflictDiff.diff.lines.length + ' 行差异')
const merged = value(await api('/review/conflicts/' + conflictOutcome.conflict.id + '/resolve', { method: 'POST', body: { mode: 'merge', title: 'e2e 冲突文档（合并）', body: '# e2e 冲突文档（合并）\n\n当前正文\n\n提议正文（人工合并）', note: 'e2e 人工合并' } }), '人工合并')
assert.equal(merged.conflict.status, 'merge')
assert.match(merged.document.body, /人工合并/)
const mergedVersions = value(await api('/kb/' + kb.id + '/docs/' + conflictDoc.id + '/versions'), '合并版本')
assert.equal(mergedVersions.versions[0].changeKind, 'merge')
assert.equal(mergedVersions.versions[0].source, 'conflict')
const again = await api('/review/conflicts/' + conflictOutcome.conflict.id + '/resolve', { method: 'POST', body: { mode: 'keep_current' } })
assert.equal(again.status, 409)
console.log('  冲突人工合并：merge 落库为合并版本，重复处理返回 409')

// ---------- 6. 自动批准规则 ----------
const originalSettings = value(await api('/settings'), 'settings').settings
value(await api('/settings', { method: 'PATCH', body: { autoApprove: true, autoApproveMaxDiffLines: 10, reviewerName: 'e2e审核员' } }), '开启自动批准')
const autoDoc = value(await api('/kb/' + kb.id + '/docs', { method: 'POST', body: { title: 'e2e 自动批准文档', kind: 'wiki', body: '# e2e 自动批准文档\n\n基线正文\n\n- 条目一', status: 'approved' } }), '创建自动批准文档').document
const smallChange = value(await api('/kb/' + kb.id + '/proposals', { method: 'POST', body: { kind: 'update', docId: autoDoc.id, title: autoDoc.title, body: '# e2e 自动批准文档\n\n基线正文\n\n- 条目一\n- 条目二' } }), '小差异更新候选')
assert.equal(smallChange.autoApproved, true, '小差异 wiki 更新应自动批准：' + JSON.stringify(smallChange))
assert.equal(smallChange.proposal.status, 'approved')
const autoDocAfter = value(await api('/kb/' + kb.id + '/docs/' + autoDoc.id), '自动批准后的文档').document
assert.match(autoDocAfter.body, /条目二/)
assert.equal(autoDocAfter.currentVersion, 2)
const bigBody = '# e2e 自动批准文档\n\n' + Array.from({ length: 20 }, (_, index) => '重写行 ' + index).join('\n')
const bigChange = value(await api('/kb/' + kb.id + '/proposals', { method: 'POST', body: { kind: 'update', docId: autoDoc.id, title: autoDoc.title, body: bigBody } }), '大差异更新候选')
assert.equal(bigChange.autoApproved, false, '大差异不得自动批准')
assert.equal(bigChange.proposal.status, 'pending')
const createChange = value(await api('/kb/' + kb.id + '/proposals', { method: 'POST', body: { kind: 'create', title: 'e2e 自动批准不适用', body: '# 新知识\n\n正文' } }), 'create 候选')
assert.equal(createChange.autoApproved, false, 'create 不得自动批准')
const log = value(await api('/review/log?limit=50'), '审核日志')
assert.ok(log.entries.some((entry) => entry.action === 'auto_approve' && entry.itemId === smallChange.proposal.id && entry.actor === 'auto:rule'), '应记录 auto_approve 日志')
console.log('  自动批准：小差异命中并写 auto_approve（actor=auto:rule），大差异与 create 转人工')

// ---------- 7. 清理与设置回滚 ----------
value(await api('/settings', { method: 'PATCH', body: { autoApprove: originalSettings.autoApprove, autoApproveMaxDiffLines: originalSettings.autoApproveMaxDiffLines, reviewerName: originalSettings.reviewerName } }), '回滚设置')
const removed = value(await api('/kb/' + kb.id + '?mode=all', { method: 'DELETE' }), '删除知识库')
assert.equal(removed.result.mode, 'all')
const gone = await api('/kb/' + kb.id)
assert.equal(gone.status, 404)
const restored = value(await api('/settings'), 'settings restored').settings
assert.equal(restored.autoApprove, originalSettings.autoApprove)
assert.equal(restored.reviewerName, originalSettings.reviewerName)
console.log('  清理：知识库已删除，设置已回滚')

console.log('待审核优化真机验收全部通过')
