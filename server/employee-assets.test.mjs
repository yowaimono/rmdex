import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
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
