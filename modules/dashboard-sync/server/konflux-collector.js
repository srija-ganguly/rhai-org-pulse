'use strict'

const { KonfluxClient } = require('./clients/konflux-client')

const BATCH_SIZE = 20
const BATCH_SLEEP_MS = 1000
const DAYS_LOOKBACK = 90

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function deriveSourceBranch(componentName) {
  const match = componentName.match(/-(\d+-\d+(?:-[a-zA-Z0-9]+)?)$/)
  if (!match) return 'main'
  return match[1].replace(/-/g, '.').replace(/\.([a-zA-Z])/, '-$1').toUpperCase()
    .replace(/^(\d+\.\d+)/, (m) => m)
    .replace(/\.(\d)/, '.$1')
    .replace(/([A-Z]+)(\d)/, '$1$2')
    .toLowerCase()
    .replace(/^(\d+\.\d+)(.*)/, (_, ver, rest) => ver + rest.toUpperCase())
    || 'main'
}

async function syncKonflux({ productKey, product, secrets, db }) {
  const namespace = product.konflux_namespace
  if (!namespace) {
    console.warn(`[dashboard-sync] [Konflux] No namespace for product '${productKey}', skipping`)
    return { processed: 0, updated: 0, skipped: 0, failed: 0 }
  }

  const tokenKey = `KONFLUX_DASHBOARD_SA_${namespace.toUpperCase().replace(/-/g, '_')}`
  const token = secrets[tokenKey]
  if (!token) {
    console.warn(`[dashboard-sync] [Konflux] No token for namespace '${namespace}' (${tokenKey}), skipping`)
    return { processed: 0, updated: 0, skipped: 0, failed: 0 }
  }

  const client = new KonfluxClient({ namespace, token })
  const artifactsCol = db.getCollection('artifacts')

  console.log(`[dashboard-sync] [Konflux] Starting for product '${productKey}' in namespace '${namespace}'`)

  const since = new Date(Date.now() - DAYS_LOOKBACK * 24 * 60 * 60 * 1000)
  let releases
  try {
    releases = await client.listReleases({ since })
  } catch (err) {
    console.error(`[dashboard-sync] [Konflux] Failed to fetch releases: ${err.message}`)
    return { processed: 0, updated: 0, skipped: 0, failed: 0 }
  }

  const releasesBySnapshot = {}
  for (const rel of releases) {
    if (!rel.snapshot) continue
    if (!releasesBySnapshot[rel.snapshot]) releasesBySnapshot[rel.snapshot] = []
    releasesBySnapshot[rel.snapshot].push({
      name: rel.name,
      environment: rel.environment,
      state: rel.state,
      released_at: rel.released_at,
      url: rel.url,
    })
  }
  console.log(`[dashboard-sync] [Konflux] Indexed ${releases.length} releases across ${Object.keys(releasesBySnapshot).length} snapshots`)

  let processed = 0, updated = 0, skipped = 0, failed = 0

  const cursor = artifactsCol.find({
    product_key: productKey,
    type: 'containers',
    commit: { $exists: true, $ne: 'unknown' },
    created_at: { $gte: since },
  }).batchSize(BATCH_SIZE)

  const commitGroups = {}
  for await (const artifact of cursor) {
    if (!artifact.commit) continue
    if (!commitGroups[artifact.commit]) commitGroups[artifact.commit] = []
    commitGroups[artifact.commit].push(artifact)
  }

  for (const [commitSha, artifacts] of Object.entries(commitGroups)) {
    const ops = []
    try {
      const snapshots = await client.listSnapshots({ commitSha })

      for (const artifact of artifacts) {
        processed++
        let snapshotName = artifact.konflux_data?.snapshot_name

        if (!snapshotName && artifact.sha_digest) {
          const matched = snapshots.find(s =>
            s.components.some(c => c.container_image && c.container_image.includes(artifact.sha_digest))
          )
          if (matched) snapshotName = matched.name
        }

        if (!snapshotName) {
          skipped++
          continue
        }

        const snapshotReleases = releasesBySnapshot[snapshotName] || []
        const snapshot = snapshots.find(s => s.name === snapshotName)
        const testResults = snapshot ? snapshot.test_results : []

        const konfluxData = {
          snapshot_name: snapshotName,
          snapshot_url: client.snapshotUrl(snapshotName),
          releases: snapshotReleases,
          test_results: testResults,
        }

        ops.push({
          updateOne: {
            filter: { _id: artifact._id },
            update: { $set: { konflux_data: konfluxData } },
          },
        })
        updated++
      }

      if (ops.length) await artifactsCol.bulkWrite(ops)
    } catch (err) {
      console.error(`[dashboard-sync] [Konflux] Error for commit ${commitSha.slice(0, 8)}: ${err.message}`)
      failed += artifacts.length
    }

    await sleep(BATCH_SLEEP_MS)
  }

  console.log(`[dashboard-sync] [Konflux] Completed for '${productKey}': processed=${processed} updated=${updated} skipped=${skipped} failed=${failed}`)
  return { processed, updated, skipped, failed }
}

module.exports = { syncKonflux, deriveSourceBranch }
