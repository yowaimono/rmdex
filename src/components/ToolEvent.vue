<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRight, FileCode2, Globe, Image, TerminalSquare, Wrench } from 'lucide-vue-next'
import { commandSummary } from '../command-summary'

type ToolItem = { type: string; [key: string]: unknown }
const props = defineProps<{ item: ToolItem; imageUrl?: string }>()
const emit = defineEmits<{ preview: [url: string] }>()
const names: Record<string, string> = {
  commandExecution: '执行命令', fileChange: '文件变更', mcpToolCall: '工具调用',
  dynamicToolCall: '工具调用', functionCallOutput: '工具结果', webSearch: '搜索网页',
  imageView: '查看图片', imageGeneration: '生成图片', collabAgentToolCall: '协作任务',
  subAgentActivity: '子任务', plan: '执行计划', sleep: '等待',
  enteredReviewMode: '进入审查', exitedReviewMode: '结束审查', contextCompaction: '上下文压缩',
}
const fieldNames: Record<string, string> = {
  command: '命令', commandActions: '命令步骤', cwd: '工作目录', aggregatedOutput: '输出',
  output: '输出', exitCode: '退出码', arguments: '参数', result: '结果', error: '错误',
  contentItems: '结果内容', changes: '变更', query: '搜索内容', action: '搜索操作',
  results: '搜索结果', path: '路径', savedPath: '保存路径', prompt: '任务', text: '内容',
  review: '审查内容', agentsStates: '任务状态', receiverThreadIds: '会话', failure: '错误',
}
const title = computed(() => names[props.item.type] || `事件 · ${props.item.type}`)
const icon = computed(() => {
  if (props.item.type === 'commandExecution') return TerminalSquare
  if (props.item.type === 'fileChange') return FileCode2
  if (props.item.type === 'webSearch') return Globe
  if (props.item.type === 'imageView' || props.item.type === 'imageGeneration') return Image
  return Wrench
})
function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text + ('truncated' in value && value.truncated ? '\n…（输出已截断）' : '')
  try { return JSON.stringify(value) } catch { return String(value) }
}
function commandActionText(value: unknown): string {
  const actions = Array.isArray(value) ? value : [value]
  return actions.map(action => {
    if (!action || typeof action !== 'object') return textValue(action)
    const item = action as Record<string, unknown>
    return [item.command, item.name, item.path].find(entry => typeof entry === 'string' && entry.trim()) as string || ''
  }).filter(Boolean).join(' · ')
}
const summary = computed(() => {
  const item = props.item
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return [item.server || item.namespace, item.tool || item.name].filter(Boolean).join(' · ')
  if (item.type === 'commandExecution') return commandSummary(item.command) || commandSummary(commandActionText(item.commandActions))
  if (item.type === 'webSearch') return textValue(item.query) || textValue(item.action)
  if (item.type === 'imageView') return textValue(item.path)
  if (item.type === 'functionCallOutput') return [item.namespace, item.name].filter(Boolean).join(' · ')
  return textValue(item.path) || textValue(item.name)
})
const outputPreview = computed(() => {
  const item = props.item
  const value = item.error || item.failure || item.aggregatedOutput || item.output
  const text = textValue(value).replace(/\s+/g, ' ').trim()
  return text.length > 180 ? `${text.slice(0, 180)}…` : text
})
const status = computed(() => {
  const value = props.item.status
  if (props.item.type === 'commandExecution' && value === 'completed' && typeof props.item.exitCode === 'number' && props.item.exitCode !== 0) return '失败'
  if (props.item.success === false) return '失败'
  return ({ inProgress: '进行中', completed: '已完成', failed: '失败', declined: '已拒绝' } as Record<string, string>)[String(value)] || (typeof value === 'string' ? value : '')
})
const duration = computed(() => typeof props.item.durationMs === 'number' ? (props.item.durationMs < 1000 ? `${props.item.durationMs} ms` : `${(props.item.durationMs / 1000).toFixed(1)} s`) : '')
const fields = computed(() => Object.entries(fieldNames).flatMap(([key, label]) => {
  const value = props.item[key]
  if (value === undefined || value === null || value === '') return []
  return [{ key, label, value: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}))
const raw = computed(() => JSON.stringify(props.item, null, 2))
</script>

<template>
  <details class="tool-event">
    <summary class="tool-summary">
      <component :is="icon" :size="15" class="tool-icon" />
      <span class="tool-title">{{ title }}</span>
      <span v-if="summary" class="tool-preview" :title="summary">{{ summary }}</span>
      <span v-if="outputPreview" class="tool-output-preview" :title="outputPreview">{{ outputPreview }}</span>
      <span v-if="status" class="tool-status" :class="{ failed: status === '失败' || status === '已拒绝' }">{{ status }}</span>
      <span v-if="duration" class="tool-duration">{{ duration }}</span>
      <ChevronRight :size="15" class="tool-chevron" />
    </summary>
    <div class="tool-details">
      <button v-if="imageUrl" type="button" class="tool-image-preview" title="放大预览图片" @click="emit('preview', imageUrl)"><img :src="imageUrl" alt="图片预览" loading="lazy" /></button>
      <div v-for="field in fields" :key="field.key" class="tool-field">
        <div class="tool-field-label">{{ field.label }}</div>
        <pre>{{ field.value }}</pre>
      </div>
      <details class="raw-event"><summary>原始事件</summary><pre>{{ raw }}</pre></details>
    </div>
  </details>
</template>
