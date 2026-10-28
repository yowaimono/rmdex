import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, isAbsolute } from 'node:path'
import { createInterface } from 'node:readline'
import './remote-agent.ts'

// The local control API remains loopback-only. Remote access is relayed over
// an authenticated outbound connection from remote-agent.ts.
const codex = spawn(process.env.RMDEX_CODEX || 'codex', ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
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
const port = Number(process.env.RMDEX_AGENT_PORT || 18787)
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

type ThreadRead = { thread?: { turns?: Array<{ items?: Array<{ type?: string; content?: Array<{ type?: string; path?: string; assetUrl?: string }> }> }> } }
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

codex.stderr.on('data', (data) => console.error(String(data).trim()))
codex.on('error', (error) => { failure = error.message; console.error(error.message) })
codex.on('exit', () => {
  failure = 'Codex app-server exited'
  activeTurns.clear()
  liveTurns.clear()
  approvals.clear()
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(failure)) }
  pending.clear()
})
createInterface({ input: codex.stdout }).on('line', (line) => {
  try {
    const message = JSON.parse(line)
    if (message.method && message.id !== undefined) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
        approvals.set(String(message.id), { id: message.id, method: message.method, params: message.params || {} })
      } else {
        codex.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'This client does not support this request' } }) + '\n')
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
})

function rpc(method: string, params: unknown): Promise<unknown> {
  if (failure) return Promise.reject(new Error(failure))
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex request timed out')) }, 15000)
    pending.set(id, { resolve, reject, timer })
    codex.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
      if (error && pending.has(id)) { clearTimeout(timer); pending.delete(id); reject(error) }
    })
  })
}

const ready = rpc('initialize', { clientInfo: { name: 'rmdex', version: '0.0.1' } })
  .then(() => { codex.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n') })
ready.catch((error) => console.error('Codex initialization failed:', error.message))

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  const host = req.headers.host || ''
  const origin = req.headers.origin
  if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(host) || (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
    res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return
  }
  if (!['GET', 'POST'].includes(req.method || '')) { res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed' })); return }
  if (req.method === 'POST' && (!/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin || '') || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))) {
    res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost:18787')
    await ready
    let result: unknown
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) {
        body += chunk.toString()
        if (body.length > 65536) throw new Error('请求过大')
      }
      const data = JSON.parse(body)
      const sendMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/send$/)
      const stopMatch = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)\/stop$/)
      const approvalMatch = url.pathname.match(/^\/api\/approvals\/([a-zA-Z0-9-]+)$/)
      if (url.pathname === '/api/threads') {
        if (typeof data.cwd !== 'string' || !data.cwd.trim() || !isAbsolute(data.cwd.trim())) throw new Error('请输入工作目录的绝对路径')
        const cwd = data.cwd.trim()
        const info = await stat(cwd).catch(() => null)
        if (!info?.isDirectory()) throw new Error('工作目录不存在或不是文件夹')
        const started = await rpc('thread/start', { cwd }) as { thread?: Record<string, unknown> }
        if (typeof started.thread?.id !== 'string') throw new Error('Codex 未返回会话 ID')
        newThreads.set(started.thread.id, started.thread)
        result = { thread: started.thread }
      } else if (sendMatch) {
        const threadId = sendMatch[1]!
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 32000) throw new Error('消息不能为空或超过长度限制')
        if (!['ask', 'auto', 'full'].includes(data.permissionMode)) throw new Error('请选择有效的权限模式')
        if (sending.has(threadId) || activeTurns.has(threadId)) throw new Error('此会话正在执行，请等待结束')
        sending.add(threadId)
        try {
          if (!newThreads.has(threadId)) await rpc('thread/resume', { threadId, excludeTurns: true })
          const options = data.permissionMode === 'full'
            ? { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }
            : { approvalPolicy: 'on-request', approvalsReviewer: data.permissionMode === 'auto' ? 'auto_review' : 'user', sandboxPolicy: { type: 'workspaceWrite' } }
          const started = await rpc('turn/start', { threadId, input: [{ type: 'text', text: data.text, text_elements: [] }], ...options }) as { turn?: { id: string; status?: string } }
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
        codex.stdin.write(JSON.stringify({ id: request.id, result: { decision: data.decision } }) + '\n')
        result = { ok: true }
      } else { res.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return }
    } else if (url.pathname === '/api/threads') {
      const list = await rpc('thread/list', { limit: 100, sortKey: 'updated_at' }) as { data: Array<{ id: string }> }
      const listed = new Set(list.data.map(thread => thread.id))
      result = { ...list, data: [...[...newThreads.values()].filter(thread => !listed.has(String(thread.id))), ...list.data] }
    } else if (/^\/api\/threads\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
      const threadId = url.pathname.split('/').pop()
      try { result = await rpc('thread/read', { threadId, includeTurns: true }) }
      catch (error) {
        const thread = newThreads.get(threadId!)
        if (!thread) throw error
        result = { thread: { ...thread, turns: [] } }
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
    res.end(JSON.stringify(result))
  } catch (error) {
    res.writeHead(502).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Codex request failed' }))
  }
})
server.listen(port, '127.0.0.1', () => console.log(`rmdex local agent listening on http://127.0.0.1:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { codex.kill(); server.close(); process.exit() })
