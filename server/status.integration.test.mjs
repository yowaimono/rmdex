import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

if (process.argv.includes('--mock-app-server')) {
  createInterface({ input: process.stdin }).on('line', async line => {
    const request = JSON.parse(line)
    if (request.id === undefined) return
    const response = await fetch(process.env.RMDEX_STATUS_TEST_RPC, { method: 'POST', body: line })
    const { result, error, events = [] } = await response.json()
    for (const event of events) console.log(JSON.stringify(event))
    console.log(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }))
  })
} else {
  const turn = (id, status) => ({ id, status, items: [{ id: `${id}-answer`, type: 'agentMessage', text: 'persisted answer' }] })
  const event = (method, threadId, value) => ({ method, params: { threadId, turn: value } })

  async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return server.address().port
  }

  async function fixture(t) {
    const home = await mkdtemp(join(tmpdir(), 'rmdex-status-test-'))
    const calls = []
    const state = { turns: [], events: [], fail: false, latency: 0 }
    const mock = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const request = JSON.parse(raw)
      calls.push(request)
      let result = {}, error, events = []
      if (request.method === 'thread/turns/list') {
        result = { data: structuredClone(state.turns), nextCursor: null }
        events = state.events.splice(0)
        if (state.fail) error = { message: 'history temporarily unavailable' }
        await delay(state.latency)
      } else if (request.method === 'turn/start') result = { turn: turn('running-turn', 'inProgress') }
      else if (!['initialize', 'thread/resume'].includes(request.method)) error = { message: `Unexpected RPC: ${request.method}` }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ result, error, events }))
    })
    const rpcPort = await listen(mock)
    const probe = createServer()
    const agentPort = await listen(probe)
    await new Promise(resolve => probe.close(resolve))
    // Replace only the test executable. The real HTTP agent runs unchanged;
    // no installed Codex process, credentials, sockets or relay are used.
    const preloader = `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; const original = cp.spawn; cp.spawn = (file, args, options) => file === 'rmdex-status-test-codex' ? original(process.execPath, [${JSON.stringify(fileURLToPath(import.meta.url))}, '--mock-app-server'], options) : original(file, args, options); syncBuiltinESMExports();`
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', `data:text/javascript,${encodeURIComponent(preloader)}`, 'server/index.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, CODEX_HOME: home, RMDEX_CODEX: 'rmdex-status-test-codex', RMDEX_CODEX_MODE: 'standalone', RMDEX_AGENT_PORT: String(agentPort), RMDEX_STATUS_TEST_RPC: `http://127.0.0.1:${rpcPort}`, RMDEX_RELAY_URL: '', RMDEX_DEVICE_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    t.after(async () => {
      const exited = once(child, 'exit')
      if (child.exitCode === null) { child.kill(); await exited }
      mock.closeAllConnections()
      await new Promise(resolve => mock.close(resolve))
      await rm(home, { recursive: true, force: true })
    })
    const base = `http://127.0.0.1:${agentPort}`
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(`${base}/api/health`)).ok) break } catch {}
      if (attempt >= 100 || child.exitCode !== null) throw new Error(`Agent did not start: ${output}`)
      await delay(30)
    }
    const status = async (id = 'thread') => {
      const response = await fetch(`${base}/api/threads/${id}/status`)
      return { code: response.status, ...(await response.json()) }
    }
    const send = async () => {
      const response = await fetch(`${base}/api/threads/thread/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }, body: JSON.stringify({ text: 'work' }) })
      assert.equal(response.status, 200, JSON.stringify(await response.json()))
    }
    return { state, calls, status, send, listCalls: () => calls.filter(call => call.method === 'thread/turns/list') }
  }

  test('status-only polling reconciles a missed completion, coalesces reads and expires its cache', { timeout: 15000 }, async t => {
    const f = await fixture(t)
    await f.send()
    f.state.turns = [turn('running-turn', 'inProgress')]
    f.state.latency = 75
    const results = await Promise.all(Array.from({ length: 6 }, () => f.status()))
    assert.ok(results.every(result => result.activeTurnId === 'running-turn'))
    assert.equal(f.listCalls().length, 1)
    assert.deepEqual(f.listCalls()[0].params, { threadId: 'thread', limit: 1, sortDirection: 'desc', itemsView: 'full' })
    f.state.turns = [turn('running-turn', 'completed')]
    assert.equal((await f.status()).lastTurn.status, 'inProgress')
    await delay(2100)
    const completed = await f.status()
    assert.equal(completed.code, 200)
    assert.equal(completed.activeTurnId, null)
    assert.deepEqual(completed.lastTurn, { id: 'running-turn', status: 'completed' })
    assert.equal(completed.live.status, 'completed')
    assert.equal(completed.live.items[0].text, 'persisted answer')
    assert.equal(f.listCalls().length, 2)
    assert.equal(f.calls.some(call => call.method === 'thread/read'), false)
  })

  test('status discovers persisted completion without any previous live turn', async t => {
    const f = await fixture(t)
    f.state.turns = [turn('already-done', 'failed')]
    f.state.turns[0].error = { message: 'model failed' }
    const result = await f.status()
    assert.equal(result.activeTurnId, null)
    assert.deepEqual(result.lastTurn, { id: 'already-done', status: 'failed', error: { message: 'model failed' } })
    assert.deepEqual(f.calls.map(call => call.method), ['initialize', 'thread/turns/list'])
  })

  for (const status of ['inProgress', 'completed']) test(`${status} status merges a delta received during the snapshot read with the correct precedence`, async t => {
    const f = await fixture(t)
    await f.send()
    const snapshot = turn('running-turn', status)
    snapshot.items.push({ id: 'persisted-only', type: 'agentMessage', text: 'from history' })
    f.state.turns = [snapshot]
    // These item events are delivered after the snapshot was captured and
    // before its RPC reply, without invalidating the status refresh.
    f.state.events = [
      { method: 'item/started', params: { threadId: 'thread', turnId: 'running-turn', item: { id: 'running-turn-answer', type: 'agentMessage', text: 'streamed text' } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'running-turn', itemId: 'running-turn-answer', delta: ' plus newer delta' } },
      { method: 'item/started', params: { threadId: 'thread', turnId: 'running-turn', item: { id: 'live-only', type: 'agentMessage', text: 'from events' } } },
    ]
    const result = await f.status()
    assert.equal(result.code, 200)
    assert.equal(result.live.status, status)
    const items = new Map(result.live.items.map(item => [item.id, item.text]))
    assert.equal(items.get('running-turn-answer'), status === 'inProgress' ? 'streamed text plus newer delta' : 'persisted answer')
    assert.equal(items.get('persisted-only'), 'from history')
    assert.equal(items.get('live-only'), 'from events')
    assert.equal(f.listCalls().length, 1)
  })

  test('a completion event without a prior live turn survives an older history read', async t => {
    const f = await fixture(t)
    f.state.events = [event('turn/completed', 'thread', turn('event-only', 'completed'))]
    const result = await f.status()
    assert.equal(result.activeTurnId, null)
    assert.equal(result.lastTurn.id, 'event-only')
    assert.equal(result.lastTurn.status, 'completed')
  })

  test('a late old completion preserves the newer active turn and its approval', async t => {
    const f = await fixture(t)
    f.state.turns = [turn('old-turn', 'completed')]
    f.state.events = [
      event('turn/started', 'thread', turn('new-turn', 'inProgress')),
      { id: 'new-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'new-turn' } },
      event('turn/completed', 'thread', turn('old-turn', 'completed')),
    ]
    const result = await f.status()
    assert.equal(result.activeTurnId, 'new-turn')
    assert.equal(result.lastTurn.id, 'new-turn')
    assert.equal(result.lastTurn.status, 'inProgress')
    assert.equal(result.approvals[0].id, 'new-approval')
    // The event invalidated the cached read, so this request reconciles again.
    f.state.turns = [turn('new-turn', 'inProgress')]
    assert.equal((await f.status()).activeTurnId, 'new-turn')
    assert.equal(f.listCalls().length, 2)
  })

  test('completion is recorded when its start event was missed and an older live turn remains', async t => {
    const f = await fixture(t)
    await f.send()
    f.state.events = [event('turn/completed', 'thread', turn('running-turn', 'completed'))]
    await f.status()
    f.state.events = [event('turn/completed', 'thread', turn('next-turn', 'completed'))]
    const result = await f.status()
    assert.equal(result.activeTurnId, null)
    assert.equal(result.lastTurn.id, 'next-turn')
    assert.equal(result.lastTurn.status, 'completed')
  })

  test('empty authoritative history removes stale active and live state', async t => {
    const f = await fixture(t)
    await f.send()
    const result = await f.status()
    assert.equal(result.activeTurnId, null)
    assert.equal(result.lastTurn, null)
    assert.equal(result.live, null)
  })

  test('persisted completion clears stale approvals even when the completion event is lost', async t => {
    const f = await fixture(t)
    f.state.events = [
      event('turn/started', 'thread', turn('running-turn', 'inProgress')),
      { id: 'old-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'running-turn' } },
    ]
    assert.equal((await f.status()).approvals.length, 1)
    f.state.turns = [turn('running-turn', 'completed')]
    const result = await f.status()
    assert.equal(result.activeTurnId, null)
    assert.equal(result.lastTurn.status, 'completed')
    assert.deepEqual(result.approvals, [])
  })

  test('history errors are surfaced and retried rather than cached as success', async t => {
    const f = await fixture(t)
    await f.send()
    f.state.fail = true
    const failed = await f.status()
    assert.equal(failed.code, 502)
    assert.match(failed.error, /history temporarily unavailable/)
    f.state.fail = false
    f.state.turns = [turn('running-turn', 'interrupted')]
    const recovered = await f.status()
    assert.equal(recovered.code, 200)
    assert.equal(recovered.activeTurnId, null)
    assert.equal(recovered.lastTurn.status, 'interrupted')
    assert.equal(f.listCalls().length, 2)
  })
}
