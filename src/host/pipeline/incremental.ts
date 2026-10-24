/**
 * 增量更新流水线（M4）：Git 变更 / 内容哈希 → 受影响文档 → 只对必要范围调用绑定模型 → 审核队列。
 *
 * 硬约束（对应规范 §5.3 / §14.3）：
 * - 无变化绝不重复生成：内容哈希与上次索引一致时直接结束，不调用模型；
 * - 小范围变更只更新相关文档：受影响文档由 sources 反查得出，模型只看到这几个文件；
 * - 已批准的 Wiki 不被静默覆盖：只生成 update 候选（proposals）等待人工审核；
 * - 草稿仍在待审核区，可直接追加新版本（status 不变），并在版本里记录来源；
 * - 结构性文件（package.json / tsconfig / 构建配置 …）变化时，把 Wiki 文档标记为「需要重新检查」；
 * - 来源文件被删除时，保留原文档并生成 stale 候选 + 重新检查标记，交给人工判断。
 */
import { promises as fs } from 'node:fs'
import { resolve, sep } from 'node:path'
import { run, type Db } from '../db/db.js'
import { type KbRow } from '../kb/store.js'
import { getDocument, listDocuments, type DocRow } from '../search.js'
import { appendVersion, diffLines } from '../docvers.js'
import { autoApproveIfEligible, createProposal } from '../review.js'
import { runModelCall } from '../model.js'
import { readSettings } from '../settings.js'
import { listWorkspaces } from '../workspace.js'
import { indexProject, saveProjectIndex, type ProjectIndex } from './index.js'
import { gitChanges, readGitState } from './git.js'
import {
  diffProjectIndex, ensureDocSources, flagRecheck, listFileChanges, listRecheck, mapAffectedDocs,
  readGitStateRow, recordFileChanges, saveGitState, type FileChange, type GitStateRow,
} from './changes.js'
import { sanitizeModelText } from './initialize.js'
import { createTask, runTask, type TaskRow } from '../tasks.js'
import { newId } from '../utils/id.js'
import { errorMessage } from '../http.js'

export class IncrementalError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const LIMITS = {
  economy: { maxFiles: 12000, maxHashes: 1500, maxDocs: 2, maxTokens: 1200, maxSnippetFiles: 4, maxSnippetChars: 4000 },
  balanced: { maxFiles: 20000, maxHashes: 3000, maxDocs: 4, maxTokens: 1800, maxSnippetFiles: 6, maxSnippetChars: 6000 },
  quality: { maxFiles: 30000, maxHashes: 6000, maxDocs: 7, maxTokens: 2400, maxSnippetFiles: 8, maxSnippetChars: 8000 },
} as const

type Strategy = keyof typeof LIMITS

const UPDATE_SYSTEM = [
  '你是知枢 KnowHub 的 Repo Wiki 维护助手。',
  '任务：根据「代码变更」和「现有文档」，给出该文档更新后的完整正文。',
  '规则：',
  '1. 只依据提供的证据，不臆测；无法确认的内容放进 uncertain 数组，不要写进正文当事实。',
  '2. 不要编造文件、模块、命令或不存在的接口。',
  '3. 保留原有正确内容，只修改与本次变更相关的部分。',
  '4. 正文使用简体中文 Markdown，不超过 1600 字。',
  '5. 只输出一个 JSON 对象，不要输出其它文字。',
  '输出格式：{"document":{"title":"文档标题","body":"Markdown 正文","changeSummary":"一句话变更摘要","uncertain":["待确认项"]}}',
].join('\n')

function limitsFor(strategy: string): (typeof LIMITS)[Strategy] {
  return strategy === 'quality' ? LIMITS.quality : strategy === 'balanced' ? LIMITS.balanced : LIMITS.economy
}

function recordLlmCall(db: Db, kb: KbRow, taskId: string, purpose: string, result: { provider: string; model: string; usage: any; finishKind: string | null; failure: any; elapsedMs: number }): void {
  const usage = result.usage ?? {}
  const promptTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : typeof usage.promptTokens === 'number' ? usage.promptTokens : null
  const completionTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : typeof usage.completionTokens === 'number' ? usage.completionTokens : null
  run(
    db,
    'INSERT INTO llm_calls (id, kb_id, task_id, provider, model, prompt_tokens, completion_tokens, latency_ms, finish_kind, failure_code, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [newId('llm'), kb.id, taskId, result.provider, result.model, promptTokens, completionTokens, result.elapsedMs, result.finishKind, result.failure ? String(result.failure.code) : null, purpose, Date.now()],
  )
}

/** 从模型输出里取出第一个 JSON 对象（允许前后有解释文字）。 */
export function extractJsonObject(text: string): any {
  const trimmed = text.trim()
  try { return JSON.parse(trimmed) } catch { /* 继续尝试截取 */ }
  const start = trimmed.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, index + 1)) } catch { return null }
      }
    }
  }
  return null
}

export interface ParsedUpdate { title: string; body: string; changeSummary: string; uncertain: string[] }

/** 结构校验 + 清洗模型输出；不合法返回 null。 */
export function parseUpdatePayload(text: string, secrets: { root: string; storageRoot: string }): ParsedUpdate | null {
  const payload = extractJsonObject(text)
  const document = payload && typeof payload === 'object' ? (payload.document ?? payload) : null
  if (document === null || typeof document !== 'object') return null
  const rawBody = typeof document.body === 'string' ? document.body.trim() : ''
  if (rawBody.length < 40) return null
  if (/^\s*(抱歉|无法|sorry|I cannot)/i.test(rawBody)) return null
  const rawTitle = typeof document.title === 'string' ? document.title.trim() : ''
  const sanitizedBody = sanitizeModelText(rawBody, secrets)
  const sanitizedTitle = sanitizeModelText(rawTitle, secrets)
  const uncertain = Array.isArray(document.uncertain) ? document.uncertain.map((item: any) => String(item).trim()).filter((item: string) => item !== '').slice(0, 8) : []
  return {
    title: sanitizedTitle.text.slice(0, 120),
    body: sanitizedBody.text.slice(0, 20000),
    changeSummary: typeof document.changeSummary === 'string' ? sanitizeModelText(document.changeSummary, secrets).text.slice(0, 300) : '',
    uncertain,
  }
}

function normalizeBody(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).join('\n').replace(/\n{2,}/g, '\n').trim()
}

function toPosix(value: string): string {
  return value.split('\\').join('/')
}

function safeJoin(root: string, relativePath: string): string | null {
  const target = resolve(root, relativePath)
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

interface Analysis {
  workspaceId: string
  root: string
  mode: 'git' | 'hash'
  head: string | null
  branch: string | null
  dirtyCount: number
  baseline: boolean
  fileCount: number
  changes: FileChange[]
  gitCommitted: FileChange[]
  affected: ReturnType<typeof mapAffectedDocs>['affected']
  unmatchedPaths: string[]
  structural: string[]
  recheckDocs: Array<{ docId: string; title: string }>
  scan: ProjectIndex
  limits: (typeof LIMITS)[Strategy]
  fallbackReason: string | null
}

async function resolveWorkspaceRoot(ctx: any, kb: KbRow, workspaceId: string | null): Promise<{ workspaceId: string; root: string; title: string }> {
  const target = workspaceId ?? kb.workspaceId
  if (target === null || target === '') throw new IncrementalError('WORKSPACE_REQUIRED', '用户级知识库执行增量更新时必须指定工作区（workspaceId）')
  const listed = await listWorkspaces(ctx)
  for (const workspace of listed.workspaces) {
    if (workspace.id !== target) continue
    if (workspace.pathState === 'missing') throw new IncrementalError('WORKSPACE_PATH_MISSING', '工作区目录不可访问（可能已被移动或删除）：' + workspace.path)
    return { workspaceId: target, root: workspace.path, title: workspace.title }
  }
  throw new IncrementalError('WORKSPACE_NOT_FOUND', '未找到该工作区：' + target)
}

/** 分析阶段（只读）：检测变更 → 受影响文档 → 重新检查标记。 */
async function analyze(input: IncrementalInput): Promise<Analysis> {
  const { ctx, db, kb, workspaceId, log } = input
  const strategy = (kb.modelStrategy as Strategy) in LIMITS ? (kb.modelStrategy as Strategy) : 'balanced'
  const limits = limitsFor(strategy)
  const workspace = await resolveWorkspaceRoot(ctx, kb, workspaceId ?? null)
  const previous = readGitStateRow(db, kb.id)
  const rootChanged = previous !== null && previous.root !== workspace.root
  const state = await readGitState(workspace.root)
  const gitMode = state.available && state.isRepo
  const fallbackReason = gitMode ? null : (state.error ?? 'Git 不可用')

  const scan = await indexProject(workspace.root, { maxFiles: limits.maxFiles, maxHashes: limits.maxHashes, timeoutMs: 20000, excludeDirs: readSettings(db).excludeDirs })
  const unreachable = scan.fileCount === 0
  if (unreachable) throw new IncrementalError('PROJECT_PATH_INVALID', '项目目录内没有可索引的文件：' + workspace.root)

  const baseline = previous === null || rootChanged
  let changes: FileChange[] = []
  let gitCommitted: FileChange[] = []
  if (!baseline) {
    changes = diffProjectIndex(db, kb.id, scan.files)
    if (gitMode) {
      const delta = await gitChanges(workspace.root, previous !== null && previous.mode === 'git' ? previous.head : null)
      if (delta.ok) {
        gitCommitted = delta.changes
        const known = new Map(changes.map((change) => [change.path, change] as const))
        for (const commitChange of delta.changes) {
          if (known.has(commitChange.path)) continue
          const exists = scan.files.some((file) => toPosix(file.path) === commitChange.path)
          if (commitChange.change === 'deleted' && exists) continue
          if (commitChange.change !== 'deleted' && !exists) continue
          known.set(commitChange.path, commitChange)
          changes.push(commitChange)
        }
        changes = changes.sort((a, b) => a.path.localeCompare(b.path))
      } else {
        log('warn', 'Git 变更读取失败，本次仅使用内容哈希比对：' + (delta.error ?? '未知错误'))
      }
    }
  }

  const impact = mapAffectedDocs(db, kb.id, changes)
  const wikiDocs = listDocuments(db, { kbIds: [kb.id], kind: 'wiki', limit: 500 }).filter((doc) => doc.status !== 'archived')
  const structuralDocs = impact.structural.length > 0 ? wikiDocs.map((doc) => ({ docId: doc.id, title: doc.title })) : []
  const recheckDocs = [...structuralDocs]

  return {
    workspaceId: workspace.workspaceId,
    root: workspace.root,
    mode: gitMode ? 'git' : 'hash',
    head: state.head,
    branch: state.branch,
    dirtyCount: state.dirtyCount,
    baseline,
    fileCount: scan.fileCount,
    changes,
    gitCommitted,
    affected: impact.affected,
    unmatchedPaths: impact.unmatchedPaths,
    structural: impact.structural,
    recheckDocs,
    scan,
    limits,
    fallbackReason,
  }
}

export interface IncrementalInput {
  ctx: any
  db: Db
  storageRoot: string
  kb: KbRow
  taskId: string
  signal: AbortSignal
  progress: (percent: number, stage?: string) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  workspaceId?: string | null
}

/** 只读预览：返回本次增量会做什么，不调用模型、不写任何数据。 */
export async function planIncremental(input: { ctx: any; db: Db; storageRoot: string; kb: KbRow; workspaceId?: string | null }): Promise<any> {
  const noop = (): void => undefined
  const analysis = await analyze({ ...input, taskId: 'plan', signal: new AbortController().signal, progress: noop, log: noop })
  const planned = analysis.affected.map((doc) => ({
    docId: doc.docId,
    title: doc.title,
    status: doc.status,
    currentVersion: doc.currentVersion,
    matchedPaths: doc.matchedPaths,
    action: doc.matchedPaths.every((path) => analysis.changes.find((change) => change.path === path)?.change === 'deleted')
      ? 'stale-proposal'
      : doc.status === 'approved' ? 'update-proposal' : 'update-draft',
  }))
  return {
    dryRun: true,
    workspaceId: analysis.workspaceId,
    workspacePath: analysis.root,
    mode: analysis.mode,
    fallbackReason: analysis.fallbackReason,
    head: analysis.head,
    branch: analysis.branch,
    dirtyCount: analysis.dirtyCount,
    baseline: analysis.baseline,
    fileCount: analysis.fileCount,
    changeCount: analysis.changes.length,
    changes: analysis.changes.slice(0, 200),
    gitCommitted: analysis.gitCommitted.slice(0, 200),
    affectedCount: analysis.affected.length,
    planned,
    unmatchedPaths: analysis.unmatchedPaths,
    structural: analysis.structural,
    recheckDocs: analysis.recheckDocs,
    plannedModelCalls: Math.min(planned.filter((item) => item.action !== 'stale-proposal').length, analysis.limits.maxDocs),
    note: analysis.baseline
      ? '尚无基线检查点：本次只建立基线，不生成任何文档。'
      : analysis.changes.length === 0 ? '未检测到内容变化：不会调用模型，也不会重写任何文档。' : '',
  }
}

async function collectSnippets(root: string, paths: string[], limits: (typeof LIMITS)[Strategy]): Promise<Array<{ path: string; text: string }>> {
  const snippets: Array<{ path: string; text: string }> = []
  let budget = limits.maxSnippetChars
  for (const path of paths.slice(0, limits.maxSnippetFiles)) {
    if (budget <= 0) break
    const target = safeJoin(root, path)
    if (target === null) continue
    try {
      const stat = await fs.stat(target)
      if (!stat.isFile() || stat.size > 512 * 1024) continue
      const raw = await fs.readFile(target, 'utf8')
      const text = raw.length > 1400 ? raw.slice(0, 1400) + '\n…（截断）' : raw
      snippets.push({ path, text })
      budget -= text.length
    } catch { /* 文件已删除或不可读：跳过 */ }
  }
  return snippets
}

function buildUpdatePrompt(input: {
  doc: DocRow
  changes: FileChange[]
  snippets: Array<{ path: string; text: string }>
  scan: ProjectIndex
  mode: string
}): string {
  const lines: string[] = []
  lines.push('## 项目概况')
  lines.push('项目根目录已省略；语言：' + (input.scan.stack.languages.join('、') || '未知') + '；框架：' + (input.scan.stack.frameworks.join('、') || '未知'))
  lines.push('文件总数：' + input.scan.fileCount + '；顶层结构：' + input.scan.tree.slice(0, 12).join('  '))
  lines.push('')
  lines.push('## 本次变更（' + input.mode + ' 检测）')
  for (const change of input.changes.slice(0, 20)) lines.push('- [' + change.change + '] ' + change.path)
  lines.push('')
  lines.push('## 变更内容片段')
  for (const snippet of input.snippets) {
    lines.push('### ' + snippet.path)
    lines.push('\u0060\u0060\u0060')
    lines.push(snippet.text)
    lines.push('\u0060\u0060\u0060')
  }
  lines.push('')
  lines.push('## 现有文档（第 ' + input.doc.currentVersion + ' 版，状态 ' + input.doc.status + '）')
  lines.push('标题：' + input.doc.title)
  lines.push('正文：')
  lines.push(input.doc.body.slice(0, 6000))
  lines.push('')
  lines.push('## 要求')
  lines.push('只输出 JSON：{"document":{"title":"…","body":"…","changeSummary":"…","uncertain":["…"]}}。')
  return lines.join('\n')
}

/** 执行增量更新（真实调用模型、可能写候选/版本）。 */
export async function runIncremental(input: IncrementalInput): Promise<any> {
  const { db, kb, taskId, log, progress, signal, storageRoot } = input
  const started = Date.now()
  progress(5, '解析工作区')
  const analysis = await analyze(input)
  progress(20, '扫描与索引')
  const secrets = { root: analysis.root, storageRoot }

  const summary: any = {
    taskId,
    workspaceId: analysis.workspaceId,
    mode: analysis.mode,
    fallbackReason: analysis.fallbackReason,
    baseline: analysis.baseline,
    head: analysis.head,
    branch: analysis.branch,
    fileCount: analysis.fileCount,
    changeCount: analysis.changes.length,
    affectedDocs: analysis.affected.length,
    unmatchedPaths: analysis.unmatchedPaths.length,
    structuralChanges: analysis.structural.length,
    recheckFlagged: 0,
    modelCalls: 0,
    updatedDrafts: 0,
    proposals: 0,
    staleProposals: 0,
    skippedNoChange: 0,
    failures: [] as string[],
  }

  // 第一件事：把本次索引写入（保证下次哈希比对准确；也兜住“基线”场景）。
  saveProjectIndex(db, kb.id, analysis.scan.files)

  if (analysis.baseline) {
    saveGitState(db, {
      kbId: kb.id, workspaceId: analysis.workspaceId, root: analysis.root, mode: analysis.mode,
      head: analysis.head, branch: analysis.branch, fileCount: analysis.fileCount, dirtyCount: analysis.dirtyCount,
      lastScanAt: Date.now(), lastTaskId: taskId, lastSummary: { baseline: true, fileCount: analysis.fileCount }, updatedAt: Date.now(),
    })
    log('info', '已建立' + (analysis.mode === 'git' ? ' Git' : '文件哈希') + '基线检查点（' + analysis.fileCount + ' 个文件）；本次不生成文档')
    summary.note = '已建立基线检查点，未调用模型'
    progress(100, '已完成')
    return summary
  }

  recordFileChanges(db, kb.id, taskId, analysis.mode, analysis.changes)
  log('info', '检测到 ' + analysis.changes.length + ' 个文件变化（模式：' + (analysis.mode === 'git' ? 'Git' : '内容哈希') + '，新增 ' + analysis.changes.filter((change) => change.change === 'added').length + ' / 修改 ' + analysis.changes.filter((change) => change.change === 'modified').length + ' / 删除 ' + analysis.changes.filter((change) => change.change === 'deleted').length + '）')
  if (analysis.structural.length > 0) log('warn', '检测到结构性文件变更（' + analysis.structural.slice(0, 6).join('、') + '）：相关 Wiki 将标记为需要重新检查')

  if (analysis.recheckDocs.length > 0) {
    summary.recheckFlagged = flagRecheck(db, kb.id, analysis.recheckDocs.map((doc) => doc.docId), '结构性文件变更：' + analysis.structural.slice(0, 8).join('、'), taskId)
    log('info', '已标记 ' + summary.recheckFlagged + ' 篇 Wiki 需要人工重新检查（不会自动重写）')
  }

  if (analysis.changes.length === 0) {
    summary.skippedNoChange = 1
    summary.note = '未检测到内容变化，未调用模型'
    log('info', '未检测到内容变化：跳过模型调用与文档更新')
    saveGitState(db, {
      kbId: kb.id, workspaceId: analysis.workspaceId, root: analysis.root, mode: analysis.mode,
      head: analysis.head, branch: analysis.branch, fileCount: analysis.fileCount, dirtyCount: analysis.dirtyCount,
      lastScanAt: Date.now(), lastTaskId: taskId, lastSummary: summary, updatedAt: Date.now(),
    })
    progress(100, '已完成')
    return summary
  }

  if (analysis.affected.length === 0) {
    summary.note = '变更文件未被任何文档引用，未调用模型'
    log('warn', '变更文件未关联到任何文档（未纳入 Wiki 来源）：' + analysis.unmatchedPaths.slice(0, 10).join('、') + '；已保留现有文档，未调用模型')
    saveGitState(db, {
      kbId: kb.id, workspaceId: analysis.workspaceId, root: analysis.root, mode: analysis.mode,
      head: analysis.head, branch: analysis.branch, fileCount: analysis.fileCount, dirtyCount: analysis.dirtyCount,
      lastScanAt: Date.now(), lastTaskId: taskId, lastSummary: summary, updatedAt: Date.now(),
    })
    progress(100, '已完成')
    return summary
  }

  progress(30, '分析受影响文档')
  const targets = analysis.affected.slice(0, analysis.limits.maxDocs)
  if (analysis.affected.length > targets.length) log('warn', '受影响文档 ' + analysis.affected.length + ' 篇，本次按「' + kb.modelStrategy + '」策略只处理前 ' + targets.length + ' 篇，其余保留并等待下一轮')

  for (let index = 0; index < targets.length; index += 1) {
    if (signal.aborted) throw new IncrementalError('TASK_CANCELLED', '任务已取消')
    const affected = targets[index]!
    const doc = getDocument(db, affected.docId)
    if (!doc) continue
    const deltaChanges = analysis.changes.filter((change) => affected.matchedPaths.includes(change.path))
    const allDeleted = deltaChanges.length > 0 && deltaChanges.every((change) => change.change === 'deleted')
    progress(30 + Math.round((index / targets.length) * 55), '处理文档：' + doc.title)

    if (allDeleted) {
      createProposal(db, kb, {
        kind: 'stale',
        docId: doc.id,
        title: doc.title,
        body: doc.body,
        docKind: doc.kind,
        tags: doc.tags,
        verifyState: 'inferred',
        sources: affected.matchedPaths.map((path) => ({ kind: 'file', ref: path, locator: null })),
        source: 'pipeline:incremental',
        reason: '来源文件已删除：' + affected.matchedPaths.join('、'),
        createdBy: 'pipeline:incremental',
      })
      summary.staleProposals += 1
      flagRecheck(db, kb.id, [doc.id], '来源文件已删除：' + affected.matchedPaths.slice(0, 6).join('、'), taskId)
      log('warn', '文档「' + doc.title + '」的来源文件已删除，已生成「标记过时」候选，正文保留未改动')
      continue
    }

    const snippets = await collectSnippets(analysis.root, deltaChanges.filter((change) => change.change !== 'deleted').map((change) => change.path), analysis.limits)
    const prompt = buildUpdatePrompt({ doc, changes: deltaChanges, snippets, scan: analysis.scan, mode: analysis.mode })
    let result
    try {
      result = await runModelCall(input.ctx, {
        provider: kb.modelProvider ?? '',
        model: kb.modelId ?? '',
        system: UPDATE_SYSTEM,
        prompt,
        maxTokens: analysis.limits.maxTokens,
        temperature: 0.2,
        timeoutMs: 120000,
        signal,
      })
    } catch (error) {
      summary.failures.push(doc.title + ' → ' + errorMessage(error))
      log('error', '文档「' + doc.title + '」模型调用异常：' + errorMessage(error) + '，已保留原文档')
      continue
    }
    recordLlmCall(db, kb, taskId, 'wiki-update:' + doc.slug, result)
    summary.modelCalls += 1
    if (!result.ok) {
      const failure = result.failure ? String(result.failure.code) + '：' + String(result.failure.message) : '模型未返回内容'
      summary.failures.push(doc.title + ' → ' + failure)
      log('error', '文档「' + doc.title + '」增量分析失败（' + failure + '），已保留原文档')
      continue
    }
    const parsed = parseUpdatePayload(result.text, secrets)
    if (parsed === null) {
      summary.failures.push(doc.title + ' → 模型输出结构不合法')
      log('warn', '文档「' + doc.title + '」的模型输出未通过结构校验，已保留原文档')
      continue
    }
    const diff = diffLines(normalizeBody(doc.body), normalizeBody(parsed.body))
    const changedLines = diff.lines.filter((line) => line.type !== 'equal').length
    if (normalizeBody(doc.body) === normalizeBody(parsed.body) || changedLines <= 2) {
      summary.skippedNoChange += 1
      log('info', '文档「' + doc.title + '」内容无实质变化（差异行 ' + changedLines + '），跳过')
      continue
    }
    const reason = '增量更新：' + deltaChanges.slice(0, 6).map((change) => change.change + ' ' + change.path).join('、')
    if (doc.status === 'approved') {
      const proposal = createProposal(db, kb, {
        kind: 'update',
        docId: doc.id,
        title: parsed.title === '' ? doc.title : parsed.title,
        body: parsed.body,
        docKind: doc.kind,
        tags: doc.tags,
        verifyState: 'inferred',
        confidence: 0.6,
        sources: deltaChanges.map((change) => ({ kind: 'file', ref: change.path, locator: null })),
        source: 'pipeline:incremental',
        reason,
        createdBy: 'pipeline:incremental',
      })
      const autoSettings = readSettings(db)
      const auto = await autoApproveIfEligible(db, storageRoot, proposal, { enabled: autoSettings.autoApprove, maxDiffLines: autoSettings.autoApproveMaxDiffLines, actor: 'auto:rule' })
      summary.proposals += 1
      if (auto.autoApproved) {
        log('info', '文档「' + doc.title + '」的更新候选 ' + auto.proposal.id + ' 已按自动批准规则通过（' + (auto.reason ?? '低风险更新') + '），并写入审核日志')
      } else {
        log('info', '文档「' + doc.title + '」已批准，生成更新候选 ' + auto.proposal.id + '，等待人工审核（' + (auto.reason ?? '不会自动覆盖') + '）')
      }
    } else {
      const updated = await appendVersion(db, storageRoot, doc, {
        title: parsed.title === '' ? doc.title : parsed.title,
        body: parsed.body,
        changeKind: 'update',
        source: 'pipeline:incremental',
        actor: 'pipeline',
        reason,
      })
      ensureDocSources(db, updated.id, 'file', deltaChanges.map((change) => change.path))
      summary.updatedDrafts += 1
      log('info', '文档「' + doc.title + '」仍为草稿，已直接更新到第 ' + updated.currentVersion + ' 版（待审核区）')
    }
  }

  summary.elapsedMs = Date.now() - started
  progress(92, '记录增量检查点')
  saveGitState(db, {
    kbId: kb.id, workspaceId: analysis.workspaceId, root: analysis.root, mode: analysis.mode,
    head: analysis.head, branch: analysis.branch, fileCount: analysis.fileCount, dirtyCount: analysis.dirtyCount,
    lastScanAt: Date.now(), lastTaskId: taskId, lastSummary: summary, updatedAt: Date.now(),
  })
  const rechecked = listRecheck(db, kb.id, 5)
  summary.recheckOpen = rechecked.length
  progress(100, '已完成')
  if (summary.failures.length > 0 && summary.modelCalls > 0 && summary.proposals + summary.updatedDrafts + summary.staleProposals === 0) {
    throw new IncrementalError('MODEL_OUTPUT_INVALID', '本次增量更新没有产生任何可用文档：' + summary.failures.join('；'))
  }
  return summary
}

/** 启动增量更新任务（同一知识库同时只允许一个）。 */
export function startIncrementalTask(input: { ctx: any; db: Db; storageRoot: string; kb: KbRow; workspaceId?: string | null }): { task: TaskRow; duplicate: boolean } {
  const created = createTask(input.db, { kbId: input.kb.id, kind: 'incremental', idemKey: 'incremental:' + input.kb.id, input: { workspaceId: input.workspaceId ?? input.kb.workspaceId ?? null } })
  const task = created.task
  if (created.duplicate) return { task, duplicate: true }
  void runTask({
    db: input.db,
    taskId: task.id,
    executor: (context) => runIncremental({
      ctx: input.ctx,
      db: input.db,
      storageRoot: input.storageRoot,
      kb: input.kb,
      taskId: task.id,
      signal: context.signal,
      progress: context.progress,
      log: context.log,
      workspaceId: input.workspaceId ?? input.kb.workspaceId ?? null,
    }),
  }).catch((error) => {
    console.error('[knowhub] 增量更新任务异常：' + errorMessage(error))
  })
  return { task, duplicate: false }
}

/** 执行已创建好的增量任务（重试路径复用）。 */
export function executeIncremental(input: { ctx: any; db: Db; storageRoot: string; kb: KbRow; task: TaskRow; workspaceId?: string | null }): void {
  void runTask({
    db: input.db,
    taskId: input.task.id,
    executor: (context) => runIncremental({
      ctx: input.ctx,
      db: input.db,
      storageRoot: input.storageRoot,
      kb: input.kb,
      taskId: input.task.id,
      signal: context.signal,
      progress: context.progress,
      log: context.log,
      workspaceId: input.workspaceId ?? input.kb.workspaceId ?? null,
    }),
  }).catch((error) => {
    console.error('[knowhub] 增量更新任务异常：' + errorMessage(error))
  })
}

/** 桌面端/诊断用：读取当前仓库状态与最近的变更记录。 */
export async function incrementalStatus(ctx: any, db: Db, kb: KbRow): Promise<any> {
  const target = kb.workspaceId
  let workspacePath: string | null = null
  if (target !== null && target !== '') {
    const listed = await listWorkspaces(ctx)
    const found = listed.workspaces.find((workspace) => workspace.id === target)
    workspacePath = found ? found.path : null
  }
  const state = readGitStateRow(db, kb.id)
  const live = workspacePath === null ? null : await readGitState(workspacePath)
  const changes = listFileChanges(db, kb.id, 100)
  const recheck = listRecheck(db, kb.id, 100)
  return {
    knowledgeBaseId: kb.id,
    workspaceId: target,
    workspacePath,
    mode: state?.mode ?? (live?.isRepo ? 'git' : 'hash'),
    git: live,
    checkpoint: state === null ? null : {
      mode: state.mode,
      head: state.head,
      branch: state.branch,
      fileCount: state.fileCount,
      dirtyCount: state.dirtyCount,
      lastScanAt: state.lastScanAt,
      lastTaskId: state.lastTaskId,
      lastSummary: state.lastSummary,
    },
    recentChanges: changes,
    recheck,
    counts: { changes: changes.length, recheck: recheck.length },
  }
}
