/**
 * 审计补充真机验收（A1 检索标签过滤 + 重复合并、A2 排除目录、A3 版本/差异/恢复接口）。
 * 对运行中的 dsh（knowhub-dev profile, 127.0.0.1:29961）执行，全部走真实 HTTP 接口。
 * 用法：node tests/refine-e2e.mjs [baseUrl]
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

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

console.log('审计补充真机验收 → ' + baseUrl)

const ping = value(await api('/ping'), 'ping')
assert.ok(ping.endpoints.some((endpoint) => endpoint.includes('/search?q=&tag=')), 'ping 应列出带 tag 参数的检索端点')
console.log('  ping 端点 ' + ping.endpoints.length + ' 条，包含 tag 检索端点')

const current = value(await api('/current-workspace'), 'current-workspace')
assert.ok(current.workspaceId, '必须能识别当前工作区')
console.log('  当前工作区：' + current.title + '（' + current.workspaceId + '）')

const catalog = value(await api('/models'), 'models')
const preferred = catalog.models.find((model) => model.provider === 'amd' && model.id === 'DeepSeek-V4-Flash')
  ?? catalog.models.find((model) => model.provider !== 'deepseek-account') ?? catalog.models[0]
console.log('  绑定模型：' + preferred.provider + ' / ' + preferred.id)

const baseSettings = value(await api('/settings'), 'settings').settings
const kbName = 'A1A2A3 审计验收 ' + new Date().toISOString().slice(11, 19)
const kb = value(await api('/kb', {
  method: 'POST',
  body: { name: kbName, scope: 'workspace', workspaceId: current.workspaceId, modelProvider: preferred.provider, modelId: preferred.id, modelStrategy: 'economy' },
}), 'create-kb').knowledgeBase
console.log('  建库：' + kb.id + '（' + kb.name + '）')

const token = '重复内容哈希审计号'
const sharedBody = '# ' + token + '\n\n这段正文用于验证内容哈希相同的多条知识在检索结果里被合并为一条，并记录被合并的数量与来源库。\n'
const createdA = value(await api('/kb/' + kb.id + '/docs', {
  method: 'POST',
  body: { title: '审计重复条目一', kind: 'memory', body: sharedBody, status: 'approved', verifyState: 'observed', tags: ['自动提炼', 'Architecture'] },
}), 'create-doc-A')
const createdB = value(await api('/kb/' + kb.id + '/docs', {
  method: 'POST',
  body: { title: '审计重复条目二', kind: 'memory', body: sharedBody, status: 'approved', verifyState: 'observed', tags: ['自动提炼'] },
}), 'create-doc-B')
console.log('  建两条同内容知识：' + createdA.document.id + ' / ' + createdB.document.id)

// ---------- A1：标签过滤 ----------
const taggedOnly = value(await api('/search?q=' + encodeURIComponent(token) + '&status=approved&tag=architecture'), 'search-tag-lower')
assert.equal(taggedOnly.hits.length, 1, '小写标签架构应只命中带 Architecture 标签的文档')
assert.equal(taggedOnly.hits[0].id, createdA.document.id)
console.log('  标签过滤（小写 architecture）：命中 1 条→' + taggedOnly.hits[0].title)

const bothTags = value(await api('/search?q=' + encodeURIComponent(token) + '&status=approved&tag=' + encodeURIComponent('自动提炼') + '&tag=architecture'), 'search-tag-and')
assert.equal(bothTags.hits.length, 1, 'AND 语义：两个标签同时命中才返回')
console.log('  标签过滤（AND：自动提炼 + architecture）：命中 1 条')

// ---------- A1：重复结果合并 ----------
const duplicates = value(await api('/search?q=' + encodeURIComponent(token) + '&status=approved&tag=' + encodeURIComponent('自动提炼')), 'search-duplicates')
assert.equal(duplicates.hits.length, 1, '同内容哈希的两条知识应被合并为一条')
assert.ok(duplicates.duplicatesMerged >= 1, '应报告合并数量')
assert.ok((duplicates.hits[0].duplicates ?? 0) >= 1, '命中项应记录被合并数量')
assert.ok((duplicates.hits[0].duplicateKbIds ?? []).includes(kb.id), '命中项应记录同内容的来源库')
assert.ok(duplicates.total >= duplicates.hits.length, '原始命中总数应不小于合并后条数')
console.log('  重复合并：原始 ' + duplicates.total + ' 条 → 合并后 ' + duplicates.hits.length + ' 条（合并 ' + duplicates.duplicatesMerged + ' 条）')

// ---------- A3：版本历史 / 差异 / 恢复（新 UI 调用的接口） ----------
const docId = createdA.document.id
value(await api('/kb/' + kb.id + '/docs/' + docId, {
  method: 'PATCH',
  body: { title: '审计重复条目一', body: sharedBody + '\n第二段补充说明：版本历史与差异必须真实可用。\n', note: '面板人工编辑' },
}), 'patch-doc')
const versions2 = value(await api('/kb/' + kb.id + '/docs/' + docId + '/versions'), 'versions')
assert.equal(versions2.versions.length, 2, '编辑后应有 2 个版本')
assert.equal(versions2.currentVersion, 2)
const versionContent = value(await api('/kb/' + kb.id + '/docs/' + docId + '/versions/1'), 'version-content')
assert.ok(versionContent.version.content.includes(token), '第 1 版内容应可读取')
const diff = value(await api('/kb/' + kb.id + '/docs/' + docId + '/diff?from=1&to=2'), 'diff')
assert.ok(diff.stats.added >= 1, '差异统计应显示新增行')
const restored = value(await api('/kb/' + kb.id + '/docs/' + docId + '/restore', { method: 'POST', body: { version: 1, actor: 'web面板', note: '从版本历史恢复' } }), 'restore')
assert.ok(restored.message.includes('恢复'), '恢复应返回明确说明')
const versions3 = value(await api('/kb/' + kb.id + '/docs/' + docId + '/versions'), 'versions-after-restore')
assert.equal(versions3.currentVersion, 3, '恢复应以新版本方式记录')
const latest = versions3.versions.find((item) => item.version === 3)
assert.equal(latest.changeKind, 'restore')
console.log('  版本历史：v1 可读 / 差异 +' + diff.stats.added + ' 行 / 恢复第 1 版 → 当前第 ' + versions3.currentVersion + ' 版（changeKind=' + latest.changeKind + '）')

// ---------- A2：用户自定义排除目录真正生效 ----------
const excludedName = 'e2e-exclude-' + Date.now().toString(36)
const excludedDir = join(current.path, excludedName)
await mkdir(excludedDir, { recursive: true })
await writeFile(join(excludedDir, 'sample.ts'), 'export const excluded = true\n', 'utf8')
value(await api('/settings', { method: 'PATCH', body: { excludeDirs: [excludedName] } }), 'patch-settings')
const settingsAfter = value(await api('/settings'), 'settings').settings
assert.deepEqual(settingsAfter.excludeDirs, [excludedName])
const scanResult = value(await api('/scan', { method: 'POST', body: { path: current.path } }), 'scan')
const scan = scanResult.scan
assert.ok(scan.skippedExcluded >= 1, '扫描应报告被用户排除的文件数')
assert.ok(!scan.sample.some((path) => path.includes(excludedName)), '被排除目录的文件不应出现在扫描样本里')
assert.ok(scan.excludedDirs.includes(excludedName), '扫描结果应列出被排除目录')
console.log('  排除目录：skippedExcluded=' + scan.skippedExcluded + ' excludedDirs 含 ' + excludedName + '，文件 ' + scan.fileCount + ' 个')

value(await api('/settings', { method: 'PATCH', body: { excludeDirs: baseSettings.excludeDirs } }), 'restore-settings')
await rm(excludedDir, { recursive: true, force: true })
console.log('  设置已恢复：' + JSON.stringify(value(await api('/settings'), 'settings').settings.excludeDirs))

// ---------- 清理 ----------
const removed = value(await api('/kb/' + kb.id + '?mode=all', { method: 'DELETE' }), 'delete-kb')
assert.equal(removed.result.mode, 'all')
assert.equal((await api('/kb/' + kb.id)).status, 404)
console.log('  清理完成：知识库已删除（mode=' + removed.result.mode + '）')

console.log('')
console.log('审计补充真机验收全部通过（A1 标签过滤+重复合并 / A2 排除目录 / A3 版本差异恢复）')
