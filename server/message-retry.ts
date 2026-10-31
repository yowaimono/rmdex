import { createHash } from 'node:crypto'
import { OperationJournal } from './desktop-adapter.ts'
import { colleagueMessage } from '../src/conversation.ts'

type Rpc = (method: string, params: Record<string, unknown>) => Promise<any>
type RetryOptions = Record<string, unknown>

export class MessageRetryService {
  constructor(private rpc: Rpc, private journal: OperationJournal, private reverted: (threadId: string) => void,
    private backup: (operationId: string, original: unknown) => Promise<void>) {}

  async retry(threadId: string, data: { turnId?: unknown; operationId?: unknown }, options: RetryOptions) {
    if (typeof data.turnId !== 'string' || !data.turnId.trim() || data.turnId.length > 256) throw new Error('缺少有效的重试回合 ID')
    if (typeof data.operationId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.operationId)) throw new Error('缺少有效的重试操作编号')
    const turnId = data.turnId
    const fingerprint = createHash('sha256').update(JSON.stringify([threadId, turnId, options])).digest('hex')
    return this.journal.run(data.operationId, fingerprint, async () => {
      let targetId = threadId
      let targetThread: Record<string, any> | undefined
      let mutated = false
      let forked = false
      try {
        const { thread } = await this.rpc('thread/read', { threadId, includeTurns: false })
        if (!thread || thread.id !== threadId) throw new Error('目标会话不存在')
        if (thread.status?.type === 'active') throw new Error('此会话正在执行，请等待结束')
        let cursor: string | undefined
        let target: any
        let latestId: string | undefined
        const cursors = new Set<string>()
        do {
          const page = await this.rpc('thread/turns/list', { threadId, limit: 50, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) })
          latestId ||= page.data?.[0]?.id
          if (page.data?.some((turn: any) => turn.status === 'inProgress')) throw new Error('此会话正在执行，请等待结束')
          target = page.data?.find((turn: any) => turn.id === turnId)
          cursor = page.nextCursor || undefined
          if (cursor && cursors.has(cursor)) throw new Error('会话历史游标重复，请刷新后重试')
          if (cursor) cursors.add(cursor)
        } while (!target && cursor)
        if (!target) throw new Error('原消息已不在会话中，请刷新后重试')
        const users = (target.items || []).filter((item: any) => item.type === 'userMessage')
        if (users.length !== 1 || !Array.isArray(users[0].content) || !users[0].content.length) throw new Error('此回合包含多条输入或缺少原消息，暂不支持重试')
        const input = users[0].content.map(({ assetUrl: _assetUrl, ...part }: Record<string, unknown>) => part)
        const text = input.filter((part: any) => part.type === 'text').map((part: any) => part.text || '').join('\n')
        if (colleagueMessage(text)) throw new Error('员工来信不能作为用户消息重试')
        // Preserve original input, including attachments and initial employee
        // context: this replaces that turn instead of appending it again.
        const queue = await this.rpc('thread/queue/list', { threadId, limit: 1 })
        if (queue.data?.length) throw new Error('会话还有排队消息，请等待处理结束后重试')
        // A second client may have added a turn while older history loaded.
        // Recheck the head immediately before deciding to replace in place.
        const head = await this.rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' })
        if (head.data?.[0]?.status === 'inProgress') throw new Error('此会话正在执行，请等待结束')
        latestId = head.data?.[0]?.id || latestId
        forked = latestId !== turnId
        await this.backup(data.operationId as string, { thread, turn: target })
        if (forked) {
          mutated = true
          const result = await this.rpc('thread/fork', { threadId, beforeTurnId: turnId, excludeTurns: true, deferGoalContinuation: true })
          if (typeof result.thread?.id !== 'string' || result.thread.id === threadId) throw new Error('Codex 未返回有效的重试分叉')
          targetThread = result.thread
          targetId = result.thread.id
        } else {
          mutated = true
          const result = await this.rpc('thread/revert', { threadId, beforeTurnId: turnId })
          targetThread = result.thread || thread
          this.reverted(threadId)
        }
        const started = await this.rpc('turn/start', { threadId: targetId, input, clientUserMessageId: data.operationId, ...options })
        if (!started.turn?.id) throw new Error('Codex 未确认重新生成的回合')
        return { outcome: 'started', threadId: targetId, thread: targetThread, sourceThreadId: threadId, replacedTurnId: turnId, forked, turn: started.turn }
      } catch (error) {
        return { outcome: mutated ? 'uncertain' : 'rejected', threadId: targetId, ...(targetThread ? { thread: targetThread } : {}), sourceThreadId: threadId, replacedTurnId: turnId, forked,
          message: mutated ? `重试结果未确认，请刷新会话核对，未重复提交：${error instanceof Error ? error.message : String(error)}` : error instanceof Error ? error.message : String(error) }
      }
    })
  }
}
