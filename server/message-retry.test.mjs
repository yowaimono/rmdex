import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OperationJournal } from './desktop-adapter.ts'
import { MessageRetryService } from './message-retry.ts'
import { commandSummary } from '../src/command-summary.ts'

const user = (id, text) => ({ id, status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] }, { type: 'agentMessage', text: 'Old answer' }] })
async function fixture(t, turns = [user('first', 'hello')]) {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-retry-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const threads = { source: { id: 'source', status: { type: 'idle' }, turns: structuredClone(turns) } }
  const calls = [], backups = [], clears = []
  let failAfterStart = false, queued = []
  const rpc = async (method, params) => {
    calls.push({ method, params: structuredClone(params) })
    const thread = threads[params.threadId]
    if (method === 'thread/read') return { thread: { id: thread.id, status: thread.status } }
    if (method === 'thread/turns/list') return { data: structuredClone(thread.turns).reverse(), nextCursor: null }
    if (method === 'thread/queue/list') return { data: queued }
    if (method === 'thread/revert') { thread.turns.splice(thread.turns.findIndex(turn => turn.id === params.beforeTurnId)); return { thread: { id: thread.id } } }
    if (method === 'thread/fork') { threads.fork = { id: 'fork', turns: structuredClone(thread.turns.slice(0, thread.turns.findIndex(turn => turn.id === params.beforeTurnId))) }; return { thread: { id: 'fork' } } }
    if (method === 'turn/start') {
      const turn = { id: 'replacement', status: 'inProgress', items: [{ type: 'userMessage', content: params.input }] }
      thread.turns.push(turn)
      if (failAfterStart) throw new Error('connection closed after dispatch')
      return { turn }
    }
    throw new Error('Unexpected method: ' + method)
  }
  const journalPath = join(home, 'journal.json')
  const service = () => new MessageRetryService(rpc, new OperationJournal(journalPath), id => clears.push(id), async (id, snapshot) => backups.push({ id, snapshot: structuredClone(snapshot) }))
  return { threads, calls, backups, clears, service: service(), restart: service, fail: () => { failAfterStart = true }, queue: () => { queued = [{ id: 'queued' }] } }
}

test('retry replaces the latest turn, preserving original context and images exactly once', async t => {
  const original = user('last', '<rmdex_employee_context>identity</rmdex_employee_context>\n<rmdex_user_request>hello</rmdex_user_request>')
  original.items[0].content.push({ type: 'localImage', path: '/private/photo.png', assetUrl: '/api/images/opaque' })
  const f = await fixture(t, [user('first', 'earlier'), original])
  const result = await f.service.retry('source', { turnId: 'last', operationId: randomUUID() }, { approvalPolicy: 'on-request' })
  assert.equal(result.outcome, 'started')
  assert.equal(result.threadId, 'source')
  assert.equal(result.forked, false)
  assert.deepEqual(f.threads.source.turns.map(turn => turn.id), ['first', 'replacement'])
  assert.deepEqual(f.threads.source.turns[1].items[0].content, original.items[0].content.map(({ assetUrl, ...part }) => part))
  assert.deepEqual(f.clears, ['source'])
  assert.deepEqual(f.backups[0].snapshot.turn, original)
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1)
})

test('retry of the first historical turn forks before it without changing the source', async t => {
  const original = [user('first', 'hello'), user('last', 'later')]
  const f = await fixture(t, original)
  const result = await f.service.retry('source', { turnId: 'first', operationId: randomUUID() }, {})
  assert.equal(result.outcome, 'started')
  assert.equal(result.forked, true)
  assert.deepEqual(f.threads.source.turns, original)
  assert.deepEqual(f.threads.fork.turns.map(turn => turn.id), ['replacement'])
  assert.equal(f.calls.find(call => call.method === 'thread/fork').params.beforeTurnId, 'first')
  assert.equal(f.calls.some(call => call.method === 'thread/revert'), false)
})

test('an operation replay survives restart and never reverts or starts twice', async t => {
  const f = await fixture(t)
  const data = { turnId: 'first', operationId: randomUUID() }
  const first = await f.service.retry('source', data, {})
  assert.deepEqual(await f.restart().retry('source', data, {}), first)
  assert.equal(f.calls.filter(call => call.method === 'thread/revert').length, 1)
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1)
})

test('ambiguous start failures retain the original backup and never blindly resend', async t => {
  const f = await fixture(t)
  f.fail()
  const data = { turnId: 'first', operationId: randomUUID() }
  const result = await f.service.retry('source', data, {})
  assert.equal(result.outcome, 'uncertain')
  assert.match(result.message, /未重复提交/)
  assert.equal(f.backups[0].snapshot.turn.id, 'first')
  assert.deepEqual(await f.restart().retry('source', data, {}), result)
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1)
})

for (const condition of ['active', 'missing', 'queue', 'multiple', 'colleague']) test(`retry rejects ${condition} before changing history`, async t => {
  const f = await fixture(t)
  if (condition === 'active') f.threads.source.status.type = 'active'
  if (condition === 'queue') f.queue()
  if (condition === 'multiple') f.threads.source.turns[0].items.push({ type: 'userMessage', content: [{ type: 'text', text: 'steer' }] })
  if (condition === 'colleague') f.threads.source.turns[0].items[0].content[0].text = '<rmdex_colleague_message>{"messageId":"message","senderName":"Writer","text":"hello"}</rmdex_colleague_message>'
  const before = structuredClone(f.threads)
  const result = await f.service.retry('source', { turnId: condition === 'missing' ? 'gone' : 'first', operationId: randomUUID() }, {})
  assert.equal(result.outcome, 'rejected')
  assert.deepEqual(f.threads, before)
  assert.equal(f.backups.length, 0)
})

test('command summaries show shell content without changing genuine command paths', () => {
  const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  assert.equal(commandSummary(`"${shell}" -Command "Get-Content src/App.vue -Raw"`), 'Get-Content src/App.vue -Raw')
  assert.equal(commandSummary(`& '${shell}' -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command 'npm.cmd run build'`), 'npm.cmd run build')
  assert.equal(commandSummary([shell, '-NoProfile', '-Command', 'rg -n "retry" src\n npm.cmd test']), 'rg -n "retry" src npm.cmd test')
  assert.equal(commandSummary('/bin/bash -lc \'npm test\''), 'npm test')
  assert.equal(commandSummary('cmd.exe /d /s /c "npm.cmd run build"'), 'npm.cmd run build')
  assert.equal(commandSummary('"pwsh.exe" -Command "Write-Output hello"'), 'Write-Output hello')
  assert.equal(commandSummary('C:\\Windows\\System32\\robocopy.exe src dst'), 'C:\\Windows\\System32\\robocopy.exe src dst')
  assert.equal(commandSummary('echo "powershell.exe -Command example"'), 'echo "powershell.exe -Command example"')
  assert.equal(commandSummary(undefined), '')
})
