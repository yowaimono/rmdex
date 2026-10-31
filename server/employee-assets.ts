import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const managedMarker = '<!-- Managed by rmdex: rmdex-employee -->'
const sourceSkill = new URL('./skills/rmdex-employee/SKILL.md', import.meta.url)
const installations = new Map<string, Promise<string>>()
const distributedSkills = new Map<string, string>()

function codexHome() { return process.env.CODEX_HOME || join(homedir(), '.codex') }
function identifier(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid employee asset identifier')
  return value
}

async function installSkill(home: string, distributedContent?: string) {
  const folder = join(home, 'skills', 'rmdex-employee')
  const path = join(folder, 'SKILL.md')
  const existingFolder = await lstat(folder).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (existingFolder && (!existingFolder.isDirectory() || existingFolder.isSymbolicLink())) throw new Error('Employee skill directory is not a regular directory')
  await mkdir(folder, { recursive: true })
  const existingFile = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (existingFile && (!existingFile.isFile() || existingFile.isSymbolicLink())) throw new Error('Employee skill is not a regular file')
  const existing = existingFile ? await readFile(path, 'utf8') : undefined
  if (existing !== undefined && !existing.includes(managedMarker)) throw new Error('A user-managed rmdex-employee skill already exists')
  const content = distributedContent ?? await readFile(sourceSkill, 'utf8')
  if (content.length > 64_000 || !/^---\r?\nname: rmdex-employee\r?\n/.test(content) || !content.includes(managedMarker)) throw new Error('Invalid employee skill content')
  if (existing !== content) await writeFile(path, content, { encoding: 'utf8', mode: 0o600, ...(existing === undefined ? { flag: 'wx' } : {}) })
  return path
}

export async function installEmployeeSkill(home = codexHome(), distributedContent?: string) {
  const previous = installations.get(home)
  const operation = (async () => {
    await previous?.catch(() => {})
    const path = await installSkill(home, distributedContent ?? distributedSkills.get(home))
    if (distributedContent !== undefined) distributedSkills.set(home, distributedContent)
    return path
  })()
  installations.set(home, operation)
  try { return await operation } finally { if (installations.get(home) === operation) installations.delete(home) }
}

async function ensureDirectory(path: string) {
  const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('Employee asset path is not a regular directory')
  await mkdir(path, { recursive: true })
}

export async function prepareEmployeeAssets(value: { userId?: unknown; employeeId?: unknown; legacyMemory?: unknown; legacyMemoryDate?: unknown; communication?: { origin: string; token: string } }, home = codexHome()) {
  const userId = identifier(value.userId)
  const employeeId = identifier(value.employeeId)
  if (value.legacyMemory !== undefined && (typeof value.legacyMemory !== 'string' || value.legacyMemory.length > 20_000)) throw new Error('Invalid previous employee memory')
  const skillPath = await installEmployeeSkill(home)
  const assetPath = join(home, 'rmdex', 'employees', userId, employeeId)
  const memories = join(assetPath, 'memories')
  for (const path of [join(home, 'rmdex'), join(home, 'rmdex', 'employees'), join(home, 'rmdex', 'employees', userId), assetPath, memories, join(assetPath, 'sops')]) await ensureDirectory(path)
  if (value.communication) {
    const origin = new URL(value.communication.origin)
    if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Invalid communication origin')
    if (typeof value.communication.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(value.communication.token)) throw new Error('Invalid communication token')
    const files = [
      ['colleagues.mjs', await readFile(new URL('./skills/rmdex-employee/colleagues.mjs', import.meta.url), 'utf8')],
      ['communication.json', JSON.stringify({ managedBy: 'rmdex', origin: origin.origin, token: value.communication.token })],
    ]
    for (const [name, content] of files) {
      const path = join(assetPath, name!)
      const existing = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Communication asset is not a regular file')
      if (existing) {
        const old = await readFile(path, 'utf8')
        if (name === 'communication.json' ? JSON.parse(old).managedBy !== 'rmdex' : !old.startsWith('// Managed by rmdex: employee communication helper')) throw new Error('User-managed communication asset already exists')
      }
      await writeFile(path, content!, { mode: 0o600, ...(existing ? {} : { flag: 'wx' }) })
    }
  }
  if (typeof value.legacyMemory === 'string' && value.legacyMemory.trim()) {
    if (typeof value.legacyMemoryDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.legacyMemoryDate)) throw new Error('Invalid previous employee memory date')
    const path = join(memories, `${value.legacyMemoryDate}-previous-employee-memory.md`)
    const content = `# Previous employee memory\n\n${value.legacyMemory.trim()}\n`
    try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== content) throw error
    }
  }
  return { assetPath, skillPath }
}
