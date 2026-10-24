/**
 * 模型适配层：只经 DSH 官方 llm 服务读取模型目录并按显式 {provider, model} 调用。
 * 事实依据（本机 0.2.1-rc.2 类型定义 dsh-llm/lib/types/index.d.ts、types/types.d.ts）：
 *   listProviders(): LlmProviderInfo[]（同步，注册顺序）      —— { id, name }
 *   listModels(provider): Promise<LlmModelInfo[]>            —— { provider, id, name, description?, inputModalities? }
 *   resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>
 *   stream(options: GenerateOptions): AsyncIterable<StreamChunk>
 * GenerateOptions: { provider, model, messages, system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }
 * StreamChunk: block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage | finish
 * finish.reason.kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'（error/aborted 带 failure）
 * 密钥由 DSH 的 adapter/credentials 管理，本插件不接触任何明文 API Key。
 */
import { errorMessage } from './http.js'

export interface ModelEntry {
  provider: string
  id: string
  name: string
  description: string | null
  inputModalities: string[] | null
}

export interface ModelCatalog {
  available: boolean
  error: string | null
  providers: Array<{ provider: string; name: string }>
  models: ModelEntry[]
  errors: string[]
}

export function getLlm(ctx: any): any {
  try {
    return ctx?.get?.('llm')
  } catch {
    return undefined
  }
}

export async function readModelCatalog(ctx: any): Promise<ModelCatalog> {
  const llm = getLlm(ctx)
  if (!llm) {
    return { available: false, error: 'llm 服务不可用（本 DSH 版本未提供或尚未初始化）', providers: [], models: [], errors: [] }
  }
  const providers: Array<{ provider: string; name: string }> = []
  const models: ModelEntry[] = []
  const errors: string[] = []
  let rawProviders: any[] = []
  try {
    rawProviders = llm.listProviders() ?? []
  } catch (error) {
    errors.push('listProviders() 失败：' + errorMessage(error))
  }
  for (const provider of rawProviders) {
    const providerId = String(provider?.id ?? '')
    if (providerId === '') continue
    providers.push({ provider: providerId, name: String(provider?.name ?? providerId) })
    try {
      const listed = await llm.listModels(providerId)
      for (const model of listed ?? []) {
        models.push({
          provider: String(model?.provider ?? providerId),
          id: String(model?.id ?? ''),
          name: String(model?.name ?? model?.id ?? ''),
          description: typeof model?.description === 'string' ? model.description : null,
          inputModalities: Array.isArray(model?.inputModalities) ? model.inputModalities.map(String) : null,
        })
      }
    } catch (error) {
      errors.push('listModels(' + providerId + ') 失败：' + errorMessage(error))
    }
  }
  return { available: true, error: null, providers, models, errors }
}

async function makeUserMessage(text: string): Promise<any> {
  // 优先用官方构造器（会补齐 MessageId 等品牌字段），失败时回退为等价字面量。
  try {
    const mod: any = await import('@deepseek-ai/dsh-llm')
    if (typeof mod?.createUserMessage === 'function') {
      return mod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    }
  } catch {
    // 官方构造器不可用时走回退路径
  }
  return {
    id: 'knowhub-probe-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

export interface ProbeInput {
  provider?: unknown
  model?: unknown
  prompt?: unknown
  maxTokens?: unknown
  timeoutMs?: unknown
}

export async function probeModel(ctx: any, input: ProbeInput): Promise<any> {
  const llm = getLlm(ctx)
  if (!llm) throw new Error('llm 服务不可用，无法执行模型探测')
  const provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (provider === '' || model === '') throw new Error('必须同时提供 provider 与 model')
  const prompt = typeof input.prompt === 'string' && input.prompt.trim() !== '' ? input.prompt.trim() : '请只回复两个字：收到'
  const maxTokens = typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) ? Math.max(1, Math.min(512, Math.trunc(input.maxTokens))) : 64
  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? Math.max(1000, Math.min(120000, Math.trunc(input.timeoutMs))) : 60000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  let text = ''
  let reasoningChars = 0
  let finishKind: string | null = null
  let failure: { code: string; message: string; status: number | null } | null = null
  let usage: any = null
  try {
    const stream = llm.stream({
      provider,
      model,
      system: '你是知枢 KnowHub 的 M0 诊断探测助手，只按用户要求回答。',
      messages: [await makeUserMessage(prompt)],
      maxTokens,
      temperature: 0,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      const type = chunk?.type
      if (type === 'text-delta') text += String(chunk.text ?? '')
      else if (type === 'reasoning-delta') reasoningChars += String(chunk.text ?? '').length
      else if (type === 'usage') usage = chunk.usage ?? null
      else if (type === 'finish') {
        const reason = chunk.reason ?? {}
        finishKind = typeof reason.kind === 'string' ? reason.kind : null
        if (reason.failure) {
          failure = {
            code: String(reason.failure.code ?? 'UNKNOWN'),
            message: String(reason.failure.message ?? ''),
            status: typeof reason.failure.status === 'number' ? reason.failure.status : null,
          }
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }

  return {
    requested: { provider, model },
    text,
    reasoningChars,
    finishKind,
    failure,
    usage,
    elapsedMs: Date.now() - started,
    ok: failure === null && (finishKind === 'stop' || finishKind === 'max-tokens'),
  }
}

export interface ModelCallInput {
  provider: string
  model: string
  system?: string
  prompt: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ModelCallResult {
  provider: string
  model: string
  text: string
  reasoningChars: number
  finishKind: string | null
  failure: { code: string; message: string; status: number | null } | null
  usage: any
  elapsedMs: number
  aborted: boolean
  ok: boolean
}

/**
 * 按显式 { provider, model } 做一次性模型调用（M2 初始化用）。
 * - 绝不回退到其它模型：provider/model 原样传下去，失败即 failure；
 * - 超时与任务取消都通过 AbortSignal 传递，finish.reason.kind === 'aborted' 时标记 aborted；
 * - 密钥由 DSH llm 适配器管理，本函数不接触明文凭据。
 */
export async function runModelCall(ctx: any, input: ModelCallInput): Promise<ModelCallResult> {
  const llm = getLlm(ctx)
  if (!llm) throw new Error('llm 服务不可用，无法调用模型')
  const provider = input.provider.trim()
  const model = input.model.trim()
  if (provider === '' || model === '') throw new Error('必须同时提供 provider 与 model')
  const maxTokens = typeof input.maxTokens === 'number' && Number.isFinite(input.maxTokens) ? Math.max(1, Math.min(8192, Math.trunc(input.maxTokens))) : 1200
  const timeoutMs = typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) ? Math.max(5000, Math.min(180000, Math.trunc(input.timeoutMs))) : 90000

  const controller = new AbortController()
  const onExternalAbort = () => controller.abort()
  if (input.signal) {
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  let text = ''
  let reasoningChars = 0
  let finishKind: string | null = null
  let failure: { code: string; message: string; status: number | null } | null = null
  let usage: any = null
  try {
    const stream = llm.stream({
      provider,
      model,
      ...(typeof input.system === 'string' && input.system !== '' ? { system: input.system } : {}),
      messages: [await makeUserMessage(input.prompt)],
      maxTokens,
      temperature: typeof input.temperature === 'number' ? input.temperature : 0.2,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      const type = chunk?.type
      if (type === 'text-delta') text += String(chunk.text ?? '')
      else if (type === 'reasoning-delta') reasoningChars += String(chunk.text ?? '').length
      else if (type === 'usage') usage = chunk.usage ?? null
      else if (type === 'finish') {
        const reason = chunk.reason ?? {}
        finishKind = typeof reason.kind === 'string' ? reason.kind : null
        if (reason.failure) {
          failure = {
            code: String(reason.failure.code ?? 'UNKNOWN'),
            message: String(reason.failure.message ?? ''),
            status: typeof reason.failure.status === 'number' ? reason.failure.status : null,
          }
        }
      }
    }
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onExternalAbort)
  }
  const aborted = finishKind === 'aborted' || (failure !== null && failure.code === 'ABORTED')
  return {
    provider,
    model,
    text,
    reasoningChars,
    finishKind,
    failure,
    usage,
    elapsedMs: Date.now() - started,
    aborted,
    ok: failure === null && (finishKind === 'stop' || finishKind === 'max-tokens'),
  }
}

