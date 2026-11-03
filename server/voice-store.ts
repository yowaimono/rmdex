import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function readEmployeeVoice(home: string, userId: string, employeeId: string, threadId: string, id: string) {
  if (![userId, employeeId].every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value)) || !/^[A-Za-z0-9-]{1,128}$/.test(threadId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return null
  const base = join(home, 'rmdex', 'employees'), user = join(base, userId), employee = join(user, employeeId), folder = join(employee, 'voice')
  const metadataPath = join(folder, `${id}.json`), audioPath = join(folder, `${id}.wav`)
  const paths = [join(home, 'rmdex'), base, user, employee, folder, metadataPath, audioPath]
  const entries = await Promise.all(paths.map(path => lstat(path).catch(() => null)))
  if (entries.some((item, index) => !item || item.isSymbolicLink() || (index < 5 ? !item.isDirectory() : !item.isFile())) || entries[6]!.size > 10 * 1024 * 1024) return null
  const metadata = await readFile(metadataPath, 'utf8').then(raw => JSON.parse(raw) as { threadId?: string }).catch(() => null)
  if (metadata?.threadId !== threadId) return null
  return readFile(audioPath).catch(() => null)
}
