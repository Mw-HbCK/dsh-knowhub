/**
 * M2 真机端到端验收：对运行中的 dsh（knowhub-dev profile, 127.0.0.1:29961）走完整初始化流程。
 * 校验：真实工作区、真实模型目录、按知识库绑定模型实际调用（llm_calls 铁证）、
 *       Wiki 候选为草稿、来源文件关联、索引落库、任务进度/日志、清理删除。
 * 用法：node tests/m2-e2e.mjs [baseUrl]
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
  if (!result.body || result.body.ok !== true) {
    throw new Error(label + ' 失败：HTTP ' + result.status + ' ' + JSON.stringify(result.body))
  }
  return result.body.value
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('M2 真机验收 → ' + baseUrl)

const ping = value(await api('/ping'), 'ping')
console.log('  宿主端点数量：' + ping.endpoints.length)

const current = value(await api('/current-workspace'), 'current-workspace')
assert.ok(current.workspaceId, '必须能识别当前工作区')
console.log('  当前工作区：' + current.title + '（' + current.workspaceId + '）')

const catalog = value(await api('/models'), 'models')
assert.ok(catalog.available, '模型目录必须可用')
assert.ok(catalog.models.length > 0, '必须至少有一个真实模型')
const preferred = catalog.models.find((model) => model.provider === 'amd' && model.id === 'DeepSeek-V4-Flash')
  ?? catalog.models.find((model) => model.provider !== 'deepseek-account')
  ?? catalog.models[0]
console.log('  绑定模型：' + preferred.provider + ' / ' + preferred.id + '（目录共 ' + catalog.models.length + ' 个模型）')

const name = 'M2 真机验收 ' + new Date().toISOString().slice(11, 19)
const created = value(await api('/kb', {
  method: 'POST',
  body: { name, scope: 'workspace', workspaceId: current.workspaceId, modelProvider: preferred.provider, modelId: preferred.id, modelStrategy: 'economy' },
}), '创建知识库')
const kb = created.knowledgeBase
console.log('  已创建知识库：' + kb.id + '（模型 ' + kb.modelProvider + '/' + kb.modelId + '，策略 ' + kb.modelStrategy + '）')
assert.equal(kb.modelId, preferred.id, '知识库必须保存所选模型 ID')

const started = value(await api('/kb/' + kb.id + '/initialize', { method: 'POST', body: {} }), '启动初始化')
assert.equal(started.duplicate, false, '首次启动不应是重复任务')
const taskId = started.task.id
console.log('  初始化任务：' + taskId)

let task = null
const deadline = Date.now() + 240000
let lastStage = ''
while (Date.now() < deadline) {
  const detail = value(await api('/tasks/' + taskId), '查询任务')
  task = detail.task
  if (task.stage && task.stage !== lastStage) {
    lastStage = task.stage
    console.log('    [' + task.progress + '%] ' + task.stage)
  }
  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') break
  await sleep(1000)
}
assert.ok(task, '任务必须存在')
assert.equal(task.status, 'succeeded', '初始化任务必须成功：' + task.errorCode + ' ' + (task.errorDetail ?? ''))
assert.equal(task.progress, 100)
assert.ok(Array.isArray(task.logs) && task.logs.length >= 3, '任务必须有可诊断日志')

const detail = value(await api('/kb/' + kb.id), '知识库详情')
assert.equal(detail.knowledgeBase.status, 'ready', '初始化成功后知识库状态应为 ready')
const docs = value(await api('/kb/' + kb.id + '/docs?limit=50'), '知识条目')
assert.ok(docs.documents.length > 0, '必须生成 Wiki 候选')
assert.ok(docs.documents.every((doc) => doc.status === 'draft'), '自动生成的 Wiki 必须是待审核草稿')
console.log('  生成候选草稿 ' + docs.documents.length + ' 篇：' + docs.documents.map((doc) => doc.title).join('、'))

const calls = value(await api('/kb/' + kb.id + '/llm-calls?limit=20'), '模型调用记录')
assert.ok(calls.calls.length >= 1, '必须有模型调用记录')
assert.ok(calls.calls.every((call) => call.provider === preferred.provider && call.model === preferred.id),
  '每条调用记录都必须使用知识库绑定的模型，不能静默改用其它模型')
assert.ok(calls.calls.every((call) => call.purpose !== null), '调用记录必须带用途')
console.log('  模型调用 ' + calls.calls.length + ' 次，全部为 ' + preferred.provider + '/' + preferred.id + '：' +
  calls.calls.map((call) => call.purpose + '(' + call.promptTokens + '→' + call.completionTokens + ' tokens, ' + call.latencyMs + 'ms)').join('、'))

const files = value(await api('/kb/' + kb.id + '/files'), '项目索引')
assert.ok(files.summary.fileCount > 0, '必须建立项目文件索引')
assert.ok(files.files.length > 0, '索引必须包含文件明细')
console.log('  项目索引：' + files.summary.fileCount + ' 个文件，已哈希 ' + files.summary.hashedCount + '，语言 ' + files.summary.byLanguage.slice(0, 4).map((item) => item.language + ':' + item.count).join(' '))

// 来源关联（草稿详情里应能看到 sources）
const first = docs.documents[0]
const one = value(await api('/kb/' + kb.id + '/docs/' + first.id), '草稿详情')
assert.ok(Array.isArray(one.sources) && one.sources.length > 0, 'Wiki 必须关联来源文件')
console.log('  Wiki 来源文件：' + one.sources.map((source) => source.ref).slice(0, 5).join('、'))

// 幂等：再次初始化不应产生重复任务或重复文档
const again = value(await api('/kb/' + kb.id + '/initialize', { method: 'POST', body: {} }), '重复初始化')
let againTask = null
if (again.duplicate) {
  againTask = again.task
  console.log('  重复启动被正确复用：' + againTask.id + '（duplicate=true）')
} else {
  const id2 = again.task.id
  const end = Date.now() + 180000
  while (Date.now() < end) {
    againTask = value(await api('/tasks/' + id2), '查询重复任务').task
    if (['succeeded', 'failed', 'cancelled'].includes(againTask.status)) break
    await sleep(1000)
  }
  assert.equal(againTask.status, 'succeeded', '重跑必须成功（幂等：同主题不重复建文档）')
  const docs2 = value(await api('/kb/' + kb.id + '/docs?limit=50'), '重跑后知识条目')
  assert.equal(docs2.documents.length, docs.documents.length, '重跑不应重复创建同主题文档')
  console.log('  重跑幂等：文档数仍为 ' + docs2.documents.length + '，未覆盖已有内容')
}

const removed = value(await api('/kb/' + kb.id + '?mode=all', { method: 'DELETE' }), '清理知识库')
console.log('  清理：' + JSON.stringify(removed.result))
const gone = await api('/kb/' + kb.id)
assert.equal(gone.status, 404, '删除后详情应为 404')

console.log('')
console.log('M2 真机验收通过。')
