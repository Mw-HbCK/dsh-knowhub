/**
 * 初始化流水线（M2）：真实扫描 → 文件索引 → 用知识库绑定模型按内容区生成知识候选 → 存为待审核草稿。
 * Repo Wiki 为两段式：先规划调用产出文档大纲（篇目/父子/证据文件），再按篇用证据文件内容生成；
 * 知识卡片与长期记忆仍按主题线生成。全部 Prompt 已分层到 pipeline/prompts/（L0 写作规则 + L1 任务层）。
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
import { all, get, run, type Db } from '../db/db.js'
import { atomicWrite, kbDir } from '../kb/files.js'
import { contentHash, type KbRow } from '../kb/store.js'
import { createDocument, getDocument, slugify } from '../search.js'
import { recordConflict } from '../review.js'
import { readModelCatalog, runModelCall } from '../model.js'
import { MAX_OUTPUT_ATTEMPTS, parseModelJson, retryTokenBudget } from './model-output.js'
import { listWorkspaces } from '../workspace.js'
import { indexProject, saveProjectIndex, type ProjectIndex } from './index.js'
import { createTask, runTask, type TaskRow } from '../tasks.js'
import { buildWikiPlanPrompt, parseWikiPlan, type WikiPlanEntry } from './prompts/wiki-plan.js'
import { buildWikiWritePrompt } from './prompts/wiki-write.js'
import { buildCardsPrompt } from './prompts/cards.js'
import { buildMemoryPrompt } from './prompts/memory.js'
import { runModelQualityCheck, runQualityChecks } from './quality.js'
import { generateDiagramForDoc } from './diagrams.js'
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
  economy: { maxFiles: 12000, maxHashes: 1500, maxContextChars: 20000, maxTokens: 10000, planMaxDocs: 5, wikiGroupSize: 4, evidenceChars: 12000 },
  balanced: { maxFiles: 20000, maxHashes: 3000, maxContextChars: 40000, maxTokens: 20000, planMaxDocs: 8, wikiGroupSize: 3, evidenceChars: 20000 },
  quality: { maxFiles: 30000, maxHashes: 6000, maxContextChars: 60000, maxTokens: 50000, planMaxDocs: 12, wikiGroupSize: 3, evidenceChars: 30000 },
} as const

type Strategy = keyof typeof STRATEGY_LIMITS

/**
 * 初始化按内容区组织模型调用（W1 两段式）：
 * - Repo Wiki 先做一次结构规划调用产出大纲，再按篇（分组）用证据文件内容生成（见 runInitialize 第 4 步）；
 * - 知识卡片与长期记忆仍按主题线生成，主题表只保留在这两条线；
 * Wiki 规划失败时回退到 legacyWikiOutline 的固定篇目，保证初始化不因规划一步整体失败。
 */
interface PlannedCall {
  purpose: string
  area: 'cards' | 'memory'
  topics: string[]
}

function planCalls(strategy: Strategy): PlannedCall[] {
  const cardsCore: PlannedCall = { purpose: 'cards-core', area: 'cards', topics: ['技术选型与决策', '已知问题与风险'] }
  if (strategy === 'economy') return [cardsCore]
  const memoryCore: PlannedCall = { purpose: 'memory-core', area: 'memory', topics: ['项目背景与长期事实', '项目约定与协作偏好'] }
  if (strategy === 'balanced') return [cardsCore, memoryCore]
  return [
    cardsCore,
    { purpose: 'cards-actions', area: 'cards', topics: ['待办事项与待确认问题'] },
    memoryCore,
  ]
}

/** Wiki 规划不可用时的回退大纲（旧版固定主题表，仅作兜底）。 */
function legacyWikiOutline(strategy: Strategy): WikiPlanEntry[] {
  const entry = (title: string, angle: WikiPlanEntry['angle']): WikiPlanEntry => ({ title, purpose: '', angle, evidence: [], parentTitle: null, diagram: null })
  const base = [entry('项目总览', 'overview'), entry('技术栈与依赖', 'general')]
  if (strategy === 'economy') return base
  const more = [...base, entry('系统架构', 'architecture'), entry('核心模块', 'module')]
  if (strategy === 'balanced') return more
  return [...more, entry('关键接口与数据流', 'interface')]
}

const AREA_LABELS: Record<PlannedCall['area'], string> = { cards: '知识卡片', memory: '长期记忆' }

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

/** 读取关键文件摘录补强上下文：README 优先、其次入口文件；只读已进入索引的文件（敏感文件已被索引排除），读不到就跳过。 */
async function readKeyFileSnippets(root: string, index: ProjectIndex): Promise<Array<{ path: string; text: string }>> {
  const known = new Set(index.files.map((file) => file.path))
  const picks: Array<{ path: string; cap: number }> = []
  const readme = index.files.find((file) => /^readme(\.[a-z-]+)?\.md$/i.test(file.path))
  if (readme) picks.push({ path: readme.path, cap: 6000 })
  for (const hint of index.stack.entryHints.slice(0, 2)) {
    if (known.has(hint) && hint !== readme?.path) picks.push({ path: hint, cap: 2500 })
  }
  const snippets: Array<{ path: string; text: string }> = []
  for (const pick of picks) {
    try {
      const text = await fs.readFile(join(root, pick.path), 'utf8')
      snippets.push({ path: pick.path, text: text.slice(0, pick.cap) })
    } catch {
      // 读不到就跳过，不阻断初始化。
    }
  }
  return snippets
}

function buildContext(index: ProjectIndex, strategy: Strategy, keySnippets: Array<{ path: string; text: string }> = []): string {
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
  if (keySnippets.length > 0) {
    parts.push('关键文件内容摘录：')
    for (const snippet of keySnippets) {
      parts.push('--- ' + snippet.path + ' ---')
      parts.push(snippet.text)
    }
  }
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

/** 读取大纲各篇证据文件的内容摘录：只读已进入索引的文件，按篇目顺序去重，总量受策略上限约束。 */
async function readEvidenceFiles(root: string, entries: WikiPlanEntry[], knownPaths: Set<string>, capChars: number): Promise<string> {
  const seen = new Set<string>()
  const parts: string[] = []
  let used = 0
  for (const entry of entries) {
    for (const path of entry.evidence) {
      if (seen.has(path) || !knownPaths.has(path)) continue
      seen.add(path)
      try {
        const text = await fs.readFile(join(root, path), 'utf8')
        const slice = text.slice(0, 3000)
        if (used + slice.length > capChars) return parts.join('\n')
        parts.push('--- ' + path + ' ---')
        parts.push(slice)
        used += slice.length
      } catch {
        // 读不到就跳过，不阻断生成。
      }
    }
  }
  return parts.join('\n')
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

    // 4) 生成候选：Wiki 两段式（规划→按篇生成），卡片/记忆按主题线；单线失败不拖垮整轮。
    const keySnippets = await readKeyFileSnippets(root, index)
    if (keySnippets.length > 0) log('info', '已读取 ' + keySnippets.length + ' 个关键文件的内容摘录补强上下文')
    const context = buildContext(index, strategy, keySnippets)
    const knownPaths = new Set(index.files.map((file) => file.path))
    const created: Array<{ id: string; title: string }> = []
    const conflicts: Array<{ title: string; reason: string }> = []
    const rejected: string[] = []
    const callFailures: Array<{ purpose: string; code: string; message: string }> = []
    let documentsSeen = 0
    const callSummaries: any[] = []
    const executedPurposes: string[] = []
    const docIdBySlug = new Map<string, string>()
    const createdDocIds = new Set<string>()

    const secrets = { root, storageRoot }
    currentStage = '生成知识候选'

    // 执行一次模型调用（含截断升额度重试与 llm_calls 记录）。mode='documents' 时做文档校验并返回候选；
    // mode='raw' 时返回原始解析结果（规划调用用）。本线失败记入 callFailures 并返回 null；模型调用本身失败按既有语义抛错。
    const executeCall = async (planned: { purpose: string }, prompt: string, mode: 'documents' | 'raw'): Promise<any> => {
      executedPurposes.push(planned.purpose)
      let budget: number = limits.maxTokens
      for (let attempt = 1; ; attempt += 1) {
        ensureNotAborted(signal)
        const result = await runModelCall(ctx, {
          provider: kb.modelProvider,
          model: kb.modelId,
          system: '你是严谨的代码仓库文档分析器，只依据给定事实输出严格 JSON。',
          prompt,
          maxTokens: budget,
          temperature: 0.2,
          timeoutMs: 150000,
          signal,
        })
        recordLlmCall(db, kb, taskId, planned.purpose, result)
        callSummaries.push({ purpose: planned.purpose, provider: result.provider, model: result.model, ok: result.ok, finishKind: result.finishKind, failure: result.failure, elapsedMs: result.elapsedMs, usage: result.usage, attempt, maxTokens: budget })
        if (result.aborted || signal.aborted) throw new InitError('TASK_CANCELLED', '任务已取消（模型调用被中断）')
        if (!result.ok) {
          const failureCode = result.failure?.code ?? 'MODEL_CALL_FAILED'
          throw new InitError('MODEL_CALL_FAILED', '模型调用失败（' + kb.modelProvider + ' / ' + kb.modelId + '，' + failureCode + '）：' + (result.failure?.message ?? '未知错误'))
        }
        log('info', '模型返回 ' + result.text.length + ' 字符（finish=' + String(result.finishKind) + '，预算 ' + budget + ' tokens，耗时 ' + result.elapsedMs + 'ms）')
        const output = parseModelJson(result.text, { finishKind: result.finishKind, maxTokens: budget, attempt, reasoningChars: result.reasoningChars })
        const truncated = result.finishKind === 'max-tokens'
        if (output.ok) {
          const docCount = Array.isArray(output.value?.documents) ? output.value.documents.length : 0
          if (mode === 'documents' && docCount === 0 && truncated && attempt < MAX_OUTPUT_ATTEMPTS) {
            const nextBudget = retryTokenBudget(budget)
            log('warn', '模型在 ' + budget + ' tokens 预算内没有写出任何文档（finish=max-tokens，思考 ' + String(result.reasoningChars ?? 0) + ' 字符），改用 ' + nextBudget + ' tokens 重试一次')
            budget = nextBudget
            continue
          }
          if (mode === 'raw') return output.value
          try {
            const validated = validateDocuments(output.value, knownPaths, secrets)
            rejected.push(...validated.rejected)
            documentsSeen += validated.documents.length
            if (validated.rejected.length > 0) log('warn', '丢弃 ' + validated.rejected.length + ' 条不合格文档候选')
            return validated.documents
          } catch (validationError) {
            if (validationError instanceof InitError && validationError.code === 'MODEL_OUTPUT_INVALID') {
              callFailures.push({ purpose: planned.purpose, code: validationError.code, message: validationError.message })
              log('warn', '本轮生成失败，已跳过（' + planned.purpose + '，' + validationError.code + '）：' + validationError.message)
              return null
            }
            throw validationError
          }
        }
        if (output.truncated && attempt < MAX_OUTPUT_ATTEMPTS) {
          const nextBudget = retryTokenBudget(budget)
          log('warn', '模型输出被截断（' + budget + ' tokens 上限），改用 ' + nextBudget + ' tokens 重试一次：' + planned.purpose)
          budget = nextBudget
          continue
        }
        callFailures.push({ purpose: planned.purpose, code: output.code, message: output.message })
        log('warn', '本轮生成失败，已跳过（' + planned.purpose + '，' + output.code + '）：' + output.message)
        return null
      }
    }

    // 已有文档标题快照：质检的交叉引用检查用（只许引用真实存在的文档）。
    const existingTitles = all(db, 'SELECT title FROM documents WHERE kb_id = ? AND deleted_at IS NULL', [kb.id]).map((row: any) => String(row.title))

    // 候选落盘：同 slug 已存在则记冲突不覆盖；Wiki 候选可带 parentId（由大纲父篇经 docIdBySlug 解析）。
    // 质检 flags（规则检查 + 模型质检）附到草稿正文的「质检提示」段，仅供审核参考，不拦截生成。
    const storeCandidates = async (candidates: CandidateDoc[], parentSlugByDocSlug?: Map<string, string | null>, extraFlags?: Map<string, string[]>, siblingTitles?: string[]): Promise<void> => {
      for (const candidate of candidates) {
        const slug = slugify(candidate.title)
        const existing = get(db, 'SELECT id, status, title FROM documents WHERE kb_id = ? AND slug = ? AND deleted_at IS NULL', [kb.id, slug])
        if (existing) {
          docIdBySlug.set(slug, String(existing.id))
          conflicts.push({ title: candidate.title, reason: existing.status === 'approved' ? '已存在同主题的已批准文档，本次候选未覆盖' : '已存在同主题草稿，未创建重复文档（等待审核或增量更新）' })
          log('warn', '跳过候选「' + candidate.title + '」：' + (existing.status === 'approved' ? '已批准文档不可被静默覆盖' : '已存在同主题草稿'))
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
        const qualityFlags = [
          ...runQualityChecks({ title: candidate.title, kind: candidate.kind, body: candidate.body, sources: candidate.sources, siblingTitles: siblingTitles ?? existingTitles }),
          ...(extraFlags?.get(slug) ?? []),
        ]
        if (qualityFlags.length > 0) {
          bodyParts.push('', '## 质检提示（自动检查，仅供审核参考）', ...qualityFlags.map((flag) => '- ' + flag))
        }
        const body = bodyParts.join('\n') + '\n\n> 本文由模型基于仓库索引生成（' + kb.modelProvider + ' / ' + kb.modelId + '），当前为待审核草稿。\n'
        let parentId: string | null = null
        const parentSlug = parentSlugByDocSlug?.get(slug)
        if (parentSlug) parentId = docIdBySlug.get(parentSlug) ?? null
        const doc = await createDocument(db, storageRoot, kb, {
          title: candidate.title,
          kind: candidate.kind,
          body,
          tags: candidate.tags,
          status: 'draft',
          verifyState: candidate.verifyState,
          confidence: candidate.confidence,
          ...(parentId ? { parentId } : {}),
        })
        docIdBySlug.set(slug, doc.id)
        createdDocIds.add(doc.id)
        for (const source of candidate.sources) {
          run(
            db,
            'INSERT INTO sources (id, doc_id, candidate_id, kind, ref, locator, excerpt_hash, verified, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?)',
            [newId('src'), doc.id, 'file', source, candidate.title, contentHash(source).slice(0, 16), Date.now()],
          )
        }
        created.push({ id: doc.id, title: doc.title })
        log('info', '已创建候选草稿「' + doc.title + '」（来源文件 ' + candidate.sources.length + ' 个，可信度 ' + candidate.confidence.toFixed(2) + '）')
      }
    }

    // 4a) Wiki 第一段：结构规划。失败（输出不合法/为空）回退固定篇目，不让整轮初始化失败。
    progress(40, '规划 Repo Wiki 文档结构')
    const planRaw = await executeCall({ purpose: 'wiki-plan' }, buildWikiPlanPrompt(context, limits.planMaxDocs), 'raw')
    let outline: WikiPlanEntry[] = []
    if (planRaw) {
      const plan = parseWikiPlan(planRaw, knownPaths, limits.planMaxDocs)
      outline = plan.entries
      for (const dropped of plan.dropped) log('warn', 'Wiki 规划条目被丢弃：' + dropped)
    }
    if (outline.length === 0) {
      log('warn', 'Wiki 结构规划未产出可用大纲，回退到固定篇目规划')
      outline = legacyWikiOutline(strategy)
    } else {
      log('info', 'Wiki 大纲共 ' + outline.length + ' 篇：' + outline.map((entry) => entry.title).join('、'))
    }

    // 4b) Wiki 第二段：按大纲分组生成（父先子后），上下文为各篇证据文件内容。
    const groupSize = limits.wikiGroupSize
    const outlineIndexBySlug = new Map(outline.map((entry, index) => [slugify(entry.title), index]))
    const parentSlugByDocSlug = new Map(outline.map((entry) => [slugify(entry.title), entry.parentTitle ? slugify(entry.parentTitle) : null]))
    const baseFacts = context.slice(0, 4000)
    for (let start = 0; start < outline.length; start += groupSize) {
      const group = outline.slice(start, start + groupSize)
      ensureNotAborted(signal)
      progress(45 + Math.round((start / outline.length) * 35), '调用模型生成 Repo Wiki：' + group.map((entry) => entry.title).join('、'))
      const evidenceText = await readEvidenceFiles(root, group, knownPaths, limits.evidenceChars)
      const prompt = buildWikiWritePrompt({ entries: group, outline, evidenceText: evidenceText === '' ? '（本组篇目没有可读的证据文件内容，请依据项目基本事实谨慎撰写，证据不足处写入 uncertain）' : evidenceText, baseFacts })
      log('info', '调用模型（wiki-write，篇目：' + group.map((entry) => entry.title).join('、') + '，提示长度 ' + prompt.length + ' 字符）')
      const docs = await executeCall({ purpose: 'wiki-write' }, prompt, 'documents')
      if (docs) {
        const sorted = [...docs].sort((a: CandidateDoc, b: CandidateDoc) => (outlineIndexBySlug.get(slugify(a.title)) ?? 999) - (outlineIndexBySlug.get(slugify(b.title)) ?? 999))
        let extraFlags: Map<string, string[]> | undefined
        if (readSettings(db).qualityModelCheck) {
          extraFlags = new Map<string, string[]>()
          for (const candidate of sorted) {
            if (candidate.body.length < 800) continue
            const issues = await runModelQualityCheck(ctx, db, kb, taskId, { title: candidate.title, kind: candidate.kind, body: candidate.body })
            if (issues.length > 0) extraFlags.set(slugify(candidate.title), issues)
          }
        }
        await storeCandidates(sorted, parentSlugByDocSlug, extraFlags, [...existingTitles, ...outline.map((entry) => entry.title)])
      }
    }

    // 4c) 知识卡片与长期记忆两条线（主题规划保持不变，Prompt 已分层到 prompts/）。
    const lineCalls = planCalls(strategy)
    for (let position = 0; position < lineCalls.length; position += 1) {
      const planned = lineCalls[position]
      if (!planned) continue
      ensureNotAborted(signal)
      progress(82 + Math.round((position / lineCalls.length) * 10), '调用模型生成' + AREA_LABELS[planned.area] + '：' + planned.topics.join('、'))
      const prompt = planned.area === 'cards' ? buildCardsPrompt(planned.topics, context) : buildMemoryPrompt(planned.topics, context)
      log('info', '调用模型（' + planned.purpose + '，主题：' + planned.topics.join('、') + '，提示长度 ' + prompt.length + ' 字符）')
      const docs = await executeCall(planned, prompt, 'documents')
      if (docs) await storeCandidates(docs)
    }

    if (created.length === 0 && conflicts.length === 0) {
      // 全部线都失败：优先报截断（有明确的换模型/升档建议），其次报输出不合法，最后才是无产出。
      const truncatedFailure = callFailures.find((failure) => failure.code === 'MODEL_OUTPUT_TRUNCATED')
      if (truncatedFailure) throw new InitError('MODEL_OUTPUT_TRUNCATED', truncatedFailure.message)
      const invalidFailure = callFailures.find((failure) => failure.code === 'MODEL_OUTPUT_INVALID')
      if (invalidFailure) throw new InitError('MODEL_OUTPUT_INVALID', invalidFailure.message)
      throw new InitError('NO_DOCUMENT_CREATED', '本次没有创建任何知识候选（模型输出未通过校验）')
    }
    if (created.length === 0) {
      // 幂等重跑：模型给出的主题都已在库中（草稿或已批准）。不视为失败，也不覆盖任何已有知识。
      log('warn', '本次没有新增草稿：' + conflicts.length + ' 篇候选均与已有文档同主题，已保留原文档不覆盖')
    }

    // 4d) Archify 图表：按大纲简报为本轮新建的 Wiki 生成图表（档位设置控制；失败只记日志，不影响知识生成）
    const archifyAuto = readSettings(db).archifyAuto
    const archifyEnabled = archifyAuto === 'all' || (archifyAuto === 'quality' && strategy === 'quality')
    let diagramsCreated = 0
    if (archifyEnabled) {
      const briefed = outline.filter((entry) => entry.diagram !== null)
      const capped = briefed.slice(0, 3)
      if (briefed.length > capped.length) log('warn', '本轮有 ' + briefed.length + ' 篇带图表简报，按上限只生成前 ' + capped.length + ' 张，其余可在文档页手动生成')
      for (const entry of capped) {
        const docId = docIdBySlug.get(slugify(entry.title))
        if (!docId || !createdDocIds.has(docId)) continue
        const doc = getDocument(db, docId)
        if (!doc) continue
        progress(93, '生成图表：' + entry.title)
        const evidenceText = await readEvidenceFiles(root, [{ ...entry, evidence: entry.diagram!.sources }], knownPaths, limits.evidenceChars)
        const generated = await generateDiagramForDoc(ctx, db, kb, { doc, type: entry.diagram!.type, sources: entry.diagram!.sources, workspaceRoot: root, evidenceText, taskId })
        if (generated.ok) {
          diagramsCreated += 1
          log('info', '已为《' + entry.title + '》生成 ' + entry.diagram!.type + ' 图表并关联')
        } else {
          log('warn', '《' + entry.title + '》图表生成未完成：' + (generated.error ?? '未知错误') + '（不影响知识生成）')
        }
      }
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
      failures: callFailures,
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
    log('info', '初始化完成：候选文档 ' + created.length + ' 篇，冲突 ' + conflicts.length + ' 条，模型调用 ' + executedPurposes.length + ' 次' + (callFailures.length > 0 ? '，其中 ' + callFailures.length + ' 条线生成失败已跳过' : ''))
    return { documents: created.length, conflicts: conflicts.length, files: index.fileCount, calls: executedPurposes.length, model: summary.model, purposes: executedPurposes }
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
