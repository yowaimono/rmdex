import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
import { test } from 'node:test'
import { AttachmentStore, attachmentInput, attachmentPrompt } from './attachments.ts'

test('attachments are stored under opaque names and turn inputs preserve images and file context', async () => {
  const store = new AttachmentStore()
  const image = await store.add({ name: 'photo.png', type: 'text/plain', data: Buffer.from('png-data').toString('base64') })
  const document = await store.add({ name: 'notes.txt', type: 'text/plain', data: Buffer.from('notes').toString('base64') })
  const files = store.resolve([image.id, document.id])
  try {
    assert.notEqual(files[0].path, 'photo.png')
    assert.equal(files[0].type, 'image/png')
    const input = attachmentInput('Review these', files)
    assert.equal(input[0].text.includes('notes.txt'), true)
    assert.equal(input[1].type, 'localImage')
    assert.equal(input[1].path, files[0].path)
    assert.equal(attachmentPrompt('', files).includes('Please inspect the attached file(s)'), true)
  } finally {
    await Promise.all(files.map(file => unlink(file.path)))
  }
})

test('attachment store rejects unknown types, malformed base64, and expired ids', async () => {
  const store = new AttachmentStore()
  await assert.rejects(store.add({ name: 'payload.exe', data: 'YQ==' }), /不支持/)
  await assert.rejects(store.add({ name: 'notes.txt', data: 'not base64!' }), /编码无效/)
  assert.throws(() => store.resolve(['00000000-0000-4000-8000-000000000000']), /过期/)
})
