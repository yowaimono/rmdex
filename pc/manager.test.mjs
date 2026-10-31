import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { isCodexDesktopProcess, PcManager } from './manager.ts'

test('managed Codex daemon processes are not treated as Desktop processes', () => {
  assert.equal(isCodexDesktopProcess('codex.exe app-server --listen unix:// --analytics-default-enabled --managed-daemon'), false)
  assert.equal(isCodexDesktopProcess('codex.exe app-server daemon pid-update-loop'), false)
})

test('Codex Desktop app-server processes are treated as Desktop processes', () => {
  assert.equal(isCodexDesktopProcess('codex.exe app-server proxy --sock C:\\Users\\Chinese\\.codex\\app-server-control\\app-server-control.sock'), true)
  assert.equal(isCodexDesktopProcess('codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled'), true)
  assert.equal(isCodexDesktopProcess('codex.exe -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'), true)
})

test('PC enrollment registers a user-owned device without persisting the account password', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rmdex-pc-enroll-'))
  const previousRelay = process.env.RMDEX_RELAY_URL
  let registrationAuth = ''
  const relay = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += String(chunk)
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/auth/login') {
      assert.deepEqual(JSON.parse(raw), { username: 'user-account', password: 'never-save-this-password' })
      res.end(JSON.stringify({ accessToken: 'login-access' })); return
    }
    if (req.url === '/api/devices') {
      registrationAuth = String(req.headers.authorization)
      assert.deepEqual(JSON.parse(raw), { name: 'Office PC' })
      res.writeHead(201)
      res.end(JSON.stringify({ token: 'device-secret', accessToken: 'client-access', refreshToken: 'client-refresh' })); return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  const address = relay.address()
  assert.ok(address && typeof address !== 'string')
  process.env.RMDEX_RELAY_URL = `ws://127.0.0.1:${address.port}/agent`
  try {
    const manager = new PcManager(root)
    manager.start = async () => ({ enrolled: true })
    const result = await manager.enroll('user-account', 'never-save-this-password', 'Office PC')
    assert.equal(result.enrolled, true)
    assert.equal(registrationAuth, 'Bearer login-access')
    assert.equal(await readFile(join(root, 'work', '.device-token'), 'utf8'), 'device-secret')
    assert.equal(await readFile(join(root, 'work', '.web-client-token'), 'utf8'), 'client-access')
    assert.equal(await readFile(join(root, 'work', '.web-client-refresh-token'), 'utf8'), 'client-refresh')
  } finally {
    relay.close()
    if (previousRelay === undefined) delete process.env.RMDEX_RELAY_URL
    else process.env.RMDEX_RELAY_URL = previousRelay
    await rm(root, { recursive: true, force: true })
  }
})

test('PC status keeps legacy root token enrollment compatible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rmdex-pc-legacy-token-'))
  try {
    await writeFile(join(root, '.device-token'), 'legacy-device-token')
    const manager = new PcManager(root)
    const status = await manager.status()
    assert.equal(status.enrolled, true)
    assert.equal(status.relay.state, 'unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('PC enrollment rejects incomplete credentials before contacting the relay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rmdex-pc-enroll-validation-'))
  try {
    const manager = new PcManager(root)
    await assert.rejects(manager.enroll(' ', '', ' '), /用户账号/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
