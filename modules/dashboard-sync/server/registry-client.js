'use strict'

/**
 * Docker Registry V2 API client for fetching image tags, manifests, and configs.
 *
 * Handles authentication, token caching, retry logic, and pagination
 * across multiple container registries (quay.io, registry.redhat.io, etc.).
 *
 * Translated from: dashboard/backend/collector/core/registry_client.py
 */

const DEFAULT_TIMEOUT = 30_000 // milliseconds

// OCI architecture mapping (matches Python Architecture enum)
const OCI_ARCH_MAP = {
  amd64: 'x86_64',
  arm64: 'aarch64',
}

const KNOWN_ARCHS = new Set([
  'aarch64', 'noarch', 'ppc64le', 'unknown', 's390x', 'x86_64',
])

/**
 * Convert OCI architecture string to normalized architecture value.
 * @param {string} ociArch - Architecture string from OCI manifest
 * @returns {string} Normalized architecture string
 */
function fromOciArch(ociArch) {
  if (OCI_ARCH_MAP[ociArch]) return OCI_ARCH_MAP[ociArch]
  if (KNOWN_ARCHS.has(ociArch)) return ociArch
  return 'unknown'
}

/**
 * Parse a registry URL into registry host and repository path.
 *
 * @param {string} registryUrl - Full registry URL (e.g. "quay.io/aipcc/rhaiis/cuda-ubi9")
 * @returns {{ registryHost: string, repoPath: string }}
 */
function parseRegistryUrl(registryUrl) {
  const url = registryUrl.replace(/^https?:\/\//, '')
  const parts = url.split('/')
  if (parts.length < 2) {
    throw new Error(`Invalid registry URL format: ${registryUrl}`)
  }
  return {
    registryHost: parts[0],
    repoPath: parts.slice(1).join('/'),
  }
}

/**
 * Docker Registry V2 API client with token caching and retry logic.
 */
class RegistryClient {
  /**
   * @param {Object<string, { username: string, password: string }>} registryCredentials
   *   Map of registry host -> { username, password }
   */
  constructor(registryCredentials = {}) {
    this.registryCredentials = registryCredentials

    // Token cache: "host/repo" -> { token, expiresAt }
    // Tokens are typically valid for 5-15 minutes
    this._tokenCache = new Map()
  }

  /**
   * Clean up expired tokens from the cache.
   */
  cleanupExpiredTokens() {
    const now = Date.now()
    for (const [key, entry] of this._tokenCache) {
      if (now >= entry.expiresAt) {
        this._tokenCache.delete(key)
      }
    }
  }

  /**
   * Make an HTTP request with retry logic for server errors.
   *
   * @param {string} method - HTTP method
   * @param {string} url - Request URL
   * @param {Object} [options] - fetch options (headers, etc.)
   * @param {number} [maxRetries=3] - Maximum retry attempts
   * @returns {Promise<Response>}
   */
  async requestWithRetry(method, url, options = {}, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          ...options,
          signal: AbortSignal.timeout(options.timeout || DEFAULT_TIMEOUT),
        })

        // If 429/500/503, retry with exponential backoff
        if ([429, 500, 503].includes(res.status) && attempt < maxRetries - 1) {
          const retryAfter = res.headers.get('Retry-After')
          const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : (2 ** attempt) * 1000
          await _sleep(waitTime)
          continue
        }

        return res
      } catch (err) {
        // Connection timeout — don't retry
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          throw err
        }
        if (attempt < maxRetries - 1) {
          const waitTime = (2 ** attempt) * 1000
          await _sleep(waitTime)
          continue
        }
        throw err
      }
    }
  }

  /**
   * Get Docker Registry V2 API bearer token with caching.
   *
   * @param {string} registryHost - Registry hostname
   * @param {string} repository - Repository path
   * @param {string} [scope='pull'] - Token scope
   * @returns {Promise<string|null>} Bearer token or null
   */
  async getDockerV2Token(registryHost, repository, scope = 'pull') {
    // Check cache first
    const cacheKey = `${registryHost}/${repository}`
    const cached = this._tokenCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.token
    }
    // Remove expired entry
    if (cached) this._tokenCache.delete(cacheKey)

    // Try to get the auth challenge
    const manifestUrl = `https://${registryHost}/v2/${repository}/tags/list`

    try {
      const challengeRes = await this.requestWithRetry('HEAD', manifestUrl)

      // If 200, no auth required (public repo)
      if (challengeRes.status === 200) return null

      // Parse WWW-Authenticate header for auth endpoint
      if (challengeRes.status !== 401) return null

      const authHeader = challengeRes.headers.get('www-authenticate') || ''
      const realmMatch = authHeader.match(/realm="([^"]+)"/)
      const serviceMatch = authHeader.match(/service="([^"]+)"/)

      if (!realmMatch) return null

      const realm = realmMatch[1]
      const service = serviceMatch ? serviceMatch[1] : registryHost
      const fullScope = `repository:${repository}:${scope}`

      // Build token URL
      const tokenUrl = `${realm}?service=${encodeURIComponent(service)}&scope=${encodeURIComponent(fullScope)}`

      // Get credentials for this registry
      const creds = this.registryCredentials[registryHost]

      const fetchOpts = {
        timeout: DEFAULT_TIMEOUT,
      }

      if (creds) {
        // Basic auth
        const encoded = Buffer.from(`${creds.username}:${creds.password}`).toString('base64')
        fetchOpts.headers = { Authorization: `Basic ${encoded}` }
      }

      const tokenRes = await this.requestWithRetry('GET', tokenUrl, fetchOpts)

      if (!tokenRes.ok) {
        const body = await tokenRes.text().catch(() => '')
        console.warn(`[registry-client] Failed to get token from ${realm}: ${tokenRes.status} - ${body.slice(0, 200)}`)
        return null
      }

      const tokenData = await tokenRes.json()
      const token = tokenData.token || tokenData.access_token

      if (token) {
        // Cache with 10-minute expiration (conservative)
        this._tokenCache.set(cacheKey, {
          token,
          expiresAt: Date.now() + 10 * 60 * 1000,
        })
      }

      return token
    } catch (err) {
      console.warn(`[registry-client] Error getting Docker V2 token for ${registryHost}: ${err.message}`)
      return null
    }
  }

  /**
   * Fetch all tags for a repository using Docker Registry V2 API with pagination.
   *
   * @param {string} registryHost - Registry hostname
   * @param {string} repository - Repository path
   * @returns {Promise<string[]>} List of tag names
   */
  async getTagsFromRegistry(registryHost, repository) {
    const token = await this.getDockerV2Token(registryHost, repository)

    const allTags = []
    const pageSize = 100
    let nextUrl = `https://${registryHost}/v2/${repository}/tags/list?n=${pageSize}`
    let pageCount = 0

    try {
      while (nextUrl) {
        pageCount++
        const headers = {}
        if (token) headers.Authorization = `Bearer ${token}`

        const res = await this.requestWithRetry('GET', nextUrl, { headers })

        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`Registry API ${res.status}: ${body.slice(0, 200)}`)
        }

        const data = await res.json()
        const tags = data.tags || []
        allTags.push(...tags)

        // Check for Link header to get next page
        const linkHeader = res.headers.get('link') || ''
        if (linkHeader) {
          const linkMatch = linkHeader.match(/<([^>]+)>/)
          if (linkMatch) {
            nextUrl = linkMatch[1]
            // If relative URL, make it absolute
            if (!nextUrl.startsWith('http')) {
              nextUrl = `https://${registryHost}${nextUrl}`
            }
          } else {
            nextUrl = null
          }
        } else {
          nextUrl = null
        }
      }

      console.log(`[registry-client] Found ${allTags.length} tags across ${pageCount} page(s) in ${registryHost}/${repository}`)
      return allTags
    } catch (err) {
      const msg = `Failed to fetch tags from ${registryHost}/${repository}: ${err.message}`
      console.error(`[registry-client] ${msg}`)
      throw new Error(msg, { cause: err })
    }
  }

  /**
   * Fetch image manifest using Docker Registry V2 API.
   *
   * @param {string} registryHost - Registry hostname
   * @param {string} repository - Repository path
   * @param {string} tag - Image tag
   * @returns {Promise<{ manifest: Object, manifestDigest: string }>}
   */
  async getImageManifest(registryHost, repository, tag) {
    const token = await this.getDockerV2Token(registryHost, repository)

    const manifestUrl = `https://${registryHost}/v2/${repository}/manifests/${tag}`
    const headers = {
      Accept: [
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
      ].join(','),
    }
    if (token) headers.Authorization = `Bearer ${token}`

    try {
      const res = await this.requestWithRetry('GET', manifestUrl, { headers })

      if (res.status === 401) {
        console.warn(`[registry-client] 401 Unauthorized fetching manifest for ${repository}:${tag}`)
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[registry-client] Failed to fetch manifest for ${repository}:${tag}: ${res.status} ${body.slice(0, 200)}`)
        return { manifest: {}, manifestDigest: '' }
      }

      const manifestDigest = res.headers.get('docker-content-digest') || ''
      const manifest = await res.json()
      return { manifest, manifestDigest }
    } catch (err) {
      console.warn(`[registry-client] Failed to fetch manifest for ${repository}:${tag}: ${err.message}`)
      return { manifest: {}, manifestDigest: '' }
    }
  }

  /**
   * Fetch image config blob containing labels and metadata.
   *
   * @param {string} registryHost - Registry hostname
   * @param {string} repository - Repository path
   * @param {string} configDigest - Config blob digest
   * @returns {Promise<Object>} Config object
   */
  async getImageConfig(registryHost, repository, configDigest) {
    const token = await this.getDockerV2Token(registryHost, repository)

    const blobUrl = `https://${registryHost}/v2/${repository}/blobs/${configDigest}`
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`

    try {
      const res = await this.requestWithRetry('GET', blobUrl, { headers })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.warn(`[registry-client] Failed to fetch config blob ${configDigest} for ${repository}: ${res.status} ${body.slice(0, 200)}`)
        return {}
      }

      return await res.json()
    } catch (err) {
      console.warn(`[registry-client] Failed to fetch config blob ${configDigest} for ${repository}: ${err.message}`)
      return {}
    }
  }
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  RegistryClient,
  parseRegistryUrl,
  fromOciArch,
  OCI_ARCH_MAP,
  KNOWN_ARCHS,
}
