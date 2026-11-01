import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { proxyRelayRequest, relayHttpOrigin } from './relay-proxy.ts'

test('PC relay proxy forwards client auth, JSON bodies, and binary responses', async t => {
  let receivedAuthorization = ''
  let receivedBody = ''
  const imageBytes = Buffer.from([0, 159, 255, 13, 10, 65, 0])
  const relay = createServer(async (req, res) => {
    receivedAuthorization = String(req.headers.authorization || '')
    if (req.url === '/api/employees') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'employee-1', name: 'Tester' }] }))
      return
    }
    if (req.url === '/api/employees/employee-1/update') {
      for await (const chunk of req) receivedBody += String(chunk)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ updated: JSON.parse(receivedBody) }))
      return
    }
    if (req.url === '/api/images/image-1') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(imageBytes)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  const relayOrigin = `http://127.0.0.1:${relay.address().port}`
  const pc = createServer((req, res) => void proxyRelayRequest(req, res, relayOrigin))
  await new Promise(resolve => pc.listen(0, '127.0.0.1', resolve))
  const pcOrigin = `http://127.0.0.1:${pc.address().port}`
  t.after(async () => {
    await Promise.all([new Promise(resolve => pc.close(resolve)), new Promise(resolve => relay.close(resolve))])
  })

  const employees = await fetch(`${pcOrigin}/api/employees`, { headers: { Authorization: 'Bearer client-token' } })
  assert.equal(employees.status, 200)
  assert.deepEqual(await employees.json(), { data: [{ id: 'employee-1', name: 'Tester' }] })
  assert.equal(receivedAuthorization, 'Bearer client-token')

  const updated = await fetch(`${pcOrigin}/api/employees/employee-1/update`, { method: 'POST', headers: { Authorization: 'Bearer client-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reviewer' }) })
  assert.equal(updated.status, 200)
  assert.deepEqual(await updated.json(), { updated: { role: 'reviewer' } })
  assert.equal(receivedBody, '{"role":"reviewer"}')

  const image = await fetch(`${pcOrigin}/api/images/image-1`, { headers: { Authorization: 'Bearer client-token' } })
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), imageBytes)
  assert.equal(relayHttpOrigin('wss://code.kyeai.xyz/agent'), 'https://code.kyeai.xyz')
})
