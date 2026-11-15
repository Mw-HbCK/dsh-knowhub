/**
 * L1 任务 Prompt：Repo Wiki 结构规划（两段式生成的第一段）。
 *
 * 取代旧的写死主题表：先让模型依据项目实际产出一份文档大纲（篇目、目的、类型倾向、
 * 证据文件、父篇），经代码校验后才进入按篇生成。大纲决定整库结构，因此这里的规则
 * 强调「按项目实际增减合并、不得凑数」；参考结构只是启发，不是模板。
 */
import { writingRulesBlock } from './writing-rules.js'
import { slugify } from '../../search.js'

export const WIKI_ANGLES = ['overview', 'architecture', 'module', 'workflow', 'interface', 'data', 'decision', 'issue', 'general'] as const
export type WikiAngle = (typeof WIKI_ANGLES)[number]

export interface DiagramBrief {
  type: string
  reason: string
  sources: string[]
}

export interface WikiPlanEntry {
  title: string
  purpose: string
  angle: WikiAngle
  evidence: string[]
  parentTitle: string | null
  /** 可选图表简报：仅当图示能显著帮助理解时给出（架构/流程/数据流等），多数篇目应为 null。 */
  diagram: DiagramBrief | null
}

export function buildWikiPlanPrompt(context: string, maxDocs: number): string {
  return [
    '你是知枢 KnowHub 的项目文档结构规划师。请只依据下面提供的仓库事实，为这个项目规划 Repo Wiki 的文档大纲（本轮只做规划，不写正文）。',
    ...writingRulesBlock(),
    '',
    '规划要求：',
    '1. 大纲必须贴合这个项目本身的规模与结构：小项目可以只有 2-3 篇；复杂项目才拆分更多篇目。不要套用固定目录，不要为了凑满篇数而拆分或编造主题。',
    '2. 可以参考但不要照搬这些常见篇目：项目总览（解决什么问题、面向什么场景、核心能力、如何启动）、系统架构（组成部分与关系、数据与控制流、外部依赖）、核心模块（职责、机制、依赖）、工作流程（入口、处理过程、状态变化）、关键接口与数据结构、技术决策、真实问题与经验。项目没有的内容就不要规划。',
    '3. 每篇给出：title（准确具体的标题）、purpose（一句话说明这篇要让读者理解什么）、angle（从 ' + WIKI_ANGLES.join(' / ') + ' 中选最贴切的一个）、evidence（支撑这篇的文件相对路径，只能用下方材料中真实存在的路径）、parent（父篇标题或 null）。',
    '4. 父级负责整体、子级负责具体问题；层级最多两层；不要让多篇重复覆盖同一内容——重叠时合并为一篇。',
    '5. 总篇数不超过 ' + maxDocs + ' 篇。',
    '6. 图表简报（可选，多数篇目不需要）：只有当这一篇讲的是系统架构、复杂模块依赖、多阶段流程、数据流、多组件交互或明显层级结构时，才给出 diagram：type 从 architecture / workflow / sequence / dataflow / lifecycle / erd / tree / class / timeline / waterfall 中选最贴切的一个，reason 一句话说明图示价值，sources 填画图依据的文件（必须是该篇 evidence 的子集）。简短概念、单个参数、内容很少的篇目不要给 diagram，不要为了数量硬画。',
    '输出 JSON 结构：',
    '{"documents":[{"title":"文档标题","purpose":"一句话目的","angle":"module","evidence":["相对路径"],"parent":null,"diagram":null}]}。需要图表时 diagram 填 {"type":"architecture","reason":"一句话理由","sources":["相对路径"]}。',
    '',
    '仓库事实：',
    context,
  ].join('\n')
}

/**
 * 校验并规整规划输出：标题去重、证据过滤到索引内文件、父篇必须指向大纲内的另一篇、
 * 父子不成环、层级压平到两层、按父先子后的拓扑序返回。返回条目与被丢弃条目的原因。
 */
/** 支持自动生成的图表类型（与捆绑 Archify 的 schemas 对齐；explainer 是长文图文，不作文档图表）。 */
export const DIAGRAM_TYPES = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle', 'erd', 'tree', 'class', 'timeline', 'waterfall'] as const

/** 校验图表简报：类型合法、理由非空、来源必须是该篇证据的子集；不合格返回 null（不画图）。 */
export function parseDiagramBrief(raw: unknown, evidence: string[]): DiagramBrief | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as any
  const type = String(record.type ?? '')
  if (!(DIAGRAM_TYPES as readonly string[]).includes(type)) return null
  const reason = String(record.reason ?? '').trim().slice(0, 120)
  if (reason === '') return null
  const evidenceSet = new Set(evidence)
  const sources: string[] = []
  if (Array.isArray(record.sources)) {
    for (const ref of record.sources) {
      const path = String(ref ?? '').trim().replace(/^\.\//, '')
      if (path !== '' && evidenceSet.has(path) && !sources.includes(path)) sources.push(path)
      if (sources.length >= 8) break
    }
  }
  return { type, reason, sources: sources.length > 0 ? sources : evidence.slice(0, 8) }
}

export function parseWikiPlan(raw: any, knownPaths: Set<string>, maxDocs: number): { entries: WikiPlanEntry[]; dropped: string[] } {
  const dropped: string[] = []
  const list = Array.isArray(raw?.documents) ? raw.documents : []
  const bySlug = new Map<string, WikiPlanEntry>()
  for (const item of list) {
    const title = typeof item?.title === 'string' ? item.title.trim() : ''
    if (title === '' || title.length > 120) { dropped.push('标题为空或过长，已丢弃一篇规划'); continue }
    const slug = slugify(title)
    if (bySlug.has(slug)) { dropped.push('规划标题重复，已合并：' + title); continue }
    const angleRaw = typeof item?.angle === 'string' ? item.angle.trim() : 'general'
    const angle = (WIKI_ANGLES as readonly string[]).includes(angleRaw) ? (angleRaw as WikiAngle) : 'general'
    const evidenceRaw = Array.isArray(item?.evidence) ? item.evidence.map((value: any) => String(value).replace(/^\.\//, '').trim()) : []
    const evidence = evidenceRaw.filter((path: string) => knownPaths.has(path)).slice(0, 12)
    const purpose = typeof item?.purpose === 'string' ? item.purpose.trim().slice(0, 300) : ''
    const parentTitle = typeof item?.parent === 'string' && item.parent.trim() !== '' ? item.parent.trim() : null
    bySlug.set(slug, { title, purpose, angle, evidence, parentTitle, diagram: parseDiagramBrief((item as any)?.diagram, evidence) })
    if (bySlug.size >= maxDocs) break
  }
  // 父篇规整：父篇必须在大纲内且不是自身；随后按拓扑序输出并压平到两层。
  const entries: WikiPlanEntry[] = []
  const placed = new Set<string>()
  const pending = [...bySlug.values()]
  for (const entry of pending) {
    if (entry.parentTitle !== null) {
      const parentSlug = slugify(entry.parentTitle)
      if (!bySlug.has(parentSlug) || parentSlug === slugify(entry.title)) entry.parentTitle = null
      else entry.parentTitle = bySlug.get(parentSlug)!.title
    }
  }
  let guard = 0
  while (pending.length > 0 && guard < 100) {
    guard += 1
    const index = pending.findIndex((entry) => entry.parentTitle === null || placed.has(slugify(entry.parentTitle)))
    if (index < 0) {
      // 剩余条目成环：断开一篇的父关系后继续。
      pending[0]!.parentTitle = null
      continue
    }
    const [entry] = pending.splice(index, 1)
    // 压平：父篇若本身有父篇，本篇直接挂到根（最多两层）。
    if (entry!.parentTitle !== null) {
      const parent = bySlug.get(slugify(entry!.parentTitle))
      if (parent && parent.parentTitle !== null) entry!.parentTitle = null
    }
    placed.add(slugify(entry!.title))
    entries.push(entry!)
  }
  for (const leftover of pending) { leftover.parentTitle = null; entries.push(leftover) }
  return { entries, dropped }
}
