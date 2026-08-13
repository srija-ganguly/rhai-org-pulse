'use strict'

const { getStrategy } = require('./strategies')

const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 100

async function linkDropsToArtifacts({ db }) {
  const dropsCol = db.getCollection('drops')
  const artifactsCol = db.getCollection('artifacts')
  const productsCol = db.getCollection('products')
  const reposCol = db.getCollection('git_repositories')

  console.log('[dashboard-sync] Starting link_drops_to_artifacts')
  let dropsProcessed = 0, artifactsLinked = 0

  const sixMonthsAgo = new Date(Date.now() - SIX_MONTHS_MS)
  let offset = 0

  while (true) {
    const drops = await dropsCol.find({ created_at: { $gte: sixMonthsAgo } })
      .skip(offset).limit(BATCH_SIZE).toArray()
    if (!drops.length) break

    const dropsByProduct = {}
    for (const drop of drops) {
      if (!dropsByProduct[drop.product_key]) dropsByProduct[drop.product_key] = []
      dropsByProduct[drop.product_key].push(drop)
    }

    for (const [productKey, productDrops] of Object.entries(dropsByProduct)) {
      const product = await productsCol.findOne({ key: productKey })
      if (!product) { dropsProcessed += productDrops.length; continue }

      let strategy
      try { strategy = getStrategy(product.drop_strategy) } catch { dropsProcessed += productDrops.length; continue }

      const repositories = await reposCol.find({ product_keys: productKey }).toArray()
      if (!repositories.length) { dropsProcessed += productDrops.length; continue }

      const candidateArtifacts = await artifactsCol.find({
        product_key: { $in: [productKey, null] },
        type: 'containers',
      }).toArray()

      const reposByKey = {}
      for (const repo of repositories) reposByKey[repo.key] = repo

      for (const drop of productDrops) {
        dropsProcessed++
        const matching = candidateArtifacts.filter(a => {
          const repo = a.git_repository_key ? reposByKey[a.git_repository_key] : null
          return strategy.matches(a, drop, repo)
        })

        const toLink = matching.filter(a =>
          !(a.drop_keys || []).includes(drop.key)
        )

        for (const artifact of toLink) {
          try {
            await artifactsCol.updateOne(
              { _id: artifact._id },
              { $addToSet: { drop_keys: drop.key } }
            )
            artifactsLinked++
          } catch (err) {
            console.error(`[dashboard-sync] Failed to link artifact '${artifact.key}' to drop '${drop.key}': ${err.message}`)
          }
        }
      }
    }
    offset += BATCH_SIZE
  }

  console.log(`[dashboard-sync] link_drops_to_artifacts: processed=${dropsProcessed} linked=${artifactsLinked}`)
  return { drops_processed: dropsProcessed, artifacts_linked: artifactsLinked }
}

async function linkArtifactsToDrops({ db }) {
  const dropsCol = db.getCollection('drops')
  const artifactsCol = db.getCollection('artifacts')
  const productsCol = db.getCollection('products')
  const reposCol = db.getCollection('git_repositories')

  console.log('[dashboard-sync] Starting link_artifacts_to_drops')
  let artifactsProcessed = 0, dropsLinked = 0

  const repoCache = {}
  const productCache = {}
  const dropsCache = {}
  let offset = 0

  while (true) {
    const artifacts = await artifactsCol.find({ type: 'containers' })
      .skip(offset).limit(BATCH_SIZE).toArray()
    if (!artifacts.length) break

    for (const artifact of artifacts) {
      artifactsProcessed++
      const repoKey = artifact.git_repository_key
      if (!repoKey) continue

      if (!repoCache[repoKey]) {
        repoCache[repoKey] = await reposCol.findOne({ key: repoKey })
      }
      const repo = repoCache[repoKey]
      if (!repo) continue

      const productKeys = artifact.product_key ? [artifact.product_key] : (repo.product_keys || [])

      for (const productKey of productKeys) {
        if (!productCache[productKey]) {
          productCache[productKey] = await productsCol.findOne({ key: productKey })
        }
        const product = productCache[productKey]
        if (!product) continue

        let strategy
        try { strategy = getStrategy(product.drop_strategy) } catch { continue }

        if (!dropsCache[productKey]) {
          dropsCache[productKey] = await dropsCol.find({ product_key: productKey }).toArray()
        }

        const matchingDrops = dropsCache[productKey].filter(drop =>
          strategy.matches(artifact, drop, repo) && !(artifact.drop_keys || []).includes(drop.key)
        )

        for (const drop of matchingDrops) {
          try {
            await artifactsCol.updateOne(
              { _id: artifact._id },
              { $addToSet: { drop_keys: drop.key } }
            )
            dropsLinked++
          } catch (err) {
            console.error(`[dashboard-sync] Failed to link drop '${drop.key}' to artifact '${artifact.key}': ${err.message}`)
          }
        }
      }
    }
    offset += BATCH_SIZE
  }

  console.log(`[dashboard-sync] link_artifacts_to_drops: processed=${artifactsProcessed} linked=${dropsLinked}`)
  return { artifacts_processed: artifactsProcessed, drops_linked: dropsLinked }
}

module.exports = { linkDropsToArtifacts, linkArtifactsToDrops }
