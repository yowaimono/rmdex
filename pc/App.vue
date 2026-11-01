<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { AlertTriangle, Check, CircleStop, Clipboard, LoaderCircle, LogIn, Monitor, Power, RefreshCw, Server, Settings2, X } from 'lucide-vue-next'
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

const status = ref<PcStatus | null>(null)
const error = ref('')
const sessionError = ref('')
const sessionReady = ref(false)
const needsLogin = ref(false)
const formError = ref('')
const busy = ref(false)
const accountName = ref('')
const accountPassword = ref('')
const deviceName = ref('')
const showControls = ref(false)
const logs = ref<{ agent: string; desktop: string } | null>(null)
const copied = ref(false)
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

async function enroll() {
  busy.value = true
  formError.value = ''
  error.value = ''
  try {
    status.value = await request<PcStatus>('/pc-api/enroll', { method: 'POST', body: JSON.stringify({ username: accountName.value, password: accountPassword.value, deviceName: deviceName.value }) })
    accountPassword.value = ''
    needsLogin.value = false
  } catch (caught) {
    formError.value = caught instanceof Error ? caught.message : String(caught)
    await refresh(false)
  } finally { busy.value = false }
}

async function relogin() {
  busy.value = true
  formError.value = ''
  error.value = ''
  try {
    status.value = await request<PcStatus>('/pc-api/relogin', { method: 'POST', body: JSON.stringify({ username: accountName.value, password: accountPassword.value }) })
    accountPassword.value = ''
    needsLogin.value = false
    await bootstrapClientSession()
  } catch (caught) {
    formError.value = caught instanceof Error ? caught.message : String(caught)
    await refresh(false)
  } finally { busy.value = false }
}

async function submitConnection() {
  if (needsLogin.value) return relogin()
  return enroll()
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
  void bootstrapClientSession()
}, { immediate: true })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <main v-if="!status" class="pc-boot-screen" role="status">
    <LoaderCircle :size="26" class="pc-spin" />
    <span>正在准备 rmdex PC…</span>
  </main>

  <main v-else-if="!status.enrolled || needsLogin" class="pc-connect-screen">
    <section class="pc-connect-panel">
      <div class="pc-connect-brand"><span class="pc-brand-mark">r</span><div><strong>rmdex PC</strong><span>桌面版 Codex 工作区</span></div></div>
      <div class="pc-connect-content">
        <div class="pc-connect-intro"><span class="pc-kicker">{{ needsLogin ? '会话已失效' : '首次连接' }}</span><h1>{{ needsLogin ? '重新连接这台电脑' : '连接这台电脑' }}</h1><p>{{ needsLogin ? '这台电脑的登录凭证已失效。重新登录会保留原有设备、员工和本地数据，不会创建重复设备。' : '登录 rmdex 账号后，这台电脑会启动本地 agent，并在桌面端打开完整对话工作区。' }}</p><div class="pc-feature-list"><span><Server :size="16" />本机执行与文件访问</span><span><LogIn :size="16" />与 Web、Android 共用会话</span></div></div>
        <form class="pc-connect-form" @submit.prevent="submitConnection">
          <label for="pc-account">账号</label><input id="pc-account" v-model="accountName" autocomplete="username" required placeholder="输入账号" />
          <label for="pc-password">密码</label><input id="pc-password" v-model="accountPassword" type="password" autocomplete="current-password" required placeholder="输入密码" />
          <template v-if="!needsLogin"><label for="pc-name">电脑名称</label><input id="pc-name" v-model="deviceName" maxlength="80" required placeholder="例如：办公室电脑" /></template>
          <p v-if="formError || (needsLogin && sessionError)" class="pc-form-error"><AlertTriangle :size="15" />{{ formError || sessionError }}</p>
          <button class="pc-primary-button" type="submit" :disabled="busy"><LoaderCircle v-if="busy" :size="16" class="pc-spin" />{{ busy ? '正在连接…' : needsLogin ? '重新登录并继续' : '登录并启动' }}</button>
          <small>{{ needsLogin ? '只更新这台电脑的登录会话，不会创建新的设备。' : '账号密码只用于注册设备，不会保存在本机。' }}</small>
        </form>
      </div>
    </section>
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
      <section class="pc-control-section"><h2><Settings2 :size="15" />默认审批模式</h2><div class="pc-mode-options"><button v-for="mode in (['ask', 'auto', 'full'] as PermissionMode[])" :key="mode" type="button" :class="{ selected: status.permissionMode === mode }" :disabled="busy" @click="setPermissionMode(mode)"><span>{{ mode === 'ask' ? '请求审批' : mode === 'auto' ? '自动审批' : '完全访问' }}</span><Check v-if="status.permissionMode === mode" :size="15" /></button></div></section>
      <section class="pc-control-section pc-control-logs"><div><h2>运行日志</h2><button type="button" @click="loadLogs"><RefreshCw :size="14" />读取</button></div><pre>{{ logs ? `Agent\n${logs.agent}\n\nDesktop launcher\n${logs.desktop}` : '尚未读取日志' }}</pre><button v-if="logs" class="pc-copy-logs" type="button" @click="copyLogs"><Clipboard :size="14" />{{ copied ? '已复制' : '复制日志' }}</button></section>
    </aside>
  </div>
</template>
