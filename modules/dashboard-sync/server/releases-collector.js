'use strict'

const { gitlabApi, gitlabRaw } = require('./gitlab-fetcher')

// GitLab project path for the builder repo
const BUILDER_PROJECT_PATH = 'redhat%2Frhel-ai%2Fwheels%2Fbuilder'
const BUILDER_RELEASES_URL = 'https://gitlab.com/redhat/rhel-ai/wheels/builder/-/releases'

// Jira board ID for "AIPCC Development Platform Team Board"
const JIRA_BOARD_ID = '3719'
const DEFAULT_JIRA_URL = 'https://redhat.atlassian.net'

const JIRA_TIMEOUT = 30_000

// Sprint name patterns for the Development Platform team
const PLATFORM_SPRINT_PATTERN = /^(AIPCC Sprint|AIPCC Application Platform|AP Sprint|DP Sprint)\s+(\d+)$/

// Mapping from variant directory names to display names
const VARIANT_DISPLAY_NAMES = {
  'cpu-ubi9': 'CPU',
  'cuda12.8-ubi9': 'NVIDIA CUDA 12.8',
  'cuda12.9-ubi9': 'NVIDIA CUDA 12.9',
  'cuda13.0-ubi9': 'NVIDIA CUDA 13.0',
  'cuda-ubi9': 'NVIDIA CUDA',
  'rocm6.4-ubi9': 'AMD ROCm 6.4',
  'rocm7.0-ubi9': 'AMD ROCm 7.0',
  'rocm7.1-ubi9': 'AMD ROCm 7.1',
  'rocm-ubi9': 'AMD ROCm',
  'gaudi-ubi9': 'Intel Gaudi',
  'spyre-ubi9': 'IBM Spyre',
  'tpu-ubi9': 'Google TPU',
  'neuron-ubi9': 'AWS Neuron',
}

// Mapping from build-args conf file names to display names
const BUILD_ARGS_DISPLAY_NAMES = {
  'cuda12.8-ubi9.conf': 'NVIDIA CUDA 12.8',
  'cuda12.9-ubi9.conf': 'NVIDIA CUDA 12.9',
  'cuda13.0-ubi9.conf': 'NVIDIA CUDA 13.0',
  'rocm6.4-ubi9.conf': 'AMD ROCm 6.4',
  'rocm7.0-ubi9.conf': 'AMD ROCm 7.0',
  'rocm7.1-ubi9.conf': 'AMD ROCm 7.1',
  'gaudi-ubi9.conf': 'Intel Gaudi',
  'spyre-ubi9.conf': 'IBM Spyre',
  'tpu-ubi9.conf': 'Google TPU',
  'neuron-ubi9.conf': 'AWS Neuron',
}

// Key packages to extract from constraints.txt
const CONSTRAINT_PACKAGES = ['torch', 'triton', 'vllm']

/**
 * Fetch all sprints from the AIPCC Development Platform Team Board.
 * Only returns sprints matching the Development Platform naming pattern.
 *
 * @param {string} jiraEmail - Jira user email for basic auth
 * @param {string} jiraToken - Jira API token
 * @param {string} [jiraUrl] - Jira base URL
 * @returns {Promise<object[]>} List of sprint objects with _number field
 */
async function fetchJiraSprints(jiraEmail, jiraToken, jiraUrl) {
  if (!jiraEmail || !jiraToken) {
    console.warn('[releases-collector] Jira credentials not configured, skipping sprint fetch')
    return []
  }

  const base = jiraUrl || DEFAULT_JIRA_URL
  const authHeader = 'Basic ' + Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')
  const sprints = []
  let startAt = 0

  while (true) {
    let data
    try {
      const url = `${base}/rest/agile/1.0/board/${JIRA_BOARD_ID}/sprint?startAt=${startAt}&maxResults=50`
      const res = await fetch(url, {
        headers: {
          'Authorization': authHeader,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(JIRA_TIMEOUT),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.error(`[releases-collector] Jira API ${res.status}: ${body.slice(0, 200)}`)
        return []
      }
      data = await res.json()
    } catch (err) {
      console.error(`[releases-collector] Failed to fetch sprints from Jira: ${err.message}`)
      return []
    }

    sprints.push(...(data.values || []))
    if (data.isLast !== false) break
    startAt += (data.values || []).length
  }

  // Filter to only Development Platform sprints and parse their numbers
  const platformSprints = []
  for (const sprint of sprints) {
    const match = PLATFORM_SPRINT_PATTERN.exec(sprint.name || '')
    if (match) {
      sprint._number = parseInt(match[2], 10)
      platformSprints.push(sprint)
    }
  }

  console.log(`[releases-collector] Fetched ${platformSprints.length} platform sprints from Jira`)
  return platformSprints
}

/**
 * Parse a Jira sprint date string into a Date.
 *
 * @param {string} dateStr
 * @returns {Date|null}
 */
function parseSprintDate(dateStr) {
  if (!dateStr) return null
  try {
    return new Date(dateStr.replace('Z', '+00:00'))
  } catch {
    return null
  }
}

/**
 * Find the sprint that contains the given release date.
 *
 * @param {Date} releaseDate
 * @param {object[]} sprints
 * @returns {object|null}
 */
function matchReleaseToSprint(releaseDate, sprints) {
  for (const sprint of sprints) {
    const start = parseSprintDate(sprint.startDate)
    const end = parseSprintDate(sprint.endDate)
    if (start && end && releaseDate >= start && releaseDate <= end) {
      return sprint
    }
  }
  return null
}

/**
 * Parse release description markdown into structured highlight sections.
 * Looks for markdown headers (## or ###) followed by bullet lists.
 *
 * @param {string} description
 * @returns {{ title: string, items: string[] }[]}
 */
function parseHighlights(description) {
  if (!description) return []

  const sections = []
  let currentTitle = null
  let currentItems = []

  for (const rawLine of description.split('\n')) {
    const line = rawLine.trim()

    // Match markdown headers (## or ###)
    const headerMatch = line.match(/^#{2,3}\s+(.+)$/)
    if (headerMatch) {
      if (currentTitle && currentItems.length) {
        sections.push({ title: currentTitle, items: currentItems })
      }
      currentTitle = headerMatch[1].trim()
      currentItems = []
      continue
    }

    // Match bullet items (- or *)
    const bulletMatch = line.match(/^[-*]\s+(.+)$/)
    if (bulletMatch && currentTitle) {
      currentItems.push(bulletMatch[1].trim())
    }
  }

  if (currentTitle && currentItems.length) {
    sections.push({ title: currentTitle, items: currentItems })
  }

  return sections
}

/**
 * Parse a build-args .conf file into key-value pairs.
 *
 * @param {string} content
 * @returns {Object<string, string>}
 */
function parseConfFile(content) {
  const result = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx !== -1) {
      result[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim()
    }
  }
  return result
}

/**
 * Parse a constraints.txt file, extracting version specs for key packages.
 *
 * @param {string} content
 * @returns {Object<string, string>}
 */
function parseConstraints(content) {
  const result = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    for (const pkg of CONSTRAINT_PACKAGES) {
      if (line.toLowerCase().startsWith(`${pkg}==`) || line.toLowerCase().startsWith(`${pkg}>=`)) {
        let raw
        if (line.includes('==')) {
          raw = line.split('==').pop()
        } else {
          raw = line.slice(pkg.length)
        }
        // Strip inline comments
        result[pkg] = raw.split('#')[0].trim()
        break
      }
    }
  }
  return result
}

/**
 * Fetch a file's content from GitLab at a specific ref.
 * Returns null if the file does not exist or cannot be fetched.
 *
 * @param {string} projectId - URL-encoded project path or numeric ID
 * @param {string} filePath
 * @param {string} ref
 * @param {string} token
 * @param {string} baseUrl
 * @returns {Promise<string|null>}
 */
async function fetchFileContent(projectId, filePath, ref, token, baseUrl) {
  try {
    const encodedPath = encodeURIComponent(filePath)
    const path = `/projects/${projectId}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`
    return await gitlabRaw(path, token, baseUrl)
  } catch {
    return null
  }
}

/**
 * Extract component versions and architecture params from build-args/ at a tag.
 *
 * @param {string} projectId - URL-encoded project path or numeric ID
 * @param {string} tag
 * @param {string} token
 * @param {string} baseUrl
 * @returns {Promise<{ component_versions: object, architecture_params: object[] }>}
 */
async function extractBuildArgs(projectId, tag, token, baseUrl) {
  const componentVersions = {}
  const archParamsRaw = {}

  // Parse common.conf for shared values
  const commonContent = await fetchFileContent(projectId, 'build-args/common.conf', tag, token, baseUrl)
  const commonVars = commonContent ? parseConfFile(commonContent) : {}
  const defaultPython = commonVars.PYTHON_VERSION || ''

  // Parse each accelerator-specific conf file
  for (const [confName, displayName] of Object.entries(BUILD_ARGS_DISPLAY_NAMES)) {
    const content = await fetchFileContent(projectId, `build-args/${confName}`, tag, token, baseUrl)
    if (!content) continue

    const confVars = parseConfFile(content)

    // CUDA version (only for CUDA accelerators)
    if (displayName.includes('CUDA')) {
      const cudaMajor = confVars.CUDA_MAJOR_VERSION
      const cudaMinor = confVars.CUDA_MINOR_VERSION
      if (cudaMajor && cudaMinor) {
        const cudaPatch = confVars.CUDA_PATCH_VERSION || ''
        let cudaVersion = `${cudaMajor}.${cudaMinor}`
        if (cudaPatch) cudaVersion = `${cudaVersion}.${cudaPatch}`
        if (!componentVersions['CUDA Version']) componentVersions['CUDA Version'] = {}
        componentVersions['CUDA Version'][displayName] = cudaVersion
      }
    }

    // ROCm version
    if (confVars.ROCM_VERSION) {
      if (!componentVersions['ROCm Version']) componentVersions['ROCm Version'] = {}
      componentVersions['ROCm Version'][displayName] = confVars.ROCM_VERSION
    }

    // Gaudi version
    if (confVars.GAUDI_VERSION) {
      if (!componentVersions['Gaudi Version']) componentVersions['Gaudi Version'] = {}
      componentVersions['Gaudi Version'][displayName] = confVars.GAUDI_VERSION
    }

    // Python version
    const pythonVer = confVars.PYTHON_VERSION || defaultPython
    if (pythonVer) {
      if (!componentVersions['Python']) componentVersions['Python'] = {}
      componentVersions['Python'][displayName] = pythonVer
    }

    // Architecture params
    if (confVars.TORCH_CUDA_ARCH_LIST) {
      if (!archParamsRaw['TORCH_CUDA_ARCH_LIST']) archParamsRaw['TORCH_CUDA_ARCH_LIST'] = {}
      archParamsRaw['TORCH_CUDA_ARCH_LIST'][displayName] = confVars.TORCH_CUDA_ARCH_LIST
    }

    if (confVars.ROCM_GPUS) {
      if (!archParamsRaw['ROCM_GPUS']) archParamsRaw['ROCM_GPUS'] = {}
      archParamsRaw['ROCM_GPUS'][displayName] = confVars.ROCM_GPUS
    }

    if (confVars.GAUDI_REVISION && confVars.GAUDI_VERSION) {
      if (!archParamsRaw['Gaudi Models']) archParamsRaw['Gaudi Models'] = {}
      archParamsRaw['Gaudi Models'][displayName] = `Gaudi (v${confVars.GAUDI_VERSION}.${confVars.GAUDI_REVISION})`
    }
  }

  // Consolidate architecture params -- deduplicate identical values across CUDA variants
  const architectureParams = []
  for (const [paramName, accelValues] of Object.entries(archParamsRaw)) {
    // Group accelerators by their value
    const valueToAccels = {}
    for (const [accel, value] of Object.entries(accelValues)) {
      if (!valueToAccels[value]) valueToAccels[value] = []
      valueToAccels[value].push(accel)
    }

    for (const [value, accels] of Object.entries(valueToAccels)) {
      let accelLabel
      if (accels.every(a => a.includes('CUDA')) && accels.length > 1) {
        accelLabel = 'NVIDIA CUDA'
      } else {
        accelLabel = accels[0]
      }
      architectureParams.push({
        accelerator: accelLabel,
        parameter_name: paramName,
        supported_values: value,
      })
    }
  }

  // OS version from common.conf BASE_IMAGE
  const baseImage = commonVars.BASE_IMAGE || ''
  const osMatch = baseImage.match(/ubi(\d+):(\d+\.\d+)/)
  if (osMatch) {
    const osVersion = `RHEL ${osMatch[1]}.${osMatch[2].split('-')[0]}`
    componentVersions['OS'] = {}
    for (const name of Object.values(BUILD_ARGS_DISPLAY_NAMES)) {
      componentVersions['OS'][name] = osVersion
    }
  }

  return { component_versions: componentVersions, architecture_params: architectureParams }
}

/**
 * Extract torch/triton/vllm versions from collections/ constraints.txt files.
 * Updates componentVersions in place.
 *
 * @param {string} projectId
 * @param {string} tag
 * @param {string} token
 * @param {string} baseUrl
 * @param {object} componentVersions - Mutated in place
 */
async function extractCollectionVersions(projectId, tag, token, baseUrl, componentVersions) {
  let tree
  try {
    const path = `/projects/${projectId}/repository/tree?path=${encodeURIComponent('collections')}&ref=${encodeURIComponent(tag)}&per_page=100`
    tree = await gitlabApi(path, token, baseUrl)
  } catch {
    return
  }

  const collectionDirs = tree
    .filter(item => item.type === 'tree' && item.name.startsWith('torch-'))
    .map(item => item.name)

  if (!collectionDirs.length) return

  // Sort by version (latest first)
  collectionDirs.sort((a, b) => {
    const parseVer = (name) => {
      const match = name.match(/^torch-(\d+)\.(\d+)\.(\d+)/)
      return match ? [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])] : [0, 0, 0]
    }
    const va = parseVer(a)
    const vb = parseVer(b)
    for (let i = 0; i < 3; i++) {
      if (vb[i] !== va[i]) return vb[i] - va[i]
    }
    return 0
  })

  for (const collectionName of collectionDirs) {
    let variantTree
    try {
      const path = `/projects/${projectId}/repository/tree?path=${encodeURIComponent(`collections/${collectionName}`)}&ref=${encodeURIComponent(tag)}&per_page=100`
      variantTree = await gitlabApi(path, token, baseUrl)
    } catch {
      continue
    }

    const variants = variantTree.filter(item => item.type === 'tree').map(item => item.name)

    for (const variantName of variants) {
      const displayName = VARIANT_DISPLAY_NAMES[variantName]
      if (!displayName) continue

      const constraintsPath = `collections/${collectionName}/${variantName}/constraints.txt`
      const content = await fetchFileContent(projectId, constraintsPath, tag, token, baseUrl)
      if (!content) continue

      const versions = parseConstraints(content)

      for (const [pkg, version] of Object.entries(versions)) {
        let componentKey
        if (pkg === 'vllm') componentKey = 'vLLM'
        else if (pkg === 'triton') componentKey = 'Triton'
        else if (pkg === 'torch') componentKey = 'Torch'
        else componentKey = pkg.charAt(0).toUpperCase() + pkg.slice(1)

        // Only set if not already set by a newer collection
        const existing = componentVersions[componentKey] && componentVersions[componentKey][displayName]
        if (!existing) {
          if (!componentVersions[componentKey]) componentVersions[componentKey] = {}
          componentVersions[componentKey][displayName] = version
        }
      }
    }
  }
}

/**
 * Consolidate versioned CUDA columns into a single "NVIDIA CUDA" column.
 * AMD ROCm variants are kept as separate columns.
 *
 * @param {object} componentVersions - { component: { accelerator: version } }
 * @returns {object} Consolidated component versions
 */
function consolidateAcceleratorColumns(componentVersions) {
  const consolidationPrefixes = ['NVIDIA CUDA']
  const consolidated = {}

  for (const [component, accelMap] of Object.entries(componentVersions)) {
    const newAccelMap = {}

    for (const [accelName, value] of Object.entries(accelMap)) {
      let merged = false
      for (const prefix of consolidationPrefixes) {
        if (accelName.startsWith(prefix) && accelName !== prefix) {
          if (!(prefix in newAccelMap)) {
            newAccelMap[prefix] = value
          }
          merged = true
          break
        }
      }
      if (!merged) {
        newAccelMap[accelName] = value
      }
    }

    consolidated[component] = newAccelMap
  }

  return consolidated
}

/**
 * Extract the major version number from a semver tag (e.g. 'v26.10.0' -> 26).
 *
 * @param {string} tagName
 * @returns {number|null}
 */
function extractVersionPrefix(tagName) {
  const match = tagName.match(/^v(\d+)\./)
  return match ? parseInt(match[1], 10) : null
}

/**
 * Classify builder releases as main or maintenance by tag version prefix.
 * The release with the highest numeric major version is the main branch.
 *
 * @param {object[]} parsedReleases
 * @returns {Object<string, object[]>} { branch_name: [releases] }
 */
function classifyReleasesByBranch(parsedReleases) {
  if (!parsedReleases.length) return {}

  const prefixes = parsedReleases.map(r => extractVersionPrefix(r.tag_name))
  const validPrefixes = prefixes.filter(p => p !== null)
  if (!validPrefixes.length) return {}

  const maxPrefix = Math.max(...validPrefixes)
  const classified = {}

  for (const release of parsedReleases) {
    const prefix = extractVersionPrefix(release.tag_name)
    if (prefix === null) continue
    const branch = prefix === maxPrefix ? 'main' : `${prefix}-maint`
    if (!classified[branch]) classified[branch] = []
    classified[branch].push(release)
  }

  return classified
}

/**
 * Parse a GitLab release API object into a plain dict with the fields we need.
 *
 * @param {object} release - GitLab release API object
 * @returns {object}
 */
function parseGitlabRelease(release) {
  const tagName = release.tag_name
  const description = release.description || ''

  let releaseDate = null
  if (release.released_at) {
    try {
      releaseDate = new Date(release.released_at)
      if (isNaN(releaseDate.getTime())) releaseDate = null
    } catch {
      releaseDate = null
    }
  }

  const releasedBy = (release.author && release.author.name) || null

  return {
    tag_name: tagName,
    description,
    release_date: releaseDate,
    released_by: releasedBy,
  }
}

/**
 * Sync builder release data from Jira sprints and GitLab.
 *
 * 1. Fetches sprints from the Jira Development Platform board
 * 2. Fetches builder releases from GitLab
 * 3. Matches builder releases to sprints by date range
 * 4. Creates one BuilderRelease document per sprint (with or without builder data)
 *
 * @param {object} params
 * @param {string} params.productKey - Product key (expected to be 'builder-images')
 * @param {string} params.token - GitLab private token
 * @param {object} params.config - Config object with baseUrl
 * @param {string} params.jiraEmail - Jira user email
 * @param {string} params.jiraToken - Jira API token
 * @returns {Promise<{ releases: object[] }>}
 */
async function syncReleases({ productKey, token, config, jiraEmail, jiraToken }) {
  const baseUrl = config.baseUrl

  // Step 1: Fetch sprints from Jira
  const sprints = await fetchJiraSprints(jiraEmail, jiraToken)
  if (!sprints.length) {
    console.error('[releases-collector] No sprints found, cannot sync releases')
    return { releases: [] }
  }

  // Apply 1-year cutoff on sprint end date
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
  const filteredSprints = sprints.filter((s) => {
    const end = parseSprintDate(s.endDate)
    return end ? end >= cutoff : true
  })
  console.log(`[releases-collector] Processing ${filteredSprints.length} sprints from the past year`)

  // Step 2: Fetch builder releases from GitLab (paginated)
  console.log(`[releases-collector] Fetching releases from ${BUILDER_PROJECT_PATH}`)
  const parsedReleases = []
  let page = 1

  while (true) {
    let gitlabReleases
    try {
      const path = `/projects/${BUILDER_PROJECT_PATH}/releases?page=${page}&per_page=100`
      gitlabReleases = await gitlabApi(path, token, baseUrl)
    } catch (err) {
      console.error(`[releases-collector] Failed to list releases from GitLab: ${err.message}`)
      return { releases: [] }
    }

    if (!gitlabReleases.length) break

    for (const release of gitlabReleases) {
      const parsed = parseGitlabRelease(release)
      if (!parsed.release_date) continue
      if (parsed.release_date < cutoff) {
        // GitLab returns releases in reverse chronological order
        // Set flag to stop paginating
        gitlabReleases = [] // will cause hasMore check to exit
        break
      }
      parsedReleases.push(parsed)
    }

    if (gitlabReleases.length < 100) break
    page++
  }

  console.log(`[releases-collector] Found ${parsedReleases.length} builder releases from the past year`)

  // Step 3: Classify releases by branch, then group each branch by sprint
  const classified = classifyReleasesByBranch(parsedReleases)
  const mainReleases = classified.main || []
  delete classified.main
  const maintReleasesByBranch = classified

  // Group main releases by sprint number
  const mainBySprint = {}
  for (const parsed of mainReleases) {
    const sprint = matchReleaseToSprint(parsed.release_date, filteredSprints)
    if (!sprint) continue
    const sprintNum = sprint._number
    if (!mainBySprint[sprintNum]) {
      mainBySprint[sprintNum] = { latest: parsed, all_releases: [parsed] }
    } else {
      mainBySprint[sprintNum].all_releases.push(parsed)
    }
  }

  // Group maintenance releases by sprint
  const maintBySprint = {}
  for (const [branch, releases] of Object.entries(maintReleasesByBranch)) {
    for (const parsed of releases) {
      const sprint = matchReleaseToSprint(parsed.release_date, filteredSprints)
      if (!sprint) continue
      const sprintNum = sprint._number
      if (!maintBySprint[sprintNum]) maintBySprint[sprintNum] = {}
      if (!maintBySprint[sprintNum][branch]) {
        maintBySprint[sprintNum][branch] = parsed // first = latest
      }
    }
  }

  // Step 4: Create one document per sprint
  const allReleases = []

  for (const sprint of filteredSprints) {
    const sprintNum = sprint._number
    const sprintStart = parseSprintDate(sprint.startDate)
    const sprintEnd = parseSprintDate(sprint.endDate)
    const mainMatched = mainBySprint[sprintNum]
    const maintMatched = maintBySprint[sprintNum] || {}

    if (mainMatched) {
      const latest = mainMatched.latest
      const allMain = mainMatched.all_releases
      const tagName = latest.tag_name

      console.log(
        `[releases-collector] Extracting build metadata for sprint ${sprintNum} ` +
        `(${tagName}, ${allMain.length} main + ${Object.keys(maintMatched).length} maint branch(es))`
      )

      // Extract main branch metadata
      const buildArgs = await extractBuildArgs(BUILDER_PROJECT_PATH, tagName, token, baseUrl)
      let componentVersions = buildArgs.component_versions
      const architectureParams = buildArgs.architecture_params

      await extractCollectionVersions(BUILDER_PROJECT_PATH, tagName, token, baseUrl, componentVersions)
      componentVersions = consolidateAcceleratorColumns(componentVersions)

      // Extract metadata for each maintenance branch independently
      const maintenanceBuilds = []
      const sortedMaintEntries = Object.entries(maintMatched).sort(([a], [b]) => a.localeCompare(b))
      for (const [branch, maintRelease] of sortedMaintEntries) {
        const maintTag = maintRelease.tag_name
        const maintBuildArgs = await extractBuildArgs(BUILDER_PROJECT_PATH, maintTag, token, baseUrl)
        let maintCv = maintBuildArgs.component_versions
        const maintAp = maintBuildArgs.architecture_params
        await extractCollectionVersions(BUILDER_PROJECT_PATH, maintTag, token, baseUrl, maintCv)
        maintCv = consolidateAcceleratorColumns(maintCv)
        maintenanceBuilds.push({
          branch,
          builder_version: maintTag,
          builder_url: `${BUILDER_RELEASES_URL}/${maintTag}`,
          component_versions: maintCv,
          architecture_params: maintAp,
        })
      }

      // Aggregate highlights from main + maintenance releases (oldest-first)
      const allReleasesForHighlights = [...allMain, ...Object.values(maintMatched)]
      const allHighlights = []
      const allNotes = []
      for (const rel of allReleasesForHighlights.reverse()) {
        const relTag = rel.tag_name
        for (const section of parseHighlights(rel.description)) {
          allHighlights.push({
            title: `${relTag}: ${section.title}`,
            items: section.items,
          })
        }
        if (rel.description) {
          allNotes.push(rel.description)
        }
      }

      allReleases.push({
        product_key: productKey,
        platform_release_number: sprintNum,
        sprint_start_date: sprintStart,
        sprint_end_date: sprintEnd,
        builder_version: tagName,
        builder_url: `${BUILDER_RELEASES_URL}/${tagName}`,
        builder_release_count: allMain.length + Object.keys(maintMatched).length,
        release_date: latest.release_date,
        released_by: latest.released_by,
        highlights: allHighlights,
        highlights_source: 'regex',
        component_versions: componentVersions,
        architecture_params: architectureParams,
        maintenance_builds: maintenanceBuilds,
        release_notes_raw: allNotes.join('\n\n---\n\n') || null,
        last_updated: new Date(),
      })
    } else {
      // Sprint with no builder release
      allReleases.push({
        product_key: productKey,
        platform_release_number: sprintNum,
        sprint_start_date: sprintStart,
        sprint_end_date: sprintEnd,
        last_updated: new Date(),
      })
    }
  }

  console.log(`[releases-collector] Releases sync complete: ${allReleases.length} release documents`)
  return { releases: allReleases }
}

module.exports = {
  syncReleases,
  // Exported for testing
  parseHighlights,
  parseConfFile,
  parseConstraints,
  consolidateAcceleratorColumns,
  classifyReleasesByBranch,
  extractVersionPrefix,
  matchReleaseToSprint,
}
