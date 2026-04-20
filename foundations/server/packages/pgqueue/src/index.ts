import type { PlatformQueue } from '@hcengineering/server-core'
import { isPgQueueConfig, parsePgQueueConfig, type PgQueueConfig } from './config'
import { PgQueue } from './queue'

export { isPgQueueConfig, parsePgQueueConfig, type PgQueueConfig } from './config'
export { PgQueue } from './queue'

export function createPgQueue (config: PgQueueConfig): PlatformQueue {
  console.info({ message: 'Using pgqueue', schema: config.schema, clientId: config.clientId })
  return new PgQueue(config)
}

export function tryCreatePgQueueFromEnv (serviceId: string, region?: string): PlatformQueue | undefined {
  const raw = process.env.QUEUE_CONFIG
  if (raw === undefined || !isPgQueueConfig(raw)) return undefined
  const config = parsePgQueueConfig(raw, serviceId, region ?? process.env.REGION ?? '')
  return createPgQueue(config)
}
