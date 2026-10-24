/**
 * 任务层：长耗时操作（项目初始化、后续增量更新）的任务记录、进度、日志、取消与重试。
 *
 * 存储：tasks / task_logs（SQLite）。运行期取消用进程内 AbortController 表。
 * 约束：
 * - 同一 idem_key 只允许一个 queued/running 任务（数据库部分唯一索引兜底，createTask 捕获冲突返回 duplicate）；
 * - 进度与阶段立即落库，前端 1.5s 轮询即可看到；
 * - 进程崩溃后残留的 queued/running 任务在首次访问时惰性标记为 failed / TASK_INTERRUPTED，避免永久“运行中”假象；
 * - 取消只 abort，不直接写库：由 runTask 统一收尾，避免竞态覆盖。
 */
import { all, get, run, type Db } from './db/db.js'
import { newId } from './utils/id.js'
import { errorMessage } from './http.js'

export const TASK_STATUS = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUS)[number]

export class TaskError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface TaskLogEntry {
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface TaskRow {
  id: string
  kbId: string
  kind: string
  status: TaskStatus
  progress: number
  stage: string | null
  idemKey: string
  attempt: number
  input: any
  errorCode: string | null
  errorDetail: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
  logs?: TaskLogEntry[]
}

function toTask(raw: any): TaskRow {
  let input: any = null
  if (typeof raw.input === 'string' && raw.input !== '') {
    try { input = JSON.parse(raw.input) } catch { input = null }
  }
  return {
    id: String(raw.id),
    kbId: String(raw.kb_id),
    kind: String(raw.kind),
    status: String(raw.status) as TaskStatus,
    progress: Number(raw.progress ?? 0),
    stage: raw.stage === null || raw.stage === undefined ? null : String(raw.stage),
    idemKey: String(raw.idem_key),
    attempt: Number(raw.attempt ?? 1),
    input,
    errorCode: raw.error_code === null || raw.error_code === undefined ? null : String(raw.error_code),
    errorDetail: raw.error_detail === null || raw.error_detail === undefined ? null : String(raw.error_detail),
    startedAt: raw.started_at === null || raw.started_at === undefined ? null : new Date(Number(raw.started_at)).toISOString(),
    finishedAt: raw.finished_at === null || raw.finished_at === undefined ? null : new Date(Number(raw.finished_at)).toISOString(),
    createdAt: new Date(Number(raw.created_at)).toISOString(),
  }
}

const SELECT = 'SELECT * FROM tasks WHERE id = ?'

function rowById(db: Db, id: string): TaskRow | null {
  const raw = get(db, SELECT, [id])
  return raw ? toTask(raw) : null
}

const controllers = new Map<string, AbortController>()
let interruptedRecovered = false

/** 进程重启后，把上次残留的 queued/running 任务标记为失败（惰性、只做一次）。 */
export function recoverInterruptedTasks(db: Db): void {
  if (interruptedRecovered) return
  interruptedRecovered = true
  run(
    db,
    "UPDATE tasks SET status = 'failed', error_code = 'TASK_INTERRUPTED', error_detail = ?, finished_at = ? WHERE status IN ('queued','running')",
    ['插件重启导致任务中断（可能原因：DSH 退出、插件重载）。请点击“重试”重新执行。', Date.now()],
  )
}

export function appendTaskLog(db: Db, taskId: string, level: 'info' | 'warn' | 'error', message: string): void {
  run(db, 'INSERT INTO task_logs (task_id, at, level, message) VALUES (?, ?, ?, ?)', [taskId, Date.now(), level, message.slice(0, 2000)])
}

export function listTaskLogs(db: Db, taskId: string, limit = 200): TaskLogEntry[] {
  const rows = all(db, 'SELECT at, level, message FROM task_logs WHERE task_id = ? ORDER BY id ASC LIMIT ?', [taskId, Math.max(1, Math.min(500, limit))])
  return rows.map((raw: any) => ({ at: Number(raw.at), level: String(raw.level) as any, message: String(raw.message) }))
}

export interface CreateTaskInput {
  kbId: string
  kind: string
  idemKey: string
  input?: any
}

export function createTask(db: Db, input: CreateTaskInput): { task: TaskRow; duplicate: boolean } {
  recoverInterruptedTasks(db)
  const existing = get(
    db,
    "SELECT * FROM tasks WHERE idem_key = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
    [input.idemKey],
  )
  if (existing) return { task: withLogs(db, toTask(existing)), duplicate: true }
  const id = newId('task')
  try {
    run(
      db,
      "INSERT INTO tasks (id, kb_id, kind, status, progress, stage, idem_key, input, attempt, created_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, 1, ?)",
      [id, input.kbId, input.kind, '排队中', input.idemKey, JSON.stringify(input.input ?? {}), Date.now()],
    )
  } catch (error) {
    const race = get(
      db,
      "SELECT * FROM tasks WHERE idem_key = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
      [input.idemKey],
    )
    if (race) return { task: withLogs(db, toTask(race)), duplicate: true }
    throw new TaskError('TASK_CREATE_FAILED', 500, '任务创建失败：' + errorMessage(error))
  }
  appendTaskLog(db, id, 'info', '任务已创建，等待执行')
  const created = rowById(db, id)
  if (!created) throw new TaskError('TASK_CREATE_FAILED', 500, '任务创建后无法读取')
  return { task: withLogs(db, created), duplicate: false }
}

/** 失败/取消任务的重试：沿用 idem_key，attempt + 1，返回新任务。 */
export function retryTask(db: Db, taskId: string): TaskRow {
  recoverInterruptedTasks(db)
  const previous = rowById(db, taskId)
  if (!previous) throw new TaskError('TASK_NOT_FOUND', 404, '任务不存在：' + taskId)
  if (previous.status === 'queued' || previous.status === 'running') {
    throw new TaskError('TASK_ALREADY_RUNNING', 409, '该任务正在执行，不能重试')
  }
  const id = newId('task')
  run(
    db,
    "INSERT INTO tasks (id, kb_id, kind, status, progress, stage, idem_key, input, attempt, created_at) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)",
    [id, previous.kbId, previous.kind, '排队中', previous.idemKey, JSON.stringify(previous.input ?? {}), previous.attempt + 1, Date.now()],
  )
  appendTaskLog(db, id, 'info', '重试任务已创建（第 ' + (previous.attempt + 1) + ' 次尝试，来源任务 ' + taskId + '）')
  const created = rowById(db, id)
  if (!created) throw new TaskError('TASK_CREATE_FAILED', 500, '任务创建后无法读取')
  return withLogs(db, created)
}

function withLogs(db: Db, task: TaskRow): TaskRow {
  return { ...task, logs: listTaskLogs(db, task.id, 100) }
}

export function getTask(db: Db, id: string): TaskRow | null {
  recoverInterruptedTasks(db)
  const task = rowById(db, id)
  return task ? withLogs(db, task) : null
}

export function listTasks(db: Db, kbId: string, limit = 20): TaskRow[] {
  recoverInterruptedTasks(db)
  const rows = all(db, 'SELECT * FROM tasks WHERE kb_id = ? ORDER BY created_at DESC LIMIT ?', [kbId, Math.max(1, Math.min(100, limit))])
  return rows.map((raw: any) => toTask(raw))
}

export interface TaskContext {
  signal: AbortSignal
  taskId: string
  progress: (percent: number, stage?: string) => void
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

/** 执行任务：统一状态流转 + 进度/日志/取消语义。executor 抛错即失败；abort 即取消。 */
export async function runTask(options: {
  db: Db
  taskId: string
  executor: (context: TaskContext) => Promise<any>
}): Promise<TaskRow> {
  const { db, taskId } = options
  const task = rowById(db, taskId)
  if (!task) throw new TaskError('TASK_NOT_FOUND', 404, '任务不存在：' + taskId)
  if (task.status !== 'queued') throw new TaskError('TASK_NOT_QUEUED', 409, '任务状态不是排队中，无法执行：' + task.status)
  const controller = new AbortController()
  controllers.set(taskId, controller)
  const startedAt = Date.now()
  run(db, "UPDATE tasks SET status = 'running', started_at = ?, stage = ?, progress = 0 WHERE id = ?", [startedAt, '启动中', taskId])
  const setProgress = (percent: number, stage?: string): void => {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    if (typeof stage === 'string' && stage !== '') {
      run(db, 'UPDATE tasks SET progress = ?, stage = ? WHERE id = ?', [clamped, stage, taskId])
    } else {
      run(db, 'UPDATE tasks SET progress = ? WHERE id = ?', [clamped, taskId])
    }
  }
  const context: TaskContext = {
    signal: controller.signal,
    taskId,
    progress: setProgress,
    log: (level, message) => {
      appendTaskLog(db, taskId, level, message)
      const prefix = level === 'error' ? '[错误] ' : level === 'warn' ? '[警告] ' : ''
      console.log('[knowhub][task ' + taskId + '] ' + prefix + message)
    },
  }
  try {
    const result = await options.executor(context)
    run(
      db,
      "UPDATE tasks SET status = 'succeeded', progress = 100, stage = '已完成', finished_at = ?, cursor = ? WHERE id = ?",
      [Date.now(), typeof result === 'object' && result !== null ? JSON.stringify(result).slice(0, 4000) : null, taskId],
    )
    appendTaskLog(db, taskId, 'info', '任务完成')
    return rowById(db, taskId) as TaskRow
  } catch (error) {
    if (controller.signal.aborted) {
      run(db, "UPDATE tasks SET status = 'cancelled', stage = '已取消', finished_at = ? WHERE id = ?", [Date.now(), taskId])
      appendTaskLog(db, taskId, 'warn', '任务已取消')
    } else {
      const code = error instanceof TaskError || (error as any)?.code ? String((error as any).code) : 'TASK_FAILED'
      const detail = errorMessage(error)
      run(
        db,
        "UPDATE tasks SET status = 'failed', stage = '失败', error_code = ?, error_detail = ?, finished_at = ? WHERE id = ?",
        [code, detail.slice(0, 4000), Date.now(), taskId],
      )
      appendTaskLog(db, taskId, 'error', '任务失败（' + code + '）：' + detail)
    }
    return rowById(db, taskId) as TaskRow
  } finally {
    controllers.delete(taskId)
  }
}

export function cancelTask(db: Db, taskId: string): TaskRow {
  const task = rowById(db, taskId)
  if (!task) throw new TaskError('TASK_NOT_FOUND', 404, '任务不存在：' + taskId)
  if (task.status !== 'queued' && task.status !== 'running') {
    throw new TaskError('TASK_NOT_RUNNING', 409, '任务当前状态为「' + task.status + '」，无需取消')
  }
  const controller = controllers.get(taskId)
  if (controller) controller.abort()
  else {
    // 进程内没有控制器（例如重启残留）：直接标记取消
    run(db, "UPDATE tasks SET status = 'cancelled', stage = '已取消', finished_at = ? WHERE id = ?", [Date.now(), taskId])
    appendTaskLog(db, taskId, 'warn', '任务已取消（无运行中执行器）')
  }
  return rowById(db, taskId) as TaskRow
}
