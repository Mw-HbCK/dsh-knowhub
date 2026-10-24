#!/usr/bin/env node
// 统一 CI 入口：类型检查 → 构建 → 渲染冒烟 → 交互测试 → 全部单元/契约测试。
// 设计要点：子进程都用 stdio:'inherit' 直接输出，不通过管道捕获（沙箱下管道可能被拒绝），
// 汇总靠退出码判断，失败时立即以非零退出，方便 GitHub Actions / 本地一键回归。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const steps = []

function run(label, command, args) {
  const started = Date.now()
  console.log('\n=== ' + label + ' ===')
  // 不要用 shell：Windows 上 shell 会把带空格的路径（工作区目录名含空格）拆开，
  // node 会把第一段当成脚本路径导致 MODULE_NOT_FOUND。
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  const elapsed = Date.now() - started
  const ok = result.status === 0
  steps.push({ label, ok, elapsed, status: result.status })
  if (!ok) {
    console.log('--- ' + label + ' 失败（exit ' + result.status + '），中止后续步骤 ---')
    report()
    process.exit(1)
  }
}

function report() {
  console.log('\n=== 汇总 ===')
  for (const step of steps) {
    console.log((step.ok ? 'PASS' : 'FAIL') + '  ' + step.label.padEnd(40) + (step.elapsed / 1000).toFixed(1) + 's')
  }
}

const tsc = [
  path.join(root, '.toolchain', 'node_modules', 'typescript', 'bin', 'tsc'),
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
].find((item) => existsSync(item)) ?? path.join(root, '.toolchain', 'node_modules', 'typescript', 'bin', 'tsc')
const tests = [
  ['冒烟测试 smoke', 'tests/smoke.test.mjs'],
  ['M1 知识库与文档', 'tests/m1.test.mjs'],
  ['M2 审核与版本', 'tests/m2.test.mjs'],
  ['M3 增量更新', 'tests/m3.test.mjs'],
  ['M4 模型调用与备份', 'tests/m4.test.mjs'],
  ['M5 面板与设置', 'tests/m5.test.mjs'],
  ['提炼与精炼', 'tests/refine.test.mjs'],
  ['待审核优化', 'tests/review-opt.test.mjs'],
  ['自动提炼运行时契约', 'tests/distill-runtime.test.mjs'],
  ['注入设置', 'tests/inject-settings.test.mjs'],
  ['P2 父级/反馈/导出导入/备份预览', 'tests/p2.test.mjs'],
  ['客户端交互', 'tests/ui-interaction.test.mjs'],
]

for (const missing of ['lib/host/index.js', 'lib/client/index.js']) {
  if (!existsSync(path.join(root, missing))) {
    console.log('缺少构建产物 ' + missing + '，先执行构建')
    run('构建 bundle', process.execPath, ['scripts/build.mjs'])
    break
  }
}

run('类型检查（宿主）', process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'])
run('类型检查（客户端）', process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.client.json'])
run('构建 bundle', process.execPath, ['scripts/build.mjs'])
run('客户端渲染冒烟', process.execPath, ['tools/verify-client.cjs'])
for (const [label, file] of tests) run(label, process.execPath, [file])

report()
const failed = steps.filter((step) => !step.ok).length
console.log('\nCI ' + (failed === 0 ? 'PASS' : 'FAIL') + '（' + steps.length + ' 步）')
process.exit(failed === 0 ? 0 : 1)
