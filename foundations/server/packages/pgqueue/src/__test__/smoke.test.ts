import { MeasureMetricsContext } from '@hcengineering/core'
import postgres from 'postgres'
import { PgQueue } from '../queue'
import type { PgQueueConfig } from '../config'

const PG_URL = process.env.PGQUEUE_TEST_DB_URL

const describeIfDb = PG_URL !== undefined ? describe : describe.skip

describeIfDb('PgQueue smoke', () => {
  const config: PgQueueConfig = {
    connectionString: PG_URL ?? '',
    clientId: 'test',
    region: '',
    schema: `huly_queue_test_${process.pid}`,
    pollIntervalMs: 500,
    retentionHours: 1
  }
  let queue: PgQueue

  beforeAll(async () => {
    queue = new PgQueue(config)
  })

  afterAll(async () => {
    const sql = postgres(config.connectionString)
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`)
    await sql.end({ timeout: 5 })
    await queue.shutdown()
  })

  it('roundtrips a message from producer to consumer', async () => {
    const ctx = new MeasureMetricsContext('pgqueue-test', {})
    const producer = queue.getProducer<{ hello: string }>(ctx, 'test-topic')

    const received: Array<{ hello: string }> = []
    const consumer = queue.createConsumer<{ hello: string }>(
      ctx,
      'test-topic',
      'test-group',
      async (_c, msg) => {
        received.push(msg.value)
      },
      { fromBegining: true }
    )

    await producer.send(ctx, 'ws-1' as any, [{ hello: 'world' }, { hello: 'there' }])

    const start = Date.now()
    while (received.length < 2 && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 100))
    }

    expect(received).toEqual([{ hello: 'world' }, { hello: 'there' }])

    await consumer.close()
    await producer.close()
  }, 30_000)

  it('persists offset across a new consumer', async () => {
    const ctx = new MeasureMetricsContext('pgqueue-test', {})
    const producer = queue.getProducer<{ n: number }>(ctx, 'offset-topic')
    await producer.send(ctx, 'ws-2' as any, [{ n: 1 }, { n: 2 }, { n: 3 }])

    const firstRun: number[] = []
    const c1 = queue.createConsumer<{ n: number }>(
      ctx,
      'offset-topic',
      'offset-group',
      async (_c, msg) => {
        firstRun.push(msg.value.n)
      },
      { fromBegining: true }
    )
    const start = Date.now()
    while (firstRun.length < 3 && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await c1.close()
    expect(firstRun).toEqual([1, 2, 3])

    await producer.send(ctx, 'ws-2' as any, [{ n: 4 }])

    const secondRun: number[] = []
    const c2 = queue.createConsumer<{ n: number }>(
      ctx,
      'offset-topic',
      'offset-group',
      async (_c, msg) => {
        secondRun.push(msg.value.n)
      }
    )
    const s2 = Date.now()
    while (secondRun.length < 1 && Date.now() - s2 < 10_000) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await c2.close()

    expect(secondRun).toEqual([4])
    await producer.close()
  }, 30_000)
})
