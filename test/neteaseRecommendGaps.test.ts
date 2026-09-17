import { describe, expect, it } from 'vitest'
import {
  neteaseBlockMoreTarget,
  normalizeNeteaseBlock,
  normalizeNeteaseResource,
  playQueueOf,
} from '../src/features/neteaseExplore/model'
import { classifyNeteaseBlock } from '../src/features/neteaseExplore/NeteaseResourceView'

// test/neteaseRecommendGaps.test.ts
// 覆盖 2026-09-17 逆向审计发现的推荐页缺口（真实抓包结构，见 docs/netease-recommend-gap-audit-2026-09-17.md）

/** 「根据你喜爱的歌曲推荐」的单曲卡：没有内嵌 song，也没有 action/orpheus，只有 playBtn + clickAction */
function playSongsCard(id: string, title: string, artist: string, queue: string[]) {
  return {
    resourceType: 'song',
    resourceId: id,
    title,
    coverUrl: `https://p1.music.126.net/${id}.jpg`,
    artistName: artist,
    recReason: '超76%人播放',
    tag: 'SQ',
    playBtn: { resourceId: id, playAction: { songIndex: 0, songIds: queue } },
    clickAction: { msg: { method: 'playSongs', module: 'nm.play', params: { songIndex: 0, songIds: queue } } },
  }
}

describe('推荐页缺口回归（playSongs 形态单曲卡）', () => {
  const queue = ['26131697', '419596411', '1862822901']

  it('抽出 playBtn/clickAction 里的整栏播放队列', () => {
    expect(playQueueOf(playSongsCard('26131697', '散花', '水月陵', queue))).toEqual(queue)
  })

  it('兼容服务端把 playBtn 序列化成 JSON 字符串的情况', () => {
    expect(playQueueOf({ resourceId: '1', playBtn: JSON.stringify({ playAction: { songIds: queue } }) })).toEqual(queue)
  })

  it('把无内嵌 song 的单曲卡补成可播放资源，而不是丢弃', () => {
    const resource = normalizeNeteaseResource(playSongsCard('26131697', '散花', '水月陵', queue), 0)
    expect(resource).not.toBeNull()
    expect(resource!.action.type).toBe('song')
    expect(resource!.song?.id).toBe(26131697)
    expect(resource!.song?.name).toBe('散花')
    expect(resource!.song?.artists.map(artist => artist.name)).toEqual(['水月陵'])
    // 封面来自卡片 coverUrl（旧逻辑漏读 coverUrl/coverImg）
    expect(resource!.coverUrl).toContain('26131697')
    // 推荐理由与角标
    expect(resource!.reason).toBe('超76%人播放')
    expect(resource!.badge).toBe('SQ')
    // 整栏队列可用于连播
    expect(resource!.playQueue).toEqual({ ids: queue, start: 0 })
  })

  it('整块 18 首不再归零（旧实现该块 resources=0，整块不渲染）', () => {
    const items = queue.map((id, index) => playSongsCard(id, `歌${index}`, '歌手', queue))
    const block = normalizeNeteaseBlock({
      positionCode: 'PAGE_RECOMMEND_RED_SIMILAR_SONG',
      dslData: { dslShowTitle: true, home_common_rcmd_songs_module_in_test_a72pm4gprt: { header: { title: '根据你喜爱的歌曲推荐' }, content: { items: [{ items }] } } },
    }, 0)
    expect(block.title).toBe('根据你喜爱的歌曲推荐')
    expect(block.resources).toHaveLength(3)
    expect(block.resources.every(resource => resource.action.type === 'song')).toBe(true)
  })
})

describe('推荐页缺口回归（区块标题散落在 dslData 各层模板节点）', () => {
  const cases: Array<[string, Record<string, any>, string]> = [
    ['blockResource.title（雷达歌单）', { blockResource: { title: 'YoshinoRinne的雷达歌单' } }, 'YoshinoRinne的雷达歌单'],
    ['模块节点内 blockResource.title（影视原声）', { home_page_common_playlist_module_x: { blockResource: { title: '影视原声' } } }, '影视原声'],
    ['模块节点内 header.title（循环不止的宝藏佳作）', { home_common_rcmd_module_y: { header: { title: '循环不止的「宝藏佳作」' } } }, '循环不止的「宝藏佳作」'],
    ['模块节点内 title（排行榜）', { rcmd_rank_module_z: { title: '排行榜' } }, '排行榜'],
    ['模块节点内 blockTitle（你关注的艺人新动向）', { home_artist_new_trends_title_w: { blockTitle: '你关注的艺人新动向' } }, '你关注的艺人新动向'],
  ]

  for (const [label, dslData, expected] of cases) {
    it(`解析 ${label}`, () => {
      const block = normalizeNeteaseBlock({ positionCode: 'PAGE_X', dslData: { dslShowTitle: true, ...dslData } }, 0)
      expect(block.title).toBe(expected)
    })
  }

  it('不会把卡片标题当成区块标题', () => {
    const block = normalizeNeteaseBlock({
      positionCode: 'PAGE_X',
      dslData: { module_a: { blockResource: { title: '', resources: [{ resourceId: '1', title: '某首歌' }] } } },
    }, 0)
    expect(block.title).toBe('')
  })
})

describe('推荐页缺口回归（每周新热趋势渲染 0 卡）', () => {
  it('名字带 NEW_SONG 但内容全是歌单时按封面墙渲染', () => {
    const resources = normalizeNeteaseBlock({
      positionCode: 'PAGE_RECOMMEND_NEW_SONG_AND_ALBUM',
      dslData: {
        module_a: {
          blockResource: {
            title: '每周新热趋势',
            resources: [1, 2, 3].map(index => ({
              resourceId: String(index),
              resourceType: 'playlist',
              title: `趋势歌单${index}`,
              coverImg: `https://p1.music.126.net/${index}.jpg`,
              action: `orpheus://nm/playlist/detail?id=${index}`,
            })),
          },
        },
      },
    }, 0).resources
    expect(resources).toHaveLength(3)
    // 旧实现返回 'songs' → SongShelf 渲染 0 张卡
    expect(classifyNeteaseBlock({ blockCode: 'PAGE_RECOMMEND_NEW_SONG_AND_ALBUM', showType: '', title: '每周新热趋势', subtitle: '', resources })).toBe('cover-shelf')
  })

  it('内容确实是歌曲时仍按歌曲列表渲染', () => {
    const resources = normalizeNeteaseBlock({
      positionCode: 'PAGE_RECOMMEND_DAILY_RECOMMEND',
      dslData: { module_a: { blockResource: { title: '每日推荐', resources: [{ resourceId: '1', resourceType: 'song', title: '歌', songData: { id: 1, name: '歌' } }] } } },
    }, 0).resources
    expect(classifyNeteaseBlock({ blockCode: 'PAGE_RECOMMEND_DAILY_RECOMMEND', showType: '', title: '每日推荐', subtitle: '', resources })).toBe('songs')
  })

  it('无资源时退回按区块语义判断（兼容旧 homepage 协议）', () => {
    expect(classifyNeteaseBlock({ blockCode: 'STYLE', showType: 'HOMEPAGE_BLOCK_STYLE_RCMD', title: '猜你喜欢的日文好歌', subtitle: '' })).toBe('songs')
    expect(classifyNeteaseBlock({ blockCode: 'SCENE', showType: 'HOMEPAGE_SCENE_PLAYLIST', title: '场景歌单', subtitle: '' })).toBe('cover-shelf')
  })
})

describe('推荐页缺口回归（雷达歌单封面角标）', () => {
  it('读出 resourceExtInfo.coverText 供封面左上角逐行显示', () => {
    const resource = normalizeNeteaseResource({
      resourceType: 'playList',
      resourceId: '3136952023',
      title: '今天从《Safe and Sound》听起',
      coverImg: 'https://p1.music.126.net/radar.jpg',
      resourceExtInfo: { coverText: ['私人', '雷达'] },
      action: 'orpheus://nm/playlist/detail?id=3136952023',
    }, 0)
    expect(resource!.coverLabel).toEqual(['私人', '雷达'])
  })

  it('没有 coverText 时不产生角标', () => {
    const resource = normalizeNeteaseResource({ resourceType: 'playList', resourceId: '1', title: '普通歌单', coverImg: 'https://x/y.jpg' }, 0)
    expect(resource!.coverLabel).toBeUndefined()
  })
})

describe('推荐页缺口回归（听精品有声书 / 广播 —— 曾被误排除）', () => {
  it('「听精品有声书」的 djradio 卡片解析为可站内打开的电台，而不是歌单', () => {
    // 实测抓包：卡片只有 `orpheus://nm/voicelist/detail?id=<radioId>`，
    // 旧 numericIdFromAction 把裸 id 一律当 playlist，导致有声书被误判成歌单。
    const resource = normalizeNeteaseResource({
      resourceType: 'djradio',
      resourceId: '982187334',
      title: '诡案缉凶',
      coverUrl: 'https://p1.music.126.net/book.jpg',
      orpheus: 'orpheus://nm/voicelist/detail?id=982187334&autoplayRecent=true&autoplayFirst=true',
      desc: '神秘的尸体杀人案件',
      subTitleFragment: '案件刑侦 · 2791万次播放',
    }, 0)
    expect(resource!.action.type).toBe('radio')
    if (resource!.action.type === 'radio') {
      expect(resource!.action.channel.id).toBe('982187334')
      expect(resource!.action.channel.name).toBe('诡案缉凶')
    }
  })

  it('「广播」里带 H5 兜底的电台卡走站内网页面板', () => {
    const resource = normalizeNeteaseResource({
      title: '张家港市融媒体中心综合广播',
      imageUrl: 'https://p6.music.126.net/radio.png',
      tag: '广播',
      action: 'orpheus://miniProgram?appId=5fc49fdba5c92810794ebea0&pageId=index%2Findex&query=from%3Dhome%26channelId%3D794&fallbackURL=https%3A%2F%2Fmp.music.163.com%2F5fc49fdba5a%2Findex%2Findex.html%3FchannelId%3D794',
    }, 0)
    expect(resource!.action.type).toBe('web')
    if (resource!.action.type === 'web') expect(resource!.action.url).toContain('mp.music.163.com')
  })

  it('「广播」里没有 H5 的小程序卡退回站内全部分类，不产生死卡', () => {
    const resource = normalizeNeteaseResource({
      title: '拉丁爵士',
      imageUrl: 'https://p6.music.126.net/tag.png',
      tag: '爵士',
      action: 'orpheus://miniProgram?appId=5c9b6b9e6d39f88741984c87&query=from%3D24%26channelId%3D1280&pageId=index',
    }, 0)
    expect(resource!.action.type).toBe('podcast-categories')
  })

  it('两块整块都能渲染出卡片', () => {
    const audiobook = normalizeNeteaseBlock({
      positionCode: 'PAGE_RECOMMEND_PODCAST_AUDIO_BOOK',
      dslData: {
        home_podcast_book_rcmd_list_simplify_x: {
          header: { title: '听精品有声书', showMore: true, action: 'orpheus://nm/mainTab/select?tab=explore&exploreTabCode=vBook' },
          items: [{ items: [
            { resourceType: 'djradio', resourceId: '982187334', title: '诡案缉凶', coverUrl: 'https://a/b.jpg', orpheus: 'orpheus://nm/voicelist/detail?id=982187334' },
            { resourceType: 'djradio', resourceId: '977405437', title: '人类的群星闪耀时', coverUrl: 'https://a/c.jpg', orpheus: 'orpheus://nm/voicelist/detail?id=977405437' },
          ] }],
        },
      },
    }, 0)
    expect(audiobook.title).toBe('听精品有声书')
    expect(audiobook.resources).toHaveLength(2)

    const broadcast = normalizeNeteaseBlock({
      positionCode: 'PAGE_RECOMMEND_BROADCAST',
      dslData: {
        home_common_title_x: { showMore: true, title: '广播' },
        podcast_broadcast_list_x: {
          commonTitle: { showMore: true, title: '广播' },
          items: [{ title: '苏州儿童广播', imageUrl: 'https://p6.music.126.net/r.png', tag: '广播', action: 'orpheus://miniProgram?appId=x&fallbackURL=https%3A%2F%2Fmp.music.163.com%2Fx%2Findex.html' }],
        },
      },
    }, 0)
    expect(broadcast.title).toBe('广播')
    expect(broadcast.resources).toHaveLength(1)
  })
})

describe('推荐页缺口回归（区块「更多」落点）', () => {  it('排行榜块按服务端 showMore 动作跳到发现-音乐-排行榜', () => {
    const block = normalizeNeteaseBlock({
      positionCode: 'PAGE_RECOMMEND_RANK',
      dslData: { rcmd_rank_module_l: { showMore: true, action: 'orpheus://nm/mainTab/select?tab=explore&exploreTabCode=music&subParams={"tabCode":"chart"}', title: '排行榜' } },
    }, 0)
    expect(block.moreActionUrl).toContain('exploreTabCode=music')
    expect(neteaseBlockMoreTarget(block)).toEqual({ kind: 'discover', tab: 'music', channelCode: 'chart' })
  })

  it('艺人热门金曲的更多指向该艺人主页', () => {
    const block = normalizeNeteaseBlock({
      positionCode: 'PAGE_RECOMMEND_MIXED_ARTIST_PLAYLIST',
      dslData: { blockResource: { showMore: true, action: 'orpheus://nm/artist/home?id=22492', title: '女王蜂等艺人热门金曲' } },
    }, 0)
    expect(neteaseBlockMoreTarget(block)).toEqual({ kind: 'artist', artistId: '22492' })
  })

  it('播客块跳到发现-播客，新歌块跳到精选', () => {
    expect(neteaseBlockMoreTarget({ blockCode: 'PAGE_RECOMMEND_PODCAST_AUDIO_BOOK' })).toEqual({ kind: 'discover', tab: 'podcast' })
    expect(neteaseBlockMoreTarget({ blockCode: 'PAGE_RECOMMEND_NEW_SONG_AND_ALBUM' })).toEqual({ kind: 'discover', tab: 'music', channelCode: 'feature' })
  })

  it('没有落点的块返回 null（不渲染「更多」按钮）', () => {
    expect(neteaseBlockMoreTarget({ blockCode: 'PAGE_RECOMMEND_GREETING' })).toBeNull()
    expect(neteaseBlockMoreTarget({ blockCode: 'PAGE_RECOMMEND_DAILY_RECOMMEND' })).toBeNull()
  })
})
