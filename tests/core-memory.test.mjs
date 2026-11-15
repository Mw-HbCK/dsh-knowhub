// W3：核心记忆口径（Core Memory）与增量退化护栏。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/host/db/db.js'
import { createKnowledgeBase } from '../lib/host/kb/store.js'
import { createDocument } from '../lib/host/search.js'
import { isCoreMemory, listCoreMemory } from '../lib/host/core-memory.js'
import { assessDegradation } from '../lib/host/pipeline/incremental.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failures.push(name); console.log('  FAIL ' + name + '\n' + String(error?.stack ?? error)) }
}

await test('isCoreMemory 口径：已批准 + 非 unverified + memory/preference', () => {
  assert.equal(isCoreMemory({ kind: 'memory', status: 'approved', verifyState: 'observed' }), true)
  assert.equal(isCoreMemory({ kind: 'preference', status: 'approved', verifyState: 'inferred' }), true)
  assert.equal(isCoreMemory({ kind: 'memory', status: 'approved', verifyState: 'unverified' }), false)
  assert.equal(isCoreMemory({ kind: 'memory', status: 'draft', verifyState: 'observed' }), false)
  assert.equal(isCoreMemory({ kind: 'memory', status: 'stale', verifyState: 'observed' }), false)
  assert.equal(isCoreMemory({ kind: 'wiki', status: 'approved', verifyState: 'observed' }), false)
})

const root = mkdtempSync(join(tmpdir(), 'knowhub-core-'))
try {
  const db = openDatabase(root)
  const kb = await createKnowledgeBase(db, { name: '核心记忆测试库', scope: 'user', modelProvider: 'amd', modelId: 'm', modelStrategy: 'balanced' }, { storageRoot: root })
  const mk = (input) => createDocument(db, root, kb, { tags: [], confidence: 0.8, ...input })
  await mk({ title: '核心记忆甲', kind: 'memory', body: '项目部署在 Ubuntu 24.04，数据目录固定。\n\n适用范围：项目级\n调用条件：讨论部署时', status: 'approved', verifyState: 'observed' })
  await mk({ title: '未验证记忆', kind: 'memory', body: '尚未验证的说法，内容足够长用于区分核心口径。', status: 'approved', verifyState: 'unverified' })
  await mk({ title: '草稿记忆', kind: 'memory', body: '仍在草稿状态的记忆，不应进入核心层。', status: 'draft', verifyState: 'observed' })
  await mk({ title: '核心偏好', kind: 'preference', body: '提交信息使用简体中文，这一约定在仓库文档中明确写出。', status: 'approved', verifyState: 'inferred' })
  await mk({ title: '普通 Wiki', kind: 'wiki', body: '这是一篇 Wiki 文档，不属于核心记忆层。', status: 'approved', verifyState: 'observed' })

  await test('listCoreMemory 只返回核心口径内的文档', () => {
    const core = listCoreMemory(db, [kb.id])
    assert.deepEqual(core.map((item) => item.title).sort(), ['核心偏好', '核心记忆甲'])
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

await test('assessDegradation：长度骤减与标题丢失被判定退化，正常更新放行', () => {
  const original = '# 标题\n\n' + '正文内容。'.repeat(120) + '\n\n## 小节一\n\n' + '细节说明。'.repeat(60) + '\n\n## 小节二\n\n' + '更多细节。'.repeat(60)
  assert.ok(assessDegradation(original, '只有一小段新内容。'.repeat(5)) !== null, '长度不足 60% 应判退化')
  const lostHeadings = '# 标题\n\n' + '正文内容。'.repeat(200)
  assert.ok(assessDegradation(original, lostHeadings) !== null, '丢掉一半以上小标题应判退化')
  const healthy = '# 标题\n\n' + '正文内容。'.repeat(120) + '\n\n## 小节一\n\n' + '细节说明。'.repeat(60) + '\n\n## 小节二\n\n' + '更新后的细节。'.repeat(60)
  assert.equal(assessDegradation(original, healthy), null)
  assert.equal(assessDegradation('短文档。', '更短。'), null, '短文档不启用长度护栏')
})

console.log('')
console.log(failures.length === 0 ? 'ALL PASS（' + passed + ' 项）' : 'FAILED（' + failures.length + ' 项失败，' + passed + ' 项通过）')
if (failures.length > 0) process.exit(1)
