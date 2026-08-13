'use strict'

const ATLAS_BASE_HOST = 'https://atlas.build.devshift.net'
const ATLAS_API_PATH = '/api/v2'
const DEFAULT_ATLAS_API_URL = `${ATLAS_BASE_HOST}${ATLAS_API_PATH}`
const ATLAS_UI_SBOMS = `${ATLAS_BASE_HOST}/sboms`

const TIMEOUT = 30_000
const THROTTLE_MS = 250

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

class AtlasClient {
  constructor({ ssoClient, baseUrl, maxRetries = 3, backoffFactor = 1.5 } = {}) {
    this.sso = ssoClient
    this.baseUrl = (baseUrl || DEFAULT_ATLAS_API_URL).replace(/\/$/, '')
    this.maxRetries = maxRetries
    this.backoffFactor = backoffFactor
  }

  async _authHeaders() {
    const token = await this.sso.getToken()
    return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  }

  async _requestWithRetry(url) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const headers = await this._authHeaders()
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) })

        if (res.ok) {
          await sleep(THROTTLE_MS)
          return res.json()
        }
        if (res.status === 429 || res.status >= 500) {
          const delay = Math.pow(this.backoffFactor, attempt) * 1000
          console.warn(`[atlas] ${res.status} for ${url}, retry in ${Math.round(delay)}ms`)
          await sleep(delay)
          continue
        }
        console.error(`[atlas] Request failed: ${res.status} ${await res.text().catch(() => '')}`)
        return {}
      } catch (err) {
        if (attempt < this.maxRetries) {
          const delay = Math.pow(this.backoffFactor, attempt) * 1000
          await sleep(delay)
          continue
        }
        console.error(`[atlas] Request exception: ${err.message}`)
        return {}
      }
    }
    return {}
  }

  async findSboms(filters) {
    if (!filters || !filters.length) return {}
    const params = new URLSearchParams()
    for (const [key, operator, value] of filters) {
      const values = Array.isArray(value) ? value : [value]
      for (const v of values) params.append('q', `${key}${operator}${v}`)
    }
    const url = `${this.baseUrl}/sbom?${params.toString()}`
    return this._requestWithRetry(url)
  }

  async findSbomByDigest(digest) {
    return this.findSboms([['document_id', '~', digest]])
  }

  async getSbomPackages(sbomUuid) {
    const url = `${this.baseUrl}/sbom/${sbomUuid}/packages`
    return this._requestWithRetry(url)
  }
}

module.exports = { AtlasClient, ATLAS_UI_SBOMS }
