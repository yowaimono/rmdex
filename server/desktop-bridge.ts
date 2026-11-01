import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'

// Desktop's local WebSocket client has no socket-path option on Windows.
type DesktopBridgeOptions = { mirrorPort?: number; mirrorToken?: string }
type MirrorEvent = { type: 'request' | 'resolved'; clientId: string; requestId: string; request?: unknown }
type MirrorResponse = { type: 'response'; clientId: string; requestId: string; result?: unknown; error?: unknown }

export async function createDesktopBridge(socketPath: string, codexExecutable = 'codex', options: DesktopBridgeOptions = {}) {
  const executable = process.platform === 'win32' && codexExecutable === 'codex' ? 'codex.cmd' : codexExecutable
  const secret = randomBytes(32).toString('hex')
  const server = createServer((_req, res) => { res.writeHead(404).end() })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  const mirrorServer = options.mirrorPort && options.mirrorToken ? createServer((_req, res) => { res.writeHead(404).end() }) : undefined
  const mirrorWss = mirrorServer ? new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 }) : undefined
  const proxies = new Set<ReturnType<typeof spawn>>()
  const clients = new Set<WebSocket>()
  const desktopConnections = new Map<string, WebSocket>()
  const mirrorClients = new Set<WebSocket>()
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
  if (mirrorServer && mirrorWss && options.mirrorToken) {
    mirrorServer.on('upgrade', (req, socket, head) => {
      const token = req.url?.slice(1) || ''
      const expected = Buffer.from(options.mirrorToken!)
      const candidate = Buffer.from(token)
      const address = mirrorServer.address()
      const valid = address && typeof address !== 'string' && req.headers.host === `127.0.0.1:${address.port}` &&
        !req.headers.origin && token.length === options.mirrorToken!.length && candidate.length === expected.length && timingSafeEqual(candidate, expected)
      if (!valid) { socket.destroy(); return }
      mirrorWss.handleUpgrade(req, socket, head, client => mirrorWss.emit('connection', client))
    })
    mirrorWss.on('connection', client => {
      mirrorClients.add(client)
      const close = () => mirrorClients.delete(client)
      client.on('error', close)
      client.on('close', close)
      client.on('message', data => {
        try {
          const message = JSON.parse(data.toString()) as MirrorResponse
          if (message.type !== 'response' || !message.clientId || !message.requestId) return
          const upstream = desktopConnections.get(message.clientId)
          if (!upstream || upstream.readyState !== WebSocket.OPEN) return
          const rpcId = /^\d+$/.test(message.requestId) ? Number(message.requestId) : message.requestId
          upstream.send(JSON.stringify({ id: rpcId, ...(message.error !== undefined ? { error: message.error } : { result: message.result }) }))
        } catch { /* Ignore malformed local mirror messages. */ }
      })
    })
  }
  wss.on('connection', client => {
    clients.add(client)
    const clientId = randomBytes(16).toString('hex')
    desktopConnections.set(clientId, client)
    const proxyArgs = ['app-server', 'proxy', '--sock', socketPath]
    const proxy = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', executable, ...proxyArgs], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(executable, proxyArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    proxies.add(proxy)
    proxy.stderr?.on('data', data => console.error(`Codex proxy: ${String(data).trim()}`))
    const stream = Duplex.from({ readable: proxy.stdout!, writable: proxy.stdin! })
    const upstream = new WebSocket('ws://localhost/rpc', { createConnection: () => stream, handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 })
    const queued: Array<{ data: WebSocket.RawData; binary: boolean }> = []
    let queuedBytes = 0
    const close = () => {
      clients.delete(client)
      desktopConnections.delete(clientId)
      proxies.delete(proxy)
      client.terminate()
      upstream.terminate()
      proxy.kill()
    }
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
    upstream.on('message', (data, binary) => {
      if (mirrorWss) {
        try {
          const message = JSON.parse(data.toString()) as { id?: string | number; method?: string; params?: { threadId?: string; questions?: unknown[]; requestId?: string | number } }
          if (message.method && message.id !== undefined && message.params?.threadId && Array.isArray(message.params.questions) &&
            ['item/tool/requestUserInput', 'item/tool/request_user_input'].includes(message.method)) {
            const event: MirrorEvent = { type: 'request', clientId, requestId: String(message.id), request: message }
            for (const watcher of mirrorClients) if (watcher.readyState === WebSocket.OPEN) watcher.send(JSON.stringify(event))
          } else if (message.method === 'serverRequest/resolved' && message.params?.requestId !== undefined) {
            const event: MirrorEvent = { type: 'resolved', clientId, requestId: String(message.params.requestId) }
            for (const watcher of mirrorClients) if (watcher.readyState === WebSocket.OPEN) watcher.send(JSON.stringify(event))
          }
        } catch { /* Preserve the transparent Desktop stream for non-JSON frames. */ }
      }
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary })
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  if (mirrorServer) await new Promise<void>((resolve, reject) => { mirrorServer.once('error', reject); mirrorServer.listen(options.mirrorPort, '127.0.0.1', () => { mirrorServer.off('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Failed to bind the Desktop bridge')
  return {
    url: `ws://127.0.0.1:${address.port}/${secret}`,
    close: () => {
      for (const client of clients) client.terminate()
      for (const mirror of mirrorClients) mirror.terminate()
      for (const proxy of proxies) proxy.kill()
      wss.close()
      server.close()
      mirrorWss?.close()
      mirrorServer?.close()
    },
  }
}
