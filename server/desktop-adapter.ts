import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DesktopError, type DesktopTool } from './desktop-mcp.ts'
import { desktopModels, sharedDesktopModels } from './desktop-models.ts'
import { normalizeItem } from '../src/conversation.ts'

export type DesktopCaller = { call: (name: string, args: Record<string, unknown>, write?: boolean) => Promise<any>; tools: () => Promise<DesktopTool[]> }
type JournalEntry = { fingerprint: string; state: 'dispatching' | 'finished'; result?: any }
export class OperationJournal {
  private entries: Record<string, JournalEntry> = Object.create(null)
  private queue = Promise.resolve()
  private ready: Promise<void>
  constructor(private path: string) {
    this.ready = readFile(path, 'utf8').then(raw => { this.entries = Object.assign(Object.create(null), JSON.parse(raw)) }).catch(error => {
      if (error.code !== 'ENOENT') throw new Error('操作记录无法读取，已停止 Desktop 写操作')
    })
    this.ready.catch(() => {})
  }
  run(id: string, fingerprint: string, action: () => Promise<any>) {
    const job = this.queue.then(async () => {
      await this.ready
      const previous = this.entries[id]
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('操作编号与之前的请求不一致')
        return previous.state === 'finished' ? previous.result : { outcome: 'uncertain', message: '此前的操作结果未确认，请在 Desktop 核对，未重复提交' }
      }
      this.entries[id] = { fingerprint, state: 'dispatching' }
      await this.persist()
      let result: any
      try { result = await action() }
      catch { result = { outcome: 'uncertain', message: 'Desktop 操作结果未确认，请核对目标会话，未自动重试' } }
      this.entries[id] = { fingerprint, state: 'finished', result }
      await this.persist()
      return result
    })
    this.queue = job.then(() => {}, () => {})
    return job
  }
  private async persist() {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(this.entries), { mode: 0o600 })
    await rename(temporary, this.path)
  }
}
function threadView(thread: any) {
  if (!thread || typeof thread.id !== 'string') throw new DesktopError('Desktop 未返回有效会话')
  return {
    id: thread.id, name: thread.title || thread.name || null, preview: thread.preview || '', cwd: thread.cwd || '',
    updatedAt: typeof thread.updatedAt === 'string' ? Date.parse(thread.updatedAt) / 1000 : thread.updatedAt,
    status: typeof thread.status === 'object' ? thread.status : { type: thread.status },
  }
}
export function adaptRead(raw: any, id: string) {
  if (raw?.thread?.id !== id || raw.thread.kind === 'chatgpt' || (raw.thread.hostId && raw.thread.hostId !== 'local')) throw new DesktopError('Desktop 返回了不匹配的本机会话')
  if (!Array.isArray(raw.turns)) throw new DesktopError('Desktop 未返回有效历史记录')
  const turns = raw.turns.map((turn: any) => ({
    id: turn.id, status: turn.status, error: turn.error,
    items: (Array.isArray(turn.items) ? turn.items : []).filter((item: any) => item && !['reasoning', 'hookPrompt'].includes(item.type)).map(normalizeItem),
  }))
  if (raw.page?.order === 'newest_first') turns.reverse()
  const running = turns.findLast((turn: any) => turn.status === 'inProgress')
  const last = turns.at(-1)
  return { thread: { ...threadView(raw.thread), turns }, activeTurnId: running?.id || (raw.thread.status?.type === 'active' || raw.thread.status === 'active' ? 'desktop-active' : null), approvals: [], lastTurn: last ? { id: last.id, status: last.status, error: last.error } : null, page: { nextCursor: raw.page?.nextCursor || null, hasMore: Boolean(raw.page?.hasMore) } }
}
export class DesktopAdapter {
  private sending = new Set<string>()
  constructor(private client: DesktopCaller, private journal: OperationJournal) {}
  async models() {
    const tools = await this.client.tools()
    const names = new Set(tools.map(tool => tool.name))
    const data = sharedDesktopModels(tools)
    const projects = names.has('list_projects') ? await this.projects() : []
    return { data, capabilities: { mode: 'desktop', models: data.length > 0, permissions: false, stop: false, approvals: false, create: names.has('create_thread'), send: names.has('send_message_to_thread'), rename: false, history: true, createRequiresPrompt: true }, projects }
  }
  private async projects() {
    const raw = await this.client.call('list_projects', {})
    return (raw.projects || []).filter((project: any) => project.projectKind !== 'chatgpt' && project.hostId === 'local' && project.path).map((project: any) => ({ id: project.projectId, name: project.label, path: project.path }))
  }
  async list() {
    const raw = await this.client.call('list_threads', { limit: 50 })
    const threads = [...(raw.pinnedThreads || []), ...(raw.threads || [])].filter(thread => thread.kind === 'codex' && thread.hostId === 'local')
    return { data: [...new Map(threads.map(thread => [thread.id, threadView(thread)])).values()] }
  }
  async read(id: string, cursor?: string) {
    if (cursor && (typeof cursor !== 'string' || cursor.length > 4096)) throw new Error('无效历史游标')
    return adaptRead(await this.client.call('read_thread', { threadId: id, hostId: 'local', turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000, ...(cursor ? { cursor } : {}) }), id)
  }
  private operation(data: any) {
    if (typeof data.operationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.operationId)) throw new Error('缺少有效的操作编号，请刷新页面')
    if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 32000) throw new Error('消息不能为空或超过长度限制')
    if (data.permissionMode != null || data.approvalPolicy != null || data.sandboxPolicy != null) throw new Error('Desktop 原生接口不支持修改权限，请在 Desktop 调整')
  }
  private async settings(name: string, data: any): Promise<{ model?: string; thinking?: string }> {
    if (data.model == null && data.effort == null) return {}
    const tool = (await this.client.tools()).find(tool => tool.name === name)
    const model = desktopModels(tool).find(model => model.id === data.model)
    if (!model) throw new Error('此模型不在当前 Desktop 主机目录中，请刷新模型列表')
    if (data.effort != null && !model.supportedReasoningEfforts.some(effort => effort.reasoningEffort === data.effort)) throw new Error('此模型不支持所选推理强度，请刷新模型列表')
    return { model: model.id, ...(data.effort != null ? { thinking: data.effort } : {}) }
  }
  async send(id: string, data: any) {
    this.operation(data)
    if (this.sending.has(id)) throw new Error('此会话的发送请求正在处理中')
    this.sending.add(id)
    try {
      const settings = await this.settings('send_message_to_thread', data)
      return await this.journal.run(data.operationId, createHash('sha256').update(JSON.stringify(['send', id, data.text, ...(settings.model ? [settings] : [])])).digest('hex'), async () => {
        const raw = await this.client.call('send_message_to_thread', { threadId: id, hostId: 'local', prompt: data.text, ...settings }, true)
        if (raw.threadId !== id) throw new DesktopError('目标会话未确认', true)
        return { outcome: 'queued', threadId: id }
      })
    } finally { this.sending.delete(id) }
  }
  async create(data: any) {
    this.operation(data)
    const settings = await this.settings('create_thread', data)
    const project = data.projectId ? (await this.projects()).find((project: any) => project.id === data.projectId) : undefined
    if (data.projectId && !project) throw new Error('请选择 Desktop 中已存在的本地项目')
    const target = project ? { type: 'project', projectId: project.id, environment: { type: 'local' } } : { type: 'projectless' }
    return this.journal.run(data.operationId, createHash('sha256').update(JSON.stringify(['create', target, data.text, ...(settings.model ? [settings] : [])])).digest('hex'), async () => {
      const raw = await this.client.call('create_thread', { target, prompt: data.text, title: data.text.trim().slice(0, 40), ...settings }, true)
      if (typeof raw.threadId === 'string') return { outcome: 'queued', thread: { id: raw.threadId, name: data.text.trim().slice(0, 40), cwd: project?.path || '' } }
      if (typeof raw.clientThreadId === 'string') return { outcome: 'preparing', message: 'Desktop 正在准备新会话，请稍后刷新会话列表' }
      throw new DesktopError('Desktop 未确认新会话', true)
    })
  }
}
