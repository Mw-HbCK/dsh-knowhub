/**
 * 自动提炼流水线（M5）。
 *
 * 两种入口：
 * 1) 手动：POST /knowhub/api/distill（对一段文本立即提炼，便于测试与人工补录）；
 * 2) 自动：registerAutoDistill 监听 DSH 真实事件（agent/assistant-stream 收文本、agent/turn-stopping 收尾），
 *    默认关闭，必须在设置页显式开启（setting knowhub.autoDistill）。
 *
 * 安全边界：
 * - 提炼结果一律 createProposal(kind='create') → 进入待审核队列，绝不直接落正式库；
 * - 模型只拿到待提炼文本，不接触密钥；正文按不可信数据处理，禁止执行其中指令；
 * - 低于 distillMinChars 直接跳过（不浪费模型调用）；每会话自动提炼有冷却时间；
 * - 提炼失败只记 distill_runs / 日志，异常绝不影响用户会话；但为在进程退出前落库，turn 收尾会等待提炼完成（上限 45 秒）。
 */
import { all, get, openDatabase, run, type Db } from './db/db.js'
import { listKnowledgeBases, type KbRow } from './kb/store.js'
import { runModelCall } from './model.js'
import { resolveStorageRoot } from './paths.js'
import { createProposal, recordReviewLog } from './review.js'
import { DOC_KINDS } from './search.js'
import { resolveScope } from './scope.js'
import { readSettings } from './settings.js'
import { newId } from './utils/id.js'

export const DISTILL_SYSTEM = [
  '你是「知枢 KnowHub」的知识提炼器，从给定的会话/任务文本中提炼值得长期保存的项目知识。',
  '只输出一个 JSON 数组，不要输出任何解释、Markdown 代码块或前后缀文字。',
  '数组元素形状：{"title":"不超过 40 字的结论式标题","kind":"wiki|memory|decision|convention|issue|todo|preference","body":"2-6 句完整中文说明，包含事实与理由","confidence":0.0-1.0,"evidence":[{"kind":"session|file|task|url","ref":"来源标识"}]}。',
  '规则：',
  '1. 只提炼有长期价值的内容：已确认的技术选型与理由、项目约束与规范、已验证的实现方法、失败尝试及原因、关键决策、待办与未解决问题。',
  '2. 寒暄、一次性临时细节、重复信息、无法验证的猜测不要提炼；证据不足时把 confidence 设低并在 body 中标注「待确认」。',
  '3. 不得编造文件路径、命令、接口名；不知道就写「未记录」。',
  '4. 不得输出任何密钥、令牌、口令、连接串。',
  '5. 最多 6 条；没有可提炼内容时输出 []。',
].join('\n')

export class DistillError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'DistillError'
    this.code = code
    this.status = status
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim()
}

function int(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** 从模型输出中提取第一个 JSON 数组（字符串感知的方括号配平，容忍代码块围栏）。 */
export function extractJsonArray(text: string): string | null {
  const source = String(text ?? '')
  const start = source.indexOf('[')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

export interface DistillCandidate {
  title: string
  kind: string
  body: string
  confidence: number
  evidence: { kind: string; ref: string }[]
}

/** 清洗疑似密钥与绝对路径（宁可少留，也不把敏感信息带进知识库）。 */
export function sanitizeDistilledText(text: string): string {
  let out = String(text ?? '')
  out = out.replace(/\b(?:sk|pk|rk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, '[已移除疑似凭据]')
  out = out.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[已移除疑似密钥]')
  out = out.replace(/\b(?:Bearer|Token|Password|Passwd|Secret|Api[-_]?Key)\s*[:=]\s*\S+/gi, (m) => m.split(/[:=]/)[0] + '=[已移除]')
  out = out.replace(/\b(?:Bearer|Basic|Authorization)\s+[A-Za-z0-9._\-+/=]{8,}/gi, '[已移除凭据]')
  out = out.replace(/(?:[A-Za-z]:\\[^\s，。；;、）)]+|\/(?:Users|home|root|etc|var|opt)\/[^\s，。；;、）)]+)/g, '[本地路径已省略]')
  return out.trim()
}

export interface ParsedCandidates {
  candidates: DistillCandidate[]
  rejected: { title: string; reason: string }[]
  error: string | null
}

/** 解析并校验模型输出；不合格的条目丢弃并记录原因（不让模型输出直接进库）。 */
export function parseCandidates(text: string): ParsedCandidates {
  const rejected: { title: string; reason: string }[] = []
  const raw = extractJsonArray(text)
  if (raw === null) return { candidates: [], rejected, error: '模型输出中没有找到 JSON 数组' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { candidates: [], rejected, error: 'JSON 解析失败：' + (error instanceof Error ? error.message : String(error)) }
  }
  if (!Array.isArray(parsed)) return { candidates: [], rejected, error: '模型输出不是数组' }
  const candidates: DistillCandidate[] = []
  for (const item of parsed) {
    const record = (item ?? {}) as any
    const title = sanitizeDistilledText(str(record.title)).slice(0, 80)
    const kind = str(record.kind)
    const body = sanitizeDistilledText(typeof record.body === 'string' ? record.body : '').slice(0, 4000)
    const confidenceRaw = Number(record.confidence)
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5
    if (title === '') { rejected.push({ title: '', reason: '标题为空' }); continue }
    if (!DOC_KINDS.includes(kind as any)) { rejected.push({ title, reason: '知识类型不合法：' + kind }); continue }
    if (body.length < 20) { rejected.push({ title, reason: '正文过短（少于 20 字）' }); continue }
    if (body.startsWith('抱歉') || body.startsWith('无法')) { rejected.push({ title, reason: '模型未给出有效内容' }); continue }
    const evidence: { kind: string; ref: string }[] = []
    if (Array.isArray(record.evidence)) {
      for (const ev of record.evidence) {
        const kind = str((ev ?? {}).kind)
        const ref = str((ev ?? {}).ref)
        if (ref === '') continue
        if (ref.startsWith('/') || /^[A-Za-z]:[\\/]/.test(ref) || ref.split(/[\\/]/).includes('..')) continue
        evidence.push({ kind: ['file', 'session', 'task', 'url'].includes(kind) ? kind : 'session', ref: ref.slice(0, 300) })
      }
    }
    candidates.push({ title, kind, body, confidence, evidence })
    if (candidates.length >= 6) break
  }
  return { candidates, rejected, error: null }
}

export interface DistillInput {
  text: string
  kbId?: string | null
  scope?: { workspaceId?: string | null; wsId?: string | null; workspacePath?: string | null; workspaceTitle?: string | null; scopekeys?: string[]; scopeKeys?: string[] } | null
  source: string
  actor?: string | null
  signal?: AbortSignal
  cwd?: string | null
}

export interface DistillResult {
  status: 'success' | 'failed' | 'skipped'
  runId: string | null
  knowledgeBaseId: string | null
  model: { provider: string | null; model: string | null }
  created: { proposalId: string; title: string; kind: string; confidence: number }[]
  skipped: { title: string; reason: string }[]
  rejected: { title: string; reason: string }[]
  chars: number
  elapsedMs: number
  error: { code: string; message: string } | null
}

function resolveKeys(input: DistillInput): string[] {
  const explicit = input.scope?.scopeKeys ?? input.scope?.scopekeys
  if (Array.isArray(explicit) && explicit.length > 0) return explicit.map(String)
  const wsId = str(input.scope?.workspaceId ?? input.scope?.wsId)
  if (wsId !== '') return ['user:*', 'ws:' + wsId]
  return ['user:*']
}

/** 选库：显式 kbId > 工作区级且有模型的库 > 用户级且有模型的库。 */
function pickKnowledgeBase(db: Db, keys: string[], kbId: string): KbRow {
  const kbs = listKnowledgeBases(db, keys).filter((kb) => kb.status !== 'disabled')
  if (kbId !== '') {
    const found = kbs.find((kb) => kb.id === kbId)
    if (!found) throw new DistillError('KB_FORBIDDEN', 403, '知识库不存在或当前作用域无权访问：' + kbId)
    return found
  }
  const usable = kbs.filter((kb) => str(kb.modelProvider) !== '' && str(kb.modelId) !== '')
  const workspace = usable.find((kb) => kb.scope === 'workspace')
  if (workspace) return workspace
  const user = usable.find((kb) => kb.scope === 'user')
  if (user) return user
  const first = kbs[0]
  if (first) throw new DistillError('NO_MODEL_CONFIGURED', 400, '知识库「' + first.name + '」未绑定可用模型，请先在知识库设置中选择模型')
  throw new DistillError('NO_KNOWLEDGE_BASE', 400, '当前作用域还没有知识库，请先创建知识库')
}

function normalizeForCompare(text: string): string {
  return String(text ?? '').replace(/\s+/g, '').toLowerCase()
}

/** 去重：同一库里已有正式知识或同标题同正文的待审核候选都跳过。 */
function findDuplicate(db: Db, kbId: string, candidate: DistillCandidate): string | null {
  const docs = all<any>(db, 'SELECT title, body FROM documents WHERE kb_id = ? AND deleted_at IS NULL', [kbId])
  const targetBody = normalizeForCompare(candidate.body)
  for (const doc of docs) {
    if (normalizeForCompare(String(doc.body ?? '')) === targetBody) return '已存在相同正文的正式知识：' + String(doc.title ?? '')
  }
  const proposals = all<any>(db, "SELECT title, body FROM proposals WHERE kb_id = ? AND status = 'pending'", [kbId])
  for (const proposal of proposals) {
    if (normalizeForCompare(String(proposal.body ?? '')) === targetBody) return '已存在相同正文的待审核候选：' + String(proposal.title ?? '')
  }
  return null
}

function recordRun(db: Db, input: { id: string; kbId: string | null; workspaceId: string | null; source: string; status: string; created: number; skipped: number; provider: string | null; model: string | null; note: string | null }): void {
  run(db, 'INSERT INTO distill_runs (id, kb_id, workspace_id, source, status, created_count, skipped_count, model_provider, model_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    input.id, input.kbId, input.workspaceId, input.source, input.status, input.created, input.skipped, input.provider, input.model, input.note, Date.now(),
  ])
}

export function listDistillRuns(db: Db, limit = 20): any[] {
  return all<any>(db, 'SELECT * FROM distill_runs ORDER BY created_at DESC LIMIT ?', [Math.max(1, Math.min(100, limit))])
    .map((row) => ({
      id: String(row.id), kbId: row.kb_id ?? null, workspaceId: row.workspace_id ?? null, source: String(row.source),
      status: String(row.status), createdCount: int(row.created_count), skippedCount: int(row.skipped_count),
      modelProvider: row.model_provider ?? null, modelId: row.model_id ?? null, note: row.note ?? null, createdAt: int(row.created_at),
    }))
}

/** 对一个文本片段做提炼，结果全部进待审核队列。 */
export async function distillText(ctx: any, db: Db, config: any, input: DistillInput): Promise<DistillResult> {
  const started = Date.now()
  const runId = newId('dst')
  const settings = readSettings(db)
  const text = String(input.text ?? '')
  const workspaceId = str(input.scope?.workspaceId ?? input.scope?.wsId)
  const base = {
    status: 'skipped' as 'success' | 'failed' | 'skipped',
    runId, knowledgeBaseId: null as string | null, model: { provider: null as string | null, model: null as string | null },
    created: [] as DistillResult['created'], skipped: [] as DistillResult['skipped'], rejected: [] as DistillResult['rejected'],
    chars: text.length, elapsedMs: 0, error: null as DistillResult['error'],
  }

  if (settings.autoDistill === false && str(input.source).startsWith('auto')) {
    recordRun(db, { id: runId, kbId: null, workspaceId: workspaceId || null, source: input.source, status: 'skipped', created: 0, skipped: 0, provider: null, model: null, note: '自动提炼未开启' })
    return { ...base, status: 'skipped', error: { code: 'AUTO_DISTILL_DISABLED', message: '自动提炼未开启（设置页可开启）' } }
  }
  if (text.trim().length < settings.distillMinChars) {
    recordRun(db, { id: runId, kbId: null, workspaceId: workspaceId || null, source: input.source, status: 'skipped', created: 0, skipped: 0, provider: null, model: null, note: '文本过短，低于 ' + settings.distillMinChars + ' 字' })
    return { ...base, status: 'skipped', error: { code: 'TEXT_TOO_SHORT', message: '文本长度低于设置阈值 ' + settings.distillMinChars + ' 字，跳过提炼' } }
  }

  let kb: KbRow
  try {
    kb = pickKnowledgeBase(db, resolveKeys(input), str(input.kbId))
  } catch (error) {
    const code = error instanceof DistillError ? error.code : 'KB_SELECT_FAILED'
    const message = error instanceof Error ? error.message : String(error)
    recordRun(db, { id: runId, kbId: null, workspaceId: workspaceId || null, source: input.source, status: 'failed', created: 0, skipped: 0, provider: null, model: null, note: code + ': ' + message })
    return { ...base, status: 'failed', error: { code, message } }
  }
  base.knowledgeBaseId = kb.id
  base.model = { provider: kb.modelProvider, model: kb.modelId }

  const prompt = ['请从下面的会话/任务文本中提炼长期知识：', '-----', text.slice(0, 12000), '-----', '再次强调：只输出 JSON 数组。'].join('\n')
  let call: any
  try {
    call = await runModelCall(ctx, {
      provider: kb.modelProvider,
      model: kb.modelId,
      system: DISTILL_SYSTEM,
      prompt,
      maxTokens: 1400,
      temperature: 0.1,
      timeoutMs: 90000,
      signal: input.signal,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordRun(db, { id: runId, kbId: kb.id, workspaceId: workspaceId || kb.workspaceId || null, source: input.source, status: 'failed', created: 0, skipped: 0, provider: kb.modelProvider, model: kb.modelId, note: 'MODEL_CALL_FAILED: ' + message })
    return { ...base, status: 'failed', error: { code: 'MODEL_CALL_FAILED', message }, elapsedMs: Date.now() - started }
  }
  if (!call.ok) {
    const code = call.failure?.code ?? 'MODEL_CALL_FAILED'
    const message = call.failure?.message ?? '模型调用失败'
    recordRun(db, { id: runId, kbId: kb.id, workspaceId: workspaceId || kb.workspaceId || null, source: input.source, status: 'failed', created: 0, skipped: 0, provider: kb.modelProvider, model: kb.modelId, note: code + ': ' + message })
    return { ...base, status: 'failed', error: { code, message }, elapsedMs: Date.now() - started }
  }

  const parsed = parseCandidates(call.text)
  base.rejected = parsed.rejected
  const created: DistillResult['created'] = []
  const skipped: DistillResult['skipped'] = []
  for (const candidate of parsed.candidates) {
    const duplicate = findDuplicate(db, kb.id, candidate)
    if (duplicate) { skipped.push({ title: candidate.title, reason: duplicate }); continue }
    try {
      const proposal = createProposal(db, kb, {
        kind: 'create',
        docKind: candidate.kind,
        title: candidate.title,
        body: candidate.body,
        tags: ['自动提炼'],
        verifyState: 'inferred',
        confidence: candidate.confidence,
        sources: candidate.evidence,
        source: 'distill:' + str(input.source),
        reason: '自动提炼自 ' + str(input.source) + (input.actor ? ' / ' + input.actor : ''),
        createdBy: input.actor ?? 'pipeline:distill',
      })
      created.push({ proposalId: proposal.id, title: proposal.title ?? candidate.title, kind: candidate.kind, confidence: candidate.confidence })
    } catch (error) {
      skipped.push({ title: candidate.title, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  recordRun(db, {
    id: runId, kbId: kb.id, workspaceId: workspaceId || kb.workspaceId || null, source: input.source,
    status: parsed.error ? 'failed' : 'success', created: created.length, skipped: skipped.length,
    provider: kb.modelProvider, model: kb.modelId, note: parsed.error ?? (parsed.candidates.length === 0 ? '模型没有提炼出候选' : null),
  })
  if (created.length > 0) recordReviewLog(db, { action: 'distill', itemKind: 'proposal', itemId: runId, kbId: kb.id, actor: input.actor ?? 'pipeline:distill', note: '自动提炼生成 ' + created.length + ' 条待审核候选' })
  return {
    ...base,
    status: parsed.error ? 'failed' : 'success',
    created, skipped,
    error: parsed.error ? { code: 'MODEL_OUTPUT_INVALID', message: parsed.error } : null,
    elapsedMs: Date.now() - started,
  }
}

interface SessionBuffer { text: string; lastAt: number; running: boolean; lastRunAt: number }

/** 单次自动提炼在 turn 收尾时的最长等待：serial 事件会阻塞 turn，必须有上限。 */
const AUTO_DISTILL_WAIT_MS = 45000

/**
 * 自动提炼：监听 DSH 真实事件。
 * - agent/assistant-stream：累积本会话助手输出文本（只累积 text-delta）；
 * - agent/turn-stopping：turn 收尾时若开启自动提炼且文本够长，异步提炼（不阻塞 turn）。
 * 事件形状做防御式读取，拿不到必要字段就静默放弃（不会因为事件 API 差异导致插件报错）。
 */
export function registerAutoDistill(hostCtx: any, config: any): void {
  if (!hostCtx || typeof hostCtx.on !== 'function') return
  const buffers = new Map<string, SessionBuffer>()
  const MAX_BUFFER = 24000
  const COOLDOWN_MS = 120000
  let lastAgent: any = null

  const bufferOf = (key: string): SessionBuffer => {
    let buffer = buffers.get(key)
    if (!buffer) { buffer = { text: '', lastAt: 0, running: false, lastRunAt: 0 }; buffers.set(key, buffer) }
    return buffer
  }

  const agentOf = (payload: any): any => payload?.agent ?? payload?.ctx ?? null
  const keyOf = (agent: any): string => str(agent?.id ?? agent?.session?.id ?? 'default') || 'default'

  // 契约（DSH 0.2.1）：assistant-stream payload 是 { agent, frame }，文本增量在 frame.chunk.type === 'text-delta' 的 frame.chunk.text；
  // turn-stopping 的 payload 可能只有 { turn, signal }，用最近一次流事件里的 agent 兜底。
  hostCtx.on('agent/assistant-stream', (payload: any) => {
    try {
      const frame = payload?.frame ?? null
      // 只认真实契约：文本增量在 frame.chunk；不接受顶层 chunk/event（旧实现误读的形状）。
      const chunk = frame?.chunk ?? null
      if (!chunk || chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || chunk.text === '') return
      const agent = agentOf(payload)
      if (agent) lastAgent = agent
      const buffer = bufferOf(keyOf(agent))
      buffer.text = (buffer.text + chunk.text).slice(-MAX_BUFFER)
      buffer.lastAt = Date.now()
    } catch { /* 静默：事件异常不影响用户会话 */ }
  })

  // turn-stopping 是 serial 事件：返回的 promise 会被 await。这里返回提炼 promise（上限 AUTO_DISTILL_WAIT_MS），
  // 保证进程退出前提炼结果已落库；开启自动提炼后 turn 收尾最多多等这一次模型调用。
  hostCtx.on('agent/turn-stopping', (payload: any): Promise<void> | void => {
    try {
      const agent = agentOf(payload) ?? lastAgent
      const key = keyOf(agent)
      const buffer = buffers.get(key)
      if (!buffer || buffer.text.trim() === '') return
      if (buffer.running) return
      if (Date.now() - buffer.lastRunAt < COOLDOWN_MS) return
      const db = openDatabase(resolveStorageRoot(config))
      const settings = readSettings(db)
      if (!settings.autoDistill) return
      const text = buffer.text
      if (text.trim().length < settings.distillMinChars) return
      const cwd = str(agent?.session?.header?.cwd ?? agent?.session?.cwd ?? '') || process.cwd()
      buffer.running = true
      buffer.lastRunAt = Date.now()
      buffer.text = ''
      const work = (async (): Promise<void> => {
        try {
          const scope = await resolveScope(hostCtx, cwd)
          await distillText(hostCtx, db, config, { text, scope, source: 'auto:turn', actor: 'pipeline:auto-distill' })
        } catch { /* 自动提炼失败静默，不影响会话 */ }
        finally {
          const current = buffers.get(key)
          if (current) current.running = false
        }
      })()
      const cap = new Promise<void>((resolve) => {
        const timer: any = setTimeout(resolve, AUTO_DISTILL_WAIT_MS)
        if (timer && typeof timer.unref === 'function') timer.unref()
      })
      return Promise.race([work, cap])
    } catch { return }
  })
}

