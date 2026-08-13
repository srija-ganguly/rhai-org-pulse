'use strict'

/**
 * Artifact creation and metadata extraction from container image configs.
 *
 * Extracts commit SHAs, dependencies, labels, and architectures from
 * Docker Registry V2 image config blobs.
 *
 * Translated from: dashboard/backend/collector/core/artifact_builder.py
 *                  dashboard/backend/domain/models/variant.py
 */

const { fromOciArch } = require('./registry-client')

// ---------------------------------------------------------------------------
// Variant detection (translated from variant.py)
// ---------------------------------------------------------------------------

const VARIANT_ALIASES = {
  nvidia: 'cuda',
  amd: 'rocm',
  intel: 'gaudi',
  aws: 'neuron',
}

const VARIANT_ACCELERATORS = new Set([
  'cpu', 'cuda', 'gaudi', 'neuron', 'rocm', 'rubin', 'spyre', 'tpu',
])

const VARIANT_OS_PREFIXES = ['rhel', 'el', 'ubi']
const VARIANT_ARCH_SUFFIXES = new Set(['x86-64', 'x86_64', 'aarch64', 'ppc64le', 's390x'])

/**
 * Preprocess a raw variant string: lowercase, fix version underscores,
 * remove arch suffixes, normalize hyphens.
 */
function _preprocessVariant(raw) {
  let v = raw.toLowerCase()
  // Convert version underscores -> dots (cuda12_9 -> cuda12.9)
  v = v.replace(/(\d+)_([0-9]+)/g, '$1.$2')
  // Replace remaining underscores with hyphens
  v = v.replace(/_/g, '-')

  const parts = v.split('-')
  // Drop trailing architecture suffix
  if (parts.length && VARIANT_ARCH_SUFFIXES.has(parts[parts.length - 1])) {
    parts.pop()
  }
  return parts.join('-')
}

/**
 * Extract accelerator and version from a variant string.
 * @returns {{ accelerator: string|null, version: string }}
 */
function _extractAccel(variant) {
  const parts = variant.split('-')
  const candidates = new Set([...VARIANT_ACCELERATORS, ...Object.keys(VARIANT_ALIASES)])

  for (const part of parts) {
    for (const acc of candidates) {
      if (part.startsWith(acc)) {
        const canonical = VARIANT_ALIASES[acc] || acc
        const ver = part.slice(acc.length)
        return { accelerator: canonical, version: ver }
      }
    }
  }
  return { accelerator: null, version: '' }
}

/**
 * Normalize an OS string to elX format.
 */
function _normalizeOs(osver) {
  const lower = osver.toLowerCase()
  for (const prefix of VARIANT_OS_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return 'el' + lower.slice(prefix.length)
    }
  }
  return lower
}

/**
 * Extract and normalize OS from a variant string.
 * @returns {string|null}
 */
function _extractOs(variant) {
  for (const part of variant.split('-')) {
    for (const prefix of VARIANT_OS_PREFIXES) {
      if (part.startsWith(prefix)) {
        return _normalizeOs(part)
      }
    }
  }
  return null
}

/**
 * Normalize a raw variant into canonical form: "<accelerator><version>-<os>".
 * @param {string} variant - Raw variant string
 * @returns {string} Normalized variant
 */
function normalizeVariant(variant) {
  if (!variant) return 'unknown'

  const v = _preprocessVariant(variant)
  const { accelerator, version } = _extractAccel(v)
  let osver = _extractOs(v)

  if (!accelerator) return 'unknown'
  if (!osver) osver = 'unknown'

  return `${accelerator}${version}-${osver}`
}

/**
 * Extract the raw variant segment from an image name or wheel name.
 * @param {string} name - Full artifact name
 * @returns {string|null}
 */
function extractRawVariant(name) {
  if (name.includes('/')) {
    let last = name.split('/').pop()
    last = last.split(':')[0] // drop tag suffix
    return last || null
  }
  if (name.includes('+')) {
    return name.split('+')[1]
  }
  return null
}

/**
 * Return normalized variant extracted from an artifact name.
 * @param {string} imageName
 * @returns {string}
 */
function variantFromArtifactName(imageName) {
  const raw = extractRawVariant(imageName)
  if (!raw) return 'unknown'
  return normalizeVariant(raw)
}

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/**
 * Detect environment based on registry host.
 *
 * @param {string} registryHost
 * @returns {string[]} Array of environment strings
 */
function detectEnvironment(registryHost) {
  if (registryHost === 'registry.redhat.io') return ['production']
  if (registryHost === 'registry.stage.redhat.io') return ['stage']
  if (registryHost === 'registry.gitlab.com') return []
  return ['stage'] // Default for quay.io etc.
}

// ---------------------------------------------------------------------------
// Metadata extraction from image config
// ---------------------------------------------------------------------------

/**
 * Extract commit, dependencies, labels, and architecture from image config.
 *
 * @param {Object} config - Image config blob from Docker Registry V2 API
 * @param {string[]|null} knownArchs - Architectures from manifest list (multi-arch)
 * @param {string|null} tag - Image tag (fallback arch extraction)
 * @returns {{ commit: string, dependencies: string[], labels: Object, archs: string[] }}
 */
function extractMetadataFromConfig(config, knownArchs, tag) {
  const labels = (config.config && config.config.Labels) || {}

  // Extract commit from vcs-ref or git.commit label
  const commit = labels['vcs-ref'] || labels['git.commit'] || 'unknown'

  // Extract dependencies
  const dependencies = []

  // Base image from com.redhat.aiplatform.image label
  const baseImage = labels['com.redhat.aiplatform.image']
  if (baseImage) dependencies.push(baseImage)

  // Extract architecture from config
  const ociArch = config.architecture
  let archs

  if (ociArch) {
    const archValue = fromOciArch(ociArch)
    archs = [archValue]
  } else {
    // Fallback: extract architecture from tag suffix
    let archFromTag = null
    if (tag) {
      const tagLower = tag.toLowerCase()
      if (tagLower.endsWith('-amd64') || tagLower.endsWith('-x86_64')) {
        archFromTag = 'amd64'
      } else if (tagLower.endsWith('-arm64') || tagLower.endsWith('-aarch64')) {
        archFromTag = 'aarch64'
      }
    }

    if (archFromTag) {
      const archValue = fromOciArch(archFromTag)
      archs = [archValue]
    } else {
      archs = ['unknown']
    }
  }

  // Wheel collection from com.redhat.aiplatform.wheel_release label
  const wheelRelease = labels['com.redhat.aiplatform.wheel_release']
  if (wheelRelease) {
    const wheels = wheelRelease.split(/\s+/)
    if (knownArchs && knownArchs.length) {
      // Multi-arch image: include wheels for all known architectures
      for (const arch of knownArchs) {
        const archSuffix = arch
        for (const wheel of wheels) {
          if (wheel.endsWith(`-${archSuffix}`) && !dependencies.includes(wheel)) {
            dependencies.push(wheel)
            break
          }
        }
      }
    } else if (archs && archs[0] !== 'unknown') {
      // Single-arch image: only include wheel matching this architecture
      for (const wheel of wheels) {
        if (wheel.endsWith(`-${archs[0]}`)) {
          dependencies.push(wheel)
          break
        }
      }
    }
  }

  return { commit, dependencies, labels, archs }
}

// ---------------------------------------------------------------------------
// Artifact creation from registry tag
// ---------------------------------------------------------------------------

/**
 * Create an artifact object from registry image using Docker V2 API.
 *
 * @param {Object} params
 * @param {import('./registry-client').RegistryClient} params.registryClient
 * @param {string} params.registryHost
 * @param {string} params.repository - Repository path
 * @param {string} params.registryUrl - Full registry URL
 * @param {string} params.tag - Image tag
 * @param {Object} params.gitRepository - Associated git repository document
 * @param {string} params.productKey - Product key
 * @returns {Promise<Object|null>} Artifact object or null
 */
async function createArtifactFromTag({
  registryClient,
  registryHost,
  repository,
  registryUrl,
  tag,
  gitRepository,
  productKey,
}) {
  // Fetch manifest to get config digest and manifest digest
  const { manifest, manifestDigest } = await registryClient.getImageManifest(
    registryHost, repository, tag
  )

  if (!manifest || !Object.keys(manifest).length) {
    console.warn(`[artifact-builder] No manifest found for ${repository}:${tag}, skipping`)
    return null
  }

  // Get config blob to extract labels and metadata
  let configDigest = manifest.config && manifest.config.digest
    ? manifest.config.digest
    : null

  // Check if this is a manifest list (has "manifests" array instead of "config")
  const isManifestList = !configDigest && Array.isArray(manifest.manifests) && manifest.manifests.length > 0
  let archs = []

  if (isManifestList) {
    // Extract all architectures from manifest list
    for (const manifestRef of manifest.manifests) {
      const platform = manifestRef.platform || {}
      const archName = platform.architecture || 'amd64'
      const archValue = fromOciArch(archName)
      if (!archs.includes(archValue)) archs.push(archValue)
    }

    // Fetch the first architecture's manifest for metadata extraction
    const firstRef = manifest.manifests[0]
    const archManifestDigest = firstRef.digest
    if (archManifestDigest) {
      const { manifest: archManifest } = await registryClient.getImageManifest(
        registryHost, repository, archManifestDigest
      )
      configDigest = archManifest.config && archManifest.config.digest
        ? archManifest.config.digest
        : null
    }
  }

  let config = {}
  let commit = 'unknown'
  let dependencies = []
  let labels = {}

  // Set default architecture if not obtained from manifest list
  if (!archs.length) {
    archs = ['unknown']
    // Fallback: try to extract architecture from tag suffix
    if (tag) {
      const tagLower = tag.toLowerCase()
      if (tagLower.endsWith('-amd64') || tagLower.endsWith('-x86_64')) {
        archs = [fromOciArch('amd64')]
      } else if (tagLower.endsWith('-arm64') || tagLower.endsWith('-aarch64')) {
        archs = [fromOciArch('aarch64')]
      }
    }
  }

  if (configDigest) {
    config = await registryClient.getImageConfig(registryHost, repository, configDigest)
    if (config && Object.keys(config).length) {
      const metadata = extractMetadataFromConfig(
        config,
        isManifestList ? archs : null,
        tag
      )
      commit = metadata.commit
      dependencies = metadata.dependencies
      labels = metadata.labels
      // Only use config archs if we didn't already extract from manifest list
      if (!isManifestList) archs = metadata.archs
    }
  }

  // If the image tag matches a known repository tag, use that commit
  // (handles cases where vcs-ref is inherited from a base image)
  if (gitRepository.tags && Array.isArray(gitRepository.tags)) {
    const matchingTag = gitRepository.tags.find(t => t.name === tag)
    if (matchingTag && matchingTag.commit && matchingTag.commit !== commit) {
      commit = matchingTag.commit
    }
  }

  // Get created timestamp from config
  let createdAt
  const createdStr = config.created || ''
  if (createdStr) {
    try {
      createdAt = new Date(createdStr.replace('Z', '+00:00'))
      if (isNaN(createdAt.getTime())) createdAt = new Date()
    } catch {
      createdAt = new Date()
    }
  } else {
    createdAt = new Date()
  }

  const environments = detectEnvironment(registryHost)
  const stageAt = environments.includes('stage') ? createdAt : null
  // Never pre-fill production_at with build time
  const productionAt = null

  const artifact = {
    key: `${registryUrl}:${tag}`,
    archs,
    commit,
    created_at: createdAt,
    dependencies,
    drop_keys: [],
    environments,
    git_repository: { key: gitRepository.key },
    product_key: productKey,
    sha_digest: manifestDigest,
    stage_at: stageAt,
    production_at: productionAt,
    type: gitRepository.type || 'containers',
    variant: variantFromArtifactName(registryUrl),
    raw_variant: extractRawVariant(registryUrl),
    labels: labels && Object.keys(labels).length ? labels : null,
    alternative_names: [],
  }

  return artifact
}

module.exports = {
  createArtifactFromTag,
  extractMetadataFromConfig,
  detectEnvironment,
  variantFromArtifactName,
  extractRawVariant,
  normalizeVariant,
}
