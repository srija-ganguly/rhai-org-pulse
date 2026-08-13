'use strict'

const yaml = require('js-yaml')
const { listConfigFiles, fetchRawFile, fetchBranchSha } = require('./gitlab-fetcher')

const PRODUCTS_DIR = 'config/products'

async function syncProducts({ token, config }) {
  const project = config.project
  const ref = config.branch
  const baseUrl = config.baseUrl

  const commitSha = await fetchBranchSha({ token, project, ref, baseUrl })
  const files = await listConfigFiles({ token, project, dir: PRODUCTS_DIR, ref, baseUrl })

  const products = []
  for (const file of files) {
    const filePath = `${PRODUCTS_DIR}/${file.name}`
    const content = await fetchRawFile({ token, project, filePath, ref, baseUrl })
    const parsed = yaml.load(content)
    if (!parsed || !parsed.key || !parsed.product_name) {
      console.warn(`[dashboard-sync] Skipping invalid product file: ${file.name}`)
      continue
    }
    products.push({
      key: parsed.key,
      product_name: parsed.product_name,
      short_name: parsed.short_name || '',
      supported_versions: parsed.supported_versions || [],
      default_product_version: parsed.default_product_version || null,
      konflux_namespace: parsed.konflux_namespace || null,
      drop_strategy: parsed.drop_strategy || 'gitlab-tags',
      collectors: parsed.collectors || [],
      last_updated: new Date(),
      commit_sha: commitSha,
    })
  }

  return {
    products,
    source: { project, branch: ref, commit_sha: commitSha, path: PRODUCTS_DIR },
  }
}

module.exports = { syncProducts }
