'use strict'

/**
 * Sync wheel package override data from the builder repo.
 *
 * Translated from:
 *   dashboard/backend/collector/tasks/wheel_overrides.py
 *   dashboard/backend/collector/core/wheel_overrides_collector.py
 *
 * Reads YAML files from overrides/settings/ in the builder repo, identifies
 * packages that are pre-built in at least one variant, enriches with Jira
 * issue data, and returns the override documents.
 */

const yaml = require('js-yaml')
const { gitlabApi, gitlabRaw } = require('./gitlab-fetcher')

const BUILDER_PROJECT_PATH = 'redhat/rhel-ai/wheels/builder'
const BUILDER_PROJECT_ENCODED = encodeURIComponent(BUILDER_PROJECT_PATH)
const OVERRIDES_DIR = 'overrides/settings'
const REF = 'main'
const DEFAULT_JIRA_URL = 'https://redhat.atlassian.net'
const DEFAULT_JIRA_EPIC_KEY = 'AIPCC-10263'

// ── Helpers ─────────────────────────────────────────────────────────────

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Return variant names where pre_built is true.
 */
function extractPreBuiltVariants(data) {
  const result = []
  const variants = data.variants || {}
  for (const [variantName, variantConfig] of Object.entries(variants)) {
    if (variantConfig && typeof variantConfig === 'object' && variantConfig.pre_built) {
      result.push(variantName)
    }
  }
  return result.sort()
}

/**
 * Extract only the lines belonging to the top-level variants: block.
 */
function findVariantsBlock(lines) {
  const result = []
  let inBlock = false
  let blockIndent = -1

  for (const line of lines) {
    if (!inBlock) {
      const m = line.match(/^(\s*)variants\s*:/)
      if (m) {
        inBlock = true
        blockIndent = m[1].length
      }
      continue
    }

    if (line.trim() === '') {
      result.push(line)
      continue
    }

    const indent = line.length - line.trimStart().length
    if (indent <= blockIndent && line.trim()) break
    result.push(line)
  }

  return result
}

/**
 * Find the comment associated with a variant's pre_built key.
 * Only searches within the variants: block to avoid false matches.
 */
function findPreBuiltComment(lines, variant) {
  const variantLines = findVariantsBlock(lines)
  let inVariant = false
  let variantIndent = -1
  let prevComment = null

  const variantPattern = new RegExp(`^\\s+${escapeRegExp(variant)}\\s*:`)

  for (const line of variantLines) {
    const stripped = line.trim()
    const indent = line.length - line.trimStart().length

    if (variantPattern.test(line)) {
      inVariant = true
      variantIndent = indent
      prevComment = null
      continue
    }

    if (!inVariant) continue

    if (indent <= variantIndent && stripped) break

    if (stripped.startsWith('#')) {
      const comment = stripped.replace(/^#+\s*/, '').trim()
      prevComment = comment || null
      continue
    }

    if (/\bpre_built\s*:/.test(line)) {
      if (line.includes('#')) {
        const comment = line.split('#', 2)[1].trim()
        if (comment) return comment
      }
      return prevComment
    }

    if (stripped) prevComment = null
  }

  return null
}

/**
 * Extract comments from pre_built lines, keyed by variant.
 * Uses the known pre_built_variants (from parsed YAML) to locate each
 * variant's block in the raw text, then extracts the comment from the
 * ``pre_built:`` line or the line immediately above it.
 */
function extractPreBuiltReason(content, preBuiltVariants) {
  const lines = content.split('\n')
  const variantReasons = {}

  for (const variant of preBuiltVariants) {
    const comment = findPreBuiltComment(lines, variant)
    if (comment) variantReasons[variant] = comment
  }

  const entries = Object.entries(variantReasons)
  if (!entries.length) return null

  const uniqueReasons = [...new Set(Object.values(variantReasons))]
  if (uniqueReasons.length === 1) return uniqueReasons[0]

  return entries.map(([v, r]) => `${v}: ${r}`).join('; ')
}

// ── GitLab: fetch overrides from builder repo ───────────────────────────

/**
 * Fetch all override YAML files and return pre-built packages.
 *
 * @param {object} opts
 * @param {string} opts.token   - GitLab private token
 * @param {string} opts.baseUrl - GitLab instance URL
 * @returns {{ success: boolean, overrides?: object[], commit_sha?: string|null,
 *             read_errors?: number, error?: string, error_type?: string }}
 */
async function fetchOverrides({ token, baseUrl }) {
  // Get latest commit SHA
  let commitSha = null
  try {
    const commits = await gitlabApi(
      `/projects/${BUILDER_PROJECT_ENCODED}/repository/commits?ref_name=${REF}&per_page=1`,
      token,
      baseUrl
    )
    if (commits.length) commitSha = commits[0].id
  } catch {
    console.log('[dashboard-sync] Could not fetch latest commit SHA for builder repo')
  }

  // List YAML files in overrides directory (paginated)
  let yamlFiles
  try {
    const allEntries = []
    let page = 1
    while (true) {
      const path =
        `/projects/${BUILDER_PROJECT_ENCODED}/repository/tree` +
        `?path=${encodeURIComponent(OVERRIDES_DIR)}&ref=${REF}&per_page=100&page=${page}`
      const batch = await gitlabApi(path, token, baseUrl)
      if (!batch.length) break
      allEntries.push(...batch)
      if (batch.length < 100) break
      page++
    }
    yamlFiles = allEntries
      .filter(item => item.type === 'blob' && item.name.endsWith('.yaml'))
      .map(item => item.name)
  } catch (err) {
    console.error(`[dashboard-sync] Failed to list ${OVERRIDES_DIR}: ${err.message}`)
    return { success: false, error: err.message, error_type: err.constructor.name }
  }

  const overrides = []
  let readErrors = 0

  for (const filename of yamlFiles) {
    const filePath = `${OVERRIDES_DIR}/${filename}`
    let content
    try {
      const encodedPath = encodeURIComponent(filePath)
      content = await gitlabRaw(
        `/projects/${BUILDER_PROJECT_ENCODED}/repository/files/${encodedPath}/raw?ref=${REF}`,
        token,
        baseUrl
      )
    } catch (err) {
      console.warn(`[dashboard-sync] Could not fetch ${filePath}: ${err.message}`)
      readErrors++
      continue
    }

    let data
    try {
      data = yaml.load(content)
    } catch {
      readErrors++
      continue
    }

    if (!data || typeof data !== 'object') continue

    const preBuiltVariants = extractPreBuiltVariants(data)
    if (!preBuiltVariants.length) continue

    const packageName = filename.replace(/\.yaml$/, '')
    const reason = extractPreBuiltReason(content, preBuiltVariants)

    overrides.push({
      package_name: packageName,
      pre_built_variants: preBuiltVariants,
      reason,
      source_file: filePath,
      commit_sha: commitSha,
    })
  }

  console.log(
    `[dashboard-sync] Collected ${overrides.length} pre-built packages ` +
    `from ${yamlFiles.length} override files (${readErrors} file read errors)`
  )

  return { success: true, overrides, commit_sha: commitSha, read_errors: readErrors }
}

// ── Jira: fetch child issues of the wheel overrides epic ────────────────

/**
 * Fetch child issues of the wheel overrides epic from Jira.
 *
 * @param {object} opts
 * @param {string} opts.jiraEmail - Jira user email for basic auth
 * @param {string} opts.jiraToken - Jira API token for basic auth
 * @param {string} [opts.epicKey] - Jira epic key (default: AIPCC-10263)
 * @returns {Promise<Array<{ summary: string, jira_key: string, jira_status: string }>>}
 */
async function fetchJiraIssues({ jiraEmail, jiraToken, epicKey }) {
  const jiraUrl = DEFAULT_JIRA_URL
  const epic = epicKey || DEFAULT_JIRA_EPIC_KEY
  const jql = `parent = ${epic}`
  const issuesList = []
  let startAt = 0
  const maxResults = 100
  const auth = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')

  while (true) {
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      startAt: String(startAt),
      fields: 'key,summary,status',
    })

    const res = await fetch(`${jiraUrl}/rest/api/3/search/jql?${params}`, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Jira API ${res.status}: ${body.slice(0, 200)}`)
    }

    const data = await res.json()
    const issues = data.issues || []

    for (const issue of issues) {
      const fields = issue.fields || {}
      issuesList.push({
        summary: (fields.summary || '').toLowerCase(),
        jira_key: issue.key,
        jira_status: (fields.status && fields.status.name) || '',
      })
    }

    if (startAt + issues.length >= (data.total || 0)) break
    startAt += maxResults
  }

  console.log(
    `[dashboard-sync] Fetched ${issuesList.length} Jira issues from epic ${epic}`
  )
  return issuesList
}

// ── Main collector ──────────────────────────────────────────────────────

/**
 * Sync wheel package override data from the builder repo.
 *
 * Reads YAML files from overrides/settings/ in the builder repo's main
 * branch, identifies packages that are pre-built in at least one variant,
 * enriches with Jira issue data, and returns the override documents.
 *
 * The caller is responsible for upserting into MongoDB (collection:
 * ``wheel_overrides``, keyed on ``package_name``) and for cleanup of
 * stale entries (only when ``read_errors === 0``).
 *
 * @param {object} opts
 * @param {string}  opts.token      - GitLab private token
 * @param {object}  opts.config     - { baseUrl }
 * @param {string}  [opts.jiraEmail] - Jira user email (omit to skip enrichment)
 * @param {string}  [opts.jiraToken] - Jira API token (omit to skip enrichment)
 * @param {string}  [opts.epicKey]   - Jira epic key (default: AIPCC-10263)
 * @returns {{ overrides: object[], read_errors: number, commit_sha: string|null }}
 */
async function syncWheelOverrides({ token, config, jiraEmail, jiraToken, epicKey }) {
  const baseUrl = config.baseUrl

  console.log('[dashboard-sync] Starting wheel overrides sync')

  // ── 1. Fetch overrides from GitLab builder repo ───────────────────────
  const fetchResult = await fetchOverrides({ token, baseUrl })

  if (!fetchResult.success) {
    throw new Error(`Wheel overrides fetch failed: ${fetchResult.error}`)
  }

  const overrides = fetchResult.overrides

  // ── 2. Enrich with Jira issue data ────────────────────────────────────
  let jiraIssues = []
  if (jiraEmail && jiraToken) {
    try {
      jiraIssues = await fetchJiraIssues({ jiraEmail, jiraToken, epicKey })
    } catch (err) {
      console.warn(
        `[dashboard-sync] Jira enrichment failed, continuing without it: ${err.message}`
      )
    }
  }

  // ── 3. Match packages to Jira issues ──────────────────────────────────
  const now = new Date()
  for (const override of overrides) {
    override.last_synced = now
    const pkgName = override.package_name.toLowerCase()
    const pattern = new RegExp(`\\b${escapeRegExp(pkgName)}\\b`)
    for (const issue of jiraIssues) {
      if (pattern.test(issue.summary)) {
        override.jira_key = issue.jira_key
        override.jira_status = issue.jira_status
        break
      }
    }
  }

  console.log(
    `[dashboard-sync] Wheel overrides sync collected ${overrides.length} pre-built packages`
  )

  return {
    overrides,
    read_errors: fetchResult.read_errors,
    commit_sha: fetchResult.commit_sha,
  }
}

module.exports = { syncWheelOverrides }
