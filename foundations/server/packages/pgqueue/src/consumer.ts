import type { MeasureContext, WorkspaceUuid } from '@hcengineering/core'
import type { ConsumerControl, ConsumerHandle, ConsumerMessage } from '@hcengineering/server-core'
import type postgres from 'postgres'
import type { PgQueueConfig } from './config'
import { notifyChannel } from './schema'

interface MessageRow {
  id: string
  workspace: string
  value: unknown
  meta: unknown
}

export interface ConsumerOptions {
  fromBegining?: boolean
  retryDelay?: number
  maxRetryDelay?: number
}

export class PgQueueConsumer implements ConsumerHandle {
  private connected = false
  private closing = false
  private paused = false
  private wake: (() => void) | undefined
  private unlisten: (() => Promise<void>) | undefined
  private readonly groupKey: string
  private readonly channel: string

  constructor (
    private readonly ctx: MeasureContext,
    private readonly sql: postgres.Sql,
    private readonly config: PgQueueConfig,
    private readonly topic: string,
    groupId: string,
    private readonly onMessage: (
      ctx: MeasureContext,
      msg: ConsumerMessage<any>,
      control: ConsumerControl
    ) => Promise<void>,
    private readonly options?: ConsumerOptions
  ) {
    this.groupKey = `${topic}-${groupId}`
    this.channel = notifyChannel(config.schema, topic)
    void this.run().catch((err) => {
      ctx.error('pgqueue consumer failed', { err, topic, groupId })
    })
  }

  isConnected (): boolean {
    return this.connected
  }

  async close (): Promise<void> {
    this.closing = true
    this.wake?.()
    if (this.unlisten !== undefined) {
      try {
        await this.unlisten()
      } catch (err: any) {
        this.ctx.warn('pgqueue unlisten failed', { err })
      }
    }
  }

  private async run (): Promise<void> {
    await this.attachListener()
    if (this.options?.fromBegining === true) {
      await this.resetOffsetToZero()
    }
    this.connected = true
    this.ctx.info('pgqueue consumer connected', { topic: this.topic, group: this.groupKey })

    const retryDelay = this.options?.retryDelay ?? 1000
    const maxRetryDelay = this.options?.maxRetryDelay ?? 10

    while (!this.closing) {
      if (this.paused) {
        await this.waitForSignal(this.config.pollIntervalMs)
        continue
      }

      const rows = await this.fetchBatch()
      if (rows.length === 0) {
        await this.waitForSignal(this.config.pollIntervalMs)
        continue
      }

      for (const row of rows) {
        if (this.closing) break

        const msg: ConsumerMessage<any> = {
          workspace: row.workspace as WorkspaceUuid,
          value: row.value
        }
        const control: ConsumerControl = {
          pause: () => {
            this.paused = true
          },
          heartbeat: async () => {}
        }
        const meta = (row.meta as Record<string, any>) ?? {}

        let attempt = 1
        while (!this.closing) {
          try {
            await this.ctx.with(
              'handle-msg',
              {},
              (ctx) => this.onMessage(ctx, msg, control),
              {},
              { meta }
            )
            break
          } catch (err: any) {
            this.ctx.error('pgqueue failed to process message', {
              err,
              topic: this.topic,
              group: this.groupKey,
              id: row.id
            })
            const backoff = Math.min(attempt, maxRetryDelay) * retryDelay
            await this.waitForSignal(backoff)
            attempt++
            if (this.closing) break
          }
        }

        if (!this.closing) {
          await this.commitOffset(BigInt(row.id))
        }
      }
    }

    this.connected = false
  }

  private async attachListener (): Promise<void> {
    try {
      const result = await this.sql.listen(this.channel, () => {
        this.wake?.()
      })
      this.unlisten = result.unlisten
    } catch (err: any) {
      this.ctx.warn('pgqueue listen not supported, falling back to polling only', { err })
    }
  }

  private async resetOffsetToZero (): Promise<void> {
    const schema = this.config.schema
    await this.sql`
      INSERT INTO ${this.sql(schema, 'consumer_offsets')} (topic, group_id, last_id)
      VALUES (${this.topic}, ${this.groupKey}, 0)
      ON CONFLICT (topic, group_id) DO UPDATE SET last_id = 0, updated_at = now()
    `
  }

  private async fetchBatch (): Promise<MessageRow[]> {
    const schema = this.config.schema
    const rows = await this.sql<MessageRow[]>`
      WITH cur AS (
        SELECT COALESCE(
          (SELECT last_id FROM ${this.sql(schema, 'consumer_offsets')}
            WHERE topic = ${this.topic} AND group_id = ${this.groupKey}),
          0
        ) AS last_id
      )
      SELECT m.id::text AS id, m.workspace, m.value, m.meta
      FROM ${this.sql(schema, 'messages')} m, cur
      WHERE m.topic = ${this.topic} AND m.id > cur.last_id
      ORDER BY m.id ASC
      LIMIT 100
    `
    return rows
  }

  private async commitOffset (lastId: bigint): Promise<void> {
    const schema = this.config.schema
    const lastIdStr = lastId.toString()
    await this.sql`
      INSERT INTO ${this.sql(schema, 'consumer_offsets')} (topic, group_id, last_id)
      VALUES (${this.topic}, ${this.groupKey}, ${lastIdStr})
      ON CONFLICT (topic, group_id) DO UPDATE
        SET last_id = GREATEST(${this.sql(schema, 'consumer_offsets')}.last_id, EXCLUDED.last_id),
            updated_at = now()
    `
  }

  private async waitForSignal (timeoutMs: number): Promise<void> {
    if (this.closing) return
    await new Promise<void>((resolve) => {
      let resolved = false
      const done = (): void => {
        if (resolved) return
        resolved = true
        this.wake = undefined
        resolve()
      }
      this.wake = done
      setTimeout(done, timeoutMs)
    })
  }
}
