/**
 * 模型输出解析与「输出被截断」诊断（0.8.7）。
 *
 * 背景：推理模型会把 token 预算耗在思考过程上，finish_kind = max-tokens 时正文还没开始写，
 * 之前统一报「模型输出中没有 JSON 对象」，既看不出是预算不足，也没有自动补救的机会。
 * 这里把「截断」识别出来，让流水线可以加倍预算重试一次，并把可操作的建议写进错误信息。
 */

export interface ModelOutputMeta {
  finishKind: string | null
  maxTokens: number
  attempt: number
  reasoningChars?: number
}

export type ModelOutputResult =
  | { ok: true; value: any }
  | { ok: false; code: 'MODEL_OUTPUT_TRUNCATED' | 'MODEL_OUTPUT_INVALID'; message: string; truncated: boolean }

/** 每个生成步骤最多尝试次数（首次 + 截断后加倍预算重试一次）。 */
export const MAX_OUTPUT_ATTEMPTS = 2

export function isTruncatedModelOutput(meta: { finishKind: string | null }): boolean {
  return meta.finishKind === 'max-tokens'
}

/** 截断重试时的预算：翻倍，但不超过 runModelCall 的上限 8192。 */
export function retryTokenBudget(maxTokens: number): number {
  const base = Number.isFinite(maxTokens) ? Math.max(1, Math.trunc(maxTokens)) : 1
  return Math.min(8192, base * 2)
}

function compactHead(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact === '') return '（空输出）'
  return compact.slice(0, 120)
}

function truncationMessage(meta: ModelOutputMeta, textLength: number, detail: string | null): string {
  const thinking = typeof meta.reasoningChars === 'number' && meta.reasoningChars > 0 ? '，其中思考过程 ' + meta.reasoningChars + ' 字符' : ''
  const suffix = detail === null ? '' : '（' + detail + '）'
  return '模型输出被截断：达到 ' + meta.maxTokens + ' tokens 上限（finish=max-tokens，输出 ' + textLength + ' 字符' + thinking + suffix + '），没有产出完整 JSON。'
    + '请在「编辑配置」里换用非推理模型（可先点「测试模型」确认可用），或把「模型使用策略」调高后重试。'
}

/**
 * 解析模型输出里的第一个 JSON 对象。
 * - 允许 Markdown 代码围栏与前后解释文字；
 * - 输出被截断（finish=max-tokens）时返回 MODEL_OUTPUT_TRUNCATED，调用方可以加倍预算重试；
 * - 其它情况返回 MODEL_OUTPUT_INVALID，并带上输出开头方便排查。
 */
export function parseModelJson(text: string, meta: ModelOutputMeta): ModelOutputResult {
  const raw = typeof text === 'string' ? text : ''
  let cleaned = raw.trim()
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) cleaned = fence[1].trim()
  const truncated = isTruncatedModelOutput(meta)
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first < 0 || last <= first) {
    if (truncated) return { ok: false, code: 'MODEL_OUTPUT_TRUNCATED', truncated: true, message: truncationMessage(meta, raw.length, null) }
    return {
      ok: false,
      code: 'MODEL_OUTPUT_INVALID',
      truncated: false,
      message: '模型输出中没有 JSON 对象（finish=' + String(meta.finishKind ?? '未知') + '，输出 ' + raw.length + ' 字符）：' + compactHead(raw),
    }
  }
  try {
    return { ok: true, value: JSON.parse(cleaned.slice(first, last + 1)) }
  } catch (error: any) {
    const detail = 'JSON 解析失败：' + String(error instanceof Error ? error.message : error)
    if (truncated) return { ok: false, code: 'MODEL_OUTPUT_TRUNCATED', truncated: true, message: truncationMessage(meta, raw.length, detail) }
    return { ok: false, code: 'MODEL_OUTPUT_INVALID', truncated: false, message: '模型输出的 ' + detail }
  }
}
