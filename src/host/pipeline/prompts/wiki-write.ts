/**
 * L1 任务 Prompt：Repo Wiki 按篇写作（两段式生成的第二段）。
 *
 * 与旧版的区别：不再「每个主题恰好一篇、300-1200 字、先概述再小标题」的模板约束；
 * 改为按大纲逐篇（或同组多篇）生成，上下文是该篇证据文件的真实内容，并给出全库
 * 大纲清单供交叉引用——只许引用清单内真实存在的文档。写作指引按类型倾向给出
 * 「应回答的问题」，而不是固定小标题。
 */
import { writingRulesBlock } from './writing-rules.js'
import type { WikiPlanEntry } from './wiki-plan.js'

const ANGLE_GUIDES: Record<string, string> = {
  overview: '应讲清：这个项目解决什么问题、面向什么场景、核心能力是什么、如何启动或使用。',
  architecture: '应讲清：系统由哪些部分组成、各部分负责什么、模块之间如何通信、数据与控制流如何传递、有哪些外部依赖。',
  module: '应讲清：模块的作用与存在理由、在系统中的位置、主要输入输出、核心实现机制、与其他模块的关系、重要限制。引用真实文件路径与函数名。',
  workflow: '应讲清：入口在哪里、处理过程分哪几步、关键状态如何变化、数据如何流转、最终产生什么结果。',
  interface: '应讲清：接口的契约（输入、输出、错误）、调用方与实现方、数据结构的关键字段与约束。',
  data: '应讲清：数据结构/存储的组织方式、关键字段含义、读写路径、一致性与生命周期。',
  decision: '应讲清：决策的背景与约束、考虑过的方案、最终选择与原因、带来的取舍与影响；材料没有的字段写未记录，不要编造。',
  issue: '应讲清：问题现象、发生环境、影响范围、定位过程、已确认原因与解决方案、验证结果；未确认的原因不要写成结论。',
  general: '围绕本篇目的组织内容，结构服从内容本身。',
}

export function buildWikiWritePrompt(input: {
  entries: WikiPlanEntry[]
  outline: WikiPlanEntry[]
  evidenceText: string
  baseFacts: string
}): string {
  const groupLines = input.entries.map((entry) => {
    const guide = ANGLE_GUIDES[entry.angle] ?? ANGLE_GUIDES.general
    return '- 《' + entry.title + '》（类型倾向：' + entry.angle + '）目的：' + (entry.purpose || '（未说明）') + '\n  写作指引：' + guide
  })
  const outlineLines = input.outline.map((entry) => '- ' + entry.title + (entry.parentTitle ? '（上级：' + entry.parentTitle + '）' : '')).join('\n')
  return [
    '你是知枢 KnowHub 的项目文档作者。请只依据下面提供的材料，为大纲中的指定篇目撰写 Repo Wiki 文档。',
    ...writingRulesBlock(),
    '',
    '本轮要写的篇目（每篇都要写，标题与大纲一致）：',
    ...groupLines,
    '',
    '全库大纲（交叉引用时只能提及这里真实存在的篇目，用「见《标题》」的形式；不要引用大纲之外的文档）：',
    outlineLines,
    '',
    '写作要求：',
    '1. 篇幅由内容复杂度决定：简单主题几段即可，复杂主题可以分小标题展开；禁止为了凑字数扩写，也不强制总结段收尾。',
    '2. 优先使用下方「证据文件内容」中的真实代码与配置来支撑说明；证据不足的部分宁可少写并写入 uncertain。',
    '3. 父篇讲整体、子篇讲具体：与同组或大纲中其他篇目重叠的内容不要重复展开，用交叉引用带过。',
    '输出 JSON 结构：',
    '{"documents":[{"title":"与大纲一致的标题","kind":"wiki","tags":["标签"],"confidence":0.6,"sources":["相对路径"],"body":"Markdown 正文","uncertain":["待确认事项"]}]}',
    'kind 只能是 wiki：本轮只生成 Repo Wiki 文档。',
    '',
    '项目基本事实：',
    input.baseFacts,
    '',
    '证据文件内容：',
    input.evidenceText,
  ].join('\n')
}
