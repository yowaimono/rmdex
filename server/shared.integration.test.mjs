import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import { test } from 'node:test'
import WebSocket from 'ws'
import { createDesktopBridge } from './desktop-bridge.ts'

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function waitFor(fn, timeout = 15000) {
  const end = Date.now() + timeout
  let lastError
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value } catch (error) { lastError = error }
    await delay(100)
  }
  throw lastError || new Error('Timed out waiting for test condition')
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit').catch(() => {})
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    await once(killer, 'exit').catch(() => {})
  } else child.kill()
  await Promise.race([exited, delay(1000)])
  child.stdin?.destroy()
  child.stdout?.destroy()
  child.stderr?.destroy()
}

async function stopCodexForSocket(socket, child) {
  if (process.platform === 'win32') {
    const escaped = socket.replaceAll("'", "''")
    const script = `$needle = '${escaped}'; Get-CimInstance Win32_Process -Filter "Name = 'codex.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
    const powershell = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore', windowsHide: true })
    await once(powershell, 'exit')
  }
  await stopChild(child)
}

function spawnCodex(args, options) {
  if (process.platform === 'win32') return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'codex.cmd', ...args], options)
  return spawn('codex', args, options)
}

test('shared client observes turns, forks history, and defers queued messages', { timeout: 90000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-shared-test-'))
  const socket = join(homedir(), '.codex', 'app-server-control', `rmdex-test-${process.pid}.sock`)
  let response
  const model = createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); response = res })
  const modelPort = await listen(model)
  const portProbe = createServer()
  const agentPort = await listen(portProbe)
  await new Promise(resolve => portProbe.close(resolve))
  const codexSpawnOptions = { env: { ...process.env, CODEX_HOME: home, RMDEX_TEST_KEY: 'test' }, stdio: 'ignore', windowsHide: true }
  const codexArgs = [
    '-c', 'model_provider="rmdextest"', '-c', 'model_providers.rmdextest.name="test"',
    '-c', `model_providers.rmdextest.base_url="http://127.0.0.1:${modelPort}/v1"`,
    '-c', 'model_providers.rmdextest.env_key="RMDEX_TEST_KEY"',
    'app-server', '--listen', `unix://${socket}`,
  ]
  const startCodex = () => spawnCodex(codexArgs, codexSpawnOptions)
  let codex = startCodex()
  let bridge, ws, agent
  try {
    await waitFor(async () => {
      const child = process.platform === 'win32'
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'codex.cmd', 'app-server', 'proxy', '--sock', socket], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
        : spawn('codex', ['app-server', 'proxy', '--sock', socket], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      child.on('error', () => {})
      const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
      let connection
      try {
        connection = new WebSocket('ws://localhost/rpc', { createConnection: () => stream, handshakeTimeout: 1000 })
        await new Promise((resolve, reject) => { connection.once('open', resolve); connection.once('error', reject) })
        return true
      } catch { return false }
      finally {
        connection?.terminate()
        await stopChild(child)
        stream.destroy()
      }
    })
    bridge = await createDesktopBridge(socket)
    const connect = (url, options) => new Promise((resolve, reject) => {
      const connection = new WebSocket(url, options)
      connection.once('open', () => resolve(connection))
      connection.once('error', reject)
    })
    await assert.rejects(connect(bridge.url.replace(/\/[a-f0-9]+$/, '/wrong')))
    await assert.rejects(connect(bridge.url, { origin: 'https://example.com' }))
    ws = await connect(bridge.url)
    let sequence = 0
    const pending = new Map()
    ws.on('message', raw => { const message = JSON.parse(raw.toString()); if (!message.method && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) } })
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10000)
      pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result) })
      ws.send(JSON.stringify({ id, method, params }))
    })
    await rpc('initialize', { clientInfo: { name: 'rmdex-test', version: '1' }, capabilities: { experimentalApi: true } })
    ws.send(JSON.stringify({ method: 'initialized', params: {} }))
    const { thread } = await rpc('thread/start', { cwd: home, approvalPolicy: 'never' })
    const { turn } = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'test', text_elements: [] }] })
    await waitFor(() => response)
    agent = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, CODEX_HOME: home, RMDEX_CODEX_MODE: 'shared', RMDEX_CODEX_SOCKET: socket, RMDEX_AGENT_PORT: String(agentPort), RMDEX_RELAY_URL: '', RMDEX_DEVICE_TOKEN: '' },
      stdio: 'ignore', windowsHide: true,
    })
    const health = await waitFor(async () => {
      const result = await fetch(`http://127.0.0.1:${agentPort}/api/health`)
      return result.ok ? result.json() : null
    })
    assert.equal(health.state, 'ready')
    const read = async () => {
      const result = await fetch(`http://127.0.0.1:${agentPort}/api/threads/${thread.id}`)
      const body = await result.json()
      if (!result.ok) throw new Error(body.error)
      return body
    }
    const active = await waitFor(read)
    assert.equal(active.activeTurnId, turn.id)
    const renamed = await fetch(`http://127.0.0.1:${agentPort}/api/threads/${thread.id}/name`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: JSON.stringify({ name: 'Shared integration thread' }),
    })
    assert.equal(renamed.status, 200, JSON.stringify(await renamed.json()))
    const status = await fetch(`http://127.0.0.1:${agentPort}/api/threads/${thread.id}/status`)
    assert.equal(status.status, 200)
    assert.equal((await status.json()).activeTurnId, turn.id)
    const incremental = await fetch(`http://127.0.0.1:${agentPort}/api/threads/${thread.id}/incremental`)
    assert.equal(incremental.status, 200)
    assert.ok(Array.isArray((await incremental.json()).thread.turns))
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'test-response', object: 'response', created_at: 1, status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
    const finished = await waitFor(async () => { const result = await read(); return result.activeTurnId === null && result.lastTurn?.status === 'completed' ? result : null })
    assert.equal(finished.lastTurn.status, 'completed')
    response = undefined
    const imagePath = join(home, 'test.png')
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aXcAAAAASUVORK5CYII=', 'base64')
    await writeFile(imagePath, imageBytes)
    const next = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'test interrupt', text_elements: [] }, { type: 'localImage', path: imagePath }] })
    await waitFor(() => response)
    await waitFor(async () => (await read()).activeTurnId === next.turn.id)
    const activeFork = await fetch(`http://127.0.0.1:${agentPort}/api/threads/${thread.id}/fork`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: JSON.stringify({ lastTurnId: next.turn.id }),
    })
    const activeForkResult = await activeFork.json()
    assert.equal(activeFork.status, 502, JSON.stringify(activeForkResult))
    assert.match(activeForkResult.error, /仍在执行/)
    await waitFor(async () => {
      const result = await (await fetch(`http://127.0.0.1:${agentPort}/api/threads/${thread.id}/status`)).json()
      return result.live?.items?.some(item => item.content?.some(part => part.type === 'localImage'))
    })
    const withImage = await read()
    const image = withImage.thread.turns.find(item => item.id === next.turn.id)?.items.flatMap(item => item.content || []).find(part => part.type === 'localImage')
    assert.match(image?.assetUrl || '', /^\/api\/images\//)
    const imageResponse = await fetch(`http://127.0.0.1:${agentPort}${image.assetUrl}`)
    assert.equal(imageResponse.status, 200)
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageBytes)
    const stopped = await fetch(`http://127.0.0.1:${agentPort}/api/threads/${thread.id}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: '{}',
    })
    assert.equal(stopped.status, 200, JSON.stringify(await stopped.json()))
    await waitFor(async () => { const result = await read(); return result.activeTurnId === null && result.lastTurn?.status === 'interrupted' })
    const forkResponse = await fetch(`http://127.0.0.1:${agentPort}/api/threads/${thread.id}/fork`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: JSON.stringify({ lastTurnId: turn.id }),
    })
    const forkResult = await forkResponse.json()
    assert.equal(forkResponse.status, 200, JSON.stringify(forkResult))
    const forked = forkResult.thread
    assert.ok(forked?.id)
    const forkReadResponse = await fetch(`http://127.0.0.1:${agentPort}/api/threads/${forked.id}`)
    assert.equal(forkReadResponse.status, 200)
    const forkRead = await forkReadResponse.json()
    assert.deepEqual(forkRead.thread.turns.map(item => item.id), [turn.id])
    assert.deepEqual((await read()).thread.turns.map(item => item.id), [turn.id, next.turn.id])
    // Native queue must start idle threads and defer busy-thread submissions.
    t.diagnostic('checking idle queue dispatch')
    response = undefined
    const blankResponse = await fetch(`http://127.0.0.1:${agentPort}/api/threads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: JSON.stringify({ cwd: home }),
    })
    const blank = await blankResponse.json()
    assert.equal(blankResponse.status, 200, JSON.stringify(blank))
    const queueThreadId = blank.thread.id
    const enqueue = text => fetch(`http://127.0.0.1:${agentPort}/api/threads/${queueThreadId}/queue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: JSON.stringify({ text }),
    })
    const idleQueued = await enqueue('idle colleague message')
    assert.equal(idleQueued.status, 200, JSON.stringify(await idleQueued.json()))
    t.diagnostic('idle submission accepted')
    await waitFor(() => response)
    const firstResponse = response
    t.diagnostic('idle submission started')
    const busyQueued = await enqueue('busy colleague message')
    assert.equal(busyQueued.status, 200, JSON.stringify(await busyQueued.json()))
    const queue = await (await fetch(`http://127.0.0.1:${agentPort}/api/threads/${queueThreadId}/queue`)).json()
    assert.equal(queue.data.length, 1)
    assert.equal(response, firstResponse)
    firstResponse.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'queue-response', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`)
    await waitFor(() => response && response !== firstResponse)
    assert.equal((await (await fetch(`http://127.0.0.1:${agentPort}/api/threads/${queueThreadId}/queue`)).json()).data.length, 0)
    const queueRead = await (await fetch(`http://127.0.0.1:${agentPort}/api/threads/${queueThreadId}`)).json()
    assert.deepEqual(queueRead.thread.turns.flatMap(turn => turn.items.filter(item => item.type === 'userMessage').flatMap(item => item.content.filter(part => part.type === 'text').map(part => part.text))), ['idle colleague message', 'busy colleague message'])
    await fetch(`http://127.0.0.1:${agentPort}/api/threads/${queueThreadId}/stop`, {
      method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}',
    })
  } finally {
    ws?.terminate()
    bridge?.close()
    await stopChild(agent)
    await stopChild(codex)
    response?.destroy()
    model.closeAllConnections()
    await new Promise(resolve => model.close(resolve))
    await unlink(socket).catch(() => {})
  }
})

test('shared proxy reconnects after the Codex app-server restarts', { timeout: 90000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-reconnect-test-'))
  const socket = join(homedir(), '.codex', 'app-server-control', `rmdex-reconnect-${process.pid}-${Date.now()}.sock`)
  const model = createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}') })
  const modelPort = await listen(model)
  const portProbe = createServer()
  const agentPort = await listen(portProbe)
  await new Promise(resolve => portProbe.close(resolve))
  const codexSpawnOptions = { env: { ...process.env, CODEX_HOME: home, RMDEX_TEST_KEY: 'test' }, stdio: 'ignore', windowsHide: true }
  const codexArgs = [
    '-c', 'model_provider="rmdextest"', '-c', 'model_providers.rmdextest.name="test"',
    '-c', `model_providers.rmdextest.base_url="http://127.0.0.1:${modelPort}/v1"`,
    '-c', 'model_providers.rmdextest.env_key="RMDEX_TEST_KEY"',
    'app-server', '--listen', `unix://${socket}`,
  ]
  const startCodex = () => spawnCodex(codexArgs, codexSpawnOptions)
  let codex = startCodex()
  const agent = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, CODEX_HOME: home, RMDEX_CODEX_MODE: 'shared', RMDEX_CODEX_SOCKET: socket, RMDEX_AGENT_PORT: String(agentPort), RMDEX_RELAY_URL: '', RMDEX_DEVICE_TOKEN: '' },
    stdio: 'ignore', windowsHide: true,
  })
  const readHealth = async () => {
    const response = await fetch(`http://127.0.0.1:${agentPort}/api/health`)
    return { status: response.status, body: await response.json() }
  }
  try {
    await waitFor(async () => { const health = await readHealth(); return health.status === 200 ? health : null })
    await stopCodexForSocket(socket, codex)
    await waitFor(async () => { const health = await readHealth(); return health.status === 503 ? health : null })
    codex = startCodex()
    const recovered = await waitFor(async () => { const health = await readHealth(); return health.status === 200 ? health : null })
    assert.equal(recovered.body.state, 'ready')
    const models = await fetch(`http://127.0.0.1:${agentPort}/api/models`)
    assert.equal(models.status, 200, await models.text())
  } finally {
    await stopChild(agent)
    await stopCodexForSocket(socket, codex)
    model.closeAllConnections()
    await new Promise(resolve => model.close(resolve))
    await unlink(socket).catch(() => {})
    await rm(home, { recursive: true, force: true })
  }
})
