<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { AlertCircle, LoaderCircle, Pause, Play, Volume2 } from 'lucide-vue-next'

const props = defineProps<{ load: () => Promise<Blob> }>()
const audio = ref<HTMLAudioElement | null>(null)
const loading = ref(false), playing = ref(false), error = ref(''), duration = ref(0), current = ref(0)
let url = '', disposed = false
function time(value: number) { const seconds = Math.floor(Number.isFinite(value) ? value : 0); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` }
async function toggle() {
  if (loading.value || !audio.value) return
  if (playing.value) { audio.value.pause(); return }
  loading.value = true; error.value = ''
  try {
    if (!url) {
      const blob = await props.load()
      if (disposed) return
      url = URL.createObjectURL(blob); audio.value!.src = url
    }
    await audio.value!.play()
  } catch (caught) { error.value = caught instanceof Error ? caught.message : '语音播放失败' }
  finally { loading.value = false }
}
function seek(event: Event) { if (audio.value) audio.value.currentTime = Number((event.target as HTMLInputElement).value) }
onUnmounted(() => { disposed = true; audio.value?.pause(); if (url) URL.revokeObjectURL(url) })
</script>

<template>
  <div class="voice-message" @pointerdown.stop @click.stop @contextmenu.stop>
    <button type="button" class="voice-play" :disabled="loading" :aria-label="playing ? '暂停语音' : error ? '重试播放语音' : '播放语音'" :title="playing ? '暂停语音' : error ? '重试播放语音' : '播放语音'" @click="toggle"><LoaderCircle v-if="loading" :size="17" class="working-spinner"/><Pause v-else-if="playing" :size="17"/><Play v-else :size="17"/></button>
    <Volume2 :size="15" class="voice-icon" />
    <input class="voice-seek" type="range" min="0" :max="duration || 1" step="0.1" :value="current" :disabled="!duration" aria-label="语音播放进度" @input="seek" />
    <span class="voice-time">{{ time(duration ? Math.max(0, duration-current) : 0) }}</span>
    <audio ref="audio" preload="none" @loadedmetadata="duration = audio?.duration || 0" @timeupdate="current = audio?.currentTime || 0" @play="playing = true" @pause="playing = false" @ended="playing = false" @error="error = '语音播放失败，请重试'" />
    <span v-if="error" class="voice-error" role="alert" :title="error"><AlertCircle :size="14"/> {{ error }}</span>
  </div>
</template>
