import assert from 'node:assert/strict'
import { test } from 'node:test'
import { timeline, voiceMessage } from './conversation.ts'

test('voice replies show a bubble without exposing a marker or spoken text', () => {
  const id = '53f016d0-aed5-4bf1-a97a-1d1b02e1e733'
  const marker = `<rmdex_voice employee="employee_1" id="${id}" seconds="12" />`
  const entry = timeline([{ id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', phase: 'final_answer', text: marker }] }])[0]
  assert.deepEqual(entry.voice, { employeeId: 'employee_1', id, seconds: 12 })
  assert.equal(entry.text, '')
  assert.equal(entry.copyText, '')
  assert.equal(voiceMessage(`${marker} extra`), undefined)
  assert.equal(voiceMessage('<rmdex_voice employee="../other" id="bad" />'), undefined)
  assert.deepEqual(voiceMessage(`<rmdex_voice employee="employee_1" id="${id}" />`), { employeeId: 'employee_1', id, seconds: 0 })
})

test('artifacts appear only below the final answer in their completed turn', () => {
  const artifacts = [{ id: 'artifact-1', threadId: 'thread-1', turnId: 'turn-1', name: 'report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 12, previewMode: 'downloadOnly' }]
  const entries = timeline([{ id: 'turn-1', status: 'completed', artifacts, items: [
    { id: 'commentary', type: 'agentMessage', phase: 'commentary', text: '处理中' },
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: '完成' },
  ] }])
  assert.deepEqual(entries.filter(entry => entry.role === 'agent').map(entry => entry.artifacts || []), [[], artifacts])
})

test('in-progress turns do not expose artifact cards', () => {
  const entries = timeline([{ id: 'turn-1', status: 'inProgress', artifacts: [{ id: 'artifact-1' }], items: [
    { id: 'message', type: 'agentMessage', text: '仍在执行' },
  ] }])
  assert.equal(entries.find(entry => entry.role === 'agent').artifacts, undefined)
})

for (const status of ['inProgress', 'failed', 'interrupted', 'completed']) test(`registered deliveries stay visible without a final answer in ${status} turns`, () => {
  const registered = { id: 'registered', source: 'registered' }
  const entries = timeline([{ id: 'turn', status, artifacts: [registered, { id: 'inferred' }], items: [] }])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].item.type, 'artifactDelivery')
  assert.equal(entries[0].forkable, false)
  assert.deepEqual(entries[0].artifacts, [registered])
})

test('registered deliveries move under the final voice bubble without duplication', () => {
  const id = '53f016d0-aed5-4bf1-a97a-1d1b02e1e733'
  const artifacts = [{ id: 'registered', source: 'registered' }]
  const entries = timeline([{ id: 'turn', status: 'completed', artifacts, items: [
    { id: 'final', type: 'agentMessage', phase: 'final_answer', text: `<rmdex_voice employee="employee_1" id="${id}" />` },
  ] }])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].voice.id, id)
  assert.deepEqual(entries[0].artifacts, artifacts)
})
