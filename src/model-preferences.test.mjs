import assert from 'node:assert/strict'
import test from 'node:test'
import { modelPreferenceKey, resolveModelPreference } from './model-preferences.ts'

const models = [
  { id: 'default-model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] },
  { id: 'fast-model', isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
]

test('stores model and reasoning preferences under distinct thread keys', () => {
  const keyA = modelPreferenceKey('device-1', 'desktop', 'thread-a')
  const keyB = modelPreferenceKey('device-1', 'desktop', 'thread-b')
  assert.notEqual(keyA, keyB)
  assert.deepEqual(resolveModelPreference(models, { model: 'fast-model', effort: 'high' }), { model: 'fast-model', effort: 'high' })
  assert.deepEqual(resolveModelPreference(models, { model: 'default-model', effort: 'low' }), { model: 'default-model', effort: 'low' })
})

test('new threads use the catalog default, not another thread preference', () => {
  assert.deepEqual(resolveModelPreference(models), { model: 'default-model', effort: 'medium' })
})

test('unknown saved models and unsupported reasoning efforts fall back safely', () => {
  assert.deepEqual(resolveModelPreference(models, { model: 'removed-model', effort: 'extreme' }), { model: 'default-model', effort: 'medium' })
})
