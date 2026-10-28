import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

const relayUrl = process.env.RMDEX_RELAY_URL
const deviceToken = process.env.RMDEX_DEVICE_TOKEN
if (relayUrl && deviceToken) {
  const address = new URL(relayUrl)
  if (address.protocol !== 'wss:' && !(address.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))) throw new Error('Relay must use WSS')
  let stopped = false
  let socket: WebSocket | undefined
  const connect = async () => {
    while (!stopped) {
      try {
        socket = new WebSocket(relayUrl, { handshakeTimeout: 10000, maxPayload: 65536 })
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('relay authentication timeout')), 10000)
          socket!.once('open', () => socket!.send(JSON.stringify({ type: 'auth', token: deviceToken })))
          socket!.on('message', async raw => {
            try {
              const message = JSON.parse(raw.toString()) as Record<string, unknown>
              if (message.type === 'ready') { clearTimeout(timeout); resolve(); return }
              if (message.type !== 'request' || typeof message.id !== 'string' || typeof message.path !== 'string' || !['GET', 'POST'].includes(String(message.method))) return
              const allowed = message.method === 'GET'
                ? /^\/api\/(?:threads(?:\/[a-zA-Z0-9-]+)?|images\/[a-f0-9-]+)$/.test(message.path)
                : /^\/api\/(?:threads|threads\/[a-zA-Z0-9-]+\/(?:send|stop)|approvals\/[a-zA-Z0-9-]+)$/.test(message.path)
              if (!allowed) { socket?.send(JSON.stringify({ type: 'response', id: message.id, error: 'Forbidden' })); return }
              try {
                const response = await fetch(`http://127.0.0.1:${process.env.RMDEX_AGENT_PORT || 18787}${message.path}`, {
                  method: String(message.method),
                  headers: message.method === 'POST' ? { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' } : {},
                  body: message.method === 'POST' ? JSON.stringify(message.data ?? {}) : undefined,
                  signal: AbortSignal.timeout(35000),
                })
                if (message.path.startsWith('/api/images/')) {
                  if (!response.ok) throw new Error('图片不可用')
                  const contentType = response.headers.get('content-type') || 'application/octet-stream'
                  if (!/^image\/(?:png|jpeg|gif|webp)$/.test(contentType)) throw new Error('Unsupported image type')
                  const bytes = Buffer.from(await response.arrayBuffer())
                  if (bytes.length > 5 * 1024 * 1024) throw new Error('Image too large for secure relay')
                  socket?.send(JSON.stringify({ type: 'response', id: message.id, result: { __rmdexBinary: true, contentType, data: bytes.toString('base64') } }))
                  return
                }
                const result = await response.json() as unknown
                socket?.send(JSON.stringify(response.ok ? { type: 'response', id: message.id, result } : { type: 'response', id: message.id, error: (result as { error?: string }).error || '本机代理请求失败' }))
              } catch (error) {
                socket?.send(JSON.stringify({ type: 'response', id: message.id, error: error instanceof Error ? error.message : '本机代理请求失败' }))
              }
            } catch { socket?.close(4003, 'Invalid relay message') }
          })
          socket!.once('error', reject)
          socket!.once('close', () => { clearTimeout(timeout); reject(new Error('relay disconnected')) })
        })
        await new Promise<void>(resolve => socket?.once('close', () => resolve()))
      } catch (error) {
        console.error('Remote relay connection failed:', error instanceof Error ? error.message : 'connection error')
        socket?.terminate()
      }
      if (!stopped) await delay(2000)
    }
  }
  void connect()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopped = true; socket?.close() })
}
