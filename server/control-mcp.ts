import { createInterface } from 'node:readline'

/**
 * A small, stable MCP control plane for rmdex.
 *
 * This deliberately talks to rmdex's loopback HTTP agent instead of depending
 * on Codex Desktop's private MCP implementation. The agent remains the single
 * place that owns app-server sessions, approvals, sandbox policy, and live
 * turn state. Any MCP client can therefore use the same permission-aware API.
 */

type JsonRpcId = string | number | null
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> }
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> }

const agentUrl = new URL(process.env.RMDEX_MCP_AGENT_URL || `http://127.0.0.1:${process.env.RMDEX_AGENT_PORT || 18787}`)
if (!['http:', 'https:'].includes(agentUrl.protocol)) throw new Error('RMDEX_MCP_AGENT_URL must be HTTP(S)')
if (!['localhost', '127.0.0.1', '[::1]'].includes(agentUrl.hostname) && process.env.RMDEX_MCP_ALLOW_REMOTE !== '1') {
  throw new Error('Refusing a non-loopback agent URL; set RMDEX_MCP_ALLOW_REMOTE=1 only behind your own authentication layer')
}

const json = (value: unknown) => JSON.stringify(value, null, 2)
const text = (value: unknown) => typeof value === 'string' ? value : json(value)
const requiredString = (args: Record<string, unknown>, name: string) => {
  const value = args[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}
const optionalString = (args: Record<string, unknown>, name: string) => {
  const value = args[name]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}
const operationId = (args: Record<string, unknown>) => {
  const value = args.operationId
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('operationId must be a UUID')
  return value
}

async function callAgent(path: string, init: RequestInit = {}) {
  const url = new URL(path, agentUrl)
  const response = await fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(35000) })
  const body = await response.text()
  if (!body.trim()) throw new Error(`rmdex agent returned an empty response (HTTP ${response.status})`)
  let value: any
  try { value = JSON.parse(body) } catch { throw new Error(`rmdex agent returned invalid JSON (HTTP ${response.status})`) }
  if (!response.ok) throw new Error(value?.error || `rmdex agent request failed (HTTP ${response.status})`)
  return value
}

const post = (path: string, body: Record<string, unknown>, timeoutMs = 35000) => callAgent(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(timeoutMs),
})

const tools: Tool[] = [
  {
    name: 'codex_capabilities',
    description: 'Return the rmdex/Codex capabilities and the permission modes available to this client.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'codex_list_models',
    description: 'List models and supported reasoning efforts from the connected Codex host.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'codex_list_threads',
    description: 'List local Codex conversations visible to the connected app-server.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
  {
    name: 'codex_read_thread',
    description: 'Read a Codex conversation, including current turn state and pending approval requests.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { threadId: { type: 'string' } }, required: ['threadId'],
    },
  },
  {
    name: 'codex_start_thread',
    description: 'Start a new Codex conversation in an existing absolute working directory.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { cwd: { type: 'string', description: 'Absolute working directory path.' } }, required: ['cwd'],
    },
  },
  {
    name: 'codex_send_message',
    description: 'Send a message with explicit approval and sandbox control. ask=workspace writes with user approval, auto=automatic review, full=dangerous full access.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        threadId: { type: 'string' }, operationId: { type: 'string', format: 'uuid' }, text: { type: 'string' },
        permissionMode: { type: 'string', enum: ['ask', 'auto', 'full'], default: 'ask' },
        model: { type: 'string' }, effort: { type: 'string' },
      }, required: ['threadId', 'operationId', 'text'],
    },
  },
  {
    name: 'codex_stop_turn',
    description: 'Interrupt the currently running turn started through rmdex.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { threadId: { type: 'string' } }, required: ['threadId'],
    },
  },
  {
    name: 'codex_list_approvals',
    description: 'List pending approval requests for a conversation.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { threadId: { type: 'string' } }, required: ['threadId'],
    },
  },
  {
    name: 'codex_respond_approval',
    description: 'Accept or decline one pending Codex approval request.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { approvalId: { type: 'string' }, decision: { type: 'string', enum: ['accept', 'decline'] } },
      required: ['approvalId', 'decision'],
    },
  },
  {
    name: 'codex_wait_turn',
    description: 'Wait until a conversation turn stops running, then return the updated conversation state.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { threadId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 } },
      required: ['threadId'],
    },
  },
]

async function execute(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'codex_capabilities':
      return {
        protocol: 'rmdex-control-mcp/1',
        backend: 'rmdex-local-agent',
        permissions: {
          ask: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite' } },
          auto: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: { type: 'workspaceWrite' } },
          full: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
        },
        note: 'The MCP server does not bypass approvals. It forwards explicit decisions to the rmdex agent.',
      }
    case 'codex_list_models': return callAgent('/api/models')
    case 'codex_list_threads': return callAgent('/api/threads')
    case 'codex_read_thread': return callAgent(`/api/threads/${encodeURIComponent(requiredString(args, 'threadId'))}`)
    case 'codex_start_thread': return post('/api/threads', { cwd: requiredString(args, 'cwd') })
    case 'codex_send_message': {
      const threadId = requiredString(args, 'threadId')
      const body: Record<string, unknown> = {
        operationId: operationId(args),
        text: requiredString(args, 'text'),
        permissionMode: args.permissionMode == null ? 'ask' : requiredString(args, 'permissionMode'),
      }
      if (!['ask', 'auto', 'full'].includes(String(body.permissionMode))) throw new Error('permissionMode must be ask, auto, or full')
      for (const key of ['model', 'effort']) { const value = optionalString(args, key); if (value != null) body[key] = value }
      return post(`/api/threads/${encodeURIComponent(threadId)}/send`, body, 120000)
    }
    case 'codex_stop_turn': return post(`/api/threads/${encodeURIComponent(requiredString(args, 'threadId'))}/stop`, {})
    case 'codex_list_approvals': {
      const thread = await callAgent(`/api/threads/${encodeURIComponent(requiredString(args, 'threadId'))}`)
      return { approvals: Array.isArray(thread?.approvals) ? thread.approvals : [] }
    }
    case 'codex_respond_approval': {
      const approvalId = requiredString(args, 'approvalId')
      const decision = requiredString(args, 'decision')
      if (!['accept', 'decline'].includes(decision)) throw new Error('decision must be accept or decline')
      return post(`/api/approvals/${encodeURIComponent(approvalId)}`, { decision })
    }
    case 'codex_wait_turn': {
      const threadId = requiredString(args, 'threadId')
      const requested = args.timeoutMs == null ? 120000 : Number(args.timeoutMs)
      if (!Number.isInteger(requested) || requested < 1000 || requested > 120000) throw new Error('timeoutMs must be an integer from 1000 to 120000')
      const deadline = Date.now() + requested
      let latest = await callAgent(`/api/threads/${encodeURIComponent(threadId)}`)
      while (latest?.activeTurnId && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500))
        latest = await callAgent(`/api/threads/${encodeURIComponent(threadId)}`)
      }
      return { completed: !latest?.activeTurnId, timedOut: Boolean(latest?.activeTurnId), thread: latest }
    }
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

function reply(id: JsonRpcId, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}
function error(id: JsonRpcId, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

const input = createInterface({ input: process.stdin })
input.on('line', async line => {
  if (!line.trim()) return
  let request: JsonRpcRequest
  try { request = JSON.parse(line) as JsonRpcRequest } catch { error(null, -32700, 'Invalid JSON'); return }
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') { error(request.id ?? null, -32600, 'Invalid Request'); return }
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return
  if (request.method === 'ping') { reply(request.id ?? null, {}); return }
  try {
    if (request.method === 'initialize') {
      reply(request.id ?? null, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'rmdex-control-mcp', version: '1.0.0' },
        instructions: 'Use codex_capabilities before sending a message. Approval and sandbox policy are explicit per turn.',
      })
    } else if (request.method === 'tools/list') {
      reply(request.id ?? null, { tools })
    } else if (request.method === 'tools/call') {
      const params = request.params || {}
      const name = requiredString(params, 'name')
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
      const result = await execute(name, args)
      reply(request.id ?? null, { content: [{ type: 'text', text: text(result) }], structuredContent: result, isError: false })
    } else {
      error(request.id ?? null, -32601, `Method not found: ${request.method}`)
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Request failed'
    if (request.method === 'tools/call') reply(request.id ?? null, { content: [{ type: 'text', text: message }], isError: true })
    else error(request.id ?? null, -32000, message)
  }
})

