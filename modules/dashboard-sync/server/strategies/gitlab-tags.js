'use strict'

const { fetchTags, fetchCommitRefs } = require('../gitlab-fetcher')
const { registerStrategy } = require('./index')

function matchBranchByVersion(branchNames, productVersion) {
  if (branchNames.includes(productVersion)) return productVersion
  const parts = productVersion.split('.')
  if (parts.length >= 2) {
    const majorMinor = `${parts[0]}.${parts[1]}`
    if (branchNames.includes(majorMinor)) return majorMinor
  }
  if (branchNames.includes('main')) return 'main'
  return null
}

async function getBranchForCommit({ token, projectId, commitSha, productVersion, baseUrl }) {
  try {
    const refs = await fetchCommitRefs({ token, projectId, commitSha, baseUrl })
    const branchNames = refs.filter(r => r.type === 'branch').map(r => r.name)
    if (!branchNames.length) return null
    if (branchNames.length === 1) return branchNames[0]

    if (productVersion) {
      const matched = matchBranchByVersion(branchNames, productVersion)
      if (matched) return matched
    }

    const versionLike = branchNames.filter(b => /^\d+\.\d+/.test(b))
    if (versionLike.length) return versionLike[0]
    const nonMain = branchNames.filter(b => b !== 'main')
    return nonMain.length ? nonMain[0] : branchNames[0]
  } catch (err) {
    console.warn(`[dashboard-sync] Could not determine branch for commit ${commitSha}: ${err.message}`)
    return null
  }
}

async function collectDrops({ productKey, repositories, existingDropNames, versionExtractor, token, config }) {
  const baseUrl = config.baseUrl
  const allDrops = []
  const repositoryTagsMap = {}

  for (const repo of repositories) {
    if (!repo.gitlab_project_id) {
      console.warn(`[dashboard-sync] Repository '${repo.key}' has no gitlab_project_id, skipping`)
      continue
    }

    try {
      const tags = await fetchTags({ token, projectId: repo.gitlab_project_id, baseUrl })
      const existingTagNames = new Set((repo.tags || []).map(t => t.name))

      const tagsToProcess = tags.filter(
        tag => !existingTagNames.has(tag.name) || !existingDropNames.has(tag.name)
      )

      const newTags = []

      for (const tag of tagsToProcess) {
        const tagName = tag.name
        const isNewTag = !existingTagNames.has(tagName)

        try {
          const productVersion = await versionExtractor({
            projectId: repo.gitlab_project_id,
            tagName,
            token,
            baseUrl,
          })

          const gitBranch = await getBranchForCommit({
            token,
            projectId: repo.gitlab_project_id,
            commitSha: tag.commit.id,
            productVersion,
            baseUrl,
          })

          allDrops.push({
            key: `${productKey}-${tagName}`,
            name: tagName,
            product_key: productKey,
            product_version: productVersion || null,
            git_branch: gitBranch || null,
            created_at: new Date(tag.commit.created_at),
          })

          if (isNewTag) {
            newTags.push({
              name: tagName,
              commit: tag.commit.id,
              parent_commits: tag.commit.parent_ids || [],
              created_at: tag.commit.created_at ? new Date(tag.commit.created_at) : null,
            })
          }
        } catch (err) {
          console.error(`[dashboard-sync] Failed to create drop from tag '${tagName}': ${err.message}`)
        }
      }

      if (newTags.length) {
        repositoryTagsMap[repo.key] = newTags
      }
    } catch (err) {
      console.error(`[dashboard-sync] Failed to process repository '${repo.key}': ${err.message}`)
    }
  }

  return { drops: allDrops, repositoryTagsMap }
}

function matches(artifact, drop, repository) {
  if (!repository || !repository.tags) return false
  const matchingTags = repository.tags.filter(tag => tag.name === drop.name)
  if (!matchingTags.length) return false

  const matchingCommits = new Set()
  for (const tag of matchingTags) {
    matchingCommits.add(tag.commit)
    const parents = tag.parent_commits || []
    if (parents.length >= 2) {
      for (let i = 1; i < parents.length; i++) matchingCommits.add(parents[i])
    }
  }
  if (artifact.commit && matchingCommits.has(artifact.commit)) return true

  if (artifact.product_key === 'builder-images') {
    return artifact.key.endsWith(`:${drop.name}`)
  }
  return false
}

registerStrategy('gitlab-tags', { collectDrops, matches })

module.exports = { collectDrops, matches, matchBranchByVersion, getBranchForCommit }
