<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Check, ChevronDown, Cpu, Gauge } from 'lucide-vue-next'

export type ModelOption = {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort: string
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
}

const props = defineProps<{
  models: ModelOption[]
  modelValue: string | null
  effort: string | null
  disabled?: boolean
  loading?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:effort': [value: string]
}>()
const open = ref(false)
const menu = ref<HTMLElement | null>(null)
const selected = computed(() => props.models.find(model => model.id === props.modelValue) || props.models.find(model => model.isDefault) || props.models[0])
const efforts = computed(() => selected.value?.supportedReasoningEfforts || [])
const selectedEffort = computed(() => props.effort || selected.value?.defaultReasoningEffort || efforts.value[0]?.reasoningEffort || '')
function chooseModel(model: ModelOption) {
  emit('update:modelValue', model.id)
  const effort = model.supportedReasoningEfforts.some(item => item.reasoningEffort === props.effort)
    ? props.effort
    : model.defaultReasoningEffort || model.supportedReasoningEfforts[0]?.reasoningEffort
  if (effort) emit('update:effort', effort)
  open.value = false
}
function chooseEffort(effort: string) {
  emit('update:effort', effort)
}
function closeOnOutside(event: MouseEvent) {
  if (menu.value && !menu.value.contains(event.target as Node)) open.value = false
}
watch(() => props.modelValue, () => {
  const current = selected.value
  if (current && props.effort && !current.supportedReasoningEfforts.some(item => item.reasoningEffort === props.effort)) emit('update:effort', current.defaultReasoningEffort)
})
onMounted(() => document.addEventListener('mousedown', closeOnOutside))
onUnmounted(() => document.removeEventListener('mousedown', closeOnOutside))
</script>

<template>
  <div ref="menu" class="model-menu">
    <button type="button" class="model-trigger" :class="{ 'is-open': open }" :disabled="disabled || loading || !models.length" title="选择模型" @click="open = !open">
      <Cpu :size="14" />
      <span class="model-trigger-copy"><strong>{{ loading ? '加载模型…' : (selected?.displayName || '选择模型') }}</strong><small v-if="selected">{{ selectedEffort }}</small></span>
      <ChevronDown :size="14" class="model-trigger-chevron" />
    </button>
    <div v-if="open" class="model-popup">
      <div class="model-popup-heading">模型</div>
      <div class="model-options">
        <button v-for="model in models" :key="model.id" type="button" class="model-option" :class="{ 'is-selected': model.id === selected?.id }" @click="chooseModel(model)">
          <Cpu :size="15" class="model-option-icon" />
          <span class="model-option-copy"><span class="model-option-name">{{ model.displayName }} <em v-if="model.isDefault">默认</em></span><span class="model-option-description">{{ model.description || model.model }}</span></span>
          <Check v-if="model.id === selected?.id" :size="15" class="model-check" />
        </button>
      </div>
      <div v-if="efforts.length" class="effort-section">
        <div class="model-popup-heading effort-heading"><Gauge :size="13" />推理强度</div>
        <div class="effort-options"><button v-for="item in efforts" :key="item.reasoningEffort" type="button" class="effort-option" :class="{ 'is-selected': item.reasoningEffort === selectedEffort }" :title="item.description" @click="chooseEffort(item.reasoningEffort)">{{ item.reasoningEffort }}<Check v-if="item.reasoningEffort === selectedEffort" :size="13" /></button></div>
      </div>
    </div>
  </div>
</template>

