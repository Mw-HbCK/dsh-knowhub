// W4：规则质检（runQualityChecks 纯函数）——套话/重复/列表占比/空泛标题/来源/引用/记忆结构/待办状态行。
import assert from 'node:assert/strict'
import { runQualityChecks } from '../lib/host/pipeline/quality.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (error) { failures.push(name); console.log('  FAIL ' + name + '\n' + String(error?.stack ?? error)) }
}

const cleanWiki = {
  title: '增量更新的文件判定机制',
  kind: 'wiki',
  body: '增量更新先用内容哈希比对文件，再结合 Git 变更信号确定受影响范围。哈希是权威判定，未提交的改动也能被发现。\n\n受影响文档由来源反查得到，模型只处理这些文档，变更之外的章节保持原样。',
  sources: ['src/host/pipeline/changes.ts'],
  siblingTitles: ['增量更新的文件判定机制', '项目总览'],
}

await test('干净正文不产生任何标记', () => {
  assert.deepEqual(runQualityChecks(cleanWiki), [])
})

await test('套话与空泛标题被标记', () => {
  const flags = runQualityChecks({ ...cleanWiki, title: '核心技术深度解析', body: cleanWiki.body + '\n\n综上所述，本模块通过体系化赋能形成了完整闭环。' })
  assert.ok(flags.some((flag) => flag.includes('综上所述')))
  assert.ok(flags.some((flag) => flag.includes('深度解析')))
})

await test('重复段落被标记', () => {
  const paragraph = '数据库连接池在启动时预热连接，请求到来时直接取用，避免每次请求都重新建立连接的开销。'
  const flags = runQualityChecks({ ...cleanWiki, body: paragraph + '\n\n' + paragraph })
  assert.ok(flags.some((flag) => flag.includes('重复')))
})

await test('列表占比过高被标记', () => {
  const body = '项目包含以下内容：\n' + Array.from({ length: 10 }, (_, i) => '- 条目 ' + i + ' 的说明文字，描述该条目负责的范围与注意事项').join('\n')
  const flags = runQualityChecks({ ...cleanWiki, body })
  assert.ok(flags.some((flag) => flag.includes('列表行占正文')))
})

await test('正文提及未列入来源的文件被标记', () => {
  const flags = runQualityChecks({ ...cleanWiki, body: '判定逻辑位于 src/host/pipeline/changes.ts 与 src/host/secret.ts 两个文件中，前者负责比对，后者负责别的。' })
  assert.ok(flags.some((flag) => flag.includes('secret.ts')))
})

await test('引用不存在的文档被标记，引用真实文档不标记', () => {
  const bad = runQualityChecks({ ...cleanWiki, body: '细节见《不存在的文档》和《项目总览》。' })
  assert.ok(bad.some((flag) => flag.includes('不存在的文档')))
  const good = runQualityChecks({ ...cleanWiki, body: '整体背景见《项目总览》。' })
  assert.ok(!good.some((flag) => flag.includes('引用检查')))
})

await test('memory 缺适用范围/调用条件被标记，齐全则不标记', () => {
  const missing = runQualityChecks({ title: '部署环境', kind: 'memory', body: '项目部署在 Ubuntu 24.04，数据目录位于项目目录下，升级时保持卷兼容。', sources: [] })
  assert.ok(missing.some((flag) => flag.includes('适用范围')))
  const complete = runQualityChecks({ title: '部署环境', kind: 'memory', body: '项目部署在 Ubuntu 24.04。\n适用范围：项目级\n调用条件：讨论部署与升级时', sources: [] })
  assert.ok(!complete.some((flag) => flag.includes('记忆结构')))
})

await test('todo 首行状态标记校验', () => {
  const bad = runQualityChecks({ title: '补文档', kind: 'todo', body: '需要补齐回滚章节的说明文档。', sources: [] })
  assert.ok(bad.some((flag) => flag.includes('状态标记')))
  const good = runQualityChecks({ title: '补文档', kind: 'todo', body: '状态：待处理\n补齐回滚章节的说明文档，原因是当前缺失。', sources: [] })
  assert.ok(!good.some((flag) => flag.includes('状态标记')))
})

console.log('')
console.log(failures.length === 0 ? 'ALL PASS（' + passed + ' 项）' : 'FAILED（' + failures.length + ' 项失败，' + passed + ' 项通过）')
if (failures.length > 0) process.exit(1)
