import assert from 'node:assert/strict'
import { test } from 'node:test'
import { timeline } from './conversation.ts'

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
