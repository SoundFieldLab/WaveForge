import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  recent: vi.fn(),
  songs: vi.fn(),
  albums: vi.fn(),
  artists: vi.fn(),
  playlists: vi.fn(),
  videos: vi.fn(),
}))

vi.mock('../src/services/appleApiBridge', () => ({ appleApiRequest: mocks.api }))
vi.mock('../src/services/appleAuth', () => ({
  getAppleCredentials: () => ({ developerToken: 'dev', mediaUserToken: 'user', storefront: 'cn' }),
}))
vi.mock('../src/services/appleMusic', () => ({ toHighResArtwork: (value: string) => value }))
vi.mock('../src/services/appleCatalog', async importOriginal => {
  const original = await importOriginal<typeof import('../src/services/appleCatalog')>()
  return {
    ...original,
    getAppleRecentPlayed: mocks.recent,
    getAppleLibrarySongs: mocks.songs,
    getAppleLibraryAlbums: mocks.albums,
    getAppleLibraryArtists: mocks.artists,
    getAppleLibraryPlaylists: mocks.playlists,
    getAppleLibraryMusicVideos: mocks.videos,
  }
})

const web = await import('../src/services/appleWebService')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.recent.mockResolvedValue([])
  mocks.songs.mockResolvedValue([])
  mocks.albums.mockResolvedValue([])
  mocks.artists.mockResolvedValue([])
  mocks.playlists.mockResolvedValue([])
  mocks.videos.mockResolvedValue([])
})

describe('Apple web page composition', () => {
  it('adds a real recent-played shelf before recently added', async () => {
    mocks.recent.mockResolvedValue([{ id: '101', name: 'Recent', artistName: 'Artist', artworkUrl: 'recent.jpg', durationMs: 1000 }])
    mocks.api.mockImplementation(async (path: string) => {
      if (path.includes('/v1/me/recommendations')) {
        return { ok: true, status: 200, data: { data: [{ attributes: { title: 'For You' }, relationships: { contents: { data: [{ id: '201', type: 'songs', attributes: { name: 'Recommended', artistName: 'Artist' } }] } } }] } }
      }
      if (path.includes('/v1/me/library/recently-added')) {
        return { ok: true, status: 200, data: { data: [{ id: 'i.album', type: 'library-albums', attributes: { name: 'Added' }, relationships: { catalog: { data: [{ id: '301', type: 'albums' }] } } }] } }
      }
      return { ok: true, status: 200, data: { data: [] } }
    })

    const page = await web.fetchAppleHomePage('cn')
    const recentIndex = page.sections.findIndex(section => section.id === 'home-recent-played')
    const addedIndex = page.sections.findIndex(section => section.id === 'home-recently-added')
    expect(recentIndex).toBeGreaterThan(-1)
    expect(addedIndex).toBeGreaterThan(recentIndex)
    expect(page.sections[recentIndex].items[0]).toMatchObject({ playId: '101', type: 'songs' })
  })

  it('requests web recommendation media fields and preserves recent track relationships', async () => {
    mocks.recent.mockResolvedValue([{
      id: 'recent-song',
      name: 'Recent Song',
      artistName: 'Artist',
      artistId: 'artist-1',
      albumId: 'album-1',
      artworkUrl: 'recent.jpg',
      durationMs: 1000,
    }])
    mocks.api.mockImplementation(async (path: string) => {
      if (path.includes('/v1/me/recommendations')) {
        expect(path).toContain('name=listen-now')
        expect(path).toContain('displayFilter%5Bkind%5D=MusicCircleCoverShelf')
        expect(path).toContain('extend=editorialArtwork,editorialVideo,plainEditorialCard,plainEditorialNotes')
        expect(path).toContain('types=activities,albums,apple-curators')
        expect(path).toContain('with=friendsMix,library,social')
        return { ok: true, status: 200, data: { data: [] } }
      }
      return { ok: true, status: 200, data: { data: [] } }
    })

    const page = await web.fetchAppleHomePage('cn')
    const recent = page.sections.find(section => section.id === 'home-recent-played')
    expect(recent?.items[0]).toMatchObject({ artistId: 'artist-1', albumId: 'album-1' })
  })

  it('keeps editorial video URLs with query parameters on recommendation resources', async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path.includes('/v1/me/recommendations')) {
        return {
          ok: true,
          status: 200,
          data: {
            data: [{
              attributes: { title: '推荐' },
              relationships: {
                contents: {
                  data: [{
                    id: 'pl-motion',
                    type: 'playlists',
                    attributes: {
                      name: '动态推荐',
                      artwork: { url: 'poster/{w}x{h}.jpg' },
                      editorialVideo: {
                        motionDetailSquare: {
                          video: 'https://cdn.example/motion.m3u8?token=abc',
                          previewFrame: { url: 'https://cdn.example/frame/{w}x{h}.jpg' },
                        },
                      },
                    },
                  }],
                },
              },
            }],
          },
        }
      }
      return { ok: true, status: 200, data: { data: [] } }
    })

    const page = await web.fetchAppleHomePage('cn')
    const item = page.sections.flatMap(section => section.items).find(entry => entry.id === 'pl-motion')
    expect(item).toMatchObject({ motionArtworkUrl: 'https://cdn.example/motion.m3u8?token=abc' })
    expect(item?.motionPosterUrl).toBe('https://cdn.example/frame/{w}x{h}.jpg')
  })

  it('keeps the mixed homepage featured shelf instead of filtering it to playlists', async () => {
    mocks.recent.mockResolvedValue([])
    mocks.api.mockImplementation(async (path: string) => {
      if (path.includes('/v1/me/recommendations')) {
        return {
          ok: true,
          status: 200,
          data: {
            data: [{
              // 官网「专属精选推荐」的 display.kind 就是 MusicNotesHeroShelf（大卡货架）。
              attributes: { stringForDisplay: '专属精选推荐', display: { kind: 'MusicNotesHeroShelf' } },
              relationships: {
                contents: {
                  data: [
                    { id: 'next-song', type: 'songs', attributes: { name: 'King & Prince', artistName: 'King & Prince' } },
                    { id: 'explore-station', type: 'stations', attributes: { name: '探索电台', artwork: { url: 'station.jpg' } } },
                    { id: 'mood-station', type: 'stations', attributes: { name: '开心能量棒', artwork: { url: 'mood.jpg' } } },
                  ],
                },
              },
            }],
          },
        }
      }
      return { ok: true, status: 200, data: { data: [] } }
    })

    const page = await web.fetchAppleHomePage('cn')
    const featured = page.sections[0]
    expect(featured.kind).toBe('home-featured')
    expect(featured.title).toBe('专属精选推荐')
    expect(featured.items.map(item => item.name)).toEqual(['King & Prince', '探索电台', '开心能量棒'])
  })

  it('merges full editorial presentation resources into relationship cards', async () => {
    mocks.api.mockImplementation(async (path: string) => {
      if (path.includes('/v1/me/recommendations')) {
        return {
          ok: true,
          status: 200,
          data: {
            data: [{
              id: 'group-1',
              type: 'personal-recommendation',
              attributes: { title: '专属精选推荐', display: { kind: 'MusicNotesHeroShelf' } },
              relationships: { contents: { data: [{ id: 'playlist-1', type: 'playlists' }] } },
            }],
            resources: {
              'personal-recommendation': {
                'group-1': {
                  id: 'group-1', type: 'personal-recommendation',
                  attributes: { title: '专属精选推荐', display: { kind: 'MusicNotesHeroShelf' } },
                  relationships: { contents: { data: [{ id: 'playlist-1', type: 'playlists' }] } },
                },
              },
              playlists: {
                'playlist-1': {
                  id: 'playlist-1', type: 'playlists',
                  attributes: {
                    name: '放松歌单',
                    artwork: { url: 'static.jpg' },
                    plainEditorialNotes: { name: '专属推荐', tagline: '舒缓旋律' },
                    plainEditorialCard: {
                      primary: {
                        editorialVideo: { motionDetailTall: { video: 'https://cdn.example/relax.m3u8?sig=1', previewFrame: { url: 'https://cdn.example/relax-frame.jpg' } } },
                        editorialArtwork: { staticDetailTall: { url: 'https://cdn.example/relax-art.jpg' } },
                        plainEditorialNotes: { name: '专属推荐', tagline: '舒缓旋律' },
                      },
                    },
                  },
                },
              },
            },
          },
        }
      }
      return { ok: true, status: 200, data: { data: [] } }
    })

    const page = await web.fetchAppleHomePage('cn')
    const item = page.sections[0]?.items[0]
    expect(page.sections[0]?.displayKind).toBe('MusicNotesHeroShelf')
    expect(item).toMatchObject({
      name: '放松歌单',
      editorialLabel: '专属推荐',
      editorialTagline: '舒缓旋律',
      motionArtworkUrl: 'https://cdn.example/relax.m3u8?sig=1',
      motionPosterUrl: 'https://cdn.example/relax-frame.jpg',
      artworkUrl: 'https://cdn.example/relax-art.jpg',
    })
  })

  it('preserves each chart item type and every chart returned by Apple', async () => {
    mocks.api.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        results: {
          songs: [
            {
              chart: 'most-played',
              shortName: '热门歌曲',
              data: [
                { id: 'song-1', type: 'songs', attributes: { name: 'Song' } },
                { id: 'playlist-1', type: 'playlists', attributes: { name: 'Playlist' } },
              ],
            },
            {
              chart: 'new-releases',
              shortName: '新歌',
              data: [{ id: 'song-2', type: 'songs', attributes: { name: 'New Song' } }],
            },
          ],
          cityCharts: [{
            chart: 'city',
            shortName: '城市榜',
            data: [{ id: 'city-1', attributes: { name: 'City Playlist' } }],
          }],
        },
      },
    })

    const sections = await web.fetchAppleTopCharts('cn')

    expect(sections).toHaveLength(3)
    expect(sections[0].items.map(item => item.type)).toEqual(['songs', 'playlists'])
    expect(sections[1].items[0].type).toBe('songs')
    expect(sections[2].items[0].type).toBe('playlists')
    expect(new Set(sections.map(section => section.id)).size).toBe(3)
  })

  it('requests paginated library data at non-truncating limits and reports partial failures', async () => {
    mocks.songs.mockRejectedValue(new Error('songs unavailable'))
    mocks.api.mockResolvedValue({ ok: true, status: 200, data: { data: [] } })

    const page = await web.fetchAppleLibraryPage('cn')

    expect(mocks.songs).toHaveBeenCalledWith(5000)
    expect(mocks.albums).toHaveBeenCalledWith(2000)
    expect(mocks.artists).toHaveBeenCalledWith(1000)
    expect(mocks.playlists).toHaveBeenCalledWith(2000)
    expect(mocks.videos).toHaveBeenCalledWith(1000)
    expect(page.fallbackReason).toContain('歌曲')
    expect(page.personalized).toBe(true)
  })
})

describe('Apple new/discover page composition', () => {
  const songIds = (n: number) => Array.from({ length: n }, (_, i) => `song-${i}`)

  /** 真实形状的房间响应：data 只是 rooms 引用，完整对象在 resources.rooms，条目在 relationships.contents。 */
  const roomFixture = (opts: {
    roomId?: string
    title?: string
    resources?: Record<string, Record<string, any>>
    contents?: Array<{ id: string; type: string }>
  } = {}) => {
    const roomId = opts.roomId || '6810874540'
    const ids = songIds(100)
    const contents = opts.contents || ids.map(id => ({ id, type: 'songs' }))
    const songs = opts.resources?.songs || Object.fromEntries(ids.map((id, i) => [id, {
      id,
      type: 'songs',
      attributes: { name: `Song ${i}`, artistName: `Artist ${i}`, albumName: `Album ${i}`, durationInMillis: 200000 + i, url: `https://music.apple.com/cn/song/${id}` },
    }]))
    return {
      data: [{ id: roomId, type: 'rooms' }],
      resources: {
        rooms: {
          [roomId]: {
            id: roomId,
            type: 'rooms',
            attributes: { title: opts.title || '新歌精选', resourceTypes: ['songs'] },
            relationships: { contents: { data: contents } },
          },
        },
        songs,
        ...(opts.resources || {}),
      },
    }
  }

  /** 真实形状的编辑文档：grouping → tabs[0](editorial-elements 根) → children。 */
  const editorialFixture = (children: any[], extraElements: Record<string, any> = {}, extraResources: Record<string, any> = {}) => ({
    data: [{ id: '170828', type: 'groupings' }],
    resources: {
      groupings: {
        170828: {
          id: '170828',
          type: 'groupings',
          attributes: { name: '音乐' },
          relationships: { tabs: { data: [{ id: 'default', type: 'editorial-elements' }] } },
        },
      },
      'editorial-elements': {
        default: { id: 'default', type: 'editorial-elements', attributes: { editorialElementKind: '382' }, relationships: { children: { data: children } } },
        ...extraElements,
      },
      ...extraResources,
    },
  })

  it('requests the real rooms endpoint and parses the flat contents list', async () => {
    const paths: string[] = []
    mocks.api.mockImplementation(async (path: string) => {
      paths.push(path)
      return { ok: true, status: 200, data: roomFixture({ title: '新歌精选' }) }
    })

    const page = await web.fetchAppleRoomPage('6810874540', 'cn')

    expect(paths[0]).toContain('/v1/editorial/cn/rooms/6810874540')
    expect(paths[0]).toContain('format%5Bresources%5D=map')
    expect(paths[0]).not.toContain('ids%5Bgroupings%5D')
    const section = page.sections[0]
    // 房间是扁平 contents 列表：实测 100 首，不截断。
    expect(section.kind).toBe('song-grid')
    expect(section.items).toHaveLength(100)
    expect(section.items[0]).toMatchObject({ playId: 'song-0', albumName: 'Album 0', durationMs: 200000 })
    // 标题取 attributes.title。
    expect(page.sourceLabel).toContain('新歌精选')
  })

  it('keeps mixed-type room contents (playlists + albums)', async () => {
    mocks.api.mockResolvedValue({
      ok: true,
      status: 200,
      data: roomFixture({
        roomId: '6810874471',
        title: '大家都在听',
        contents: [{ id: 'pl.1', type: 'playlists' }, { id: 'al.1', type: 'albums' }],
        resources: {
          playlists: { 'pl.1': { id: 'pl.1', type: 'playlists', attributes: { name: 'Playlist A', curatorName: 'Apple Music' } } },
          albums: { 'al.1': { id: 'al.1', type: 'albums', attributes: { name: 'Album A', artistName: 'Artist A' } } },
        },
      }),
    })

    const page = await web.fetchAppleRoomPage('6810874471', 'cn')
    const section = page.sections[0]

    expect(section.items.map(item => item.type)).toEqual(['playlists', 'albums'])
    expect(section.kind).toBe('album-shelf')
  })

  it('reports an explicit failure when the room request yields no data', async () => {
    mocks.api.mockResolvedValue({ ok: true, status: 200, data: { data: [] } })

    const page = await web.fetchAppleRoomPage('999', 'cn')

    expect(page.sections).toHaveLength(0)
    expect(page.sourceLabel).toBe('room 取流失败')
  })

  it('reads 探索更多 from element kind 391 (labels come from the API) and 322 produces no section', async () => {
    const grid = {
      id: 'grid-1',
      type: 'editorial-elements',
      attributes: { editorialElementKind: '326', name: '歌单已更新', type: 'normal', displayStyle: 'compact' },
      relationships: {
        contents: { data: [{ id: 'pl.9', type: 'playlists' }] },
        room: { data: [{ id: '6810874671', type: 'rooms' }] },
      },
    }
    const explore = {
      id: 'explore-1',
      type: 'editorial-elements',
      attributes: {
        editorialElementKind: '391',
        name: '探索更多',
        links: [
          { label: '按风格浏览', url: 'https://itunes.apple.com/cn/collection/x/id178644?fcId=6456176470&mt=1' },
          { label: '排行榜', url: 'https://itunes.apple.com/WebObjects/MZStore.woa/wa/viewTop?genreId=34' },
          { label: '音乐视频', url: 'https://music.apple.com/WebObjects/MZStore.woa/wa/viewGrouping?cc=cn&id=170872' },
        ],
      },
    }
    const genreRow = {
      id: 'genres-1',
      type: 'editorial-elements',
      attributes: { editorialElementKind: '322', links: [{ label: '非洲音乐', url: 'https://music.apple.com/WebObjects/MZStore.woa/wa/viewGrouping?cc=cn&id=170932' }] },
    }
    mocks.api.mockResolvedValue({
      ok: true,
      status: 200,
      data: editorialFixture([grid, explore, genreRow], {}, {
        playlists: { 'pl.9': { id: 'pl.9', type: 'playlists', attributes: { name: 'P9' } } },
      }),
    })

    const page = await web.fetchAppleBrowsePage('cn')

    const exploreSection = page.sections.find(section => section.kind === 'explore-links')
    expect(exploreSection?.items.map(item => item.name)).toEqual(['按风格浏览', '排行榜', '音乐视频'])
    const grid9 = page.sections.find(section => section.title === '歌单已更新')
    // 区块入口来自 relationships.room，而不是 link.url。
    expect(grid9?.roomId).toBe('6810874671')
    expect(grid9?.layoutType).toBe('normal')
    expect(grid9?.displayStyle).toBe('compact')
    // 322 实测官网不渲染，因此不应产生区块。
    expect(page.sections.some(section => section.items.some(item => item.name === '非洲音乐'))).toBe(false)
  })

  it('renders element kind 404 as a text block and recurses through 382/316 containers', async () => {
    const textBlock = {
      id: 'qa-1',
      type: 'editorial-elements',
      attributes: { editorialElementKind: '404', title: '空间音频 Q&A', description: '<b>问：什么耳机能用？</b>\n答：兼容耳机即可。' },
    }
    const innerGrid = {
      id: 'grid-345',
      type: 'editorial-elements',
      attributes: { editorialElementKind: '345', title: '听见不同' },
      relationships: { contents: { data: [{ id: 'al.2', type: 'albums' }] }, room: { data: [{ id: '1643004587', type: 'rooms' }] } },
    }
    const container = {
      id: 'c-382',
      type: 'editorial-elements',
      attributes: { editorialElementKind: '382' },
      relationships: { children: { data: [textBlock, innerGrid] } },
    }
    mocks.api.mockResolvedValue({
      ok: true,
      status: 200,
      data: editorialFixture([container], {}, {
        albums: { 'al.2': { id: 'al.2', type: 'albums', attributes: { name: 'Album B', artistName: 'Artist B' } } },
      }),
    })

    const page = await web.fetchAppleGroupingPage('1643101724', 'cn')

    const text = page.sections.find(section => section.kind === 'text-block')
    expect(text?.title).toBe('空间音频 Q&A')
    expect(text?.bodyHtml).toContain('什么耳机能用')
    const shelf = page.sections.find(section => section.title === '听见不同')
    expect(shelf?.roomId).toBe('1643004587')
    expect(shelf?.items.map(item => item.name)).toEqual(['Album B'])
  })

  it('normalizes apple-curators into curators instead of dropping them', async () => {
    const curatorGrid = {
      id: 'grid-curators',
      type: 'editorial-elements',
      attributes: { editorialElementKind: '326', name: '来自全球', type: 'normal', displayStyle: 'compact' },
      relationships: { contents: { data: [{ id: '988656348', type: 'apple-curators' }] }, room: { data: [{ id: '6456176473', type: 'rooms' }] } },
    }
    mocks.api.mockResolvedValue({
      ok: true,
      status: 200,
      data: editorialFixture([curatorGrid], {}, {
        'apple-curators': { 988656348: { id: '988656348', type: 'apple-curators', attributes: { name: '非洲音乐', shortName: 'Apple Music 非洲音乐', url: 'https://music.apple.com/cn/curator/africa/988656348' } } },
      }),
    })

    const browse = await web.fetchAppleBrowsePage('cn')
    const section = browse.sections.find(entry => entry.title === '来自全球')

    expect(section?.items[0]).toMatchObject({ type: 'curators', name: '非洲音乐' })
  })

  it('resolves explore targets from legacy and modern URLs', () => {
    expect(web.resolveExploreTarget('https://itunes.apple.com/cn/collection/x/id178644?fcId=6456176470&mt=1')).toEqual({ kind: 'room', id: '6456176470' })
    expect(web.resolveExploreTarget('https://music.apple.com/WebObjects/MZStore.woa/wa/viewGrouping?cc=cn&id=170872')).toEqual({ kind: 'grouping', id: '170872' })
    expect(web.resolveExploreTarget('https://itunes.apple.com/WebObjects/MZStore.woa/wa/viewTop?genreId=34')).toEqual({ kind: 'charts' })
    expect(web.resolveExploreTarget('https://itunes.apple.com/WebObjects/MZStore.woa/wa/viewMultiRoom?cc=cn&fcId=1643101724&mt=1')).toEqual({ kind: 'multiroom', id: '1643101724' })
    expect(web.resolveExploreTarget('https://music.apple.com/cn/curator/apple-music-x/988656348')).toEqual({ kind: 'curator', id: '988656348' })
    expect(web.resolveExploreTarget('https://music.apple.com/cn/room/6810874540')).toEqual({ kind: 'room', id: '6810874540' })
    expect(web.resolveExploreTarget('')).toBeNull()
  })
})
