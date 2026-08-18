import { describe, it, expect } from 'vitest'
import {
  normalizeText,
  cleanSongTitle,
  scoreCandidate,
  shouldAutoPlay,
  pickBestSubtitle,
  songKeyOf,
  classifyCandidateType,
  buildQueries,
  dedupeCandidates,
  getBilibiliBlacklist,
  addBilibiliBlacklist,
  getBilibiliWatchSettings,
  type MatchContext,
  type BilibiliVideo,
  type CandidateScore,
  type CandidateSignals,
} from '../src/services/bilibiliApi'

const ctx: MatchContext = { songTitle: '稻香', artists: ['周杰伦'], songDuration: 223, platform: 'netease', id: 123 }

const video = (partial: Partial<BilibiliVideo>): BilibiliVideo => ({
  bvid: 'BV1xxxx',
  title: '',
  duration: 0,
  play: 0,
  author: '',
  pic: '',
  typename: '音乐',
  ...partial,
})

/** 构造一个指定分数/信号的候选（门槛测试用） */
const fakeCandidate = (score: number, strong: boolean): CandidateScore => {
  const signals: CandidateSignals = {
    officialMarker: strong,
    mvMarker: false,
    negativeHit: false,
    hasArtist: true,
    nearDuration: true,
    hdMarker: false,
  }
  return {
    video: video({ title: '周杰伦 稻香 MV', duration: 223 }),
    score,
    signals,
    rank: 0,
    officialVerifyType: strong ? 1 : 0,
    manualZhSubtitle: false,
    autoSubtitle: false,
    type: 'official',
  }
}

describe('normalizeText（文本规范化）', () => {
  it('繁体转简体（B 站官方标题常用繁体）', () => {
    expect(normalizeText('周杰倫《稻香》')).toBe('周杰伦稻香')
  })
  it('全角转半角 + 去标点 + 小写', () => {
    expect(normalizeText('【Official】Never Gonna Give You Up - Rick Astley')).toBe('officialnevergonnagiveyouuprickastley')
    expect(normalizeText('周杰伦《稻香》超治愈神作！')).toBe('周杰伦稻香超治愈神作')
  })
})

describe('cleanSongTitle（歌名清洗）', () => {
  it('剥离括号后缀', () => {
    expect(cleanSongTitle('稻香（Live）')).toBe('稻香')
    expect(cleanSongTitle('光年之外 (Live in HK)')).toBe('光年之外')
  })
})

describe('classifyCandidateType（候选类型识别）', () => {
  it('按标题标记分类', () => {
    expect(classifyCandidateType('【官方MV】周杰倫《稻香》')).toBe('official')
    expect(classifyCandidateType('周杰伦《稻香》现场版 演唱会')).toBe('live')
    expect(classifyCandidateType('翻唱《稻香》')).toBe('cover')
    expect(classifyCandidateType('周杰伦《稻香》钢琴演奏')).toBe('instrumental')
    expect(classifyCandidateType('周杰伦《稻香》歌词字幕版')).toBe('lyrics')
    expect(classifyCandidateType('周杰伦《稻香》超治愈神作')).toBe('other')
  })
})

describe('scoreCandidate（候选打分）', () => {
  it('硬淘汰：歌名未完整出现在标题 → 无关视频，直接 -Infinity', () => {
    const wrong = scoreCandidate(video({ title: '【官方MV】晴天 - 周杰伦', duration: 269 }), ctx)
    expect(wrong.score).toBe(-Infinity)
  })

  it('官方 MV：完整命中 + 歌手 + 官方标记 + 机构认证 → 高分且自动播放', () => {
    const official = scoreCandidate(
      video({ title: '【官方MV】周杰倫《稻香》- Official Music Video', duration: 223, play: 10_000_000, author: '杰威尔音乐' }),
      ctx,
      { officialVerifyType: 2, manualZhSubtitle: true },
    )
    expect(official.score).toBeGreaterThanOrEqual(230)
    expect(official.signals.officialMarker).toBe(true)
    expect(official.signals.hasArtist).toBe(true)
    expect(official.type).toBe('official')
    expect(shouldAutoPlay(official)).toBe(true)
  })

  it('私藏馆类高播放搬运：匹配但无官方信号 → 不自动播放，进候选确认', () => {
    const remaster = scoreCandidate(
      video({ title: '【私藏馆】周杰伦《稻香》超治愈神作！', duration: 223, play: 9_260_000, author: '音乐私藏馆' }),
      ctx,
      { officialVerifyType: 0 },
    )
    expect(remaster.score).toBeGreaterThanOrEqual(150)
    expect(remaster.score).toBeLessThan(230)
    expect(shouldAutoPlay(remaster)).toBe(false)
  })

  it('教学/翻弹类：负向标记重罚，不自动播放', () => {
    const tutorial = scoreCandidate(video({ title: '周杰伦《稻香》吉他指弹详细讲解', duration: 400, play: 30_000 }), ctx)
    expect(shouldAutoPlay(tutorial)).toBe(false)
    expect(tutorial.score).toBeLessThan(100)
    expect(tutorial.type).toBe('instrumental')
  })

  it('翻唱：负向标记压制，不自动播放', () => {
    const cover = scoreCandidate(video({ title: '翻唱《稻香》周杰伦 完整版', duration: 240, play: 500_000 }), ctx, { officialVerifyType: 0 })
    expect(shouldAutoPlay(cover)).toBe(false)
    expect(cover.type).toBe('cover')
  })

  it('短歌名撞车惩罚：标题不含歌手时扣分', () => {
    const shortCtx: MatchContext = { songTitle: '晴天', artists: ['周杰伦'], songDuration: 269 }
    const noArtist = scoreCandidate(video({ title: '晴天 MV', duration: 269, play: 1_000_000 }), shortCtx)
    const withArtist = scoreCandidate(video({ title: '周杰伦 晴天 MV', duration: 269, play: 1_000_000 }), shortCtx)
    expect(withArtist.score).toBeGreaterThan(noArtist.score)
    expect(shouldAutoPlay(noArtist)).toBe(false)
  })

  it('时长偏离过远扣分（相对时长）', () => {
    const far = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 900 }), ctx)
    const close = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 220 }), ctx)
    expect(far.score).toBeLessThan(close.score)
  })

  it('相对时长：10 分钟的长歌，±60 秒仍算贴近（比例而非绝对差）', () => {
    const longCtx: MatchContext = { songTitle: '长歌', artists: ['歌手'], songDuration: 600 }
    const near = scoreCandidate(video({ title: '歌手 长歌 MV', duration: 660 }), longCtx)
    const far = scoreCandidate(video({ title: '歌手 长歌 MV', duration: 900 }), longCtx)
    expect(near.score).toBeGreaterThan(far.score)
    expect(near.signals.nearDuration).toBe(true)
  })

  it('搜索排名加权：靠前的结果更可信', () => {
    const top = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { rank: 0 })
    const bottom = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { rank: 25 })
    expect(top.score - bottom.score).toBeCloseTo(12)
  })

  it('官方频道关键词：作者名命中唱片公司/官方账号 → 加分', () => {
    const officialChannel = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '杰威尔音乐官方' }), ctx)
    const randomChannel = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '音乐分享君' }), ctx)
    expect(officialChannel.score - randomChannel.score).toBe(25)
  })

  it('分数 >= 230 且无官方信号也自动播放（全面强匹配）', () => {
    const strong = scoreCandidate(
      video({ title: '周杰伦 稻香 MV 官方字幕 4K', duration: 225, play: 100_000_000 }),
      ctx,
      { officialVerifyType: 0 },
    )
    expect(strong.score).toBeGreaterThanOrEqual(230)
    expect(shouldAutoPlay(strong)).toBe(true)
  })
})

describe('shouldAutoPlay（门槛随严格度）', () => {
  it('strict 严格：200 分 + 官方信号自动；180 分 + 官方信号不自动', () => {
    expect(shouldAutoPlay(fakeCandidate(200, true), 'strict')).toBe(true)
    expect(shouldAutoPlay(fakeCandidate(180, true), 'strict')).toBe(false)
    expect(shouldAutoPlay(fakeCandidate(300, false), 'strict')).toBe(true)
  })
  it('standard 标准：180 分 + 官方信号自动；160 分无信号不自动', () => {
    expect(shouldAutoPlay(fakeCandidate(180, true), 'standard')).toBe(true)
    expect(shouldAutoPlay(fakeCandidate(160, false), 'standard')).toBe(false)
    expect(shouldAutoPlay(fakeCandidate(240, false), 'standard')).toBe(true)
  })
  it('relaxed 宽松：190 分无信号自动；120 分无信号不自动', () => {
    expect(shouldAutoPlay(fakeCandidate(190, false), 'relaxed')).toBe(true)
    expect(shouldAutoPlay(fakeCandidate(150, true), 'relaxed')).toBe(true)
    expect(shouldAutoPlay(fakeCandidate(120, false), 'relaxed')).toBe(false)
  })
})

describe('偏好加权（preferenceAdjustment）', () => {
  // 可比视频：标题结构相同（都只带一个类型标记），时长一致
  const liveVideo = video({ bvid: 'BV1live', title: '周杰伦《稻香》演唱会现场版', duration: 240, play: 200_000 })
  const officialVideo = video({ bvid: 'BV1offi', title: '周杰伦《稻香》MV', duration: 223, play: 200_000 })

  it('现场偏好下现场版分数高于官方版', () => {
    const live = scoreCandidate(liveVideo, ctx, { preference: 'live' })
    const official = scoreCandidate(officialVideo, ctx, { preference: 'live' })
    expect(live.type).toBe('live')
    expect(official.type).toBe('official')
    expect(live.score).toBeGreaterThan(official.score)
  })

  it('官方偏好下官方版分数高于现场版', () => {
    const live = scoreCandidate(liveVideo, ctx, { preference: 'official' })
    const official = scoreCandidate(officialVideo, ctx, { preference: 'official' })
    expect(official.score).toBeGreaterThan(live.score)
  })

  it('高清偏好：标题带 4K/1080P/高清 加分（含基础标记共 30 分）', () => {
    const hd = scoreCandidate(video({ title: '周杰伦《稻香》MV 4K', duration: 223, play: 100_000 }), ctx, { preference: 'hd' })
    const normal = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { preference: 'hd' })
    expect(hd.score - normal.score).toBe(30) // +10 基础高清标记 +20 hd 偏好加权
  })

  it('歌词字幕偏好：歌词版分数更高', () => {
    const lyrics = scoreCandidate(video({ title: '周杰伦《稻香》歌词字幕', duration: 223, play: 100_000 }), ctx, { preference: 'lyrics' })
    const normal = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { preference: 'lyrics' })
    expect(lyrics.score).toBeGreaterThan(normal.score)
  })
})

describe('buildQueries（关键词构建）', () => {
  it('auto 均衡：歌名+歌手 / 歌名+MV', () => {
    expect(buildQueries(ctx)).toEqual(['稻香 周杰伦', '稻香 MV'])
  })
  it('auto 官方偏好：追加官方词', () => {
    expect(buildQueries(ctx, { matchPreference: 'official' })).toEqual(['稻香 周杰伦', '稻香 MV', '稻香 周杰伦 官方', '稻香 官方MV'])
  })
  it('auto 现场偏好：追加现场词', () => {
    expect(buildQueries(ctx, { matchPreference: 'live' })).toEqual(['稻香 周杰伦', '稻香 MV', '稻香 周杰伦 现场', '稻香 演唱会'])
  })
  it('自定义模板：占位符替换', () => {
    expect(buildQueries(ctx, { keywordTemplate: 'custom', customKeywordTemplate: '{title} {artist} 官方 4K' })).toEqual(['稻香 周杰伦 官方 4K'])
  })
  it('固定模板', () => {
    expect(buildQueries(ctx, { keywordTemplate: 'title-mv' })).toEqual(['稻香 MV'])
    expect(buildQueries(ctx, { keywordTemplate: 'title-artist' })).toEqual(['稻香 周杰伦'])
  })
})

describe('dedupeCandidates（近重复标题去重）', () => {
  it('规范化后同标题只留播放量最高者', () => {
    const a = scoreCandidate(video({ bvid: 'BV1aaa', title: '周杰伦《稻香》MV', duration: 223, play: 1000 }), ctx)
    const b = scoreCandidate(video({ bvid: 'BV1bbb', title: '周杰伦(稻香) MV', duration: 223, play: 5000 }), ctx)
    const c = scoreCandidate(video({ bvid: 'BV1ccc', title: '周杰伦《晴天》MV', duration: 269 }), ctx)
    const deduped = dedupeCandidates([a, b, c])
    expect(deduped).toHaveLength(2)
    expect(deduped.map((x) => x.video.bvid)).toEqual(['BV1bbb', 'BV1ccc'])
  })
})

describe('pickBestSubtitle（字幕挑选按偏好）', () => {
  const aiZh = { lan: 'ai-zh', lanDoc: 'AI字幕', aiType: 1, cacheKey: 'a' }
  const manualZh = { lan: 'zh-CN', lanDoc: '中文（简体）', aiType: 0, cacheKey: 'b' }
  const manualEn = { lan: 'en-US', lanDoc: 'English', aiType: 0, cacheKey: 'c' }

  it('zh-manual：优先人工中文字幕', () => {
    expect(pickBestSubtitle([aiZh, manualZh, manualEn], 'zh-manual')?.cacheKey).toBe('b')
  })
  it('zh-any：无人工中文时用 AI 中文', () => {
    expect(pickBestSubtitle([aiZh, manualEn], 'zh-any')?.cacheKey).toBe('a')
  })
  it('any：任意语言取首条', () => {
    expect(pickBestSubtitle([manualEn, aiZh], 'any')?.cacheKey).toBe('c')
  })
  it('off：返回 null', () => {
    expect(pickBestSubtitle([manualZh], 'off')).toBeNull()
  })
  it('空列表返回 null', () => {
    expect(pickBestSubtitle([])).toBeNull()
  })
})

describe('黑名单（不喜欢记忆）', () => {
  it('addBilibiliBlacklist 累加去重，getBilibiliBlacklist 读取', () => {
    addBilibiliBlacklist('netease:123', 'BV1aaa')
    addBilibiliBlacklist('netease:123', 'BV1bbb')
    addBilibiliBlacklist('netease:123', 'BV1aaa')
    expect(getBilibiliBlacklist('netease:123')).toEqual(['BV1aaa', 'BV1bbb'])
  })
})

describe('看歌设置持久化', () => {
  it('getBilibiliWatchSettings 返回默认值（未设置时）', () => {
    const settings = getBilibiliWatchSettings()
    expect(settings.matchPreference).toBe('balanced')
    expect(settings.autoPlayStrictness).toBe('standard')
    expect(settings.videoEndBehavior).toBe('next')
  })
})

describe('songKeyOf（歌曲缓存键）', () => {
  it('有平台 id 用平台键', () => {
    expect(songKeyOf({ songTitle: '稻香', artists: ['周杰伦'], songDuration: 223, platform: 'netease', id: 123 })).toBe('netease:123')
  })
  it('无平台 id 用标题+歌手规范化键', () => {
    const key = songKeyOf({ songTitle: '稻香', artists: ['周杰伦'], songDuration: 223 })
    expect(key).toBe('t:稻香:周杰伦')
  })
})
