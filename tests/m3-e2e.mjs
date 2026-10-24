/**
 * M3 真机端到端验收：对运行中的 dsh（knowhub-dev profile, 127.0.0.1:29961）走完整审核流。
 * 校验：审核队列真实数据、候选批准入正式库、人工编辑版本、版本差异、恢复历史版本、
 *       基础版本过期生成冲突、冲突解决（采用新提议）、审核日志、清理删除。
 * 用法：node tests/m3-e2e.mjs [baseUrl]
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

const stamp = new Date().toISOString().slice(11, 19)
console.log('M3 真机验收 → ' + baseUrl + '（' + stamp + '）')
let kbId = ''

try {
  const ping = value(await api('/ping'), 'ping')
  console.log('  端点数量：' + ping.endpoints.length)
  assert.ok(ping.endpoints.some((line) => line.includes('/review')), 'ping 端点清单必须包含审核接口')
  assert.ok(ping.endpoints.length >= 22, 'M3 端点数量应不少于 22 条，实际 ' + ping.endpoints.length)

  const current = value(await api('/current-workspace'), 'current-workspace')
  assert.ok(current.workspaceId, '必须能识别当前工作区')
  console.log('  当前工作区：' + current.title + '（' + current.workspaceId + '）')

  const catalog = value(await api('/models'), 'models')
  assert.ok(catalog.available && catalog.models.length > 0, '模型目录必须可用')
  const model = catalog.models.find((item) => item.provider === 'amd' && item.id === 'DeepSeek-V4-Flash') ?? catalog.models[0]
  console.log('  绑定模型：' + model.provider + ' / ' + model.id)

  const created = value(await api('/kb', {
    method: 'POST',
    body: { name: 'M3 验收知识库 ' + stamp, scope: 'workspace', workspaceId: current.workspaceId, modelProvider: model.provider, modelId: model.id, modelStrategy: 'economy' },
  }), '创建知识库')
  kbId = created.knowledgeBase.id
  console.log('  知识库：' + kbId)

  const draft = value(await api('/kb/' + kbId + '/docs', {
    method: 'POST',
    body: { title: 'M3 验收知识', kind: 'memory', body: '第一版：构建命令是 node scripts/build.mjs。', status: 'draft', verifyState: 'observed', tags: ['验收', 'M3'] },
  }), '写入草稿')
  const docId = draft.document.id
  assert.equal(draft.document.status, 'draft', '新建知识默认为待审核草稿')

  // 待审核队列应能真实读到这条草稿
  const queue1 = value(await api('/review'), '审核队列')
  assert.ok(queue1.counts.drafts >= 1, '审核队列应包含待审核草稿')
  assert.equal(queue1.workspaceId, current.workspaceId, '审核队列必须绑定当前工作区作用域')
  console.log('  审核队列：草稿 ' + queue1.counts.drafts + ' / 候选 ' + queue1.counts.proposals + ' / 冲突 ' + queue1.counts.conflicts)

  const approved = value(await api('/kb/' + kbId + '/docs/' + docId + '/review', { method: 'POST', body: { action: 'approve', actor: 'e2e', note: '验收批准' } }), '批准草稿')
  assert.equal(approved.document.status, 'approved', '批准后应转为正式知识')
  assert.equal(approved.document.currentVersion, 1, '首次批准应产生第 1 版')
  console.log('  已批准：' + approved.document.title + '（第 ' + approved.document.currentVersion + ' 版）')

  const edited = value(await api('/kb/' + kbId + '/docs/' + docId, {
    method: 'PATCH',
    body: { body: '第二版：构建命令是 node scripts/build.mjs；测试命令是 node tests/m3.test.mjs。', note: '补充测试命令' },
  }), '人工编辑')
  assert.equal(edited.document.currentVersion, 2, '人工编辑应追加第 2 版')

  const versions = value(await api('/kb/' + kbId + '/docs/' + docId + '/versions'), '版本列表')
  assert.equal(versions.versions.length, 2, '应有 2 个历史版本')
  assert.ok(versions.versions.some((item) => item.source === 'manual'), '人工编辑版本应记录来源')
  const v1 = value(await api('/kb/' + kbId + '/docs/' + docId + '/versions/1'), '读取第 1 版')
  assert.ok(v1.version.content.includes('第一版'), '第 1 版内容应可追溯')

  const diff = value(await api('/kb/' + kbId + '/docs/' + docId + '/diff?from=1&to=2'), '版本差异')
  assert.ok(diff.stats.added > 0, '第 2 版应包含新增行')
  console.log('  版本差异：+' + diff.stats.added + ' / -' + diff.stats.removed + ' / 未变 ' + diff.stats.unchanged)

  const restored = value(await api('/kb/' + kbId + '/docs/' + docId + '/restore', { method: 'POST', body: { version: 1, note: '验收回滚' } }), '恢复历史版本')
  assert.equal(restored.restoredFrom, 1, '应记录恢复来源版本')
  assert.equal(restored.document.currentVersion, 3, '恢复以新版本记录，不静默覆盖')
  const v3 = value(await api('/kb/' + kbId + '/docs/' + docId + '/versions'), '版本列表')
  assert.equal(v3.versions[0].changeKind, 'restore', '最新版本类型应为 restore')
  console.log('  恢复完成：' + restored.message)

  // 候选修改 + 基础版本过期 → 冲突
  const proposal = value(await api('/kb/' + kbId + '/proposals', {
    method: 'POST',
    body: { kind: 'update', docId, title: 'M3 验收知识（新）', body: '第三版提议：构建使用 pnpm build。', reason: '模型整理', createdBy: 'e2e' },
  }), '提交候选')
  const proposalId = proposal.proposal.id
  assert.equal(proposal.proposal.status, 'pending', '候选必须默认待审核')
  assert.equal(proposal.proposal.baseVersion, 3, '候选应记录基础版本')

  const bumped = value(await api('/kb/' + kbId + '/docs/' + docId, {
    method: 'PATCH',
    body: { body: '第四版：构建命令是 node scripts/build.mjs（人工先改）。', note: '人工先改' },
  }), '再次人工编辑')
  assert.equal(bumped.document.currentVersion, 4)

  const approvedStale = value(await api('/review/proposals/' + proposalId + '/approve', { method: 'POST', body: { actor: 'e2e' } }), '批准过期候选')
  assert.ok(approvedStale.conflict, '基础版本过期时必须生成冲突审核项')
  assert.ok(String(approvedStale.message).includes('冲突'), '应提示冲突未覆盖当前知识')
  const afterConflict = value(await api('/kb/' + kbId + '/docs/' + docId), '冲突后读取文档')
  assert.ok(afterConflict.document.body.includes('第四版'), '冲突时不得覆盖当前正式内容')
  console.log('  冲突：' + approvedStale.conflict.id + '（当前内容未被覆盖）')

  const queue2 = value(await api('/review'), '审核队列冲突计数')
  assert.ok(queue2.counts.conflicts >= 1, '审核队列应显示待处理冲突')

  const resolved = value(await api('/review/conflicts/' + approvedStale.conflict.id + '/resolve', {
    method: 'POST', body: { mode: 'use_proposed', actor: 'e2e', note: '采用模型提议' },
  }), '解决冲突')
  assert.ok(resolved.document.body.includes('pnpm build'), '采用新提议后正文应更新')
  assert.equal(resolved.document.currentVersion, 5, '解决冲突应追加合并版本')

  const log = value(await api('/review/log?limit=80'), '审核日志')
  assert.ok(log.entries.length >= 5, '审核日志应记录 propose/approve/edit/restore/conflict 等动作')
  const actions = log.entries.map((entry) => entry.action)
  for (const expected of ['propose', 'doc_approve', 'doc_edit', 'doc_restore', 'conflict_detected', 'resolve_conflict']) {
    assert.ok(actions.includes(expected), '审核日志应包含动作：' + expected)
  }
  console.log('  审核日志：' + log.entries.length + ' 条（' + Array.from(new Set(actions)).join(' / ') + '）')

  const kbQueue = value(await api('/kb/' + kbId + '/review'), '单库审核队列')
  assert.ok(kbQueue.counts.total >= 0)

  console.log('M3 真机验收全部通过 ✔')
} finally {
  if (kbId !== '') {
    const removed = await api('/kb/' + kbId + '?mode=all', { method: 'DELETE' })
    if (removed.body && removed.body.ok === true) console.log('  已清理知识库：' + kbId + '（含知识文件）')
    else console.log('  清理失败：HTTP ' + removed.status + ' ' + JSON.stringify(removed.body))
  }
}
