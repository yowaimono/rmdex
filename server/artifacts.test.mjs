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

test('registers an absolute file path mentioned inline before Chinese sentence punctuation', async () => {
  const { root, threadId, result } = await fixture()
  result.thread.turns[0].items.at(-1).text = `报告已生成在 ${join(root, 'out', 'report.docx')}，可以点击下载查看。`
  const artifacts = await new ArtifactRegistry().register(result, threadId)
  assert.deepEqual(artifacts.map(artifact => artifact.name), ['report.docx'])
})

test('registers Codex Markdown delivery links with Windows drive prefixes and source locations', async () => {
  const { root, threadId, result } = await fixture()
  const file = join(root, 'out', 'account-playbook.md')
  await writeFile(file, '# Delivery')
  const target = process.platform === 'win32' ? `/${file.replaceAll('\\', '/')}` : file
  delete result.thread.cwd
  result.thread.turns[0].items = [{ id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: `已交付：[运营底稿](<${target}:12>)` }]
  const artifacts = await new ArtifactRegistry().register(result, threadId)
  assert.deepEqual(artifacts.map(artifact => artifact.name), ['account-playbook.md'])
})

test('registers encoded Markdown and file URL links with spaces, parentheses and Unicode filenames', async () => {
  const { root, threadId, result } = await fixture()
  const file = join(root, 'out', '交付 (最终).pdf')
  await writeFile(file, 'pdf-data')
  delete result.thread.cwd
  const { pathToFileURL } = await import('node:url')
  for (const target of [file.replaceAll('\\', '/'), pathToFileURL(file).href]) {
    result.thread.turns[0].items.at(-1).text = `已交付：[下载报告](<${target}>)`
    const artifacts = await new ArtifactRegistry().register(result, threadId)
    assert.deepEqual(artifacts.map(artifact => artifact.name), ['交付 (最终).pdf'])
  }
})

test('registers an explicitly linked video with its correct media type', async () => {
  const { root, threadId, result } = await fixture()
  const file = join(root, 'out', 'intro.mp4')
  await writeFile(file, 'video-data')
  const target = process.platform === 'win32' ? `/${file.replaceAll('\\', '/')}` : file
  result.thread.turns[0].items.at(-1).text = `样片已完成：[查看视频](<${target}>)`
  const artifacts = await new ArtifactRegistry().register(result, threadId)
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].name, 'intro.mp4')
  assert.equal(artifacts[0].mimeType, 'video/mp4')
  assert.equal(artifacts[0].previewMode, 'downloadOnly')
})

test('keeps explicitly delivered Markdown created by fileChange while excluding code and config diffs', async () => {
  const { root, threadId, result } = await fixture()
  const file = join(root, 'out', 'account-playbook.md')
  await writeFile(file, '# Delivered document')
  result.thread.turns[0].items.unshift({ id: 'document-change', type: 'fileChange', changes: [{ path: file }] })
  const target = path => process.platform === 'win32' ? `/${path.replaceAll('\\', '/')}` : path
  result.thread.turns[0].items.at(-1).text = `已交付：[运营底稿](<${target(file)}>)\n代码：[App](<${target(join(root, 'App.vue'))}>)\n配置：[配置](<${target(join(root, 'settings.json'))}>)`
  const artifacts = await new ArtifactRegistry().register(result, threadId)
  assert.deepEqual(artifacts.map(artifact => artifact.name), ['account-playbook.md'])
})

test('rejects paths outside the thread working directory', async () => {
  const { root, threadId, result } = await fixture()
  const outside = join(root, '..', 'outside.pdf')
  await writeFile(outside, 'private')
  try {
    result.thread.turns[0].items.at(-1).text += `\n文件：${outside}`
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

test('registers explicitly linked delivery files outside the project directory', async () => {
  const { root, threadId, result } = await fixture()
  const screenshot = join(root, '..', 'desktop-shot.png')
  await writeFile(screenshot, 'image-data')
  try {
    result.thread.turns[0].items.at(-1).text = `已生成文件：${join(root, 'out', 'report.docx')}\n桌面截图已保存：[查看截图](${screenshot})`
    const artifacts = await new ArtifactRegistry().register(result, threadId)
    assert.deepEqual(artifacts.map(artifact => artifact.name), ['desktop-shot.png', 'report.docx'])
    assert.equal(artifacts.find(artifact => artifact.name === 'desktop-shot.png').previewMode, 'thumbnail')
  } finally { await rm(screenshot, { force: true }) }
})

test('registers explicitly linked delivery files when the thread has no working directory', async () => {
  const { root, threadId, result } = await fixture()
  const screenshot = join(root, '..', 'session-image.png')
  await writeFile(screenshot, 'image-data')
  try {
    delete result.thread.cwd
    result.thread.turns[0].items = [{ id: 'answer-1', type: 'agentMessage', phase: 'final_answer', text: `图片已附上：[查看二维码](${screenshot})` }]
    const artifacts = await new ArtifactRegistry().register(result, threadId)
    assert.deepEqual(artifacts.map(artifact => artifact.name), ['session-image.png'])
    assert.equal(artifacts[0].previewMode, 'thumbnail')
  } finally { await rm(screenshot, { force: true }) }
})
