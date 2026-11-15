/**
 * L1 任务 Prompt：知识质量检查（模型质检，默认关闭，设置开启后才调用）。
 *
 * 检查清单来自任务书 §8：只输出问题清单，不改写正文、不创造新事实、不打分设门槛。
 * 规则质检（零调用）见 pipeline/quality.ts，两者结果合并后附在候选的审核信息里。
 */

export function buildQualityCheckPrompt(input: { title: string; kind: string; body: string }): string {
  const wikiChecks = [
    '是否准确表达主题、是否有明确信息价值',
    '是否存在大量重复或空泛表达、是否有不必要的章节',
    '解释是否充分、是否符合技术文档的阅读习惯',
    '是否与正文自述的来源一致、是否存在编造内容',
    '父子关系与交叉引用是否合理（引用了不存在的文档也算问题）',
  ]
  const memoryChecks = [
    '是否值得长期保留、能否被未来 Agent 直接使用',
    '是否与常识或其他记忆明显重复或冲突',
    '是否有明确作用域与有效来源、是否已经过时',
    '是否包含不必要的描述、是否把推断当作事实陈述',
  ]
  const checks = input.kind === 'wiki' ? wikiChecks : input.kind === 'memory' || input.kind === 'preference' ? memoryChecks : [...wikiChecks.slice(0, 3), ...memoryChecks.slice(2)]
  return [
    '你是知枢 KnowHub 的知识质量检查员。请只依据下面这篇知识正文做质量检查，不要改写它，也不要补充任何新事实。',
    '逐项检查：',
    ...checks.map((item, index) => (index + 1) + '. ' + item),
    '只输出一个 JSON 对象：{"issues":["问题一","问题二"]}。每条问题一句话、指出具体位置或段落主题；没有问题时输出 {"issues":[]}。不要给分数，不要输出 JSON 之外的文字。',
    '',
    '知识类型：' + input.kind,
    '标题：' + input.title,
    '正文：',
    input.body.slice(0, 6000),
  ].join('\n')
}
