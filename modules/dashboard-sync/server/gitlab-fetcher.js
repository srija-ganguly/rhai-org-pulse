'use strict'

const API_TIMEOUT = 30_000
const DEFAULT_BASE_URL = 'https://gitlab.com'
const DEFAULT_PROJECT = 'redhat%2Frhel-ai%2Fci-cd%2Fdashboard'

let _fetch = globalThis.fetch

function _setFetch(fn) { _fetch = fn }

async function gitlabApi(path, token, baseUrl) {
  const url = `${baseUrl || DEFAULT_BASE_URL}/api/v4${path}`
  const res = await _fetch(url, {
    headers: { 'PRIVATE-TOKEN': token, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`GitLab API ${res.status}: ${body.slice(0, 200)}`)
    err.upstreamStatus = res.status
    throw err
  }
  return res.json()
}

async function gitlabRaw(path, token, baseUrl) {
  const url = `${baseUrl || DEFAULT_BASE_URL}/api/v4${path}`
  const res = await _fetch(url, {
    headers: { 'PRIVATE-TOKEN': token },
    signal: AbortSignal.timeout(API_TIMEOUT),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`GitLab API ${res.status}: ${body.slice(0, 200)}`)
    err.upstreamStatus = res.status
    throw err
  }
  return res.text()
}

async function listConfigFiles({ token, project, dir, ref, baseUrl }) {
  const proj = project || DEFAULT_PROJECT
  const branch = ref || 'main'
  const path = `/projects/${proj}/repository/tree?path=${encodeURIComponent(dir)}&ref=${branch}&per_page=100`
  const entries = await gitlabApi(path, token, baseUrl)
  return entries.filter(e => e.type === 'blob' && e.name.endsWith('.yaml'))
}

async function fetchRawFile({ token, project, filePath, ref, baseUrl }) {
  const proj = project || DEFAULT_PROJECT
  const branch = ref || 'main'
  const encodedPath = encodeURIComponent(filePath)
  const path = `/projects/${proj}/repository/files/${encodedPath}/raw?ref=${branch}`
  return gitlabRaw(path, token, baseUrl)
}

async function fetchBranchSha({ token, project, ref, baseUrl }) {
  const proj = project || DEFAULT_PROJECT
  const branch = ref || 'main'
  const path = `/projects/${proj}/repository/branches/${encodeURIComponent(branch)}`
  const data = await gitlabApi(path, token, baseUrl)
  return data.commit ? data.commit.id : null
}

async function fetchTags({ token, projectId, baseUrl }) {
  const tags = []
  let page = 1
  while (true) {
    const path = `/projects/${projectId}/repository/tags?per_page=100&page=${page}`
    const batch = await gitlabApi(path, token, baseUrl)
    if (!batch.length) break
    tags.push(...batch)
    if (batch.length < 100) break
    page++
  }
  return tags
}

async function fetchCommitRefs({ token, projectId, commitSha, baseUrl }) {
  const path = `/projects/${projectId}/repository/commits/${commitSha}/refs?type=branch`
  return gitlabApi(path, token, baseUrl)
}

async function fetchFileAtRef({ token, projectId, filePath, ref, baseUrl }) {
  const encodedPath = encodeURIComponent(filePath)
  const path = `/projects/${projectId}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`
  return gitlabRaw(path, token, baseUrl)
}

async function listTreeAtRef({ token, projectId, dir, ref, baseUrl }) {
  const path = `/projects/${projectId}/repository/tree?path=${encodeURIComponent(dir)}&ref=${encodeURIComponent(ref)}&per_page=100`
  return gitlabApi(path, token, baseUrl)
}

module.exports = {
  gitlabApi,
  gitlabRaw,
  listConfigFiles,
  fetchRawFile,
  fetchBranchSha,
  fetchTags,
  fetchCommitRefs,
  fetchFileAtRef,
  listTreeAtRef,
  _setFetch,
}
