'use strict'

const KONFLUX_API_SERVER = 'https://api-toolchain-host-operator.apps.stone-prod-p02.hjvn.p1.openshiftapps.com'
const KONFLUX_UI_BASE = 'https://console.redhat.com/application-pipeline'
const TEKTON_GROUP = 'tekton.dev'
const TEKTON_VERSION = 'v1'
const APPSTUDIO_GROUP = 'appstudio.redhat.com'
const APPSTUDIO_VERSION = 'v1alpha1'
const TIMEOUT = 30_000

class KonfluxClient {
  constructor({ namespace, token, apiServer, uiBaseUrl } = {}) {
    this.namespace = namespace
    this.token = token
    this.apiServer = (apiServer || KONFLUX_API_SERVER).replace(/\/$/, '')
    this.uiBaseUrl = (uiBaseUrl || KONFLUX_UI_BASE).replace(/\/$/, '')
    this.customApi = this.token ? true : false
  }

  async _k8sGet(path) {
    if (!this.token) throw new Error('Konflux: no service account token configured')
    const url = `${this.apiServer}${path}`
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Konflux K8s API ${res.status}: ${body.slice(0, 200)}`)
    }
    return res.json()
  }

  async listSnapshots({ commitSha, limit = 500 } = {}) {
    let labelSelector = ''
    if (commitSha) {
      labelSelector = `&labelSelector=${encodeURIComponent(`pac.test.appstudio.openshift.io/sha=${commitSha}`)}`
    }
    const path = `/apis/${APPSTUDIO_GROUP}/${APPSTUDIO_VERSION}/namespaces/${this.namespace}/snapshots?limit=${limit}${labelSelector}`
    const data = await this._k8sGet(path)
    return (data.items || []).map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      created_at: item.metadata.creationTimestamp,
      labels: item.metadata.labels || {},
      components: (item.spec.components || []).map(c => ({
        name: c.name,
        container_image: c.containerImage,
      })),
      test_results: this._extractTestResults(item),
    }))
  }

  async listReleases({ limit = 500, since } = {}) {
    const path = `/apis/${APPSTUDIO_GROUP}/${APPSTUDIO_VERSION}/namespaces/${this.namespace}/releases?limit=${limit}`
    const data = await this._k8sGet(path)
    return (data.items || []).filter(item => {
      if (!since) return true
      const created = item.metadata.creationTimestamp
      return created && new Date(created) >= since
    }).map(item => this._parseRelease(item))
  }

  async listPipelineRuns({ commitSha, limit = 100 } = {}) {
    let labelSelector = ''
    if (commitSha) {
      labelSelector = `&labelSelector=${encodeURIComponent(`pipelinesascode.tekton.dev/sha=${commitSha}`)}`
    }
    const path = `/apis/${TEKTON_GROUP}/${TEKTON_VERSION}/namespaces/${this.namespace}/pipelineruns?limit=${limit}${labelSelector}`
    const data = await this._k8sGet(path)
    return (data.items || []).map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      created_at: item.metadata.creationTimestamp,
      labels: item.metadata.labels || {},
      status: item.status?.conditions?.[0]?.status || 'Unknown',
      url: `${this.uiBaseUrl}/ns/${this.namespace}/pipelinerun/${item.metadata.name}`,
    }))
  }

  _parseRelease(item) {
    const meta = item.metadata || {}
    const spec = item.spec || {}
    const status = item.status || {}
    const conditions = status.conditions || []
    const releasedCond = conditions.find(c => c.type === 'Released')

    return {
      name: meta.name,
      namespace: meta.namespace,
      created_at: meta.creationTimestamp,
      snapshot: spec.snapshot,
      release_plan: spec.releasePlan,
      state: releasedCond ? (releasedCond.status === 'True' ? 'succeeded' : 'failed') : 'unknown',
      released_at: releasedCond?.lastTransitionTime || null,
      environment: this._getEnvironment(item),
      url: `${this.uiBaseUrl}/ns/${this.namespace}/release/${meta.name}`,
    }
  }

  _getEnvironment(item) {
    const name = item.spec?.releasePlan || ''
    if (name.includes('prod')) return 'production'
    if (name.includes('stage')) return 'stage'
    return 'unknown'
  }

  _extractTestResults(snapshot) {
    const results = []
    const labels = snapshot.metadata?.labels || {}
    for (const [key, value] of Object.entries(labels)) {
      if (key.startsWith('test.appstudio.openshift.io/')) {
        const testName = key.replace('test.appstudio.openshift.io/', '')
        results.push({ name: testName, status: value })
      }
    }
    return results
  }

  snapshotUrl(name) {
    return `${this.uiBaseUrl}/ns/${this.namespace}/snapshot/${name}`
  }

  releaseUrl(name) {
    return `${this.uiBaseUrl}/ns/${this.namespace}/release/${name}`
  }
}

module.exports = { KonfluxClient }
