import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { installEmployeeSkill, prepareEmployeeAssets } from './employee-assets.ts'

const relayUrl = process.env.RMDEX_RELAY_URL
const deviceToken = process.env.RMDEX_DEVICE_TOKEN
if (relayUrl && deviceToken) {
  const address = new URL(relayUrl)
  if (address.protocol !== 'wss:' && !(address.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))) throw new Error('Relay must use WSS')
  let stopped = false
  let socket: WebSocket | undefined
  const streamAcks = new Map<string, () => void>()
  const streamControllers = new Map<string, AbortController>()
  const waitForStreamAck = (id: string) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { streamAcks.delete(id); reject(new Error('artifact stream acknowledgement timed out')) }, 30000)
    streamAcks.set(id, () => { clearTimeout(timeout); streamAcks.delete(id); resolve() })
  })
  const connect = async () => {
    while (!stopped) {
      try {
        socket = new WebSocket(relayUrl, { handshakeTimeout: 10000, maxPayload: 32 * 1024 * 1024 })
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('relay authentication timeout')), 10000)
          socket!.once('open', () => socket!.send(JSON.stringify({ type: 'auth', token: deviceToken })))
          socket!.on('message', async raw => {
            try {
              const message = JSON.parse(raw.toString()) as Record<string, unknown>
              if (message.type === 'ready') {
                const skill = typeof message.employeeSkill === 'string' ? message.employeeSkill : undefined
                await installEmployeeSkill(undefined, skill).catch(error => console.error('[rmdex] Employee skill installation failed:', error.message))
                clearTimeout(timeout); resolve(); return
              }
              if (message.type === 'ack' && typeof message.id === 'string') { streamAcks.get(message.id)?.(); return }
              if (message.type === 'cancel' && typeof message.id === 'string') { streamControllers.get(message.id)?.abort(); streamAcks.get(message.id)?.(); return }
              if (message.type !== 'request' || typeof message.id !== 'string' || typeof message.path !== 'string' || !['GET', 'POST', 'DELETE'].includes(String(message.method))) return
              if (message.stream === true && message.method === 'GET' && /^\/api\/threads\/[a-zA-Z0-9-]+\/artifacts\/[a-zA-Z0-9-]+\/(?:content|preview)$/.test(message.path)) {
                const controller = new AbortController()
                streamControllers.set(message.id, controller)
                try {
                  const response = await fetch(`http://127.0.0.1:${process.env.RMDEX_AGENT_PORT || 18787}${message.path}`, { headers: typeof message.range === 'string' ? { Range: message.range } : {}, signal: controller.signal })
                  if (!response.ok || !response.body) throw new Error((await response.text().catch(() => '')) || 'Artifact unavailable')
                  socket?.send(JSON.stringify({ type: 'stream', id: message.id, status: response.status, contentType: response.headers.get('content-type') || 'application/octet-stream', contentDisposition: response.headers.get('content-disposition') || undefined, contentLength: response.headers.get('content-length') || undefined, contentRange: response.headers.get('content-range') || undefined }))
                  await waitForStreamAck(message.id)
                  const reader = response.body.getReader()
                  while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    for (let offset = 0; offset < value.length; offset += 48 * 1024) {
                      const chunk = Buffer.from(value.subarray(offset, Math.min(offset + 48 * 1024, value.length)))
                      socket?.send(JSON.stringify({ type: 'stream', id: message.id, data: chunk.toString('base64') }))
                      await waitForStreamAck(message.id)
                    }
                  }
                  socket?.send(JSON.stringify({ type: 'stream', id: message.id, done: true }))
                } catch (error) {
                  if (!controller.signal.aborted) socket?.send(JSON.stringify({ type: 'stream', id: message.id, error: error instanceof Error ? error.message : 'Artifact transfer failed', done: true }))
                } finally { streamControllers.delete(message.id); streamAcks.delete(message.id) }
                return
              }
              if (message.method === 'POST' && message.path === '/api/employee-assets/prepare') {
                try {
                  const result = await prepareEmployeeAssets((message.data || {}) as Parameters<typeof prepareEmployeeAssets>[0])
                  socket?.send(JSON.stringify({ type: 'response', id: message.id, result }))
                } catch (error) {
                  socket?.send(JSON.stringify({ type: 'response', id: message.id, error: error instanceof Error ? error.message : 'Employee assets could not be prepared' }))
                }
                return
              }
              const isAttachmentUpload = message.method === 'POST' && message.path === '/api/attachments'
              const isProjectMutation = message.method === 'POST' && /^\/api\/projects(?:\/[a-zA-Z0-9-]+\/(?:update|delete))?$/.test(message.path)
              const isAutomationRequest = (message.method === 'GET' && message.path === '/api/automations') || (message.method === 'POST' && message.path === '/api/automations/update')
              const allowed = isAttachmentUpload || isProjectMutation || (message.method === 'GET'
                ? isAutomationRequest || /^\/api\/(?:models|projects|settings|threads(?:\/[a-zA-Z0-9-]+(?:\/(?:status|incremental|queue|artifacts\/[a-zA-Z0-9-]+\/(?:content|preview)))?)?|images\/[a-f0-9-]+)$/.test(message.path)
                : isAutomationRequest || /^\/api\/(?:settings|threads|threads\/[a-zA-Z0-9-]+\/(?:send|retry|stop|history|name|fork|archive|unarchive|delete|queue|steer)|threads\/[a-zA-Z0-9-]+\/queue\/[^/]+(?:\/(?:steer|delete))?|approvals\/[a-zA-Z0-9-]+|user-input\/[a-zA-Z0-9-]+)$/.test(message.path))
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
                  if (bytes.length > 5 * 1024 * 1024) throw new Error('图片过大，暂不支持远程预览')
                  socket?.send(JSON.stringify({ type: 'response', id: message.id, result: { __rmdexBinary: true, contentType, data: bytes.toString('base64') } }))
                  return
                }
                const text = await response.text()
                if (!text.trim()) throw new Error(`本机代理返回空响应（HTTP ${response.status}）`)
                let result: unknown
                try { result = JSON.parse(text) as unknown }
                catch { throw new Error(`本机代理返回无效 JSON（HTTP ${response.status}）`) }
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
