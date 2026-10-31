import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
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
const json = (data, token) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data) })

test('colleague communication routes current threads, isolates identity and persists retry receipts', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rmdex-communication-'))
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  const statePath = join(dir, 'state.json')
  const employee = (id, deviceId, userId = 'user') => ({ id, deviceId, userId, name: id, role: 'Test role', instructions: '', projectPath: dir, threadId: `${id}-thread`, initializedThreadId: `${id}-thread`, assetContextVersion: 1, createdAt: 1, updatedAt: 1 })
  await writeFile(statePath, JSON.stringify({
    users: [{ id: 'user', username: 'admin', role: 'admin', passwordHash: `sha256:${hash('password')}`, createdAt: 1 }, { id: 'other-user', username: 'other', role: 'user', passwordHash: 'unused', createdAt: 1 }],
    devices: [{ id: 'source', userId: 'user', name: 'Source', tokenHash: hash('source-token'), createdAt: 1 }, { id: 'target', userId: 'user', name: 'Target', tokenHash: hash('target-token'), createdAt: 1 }, { id: 'foreign', userId: 'other-user', name: 'Foreign', tokenHash: hash('foreign-token'), createdAt: 1 }],
    employees: [employee('sender', 'source'), employee('recipient', 'target'), employee('foreign-employee', 'foreign', 'other-user'), { ...employee('unopened', 'target'), threadId: undefined }],
  }))
  let child
  const sockets = []
  const requests = []
  let failQueue = false, prepareGate, enteredPrepare
  const start = async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'server/relay/index.ts'], { env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, RMDEX_STATE: statePath }, stdio: 'ignore', windowsHide: true })
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${origin}/api/health`)).ok) return } catch {}
      await delay(50)
    }
    throw new Error('Relay failed to start')
  }
  const stop = async () => {
    for (const ws of sockets.splice(0)) ws.terminate()
    const exited = new Promise(resolve => child.once('exit', resolve))
    child.kill(); await exited
  }
  const call = async (path, options) => { const res = await fetch(origin + path, options); return { status: res.status, data: await res.json() } }
  const connect = async (device, token) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`)
    sockets.push(ws)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const ready = new Promise(resolve => ws.once('message', resolve))
    ws.send(JSON.stringify({ type: 'auth', token })); await ready
    ws.on('message', async raw => {
      const msg = JSON.parse(String(raw))
      if (msg.type !== 'request') return
      requests.push({ device, ...msg })
      try {
        let result = { ok: true }
        if (msg.path === '/api/employee-assets/prepare') {
          enteredPrepare?.(); if (prepareGate) await prepareGate
          result = await prepareEmployeeAssets(msg.data, join(dir, device))
        } else if (msg.path.endsWith('/queue')) {
          if (failQueue) throw new Error('Lost response after enqueue')
          result = { outcome: 'queued', queuedSubmission: { id: randomUUID() } }
        } else if (msg.path === '/api/threads') result = { thread: { id: `replacement-${randomUUID()}` } }
        ws.send(JSON.stringify({ type: 'response', id: msg.id, result }))
      } catch (error) { ws.send(JSON.stringify({ type: 'response', id: msg.id, error: error.message })) }
    })
  }
  try {
    await start()
    await connect('source', 'source-token'); await connect('target', 'target-token')
    const login = await call('/api/auth/login', json({ username: 'admin', password: 'password' }, ''))
    const client = await call('/api/devices/source/web-client', json({}, login.data.accessToken))
    const userToken = client.data.accessToken
    assert.equal((await call('/api/threads/sender-thread/send', json({ text: 'Initialize communication', employeeId: 'sender' }, userToken))).status, 200)
    const configPath = join(dir, 'source', 'rmdex', 'employees', 'user', 'sender', 'communication.json')
    const { token } = JSON.parse(await readFile(configPath, 'utf8'))
    const send = body => call('/api/employee-communication/messages', json(body, token))
    const list = await call('/api/employee-communication/colleagues', { headers: { Authorization: `Bearer ${token}` } })
    assert.deepEqual(list.data.data.map(item => item.id), ['recipient', 'unopened'])
    assert.equal((await call('/api/threads/sender-thread', { headers: { Authorization: `Bearer ${token}` } })).status, 401)
    assert.equal((await send({ recipientId: 'foreign-employee', text: 'No', messageId: randomUUID() })).status, 404)
    assert.equal((await send({ recipientId: 'unopened', text: 'No', messageId: randomUUID() })).status, 409)
    assert.equal((await send({ recipientId: 'recipient', senderId: 'foreign-employee', text: 'Spoof', messageId: randomUUID() })).status, 400)
    const message = { recipientId: 'recipient', text: '请核实产品功能，完成后回复。', messageId: randomUUID() }
    let release
    prepareGate = new Promise(resolve => { release = resolve })
    const preparing = new Promise(resolve => { enteredPrepare = resolve })
    const first = send(message)
    await preparing
    assert.equal((await send(message)).status, 409)
    assert.equal((await call('/api/employees/recipient/reset-thread', json({}, userToken))).status, 409)
    release(); prepareGate = undefined; enteredPrepare = undefined
    const accepted = await first
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data))
    assert.equal(accepted.data.receipt.threadId, 'recipient-thread')
    const queued = requests.filter(item => item.path.endsWith('/queue'))
    assert.equal(queued.length, 1)
    assert.equal(queued[0].device, 'target')
    assert.equal(queued[0].path, '/api/threads/recipient-thread/queue')
    assert.equal(queued[0].data.clientUserMessageId, message.messageId)
    assert.match(queued[0].data.text, /rmdex_employee_context/)
    assert.match(queued[0].data.text, /rmdex_colleague_message/)
    assert.match(queued[0].data.text, /"senderName":"sender"/)
    assert.equal((await send(message)).status, 200)
    assert.equal((await send({ ...message, text: 'Changed' })).status, 409)
    assert.equal((await call('/api/employees/recipient/reset-thread', json({}, userToken))).status, 200)
    assert.equal((await send(message)).data.receipt.threadId, 'recipient-thread')
    failQueue = true
    const uncertain = { ...message, messageId: randomUUID() }
    assert.equal((await send(uncertain)).data.receipt.status, 'uncertain')
    assert.equal((await send(uncertain)).status, 409)
    assert.equal(requests.filter(item => item.path.endsWith('/queue')).length, 2)
    assert.ok(!requests.some(item => item.path.endsWith('/steer')))
    await stop(); await start()
    // Receipts remain authoritative after restart, even with the device offline.
    assert.equal((await send(message)).status, 200)
    assert.equal((await send(uncertain)).status, 409)
    assert.equal((await send({ ...message, messageId: randomUUID() })).status, 409)
    await connect('source', 'source-token')
    assert.equal((await call('/api/employees/sender/reset-thread', json({}, userToken))).status, 200)
    assert.equal((await send(message)).status, 401)
  } finally {
    if (child?.exitCode === null) await stop()
    await rm(dir, { recursive: true, force: true })
  }
})
