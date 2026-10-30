import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { extname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Duplex } from 'node:stream'
import WebSocket from 'ws'
import './remote-agent.ts'

const requestedMode = (process.env.RMDEX_CODEX_MODE || '').trim().toLowerCase()
const legacyDesktopMode = ['desktop-legacy', 'desktop-mcp'].includes(requestedMode)
if (legacyDesktopMode) {
  console.warn('[rmdex] Legacy Desktop MCP mode is enabled explicitly; use RMDEX_CODEX_MODE=desktop for the permission-aware app-server mode.')
  await import('./desktop-agent.ts')
} else {

// The local control API remains loopback-only. Remote access is relayed over
// an authenticated outbound connection from remote-agent.ts.
const codexExecutable = process.env.RMDEX_CODEX || 'codex'
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
const sharedSocket = process.env.RMDEX_CODEX_SOCKET || join(codexHome, 'app-server-control', 'app-server-control.sock')
const sharedMode = ['shared', 'proxy'].includes(requestedMode)
const threadNamesPath = join(codexHome, 'rmdex-thread-names.json')
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
  : { file: codexExecutable, args: codexArgs }
const codex = spawn(codexLaunch.file, codexLaunch.args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
const sharedConnection = sharedMode
  ? new WebSocket('ws://localhost/rpc', { createConnection: () => Duplex.from({ readable: codex.stdout, writable: codex.stdin }), handshakeTimeout: 10000 })
  : undefined
let sequence = 0
const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
let failure: string | undefined
const images = new Map<string, string>()
const imageIds = new Map<string, string>()
const activeTurns = new Map<string, string>()
type LiveItem = { id: string; type: string; [key: string]: unknown }
type LiveTurn = { id: string; status: string; items: Map<string, LiveItem>; error?: unknown; sentText?: string }
const liveTurns = new Map<string, LiveTurn>()
const approvals = new Map<string, { id: string | number; method: string; params: Record<string, unknown> }>()
const sending = new Set<string>()
const newThreads = new Map<string, Record<string, unknown>>()
const subscriptions = new Map<string, Promise<void>>()
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

type ThreadRead = { thread?: { turns?: Array<{ items?: Array<{ type?: string; content?: Array<{ type?: string; path?: string; assetUrl?: string }> }> }> } }
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
function registerImages(result: unknown) {
  const thread = result as ThreadRead
  for (const turn of thread.thread?.turns || []) {
    for (const item of turn.items || []) {
      if (item.type !== 'userMessage') continue
      for (const part of item.content || []) {
        if (part.type !== 'localImage' || !part.path || !isAbsolute(part.path) || !imageTypes[extname(part.path).toLowerCase()]) continue
        const id = imageIds.get(part.path) || randomUUID()
        imageIds.set(part.path, id)
        images.set(id, part.path)
        part.assetUrl = `/api/images/${id}`
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

function failConnection(message: string) {
  if (failure) return
  failure = message
  console.error(message)
  activeTurns.clear()
  liveTurns.clear()
  approvals.clear()
  subscriptions.clear()
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(failure)) }
  pending.clear()
}
codex.stderr.on('data', (data) => console.error(String(data).trim()))
codex.on('error', (error) => failConnection(`Codex process failed: ${error.message}`))
codex.on('exit', () => failConnection(sharedMode ? 'Codex shared proxy exited; check that the daemon is running' : 'Codex app-server exited'))
sharedConnection?.on('error', (error) => failConnection(`Codex shared connection failed: ${error.message}`))
sharedConnection?.on('close', () => failConnection('Codex shared connection closed'))
function sendMessage(message: unknown, callback?: (error?: Error | null) => void) {
  if (failure) { callback?.(new Error(failure)); return }
  const payload = JSON.stringify(message)
  if (sharedConnection) {
    if (sharedConnection.readyState !== WebSocket.OPEN) { callback?.(new Error('Codex shared connection is not ready')); return }
    sharedConnection.send(payload, callback)
  } else {
    codex.stdin.write(payload + '\n', callback)
  }
}
function handleMessage(line: string) {
  try {
    const message = JSON.parse(line)
    if (message.method && message.id !== undefined) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
        approvals.set(String(message.id), { id: message.id, method: message.method, params: message.params || {} })
      } else if (!sharedMode) {
        sendMessage({ id: message.id, error: { code: -32601, message: 'This client does not support this request' } })
      } else {
        console.warn(`Unsupported shared Codex request: ${message.method}`)
      }
      return
    }
    if (message.method === 'turn/started' && message.params?.threadId && message.params?.turn?.id) {
      const { threadId, turn } = message.params
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
    if (message.method === 'turn/completed' && message.params?.threadId) {
      activeTurns.delete(message.params.threadId)
      const live = liveTurns.get(message.params.threadId)
      if (live && live.id === message.params.turn?.id) { live.status = message.params.turn.status; live.error = message.params.turn.error }
      for (const [key, request] of approvals) if (request.params.threadId === message.params.threadId) approvals.delete(key)
    }
    if (message.method === 'serverRequest/resolved') approvals.delete(String(message.params?.requestId))
    if (typeof message.id !== 'number' || !pending.has(message.id)) return
    const request = pending.get(message.id)!
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message || 'Codex request failed'))
    else request.resolve(message.result)
  } catch { console.error('Invalid app-server response') }
}
if (sharedConnection) sharedConnection.on('message', (data) => handleMessage(data.toString()))
else createInterface({ input: codex.stdout }).on('line', handleMessage)

function rpc(method: string, params: unknown): Promise<unknown> {
  if (failure) return Promise.reject(new Error(failure))
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex request timed out')) }, 15000)
    pending.set(id, { resolve, reject, timer })
    sendMessage({ id, method, params }, (error) => {
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

const transportReady = sharedConnection ? new Promise<void>((resolve, reject) => {
  sharedConnection.once('open', resolve)
  sharedConnection.once('error', reject)
  sharedConnection.once('close', () => reject(new Error('Codex shared connection closed')))
}) : Promise.resolve()
const ready = transportReady.catch((error: Error) => { throw new Error(failure || `Codex shared connection failed: ${error.message}`) })
  .then(() => rpc('initialize', { clientInfo: { name: 'rmdex', version: '0.0.1' }, capabilities: { experimentalApi: true } }))
  .then(() => { sendMessage({ method: 'initialized', params: {} }) })
ready.catch((error) => console.error('Codex initialization failed:', error.message))

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
    await ready
    let result: unknown
    if (req.method === 'POST' || req.method === 'DELETE') {
      let body = ''
      if (req.method === 'POST') for await (const chunk of req) {
        body += chunk.toString()
        if (body.length > 65536) throw new Error('请求过大')
      }
      const data = body ? JSON.parse(body) : {}
      const sendMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/send$/)
      const stopMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/stop$/)
      const historyMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/history$/)
      const renameMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/name$/)
      const archiveMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/(archive|unarchive)$/)
      const deleteMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/delete$/)
      const forkMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/fork$/)
      const queueMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/(queue|steer)$/)
      const queueDeleteMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/queue\/([a-zA-Z0-9-]+)$/)
      const queueSteerMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/queue\/([a-zA-Z0-9-]+)\/steer$/)
      const approvalMatch = url.pathname.match(/^\/api\/approvals\/([a-zA-Z0-9-]+)$/)
      if (url.pathname === '/api/settings') {
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
        threadListCache = undefined
        result = { thread: started.thread }
      } else if (forkMatch) {
        const threadId = forkMatch[1]!
        const source = newThreads.get(threadId) || { id: threadId, name: threadNames[threadId] || null }
        const requestedName = typeof data.name === 'string' ? data.name.trim() : ''
        const sourceName = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : '未命名会话'
        const name = (requestedName || `${sourceName} 副本`).slice(0, 80)
        const forked = await rpc('thread/fork', { threadId, excludeTurns: true }) as { thread?: Record<string, unknown> }
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
        liveTurns.delete(threadId)
        activeTurns.delete(threadId)
        result = { threadId, deleted: true }
      } else if (queueMatch) {
        const threadId = queueMatch[1]!
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 32000) throw new Error('消息不能为空或超出长度限制')
        if (sharedMode && !newThreads.has(threadId)) await subscribeToThread(threadId)
        const input = [{ type: 'text', text: data.text, text_elements: [] }]
        if (queueMatch[2] === 'queue') {
          const queued = await rpc('thread/queue/add', { threadId, input, clientUserMessageId: typeof data.clientUserMessageId === 'string' ? data.clientUserMessageId : randomUUID() })
          result = { outcome: 'queued', threadId, queuedSubmission: (queued as { queuedSubmission?: unknown }).queuedSubmission || null }
        } else {
          const expectedTurnId = typeof data.expectedTurnId === 'string' && data.expectedTurnId ? data.expectedTurnId : activeTurns.get(threadId)
          if (!expectedTurnId) throw new Error('当前没有可引导的运行中任务')
          const steered = await rpc('turn/steer', { threadId, expectedTurnId, input, clientUserMessageId: typeof data.clientUserMessageId === 'string' ? data.clientUserMessageId : randomUUID() })
          result = { outcome: 'steered', threadId, expectedTurnId, ...(steered && typeof steered === 'object' ? steered : {}) }
        }
      } else if (queueDeleteMatch && req.method === 'DELETE') {
        const threadId = queueDeleteMatch[1]!
        const queuedSubmissionId = queueDeleteMatch[2]!
        if (sharedMode && !newThreads.has(threadId)) await subscribeToThread(threadId)
        result = await rpc('thread/queue/delete', { threadId, queuedSubmissionId })
      } else if (queueSteerMatch) {
        const threadId = queueSteerMatch[1]!
        const queuedSubmissionId = queueSteerMatch[2]!
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
        result = { ...(result as object), activeTurnId: activeTurns.get(threadId) || null, lastTurn: live ? { id: live.id, status: live.status, error: live.error } : null, approvals: [...approvals.entries()].filter(([, request]) => request.params.threadId === threadId).map(([id, request]) => ({ id, method: request.method, params: request.params })) }
      } else if (sendMatch) {
        const threadId = sendMatch[1]!
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 32000) throw new Error('消息不能为空或超过长度限制')
        const permissionMode = data.permissionMode === undefined ? defaultPermissionMode : data.permissionMode
        if (!['ask', 'auto', 'full'].includes(permissionMode)) throw new Error('请选择有效的权限模式')
        const models = (data.model !== undefined || data.effort !== undefined) ? await listModels() : []
        const selectedModel = typeof data.model === 'string' && data.model.trim() ? models.find(model => model.id === data.model) : undefined
        if (data.model !== undefined && !selectedModel) throw new Error('所选模型不在当前 Codex 主机的模型列表中')
        if (data.effort !== undefined && (typeof data.effort !== 'string' || !selectedModel?.supportedReasoningEfforts?.some(option => option.reasoningEffort === data.effort))) throw new Error('所选推理强度不受当前模型支持')
        if (sending.has(threadId) || activeTurns.has(threadId)) throw new Error('此会话正在执行，请等待结束')
        sending.add(threadId)
        try {
          if (!newThreads.has(threadId)) {
            if (sharedMode) await subscribeToThread(threadId)
            else await rpc('thread/resume', { threadId, excludeTurns: true })
          }
          const options = permissionMode === 'full'
            ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }
            : { approvalPolicy: 'on-request', approvalsReviewer: permissionMode === 'auto' ? 'auto_review' : 'user', sandboxPolicy: { type: 'workspaceWrite' } }
          const modelOptions = selectedModel ? { model: selectedModel.id, effort: data.effort } : {}
          const started = await rpc('turn/start', { threadId, input: [{ type: 'text', text: data.text, text_elements: [] }], ...modelOptions, ...options }) as { turn?: { id: string; status?: string } }
          newThreads.delete(threadId)
          if (started.turn?.id) {
            let live = liveTurns.get(threadId)
            if (!live || live.id !== started.turn.id) { live = { id: started.turn.id, status: started.turn.status || 'inProgress', items: new Map() }; liveTurns.set(threadId, live) }
            live.sentText = data.text
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
      } else { res.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return }
    } else if (url.pathname === '/api/settings') {
      result = { permissionMode: defaultPermissionMode, mode: sharedMode ? 'shared' : 'standalone' }
    } else if (/^\/api\/threads\/[a-zA-Z0-9-]+\/queue$/.test(url.pathname)) {
      const threadId = url.pathname.split('/')[3]!
      if (sharedMode && !newThreads.has(threadId)) await subscribeToThread(threadId)
      result = await rpc('thread/queue/list', { threadId, limit: 100 })
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
      result = { thread: { ...applyThreadName(base), turns: page.turns }, page: page.page, activeTurnId: activeTurns.get(threadId) || null, lastTurn: live ? { id: live.id, status: live.status, error: live.error } : null, approvals: [...approvals.entries()].filter(([, request]) => request.params.threadId === threadId).map(([id, request]) => ({ id, method: request.method, params: request.params })) }
      registerImages(result)
    } else if (/^\/api\/threads\/[a-zA-Z0-9-]+\/status$/.test(url.pathname)) {
      const threadId = url.pathname.split('/')[3]!
      const live = liveTurns.get(threadId)
      result = {
        threadId,
        activeTurnId: activeTurns.get(threadId) || null,
        approvals: [...approvals.entries()]
          .filter(([, request]) => request.params.threadId === threadId)
          .map(([id, request]) => ({ id, method: request.method, params: request.params })),
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
      const currentRead = result as { thread?: { turns?: Array<{ id: string; status: string }> } }
      const runningTurn = currentRead.thread?.turns?.findLast(turn => turn.status === 'inProgress')
      if (sharedMode && runningTurn && !activeTurns.has(threadId!)) {
        activeTurns.set(threadId!, runningTurn.id)
        if (!liveTurns.has(threadId!)) liveTurns.set(threadId!, { id: runningTurn.id, status: runningTurn.status, items: new Map() })
      }
      registerImages(result)
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
      result = { ...(result as object), activeTurnId: activeTurns.get(threadId!) || null, lastTurn: live ? { id: live.id, status: live.status, error: live.error } : null, approvals: [...approvals.entries()].filter(([, request]) => request.params.threadId === threadId).map(([id, request]) => ({ id, method: request.method, params: request.params })) }
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
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { sharedConnection?.terminate(); codex.kill(); server.close(); process.exit() })
}
