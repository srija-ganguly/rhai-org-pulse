import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const fetcher = require_('../../server/gitlab-fetcher.js')
const { syncProducts } = require_('../../server/products-collector.js')

describe('products-collector', () => {
  beforeEach(() => {
    const responses = {
      branches: { commit: { id: 'sha-abc123' } },
      tree: [
        { name: 'rhaiis.yaml', type: 'blob' },
        { name: 'rhel-ai.yaml', type: 'blob' },
      ],
      'rhaiis.yaml': [
        'key: rhaiis',
        'product_name: "Red Hat AI Inference Server"',
        'short_name: "RHAIIS"',
        'supported_versions:',
        '  - "3.0"',
        '  - "3.1"',
        'drop_strategy: "gitlab-tags"',
        'collectors:',
        '  - drops',
        '  - images',
      ].join('\n'),
      'rhel-ai.yaml': [
        'key: rhel-ai',
        'product_name: "Red Hat Enterprise Linux AI"',
        'short_name: "RHEL AI"',
        'supported_versions:',
        '  - "1.4"',
      ].join('\n'),
    }

    const mockFetch = vi.fn().mockImplementation(async (url) => {
      if (url.includes('/branches/')) {
        return { ok: true, json: async () => responses.branches }
      }
      if (url.includes('/tree')) {
        return { ok: true, json: async () => responses.tree }
      }
      if (url.includes('rhaiis.yaml')) {
        return { ok: true, text: async () => responses['rhaiis.yaml'] }
      }
      if (url.includes('rhel-ai.yaml')) {
        return { ok: true, text: async () => responses['rhel-ai.yaml'] }
      }
      return { ok: false, status: 404, text: async () => 'Not Found' }
    })
    fetcher._setFetch(mockFetch)
  })

  it('syncs products with correct schema', async () => {
    const result = await syncProducts({
      token: 'test-token',
      config: { project: 'test%2Fproject', branch: 'main', baseUrl: 'https://gitlab.example.com' },
    })

    expect(result.products).toHaveLength(2)
    expect(result.source.commit_sha).toBe('sha-abc123')

    const rhaiis = result.products.find(p => p.key === 'rhaiis')
    expect(rhaiis).toBeDefined()
    expect(rhaiis.product_name).toBe('Red Hat AI Inference Server')
    expect(rhaiis.short_name).toBe('RHAIIS')
    expect(rhaiis.supported_versions).toEqual(['3.0', '3.1'])
    expect(rhaiis.drop_strategy).toBe('gitlab-tags')
    expect(rhaiis.collectors).toEqual(['drops', 'images'])
    expect(rhaiis.last_updated).toBeInstanceOf(Date)
    expect(rhaiis.commit_sha).toBe('sha-abc123')
  })

  it('uses snake_case field names (matching Dashboard MongoDB)', async () => {
    const result = await syncProducts({
      token: 'tok',
      config: { project: 'p', branch: 'main', baseUrl: 'https://gitlab.example.com' },
    })
    const product = result.products[0]
    expect(product).toHaveProperty('product_name')
    expect(product).toHaveProperty('short_name')
    expect(product).toHaveProperty('supported_versions')
    expect(product).toHaveProperty('drop_strategy')
    expect(product).toHaveProperty('last_updated')
    expect(product).toHaveProperty('commit_sha')
    expect(product).not.toHaveProperty('productName')
    expect(product).not.toHaveProperty('shortName')
  })

  it('skips files with missing required fields', async () => {
    fetcher._setFetch(vi.fn().mockImplementation(async (url) => {
      if (url.includes('/branches/')) return { ok: true, json: async () => ({ commit: { id: 'sha' } }) }
      if (url.includes('/tree')) return { ok: true, json: async () => [{ name: 'bad.yaml', type: 'blob' }] }
      if (url.includes('bad.yaml')) return { ok: true, text: async () => 'description: no key field' }
      return { ok: false, status: 404, text: async () => '' }
    }))

    const result = await syncProducts({
      token: 'tok',
      config: { project: 'p', branch: 'main', baseUrl: 'https://gitlab.example.com' },
    })
    expect(result.products).toHaveLength(0)
  })
})
