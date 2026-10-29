import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'

export type PermissionMode = 'ask' | 'auto' | 'full'
type ProcessState = 'stopped' | 'starting' | 'running' | 'error'
type Phone = { name: string; online: boolean; lastSeenAt?: number }
type Settings = { permissionMode: PermissionMode }

export type PcStatus = {
  phase: ProcessState
  permissionMode: PermissionMode
  codexDesktop: { state: ProcessState; pid?: number }
  appServer: { state: ProcessState; socketPath: string; agentPort: number; pid?: number }
  relay: { state: 'unknown' | 'online' | 'offline'; deviceName?: string; error?: string }
  phones: Phone[]
  error?: string
  logs: { agent: string; desktop: string }
}

const validModes: PermissionMode[] = ['ask', 'auto', 'full']

function isAlive(child: ChildProcess | undefined) {
  return Boolean(child && child.exitCode === null && !child.killed)
}

async function exists(path: string) {
  try { await access(path); return true } catch { return false }
}

async function findCodexExecutable() {
  if (process.env.RMDEX_CODEX && await exists(process.env.RMDEX_CODEX)) return process.env.RMDEX_CODEX
  const root = join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin')
  const candidates: string[] = []
  async function visit(directory: string) {
    if (!await exists(directory)) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.toLowerCase() === 'codex.exe') candidates.push(path)
    }
  }
  await visit(root)
  candidates.sort()
  return candidates.at(-1) || 'codex'
}

function run(command: string, args: string[]) {
  const useShell = process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(command)
  const child = useShell
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command, ...args], { stdio: 'ignore', windowsHide: true })
    : spawn(command, args, { stdio: 'ignore', windowsHide: true })
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? 'unknown'}`)))
  })
}

async function terminate(child: ChildProcess | undefined) {
  const active = child
  if (!isAlive(active) || !active) return
  if (process.platform === 'win32' && active.pid) {
    await run('taskkill.exe', ['/PID', String(active.pid), '/T', '/F']).catch(() => {})
    return
  }
  active.kill('SIGTERM')
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 3000)
    active.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

export class PcManager {
  private readonly root: string
  private readonly work: string
  private readonly settingsPath: string
  private readonly agentPort: number
  private readonly socketPath: string
  private readonly relayUrl: string
  private agent?: ChildProcess
  private desktop?: ChildProcess
  private agentLog?: WriteStream
  private desktopLog?: WriteStream
  private phase: ProcessState = 'stopped'
  private error = ''
  private settings: Settings = { permissionMode: 'ask' }
  private relayCache: { at: number; state: PcStatus['relay']; phones: Phone[] } = { at: 0, state: { state: 'unknown' }, phones: [] }

  constructor(root: string) {
    this.root = root
    this.work = join(root, 'work')
    this.settingsPath = join(this.work, 'pc-settings.json')
    this.agentPort = Number(process.env.RMDEX_AGENT_PORT || 18787)
    const codexHome = process.env.CODEX_HOME || join(process.env.USERPROFILE || '', '.codex')
    this.socketPath = process.env.RMDEX_CODEX_SOCKET || join(codexHome, 'app-server-control', 'app-server-control.sock')
    this.relayUrl = process.env.RMDEX_RELAY_URL || 'wss://code.kyeai.xyz/agent'
  }

  async init() {
    await mkdir(this.work, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, 'utf8')) as Partial<Settings>
      if (parsed.permissionMode && validModes.includes(parsed.permissionMode)) this.settings.permissionMode = parsed.permissionMode
    } catch { /* first run */ }
  }

  private setChildState(child: ChildProcess, type: 'agent' | 'desktop') {
    child.once('error', error => {
      this.error = `${type === 'agent' ? '本地 agent' : 'Codex Desktop'} 启动失败：${error.message}`
      if (type === 'agent') this.phase = 'error'
    })
    child.once('exit', code => {
      if (type === 'agent') this.agent = undefined
      else this.desktop = undefined
      if (code && this.phase !== 'stopped') {
        this.error = `${type === 'agent' ? '本地 agent' : 'Codex Desktop 启动器'} 已退出（代码 ${code}）`
        this.phase = 'error'
      } else if (!this.agent && !this.desktop && this.phase !== 'stopped') this.phase = 'stopped'
    })
  }

  private async preflight() {
    // Do not accidentally attach to an unrelated process already owning the agent port.
    await new Promise<void>((resolve, reject) => {
      const probe = createNetServer()
      probe.once('error', () => reject(new Error(`Port ${this.agentPort} is already in use; stop the existing agent first.`)))
      probe.listen(this.agentPort, '127.0.0.1', () => probe.close(() => resolve()))
    })
    if (process.platform === 'win32') {
      const check = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe'\" | Where-Object { $_.CommandLine -match 'app-server.*analytics-default-enabled|features\\.code_mode_host=true.*app-server' }) { exit 1 }"], { stdio: 'ignore', windowsHide: true })
      const code = await new Promise<number>((resolve, reject) => { check.once('error', reject); check.once('exit', value => resolve(value ?? 2)) })
      if (code !== 0) throw new Error('Exit Codex Desktop completely before starting shared mode. Existing sessions will not be force-closed.')
    }
  }

  private async startDaemon() {
    const codex = await findCodexExecutable()
    await run(codex, ['app-server', 'daemon', 'start'])
    const deadline = Date.now() + 30_000
    while (!await exists(this.socketPath)) {
      if (Date.now() > deadline) throw new Error(`Codex managed daemon 未就绪：${this.socketPath}`)
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  private async startAgent() {
    const node = process.execPath
    const stdout = join(this.work, 'pc-agent.stdout.log')
    const stderr = join(this.work, 'pc-agent.stderr.log')
    this.agentLog = createWriteStream(stdout, { flags: 'a' })
    const errorLog = createWriteStream(stderr, { flags: 'a' })
    const tokenPath = join(this.root, '.device-token')
    const deviceToken = process.env.RMDEX_DEVICE_TOKEN || (await readFile(tokenPath, 'utf8').catch(() => '')).trim()
    const child = spawn(node, ['--import', 'tsx', join(this.root, 'server', 'index.ts')], {
      cwd: this.root,
      env: {
        ...process.env,
        RMDEX_CODEX: await findCodexExecutable(),
        RMDEX_CODEX_MODE: 'shared',
        RMDEX_CODEX_SOCKET: this.socketPath,
        RMDEX_AGENT_PORT: String(this.agentPort),
        RMDEX_RELAY_URL: this.relayUrl,
        RMDEX_DEVICE_TOKEN: deviceToken,
        RMDEX_DEFAULT_PERMISSION_MODE: this.settings.permissionMode,
      },
      stdio: ['ignore', this.agentLog, errorLog],
      windowsHide: true,
    })
    this.agent = child
    this.setChildState(child, 'agent')
    const deadline = Date.now() + 60_000
    while (true) {
      if (!isAlive(child)) throw new Error(`本地 agent 未能启动，请查看 ${stderr}`)
      try {
        const response = await fetch(`http://127.0.0.1:${this.agentPort}/api/models`, { signal: AbortSignal.timeout(2000) })
        if (response.ok) return
      } catch { /* retry */ }
      if (Date.now() > deadline) throw new Error(`本地 agent 未在 ${this.agentPort} 端口就绪，请查看 ${stderr}`)
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }

  private startDesktop() {
    const child = spawn(process.execPath, ['--import', 'tsx', join(this.root, 'scripts', 'start-shared-desktop.ts'), '--ensure-daemon'], {
      cwd: this.root,
      env: { ...process.env, RMDEX_CODEX_MODE: 'shared', RMDEX_CODEX_SOCKET: this.socketPath },
      stdio: ['ignore', this.desktopLog, this.desktopLog],
      windowsHide: false,
    })
    this.desktop = child
    this.setChildState(child, 'desktop')
  }

  async start() {
    if (this.phase === 'starting' || isAlive(this.agent) || isAlive(this.desktop)) return this.status()
    this.phase = 'starting'
    this.error = ''
    await mkdir(this.work, { recursive: true })
    const desktopLogPath = join(this.work, 'pc-desktop.log')
    this.desktopLog = createWriteStream(desktopLogPath, { flags: 'a' })
    try {
      await this.preflight()
      await this.startDaemon()
      await this.startAgent()
      this.startDesktop()
      this.phase = 'running'
      return this.status()
    } catch (caught) {
      this.error = caught instanceof Error ? caught.message : String(caught)
      this.phase = 'error'
      await terminate(this.agent)
      this.agent = undefined
      return this.status()
    }
  }

  async stop() {
    await terminate(this.desktop)
    await terminate(this.agent)
    this.desktop = undefined
    this.agent = undefined
    this.agentLog?.end()
    this.desktopLog?.end()
    this.agentLog = undefined
    this.desktopLog = undefined
    this.phase = 'stopped'
    this.error = ''
    return this.status()
  }

  async restart() {
    await this.stop()
    return this.start()
  }

  async setPermissionMode(permissionMode: PermissionMode) {
    if (!validModes.includes(permissionMode)) throw new Error('permissionMode 必须是 ask、auto 或 full')
    this.settings.permissionMode = permissionMode
    await writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2) + '\n', { mode: 0o600 })
    if (isAlive(this.agent)) {
      const response = await fetch(`http://127.0.0.1:${this.agentPort}/api/settings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173', 'X-Rmdex-Manager': '1' },
        body: JSON.stringify({ permissionMode }), signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`更新本地权限模式失败（HTTP ${response.status}）`)
    }
    return this.status()
  }

  private async refreshRelay() {
    if (Date.now() - this.relayCache.at < 5000) return
    const token = process.env.RMDEX_WEB_CLIENT_TOKEN || (await readFile(join(this.root, '.web-client-token'), 'utf8').catch(() => '')).trim()
    if (!token) {
      this.relayCache = { at: Date.now(), state: { state: 'unknown', error: '未配置 .web-client-token' }, phones: [] }
      return
    }
    try {
      const httpUrl = this.relayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/agent$/, '')
      let response = await fetch(`${httpUrl}/api/client/peers`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
      const oldRelay = response.status === 404
      if (oldRelay) response = await fetch(`${httpUrl}/api/client`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
      const data = await response.json() as { device?: { name?: string }; phones?: Phone[]; error?: string }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      this.relayCache = { at: Date.now(), state: { state: 'online', deviceName: data.device?.name, ...(oldRelay ? { error: 'Server needs an upgrade to show phone status.' } : {}) }, phones: data.phones || [] }
    } catch (caught) {
      this.relayCache = { at: Date.now(), state: { state: 'offline', error: caught instanceof Error ? caught.message : String(caught) }, phones: [] }
    }
  }

  async status(): Promise<PcStatus> {
    await this.refreshRelay()
    const agentRunning = isAlive(this.agent)
    const desktopRunning = isAlive(this.desktop)
    let permissionMode = this.settings.permissionMode
    if (agentRunning) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.agentPort}/api/settings`, { signal: AbortSignal.timeout(1500) })
        if (response.ok) permissionMode = (await response.json() as { permissionMode: PermissionMode }).permissionMode
      } catch { /* use persisted setting */ }
    }
    return {
      phase: this.phase,
      permissionMode,
      codexDesktop: { state: desktopRunning ? 'running' : this.phase === 'starting' ? 'starting' : this.phase === 'error' ? 'error' : 'stopped', pid: this.desktop?.pid },
      appServer: { state: agentRunning ? 'running' : this.phase === 'starting' ? 'starting' : this.phase === 'error' ? 'error' : 'stopped', socketPath: this.socketPath, agentPort: this.agentPort, pid: this.agent?.pid },
      relay: this.relayCache.state,
      phones: this.relayCache.phones,
      ...(this.error ? { error: this.error } : {}),
      logs: { agent: join(this.work, 'pc-agent.stderr.log'), desktop: join(this.work, 'pc-desktop.log') },
    }
  }

  async logs() {
    const readTail = async (path: string) => {
      const text = await readFile(path, 'utf8').catch(() => '')
      return text.split(/\r?\n/).slice(-80).join('\n')
    }
    return { agent: await readTail(join(this.work, 'pc-agent.stderr.log')), desktop: await readTail(join(this.work, 'pc-desktop.log')) }
  }
}
