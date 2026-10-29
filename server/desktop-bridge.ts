import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'

// Desktop's local WebSocket client has no socket-path option on Windows.
export async function createDesktopBridge(socketPath: string, codexExecutable = 'codex') {
  const secret = randomBytes(32).toString('hex')
  const server = createServer((_req, res) => { res.writeHead(404).end() })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  const proxies = new Set<ReturnType<typeof spawn>>()
  const clients = new Set<WebSocket>()
  server.on('upgrade', (req, socket, head) => {
    const token = req.url?.slice(1) || ''
    const expected = Buffer.from(secret)
    const candidate = Buffer.from(token)
    const address = server.address()
    const valid = address && typeof address !== 'string' && req.headers.host === `127.0.0.1:${address.port}` &&
      !req.headers.origin && token.length === secret.length && candidate.length === expected.length && timingSafeEqual(candidate, expected)
    if (!valid) { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client))
  })
  wss.on('connection', client => {
    clients.add(client)
    const proxy = spawn(codexExecutable, ['app-server', 'proxy', '--sock', socketPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    proxies.add(proxy)
    proxy.stderr?.on('data', data => console.error(`Codex proxy: ${String(data).trim()}`))
    const stream = Duplex.from({ readable: proxy.stdout!, writable: proxy.stdin! })
    const upstream = new WebSocket('ws://localhost/rpc', { createConnection: () => stream, handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 })
    const queued: Array<{ data: WebSocket.RawData; binary: boolean }> = []
    let queuedBytes = 0
    const close = () => { clients.delete(client); proxies.delete(proxy); client.terminate(); upstream.terminate(); proxy.kill() }
    proxy.on('error', close)
    proxy.on('exit', close)
    upstream.on('error', close)
    upstream.on('close', close)
    client.on('error', close)
    client.on('close', close)
    upstream.on('open', () => { for (const item of queued) upstream.send(item.data, { binary: item.binary }); queued.length = 0; queuedBytes = 0 })
    client.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary })
      else if (upstream.readyState === WebSocket.CONNECTING) {
        queuedBytes += Array.isArray(data) ? data.reduce((total, part) => total + part.length, 0) : data.byteLength
        if (queuedBytes > 16 * 1024 * 1024) { close(); return }
        queued.push({ data, binary })
      } else close()
    })
    upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to bind the Desktop bridge')
  return {
    url: `ws://127.0.0.1:${address.port}/${secret}`,
    close: () => { for (const client of clients) client.terminate(); for (const proxy of proxies) proxy.kill(); wss.close(); server.close() },
  }
}
