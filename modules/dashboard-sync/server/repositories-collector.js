'use strict'

const yaml = require('js-yaml')
const { listConfigFiles, fetchRawFile, fetchBranchSha } = require('./gitlab-fetcher')

const REPOSITORIES_DIR = 'config/repositories'

function parseBranches(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(b => {
    if (typeof b === 'string') return { name: b }
    return { name: b.name, last_commit: b.last_commit || null }
  })
}

function parseImages(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(img => {
    if (typeof img === 'string') return { name: img }
    return { name: img.name, last_update: img.last_update || null }
  })
}

async function syncRepositories({ token, config }) {
  const project = config.project
  const ref = config.branch
  const baseUrl = config.baseUrl

  const commitSha = await fetchBranchSha({ token, project, ref, baseUrl })
  const files = await listConfigFiles({ token, project, dir: REPOSITORIES_DIR, ref, baseUrl })

  const repositories = []
  for (const file of files) {
    const filePath = `${REPOSITORIES_DIR}/${file.name}`
    const content = await fetchRawFile({ token, project, filePath, ref, baseUrl })
    const parsed = yaml.load(content)
    if (!parsed || !parsed.key || !parsed.url) {
      console.warn(`[dashboard-sync] Skipping invalid repository file: ${file.name}`)
      continue
    }
    repositories.push({
      key: parsed.key,
      url: parsed.url,
      gitlab_project_id: parsed.gitlab_project_id || null,
      type: parsed.type || 'unknown',
      branches: parseBranches(parsed.branches),
      images: parseImages(parsed.images),
      depends_on_keys: parsed.depends_on_keys || [],
      product_keys: parsed.product_keys || [],
      product_version_file: parsed.product_version_file || null,
      product_version_key: parsed.product_version_key || null,
      artifact_enrichment: parsed.artifact_enrichment || null,
      artifact_filters: parsed.artifact_filters || null,
      last_updated: new Date(),
      commit_sha: commitSha,
    })
  }

  return {
    repositories,
    source: { project, branch: ref, commit_sha: commitSha, path: REPOSITORIES_DIR },
  }
}

module.exports = { syncRepositories }
