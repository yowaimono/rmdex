<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { App as NativeApp } from '@capacitor/app'
import { LocalNotifications } from '@capacitor/local-notifications'
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner'
import MarkdownIt from 'markdown-it'
import { ArrowLeft, ArrowUp, ChevronRight, CircleAlert, Ellipsis, LoaderCircle, Menu, MessageSquare, Monitor, PanelLeftClose, Pencil, Plus, RefreshCw, Search, Square, Wrench, X, QrCode, Copy, Smartphone, Trash2, ShieldAlert } from 'lucide-vue-next'
import QRCode from 'qrcode'
import logoUrl from './assets/rmdex-logo.jpg'
import ToolEvent from './components/ToolEvent.vue'
import PermissionMenu from './components/PermissionMenu.vue'
import ModelMenu, { type ModelOption } from './components/ModelMenu.vue'
import { timeline, type ContentPart, type Turn } from './conversation'
import { loadThreadCache, queueThreadCacheWrite } from './thread-cache'

type Thread = { id: string; name?: string | null; preview?: string; cwd?: string; updatedAt?: number; status?: { type: string }; turns?: Turn[]; desktopDraft?: { projectId: string | null; deviceKey: string; preparing?: boolean } }
const apiBase = Capacitor.isNativePlatform() ? 'https://code.kyeai.xyz' : ''
const apiUrl = (path: string) => path.startsWith('http://') || path.startsWith('https://') ? path : `${apiBase}${path}`
let appUrlListener: { remove: () => Promise<void> } | undefined
const threads = ref<Thread[]>([])
const localDraftThreads = ref<Thread[]>([])
const selected = ref<Thread | null>(null)
const query = ref('')
const loading = ref(false)
const threadLoading = ref(false)
const threadLoadError = ref('')
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
const scanningPair = ref(false)
const pairApprovalPage = ref(false)
const pairApprovalState = ref<'waiting' | 'denied' | 'expired' | 'error'>('waiting')
const threadMenuId = ref<string | null>(null)
const renameThread = ref<Thread | null>(null)
const renameValue = ref('')
const renameError = ref('')
const renaming = ref(false)
let selectionVersion = 0
const mobileDetail = ref(false)
const sidebarOpen = ref(true)
const creating = ref(false)
const showCreate = ref(false)
const createPath = ref('')
const createError = ref('')
const createProject = ref('')
const desktopProjects = ref<Array<{ id: string; name: string; path: string }>>([])
const defaultCapabilities = { mode: 'app-server', models: true, permissions: true, stop: true, approvals: true, create: true, send: true, rename: true, history: false, createRequiresPrompt: false }
const capabilities = ref({ ...defaultCapabilities })
const desktopMode = computed(() => capabilities.value.mode === 'desktop')
const historyCursor = ref<string | null>(null)
const historyLoading = ref(false)
let queuedUntil = 0
const conversation = ref<HTMLElement | null>(null)
async function scrollToLatest() { await nextTick(); if (conversation.value) conversation.value.scrollTop = conversation.value.scrollHeight }
const drafts = ref<Record<string, string>>({})
const sending = ref(false)
const sendingThreadId = ref<string | null>(null)
const activeTurnId = ref<string | null>(null)
const stopRequested = ref(false)
const stopping = ref(false)
const pendingMessages = ref<Record<string, { text: string; previousCount: number }>>({})
const permissionMode = ref<'ask' | 'auto' | 'full'>((localStorage.getItem('rmdex-permission-mode') as 'ask' | 'auto' | 'full' | null) || 'ask')
const showFullAccessConfirm = ref(false)
const fullAccessConfirmed = ref(false)
const models = ref<ModelOption[]>([])
const selectedModel = ref<string | null>(null)
const selectedEffort = ref<string | null>(null)
const modelLoading = ref(false)
const desktopDefaultModel = '__rmdex_desktop_default__'
const lastTurn = ref<{ id?: string; status: string; error?: { message?: string } } | null>(null)
type Approval = { id: string; method: string; params: { command?: string; reason?: string; cwd?: string; grantRoot?: string } }
const pendingApprovals = ref<Approval[]>([])
let poll: ReturnType<typeof setInterval> | undefined
let pollBusy = false
let appStateListener: { remove: () => Promise<void> } | undefined
let notificationListener: { remove: () => Promise<void> } | undefined
let appActive = true
const trackedTasks = new Map<string, { turnId: string; text: string; name: string }>()
const cacheHydratedKeys = new Set<string>()
const threadListCache = new Map<string, { savedAt: number; data: Thread[] }>()
const threadListRequests = new Map<string, Promise<Thread[]>>()
type ReadResult = { thread: Thread; activeTurnId: string | null; approvals: Approval[]; lastTurn?: { id?: string; status: string; error?: { message?: string } } | null; page?: { hasMore: boolean; nextCursor: string | null } }
type ThreadStatus = {
  threadId: string
  activeTurnId: string | null
  approvals: Approval[]
  lastTurn?: { id?: string; status: string; error?: { message?: string } } | null
  live?: { turnId: string; status: string; error?: { message?: string }; sentText?: string; items: Turn['items'] } | null
}
const threadCache = new Map<string, ReadResult>()
const threadRequests = new Map<string, Promise<ReadResult>>()
let modelsLoadedKey = ''
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })
const defaultLink = markdown.renderer.rules.link_open || ((tokens, idx, options, _env, renderer) => renderer.renderToken(tokens, idx, options))
markdown.renderer.rules.link_open = (tokens, idx, options, env, renderer) => {
  tokens[idx]!.attrSet('target', '_blank')
  tokens[idx]!.attrSet('rel', 'noopener noreferrer')
  return defaultLink(tokens, idx, options, env, renderer)
}
const orderedThreads = computed(() => [...threads.value].sort((a, b) => {
  const active = (value: Thread) => ['active', 'inProgress', 'running'].includes(value.status?.type || '') ? 1 : 0
  return active(b) - active(a) || (b.updatedAt || 0) - (a.updatedAt || 0)
}))
const filtered = computed(() => orderedThreads.value.filter((t) => `${t.name || ''} ${t.preview || ''} ${t.cwd || ''}`.toLowerCase().includes(query.value.toLowerCase())))
const remoteMode = computed(() => Capacitor.isNativePlatform() || !!clientToken.value || !['localhost', '127.0.0.1'].includes(location.hostname))
const messages = computed(() => timeline(selected.value?.turns || []))
const working = computed(() => !!activeTurnId.value || sendingThreadId.value === selected.value?.id || !!selected.value?.desktopDraft?.preparing)
const workLabel = computed(() => {
  if (selected.value?.desktopDraft?.preparing) return 'Desktop 正在准备新会话'
  if (pendingApprovals.value.length) return '等待审批'
  const turn = selected.value?.turns?.find(item => item.id === activeTurnId.value)
  const last = turn?.items?.[turn.items.length - 1]
  const labels: Record<string, string> = { commandExecution: '正在执行命令', mcpToolCall: '正在调用工具', dynamicToolCall: '正在调用工具', webSearch: '正在搜索', fileChange: '正在处理文件', agentMessage: '正在回复' }
  return (last && labels[last.type]) || 'Codex 正在工作'
})
function threadCacheKey(id: string) {
  return `${remoteDevice.value?.id || 'local'}:${desktopMode.value ? 'desktop' : 'app-server'}:${id}`
}
function cloneRead(result: ReadResult): ReadResult {
  return structuredClone(result)
}
function rememberThreadRead(result: ReadResult) {
  const key = threadCacheKey(result.thread.id)
  const copy = cloneRead(result)
  threadCache.set(key, copy)
  queueThreadCacheWrite(key, copy)
}
async function hydrateThreadCache() {
  const prefix = `${remoteDevice.value?.id || 'local'}:${desktopMode.value ? 'desktop' : 'app-server'}:`
  if (cacheHydratedKeys.has(prefix)) return
  cacheHydratedKeys.add(prefix)
  for (const entry of await loadThreadCache(prefix)) {
    if (entry.result && typeof entry.result === 'object' && 'thread' in entry.result) threadCache.set(entry.key, entry.result as ReadResult)
  }
}
function notificationTasks() {
  try { return JSON.parse(localStorage.getItem('rmdex-active-tasks') || '[]') as Array<{ deviceKey: string; threadId: string; turnId: string; text: string; name: string }> } catch { return [] }
}
function persistNotificationTasks() {
  localStorage.setItem('rmdex-active-tasks', JSON.stringify([...trackedTasks.entries()].map(([threadId, task]) => ({ deviceKey: remoteDevice.value?.id || 'local', threadId, ...task }))))
}
function trackTask(threadId: string, turnId: string, text: string, name: string) {
  trackedTasks.set(threadId, { turnId, text, name })
  persistNotificationTasks()
}
function clearTask(threadId: string) {
  if (!trackedTasks.delete(threadId)) return
  persistNotificationTasks()
}
async function notifyTaskComplete(threadId: string, task: { turnId: string; text: string; name: string }, status: string) {
  clearTask(threadId)
  if (appActive || !Capacitor.isNativePlatform()) return
  try {
    const permission = await LocalNotifications.checkPermissions()
    if (permission.display !== 'granted') return
    await LocalNotifications.schedule({ notifications: [{
      id: Math.abs([...task.turnId].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)),
      title: `${task.name || 'Codex 会话'}已完成`,
      body: status === 'completed' ? '任务已完成，点击查看结果' : `任务${status === 'interrupted' ? '已暂停' : '未完成'}，点击查看详情`,
      channelId: 'rmdex-tasks',
      extra: { threadId },
    }] })
  } catch { /* Notification permission or channel may be unavailable on this device. */ }
}
async function setupNotifications() {
  if (!Capacitor.isNativePlatform()) return
  try {
    const permission = await LocalNotifications.checkPermissions()
    if (permission.display !== 'granted') await LocalNotifications.requestPermissions()
    await LocalNotifications.createChannel({ id: 'rmdex-tasks', name: '任务完成', description: 'Codex 任务完成提醒', importance: 5, visibility: 1 })
    notificationListener = await LocalNotifications.addListener('localNotificationActionPerformed', async action => {
      const threadId = typeof action.notification.extra?.threadId === 'string' ? action.notification.extra.threadId : ''
      if (!threadId) return
      await refresh()
      const thread = threads.value.find(item => item.id === threadId)
      if (thread) await openThread(thread)
    })
    appStateListener = await NativeApp.addListener('appStateChange', ({ isActive }) => {
      appActive = isActive
      if (isActive) void updateThread()
    })
  } catch { /* Notifications are optional on devices that deny permission. */ }
}
function maybeNotifyTaskComplete(result: ThreadStatus) {
  const task = trackedTasks.get(result.threadId)
  if (!task || result.activeTurnId || result.lastTurn?.id !== task.turnId) return
  const status = result.lastTurn.status
  if (!['completed', 'interrupted', 'failed', 'error'].includes(status)) return
  void notifyTaskComplete(result.threadId, task, status)
}
async function readThread(id: string, force = false) {
  const key = threadCacheKey(id)
  if (!force) {
    const cached = threadCache.get(key)
    if (cached) return cloneRead(cached)
  }
  const existing = threadRequests.get(key)
  if (existing) return existing.then(cloneRead)
  const request = get<ReadResult>(`/api/threads/${id}`)
    .then(result => { rememberThreadRead(result); return result })
    .finally(() => threadRequests.delete(key))
  threadRequests.set(key, request)
  return request.then(cloneRead)
}
function mergeThreadStatus(result: ThreadStatus) {
  if (!selected.value || selected.value.id !== result.threadId) return
  const turns = selected.value.turns ||= []
  const live = result.live
  if (live) {
    let turn = turns.find(item => item.id === live.turnId)
    if (!turn) { turn = { id: live.turnId, status: live.status, items: [] }; turns.push(turn) }
    turn.status = live.status
    const hasUserInput = live.sentText && turn.items.some(item => item.type === 'userMessage' && item.content?.some(part => part.text === live.sentText))
    if (live.sentText && !hasUserInput) turn.items.unshift({ id: `rmdex-input-${live.turnId}`, type: 'userMessage', content: [{ type: 'text', text: live.sentText }] })
    for (const item of live.items || []) {
      const index = turn.items.findIndex(existing => existing.id && existing.id === item.id)
      if (index < 0) turn.items.push(item)
      else turn.items[index] = item
    }
  }
  activeTurnId.value = result.activeTurnId
  pendingApprovals.value = result.approvals || []
  lastTurn.value = result.lastTurn || null
  rememberThreadRead({ thread: selected.value, activeTurnId: activeTurnId.value, approvals: pendingApprovals.value, lastTurn: lastTurn.value, page: threadCache.get(threadCacheKey(result.threadId))?.page })
  maybeNotifyTaskComplete(result)
}
function applyRead(result: ReadResult) {
  if (desktopMode.value && selected.value?.id === result.thread.id) {
    result.thread.turns = [...new Map([...(selected.value.turns || []), ...(result.thread.turns || [])].map(turn => [turn.id, turn])).values()]
  }
  selected.value = result.thread; activeTurnId.value = result.activeTurnId; pendingApprovals.value = result.approvals || []; lastTurn.value = result.lastTurn || null
  for (const turn of result.thread.turns || []) for (const item of turn.items || []) if (item.type === 'userMessage') for (const part of item.content || []) if (part.assetUrl && !authenticatedImages.value[part.assetUrl] && !imageLoads.has(part.assetUrl)) {
    const assetUrl = part.assetUrl
    const request = (async () => {
      try {
        const response = await fetch(apiUrl(assetUrl), { headers: clientToken.value ? { Authorization: `Bearer ${clientToken.value}` } : {} })
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
  if (desktopMode.value && !activeTurnId.value && pendingMessages.value[result.thread.id] && Date.now() < queuedUntil) activeTurnId.value = 'desktop-queued'
  rememberThreadRead({ thread: selected.value, activeTurnId: activeTurnId.value, approvals: pendingApprovals.value, lastTurn: lastTurn.value, page: result.page })
}
function toolSummary(items: { type: string; command?: unknown; commandActions?: unknown; tool?: unknown; name?: unknown; server?: unknown; namespace?: unknown; query?: unknown; path?: unknown }[]) {
  const names: Record<string, string> = { commandExecution: '执行命令', mcpToolCall: '调用工具', dynamicToolCall: '调用工具', functionCallOutput: '工具结果', fileChange: '修改文件', webSearch: '搜索网页', imageView: '查看图片', plan: '执行计划', contextCompaction: '上下文压缩' }
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

async function readJsonResponse(response: Response, fallback: string) {
  const text = await response.text()
  if (!text.trim()) throw new Error(`${fallback}（服务器返回了空响应，设备可能正在重连）`)
  try {
    return JSON.parse(text) as any
  } catch {
    throw new Error(`${fallback}（服务器返回了无效 JSON）`)
  }
}
async function get<T>(path: string): Promise<T> {
  const response = await fetch(apiUrl(path), { headers: clientToken.value ? { Authorization: `Bearer ${clientToken.value}` } : {} })
  const data = await readJsonResponse(response, `加载 ${path} 失败`)
  if (!response.ok) throw new Error(data?.error || 'Request failed')
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
  const deviceKey = remoteDevice.value?.id || 'local'
  const requestedKey = `${desktopMode.value ? 'desktop' : 'app-server'}:${deviceKey}`
  if (modelsLoadedKey === requestedKey) return
  modelLoading.value = true
  try {
    const result = await get<{ data: ModelOption[]; capabilities?: typeof defaultCapabilities; projects?: typeof desktopProjects.value }>('/api/models')
    capabilities.value = { ...defaultCapabilities, ...result.capabilities }
    desktopProjects.value = result.projects || []
    models.value = result.data.filter(model => !model.hidden)
    if (desktopMode.value && capabilities.value.models) {
      models.value = [{ id: desktopDefaultModel, model: '', displayName: '沿用 Desktop', description: '使用会话的现有模型，新对话使用桌面默认设置', hidden: false, isDefault: true, defaultReasoningEffort: '', supportedReasoningEfforts: [] }, ...models.value]
    }
    const settingsKey = desktopMode.value ? `desktop:${deviceKey}` : deviceKey
    const savedModel = localStorage.getItem(`rmdex-model:${settingsKey}`)
    const savedEffort = localStorage.getItem(`rmdex-effort:${settingsKey}`)
    const nextModel = models.value.find(model => model.id === savedModel) || models.value.find(model => model.isDefault) || models.value[0]
    selectedModel.value = nextModel?.id || null
    const nextEffort = nextModel?.supportedReasoningEfforts.some(item => item.reasoningEffort === savedEffort)
      ? savedEffort
      : nextModel?.defaultReasoningEffort || nextModel?.supportedReasoningEfforts[0]?.reasoningEffort || null
    selectedEffort.value = nextEffort
    modelsLoadedKey = requestedKey
  } catch (e) {
    models.value = []; selectedModel.value = null; selectedEffort.value = null
    capabilities.value = { ...defaultCapabilities, models: false, permissions: false, stop: false, send: false, create: false }
    error.value = `设备设置暂不可用：${e instanceof Error ? e.message : String(e)}`
  } finally { modelLoading.value = false }
}
async function loadThreads(force = false) {
  const scope = `${remoteDevice.value?.id || 'local'}:${desktopMode.value ? 'desktop' : 'app-server'}`
  const cached = threadListCache.get(scope)
  if (!force && cached && Date.now() - cached.savedAt < 5000) return cached.data.map(thread => ({ ...thread }))
  const existing = threadListRequests.get(scope)
  if (existing) return existing.then(data => data.map(thread => ({ ...thread })))
  const request = get<{ data: Thread[] }>('/api/threads').then(result => {
    const data = result.data || []
    threadListCache.set(scope, { savedAt: Date.now(), data: data.map(thread => ({ ...thread })) })
    return data
  }).finally(() => threadListRequests.delete(scope))
  threadListRequests.set(scope, request)
  return request.then(data => data.map(thread => ({ ...thread })))
}
let threadLongPressTimer: ReturnType<typeof setTimeout> | undefined
function clearThreadLongPress() {
  if (threadLongPressTimer) clearTimeout(threadLongPressTimer)
  threadLongPressTimer = undefined
}
function openThreadMenu(thread: Thread) {
  threadMenuId.value = threadMenuId.value === thread.id ? null : thread.id
}
function beginRename(thread: Thread) {
  threadMenuId.value = null
  renameThread.value = thread
  renameValue.value = thread.name || thread.preview || ''
  renameError.value = ''
}
function startThreadLongPress(thread: Thread) {
  clearThreadLongPress()
  threadLongPressTimer = setTimeout(() => beginRename(thread), 550)
}
async function submitRename() {
  const thread = renameThread.value
  const name = renameValue.value.trim()
  if (!thread || renaming.value) return
  if (!name || name.length > 80) { renameError.value = '名称不能为空且不能超过 80 个字符'; return }
  renaming.value = true; renameError.value = ''
  try {
    await post(`/api/threads/${thread.id}/name`, { name })
    const update = (item: Thread) => item.id === thread.id ? { ...item, name } : item
    threads.value = threads.value.map(update)
    localDraftThreads.value = localDraftThreads.value.map(update)
    if (selected.value?.id === thread.id) selected.value = { ...selected.value, name }
    const cached = threadCache.get(threadCacheKey(thread.id))
    if (cached) { cached.thread = { ...cached.thread, name }; rememberThreadRead(cached) }
    renameThread.value = null
  } catch (e) { renameError.value = e instanceof Error ? e.message : String(e) }
  finally { renaming.value = false }
}
function rememberPermission(value: 'ask' | 'auto' | 'full') {
  permissionMode.value = value
  localStorage.setItem('rmdex-permission-mode', value)
}
function rememberModel(value: string) {
  selectedModel.value = value
  const deviceKey = remoteDevice.value?.id || 'local'
  localStorage.setItem(`rmdex-model:${desktopMode.value ? `desktop:${deviceKey}` : deviceKey}`, value)
}
function rememberEffort(value: string) {
  selectedEffort.value = value
  const deviceKey = remoteDevice.value?.id || 'local'
  localStorage.setItem(`rmdex-effort:${desktopMode.value ? `desktop:${deviceKey}` : deviceKey}`, value)
}
function desktopSettings(): { model?: string; effort?: string } {
  if (!capabilities.value.models || !selectedModel.value || selectedModel.value === desktopDefaultModel) return {}
  return { model: selectedModel.value, ...(selectedEffort.value ? { effort: selectedEffort.value } : {}) }
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
    await hydrateThreadCache()
    const [result] = await Promise.all([
      loadThreads(),
      loadModels(),
    ])
    const deviceKey = remoteDevice.value?.id || 'local'
    threads.value = [...localDraftThreads.value.filter(thread => thread.desktopDraft?.deviceKey === deviceKey), ...new Map(result.map((thread) => [thread.id, thread])).values()]
    connected.value = true
  }
  catch (e) { connected.value = false; error.value = e instanceof Error ? e.message : String(e) }
  finally { loading.value = false }
}

async function openThread(thread: Thread) {
  const version = ++selectionVersion
  const cached = threadCache.get(threadCacheKey(thread.id))
  threadLoading.value = !cached; threadLoadError.value = ''; historyCursor.value = cached?.page?.hasMore ? cached.page.nextCursor : null; historyLoading.value = false; queuedUntil = 0
  selected.value = thread; activeTurnId.value = null; pendingApprovals.value = []; lastTurn.value = null; mobileDetail.value = true; error.value = ''
  if (cached) {
    applyRead(cloneRead(cached))
    threadLoading.value = false
    void readThread(thread.id, true).then(result => {
      if (version !== selectionVersion) return
      applyRead(result)
      historyCursor.value = result.page?.hasMore ? result.page.nextCursor : null
    }).catch(e => { if (version === selectionVersion) error.value = e instanceof Error ? e.message : String(e) })
    await nextTick()
    await scrollToLatest()
  }
  if (thread.desktopDraft) {
    threadLoading.value = false
    await nextTick()
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
    return
  }
  if (cached) return
  try {
    const result = await readThread(thread.id)
    if (version === selectionVersion) { applyRead(result); historyCursor.value = result.page?.hasMore ? result.page.nextCursor : null; threadLoading.value = false; await scrollToLatest() }
  }
  catch (e) { if (version === selectionVersion) threadLoadError.value = e instanceof Error ? e.message : String(e) }
  finally { if (version === selectionVersion) threadLoading.value = false }
}
async function loadOlder() {
  if (!selected.value || !historyCursor.value || historyLoading.value) return
  const id = selected.value.id
  const version = selectionVersion
  historyLoading.value = true
  try {
    const result = await post(`/api/threads/${id}/history`, { cursor: historyCursor.value }) as ReadResult
    if (version !== selectionVersion || !selected.value) return
    const element = conversation.value
    const height = element?.scrollHeight || 0
    selected.value.turns = [...new Map([...(result.thread.turns || []), ...(selected.value.turns || [])].map(turn => [turn.id, turn])).values()]
    // Register attachment downloads without replacing the live state with an older page.
    applyRead({ ...result, thread: selected.value, activeTurnId: activeTurnId.value, approvals: pendingApprovals.value, lastTurn: lastTurn.value })
    historyCursor.value = result.page?.hasMore ? result.page.nextCursor : null
    await nextTick()
    if (element) element.scrollTop += element.scrollHeight - height
  } catch (e) { if (version === selectionVersion) error.value = e instanceof Error ? e.message : String(e) }
  finally { if (version === selectionVersion) historyLoading.value = false }
}
async function updateThread() {
  if (!selected.value || selected.value.desktopDraft || pollBusy || threadLoading.value || threadLoadError.value) return
  const id = selected.value.id
  const version = selectionVersion
  const element = conversation.value
  const follow = element ? element.scrollHeight - element.scrollTop - element.clientHeight < 100 : false
  pollBusy = true
  try {
    if (desktopMode.value) {
      const result = await readThread(id, true)
      if (version === selectionVersion) { applyRead(result); if (follow) await scrollToLatest() }
    } else {
      const result = await get<ThreadStatus>(`/api/threads/${id}/status`)
      if (version === selectionVersion) {
        mergeThreadStatus(result)
        if (result.lastTurn?.id && !selected.value?.turns?.some(turn => turn.id === result.lastTurn?.id)) {
          const delta = await get<ReadResult>(`/api/threads/${id}/incremental`)
          if (version !== selectionVersion || !selected.value) return
          const mergedThread = { ...selected.value, ...delta.thread, turns: [...new Map([...(selected.value.turns || []), ...(delta.thread.turns || [])].map(turn => [turn.id, turn])).values()] }
          applyRead({ ...delta, thread: mergedThread, activeTurnId: result.activeTurnId, approvals: result.approvals, lastTurn: result.lastTurn })
          historyCursor.value = delta.page?.hasMore ? delta.page.nextCursor : historyCursor.value
        }
        if (follow) await scrollToLatest()
      }
    }
  } catch (e) { if (version === selectionVersion) error.value = e instanceof Error ? e.message : String(e) }
  finally { pollBusy = false }
}
async function post(path: string, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (clientToken.value) headers.Authorization = `Bearer ${clientToken.value}`
  const response = await fetch(apiUrl(path), { method: 'POST', headers, body: JSON.stringify(body) })
  const result = await readJsonResponse(response, `请求 ${path} 失败`)
  if (!response.ok) throw new Error(result?.error || '请求失败')
  return result
}
async function adminFetch<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${adminToken.value}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(apiUrl(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await readJsonResponse(response, `请求 ${path} 失败`)
  if (!response.ok) throw new Error(data?.error || '请求失败')
  return data as T
}
async function loginAdmin() {
  pairError.value = ''
  try {
    const response = await fetch(apiUrl('/api/auth/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: adminPassword.value }) })
    const result = await readJsonResponse(response, '登录失败')
    if (!response.ok) throw new Error(result?.error || '登录失败')
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
    const response = await fetch(apiUrl('/api/pair/claim'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) })
    const result = await response.json()
    if (response.status !== 202) throw new Error(result.error || '配对失败')
    history.replaceState({}, '', location.pathname)
    pairInput.value = ''
    pairLanding.value = false
    showDevices.value = false
    pairApprovalPage.value = true
    pairApprovalState.value = 'waiting'
    for (let attempt = 0; attempt < 150; attempt++) {
      const status = await fetch(apiUrl('/api/pair/status'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: result.requestId }) })
      const state = await status.json()
      if (state.status === 'approved' && state.token) {
        clientToken.value = state.token; localStorage.setItem('rmdex-client-token', state.token)
        pairApprovalPage.value = false; pairLanding.value = false; showDevices.value = false; await refresh(); return
      }
      if (state.status === 'denied') { pairApprovalState.value = 'denied'; pairError.value = '电脑端拒绝了配对请求'; return }
      if (state.status === 'expired') { pairApprovalState.value = 'expired'; pairError.value = '配对申请已过期'; return }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }
    pairApprovalState.value = 'error'
    throw new Error('等待电脑确认超时，请重新扫码')
  } catch (e) {
    pairApprovalPage.value = true; showDevices.value = false; pairApprovalState.value = 'error'; pairError.value = e instanceof Error ? e.message : String(e)
  } finally { mobilePairing.value = false }
}
function returnToPairingEntry() {
  pairApprovalPage.value = false
  pairApprovalState.value = 'waiting'
  pairError.value = ''
  pairLanding.value = true
  showDevices.value = true
}
async function scanPairCode() {
  if (scanningPair.value) return
  pairError.value = ''
  scanningPair.value = true
  try {
    const result = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
      scanInstructions: '将电脑端二维码放入取景框内',
      scanText: '扫描二维码',
      cancelButtonAccessibilityLabel: '取消扫码',
      torchButtonOnAccessibilityLabel: '关闭闪光灯',
      torchButtonOffAccessibilityLabel: '打开闪光灯',
    })
    const value = result.ScanResult?.trim()
    if (!value) return
    if (/^https?:\/\//i.test(value)) {
      await handlePairLink(value)
      return
    }
    const code = new URLSearchParams(value.replace(/^#/, '')).get('pair')
    if (code) {
      await claimPair(code)
      return
    }
    if (/^[A-Za-z0-9]{32}$/.test(value)) {
      pairInput.value = value
      await claimPair(value)
      return
    }
    throw new Error('二维码不是有效的 rmdex 配对二维码')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (!/cancel|canceled|cancelled|取消/i.test(message)) {
      pairError.value = message
      if (pairApprovalPage.value) pairApprovalState.value = 'error'
    }
  } finally { scanningPair.value = false }
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
  if (!capabilities.value.create) return
  createPath.value = selected.value?.cwd || 'D:\\WorkSpace'
  createProject.value = desktopProjects.value.find(project => project.path.toLowerCase() === createPath.value.toLowerCase())?.id || ''
  createError.value = ''
  showCreate.value = true
}
function operationId(key: string, signature: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null') as { signature: string; id: string } | null
    if (saved?.signature === signature && saved.id) return saved.id
  } catch { /* A damaged browser entry should not prevent a new operation. */ }
  const id = crypto.randomUUID()
  sessionStorage.setItem(key, JSON.stringify({ signature, id }))
  return id
}
async function createThread() {
  if (creating.value) return
  if (desktopMode.value) {
    const thread: Thread = {
      id: `draft-${crypto.randomUUID()}`, name: '新对话', turns: [], updatedAt: Date.now() / 1000,
      cwd: desktopProjects.value.find(project => project.id === createProject.value)?.path || '',
      desktopDraft: { projectId: createProject.value || null, deviceKey: remoteDevice.value?.id || 'local' },
    }
    localDraftThreads.value.unshift(thread)
    threads.value.unshift(thread)
    query.value = ''; showCreate.value = false
    await openThread(thread)
    return
  }
  creating.value = true; createError.value = ''
  try {
    const result = await post('/api/threads', { cwd: createPath.value }) as { thread?: Thread; outcome?: string; message?: string }
    if (result.outcome === 'uncertain') throw new Error(result.message || '创建结果未确认，请在 Desktop 核对')
    if (!result.thread) { showCreate.value = false; await refresh(); error.value = result.message || 'Desktop 正在准备会话，请稍后刷新'; return }
    const thread = result.thread
    query.value = ''
    threads.value = [thread, ...threads.value.filter(item => item.id !== thread.id)]
    showCreate.value = false
    await openThread(thread)
  } catch (e) { createError.value = e instanceof Error ? e.message : String(e) }
  finally { creating.value = false }
}
async function sendDesktopDraft(thread: Thread, text: string) {
  const draft = thread.desktopDraft!
  const key = `rmdex-create:${draft.deviceKey}:${thread.id}`
  const settings = desktopSettings()
  const result = await post('/api/threads', {
    text, projectId: draft.projectId, ...settings,
    operationId: operationId(key, JSON.stringify([text, draft.projectId, ...(settings.model ? [settings] : [])])),
  }) as { thread?: Thread; outcome?: string; message?: string }
  if (result.outcome === 'uncertain') throw new Error(result.message || '创建结果未确认，请在 Desktop 核对')
  if (!result.thread) {
    if (result.outcome !== 'preparing') throw new Error('Desktop 未返回会话，请核对桌面后再试')
    draft.preparing = true
    drafts.value[thread.id] = ''
    if (selected.value?.id === thread.id) error.value = result.message || 'Desktop 正在准备新会话，请稍后刷新会话列表'
    return
  }
  sessionStorage.removeItem(key)
  const created = result.thread
  localDraftThreads.value = localDraftThreads.value.filter(item => item.id !== thread.id)
  threads.value = [created, ...threads.value.filter(item => item.id !== thread.id && item.id !== created.id)]
  if (pendingMessages.value[thread.id]) pendingMessages.value[created.id] = pendingMessages.value[thread.id]!
  delete pendingMessages.value[thread.id]
  delete drafts.value[thread.id]
  queuedUntil = Date.now() + 60000
  if (selected.value?.id === thread.id) {
    ++selectionVersion
    selected.value = created
    sendingThreadId.value = created.id
    activeTurnId.value = 'desktop-queued'
    await updateThread()
    await scrollToLatest()
  }
}
async function send() {
  if (!selected.value || sending.value || activeTurnId.value || selected.value.desktopDraft?.preparing || !capabilities.value.send) return
  const thread = selected.value
  const id = selected.value.id
  const text = (drafts.value[id] || '').trim()
  if (!text) return
  if (capabilities.value.permissions && permissionMode.value === 'full' && !fullAccessConfirmed.value) { showFullAccessConfirm.value = true; return }
  fullAccessConfirmed.value = false
  sending.value = true; sendingThreadId.value = id; stopRequested.value = false; stopping.value = false; pendingMessages.value[id] = { text, previousCount: messages.value.filter(entry => entry.role === 'user' && entry.text === text).length }; error.value = ''; lastTurn.value = null
  await scrollToLatest()
  try {
    if (thread.desktopDraft) { await sendDesktopDraft(thread, text); return }
    const key = `rmdex-send:${remoteDevice.value?.id || 'local'}:${id}`
    const settings = desktopSettings()
    const result = await post(`/api/threads/${id}/send`, desktopMode.value ? {
      text, ...settings, operationId: operationId(key, settings.model ? JSON.stringify([text, settings]) : text),
    } : {
      text,
      permissionMode: permissionMode.value,
      model: selectedModel.value,
      effort: selectedEffort.value,
    })
    if (result.outcome === 'uncertain') throw new Error(result.message || '发送结果未确认，请在 Desktop 核对')
    sessionStorage.removeItem(key)
    if (desktopMode.value) queuedUntil = Date.now() + 60000
    if (drafts.value[id]?.trim() === text) drafts.value[id] = ''
    if (selected.value?.id === id) activeTurnId.value = result.turn?.id || activeTurnId.value
    if (result.turn?.id) trackTask(id, result.turn.id, text, thread.name || thread.preview || 'Codex 会话')
    if (stopRequested.value) {
      try { if (result.turn?.id) await post(`/api/threads/${id}/stop`, {}) }
      catch (e) { if (selected.value?.id === id) error.value = e instanceof Error ? e.message : String(e) }
      finally { stopRequested.value = false; stopping.value = false }
    }
    if (selected.value?.id === id) { await updateThread(); await scrollToLatest() }
  } catch (e) { delete pendingMessages.value[id]; stopRequested.value = false; stopping.value = false; if (selected.value?.id === id) error.value = e instanceof Error ? e.message : String(e) }
  finally { sending.value = false; sendingThreadId.value = null }
}
function onEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  void send()
}
async function stop() {
  if (!selected.value || stopping.value || !capabilities.value.stop) return
  if (sending.value && !activeTurnId.value) {
    stopRequested.value = true
    stopping.value = true
    return
  }
  if (!activeTurnId.value) return
  stopping.value = true
  try { await post(`/api/threads/${selected.value.id}/stop`, {}); await updateThread() }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { stopping.value = false }
}
async function decide(approval: Approval, decision: 'accept' | 'decline') {
  try { await post(`/api/approvals/${approval.id}`, { decision }); pendingApprovals.value = pendingApprovals.value.filter(item => item.id !== approval.id) }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
function date(value?: number) { return value ? new Date(value * 1000).toLocaleDateString() : '' }
async function handlePairLink(rawUrl: string) {
  const url = new URL(rawUrl)
  const code = new URLSearchParams(url.hash.slice(1)).get('pair')
  if (!code) return
  pairLanding.value = true
  showDevices.value = true
  if (!Capacitor.isNativePlatform()) history.replaceState({}, '', location.pathname)
  await claimPair(code)
}
onMounted(async () => {
  let handledLaunch = false
  for (const task of notificationTasks()) trackedTasks.set(task.threadId, { turnId: task.turnId, text: task.text, name: task.name })
  await setupNotifications()
  if (Capacitor.isNativePlatform()) {
    appUrlListener = await NativeApp.addListener('appUrlOpen', ({ url }) => { void handlePairLink(url) })
    const launch = await NativeApp.getLaunchUrl()
    if (launch?.url) { handledLaunch = true; await handlePairLink(launch.url) }
  }
  if (!handledLaunch) {
    const code = new URLSearchParams(location.hash.slice(1)).get('pair')
    if (code) await handlePairLink(location.href)
    else if (Capacitor.isNativePlatform() && !clientToken.value) { pairLanding.value = true; showDevices.value = true }
    else void refresh()
  }
  poll = setInterval(() => { updateThread(); if (adminToken.value && showDevices.value) void loadDevices() }, 2000)
  if (adminToken.value) void loadDevices()
})
onUnmounted(() => { if (poll) clearInterval(poll); clearThreadLongPress(); void appUrlListener?.remove(); void appStateListener?.remove(); void notificationListener?.remove() })
</script>

<template>
  <div class="shell">
    <aside id="thread-panel" class="thread-panel" :class="{ collapsed: !sidebarOpen, hiddenMobile: mobileDetail }">
      <div class="brand-row">
        <div class="brand"><img :src="logoUrl" alt="" /><span>rmdex</span></div>
        <button class="icon-button collapse-button" title="收起侧栏" aria-label="收起侧栏" aria-controls="thread-panel" :aria-expanded="sidebarOpen" @click="sidebarOpen = false"><PanelLeftClose :size="19" /></button>
      </div>
      <button class="new-thread" :disabled="!capabilities.create" @click="openCreate"><Plus :size="17" /><span>新建对话</span></button>
      <div class="device"><span class="device-icon"><Monitor :size="16" /></span><div class="device-copy"><strong>{{ remoteDevice?.name || (remoteMode ? '未连接 Codex 设备' : '本机设备') }}</strong><small>{{ connected ? '已连接' : (remoteMode ? '等待远程设备' : '未连接') }}</small></div><span class="online" :class="{ offline: !connected }"></span></div>
      <button class="pair-entry" type="button" @click="showDevices = true"><QrCode :size="16" /><span>连接设备</span><span class="pair-entry-hint">扫码配对</span></button>
      <label class="search"><Search :size="16" /><input v-model="query" placeholder="搜索会话" aria-label="搜索会话" /></label>
      <div class="section-label"><span>会话 <span class="count">{{ filtered.length }}</span></span><button class="icon-button" title="刷新会话" aria-label="刷新会话" :disabled="loading" @click="refresh"><RefreshCw :size="15" /></button></div>
      <div v-if="error && !connected" class="sidebar-error">{{ error }}</div>
      <div class="thread-list"><div v-for="thread in filtered" :key="thread.id" class="thread-row" @pointerdown="capabilities.rename && startThreadLongPress(thread)" @pointerup="clearThreadLongPress" @pointercancel="clearThreadLongPress" @pointerleave="clearThreadLongPress" @contextmenu.prevent="capabilities.rename && beginRename(thread)"><button class="thread" :class="{ selected: selected?.id === thread.id }" @click="threadMenuId = null; openThread(thread)"><span class="thread-title">{{ thread.name || thread.preview || '未命名会话' }}</span><span class="thread-meta">{{ date(thread.updatedAt) }}</span></button><button v-if="capabilities.rename" class="icon-button thread-menu-trigger" type="button" title="会话操作" aria-label="会话操作" @click.stop="openThreadMenu(thread)"><Ellipsis :size="17" /></button><div v-if="capabilities.rename && threadMenuId === thread.id" class="thread-menu" @click.stop><button type="button" @click="beginRename(thread)"><Pencil :size="14" />重命名</button><button type="button" @click="copyValue(thread.id); threadMenuId = null"><Copy :size="14" />复制会话 ID</button></div></div><div v-if="!filtered.length && !loading" class="empty-list">暂无会话</div></div>
      <footer class="side-footer"><span class="online" :class="{ offline: !connected }"></span> {{ remoteMode ? '远程设备' : '本机模式' }} <span class="footer-label">{{ connected ? '已连接' : '未连接' }}</span></footer>
    </aside>
    <main class="main" :class="{ hiddenMobile: !mobileDetail }">
      <header class="main-head"><button class="icon-button back" title="返回会话" aria-label="返回会话" @click="mobileDetail = false"><ArrowLeft :size="19" /></button><button v-if="!sidebarOpen" class="icon-button expand-button" title="展开侧栏" aria-label="展开侧栏" aria-controls="thread-panel" :aria-expanded="sidebarOpen" @click="sidebarOpen = true"><Menu :size="19" /></button><div class="heading"><strong>{{ selected?.name || selected?.preview || '会话' }}</strong><span v-if="selected">本机设备</span></div><span v-if="activeTurnId" class="readonly">执行中</span><button v-if="!sidebarOpen && capabilities.create" class="icon-button expand-button" title="新建对话" aria-label="新建对话" @click="openCreate"><Plus :size="19" /></button></header>
      <div v-if="error" class="error"><CircleAlert :size="18" /><span>{{ error }}</span><button @click="refresh">重试</button></div>
      <div v-if="!selected" class="welcome"><div class="welcome-icon"><MessageSquare :size="22" /></div><h2>选择一个会话</h2><p>查看你的 Codex 对话</p></div>
      <div v-else-if="threadLoading" class="thread-load-state" role="status" aria-live="polite"><LoaderCircle :size="20" class="working-spinner" /><span>正在加载历史会话…</span></div>
      <div v-else-if="threadLoadError" class="thread-load-state" role="alert"><CircleAlert :size="20" /><span>加载会话失败：{{ threadLoadError }}</span><button type="button" @click="openThread(selected)">重试</button></div>
      <div v-else ref="conversation" class="conversation"><div class="conversation-inner"><button v-if="historyCursor" class="history-button" :disabled="historyLoading" @click="loadOlder"><LoaderCircle v-if="historyLoading" :size="14" class="working-spinner" />{{ historyLoading ? '正在加载…' : '加载更早的消息' }}</button><div class="conversation-header"><h2>{{ selected.name || selected.preview || '未命名会话' }}</h2></div><div v-if="!messages.length && !pendingMessages[selected.id]" class="empty-messages">{{ selected.desktopDraft ? '从下方发送消息，开始新对话。' : '此会话暂无可显示的消息。' }}</div><template v-for="(message, i) in messages" :key="i"><details v-if="message.role === 'tools'" class="tool-group"><summary><Wrench :size="14" /><span>{{ toolSummary(message.items) }}</span><span v-if="message.items.some(item => item.status === 'failed' || item.status === 'declined' || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0))" class="group-failed">含失败</span><ChevronRight :size="14" class="group-chevron" /></summary><div class="tool-group-content"><ToolEvent v-for="(item, index) in message.items" :key="item.id || index" :item="item" /></div></details><article v-else class="message" :class="`message--${message.role}`" :aria-label="message.role === 'user' ? '用户消息' : 'Codex 回复'"><div class="message-body"><div v-if="message.images.length" class="attachments"><template v-for="(image, index) in message.images" :key="index"><a v-if="imageSource(image)" :href="imageSource(image)" target="_blank" rel="noopener noreferrer" class="attachment"><img :src="imageSource(image)" alt="图片附件" loading="lazy" /></a><span v-else class="attachment-unavailable">图片附件不可用</span></template></div><div v-if="message.text" class="message-text markdown" v-html="markdown.render(message.text)"></div></div></article></template><article v-if="pendingMessages[selected.id]" class="message message--user" aria-label="待显示的用户消息"><div class="message-body"><div class="message-text markdown" v-html="markdown.render(pendingMessages[selected.id]!.text)"></div></div></article><div v-if="working" class="working" role="status" aria-live="polite"><LoaderCircle :size="16" class="working-spinner" /><span>{{ workLabel }}</span></div><div v-else-if="lastTurn?.status === 'failed'" class="turn-failure" role="alert">执行失败<span v-if="lastTurn.error?.message">：{{ lastTurn.error.message }}</span></div></div></div>
      <div v-if="selected && !threadLoading && !threadLoadError" class="compose-area">
        <p v-if="desktopMode" class="desktop-hint">{{ capabilities.models ? '模型与推理强度可在右侧选择；权限、审批和暂停请在 Desktop 处理。' : '当前设备未提供可识别的模型目录；模型、权限、审批和暂停请在 Desktop 处理。' }}</p><div v-for="approval in (capabilities.approvals ? pendingApprovals : [])" :key="approval.id" class="approval"><strong>{{ approval.method.includes('commandExecution') ? '命令执行需要确认' : '文件修改需要确认' }}</strong><p v-if="approval.params.reason">{{ approval.params.reason }}</p><pre v-if="approval.params.command">{{ approval.params.command }}</pre><p v-if="approval.params.cwd">工作目录：{{ approval.params.cwd }}</p><p v-if="approval.params.grantRoot">授权目录：{{ approval.params.grantRoot }}</p><details><summary>完整请求信息</summary><pre>{{ JSON.stringify(approval.params, null, 2) }}</pre></details><p v-if="approval.method.includes('fileChange')">请先在上方工具调用中查看文件变更，再决定是否允许。</p><div class="approval-actions"><button @click="decide(approval, 'decline')">拒绝</button><button @click="decide(approval, 'accept')">允许本次</button></div></div>
        <form class="composer" @submit.prevent="send"><textarea v-model="drafts[selected.id]" placeholder="给 Codex 发送消息" aria-label="消息" rows="2" :disabled="sending || !!activeTurnId || !!selected.desktopDraft?.preparing || !capabilities.send" @keydown.enter.exact="onEnter"></textarea><div class="compose-actions"><PermissionMenu v-if="capabilities.permissions" :model-value="permissionMode" :disabled="working" @update:model-value="rememberPermission" /><div class="compose-right"><ModelMenu v-if="capabilities.models" :models="models" :model-value="selectedModel" :effort="selectedEffort" :loading="modelLoading" :disabled="working || sending" @update:model-value="rememberModel" @update:effort="rememberEffort" /><button v-if="working && capabilities.stop" type="button" class="send-button stop-button" :class="{ 'is-stopping': stopping }" :title="stopping ? '正在暂停' : '暂停任务'" :aria-label="stopping ? '正在暂停' : '暂停任务'" :disabled="stopping && !!activeTurnId" @click="stop"><Square :size="14" fill="currentColor" /></button><button v-else-if="working" type="button" class="send-button" disabled title="Desktop 正在工作"><LoaderCircle :size="18" class="working-spinner" /></button><button v-else type="submit" class="send-button" title="发送消息" aria-label="发送消息" :disabled="sending || !capabilities.send || !drafts[selected.id]?.trim()"><ArrowUp :size="18" /></button></div></div></form>
      </div>
    </main>
    <div v-if="showFullAccessConfirm" class="modal-backdrop" @click.self="showFullAccessConfirm = false"><section class="create-dialog risk-dialog" role="dialog" aria-modal="true" aria-labelledby="full-access-title" @keydown.esc="showFullAccessConfirm = false"><header><div class="risk-heading"><span class="risk-icon"><ShieldAlert :size="19" /></span><div><h2 id="full-access-title">确认使用完全访问</h2><p>这次消息将跳过 Codex 审批。</p></div></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showFullAccessConfirm = false"><X :size="18" /></button></header><div class="risk-copy"><p>完全访问模式允许 Codex 直接执行命令、修改工作目录中的文件，并访问电脑上的网络资源。</p><p>只在你明确知道这条消息会做什么时继续。你也可以取消后切换为“请求审批”。</p></div><div class="dialog-actions"><button type="button" class="cancel-button" @click="showFullAccessConfirm = false">取消</button><button type="button" class="danger-confirm-button" @click="showFullAccessConfirm = false; fullAccessConfirmed = true; send()">继续发送</button></div></section></div>
    <div v-if="showCreate" class="modal-backdrop" @click.self="!creating && (showCreate = false)"><section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title" @keydown.esc="!creating && (showCreate = false)"><header><h2 id="create-title">新建对话</h2><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="creating" @click="showCreate = false"><X :size="18" /></button></header><form @submit.prevent="createThread"><template v-if="desktopMode"><label>项目</label><div class="desktop-project-options"><button type="button" :class="{ chosen: !createProject }" @click="createProject = ''">独立会话</button><button v-for="project in desktopProjects" :key="project.id" type="button" :class="{ chosen: createProject === project.id }" @click="createProject = project.id">{{ project.name || project.path }}</button></div></template><template v-else><label for="working-directory">工作目录</label><input id="working-directory" v-model="createPath" required autocomplete="off" placeholder="例如 D:\WorkSpace\rmdex" /></template><p v-if="createError" class="create-error" role="alert">{{ createError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="creating" @click="showCreate = false">取消</button><button type="submit" class="create-button" :disabled="creating || (!desktopMode && !createPath.trim())">{{ creating ? '创建中…' : '创建对话' }}</button></div></form></section></div>
    <div v-if="renameThread" class="modal-backdrop" @click.self="!renaming && (renameThread = null)"><section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title" @keydown.esc="!renaming && (renameThread = null)"><header><div><h2 id="rename-title">重命名会话</h2><p>名称只影响 rmdex 显示，不会修改消息内容。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="renaming" @click="renameThread = null"><X :size="18" /></button></header><form @submit.prevent="submitRename"><label for="thread-name">会话名称</label><input id="thread-name" v-model="renameValue" maxlength="80" autocomplete="off" /><p v-if="renameError" class="create-error" role="alert">{{ renameError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="renaming" @click="renameThread = null">取消</button><button type="submit" class="create-button" :disabled="renaming || !renameValue.trim()">{{ renaming ? '保存中…' : '保存名称' }}</button></div></form></section></div>
    <div v-if="pairApprovalPage" class="pair-status-backdrop"><section class="pair-status-page" role="dialog" aria-modal="true" aria-labelledby="pair-status-title"><button class="icon-button pair-status-close" type="button" title="返回设备连接" aria-label="返回设备连接" @click="returnToPairingEntry"><X :size="18" /></button><div class="pair-status-icon" :class="`is-${pairApprovalState}`"><LoaderCircle v-if="pairApprovalState === 'waiting'" :size="28" class="working-spinner" /><CircleAlert v-else :size="28" /></div><h2 id="pair-status-title">{{ pairApprovalState === 'waiting' ? '等待电脑端确认' : pairApprovalState === 'denied' ? '配对请求未通过' : pairApprovalState === 'expired' ? '配对请求已过期' : '配对暂时没有完成' }}</h2><p class="pair-status-copy">{{ pairApprovalState === 'waiting' ? '配对申请已经发送到电脑端，请在 Codex Desktop 中允许这台手机连接。' : pairError }}</p><div v-if="pairApprovalState === 'waiting'" class="pair-status-waiting"><span class="online"></span><span>正在等待电脑端审批</span></div><div v-else class="pair-status-actions"><button class="create-button" type="button" :disabled="scanningPair" @click="scanPairCode"><QrCode :size="16" />重新扫描二维码</button><button class="cancel-button" type="button" @click="returnToPairingEntry">手动输入配对码</button></div><form v-if="pairApprovalState !== 'waiting'" class="pair-status-manual" @submit.prevent="claimPair()"><label for="pair-status-code">输入 32 位配对码</label><div><input id="pair-status-code" v-model="pairInput" maxlength="32" inputmode="text" autocomplete="off" placeholder="输入配对码" /><button class="create-button" type="submit" :disabled="pairInput.length !== 32 || mobilePairing">继续</button></div></form></section></div>
    <div v-if="showDevices" class="modal-backdrop" @click.self="showDevices = false"><section class="create-dialog device-dialog" role="dialog" aria-modal="true" aria-labelledby="devices-title" @keydown.esc="showDevices = false"><header><div><h2 id="devices-title">设备连接</h2><p>管理 Codex 电脑与手机配对</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showDevices = false"><X :size="18" /></button></header>
      <form v-if="!adminToken && !pairLanding" class="admin-login" @submit.prevent="loginAdmin"><label for="admin-password">设备管理员密码</label><p class="dialog-hint">登录后才能管理 Codex 电脑、生成手机配对码和审批手机连接。</p><input id="admin-password" v-model="adminPassword" type="password" autocomplete="current-password" required placeholder="输入服务器管理员密码" /><button class="create-button" type="submit">登录管理设备</button></form>
      <template v-else-if="adminToken"><div class="admin-status"><span class="online"></span><span>管理员已验证</span></div><form class="register-device" @submit.prevent="registerDevice"><input v-model="deviceName" aria-label="设备名称" maxlength="80" /><button class="create-button" type="submit"><Plus :size="15" />注册此电脑</button></form>
        <div v-if="newDeviceToken" class="device-secret"><strong>设备密钥只显示这一次</strong><p>将它配置在运行 Codex Desktop 的电脑上。不要发送给其他人。</p><code>{{ newDeviceToken }}</code><button class="copy-button" type="button" @click="copyValue(newDeviceToken)"><Copy :size="15" />复制密钥</button><small>电脑代理环境变量：RMDEX_RELAY_URL=wss://code.kyeai.xyz/agent，RMDEX_DEVICE_TOKEN=上方密钥</small></div>
        <div v-if="pairRequests.length" class="pair-requests"><strong>等待确认的手机</strong><div v-for="request in pairRequests" :key="request.id" class="pair-request"><span>{{ request.name }}</span><button type="button" @click="decidePair(request.id, 'deny')">拒绝</button><button type="button" class="approve-pair" @click="decidePair(request.id, 'approve')">允许</button></div></div>
        <div class="device-list"><div v-for="device in devices" :key="device.id" class="device-row"><span class="device-icon"><Monitor :size="16" /></span><div class="device-copy"><strong>{{ device.name }}</strong><small>{{ device.online ? '在线' : '离线' }}</small></div><span class="online" :class="{ offline: !device.online }"></span><button class="icon-button" :class="{ 'connect-device-button': remoteDevice?.id !== device.id }" title="连接此设备" aria-label="连接此设备" :disabled="!device.online" @click="connectDevice(device.id)"><MessageSquare :size="16" /></button><button class="icon-button" title="生成手机配对码" aria-label="生成手机配对码" @click="createPair(device.id)"><Smartphone :size="16" /></button><button class="icon-button revoke-button" title="撤销设备" aria-label="撤销设备" @click="revokeDevice(device.id)"><Trash2 :size="15" /></button></div><p v-if="!devices.length" class="device-empty">尚未注册 Codex 电脑</p></div>
        <div v-if="pairCode" class="pair-result"><img :src="pairQr" alt="手机扫码配对二维码" /><div><strong>手机扫码配对</strong><p>二维码和配对码 3 分钟内有效，只能使用一次。</p><code>{{ pairCode }}</code><button class="copy-button" type="button" @click="copyValue(pairUrl)"><Copy :size="15" />复制配对链接</button></div></div>
      </template>
      <template v-else-if="pairLanding"><div class="mobile-pair-intro"><Smartphone :size="22" /><div><strong>申请连接 Codex 电脑</strong><p>配对申请会发送到电脑端，等待管理员允许后即可使用。</p></div></div><button class="create-button scan-pair-button" type="button" :disabled="scanningPair || mobilePairing" @click="scanPairCode"><QrCode :size="16" />{{ scanningPair ? '正在打开扫码…' : '扫描电脑二维码' }}</button><form class="claim-pair" @submit.prevent="claimPair()"><label for="pair-code">二维码无法识别时，输入配对码</label><div><input id="pair-code" v-model="pairInput" maxlength="32" placeholder="输入配对码" /><button class="create-button" type="submit" :disabled="pairInput.length !== 32 || mobilePairing">配对</button></div></form><p v-if="mobilePairing && !pairError" class="pair-waiting" role="status"><LoaderCircle :size="15" class="working-spinner" />配对申请已发送，请在电脑端允许此手机连接。</p></template>
      <p v-if="pairError" class="create-error" role="alert">{{ pairError }}</p>
    </section></div>
  </div>
</template>
