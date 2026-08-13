'use strict'

const PYXIS_API_BASE = 'https://catalog.redhat.com/api/containers/v1'
const PYXIS_STAGE_API_BASE = 'https://catalog.stage.redhat.com/api/containers/v1'
const STAGE_REGISTRIES = ['registry.stage.redhat.io']
const PYXIS_REGISTRY_MAP = {
  'registry.redhat.io': 'registry.access.redhat.com',
  'registry.stage.redhat.io': 'registry.stage.redhat.com',
}

const TIMEOUT = 30_000
const THROTTLE_MS = 100

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

class PyxisClient {
  constructor({ maxRetries = 3, backoffFactor = 1.5 } = {}) {
    this.maxRetries = maxRetries
    this.backoffFactor = backoffFactor
  }

  _baseUrl(registry) {
    return STAGE_REGISTRIES.includes(registry) ? PYXIS_STAGE_API_BASE : PYXIS_API_BASE
  }

  async _get(url) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT),
        })
        if (res.ok) {
          await sleep(THROTTLE_MS)
          return res.json()
        }
        if (res.status === 429 || res.status >= 500) {
          const delay = Math.pow(this.backoffFactor, attempt) * 1000
          console.warn(`[pyxis] ${res.status} for ${url}, retry in ${Math.round(delay)}ms`)
          await sleep(delay)
          continue
        }
        console.warn(`[pyxis] Request failed: ${res.status} for ${url}`)
        return null
      } catch (err) {
        if (attempt < this.maxRetries) {
          const delay = Math.pow(this.backoffFactor, attempt) * 1000
          await sleep(delay)
          continue
        }
        console.error(`[pyxis] Request exception for ${url}: ${err.message}`)
        return null
      }
    }
    return null
  }

  async getImagesByTag(registry, repository, tag) {
    const base = this._baseUrl(registry)
    const pyxisRegistry = PYXIS_REGISTRY_MAP[registry] || registry
    const repoEncoded = encodeURIComponent(repository)
    const tagEncoded = encodeURIComponent(tag)
    const url = `${base}/repositories/registry/${pyxisRegistry}/repository/${repoEncoded}/tag/${tagEncoded}`
    const result = await this._get(url)
    if (!result) return []
    if (result.data) return result.data
    if (Array.isArray(result)) return result
    if (result._id) return [result]
    return []
  }

  async getVulnerabilities(imageId, registry) {
    const base = this._baseUrl(registry)
    const url = `${base}/images/id/${imageId}/vulnerabilities`
    const result = await this._get(url)
    if (!result) return []
    return result.data || []
  }
}

module.exports = { PyxisClient }
