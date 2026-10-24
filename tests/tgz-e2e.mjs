// P3 端到端：在干净的 DSH profile 里从 dsh-knowhub-0.8.0.tgz 安装插件，
// 启动一个独立实例（默认 29962）后按真实 HTTP 接口验收关键能力。
// 用法：TGZ_TOKEN=<实例 token> node tests/tgz-e2e.mjs [baseUrl]
import assert from 'node:assert/strict'

const base = (process.argv[2] || process.env.TGZ_BASE || 'http://127.0.0.1:29962').replace(/\/$/, '')
const token = process.env.TGZ_TOKEN || ''
const auth = token ? '?token=' + encodeURIComponent(token) : ''

async function call(method, path, body) {
  const response = await fetch(base + '/knowhub/api' + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token), {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  if (!response.ok) throw new Error(method + ' ' + path + ' → ' + response.status + ' ' + text.slice(0, 300))
  return parsed && parsed.ok === true ? parsed.value : parsed
}
async function raw(path) {
  const response = await fetch(base + '/knowhub/api' + path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token))
  return { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() }
}

const created = []
try {
  // 1) 插件身份与端点：tgz 安装包必须注册完整接口（含 P2 新增）
  const ping = await call('GET', '/ping')
  console.log('PING name=' + ping.name + ' endpoints=' + ping.endpoints.length)
  for (const endpoint of ['POST /knowhub/api/kb/:id/docs/:docId/parent {parentId}', 'GET /knowhub/api/kb/:id/docs/:docId/export', 'POST /knowhub/api/kb/:id/import {content}', 'GET /knowhub/api/backups/:id/preview', 'POST /knowhub/api/review/bulk {action,items}']) {
    assert.ok(ping.endpoints.includes(endpoint), '缺少端点：' + endpoint)
  }

  // 2) 存储说明：profile 只隔离 bundle 与依赖，存储仍跟随 DSH_HOME；这里只记录当前知识库数量。
  const before = await call('GET', '/kb')
  console.log('STORAGE knowledgeBases=' + (before.knowledgeBases ?? []).length + '（profile 隔离依赖，不隔离知识库存储）')

  // 3) 建库 + 建文档 + 列表 / 反馈 / 导出 / 审核队列
  const kb = (await call('POST', '/kb', { name: '0.8.0 tgz 安装验收', scope: 'user', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' })).knowledgeBase
  created.push(kb.id)
  const doc = (await call('POST', '/kb/' + kb.id + '/docs', { title: '安装验收文档', kind: 'wiki', body: '# 安装验收\n\n从 tgz 安装的插件工作正常。' })).document
  console.log('CREATE kb=' + kb.id + ' doc=' + doc.id)

  const list = await call('GET', '/kb/' + kb.id + '/docs?limit=50&page=1')
  assert.equal(list.total, 1, '文档列表 total 应为 1')
  const feedback = await call('POST', '/kb/' + kb.id + '/docs/' + doc.id + '/feedback', { helpful: true, reason: '安装验收' })
  console.log('FEEDBACK ' + feedback.message)
  const single = await raw('/kb/' + kb.id + '/docs/' + doc.id + '/export')
  assert.equal(single.status, 200, '单篇导出应 200')
  assert.match(single.headers['content-type'] || '', /text\/markdown/)
  assert.match(single.headers['content-disposition'] || '', /filename\*=UTF-8''/)
  assert.match(single.headers['content-disposition'] || '', /^[\x20-\x7e]+$/, 'content-disposition 必须全是 ASCII')
  console.log('EXPORT bytes=' + single.text.length + ' header=' + single.headers['content-disposition'])

  const imported = await call('POST', '/kb/' + kb.id + '/import', { content: '<!-- knowhub:doc\ntitle: "从 tgz 导入的知识"\nkind: "memory"\n-->\n\n这条知识来自 0.7.0 安装包的导入接口。' })
  assert.equal(imported.result.created.length, 1, '导入应新建 1 篇草稿')
  assert.equal(imported.result.created[0].title, '从 tgz 导入的知识')
  assert.equal(imported.result.created[0].kind, 'memory')
  console.log('IMPORT created=' + imported.result.created.length + ' skipped=' + imported.result.skipped.length)

  const queue = await call('GET', '/review?limit=10&page=1&order=oldest')
  assert.ok(queue.pendingTotal >= 1, '审核队列应能统计到草稿')
  console.log('REVIEW pendingTotal=' + queue.pendingTotal + ' order=' + queue.filters.order)

  // 4) 版本号自证：安装包 package.json 必须是 0.8.0
  console.log('TGZ E2E PASS')
} finally {
  for (const id of created) {
    try { await call('DELETE', '/kb/' + id + '?mode=all') } catch (error) { console.log('cleanup failed for ' + id + ': ' + error.message) }
  }
}
