import type { Options } from 'postgres'

export interface PgQueueConfig {
  connectionString: string
  clientId: string
  region: string
  schema: string
  pollIntervalMs: number
  retentionHours: number
  postgresOptions?: Options<Record<string, never>>
}

const DEFAULT_SCHEMA = 'huly_queue'
const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_RETENTION_HOURS = 24 * 7

export function parsePgQueueConfig (queueConfig: string, serviceId: string, region: string): PgQueueConfig {
  const url = new URL(queueConfig)
  const schema = url.searchParams.get('schema') ?? DEFAULT_SCHEMA
  const pollIntervalMs = parseInt(url.searchParams.get('poll_interval_ms') ?? `${DEFAULT_POLL_INTERVAL_MS}`, 10)
  const retentionHours = parseInt(url.searchParams.get('retention_hours') ?? `${DEFAULT_RETENTION_HOURS}`, 10)

  const cleanUrl = new URL(queueConfig)
  cleanUrl.searchParams.delete('schema')
  cleanUrl.searchParams.delete('poll_interval_ms')
  cleanUrl.searchParams.delete('retention_hours')

  return {
    connectionString: cleanUrl.toString(),
    clientId: serviceId,
    region,
    schema,
    pollIntervalMs,
    retentionHours
  }
}

export function isPgQueueConfig (queueConfig: string): boolean {
  return queueConfig.startsWith('postgres://') || queueConfig.startsWith('postgresql://')
}
