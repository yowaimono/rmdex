import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

export type DesktopContext = { pipe: string; server: string; threadId: string; turnId: string; hostId?: string; registeredAt: number }
export type DesktopTool = { name: string; inputSchema?: Record<string, unknown> }
export class DesktopError extends Error {
  constructor(message: string, public uncertain = false) { super(message) }
}

// Calls use only locally registered Desktop executor metadata. Remote input
// never chooses caller identity, transport, tool names, or metadata.
export class DesktopMcp {
  private child: ChildProcessWithoutNullStreams
  private pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; write: boolean }>()
  private sequence = 0
  private failure = false
  private catalog?: DesktopTool[]
  private catalogAt = 0
  private catalogRequest?: Promise<DesktopTool[]>
  readonly ready: Promise<void>
  constructor(private context: DesktopContext, private timeoutMs = 25000, executable = process.execPath) {
    this.child = spawn(executable, [context.server], {
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: context.pipe, CODEX_APP_TOOLS_CALLER_HOST_ID: context.hostId || 'local' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    this.child.stderr.resume() // Native errors may contain private connection data.
    this.child.on('error', () => this.fail())
    this.child.on('exit', () => this.fail())
    this.child.stdin.on('error', () => this.fail())
    const lines = createInterface({ input: this.child.stdout })
    lines.on('line', line => {
      let message: any
      try { message = JSON.parse(line) } catch { return }
      if (message.method === 'notifications/tools/list_changed') this.catalogAt = 0
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id); clearTimeout(entry.timer)
      if (message.error) entry.reject(new DesktopError('Desktop 工具调用失败，请检查桌面连接', entry.write))
      else entry.resolve(message.result)
    })
    this.ready = this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rmdex-desktop', version: '1' } })
      .then(() => { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') })
    this.ready.catch(() => {})
  }
  private fail() {
    this.failure = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new DesktopError('Desktop 连接已断开，请在 Codex Desktop 中重新连接 rmdex', entry.write))
    }
    this.pending.clear()
  }
  private request(method: string, params: unknown, write = false): Promise<any> {
    if (this.failure) return Promise.reject(new DesktopError('Desktop 连接已断开，请重新连接'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DesktopError(write ? 'Desktop 响应超时，操作结果尚未确认，请核对目标会话，勿重复发送' : 'Desktop 读取超时，请稍后重试', write))
        this.close()
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, write })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async tools(refresh = false): Promise<DesktopTool[]> {
    await this.ready
    if (this.catalogRequest) return this.catalogRequest
    if (refresh || !this.catalog || Date.now() - this.catalogAt >= 30000) {
      this.catalogRequest = this.request('tools/list', {}).then(result => {
        if (!Array.isArray(result?.tools)) throw new DesktopError('Desktop 未返回工具列表')
        this.catalog = result.tools
        this.catalogAt = Date.now()
        return this.catalog!
      }).finally(() => { this.catalogRequest = undefined })
      return this.catalogRequest
    }
    return this.catalog
  }
  get disconnected() { return this.failure }
  async call(name: string, args: Record<string, unknown>, write = false): Promise<any> {
    const allowed = ['list_threads', 'read_thread', 'list_projects', 'send_message_to_thread', 'create_thread']
    if (!allowed.includes(name) || !(await this.tools()).some(tool => tool.name === name)) throw new DesktopError('当前 Desktop 不提供此功能')
    const result = await this.request('tools/call', {
      name, arguments: args,
      _meta: { threadId: this.context.threadId, turnId: this.context.turnId, callId: `rmdex-${randomUUID()}` },
    }, write)
    if (result?.isError) throw new DesktopError(write ? 'Desktop 未确认操作结果，请核对目标会话，勿重复提交' : 'Desktop 暂时无法读取此会话', write)
    try {
      const text = result?.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
      return JSON.parse(text)
    } catch { throw new DesktopError('Desktop 返回结果无法核对，请检查桌面', write) }
  }
  close() { this.fail(); this.child.kill() }
}
