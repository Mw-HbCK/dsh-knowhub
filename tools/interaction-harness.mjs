// P3 交互测试：最小但可用的 React 运行时（useState/useEffect/useMemo/useRef + 按位置复用实例）
// + 假 fetch + 点击/输入驱动，用于验证面板真实交互（分页加载、反馈提交、导入、配置编辑、筛选排序）。
// 与 tools/verify-client.cjs 的区别：那个只做首屏渲染冒烟，这里会模拟用户操作并断言发出的请求与界面变化。
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.dirname(fileURLToPath(import.meta.url))
let captured = null

// ---- 最小 React ----
const Fragment = Symbol('Fragment')
let currentInstance = null
let instanceStore = new Map()
let pendingEffects = []
let dirty = false
let rootVnode = null

const React = {
  Fragment,
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  useState(initial) {
    const inst = currentInstance
    const index = inst.index
    inst.index += 1
    if (!(index in inst.hooks)) inst.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    const slot = inst.hooks[index]
    const setter = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      dirty = true
    }
    return [slot.value, setter]
  },
  useEffect(fn, deps) {
    const inst = currentInstance
    const index = inst.index
    inst.index += 1
    const previous = inst.hooks[index]
    const changed = !previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((item, i) => !Object.is(item, previous.deps[i]))
    if (changed) {
      inst.hooks[index] = { deps: deps || null, cleanup: previous ? previous.cleanup : undefined }
      pendingEffects.push({ inst, fn, slot: inst.hooks[index] })
    }
  },
  useLayoutEffect(fn, deps) { React.useEffect(fn, deps) },
  useMemo(factory, deps) {
    const inst = currentInstance
    const index = inst.index
    inst.index += 1
    const previous = inst.hooks[index]
    const changed = !previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((item, i) => !Object.is(item, previous.deps[i]))
    if (changed) inst.hooks[index] = { deps: deps || null, value: factory() }
    return inst.hooks[index].value
  },
  useCallback(fn, deps) {
    const inst = currentInstance
    const index = inst.index
    inst.index += 1
    const previous = inst.hooks[index]
    const changed = !previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((item, i) => !Object.is(item, previous.deps[i]))
    if (changed) inst.hooks[index] = { deps: deps || null, value: fn }
    return inst.hooks[index].value
  },
  useRef(initial) {
    const inst = currentInstance
    const index = inst.index
    inst.index += 1
    if (!(index in inst.hooks)) inst.hooks[index] = { value: { current: initial } }
    return inst.hooks[index].value
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    const inst = currentInstance
    inst.index += 1
    return getSnapshot()
  },
  memo(component) { return component },
  forwardRef(fn) { return fn },
}

// ---- 渲染（按路径复用实例，hook 状态才不会被重置）----
function render(vnode, instancePath) {
  if (vnode === null || vnode === undefined || vnode === false || vnode === true) return { kind: 'empty' }
  if (typeof vnode === 'string' || typeof vnode === 'number') return { kind: 'text', text: String(vnode) }
  if (Array.isArray(vnode)) return { kind: 'list', items: vnode.map((item, i) => render(item, instancePath + '.' + i)) }
  if (typeof vnode.type === 'function') {
    let inst = instanceStore.get(instancePath)
    if (!inst) {
      inst = { hooks: [], index: 0 }
      instanceStore.set(instancePath, inst)
    }
    inst.type = vnode.type
    inst.props = vnode.props
    inst.index = 0
    const previous = currentInstance
    currentInstance = inst
    let output
    try {
      output = vnode.type({ ...vnode.props, children: vnode.children })
    } finally {
      currentInstance = previous
    }
    return { kind: 'component', type: vnode.type, props: vnode.props, rendered: render(output, instancePath + '#') }
  }
  const children = (vnode.children || []).map((child, i) => render(child, instancePath + ':' + i))
  return { kind: 'node', type: vnode.type, props: vnode.props, children }
}

function collectText(tree) {
  if (!tree) return ''
  if (tree.kind === 'text') return tree.text
  if (tree.kind === 'list') return tree.items.map(collectText).join('')
  if (tree.kind === 'component') return collectText(tree.rendered)
  if (tree.kind === 'node') return tree.children.map(collectText).join('')
  return ''
}

function* walk(tree) {
  if (!tree) return
  if (tree.kind === 'list') { for (const item of tree.items) yield* walk(item); return }
  if (tree.kind === 'component') { yield tree; yield* walk(tree.rendered); return }
  if (tree.kind === 'node') { yield tree; for (const child of tree.children) yield* walk(child) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function settle(rounds = 40) {
  for (let i = 0; i < rounds; i += 1) {
    await sleep(15)
    let acted = false
    while (pendingEffects.length > 0) {
      const effects = pendingEffects.splice(0)
      for (const effect of effects) {
        if (typeof effect.slot.cleanup === 'function') {
          try { effect.slot.cleanup() } catch (error) { /* ignore cleanup errors */ }
        }
        const previous = currentInstance
        currentInstance = effect.inst
        effect.inst.index = 0
        try {
          const cleanup = effect.fn()
          effect.slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
        } catch (error) {
          effect.slot.cleanup = undefined
          console.log('effect error: ' + (error && error.message ? error.message : error))
        } finally {
          currentInstance = previous
        }
        acted = true
      }
    }
    if (dirty) {
      dirty = false
      rootVnode.rendered = render(rootVnode.vnode, 'root')
      acted = true
    }
    if (!acted) return
  }
}

const documentStub = {
  createElement() {
    return { style: {}, setAttribute() {}, click() {}, remove() {}, appendChild() {} }
  },
  addEventListener() {},
  removeEventListener() {},
  get body() { return { appendChild() {}, removeChild() {}, style: {} } },
}
globalThis.document = documentStub
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry } }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }) }
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'interaction-test' }, configurable: true }) } catch (error) { /* Node 已内置不可写 navigator，忽略 */ }
globalThis.localStorage = globalThis.window.localStorage
globalThis.matchMedia = globalThis.window.matchMedia

// ---- 假 fetch：记录请求，按 handler 返回 ----
const calls = []
let handler = () => ({})
globalThis.fetch = async (url, init) => {
  const request = { url: String(url), method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null }
  calls.push(request)
  const value = await handler(request)
  return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
}
function resetCalls(nextHandler) {
  calls.length = 0
  handler = nextHandler
}

require(path.join(root, '..', 'lib', 'client', 'index.js'))
if (!captured) throw new Error('bundle did not register with __ModuleLoader__')
const moduleExports = captured.factory((id) => {
  if (id === 'react' || id === 'react/jsx-runtime') return React
  throw new Error('unexpected require: ' + id)
})
const smoke = moduleExports.__smoke || {}

async function mount(type, props) {
  instanceStore = new Map()
  pendingEffects = []
  dirty = false
  rootVnode = { vnode: { type, props: props || {}, children: [] }, rendered: null }
  rootVnode.rendered = render(rootVnode.vnode, 'root')
  await settle()
  return rootVnode.rendered
}
/** 挂载视图本身 + 全局反馈层（ToastHost/ConfirmHost），用于断言 toast 与确认框这类跨组件 UI。 */
async function mountHosted(type, props) {
  const Hosted = function Hosted() {
    return React.createElement(Fragment, null,
      React.createElement(type, props || {}),
      smoke.ToastHost ? React.createElement(smoke.ToastHost, null) : null,
      smoke.ConfirmHost ? React.createElement(smoke.ConfirmHost, null) : null)
  }
  return mount(Hosted, {})
}
/** 当前 toast 文案（组件外部可观测，用于断言"操作成功后的反馈"）。 */
function toasts() {
  return typeof smoke.toastSnapshot === 'function' ? smoke.toastSnapshot() : []
}
function tree() { return rootVnode.rendered }
function text() { return collectText(tree()) }
function findNodes(predicate) {
  const found = []
  for (const node of walk(tree())) {
    if (node.kind === 'node' && predicate(node)) found.push(node)
  }
  return found
}
function nodeText(node) { return collectText(node) }
function byText(label) {
  const nodes = findNodes((node) => node.type === 'button' && nodeText(node).includes(label))
  if (nodes.length === 0) throw new Error('找不到按钮：' + label + '（当前文本：' + text().slice(0, 300) + '）')
  return nodes[0]
}
async function click(label) {
  const node = byText(label)
  if (typeof node.props.onClick !== 'function') throw new Error('按钮没有 onClick：' + label)
  await node.props.onClick({ preventDefault() {}, stopPropagation() {} })
  await settle()
  return node
}
function inputByPlaceholder(placeholder) {
  const nodes = findNodes((node) => (node.type === 'input' || node.type === 'textarea') && node.props.placeholder === placeholder)
  if (nodes.length === 0) throw new Error('找不到输入框：' + placeholder + '（当前文本：' + text().slice(0, 300) + '）')
  return nodes[0]
}
function textareaAt(index) {
  const nodes = findNodes((node) => node.type === 'textarea')
  const node = nodes[index]
  if (!node) throw new Error('找不到第 ' + index + ' 个 textarea')
  return node
}
async function typeInto(node, value) {
  if (typeof node.props.onChange !== 'function') throw new Error('输入框没有 onChange')
  await node.props.onChange({ target: { value } })
  await settle()
}
function selectByValue(value) {
  const nodes = findNodes((node) => node.type === 'select' && node.props.value === value)
  if (nodes.length === 0) throw new Error('找不到下拉框 value=' + value + '（当前文本：' + text().slice(0, 300) + '）')
  return nodes[0]
}
async function choose(node, value) {
  if (typeof node.props.onChange !== 'function') throw new Error('下拉框没有 onChange')
  await node.props.onChange({ target: { value } })
  await settle()
}

// ---- 断言 ----
let failures = 0
let checks = 0
function check(condition, message) {
  checks += 1
  if (condition) return
  failures += 1
  console.log('  FAIL ' + message)
}
function checkText(expect, message) {
  const body = text()
  check(body.includes(expect), (message || '缺少文本') + '：' + expect)
}
async function testCase(name, fn) {
  console.log('CASE ' + name)
  try {
    await fn()
  } catch (error) {
    failures += 1
    console.log('  ERROR ' + (error && error.stack ? error.stack.split(String.fromCharCode(10)).slice(0, 6).join(' | ') : error))
  }
}

function failureCount() { return failures }
function checkCount() { return checks }
export { smoke, mount, mountHosted, toasts, tree, text, findNodes, nodeText, byText, click, inputByPlaceholder, textareaAt, typeInto, selectByValue, choose, resetCalls, calls, settle, testCase, check, checkText, sleep, failureCount, checkCount }
