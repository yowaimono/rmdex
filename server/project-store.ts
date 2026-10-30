import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export type ManagedProject = { id: string; name: string; path: string; createdAt: number; updatedAt: number }
export type NativeProject = { id: string; name: string; path: string }
export type ProjectView = ManagedProject & { source: 'local' | 'desktop'; nativeProjectId?: string }

function normalizePath(value: string) {
  return value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLocaleLowerCase()
}

export class ProjectStore {
  private projects: ManagedProject[] = []
  private ready: Promise<void>
  private queue = Promise.resolve()
  private readonly file: string

  constructor(codexHome: string) {
    this.file = join(codexHome, 'rmdex-projects.json')
    this.ready = readFile(this.file, 'utf8').then(raw => {
      const data = JSON.parse(raw)
      if (Array.isArray(data)) this.projects = data.filter((item): item is ManagedProject => Boolean(item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.path === 'string'))
    }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[rmdex] Project metadata could not be loaded')
    })
  }

  async list(nativeProjects: NativeProject[] = []): Promise<ProjectView[]> {
    await this.ready
    const nativeByPath = new Map(nativeProjects.map(project => [normalizePath(project.path), project]))
    const local = this.projects.map(project => {
      const native = nativeByPath.get(normalizePath(project.path))
      if (native) nativeByPath.delete(normalizePath(native.path))
      return { ...project, source: 'local' as const, ...(native ? { nativeProjectId: native.id } : {}) }
    })
    const desktop = [...nativeByPath.values()].map(project => ({
      id: `desktop-${project.id}`,
      name: project.name,
      path: project.path,
      createdAt: 0,
      updatedAt: 0,
      source: 'desktop' as const,
      nativeProjectId: project.id,
    }))
    return [...local, ...desktop]
  }

  async create(input: { name?: unknown; path?: unknown }) {
    const project = await this.validate(input)
    return this.mutate(async () => {
      if (this.projects.some(item => normalizePath(item.path) === normalizePath(project.path))) throw new Error('此路径已添加为 Project')
      const now = Date.now()
      const created = { id: randomUUID(), ...project, createdAt: now, updatedAt: now }
      this.projects.push(created)
      await this.persist()
      return created
    })
  }

  async update(id: string, input: { name?: unknown; path?: unknown }) {
    const project = await this.validate(input)
    return this.mutate(async () => {
      const index = this.projects.findIndex(item => item.id === id)
      if (index < 0) throw new Error('Project 不存在或由 Codex Desktop 管理')
      if (this.projects.some(item => item.id !== id && normalizePath(item.path) === normalizePath(project.path))) throw new Error('此路径已添加为 Project')
      const updated = { ...this.projects[index]!, ...project, updatedAt: Date.now() }
      this.projects[index] = updated
      await this.persist()
      return updated
    })
  }

  async delete(id: string) {
    return this.mutate(async () => {
      const index = this.projects.findIndex(item => item.id === id)
      if (index < 0) throw new Error('Project 不存在或由 Codex Desktop 管理')
      this.projects.splice(index, 1)
      await this.persist()
      return { deleted: true, id }
    })
  }

  private async validate(input: { name?: unknown; path?: unknown }) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    const projectPath = typeof input.path === 'string' ? input.path.trim() : ''
    if (!name || name.length > 80) throw new Error('Project 名称不能为空且不能超过 80 个字符')
    if (!projectPath || !isAbsolute(projectPath) || projectPath.length > 1000) throw new Error('请输入有效的绝对文件夹路径')
    const details = await stat(projectPath).catch(() => null)
    if (!details?.isDirectory()) throw new Error('Project 路径不存在或不是文件夹')
    return { name, path: projectPath }
  }

  private mutate<T>(action: () => Promise<T>) {
    const result = this.queue.then(action)
    this.queue = result.then(() => {}, () => {})
    return result
  }

  private async persist() {
    await mkdir(join(this.file, '..'), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(this.projects, null, 2), { mode: 0o600 })
    await rename(temporary, this.file)
  }
}
