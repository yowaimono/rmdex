import { execFileSync, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { createDesktopBridge } from '../server/desktop-bridge.ts'

const argumentsList = process.argv.slice(2)
if (argumentsList.includes('--help') || argumentsList.includes('-h')) {
  console.log('Usage: node --import tsx scripts/start-shared-desktop.ts [--wait-for-desktop-exit] [--ensure-daemon] [ChatGPT.exe]')
  process.exit(0)
}
const waitForDesktopExit = argumentsList.includes('--wait-for-desktop-exit')
const ensureDaemon = argumentsList.includes('--ensure-daemon')
const executableArgument = argumentsList.find(argument => !argument.startsWith('--'))
const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
const socket = process.env.RMDEX_CODEX_SOCKET || join(codexHome, 'app-server-control', 'app-server-control.sock')
const codexExecutable = process.env.RMDEX_CODEX || 'codex'

function findDesktopExecutable() {
  if (executableArgument) return executableArgument
  if (process.platform !== 'win32') throw new Error('Pass the absolute path to the Codex Desktop executable')
  const installLocation = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation)',
  ], { encoding: 'utf8' }).trim()
  if (!installLocation) throw new Error('Cannot find the OpenAI Codex Desktop package; pass its executable path explicitly')
  return join(installLocation, 'app', 'ChatGPT.exe')
}

function desktopAppServerCount() {
  if (process.platform !== 'win32') return 0
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object { $_.CommandLine -match "app-server.*analytics-default-enabled|features\\.code_mode_host=true.*app-server" } | Measure-Object).Count`,
  ], { encoding: 'utf8' }).trim()
  return Number(output) || 0
}

async function waitForDesktopToExit() {
  const startedAt = Date.now()
  const timeout = Number(process.env.RMDEX_SHARED_WAIT_TIMEOUT_MS || 0)
  let announced = false
  while (desktopAppServerCount() > 0) {
    if (!announced) {
      console.log('Existing Codex Desktop processes are still running. Close all Desktop windows; the shared launcher is waiting and will not terminate them.')
      announced = true
    }
    if (timeout > 0 && Date.now() - startedAt >= timeout) throw new Error('Timed out waiting for Codex Desktop to exit')
    await delay(1000)
  }
}

async function runCodexDaemonStart() {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(codexExecutable, ['app-server', 'daemon', 'start'], { stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Codex managed daemon failed to start (exit ${code ?? 'unknown'})`)))
  })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try { await access(socket); return } catch { await delay(250) }
  }
  throw new Error(`Codex managed daemon did not create its control socket: ${socket}`)
}

const executable = findDesktopExecutable()
if (waitForDesktopExit) await waitForDesktopToExit()
if (ensureDaemon) await runCodexDaemonStart()
const bridge = await createDesktopBridge(socket, process.env.RMDEX_CODEX || 'codex')
try {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(bridge.url, { handshakeTimeout: 5000 })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Codex shared server did not initialize')) }, 10000)
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'rmdex-desktop-probe', version: '1' } } })))
    ws.on('message', data => {
      try {
        const message = JSON.parse(data.toString())
        if (message.id !== 1) return
        clearTimeout(timer)
        ws.terminate()
        if (message.error) reject(new Error(message.error.message || 'Codex initialization failed'))
        else resolve()
      } catch (error) { clearTimeout(timer); ws.terminate(); reject(error) }
    })
    ws.on('error', error => { clearTimeout(timer); reject(error) })
    ws.on('close', () => { clearTimeout(timer); reject(new Error('Codex shared connection closed before initialization')) })
  })
} catch (error) { bridge.close(); throw error }
console.log('Starting Codex Desktop with a local shared app-server connection. Keep this process running.')
const startedAt = Date.now()
const desktop = spawn(executable, [], { env: { ...process.env, CODEX_APP_SERVER_WS_URL: bridge.url }, stdio: 'ignore', windowsHide: false })
desktop.on('error', error => { console.error(`Desktop could not start: ${error.message}`); bridge.close(); process.exitCode = 1 })
desktop.on('exit', code => {
  if (Date.now() - startedAt < 5000) {
    console.error('Desktop exited immediately. The Windows single-instance process may have rejected CODEX_APP_SERVER_WS_URL or forwarded to an existing Desktop process.')
    bridge.close()
    process.exitCode = 1
    return
  }
  bridge.close()
  process.exitCode = code || 0
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { bridge.close(); process.exit() })
