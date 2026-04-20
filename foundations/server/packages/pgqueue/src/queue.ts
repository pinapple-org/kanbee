import type { MeasureContext } from '@hcengineering/core'
import {
  QueueTopic,
  type ConsumerControl,
  type ConsumerHandle,
  type ConsumerMessage,
  type PlatformQueue,
  type PlatformQueueProducer
} from '@hcengineering/server-core'
import postgres from 'postgres'
import type { PgQueueConfig } from './config'
import { PgQueueConsumer } from './consumer'
import { PgQueueProducer } from './producer'
import { ensureSchema } from './schema'

export class PgQueue implements PlatformQueue {
  private readonly sql: postgres.Sql
  private readonly producers = new Map<string, PgQueueProducer<any>>()
  private readonly consumers: PgQueueConsumer[] = []
  private schemaReady: Promise<void> | undefined
  private closed = false

  constructor (readonly config: PgQueueConfig) {
    this.sql = postgres(config.connectionString, {
      max: 10,
      connect_timeout: 10,
      idle_timeout: 30,
      prepare: false,
      ...config.postgresOptions
    })
  }

  getClientId (): string {
    return this.config.clientId
  }

  private async ready (): Promise<postgres.Sql> {
    if (this.schemaReady === undefined) {
      this.schemaReady = ensureSchema(this.sql, this.config.schema)
    }
    await this.schemaReady
    return this.sql
  }

  getProducer<T>(ctx: MeasureContext, topic: QueueTopic | string): PlatformQueueProducer<T> {
    const topicId = this.toTopicId(topic)
    const existing = this.producers.get(topicId)
    if (existing !== undefined && !existing.isClosed()) {
      return existing as unknown as PlatformQueueProducer<T>
    }
    const producer = new PgQueueProducerWrapper<T>(ctx, this, topicId)
    this.producers.set(topicId, producer as unknown as PgQueueProducer<any>)
    return producer
  }

  createConsumer<T>(
    ctx: MeasureContext,
    topic: QueueTopic | string,
    groupId: string,
    onMessage: (ctx: MeasureContext, msg: ConsumerMessage<T>, queue: ConsumerControl) => Promise<void>,
    options?: {
      fromBegining?: boolean
      retryDelay?: number
      maxRetryDelay?: number
    }
  ): ConsumerHandle {
    const topicId = this.toTopicId(topic)
    const handle: ConsumerHandle = {
      close: async () => {}, // replaced below
      isConnected: () => false
    }

    void (async () => {
      const sql = await this.ready()
      const real = new PgQueueConsumer(ctx, sql, this.config, topicId, groupId, onMessage as any, options)
      this.consumers.push(real)
      handle.close = real.close.bind(real)
      handle.isConnected = real.isConnected.bind(real)
    })().catch((err) => {
      ctx.error('pgqueue createConsumer failed', { err, topic: topicId, groupId })
    })

    return handle
  }

  async createTopic (topics: string | string[], partitions: number): Promise<void> {
    // No-op: PG queue does not require explicit topic creation.
    // Schema is ensured on first producer/consumer use.
    await this.ready()
  }

  async createTopics (tx: number): Promise<void> {
    await this.ready()
  }

  async deleteTopics (topics?: (QueueTopic | string)[]): Promise<void> {
    const sql = await this.ready()
    const list = topics !== undefined
      ? topics.map((t) => this.toTopicId(t))
      : Object.values(QueueTopic).map((t) => this.toTopicId(t))

    if (list.length === 0) return
    await sql`
      DELETE FROM ${sql(this.config.schema)}.messages
      WHERE topic = ANY(${list})
    `
    await sql`
      DELETE FROM ${sql(this.config.schema)}.consumer_offsets
      WHERE topic = ANY(${list})
    `
  }

  async shutdown (): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const [, producer] of this.producers) {
      try {
        await producer.close()
      } catch (err: any) {
        console.error('pgqueue producer close failed', err)
      }
    }
    for (const consumer of this.consumers) {
      try {
        await consumer.close()
      } catch (err: any) {
        console.error('pgqueue consumer close failed', err)
      }
    }
    await this.sql.end({ timeout: 5 })
  }

  internalSql (): postgres.Sql {
    return this.sql
  }

  toTopicId (topic: QueueTopic | string): string {
    if (this.config.region !== '') {
      return `${this.config.region}.${topic}`
    }
    return topic
  }
}

class PgQueueProducerWrapper<T> implements PlatformQueueProducer<T> {
  private inner: PgQueueProducer<T> | undefined
  private closed = false
  private readonly buffered: Array<{
    ctx: MeasureContext
    workspace: string
    msgs: T[]
    partitionKey: string | undefined
    resolve: () => void
    reject: (err: any) => void
  }> = []

  constructor (
    private readonly ctx: MeasureContext,
    private readonly queue: PgQueue,
    private readonly topic: string
  ) {
    void this.init().catch((err) => ctx.error('pgqueue producer init failed', { err, topic }))
  }

  private async init (): Promise<void> {
    const sql = await (this.queue as any).ready()
    this.inner = new PgQueueProducer<T>(sql, this.queue.config, this.topic, this.queue)
    const queued = this.buffered.splice(0)
    for (const item of queued) {
      try {
        await this.inner.send(item.ctx, item.workspace as any, item.msgs, item.partitionKey)
        item.resolve()
      } catch (err: any) {
        item.reject(err)
      }
    }
  }

  getQueue (): PlatformQueue {
    return this.queue
  }

  async send (ctx: MeasureContext, workspace: any, msgs: T[], partitionKey?: string): Promise<void> {
    if (this.closed) throw new Error('producer is closed')
    if (this.inner !== undefined) {
      await this.inner.send(ctx, workspace, msgs, partitionKey)
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.buffered.push({ ctx, workspace, msgs, partitionKey, resolve, reject })
    })
  }

  isClosed (): boolean {
    return this.closed
  }

  async close (): Promise<void> {
    this.closed = true
    if (this.inner !== undefined) {
      await this.inner.close()
    }
  }
}
