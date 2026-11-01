import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'

// Desktop's local WebSocket client has no socket-path option on Windows.
type DesktopBridgeOptions = {
  mirrorPort?: number
  mirrorToken?: string
  spawnProxy?: (executable: string, args: string[]) => ChildProcess
  log?: (message: string) => void
}
type MirrorEvent = { type: 'request' | 'resolved'; clientId: string; requestId: string; request?: unknown }
type MirrorResponse = { type: 'response'; clientId: string; requestId: string; result?: unknown; error?: unknown }

export async function createDesktopBridge(socketPath: string, codexExecutable = 'codex', options: DesktopBridgeOptions = {}) {
  const executable = process.platform === 'win32' && codexExecutable === 'codex' ? 'codex.cmd' : codexExecutable
  const log = options.log || (message => console.log(`[rmdex desktop bridge] ${message}`))
  const secret = randomBytes(32).toString('hex')
  const server = createServer((_req, res) => { res.writeHead(404).end() })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 })
  const mirrorServer = options.mirrorPort !== undefined && options.mirrorToken ? createServer((_req, res) => { res.writeHead(404).end() }) : undefined
  const mirrorWss = mirrorServer ? new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 }) : undefined
  const proxies = new Set<ChildProcess>()
  const clients = new Set<WebSocket>()
  const desktopUpstreams = new Map<string, WebSocket>()
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
      log(`mirror client connected count=${mirrorClients.size}`)
      const close = () => mirrorClients.delete(client)
      client.on('error', close)
      client.on('close', () => { close(); log(`mirror client disconnected count=${mirrorClients.size}`) })
      client.on('message', data => {
        try {
          const message = JSON.parse(data.toString()) as MirrorResponse
          if (message.type !== 'response' || !message.clientId || !message.requestId) return
          const upstream = desktopUpstreams.get(message.clientId)
          if (!upstream || upstream.readyState !== WebSocket.OPEN) {
            log(`mirror response dropped client=${message.clientId} request=${message.requestId} upstream=unavailable`)
            client.send(JSON.stringify({ type: 'responseError', clientId: message.clientId, requestId: message.requestId, error: 'Codex Desktop 提问通道已断开' }))
            return
          }
          const rpcId = /^\d+$/.test(message.requestId) ? Number(message.requestId) : message.requestId
          upstream.send(JSON.stringify({ id: rpcId, ...(message.error !== undefined ? { error: message.error } : { result: message.result }) }), error => {
            if (error) {
              log(`mirror response failed client=${message.clientId} request=${message.requestId}`)
              if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'responseError', clientId: message.clientId, requestId: message.requestId, error: 'Codex Desktop 回答发送失败' }))
              return
            }
            log(`mirror response forwarded client=${message.clientId} request=${message.requestId} kind=${message.error !== undefined ? 'error' : 'result'}`)
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'responseForwarded', clientId: message.clientId, requestId: message.requestId }))
          })
        } catch { /* Ignore malformed local mirror messages. */ }
      })
    })
  }
  wss.on('connection', client => {
    clients.add(client)
    const clientId = randomBytes(16).toString('hex')
    log(`Desktop client connected client=${clientId}`)
    const proxyArgs = ['app-server', 'proxy', '--sock', socketPath]
    const proxy = options.spawnProxy
      ? options.spawnProxy(executable, proxyArgs)
      : process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', executable, ...proxyArgs], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        : spawn(executable, proxyArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    proxies.add(proxy)
    proxy.stderr?.on('data', data => console.error(`Codex proxy: ${String(data).trim()}`))
    const stream = Duplex.from({ readable: proxy.stdout!, writable: proxy.stdin! })
    const upstream = new WebSocket('ws://localhost/rpc', { createConnection: () => stream, handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024 })
    desktopUpstreams.set(clientId, upstream)
    const queued: Array<{ data: WebSocket.RawData; binary: boolean }> = []
    let queuedBytes = 0
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clients.delete(client)
      desktopUpstreams.delete(clientId)
      proxies.delete(proxy)
      client.terminate()
      upstream.terminate()
      proxy.kill()
      log(`Desktop client disconnected client=${clientId}`)
    }
    proxy.on('error', close)
    proxy.on('exit', close)
    upstream.on('error', close)
    upstream.on('close', close)
    client.on('error', close)
    client.on('close', close)
    upstream.on('open', () => {
      log(`Desktop upstream connected client=${clientId}`)
      for (const item of queued) upstream.send(item.data, { binary: item.binary })
      queued.length = 0
      queuedBytes = 0
    })
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
            log(`user input mirrored client=${clientId} request=${String(message.id)} thread=${message.params.threadId} questions=${message.params.questions.length} watchers=${mirrorClients.size}`)
          } else if (message.method === 'serverRequest/resolved' && message.params?.requestId !== undefined) {
            const event: MirrorEvent = { type: 'resolved', clientId, requestId: String(message.params.requestId) }
            for (const watcher of mirrorClients) if (watcher.readyState === WebSocket.OPEN) watcher.send(JSON.stringify(event))
            log(`server request resolved client=${clientId} request=${String(message.params.requestId)} watchers=${mirrorClients.size}`)
          } else if (message.method && message.id !== undefined) {
            log(`server request observed client=${clientId} method=${message.method}`)
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
  const mirrorAddress = mirrorServer?.address()
  return {
    url: `ws://127.0.0.1:${address.port}/${secret}`,
    mirrorUrl: mirrorAddress && typeof mirrorAddress !== 'string' && options.mirrorToken
      ? `ws://127.0.0.1:${mirrorAddress.port}/${options.mirrorToken}`
      : undefined,
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
