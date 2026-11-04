import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { installEmployeeSkill, prepareEmployeeAssets } from './employee-assets.ts'

test('employee skill installation and assets are isolated, repeatable, and preserve files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-employee-assets-'))
  try {
    const [skillPath, samePath] = await Promise.all([installEmployeeSkill(home), installEmployeeSkill(home)])
    assert.equal(skillPath, samePath)
    assert.match(await readFile(skillPath, 'utf8'), /name: rmdex-employee/)
    const first = await prepareEmployeeAssets({ userId: 'user-one', employeeId: 'employee-one' }, home)
    const otherEmployee = await prepareEmployeeAssets({ userId: 'user-one', employeeId: 'employee-two' }, home)
    const otherUser = await prepareEmployeeAssets({ userId: 'user-two', employeeId: 'employee-one' }, home)
    assert.notEqual(first.assetPath, otherEmployee.assetPath)
    assert.notEqual(first.assetPath, otherUser.assetPath)
    const memoryPath = join(first.assetPath, 'memories', '2026-01-01-preference.md')
    await writeFile(memoryPath, 'Preserve this memory')
    await writeFile(join(first.assetPath, 'sops', '2026-01-01-workflow.md'), 'A workflow')
    assert.equal((await prepareEmployeeAssets({ userId: 'user-one', employeeId: 'employee-one' }, home)).assetPath, first.assetPath)
    assert.equal(await readFile(memoryPath, 'utf8'), 'Preserve this memory')
    await assert.rejects(prepareEmployeeAssets({ userId: '../other', employeeId: 'employee-one' }, home), /identifier/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('existing user skill is not overwritten and prior memory is migrated idempotently', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-employee-assets-'))
  try {
    const skillDir = join(home, 'skills', 'rmdex-employee')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), 'user-managed skill')
    await assert.rejects(installEmployeeSkill(home), /user-managed/)
    assert.equal(await readFile(join(skillDir, 'SKILL.md'), 'utf8'), 'user-managed skill')
  } finally { await rm(home, { recursive: true, force: true }) }
  const migratedHome = await mkdtemp(join(tmpdir(), 'rmdex-employee-migrate-'))
  try {
    const input = { userId: 'user', employeeId: 'employee', legacyMemory: 'A prior note', legacyMemoryDate: '2026-01-01' }
    const result = await prepareEmployeeAssets(input, migratedHome)
    await prepareEmployeeAssets(input, migratedHome)
    assert.match(await readFile(join(result.assetPath, 'memories', '2026-01-01-previous-employee-memory.md'), 'utf8'), /A prior note/)
  } finally { await rm(migratedHome, { recursive: true, force: true }) }
})

test('communication helper is managed, scoped and protects user-owned files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-employee-communication-assets-'))
  try {
    const input = { userId: 'user', employeeId: 'employee', communication: { origin: 'https://relay.example', token: 'a'.repeat(43) } }
    const result = await prepareEmployeeAssets(input, home)
    const config = JSON.parse(await readFile(join(result.assetPath, 'communication.json'), 'utf8'))
    assert.deepEqual(config, { managedBy: 'rmdex', ...input.communication })
    assert.match(await readFile(join(result.assetPath, 'colleagues.mjs'), 'utf8'), /redirect: 'error'/)
    assert.match(await readFile(join(result.assetPath, 'voice.mjs'), 'utf8'), /employee voice helper/)
    await prepareEmployeeAssets({ ...input, communication: { ...input.communication, token: 'b'.repeat(43) } }, home)
    assert.equal(JSON.parse(await readFile(join(result.assetPath, 'communication.json'), 'utf8')).token, 'b'.repeat(43))
    await writeFile(join(result.assetPath, 'colleagues.mjs'), 'user owned helper')
    await assert.rejects(prepareEmployeeAssets(input, home), /User-managed/)
    assert.equal(await readFile(join(result.assetPath, 'colleagues.mjs'), 'utf8'), 'user owned helper')
    await assert.rejects(prepareEmployeeAssets({ ...input, communication: { ...input.communication, origin: 'http://insecure.example' } }, home), /origin/)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('artifact helper is installed without communication credentials and follows thread resets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-artifact-assets-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const input = { userId: 'user', employeeId: 'employee', threadId: 'old-thread' }
  const { assetPath } = await prepareEmployeeAssets(input, home)
  const helper = join(assetPath, 'artifacts.mjs'), contextPath = join(assetPath, 'artifact-context.json')
  const source = await readFile(new URL('./skills/rmdex-employee/artifacts.mjs', import.meta.url), 'utf8')
  assert.equal(await readFile(helper, 'utf8'), source)
  let context = JSON.parse(await readFile(contextPath, 'utf8'))
  assert.equal(context.userId, input.userId)
  assert.equal(context.employeeId, input.employeeId)
  assert.equal(context.threadId, 'old-thread')
  assert.deepEqual(Object.keys(context).sort(), ['agentOrigin', 'employeeId', 'managedBy', 'threadId', 'userId'])
  await prepareEmployeeAssets({ ...input, threadId: 'new-thread' }, home)
  context = JSON.parse(await readFile(contextPath, 'utf8'))
  assert.equal(context.threadId, 'new-thread')
  await assert.rejects(prepareEmployeeAssets({ ...input, threadId: '../bad' }, home), /thread identifier/)
  assert.equal(JSON.parse(await readFile(contextPath, 'utf8')).threadId, 'new-thread')
  await writeFile(helper, 'user owned helper')
  await assert.rejects(prepareEmployeeAssets(input, home), /User-managed/)
  assert.equal(await readFile(helper, 'utf8'), 'user owned helper')
  await writeFile(helper, source)
  await writeFile(contextPath, JSON.stringify({ managedBy: 'user' }))
  await assert.rejects(prepareEmployeeAssets(input, home), /User-managed/)
  assert.equal(JSON.parse(await readFile(contextPath, 'utf8')).managedBy, 'user')
})

test('artifact installation refuses linked helpers', async t => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-artifact-link-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const directory = join(home, 'rmdex', 'employees', 'user', 'employee')
  await mkdir(directory, { recursive: true })
  const target = join(home, 'owned.mjs')
  await writeFile(target, 'user file')
  try { await symlink(target, join(directory, 'artifacts.mjs')) } catch (error) {
    if (error.code === 'EPERM') { t.skip('File symlinks require Windows developer mode'); return }
    throw error
  }
  await assert.rejects(prepareEmployeeAssets({ userId: 'user', employeeId: 'employee', threadId: 'thread' }, home), /regular file/)
  assert.equal(await readFile(target, 'utf8'), 'user file')
})
