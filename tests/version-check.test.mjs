/**
 * C-3 验收测试：运行版本 vs 安装版本对比（进程内运行）。
 *
 * 覆盖：启动定格（capture 只定格一次）、纯对比函数（含 null 防误报）、
 *       GET /knowhub/api/version 端点信封、/diagnose 的 plugin 段新字段。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const libRoot = new URL('../lib/host/', import.meta.url)
const load = (relative) => import(new URL(relative, libRoot).href)

const diagnostics = await load('diagnostics.js')
const { createRouter } = await load('route.js')
const ownPkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

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

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body ? body.toString('utf8') : '' },
  }
}

async function getJson(router, url) {
  const res = fakeRes()
  await router.handle({ url, method: 'GET' }, res)
  assert.equal(res.status, 200, url + ' 应返回 200，实际 ' + res.status + '：' + res.body.slice(0, 200))
  return JSON.parse(res.body)
}

await test('captureRunningVersion 把当前磁盘版本定格，且重复捕获不覆盖', async () => {
  diagnostics.setRunningVersionForTest(null)
  const captured = diagnostics.captureRunningVersion()
  assert.equal(captured, ownPkg.version)
  assert.equal(diagnostics.getRunningVersion(), ownPkg.version)
  diagnostics.setRunningVersionForTest('0.0.1-test')
  assert.equal(diagnostics.captureRunningVersion(), '0.0.1-test', '已定格后不应被后续捕获覆盖')
})

await test('compareVersions：相等不报、不等才报、任一侧 null 永不误报', async () => {
  assert.deepEqual(diagnostics.compareVersions('0.8.8', '0.8.8'), { running: '0.8.8', installed: '0.8.8', mismatch: false })
  assert.deepEqual(diagnostics.compareVersions('0.8.8', '0.9.0'), { running: '0.8.8', installed: '0.9.0', mismatch: true })
  assert.deepEqual(diagnostics.compareVersions('0.9.0', '0.8.8'), { running: '0.9.0', installed: '0.8.8', mismatch: true }, '磁盘回滚同样算不一致')
  assert.equal(diagnostics.compareVersions(null, '0.9.0').mismatch, false)
  assert.equal(diagnostics.compareVersions('0.8.8', null).mismatch, false)
  assert.equal(diagnostics.compareVersions(null, null).mismatch, false)
})

await test('buildVersionCheck：运行版本未定格（null）时 mismatch 为 false 且不丢安装版本', async () => {
  diagnostics.setRunningVersionForTest(null)
  const check = await diagnostics.buildVersionCheck()
  assert.equal(check.running, null)
  assert.equal(check.installed, ownPkg.version)
  assert.equal(check.mismatch, false)
  assert.equal(check.name, ownPkg.name)
})

await test('GET /version：版本一致时返回 {running, installed, mismatch:false}', async () => {
  diagnostics.setRunningVersionForTest(ownPkg.version)
  const router = createRouter(null, {})
  const payload = await getJson(router, '/knowhub/api/version')
  assert.equal(payload.ok, true)
  assert.equal(payload.value.running, ownPkg.version)
  assert.equal(payload.value.installed, ownPkg.version)
  assert.equal(payload.value.mismatch, false)
})

await test('GET /version：注入假运行版本时返回 mismatch:true 且两个版本号原样透传', async () => {
  const router = createRouter(null, {}, { runningVersion: '0.0.1-test' })
  const payload = await getJson(router, '/knowhub/api/version')
  assert.equal(payload.ok, true)
  assert.equal(payload.value.running, '0.0.1-test')
  assert.equal(payload.value.installed, ownPkg.version)
  assert.equal(payload.value.mismatch, true)
})

await test('GET /diagnose：plugin 段含 installedVersion/versionMismatch，version 为运行版本', async () => {
  diagnostics.setRunningVersionForTest(ownPkg.version)
  const router = createRouter(null, {})
  const same = await getJson(router, '/knowhub/api/diagnose?section=tools')
  assert.equal(same.value.plugin.version, ownPkg.version)
  assert.equal(same.value.plugin.installedVersion, ownPkg.version)
  assert.equal(same.value.plugin.versionMismatch, false)
  assert.equal(same.value.plugin.route, '/knowhub/api/*', '老字段应保留')

  diagnostics.setRunningVersionForTest('0.0.1-test')
  const diff = await getJson(router, '/knowhub/api/diagnose?section=tools')
  assert.equal(diff.value.plugin.version, '0.0.1-test')
  assert.equal(diff.value.plugin.installedVersion, ownPkg.version)
  assert.equal(diff.value.plugin.versionMismatch, true)
  diagnostics.setRunningVersionForTest(ownPkg.version)
})

console.log('\n' + (failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.length) + '（' + passed + ' 通过 / ' + failures.length + ' 失败）')
process.exit(failures.length === 0 ? 0 : 1)
