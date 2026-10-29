import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { DesktopContext } from './desktop-mcp.ts'

export const contextFile = process.env.RMDEX_DESKTOP_CONTEXT || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'rmdex', 'desktop-context.bin')
const protectScript = `Add-Type -AssemblyName System.Security
$value = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($value)
$encrypted = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Write([Convert]::ToBase64String($encrypted))`
const unprotectScript = `Add-Type -AssemblyName System.Security
$value = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($value)
$clear = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Write([System.Text.Encoding]::UTF8.GetString($clear))`
function crypt(value: string, protect: boolean): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new Error('Desktop 注册目前仅支持 Windows'))
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', protect ? protectScript : unprotectScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('本机 Desktop 连接信息解密超时')) }, 10000)
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.on('error', () => { clearTimeout(timer); reject(new Error('无法访问 Windows 用户加密服务')) })
    child.stdin.on('error', () => {})
    child.on('exit', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error('无法读取本机 Desktop 注册，请重新连接')) })
    child.stdin.end(value)
  })
}
export async function readDesktopContext(): Promise<DesktopContext> {
  try {
    const context = JSON.parse(await crypt(await readFile(contextFile, 'utf8'), false)) as DesktopContext
    if (!context.pipe || !context.server || !context.threadId || !context.turnId || !Number.isFinite(context.registeredAt)) throw new Error('Invalid context')
    return context
  } catch { throw new Error('Desktop 尚未连接或注册已失效，请在 Codex Desktop 中重新连接 rmdex') }
}
export async function registerDesktopContext() {
  const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH
  const threadId = process.env.CODEX_THREAD_ID
  if (!pipe || !threadId) throw new Error('请从正在运行的 Codex Desktop 会话连接 rmdex')
  const home = process.env.CODEX_HOME || join(homedir(), '.codex')
  const toolsRoot = join(home, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools')
  const candidates = await Promise.all((await readdir(toolsRoot)).map(async version => {
    const path = join(toolsRoot, version, 'server.mjs')
    try { return { path, time: (await stat(path)).mtimeMs } } catch { return null }
  }))
  const server = candidates.filter(candidate => candidate !== null).sort((a, b) => b.time - a.time)[0]?.path
  if (!server) throw new Error('没有找到已安装的 Desktop 工具服务')
  const sessions = join(home, 'sessions')
  const files = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl') && file.includes(threadId))
  let turnId: string | undefined
  let latestTime = 0
  for (const file of files) {
    const path = join(sessions, file)
    const modified = (await stat(path)).mtimeMs
    if (modified < latestTime) continue
    let matches = false
    let currentTurn: string | undefined
    const input = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of input) {
      let event: any
      try { event = JSON.parse(line) } catch { continue }
      if (event.type === 'session_meta') matches = event.payload?.id === threadId
      if (matches && event.type === 'event_msg' && event.payload?.type === 'task_started' && typeof event.payload.turn_id === 'string') currentTurn = event.payload.turn_id
    }
    if (matches && currentTurn) { turnId = currentTurn; latestTime = modified }
  }
  if (!turnId) throw new Error('无法确认当前 Desktop 会话上下文，请从 Desktop 中重试')
  const context: DesktopContext = { pipe, server, threadId, turnId, hostId: process.env.CODEX_APP_TOOLS_CALLER_HOST_ID || 'local', registeredAt: Date.now() }
  // Probe before replacing a working registration; neither pipe nor identity is logged.
  const { DesktopMcp } = await import('./desktop-mcp.ts')
  const probe = new DesktopMcp(context)
  try {
    const tools = await probe.tools()
    if (!tools.some(tool => tool.name === 'list_threads')) throw new Error('Desktop 缺少会话工具')
    await probe.call('list_threads', { limit: 1 })
  } finally { probe.close() }
  const encrypted = await crypt(JSON.stringify(context), true)
  await mkdir(dirname(contextFile), { recursive: true })
  const temporary = `${contextFile}.${process.pid}.tmp`
  await writeFile(temporary, encrypted, { mode: 0o600 })
  await rename(temporary, contextFile)
}
