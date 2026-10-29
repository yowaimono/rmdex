import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

function rpc(child, method, params = {}, id = 1) {
  return new Promise((resolve, reject) => {
    const onData = chunk => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id !== id) continue
        child.stdout.off('data', onData)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    }
    child.stdout.on('data', onData)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

test('control MCP exposes permission-aware calls over stdio', { timeout: 15000 }, async () => {
  const calls = []
  const agent = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url })
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/models') res.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }))
    else if (req.url === '/api/threads') res.end(JSON.stringify({ data: [{ id: 'thread-1' }] }))
    else if (req.url === '/api/threads/thread-1/send') res.end(JSON.stringify({ outcome: 'queued', threadId: 'thread-1' }))
    else res.end(JSON.stringify({ thread: { id: 'thread-1', turns: [] }, approvals: [] }))
  })
  const port = await listen(agent)
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/control-mcp.ts'], {
    cwd: process.cwd(), env: { ...process.env, RMDEX_MCP_AGENT_URL: `http://127.0.0.1:${port}` },
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  })
  const exited = new Promise(resolve => child.once('exit', resolve))
  try {
    const initialized = await rpc(child, 'initialize', {}, 1)
    assert.equal(initialized.serverInfo.name, 'rmdex-control-mcp')
    const listed = await rpc(child, 'tools/list', {}, 2)
    assert.ok(listed.tools.some(tool => tool.name === 'codex_send_message'))
    const capabilities = await rpc(child, 'tools/call', { name: 'codex_capabilities', arguments: {} }, 3)
    assert.equal(capabilities.isError, false)
    assert.equal(capabilities.structuredContent.permissions.ask.approvalPolicy, 'on-request')
    const sent = await rpc(child, 'tools/call', { name: 'codex_send_message', arguments: {
      threadId: 'thread-1', operationId: '123e4567-e89b-12d3-a456-426614174000', text: 'hello', permissionMode: 'ask',
    } }, 4)
    assert.equal(sent.isError, false)
    assert.equal(calls.at(-1).url, '/api/threads/thread-1/send')
  } finally {
    child.kill()
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))])
    await new Promise(resolve => agent.close(resolve))
  }
})
