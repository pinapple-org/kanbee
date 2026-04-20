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

function parseJsonb (raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
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
          value: parseJsonb(row.value)
        }
        const control: ConsumerControl = {
          pause: () => {
            this.paused = true
          },
          heartbeat: async () => {}
        }
        const meta = (parseJsonb(row.meta) as Record<string, any>) ?? {}

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
          await this.commitOffset(row.id)
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
    await this.sql.unsafe(
      `INSERT INTO "${schema}".consumer_offsets (topic, group_id, last_id)
       VALUES ($1, $2, 0)
       ON CONFLICT (topic, group_id) DO UPDATE SET last_id = 0, updated_at = now()`,
      [this.topic, this.groupKey] as any
    )
  }

  private async fetchBatch (): Promise<MessageRow[]> {
    const schema = this.config.schema
    const rows = await this.sql.unsafe<MessageRow[]>(
      `WITH cur AS (
         SELECT COALESCE(
           (SELECT last_id FROM "${schema}".consumer_offsets WHERE topic = $1 AND group_id = $2),
           0
         ) AS last_id
       )
       SELECT m.id::text AS id, m.workspace, m.value, m.meta
       FROM "${schema}".messages m, cur
       WHERE m.topic = $1 AND m.id > cur.last_id
       ORDER BY m.id ASC
       LIMIT 100`,
      [this.topic, this.groupKey] as any
    )
    return rows as unknown as MessageRow[]
  }

  private async commitOffset (lastId: string): Promise<void> {
    const schema = this.config.schema
    await this.sql.unsafe(
      `INSERT INTO "${schema}".consumer_offsets (topic, group_id, last_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (topic, group_id) DO UPDATE
         SET last_id = GREATEST("${schema}".consumer_offsets.last_id, EXCLUDED.last_id),
             updated_at = now()`,
      [this.topic, this.groupKey, lastId] as any
    )
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
