import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import WebSocket from 'ws'

const dir = await mkdtemp(join(tmpdir(), 'rmdex-test-'))
const port = 21976
const origin = `http://127.0.0.1:${port}`
const password = 'test-password-not-for-production'
const child = spawn(process.execPath, ['--import', 'tsx', 'server/relay/index.ts'], {
  env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, RMDEX_STATE: join(dir, 'state.json'), RMDEX_ADMIN_HASH: (await import('node:crypto')).createHash('sha256').update(password).digest('hex') },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let errors = ''
child.stderr.on('data', data => { errors += String(data) })
async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(origin + path, options)
  return { status: response.status, data: await response.json() as Record<string, any> }
}
const json = (data: unknown, token?: string): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) })
let ws: WebSocket | undefined
let agent: ReturnType<typeof spawn> | undefined
const fakeAgent = createServer((req, res) => {
  if (req.url?.startsWith('/api/images/')) { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); return }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ data: [{ id: 'local-agent-test' }], path: req.url }))
})
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await request('/api/health')).status === 200) break } catch {}
    await delay(100)
    if (i === 49) throw new Error(`Relay did not start: ${errors}`)
  }
  assert.equal((await request('/api/threads')).status, 401)
  assert.equal((await request('/api/auth/login', json({ password: 'incorrect' }))).status, 401)
  assert.equal((await request('/api/auth/login', { ...json({ password }), headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' } })).status, 403)
  const admin = (await request('/api/auth/login', json({ password }))).data.token as string
  assert.ok(admin)
  const device = (await request('/api/devices', json({ name: 'Synthetic test device' }, admin))).data
  assert.ok(device.token && device.id)
  ws = new WebSocket(`ws://127.0.0.1:${port}/agent`)
  await new Promise<void>((resolve, reject) => { ws!.once('open', () => resolve()); ws!.once('error', reject) })
  ws.send(JSON.stringify({ type: 'auth', token: device.token }))
  await new Promise<void>((resolve, reject) => {
    ws!.once('message', data => { try { assert.equal(JSON.parse(String(data)).type, 'ready'); resolve() } catch (error) { reject(error) } })
  })
  ws.on('message', data => {
    const item = JSON.parse(String(data))
    if (item.type === 'request') ws!.send(JSON.stringify({ type: 'response', id: item.id, result: { data: [{ id: 'test-thread' }] } }))
  })
  const pairing = (await request(`/api/devices/${device.id}/pair`, json({}, admin))).data
  assert.equal(pairing.code.length, 32)
  assert.ok(pairing.url.includes('/#pair='))
  const claim = await request('/api/pair/claim', json({ code: pairing.code, name: 'test phone' }))
  assert.equal(claim.status, 202)
  assert.equal((await request('/api/pair/claim', json({ code: pairing.code }))).status, 400)
  const pendingList = await request('/api/pair-requests', { headers: { Authorization: `Bearer ${admin}` } })
  assert.equal(pendingList.data.data.length, 1)
  const statusBody = json({ requestId: claim.data.requestId })
  assert.equal((await request('/api/pair/status', statusBody)).data.status, 'pending')
  const approved = await request(`/api/pair-requests/${claim.data.requestId}`, json({ decision: 'approve' }, admin))
  assert.equal(approved.status, 200)
  const claimedStatus = await request('/api/pair/status', statusBody)
  assert.equal(claimedStatus.data.status, 'approved')
  assert.equal((await request('/api/pair/status', statusBody)).data.status, 'expired')
  const client = claimedStatus.data.token as string
  const headers = { Authorization: `Bearer ${client}` }
  assert.equal((await request('/api/client', { headers })).data.device.online, true)
  assert.equal((await request('/api/threads', { headers })).data.data[0].id, 'test-thread')
  assert.equal((await request('/api/unknown', { headers })).status, 404)
  assert.equal((await request(`/api/devices/${device.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } })).status, 200)
  assert.equal((await request('/api/client', { headers })).status, 401)
  assert.equal((await request('/api/threads', { headers })).status, 401)
  await new Promise<void>(resolve => fakeAgent.listen(0, '127.0.0.1', resolve))
  const address = fakeAgent.address()
  assert.ok(address && typeof address !== 'string')
  const device2 = (await request('/api/devices', json({ name: 'Real outbound agent' }, admin))).data
  agent = spawn(process.execPath, ['--import', 'tsx', 'server/remote-agent.ts'], {
    env: { ...process.env, RMDEX_RELAY_URL: `ws://127.0.0.1:${port}/agent`, RMDEX_DEVICE_TOKEN: device2.token, RMDEX_AGENT_PORT: String(address.port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const pair2 = (await request(`/api/devices/${device2.id}/pair`, json({}, admin))).data
  const claim2 = (await request('/api/pair/claim', json({ code: pair2.code, name: 'real outbound test phone' }))).data
  await request(`/api/pair-requests/${claim2.requestId}`, json({ decision: 'approve' }, admin))
  const client2 = (await request('/api/pair/status', json({ requestId: claim2.requestId }))).data.token
  const headers2 = { Authorization: `Bearer ${client2}` }
  for (let i = 0; i < 50; i++) {
    if ((await request('/api/client', { headers: headers2 })).data.device.online) break
    await delay(100)
    if (i === 49) throw new Error('Outbound agent did not connect')
  }
  const forwarded = await request('/api/threads', { headers: headers2 })
  assert.equal(forwarded.status, 200)
  assert.equal(forwarded.data.data[0].id, 'local-agent-test')
  assert.equal(forwarded.data.path, '/api/threads')
  const image = await fetch(origin + '/api/images/01234567-89ab-cdef-0123-456789abcdef', { headers: headers2 })
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await image.arrayBuffer()).subarray(0, 4).toString('hex'), '89504e47')
  assert.equal((await request(`/api/devices/${device2.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } })).status, 200)
  assert.equal((await request('/api/client', { headers: headers2 })).status, 401)
  console.log('Relay checks passed: auth, origin, pairing replay, online, real outbound agent forwarding, allowlist, revocation')
} finally {
  ws?.terminate()
  if (agent && agent.exitCode === null) { agent.kill(); await new Promise<void>(resolve => agent!.once('exit', () => resolve())) }
  fakeAgent.close()
  child.kill()
  await new Promise<void>(resolve => child.once('exit', () => resolve()))
  await rm(dir, { recursive: true, force: true })
}
