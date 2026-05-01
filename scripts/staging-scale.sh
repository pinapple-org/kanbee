#!/usr/bin/env bash
# Scale all kanbee-staging services up (1 replica) or down (0 replicas).
#
# Uses Railway's GraphQL API because the `railway` CLI doesn't expose a
# replica-scaling command. If this script breaks (Railway API changes),
# the fallback is the dashboard: each service → Settings → Replicas → 0 or 1.
#
# Usage:
#   ./staging-scale.sh up      # scale all services to 1
#   ./staging-scale.sh down    # scale all services to 0
#   ./staging-scale.sh status  # show current replica counts
#
# One-time setup (put in ~/.kanbee-staging.env, then `source` it before running):
#   export RAILWAY_TOKEN=...                    # https://railway.app/account/tokens
#   export STAGING_ENVIRONMENT_ID=...           # `railway status` in linked project
#   export STAGING_SERVICE_IDS="id1 id2 id3..." # space-separated, all 12 services
#
# To discover service IDs after linking the staging project:
#   railway link    # pick kanbee-staging
#   railway status --json | jq -r '.services[].id'

set -euo pipefail

ACTION="${1:-}"
case "$ACTION" in
  up)     REPLICAS=1 ;;
  down)   REPLICAS=0 ;;
  status) REPLICAS=- ;;
  *)
    echo "Usage: $0 {up|down|status}" >&2
    exit 1
    ;;
esac

: "${RAILWAY_TOKEN:?RAILWAY_TOKEN required (see header for setup)}"
: "${STAGING_ENVIRONMENT_ID:?STAGING_ENVIRONMENT_ID required}"
: "${STAGING_SERVICE_IDS:?STAGING_SERVICE_IDS required}"

API="https://backboard.railway.com/graphql/v2"

gql() {
  curl -fsS -X POST "$API" \
    -H "Authorization: Bearer ${RAILWAY_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$1"
}

scale_service() {
  local service_id="$1"
  local replicas="$2"
  local payload
  payload=$(jq -nc \
    --arg sid "$service_id" \
    --arg eid "$STAGING_ENVIRONMENT_ID" \
    --argjson n "$replicas" \
    '{query: "mutation($sid: String!, $eid: String!, $n: Int!) { serviceInstanceUpdate(serviceId: $sid, environmentId: $eid, input: { numReplicas: $n }) }",
      variables: {sid: $sid, eid: $eid, n: $n}}')
  gql "$payload" > /dev/null
  echo "  $service_id → $replicas"
}

status_service() {
  local service_id="$1"
  local payload
  payload=$(jq -nc \
    --arg sid "$service_id" \
    --arg eid "$STAGING_ENVIRONMENT_ID" \
    '{query: "query($sid: String!, $eid: String!) { serviceInstance(serviceId: $sid, environmentId: $eid) { numReplicas latestDeployment { status } } }",
      variables: {sid: $sid, eid: $eid}}')
  local result
  result=$(gql "$payload")
  local n; n=$(echo "$result" | jq -r '.data.serviceInstance.numReplicas // "?"')
  local s; s=$(echo "$result" | jq -r '.data.serviceInstance.latestDeployment.status // "-"')
  printf "  %-40s replicas=%s  status=%s\n" "$service_id" "$n" "$s"
}

echo "==> Action: $ACTION"
for sid in $STAGING_SERVICE_IDS; do
  if [ "$ACTION" = "status" ]; then
    status_service "$sid"
  else
    scale_service "$sid" "$REPLICAS"
  fi
done

if [ "$ACTION" = "up" ]; then
  echo "==> Scaled up. Wait ~2-3 min for services to become healthy, then deploy your tag."
elif [ "$ACTION" = "down" ]; then
  echo "==> Scaled down. Storage volumes persist; data survives next 'up'."
fi
