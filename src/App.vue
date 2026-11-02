<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { App as NativeApp } from '@capacitor/app'
import { LocalNotifications } from '@capacitor/local-notifications'
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner'
import MarkdownIt from 'markdown-it'
import { Archive, ArrowLeft, ArrowUp, Bot, CalendarClock, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, CircleHelp, CornerDownRight, Ellipsis, ExternalLink, Eye, EyeOff, Folder, FolderPlus, GitFork, LoaderCircle, LogOut, Menu, MessageSquare, Monitor, MonitorCog, Moon, PanelLeftClose, Paperclip, Pencil, Pin, Plus, RefreshCw, RotateCcw, Search, Settings, ShieldAlert, Smartphone, Square, Sun, Trash2, Users, Wrench, X, QrCode, Copy } from 'lucide-vue-next'
import QRCode from 'qrcode'
import logoUrl from './assets/rmdex-logo.jpg'
import ToolEvent from './components/ToolEvent.vue'
import ArtifactStrip from './components/ArtifactStrip.vue'
import MessageBubble from './components/MessageBubble.vue'
import PlanExecutionCard from './components/PlanExecutionCard.vue'
import PermissionMenu from './components/PermissionMenu.vue'
import ModelMenu, { type ModelOption } from './components/ModelMenu.vue'
import ProjectMenu from './components/ProjectMenu.vue'
import UserMenu from './components/UserMenu.vue'
import SidebarResize from './components/SidebarResize.vue'
import { installInAppLinks } from './in-app-browser'
import { colleagueMessage, messageRequest, timeline, userText, type Artifact, type ContentPart, type MessageEntry, type Turn } from './conversation'
import { loadThreadCache, queueThreadCacheWrite, removeThreadCache } from './thread-cache'
import { commandSummary } from './command-summary'
import { modelPreferenceKey, resolveModelPreference, type ModelPreference } from './model-preferences'

type PcLoginSession = { accessToken: string; refreshToken: string; device: { id: string; name: string; online: boolean } }
const props = defineProps<{ pcLogin?: (username: string, password: string, deviceName: string) => Promise<PcLoginSession>; pcDeviceName?: string }>()
const emit = defineEmits<{ 'pc-authenticated': [] }>()

type Thread = { id: string; name?: string | null; preview?: string; cwd?: string; updatedAt?: number; status?: { type: string }; turns?: Turn[]; employeeId?: string; desktopDraft?: { projectId: string | null; deviceKey: string; preparing?: boolean } }
type Project = { id: string; name: string; path: string; source: 'local' | 'desktop'; nativeProjectId?: string }
type Employee = { id: string; name: string; role: string; instructions: string; deviceId: string; projectPath: string; threadId?: string; initializedThreadId?: string; createdAt: number; updatedAt: number }
type Plan = { id: string; name: string; prompt: string; employeeId?: string; employee?: { id: string; name: string; threadId?: string | null }; model?: string; effort?: string; cwd: string; trigger: { type: 'once' | 'interval'; at?: number; intervalMinutes?: number }; overlap: 'skip' | 'queue' | 'parallel'; enabled: boolean; nextRunAt: number; createdAt: number; updatedAt: number }
type PlanRun = { id: string; planId: string; planName: string; employeeId?: string; employeeName?: string; threadId?: string; turnId?: string; status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled'; triggeredAt: number; startedAt?: number; finishedAt?: number; summary?: string; error?: string }
const apiBase = Capacitor.isNativePlatform() ? 'https://code.kyeai.xyz' : ''
const apiUrl = (path: string) => path.startsWith('http://') || path.startsWith('https://') ? path : `${apiBase}${path}`
const RmdexBackgroundService = registerPlugin<{ start(options: { relayUrl: string; pushToken: string; cursor?: number }): Promise<void>; stop(): Promise<void> }>('RmdexBackgroundService')
const RmdexDeviceInfo = registerPlugin<{ getInfo(): Promise<{ platform?: string; manufacturer?: string; model?: string }> }>('RmdexDeviceInfo')
const RmdexFileDownload = registerPlugin<{ enqueue(options: { url: string; fileName: string; mimeType: string; authorization?: string }): Promise<{ id: string }>; status(options: { id: string }): Promise<{ status: string; loaded: number; total: number }>; openDownloads(): Promise<void> }>('RmdexFileDownload')
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
const pcDeviceName = ref(props.pcDeviceName || 'Codex 电脑')
const loginError = ref('')
const loginLoading = ref(false)
const authReady = ref(false)
const activePage = ref<'workspace' | 'users' | 'settings' | 'plan-detail'>('workspace')
const plans = ref<Plan[]>([])
const planRuns = ref<PlanRun[]>([])
const plansLoading = ref(false)
const plansError = ref('')
const selectedPlanId = ref<string | null>(null)
const planEditor = ref(false)
const planSaving = ref(false)
const planName = ref('')
const planPrompt = ref('')
const planEmployeeId = ref('')
const planCwd = ref('')
const planTriggerType = ref<'once' | 'interval'>('interval')
const planAt = ref('')
const planIntervalMinutes = ref('60')
const planOverlap = ref<'skip' | 'queue' | 'parallel'>('skip')
const planModel = ref('')
const planEffort = ref('')
const selectedPlan = computed(() => plans.value.find(plan => plan.id === selectedPlanId.value) || null)
const selectedPlanRuns = computed(() => planRuns.value.filter(run => run.planId === selectedPlanId.value).sort((a, b) => b.triggeredAt - a.triggeredAt))
const planModelOption = computed(() => models.value.find(model => model.id === planModel.value))
const planEfforts = computed(() => planModelOption.value?.supportedReasoningEfforts || [])
type ThemePreference = 'system' | 'light' | 'dark'
const themePreference = ref<ThemePreference>((localStorage.getItem('rmdex-theme-preference') as ThemePreference | null) || 'system')
const themeMediaQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null
const systemThemeDark = ref(themeMediaQuery?.matches ?? false)
const effectiveTheme = computed(() => themePreference.value === 'system' ? (systemThemeDark.value ? 'dark' : 'light') : themePreference.value)
function applyTheme() {
  document.documentElement.dataset.theme = effectiveTheme.value
  document.documentElement.style.colorScheme = effectiveTheme.value
}
function setThemePreference(value: ThemePreference) {
  themePreference.value = value
  localStorage.setItem('rmdex-theme-preference', value)
  applyTheme()
}
function handleSystemThemeChange(event: MediaQueryListEvent) {
  systemThemeDark.value = event.matches
  if (themePreference.value === 'system') applyTheme()
}
applyTheme()
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
const connectingDeviceId = ref('')
const revokingDeviceId = ref('')
const deviceSwitchTarget = ref<{ id: string; name: string } | null>(null)
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
const employeeSwipeOpenId = ref<string | null>(null)
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
const sidebarWidth = ref((() => {
  try { const width = Number(localStorage.getItem('rmdex-sidebar-width')); return width >= 220 && width <= 560 ? width : 290 }
  catch { return 290 }
})())
const resizingSidebar = ref(false)
function saveSidebarWidth(width: number) {
  try { localStorage.setItem('rmdex-sidebar-width', String(width)) } catch { /* Keep resizing available when storage is restricted. */ }
}
let removeInAppLinks: (() => void) | undefined
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
const employeeResetTarget = ref<Employee | null>(null)
const employeeResetError = ref('')
const createPath = ref('')
const createError = ref('')
const createProject = ref('')
const projects = ref<Project[]>([])
const collapsedProjectIds = ref<string[]>([])
const collapsedSidebarSections = ref<Record<'employees' | 'plans' | 'sessions', boolean>>({ employees: false, plans: false, sessions: false })
const projectEditor = ref(false)
const editingProjectId = ref<string | null>(null)
const projectName = ref('')
const projectPath = ref('')
const projectError = ref('')
const projectSaving = ref(false)
const deleteProjectTarget = ref<Project | null>(null)
const desktopProjects = ref<Array<{ id: string; name: string; path: string }>>([])
const defaultCapabilities = { mode: 'app-server', models: true, permissions: true, stop: true, approvals: true, create: true, send: true, retry: true, queue: true, steer: true, rename: true, fork: true, archive: true, delete: true, history: false, createRequiresPrompt: false }
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
type RetrySubmission = { threadId: string; deviceKey: string; text: string; files: File[]; failedId?: string; retryTurnId?: string }
type FailedMessage = RetrySubmission & { id: string; previousTurnIds: string[]; error: string }
const failedMessages = ref<Record<string, FailedMessage[]>>({})
const retrying = ref(false)
const regenerating = ref(false)
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
type UserInput = { id: string; method: string; params: { threadId: string; turnId: string; itemId: string; questions: Array<{ header: string; id: string; question: string; options?: Array<{ label: string; description: string }> | null; isOther?: boolean; isSecret?: boolean }>; isBlocking: boolean } }
const pendingUserInputs = ref<UserInput[]>([])
const userInputAnswers = ref<Record<string, Record<string, string>>>({})
const userInputOther = ref<Record<string, string>>({})
const userInputIndexes = ref<Record<string, number>>({})
const userInputSkipped = ref<Record<string, Record<string, boolean>>>({})
const answeringUserInput = ref<string | null>(null)
let poll: ReturnType<typeof setInterval> | undefined
let pollBusy = false
let threadStatusPollBusy = false
let appStateListener: { remove: () => Promise<void> } | undefined
let notificationListener: { remove: () => Promise<void> } | undefined
let appActive = true
let notificationSetupPromise: Promise<boolean> | undefined
let backgroundNotificationsReady = false
let backgroundNotificationSetupPromise: Promise<void> | undefined
const trackedTasks = new Map<string, { turnId: string; text: string; name: string }>()
const cacheHydratedKeys = new Set<string>()
const threadListCache = new Map<string, { savedAt: number; data: Thread[] }>()
const threadListRequests = new Map<string, Promise<Thread[]>>()
type ReadResult = { thread: Thread; activeTurnId: string | null; approvals: Approval[]; userInputs?: UserInput[]; lastTurn?: { id?: string; status: string; error?: { message?: string } } | null; page?: { hasMore: boolean; nextCursor: string | null } }
type ThreadStatus = {
  threadId: string
  activeTurnId: string | null
  approvals: Approval[]
  userInputs?: UserInput[]
  artifacts?: Artifact[]
  lastTurn?: { id?: string; status: string; error?: { message?: string } } | null
  live?: { turnId: string; status: string; error?: { message?: string }; sentText?: string; items: Turn['items'] } | null
}
const artifactLoading = ref<string | null>(null)
const artifactDownloadState = ref<{ artifactId: string; loaded: number; total: number; phase: 'downloading' | 'saving' } | null>(null)
const downloadedArtifacts = ref<Record<string, boolean>>({})
const savedArtifactIds = new Map<string, number | string>()
const pcArtifactApp = computed(() => !!props.pcLogin)
const artifactDownloadConfirm = ref<Artifact | null>(null)
const artifactPreview = ref<Artifact | null>(null)
const artifactPreviewUrl = ref('')
const artifactImageUrls = ref<Record<string, string>>({})
const artifactPreviewText = ref('')
const artifactPreviewError = ref('')
let artifactRequestVersion = 0
const artifactThumbnailLoads = new Map<string, Promise<void>>()
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
const requiresLogin = computed(() => props.pcLogin ? !clientToken.value : remoteMode.value && !adminToken.value && !clientToken.value && !pairLanding.value)
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
  if (backgroundNotificationsReady) return
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
        if (isActive) {
          void updateThread()
          void setupBackgroundNotifications()
        }
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
type NativeDeviceInfo = { platform?: string; manufacturer?: string; model?: string }
async function nativeDeviceInfo(): Promise<NativeDeviceInfo> {
  if (!Capacitor.isNativePlatform()) return {}
  try { return await RmdexDeviceInfo.getInfo() } catch { return { platform: Capacitor.getPlatform() } }
}
function deviceDisplayName(info: NativeDeviceInfo) {
  const model = info.model?.trim()
  if (model) return model
  if (info.manufacturer?.trim()) return `${info.manufacturer.trim()} 设备`
  return info.platform === 'ios' ? 'iPhone' : 'Android 设备'
}
async function setupBackgroundNotifications() {
  if (!Capacitor.isNativePlatform() || !clientToken.value) return
  if (backgroundNotificationSetupPromise) return backgroundNotificationSetupPromise
  const sessionToken = clientToken.value
  const setup = (async () => {
    try {
      if (!await setupNotifications()) return
      const current = await get<{ device: { id: string } }>('/api/client')
      let pushToken = localStorage.getItem('rmdex-background-push-token') || ''
      let cursor: number | undefined
      if (pushToken) {
        const response = await fetch(apiUrl('/api/push/status'), { headers: { Authorization: `Bearer ${pushToken}` } })
        const subscription = response.ok ? await response.json() as { deviceId?: string } : undefined
        if (!subscription || subscription.deviceId !== current.device.id) {
          pushToken = ''
          localStorage.removeItem('rmdex-background-push-token')
        }
      }
      if (sessionToken !== clientToken.value) return
      if (!pushToken) {
        const info = await nativeDeviceInfo()
        const result = await post('/api/push/register', { installationId: installationId(), clientName: deviceDisplayName(info), ...info }) as { pushToken: string; cursor?: number }
        pushToken = result.pushToken
        cursor = Number.isFinite(result.cursor) ? result.cursor : undefined
        if (sessionToken !== clientToken.value) return
        localStorage.setItem('rmdex-background-push-token', pushToken)
      }
      await RmdexBackgroundService.start({ relayUrl: apiBase, pushToken, ...(cursor === undefined ? {} : { cursor }) })
      backgroundNotificationsReady = true
    } catch (cause) {
      console.warn('Android background notifications could not start', cause)
      error.value = '后台通知连接失败，请检查网络并重新打开应用'
    }
  })()
  backgroundNotificationSetupPromise = setup
  try {
    await setup
  } finally {
    if (backgroundNotificationSetupPromise === setup) backgroundNotificationSetupPromise = undefined
    if (clientToken.value && sessionToken !== clientToken.value) void setupBackgroundNotifications()
  }
}
function stopBackgroundNotifications() {
  backgroundNotificationsReady = false
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
  if (result.artifacts?.length) {
    const artifactTurn = turns.find(item => item.id === result.lastTurn?.id || item.id === result.activeTurnId)
    if (artifactTurn) artifactTurn.artifacts = result.artifacts.filter(item => item.turnId === artifactTurn.id)
  }
  selected.value.turns = normalizeTurns(selected.value.turns)
  activeTurnId.value = result.activeTurnId
  pendingApprovals.value = result.approvals || []
  pendingUserInputs.value = result.userInputs || []
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
  selected.value = result.thread; activeTurnId.value = result.activeTurnId; pendingApprovals.value = result.approvals || []; pendingUserInputs.value = result.userInputs || []; lastTurn.value = result.lastTurn || null
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
    preview = commandSummary(first.command) || commandSummary(action?.command || action?.name)
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
function clearArtifactPreview() {
  artifactRequestVersion++
  if (artifactPreviewUrl.value && artifactPreview.value?.mimeType.startsWith('image/')) artifactImageUrls.value[artifactPreview.value.id] = artifactPreviewUrl.value
  else if (artifactPreviewUrl.value) URL.revokeObjectURL(artifactPreviewUrl.value)
  artifactPreviewUrl.value = ''
  artifactPreviewText.value = ''
  artifactPreviewError.value = ''
  artifactPreview.value = null
}
function artifactUrl(artifact: Artifact, action: 'content' | 'preview') {
  return `/api/threads/${encodeURIComponent(artifact.threadId)}/artifacts/${encodeURIComponent(artifact.id)}/${action}`
}
function loadArtifactThumbnail(artifact: Artifact) {
  if (artifactImageUrls.value[artifact.id] || artifactThumbnailLoads.has(artifact.id) || artifact.previewMode !== 'thumbnail') return
  const request = (async () => {
    try {
      const response = await authenticatedFetch(artifactUrl(artifact, 'preview'), {}, 'client')
      if (!response.ok) return
      const objectUrl = URL.createObjectURL(await response.blob())
      if (selected.value?.id !== artifact.threadId) URL.revokeObjectURL(objectUrl)
      else artifactImageUrls.value[artifact.id] = objectUrl
    } catch { /* Keep the file card usable if thumbnail preview is unavailable. */ }
    finally { artifactThumbnailLoads.delete(artifact.id) }
  })()
  artifactThumbnailLoads.set(artifact.id, request)
}
function formatArtifactSize(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
async function readArtifactResponse(response: Response, artifact: Artifact) {
  const total = Number(response.headers.get('content-length')) || artifact.size || 0
  if (!response.body) {
    const blob = await response.blob()
    artifactDownloadState.value = { artifactId: artifact.id, loaded: blob.size, total: total || blob.size, phase: 'downloading' }
    return blob
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value)
    loaded += value.byteLength
    artifactDownloadState.value = { artifactId: artifact.id, loaded, total: total || loaded, phase: 'downloading' }
  }
  const data = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
  return new Blob([data.buffer], { type: response.headers.get('content-type') || artifact.mimeType })
}
async function downloadArtifact(artifact: Artifact) {
  artifactLoading.value = artifact.id
  artifactDownloadState.value = { artifactId: artifact.id, loaded: 0, total: artifact.size || 0, phase: 'downloading' }
  try {
    if (Capacitor.isNativePlatform()) {
      const result = await RmdexFileDownload.enqueue({ url: apiUrl(artifactUrl(artifact, 'content')), fileName: artifact.name, mimeType: artifact.mimeType, ...(clientToken.value ? { authorization: `Bearer ${clientToken.value}` } : {}) })
      savedArtifactIds.set(artifact.id, result.id)
      let finished = false
      while (!finished) {
        const status = await RmdexFileDownload.status({ id: String(result.id) })
        const total = status.total || artifact.size || 0
        artifactDownloadState.value = { artifactId: artifact.id, loaded: status.loaded || 0, total, phase: 'downloading' }
        finished = status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled'
        if (!finished) await new Promise(resolve => setTimeout(resolve, 350))
        if (status.status === 'failed' || status.status === 'cancelled') throw new Error('系统下载失败')
      }
      downloadedArtifacts.value = { ...downloadedArtifacts.value, [artifact.id]: true }
      artifactDownloadState.value = null
      return
    }
    const response = await authenticatedFetch(artifactUrl(artifact, 'content'), {}, 'client')
    if (!response.ok) {
      const result = await readJsonResponse(response, '下载文件失败')
      throw new Error(result?.error || '下载文件失败')
    }
    const blob = await readArtifactResponse(response, artifact)
    if (pcArtifactApp.value) {
      artifactDownloadState.value = { artifactId: artifact.id, loaded: blob.size, total: blob.size, phase: 'saving' }
      const saved = await fetch('/pc-api/files', { method: 'POST', headers: { 'Content-Type': artifact.mimeType, 'X-Rmdex-File-Name': encodeURIComponent(artifact.name), 'X-Rmdex-Mime-Type': artifact.mimeType }, body: blob })
      const savedResult = await readJsonResponse(saved, '保存文件失败')
      if (!saved.ok || !savedResult.fileId) throw new Error(savedResult?.error || '保存文件失败')
      savedArtifactIds.set(artifact.id, savedResult.fileId)
      downloadedArtifacts.value = { ...downloadedArtifacts.value, [artifact.id]: true }
      artifactDownloadState.value = null
      return
    }
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = artifact.name
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    downloadedArtifacts.value = { ...downloadedArtifacts.value, [artifact.id]: true }
    artifactDownloadState.value = null
  } catch (cause) {
    error.value = `下载 ${artifact.name} 失败：${cause instanceof Error ? cause.message : String(cause)}`
    artifactDownloadState.value = null
  } finally { if (artifactLoading.value === artifact.id) artifactLoading.value = null }
}
function requestArtifactDownload(artifact: Artifact) {
  if (artifactLoading.value) return
  artifactDownloadConfirm.value = artifact
}
function cancelArtifactDownload() {
  if (!artifactLoading.value) artifactDownloadConfirm.value = null
}
async function confirmArtifactDownload() {
  const artifact = artifactDownloadConfirm.value
  if (!artifact || artifactLoading.value) return
  artifactDownloadConfirm.value = null
  await downloadArtifact(artifact)
}
async function openArtifactLocation(artifact: Artifact) {
  if (!downloadedArtifacts.value[artifact.id]) return
  try {
    if (Capacitor.isNativePlatform()) {
      await RmdexFileDownload.openDownloads()
      return
    }
    if (pcArtifactApp.value) {
      const fileId = savedArtifactIds.get(artifact.id)
      if (typeof fileId !== 'string') throw new Error('下载文件记录不存在，请重新下载')
      const response = await fetch('/pc-api/files/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId }) })
      const result = await readJsonResponse(response, '打开文件位置失败')
      if (!response.ok) throw new Error(result?.error || '打开文件位置失败')
    }
  } catch (cause) { error.value = `打开 ${artifact.name} 位置失败：${cause instanceof Error ? cause.message : String(cause)}` }
}
async function previewArtifact(artifact: Artifact) {
  clearArtifactPreview()
  const version = artifactRequestVersion
  artifactPreview.value = artifact
  artifactLoading.value = artifact.id
  try {
    const response = await authenticatedFetch(artifactUrl(artifact, 'preview'), {}, 'client')
    if (!response.ok) {
      const result = await readJsonResponse(response, '预览文件失败')
      throw new Error(result?.error || '预览文件失败')
    }
    if (version !== artifactRequestVersion) return
    if (artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json') {
      const text = await response.text()
      if (text.length > 256 * 1024) throw new Error('文本预览超过 256 KB，请下载查看')
      if (version !== artifactRequestVersion) return
      artifactPreviewText.value = text
    } else {
      const objectUrl = URL.createObjectURL(await response.blob())
      if (version !== artifactRequestVersion) URL.revokeObjectURL(objectUrl)
      else {
        artifactPreviewUrl.value = objectUrl
        if (artifact.mimeType.startsWith('image/')) artifactImageUrls.value[artifact.id] = objectUrl
      }
    }
  } catch (cause) {
    if (version === artifactRequestVersion) artifactPreviewError.value = cause instanceof Error ? cause.message : String(cause)
  } finally { if (artifactLoading.value === artifact.id) artifactLoading.value = null }
}
function handlePreviewKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && artifactPreview.value) clearArtifactPreview()
  else if (event.key === 'Escape' && previewImageUrl.value) closeImagePreview()
}
watch(() => selected.value?.id, () => {
  clearArtifactPreview()
  for (const url of Object.values(artifactImageUrls.value)) URL.revokeObjectURL(url)
  artifactImageUrls.value = {}
})

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
    restoreModelPreference(selected.value?.id)
    modelsLoadedKey = requestedKey
  } catch (e) {
    models.value = []; selectedModel.value = null; selectedEffort.value = null
    capabilities.value = { ...defaultCapabilities, models: false, permissions: false, stop: false, send: false, create: false }
    error.value = `设备设置暂不可用：${e instanceof Error ? e.message : String(e)}`
  } finally { modelLoading.value = false }
}
function readModelPreference(threadId: string): ModelPreference | null {
  try {
    const key = modelPreferenceKey(remoteDevice.value?.id, desktopMode.value ? 'desktop' : 'app-server', threadId)
    const saved = JSON.parse(localStorage.getItem(key) || 'null') as Partial<ModelPreference> | null
    return typeof saved?.model === 'string' && saved.model
      ? { model: saved.model, effort: typeof saved.effort === 'string' ? saved.effort : null }
      : null
  } catch { return null }
}
function writeModelPreference(threadId: string, preference: ModelPreference) {
  const key = modelPreferenceKey(remoteDevice.value?.id, desktopMode.value ? 'desktop' : 'app-server', threadId)
  localStorage.setItem(key, JSON.stringify(preference))
}
function restoreModelPreference(threadId?: string) {
  const preference = resolveModelPreference(models.value, threadId ? readModelPreference(threadId) : null)
  selectedModel.value = preference.model || null
  selectedEffort.value = preference.effort
}
function saveModelPreference() {
  const threadId = selected.value?.id
  if (!threadId || !selectedModel.value) return
  writeModelPreference(threadId, { model: selectedModel.value, effort: selectedEffort.value })
}
function copyModelPreference(fromThreadId: string, toThreadId: string) {
  const preference = readModelPreference(fromThreadId)
  if (preference) writeModelPreference(toThreadId, preference)
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
function requestEmployeeThreadReset(employee: Employee) {
  if (employeeResetting.value) return
  employeeResetError.value = ''
  employeeResetTarget.value = employee
}
function closeEmployeeThreadResetConfirm() {
  if (!employeeResetting.value) employeeResetTarget.value = null
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
async function resetEmployeeThread(employee: Employee): Promise<boolean> {
  if (employeeResetting.value) return false
  employeeResetting.value = employee.id
  employeeResetError.value = ''
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
    return true
  } catch (e) {
    employeeResetError.value = e instanceof Error ? e.message : String(e)
    error.value = employeeResetError.value
    return false
  } finally { employeeResetting.value = null }
}
async function confirmEmployeeThreadReset() {
  const employee = employeeResetTarget.value
  if (!employee) return
  if (await resetEmployeeThread(employee)) employeeResetTarget.value = null
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
function loadCollapsedSidebarSections() {
  try {
    const raw = localStorage.getItem(`rmdex-collapsed-sidebar-sections:${archiveScope()}`)
    const saved = raw ? JSON.parse(raw) as Partial<Record<'employees' | 'plans' | 'sessions', unknown>> : {}
    collapsedSidebarSections.value = {
      employees: saved.employees === true,
      plans: saved.plans === true,
      sessions: saved.sessions === true,
    }
  } catch { collapsedSidebarSections.value = { employees: false, plans: false, sessions: false } }
}
function persistCollapsedSidebarSections() {
  localStorage.setItem(`rmdex-collapsed-sidebar-sections:${archiveScope()}`, JSON.stringify(collapsedSidebarSections.value))
}
function sidebarSectionIsCollapsed(section: 'employees' | 'plans' | 'sessions') {
  return collapsedSidebarSections.value[section]
}
function toggleSidebarSection(section: 'employees' | 'plans' | 'sessions') {
  collapsedSidebarSections.value = { ...collapsedSidebarSections.value, [section]: !collapsedSidebarSections.value[section] }
  persistCollapsedSidebarSections()
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
function handleEmployeeTouchStart(employee: Employee, event: TouchEvent) {
  touchThreadId = `employee:${employee.id}`
  touchStartX = event.touches[0]?.clientX || 0
  touchCurrentX = touchStartX
  touchMoved = false
  clearThreadLongPress()
}
function handleEmployeeTouchMove(employee: Employee, event: TouchEvent) {
  if (touchThreadId !== `employee:${employee.id}`) return
  touchCurrentX = event.touches[0]?.clientX || touchCurrentX
  if (Math.abs(touchCurrentX - touchStartX) > 8) touchMoved = true
  if (touchStartX - touchCurrentX > 8) employeeSwipeOpenId.value = employee.id
  else if (touchCurrentX - touchStartX > 8 && employeeSwipeOpenId.value === employee.id) employeeSwipeOpenId.value = null
}
function handleEmployeeTouchEnd(employee: Employee) {
  if (touchThreadId === `employee:${employee.id}` && touchMoved && Math.abs(touchCurrentX - touchStartX) > 8) {
    employeeSwipeOpenId.value = touchStartX - touchCurrentX > 45 ? employee.id : null
  }
  touchThreadId = ''
}
function closeThreadMenus() {
  threadMenuId.value = null
  swipeOpenId.value = null
  employeeSwipeOpenId.value = null
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
  saveModelPreference()
}
function rememberEffort(value: string) {
  selectedEffort.value = value
  saveModelPreference()
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
    loadCollapsedSidebarSections()
    await hydrateThreadCache()
    const [result] = await Promise.all([
      loadThreads(force),
      loadModels(),
      loadProjects(),
      loadEmployees(),
      ...(force ? [loadPlans()] : []),
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
  const raw = (item.input || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n').trim()
  const colleague = colleagueMessage(raw)
  return colleague ? `来自员工 ${colleague.senderName}：${colleague.text}` : userText(raw) || '排队任务'
}
function isColleagueQueued(item: QueuedSubmission) {
  const raw = (item.input || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n').trim()
  return Boolean(colleagueMessage(raw))
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
  restoreModelPreference(thread.id)
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
  if (!selected.value || selected.value.desktopDraft || pollBusy || threadLoading.value || threadLoadError.value || regenerating.value) return
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
async function loadPlans() {
  if (!clientToken.value) return
  plansLoading.value = true; plansError.value = ''
  try {
    const [planResult, runResult] = await Promise.all([get<{ data?: Plan[] }>('/api/plans'), get<{ data?: PlanRun[] }>('/api/plan-runs')])
    plans.value = planResult.data || []
    planRuns.value = runResult.data || []
  } catch (e) { plansError.value = e instanceof Error ? e.message : String(e) }
  finally { plansLoading.value = false }
}
function openPlanEditor() {
  planName.value = ''; planPrompt.value = ''; planEmployeeId.value = ''; planCwd.value = selected.value?.cwd || projects.value[0]?.path || ''; planTriggerType.value = 'interval'; planAt.value = ''; planIntervalMinutes.value = '60'; planOverlap.value = 'skip'; planModel.value = selectedModel.value || ''; planEffort.value = selectedEffort.value || ''; planEditor.value = true
  void loadModels().then(() => {
    const defaultModel = models.value.find(model => model.id === planModel.value) || models.value.find(model => model.isDefault) || models.value[0]
    if (!defaultModel) return
    planModel.value = defaultModel.id
    planEffort.value = planEfforts.value.some(item => item.reasoningEffort === planEffort.value) ? planEffort.value : (defaultModel.defaultReasoningEffort || defaultModel.supportedReasoningEfforts[0]?.reasoningEffort || '')
  })
}
function openPlanEditorFromSidebar() {
  openPlanEditor()
}
function openPlan(plan: Plan) {
  selectedPlanId.value = plan.id
  activePage.value = 'plan-detail'
  void loadPlans()
}
function backToWorkspace() {
  selectedPlanId.value = null
  activePage.value = 'workspace'
}
function formatPlanSidebarMeta(plan: Plan) {
  return `${plan.enabled ? '运行中' : '已暂停'} · ${formatPlanTrigger(plan)}`
}
function formatPlanModel(plan: Plan) {
  const model = models.value.find(item => item.id === plan.model)
  return model?.displayName || plan.model || '设备默认模型'
}
function formatPlanTrigger(plan: Plan) {
  return plan.trigger.type === 'once' ? `一次性 · ${new Date(plan.trigger.at || 0).toLocaleString()}` : `每 ${plan.trigger.intervalMinutes || 60} 分钟`
}
function formatPlanRunStatus(status: PlanRun['status']) {
  return ({ pending: '等待中', running: '执行中', completed: '已完成', skipped: '已跳过', failed: '失败', cancelled: '已取消' } as Record<string, string>)[status] || status
}
async function savePlan() {
  if (planSaving.value) return
  planSaving.value = true; plansError.value = ''
  try {
    const payload = { mode: 'create', name: planName.value.trim(), prompt: planPrompt.value.trim(), cwd: planCwd.value.trim(), ...(planEmployeeId.value ? { employeeId: planEmployeeId.value } : {}), ...(planModel.value ? { model: planModel.value } : {}), ...(planEffort.value ? { effort: planEffort.value } : {}), triggerType: planTriggerType.value, ...(planTriggerType.value === 'once' ? { at: new Date(planAt.value).getTime() } : { intervalMinutes: Number(planIntervalMinutes.value) }), overlap: planOverlap.value }
    const result = await post('/api/plans/update', payload) as { plan?: Plan }
    planEditor.value = false
    await loadPlans()
    if (result.plan?.id) selectedPlanId.value = result.plan.id
  } catch (e) { plansError.value = e instanceof Error ? e.message : String(e) }
  finally { planSaving.value = false }
}
async function updatePlan(plan: Plan, mode: 'pause' | 'resume' | 'run' | 'delete') {
  if (mode === 'delete' && !window.confirm(`删除计划“${plan.name}”？`)) return
  try {
    await post('/api/plans/update', { mode, id: plan.id })
    if (mode === 'delete' && selectedPlanId.value === plan.id) backToWorkspace()
    await loadPlans()
  }
  catch (e) { plansError.value = e instanceof Error ? e.message : String(e) }
}
async function cancelPlanRun(run: PlanRun) {
  try { await post(`/api/plan-runs/${run.id}/cancel`, {}); await loadPlans() }
  catch (e) { plansError.value = e instanceof Error ? e.message : String(e) }
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
    if (props.pcLogin) {
      const session = await props.pcLogin(adminUsername.value.trim(), adminPassword.value, pcDeviceName.value.trim())
      storeSession('client', session)
      remoteDevice.value = session.device
      localStorage.setItem('rmdex-admin-username', adminUsername.value.trim())
      adminPassword.value = ''
      authReady.value = true
      emit('pc-authenticated')
      await refresh()
      return
    }
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
function resetDeviceScopedState() {
  selectionVersion++
  selected.value = null
  activeEmployeeId.value = null
  activeTurnId.value = null
  pendingApprovals.value = []
  pendingUserInputs.value = []
  lastTurn.value = null
  queuedSubmissions.value = []
  failedMessages.value = {}
  pendingMessages.value = {}
  threadIndicators.value = {}
  localDraftThreads.value = []
  historyCursor.value = null
  mobileDetail.value = false
  error.value = ''
  modelsLoadedKey = ''
  plans.value = []
  planRuns.value = []
  selectedPlanId.value = null
  plansError.value = ''
}
function requestDeviceSwitch(device: { id: string; name: string; online: boolean }) {
  if (!device.online || remoteDevice.value?.id === device.id || connectingDeviceId.value) return
  deviceSwitchTarget.value = { id: device.id, name: device.name }
}
async function confirmDeviceSwitch() {
  const target = deviceSwitchTarget.value
  if (!target) return
  if (await connectDevice(target.id)) deviceSwitchTarget.value = null
}
async function connectDevice(deviceId: string): Promise<boolean> {
  if (connectingDeviceId.value) return false
  pairError.value = ''
  connectingDeviceId.value = deviceId
  try {
    const result = await adminFetch<{ accessToken?: string; refreshToken?: string; clientToken: string; device: { id: string; name: string; online: boolean } }>(`/api/devices/${deviceId}/web-client`, 'POST', {})
    resetDeviceScopedState()
    storeSession('client', result)
    remoteDevice.value = result.device
    showDevices.value = false
    await refresh()
    return true
  } catch (e) { pairError.value = e instanceof Error ? e.message : String(e); return false }
  finally { connectingDeviceId.value = '' }
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
    const info = await nativeDeviceInfo()
    const response = await fetch(apiUrl('/api/pair/claim'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: deviceDisplayName(info), ...info }) })
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
  if (revokingDeviceId.value) return
  if (!window.confirm('撤销后此电脑与所有已配对手机都会断开。确定继续？')) return
  revokingDeviceId.value = deviceId
  try { await adminFetch(`/api/devices/${deviceId}`, 'DELETE'); await loadDevices() }
  catch (e) { pairError.value = e instanceof Error ? e.message : String(e) }
  finally { revokingDeviceId.value = '' }
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
  copyModelPreference(thread.id, created.id)
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
      if (!capabilities.value.retry) throw new Error('当前设备暂不支持重新生成，请更新 rmdex-pc')
      submission = { threadId: thread.id, deviceKey, text: messageRequest(message.item), files: [], retryTurnId: message.turnId }
    }
    if (isCurrent()) await send(submission)
  } catch (e) { if (isCurrent()) error.value = e instanceof Error ? e.message : String(e) }
  finally { retrying.value = false }
}
async function regenerateMessage(thread: Thread, retry: RetrySubmission, settings: Record<string, unknown>, mode: string) {
  const id = thread.id
  const key = `rmdex-retry:${retry.deviceKey}:${id}:${retry.retryTurnId}`
  const payload = { turnId: retry.retryTurnId, ...settings, permissionMode: mode, ...(activeEmployeeId.value ? { employeeId: activeEmployeeId.value } : {}) }
  const requestId = operationId(key, JSON.stringify(payload))
  const version = ++selectionVersion // Ignore polls started before history is replaced.
  const isCurrent = () => selectionVersion === version && selected.value?.id === id && (remoteDevice.value?.id || 'local') === retry.deviceKey
  sending.value = true
  sendingThreadId.value = id
  regenerating.value = true
  error.value = ''
  try {
    const result = await post(`/api/threads/${id}/retry`, { ...payload, operationId: requestId }) as { outcome?: string; message?: string; thread?: Thread; threadId?: string; turn?: { id: string; status?: string }; forked?: boolean }
    if (result.outcome === 'rejected') {
      sessionStorage.removeItem(key)
      throw new Error(result.message || '暂时无法重试这条消息')
    }
    if (result.outcome === 'started') sessionStorage.removeItem(key)
    const target = result.thread
    if (target?.id && (remoteDevice.value?.id || 'local') === retry.deviceKey) {
      const refreshed: Thread = result.forked ? { ...target, name: `${thread.name || thread.preview || '会话'} · 重试` } : { ...thread, ...target, turns: undefined }
      threadCache.delete(threadCacheKey(target.id))
      void removeThreadCache(threadCacheKey(target.id))
      threads.value = [refreshed, ...threads.value.filter(item => item.id !== target.id)]
      if (result.forked) {
        drafts.value[target.id] = drafts.value[id] || ''
        if (attachmentsByThread.value[id]) attachmentsByThread.value[target.id] = [...attachmentsByThread.value[id]!]
      }
      if (result.turn?.id && result.turn.status === 'inProgress') trackTask(target.id, result.turn.id, retry.text, refreshed.name || 'Codex 会话')
      if (isCurrent()) {
        await openThread(refreshed)
        if (result.forked && result.outcome === 'started') {
          copyFeedback.value = '已在新会话中重试，原会话已保留'
          if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer)
          copyFeedbackTimer = setTimeout(() => { copyFeedback.value = '' }, 2600)
        }
      }
    } else if (isCurrent()) {
      threadCache.delete(threadCacheKey(id))
      await openThread({ ...thread, turns: undefined })
    }
    if (result.outcome !== 'started' && (selected.value?.id === (target?.id || id))) error.value = result.message || '重试结果未确认，请刷新会话核对，未重复提交'
  } catch (e) {
    if ((remoteDevice.value?.id || 'local') === retry.deviceKey && selected.value?.id === id) {
      const detail = e instanceof Error ? e.message : String(e)
      // Keep the same operation ID after transport failure. Never turn an
      // uncertain regeneration into a normal send of the original message.
      if (selectionVersion === version) {
        try { const read = await readThread(id, true); if (isCurrent()) applyRead(read) } catch { /* Preserve the original error. */ }
      }
      error.value = detail
    }
  } finally { regenerating.value = false; sending.value = false; sendingThreadId.value = null }
}
async function send(retry?: RetrySubmission) {
  if (!retry && retrying.value) return
  if (!selected.value || sending.value || activeTurnId.value || selected.value.desktopDraft?.preparing || !capabilities.value.send) return
  if (retry && (retry.threadId !== selected.value.id || retry.deviceKey !== (remoteDevice.value?.id || 'local'))) return
  const thread = selected.value
  const id = selected.value.id
  const text = retry ? retry.text : (drafts.value[id] || '').trim()
  const files = retry ? retry.files : [...(attachmentsByThread.value[id] || [])]
  if (!text && !files.length && !retry?.retryTurnId) return
  if (capabilities.value.permissions && permissionMode.value === 'full' && !skipFullAccessConfirm.value && !fullAccessConfirmed.value) { fullAccessRetry = retry; showFullAccessConfirm.value = true; return }
  fullAccessConfirmed.value = false
  if (retry?.retryTurnId) {
    await regenerateMessage(thread, retry, desktopSettings(), permissionMode.value)
    return
  }
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
function chooseUserInput(requestId: string, questionId: string, value: string) {
  const answers = userInputAnswers.value[requestId] || (userInputAnswers.value[requestId] = {})
  answers[questionId] = value
  if (userInputSkipped.value[requestId]) delete userInputSkipped.value[requestId]![questionId]
}
function chosenUserInput(requestId: string, questionId: string) { return userInputAnswers.value[requestId]?.[questionId] || '' }
function currentUserInputQuestion(request: UserInput) {
  const index = userInputIndexes.value[request.id] || 0
  return { index, question: request.params.questions[index] }
}
function userInputHasAnswer(requestId: string, question: UserInput['params']['questions'][number]) {
  const choice = chosenUserInput(requestId, question.id)
  return choice === '__other__' ? Boolean(userInputOther.value[`${requestId}:${question.id}`]?.trim()) : Boolean(choice)
}
async function advanceUserInput(request: UserInput, skip = false) {
  const { index, question } = currentUserInputQuestion(request)
  if (!question || answeringUserInput.value) return
  if (skip) {
    const skipped = userInputSkipped.value[request.id] || (userInputSkipped.value[request.id] = {})
    skipped[question.id] = true
    if (userInputAnswers.value[request.id]) delete userInputAnswers.value[request.id]![question.id]
  }
  if (index < request.params.questions.length - 1) {
    userInputIndexes.value[request.id] = index + 1
    return
  }
  await answerUserInput(request)
}
async function answerUserInput(request: UserInput) {
  if (answeringUserInput.value) return
  const answers: Record<string, { answers: string[] }> = {}
  for (const question of request.params.questions) {
    const choice = chosenUserInput(request.id, question.id)
    const other = userInputOther.value[`${request.id}:${question.id}`] || ''
    const customAnswer = choice === '__other__' || (!question.options?.length && !question.isOther)
    answers[question.id] = { answers: userInputSkipped.value[request.id]?.[question.id] ? [] : [customAnswer ? other : choice].filter(Boolean) }
  }
  answeringUserInput.value = request.id
  try {
    await post(`/api/user-input/${request.id}`, { answers })
    pendingUserInputs.value = pendingUserInputs.value.filter(item => item.id !== request.id)
    delete userInputAnswers.value[request.id]
    delete userInputIndexes.value[request.id]
    delete userInputSkipped.value[request.id]
    for (const question of request.params.questions) delete userInputOther.value[`${request.id}:${question.id}`]
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { answeringUserInput.value = null }
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
  themeMediaQuery?.addEventListener('change', handleSystemThemeChange)
  removeInAppLinks = installInAppLinks(message => { error.value = message })
  window.addEventListener('keydown', handlePreviewKey)
  const desktopOpenThreadId = new URLSearchParams(location.search).get('openThread')?.trim() || ''
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
  if (desktopOpenThreadId) {
    await refresh()
    const thread = threads.value.find(item => item.id === desktopOpenThreadId)
    if (thread) await openThread(thread)
    else error.value = '找不到要打开的会话，可能已被删除或当前设备无权访问'
    history.replaceState({}, '', `${location.pathname}${location.hash}`)
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
  if (clientToken.value) void loadPlans()
  authReady.value = true
  poll = setInterval(() => { void updateThread(); void refreshThreadIndicators(); if (adminToken.value && showDevices.value) void loadDevices() }, 2000)
})
onUnmounted(() => { themeMediaQuery?.removeEventListener('change', handleSystemThemeChange); removeInAppLinks?.(); window.removeEventListener('keydown', handlePreviewKey); if (poll) clearInterval(poll); clearThreadLongPress(); clearArtifactPreview(); for (const url of Object.values(authenticatedImages.value)) URL.revokeObjectURL(url); void appUrlListener?.remove(); void appStateListener?.remove(); void notificationListener?.remove() })
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
        <template v-if="props.pcLogin">
          <label for="pc-device-name">电脑名称</label>
          <input id="pc-device-name" v-model="pcDeviceName" maxlength="80" required placeholder="例如：办公室电脑" />
        </template>
        <p v-if="loginError" class="auth-error" role="alert">{{ loginError }}</p>
        <button class="auth-submit" type="submit" :disabled="loginLoading || !adminUsername.trim() || !adminPassword || (props.pcLogin && !pcDeviceName.trim())">{{ loginLoading ? (props.pcLogin ? '正在连接…' : '正在登录…') : props.pcLogin ? '登录并启动' : '登录' }}</button>
      </form>
      <p class="auth-help">{{ props.pcLogin ? '登录后会自动注册这台电脑并启动本地服务。' : '账号由系统管理员创建。如无法登录，请联系管理员。' }}</p>
    </section>
  </main>
  <main v-else-if="activePage === 'settings'" class="settings-page">
    <header class="settings-topbar"><button class="admin-brand" type="button" @click="activePage = 'workspace'"><img :src="logoUrl" alt="" /><span>rmdex</span></button><button class="admin-nav-button" type="button" @click="activePage = 'workspace'"><ArrowLeft :size="16" />返回工作区</button></header>
    <section class="settings-content" aria-labelledby="settings-title">
      <div class="settings-heading"><p class="eyebrow">偏好设置</p><h1 id="settings-title">设置</h1><p>调整界面外观和账号操作。</p></div>
      <section class="settings-card" aria-labelledby="appearance-title">
        <div class="settings-card-heading"><span class="settings-card-icon"><MonitorCog :size="18" /></span><div><h2 id="appearance-title">外观</h2><p>默认跟随系统，也可以手动固定亮色或暗色。</p></div></div>
        <div class="theme-options" role="radiogroup" aria-label="主题模式">
          <button type="button" class="theme-option" :class="{ selected: themePreference === 'system' }" role="radio" :aria-checked="themePreference === 'system'" @click="setThemePreference('system')"><span class="theme-option-icon"><MonitorCog :size="17" /></span><span><strong>跟随系统</strong><small>当前系统：{{ systemThemeDark ? '暗色' : '亮色' }}</small></span><CircleCheck v-if="themePreference === 'system'" :size="17" class="theme-check" /></button>
          <button type="button" class="theme-option" :class="{ selected: themePreference === 'light' }" role="radio" :aria-checked="themePreference === 'light'" @click="setThemePreference('light')"><span class="theme-option-icon"><Sun :size="17" /></span><span><strong>亮色</strong><small>使用明亮的界面配色</small></span><CircleCheck v-if="themePreference === 'light'" :size="17" class="theme-check" /></button>
          <button type="button" class="theme-option" :class="{ selected: themePreference === 'dark' }" role="radio" :aria-checked="themePreference === 'dark'" @click="setThemePreference('dark')"><span class="theme-option-icon"><Moon :size="17" /></span><span><strong>暗色</strong><small>降低夜间使用时的亮度</small></span><CircleCheck v-if="themePreference === 'dark'" :size="17" class="theme-check" /></button>
        </div>
      </section>
      <section class="settings-card settings-account-card" aria-labelledby="account-title">
        <div class="settings-card-heading"><span class="settings-card-icon"><Users :size="18" /></span><div><h2 id="account-title">账号</h2><p>退出后需要重新登录才能访问工作区。</p></div></div>
        <button class="settings-logout-button" type="button" @click="logout"><LogOut :size="16" />退出登录</button>
      </section>
    </section>
  </main>
  <main v-else-if="activePage === 'plan-detail'" class="settings-page">
    <header class="settings-topbar"><button class="admin-brand" type="button" @click="backToWorkspace"><img :src="logoUrl" alt="" /><span>rmdex</span></button><button class="admin-nav-button" type="button" @click="backToWorkspace"><ArrowLeft :size="16" />返回工作区</button></header>
    <section class="settings-content" aria-labelledby="plans-title">
      <div class="settings-heading"><p class="eyebrow">当前设备：{{ remoteDevice?.name || '本机设备' }}</p><h1 id="plans-title">{{ selectedPlan?.name || '计划任务' }}</h1><p>{{ selectedPlan ? '查看这个计划的配置、执行控制和历史执行记录。' : '正在加载当前设备的计划。' }}</p></div>
      <section class="settings-card plan-card" aria-labelledby="plan-list-title">
        <div class="settings-card-heading"><span class="settings-card-icon"><CalendarClock :size="18" /></span><div><h2 id="plan-list-title">计划详情</h2><p>未绑定员工的执行线程会隐藏在普通会话列表之外。</p></div></div>
        <p v-if="plansError" class="create-error" role="alert">{{ plansError }}</p>
        <div v-if="plansLoading" class="automation-state">正在加载当前设备的计划…</div>
        <template v-if="selectedPlan"><div class="plan-detail-summary"><div><span class="plan-detail-label">状态</span><strong>{{ selectedPlan.enabled ? '运行中' : '已暂停' }}</strong></div><div><span class="plan-detail-label">绑定员工</span><strong>{{ selectedPlan.employee?.name || '独立执行' }}</strong></div><div><span class="plan-detail-label">执行模型</span><strong>{{ formatPlanModel(selectedPlan) }}{{ selectedPlan.effort ? ` · ${selectedPlan.effort}` : '' }}</strong></div><div><span class="plan-detail-label">触发方式</span><strong>{{ formatPlanTrigger(selectedPlan) }}</strong></div><div><span class="plan-detail-label">下次执行</span><strong>{{ selectedPlan.enabled ? new Date(selectedPlan.nextRunAt).toLocaleString() : '已暂停' }}</strong></div></div><div class="plan-detail-prompt"><span class="plan-detail-label">任务内容</span><p>{{ selectedPlan.prompt }}</p></div><div class="plan-item-actions plan-detail-actions"><button type="button" @click="updatePlan(selectedPlan, 'run')">立即执行</button><button type="button" @click="updatePlan(selectedPlan, selectedPlan.enabled ? 'pause' : 'resume')">{{ selectedPlan.enabled ? '暂停计划' : '恢复计划' }}</button><button class="danger-text-button" type="button" @click="updatePlan(selectedPlan, 'delete')">删除计划</button></div><div class="plan-detail-runs"><div class="plan-detail-section-heading"><div><h3>执行记录</h3><p>只显示这个计划的执行历史。</p></div><button class="icon-button" type="button" title="刷新执行记录" aria-label="刷新执行记录" :disabled="plansLoading" @click="loadPlans"><RefreshCw :size="15" /></button></div><div v-if="!selectedPlanRuns.length" class="automation-state">这个计划还没有执行记录。</div><div v-else class="automation-list"><article v-for="run in selectedPlanRuns" :key="run.id" class="automation-item"><div><strong>{{ formatPlanRunStatus(run.status) }}</strong><small>{{ new Date(run.triggeredAt).toLocaleString() }} · {{ run.employeeName || '独立执行' }}</small><p>{{ run.error || run.summary || '等待执行结果' }}</p></div><button v-if="['pending', 'running'].includes(run.status)" type="button" @click="cancelPlanRun(run)">停止</button></article></div></div></template><div v-else class="automation-state">正在准备计划详情…</div>
      </section>
    </section>
  </main>
  <main v-else-if="activePage === 'users' && isPlatformAdmin" class="admin-page">
    <header class="admin-topbar"><button class="admin-brand" type="button" @click="activePage = 'workspace'"><img :src="logoUrl" alt="" /><span>rmdex</span></button><div class="admin-top-actions"><button class="admin-nav-button" type="button" @click="activePage = 'workspace'"><ArrowLeft :size="16" />工作区</button><button class="admin-icon-button" type="button" title="设置" aria-label="设置" @click="activePage = 'settings'"><Settings :size="17" /></button></div></header>
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
  <div v-else class="shell" :class="{ 'native-app': Capacitor.isNativePlatform(), 'is-resizing-sidebar': resizingSidebar }" :style="{ '--sidebar-width': `${sidebarWidth}px` }">
    <aside id="thread-panel" class="thread-panel" :class="{ collapsed: !sidebarOpen, hiddenMobile: mobileDetail }">
      <div class="thread-panel-scroll">
      <div class="brand-row">
        <div class="brand"><img :src="logoUrl" alt="" /><span>rmdex</span></div>
        <button class="icon-button collapse-button" title="收起侧栏" aria-label="收起侧栏" aria-controls="thread-panel" :aria-expanded="sidebarOpen" @click="sidebarOpen = false"><PanelLeftClose :size="19" /></button>
      </div>
      <button class="new-thread" :disabled="!capabilities.create" @click="openCreate()"><Plus :size="17" /><span>新建对话</span></button>
      <div class="device"><span class="device-icon"><Monitor :size="16" /></span><div class="device-copy"><strong>{{ remoteDevice?.name || (remoteMode ? '未连接 Codex 设备' : '本机设备') }}</strong><small>{{ connected ? '已连接' : (remoteMode ? '等待远程设备' : '未连接') }}</small></div><span class="online" :class="{ offline: !connected }"></span></div>
      <button class="pair-entry" type="button" @click="showDevices = true"><QrCode :size="16" /><span>连接设备</span><span class="pair-entry-hint">切换或管理</span></button>
      <label class="search"><Search :size="16" /><input v-model="query" placeholder="搜索会话" aria-label="搜索会话" /></label>
        <div v-if="remoteMode" class="employee-section">
          <div class="section-label sidebar-section-label" role="button" tabindex="0" :aria-expanded="!sidebarSectionIsCollapsed('employees')" @click="toggleSidebarSection('employees')" @keydown.enter.prevent="toggleSidebarSection('employees')" @keydown.space.prevent="toggleSidebarSection('employees')"><span>AI 员工 <span class="count">{{ employees.length }}</span></span><button class="icon-button" type="button" title="新建 AI 员工" aria-label="新建 AI 员工" @click.stop="openEmployeeEditor()"><Plus :size="15" /></button></div>
          <template v-if="!sidebarSectionIsCollapsed('employees')"><div v-for="employee in employees" :key="employee.id" class="employee-row" :class="{ selected: activeEmployeeId === employee.id, 'is-swipe-open': employeeSwipeOpenId === employee.id }" @touchstart.passive="handleEmployeeTouchStart(employee, $event)" @touchmove.passive="handleEmployeeTouchMove(employee, $event)" @touchend="handleEmployeeTouchEnd(employee)">
            <div class="employee-row-content" :style="{ transform: employeeSwipeOpenId === employee.id ? 'translateX(-102px)' : 'translateX(0)' }">
              <button class="employee-select" type="button" @click="openEmployee(employee)"><span class="employee-icon"><Bot :size="15" /></span><span class="employee-copy"><strong>{{ employee.name }}</strong><small>{{ employee.role || employee.projectPath }}</small></span></button>
            </div>
            <div class="employee-swipe-actions" aria-label="AI 员工快捷操作"><button type="button" title="编辑员工" aria-label="编辑员工" @click.stop="openEmployeeEditor(employee)"><Pencil :size="15" /></button><button type="button" title="换绑 Thread" aria-label="换绑 Thread" :disabled="employeeResetting === employee.id" @click.stop="requestEmployeeThreadReset(employee)"><RotateCcw :size="15" :class="{ spin: employeeResetting === employee.id }" /></button></div>
          </div></template>
          <p v-if="!employees.length && !sidebarSectionIsCollapsed('employees')" class="employee-empty">创建一个有固定身份和长期记忆的 Codex 员工。</p>
        </div>
        <div v-if="remoteMode && clientToken" class="employee-section plan-section">
          <div class="section-label sidebar-section-label" role="button" tabindex="0" :aria-expanded="!sidebarSectionIsCollapsed('plans')" @click="toggleSidebarSection('plans')" @keydown.enter.prevent="toggleSidebarSection('plans')" @keydown.space.prevent="toggleSidebarSection('plans')"><span>计划任务 <span class="count">{{ plans.length }}</span></span><button class="icon-button" type="button" title="新建计划" aria-label="新建计划" @click.stop="openPlanEditorFromSidebar()"><Plus :size="15" /></button></div>
          <template v-if="!sidebarSectionIsCollapsed('plans')"><button v-for="plan in plans" :key="plan.id" class="plan-sidebar-row" type="button" :class="{ selected: selectedPlanId === plan.id }" @click="openPlan(plan)"><span class="employee-icon plan-icon"><CalendarClock :size="15" /></span><span class="employee-copy"><strong>{{ plan.name }}</strong><small>{{ plan.employee?.name || '独立计划' }} · {{ formatPlanSidebarMeta(plan) }}</small></span><ChevronRight :size="14" class="plan-sidebar-chevron" /></button>
          <p v-if="!plans.length && !plansLoading" class="employee-empty">当前设备还没有计划。</p></template>
        </div>
        <div class="section-label sidebar-section-label" role="button" tabindex="0" :aria-expanded="!sidebarSectionIsCollapsed('sessions')" @click="toggleSidebarSection('sessions')" @keydown.enter.prevent="toggleSidebarSection('sessions')" @keydown.space.prevent="toggleSidebarSection('sessions')"><span>会话与 Projects <span class="count">{{ filtered.length }}</span></span><div class="section-actions"><button class="archive-toggle" type="button" :class="{ active: showArchivedThreads }" :title="showArchivedThreads ? '隐藏已归档' : '显示已归档'" @click.stop="showArchivedThreads = !showArchivedThreads"><Archive :size="14" /><span v-if="archivedThreads.length">{{ archivedThreads.length }}</span></button><button class="icon-button" title="新建 Project" aria-label="新建 Project" @click.stop="openProjectEditor()"><FolderPlus :size="15" /></button><button class="icon-button" title="刷新会话" aria-label="刷新会话" :disabled="loading" @click.stop="retryConnection"><RefreshCw :size="15" /></button></div></div>
      <div v-if="threadActionError" class="sidebar-error">{{ threadActionError }}</div>
      <div v-if="!sidebarSectionIsCollapsed('sessions')" class="thread-list">
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
      <footer class="side-footer"><span class="online" :class="{ offline: !connected }"></span> {{ remoteMode ? '远程设备' : '本机模式' }} <span class="footer-label">{{ connected ? '已连接' : '未连接' }}</span><span class="side-account-actions"><button v-if="isPlatformAdmin" type="button" @click="activePage = 'users'" title="用户管理"><Users :size="15" /><span>用户</span></button><button v-if="adminToken || clientToken" type="button" @click="activePage = 'settings'" title="设置"><Settings :size="15" /><span>设置</span></button></span></footer>
    </aside>
    <SidebarResize v-if="sidebarOpen" v-model="sidebarWidth" @change="saveSidebarWidth" @resizing="resizingSidebar = $event" />
    <main class="main" :class="{ hiddenMobile: !mobileDetail }">
       <header class="main-head"><button class="icon-button back" title="返回会话" aria-label="返回会话" @click="mobileDetail = false"><ArrowLeft :size="19" /></button><button v-if="!sidebarOpen" class="icon-button expand-button" title="展开侧栏" aria-label="展开侧栏" aria-controls="thread-panel" :aria-expanded="sidebarOpen" @click="sidebarOpen = true"><Menu :size="19" /></button><div class="heading"><strong>{{ selected?.name || selected?.preview || '会话' }}</strong><span v-if="selected">本机设备</span></div></header>
      <div v-if="connectionState === 'connected'" class="connection-indicator" role="status" title="已连接"><span class="online"></span></div><div v-else class="connection-banner" :class="connectionState" role="status" aria-live="polite"><span class="online offline"></span><strong>{{ connectionState === 'reconnecting' ? '正在重连' : '已断开' }}</strong><span v-if="connectionState === 'reconnecting'">将自动重试</span><span v-else>部分操作暂不可用</span><button type="button" @click="retryConnection"><RotateCcw :size="14" />立即重试</button><details v-if="connectionErrorDetail"><summary>错误详情</summary><p>{{ connectionErrorDetail }}</p></details></div>
      <div v-if="error" class="error"><CircleAlert :size="18" /><span>{{ error }}</span><button @click="retryConnection">重试</button></div>
      <div v-if="!selected" class="welcome"><div class="welcome-icon"><MessageSquare :size="22" /></div><h2>选择一个会话</h2><p>查看你的 Codex 对话</p></div>
      <div v-else-if="threadLoading" class="conversation conversation-skeleton" role="status" aria-live="polite"><div class="conversation-inner"><span class="skeleton-line skeleton-line-heading"></span><span class="skeleton-line skeleton-line-wide"></span><span class="skeleton-line skeleton-line-medium"></span><span class="skeleton-line skeleton-line-wide"></span><span class="skeleton-line skeleton-line-short"></span></div></div>
      <div v-else-if="threadLoadError" class="thread-load-state" role="alert"><CircleAlert :size="20" /><span>加载会话失败：{{ threadLoadError }}</span><button type="button" @click="openThread(selected)">重试</button></div>
      <div v-else ref="conversation" class="conversation"><div class="conversation-inner">
        <button v-if="historyCursor" class="history-button" :disabled="historyLoading" @click="loadOlder"><LoaderCircle v-if="historyLoading" :size="14" class="working-spinner" />{{ historyLoading ? '正在加载…' : '加载更早的消息' }}</button>
        <div v-if="!messages.length && !pendingMessageVisible(selected) && !failedMessages[selected.id]?.length" class="empty-messages">{{ selected.desktopDraft ? '从下方发送消息，开始新对话。' : '此会话暂无可显示的消息。' }}</div>
        <template v-for="(message, i) in messages" :key="message.role === 'tools' ? `tools-${i}` : `${message.turnId}-${message.item.id || i}`">
          <details v-if="message.role === 'tools'" class="tool-group">
            <summary><Wrench :size="14" /><span>{{ toolSummary(message.items) }}</span><span v-if="message.items.some(item => item.status === 'failed' || item.status === 'declined' || item.success === false || (typeof item.exitCode === 'number' && item.exitCode !== 0))" class="group-failed">含失败</span><ChevronRight :size="14" class="group-chevron" /></summary>
            <div class="tool-group-content"><ToolEvent v-for="(item, index) in message.items" :key="item.id || index" :item="item" :image-url="toolImageSource(item)" @preview="showImagePreview" /></div>
          </details>
          <template v-else>
            <MessageBubble :role="message.role" :copy-text="message.copyText" :retryable="message.role === 'user' && !message.colleagueName && capabilities.retry" :retry-disabled="working || retrying" :retry-label="message.turnId === selected.turns?.at(-1)?.id ? '重试' : '从这里重试（新会话）'" :forkable="message.role === 'agent' && message.forkable && capabilities.fork" @copy="copyValue($event, '已复制消息')" @retry="retryMessage(message)" @fork="forkMessage(message)">
              <div v-if="message.colleagueName" class="colleague-message-source">来自员工 · {{ message.colleagueName }}</div>
              <PlanExecutionCard v-if="message.planExecution" :execution="message.planExecution" :prompt="message.text" />
              <div v-if="message.images.length" class="attachments"><template v-for="(image, index) in message.images" :key="index"><button v-if="imageSource(image)" type="button" class="attachment" title="放大预览图片" aria-label="放大预览图片" @click="showImagePreview(imageSource(image) || '')"><img :src="imageSource(image)" alt="图片附件" loading="lazy" /></button><span v-else class="attachment-unavailable">图片附件不可用</span></template></div>
              <div v-if="message.text && !message.planExecution" class="message-text markdown" v-html="markdown.render(message.text)"></div>
            </MessageBubble>
            <ArtifactStrip v-if="message.role === 'agent' && message.forkable && message.artifacts?.length" :artifacts="message.artifacts" :loading="artifactLoading" :download-state="artifactDownloadState" :downloaded="downloadedArtifacts" :can-open-location="Capacitor.isNativePlatform() || pcArtifactApp" :open-location-label="Capacitor.isNativePlatform() ? '打开下载目录' : '在资源管理器中打开'" :image-urls="artifactImageUrls" @download="requestArtifactDownload" @preview="previewArtifact" @load-thumbnail="loadArtifactThumbnail" @open-location="openArtifactLocation" />
          </template>
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
        <section v-if="queuedSubmissions.length" class="queued-followups" aria-label="排队任务"><div class="queued-followups-heading"><span>排队中</span><span class="queued-count">{{ queuedSubmissions.length }}</span></div><div v-for="item in queuedSubmissions" :key="item.id" class="queued-followup"><CornerDownRight :size="15" class="queued-followup-icon" /><span class="queued-followup-text">{{ queuedText(item) }}</span><div class="queued-followup-actions"><button v-if="!isColleagueQueued(item)" type="button" class="queue-steer-button" :disabled="!!queueActionId || !activeTurnId" @click="steerQueued(item)"><CornerDownRight :size="14" />Steer</button><button type="button" class="queue-icon-button" title="删除排队任务" aria-label="删除排队任务" :disabled="!!queueActionId" @click="deleteQueued(item)"><Trash2 :size="15" /></button><button v-if="!isColleagueQueued(item)" type="button" class="queue-icon-button" title="更多操作" aria-label="更多操作" :disabled="!!queueActionId" @click="queueMenuId = queueMenuId === item.id ? null : item.id"><Ellipsis :size="16" /></button></div><div v-if="queueMenuId === item.id && !isColleagueQueued(item)" class="queued-followup-menu"><button type="button" :disabled="!!queueActionId" @click="editQueued(item)"><Pencil :size="14" />编辑消息</button></div></div></section>
        <p v-if="desktopMode" class="desktop-hint">{{ capabilities.models ? '模型与推理强度可在右侧选择；权限、审批和暂停请在 Desktop 处理。' : '当前设备未提供可识别的模型目录；模型、权限、审批和暂停请在 Desktop 处理。' }}</p><div v-for="approval in (capabilities.approvals ? pendingApprovals : [])" :key="approval.id" class="approval"><strong>{{ approval.method.includes('commandExecution') ? '命令执行需要确认' : '文件修改需要确认' }}</strong><p v-if="approval.params.reason">{{ approval.params.reason }}</p><pre v-if="approval.params.command">{{ approval.params.command }}</pre><p v-if="approval.params.cwd">工作目录：{{ approval.params.cwd }}</p><p v-if="approval.params.grantRoot">授权目录：{{ approval.params.grantRoot }}</p><details><summary>完整请求信息</summary><pre>{{ JSON.stringify(approval.params, null, 2) }}</pre></details><p v-if="approval.method.includes('fileChange')">请先在上方工具调用中查看文件变更，再决定是否允许。</p><div class="approval-actions"><button @click="decide(approval, 'decline')">拒绝</button><button @click="decide(approval, 'accept')">允许本次</button></div></div>
        <section v-for="request in pendingUserInputs" :key="request.id" class="user-input-request" aria-live="polite">
          <div class="user-input-toolbar"><div class="user-input-title"><CircleHelp :size="15" /><span>Question</span></div><div class="user-input-pagination"><button type="button" title="上一题" aria-label="上一题" :disabled="currentUserInputQuestion(request).index === 0 || answeringUserInput === request.id" @click="userInputIndexes[request.id] = Math.max(0, currentUserInputQuestion(request).index - 1)"><ChevronLeft :size="15" /></button><span>{{ currentUserInputQuestion(request).index + 1 }} of {{ request.params.questions.length }}</span><button type="button" title="下一题" aria-label="下一题" :disabled="currentUserInputQuestion(request).index >= request.params.questions.length - 1 || answeringUserInput === request.id" @click="userInputIndexes[request.id] = Math.min(request.params.questions.length - 1, currentUserInputQuestion(request).index + 1)"><ChevronRight :size="15" /></button><button type="button" class="user-input-close" title="跳过全部问题" aria-label="跳过全部问题" :disabled="answeringUserInput === request.id" @click="request.params.questions.forEach(question => userInputSkipped[request.id] = { ...(userInputSkipped[request.id] || {}), [question.id]: true }); answerUserInput(request)"><X :size="15" /></button></div></div>
          <template v-if="currentUserInputQuestion(request).question">
            <div class="user-input-question">
              <div class="user-input-prompt">{{ currentUserInputQuestion(request).question.question }}</div>
              <div v-if="currentUserInputQuestion(request).question.options?.length" class="user-input-options">
                <button v-for="(option, index) in currentUserInputQuestion(request).question.options || []" :key="option.label" type="button" :class="{ selected: chosenUserInput(request.id, currentUserInputQuestion(request).question.id) === option.label }" @click="chooseUserInput(request.id, currentUserInputQuestion(request).question.id, option.label)"><span class="user-input-option-index">{{ index + 1 }}</span><span class="user-input-option-copy"><strong>{{ option.label }}</strong><small v-if="option.description">{{ option.description }}</small></span></button>
              </div>
              <label class="user-input-custom"><Pencil :size="14" /><input v-model="userInputOther[`${request.id}:${currentUserInputQuestion(request).question.id}`]" :placeholder="currentUserInputQuestion(request).question.isSecret ? 'Write your own response' : 'Or write your own response'" :type="currentUserInputQuestion(request).question.isSecret ? 'password' : 'text'" @focus="chooseUserInput(request.id, currentUserInputQuestion(request).question.id, '__other__')" @input="chooseUserInput(request.id, currentUserInputQuestion(request).question.id, '__other__')" /></label>
            </div>
            <div class="user-input-actions"><button type="button" class="user-input-skip" :disabled="answeringUserInput === request.id" @click="advanceUserInput(request, true)">Skip</button><button type="button" class="user-input-next" :disabled="answeringUserInput === request.id || !userInputHasAnswer(request.id, currentUserInputQuestion(request).question)" @click="advanceUserInput(request)">{{ answeringUserInput === request.id ? 'Submitting…' : currentUserInputQuestion(request).index === request.params.questions.length - 1 ? 'Submit' : 'Next' }}</button></div>
          </template>
        </section>
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
    <div v-if="employeeResetTarget" class="modal-backdrop" @click.self="closeEmployeeThreadResetConfirm"><section class="create-dialog delete-dialog employee-reset-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-reset-title" @keydown.esc="closeEmployeeThreadResetConfirm"><header><div><h2 id="employee-reset-title">换绑员工 Thread</h2><p>为“{{ employeeResetTarget.name }}”创建新的执行会话。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="!!employeeResetting" @click="closeEmployeeThreadResetConfirm"><X :size="18" /></button></header><p class="delete-copy">当前 Thread 将被归档并创建新的 Thread。员工的长期记忆、SOP 和本地资产会保留，正在执行或排队的任务需要先结束。</p><p v-if="employeeResetError" class="create-error" role="alert">{{ employeeResetError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="!!employeeResetting" @click="closeEmployeeThreadResetConfirm">取消</button><button type="button" class="danger-confirm-button" :disabled="!!employeeResetting" @click="confirmEmployeeThreadReset">{{ employeeResetting ? '换绑中…' : '确认换绑' }}</button></div></section></div>
    <div v-if="copyFeedback" class="copy-toast" role="status" aria-live="polite">{{ copyFeedback }}</div>
    <div v-if="previewImageUrl" class="image-preview-backdrop" @click.self="closeImagePreview"><section class="image-preview-dialog" role="dialog" aria-modal="true" aria-label="图片预览"><button class="icon-button image-preview-close" type="button" title="关闭图片预览" aria-label="关闭图片预览" @click="closeImagePreview"><X :size="18" /></button><img :src="previewImageUrl" alt="图片大图预览" /></section></div>
    <div v-if="artifactPreview" class="artifact-preview-backdrop" @click.self="clearArtifactPreview"><section class="artifact-preview-dialog" role="dialog" aria-modal="true" :aria-label="`预览 ${artifactPreview.name}`"><header><div><strong>{{ artifactPreview.name }}</strong><small>{{ artifactPreview.name.split('.').pop()?.toUpperCase() || 'FILE' }} · {{ formatArtifactSize(artifactPreview.size) }}</small></div><button type="button" class="icon-button" title="关闭预览" aria-label="关闭预览" @click="clearArtifactPreview"><X :size="18" /></button></header><img v-if="artifactPreview.mimeType.startsWith('image/') && artifactPreviewUrl" :src="artifactPreviewUrl" :alt="artifactPreview.name" /><iframe v-else-if="artifactPreview.mimeType === 'application/pdf' && artifactPreviewUrl" :src="artifactPreviewUrl" title="PDF 预览"></iframe><pre v-else-if="artifactPreviewText">{{ artifactPreviewText }}</pre><div v-else-if="artifactPreviewError" class="artifact-preview-error">预览失败：{{ artifactPreviewError }}<button type="button" @click="requestArtifactDownload(artifactPreview!)">下载文件</button></div><div v-else class="artifact-preview-loading">{{ artifactLoading === artifactPreview.id ? '正在准备预览…' : '暂无可用预览' }}</div></section></div>
    <div v-if="artifactDownloadConfirm" class="modal-backdrop" @click.self="cancelArtifactDownload"><section class="create-dialog artifact-download-confirm" role="dialog" aria-modal="true" aria-labelledby="artifact-download-title" @keydown.esc="cancelArtifactDownload"><header><div><h2 id="artifact-download-title">确认下载</h2><p>文件将从当前绑定设备读取。</p></div><button class="icon-button" type="button" title="取消下载" aria-label="取消下载" @click="cancelArtifactDownload"><X :size="18" /></button></header><div class="artifact-download-summary"><strong>{{ artifactDownloadConfirm.name }}</strong><small>{{ artifactDownloadConfirm.name.split('.').pop()?.toUpperCase() || 'FILE' }} · {{ formatArtifactSize(artifactDownloadConfirm.size) }}</small></div><p class="delete-copy">确定下载这个文件吗？</p><div class="dialog-actions"><button type="button" class="cancel-button" @click="cancelArtifactDownload">取消</button><button type="button" class="create-button" @click="confirmArtifactDownload">确认下载</button></div></section></div>
    <div v-if="showFullAccessConfirm" class="modal-backdrop" @click.self="showFullAccessConfirm = false"><section class="create-dialog risk-dialog" role="dialog" aria-modal="true" aria-labelledby="full-access-title" @keydown.esc="showFullAccessConfirm = false"><header><div class="risk-heading"><span class="risk-icon"><ShieldAlert :size="19" /></span><div><h2 id="full-access-title">确认使用完全访问</h2><p>这次消息将跳过 Codex 审批。</p></div></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showFullAccessConfirm = false"><X :size="18" /></button></header><div class="risk-copy"><p>完全访问模式允许 Codex 直接执行命令、修改工作目录中的文件，并访问电脑上的网络资源。</p><p>只在你明确知道这条消息会做什么时继续。你也可以取消后切换为“请求审批”。</p></div><label class="risk-checkbox"><input v-model="skipFullAccessConfirm" type="checkbox" /> <span>不再提醒</span></label><div class="dialog-actions"><button type="button" class="cancel-button" @click="showFullAccessConfirm = false">取消</button><button type="button" class="danger-confirm-button" @click="confirmFullAccess">继续发送</button></div></section></div>
     <div v-if="showCreate" class="modal-backdrop" @click.self="!creating && (showCreate = false)"><section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title" @keydown.esc="!creating && (showCreate = false)"><header><h2 id="create-title">新建对话</h2><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="creating" @click="showCreate = false"><X :size="18" /></button></header><form @submit.prevent="createThread"><label for="new-thread-project">Project</label><ProjectMenu v-model="createProject" :projects="projects" :desktop-mode="desktopMode" :disabled="creating" @update:model-value="syncCreateProjectPath" /><template v-if="!desktopMode && !createProject"><label for="working-directory">工作目录</label><input id="working-directory" v-model="createPath" required autocomplete="off" placeholder="例如 D:\WorkSpace\rmdex" /></template><p v-else-if="createProject" class="project-path-hint">{{ projects.find(project => project.id === createProject)?.path }}</p><p v-if="createError" class="create-error" role="alert">{{ createError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="creating" @click="showCreate = false">取消</button><button type="submit" class="create-button" :disabled="creating || (!desktopMode && !createProject && !createPath.trim())">{{ creating ? '创建中…' : '创建对话' }}</button></div></form></section></div>
     <div v-if="employeeEditor" class="modal-backdrop" @click.self="!employeeSaving && (employeeEditor = false)"><section class="create-dialog employee-dialog" role="dialog" aria-modal="true" aria-labelledby="employee-title" @keydown.esc="!employeeSaving && (employeeEditor = false)"><header><div><h2 id="employee-title">{{ editingEmployeeId ? '编辑 AI 员工' : '新建 AI 员工' }}</h2><p>员工会使用绑定电脑上的 Codex Thread 工作。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="employeeSaving" @click="employeeEditor = false"><X :size="18" /></button></header><form @submit.prevent="saveEmployee"><label for="employee-name">名称</label><input id="employee-name" v-model="employeeName" maxlength="80" required placeholder="例如：回归测试员" /><label for="employee-role">职位</label><input id="employee-role" v-model="employeeRole" maxlength="120" placeholder="例如：负责运行测试并分析失败" /><label for="employee-project-path">Project 路径</label><input id="employee-project-path" v-model="employeeProjectPath" maxlength="1000" required placeholder="例如：D:\WorkSpace\rmdex" /><label for="employee-instructions">员工职责与沟通方式</label><textarea id="employee-instructions" v-model="employeeInstructions" rows="5" maxlength="12000" placeholder="描述它应该如何工作、如何汇报结果。"></textarea><p v-if="employeeError" class="create-error" role="alert">{{ employeeError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="employeeSaving" @click="employeeEditor = false">取消</button><button type="submit" class="create-button" :disabled="employeeSaving || !employeeName.trim() || !employeeProjectPath.trim()">{{ employeeSaving ? '保存中…' : '保存员工' }}</button></div></form></section></div>
     <div v-if="projectEditor" class="modal-backdrop" @click.self="!projectSaving && (projectEditor = false)"><section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="project-title" @keydown.esc="!projectSaving && (projectEditor = false)"><header><h2 id="project-title">{{ editingProjectId ? '编辑 Project' : '新建 Project' }}</h2><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="projectSaving" @click="projectEditor = false"><X :size="18" /></button></header><form @submit.prevent="saveProject"><label for="project-name">名称</label><input id="project-name" v-model="projectName" maxlength="80" required autocomplete="off" placeholder="例如 rmdex" /><label for="project-path">文件夹路径</label><input id="project-path" v-model="projectPath" required autocomplete="off" placeholder="例如 D:\WorkSpace\rmdex" /><p class="dialog-hint">路径必须是这台 Codex 电脑上已存在的文件夹。Desktop 已创建的 Projects 会自动出现在列表中。</p><p v-if="projectError" class="create-error" role="alert">{{ projectError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="projectSaving" @click="projectEditor = false">取消</button><button type="submit" class="create-button" :disabled="projectSaving || !projectName.trim() || !projectPath.trim()">{{ projectSaving ? '保存中…' : '保存 Project' }}</button></div></form></section></div>
     <div v-if="deleteProjectTarget" class="modal-backdrop" @click.self="deleteProjectTarget = null"><section class="create-dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-project-title"><header><div><h2 id="delete-project-title">删除 Project</h2><p>只会移除 rmdex 中的 Project 记录，不会删除文件夹或会话。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="deleteProjectTarget = null"><X :size="18" /></button></header><p class="delete-copy">确定移除“{{ deleteProjectTarget.name }}”吗？</p><div class="dialog-actions"><button type="button" class="cancel-button" @click="deleteProjectTarget = null">取消</button><button type="button" class="danger-confirm-button" @click="deleteProject">确认移除</button></div></section></div>
    <div v-if="renameThread" class="modal-backdrop" @click.self="!renaming && (renameThread = null)"><section class="create-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title" @keydown.esc="!renaming && (renameThread = null)"><header><div><h2 id="rename-title">重命名会话</h2><p>名称只影响 rmdex 显示，不会修改消息内容。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="renaming" @click="renameThread = null"><X :size="18" /></button></header><form @submit.prevent="submitRename"><label for="thread-name">会话名称</label><input id="thread-name" v-model="renameValue" maxlength="80" autocomplete="off" /><p v-if="renameError" class="create-error" role="alert">{{ renameError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="renaming" @click="renameThread = null">取消</button><button type="submit" class="create-button" :disabled="renaming || !renameValue.trim()">{{ renaming ? '保存中…' : '保存名称' }}</button></div></form></section></div>
    <div v-if="deleteThreadTarget" class="modal-backdrop" @click.self="!threadActionId && (deleteThreadTarget = null)"><section class="create-dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title" @keydown.esc="!threadActionId && (deleteThreadTarget = null)"><header><div><h2 id="delete-title">删除会话</h2><p>删除后无法从 rmdex 恢复这条会话。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" :disabled="!!threadActionId" @click="deleteThreadTarget = null"><X :size="18" /></button></header><p class="delete-copy">确定删除“{{ deleteThreadTarget.name || deleteThreadTarget.preview || '未命名会话' }}”吗？这会同时从 Codex 中删除会话记录。</p><div class="dialog-actions"><button type="button" class="cancel-button" :disabled="!!threadActionId" @click="deleteThreadTarget = null">取消</button><button type="button" class="danger-confirm-button" :disabled="!!threadActionId" @click="confirmDeleteThread">{{ threadActionId ? '删除中…' : '确认删除' }}</button></div></section></div>
    <div v-if="pairApprovalPage" class="pair-status-backdrop"><section class="pair-status-page" role="dialog" aria-modal="true" aria-labelledby="pair-status-title"><button class="icon-button pair-status-close" type="button" title="返回设备连接" aria-label="返回设备连接" @click="returnToPairingEntry"><X :size="18" /></button><div class="pair-status-icon" :class="`is-${pairApprovalState}`"><LoaderCircle v-if="pairApprovalState === 'waiting'" :size="28" class="working-spinner" /><CircleAlert v-else :size="28" /></div><h2 id="pair-status-title">{{ pairApprovalState === 'waiting' ? '等待电脑端确认' : pairApprovalState === 'denied' ? '配对请求未通过' : pairApprovalState === 'expired' ? '配对请求已过期' : '配对暂时没有完成' }}</h2><p class="pair-status-copy">{{ pairApprovalState === 'waiting' ? '配对申请已经发送到电脑端，请在 Codex Desktop 中允许这台手机连接。' : pairError }}</p><div v-if="pairApprovalState === 'waiting'" class="pair-status-waiting"><span class="online"></span><span>正在等待电脑端审批</span></div><div v-else class="pair-status-actions"><button class="create-button" type="button" :disabled="scanningPair" @click="scanPairCode"><QrCode :size="16" />重新扫描二维码</button><button class="cancel-button" type="button" @click="returnToPairingEntry">手动输入配对码</button></div><form v-if="pairApprovalState !== 'waiting'" class="pair-status-manual" @submit.prevent="claimPair()"><label for="pair-status-code">输入 32 位配对码</label><div><input id="pair-status-code" v-model="pairInput" maxlength="32" inputmode="text" autocomplete="off" placeholder="输入配对码" /><button class="create-button" type="submit" :disabled="pairInput.length !== 32 || mobilePairing">继续</button></div></form></section></div>
    <div v-if="showDevices" class="modal-backdrop" @click.self="showDevices = false"><section class="create-dialog device-dialog" role="dialog" aria-modal="true" aria-labelledby="devices-title" @keydown.esc="showDevices = false"><header><div><h2 id="devices-title">连接设备</h2><p>切换正在使用的 Codex 电脑，或管理电脑与手机配对。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showDevices = false"><X :size="18" /></button></header>
      <template v-if="adminToken"><div class="admin-status"><span class="online"></span><span>{{ isPlatformAdmin ? '平台管理员已验证' : '用户已验证' }}</span></div>
        <div class="device-dialog-toolbar"><div><strong>我的 Codex 电脑</strong><small>{{ devices.length ? `${devices.length} 台已注册设备` : '还没有注册设备' }}</small></div><button class="create-button" type="button" @click="openRegisterDeviceDialog"><Plus :size="15" />添加电脑</button></div>
        <div v-if="pairRequests.length" class="pair-requests"><strong>待处理的手机配对</strong><div v-for="request in pairRequests" :key="request.id" class="pair-request"><span>{{ request.name }}</span><button type="button" @click="decidePair(request.id, 'deny')">拒绝</button><button type="button" class="approve-pair" @click="decidePair(request.id, 'approve')">允许</button></div></div>
        <div class="device-list">
          <article v-for="device in devices" :key="device.id" class="device-row" :class="{ 'is-current': remoteDevice?.id === device.id, 'is-switchable': device.online && remoteDevice?.id !== device.id }" @click="requestDeviceSwitch(device)">
            <span class="device-icon"><Monitor :size="17" /></span>
            <div class="device-copy"><strong>{{ device.name }}</strong><small>{{ device.online ? '可连接到这台电脑' : '当前离线，暂时无法连接' }}</small></div>
            <span class="device-status" :class="device.online ? 'is-online' : 'is-offline'">{{ remoteDevice?.id === device.id ? '当前设备' : device.online ? '在线' : '离线' }}</span>
            <div class="device-row-actions">
              <button class="device-connect-button" type="button" :disabled="!device.online || !!connectingDeviceId || remoteDevice?.id === device.id" @click.stop="connectDevice(device.id)"><LoaderCircle v-if="connectingDeviceId === device.id" :size="14" class="working-spinner" /><MessageSquare v-else :size="14" />{{ remoteDevice?.id === device.id ? '当前使用' : connectingDeviceId === device.id ? '正在连接' : device.online ? '连接' : '离线' }}</button>
              <button class="device-action-button" type="button" title="生成手机配对码" :disabled="!!connectingDeviceId || !!revokingDeviceId" @click.stop="openPairDialog(device.id)"><Smartphone :size="14" /><span>手机配对</span></button>
              <button class="device-action-button revoke-button" type="button" title="撤销设备" :disabled="!!connectingDeviceId || !!revokingDeviceId" @click.stop="revokeDevice(device.id)"><LoaderCircle v-if="revokingDeviceId === device.id" :size="14" class="working-spinner" /><Trash2 v-else :size="14" /><span>{{ revokingDeviceId === device.id ? '撤销中' : '撤销' }}</span></button>
            </div>
          </article>
          <p v-if="!devices.length" class="device-empty"><Monitor :size="18" /><strong>还没有连接电脑</strong><span>在新电脑上登录 rmdex PC，或添加手动配置的 agent。</span></p>
        </div>
      </template>
      <template v-else-if="pairLanding"><div class="mobile-pair-intro"><Smartphone :size="22" /><div><strong>申请连接 Codex 电脑</strong><p>配对申请会发送到电脑端，等待管理员允许后即可使用。</p></div></div><button class="create-button scan-pair-button" type="button" :disabled="scanningPair || mobilePairing" @click="scanPairCode"><QrCode :size="16" />{{ scanningPair ? '正在打开扫码…' : '扫描电脑二维码' }}</button><form class="claim-pair" @submit.prevent="claimPair()"><label for="pair-code">二维码无法识别时，输入配对码</label><div><input id="pair-code" v-model="pairInput" maxlength="32" placeholder="输入配对码" /><button class="create-button" type="submit" :disabled="pairInput.length !== 32 || mobilePairing">配对</button></div></form><p v-if="mobilePairing && !pairError" class="pair-waiting" role="status"><LoaderCircle :size="15" class="working-spinner" />配对申请已发送，请在电脑端允许此手机连接。</p></template>
      <div v-else-if="clientToken" class="client-device-state"><span class="device-icon"><Monitor :size="18" /></span><div><strong>{{ remoteDevice?.name || '已连接的电脑' }}</strong><small>当前会话已通过设备凭据连接。登录账号后可切换或管理其他设备。</small></div></div>
      <p v-if="pairError" class="create-error" role="alert">{{ pairError }}</p>
    </section></div>
    <div v-if="showRegisterDevice" class="modal-backdrop device-submodal" @click.self="showRegisterDevice = false"><section class="create-dialog register-device-dialog" role="dialog" aria-modal="true" aria-labelledby="register-device-title" @keydown.esc="showRegisterDevice = false"><header><div><h2 id="register-device-title">添加 Codex 电脑</h2><p>{{ newDeviceToken ? '注册码已生成，请在新电脑上完成连接。' : registerDeviceMode === 'guide' ? '推荐使用 rmdex-pc 登录账号自动注册。' : '仅在手动配置 agent 时生成注册码。' }}</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showRegisterDevice = false"><X :size="18" /></button></header><template v-if="!newDeviceToken && registerDeviceMode === 'guide'"><div class="device-guide device-guide-primary"><strong>推荐方式：在新电脑上登录</strong><ol><li>在新电脑安装并打开 rmdex-pc。</li><li>输入要绑定的用户账号、密码和电脑名称。</li><li>点击“连接账号并启动”，设备会自动注册并上线。</li></ol><p>注册完成后，这台电脑会自动出现在当前设备列表中，不需要先在这里创建空设备。</p></div><div class="dialog-actions"><button type="button" class="cancel-button" @click="showRegisterDevice = false">关闭</button><button type="button" class="create-button" @click="registerDeviceMode = 'manual'"><Wrench :size="15" />手动配置注册码</button></div></template><template v-else-if="!newDeviceToken"><label class="user-select-label">设备所属用户</label><UserMenu v-model="selectedUserId" :users="users" :disabled="!isPlatformAdmin || users.length < 2" @update:model-value="selectUser" /><label for="new-device-name">电脑名称</label><input id="new-device-name" v-model="deviceName" maxlength="80" autocomplete="off" placeholder="例如：办公室电脑" /><div class="device-guide"><strong>手动配置适用于已有 agent 的电脑</strong><p>生成后复制注册码，并将它配置到电脑端的 <code>RMDEX_DEVICE_TOKEN</code>。普通的新电脑请返回上一步，直接使用 rmdex-pc 登录。</p></div><p v-if="pairError" class="create-error" role="alert">{{ pairError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" @click="registerDeviceMode = 'guide'">返回</button><button type="button" class="create-button" :disabled="!selectedUserId || !deviceName.trim()" @click="registerDevice"><Plus :size="15" />生成注册码</button></div></template><div v-else class="device-secret"><strong>注册码已生成</strong><p>将它配置到手动 agent 后，设备会出现在设备列表。普通新电脑不需要使用注册码，直接在 rmdex-pc 登录即可。</p><code>{{ newDeviceToken }}</code><button class="copy-button" type="button" @click="copyValue(newDeviceToken, '已复制设备注册码')"><Copy :size="15" />复制注册码</button><small>手动配置：RMDEX_RELAY_URL=wss://code.kyeai.xyz/agent<br />RMDEX_DEVICE_TOKEN={{ newDeviceToken }}</small><div class="dialog-actions"><button type="button" class="create-button" @click="showRegisterDevice = false">完成</button></div></div></section></div>
    <div v-if="showPairDialog" class="modal-backdrop device-submodal" @click.self="showPairDialog = false"><section class="create-dialog pair-dialog" role="dialog" aria-modal="true" aria-labelledby="pair-dialog-title" @keydown.esc="showPairDialog = false"><header><div><h2 id="pair-dialog-title">手机扫码配对</h2><p>二维码和配对码 3 分钟内有效，只能使用一次。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="showPairDialog = false"><X :size="18" /></button></header><div v-if="pairQr" class="pair-result"><img :src="pairQr" alt="手机扫码配对二维码" /><div><strong>使用手机扫描二维码</strong><code>{{ pairCode }}</code><button class="copy-button" type="button" @click="copyValue(pairUrl, '已复制配对链接')"><Copy :size="15" />复制配对链接</button></div></div><div v-else class="pair-loading"><LoaderCircle :size="18" class="working-spinner" />正在生成配对码…</div><p v-if="pairError" class="create-error" role="alert">{{ pairError }}</p></section></div>
    <div v-if="deviceSwitchTarget" class="modal-backdrop device-submodal" @click.self="deviceSwitchTarget = null"><section class="create-dialog device-switch-dialog" role="dialog" aria-modal="true" aria-labelledby="device-switch-title" @keydown.esc="deviceSwitchTarget = null"><header><div><h2 id="device-switch-title">切换当前设备</h2><p>切换后会重新加载这台设备的会话、AI 员工、计划任务和执行记录。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="deviceSwitchTarget = null"><X :size="18" /></button></header><p class="device-switch-copy">确定切换到“{{ deviceSwitchTarget.name }}”吗？</p><div class="dialog-actions"><button type="button" class="cancel-button" @click="deviceSwitchTarget = null">取消</button><button type="button" class="create-button" :disabled="!!connectingDeviceId" @click="confirmDeviceSwitch">{{ connectingDeviceId ? '切换中…' : '确认切换' }}</button></div></section></div>
    <Teleport to="body"><div v-if="planEditor" class="modal-backdrop automation-backdrop" @click.self="!planSaving && (planEditor = false)"><section class="create-dialog automation-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-plan-create-title"><header><div><h2 id="workspace-plan-create-title">新建计划</h2><p>计划保存在当前设备，由 rmdex server 调度。</p></div><button class="icon-button" type="button" title="关闭" aria-label="关闭" @click="planEditor = false"><X :size="18" /></button></header><form @submit.prevent="savePlan"><label for="workspace-plan-name">名称</label><input id="workspace-plan-name" v-model="planName" required maxlength="120" placeholder="例如：每天检查项目状态" /><label for="workspace-plan-model">执行模型</label><select id="workspace-plan-model" v-model="planModel" required><option value="" disabled>正在加载模型…</option><option v-for="model in models" :key="model.id" :value="model.id">{{ model.displayName }}{{ model.isDefault ? '（默认）' : '' }}</option></select><label v-if="planEfforts.length" for="workspace-plan-effort">推理强度</label><select v-if="planEfforts.length" id="workspace-plan-effort" v-model="planEffort"><option v-for="effort in planEfforts" :key="effort.reasoningEffort" :value="effort.reasoningEffort">{{ effort.reasoningEffort || '默认' }}</option></select><label for="workspace-plan-employee">绑定员工（可选）</label><select id="workspace-plan-employee" v-model="planEmployeeId"><option value="">不绑定员工，创建独立执行线程</option><option v-for="employee in employees" :key="employee.id" :value="employee.id">{{ employee.name }}</option></select><label for="workspace-plan-prompt">任务内容</label><textarea id="workspace-plan-prompt" v-model="planPrompt" required rows="5" maxlength="20000" placeholder="描述员工或独立任务需要完成的工作"></textarea><label for="workspace-plan-cwd">工作目录</label><input id="workspace-plan-cwd" v-model="planCwd" required placeholder="例如：D:\WorkSpace\rmdex" /><label for="workspace-plan-trigger">触发方式</label><select id="workspace-plan-trigger" v-model="planTriggerType"><option value="interval">按间隔执行</option><option value="once">一次性执行</option></select><input v-if="planTriggerType === 'interval'" v-model="planIntervalMinutes" type="number" min="1" max="525600" required placeholder="间隔分钟数" /><input v-else v-model="planAt" type="datetime-local" required /><label for="workspace-plan-overlap">上次未完成时</label><select id="workspace-plan-overlap" v-model="planOverlap"><option value="skip">跳过本次</option><option value="queue">排队等待</option><option value="parallel">允许并行</option></select><p v-if="plansError" class="create-error" role="alert">{{ plansError }}</p><div class="dialog-actions"><button type="button" class="cancel-button" @click="planEditor = false">取消</button><button type="submit" class="create-button" :disabled="planSaving || !planName.trim() || !planPrompt.trim() || !planCwd.trim() || !planModel">{{ planSaving ? '创建中…' : '创建计划' }}</button></div></form></section></div></Teleport>
  </div>
</template>
