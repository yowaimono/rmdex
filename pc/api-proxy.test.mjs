import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { proxyAgentRequest } from './api-proxy.ts'

test('PC API proxy preserves the agent status, JSON body, and binary image bytes', async t => {
  const imageBytes = Buffer.from([0, 159, 255, 13, 10, 65, 0])
  let receivedOrigin = ''
  let receivedBody = ''
  const agent = createServer(async (req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'conflict' }))
      return
    }
    if (req.url === '/api/send') {
      receivedOrigin = String(req.headers.origin)
      for await (const chunk of req) receivedBody += String(chunk)
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ accepted: JSON.parse(receivedBody) }))
      return
    }
    if (req.url === '/api/image') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(imageBytes)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => agent.listen(0, '127.0.0.1', resolve))
  const agentPort = agent.address().port
  const pc = createServer((req, res) => void proxyAgentRequest(req, res, agentPort))
  await new Promise(resolve => pc.listen(0, '127.0.0.1', resolve))
  const pcOrigin = `http://127.0.0.1:${pc.address().port}`
  t.after(async () => {
    await Promise.all([new Promise(resolve => pc.close(resolve)), new Promise(resolve => agent.close(resolve))])
  })

  const conflict = await fetch(`${pcOrigin}/api/status`)
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), { error: 'conflict' })

  const sent = await fetch(`${pcOrigin}/api/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'retry' }) })
  assert.equal(sent.status, 202)
  assert.equal(receivedOrigin, 'http://localhost:5173')
  assert.deepEqual(await sent.json(), { accepted: { text: 'retry' } })

  const image = await fetch(`${pcOrigin}/api/image`)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes)
})
