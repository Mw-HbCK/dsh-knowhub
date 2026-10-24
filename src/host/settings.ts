/**
 * 设置与诊断（M5）：把「两处部署可能不同」的值放进 settings 表，而不是硬编码。
 *
 * 覆盖项：默认模型策略、自动提炼开关与阈值、工作区排除目录、备份保留份数、破坏性操作前自动备份。
 * 存储位置单独处理：见 paths.ts 的迁移指针（迁移只切换指针，旧数据保留可回退）。
 */
import { userInfo } from 'node:os'
import { get, run, type Db } from './db/db.js'
import { recordReviewLog } from './review.js'
import { locationPointerFile, readLocationPointer, storageLocation } from './paths.js'

export const STRATEGIES = ['economy', 'balanced', 'quality'] as const
export type Strategy = (typeof STRATEGIES)[number]

export const SETTING_KEY = {
  defaultStrategy: 'knowhub.defaultStrategy',
  autoDistill: 'knowhub.autoDistill',
  distillMinChars: 'knowhub.distillMinChars',
  excludeDirs: 'knowhub.excludeDirs',
  backupKeep: 'knowhub.backupKeep',
  autoBackup: 'knowhub.autoBackup',
  autoApprove: 'knowhub.autoApprove',
  autoApproveMaxDiffLines: 'knowhub.autoApproveMaxDiffLines',
  reviewerName: 'knowhub.reviewerName',
  injectEnabled: 'knowhub.injectEnabled',
  injectMaxChars: 'knowhub.injectMaxChars',
  injectMaxTitles: 'knowhub.injectMaxTitles',
  injectIncludeUser: 'knowhub.injectIncludeUser',
  injectIncludeWorkspace: 'knowhub.injectIncludeWorkspace',
} as const

export interface KnowhubSettings {
  defaultStrategy: Strategy
  /** 自动提炼：默认关闭；关闭时只有手动入口会生成候选。 */
  autoDistill: boolean
  /** 自动提炼的最小文本长度，太短的小回合不浪费模型调用。 */
  distillMinChars: number
  /** 追加到默认排除名单的工作区目录名。 */
  excludeDirs: string[]
  /** 保留最近多少份备份。 */
  backupKeep: number
  /** 破坏性操作（恢复备份、删除知识库文件）前自动备份。 */
  autoBackup: boolean
  /** 自动批准低风险 wiki 更新：默认关闭，开启后仅满足严格规则的候选自动通过。 */
  autoApprove: boolean
  /** 自动批准允许的最大差异行数（新增+删除），默认 10。 */
  autoApproveMaxDiffLines: number
  /** 审核人名称：未显式传入 actor 时使用，默认取当前系统用户名。 */
  reviewerName: string
  /** 是否向 Agent 系统提示注入知识摘要（总开关）。 */
  injectEnabled: boolean
  /** 注入摘要的最大字符数（300–4000）。 */
  injectMaxChars: number
  /** 注入摘要里最多列出的已批准知识标题数（1–20）。 */
  injectMaxTitles: number
  /** 是否把用户级（跨工作区共享）知识纳入注入。 */
  injectIncludeUser: boolean
  /** 是否把当前工作区知识纳入注入。 */
  injectIncludeWorkspace: boolean
}

function defaultReviewerName(): string {
  try {
    const name = userInfo().username.trim()
    return name === '' ? 'web' : name
  } catch {
    return 'web'
  }
}

export const DEFAULT_SETTINGS: KnowhubSettings = {
  defaultStrategy: 'balanced',
  autoDistill: false,
  distillMinChars: 200,
  excludeDirs: [],
  backupKeep: 10,
  autoBackup: true,
  autoApprove: false,
  autoApproveMaxDiffLines: 10,
  reviewerName: defaultReviewerName(),
  injectEnabled: true,
  injectMaxChars: 900,
  injectMaxTitles: 6,
  injectIncludeUser: true,
  injectIncludeWorkspace: true,
}

export class SettingsError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

function readRaw(db: Db, key: string): unknown {
  const row = get<{ value?: string }>(db, 'SELECT value FROM settings WHERE key = ?', [key])
  if (!row?.value) return undefined
  try { return JSON.parse(row.value) } catch { return undefined }
}

function writeRaw(db: Db, key: string, value: unknown): void {
  run(db, 'INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, JSON.stringify(value), Date.now()])
}

export function readSettings(db: Db): KnowhubSettings {
  const strategy = readRaw(db, SETTING_KEY.defaultStrategy)
  const autoDistill = readRaw(db, SETTING_KEY.autoDistill)
  const minChars = readRaw(db, SETTING_KEY.distillMinChars)
  const exclude = readRaw(db, SETTING_KEY.excludeDirs)
  const keep = readRaw(db, SETTING_KEY.backupKeep)
  const autoBackup = readRaw(db, SETTING_KEY.autoBackup)
  const autoApprove = readRaw(db, SETTING_KEY.autoApprove)
  const autoApproveMaxDiffLines = readRaw(db, SETTING_KEY.autoApproveMaxDiffLines)
  const reviewerName = readRaw(db, SETTING_KEY.reviewerName)
  const injectEnabled = readRaw(db, SETTING_KEY.injectEnabled)
  const injectMaxChars = readRaw(db, SETTING_KEY.injectMaxChars)
  const injectMaxTitles = readRaw(db, SETTING_KEY.injectMaxTitles)
  const injectIncludeUser = readRaw(db, SETTING_KEY.injectIncludeUser)
  const injectIncludeWorkspace = readRaw(db, SETTING_KEY.injectIncludeWorkspace)
  return {
    defaultStrategy: STRATEGIES.includes(strategy as Strategy) ? (strategy as Strategy) : DEFAULT_SETTINGS.defaultStrategy,
    autoDistill: typeof autoDistill === 'boolean' ? autoDistill : DEFAULT_SETTINGS.autoDistill,
    distillMinChars: Number.isInteger(minChars) && (minChars as number) >= 80 && (minChars as number) <= 4000 ? (minChars as number) : DEFAULT_SETTINGS.distillMinChars,
    excludeDirs: Array.isArray(exclude) ? exclude.filter((item): item is string => typeof item === 'string').slice(0, 40) : DEFAULT_SETTINGS.excludeDirs,
    backupKeep: Number.isInteger(keep) && (keep as number) >= 1 && (keep as number) <= 50 ? (keep as number) : DEFAULT_SETTINGS.backupKeep,
    autoBackup: typeof autoBackup === 'boolean' ? autoBackup : DEFAULT_SETTINGS.autoBackup,
    autoApprove: typeof autoApprove === 'boolean' ? autoApprove : DEFAULT_SETTINGS.autoApprove,
    autoApproveMaxDiffLines: Number.isInteger(autoApproveMaxDiffLines) && (autoApproveMaxDiffLines as number) >= 1 && (autoApproveMaxDiffLines as number) <= 200 ? (autoApproveMaxDiffLines as number) : DEFAULT_SETTINGS.autoApproveMaxDiffLines,
    reviewerName: typeof reviewerName === 'string' && reviewerName.trim() !== '' ? reviewerName.trim().slice(0, 40) : DEFAULT_SETTINGS.reviewerName,
    injectEnabled: typeof injectEnabled === 'boolean' ? injectEnabled : DEFAULT_SETTINGS.injectEnabled,
    injectMaxChars: Number.isInteger(injectMaxChars) && (injectMaxChars as number) >= 300 && (injectMaxChars as number) <= 4000 ? (injectMaxChars as number) : DEFAULT_SETTINGS.injectMaxChars,
    injectMaxTitles: Number.isInteger(injectMaxTitles) && (injectMaxTitles as number) >= 1 && (injectMaxTitles as number) <= 20 ? (injectMaxTitles as number) : DEFAULT_SETTINGS.injectMaxTitles,
    injectIncludeUser: typeof injectIncludeUser === 'boolean' ? injectIncludeUser : DEFAULT_SETTINGS.injectIncludeUser,
    injectIncludeWorkspace: typeof injectIncludeWorkspace === 'boolean' ? injectIncludeWorkspace : DEFAULT_SETTINGS.injectIncludeWorkspace,
  }
}

export interface SettingsPatch {
  defaultStrategy?: unknown
  autoDistill?: unknown
  distillMinChars?: unknown
  excludeDirs?: unknown
  backupKeep?: unknown
  autoBackup?: unknown
  autoApprove?: unknown
  autoApproveMaxDiffLines?: unknown
  reviewerName?: unknown
  injectEnabled?: unknown
  injectMaxChars?: unknown
  injectMaxTitles?: unknown
  injectIncludeUser?: unknown
  injectIncludeWorkspace?: unknown
}

export function validateSettingsPatch(patch: SettingsPatch): Partial<KnowhubSettings> {
  const out: Partial<KnowhubSettings> = {}
  if (patch.defaultStrategy !== undefined) {
    const value = String(patch.defaultStrategy).trim()
    if (!STRATEGIES.includes(value as Strategy)) throw new SettingsError('SETTING_INVALID', 400, '默认模型策略必须是 economy / balanced / quality 之一')
    out.defaultStrategy = value as Strategy
  }
  const booleanLabels: Record<string, string> = {
    autoDistill: '自动提炼开关',
    autoBackup: '自动备份开关',
    autoApprove: '自动批准开关',
    injectEnabled: '知识注入开关',
    injectIncludeUser: '全局记忆注入开关',
    injectIncludeWorkspace: '项目记忆注入开关',
  }
  for (const key of ['autoDistill', 'autoBackup', 'autoApprove', 'injectEnabled', 'injectIncludeUser', 'injectIncludeWorkspace'] as const) {
    if (patch[key] === undefined) continue
    if (typeof patch[key] !== 'boolean') throw new SettingsError('SETTING_INVALID', 400, (booleanLabels[key] ?? key) + '必须是布尔值')
    out[key] = patch[key] as boolean
  }
  if (patch.distillMinChars !== undefined) {
    const value = Number(patch.distillMinChars)
    if (!Number.isInteger(value) || value < 80 || value > 4000) throw new SettingsError('SETTING_INVALID', 400, '自动提炼最小长度必须是 80–4000 之间的整数')
    out.distillMinChars = value
  }
  if (patch.autoApproveMaxDiffLines !== undefined) {
    const value = Number(patch.autoApproveMaxDiffLines)
    if (!Number.isInteger(value) || value < 1 || value > 200) throw new SettingsError('SETTING_INVALID', 400, '自动批准最大差异行数必须是 1–200 之间的整数')
    out.autoApproveMaxDiffLines = value
  }
  if (patch.reviewerName !== undefined) {
    const value = String(patch.reviewerName ?? '').trim()
    if (value === '') throw new SettingsError('SETTING_INVALID', 400, '审核人名称不能为空')
    if (value.length > 40) throw new SettingsError('SETTING_INVALID', 400, '审核人名称最多 40 个字符')
    out.reviewerName = value
  }
  if (patch.injectMaxChars !== undefined) {
    const value = Number(patch.injectMaxChars)
    if (!Number.isInteger(value) || value < 300 || value > 4000) throw new SettingsError('SETTING_INVALID', 400, '注入摘要字符数必须是 300–4000 之间的整数')
    out.injectMaxChars = value
  }
  if (patch.injectMaxTitles !== undefined) {
    const value = Number(patch.injectMaxTitles)
    if (!Number.isInteger(value) || value < 1 || value > 20) throw new SettingsError('SETTING_INVALID', 400, '注入摘要标题数必须是 1–20 之间的整数')
    out.injectMaxTitles = value
  }
  if (patch.backupKeep !== undefined) {
    const value = Number(patch.backupKeep)
    if (!Number.isInteger(value) || value < 1 || value > 50) throw new SettingsError('SETTING_INVALID', 400, '备份保留份数必须是 1–50 之间的整数')
    out.backupKeep = value
  }
  if (patch.excludeDirs !== undefined) {
    if (!Array.isArray(patch.excludeDirs)) throw new SettingsError('SETTING_INVALID', 400, '排除目录必须是字符串数组')
    const list: string[] = []
    for (const item of patch.excludeDirs) {
      const value = String(item ?? '').trim()
      if (value === '') continue
      if (value.length > 120) throw new SettingsError('SETTING_INVALID', 400, '单个排除目录名不能超过 120 个字符：' + value.slice(0, 40))
      if (/[\\/:*?"<>|]/.test(value) || value === '..' || value === '.') throw new SettingsError('SETTING_INVALID', 400, '排除目录只接受目录名，不能包含路径分隔符或 ..：' + value)
      if (!list.includes(value)) list.push(value)
    }
    if (list.length > 40) throw new SettingsError('SETTING_INVALID', 400, '排除目录最多 40 条')
    out.excludeDirs = list
  }
  return out
}

export function writeSettings(db: Db, patch: SettingsPatch, actor: string | null): { settings: KnowhubSettings; changed: string[] } {
  const valid = validateSettingsPatch(patch)
  const changed: string[] = []
  for (const [key, value] of Object.entries(valid)) {
    writeRaw(db, (SETTING_KEY as any)[key], value)
    changed.push(key)
  }
  if (changed.length > 0) {
    recordReviewLog(db, { action: 'settings_update', itemKind: 'settings', itemId: 'knowhub', actor, note: '修改设置：' + changed.join(', ') })
  }
  return { settings: readSettings(db), changed }
}

/** 设置页需要的完整快照：设置值 + 存储位置 + 指针文件（供诊断展示）。 */
export function settingsSnapshot(db: Db, config: any): any {
  const location = storageLocation(config)
  const settings = readSettings(db)
  return {
    settings,
    defaults: DEFAULT_SETTINGS,
    storage: {
      storageRoot: location.storageRoot,
      source: location.source,
      configStorageRoot: location.configStorageRoot,
      pointerFile: locationPointerFile(),
      pointerStorageRoot: readLocationPointer(),
      restartRequiredForPointerChange: true,
    },
    note: '自动提炼与自动批准默认关闭；关闭时只有面板/工具的手动入口会生成待审核候选。自动批准仅对满足规则的低风险 wiki 更新生效，并写入审核日志。知识注入默认开启，可按全局记忆/项目记忆分别关闭，并限制摘要字符数与标题数。',
  }
}