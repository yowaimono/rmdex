// Managed by rmdex: employee communication helper
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

try {
  const config = JSON.parse(await readFile(new URL('./communication.json', import.meta.url), 'utf8'))
  const [command, ...args] = process.argv.slice(2)
  const option = name => args[args.indexOf(name) + 1]
  if (!['list', 'send', 'create-employee'].includes(command)) throw new Error('Usage: colleagues.mjs list | send --to EMPLOYEE_ID --file UTF8_FILE --id MESSAGE_UUID | create-employee --name NAME --role ROLE --instructions-file UTF8_FILE')
  let body
  if (command === 'send') {
    if (!args.includes('--to') || !args.includes('--file')) throw new Error('--to and --file are required')
    const id = args.includes('--id') ? option('--id') : randomUUID()
    // Print before dispatch so an uncertain result can be checked using the same ID.
    console.error(`messageId: ${id}`)
    body = { recipientId: option('--to'), text: await readFile(option('--file'), 'utf8'), messageId: id }
  } else if (command === 'create-employee') {
    if (!args.includes('--name') || !args.includes('--instructions-file')) throw new Error('--name and --instructions-file are required')
    body = { name: option('--name'), role: args.includes('--role') ? option('--role') : '', instructions: await readFile(option('--instructions-file'), 'utf8') }
  }
  const path = command === 'list' ? 'colleagues' : command === 'send' ? 'messages' : 'employees'
  const response = await fetch(`${config.origin}/api/employee-communication/${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000), redirect: 'error',
  })
  const result = await response.json()
  console.log(JSON.stringify(result, null, 2))
  if (!response.ok) process.exitCode = 1
} catch (error) { console.error(error.message); process.exitCode = 1 }
