import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PcManager, type PermissionMode } from './manager.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const port = Number(process.env.RMDEX_PC_PORT || 18788)
const dist = join(root, 'dist-pc')
const manager = new PcManager(root)
await manager.init()

function json(res: import('node:http').ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value === undefined ? { error: 'PC service returned no data' } : value))
}

async function body(req: import('node:http').IncomingMessage) {
  let raw = ''
  for await (const chunk of req) {
    raw += String(chunk)
    if (raw.length > 16_384) throw new Error('请求过大')
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {}
}

async function staticFile(pathname: string) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const safe = normalize(requested).replace(/^\.([/\\]|$)/, '')
  const path = join(dist, safe)
  try { return { path, data: await readFile(path) } } catch {
    return { path: join(dist, 'index.html'), data: await readFile(join(dist, 'index.html')) }
  }
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || ''
    const origin = req.headers.origin
    if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host) || (origin && ![ `http://localhost:${port}`, `http://127.0.0.1:${port}` ].includes(origin))) { json(res, 403, { error: 'Forbidden' }); return }
    if (req.method === 'POST' && (!origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))) { json(res, 403, { error: 'Forbidden' }); return }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    if (url.pathname.startsWith('/pc-api/')) {
      if (!['GET', 'POST'].includes(req.method || '')) { json(res, 405, { error: 'Method not allowed' }); return }
      if (req.method === 'GET' && url.pathname === '/pc-api/status') { json(res, 200, await manager.status()); return }
      if (req.method === 'GET' && url.pathname === '/pc-api/logs') { json(res, 200, await manager.logs()); return }
      if (req.method === 'POST' && url.pathname === '/pc-api/start') { json(res, 200, await manager.start()); return }
      if (req.method === 'POST' && url.pathname === '/pc-api/stop') { json(res, 200, await manager.stop()); return }
      if (req.method === 'POST' && url.pathname === '/pc-api/restart') { json(res, 200, await manager.restart()); return }
      if (req.method === 'POST' && url.pathname === '/pc-api/enroll') {
        const data = await body(req)
        const result = await manager.enroll(String(data.username || ''), String(data.password || ''), String(data.deviceName || ''))
        json(res, 200, result)
        return
      }
      if (req.method === 'POST' && url.pathname === '/pc-api/settings') {
        const data = await body(req)
        json(res, 200, await manager.setPermissionMode(String(data.permissionMode) as PermissionMode))
        return
      }
      json(res, 404, { error: 'Not found' }); return
    }
    const file = await staticFile(url.pathname)
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' }[extname(file.path).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': file.path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
    res.end(file.data)
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, '127.0.0.1', () => console.log(`rmdex-pc listening on http://127.0.0.1:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await manager.stop(); server.close(); process.exit(0) })
