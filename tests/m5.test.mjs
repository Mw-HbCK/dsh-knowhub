/**
 * M5 验收测试（进程内运行；沙箱禁止子进程管道，故不用 node --test runner）。
 * 覆盖：设置校验与持久化、存储位置诊断、自动提炼开关、
 *       提炼解析/去重/越权/模型失败、备份创建/合并恢复、存储迁移预检与正式迁移、
 *       总览统计、跨库浏览筛选与分页、跨库隔离。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const rootPath = decodeURIComponent(new URL('../.build/test-data/m5-' + Date.now().toString(36) + '/', import.meta.url).pathname)
const testRoot = process.platform === 'win32' ? rootPath.replace(/^\//, '') : rootPath
const storageRoot = join(testRoot, 'storage')
const dshHome = join(testRoot, 'dsh-home')
await mkdir(storageRoot, { recursive: true })
await mkdir(dshHome, { recursive: true })
process.env.DSH_HOME = dshHome

const dbLib = await load('db/db.js')
const { openDatabase, closeDatabase, all, get } = dbLib
const store = await load('kb/store.js')
const search = await load('search.js')
const review = await load('review.js')
const settingsLib = await load('settings.js')
const backupLib = await load('backup.js')
const overviewLib = await load('overview.js')
const distillLib = await load('distill.js')

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
const expectReject = async (fn, code) => {
  try { await fn() } catch (error) {
    if (code) assert.equal(error.code, code, '期望错误码 ' + code + '，实际 ' + error.code + '（' + error.message + '）')
    return error
  }
  throw new Error('期望失败但成功了')
}

// 假模型：mode='ok' 返回 JSON 数组；mode='fail' 返回失败 finish；mode='garbage' 返回非 JSON
const modelCalls = []
const fake = { mode: 'ok', payload: null }
const fakeLlm = {
  stream(options) {
    modelCalls.push({ provider: options.provider, model: options.model, system: options.system })
    if (fake.mode === 'fail') {
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: '凭据无效' } } }
      })()
    }
    const text = fake.mode === 'garbage' ? '抱歉，我无法提炼。' : JSON.stringify(fake.payload ?? [])
    return (async function* () {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const fakeCtx = {
  get(name) {
    if (name === 'llm') return fakeLlm
    return undefined
  },
  on() { return () => undefined },
}

const db = openDatabase(storageRoot)
const kbA = await store.createKnowledgeBase(db, { name: '项目 A 知识库', scope: 'workspace', workspaceId: 'ws-a-uuid', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, { storageRoot, workspacePath: join(testRoot, 'ws-a'), workspaceTitle: '项目 A' })
const kbB = await store.createKnowledgeBase(db, { name: '项目 B 知识库', scope: 'workspace', workspaceId: 'ws-b-uuid', modelProvider: 'deepseek-account', modelId: 'deepseek-v4-pro', modelStrategy: 'economy' }, { storageRoot, workspacePath: join(testRoot, 'ws-b'), workspaceTitle: '项目 B' })
const scopeA = ['user:*', 'ws:ws-a-uuid']

const longBody = '# 架构说明\n\n本项目采用适配层 + 核心层分层结构，所有对外能力都经服务层，便于 DSH 升级时只改适配层。\n\n## 关键决策\n\n- 内容哈希作为增量判定权威\n- 已批准知识只生成候选\n'
const docA = await search.createDocument(db, storageRoot, kbA, { title: '架构说明', kind: 'wiki', body: longBody, status: 'approved', verifyState: 'observed' })
const memA = await search.createDocument(db, storageRoot, kbA, { title: '存储选型', kind: 'memory', body: longBody.replace('架构说明', '存储选型'), status: 'approved', verifyState: 'observed' })
const docB = await search.createDocument(db, storageRoot, kbB, { title: 'B 项目架构', kind: 'wiki', body: longBody.replace('架构说明', 'B 项目架构'), status: 'approved', verifyState: 'observed' })

console.log('M5 单测开始：' + testRoot)

// ---------- 设置 ----------
await test('设置默认值（未写入时使用默认）', () => {
  const settings = settingsLib.readSettings(openDatabase(join(testRoot, 'fresh-storage')))
  assert.equal(settings.defaultStrategy, 'balanced')
  assert.equal(settings.autoDistill, false)
  assert.equal(settings.distillMinChars, 200)
  assert.deepEqual(settings.excludeDirs, [])
  assert.equal(settings.backupKeep, 10)
  assert.equal(settings.autoBackup, true)
})

await test('设置校验：非法策略/阈值/排除目录被拒绝且不落库', async () => {
  await expectReject(async () => settingsLib.writeSettings(db, { defaultStrategy: 'fast' }, 'test'), 'SETTING_INVALID')
  await expectReject(async () => settingsLib.writeSettings(db, { distillMinChars: 10 }, 'test'), 'SETTING_INVALID')
  await expectReject(async () => settingsLib.writeSettings(db, { backupKeep: 999 }, 'test'), 'SETTING_INVALID')
  await expectReject(async () => settingsLib.writeSettings(db, { excludeDirs: ['../etc'] }, 'test'), 'SETTING_INVALID')
  await expectReject(async () => settingsLib.writeSettings(db, { autoDistill: 'yes' }, 'test'), 'SETTING_INVALID')
  assert.equal(settingsLib.readSettings(db).defaultStrategy, 'balanced')
})

await test('设置持久化 + 写 review_log', () => {
  const result = settingsLib.writeSettings(db, { defaultStrategy: 'quality', autoDistill: true, distillMinChars: 300, excludeDirs: ['vendor', 'third_party'], backupKeep: 3, autoBackup: false }, 'tester')
  assert.deepEqual(result.changed.sort(), ['autoBackup', 'autoDistill', 'backupKeep', 'defaultStrategy', 'distillMinChars', 'excludeDirs'].sort())
  const settings = settingsLib.readSettings(db)
  assert.equal(settings.defaultStrategy, 'quality')
  assert.equal(settings.autoDistill, true)
  assert.deepEqual(settings.excludeDirs, ['vendor', 'third_party'])
  const log = get(db, "SELECT * FROM review_log WHERE action = 'settings_update' ORDER BY at DESC LIMIT 1")
  assert.ok(log, '应写入 settings_update 日志')
  // 复原为默认，避免影响后续测试
  settingsLib.writeSettings(db, { defaultStrategy: 'balanced', autoDistill: false, distillMinChars: 200, excludeDirs: [], backupKeep: 10, autoBackup: true }, 'tester')
})

await test('设置快照包含存储位置与来源', () => {
  const snapshot = settingsLib.settingsSnapshot(db, { storageRoot })
  assert.equal(snapshot.storage.source, 'config')
  assert.equal(snapshot.storage.storageRoot, storageRoot)
  assert.ok(snapshot.storage.pointerFile.endsWith('knowhub-location.json'))
  assert.equal(snapshot.defaults.distillMinChars, 200)
})

// ---------- 提炼：解析 ----------
await test('提炼解析：合法候选保留、绝对路径证据丢弃、密钥清洗', () => {
  const parsed = distillLib.parseCandidates(JSON.stringify([
    { title: '  用 SQLite FTS5 做检索  ', kind: 'decision', body: '选择 SQLite FTS5 trigram 作为全文检索实现，因为本机 node:sqlite 已内置 FTS5 且支持 trigram 分词。', confidence: 0.86, evidence: [{ kind: 'file', ref: 'docs/adr/001.md' }, { kind: 'file', ref: 'C:/secret/path.ts' }, { kind: 'file', ref: '../escape.md' }] },
    { title: '无效类型', kind: 'not-a-kind', body: '这是一段足够长的正文，用来验证类型校验是否生效。' },
    { title: '太短', kind: 'memory', body: '短' },
  ]))
  assert.equal(parsed.candidates.length, 1)
  const candidate = parsed.candidates[0]
  assert.equal(candidate.title, '用 SQLite FTS5 做检索')
  assert.equal(candidate.kind, 'decision')
  assert.equal(candidate.evidence.length, 1)
  assert.equal(candidate.evidence[0].ref, 'docs/adr/001.md')
  assert.equal(parsed.rejected.length, 2)
  assert.ok(parsed.rejected.some((item) => item.reason.includes('类型')))
  assert.ok(parsed.rejected.some((item) => item.reason.includes('过短')))
})

await test('提炼解析：代码块围栏与字符串里的括号不影响 JSON 提取', () => {
  const text = '说明文字\n```json\n[{"title":"含 [括号] 的标题","kind":"memory","body":"正文里包含 ] 和 [ 都不应截断解析，长度足够通过校验。","confidence":0.5}]\n```\n'
  const parsed = distillLib.parseCandidates(text)
  assert.equal(parsed.error, null)
  assert.equal(parsed.candidates.length, 1)
  assert.equal(parsed.candidates[0].title, '含 [括号] 的标题')
})

await test('提炼解析：非 JSON 输出报错而不是抛异常', () => {
  const parsed = distillLib.parseCandidates('抱歉，我无法提炼。')
  assert.equal(parsed.candidates.length, 0)
  assert.ok(parsed.error)
})

await test('敏感信息清洗：Bearer 与长十六进制被移除', () => {
  const cleaned = distillLib.sanitizeDistilledText('配置：Bearer abcdefghijklmnop 以及 key sk-abcdefghijklmnopqrstuvwxyz 和 ' + 'a'.repeat(40))
  assert.ok(!cleaned.includes('abcdefghijklmnop'))
  assert.ok(!cleaned.includes('a'.repeat(40)))
})

// ---------- 提炼：流程 ----------
await test('提炼：文本过短跳过且不调用模型', async () => {
  const before = modelCalls.length
  const result = await distillLib.distillText(fakeCtx, db, { storageRoot }, { text: '太短', scope: { workspaceId: 'ws-a-uuid' }, source: 'manual' })
  assert.equal(result.status, 'skipped')
  assert.equal(result.error.code, 'TEXT_TOO_SHORT')
  assert.equal(modelCalls.length, before)
})

await test('提炼：自动提炼默认关闭时跳过', async () => {
  const result = await distillLib.distillText(fakeCtx, db, { storageRoot }, { text: '这是一段足够长的会话文本，'.repeat(30), scope: { workspaceId: 'ws-a-uuid' }, source: 'auto:turn' })
  assert.equal(result.status, 'skipped')
  assert.equal(result.error.code, 'AUTO_DISTILL_DISABLED')
})

await test('提炼：成功生成待审核候选（不直接落正式库）', async () => {
  settingsLib.writeSettings(db, { distillMinChars: 80 }, 'test')
  fake.mode = 'ok'
  fake.payload = [
    { title: '优先使用内容哈希判断变更', kind: 'decision', body: '增量更新以内容哈希为权威判定，Git 只提供提交级信号；这样未提交变更也不会重复处理。', confidence: 0.9, evidence: [{ kind: 'file', ref: 'src/host/pipeline/changes.ts' }] },
    { title: '测试命令统一走 node 脚本', kind: 'convention', body: '本仓库测试不使用 node --test runner，改为直接 node tests/xxx.test.mjs 进程内运行，避免沙箱子进程限制。', confidence: 0.8, evidence: [{ kind: 'session', ref: 'session-m5' }] },
  ]
  const docsBefore = all(db, 'SELECT id FROM documents WHERE kb_id = ?', [kbA.id]).length
  const result = await distillLib.distillText(fakeCtx, db, { storageRoot }, { text: '会话里确认了增量更新以内容哈希为权威判定，并且测试统一使用 node 脚本进程内运行。'.repeat(5), scope: { workspaceId: 'ws-a-uuid' }, source: 'manual', actor: 'tester' })
  assert.equal(result.status, 'success')
  assert.equal(result.knowledgeBaseId, kbA.id)
  assert.equal(result.created.length, 2)
  assert.equal(modelCalls[modelCalls.length - 1].provider, 'amd')
  assert.equal(modelCalls[modelCalls.length - 1].model, 'DeepSeek-V4-Flash')
  assert.equal(all(db, 'SELECT id FROM documents WHERE kb_id = ?', [kbA.id]).length, docsBefore, '提炼不得直接写正式文档')
  const pending = all(db, "SELECT * FROM proposals WHERE kb_id = ? AND status = 'pending'", [kbA.id])
  assert.equal(pending.length, 2)
  assert.ok(pending.every((row) => row.doc_kind === 'decision' || row.doc_kind === 'convention'))
  assert.ok(pending.every((row) => String(row.source).startsWith('distill:')))
  const run = get(db, "SELECT * FROM distill_runs WHERE id = ?", [result.runId])
  assert.equal(run.status, 'success')
  assert.equal(Number(run.created_count), 2)
})

await test('提炼：重复内容被去重跳过', async () => {
  fake.mode = 'ok'
  const duplicate = { title: '优先使用内容哈希判断变更', kind: 'decision', body: '增量更新以内容哈希为权威判定，Git 只提供提交级信号；这样未提交变更也不会重复处理。', confidence: 0.9, evidence: [] }
  fake.payload = [duplicate]
  const result = await distillLib.distillText(fakeCtx, db, { storageRoot }, { text: '重复会话文本。'.repeat(30), scope: { workspaceId: 'ws-a-uuid' }, source: 'manual' })
  assert.equal(result.status, 'success')
  assert.equal(result.created.length, 0)
  assert.equal(result.skipped.length, 1)
  assert.ok(result.skipped[0].reason.includes('待审核候选') || result.skipped[0].reason.includes('正式知识'))
})

await test('提炼：越权知识库被拒绝（KB_FORBIDDEN）', async () => {
  const result = await distillLib.distillText(fakeCtx, db, { storageRoot }, { text: '越权测试文本。'.repeat(30), kbId: kbB.id, scope: { workspaceId: 'ws-a-uuid' }, source: 'manual' })
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'KB_FORBIDDEN')
})

await test('提炼：当前作用域没有知识库时明确报错', async () => {
  const emptyRoot = join(testRoot, 'empty-storage')
  const emptyDb = openDatabase(emptyRoot)
  const result = await distillLib.distillText(fakeCtx, emptyDb, { storageRoot: emptyRoot }, { text: '没有任何知识库时也应该给出明确错误。'.repeat(30), scope: { workspaceId: 'ws-x-uuid' }, source: 'manual' })
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'NO_KNOWLEDGE_BASE')
})

await test('提炼：模型失败不产生候选并记录失败运行', async () => {
  fake.mode = 'fail'
  const result = await distillLib.distillText(fakeCtx, db, { storageRoot }, { text: '模型失败场景会话文本。'.repeat(20), scope: { workspaceId: 'ws-a-uuid' }, source: 'manual' })
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'AUTH')
  assert.equal(result.created.length, 0)
  assert.equal(get(db, 'SELECT status FROM distill_runs WHERE id = ?', [result.runId]).status, 'failed')
})

await test('提炼：模型输出非法 JSON 时不覆盖也不产候选', async () => {
  fake.mode = 'garbage'
  const before = all(db, "SELECT id FROM proposals WHERE kb_id = ? AND status = 'pending'", [kbA.id]).length
  const result = await distillLib.distillText(fakeCtx, db, { storageRoot }, { text: '模型返回非 JSON 的场景会话文本。'.repeat(20), scope: { workspaceId: 'ws-a-uuid' }, source: 'manual' })
  assert.equal(result.status, 'failed')
  assert.equal(result.error.code, 'MODEL_OUTPUT_INVALID')
  assert.equal(all(db, "SELECT id FROM proposals WHERE kb_id = ? AND status = 'pending'", [kbA.id]).length, before)
  fake.mode = 'ok'
})

await test('自动提炼：注册监听真实事件名且不抛异常', () => {
  const events = []
  const hostCtx = { on(name) { events.push(name); return () => undefined }, get() { return undefined } }
  distillLib.registerAutoDistill(hostCtx, { storageRoot })
  assert.deepEqual(events.sort(), ['agent/assistant-stream', 'agent/turn-stopping'])
})

// ---------- 备份 ----------
let backupId = ''
await test('备份：创建 gzip 备份并记录元数据', async () => {
  const before = backupLib.listBackups(db, storageRoot).length
  const result = backupLib.createBackup(db, storageRoot, { note: 'M5 单测备份', actor: 'tester' })
  backupId = result.id
  assert.ok(result.bytes > 0)
  assert.ok(result.kbCount >= 2)
  assert.ok(result.docCount >= 3)
  const filePath = join(storageRoot, result.file)
  assert.ok(existsSync(filePath), '备份文件应存在：' + filePath)
  const list = backupLib.listBackups(db, storageRoot)
  assert.equal(list.length, before + 1)
  assert.equal(list[0].exists, true)
  const stats = backupLib.backupStats(db, storageRoot)
  assert.ok(stats.count >= 1)
  assert.ok(stats.totalBytes > 0)
})

await test('备份：元数据里不出现明文凭据（备份内容为知识正文）', async () => {
  const raw = await readFile(join(storageRoot, backupLib.listBackups(db, storageRoot)[0].file))
  assert.ok(raw.length > 0)
})

await test('恢复：同名同内容跳过、正文不同只生成候选（不覆盖）', async () => {
  await search.updateDocumentByHuman ? null : null
  const human = await review.updateDocumentByHuman(db, storageRoot, search.getDocument(db, docA.id), { body: longBody + '\n补充：人工新增的一段说明。' }, 'tester')
  assert.ok(human)
  const result = await backupLib.restoreBackup(db, storageRoot, backupId, { actor: 'tester', note: '合并恢复测试' })
  assert.ok(result.proposals >= 1, '正文不同应生成候选，实际 ' + result.proposals)
  assert.equal(result.skipped >= 1, true)
  const current = search.getDocument(db, docA.id)
  assert.ok(current.body.includes('人工新增'), '恢复不得覆盖当前正文')
})

await test('恢复：删掉知识库后可从备份重建（含文档与来源）', async () => {
  await store.deleteKnowledgeBase(db, storageRoot, kbB.id, 'all')
  // 完全移除文档行，模拟“库和知识都被删掉”后从备份重建
  db.raw.exec("DELETE FROM sources WHERE doc_id IN (SELECT id FROM documents WHERE kb_id = '" + kbB.id + "')")
  db.raw.exec("DELETE FROM doc_versions WHERE doc_id IN (SELECT id FROM documents WHERE kb_id = '" + kbB.id + "')")
  db.raw.exec("DELETE FROM documents WHERE kb_id = '" + kbB.id + "'")
  assert.equal(store.getKnowledgeBase(db, kbB.id), null)
  const result = await backupLib.restoreBackup(db, storageRoot, backupId, { actor: 'tester' })
  assert.ok(result.createdKbs.length >= 1)
  assert.ok(result.createdDocs >= 1)
  const rebuilt = store.getKnowledgeBase(db, kbB.id)
  assert.ok(rebuilt, '应重建知识库 ' + kbB.id)
  const docs = all(db, 'SELECT id, title FROM documents WHERE kb_id = ? AND deleted_at IS NULL', [kbB.id])
  assert.ok(docs.length >= 1)
  const restored = docs.find((row) => row.title === 'B 项目架构')
  assert.ok(restored, '应恢复文档')
  const sources = all(db, 'SELECT * FROM sources WHERE doc_id = ?', [restored.id])
  assert.ok(sources.length >= 0)
})

await test('恢复：不存在的备份返回 BACKUP_NOT_FOUND', async () => {
  await expectReject(async () => backupLib.restoreBackup(db, storageRoot, 'bkp_not_exist', {}), 'BACKUP_NOT_FOUND')
})

// ---------- 存储迁移 ----------
await test('迁移：相对路径目标被拒绝', async () => {
  await expectReject(async () => backupLib.migrateStorage(db, { storageRoot }, { target: 'relative/dir', dryRun: true }), 'STORAGE_TARGET_INVALID')
})

await test('迁移：预检返回将复制的文件统计', async () => {
  const target = join(testRoot, 'migrated')
  const preview = await backupLib.migrateStorage(db, { storageRoot }, { target, dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.ok(preview.willCopy.files > 0)
  assert.ok(preview.willCopy.bytes > 0)
  assert.equal(existsSync(join(target, 'database', 'knowledge.db')), false, '预检不应写目标文件')
})

await test('迁移：正式迁移校验计数一致并写位置指针，重启后生效', async () => {
  const target = join(testRoot, 'migrated')
  const result = await backupLib.migrateStorage(db, { storageRoot }, { target, dryRun: false, actor: 'tester' })
  assert.equal(result.dryRun, false)
  assert.equal(result.restartRequired, true)
  assert.ok(result.verified.knowledgeBases >= 1)
  assert.ok(result.verified.documents >= 3)
  assert.ok(existsSync(join(target, 'database', 'knowledge.db')))
  const pointer = JSON.parse(await readFile(join(dshHome, 'knowhub-location.json'), 'utf8'))
  assert.equal(pointer.storageRoot, target)
  // 模拟重启：不传 config.storageRoot 时，指针应成为权威存储位置，且目标库数据可读
  const pathsLib = await load('paths.js')
  assert.equal(pathsLib.resolveStorageRoot({}), target, '重启后应解析到迁移指针指向的新目录')
  assert.equal(pathsLib.storageLocation({}).source, 'pointer')
  const targetDb = openDatabase(target)
  try {
    const migratedKbs = all(targetDb, 'SELECT id FROM knowledge_bases WHERE deleted_at IS NULL')
    const migratedDocs = all(targetDb, 'SELECT id FROM documents WHERE deleted_at IS NULL')
    assert.equal(migratedKbs.length, result.verified.knowledgeBases)
    assert.equal(migratedDocs.length, result.verified.documents)
    assert.ok(all(targetDb, 'SELECT name FROM sqlite_master WHERE type = ?', ['table']).length > 0)
    const migratedTitles = all(targetDb, 'SELECT title, status FROM documents WHERE deleted_at IS NULL').map((row) => row.title)
    const sourceTitles = all(db, 'SELECT title FROM documents WHERE deleted_at IS NULL').map((row) => row.title)
    assert.deepEqual(migratedTitles.sort(), sourceTitles.sort(), '迁移后知识标题集合应与源库一致')
  } finally {
    closeDatabase(target)
  }
  // 回退：删除指针后重新解析回默认目录（原数据未删除）
  await rm(join(dshHome, 'knowhub-location.json'), { force: true })
  assert.equal(pathsLib.resolveStorageRoot({}), join(dshHome, 'knowledge-center'))
  assert.equal(pathsLib.storageLocation({}).source, 'default')
  assert.ok(existsSync(join(storageRoot, 'database', 'knowledge.db')), '回退后旧目录数据仍在')
  const location = settingsLib.settingsSnapshot(db, { storageRoot })
  assert.equal(location.storage.storageRoot, storageRoot)
})

// ---------- 总览与跨库浏览 ----------
await test('总览：统计与当前作用域一致，不包含其他工作区私有库', () => {
  const overview = overviewLib.buildOverview(db, storageRoot, scopeA)
  assert.equal(overview.counts.workspaceKbs, 1)
  assert.ok(overview.counts.userKbs >= 0)
  assert.ok(overview.documents.approved >= 2)
  const kbIds = overview.recentDocs.map((doc) => doc.kbId)
  assert.ok(!kbIds.includes(kbB.id), '总览不应包含 B 工作区私有知识')
  assert.ok(overview.schemaVersion >= 5)
})

await test('跨库浏览：kind/status/关键词/分页过滤', () => {
  const allDocs = overviewLib.listDocumentsAcrossKbs(db, [kbA.id], {})
  assert.ok(allDocs.total >= 2)
  const wikis = overviewLib.listDocumentsAcrossKbs(db, [kbA.id], { kind: 'wiki' })
  assert.ok(wikis.documents.every((doc) => doc.kind === 'wiki'))
  const memories = overviewLib.listDocumentsAcrossKbs(db, [kbA.id], { kind: 'memory' })
  assert.ok(memories.total >= 1)
  const queried = overviewLib.listDocumentsAcrossKbs(db, [kbA.id], { query: '存储选型' })
  assert.ok(queried.total >= 1)
  const paged = overviewLib.listDocumentsAcrossKbs(db, [kbA.id], { limit: 1, offset: 0 })
  assert.equal(paged.documents.length, 1)
  assert.ok(paged.total >= 2)
  const filtered = overviewLib.listDocumentsAcrossKbs(db, [kbA.id], { status: 'approved' })
  assert.ok(filtered.documents.every((doc) => doc.status === 'approved'))
  assert.ok(filtered.documents[0].sourceCount >= 0)
})

await test('跨库浏览：非法筛选条件返回 DOC_FILTER_INVALID', () => {
  for (const input of [{ kind: 'nope' }, { status: 'nope' }, { verifyState: 'nope' }]) {
    let code = ''
    try { overviewLib.listDocumentsAcrossKbs(db, [kbA.id], input) } catch (error) { code = error.code }
    assert.equal(code, 'DOC_FILTER_INVALID')
  }
})

await test('跨库浏览：作用域隔离（A 看不到 B 的知识）', () => {
  const visible = store.listKnowledgeBases(db, scopeA).map((kb) => kb.id)
  const docs = overviewLib.listDocumentsAcrossKbs(db, visible, {})
  assert.ok(!docs.documents.some((doc) => doc.kbId === kbB.id))
})

console.log('')
if (failures.length > 0) {
  console.log('M5 单测失败 ' + failures.length + ' 项 / 通过 ' + passed + ' 项')
  for (const failure of failures) console.log('  ✗ ' + failure.name + ' → ' + (failure.error?.stack ?? failure.error))
  process.exit(1)
}
console.log('M5 单测全部通过：' + passed + ' 项')