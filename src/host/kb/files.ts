/**
 * 知识库文件层：Markdown 为正文真源，JSON 为可读清单。
 * 原子写：先写同目录临时文件，再 rename 覆盖，避免半截文件。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function kbDir(storageRoot: string, kbId: string): string {
  return join(storageRoot, 'knowledge-bases', kbId)
}

export function docDir(storageRoot: string, kbId: string, kind: string): string {
  return join(kbDir(storageRoot, kbId), kind === 'wiki' ? 'wiki' : 'knowledge')
}

export function docFilePath(storageRoot: string, kbId: string, kind: string, slug: string): string {
  return join(docDir(storageRoot, kbId, kind), slug + '.md')
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid.toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

export async function ensureKbLayout(storageRoot: string, kb: any): Promise<string> {
  const dir = kbDir(storageRoot, kb.id)
  for (const name of ['wiki', 'memories', 'knowledge']) {
    await mkdir(join(dir, name), { recursive: true })
  }
  const manifest = {
    id: kb.id,
    name: kb.name,
    scope: kb.scope,
    scopeKey: kb.scopeKey,
    workspaceId: kb.workspaceId,
    modelProvider: kb.modelProvider,
    modelId: kb.modelId,
    modelStrategy: kb.modelStrategy,
    status: kb.status,
    createdAt: kb.createdAt,
    updatedAt: kb.updatedAt,
    schemaVersion: kb.schemaVersion,
  }
  await atomicWrite(join(dir, 'knowledge-base.json'), JSON.stringify(manifest, null, 2) + '\n')
  await atomicWrite(join(dir, 'project.json'), JSON.stringify({
    workspaceId: kb.workspaceId,
    workspacePath: kb.workspacePath ?? null,
    workspaceTitle: kb.workspaceTitle ?? null,
    updatedAt: kb.updatedAt,
  }, null, 2) + '\n')
  return dir
}

export async function removeKbFiles(storageRoot: string, kbId: string): Promise<void> {
  await rm(kbDir(storageRoot, kbId), { recursive: true, force: true })
}

export async function readKbManifest(storageRoot: string, kbId: string): Promise<any | null> {
  try {
    const text = await readFile(join(kbDir(storageRoot, kbId), 'knowledge-base.json'), 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}
