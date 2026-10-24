/**
 * M4 真机端到端验收：对运行中的 dsh（knowhub-dev profile, 127.0.0.1:29961）走完整增量更新流程。
 * 校验：新增端点、Git 探针、基线检查点、哈希检测、影响面、绑定模型真实调用（llm_calls 铁证）、
 *       已批准文档只产生候选、审核后生效、来源删除→过时候选、结构性变更→需重新检查、无变更不调模型。
 * 用法：node tests/m4-e2e.mjs [baseUrl]
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
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
  if (!result.body || result.body.ok !== true) {
    throw new Error(label + ' 失败：HTTP ' + result.status + ' ' + JSON.stringify(result.body))
  }
  return result.body.value
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

console.log('M4 真机验收 → ' + baseUrl)

const ping = value(await api('/ping'), 'ping')
for (const endpoint of ['POST /knowhub/api/kb/:id/incremental {workspaceId?,dryRun?}', 'GET /knowhub/api/kb/:id/git', 'GET /knowhub/api/kb/:id/changes', 'GET /knowhub/api/git-probe?path=']) {
  assert.ok(ping.endpoints.includes(endpoint), '缺少端点：' + endpoint)
}
console.log('  ping 端点包含增量更新三件套（共 ' + ping.endpoints.length + ' 条）')

const current = value(await api('/current-workspace'), 'current-workspace')
assert.ok(current.workspaceId, '必须能识别当前工作区')
const workspaceRoot = current.path
console.log('  当前工作区：' + current.title + '（' + current.workspaceId + '）')

const gitProbe = value(await api('/git-probe?path=' + encodeURIComponent(workspaceRoot)), 'git-probe')
console.log('  Git 探针：available=' + gitProbe.git.available + ' isRepo=' + gitProbe.git.isRepo + ' → ' + gitProbe.note)

const catalog = value(await api('/models'), 'models')
const preferred = catalog.models.find((model) => model.provider === 'amd' && model.id === 'DeepSeek-V4-Flash')
  ?? catalog.models.find((model) => model.provider !== 'deepseek-account')
  ?? catalog.models[0]
console.log('  绑定模型：' + preferred.provider + ' / ' + preferred.id)

// 准备一个真实文件作为 Wiki 文档的来源（放在 workspace 内，最后清理）
const sampleRel = 'docs/e2e-m4-sample.md'
const sampleAbs = join(workspaceRoot, 'docs', 'e2e-m4-sample.md')
await mkdir(join(workspaceRoot, 'docs'), { recursive: true })
await writeFile(sampleAbs, '# 示例模块\n\n这是 M4 真机验收使用的示例模块，导出 foo 与 bar。\n', 'utf8')

const name = 'M4 真机验收 ' + new Date().toISOString().slice(11, 19)
const created = value(await api('/kb', {
  method: 'POST',
  body: { name, scope: 'workspace', workspaceId: current.workspaceId, modelProvider: preferred.provider, modelId: preferred.id, modelStrategy: 'economy' },
}), '创建知识库')
const kb = created.knowledgeBase
console.log('  已创建知识库：' + kb.id)

const docBody = '# 架构说明\n\n示例模块负责导出 foo 与 bar 两个能力，供上层索引器调用。\n\n## 关键点\n\n- 只读 Git 命令检测变更\n- 内容哈希作为权威判定\n'
const docCreated = value(await api('/kb/' + kb.id + '/docs', {
  method: 'POST',
  body: { title: '示例模块架构说明', kind: 'wiki', body: docBody, status: 'approved', verifyState: 'observed', sources: [sampleRel] },
}), '创建已批准文档')
const docId = docCreated.document.id
assert.equal(docCreated.sourcesAdded, 1, '来源文件必须被记录')
console.log('  已创建已批准文档：' + docId + '（来源 ' + sampleRel + '）')

const pollTask = async (taskId, deadlineMs = 300000) => {
  const deadline = Date.now() + deadlineMs
  let last = null
  let lastStage = ''
  while (Date.now() < deadline) {
    last = value(await api('/tasks/' + taskId), '查询任务').task
    if (last.stage && last.stage !== lastStage) { lastStage = last.stage; console.log('    [' + last.progress + '%] ' + last.stage) }
    if (last.status === 'succeeded' || last.status === 'failed' || last.status === 'cancelled') return last
    await sleep(1500)
  }
  throw new Error('任务超时：' + taskId)
}

const startIncremental = async (body) => {
  const started = value(await api('/kb/' + kb.id + '/incremental', { method: 'POST', body }), '启动增量更新')
  const task = await pollTask(started.task.id)
  console.log('  任务 ' + task.id.slice(-8) + ' 结束：' + task.status + '（进度 ' + task.progress + '%，阶段 ' + task.stage + '）' + (task.errorCode ? ' 错误码 ' + task.errorCode : ''))
  return task
}

// 1) 首次 preview：尚无检查点，应提示只建立基线
const firstPlan = value(await api('/kb/' + kb.id + '/incremental', { method: 'POST', body: { dryRun: true } }), '首次预览')
assert.equal(firstPlan.baseline, true, '首次运行应为基线模式')
assert.equal(firstPlan.plannedModelCalls, 0, '基线不调用模型')
console.log('  首次预览：baseline=' + firstPlan.baseline + ' 变更=' + firstPlan.changeCount + ' 预计模型调用=' + firstPlan.plannedModelCalls)

// 2) 建立基线
const baselineTask = await startIncremental({})
assert.equal(baselineTask.status, 'succeeded', '基线任务必须成功')

const callsAfterBaseline = value(await api('/kb/' + kb.id + '/llm-calls?limit=50'), 'llm-calls').calls
assert.equal(callsAfterBaseline.length, 0, '基线阶段不应有模型调用')
console.log('  基线完成，模型调用数：0')

// 3) 无变更：不应调用模型
const zeroPlan = value(await api('/kb/' + kb.id + '/incremental', { method: 'POST', body: { dryRun: true } }), '无变更预览')
assert.equal(zeroPlan.changeCount, 0, '无变更时 changeCount 必须为 0')
assert.equal(zeroPlan.affectedCount, 0)
console.log('  无变更预览：变更 0，受影响文档 0')

// 4) 修改来源文件：只影响该文档，已批准文档只产生候选
await writeFile(sampleAbs, '# 示例模块\n\n这是 M4 真机验收使用的示例模块，现已导出 foo、bar 与 baz（新增能力）。\n', 'utf8')
const updatePlan = value(await api('/kb/' + kb.id + '/incremental', { method: 'POST', body: { dryRun: true } }), '变更预览')
console.log('  修改后预览：模式=' + updatePlan.mode + ' 变更=' + updatePlan.changeCount + ' 受影响=' + updatePlan.affectedCount + ' 预计模型调用=' + updatePlan.plannedModelCalls)
assert.equal(updatePlan.changeCount, 1, '应检测到 1 个文件变更')
assert.equal(updatePlan.affectedCount, 1, '应只影响 1 篇文档')
assert.equal(updatePlan.planned[0].action, 'update-proposal', '已批准文档应生成修改候选')

const updateTask = await startIncremental({})
assert.equal(updateTask.status, 'succeeded', '增量任务必须成功：' + (updateTask.errorCode ?? '') + ' ' + (updateTask.errorDetail ?? ''))

const callsAfterUpdate = value(await api('/kb/' + kb.id + '/llm-calls?limit=50'), 'llm-calls').calls
console.log('  模型调用记录：' + callsAfterUpdate.length + ' 条')
for (const call of callsAfterUpdate) console.log('    - ' + call.provider + '/' + call.model + ' purpose=' + call.purpose + ' tokens ' + call.promptTokens + '→' + call.completionTokens + ' ' + call.latencyMs + 'ms')
const updateCall = callsAfterUpdate.find((call) => String(call.purpose ?? '').startsWith('wiki-update:'))
assert.ok(updateCall, '必须留下 wiki-update 用途的模型调用记录')
assert.equal(updateCall.provider, preferred.provider)
assert.equal(updateCall.model, preferred.id, '实际调用必须使用知识库绑定的模型')
assert.ok(updateCall.promptTokens > 0 && updateCall.completionTokens > 0, '必须记录真实 token 用量')

const docAfter = value(await api('/kb/' + kb.id + '/docs/' + docId), '读取文档')
assert.equal(docAfter.document.status, 'approved')
assert.equal(docAfter.document.currentVersion, 1, '已批准文档不能被自动覆盖')
console.log('  已批准文档版本仍为 v' + docAfter.document.currentVersion + '（未被自动覆盖）')

const queue = value(await api('/review?kbId=' + kb.id), '审核队列')
const proposal = queue.proposals.find((item) => item.docId === docId)
assert.ok(proposal, '审核队列必须出现该文档的修改候选')
assert.equal(proposal.kind, 'update')
console.log('  待审核候选：' + proposal.id + '（' + proposal.kind + ' / ' + proposal.status + '）')

const approved = value(await api('/review/proposals/' + proposal.id + '/approve', { method: 'POST', body: { actor: 'e2e', note: 'M4 真机验收批准' } }), '批准候选')
assert.equal(approved.document.currentVersion, 2, '批准后应生成新版本')
const versions = value(await api('/kb/' + kb.id + '/docs/' + docId + '/versions'), '版本历史').versions
console.log('  批准后版本数：' + versions.length + '（最新来源 ' + versions[0].source + '）')

// 5) 再跑一次：无变更不调用模型
const beforeCalls = value(await api('/kb/' + kb.id + '/llm-calls?limit=50'), 'llm-calls').calls.length
const secondTask = await startIncremental({})
assert.equal(secondTask.status, 'succeeded')
const afterCalls = value(await api('/kb/' + kb.id + '/llm-calls?limit=50'), 'llm-calls').calls.length
assert.equal(afterCalls, beforeCalls, '无变更时不得调用模型')
console.log('  二次运行：无变更、无模型调用（调用数保持 ' + afterCalls + '）')

// 6) 结构性变更 → 需重新检查
const tsconfigRel = 'tsconfig.e2e.json'
const tsconfigAbs = join(workspaceRoot, tsconfigRel)
await writeFile(tsconfigAbs, JSON.stringify({ compilerOptions: { strict: true } }, null, 2), 'utf8')
const structuralPlan = value(await api('/kb/' + kb.id + '/incremental', { method: 'POST', body: { dryRun: true } }), '结构性变更预览')
console.log('  结构性变更预览：structural=' + JSON.stringify(structuralPlan.structural) + ' recheckDocs=' + structuralPlan.recheckDocs.length)
assert.ok(structuralPlan.structural.length >= 1, '必须识别结构性文件变更')
const structuralTask = await startIncremental({})
await rm(tsconfigAbs)
assert.equal(structuralTask.status, 'succeeded')
const changeState = value(await api('/kb/' + kb.id + '/changes?limit=50'), '变更记录')
assert.ok(changeState.recheck.length >= 1, '结构性变更必须标记需要重新检查的文档')
console.log('  需重新检查文档：' + changeState.recheck.length + ' 篇（最近变更记录 ' + changeState.changes.length + ' 条）')

// 7) 来源文件删除 → 过时候选，正文保留
await rm(sampleAbs)
const staleGonePlan = value(await api('/kb/' + kb.id + '/incremental', { method: 'POST', body: { dryRun: true } }), '删除预览')
console.log('  删除来源预览：变更=' + staleGonePlan.changeCount + ' 计划动作=' + JSON.stringify(staleGonePlan.planned.map((item) => item.action)))
const staleTask = await startIncremental({})
assert.equal(staleTask.status, 'succeeded')
const queueAfter = value(await api('/review?kbId=' + kb.id), '审核队列')
const staleProposal = (queueAfter.proposals ?? []).find((item) => item.docId === docId && item.kind === 'stale')
assert.ok(staleProposal, '来源全部删除后应生成过时候选')
const docStill = value(await api('/kb/' + kb.id + '/docs/' + docId), '读取文档').document
assert.ok(String(docStill.body).length > 40, '过时文档正文必须保留')
console.log('  过时候选：' + staleProposal.id + '，正文保留 ' + String(docStill.body).length + ' 字符')

// 8) Git 状态端点
const gitState = value(await api('/kb/' + kb.id + '/git'), 'git 状态')
console.log('  /git：模式=' + gitState.mode + ' checkpoint=' + (gitState.checkpoint ? gitState.checkpoint.mode + '/文件 ' + gitState.checkpoint.fileCount : '无'))

// 清理：只删除本次创建的文件，绝不动 workspace 里已有的 docs 目录
await rm(sampleAbs, { force: true })
await rm(join(workspaceRoot, 'tsconfig.e2e.json'), { force: true })
const removed = value(await api('/kb/' + kb.id + '?mode=all', { method: 'DELETE' }), '删除知识库')
console.log('  已清理知识库：' + JSON.stringify(removed.result))
const after = await api('/kb/' + kb.id)
assert.equal(after.status, 404, '删除后详情应 404')

console.log('')
console.log('M4 真机验收全部通过')
