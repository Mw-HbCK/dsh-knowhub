/** /knowhub HTTP 路由的请求/响应最小工具（原生 Node http，无框架依赖）。 */

export function writeJson(res: any, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

export function writeOk(res: any, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** 文本/附件下载响应（导出 Markdown 用）。 */
export function writeText(res: any, status: number, text: string, contentType: string, filename?: string): void {
  const body = Buffer.from(text, 'utf8')
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  }
  if (filename) {
    // HTTP 头只能是 latin-1：中文文件名必须给 ASCII 回退名 + RFC 5987 的 filename*，否则 Node 直接抛
    // "Invalid character in header content"（中文标题导出曾因此 500）。
    const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '') || 'download.md'
    headers['content-disposition'] = 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename)
  }
  res.writeHead(status, headers)
  res.end(body)
}

export function writeError(res: any, status: number, code: string, message: string): void {
  writeJson(res, status, { ok: false, error: { code, message } })
}

export async function readBody(req: any, limit = 256 * 1024): Promise<any> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > limit) throw new Error('请求体超过 256KB 上限')
    chunks.push(buf)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
