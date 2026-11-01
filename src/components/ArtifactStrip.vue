<script setup lang="ts">
import { ChevronDown, ChevronUp, Download, FileArchive, FileCode2, FileImage, FileSpreadsheet, FileText, FileType, Presentation } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

export type Artifact = { id: string; threadId: string; turnId: string; sourceItemId?: string; name: string; mimeType: string; size: number; previewMode: 'thumbnail' | 'inline' | 'downloadOnly' }
const emit = defineEmits<{ download: [artifact: Artifact]; preview: [artifact: Artifact]; 'load-thumbnail': [artifact: Artifact] }>()
const expanded = ref(false)
const props = defineProps<{ artifacts: Artifact[]; loading?: string | null; imageUrls?: Record<string, string> }>()
const visibleArtifacts = computed(() => expanded.value ? props.artifacts : props.artifacts.slice(0, 3))
const hiddenCount = computed(() => Math.max(0, props.artifacts.length - 3))
watch(visibleArtifacts, artifacts => {
  for (const artifact of artifacts) if (artifact.previewMode === 'thumbnail' && !props.imageUrls?.[artifact.id]) emit('load-thumbnail', artifact)
}, { immediate: true })
function icon(artifact: Artifact) {
  if (artifact.mimeType.startsWith('image/')) return FileImage
  if (artifact.mimeType.includes('spreadsheet') || artifact.mimeType === 'text/csv') return FileSpreadsheet
  if (artifact.mimeType.includes('presentation')) return Presentation
  if (artifact.mimeType.includes('word') || artifact.mimeType === 'application/pdf') return FileText
  if (artifact.mimeType.includes('zip') || artifact.mimeType.includes('rar') || artifact.mimeType.includes('7z')) return FileArchive
  if (artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json') return FileCode2
  return FileType
}
function size(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
function typeLabel(artifact: Artifact) {
  const extension = artifact.name.includes('.') ? artifact.name.split('.').pop()?.toUpperCase() : ''
  return extension || artifact.mimeType.split('/').pop()?.toUpperCase() || 'FILE'
}
function openPreview(artifact: Artifact) {
  if (artifact.previewMode === 'downloadOnly') return emit('download', artifact)
  emit('preview', artifact)
}
</script>

<template>
  <section v-if="props.artifacts.length" class="artifact-strip" aria-label="任务产物">
    <div class="artifact-strip-heading"><span>任务产物</span><span class="artifact-count">{{ props.artifacts.length }}</span></div>
    <div class="artifact-list">
      <article v-for="artifact in visibleArtifacts" :key="artifact.id" class="artifact-card">
        <button type="button" class="artifact-main" :title="artifact.previewMode === 'downloadOnly' ? '下载文件' : '预览文件'" @click="openPreview(artifact)">
          <img v-if="artifact.mimeType.startsWith('image/') && props.imageUrls?.[artifact.id]" class="artifact-thumbnail" :src="props.imageUrls[artifact.id]" :alt="artifact.name" loading="lazy" />
          <component v-else :is="icon(artifact)" :size="20" class="artifact-icon" />
          <span class="artifact-info"><strong>{{ artifact.name }}</strong><small>{{ typeLabel(artifact) }} · {{ size(artifact.size) }}</small></span>
        </button>
        <button type="button" class="artifact-download" title="下载文件" aria-label="下载文件" :disabled="props.loading === artifact.id" @click="emit('download', artifact)"><Download :size="16" /></button>
      </article>
    </div>
    <button v-if="hiddenCount" type="button" class="artifact-more" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? '收起其他产物' : `显示其他 ${hiddenCount} 个产物` }}<ChevronUp v-if="expanded" :size="14" /><ChevronDown v-else :size="14" /></button>
  </section>
</template>
