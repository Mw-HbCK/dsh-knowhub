/**
 * 初始化流水线（M2）：真实扫描 → 文件索引 → 用知识库绑定模型生成 Wiki 候选 → 存为待审核草稿。
 *
 * 硬约束（对应规范 §4 / §14.2 / §14.3）：
 * - 模型只用 knowledge_base.model_provider + model_id，绝不回退到全局默认；目录里找不到即报错；
 * - 每次模型调用的 provider/model/token/耗时都写入 llm_calls，作为“实际用了哪个模型”的铁证；
 * - 模型输出先做 JSON 结构校验 + 内容清洗，失败则不写任何知识；
 * - 生成结果一律 status='draft'、verify_state 标注 observed/inferred/unverified，等待人工审核（M3）后才成为正式知识；
 * - 已存在的同 slug 已批准文档绝不覆盖，只记为冲突；
 * - 失败或取消时保留已有正式知识，只把知识库状态置为 error/created 并记录原因。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { get, run, type Db } from '../db/db.js'
import { atomicWrite, kbDir } from '../kb/files.js'
import { contentHash, type KbRow } from '../kb/store.js'
import { createDocument, getDocument, slugify } from '../search.js'
import { recordConflict } from '../review.js'
import { readModelCatalog, runModelCall } from '../model.js'
import { listWorkspaces } from '../workspace.js'
import { indexProject, saveProjectIndex, type ProjectIndex } from './index.js'
import { createTask, runTask, type TaskRow } from '../tasks.js'
import { newId } from '../utils/id.js'
import { errorMessage } from '../http.js'
import { readSettings } from '../settings.js'

export class InitError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const DOC_KINDS = new Set(['wiki', 'decision', 'issue', 'todo', 'memory', 'convention', 'preference'])

const STRATEGY_LIMITS = {
  economy: { maxFiles: 12000, maxHashes: 1500, maxContextChars: 12000, maxTokens: 1600, wikiPages: 2 },
  balanced: { maxFiles: 20000, maxHashes: 3000, maxContextChars: 20000, maxTokens: 2200, wikiPages: 4 },
  quality: { maxFiles: 30000, maxHashes: 6000, maxContextChars: 30000, maxTokens: 3200, wikiPages: 7 },
} as const

type Strategy = keyof typeof STRATEGY_LIMITS

interface PlannedCall {
  purpose: string
  topics: string[]
}

function planCalls(strategy: Strategy): PlannedCall[] {
  const base: PlannedCall[] = [{ purpose: 'wiki-overview', topics: ['项目总览', '技术栈与依赖'] }]
  if (strategy === 'economy') return base
  const second: PlannedCall = { purpose: 'wiki-architecture', topics: ['系统架构', '核心模块'] }
  if (strategy === 'balanced') return [...base, second]
  return [...base, second, { purpose: 'wiki-interfaces', topics: ['关键接口与数据流', '技术选型与决策记录', '已知问题与待确认事项'] }]
}

function updateKbStatus(db: Db, kbId: string, status: string, detail: any): void {
  run(db, 'UPDATE knowledge_bases SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?', [status, JSON.stringify(detail).slice(0, 4000), Date.now(), kbId])
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

/** 绝对路径与疑似密钥清洗：知识正文里不得出现本机绝对路径或凭据。 */
export function sanitizeModelText(text: string, secrets: { root: string; storageRoot: string }): { text: string; removed: number } {
  let removed = 0
  let output = text
  const replacements: Array<[RegExp, string]> = [
    [new RegExp(escapeRegex(secrets.root), 'gi'), '<项目根>'],
    [new RegExp(escapeRegex(secrets.storageRoot), 'gi'), '<知识库存储>'],
    [/[A-Za-z]:\\[^\s"'\`<>|]+/g, '<本机绝对路径>'],
    [/(?:sk|pk|ghp|gho|ghs|xox[baprs])-[A-Za-z0-9_-]{12,}/g, '[已移除疑似密钥]'],
    [/((?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*)["']?[A-Za-z0-9_\-./+]{8,}["']?/gi, '$1[已移除疑似凭据]'],
  ]
  for (const [pattern, replacement] of replacements) {
    output = output.replace(pattern, () => { removed += 1; return replacement })
  }
  return { text: output, removed }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildContext(index: ProjectIndex, strategy: Strategy): string {
  const limits = STRATEGY_LIMITS[strategy]
  const parts: string[] = []
  parts.push('项目根：<项目根>')
  parts.push('文件总数：' + index.fileCount + '（文本文件 ' + index.textFileCount + '，已计算内容哈希的文件数见索引）')
  parts.push('语言分布：' + index.byLanguage.slice(0, 8).map((item) => item.language + '(' + item.count + ')').join('、'))
  parts.push('目录摘要（部分）：')
  parts.push(index.tree.slice(0, 60).join('\n'))
  parts.push('识别到的框架/工具：' + (index.stack.frameworks.join('、') || '（未从依赖中识别）'))
  parts.push('包管理器：' + (index.stack.packageManagers.join('、') || '（未识别）'))
  parts.push('配置文件：' + (index.stack.configFiles.join('、') || '（无）'))
  if (index.stack.scripts.length > 0) parts.push('可用的 package.json 脚本：' + index.stack.scripts.join('、') + '（仅作事实描述，禁止执行）')
  if (index.stack.entryHints.length > 0) parts.push('入口候选：' + index.stack.entryHints.join('、'))
  const fileLimit = strategy === 'economy' ? 160 : strategy === 'balanced' ? 260 : 380
  parts.push('文件清单（部分，相对路径）：')
  parts.push(index.files.slice(0, fileLimit).map((file) => file.path).join('\n'))
  if (index.files.length > fileLimit) parts.push('…（其余 ' + (index.files.length - fileLimit) + ' 个文件未列出）')
  if (index.configSnippets.length > 0) {
    parts.push('关键配置摘要：')
    for (const snippet of index.configSnippets) {
      parts.push('--- ' + snippet.path + ' ---')
      parts.push(snippet.text.slice(0, 3500))
    }
  }
  const text = parts.join('\n')
  return text.length > limits.maxContextChars ? text.slice(0, limits.maxContextChars) + '\n…（上下文已按策略截断）' : text
}

function buildPrompt(topics: string[], context: string): string {
  return [
    '你是知枢 KnowHub 的项目文档分析器。请只依据下面提供的仓库事实，生成 Repo Wiki 候选文档。',
    '严格要求：',
    '1. 只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码围栏之外的文字。',
    '2. 不得编造未在上下文中出现的模块职责、接口、依赖或决策；无法确认的内容写入 uncertain 数组。',
    '3. 文档正文使用简体中文 Markdown；涉及文件时使用相对路径（如 src/host/tasks.ts）。',
    '4. 每条文档必须给出 sources，值为上方文件清单中真实存在的相对路径；没有可引用文件时 sources 为空数组。',
    '5. 不得输出密钥、凭据、绝对路径或完整环境变量值。',
    '',
    '需要生成的文档主题：' + topics.join('、'),
    '输出 JSON 结构：',
    '{"documents":[{"title":"文档标题","kind":"wiki","tags":["标签"],"confidence":0.6,"sources":["相对路径"],"body":"Markdown 正文","uncertain":["待确认事项"]}]}',
    'kind 只能是 wiki / decision / issue / todo 之一：架构、模块、总览、技术栈用 wiki；技术选型理由用 decision；已知问题用 issue；待确认事项用 todo。',
    '',
    '仓库事实：',
    context,
  ].join('\n')
}

function extractJson(text: string): any {
  let cleaned = text.trim()
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) cleaned = fence[1].trim()
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first < 0 || last <= first) throw new InitError('MODEL_OUTPUT_INVALID', '模型输出中没有 JSON 对象')
  try {
    return JSON.parse(cleaned.slice(first, last + 1))
  } catch (error) {
    throw new InitError('MODEL_OUTPUT_INVALID', '模型输出的 JSON 解析失败：' + errorMessage(error))
  }
}

interface CandidateDoc {
  title: string
  kind: string
  tags: string[]
  confidence: number
  sources: string[]
  body: string
  uncertain: string[]
  verifyState: string
}

function validateDocuments(raw: any, knownPaths: Set<string>, secrets: { root: string; storageRoot: string }): { documents: CandidateDoc[]; rejected: string[] } {
  const documents: CandidateDoc[] = []
  const rejected: string[] = []
  const list = Array.isArray(raw?.documents) ? raw.documents : []
  if (list.length === 0) throw new InitError('MODEL_OUTPUT_INVALID', '模型输出缺少 documents 数组或数组为空')
  for (const item of list) {
    const title = typeof item?.title === 'string' ? item.title.trim() : ''
    let body = typeof item?.body === 'string' ? item.body.trim() : ''
    if (title === '' || title.length > 120) { rejected.push('标题为空或超过 120 字符：' + String(item?.title ?? '').slice(0, 60)); continue }
    if (body.length < 40) { rejected.push('正文过短，已丢弃：' + title); continue }
    const sanitized = sanitizeModelText(body.slice(0, 20000), secrets)
    body = sanitized.text
    const kindRaw = typeof item?.kind === 'string' ? item.kind.trim() : 'wiki'
    const kind = DOC_KINDS.has(kindRaw) ? kindRaw : 'wiki'
    const tags = Array.isArray(item?.tags) ? item.tags.map((tag: any) => String(tag).trim()).filter((tag: string) => tag !== '').slice(0, 10) : []
    const rawSources = Array.isArray(item?.sources) ? item.sources.map((source: any) => String(source).replace(/^\.\//, '').trim()) : []
    const sources = rawSources.filter((source: string) => knownPaths.has(source))
    const unknownSources = rawSources.filter((source: string) => !knownPaths.has(source))
    const rawConfidence = typeof item?.confidence === 'number' && Number.isFinite(item.confidence) ? item.confidence : 0.5
    let confidence = Math.max(0, Math.min(1, rawConfidence))
    let verifyState = 'inferred'
    if (sources.length === 0) { verifyState = 'unverified'; confidence = Math.min(confidence, 0.3) }
    const uncertain = Array.isArray(item?.uncertain) ? item.uncertain.map((value: any) => String(value).trim()).filter((value: string) => value !== '').slice(0, 20) : []
    if (unknownSources.length > 0) uncertain.push('模型引用了索引中不存在的文件，已剔除：' + unknownSources.slice(0, 5).join('、'))
    if (sanitized.removed > 0) uncertain.push('正文中已移除 ' + sanitized.removed + ' 处绝对路径或疑似密钥')
    documents.push({ title, kind, tags, confidence, sources, body, uncertain, verifyState })
  }
  return { documents, rejected }
}

export interface InitializeDeps {
  ctx: any
  db: Db
  storageRoot: string
  kb: KbRow
  taskId: string
  signal: AbortSignal
  progress: (percent: number, stage?: string) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new InitError('TASK_CANCELLED', '任务已取消')
}

export async function runInitialize(deps: InitializeDeps): Promise<any> {
  const { ctx, db, storageRoot, kb, taskId, signal, progress, log } = deps
  const strategy = (STRATEGY_LIMITS[kb.modelStrategy as Strategy] ? kb.modelStrategy : 'balanced') as Strategy
  const limits = STRATEGY_LIMITS[strategy]
  const startedAt = Date.now()
  let currentStage = '初始化'

  try {
    // 1) 校验工作区与目录
    currentStage = '校验工作区'
    progress(3, currentStage)
    const workspaceId = kb.workspaceId
    if (!workspaceId) throw new InitError('WORKSPACE_REQUIRED', '该知识库是用户级知识库，初始化时必须指定要分析的工作区')
    const listed = await listWorkspaces(ctx)
    if (!listed.available) throw new InitError('WORKSPACE_SERVICE_UNAVAILABLE', '无法读取工作区列表：' + (listed.error ?? ''))
    const workspace = listed.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new InitError('WORKSPACE_NOT_FOUND', '知识库绑定的工作区不存在（可能已被删除）：' + workspaceId)
    if (workspace.pathState === 'missing') throw new InitError('WORKSPACE_PATH_MISSING', '工作区目录不可访问（可能已被移动或删除）：' + workspace.path)
    const root = await fs.realpath(workspace.path)
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) throw new InitError('PROJECT_PATH_INVALID', '工作区路径不是目录：' + root)
    log('info', '目标工作区：' + workspace.title + '（' + workspaceId + '），项目根：' + root)
    ensureNotAborted(signal)

    // 2) 扫描 + 索引
    currentStage = '扫描项目文件'
    progress(8, currentStage)
    log('info', '开始扫描项目文件（策略 ' + strategy + '：最多 ' + limits.maxFiles + ' 个文件，最多 ' + limits.maxHashes + ' 个内容哈希）')
    const index = await indexProject(root, { maxFiles: limits.maxFiles, maxHashes: limits.maxHashes, timeoutMs: 60000, excludeDirs: readSettings(db).excludeDirs })
    ensureNotAborted(signal)
    progress(28, '写入文件索引')
    const saved = saveProjectIndex(db, kb.id, index.files)
    log('info', '索引完成：' + index.fileCount + ' 个文件（新增 ' + saved.inserted + '，更新 ' + saved.updated + '，移除 ' + saved.removed + '），跳过敏感文件 ' + index.skippedSensitive + ' 个、符号链接 ' + index.skippedSymlinks + ' 个、用户排除 ' + index.skippedExcluded + ' 个')
    if (index.truncated) log('warn', '索引达到上限或超时，结果已截断（后续可通过 M4 增量更新补全）')

    // 3) 校验知识库绑定模型仍可用（不允许静默换模型）
    currentStage = '校验知识库绑定模型'
    progress(36, currentStage)
    const catalog = await readModelCatalog(ctx)
    if (!catalog.available) throw new InitError('MODEL_CATALOG_UNAVAILABLE', '无法读取 DSH 模型配置：' + (catalog.error ?? ''))
    const modelAvailable = catalog.models.some((entry) => entry.provider === kb.modelProvider && entry.id === kb.modelId)
    if (!modelAvailable) throw new InitError('MODEL_NOT_AVAILABLE', '知识库绑定的模型已不可用（提供方 ' + kb.modelProvider + ' / 模型 ' + kb.modelId + '）。请在知识库设置中重新选择模型；插件不会自动改用其它模型。')
    log('info', '使用知识库绑定模型：' + kb.modelProvider + ' / ' + kb.modelId)

    // 4) 按策略调用模型生成候选
    const calls = planCalls(strategy)
    const context = buildContext(index, strategy)
    const knownPaths = new Set(index.files.map((file) => file.path))
    const created: Array<{ id: string; title: string }> = []
    const conflicts: Array<{ title: string; reason: string }> = []
    const rejected: string[] = []
    let documentsSeen = 0
    const callSummaries: any[] = []

    const secrets = { root, storageRoot }
    for (let position = 0; position < calls.length; position += 1) {
      const planned = calls[position]
      if (!planned) continue
      ensureNotAborted(signal)
      const percent = 40 + Math.round((position / calls.length) * 45)
      progress(percent, '调用模型生成：' + planned.topics.join('、'))
      const prompt = buildPrompt(planned.topics, context)
      log('info', '调用模型（' + planned.purpose + '，主题：' + planned.topics.join('、') + '，提示长度 ' + prompt.length + ' 字符）')
      const result = await runModelCall(ctx, {
        provider: kb.modelProvider,
        model: kb.modelId,
        system: '你是严谨的代码仓库文档分析器，只依据给定事实输出严格 JSON。',
        prompt,
        maxTokens: limits.maxTokens,
        temperature: 0.2,
        timeoutMs: 150000,
        signal,
      })
      recordLlmCall(db, kb, taskId, planned.purpose, result)
      callSummaries.push({ purpose: planned.purpose, provider: result.provider, model: result.model, ok: result.ok, finishKind: result.finishKind, failure: result.failure, elapsedMs: result.elapsedMs, usage: result.usage })
      if (result.aborted || signal.aborted) throw new InitError('TASK_CANCELLED', '任务已取消（模型调用被中断）')
      if (!result.ok) {
        const failureCode = result.failure?.code ?? 'MODEL_CALL_FAILED'
        throw new InitError('MODEL_CALL_FAILED', '模型调用失败（' + kb.modelProvider + ' / ' + kb.modelId + '，' + failureCode + '）：' + (result.failure?.message ?? '未知错误'))
      }
      log('info', '模型返回 ' + result.text.length + ' 字符（finish=' + String(result.finishKind) + '，耗时 ' + result.elapsedMs + 'ms）')
      const parsed = extractJson(result.text)
      const validated = validateDocuments(parsed, knownPaths, secrets)
      rejected.push(...validated.rejected)
      documentsSeen += validated.documents.length
      if (validated.rejected.length > 0) log('warn', '丢弃 ' + validated.rejected.length + ' 条不合格文档候选')

      for (const candidate of validated.documents) {
        const existing = get(db, 'SELECT id, status, title FROM documents WHERE kb_id = ? AND slug = ? AND deleted_at IS NULL', [kb.id, slugify(candidate.title)])
        if (existing) {
          conflicts.push({ title: candidate.title, reason: existing.status === 'approved' ? '已存在同主题的已批准文档，本次候选未覆盖' : '已存在同主题草稿，未创建重复文档（等待审核或增量更新）' })
          log('warn', '跳过候选「' + candidate.title + '」：' + (existing.status === 'approved' ? '已批准文档不可被静默覆盖' : '已存在同主题草稿'))
          // 记入冲突审核项：让差异内容进入人工审核队列，而不是丢弃或覆盖。
          try {
            const existingDoc = getDocument(db, String(existing.id))
            if (existingDoc) {
              const conflict = recordConflict(db, { kbId: kb.id, doc: existingDoc, proposedBody: candidate.body, proposedTitle: candidate.title, source: 'initialize:' + taskId })
              log('info', '已生成冲突审核项 ' + conflict.id + '（待人工选择保留或采用）')
            }
          } catch (conflictError) {
            log('warn', '记录冲突审核项失败：' + errorMessage(conflictError))
          }
          continue
        }
        const bodyParts = [candidate.body]
        if (candidate.uncertain.length > 0) {
          bodyParts.push('', '## 待确认事项', ...candidate.uncertain.map((item) => '- ' + item))
        }
        const body = bodyParts.join('\n') + '\n\n> 本文由模型基于仓库索引生成（' + kb.modelProvider + ' / ' + kb.modelId + '），当前为待审核草稿。\n'
        const doc = await createDocument(db, storageRoot, kb, {
          title: candidate.title,
          kind: candidate.kind,
          body,
          tags: candidate.tags,
          status: 'draft',
          verifyState: candidate.verifyState,
          confidence: candidate.confidence,
        })
        for (const source of candidate.sources) {
          run(
            db,
            'INSERT INTO sources (id, doc_id, candidate_id, kind, ref, locator, excerpt_hash, verified, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?)',
            [newId('src'), doc.id, 'file', source, candidate.title, contentHash(source).slice(0, 16), Date.now()],
          )
        }
        created.push({ id: doc.id, title: doc.title })
        log('info', '已创建 Wiki 候选草稿「' + doc.title + '」（来源文件 ' + candidate.sources.length + ' 个，可信度 ' + candidate.confidence.toFixed(2) + '）')
      }
    }

    if (created.length === 0 && conflicts.length === 0) {
      throw new InitError('NO_DOCUMENT_CREATED', '本次没有创建任何 Wiki 候选（模型输出未通过校验）')
    }
    if (created.length === 0) {
      // 幂等重跑：模型给出的主题都已在库中（草稿或已批准）。不视为失败，也不覆盖任何已有知识。
      log('warn', '本次没有新增草稿：' + conflicts.length + ' 篇候选均与已有文档同主题，已保留原文档不覆盖')
    }

    // 5) 收尾：状态 + 项目清单
    currentStage = '更新知识库状态'
    progress(95, currentStage)
    const summary = {
      taskId,
      strategy,
      model: { provider: kb.modelProvider, id: kb.modelId },
      calls: callSummaries,
      documents: created,
      conflicts,
      rejected,
      index: { fileCount: index.fileCount, textFileCount: index.textFileCount, byLanguage: index.byLanguage.slice(0, 8), excludedDirs: index.excludedDirs, skippedSensitive: index.skippedSensitive, skippedSymlinks: index.skippedSymlinks, truncated: index.truncated },
      workspace: { id: workspace.id, title: workspace.title, path: root },
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    }
    updateKbStatus(db, kb.id, 'ready', { code: 'OK', message: '初始化完成，候选文档待审核', finishedAt: summary.finishedAt, documents: created.length, conflicts: conflicts.length, model: summary.model, files: index.fileCount })
    await atomicWrite(
      join(kbDir(storageRoot, kb.id), 'project.json'),
      JSON.stringify({
        workspaceId: workspace.id,
        workspacePath: root,
        workspaceTitle: workspace.title,
        initializedAt: summary.finishedAt,
        initializedByModel: summary.model,
        index: { fileCount: index.fileCount, byLanguage: index.byLanguage.slice(0, 12), lastIndexedAt: new Date().toISOString() },
        wikiCandidates: created.length,
        updatedAt: summary.finishedAt,
      }, null, 2) + '\n',
    )
    progress(100, '完成')
    log('info', '初始化完成：候选文档 ' + created.length + ' 篇，冲突 ' + conflicts.length + ' 条，模型调用 ' + calls.length + ' 次')
    return { documents: created.length, conflicts: conflicts.length, files: index.fileCount, calls: calls.length, model: summary.model, purposes: calls.map((call) => call.purpose) }
  } catch (error) {
    const code = error instanceof InitError ? error.code : 'INITIALIZE_FAILED'
    const message = errorMessage(error)
    const cancelled = signal.aborted || code === 'TASK_CANCELLED'
    updateKbStatus(db, kb.id, cancelled ? 'created' : 'error', { code: cancelled ? 'CANCELLED' : code, message, stage: currentStage, taskId, at: new Date().toISOString() })
    log(cancelled ? 'warn' : 'error', '初始化失败（' + (cancelled ? 'CANCELLED' : code) + '，阶段：' + currentStage + '）：' + message)
    throw error instanceof InitError ? error : new InitError(code, message)
  }
}

export interface StartInitializeInput {
  ctx: any
  db: Db
  storageRoot: string
  kb: KbRow
  workspaceId?: string | null
}

/** 创建并异步启动初始化任务；已有运行中的初始化任务时返回 duplicate。 */
export function startInitializeTask(input: StartInitializeInput): { task: TaskRow; duplicate: boolean } {
  const { db, kb } = input
  const result = createTask(db, { kbId: kb.id, kind: 'initialize', idemKey: 'initialize:' + kb.id, input: { workspaceId: input.workspaceId ?? kb.workspaceId } })
  if (result.duplicate) return result
  const taskId = result.task.id
  const executor = (context: { signal: AbortSignal; progress: (percent: number, stage?: string) => void; log: (level: 'info' | 'warn' | 'error', message: string) => void }): Promise<any> =>
    runInitialize({
      ctx: input.ctx,
      db,
      storageRoot: input.storageRoot,
      kb: { ...kb, workspaceId: (input.workspaceId ?? kb.workspaceId) ?? null },
      taskId,
      signal: context.signal,
      progress: context.progress,
      log: context.log,
    })
  void runTask({ db, taskId, executor }).catch((error) => {
    console.error('[knowhub] 初始化任务异常：' + errorMessage(error))
  })
  return result
}

/** 执行一个已经创建好的初始化任务（重试路径复用）。 */
export function executeInitialization(input: { ctx: any; db: Db; storageRoot: string; kb: KbRow; task: TaskRow; workspaceId?: string | null }): void {
  const taskId = input.task.id
  void runTask({
    db: input.db,
    taskId,
    executor: (context) => runInitialize({
      ctx: input.ctx,
      db: input.db,
      storageRoot: input.storageRoot,
      kb: { ...input.kb, workspaceId: (input.workspaceId ?? input.kb.workspaceId) ?? null },
      taskId,
      signal: context.signal,
      progress: context.progress,
      log: context.log,
    }),
  }).catch((error) => {
    console.error('[knowhub] 初始化任务异常：' + errorMessage(error))
  })
}
