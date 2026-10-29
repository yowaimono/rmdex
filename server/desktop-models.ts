import type { DesktopTool } from './desktop-mcp.ts'

type Model = {
  id: string; model: string; displayName: string; description: string
  hidden: boolean; isDefault: boolean; defaultReasoningEffort: string
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
}

// The installed Desktop currently publishes its host catalog in the model
// property's description. Do not infer models from configuration or use a
// fallback list if that format changes. Prefer a structured enum when present.
export function desktopModels(tool?: DesktopTool): Model[] {
  const properties = tool?.inputSchema?.properties as Record<string, any> | undefined
  const schema = properties?.model
  if (schema?.type !== 'string') return []
  const allowedEfforts = properties?.thinking?.enum
  const marker = 'Models and supported reasoning efforts on the calling host: '
  const description = typeof schema.description === 'string' ? schema.description : ''
  const offset = description.indexOf(marker)
  const parsed = new Map<string, { description: string; efforts: string[] }>()
  if (offset >= 0) {
    let remaining = description.slice(offset + marker.length)
    while (remaining) {
      const match = /^([^,()\r\n]+?) \(([\s\S]*?); supported reasoning efforts: ([a-z]+(?:, [a-z]+)*)\)(, |\.(?:\s|$)|$)/.exec(remaining)
      if (!match || parsed.has(match[1]!.trim())) { parsed.clear(); break }
      const efforts = match[3]!.split(', ')
      if (Array.isArray(allowedEfforts) && efforts.some(effort => !allowedEfforts.includes(effort))) { parsed.clear(); break }
      parsed.set(match[1]!.trim(), { description: match[2]!, efforts: Array.isArray(allowedEfforts) ? efforts : [] })
      remaining = match[4] === ', ' ? remaining.slice(match[0].length) : ''
    }
  }
  const ids: string[] = Array.isArray(schema.enum)
    ? [...new Set<string>(schema.enum.filter((id: unknown) => typeof id === 'string' && id.trim()))]
    : [...parsed.keys()]
  return ids.map(id => ({
    id, model: id, displayName: id, description: parsed.get(id)?.description || '',
    hidden: false, isDefault: false, defaultReasoningEffort: '',
    supportedReasoningEfforts: (parsed.get(id)?.efforts || []).map(reasoningEffort => ({ reasoningEffort, description: '' })),
  }))
}

export function sharedDesktopModels(tools: DesktopTool[]) {
  const catalogs = ['send_message_to_thread', 'create_thread'].flatMap(name => {
    const tool = tools.find(tool => tool.name === name)
    return tool ? [desktopModels(tool)] : []
  })
  const [first, ...rest] = catalogs
  return (first || []).filter(model => rest.every(catalog => catalog.some(other => other.id === model.id))).map(model => ({
    ...model,
    supportedReasoningEfforts: model.supportedReasoningEfforts.filter(effort => rest.every(catalog => catalog.find(other => other.id === model.id)?.supportedReasoningEfforts.some(other => other.reasoningEffort === effort.reasoningEffort))),
  }))
}
