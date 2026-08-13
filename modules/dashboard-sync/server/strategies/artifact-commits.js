'use strict'

const { registerStrategy } = require('./index')
const { fetchFileAtRef } = require('../gitlab-fetcher')

function parseKeyValue(content, key) {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(`${key}=`)) {
      return trimmed.split('=')[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  return null
}

async function extractVersionFromGitFile({ commitSha, repository, token, baseUrl, versionCache }) {
  if (versionCache.has(commitSha)) return versionCache.get(commitSha)

  if (!repository || !repository.gitlab_project_id || !repository.product_version_file || !repository.product_version_key) {
    versionCache.set(commitSha, null)
    return null
  }

  const filePaths = [repository.product_version_file]
  if (repository.product_version_file.includes('-')) {
    filePaths.push(repository.product_version_file.replace(/-/g, '.'))
  }

  for (const filePath of filePaths) {
    try {
      const content = await fetchFileAtRef({
        token,
        projectId: repository.gitlab_project_id,
        filePath,
        ref: commitSha,
        baseUrl,
      })
      const version = parseKeyValue(content, repository.product_version_key)
      if (version) {
        versionCache.set(commitSha, version)
        return version
      }
    } catch {
      // file not found at this commit, try next
    }
  }

  versionCache.set(commitSha, null)
  return null
}

async function collectDrops({ productKey, repositories, existingDropNames, token, config, db }) {
  const baseUrl = config.baseUrl
  console.log(`[dashboard-sync] Using ArtifactCommitsStrategy for product '${productKey}'`)

  if (!db) {
    console.warn('[dashboard-sync] artifact-commits strategy requires db access for artifact queries')
    return { drops: [], repositoryTagsMap: {} }
  }

  const artifactsCol = db.getCollection('artifacts')
  const artifacts = await artifactsCol.find({
    product_key: productKey,
    commit: { $ne: 'unknown', $exists: true },
  }).toArray()

  console.log(`[dashboard-sync] Found ${artifacts.length} artifacts with known commits for '${productKey}'`)

  const byCommit = {}
  for (const a of artifacts) {
    if (a.commit && a.commit !== 'unknown') {
      if (!byCommit[a.commit]) byCommit[a.commit] = []
      byCommit[a.commit].push(a)
    }
  }

  const primaryRepo = repositories.find(r =>
    r.gitlab_project_id && r.product_version_file
  ) || null

  const versionCache = new Map()
  const allDrops = []

  for (const [commitSha, commitArtifacts] of Object.entries(byCommit)) {
    const version = await extractVersionFromGitFile({
      commitSha, repository: primaryRepo, token, baseUrl, versionCache,
    })

    if (!version) continue

    const commitShort = commitSha.slice(0, 11)
    const dropName = `${version}-${commitShort}`

    if (existingDropNames.has(dropName)) continue

    const createdDates = commitArtifacts
      .filter(a => a.created_at)
      .map(a => new Date(a.created_at))
    const createdAt = createdDates.length ? new Date(Math.min(...createdDates)) : new Date()

    allDrops.push({
      key: `${productKey}-${dropName}`,
      name: dropName,
      product_key: productKey,
      product_version: version,
      created_at: createdAt,
    })
  }

  console.log(`[dashboard-sync] ArtifactCommitsStrategy collected ${allDrops.length} drops for '${productKey}' (cached ${versionCache.size} lookups)`)
  return { drops: allDrops, repositoryTagsMap: {} }
}

function matches(artifact, drop) {
  if (!artifact.labels) return false
  const vcsRef = artifact.labels['vcs-ref']
  if (!vcsRef) return false
  if (!drop.name.includes('-')) return false
  const commitShort = drop.name.split('-').pop()
  return vcsRef.startsWith(commitShort)
}

registerStrategy('artifact-commits', { collectDrops, matches })

module.exports = { collectDrops, matches }
