#!/usr/bin/env node
/**
 * 构建：1) tsc 编译宿主（ESM → lib/） 2) tsc 编译客户端为 CJS → 手写注入 ModuleLoader 外壳。
 *
 * 说明：本机 DSH 沙箱禁止子进程管道通信（esbuild 的 service 需要 spawn + pipe，报 EPERM），
 * 因此客户端 bundle 不依赖 esbuild：用 tsc 的 CommonJS 产物 + 官方客户端外壳拼接，
 * 不引入任何运行时依赖（react 由宿主通过 require 提供）。
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tscBin = join(root, '.toolchain', 'node_modules', 'typescript', 'bin', 'tsc')

if (!existsSync(tscBin)) {
  console.error('[knowhub] 缺少 TypeScript：请在 .toolchain 执行 npm install --save typescript @types/node')
  process.exit(1)
}

function runTsc(project) {
  const result = spawnSync(process.execPath, [tscBin, '-p', join(root, project)], { cwd: root, stdio: 'inherit' })
  if (result.error) {
    console.error('[knowhub] 无法启动 tsc：', result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

rmSync(join(root, 'lib'), { recursive: true, force: true })
rmSync(join(root, '.build'), { recursive: true, force: true })

console.log('[knowhub] 1/3 tsc 编译宿主（ESM → lib/host）')
runTsc('tsconfig.json')

console.log('[knowhub] 2/3 tsc 编译客户端（CommonJS → .build/client-cjs）')
runTsc('tsconfig.client.json')

console.log('[knowhub] 3/3 注入 window.__ModuleLoader__ 外壳 → lib/client/index.js')
const compiled = join(root, '.build', 'client-cjs', 'client', 'index.js')
if (!existsSync(compiled)) {
  console.error('[knowhub] 未找到客户端编译产物：' + compiled)
  process.exit(1)
}
const code = readFileSync(compiled, 'utf8')
const header = 'window.__ModuleLoader__.load({ id: "dsh-knowhub", factory: (require) => {\n'
  + 'var module = { exports: {} }; var exports = module.exports;\n'
const footer = '\nreturn module.exports;\n} });\n'
const outDir = join(root, 'lib', 'client')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'index.js'), header + code + footer, 'utf8')

console.log('[knowhub] 构建完成：lib/host/index.js + lib/client/index.js')
