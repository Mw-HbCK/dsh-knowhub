/**
 * L1 任务 Prompt：Archify 图表 IR 生成与修复。
 *
 * 模型只负责产出符合 Archify Typed JSON IR Schema 的候选 JSON；校验、修复回路、
 * finalize 交付全部走 Archify 自带 CLI（见 pipeline/diagrams.ts），不得绕过。
 * 节点与关系必须来自文档与证据原文，不许为了好看编造组件。
 */

export function buildDiagramPrompt(input: {
  type: string
  docTitle: string
  docBody: string
  evidenceText: string
  schemaText: string
}): string {
  return [
    '你是知枢 KnowHub 的知识可视化助手。请为下面这篇文档生成一张 Archify「' + input.type + '」图的 JSON IR。',
    '只输出一个 JSON 对象，不要输出任何解释或 Markdown 围栏。输出必须严格符合给出的 JSON Schema（schema_version、diagram_type 等字段按 Schema 要求填写，diagram_type 必须是 "' + input.type + '"）。',
    '节点、分组与关系只能来自文档正文与证据材料：不得编造不存在的组件、接口或数据流；材料里没有把握的关系宁可不画。',
    '标签使用简体中文（文件/类/函数等专有名词保留原文）；标题（meta.title）用文档标题或其自然简称。',
    '',
    '文档标题：' + input.docTitle,
    '文档正文（节选）：',
    input.docBody.slice(0, 4000),
    '',
    '证据材料（节选）：',
    input.evidenceText.slice(0, 6000),
    '',
    'JSON Schema（' + input.type + '）：',
    input.schemaText.slice(0, 9000),
  ].join('\n')
}

/** 校验失败后的修复提示：把 Archify 校验器的诊断原文带回给模型，只修结构不改事实。 */
export function buildDiagramRepairPrompt(input: { type: string; candidateJson: string; diagnostics: string }): string {
  return [
    '你上一次输出的 Archify「' + input.type + '」图 JSON IR 没有通过官方校验器。请只修复校验指出的问题，不要改变图中的事实内容（节点、关系、标签含义保持不变）。',
    '只输出修复后的完整 JSON 对象，不要输出任何解释或 Markdown 围栏。',
    '',
    '校验诊断：',
    input.diagnostics.slice(0, 3000),
    '',
    '上次输出：',
    input.candidateJson.slice(0, 9000),
  ].join('\n')
}
