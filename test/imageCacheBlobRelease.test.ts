/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imageCache } from '../src/utils/imageCache'

// 回归：LRU 淘汰被淘汰的 blob: 条目时必须 revokeObjectURL。
// 旧实现在超限 while 循环里只 delete 不 revoke，导致解码后的封面 Blob
// （通常数百 KB）一直驻留到页面销毁。
describe('imageCache blob 释放', () => {
  let revoked: string[] = []
  let created = 0

  beforeEach(() => {
    revoked = []
    created = 0
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => `blob:mock/${created += 1}`,
      revokeObjectURL: (url: string) => { revoked.push(url) },
    })
  })

  afterEach(() => {
    imageCache.clear()
    vi.unstubAllGlobals()
  })

  it('超出上限淘汰时释放被淘汰条目的 blob URL', () => {
    // maxEntries = 800；写入 802 条，前 2 条应被淘汰并 revoke
    const blobUrls: string[] = []
    for (let i = 0; i < 802; i += 1) {
      const url = `blob:mock/${i}`
      blobUrls.push(url)
      imageCache.set(`key-${i}`, url)
    }

    expect(imageCache.size()).toBeLessThanOrEqual(800)
    // 被淘汰的前两条必须已 revoke
    expect(revoked).toContain(blobUrls[0])
    expect(revoked).toContain(blobUrls[1])
    // 仍在缓存中的最新条目不应被 revoke
    expect(revoked).not.toContain(blobUrls[801])
  })

  it('非 blob URL 不调用 revokeObjectURL', () => {
    for (let i = 0; i < 802; i += 1) imageCache.set(`http-key-${i}`, `http://localhost:3001/api/cover?i=${i}`)
    expect(revoked).toEqual([])
  })

  it('覆盖同一 key 且 URL 变化时释放旧 blob', () => {
    imageCache.set('same', 'blob:old')
    imageCache.set('same', 'blob:new')
    expect(revoked).toContain('blob:old')
    expect(imageCache.get('same')).toBe('blob:new')
  })
})
