// Run against an emulator with the isolated notificationTest APK installed.
// No production accounts, user sessions or existing app data are used.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const exec = promisify(execFile)
const adbPath = process.env.ANDROID_ADB || 'adb'
const serial = process.argv[2]
if (!serial || !/^(emulator-\d+|127\.0\.0\.1:\d+)$/.test(serial)) throw new Error('Pass an explicit emulator serial; physical devices are excluded')
const app = 'xyz.kyeai.rmdex.notificationtest'
const root = fileURLToPath(new URL('../', import.meta.url))
const adb = async (...args) => (await exec(adbPath, ['-s', serial, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout.trim()
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value } catch (error) { last = error }
    await delay(200)
  }
  throw last || new Error('Timed out waiting for Android notification')
}
const probe = createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const origin = `http://127.0.0.1:${port}`
const hash = text => createHash('sha256').update(text).digest('hex')
const directory = await mkdtemp(join(tmpdir(), 'rmdex-android-notification-'))
const statePath = join(directory, 'state.json')
await writeFile(statePath, JSON.stringify({
  users: [{ id: 'test-user', username: 'test', role: 'admin', passwordHash: 'unused', createdAt: 1 }],
  devices: [{ id: 'test-pc', userId: 'test-user', name: 'Isolated PC', tokenHash: hash('test-device-token'), createdAt: 1 }],
  clients: [{ deviceId: 'test-pc', tokenHash: hash('test-client-token'), name: 'Isolated Android', createdAt: 1 }],
  pushTokens: [{ deviceId: 'test-pc', tokenHash: hash('test-push-token'), installationId: 'test-installation-android', platform: 'android', createdAt: 1, lastSeenAt: 1 }],
}))
let child, agent, cdp, forwardPort, sequence = 0
const pending = new Map()
let turnId = '', completed = false, statusReads = 0, persistedReads = 0
const runId = Date.now().toString(36)
const evaluate = expression => new Promise((resolve, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('WebView evaluation timed out')) }, 15000)
  pending.set(id, message => {
    clearTimeout(timer)
    if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)))
    else resolve(message.result.result.value)
  })
  cdp.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
})
const call = async (path, data) => {
  const response = await fetch(origin + path, { method: 'POST', headers: { Authorization: 'Bearer test-client-token', 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  assert.equal(response.status, 200, await response.text())
}
try {
  child = spawn(process.execPath, ['--import', 'tsx', 'server/relay/index.ts'], { cwd: root, env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, RMDEX_STATE: statePath }, stdio: 'ignore', windowsHide: true })
  await until(async () => (await fetch(origin + '/api/health')).ok)
  agent = new WebSocket(`ws://127.0.0.1:${port}/agent`)
  await new Promise((resolve, reject) => { agent.once('open', resolve); agent.once('error', reject) })
  const ready = new Promise(resolve => agent.once('message', resolve))
  agent.send(JSON.stringify({ type: 'auth', token: 'test-device-token' }))
  await ready
  agent.on('message', raw => {
    const message = JSON.parse(raw.toString())
    if (message.type !== 'request') return
    let result
    if (message.path.endsWith('/send')) result = { turn: { id: turnId, status: 'inProgress' } }
    else if (message.path.endsWith('/status')) {
      statusReads++
      result = { activeTurnId: turnId, lastTurn: { id: turnId, status: 'inProgress' } }
    } else if (message.path.endsWith('/incremental')) {
      persistedReads++
      result = { thread: { turns: [{ id: turnId, status: completed ? 'completed' : 'inProgress' }] }, activeTurnId: turnId }
    } else throw new Error(`Unexpected PC request: ${message.path}`)
    agent.send(JSON.stringify({ type: 'response', id: message.id, result }))
  })
  await adb('reverse', `tcp:${port}`, `tcp:${port}`)
  await adb('shell', 'pm', 'grant', app, 'android.permission.POST_NOTIFICATIONS')
  await adb('shell', 'am', 'start', '-n', `${app}/xyz.kyeai.rmdex.MainActivity`)
  const pid = await until(() => adb('shell', 'pidof', app))
  forwardPort = await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`)
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${forwardPort}/json`)).json()).find(item => item.type === 'page'))
  cdp = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject) })
  cdp.on('message', raw => { const message = JSON.parse(String(raw)); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message) } })
  await until(() => evaluate('Boolean(window.Capacitor?.Plugins?.RmdexBackgroundService)'))
  await evaluate(`window.Capacitor.Plugins.RmdexBackgroundService.start(${JSON.stringify({ relayUrl: `http://localhost:${port}`, pushToken: 'test-push-token', cursor: 0 })}).then(() => true)`)
  await until(async () => (await adb('shell', 'dumpsys', 'activity', 'services', app)).includes('isForeground=true'))
  for (const [index, locked] of [[1, false], [2, true]]) {
    turnId = `background-turn-${runId}-${index}`
    const title = `Android E2E ${runId} ${index}`
    completed = false
    await call('/api/threads/background-thread/send', { text: 'Isolated background notification check', name: title })
    await adb('shell', 'am', 'start', '-a', 'android.settings.SETTINGS')
    await until(async () => /(?:mResumedActivity|topResumedActivity).*com.android.settings/.test(await adb('shell', 'dumpsys', 'activity', 'activities')))
    if (locked) await adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
    const started = Date.now()
    completed = true
    const notification = await until(async () => {
      const keys = (await adb('shell', 'cmd', 'notification', 'list')).split(/\r?\n/).filter(line => line.includes(`|${app}|`) && !line.includes('|18787|'))
      for (const key of keys) {
        const record = await adb('shell', `cmd notification get '${key.trim().replaceAll("'", "'\\''")}'`)
        if (record.includes(title)) return record
      }
      return null
    })
    assert.match(notification, /rmdex-task-alerts-v2/)
    assert.match(notification, /importance=4|mImportance=4/)
    if (!locked) {
      await delay(600)
      await adb('shell', 'screencap', '-p', '/sdcard/rmdex-notificationtest.png')
      await adb('pull', '/sdcard/rmdex-notificationtest.png', join(root, 'work', 'android-notification-0.3.2.png'))
    }
    console.log(JSON.stringify({ scenario: locked ? 'screen-off' : 'other-app', turnId, deliveryMs: Date.now() - started, notificationPostedBeforeAppResume: true }))
    if (locked) { await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'); await adb('shell', 'wm', 'dismiss-keyguard') }
  }
  assert.ok(statusReads > 0 && persistedReads > 0)
  const events = await (await fetch(origin + '/api/notifications/poll?wait=0&after=0', { headers: { Authorization: 'Bearer test-push-token' } })).json()
  assert.equal(events.data.length, 2)
  assert.equal(new Set(events.data.map(event => event.turnId)).size, 2)
  console.log('Android E2E passed: real Relay, stale PC event cache, native service, other-app and screen-off notifications; no FCM')
} finally {
  cdp?.terminate()
  agent?.terminate()
  await adb('shell', 'am', 'force-stop', app).catch(() => {})
  await adb('reverse', '--remove', `tcp:${port}`).catch(() => {})
  if (forwardPort) await adb('forward', '--remove', `tcp:${forwardPort}`).catch(() => {})
  if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited }
  await rm(directory, { recursive: true, force: true })
}
