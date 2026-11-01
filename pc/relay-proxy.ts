import type { IncomingMessage, ServerResponse } from 'node:http'

export function relayHttpOrigin(relayUrl: string) {
  const url = new URL(relayUrl)
  if (url.protocol === 'wss:') url.protocol = 'https:'
  else if (url.protocol === 'ws:') url.protocol = 'http:'
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Relay URL must use HTTP(S) or WS(S)')
  url.pathname = url.pathname.replace(/\/agent\/?$/, '')
  url.search = ''
  url.hash = ''
  return url.origin
}

export async function proxyRelayRequest(req: IncomingMessage, res: ServerResponse, relayOrigin: string) {
  const chunks: Buffer[] = []
  let size = 0
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > 32 * 1024 * 1024) throw new Error('请求过大')
      chunks.push(bytes)
    }
  }
  const headers = new Headers()
  for (const name of ['authorization', 'accept', 'content-type']) {
    const value = req.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  const incoming = new URL(req.url || '/', 'http://localhost')
  const response = await fetch(`${relayOrigin}${incoming.pathname}${incoming.search}`, {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
    signal: AbortSignal.timeout(35_000),
  })
  for (const name of ['content-type', 'cache-control', 'location']) {
    const value = response.headers.get(name)
    if (value) res.setHeader(name, value)
  }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.writeHead(response.status)
  res.end(Buffer.from(await response.arrayBuffer()))
}
