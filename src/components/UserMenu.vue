<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Check, ChevronDown, UserRound } from 'lucide-vue-next'

type User = { id: string; username: string; deviceCount?: number }
const props = defineProps<{ modelValue: string; users: User[]; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const focused = ref(0)
const selected = computed(() => props.users.find(user => user.id === props.modelValue) || props.users[0])

function focusOption(index: number) {
  focused.value = Math.max(0, Math.min(index, props.users.length - 1))
  nextTick(() => root.value?.querySelectorAll<HTMLButtonElement>('[role="option"]')[focused.value]?.focus())
}
function show() {
  if (props.disabled || !props.users.length) return
  open.value = true
  focusOption(Math.max(0, props.users.findIndex(user => user.id === props.modelValue)))
}
function close(restoreFocus = false) {
  open.value = false
  if (restoreFocus) nextTick(() => trigger.value?.focus())
}
function choose(id: string) { emit('update:modelValue', id); close(true) }
function outside(event: PointerEvent) { if (!root.value?.contains(event.target as Node)) close() }
function onKey(event: KeyboardEvent) {
  if (!open.value) return
  if (event.key === 'Escape') { event.preventDefault(); close(true) }
  else if (event.key === 'ArrowDown') { event.preventDefault(); focusOption(focused.value + 1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); focusOption(focused.value - 1) }
  else if (event.key === 'Home') { event.preventDefault(); focusOption(0) }
  else if (event.key === 'End') { event.preventDefault(); focusOption(props.users.length - 1) }
  else if (event.key === 'Tab') close()
}
watch(() => props.disabled, disabled => { if (disabled) close() })
onMounted(() => document.addEventListener('pointerdown', outside))
onUnmounted(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <div ref="root" class="user-menu" @keydown="onKey">
    <button ref="trigger" type="button" class="user-menu-trigger" :class="{ 'is-open': open }" :disabled="disabled || !users.length" aria-haspopup="listbox" :aria-expanded="open" @click="open ? close() : show()" @keydown.down.prevent="show" @keydown.up.prevent="show">
      <UserRound :size="16" class="user-menu-trigger-icon" /><span class="user-menu-trigger-copy"><strong>{{ selected?.username || '选择用户' }}</strong><small v-if="selected">{{ selected.deviceCount ?? 0 }} 台电脑</small></span><ChevronDown :size="16" class="user-menu-chevron" />
    </button>
    <div v-if="open" class="user-menu-popup" role="listbox" aria-label="选择设备所属用户">
      <button v-for="(user, index) in users" :key="user.id" type="button" role="option" :aria-selected="modelValue === user.id" :tabindex="focused === index ? 0 : -1" class="user-menu-option" :class="{ 'is-selected': modelValue === user.id }" @focus="focused = index" @click="choose(user.id)"><UserRound :size="15" class="user-menu-option-icon" /><span><strong>{{ user.username }}</strong><small>{{ user.deviceCount ?? 0 }} 台电脑</small></span><Check v-if="modelValue === user.id" :size="15" class="user-menu-check" /></button>
    </div>
  </div>
</template>

<style scoped>
.user-menu { position: relative; width: 100%; }
.user-menu-trigger { width: 100%; min-height: 43px; display: flex; align-items: center; gap: 9px; padding: 7px 11px; border: 1px solid #dce4ed; border-radius: 6px; color: #263545; background: #fff; text-align: left; }
.user-menu-trigger:hover, .user-menu-trigger.is-open, .user-menu-trigger:focus-visible { border-color: #8dbcf0; outline: 0; box-shadow: 0 0 0 2px rgba(8, 121, 249, .1); }
.user-menu-trigger-icon, .user-menu-chevron { flex: none; color: #7d8d9d; }
.user-menu-trigger-copy, .user-menu-option span { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.user-menu-trigger-copy strong, .user-menu-option strong { overflow: hidden; color: #34485a; font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.user-menu-trigger-copy small, .user-menu-option small { color: #98a5b2; font-size: 10px; }
.user-menu-popup { position: absolute; z-index: 5; top: calc(100% + 5px); left: 0; right: 0; max-height: 240px; overflow-y: auto; padding: 5px; border: 1px solid #dce4ed; border-radius: 7px; background: #fff; box-shadow: 0 10px 28px rgba(35, 53, 75, .16); }
.user-menu-option { width: 100%; display: flex; align-items: center; gap: 9px; min-height: 42px; padding: 8px; border: 0; border-radius: 5px; color: #34485a; background: transparent; text-align: left; }
.user-menu-option:hover, .user-menu-option:focus-visible, .user-menu-option.is-selected { outline: 0; background: #edf5ff; }
.user-menu-option-icon, .user-menu-check { flex: none; color: #7d91a3; }
.user-menu-option.is-selected .user-menu-option-icon, .user-menu-check { color: #0879f9; }
</style>
