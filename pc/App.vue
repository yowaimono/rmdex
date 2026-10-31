<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Activity, AlertTriangle, Check, CircleStop, ExternalLink, LoaderCircle, Monitor, Phone, Power, RefreshCw, Server, Settings2, Terminal, Wifi, WifiOff } from 'lucide-vue-next'

type PermissionMode = 'ask' | 'auto' | 'full'
type Status = {
  enrolled: boolean
  phase: 'stopped' | 'starting' | 'running' | 'error'
  permissionMode: PermissionMode
  codexDesktop: { state: string; pid?: number }
  appServer: { state: string; socketPath: string; agentPort: number; pid?: number }
  relay: { state: string; deviceName?: string; error?: string }
  phones: Array<{ name: string; online: boolean; lastSeenAt?: number }>
  error?: string
  logs: { agent: string; desktop: string }
}

const status = ref<Status | null>(null)
const error = ref('')
const busy = ref(false)
const accountName = ref('')
const accountPassword = ref('')
const deviceName = ref('')
const showLogs = ref(false)
const logs = ref<{ agent: string; desktop: string } | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

const phaseLabel = computed(() => ({ stopped: '已停止', starting: '启动中', running: '运行中', error: '需要处理' }[status.value?.phase || 'stopped']))
const phaseClass = computed(() => status.value?.phase || 'stopped')
const isRunning = computed(() => status.value?.phase === 'running' || status.value?.phase === 'starting')
const modeLabel = (mode: PermissionMode) => ({ ask: '请求审批', auto: '自动审批', full: '完全访问' }[mode])

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } })
  const data = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`)
  return data
}

async function refresh() {
  try { status.value = await request<Status>('/pc-api/status'); error.value = '' } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught) }
}

async function action(path: string) {
  busy.value = true
  try { status.value = await request<Status>(path, { method: 'POST', body: '{}' }); error.value = '' } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); await refresh() } finally { busy.value = false }
}

async function setMode(mode: PermissionMode) {
  if (!status.value || status.value.permissionMode === mode) return
  busy.value = true
  try { status.value = await request<Status>('/pc-api/settings', { method: 'POST', body: JSON.stringify({ permissionMode: mode }) }); error.value = '' } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught) } finally { busy.value = false }
}

async function enroll() {
  busy.value = true
  error.value = ''
  try {
    status.value = await request<Status>('/pc-api/enroll', { method: 'POST', body: JSON.stringify({ username: accountName.value, password: accountPassword.value, deviceName: deviceName.value }) })
    accountPassword.value = ''
  } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); await refresh() }
  finally { busy.value = false }
}

async function loadLogs() {
  try { logs.value = await request('/pc-api/logs'); showLogs.value = true } catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught) }
}

function stateText(value: string) { return ({ running: '在线', starting: '启动中', stopped: '离线', error: '异常', unknown: '未知', offline: '离线' }[value] || value) }
function stateIcon(value: string) { return value === 'running' || value === 'online' ? Check : value === 'starting' ? LoaderCircle : value === 'error' ? AlertTriangle : WifiOff }
function lastSeen(value?: number) { return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '尚未连接' }

onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 5000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark">r</div><div><strong>rmdex PC</strong><span>Shared Codex control plane</span></div></div>
      <div class="top-actions"><span class="phase" :class="phaseClass"><i></i>{{ phaseLabel }}</span><button class="icon-button" title="刷新状态" aria-label="刷新状态" :disabled="busy" @click="refresh"><RefreshCw :size="16" /></button></div>
    </header>

    <section class="hero">
      <div><p class="eyebrow">本机控制台</p><h1>Codex Desktop <span>共享运行状态</span></h1><p class="subtitle">一个 app-server，连接 PC、Server 和手机端。暂停或重启时会清理残留的 Codex app-server 进程。</p></div>
      <div class="hero-actions"><button class="primary" :disabled="busy || isRunning || !status?.enrolled" @click="action('/pc-api/start')"><Power :size="16" />启动组件</button><button class="secondary" :disabled="busy || !isRunning" @click="action('/pc-api/restart')"><RefreshCw :size="16" />重启</button><button class="danger" :disabled="busy || !isRunning" @click="action('/pc-api/stop')"><CircleStop :size="16" />暂停组件</button></div>
    </section>

    <p v-if="error || status?.error" class="error-banner"><AlertTriangle :size="17" />{{ error || status?.error }}</p>

    <section v-if="status && !status.enrolled" class="enroll-panel">
      <div><p class="eyebrow">连接 Rmdex</p><h2>连接你的 Rmdex 账号</h2><p class="subtitle">使用用户账号登录。这台电脑会注册到该账号，并将设备凭证保存在本机。</p></div>
      <form class="enroll-form" @submit.prevent="enroll"><label for="user-account">用户账号</label><input id="user-account" v-model="accountName" autocomplete="username" required placeholder="账号" /><label for="user-password">密码</label><input id="user-password" v-model="accountPassword" type="password" autocomplete="current-password" required placeholder="密码" /><label for="pc-device-name">电脑名称</label><input id="pc-device-name" v-model="deviceName" maxlength="80" required placeholder="例如：办公室电脑" /><button class="primary" type="submit" :disabled="busy"><LoaderCircle v-if="busy" :size="16" class="spin" />{{ busy ? '正在注册并启动…' : '连接账号并启动' }}</button></form>
    </section>

    <section v-if="status?.enrolled" class="status-grid">
      <article class="status-card"><div class="card-icon blue"><Monitor :size="18" /></div><div><span class="label">Codex Desktop</span><strong>{{ stateText(status?.codexDesktop.state || 'stopped') }}</strong><small v-if="status?.codexDesktop.pid">PID {{ status.codexDesktop.pid }}</small></div><component :is="stateIcon(status?.codexDesktop.state || 'stopped')" :size="17" class="state-icon" :class="status?.codexDesktop.state" /></article>
      <article class="status-card"><div class="card-icon green"><Server :size="18" /></div><div><span class="label">Shared app-server</span><strong>{{ stateText(status?.appServer.state || 'stopped') }}</strong><small>端口 {{ status?.appServer.agentPort || 18787 }}</small></div><component :is="stateIcon(status?.appServer.state || 'stopped')" :size="17" class="state-icon" :class="status?.appServer.state" /></article>
      <article class="status-card"><div class="card-icon violet"><Wifi :size="18" /></div><div><span class="label">Server API</span><strong>{{ stateText(status?.relay.state || 'unknown') }}</strong><small>{{ status?.relay.deviceName || '未配置客户端凭据' }}</small></div><component :is="stateIcon(status?.relay.state || 'unknown')" :size="17" class="state-icon" :class="status?.relay.state" /></article>
    </section>

    <section v-if="status?.enrolled" class="content-grid">
      <article class="panel permission-panel"><div class="panel-heading"><div><p class="eyebrow">安全策略</p><h2>审批权限</h2></div><Settings2 :size="19" class="muted" /></div><p class="panel-copy">设置 rmdex 从 PC 发起新任务时使用的默认审批模式。Desktop 与 Android 通过同一 shared app-server 协作。</p><div class="mode-list"><button v-for="mode in (['ask', 'auto', 'full'] as PermissionMode[])" :key="mode" class="mode-option" :class="{ selected: status?.permissionMode === mode }" :disabled="busy" @click="setMode(mode)"><span class="mode-radio"></span><span><strong>{{ modeLabel(mode) }}</strong><small>{{ mode === 'ask' ? '命令和文件变更逐次确认' : mode === 'auto' ? '允许自动审核安全操作' : '关闭审批并允许完全访问' }}</small></span></button></div><div class="policy-note"><Activity :size="15" /><span>当前模式：<strong>{{ modeLabel(status?.permissionMode || 'ask') }}</strong></span></div></article>

      <article class="panel devices-panel"><div class="panel-heading"><div><p class="eyebrow">设备</p><h2>已配对客户端</h2></div><span class="count">{{ status?.phones.length || 0 }}</span></div><div v-if="status?.phones.length" class="phone-list"><div v-for="phone in status.phones" :key="phone.name + phone.lastSeenAt" class="phone-row"><div class="phone-icon"><Phone :size="16" /></div><div><strong>{{ phone.name }}</strong><small>{{ phone.online ? '最近活动 ' + lastSeen(phone.lastSeenAt) : '未活跃 · 最近 ' + lastSeen(phone.lastSeenAt) }}</small></div><span class="online-dot" :class="{ offline: !phone.online }"></span></div></div><div v-else class="empty"><Phone :size="21" /><span>暂时没有已配对客户端</span><small>在 Web 端设备面板生成配对码后，用 Android App 扫码连接。</small></div></article>
    </section>

    <section v-if="status?.enrolled" class="footer-panel"><div><div class="footer-title"><Terminal :size="16" />诊断信息</div><p>本地 agent 只监听回环地址，PC 通过出站 WSS 连接 Server。</p><div class="paths"><code>{{ status?.logs.agent || 'work/pc-agent.stderr.log' }}</code><code>{{ status?.logs.desktop || 'work/pc-desktop.log' }}</code></div></div><button class="secondary" @click="loadLogs"><ExternalLink :size="15" />查看最近日志</button></section>

    <div v-if="showLogs" class="modal-backdrop" @click.self="showLogs = false"><section class="logs-modal"><header><div><p class="eyebrow">最近 80 行</p><h2>运行日志</h2></div><button class="icon-button" title="关闭" aria-label="关闭" @click="showLogs = false">×</button></header><h3>Agent</h3><pre>{{ logs?.agent || '暂无 stderr 输出' }}</pre><h3>Desktop launcher</h3><pre>{{ logs?.desktop || '暂无 launcher 输出' }}</pre></section></div>
  </main>
</template>
