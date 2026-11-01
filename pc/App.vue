<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { AlertTriangle, CircleStop, Clipboard, LoaderCircle, Monitor, Power, RefreshCw, Server, Settings2, Smartphone, X } from 'lucide-vue-next'
import ChatApp from '../src/App.vue'

type PermissionMode = 'ask' | 'auto' | 'full'
type PcStatus = {
  enrolled: boolean
  phase: 'stopped' | 'starting' | 'running' | 'error'
  permissionMode: PermissionMode
  codexDesktop: { state: string; pid?: number }
  appServer: { connectionState?: string; connectionError?: string; agentPort?: number }
  relay: { state: string; deviceName?: string; error?: string }
  error?: string
}
type PcClientSession = {
  accessToken: string
  refreshToken: string
  device: { id: string; name: string; online: boolean }
}
type PeerPhone = {
  id: string
  name: string
  model?: string
  platform?: string
  online: boolean
  lastSeenAt?: number
}

const status = ref<PcStatus | null>(null)
const error = ref('')
const sessionError = ref('')
const sessionReady = ref(false)
const needsLogin = ref(false)
const busy = ref(false)
const pcLoginInProgress = ref(false)
const deviceName = ref(localStorage.getItem('rmdex-pc-device-name') || 'Codex 电脑')
const showControls = ref(false)
const logs = ref<{ agent: string; desktop: string } | null>(null)
const copied = ref(false)
const phones = ref<PeerPhone[]>([])
const peersLoading = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

const chatReady = computed(() => status.value?.enrolled && status.value.phase === 'running')
const phaseLabel = computed(() => ({ stopped: '未启动', starting: '启动中', running: '运行中', error: '需要处理' }[status.value?.phase || 'stopped']))
let sessionRequest: Promise<void> | undefined

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } })
  const data = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`)
  return data
}

async function refresh(autoStart = true) {
  try {
    const next = await request<PcStatus>('/pc-api/status')
    status.value = next
    error.value = next.error || next.relay.error || ''
    if (autoStart && next.enrolled && next.phase === 'stopped' && !busy.value) {
      busy.value = true
      try {
        status.value = await request<PcStatus>('/pc-api/start', { method: 'POST', body: '{}' })
        error.value = status.value.error || ''
      } finally { busy.value = false }
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  }
}

async function bootstrapClientSession() {
  if (!chatReady.value || sessionRequest) return sessionRequest
  sessionError.value = ''
  const requestPromise = (async () => {
    try {
      const session = await request<PcClientSession>('/pc-api/session')
      localStorage.setItem('rmdex-client-token', session.accessToken)
      localStorage.setItem('rmdex-client-access-token', session.accessToken)
      localStorage.setItem('rmdex-client-refresh-token', session.refreshToken)
      needsLogin.value = false
      sessionReady.value = true
      void loadPeers()
    } catch (caught) {
      sessionReady.value = false
      sessionError.value = caught instanceof Error ? caught.message : String(caught)
      needsLogin.value = /重新登录|登录态已过期|登录态不存在|重新配对/.test(sessionError.value)
    } finally {
      sessionRequest = undefined
    }
  })()
  sessionRequest = requestPromise
  return requestPromise
}

async function loadPeers() {
  const token = localStorage.getItem('rmdex-client-access-token') || localStorage.getItem('rmdex-client-token') || ''
  if (!token) return
  peersLoading.value = true
  try {
    const result = await request<{ phones?: PeerPhone[] }>('/api/client/peers', { headers: { Authorization: `Bearer ${token}` } })
    phones.value = result.phones || []
  } catch {
    // Keep the last successful list visible while the PC service or relay reconnects.
  } finally {
    peersLoading.value = false
  }
}

async function completePcLogin(username: string, password: string, name: string): Promise<PcClientSession> {
  pcLoginInProgress.value = true
  busy.value = true
  error.value = ''
  try {
    const enrolling = !status.value?.enrolled
    const path = enrolling ? '/pc-api/enroll' : '/pc-api/relogin'
    const payload = enrolling ? { username, password, deviceName: name.trim() } : { username, password }
    status.value = await request<PcStatus>(path, { method: 'POST', body: JSON.stringify(payload) })
    needsLogin.value = true
    deviceName.value = name.trim()
    localStorage.setItem('rmdex-pc-device-name', deviceName.value)
    sessionError.value = ''
    return await request<PcClientSession>('/pc-api/session')
  } catch (caught) {
    pcLoginInProgress.value = false
    throw caught
  } finally { busy.value = false }
}

function onPcAuthenticated() {
  pcLoginInProgress.value = false
  needsLogin.value = false
  sessionReady.value = true
}

async function restart() {
  busy.value = true
  error.value = ''
  try { status.value = await request<PcStatus>('/pc-api/restart', { method: 'POST', body: '{}' }) }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); await refresh(false) }
  finally { busy.value = false }
}

async function control(path: 'start' | 'stop' | 'restart') {
  busy.value = true
  error.value = ''
  try { status.value = await request<PcStatus>(`/pc-api/${path}`, { method: 'POST', body: '{}' }) }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); await refresh(false) }
  finally { busy.value = false }
}

async function setPermissionMode(mode: PermissionMode) {
  if (status.value?.permissionMode === mode) return
  busy.value = true
  error.value = ''
  try { status.value = await request<PcStatus>('/pc-api/settings', { method: 'POST', body: JSON.stringify({ permissionMode: mode }) }) }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught) }
  finally { busy.value = false }
}

async function loadLogs() {
  try { logs.value = await request('/pc-api/logs') }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught) }
}

async function copyLogs() {
  if (!logs.value) return
  await navigator.clipboard.writeText(`Agent\n${logs.value.agent}\n\nDesktop launcher\n${logs.value.desktop}`)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1600)
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => { if (!chatReady.value) void refresh() }, 4000)
})
watch(chatReady, ready => {
  if (!ready) { sessionReady.value = false; return }
  if (pcLoginInProgress.value || needsLogin.value) return
  void bootstrapClientSession()
}, { immediate: true })
onUnmounted(() => { if (timer) clearInterval(timer) })
watch(showControls, opened => { if (opened) void loadPeers() })
</script>

<template>
  <main v-if="!status" class="pc-boot-screen" role="status">
    <LoaderCircle :size="26" class="pc-spin" />
    <span>正在准备 rmdex PC…</span>
  </main>

  <main v-else-if="!status.enrolled || needsLogin" class="pc-login-shell">
    <ChatApp :pc-login="completePcLogin" :pc-device-name="deviceName" @pc-authenticated="onPcAuthenticated" />
  </main>

  <main v-else-if="!chatReady || !sessionReady" class="pc-boot-screen pc-error-screen" role="status">
    <AlertTriangle :size="26" />
    <strong>{{ !chatReady ? (status.phase === 'starting' ? '正在启动本机服务…' : '本机服务暂未就绪') : '正在连接 rmdex 账号…' }}</strong>
    <span>{{ sessionError || error || status.appServer.connectionError || `当前状态：${phaseLabel}` }}</span>
    <div class="pc-boot-actions"><button class="pc-secondary-button" :disabled="busy" @click="chatReady ? bootstrapClientSession() : refresh(false)"><RefreshCw :size="15" />{{ chatReady ? '重试连接' : '刷新状态' }}</button><button class="pc-primary-button" :disabled="busy" @click="restart"><RefreshCw :size="15" />重启服务</button></div>
  </main>

  <div v-else class="pc-chat-shell">
    <ChatApp />
    <button class="pc-control-trigger" type="button" title="本机控制" aria-label="本机控制" :aria-expanded="showControls" @click="showControls = !showControls"><Settings2 :size="17" /></button>
    <aside v-if="showControls" class="pc-control-panel" aria-label="本机控制面板">
      <header><div><span>rmdex PC</span><strong>本机控制</strong></div><button type="button" title="关闭" aria-label="关闭本机控制" @click="showControls = false"><X :size="17" /></button></header>
      <p v-if="error" class="pc-control-error" role="alert"><AlertTriangle :size="15" />{{ error }}</p>
      <section class="pc-control-section"><h2>服务状态</h2><div class="pc-control-status"><span><i :class="{ online: status.phase === 'running' }"></i>rmdex agent</span><strong>{{ phaseLabel }}</strong></div><div class="pc-control-status"><span><Monitor :size="15" />Codex Desktop</span><strong>{{ status.codexDesktop.state === 'running' ? '运行中' : status.codexDesktop.state === 'starting' ? '启动中' : '已停止' }}</strong></div><div class="pc-control-status"><span><Server :size="15" />共享 app-server</span><strong>{{ status.appServer.connectionState === 'ready' ? '已连接' : status.appServer.connectionState || '未知' }}</strong></div><div class="pc-control-actions"><button type="button" :disabled="busy || status.phase === 'running'" @click="control('start')"><Power :size="14" />启动</button><button type="button" :disabled="busy || status.phase !== 'running'" @click="control('restart')"><RefreshCw :size="14" />重启</button><button type="button" :disabled="busy || status.phase !== 'running'" @click="control('stop')"><CircleStop :size="14" />暂停</button></div></section>
      <section class="pc-control-section"><h2><Settings2 :size="15" />默认审批模式</h2><select class="pc-permission-select" :value="status.permissionMode" :disabled="busy" aria-label="默认审批模式" @change="setPermissionMode(($event.target as HTMLSelectElement).value as PermissionMode)"><option value="ask">请求审批</option><option value="auto">自动审批</option><option value="full">完全访问</option></select></section>
      <section class="pc-control-section pc-mobile-devices"><div class="pc-section-heading"><h2><Smartphone :size="15" />已连接的手机</h2><button type="button" :disabled="peersLoading" @click="loadPeers"><RefreshCw :size="14" :class="{ 'pc-spin': peersLoading }" />刷新</button></div><div v-if="peersLoading && !phones.length" class="pc-peer-state">正在读取…</div><div v-else-if="!phones.length" class="pc-peer-state">暂无已连接手机</div><div v-else class="pc-peer-list"><div v-for="phone in phones" :key="phone.id" class="pc-peer-row"><Smartphone :size="15" /><div><strong>{{ phone.name }}</strong><small>{{ phone.online ? '在线' : '离线' }}</small></div><i :class="{ online: phone.online }"></i></div></div></section>
      <section class="pc-control-section pc-control-logs"><div><h2>运行日志</h2><button type="button" @click="loadLogs"><RefreshCw :size="14" />读取</button></div><pre>{{ logs ? `Agent\n${logs.agent}\n\nDesktop launcher\n${logs.desktop}` : '尚未读取日志' }}</pre><button v-if="logs" class="pc-copy-logs" type="button" @click="copyLogs"><Clipboard :size="14" />{{ copied ? '已复制' : '复制日志' }}</button></section>
    </aside>
  </div>
</template>
