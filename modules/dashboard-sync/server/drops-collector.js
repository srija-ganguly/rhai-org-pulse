'use strict'

const { getStrategy } = require('./strategies')
const { getVersionExtractor } = require('./version-extractors')

const DEFAULT_STRATEGY = 'gitlab-tags'

async function syncDrops({ productKey, repositories, existingDropNames, dropStrategy, token, config, db }) {
  const strategyName = dropStrategy || DEFAULT_STRATEGY
  let strategy
  try {
    strategy = getStrategy(strategyName)
  } catch {
    console.warn(`[dashboard-sync] Skipping drops for '${productKey}': strategy '${strategyName}' not yet implemented (requires images collector)`)
    return { drops: [], repositoryTagsMap: {}, skipped: strategyName }
  }
  const versionExtractor = getVersionExtractor(productKey)

  const containerRepos = repositories.filter(r => r.type === 'containers')
  if (!containerRepos.length) {
    console.warn(`[dashboard-sync] No container repositories for product '${productKey}', skipping drops`)
    return { drops: [], repositoryTagsMap: {} }
  }

  return strategy.collectDrops({
    productKey,
    repositories: containerRepos,
    existingDropNames: existingDropNames || new Set(),
    versionExtractor,
    token,
    config,
    db,
  })
}

module.exports = { syncDrops }
