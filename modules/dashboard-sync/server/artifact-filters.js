'use strict'

/**
 * Artifact filtering engine for declarative artifact ingestion filtering.
 *
 * Supports modular, repository-level filters to exclude unwanted artifacts
 * during collection (e.g., .git reference tags, CI artifacts, etc.).
 *
 * Translated from: dashboard/backend/collector/core/artifact_filters.py
 */

class ArtifactFilter {
  /**
   * Initialize artifact filter with configuration.
   *
   * @param {Object|null} filterConfig - Filter configuration from repository YAML
   *   Example:
   *   {
   *     "exclude": [
   *       { "key_pattern": ".*\\.git$" },
   *       { "key_pattern": ".*-source$" }
   *     ]
   *   }
   */
  constructor(filterConfig) {
    this.filterConfig = filterConfig || {}
    this.excludePatterns = this._compileExcludePatterns()
  }

  /**
   * Compile exclude patterns from filter configuration.
   * @returns {RegExp[]}
   */
  _compileExcludePatterns() {
    const patterns = []
    const excludeRules = this.filterConfig.exclude || []

    for (const rule of excludeRules) {
      if (rule && typeof rule === 'object' && rule.key_pattern) {
        try {
          const compiled = new RegExp(rule.key_pattern)
          patterns.push(compiled)
        } catch (err) {
          console.warn(`[artifact-filters] Invalid regex pattern '${rule.key_pattern}': ${err.message}, skipping`)
        }
      }
    }

    return patterns
  }

  /**
   * Determine if an artifact should be included based on filters.
   *
   * @param {string} artifactKey - Full artifact key (e.g. "quay.io/repo/image:tag")
   * @returns {boolean} True if artifact should be included
   */
  shouldIncludeArtifact(artifactKey) {
    for (const pattern of this.excludePatterns) {
      if (pattern.test(artifactKey)) {
        return false
      }
    }
    return true
  }

  /**
   * Get filter statistics.
   * @returns {{ exclude_patterns: number }}
   */
  getStats() {
    return {
      exclude_patterns: this.excludePatterns.length,
    }
  }
}

module.exports = { ArtifactFilter }
