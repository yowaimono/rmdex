import { createInterface } from 'node:readline'
const input = createInterface({ input: process.stdin })
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
input.on('line', line => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') { reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} } }); return }
  if (request.method === 'tools/list') { reply(request.id, { tools: ['list_threads', 'read_thread', 'send_message_to_thread', 'create_thread', 'list_projects'].map(name => ({ name })) }); return }
  if (request.method !== 'tools/call') return
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH === 'disconnect') { process.exit(0); return }
  if (process.env.CODEX_APP_TOOLS_PIPE_PATH === 'timeout') return
  if (request.params.arguments.threadId === 'slow') { setTimeout(() => reply(request.id, { content: [{ type: 'text', text: JSON.stringify({ id: 'slow' }) }] }), 100); return }
  reply(request.id, { content: [{ type: 'text', text: JSON.stringify({ id: request.params.arguments.threadId, metadata: request.params._meta }) }] })
})
