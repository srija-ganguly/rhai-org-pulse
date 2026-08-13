import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetcher = await import('../../server/gitlab-fetcher.js')

describe('gitlab-fetcher', () => {
  beforeEach(() => {
    fetcher._setFetch(globalThis.fetch)
  })

  it('exports expected functions', () => {
    expect(typeof fetcher.gitlabApi).toBe('function')
    expect(typeof fetcher.listConfigFiles).toBe('function')
    expect(typeof fetcher.fetchRawFile).toBe('function')
    expect(typeof fetcher.fetchBranchSha).toBe('function')
    expect(typeof fetcher.fetchTags).toBe('function')
    expect(typeof fetcher.fetchCommitRefs).toBe('function')
  })

  it('gitlabApi sends PRIVATE-TOKEN header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: 'test' }),
    })
    fetcher._setFetch(mockFetch)

    await fetcher.gitlabApi('/test', 'my-token', 'https://gitlab.example.com')

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://gitlab.example.com/api/v4/test')
    expect(opts.headers['PRIVATE-TOKEN']).toBe('my-token')
  })

  it('gitlabApi throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    })
    fetcher._setFetch(mockFetch)

    await expect(fetcher.gitlabApi('/test', 'bad-token')).rejects.toThrow('GitLab API 401')
  })

  it('listConfigFiles filters to .yaml blobs', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { name: 'rhaiis.yaml', type: 'blob' },
        { name: 'rhel-ai.yaml', type: 'blob' },
        { name: 'README.md', type: 'blob' },
        { name: 'subdir', type: 'tree' },
      ],
    })
    fetcher._setFetch(mockFetch)

    const files = await fetcher.listConfigFiles({
      token: 'tok', dir: 'config/products', ref: 'main',
    })
    expect(files).toHaveLength(2)
    expect(files[0].name).toBe('rhaiis.yaml')
    expect(files[1].name).toBe('rhel-ai.yaml')
  })

  it('fetchBranchSha extracts commit id', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ commit: { id: 'abc123def456' } }),
    })
    fetcher._setFetch(mockFetch)

    const sha = await fetcher.fetchBranchSha({ token: 'tok', ref: 'main' })
    expect(sha).toBe('abc123def456')
  })

  it('fetchTags paginates', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `tag-${i}` }))
    const page2 = [{ name: 'tag-100' }, { name: 'tag-101' }]
    let callCount = 0
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++
      return {
        ok: true,
        json: async () => callCount === 1 ? page1 : page2,
      }
    })
    fetcher._setFetch(mockFetch)

    const tags = await fetcher.fetchTags({ token: 'tok', projectId: 123 })
    expect(tags).toHaveLength(102)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
