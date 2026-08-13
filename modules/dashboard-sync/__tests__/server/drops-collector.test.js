import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const fetcher = require_('../../server/gitlab-fetcher.js')
const { syncDrops } = require_('../../server/drops-collector.js')

describe('drops-collector', () => {
  beforeEach(() => {
    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('/repository/tags')) {
        return {
          ok: true,
          json: async () => [
            {
              name: '3.2.0-1234567890',
              commit: {
                id: 'aaa111bbb222',
                created_at: '2026-07-10T12:00:00Z',
                parent_ids: ['parent1', 'parent2'],
              },
            },
            {
              name: '3.1.0-9876543210',
              commit: {
                id: 'ccc333ddd444',
                created_at: '2026-06-01T10:00:00Z',
                parent_ids: [],
              },
            },
          ],
        }
      }
      if (url.includes('/refs')) {
        return { ok: true, json: async () => [{ type: 'branch', name: '3.2' }] }
      }
      if (url.includes('/raw')) {
        return { ok: true, text: async () => 'RHAIIS_VERSION=3.2.0\nOTHER=value' }
      }
      if (url.includes('/tree')) {
        return {
          ok: true,
          json: async () => [
            { name: 'cuda-ubi9.conf', type: 'blob' },
          ],
        }
      }
      return { ok: false, status: 404, text: async () => '' }
    })
    fetcher._setFetch(mockFetch)
  })

  it('collects drops from GitLab tags', async () => {
    const result = await syncDrops({
      productKey: 'rhaiis',
      repositories: [
        { key: 'rhaiis/containers', gitlab_project_id: 68845382, type: 'containers', tags: [] },
      ],
      existingDropNames: new Set(),
      dropStrategy: 'gitlab-tags',
      token: 'tok',
      config: { baseUrl: 'https://gitlab.example.com' },
    })

    expect(result.drops).toHaveLength(2)

    const drop1 = result.drops.find(d => d.name === '3.2.0-1234567890')
    expect(drop1).toBeDefined()
    expect(drop1.key).toBe('rhaiis-3.2.0-1234567890')
    expect(drop1.product_key).toBe('rhaiis')
    expect(drop1.product_version).toBe('3.2.0')
    expect(drop1.git_branch).toBe('3.2')
    expect(drop1.created_at).toBeInstanceOf(Date)
  })

  it('skips non-container repositories', async () => {
    const result = await syncDrops({
      productKey: 'rhaiis',
      repositories: [
        { key: 'wheels-builder', gitlab_project_id: 123, type: 'wheels-collection', tags: [] },
      ],
      existingDropNames: new Set(),
      dropStrategy: 'gitlab-tags',
      token: 'tok',
      config: { baseUrl: 'https://gitlab.example.com' },
    })

    expect(result.drops).toHaveLength(0)
  })

  it('tracks new tags in repositoryTagsMap', async () => {
    const result = await syncDrops({
      productKey: 'rhaiis',
      repositories: [
        { key: 'rhaiis/containers', gitlab_project_id: 68845382, type: 'containers', tags: [] },
      ],
      existingDropNames: new Set(),
      dropStrategy: 'gitlab-tags',
      token: 'tok',
      config: { baseUrl: 'https://gitlab.example.com' },
    })

    expect(result.repositoryTagsMap['rhaiis/containers']).toHaveLength(2)
    const tag = result.repositoryTagsMap['rhaiis/containers'][0]
    expect(tag).toHaveProperty('name')
    expect(tag).toHaveProperty('commit')
    expect(tag).toHaveProperty('parent_commits')
  })

  it('uses snake_case field names in drops', async () => {
    const result = await syncDrops({
      productKey: 'rhaiis',
      repositories: [
        { key: 'rhaiis/containers', gitlab_project_id: 68845382, type: 'containers', tags: [] },
      ],
      existingDropNames: new Set(),
      dropStrategy: 'gitlab-tags',
      token: 'tok',
      config: { baseUrl: 'https://gitlab.example.com' },
    })

    const drop = result.drops[0]
    expect(drop).toHaveProperty('product_key')
    expect(drop).toHaveProperty('product_version')
    expect(drop).toHaveProperty('git_branch')
    expect(drop).toHaveProperty('created_at')
    expect(drop).not.toHaveProperty('productKey')
    expect(drop).not.toHaveProperty('productVersion')
  })

  it('skips existing drops', async () => {
    const result = await syncDrops({
      productKey: 'rhaiis',
      repositories: [
        {
          key: 'rhaiis/containers',
          gitlab_project_id: 68845382,
          type: 'containers',
          tags: [{ name: '3.2.0-1234567890' }, { name: '3.1.0-9876543210' }],
        },
      ],
      existingDropNames: new Set(['3.2.0-1234567890', '3.1.0-9876543210']),
      dropStrategy: 'gitlab-tags',
      token: 'tok',
      config: { baseUrl: 'https://gitlab.example.com' },
    })

    expect(result.drops).toHaveLength(0)
  })
})
