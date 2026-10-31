import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const statePath = join(dir, 'state.json')
const skillPath = join(dir, 'distributed-skill.md')
const distributedSkill = `${await readFile('server/skills/rmdex-employee/SKILL.md', 'utf8')}\n<!-- relay distribution test -->\n`
await writeFile(skillPath, distributedSkill)
const crypto = await import('node:crypto')
const existingAdminPasswordHash = `sha256:${crypto.createHash('sha256').update(password).digest('hex')}`
await writeFile(statePath, JSON.stringify({ devices: [{ id: 'unowned-pc', name: 'Unowned PC', tokenHash: 'not-attached-to-a-user', createdAt: 1 }], clients: [], pairings: [], pairRequests: [], users: [{ id: 'existing-admin', username: 'admin', passwordHash: existingAdminPasswordHash, role: 'admin', createdAt: 1 }], sessions: [], pushTokens: [], notifications: [], employees: [] }))
const child = spawn(process.execPath, ['--import', 'tsx', 'server/relay/index.ts'], {
  env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, RMDEX_STATE: statePath, RMDEX_EMPLOYEE_SKILL: skillPath, RMDEX_ADMIN_HASH: crypto.createHash('sha256').update(password).digest('hex') },
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
let forwardedBody: Record<string, unknown> | undefined
const fakeAgent = createServer(async (req, res) => {
  if (req.url?.startsWith('/api/images/')) { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); return }
  let raw = ''
  for await (const chunk of req) raw += String(chunk)
  if (raw) forwardedBody = JSON.parse(raw) as Record<string, unknown>
  res.setHeader('Content-Type', 'application/json')
  if (req.url === '/api/threads' && req.method === 'POST') { res.end(JSON.stringify({ thread: { id: 'employee-test-thread' } })); return }
  if (req.url === '/api/models') { res.end(JSON.stringify({ data: [{ id: 'dynamic-model', displayName: 'Dynamic Model' }] })); return }
  if (req.url?.endsWith('/send')) { res.end(JSON.stringify({ turn: { id: 'completed-turn' }, path: req.url })); return }
  if (req.url?.endsWith('/status')) { res.end(JSON.stringify({ activeTurnId: null, lastTurn: { id: 'completed-turn', status: 'completed' }, path: req.url })); return }
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
  const login = (await request('/api/auth/login', json({ username: 'admin', password }))).data
  assert.ok(login.accessToken && login.refreshToken)
  const refreshed = await request('/api/auth/refresh', json({ refreshToken: login.refreshToken }))
  assert.equal(refreshed.status, 200)
  assert.equal((await request('/api/auth/refresh', json({ refreshToken: login.refreshToken }))).status, 401)
  const admin = (await request('/api/auth/login', json({ username: 'admin', password }))).data.accessToken as string
  assert.equal((await request('/api/auth/me', { headers: { Authorization: `Bearer ${admin}` } })).data.user.id, 'existing-admin')
  const defaultUsers = await request('/api/users', { headers: { Authorization: `Bearer ${admin}` } })
  assert.equal(defaultUsers.status, 200)
  assert.equal(defaultUsers.data.data[0].id, 'existing-admin')
  const initialDevices = await request('/api/devices', { headers: { Authorization: `Bearer ${admin}` } })
  assert.equal(initialDevices.status, 200)
  assert.deepEqual(initialDevices.data.data, [])
  const createdUser = await request('/api/users', json({ username: 'user-two', password: 'user-password-long-enough' }, admin))
  assert.equal(createdUser.status, 201)
  const userLogin = await request('/api/auth/login', json({ username: 'user-two', password: 'user-password-long-enough' }))
  assert.equal(userLogin.status, 200)
  assert.equal(userLogin.data.user.role, 'user')
  const userToken = userLogin.data.accessToken as string
  const userList = await request('/api/users', { headers: { Authorization: `Bearer ${userToken}` } })
  assert.deepEqual(userList.data.data.map((item: { id: string }) => item.id), [userLogin.data.user.id])
  const userDevice = await request('/api/devices', json({ name: 'User PC' }, userToken))
  assert.equal(userDevice.status, 201)
  assert.equal(userDevice.data.userId, userLogin.data.user.id)
  assert.equal((await request('/api/devices', { headers: { Authorization: `Bearer ${userToken}` } })).data.data[0].id, userDevice.data.id)
  assert.equal((await request(`/api/devices/${userDevice.data.id}/web-client`, json({}, admin))).status, 201)
  const deviceResponse = await request('/api/devices', json({ name: 'Synthetic test device', userId: 'existing-admin' }, admin))
  const device = deviceResponse.data
  assert.equal((await request(`/api/devices/${device.id}/web-client`, json({}, userToken))).status, 404)
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
  const pushRegistration = await request('/api/push/register', { ...json({ installationId: 'test-installation-1234' }), headers: { ...headers, 'Content-Type': 'application/json' } })
  assert.equal(pushRegistration.status, 200)
  assert.ok(pushRegistration.data.pushToken)
  assert.equal((await request(`/api/notifications/poll?wait=0&after=0`, { headers: { Authorization: `Bearer ${pushRegistration.data.pushToken}` } })).status, 200)
  assert.equal((await request('/api/devices', { headers })).status, 401)
  assert.equal((await request('/api/client', { headers })).data.device.online, true)
  assert.equal((await request('/api/threads', { headers })).data.data[0].id, 'test-thread')
  assert.equal((await request('/api/unknown', { headers })).status, 404)
  assert.equal((await request(`/api/devices/${device.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } })).status, 200)
  assert.equal((await request('/api/client', { headers })).status, 401)
  assert.equal((await request('/api/threads', { headers })).status, 401)
  await new Promise<void>(resolve => fakeAgent.listen(0, '127.0.0.1', resolve))
  const address = fakeAgent.address()
  assert.ok(address && typeof address !== 'string')
  const device2 = (await request('/api/devices', json({ name: 'Real outbound agent', userId: 'existing-admin' }, admin))).data
  agent = spawn(process.execPath, ['--import', 'tsx', 'server/remote-agent.ts'], {
    env: { ...process.env, CODEX_HOME: dir, RMDEX_RELAY_URL: `ws://127.0.0.1:${port}/agent`, RMDEX_DEVICE_TOKEN: device2.token, RMDEX_AGENT_PORT: String(address.port) },
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
  for (let i = 0; i < 50; i++) {
    const installed = await readFile(join(dir, 'skills', 'rmdex-employee', 'SKILL.md'), 'utf8').catch(() => '')
    if (installed === distributedSkill) break
    await delay(100)
    if (i === 49) throw new Error('Distributed employee skill was not installed')
  }
  const employeeCreated = await request('/api/employees', json({ name: 'Test employee', role: 'Tester', instructions: 'Check the project', projectPath: dir }, client2))
  assert.equal(employeeCreated.status, 201)
  const employee = employeeCreated.data.employee
  const employeeThread = await request(`/api/employees/${employee.id}/ensure-thread`, json({}, client2))
  assert.equal(employeeThread.status, 200)
  assert.equal((await request(`/api/threads/${employeeThread.data.thread.id}/send`, json({ text: 'Begin', employeeId: employee.id }, client2))).status, 200)
  assert.match(String(forwardedBody?.text), /rmdex-employee/)
  const employeeAssets = join(dir, 'rmdex', 'employees', 'existing-admin', employee.id)
  await writeFile(join(employeeAssets, 'memories', '2026-01-01-test.md'), 'remember this')
  assert.equal(await readFile(join(employeeAssets, 'memories', '2026-01-01-test.md'), 'utf8'), 'remember this')
  assert.equal(await readFile(join(dir, 'skills', 'rmdex-employee', 'SKILL.md'), 'utf8'), distributedSkill)
  const forwarded = await request('/api/threads', { headers: headers2 })
  assert.equal(forwarded.status, 200)
  assert.equal(forwarded.data.data[0].id, 'local-agent-test')
  assert.equal(forwarded.data.path, '/api/threads')
  const pushRegistration2 = await request('/api/push/register', { ...json({ installationId: 'test-installation-5678' }), headers: { ...headers2, 'Content-Type': 'application/json' } })
  assert.equal(pushRegistration2.status, 200)
  const waitingNotifications = request(`/api/notifications/poll?wait=10000&after=${Date.now()}`, { headers: { Authorization: `Bearer ${pushRegistration2.data.pushToken}` } })
  const models = await request('/api/models', { headers: headers2 })
  assert.equal(models.status, 200)
  assert.equal(models.data.data[0].id, 'dynamic-model')
  const projects = await request('/api/projects', { headers: headers2 })
  assert.equal(projects.status, 200)
  assert.equal(projects.data.path, '/api/projects')
  const createdProject = await request('/api/projects', { ...json({ name: 'rmdex', path: 'D:/WorkSpace/rmdex' }), headers: { ...headers2, 'Content-Type': 'application/json' } })
  assert.equal(createdProject.status, 200)
  assert.equal(forwardedBody?.name, 'rmdex')
  assert.equal(forwardedBody?.path, 'D:/WorkSpace/rmdex')
  const sent = await request('/api/threads/local-agent-test/send', { ...json({ text: 'model forwarding', permissionMode: 'ask', model: 'dynamic-model', effort: 'high' }), headers: { ...headers2, 'Content-Type': 'application/json' } })
  assert.equal(sent.status, 200)
  const notifications = await waitingNotifications
  assert.equal(notifications.status, 200)
  const forwardedNotification = notifications.data.data.find((event: { threadId: string }) => event.threadId === 'local-agent-test')
  assert.equal(forwardedNotification?.turnId, 'completed-turn')
  assert.ok(notifications.data.cursor > 0)
  assert.equal((await request(`/api/notifications/poll?wait=0&after=${notifications.data.cursor}`, { headers: { Authorization: `Bearer ${pushRegistration2.data.pushToken}` } })).data.data.length, 0)
  assert.equal(forwardedBody?.model, 'dynamic-model')
  assert.equal(forwardedBody?.effort, 'high')
  const retryRequest = { turnId: 'source-turn', operationId: crypto.randomUUID(), permissionMode: 'ask' }
  const forwardedRetry = await request('/api/threads/local-agent-test/retry', json(retryRequest, client2))
  assert.equal(forwardedRetry.status, 200)
  assert.equal(forwardedRetry.data.path, '/api/threads/local-agent-test/retry')
  assert.deepEqual(forwardedBody, retryRequest)
  assert.equal((await request('/api/threads/local-agent-test/revert', json({}, client2))).status, 404)
  const history = await request('/api/threads/local-agent-test/history', { ...json({ cursor: 'older-history' }), headers: { ...headers2, 'Content-Type': 'application/json' } })
  assert.equal(history.status, 200)
  assert.equal(history.data.path, '/api/threads/local-agent-test/history')
  assert.equal(forwardedBody?.cursor, 'older-history')
  assert.equal((await request('/api/threads/local-agent-test/register', { ...json({}), headers: { ...headers2, 'Content-Type': 'application/json' } })).status, 404)
  const image = await fetch(origin + '/api/images/01234567-89ab-cdef-0123-456789abcdef', { headers: headers2 })
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(Buffer.from(await image.arrayBuffer()).subarray(0, 4).toString('hex'), '89504e47')
  const attachment = await request('/api/attachments', { ...json({ name: 'notes.txt', type: 'text/plain', data: 'bm90ZXM=' }), headers: { ...headers2, 'Content-Type': 'application/json' } })
  assert.equal(attachment.status, 200)
  assert.equal(attachment.data.path, '/api/attachments')
  assert.equal(forwardedBody?.name, 'notes.txt')
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
