'use strict'

const { fetchFileAtRef, listTreeAtRef } = require('./gitlab-fetcher')

function parseKeyValue(content, key) {
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(`${key}=`)) {
      return trimmed.split('=')[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  return null
}

function extractVersionFromTagName(tagName) {
  const semantic = tagName.match(/^v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)$/)
  if (semantic) return semantic[1]
  const rhaiis = tagName.match(/^v(\d{8,12})$/)
  if (rhaiis) return rhaiis[1]
  const generic = tagName.match(/(\d+(?:[.\-_]\d+)*(?:[.\-_][\w]+)?)/)
  if (generic) return generic[1]
  return null
}

async function discoverConfFiles({ token, projectId, dir, ref, baseUrl }) {
  try {
    const tree = await listTreeAtRef({ token, projectId, dir, ref, baseUrl })
    return tree
      .filter(e => e.type === 'blob' && e.name.endsWith('.conf'))
      .map(e => `${dir}/${e.name}`)
  } catch {
    return null
  }
}

async function fileBasedExtract({ token, projectId, tagName, baseUrl, filePaths, versionKey, discoverDir }) {
  let paths = filePaths
  if (discoverDir) {
    const discovered = await discoverConfFiles({ token, projectId, dir: discoverDir, ref: tagName, baseUrl })
    if (discovered && discovered.length) paths = discovered
  }

  const versions = new Set()
  for (const fp of paths) {
    try {
      const content = await fetchFileAtRef({ token, projectId, filePath: fp, ref: tagName, baseUrl })
      const v = parseKeyValue(content, versionKey)
      if (v) versions.add(v)
    } catch {
      // file may not exist at this tag
    }
  }

  if (versions.size === 1) return [...versions][0]
  if (versions.size > 1) {
    console.warn(`[dashboard-sync] Multiple ${versionKey} values at tag ${tagName}: ${[...versions].join(', ')}`)
    return [...versions].sort().pop()
  }
  return null
}

const EXTRACTORS = {
  rhaiis: {
    filePaths: [
      'build-args/cpu-ubi9.conf', 'build-args/cuda-ubi9.conf',
      'build-args/gaudi-ubi9.conf', 'build-args/rocm-ubi9.conf',
      'build-args/neuron-ubi9.conf', 'build-args/spyre-ubi9.conf',
      'build-args/tpu-ubi9.conf',
      'build-args/cpu.conf', 'build-args/cuda.conf',
      'build-args/gaudi.conf', 'build-args/rocm.conf',
    ],
    versionKey: 'RHAIIS_VERSION',
    discoverDir: 'build-args',
    fallback: extractVersionFromTagName,
  },
  'base-images': {
    filePaths: ['build-args/cpu-app.conf'],
    versionKey: 'INDEX_VERSION',
    discoverDir: 'build-args',
    fallback(tagName) {
      const semantic = tagName.match(/^v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)$/)
      return semantic ? semantic[1] : null
    },
  },
}

function getVersionExtractor(productKey) {
  const cfg = EXTRACTORS[productKey]

  if (cfg) {
    return async function extractVersion({ projectId, tagName, token, baseUrl }) {
      const version = await fileBasedExtract({
        token, projectId, tagName, baseUrl,
        filePaths: cfg.filePaths,
        versionKey: cfg.versionKey,
        discoverDir: cfg.discoverDir,
      })
      return version || cfg.fallback(tagName)
    }
  }

  return async function defaultExtract({ tagName }) {
    return extractVersionFromTagName(tagName)
  }
}

module.exports = { getVersionExtractor, extractVersionFromTagName, parseKeyValue }
