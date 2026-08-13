'use strict'

const db = require('./db')
const { syncProducts } = require('./products-collector')
const { syncRepositories } = require('./repositories-collector')
const { syncDrops } = require('./drops-collector')
const { syncImages } = require('./images-collector')
const { syncWheels } = require('./wheels-collector')
const { syncChangelogs } = require('./changelogs-collector')
const { syncChi } = require('./chi-collector')
const { syncSbom } = require('./sbom-collector')
const { syncReleases } = require('./releases-collector')
const { syncKonflux } = require('./konflux-collector')
const { syncWheelOverrides } = require('./wheel-overrides-collector')
const { linkDropsToArtifacts, linkArtifactsToDrops } = require('./linking-collector')

const DEMO_MODE = process.env.DEMO_MODE === 'true'
const COOLDOWN_MS = 5 * 60 * 1000
const DEFAULT_PROJECT = 'redhat%2Frhel-ai%2Fci-cd%2Fdashboard'
const DEFAULT_BRANCH = 'main'

let lastSyncTime = 0
let syncRunning = false
let lastSyncMetrics = null

function getConfig(secrets) {
  return {
    project: secrets.DASHBOARD_GITLAB_PROJECT || DEFAULT_PROJECT,
    branch: secrets.DASHBOARD_GITLAB_BRANCH || DEFAULT_BRANCH,
    baseUrl: secrets.GITLAB_BASE_URL || 'https://gitlab.com',
  }
}

/**
 * @openapi
 * /api/modules/dashboard-sync/products:
 *   get:
 *     summary: List synced products
 *     tags: [Dashboard Sync]
 *     responses:
 *       200:
 *         description: Array of product documents
 */

/**
 * @openapi
 * /api/modules/dashboard-sync/repositories:
 *   get:
 *     summary: List synced repositories
 *     tags: [Dashboard Sync]
 *     responses:
 *       200:
 *         description: Array of repository documents
 */

/**
 * @openapi
 * /api/modules/dashboard-sync/drops:
 *   get:
 *     summary: List synced drops
 *     tags: [Dashboard Sync]
 *     parameters:
 *       - in: query
 *         name: product_key
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of drop documents
 */

/**
 * @openapi
 * /api/modules/dashboard-sync/artifacts:
 *   get:
 *     summary: List synced artifacts
 *     tags: [Dashboard Sync]
 *     parameters:
 *       - in: query
 *         name: product_key
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of artifact documents
 */

/**
 * @openapi
 * /api/modules/dashboard-sync/status:
 *   get:
 *     summary: Sync status and metrics
 *     tags: [Dashboard Sync]
 *     responses:
 *       200:
 *         description: Current sync status with collection counts and timing
 */

/**
 * @openapi
 * /api/modules/dashboard-sync/sync:
 *   post:
 *     summary: Trigger full sync (all collectors)
 *     tags: [Dashboard Sync]
 *     responses:
 *       200:
 *         description: Sync results with per-collector timing
 *       429:
 *         description: Cooldown active or sync already running
 *       503:
 *         description: MongoDB not connected
 */

/**
 * @openapi
 * /api/modules/dashboard-sync/sync/{collector}:
 *   post:
 *     summary: Trigger sync for a specific collector
 *     tags: [Dashboard Sync]
 *     parameters:
 *       - in: path
 *         name: collector
 *         required: true
 *         schema:
 *           type: string
 *           enum: [products, repositories, drops, images, wheels, changelogs, chi, sbom, releases, konflux, wheel-overrides, linking]
 *     responses:
 *       200:
 *         description: Collector sync result
 */

module.exports = function registerRoutes(router, context) {
  const { secrets, RefreshSkip } = context
  const token = secrets.GITLAB_TOKEN
  const config = getConfig(secrets)

  const registryKeys = ['QUAY_USERNAME', 'QUAY_PASSWORD', 'REGISTRY_REDHAT_USERNAME', 'REGISTRY_REDHAT_PASSWORD', 'GITLAB_TOKEN']
  console.log('[dashboard-sync] Registry secrets available:', registryKeys.filter(k => !!secrets[k]).join(', ') || 'NONE')

  const mongoUri = secrets.DASHBOARD_SYNC_MONGODB_URI
  if (mongoUri) {
    console.log('[dashboard-sync] Connecting to MongoDB:', mongoUri.replace(/\/\/[^@]+@/, '//<redacted>@'))
    db.connect(mongoUri).then(() => {
      console.log('[dashboard-sync] Connected to MongoDB')
    }).catch(err => {
      console.error('[dashboard-sync] MongoDB connection failed:', err.message)
    })
  } else {
    console.error('[dashboard-sync] DASHBOARD_SYNC_MONGODB_URI not set — module will not function')
  }

  function timed(label, fn) {
    return async function (...args) {
      const start = performance.now()
      const result = await fn(...args)
      const duration = Math.round(performance.now() - start)
      console.log(`[dashboard-sync] ${label} completed in ${duration}ms`)
      return { result, duration_ms: duration }
    }
  }

  // --- Core config collectors ---

  const runProductsSync = timed('Products sync', async () => {
    const result = await syncProducts({ token, config })
    await db.upsertMany('products', result.products)
    return { synced: result.products.length }
  })

  const runRepositoriesSync = timed('Repositories sync', async () => {
    const result = await syncRepositories({ token, config })
    await db.upsertMany('git_repositories', result.repositories)
    return { synced: result.repositories.length }
  })

  // --- Drops collector (per product) ---

  async function runDropsSync() {
    const totalStart = performance.now()
    const products = await db.getCollection('products').find().toArray()
    const allResults = []

    for (const product of products) {
      const productStart = performance.now()
      const repos = await db.getCollection('git_repositories')
        .find({ product_keys: product.key }).toArray()
      const existingDrops = await db.getCollection('drops')
        .find({ product_key: product.key }).toArray()
      const existingDropNames = new Set(existingDrops.map(d => d.name))

      const result = await syncDrops({
        productKey: product.key, repositories: repos, existingDropNames,
        dropStrategy: product.drop_strategy, token, config, db,
      })

      if (result.drops.length) await db.upsertMany('drops', result.drops)

      for (const [repoKey, newTags] of Object.entries(result.repositoryTagsMap)) {
        await db.getCollection('git_repositories').updateOne(
          { key: repoKey }, { $push: { tags: { $each: newTags } } }
        )
      }

      const dur = Math.round(performance.now() - productStart)
      console.log(`[dashboard-sync] Drops sync for '${product.key}': ${result.drops.length} drops in ${dur}ms${result.skipped ? ` (skipped: ${result.skipped})` : ''}`)
      allResults.push({ product_key: product.key, drops_synced: result.drops.length, duration_ms: dur, skipped: result.skipped || null })
    }

    const totalDuration = Math.round(performance.now() - totalStart)
    return { results: allResults, duration_ms: totalDuration }
  }

  // --- Images collector (per product) ---

  const runImagesSync = timed('Images sync', async () => {
    const products = await db.getCollection('products').find().toArray()
    let totalArtifacts = 0

    for (const product of products) {
      const repos = await db.getCollection('git_repositories')
        .find({ product_keys: product.key }).toArray()
      const existingKeys = new Set(
        (await db.getCollection('artifacts').find({ product_key: product.key }, { projection: { key: 1 } }).toArray()).map(a => a.key)
      )

      const result = await syncImages({
        productKey: product.key, repositories: repos, secrets,
        existingArtifactKeys: existingKeys, config,
      })

      if (result.artifacts.length) {
        await db.upsertMany('artifacts', result.artifacts)
        totalArtifacts += result.artifacts.length
      }
    }
    return { artifacts_synced: totalArtifacts }
  })

  // --- Wheels collector (per product) ---

  const runWheelsSync = timed('Wheels sync', async () => {
    const products = await db.getCollection('products').find().toArray()
    let totalArtifacts = 0

    for (const product of products) {
      if (!(product.collectors || []).includes('wheels-collections')) continue
      const repos = await db.getCollection('git_repositories')
        .find({ product_keys: product.key, type: 'wheels-collection' }).toArray()
      const existingDropNames = new Set(
        (await db.getCollection('drops').find({ product_key: product.key }, { projection: { name: 1 } }).toArray()).map(d => d.name)
      )

      const result = await syncWheels({
        productKey: product.key, repositories: repos,
        existingDropNames, token, config,
      })

      if (result.artifacts && result.artifacts.length) {
        await db.upsertMany('artifacts', result.artifacts)
        totalArtifacts += result.artifacts.length
      }
      if (result.drops && result.drops.length) {
        await db.upsertMany('drops', result.drops)
      }
    }
    return { artifacts_synced: totalArtifacts }
  })

  // --- Changelogs collector ---

  const runChangelogsSync = timed('Changelogs sync', async () => {
    const products = await db.getCollection('products').find().toArray()
    let totalCreated = 0

    for (const product of products) {
      if (!(product.collectors || []).includes('changelogs')) continue
      const result = await syncChangelogs({ productKey: product.key, token, config })
      if (result.changelogs.length) {
        await db.upsertMany('changelogs', result.changelogs)
        totalCreated += result.created
      }
    }
    return { changelogs_created: totalCreated }
  })

  // --- CHI collector ---

  const runChiSync = timed('CHI sync', async () => {
    return syncChi({ db })
  })

  // --- SBOM collector ---

  const runSbomSync = timed('SBOM sync', async () => {
    return syncSbom({ db, secrets })
  })

  // --- Releases collector ---

  const runReleasesSync = timed('Releases sync', async () => {
    const products = await db.getCollection('products').find().toArray()
    let totalReleases = 0

    for (const product of products) {
      if (!(product.collectors || []).includes('releases')) continue
      const result = await syncReleases({
        productKey: product.key, token, config,
        jiraEmail: secrets.JIRA_EMAIL, jiraToken: secrets.JIRA_TOKEN,
      })
      if (result.releases && result.releases.length) {
        const col = db.getCollection('builder_releases')
        for (const rel of result.releases) {
          await col.updateOne(
            { product_key: rel.product_key, platform_release_number: rel.platform_release_number },
            { $set: rel },
            { upsert: true }
          )
        }
        totalReleases += result.releases.length
      }
    }
    return { releases_synced: totalReleases }
  })

  // --- Konflux collector ---

  const runKonfluxSync = timed('Konflux sync', async () => {
    const products = await db.getCollection('products').find().toArray()
    let totalUpdated = 0

    for (const product of products) {
      if (!(product.collectors || []).includes('konflux-data')) continue
      const result = await syncKonflux({ productKey: product.key, product, secrets, db })
      totalUpdated += result.updated
    }
    return { artifacts_enriched: totalUpdated }
  })

  // --- Wheel overrides collector ---

  const runWheelOverridesSync = timed('Wheel overrides sync', async () => {
    const result = await syncWheelOverrides({
      token, config,
      jiraEmail: secrets.JIRA_EMAIL, jiraToken: secrets.JIRA_TOKEN,
    })
    if (result.overrides && result.overrides.length) {
      await db.upsertMany('wheel_overrides', result.overrides, 'package_name')
    }
    return { overrides_synced: result.overrides ? result.overrides.length : 0 }
  })

  // --- Linking collector ---

  const runLinkingSync = timed('Linking sync', async () => {
    const r1 = await linkDropsToArtifacts({ db })
    const r2 = await linkArtifactsToDrops({ db })
    return { drops_to_artifacts: r1, artifacts_to_drops: r2 }
  })

  // --- Full sync orchestrator ---

  async function runFullSync() {
    const fullStart = performance.now()
    const results = {}

    results.products = await runProductsSync()
    results.repositories = await runRepositoriesSync()
    results.drops = await runDropsSync()
    results.images = await runImagesSync()
    results.wheels = await runWheelsSync()
    results.changelogs = await runChangelogsSync()
    results.linking = await runLinkingSync()
    results.chi = await runChiSync()
    results.sbom = await runSbomSync()
    results.releases = await runReleasesSync()
    results.konflux = await runKonfluxSync()
    results.wheel_overrides = await runWheelOverridesSync()

    const totalDuration = Math.round(performance.now() - fullStart)
    lastSyncTime = Date.now()

    const collections = ['products', 'git_repositories', 'drops', 'artifacts', 'changelogs', 'builder_releases', 'wheel_overrides']
    const counts = {}
    for (const col of collections) {
      counts[col] = await db.getCollection(col).countDocuments()
    }

    const metrics = { total_duration_ms: totalDuration, collectors: results, counts }
    lastSyncMetrics = metrics
    console.log(`[dashboard-sync] Full sync completed in ${totalDuration}ms`)
    console.log(`[dashboard-sync] Counts:`, JSON.stringify(counts))
    return metrics
  }

  // --- Collector registry for per-collector sync ---

  const collectors = {
    products: runProductsSync,
    repositories: runRepositoriesSync,
    drops: runDropsSync,
    images: runImagesSync,
    wheels: runWheelsSync,
    changelogs: runChangelogsSync,
    chi: runChiSync,
    sbom: runSbomSync,
    releases: runReleasesSync,
    konflux: runKonfluxSync,
    'wheel-overrides': runWheelOverridesSync,
    linking: runLinkingSync,
  }

  // --- Refresh handlers ---

  function skipCheck() {
    if (DEMO_MODE) return 'Demo mode'
    if (!token) return 'GITLAB_TOKEN not configured'
    if (!db.isConnected()) return 'MongoDB not connected'
    return null
  }

  context.registerRefresh('products', {
    order: 70, cadence: '12h', timeout: 120000,
    description: 'Sync product definitions from AIPCC Dashboard GitLab repo',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runProductsSync()).result },
  })

  context.registerRefresh('repositories', {
    order: 71, cadence: '12h', timeout: 120000,
    description: 'Sync git repository definitions from AIPCC Dashboard GitLab repo',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runRepositoriesSync()).result },
  })

  context.registerRefresh('drops', {
    order: 72, cadence: '1h', timeout: 600000,
    description: 'Sync drops from GitLab tags for all products',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return runDropsSync() },
  })

  context.registerRefresh('images', {
    order: 73, cadence: '1h', timeout: 900000,
    description: 'Sync container image artifacts from registries',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runImagesSync()).result },
  })

  context.registerRefresh('wheels', {
    order: 74, cadence: '12h', timeout: 600000,
    description: 'Sync wheel collection artifacts from GitLab releases',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runWheelsSync()).result },
  })

  context.registerRefresh('changelogs', {
    order: 80, cadence: '12h', timeout: 600000,
    description: 'Compute commit changelogs between drops',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runChangelogsSync()).result },
  })

  context.registerRefresh('linking', {
    order: 81, cadence: '1h', timeout: 600000,
    description: 'Link drops to artifacts and artifacts to drops',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runLinkingSync()).result },
  })

  context.registerRefresh('chi', {
    order: 90, cadence: '24h', timeout: 900000,
    description: 'Fetch Container Health Index from Pyxis',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runChiSync()).result },
  })

  context.registerRefresh('sbom', {
    order: 91, cadence: '24h', timeout: 900000,
    description: 'Resolve SBOM links from Atlas',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runSbomSync()).result },
  })

  context.registerRefresh('releases', {
    order: 85, cadence: '24h', timeout: 600000,
    description: 'Sync builder releases from Jira sprints and GitLab',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runReleasesSync()).result },
  })

  context.registerRefresh('konflux', {
    order: 82, cadence: '12h', timeout: 900000,
    description: 'Enrich artifacts with Konflux build and release data',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runKonfluxSync()).result },
  })

  context.registerRefresh('wheel-overrides', {
    order: 86, cadence: '24h', timeout: 300000,
    description: 'Sync wheel override data from builder repo and Jira',
    handler: async () => { const s = skipCheck(); if (s) return new RefreshSkip(s); return (await runWheelOverridesSync()).result },
  })

  // --- API routes ---

  router.get('/products', async (req, res) => {
    if (!db.isConnected()) return res.status(503).json({ error: 'MongoDB not connected' })
    res.json(await db.getCollection('products').find().toArray())
  })

  router.get('/repositories', async (req, res) => {
    if (!db.isConnected()) return res.status(503).json({ error: 'MongoDB not connected' })
    const query = {}
    if (req.query.product_key) query.product_keys = req.query.product_key
    res.json(await db.getCollection('git_repositories').find(query).toArray())
  })

  router.get('/drops', async (req, res) => {
    if (!db.isConnected()) return res.status(503).json({ error: 'MongoDB not connected' })
    const query = {}
    if (req.query.product_key) query.product_key = req.query.product_key
    res.json(await db.getCollection('drops').find(query).sort({ created_at: -1 }).toArray())
  })

  router.get('/artifacts', async (req, res) => {
    if (!db.isConnected()) return res.status(503).json({ error: 'MongoDB not connected' })
    const query = {}
    if (req.query.product_key) query.product_key = req.query.product_key
    res.json(await db.getCollection('artifacts').find(query).sort({ created_at: -1 }).limit(100).toArray())
  })

  router.get('/status', async (req, res) => {
    const connected = db.isConnected()
    const counts = {}
    if (connected) {
      for (const col of ['products', 'git_repositories', 'drops', 'artifacts', 'changelogs', 'builder_releases', 'wheel_overrides']) {
        counts[col] = await db.getCollection(col).countDocuments()
      }
    }
    res.json({
      mongodb_connected: connected,
      last_sync: lastSyncTime ? new Date(lastSyncTime).toISOString() : null,
      sync_running: syncRunning,
      available_collectors: Object.keys(collectors),
      counts,
      last_sync_metrics: lastSyncMetrics,
    })
  })

  router.post('/sync', async (req, res) => {
    if (!db.isConnected()) return res.status(503).json({ error: 'MongoDB not connected' })
    if (syncRunning) return res.status(429).json({ error: 'Sync already running' })
    if (Date.now() - lastSyncTime < COOLDOWN_MS) {
      return res.status(429).json({ error: 'Cooldown active', retry_after_ms: COOLDOWN_MS - (Date.now() - lastSyncTime) })
    }
    syncRunning = true
    try {
      const result = await runFullSync()
      res.json({ success: true, result })
    } catch (err) {
      console.error('[dashboard-sync] Full sync failed:', err)
      res.status(500).json({ error: err.message })
    } finally {
      syncRunning = false
    }
  })

  router.post('/sync/:collector', async (req, res) => {
    if (!db.isConnected()) return res.status(503).json({ error: 'MongoDB not connected' })
    const collectorFn = collectors[req.params.collector]
    if (!collectorFn) {
      return res.status(404).json({ error: `Unknown collector: ${req.params.collector}`, available: Object.keys(collectors) })
    }
    try {
      const result = await collectorFn()
      res.json({ success: true, collector: req.params.collector, result })
    } catch (err) {
      console.error(`[dashboard-sync] Collector '${req.params.collector}' failed:`, err)
      res.status(500).json({ error: err.message })
    }
  })

  // --- Diagnostics ---

  context.registerDiagnostics(async () => {
    const connected = db.isConnected()
    const diag = { mongodb: connected ? 'connected' : 'disconnected' }
    if (connected) {
      for (const col of ['products', 'git_repositories', 'drops', 'artifacts', 'changelogs', 'builder_releases', 'wheel_overrides']) {
        diag[col] = await db.getCollection(col).countDocuments()
      }
    }
    if (lastSyncTime) diag.last_sync = new Date(lastSyncTime).toISOString()
    return diag
  })
}
