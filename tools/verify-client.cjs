// 客户端 bundle 渲染冒烟：最小 React 运行时 + 假 fetch，执行模块初始化、注册与各视图首屏渲染。
const path = require('node:path')

let captured = null
global.window = { __ModuleLoader__: { load: (entry) => { captured = entry } } }

let hookCursor = 0
const Fragment = Symbol('Fragment')
const React = {
  Fragment,
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  useState(initial) { hookCursor += 1; return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() { hookCursor += 1 },
  useLayoutEffect() { hookCursor += 1 },
  useMemo(factory) { hookCursor += 1; return factory() },
  useCallback(fn) { hookCursor += 1; return fn },
  useRef(initial) { hookCursor += 1; return { current: initial } },
  useSyncExternalStore(_subscribe, getSnapshot) { hookCursor += 1; return getSnapshot() },
  memo(component) { return component },
  forwardRef(fn) { return fn },
}

const now = Date.now()
const kb = { id: 'kb1', name: '演示知识库', scope: 'workspace', workspaceId: 'ws-1', workspaceTitle: '演示项目', workspacePath: 'C:/demo', status: 'ready', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced', documentCount: 2, updatedAt: now, createdAt: now, scopeKey: 'ws:ws-1' }
const doc = { id: 'd1', kbId: 'kb1', kbName: '演示知识库', kind: 'wiki', title: '系统架构总览', status: 'approved', verifyState: 'observed', currentVersion: 2, updatedAt: now, createdAt: now, tags: ['架构'], excerpt: '架构摘要', sourceCount: 2, body: '正文内容' }
const diffData = {
  kind: 'proposal',
  proposal: { id: 'p1', kbId: 'kb1', kbName: '演示知识库', kind: 'update', title: '系统架构总览', body: '第一行\n新增行\n第三行', docKind: 'wiki', source: 'pipeline', createdBy: 'agent', createdAt: now },
  document: { id: 'd1', title: '系统架构总览', currentVersion: 2, status: 'approved', kind: 'wiki' },
  kb: { id: 'kb1', name: '演示知识库', scopeKey: 'ws:ws-1' },
  base: { title: '系统架构总览', body: '第一行\n第二行\n第三行', version: 2, status: 'approved' },
  target: { title: '系统架构总览', body: '第一行\n新增行\n第三行' },
  diff: {
    lines: [
      { type: 'equal', text: '第一行' },
      { type: 'del', text: '第二行' },
      { type: 'add', text: '新增行' },
      { type: 'equal', text: '第三行' },
    ],
    truncated: false,
    stats: { added: 1, removed: 1, unchanged: 2 },
  },
}
function payloadFor(url) {
  if (url.endsWith('/diff')) return diffData
  if (url.includes('/current-workspace')) return { workspaceId: 'ws-1', workspacePath: 'C:/demo', workspaceTitle: '演示项目' }
  if (url.includes('/workspaces')) return { workspaces: [{ id: 'ws-1', title: '演示项目', path: 'C:/demo' }] }
  if (url.includes('/models')) return { available: true, providers: [{ id: 'amd', name: 'Amd' }], models: [{ provider: 'amd', id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash' }], errors: [] }
  if (url.includes('/review')) return { counts: { proposals: 1, conflicts: 0, drafts: 1, stale: 0, total: 2 }, proposals: [], conflicts: [], drafts: [], staleDocuments: [], workspaceId: 'ws-1', scopeKeys: [] }
  if (url.includes('/documents')) return { total: 1, documents: [doc], knowledgeBases: [kb], counts: { byKind: [], byStatus: [] } }
  if (url.match(/\/kb\/[^/]+\/docs\//)) return { document: doc, sources: [{ id: 's1', kind: 'file', ref: 'src/index.ts', verified: 1, locator: '1-20' }], versions: [{ version: 2, changeKind: 'update', source: 'pipeline', createdAt: now }, { version: 1, changeKind: 'create', source: 'pipeline', createdAt: now }] }
  if (url.match(/\/kb\/kb1\/tasks/)) return { tasks: [] }
  if (url.match(/\/kb\/kb1\/files/)) return { summary: { fileCount: 10, hashedCount: 10, lastIndexedAt: now, byLanguage: [] } }
  if (url.match(/\/kb\/kb1\/llm-calls/)) return { calls: [] }
  if (url.match(/\/kb\/kb1\/git/)) return { checkpoint: { mode: 'hash', lastScanAt: now }, git: { available: false }, recentChanges: [], recheck: [] }
  if (url.match(/\/kb\/kb1\/changes/)) return { changes: [], recheck: [] }
  if (url.match(/\/kb\/kb1$/)) return { knowledgeBase: kb, documentCount: 2 }
  if (url.match(/\/kb(\?|$)/)) return { knowledgeBases: [kb] }
  if (url.includes('/overview')) return { counts: { knowledgeBases: 1, documents: { approved: 1, draft: 1, total: 2 } }, review: { proposals: 1, drafts: 1, conflicts: 0, stale: 0 }, pendingTotal: 2, recentDocs: [], runningTasks: [], recentActivity: [] }
  if (url.includes('/settings')) return { settings: { defaultStrategy: 'balanced', autoDistill: false, distillMinChars: 200, excludeDirs: [], backupKeep: 10, autoBackup: true, autoApprove: false, autoApproveMaxDiffLines: 10, reviewerName: 'tester', injectEnabled: true, injectIncludeUser: true, injectIncludeWorkspace: true, injectMaxChars: 900, injectMaxTitles: 6 }, storage: { storageRoot: 'C:/store', source: 'config' }, note: '' }
  if (url.includes('/backups')) return { backups: [], stats: { count: 0, bytes: 0 } }
  if (url.includes('/distill/runs')) return { runs: [], autoDistill: false, distillMinChars: 200 }
  return {}
}
global.fetch = async (url) => ({ ok: true, status: 200, json: async () => ({ ok: true, value: payloadFor(String(url)) }) })

require(path.join(__dirname, '..', 'lib', 'client', 'index.js'))
if (!captured) throw new Error('bundle did not register with __ModuleLoader__')
const moduleExports = captured.factory((id) => {
  if (id === 'react' || id === 'react/jsx-runtime') return React
  throw new Error('unexpected require: ' + id)
})
console.log('exports:', Object.keys(moduleExports).join(','), '| inject:', JSON.stringify(moduleExports.inject))

function renderNode(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(renderNode).join('')
  if (typeof node.type === 'function') {
    const saved = hookCursor
    hookCursor = 0
    const out = node.type({ ...node.props, children: node.children })
    hookCursor = saved
    return renderNode(out)
  }
  if (typeof node.type === 'symbol') return node.children.map(renderNode).join('')
  return node.children.map(renderNode).join('')
}
let failures = 0
function renderComponent(fn, props, label) {
  try {
    const text = String(renderNode({ type: fn, props: props || {}, children: [] }))
    console.log('RENDER OK   ' + label.padEnd(14) + ' chars=' + text.length + ' text=' + JSON.stringify(text.slice(0, 240)))
    return text
  } catch (error) {
    failures += 1
    console.log('RENDER FAIL ' + label + ': ' + (error && error.stack ? error.stack.split('\n').slice(0, 5).join(' | ') : error))
    return ''
  }
}

const registrations = []
const fakeSlots = {
  inject(key, callback) { callback() },
  register(definition, component) {
    registrations.push({ name: definition.name, key: definition.key || definition.id || '', label: typeof definition.label === 'function' ? definition.label() : '', component })
  },
}
const fakeCtx = {
  get(name) { return name === 'slots' ? fakeSlots : undefined },
  effect(fn) { fn(); return () => {} },
}
moduleExports.apply(fakeCtx)
console.log('registrations:', registrations.map((r) => r.name + '/' + r.key + (r.label ? '/' + r.label : '')).join(', '))
for (const reg of registrations) renderComponent(reg.component, {}, 'slot:' + reg.name)

const smoke = moduleExports.__smoke || {}
// 这些不是"首屏可渲染组件"：Page/renderMarkdown 单独断言；反馈层在下方做专项断言
// （askConfirm 返回 Promise、pushToast 返回 id，直接当组件渲染会污染 toast 队列）。
const SKIP_RENDER = new Set(['Page', 'renderMarkdown', 'Modal', 'ToastHost', 'ConfirmHost', 'pushToast', 'askConfirm', 'settleConfirm', 'useNoticeToast'])
for (const name of Object.keys(smoke)) {
  if (SKIP_RENDER.has(name)) continue
  const props = name === 'KbView'
    ? { models: [{ provider: 'amd', id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash' }], workspaces: [], currentWorkspace: { workspaceId: 'ws-1', title: '演示项目' }, notify: () => {} }
    : name === 'EditKbForm'
    ? { kb: { id: 'kb1', name: '演示知识库', scope: 'workspace', workspacePath: 'C:/demo', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced' }, models: [{ provider: 'amd', id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash' }], onCancel: () => {}, onSaved: () => {} }
    : name === 'CreateKbForm'
    ? { models: [{ provider: 'amd', id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash' }], workspaces: [{ id: 'ws-1', title: '演示项目', path: 'C:/demo' }], currentWorkspaceId: 'ws-1', onCancel: () => {}, onCreated: () => {} }
    : name === 'DocumentDiffPage'
    ? { state: { kind: 'proposal', id: 'p1', loading: false, data: diffData, error: null }, busy: null, error: null, notice: '', note: '', onNote: () => {}, onBack: () => {}, onApproveProposal: () => {}, onRejectProposal: () => {}, onResolveConflict: () => {} }
    : (name === 'ReviewView' || name === 'SearchView') ? { knowledgeBases: [{ id: 'kb1', name: '演示知识库' }] } : {}
  renderComponent(smoke[name], props, name)
}
if (typeof smoke.renderMarkdown === 'function') {
  try {
    const source = [
      '# 系统架构总览',
      '',
      '这一段包含 **加粗**、`行内代码`、[链接](https://example.com) 与 ~~删除线~~。',
      '',
      '## 模块',
      '',
      '- 检索层',
      '- 存储层',
      '',
      '1. 第一步',
      '2. 第二步',
      '',
      '```ts',
      'const answer: number = 42',
      '```',
      '',
      '> 引用说明',
      '',
      '| 列 1 | 列 2 |',
      '| --- | --- |',
      '| a | b |',
      '',
      '---',
    ].join('\n')
    const nodes = smoke.renderMarkdown(source, 'smoke')
    const text = nodes.map(renderNode).join('')
    console.log('RENDER OK   ' + 'renderMarkdown'.padEnd(14) + ' blocks=' + nodes.length + ' text=' + JSON.stringify(text.slice(0, 120)))
    if (nodes.length < 9) throw new Error('expected >=9 blocks, got ' + nodes.length)
    for (const probe of ['系统架构总览', '加粗', '行内代码', '检索层', '第一步', 'const answer', '引用说明', '列 1', 'a']) {
      if (!text.includes(probe)) throw new Error('markdown text missing: ' + probe)
    }
    console.log('MARKDOWN OK')
  } catch (error) {
    failures += 1
    console.log('MARKDOWN FAIL: ' + (error && error.message ? error.message : error))
  }
}
if (typeof smoke.SettingsInjectionCard === 'function') {
  try {
    const form = { injectEnabled: true, injectIncludeUser: true, injectIncludeWorkspace: false, injectMaxChars: 900, injectMaxTitles: 6 }
    const text = String(renderNode({ type: smoke.SettingsInjectionCard, props: { form, patch: () => {} }, children: [] }))
    console.log('RENDER OK   ' + 'InjectionCard'.padEnd(14) + ' chars=' + text.length + ' text=' + JSON.stringify(text.slice(0, 160)))
    for (const probe of ['知识注入', '已开启', '开启知识注入', '注入全局记忆', '注入项目记忆', '摘要最大字符数', '最多列出标题数']) {
      if (!text.includes(probe)) throw new Error('injection card missing: ' + probe)
    }
    console.log('INJECTION CARD OK')
  } catch (error) {
    failures += 1
    console.log('INJECTION CARD FAIL: ' + (error && error.message ? error.message : error))
  }
}
// ---------- 0.8.5 全局反馈层：弹窗外壳 / toast / 确认框 ----------
if (typeof smoke.Modal === 'function') {
  try {
    const text = String(renderNode({ type: smoke.Modal, props: { onClose: () => {}, maxWidth: '600px' }, children: [React.createElement('div', null, '弹窗内容测试')] }))
    console.log('RENDER OK   ' + 'Modal'.padEnd(14) + ' chars=' + text.length + ' text=' + JSON.stringify(text.slice(0, 80)))
    if (!text.includes('弹窗内容测试')) throw new Error('modal children missing')
    console.log('MODAL OK')
  } catch (error) {
    failures += 1
    console.log('MODAL FAIL: ' + (error && error.message ? error.message : error))
  }
}
if (typeof smoke.ToastHost === 'function' && typeof smoke.pushToast === 'function') {
  try {
    smoke.pushToast('设置已保存', 'error')
    const text = String(renderNode({ type: smoke.ToastHost, props: {}, children: [] }))
    console.log('RENDER OK   ' + 'ToastHost'.padEnd(14) + ' chars=' + text.length + ' text=' + JSON.stringify(text.slice(0, 120)))
    for (const probe of ['设置已保存', '!', '✕']) {
      if (!text.includes(probe)) throw new Error('toast text missing: ' + probe)
    }
    console.log('TOAST OK')
  } catch (error) {
    failures += 1
    console.log('TOAST FAIL: ' + (error && error.message ? error.message : error))
  }
}
if (typeof smoke.ConfirmHost === 'function' && typeof smoke.askConfirm === 'function' && typeof smoke.settleConfirm === 'function') {
  try {
    let settled = null
    const pending = smoke.askConfirm({ title: '删除知识库', text: '删除后不可恢复，确认继续？', confirmText: '删除', danger: true }).then((ok) => { settled = ok })
    const text = String(renderNode({ type: smoke.ConfirmHost, props: {}, children: [] }))
    console.log('RENDER OK   ' + 'ConfirmHost'.padEnd(14) + ' chars=' + text.length + ' text=' + JSON.stringify(text.slice(0, 140)))
    for (const probe of ['删除知识库', '删除后不可恢复', '取消', '删除', 'Esc 取消 · Enter 确认']) {
      if (!text.includes(probe)) throw new Error('confirm text missing: ' + probe)
    }
    smoke.settleConfirm(false)
    pending.then(() => {
      try {
        if (settled !== false) throw new Error('confirm should resolve false after cancel')
        console.log('CONFIRM OK')
      } catch (error) {
        failures += 1
        console.log('CONFIRM FAIL: ' + (error && error.message ? error.message : error))
      }
    })
  } catch (error) {
    failures += 1
    console.log('CONFIRM FAIL: ' + (error && error.message ? error.message : error))
  }
}
if (smoke.Page) renderComponent(smoke.Page, {}, 'Page')
if (typeof smoke.diffUnifiedRows === 'function' && typeof smoke.diffSplitRows === 'function') {
  try {
    const unified = smoke.diffUnifiedRows(diffData.diff)
    const split = smoke.diffSplitRows(diffData.diff)
    const unifiedText = unified.map((row) => (row.oldNum === null ? '' : row.oldNum) + ':' + (row.newNum === null ? '' : row.newNum) + ':' + row.type + ':' + row.text).join('|')
    console.log('DIFF OK unified=' + unified.length + ' split=' + split.length + ' ' + unifiedText)
    if (unified.length !== 4) throw new Error('unified rows expected 4, got ' + unified.length)
    if (unified[1].oldNum !== 2 || unified[1].newNum !== null) throw new Error('unified del numbering wrong')
    if (unified[2].newNum !== 2 || unified[2].oldNum !== null) throw new Error('unified add numbering wrong')
    if (split.length !== 3) throw new Error('split rows expected 3 (equal + paired replace + equal), got ' + split.length)
    if (split[1].type !== 'replace' || !split[1].left || !split[1].right) throw new Error('split replace pairing wrong: ' + JSON.stringify(split[1]))
  } catch (error) {
    failures += 1
    console.log('DIFF FAIL: ' + (error && error.message ? error.message : error))
  }
}
// 等确认框的 Promise 微任务跑完再收尾，否则 CONFIRM 断言的结果来不及计入 failures。
// 不用 process.exit：管道下的 stdout 是异步写入，立刻退出会截断最后几行（CONFIRM OK 曾因此丢失）。
setTimeout(() => {
  console.log(failures === 0 ? 'SMOKE PASS' : 'SMOKE FAILURES: ' + failures)
  process.exitCode = failures === 0 ? 0 : 1
}, 20)
