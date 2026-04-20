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
    const rawMeta = ctx.extractMeta?.()
    const meta = JSON.stringify(rawMeta ?? {})
    const topic = this.topic
    const schema = this.config.schema
    const channel = notifyChannel(schema, topic)

    const insertSql =
      `INSERT INTO "${schema}".messages (topic, partition_key, workspace, value, meta) ` +
      'VALUES ' + msgs.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}::jsonb, $${i * 5 + 5}::jsonb)`).join(', ')
    const insertParams: unknown[] = []
    for (const value of msgs) {
      insertParams.push(topic, key, workspace, JSON.stringify(value), meta)
    }

    await ctx.with('send', { topic }, async () => {
      await this.sql.begin(async (tx) => {
        await tx.unsafe(insertSql, insertParams as any)
        await tx.unsafe('SELECT pg_notify($1, $2)', [channel, ''])
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
