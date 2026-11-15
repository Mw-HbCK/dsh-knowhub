/**
 * Archify 深度集成（任务书 §7）：知识生产流程内的图表生成与关联。
 *
 * 流程：图表简报（大纲规划产出，或面板手动指定）→ 模型按 Archify Typed JSON IR
 * Schema 产出候选 → 写入工作区 .archify/knowhub-<slug>-<日期>/candidate.json →
 * 调用捆绑 Archify CLI `validate --json` 校验 → 诊断回喂模型修复（≤2 次）→
 * `finalize` 交付 HTML → doc_diagrams 记录关联（文档版本 + 来源哈希）。
 * 全程不绕过 Archify 校验；任何一步失败只记录失败，绝不拖垮知识生成主流程。
 * 图表产物保存在工作区 .archify/ 下（与技能手动生成的产物同域），知识库只存关联。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { all, get, run, type Db } from '../db/db.js'
import { type KbRow } from '../kb/store.js'
import { getDocument, slugify, type DocRow } from '../search.js'
import { runModelCall } from '../model.js'
import { createTask, runTask, type TaskRow } from '../tasks.js'
import { listWorkspaces } from '../workspace.js'
import { newId } from '../utils/id.js'
import { parseModelJson } from './model-output.js'
import { DIAGRAM_TYPES } from './prompts/wiki-plan.js'
import { buildDiagramPrompt, buildDiagramRepairPrompt } from './prompts/diagram.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
export const ARCHIFY_DIR = join(PACKAGE_ROOT, 'skills', 'archify')
export const ARCHIFY_CLI = join(ARCHIFY_DIR, 'bin', 'archify.mjs')
const MAX_REPAIRS = 2

export interface DocDiagram {
  id: string
  docId: string
  kbId: string
  type: string
  title: string
  candidatePath: string
  htmlPath: string
  sources: string[]
  docVersion: number
  status: string
  createdAt: number
  updatedAt: number
}

function toDiagram(raw: any): DocDiagram {
  let sources: string[] = []
  try { const parsed = JSON.parse(String(raw.sources ?? '[]')); if (Array.isArray(parsed)) sources = parsed.map(String) } catch { /* ignore */ }
  return {
    id: String(raw.id), docId: String(raw.doc_id), kbId: String(raw.kb_id), type: String(raw.type),
    title: String(raw.title ?? ''), candidatePath: String(raw.candidate_path ?? ''), htmlPath: String(raw.html_path ?? ''),
    sources, docVersion: Number(raw.doc_version ?? 1), status: String(raw.status),
    createdAt: Number(raw.created_at ?? 0), updatedAt: Number(raw.updated_at ?? 0),
  }
}

export function listDocDiagrams(db: Db, docId: string): DocDiagram[] {
  return all(db, 'SELECT * FROM doc_diagrams WHERE doc_id = ? ORDER BY created_at DESC', [docId]).map(toDiagram)
}

export function getDiagram(db: Db, id: string): DocDiagram | null {
  const raw = get(db, 'SELECT * FROM doc_diagrams WHERE id = ?', [id])
  return raw ? toDiagram(raw) : null
}

/** 删除图表关联（只删关联记录，.archify 下的产物文件保留）。 */
export function deleteDiagramAssociation(db: Db, id: string): boolean {
  const before = getDiagram(db, id)
  if (!before) return false
  run(db, 'DELETE FROM doc_diagrams WHERE id = ?', [id])
  return true
}

/** 来源文件变更时把受影响的 current 图表标记为 stale（增量流水线调用）。 */
export function markStaleDiagramsForChanges(db: Db, kbId: string, changedPaths: string[]): number {
  if (changedPaths.length === 0) return 0
  const changed = new Set(changedPaths)
  const rows = all(db, "SELECT * FROM doc_diagrams WHERE kb_id = ? AND status = 'current'", [kbId]).map(toDiagram)
  let marked = 0
  for (const diagram of rows) {
    if (diagram.sources.some((source) => changed.has(source))) {
      run(db, "UPDATE doc_diagrams SET status = 'stale', updated_at = ? WHERE id = ?", [Date.now(), diagram.id])
      marked += 1
    }
  }
  return marked
}

/** 解析图表 HTML 的绝对路径，并保证落在该知识库工作区内（防路径穿越）。 */
export async function resolveDiagramHtmlAbs(ctx: any, db: Db, diagram: DocDiagram): Promise<string | null> {
  if (diagram.htmlPath === '') return null
  const kb = get<any>(db, 'SELECT workspace_id FROM knowledge_bases WHERE id = ?', [diagram.kbId])
  const workspaceId = kb?.workspace_id ? String(kb.workspace_id) : ''
  if (workspaceId === '') return null
  const listed = await listWorkspaces(ctx)
  const workspace = listed.workspaces.find((item: any) => item.id === workspaceId)
  if (!workspace || workspace.pathState === 'missing') return null
  const root = resolve(workspace.path)
  const target = resolve(root, diagram.htmlPath)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

function runArchifyCli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [ARCHIFY_CLI, ...args], { cwd, timeout: 90000, maxBuffer: 8 * 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
      resolvePromise({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function recordDiagramCall(db: Db, kb: KbRow, taskId: string, doc: DocRow, result: any): void {
  const usage = result.usage ?? {}
  run(db, 'INSERT INTO llm_calls (id, kb_id, task_id, provider, model, prompt_tokens, completion_tokens, latency_ms, finish_kind, failure_code, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    newId('llm'), kb.id, taskId, result.provider, result.model,
    typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
    typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
    result.elapsedMs, result.finishKind, result.failure ? String(result.failure.code) : null, 'diagram:' + doc.slug, Date.now(),
  ])
}

async function readFilesText(root: string, paths: string[], capChars: number): Promise<string> {
  const parts: string[] = []
  let used = 0
  for (const path of paths) {
    if (used >= capChars) break
    try {
      const target = resolve(root, path)
      if (!target.startsWith(resolve(root) + sep)) continue
      const raw = await fs.readFile(target, 'utf8')
      const text = raw.slice(0, 3000)
      parts.push('--- ' + path + ' ---\n' + text)
      used += text.length
    } catch { /* 读不到的证据跳过 */ }
  }
  return parts.join('\n\n')
}

async function hashSources(root: string, sources: string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const source of sources) {
    hash.update(source + '\n')
    try {
      const raw = await fs.readFile(resolve(root, source))
      hash.update(raw.subarray(0, 512 * 1024))
    } catch { hash.update('<missing>') }
    hash.update('\n')
  }
  return hash.digest('hex').slice(0, 32)
}

export interface DiagramGenerateInput {
  doc: DocRow
  type: string
  sources: string[]
  workspaceRoot: string
  evidenceText: string
  taskId: string
}

export interface DiagramGenerateResult {
  ok: boolean
  diagramId?: string
  error?: string
  attempts: number
}

/** 为一篇文档生成一张图表并落关联。全程不抛异常：失败以 { ok:false, error } 返回。 */
export async function generateDiagramForDoc(ctx: any, db: Db, kb: KbRow, input: DiagramGenerateInput): Promise<DiagramGenerateResult> {
  const { doc, workspaceRoot } = input
  let attempts = 0
  try {
    if (!(DIAGRAM_TYPES as readonly string[]).includes(input.type)) {
      return { ok: false, error: '不支持的图表类型：' + input.type, attempts }
    }
    const schemaText = await fs.readFile(join(ARCHIFY_DIR, 'schemas', input.type + '.schema.json'), 'utf8').catch(() => '')
    if (schemaText === '') return { ok: false, error: '找不到 Archify 图表 Schema：' + input.type, attempts }

    // 1) 模型产出 IR 候选（截断时加倍预算重试一次，与其他流水线一致）。
    let budget = 8000
    let candidate: any = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await runModelCall(ctx, {
        provider: kb.modelProvider, model: kb.modelId,
        system: '你是严谨的知识可视化助手，只输出严格符合 Schema 的 JSON，不编造事实。',
        prompt: buildDiagramPrompt({ type: input.type, docTitle: doc.title, docBody: doc.body, evidenceText: input.evidenceText, schemaText }),
        maxTokens: budget, temperature: 0.1, timeoutMs: 120000,
      })
      recordDiagramCall(db, kb, input.taskId, doc, result)
      attempts += 1
      if (!result.ok) return { ok: false, error: '模型调用失败：' + (result.failure ? String(result.failure.code) + ' ' + String(result.failure.message) : '未知错误'), attempts }
      const output = parseModelJson(result.text, { finishKind: result.finishKind, maxTokens: budget, attempt, reasoningChars: result.reasoningChars })
      if (output.ok) { candidate = output.value; break }
      if (output.truncated && attempt < 2) { budget *= 2; continue }
      return { ok: false, error: '模型输出不是合法 JSON：' + output.message, attempts }
    }
    if (candidate === null) return { ok: false, error: '模型未产出图表候选', attempts }

    // 2) 候选落盘到工作区 .archify/knowhub-<slug>-<日期>/。
    const date = new Date()
    const stamp = String(date.getFullYear()) + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0')
    const relDir = '.archify/knowhub-' + (doc.slug || slugify(doc.title)) + '-' + stamp
    const absDir = join(workspaceRoot, relDir)
    await fs.mkdir(absDir, { recursive: true })
    const candidateRel = relDir + '/candidate.json'
    const htmlRel = relDir + '/diagram.html'
    const candidateAbs = join(workspaceRoot, candidateRel)
    const htmlAbs = join(workspaceRoot, htmlRel)
    await fs.writeFile(candidateAbs, JSON.stringify(candidate, null, 2), 'utf8')

    // 3) Archify 校验 → 诊断回喂修复（≤2 次）→ finalize 交付。
    let validated = false
    for (let round = 0; round <= MAX_REPAIRS; round += 1) {
      const check = await runArchifyCli(['validate', input.type, candidateAbs, '--json'], workspaceRoot)
      if (check.code === 0) { validated = true; break }
      if (round === MAX_REPAIRS) {
        return { ok: false, error: 'Archify 校验未通过（已修复 ' + MAX_REPAIRS + ' 次）：' + (check.stdout || check.stderr).slice(0, 300), attempts }
      }
      const repair = await runModelCall(ctx, {
        provider: kb.modelProvider, model: kb.modelId,
        system: '你是严谨的知识可视化助手，只输出修复后的完整 JSON，不改变事实内容。',
        prompt: buildDiagramRepairPrompt({ type: input.type, candidateJson: JSON.stringify(candidate), diagnostics: (check.stdout || check.stderr).slice(0, 3000) }),
        maxTokens: 8000, temperature: 0.1, timeoutMs: 120000,
      })
      recordDiagramCall(db, kb, input.taskId, doc, repair)
      attempts += 1
      if (!repair.ok) return { ok: false, error: '图表修复调用失败：' + (repair.failure ? String(repair.failure.message) : '未知错误'), attempts }
      const output = parseModelJson(repair.text, { finishKind: repair.finishKind, maxTokens: 8000, attempt: 1, reasoningChars: repair.reasoningChars })
      if (!output.ok) return { ok: false, error: '修复输出不是合法 JSON：' + output.message, attempts }
      candidate = output.value
      await fs.writeFile(candidateAbs, JSON.stringify(candidate, null, 2), 'utf8')
    }
    if (!validated) return { ok: false, error: 'Archify 校验未通过', attempts }
    const delivered = await runArchifyCli(['finalize', input.type, candidateAbs, htmlAbs, '--json'], workspaceRoot)
    if (delivered.code !== 0) {
      return { ok: false, error: 'Archify finalize 失败：' + (delivered.stdout || delivered.stderr).slice(0, 300), attempts }
    }
    const stat = await fs.stat(htmlAbs).catch(() => null)
    if (!stat || !stat.isFile()) return { ok: false, error: 'Archify finalize 未产出 HTML 文件', attempts }

    // 4) 关联落库：同文档同类型的旧 current 图表标记 superseded（产物文件保留在各自目录）。
    const now = Date.now()
    run(db, "UPDATE doc_diagrams SET status = 'superseded', updated_at = ? WHERE doc_id = ? AND type = ? AND status = 'current'", [now, doc.id, input.type])
    const id = newId('dgm')
    run(db, 'INSERT INTO doc_diagrams (id, doc_id, kb_id, type, title, candidate_path, html_path, sources, doc_version, source_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id, doc.id, kb.id, input.type, doc.title, candidateRel, htmlRel, JSON.stringify(input.sources),
      doc.currentVersion, await hashSources(workspaceRoot, input.sources), 'current', now, now,
    ])
    return { ok: true, diagramId: id, attempts }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), attempts }
  }
}

/** 手动/重新生成任务：解析工作区与证据 → generateDiagramForDoc。 */
export function startDiagramTask(input: { ctx: any; db: Db; storageRoot: string; kb: KbRow; docId: string; type?: string | null; diagramId?: string | null; workspaceId?: string | null }): { task: TaskRow; duplicate: boolean } {
  const created = createTask(input.db, {
    kbId: input.kb.id,
    kind: 'diagram',
    idemKey: 'diagram:' + input.docId,
    input: { docId: input.docId, type: input.type ?? null, diagramId: input.diagramId ?? null, workspaceId: input.workspaceId ?? null },
  })
  const task = created.task
  if (created.duplicate) return { task, duplicate: true }
  void runTask({
    db: input.db,
    taskId: task.id,
    executor: async (context) => {
      const doc = getDocument(input.db, input.docId)
      if (!doc) throw new Error('知识不存在：' + input.docId)
      const workspaceId = input.workspaceId ?? input.kb.workspaceId
      if (!workspaceId) throw new Error('该知识库未绑定工作区，无法定位图表产物目录')
      const listed = await listWorkspaces(input.ctx)
      const workspace = listed.workspaces.find((item: any) => item.id === workspaceId)
      if (!workspace || workspace.pathState === 'missing') throw new Error('工作区目录不可访问：' + workspaceId)
      let type = String(input.type ?? '')
      let sources: string[] = []
      if (input.diagramId) {
        const existing = getDiagram(input.db, String(input.diagramId))
        if (existing && existing.docId === doc.id) { type = existing.type; sources = existing.sources }
      }
      if (type === '') type = doc.kind === 'wiki' ? 'architecture' : 'tree'
      if (sources.length === 0) {
        sources = all(input.db, "SELECT ref FROM sources WHERE doc_id = ? AND kind = 'file'", [doc.id]).map((row: any) => String(row.ref))
      }
      const evidenceText = await readFilesText(workspace.path, sources, 12000)
      const result = await generateDiagramForDoc(input.ctx, input.db, input.kb, { doc, type, sources, workspaceRoot: workspace.path, evidenceText, taskId: task.id })
      if (!result.ok) throw new Error('图表生成失败：' + (result.error ?? '未知错误'))
      context.log('info', '已为文档「' + doc.title + '」生成 ' + type + ' 图表并关联（模型调用 ' + result.attempts + ' 次）')
      return { diagramId: result.diagramId, type }
    },
  }).catch((error) => {
    console.error('[knowhub] 图表生成任务异常：' + (error instanceof Error ? error.message : String(error)))
  })
  return { task, duplicate: false }
}
