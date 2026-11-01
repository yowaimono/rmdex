export type ModelPreference = { model: string; effort: string | null }
export type ModelPreferenceOption = {
  id: string
  isDefault: boolean
  defaultReasoningEffort: string
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>
}

export function modelPreferenceKey(deviceId: string | undefined, mode: 'desktop' | 'app-server', threadId: string) {
  return `rmdex-thread-model:${mode}:${deviceId || 'local'}:${threadId}`
}

export function resolveModelPreference(models: ModelPreferenceOption[], saved?: ModelPreference | null): ModelPreference {
  const model = models.find(item => item.id === saved?.model) || models.find(item => item.isDefault) || models[0]
  if (!model) return { model: '', effort: null }
  return {
    model: model.id,
    effort: model.supportedReasoningEfforts.some(item => item.reasoningEffort === saved?.effort)
      ? saved?.effort || null
      : model.defaultReasoningEffort || model.supportedReasoningEfforts[0]?.reasoningEffort || null,
  }
}
