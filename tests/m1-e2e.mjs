/** M1 真机端到端验收：对 knowhub-dev 真实实例调用 /knowhub/api/*。 */
const base = 'http://127.0.0.1:29961/knowhub/api'
let passed = 0
const failures = []
function ok(name, condition, extra) {
  if (condition) { passed += 1; console.log('  ok   ' + name + (extra ? ' -> ' + extra : '')) }
  else { failures.push(name); console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')) }
}
async function call(method, path, body) {
  const init = { method, headers: { accept: 'application/json' } }
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  const response = await fetch(base + path, init)
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = { raw: text } }
  return { status: response.status, payload }
}

const ping = await call('GET', '/ping')
ok('真机插件 HTTP 存活', ping.status === 200 && ping.payload.ok === true, 'endpoints=' + (ping.payload.value?.endpoints?.length ?? 0))

const current = await call('GET', '/current-workspace')
ok('服务端推导当前工作区', current.status === 200 && typeof current.payload.value.workspaceId === 'string', 'workspaceId=' + current.payload.value.workspaceId + ' path=' + current.payload.value.path)

const models = await call('GET', '/models')
ok('读取真实模型目录', models.status === 200 && models.payload.value.models.length > 0, 'providers=' + models.payload.value.providers.map((p) => p.provider + '/' + p.name).join(',') + ' models=' + models.payload.value.models.length)
const flash = models.payload.value.models.find((m) => m.id === 'deepseek-flash') ?? models.payload.value.models[0]
const second = models.payload.value.models.find((m) => m.id !== flash.id) ?? flash

const suffix = Date.now().toString(36)
const payload = { name: 'M1 验收库 ' + suffix, scope: 'workspace', workspaceId: current.payload.value.workspaceId, modelProvider: flash.provider, modelId: flash.id, modelStrategy: 'balanced' }
const created = await call('POST', '/kb', payload)
ok('创建真实工作区知识库', created.status === 200 && created.payload.ok === true, created.payload.ok ? 'id=' + created.payload.value.knowledgeBase.id : JSON.stringify(created.payload))
const kbId = created.payload.value?.knowledgeBase?.id ?? ''
ok('创建返回下一步动作而不是自动初始化', created.payload.value?.nextAction === 'start-initialize')

const dup = await call('POST', '/kb', payload)
ok('同作用范围重名被拒绝', dup.status === 409 && dup.payload.error.code === 'KB_NAME_DUPLICATED')

const listed = await call('GET', '/kb?workspaceId=' + encodeURIComponent(current.payload.value.workspaceId))
ok('列表包含新建知识库', listed.status === 200 && listed.payload.value.knowledgeBases.some((row) => row.id === kbId))

const doc = await call('POST', '/kb/' + kbId + '/docs', {
  title: 'M1 真机验收记录',
  kind: 'memory',
  body: '知枢 M1 在真实 DSH 0.2.1-rc.2 实例中完成知识库创建、Markdown 写入、SQLite 索引与全文检索。真机验收通过，检索可返回来源路径与审核状态。',
  tags: ['验收', 'M1', '检索'],
  status: 'approved',
  verifyState: 'observed',
})
ok('写入知识正文（Markdown + SQLite 索引）', doc.status === 200 && doc.payload.ok === true, doc.payload.ok ? 'path=' + doc.payload.value.document.path : JSON.stringify(doc.payload))

const fts = await call('GET', '/search?q=' + encodeURIComponent('真机验收') + '&status=any')
ok('FTS5 trigram 命中中文', fts.status === 200 && fts.payload.value.mode === 'fts' && fts.payload.value.hits.length >= 1, 'mode=' + fts.payload.value.mode + ' hits=' + fts.payload.value.hits.length + ' matchedBy=' + fts.payload.value.hits[0]?.matchedBy)
ok('检索结果显示来源与审核状态', Boolean(fts.payload.value.hits[0]) && typeof fts.payload.value.hits[0].path === 'string' && fts.payload.value.hits[0].status === 'approved' && Array.isArray(fts.payload.value.scopeKeys))

const fallback = await call('GET', '/search?q=' + encodeURIComponent('验收') + '&status=any')
ok('1-2 字回退 LIKE', fallback.status === 200 && fallback.payload.value.mode === 'like' && fallback.payload.value.hits.length >= 1, 'hits=' + fallback.payload.value.hits.length)

const patched = await call('PATCH', '/kb/' + kbId, { modelProvider: second.provider, modelId: second.id, modelStrategy: 'quality' })
const detail = await call('GET', '/kb/' + kbId)
ok('修改模型并读回一致', patched.status === 200 && detail.payload.value.knowledgeBase.modelId === second.id && detail.payload.value.knowledgeBase.modelStrategy === 'quality', 'model=' + detail.payload.value?.knowledgeBase?.modelId)

const badPatch = await call('PATCH', '/kb/' + kbId, { modelProvider: second.provider, modelId: '不存在的模型' })
ok('失效模型被拒绝且不静默切换', badPatch.status === 400 && badPatch.payload.error.code === 'MODEL_NOT_AVAILABLE')
ok('失效模型尝试后配置未变', (await call('GET', '/kb/' + kbId)).payload.value.knowledgeBase.modelId === second.id)

const userKb = await call('POST', '/kb', { name: 'M1 用户级库 ' + suffix, scope: 'user', modelProvider: flash.provider, modelId: flash.id, modelStrategy: 'economy' })
ok('创建用户级知识库无需工作区', userKb.status === 200 && userKb.payload.value.knowledgeBase.workspaceId === null)
const userKbId = userKb.payload.value?.knowledgeBase?.id ?? ''
ok('用户级知识库出现在默认列表', (await call('GET', '/kb')).payload.value.knowledgeBases.some((row) => row.id === userKbId))

const delConfig = await call('DELETE', '/kb/' + userKbId + '?mode=config')
ok('只删配置保留文件', delConfig.payload.value.result.rowDeleted === true && delConfig.payload.value.result.filesDeleted === false)
ok('删除后详情 404', (await call('GET', '/kb/' + userKbId)).status === 404)

const delAll = await call('DELETE', '/kb/' + kbId + '?mode=all')
ok('删除全部（记录 + 文件）', delAll.status === 200 && delAll.payload.value.result.rowDeleted === true && delAll.payload.value.result.filesDeleted === true)

console.log('')
console.log('M1 真机验收：' + passed + ' 通过，' + failures.length + ' 失败')
if (failures.length > 0) { console.log('失败项：' + failures.join(' | ')); process.exitCode = 1 }
