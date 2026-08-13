'use strict'

const db = require('./db')
const { syncProducts } = require('./products-collector')
const { syncRepositories } = require('./repositories-collector')
const { syncDrops } = require('./drops-collector')

const DEMO_MODE = process.env.DEMO_MODE === 'true'
const COOLDOWN_MS = 5 * 60 * 1000
const DEFAULT_PROJECT = 'redhat%2Frhel-ai%2Fci-cd%2Fdashboard'
const DEFAULT_BRANCH = 'main'

let lastSyncTime = 0
let syncRunning = false

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
 *         description: Array of product documents from MongoDB
 */

/**
 * @openapi
 * /api/modules/dashboard-sync/repositories:
 *   get:
 *     summary: List synced repositories
 *     tags: [Dashboard Sync]
 *     responses:
 *       200:
 *         description: Array of repository documents from MongoDB
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
 *         description: Filter drops by product key
 *     responses:
 *       200:
 *         description: Array of drop documents from MongoDB
 */

/**
 * @openapi
 * /api/modules/dashboard-sync/status:
 *   get:
 *     summary: Sync status
 *     tags: [Dashboard Sync]
 *     responses:
 *       200:
 *         description: Current sync status and collection counts
 */

/**
 * @openapi
 * /api/modules/dashboard-sync/sync:
 *   post:
 *     summary: Trigger manual sync (products → repositories → drops)
 *     tags: [Dashboard Sync]
 *     responses:
 *       200:
 *         description: Sync results
 *       429:
 *         description: Cooldown active
 *       503:
 *         description: MongoDB not connected
 */

module.exports = function registerRoutes(router, context) {
  const { requireAuth, requireAdmin, secrets, RefreshSkip } = context
  const token = secrets.GITLAB_TOKEN
  const config = getConfig(secrets)

  const mongoUri = secrets.DASHBOARD_SYNC_MONGODB_URI || 'mongodb://localhost:27017/dashboard-sync-poc'
  db.connect(mongoUri).then(() => {
    console.log('[dashboard-sync] Connected to MongoDB')
  }).catch(err => {
    console.error('[dashboard-sync] MongoDB connection failed:', err.message)
  })

  async function runProductsSync() {
    const result = await syncProducts({ token, config })
    await db.upsertMany('products', result.products)
    return result
  }

  async function runRepositoriesSync() {
    const result = await syncRepositories({ token, config })
    await db.upsertMany('git_repositories', result.repositories)
    return result
  }

  async function runDropsSync() {
    const products = await db.getCollection('products').find().toArray()
    const allResults = []

    for (const product of products) {
      const repos = await db.getCollection('git_repositories')
        .find({ product_keys: product.key })
        .toArray()

      const existingDrops = await db.getCollection('drops')
        .find({ product_key: product.key })
        .toArray()
      const existingDropNames = new Set(existingDrops.map(d => d.name))

      const result = await syncDrops({
        productKey: product.key,
        repositories: repos,
        existingDropNames,
        dropStrategy: product.drop_strategy,
        token,
        config,
      })

      if (result.drops.length) {
        await db.upsertMany('drops', result.drops)
      }

      for (const [repoKey, newTags] of Object.entries(result.repositoryTagsMap)) {
        await db.getCollection('git_repositories').updateOne(
          { key: repoKey },
          { $push: { tags: { $each: newTags } } }
        )
      }

      allResults.push({ product_key: product.key, drops_synced: result.drops.length })
    }

    return allResults
  }

  async function runFullSync() {
    const productsResult = await runProductsSync()
    const reposResult = await runRepositoriesSync()
    const dropsResult = await runDropsSync()
    lastSyncTime = Date.now()
    return {
      products: { synced: productsResult.products.length },
      repositories: { synced: reposResult.repositories.length },
      drops: dropsResult,
    }
  }

  // --- Refresh handlers ---

  context.registerRefresh('products', {
    order: 70,
    cadence: '12h',
    timeout: 120000,
    description: 'Sync product definitions from AIPCC Dashboard GitLab repo',
    handler: async function () {
      if (DEMO_MODE) return new RefreshSkip('Demo mode')
      if (!token) return new RefreshSkip('GITLAB_TOKEN not configured')
      if (!db.isConnected()) return new RefreshSkip('MongoDB not connected')
      const result = await runProductsSync()
      return { synced: result.products.length }
    },
  })

  context.registerRefresh('repositories', {
    order: 71,
    cadence: '12h',
    timeout: 120000,
    description: 'Sync git repository definitions from AIPCC Dashboard GitLab repo',
    handler: async function () {
      if (DEMO_MODE) return new RefreshSkip('Demo mode')
      if (!token) return new RefreshSkip('GITLAB_TOKEN not configured')
      if (!db.isConnected()) return new RefreshSkip('MongoDB not connected')
      const result = await runRepositoriesSync()
      return { synced: result.repositories.length }
    },
  })

  context.registerRefresh('drops', {
    order: 72,
    cadence: '1h',
    timeout: 600000,
    description: 'Sync drops from GitLab tags for all products',
    handler: async function () {
      if (DEMO_MODE) return new RefreshSkip('Demo mode')
      if (!token) return new RefreshSkip('GITLAB_TOKEN not configured')
      if (!db.isConnected()) return new RefreshSkip('MongoDB not connected')
      const results = await runDropsSync()
      const totalDrops = results.reduce((sum, r) => sum + r.drops_synced, 0)
      return { products_processed: results.length, drops_synced: totalDrops }
    },
  })

  // --- API routes ---

  router.get('/products', requireAuth, async (req, res) => {
    if (!db.isConnected()) return res.status(503).json({ error: 'MongoDB not connected' })
    const products = await db.getCollection('products').find().toArray()
    res.json(products)
  })

  router.get('/repositories', requireAuth, async (req, res) => {
    if (!db.isConnected()) return res.status(503).json({ error: 'MongoDB not connected' })
    const query = {}
    if (req.query.product_key) query.product_keys = req.query.product_key
    const repos = await db.getCollection('git_repositories').find(query).toArray()
    res.json(repos)
  })

  router.get('/drops', requireAuth, async (req, res) => {
    if (!db.isConnected()) return res.status(503).json({ error: 'MongoDB not connected' })
    const query = {}
    if (req.query.product_key) query.product_key = req.query.product_key
    const drops = await db.getCollection('drops').find(query).sort({ created_at: -1 }).toArray()
    res.json(drops)
  })

  router.get('/status', requireAuth, async (req, res) => {
    const connected = db.isConnected()
    const counts = {}
    if (connected) {
      counts.products = await db.getCollection('products').countDocuments()
      counts.git_repositories = await db.getCollection('git_repositories').countDocuments()
      counts.drops = await db.getCollection('drops').countDocuments()
    }
    res.json({
      mongodb_connected: connected,
      last_sync: lastSyncTime ? new Date(lastSyncTime).toISOString() : null,
      sync_running: syncRunning,
      counts,
    })
  })

  router.post('/sync', requireAdmin, async (req, res) => {
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
      console.error('[dashboard-sync] Sync failed:', err)
      res.status(500).json({ error: err.message })
    } finally {
      syncRunning = false
    }
  })

  // --- Diagnostics ---

  context.registerDiagnostics(async () => {
    const connected = db.isConnected()
    const diag = { mongodb: connected ? 'connected' : 'disconnected' }
    if (connected) {
      diag.products = await db.getCollection('products').countDocuments()
      diag.git_repositories = await db.getCollection('git_repositories').countDocuments()
      diag.drops = await db.getCollection('drops').countDocuments()
    }
    if (lastSyncTime) diag.last_sync = new Date(lastSyncTime).toISOString()
    return diag
  })
}
