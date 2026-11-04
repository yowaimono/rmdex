import { randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import MarkdownIt from 'markdown-it'
import { readArtifactRecords } from './skills/rmdex-employee/artifacts.mjs'

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
  source?: 'registered'
  sha256?: string
  createdAt?: number
  mtimeMs?: number
}

const mimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar', '.exe': 'application/vnd.microsoft.portable-executable',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
}
const sourceExtensions = new Set(['.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.jsx', '.jsonl', '.kt', '.m', '.md', '.php', '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.swift', '.ts', '.tsx', '.vue', '.xml', '.yaml', '.yml'])
const artifactExtensionPattern = Object.keys(mimeTypes).map(extension => extension.slice(1)).join('|')
const markdown = new MarkdownIt()
const validateLink = markdown.validateLink.bind(markdown)
// These links are inspected as local file references, never rendered as HTML.
markdown.validateLink = href => /^file:\/\//i.test(href) || validateLink(href)

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
  const markdownTargets = markdown.parse(value, {}).flatMap(block => (block.children || []).flatMap(token => {
    const path = token.type === 'link_open' ? token.attrGet('href') : token.type === 'image' ? token.attrGet('src') : null
    return path ? [{ path, explicitlyLinked: true }] : []
  }))
  // Stop at the artifact extension, not at the end of the sentence. A greedy
  // absolute-path match used to absorb Chinese/English prose after the file,
  // making stat() fail even though the answer clearly named an existing file.
  const boundary = `(?=$|[\\s<>"'\x60(),，。；：、.!?])`
  const plainPaths = [
    ...(value.match(new RegExp(`(?:[A-Za-z]:\\\\|/)[^<>"\\r\\n]*?\\.(?:${artifactExtensionPattern})${boundary}`, 'gi')) || []),
    ...(value.match(new RegExp(`(?:\\.\\.?[\\\\/])?[^\\s<>"'\\x60()]+\\.(?:${artifactExtensionPattern})${boundary}`, 'gi')) || []),
  ].map(path => ({ path, explicitlyLinked: false }))
  return [...markdownTargets, ...plainPaths].map(candidate => ({ ...candidate, path: trimPath(candidate.path) })).filter(candidate => candidate.path)
}

function linkPath(value: string) {
  if (/^file:\/\//i.test(value)) {
    try { return fileURLToPath(value) }
    catch { return value }
  }
  // Codex emits Markdown targets such as </D:/WorkSpace/report.md:12> on
  // Windows. The leading slash and editor location are not part of the file.
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:(?:[\\/]|%5c|%2f)/i.test(value)) return value
  let path = value
  try { path = decodeURIComponent(path) } catch { /* Keep literal malformed escapes. */ }
  if (process.platform === 'win32') path = path.replace(/^\/([a-z]:[\\/])/i, '$1')
  return path.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '')
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
  private readonly registeredPaths = new Map<string, Set<string>>()
  private readonly registeredArtifacts = new Map<string, Artifact>()

  constructor(private readonly home?: string) {}

  private forget(id: string) {
    this.artifacts.delete(id)
    const key = this.artifactKeys.get(id)
    if (key) this.keys.delete(key)
    this.artifactKeys.delete(id)
  }

  async restore(threadId: string) {
    if (!this.home) return
    const records = await readArtifactRecords(this.home, threadId)
    for (const [key, artifact] of this.registeredArtifacts) if (artifact.threadId === threadId) this.registeredArtifacts.delete(key)
    const paths = new Set<string>()
    for (const record of records) {
      const pathKey = `${record.turnId}:${record.path}`
      paths.add(pathKey)
      for (const artifact of this.artifacts.values()) if (artifact.threadId === threadId && `${artifact.turnId}:${artifact.path}` === pathKey) this.forget(artifact.id)
      if (record.detached) continue
      const mimeType = mimeTypes[extname(record.path).toLowerCase()] || 'application/octet-stream'
      this.registeredArtifacts.set(`${threadId}:${record.id}`, { id: record.id, threadId, turnId: record.turnId, path: record.path, name: record.name, size: record.size, mimeType, previewMode: previewMode(mimeType, record.size), source: 'registered', sha256: record.sha256, createdAt: record.createdAt, mtimeMs: record.mtimeMs })
    }
    this.registeredPaths.set(threadId, paths)
  }

  async register(result: unknown, threadId: string) {
    await this.restore(threadId)
    const root = typeof (result as any)?.thread?.cwd === 'string' ? (result as any).thread.cwd : ''
    const turns = Array.isArray((result as any)?.thread?.turns) ? (result as any).thread.turns : []
    for (const turn of turns) {
      if (!turn || turn.status !== 'completed' || typeof turn.id !== 'string' || !Array.isArray(turn.items)) continue
      const candidates: Array<{ path: string; sourceItemId?: string; explicitlyLinked?: boolean }> = []
      const changedPaths = new Set<string>()
      const addChangedPath = (value: string) => {
        if (!root || !isAbsolute(root)) return
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
      for (const item of textItems) for (const candidate of pathsFromText(item.text)) candidates.push({ ...candidate, path: candidate.explicitlyLinked ? linkPath(candidate.path) : candidate.path, sourceItemId: item.id })
      for (const item of turn.items) {
        if (item?.type !== 'imageGeneration') continue
        for (const path of [item.path, item.savedPath]) if (typeof path === 'string') candidates.push({ path, sourceItemId: item.id, explicitlyLinked: true })
      }
      for (const candidate of candidates) {
        if (!isAbsolute(candidate.path) && (!root || !isAbsolute(root))) continue
        const resolved = isAbsolute(candidate.path) ? resolve(candidate.path) : resolve(root, candidate.path)
        const extension = extname(resolved).toLowerCase()
        const changedSource = extension === '.json' || (sourceExtensions.has(extension) && extension !== '.md')
        if (root && isAbsolute(root) && changedPaths.has(relative(root, resolved).toLowerCase()) && (!candidate.explicitlyLinked || changedSource)) continue
        await this.registerFile(threadId, turn.id, root, candidate.path, candidate.sourceItemId, candidate.explicitlyLinked)
      }
    }
    return this.list(threadId)
  }

  private async registerFile(threadId: string, turnId: string, root: string, rawPath: string, sourceItemId?: string, explicitlyLinked = false) {
    const path = trimPath(rawPath)
    if (!isAbsolute(path) && (!root || !isAbsolute(root))) return
    const target = isAbsolute(path) ? path : resolve(root, path)
    if (!explicitlyLinked && (!root || !within(root, target))) return
    const extension = extname(path).toLowerCase()
    if (sourceExtensions.has(extension) && extension !== '.md') return
    const [canonicalRoot, canonicalTarget] = await Promise.all([root ? realpath(root).catch(() => '') : Promise.resolve(''), realpath(target).catch(() => '')])
    if (!canonicalTarget || (!explicitlyLinked && (!canonicalRoot || !within(canonicalRoot, canonicalTarget)))) return
    if (this.registeredPaths.get(threadId)?.has(`${turnId}:${canonicalTarget}`)) return
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
      this.forget(first)
    }
  }

  list(threadId: string) { return [...this.registeredArtifacts.values(), ...this.artifacts.values()].filter(item => item.threadId === threadId).map(({ path: _path, mtimeMs: _mtimeMs, ...item }) => item) }
  resolve(id: string, threadId?: string) { return (threadId ? this.registeredArtifacts.get(`${threadId}:${id}`) : [...this.registeredArtifacts.values()].find(item => item.id === id)) || this.artifacts.get(id) }
}
