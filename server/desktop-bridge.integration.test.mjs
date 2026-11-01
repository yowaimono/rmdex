import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'
import { createDesktopBridge } from './desktop-bridge.ts'

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return server.address().port
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function nextMessage(socket, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for WebSocket message')) }, timeout)
    const onMessage = raw => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (!predicate(message)) return
      cleanup()
      resolve(message)
    }
    const onClose = () => { cleanup(); reject(new Error('WebSocket closed before expected message')) }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
}

test('Desktop user-input request is mirrored and its answer returns to the original RPC client', { timeout: 15000 }, async t => {
  const server = createServer()
  const upstreamWss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => upstreamWss.handleUpgrade(request, socket, head, client => upstreamWss.emit('connection', client, request)))
  const upstreamPort = await listen(server)
  const appClients = new Set()
  const proxyChildren = new Set()
  upstreamWss.on('connection', client => {
    appClients.add(client)
    client.on('close', () => appClients.delete(client))
    client.on('message', raw => {
      const message = JSON.parse(raw.toString())
      if (message.method === 'initialize') client.send(JSON.stringify({ id: message.id, result: { serverInfo: { name: 'rmdex-test', version: '1' } } }))
    })
  })

  let bridge
  let desktop
  let mirror
  t.after(async () => {
    desktop?.terminate()
    mirror?.terminate()
    bridge?.close()
    for (const child of proxyChildren) {
      if (child.exitCode === null) child.kill()
    }
    for (const client of appClients) client.terminate()
    upstreamWss.close()
    await new Promise(resolve => server.close(resolve))
  })

  bridge = await createDesktopBridge('mock-socket', 'mock-codex', {
    mirrorPort: 0,
    mirrorToken: 'integration-test-token',
    log: () => {},
    spawnProxy: () => {
      const forwarder = `const net=require('node:net');const socket=net.connect(${upstreamPort},'127.0.0.1');process.stdin.pipe(socket);socket.pipe(process.stdout);socket.on('error',()=>process.exit(1))`
      const child = spawn(process.execPath, ['-e', forwarder], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      proxyChildren.add(child)
      child.once('exit', () => proxyChildren.delete(child))
      return child
    },
  })
  assert.ok(bridge.mirrorUrl)
  mirror = await connect(bridge.mirrorUrl)
  desktop = await connect(bridge.url)
  const appServer = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const poll = async () => {
      if (appClients.size) return resolve([...appClients][0])
      if (Date.now() >= deadline) return reject(new Error('Mock app-server proxy did not connect'))
      await delay(10)
      void poll()
    }
    void poll()
  })

  const initialization = nextMessage(desktop, message => message.id === 1)
  desktop.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'rmdex-test', version: '1' } } }))
  assert.equal((await initialization).result.serverInfo.name, 'rmdex-test')

  const request = {
    id: 77,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'desktop-thread-test',
      turnId: 'turn-test',
      itemId: 'item-test',
      questions: [{ id: 'choice', header: 'Choice', question: 'Continue?', options: [{ label: 'Yes', description: 'Continue the task' }] }],
      isBlocking: true,
    },
  }
  const mirrored = nextMessage(mirror, message => message.type === 'request')
  const transparent = nextMessage(desktop, message => message.method === request.method)
  appServer.send(JSON.stringify(request))
  const [mirrorEvent, desktopEvent] = await Promise.all([mirrored, transparent])
  assert.equal(mirrorEvent.requestId, '77')
  assert.deepEqual(mirrorEvent.request, request)
  assert.deepEqual(desktopEvent, request)

  const appServerAnswer = nextMessage(appServer, message => message.id === 77 && !message.method)
  const responseAck = nextMessage(mirror, message => message.type === 'responseForwarded')
  mirror.send(JSON.stringify({
    type: 'response',
    clientId: mirrorEvent.clientId,
    requestId: mirrorEvent.requestId,
    result: { answers: { choice: { answers: ['Yes'] } } },
  }))
  const [answer, ack] = await Promise.all([appServerAnswer, responseAck])
  assert.deepEqual(answer.result, { answers: { choice: { answers: ['Yes'] } } })
  assert.equal(ack.clientId, mirrorEvent.clientId)
  assert.equal(ack.requestId, '77')

  const resolved = nextMessage(mirror, message => message.type === 'resolved')
  appServer.send(JSON.stringify({ method: 'serverRequest/resolved', params: { requestId: 77 } }))
  assert.deepEqual(await resolved, { type: 'resolved', clientId: mirrorEvent.clientId, requestId: '77' })
})
