import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DesktopMcp } from './desktop-mcp.ts'
import { DesktopAdapter, OperationJournal, adaptRead } from './desktop-adapter.ts'
import { desktopModels } from './desktop-models.ts'
import { normalizeItem, timeline } from '../src/conversation.ts'

const fixture = fileURLToPath(new URL('./desktop-test-fixture.mjs', import.meta.url))
const context = { server: fixture, pipe: 'mock', threadId: 'registered-caller', turnId: 'registered-turn', registeredAt: Date.now() }
test('Desktop delegated input renders as user before replies without hiding real tool results', () => {
  const input = name => ({ type: 'functionCallOutput', id: name, namespace: 'codex_app', name, output: { text: '<codex_delegation>\n  <source_thread_id>caller-id</source_thread_id>\n  <input>看看我电脑配置</input>\n</codex_delegation>', truncated: false } })
  for (const name of ['create_thread', 'send_message_to_thread']) {
    const result = adaptRead({ thread: { id: 'target', kind: 'codex', hostId: 'local' }, page: { order: 'newest_first' }, turns: [{ id: 'turn', status: 'completed', items: [input(name), { type: 'agentMessage', text: '我会检查系统' }, { type: 'commandExecution', output: { text: 'result', truncated: false } }] }] }, 'target')
    assert.deepEqual(timeline(result.thread.turns).map(entry => entry.role), ['user', 'agent', 'tools'])
    assert.equal(result.thread.turns[0].items[0].content[0].text, '看看我电脑配置')
    assert.equal(timeline([{ id: 't', status: 'completed', items: [input(name)] }])[0].role, 'user')
  }
  const realOutput = { ...input('read_thread') }
  assert.equal(normalizeItem(realOutput), realOutput)
  const otherServer = { ...input('send_message_to_thread'), namespace: 'other' }
  assert.equal(normalizeItem(otherServer), otherServer)
  const incomplete = { ...input('send_message_to_thread'), output: { text: '<codex_delegation><input>incomplete' } }
  assert.equal(normalizeItem(incomplete), incomplete)
  const nested = { ...input('create_thread'), output: { text: '<codex_delegation><source_thread_id>source</source_thread_id><input>keep </input> inside text</input></codex_delegation>' } }
  assert.equal(normalizeItem(nested).content[0].text, 'keep </input> inside text')
})
test('MCP matches concurrent replies and preserves registered identity', async () => {
  const client = new DesktopMcp(context)
  try {
    const [slow, fast] = await Promise.all([client.call('read_thread', { threadId: 'slow' }), client.call('read_thread', { threadId: 'fast', _meta: { threadId: 'attacker' } })])
    assert.equal(slow.id, 'slow'); assert.equal(fast.id, 'fast')
    assert.equal(fast.metadata.threadId, 'registered-caller'); assert.equal(fast.metadata.turnId, 'registered-turn')
    await assert.rejects(client.call('set_thread_archived', {}), /不提供/)
  } finally { client.close() }
})
for (const pipe of ['timeout', 'disconnect']) test(`MCP ${pipe} reports uncertain write without retry`, async () => {
  const client = new DesktopMcp({ ...context, pipe }, 500)
  try {
    await client.tools()
    await assert.rejects(client.call('send_message_to_thread', { threadId: 'target', prompt: 'test' }, true), error => error.uncertain === true)
  } finally { client.close() }
})
test('history is chronological, excludes reasoning, reports live turn and cursor', () => {
  const result = adaptRead({ thread: { id: 'target', kind: 'codex', hostId: 'local', title: 'test' }, page: { order: 'newest_first', hasMore: true, nextCursor: 'older' }, turns: [
    { id: 'new', status: 'inProgress', items: [{ type: 'reasoning' }, { type: 'commandExecution', output: 'visible' }] },
    { id: 'old', status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }] },
  ] }, 'target')
  assert.deepEqual(result.thread.turns.map(turn => turn.id), ['old', 'new'])
  assert.deepEqual(result.thread.turns[1].items.map(item => item.type), ['commandExecution'])
  assert.equal(result.activeTurnId, 'new'); assert.equal(result.page.nextCursor, 'older')
  assert.throws(() => adaptRead({ thread: { id: 'other' }, turns: [] }, 'target'), /不匹配/)
})
test('adapter filters hosts and kinds, forwards history cursor and disables unsupported controls', async () => {
  const calls = []
  const client = {
    tools: async () => ['list_threads', 'read_thread', 'send_message_to_thread', 'create_thread'].map(name => ({ name })),
    call: async (name, args) => {
      calls.push([name, args])
      if (name === 'list_threads') return { pinnedThreads: [{ id: 'pinned', kind: 'codex', hostId: 'local', title: 'pinned' }], threads: [{ id: 'remote', kind: 'codex', hostId: 'remote' }, { id: 'chatgpt', kind: 'chatgpt', hostId: 'local' }, { id: 'pinned', kind: 'codex', hostId: 'local' }] }
      return { thread: { id: args.threadId }, turns: [], page: {} }
    },
  }
  const adapter = new DesktopAdapter(client, null)
  assert.deepEqual((await adapter.list()).data.map(thread => thread.id), ['pinned'])
  const caps = (await adapter.models()).capabilities
  assert.equal(caps.stop, false); assert.equal(caps.models, false); assert.equal(caps.permissions, false)
  await adapter.read('target', 'previous-page')
  assert.equal(calls.at(-1)[1].cursor, 'previous-page')
})
test('durable journal prevents repeated writes after timeout and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rmdex-desktop-test-'))
  const path = join(dir, 'operations.json')
  try {
    let count = 0
    const journal = new OperationJournal(path)
    const result = await journal.run('operation', 'fingerprint', async () => { count++; throw new Error('private transport error') })
    assert.equal(result.outcome, 'uncertain')
    const restarted = new OperationJournal(path)
    assert.deepEqual(await restarted.run('operation', 'fingerprint', async () => { count++; return {} }), result)
    assert.equal(count, 1)
    await assert.rejects(restarted.run('operation', 'different', async () => ({})), /不一致/)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    saved['interrupted'] = { fingerprint: 'f', state: 'dispatching' }
    await writeFile(path, JSON.stringify(saved))
    assert.equal((await new OperationJournal(path).run('interrupted', 'f', async () => { throw new Error('must not run') })).outcome, 'uncertain')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('parses the live Desktop model catalog without hardcoding model ids', () => {
  const description = 'Models and supported reasoning efforts on the calling host: vendor/model (Friendly model; supported reasoning efforts: low, high), ccs-zz/Codex Auto Review (Review model · 128K; supported reasoning efforts: none, high). A different destination host is validated when the tool runs.'
  const models = desktopModels({ name: 'send_message_to_thread', inputSchema: { properties: { model: { type: 'string', description }, thinking: { type: 'string', enum: ['none', 'low', 'high'] } } } })
  assert.deepEqual(models.map(model => model.id), ['vendor/model', 'ccs-zz/Codex Auto Review'])
  assert.deepEqual(models[0].supportedReasoningEfforts.map(item => item.reasoningEffort), ['low', 'high'])
  assert.deepEqual(models[1].supportedReasoningEfforts.map(item => item.reasoningEffort), ['none', 'high'])
})

test('send and create forward an explicitly selected model and reasoning effort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rmdex-desktop-test-'))
  try {
    const calls = []
    const catalog = { type: 'object', properties: {
      model: { type: 'string', description: 'Models and supported reasoning efforts on the calling host: vendor/model (Friendly model; supported reasoning efforts: low, high).' },
      thinking: { type: 'string', enum: ['low', 'high'] },
    } }
    const client = { tools: async () => ['send_message_to_thread', 'create_thread'].map(name => ({ name, inputSchema: catalog })), call: async (name, args) => {
      calls.push([name, args])
      if (name === 'list_projects') return { projects: [{ projectId: 'project', hostId: 'local', projectKind: 'local', path: 'D:/work' }] }
      return { threadId: 'target' }
    } }
    const adapter = new DesktopAdapter(client, new OperationJournal(join(dir, 'journal.json')))
    const data = { operationId: '12345678-1234-1234-1234-123456789012', text: 'user input' }
    assert.equal((await adapter.send('target', data)).outcome, 'queued')
    await adapter.send('target', data)
    assert.equal(calls.filter(([name]) => name === 'send_message_to_thread').length, 1)
    assert.deepEqual(calls[0][1], { threadId: 'target', hostId: 'local', prompt: 'user input' })
    const selected = { ...data, operationId: '22345678-1234-1234-1234-123456789012', model: 'vendor/model', effort: 'high' }
    await adapter.send('target', selected)
    assert.deepEqual(calls.at(-1)[1], { threadId: 'target', hostId: 'local', prompt: 'user input', model: 'vendor/model', thinking: 'high' })
    await assert.rejects(adapter.send('target', { ...data, operationId: '32345678-1234-1234-1234-123456789012', model: 'unknown' }), /模型/)
    await assert.rejects(adapter.send('target', { ...data, operationId: '42345678-1234-1234-1234-123456789012', permissionMode: 'full' }), /权限/)
    const created = await adapter.create({ ...selected, operationId: '87654321-1234-1234-1234-123456789012', projectId: 'project' })
    assert.equal(created.thread.id, 'target')
    assert.deepEqual(calls.at(-1)[1].target, { type: 'project', projectId: 'project', environment: { type: 'local' } })
    assert.equal(calls.at(-1)[1].prompt, 'user input')
    assert.equal(calls.at(-1)[1].model, 'vendor/model')
    assert.equal(calls.at(-1)[1].thinking, 'high')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
