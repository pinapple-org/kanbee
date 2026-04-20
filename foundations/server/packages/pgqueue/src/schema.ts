import type postgres from 'postgres'

export async function ensureSchema (sql: postgres.Sql, schema: string): Promise<void> {
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS ${schema};

    CREATE TABLE IF NOT EXISTS ${schema}.messages (
      id BIGSERIAL PRIMARY KEY,
      topic TEXT NOT NULL,
      partition_key TEXT NOT NULL,
      workspace TEXT NOT NULL,
      value JSONB NOT NULL,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS messages_topic_id_idx ON ${schema}.messages (topic, id);
    CREATE INDEX IF NOT EXISTS messages_created_at_idx ON ${schema}.messages (created_at);

    CREATE TABLE IF NOT EXISTS ${schema}.consumer_offsets (
      topic TEXT NOT NULL,
      group_id TEXT NOT NULL,
      last_id BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (topic, group_id)
    );
  `)
}

export function notifyChannel (schema: string, topic: string): string {
  return `${schema}__${topic}`.replace(/[^a-zA-Z0-9_]/g, '_')
}
