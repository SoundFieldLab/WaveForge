import { describe, it, expect, vi } from 'vitest'
import {
  applyDurationConsistencyPreference,
  applyIdentityVeto,
  applyOfficialTierPreference,
  isContentCredible,
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
  detectSongDurationConsensus,
  pickBestPage,
  getBilibiliBlacklist,
  addBilibiliBlacklist,
  setBilibiliOverride,
  getBilibiliOverride,
  getLocalMvMark,
  saveLocalMvMark,
  removeLocalMvMark,
  pruneLegacyUnmarkedOverrides,
  clearAllMvMatchCache,
  setSessionManualPick,
  getSessionManualPick,
  peekSessionManualPick,
  clearSessionManualPick,
  noteCurrentSongForManualPick,
  getBilibiliWatchSettings,
  saveBilibiliWatchSettings,
  setBilibiliApiBaseForTest,
  findBestBilibiliMv,
  resetLegacyOverrideSweepForTest,
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
  it('特殊字母折叠：希腊 β/ο 与拉丁 b/o 归一（泽野弘之《βiοs》实测根因）', () => {
    // 平台歌名用希腊字母（β U+03B2 / ο U+03BF），B 站热门标题写拉丁 Bios，
    // 不折叠会让硬淘汰把全部正片判为无关视频
    expect(normalizeText('βiοs')).toBe(normalizeText('Bios'))
    expect(normalizeText('βios')).toBe('bios')
    expect(normalizeText('βίος')).toBe('bios') // 希腊带调 ί
    expect(normalizeText('ßios')).toBe('bios') // 德语 ß：B 站标题《ßios》即拔剑神曲 Bios
    // 变形拉丁/西里尔同形（泽野《REVIVƎЯ》的 Ǝ/Я）
    expect(normalizeText('REVIVƎЯ')).toBe('reviver')
  })
  it('特殊字母折叠不误伤：CJK 与常规拉丁保持原语义', () => {
    expect(normalizeText('周杰倫《稻香》')).toBe('周杰伦稻香')
    expect(normalizeText('Hello World')).toBe('helloworld')
    // 假名不受折叠影响（日文歌名/歌手判定依赖假名）
    expect(normalizeText('夜に駆ける')).toBe('夜に駆ける')
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

describe('applyDurationConsistencyPreference（版本一致性优选）', () => {
  const cand = (bvid: string, score: number, duration: number, type = 'other') => ({ video: { bvid, duration }, score, type })

  it('合集/长版压过等长正片 → 改选等长（ばかじゃないのに：389s 286.8 压过官方 MV 256s 283.6）', () => {
    const ordered = [cand('compilation', 286.8, 389), cand('officialMv', 283.6, 256, 'official')]
    const out = applyDurationConsistencyPreference(ordered, 256)
    expect(out[0].video.bvid).toBe('officialMv')
  })

  it('口径已一致 → 原样返回（不干扰已正确的选择）', () => {
    const ordered = [cand('best', 300, 258), cand('other', 290, 256)]
    expect(applyDurationConsistencyPreference(ordered, 256)).toBe(ordered)
  })

  it('instrumental 不参与（リテラチュア 实测：99s 长笛独奏谱不算同版本）', () => {
    const ordered = [cand('longFull', 199.2, 478), cand('fluteSolo', 169.7, 99, 'instrumental')]
    expect(applyDurationConsistencyPreference(ordered, 92)).toBe(ordered)
  })

  it('等长候选掉出 30 分带 → 不动；在带内才改选（ステラ：556s 合集 vs 官方 326s）', () => {
    const ordered = [cand('compilation', 336.3, 556), cand('officialMv', 300, 326, 'official')]
    expect(applyDurationConsistencyPreference(ordered, 326)).toBe(ordered)
    const inBand = [cand('compilation', 336.3, 556), cand('officialMv', 318.3, 326, 'official')]
    expect(applyDurationConsistencyPreference(inBand, 326)[0].video.bvid).toBe('officialMv')
  })
})

describe('applyIdentityVeto（同源档位优选）', () => {
  const cand = (bvid: string, score: number) => ({ video: { bvid } as any, score, type: 'other' as const })

  it('所选明显不同源 → 改选同源档位里评分最高者（SAKURA リグレット 0.264 → 0.822/0.934 中分数高的）', () => {
    const ordered = [cand('picked', 253.9), cand('sameA', 233.7), cand('sameB', 222.1)]
    const vetoed = applyIdentityVeto(ordered, new Map([['picked', 0.264], ['sameA', 0.822], ['sameB', 0.934]]))
    expect(vetoed[0].video.bvid).toBe('sameA') // 档内按分数：sameA 233.7 > sameB 222.1
  })

  it('所选已同源（≥0.8）→ 不动（ヒビカセ live 0.689 低于档位，但同源档内有 0.87 的搬运 → 会改选）', () => {
    // 0.689 < 0.8：按规则改选同源档内评分最高者
    const ordered = [cand('live', 249.3), cand('subbed', 249), cand('mv4k', 247.6)]
    const vetoed = applyIdentityVeto(ordered, new Map([['live', 0.689], ['subbed', 0.703], ['mv4k', 0.759]]))
    expect(vetoed[0].video.bvid).toBe('live') // 三条都 <0.8 → 无同源档 → 保持
  })

  it('真 MV 与静态搬运都同源 → 保持分数序（送り狼：官方 0.869 与静态 0.985 同在档内 → 官方保留）', () => {
    const ordered = [cand('official', 284.7), cand('staticHiRes', 207.2)]
    const vetoed = applyIdentityVeto(ordered, new Map([['official', 0.869], ['staticHiRes', 0.985]]))
    expect(vetoed).toBe(ordered)
  })

  it('纯人声轨/剪辑版被同源候选替换（Манекены 0.367 → 0.922）', () => {
    const ordered = [cand('vocalStem', 201), cand('sameSource', 199.1)]
    const vetoed = applyIdentityVeto(ordered, new Map([['vocalStem', 0.367], ['sameSource', 0.922]]))
    expect(vetoed[0].video.bvid).toBe('sameSource')
  })

  it('缺探针数据/单候选/无同源档 → 原样返回', () => {
    const ordered = [cand('a', 100), cand('b', 90)]
    expect(applyIdentityVeto(ordered, new Map())).toBe(ordered)
    expect(applyIdentityVeto(ordered, new Map([['b', 0.5]]))).toBe(ordered) // 无 ≥0.8 同源档
    expect(applyIdentityVeto(ordered, new Map([['a', 0.3], ['b', 0.4]]))).toBe(ordered)
    expect(applyIdentityVeto([cand('a', 100)], new Map([['a', 0.5]]))).toEqual([cand('a', 100)])
  })
})

describe('applyOfficialTierPreference（同源档位内官号优选）', () => {
  const cand = (bvid: string, score: number, upMatch = false) => ({
    video: { bvid } as any, score, type: 'other' as const, signals: { uploaderMatchesArtist: upMatch },
  })

  it('所选同源但非官号，池内有同源官号（峰差 ≤0.08）→ 改选官号（炎 0.969 中日字幕 → LiSA_OFFiCiAL 0.927）', () => {
    const ordered = [cand('subbed', 275.6), cand('lisaOfficial', 249.9, true)]
    const out = applyOfficialTierPreference(ordered, new Map([['subbed', 0.969], ['lisaOfficial', 0.927]]))
    expect(out[0].video.bvid).toBe('lisaOfficial')
  })

  it('官号峰明显更低（不眠之夜 官号练习室 0.803 vs 所选 0.982）→ 容差内不改选，对齐优先', () => {
    const ordered = [cand('reupload', 270.6), cand('official', 259.6, true)]
    const out = applyOfficialTierPreference(ordered, new Map([['reupload', 0.982], ['official', 0.803]]))
    expect(out).toBe(ordered)
  })

  it('所选已是官号 → 不动；多个官号 → 取评分最高（Fire Again 0.865→无畏契约 0.941）', () => {
    const already = [cand('official', 293.6, true), cand('other', 280)]
    expect(applyOfficialTierPreference(already, new Map([['official', 0.865], ['other', 0.941]]))).toBe(already)
    const multi = [cand('fan', 293.6), cand('officialLow', 200, true), cand('officialHigh', 250, true)]
    const out = applyOfficialTierPreference(multi, new Map([['fan', 0.865], ['officialLow', 0.941], ['officialHigh', 0.9]]))
    expect(out[0].video.bvid).toBe('officialHigh') // 0.9 ≥ 0.865-0.08 且评分更高
  })

  it('所不同源（峰 <0.8）→ 不接管（留给同源否决与 0.5 兜底）', () => {
    const ordered = [cand('cover', 300), cand('official', 250, true)]
    expect(applyOfficialTierPreference(ordered, new Map([['cover', 0.4], ['official', 0.95]]))).toBe(ordered)
  })

  it('无探针/官号峰低于档位 → 原样返回', () => {
    const ordered = [cand('a', 300), cand('b', 250, true)]
    expect(applyOfficialTierPreference(ordered, new Map())).toBe(ordered)
    expect(applyOfficialTierPreference(ordered, new Map([['a', 0.9], ['b', 0.5]]))).toBe(ordered)
  })
})

describe('isContentCredible（音源不同源时"照播 vs 回退"的内容可信度）', () => {
  const cand = (over: any = {}) => ({
    type: 'other' as const,
    officialVerifyType: -1,
    signals: { negativeHit: false, hasArtist: false, nearDuration: false, uploaderMatchesArtist: false, officialChannel: false, ...over.signals },
    ...over,
  })

  it('官号/歌手本人/机构认证 → 可信（源不同也照播：Wildfire 0.37、前前前世 movie ver. 0.30）', () => {
    expect(isContentCredible(cand({ signals: { uploaderMatchesArtist: true } }))).toBe(true)
    expect(isContentCredible(cand({ signals: { officialChannel: true } }))).toBe(true)
    expect(isContentCredible(cand({ officialVerifyType: 1 }))).toBe(true)
    expect(isContentCredible(cand({ type: 'official', signals: { hasArtist: true } }))).toBe(true)
  })

  it('认证账号 + 时长贴近 → 可信（游戏官号：崩铁《Wildfire》verified=0、音源与平台不同版）', () => {
    expect(isContentCredible(cand({ officialVerifyType: 0, signals: { nearDuration: true } }))).toBe(true)
    // 未认证账号不算（实测回退清单 44 首全部 verified=-1：直播录音/游戏录像/整活视频）
    expect(isContentCredible(cand({ officialVerifyType: -1, signals: { hasArtist: true, nearDuration: true } }))).toBe(false)
  })

  it('负向类型 → 不可信（osu!mania 打歌 0.31、镜音翻唱 0.17、赛车试玩 0.23、直播录音 0.12）', () => {
    expect(isContentCredible(cand({ type: 'cover', signals: { hasArtist: true, nearDuration: true } }))).toBe(false)
    expect(isContentCredible(cand({ type: 'instrumental', signals: { uploaderMatchesArtist: true } }))).toBe(false)
    expect(isContentCredible(cand({ signals: { negativeHit: true, hasArtist: true, nearDuration: true } }))).toBe(false)
  })

  it('无据来源（歌名碰瓷/错歌：既非官号也无歌手命中）→ 不可信', () => {
    expect(isContentCredible(cand({ signals: { hasArtist: false, nearDuration: true } }))).toBe(false)
    expect(isContentCredible(cand({ signals: { hasArtist: true, nearDuration: false } }))).toBe(false)
  })
})

describe('scoreCandidate（候选打分）', () => {
  it('硬淘汰：歌名未完整出现在标题 → 无关视频，直接 -Infinity', () => {
    const wrong = scoreCandidate(video({ title: '【官方MV】晴天 - 周杰伦', duration: 269 }), ctx)
    expect(wrong.score).toBe(-Infinity)
  })

  it('希腊字母歌名：拉丁 Bios 标题不再被硬淘汰（泽野弘之《βiοs》实测场景）', () => {
    const greekCtx: MatchContext = { songTitle: 'βiοs', artists: ['澤野弘之'], songDuration: 274, platform: 'qq', id: 1 }
    // B 站热门正片的三种标题写法：拉丁/希腊混合/希腊带调，修复前全部 -Infinity
    const latin = scoreCandidate(video({ title: '【Animenz】Bios（10周年版）- 罪恶王冠 OST', duration: 471, play: 3_050_000, author: 'Animenzzz' }), greekCtx)
    expect(latin.score).toBeGreaterThan(0)
    const mixed = scoreCandidate(video({ title: '【罪恶王冠】《βios》拔剑神曲—王の诞生【燃向】', duration: 274, play: 4_850_000, author: '沐风の少年' }), greekCtx)
    expect(mixed.score).toBeGreaterThan(0)
    const greekToned = scoreCandidate(video({ title: '在百万豪装录音棚大声听 罪恶王冠ost 小林未郁 &澤野弘之《βίος》【Hi-res】', duration: 275, play: 2_150_000, author: 'JLRS-LeoFM' }), greekCtx)
    expect(greekToned.score).toBeGreaterThan(0)
    // 无关视频：主板 BIOS 教程标题确实含 bios 字样不会被硬淘汰，但会被压到低分（无歌手、时长不符）
    const unrelated = scoreCandidate(video({ title: '主板BIOS设置教程 网卡开关', duration: 114, play: 114_948, author: '团长电脑' }), greekCtx)
    expect(unrelated.score).toBeLessThan(120)
  })

  it('【作品名】《歌名》前缀不是「他人演唱」：不罚 -30（485万播放正片实测误罚场景）', () => {
    // 【罪恶王冠】标注的是作品，不是翻唱者——前缀后紧跟书名号歌名的结构应豁免
    const workPrefix = scoreCandidate(
      video({ title: '【罪恶王冠】《βios》拔剑神曲—王の诞生【燃向】', duration: 274, play: 4_850_000, author: '沐风の少年' }),
      { songTitle: 'βiοs', artists: ['澤野弘之'], songDuration: 274, platform: 'qq', id: 1 },
    )
    // 无歌手命中本该 -30：豁免后不应再叠加
    expect(workPrefix.signals.hasArtist).toBe(false)
    expect(workPrefix.score).toBeGreaterThan(150)
  })

  it('独立【人名】歌名前缀仍罚 -30（翻唱者标注，防翻唱压原唱）', () => {
    const personPrefix = scoreCandidate(video({ title: '【某某翻唱者】稻香', duration: 223, play: 500_000, author: '路人' }), ctx)
    expect(personPrefix.signals.hasArtist).toBe(false)
    // 无人名豁免对比：同结构但【】后紧跟书名号（【作品】《歌名》）分数显著更高（见上一用例）
    // 断言：独立【人名】拿到 -30，正片级分数（150+）不可能
    expect(personPrefix.score).toBeLessThan(140)
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

  it('本人频道 + 实名认证 → 压过中日字幕搬运（Vaundy《カーニバル》实测 292.2 vs 293.1）', () => {
    const carnivalCtx: MatchContext = { songTitle: 'カーニバル', artists: ['Vaundy'], songDuration: 203, platform: 'qq', id: 1, album: 'replica' }
    const official = scoreCandidate(
      video({ bvid: 'BV1VNLu6RExN', title: 'カーニバル(狂欢节) / Vaundy ：MUSIC VIDEO', duration: 211, play: 16_254, author: 'Vaundy' }),
      carnivalCtx,
      { rank: 0, officialVerifyType: 0 },
    )
    const reupload = scoreCandidate(
      video({ bvid: 'BV1oc411X74G', title: '【中日字幕】Vaundy 新曲「カーニバル(狂欢节)」完整版【日剧「火烧御手洗家」主题歌】正式音源', duration: 203, play: 38_603, author: '百億_光年' }),
      carnivalCtx,
      { rank: 2, officialVerifyType: -1 },
    )
    expect(official.signals.uploaderMatchesArtist).toBe(true)
    expect(reupload.signals.uploaderMatchesArtist).toBe(false)
    // 字幕对背景 MV 是冗余项（应用自带歌词），权威来源优先
    expect(official.score).toBeGreaterThan(reupload.score)
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

  it('电影作品名出现在主题曲前缀时不误判为另一首歌', () => {
    const hanabiCtx: MatchContext = { songTitle: '打上花火', artists: ['Daoko', '米津玄師'], songDuration: 286 }
    const candidate = scoreCandidate(video({
      title: '【𝟒𝐊 𝐇𝐢𝐑𝐞𝐬】《烟花》主题曲 打上花火-米津玄師、DAOKO(中日歌词)',
      duration: 286,
      play: 394000,
      author: '三桂花鱼',
      mid: 351098096,
    }), hanabiCtx)
    expect(candidate.score).not.toBe(-Infinity)
    expect(candidate.signals.hasArtist).toBe(true)
    expect(candidate.score).toBeGreaterThan(200)
  })

  it('上传者信誉权重：三桂花鱼提升，JLRS-LeoFM 降低，且不影响其他账号', () => {
    const hanabiCtx: MatchContext = { songTitle: '打上花火', artists: ['Daoko', '米津玄師'], songDuration: 286 }
    const base = video({ title: '打上花火 MV', duration: 286, play: 100_000 })
    const preferred = scoreCandidate({ ...base, author: '三桂花鱼', mid: 351098096 }, hanabiCtx)
    const preferredByMid = scoreCandidate({ ...base, author: '账号改名', mid: 351098096 }, hanabiCtx)
    const jlrs = scoreCandidate({ ...base, author: 'JLRS-LeoFM' }, hanabiCtx)
    const normal = scoreCandidate({ ...base, author: '普通音乐账号' }, hanabiCtx)
    expect(preferred.score - normal.score).toBe(45)
    expect(preferredByMid.score).toBe(preferred.score)
    expect(normal.score - jlrs.score).toBe(45)
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
    // 标题党防御后：官方频道拿到全额 MV 标记（+15），非官方自报只剩半额（+7.5），
    // 加上 officialChannel +25 与半额差 7.5，总差 32.5
    const officialChannel = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '杰威尔音乐官方' }), ctx)
    const randomChannel = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '音乐分享君' }), ctx)
    expect(officialChannel.score - randomChannel.score).toBeGreaterThanOrEqual(25)
  })

  it('官方发行 MV 压过时长贴合的翻录（SAKURA リグレット 实测用例）', () => {
    // 用户实测：索尼音乐中国发的官方 MV（7:10，机构认证）排在翻录正片后面。
    // 两处系统性偏差叠加：①「歌手「歌名」」形态判不出 artist-title，白丢 25；
    // ② 官方 MV 时长天然比流媒体单曲长，被时长项判 -15，而贴合的翻录拿 +40。
    const sakuraCtx: MatchContext = {
      songTitle: 'SAKURA リグレット (落樱的悔恨)',
      artists: ['Flower (フラワー)'],
      songDuration: 305,
      platform: 'netease',
      id: 0,
    }
    const officialMv = scoreCandidate(
      video({ bvid: 'BVsony', title: 'Flower「SAKURAリグレット」', author: '索尼音乐中国', mid: 486906719, duration: 430, play: 1496 }),
      sakuraCtx,
      { rank: 0, officialVerifyType: 1 },
    )
    const rip = scoreCandidate(
      video({ bvid: 'BVrip', title: 'Flower - SAKURA リグレット', author: '-友人C-', duration: 311, play: 6687 }),
      sakuraCtx,
      { rank: 0 },
    )
    // 「歌手「歌名」」是官方发行常用命名，必须算 artist-title（与破折号形态同权）
    expect(classifyExactTitleMatch('Flower「SAKURAリグレット」', sakuraCtx.songTitle, resolveArtistNames(['Flower (フラワー)']))).toBe('artist-title')
    expect(officialMv.signals.officialChannel).toBe(true)
    expect(officialMv.score).toBeGreaterThan(rip.score)

    // 豁免只对官方来源的「更长」方向生效：同样超长的普通搬运仍按原规则扣分
    const ripLonger = scoreCandidate(video({ title: 'Flower - SAKURAリグレット', author: 'xX永Xx', duration: 425, play: 5000 }), sakuraCtx, { rank: 0 })
    const ripMatched = scoreCandidate(video({ title: 'Flower - SAKURAリグレット', author: 'xX永Xx', duration: 311, play: 5000 }), sakuraCtx, { rank: 0 })
    expect(ripMatched.score - ripLonger.score).toBeCloseTo(55)
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
    // 标题党防御后：官号（officialBacked）拿全额 MV 标记，非官方账号只剩半额，
    // 差值在原 25/15 基础上各多出半额 MV（7.5）
    const exact = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '周杰伦' }), ctx)
    const contains = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '周杰伦官方' }), ctx)
    const normal = scoreCandidate(video({ title: '周杰伦《稻香》MV', duration: 223, play: 100_000, author: '音乐私藏馆' }), ctx)
    expect(exact.score - normal.score).toBeGreaterThanOrEqual(25)
    expect(contains.score - normal.score).toBeGreaterThanOrEqual(15)
    expect(exact.score - normal.score).toBeLessThan(40)
    expect(contains.score - normal.score).toBeLessThan(30)
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
    expect(artistOfficial.score - noVerify.score).toBe(35) // +15 个人认证 +20 官号认证叠加（原 +10，见 カーニバル 回归）
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
    // 非官方账号自报打五折：+6 主题曲 +6 加长版 +25「加长版+歌手+高播放」完整正片本体加成
    expect(themeSong.score - plain.score).toBe(37)
  })

  it('OP/ED 标记按词边界加分（动漫主题曲）', () => {
    const lisaCtx: MatchContext = { songTitle: '紅蓮華', artists: ['LiSA'], songDuration: 239 }
    const op = scoreCandidate(video({ title: '【OP】LiSA 紅蓮華 鬼灭之刃', duration: 239, play: 100_000 }), lisaCtx)
    const noOp = scoreCandidate(video({ title: 'LiSA 紅蓮華 鬼灭之刃', duration: 239, play: 100_000 }), lisaCtx)
    expect(op.score - noOp.score).toBe(9) // 非官方账号自报 OP/ED 减半（标题党防御）
    // 小写/大小写混合/带集数都应命中；普通单词（operation/editor/open）不误伤
    for (const t of ['LiSA 紅蓮華 op 鬼灭之刃', 'LiSA 紅蓮華 Ed 鬼灭之刃', 'LiSA 紅蓮華 OP1 鬼灭之刃', 'LiSA 紅蓮華 ED2 鬼灭之刃']) {
      const hit = scoreCandidate(video({ title: t, duration: 239, play: 100_000 }), lisaCtx)
      expect(hit.score - noOp.score).toBe(9)
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
    // 69s/111s 的 OP 视频相对无 OP 标记的 69s 视频仍保留 OP 加分（非官方账号半额 +9），未被短版降级扣掉
    expect(justShort.score - base.score).toBe(9)
    const base111 = scoreCandidate(video({ title: 'LiSA 紅蓮華 鬼灭之刃', duration: 111, play: 100_000 }), lisaCtx)
    expect(justLong.score - base111.score).toBe(9)
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

  it('情绪钩子引号 + 作品书名号叠加时不误罚主语位歌名（theDOGS 176.8万正片实测误伤场景）', () => {
    // 『“路上小心，艾伦”《进击的巨人》theDOGS——剧场版…』剥引号后歌名在主语位（开头），
    // 是本曲正片；旧的 -85「主标题是另一首歌」规则把它从 #3 压到 #15（复审门外）
    const dogsCtx: MatchContext = { songTitle: 'theDOGS', artists: ['澤野弘之', 'mpi'], songDuration: 275 }
    const hookQuoted = scoreCandidate(video({ title: '“路上小心，艾伦”《进击的巨人》theDOGS——剧场版 mpi/泽野弘之【Hi-Res百万级录音棚试听】', duration: 274, play: 1_768_250, author: 'JLRS-jayfm' }), dogsCtx)
    const plain = scoreCandidate(video({ title: 'theDOGS——剧场版 mpi/泽野弘之【Hi-Res百万级录音棚试听】', duration: 274, play: 1_768_250, author: 'JLRS-jayfm' }), dogsCtx)
    // 钩子引号不改变主体判定（±2 分内），不再是 -85 悬崖
    expect(Math.abs(hookQuoted.score - plain.score)).toBeLessThan(3)
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

  it('歌名自带 Anime Size / TV ver. / アニメサイズ 等短版标记时推断 tv-size', () => {
    // 用户实测：上田麗奈「リテラチュア (文学) (Anime Size)」（魔女の旅々 OP）——歌名里的
    // Anime Size 必须被识别成短版本体，否则会被当成完整版、反过来避开 90 秒的 OP 正片。
    expect(inferRecordingTarget({ songTitle: 'リテラチュア (文学) (Anime Size)', artists: ['上田麗奈'], songDuration: 90 })).toBe('tv-size')
    expect(inferRecordingTarget({ songTitle: '残酷な天使のテーゼ (TVサイズ)', artists: ['高橋洋子'], songDuration: 92 })).toBe('tv-size')
    expect(inferRecordingTarget({ songTitle: 'Some Song (Anime Ver.)', artists: ['X'], songDuration: 90 })).toBe('tv-size')
    expect(inferRecordingTarget({ songTitle: 'Some Song (TV Edition)', artists: ['X'], songDuration: 90 })).toBe('tv-size')
    expect(inferRecordingTarget({ songTitle: 'Some Song アニメver.', artists: ['X'], songDuration: 90 })).toBe('tv-size')
    // 完整版歌名（无短版标记）不受影响：仍按完整版处理、继续避开短 OP/ED；
    // 泛词不误伤（Television / Animation 不是短版标记）
    expect(inferRecordingTarget({ songTitle: 'リテラチュア', artists: ['上田麗奈'], songDuration: 260 })).toBeUndefined()
    expect(inferRecordingTarget({ songTitle: 'Television', artists: ['X'], songDuration: 200 })).toBeUndefined()
    expect(inferRecordingTarget({ songTitle: 'Animation', artists: ['X'], songDuration: 200 })).toBeUndefined()
  })

  it('Anime Size 歌曲优先匹配 1:30 的 OP/ED 正片，完整版歌曲仍避开短版', () => {
    const animeCtx: MatchContext = { songTitle: 'リテラチュア (文学) (Anime Size)', artists: ['上田麗奈'], songDuration: 90, franchise: '魔女の旅々' }
    // 短版本体：90 秒 OP 正片（自报 Anime Size）必须压过 4 分钟的完整版投稿
    const op = scoreCandidate(video({ title: '【魔女の旅々】OP リテラチュア 上田麗奈 Anime Size', duration: 90, play: 100_000 }), animeCtx)
    const fullMv = scoreCandidate(video({ title: '上田麗奈 リテラチュア 完整版 MV', duration: 250, play: 100_000 }), animeCtx)
    expect(op.score).toBeGreaterThan(fullMv.score)
    // 长短版本互斥的另一半：同一个 90 秒 OP 在完整版歌名语境下必须被短版降级压下去
    const fullCtx: MatchContext = { songTitle: 'リテラチュア', artists: ['上田麗奈'], songDuration: 250 }
    const opForFull = scoreCandidate(video({ title: '【魔女の旅々】OP リテラチュア 上田麗奈 Anime Size', duration: 90, play: 100_000 }), fullCtx)
    const fullForFull = scoreCandidate(video({ title: '上田麗奈 リテラチュア 完整版 MV', duration: 250, play: 100_000 }), fullCtx)
    expect(fullForFull.score).toBeGreaterThan(opForFull.score)
  })

  it('tv-size 的短版加分按候选标题标记发放，教学/演奏版不吃加分', () => {
    const tvCtx: MatchContext = { songTitle: 'リテラチュア (Anime Size)', artists: ['上田麗奈'], songDuration: 90 }
    const plain = scoreCandidate(video({ title: '【OP】リテラチュア 上田麗奈', duration: 90, play: 100_000 }), tvCtx)
    const marked = scoreCandidate(video({ title: '【OP】リテラチュア 上田麗奈 Anime Size', duration: 90, play: 100_000 }), tvCtx)
    expect(marked.score - plain.score).toBeGreaterThanOrEqual(30)
    const instrumental = scoreCandidate(video({ title: '【OP】リテラチュア 上田麗奈 Anime Size 钢琴版', duration: 90, play: 100_000 }), tvCtx)
    expect(instrumental.score).toBeLessThan(marked.score)
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
  it('打上花火会优先追加可信上传者查询', () => {
    const queries = buildQueries({ songTitle: '打上花火', artists: ['Daoko', '米津玄師'], songDuration: 286 })
    expect(queries[0]).toBe('打上花火 三桂花鱼')
  })
  it('auto 均衡：歌名+歌手 / 仅歌名 / 歌名+MV（含繁体/英文名别名查询）', () => {
    const queries = buildQueries(ctx)
    expect(queries[0]).toBe('稻香 周杰伦')
    expect(queries).toContain('稻香')
    expect(queries).toContain('稻香 MV')
    // 周杰伦别名（繁体/英文名）派生查询：B 站繁体标题与英文署名是独立检索面
    expect(queries.some(q => q.includes('周杰倫') || q.includes('Jay Chou'))).toBe(true)
  })
  it('auto 官方偏好：追加官方词', () => {
    const queries = buildQueries(ctx, { matchPreference: 'official' })
    expect(queries).toContain('稻香 周杰伦 官方')
    expect(queries).toContain('稻香 官方MV')
  })
  it('auto 现场偏好：追加现场词', () => {
    const queries = buildQueries(ctx, { matchPreference: 'live' })
    expect(queries).toContain('稻香 周杰伦 现场')
    expect(queries).toContain('稻香 演唱会')
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
    // 「一滴泪」型：标题完美 + 人工 CC，无歌词时按 unverified 缩水档仍险胜低播放正片。
    // 注：标题不用"直播切片"——2026-10 起「直播」已是负向标记（会提前重罚，属另一条防线）；
    // 这里要测的是 CC 复审接线本身。
    const junk = scoreCandidate(
      video({ bvid: 'BVjunk', title: '周杰伦 稻香（饭制剪辑版）', duration: 223, play: 27_700, author: '捷王中王' }),
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

describe('教学/标注向内容与圈层前缀（用户实测：Thank you for dears. 场景）', () => {
  // 复现案例：真机自动匹配曾把 1.4 万播放的「歌词详解|罗马音假名标注」排到 233.7 万播放的
  // 正片（【东方Vocal】原曲：感情的摩天楼）之前，导致看歌/MV 背景都播了教学视频。
  const dearsCtx: MatchContext = {
    songTitle: 'Thank you for dears.',
    artists: ['GET IN THE RING (みぃ)'],
    songDuration: 326,
  }

  const teaching = () => scoreCandidate(
    video({
      bvid: 'BVlesson',
      title: '歌词详解|罗马音假名标注「Thank you for dears.」GET IN THE RING',
      duration: 321,
      play: 14_126,
      author: '卷心儿-听歌学日语',
      typename: '校园学习',
    }),
    dearsCtx,
    { rank: 6, officialVerifyType: -1 },
  )

  const realMv = () => scoreCandidate(
    video({
      bvid: 'BVtouhou',
      title: '【东方Vocal】Thank you for dears.（原曲：感情的摩天楼 ～ Cosmic Mind）【中日双语字幕】',
      duration: 327,
      play: 2_337_009,
      author: '头铁的辉夜',
      typename: '乐评盘点',
    }),
    dearsCtx,
    { rank: 1, officialVerifyType: -1 },
  )

  it('歌词详解 + 教学频道：正片必须排在它前面，且不自动播放', () => {
    const lesson = teaching()
    const mv = realMv()
    expect(lesson.signals.negativeHit).toBe(true)
    expect(shouldAutoPlay(lesson)).toBe(false)
    expect(mv.score).toBeGreaterThan(lesson.score)
  })

  it('标题负向词（详解/空耳/谐音）逐条生效；配罗马音的正规搬运不罚', () => {
    const base = scoreCandidate(video({ title: 'Thank you for dears.', duration: 326, play: 100_000, author: '搬运工' }), dearsCtx, {})
    const explained = scoreCandidate(video({ title: 'Thank you for dears. 歌词详解', duration: 326, play: 100_000, author: '搬运工' }), dearsCtx, {})
    expect(base.score - explained.score).toBeGreaterThanOrEqual(35)
    // 正规搬运带「中日字幕配罗马音」后缀是加分项不是教学向（用户实测：4K音楽館 录音室版）
    const romaji = scoreCandidate(video({ title: 'Thank you for dears. 中日字幕配罗马音', duration: 326, play: 100_000, author: '搬运工' }), dearsCtx, {})
    expect(romaji.score).toBeGreaterThanOrEqual(base.score)
  })

  it('作者名命中教学向标记也降权（标题可以完全不提教学）', () => {
    const plainAuthor = scoreCandidate(video({ title: 'Thank you for dears. 歌词版', duration: 326, play: 100_000, author: '搬运工' }), dearsCtx, {})
    const teachingAuthor = scoreCandidate(video({ title: 'Thank you for dears. 歌词版', duration: 326, play: 100_000, author: '卷心儿-听歌学日语' }), dearsCtx, {})
    expect(plainAuthor.score - teachingAuthor.score).toBeGreaterThanOrEqual(35)
    expect(teachingAuthor.signals.negativeHit).toBe(true)
  })

  it('【东方Vocal】等圈层/类型前缀不再被当"他人署名"（与真实人名前缀对比）', () => {
    const qualifier = scoreCandidate(video({ title: '【东方Vocal】Thank you for dears.', duration: 326, play: 100_000, author: 'up主' }), dearsCtx, {})
    const personLead = scoreCandidate(video({ title: '【黒音さや】Thank you for dears.', duration: 326, play: 100_000, author: 'up主' }), dearsCtx, {})
    expect(qualifier.score).toBeGreaterThan(personLead.score)
  })

  it('「原曲/東方」框架下标题无假名不再触发"中文同名曲"降权', () => {
    // 两条标题只差「原曲」二字（都不构成精确标题匹配，排除其它项干扰）
    const framed = scoreCandidate(video({ title: 'Thank you for dears.（原曲：感情的摩天楼）', duration: 326, play: 100_000, author: '头铁的辉夜' }), dearsCtx, {})
    const bare = scoreCandidate(video({ title: 'Thank you for dears.（感情的摩天楼）', duration: 326, play: 100_000, author: '头铁的辉夜' }), dearsCtx, {})
    expect(framed.score - bare.score).toBe(15)
  })

  it('钩子式引号文案不按"主标题是另一首歌"重罚（歌名就是引号外的主体）', () => {
    const hooked = scoreCandidate(video({ title: '“竟然是东方曲 难怪这么惊艳”！Thank you for dears.', duration: 327, play: 7_060_056, author: '饿了的白熊' }), dearsCtx, { rank: 0 })
    const plain = scoreCandidate(video({ title: '竟然是东方曲 难怪这么惊艳！Thank you for dears.', duration: 327, play: 7_060_056, author: '饿了的白熊' }), dearsCtx, { rank: 0 })
    expect(hooked.score).toBe(plain.score)
  })

  it('翻调（虚拟歌手二次创作）按翻唱处理：类型 cover + 负向压分 + 不自动播放', () => {
    expect(classifyCandidateType('【重音Teto|SV翻调】GET IN THE RING - Thank You For Dears')).toBe('cover')
    const cover = scoreCandidate(
      video({ title: '【重音Teto|SV翻调】GET IN THE RING - Thank You For Dears', duration: 327, play: 900, author: 'やそうきょく夜想曲', typename: 'VOCALOID·UTAU' }),
      dearsCtx,
      { rank: 39 },
    )
    expect(cover.type).toBe('cover')
    expect(cover.signals.negativeHit).toBe(true)
    expect(shouldAutoPlay(cover)).toBe(false)
    expect(cover.score).toBeLessThan(realMv().score)
  })
})

describe('手动选择的持久化语义（未标记不构成记忆）', () => {
  it('会话内手动选择只走内存，切歌即失效', () => {
    setSessionManualPick('qq:1', 'BVPICK')
    expect(getSessionManualPick('qq:1')).toBe('BVPICK')
    // 切到别的歌（另一个表面也会通知一次）
    noteCurrentSongForManualPick('qq:2')
    expect(getSessionManualPick('qq:1')).toBeNull()
    // 直接换 key 取也会失效
    setSessionManualPick('qq:3', 'BVOTHER')
    expect(getSessionManualPick('qq:4')).toBeNull()
    expect(getSessionManualPick('qq:3')).toBeNull()
    clearSessionManualPick()
  })

  it('peekSessionManualPick 查别的歌不作废当前选择（预加载不能清掉手动选择）', () => {
    // 背景/播放器会为「下一首」预加载而查询别的 songKey：若用会触发"切歌即失效"的
    // getSessionManualPick，当前歌的手动选择会被后台预加载悄悄清掉。
    setSessionManualPick('qq:peek', 'BVKEEP')
    expect(peekSessionManualPick('qq:next')).toBeNull()
    expect(peekSessionManualPick('qq:peek')).toBe('BVKEEP')
    clearSessionManualPick()
  })

  it('手动选择后重新匹配仍是它：不被自动第一名顶掉、旧缓存也不盖过（看歌/背景一致）', async () => {
    // 用户实测 bug：看歌里换成另一个 MV → 切普通歌词（背景已对齐同一 BVID）→ 再切回看歌，
    // 播放器重挂载后后台复跑匹配，best 回到自动第一名 ≠ 手动选择。
    // 背景靠自己的接管 effect 读会话内选择，播放器走 findBestBilibiliMv —— 两表面必须同源。
    setBilibiliApiBaseForTest('http://probe.invalid/api/bilibili')
    const json = (payload: unknown) => ({ ok: true, json: async () => payload }) as Response
    const hit = (bvid: string, title: string, duration: number, play: number, author: string) => ({
      bvid, title, duration, play, author, mid: 1, pic: '', typename: '音乐',
    })
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.includes('/search')) {
        return json({
          code: 0,
          results: [
            hit('BVAUTO', 'アーティスト - 曲名', 202, 500_000, '搬运工'),
            hit('BVPICK', '曲名', 205, 12, '小UP'),
          ],
        })
      }
      if (url.includes('/view')) {
        const bvid = new URL(url).searchParams.get('bvid') || ''
        const isPick = bvid === 'BVPICK'
        return json({
          code: 0,
          data: {
            bvid,
            cid: 1,
            title: isPick ? '曲名' : 'アーティスト - 曲名',
            duration: isPick ? 205 : 202,
            play: isPick ? 12 : 500_000,
            pic: '',
            owner: { mid: 1, name: isPick ? '小UP' : '搬运工', officialVerifyType: -1 },
          },
        })
      }
      return json({ code: -1 })
    }))
    const probeCtx: MatchContext = { songTitle: '曲名', artists: ['アーティスト'], songDuration: 203, platform: 'netease', id: 987654 }
    try {
      clearAllMvMatchCache()
      clearSessionManualPick()
      // ① 没有手动选择：自动第一名 BVAUTO（缓存建立）
      const auto = await findBestBilibiliMv(probeCtx, { useDeveloperDeclarations: false })
      expect(auto.best?.video.bvid).toBe('BVAUTO')
      // ② 手动换成 BVPICK（只写会话内记忆，未标记）→ 重新匹配必须还是 BVPICK
      setSessionManualPick(songKeyOf(probeCtx), 'BVPICK')
      const picked = await findBestBilibiliMv(probeCtx, { useDeveloperDeclarations: false })
      expect(picked.best?.video.bvid).toBe('BVPICK')
      expect(picked.status).toBe('auto')
      // 候选列表仍保留自动结果，用户还能换回去
      expect(picked.candidates.some((c) => c.video.bvid === 'BVAUTO')).toBe(true)
    } finally {
      clearSessionManualPick()
      clearAllMvMatchCache()
      resetLegacyOverrideSweepForTest()
      setBilibiliApiBaseForTest('http://localhost:3001/api/bilibili')
      vi.unstubAllGlobals()
    }
  })

  it('只有标记才写 override；遗留的未标记 override 会被清扫，标记的保留', () => {
    // 清扫是一次性开关：先复位，避免前面调用过匹配器的用例把它用掉（顺序无关）
    resetLegacyOverrideSweepForTest()
    setBilibiliOverride('qq:legacy', 'BVLEGACY')
    saveLocalMvMark({ songKey: 'qq:marked', songTitle: '歌', artist: '人', bvid: 'BVMARKED', videoTitle: 't', pic: '', author: '' })
    expect(getBilibiliOverride('qq:legacy')).toBe('BVLEGACY')
    pruneLegacyUnmarkedOverrides()
    expect(getBilibiliOverride('qq:legacy')).toBeNull()
    expect(getBilibiliOverride('qq:marked')).toBe('BVMARKED')
    expect(getLocalMvMark('qq:marked')?.bvid).toBe('BVMARKED')
    removeLocalMvMark('qq:marked')
    expect(getBilibiliOverride('qq:marked')).toBeNull()
  })

  it('清除 MV 匹配缓存会同时清掉标记库（弹窗文案承诺的"手动标记"）', () => {
    saveLocalMvMark({ songKey: 'qq:clear', songTitle: '歌', artist: '人', bvid: 'BVCLEAR', videoTitle: 't', pic: '', author: '' })
    expect(getLocalMvMark('qq:clear')?.bvid).toBe('BVCLEAR')
    clearAllMvMatchCache()
    expect(getLocalMvMark('qq:clear')).toBeNull()
    expect(getBilibiliOverride('qq:clear')).toBeNull()
  })
})

describe('跨语言版本与《歌名》前缀描述语（扩充评测发现的失败模式）', () => {
  const yoruCtx: MatchContext = { songTitle: '夜に駆ける', artists: ['YOASOBI'], songDuration: 261 }

  it('英文版压不过日文官方 MV（用户实测：Into The Night 曾登顶）', () => {
    const englishVer = scoreCandidate(
      video({ title: '【中英字幕】Into The Night（夜に駆ける 英文 官方正式完整版） - YOASOBI 向夜晚奔去Ayase+ikura幾田りら', duration: 276, play: 615_232, author: '姐夫日剧字幕组' }),
      yoruCtx,
      { rank: 1, officialVerifyType: -1 },
    )
    const jpOfficial = scoreCandidate(
      video({ title: 'YOASOBI 夜に駆ける (Yoru ni Kakeru) Official Music Video', duration: 276, play: 14_765_074, author: 'Ayase-YOASOBI' }),
      yoruCtx,
      { rank: 2, officialVerifyType: 1 },
    )
    expect(jpOfficial.score).toBeGreaterThan(englishVer.score)
  })

  it('同语言的版本标记（中文字幕/日本語フル）不触发跨语言罚分', () => {
    const withZhSub = scoreCandidate(
      video({ title: '【中文字幕】夜に駆ける - YOASOBI', duration: 261, play: 100_000, author: '搬运工' }),
      yoruCtx,
      {},
    )
    const plain = scoreCandidate(
      video({ title: '夜に駆ける - YOASOBI', duration: 261, play: 100_000, author: '搬运工' }),
      yoruCtx,
      {},
    )
    expect(withZhSub.score).toBeGreaterThanOrEqual(plain.score)
  })

  it('中文歌标题的「英文版」候选被压（翻译版不是原录音）', () => {
    const daoXiang: MatchContext = { songTitle: '稻香', artists: ['周杰伦'], songDuration: 223 }
    const enVer = scoreCandidate(video({ title: '稻香 英文版 Rice Field English Ver', duration: 223, play: 500_000, author: '搬运工' }), daoXiang, {})
    const normal = scoreCandidate(video({ title: '稻香 - 周杰伦', duration: 223, play: 500_000, author: '搬运工' }), daoXiang, {})
    expect(normal.score).toBeGreaterThan(enVer.score)
  })

  it('《歌名》前的描述语（官方制作的/自制）不再被当成"他人署名"（用户实测：EVA 2021 官方 MV 被罚 -45）', () => {
    const evaCtx: MatchContext = { songTitle: '残酷な天使のテーゼ', artists: ['高橋洋子'], songDuration: 245 }
    const officialMv = scoreCandidate(
      video({ title: '【4K 新世纪福音战士】官方制作的《残酷な天使のテーゼ》MUSIC VIDEO 2021年黑科技4K60帧', duration: 245, play: 1_351_282, author: 'RiKi的音乐游戏店' }),
      evaCtx,
      { rank: 30 },
    )
    // 前缀是真演唱者时仍然要罚（张国荣《春夏秋冬》对 NIKIIE 的歌）
    const othersPerf = scoreCandidate(
      video({ title: '张国荣Leslie《残酷な天使のテーゼ》', duration: 245, play: 1_351_282, author: '荣迷俱乐部' }),
      evaCtx,
      { rank: 31 },
    )
    expect(officialMv.score).toBeGreaterThan(othersPerf.score)
  })
})

describe('normalizeText NFC（分解形假名导致硬误杀）', () => {
  it('セ+U+3099 组合浊点经 NFC 归一为 ゼ，歌名硬淘汰不再误杀（用户实测：EVA 官方 MV 被误杀）', () => {
    // B 站真实标题：'残酷な天使のテーゼ' 的 ゼ 被上传方写成 セ+组合浊点（NFD 形态）
    const decomposed = '残酷な天使のテー' + 'セ' + '゙'
    expect(normalizeText(decomposed)).toBe(normalizeText('残酷な天使のテーゼ'))
    const eva: MatchContext = { songTitle: '残酷な天使のテーゼ', artists: ['高橋洋子'], songDuration: 245 }
    const s = scoreCandidate(
      video({ title: `【4K】官方制作的《${decomposed}》MUSIC VIDEO`, duration: 245, play: 1_351_282, author: 'RiKi的音乐游戏店' }),
      eva,
      {},
    )
    expect(s.score).not.toBe(-Infinity)
  })
})

describe('搜索阶段多P合集软罚（尼尔 case：正确 OST 合集曾掉出复审名单）', () => {
  it('搜索阶段（无分P信息）总时长 ≥3× 歌曲时长 → 软罚 -15 而非 -35，保留进复审资格', () => {
    const compilation = video({ title: '周杰伦《稻香》MV全集', duration: 1200, play: 200_000, author: '周杰伦音乐馆' })
    const searchStage = scoreCandidate(compilation, ctx)
    // 复审确认它是长单P（无分P可选）→ 恢复重罚
    const reviewStage = scoreCandidate(compilation, ctx, { effectiveDuration: 1200 })
    expect(reviewStage.score - searchStage.score).toBe(-20) // 复审 -35 vs 搜索阶段软罚 -15
  })

  it('总时长不足 3× 歌曲时长的普通长视频不软化（仍按 -35）', () => {
    const longVideo = video({ title: '周杰伦《稻香》MV', duration: 620 })
    const searchStage = scoreCandidate(longVideo, ctx)
    const reviewStage = scoreCandidate(longVideo, ctx, { effectiveDuration: 620 })
    expect(reviewStage.score).toBe(searchStage.score)
  })

  it('复审阶段拿到贴近的分P时长 → 正常计分（合集视频的分P路径闭环）', () => {
    const compilation = video({ title: '周杰伦《稻香》MV全集', duration: 1200, play: 200_000, author: '周杰伦音乐馆' })
    const reviewed = scoreCandidate(compilation, ctx, { effectiveDuration: 223 })
    expect(reviewed.signals.nearDuration).toBe(true)
  })
})

describe('songDurationOverride（平台元数据时长错误防御）', () => {
  const badDurCtx: MatchContext = { songTitle: 'ばかじゃないのに', artists: ['ずっと真夜中でいいのに。'], songDuration: 122 }
  it('有共识校正值时按校正值评分：正确官方 MV 获得时长贴近分', () => {
    const mv = video({ title: 'ずっと真夜中でいいのに。『ばかじゃないのに』MUSIC VIDEO', duration: 256, play: 100_000, author: '环球音乐日本' })
    const withOverride = scoreCandidate(mv, badDurCtx, { songDurationOverride: 256 })
    const withoutOverride = scoreCandidate(mv, badDurCtx)
    expect(withOverride.signals.nearDuration).toBe(true)
    expect(withOverride.score - withoutOverride.score).toBe(75) // +40 vs -35
  })

  it('校正值优先于平台时长，且不影响无校正值路径', () => {
    const clip = video({ title: 'ばかじゃないのに 试听短片', duration: 122, play: 5_000 })
    const asOverride = scoreCandidate(clip, badDurCtx, { songDurationOverride: 256 })
    const asIs = scoreCandidate(clip, badDurCtx)
    expect(asOverride.score).toBeLessThan(asIs.score) // 122s 片段在正确基准下被压
  })
})

describe('detectSongDurationConsensus（候选时长聚集推正平台错误时长）', () => {
  const consensusCtx: MatchContext = { songTitle: 'ばかじゃないのに', artists: ['ずっと真夜中でいいのに。'], songDuration: 122 }
  const v = (bvid: string, title: string, duration: number, author = '搬运君'): BilibiliVideo => ({
    bvid, title, duration, play: 1_000, author, pic: '', typename: '音乐',
  })

  it('≥3 个双命中候选聚集 ±10% 且与平台时长偏离 >60% → 返回聚集中位数', () => {
    const videos = [
      v('BV1', 'ずっと真夜中でいいのに。『ばかじゃないのに』MUSIC VIDEO', 256, '环球音乐日本'),
      v('BV2', 'ばかじゃないのに / ずっと真夜中でいいのに。(Official)', 254),
      v('BV3', '【公式MV】ばかじゃないのに ずっと真夜中でいいのに。', 258),
      v('BV4', 'ばかじゃないのに 短版试听', 122),
    ]
    expect(detectSongDurationConsensus(videos, consensusCtx)).toBe(256)
  })

  it('候选时长分散（无聚集簇）→ 不校正', () => {
    const videos = [
      v('BV1', 'ばかじゃないのに ずっと真夜中でいいのに。', 256),
      v('BV2', 'ばかじゃないのに ずっと真夜中でいいのに。 现场', 180),
      v('BV3', 'ばかじゃないのに ずっと真夜中でいいのに。 钢琴版', 300),
    ]
    expect(detectSongDurationConsensus(videos, consensusCtx)).toBeUndefined()
  })

  it('聚集簇不足 3 个 → 不校正', () => {
    const videos = [
      v('BV1', 'ばかじゃないのに ずっと真夜中でいいのに。', 256),
      v('BV2', 'ばかじゃないのに ずっと真夜中でいいのに。 完整版', 258),
      v('BV3', 'ばかじゃないのに ずっと真夜中でいいのに。 试听', 122),
    ]
    expect(detectSongDurationConsensus(videos, consensusCtx)).toBeUndefined()
  })

  it('偏离 ≤60%（小误差）→ 不校正（保守阈值，避免误伤 TV size 等合法差异）', () => {
    const ctx238: MatchContext = { ...consensusCtx, songDuration: 238 }
    const videos = [
      v('BV1', 'ばかじゃないのに ずっと真夜中でいいのに。', 256),
      v('BV2', 'ばかじゃないのに ずっと真夜中でいいのに。 完整版', 255),
      v('BV3', 'ばかじゃないのに ずっと真夜中でいいのに。 MV', 257),
    ]
    expect(detectSongDurationConsensus(videos, ctx238)).toBeUndefined()
  })

  it('标题命中的候选但歌手/上传者全不命中 → 不计入共识（防同名曲污染）', () => {
    const videos = [
      v('BV1', 'ばかじゃないのに （别人翻唱）', 256, '路人A'),
      v('BV2', 'ばかじゃないのに 翻唱版', 254, '路人B'),
      v('BV3', 'ばかじゃないのに cover', 258, '路人C'),
    ]
    expect(detectSongDurationConsensus(videos, consensusCtx)).toBeUndefined()
  })
})

describe('pickBestPage（多P分P选择：标题内容为主，时长兜底）', () => {
  const pages = (parts: Array<[string, number]>) =>
    parts.map(([part, duration], i) => ({ cid: i + 1, page: i + 1, part, duration }))
  const pageCtx = (songDuration?: number) => ({ songTitle: '稻香', artists: ['周杰伦'], songDuration })

  it('标题命中歌名的分 P 优先（不看时长）', () => {
    const idx = pickBestPage(pages([['01', 100], ['稻香 完整版', 180], ['02', 223]]), pageCtx(223))
    expect(idx).toBe(1)
  })

  it('伴奏/现场分 P 降权，正片分 P 胜出（内容判据来自上传者的分 P 命名）', () => {
    const idx = pickBestPage(
      pages([['稻香 伴奏', 223], ['稻香 现场版', 223], ['稻香 MV 完整版', 223]]),
      pageCtx(223),
    )
    expect(idx).toBe(2)
  })

  it('纯编号分 P 无标题信息 → 按时长贴近兜底（不盲选第 1 个分 P）', () => {
    const idx = pickBestPage(pages([['01', 400], ['02', 223], ['03', 500]]), pageCtx(223))
    expect(idx).toBe(1)
  })

  it('标题全无命中的文字分 P → 也按时长贴近兜底', () => {
    const idx = pickBestPage(pages([['杂谈', 400], ['音乐分享', 223], ['合集', 500]]), pageCtx(223))
    expect(idx).toBe(1)
  })

  it('分 P 无时长信息 → 回退第 1 个分 P（历史行为）', () => {
    const idx = pickBestPage(pages([['01', 0], ['02', 0]]), pageCtx(223))
    expect(idx).toBe(0)
  })

  it('单 P 视频直接返回 0', () => {
    const idx = pickBestPage(pages([['稻香', 223]]), pageCtx(223))
    expect(idx).toBe(0)
  })
})
