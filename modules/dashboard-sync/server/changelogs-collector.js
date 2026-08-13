'use strict'

/**
 * Sync changelogs: compute commit diffs between consecutive drops per repository.
 *
 * Translated from dashboard/backend/collector/tasks/changelogs.py
 *
 * For each repository associated with a product, finds consecutive drop pairs
 * by matching artifact commit SHAs to repository tags, then fetches the commit
 * list from GitLab's compare API and returns Changelog documents.
 */

const { getCollection } = require('./db')
const { compareCommits } = require('./gitlab-fetcher')

/**
 * Compute changelogs between consecutive drops for a single product.
 *
 * @param {object} opts
 * @param {string} opts.productKey - Product key to compute changelogs for
 * @param {string} opts.token      - GitLab private token
 * @param {object} opts.config     - { baseUrl }
 * @returns {{ changelogs: object[], created: number, skipped: number }}
 */
async function syncChangelogs({ productKey, token, config }) {
  const baseUrl = config.baseUrl

  // ── 1. Load drops (sorted chronologically) ────────────────────────────
  const allDrops = await getCollection('drops')
    .find({ product_key: productKey })
    .sort({ created_at: 1 })
    .toArray()

  if (allDrops.length < 2) {
    console.log(
      `[dashboard-sync] Fewer than 2 drops for product '${productKey}', ` +
      'no changelogs to compute'
    )
    return { changelogs: [], created: 0, skipped: 0 }
  }

  // ── 2. Load eligible repositories ─────────────────────────────────────
  const repositories = await getCollection('git_repositories')
    .find({ product_keys: productKey })
    .toArray()

  const eligibleRepos = repositories.filter(
    r => r.type === 'containers' && r.gitlab_project_id && r.tags && r.tags.length
  )

  if (!eligibleRepos.length) {
    console.log(
      `[dashboard-sync] No eligible repositories with tags found for ` +
      `product '${productKey}'`
    )
    return { changelogs: [], created: 0, skipped: 0 }
  }

  // ── 3. Build commit SHA → drop-keys map from artifacts ────────────────
  const allDropKeys = allDrops.map(d => d.key)

  const artifacts = await getCollection('artifacts')
    .find({ drop_keys: { $in: allDropKeys }, product_key: productKey })
    .toArray()

  // Map: commit SHA → Set<drop key>
  const commitToDrops = {}
  for (const artifact of artifacts) {
    if (artifact.commit) {
      if (!commitToDrops[artifact.commit]) {
        commitToDrops[artifact.commit] = new Set()
      }
      for (const dk of (artifact.drop_keys || [])) {
        commitToDrops[artifact.commit].add(dk)
      }
    }
  }

  // ── 4. Pre-fetch existing changelog keys to avoid re-computing ────────
  const existingDocs = await getCollection('changelogs')
    .find({ product_key: productKey })
    .project({ key: 1 })
    .toArray()
  const existingKeys = new Set(existingDocs.map(c => c.key))

  // ── 5. Process each repository ────────────────────────────────────────
  const changelogs = []
  let totalSkipped = 0

  for (const repo of eligibleRepos) {
    // Build tag ↔ commit maps for this repo
    const tagCommitMap = {}  // tag name → commit SHA
    const commitTagMap = {}  // commit SHA → tag name (first wins)
    for (const tag of repo.tags) {
      tagCommitMap[tag.name] = tag.commit
      if (!commitTagMap[tag.commit]) {
        commitTagMap[tag.commit] = tag.name
      }
    }

    // Find which drops have artifacts whose commit matches a tag in this repo
    // Result: array of { drop, tagName } sorted by drop.created_at (inherits order)
    const dropTagPairs = []
    for (const drop of allDrops) {
      for (const [commitSha, dropKeys] of Object.entries(commitToDrops)) {
        if (dropKeys.has(drop.key) && commitTagMap[commitSha]) {
          dropTagPairs.push({ drop, tagName: commitTagMap[commitSha] })
          break
        }
      }
    }

    if (dropTagPairs.length < 2) {
      continue
    }

    // Group drops by branch to avoid cross-branch diffs
    const branchGroups = {}
    let skippedNoBranch = 0
    for (const pair of dropTagPairs) {
      const branch = pair.drop.git_branch
      if (branch == null) {
        skippedNoBranch++
        continue
      }
      if (!branchGroups[branch]) branchGroups[branch] = []
      branchGroups[branch].push(pair)
    }

    if (skippedNoBranch) {
      console.log(
        `[dashboard-sync] Skipped ${skippedNoBranch} drops with no git_branch ` +
        `in repo '${repo.key}' for product '${productKey}'`
      )
    }

    // Process consecutive pairs within each branch
    for (const pairs of Object.values(branchGroups)) {
      if (pairs.length < 2) continue

      for (let i = 1; i < pairs.length; i++) {
        const { drop: toDrop, tagName: toTag } = pairs[i]
        const toCommit = tagCommitMap[toTag]

        // Walk back to find the most recent drop with a different commit
        let fromDrop = null
        let fromTag = null
        for (let j = i - 1; j >= 0; j--) {
          const candidate = pairs[j]
          if (tagCommitMap[candidate.tagName] !== toCommit) {
            fromDrop = candidate.drop
            fromTag = candidate.tagName
            break
          }
        }

        if (!fromDrop) {
          // All previous drops on this branch share the same commit
          continue
        }

        const changelogKey = `${repo.key}:${fromDrop.key}..${toDrop.key}`

        // Skip if already computed
        if (existingKeys.has(changelogKey)) {
          totalSkipped++
          continue
        }

        // Fetch commits from GitLab compare API
        let commits
        try {
          commits = await compareCommits({
            token,
            projectId: repo.gitlab_project_id,
            from: fromTag,
            to: toTag,
            baseUrl,
          })
        } catch (err) {
          console.warn(
            `[dashboard-sync] Failed to get changelog for ${changelogKey}: ${err.message}`
          )
          continue
        }

        changelogs.push({
          key: changelogKey,
          repository_key: repo.key,
          from_drop_key: fromDrop.key,
          to_drop_key: toDrop.key,
          product_key: productKey,
          commits: commits.map(c => ({
            sha: c.sha,
            short_id: c.short_id,
            title: c.title,
            author_name: c.author_name,
            committed_date: new Date(c.committed_date),
          })),
          total_commits: commits.length,
          computed_at: new Date(),
        })

        console.log(
          `[dashboard-sync] Created changelog ${changelogKey} ` +
          `with ${commits.length} commits`
        )
      }
    }
  }

  console.log(
    `[dashboard-sync] Changelogs for '${productKey}': ${changelogs.length} created, ` +
    `${totalSkipped} skipped (already exist)`
  )

  return { changelogs, created: changelogs.length, skipped: totalSkipped }
}

module.exports = { syncChangelogs }
