import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) {
  console.error('Desktop tools connection unavailable in this process.')
  process.exitCode = 1
} else {
  try {
    const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache', 'openai-bundled', 'codex-app-tools')
    const candidates = await Promise.all((await readdir(root)).map(async version => {
      const path = join(root, version, 'server.mjs')
      try { return { path, time: (await stat(path)).mtimeMs } } catch { return null }
    }))
    const server = candidates.filter(Boolean).sort((a, b) => b.time - a.time)[0]?.path
    if (!server) throw new Error('Desktop tools server not found')
    const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const lines = createInterface({ input: child.stdout })
    let sequence = 0
    let disconnected = false
    const pending = new Map()
    const fail = () => { disconnected = true; for (const callback of pending.values()) callback(new Error('Desktop tools connection closed')); pending.clear() }
    child.on('error', fail)
    child.on('exit', fail)
    child.stdin.on('error', fail)
    lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { return }
      const callback = pending.get(message.id)
      if (callback) { pending.delete(message.id); callback(message.error ? new Error('Desktop tools request failed') : null, message.result) }
    })
    const request = (method, params) => new Promise((resolve, reject) => {
      if (disconnected) { reject(new Error('Desktop tools connection closed')); return }
      const id = ++sequence
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Desktop tools request timed out')) }, 10000)
      pending.set(id, (error, result) => { clearTimeout(timer); if (error) reject(error); else resolve(result) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    try {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rmdex-desktop-probe', version: '1' } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
      const result = await request('tools/list', {})
      if (!Array.isArray(result?.tools)) throw new Error('Invalid Desktop tools catalog')
      const names = new Set(result.tools.map(tool => tool.name))
      for (const name of ['list_threads', 'read_thread', 'send_message_to_thread', 'create_thread', 'wait_threads']) console.log(name + ': ' + (names.has(name) ? 'available' : 'unavailable'))
    } finally { lines.close(); child.kill() }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Desktop probe failed')
    process.exitCode = 1
  }
}
