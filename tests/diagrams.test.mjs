// W5：Archify 集成——迁移、简报校验、真实 CLI 校验/交付全流程、过时标记与关联删除。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../lib/host/db/db.js'
import { get } from '../lib/host/db/db.js'
import { createKnowledgeBase } from '../lib/host/kb/store.js'
import { createDocument } from '../lib/host/search.js'
import { parseWikiPlan } from '../lib/host/pipeline/prompts/wiki-plan.js'
import { deleteDiagramAssociation, generateDiagramForDoc, listDocDiagrams, markStaleDiagramsForChanges } from '../lib/host/pipeline/diagrams.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failures.push(name); console.log('  FAIL ' + name + '\n' + String(error?.stack ?? error)) }
}

// 无头环境里 finalize 的 browser-check 需要一个 Chrome：优先用环境变量，其次用本机 CFT。
const cftChrome = join(process.env.HOME ?? '', 'workspace/tools/cft/chrome-linux64/chrome')
if (!process.env.ARCHIFY_CHROME && existsSync(cftChrome)) process.env.ARCHIFY_CHROME = cftChrome
const hasChrome = Boolean(process.env.ARCHIFY_CHROME) && existsSync(String(process.env.ARCHIFY_CHROME))

const TREE_IR = {
  schema_version: 1,
  diagram_type: 'tree',
  meta: { title: '系统结构', output: 'diagram.html' },
  layout: { direction: 'down' },
  nodes: [
    { id: 'root', label: '知枢 KnowHub' },
    { id: 'host', label: '宿主层', parent: 'root' },
    { id: 'client', label: '面板', parent: 'root' },
  ],
}

const fakeState = { mode: 'ok' }
const fakeLlm = {
  stream() {
    return (async function* () {
      const text = fakeState.mode === 'ok' ? JSON.stringify(TREE_IR) : '这不是 JSON'
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const fakeCtx = { get: (name) => (name === 'llm' ? fakeLlm : undefined), on: () => () => undefined }

const root = mkdtempSync(join(tmpdir(), 'knowhub-diagrams-'))
const storageRoot = join(root, 'storage')
const workspace = join(root, 'ws')
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, 'README.md'), '# 示例项目\n\n宿主层与面板两部分组成。\n', 'utf8')
writeFileSync(join(workspace, 'package.json'), '{"name":"demo"}\n', 'utf8')

try {
  const db = openDatabase(storageRoot)

  await test('迁移 v8：doc_diagrams 表存在', () => {
    const row = get(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'doc_diagrams'")
    assert.ok(row, 'doc_diagrams 应由迁移创建')
  })

  await test('简报校验：合法简报保留、非法类型丢弃、来源过滤到证据子集', () => {
    const { entries } = parseWikiPlan({
      documents: [
        { title: '系统架构', purpose: '讲结构', angle: 'architecture', evidence: ['README.md', 'package.json'], parent: null, diagram: { type: 'architecture', reason: '组件关系复杂', sources: ['README.md', '不存在.ts'] } },
        { title: '随便一篇', purpose: 'x', angle: 'general', evidence: ['README.md'], parent: null, diagram: { type: 'pie', reason: 'x', sources: [] } },
      ],
    }, new Set(['README.md', 'package.json']), 8)
    assert.equal(entries[0].diagram.type, 'architecture')
    assert.deepEqual(entries[0].diagram.sources, ['README.md'])
    assert.equal(entries[1].diagram, null)
  })

  const kb = await createKnowledgeBase(db, { name: '图表测试库', scope: 'workspace', workspaceId: 'ws-diagram', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'quality' }, { storageRoot, workspacePath: workspace, workspaceTitle: '示例项目' })
  const doc = await createDocument(db, storageRoot, kb, {
    title: '系统架构', kind: 'wiki', status: 'approved', verifyState: 'observed', tags: [],
    body: '系统由宿主层与面板组成。宿主层负责知识存储与模型调用，面板负责展示与审核。\n\n适用范围之外的内容不在此列。',
  })

  if (hasChrome) {
    await test('全流程：模型 IR → Archify validate/finalize → 关联落库（current）', async () => {
      const result = await generateDiagramForDoc(fakeCtx, db, kb, { doc, type: 'tree', sources: ['README.md'], workspaceRoot: workspace, evidenceText: 'README 内容', taskId: 'task-test' })
      assert.equal(result.ok, true, result.error ?? '')
      const diagrams = listDocDiagrams(db, doc.id)
      assert.equal(diagrams.length, 1)
      assert.equal(diagrams[0].status, 'current')
      assert.equal(diagrams[0].type, 'tree')
      assert.ok(existsSync(join(workspace, diagrams[0].htmlPath)), 'HTML 产物应存在于工作区 .archify 下')
      assert.ok(existsSync(join(workspace, diagrams[0].candidatePath)), '候选 IR 应保留')
      assert.ok(diagrams[0].sources.includes('README.md'))

      const marked = markStaleDiagramsForChanges(db, kb.id, ['README.md'])
      assert.equal(marked, 1)
      assert.equal(listDocDiagrams(db, doc.id)[0].status, 'stale')

      assert.equal(deleteDiagramAssociation(db, diagrams[0].id), true)
      assert.equal(listDocDiagrams(db, doc.id).length, 0)
    })
  } else {
    console.log('  skip 全流程测试：无可用 Chrome（ARCHIFY_CHROME 未设置），finalize 的 browser-check 无法运行')
  }

  await test('模型输出非法时返回失败且不落关联', async () => {
    fakeState.mode = 'bad'
    const result = await generateDiagramForDoc(fakeCtx, db, kb, { doc, type: 'tree', sources: ['README.md'], workspaceRoot: workspace, evidenceText: '', taskId: 'task-test' })
    assert.equal(result.ok, false)
    assert.equal(listDocDiagrams(db, doc.id).length, 0)
    fakeState.mode = 'ok'
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
console.log(failures.length === 0 ? 'ALL PASS（' + passed + ' 项）' : 'FAILED（' + failures.length + ' 项失败，' + passed + ' 项通过）')
if (failures.length > 0) process.exit(1)
