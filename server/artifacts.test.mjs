import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ArtifactRegistry } from './artifacts.ts'

const roots = []
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rmdex-artifact-'))
  roots.push(root)
  await mkdir(join(root, 'out'))
  await writeFile(join(root, 'out', 'report.docx'), 'word-data')
  await writeFile(join(root, 'App.vue'), '<template />')
  await writeFile(join(root, 'settings.json'), '{"old":true}')
  const threadId = 'thread-1'
  const turnId = 'turn-1'
  const result = { thread: { cwd: root, turns: [{ id: turnId, status: 'completed', items: [
    { id: 'change-1', type: 'fileChange', changes: [{ path: join(root, 'App.vue'), oldText: 'old', newText: 'new' }] },
    { id: 'change-2', type: 'fileChange', changes: [{ path: join(root, 'settings.json'), oldText: 'old', newText: 'new' }] },
    { id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: `已生成文件：${join(root, 'out', 'report.docx')}\n代码已更新 ${join(root, 'App.vue')} 和 ${join(root, 'settings.json')}` },
  ] }] } }
  return { root, threadId, turnId, result }
}

test('registers generated office files as download-only and excludes changed source files', async () => {
  const { root, threadId, turnId, result } = await fixture()
  const registry = new ArtifactRegistry()
  const artifacts = await registry.register(result, threadId)
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].name, 'report.docx')
  assert.equal(artifacts[0].turnId, turnId)
  assert.equal(artifacts[0].previewMode, 'downloadOnly')
  assert.equal('path' in artifacts[0], false)
  assert.equal(registry.resolve(artifacts[0].id).path, join(root, 'out', 'report.docx'))
})

test('rejects paths outside the thread working directory', async () => {
  const { root, threadId, result } = await fixture()
  const outside = join(root, '..', 'outside.pdf')
  await writeFile(outside, 'private')
  try {
    result.thread.turns[0].items[1].text = `文件：${outside}`
    const artifacts = await new ArtifactRegistry().register(result, threadId)
    assert.deepEqual(artifacts.map(artifact => artifact.name), ['report.docx'])
  } finally { await rm(outside, { force: true }) }
})

test('only registers image generation output, not viewed input images', async () => {
  const { root, threadId, result } = await fixture()
  await writeFile(join(root, 'input.png'), 'not really png')
  result.thread.turns[0].items.push({ id: 'view-1', type: 'imageView', path: join(root, 'input.png') })
  const artifacts = await new ArtifactRegistry().register(result, threadId)
  assert.equal(artifacts.some(item => item.name === 'input.png'), false)
})
