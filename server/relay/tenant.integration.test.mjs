import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function freePort() {
  const { createServer } = await import('node:net')
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = address.port
  await new Promise(resolve => probe.close(resolve))
  return port
}

async function waitForHealth(origin, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch { /* relay is still starting */ }
    await delay(100)
  }
  throw new Error(`Relay did not start: ${stderr()}; exit=${child.exitCode}`)
}

function json(body, token) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }
}

async function request(origin, path, options = {}) {
  const response = await fetch(origin + path, options)
  const raw = await response.text()
  return { status: response.status, data: raw ? JSON.parse(raw) : null }
}

test('relay migrates legacy state and enforces tenant boundaries for admin workflows', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rmdex-tenant-integration-'))
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const password = 'legacy-admin-password'
  const legacyPairCode = 'L'.repeat(32)
  const statePath = join(dir, 'state.json')
  await writeFile(statePath, JSON.stringify({
    devices: [{ id: 'legacy-pc', name: 'Migrated PC', tokenHash: sha256('legacy-device-token'), createdAt: 1 }],
    clients: [],
    pairings: [{ codeHash: sha256(legacyPairCode), deviceId: 'legacy-pc', expiresAt: Date.now() + 60_000 }],
    pairRequests: [{ id: 'legacy-request', deviceId: 'legacy-pc', name: 'Legacy phone', createdAt: 1, expiresAt: Date.now() + 60_000, status: 'pending' }],
    users: [{ id: 'existing-admin', username: 'admin', passwordHash: `sha256:${sha256(password)}`, role: 'admin', createdAt: 1 }],
    sessions: [],
    pushTokens: [],
    notifications: [],
  }))

  const child = spawn(process.execPath, ['--import', 'tsx', 'server/relay/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, RMDEX_STATE: statePath, RMDEX_ADMIN_HASH: sha256(password) },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += String(data) })

  try {
    await waitForHealth(origin, child, () => stderr)
    const saved = JSON.parse(await readFile(statePath, 'utf8'))
    assert.deepEqual(saved.tenants.map(item => item.id), ['legacy-default'])
    assert.equal(saved.devices.find(item => item.id === 'legacy-pc').tenantId, 'legacy-default')
    assert.equal(saved.pairings[0].tenantId, 'legacy-default')
    assert.equal(saved.pairRequests[0].tenantId, 'legacy-default')
    assert.equal(saved.users.find(item => item.id === 'existing-admin').tenantId, undefined)

    const login = async (username, passwordValue) => {
      const result = await request(origin, '/api/auth/login', json({ username, password: passwordValue }))
      assert.equal(result.status, 200, JSON.stringify(result.data))
      return result.data
    }
    const platform = await login('admin', password)
    assert.equal(platform.user.role, 'admin')
    assert.equal(platform.user.tenantId, null)

    const tenantA = await request(origin, '/api/tenants', json({ name: 'Tenant A', username: 'tenant-a', password: 'tenant-a-password' }, platform.accessToken))
    const tenantB = await request(origin, '/api/tenants', json({ name: 'Tenant B', username: 'tenant-b', password: 'tenant-b-password' }, platform.accessToken))
    assert.equal(tenantA.status, 201, JSON.stringify(tenantA.data))
    assert.equal(tenantB.status, 201, JSON.stringify(tenantB.data))

    const tenantAId = tenantA.data.tenant.id
    const tenantBId = tenantB.data.tenant.id
    const accountA = await login('tenant-a', 'tenant-a-password')
    const accountB = await login('tenant-b', 'tenant-b-password')
    assert.equal(accountA.user.tenantId, tenantAId)
    assert.equal(accountB.user.tenantId, tenantBId)

    const deviceA = await request(origin, '/api/devices', json({ name: 'Tenant A PC', tenantId: tenantBId }, accountA.accessToken))
    const deviceB = await request(origin, '/api/devices', json({ name: 'Tenant B PC' }, accountB.accessToken))
    assert.equal(deviceA.status, 201, JSON.stringify(deviceA.data))
    assert.equal(deviceB.status, 201, JSON.stringify(deviceB.data))
    assert.equal(deviceA.data.tenantId, tenantAId)
    assert.equal(deviceB.data.tenantId, tenantBId)

    const platformDevices = await request(origin, `/api/devices?tenantId=${tenantAId}`, { headers: { Authorization: `Bearer ${platform.accessToken}` } })
    assert.deepEqual(platformDevices.data.data.map(item => item.id), [deviceA.data.id])
    const tenantDevices = await request(origin, `/api/devices?tenantId=${tenantBId}`, { headers: { Authorization: `Bearer ${accountA.accessToken}` } })
    assert.deepEqual(tenantDevices.data.data.map(item => item.id), [deviceA.data.id])
    assert.equal((await request(origin, '/api/devices', { headers: { Authorization: `Bearer ${platform.accessToken}` } })).status, 403)

    assert.equal((await request(origin, `/api/devices/${deviceB.data.id}/web-client`, json({}, accountA.accessToken))).status, 404)
    assert.equal((await request(origin, `/api/devices/${deviceB.data.id}/pair`, json({}, accountA.accessToken))).status, 404)
    assert.equal((await request(origin, `/api/devices/${deviceB.data.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accountA.accessToken}` } })).status, 404)
    assert.equal((await request(origin, '/api/tenants', json({ name: 'Illegal', username: 'illegal-user', password: 'illegal-password' }, accountA.accessToken))).status, 403)

    const pair = await request(origin, `/api/devices/${deviceB.data.id}/pair`, json({}, accountB.accessToken))
    assert.equal(pair.status, 200)
    const claim = await request(origin, '/api/pair/claim', json({ code: pair.data.code, name: 'Tenant B phone' }))
    assert.equal(claim.status, 202)
    const hiddenRequests = await request(origin, '/api/pair-requests', { headers: { Authorization: `Bearer ${accountA.accessToken}` } })
    const visibleRequests = await request(origin, '/api/pair-requests', { headers: { Authorization: `Bearer ${accountB.accessToken}` } })
    assert.deepEqual(hiddenRequests.data.data, [])
    assert.deepEqual(visibleRequests.data.data.map(item => item.id), [claim.data.requestId])
    assert.equal((await request(origin, `/api/pair-requests/${claim.data.requestId}`, json({ decision: 'approve' }, accountA.accessToken))).status, 404)
    assert.equal((await request(origin, `/api/pair-requests/${claim.data.requestId}`, json({ decision: 'approve' }, accountB.accessToken))).status, 200)

    assert.equal((await request(origin, `/api/devices/${deviceB.data.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accountA.accessToken}` } })).status, 404)
    assert.equal((await request(origin, `/api/devices/${deviceB.data.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${accountB.accessToken}` } })).status, 200)
    const afterRevoke = await request(origin, `/api/devices?tenantId=${tenantBId}`, { headers: { Authorization: `Bearer ${platform.accessToken}` } })
    assert.deepEqual(afterRevoke.data.data, [])
  } finally {
    child.kill()
    await new Promise(resolve => child.once('exit', resolve))
    await rm(dir, { recursive: true, force: true })
  }
})
