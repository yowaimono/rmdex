import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'

type Device = { id: string; userId: string; name: string; tokenHash: string; createdAt: number; revoked?: boolean }
type Client = { tokenHash: string; deviceId: string; name: string; createdAt: number; lastSeenAt?: number; revoked?: boolean }
type User = { id: string; username: string; passwordHash: string; role: 'admin' | 'user'; createdAt: number; disabled?: boolean }
type AuthSession = { id: string; familyId: string; userId: string; deviceId?: string; name?: string; accessHash: string; accessExpiresAt: number; refreshHash: string; refreshExpiresAt: number; usedRefreshHashes?: string[]; createdAt: number; lastSeenAt?: number; revoked?: boolean }
type PushToken = { tokenHash: string; deviceId: string; installationId: string; platform: 'android'; clientName?: string; createdAt: number; lastSeenAt: number }
type NotificationEvent = { id: string; deviceId: string; threadId: string; turnId: string; status: string; title: string; body: string; createdAt: number }
type Employee = { id: string; userId: string; name: string; role: string; instructions: string; legacyMemory?: string; deviceId: string; projectPath: string; threadId?: string; initializedThreadId?: string; assetContextVersion?: number; createdAt: number; updatedAt: number; archived?: boolean }
type Pairing = { codeHash: string; deviceId: string; userId: string; expiresAt: number }
type PairRequest = { id: string; deviceId: string; userId: string; name: string; createdAt: number; expiresAt: number; status: 'pending' | 'approved' | 'denied'; token?: string }
type State = { devices: Device[]; clients: Client[]; pairings: Pairing[]; pairRequests: PairRequest[]; users: User[]; sessions: AuthSession[]; pushTokens: PushToken[]; notifications: NotificationEvent[]; employees: Employee[] }
type Credentials = { accessToken: string; refreshToken: string; expiresIn: number; user: { id: string; username: string; role?: User['role'] }; token?: string; clientToken?: string; deviceId?: string }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

const port = Number(process.env.PORT || 8787)
const publicOrigin = process.env.PUBLIC_ORIGIN || 'https://code.kyeai.xyz'
const adminHash = process.env.RMDEX_ADMIN_HASH || ''
const adminUsername = (process.env.RMDEX_ADMIN_USERNAME || 'admin').trim().slice(0, 80) || 'admin'
const adminPassword = process.env.RMDEX_ADMIN_PASSWORD || ''
const statePath = process.env.RMDEX_STATE || '/data/state.json'
const webRoot = process.env.RMDEX_WEB_ROOT || '/app/web'
const employeeSkill = await readFile(process.env.RMDEX_EMPLOYEE_SKILL || join(process.cwd(), 'server', 'skills', 'rmdex-employee', 'SKILL.md'), 'utf8')
const state: State = { devices: [], clients: [], pairings: [], pairRequests: [], users: [], sessions: [], pushTokens: [], notifications: [], employees: [] }
const approvedPairTokens = new Map<string, Credentials>()
const deviceSockets = new Map<string, WebSocket>()
const devicePending = new Map<string, Map<string, Pending>>()
const authAttempts = new Map<string, { count: number; until: number }>()
const notificationWaiters = new Map<string, Set<{ after: number; resolve: () => void; timer: NodeJS.Timeout }>>()
const scryptAsync = promisify(scrypt)
const ACCESS_TTL = 15 * 60_000
const REFRESH_TTL = 30 * 24 * 60 * 60_000

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
function equalHash(value: string, expected: string) {
  const actual = Buffer.from(hash(value), 'hex')
  const wanted = Buffer.from(expected, 'hex')
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}
function encodePart(value: string | Buffer) { return Buffer.from(value).toString('base64url') }
async function passwordDigest(password: string) {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, 64, { N: 16_384, r: 8, p: 1 }) as Buffer
  return `scrypt$16384$8$1$${encodePart(salt)}$${encodePart(derived)}`
}
async function verifyPassword(password: string, stored: string) {
  if (stored.startsWith('sha256:')) return password.length <= 256 && equalHash(password, stored.slice(7))
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nText, rText, pText, saltText, expectedText] = parts
  const n = Number(nText); const r = Number(rText); const p = Number(pText)
  if (![n, r, p].every(Number.isSafeInteger) || n < 1024 || r < 1 || p < 1) return false
  try {
    const expected = Buffer.from(expectedText!, 'base64url')
    const actual = await scryptAsync(password, Buffer.from(saltText!, 'base64url'), expected.length, { N: n, r, p }) as Buffer
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch { return false }
}
function bearer(req: import('node:http').IncomingMessage) { return req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] }
function userForId(id: string) { return state.users.find(user => user.id === id && !user.disabled) }
function accessSession(token: string | undefined) {
  if (!token) return undefined
  const session = state.sessions.find(item => !item.revoked && item.accessExpiresAt > Date.now() && equalHash(token, item.accessHash))
  if (session) session.lastSeenAt = Date.now()
  return session
}
function sessionCredentials(session: AuthSession, accessToken: string, refreshToken: string): Credentials {
  const user = userForId(session.userId)
  if (!user) throw new Error('用户不存在')
  return { accessToken, refreshToken, expiresIn: Math.max(1, Math.floor((session.accessExpiresAt - Date.now()) / 1000)), user: { id: user.id, username: user.username, role: user.role }, token: accessToken, ...(session.deviceId ? { clientToken: accessToken, deviceId: session.deviceId } : {}) }
}
async function createSession(userId: string, deviceId?: string, name?: string): Promise<Credentials> {
  const accessToken = randomToken()
  const refreshToken = randomToken()
  const session: AuthSession = { id: randomToken(12), familyId: randomToken(12), userId, ...(deviceId ? { deviceId } : {}), ...(name ? { name } : {}), accessHash: hash(accessToken), accessExpiresAt: Date.now() + ACCESS_TTL, refreshHash: hash(refreshToken), refreshExpiresAt: Date.now() + REFRESH_TTL, createdAt: Date.now() }
  state.sessions.push(session)
  await persist()
  return sessionCredentials(session, accessToken, refreshToken)
}
async function rotateSession(refreshToken: string): Promise<Credentials | undefined> {
  const session = state.sessions.find(item => !item.revoked && equalHash(refreshToken, item.refreshHash))
  if (!session) {
    const replayed = state.sessions.find(item => !item.revoked && item.usedRefreshHashes?.some(value => equalHash(refreshToken, value)))
    if (replayed) {
      for (const item of state.sessions) if (item.familyId === replayed.familyId) item.revoked = true
      await persist()
    }
    return undefined
  }
  if (session.refreshExpiresAt <= Date.now()) { session.revoked = true; await persist(); return undefined }
  const nextAccess = randomToken()
  const nextRefresh = randomToken()
  session.usedRefreshHashes = [...(session.usedRefreshHashes || []), session.refreshHash].slice(-5)
  session.accessHash = hash(nextAccess)
  session.accessExpiresAt = Date.now() + ACCESS_TTL
  session.refreshHash = hash(nextRefresh)
  session.refreshExpiresAt = Date.now() + REFRESH_TTL
  session.lastSeenAt = Date.now()
  await persist()
  return sessionCredentials(session, nextAccess, nextRefresh)
}
function revokeAccess(token: string | undefined) {
  const session = accessSession(token)
  if (session) session.revoked = true
  return session
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
    const saved = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>
    const savedUsers = Array.isArray(saved.users) ? saved.users : []
    state.users = savedUsers.filter(item => item && typeof item.id === 'string' && typeof item.username === 'string' && typeof item.passwordHash === 'string' && (item.role === 'admin' || item.role === 'user')).map(item => ({
      id: item.id, username: item.username, passwordHash: item.passwordHash, role: item.role, createdAt: Number(item.createdAt) || Date.now(), ...(item.disabled ? { disabled: true } : {}),
    }))
    const savedDevices = Array.isArray(saved.devices) ? saved.devices : []
    state.devices = savedDevices.filter(item => item && typeof item.id === 'string' && typeof item.userId === 'string' && typeof item.name === 'string' && typeof item.tokenHash === 'string' && state.users.some(user => user.id === item.userId)).map(item => ({
      id: item.id, userId: item.userId, name: item.name, tokenHash: item.tokenHash, createdAt: Number(item.createdAt) || Date.now(), ...(item.revoked ? { revoked: true } : {}),
    }))
    state.clients = Array.isArray(saved.clients) ? saved.clients : []
    state.sessions = Array.isArray(saved.sessions) ? saved.sessions : []
    state.pushTokens = Array.isArray(saved.pushTokens) ? saved.pushTokens.flatMap(item => {
      if (typeof item.tokenHash === 'string') return [item]
      if (typeof (item as { token?: string }).token === 'string') return [{ tokenHash: hash((item as { token: string }).token), deviceId: item.deviceId, installationId: `legacy-${item.deviceId}`, platform: 'android' as const, clientName: item.clientName, createdAt: item.createdAt, lastSeenAt: item.lastSeenAt }]
      return []
    }) : []
    state.notifications = Array.isArray(saved.notifications) ? saved.notifications.filter(item => item && typeof item.deviceId === 'string' && typeof item.threadId === 'string') : []
    state.employees = Array.isArray(saved.employees) ? saved.employees.filter(item => item && typeof item.id === 'string' && typeof item.userId === 'string' && typeof item.name === 'string' && typeof item.deviceId === 'string' && typeof item.projectPath === 'string' && state.users.some(user => user.id === item.userId)).map(item => ({
      id: item.id, userId: item.userId, name: item.name, role: typeof item.role === 'string' ? item.role : '', instructions: typeof item.instructions === 'string' ? item.instructions : '', ...(typeof item.legacyMemory === 'string' && item.legacyMemory.trim() ? { legacyMemory: item.legacyMemory } : typeof item.memory === 'string' && item.memory.trim() ? { legacyMemory: item.memory } : {}), deviceId: item.deviceId, projectPath: item.projectPath, ...(typeof item.threadId === 'string' ? { threadId: item.threadId } : {}), ...(item.assetContextVersion === 1 && typeof item.initializedThreadId === 'string' ? { initializedThreadId: item.initializedThreadId, assetContextVersion: 1 } : {}), createdAt: Number(item.createdAt) || Date.now(), updatedAt: Number(item.updatedAt) || Date.now(), ...(item.archived ? { archived: true } : {}),
    })) : []
    state.pairings = Array.isArray(saved.pairings) ? saved.pairings.filter(pair => pair && pair.expiresAt > Date.now() && typeof pair.codeHash === 'string' && typeof pair.deviceId === 'string' && typeof pair.userId === 'string' && state.users.some(user => user.id === pair.userId)).map(pair => ({ codeHash: pair.codeHash, deviceId: pair.deviceId, userId: pair.userId, expiresAt: pair.expiresAt })) : []
    state.pairRequests = Array.isArray(saved.pairRequests) ? saved.pairRequests.filter(pair => pair && pair.expiresAt > Date.now() && pair.status === 'pending' && typeof pair.id === 'string' && typeof pair.deviceId === 'string' && typeof pair.userId === 'string' && typeof pair.name === 'string' && state.users.some(user => user.id === pair.userId)).map(pair => ({ id: pair.id, deviceId: pair.deviceId, userId: pair.userId, name: pair.name, createdAt: pair.createdAt, expiresAt: pair.expiresAt, status: pair.status })) : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
async function ensureAdminUser() {
  if (state.users.some(user => user.role === 'admin')) return
  let passwordHash = ''
  if (adminPassword) passwordHash = await passwordDigest(adminPassword)
  else if (/^[a-f0-9]{64}$/i.test(adminHash)) passwordHash = `sha256:${adminHash}`
  if (!passwordHash) throw new Error('需要配置 RMDEX_ADMIN_PASSWORD，或兼容旧版的 RMDEX_ADMIN_HASH')
  state.users.push({ id: randomToken(12), username: adminUsername, passwordHash, role: 'admin', createdAt: Date.now() })
  await persist()
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
    if (raw.length > 12 * 1024 * 1024) throw new Error('请求过大')
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {}
}
function clientFor(req: import('node:http').IncomingMessage) {
  const token = bearer(req)
  const session = accessSession(token)
  if (session?.deviceId && userForId(session.userId) && state.devices.some(device => !device.revoked && device.id === session.deviceId && device.userId === session.userId)) return { tokenHash: session.accessHash, deviceId: session.deviceId, name: session.name || '已登录设备', createdAt: session.createdAt, lastSeenAt: session.lastSeenAt } satisfies Client
  const client = token ? state.clients.find(item => !item.revoked && equalHash(token, item.tokenHash)) : undefined
  if (client) client.lastSeenAt = Date.now()
  return client
}
function pushFor(req: import('node:http').IncomingMessage) {
  const token = bearer(req)
  const subscription = token ? state.pushTokens.find(item => equalHash(token, item.tokenHash)) : undefined
  if (subscription) subscription.lastSeenAt = Date.now()
  return subscription
}
function adminFor(req: import('node:http').IncomingMessage) {
  const session = accessSession(bearer(req))
  const user = session ? userForId(session.userId) : undefined
  return user && !session?.deviceId ? user : undefined
}
function canManageUser(user: User, userId: string | undefined) {
  return user.role === 'admin' || Boolean(userId && user.id === userId)
}
function employeeFor(id: string, userId: string) {
  return state.employees.find(item => !item.archived && item.id === id && item.userId === userId)
}
function deviceForUser(deviceId: string, userId: string) {
  return state.devices.find(item => !item.revoked && item.id === deviceId && item.userId === userId)
}
function employeeView(employee: Employee) {
  const { legacyMemory: _legacyMemory, ...view } = employee
  return view
}
function employeeContext(employee: Employee, assets: { assetPath: string; skillPath: string }) {
  return [
    '<rmdex_employee_context>',
    `Employee name: ${employee.name}`,
    `Role: ${employee.role || 'AI work employee'}`,
    'Instructions:',
    employee.instructions || '(Follow the user request carefully and report concrete results.)',
    `Employee asset directory: ${JSON.stringify(assets.assetPath)}`,
    `Use the rmdex-employee skill. Read and follow its instructions at: ${JSON.stringify(assets.skillPath)}`,
    'Search and maintain this employee\'s local memories and SOPs as the skill instructs.',
    '</rmdex_employee_context>',
    '<rmdex_user_request>',
  ].join('\n')
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

const taskWatchers = new Map<string, NodeJS.Timeout>()
function notificationEvents(deviceId: string, after: number) {
  return state.notifications.filter(item => item.deviceId === deviceId && item.createdAt > after)
}
async function enqueueNotification(deviceId: string, threadId: string, turnId: string, status: string, title: string, bodyText: string) {
  const previousCreatedAt = state.notifications.length ? state.notifications[state.notifications.length - 1]!.createdAt : 0
  const event: NotificationEvent = { id: randomToken(12), deviceId, threadId, turnId, status, title, body: bodyText, createdAt: Math.max(Date.now(), previousCreatedAt + 1) }
  state.notifications.push(event)
  if (state.notifications.length > 2000) state.notifications.splice(0, state.notifications.length - 2000)
  await persist()
  for (const waiter of notificationWaiters.get(deviceId) || []) {
    clearTimeout(waiter.timer)
    waiter.resolve()
  }
  notificationWaiters.delete(deviceId)
}
function watchTask(deviceId: string, threadId: string, turnId: string, name: string) {
  const key = `${deviceId}:${threadId}:${turnId}`
  if (taskWatchers.has(key)) return
  const startedAt = Date.now()
  const poll = async () => {
    taskWatchers.delete(key)
    if (Date.now() - startedAt > 24 * 60 * 60_000) return
    try {
      const result = await rpc(deviceId, `/api/threads/${threadId}/status`, 'GET') as { activeTurnId?: string | null; lastTurn?: { id?: string; status?: string } | null }
      const status = result.lastTurn?.status || ''
      if (result.lastTurn?.id === turnId && !result.activeTurnId && status && !['inProgress', 'running', 'active', 'started'].includes(status)) {
        await enqueueNotification(deviceId, threadId, turnId, status, `${name || 'Codex 会话'}已完成`, status === 'completed' ? '任务已完成，点击查看结果' : `任务${status === 'interrupted' ? '已暂停' : '已结束'}，点击查看详情`)
        return
      }
    } catch { /* The desktop agent may be reconnecting; keep watching. */ }
    const timer = setTimeout(() => void poll(), 3000)
    taskWatchers.set(key, timer)
  }
  void poll()
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
      const username = typeof data.username === 'string' ? data.username.trim() : adminUsername
      const password = typeof data.password === 'string' ? data.password : ''
      const user = state.users.find(item => item.username.toLowerCase() === username.toLowerCase() && !item.disabled)
      const valid = Boolean(user && password.length <= 256 && await verifyPassword(password, user.passwordHash))
      if (!valid) {
        const next = attempts?.until && attempts.until > Date.now() ? attempts : { count: 0, until: Date.now() + 15 * 60_000 }
        next.count++
        authAttempts.set(ip, next)
        json(res, 401, { error: '账号或密码不正确' }); return
      }
      authAttempts.delete(ip)
      json(res, 200, await createSession(user!.id)); return
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/refresh') {
      const data = await body(req)
      const refreshToken = typeof data.refreshToken === 'string' ? data.refreshToken : ''
      const credentials = refreshToken ? await rotateSession(refreshToken) : undefined
      if (!credentials) { json(res, 401, { error: '刷新凭证已失效，请重新登录' }); return }
      json(res, 200, credentials); return
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const data = await body(req)
      const access = accessSession(bearer(req))
      const refresh = typeof data.refreshToken === 'string' ? data.refreshToken : ''
      const refreshSession = refresh ? state.sessions.find(item => !item.revoked && equalHash(refresh, item.refreshHash)) : undefined
      if (access) access.revoked = true
      if (refreshSession) refreshSession.revoked = true
      await persist()
      json(res, 200, { ok: true }); return
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') {
      const session = accessSession(bearer(req))
      const user = session ? userForId(session.userId) : undefined
      if (!session || !user) { json(res, 401, { error: '登录已失效' }); return }
      json(res, 200, { user: { id: user.id, username: user.username, role: user.role }, expiresAt: session.accessExpiresAt, deviceId: session.deviceId || null }); return
    }
    if (req.method === 'POST' && url.pathname === '/api/pair/claim') {
      const data = await body(req)
      const code = typeof data.code === 'string' ? data.code.trim() : ''
      if (!/^[A-Za-z0-9_-]{32}$/.test(code)) { json(res, 400, { error: '配对码无效或已过期' }); return }
      const index = state.pairings.findIndex(item => item.expiresAt > Date.now() && equalHash(code, item.codeHash))
      if (index < 0) { json(res, 400, { error: '配对码无效或已过期' }); return }
      const [pairing] = state.pairings.splice(index, 1)
      const id = randomToken()
      const request: PairRequest = { id, deviceId: pairing!.deviceId, userId: pairing!.userId, name: typeof data.name === 'string' ? data.name.slice(0, 80) : '手机', createdAt: Date.now(), expiresAt: Date.now() + 5 * 60_000, status: 'pending' }
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
      const credentials = approvedPairTokens.get(request.id)
      if (!credentials) { json(res, 410, { status: 'expired' }); return }
      approvedPairTokens.delete(request.id)
      state.pairRequests = state.pairRequests.filter(item => item.id !== request.id)
      await persist()
      json(res, 200, { status: 'approved', ...credentials, token: credentials.accessToken, deviceId: request.deviceId }); return
    }
    if (req.method === 'POST' && url.pathname === '/api/devices') {
      const admin = adminFor(req)
      if (!admin) { json(res, 401, { error: '需要管理员登录' }); return }
      const data = await body(req)
      const requestedUserId = typeof data.userId === 'string' ? data.userId : undefined
      if (requestedUserId && admin.role !== 'admin' && requestedUserId !== admin.id) { json(res, 403, { error: '无权为其他用户创建设备' }); return }
      const userId = requestedUserId || admin.id
      if (!userForId(userId) || !canManageUser(admin, userId)) { json(res, 400, { error: '用户不存在或无权管理' }); return }
      const token = randomToken()
      const device: Device = { id: randomToken(12), userId, name: typeof data.name === 'string' ? data.name.slice(0, 80) : 'Codex 设备', tokenHash: hash(token), createdAt: Date.now() }
      state.devices.push(device)
      const credentials = await createSession(device.userId, device.id, '管理网页')
      await persist()
      json(res, 201, { id: device.id, userId, ...credentials, token, clientToken: credentials.accessToken, name: device.name }); return
    }
    if (url.pathname === '/api/users' && req.method === 'GET') {
      const admin = adminFor(req)
      if (!admin) { json(res, 401, { error: '需要管理员登录' }); return }
      const users = admin.role === 'admin' ? state.users.filter(user => !user.disabled) : [admin]
      json(res, 200, { data: users.map(user => ({ id: user.id, username: user.username, role: user.role, deviceCount: state.devices.filter(device => device.userId === user.id && !device.revoked).length })) }); return
    }
    if (url.pathname === '/api/users' && req.method === 'POST') {
      const admin = adminFor(req)
      if (!admin || admin.role !== 'admin') { json(res, 403, { error: '仅平台管理员可以创建用户' }); return }
      const data = await body(req)
      const username = typeof data.username === 'string' ? data.username.trim().slice(0, 80) : ''
      const password = typeof data.password === 'string' ? data.password : ''
      if (!/^[A-Za-z0-9_.@-]{3,80}$/.test(username) || password.length < 12 || password.length > 256) { json(res, 400, { error: '账号需 3-80 位；初始密码需 12-256 位' }); return }
      if (state.users.some(user => user.username.toLowerCase() === username.toLowerCase())) { json(res, 409, { error: '账号已存在' }); return }
      const user: User = { id: randomToken(12), username, passwordHash: await passwordDigest(password), role: 'user', createdAt: Date.now() }
      state.users.push(user); await persist()
      json(res, 201, { user: { id: user.id, username: user.username, role: user.role, deviceCount: 0 } }); return
    }
    if (req.method === 'GET' && url.pathname === '/api/devices') {
      const admin = adminFor(req)
      if (!admin) { json(res, 401, { error: '需要管理员登录' }); return }
      const requestedUserId = url.searchParams.get('userId')
      const userId = admin.role === 'admin' ? (requestedUserId || admin.id) : (requestedUserId && requestedUserId !== admin.id ? '' : admin.id)
      if (!userForId(userId) || !canManageUser(admin, userId)) { json(res, 403, { error: '用户不存在或无权管理' }); return }
      json(res, 200, { data: state.devices.filter(device => !device.revoked && device.userId === userId).map(({ id, userId, name, createdAt }) => ({ id, userId, name, createdAt, online: deviceSockets.get(id)?.readyState === WebSocket.OPEN })) }); return
    }
    const webClientMatch = url.pathname.match(/^\/api\/devices\/([\w-]+)\/web-client$/)
    if (req.method === 'POST' && webClientMatch) {
      const admin = adminFor(req)
      if (!admin) { json(res, 401, { error: '需要管理员登录' }); return }
      const device = state.devices.find(item => item.id === webClientMatch[1] && !item.revoked)
      if (!device || !canManageUser(admin, device.userId)) { json(res, 404, { error: '设备不存在' }); return }
      const credentials = await createSession(device.userId, device.id, '管理网页')
      await persist()
      json(res, 201, { ...credentials, clientToken: credentials.accessToken, device: { id: device.id, name: device.name, online: deviceSockets.get(device.id)?.readyState === WebSocket.OPEN } }); return
    }
    if (req.method === 'GET' && url.pathname === '/api/pair-requests') {
      const admin = adminFor(req)
      if (!admin) { json(res, 401, { error: '需要管理员登录' }); return }
      json(res, 200, { data: state.pairRequests.filter(pair => pair.status === 'pending' && pair.expiresAt > Date.now() && canManageUser(admin, pair.userId)).map(({ id, deviceId, userId, name, createdAt }) => ({ id, deviceId, userId, name, createdAt })) }); return
    }
    const pairDecision = url.pathname.match(/^\/api\/pair-requests\/([A-Za-z0-9_-]+)$/)
    if (req.method === 'POST' && pairDecision) {
      const admin = adminFor(req)
      if (!admin) { json(res, 401, { error: '需要管理员登录' }); return }
      const data = await body(req)
      const request = state.pairRequests.find(item => item.id === pairDecision[1] && item.status === 'pending' && item.expiresAt > Date.now())
      if (!request || !canManageUser(admin, request.userId) || !['approve', 'deny'].includes(String(data.decision))) { json(res, 404, { error: '配对请求不存在或已过期' }); return }
      request.status = data.decision === 'approve' ? 'approved' : 'denied'
      if (request.status === 'approved') {
        approvedPairTokens.set(request.id, await createSession(request.userId, request.deviceId, request.name))
      }
      await persist()
      json(res, 200, { ok: true }); return
    }
    const pairMatch = url.pathname.match(/^\/api\/devices\/([\w-]+)\/pair$/)
    if (req.method === 'POST' && pairMatch) {
      if (!adminFor(req)) { json(res, 401, { error: '需要管理员登录' }); return }
      const device = state.devices.find(item => item.id === pairMatch[1] && !item.revoked)
      const admin = adminFor(req)!
      if (!device || !canManageUser(admin, device.userId)) { json(res, 404, { error: '设备不存在' }); return }
      const code = randomToken(24)
      state.pairings = state.pairings.filter(pair => pair.deviceId !== device.id && pair.expiresAt > Date.now())
      state.pairings.push({ codeHash: hash(code), deviceId: device.id, userId: device.userId, expiresAt: Date.now() + 180_000 })
      await persist()
      json(res, 200, { code, url: `${publicOrigin}/#pair=${encodeURIComponent(code)}`, expiresAt: Date.now() + 180_000 }); return
    }
    const revokeMatch = url.pathname.match(/^\/api\/devices\/([\w-]+)$/)
    if (req.method === 'DELETE' && revokeMatch) {
      const admin = adminFor(req)
      if (!admin) { json(res, 401, { error: '需要管理员登录' }); return }
      const device = state.devices.find(item => item.id === revokeMatch[1])
      if (!device || !canManageUser(admin, device.userId)) { json(res, 404, { error: '设备不存在' }); return }
      device.revoked = true
      state.clients = state.clients.filter(client => client.deviceId !== device.id)
      for (const session of state.sessions) if (session.deviceId === device.id) session.revoked = true
      state.pushTokens = state.pushTokens.filter(item => item.deviceId !== device.id)
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
    if (req.method === 'GET' && url.pathname === '/api/client/peers') {
      const client = clientFor(req)
      if (!client) { json(res, 401, { error: '请重新配对' }); return }
      const device = state.devices.find(item => item.id === client.deviceId && !item.revoked)
      if (!device) { json(res, 401, { error: '设备已撤销' }); return }
      const phones = state.clients
        .filter(item => !item.revoked && item.deviceId === device.id && item !== client)
        .map(item => ({ name: item.name, lastSeenAt: item.lastSeenAt, online: Boolean(item.lastSeenAt && Date.now() - item.lastSeenAt < 90_000) }))
      json(res, 200, { device: { id: device.id, name: device.name, online: deviceSockets.get(device.id)?.readyState === WebSocket.OPEN }, phones }); return
    }
    if (req.method === 'POST' && (url.pathname === '/api/push/register' || url.pathname === '/api/push/unregister')) {
      const client = clientFor(req)
      if (!client) { json(res, 401, { error: '需要登录或扫码配对' }); return }
      const device = state.devices.find(item => item.id === client.deviceId && !item.revoked)
      if (!device) { json(res, 401, { error: '设备已撤销' }); return }
      const data = await body(req)
      const installationId = typeof data.installationId === 'string' ? data.installationId.trim() : ''
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(installationId)) { json(res, 400, { error: '安装标识无效' }); return }
      if (url.pathname.endsWith('/unregister')) {
        state.pushTokens = state.pushTokens.filter(item => !(item.deviceId === device.id && item.installationId === installationId))
        await persist()
        json(res, 200, { ok: true }); return
      }
      const pushToken = randomToken()
      state.pushTokens = state.pushTokens.filter(item => !(item.deviceId === device.id && item.installationId === installationId))
      state.pushTokens.push({ tokenHash: hash(pushToken), deviceId: device.id, installationId, platform: 'android', clientName: typeof data.clientName === 'string' ? data.clientName.slice(0, 80) : client.name, createdAt: Date.now(), lastSeenAt: Date.now() })
      await persist()
      json(res, 200, { pushToken }); return
    }
    if (req.method === 'GET' && url.pathname === '/api/notifications/poll') {
      const subscription = pushFor(req)
      if (!subscription) { json(res, 401, { error: '后台连接凭证已失效' }); return }
      const after = Math.max(0, Number(url.searchParams.get('after') || 0))
      const wait = Math.min(30_000, Math.max(0, Number(url.searchParams.get('wait') || 25_000)))
      if (!Number.isFinite(after) || !Number.isFinite(wait)) { json(res, 400, { error: '游标无效' }); return }
      if (!notificationEvents(subscription.deviceId, after).length && wait > 0) {
        let currentWaiter: { after: number; resolve: () => void; timer: NodeJS.Timeout } | undefined
        await new Promise<void>(resolve => {
          currentWaiter = { after, resolve, timer: setTimeout(resolve, wait) }
          const waiters = notificationWaiters.get(subscription.deviceId) || new Set()
          waiters.add(currentWaiter)
          notificationWaiters.set(subscription.deviceId, waiters)
        })
        const waiters = notificationWaiters.get(subscription.deviceId)
        if (waiters) {
          if (currentWaiter) { clearTimeout(currentWaiter.timer); waiters.delete(currentWaiter) }
          if (!waiters.size) notificationWaiters.delete(subscription.deviceId)
        }
      }
      const events = notificationEvents(subscription.deviceId, after)
      const cursor = events.reduce((value, item) => Math.max(value, item.createdAt), after)
      json(res, 200, { data: events, cursor }); return
    }
    const client = clientFor(req)
    if (!client) { json(res, 401, { error: '需要登录或扫码配对' }); return }
    const device = state.devices.find(item => item.id === client.deviceId && !item.revoked)
    if (!device) { json(res, 401, { error: '设备已撤销' }); return }
    const userId = device.userId
    if (req.method === 'GET' && url.pathname === '/api/employees') {
      json(res, 200, { data: state.employees.filter(item => !item.archived && item.userId === userId).map(employeeView) }); return
    }
    if (req.method === 'POST' && url.pathname === '/api/employees') {
      const data = await body(req)
      const name = typeof data.name === 'string' ? data.name.trim().slice(0, 80) : ''
      const role = typeof data.role === 'string' ? data.role.trim().slice(0, 120) : ''
      const instructions = typeof data.instructions === 'string' ? data.instructions.trim().slice(0, 12_000) : ''
      const projectPath = typeof data.projectPath === 'string' ? data.projectPath.trim().slice(0, 1000) : ''
      const deviceId = typeof data.deviceId === 'string' ? data.deviceId : device.id
      if (!name || !projectPath || !deviceForUser(deviceId, userId)) { json(res, 400, { error: '请填写员工名称、Project 路径，并选择本用户的设备' }); return }
      if (state.employees.some(item => !item.archived && item.userId === userId && item.name.toLowerCase() === name.toLowerCase())) { json(res, 409, { error: '员工名称已存在' }); return }
      const now = Date.now()
      const employee: Employee = { id: randomToken(12), userId, name, role, instructions, deviceId, projectPath, createdAt: now, updatedAt: now }
      state.employees.push(employee)
      await persist()
      json(res, 201, { employee: employeeView(employee) }); return
    }
    const employeeMatch = url.pathname.match(/^\/api\/employees\/([A-Za-z0-9_-]+)(?:\/(update|ensure-thread|reset-thread))?$/)
    if (employeeMatch) {
      const employee = employeeFor(employeeMatch[1]!, userId)
      if (!employee) { json(res, 404, { error: '员工不存在' }); return }
      const action = employeeMatch[2]
      if (req.method === 'POST' && action === 'update') {
        const data = await body(req)
        const nextName = typeof data.name === 'string' ? data.name.trim().slice(0, 80) : employee.name
        const nextRole = typeof data.role === 'string' ? data.role.trim().slice(0, 120) : employee.role
        const nextInstructions = typeof data.instructions === 'string' ? data.instructions.trim().slice(0, 12_000) : employee.instructions
        const nextPath = typeof data.projectPath === 'string' ? data.projectPath.trim().slice(0, 1000) : employee.projectPath
        const nextDeviceId = typeof data.deviceId === 'string' ? data.deviceId : employee.deviceId
        if (!nextName || !nextPath || !deviceForUser(nextDeviceId, userId)) { json(res, 400, { error: '员工名称、Project 路径或设备无效' }); return }
        if (state.employees.some(item => !item.archived && item.id !== employee.id && item.userId === userId && item.name.toLowerCase() === nextName.toLowerCase())) { json(res, 409, { error: '员工名称已存在' }); return }
        const contextChanged = nextName !== employee.name || nextRole !== employee.role || nextInstructions !== employee.instructions
        const bindingChanged = nextPath !== employee.projectPath || nextDeviceId !== employee.deviceId
        Object.assign(employee, { name: nextName, role: nextRole, instructions: nextInstructions, projectPath: nextPath, deviceId: nextDeviceId, updatedAt: Date.now(), ...(contextChanged || bindingChanged ? { initializedThreadId: undefined } : {}), ...(bindingChanged ? { threadId: undefined } : {}) })
        await persist()
        json(res, 200, { employee: employeeView(employee) }); return
      }
      if (req.method !== 'POST' || !['ensure-thread', 'reset-thread'].includes(action || '')) { json(res, 405, { error: 'Method not allowed' }); return }
      const targetDevice = deviceForUser(employee.deviceId, userId)
      if (!targetDevice) { json(res, 404, { error: '员工绑定的设备不存在' }); return }
      if (!employee.projectPath) { json(res, 400, { error: '请先为员工绑定 Project 路径' }); return }
      if (action === 'ensure-thread' && employee.threadId) {
        json(res, 200, { employee: employeeView(employee), thread: { id: employee.threadId, name: employee.name, cwd: employee.projectPath } }); return
      }
      if (action === 'reset-thread' && employee.threadId) await rpc(targetDevice.id, `/api/threads/${employee.threadId}/archive`, 'POST', {})
      const started = await rpc(targetDevice.id, '/api/threads', 'POST', { cwd: employee.projectPath }) as { thread?: Record<string, unknown> }
      const threadId = typeof started.thread?.id === 'string' ? started.thread.id : ''
      if (!threadId) throw new Error('Codex 未返回员工 Thread ID')
      try { await rpc(targetDevice.id, `/api/threads/${threadId}/name`, 'POST', { name: employee.name }) } catch { /* Thread naming is an overlay; execution can continue. */ }
      employee.threadId = threadId
      employee.initializedThreadId = undefined
      employee.updatedAt = Date.now()
      await persist()
      json(res, 200, { employee: employeeView(employee), thread: { ...(started.thread || {}), id: threadId, name: employee.name, cwd: employee.projectPath } }); return
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) { json(res, 405, { error: 'Method not allowed' }); return }
    const allowed = req.method === 'GET'
      ? /^\/api\/(?:models|projects|settings|threads(?:\/[a-zA-Z0-9-]+(?:\/(?:status|incremental|queue))?)?|images\/[a-f0-9-]+)$/.test(url.pathname)
      : /^\/api\/(?:settings|threads|threads\/[a-zA-Z0-9-]+\/(?:send|stop|history|name|fork|archive|unarchive|delete|queue|steer)|threads\/[a-zA-Z0-9-]+\/queue\/[^/]+(?:\/(?:steer|delete))?|approvals\/[a-zA-Z0-9-]+)$/.test(url.pathname)
    const projectMutation = req.method === 'POST' && /^\/api\/projects(?:\/[a-zA-Z0-9-]+\/(?:update|delete))?$/.test(url.pathname)
    if ((!allowed && !(req.method === 'POST' && url.pathname === '/api/attachments') && !projectMutation) || url.search) { json(res, 404, { error: 'Not found' }); return }
    let requestData = req.method === 'POST' ? await body(req) : undefined
    const employeeId = typeof requestData?.employeeId === 'string' ? requestData.employeeId : ''
    const employee = employeeId ? employeeFor(employeeId, userId) : undefined
    const employeeNeedsContext = Boolean(employee && employee.threadId === url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/send$/)?.[1] && employee.initializedThreadId !== employee.threadId)
    if (employeeId && !employee) { json(res, 404, { error: '员工不存在' }); return }
    if (employee && (employee.deviceId !== device.id || employee.threadId !== url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/(?:send|queue|steer)$/)?.[1])) { json(res, 403, { error: '员工与当前设备或会话不匹配' }); return }
    if (employee && url.pathname.endsWith('/send')) {
      const assets = await rpc(device.id, '/api/employee-assets/prepare', 'POST', { userId, employeeId: employee.id, ...(employee.legacyMemory ? { legacyMemory: employee.legacyMemory, legacyMemoryDate: new Date(employee.createdAt).toISOString().slice(0, 10) } : {}) }) as { assetPath?: unknown; skillPath?: unknown }
      if (typeof assets?.assetPath !== 'string' || typeof assets.skillPath !== 'string') throw new Error('设备未能准备员工资产目录或 Skill')
      if (employee.legacyMemory) { delete employee.legacyMemory; await persist() }
      if (employeeNeedsContext) requestData = { ...requestData, text: `${employeeContext(employee, { assetPath: assets.assetPath, skillPath: assets.skillPath })}\n${typeof requestData?.text === 'string' ? requestData.text : ''}\n</rmdex_user_request>` }
    }
    if (requestData && 'employeeId' in requestData) {
      const forwarded = { ...requestData }
      delete forwarded.employeeId
      requestData = forwarded
    }
    const result = await rpc(device.id, url.pathname + url.search, req.method!, requestData)
    if (employee && employeeNeedsContext) {
      employee.initializedThreadId = employee.threadId
      employee.assetContextVersion = 1
      employee.updatedAt = Date.now()
      await persist()
    }
    const sendMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/send$/)
    if (sendMatch && result && typeof result === 'object') {
      const turn = (result as { turn?: { id?: string } }).turn
      if (turn?.id) watchTask(device.id, sendMatch[1]!, turn.id, employee?.name || (typeof requestData?.name === 'string' ? requestData.name : 'Codex 会话'))
    }
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
        ws.send(JSON.stringify({ type: 'ready', deviceId, employeeSkill }))
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
await ensureAdminUser()
server.listen(port, '0.0.0.0', () => console.log(`rmdex relay listening on ${port}`))
