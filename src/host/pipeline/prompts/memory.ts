/**
* L1 任务 Prompt：长期记忆提炼（memory / preference，初始化记忆线）。
*
* Memory 面向未来 Agent 直接调用：正文除事实外必须带「适用范围」与「调用条件」
* 两行（核心记忆层的结构约定，质量检查会校验其存在性）。Preference 只记材料中
* 明确表达的偏好，禁止把推测写成用户偏好。保留「长期记忆」候选的任务表述。
*/
import { writingRulesBlock} from './writing-rules.js'

export function buildMemoryPrompt(topics: string[], context: string): string {
return [
'你是知枢 KnowHub 的长期记忆分析器。请只依据下面提供的仓库事实，提炼值得长期保存、跨会话复用的「长期记忆」候选。',
...writingRulesBlock(),
'',
'需要提炼的主题：' + topics.join('、'),
'kind 只能是 memory / preference 之一，两类分别遵循以下策略：',
'',
'只记长期有效、未来会被反复用到的事实：项目目标与背景、当前阶段与里程碑、稳定的技术事实、项目约束与边界。不记一次性细节和临时状态。每条正文结构固定为三部分：先用 2-5 句给出事实本身（先事实、再一句理由或来源说明），然后另起一行写「适用范围：用户级 / 项目级 / 具体工作区（三选一并说明）」，再另起一行写「调用条件：在什么场景下这条记忆应当被想起」。',
'只记录材料中明确表达出来的偏好与长期约定（文档明文、配置取值、反复出现的明确做法），并在正文中注明它出现在哪里。仅仅是你的推测、或只出现一次且语境不明的，不要写成偏好；拿不准就不要产出这一类。',
'',
'每个主题提炼 1-2 条。',
'输出 JSON 结构：',
'{"documents":[{"title":"记忆标题","kind":"memory","tags":["标签"],"confidence":0.6,"sources":["相对路径"],"body":"Markdown 正文","uncertain":["待确认事项"]}]}',
'',
'仓库事实：',
context,
].join('\n')
}
