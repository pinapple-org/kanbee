#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const failures = []
const warnings = []

const services = {
  transactor: 'RAILWAY_TRANSACTOR_SERVICE_ID',
  workspace: 'RAILWAY_WORKSPACE_SERVICE_ID',
  fulltext: 'RAILWAY_FULLTEXT_SERVICE_ID',
  front: 'RAILWAY_FRONT_SERVICE_ID'
}

function read (relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

function cleanVersion (value) {
  return value.trim().replace(/^"/, '').replace(/"$/, '')
}

function check (condition, message) {
  if (!condition) failures.push(message)
}

function warn (condition, message) {
  if (!condition) warnings.push(message)
}

function expectedImage (service, version) {
  return `ghcr.io/pinapple-org/kanbee-${service}:${version}`
}

async function fetchRailwayImage (serviceId, environmentId, token) {
  const query = `
    query KanbeeServiceInstance($serviceId: String!, $environmentId: String!) {
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
        source {
          image
        }
      }
    }
  `
  const response = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      variables: { serviceId, environmentId }
    })
  })

  const payload = await response.json()
  if (!response.ok || payload.errors != null) {
    throw new Error(JSON.stringify(payload.errors ?? payload))
  }
  return payload.data?.serviceInstance?.source?.image
}

const version = cleanVersion(read('common/scripts/version.txt'))
const expectedVersion = process.env.KANBEE_EXPECTED_VERSION

check(version.length > 0, 'common/scripts/version.txt is empty')
check(expectedVersion == null || expectedVersion === version, `version.txt is ${version}, expected ${expectedVersion}`)
check(read('common/scripts/show_version.js').includes('version.txt'), 'show_version.js must read common/scripts/version.txt')
check(read('common/scripts/show_tag.js').includes('version.txt'), 'show_tag.js must prefer common/scripts/version.txt')

const frontDockerfile = read('.github/docker/Dockerfile.kanbee-front')
check(frontDockerfile.includes('COPY branding/kanbee/branding.json'), 'Kanbee front Dockerfile must copy branding.json from platform/branding/kanbee')
check(frontDockerfile.includes('COPY branding/kanbee/kanbee/'), 'Kanbee front Dockerfile must copy app assets from platform/branding/kanbee')
check(!frontDockerfile.includes('common/temp/kanbee-deploy'), 'Kanbee front Dockerfile still references the old kanbee-deploy checkout')

for (const asset of [
  'branding/kanbee/branding.json',
  'branding/kanbee/kanbee/favicon.svg',
  'branding/kanbee/kanbee/site.webmanifest',
  'branding/kanbee/kanbee/apple-touch-icon.png',
  'branding/kanbee/kanbee/icon-192.png',
  'branding/kanbee/kanbee/icon-512.png'
]) {
  check(existsSync(resolve(root, asset)), `Missing branding asset ${asset}`)
}

const workflow = read('.github/workflows/kanbee-images.yml')
check(!workflow.includes('kanbee-deploy'), 'Kanbee image workflow still checks out kanbee-deploy')
check(workflow.includes('deploy_to_railway'), 'Kanbee image workflow is missing the manual Railway deploy input')
for (const service of Object.keys(services)) {
  check(
    workflow.includes(`ghcr.io/pinapple-org/kanbee-${service}:`) &&
      workflow.includes('steps.version.outputs.version'),
    `Kanbee image workflow does not tag ${service} from version.txt`
  )
}

const frontPackage = JSON.parse(read('pods/front/package.json'))
const serverPackage = JSON.parse(read('pods/server/package.json'))
check(frontPackage.scripts.bundle.includes('--define=MODEL_VERSION'), 'front bundle must define MODEL_VERSION')
check(frontPackage.scripts.bundle.includes('--define=VERSION'), 'front bundle must define VERSION')
check(serverPackage.scripts.bundle.includes('--define=MODEL_VERSION'), 'transactor bundle must define MODEL_VERSION')
check(serverPackage.scripts.bundle.includes('--define=VERSION'), 'transactor bundle must define VERSION')

const selfhostComposePath = resolve(root, '../huly-selfhost/compose.override.yml')
const selfhostTemplatePath = resolve(root, '../huly-selfhost/.template.huly.conf')
const selfhostCurrentConfigPath = resolve(root, '../huly-selfhost/huly_v7.conf')
const upstreamVersion = `v${version}`
if (existsSync(selfhostComposePath)) {
  const compose = readFileSync(selfhostComposePath, 'utf8')
  for (const service of Object.keys(services)) {
    check(compose.includes(`image: ${expectedImage(service, version)}`), `compose.override.yml does not pin ${service} to ${version}`)
  }
  check(compose.includes('../platform/branding/kanbee/branding.json'), 'compose.override.yml must mount platform/branding/kanbee/branding.json')
  check(compose.includes('../platform/branding/kanbee/kanbee'), 'compose.override.yml must mount platform/branding/kanbee/kanbee')
  check(compose.includes('DISABLE_SIGNUP=true'), 'compose.override.yml must set DISABLE_SIGNUP=true')
} else {
  warnings.push('Skipping huly-selfhost compose checks because ../huly-selfhost/compose.override.yml is not present')
}

if (existsSync(selfhostTemplatePath)) {
  const template = readFileSync(selfhostTemplatePath, 'utf8')
  check(template.includes(`HULY_VERSION=${upstreamVersion}`), `.template.huly.conf must pin upstream images to ${upstreamVersion}`)
  check(template.includes(`DESKTOP_CHANNEL=${version}`), `.template.huly.conf must set DESKTOP_CHANNEL=${version}`)
}

if (existsSync(selfhostCurrentConfigPath)) {
  const currentConfig = readFileSync(selfhostCurrentConfigPath, 'utf8')
  check(currentConfig.includes(`HULY_VERSION=${upstreamVersion}`), `huly_v7.conf must pin upstream images to ${upstreamVersion}`)
  check(currentConfig.includes(`DESKTOP_CHANNEL=${version}`), `huly_v7.conf must set DESKTOP_CHANNEL=${version}`)
}

if (process.env.KANBEE_CHECK_RAILWAY === 'true') {
  const railwayToken = process.env.RAILWAY_TOKEN
  const railwayEnvironmentId = process.env.RAILWAY_ENVIRONMENT_ID
  check(railwayToken != null && railwayToken !== '', 'KANBEE_CHECK_RAILWAY requires RAILWAY_TOKEN')
  check(railwayEnvironmentId != null && railwayEnvironmentId !== '', 'KANBEE_CHECK_RAILWAY requires RAILWAY_ENVIRONMENT_ID')

  // KANBEE_DEPLOY_TAG (e.g. "0.7.413-abc1234") is set by the CI deploy step
  // so this audit can validate Railway is pinned to the immutable per-commit
  // tag, not just the movable :version one. Falls back to bare version for
  // manual / pre-SHA-tag invocations.
  const deployTag = process.env.KANBEE_DEPLOY_TAG?.trim()
  const expectedRailwayTag = deployTag != null && deployTag !== '' ? deployTag : version

  if (railwayToken != null && railwayEnvironmentId != null) {
    for (const [service, envName] of Object.entries(services)) {
      const serviceId = process.env[envName]
      check(serviceId != null && serviceId !== '', `KANBEE_CHECK_RAILWAY requires ${envName}`)
      if (serviceId == null || serviceId === '') continue

      try {
        const image = await fetchRailwayImage(serviceId, railwayEnvironmentId, railwayToken)
        check(image === expectedImage(service, expectedRailwayTag), `Railway ${service} image is ${image ?? '<unset>'}, expected ${expectedImage(service, expectedRailwayTag)}`)
      } catch (err) {
        failures.push(`Unable to fetch Railway ${service} source image: ${err.message}`)
      }
    }
  }
} else {
  warnings.push('Skipping live Railway target checks; set KANBEE_CHECK_RAILWAY=true with Railway token, environment id, and service ids to enable them')
}

for (const message of warnings) {
  console.warn(`WARN ${message}`)
}

if (failures.length > 0) {
  for (const message of failures) {
    console.error(`FAIL ${message}`)
  }
  process.exit(1)
}

console.log(`OK Kanbee release audit passed for ${version}`)
