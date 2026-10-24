// P3 交互测试用例：用 tools/interaction-harness.mjs 的真实 hook 运行时驱动面板组件。
import { smoke, mount, mountHosted, toasts, text, byText, click, textareaAt, typeInto, selectByValue, choose, inputByPlaceholder, findNodes, nodeText, resetCalls, calls, testCase, check, checkText, sleep, failureCount, checkCount } from '../tools/interaction-harness.mjs'

const now = Date.now()
const kb = { id: 'kb1', name: '演示知识库', scope: 'workspace', workspaceId: 'ws-1', workspaceTitle: '演示项目', workspacePath: 'C:/demo', status: 'ready', modelProvider: 'amd', modelId: 'DeepSeek-V4-Flash', modelStrategy: 'balanced', documentCount: 120, updatedAt: now, createdAt: now, scopeKey: 'ws:ws-1' }

function makeDoc(index, page) {
  return {
    id: 'doc' + index,
    kbId: 'kb1',
    kbName: '演示知识库',
    kind: 'wiki',
    title: '知识条目 ' + index,
    status: 'approved',
    verifyState: 'observed',
    currentVersion: 1,
    updatedAt: now - index * 1000,
    createdAt: now - index * 1000,
    tags: [],
    excerpt: '摘要 ' + index,
    sourceCount: 1,
    page,
  }
}
const allDocs = Array.from({ length: 120 }, (_item, i) => makeDoc(i + 1))

function docListHandler(request) {
  if (!request.url.includes('/documents?')) return {}
  const page = Number(new URL(request.url, 'http://local').searchParams.get('page') || '1')
  const limit = Number(new URL(request.url, 'http://local').searchParams.get('limit') || '50')
  const start = (page - 1) * limit
  return { total: allDocs.length, count: allDocs.slice(start, start + limit).length, limit, page, offset: start, documents: allDocs.slice(start, start + limit), knowledgeBases: [kb], feedback: {} }
}
function detailHandler(request) {
  const match = request.url.match(/\/kb\/kb1\/docs\/(doc\d+)$/)
  if (!match) return {}
  const doc = allDocs.find((item) => item.id === match[1])
  return {
    document: { ...doc, body: '正文内容：' + doc.title },
    sources: [{ id: 's1', kind: 'file', ref: 'src/index.ts', verified: 1, locator: '1-20' }],
    versions: [{ version: 1, changeKind: 'create', source: 'pipeline', createdAt: now }],
    feedback: { docId: doc.id, helpful: 1, notHelpful: 0, total: 1, lastAt: now, lastReason: null },
    parent: null,
    children: [],
  }
}

await testCase('DocsExplorer 分页：共 120 条 → 加载更多拉第 2 页并累加', async () => {
  resetCalls((request) => {
    if (request.url.includes('/documents?')) return docListHandler(request)
    if (request.url.match(/\/kb\/kb1\/docs\/doc\d+$/)) return detailHandler(request)
    if (request.url.includes('/current-workspace')) return { workspaceId: 'ws-1', workspacePath: 'C:/demo', workspaceTitle: '演示项目' }
    return {}
  })
  await mount(smoke.DocsExplorer, {})
  checkText('共 120 条，已显示 50 条', '初始分页提示')
  checkText('加载更多', '加载更多按钮')
  await click('加载更多')
  checkText('共 120 条，已显示 100 条', '加载更多后的计数')
  const pages = calls.filter((item) => item.url.includes('/documents?')).map((item) => new URL(item.url, 'http://local').searchParams.get('page'))
  check(pages.join(',') === '1,2', '应当依次请求第 1、2 页，实际：' + pages.join(','))
})

await testCase('DocsExplorer 反馈：点击有帮助 → POST feedback 且显示统计', async () => {
  resetCalls((request) => {
    if (request.url.includes('/documents?')) return docListHandler(request)
    if (request.url.match(/\/kb\/kb1\/docs\/doc\d+\/feedback$/)) return { feedback: { docId: 'doc1', helpful: 1, notHelpful: 0, total: 1, lastAt: now, lastReason: '很有用' }, summary: { docId: 'doc1', helpful: 1, notHelpful: 0, total: 1, lastAt: now, lastReason: '很有用' }, message: '已记录：这条知识有帮助' }
    if (request.url.match(/\/kb\/kb1\/docs\/doc\d+$/)) return detailHandler(request)
    return {}
  })
  await mountHosted(smoke.DocsExplorer, {})
  await click('知识条目 1')
  await sleep(30)
  await click('有帮助')
  const posts = calls.filter((item) => item.url.includes('/feedback'))
  check(posts.length === 1, '应当只提交一次反馈，实际 ' + posts.length)
  check(posts[0] && posts[0].method === 'POST', '反馈必须是 POST')
  check(posts[0] && posts[0].body && posts[0].body.helpful === true, '帮助反馈的 helpful 应为 true')
  // 0.8.5：临时提示改为右下角 toast（由 ToastHost 渲染），不再占用页面布局
  checkText('已记录', '提交反馈后的 toast 提示')
  check(toasts().some((item) => item.includes('已记录')), 'toast 队列应包含提交反馈的结果，实际：' + JSON.stringify(toasts()))
})

await testCase('ImportMarkdownForm：粘贴内容 → POST import 并展示结果', async () => {
  resetCalls((request) => {
    if (request.url.match(/\/kb\/kb1\/import$/)) return { result: { created: [{ id: 'new1', title: '导入的知识', kind: 'wiki' }], skipped: [], failed: [], parentLinked: 0, warnings: [] }, message: '导入完成：新建 1 篇草稿' }
    return {}
  })
  await mount(smoke.ImportMarkdownForm, { kbId: 'kb1', kbName: '演示知识库', onCancel: () => {}, onDone: () => {} })
  checkText('导入 Markdown', '弹窗标题')
  await typeInto(textareaAt(0), '<!-- knowhub:doc\n{"title":"导入的知识"}\n-->\n正文')
  await click('开始导入')
  const posts = calls.filter((item) => item.url.includes('/kb/kb1/import'))
  check(posts.length === 1, '应当提交一次导入，实际 ' + posts.length)
  check(posts[0] && posts[0].body && String(posts[0].body.content).includes('导入的知识'), '导入内容应包含粘贴的 Markdown')
  checkText('导入的知识', '导入结果里的新建标题')
})

await testCase('EditKbForm：只改名 → PATCH 不携带未变的模型字段', async () => {
  resetCalls((request) => {
    if (request.url.match(/\/kb\/kb1$/) && request.method === 'PATCH') return { knowledgeBase: { ...kb, name: '改名后的知识库' } }
    return {}
  })
  await mount(smoke.EditKbForm, { kb, models: [{ provider: 'amd', id: 'DeepSeek-V4-Flash', name: 'DeepSeek-V4-Flash' }], onCancel: () => {}, onSaved: () => {} })
  checkText('编辑知识库配置', '弹窗标题')
  await typeInto(inputByPlaceholder('例如：知枢 KnowHub 项目知识库'), '改名后的知识库')
  await click('保存配置')
  const patches = calls.filter((item) => item.method === 'PATCH')
  check(patches.length === 1, '应当发一次 PATCH，实际 ' + patches.length)
  check(patches[0] && patches[0].body.name === '改名后的知识库', 'PATCH 应携带新名称')
  check(patches[0] && patches[0].body.modelProvider === undefined && patches[0].body.modelId === undefined, '模型未变化时不应提交 provider/modelId')
  check(patches[0] && patches[0].body.modelStrategy === 'balanced', '应保留原策略')
})

await testCase('ReviewView 排序：切换为最早提交 → 请求带 order=oldest 且回到第 1 页', async () => {
  const proposal = { id: 'p1', kbId: 'kb1', kbName: '演示知识库', kind: 'update', title: '项目总览', body: '新正文', docKind: 'wiki', source: 'pipeline', createdBy: 'agent', createdAt: now }
  resetCalls((request) => {
    if (request.url.includes('/review?')) return { counts: { proposals: 3, conflicts: 0, drafts: 0, stale: 0, total: 3 }, proposals: [proposal], conflicts: [], drafts: [], staleDocuments: [], pendingTotal: 3, workspaceId: 'ws-1', scopeKeys: [], filters: {}, pagination: { limit: 50, offset: 0, page: 1, totals: { proposals: 3, conflicts: 0, drafts: 0, stale: 0 } } }
    return {}
  })
  await mount(smoke.ReviewView, { knowledgeBases: [{ id: 'kb1', name: '演示知识库' }] })
  const sortSelect = selectByValue('newest')
  await choose(sortSelect, 'oldest')
  const urls = calls.filter((item) => item.url.includes('/review?')).map((item) => item.url)
  check(urls.some((url) => url.includes('order=oldest')), '应当请求 order=oldest，实际：' + urls.join(' | '))
  const last = urls[urls.length - 1] || ''
  check(last.includes('order=oldest'), '最后一次请求应是 oldest 排序')
  check(!last.includes('page=2'), '切换排序后应回到第 1 页')
})

await testCase('ReviewView 跨页全选：按筛选翻页凑满 50 条并提示已截断', async () => {
  const proposals = Array.from({ length: 30 }, (_item, i) => ({ id: 'prop' + i, kbId: 'kb1', kbName: '演示知识库', kind: 'update', title: '知识 ' + i, body: '正文', docKind: 'wiki', source: 'pipeline', createdBy: 'agent', createdAt: now }))
  resetCalls((request) => {
    if (request.url.includes('/review?')) {
      const page = Number(new URL(request.url, 'http://local').searchParams.get('page') || '1')
      const slice = proposals.slice((page - 1) * 30, page * 30)
      return { counts: { proposals: 60, conflicts: 0, drafts: 0, stale: 0, total: 60 }, proposals: slice, conflicts: [], drafts: [], staleDocuments: [], pendingTotal: 60, workspaceId: 'ws-1', scopeKeys: [], filters: {}, pagination: { limit: 30, offset: (page - 1) * 30, page, totals: { proposals: 60, conflicts: 0, drafts: 0, stale: 0 } } }
    }
    if (request.url.includes('/review/bulk')) return { results: [], approved: 0, rejected: 0, failed: 0, message: 'ok' }
    return {}
  })
  await mountHosted(smoke.ReviewView, { knowledgeBases: [{ id: 'kb1', name: '演示知识库' }] })
  checkText('全选筛选结果', '跨页全选按钮')
  await click('全选筛选结果')
  await sleep(50)
  const reviewPages = calls.filter((item) => item.url.includes('/review?') && item.url.includes('limit=100')).length
  check(reviewPages >= 1, '跨页全选应按 limit=100 拉取筛选结果，实际请求 ' + reviewPages + ' 次')
  checkText('已选择', '全选后的 toast 提示')
  check(toasts().some((item) => item.includes('已选择')), 'toast 队列应包含全选结果，实际：' + JSON.stringify(toasts()))
})

await testCase('确认框：危险操作先弹确认，取消不发请求、确认后才提交', async () => {
  resetCalls((request) => {
    if (request.url.includes('/documents?')) return docListHandler(request)
    if (request.url.match(/\/kb\/kb1\/docs\/doc1\/review$/)) return { document: { ...allDocs[0], status: 'stale' }, message: '已标记为过时' }
    if (request.url.match(/\/kb\/kb1\/docs\/doc\d+$/)) return detailHandler(request)
    return {}
  })
  await mountHosted(smoke.DocsExplorer, {})
  await click('知识条目 1')
  await sleep(30)
  // 第一次：弹确认框但点「取消」，不应发出任何审核请求
  await click('标记过时')
  checkText('标记为过时', '确认框标题')
  checkText('Esc 取消 · Enter 确认', '确认框快捷提示')
  await click('取消')
  const afterCancel = calls.filter((item) => item.url.includes('/review')).length
  check(afterCancel === 0, '取消后不应发出审核请求，实际 ' + afterCancel + ' 次')
  // 第二次：确认后才提交
  await click('标记过时')
  await click('确认标记过时')
  await sleep(40)
  const posts = calls.filter((item) => item.method === 'POST' && item.url.match(/\/kb\/kb1\/docs\/doc1\/review$/))
  check(posts.length === 1, '确认后应提交一次标记过时请求，实际 ' + posts.length)
  check(!!(posts[0] && posts[0].body && posts[0].body.action === 'mark_stale'), 'body.action 应为 mark_stale')
  check(toasts().some((item) => item.includes('已标记为过时')), 'toast 队列应包含标记结果，实际：' + JSON.stringify(toasts()))
})

await testCase('ReviewView 草稿卡：点「查看详情与差异」进入知识对比页并可直接批准', async () => {
  const draft = { id: 'doc9', kbId: 'kb1', kbName: '演示知识库', title: '待审核草稿知识', kind: 'wiki', status: 'draft', currentVersion: 1, updatedAt: now, createdAt: now }
  resetCalls((request) => {
    if (request.url.includes('/review/documents/doc9/diff')) {
      return {
        kind: 'document',
        document: { id: 'doc9', title: '待审核草稿知识', currentVersion: 1, status: 'draft', kind: 'wiki', kbId: 'kb1' },
        kb: { id: 'kb1', name: '演示知识库', scopeKey: 'ws:ws-1' },
        base: { title: null, body: '', version: null, status: null },
        target: { title: '待审核草稿知识', body: '第一行\n第二行' },
        diff: { lines: [{ type: 'add', text: '第一行' }, { type: 'add', text: '第二行' }], truncated: false, stats: { added: 2, removed: 0, unchanged: 0 } },
      }
    }
    if (request.url.includes('/review?')) {
      return { counts: { proposals: 0, conflicts: 0, drafts: 1, stale: 0, total: 1 }, proposals: [], conflicts: [], drafts: [draft], staleDocuments: [], pendingTotal: 1, workspaceId: 'ws-1', scopeKeys: [], filters: {}, pagination: { limit: 50, offset: 0, page: 1, totals: { proposals: 0, conflicts: 0, drafts: 1, stale: 0 } } }
    }
    if (request.url.includes('/kb/kb1/docs/doc9/review')) return { document: draft, message: '已批准' }
    return {}
  })
  await mount(smoke.ReviewView, { knowledgeBases: [{ id: 'kb1', name: '演示知识库' }] })
  checkText('查看详情与差异', '草稿卡应提供差异入口')
  await click('查看详情与差异')
  await sleep(60)
  check(calls.some((item) => item.url.includes('/review/documents/doc9/diff')), '应请求知识对比端点，实际：' + calls.map((item) => item.url).join(' | '))
  checkText('知识对比：', '对比页标题应标明是知识对比')
  checkText('批准这条知识', '草稿对比页主按钮')
  checkText('只有一版历史', '单版知识应提示没有历史版本')
  await click('批准这条知识')
  await sleep(60)
  const posts = calls.filter((item) => item.method === 'POST' && item.url.includes('/kb/kb1/docs/doc9/review'))
  check(posts.length === 1, '批准应走文档审核端点，实际 ' + posts.length + ' 次')
  check(!!(posts[0] && posts[0].body && posts[0].body.action === 'approve'), 'body.action 应为 approve')
})

if (smoke.diffUnifiedRows) {
  await testCase('diff 视图渲染（回归：统一/并排数据源仍可用）', async () => {
    const data = {
      kind: 'proposal',
      proposal: { id: 'p1', kbId: 'kb1', kbName: '演示知识库', kind: 'update', title: '系统架构总览', body: '第一行\n新增行\n第三行', docKind: 'wiki', source: 'pipeline', createdBy: 'agent', createdAt: now },
      document: { id: 'doc1', title: '系统架构总览', currentVersion: 2, status: 'approved', kind: 'wiki' },
      kb: { id: 'kb1', name: '演示知识库', scopeKey: 'ws:ws-1' },
      base: { title: '系统架构总览', body: '第一行\n第二行\n第三行', version: 2, status: 'approved' },
      target: { title: '系统架构总览', body: '第一行\n新增行\n第三行' },
      diff: { lines: [{ type: 'equal', text: '第一行' }, { type: 'del', text: '第二行' }, { type: 'add', text: '新增行' }, { type: 'equal', text: '第三行' }], truncated: false, stats: { added: 1, removed: 1, unchanged: 2 } },
    }
    await mount(smoke.DocumentDiffPage, { state: { kind: 'proposal', id: 'p1', loading: false, data, error: null }, busy: null, error: null, notice: '', note: '', onNote: () => {}, onBack: () => {}, onApproveProposal: () => {}, onRejectProposal: () => {}, onResolveConflict: () => {} })
    checkText('新增 1 行', '新增统计')
    checkText('删除 1 行', '删除统计')
  })
}


// ---- 0.8.0 对比页增强：行内词元高亮 / 上下文折叠 / 改动跳转 / 相似度配对 / 换行开关 ----
const diffProps = (data, extra = {}) => ({
  state: { kind: 'proposal', id: 'p1', loading: false, data, error: null },
  busy: null, error: null, notice: '', note: '', onNote: () => {}, onBack: () => {},
  onApproveProposal: () => {}, onRejectProposal: () => {}, onResolveConflict: () => {}, ...extra,
})
const proposalShell = (overrides) => ({
  kind: 'proposal',
  proposal: { id: 'p1', kbId: 'kb1', kbName: '演示知识库', kind: 'update', title: '系统架构总览', body: '', docKind: 'wiki', source: 'pipeline', createdBy: 'agent', createdAt: now },
  document: { id: 'doc1', title: '系统架构总览', currentVersion: 2, status: 'approved', kind: 'wiki' },
  kb: { id: 'kb1', name: '演示知识库', scopeKey: 'ws:ws-1' },
  base: { title: '系统架构总览', body: '', version: 2, status: 'approved' },
  target: { title: '系统架构总览', body: '' },
  ...overrides,
})

/** 取行内高亮 span 的文本：add=绿色（45% success），del=红色（45% error）。 */
function highlightTexts(tone) {
  const token = tone === 'add' ? 'state-success-primary' : 'state-error-primary'
  return findNodes((node) => typeof node.type === 'string' && node.props && node.props.style
    && typeof node.props.style.background === 'string'
    && node.props.style.background.includes(token) && node.props.style.background.includes('45%'))
    .map((node) => nodeText(node))
}

await testCase('对比页行内高亮：只给真正变化的字/词着色，未变文字保持普通样式', async () => {
  const baseText = '配置项：端口 = 8080，超时 = 30 秒'
  const targetText = '配置项：端口 = 9090，超时 = 30 秒'
  const data = proposalShell({
    diff: {
      lines: [{ type: 'del', text: baseText }, { type: 'add', text: targetText }],
      truncated: false,
      stats: { added: 1, removed: 1, unchanged: 0 },
    },
  })
  await mount(smoke.DocumentDiffPage, diffProps(data))
  const added = highlightTexts('add')
  const removed = highlightTexts('del')
  check(added.length > 0, '新增行应有行内高亮片段')
  check(removed.length > 0, '删除行应有行内高亮片段')
  check(added.join('') === '9090', '高亮只覆盖变化的字词，实际：' + JSON.stringify(added))
  check(removed.join('') === '8080', '高亮只覆盖变化的字词，实际：' + JSON.stringify(removed))
  checkText('超时 = 30 秒', '未变文字仍应正常渲染')
})

await testCase('对比页上下文折叠：未变内容超 7 行自动收起，可逐段展开/收起', async () => {
  const lines = []
  for (let i = 1; i <= 10; i += 1) lines.push({ type: 'equal', text: '开头行 ' + i })
  lines.push({ type: 'del', text: '旧内容 A' }, { type: 'add', text: '新内容 A' })
  for (let i = 1; i <= 20; i += 1) lines.push({ type: 'equal', text: '中间行 ' + i })
  lines.push({ type: 'del', text: '旧内容 B' }, { type: 'add', text: '新内容 B' })
  for (let i = 1; i <= 3; i += 1) lines.push({ type: 'equal', text: '结尾行 ' + i })
  const data = proposalShell({ diff: { lines, truncated: false, stats: { added: 2, removed: 2, unchanged: 33 } } })
  await mount(smoke.DocumentDiffPage, diffProps(data))
  checkText('展开 4 行未变内容', '第一段未变内容折叠（10 - 3×2 = 4）')
  checkText('展开 14 行未变内容', '第二段未变内容折叠（20 - 3×2 = 14）')
  checkText('第 1 / 2 处改动', '改动处计数')
  check(!text().includes('开头行 5'), '折叠时中间的未变行不应渲染')
  await click('展开 4 行未变内容')
  checkText('开头行 5', '展开后中间的未变行应出现')
  checkText('收起 4 行未变内容', '展开后按钮变为收起')
})

await testCase('对比页改动跳转：上一处/下一处切换并更新计数', async () => {
  const lines = [{ type: 'equal', text: '第 1 行' }, { type: 'del', text: '旧 A' }, { type: 'add', text: '新 A' }, { type: 'equal', text: '第 2 行' }, { type: 'del', text: '旧 B' }, { type: 'add', text: '新 B' }]
  const data = proposalShell({ diff: { lines, truncated: false, stats: { added: 2, removed: 2, unchanged: 2 } } })
  await mount(smoke.DocumentDiffPage, diffProps(data))
  checkText('第 1 / 2 处改动', '初始位于第 1 处改动')
  await click('↓ 下一处改动')
  checkText('第 2 / 2 处改动', '点击下一处后计数更新')
  await click('↑ 上一处改动')
  checkText('第 1 / 2 处改动', '点击上一处后计数回退')
})

await testCase('对比页并排配对：改动块内按相似度对齐，而不是按位置硬配', async () => {
  // 旧侧两行、新侧一行：按位置配会把「同一段落 A 内容」配成 replace，按相似度应把完全一致的「第二段完全重写」配成 replace。
  const diff = {
    lines: [
      { type: 'del', text: '同一段落 A 内容' },
      { type: 'del', text: '第二段完全重写' },
      { type: 'add', text: '第二段完全重写' },
    ],
  }
  const split = smoke.diffSplitRows(diff)
  check(split.length === 2, '应有 2 行并排结果，实际 ' + split.length)
  check(split[0].type === 'del' && split[0].left !== null && split[0].right === null, '第一行应是纯删除：' + JSON.stringify(split[0] && split[0].type))
  check(split[1].type === 'replace', '第二行应是配对行：' + JSON.stringify(split[1] && split[1].type))
  check(split[1].left.text === '第二段完全重写' && split[1].right.text === '第二段完全重写', '配对应发生在两行完全一致的位置')
  const changed = (split[1].inline && split[1].inline.left ? split[1].inline.left : []).filter((part) => part.changed === true)
  check(changed.length === 0, '完全一致的行不应有行内高亮片段，实际：' + JSON.stringify(changed))
  const unified = smoke.diffUnifiedRows(diff)
  check(unified.length === 3, '统一视图应为 3 行（1 删除 + 1 删除 + 1 新增），实际 ' + unified.length)
  check(unified[1].oldNum === 2 && unified[1].newNum === null, '统一视图行号应按旧侧顺序单调')
  check(unified[2].newNum === 1 && unified[2].oldNum === null, '统一视图行号应按新侧顺序单调')
})

await testCase('对比页换行开关：默认自动换行，点击后切换为不换行', async () => {
  const data = proposalShell({ diff: { lines: [{ type: 'add', text: '一条很长的新增内容 '.repeat(6) }], truncated: false, stats: { added: 1, removed: 0, unchanged: 0 } } })
  await mount(smoke.DocumentDiffPage, diffProps(data))
  const wrapButton = byText('自动换行')
  check(wrapButton.props.style.background === 'var(--dsw-alias-interactive-bg-hover)', '默认应处于开启（高亮）状态')
  await click('自动换行')
  const afterButton = byText('自动换行')
  check(afterButton.props.style.background === 'transparent', '点击后应切换为关闭（透明）状态')
})

console.log('checks=' + checkCount())
const failed = failureCount()
console.log(failed === 0 ? 'INTERACTION PASS' : 'INTERACTION FAILURES: ' + failed)
process.exit(failed === 0 ? 0 : 1)
