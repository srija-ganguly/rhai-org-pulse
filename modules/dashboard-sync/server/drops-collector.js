'use strict'

const { getStrategy } = require('./strategies')
const { getVersionExtractor } = require('./version-extractors')

const DEFAULT_STRATEGY = 'gitlab-tags'

async function syncDrops({ productKey, repositories, existingDropNames, dropStrategy, token, config }) {
  const strategyName = dropStrategy || DEFAULT_STRATEGY
  const strategy = getStrategy(strategyName)
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
  })
}

module.exports = { syncDrops }
