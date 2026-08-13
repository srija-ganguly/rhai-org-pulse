import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const fetcher = require_('../../server/gitlab-fetcher.js')
const { syncRepositories } = require_('../../server/repositories-collector.js')

describe('repositories-collector', () => {
  beforeEach(() => {
    const repoYaml = [
      'key: rhaiis/containers',
      'url: https://gitlab.com/redhat/rhel-ai/rhaiis/containers',
      'gitlab_project_id: 68845382',
      'type: containers',
      'branches:',
      '  - name: "3.0"',
      '  - name: "3.1"',
      '  - name: main',
      'images:',
      '  - name: quay.io/aipcc/rhaiis/cpu-ubi9',
      '  - name: quay.io/aipcc/rhaiis/cuda-ubi9',
      'depends_on_keys:',
      '  - base-images/app',
      'product_keys:',
      '  - rhaiis',
      'product_version_file: build-args/cuda-ubi9.conf',
      'product_version_key: RHAIIS_VERSION',
    ].join('\n')

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('/branches/')) return { ok: true, json: async () => ({ commit: { id: 'sha-repo' } }) }
      if (url.includes('/tree')) return { ok: true, json: async () => [{ name: 'rhaiis-containers.yaml', type: 'blob' }] }
      if (url.includes('rhaiis-containers.yaml')) return { ok: true, text: async () => repoYaml }
      return { ok: false, status: 404, text: async () => '' }
    })
    fetcher._setFetch(mockFetch)
  })

  it('syncs repositories with correct schema', async () => {
    const result = await syncRepositories({
      token: 'tok',
      config: { project: 'p', branch: 'main', baseUrl: 'https://gitlab.example.com' },
    })

    expect(result.repositories).toHaveLength(1)
    const repo = result.repositories[0]

    expect(repo.key).toBe('rhaiis/containers')
    expect(repo.url).toBe('https://gitlab.com/redhat/rhel-ai/rhaiis/containers')
    expect(repo.gitlab_project_id).toBe(68845382)
    expect(repo.type).toBe('containers')
    expect(repo.branches).toEqual([
      { name: '3.0', last_commit: null },
      { name: '3.1', last_commit: null },
      { name: 'main', last_commit: null },
    ])
    expect(repo.images).toEqual([
      { name: 'quay.io/aipcc/rhaiis/cpu-ubi9', last_update: null },
      { name: 'quay.io/aipcc/rhaiis/cuda-ubi9', last_update: null },
    ])
    expect(repo.depends_on_keys).toEqual(['base-images/app'])
    expect(repo.product_keys).toEqual(['rhaiis'])
    expect(repo.product_version_file).toBe('build-args/cuda-ubi9.conf')
    expect(repo.product_version_key).toBe('RHAIIS_VERSION')
  })

  it('does NOT include tags field', async () => {
    const result = await syncRepositories({
      token: 'tok',
      config: { project: 'p', branch: 'main', baseUrl: 'https://gitlab.example.com' },
    })
    const repo = result.repositories[0]
    expect(repo).not.toHaveProperty('tags')
  })

  it('uses snake_case field names', async () => {
    const result = await syncRepositories({
      token: 'tok',
      config: { project: 'p', branch: 'main', baseUrl: 'https://gitlab.example.com' },
    })
    const repo = result.repositories[0]
    expect(repo).toHaveProperty('gitlab_project_id')
    expect(repo).toHaveProperty('depends_on_keys')
    expect(repo).toHaveProperty('product_keys')
    expect(repo).toHaveProperty('product_version_file')
    expect(repo).toHaveProperty('product_version_key')
    expect(repo).not.toHaveProperty('gitlabProjectId')
    expect(repo).not.toHaveProperty('dependsOnKeys')
  })
})
