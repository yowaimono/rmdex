import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, dirname } from 'node:path'
import { AttachmentStore } from './attachments.ts'
import { ProjectStore } from './project-store.ts'
import { DesktopAdapter, OperationJournal } from './desktop-adapter.ts'
import { contextFile, readDesktopContext } from './desktop-context.ts'
import { DesktopMcp } from './desktop-mcp.ts'

const port = Number(process.env.RMDEX_AGENT_PORT || 18787)
const journal = new OperationJournal(join(dirname(contextFile), 'desktop-operations.json'))
let connection: { version: number; client: DesktopMcp; adapter: DesktopAdapter } | undefined
let opening: Promise<DesktopAdapter> | undefined
async function adapter() {
  if (opening) return opening
  opening = (async () => {
    const version = (await stat(contextFile).catch(() => null))?.mtimeMs
    if (!version) throw new Error('Desktop 尚未连接，请在 Codex Desktop 中连接 rmdex')
    if (connection?.version === version) return connection.adapter
    connection?.client.close(); connection = undefined
    const context = await readDesktopContext()
    const client = new DesktopMcp(context)
    try {
      await client.ready
      const next = new DesktopAdapter(client, journal)
      connection = { version, client, adapter: next }
      return next
    } catch (error) { client.close(); throw error }
  })()
  try { return await opening } finally { opening = undefined }
}
const images = new Map<string, string>()
const imageIds = new Map<string, string>()
const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
const attachmentStore = new AttachmentStore()
const projectStore = new ProjectStore(process.env.CODEX_HOME || join(homedir(), '.codex'))
function registerImages(result: any) {
  for (const turn of result.thread?.turns || []) for (const item of turn.items || []) {
    const parts = item.type === 'userMessage' ? item.content || [] : []
    for (const part of parts) registerImagePath(part, part.path)
    if (['imageView', 'imageGeneration'].includes(String(item.type))) registerImagePath(item, item.path || item.savedPath)
  }
  while (images.size > 2000) {
    const id = images.keys().next().value!
    imageIds.delete(images.get(id)!); images.delete(id)
  }
}
function registerImagePath(target: Record<string, unknown>, value: unknown) {
  if (typeof value !== 'string' || !isAbsolute(value) || !types[extname(value).toLowerCase()]) return
  const id = imageIds.get(value) || randomUUID()
  images.set(id, value); imageIds.set(value, id)
  target.assetUrl = `/api/images/${id}`
}
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  const origin = req.headers.origin
  if (![ `localhost:${port}`, `127.0.0.1:${port}` ].includes(req.headers.host || '') || (origin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin))) {
    res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return
  }
  if (!['GET', 'POST'].includes(req.method || '')) { res.writeHead(405).end(); return }
  if (req.method === 'POST' && (!/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin || '') || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))) {
    res.writeHead(403).end(JSON.stringify({ error: 'Forbidden' })); return
  }
  try {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    if (url.search) { res.writeHead(404).end(); return }
    let data: any = {}
    if (req.method === 'POST') {
      let raw = ''
      for await (const chunk of req) { raw += chunk.toString(); if (raw.length > 12 * 1024 * 1024) throw new Error('请求过大') }
      data = JSON.parse(raw || '{}')
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('无效请求')
    }
    const match = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)(?:\/(send|history|stop))?$/)
    const projectUpdateMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/update$/)
    const projectDeleteMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9-]+)\/delete$/)
    if (req.method === 'POST' && (match?.[2] === 'stop' || url.pathname.startsWith('/api/approvals/'))) {
      res.writeHead(409).end(JSON.stringify({ error: '当前 Desktop 工具不支持此操作，请在 Codex Desktop 中处理' })); return
    }
    if (req.method === 'POST' && url.pathname === '/api/attachments') {
      res.writeHead(201)
      res.end(JSON.stringify(await attachmentStore.add(data)))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      res.writeHead(201)
      res.end(JSON.stringify(await projectStore.create(data)))
      return
    }
    if (req.method === 'POST' && projectUpdateMatch) {
      res.end(JSON.stringify(await projectStore.update(projectUpdateMatch[1]!, data)))
      return
    }
    if (req.method === 'POST' && projectDeleteMatch) {
      res.end(JSON.stringify(await projectStore.delete(projectDeleteMatch[1]!)))
      return
    }
    if (req.method === 'GET' && /^\/api\/images\/[a-f0-9-]+$/.test(url.pathname)) {
      const path = images.get(url.pathname.split('/').pop()!)
      if (!path || !(await stat(path)).isFile() || (await stat(path)).size > 15 * 1024 * 1024) { res.writeHead(404).end(); return }
      res.setHeader('Content-Type', types[extname(path).toLowerCase()]!)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.end(await readFile(path)); return
    }
    const desktop = await adapter()
    let result: any
    if (req.method === 'GET' && url.pathname === '/api/projects') result = { data: await projectStore.list(await desktop.projects()) }
    else if (req.method === 'GET' && url.pathname === '/api/models') result = await desktop.models()
    else if (req.method === 'GET' && url.pathname === '/api/threads') result = await desktop.list()
    else if (req.method === 'GET' && match && !match[2]) { result = await desktop.read(match[1]!); registerImages(result) }
    else if (req.method === 'POST' && match?.[2] === 'history') {
      if (typeof data.cursor !== 'string' || !data.cursor) throw new Error('缺少历史游标')
      result = await desktop.read(match[1]!, data.cursor); registerImages(result)
    } else if (req.method === 'POST' && match?.[2] === 'send') result = await desktop.send(match[1]!, { ...data, attachments: attachmentStore.resolve(data.attachments) })
    else if (req.method === 'POST' && url.pathname === '/api/threads') result = await desktop.create({ ...data, attachments: attachmentStore.resolve(data.attachments) })
    else { res.writeHead(404).end(JSON.stringify({ error: 'Not found' })); return }
    res.end(JSON.stringify(result === undefined ? { error: 'Agent returned no data' } : result))
  } catch (error) {
    res.writeHead(502).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Desktop 请求失败' }))
    // A fresh read may reconnect. Writes are protected separately by the journal.
    if (connection?.client.disconnected) { connection.client.close(); connection = undefined }
  }
})
server.listen(port, '127.0.0.1', () => console.log(`rmdex Desktop agent listening on http://127.0.0.1:${port}`))
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { connection?.client.close(); server.close(); process.exit() })
