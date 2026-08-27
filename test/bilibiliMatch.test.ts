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
    uploaderMatchesArtist: strong,
    ccSubtitle: false,
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

  it('私藏馆类高播放搬运：无官方信号 → 播放加权推高分数（15172e1 行为，实测接受自动播放）', () => {
    const remaster = scoreCandidate(
      video({ title: '【私藏馆】周杰伦《稻香》超治愈神作！', duration: 223, play: 9_260_000, author: '音乐私藏馆' }),
      ctx,
      { officialVerifyType: 0 },
    )
    expect(remaster.score).toBeGreaterThanOrEqual(150)
    // 播放加成 ×13 不封顶后，926 万播放足以越过 standard 档 230 纯分数线
    expect(shouldAutoPlay(remaster)).toBe(true)
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
    // 权重从 0.8 降至 0.5（干净标题的低播放搬运常排首位，不应压过高播放真 MV）
    expect(top.score - bottom.score).toBeCloseTo(7.5)
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

  it('4K/120帧 标记任意偏好下基础加成', () => {
    const hd4k = scoreCandidate(video({ title: '周杰伦《稻香》MV 4K', duration: 223, play: 100_000 }), ctx)
    const hd120 = scoreCandidate(video({ title: '周杰伦《稻香》120帧', duration: 223, play: 100_000 }), ctx)
    const plain = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx)
    const base = scoreCandidate(video({ title: '周杰伦《稻香》', duration: 223, play: 100_000 }), ctx)
    expect(hd4k.signals.hdMarker).toBe(true)
    expect(hd120.signals.hdMarker).toBe(true)
    // 同结构标题对比：4K 比普通 MV 高 28（+10 正向标记 +12 hdMarker +6 premium）
    expect(hd4k.score - plain.score).toBe(28)
    // 120帧 单独对比无 MV/无高清标记的标题：+12 hdMarker +6 premium
    expect(hd120.score - base.score).toBe(18)
  })

  it('CC 字幕权重：人工中文字幕 > AI 字幕 > 无字幕', () => {
    const base = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx)
    const manual = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { manualZhSubtitle: true })
    const auto = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { autoSubtitle: true })
    expect(manual.score - base.score).toBe(25)
    expect(auto.score - base.score).toBe(10)
    expect(manual.signals.ccSubtitle).toBe(true)
    expect(auto.signals.ccSubtitle).toBe(true)
  })

  it('官号：作者名=歌手（音乐人本人官号）加分', () => {
    const exact = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '周杰伦' }), ctx)
    const contains = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '周杰伦官方' }), ctx)
    const normal = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '音乐私藏馆' }), ctx)
    expect(exact.score - normal.score).toBe(25)
    expect(contains.score - normal.score).toBe(15)
    expect(exact.signals.uploaderMatchesArtist).toBe(true)
    expect(contains.signals.uploaderMatchesArtist).toBe(true)
    expect(normal.signals.uploaderMatchesArtist).toBe(false)
  })

  it('官号 + 个人认证：认证加成叠加', () => {
    const artistOfficial = scoreCandidate(
      video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '周杰伦' }),
      ctx,
      { officialVerifyType: 1 },
    )
    const noVerify = scoreCandidate(
      video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '周杰伦' }),
      ctx,
      { officialVerifyType: 0 },
    )
    expect(artistOfficial.score - noVerify.score).toBe(25) // +15 个人认证 +10 官号认证叠加
  })

  it('跨书写系统官号：ZUTOMAYO 官方 MV 压过粉丝字幕版（标题/UP主用英文名与中文名）', () => {
    const zutoCtx: MatchContext = { songTitle: 'メディアノーチェ', artists: ['ずっと真夜中でいいのに。'], songDuration: 240 }
    const official = scoreCandidate(
      video({ title: '【官方MV】ZUTOMAYO 永远是深夜有多好。《メディアノーチェ》MV正式上线！ (ZUTOMAYO - Medianoche)', duration: 240, play: 799_219, author: 'ZUTOMAYO_Channel' }),
      zutoCtx,
    )
    const fanSub = scoreCandidate(
      video({ title: '【ずっと真夜中でいいのに 新曲 | MV | 中日字幕】『メディアノーチェ (Media Noche)』【Hi-Res高音质】', duration: 240, play: 500_000, author: '私は最強uta' }),
      zutoCtx,
    )
    expect(official.signals.hasArtist).toBe(true) // 别名 ZUTOMAYO 命中标题
    expect(official.signals.uploaderMatchesArtist).toBe(true) // 官方频道命中别名
    expect(official.score).toBeGreaterThan(fanSub.score) // 官方正片压过粉丝版
    expect(shouldAutoPlay(official)).toBe(true)
  })

  it('主题曲/加长版 正片增强标记加分', () => {
    const lisaCtx: MatchContext = { songTitle: '紅蓮華', artists: ['LiSA'], songDuration: 239 }
    const themeSong = scoreCandidate(
      video({ title: 'LiSA 紅蓮華 主题曲MV 加长版', duration: 239, play: 100_000 }),
      lisaCtx,
    )
    const plain = scoreCandidate(video({ title: 'LiSA 紅蓮華 MV', duration: 239, play: 100_000 }), lisaCtx)
    // +12 主题曲 +12 加长版 +25「加长版+歌手+高播放」完整正片本体加成
    expect(themeSong.score - plain.score).toBe(49)
  })

  it('OP/ED 标记按词边界加分（动漫主题曲）', () => {
    const lisaCtx: MatchContext = { songTitle: '紅蓮華', artists: ['LiSA'], songDuration: 239 }
    const op = scoreCandidate(video({ title: '【OP】LiSA 紅蓮華 鬼灭之刃', duration: 239, play: 100_000 }), lisaCtx)
    const noOp = scoreCandidate(video({ title: 'LiSA 紅蓮華 鬼灭之刃', duration: 239, play: 100_000 }), lisaCtx)
    expect(op.score - noOp.score).toBe(18) // OP/ED 权重已提升
    // 小写/大小写混合/带集数都应命中；普通单词（operation/editor/open）不误伤
    for (const t of ['LiSA 紅蓮華 op 鬼灭之刃', 'LiSA 紅蓮華 Ed 鬼灭之刃', 'LiSA 紅蓮華 OP1 鬼灭之刃', 'LiSA 紅蓮華 ED2 鬼灭之刃']) {
      const hit = scoreCandidate(video({ title: t, duration: 239, play: 100_000 }), lisaCtx)
      expect(hit.score - noOp.score).toBe(18)
    }
    for (const t of ['LiSA 紅蓮華 operation 鬼灭之刃', 'LiSA 紅蓮華 editor 鬼灭之刃', 'LiSA 紅蓮華 open 鬼灭之刃']) {
      const miss = scoreCandidate(video({ title: t, duration: 239, play: 100_000 }), lisaCtx)
      expect(miss.score - noOp.score).toBe(0)
    }
  })

  it('OP/ED TV 版短时长（70~110s）降级，完整版优先', () => {
    const lisaCtx: MatchContext = { songTitle: '紅蓮華', artists: ['LiSA'], songDuration: 239 }
    // 同一首歌：TV 版 90s OP vs 完整版 239s OP —— 短版必须显著低于完整版
    const tvSize = scoreCandidate(video({ title: '【OP】LiSA 紅蓮華 鬼灭之刃', duration: 90, play: 100_000 }), lisaCtx)
    const full = scoreCandidate(video({ title: '【OP】LiSA 紅蓮華 完整版', duration: 239, play: 100_000 }), lisaCtx)
    expect(tvSize.score).toBeLessThan(full.score)
    // 边界外（69s / 111s）不触发 OP/ED 短版降级（但仍受时长偏离评分约束）
    const justShort = scoreCandidate(video({ title: '【OP】LiSA 紅蓮華 鬼灭之刃', duration: 69, play: 100_000 }), lisaCtx)
    const justLong = scoreCandidate(video({ title: '【OP】LiSA 紅蓮華 鬼灭之刃', duration: 111, play: 100_000 }), lisaCtx)
    const base = scoreCandidate(video({ title: 'LiSA 紅蓮華 鬼灭之刃', duration: 69, play: 100_000 }), lisaCtx)
    // 69s/111s 的 OP 视频相对无 OP 标记的 69s 视频仍保留 OP 加分（+18），未被短版降级扣掉
    expect(justShort.score - base.score).toBe(18)
    const base111 = scoreCandidate(video({ title: 'LiSA 紅蓮華 鬼灭之刃', duration: 111, play: 100_000 }), lisaCtx)
    expect(justLong.score - base111.score).toBe(18)
  })

  it('单字歌名不过滤（恋/星野源，防歌名变体长度过滤回归）', () => {
    const shortCtx: MatchContext = { songTitle: '恋', artists: ['星野源'], songDuration: 275 }
    const scored = scoreCandidate(video({ title: '【官方】星野源 – 恋 (Official Video)', duration: 275, play: 1_000_000 }), shortCtx)
    expect(scored.score).not.toBe(-Infinity)
    expect(scored.signals.hasArtist).toBe(true)
  })

  it('舞蹈练习/翻跳/自用类压分（非官方 MV）', () => {
    const ctx2: MatchContext = { songTitle: 'ステラ', artists: ['Leo/need'], songDuration: 200 }
    const practice = scoreCandidate(video({ title: 'ステラ leo/need 五人练舞镜面自用', duration: 200, play: 100_000 }), ctx2)
    const mv = scoreCandidate(video({ title: 'ステラ (Stella) Leo/need 2DMV', duration: 200, play: 100_000 }), ctx2)
    expect(practice.score).toBeLessThan(mv.score)
    // 播放加权后整体水位上涨（10 万播放 +65），但练舞稿仍压在自动播放线 230 之下
    expect(practice.score).toBeLessThan(230)
    expect(shouldAutoPlay(practice)).toBe(false)
  })

  it('短歌名 + 官方标记 + 无歌手 → 张冠李戴重罚（王艺瑾-喜欢你 场景）', () => {
    const ctx3: MatchContext = { songTitle: '喜欢你', artists: ['邓紫棋'], songDuration: 199 }
    const wrongArtist = scoreCandidate(video({ title: '【官方MV】王艺瑾 - 喜欢你', duration: 200, play: 1_000_000, author: '太合音乐' }), ctx3)
    const realArtist = scoreCandidate(video({ title: '【4K·高音质】《喜欢你》——邓紫棋', duration: 200, play: 100_000, author: '音乐里沉沦' }), ctx3)
    expect(realArtist.signals.hasArtist).toBe(true)
    expect(wrongArtist.signals.hasArtist).toBe(false)
    expect(realArtist.score).toBeGreaterThan(wrongArtist.score) // 真歌手版本压过"别的歌手的官方MV"
  })

  it('教学/纯人声/红石音乐 负向标记压分', () => {
    const ctx4: MatchContext = { songTitle: 'さかゆめ', artists: ['King Gnu'], songDuration: 225 }
    const teaching = scoreCandidate(video({ title: '听歌学日语丨逆夢(さかゆめ) - King Gnu', duration: 225, play: 50_000 }), ctx4)
    expect(teaching.score).toBeLessThan(200) // 教学类被 -35×2 压制，远低于正常 MV（~230+）
  })

  it('变速/降调/升调 非原版处理重罚（-45，高于翻唱 -30）', () => {
    const ctx5: MatchContext = { songTitle: '夜に駆ける', artists: ['YOASOBI'], songDuration: 263 }
    const sped = scoreCandidate(video({ title: '夜に駆ける - Nightcore 变速版', duration: 263, play: 100_000 }), ctx5)
    const slowed = scoreCandidate(video({ title: '夜に駆ける slowed 降调 慢放', duration: 263, play: 100_000 }), ctx5)
    const normal = scoreCandidate(video({ title: 'YOASOBI 夜に駆ける MV', duration: 263, play: 100_000 }), ctx5)
    expect(normal.score - sped.score).toBeGreaterThanOrEqual(45)
    expect(normal.score - slowed.score).toBeGreaterThanOrEqual(45)
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
  it('官号信号（作者=歌手）计入 strong：160 分 + 官号 → standard 自动', () => {
    const withUploader: CandidateScore = {
      video: video({ title: '周杰伦 稻香 MV', duration: 223, play: 1_000_000, author: '周杰伦' }),
      score: 160,
      signals: { officialMarker: false, mvMarker: false, negativeHit: false, hasArtist: true, nearDuration: false, hdMarker: false, uploaderMatchesArtist: true, ccSubtitle: false },
      rank: 0,
      officialVerifyType: 0,
      manualZhSubtitle: false,
      autoSubtitle: false,
      type: 'other',
    }
    expect(shouldAutoPlay(withUploader)).toBe(true)
    const withoutUploader: CandidateScore = { ...withUploader, signals: { ...withUploader.signals, uploaderMatchesArtist: false } }
    expect(shouldAutoPlay(withoutUploader)).toBe(false)
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

  it('高清偏好：标题带 4K/1080P/高清 加分（含基础标记共 48 分）', () => {
    const hd = scoreCandidate(video({ title: '周杰伦《稻香》MV 4K', duration: 223, play: 100_000 }), ctx, { preference: 'hd' })
    const normal = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { preference: 'hd' })
    expect(hd.score - normal.score).toBe(48) // +10 正向标记(4k) +12 hdMarker +6 premium +20 hd 偏好加权
  })

  it('歌词字幕偏好：歌词版分数更高', () => {
    const lyrics = scoreCandidate(video({ title: '周杰伦《稻香》歌词字幕', duration: 223, play: 100_000 }), ctx, { preference: 'lyrics' })
    const normal = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { preference: 'lyrics' })
    expect(lyrics.score).toBeGreaterThan(normal.score)
  })
})

describe('buildQueries（关键词构建）', () => {
  it('auto 均衡：歌名+歌手 / 仅歌名 / 歌名+MV', () => {
    expect(buildQueries(ctx)).toEqual(['稻香 周杰伦', '稻香', '稻香 MV'])
  })
  it('auto 官方偏好：追加官方词', () => {
    expect(buildQueries(ctx, { matchPreference: 'official' })).toEqual(['稻香 周杰伦', '稻香', '稻香 MV', '稻香 周杰伦 官方', '稻香 官方MV'])
  })
  it('auto 现场偏好：追加现场词', () => {
    expect(buildQueries(ctx, { matchPreference: 'live' })).toEqual(['稻香 周杰伦', '稻香', '稻香 MV', '稻香 周杰伦 现场', '稻香 演唱会'])
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

describe('货不对板识别（同名不同歌手，如日语曲撞中文同名曲）', () => {
  // 真实案例：NIKIE(ニキー) 的日语曲「春夏秋冬 (Seasons)」曾被匹配到
  // 张国荣的高播放现场版（37.9万播放），而正确的是 sumika 的 MAD 版（2.4万播放）
  const jCtx: MatchContext = {
    songTitle: '春夏秋冬 (Seasons)',
    artists: ['NIKIE (ニキー)'],
    songDuration: 280,
    platform: 'netease',
    id: 999,
  }

  it('「他人《歌名》」+ 现场标记的高播放视频应排到正确候选之下', () => {
    const leslieLive = scoreCandidate(
      video({
        title: '【4K60FPS】张国荣Leslie《春夏秋冬》2000年热情演出现场',
        author: '荣迷俱乐部',
        duration: 285,
        play: 379000,
      }),
      jCtx,
      { rank: 0 },
    )
    const sumikaEd = scoreCandidate(
      video({
        title: '【4KMAD|HIRES96kHz/24Bit】春夏秋冬-sumika我想吃掉你的胰脏ED',
        author: 'MAD制作者',
        duration: 285,
        play: 24000,
      }),
      jCtx,
      { rank: 1 },
    )
    expect(leslieLive.score).toBeLessThan(sumikaEd.score)
  })

  it('书名号前缀是他人名时显著降分（同条件下与无前缀标题对比）', () => {
    const withPrefix = scoreCandidate(
      video({ title: '张国荣《春夏秋冬》', author: 'up主', duration: 280, play: 379000 }),
      jCtx,
      {},
    )
    const noPrefix = scoreCandidate(
      video({ title: '春夏秋冬', author: 'up主', duration: 280, play: 24000 }),
      jCtx,
      {},
    )
    expect(withPrefix.score).toBeLessThan(noPrefix.score)
  })

  it('书名号前缀含本曲歌手时不罚（周杰伦《稻香》对周杰伦歌曲）', () => {
    const s = scoreCandidate(
      video({ title: '【官方】周杰伦《稻香》MV', author: '杰威尔音乐', duration: 223, play: 1000000 }),
      ctx,
      {},
    )
    expect(s.signals.hasArtist).toBe(true)
    // 无歌手惩罚链不应触发：分数应明显高于无歌手命中基线（100-35-15+正分）
    expect(s.score).toBeGreaterThan(120)
  })

  it('无歌手命中的现场版比同条件普通标题分低（别人的 live）', () => {
    const live = scoreCandidate(
      video({ title: '春夏秋冬 现场版', author: 'up主', duration: 280, play: 300000 }),
      jCtx,
      {},
    )
    const normal = scoreCandidate(
      video({ title: '春夏秋冬', author: 'up主', duration: 280, play: 300000 }),
      jCtx,
      {},
    )
    expect(live.score).toBeLessThan(normal.score)
  })
})
