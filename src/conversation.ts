export type ContentPart = { type: string; text?: string; url?: string; path?: string; assetUrl?: string }
export type Item = { id?: string; type: string; text?: string; content?: ContentPart[]; [key: string]: unknown }
export type Turn = { id: string; status: string; items: Item[] }
export type Entry = { role: 'user' | 'agent'; text: string; images: ContentPart[]; item: Item } | { role: 'tools'; items: Item[] }

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
    for (const item of turn.items || []) {
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
