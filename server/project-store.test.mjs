import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProjectStore } from './project-store.ts'

test('managed projects persist, update, merge with Desktop projects, and delete without touching folders', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-project-store-'))
  const folder = join(home, 'sample-project')
  await mkdir(folder)
  try {
    const store = new ProjectStore(home)
    const project = await store.create({ name: 'Sample', path: folder })
    assert.equal(project.name, 'Sample')
    await assert.rejects(store.create({ name: 'Duplicate', path: folder }), /已添加/)

    const updated = await store.update(project.id, { name: 'Renamed', path: folder })
    assert.equal(updated.name, 'Renamed')
    const reloaded = new ProjectStore(home)
    assert.equal((await reloaded.list())[0].name, 'Renamed')

    const merged = await reloaded.list([{ id: 'native-project', name: 'Desktop name', path: folder }, { id: 'native-other', name: 'Other', path: home }])
    assert.equal(merged.length, 2)
    assert.equal(merged.find(item => item.id === project.id).nativeProjectId, 'native-project')
    assert.equal(merged.find(item => item.nativeProjectId === 'native-other').source, 'desktop')

    await reloaded.delete(project.id)
    assert.equal((await new ProjectStore(home).list()).length, 0)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('project store requires an absolute path to an existing directory', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-project-store-'))
  try {
    const store = new ProjectStore(home)
    await assert.rejects(store.create({ name: 'Missing', path: join(home, 'missing') }), /不存在/)
    await assert.rejects(store.create({ name: 'Relative', path: 'relative' }), /绝对/)
  } finally { await rm(home, { recursive: true, force: true }) }
})
