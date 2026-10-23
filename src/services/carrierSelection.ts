/**
 * 多平台载体选择算法（平台可用性增强的核心）
 *
 * 回答的问题：一首原平台（汽水/Spotify/QQ/酷狗/Apple）播不了的歌，在「当前已登录、
 * 且能实际出声」的其它平台里，用哪个平台的音源出声最合适？
 *
 * 设计原则（与「身份不换」口径一致）：
 * - 身份/收藏/评论/歌词归属永远跟原平台，这里只决定"借谁的音频"；
 * - 能完整播放 > 音质高 > 匹配准 > 平台偏好，按这个优先级排序；
 * - 一切登录态/会员态/音质档案由调用方注入（本模块不做 IO，可单测）；
 * - 候选必须来自搜索结果（title/artist/duration 评分），算法只负责"选谁"，
 *   不负责"找谁"——搜索仍走 findPlayableAppleSong 的并行多源搜索。
 */

import type { MusicPlatform } from './platforms'
import type { Song } from './musicApi'

/** 规范化会员档位（与 utils/musicEntitlements 的 EntitlementTier 同构，避免环依赖此处重声明） */
export type CarrierTier = 'free' | 'vip' | 'svip' | 'unknown'

/** 一个平台的可用性档案：调用方（App）从登录态/会员态/设置实时组装 */
export interface CarrierPlatformProfile {
  platform: MusicPlatform
  /** 是否已登录（未登录的载体平台不参与——借源不能要求用户去另一个平台再登一次） */
  loggedIn: boolean
  /** 会员档位；unknown = 不预设（酷狗），实测取流 */
  tier: CarrierTier
  /**
   * 该平台当前可取到的最高音质档（0-100 归一化分）。
   * 由调用方按用户音质偏好设置折算（standard 60 / high 70 / lossless 90 / hires 100）；
   * 0 = 未设置偏好，按平台档位上限算。会员档位会进一步封顶（见 effectiveQualityScore）。
   */
  qualityScore: number
  /** 用户当前点歌进入的平台（它是「自己平台」，平票时优先）——由调用方每次传入 */
  isPreferred?: boolean
}

/** 载体选择结果：胜出者 + 完整排序（供日志/界面解释"为什么用了它"） */
export interface CarrierDecision {
  best: CarrierPlatformProfile | null
  ranking: Array<{ platform: MusicPlatform; score: number; reasons: string[] }>
}

/** 各平台音源的实际品质上限（归一化 0-100）：标准音质=60 起步，无损/Hi-Res 拉满 */
// 评分锚点：standard 60 / high 70 / lossless 90 / hires 100。
// 候选之间差 10 分才换平台的容差（QUALITY_TIE_THRESHOLD）就是按这个刻度定的：
// 标准音质与无损的差距（30）远超容差，能被音质档拉开；两个都无损则落入平票分支。
export const PLATFORM_QUALITY_CEILING: Record<'netease' | 'qq' | 'kugou' | 'soda', number> = {
  netease: 100, // 无损/Hi-Res/超清母带
  qq: 100,      // 无损/臻音全景声/超清母带
  kugou: 100,   // 无损/Hi-Res（概念版凭据）
  soda: 70,     // 汽水上游最高 high 档
}

/**
 * 按会员档位 × 用户音质偏好折算一个平台"实际能取到的音质分"。
 * - profile.qualityScore：用户音质偏好折算分（standard 60 / high 70 / lossless 90 / hires 100），
 *   由调用方从 audioQualitySettings 组装；0/缺省视为"不设偏好"，不收紧档位上限。
 * - 会员档位封顶：免费账号勾了无损也拿不到无损（free 封顶 55-70）；unknown 给中上估分
 *   （酷狗无档位来源，不惩罚实测）；svip/vip 按平台上限走。
 */
export function effectiveQualityScore(profile: CarrierPlatformProfile): number {
  const ceiling = PLATFORM_QUALITY_CEILING[profile.platform as keyof typeof PLATFORM_QUALITY_CEILING] ?? 60
  let cap: number
  switch (profile.tier) {
    case 'svip': cap = ceiling; break
    case 'vip': cap = Math.min(ceiling, 95); break
    case 'free': cap = Math.min(ceiling, profile.platform === 'soda' ? 70 : 55); break
    default: cap = Math.min(ceiling, 70)
  }
  const preference = profile.qualityScore > 0 ? profile.qualityScore : cap
  return Math.min(cap, preference)
}

/** 候选歌（搜索结果）与它的档位要求 */
export interface CarrierCandidate {
  song: Song
  /** 该候选要求的最低会员档（Song.requiredTier；旧数据只有 vip 布尔） */
  tier: CarrierTier
}

export interface CarrierSelectionInput {
  /** 原平台（点歌进入的平台）。它若出现在候选里且可播，平票时优先 */
  originPlatform: MusicPlatform
  /** 已登录且参与借源的载体平台档案 */
  profiles: CarrierPlatformProfile[]
  /** 每个平台搜到的候选（同一平台多个候选取最高分；由调用方传入评分） */
  candidatesByPlatform: Record<string, CarrierCandidate[]>
  /** 候选与原曲的匹配分（0-100，来自 findPlayableAppleSong 的评分口径） */
  matchScoreOf: (song: Song) => number
  /**
   * 音质偏好容差：候选间音质分差小于此值视为"听不出差别"，交给匹配分/偏好决定。
   * 默认 10（标准音质 60 与无损 90 之间还隔着高品 70，10 分≈同一档）。
   */
  qualityTieThreshold?: number
}

/**
 * 载体选择主算法。
 *
 * 每个候选的得分（各项权重见注释，方向：能完整播 > 音质 > 匹配准 > 自己平台）：
 * - base = 匹配分（0-100，来自标题/艺人/时长评分）
 * - 可播性是门槛不是加分：候选要求 vip 而载体平台档位不够 → 直接淘汰（避免选了 30 秒试听）；
 *   unknown 档不淘汰（酷狗无档位来源，实测取流），但记录风险
 * - 音质分（0-30）：effectiveQualityScore 折算后 ×0.3——无损与标准的差距（30 分）足以
 *   盖过小幅匹配分差，但盖不过"能完整播 vs 试听"的门槛淘汰
 * - 匹配精度的余量（0-10）：匹配分超出门槛（60）越多越可信，×0.25 封顶 10
 *   ——同一平台内部多候选排序沿用这个逻辑
 * - 自己平台偏好（+6）：原平台的音源版本评论数/歌词/地域适配通常最好，
 *   但 6 分不足以逆转音质档差（30 分），只用于平票
 * 得分同分时按 ranking 稳定排序（音质分 desc → 平台名），保证同一首歌的选择可复现。
 */
export function selectCarrier(input: CarrierSelectionInput): CarrierDecision {
  const tieThreshold = input.qualityTieThreshold ?? 10
  const ranking: CarrierDecision['ranking'] = []
  const scored: Array<{ profile: CarrierPlatformProfile; song: Song; score: number; reasons: string[] }> = []

  for (const profile of input.profiles) {
    if (!profile.loggedIn) continue
    const candidates = input.candidatesByPlatform[profile.platform] || []
    if (candidates.length === 0) continue

    // 平台内取匹配分最高的候选
    let bestCandidate: CarrierCandidate | null = null
    let bestMatch = -1
    for (const candidate of candidates) {
      const match = input.matchScoreOf(candidate.song)
      if (match > bestMatch) { bestMatch = match; bestCandidate = candidate }
    }
    if (!bestCandidate) continue

    const reasons: string[] = []
    // 门槛：档位不够的候选淘汰（试听没有借源价值）。unknown 放行（实测取流）。
    const requirement = bestCandidate.tier
    if (requirement === 'vip' && profile.tier === 'free') {
      ranking.push({ platform: profile.platform, score: -1, reasons: ['需要会员，淘汰'] })
      continue
    }
    if (requirement === 'svip' && profile.tier !== 'svip') {
      ranking.push({ platform: profile.platform, score: -1, reasons: [profile.tier === 'vip' ? '需要超级会员，淘汰' : '需要超级会员，淘汰'] })
      continue
    }
    if (profile.tier === 'unknown') reasons.push('会员档位未知，实测取流')

    const quality = effectiveQualityScore(profile)
    const match = bestMatch
    const preferredBonus = profile.isPreferred || profile.platform === input.originPlatform ? 6 : 0

    const score = match * 1 + quality * 0.3 + Math.max(0, match - 60) * 0.25 + preferredBonus
    if (requirement === 'vip' && profile.tier !== 'free') reasons.push('会员可完整播放')
    if (quality >= 90) reasons.push('无损及以上')
    else if (quality >= 70) reasons.push('高品')
    if (preferredBonus) reasons.push('原平台优先')
    reasons.push(`匹配 ${Math.round(match)}`)

    scored.push({ profile, song: bestCandidate.song, score, reasons })
    ranking.push({ platform: profile.platform, score, reasons })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // 平票：先看音质差是否真的小于容差（音质主导的平票交给原平台偏好，上面已加分），
    // 这里只做稳定性兜底：音质分 desc → 平台名 asc
    const qa = effectiveQualityScore(a.profile)
    const qb = effectiveQualityScore(b.profile)
    if (Math.abs(qa - qb) >= tieThreshold) return qb - qa
    return a.profile.platform.localeCompare(b.profile.platform)
  })

  const best = scored.length > 0 ? { ...scored[0].profile } : null
  ranking.sort((a, b) => b.score - a.score)
  return { best, ranking }
}

/**
 * 从 Song 推候选的会员档要求。优先 requiredTier（网易云/QQ 新数据带），
 * 旧数据退回 vip 布尔。酷狗的 pay 字段在 kugouTrackToSong 里已映射到 vip。
 */
export function candidateTierOf(song: Song): CarrierTier {
  if (song.requiredTier === 'svip' || song.requiredTier === 'vip' || song.requiredTier === 'free') {
    return song.requiredTier
  }
  return song.vip ? 'vip' : 'free'
}
