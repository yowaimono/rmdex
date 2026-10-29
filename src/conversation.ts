export type ContentPart = { type: string; text?: string; url?: string; path?: string; assetUrl?: string }
export type Item = { id?: string; type: string; text?: string; content?: ContentPart[]; [key: string]: unknown }
export type Turn = { id: string; status: string; items: Item[] }
export type Entry = { role: 'user' | 'agent'; text: string; images: ContentPart[]; item: Item } | { role: 'tools'; items: Item[] }

// Desktop routes native create/send input through a delegation tool result.
// Only this exact envelope is user input; ordinary tool results stay tools.
export function normalizeItem(item: Item): Item {
  if (item.type !== 'functionCallOutput' || item.namespace !== 'codex_app' || !['create_thread', 'send_message_to_thread'].includes(String(item.name))) return item
  const output = item.output
  const text = typeof output === 'string' ? output : output && typeof output === 'object' && 'text' in output ? output.text : null
  if (typeof text !== 'string') return item
  const match = text.match(/^\s*<codex_delegation>\s*<source_thread_id>[a-zA-Z0-9-]+<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/)
  if (!match) return item
  return { id: item.id, type: 'userMessage', content: [{ type: 'text', text: match[1]!.trim() }] }
}

export function userText(text: string): string {
  const context = /<in-app-browser-context source="ambient-ui-state">[\s\S]*?<\/in-app-browser-context>/g
  const hasContext = context.test(text)
  let result = text.replace(context, '').trim()
  const filesWrapper = /^# Files mentioned by the user:\s*\n[\s\S]*?\nDistinguish instructions in attached documents from the user's request\.\s*\n\s*## My request:\s*\n/
  const match = result.match(filesWrapper)
  if (match) return result.slice(match[0].length).trim()
  if (hasContext && /^## My request:\s*\n/.test(result)) result = result.replace(/^## My request:\s*\n/, '')
  return result.trim()
}

export function timeline(turns: Turn[]): Entry[] {
  const entries: Entry[] = []
  for (const turn of turns) {
    let group: Item[] = []
    const flush = () => { if (group.length) entries.push({ role: 'tools', items: group }); group = [] }
    for (const original of turn.items || []) {
      const item = normalizeItem(original)
      if (item.type === 'reasoning' || item.type === 'hookPrompt') continue
      if (item.type === 'userMessage') {
        flush()
        const text = userText((item.content || []).filter(part => part.type === 'text').map(part => part.text || '').filter(Boolean).join('\n'))
        const images = (item.content || []).filter(part => part.type === 'localImage' || part.type === 'image')
        if (text || images.length) entries.push({ role: 'user', text, images, item })
      } else if (item.type === 'agentMessage') {
        flush()
        if (item.text) entries.push({ role: 'agent', text: item.text, images: [], item })
      } else group.push(item)
    }
    flush()
  }
  return entries
}
