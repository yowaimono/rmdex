import type { IncomingMessage, ServerResponse } from 'node:http'

export async function proxyAgentRequest(req: IncomingMessage, res: ServerResponse, agentPort: number) {
  const chunks: Buffer[] = []
  let size = 0
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > 12 * 1024 * 1024) throw new Error('请求过大')
      chunks.push(bytes)
    }
  }
  const headers = new Headers()
  for (const name of ['authorization', 'accept', 'content-type']) {
    const value = req.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') headers.set('origin', 'http://localhost:5173')
  const pathname = new URL(req.url || '/', 'http://localhost').pathname
  const search = new URL(req.url || '/', 'http://localhost').search
  const response = await fetch(`http://127.0.0.1:${agentPort}${pathname}${search}`, {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  for (const name of ['content-type', 'cache-control']) {
    const value = response.headers.get(name)
    if (value) res.setHeader(name, value)
  }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(response.status)
  res.end(Buffer.from(await response.arrayBuffer()))
}
