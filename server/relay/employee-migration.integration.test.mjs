import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import WebSocket from 'ws'
import { prepareEmployeeAssets } from '../employee-assets.ts'

const hash = value => createHash('sha256').update(value).digest('hex')
const json = (data, token) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) })

test('legacy memory is retained on device failure and migrated before thread initialization', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rmdex-employee-migration-'))
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const statePath = join(dir, 'state.json')
  const password = 'test-password'
  const deviceToken = 'test-device-token'
  await writeFile(statePath, JSON.stringify({
    users: [{ id: 'user', username: 'admin', role: 'admin', passwordHash: `sha256:${hash(password)}`, createdAt: 1 }],
    devices: [{ id: 'device', userId: 'user', name: 'PC', tokenHash: hash(deviceToken), createdAt: 1 }],
    employees: [{ id: 'employee', userId: 'user', deviceId: 'device', name: 'Employee', role: 'Tester', instructions: '', memory: 'Important old memory', projectPath: dir, threadId: 'old-thread', initializedThreadId: 'old-thread', createdAt: 1767225600000, updatedAt: 1 }],
  }))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/relay/index.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, RMDEX_STATE: statePath }, stdio: 'ignore', windowsHide: true })
  let ws
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${origin}/api/health`)).ok) break } catch {}
      await delay(100)
      if (i === 99) throw new Error('Relay failed to start')
    }
    const call = async (path, options) => { const response = await fetch(origin + path, options); return { status: response.status, data: await response.json() } }
    const login = await call('/api/auth/login', json({ username: 'admin', password }))
    ws = new WebSocket(`ws://127.0.0.1:${port}/agent`)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.send(JSON.stringify({ type: 'auth', token: deviceToken }))
    await new Promise(resolve => ws.once('message', resolve))
    let failPrepare = true
    let forwarded
    ws.on('message', async raw => {
      const message = JSON.parse(String(raw))
      if (message.type !== 'request') return
      if (message.path === '/api/employee-assets/prepare' && failPrepare) {
        ws.send(JSON.stringify({ type: 'response', id: message.id, error: 'Device storage unavailable' }))
      } else if (message.path === '/api/employee-assets/prepare') {
        const result = await prepareEmployeeAssets(message.data, join(dir, 'codex'))
        ws.send(JSON.stringify({ type: 'response', id: message.id, result }))
      } else {
        if (message.path.endsWith('/send')) forwarded = message.data
        ws.send(JSON.stringify({ type: 'response', id: message.id, result: { turn: { id: 'turn' } } }))
      }
    })
    const client = await call('/api/devices/device/web-client', json({}, login.data.accessToken))
    const token = client.data.accessToken
    const employees = await call('/api/employees', { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(employees.data.data[0].legacyMemory, undefined)
    const failed = await call('/api/threads/old-thread/send', json({ text: 'Hello', employeeId: 'employee' }, token))
    assert.equal(failed.status, 502)
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).employees[0].legacyMemory, 'Important old memory')
    failPrepare = false
    const sent = await call('/api/threads/old-thread/send', json({ text: 'Hello', employeeId: 'employee' }, token))
    assert.equal(sent.status, 200)
    assert.match(forwarded.text, /rmdex-employee/)
    assert.doesNotMatch(forwarded.text, /Important old memory/)
    assert.match(await readFile(join(dir, 'codex', 'rmdex', 'employees', 'user', 'employee', 'memories', '2026-01-01-previous-employee-memory.md'), 'utf8'), /Important old memory/)
    const savedEmployee = JSON.parse(await readFile(statePath, 'utf8')).employees[0]
    assert.equal(savedEmployee.legacyMemory, undefined)
    assert.equal(savedEmployee.memory, undefined)
  } finally {
    ws?.terminate()
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
