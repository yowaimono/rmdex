import { randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

export type Artifact = {
  id: string
  threadId: string
  turnId: string
  sourceItemId?: string
  name: string
  path: string
  mimeType: string
  size: number
  previewMode: 'thumbnail' | 'inline' | 'downloadOnly'
}

const mimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar', '.exe': 'application/vnd.microsoft.portable-executable',
}
const sourceExtensions = new Set(['.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx', '.jsonl', '.kt', '.m', '.md', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml'])

function trimPath(value: string) {
  return value.trim().replace(/^['"`]+|['"`,.;:!?)}]+$/g, '')
}

function within(root: string, target: string) {
  const rootPath = resolve(root)
  const targetPath = resolve(target)
  const rest = relative(rootPath, targetPath)
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest))
}

function pathsFromText(value: string) {
  const markdownTargets = [...value.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+['"][^)]*['"])?\)/g)]
    .map(match => ({ path: match[1] || match[2] || '', explicitlyLinked: true }))
  const plainPaths = [
    ...(value.match(/(?:[A-Za-z]:\\|\/)[^<>"\r\n]+/g) || []),
    ...(value.match(/(?:\.\.?[\\/])?[^\s<>"'`()]+\.(?:pdf|docx?|xlsx?|pptx?|csv|json|md|txt|png|jpe?g|gif|webp|zip|7z|rar|exe)(?=$|[\s<>"'`()])/gi) || []),
  ].map(path => ({ path, explicitlyLinked: false }))
  return [...markdownTargets, ...plainPaths].map(candidate => ({ ...candidate, path: trimPath(candidate.path) })).filter(candidate => candidate.path)
}

function linkPath(value: string) {
  if (value.startsWith('file://')) {
    try { return decodeURIComponent(new URL(value).pathname.replace(/^\/(\w:)/, '$1')) }
    catch { return value }
  }
  return value
}

function previewMode(mimeType: string, size: number): Artifact['previewMode'] {
  if (mimeType.startsWith('image/') && size <= 15 * 1024 * 1024) return 'thumbnail'
  if (mimeType === 'application/pdf' && size <= 32 * 1024 * 1024) return 'inline'
  if ((mimeType.startsWith('text/') || mimeType === 'application/json') && size <= 256 * 1024) return 'inline'
  return 'downloadOnly'
}

export class ArtifactRegistry {
  private readonly artifacts = new Map<string, Artifact>()
  private readonly keys = new Map<string, string>()
  private readonly artifactKeys = new Map<string, string>()

  async register(result: unknown, threadId: string) {
    const root = typeof (result as any)?.thread?.cwd === 'string' ? (result as any).thread.cwd : ''
    if (!root || !isAbsolute(root)) return this.list(threadId)
    const turns = Array.isArray((result as any)?.thread?.turns) ? (result as any).thread.turns : []
    for (const turn of turns) {
      if (!turn || turn.status !== 'completed' || typeof turn.id !== 'string' || !Array.isArray(turn.items)) continue
      const candidates: Array<{ path: string; sourceItemId?: string }> = []
      const changedPaths = new Set<string>()
      const addChangedPath = (value: string) => {
        let file = value.trim().replaceAll('/', sep).replace(/^[ab]\\/, '')
        if (!file) return
        if (isAbsolute(file)) {
          const rel = relative(root, resolve(file))
          if (rel.startsWith('..') || isAbsolute(rel)) return
          file = rel
        }
        changedPaths.add(file.toLowerCase())
      }
      const collectChanged = (value: unknown) => {
        if (typeof value === 'string') {
          for (const match of value.matchAll(/^\+\+\+ (?:[ab]\/)?([^\s]+)/gm)) addChangedPath(match[1]!)
          for (const match of value.matchAll(/^diff --git a\/([^\s]+) b\/([^\s]+)/gm)) addChangedPath(match[2]!)
        } else if (Array.isArray(value)) value.forEach(collectChanged)
        else if (value && typeof value === 'object') {
          const item = value as Record<string, unknown>
          const file = [item.path, item.filePath, item.filename, item.file].find((part): part is string => typeof part === 'string')
          if (file) addChangedPath(file)
          Object.values(value).forEach(collectChanged)
        }
      }
      for (const item of turn.items) if (item?.type === 'fileChange') collectChanged(item.changes)
      const replies = turn.items.filter((item: any) => item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim())
      const finalReplies = replies.filter((item: any) => item.phase === 'final_answer')
      const textItems = finalReplies.length ? finalReplies : replies.filter((item: any) => !item.phase).slice(-1)
      for (const item of textItems) for (const candidate of pathsFromText(item.text)) candidates.push({ ...candidate, path: linkPath(candidate.path), sourceItemId: item.id })
      for (const item of turn.items) {
        if (item?.type !== 'imageGeneration') continue
        for (const path of [item.path, item.savedPath]) if (typeof path === 'string') candidates.push({ path, sourceItemId: item.id, explicitlyLinked: true })
      }
      for (const candidate of candidates) {
        const resolved = isAbsolute(candidate.path) ? resolve(candidate.path) : resolve(root, candidate.path)
        if (changedPaths.has(relative(root, resolved).toLowerCase())) continue
        await this.registerFile(threadId, turn.id, root, candidate.path, candidate.sourceItemId, candidate.explicitlyLinked)
      }
    }
    return this.list(threadId)
  }

  private async registerFile(threadId: string, turnId: string, root: string, rawPath: string, sourceItemId?: string, explicitlyLinked = false) {
    const path = trimPath(rawPath)
    const target = isAbsolute(path) ? path : resolve(root, path)
    if (!explicitlyLinked && !within(root, target)) return
    const extension = extname(path).toLowerCase()
    if (sourceExtensions.has(extension) && extension !== '.md') return
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root).catch(() => ''), realpath(target).catch(() => '')])
    if (!canonicalRoot || !canonicalTarget || (!explicitlyLinked && !within(canonicalRoot, canonicalTarget))) return
    const info = await stat(canonicalTarget).catch(() => null)
    if (!info?.isFile() || info.size > 512 * 1024 * 1024) return
    const key = `${threadId}:${turnId}:${canonicalTarget}:${info.size}:${info.mtimeMs}`
    if (this.keys.has(key)) return
    const mimeType = mimeTypes[extension] || 'application/octet-stream'
    const artifact: Artifact = { id: randomUUID(), threadId, turnId, ...(sourceItemId ? { sourceItemId } : {}), name: basename(canonicalTarget), path: canonicalTarget, mimeType, size: info.size, previewMode: previewMode(mimeType, info.size) }
    this.keys.set(key, artifact.id)
    this.artifacts.set(artifact.id, artifact)
    this.artifactKeys.set(artifact.id, key)
    while (this.artifacts.size > 2000) {
      const first = this.artifacts.keys().next().value
      if (!first) break
      this.artifacts.delete(first)
      const firstKey = this.artifactKeys.get(first)
      if (firstKey) this.keys.delete(firstKey)
      this.artifactKeys.delete(first)
    }
  }

  list(threadId: string) { return [...this.artifacts.values()].filter(item => item.threadId === threadId).map(({ path: _path, ...item }) => item) }
  resolve(id: string) { return this.artifacts.get(id) }
}
