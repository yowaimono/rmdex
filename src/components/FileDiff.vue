<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, FileCode2 } from 'lucide-vue-next'

type Change = Record<string, unknown>
type DiffLine = { kind: 'add' | 'remove' | 'context'; oldNumber?: number; newNumber?: number; text: string }
type ParsedFile = { path: string; additions: number; deletions: number; lines: DiffLine[]; key: string }

const props = defineProps<{ item: Record<string, unknown> }>()

function isRecord(value: unknown): value is Change {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lineList(value: unknown): string[] | undefined {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').split('\n') : undefined
}

function textDiff(oldText: string, newText: string): string {
  const oldLines = lineList(oldText) || []
  const newLines = lineList(newText) || []
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++
  const contextBefore = oldLines.slice(0, prefix)
  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  const contextAfter = oldLines.slice(oldLines.length - suffix)
  return [
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...contextBefore.map(line => ` ${line}`),
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
    ...contextAfter.map(line => ` ${line}`),
  ].join('\n')
}

function diffSegments(diff: string): Array<{ path?: string; diff: string }> {
  const normalized = diff.replace(/\r\n/g, '\n')
  const starts = [...normalized.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm)].map(match => match.index ?? 0)
  if (!starts.length) return [{ diff: normalized }]
  return starts.map((start, index) => {
    const segment = normalized.slice(start, starts[index + 1])
    const header = segment.match(/^diff --git a\/(.+?) b\/(.+?)$/m)
    return { path: header?.[2] || header?.[1], diff: segment }
  })
}

function diffPath(diff: string): string | undefined {
  const gitHeader = diff.match(/^diff --git a\/(.+?) b\/(.+?)$/m)
  if (gitHeader) return gitHeader[2] || gitHeader[1]
  const fileHeader = diff.match(/^\+\+\+ (?:b\/)?([^\s]+)$/m)
  if (fileHeader && fileHeader[1] !== '/dev/null') return fileHeader[1]
  const oldHeader = diff.match(/^--- (?:a\/)?([^\s]+)$/m)
  return oldHeader?.[1] === '/dev/null' ? undefined : oldHeader?.[1]
}

function parseDiff(diff: string): Omit<ParsedFile, 'path' | 'key'> | undefined {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const parsed: DiffLine[] = []
  let oldNumber = 0
  let newNumber = 0
  let hasHunk = false
  let additions = 0
  let deletions = 0

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (!match) return undefined
      oldNumber = Number(match[1])
      newNumber = Number(match[2])
      hasHunk = true
      continue
    }
    if (!hasHunk || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      parsed.push({ kind: 'add', newNumber: newNumber++, text: line.slice(1) })
      additions++
    } else if (line.startsWith('-')) {
      parsed.push({ kind: 'remove', oldNumber: oldNumber++, text: line.slice(1) })
      deletions++
    } else if (line.startsWith(' ')) {
      parsed.push({ kind: 'context', oldNumber: oldNumber++, newNumber: newNumber++, text: line.slice(1) })
    } else if (line.length) {
      return undefined
    }
  }

  return hasHunk ? { additions, deletions, lines: parsed } : undefined
}

const files = computed<ParsedFile[]>(() => {
  const changes = props.item.changes
  const entries: Array<{ path?: string; diff?: string }> = []
  if (typeof changes === 'string') {
    entries.push(...diffSegments(changes))
  } else if (Array.isArray(changes)) {
    for (const value of changes) {
      if (typeof value === 'string') entries.push(...diffSegments(value))
      else if (isRecord(value)) {
        const path = [value.path, value.filePath, value.filename, value.file].find(item => typeof item === 'string' && item.trim()) as string | undefined
        const diff = typeof value.diff === 'string' ? value.diff : typeof value.unifiedDiff === 'string' ? value.unifiedDiff : typeof value.patch === 'string' ? value.patch : undefined
        if (diff) entries.push(...diffSegments(diff).map(segment => ({ ...segment, path: path || segment.path })))
        else if (typeof value.oldText === 'string' && typeof value.newText === 'string') entries.push({ path, diff: textDiff(value.oldText, value.newText) })
      }
    }
  } else if (isRecord(changes)) {
    const hasChangeFields = ['path', 'filePath', 'filename', 'file', 'diff', 'unifiedDiff', 'patch', 'oldText', 'newText'].some(key => key in changes)
    if (hasChangeFields) {
      const path = [changes.path, changes.filePath, changes.filename, changes.file].find(item => typeof item === 'string' && item.trim()) as string | undefined
      const diff = typeof changes.diff === 'string' ? changes.diff : typeof changes.unifiedDiff === 'string' ? changes.unifiedDiff : typeof changes.patch === 'string' ? changes.patch : undefined
      if (diff) entries.push(...diffSegments(diff).map(segment => ({ ...segment, path: path || segment.path })))
      else if (typeof changes.oldText === 'string' && typeof changes.newText === 'string') entries.push({ path, diff: textDiff(changes.oldText, changes.newText) })
    } else {
      for (const [path, value] of Object.entries(changes)) {
        if (typeof value === 'string') entries.push({ path, diff: value })
        else if (isRecord(value)) {
          const diff = typeof value.diff === 'string' ? value.diff : typeof value.unifiedDiff === 'string' ? value.unifiedDiff : typeof value.patch === 'string' ? value.patch : undefined
          if (diff) entries.push(...diffSegments(diff).map(segment => ({ ...segment, path: path || segment.path })))
          else if (typeof value.oldText === 'string' && typeof value.newText === 'string') entries.push({ path, diff: textDiff(value.oldText, value.newText) })
        }
      }
    }
  }
  const parsed = entries.flatMap((entry, index) => {
    const path = entry.path || diffPath(entry.diff || '') || (typeof props.item.path === 'string' ? props.item.path : undefined)
    if (!path || !entry.diff) return []
    const result = parseDiff(entry.diff)
    return result ? [{ ...result, path, key: `${path}-${index}` }] : []
  })
  return parsed
})

const hasUnparsedChanges = computed(() => files.value.length === 0)
</script>

<template>
  <div v-if="files.length" class="file-diff-list">
    <details v-for="file in files" :key="file.key" class="file-diff">
      <summary class="file-diff-summary">
        <ChevronRight :size="14" class="file-diff-chevron" />
        <FileCode2 :size="15" class="file-diff-icon" />
        <span class="file-diff-path" :title="file.path">{{ file.path }}</span>
        <span class="file-diff-counts"><span>+{{ file.additions }}</span><span>-{{ file.deletions }}</span></span>
      </summary>
      <div class="file-diff-scroll" tabindex="0" :aria-label="`${file.path} 的代码差异`">
        <div v-for="(line, index) in file.lines" :key="`${file.key}-${index}`" class="file-diff-line" :class="`is-${line.kind}`">
          <span class="file-diff-number">{{ line.oldNumber ?? '' }}</span>
          <span class="file-diff-number">{{ line.newNumber ?? '' }}</span>
          <span class="file-diff-mark">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }}</span>
          <code>{{ line.text || ' ' }}</code>
        </div>
      </div>
    </details>
  </div>
  <slot v-else-if="hasUnparsedChanges" />
</template>
