/**
 * M5 真机端到端验收：对运行中的 dsh（knowhub-dev profile, 127.0.0.1:29961）走完整产品化流程。
 * 校验：总览统计、跨库知识浏览与筛选、设置读写、自动提炼真实模型调用（distill_runs + 待审核候选）、
 *       备份创建/列表、合并恢复（不覆盖当前正文）、存储迁移预检（不切换指针）、清理。
 * 用法：node tests/m5-e2e.mjs [baseUrl]
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('M5 真机验收 → ' + baseUrl)

// ---------- 1. 端点清单 ----------
const ping = value(await api('/ping'), 'ping')
for (const endpoint of ['GET /knowhub/api/overview', 'GET /knowhub/api/documents?kind=&status=&verifyState=&q=&kbId=&limit=&page=', 'GET|PATCH /knowhub/api/settings', 'POST /knowhub/api/settings/storage/migrate {target,dryRun?}', 'GET|POST /knowhub/api/backups', 'GET /knowhub/api/backups/stats', 'POST /knowhub/api/backups/:id/restore {note?}', 'POST /knowhub/api/distill {text,kbId?}', 'GET /knowhub/api/distill/runs?limit=']) {
  assert.ok(ping.endpoints.includes(endpoint), '缺少端点：' + endpoint)
}
console.log('  ping 端点含 M5 九件套（共 ' + ping.endpoints.length + ' 条）')

const current = value(await api('/current-workspace'), 'current-workspace')
assert.ok(current.workspaceId, '必须能识别当前工作区')
console.log('  当前工作区：' + current.title + '（' + current.workspaceId + '）')

const catalog = value(await api('/models'), 'models')
const preferred = catalog.models.find((model) => model.provider === 'amd' && model.id === 'DeepSeek-V4-Flash')
  ?? catalog.models.find((model) => model.provider !== 'deepseek-account')
  ?? catalog.models[0]
console.log('  绑定模型：' + preferred.provider + ' / ' + preferred.id)

// ---------- 2. 建库与知识 ----------
const name = 'M5 真机验收 ' + new Date().toISOString().slice(11, 19)
const kb = value(await api('/kb', {
  method: 'POST',
  body: { name, scope: 'workspace', workspaceId: current.workspaceId, modelProvider: preferred.provider, modelId: preferred.id, modelStrategy: 'economy' },
}), '创建知识库').knowledgeBase
console.log('  已创建知识库：' + kb.id)

const docBody = '# 部署约定\n\n生产环境使用只读挂载运行，升级前必须先跑迁移脚本，并在发布记录里写明回滚命令。\n\n## 证据\n\n- 来自 docs/deploy.md\n'
const doc = value(await api('/kb/' + kb.id + '/docs', {
  method: 'POST',
  body: { title: '部署约定（M5 e2e）', kind: 'wiki', body: docBody, status: 'approved', verifyState: 'observed', tags: ['部署'] },
}), '创建已批准文档')
const docId = doc.document.id
console.log('  已创建已批准文档：' + docId)

// ---------- 3. 总览 ----------
const overview = value(await api('/overview'), 'overview')
assert.ok(overview.counts.knowledgeBases >= 1, '总览应至少统计到 1 个可见知识库')
assert.ok(overview.documents.approved >= 1, '总览应统计到已批准知识')
assert.ok(overview.storageRoot, '总览应返回存储路径')
assert.ok(Array.isArray(overview.recentDocs) && overview.recentDocs.length >= 1, '总览应返回最近更新知识')
assert.ok(Array.isArray(overview.recentActivity), '总览应返回最近操作日志')
console.log('  总览：可见知识库 ' + overview.counts.knowledgeBases + ' / 已批准 ' + overview.documents.approved + ' / 待审核 ' + overview.pendingTotal + ' / 最近更新 ' + overview.recentDocs.length)

// ---------- 4. 跨库知识浏览 ----------
const browse = value(await api('/documents?kind=wiki&status=approved&limit=5'), 'documents')
assert.ok(browse.total >= 1, '跨库浏览应命中已批准 wiki')
assert.ok(browse.documents.every((item) => item.kind === 'wiki' && item.status === 'approved'), '筛选条件必须生效')
assert.ok(browse.counts.byKind.length >= 1 && browse.counts.byStatus.length >= 1, '应返回类型/状态分布')
const filtered = value(await api('/documents?q=' + encodeURIComponent('部署约定（M5 e2e）') + '&limit=5'), 'documents q')
assert.ok(filtered.documents.some((item) => item.id === docId), '关键词检索应命中刚建的知识')
console.log('  跨库浏览：total=' + browse.total + ' 类型分布=' + browse.counts.byKind.map((item) => item.kind + ':' + item.count).join(',') + ' 关键词命中=' + filtered.documents.length)

// ---------- 5. 设置读写 ----------
const before = value(await api('/settings'), 'settings')
const original = before.settings
const patched = value(await api('/settings', {
  method: 'PATCH',
  body: { defaultStrategy: 'economy', autoDistill: true, distillMinChars: 220, backupKeep: 7, excludeDirs: ['e2e-excluded'] },
}), 'PATCH settings')
assert.equal(patched.settings.defaultStrategy, 'economy')
assert.equal(patched.settings.autoDistill, true)
assert.equal(patched.settings.distillMinChars, 220)
assert.equal(patched.settings.backupKeep, 7)
assert.deepEqual(patched.settings.excludeDirs, ['e2e-excluded'])
const reread = value(await api('/settings'), 'settings reread')
assert.equal(reread.settings.autoDistill, true, '设置必须持久化')
assert.ok(reread.storage.storageRoot, '设置快照应返回存储位置')
assert.equal(reread.storage.restartRequiredForPointerChange, true)
console.log('  设置：已写入并读回（storage 来源=' + reread.storage.source + '）')

// 非法设置被拒绝
const bad = await api('/settings', { method: 'PATCH', body: { distillMinChars: 10 } })
assert.equal(bad.status, 400)
assert.equal(bad.body.error.code, 'SETTING_INVALID')
console.log('  设置：非法阈值被拒绝（SETTING_INVALID）')

// ---------- 6. 自动提炼（真实模型调用） ----------
const distillText = [
  '本次会话确认：KnowHub 的存储迁移必须先创建备份，再切换位置指针，重启后生效。',
  '生产中只读挂载运行，升级前必须跑迁移脚本，并在发布记录写回滚命令。',
  '已经验证：内容哈希是增量更新的权威判据，Git 只提供提交级信号。',
  '失败过的做法：直接覆盖已批准文档会被审核流拒绝，必须生成候选等人确认。',
  '约定：所有自动生成的知识一律先进入待审核队列，不直接成为正式知识。',
  '验证结果：M5 设置页读写的默认策略、提炼阈值、备份保留数量都在重启后保持，读回值与写入值一致。',
  '观察事实：备份文件以 gzip 压缩保存在存储根的 backups 目录，恢复采用合并语义，同名同内容跳过，正文不同只生成候选。',
  '待确认事项：演示实例里 Git 模式仍不可用，因为宿主进程无法 spawn git，所以当前以内容哈希作为权威变更判据。',
].join('\n')
const runAt = Date.now()
const distilled = value(await api('/distill', { method: 'POST', body: { text: distillText, kbId: kb.id, source: 'e2e', actor: 'e2e' } }), 'distill')
assert.equal(distilled.status, 'success', '提炼应成功：' + JSON.stringify(distilled.error))
assert.ok(distilled.created.length >= 1, '应至少产生 1 条待审核候选')
assert.equal(distilled.knowledgeBaseId, kb.id, '必须使用指定知识库')
assert.equal(distilled.model.provider, preferred.provider, '必须使用知识库绑定的 provider')
assert.equal(distilled.model.model, preferred.id, '必须使用知识库绑定的 model')
console.log('  自动提炼：' + distilled.created.length + ' 条候选，模型 ' + distilled.model.provider + '/' + distilled.model.model + '，耗时 ' + distilled.elapsedMs + 'ms')
const proposals = distilled.created.map((item) => item.proposalId)
const queue = value(await api('/review'), 'review')
for (const proposalId of proposals) {
  assert.ok(queue.proposals.some((item) => item.id === proposalId), '候选必须出现在待审核队列：' + proposalId)
}
const runsResult = value(await api('/distill/runs?limit=5'), 'distill runs')
const runs = runsResult.runs
assert.ok(runs.length >= 1, '应记录提炼运行')
assert.equal(runs[0].status, 'success')
assert.ok(runs[0].createdCount >= 1)
assert.equal(runs[0].modelId, preferred.id)
console.log('  自动提炼：distill_runs 记录 ' + runs.length + ' 条（最新 created=' + runs[0].createdCount + '）')

// 未批准前不得成为正式知识
const official = value(await api('/kb/' + kb.id + '/docs?limit=200'), 'kb docs')
const officialTitles = JSON.stringify(official)
for (const created of distilled.created) {
  assert.ok(!officialTitles.includes(created.title), '未批准的候选不得出现在正式知识里：' + created.title)
}
console.log('  自动提炼：候选未进入正式知识（仍需人工审核）')

// ---------- 7. 备份与恢复 ----------
const backup = value(await api('/backups', { method: 'POST', body: { note: 'M5 e2e 备份', actor: 'e2e' } }), 'create backup')
assert.ok(backup.id && backup.kbCount >= 1 && backup.docCount >= 1, '备份应包含知识库与知识')
assert.ok(backup.bytes > 0)
const backupList = value(await api('/backups'), 'list backups')
assert.ok(backupList.backups.some((item) => item.id === backup.id && item.exists), '备份列表应包含新备份且文件存在')
assert.ok(backupList.stats.count >= 1)
const stats = value(await api('/backups/stats'), 'backup stats')
assert.ok(stats.count >= 1 && stats.dir, '备份统计应返回目录')
console.log('  备份：' + backup.id + '（' + backup.kbCount + ' 库 / ' + backup.docCount + ' 条 / ' + backup.bytes + ' 字节）')

const restored = value(await api('/backups/' + backup.id + '/restore', { method: 'POST', body: { actor: 'e2e', note: 'M5 e2e 合并恢复' } }), 'restore backup')
assert.ok(restored.backupId === backup.id)
assert.ok(restored.preBackupId, '开启自动备份时应生成恢复点')
assert.ok(restored.skipped >= 1, '内容相同应跳过而不是重复创建')
const docAfter = value(await api('/kb/' + kb.id + '/docs/' + docId), 'doc after restore')
assert.equal(docAfter.document.status, 'approved', '恢复不得改变已批准状态')
console.log('  恢复：跳过 ' + restored.skipped + ' 条相同知识，候选 ' + restored.proposals + ' 条，恢复点 ' + restored.preBackupId)

// ---------- 8. 存储迁移预检（不切换指针） ----------
const target = join(tmpdir(), 'knowhub-m5-e2e-' + Date.now().toString(36))
const dry = value(await api('/settings/storage/migrate', { method: 'POST', body: { target, dryRun: true } }), 'migrate dry run')
assert.equal(dry.dryRun, true)
assert.ok(dry.willCopy.files >= 1 && dry.willCopy.bytes > 0, '预检应统计将复制的文件')
assert.equal(dry.to, target)
assert.ok(dry.pointerFile, '预检应返回位置指针路径')
const afterDry = value(await api('/settings'), 'settings after dry run')
assert.notEqual(afterDry.storage.storageRoot, target, '预检不得切换存储指针')
console.log('  存储迁移预检：将复制 ' + dry.willCopy.files + ' 个文件 / ' + dry.willCopy.bytes + ' 字节，指针未切换')

// ---------- 9. 清理与设置回滚 ----------
await api('/settings', {
  method: 'PATCH',
  body: { defaultStrategy: original.defaultStrategy, autoDistill: original.autoDistill, distillMinChars: original.distillMinChars, backupKeep: original.backupKeep, excludeDirs: original.excludeDirs },
})
const removed = value(await api('/kb/' + kb.id + '?mode=all', { method: 'DELETE' }), 'delete kb')
assert.equal(removed.result.mode, 'all')
const gone = await api('/kb/' + kb.id)
assert.equal(gone.status, 404)
const settingsRestored = value(await api('/settings'), 'settings restored')
assert.equal(settingsRestored.settings.defaultStrategy, original.defaultStrategy, '设置应回滚')
console.log('  清理：知识库已删除，设置已回滚')

console.log('M5 真机验收全部通过')
