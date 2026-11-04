// Managed by rmdex: employee artifact helper
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const threadIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(value)
const maxSize = 512 * 1024 * 1024

async function regular(path, directory = false, optional = false) {
  const info = await lstat(path).catch(error => { if (optional && error.code === 'ENOENT') return null; throw error })
  if (info && (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()))) throw new Error('产物登记路径不是普通文件或目录')
  return info
}

async function folder(home, threadId, create = false) {
  if (!threadIdentifier(threadId)) throw new Error('会话 ID 无效')
  let path = home
  for (const part of ['rmdex', 'artifacts', threadId]) {
    path = join(path, part)
    const exists = await regular(path, true, true)
    if (!exists) {
      if (!create) return null
      await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      await regular(path, true)
    }
  }
  return path
}

function validateRecord(record, threadId, id) {
  if (record?.version !== 1 || record.id !== id || record.threadId !== threadId || !threadIdentifier(record.turnId) ||
    !identifier(record.userId) || !identifier(record.employeeId) || typeof record.path !== 'string' || !isAbsolute(record.path) ||
    typeof record.name !== 'string' || !record.name || record.name.length > 240 || /[\\/\x00-\x1f]/.test(record.name) ||
    !Number.isSafeInteger(record.size) || record.size < 0 || record.size > maxSize || !Number.isFinite(record.mtimeMs) ||
    typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isFinite(record.createdAt) || typeof record.detached !== 'boolean') {
    throw new Error('产物登记记录损坏，请检查设备上的登记清单')
  }
  return record
}

async function readRecord(path, threadId, id) {
  const info = await regular(path, false, true)
  if (!info) return null
  if (info.size > 16 * 1024) throw new Error('产物登记记录过大')
  return validateRecord(JSON.parse(await readFile(path, 'utf8')), threadId, id)
}

export async function readArtifactRecords(home, threadId) {
  const directory = await folder(home, threadId)
  if (!directory) return []
  const names = (await readdir(directory)).filter(name => name.endsWith('.json') && uuid.test(name.slice(0, -5)))
  const records = await Promise.all(names.map(name => readRecord(join(directory, name), threadId, name.slice(0, -5))))
  return records.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

function publicRecord({ id, threadId, turnId, name, size, sha256, createdAt, detached }) {
  return { id, threadId, turnId, name, size, sha256, createdAt, detached }
}

async function contextFor(helperDirectory) {
  const path = join(helperDirectory, 'artifact-context.json')
  const info = await regular(path)
  if (info.size > 4096) throw new Error('产物登记配置无效')
  const context = JSON.parse(await readFile(path, 'utf8'))
  if (context.managedBy !== 'rmdex' || !identifier(context.userId) || !identifier(context.employeeId) || !threadIdentifier(context.threadId)) throw new Error('员工产物登记配置无效，请刷新员工会话')
  const home = resolve(helperDirectory, '../../../..')
  const expected = join(home, 'rmdex', 'employees', context.userId, context.employeeId)
  if (resolve(helperDirectory) !== expected) throw new Error('员工产物登记目录与身份不匹配')
  const origin = new URL(context.agentOrigin)
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('本机产物登记服务地址无效')
  for (const path of [join(home, 'rmdex'), join(home, 'rmdex', 'employees'), dirname(helperDirectory), helperDirectory]) await regular(path, true)
  return { ...context, home, agentOrigin: origin.origin }
}

async function withRecord(context, id, action) {
  if (!uuid.test(id)) throw new Error('--id 必须是 UUID')
  const directory = await folder(context.home, context.threadId, true)
  const lockPath = join(directory, `${id}.lock`)
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('此产物正在登记或上次执行中断，请先用 list 检查，保留原 ID 重试')
    throw error
  })
  const path = join(directory, `${id}.json`)
  try {
    const previous = await readRecord(path, context.threadId, id)
    if (previous && (previous.userId !== context.userId || previous.employeeId !== context.employeeId)) throw new Error('此产物 ID 属于其他员工')
    return await action(previous, async record => {
      const temporary = join(directory, `${id}.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    })
  } finally { await lock.close(); await unlink(lockPath) }
}

async function attach(context, id, file, requestedName) {
  if (!file || !isAbsolute(file)) throw new Error('--file 必须是已生成文件的绝对路径')
  return withRecord(context, id, async (previous, save) => {
    const path = await realpath(file)
    const info = await stat(path)
    if (!info.isFile() || info.size > maxSize) throw new Error('仅可登记 512 MB 以内的普通文件')
    const name = requestedName || basename(path)
    if (!name || name.length > 240 || /[\\/\x00-\x1f]/.test(name)) throw new Error('展示文件名无效')
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(path)) digest.update(chunk)
    const sha256 = digest.digest('hex')
    const after = await stat(path)
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || await realpath(file) !== path) throw new Error('文件仍在修改，请生成完成后重新登记')
    if (previous) {
      if (previous.path !== path || previous.name !== name || previous.sha256 !== sha256 || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs || previous.detached) throw new Error('同一产物 ID 不能用于不同文件、内容或已撤下的登记，请使用新的 ID')
      return { status: 'attached', reused: true, artifact: publicRecord(previous) }
    }
    const response = await fetch(`${context.agentOrigin}/api/threads/${context.threadId}/status`, { redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error('无法确认当前回合，请检查本机 agent 后保留原 ID 重试')
    const status = await response.json()
    const turnId = status.activeTurnId || status.lastTurn?.id
    if (status.threadId !== context.threadId || !threadIdentifier(turnId)) throw new Error('当前员工会话没有可登记产物的回合')
    const record = { version: 1, id, userId: context.userId, employeeId: context.employeeId, threadId: context.threadId, turnId, path, name, size: info.size, mtimeMs: info.mtimeMs, sha256, createdAt: Date.now(), detached: false }
    await save(record)
    return { status: 'attached', reused: false, artifact: publicRecord(record) }
  })
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!['attach', 'list', 'detach'].includes(command)) throw new Error('Usage: artifacts.mjs attach --file ABSOLUTE_PATH --id UUID [--name FILE_NAME] | list | detach --id UUID')
  const options = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (!['--file', '--id', '--name'].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error('产物登记参数无效')
    options.set(args[i], args[i + 1])
  }
  const context = await contextFor(dirname(fileURLToPath(import.meta.url)))
  if (command === 'list') {
    if (options.size) throw new Error('list 不接受额外参数')
    const records = await readArtifactRecords(context.home, context.threadId)
    console.log(JSON.stringify({ data: records.filter(record => record.userId === context.userId && record.employeeId === context.employeeId && !record.detached).map(publicRecord) }))
  } else {
    const id = options.get('--id')?.toLowerCase()
    if (!id || !uuid.test(id)) throw new Error('--id 必须是 UUID；重试时保留同一 ID')
    let result
    if (command === 'attach') result = await attach(context, id, options.get('--file'), options.get('--name'))
    else {
      if (options.size !== 1) throw new Error('detach 只接受 --id')
      result = await withRecord(context, id, async (previous, save) => {
        if (!previous) throw new Error('产物不存在')
        await save({ ...previous, detached: true })
        return { status: 'detached', artifact: publicRecord({ ...previous, detached: true }) }
      })
    }
    console.log(JSON.stringify(result))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1 })
