import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { PlatformQueue, PlatformQueueProducer } from '@hcengineering/server-core'
import type postgres from 'postgres'
import type { PgQueueConfig } from './config'
import { notifyChannel } from './schema'

export class PgQueueProducer<T> implements PlatformQueueProducer<T> {
  private closed = false

  constructor (
    private readonly sql: postgres.Sql,
    private readonly config: PgQueueConfig,
    private readonly topic: string,
    private readonly queue: PlatformQueue
  ) {}

  getQueue (): PlatformQueue {
    return this.queue
  }

  async send (ctx: MeasureContext, workspace: WorkspaceUuid, msgs: T[], partitionKey?: string): Promise<void> {
    if (this.closed) {
      throw new Error('producer is closed')
    }
    if (msgs.length === 0) return

    const key = partitionKey ?? workspace
    const meta = JSON.stringify(ctx.extractMeta())
    const topic = this.topic
    const schema = this.config.schema
    const channel = notifyChannel(schema, topic)

    await ctx.with('send', { topic }, async () => {
      await this.sql.begin(async (tx) => {
        const rows = msgs.map((value) => ({
          topic,
          partition_key: key,
          workspace,
          value: JSON.stringify(value),
          meta
        }))
        await tx`
          INSERT INTO ${tx(schema, 'messages')}
          ${tx(rows, 'topic', 'partition_key', 'workspace', 'value', 'meta')}
        `
        await tx`SELECT pg_notify(${channel}, '')`
      })
    })
  }

  isClosed (): boolean {
    return this.closed
  }

  async close (): Promise<void> {
    this.closed = true
  }
}
