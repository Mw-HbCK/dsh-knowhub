/**
 * 知识质量检查（任务书 §8）：两层，默认只启用第一层。
 *
 * 第一层 规则质检（本文件 runQualityChecks）：零模型调用、纯本地检查——套话、
 * 段落重复、列表占比、空泛标题、正文提及文件与来源的一致性、交叉引用是否指向
 * 真实文档、memory 结构（适用范围/调用条件）、todo 状态行。结果只是给审核人的
 * 提示（qualityFlags），不拦截、不自动改写、不打分。
 *
 * 第二层 模型质检（runModelQualityCheck）：设置 qualityModelCheck 开启后才调用，
 * 检查清单见 prompts/quality.ts；同样只产出问题清单。
 */
import { run, type Db } from '../db/db.js'
import { type KbRow } from '../kb/store.js'
import { runModelCall } from '../model.js'
import { newId } from '../utils/id.js'
import { parseModelJson } from './model-output.js'
import { buildQualityCheckPrompt } from './prompts/quality.js'

export interface QualityCheckInput {
  title: string
  kind: string
  body: string
  sources: string[]
  /** 可交叉引用的真实文档标题集合（提供时才做引用检查）。 */
  siblingTitles?: string[]
}

/** 套话词表（与 L0 写作规则黑名单保持一致）。 */
const FILLER_PHRASES = ['综上所述', '在当今快速发展的', '核心要点如下', '赋能', '闭环', '体系化', '生态系统', '值得注意的是', '首先、其次、最后']
const VAGUE_TITLE_WORDS = ['深度解析', '深度剖析', '全面认识', '全面了解', '重要功能介绍', '系统核心优势', '技术实现的思考']

function charGrams(text: string, n: number): Set<string> {
  const grams = new Set<string>()
  const clean = text.replace(/\s+/g, '')
  for (let i = 0; i + n <= clean.length; i += 1) grams.add(clean.slice(i, i + n))
  return grams
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) if (b.has(item)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

const FILE_REF_PATTERN = /(?:^|[\s`'"（(])([A-Za-z0-9_.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|css|scss|yml|yaml|toml|sh|html))(?=$|[\s`'"）)，。；;:：])/g

export function runQualityChecks(input: QualityCheckInput): string[] {
  const flags: string[] = []
  const body = String(input.body ?? '')
  const title = String(input.title ?? '')

  // 1) 套话：同一词出现即提示（「值得注意的是」出现 2 次以上才算机械重复）。
  for (const phrase of FILLER_PHRASES) {
    const count = body.split(phrase).length - 1
    if (phrase === '值得注意的是' ? count >= 2 : count >= 1) {
      flags.push('套话检查：正文出现「' + phrase + '」' + (count > 1 ? ' ' + count + ' 次' : '') + '，请确认是否确有必要')
    }
  }

  // 2) 段落重复：段落间 3-gram Jaccard 相似度过高。
  const paragraphs = body.split(/\n\s*\n/).map((part) => part.trim()).filter((part) => part.length >= 30)
  const gramSets = paragraphs.map((part) => charGrams(part, 3))
  let duplicatePairs = 0
  for (let i = 0; i < paragraphs.length; i += 1) {
    for (let j = i + 1; j < paragraphs.length; j += 1) {
      if (jaccard(gramSets[i]!, gramSets[j]!) > 0.75) duplicatePairs += 1
    }
  }
  if (duplicatePairs > 0) flags.push('重复检查：有 ' + duplicatePairs + ' 组段落内容高度重复，请合并或删减')

  // 3) 列表占比：长文里列表行过半，通常是把自然语言拆碎了。
  const lines = body.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  if (body.length > 200 && lines.length >= 8) {
    const listLines = lines.filter((line) => /^[-*]\s/.test(line) || /^\d+[.)]\s/.test(line)).length
    if (listLines / lines.length > 0.6) flags.push('结构检查：列表行占正文 ' + Math.round((listLines / lines.length) * 100) + '%，能用自然段讲清的内容不要拆成列表')
  }

  // 4) 空泛标题。
  for (const word of VAGUE_TITLE_WORDS) {
    if (title.includes(word)) { flags.push('标题检查：标题含空泛表述「' + word + '」，请改用准确说明内容的标题'); break }
  }

  // 5) 来源一致性：正文提及的文件应出现在 sources 中。
  const sourceSet = new Set((input.sources ?? []).map((item) => String(item).replace(/^\.\//, '')))
  const mentioned = new Set<string>()
  for (const match of body.matchAll(FILE_REF_PATTERN)) {
    const ref = String(match[1]).replace(/^\.\//, '')
    if (!ref.includes('://')) mentioned.add(ref)
  }
  const uncovered = [...mentioned].filter((ref) => !sourceSet.has(ref)).slice(0, 3)
  if (uncovered.length > 0) flags.push('来源检查：正文提及但未列入来源的文件：' + uncovered.join('、'))

  // 6) 交叉引用：只许引用真实存在的文档标题。
  if (input.siblingTitles !== undefined) {
    const known = new Set(input.siblingTitles)
    const refs = new Set<string>()
    for (const match of body.matchAll(/《([^》]{2,60})》/g)) refs.add(String(match[1]))
    const broken = [...refs].filter((ref) => !known.has(ref) && ref !== title).slice(0, 3)
    if (broken.length > 0) flags.push('引用检查：正文引用了不存在的文档：《' + broken.join('》、《') + '》')
  }

  // 7) Memory 结构：核心记忆应带适用范围与调用条件。
  if (input.kind === 'memory') {
    const missing: string[] = []
    if (!body.includes('适用范围：') && !body.includes('适用范围:')) missing.push('适用范围')
    if (!body.includes('调用条件：') && !body.includes('调用条件:')) missing.push('调用条件')
    if (missing.length > 0) flags.push('记忆结构：缺少「' + missing.join('」「') + '」，核心记忆应写明适用范围与调用条件')
  }

  // 8) Todo 状态行：首行必须是状态标记。
  if (input.kind === 'todo') {
    const firstLine = lines[0] ?? ''
    if (!/^状态[:：](待处理|进行中|已阻塞|已完成|已取消)/.test(firstLine)) flags.push('待办结构：正文首行应为状态标记（如「状态：待处理」）')
  }

  return flags.slice(0, 8)
}

/** 模型质检（第二层）：返回问题清单；调用失败或输出不合法时返回空数组（质检不拖垮主流程）。 */
export async function runModelQualityCheck(ctx: any, db: Db, kb: KbRow, taskId: string, input: { title: string; kind: string; body: string }): Promise<string[]> {
  try {
    const result = await runModelCall(ctx, {
      provider: kb.modelProvider,
      model: kb.modelId,
      system: '你是严谨的知识质量检查员，只依据给定正文输出严格 JSON。',
      prompt: buildQualityCheckPrompt(input),
      maxTokens: 1200,
      temperature: 0.1,
      timeoutMs: 60000,
    })
    const usage = result.usage ?? {}
    run(db, 'INSERT INTO llm_calls (id, kb_id, task_id, provider, model, prompt_tokens, completion_tokens, latency_ms, finish_kind, failure_code, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      newId('llm'), kb.id, taskId, result.provider, result.model,
      typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
      typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
      result.elapsedMs, result.finishKind, result.failure ? String(result.failure.code) : null, 'quality-check', Date.now(),
    ])
    if (!result.ok) return []
    const output = parseModelJson(result.text, { finishKind: result.finishKind, maxTokens: 1200, attempt: 1, reasoningChars: result.reasoningChars })
    if (!output.ok || !Array.isArray(output.value?.issues)) return []
    return output.value.issues.map((item: any) => '模型质检：' + String(item).slice(0, 200)).filter((item: string) => item.length > 5).slice(0, 6)
  } catch {
    return []
  }
}
