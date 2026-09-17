import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequest = vi.fn()

vi.mock('../src/services/appleApiBridge', () => ({
  appleApiRequest: apiRequest,
}))

vi.mock('../src/services/appleAuth', () => ({
  AMP_API: 'https://amp-api.music.apple.com/v1',
  forwardToBackend: vi.fn(),
  getAppleCredentials: () => ({
    developerToken: 'developer-token',
    mediaUserToken: 'media-token',
    storefront: 'cn',
  }),
}))

vi.mock('../src/services/musicApi', () => ({
  searchSongs: vi.fn(),
}))

vi.mock('../src/services/appleMusic', () => ({
  searchAppleTracks: vi.fn(),
  toHighResArtwork: (value: string) => String(value || '').replace('{w}x{h}', '300x300'),
}))

const catalog = await import('../src/services/appleCatalog')

/**
 * 官网搜索页实测响应形态：带 format[resources]=map 时
 * `results[type].data` 只有 {id,type} 引用，完整 attributes 在 `resources[type][id]`。
 * 这里断言服务层正确合并并产出官网顺序的分区。
 */
const searchResponse = (overrides: Record<string, any[]> = {}) => ({
  ok: true,
  status: 200,
  data: {
    results: {
      songs: { data: [{ id: '1783690599', type: 'songs' }] },
      albums: { data: [{ id: '1783690060', type: 'albums' }] },
      artists: { data: [{ id: '1600816144', type: 'artists' }] },
      playlists: { data: [{ id: 'pl.abc', type: 'playlists' }] },
      'music-videos': { data: [{ id: '1440843597', type: 'music-videos' }] },
      ...overrides,
    },
    resources: {
      songs: { 1783690599: { id: '1783690599', type: 'songs', attributes: { name: '千屈菜', artistName: '珂拉琪 Collage', artwork: { url: 'https://x/{w}x{h}bb.jpg' }, durationInMillis: 187000, url: 'https://music.apple.com/cn/song/1' } } },
      albums: { 1783690060: { id: '1783690060', type: 'albums', attributes: { name: 'Deus Ex Machina', artistName: '珂拉琪 Collage', artwork: { url: 'https://y/{w}x{h}bb.jpg' }, trackCount: 10, url: 'https://music.apple.com/cn/album/1' } } },
      artists: { 1600816144: { id: '1600816144', type: 'artists', attributes: { name: '珂拉琪 Collage', artwork: { url: 'https://z/{w}x{h}bb.jpg' }, url: 'https://music.apple.com/cn/artist/1' } } },
      playlists: { 'pl.abc': { id: 'pl.abc', type: 'playlists', attributes: { name: '破格之声', curatorName: 'Apple Music 另类音乐', artwork: { url: 'https://p/{w}x{h}bb.jpg' }, trackCount: 42, url: 'https://music.apple.com/cn/playlist/1' } } },
      'music-videos': { 1440843597: { id: '1440843597', type: 'music-videos', attributes: { name: '拼贴记忆', artistName: 'SpeXial', artwork: { url: 'https://v/{w}x{h}bb.jpg' }, url: 'https://music.apple.com/cn/music-video/1' } } },
    },
  },
})

describe('Apple 搜索页分区', () => {
  beforeEach(() => apiRequest.mockReset())

  it('缺 developer token 时返回 errorStatus（调用方可回退）', async () => {
    const auth = await import('../src/services/appleAuth')
    const spy = vi.spyOn(auth, 'getAppleCredentials').mockReturnValue({ developerToken: '', mediaUserToken: '', storefront: 'cn' } as any)
    await expect(catalog.searchAppleCatalogSections('x', 'cn')).resolves.toEqual(expect.objectContaining({ errorStatus: -1 }))
    spy.mockRestore()
  })

  it('空关键词不发请求', async () => {
    await expect(catalog.searchAppleCatalogSections('   ', 'cn')).resolves.toEqual({ sections: [] })
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('合并 resources 里的 attributes 并产出官网六分区顺序', async () => {
    apiRequest.mockResolvedValue(searchResponse())
    const result = await catalog.searchAppleCatalogSections('千屈菜', 'cn')
    // 官网实测顺序（term=collage）：最佳结果 → 艺人 → 专辑 → 歌曲 → 播放列表 → 音乐视频
    expect(result.sections.map(section => section.id)).toEqual(['top', 'artists', 'albums', 'songs', 'playlists', 'music-videos'])
    // 最佳结果跨类型混排，且引用已解析出名称
    const top = result.sections.find(section => section.id === 'top')
    expect(top?.items.length).toBeGreaterThan(0)
    expect(top?.items.every(item => item.name)).toBe(true)
    // 艺人不可播放（无 playId），歌曲/专辑可播
    const artists = result.sections.find(section => section.id === 'artists')
    expect(artists?.items[0].playId).toBeUndefined()
    expect(artists?.items[0].subtitle).toBe('艺人')
    const songs = result.sections.find(section => section.id === 'songs')
    expect(songs?.items[0].playId).toBe('1783690599')
    expect(songs?.items[0].artworkUrl).toContain('300x300')
    const albums = result.sections.find(section => section.id === 'albums')
    expect(albums?.items[0].trackCount).toBe(10)
  })

  /**
   * 每个类型**单独请求**。
   *
   * 实测（collage / cn）在同一个请求里混多个 types 会静默丢类型：
   * `types=songs,albums,artists,playlists,music-videos` 只回 songs/albums/artists，
   * playlists 与 music-videos 直接消失。单类型请求才能拿到与官网一致的
   * artists 21 / albums 21 / songs 21 / playlists 14 / music-videos 8。
   */
  it('每个类型单独请求，且都带 format[resources]=map', async () => {
    apiRequest.mockResolvedValue(searchResponse())
    await catalog.searchAppleCatalogSections('千屈菜', 'cn')
    const paths = apiRequest.mock.calls.map(([path]) => String(path))
    expect(paths).toHaveLength(5)
    for (const type of ['artists', 'albums', 'songs', 'playlists', 'music-videos']) {
      const path = paths.find(p => p.includes(`types=${type}&`))
      expect(path, `缺少 types=${type} 的独立请求`).toBeTruthy()
      expect(path).toContain('format[resources]=map')
      // 不能把多个类型拼进同一个请求
      expect(path).not.toMatch(/types=[^&]*,/)
    }
  })

  it('无结果时分区为空数组（驱动官网空态文案）', async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        results: { songs: { data: [] }, albums: { data: [] }, artists: { data: [] } },
        resources: {},
      },
    })
    await expect(catalog.searchAppleCatalogSections('zzzz', 'cn')).resolves.toEqual({ sections: [] })
  })
})
