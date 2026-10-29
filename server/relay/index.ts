import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'

type Device = { id: string; name: string; tokenHash: string; createdAt: number; revoked?: boolean }
type Client = { tokenHash: string; deviceId: string; name: string; createdAt: number; revoked?: boolean }
type Pairing = { codeHash: string; deviceId: string; expiresAt: number }
type PairRequest = { id: string; deviceId: string; name: string; createdAt: number; expiresAt: number; status: 'pending' | 'approved' | 'denied'; token?: string }
type State = { devices: Device[]; clients: Client[]; pairings: Pairing[]; pairRequests: PairRequest[] }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

const port = Number(process.env.PORT || 8787)
const publicOrigin = process.env.PUBLIC_ORIGIN || 'https://code.kyeai.xyz'
const adminHash = process.env.RMDEX_ADMIN_HASH || ''
const statePath = process.env.RMDEX_STATE || '/data/state.json'
const webRoot = process.env.RMDEX_WEB_ROOT || '/app/web'
const state: State = { devices: [], clients: [], pairings: [], pairRequests: [] }
const adminSessions = new Map<string, number>()
const approvedPairTokens = new Map<string, string>()
const deviceSockets = new Map<string, WebSocket>()
const devicePending = new Map<string, Map<string, Pending>>()
const authAttempts = new Map<string, { count: number; until: number }>()

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
function equalHash(value: string, expected: string) {
  const actual = Buffer.from(hash(value), 'hex')
  const wanted = Buffer.from(expected, 'hex')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
let saveQueue = Promise.resolve()
async function persist() {
  const snapshot = JSON.stringify(state)
  const operation = saveQueue.then(async () => {
  await mkdir(dirname(statePath), { recursive: true })
  const temp = `${statePath}.${process.pid}.tmp`
  await writeFile(temp, snapshot, { mode: 0o600 })
  await rename(temp, statePath)
  })
  saveQueue = operation.catch(() => {})
  await operation
}
async function load() {
  try {
    const saved = JSON.parse(await readFile(statePath, 'utf8')) as State
    state.devices = Array.isArray(saved.devices) ? saved.devices : []
    state.clients = Array.isArray(saved.clients) ? saved.clients : []
    state.pairings = Array.isArray(saved.pairings) ? saved.pairings.filter(pair => pair.expiresAt > Date.now()) : []
    state.pairRequests = Array.isArray(saved.pairRequests) ? saved.pairRequests.filter(pair => pair.expiresAt > Date.now() && pair.status === 'pending') : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
function json(res: import('node:http').ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  // Never emit an empty HTTP body for an API response. JSON.stringify(undefined)
  // would make the browser fail with an opaque "Unexpected end of JSON input".
  res.end(JSON.stringify(data === undefined ? { error: 'Relay returned no data' } : data))
}
async function body(req: import('node:http').IncomingMessage) {
  let raw = ''
  for await (const part of req) {
    raw += part.toString()
    if (raw.length > 65536) throw new Error('请求过大')
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {}
}
function clientFor(req: import('node:http').IncomingMessage) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  return token ? state.clients.find(client => !client.revoked && equalHash(token, client.tokenHash)) : undefined
}
function adminFor(req: import('node:http').IncomingMessage) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return false
  const expires = adminSessions.get(token)
  if (!expires || expires <= Date.now()) { adminSessions.delete(token); return false }
  return true
}
function rpc(deviceId: string, path: string, method: string, data?: unknown): Promise<unknown> {
  const socket = deviceSockets.get(deviceId)
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('设备当前离线'))
  const id = randomToken(12)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { devicePending.get(deviceId)?.delete(id); reject(new Error('设备响应超时')) }, 30000)
    const requests = devicePending.get(deviceId) || new Map<string, Pending>()
    requests.set(id, { resolve, reject, timer })
    devicePending.set(deviceId, requests)
    socket.send(JSON.stringify({ type: 'request', id, path, method, data }))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', publicOrigin)
  const origin = req.headers.origin
  if (origin && origin !== publicOrigin) { json(res, 403, { error: 'Origin not allowed' }); return }
  try {
    if (req.method === 'GET' && (url.pathname === '/' || !url.pathname.startsWith('/api/'))) {
      const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
      const requested = relative && !relative.startsWith('..') ? join(webRoot, relative) : join(webRoot, 'index.html')
      let file: Buffer
      let contentType: string
      try {
        file = await readFile(requested)
        contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' } as Record<string, string>)[extname(requested)] || 'application/octet-stream'
      } catch {
        file = await readFile(join(webRoot, 'index.html'))
        contentType = 'text/html; charset=utf-8'
      }
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': requested.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
      res.end(file); return
    }
    if (req.method === 'GET' && url.pathname === '/api/health') { json(res, 200, { ok: true }); return }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const ip = req.socket.remoteAddress || 'unknown'
      const attempts = authAttempts.get(ip)
      if (attempts && attempts.until > Date.now() && attempts.count >= 8) { json(res, 429, { error: '登录尝试过多，请稍后重试' }); return }
      const data = await body(req)
      const password = typeof data.password === 'string' ? data.password : ''
      const valid = /^[a-f0-9]{64}$/i.test(adminHash) && password.length <= 256 && equalHash(password, adminHash)
      if (!valid) {
        const next = attempts?.until && attempts.until > Date.now() ? attempts : { count: 0, until: Date.now() + 15 * 60_000 }
        next.count++
        authAttempts.set(ip, next)
        json(res, 401, { error: '密码不正确' }); return
      }
      authAttempts.delete(ip)
      const token = randomToken()
      adminSessions.set(token, Date.now() + 8 * 60 * 60_000)
      for (const [session, expires] of adminSessions) if (expires <= Date.now()) adminSessions.delete(session)
      json(res, 200, { token }); return
    }
    if (req.method === 'POST' && url.pathname === '/api/pair/claim') {
      const data = await body(req)
      const code = typeof data.code === 'string' ? data.code.trim() : ''
      if (!/^[A-Za-z0-9_-]{32}$/.test(code)) { json(res, 400, { error: '配对码无效或已过期' }); return }
      const index = state.pairings.findIndex(item => item.expiresAt > Date.now() && equalHash(code, item.codeHash))
      if (index < 0) { json(res, 400, { error: '配对码无效或已过期' }); return }
      const [pairing] = state.pairings.splice(index, 1)
      const id = randomToken()
      const request: PairRequest = { id, deviceId: pairing!.deviceId, name: typeof data.name === 'string' ? data.name.slice(0, 80) : '手机', createdAt: Date.now(), expiresAt: Date.now() + 5 * 60_000, status: 'pending' }
      state.pairRequests.push(request)
      await persist()
      json(res, 202, { requestId: id, status: 'pending' }); return
    }
    if (req.method === 'POST' && url.pathname === '/api/pair/status') {
      const data = await body(req)
      const requestId = typeof data.requestId === 'string' ? data.requestId : ''
      const request = state.pairRequests.find(item => item.id === requestId)
      if (!request || request.expiresAt <= Date.now()) { json(res, 410, { status: 'expired' }); return }
      if (request.status === 'pending') { json(res, 200, { status: 'pending' }); return }
      if (request.status === 'denied') { state.pairRequests = state.pairRequests.filter(item => item.id !== request.id); await persist(); json(res, 200, { status: 'denied' }); return }
      const token = approvedPairTokens.get(request.id)
      if (!token) { json(res, 410, { status: 'expired' }); return }
      approvedPairTokens.delete(request.id)
      state.pairRequests = state.pairRequests.filter(item => item.id !== request.id)
      await persist()
      json(res, 200, { status: 'approved', token, deviceId: request.deviceId }); return
    }
    if (req.method === 'POST' && url.pathname === '/api/devices') {
      if (!adminFor(req)) { json(res, 401, { error: '需要管理员登录' }); return }
      const data = await body(req)
      const token = randomToken()
      const device = { id: randomToken(12), name: typeof data.name === 'string' ? data.name.slice(0, 80) : 'Codex 设备', tokenHash: hash(token), createdAt: Date.now() }
      state.devices.push(device)
      const clientToken = randomToken()
      state.clients.push({ tokenHash: hash(clientToken), deviceId: device.id, name: '管理网页', createdAt: Date.now() })
      await persist()
      json(res, 201, { id: device.id, token, clientToken, name: device.name }); return
    }
    if (req.method === 'GET' && url.pathname === '/api/devices') {
      if (!adminFor(req)) { json(res, 401, { error: '需要管理员登录' }); return }
      json(res, 200, { data: state.devices.filter(device => !device.revoked).map(({ id, name, createdAt }) => ({ id, name, createdAt, online: deviceSockets.get(id)?.readyState === WebSocket.OPEN })) }); return
    }
    const webClientMatch = url.pathname.match(/^\/api\/devices\/([\w-]+)\/web-client$/)
    if (req.method === 'POST' && webClientMatch) {
      if (!adminFor(req)) { json(res, 401, { error: '需要管理员登录' }); return }
      const device = state.devices.find(item => item.id === webClientMatch[1] && !item.revoked)
      if (!device) { json(res, 404, { error: '设备不存在' }); return }
      const clientToken = randomToken()
      state.clients.push({ tokenHash: hash(clientToken), deviceId: device.id, name: '管理网页', createdAt: Date.now() })
      await persist()
      json(res, 201, { clientToken, device: { id: device.id, name: device.name, online: deviceSockets.get(device.id)?.readyState === WebSocket.OPEN } }); return
    }
    if (req.method === 'GET' && url.pathname === '/api/pair-requests') {
      if (!adminFor(req)) { json(res, 401, { error: '需要管理员登录' }); return }
      json(res, 200, { data: state.pairRequests.filter(pair => pair.status === 'pending' && pair.expiresAt > Date.now()).map(({ id, deviceId, name, createdAt }) => ({ id, deviceId, name, createdAt })) }); return
    }
    const pairDecision = url.pathname.match(/^\/api\/pair-requests\/([A-Za-z0-9_-]+)$/)
    if (req.method === 'POST' && pairDecision) {
      if (!adminFor(req)) { json(res, 401, { error: '需要管理员登录' }); return }
      const data = await body(req)
      const request = state.pairRequests.find(item => item.id === pairDecision[1] && item.status === 'pending' && item.expiresAt > Date.now())
      if (!request || !['approve', 'deny'].includes(String(data.decision))) { json(res, 404, { error: '配对请求不存在或已过期' }); return }
      request.status = data.decision === 'approve' ? 'approved' : 'denied'
      if (request.status === 'approved') {
        const token = randomToken()
        state.clients.push({ tokenHash: hash(token), deviceId: request.deviceId, name: request.name, createdAt: Date.now() })
        approvedPairTokens.set(request.id, token)
      }
      await persist()
      json(res, 200, { ok: true }); return
    }
    const pairMatch = url.pathname.match(/^\/api\/devices\/([\w-]+)\/pair$/)
    if (req.method === 'POST' && pairMatch) {
      if (!adminFor(req)) { json(res, 401, { error: '需要管理员登录' }); return }
      const device = state.devices.find(item => item.id === pairMatch[1] && !item.revoked)
      if (!device) { json(res, 404, { error: '设备不存在' }); return }
      const code = randomToken(24)
      state.pairings = state.pairings.filter(pair => pair.deviceId !== device.id && pair.expiresAt > Date.now())
      state.pairings.push({ codeHash: hash(code), deviceId: device.id, expiresAt: Date.now() + 180_000 })
      await persist()
      json(res, 200, { code, url: `${publicOrigin}/#pair=${encodeURIComponent(code)}`, expiresAt: Date.now() + 180_000 }); return
    }
    const revokeMatch = url.pathname.match(/^\/api\/devices\/([\w-]+)$/)
    if (req.method === 'DELETE' && revokeMatch) {
      if (!adminFor(req)) { json(res, 401, { error: '需要管理员登录' }); return }
      const device = state.devices.find(item => item.id === revokeMatch[1])
      if (!device) { json(res, 404, { error: '设备不存在' }); return }
      device.revoked = true
      state.clients = state.clients.filter(client => client.deviceId !== device.id)
      state.pairings = state.pairings.filter(pair => pair.deviceId !== device.id)
      state.pairRequests = state.pairRequests.filter(pair => pair.deviceId !== device.id)
      deviceSockets.get(device.id)?.close(4001, 'Device revoked')
      await persist()
      json(res, 200, { ok: true }); return
    }
    if (req.method === 'GET' && url.pathname === '/api/client') {
      const client = clientFor(req)
      if (!client) { json(res, 401, { error: '需要重新配对' }); return }
      const device = state.devices.find(item => item.id === client.deviceId && !item.revoked)
      if (!device) { json(res, 401, { error: '设备已撤销' }); return }
      json(res, 200, { device: { id: device.id, name: device.name, online: deviceSockets.get(device.id)?.readyState === WebSocket.OPEN } }); return
    }
    const client = clientFor(req)
    if (!client) { json(res, 401, { error: '需要登录或扫码配对' }); return }
    const device = state.devices.find(item => item.id === client.deviceId && !item.revoked)
    if (!device) { json(res, 401, { error: '设备已撤销' }); return }
    if (!['GET', 'POST'].includes(req.method || '')) { json(res, 405, { error: 'Method not allowed' }); return }
    const allowed = req.method === 'GET'
      ? /^\/api\/(?:models|threads(?:\/[a-zA-Z0-9-]+)?|images\/[a-f0-9-]+)$/.test(url.pathname)
      : /^\/api\/(?:threads|threads\/[a-zA-Z0-9-]+\/(?:send|stop|history)|approvals\/[a-zA-Z0-9-]+)$/.test(url.pathname)
    if (!allowed || url.search) { json(res, 404, { error: 'Not found' }); return }
    const result = await rpc(device.id, url.pathname + url.search, req.method!, req.method === 'POST' ? await body(req) : undefined)
    if (url.pathname.startsWith('/api/images/') && result && typeof result === 'object' && (result as { __rmdexBinary?: boolean }).__rmdexBinary) {
      const image = result as { contentType: string; data: string }
      res.writeHead(200, { 'Content-Type': image.contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(Buffer.from(image.data, 'base64')); return
    }
    json(res, 200, result)
  } catch (error) {
    json(res, 502, { error: error instanceof Error ? error.message : 'Relay error' })
  }
})

const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url || '/', publicOrigin).pathname !== '/agent') { socket.destroy(); return }
  sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws, req))
})
sockets.on('connection', ws => {
  const timer = setTimeout(() => ws.close(4000, 'Authentication timeout'), 5000)
  let deviceId: string | undefined
  ws.on('message', async raw => {
    try {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>
      if (!deviceId) {
        if (message.type !== 'auth' || typeof message.token !== 'string') { ws.close(4001, 'Unauthorized'); return }
        const device = state.devices.find(item => !item.revoked && equalHash(message.token as string, item.tokenHash))
        if (!device) { ws.close(4001, 'Unauthorized'); return }
        const previous = deviceSockets.get(device.id)
        if (previous && previous !== ws) {
          for (const pending of devicePending.get(device.id)?.values() || []) { clearTimeout(pending.timer); pending.reject(new Error('设备重新连接')) }
          previous.close(4002, 'Reconnected')
        }
        deviceId = device.id
        deviceSockets.set(device.id, ws)
        devicePending.set(device.id, new Map())
        clearTimeout(timer)
        ws.send(JSON.stringify({ type: 'ready', deviceId }))
        return
      }
      if (message.type === 'response' && typeof message.id === 'string') {
        const pending = devicePending.get(deviceId)?.get(message.id)
        if (pending) {
          clearTimeout(pending.timer)
          devicePending.get(deviceId)?.delete(message.id)
          if (message.error) pending.reject(new Error(String(message.error)))
          else pending.resolve(message.result)
        }
      }
    } catch { ws.close(4003, 'Invalid message') }
  })
  ws.on('close', () => {
    clearTimeout(timer)
    if (!deviceId || deviceSockets.get(deviceId) !== ws) return
    deviceSockets.delete(deviceId)
    for (const pending of devicePending.get(deviceId)?.values() || []) { clearTimeout(pending.timer); pending.reject(new Error('设备连接断开')) }
    devicePending.delete(deviceId)
  })
})

await load()
if (!/^[a-f0-9]{64}$/i.test(adminHash)) throw new Error('RMDEX_ADMIN_HASH must be a SHA-256 password hash')
server.listen(port, '0.0.0.0', () => console.log(`rmdex relay listening on ${port}`))
