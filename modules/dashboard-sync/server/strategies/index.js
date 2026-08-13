'use strict'

const _registry = {}

function registerStrategy(name, strategy) {
  if (_registry[name]) throw new Error(`Duplicate drop strategy: ${name}`)
  _registry[name] = strategy
}

function getStrategy(name) {
  const strategy = _registry[name]
  if (!strategy) {
    const available = Object.keys(_registry).join(', ')
    throw new Error(`Unknown drop strategy '${name}'. Available: ${available}`)
  }
  return strategy
}

function getAvailableStrategies() {
  return Object.keys(_registry)
}

module.exports = { registerStrategy, getStrategy, getAvailableStrategies }

require('./gitlab-tags')
require('./artifact-commits')
