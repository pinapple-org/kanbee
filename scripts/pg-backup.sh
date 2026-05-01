#!/usr/bin/env bash
# Streams pg_dump output, gzipped, into R2 under backups/postgres/<UTC-timestamp>.sql.gz
#
# Restore (one-shot, against an empty target DB):
#   aws s3 cp s3://kanbee/backups/postgres/<key>.sql.gz - \
#     --endpoint-url "$R2_ENDPOINT" | gunzip | psql "$TARGET_DATABASE_URL"

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL required (postgres connection string for the source DB)}"
: "${R2_BUCKET:?R2_BUCKET required}"
: "${R2_ENDPOINT:?R2_ENDPOINT required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID required (R2 access key)}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY required (R2 secret key)}"

TIMESTAMP=$(date -u +%Y-%m-%dT%H-%M-%SZ)
KEY="backups/postgres/${TIMESTAMP}.sql.gz"

echo "==> Dumping Postgres to s3://${R2_BUCKET}/${KEY}"
set -o pipefail
pg_dump --no-owner --no-privileges --format=plain "${DATABASE_URL}" \
  | gzip -9 \
  | aws s3 cp - "s3://${R2_BUCKET}/${KEY}" \
      --endpoint-url "${R2_ENDPOINT}" \
      --no-progress

echo "==> Backup complete"
echo "==> Recent backups:"
aws s3 ls "s3://${R2_BUCKET}/backups/postgres/" \
  --endpoint-url "${R2_ENDPOINT}" \
  | sort \
  | tail -7
