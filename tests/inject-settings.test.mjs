/**
 * P1 验收测试：知识注入的「设置化」行为（进程内运行）。
 *
 * 覆盖：默认摘要内容与上限、注入总开关、全局记忆/项目记忆分开关、
 *       标题数上限、摘要字符数上限、设置校验（非法值拒绝）、设置持久化后立即生效。
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const { openDatabase, closeDatabase } = await load('db/db.js')
const store = await load('kb/store.js')
const review = await load('review.js')
const settingsLib = await load('settings.js')
const inject = await load('inject.js')

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push({ name, error })
    console.log('  FAIL ' + name + ' → ' + (error instanceof Error ? error.message : String(error)))
  }
}

const rootPath = decodeURIComponent(new URL('../.build/test-data/inject-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const base = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
const storageRoot = join(base, 'storage')
const dshHome = join(base, 'dsh-home')
await mkdir(storageRoot, { recursive: true })
await mkdir(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome
const config = { storageRoot }

const db = openDatabase(storageRoot)
const kbUser = await store.createKnowledgeBase(db, { name: '通用偏好', scope: 'user', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'economy' }, { storageRoot })
const kbWs = await store.createKnowledgeBase(db, { name: '项目 A 知识库', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot, workspacePath: join(base, 'ws-a'), workspaceTitle: '项目 A' })

const scope = { scopeKeys: ['user:*', 'ws:ws-a-uuid'], workspaceId: 'ws-a-uuid', workspaceTitle: '项目 A' }
const userScope = { scopeKeys: ['user:*'], workspaceId: null, workspaceTitle: null }

async function approvedDoc(kb, title, body) {
  const proposal = review.createProposal(db, kb, { title, docKind: 'convention', body, tags: [], verifyState: 'observed', sources: [], source: 'test', reason: 'P1 注入测试' })
  const result = await review.approveProposal(db, storageRoot, proposal.id, { actor: 'tester' })
  assert.equal(result.document.status, 'approved')
  return result.document
}

const userDoc = await approvedDoc(kbUser, '全局编码偏好', '所有项目统一使用两空格缩进与单引号。')
const wsDoc = await approvedDoc(kbWs, '项目 A 构建命令', '项目 A 使用 pnpm build 构建，产物在 dist 目录。')
console.log('  已准备已批准知识：' + userDoc.id + ' / ' + wsDoc.id)

await test('默认设置下注入摘要包含表头、计数与已批准标题，长度不超过 900', async () => {
  const text = inject.buildKnowledgeDigest(config, scope)
  assert.ok(text.includes(inject.CONTEXT_SECTION_NAME) === false, '摘要正文不应包含 section 名称')
  assert.ok(text.startsWith('## 知枢 KnowHub 知识中心'), '摘要应以知识中心表头开始，实际：' + text.slice(0, 40))
  assert.ok(text.includes('已批准知识 2 条'), '应统计两个知识库的已批准知识，实际：' + text)
  assert.ok(text.includes('全局编码偏好') && text.includes('项目 A 构建命令'), '应列出两篇已批准标题，实际：' + text)
  assert.ok([...text].length <= inject.CONTEXT_MAX_CHARS + 1, '摘要应受默认上限约束，实际长度 ' + [...text].length)
})

await test('注入总开关关闭后完全不注入', async () => {
  settingsLib.writeSettings(db, { injectEnabled: false })
  assert.equal(inject.buildKnowledgeDigest(config, scope), '')
  settingsLib.writeSettings(db, { injectEnabled: true })
  assert.ok(inject.buildKnowledgeDigest(config, scope).includes('全局编码偏好'))
})

await test('关闭全局记忆后只剩项目记忆', async () => {
  settingsLib.writeSettings(db, { injectIncludeUser: false })
  const text = inject.buildKnowledgeDigest(config, scope)
  assert.ok(!text.includes('全局编码偏好'), '用户级知识不应出现，实际：' + text)
  assert.ok(text.includes('项目 A 构建命令'), '项目知识应保留，实际：' + text)
  assert.ok(text.includes('已批准知识 1 条'), '计数应只剩项目库，实际：' + text)
  assert.equal(inject.buildKnowledgeDigest(config, userScope), '', '仅用户级作用域且关闭用户记忆时返回空')
  settingsLib.writeSettings(db, { injectIncludeUser: true })
})

await test('关闭项目记忆后只剩全局记忆', async () => {
  settingsLib.writeSettings(db, { injectIncludeWorkspace: false })
  const text = inject.buildKnowledgeDigest(config, scope)
  assert.ok(text.includes('全局编码偏好'), '用户级知识应保留，实际：' + text)
  assert.ok(!text.includes('项目 A 构建命令'), '项目知识不应出现，实际：' + text)
  assert.ok(text.includes('可见知识库 1 个'), '应只剩用户级知识库，实际：' + text)
  assert.ok(inject.buildKnowledgeDigest(config, userScope).includes('全局编码偏好'), '仅用户级作用域仍应注入')
  settingsLib.writeSettings(db, { injectIncludeWorkspace: true })
})

await test('标题数上限生效（injectMaxTitles=1）', async () => {
  settingsLib.writeSettings(db, { injectMaxTitles: 1 })
  const text = inject.buildKnowledgeDigest(config, scope)
  const line = text.split('\n').find((row) => row.startsWith('最近更新的已批准知识：'))
  assert.ok(line, '摘要应包含标题行，实际：' + text)
  const listed = line.replace('最近更新的已批准知识：', '').split('；').filter((item) => item !== '')
  assert.equal(listed.length, 1, '最多列出 1 条标题，实际：' + listed.length)
  settingsLib.writeSettings(db, { injectMaxTitles: 6 })
})

await test('字符数上限生效（injectMaxChars=300，内容超长时截断）', async () => {
  for (let index = 1; index <= 5; index += 1) {
    await approvedDoc(kbWs, '较长的已批准标题用于验证截断行为第 ' + '一二三四五六七八九十'[index - 1] + ' 篇说明文档', '第 ' + index + ' 篇说明正文。')
  }
  settingsLib.writeSettings(db, { injectMaxChars: 300 })
  const text = inject.buildKnowledgeDigest(config, scope)
  assert.ok([...text].length <= 301, '应截断到 300 字符（含省略号），实际 ' + [...text].length)
  assert.ok(text.endsWith('…'), '截断时应以省略号结尾，实际结尾：' + JSON.stringify(text.slice(-12)))
  settingsLib.writeSettings(db, { injectMaxChars: 900 })
})

await test('设置校验：非法注入参数被拒绝', async () => {
  for (const patch of [{ injectMaxChars: 200 }, { injectMaxChars: 5000 }, { injectMaxChars: 'abc' }, { injectMaxTitles: 0 }, { injectMaxTitles: 21 }, { injectMaxTitles: 3.5 }, { injectEnabled: 'yes' }]) {
    assert.throws(() => settingsLib.validateSettingsPatch(patch), (error) => error && error.code === 'SETTING_INVALID', '应拒绝 ' + JSON.stringify(patch))
  }
  assert.doesNotThrow(() => settingsLib.validateSettingsPatch({ injectMaxChars: 300, injectMaxTitles: 20, injectEnabled: false }))
})

await test('设置持久化后重新读取一致', async () => {
  settingsLib.writeSettings(db, { injectEnabled: false, injectMaxChars: 1200, injectMaxTitles: 3, injectIncludeUser: false, injectIncludeWorkspace: true })
  const settings = settingsLib.readSettings(db)
  assert.equal(settings.injectEnabled, false)
  assert.equal(settings.injectMaxChars, 1200)
  assert.equal(settings.injectMaxTitles, 3)
  assert.equal(settings.injectIncludeUser, false)
  assert.equal(settings.injectIncludeWorkspace, true)
  const snapshot = settingsLib.settingsSnapshot(db, config)
  assert.equal(snapshot.settings.injectEnabled, false)
  assert.ok(snapshot.note.includes('知识注入'), '快照说明应提到知识注入，实际：' + snapshot.note)
})

await test('任何异常都降级为空摘要而不是抛错', async () => {
  assert.equal(inject.buildKnowledgeDigest({ storageRoot: join(base, '不存在目录') }, scope), '')
  assert.equal(inject.buildKnowledgeDigest({}, { scopeKeys: [] }), '')
})

closeDatabase(storageRoot)
console.log('\n' + (failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.length) + '（' + passed + ' 通过 / ' + failures.length + ' 失败）')
process.exit(failures.length === 0 ? 0 : 1)
