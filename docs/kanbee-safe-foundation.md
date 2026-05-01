# Kanbee Safe Foundation

This fork is operated as a pinned Huly release with small Kanbee-owned overlays.
Production must not track upstream `main` directly.

## Current Pinned Base

- Product branch: `platform/main`
- Current pinned Huly-compatible version: `0.7.413`
- Source of truth for the build tag: `common/scripts/version.txt`
- Custom images:
  - `ghcr.io/pinapple-org/kanbee-front:0.7.413`
  - `ghcr.io/pinapple-org/kanbee-transactor:0.7.413`
  - `ghcr.io/pinapple-org/kanbee-workspace:0.7.413`
  - `ghcr.io/pinapple-org/kanbee-fulltext:0.7.413`

Keep `common/scripts/show_version.js`, `common/scripts/show_tag.js`, the Docker image workflow, and deployment targets aligned with `version.txt`. Run:

```bash
node scripts/kanbee-audit.mjs
```

To also check Railway service image targets, install or use Node 22 and run with:

```bash
KANBEE_CHECK_RAILWAY=true \
RAILWAY_TOKEN=... \
RAILWAY_ENVIRONMENT_ID=... \
RAILWAY_TRANSACTOR_SERVICE_ID=... \
RAILWAY_WORKSPACE_SERVICE_ID=... \
RAILWAY_FULLTEXT_SERVICE_ID=... \
RAILWAY_FRONT_SERVICE_ID=... \
node scripts/kanbee-audit.mjs
```

## Upstream Update Flow

1. Fetch upstream tags without changing the production branch:

```bash
git remote add upstream https://github.com/hcengineering/platform.git
git fetch upstream --tags
```

2. Create an explicit upgrade branch from the tested upstream tag:

```bash
git checkout -b kanbee/upgrade-v0.7.xxx v0.7.xxx
```

3. Reapply Kanbee changes in small commits:

- Additive packages stay additive: `@hcengineering/pgqueue` and `@hcengineering/meili`.
- Upstream-owned edits stay limited to dispatch hooks:
  - Kafka queue selection routes `postgres://` and `postgresql://` to `pgqueue`.
  - Fulltext selection routes `meilisearch://` and `meili://` to the Meilisearch adapter.
- Branding assets stay under `branding/kanbee`.
- Avoid broad upstream UI edits unless the token/branding layer cannot express the change.

4. Validate the upgrade branch before promoting:

```bash
node common/scripts/install-run-rush.js install
node scripts/kanbee-audit.mjs
node common/scripts/install-run-rush.js build --to @hcengineering/pgqueue --to @hcengineering/meili
node common/scripts/install-run-rush.js test --to @hcengineering/pgqueue --to @hcengineering/meili
node common/scripts/install-run-rush.js bundle --to @hcengineering/pod-server --to @hcengineering/pod-workspace --to @hcengineering/pod-fulltext --to @hcengineering/pod-front
```

For real adapter smoke tests, provide:

- `PGQUEUE_TEST_DB_URL` for Postgres.
- `MEILI_TEST_URL` for Meilisearch.

## Rebuild And Deploy

Use `.github/workflows/kanbee-images.yml` with `workflow_dispatch`.

Required image build secret:

- `GHCR_PAT`

Required only when `deploy_to_railway` is selected:

- `RAILWAY_TOKEN`
- `RAILWAY_PROJECT_ID`
- `RAILWAY_ENVIRONMENT_ID`
- `RAILWAY_TRANSACTOR_SERVICE_ID`
- `RAILWAY_WORKSPACE_SERVICE_ID`
- `RAILWAY_FULLTEXT_SERVICE_ID`
- `RAILWAY_FRONT_SERVICE_ID`

The workflow builds and pushes all four custom images from the same `version.txt` value. If deployment is enabled, it updates all four Railway service `source.image` values to that same tag in one workflow run.

Do not deploy only one of the four custom images. Front, transactor, workspace, and fulltext must move together so the model version in the browser, transactor, workspace worker, and fulltext worker remains aligned.

## Branding Source

Canonical branding assets live in:

```text
branding/kanbee/
```

The Kanbee front Dockerfile copies from that directory. Local self-host mounts the same directory from `../platform/branding/kanbee`. Do not reintroduce `huly-selfhost/kanbee-branding` or a second branding checkout in CI.

## Signup Policy

Kanbee production is invite-only.

- Set `DISABLE_SIGNUP=true` for the front service so direct signup actions are hidden by login metadata.
- Set `DISABLE_SIGNUP=true` for the account service so direct signup methods are not exposed.
- Keep `/login/join?inviteId=...` working. Invite join uses `join`, `checkJoin`, `getInviteInfo`, and `signUpJoin`; those remain enabled.
- Keep invite generation restricted through existing invite-role settings. Default allowed inviter roles should remain owner/maintainer level unless a workspace explicitly changes them.

## Production Safety Checklist

Before public customers:

- Enable Railway Postgres backups and confirm restore access.
- Document the current R2 bucket, credentials owner, and recovery contact outside the repo.
- Add uptime monitoring for `https://app.kanbee.io`.
- Keep image auto-updates disabled for the four Kanbee services; deploy only pinned tags.
- Keep the smoke-test result with the deployment record.

Meilisearch recovery:

1. Restore or recreate the Meilisearch service.
2. Confirm `FULLTEXT_DB_URL` points at the restored service.
3. Start `fulltext`.
4. Trigger a full workspace reindex with the existing server tool path for workspace reindex events.
5. Verify search on a newly created issue and an older existing issue.

Production smoke test after deploy:

- Login works for an existing user.
- Workspace loads without a front/server model-version mismatch.
- Direct signup is blocked.
- Valid invite join works for a new user.
- Issue creation works.
- Search returns the created issue.
- Attachment upload and preview use the R2-backed `STORAGE_CONFIG`.
- All four Railway services point to the same `version.txt` tag.
- Uptime monitor is green.
