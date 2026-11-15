// Wiki 两段式：结构规划输出的校验与规整（parseWikiPlan 纯函数）。
import assert from 'node:assert/strict'
import { parseWikiPlan } from '../lib/host/pipeline/prompts/wiki-plan.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failures.push(name); console.log('  FAIL ' + name + '\n' + String(error?.stack ?? error)) }
}

const known = new Set(['README.md', 'package.json', 'src/index.ts', 'src/router.ts'])

await test('正常大纲：父先子后、证据过滤到索引内文件', async () => {
  const { entries, dropped } = parseWikiPlan({
    documents: [
      { title: '核心模块说明', purpose: '讲模块', angle: 'module', evidence: ['src/index.ts', '不存在.ts'], parent: '项目总览' },
      { title: '项目总览', purpose: '讲总览', angle: 'overview', evidence: ['README.md'], parent: null },
    ],
  }, known, 8)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].title, '项目总览', '父篇应排在子篇之前')
  assert.equal(entries[1].parentTitle, '项目总览')
  assert.deepEqual(entries[1].evidence, ['src/index.ts'], '索引外证据应被过滤')
  assert.equal(dropped.length, 0)
})

await test('父篇不在大纲内或指向自身时置空；重复标题合并', async () => {
  const { entries, dropped } = parseWikiPlan({
    documents: [
      { title: '甲篇', angle: 'general', evidence: [], parent: '不存在的父篇' },
      { title: '甲篇', angle: 'general', evidence: [], parent: null },
      { title: '乙篇', angle: 'general', evidence: [], parent: '乙篇' },
    ],
  }, known, 8)
  assert.equal(entries.length, 2)
  assert.ok(entries.every((entry) => entry.parentTitle === null))
  assert.ok(dropped.some((line) => line.includes('重复')))
})

await test('父子成环时断开一篇父关系，全部条目保留', async () => {
  const { entries } = parseWikiPlan({
    documents: [
      { title: 'A 篇', angle: 'general', evidence: [], parent: 'B 篇' },
      { title: 'B 篇', angle: 'general', evidence: [], parent: 'A 篇' },
    ],
  }, known, 8)
  assert.equal(entries.length, 2)
  assert.ok(entries.some((entry) => entry.parentTitle === null), '成环时至少一篇应被断开父关系')
})

await test('三层父子压平为两层；篇数受上限约束；非法 angle 归为 general', async () => {
  const { entries } = parseWikiPlan({
    documents: [
      { title: '根', angle: 'weird', evidence: [], parent: null },
      { title: '中', angle: 'module', evidence: [], parent: '根' },
      { title: '叶', angle: 'module', evidence: [], parent: '中' },
      { title: '超额篇', angle: 'module', evidence: [], parent: null },
    ],
  }, known, 3)
  assert.equal(entries.length, 3, '超过上限的篇目应被截断')
  const leaf = entries.find((entry) => entry.title === '叶')
  assert.ok(leaf && leaf.parentTitle === null, '第三层应被压平到根层')
  assert.equal(entries.find((entry) => entry.title === '根').angle, 'general')
})

await test('空/畸形输出返回空大纲（上层据此回退固定篇目）', async () => {
  assert.deepEqual(parseWikiPlan(null, known, 8).entries, [])
  assert.deepEqual(parseWikiPlan({ documents: 'nope' }, known, 8).entries, [])
  assert.deepEqual(parseWikiPlan({ documents: [{ title: '' }] }, known, 8).entries, [])
})

console.log('')
console.log(failures.length === 0 ? 'ALL PASS（' + passed + ' 项）' : 'FAILED（' + failures.length + ' 项失败，' + passed + ' 项通过）')
if (failures.length > 0) process.exit(1)
