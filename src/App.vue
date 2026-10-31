<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { App as NativeApp } from '@capacitor/app'
import { LocalNotifications } from '@capacitor/local-notifications'
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner'
import MarkdownIt from 'markdown-it'
import { Archive, ArrowLeft, ArrowUp, Bot, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CornerDownRight, Ellipsis, ExternalLink, Eye, EyeOff, Folder, FolderPlus, GitFork, LoaderCircle, LogOut, Menu, MessageSquare, Monitor, PanelLeftClose, Paperclip, Pencil, Pin, Plus, RefreshCw, RotateCcw, Search, Square, Users, Wrench, X, QrCode, Copy, Smartphone, Trash2, ShieldAlert } from 'lucide-vue-next'
import QRCode from 'qrcode'
import logoUrl from './assets/rmdex-logo.jpg'
import ToolEvent from './components/ToolEvent.vue'
import MessageBubble from './components/MessageBubble.vue'
import PermissionMenu from './components/PermissionMenu.vue'
import ModelMenu, { type ModelOption } from './components/ModelMenu.vue'
import ProjectMenu from './components/ProjectMenu.vue'
import UserMenu from './components/UserMenu.vue'
import { messageRequest, timeline, userText, type ContentPart, type MessageEntry, type Turn } from './conversation'
import { loadThreadCache, queueThreadCacheWrite, removeThreadCache } from './thread-cache'

type Thread = { id: string; name?: string | null; preview?: string; cwd?: string; updatedAt?: number; status?: { type: string }; turns?: Turn[]; employeeId?: string; desktopDraft?: { projectId: string | null; deviceKey: string; preparing?: boolean } }
type Project = { id: string; name: string; path: string; source: 'local' | 'desktop'; nativeProjectId?: string }
type Employee = { id: string; name: string; role: string; instructions: string; deviceId: string; projectPath: string; threadId?: string; initializedThreadId?: string; createdAt: number; updatedAt: number }
const apiBase = Capacitor.isNativePlatform() ? 'https://code.kyeai.xyz' : ''
const apiUrl = (path: string) => path.startsWith('http://') || path.startsWith('https://') ? path : `${apiBase}${path}`
const RmdexBackgroundService = registerPlugin<{ start(options: { relayUrl: string; pushToken: string }): Promise<void>; stop(): Promise<void> }>('RmdexBackgroundService')
let appUrlListener: { remove: () => Promise<void> } | undefined
const threads = ref<Thread[]>([])
const employees = ref<Employee[]>([])
const localDraftThreads = ref<Thread[]>([])
const selected = ref<Thread | null>(null)
const activeEmployeeId = ref<string | null>(null)
const query = ref('')
const loading = ref(false)
const threadLoading = ref(false)
const threadLoadError = ref('')
const error = ref('')
const connected = ref(false)
const connectionState = ref<'connected' | 'reconnecting' | 'offline'>('offline')
const connectionErrorDetail = ref('')
const nextReconnectAt = ref(0)
const showConnectionDetails = ref(false)
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
let reconnectAttempt = 0
const remoteDevice = ref<{ id: string; name: string; online: boolean } | null>(null)
const authenticatedImages = ref<Record<string, string>>({})
const imageLoads = new Map<string, Promise<string | undefined>>()
const previewImageUrl = ref('')
const showDevices = ref(false)
const showRegisterDevice = ref(false)
const showPairDialog = ref(false)
const registerDeviceMode = ref<'guide' | 'manual'>('guide')
const adminUsername = ref(localStorage.getItem('rmdex-admin-username') || 'admin')
const adminPassword = ref('')
const loginError = ref('')
const loginLoading = ref(false)
const authReady = ref(false)
const activePage = ref<'workspace' | 'users'>('workspace')
const showCreateUser = ref(false)
const creatingUser = ref(false)
const showUserPassword = ref(false)
const userPasswordConfirm = ref('')
const userFormError = ref('')
const adminToken = ref(sessionStorage.getItem('rmdex-admin-token') || localStorage.getItem('rmdex-admin-access-token') || '')
const adminRefreshToken = ref(localStorage.getItem('rmdex-admin-refresh-token') || '')
const isPlatformAdmin = ref(false)
const clientToken = ref(localStorage.getItem('rmdex-client-token') || localStorage.getItem('rmdex-client-access-token') || '')
const clientRefreshToken = ref(localStorage.getItem('rmdex-client-refresh-token') || '')
const devices = ref<Array<{ id: string; name: string; online: boolean }>>([])
const users = ref<Array<{ id: string; username: string; role?: string; deviceCount?: number }>>([])
const onlineDeviceCounts = ref<Record<string, number>>({})
const selectedUserId = ref('')
const userUsername = ref('')
const userPassword = ref('')
const createdUserCredentials = ref<{ username: string; password: string } | null>(null)
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
const threadActionId = ref<string | null>(null)
const threadActionError = ref('')
const copyFeedback = ref('')
let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined
const deleteThreadTarget = ref<Thread | null>(null)
const archivedThreads = ref<Thread[]>([])
const pinnedThreads = ref<string[]>([])
const showArchivedThreads = ref(false)
const swipeOpenId = ref<string | null>(null)
let touchStartX = 0
let touchCurrentX = 0
let touchThreadId = ''
let touchMoved = false
const renameThread = ref<Thread | null>(null)
const renameValue = ref('')
const renameError = ref('')
const renaming = ref(false)
let selectionVersion = 0
const mobileDetail = ref(false)
const sidebarOpen = ref(true)
const creating = ref(false)
const showCreate = ref(false)
const employeeEditor = ref(false)
const editingEmployeeId = ref<string | null>(null)
const employeeName = ref('')
const employeeRole = ref('')
const employeeInstructions = ref('')
const employeeProjectPath = ref('')
const employeeError = ref('')
const employeeSaving = ref(false)
const employeeResetting = ref<string | null>(null)
const createPath = ref('')
const createError = ref('')
const createProject = ref('')
const projects = ref<Project[]>([])
const collapsedProjectIds = ref<string[]>([])
const projectEditor = ref(false)
const editingProjectId = ref<string | null>(null)
const projectName = ref('')
const projectPath = ref('')
const projectError = ref('')
const projectSaving = ref(false)
const deleteProjectTarget = ref<Project | null>(null)
const desktopProjects = ref<Array<{ id: string; name: string; path: string }>>([])
const defaultCapabilities = { mode: 'app-server', models: true, permissions: true, stop: true, approvals: true, create: true, send: true, queue: true, steer: true, rename: true, fork: true, archive: true, delete: true, history: false, createRequiresPrompt: false }
const capabilities = ref({ ...defaultCapabilities })
const desktopMode = computed(() => capabilities.value.mode === 'desktop')
const historyCursor = ref<string | null>(null)
const historyLoading = ref(false)
let queuedUntil = 0
const conversation = ref<HTMLElement | null>(null)
async function scrollToLatest() { await nextTick(); if (conversation.value) conversation.value.scrollTop = conversation.value.scrollHeight }
const drafts = ref<Record<string, string>>({})
const attachmentsByThread = ref<Record<string, File[]>>({})
const selectedAttachments = computed(() => selected.value ? attachmentsByThread.value[selected.value.id] || [] : [])
const attachmentPreviewUrls = new WeakMap<File, string>()
const swipeActionWidth = Capacitor.isNativePlatform() ? 240 : 204
const sending = ref(false)
const sendingThreadId = ref<string | null>(null)
const activeTurnId = ref<string | null>(null)
const stopRequested = ref(false)
const stopping = ref(false)
const pendingMessages = ref<Record<string, { text: string; previousCount: number; attachmentNames?: string[] }>>({})
type RetrySubmission = { threadId: string; deviceKey: string; text: string; files: File[]; failedId?: string }
type FailedMessage = RetrySubmission & { id: string; previousTurnIds: string[]; error: string }
const failedMessages = ref<Record<string, FailedMessage[]>>({})
const retrying = ref(false)
let fullAccessRetry: RetrySubmission | undefined
type QueuedSubmission = { id: string; input?: Array<{ type?: string; text?: string }>; clientUserMessageId?: string }
const queuedSubmissions = ref<QueuedSubmission[]>([])
const queueActionId = ref<string | null>(null)
const queueMenuId = ref<string | null>(null)
const composerInput = ref<HTMLTextAreaElement | null>(null)
const threadIndicators = ref<Record<string, 'working' | 'completed' | 'failed'>>({})
const permissionMode = ref<'ask' | 'auto' | 'full'>((localStorage.getItem('rmdex-permission-mode') as 'ask' | 'auto' | 'full' | null) || 'ask')
const showFullAccessConfirm = ref(false)
const fullAccessConfirmed = ref(false)
const skipFullAccessConfirm = ref(localStorage.getItem('rmdex-skip-full-access-confirm') === '1')
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
let threadStatusPollBusy = false
let appStateListener: { remove: () => Promise<void> } | undefined
let notificationListener: { remove: () => Promise<void> } | undefined
let appActive = true
let notificationSetupPromise: Promise<boolean> | undefined
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
  const pinOrder = (thread: Thread) => {
    const index = pinnedThreads.value.indexOf(thread.id)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  if (pinOrder(a) !== pinOrder(b)) return pinOrder(a) - pinOrder(b)
  const active = (value: Thread) => ['active', 'inProgress', 'running'].includes(value.status?.type || '') ? 1 : 0
  return active(b) - active(a) || (b.updatedAt || 0) - (a.updatedAt || 0)
}))
const archivedIds = computed(() => new Set(archivedThreads.value.map(thread => thread.id)))
const visibleThreadPool = computed(() => {
  const current = orderedThreads.value.filter(thread => showArchivedThreads.value || !archivedIds.value.has(thread.id))
  if (!showArchivedThreads.value) return current
  return [...new Map([...current, ...archivedThreads.value].map(thread => [thread.id, thread])).values()]
})
const filtered = computed(() => visibleThreadPool.value.filter((t) => `${t.name || ''} ${t.preview || ''} ${t.cwd || ''}`.toLowerCase().includes(query.value.toLowerCase())))
function normalizedProjectPath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
function projectForThread(thread: Thread) {
  if (!thread.cwd) return undefined
  const cwd = normalizedProjectPath(thread.cwd)
  return projects.value
    .filter(project => {
      const root = normalizedProjectPath(project.path)
      return cwd === root || cwd.startsWith(`${root}/`)
    })
    .sort((a, b) => normalizedProjectPath(b.path).length - normalizedProjectPath(a.path).length)[0]
}
const pinnedRootThreads = computed(() => filtered.value.filter(thread => isPinned(thread.id)))
const projectGroups = computed(() => projects.value.map(project => ({
  project,
  threads: filtered.value.filter(thread => !isPinned(thread.id) && projectForThread(thread)?.id === project.id),
})).filter(group => {
  const search = query.value.trim().toLowerCase()
  return !search || group.threads.length > 0 || `${group.project.name} ${group.project.path}`.toLowerCase().includes(search)
}))
const otherThreads = computed(() => filtered.value.filter(thread => !isPinned(thread.id) && !projectForThread(thread)))
function threadIndicator(thread: Thread) {
  if (selected.value?.id === thread.id && activeTurnId.value) return 'working'
  const type = thread.status?.type || ''
  if (['active', 'inProgress', 'running'].includes(type)) return 'working'
  return threadIndicators.value[thread.id] || null
}
const remoteMode = computed(() => Capacitor.isNativePlatform() || !!clientToken.value || (import.meta.env.DEV && new URLSearchParams(location.search).has('authPreview')) || !['localhost', '127.0.0.1'].includes(location.hostname))
const requiresLogin = computed(() => remoteMode.value && !adminToken.value && !pairLanding.value)
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
function itemText(item: Turn['items'][number]) {
  if (item.type !== 'userMessage' || !Array.isArray(item.content)) return ''
  return item.content.filter(part => part.type === 'text').map(part => part.text || '').join('\n').trim()
}
function normalizeTurns(turns: Turn[] | undefined) {
  return (turns || []).map(turn => {
    const seenIds = new Set<string>()
    const seenUserTexts = new Set<string>()
    const items = (turn.items || []).filter(item => {
      if (item.id && seenIds.has(item.id)) return false
      if (item.id) seenIds.add(item.id)
      const text = itemText(item)
      if (!text) return true
      if (seenUserTexts.has(text)) return false
      seenUserTexts.add(text)
      return true
    })
    return { ...turn, items }
  })
}
function normalizeRead(result: ReadResult): ReadResult {
  return { ...result, thread: { ...result.thread, turns: normalizeTurns(result.thread.turns) } }
}
function cloneRead(result: ReadResult): ReadResult {
  // Read results are JSON API data. Vue turns selected threads into reactive
  // proxies, which Android WebView cannot structuredClone before IndexedDB
  // persistence. Snapshot through JSON at the cache boundary instead.
  return normalizeRead(JSON.parse(JSON.stringify(result)) as ReadResult)
}
function rememberThreadRead(result: ReadResult) {
  const key = threadCacheKey(result.thread.id)
  const copy = cloneRead(result)
  threadCache.set(key, copy)
  queueThreadCacheWrite(key, copy)
}
function pendingMessageVisible(thread: Thread | null) {
  if (!thread) return false
  const pending = pendingMessages.value[thread.id]
  if (!pending) return false
  const count = timeline(normalizeTurns(thread.turns)).filter(entry => entry.role === 'user' && pendingTextMatches(entry.text, pending.text)).length
  return count <= pending.previousCount
}
function pendingTextMatches(message: string, pending: string) {
  return message === pending || (!pending && message.startsWith('附件：')) || message.startsWith(`${pending}\n\n附件：`)
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
async function setupNotifications(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false
  if (notificationSetupPromise) return notificationSetupPromise
  const setup = (async () => {
    try {
      let permission = await LocalNotifications.checkPermissions()
      if (permission.display !== 'granted') permission = await LocalNotifications.requestPermissions()
      if (permission.display !== 'granted') return false
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
      return true
    } catch { /* Notifications are optional on devices that deny permission. */ return false }
  })()
  notificationSetupPromise = setup
  const ready = await setup
  if (!ready && notificationSetupPromise === setup) notificationSetupPromise = undefined
  return ready
}
function installationId() {
  const key = 'rmdex-installation-id'
  let value = localStorage.getItem(key) || ''
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    value = crypto.randomUUID().replace(/[^A-Za-z0-9_-]/g, '')
    localStorage.setItem(key, value)
  }
  return value
}
async function setupBackgroundNotifications() {
  if (!Capacitor.isNativePlatform() || !clientToken.value) return
  try {
    if (!await setupNotifications()) return
    let pushToken = localStorage.getItem('rmdex-background-push-token') || ''
    if (!pushToken) {
      const result = await post('/api/push/register', { installationId: installationId(), clientName: 'rmdex Android' }) as { pushToken: string }
      pushToken = result.pushToken
      localStorage.setItem('rmdex-background-push-token', pushToken)
    }
    await RmdexBackgroundService.start({ relayUrl: apiBase, pushToken })
  } catch { /* The foreground service is optional on web and older Android installs. */ }
}
function stopBackgroundNotifications() {
  if (Capacitor.isNativePlatform()) void RmdexBackgroundService.stop().catch(() => {})
  localStorage.removeItem('rmdex-background-push-token')
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
      if (item.type === 'userMessage') {
        const text = itemText(item)
        if (text && turn.items.some(existing => itemText(existing) === text)) continue
      }
      const index = turn.items.findIndex(existing => existing.id && existing.id === item.id)
      if (index < 0) turn.items.push(item)
      else turn.items[index] = item
    }
  }
  selected.value.turns = normalizeTurns(selected.value.turns)
  activeTurnId.value = result.activeTurnId
  pendingApprovals.value = result.approvals || []
  lastTurn.value = result.lastTurn || null
  if (result.activeTurnId) threadIndicators.value[result.threadId] = 'working'
  else if (result.lastTurn?.status && ['completed', 'interrupted', 'failed', 'error'].includes(result.lastTurn.status)) threadIndicators.value[result.threadId] = ['failed', 'error'].includes(result.lastTurn.status) ? 'failed' : 'completed'
  rememberThreadRead({ thread: selected.value, activeTurnId: activeTurnId.value, approvals: pendingApprovals.value, lastTurn: lastTurn.value, page: threadCache.get(threadCacheKey(result.threadId))?.page })
  maybeNotifyTaskComplete(result)
}
function applyRead(result: ReadResult) {
  result = normalizeRead(result)
  if (desktopMode.value && selected.value?.id === result.thread.id) {
    result.thread.turns = [...new Map([...(selected.value.turns || []), ...(result.thread.turns || [])].map(turn => [turn.id, turn])).values()]
    result.thread.turns = normalizeTurns(result.thread.turns)
  }
  selected.value = result.thread; activeTurnId.value = result.activeTurnId; pendingApprovals.value = result.approvals || []; lastTurn.value = result.lastTurn || null
  if (result.activeTurnId) threadIndicators.value[result.thread.id] = 'working'
  else if (result.lastTurn?.status && ['completed', 'interrupted', 'failed', 'error'].includes(result.lastTurn.status)) threadIndicators.value[result.thread.id] = ['failed', 'error'].includes(result.lastTurn.status) ? 'failed' : 'completed'
  for (const turn of result.thread.turns || []) for (const item of turn.items || []) {
    if (typeof item.assetUrl === 'string') queueImageLoad(item.assetUrl)
    for (const part of item.content || []) if (part.assetUrl) queueImageLoad(part.assetUrl)
  }
  const pending = pendingMessages.value[result.thread.id]
  if (pending && timeline(result.thread.turns || []).filter(entry => entry.role === 'user' && pendingTextMatches(entry.text, pending.text)).length > pending.previousCount) delete pendingMessages.value[result.thread.id]
  if (desktopMode.value && !activeTurnId.value && pendingMessages.value[result.thread.id] && Date.now() < queuedUntil) activeTurnId.value = 'desktop-queued'
  rememberThreadRead({ thread: selected.value, activeTurnId: activeTurnId.value, approvals: pendingApprovals.value, lastTurn: lastTurn.value, page: result.page })
}
function queueImageLoad(assetUrl: string) {
  if (authenticatedImages.value[assetUrl] || imageLoads.has(assetUrl)) return
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
function toolImageSource(item: Record<string, unknown>) {
  const assetUrl = typeof item.assetUrl === 'string' ? item.assetUrl : ''
  if (assetUrl) return authenticatedImages.value[assetUrl]
  const url = typeof item.url === 'string' ? item.url : ''
  if (/^https:\/\//i.test(url) || /^data:image\//i.test(url)) return url
  return undefined
}
function showImagePreview(url: string) { previewImageUrl.value = url }
function closeImagePreview() { previewImageUrl.value = '' }
function handlePreviewKey(event: KeyboardEvent) { if (event.key === 'Escape' && previewImageUrl.value) closeImagePreview() }

async function readJsonResponse(response: Response, fallback: string) {
  const text = await response.text()
  if (!text.trim()) throw new Error(`${fallback}（服务器返回了空响应，设备可能正在重连）`)
  try {
    return JSON.parse(text) as any
  } catch {
    throw new Error(`${fallback}（服务器返回了无效 JSON）`)
  }
}
type AuthKind = 'admin' | 'client'
let adminRefreshPromise: Promise<boolean> | undefined
let clientRefreshPromise: Promise<boolean> | undefined
function storeSession(kind: AuthKind, result: { accessToken?: string; refreshToken?: string; token?: string; clientToken?: string }) {
  const access = result.accessToken || result.token || result.clientToken || ''
  if (kind === 'admin') {
    adminToken.value = access
    adminRefreshToken.value = result.refreshToken || adminRefreshToken.value
    sessionStorage.setItem('rmdex-admin-token', access)
    localStorage.setItem('rmdex-admin-access-token', access)
    if (result.refreshToken) localStorage.setItem('rmdex-admin-refresh-token', result.refreshToken)
  } else {
    clientToken.value = access
    clientRefreshToken.value = result.refreshToken || clientRefreshToken.value
    localStorage.setItem('rmdex-client-token', access)
    localStorage.setItem('rmdex-client-access-token', access)
    if (result.refreshToken) localStorage.setItem('rmdex-client-refresh-token', result.refreshToken)
    if (Capacitor.isNativePlatform()) void setupBackgroundNotifications()
  }
}
function clearSession(kind: AuthKind) {
  if (kind === 'admin') {
    adminToken.value = ''; adminRefreshToken.value = ''
    sessionStorage.removeItem('rmdex-admin-token')
    localStorage.removeItem('rmdex-admin-access-token'); localStorage.removeItem('rmdex-admin-refresh-token')
  } else {
    void post('/api/push/unregister', { installationId: installationId() }).catch(() => {})
    stopBackgroundNotifications()
    clientToken.value = ''; clientRefreshToken.value = ''
    localStorage.removeItem('rmdex-client-token'); localStorage.removeItem('rmdex-client-access-token'); localStorage.removeItem('rmdex-client-refresh-token')
  }
}
async function refreshSession(kind: AuthKind) {
  const refreshToken = kind === 'admin' ? adminRefreshToken.value : clientRefreshToken.value
  if (!refreshToken) return false
  const current = kind === 'admin' ? adminRefreshPromise : clientRefreshPromise
  if (current) return current
  const promise = (async () => {
    try {
      const response = await fetch(apiUrl('/api/auth/refresh'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken }) })
      const result = await readJsonResponse(response, '凭证续期失败')
      if (!response.ok || !result.accessToken) throw new Error(result?.error || '凭证续期失败')
      storeSession(kind, result)
      return true
    } catch {
      clearSession(kind)
      return false
    } finally {
      if (kind === 'admin') adminRefreshPromise = undefined
      else clientRefreshPromise = undefined
    }
  })()
  if (kind === 'admin') adminRefreshPromise = promise
  else clientRefreshPromise = promise
  return promise
}
async function authenticatedFetch(path: string, init: RequestInit, kind: AuthKind, retried = false) {
  const token = kind === 'admin' ? adminToken.value : clientToken.value
  const headers = new Headers(init.headers || {})
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(apiUrl(path), { ...init, headers })
  if (response.status === 401 && !retried && await refreshSession(kind)) return authenticatedFetch(path, init, kind, true)
  return response
}
async function get<T>(path: string): Promise<T> {
  const response = await authenticatedFetch(path, {}, 'client')
  const data = await readJsonResponse(response, `加载 ${path} 失败`)
  if (!response.ok) throw new Error(data?.error || 'Request failed')
  return data as T
}
async function bindOnlineDevice() {
  if (!adminToken.value) return false
  await loadDevices()
  const device = devices.value.find(item => item.online)
  if (!device) return false
  const result = await adminFetch<{ accessToken?: string; refreshToken?: string; clientToken: string; device: { id: string; name: string; online: boolean } }>(`/api/devices/${device.id}/web-client`, 'POST', {})
  storeSession('client', result)
  remoteDevice.value = result.device
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
async function loadProjects() {
  try {
    const result = await get<{ data: Project[] }>('/api/projects')
    projects.value = (result.data || []).sort((a, b) => a.name.localeCompare(b.name))
  } catch (e) {
    if (!(e instanceof Error) || !/not found/i.test(e.message)) throw e
    projects.value = desktopProjects.value.map(project => ({ ...project, source: 'desktop' as const, nativeProjectId: project.id }))
  }
}
async function loadEmployees() {
  if (!remoteMode.value) { employees.value = []; return }
  try {
    const result = await get<{ data: Employee[] }>('/api/employees')
    employees.value = (result.data || []).sort((a, b) => a.name.localeCompare(b.name))
  } catch (e) {
    if (!(e instanceof Error) || !/not found/i.test(e.message)) throw e
    employees.value = []
  }
}
function employeeForThread(threadId: string) {
  return employees.value.find(employee => employee.threadId === threadId)
}
function decorateEmployeeThread(thread: Thread): Thread {
  const employee = employeeForThread(thread.id)
  return employee ? { ...thread, employeeId: employee.id, name: thread.name || employee.name } : thread
}
function openEmployeeEditor(employee?: Employee) {
  editingEmployeeId.value = employee?.id || null
  employeeName.value = employee?.name || ''
  employeeRole.value = employee?.role || ''
  employeeInstructions.value = employee?.instructions || ''
  employeeProjectPath.value = employee?.projectPath || projects.value[0]?.path || selected.value?.cwd || ''
  employeeError.value = ''
  employeeEditor.value = true
}
async function saveEmployee() {
  if (employeeSaving.value) return
  employeeSaving.value = true
  employeeError.value = ''
  try {
    const payload = { name: employeeName.value, role: employeeRole.value, instructions: employeeInstructions.value, projectPath: employeeProjectPath.value, deviceId: remoteDevice.value?.id }
    if (editingEmployeeId.value) await post(`/api/employees/${editingEmployeeId.value}/update`, payload)
    else await post('/api/employees', payload)
    await loadEmployees()
    employeeEditor.value = false
  } catch (e) { employeeError.value = e instanceof Error ? e.message : String(e) }
  finally { employeeSaving.value = false }
}
async function openEmployee(employee: Employee) {
  if (employeeResetting.value) return
  closeThreadMenus()
  error.value = ''
  try {
    if (employee.deviceId !== remoteDevice.value?.id) throw new Error('请先连接员工绑定的 Codex 电脑')
    const result = await post(`/api/employees/${employee.id}/ensure-thread`, {}) as { employee: Employee; thread: Thread }
    employees.value = employees.value.map(item => item.id === employee.id ? result.employee : item)
    const thread = decorateEmployeeThread({ ...result.thread, employeeId: employee.id, name: employee.name, cwd: employee.projectPath })
    threads.value = [thread, ...threads.value.filter(item => item.id !== thread.id)]
    activeEmployeeId.value = employee.id
    await openThread(thread)
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
async function resetEmployeeThread(employee: Employee) {
  if (employeeResetting.value) return
  employeeResetting.value = employee.id
  error.value = ''
  try {
    if (employee.deviceId !== remoteDevice.value?.id) throw new Error('请先连接员工绑定的 Codex 电脑')
    const oldThreadId = employee.threadId
    const result = await post(`/api/employees/${employee.id}/reset-thread`, {}) as { employee: Employee; thread: Thread }
    employees.value = employees.value.map(item => item.id === employee.id ? result.employee : item)
    const oldThread = oldThreadId ? threads.value.find(item => item.id === oldThreadId) : undefined
    if (oldThread) rememberArchived(oldThread)
    if (oldThreadId) threads.value = threads.value.filter(item => item.id !== oldThreadId)
    const thread = decorateEmployeeThread({ ...result.thread, employeeId: employee.id, name: employee.name, cwd: employee.projectPath })
    threads.value = [thread, ...threads.value.filter(item => item.id !== thread.id)]
    activeEmployeeId.value = employee.id
    await openThread(thread)
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { employeeResetting.value = null }
}
function archiveScope() {
  return `${remoteDevice.value?.id || 'local'}:${desktopMode.value ? 'desktop' : 'app-server'}`
}
function loadArchivedThreads() {
  try {
    const raw = localStorage.getItem(`rmdex-archived-threads:${archiveScope()}`)
    archivedThreads.value = raw ? JSON.parse(raw) as Thread[] : []
  } catch { archivedThreads.value = [] }
}
function loadPinnedThreads() {
  try {
    const raw = localStorage.getItem(`rmdex-pinned-threads:${archiveScope()}`)
    pinnedThreads.value = raw ? JSON.parse(raw).filter((id: unknown): id is string => typeof id === 'string') : []
  } catch { pinnedThreads.value = [] }
}
function loadCollapsedProjects() {
  try {
    const raw = localStorage.getItem(`rmdex-collapsed-projects:${archiveScope()}`)
    collapsedProjectIds.value = raw ? JSON.parse(raw).filter((id: unknown): id is string => typeof id === 'string') : []
  } catch { collapsedProjectIds.value = [] }
}
function persistCollapsedProjects() {
  localStorage.setItem(`rmdex-collapsed-projects:${archiveScope()}`, JSON.stringify(collapsedProjectIds.value))
}
function projectIsCollapsed(projectId: string) {
  return collapsedProjectIds.value.includes(projectId)
}
function toggleProject(projectId: string) {
  collapsedProjectIds.value = projectIsCollapsed(projectId)
    ? collapsedProjectIds.value.filter(id => id !== projectId)
    : [...collapsedProjectIds.value, projectId]
  persistCollapsedProjects()
}
function openProjectEditor(project?: Project) {
  editingProjectId.value = project?.source === 'local' ? project.id : null
  projectName.value = project?.name || ''
  projectPath.value = project?.path || 'D:\\WorkSpace\\'
  projectError.value = ''
  projectEditor.value = true
}
async function saveProject() {
  if (projectSaving.value) return
  projectSaving.value = true
  projectError.value = ''
  try {
    if (editingProjectId.value) await post(`/api/projects/${editingProjectId.value}/update`, { name: projectName.value, path: projectPath.value })
    else await post('/api/projects', { name: projectName.value, path: projectPath.value })
    await loadProjects()
    projectEditor.value = false
  } catch (e) { projectError.value = e instanceof Error ? e.message : String(e) }
  finally { projectSaving.value = false }
}
async function deleteProject() {
  const project = deleteProjectTarget.value
  if (!project || project.source !== 'local') return
  try {
    await post(`/api/projects/${project.id}/delete`, {})
    await loadProjects()
    collapsedProjectIds.value = collapsedProjectIds.value.filter(id => id !== project.id)
    persistCollapsedProjects()
    deleteProjectTarget.value = null
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
function persistPinnedThreads() {
  localStorage.setItem(`rmdex-pinned-threads:${archiveScope()}`, JSON.stringify(pinnedThreads.value))
}
function isPinned(threadId: string) {
  return pinnedThreads.value.includes(threadId)
}
function togglePinned(thread: Thread) {
  pinnedThreads.value = isPinned(thread.id) ? pinnedThreads.value.filter(id => id !== thread.id) : [...pinnedThreads.value, thread.id]
  persistPinnedThreads()
  closeThreadMenus()
}
function persistArchivedThreads() {
  localStorage.setItem(`rmdex-archived-threads:${archiveScope()}`, JSON.stringify(archivedThreads.value))
}
function isArchived(threadId: string) {
  return archivedIds.value.has(threadId)
}
function rememberArchived(thread: Thread) {
  archivedThreads.value = [...archivedThreads.value.filter(item => item.id !== thread.id), { ...thread }]
  persistArchivedThreads()
}
function forgetArchived(threadId: string) {
  archivedThreads.value = archivedThreads.value.filter(thread => thread.id !== threadId)
  persistArchivedThreads()
}
function forgetPinned(threadId: string) {
  pinnedThreads.value = pinnedThreads.value.filter(id => id !== threadId)
  persistPinnedThreads()
}
function removeSentAttachments(threadId: string) {
  for (const file of attachmentsByThread.value[threadId] || []) {
    const url = attachmentPreviewUrls.get(file)
    if (url) URL.revokeObjectURL(url)
    attachmentPreviewUrls.delete(file)
  }
  delete attachmentsByThread.value[threadId]
}
function attachmentPreview(file: File) {
  if (!file.type.startsWith('image/')) return ''
  let url = attachmentPreviewUrls.get(file)
  if (!url) { url = URL.createObjectURL(file); attachmentPreviewUrls.set(file, url) }
  return url
}
function attachmentSelection(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files || [])]
  input.value = ''
  if (!selected.value || !files.length) return
  const current = attachmentsByThread.value[selected.value.id] || []
  const validExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'csv', 'json', 'xml', 'yaml', 'yml', 'log', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'zip', 'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'sql', 'sh', 'ps1'])
  const valid = files.filter(file => file.size > 0 && file.size <= 8 * 1024 * 1024 && validExtensions.has(file.name.split('.').pop()?.toLowerCase() || ''))
  if (valid.length !== files.length) error.value = '仅支持常见图片、文档和代码文件，单个附件不能超过 8 MB'
  if (current.length + valid.length > 10) { error.value = '每条消息最多添加 10 个附件'; return }
  attachmentsByThread.value[selected.value.id] = [...current, ...valid]
}
function removeAttachment(index: number) {
  if (!selected.value) return
  const id = selected.value.id
  const files = [...(attachmentsByThread.value[id] || [])]
  const [removed] = files.splice(index, 1)
  if (removed) {
    const url = attachmentPreviewUrls.get(removed)
    if (url) URL.revokeObjectURL(url)
    attachmentPreviewUrls.delete(removed)
  }
  attachmentsByThread.value[id] = files
}
async function uploadAttachments(files: File[]) {
  const result: Array<{ id: string; name: string; size: number; lastModified: number }> = []
  for (const file of files) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error(`读取附件失败：${file.name}`))
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error(`读取附件失败：${file.name}`))
      reader.readAsDataURL(file)
    })
    const uploaded = await post('/api/attachments', { name: file.name, type: file.type, data: dataUrl.slice(dataUrl.indexOf(',') + 1) }) as { id: string; name: string }
    result.push({ ...uploaded, size: file.size, lastModified: file.lastModified })
  }
  return result
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
function handleThreadTouchStart(thread: Thread, event: TouchEvent) {
  touchThreadId = thread.id
  touchStartX = event.touches[0]?.clientX || 0
  touchCurrentX = touchStartX
  touchMoved = false
  startThreadLongPress(thread)
}
function handleThreadTouchMove(thread: Thread, event: TouchEvent) {
  if (touchThreadId !== thread.id) return
  touchCurrentX = event.touches[0]?.clientX || touchCurrentX
  if (Math.abs(touchCurrentX - touchStartX) > 8) {
    touchMoved = true
    clearThreadLongPress()
  }
  if (touchStartX - touchCurrentX > 8) swipeOpenId.value = thread.id
  else if (touchCurrentX - touchStartX > 8 && swipeOpenId.value === thread.id) swipeOpenId.value = null
}
function handleThreadTouchEnd(thread: Thread) {
  clearThreadLongPress()
  if (touchThreadId === thread.id && touchMoved && Math.abs(touchCurrentX - touchStartX) > 8) {
    swipeOpenId.value = touchStartX - touchCurrentX > 45 ? thread.id : null
  }
  touchThreadId = ''
}
function closeThreadMenus() {
  threadMenuId.value = null
  swipeOpenId.value = null
}
function selectThread(thread: Thread) {
  if (touchMoved) { touchMoved = false; return }
  closeThreadMenus()
  void openThread(thread)
}
async function refreshThread(thread: Thread) {
  if (threadActionId.value) return
  closeThreadMenus()
  threadActionError.value = ''
  threadActionId.value = thread.id
  try {
    const result = await readThread(thread.id, true)
    if (selected.value?.id === thread.id) applyRead(result)
    else rememberThreadRead(result)
    await loadThreads(true).then(result => { threads.value = [...localDraftThreads.value, ...new Map(result.map(item => [item.id, item])).values()] })
  } catch (e) { threadActionError.value = e instanceof Error ? e.message : String(e); error.value = threadActionError.value }
  finally { threadActionId.value = null }
}
async function forkThread(thread: Thread, lastTurnId?: string) {
  if (!capabilities.value.fork || threadActionId.value) return
  closeThreadMenus()
  threadActionError.value = ''
  threadActionId.value = thread.id
  try {
    const result = await post(`/api/threads/${thread.id}/fork`, lastTurnId ? { lastTurnId } : {}) as { thread?: Thread; message?: string }
    if (!result.thread?.id) throw new Error(result.message || 'Fork 未返回新会话')
    const forked = result.thread
    threads.value = [forked, ...threads.value.filter(item => item.id !== forked.id)]
    localDraftThreads.value = localDraftThreads.value.filter(item => item.id !== forked.id)
    await openThread(forked)
  } catch (e) { threadActionError.value = e instanceof Error ? e.message : String(e); error.value = threadActionError.value }
  finally { threadActionId.value = null }
}
function forkMessage(message: MessageEntry) {
  if (!message.forkable || !selected.value) return
  void forkThread(selected.value, message.turnId)
}
async function archiveThread(thread: Thread) {
  if (!capabilities.value.archive || threadActionId.value) return
  closeThreadMenus()
  threadActionError.value = ''
  threadActionId.value = thread.id
  try {
    await post(`/api/threads/${thread.id}/archive`, {})
    rememberArchived(thread)
    threads.value = threads.value.filter(item => item.id !== thread.id)
    localDraftThreads.value = localDraftThreads.value.filter(item => item.id !== thread.id)
  } catch (e) {
    threadActionError.value = e instanceof Error ? e.message : String(e); error.value = threadActionError.value
    try {
      const result = await loadThreads(true)
      threads.value = [...localDraftThreads.value, ...new Map(result.map(item => [item.id, item])).values()]
    } catch { /* Keep the original action error visible. */ }
  } finally { threadActionId.value = null }
}
async function unarchiveThread(thread: Thread) {
  if (!capabilities.value.archive || threadActionId.value) return
  closeThreadMenus()
  threadActionError.value = ''
  threadActionId.value = thread.id
  try {
    await post(`/api/threads/${thread.id}/unarchive`, {})
    forgetArchived(thread.id)
    const result = await loadThreads(true)
    threads.value = [...localDraftThreads.value, ...new Map(result.map(item => [item.id, item])).values()]
  } catch (e) { threadActionError.value = e instanceof Error ? e.message : String(e); error.value = threadActionError.value }
  finally { threadActionId.value = null }
}
function requestDeleteThread(thread: Thread) {
  closeThreadMenus()
  threadActionError.value = ''
  deleteThreadTarget.value = thread
}
async function confirmDeleteThread() {
  const thread = deleteThreadTarget.value
  if (!thread || threadActionId.value) return
  threadActionError.value = ''
  threadActionId.value = thread.id
  try {
    await post(`/api/threads/${thread.id}/delete`, {})
    threads.value = threads.value.filter(item => item.id !== thread.id)
    localDraftThreads.value = localDraftThreads.value.filter(item => item.id !== thread.id)
    forgetArchived(thread.id)
    forgetPinned(thread.id)
    threadCache.delete(threadCacheKey(thread.id))
    delete pendingMessages.value[thread.id]
    if (selected.value?.id === thread.id) {
      selected.value = null
      mobileDetail.value = false
      activeTurnId.value = null
      pendingApprovals.value = []
      lastTurn.value = null
    }
    void removeThreadCache(threadCacheKey(thread.id))
    deleteThreadTarget.value = null
  } catch (e) { threadActionError.value = e instanceof Error ? e.message : String(e); error.value = threadActionError.value }
  finally { threadActionId.value = null }
}
function openThreadInDesktop(thread: Thread) {
  closeThreadMenus()
  const opened = window.open(`codex://thread/${encodeURIComponent(thread.id)}`, '_blank')
  if (!opened) error.value = '无法打开 Desktop，请确认已安装并注册 codex:// 协议'
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
    archivedThreads.value = archivedThreads.value.map(update)
    persistArchivedThreads()
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
function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = undefined
  nextReconnectAt.value = 0
}
function scheduleReconnect() {
  if (reconnectTimer || (!clientToken.value && remoteMode.value && !adminToken.value)) return
  reconnectAttempt += 1
  const delay = Math.min(30000, 1500 * (2 ** Math.min(reconnectAttempt - 1, 5)))
  nextReconnectAt.value = Date.now() + delay
  connectionState.value = 'reconnecting'
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    void refresh(false)
  }, delay)
}
async function retryConnection() {
  clearReconnectTimer()
  reconnectAttempt = 0
  showConnectionDetails.value = false
  await refresh(true)
}
async function refresh(force = true) {
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
          clearSession('client')
          if (!(await bindOnlineDevice())) throw firstError
          client = await get('/api/client')
        }
      }
      remoteDevice.value = client.device
      if (!client.device.online) {
        clearSession('client')
        if (!(await bindOnlineDevice())) throw new Error(adminToken.value ? '本地 Codex 设备当前离线，请先启动电脑端代理' : '当前绑定的电脑已离线，请在“连接设备”中重新选择在线电脑')
        client = await get('/api/client')
        remoteDevice.value = client.device
      }
    }
    loadArchivedThreads()
    loadPinnedThreads()
    loadCollapsedProjects()
    await hydrateThreadCache()
    const [result] = await Promise.all([
      loadThreads(force),
      loadModels(),
      loadProjects(),
      loadEmployees(),
    ])
    if (!projects.value.length && desktopProjects.value.length) {
      projects.value = desktopProjects.value.map(project => ({ ...project, source: 'desktop', nativeProjectId: project.id }))
    }
    const deviceKey = remoteDevice.value?.id || 'local'
    const decorated = result.map(decorateEmployeeThread)
    threads.value = [...localDraftThreads.value.filter(thread => thread.desktopDraft?.deviceKey === deviceKey), ...new Map(decorated.filter(thread => !isArchived(thread.id)).map((thread) => [thread.id, thread])).values()]
    connected.value = true
    connectionState.value = 'connected'
    connectionErrorDetail.value = ''
    reconnectAttempt = 0
    clearReconnectTimer()
  }
  catch (e) {
    connected.value = false
    connectionState.value = 'offline'
    connectionErrorDetail.value = e instanceof Error ? e.message : String(e)
    error.value = connectionErrorDetail.value
    scheduleReconnect()
  }
  finally { loading.value = false }
}

function queuedText(item: QueuedSubmission) {
  return (item.input || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n').trim() || '排队任务'
}
async function loadQueuedSubmissions(threadId: string): Promise<QueuedSubmission[] | null> {
  if (desktopMode.value) { queuedSubmissions.value = []; return [] }
  try {
    const result = await get<{ data?: QueuedSubmission[] }>(`/api/threads/${threadId}/queue`)
    const items = Array.isArray(result.data) ? result.data.filter(item => typeof item?.id === 'string') : []
    if (selected.value?.id === threadId) queuedSubmissions.value = items
    return items
  } catch { /* Older local agents may not expose queue/list yet; clear stale local entries after a terminal turn. */ return null }
}
async function deleteQueued(item: QueuedSubmission) {
  if (!selected.value || queueActionId.value) return
  const threadId = selected.value.id
  queueActionId.value = item.id
  queueMenuId.value = null
  try {
    const response = await authenticatedFetch(`/api/threads/${threadId}/queue/${encodeURIComponent(item.id)}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 'client')
    const result = await readJsonResponse(response, '删除排队任务失败')
    if (!response.ok) throw new Error(result?.error || '删除排队任务失败')
    await loadQueuedSubmissions(threadId)
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { queueActionId.value = null }
}
async function editQueued(item: QueuedSubmission) {
  if (!selected.value || queueActionId.value) return
  const threadId = selected.value.id
  queueActionId.value = item.id
  queueMenuId.value = null
  try {
    const response = await authenticatedFetch(`/api/threads/${threadId}/queue/${encodeURIComponent(item.id)}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 'client')
    const result = await readJsonResponse(response, '编辑排队任务失败')
    if (!response.ok) throw new Error(result?.error || '编辑排队任务失败')
    drafts.value[threadId] = queuedText(item)
    await loadQueuedSubmissions(threadId)
    await nextTick()
    composerInput.value?.focus()
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { queueActionId.value = null }
}
async function steerQueued(item: QueuedSubmission) {
  if (!selected.value || queueActionId.value || !activeTurnId.value) return
  const threadId = selected.value.id
  queueActionId.value = item.id
  queueMenuId.value = null
  try {
    await post(`/api/threads/${threadId}/queue/${encodeURIComponent(item.id)}/steer`, { expectedTurnId: activeTurnId.value })
    await loadQueuedSubmissions(threadId)
    await updateThread()
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { queueActionId.value = null }
}
function confirmFullAccess() {
  if (skipFullAccessConfirm.value) localStorage.setItem('rmdex-skip-full-access-confirm', '1')
  showFullAccessConfirm.value = false
  fullAccessConfirmed.value = true
  const retry = fullAccessRetry
  fullAccessRetry = undefined
  void send(retry)
}
async function openThread(thread: Thread) {
  const version = ++selectionVersion
  const cached = threadCache.get(threadCacheKey(thread.id))
  threadLoading.value = !cached; threadLoadError.value = ''; historyCursor.value = cached?.page?.hasMore ? cached.page.nextCursor : null; historyLoading.value = false; queuedUntil = 0
  selected.value = thread; activeEmployeeId.value = thread.employeeId || employeeForThread(thread.id)?.id || null; activeTurnId.value = null; pendingApprovals.value = []; lastTurn.value = null; queuedSubmissions.value = []; queueMenuId.value = null; mobileDetail.value = true; error.value = ''
  void loadQueuedSubmissions(thread.id)
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
  let queueStatus: ThreadStatus | undefined
  try {
    if (desktopMode.value) {
      const result = await readThread(id, true)
      if (version === selectionVersion) { applyRead(result); if (follow) await scrollToLatest() }
    } else {
      const result = await get<ThreadStatus>(`/api/threads/${id}/status`)
      queueStatus = result
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
    if (version === selectionVersion && queueStatus) {
      const queued = await loadQueuedSubmissions(id)
      const terminal = !queueStatus.activeTurnId && queueStatus.lastTurn?.status && ['completed', 'interrupted', 'failed', 'error'].includes(queueStatus.lastTurn.status)
      if (terminal && queued === null) queuedSubmissions.value = []
    }
  } catch (e) { if (version === selectionVersion) error.value = e instanceof Error ? e.message : String(e) }
  finally { pollBusy = false }
}
async function refreshThreadIndicators() {
  if (desktopMode.value || threadStatusPollBusy) return
  const candidates = threads.value.filter(thread => thread.id !== selected.value?.id && (['active', 'inProgress', 'running'].includes(thread.status?.type || '') || threadIndicators.value[thread.id] === 'working'))
  if (!candidates.length) return
  threadStatusPollBusy = true
  try {
    await Promise.allSettled(candidates.map(async thread => {
      const result = await get<ThreadStatus>(`/api/threads/${thread.id}/status`)
      const wasWorking = ['active', 'inProgress', 'running'].includes(thread.status?.type || '') || threadIndicators.value[thread.id] === 'working'
      const terminal = result.lastTurn?.status && ['completed', 'interrupted', 'failed', 'error'].includes(result.lastTurn.status)
      if (result.activeTurnId) threadIndicators.value[thread.id] = 'working'
      else if (terminal || wasWorking) threadIndicators.value[thread.id] = terminal && ['failed', 'error'].includes(result.lastTurn!.status) ? 'failed' : 'completed'
      threads.value = threads.value.map(item => item.id === thread.id ? { ...item, status: { ...(item.status || {}), type: result.activeTurnId ? 'active' : 'idle' } } : item)
      if (terminal) maybeNotifyTaskComplete(result)
    }))
  } finally { threadStatusPollBusy = false }
}
async function post(path: string, body: unknown) {
  const response = await authenticatedFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'client')
  const result = await readJsonResponse(response, `请求 ${path} 失败`)
  if (!response.ok) throw new Error(result?.error || '请求失败')
  return result
}
async function adminFetch<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await authenticatedFetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, 'admin')
  const data = await readJsonResponse(response, `请求 ${path} 失败`)
  if (!response.ok) throw new Error(data?.error || '请求失败')
  return data as T
}
async function loginAdmin() {
  if (loginLoading.value) return
  loginLoading.value = true
  loginError.value = ''
  try {
    const response = await fetch(apiUrl('/api/auth/login'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: adminUsername.value, password: adminPassword.value }) })
    const result = await readJsonResponse(response, '登录失败')
    if (!response.ok) throw new Error(result?.error || '登录失败')
    storeSession('admin', result); isPlatformAdmin.value = result.user?.role === 'admin'; localStorage.setItem('rmdex-admin-username', adminUsername.value); adminPassword.value = ''
    activePage.value = 'workspace'
    authReady.value = true
    await loadDevices()
    if (!clientToken.value) {
      const device = devices.value.find(item => item.online)
      if (device) await connectDevice(device.id)
    } else {
      await refresh()
    }
  } catch (e) { loginError.value = e instanceof Error ? e.message : String(e) }
  finally { loginLoading.value = false }
}
async function loadDevices() {
  if (!adminToken.value) return
  try {
    const me = await adminFetch<{ user: { id: string; role: string } }>('/api/auth/me')
    isPlatformAdmin.value = me.user.role === 'admin'
    const userResult = await adminFetch<{ data: typeof users.value }>('/api/users')
    users.value = userResult.data
    if (!users.value.some(item => item.id === selectedUserId.value)) selectedUserId.value = users.value[0]?.id || ''
    const deviceUsers = isPlatformAdmin.value ? users.value : users.value.filter(user => user.id === me.user.id)
    const [deviceResults, requestResult] = await Promise.all([
      Promise.all(deviceUsers.map(user => adminFetch<{ data: typeof devices.value }>(`/api/devices?userId=${encodeURIComponent(user.id)}`))),
      adminFetch<{ data: typeof pairRequests.value }>('/api/pair-requests'),
    ])
    onlineDeviceCounts.value = Object.fromEntries(deviceUsers.map((user, index) => [user.id, deviceResults[index].data.filter(device => device.online).length]))
    devices.value = deviceResults[deviceUsers.findIndex(user => user.id === selectedUserId.value)]?.data || []
    pairRequests.value = requestResult.data
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    pairError.value = message
    if (!adminToken.value || /需要.*登录|登录已过期|凭证无效/i.test(message)) {
      clearSession('admin')
      loginError.value = '登录已失效，请重新登录。'
    }
  }
}
async function createUser() {
  const username = userUsername.value.trim()
  if (creatingUser.value) return
  if (username.length < 3) { userFormError.value = '用户名至少需要 3 个字符'; return }
  if (userPassword.value.length < 12) { userFormError.value = '初始密码至少需要 12 位'; return }
  if (userPassword.value !== userPasswordConfirm.value) { userFormError.value = '两次输入的密码不一致'; return }
  creatingUser.value = true
  userFormError.value = ''
  createdUserCredentials.value = null
  try {
    const result = await adminFetch<{ user: { id: string; username: string; role: string } }>('/api/users', 'POST', { username, password: userPassword.value })
    users.value = [...users.value, result.user]
    selectedUserId.value = result.user.id
    createdUserCredentials.value = { username, password: userPassword.value }
    userUsername.value = ''; userPassword.value = ''; userPasswordConfirm.value = ''
    await loadDevices()
  } catch (e) { userFormError.value = e instanceof Error ? e.message : String(e) }
  finally { creatingUser.value = false }
}
function openUserCreate() {
  showCreateUser.value = true
  createdUserCredentials.value = null
  userFormError.value = ''
  userUsername.value = ''
  userPassword.value = ''
  userPasswordConfirm.value = ''
  showUserPassword.value = false
}
function generateUserPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%'
  const values = new Uint32Array(18)
  crypto.getRandomValues(values)
  const password = Array.from(values, value => alphabet[value % alphabet.length]).join('')
  userPassword.value = password
  userPasswordConfirm.value = password
  showUserPassword.value = true
}
function logout() {
  clearSession('client')
  clearSession('admin')
  activePage.value = 'workspace'
  showCreateUser.value = false
  isPlatformAdmin.value = false
  remoteDevice.value = null
  devices.value = []
  users.value = []
  employees.value = []
  threads.value = []
  localDraftThreads.value = []
  failedMessages.value = {}
  pendingMessages.value = {}
  fullAccessRetry = undefined
  selected.value = null
  pendingApprovals.value = []
  pairRequests.value = []
  connected.value = false
  connectionState.value = 'offline'
  authReady.value = true
}
async function selectUser() { await loadDevices() }
async function connectDevice(deviceId: string) {
  pairError.value = ''
  try {
    const result = await adminFetch<{ accessToken?: string; refreshToken?: string; clientToken: string; device: { id: string; name: string; online: boolean } }>(`/api/devices/${deviceId}/web-client`, 'POST', {})
    storeSession('client', result)
    remoteDevice.value = result.device
    showDevices.value = false
    await refresh()
  } catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
}
async function registerDevice() {
  pairError.value = ''; newDeviceToken.value = ''; pairCode.value = ''; pairQr.value = ''
  try {
    const result = await adminFetch<{ token: string; clientToken: string; accessToken?: string; refreshToken?: string }>('/api/devices', 'POST', { name: deviceName.value, userId: selectedUserId.value })
    newDeviceToken.value = result.token
    await loadDevices()
    showRegisterDevice.value = true
  }
  catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
}
function openRegisterDeviceDialog() {
  pairError.value = ''
  newDeviceToken.value = ''
  deviceName.value = 'Codex 电脑'
  registerDeviceMode.value = 'guide'
  showRegisterDevice.value = true
}
async function createPair(deviceId: string) {
  pairError.value = ''
  try { const result = await adminFetch<{ code: string; url: string }>(`/api/devices/${deviceId}/pair`, 'POST', {}); pairCode.value = result.code; pairUrl.value = result.url; pairQr.value = await QRCode.toDataURL(result.url, { width: 240, margin: 1, color: { dark: '#162b45', light: '#ffffff' } }) }
  catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
}
async function openPairDialog(deviceId: string) {
  pairError.value = ''
  pairCode.value = ''
  pairQr.value = ''
  pairUrl.value = ''
  showPairDialog.value = true
  await createPair(deviceId)
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
      if (state.status === 'approved' && (state.accessToken || state.token)) {
        storeSession('client', state)
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
      await handleAppUrl(value)
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
async function copyValue(value: string, feedback = '已复制会话 ID') {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value)
    else {
      const input = document.createElement('textarea')
      input.value = value
      input.setAttribute('readonly', '')
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      try {
        input.select()
        if (!document.execCommand('copy')) throw new Error('复制失败')
      } finally { input.remove() }
    }
    copyFeedback.value = feedback
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
    copyFeedbackTimer = setTimeout(() => { copyFeedback.value = '' }, 1800)
  } catch (e) {
    copyFeedback.value = '复制失败，请长按手动复制'
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
    copyFeedbackTimer = setTimeout(() => { copyFeedback.value = '' }, 2600)
    error.value = e instanceof Error ? e.message : '复制失败，请手动复制'
  }
}
function openCreate(project?: Project) {
  if (!capabilities.value.create) return
  createProject.value = project?.id || ''
  createPath.value = project?.path || selected.value?.cwd || 'D:\\WorkSpace'
  createError.value = ''
  showCreate.value = true
}
function syncCreateProjectPath() {
  const project = projects.value.find(item => item.id === createProject.value)
  if (project) createPath.value = project.path
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
    const project = projects.value.find(item => item.id === createProject.value)
    if (project && !project.nativeProjectId) {
      createError.value = '请先在 Codex Desktop 中创建此 Project，再刷新 rmdex 项目列表'
      return
    }
    const thread: Thread = {
      id: `draft-${crypto.randomUUID()}`, name: '新对话', turns: [], updatedAt: Date.now() / 1000,
      cwd: project?.path || '',
      desktopDraft: { projectId: project?.nativeProjectId || null, deviceKey: remoteDevice.value?.id || 'local' },
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
async function sendDesktopDraft(thread: Thread, text: string, attachments: Array<{ id: string; name: string; size: number; lastModified: number }>, preserveDraft = false) {
  const draft = thread.desktopDraft!
  const key = `rmdex-create:${draft.deviceKey}:${thread.id}`
  const settings = desktopSettings()
  const result = await post('/api/threads', {
    text, attachments: attachments.map(file => file.id), projectId: draft.projectId, ...settings,
    operationId: operationId(key, JSON.stringify([text, draft.projectId, attachments.map(file => [file.name, file.size, file.lastModified]), ...(settings.model ? [settings] : [])])),
  }) as { thread?: Thread; outcome?: string; message?: string }
  if (result.outcome === 'uncertain') throw new Error(result.message || '创建结果未确认，请在 Desktop 核对')
  if (!result.thread) {
    if (result.outcome !== 'preparing') throw new Error('Desktop 未返回会话，请核对桌面后再试')
    draft.preparing = true
    if (!preserveDraft) drafts.value[thread.id] = ''
    if (selected.value?.id === thread.id) error.value = result.message || 'Desktop 正在准备新会话，请稍后刷新会话列表'
    return
  }
  sessionStorage.removeItem(key)
  const created = result.thread
  localDraftThreads.value = localDraftThreads.value.filter(item => item.id !== thread.id)
  threads.value = [created, ...threads.value.filter(item => item.id !== thread.id && item.id !== created.id)]
  threadIndicators.value[created.id] = 'working'
  if (pendingMessages.value[thread.id]) pendingMessages.value[created.id] = pendingMessages.value[thread.id]!
  delete pendingMessages.value[thread.id]
  if (preserveDraft) {
    drafts.value[created.id] = drafts.value[thread.id] || ''
    if (attachmentsByThread.value[thread.id]) attachmentsByThread.value[created.id] = attachmentsByThread.value[thread.id]!
    delete attachmentsByThread.value[thread.id]
  }
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
async function retryMessage(message: MessageEntry | FailedMessage) {
  if (!selected.value || working.value || retrying.value || !capabilities.value.send) return
  const thread = selected.value
  const version = selectionVersion
  const deviceKey = remoteDevice.value?.id || 'local'
  const isCurrent = () => selected.value?.id === thread.id && version === selectionVersion && (remoteDevice.value?.id || 'local') === deviceKey
  retrying.value = true
  error.value = ''
  try {
    // A failed HTTP request may already have started a turn. Reconcile with
    // the host before allowing an explicit resend.
    if (!thread.desktopDraft) {
      const result = await readThread(thread.id, true)
      if (!isCurrent()) return
      const merged = { ...result, thread: { ...result.thread, turns: [...new Map([...(thread.turns || []), ...(result.thread.turns || [])].map(turn => [turn.id, turn])).values()] } }
      applyRead(merged)
      if ('previousTurnIds' in message) {
        const delivered = timeline(result.thread.turns || []).some(entry => entry.role === 'user' && !message.previousTurnIds.includes(entry.turnId) && pendingTextMatches(entry.text, userText(message.text)))
        if (delivered) {
          failedMessages.value[thread.id] = (failedMessages.value[thread.id] || []).filter(item => item.id !== message.id)
          error.value = '这条消息已送达，已同步最新会话；如需再次执行，可长按历史消息重试。'
          return
        }
      }
      if (activeTurnId.value) { error.value = '当前会话正在执行，请等待任务结束后重试'; return }
    }
    let submission: RetrySubmission
    if ('previousTurnIds' in message) {
      if (message.deviceKey !== deviceKey) return
      submission = { ...message, failedId: message.id }
    } else {
      if (message.role !== 'user') return
      const files: File[] = []
      for (const image of message.images) {
        const source = imageSource(image)
        if (!image.assetUrl && !source) throw new Error('原消息的图片不可用，请重新选择附件后发送')
        const response = image.assetUrl ? await authenticatedFetch(image.assetUrl, {}, 'client') : await fetch(source!)
        if (!response.ok) throw new Error('读取原消息图片失败，请稍后重试')
        const blob = await response.blob()
        const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[blob.type] || 'png'
        const name = image.path?.split(/[\\/]/).pop() || `image-${files.length + 1}.${extension}`
        files.push(new File([blob], name, { type: blob.type }))
      }
      submission = { threadId: thread.id, deviceKey, text: messageRequest(message.item), files }
    }
    if (isCurrent()) await send(submission)
  } catch (e) { if (isCurrent()) error.value = e instanceof Error ? e.message : String(e) }
  finally { retrying.value = false }
}
async function send(retry?: RetrySubmission) {
  if (!retry && retrying.value) return
  if (!selected.value || sending.value || activeTurnId.value || selected.value.desktopDraft?.preparing || !capabilities.value.send) return
  if (retry && (retry.threadId !== selected.value.id || retry.deviceKey !== (remoteDevice.value?.id || 'local'))) return
  const thread = selected.value
  const id = selected.value.id
  const text = retry ? retry.text : (drafts.value[id] || '').trim()
  const files = retry ? retry.files : [...(attachmentsByThread.value[id] || [])]
  if (!text && !files.length) return
  if (capabilities.value.permissions && permissionMode.value === 'full' && !skipFullAccessConfirm.value && !fullAccessConfirmed.value) { fullAccessRetry = retry; showFullAccessConfirm.value = true; return }
  fullAccessConfirmed.value = false
  const previousTurnIds = (thread.turns || []).map(turn => turn.id)
  const visibleText = userText(text)
  const failedId = retry?.failedId || crypto.randomUUID()
  const deviceKey = remoteDevice.value?.id || 'local'
  const employeeId = activeEmployeeId.value
  const settings = desktopSettings()
  const mode = permissionMode.value
  let accepted = false
  if (retry?.failedId) failedMessages.value[id] = (failedMessages.value[id] || []).filter(item => item.id !== retry.failedId)
  sending.value = true; sendingThreadId.value = id; stopRequested.value = false; stopping.value = false; pendingMessages.value[id] = { text: visibleText, previousCount: messages.value.filter(entry => entry.role === 'user' && pendingTextMatches(entry.text, visibleText)).length, attachmentNames: files.map(file => file.name) }; error.value = ''; lastTurn.value = null
  await scrollToLatest()
  try {
    const uploaded = await uploadAttachments(files)
    if ((remoteDevice.value?.id || 'local') !== deviceKey) throw new Error('设备已切换，请回到原设备重试消息')
    if (thread.desktopDraft) { await sendDesktopDraft(thread, text, uploaded, !!retry); accepted = true; if (!retry) removeSentAttachments(id); return }
    const key = `rmdex-send:${deviceKey}:${id}`
    const result = await post(`/api/threads/${id}/send`, desktopMode.value ? {
      text, attachments: uploaded.map(file => file.id), ...settings, operationId: operationId(key, JSON.stringify([text, uploaded.map(file => [file.name, file.size, file.lastModified]), settings])),
    } : {
      text,
      attachments: uploaded.map(file => file.id),
      name: thread.name || thread.preview || 'Codex 会话',
      ...(employeeId ? { employeeId } : {}),
      permissionMode: mode,
      ...settings,
    })
    if (result.outcome === 'uncertain') throw new Error(result.message || '发送结果未确认，请在 Desktop 核对')
    accepted = true
    sessionStorage.removeItem(key)
    if (!retry) removeSentAttachments(id)
    if (desktopMode.value) queuedUntil = Date.now() + 60000
    if (!retry && drafts.value[id]?.trim() === text) drafts.value[id] = ''
    if (selected.value?.id === id) activeTurnId.value = result.turn?.id || activeTurnId.value
    if (result.turn?.id) {
      threadIndicators.value[id] = 'working'
      threads.value = threads.value.map(item => item.id === id ? { ...item, status: { ...(item.status || {}), type: 'active' } } : item)
    }
    if (result.turn?.id) trackTask(id, result.turn.id, text, thread.name || thread.preview || 'Codex 会话')
    if (stopRequested.value) {
      try { if (result.turn?.id) await post(`/api/threads/${id}/stop`, {}) }
      catch (e) { if (selected.value?.id === id) error.value = e instanceof Error ? e.message : String(e) }
      finally { stopRequested.value = false; stopping.value = false }
    }
    if (selected.value?.id === id) { await updateThread(); await scrollToLatest() }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    if (!accepted) {
      delete pendingMessages.value[id]
      failedMessages.value[id] = [...(failedMessages.value[id] || []).filter(item => item.id !== failedId), { id: failedId, threadId: id, deviceKey, text, files, previousTurnIds, error: detail }]
    }
    stopRequested.value = false; stopping.value = false
    if (selected.value?.id === id) error.value = detail
  }
  finally { sending.value = false; sendingThreadId.value = null }
}
async function sendFollowUp(mode: 'queue' | 'steer') {
  if (!selected.value || sending.value || !activeTurnId.value || selected.value.desktopDraft || !capabilities.value.send) return
  if (mode === 'queue' && !capabilities.value.queue) return
  if (mode === 'steer' && !capabilities.value.steer) return
  const thread = selected.value
  const id = thread.id
  const text = (drafts.value[id] || '').trim()
  if (!text) return
  const expectedTurnId = activeTurnId.value
  sending.value = true
  sendingThreadId.value = id
  error.value = ''
  threadIndicators.value[id] = 'working'
  threads.value = threads.value.map(item => item.id === id ? { ...item, status: { ...(item.status || {}), type: 'active' } } : item)
  try {
    const clientUserMessageId = crypto.randomUUID()
    const result = await post(`/api/threads/${id}/${mode}`, { text, expectedTurnId, clientUserMessageId, ...(activeEmployeeId.value ? { employeeId: activeEmployeeId.value } : {}) }) as { outcome?: string; turn?: { id?: string }; queuedSubmission?: QueuedSubmission }
    if (drafts.value[id]?.trim() === text) drafts.value[id] = ''
    if (mode === 'queue' && result.queuedSubmission?.id) queuedSubmissions.value = [...queuedSubmissions.value.filter(item => item.id !== result.queuedSubmission!.id), result.queuedSubmission]
    if (result.turn?.id) trackTask(id, result.turn.id, text, thread.name || thread.preview || 'Codex 会话')
    await updateThread()
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { sending.value = false; sendingThreadId.value = null }
}
function onEnter(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (activeTurnId.value && capabilities.value.queue) void sendFollowUp('queue')
  else if (activeTurnId.value && capabilities.value.steer) void sendFollowUp('steer')
  else void send()
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
async function handleAppUrl(rawUrl: string) {
  const url = new URL(rawUrl)
  const params = new URLSearchParams(url.hash.slice(1))
  const code = params.get('pair')
  if (code) {
    pairLanding.value = true
    showDevices.value = true
    if (!Capacitor.isNativePlatform()) history.replaceState({}, '', location.pathname)
    await claimPair(code)
    return
  }
  const threadId = params.get('thread')
  if (!threadId) return
  await refresh()
  const thread = threads.value.find(item => item.id === threadId)
  if (thread) await openThread(thread)
}
onMounted(async () => {
  window.addEventListener('keydown', handlePreviewKey)
  let handledLaunch = false
  for (const task of notificationTasks()) trackedTasks.set(task.threadId, { turnId: task.turnId, text: task.text, name: task.name })
  const notificationsReady = await setupNotifications()
  if (clientToken.value && notificationsReady) void setupBackgroundNotifications()
  if (Capacitor.isNativePlatform()) {
    appUrlListener = await NativeApp.addListener('appUrlOpen', ({ url }) => { void handleAppUrl(url) })
    const launch = await NativeApp.getLaunchUrl()
    if (launch?.url) { handledLaunch = true; await handleAppUrl(launch.url) }
  }
  if (!handledLaunch) {
    const code = new URLSearchParams(location.hash.slice(1)).get('pair')
    if (code) await handleAppUrl(location.href)
    else if (Capacitor.isNativePlatform() && !clientToken.value) { pairLanding.value = true; showDevices.value = true }
    else if (clientToken.value || !remoteMode.value) void refresh()
  }
  if (adminToken.value) {
    await loadDevices()
    if (!clientToken.value && !pairLanding.value) {
      const device = devices.value.find(item => item.online)
      if (device) await connectDevice(device.id)
    } else if (clientToken.value && !pairLanding.value) {
      await refresh()
    }
  }
  authReady.value = true
  poll = setInterval(() => { void updateThread(); void refreshThreadIndicators(); if (adminToken.value && showDevices.value) void loadDevices() }, 2000)
})
onUnmounted(() => { window.removeEventListener('keydown', handlePreviewKey); if (poll) clearInterval(poll); clearThreadLongPress(); void appUrlListener?.remove(); void appStateListener?.remove(); void notificationListener?.remove() })
</script>

<template>
  <div v-if="!authReady" class="auth-loading" role="status" aria-label="正在验证登录状态"><img :src="logoUrl" alt="" /><span class="working-spinner"></span></div>
  <main v-else-if="requiresLogin" class="auth-page">
    <section class="auth-panel" aria-labelledby="login-title">
      <div class="auth-brand"><img :src="logoUrl" alt="" /><span>rmdex</span></div>
      <h1 id="login-title">登录</h1>
      <p class="auth-subtitle">登录以访问你的 Codex 工作区和设备。</p>
      <form class="auth-form" @submit.prevent="loginAdmin">
        <label for="admin-username">用户名</label>
        <input id="admin-username" v-model="adminUsername" autocomplete="username" required autofocus placeholder="输入用户名" />
        <label for="admin-password">密码</label>
        <input id="admin-password" v-model="adminPassword" type="password" autocomplete="current-password" required placeholder="输入密码" />
        <p v-if="loginError" class="auth-error" role="alert">{{ loginError }}</p>
        <button class="auth-submit" type="submit" :disabled="loginLoading || !adminUsername.trim() || !adminPassword">{{ loginLoading ? '正在登录…' : '登录' }}</button>
      </form>
      <p class="auth-help">账号由系统管理员创建。如无法登录，请联系管理员。</p>
    </section>
  </main>
  <main v-else-if="activePage === 'users' && isPlatformAdmin" class="admin-page">
    <header class="admin-topbar"><button class="admin-brand" type="button" @click="activePage = 'workspace'"><img :src="logoUrl" alt="" /><span>rmdex</span></button><div class="admin-top-actions"><button class="admin-nav-button" type="button" @click="activePage = 'workspace'"><ArrowLeft :size="16" />工作区</button><button class="admin-icon-button" type="button" title="退出登录" aria-label="退出登录" @click="logout"><LogOut :size="17" /></button></div></header>
    <section class="users-page-content" aria-labelledby="users-title">
      <div class="users-heading"><div><p class="eyebrow">账号与访问</p><h1 id="users-title">用户管理</h1><p>创建账号并管理每位用户的 Codex 设备。</p></div><button class="auth-submit users-create-button" type="button" @click="openUserCreate"><Plus :size="17" />创建用户</button></div>
      <div class="users-table-wrap"><table class="users-table"><thead><tr><th>用户</th><th>设备</th><th>在线设备</th><th>账号类型</th></tr></thead><tbody><tr v-for="user in users" :key="user.id"><td><strong>{{ user.username }}</strong><small>{{ user.id }}</small></td><td>{{ user.deviceCount ?? 0 }}</td><td>{{ onlineDeviceCounts[user.id] ?? 0 }}</td><td><span class="role-label">{{ user.role === 'admin' ? '管理员' : '用户' }}</span></td></tr><tr v-if="!users.length"><td colspan="4" class="users-empty">暂无用户</td></tr></tbody></table></div>
      <p v-if="pairError" class="auth-error" role="alert">{{ pairError }}</p>
    </section>
    <div v-if="showCreateUser" class="modal-backdrop" @click.self="!creatingUser && (showCreateUser = false)"><section class="create-dialog user-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-user-title" @keydown.esc="!creatingUser && (showCreateUser = false)"><header><div><h2 id="create-user-title">{{ createdUserCredentials ? '用户已创建' : '创建用户' }}</h2><p>{{ createdUserCredentials ? '请安全地将以下凭据交付给用户。' : '设置用户名和初始密码。' }}</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showCreateUser = false"><X :size="18" /></button></header>
        <div v-if="createdUserCredentials" class="created-credentials"><label>用户名</label><code>{{ createdUserCredentials.username }}</code><label>初始密码</label><code>{{ createdUserCredentials.password }}</code><button class="copy-button" type="button" @click="copyValue(createdUserCredentials.username + '\n' + createdUserCredentials.password, '已复制登录凭据')"><Copy :size="15" />复制登录凭据</button><div class="dialog-actions"><button class="create-button" type="button" @click="showCreateUser = false">完成</button></div></div>
        <form v-else class="user-create-form user-create-form-dialog" @submit.prevent="createUser"><label for="new-user-name">用户名</label><input id="new-user-name" v-model="userUsername" pattern="[A-Za-z0-9_.@-]{3,80}" minlength="3" maxlength="80" required autocomplete="off" placeholder="3–80 位字母、数字或 . _ @ -" /><label for="new-user-password">初始密码</label><div class="password-field"><input id="new-user-password" v-model="userPassword" :type="showUserPassword ? 'text' : 'password'" minlength="12" required autocomplete="new-password" placeholder="至少 12 位" /><button type="button" class="password-generate" :title="showUserPassword ? '隐藏密码' : '显示密码'" :aria-label="showUserPassword ? '隐藏密码' : '显示密码'" @click="showUserPassword = !showUserPassword"><EyeOff v-if="showUserPassword" :size="16" /><Eye v-else :size="16" /></button></div><button type="button" class="generate-password-link" @click="generateUserPassword">生成安全密码</button><label for="new-user-password-confirm">确认密码</label><input id="new-user-password-confirm" v-model="userPasswordConfirm" type="password" minlength="12" required autocomplete="new-password" placeholder="再次输入初始密码" /><p v-if="userFormError" class="auth-error" role="alert">{{ userFormError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="creatingUser" @click="showCreateUser = false">取消</button><button class="create-button" type="submit" :disabled="creatingUser">{{ creatingUser ? '正在创建…' : '创建用户' }}</button></div></form>
      </section></div>
  </main>
  <div v-else class="shell" :class="{ 'native-app': Capacitor.isNativePlatform() }">
    <aside id="thread-panel" class="thread-panel" :class="{ collapsed: !sidebarOpen, hiddenMobile: mobileDetail }">
      <div class="thread-panel-scroll">
      <div class="brand-row">
        <div class="brand"><img :src="logoUrl" alt="" /><span>rmdex</span></div>
        <button class="icon-button collapse-button" title="收起侧栏" aria-label="收起侧栏" aria-controls="thread-panel" :aria-expanded="sidebarOpen" @click="sidebarOpen = false"><PanelLeftClose :size="19" /></button>
      </div>
      <button class="new-thread" :disabled="!capabilities.create" @click="openCreate()"><Plus :size="17" /><span>新建对话</span></button>
      <div class="device"><span class="device-icon"><Monitor :size="16" /></span><div class="device-copy"><strong>{{ remoteDevice?.name || (remoteMode ? '未连接 Codex 设备' : '本机设备') }}</strong><small>{{ connected ? '已连接' : (remoteMode ? '等待远程设备' : '未连接') }}</small></div><span class="online" :class="{ offline: !connected }"></span></div>
      <button class="pair-entry" type="button" @click="showDevices = true"><QrCode :size="16" /><span>连接设备</span><span class="pair-entry-hint">扫码配对</span></button>
      <label class="search"><Search :size="16" /><input v-model="query" placeholder="搜索会话" aria-label="搜索会话" /></label>
        <div v-if="remoteMode" class="employee-section">
          <div class="section-label"><span>AI 员工 <span class="count">{{ employees.length }}</span></span><button class="icon-button" type="button" title="新建 AI 员工" aria-label="新建 AI 员工" @click="openEmployeeEditor()"><Plus :size="15" /></button></div>
          <div v-for="employee in employees" :key="employee.id" class="employee-row" :class="{ selected: activeEmployeeId === employee.id }">
            <button class="employee-select" type="button" @click="openEmployee(employee)"><span class="employee-icon"><Bot :size="15" /></span><span class="employee-copy"><strong>{{ employee.name }}</strong><small>{{ employee.role || employee.projectPath }}</small></span></button>
            <button class="employee-action" type="button" title="编辑员工" aria-label="编辑员工" @click.stop="openEmployeeEditor(employee)"><Pencil :size="14" /></button><button class="employee-action" type="button" title="重置上下文" aria-label="重置上下文" :disabled="employeeResetting === employee.id" @click.stop="resetEmployeeThread(employee)"><RotateCcw :size="14" :class="{ spin: employeeResetting === employee.id }" /></button>
          </div>
          <p v-if="!employees.length" class="employee-empty">创建一个有固定身份和长期记忆的 Codex 员工。</p>
        </div>
        <div class="section-label"><span>会话与 Projects <span class="count">{{ filtered.length }}</span></span><div class="section-actions"><button class="archive-toggle" type="button" :class="{ active: showArchivedThreads }" :title="showArchivedThreads ? '隐藏已归档' : '显示已归档'" @click="showArchivedThreads = !showArchivedThreads"><Archive :size="14" /><span v-if="archivedThreads.length">{{ archivedThreads.length }}</span></button><button class="icon-button" title="新建 Project" aria-label="新建 Project" @click="openProjectEditor()"><FolderPlus :size="15" /></button><button class="icon-button" title="刷新会话" aria-label="刷新会话" :disabled="loading" @click="retryConnection"><RefreshCw :size="15" /></button></div></div>
      <div v-if="threadActionError" class="sidebar-error">{{ threadActionError }}</div>
      <div class="thread-list">
        <div v-if="loading && !filtered.length" class="skeleton-list" aria-label="正在加载会话"><div v-for="index in 6" :key="index" class="skeleton-row"><span class="skeleton-line skeleton-line-title"></span><span class="skeleton-line skeleton-line-meta"></span></div></div>
         <div v-if="pinnedRootThreads.length" class="tree-section-label">置顶会话</div>
         <div v-for="thread in pinnedRootThreads" :key="thread.id" class="thread-row" :class="{ 'is-swipe-open': swipeOpenId === thread.id, 'is-menu-open': threadMenuId === thread.id }" @pointerdown="capabilities.rename && startThreadLongPress(thread)" @pointerup="clearThreadLongPress" @pointercancel="clearThreadLongPress" @pointerleave="clearThreadLongPress" @touchstart.passive="handleThreadTouchStart(thread, $event)" @touchmove.passive="handleThreadTouchMove(thread, $event)" @touchend="handleThreadTouchEnd(thread)" @contextmenu.prevent="capabilities.rename && beginRename(thread)">
          <div class="thread-row-content" :style="{ transform: swipeOpenId === thread.id ? `translateX(-${swipeActionWidth}px)` : 'translateX(0)' }">
            <button class="thread" :class="{ selected: selected?.id === thread.id }" @click="selectThread(thread)"><span class="thread-title-row"><Pin v-if="isPinned(thread.id)" :size="13" class="thread-pinned-icon" fill="currentColor" /><span class="thread-title">{{ thread.name || thread.preview || '未命名会话' }}</span><LoaderCircle v-if="threadIndicator(thread) === 'working'" :size="13" class="thread-state-icon thread-state-working" title="正在执行" /><CircleCheck v-else-if="threadIndicator(thread) === 'completed'" :size="14" class="thread-state-icon thread-state-completed" title="任务已完成" /><CircleAlert v-else-if="threadIndicator(thread) === 'failed'" :size="14" class="thread-state-icon thread-state-failed" title="任务失败" /></span><span class="thread-meta"><span>{{ date(thread.updatedAt) }}</span><span v-if="isArchived(thread.id)" class="archived-label">已归档</span></span></button>
            <button v-if="!Capacitor.isNativePlatform()" class="icon-button thread-menu-trigger" type="button" title="会话操作" aria-label="会话操作" @click.stop="openThreadMenu(thread)"><Ellipsis :size="17" /></button>
          </div>
          <div class="thread-swipe-actions" aria-label="会话快捷操作"><button type="button" :title="isPinned(thread.id) ? '取消置顶' : '置顶'" :aria-label="isPinned(thread.id) ? '取消置顶' : '置顶'" @click.stop="togglePinned(thread)"><Pin :size="15" :fill="isPinned(thread.id) ? 'currentColor' : 'none'" /></button><button type="button" title="重命名" aria-label="重命名" :disabled="!capabilities.rename || !!threadActionId" @click.stop="beginRename(thread)"><Pencil :size="15" /></button><button v-if="Capacitor.isNativePlatform()" type="button" title="Fork Chat" aria-label="Fork Chat" :disabled="!capabilities.fork || !!threadActionId" @click.stop="forkThread(thread)"><GitFork :size="15" /></button><button type="button" :title="isArchived(thread.id) ? '取消归档' : '归档'" :aria-label="isArchived(thread.id) ? '取消归档' : '归档'" :disabled="!capabilities.archive || !!threadActionId" @click.stop="isArchived(thread.id) ? unarchiveThread(thread) : archiveThread(thread)"><Archive :size="15" /></button><button type="button" title="删除" aria-label="删除" :disabled="!capabilities.delete || !!threadActionId" @click.stop="requestDeleteThread(thread)"><Trash2 :size="15" /></button></div>
          <div v-if="!Capacitor.isNativePlatform() && threadMenuId === thread.id" class="thread-menu" @click.stop><button type="button" @click="togglePinned(thread)"><Pin :size="14" />{{ isPinned(thread.id) ? '取消置顶' : '置顶' }}</button><button v-if="capabilities.rename" type="button" @click="beginRename(thread)"><Pencil :size="14" />重命名</button><button v-if="capabilities.fork" type="button" :disabled="threadActionId === thread.id" @click="forkThread(thread)"><GitFork :size="14" />Fork Chat</button><button type="button" @click="copyValue(thread.id); closeThreadMenus()"><Copy :size="14" />复制会话 ID</button><button type="button" :disabled="threadActionId === thread.id" @click="refreshThread(thread)"><RefreshCw :size="14" />刷新</button><button v-if="capabilities.archive" type="button" :disabled="threadActionId === thread.id" @click="isArchived(thread.id) ? unarchiveThread(thread) : archiveThread(thread)"><Archive :size="14" />{{ isArchived(thread.id) ? '取消归档' : '归档' }}</button><button v-if="capabilities.delete" type="button" :disabled="threadActionId === thread.id" @click="requestDeleteThread(thread)"><Trash2 :size="14" />删除</button><button type="button" @click="openThreadInDesktop(thread)"><ExternalLink :size="14" />在 Desktop 打开</button></div>
        </div>
         <div v-for="group in projectGroups" :key="group.project.id" class="project-tree-group">
           <div class="project-tree-row">
             <button class="project-tree-toggle" type="button" :aria-expanded="!projectIsCollapsed(group.project.id)" :title="projectIsCollapsed(group.project.id) ? '展开 Project' : '收起 Project'" @click="toggleProject(group.project.id)"><ChevronRight v-if="projectIsCollapsed(group.project.id)" :size="15" /><ChevronDown v-else :size="15" /></button>
             <Folder :size="16" class="project-folder-icon" />
             <button class="project-tree-name" type="button" @click="toggleProject(group.project.id)"><span>{{ group.project.name }}</span><small :title="group.project.path">{{ group.project.path }}</small></button>
             <span class="project-thread-count">{{ group.threads.length }}</span>
             <button class="project-action" type="button" title="在此 Project 新建会话" aria-label="在此 Project 新建会话" :disabled="desktopMode && !group.project.nativeProjectId" @click="openCreate(group.project)"><Plus :size="15" /></button>
             <button v-if="group.project.source === 'local'" class="project-action" type="button" title="编辑 Project" :aria-label="`编辑 Project ${group.project.name}`" @click="openProjectEditor(group.project)"><Pencil :size="14" /></button>
             <button v-if="group.project.source === 'local'" class="project-action project-delete-action" type="button" title="删除 Project" :aria-label="`删除 Project ${group.project.name}`" @click="deleteProjectTarget = group.project"><Trash2 :size="14" /></button>
           </div>
           <div v-if="!projectIsCollapsed(group.project.id)" class="project-thread-list">
             <div v-for="thread in group.threads" :key="thread.id" class="thread-row project-thread-row" :class="{ 'is-swipe-open': swipeOpenId === thread.id, 'is-menu-open': threadMenuId === thread.id }" @pointerdown="capabilities.rename && startThreadLongPress(thread)" @pointerup="clearThreadLongPress" @pointercancel="clearThreadLongPress" @pointerleave="clearThreadLongPress" @touchstart.passive="handleThreadTouchStart(thread, $event)" @touchmove.passive="handleThreadTouchMove(thread, $event)" @touchend="handleThreadTouchEnd(thread)" @contextmenu.prevent="capabilities.rename && beginRename(thread)">
               <div class="thread-row-content" :style="{ transform: swipeOpenId === thread.id ? `translateX(-${swipeActionWidth}px)` : 'translateX(0)' }">
                 <button class="thread" :class="{ selected: selected?.id === thread.id }" @click="selectThread(thread)"><span class="thread-title-row"><span class="thread-title">{{ thread.name || thread.preview || '未命名会话' }}</span><LoaderCircle v-if="threadIndicator(thread) === 'working'" :size="13" class="thread-state-icon thread-state-working" title="正在执行" /><CircleCheck v-else-if="threadIndicator(thread) === 'completed'" :size="14" class="thread-state-icon thread-state-completed" title="任务已完成" /><CircleAlert v-else-if="threadIndicator(thread) === 'failed'" :size="14" class="thread-state-icon thread-state-failed" title="任务失败" /></span><span class="thread-meta"><span>{{ date(thread.updatedAt) }}</span><span v-if="isArchived(thread.id)" class="archived-label">已归档</span></span></button>
                 <button v-if="!Capacitor.isNativePlatform()" class="icon-button thread-menu-trigger" type="button" title="会话操作" aria-label="会话操作" @click.stop="openThreadMenu(thread)"><Ellipsis :size="17" /></button>
               </div>
               <div class="thread-swipe-actions" aria-label="会话快捷操作"><button type="button" :title="isPinned(thread.id) ? '取消置顶' : '置顶'" :aria-label="isPinned(thread.id) ? '取消置顶' : '置顶'" @click.stop="togglePinned(thread)"><Pin :size="15" :fill="isPinned(thread.id) ? 'currentColor' : 'none'" /></button><button type="button" title="重命名" aria-label="重命名" :disabled="!capabilities.rename || !!threadActionId" @click.stop="beginRename(thread)"><Pencil :size="15" /></button><button v-if="Capacitor.isNativePlatform()" type="button" title="Fork Chat" aria-label="Fork Chat" :disabled="!capabilities.fork || !!threadActionId" @click.stop="forkThread(thread)"><GitFork :size="15" /></button><button type="button" :title="isArchived(thread.id) ? '取消归档' : '归档'" :aria-label="isArchived(thread.id) ? '取消归档' : '归档'" :disabled="!capabilities.archive || !!threadActionId" @click.stop="isArchived(thread.id) ? unarchiveThread(thread) : archiveThread(thread)"><Archive :size="15" /></button><button type="button" title="删除" aria-label="删除" :disabled="!capabilities.delete || !!threadActionId" @click.stop="requestDeleteThread(thread)"><Trash2 :size="15" /></button></div>
               <div v-if="!Capacitor.isNativePlatform() && threadMenuId === thread.id" class="thread-menu" @click.stop><button type="button" @click="togglePinned(thread)"><Pin :size="14" />{{ isPinned(thread.id) ? '取消置顶' : '置顶' }}</button><button v-if="capabilities.rename" type="button" @click="beginRename(thread)"><Pencil :size="14" />重命名</button><button v-if="capabilities.fork" type="button" :disabled="threadActionId === thread.id" @click="forkThread(thread)"><GitFork :size="14" />Fork Chat</button><button type="button" @click="copyValue(thread.id); closeThreadMenus()"><Copy :size="14" />复制会话 ID</button><button type="button" :disabled="threadActionId === thread.id" @click="refreshThread(thread)"><RefreshCw :size="14" />刷新</button><button v-if="capabilities.archive" type="button" :disabled="threadActionId === thread.id" @click="isArchived(thread.id) ? unarchiveThread(thread) : archiveThread(thread)"><Archive :size="14" />{{ isArchived(thread.id) ? '取消归档' : '归档' }}</button><button v-if="capabilities.delete" type="button" :disabled="threadActionId === thread.id" @click="requestDeleteThread(thread)"><Trash2 :size="14" />删除</button><button type="button" @click="openThreadInDesktop(thread)"><ExternalLink :size="14" />在 Desktop 打开</button></div>
             </div>
             <div v-if="!group.threads.length" class="project-empty">此 Project 还没有会话</div>
           </div>
         </div>
         <div v-if="otherThreads.length" class="tree-section-label tree-section-label-other">其他会话</div>
         <div v-for="thread in otherThreads" :key="thread.id" class="thread-row" :class="{ 'is-swipe-open': swipeOpenId === thread.id, 'is-menu-open': threadMenuId === thread.id }" @pointerdown="capabilities.rename && startThreadLongPress(thread)" @pointerup="clearThreadLongPress" @pointercancel="clearThreadLongPress" @pointerleave="clearThreadLongPress" @touchstart.passive="handleThreadTouchStart(thread, $event)" @touchmove.passive="handleThreadTouchMove(thread, $event)" @touchend="handleThreadTouchEnd(thread)" @contextmenu.prevent="capabilities.rename && beginRename(thread)">
           <div class="thread-row-content" :style="{ transform: swipeOpenId === thread.id ? `translateX(-${swipeActionWidth}px)` : 'translateX(0)' }"><button class="thread" :class="{ selected: selected?.id === thread.id }" @click="selectThread(thread)"><span class="thread-title-row"><span class="thread-title">{{ thread.name || thread.preview || '未命名会话' }}</span><LoaderCircle v-if="threadIndicator(thread) === 'working'" :size="13" class="thread-state-icon thread-state-working" title="正在执行" /><CircleCheck v-else-if="threadIndicator(thread) === 'completed'" :size="14" class="thread-state-icon thread-state-completed" title="任务已完成" /><CircleAlert v-else-if="threadIndicator(thread) === 'failed'" :size="14" class="thread-state-icon thread-state-failed" title="任务失败" /></span><span class="thread-meta"><span>{{ date(thread.updatedAt) }}</span></span></button><button v-if="!Capacitor.isNativePlatform()" class="icon-button thread-menu-trigger" type="button" title="会话操作" aria-label="会话操作" @click.stop="openThreadMenu(thread)"><Ellipsis :size="17" /></button></div>
           <div class="thread-swipe-actions" aria-label="会话快捷操作"><button type="button" title="置顶" aria-label="置顶" @click.stop="togglePinned(thread)"><Pin :size="15" /></button><button type="button" title="重命名" aria-label="重命名" :disabled="!capabilities.rename || !!threadActionId" @click.stop="beginRename(thread)"><Pencil :size="15" /></button><button v-if="Capacitor.isNativePlatform()" type="button" title="Fork Chat" aria-label="Fork Chat" :disabled="!capabilities.fork || !!threadActionId" @click.stop="forkThread(thread)"><GitFork :size="15" /></button><button type="button" title="归档" aria-label="归档" :disabled="!capabilities.archive || !!threadActionId" @click.stop="archiveThread(thread)"><Archive :size="15" /></button><button type="button" title="删除" aria-label="删除" :disabled="!capabilities.delete || !!threadActionId" @click.stop="requestDeleteThread(thread)"><Trash2 :size="15" /></button></div>
           <div v-if="!Capacitor.isNativePlatform() && threadMenuId === thread.id" class="thread-menu" @click.stop><button type="button" @click="togglePinned(thread)"><Pin :size="14" />置顶</button><button v-if="capabilities.rename" type="button" @click="beginRename(thread)"><Pencil :size="14" />重命名</button><button v-if="capabilities.fork" type="button" @click="forkThread(thread)"><GitFork :size="14" />Fork Chat</button><button type="button" @click="copyValue(thread.id); closeThreadMenus()"><Copy :size="14" />复制会话 ID</button><button type="button" @click="refreshThread(thread)"><RefreshCw :size="14" />刷新</button><button v-if="capabilities.archive" type="button" @click="archiveThread(thread)"><Archive :size="14" />归档</button><button v-if="capabilities.delete" type="button" @click="requestDeleteThread(thread)"><Trash2 :size="14" />删除</button><button type="button" @click="openThreadInDesktop(thread)"><ExternalLink :size="14" />在 Desktop 打开</button></div>
         </div>
         <div v-if="!filtered.length && !projects.length && !loading" class="empty-list">{{ showArchivedThreads ? '暂无已归档会话' : '暂无会话或 Project' }}</div>
      </div>
      </div>
      <footer class="side-footer"><span class="online" :class="{ offline: !connected }"></span> {{ remoteMode ? '远程设备' : '本机模式' }} <span class="footer-label">{{ connected ? '已连接' : '未连接' }}</span><span class="side-account-actions"><button v-if="isPlatformAdmin" type="button" @click="activePage = 'users'" title="用户管理"><Users :size="15" /><span>用户</span></button><button v-if="adminToken" type="button" @click="logout" title="退出登录"><LogOut :size="15" /><span>退出</span></button></span></footer>
    </aside>
    <main class="main" :class="{ hiddenMobile: !mobileDetail }">
       <header class="main-head"><button class="icon-button back" title="返回会话" aria-label="返回会话" @click="mobileDetail = false"><ArrowLeft :size="19" /></button><button v-if="!sidebarOpen" class="icon-button expand-button" title="展开侧栏" aria-label="展开侧栏" aria-controls="thread-panel" :aria-expanded="sidebarOpen" @click="sidebarOpen = true"><Menu :size="19" /></button><div class="heading"><strong>{{ selected?.name || selected?.preview || '会话' }}</strong><span v-if="selected">本机设备</span></div><button v-if="!sidebarOpen && capabilities.create" class="icon-button expand-button" title="新建对话" aria-label="新建对话" @click="openCreate()"><Plus :size="19" /></button></header>
      <div v-if="connectionState === 'connected'" class="connection-indicator" role="status" title="已连接"><span class="online"></span></div><div v-else class="connection-banner" :class="connectionState" role="status" aria-live="polite"><span class="online offline"></span><strong>{{ connectionState === 'reconnecting' ? '正在重连' : '已断开' }}</strong><span v-if="connectionState === 'reconnecting'">将自动重试</span><span v-else>部分操作暂不可用</span><button type="button" @click="retryConnection"><RotateCcw :size="14" />立即重试</button><details v-if="connectionErrorDetail"><summary>错误详情</summary><p>{{ connectionErrorDetail }}</p></details></div>
      <div v-if="error" class="error"><CircleAlert :size="18" /><span>{{ error }}</span><button @click="retryConnection">重试</button></div>
      <div v-if="!selected" class="welcome"><div class="welcome-icon"><MessageSquare :size="22" /></div><h2>选择一个会话</h2><p>查看你的 Codex 对话</p></div>
      <div v-else-if="threadLoading" class="conversation conversation-skeleton" role="status" aria-live="polite"><div class="conversation-inner"><span class="skeleton-line skeleton-line-heading"></span><span class="skeleton-line skeleton-line-wide"></span><span class="skeleton-line skeleton-line-medium"></span><span class="skeleton-line skeleton-line-wide"></span><span class="skeleton-line skeleton-line-short"></span></div></div>
      <div v-else-if="threadLoadError" class="thread-load-state" role="alert"><CircleAlert :size="20" /><span>加载会话失败：{{ threadLoadError }}</span><button type="button" @click="openThread(selected)">重试</button></div>
      <div v-else ref="conversation" class="conversation"><div class="conversation-inner">
        <button v-if="historyCursor" class="history-button" :disabled="historyLoading" @click="loadOlder"><LoaderCircle v-if="historyLoading" :size="14" class="working-spinner" />{{ historyLoading ? '正在加载…' : '加载更早的消息' }}</button>
        <div class="conversation-header"><h2>{{ selected.name || selected.preview || '未命名会话' }}</h2></div>
        <div v-if="!messages.length && !pendingMessageVisible(selected) && !failedMessages[selected.id]?.length" class="empty-messages">{{ selected.desktopDraft ? '从下方发送消息，开始新对话。' : '此会话暂无可显示的消息。' }}</div>
        <template v-for="(message, i) in messages" :key="message.role === 'tools' ? `tools-${i}` : `${message.turnId}-${message.item.id || i}`">
          <details v-if="message.role === 'tools'" class="tool-group">
            <summary><Wrench :size="14" /><span>{{ toolSummary(message.items) }}</span><span v-if="message.items.some(item => item.status === 'failed' || item.status === 'declined' || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0))" class="group-failed">含失败</span><ChevronRight :size="14" class="group-chevron" /></summary>
            <div class="tool-group-content"><ToolEvent v-for="(item, index) in message.items" :key="item.id || index" :item="item" :image-url="toolImageSource(item)" @preview="showImagePreview" /></div>
          </details>
          <MessageBubble v-else :role="message.role" :copy-text="message.copyText" :retryable="message.role === 'user' && capabilities.send" :retry-disabled="working || retrying" :forkable="message.role === 'agent' && message.forkable && capabilities.fork" @copy="copyValue($event, '已复制消息')" @retry="retryMessage(message)" @fork="forkMessage(message)">
            <div v-if="message.images.length" class="attachments"><template v-for="(image, index) in message.images" :key="index"><button v-if="imageSource(image)" type="button" class="attachment" title="放大预览图片" aria-label="放大预览图片" @click="showImagePreview(imageSource(image) || '')"><img :src="imageSource(image)" alt="图片附件" loading="lazy" /></button><span v-else class="attachment-unavailable">图片附件不可用</span></template></div>
            <div v-if="message.text" class="message-text markdown" v-html="markdown.render(message.text)"></div>
          </MessageBubble>
        </template>
        <MessageBubble v-for="failed in (failedMessages[selected.id] || [])" :key="failed.id" role="user" :copy-text="userText(failed.text)" :retryable="capabilities.send" :retry-disabled="working || retrying" failed @copy="copyValue($event, '已复制消息')" @retry="retryMessage(failed)">
          <div v-if="failed.files.length" class="pending-attachment-names">{{ failed.files.map(file => file.name).join(' · ') }}</div>
          <div v-if="failed.text" class="message-text markdown" v-html="markdown.render(userText(failed.text))"></div>
          <div class="message-send-error" role="status" :title="failed.error"><CircleAlert :size="13" /><span>发送未成功 · 长按重试</span></div>
        </MessageBubble>
        <MessageBubble v-if="pendingMessageVisible(selected)" role="user" :copy-text="pendingMessages[selected.id]!.text" :retryable="capabilities.send" retry-disabled @copy="copyValue($event, '已复制消息')"><div v-if="pendingMessages[selected.id]!.attachmentNames?.length" class="pending-attachment-names">{{ pendingMessages[selected.id]!.attachmentNames!.join(' · ') }}</div><div v-if="pendingMessages[selected.id]!.text" class="message-text markdown" v-html="markdown.render(pendingMessages[selected.id]!.text)"></div></MessageBubble>
        <div v-if="working || retrying" class="working" role="status" aria-live="polite"><LoaderCircle :size="16" class="working-spinner" /><span>{{ retrying && !working ? '正在准备重试' : workLabel }}</span></div>
        <div v-else-if="lastTurn?.status === 'failed'" class="turn-failure" role="alert">执行失败<span v-if="lastTurn.error?.message">：{{ lastTurn.error.message }}</span></div>
      </div></div>
      <div v-if="selected && !threadLoading && !threadLoadError" class="compose-area">
        <section v-if="queuedSubmissions.length" class="queued-followups" aria-label="排队任务"><div class="queued-followups-heading"><span>排队中</span><span class="queued-count">{{ queuedSubmissions.length }}</span></div><div v-for="item in queuedSubmissions" :key="item.id" class="queued-followup"><CornerDownRight :size="15" class="queued-followup-icon" /><span class="queued-followup-text">{{ queuedText(item) }}</span><div class="queued-followup-actions"><button type="button" class="queue-steer-button" :disabled="!!queueActionId || !activeTurnId" @click="steerQueued(item)"><CornerDownRight :size="14" />Steer</button><button type="button" class="queue-icon-button" title="删除排队任务" aria-label="删除排队任务" :disabled="!!queueActionId" @click="deleteQueued(item)"><Trash2 :size="15" /></button><button type="button" class="queue-icon-button" title="更多操作" aria-label="更多操作" :disabled="!!queueActionId" @click="queueMenuId = queueMenuId === item.id ? null : item.id"><Ellipsis :size="16" /></button></div><div v-if="queueMenuId === item.id" class="queued-followup-menu"><button type="button" :disabled="!!queueActionId" @click="editQueued(item)"><Pencil :size="14" />编辑消息</button></div></div></section>
        <p v-if="desktopMode" class="desktop-hint">{{ capabilities.models ? '模型与推理强度可在右侧选择；权限、审批和暂停请在 Desktop 处理。' : '当前设备未提供可识别的模型目录；模型、权限、审批和暂停请在 Desktop 处理。' }}</p><div v-for="approval in (capabilities.approvals ? pendingApprovals : [])" :key="approval.id" class="approval"><strong>{{ approval.method.includes('commandExecution') ? '命令执行需要确认' : '文件修改需要确认' }}</strong><p v-if="approval.params.reason">{{ approval.params.reason }}</p><pre v-if="approval.params.command">{{ approval.params.command }}</pre><p v-if="approval.params.cwd">工作目录：{{ approval.params.cwd }}</p><p v-if="approval.params.grantRoot">授权目录：{{ approval.params.grantRoot }}</p><details><summary>完整请求信息</summary><pre>{{ JSON.stringify(approval.params, null, 2) }}</pre></details><p v-if="approval.method.includes('fileChange')">请先在上方工具调用中查看文件变更，再决定是否允许。</p><div class="approval-actions"><button @click="decide(approval, 'decline')">拒绝</button><button @click="decide(approval, 'accept')">允许本次</button></div></div>
        <form class="composer" @submit.prevent="send()">
          <div v-if="selectedAttachments.length" class="composer-attachments" aria-label="待发送附件">
            <div v-for="(file, index) in selectedAttachments" :key="`${file.name}-${file.lastModified}-${index}`" class="composer-attachment">
              <img v-if="attachmentPreview(file)" :src="attachmentPreview(file)" alt="" />
              <span class="composer-attachment-name" :title="file.name">{{ file.name }}</span>
              <button type="button" title="移除附件" :aria-label="`移除附件 ${file.name}`" @click="removeAttachment(index)"><X :size="14" /></button>
            </div>
          </div>
          <textarea ref="composerInput" v-model="drafts[selected.id]" placeholder="输入消息，Enter 发送；Shift+Enter 换行" aria-label="消息" rows="2" :disabled="sending || !!selected.desktopDraft?.preparing || !capabilities.send" @keydown.enter.exact="onEnter"></textarea>
          <div class="compose-actions">
            <div class="compose-left">
              <label class="attachment-picker" title="添加图片或文件" aria-label="添加图片或文件"><Paperclip :size="17" /><input type="file" multiple accept="image/*,.pdf,.txt,.md,.csv,.json,.xml,.yaml,.yml,.log,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.zip,.js,.ts,.tsx,.jsx,.html,.css,.py,.go,.rs,.java,.kt,.c,.h,.cpp,.sql,.sh,.ps1" :disabled="sending || !capabilities.send" @change="attachmentSelection" /></label>
              <PermissionMenu v-if="capabilities.permissions" :model-value="permissionMode" :disabled="working" @update:model-value="rememberPermission" />
            </div>
            <div class="compose-right">
              <ModelMenu v-if="capabilities.models" :models="models" :model-value="selectedModel" :effort="selectedEffort" :loading="modelLoading" :disabled="working || sending" @update:model-value="rememberModel" @update:effort="rememberEffort" />
              <button v-if="working && capabilities.stop" type="button" class="send-button stop-button" :class="{ 'is-stopping': stopping }" :title="stopping ? '正在暂停' : '暂停任务'" :aria-label="stopping ? '正在暂停' : '暂停任务'" :disabled="stopping && !!activeTurnId" @click="stop"><Square :size="14" fill="currentColor" /></button>
              <button v-else-if="working" type="button" class="send-button" disabled title="Desktop 正在工作"><LoaderCircle :size="18" class="working-spinner" /></button>
              <button v-else type="submit" class="send-button" title="发送消息" aria-label="发送消息" :disabled="sending || !capabilities.send || (!drafts[selected.id]?.trim() && !selectedAttachments.length)"><ArrowUp :size="18" /></button>
            </div>
          </div>
        </form>
      </div>
    </main>
    <div v-if="copyFeedback" class="copy-toast" role="status" aria-live="polite">{{ copyFeedback }}</div>
    <div v-if="previewImageUrl" class="image-preview-backdrop" @click.self="closeImagePreview"><section class="image-preview-dialog" role="dialog" aria-modal="true" aria-label="图片预览"><button class="icon-button image-preview-close" type="button" title="关闭图片预览" aria-label="关闭图片预览" @click="closeImagePreview"><X :size="18" /></button><img :src="previewImageUrl" alt="图片大图预览" /></section></div>
    <div v-if="showFullAccessConfirm" class="modal-backdrop" @click.self="showFullAccessConfirm = false"><section class="create-dialog risk-dialog" role="dialog" aria-modal="true" aria-labelledby="full-access-title" @keydown.esc="showFullAccessConfirm = false"><header><div class="risk-heading"><span class="risk-icon"><ShieldAlert :size="19" /></span><div><h2 id="full-access-title">确认使用完全访问</h2><p>这次消息将跳过 Codex 审批。</p></div></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showFullAccessConfirm = false"><X :size="18" /></button></header><div class="risk-copy"><p>完全访问模式允许 Codex 直接执行命令、修改工作目录中的文件，并访问电脑上的网络资源。</p><p>只在你明确知道这条消息会做什么时继续。你也可以取消后切换为“请求审批”。</p></div><label class="risk-checkbox"><input v-model="skipFullAccessConfirm" type="checkbox" /> <span>不再提醒</span></label><div class="dialog-actions"><button type="button" class="cancel-button" @click="showFullAccessConfirm = false">取消</button><button type="button" class="danger-confirm-button" @click="confirmFullAccess">继续发送</button></div></section></div>
     <div v-if="showCreate" class="modal-backdrop" @click.self="!creating && (showCreate = false)"><section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title" @keydown.esc="!creating && (showCreate = false)"><header><h2 id="create-title">新建对话</h2><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="creating" @click="showCreate = false"><X :size="18" /></button></header><form @submit.prevent="createThread"><label for="new-thread-project">Project</label><ProjectMenu v-model="createProject" :projects="projects" :desktop-mode="desktopMode" :disabled="creating" @update:model-value="syncCreateProjectPath" /><template v-if="!desktopMode && !createProject"><label for="working-directory">工作目录</label><input id="working-directory" v-model="createPath" required autocomplete="off" placeholder="例如 D:\WorkSpace\rmdex" /></template><p v-else-if="createProject" class="project-path-hint">{{ projects.find(project => project.id === createProject)?.path }}</p><p v-if="createError" class="create-error" role="alert">{{ createError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="creating" @click="showCreate = false">取消</button><button type="submit" class="create-button" :disabled="creating || (!desktopMode && !createProject && !createPath.trim())">{{ creating ? '创建中…' : '创建对话' }}</button></div></form></section></div>
     <div v-if="employeeEditor" class="modal-backdrop" @click.self="!employeeSaving && (employeeEditor = false)"><section class="create-dialog employee-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-title" @keydown.esc="!employeeSaving && (employeeEditor = false)"><header><div><h2 id="employee-title">{{ editingEmployeeId ? '编辑 AI 员工' : '新建 AI 员工' }}</h2><p>员工会使用绑定电脑上的 Codex Thread 工作。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="employeeSaving" @click="employeeEditor = false"><X :size="18" /></button></header><form @submit.prevent="saveEmployee"><label for="employee-name">名称</label><input id="employee-name" v-model="employeeName" maxlength="80" required placeholder="例如：回归测试员" /><label for="employee-role">职位</label><input id="employee-role" v-model="employeeRole" maxlength="120" placeholder="例如：负责运行测试并分析失败" /><label for="employee-project-path">Project 路径</label><input id="employee-project-path" v-model="employeeProjectPath" maxlength="1000" required placeholder="例如：D:\WorkSpace\rmdex" /><label for="employee-instructions">员工职责与沟通方式</label><textarea id="employee-instructions" v-model="employeeInstructions" rows="5" maxlength="12000" placeholder="描述它应该如何工作、如何汇报结果。"></textarea><p v-if="employeeError" class="create-error" role="alert">{{ employeeError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="employeeSaving" @click="employeeEditor = false">取消</button><button type="submit" class="create-button" :disabled="employeeSaving || !employeeName.trim() || !employeeProjectPath.trim()">{{ employeeSaving ? '保存中…' : '保存员工' }}</button></div></form></section></div>
     <div v-if="projectEditor" class="modal-backdrop" @click.self="!projectSaving && (projectEditor = false)"><section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="project-title" @keydown.esc="!projectSaving && (projectEditor = false)"><header><h2 id="project-title">{{ editingProjectId ? '编辑 Project' : '新建 Project' }}</h2><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="projectSaving" @click="projectEditor = false"><X :size="18" /></button></header><form @submit.prevent="saveProject"><label for="project-name">名称</label><input id="project-name" v-model="projectName" maxlength="80" required autocomplete="off" placeholder="例如 rmdex" /><label for="project-path">文件夹路径</label><input id="project-path" v-model="projectPath" required autocomplete="off" placeholder="例如 D:\WorkSpace\rmdex" /><p class="dialog-hint">路径必须是这台 Codex 电脑上已存在的文件夹。Desktop 已创建的 Projects 会自动出现在列表中。</p><p v-if="projectError" class="create-error" role="alert">{{ projectError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="projectSaving" @click="projectEditor = false">取消</button><button type="submit" class="create-button" :disabled="projectSaving || !projectName.trim() || !projectPath.trim()">{{ projectSaving ? '保存中…' : '保存 Project' }}</button></div></form></section></div>
     <div v-if="deleteProjectTarget" class="modal-backdrop" @click.self="deleteProjectTarget = null"><section class="create-dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-project-title"><header><div><h2 id="delete-project-title">删除 Project</h2><p>只会移除 rmdex 中的 Project 记录，不会删除文件夹或会话。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="deleteProjectTarget = null"><X :size="18" /></button></header><p class="delete-copy">确定移除“{{ deleteProjectTarget.name }}”吗？</p><div class="dialog-actions"><button type="button" class="cancel-button" @click="deleteProjectTarget = null">取消</button><button type="button" class="danger-confirm-button" @click="deleteProject">确认移除</button></div></section></div>
    <div v-if="renameThread" class="modal-backdrop" @click.self="!renaming && (renameThread = null)"><section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title" @keydown.esc="!renaming && (renameThread = null)"><header><div><h2 id="rename-title">重命名会话</h2><p>名称只影响 rmdex 显示，不会修改消息内容。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="renaming" @click="renameThread = null"><X :size="18" /></button></header><form @submit.prevent="submitRename"><label for="thread-name">会话名称</label><input id="thread-name" v-model="renameValue" maxlength="80" autocomplete="off" /><p v-if="renameError" class="create-error" role="alert">{{ renameError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="renaming" @click="renameThread = null">取消</button><button type="submit" class="create-button" :disabled="renaming || !renameValue.trim()">{{ renaming ? '保存中…' : '保存名称' }}</button></div></form></section></div>
    <div v-if="deleteThreadTarget" class="modal-backdrop" @click.self="!threadActionId && (deleteThreadTarget = null)"><section class="create-dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" @keydown.esc="!threadActionId && (deleteThreadTarget = null)"><header><div><h2 id="delete-title">删除会话</h2><p>删除后无法从 rmdex 恢复这条会话。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="!!threadActionId" @click="deleteThreadTarget = null"><X :size="18" /></button></header><p class="delete-copy">确定删除“{{ deleteThreadTarget.name || deleteThreadTarget.preview || '未命名会话' }}”吗？这会同时从 Codex 中删除会话记录。</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="!!threadActionId" @click="deleteThreadTarget = null">取消</button><button type="button" class="danger-confirm-button" :disabled="!!threadActionId" @click="confirmDeleteThread">{{ threadActionId ? '删除中…' : '确认删除' }}</button></div></section></div>
    <div v-if="pairApprovalPage" class="pair-status-backdrop"><section class="pair-status-page" role="dialog" aria-modal="true" aria-labelledby="pair-status-title"><button class="icon-button pair-status-close" type="button" title="返回设备连接" aria-label="返回设备连接" @click="returnToPairingEntry"><X :size="18" /></button><div class="pair-status-icon" :class="`is-${pairApprovalState}`"><LoaderCircle v-if="pairApprovalState === 'waiting'" :size="28" class="working-spinner" /><CircleAlert v-else :size="28" /></div><h2 id="pair-status-title">{{ pairApprovalState === 'waiting' ? '等待电脑端确认' : pairApprovalState === 'denied' ? '配对请求未通过' : pairApprovalState === 'expired' ? '配对请求已过期' : '配对暂时没有完成' }}</h2><p class="pair-status-copy">{{ pairApprovalState === 'waiting' ? '配对申请已经发送到电脑端，请在 Codex Desktop 中允许这台手机连接。' : pairError }}</p><div v-if="pairApprovalState === 'waiting'" class="pair-status-waiting"><span class="online"></span><span>正在等待电脑端审批</span></div><div v-else class="pair-status-actions"><button class="create-button" type="button" :disabled="scanningPair" @click="scanPairCode"><QrCode :size="16" />重新扫描二维码</button><button class="cancel-button" type="button" @click="returnToPairingEntry">手动输入配对码</button></div><form v-if="pairApprovalState !== 'waiting'" class="pair-status-manual" @submit.prevent="claimPair()"><label for="pair-status-code">输入 32 位配对码</label><div><input id="pair-status-code" v-model="pairInput" maxlength="32" inputmode="text" autocomplete="off" placeholder="输入配对码" /><button class="create-button" type="submit" :disabled="pairInput.length !== 32 || mobilePairing">继续</button></div></form></section></div>
    <div v-if="showDevices" class="modal-backdrop" @click.self="showDevices = false"><section class="create-dialog device-dialog" role="dialog" aria-modal="true" aria-labelledby="devices-title" @keydown.esc="showDevices = false"><header><div><h2 id="devices-title">设备连接</h2><p>选择要使用的 Codex 电脑，或添加一台新电脑。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showDevices = false"><X :size="18" /></button></header>
      <template v-if="adminToken"><div class="admin-status"><span class="online"></span><span>{{ isPlatformAdmin ? '平台管理员已验证' : '用户已验证' }}</span></div>
        <div class="device-dialog-toolbar"><div><strong>我的 Codex 电脑</strong><small>{{ devices.length ? `${devices.length} 台已注册设备` : '还没有注册设备' }}</small></div><button class="create-button" type="button" @click="openRegisterDeviceDialog"><Plus :size="15" />添加电脑</button></div>
        <div v-if="pairRequests.length" class="pair-requests"><strong>待处理的手机配对</strong><div v-for="request in pairRequests" :key="request.id" class="pair-request"><span>{{ request.name }}</span><button type="button" @click="decidePair(request.id, 'deny')">拒绝</button><button type="button" class="approve-pair" @click="decidePair(request.id, 'approve')">允许</button></div></div>
        <div class="device-list"><div v-for="device in devices" :key="device.id" class="device-row"><span class="device-icon"><Monitor :size="16" /></span><div class="device-copy"><strong>{{ device.name }}</strong><small>{{ device.online ? '在线' : '离线' }}</small></div><span class="online" :class="{ offline: !device.online }"></span><button class="icon-button" :class="{ 'connect-device-button': remoteDevice?.id !== device.id }" title="连接此设备" aria-label="连接此设备" :disabled="!device.online" @click="connectDevice(device.id)"><MessageSquare :size="16" /></button><button class="icon-button" title="生成手机配对码" aria-label="生成手机配对码" @click="openPairDialog(device.id)"><Smartphone :size="16" /></button><button class="icon-button revoke-button" title="撤销设备" aria-label="撤销设备" @click="revokeDevice(device.id)"><Trash2 :size="15" /></button></div><p v-if="!devices.length" class="device-empty">尚未注册 Codex 电脑。点击“添加电脑”开始。</p></div>
      </template>
      <template v-else-if="pairLanding"><div class="mobile-pair-intro"><Smartphone :size="22" /><div><strong>申请连接 Codex 电脑</strong><p>配对申请会发送到电脑端，等待管理员允许后即可使用。</p></div></div><button class="create-button scan-pair-button" type="button" :disabled="scanningPair || mobilePairing" @click="scanPairCode"><QrCode :size="16" />{{ scanningPair ? '正在打开扫码…' : '扫描电脑二维码' }}</button><form class="claim-pair" @submit.prevent="claimPair()"><label for="pair-code">二维码无法识别时，输入配对码</label><div><input id="pair-code" v-model="pairInput" maxlength="32" placeholder="输入配对码" /><button class="create-button" type="submit" :disabled="pairInput.length !== 32 || mobilePairing">配对</button></div></form><p v-if="mobilePairing && !pairError" class="pair-waiting" role="status"><LoaderCircle :size="15" class="working-spinner" />配对申请已发送，请在电脑端允许此手机连接。</p></template>
      <p v-if="pairError" class="create-error" role="alert">{{ pairError }}</p>
    </section></div>
    <div v-if="showRegisterDevice" class="modal-backdrop device-submodal" @click.self="showRegisterDevice = false"><section class="create-dialog register-device-dialog" role="dialog" aria-modal="true" aria-labelledby="register-device-title" @keydown.esc="showRegisterDevice = false"><header><div><h2 id="register-device-title">添加 Codex 电脑</h2><p>{{ newDeviceToken ? '注册码已生成，请在新电脑上完成连接。' : registerDeviceMode === 'guide' ? '推荐使用 rmdex-pc 登录账号自动注册。' : '仅在手动配置 agent 时生成注册码。' }}</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showRegisterDevice = false"><X :size="18" /></button></header><template v-if="!newDeviceToken && registerDeviceMode === 'guide'"><div class="device-guide device-guide-primary"><strong>推荐方式：在新电脑上登录</strong><ol><li>在新电脑安装并打开 rmdex-pc。</li><li>输入要绑定的用户账号、密码和电脑名称。</li><li>点击“连接账号并启动”，设备会自动注册并上线。</li></ol><p>注册完成后，这台电脑会自动出现在当前设备列表中，不需要先在这里创建空设备。</p></div><div class="dialog-actions"><button type="button" class="cancel-button" @click="showRegisterDevice = false">关闭</button><button type="button" class="create-button" @click="registerDeviceMode = 'manual'"><Wrench :size="15" />手动配置注册码</button></div></template><template v-else-if="!newDeviceToken"><label class="user-select-label">设备所属用户</label><UserMenu v-model="selectedUserId" :users="users" :disabled="!isPlatformAdmin || users.length < 2" @update:model-value="selectUser" /><label for="new-device-name">电脑名称</label><input id="new-device-name" v-model="deviceName" maxlength="80" autocomplete="off" placeholder="例如：办公室电脑" /><div class="device-guide"><strong>手动配置适用于已有 agent 的电脑</strong><p>生成后复制注册码，并将它配置到电脑端的 <code>RMDEX_DEVICE_TOKEN</code>。普通的新电脑请返回上一步，直接使用 rmdex-pc 登录。</p></div><p v-if="pairError" class="create-error" role="alert">{{ pairError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" @click="registerDeviceMode = 'guide'">返回</button><button type="button" class="create-button" :disabled="!selectedUserId || !deviceName.trim()" @click="registerDevice"><Plus :size="15" />生成注册码</button></div></template><div v-else class="device-secret"><strong>注册码已生成</strong><p>将它配置到手动 agent 后，设备会出现在设备列表。普通新电脑不需要使用注册码，直接在 rmdex-pc 登录即可。</p><code>{{ newDeviceToken }}</code><button class="copy-button" type="button" @click="copyValue(newDeviceToken, '已复制设备注册码')"><Copy :size="15" />复制注册码</button><small>手动配置：RMDEX_RELAY_URL=wss://code.kyeai.xyz/agent<br />RMDEX_DEVICE_TOKEN={{ newDeviceToken }}</small><div class="dialog-actions"><button type="button" class="create-button" @click="showRegisterDevice = false">完成</button></div></div></section></div>
    <div v-if="showPairDialog" class="modal-backdrop device-submodal" @click.self="showPairDialog = false"><section class="create-dialog pair-dialog" role="dialog" aria-modal="true" aria-labelledby="pair-dialog-title" @keydown.esc="showPairDialog = false"><header><div><h2 id="pair-dialog-title">手机扫码配对</h2><p>二维码和配对码 3 分钟内有效，只能使用一次。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showPairDialog = false"><X :size="18" /></button></header><div v-if="pairQr" class="pair-result"><img :src="pairQr" alt="手机扫码配对二维码" /><div><strong>使用手机扫描二维码</strong><code>{{ pairCode }}</code><button class="copy-button" type="button" @click="copyValue(pairUrl, '已复制配对链接')"><Copy :size="15" />复制配对链接</button></div></div><div v-else class="pair-loading"><LoaderCircle :size="18" class="working-spinner" />正在生成配对码…</div><p v-if="pairError" class="create-error" role="alert">{{ pairError }}</p></section></div>
  </div>
</template>
