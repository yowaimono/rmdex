<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { Copy, GitFork, RotateCcw, X } from 'lucide-vue-next'

const props = defineProps<{ role: 'user' | 'agent'; copyText: string; retryable?: boolean; retryDisabled?: boolean; retryLabel?: string; forkable?: boolean; failed?: boolean }>()
const emit = defineEmits<{ copy: [text: string]; retry: []; fork: [] }>()
const open = ref(false)
const target = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let origin: { x: number; y: number; id: number } | undefined
let suppressClick = false
let actionPointerStarted = false

function cancelPress() {
  if (timer) clearTimeout(timer)
  timer = undefined
  origin = undefined
}
function showMenu() {
  cancelPress()
  suppressClick = true
  actionPointerStarted = false
  open.value = true
  window.getSelection()?.removeAllRanges()
  void nextTick(() => menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus())
}
function startPress(event: PointerEvent) {
  cancelPress()
  suppressClick = false
  if (!event.isPrimary || event.button !== 0) return
  origin = { x: event.clientX, y: event.clientY, id: event.pointerId }
  timer = setTimeout(showMenu, 500)
}
function movePress(event: PointerEvent) {
  if (origin && (event.pointerId !== origin.id || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10)) cancelPress()
}
function onClick(event: MouseEvent) {
  if (!suppressClick) return
  event.preventDefault()
  event.stopPropagation()
  suppressClick = false
}
function choose(action: 'copy' | 'retry' | 'fork') {
  close()
  if (action === 'copy') emit('copy', props.copyText)
  else if (action === 'retry') emit('retry')
  else emit('fork')
}
function actionClick(event: MouseEvent) {
  // Touch browsers can target the newly opened overlay with the synthetic
  // click from releasing the long press. Require a fresh press in the menu.
  if (event.detail > 0 && !actionPointerStarted) {
    event.preventDefault()
    event.stopPropagation()
  }
  actionPointerStarted = false
}
function close() {
  open.value = false
  void nextTick(() => target.value?.focus({ preventScroll: true }))
}
function menuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  event.preventDefault()
  event.stopPropagation()
  const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
watch(open, visible => {
  if (visible) window.addEventListener('keydown', menuKey, true)
  else window.removeEventListener('keydown', menuKey, true)
})
onUnmounted(() => { cancelPress(); window.removeEventListener('keydown', menuKey, true) })
</script>

<template>
  <article class="message" :class="[`message--${role}`, { 'message--failed': failed }]" :aria-label="failed ? '发送失败的用户消息' : role === 'user' ? '用户消息' : 'Codex 回复'">
    <div ref="target" class="message-body message-action-target" tabindex="0" aria-haspopup="dialog" :aria-expanded="open"
      @pointerdown="startPress" @pointermove="movePress" @pointerup="cancelPress" @pointercancel="cancelPress" @pointerleave="cancelPress"
      @contextmenu.prevent="showMenu" @keydown.shift.f10.prevent="showMenu" @keydown.context-menu.prevent="showMenu" @click.capture="onClick">
      <slot />
    </div>
    <Teleport to="body">
      <div v-if="open" class="message-action-backdrop" @pointerdown.capture="actionPointerStarted = true" @click.capture="actionClick" @click.self="close" @contextmenu.prevent @keydown.esc.stop.prevent="close">
        <section ref="menu" class="message-action-menu" role="dialog" aria-modal="true" :aria-label="role === 'user' ? '用户消息操作' : 'AI 回复操作'">
          <header><span>{{ role === 'user' ? '消息操作' : '最终回答' }}</span><button type="button" class="icon-button" aria-label="关闭消息操作" @click="close"><X :size="17" /></button></header>
          <button v-if="retryable" type="button" class="message-action-option" :disabled="retryDisabled" @click="choose('retry')"><RotateCcw :size="17" /><span>{{ retryLabel || '重试' }}</span></button>
          <button v-if="forkable" type="button" class="message-action-option" @click="choose('fork')"><GitFork :size="17" /><span>从这里分叉</span></button>
          <button type="button" class="message-action-option" :disabled="!copyText" @click="choose('copy')"><Copy :size="17" /><span>{{ role === 'user' ? '复制消息' : '复制最终回答' }}</span></button>
          <p v-if="retryable && retryDisabled">当前任务结束后可重试</p>
          <p v-if="role === 'agent' && !copyText">最终回答生成后可复制</p>
        </section>
      </div>
    </Teleport>
  </article>
</template>
