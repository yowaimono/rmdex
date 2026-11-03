<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { AlertCircle, LoaderCircle, Pause, Volume2 } from 'lucide-vue-next'

const props = defineProps<{ load: () => Promise<Blob>; seconds: number }>()
const audio = ref<HTMLAudioElement | null>(null)
const loading = ref(false), playing = ref(false), played = ref(false), error = ref(''), duration = ref(props.seconds)
let url = '', disposed = false
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
onUnmounted(() => { disposed = true; audio.value?.pause(); if (url) URL.revokeObjectURL(url) })
</script>

<template>
  <div class="voice-message" :class="{ 'is-playing': playing, 'has-error': error }" @pointerdown.stop @click.stop @contextmenu.stop>
    <button type="button" class="voice-play" :disabled="loading" :aria-label="playing ? '暂停语音' : error ? '重试播放语音' : '播放语音'" :title="playing ? '暂停语音' : error ? '重试播放语音' : '播放语音'" @click="toggle"><LoaderCircle v-if="loading" :size="17" class="working-spinner"/><Pause v-else-if="playing" :size="17"/><Volume2 v-else :size="17"/></button>
    <span class="voice-time">{{ duration ? `${duration}″` : '语音' }}</span>
    <span v-if="!played && !error" class="voice-unread" aria-label="未播放" />
    <audio ref="audio" preload="none" @loadedmetadata="duration = Math.max(1, Math.ceil(audio?.duration || duration || 1))" @play="playing = true; played = true" @pause="playing = false" @ended="playing = false" @error="error = '语音播放失败，请重试'" />
    <span v-if="error" class="voice-error" role="alert" :title="error"><AlertCircle :size="14"/> {{ error }}</span>
  </div>
</template>
