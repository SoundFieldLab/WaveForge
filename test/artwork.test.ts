import { describe, expect, it } from 'vitest'
import { getArtworkRoleSize, getArtworkSizeBucket, resizeArtworkSource, resolveArtworkUrl, unwrapArtworkSource } from '../src/services/artwork'
import { getArtworkCacheKey } from '../src/services/artworkLoader'

describe('artwork resolver', () => {
  it('uses stable rendition buckets for displayed slot sizes', () => {
    expect(getArtworkSizeBucket(1)).toBe(64)
    expect(getArtworkSizeBucket(80)).toBe(128)
    expect(getArtworkSizeBucket(300)).toBe(512)
    expect(getArtworkRoleSize('row', 40, 2)).toBe(128)
    expect(getArtworkRoleSize('background', 900, 2)).toBe(1024)
  })

  it('unwraps compatible proxy URLs before choosing a new rendition', () => {
    const source = 'https://p1.music.126.net/cover.jpg?foo=bar'
    const proxy = `http://localhost:3001/api/cover?url=${encodeURIComponent(source)}`
    expect(unwrapArtworkSource(proxy)).toBe(source)
    const resolved = new URL(resolveArtworkUrl(proxy, { size: 128 }))
    expect(resolved.pathname).toBe('/api/cover')
    expect(new URL(resolved.searchParams.get('url') || '').searchParams.get('param')).toBe('128y128')
  })

  it('builds versioned platform/rendition/source keys with an unknown namespace fallback', () => {
    const source = 'https://p1.music.126.net/cover.jpg'
    expect(getArtworkCacheKey(source, { platform: 'netease', size: 128 }))
      .toBe('artwork:v1:netease:128:https://p1.music.126.net/cover.jpg')
    expect(getArtworkCacheKey(source, { platform: 'qq', size: 256 }))
      .toBe('artwork:v1:qq:256:https://p1.music.126.net/cover.jpg')
    expect(getArtworkCacheKey('https://cdn.example.com/cover.jpg', { size: 128 }))
      .toBe('artwork:v1:unknown:128:https://cdn.example.com/cover.jpg')
  })

  /**
   * 回归：播放页封面（size:500→512 桶）与「下一首封面」预热必须落在同一档。
   *
   * 背景层用 background(128)、播放页封面用 getProxiedImageUrl 默认 size:500(→512)。
   * 缓存键与代理 URL 都带清晰度，所以此前只预热 background 时，切歌后封面 <img>
   * 仍要现下载 512 图；下载期间浏览器继续显示上一首已解码位图，
   * 表现为"背景已换新歌、封面还停在上一首 3~4 秒"。
   */
  it('播放页封面档位：size:500 与 displayCoverUrl 解析结果一致，且区别于背景档', () => {
    const source = 'https://p1.music.126.net/cover.jpg'
    const displayUrl = resolveArtworkUrl(source, { size: 500 })
    const preloadUrl = resolveArtworkUrl(source, { size: 500 })
    const backgroundUrl = resolveArtworkUrl(source, { role: 'background' })
    // 预热 URL 必须与展示 URL 完全相同，才能命中 HTTP 缓存 / 同一缓存键
    expect(preloadUrl).toBe(displayUrl)
    expect(displayUrl).not.toBe(backgroundUrl)
    expect(getArtworkSizeBucket(500)).toBe(512)
    expect(getArtworkCacheKey(source, { size: 500 }))
      .not.toBe(getArtworkCacheKey(source, { role: 'background' }))
  })

  it('only rewrites known provider artwork conventions', () => {
    expect(resizeArtworkSource('https://p1.music.126.net/a.jpg?param=500y500', 64))
      .toContain('param=64y64')
    expect(resizeArtworkSource('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg', 128))
      .toContain('T002R300x300')
    expect(resizeArtworkSource('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg', 512))
      .toContain('T002R500x500')
    expect(resizeArtworkSource('https://is1-ssl.mzstatic.com/image/thumb/{w}x{h}bb.jpg', 256))
      .toContain('/256x256bb.jpg')
    const signed = 'https://cdn.example.com/image.jpg?signature=a%2Bb&expires=1'
    expect(resizeArtworkSource(signed, 64)).toBe(signed)
  })
})
