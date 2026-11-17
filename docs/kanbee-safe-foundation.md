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
  - `ghcr.io/pinapple-org/kanbee-account:0.7.413` (Huly account service plus the security backports below; rolled out by hand, see "Account Service")

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
node common/scripts/install-run-rush.js bundle --to @hcengineering/pod-server --to @hcengineering/pod-workspace --to @hcengineering/pod-fulltext --to @hcengineering/pod-front --to @hcengineering/pod-account
```

5. Re-check the account security backports listed under "Account Service": drop each one the new upstream base already contains, and keep the rest.

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

The workflow also builds and pushes `kanbee-account` from the same commit, but `deploy_to_railway` does not touch the account service. See "Account Service".

## Account Service

Upstream Huly only patches its latest release, so the pinned `0.7.413` base keeps account vulnerabilities that upstream fixed later. `kanbee-account` carries these upstream fixes as cherry-picks (`git cherry-pick -x`, so each commit names its source):

| Upstream PR | Fix | First upstream tags that contain it |
|---|---|---|
| hcengineering/platform#10869 | `checkJoin` throws Forbidden for non-members | `s0.7.424`, `v0.7.426` |
| hcengineering/platform#10861 | `signUpJoin` requires email confirmation when `MAIL_URL` is set | `s0.7.424`, `v0.7.426` |
| hcengineering/platform#10997 | `mergeSpecifiedPersons` / `canMergeSpecifiedPersons` check authority (account takeover, hcengineering/platform#10914) | `s0.7.437` (no `v` tag yet) |
| hcengineering/platform#11067 | `hasWorkspacePermission` no longer returns true for missing grants | `develop` only |
| hcengineering/platform#11095 | `getMailboxSecret` enforces the `huly-mail` service check (hcengineering/platform#10862) | `develop` only |

Apart from these backports, `server/account`, `server/account-service` and `pods/account` match upstream `s0.7.413` and `s0.7.418` (upstream made no account changes between those tags), except for Kanbee branding in the email templates and the 2FA app name. The account service does not use the platform queue, so the `pgqueue` routing does not affect it.

Front-end companion fix (Kanbee-owned, not upstream): with `MAIL_URL` set, hcengineering/platform#10861 makes `signUpJoin` answer without a token until the email is confirmed, and upstream's invite page did not handle that (it called `logIn()`, which fails with 401). `plugins/login-resources/src/components/Join.svelte` now sends such answers to the "confirmation sent" page, like `SignupForm.svelte` already does; the confirmation link then finishes the workspace join. This fix ships in the `kanbee-front` image.

Not backported yet: hcengineering/platform#10874 (`getAccountInfo` returned another account's timezone, locale and 2FA flag to any caller, fixed in `s0.7.437`). It also changes the contact model and front, so it has to ride on a full four-image deploy; pick it up with the next upstream upgrade or as its own backport.

The account service owns the accounts database (users, workspaces, invites, social ids), so it is switched by hand, never by `deploy_to_railway`:

1. Back up the accounts database (`DB_URL` of the account service) and confirm the backup restores.
2. After the first workflow run that pushes `kanbee-account`, make the GHCR package readable by Railway the same way as the other `kanbee-*` packages (they are public), or add registry credentials to the account service. A new GHCR package starts private.
3. If the account service has `MAIL_URL` set, deploy the four custom images from the same commit first (they carry the `Join.svelte` fix), otherwise invited sign-ups stall after submitting the form. Without `MAIL_URL` the account image can go alone.
4. In staging, set the account service `source.image` to `ghcr.io/pinapple-org/kanbee-account:<version>-<sha>` (the immutable tag from the workflow summary).
5. Smoke test staging: login, workspace selection, invite join for a new and for an existing user, password recovery email, and `select count(*) from global_account._account_applied_migrations` unchanged.
6. Repeat in production. To roll back, set the image back to the previous one: the backports add no database migrations.

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
