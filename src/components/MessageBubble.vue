<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { Copy, GitFork, RotateCcw } from 'lucide-vue-next'

const props = defineProps<{ role: 'user' | 'agent'; copyText: string; retryable?: boolean; retryDisabled?: boolean; retryLabel?: string; forkable?: boolean; failed?: boolean }>()
const emit = defineEmits<{ copy: [text: string]; retry: []; fork: [] }>()
const open = ref(false)
const target = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const position = ref({ left: '0px', top: '0px', maxHeight: '100vh', maxWidth: '100vw' })
const positioned = ref(false)
const placement = ref<'up' | 'down'>('down')
let timer: ReturnType<typeof setTimeout> | undefined
let origin: { x: number; y: number; id: number } | undefined
let suppressClick = false
let actionPointerStarted = false

function cancelPress() {
  if (timer) clearTimeout(timer)
  timer = undefined
  origin = undefined
}
function showMenu(event?: MouseEvent | KeyboardEvent | { clientX: number; clientY: number }) {
  if (open.value) return
  const point = event && 'clientX' in event ? { x: event.clientX, y: event.clientY } : undefined
  cancelPress()
  suppressClick = true
  actionPointerStarted = false
  positioned.value = false
  open.value = true
  window.getSelection()?.removeAllRanges()
  void nextTick(() => {
    if (!open.value || !menu.value || !target.value) return
    const viewport = window.visualViewport
    const left = (viewport?.offsetLeft || 0) + 12
    const top = (viewport?.offsetTop || 0) + 12
    const width = (viewport?.width || window.innerWidth) - 24
    const height = (viewport?.height || window.innerHeight) - 24
    position.value = { left: `${left}px`, top: `${top}px`, maxHeight: `${height}px`, maxWidth: `${width}px` }
    void nextTick(() => {
      if (!open.value || !menu.value || !target.value) return
      const rect = target.value.getBoundingClientRect()
      const popup = menu.value.getBoundingClientRect()
      // Long answers can extend beyond the screen: keep the menu near the
      // pressed text rather than the offscreen end of the entire answer.
      const usePoint = point && (rect.height > 160 || rect.top < top || rect.bottom > top + height)
      const above = usePoint ? point.y : Math.max(top, rect.top)
      const below = usePoint ? point.y : Math.min(top + height, rect.bottom)
      const downSpace = top + height - below - 8
      const upSpace = above - top - 8
      placement.value = downSpace >= popup.height || downSpace >= upSpace ? 'down' : 'up'
      const x = usePoint ? point.x - (props.role === 'user' ? popup.width : 0) : props.role === 'user' ? rect.right - popup.width : rect.left
      const y = placement.value === 'down' ? below + 8 : above - popup.height - 8
      position.value.left = `${Math.max(left, Math.min(x, left + width - popup.width))}px`
      position.value.top = `${Math.max(top, Math.min(y, top + height - popup.height))}px`
      positioned.value = true
      void nextTick(() => {
        if (!open.value || !menu.value) return
        const focusTarget = menu.value.querySelector<HTMLButtonElement>('button:not(:disabled)') || menu.value
        focusTarget.focus({ preventScroll: true })
      })
    })
  })
}
function startPress(event: PointerEvent) {
  cancelPress()
  suppressClick = false
  if (!event.isPrimary || event.button !== 0) return
  origin = { x: event.clientX, y: event.clientY, id: event.pointerId }
  const point = { clientX: event.clientX, clientY: event.clientY }
  timer = setTimeout(() => showMenu(point), 500)
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
  // Touch browsers can target the newly opened menu with the synthetic
  // click from releasing the long press. Require a fresh press in the menu.
  if (event.detail > 0 && !actionPointerStarted) {
    event.preventDefault()
    event.stopPropagation()
  }
  actionPointerStarted = false
}
function close(restoreFocus = true) {
  open.value = false
  if (restoreFocus) target.value?.focus({ preventScroll: true })
}
function outside(event: PointerEvent) {
  if (!menu.value?.contains(event.target as Node)) close(false)
}
function viewportChanged(event: Event) {
  if (!(event.target instanceof Node) || !menu.value?.contains(event.target)) close(false)
}
function menuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
    return
  }
  if (event.key === 'Tab') { close(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  event.preventDefault()
  event.stopPropagation()
  const direction = event.key === 'ArrowUp' ? -1 : 1
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length
  buttons[next]?.focus()
}
function removeListeners() {
  window.removeEventListener('keydown', menuKey, true)
  document.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('scroll', viewportChanged, true)
  window.removeEventListener('resize', viewportChanged)
  window.visualViewport?.removeEventListener('resize', viewportChanged)
  window.visualViewport?.removeEventListener('scroll', viewportChanged)
}
watch(open, visible => {
  if (visible) {
    window.addEventListener('keydown', menuKey, true)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('scroll', viewportChanged, true)
    window.addEventListener('resize', viewportChanged)
    window.visualViewport?.addEventListener('resize', viewportChanged)
    window.visualViewport?.addEventListener('scroll', viewportChanged)
  } else removeListeners()
})
onUnmounted(() => { cancelPress(); removeListeners() })
</script>

<template>
  <article class="message" :class="[`message--${role}`, { 'message--failed': failed }]" :aria-label="failed ? '发送失败的用户消息' : role === 'user' ? '用户消息' : 'Codex 回复'">
    <div ref="target" class="message-body message-action-target" tabindex="0" aria-haspopup="menu" :aria-expanded="open"
      @pointerdown="startPress" @pointermove="movePress" @pointerup="cancelPress" @pointercancel="cancelPress" @pointerleave="cancelPress"
      @contextmenu.prevent="showMenu" @keydown.shift.f10.prevent="showMenu" @keydown.context-menu.prevent="showMenu" @click.capture="onClick">
      <slot />
    </div>
    <Teleport to="body">
      <section v-if="open" ref="menu" class="message-action-menu" :class="`message-action-menu--${placement}`" :style="{ ...position, visibility: positioned ? 'visible' : 'hidden' }" role="menu" tabindex="-1" :aria-label="role === 'user' ? '用户消息操作' : 'AI 回复操作'" @pointerdown.capture="actionPointerStarted = true" @click.capture="actionClick" @contextmenu.prevent>
        <button v-if="retryable" type="button" role="menuitem" tabindex="-1" class="message-action-option" :disabled="retryDisabled" @click="choose('retry')"><RotateCcw :size="17" /><span>{{ retryLabel || '重试' }}</span></button>
        <button v-if="forkable" type="button" role="menuitem" tabindex="-1" class="message-action-option" @click="choose('fork')"><GitFork :size="17" /><span>从这里分叉</span></button>
        <button type="button" role="menuitem" tabindex="-1" class="message-action-option" :disabled="!copyText" @click="choose('copy')"><Copy :size="17" /><span>{{ role === 'user' ? '复制消息' : '复制最终回答' }}</span></button>
        <p v-if="retryable && retryDisabled">当前任务结束后可重试</p>
        <p v-if="role === 'agent' && !copyText">最终回答生成后可复制</p>
      </section>
    </Teleport>
  </article>
</template>
