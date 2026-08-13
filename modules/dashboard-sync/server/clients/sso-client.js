'use strict'

const DEFAULT_TOKEN_URL = 'https://auth.redhat.com/auth/realms/EmployeeIDP/protocol/openid-connect/token'
const FALLBACK_EXPIRES_IN = 300

class SSOClient {
  constructor({ clientId, clientSecret, tokenUrl, timeout = 30000, earlyRenewalSeconds = 10 } = {}) {
    if (!clientId || !clientSecret) throw new Error('SSO credentials required: clientId and clientSecret')
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.tokenUrl = tokenUrl || DEFAULT_TOKEN_URL
    this.timeout = timeout
    this.earlyRenewalSeconds = earlyRenewalSeconds
    this._token = null
    this._expiresAt = 0
  }

  async getToken() {
    if (this._isValid()) return this._token

    console.log('[sso] Requesting new SSO token...')
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    })

    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeout),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`SSO token request failed: ${res.status} ${text}`)
    }

    const data = await res.json()
    if (!data.access_token) throw new Error('SSO response missing access_token')

    this._token = data.access_token
    const expiresIn = data.expires_in != null ? Number(data.expires_in) : FALLBACK_EXPIRES_IN
    this._expiresAt = (Date.now() / 1000) + expiresIn - this.earlyRenewalSeconds

    console.log('[sso] Token obtained successfully')
    return this._token
  }

  _isValid() {
    return this._token && (Date.now() / 1000) < this._expiresAt - this.earlyRenewalSeconds
  }
}

module.exports = { SSOClient }
