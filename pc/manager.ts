import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { createServer as createNetServer } from 'node:net'

export type PermissionMode = 'ask' | 'auto' | 'full'
type ProcessState = 'stopped' | 'starting' | 'running' | 'error'
type Phone = { name: string; online: boolean; lastSeenAt?: number }
type Settings = { permissionMode: PermissionMode }

/**
 * Codex Desktop starts an app-server client process, while the shared managed
 * daemon also runs as codex.exe. The daemon must survive PC restarts because
 * both rmdex and Desktop use its control socket.
 */
export function isCodexDesktopProcess(commandLine: string) {
  const normalized = commandLine.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return false
  if (/(?:^|\s)--managed-daemon(?:\s|$)/.test(normalized)) return false
  if (/\bapp-server\s+daemon\s+pid-update-loop\b/.test(normalized)) return false
  return normalized.includes('app-server')
    || normalized.includes('features.code_mode_host=true')
    || normalized.includes('codex_app.enabled=true')
}

export type PcStatus = {
  enrolled: boolean
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
  private readonly deviceTokenPath: string
  private readonly clientTokenPath: string
  private readonly clientRefreshTokenPath: string
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
    this.deviceTokenPath = join(this.work, '.device-token')
    this.clientTokenPath = join(this.work, '.web-client-token')
    this.clientRefreshTokenPath = join(this.work, '.web-client-refresh-token')
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

  private async cleanupCodexProcesses() {
    if (process.platform !== 'win32') return 0
    const script = "$pattern = 'app-server|features\\.code_mode_host=true|codex_app\\.enabled=true'; Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match $pattern } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', value => resolve(value ?? 2)) })
    if (code !== 0) throw new Error('无法读取 Codex app-server 进程列表')
    const processes = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const separator = line.indexOf('|')
      return { pid: Number(separator < 0 ? line : line.slice(0, separator)), commandLine: separator < 0 ? '' : line.slice(separator + 1) }
    }).filter(item => Number.isInteger(item.pid) && item.pid > 0 && isCodexDesktopProcess(item.commandLine))
    for (const process of processes) await run('taskkill.exe', ['/PID', String(process.pid), '/T', '/F']).catch(() => {})
    if (processes.length) await new Promise(resolve => setTimeout(resolve, 500))
    return processes.length
  }

  private async preflight() {
    await this.cleanupCodexProcesses()
    // Do not accidentally attach to an unrelated process already owning the agent port.
    await new Promise<void>((resolve, reject) => {
      const probe = createNetServer()
      probe.once('error', () => reject(new Error(`Port ${this.agentPort} is already in use; stop the existing agent first.`)))
      probe.listen(this.agentPort, '127.0.0.1', () => probe.close(() => resolve()))
    })
  }

  private async startDaemon() {
    const codex = await findCodexExecutable()
    const daemonReady = async () => {
      try {
        await run(codex, ['app-server', 'daemon', 'version'])
        return true
      } catch {
        return false
      }
    }
    // The control socket is a Windows named-pipe reparse point and can remain
    // after the daemon exits. Probe the daemon instead of trusting the path.
    if (await daemonReady()) return
    await run(codex, ['app-server', 'daemon', 'start'])
    const deadline = Date.now() + 30_000
    while (!await daemonReady()) {
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
    const rootTokenPath = join(this.root, '.device-token')
    const deviceToken = process.env.RMDEX_DEVICE_TOKEN || (await readFile(rootTokenPath, 'utf8').catch(() => '')).trim() || (await readFile(this.deviceTokenPath, 'utf8').catch(() => '')).trim()
    // Keep the entrypoint relative to cwd. Node 24 + tsx can reject a Windows
    // drive-letter path passed as an ESM entrypoint (ERR_UNSUPPORTED_ESM_URL_SCHEME).
    const child = spawn(node, ['--import', 'tsx', 'server/index.ts'], {
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
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/start-shared-desktop.ts', '--ensure-daemon', '--wait-for-desktop-exit'], {
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
      await this.cleanupCodexProcesses().catch(() => {})
      return this.status()
    }
  }

  async stop() {
    await terminate(this.desktop)
    await terminate(this.agent)
    await this.cleanupCodexProcesses()
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

  async enroll(username: string, password: string, deviceName: string) {
    const cleanUsername = username.trim()
    const cleanName = deviceName.trim().slice(0, 80)
    if (!cleanUsername || password.length < 1 || !cleanName) throw new Error('请输入工作空间管理员账号、密码和电脑名称')
    const httpUrl = this.relayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/agent$/, '')
    const loginResponse = await fetch(`${httpUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: cleanUsername, password }), signal: AbortSignal.timeout(10_000),
    })
    const login = await loginResponse.json() as { accessToken?: string; error?: string }
    if (!loginResponse.ok || !login.accessToken) throw new Error(login.error || '工作空间登录失败')
    const registerResponse = await fetch(`${httpUrl}/api/devices`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ name: cleanName }), signal: AbortSignal.timeout(10_000),
    })
    const registration = await registerResponse.json() as { token?: string; accessToken?: string; refreshToken?: string; error?: string }
    if (!registerResponse.ok || !registration.token) throw new Error(registration.error || '电脑注册失败')
    await mkdir(this.work, { recursive: true })
    await writeFile(this.deviceTokenPath, registration.token, { mode: 0o600 })
    if (registration.accessToken && registration.refreshToken) {
      await writeFile(this.clientTokenPath, registration.accessToken, { mode: 0o600 })
      await writeFile(this.clientRefreshTokenPath, registration.refreshToken, { mode: 0o600 })
    }
    this.relayCache.at = 0
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
    const token = process.env.RMDEX_WEB_CLIENT_TOKEN || (await readFile(join(this.root, '.web-client-token'), 'utf8').catch(() => '')).trim() || (await readFile(this.clientTokenPath, 'utf8').catch(() => '')).trim()
    if (!token) {
      this.relayCache = { at: Date.now(), state: { state: 'unknown', error: '未配置 .web-client-token' }, phones: [] }
      return
    }
    try {
      const httpUrl = this.relayUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/agent$/, '')
      let response = await fetch(`${httpUrl}/api/client/peers`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
      if (response.status === 401 && !process.env.RMDEX_WEB_CLIENT_TOKEN) {
        const refreshToken = (await readFile(this.clientRefreshTokenPath, 'utf8').catch(() => '')).trim()
        if (refreshToken) {
          const refreshed = await fetch(`${httpUrl}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }), signal: AbortSignal.timeout(5000) })
          const credentials = await refreshed.json() as { accessToken?: string; refreshToken?: string }
          if (refreshed.ok && credentials.accessToken && credentials.refreshToken) {
            await writeFile(this.clientTokenPath, credentials.accessToken, { mode: 0o600 })
            await writeFile(this.clientRefreshTokenPath, credentials.refreshToken, { mode: 0o600 })
            response = await fetch(`${httpUrl}/api/client/peers`, { headers: { Authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(5000) })
          }
        }
      }
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
      enrolled: Boolean(process.env.RMDEX_DEVICE_TOKEN || await readFile(join(this.root, '.device-token'), 'utf8').catch(() => '') || await readFile(this.deviceTokenPath, 'utf8').catch(() => '')),
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
