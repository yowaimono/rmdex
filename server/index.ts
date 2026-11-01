import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Duplex } from 'node:stream'
import WebSocket from 'ws'
import { AttachmentStore, attachmentInput } from './attachments.ts'
import { ProjectStore } from './project-store.ts'
import { installEmployeeSkill } from './employee-assets.ts'
import { OperationJournal } from './desktop-adapter.ts'
import { MessageRetryService } from './message-retry.ts'
import { ArtifactRegistry } from './artifacts.ts'
import './remote-agent.ts'

await installEmployeeSkill().catch(error => console.error('[rmdex] Employee skill installation failed:', error.message))
const requestedMode = (process.env.RMDEX_CODEX_MODE || '').trim().toLowerCase()
const legacyDesktopMode = ['desktop-legacy', 'desktop-mcp'].includes(requestedMode)
if (legacyDesktopMode) {
  console.warn('[rmdex] Legacy Desktop MCP mode is enabled explicitly; use RMDEX_CODEX_MODE=desktop for the permission-aware app-server mode.')
  await import('./desktop-agent.ts')
} else {

// The local control API remains loopback-only. Remote access is relayed over
// an authenticated outbound connection from remote-agent.ts.
const codexExecutable = process.env.RMDEX_CODEX || (process.platform === 'win32' ? 'codex.cmd' : 'codex')
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
const sharedSocket = process.env.RMDEX_CODEX_SOCKET || join(codexHome, 'app-server-control', 'app-server-control.sock')
const sharedMode = ['shared', 'proxy'].includes(requestedMode)
const threadNamesPath = join(codexHome, 'rmdex-thread-names.json')
const projectStore = new ProjectStore(codexHome)
let threadNames: Record<string, string> = {}
const threadNamesReady = readFile(threadNamesPath, 'utf8').then(raw => { threadNames = JSON.parse(raw) }).catch(error => { if (error.code !== 'ENOENT') console.warn(`[rmdex] Thread names could not be loaded: ${error.message}`) })
let threadListCache: { expiresAt: number; data: Array<Record<string, unknown>> } | undefined
let threadListRequest: Promise<Array<Record<string, unknown>>> | undefined
const codexArgs = sharedMode ? ['app-server', 'proxy', '--sock', sharedSocket] : ['app-server']
console.log(`[rmdex] Codex connection mode: ${sharedMode ? `shared proxy (${sharedSocket})` : requestedMode === 'desktop' ? 'Desktop-compatible app-server' : 'standalone app-server'}`)
// Windows npm installs may expose Codex as a PowerShell shim. Node's spawn
// cannot execute .ps1 files directly, so invoke the shim explicitly instead
// of failing before the app-server has a chance to start.
const codexLaunch = process.platform === 'win32' && /\.ps1$/i.test(codexExecutable)
  ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', codexExecutable, ...codexArgs] }
  : process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(codexExecutable)
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', codexExecutable, ...codexArgs] }
    : { file: codexExecutable, args: codexArgs }
let codex: ChildProcess | undefined
let sharedConnection: WebSocket | undefined
let sharedConnectionAttempt: Promise<void> | undefined
let sharedReconnectTimer: NodeJS.Timeout | undefined
let sharedStableTimer: NodeJS.Timeout | undefined
let sharedReconnectDelay = 1000
let sharedConnectionState: 'ready' | 'connecting' | 'disconnected' = sharedMode ? 'disconnected' : 'ready'
let sharedConnectionError = ''
let shuttingDown = false
let sequence = 0
const pending = new Map<number, { connection?: WebSocket; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
const disconnectedConnections = new WeakSet<WebSocket>()
const images = new Map<string, string>()
const imageIds = new Map<string, string>()
const attachmentStore = new AttachmentStore()
const artifactRegistry = new ArtifactRegistry()
const threadCwds = new Map<string, string>()
const activeTurns = new Map<string, string>()
type LiveItem = { id: string; type: string; [key: string]: unknown }
type LiveTurn = { id: string; status: string; items: Map<string, LiveItem>; error?: unknown; sentText?: string }
const liveTurns = new Map<string, LiveTurn>()
const statusRefreshes = new Map<string, { expiresAt: number; request: Promise<void> }>()
const approvals = new Map<string, { id: string | number; method: string; params: Record<string, unknown> }>()
type UserInputQuestion = { header: string; id: string; question: string; options?: Array<{ label: string; description: string }> | null; isOther?: boolean; isSecret?: boolean }
type UserInputRequest = {
  id: string
  rpcId: string | number
  method: string
  params: { threadId: string; turnId: string; itemId: string; questions: UserInputQuestion[]; isBlocking: boolean }
  transport: 'local' | 'desktop-mirror'
  mirrorClientId?: string
}
const userInputs = new Map<string, UserInputRequest>()
function pendingUserInputs(threadId: string) {
  return [...userInputs.entries()].filter(([, request]) => request.params.threadId === threadId).map(([id, request]) => ({ id, method: request.method, params: request.params }))
}
const sending = new Set<string>()
const newThreads = new Map<string, Record<string, unknown>>()
const subscriptions = new Map<string, Promise<void>>()
function clearThreadRuntime(threadId: string) {
  statusRefreshes.delete(threadId)
  activeTurns.delete(threadId)
  liveTurns.delete(threadId)
  for (const [key, request] of approvals) if (request.params.threadId === threadId) approvals.delete(key)
  for (const [key, request] of userInputs) if (request.params.threadId === threadId) userInputs.delete(key)
  threadListCache = undefined
}
type PermissionMode = 'ask' | 'auto' | 'full'
let defaultPermissionMode: PermissionMode = ['ask', 'auto', 'full'].includes(process.env.RMDEX_DEFAULT_PERMISSION_MODE || '')
  ? process.env.RMDEX_DEFAULT_PERMISSION_MODE as PermissionMode
  : 'ask'
type CodexModel = {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort: string
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
  [key: string]: unknown
}
let modelCache: { expiresAt: number; data: CodexModel[] } | undefined
const port = Number(process.env.RMDEX_AGENT_PORT || 18787)
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

type ThreadRead = { thread?: { turns?: Array<{ items?: Array<Record<string, any>> }> } }
function applyThreadName(thread: Record<string, unknown>) {
  const id = typeof thread.id === 'string' ? thread.id : ''
  return id && threadNames[id] ? { ...thread, name: threadNames[id] } : thread
}
async function persistThreadNames() {
  await writeFile(threadNamesPath, JSON.stringify(threadNames, null, 2), { mode: 0o600 })
}
async function listThreads() {
  await threadNamesReady
  if (threadListCache && threadListCache.expiresAt > Date.now()) return threadListCache.data
  if (threadListRequest) return threadListRequest
  threadListRequest = rpc('thread/list', { limit: 100, sortKey: 'updated_at' }).then(raw => {
    const list = raw as { data?: Array<Record<string, unknown>> }
    const data = (list.data || []).map(applyThreadName)
    threadListCache = { expiresAt: Date.now() + 3000, data }
    return data
  }).finally(() => { threadListRequest = undefined })
  return threadListRequest
}
async function listThreadTurns(threadId: string, cursor?: string) {
  const page = await rpc('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) }) as { data?: Array<Record<string, unknown>>; nextCursor?: string | null }
  const turns = [...(page.data || [])].reverse()
  return { turns, page: { hasMore: Boolean(page.nextCursor), nextCursor: page.nextCursor || null } }
}
async function refreshThreadStatus(threadId: string) {
  const previous = statusRefreshes.get(threadId)
  if (previous && previous.expiresAt > Date.now()) return previous.request
  const refresh = { expiresAt: Infinity, request: Promise.resolve() }
  statusRefreshes.set(threadId, refresh)
  refresh.request = (async () => {
    const page = await rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' }) as { data?: Array<{ id: string; status: string; error?: unknown; items?: LiveItem[] }> }
    if (!Array.isArray(page.data)) throw new Error('Codex returned invalid turn history')
    const latest = page.data[0]
    if (latest && (typeof latest.id !== 'string' || !['inProgress', 'completed', 'interrupted', 'failed', 'error'].includes(latest.status))) throw new Error('Codex returned invalid turn status')
    // A lifecycle event or runtime reset after this read started is newer than
    // its snapshot. Keep that event and let the next poll reconcile again.
    if (statusRefreshes.get(threadId) !== refresh) return
    if (latest) {
      const live = liveTurns.get(threadId)
      const persistedItems = (latest.items || []).map(item => [item.id, item] as const)
      const liveItems = live?.id === latest.id ? [...live.items] : []
      liveTurns.set(threadId, {
        id: latest.id, status: latest.status, error: latest.error,
        sentText: live?.id === latest.id ? live.sentText : undefined,
        // Deltas may arrive while the snapshot is in flight. Preserve them
        // during streaming; terminal snapshots contain the final item values.
        items: new Map(latest.status === 'inProgress' ? [...persistedItems, ...liveItems] : [...liveItems, ...persistedItems]),
      })
    } else liveTurns.delete(threadId)
    if (latest?.status === 'inProgress') activeTurns.set(threadId, latest.id)
    else {
      activeTurns.delete(threadId)
      for (const [key, request] of approvals) if (request.params.threadId === threadId) approvals.delete(key)
    }
    refresh.expiresAt = Date.now() + 2000
  })().catch(error => {
    if (statusRefreshes.get(threadId) === refresh) statusRefreshes.delete(threadId)
    throw error
  })
  return refresh.request
}
function registerImages(result: unknown) {
  const thread = result as ThreadRead
  for (const turn of thread.thread?.turns || []) {
    for (const item of turn.items || []) {
      const parts = item.type === 'userMessage' ? item.content || [] : []
      for (const part of parts) registerImagePath(part, part.path)
      if (['imageView', 'imageGeneration'].includes(String(item.type))) {
        registerImagePath(item, item.path || item.savedPath)
      }
    }
  }
  while (images.size > 2000) {
    const first = images.keys().next().value!
    const path = images.get(first)
    images.delete(first)
    if (path && imageIds.get(path) === first) imageIds.delete(path)
  }
}
function registerImagePath(target: Record<string, unknown>, value: unknown) {
  if (typeof value !== 'string' || !isAbsolute(value) || !imageTypes[extname(value).toLowerCase()]) return
  const id = imageIds.get(value) || randomUUID()
  imageIds.set(value, id)
  images.set(id, value)
  target.assetUrl = `/api/images/${id}`
}
async function registerArtifacts(result: any, threadId: string) {
  const cwd = typeof result?.thread?.cwd === 'string' ? result.thread.cwd : threadCwds.get(threadId)
  if (cwd) { threadCwds.set(threadId, cwd); result.thread ||= {}; result.thread.cwd ||= cwd }
  const artifacts = await artifactRegistry.register(result, threadId)
  result.artifacts = artifacts
  for (const turn of result?.thread?.turns || []) turn.artifacts = artifacts.filter((artifact: { turnId: string }) => artifact.turnId === turn.id)
}

const desiredSubscriptions = new Set<string>()

function timestamp() { return new Date().toISOString() }
function sendMessage(message: unknown, callback?: (error?: Error | null) => void) {
  const payload = JSON.stringify(message)
  if (sharedMode) {
    if (!sharedConnection || sharedConnection.readyState !== WebSocket.OPEN) { callback?.(new Error(sharedConnectionError || 'Codex shared connection is not ready')); return }
    sharedConnection.send(payload, callback)
  } else if (codex?.stdin) codex.stdin.write(payload + '\n', callback)
  else callback?.(new Error('Codex app-server is not available'))
}
let desktopMirror: WebSocket | undefined
let desktopMirrorReconnect: NodeJS.Timeout | undefined
function desktopMirrorUrl() {
  if (process.env.RMDEX_DESKTOP_MIRROR_URL) return process.env.RMDEX_DESKTOP_MIRROR_URL
  const mirrorPort = Number(process.env.RMDEX_DESKTOP_MIRROR_PORT || 0)
  const mirrorToken = process.env.RMDEX_DESKTOP_MIRROR_TOKEN || ''
  return mirrorPort && mirrorToken ? `ws://127.0.0.1:${mirrorPort}/${mirrorToken}` : ''
}
function scheduleDesktopMirrorReconnect() {
  if (desktopMirrorReconnect || shuttingDown || !desktopMirrorUrl()) return
  desktopMirrorReconnect = setTimeout(() => { desktopMirrorReconnect = undefined; connectDesktopMirror() }, 1000)
}
function connectDesktopMirror() {
  const url = desktopMirrorUrl()
  if (!url || shuttingDown || (desktopMirror && [WebSocket.OPEN, WebSocket.CONNECTING].includes(desktopMirror.readyState))) return
  const connection = new WebSocket(url)
  desktopMirror = connection
  connection.on('open', () => console.log(`[${timestamp()}] Desktop question mirror ready`))
  connection.on('message', data => {
    try {
      const event = JSON.parse(data.toString()) as { type?: string; clientId?: string; requestId?: string; request?: { id?: string | number; method?: string; params?: UserInputRequest['params'] } }
      if (event.type === 'request' && event.clientId && event.requestId && event.request?.id !== undefined && event.request.params?.threadId && Array.isArray(event.request.params.questions)) {
        const id = `desktop-${event.clientId}-${event.requestId}`
        userInputs.set(id, { id, rpcId: event.request.id, method: event.request.method || 'item/tool/requestUserInput', params: event.request.params, transport: 'desktop-mirror', mirrorClientId: event.clientId })
      } else if (event.type === 'resolved' && event.clientId && event.requestId) {
        userInputs.delete(`desktop-${event.clientId}-${event.requestId}`)
      }
    } catch { console.error('Invalid Desktop mirror event') }
  })
  const clear = () => {
    if (desktopMirror === connection) desktopMirror = undefined
    for (const [key, request] of userInputs) if (request.transport === 'desktop-mirror') userInputs.delete(key)
    scheduleDesktopMirrorReconnect()
  }
  connection.on('error', clear)
  connection.on('close', clear)
}
function sendUserInputResponse(request: UserInputRequest, result: unknown) {
  if (request.transport === 'desktop-mirror') {
    if (!desktopMirror || desktopMirror.readyState !== WebSocket.OPEN || !request.mirrorClientId) throw new Error('Codex Desktop 提问通道已断开')
    desktopMirror.send(JSON.stringify({ type: 'response', clientId: request.mirrorClientId, requestId: String(request.rpcId), result }))
    return
  }
  sendMessage({ id: request.rpcId, result })
}
function handleMessage(line: string) {
  try {
    const message = JSON.parse(line)
    if (message.method && message.id !== undefined) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
        approvals.set(String(message.id), { id: message.id, method: message.method, params: message.params || {} })
      } else if (['item/tool/requestUserInput', 'item/tool/request_user_input'].includes(String(message.method)) && message.params?.threadId && Array.isArray(message.params?.questions)) {
        const id = String(message.id)
        userInputs.set(id, { id, rpcId: message.id, method: message.method, params: message.params, transport: 'local' })
      } else if (!sharedMode) {
        sendMessage({ id: message.id, error: { code: -32601, message: 'This client does not support this request' } })
      } else {
        console.warn(`Unsupported shared Codex request: ${message.method}`)
      }
      return
    }
    if (message.method === 'turn/started' && message.params?.threadId && message.params?.turn?.id) {
      const { threadId, turn } = message.params
      statusRefreshes.delete(threadId)
      activeTurns.set(threadId, turn.id)
      if (liveTurns.get(threadId)?.id !== turn.id) liveTurns.set(threadId, { id: turn.id, status: 'inProgress', items: new Map() })
    }
    if (['item/started', 'item/completed'].includes(message.method) && message.params?.threadId && message.params?.item?.id) {
      const { threadId, turnId, item } = message.params
      const live = liveTurns.get(threadId)
      if (live && live.id === turnId) live.items.set(item.id, item)
    }
    if (message.method === 'item/agentMessage/delta' && message.params?.threadId && message.params?.itemId && typeof message.params.delta === 'string') {
      const { threadId, turnId, itemId, delta } = message.params
      const live = liveTurns.get(threadId)
      if (live && live.id === turnId) {
        const item = live.items.get(itemId) || { id: itemId, type: 'agentMessage', text: '' }
        item.text = (String(item.text || '') + delta).slice(0, 1_000_000)
        live.items.set(itemId, item)
      }
    }
    if (message.method === 'turn/completed' && message.params?.threadId && message.params?.turn?.id) {
      const { threadId, turn } = message.params
      statusRefreshes.delete(threadId)
      if (activeTurns.get(threadId) === turn.id) activeTurns.delete(threadId)
      const live = liveTurns.get(threadId)
      if (live && live.id === turn.id) { live.status = turn.status; live.error = turn.error }
      else if (!activeTurns.has(threadId)) liveTurns.set(threadId, { id: turn.id, status: turn.status, error: turn.error, items: new Map((turn.items || []).map((item: LiveItem) => [item.id, item])) })
      if (!activeTurns.has(threadId)) for (const [key, request] of approvals) if (request.params.threadId === threadId) approvals.delete(key)
    }
    if (message.method === 'serverRequest/resolved') {
      approvals.delete(String(message.params?.requestId))
      for (const [key, request] of userInputs) if (String(request.rpcId) === String(message.params?.requestId)) userInputs.delete(key)
    }
    if (message.method === 'thread/reverted' && message.params?.threadId) clearThreadRuntime(message.params.threadId)
    if (typeof message.id !== 'number' || !pending.has(message.id)) return
    const request = pending.get(message.id)!
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message || 'Codex request failed'))
    else request.resolve(message.result)
  } catch { console.error('Invalid app-server response') }
}
if (!sharedMode) {
  codex = spawn(codexLaunch.file, codexLaunch.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  codex.stderr?.on('data', data => console.error(`[${timestamp()}] Codex app-server: ${String(data).trim()}`))
  codex.on('error', error => { sharedConnectionError = `Codex app-server failed: ${error.message}`; console.error(`[${timestamp()}] ${sharedConnectionError}`) })
  codex.on('exit', (code, signal) => { sharedConnectionState = 'disconnected'; sharedConnectionError = `Codex app-server exited (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`; console.error(`[${timestamp()}] ${sharedConnectionError}`) })
  createInterface({ input: codex.stdout! }).on('line', handleMessage)
}

async function connectShared() {
  const child = spawn(codexLaunch.file, codexLaunch.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const connection = new WebSocket('ws://localhost/rpc', {
    createConnection: () => Duplex.from({ readable: child.stdout!, writable: child.stdin! }),
    handshakeTimeout: 10000,
  })
  codex = child
  sharedConnection = connection
  sharedConnectionState = 'connecting'
  child.stderr?.on('data', data => console.error(`[${timestamp()}] Codex shared proxy: ${String(data).trim()}`))
  child.on('error', error => disconnectShared(connection, `Codex shared proxy error: ${error.message}`))
  child.on('exit', (code, signal) => {
    const message = `Codex shared proxy exited (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})`
    console.error(`[${timestamp()}] ${message}`)
    disconnectShared(connection, message, false)
  })
  connection.on('message', data => { if (sharedConnection === connection) handleMessage(data.toString()) })
  connection.on('error', error => disconnectShared(connection, `Codex shared WebSocket error: ${error.message}`))
  connection.on('close', (code, reason) => disconnectShared(connection, `Codex shared WebSocket closed (code ${code}${reason.length ? `, reason: ${reason.toString()}` : ''})`))

  try {
    await new Promise<void>((resolve, reject) => {
      connection.once('open', resolve)
      connection.once('error', reject)
      connection.once('close', (code, reason) => reject(new Error(`WebSocket closed before open (code ${code}${reason.length ? `, reason: ${reason.toString()}` : ''})`)))
    })
    await rpc('initialize', { clientInfo: { name: 'rmdex', version: '0.0.1' }, capabilities: { experimentalApi: true } }, true)
    sendMessage({ method: 'initialized', params: {} })
    if (sharedConnection !== connection) throw new Error(sharedConnectionError || 'Codex shared connection closed during initialization')
    sharedConnectionState = 'ready'
    sharedConnectionError = ''
    if (sharedStableTimer) clearTimeout(sharedStableTimer)
    sharedStableTimer = setTimeout(() => { sharedReconnectDelay = 1000; sharedStableTimer = undefined }, 30000)
    console.log(`[${timestamp()}] Codex shared connection ready`)
    const resubscribe = [...desiredSubscriptions]
    subscriptions.clear()
    for (const threadId of resubscribe) void subscribeToThread(threadId).catch(error => console.error(`[${timestamp()}] Could not restore subscription for ${threadId}: ${error instanceof Error ? error.message : String(error)}`))
  } catch (error) {
    disconnectShared(connection, error instanceof Error ? error.message : String(error))
    throw error
  }
}

function disconnectShared(connection: WebSocket, message: string, log = true) {
  if (disconnectedConnections.has(connection) || sharedConnection !== connection) return
  disconnectedConnections.add(connection)
  sharedConnection = undefined
  sharedConnectionState = 'disconnected'
  sharedConnectionError = message
  if (log) console.error(`[${timestamp()}] ${message}`)
  if (sharedStableTimer) { clearTimeout(sharedStableTimer); sharedStableTimer = undefined }
  activeTurns.clear()
  liveTurns.clear()
  statusRefreshes.clear()
  approvals.clear()
  subscriptions.clear()
  for (const [id, request] of pending) {
    if (request.connection !== connection) continue
    clearTimeout(request.timer)
    request.reject(new Error(message))
    pending.delete(id)
  }
  if (codex?.exitCode === null) codex.kill()
  if (!shuttingDown && !sharedReconnectTimer) {
    const delay = sharedReconnectDelay
    sharedReconnectDelay = Math.min(sharedReconnectDelay * 2, 30000)
    sharedReconnectTimer = setTimeout(() => {
      sharedReconnectTimer = undefined
      void ensureSharedConnected().catch(() => {})
    }, delay)
  }
}

function ensureSharedConnected(): Promise<void> {
  if (!sharedMode || sharedConnectionState === 'ready') return Promise.resolve()
  if (sharedConnectionAttempt) return sharedConnectionAttempt
  if (sharedReconnectTimer) { clearTimeout(sharedReconnectTimer); sharedReconnectTimer = undefined }
  const attempt = connectShared()
  sharedConnectionAttempt = attempt
  void attempt.finally(() => { if (sharedConnectionAttempt === attempt) sharedConnectionAttempt = undefined }).catch(() => {})
  return attempt
}

async function rpc(method: string, params: unknown, allowConnecting = false): Promise<unknown> {
  if (sharedMode && !allowConnecting) await ensureSharedConnected()
  const connection = sharedConnection
  if (sharedMode && (!connection || connection.readyState !== WebSocket.OPEN)) throw new Error(sharedConnectionError || 'Codex shared connection is not ready')
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex request timed out')) }, 15000)
    pending.set(id, { connection, resolve, reject, timer })
    sendMessage({ id, method, params }, error => {
      if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(error) }
    })
  })
}

async function listModels() {
  if (modelCache && modelCache.expiresAt > Date.now()) return modelCache.data
  const data: CodexModel[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page += 1) {
    const result = await rpc('model/list', { limit: 100, includeHidden: false, cursor }) as { data?: CodexModel[]; nextCursor?: string | null }
    if (Array.isArray(result.data)) data.push(...result.data.filter(model => model && typeof model.id === 'string'))
    if (!result.nextCursor || result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  modelCache = { expiresAt: Date.now() + 5000, data }
  return data
}

function subscribeToThread(threadId: string) {
  desiredSubscriptions.add(threadId)
  let subscription = subscriptions.get(threadId)
  if (!subscription) {
    subscription = rpc('thread/resume', { threadId, excludeTurns: true }).then(() => {}).catch(error => {
      // Desktop may already own the thread writer. Historical reads remain
      // valid in that case; only live event subscription is unavailable.
      const message = error instanceof Error ? error.message : String(error)
      if (/active writer/i.test(message)) {
        console.warn(`[rmdex] thread ${threadId} is already owned by another writer; continuing without live subscription`)
        return
      }
      throw error
    })
    subscriptions.set(threadId, subscription)
    subscription.catch(() => { if (subscriptions.get(threadId) === subscription) subscriptions.delete(threadId) })
  }
  return subscription
}

async function ensureReady() {
  if (sharedMode) return ensureSharedConnected()
  if (!standaloneReady) {
    standaloneReady = rpc('initialize', { clientInfo: { name: 'rmdex', version: '0.3.3' }, capabilities: { experimentalApi: true } }).then(() => { sendMessage({ method: 'initialized', params: {} }) })
  }
  return standaloneReady
}

let standaloneReady: Promise<void> | undefined
void (sharedMode ? ensureSharedConnected() : ensureReady()).catch(error => console.error(`[${timestamp()}] Codex initialization failed: ${error.message}`))
if (desktopMirrorUrl()) connectDesktopMirror()

const messageRetries = new MessageRetryService(rpc, new OperationJournal(join(codexHome, 'rmdex-message-retries.json')), clearThreadRuntime, async (id, original) => {
  const directory = join(codexHome, 'rmdex-retry-backups')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, `${id}.json`), JSON.stringify(original), { mode: 0o600, flag: 'wx' })
})

async function turnOptions(data: Record<string, any>) {
  const permissionMode = data.permissionMode === undefined ? defaultPermissionMode : data.permissionMode
  if (!['ask', 'auto', 'full'].includes(permissionMode)) throw new Error('请选择有效的权限模式')
  const models = (data.model !== undefined || data.effort !== undefined) ? await listModels() : []
  const selectedModel = typeof data.model === 'string' && data.model.trim() ? models.find(model => model.id === data.model) : undefined
  if (data.model !== undefined && !selectedModel) throw new Error('所选模型不在当前 Codex 主机的模型列表中')
  if (data.effort !== undefined && (typeof data.effort !== 'string' || !selectedModel?.supportedReasoningEfforts?.some(option => option.reasoningEffort === data.effort))) throw new Error('所选推理强度不受当前模型支持')
  const permissions = permissionMode === 'full'
    ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }
    : { approvalPolicy: 'on-request', approvalsReviewer: permissionMode === 'auto' ? 'auto_review' : 'user', sandboxPolicy: { type: 'workspaceWrite' } }
  return { ...permissions, ...(selectedModel ? { model: selectedModel.id, effort: data.effort } : {}) }
}

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  const host = req.headers.host || ''
  const origin = req.headers.origin
  if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host) || (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
    res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return
  }
  if (!['GET', 'POST', 'DELETE'].includes(req.method || '')) { res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed' })); return }
  if (req.method === 'POST' && ((!/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin || '')) || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))) {
    res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost:18787')
    if (url.pathname === '/api/health') {
      const ready = !sharedMode || sharedConnectionState === 'ready'
      res.writeHead(ready ? 200 : 503)
      res.end(JSON.stringify({ ok: ready, state: sharedMode ? sharedConnectionState : 'ready', error: ready ? undefined : sharedConnectionError }))
      return
    }
    const artifactMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/artifacts\/([a-zA-Z0-9-]+)\/(content|preview)$/)
    if (req.method === 'GET' && artifactMatch) {
      const artifact = artifactRegistry.resolve(artifactMatch[2]!)
      if (artifact?.threadId !== artifactMatch[1]) { res.writeHead(404).end(JSON.stringify({ error: 'Artifact not found' })); return }
      if (!artifact) { res.writeHead(404).end(JSON.stringify({ error: 'Artifact not found' })); return }
      const info = await stat(artifact.path).catch(() => null)
      if (!info?.isFile() || info.size !== artifact.size) { res.writeHead(404).end(JSON.stringify({ error: 'Artifact unavailable' })); return }
      if (artifactMatch[3] === 'preview' && artifact.previewMode === 'downloadOnly') { res.writeHead(415).end(JSON.stringify({ error: '此文件类型仅支持下载' })); return }
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
      let start = 0; let end = info.size - 1; let status = 200
      if (range) {
        if (!range[1] && !range[2]) { res.writeHead(416).end(); return }
        if (!range[1]) { start = Math.max(0, info.size - Number(range[2])) }
        else start = Number(range[1])
        if (range[2]) end = Math.min(end, Number(range[2]))
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return }
        status = 206
      }
      res.setHeader('Content-Type', artifact.mimeType)
      res.setHeader('Content-Length', String(end - start + 1))
      if (status === 206) res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`)
      const inline = artifactMatch[3] === 'preview' && artifact.previewMode !== 'downloadOnly'
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (info.size === 0) { res.writeHead(status); res.end(); return }
      createReadStream(artifact.path, { start, end }).on('error', () => { if (!res.headersSent) res.writeHead(404); res.end() }).pipe(res)
      return
    }
    await ensureReady()
    let result: unknown
    if (req.method === 'POST' || req.method === 'DELETE') {
      let body = ''
      if (req.method === 'POST') for await (const chunk of req) {
        body += chunk.toString()
        if (body.length > 12 * 1024 * 1024) throw new Error('请求过大')
      }
      const data = body ? JSON.parse(body) : {}
      const sendMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/send$/)
      const retryMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/retry$/)
      const stopMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/stop$/)
      const historyMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/history$/)
      const renameMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/name$/)
      const archiveMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/(archive|unarchive)$/)
      const deleteMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/delete$/)
      const forkMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/fork$/)
      const queueMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/(queue|steer)$/)
      const queueDeletePostMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/queue\/([^/]+)\/delete$/)
      const queueDeleteMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/queue\/([^/]+)$/)
      const queueSteerMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/queue\/([^/]+)\/steer$/)
      const approvalMatch = url.pathname.match(/^\/api\/approvals\/([a-zA-Z0-9-]+)$/)
      const userInputMatch = url.pathname.match(/^\/api\/user-input\/([a-zA-Z0-9-]+)$/)
      const projectUpdateMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/update$/)
      const projectDeleteMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/delete$/)
      if (url.pathname === '/api/attachments') {
        result = await attachmentStore.add(data)
        res.writeHead(201)
      } else if (url.pathname === '/api/projects') {
        result = await projectStore.create(data)
        res.writeHead(201)
      } else if (projectUpdateMatch) {
        result = await projectStore.update(projectUpdateMatch[1]!, data)
      } else if (projectDeleteMatch) {
        result = await projectStore.delete(projectDeleteMatch[1]!)
      } else if (url.pathname === '/api/settings') {
        if (!['ask', 'auto', 'full'].includes(data.permissionMode)) throw new Error('请选择有效的权限模式')
        defaultPermissionMode = data.permissionMode as PermissionMode
        result = { permissionMode: defaultPermissionMode }
      } else if (url.pathname === '/api/threads') {
        if (typeof data.cwd !== 'string' || !data.cwd.trim() || !isAbsolute(data.cwd.trim())) throw new Error('请输入工作目录的绝对路径')
        const cwd = data.cwd.trim()
        const info = await stat(cwd).catch(() => null)
        if (!info?.isDirectory()) throw new Error('工作目录不存在或不是文件夹')
        const started = await rpc('thread/start', { cwd }) as { thread?: Record<string, unknown> }
        if (typeof started.thread?.id !== 'string') throw new Error('Codex 未返回会话 ID')
        newThreads.set(started.thread.id, started.thread)
        threadCwds.set(started.thread.id, cwd)
        threadListCache = undefined
        result = { thread: started.thread }
      } else if (forkMatch) {
        const threadId = forkMatch[1]!
        if (data.lastTurnId !== undefined && (typeof data.lastTurnId !== 'string' || !data.lastTurnId.trim() || data.lastTurnId.length > 256)) throw new Error('缺少有效的 Fork 回合 ID')
        const lastTurnId = typeof data.lastTurnId === 'string' ? data.lastTurnId.trim() : undefined
        if (lastTurnId && activeTurns.get(threadId) === lastTurnId) throw new Error('当前回合仍在执行，结束后再从这里分叉')
        const source = newThreads.get(threadId) || { id: threadId, name: threadNames[threadId] || null }
        const requestedName = typeof data.name === 'string' ? data.name.trim() : ''
        const sourceName = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : '未命名会话'
        const name = (requestedName || `${sourceName} 副本`).slice(0, 80)
        const forked = await rpc('thread/fork', { threadId, ...(lastTurnId ? { lastTurnId } : {}), excludeTurns: true }) as { thread?: Record<string, unknown> }
        if (typeof forked.thread?.id !== 'string') throw new Error('Codex 未返回 Fork 后的新会话 ID')
        const forkedId = forked.thread.id
        newThreads.set(forkedId, { ...forked.thread, name })
        try { await rpc('thread/name/set', { threadId: forkedId, name }) } catch (error) { console.warn(`[rmdex] Fork thread rename unavailable, using rmdex overlay: ${error instanceof Error ? error.message : String(error)}`) }
        threadNames[forkedId] = name
        await persistThreadNames()
        threadListCache = undefined
        result = { thread: applyThreadName({ ...forked.thread, name }), sourceThreadId: threadId }
      } else if (renameMatch) {
        const threadId = renameMatch[1]!
        if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80) throw new Error('会话名称不能为空且不能超过 80 个字符')
        await threadNamesReady
        if (!newThreads.has(threadId)) {
          if (sharedMode) await subscribeToThread(threadId)
          else await rpc('thread/resume', { threadId, excludeTurns: true })
        }
        try { await rpc('thread/name/set', { threadId, name: data.name.trim() }) } catch (error) { console.warn(`[rmdex] Codex thread rename unavailable, using rmdex overlay: ${error instanceof Error ? error.message : String(error)}`) }
        threadNames[threadId] = data.name.trim()
        await persistThreadNames()
        threadListCache = undefined
        result = { threadId, name: threadNames[threadId] }
      } else if (archiveMatch) {
        const threadId = archiveMatch[1]!
        await rpc(`thread/${archiveMatch[2]}`, { threadId })
        threadListCache = undefined
        result = { threadId, archived: archiveMatch[2] === 'archive' }
      } else if (deleteMatch) {
        const threadId = deleteMatch[1]!
        await rpc('thread/delete', { threadId })
        threadListCache = undefined
        newThreads.delete(threadId)
        desiredSubscriptions.delete(threadId)
        liveTurns.delete(threadId)
        activeTurns.delete(threadId)
        result = { threadId, deleted: true }
      } else if (queueMatch) {
        const threadId = queueMatch[1]!
        if (sending.has(threadId)) throw new Error('此会话正在提交或重试消息，请稍后再试')
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 32000) throw new Error('消息不能为空或超出长度限制')
        if (sharedMode && !newThreads.has(threadId)) await subscribeToThread(threadId)
        const input = [{ type: 'text', text: data.text, text_elements: [] }]
        if (queueMatch[2] === 'queue') {
          const queued = await rpc('thread/queue/add', { threadId, input, clientUserMessageId: typeof data.clientUserMessageId === 'string' ? data.clientUserMessageId : randomUUID() })
          // add alone persists an idle submission but does not start it. Read
          // native state as shared Desktop turns may predate our subscription.
          const metadata = await rpc('thread/read', { threadId, includeTurns: false }) as { thread?: { status?: { type?: string } } }
          const running = metadata.thread?.status?.type === 'active' || activeTurns.has(threadId)
          let started: unknown
          if (!running) {
            try { started = await rpc('thread/queue/start', { threadId }) }
            catch (error) {
              // The app-server may consume queue/add between our status read
              // and queue/start. Do not turn an accepted submission into a
              // client-visible failure or retry it.
              if (!/queue is empty/i.test(error instanceof Error ? error.message : String(error))) throw error
            }
          }
          result = { outcome: 'queued', threadId, queuedSubmission: (queued as { queuedSubmission?: unknown }).queuedSubmission || null, ...(started && typeof started === 'object' ? started : {}) }
          statusRefreshes.delete(threadId)
        } else {
          const expectedTurnId = typeof data.expectedTurnId === 'string' && data.expectedTurnId ? data.expectedTurnId : activeTurns.get(threadId)
          if (!expectedTurnId) throw new Error('当前没有可引导的运行中任务')
          const steered = await rpc('turn/steer', { threadId, expectedTurnId, input, clientUserMessageId: typeof data.clientUserMessageId === 'string' ? data.clientUserMessageId : randomUUID() })
          result = { outcome: 'steered', threadId, expectedTurnId, ...(steered && typeof steered === 'object' ? steered : {}) }
        }
      } else if ((queueDeletePostMatch && req.method === 'POST') || (queueDeleteMatch && req.method === 'DELETE')) {
        const match = queueDeletePostMatch || queueDeleteMatch!
        const threadId = match[1]!
        const queuedSubmissionId = decodeURIComponent(match[2]!)
        if (sharedMode && !newThreads.has(threadId)) await subscribeToThread(threadId)
        result = await rpc('thread/queue/delete', { threadId, queuedSubmissionId })
      } else if (queueSteerMatch) {
        const threadId = queueSteerMatch[1]!
        const queuedSubmissionId = decodeURIComponent(queueSteerMatch[2]!)
        if (sharedMode && !newThreads.has(threadId)) await subscribeToThread(threadId)
        const queued = await rpc('thread/queue/list', { threadId, limit: 100 }) as { data?: Array<{ id?: string; input?: unknown; clientUserMessageId?: string }> }
        const submission = queued.data?.find(item => item.id === queuedSubmissionId)
        if (!submission?.id || !Array.isArray(submission.input)) throw new Error('排队任务不存在或已执行')
        const expectedTurnId = typeof data.expectedTurnId === 'string' && data.expectedTurnId ? data.expectedTurnId : activeTurns.get(threadId)
        if (!expectedTurnId) throw new Error('当前没有可引导的运行中任务')
        const steered = await rpc('turn/steer', { threadId, expectedTurnId, input: submission.input, clientUserMessageId: submission.clientUserMessageId || randomUUID() })
        const deleted = await rpc('thread/queue/delete', { threadId, queuedSubmissionId }) as { deleted?: boolean }
        result = { outcome: 'steered', threadId, expectedTurnId, queuedSubmissionId, deleted: deleted.deleted !== false, ...(steered && typeof steered === 'object' ? steered : {}) }
      } else if (historyMatch) {
        const threadId = historyMatch[1]!
        if (typeof data.cursor !== 'string' || !data.cursor || data.cursor.length > 4096) throw new Error('缺少有效历史游标')
        if (sharedMode && !newThreads.has(threadId)) await subscribeToThread(threadId)
        const page = await listThreadTurns(threadId, data.cursor)
        const base = newThreads.get(threadId) || { id: threadId, name: threadNames[threadId] || null }
        result = { thread: { ...applyThreadName(base), turns: page.turns }, page: page.page }
        const read = result as { thread?: Record<string, unknown> }
        if (read.thread) read.thread = applyThreadName(read.thread)
        registerImages(result)
        const live = liveTurns.get(threadId)
        await registerArtifacts(result, threadId)
        result = { ...(result as object), activeTurnId: activeTurns.get(threadId) || null, lastTurn: live ? { id: live.id, status: live.status, error: live.error } : null, approvals: [...approvals.entries()].filter(([, request]) => request.params.threadId === threadId).map(([id, request]) => ({ id, method: request.method, params: request.params })), userInputs: pendingUserInputs(threadId) }
      } else if (retryMatch) {
        const threadId = retryMatch[1]!
        const options = await turnOptions(data)
        if (sending.has(threadId)) throw new Error('此会话的发送请求正在处理中')
        sending.add(threadId)
        try {
          if (sharedMode) await subscribeToThread(threadId)
          else await rpc('thread/resume', { threadId, excludeTurns: true })
          const retried = await messageRetries.retry(threadId, data, options)
          if (retried.thread?.id) {
            threadListCache = undefined
            if (retried.forked && !threadNames[retried.thread.id]) {
              const sourceName = threadNames[threadId] || retried.thread.name || retried.thread.preview || '会话'
              threadNames[retried.thread.id] = `${sourceName} · 重试`.slice(0, 80)
              await persistThreadNames()
            }
            retried.thread = applyThreadName(retried.thread)
          }
          if (retried.outcome === 'started' && retried.turn?.id) {
            const targetId = retried.threadId
            statusRefreshes.delete(targetId)
            const page = await listThreadTurns(targetId)
            const current = page.turns.find(turn => turn.id === retried.turn.id)
            if (current) retried.turn = { ...retried.turn, status: current.status }
            if (retried.turn.status === 'inProgress') {
              activeTurns.set(targetId, retried.turn.id)
              if (liveTurns.get(targetId)?.id !== retried.turn.id) liveTurns.set(targetId, { id: retried.turn.id, status: 'inProgress', items: new Map() })
            }
          }
          result = retried
        } finally { sending.delete(threadId) }
      } else if (sendMatch) {
        const threadId = sendMatch[1]!
        const attachments = attachmentStore.resolve(data.attachments)
        const text = typeof data.text === 'string' ? data.text.trim() : ''
        if ((!text && !attachments.length) || text.length > 32000) throw new Error('消息不能为空或超过长度限制')
        const options = await turnOptions(data)
        if (sending.has(threadId) || activeTurns.has(threadId)) throw new Error('此会话正在执行，请等待结束')
        sending.add(threadId)
        try {
          if (!newThreads.has(threadId)) {
            if (sharedMode) await subscribeToThread(threadId)
            else await rpc('thread/resume', { threadId, excludeTurns: true })
          }
          const input = attachmentInput(text, attachments)
          const started = await rpc('turn/start', { threadId, input, ...options }) as { turn?: { id: string; status?: string } }
          statusRefreshes.delete(threadId)
          newThreads.delete(threadId)
          if (started.turn?.id) {
            let live = liveTurns.get(threadId)
            if (!live || live.id !== started.turn.id) { live = { id: started.turn.id, status: started.turn.status || 'inProgress', items: new Map() }; liveTurns.set(threadId, live) }
            live.sentText = input.find(part => part.type === 'text')?.text || text
          }
          if (started.turn?.id && started.turn.status === 'inProgress' && (!liveTurns.has(threadId) || liveTurns.get(threadId)?.status === 'inProgress')) activeTurns.set(threadId, started.turn.id)
          result = started
        } finally { sending.delete(threadId) }
      } else if (stopMatch) {
        const threadId = stopMatch[1]!
        const turnId = activeTurns.get(threadId)
        if (!turnId) throw new Error('没有由本客户端启动的运行中任务')
        result = await rpc('turn/interrupt', { threadId, turnId })
      } else if (approvalMatch) {
        const request = approvals.get(approvalMatch[1]!)
        if (!request || !['accept', 'decline'].includes(data.decision)) throw new Error('审批请求已失效')
        approvals.delete(approvalMatch[1]!)
        sendMessage({ id: request.id, result: { decision: data.decision } })
        result = { ok: true }
      } else if (userInputMatch) {
        const request = userInputs.get(userInputMatch[1]!)
        if (!request || !data.answers || typeof data.answers !== 'object') throw new Error('问题已失效')
        const answers: Record<string, { answers: string[] }> = {}
        for (const question of request.params.questions) {
          const answer = data.answers[question.id]
          if (!answer || !Array.isArray(answer.answers) || answer.answers.some((value: unknown) => typeof value !== 'string')) throw new Error('问题答案格式无效')
          answers[question.id] = { answers: answer.answers }
        }
        sendUserInputResponse(request, { answers })
        userInputs.delete(userInputMatch[1]!)
        result = { ok: true }
      } else { res.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return }
    } else if (url.pathname === '/api/settings') {
      result = { permissionMode: defaultPermissionMode, mode: sharedMode ? 'shared' : 'standalone' }
    } else if (/^\/api\/threads\/[a-zA-Z0-9-]+\/queue$/.test(url.pathname)) {
      const threadId = url.pathname.split('/')[3]!
      if (sharedMode && !newThreads.has(threadId)) await subscribeToThread(threadId)
      result = await rpc('thread/queue/list', { threadId, limit: 100 })
    } else if (url.pathname === '/api/projects') {
      result = { data: await projectStore.list() }
    } else if (url.pathname === '/api/models') {
      result = {
        data: await listModels(),
        capabilities: {
          mode: 'app-server',
          models: true,
          permissions: true,
          stop: true,
          approvals: true,
          create: true,
          send: true,
          retry: true,
          queue: true,
          steer: true,
          rename: true,
          fork: true,
          archive: true,
          delete: true,
          history: false,
          createRequiresPrompt: false,
        },
      }
    } else if (url.pathname === '/api/threads') {
      const data = await listThreads()
      const listed = new Set(data.map(thread => String(thread.id)))
      result = { data: [...[...newThreads.values()].filter(thread => !listed.has(String(thread.id))).map(applyThreadName), ...data] }
    } else if (/^\/api\/threads\/[a-zA-Z0-9-]+\/incremental$/.test(url.pathname)) {
      const threadId = url.pathname.split('/')[3]!
      if (sharedMode && !newThreads.has(threadId)) await subscribeToThread(threadId)
      const page = await listThreadTurns(threadId)
      const base = newThreads.get(threadId) || { id: threadId, name: threadNames[threadId] || null }
      const live = liveTurns.get(threadId)
      result = { thread: { ...applyThreadName(base), turns: page.turns }, page: page.page, activeTurnId: activeTurns.get(threadId) || null, lastTurn: live ? { id: live.id, status: live.status, error: live.error } : null, approvals: [...approvals.entries()].filter(([, request]) => request.params.threadId === threadId).map(([id, request]) => ({ id, method: request.method, params: request.params })), userInputs: pendingUserInputs(threadId) }
      await registerArtifacts(result, threadId)
      registerImages(result)
    } else if (/^\/api\/threads\/[a-zA-Z0-9-]+\/status$/.test(url.pathname)) {
      const threadId = url.pathname.split('/')[3]!
      await refreshThreadStatus(threadId)
      const live = liveTurns.get(threadId)
      const statusArtifacts = live ? await artifactRegistry.register({ thread: { cwd: threadCwds.get(threadId), turns: [{ id: live.id, status: live.status, items: [...live.items.values()] }] } }, threadId) : []
      result = {
        threadId,
        activeTurnId: activeTurns.get(threadId) || null,
        approvals: [...approvals.entries()]
          .filter(([, request]) => request.params.threadId === threadId)
          .map(([id, request]) => ({ id, method: request.method, params: request.params })),
        userInputs: [...userInputs.entries()].filter(([, request]) => request.params.threadId === threadId).map(([id, request]) => ({ id, method: request.method, params: request.params })),
        artifacts: statusArtifacts,
        lastTurn: live ? { id: live.id, status: live.status, error: live.error } : null,
        live: live ? { turnId: live.id, status: live.status, error: live.error, sentText: live.sentText, items: [...live.items.values()] } : null,
      }
    } else if (/^\/api\/threads\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
      const threadId = url.pathname.split('/').pop()
      if (sharedMode && !newThreads.has(threadId!)) await subscribeToThread(threadId!)
      try {
        const metadata = await rpc('thread/read', { threadId, includeTurns: false }) as { thread?: Record<string, unknown> }
        const page = await listThreadTurns(threadId!)
        result = { thread: { ...(metadata.thread || { id: threadId }), turns: page.turns }, page: page.page }
      }
      catch (error) {
        try { result = await rpc('thread/read', { threadId, includeTurns: true }) }
        catch {
          const thread = newThreads.get(threadId!)
          if (!thread) throw error
          result = { thread: { ...thread, turns: [] }, page: { hasMore: false, nextCursor: null } }
        }
      }
      if ((result as { thread?: Record<string, unknown> }).thread) {
        (result as { thread: Record<string, unknown> }).thread = applyThreadName((result as { thread: Record<string, unknown> }).thread)
      }
      await registerArtifacts(result, threadId!)
      const currentRead = result as { thread?: { turns?: Array<{ id: string; status: string }> } }
      const runningTurn = currentRead.thread?.turns?.findLast(turn => turn.status === 'inProgress')
      if (sharedMode && runningTurn && !activeTurns.has(threadId!)) {
        activeTurns.set(threadId!, runningTurn.id)
        if (!liveTurns.has(threadId!)) liveTurns.set(threadId!, { id: runningTurn.id, status: runningTurn.status, items: new Map() })
      }
      const live = liveTurns.get(threadId!)
      const read = result as { thread: { turns?: Array<{ id: string; status: string; items: LiveItem[] }> } }
      if (live && read.thread) {
        const turns = read.thread.turns ||= []
        let turn = turns.find(item => item.id === live.id)
        if (!turn) { turn = { id: live.id, status: live.status, items: [] }; turns.push(turn) }
        turn.status = live.status
        const hasUserInput = [...turn.items, ...live.items.values()].some(item => item.type === 'userMessage' && Array.isArray(item.content) && item.content.some((part: { text?: string }) => part.text === live.sentText))
        if (live.sentText && !hasUserInput) turn.items.unshift({ id: `rmdex-input-${live.id}`, type: 'userMessage', content: [{ type: 'text', text: live.sentText }] })
        for (const item of live.items.values()) {
          const index = turn.items.findIndex(existing => existing.id === item.id)
          if (index < 0) turn.items.push(item)
          else turn.items[index] = item
        }
      }
      registerImages(result)
      result = { ...(result as object), activeTurnId: activeTurns.get(threadId!) || null, lastTurn: live ? { id: live.id, status: live.status, error: live.error } : null, approvals: [...approvals.entries()].filter(([, request]) => request.params.threadId === threadId).map(([id, request]) => ({ id, method: request.method, params: request.params })), userInputs: pendingUserInputs(threadId!) }
    } else if (/^\/api\/images\/[a-f0-9-]+$/.test(url.pathname)) {
      const path = images.get(url.pathname.split('/').pop()!)
      if (!path) { res.writeHead(404).end(JSON.stringify({ error: 'Image not found' })); return }
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size > 15 * 1024 * 1024) throw new Error('Invalid image')
        const bytes = await readFile(path)
        res.setHeader('Content-Type', imageTypes[extname(path).toLowerCase()]!)
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.end(bytes)
      } catch { res.writeHead(404).end(JSON.stringify({ error: 'Image unavailable' })) }
      return
    } else { res.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return }
    res.end(JSON.stringify(result === undefined ? { error: 'Agent returned no data' } : result))
  } catch (error) {
    res.writeHead(502).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Codex request failed' }))
  }
})
server.listen(port, '127.0.0.1', () => console.log(`rmdex local agent listening on http://127.0.0.1:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  shuttingDown = true
  if (sharedReconnectTimer) clearTimeout(sharedReconnectTimer)
  if (sharedStableTimer) clearTimeout(sharedStableTimer)
  sharedConnection?.terminate()
  codex?.kill()
  server.close()
  process.exit()
})
}
