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
  compareCandidates,
  playCountScore,
  classifyExactTitleMatch,
  resolveArtistNames,
  inferRecordingTarget,
  compareSubtitleWithLyrics,
  flattenLyricLinesForMatch,
  rescoreResultWithLyrics,
  getBilibiliBlacklist,
  addBilibiliBlacklist,
  getBilibiliWatchSettings,
  saveBilibiliWatchSettings,
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
    officialChannel: false,
    ccSubtitle: false,
  }
  return {
    video: video({ title: '周杰伦 稻香 MV', duration: 223 }),
    score,
    signals,
    rank: 0,
    officialVerifyType: strong ? 1 : -1,
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
      { officialVerifyType: 1, manualZhSubtitle: true },
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
      { officialVerifyType: -1 },
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
      { officialVerifyType: -1 },
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

  it('CC 字幕权重分档：验证 match 足额 > unverified 缩水 > mismatch 反罚', () => {
    const base = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx)
    const manual = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { manualZhSubtitle: true })
    const auto = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { autoSubtitle: true })
    // 缺省（未验证/无法验证）缩水档：人工 +8 / AI +3——CC 只证明"有字幕"，不证明"是这首歌"
    expect(manual.score - base.score).toBe(8)
    expect(auto.score - base.score).toBe(3)
    expect(manual.signals.ccSubtitle).toBe(true)
    // 比对 match：人工 +25 / AI +10（足额）
    const manualOk = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { manualZhSubtitle: true, ccVerification: 'match' })
    const autoOk = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { autoSubtitle: true, ccVerification: 'match' })
    expect(manualOk.score - base.score).toBe(25)
    expect(autoOk.score - base.score).toBe(10)
    // 比对 mismatch（字幕内容与歌词无关，如直播切片）：加分变惩罚
    const manualBad = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { manualZhSubtitle: true, ccVerification: 'mismatch' })
    const autoBad = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000 }), ctx, { autoSubtitle: true, ccVerification: 'mismatch' })
    expect(manualBad.score - base.score).toBe(-20)
    expect(autoBad.score - base.score).toBe(-8)
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
      { officialVerifyType: 0 },
    )
    const noVerify = scoreCandidate(
      video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '周杰伦' }),
      ctx,
      { officialVerifyType: -1 },
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

describe('来源证据与稳定排序回归', () => {
  const valorantCtx: MatchContext = {
    songTitle: 'Ticking Away',
    artists: ['VALORANT Music, Grabbitz & bbno$'],
    songDuration: 205,
  }

  it('Ticking Away：官方游戏频道候选稳定排在低播放纯标题转载之前', () => {
    const repost = scoreCandidate(video({
      bvid: 'BVrepost', title: 'Ticking Away', duration: 206, play: 14_000, author: 'FlyingTiercel',
    }), valorantCtx, { rank: 0, officialVerifyType: -1 })
    const riotMusic = scoreCandidate(video({
      bvid: 'BVriotmusic', title: 'Ticking Away（流光似箭）｜无畏契约2023全球冠军赛主题曲', duration: 205, play: 1_031_000, author: '拳头游戏音乐',
    }), valorantCtx, { rank: 2, officialVerifyType: 1 })
    const valorant = scoreCandidate(video({
      bvid: 'BVvalorant', title: '《Ticking Away 流光似箭》// 2023无畏契约全球冠军赛主题曲', duration: 205, play: 20_551_000, author: '无畏契约',
    }), valorantCtx, { rank: 6, officialVerifyType: 1 })

    const sorted = [repost, riotMusic, valorant].sort(compareCandidates)
    expect(sorted[0].video.bvid).toBe('BVvalorant')
    expect(sorted[1].video.bvid).toBe('BVriotmusic')
    expect(sorted[2].video.bvid).toBe('BVrepost')
    expect(riotMusic.signals.officialChannel).toBe(true)
    expect(valorant.signals.uploaderMatchesArtist).toBe(true)
  })

  it('手动推荐排序保留不相关结果，并把它放在有限分数候选之后', () => {
    const relevant = scoreCandidate(video({ bvid: 'BVok', title: 'Grabbitz - Ticking Away', duration: 205, play: 10_000 }), valorantCtx, { rank: 1 })
    const unrelated = scoreCandidate(video({ bvid: 'BVother', title: '完全无关的视频', duration: 100, play: 99_000_000 }), valorantCtx, { rank: 0 })
    const secondUnrelated = scoreCandidate(video({ bvid: 'BVother2', title: '另一个无关视频', duration: 100, play: Number.NaN }), valorantCtx, { rank: 2 })
    const sorted = [secondUnrelated, unrelated, relevant].sort(compareCandidates)
    expect(sorted.map((candidate) => candidate.video.bvid)).toEqual(['BVok', 'BVother', 'BVother2'])
    expect(unrelated.score).toBe(-Infinity)
  })

  it('Come Alive 中的 alive 不是 live 现场标记', () => {
    expect(classifyCandidateType('HOYO-MiX - Come Alive')).not.toBe('live')
  })

  it('Leo/need 保持为完整组合名，不拆成 Leo 和 need', () => {
    expect(resolveArtistNames(['Leo/need']).raw).toEqual(['Leo/need'])
  })

  it('泛化英文歌名缺少艺人/IP证据时显著降权', () => {
    const answersCtx: MatchContext = { songTitle: 'Answers', artists: ['植松伸夫', 'Susan Calloway'], songDuration: 427, targetVersion: 'full-original', franchise: 'FINAL FANTASY XIV' }
    const unrelated = scoreCandidate(video({ title: 'Dr. Harley Sawyer Answers Some Burning Questions', duration: 428, play: 211_443, typename: '单机游戏' }), answersCtx)
    const correct = scoreCandidate(video({ title: '【FF14】Answers 最终幻想14主题曲 Susan Calloway', duration: 442, play: 86_376, typename: '网络游戏' }), answersCtx)
    expect(correct.score).toBeGreaterThan(unrelated.score)
  })

  it('virtual-singer 目标下原 Vocaloid 版优先于 Project SEKAI 翻唱', () => {
    const vocaloidCtx: MatchContext = { songTitle: '神っぽいな', artists: ['ピノキオピー', '初音ミク'], songDuration: 204, targetVersion: 'virtual-singer' }
    const sekai = scoreCandidate(video({ title: '【25時、ナイトコードで。×初音ミク】神っぽいな【2DMV／世界计划】', author: 'Project_SEKAI资讯站', duration: 207, play: 1_129_343 }), vocaloidCtx)
    const original = scoreCandidate(video({ title: '【初音ミク】神っぽいな【ピノキオピー】', author: 'ピノキオピー_official', duration: 205, play: 14_606_762 }), vocaloidCtx)
    expect(original.score).toBeGreaterThan(sekai.score)
  })

  it('TV size 目标奖励原版 90 秒候选，但不奖励教学或演奏版', () => {
    const tvCtx: MatchContext = { songTitle: 'Tank! (TV Size)', artists: ['SEATBELTS'], songDuration: 90, targetVersion: 'tv-size', franchise: 'Cowboy Bebop' }
    const tv = scoreCandidate(video({ title: 'Cowboy Bebop OP Tank! TV Size SEATBELTS', duration: 90, play: 100_000 }), tvCtx)
    const tutorial = scoreCandidate(video({ title: 'Cowboy Bebop OP Tank! 吉他带谱教学 SEATBELTS', duration: 90, play: 100_000 }), tvCtx)
    const full = scoreCandidate(video({ title: 'Cowboy Bebop OP Tank! TV Size SEATBELTS', duration: 90, play: 100_000 }), { ...tvCtx, songTitle: 'Tank!', songDuration: 220, targetVersion: 'full-original' })
    expect(tv.score).toBeGreaterThan(tutorial.score)
    expect(tv.score).toBeGreaterThan(full.score)
  })

  it('完整版目标下现场演出不能靠播放量压过录音室版本', () => {
    const popCtx: MatchContext = { songTitle: 'Blinding Lights', artists: ['The Weeknd'], songDuration: 200, targetVersion: 'full-original' }
    const performance = scoreCandidate(video({ title: 'The Weeknd VMA 2020《Blinding Lights》完整版演出', duration: 198, play: 423_731 }), popCtx)
    const studio = scoreCandidate(video({ title: '【MV中英字幕】Blinding Lights - The Weeknd', duration: 245, play: 21_244 }), popCtx)
    expect(studio.score).toBeGreaterThan(performance.score)
  })

  it('其他歌手位于分隔段首位时不能借 franchise 冒充目标录音', () => {
    const answersCtx: MatchContext = { songTitle: 'Answers', artists: ['植松伸夫', 'Susan Calloway'], songDuration: 427, targetVersion: 'full-original', franchise: 'FINAL FANTASY XIV' }
    const wrongSinger = scoreCandidate(video({ title: '尚雯婕 | Answers | 最终幻想ff14主题曲', duration: 469, play: 20_702 }), answersCtx)
    const right = scoreCandidate(video({ title: 'Answers - 植松伸夫 & Susan Calloway', duration: 401, play: 144 }), answersCtx)
    expect(right.score).toBeGreaterThan(wrongSinger.score)
  })

  it('可信唱片来源不能替代泛化标题的艺人身份', () => {
    const comeAliveCtx: MatchContext = { songTitle: 'Come Alive', artists: ['HOYO-MiX', 'San-Z', 'Sam Haft'], songDuration: 221, targetVersion: 'full-original', franchise: '绝区零' }
    const wrongLabelSong = scoreCandidate(video({ title: 'Cannons「Come Alive」', author: '索尼音乐中国', mid: 486906719, duration: 217, play: 10_000 }), comeAliveCtx)
    const right = scoreCandidate(video({ title: 'Sān-Z Studio & HOYO-MiX - Come Alive 绝区零', author: '音乐分享', duration: 217, play: 1_000 }), comeAliveCtx)
    expect(wrongLabelSong.signals.officialChannel).toBe(true)
    expect(right.score).toBeGreaterThan(wrongLabelSong.score)
  })

  it('虚拟歌手原版目标下舞蹈投稿属于衍生版本', () => {
    const vocaloidCtx: MatchContext = { songTitle: 'ボルテッカー', artists: ['DECO*27', '初音ミク'], songDuration: 161, targetVersion: 'virtual-singer' }
    const dance = scoreCandidate(video({ title: 'ボルテッカー/DECO*27 踊ってみた 初音ミク', duration: 161, play: 100_000 }), vocaloidCtx)
    const original = scoreCandidate(video({ title: 'DECO*27 - ボルテッカー feat. 初音ミク', duration: 161, play: 10_000 }), vocaloidCtx)
    expect(original.score).toBeGreaterThan(dance.score)
  })

  it('主标题是另一首歌时，不因附带说明提及目标歌名而误匹配', () => {
    const starboyCtx: MatchContext = { songTitle: 'Starboy', artists: ['The Weeknd', 'Daft Punk'], songDuration: 230, targetVersion: 'full-original' }
    const wrong = scoreCandidate(video({ title: 'The Weeknd热单《Die For You》超清MV，Starboy五周年彩蛋', author: '欧美纪westworld', duration: 281, play: 105_676 }), starboyCtx)
    const right = scoreCandidate(video({ title: 'Starboy - The Weeknd & Daft Punk', author: '音乐分享', duration: 227, play: 828_557 }), starboyCtx)
    expect(right.score).toBeGreaterThan(wrong.score)
  })

  it('目标歌名在书名号前时允许后续动画或 IP 名称', () => {
    const animeCtx: MatchContext = { songTitle: '紅蓮華', artists: ['LiSA'], songDuration: 236, targetVersion: 'full-original' }
    const withAnimeName = scoreCandidate(video({ title: 'LiSA 紅蓮華《鬼滅の刃》OP', duration: 236, play: 100_000 }), animeCtx)
    const plain = scoreCandidate(video({ title: 'LiSA 紅蓮華 OP', duration: 236, play: 100_000 }), animeCtx)
    expect(withAnimeName.score).toBe(plain.score)
  })

  it('指定古典录音要求主要演奏者或指挥证据', () => {
    const classicalCtx: MatchContext = { songTitle: 'Symphony No. 5 in C Minor, Op. 67', artists: ['Carlos Kleiber', 'Vienna Philharmonic'], songDuration: 1978, targetVersion: 'specific-performance' }
    const wrongConductor = scoreCandidate(video({ title: 'Beethoven Symphony No. 5 in C Minor, Op. 67 卡拉扬指挥', duration: 1968, play: 4780 }), classicalCtx)
    const target = scoreCandidate(video({ title: 'Carlos Kleiber - Symphony No. 5 in C Minor, Op. 67', duration: 1978, play: 500 }), classicalCtx)
    expect(target.score).toBeGreaterThan(wrongConductor.score)
  })

  it('franchise 参与查询，提升 TV size 和游戏泛词歌曲召回', () => {
    const queries = buildQueries({ songTitle: 'Tank! (TV Size)', artists: ['SEATBELTS'], songDuration: 90, targetVersion: 'tv-size', franchise: 'Cowboy Bebop' })
    expect(queries).toContain('Tank! Cowboy Bebop')
  })

  it('只在明确元数据下自动推断 TV、SEKAI 与虚拟歌手版本', () => {
    expect(inferRecordingTarget({ songTitle: 'Tank! (TV Size)', artists: ['SEATBELTS'], songDuration: 90 })).toBe('tv-size')
    expect(inferRecordingTarget({ songTitle: 'ステラ', artists: ['Leo/need'], songDuration: 326 })).toBe('sekai-version')
    expect(inferRecordingTarget({ songTitle: '神っぽいな', artists: ['ピノキオピー', '初音ミク'], songDuration: 204 })).toBe('virtual-singer')
    expect(inferRecordingTarget({ songTitle: 'unravel', artists: ['TK from 凛として時雨'], songDuration: 238 })).toBeUndefined()
  })

  it('社区合作频道不会冒充官方来源，SEKAI 版本仅由版本证据加权', () => {
    const sekaiVideo = video({ title: '【2DMV】神っぽいな 初音ミク', author: 'Project_SEKAI资讯站', mid: 13148307, duration: 205, play: 1_000_000 })
    const vocaloid = scoreCandidate(sekaiVideo, { songTitle: '神っぽいな', artists: ['ピノキオピー', '初音ミク'], songDuration: 204, targetVersion: 'virtual-singer' })
    const sekai = scoreCandidate(sekaiVideo, { songTitle: '神っぽいな', artists: ['25時、ナイトコードで。'], songDuration: 207, targetVersion: 'sekai-version', franchise: 'Project SEKAI' })
    expect(vocaloid.signals.officialChannel).toBe(false)
    expect(sekai.signals.officialChannel).toBe(false)
    expect(sekai.score).toBeGreaterThan(vocaloid.score)
  })

  it('精确标题只奖励纯歌名或正确艺人，不奖励错误艺人的同名歌', () => {
    const artists = resolveArtistNames(['VALORANT Music, Grabbitz & bbno$'])
    expect(classifyExactTitleMatch('Ticking Away', 'Ticking Away', artists)).toBe('title-only')
    expect(classifyExactTitleMatch('Grabbitz - Ticking Away', 'Ticking Away', artists)).toBe('artist-title')
    expect(classifyExactTitleMatch('Other Artist - Ticking Away', 'Ticking Away', artists)).toBe('none')
    expect(classifyExactTitleMatch('A Fan of Grabbitz - Ticking Away', 'Ticking Away', artists)).toBe('none')
  })

  it('艺人别名只按完整名字展开，不因子串把 Shadow 误认成 Ado', () => {
    const artists = resolveArtistNames(['Shadow'])
    expect(artists.aliases).not.toContain(normalizeText('アド'))
  })

  it('上传者名称按完整边界匹配，不把 ShadowMusic 误认成 Ado', () => {
    const adoCtx: MatchContext = { songTitle: '新時代', artists: ['Ado'], songDuration: 226 }
    const candidate = scoreCandidate(video({ title: 'Ado 新時代', author: 'ShadowMusic', duration: 226, play: 100_000 }), adoCtx)
    expect(candidate.signals.hasArtist).toBe(true)
    expect(candidate.signals.uploaderMatchesArtist).toBe(false)
  })

  it('受限官方 MID 不能靠候选标题自行证明作用域', () => {
    const unrelatedCtx: MatchContext = { songTitle: 'Other Song', artists: ['Other Artist'], songDuration: 180 }
    const candidate = scoreCandidate(video({ title: 'DECO*27 Other Song', author: 'DECO27_Official', mid: 177291194, duration: 180, play: 100_000 }), unrelatedCtx)
    expect(candidate.signals.officialChannel).toBe(false)
  })

  it('普通艺人名称包含 flower 或 GUMI 时不误判为虚拟歌手版本', () => {
    expect(inferRecordingTarget({ songTitle: 'Song', artists: ['The Flower Kings', 'Guest'], songDuration: 200 })).toBeUndefined()
    expect(inferRecordingTarget({ songTitle: 'Song', artists: ['GUMI Inc.', 'Guest'], songDuration: 200 })).toBeUndefined()
  })

  it('播放量曲线单调、递减增长且始终有限', () => {
    const values = [0, 10_000, 1_000_000, 20_000_000].map(playCountScore)
    expect(values[0]).toBe(0)
    expect(values[1]).toBeLessThan(values[2])
    expect(values[2]).toBeLessThan(values[3])
    expect(values[3]).toBeLessThanOrEqual(90)
    expect(playCountScore(Number.NaN)).toBe(0)
    expect(playCountScore(-10)).toBe(0)
  })

  it('标题自称官方不是自动播放强来源证据', () => {
    const claimed = scoreCandidate(video({ title: '【官方MV】稻香', duration: 223, play: 100, author: '普通账号' }), ctx)
    expect(claimed.signals.officialMarker).toBe(true)
    expect(claimed.signals.officialChannel).toBe(false)
    expect(shouldAutoPlay({ ...claimed, score: 160 }, 'standard')).toBe(false)
  })

  it('机构认证强于个人认证，只有机构认证可单独构成强信号', () => {
    const baseVideo = video({ title: '周杰伦《稻香》', duration: 223, play: 100_000, author: '普通账号' })
    const unverified = scoreCandidate(baseVideo, ctx, { officialVerifyType: -1 })
    const personal = scoreCandidate(baseVideo, ctx, { officialVerifyType: 0 })
    const organization = scoreCandidate(baseVideo, ctx, { officialVerifyType: 1 })
    expect(personal.score - unverified.score).toBe(15)
    expect(organization.score - unverified.score).toBe(30)
    expect(shouldAutoPlay({ ...unverified, score: 160 }, 'standard')).toBe(false)
    expect(shouldAutoPlay({ ...personal, score: 160 }, 'standard')).toBe(false)
    expect(shouldAutoPlay({ ...organization, score: 160 }, 'standard')).toBe(true)
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
      signals: { officialMarker: false, mvMarker: false, negativeHit: false, hasArtist: true, nearDuration: false, hdMarker: false, uploaderMatchesArtist: true, officialChannel: false, ccSubtitle: false },
      rank: 0,
      officialVerifyType: -1,
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
  it('组合艺人查询去重且有上限，不随别名数无限膨胀', () => {
    const queries = buildQueries({ songTitle: 'Ticking Away', artists: ['VALORANT Music, Grabbitz & bbno$'], songDuration: 205 })
    expect(queries.length).toBeLessThanOrEqual(10)
    expect(new Set(queries.map(normalizeText)).size).toBe(queries.length)
    expect(queries).toContain('Ticking Away VALORANT')
    expect(queries).toContain('Ticking Away MV')
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
  it('getBilibiliWatchSettings 返回安全默认值（未设置时）', () => {
    const settings = getBilibiliWatchSettings()
    expect(settings.matchPreference).toBe('balanced')
    expect(settings.autoPlayStrictness).toBe('standard')
    expect(settings.videoEndBehavior).toBe('next')
    expect(settings.forceAutoPlayHighest).toBe(false)
    expect(settings.showLowConfidenceCandidates).toBe(false)
  })

  it('旧设置首次迁移关闭强制最高分，迁移后尊重用户重新开启', () => {
    localStorage.setItem('bilibili_watch_settings', JSON.stringify({ forceAutoPlayHighest: true, matchPreference: 'hd' }))
    localStorage.removeItem('bilibili_watch_settings_schema')
    expect(getBilibiliWatchSettings().forceAutoPlayHighest).toBe(false)
    expect(getBilibiliWatchSettings().matchPreference).toBe('hd')
    saveBilibiliWatchSettings({ forceAutoPlayHighest: true })
    expect(getBilibiliWatchSettings().forceAutoPlayHighest).toBe(true)
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

/** 稻香歌词（CC 比对用例共用：歌词字幕/Live 前段说话/直播切片闲聊等场景的基准歌词） */
const daoXiangLyrics = [
  '对这个世界如果你有太多的抱怨',
  '跌倒了就不敢继续往前走',
  '为什么人要这么的脆弱堕落',
  '请你打开电视看看',
  '多少人为生命在努力勇敢的走下去',
  '我们是不是该知足',
  '珍惜一切 就算没有拥有',
  '还记得你说家是唯一的城堡',
  '随着稻香河流继续奔跑',
  '微微笑 小时候的梦我知道',
  '不要哭让萤火虫带着你逃跑',
  '乡间的歌谣永远的依靠',
  '回家吧 回到最初的美好',
].join('\n')

describe('compareSubtitleWithLyrics（CC 字幕 ↔ 歌词内容比对）', () => {
  // 真实背景：Starboy (Explicit) 曾匹配到「一滴泪」直播切片——其人工 CC 字幕 +25 分把它推上最佳（245）。
  // 比对器让"字幕内容是否真是这首歌"决定 CC 分档：match 足额 / unverified 缩水 / mismatch 反罚。
  const line = (from: number, content: string) => ({ from, content })
  const starboyLyrics = [
    "I'm trying to put you in the worst mood, ah",
    'P1 cleaner than your church shoes, ah',
    "Million' done, we make it move, ah",
    'You lookin at the truth, ah',
    'Look what you done did to the boy',
  ].join('\n')

  it('歌词字幕视频：字幕行即歌词 → match', () => {
    const subs = [
      '对这个世界如果你有太多的抱怨',
      '跌倒了就不敢继续往前走',
      '还记得你说家是唯一的城堡',
      '随着稻香河流继续奔跑',
      '回家吧 回到最初的美好',
    ].map((c, i) => line(i * 15, c))
    expect(compareSubtitleWithLyrics(subs, daoXiangLyrics).verdict).toBe('match')
  })

  it('翻译措辞因人而异（分段微调/少字）不伤判定（bigram 模糊命中）', () => {
    const subs = [
      '这个世界 如果你有太多的抱怨',
      '跌倒了 就不敢继续往前走',
      '还记得你说 家是唯一的城堡',
      '我们是不是该知足',
      '回家吧 回到最初的美好',
    ].map((c, i) => line(i * 15, c))
    expect(compareSubtitleWithLyrics(subs, daoXiangLyrics).verdict).toBe('match')
  })

  it('Live 前段说话、后面正片：闲聊行占少数采样 → 仍判 match', () => {
    const subs = [
      line(0, '大家好欢迎来到今天的直播间'),
      line(10, '今天给大家唱一首稻香'),
      line(20, '对这个世界如果你有太多的抱怨'),
      line(35, '跌倒了就不敢继续往前走'),
      line(50, '还记得你说家是唯一的城堡'),
      line(65, '随着稻香河流继续奔跑'),
      line(80, '回家吧 回到最初的美好'),
    ]
    expect(compareSubtitleWithLyrics(subs, daoXiangLyrics).verdict).toBe('match')
  })

  it('直播切片闲聊字幕（可比对却全不命中）→ mismatch 反罚', () => {
    const subs = [
      '谢谢哥送的火箭么么哒呀',
      '不要骂我了宝宝们委屈',
      '加我粉丝团看更多精彩直播',
      '宝宝美瞳是什么牌子的',
      '想要同款的私信我上链接',
    ].map((c, i) => line(i * 10, c))
    expect(compareSubtitleWithLyrics(subs, daoXiangLyrics).verdict).toBe('mismatch')
  })

  it('英文歌 + 闲聊中文翻译字幕（歌词侧无翻译可比）→ unverified 不误罚', () => {
    const subs = [
      '不要骂我了宝宝们委屈',
      '加我粉丝团看更多精彩直播',
      '想要同款的私信我上链接',
    ].map((c, i) => line(i * 10, c))
    expect(compareSubtitleWithLyrics(subs, starboyLyrics).verdict).toBe('unverified')
  })

  it('英文歌 + 英文 CC 歌词字幕 → match', () => {
    const subs = [
      "I'm trying to put you in the worst mood",
      'P1 cleaner than your church shoes',
      'You lookin at the truth',
      'Look what you done did to the boy',
    ].map((c, i) => line(i * 15, c))
    expect(compareSubtitleWithLyrics(subs, starboyLyrics).verdict).toBe('match')
  })

  it('中英双语 CC（原文+译文分段）→ 译文侧与歌词比对命中', () => {
    const subs = [
      'The world has too many complaints\n对这个世界如果你有太多的抱怨',
      'Fall down and dare not go on\n跌倒了就不敢继续往前走',
      'Home is the only castle\n还记得你说家是唯一的城堡',
      'Run along the fragrance river\n随着稻香河流继续奔跑',
      'Back to the initial beauty\n回家吧 回到最初的美好',
    ].map((c, i) => line(i * 15, c))
    const r = compareSubtitleWithLyrics(subs, daoXiangLyrics)
    expect(r.verdict).toBe('match')
    expect(r.comparable).toBe(5) // 拉丁段与纯中文歌词不可比，只计译文段
  })

  it('AI 字幕全是「♪音乐♪」噪音行 → unverified（不奖不罚）', () => {
    const subs = [line(0, '♪ 音乐 ♪'), line(10, '音乐'), line(20, '♪音乐♪')]
    expect(compareSubtitleWithLyrics(subs, daoXiangLyrics).verdict).toBe('unverified')
  })

  it('歌词过短/纯 credits（纯音乐空壳）→ unverified', () => {
    const subs = ['随便什么话内容足够长'].map((c, i) => line(i * 10, c))
    expect(compareSubtitleWithLyrics(subs, '作词：某某\n作曲：某某').verdict).toBe('unverified')
  })

  it('歌词带 credits 头不伤判定（剔除作词/作曲行）', () => {
    const subs = [
      '对这个世界如果你有太多的抱怨',
      '跌倒了就不敢继续往前走',
      '还记得你说家是唯一的城堡',
      '随着稻香河流继续奔跑',
      '回家吧 回到最初的美好',
    ].map((c, i) => line(i * 15, c))
    expect(compareSubtitleWithLyrics(subs, `作词：周杰伦\n作曲：周杰伦\n${daoXiangLyrics}`).verdict).toBe('match')
  })

  it('可比样本太少（1~2 段）不敢判 mismatch → unverified', () => {
    const subs = [line(0, '完全无关的一句话呀'), line(10, '再说一句无关的话吧')]
    expect(compareSubtitleWithLyrics(subs, daoXiangLyrics).verdict).toBe('unverified')
  })
})

describe('flattenLyricLinesForMatch（歌词压平：正文+翻译都进比对云）', () => {
  it('text 与 translation 都保留，空行剔除', () => {
    expect(flattenLyricLinesForMatch([
      { text: '稻香', translation: 'Dao Xiang' },
      { text: '' },
      { text: '回家吧', translation: '' },
    ])).toBe('稻香\nDao Xiang\n回家吧')
  })
  it('空/非法输入返回空串', () => {
    expect(flattenLyricLinesForMatch(undefined)).toBe('')
    expect(flattenLyricLinesForMatch([])).toBe('')
  })
})

describe('CC 验证接线（shouldAutoPlay strong 收紧 + 缓存命中零网络升级）', () => {
  const manualCcCandidate = (ccVerification?: 'match' | 'mismatch' | 'unverified'): CandidateScore => ({
    video: video({ title: '周杰伦 稻香 MV', duration: 223, play: 50_000 }),
    score: 160,
    signals: {
      officialMarker: false, mvMarker: false, negativeHit: false, hasArtist: true,
      nearDuration: false, hdMarker: false, uploaderMatchesArtist: false, officialChannel: false, ccSubtitle: true,
    },
    rank: 0,
    officialVerifyType: -1,
    manualZhSubtitle: true,
    autoSubtitle: false,
    ...(ccVerification ? { ccVerification } : {}),
    type: 'other',
  })

  it('未验证的人工 CC 不再单独撑起自动播放；验证 match 才算 strong', () => {
    expect(shouldAutoPlay(manualCcCandidate(), 'standard')).toBe(false)
    expect(shouldAutoPlay(manualCcCandidate('unverified'), 'standard')).toBe(false)
    expect(shouldAutoPlay(manualCcCandidate('match'), 'standard')).toBe(true)
    expect(shouldAutoPlay(manualCcCandidate('mismatch'), 'standard')).toBe(false)
  })

  it('缓存命中后拿到歌词：零网络重扫升级（mismatch 把无关视频拉下最佳）', () => {
    const sbCtx: MatchContext = { songTitle: '稻香', artists: ['周杰伦'], songDuration: 223 }
    // 「一滴泪」型：标题完美 + 人工 CC，无歌词时按 unverified 缩水档仍险胜低播放正片
    const junk = scoreCandidate(
      video({ bvid: 'BVjunk', title: '周杰伦 稻香（直播切片）', duration: 223, play: 27_700, author: '捷王中王' }),
      sbCtx,
      { rank: 0, manualZhSubtitle: true, ccVerification: 'unverified' },
    )
    const real = scoreCandidate(
      video({ bvid: 'BVreal', title: '周杰伦《稻香》', duration: 223, play: 6_000, author: '路人' }),
      sbCtx,
      { rank: 0 },
    )
    expect(junk.score).toBeGreaterThan(real.score) // 无歌词时的排序（CC 缩水档仍让它领先）
    const result = {
      status: 'auto' as const,
      best: junk,
      candidates: [junk, real],
      fallbackChain: [junk, real],
      ccUnverifiedWithoutLyrics: true,
    }
    const settings = { matchPreference: 'balanced' as const, autoPlayStrictness: 'standard' as const, forceAutoPlayHighest: true }
    const chatSubs = ['谢谢哥送的火箭么么哒呀', '不要骂我了宝宝们委屈', '加我粉丝团看更多精彩直播', '宝宝美瞳是什么牌子的', '想要同款的私信我上链接']
      .map((c, i) => ({ from: i * 10, text: c }))
    const upgraded = rescoreResultWithLyrics(
      result,
      sbCtx,
      settings,
      daoXiangLyrics,
      '',
      (bvid) => (bvid === 'BVjunk' ? { manualZh: true, subLines: chatSubs } : undefined),
    )
    expect(upgraded).not.toBe(result)
    const junkAfter = upgraded.fallbackChain.find((c) => c.video.bvid === 'BVjunk')
    expect(junkAfter?.ccVerification).toBe('mismatch')
    expect(upgraded.best?.video.bvid).toBe('BVreal')
    expect(upgraded.candidates[0].video.bvid).toBe('BVreal')
    // 拿到歌词重扫后不再缺歌词标记
    expect(upgraded.ccUnverifiedWithoutLyrics).toBeFalsy()
  })
})
