'use strict'

/**
 * Sync image artifacts from container registries.
 *
 * Orchestrates the collection of container image metadata from Docker V2
 * registries, building artifact objects and filtering them.
 *
 * Translated from:
 *   dashboard/backend/collector/tasks/images.py
 *   dashboard/backend/collector/core/image_registry_collector.py
 */

const { RegistryClient, parseRegistryUrl } = require('./registry-client')
const { createArtifactFromTag } = require('./artifact-builder')
const { ArtifactFilter } = require('./artifact-filters')

// Concurrency limit for parallel manifest/config fetches
const MAX_WORKERS = 8

// Tag filter patterns (from image_registry_collector.py)

// Floating version tags: optional 'v' + single-digit groups separated by dots
// Matches v3, v3.2, v3.2.2 but NOT v25.9.0, v14.2.8
const FLOATING_PATTERN = /^v?\d(\.\d){0,2}$/

// SHA256 digest tags (64 hexadecimal characters)
const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/

/**
 * Determine if a tag should be included in artifact collection.
 *
 * Filters out:
 * - Floating tags (latest, version numbers like 3, 3.2, 3.2.2)
 * - Tags starting with sha256- or ci-
 * - SHA256 digest tags (64-character hex strings)
 * - Tags ending with -source, .sig, or .att
 * - Tags ending with special characters (-, _, ., etc.)
 *
 * @param {string} tagName
 * @returns {boolean}
 */
function shouldIncludeTag(tagName) {
  // Tags must end with alphanumeric character
  if (!tagName || !/[a-zA-Z0-9]$/.test(tagName)) return false

  if (
    tagName.startsWith('sha256-') ||
    tagName.startsWith('ci-') ||
    SHA256_DIGEST_PATTERN.test(tagName) ||
    tagName.endsWith('-source') ||
    tagName.endsWith('.sig') ||
    tagName.endsWith('.att') ||
    tagName === 'latest' ||
    FLOATING_PATTERN.test(tagName)
  ) {
    return false
  }

  return true
}

/**
 * Extract registry URLs from a repository object.
 *
 * @param {Object} repository
 * @returns {string[]}
 */
function getRegistryUrlsFromRepository(repository) {
  if (!repository.images || !repository.images.length) {
    console.warn(`[images-collector] No images configured for repository: ${repository.key}`)
    return []
  }
  return repository.images.map(img => typeof img === 'string' ? img : img.name)
}

/**
 * Run promises with concurrency limit.
 *
 * @param {Array<() => Promise<T>>} tasks - Array of functions that return promises
 * @param {number} concurrency - Max concurrent tasks
 * @returns {Promise<T[]>} Results (including nulls for failed/skipped tasks)
 * @template T
 */
async function runWithConcurrency(tasks, concurrency) {
  const results = []
  let index = 0

  async function worker() {
    while (index < tasks.length) {
      const i = index++
      try {
        results[i] = await tasks[i]()
      } catch (err) {
        results[i] = null
        console.error(`[images-collector] Task ${i} failed: ${err.message}`)
      }
    }
  }

  const workers = []
  for (let w = 0; w < Math.min(concurrency, tasks.length); w++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  return results
}

/**
 * Collect image artifacts for a product from container registries.
 *
 * For each repository's image URLs: list tags, filter, fetch manifests,
 * build artifact objects.
 *
 * @param {Object} params
 * @param {string} params.productKey - Product key
 * @param {Object[]} params.repositories - Array of repository objects (from MongoDB)
 * @param {Object} [params.secrets] - Registry credentials
 *   { quay: { username, password }, redhat: { username, password },
 *     redhatStage: { username, password }, gitlab: { token } }
 * @param {Set<string>} [params.existingArtifactKeys] - Artifact keys already in DB
 * @param {Object} [params.config] - Additional config options
 * @returns {Promise<{ artifacts: Object[], stats: Object }>}
 */
async function syncImages({ productKey, repositories, secrets, existingArtifactKeys, config: _config }) {
  const existingKeys = existingArtifactKeys || new Set()
  const containerRepos = (repositories || []).filter(r => r.type === 'containers')

  if (!containerRepos.length) {
    console.warn(`[images-collector] No container repositories found for product '${productKey}'`)
    return { artifacts: [], stats: { total: 0, filtered: 0, skipped: 0, created: 0, errors: 0 } }
  }

  // Build registry credentials map from secrets
  const registryCredentials = _buildCredentials(secrets)
  const registryClient = new RegistryClient(registryCredentials)

  const allArtifacts = []
  const stats = {
    total_tags: 0,
    filtered_tags: 0,
    artifact_filtered: 0,
    skipped_existing: 0,
    created: 0,
    errors: 0,
  }

  try {
    for (const repository of containerRepos) {
      // Initialize artifact filter for this repository
      const artifactFilter = new ArtifactFilter(repository.artifact_filters || null)
      const filterStats = artifactFilter.getStats()
      if (filterStats.exclude_patterns > 0) {
        console.log(`[images-collector] Repository '${repository.key}' has ${filterStats.exclude_patterns} exclude pattern(s)`)
      }

      const registryUrls = getRegistryUrlsFromRepository(repository)

      for (const registryUrl of registryUrls) {
        try {
          console.log(`[images-collector] Fetching images from registry: ${registryUrl}`)

          const { registryHost, repoPath } = parseRegistryUrl(registryUrl)

          // Fetch tags using Docker V2 API
          let tags
          try {
            tags = await registryClient.getTagsFromRegistry(registryHost, repoPath)
          } catch (err) {
            console.error(`[images-collector] Failed to fetch tags from ${registryUrl}: ${err.message}`)
            stats.errors++
            continue
          }

          stats.total_tags += tags.length

          // --- Pass 1: Filter (sequential, fast) ---
          const workItems = []
          let filteredCount = 0
          let artifactFilteredCount = 0
          let skippedCount = 0

          for (const tag of tags) {
            if (!tag) continue

            if (!shouldIncludeTag(tag)) {
              filteredCount++
              continue
            }

            const artifactKey = `${registryUrl}:${tag}`
            if (!artifactFilter.shouldIncludeArtifact(artifactKey)) {
              artifactFilteredCount++
              continue
            }

            if (existingKeys.has(artifactKey)) {
              skippedCount++
              continue
            }

            workItems.push({ registryHost, repoPath, registryUrl, tag, repository })
          }

          stats.filtered_tags += filteredCount
          stats.artifact_filtered += artifactFilteredCount
          stats.skipped_existing += skippedCount

          if (!workItems.length) {
            console.log(
              `[images-collector] Completed ${registryUrl}: ${tags.length} total tags, ` +
              `${filteredCount} filtered, ${artifactFilteredCount} artifact-filtered, ` +
              `${skippedCount} already in DB, 0 new`
            )
            continue
          }

          // --- Pass 2: Fetch (parallel with concurrency limit) ---
          const tasks = workItems.map(item => async () => {
            return createArtifactFromTag({
              registryClient,
              registryHost: item.registryHost,
              repository: item.repoPath,
              registryUrl: item.registryUrl,
              tag: item.tag,
              gitRepository: item.repository,
              productKey,
            })
          })

          const results = await runWithConcurrency(tasks, MAX_WORKERS)

          let processedCount = 0
          for (const artifact of results) {
            if (!artifact) continue
            allArtifacts.push(artifact)
            processedCount++
            if (processedCount % 10 === 0) {
              console.log(`[images-collector] Progress: ${processedCount} artifacts created from ${registryUrl}`)
            }
          }

          stats.created += processedCount
          stats.errors += results.filter(r => r === null).length - (workItems.length - processedCount)

          console.log(
            `[images-collector] Completed ${registryUrl}: ${tags.length} total tags, ` +
            `${filteredCount} filtered, ${artifactFilteredCount} artifact-filtered, ` +
            `${skippedCount} already in DB, ${processedCount} new artifacts created`
          )
        } catch (err) {
          console.error(`[images-collector] Failed to process ${registryUrl}: ${err.message}`)
          stats.errors++
        }
      }

      // Clean up expired tokens after each repository
      registryClient.cleanupExpiredTokens()
    }
  } catch (err) {
    console.error(`[images-collector] Unexpected error for product '${productKey}': ${err.message}`)
    stats.errors++
  }

  console.log(
    `[images-collector] Collected ${allArtifacts.length} new image artifacts ` +
    `for product '${productKey}' (skipped ${stats.skipped_existing} existing)`
  )

  return { artifacts: allArtifacts, stats }
}

/**
 * Build registry credentials map from secrets object.
 *
 * @param {Object} [secrets]
 * @returns {Object<string, { username: string, password: string }>}
 */
function _buildCredentials(secrets) {
  const creds = {}
  if (!secrets) return creds

  if (secrets.QUAY_USERNAME && secrets.QUAY_PASSWORD) {
    creds['quay.io'] = { username: secrets.QUAY_USERNAME, password: secrets.QUAY_PASSWORD }
  }

  if (secrets.REGISTRY_REDHAT_USERNAME && secrets.REGISTRY_REDHAT_PASSWORD) {
    creds['registry.redhat.io'] = { username: secrets.REGISTRY_REDHAT_USERNAME, password: secrets.REGISTRY_REDHAT_PASSWORD }
  }

  if (secrets.REGISTRY_STAGE_REDHAT_USERNAME && secrets.REGISTRY_STAGE_REDHAT_PASSWORD) {
    creds['registry.stage.redhat.io'] = { username: secrets.REGISTRY_STAGE_REDHAT_USERNAME, password: secrets.REGISTRY_STAGE_REDHAT_PASSWORD }
  }

  if (secrets.GITLAB_TOKEN) {
    creds['registry.gitlab.com'] = { username: 'oauth2', password: secrets.GITLAB_TOKEN }
  }

  return creds
}

module.exports = { syncImages, shouldIncludeTag }
