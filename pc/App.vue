<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Activity, AlertTriangle, Check, ChevronRight, CircleStop, Clipboard, FileText, Laptop, LoaderCircle, Monitor, Network, Phone, Power, RefreshCw, Server, Settings2, ShieldCheck, Terminal, WifiOff, X } from 'lucide-vue-next'

type PermissionMode = 'ask' | 'auto' | 'full'
type View = 'overview' | 'permissions' | 'devices' | 'diagnostics'
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
const formError = ref('')
const busy = ref(false)
const accountName = ref('')
const accountPassword = ref('')
const deviceName = ref('')
const activeView = ref<View>('overview')
const showLogs = ref(false)
const logs = ref<{ agent: string; desktop: string } | null>(null)
const copiedLog = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

const phaseLabel = computed(() => ({ stopped: '已停止', starting: '启动中', running: '运行中', error: '需要处理' }[status.value?.phase || 'stopped']))
const phaseClass = computed(() => status.value?.phase || 'stopped')
const isRunning = computed(() => status.value?.phase === 'running' || status.value?.phase === 'starting')
const needsEnrollment = computed(() => Boolean(status.value && (!status.value.enrolled || status.value.relay.error?.includes('撤销'))))
const relayLabel = computed(() => {
  if (status.value?.relay.state === 'online') return '已连接'
  if (status.value?.relay.error?.includes('撤销')) return '需要重新连接'
  if (status.value?.relay.state === 'offline') return '离线'
  return '未连接'
})
const viewMeta = computed(() => ({
  overview: { label: '概览', title: '运行状态', description: '查看本机组件与 rmdex 服务的连接状态。' },
  permissions: { label: '权限', title: '审批权限', description: '配置从这台电脑发起任务时使用的默认权限模式。' },
  devices: { label: '关联设备', title: '关联设备', description: '查看已配对的移动端设备。' },
  diagnostics: { label: '诊断', title: '诊断信息', description: '查看本地 agent 和 Desktop launcher 的运行日志。' },
}[activeView.value]))
const navItems: Array<{ id: View; label: string; icon: typeof Activity }> = [
  { id: 'overview', label: '概览', icon: Activity },
  { id: 'permissions', label: '权限', icon: ShieldCheck },
  { id: 'devices', label: '关联设备', icon: Phone },
  { id: 'diagnostics', label: '诊断', icon: FileText },
]

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } })
  const data = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`)
  return data
}
async function refresh() {
  try { status.value = await request<Status>('/pc-api/status'); error.value = status.value.relay.error?.includes('撤销') ? status.value.relay.error : '' }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught) }
}
async function action(path: string) {
  busy.value = true; error.value = ''
  try { status.value = await request<Status>(path, { method: 'POST', body: '{}' }) }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught); await refresh() }
  finally { busy.value = false }
}
async function setMode(mode: PermissionMode) {
  if (!status.value || status.value.permissionMode === mode) return
  busy.value = true; error.value = ''
  try { status.value = await request<Status>('/pc-api/settings', { method: 'POST', body: JSON.stringify({ permissionMode: mode }) }) }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught) }
  finally { busy.value = false }
}
async function enroll() {
  busy.value = true; formError.value = ''; error.value = ''
  try { status.value = await request<Status>('/pc-api/enroll', { method: 'POST', body: JSON.stringify({ username: accountName.value, password: accountPassword.value, deviceName: deviceName.value }) }); accountPassword.value = '' }
  catch (caught) { formError.value = caught instanceof Error ? caught.message : String(caught); await refresh() }
  finally { busy.value = false }
}
async function loadLogs(open = true) {
  try { logs.value = await request('/pc-api/logs'); if (open) showLogs.value = true }
  catch (caught) { error.value = caught instanceof Error ? caught.message : String(caught) }
}
async function copyLogs() {
  if (!logs.value) return
  await navigator.clipboard?.writeText(`Agent\n${logs.value.agent}\n\nDesktop launcher\n${logs.value.desktop}`)
  copiedLog.value = true; setTimeout(() => { copiedLog.value = false }, 1600)
}
function stateText(value: string) { return ({ running: '运行中', starting: '启动中', stopped: '已停止', error: '异常', unknown: '未知', offline: '离线', online: '在线' }[value] || value) }
function stateIcon(value: string) { return value === 'running' || value === 'online' ? Check : value === 'starting' ? LoaderCircle : value === 'error' ? AlertTriangle : WifiOff }
function lastSeen(value?: number) { return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '尚未连接' }
function selectView(view: View) { activeView.value = view; error.value = '' }
onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 5000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <main v-if="status && needsEnrollment" class="connect-shell">
    <section class="connect-panel">
      <div class="connect-brand"><div class="brand-mark">r</div><div><strong>rmdex PC</strong><span>连接本机到你的 rmdex 账号</span></div></div>
      <div class="connect-content">
        <div class="connect-intro"><span class="section-kicker">首次连接</span><h1>连接这台电脑</h1><p>登录你的 rmdex 账号，注册这台电脑并启动本地服务。</p><div class="connect-steps"><div class="connect-step active"><span>1</span><div><strong>登录账号</strong><small>验证你的 rmdex 账号</small></div></div><div class="connect-step"><span>2</span><div><strong>注册电脑</strong><small>将本机加入设备列表</small></div></div><div class="connect-step"><span>3</span><div><strong>启动服务</strong><small>开始连接 Codex Desktop</small></div></div></div></div>
        <form class="connect-form" @submit.prevent="enroll"><div class="form-heading"><h2>账号信息</h2><span>仅用于本次连接</span></div><label for="user-account">账号</label><input id="user-account" v-model="accountName" autocomplete="username" required placeholder="输入账号" /><label for="user-password">密码</label><input id="user-password" v-model="accountPassword" type="password" autocomplete="current-password" required placeholder="输入密码" /><label for="pc-device-name">电脑名称</label><input id="pc-device-name" v-model="deviceName" maxlength="80" required placeholder="例如：办公室电脑" /><p v-if="formError || error" class="form-error"><AlertTriangle :size="15" />{{ formError || error }}</p><button class="button primary wide" type="submit" :disabled="busy"><LoaderCircle v-if="busy" :size="16" class="spin" />{{ busy ? '正在连接…' : '登录并注册这台电脑' }}<ChevronRight v-if="!busy" :size="16" /></button><small class="form-note">注册完成后会自动启动本地 agent 和 Codex Desktop。</small></form>
      </div>
    </section>
  </main>

  <main v-else class="app-shell">
    <aside class="sidebar"><div class="sidebar-brand"><div class="brand-mark">r</div><div><strong>rmdex PC</strong><span>本机控制台</span></div></div><div class="device-summary"><div class="device-icon"><Laptop :size="17" /></div><div><strong>{{ status?.relay.deviceName || '本机设备' }}</strong><span><i :class="{ online: status?.relay.state === 'online' }"></i>{{ relayLabel }}</span></div></div><nav class="main-nav" aria-label="主导航"><span class="nav-label">工作台</span><button v-for="item in navItems" :key="item.id" class="nav-item" :class="{ active: activeView === item.id }" @click="selectView(item.id)"><component :is="item.icon" :size="17" /><span>{{ item.label }}</span><ChevronRight v-if="activeView === item.id" :size="14" /></button></nav><div class="sidebar-bottom"><div class="connection-line"><span class="status-dot" :class="phaseClass"></span><span>{{ phaseLabel }}</span></div><button class="refresh-link" :disabled="busy" @click="refresh"><RefreshCw :size="14" />刷新状态</button></div></aside>
    <section class="workspace"><header class="workspace-header"><div><span class="section-kicker">{{ viewMeta.label }}</span><h1>{{ viewMeta.title }}</h1><p>{{ viewMeta.description }}</p></div><div class="header-actions"><span class="runtime-chip" :class="phaseClass"><i></i>{{ phaseLabel }}</span><button class="icon-button" title="刷新状态" aria-label="刷新状态" :disabled="busy" @click="refresh"><RefreshCw :size="16" /></button></div></header><p v-if="error || status?.error" class="error-banner"><AlertTriangle :size="16" />{{ error || status?.error }}</p>

      <template v-if="activeView === 'overview'"><section class="overview-lead"><div><span class="section-kicker">本机运行环境</span><h2>{{ status?.relay.deviceName || 'rmdex PC' }}</h2><p>本机 agent 通过安全连接与 rmdex 服务通信，Codex Desktop 使用共享 app-server。</p></div><div class="lead-actions"><button class="button primary" :disabled="busy || isRunning" @click="action('/pc-api/start')"><Power :size="15" />启动组件</button><button class="button subtle" :disabled="busy || !isRunning" @click="action('/pc-api/restart')"><RefreshCw :size="15" />重启</button><button class="button danger" :disabled="busy || !isRunning" @click="action('/pc-api/stop')"><CircleStop :size="15" />暂停</button></div></section><section class="status-list"><div class="list-heading"><div><span class="section-kicker">组件状态</span><h2>运行中的服务</h2></div><span class="updated-label">自动刷新 · 5 秒</span></div><div class="status-row"><div class="row-icon blue"><Monitor :size="18" /></div><div class="row-main"><strong>Codex Desktop</strong><span>桌面执行环境</span></div><div class="row-value"><strong>{{ stateText(status?.codexDesktop.state || 'stopped') }}</strong><small v-if="status?.codexDesktop.pid">PID {{ status.codexDesktop.pid }}</small></div><component :is="stateIcon(status?.codexDesktop.state || 'stopped')" :size="17" class="row-state" :class="status?.codexDesktop.state" /></div><div class="status-row"><div class="row-icon green"><Server :size="18" /></div><div class="row-main"><strong>共享 app-server</strong><span>本地任务服务 · 端口 {{ status?.appServer.agentPort || 18787 }}</span></div><div class="row-value"><strong>{{ stateText(status?.appServer.state || 'stopped') }}</strong></div><component :is="stateIcon(status?.appServer.state || 'stopped')" :size="17" class="row-state" :class="status?.appServer.state" /></div><div class="status-row"><div class="row-icon violet"><Network :size="18" /></div><div class="row-main"><strong>rmdex 服务</strong><span>远程中继与账号服务</span></div><div class="row-value"><strong>{{ stateText(status?.relay.state || 'unknown') }}</strong><small>{{ status?.relay.deviceName || '未命名设备' }}</small></div><component :is="stateIcon(status?.relay.state || 'unknown')" :size="17" class="row-state" :class="status?.relay.state" /></div></section></template>

      <template v-else-if="activeView === 'permissions'"><section class="settings-section"><div class="settings-heading"><div class="setting-icon"><Settings2 :size="18" /></div><div><h2>默认审批模式</h2><p>决定 rmdex 从本机发起任务时如何处理命令和文件操作。</p></div></div><div class="option-list"><button v-for="mode in (['ask', 'auto', 'full'] as PermissionMode[])" :key="mode" class="option-row" :class="{ selected: status?.permissionMode === mode }" :disabled="busy" @click="setMode(mode)"><span class="radio"><i></i></span><span class="option-copy"><strong>{{ mode === 'ask' ? '请求审批' : mode === 'auto' ? '自动审批' : '完全访问' }}</strong><small>{{ mode === 'ask' ? '每次执行敏感操作前向你确认。' : mode === 'auto' ? '自动放行安全操作，必要时请求确认。' : '不请求审批，允许任务完整访问本机。' }}</small></span><Check v-if="status?.permissionMode === mode" :size="17" class="option-check" /></button></div><div class="current-setting"><Activity :size="15" /><span>当前设置：<strong>{{ status?.permissionMode === 'ask' ? '请求审批' : status?.permissionMode === 'auto' ? '自动审批' : '完全访问' }}</strong></span></div></section></template>

      <template v-else-if="activeView === 'devices'"><section class="devices-section"><div class="section-toolbar"><div><h2>已配对客户端</h2><p>连接到同一账号的移动端设备会显示在这里。</p></div><span class="count-badge">{{ status?.phones.length || 0 }}</span></div><div v-if="status?.phones.length" class="device-list"><div v-for="phone in status.phones" :key="phone.name + phone.lastSeenAt" class="device-row"><div class="device-icon"><Phone :size="17" /></div><div class="row-main"><strong>{{ phone.name }}</strong><span>{{ phone.online ? '最近活动 ' + lastSeen(phone.lastSeenAt) : '未活跃 · 最近 ' + lastSeen(phone.lastSeenAt) }}</span></div><span class="device-online" :class="{ offline: !phone.online }">{{ phone.online ? '在线' : '离线' }}</span></div></div><div v-else class="empty-state"><div class="empty-icon"><Phone :size="22" /></div><h3>还没有关联设备</h3><p>在 Web 端设备面板生成配对码后，用 Android App 扫描连接。</p></div></section></template>

      <template v-else><section class="diagnostics-section"><div class="section-toolbar"><div><h2>运行日志</h2><p>用于排查本地 agent 与 Desktop launcher 的启动问题。</p></div><button class="button subtle" :disabled="busy" @click="loadLogs(false)"><RefreshCw :size="15" />刷新日志</button></div><div class="log-block"><div class="log-heading"><div><Terminal :size="16" /><strong>Agent</strong></div><code>{{ status?.logs.agent }}</code></div><pre>{{ logs?.agent || '点击“刷新日志”读取最新输出。' }}</pre></div><div class="log-block"><div class="log-heading"><div><Terminal :size="16" /><strong>Desktop launcher</strong></div><code>{{ status?.logs.desktop }}</code></div><pre>{{ logs?.desktop || '点击“刷新日志”读取最新输出。' }}</pre></div><button class="text-button" @click="loadLogs(true)"><FileText :size="15" />在弹窗中查看完整日志</button></section></template>
    </section>
    <div v-if="showLogs" class="modal-backdrop" @click.self="showLogs = false"><section class="logs-modal"><header><div><span class="section-kicker">最近 80 行</span><h2>运行日志</h2></div><div class="modal-actions"><button class="icon-button" title="复制日志" aria-label="复制日志" @click="copyLogs"><Clipboard :size="16" /></button><button class="icon-button" title="关闭" aria-label="关闭" @click="showLogs = false"><X :size="16" /></button></div></header><p v-if="copiedLog" class="copy-feedback">日志已复制</p><h3>Agent</h3><pre>{{ logs?.agent || '暂无输出' }}</pre><h3>Desktop launcher</h3><pre>{{ logs?.desktop || '暂无输出' }}</pre></section></div>
  </main>
</template>
