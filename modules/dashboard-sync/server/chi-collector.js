'use strict'

const { PyxisClient } = require('./clients/pyxis-client')

const BATCH_SIZE = 20
const BATCH_SLEEP_MS = 1000
const RED_HAT_REGISTRIES = ['registry.redhat.io', 'registry.stage.redhat.io']

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function findRedHatImageName(artifact) {
  const names = [artifact.key, ...(artifact.alternative_names || [])]
  for (const name of names) {
    for (const registry of RED_HAT_REGISTRIES) {
      if (name.startsWith(`${registry}/`)) return name
    }
  }
  return null
}

function parseImageName(imageName) {
  let repoPart, tag
  if (imageName.includes(':')) {
    const idx = imageName.lastIndexOf(':')
    repoPart = imageName.slice(0, idx)
    tag = imageName.slice(idx + 1)
  } else {
    repoPart = imageName
    tag = ''
  }
  const slashIdx = repoPart.indexOf('/')
  const registry = slashIdx >= 0 ? repoPart.slice(0, slashIdx) : repoPart
  const repository = slashIdx >= 0 ? repoPart.slice(slashIdx + 1) : ''
  return { registry, repository, tag }
}

function extractBestGrade(images) {
  const gradeRank = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, Unknown: 6 }
  let bestGrade = 'Unknown'
  let bestDate = null

  for (const img of images) {
    const grades = img.freshness_grades || []
    if (!grades.length) continue
    const latest = grades.reduce((a, b) =>
      (a.creation_date || '') > (b.creation_date || '') ? a : b
    )
    const grade = latest.grade || 'Unknown'
    if ((gradeRank[grade] ?? 6) < (gradeRank[bestGrade] ?? 6)) {
      bestGrade = grade
      if (latest.creation_date) {
        try { bestDate = new Date(latest.creation_date) } catch { /* skip */ }
      }
    }
  }
  return { grade: bestGrade, grade_date: bestDate }
}

async function syncChi({ db }) {
  const pyxis = new PyxisClient()
  const col = db.getCollection('artifacts')

  console.log('[dashboard-sync] [CHI] Starting Container Health Index collection')

  let processed = 0, updated = 0, skipped = 0, failed = 0

  const cursor = col.find({
    type: 'containers',
    sha_digest: { $exists: true, $ne: null },
    environments: { $in: ['production', 'stage'] },
    $or: [
      { key: { $regex: '^registry\\.redhat\\.io/' } },
      { key: { $regex: '^registry\\.stage\\.redhat\\.io/' } },
      { alternative_names: { $regex: '^registry\\.redhat\\.io/' } },
      { alternative_names: { $regex: '^registry\\.stage\\.redhat\\.io/' } },
    ],
  }).batchSize(BATCH_SIZE)

  const batch = []
  for await (const artifact of cursor) {
    batch.push(artifact)
    if (batch.length >= BATCH_SIZE) {
      const result = await _processBatch(pyxis, col, batch)
      processed += result.processed
      updated += result.updated
      skipped += result.skipped
      failed += result.failed
      batch.length = 0
      await sleep(BATCH_SLEEP_MS)
    }
  }
  if (batch.length) {
    const result = await _processBatch(pyxis, col, batch)
    processed += result.processed
    updated += result.updated
    skipped += result.skipped
    failed += result.failed
  }

  console.log(`[dashboard-sync] [CHI] Completed. processed=${processed} updated=${updated} skipped=${skipped} failed=${failed}`)
  return { processed, updated, skipped, failed }
}

async function _processBatch(pyxis, col, batch) {
  let processed = 0, updated = 0, skipped = 0, failed = 0
  const ops = []

  for (const artifact of batch) {
    processed++
    const imageName = findRedHatImageName(artifact)
    if (!imageName) { skipped++; continue }

    const { registry, repository, tag } = parseImageName(imageName)
    if (!repository || !tag) { skipped++; continue }

    try {
      const images = await pyxis.getImagesByTag(registry, repository, tag)
      if (!images.length) { failed++; continue }

      const { grade, grade_date } = extractBestGrade(images)
      let vulnerability_count = 0
      const firstId = images[0]._id
      if (firstId) {
        const vulns = await pyxis.getVulnerabilities(firstId, registry)
        vulnerability_count = vulns.length
      }

      ops.push({
        updateOne: {
          filter: { _id: artifact._id },
          update: { $set: { health_index: { grade, grade_date, vulnerability_count } } },
        },
      })
      updated++
    } catch (err) {
      console.error(`[dashboard-sync] [CHI] Error for ${artifact.key}: ${err.message}`)
      failed++
    }
  }

  if (ops.length) await col.bulkWrite(ops)
  return { processed, updated, skipped, failed }
}

module.exports = { syncChi }
