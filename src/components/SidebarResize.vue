<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{ modelValue: number }>()
const emit = defineEmits<{ 'update:modelValue': [width: number]; change: [width: number]; resizing: [active: boolean] }>()
const handle = ref<HTMLElement | null>(null)
const available = ref(window.innerWidth)
const minimum = 220
const maximum = computed(() => Math.max(minimum, Math.min(560, available.value - 320)))
const width = computed(() => Math.round(Math.max(minimum, Math.min(maximum.value, props.modelValue))))
let drag: { pointerId: number; x: number; width: number } | undefined
let observer: ResizeObserver | undefined

function resize(value: number) {
  emit('update:modelValue', Math.round(Math.max(minimum, Math.min(maximum.value, value))))
}
function start(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return
  event.preventDefault()
  drag = { pointerId: event.pointerId, x: event.clientX, width: width.value }
  handle.value?.setPointerCapture(event.pointerId)
  emit('resizing', true)
}
function move(event: PointerEvent) {
  if (event.pointerId === drag?.pointerId) resize(drag.width + event.clientX - drag.x)
}
function finish(event?: PointerEvent) {
  if (!drag || (event && event.pointerId !== drag.pointerId)) return
  const id = drag.pointerId
  drag = undefined
  if (handle.value?.hasPointerCapture(id)) handle.value.releasePointerCapture(id)
  emit('resizing', false)
  emit('change', width.value)
}
function keyboard(event: KeyboardEvent) {
  const next = event.key === 'ArrowLeft' ? width.value - 16 : event.key === 'ArrowRight' ? width.value + 16
    : event.key === 'Home' ? minimum : event.key === 'End' ? maximum.value : undefined
  if (next === undefined) return
  event.preventDefault()
  resize(next)
  emit('change', Math.round(Math.max(minimum, Math.min(maximum.value, next))))
}
function reset() { resize(290); emit('change', Math.min(maximum.value, 290)) }
onMounted(() => {
  observer = new ResizeObserver(entries => { available.value = entries[0]?.contentRect.width || window.innerWidth })
  if (handle.value?.parentElement) observer.observe(handle.value.parentElement)
})
onUnmounted(() => { observer?.disconnect(); finish() })
</script>

<template>
  <div ref="handle" class="sidebar-resizer" role="separator" tabindex="0" aria-label="调整会话列表宽度" aria-orientation="vertical"
    :aria-valuemin="minimum" :aria-valuemax="maximum" :aria-valuenow="width" aria-controls="thread-panel"
    title="拖动调整宽度，双击恢复默认" @pointerdown="start" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish" @keydown="keyboard" @dblclick="reset"><span /></div>
</template>
