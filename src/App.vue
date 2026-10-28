<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import { ArrowLeft, ArrowUp, ChevronRight, CircleAlert, LoaderCircle, Menu, MessageSquare, Monitor, PanelLeftClose, Plus, RefreshCw, Search, Square, Wrench, X, QrCode, Copy, Smartphone, Trash2 } from 'lucide-vue-next'
import QRCode from 'qrcode'
import logoUrl from './assets/rmdex-logo.jpg'
import ToolEvent from './components/ToolEvent.vue'
import PermissionMenu from './components/PermissionMenu.vue'
import ModelMenu, { type ModelOption } from './components/ModelMenu.vue'
import { timeline, type ContentPart, type Turn } from './conversation'

type Thread = { id: string; name?: string | null; preview?: string; cwd?: string; updatedAt?: number; status?: { type: string }; turns?: Turn[] }
const threads = ref<Thread[]>([])
const selected = ref<Thread | null>(null)
const query = ref('')
const loading = ref(false)
const error = ref('')
const connected = ref(false)
const remoteDevice = ref<{ id: string; name: string; online: boolean } | null>(null)
const authenticatedImages = ref<Record<string, string>>({})
const imageLoads = new Map<string, Promise<string | undefined>>()
const showDevices = ref(false)
const adminPassword = ref('')
const adminToken = ref(sessionStorage.getItem('rmdex-admin-token') || '')
const clientToken = ref(localStorage.getItem('rmdex-client-token') || '')
const devices = ref<Array<{ id: string; name: string; online: boolean }>>([])
const newDeviceToken = ref('')
const pairCode = ref('')
const pairQr = ref('')
const pairUrl = ref('')
const pairError = ref('')
const deviceName = ref('Codex 电脑')
const pairInput = ref('')
const pairRequests = ref<Array<{ id: string; deviceId: string; name: string; createdAt: number }>>([])
const mobilePairing = ref(false)
const pairLanding = ref(false)
let selectionVersion = 0
const mobileDetail = ref(false)
const sidebarOpen = ref(true)
const creating = ref(false)
const showCreate = ref(false)
const createPath = ref('')
const createError = ref('')
const conversation = ref<HTMLElement | null>(null)
async function scrollToLatest() { await nextTick(); if (conversation.value) conversation.value.scrollTop = conversation.value.scrollHeight }
const drafts = ref<Record<string, string>>({})
const sending = ref(false)
const sendingThreadId = ref<string | null>(null)
const activeTurnId = ref<string | null>(null)
const pendingMessages = ref<Record<string, { text: string; previousCount: number }>>({})
const permissionMode = ref<'ask' | 'auto' | 'full'>('ask')
const models = ref<ModelOption[]>([])
const selectedModel = ref<string | null>(null)
const selectedEffort = ref<string | null>(null)
const modelLoading = ref(false)
const lastTurn = ref<{ status: string; error?: { message?: string } } | null>(null)
type Approval = { id: string; method: string; params: { command?: string; reason?: string; cwd?: string; grantRoot?: string } }
const pendingApprovals = ref<Approval[]>([])
let poll: ReturnType<typeof setInterval> | undefined
let pollBusy = false
type ReadResult = { thread: Thread; activeTurnId: string | null; approvals: Approval[]; lastTurn?: { status: string; error?: { message?: string } } | null }
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const defaultLink = markdown.renderer.rules.link_open || ((tokens, idx, options, _env, renderer) => renderer.renderToken(tokens, idx, options))
markdown.renderer.rules.link_open = (tokens, idx, options, env, renderer) => {
  tokens[idx]!.attrSet('target', '_blank')
  tokens[idx]!.attrSet('rel', 'noopener noreferrer')
  return defaultLink(tokens, idx, options, env, renderer)
}
const filtered = computed(() => threads.value.filter((t) => `${t.name || ''} ${t.preview || ''} ${t.cwd || ''}`.toLowerCase().includes(query.value.toLowerCase())))
const remoteMode = computed(() => !!clientToken.value || !['localhost', '127.0.0.1'].includes(location.hostname))
const messages = computed(() => timeline(selected.value?.turns || []))
const working = computed(() => !!activeTurnId.value || sendingThreadId.value === selected.value?.id)
const workLabel = computed(() => {
  if (pendingApprovals.value.length) return '等待审批'
  const turn = selected.value?.turns?.find(item => item.id === activeTurnId.value)
  const last = turn?.items?.[turn.items.length - 1]
  const labels: Record<string, string> = { commandExecution: '正在执行命令', mcpToolCall: '正在调用工具', dynamicToolCall: '正在调用工具', webSearch: '正在搜索', fileChange: '正在处理文件', agentMessage: '正在回复' }
  return (last && labels[last.type]) || 'Codex 正在工作'
})
function applyRead(result: ReadResult) {
  selected.value = result.thread; activeTurnId.value = result.activeTurnId; pendingApprovals.value = result.approvals || []; lastTurn.value = result.lastTurn || null
  for (const turn of result.thread.turns || []) for (const item of turn.items || []) if (item.type === 'userMessage') for (const part of item.content || []) if (part.assetUrl && !authenticatedImages.value[part.assetUrl] && !imageLoads.has(part.assetUrl)) {
    const assetUrl = part.assetUrl
    const request = (async () => {
      try {
        const response = await fetch(assetUrl, { headers: clientToken.value ? { Authorization: `Bearer ${clientToken.value}` } : {} })
        if (!response.ok) return undefined
        const objectUrl = URL.createObjectURL(await response.blob())
        authenticatedImages.value[assetUrl] = objectUrl
        return objectUrl
      } catch { return undefined }
      finally { imageLoads.delete(assetUrl) }
    })()
    imageLoads.set(assetUrl, request)
  }
  const pending = pendingMessages.value[result.thread.id]
  if (pending && timeline(result.thread.turns || []).filter(entry => entry.role === 'user' && entry.text === pending.text).length > pending.previousCount) delete pendingMessages.value[result.thread.id]
}
function toolSummary(items: { type: string; command?: unknown; commandActions?: unknown; tool?: unknown; name?: unknown; server?: unknown; namespace?: unknown; query?: unknown; path?: unknown }[]) {
  const names: Record<string, string> = { commandExecution: '执行命令', mcpToolCall: '调用工具', dynamicToolCall: '调用工具', fileChange: '修改文件', webSearch: '搜索网页', imageView: '查看图片' }
  const labels = [...new Set(items.map(item => names[item.type] || '其他操作'))]
  const first = items.find(item => ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'fileChange', 'imageView'].includes(item.type))
  let preview = ''
  if (first?.type === 'commandExecution') {
    const actions = Array.isArray(first.commandActions) ? first.commandActions : [first.commandActions]
    const action = actions.find(value => value && typeof value === 'object') as Record<string, unknown> | undefined
    preview = String(first.command || action?.command || action?.name || '')
  } else if (first?.type === 'mcpToolCall' || first?.type === 'dynamicToolCall') {
    preview = [first.server || first.namespace, first.tool || first.name].filter(Boolean).join(' · ')
  } else if (first?.type === 'webSearch') preview = String(first.query || '')
  else if (first) preview = String(first.path || '')
  if (preview.length > 140) preview = `${preview.slice(0, 140)}…`
  return labels.join('、') + (items.length > 1 ? ` · ${items.length} 项` : '') + (preview ? ` · ${preview}` : '')
}
function imageSource(part: ContentPart) {
  if (part.assetUrl) return authenticatedImages.value[part.assetUrl]
  if (part.url && (/^https:\/\//i.test(part.url) || /^data:image\/(png|jpeg|gif|webp);base64,/i.test(part.url))) return part.url
  return undefined
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: clientToken.value ? { Authorization: `Bearer ${clientToken.value}` } : {} })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data as T
}
async function bindOnlineDevice() {
  if (!adminToken.value) return false
  await loadDevices()
  const device = devices.value.find(item => item.online)
  if (!device) return false
  const result = await adminFetch<{ clientToken: string; device: { id: string; name: string; online: boolean } }>(`/api/devices/${device.id}/web-client`, 'POST', {})
  clientToken.value = result.clientToken
  remoteDevice.value = result.device
  localStorage.setItem('rmdex-client-token', result.clientToken)
  return true
}
async function loadModels() {
  modelLoading.value = true
  try {
    const result = await get<{ data: ModelOption[] }>('/api/models')
    models.value = result.data.filter(model => !model.hidden)
    const deviceKey = remoteDevice.value?.id || 'local'
    const savedModel = localStorage.getItem(`rmdex-model:${deviceKey}`)
    const savedEffort = localStorage.getItem(`rmdex-effort:${deviceKey}`)
    const nextModel = models.value.find(model => model.id === savedModel) || models.value.find(model => model.isDefault) || models.value[0]
    selectedModel.value = nextModel?.id || null
    const nextEffort = nextModel?.supportedReasoningEfforts.some(item => item.reasoningEffort === savedEffort)
      ? savedEffort
      : nextModel?.defaultReasoningEffort || nextModel?.supportedReasoningEfforts[0]?.reasoningEffort || null
    selectedEffort.value = nextEffort
  } catch (e) {
    models.value = []; selectedModel.value = null; selectedEffort.value = null
    throw e
  } finally { modelLoading.value = false }
}
function rememberModel(value: string) {
  selectedModel.value = value
  const deviceKey = remoteDevice.value?.id || 'local'
  localStorage.setItem(`rmdex-model:${deviceKey}`, value)
}
function rememberEffort(value: string) {
  selectedEffort.value = value
  const deviceKey = remoteDevice.value?.id || 'local'
  localStorage.setItem(`rmdex-effort:${deviceKey}`, value)
}
async function refresh() {
  loading.value = true; error.value = ''
  try {
    if (remoteMode.value) {
      let client: { device: { id: string; name: string; online: boolean } }
      if (!clientToken.value) {
        if (!(await bindOnlineDevice())) throw new Error(adminToken.value ? '没有在线的本地 Codex 设备，请先启动电脑端代理' : '请先在“连接设备”中绑定这台电脑')
        client = await get('/api/client')
      } else {
        try {
          client = await get('/api/client')
        } catch (firstError) {
          localStorage.removeItem('rmdex-client-token')
          clientToken.value = ''
          if (!(await bindOnlineDevice())) throw firstError
          client = await get('/api/client')
        }
      }
      remoteDevice.value = client.device
      if (!client.device.online) {
        localStorage.removeItem('rmdex-client-token')
        clientToken.value = ''
        if (!(await bindOnlineDevice())) throw new Error(adminToken.value ? '本地 Codex 设备当前离线，请先启动电脑端代理' : '当前绑定的电脑已离线，请在“连接设备”中重新选择在线电脑')
        client = await get('/api/client')
        remoteDevice.value = client.device
      }
    }
    const [result] = await Promise.all([
      get<{ data: Thread[] }>('/api/threads'),
      loadModels(),
    ])
    threads.value = [...new Map(result.data.map((thread) => [thread.id, thread])).values()]
    connected.value = true
  }
  catch (e) { connected.value = false; error.value = e instanceof Error ? e.message : String(e) }
  finally { loading.value = false }
}

async function openThread(thread: Thread) {
  const version = ++selectionVersion
  selected.value = thread; activeTurnId.value = null; pendingApprovals.value = []; lastTurn.value = null; mobileDetail.value = true; error.value = ''
  try {
    const result = await get<ReadResult>(`/api/threads/${thread.id}`)
    if (version === selectionVersion) { applyRead(result); await scrollToLatest() }
  }
  catch (e) { if (version === selectionVersion) error.value = e instanceof Error ? e.message : String(e) }
}
async function updateThread() {
  if (!selected.value || pollBusy) return
  const id = selected.value.id
  const version = selectionVersion
  const element = conversation.value
  const follow = element ? element.scrollHeight - element.scrollTop - element.clientHeight < 100 : false
  pollBusy = true
  try {
    const result = await get<ReadResult>(`/api/threads/${id}`)
    if (version === selectionVersion) { applyRead(result); if (follow) await scrollToLatest() }
  } catch (e) { if (version === selectionVersion) error.value = e instanceof Error ? e.message : String(e) }
  finally { pollBusy = false }
}
async function post(path: string, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (clientToken.value) headers.Authorization = `Bearer ${clientToken.value}`
  const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '请求失败')
  return result
}
async function adminFetch<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${adminToken.value}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败')
  return data as T
}
async function loginAdmin() {
  pairError.value = ''
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: adminPassword.value }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '登录失败')
    adminToken.value = result.token; sessionStorage.setItem('rmdex-admin-token', result.token); adminPassword.value = ''
    await loadDevices()
    if (!clientToken.value) {
      const device = devices.value.find(item => item.online)
      if (device) await connectDevice(device.id)
    } else {
      await refresh()
    }
  } catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
}
async function loadDevices() {
  if (!adminToken.value) return
  try {
    const [deviceResult, requestResult] = await Promise.all([
      adminFetch<{ data: typeof devices.value }>('/api/devices'),
      adminFetch<{ data: typeof pairRequests.value }>('/api/pair-requests'),
    ])
    devices.value = deviceResult.data; pairRequests.value = requestResult.data
  }
  catch (e) { adminToken.value = ''; sessionStorage.removeItem('rmdex-admin-token'); pairError.value = e instanceof Error ? e.message : String(e) }
}
async function connectDevice(deviceId: string) {
  pairError.value = ''
  try {
    const result = await adminFetch<{ clientToken: string; device: { id: string; name: string; online: boolean } }>(`/api/devices/${deviceId}/web-client`, 'POST', {})
    clientToken.value = result.clientToken
    remoteDevice.value = result.device
    localStorage.setItem('rmdex-client-token', result.clientToken)
    showDevices.value = false
    await refresh()
  } catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
}
async function registerDevice() {
  pairError.value = ''; newDeviceToken.value = ''; pairCode.value = ''; pairQr.value = ''
  try {
    const result = await adminFetch<{ token: string; clientToken: string }>('/api/devices', 'POST', { name: deviceName.value })
    newDeviceToken.value = result.token
    clientToken.value = result.clientToken
    localStorage.setItem('rmdex-client-token', result.clientToken)
    await loadDevices()
    await refresh()
  }
  catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
}
async function createPair(deviceId: string) {
  pairError.value = ''
  try { const result = await adminFetch<{ code: string; url: string }>(`/api/devices/${deviceId}/pair`, 'POST', {}); pairCode.value = result.code; pairUrl.value = result.url; pairQr.value = await QRCode.toDataURL(result.url, { width: 240, margin: 1, color: { dark: '#162b45', light: '#ffffff' } }) }
  catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
}
async function claimPair(code = pairInput.value) {
  pairError.value = ''
  mobilePairing.value = true
  try {
    const response = await fetch('/api/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
    const result = await response.json()
    if (response.status !== 202) throw new Error(result.error || '配对失败')
    history.replaceState({}, '', location.pathname)
    pairInput.value = ''
    for (let attempt = 0; attempt < 150; attempt++) {
      const status = await fetch('/api/pair/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: result.requestId }) })
      const state = await status.json()
      if (state.status === 'approved' && state.token) {
        clientToken.value = state.token; localStorage.setItem('rmdex-client-token', state.token)
        pairLanding.value = false; showDevices.value = false; mobilePairing.value = false; await refresh(); return
      }
      if (state.status === 'denied' || state.status === 'expired') throw new Error(state.status === 'denied' ? '电脑端拒绝了配对请求' : '配对申请已过期')
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    throw new Error('等待电脑确认超时，请重新扫码')
  } catch (e) { showDevices.value = true; pairError.value = e instanceof Error ? e.message : String(e) }
  finally { mobilePairing.value = false }
}
async function decidePair(requestId: string, decision: 'approve' | 'deny') {
  try { await adminFetch(`/api/pair-requests/${requestId}`, 'POST', { decision }); await loadDevices() }
  catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
}
async function revokeDevice(deviceId: string) {
  if (!window.confirm('撤销后此电脑与所有已配对手机都会断开。确定继续？')) return
  try { await adminFetch(`/api/devices/${deviceId}`, 'DELETE'); await loadDevices() }
  catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
}
async function copyValue(value: string) { await navigator.clipboard.writeText(value) }
function openCreate() {
  createPath.value = selected.value?.cwd || 'D:\\WorkSpace'
  createError.value = ''
  showCreate.value = true
}
async function createThread() {
  if (creating.value) return
  creating.value = true; createError.value = ''
  try {
    const result = await post('/api/threads', { cwd: createPath.value }) as { thread: Thread }
    query.value = ''
    threads.value = [result.thread, ...threads.value.filter(thread => thread.id !== result.thread.id)]
    showCreate.value = false
    await openThread(result.thread)
  } catch (e) { createError.value = e instanceof Error ? e.message : String(e) }
  finally { creating.value = false }
}
async function send() {
  if (!selected.value || sending.value || activeTurnId.value) return
  const id = selected.value.id
  const text = (drafts.value[id] || '').trim()
  if (!text) return
  if (permissionMode.value === 'full' && !window.confirm('完全访问允许 Codex 不经审批执行操作，并访问电脑上的文件和网络。确认使用此权限发送？')) return
  sending.value = true; sendingThreadId.value = id; pendingMessages.value[id] = { text, previousCount: messages.value.filter(entry => entry.role === 'user' && entry.text === text).length }; error.value = ''; lastTurn.value = null
  await scrollToLatest()
  try {
    const result = await post(`/api/threads/${id}/send`, {
      text,
      permissionMode: permissionMode.value,
      model: selectedModel.value,
      effort: selectedEffort.value,
    })
    if (drafts.value[id]?.trim() === text) drafts.value[id] = ''
    if (selected.value?.id === id) { activeTurnId.value = result.turn?.id || null; await updateThread(); await scrollToLatest() }
  } catch (e) { delete pendingMessages.value[id]; if (selected.value?.id === id) error.value = e instanceof Error ? e.message : String(e) }
  finally { sending.value = false; sendingThreadId.value = null }
}
function onEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void send()
}
async function stop() {
  if (!selected.value) return
  try { await post(`/api/threads/${selected.value.id}/stop`, {}); await updateThread() }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
async function decide(approval: Approval, decision: 'accept' | 'decline') {
  try { await post(`/api/approvals/${approval.id}`, { decision }); pendingApprovals.value = pendingApprovals.value.filter(item => item.id !== approval.id) }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
function date(value?: number) { return value ? new Date(value * 1000).toLocaleDateString() : '' }
onMounted(() => { const code = new URLSearchParams(location.hash.slice(1)).get('pair'); if (code) { pairLanding.value = true; showDevices.value = true; history.replaceState({}, '', location.pathname); void claimPair(code) } else void refresh(); poll = setInterval(() => { updateThread(); if (adminToken.value && showDevices.value) void loadDevices() }, 2000); if (adminToken.value) void loadDevices() })
onUnmounted(() => { if (poll) clearInterval(poll) })
</script>

<template>
  <div class="shell">
    <aside id="thread-panel" class="thread-panel" :class="{ collapsed: !sidebarOpen, hiddenMobile: mobileDetail }">
      <div class="brand-row">
        <div class="brand"><img :src="logoUrl" alt="" /><span>rmdex</span></div>
        <button class="icon-button collapse-button" title="收起侧栏" aria-label="收起侧栏" aria-controls="thread-panel" :aria-expanded="sidebarOpen" @click="sidebarOpen = false"><PanelLeftClose :size="19" /></button>
      </div>
      <button class="new-thread" @click="openCreate"><Plus :size="17" /><span>新建对话</span></button>
      <div class="device"><span class="device-icon"><Monitor :size="16" /></span><div class="device-copy"><strong>{{ remoteDevice?.name || (remoteMode ? '未连接 Codex 设备' : '本机设备') }}</strong><small>{{ connected ? '已连接' : (remoteMode ? '等待远程设备' : '未连接') }}</small></div><span class="online" :class="{ offline: !connected }"></span></div>
      <button class="pair-entry" type="button" @click="showDevices = true"><QrCode :size="16" /><span>连接设备</span><span class="pair-entry-hint">扫码配对</span></button>
      <label class="search"><Search :size="16" /><input v-model="query" placeholder="搜索会话" aria-label="搜索会话" /></label>
      <div class="section-label"><span>会话 <span class="count">{{ filtered.length }}</span></span><button class="icon-button" title="刷新会话" aria-label="刷新会话" :disabled="loading" @click="refresh"><RefreshCw :size="15" /></button></div>
      <div v-if="error && !connected" class="sidebar-error">{{ error }}</div>
      <div class="thread-list"><button v-for="thread in filtered" :key="thread.id" class="thread" :class="{ selected: selected?.id === thread.id }" @click="openThread(thread)"><span class="thread-title">{{ thread.name || thread.preview || '未命名会话' }}</span><span class="thread-meta">{{ date(thread.updatedAt) }}</span></button><div v-if="!filtered.length && !loading" class="empty-list">暂无会话</div></div>
      <footer class="side-footer"><span class="online" :class="{ offline: !connected }"></span> {{ remoteMode ? '远程设备' : '本机模式' }} <span class="footer-label">{{ connected ? '已连接' : '未连接' }}</span></footer>
    </aside>
    <main class="main" :class="{ hiddenMobile: !mobileDetail }">
      <header class="main-head"><button class="icon-button back" title="返回会话" aria-label="返回会话" @click="mobileDetail = false"><ArrowLeft :size="19" /></button><button v-if="!sidebarOpen" class="icon-button expand-button" title="展开侧栏" aria-label="展开侧栏" aria-controls="thread-panel" :aria-expanded="sidebarOpen" @click="sidebarOpen = true"><Menu :size="19" /></button><div class="heading"><strong>{{ selected?.name || selected?.preview || '会话' }}</strong><span v-if="selected">本机设备</span></div><span v-if="activeTurnId" class="readonly">执行中</span><button v-if="!sidebarOpen" class="icon-button expand-button" title="新建对话" aria-label="新建对话" @click="openCreate"><Plus :size="19" /></button></header>
      <div v-if="error" class="error"><CircleAlert :size="18" /><span>{{ error }}</span><button @click="refresh">重试</button></div>
      <div v-if="!selected" class="welcome"><div class="welcome-icon"><MessageSquare :size="22" /></div><h2>选择一个会话</h2><p>查看你的 Codex 对话</p></div>
      <div v-else ref="conversation" class="conversation"><div class="conversation-inner"><div class="conversation-header"><h2>{{ selected.name || selected.preview || '未命名会话' }}</h2><p>{{ selected.cwd }}</p></div><div v-if="!messages.length && !pendingMessages[selected.id]" class="empty-messages">此会话暂无可显示的消息。</div><template v-for="(message, i) in messages" :key="i"><details v-if="message.role === 'tools'" class="tool-group"><summary><Wrench :size="14" /><span>{{ toolSummary(message.items) }}</span><span v-if="message.items.some(item => item.status === 'failed' || item.status === 'declined' || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0))" class="group-failed">含失败</span><ChevronRight :size="14" class="group-chevron" /></summary><div class="tool-group-content"><ToolEvent v-for="(item, index) in message.items" :key="item.id || index" :item="item" /></div></details><article v-else class="message" :class="`message--${message.role}`" :aria-label="message.role === 'user' ? '用户消息' : 'Codex 回复'"><div class="message-body"><div v-if="message.images.length" class="attachments"><template v-for="(image, index) in message.images" :key="index"><a v-if="imageSource(image)" :href="imageSource(image)" target="_blank" rel="noopener noreferrer" class="attachment"><img :src="imageSource(image)" alt="图片附件" loading="lazy" /></a><span v-else class="attachment-unavailable">图片附件不可用</span></template></div><div v-if="message.text" class="message-text markdown" v-html="markdown.render(message.text)"></div></div></article></template><article v-if="pendingMessages[selected.id]" class="message message--user" aria-label="待显示的用户消息"><div class="message-body"><div class="message-text markdown" v-html="markdown.render(pendingMessages[selected.id]!.text)"></div></div></article><div v-if="working" class="working" role="status" aria-live="polite"><LoaderCircle :size="16" class="working-spinner" /><span>{{ workLabel }}</span></div><div v-else-if="lastTurn?.status === 'failed'" class="turn-failure" role="alert">执行失败<span v-if="lastTurn.error?.message">：{{ lastTurn.error.message }}</span></div></div></div>
      <div v-if="selected" class="compose-area">
        <div v-for="approval in pendingApprovals" :key="approval.id" class="approval"><strong>{{ approval.method.includes('commandExecution') ? '命令执行需要确认' : '文件修改需要确认' }}</strong><p v-if="approval.params.reason">{{ approval.params.reason }}</p><pre v-if="approval.params.command">{{ approval.params.command }}</pre><p v-if="approval.params.cwd">工作目录：{{ approval.params.cwd }}</p><p v-if="approval.params.grantRoot">授权目录：{{ approval.params.grantRoot }}</p><details><summary>完整请求信息</summary><pre>{{ JSON.stringify(approval.params, null, 2) }}</pre></details><p v-if="approval.method.includes('fileChange')">请先在上方工具调用中查看文件变更，再决定是否允许。</p><div class="approval-actions"><button @click="decide(approval, 'decline')">拒绝</button><button @click="decide(approval, 'accept')">允许本次</button></div></div>
        <form class="composer" @submit.prevent="send"><textarea v-model="drafts[selected.id]" placeholder="给 Codex 发送消息" aria-label="消息" rows="2" :disabled="sending || !!activeTurnId" @keydown.enter.exact="onEnter"></textarea><div class="compose-actions"><PermissionMenu v-model="permissionMode" :disabled="working" /><div class="compose-right"><ModelMenu :models="models" :model-value="selectedModel" :effort="selectedEffort" :loading="modelLoading" :disabled="working || sending" @update:model-value="rememberModel" @update:effort="rememberEffort" /><button v-if="activeTurnId" type="button" class="send-button stop-button" title="停止任务" aria-label="停止任务" @click="stop"><Square :size="14" fill="currentColor" /></button><button v-else type="submit" class="send-button" title="发送消息" aria-label="发送消息" :disabled="sending || !drafts[selected.id]?.trim()"><ArrowUp :size="18" /></button></div></div></form>
      </div>
    </main>
    <div v-if="showCreate" class="modal-backdrop" @click.self="!creating && (showCreate = false)"><section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title" @keydown.esc="!creating && (showCreate = false)"><header><h2 id="create-title">新建对话</h2><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="creating" @click="showCreate = false"><X :size="18" /></button></header><form @submit.prevent="createThread"><label for="working-directory">工作目录</label><input id="working-directory" v-model="createPath" required autocomplete="off" placeholder="例如 D:\WorkSpace\rmdex" /><p v-if="createError" class="create-error" role="alert">{{ createError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="creating" @click="showCreate = false">取消</button><button type="submit" class="create-button" :disabled="creating || !createPath.trim()">{{ creating ? '创建中…' : '创建对话' }}</button></div></form></section></div>
    <div v-if="showDevices" class="modal-backdrop" @click.self="showDevices = false"><section class="create-dialog device-dialog" role="dialog" aria-modal="true" aria-labelledby="devices-title" @keydown.esc="showDevices = false"><header><div><h2 id="devices-title">设备连接</h2><p>管理 Codex 电脑与手机配对</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showDevices = false"><X :size="18" /></button></header>
      <form v-if="!adminToken && !pairLanding" class="admin-login" @submit.prevent="loginAdmin"><label for="admin-password">设备管理员密码</label><p class="dialog-hint">登录后才能管理 Codex 电脑、生成手机配对码和审批手机连接。</p><input id="admin-password" v-model="adminPassword" type="password" autocomplete="current-password" required placeholder="输入服务器管理员密码" /><button class="create-button" type="submit">登录管理设备</button></form>
      <template v-else-if="adminToken"><div class="admin-status"><span class="online"></span><span>管理员已验证</span></div><form class="register-device" @submit.prevent="registerDevice"><input v-model="deviceName" aria-label="设备名称" maxlength="80" /><button class="create-button" type="submit"><Plus :size="15" />注册此电脑</button></form>
        <div v-if="newDeviceToken" class="device-secret"><strong>设备密钥只显示这一次</strong><p>将它配置在运行 Codex Desktop 的电脑上。不要发送给其他人。</p><code>{{ newDeviceToken }}</code><button class="copy-button" type="button" @click="copyValue(newDeviceToken)"><Copy :size="15" />复制密钥</button><small>电脑代理环境变量：RMDEX_RELAY_URL=wss://code.kyeai.xyz/agent，RMDEX_DEVICE_TOKEN=上方密钥</small></div>
        <div v-if="pairRequests.length" class="pair-requests"><strong>等待确认的手机</strong><div v-for="request in pairRequests" :key="request.id" class="pair-request"><span>{{ request.name }}</span><button type="button" @click="decidePair(request.id, 'deny')">拒绝</button><button type="button" class="approve-pair" @click="decidePair(request.id, 'approve')">允许</button></div></div>
        <div class="device-list"><div v-for="device in devices" :key="device.id" class="device-row"><span class="device-icon"><Monitor :size="16" /></span><div class="device-copy"><strong>{{ device.name }}</strong><small>{{ device.online ? '在线' : '离线' }}</small></div><span class="online" :class="{ offline: !device.online }"></span><button class="icon-button" :class="{ 'connect-device-button': remoteDevice?.id !== device.id }" title="连接此设备" aria-label="连接此设备" :disabled="!device.online" @click="connectDevice(device.id)"><MessageSquare :size="16" /></button><button class="icon-button" title="生成手机配对码" aria-label="生成手机配对码" @click="createPair(device.id)"><Smartphone :size="16" /></button><button class="icon-button revoke-button" title="撤销设备" aria-label="撤销设备" @click="revokeDevice(device.id)"><Trash2 :size="15" /></button></div><p v-if="!devices.length" class="device-empty">尚未注册 Codex 电脑</p></div>
        <div v-if="pairCode" class="pair-result"><img :src="pairQr" alt="手机扫码配对二维码" /><div><strong>手机扫码配对</strong><p>二维码和配对码 3 分钟内有效，只能使用一次。</p><code>{{ pairCode }}</code><button class="copy-button" type="button" @click="copyValue(pairUrl)"><Copy :size="15" />复制配对链接</button></div></div>
      </template>
      <template v-else-if="pairLanding"><div class="mobile-pair-intro"><Smartphone :size="22" /><div><strong>申请连接 Codex 电脑</strong><p>配对申请会发送到电脑端，等待管理员允许后即可使用。</p></div></div><form class="claim-pair" @submit.prevent="claimPair()"><label for="pair-code">二维码无法自动识别时，输入配对码</label><div><input id="pair-code" v-model="pairInput" maxlength="32" placeholder="输入配对码" /><button class="create-button" type="submit" :disabled="pairInput.length !== 32">配对</button></div></form><p v-if="mobilePairing && !pairError" class="pair-waiting" role="status"><LoaderCircle :size="15" class="working-spinner" />配对申请已发送，请在电脑端允许此手机连接。</p></template>
      <p v-if="pairError" class="create-error" role="alert">{{ pairError }}</p>
    </section></div>
  </div>
</template>
