<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Check, ChevronDown, Hand, ShieldAlert, ShieldCheck, Sparkles } from 'lucide-vue-next'

type Mode = 'ask' | 'auto' | 'full'
const props = defineProps<{ modelValue: Mode; disabled: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: Mode] }>()
const options = [
  { value: 'ask' as const, label: '请求审批', description: '需要额外权限时由你确认', icon: Hand },
  { value: 'auto' as const, label: '自动审查', description: '审批请求交由 Codex 自动审查', icon: Sparkles },
  { value: 'full' as const, label: '完全访问', description: '无需审批，可访问电脑文件和网络', icon: ShieldAlert },
]
const current = computed(() => options.find(option => option.value === props.modelValue)!)
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const focused = ref(0)

function focusOption(index: number) {
  focused.value = (index + options.length) % options.length
  nextTick(() => root.value?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[focused.value]?.focus())
}
function show() {
  if (props.disabled) return
  open.value = true
  focusOption(options.findIndex(option => option.value === props.modelValue))
}
function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) nextTick(() => trigger.value?.focus())
}
function choose(value: Mode) { emit('update:modelValue', value); close(true) }
function outside(event: PointerEvent) { if (!root.value?.contains(event.target as Node)) close() }
function onKey(event: KeyboardEvent) {
  if (!open.value) return
  if (event.key === 'Escape') { event.preventDefault(); close(true) }
  else if (event.key === 'ArrowDown') { event.preventDefault(); focusOption(focused.value + 1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); focusOption(focused.value - 1) }
  else if (event.key === 'Home') { event.preventDefault(); focusOption(0) }
  else if (event.key === 'End') { event.preventDefault(); focusOption(options.length - 1) }
}
watch(() => props.disabled, disabled => { if (disabled) close() })
onMounted(() => document.addEventListener('pointerdown', outside))
onUnmounted(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <div ref="root" class="permission-menu" @keydown="onKey">
    <button ref="trigger" type="button" class="permission-trigger" :class="{ 'is-full': modelValue === 'full', 'is-open': open }" :disabled="disabled" aria-haspopup="menu" :aria-expanded="open" title="选择权限模式" @click="open ? close() : show()" @keydown.down.prevent="show()" @keydown.up.prevent="show()">
      <ShieldCheck :size="16" /><span>{{ current.label }}</span><ChevronDown :size="14" />
    </button>
    <div v-if="open" class="permission-popup" role="menu" aria-label="权限模式">
      <div class="permission-heading">选择权限模式</div>
      <button v-for="(option, index) in options" :key="option.value" type="button" role="menuitemradio" :aria-checked="modelValue === option.value" :tabindex="focused === index ? 0 : -1" class="permission-option" :class="{ 'is-selected': modelValue === option.value, 'is-danger': option.value === 'full' }" @focus="focused = index" @click="choose(option.value)">
        <component :is="option.icon" :size="16" class="permission-option-icon" />
        <span class="permission-copy"><span class="permission-name">{{ option.label }}</span><span class="permission-description">{{ option.description }}</span></span>
        <Check v-if="modelValue === option.value" :size="16" class="permission-check" />
      </button>
    </div>
  </div>
</template>
