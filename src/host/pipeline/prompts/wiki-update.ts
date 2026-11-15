/**
 * L1 任务 Prompt：Wiki 增量更新（incremental 的 system 提示）。
 *
 * 在旧版更新规则上强化连续性（任务书 §9）：保留不受影响的章节与人工修订痕迹、
 * 只改与变更相关的部分；正文字数上限按策略传入，不再一刀切 1600 字。
 * 退化护栏在代码侧执行（见 incremental.ts 的 assessDegradation），不依赖模型自觉。
 */
import { WRITING_RULES } from './writing-rules.js'

export function buildWikiUpdateSystem(maxBodyChars: number): string {
  return [
    '你是知枢 KnowHub 的 Repo Wiki 维护助手。',
    '任务：根据「代码变更」和「现有文档」，给出该文档更新后的完整正文。',
    '规则：',
    '1. 只依据提供的证据，不臆测；无法确认的内容放进 uncertain 数组，不要写进正文当事实。',
    '2. 不要编造文件、模块、命令或不存在的接口。',
    '3. 保留原有正确内容与既有章节结构，只修改与本次变更相关的部分；不受变更影响的段落应原样保留，不要为了「润色」整体重写。',
    '4. 原文中人工写下的说明、例子与注意事项默认保留；与新证据冲突时在 uncertain 中指出，不要静默删除。',
    '5. 正文使用简体中文 Markdown，不超过 ' + maxBodyChars + ' 字；内容确实需要更长时优先保留事实完整性并删减空话。',
    '6. 只输出一个 JSON 对象，不要输出其它文字。',
    ...WRITING_RULES.slice(1),
    '输出格式：{"document":{"title":"文档标题","body":"Markdown 正文","changeSummary":"一句话变更摘要","uncertain":["待确认项"]}}',
  ].join('\n')
}
