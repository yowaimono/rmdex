// Managed by rmdex: employee voice helper
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const voiceDir = join(root, 'voice')
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const description = '自然、清晰、温和的年轻中文女声，语速适中，像同事交谈，不带播音腔。'
function durationSeconds(audio) {
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV 音频无效')
  const byteRate = audio.readUInt32LE(28)
  return byteRate > 0 ? Math.max(1, Math.ceil(audio.readUInt32LE(40) / byteRate)) : 0
}

export async function synthesize(model, text, voice) {
  const key = process.env.MIMO_API_KEY?.trim()
  if (!key) throw new Error('未配置 MIMO_API_KEY，请先在员工设备配置小米 MiMo API Key')
  const response = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: description }, { role: 'assistant', content: text }], audio: { format: 'wav', ...(voice ? { voice } : {}) } }),
    redirect: 'error', signal: AbortSignal.timeout(120000),
  })
  if (!response.ok) throw new Error(`语音合成失败（HTTP ${response.status}）`)
  const data = await response.json()
  const encoded = data?.choices?.[0]?.message?.audio?.data
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('语音服务未返回有效音频')
  const audio = Buffer.from(encoded, 'base64')
  if (audio.length < 44 || audio.length > 10 * 1024 * 1024 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('语音服务返回的 WAV 音频无效')
  return audio
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  const option = name => args[args.indexOf(name) + 1]
  await mkdir(voiceDir, { recursive: true })
  if (command === 'design') {
    const path = join(voiceDir, 'sample.wav')
    const exists = await access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    if (exists) throw new Error('员工音色样本已存在，请先试听；不会覆盖原音色')
    const audio = await synthesize('mimo-v2.5-tts-voicedesign', '你好，我是你的工作伙伴。有事情随时告诉我，我们一起处理。')
    await writeFile(path, audio, { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ sample: path }))
    return
  }
  if (command !== 'send' || !args.includes('--file') || !args.includes('--id')) throw new Error('Usage: voice.mjs design | send --file UTF8_FILE --id UUID')
  const id = option('--id')
  if (!uuidPattern.test(id)) throw new Error('消息 ID 必须是 UUID')
  const text = (await readFile(option('--file'), 'utf8')).trim()
  if (!text || text.length > 2000) throw new Error('语音内容须为 1 至 2000 字符')
  const fingerprint = createHash('sha256').update(text).digest('hex')
  const config = JSON.parse(await readFile(join(root, 'communication.json'), 'utf8'))
  const origin = new URL(config.origin)
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('员工身份服务地址无效')
  const response = await fetch(new URL('/api/employee-communication/voice-context', origin), { headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('无法确认员工当前会话，请刷新员工会话后重试')
  const context = await response.json()
  if (![context.userId, context.employeeId, context.threadId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) throw new Error('员工会话信息无效')
  const metadataPath = join(voiceDir, `${id}.json`), audioPath = join(voiceDir, `${id}.wav`)
  const marker = seconds => `<rmdex_voice employee="${context.employeeId}" id="${id}" seconds="${seconds}" />`
  const lockPath = join(voiceDir, `${id}.lock`)
  const lock = await open(lockPath, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw new Error('此语音正在生成或上次执行中断，请先检查原消息'); throw error })
  try {
    const previous = await readFile(metadataPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (previous && (previous.fingerprint !== fingerprint || previous.threadId !== context.threadId)) throw new Error('同一消息 ID 不能用于不同内容或会话')
    if (!previous) await writeFile(metadataPath, JSON.stringify({ threadId: context.threadId, fingerprint }), { flag: 'wx', mode: 0o600 })
    const existing = await readFile(audioPath).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    let seconds = Number(previous?.seconds) || (existing ? durationSeconds(existing) : 0)
    if (!existing) {
      const sample = await readFile(join(voiceDir, 'sample.wav')).catch(error => { if (error.code === 'ENOENT') throw new Error('请先运行 voice.mjs design 创建并试听员工音色'); throw error })
      if (sample.length > 10 * 1024 * 1024 || sample.toString('ascii', 0, 4) !== 'RIFF' || sample.toString('ascii', 8, 12) !== 'WAVE') throw new Error('员工音色样本无效')
      const audio = await synthesize('mimo-v2.5-tts-voiceclone', text, `data:audio/wav;base64,${sample.toString('base64')}`)
      seconds = durationSeconds(audio)
      const temporary = join(voiceDir, `${id}.${randomUUID()}.tmp`)
      await writeFile(temporary, audio, { flag: 'wx', mode: 0o600 })
      await rename(temporary, audioPath)
    }
    if (!previous?.seconds) {
      const temporaryMetadata = join(voiceDir, `${id}.${randomUUID()}.json.tmp`)
      await writeFile(temporaryMetadata, JSON.stringify({ threadId: context.threadId, fingerprint, seconds }), { flag: 'wx', mode: 0o600 })
      await rename(temporaryMetadata, metadataPath)
    }
    console.log(marker(seconds))
  } finally { await lock.close(); await unlink(lockPath) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
