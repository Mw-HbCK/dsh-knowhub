import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('package.json 声明 bundle patch 与 web 客户端', () => {
  assert.equal(pkg.name, 'dsh-knowhub')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(pkg.exports['./client'])
  assert.ok(pkg.exports['./host'])
  assert.ok(pkg.engines?.dsh)
})

test('cordis.patch.yml 含 host 与 ui 两行', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /dsh-knowhub\/host/)
  assert.match(patch, /- id: knowhub/)
  assert.match(patch, /- id: knowhub-ui/)
})

test('构建产物存在且客户端 bundle 带 ModuleLoader 外壳', () => {
  const host = join(root, 'lib', 'host', 'index.js')
  const client = join(root, 'lib', 'client', 'index.js')
  assert.ok(existsSync(host), '缺少 lib/host/index.js，请先 npm run build')
  assert.ok(existsSync(client), '缺少 lib/client/index.js，请先 npm run build')
  const clientCode = readFileSync(client, 'utf8')
  assert.match(clientCode, /window\.__ModuleLoader__\.load\(/)
  assert.match(clientCode, /id: "dsh-knowhub"/)
  assert.ok(clientCode.trimEnd().endsWith('} });'))
})

test('宿主入口可加载：webServer 为可选依赖且不写死模型/工作区数据', async () => {
  const host = await import(new URL('../lib/host/index.js', import.meta.url))
  assert.equal(host.name, 'dsh-knowhub/host')
  assert.ok(Array.isArray(host.inject))
  assert.equal(host.inject.includes('webServer'), false, 'webServer 必须可选（桌面版没有该服务）')
  assert.equal(typeof host.apply, 'function')
  const code = readFileSync(new URL('../lib/host/index.js', import.meta.url), 'utf8')
  assert.match(code, /webServer/, '宿主代码需在运行时解析 webServer')
  assert.doesNotMatch(code, /deepseek-flash|deepseek-account/, '不得写死模型')
  assert.doesNotMatch(code, /C:\\\\Users/, '不得写死路径')
})

test('扫描器默认排除敏感文件与依赖目录', async () => {
  const { scanProject } = await import(new URL('../lib/host/scan.js', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'knowhub-scan-'))
  try {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, '.env'), 'SECRET=1\n')
    writeFileSync(join(dir, 'id_rsa'), 'x\n')
    writeFileSync(join(dir, 'node_modules', 'lib.js'), 'module.exports = 1\n')
    const result = await scanProject(dir)
    assert.equal(result.fileCount, 1, '只应统计 src/app.ts')
    assert.equal(result.skippedSensitive, 2, '.env 与 id_rsa 都必须被跳过')
    assert.ok(result.excludedDirs.includes('node_modules'))
    assert.ok(result.byExtension.some((entry) => entry.extension === '.ts'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('扫描器拒绝越界路径（不存在的目录）', async () => {
  const { scanProject } = await import(new URL('../lib/host/scan.js', import.meta.url))
  await assert.rejects(() => scanProject(join(tmpdir(), 'knowhub-definitely-missing-' + Date.now())))
})
