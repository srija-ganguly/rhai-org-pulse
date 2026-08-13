'use strict'

const { SSOClient } = require('./clients/sso-client')
const { AtlasClient, ATLAS_UI_SBOMS } = require('./clients/atlas-client')

const BATCH_SIZE = 20
const BATCH_SLEEP_MS = 1000
const INCOMPATIBLE_ENTRY = { name: '', atlas_url: '' }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function syncSbom({ db, secrets }) {
  const sso = new SSOClient({
    clientId: secrets.SSO_CLIENT_ID,
    clientSecret: secrets.SSO_CLIENT_SECRET,
  })
  const atlas = new AtlasClient({ ssoClient: sso })
  const col = db.getCollection('artifacts')

  console.log('[dashboard-sync] [SBOM] Starting SBOM link collection')

  let processed = 0, successful = 0, incompatible = 0, failed = 0

  const cursor = col.find({
    type: 'containers',
    sha_digest: { $exists: true, $ne: null },
    $or: [
      { sbom_links: { $exists: false } },
      { sbom_links: null },
      { sbom_links: { $size: 0 } },
    ],
    sbom_links: { $ne: [INCOMPATIBLE_ENTRY] },
  }).batchSize(BATCH_SIZE)

  const batch = []
  for await (const artifact of cursor) {
    batch.push(artifact)
    if (batch.length >= BATCH_SIZE) {
      const r = await _processBatch(atlas, col, batch)
      processed += r.processed; successful += r.successful
      incompatible += r.incompatible; failed += r.failed
      batch.length = 0
      await sleep(BATCH_SLEEP_MS)
    }
  }
  if (batch.length) {
    const r = await _processBatch(atlas, col, batch)
    processed += r.processed; successful += r.successful
    incompatible += r.incompatible; failed += r.failed
  }

  console.log(`[dashboard-sync] [SBOM] Completed. processed=${processed} successful=${successful} incompatible=${incompatible} failed=${failed}`)
  return { processed, successful, incompatible, failed }
}

async function _processBatch(atlas, col, batch) {
  let processed = 0, successful = 0, incompatible = 0, failed = 0
  const ops = []

  for (const artifact of batch) {
    processed++
    try {
      const result = await _processArtifact(atlas, artifact)
      if (result.status === 'successful') {
        successful++
        ops.push({ updateOne: { filter: { _id: artifact._id }, update: { $set: { sbom_links: result.links } } } })
      } else if (result.status === 'incompatible') {
        incompatible++
        ops.push({ updateOne: { filter: { _id: artifact._id }, update: { $set: { sbom_links: [INCOMPATIBLE_ENTRY] } } } })
      } else {
        failed++
      }
    } catch (err) {
      console.error(`[dashboard-sync] [SBOM] Error for ${artifact.key}: ${err.message}`)
      failed++
    }
  }

  if (ops.length) await col.bulkWrite(ops)
  return { processed, successful, incompatible, failed }
}

async function _processArtifact(atlas, artifact) {
  const topLevel = await atlas.findSboms([['document_id', '~', artifact.sha_digest]])

  if (!topLevel || !Object.keys(topLevel).length) {
    return { status: 'failed' }
  }

  if (!topLevel.items || !topLevel.items.length) {
    return { status: 'incompatible' }
  }

  const indexUuid = topLevel.items[0].id
  if (!indexUuid) return { status: 'incompatible' }

  const packages = await atlas.getSbomPackages(indexUuid)
  const items = packages.items || []
  const archPackages = items.filter(pkg => !pkg.id || !pkg.id.toLowerCase().includes('index'))

  if (!archPackages.length) return { status: 'incompatible' }

  const links = []
  for (const pkg of archPackages) {
    const resolved = await _resolveRealSbom(atlas, pkg)
    if (resolved) links.push(resolved)
  }

  if (!links.length) return { status: 'incompatible' }
  return { status: 'successful', links }
}

async function _resolveRealSbom(atlas, pkg) {
  const name = pkg.name
  const purls = pkg.purl || []
  if (purls.length !== 1) return null

  const digest = (purls[0].version || {}).version
  if (!digest) return null

  const realSbom = await atlas.findSboms([['document_id', '~', digest]])
  if (!realSbom || !realSbom.items || !realSbom.items.length) return null

  const realUuid = realSbom.items[0].id
  if (!realUuid) return null

  return { name, atlas_url: `${ATLAS_UI_SBOMS}/${realUuid}` }
}

module.exports = { syncSbom }
