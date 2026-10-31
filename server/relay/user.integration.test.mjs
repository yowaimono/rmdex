import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import WebSocket from 'ws'
import { prepareEmployeeAssets } from '../employee-assets.ts'

function sha256(value) { return createHash('sha256').update(value).digest('hex') }
async function freePort() {
  const { createServer } = await import('node:net')
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}
async function waitForHealth(origin, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return } catch { /* relay is still starting */ }
    await delay(100)
  }
  throw new Error(`Relay did not start: ${stderr()}; exit=${child.exitCode}`)
}
function json(body, token) { return { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) } }
async function request(origin, path, options = {}) {
  const response = await fetch(origin + path, options)
  const raw = await response.text()
  return { status: response.status, data: raw ? JSON.parse(raw) : null }
}

test('relay isolates users across devices, pairings, and employees', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rmdex-user-integration-'))
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const adminPassword = 'platform-admin-password'
  const statePath = join(dir, 'state.json')
  await writeFile(statePath, JSON.stringify({
    devices: [], clients: [], pairings: [], pairRequests: [],
    users: [{ id: 'platform-admin', username: 'admin', passwordHash: `sha256:${sha256(adminPassword)}`, role: 'admin', createdAt: 1 }],
    sessions: [], pushTokens: [], notifications: [], employees: [],
  }))
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/relay/index.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, RMDEX_STATE: statePath, RMDEX_ADMIN_HASH: sha256(adminPassword) }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', data => { stderr += String(data) })
  let employeeWs
  try {
    await waitForHealth(origin, child, () => stderr)
    const login = async (username, password) => {
      const result = await request(origin, '/api/auth/login', json({ username, password }))
      assert.equal(result.status, 200, JSON.stringify(result.data))
      return result.data
    }
    const admin = await login('admin', adminPassword)
    const createUser = async username => request(origin, '/api/users', json({ username, password: `${username}-password-long` }, admin.accessToken))
    assert.equal((await createUser('user-a')).status, 201)
    assert.equal((await createUser('user-b')).status, 201)
    const accountA = await login('user-a', 'user-a-password-long')
    const accountB = await login('user-b', 'user-b-password-long')

    const deviceA = await request(origin, '/api/devices', json({ name: 'User A PC' }, accountA.accessToken))
    assert.equal(deviceA.status, 201)
    assert.equal(deviceA.data.userId, accountA.user.id)
    const deviceB = await request(origin, '/api/devices', json({ name: 'User B PC', userId: accountB.user.id }, admin.accessToken))
    assert.equal(deviceB.status, 201)
    assert.equal(deviceB.data.userId, accountB.user.id)
    assert.equal(deviceB.data.user.id, accountB.user.id)
    assert.deepEqual((await request(origin, '/api/devices', { headers: { Authorization: `Bearer ${accountA.accessToken}` } })).data.data.map(item => item.id), [deviceA.data.id])
    assert.equal((await request(origin, `/api/devices?userId=${accountB.user.id}`, { headers: { Authorization: `Bearer ${accountA.accessToken}` } })).status, 403)
    assert.equal((await request(origin, `/api/devices/${deviceB.data.id}/web-client`, json({}, accountA.accessToken))).status, 404)

    employeeWs = new WebSocket(`ws://127.0.0.1:${port}/agent`)
    await new Promise((resolve, reject) => { employeeWs.once('open', resolve); employeeWs.once('error', reject) })
    const agentRequests = []
    let createdThreadCount = 0
    employeeWs.on('message', async raw => {
      const message = JSON.parse(String(raw))
      if (message.type !== 'request') return
      agentRequests.push(message)
      let result = { ok: true }
      if (message.path === '/api/employee-assets/prepare') {
        result = await prepareEmployeeAssets(message.data, join(dir, 'device-b-codex'))
      } else if (message.path === '/api/threads' && message.method === 'POST') {
        createdThreadCount += 1
        result = { thread: { id: `employee-thread-${createdThreadCount}`, cwd: message.data.cwd, name: 'Regression Worker' } }
      } else if (message.path.endsWith('/send')) result = { turn: { id: `employee-turn-${agentRequests.length}`, status: 'inProgress' } }
      employeeWs.send(JSON.stringify({ type: 'response', id: message.id, result }))
    })
    employeeWs.send(JSON.stringify({ type: 'auth', token: deviceB.data.token }))
    await new Promise((resolve, reject) => { employeeWs.once('message', raw => { try { assert.equal(JSON.parse(String(raw)).type, 'ready'); resolve() } catch (error) { reject(error) } }) })

    const userBClient = await request(origin, `/api/devices/${deviceB.data.id}/web-client`, json({}, accountB.accessToken))
    assert.equal(userBClient.status, 201)
    const employeeToken = userBClient.data.accessToken
    const createdEmployee = await request(origin, '/api/employees', json({ name: 'Regression Worker', role: 'Runs tests', instructions: 'Always run the focused test suite first.', projectPath: 'D:/WorkSpace/rmdex' }, employeeToken))
    assert.equal(createdEmployee.status, 201, JSON.stringify(createdEmployee.data))
    const employee = createdEmployee.data.employee
    assert.equal((await request(origin, '/api/employees', { headers: { Authorization: `Bearer ${accountA.accessToken}` } })).status, 401)
    assert.equal((await request(origin, '/api/employees', { headers: { Authorization: `Bearer ${employeeToken}` } })).data.data[0].id, employee.id)

    const ensured = await request(origin, `/api/employees/${employee.id}/ensure-thread`, json({}, employeeToken))
    assert.equal(ensured.status, 200)
    const firstSend = await request(origin, `/api/threads/${ensured.data.thread.id}/send`, json({ text: 'Run the tests', employeeId: employee.id, name: 'Regression Worker', permissionMode: 'ask' }, employeeToken))
    assert.equal(firstSend.status, 200)
    const firstForward = agentRequests.find(item => item.path.endsWith('/send'))
    assert.match(firstForward.data.text, /<rmdex_employee_context>/)
    assert.match(firstForward.data.text, /rmdex-employee/)
    const assetRequest = agentRequests.find(item => item.path === '/api/employee-assets/prepare')
    assert.equal(assetRequest.data.userId, accountB.user.id)
    assert.equal(assetRequest.data.employeeId, employee.id)
    assert.equal(assetRequest.data.communication.origin, origin)
    assert.equal(typeof assetRequest.data.communication.token, 'string')
    const assetPath = join(dir, 'device-b-codex', 'rmdex', 'employees', accountB.user.id, employee.id)
    assert.match(await readFile(join(dir, 'device-b-codex', 'skills', 'rmdex-employee', 'SKILL.md'), 'utf8'), /name: rmdex-employee/)
    await writeFile(join(assetPath, 'memories', '2026-01-01-test.md'), 'Employee-owned memory')
    const secondSend = await request(origin, `/api/threads/${ensured.data.thread.id}/send`, json({ text: 'Continue', employeeId: employee.id, name: 'Regression Worker', permissionMode: 'ask' }, employeeToken))
    assert.equal(secondSend.status, 200)
    const sends = agentRequests.filter(item => item.path.endsWith('/send'))
    assert.doesNotMatch(sends[1].data.text, /<rmdex_employee_context>/)
    const edited = await request(origin, `/api/employees/${employee.id}/update`, json({ name: 'Senior Tester', role: 'Senior reviewer' }, employeeToken))
    assert.equal(edited.status, 200)
    assert.equal((await request(origin, `/api/threads/${ensured.data.thread.id}/send`, json({ text: 'Continue as updated', employeeId: employee.id }, employeeToken))).status, 200)
    assert.match(agentRequests.filter(item => item.path.endsWith('/send')).at(-1).data.text, /Senior reviewer/)
    const reset = await request(origin, `/api/employees/${employee.id}/reset-thread`, json({}, employeeToken))
    assert.equal(reset.status, 200)
    assert.equal(reset.data.thread.id, 'employee-thread-2')
    assert.equal((await request(origin, `/api/threads/${reset.data.thread.id}/send`, json({ text: 'Resume', employeeId: employee.id }, employeeToken))).status, 200)
    assert.equal(agentRequests.filter(item => item.path === '/api/employee-assets/prepare').length, 4)
    assert.equal(await readFile(join(assetPath, 'memories', '2026-01-01-test.md'), 'utf8'), 'Employee-owned memory')
    assert.equal((await request(origin, '/api/threads/other-thread/send', json({ text: 'Wrong thread', employeeId: employee.id }, employeeToken))).status, 403)
    const secondEmployee = await request(origin, '/api/employees', json({ name: 'Image reviewer', projectPath: 'D:/WorkSpace/rmdex' }, employeeToken))
    const secondThread = await request(origin, `/api/employees/${secondEmployee.data.employee.id}/ensure-thread`, json({}, employeeToken))
    const attachmentOnly = await request(origin, `/api/threads/${secondThread.data.thread.id}/send`, json({ attachments: ['image'], employeeId: secondEmployee.data.employee.id }, employeeToken))
    assert.equal(attachmentOnly.status, 200)
    assert.match(agentRequests.filter(item => item.path.endsWith('/send')).at(-1).data.text, /rmdex-employee/)

    const pair = await request(origin, `/api/devices/${deviceB.data.id}/pair`, json({}, accountB.accessToken))
    assert.equal(pair.status, 200)
    const claim = await request(origin, '/api/pair/claim', json({ code: pair.data.code, name: 'User B phone' }))
    assert.equal(claim.status, 202)
    assert.deepEqual((await request(origin, '/api/pair-requests', { headers: { Authorization: `Bearer ${accountA.accessToken}` } })).data.data, [])
    assert.deepEqual((await request(origin, '/api/pair-requests', { headers: { Authorization: `Bearer ${accountB.accessToken}` } })).data.data.map(item => item.id), [claim.data.requestId])
    assert.equal((await request(origin, `/api/pair-requests/${claim.data.requestId}`, json({ decision: 'approve' }, accountA.accessToken))).status, 404)
    assert.equal((await request(origin, `/api/pair-requests/${claim.data.requestId}`, json({ decision: 'approve' }, accountB.accessToken))).status, 200)
  } finally {
    employeeWs?.terminate()
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
