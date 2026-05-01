# Kanbee staging on Railway

A `staging` environment inside the existing `kanbee-prod` Railway project. Same service definitions as prod (Railway environment duplication shares them), per-environment env-var overrides for the things that must differ. Stays scaled-to-zero between deploys.

Cost when idle: ~$0.10–0.50/mo (storage volumes only — Railway environments get their own volumes). Cost during ~20-min smoke tests: pennies. Total realistic budget: **<$2/mo**.

## What "staging" exists to catch

Things that don't surface in any local docker stack:

- Railway template-var resolution (`${{...RAILWAY_PUBLIC_DOMAIN}}` vs `.railway.internal` literal)
- Service-slug-vs-name mismatches (`rekoni` → `rekoni-service.railway.internal`, `kvs` → `hulykvs.railway.internal`)
- Front↔transactor handshake through Railway's TLS termination (the `wss://` path)
- Migration timing/locks against realistic data
- Env var validation at Railway-injected startup time
- R2 latency over the public network

## Post-duplication checklist (do this before scaling anything up)

The `staging` environment was created by duplicating `production` inside the `kanbee-prod` project. That copies service definitions **and** env vars verbatim. Internal-DNS template references (e.g. `postgres.railway.internal`) automatically resolve to staging's own services because `.railway.internal` is environment-scoped — that part is safe out of the box.

What is **not** safe out of the box: anything pointing at external resources or reusing prod secrets. The defaults will have staging writing to the prod R2 bucket and accepting prod-signed JWTs. Override these before first boot.

### Step 1 — Switch to the staging environment in the dashboard

Top-of-project environment switcher → `staging`. Every change below applies only to the selected environment.

### Step 2 — Generate fresh shared secrets

These were duplicated from prod and need replacing so a leaked staging secret can never authenticate against prod (and vice versa):

| Secret | Where to set it | Generate with |
|---|---|---|
| `SERVER_SECRET` | every backend service that has it (account, transactor, workspace, fulltext, collaborator, stats, kvs, …) | `openssl rand -hex 32` |
| `MEILI_MASTER_KEY` | the **Meilisearch** service env, **and** every service that connects to it (transactor, workspace, fulltext) inside their `FULLTEXT_DB_URL` | `openssl rand -hex 32` |

Use Railway's "shared variables" feature if available so `SERVER_SECRET` lives in one place per env.

### Step 3 — Point storage at a separate R2 bucket

Create `kanbee-staging` bucket in Cloudflare R2 (same access keys work — keys aren't bucket-scoped). Add a lifecycle rule on the staging bucket to auto-expire objects after 14 days.

Then on every service whose env has `STORAGE_CONFIG`, change `rootBucket=kanbee` → `rootBucket=kanbee-staging`. (account, transactor, workspace, fulltext, collaborator, front — anything S3-aware.)

### Step 4 — Public URLs need the staging domain

Anything wired to `app.kanbee.io` or other custom domains in prod needs to use `*.up.railway.app` in staging. The `${{<service>.RAILWAY_PUBLIC_DOMAIN}}` template var resolves per-environment and gives you the right staging URL automatically.

| Variable | Prod value | Staging override |
|---|---|---|
| `FRONT_URL` (on backends that need it) | `https://app.kanbee.io` | `https://${{front.RAILWAY_PUBLIC_DOMAIN}}` |
| `ACCOUNTS_URL` (on front) | whatever points at prod account | `https://${{account.RAILWAY_PUBLIC_DOMAIN}}` |
| `TRANSACTOR_URL` (on account) | `ws://transactor.railway.internal:3333;wss://transactor.kanbee.io` (or similar) | `ws://transactor.railway.internal:3333;wss://${{transactor.RAILWAY_PUBLIC_DOMAIN}}` |
| `GMAIL_URL`, `CALENDAR_URL`, `TELEGRAM_URL`, `LOVE_ENDPOINT` | prod front domain + path | staging front domain + path (must be set to *something* — 404 at runtime = feature correctly disabled) |

What you should **not** need to touch (verify but don't change):
- `DB_URL` / `ACCOUNTS_DB_URL` referencing `postgres.railway.internal:5432` — already env-scoped.
- `FULLTEXT_DB_URL` host portion (`meilisearch.railway.internal:7700`) — env-scoped. Only the master key (Step 2) needs updating.
- `STATS_URL`, `COLLABORATOR_URL`, `REKONI_URL`, `KVS_URL` (literal `<service>.railway.internal:<port>`) — env-scoped.

### Step 5 — Reminders carried over from prod gotchas (see CLAUDE.md)

- Use literal `<service>.railway.internal:<port>` for *internal* URLs, not `${{...RAILWAY_PRIVATE_DOMAIN}}` (which flakes).
- `${{...RAILWAY_PUBLIC_DOMAIN}}` is fine and preferred for public URLs.
- `rekoni-service.railway.internal` (slug ≠ name), `hulykvs.railway.internal` (slug ≠ name).

### Step 6 — Scale everything to 0 by default

Once the env is configured but before you trigger a deploy: scale every service in the staging environment to 0 replicas. Otherwise duplication-from-prod will leave them running at 1 replica forever.

## Daily flow (per deploy)

1. CI builds new images at `:0.7.XXX` and pushes to ghcr.
2. Switch to the `staging` environment in the dashboard.
3. **Scale staging up**: `bash platform/scripts/staging-scale.sh up` (or scale each service to 1 in the dashboard).
4. Update front + transactor + workspace + fulltext tags in the `staging` env to `:0.7.XXX`. Wait ~3 min for redeploy.
5. Hit `https://<front-staging>.up.railway.app`, log in, exercise the changed feature.
6. If green: switch to `production` env and flip the same 4 tags. If red: investigate in staging without affecting users.
7. **Scale staging down**: `bash platform/scripts/staging-scale.sh down`.

## Restoring prod data into staging (optional, for migration rehearsals)

```bash
# Get latest backup
aws s3 ls s3://kanbee/backups/postgres/ --endpoint-url $R2_ENDPOINT | tail -1
# Stream-restore into staging PG (scaled up first)
aws s3 cp s3://kanbee/backups/postgres/<key> - --endpoint-url $R2_ENDPOINT \
  | gunzip \
  | psql "$STAGING_DATABASE_URL"
```

Worth doing before any migration that touches large tables — staging on empty PG won't catch a 2-minute lock.
