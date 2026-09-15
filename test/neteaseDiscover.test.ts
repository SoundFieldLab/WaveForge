import { describe, expect, it } from 'vitest'
import {
  filterNeteaseAdResources,
  isNeteaseAdResource,
  isNeteaseExcludedPosition,
  neteaseResourceArtwork,
  normalizeNeteaseBlock,
  normalizeNeteaseLinkPage,
  normalizeNeteaseResource,
  normalizeNeteaseShortcuts,
  type NeteaseNativeResource,
} from '../src/features/neteaseExplore/model'
import {
  normalizeNeteaseCubeBlocks,
  normalizeNeteaseCubePage,
  normalizeNeteasePodcastBlocks,
  normalizeNeteasePodcastHome,
  normalizeNeteaseSquareBlocks,
  normalizeNeteaseToplistBlocks,
} from '../src/features/neteaseExplore/discover'
import { discoverTargetForBlock } from '../src/features/neteaseExplore/NeteaseExplorePage'

// 网易云 9.5.90 Link Platform 响应结构（来源：docs/netease-discover-reverse-2026-09-13.md）

const linkPagePayload = {
  code: 200,
  accountScoped: true,
  data: {
    cursor: 11,
    hasMore: true,
    blockCodeOrderList: ['PAGE_DISCOVERY_QUALITY_SONG_LIST', 'PAGE_RECOMMEND_PODCAST_AUDIO_BOOK'],
    blocks: [
      {
        positionCode: 'PAGE_DISCOVERY_QUALITY_SONG_LIST',
        bizCode: 'PAGE_DISCOVERY_QUALITY_SONG_LIST',
        dslData: {
          blockResource: {
            title: '甄选歌单',
            resources: [
              { resourceId: '7829959298', resourceType: 'playlist', title: '欧美高燃踩点', coverImg: 'http://p1.music.126.net/a.jpg', action: 'orpheus://playlist/7829959298' },
            ],
          },
        },
      },
      {
        positionCode: 'PAGE_RECOMMEND_PODCAST_AUDIO_BOOK',
        bizCode: 'PAGE_RECOMMEND_PODCAST_AUDIO_BOOK',
        dslData: {
          blockResource: {
            title: '听精品有声书',
            resources: [
              { resourceId: '1', resourceType: 'voice', title: '有声书', coverImg: 'http://p1.music.126.net/b.jpg', action: 'orpheus://voice/1' },
            ],
          },
        },
      },
      {
        positionCode: 'PAGE_DISCOVERY_BANNER',
        bizCode: 'PAGE_DISCOVERY_BANNER',
        dslData: {
          data: {
            showMore: true,
            resources: [
              { resourceId: '9', resourceType: 'song', title: '鲍比跨时空对话神曲', coverImg: 'http://p1.music.126.net/c.jpg', action: 'orpheus://song/9' },
              { resourceId: '10', resourceType: 'playlist', title: '正常歌单', coverImg: 'http://p1.music.126.net/d.jpg', action: 'orpheus://playlist/10' },
            ],
          },
        },
      },
    ],
  },
}

describe('normalizeNeteaseLinkPage', () => {
  const page = normalizeNeteaseLinkPage(linkPagePayload)

  it('从 dslData.blockResource 提取资源并保留真实封面', () => {
    const block = page.blocks.find(item => item.blockCode === 'PAGE_DISCOVERY_QUALITY_SONG_LIST')
    expect(block?.title).toBe('甄选歌单')
    expect(block?.resources).toHaveLength(1)
    expect(block!.resources[0].coverUrl).toBe('https://p1.music.126.net/a.jpg')
    expect(block!.resources[0].action.type).toBe('playlist')
    if (block!.resources[0].action.type === 'playlist') expect(block!.resources[0].action.playlist.id).toBe('7829959298')
  })

  it('过滤听精品有声书等排除模块', () => {
    expect(page.blocks.some(block => block.blockCode === 'PAGE_RECOMMEND_PODCAST_AUDIO_BOOK')).toBe(false)
    expect(isNeteaseExcludedPosition('PAGE_RECOMMEND_PODCAST_AUDIO_BOOK')).toBe(true)
    expect(isNeteaseExcludedPosition('INFINITE_PODCAST_HOMEPAGE_VOICEBOOK_TAB')).toBe(true)
  })

  it('过滤鲍比等广告推广资源', () => {
    const banner = page.blocks.find(block => block.blockCode === 'PAGE_DISCOVERY_BANNER')
    expect(banner?.resources.map(resource => resource.title)).toEqual(['正常歌单'])
    expect(isNeteaseAdResource({ title: '鲍比跨时空对话神曲' } as NeteaseNativeResource)).toBe(true)
    expect(filterNeteaseAdResources([{ title: '普通歌曲' } as NeteaseNativeResource])).toHaveLength(1)
  })

  it('按 blockCodeOrderList 排序并保留 cursor/hasMore', () => {
    expect(page.cursor).toBe('11')
    expect(page.hasMore).toBe(true)
    expect(page.blockCodeOrderList).toEqual(['PAGE_DISCOVERY_QUALITY_SONG_LIST', 'PAGE_RECOMMEND_PODCAST_AUDIO_BOOK'])
  })
})

describe('normalizeNeteaseShortcuts', () => {
  it('解析 PAGE_RECOMMEND_SHORTCUT 卡片并带封面', () => {
    const shortcuts = normalizeNeteaseShortcuts({
      data: {
        blocks: [{
          positionCode: 'PAGE_RECOMMEND_SHORTCUT',
          dslData: {
            dslShowTitle: false,
            data: {
              showMore: true,
              resources: [
                { resourceId: '2614343690', title: '每日推荐', coverImg: 'http://p1.music.126.net/e.jpg', action: 'orpheus://nm/play/dailySong?resourceId=2614343690' },
                { resourceId: '2', title: '漫游', coverImg: 'http://p1.music.126.net/f.jpg', action: 'orpheus://nm/play/fm' },
              ],
            },
          },
        }],
      },
    })
    expect(shortcuts).toHaveLength(2)
    expect(shortcuts[0].title).toBe('每日推荐')
    expect(shortcuts[0].coverUrl).toBe('https://p1.music.126.net/e.jpg')
  })
})

describe('normalizeNeteaseToplistBlocks', () => {
  it('把排行榜 data[] 变成封面卡片区块', () => {
    const blocks = normalizeNeteaseToplistBlocks([
      { id: 19723756, name: '飙升榜', coverImgUrl: 'http://p1.music.126.net/g.jpg', updateFrequency: '每天更新', tracks: [{ id: 1 }, { id: 2 }] },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].title).toBe('排行榜')
    expect(blocks[0].resources[0].action.type).toBe('playlist')
    expect(blocks[0].resources[0].coverUrl).toBe('https://p1.music.126.net/g.jpg')
  })
})

describe('normalizeNeteaseSquareBlocks', () => {
  it('解析歌单广场 blocks.creatives', () => {
    const blocks = normalizeNeteaseSquareBlocks({
      data: {
        blocks: [{
          showType: 'PLAYLIST_SQUARE_SINGLE_SLID',
          blockCode: 'PLAYLIST_SQUARE_COMMON_RECOMMEND',
          uiElement: { mainTitle: { title: '音乐新发现' } },
          creatives: [{ creativeId: 1, resourceId: '123', resourceType: 'playlist', action: 'orpheus://playlist/123', uiElement: { mainTitle: { title: '歌单A' }, image: { imageUrl: 'http://p1.music.126.net/h.jpg' } } }],
        }],
      },
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].title).toBe('音乐新发现')
    expect(blocks[0].resources[0].coverUrl).toBe('https://p1.music.126.net/h.jpg')
  })
})

describe('normalizeNeteaseCubeBlocks', () => {
  it('从 cube 组件树按标题分段提取歌单', () => {
    const blocks = normalizeNeteaseCubeBlocks({
      data: {
        pageProtocol: {
          pages: [{
            componentName: 'Page',
            children: [{
              componentName: 'MusicGenreSongList',
              children: [
                { componentName: 'Title', props: { mainTitle: '次元职人' }, children: [] },
                { componentName: 'Grid', props: {}, children: [
                  { componentName: 'Playlist', props: { id: '6686195533', title: '穿越次元的心动', coverUrl: 'http://p1.music.126.net/i.jpg', playCount: 475169 }, children: [] },
                ] },
                { componentName: 'Title', props: { mainTitle: '热门歌单' }, children: [] },
                { componentName: 'Scroll', props: {}, children: [
                  { componentName: 'Entrance', props: { title: 'Ado', coverUrl: 'http://p1.music.126.net/j.jpg', action: { type: 'resource', params: { query: '8873757534', resourceType: 'playlist' } } }, children: [] },
                ] },
              ],
            }],
          }],
        },
      },
    })
    expect(blocks.map(block => block.title)).toEqual(['次元职人', '热门歌单'])
    expect(blocks[0].resources[0].title).toBe('穿越次元的心动')
    expect(blocks[0].resources[0].coverUrl).toBe('https://p1.music.126.net/i.jpg')
    expect(blocks[1].resources[0].action.type).toBe('playlist')
  })
})

describe('normalizeNeteasePodcastBlocks', () => {
  it('解析播客无限流 blockVOS', () => {
    const blocks = normalizeNeteasePodcastBlocks({
      data: {
        blockVOS: [{
          blockCode: 'PODCAST_RCMD_FOR_YOU',
          uiElement: { mainTitle: { title: '为你推荐' } },
          resources: [{ resourceId: '3715608827', resourceType: 'voice', title: '节目A', coverImg: 'http://p1.music.126.net/k.jpg', action: 'orpheus://program/3715608827' }],
        }],
      },
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].title).toBe('为你推荐')
    expect(blocks[0].resources[0].coverUrl).toBe('https://p1.music.126.net/k.jpg')
    expect(blocks[0].resources[0].action.type).toBe('program')
  })
})

describe('normalizeNeteaseCubePage', () => {
  it('识别 StickyTabs/TabItem 模板为页内子 Tab', () => {
    const page = normalizeNeteaseCubePage({
      data: {
        pageProtocol: {
          pages: [{
            componentName: 'Page',
            children: [{
              componentName: 'StickyTabs',
              children: [
                { componentName: 'TabHeader', children: [] },
                {
                  componentName: 'TabItem', props: { title: 'R&B' }, children: [
                    { componentName: 'Text', props: { content: '编年' }, children: [] },
                    { componentName: 'Grid', children: [
                      { componentName: 'Entrance', props: { title: 'R&B岁月留声', coverUrl: 'http://p1.music.126.net/x.jpg', action: { type: 'resource', params: { query: '1', resourceType: 'playlist' } } }, children: [] },
                    ] },
                  ],
                },
                {
                  componentName: 'TabItem', props: { title: '摇滚' }, children: [
                    { componentName: 'Text', props: { content: '摇滚50年代' }, children: [] },
                    { componentName: 'Grid', children: [
                      { componentName: 'Entrance', props: { title: '摇滚70年代', coverUrl: 'http://p1.music.126.net/y.jpg', action: { type: 'resource', params: { query: '2', resourceType: 'playlist' } } }, children: [] },
                    ] },
                  ],
                },
              ],
            }],
          }],
        },
      },
    })
    expect(page.tabs.map(tab => tab.title)).toEqual(['R&B', '摇滚'])
    expect(page.tabs[0].blocks[0].title).toBe('编年')
    expect(page.tabs[0].blocks[0].resources[0].action.type).toBe('playlist')
    expect(page.tabs[1].blocks[0].resources[0].coverUrl).toBe('https://p1.music.126.net/y.jpg')
  })

  it('识别 MusicGenreSongList/MusicGenreSongListItem 模板', () => {
    const page = normalizeNeteaseCubePage({
      data: {
        pageProtocol: {
          pages: [{
            componentName: 'Page',
            children: [{
              componentName: 'MusicGenreSongList',
              props: { tab: 17001 },
              children: [
                { componentName: 'MusicGenreSongListItem', props: { title: '次元职人' }, children: [
                  { componentName: 'Grid', children: [{ componentName: 'Playlist', props: { id: '6686195533', title: '穿越次元的心动', coverUrl: 'http://p1.music.126.net/z.jpg', playCount: 1 } }] },
                ] },
                { componentName: 'MusicGenreSongListItem', props: { title: '原声带精选' }, children: [
                  { componentName: 'Grid', children: [{ componentName: 'Playlist', props: { id: '2', title: 'OST', coverUrl: 'http://p1.music.126.net/w.jpg' } }] },
                ] },
              ],
            }],
          }],
        },
      },
    })
    expect(page.tabs.map(tab => tab.title)).toEqual(['次元职人', '原声带精选'])
    expect(page.tabs[0].blocks[0].resources[0].coverUrl).toBe('https://p1.music.126.net/z.jpg')
    // 兼容旧接口
    expect(normalizeNeteaseCubeBlocks({ data: { pageProtocol: { pages: [{ componentName: 'Page', children: [] }] } } })).toEqual([])
  })
})

describe('normalizeNeteasePodcastHome', () => {
  it('拆分龙珠固定入口与内容区块', () => {
    const home = normalizeNeteasePodcastHome({
      data: {
        blockVOS: [
          {
            blockCode: 'FINITE_DRAGONBALL',
            creatives: [
              { creativeId: 1, resourceId: '1', resourceType: 'podcastTab', action: 'orpheus://podcast/mine', uiElement: { mainTitle: { title: '我的播客' }, image: { imageUrl: 'http://p1.music.126.net/p.jpg' } } },
            ],
          },
          {
            blockCode: 'RCMD_FOR_YOU',
            uiElement: { mainTitle: { title: '为你推荐' } },
            creatives: [
              { creativeId: 2, resourceId: '3715608827', resourceType: 'voice', action: 'orpheus://program/3715608827', uiElement: { mainTitle: { title: '节目A' }, image: { imageUrl: 'http://p1.music.126.net/q.jpg' } } },
            ],
          },
        ],
      },
    })
    expect(home.quickEntries.map(entry => entry.title)).toEqual(['我的播客'])
    expect(home.blocks).toHaveLength(1)
    expect(home.blocks[0].title).toBe('为你推荐')
    expect(home.blocks[0].resources[0].coverUrl).toBe('https://p1.music.126.net/q.jpg')
  })
})

describe('discoverTargetForBlock', () => {
  it('把推荐/精选区块映射到发现页频道', () => {
    expect(discoverTargetForBlock('PAGE_RECOMMEND_RANK')).toEqual({ tab: 'music', channelCode: 'chart' })
    expect(discoverTargetForBlock('PAGE_DISCOVERY_QUALITY_SONG_LIST')).toEqual({ tab: 'music', channelCode: 'playlist' })
    expect(discoverTargetForBlock('PAGE_DISCOVERY_NEWSONG_NEWALBUM')).toEqual({ tab: 'music', channelCode: 'feature' })
    expect(discoverTargetForBlock('PAGE_RECOMMEND_PODCAST_RADIO_PROGRAM')).toEqual({ tab: 'podcast' })
    expect(discoverTargetForBlock('PAGE_RECOMMEND_GREETING')).toBeNull()
  })
})

describe('Link Platform 翻页与区块识别（ADB 对照回归）', () => {
  it('blockCodeOrderList 为 JSON 字符串时也能解析并排序', () => {
    const page = normalizeNeteaseLinkPage({
      data: {
        cursor: 6,
        hasMore: true,
        blockCodeOrderList: '["PAGE_RECOMMEND_B","PAGE_RECOMMEND_A"]',
        blocks: [
          { positionCode: 'PAGE_RECOMMEND_A', dslData: { blockResource: { title: 'A', resources: [{ resourceId: '1', resourceType: 'playlist', title: 'a', coverImg: 'http://p1.music.126.net/a.jpg', action: 'orpheus://playlist/1' }] } } },
          { positionCode: 'PAGE_RECOMMEND_B', dslData: { blockResource: { title: 'B', resources: [{ resourceId: '2', resourceType: 'playlist', title: 'b', coverImg: 'http://p1.music.126.net/b.jpg', action: 'orpheus://playlist/2' }] } } },
        ],
      },
    })
    expect(page.blockCodeOrderList).toEqual(['PAGE_RECOMMEND_B', 'PAGE_RECOMMEND_A'])
    expect(page.blocks.map(block => block.title)).toEqual(['B', 'A'])
    expect(page.cursor).toBe('6')
  })

  it('cube 轮播卡片（无标题、background + link action）仍被提取', () => {
    const page = normalizeNeteaseCubePage({
      data: {
        pageProtocol: {
          pages: [{
            componentName: 'Page',
            children: [{
              componentName: 'MusicGenreSongList',
              children: [
                { componentName: 'MusicGenreSongListItem', props: { title: '全部' }, children: [
                  { componentName: 'RecommendTabCarousel', props: { carousel: [{ background: 'http://p1.music.126.net/banner.jpg', action: { type: 'link', params: { url: 'https://y.music.163.com/g/yida/x' } } }] }, children: [] },
                  { componentName: 'Grid', children: [{ componentName: 'Playlist', props: { id: '1', title: 'p', coverUrl: 'http://p1.music.126.net/p.jpg' } }] },
                ] },
                { componentName: 'MusicGenreSongListItem', props: { title: '时空隧道' }, children: [
                  { componentName: 'RecommendHorizontal', props: { title: '需要客户端再拉取' }, children: [] },
                ] },
              ],
            }],
          }],
        },
      },
    })
    expect(page.tabs.map(tab => tab.title)).toEqual(['全部', '时空隧道'])
    const banner = page.tabs[0].blocks.flatMap(block => block.resources).find(resource => resource.action.type === 'web')
    expect(banner?.coverUrl).toBe('https://p1.music.126.net/banner.jpg')
    // 数据由客户端运行时再拉取的页签不丢弃，只是内容为空
    expect(page.tabs[1].blocks).toHaveLength(0)
  })

  it('播客无限流：龙珠固定入口含 7 项（含排行榜）', () => {
    const home = normalizeNeteasePodcastHome({
      data: {
        blockVOS: [
          {
            blockCode: 'DRAGONBALL',
            creatives: ['我的播客', '全部分类', '排行榜', '音乐播客', '对话现场', '助眠解压', '广播电台'].map((title, index) => ({
              creativeId: index + 1, resourceType: 'podcastTab', action: `orpheus://tab/${index}`,
              uiElement: { mainTitle: { title }, images: [{ imageUrl: `http://p1.music.126.net/${index}.jpg` }] },
            })),
          },
          { blockCode: 'GUESS_LIKE', uiElement: { mainTitle: { title: '猜你喜欢' } }, creatives: [] },
        ],
      },
    })
    expect(home.quickEntries.map(entry => entry.title)).toEqual(['我的播客', '全部分类', '排行榜', '音乐播客', '对话现场', '助眠解压', '广播电台'])
  })
})

describe('ADB 对照回归（第二轮）', () => {
  it('创意卡带 resources 时仍保留自身封面（音乐新发现六张卡）', () => {
    const blocks = normalizeNeteaseSquareBlocks({
      data: {
        blocks: [{
          showType: 'PLAYLIST_SQUARE_SINGLE_SLID',
          blockCode: 'PLAYLIST_SQUARE_COMMON_RECOMMEND',
          uiElement: { mainTitle: { title: '音乐新发现' } },
          creatives: [{
            creativeId: 14060278987,
            creativeType: 'list',
            action: { clickAction: { targetUrl: 'orpheus://playlist/14060278987' } },
            uiElement: { mainTitle: { title: '孤独唱片店' }, images: [{ imageUrl: 'http://p1.music.126.net/discover.jpg' }] },
            resources: [{ resourceType: 'playlist', resourceId: '14060278987', resourceExt: { playCount: 4275565 } }],
          }],
        }],
      },
    })
    expect(blocks[0].resources[0].coverUrl).toBe('https://p1.music.126.net/discover.jpg')
    expect(neteaseResourceArtwork(blocks[0].resources[0])).toContain('discover.jpg')
    expect(blocks[0].resources[0].action.type).toBe('playlist')
  })

  it('cube recommendModule：cover+resource 歌单卡与 fm 一键播放卡', () => {
    const page = normalizeNeteaseCubePage({
      data: {
        pageProtocol: {
          pages: [{
            componentName: 'Page',
            children: [{
              componentName: 'MusicGenreSongList',
              children: [
                { componentName: 'MusicGenreSongListItem', props: { title: '全部' }, children: [
                  { componentName: 'RecommendHorizontal', props: { title: 'ACG主打', recommendModule: [{ title: 'tab1', modules: [{ cover: 'http://p5.music.126.net/fm.png', mode: 'SCENE_RCMD', subMode: 'ACG', type: 'fm', title: '24h不间断ACG频道 一键播放' }] }] } },
                  { componentName: 'RecommendHorizontal', props: { title: 'ACG热播', recommendModule: [{ modules: [{ cover: 'http://p1.music.126.net/hot.jpg', resource: 12509822645, type: 'song_list', title: '《我推的孩子》' }] }] } },
                  { componentName: 'RecommendHorizontal', props: { title: 'ACG专属', recommendModule: [{ modules: [{ resource: 17377921380, type: 'song_list', title: '轻抚你的疲惫' }] }] } },
                  { componentName: 'MusiclibraryRank', props: { playlistIds: '3001835560,3001795926', titles: 'ACG动画榜,ACG游戏榜', rankModuleTitle: '热门排行' } },
                ] },
                { componentName: 'MusicGenreSongListItem', props: { title: '动漫空间' }, children: [] },
              ],
            }],
          }],
        },
      },
    })
    const all = page.tabs.find(tab => tab.title === '全部')
    expect(all?.blocks.map(block => block.title)).toEqual(['ACG主打', 'ACG热播', 'ACG专属', '热门排行'])
    const fm = all?.blocks[0].resources[0]
    expect(fm?.action.type).toBe('fm')
    if (fm?.action.type === 'fm') expect([fm.action.fmMode, fm.action.subMode]).toEqual(['SCENE_RCMD', 'ACG'])
    expect(all?.blocks[1].resources[0].coverUrl).toBe('https://p1.music.126.net/hot.jpg')
    expect(all?.blocks[1].resources[0].action.type).toBe('playlist')
    // 只下发 id 的卡片也要保留（封面由 /tag-playlists 回填）
    expect(all?.blocks[2].resources[0].title).toBe('轻抚你的疲惫')
    // 榜单：逗号分隔的 titles 要拆开
    expect(all?.blocks[3].resources.map(r => r.title)).toEqual(['ACG动画榜', 'ACG游戏榜'])
  })

  it('similarFM：区分相似歌曲与相似艺人，解析自带种子', () => {
    const song = normalizeNeteaseResource({ resourceId: '1', resourceType: 'similarFm', action: 'orpheus://nm/play/similarFM?sourceId=[\\"448596416\\",\\"2\\"]&sourceType=song', title: '相似歌曲' }, 0)
    expect(song?.action.type).toBe('similar-songs')
    if (song?.action.type === 'similar-songs') expect(song.action.seedIds).toEqual(['448596416', '2'])
    const artist = normalizeNeteaseResource({ resourceId: '2', resourceType: 'similarFm', action: 'orpheus://nm/play/similarFM?sourceId=[14713120,510882]&sourceType=artist&sourceName=相似艺人', title: '相似艺人' }, 0)
    expect(artist?.action.type).toBe('similar-artists')
    if (artist?.action.type === 'similar-artists') expect(artist.action.artistIds).toEqual(['14713120', '510882'])
  })
})

describe('normalizeNeteaseBlock title from dslData', () => {
  it('读取 blockResource.title', () => {
    const block = normalizeNeteaseBlock({ positionCode: 'PAGE_DISCOVERY_STYLE_SONG_LIST', dslData: { blockResource: { title: '周末好时光', resources: [] } } }, 0)
    expect(block.title).toBe('周末好时光')
    expect(block.blockCode).toBe('PAGE_DISCOVERY_STYLE_SONG_LIST')
  })
})

describe('查漏补缺：服务端下发的"没目标"条目也要能用', () => {
  const action = (raw: any) => normalizeNeteaseResource(raw, 0)?.action

  it('songrcmd → 日推 / 风格日推', () => {
    expect(action({ resourceId: '1', resourceType: 'dailySongs', action: 'orpheus://songrcmd?tab=default&resourceId=1540959188', title: '每日推荐' }))
      .toEqual({ type: 'daily-rcmd', tab: 'default', categoryId: '', tagId: '', songId: '' })
    expect(action({ resourceId: '2', resourceType: 'dailySongs', action: 'orpheus://songrcmd?tab=style&categoryId=1000&tagId=10001&songId=3396264200', title: '风格日推' }))
      .toEqual({ type: 'daily-rcmd', tab: 'style', categoryId: '1000', tagId: '10001', songId: '3396264200' })
  })

  it('裸文案动作走语义执行（心动模式等）', () => {
    expect(action({ resourceId: '3', resourceType: 'x', action: '心动模式', title: '你的红心歌曲' })).toEqual({ type: 'semantic', text: '心动模式' })
  })

  it('播客入口映射为站内页面 / 全部分类', () => {
    expect(action({ resourceId: '4', resourceType: 'x', action: 'orpheus://rnpage?component=rn-podcast-my&route=my', title: '我的播客' })).toEqual({ type: 'podcast-mine' })
    expect(action({ resourceId: '5', resourceType: 'x', action: 'orpheus://nm/voice/category', title: '全部分类' })).toEqual({ type: 'podcast-categories' })
    expect(action({ resourceId: '6', resourceType: 'x', action: 'orpheus://miniProgram?appId=6018f69c', title: '助眠解压' })).toEqual({ type: 'podcast-categories' })
  })

  it('纯装饰卡（无目标、无歌、无歌单）不再产出灰卡', () => {
    const block = normalizeNeteaseBlock({
      blockCode: 'B',
      resources: [
        { resourceId: 'deco-1', resourceType: 'x', title: '推荐内容', coverImg: 'http://p1.music.126.net/deco.jpg' },
        { resourceId: 'real-1', resourceType: 'playlist', title: '正常歌单', action: 'orpheus://playlist/1' },
      ],
    }, 0)
    expect(block.resources.map(r => r.title)).toEqual(['正常歌单'])
  })

  it('电台列表归一化为可打开的播客资源', async () => {
    const { normalizeNeteaseRadioResources } = await import('../src/features/neteaseExplore/discover')
    const resources = normalizeNeteaseRadioResources({
      data: { djRadios: [{ dj: { id: 970411486, nickname: '主播' }, id: 970411486, name: '肥话连篇', picUrl: 'http://p1.music.126.net/radio.jpg', playCount: 12345, desc: '聊天' }] },
    })
    expect(resources).toHaveLength(1)
    expect(resources[0].action.type).toBe('radio')
    expect(resources[0].coverUrl).toBe('https://p1.music.126.net/radio.jpg')
  })
})

describe('查漏补缺：剩余不可点条目已全部落地', () => {
  const action = (raw: any) => normalizeNeteaseResource(raw, 0)?.action

  it('cube rnpage → 站内 cube 页', () => {
    expect(action({ resourceId: 'x', resourceType: 'x', action: 'orpheus://rnpage?component=cube-renderer-rn&isTheme=true&page=36a536dd466743298a190343d1ed12b1', title: '宝藏音乐人' }))
      .toEqual({ type: 'cube-page', pageId: '36a536dd466743298a190343d1ed12b1', title: '宝藏音乐人' })
  })

  it('orpheus://activity 内的 https 走站内网页面板', () => {
    const act = action({ resourceId: 'y', resourceType: 'x', action: 'orpheus://activity?url=https%3A%2F%2Fmp.music.163.com%2Finvite%2Findex.html%3Fnm_style%3Dsbt', title: '会员专属权益' })
    expect(act?.type).toBe('web')
    if (act?.type === 'web') expect(act.url).toContain('mp.music.163.com/invite/index.html')
  })

  it('orph://song/<id> 与榜单内歌曲按歌曲详情播放', () => {
    expect(action({ resourceId: 'z', resourceType: 'x', action: 'orpheus://song/3434302948', title: '一无所有的我们' }))
      .toEqual({ type: 'song-id', id: '3434302948' })
    expect(action({ resourceId: '3434302948', resourceType: 'x', action: 'play_top_list_from_current_index', title: '海屿你' }))
      .toEqual({ type: 'song-id', id: '3434302948' })
  })
})

describe('空导航卡过滤（查漏补缺收尾）', () => {
  it('无封面无内容的语义跳转卡不再产出', () => {
    const block = normalizeNeteaseBlock({
      blockCode: 'NEW_SONG',
      resources: [
        { resourceId: 'nav-1', resourceType: 'x', action: 'orpheus://nm/discovery/newsongalbum?tab=song', title: '新歌新碟' },
        { resourceId: 'nav-2', resourceType: 'x', action: 'orpheus://nm/discovery/newsongalbum?tab=song', title: '新歌新碟带图', coverImg: 'http://p1.music.126.net/cover.jpg' },
      ],
    }, 0)
    expect(block.resources.map(r => r.title)).toEqual(['新歌新碟带图'])
  })
})
