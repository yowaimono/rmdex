<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Check, ChevronDown, Folder, MessageSquare } from 'lucide-vue-next'

type Project = { id: string; name: string; nativeProjectId?: string }
const props = defineProps<{ modelValue: string; projects: Project[]; desktopMode: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const focused = ref(0)
const options = computed(() => [
  { value: '', label: '独立会话', disabled: false },
  ...props.projects.map(project => ({ value: project.id, label: project.name, disabled: props.desktopMode && !project.nativeProjectId })),
])
const selected = computed(() => options.value.find(option => option.value === props.modelValue) || options.value[0]!)

function focusOption(index: number, direction = 1) {
  const count = options.value.length
  let next = (index + count) % count
  while (options.value[next]?.disabled) next = (next + direction + count) % count
  focused.value = next
  nextTick(() => root.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[next]?.focus())
}
function show() {
  if (props.disabled) return
  open.value = true
  focusOption(Math.max(0, options.value.findIndex(option => option.value === props.modelValue)))
}
function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) nextTick(() => trigger.value?.focus())
}
function choose(value: string) { emit('update:modelValue', value); close(true) }
function outside(event: PointerEvent) { if (!root.value?.contains(event.target as Node)) close() }
function onKey(event: KeyboardEvent) {
  if (!open.value) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  else if (event.key === 'ArrowDown') { event.preventDefault(); focusOption(focused.value + 1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); focusOption(focused.value - 1, -1) }
  else if (event.key === 'Home') { event.preventDefault(); focusOption(0) }
  else if (event.key === 'End') { event.preventDefault(); focusOption(options.value.length - 1, -1) }
  else if (event.key === 'Tab') close()
}
watch(() => props.disabled, disabled => { if (disabled) close() })
onMounted(() => document.addEventListener('pointerdown', outside))
onUnmounted(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <div ref="root" class="project-menu" @keydown="onKey">
    <button id="new-thread-project" ref="trigger" type="button" class="project-trigger" :class="{ 'is-open': open }" :disabled="disabled" aria-haspopup="menu" :aria-expanded="open" @click="open ? close() : show()" @keydown.down.prevent="show()" @keydown.up.prevent="show()">
      <span>{{ selected.label }}</span><ChevronDown :size="16" />
    </button>
    <div v-if="open" class="project-popup" role="menu" aria-label="选择 Project">
      <button v-for="(option, index) in options" :key="option.value" type="button" role="menuitemradio" :aria-checked="modelValue === option.value" :tabindex="focused === index ? 0 : -1" :disabled="option.disabled" class="project-option" :class="{ 'is-selected': modelValue === option.value }" @focus="focused = index" @click="choose(option.value)">
        <component :is="option.value ? Folder : MessageSquare" :size="16" class="project-option-icon" />
        <span class="project-option-name">{{ option.label }}<small v-if="option.disabled">请在 Desktop 创建</small></span>
        <Check v-if="modelValue === option.value" :size="16" class="project-check" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.project-menu { position: relative; margin-bottom: 14px; }
.project-trigger { width: 100%; height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 11px; border: 1px solid #dce4ed; border-radius: 5px; color: #263545; background: #fff; font-size: 13px; text-align: left; }
.project-trigger span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-trigger svg { flex: none; color: #7d8d9d; }
.project-trigger:hover, .project-trigger.is-open, .project-trigger:focus-visible { border-color: #8dbcf0; outline: 0; box-shadow: 0 0 0 2px rgba(8, 121, 249, .1); }
.project-popup { position: absolute; z-index: 2; top: calc(100% + 5px); left: 0; right: 0; max-height: min(240px, 40dvh); overflow-y: auto; padding: 5px; border: 1px solid #dce4ed; border-radius: 6px; background: #fff; box-shadow: 0 8px 24px rgba(35, 53, 75, .16); }
.project-option { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 9px; padding: 8px; border: 0; border-radius: 4px; color: #34485a; background: transparent; font-size: 13px; text-align: left; }
.project-option:hover:not(:disabled), .project-option:focus-visible { outline: 0; background: #f1f6fb; }
.project-option.is-selected { color: #0879f9; background: #edf5ff; }
.project-option:disabled { color: #a3afba; cursor: not-allowed; }
.project-option-icon, .project-check { flex: none; }
.project-option-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.project-option-name small { display: block; margin-top: 2px; font-size: 11px; }
</style>
