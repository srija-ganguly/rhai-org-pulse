'use strict'

const { Readable } = require('stream')
const zlib = require('zlib')
const tar = require('tar')
const { gitlabApi } = require('./gitlab-fetcher')

const RELEASES_PER_PAGE = 30
const DOWNLOAD_TIMEOUT = 120_000

/**
 * Parse a requirements or constraints file from text content, line by line.
 * Strips comments and blank lines.
 *
 * @param {string} text - Raw file content
 * @returns {string[]} List of package specifications
 */
function parseRequirementsFromText(text) {
  const lines = []
  for (const raw of text.split('\n')) {
    const useful = raw.split('#')[0].trim()
    if (!useful) continue
    lines.push(useful)
  }
  return lines
}

/**
 * Canonicalize a Python package name for consistent matching.
 * PEP 503: replace runs of [-_.] with a single hyphen, then lowercase.
 *
 * @param {string} name
 * @returns {string}
 */
function canonicalizeName(name) {
  return name.replace(/[-_.]+/g, '-').toLowerCase()
}

/**
 * Parse a PEP 508 requirement string into { name, specifier }.
 * Handles simple forms like "torch==2.1.0" or "vllm>=0.3.0".
 *
 * @param {string} req
 * @returns {{ name: string, specifier: string } | null}
 */
function parseRequirement(req) {
  // Match: package_name followed by optional version specifier
  const match = req.match(/^([A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?)(.*)$/)
  if (!match) return null
  return { name: match[1], specifier: match[3].trim() }
}

/**
 * Merge requirements with their versions from constraints.
 * requirements.txt has the packages users care about.
 * constraints.txt has ALL packages with exact versions.
 *
 * @param {string[]} requirements
 * @param {string[]} constraints
 * @returns {string[]}
 */
function mergeRequirementsWithConstraints(requirements, constraints) {
  // Build a mapping of canonicalized package name to version specifier
  const constraintsMap = new Map()
  for (const constraint of constraints) {
    const parsed = parseRequirement(constraint)
    if (!parsed) continue
    const canonical = canonicalizeName(parsed.name)
    constraintsMap.set(canonical, parsed.specifier)
  }

  const merged = []
  for (const req of requirements) {
    const parsed = parseRequirement(req)
    if (!parsed) continue
    const canonical = canonicalizeName(parsed.name)
    const version = constraintsMap.get(canonical)
    if (version) {
      merged.push(`${parsed.name}${version}`)
    } else {
      merged.push(req)
    }
  }
  return merged
}

/**
 * Extract architecture string from a wheels tar.gz filename.
 * Format: wheels-{version}+{suffix}-{arch}.tar.gz
 * Example: wheels-3.2.3.571+model-opt-cuda-ubi9-aarch64.tar.gz -> "aarch64"
 *
 * @param {string} filename
 * @returns {string|null}
 */
function extractArchFromFilename(filename) {
  const match = filename.match(/^wheels-.+-([a-z0-9_]+)\.tar\.gz$/)
  return match ? match[1] : null
}

/**
 * Download a tarball and extract specific files from it.
 * Uses streaming to avoid holding the entire tarball in memory at once.
 *
 * @param {string} url - Download URL
 * @param {string} token - GitLab private token
 * @returns {Promise<{ requirements: string[]|null, constraints: string[]|null, build_sequence: string|null, dependency_graph: string|null }>}
 */
async function downloadAndParseTarball(url, token) {
  const res = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': token },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Tarball download failed ${res.status}: ${body.slice(0, 200)}`)
  }

  let requirements = null
  let constraints = null
  let buildSequence = null
  let dependencyGraph = null

  // Stream the response through gunzip and tar parser
  const chunks = []
  for await (const chunk of res.body) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)

  // Decompress gzip
  const decompressed = await new Promise((resolve, reject) => {
    zlib.gunzip(buffer, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

  // Parse tar entries
  const fileContents = new Map()
  const parser = new tar.Parser()

  const parsePromise = new Promise((resolve, reject) => {
    parser.on('entry', (entry) => {
      const name = entry.path
      const isTarget =
        name.endsWith('release/inputs/requirements.txt') ||
        name.endsWith('release/outputs/constraints.txt') ||
        name.endsWith('release/outputs/build-sequence-summary.json') ||
        name.endsWith('release/outputs/graph.json')

      if (isTarget) {
        const bufs = []
        entry.on('data', (d) => bufs.push(d))
        entry.on('end', () => {
          fileContents.set(name, Buffer.concat(bufs).toString('utf8'))
        })
        entry.resume()
      } else {
        entry.resume()
      }
    })
    parser.on('end', resolve)
    parser.on('error', reject)
  })

  // Feed the decompressed data into the parser
  const readable = Readable.from([decompressed])
  readable.pipe(parser)
  await parsePromise

  // Process extracted files
  for (const [name, content] of fileContents) {
    if (name.endsWith('release/inputs/requirements.txt')) {
      requirements = parseRequirementsFromText(content)
    } else if (name.endsWith('release/outputs/constraints.txt')) {
      constraints = parseRequirementsFromText(content)
    } else if (name.endsWith('release/outputs/build-sequence-summary.json')) {
      try {
        let data = JSON.parse(content)
        if (Array.isArray(data)) {
          for (const entry of data) {
            if (entry && typeof entry === 'object') {
              delete entry.download_url
              if (entry.wheel_filename) {
                // Extract only filename from path
                const parts = entry.wheel_filename.split('/')
                entry.wheel_filename = parts[parts.length - 1]
              }
            }
          }
        }
        buildSequence = JSON.stringify(data)
      } catch {
        console.warn('[wheels-collector] Could not parse build-sequence-summary.json')
      }
    } else if (name.endsWith('release/outputs/graph.json')) {
      try {
        JSON.parse(content) // validate
        dependencyGraph = content
      } catch {
        console.warn('[wheels-collector] Could not parse graph.json')
      }
    }
  }

  return { requirements, constraints, build_sequence: buildSequence, dependency_graph: dependencyGraph }
}

/**
 * Process a single wheels asset (tar.gz) from a release.
 * Downloads the tarball, parses files, and returns artifact + drop objects.
 *
 * @param {object} params
 * @param {string} params.assetName - tar.gz filename
 * @param {string} params.assetUrl - Download URL
 * @param {string} params.releaseTag - Git release tag
 * @param {Date} params.releaseCreatedAt - Release creation timestamp
 * @param {string} params.commitSha - Git commit SHA
 * @param {string} params.productKey - Product key
 * @param {Set<string>} params.existingArtifactKeys - Keys already in DB
 * @param {string} params.token - GitLab private token
 * @returns {Promise<{ artifact: object, drop: object }|null>}
 */
async function processWheelsAsset({
  assetName,
  assetUrl,
  releaseTag,
  releaseCreatedAt,
  commitSha,
  productKey,
  existingArtifactKeys,
  token,
}) {
  // Extract architecture from filename
  const archStr = extractArchFromFilename(assetName)
  if (!archStr) {
    console.warn(`[wheels-collector] Could not extract architecture from filename: ${assetName}`)
    return null
  }

  // Strip 'v' prefix from release tag if present
  const tagWithoutV = releaseTag.replace(/^v/, '')

  // Extract the suffix from release tag (contains build config info and variant)
  if (!tagWithoutV.includes('+')) {
    console.error(`[wheels-collector] Release tag '${releaseTag}' does not contain suffix (no '+' found), skipping`)
    return null
  }
  const releaseSuffix = tagWithoutV.split('+').slice(1).join('+')

  // Build artifact key early to check if it already exists
  const artifactKey = tagWithoutV.endsWith(`-${archStr}`)
    ? tagWithoutV
    : `${tagWithoutV}-${archStr}`

  if (existingArtifactKeys && existingArtifactKeys.has(artifactKey)) {
    console.log(`[wheels-collector] Artifact '${artifactKey}' already exists, skipping download`)
    return null
  }

  console.log(`[wheels-collector] Processing wheels asset: ${assetName}`)

  // Download and parse the tarball
  const parsed = await downloadAndParseTarball(assetUrl, token)

  // Merge requirements with constraints
  let mainPackages = []
  if (parsed.requirements && parsed.constraints) {
    mainPackages = mergeRequirementsWithConstraints(parsed.requirements, parsed.constraints)
  } else if (parsed.requirements) {
    mainPackages = parsed.requirements
    console.log(`[wheels-collector] No constraints.txt found in ${assetName}, using requirements as-is`)
  } else {
    console.log(`[wheels-collector] No requirements.txt found in ${assetName}`)
  }

  // Build constraints JSON with structured data for UI
  const constraintsData = { main: mainPackages, all: parsed.constraints || [] }
  const constraintsJson = JSON.stringify(constraintsData)

  // Create drop name and key
  const dropName = artifactKey
  const dropKey = `${productKey}-${dropName}`

  // Extract product version (major.minor) from tag
  const versionPart = tagWithoutV.split('+')[0]
  const versionComponents = versionPart.split('.')
  let productVersion = null
  let series = null
  if (versionComponents.length >= 2) {
    productVersion = `${versionComponents[0]}.${versionComponents[1]}`
    series = productVersion
  }

  // Extract package names from dependency graph for indexed search
  let packageNames = []
  if (parsed.dependency_graph) {
    try {
      const graphData = JSON.parse(parsed.dependency_graph)
      packageNames = Object.values(graphData)
        .filter(data => data && data.canonicalized_name)
        .map(data => data.canonicalized_name.toLowerCase())
      packageNames = [...new Set(packageNames)].sort()
    } catch {
      console.warn('[wheels-collector] Could not parse dependency_graph for package extraction')
    }
  }

  // Normalize variant from release suffix
  const variant = releaseSuffix || null
  // Extract raw variant from artifact key (portion after version+)
  const rawVariant = artifactKey.includes('+') ? artifactKey.split('+').slice(1).join('+') : null

  const artifact = {
    key: artifactKey,
    archs: [archStr],
    commit: commitSha,
    created_at: releaseCreatedAt,
    environments: [],
    product_key: productKey,
    type: 'wheels-collection',
    variant,
    raw_variant: rawVariant,
    constraints_file: constraintsJson,
    build_sequence_summary: parsed.build_sequence || null,
    dependency_graph: parsed.dependency_graph || null,
    package_names: packageNames,
    series,
    drop_keys: [dropKey],
  }

  const drop = {
    key: dropKey,
    name: dropName,
    product_key: productKey,
    product_version: productVersion,
    created_at: releaseCreatedAt,
  }

  console.log(`[wheels-collector] Parsed artifact '${artifactKey}' and drop '${dropKey}'`)
  return { artifact, drop }
}

/**
 * Fetch one page of releases from the GitLab releases API.
 *
 * @param {object} params
 * @param {number} params.projectId - GitLab project ID
 * @param {string} params.token - GitLab private token
 * @param {string} params.baseUrl - GitLab base URL
 * @param {number} params.page - Page number (1-indexed)
 * @param {number} params.perPage - Releases per page
 * @param {Date|null} params.newerThan - Only return releases newer than this
 * @returns {Promise<{ releases: object[], hasMore: boolean }>}
 */
async function fetchReleases({ projectId, token, baseUrl, page, perPage, newerThan }) {
  const path = `/projects/${projectId}/releases?page=${page}&per_page=${perPage}`
  const releases = await gitlabApi(path, token, baseUrl)

  const hasMore = releases.length === perPage

  if (newerThan) {
    const filtered = releases.filter((release) => {
      try {
        const createdAt = new Date(release.created_at)
        return createdAt > newerThan
      } catch {
        return false
      }
    })
    return { releases: filtered, hasMore }
  }

  return { releases, hasMore }
}

/**
 * Sync wheels collection data from GitLab releases.
 *
 * Fetches releases from the GitLab repository, downloads tar.gz files,
 * extracts and parses requirements/constraints/build-sequence files,
 * and returns artifact and drop objects for the caller to persist.
 *
 * @param {object} params
 * @param {string} params.productKey - Product key
 * @param {object[]} params.repositories - Wheels-collections repositories
 * @param {Set<string>} params.existingDropNames - Drop names already in DB
 * @param {string} params.token - GitLab private token
 * @param {object} params.config - Config object with baseUrl
 * @returns {Promise<{ artifacts: object[], drops: object[] }>}
 */
async function syncWheels({ productKey, repositories, existingDropNames, token, config }) {
  const baseUrl = config.baseUrl

  const wheelsRepos = repositories.filter(r => r.type === 'wheels-collections')
  if (!wheelsRepos.length) {
    console.warn(`[wheels-collector] No wheels-collections repositories found for product '${productKey}'`)
    return { artifacts: [], drops: [] }
  }

  const allArtifacts = []
  const allDrops = []

  for (const repository of wheelsRepos) {
    if (!repository.gitlab_project_id) {
      console.error(`[wheels-collector] Repository '${repository.key}' has no gitlab_project_id`)
      continue
    }

    console.log(`[wheels-collector] Starting wheels collection from repository '${repository.key}' for product '${productKey}'`)

    // Build set of existing artifact keys for skip-check
    const existingArtifactKeys = existingDropNames || new Set()

    let page = 1
    let totalArtifacts = 0

    while (true) {
      console.log(`[wheels-collector] Fetching page ${page} of releases for repository '${repository.key}'`)

      let fetchResult
      try {
        fetchResult = await fetchReleases({
          projectId: repository.gitlab_project_id,
          token,
          baseUrl,
          page,
          perPage: RELEASES_PER_PAGE,
          newerThan: null,
        })
      } catch (err) {
        console.error(`[wheels-collector] Failed to fetch page ${page} from repository '${repository.key}': ${err.message}`)
        break
      }

      const { releases, hasMore } = fetchResult

      if (!releases.length) {
        if (page === 1) {
          console.log(`[wheels-collector] No releases found for repository '${repository.key}'`)
        }
        break
      }

      console.log(`[wheels-collector] Processing ${releases.length} releases from page ${page}`)

      for (const release of releases) {
        const releaseTag = release.tag_name
        const createdAt = new Date(release.created_at)
        const commitSha = (release.commit && release.commit.id) || ''

        if (!commitSha) {
          console.warn(`[wheels-collector] No commit SHA found for release ${release.name}`)
          continue
        }

        // Process each asset link in the release
        const assetLinks = (release.assets && release.assets.links) || []
        for (const asset of assetLinks) {
          const assetName = asset.name || ''
          const assetUrl = asset.url || ''

          // Only process wheels tar.gz files
          if (!assetName.startsWith('wheels-') || !assetName.endsWith('.tar.gz')) {
            continue
          }

          try {
            const result = await processWheelsAsset({
              assetName,
              assetUrl,
              releaseTag,
              releaseCreatedAt: createdAt,
              commitSha,
              productKey,
              existingArtifactKeys,
              token,
            })

            if (result) {
              result.artifact.git_repository = { key: repository.key }
              allArtifacts.push(result.artifact)
              allDrops.push(result.drop)
              totalArtifacts++
            }
          } catch (err) {
            console.error(`[wheels-collector] Failed to process asset ${assetName}: ${err.message}`)
          }
        }
      }

      console.log(`[wheels-collector] Page ${page} completed. Running total: ${totalArtifacts} artifacts`)

      if (!hasMore) break
      page++
    }

    console.log(
      `[wheels-collector] Wheels collection completed for repository '${repository.key}': ` +
      `${allArtifacts.length} artifacts, ${allDrops.length} drops`
    )
  }

  return { artifacts: allArtifacts, drops: allDrops }
}

module.exports = {
  syncWheels,
  // Exported for testing
  parseRequirementsFromText,
  mergeRequirementsWithConstraints,
  extractArchFromFilename,
  canonicalizeName,
}
