export type ContentPart = { type: string; text?: string; url?: string; path?: string; assetUrl?: string }
export type Item = { id?: string; type: string; text?: string; content?: ContentPart[]; [key: string]: unknown }
export type Turn = { id: string; status: string; items: Item[] }
export type MessageEntry = { role: 'user' | 'agent'; text: string; copyText: string; images: ContentPart[]; item: Item; turnId: string; forkable: boolean; colleagueName?: string }
export type Entry = MessageEntry | { role: 'tools'; items: Item[] }

// A retry must keep file references, but must not replay employee bootstrap
// instructions or ambient browser context from the original turn.
export function messageRequest(item: Item): string {
  const text = (item.content || []).filter(part => part.type === 'text').map(part => part.text || '').filter(Boolean).join('\n')
  return text.replace(/<in-app-browser-context source="ambient-ui-state">[\s\S]*?<\/in-app-browser-context>/g, '')
    .replace(/<rmdex_employee_context>[\s\S]*?<\/rmdex_employee_context>\s*/g, '')
    .replace(/<\/?rmdex_user_request>\s*/g, '').trim()
}

export function colleagueMessage(text: string): { senderName: string; text: string } | undefined {
  const clean = text.replace(/<rmdex_employee_context>[\s\S]*?<\/rmdex_employee_context>\s*/g, '').replace(/<\/?rmdex_user_request>\s*/g, '').trim()
  const match = clean.match(/^<rmdex_colleague_message>\s*([\s\S]*?)\s*<\/rmdex_colleague_message>$/)
  if (!match) return undefined
  try {
    const data = JSON.parse(match[1]!)
    if (typeof data.senderName === 'string' && typeof data.text === 'string' && typeof data.messageId === 'string') return data
  } catch { /* Display malformed envelopes as ordinary text. */ }
}

function finalAnswerItems(turn: Turn): Item[] {
  const replies = (turn.items || []).filter(item => item.type === 'agentMessage' && item.text?.trim())
  const explicit = replies.filter(item => item.phase === 'final_answer')
  if (explicit.length) return explicit
  // Older hosts omit phase. Only use the last reply after a completed turn,
  // and never fall back to an explicitly labelled commentary message.
  const last = replies[replies.length - 1]
  return turn.status === 'completed' && last && !last.phase ? [last] : []
}

export function finalAnswer(turn: Turn): string {
  return finalAnswerItems(turn).map(item => item.text!).join('\n\n')
}

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
  const employeeContext = /<rmdex_employee_context>[\s\S]*?<\/rmdex_employee_context>\s*/g
  let result = text.replace(context, '').replace(employeeContext, '').trim()
  result = result.replace(/^<rmdex_user_request>\s*/, '').replace(/\s*<\/rmdex_user_request>\s*$/, '').trim()
  const filesWrapper = /^# Files mentioned by the user:\s*\n[\s\S]*?\nDistinguish instructions in attached documents from the user's request\.\s*\n\s*## My request:\s*\n/
  const match = result.match(filesWrapper)
  const files = userFiles(text)
  if (match) result = result.slice(match[0].length).trim()
  result = result.replace(employeeContext, '').replace(/^<rmdex_user_request>\s*/, '').replace(/\s*<\/rmdex_user_request>\s*$/, '').trim()
  if (hasContext && /^## My request:\s*\n/.test(result)) result = result.replace(/^## My request:\s*\n/, '')
  const request = result.trim()
  return files.length ? [request, `附件：${files.map(file => file.name).join('、')}`].filter(Boolean).join('\n\n') : request
}

function userFiles(text: string) {
  const block = text.match(/^# Files mentioned by the user:\s*\n([\s\S]*?)\nDistinguish instructions in attached documents from the user's request\.\s*\n\s*## My request:\s*\n/)
  if (!block) return []
  return block[1]!.split('\n').flatMap(line => {
    const match = line.match(/^- (.+?): (.+)$/)
    return match ? [{ name: match[1]!, path: match[2]! }] : []
  })
}

export function timeline(turns: Turn[]): Entry[] {
  const entries: Entry[] = []
  for (const turn of turns) {
    const answerItems = finalAnswerItems(turn)
    const answer = answerItems.map(item => item.text!).join('\n\n')
    let group: Item[] = []
    const flush = () => { if (group.length) entries.push({ role: 'tools', items: group }); group = [] }
    for (const original of turn.items || []) {
      const item = normalizeItem(original)
      if (item.type === 'reasoning' || item.type === 'hookPrompt') continue
      if (item.type === 'userMessage') {
        flush()
        const rawText = (item.content || []).filter(part => part.type === 'text').map(part => part.text || '').filter(Boolean).join('\n')
        const colleague = colleagueMessage(rawText)
        const text = colleague?.text ?? userText(rawText)
        const images = (item.content || []).filter(part => part.type === 'localImage' || part.type === 'image')
        if (text || images.length) entries.push({ role: 'user', text, copyText: text, images, item, turnId: turn.id, forkable: false, ...(colleague ? { colleagueName: colleague.senderName } : {}) })
      } else if (item.type === 'agentMessage') {
        flush()
        if (item.text) entries.push({ role: 'agent', text: item.text, copyText: answer, images: [], item, turnId: turn.id, forkable: turn.status === 'completed' && answerItems.includes(original) })
      } else group.push(item)
    }
    flush()
  }
  return entries
}
