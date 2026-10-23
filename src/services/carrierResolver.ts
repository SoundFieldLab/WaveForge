/**
 * 跨平台载体匹配编排器（平台可用性增强的入口）
 *
 * resolvePlayableSong（appleCatalog）的老流程是固定 ['netease','qq'] 双源搜索 + 阈值筛选，
 * 不看登录态、不看会员档、不看音质偏好。本模块在其上做三件事：
 * 1. 候选源动态化：从「平台可用性增强」的载体白名单里挑出**已登录**的平台（含酷狗），
 *    并行搜索（每源 top15，与老口径一致）；
 * 2. 每个候选算匹配分（与 findPlayableAppleSong 完全同一评分函数，保证口径）；
 * 3. 用 carrierSelection.selectCarrier 做选择：能完整播 > 音质 > 匹配准 > 原平台偏好。
 *
 * 身份数据（收藏/评论/歌词归属）不经过这里——调用方只拿返回的载体 Song 组
 * audioSourceOverride，歌曲身份仍在原平台。
 */

import type { MusicPlatform } from './platforms'
import type { Song } from './musicApi'
import {
  selectCarrier,
  candidateTierOf,
  type CarrierPlatformProfile,
  type CarrierCandidate,
} from './carrierSelection'
import { getPlatformCookie } from './platforms'

/** searchSongs 惰性引入：musicApi → carrierResolver → appleCatalog → musicApi 会成环，
 *  仓库既有惯例（appleCatalog 亦被 musicApi 动态 import）就在调用点 await import */
const searchSongsLazy = async (keywords: string, limit: number, platform: MusicPlatform) => {
  const { searchSongs } = await import('./musicApi')
  return searchSongs(keywords, limit, platform)
}

/** normalizeMatch 同理惰性：避免静态环（appleCatalog 静态引 musicApi）。
 *  返回归一化函数本体（ESM 模块缓存让重复 import 零开销） */
const loadNormalizeMatch = async () => {
  const { normalizeMatch } = await import('./appleCatalog')
  return normalizeMatch
}

/** 借源可用的载体平台（apple/spotify 自己也是被借方时排除——它们不能给别的平台供音频） */
const CARRIER_PLATFORMS: MusicPlatform[] = ['netease', 'qq', 'kugou']

/** 匹配门槛：与 findPlayableAppleSong 一致（60 分以下视为不可信命中） */
const MATCH_THRESHOLD = 60

/** 每源搜索条数：与老流程一致（15），混入的翻唱/Live 由评分门槛挡 */
const PER_SOURCE_LIMIT = 15

export interface ResolveOptions {
  /** 原平台（点歌进入的平台）；平票时它优先 */
  originPlatform?: MusicPlatform
  /** 载体平台档案（登录态+会员档+音质偏好分）。缺省时按凭据存在性自判（登录态兜底口径） */
  profiles?: CarrierPlatformProfile[]
  /** 指定候选源（默认：白名单中已登录的平台） */
  sources?: MusicPlatform[]
  /** 音质偏好折算分（standard 60 / high 70 / lossless 90 / hires 100），按平台给 */
  qualityScoreOf?: (platform: MusicPlatform) => number
}

/** 未登录但凭据仍在的兜底判定：与 App 登录态初始化同一口径（getPlatformCookie 存在性） */
function platformLikelyLoggedIn(platform: MusicPlatform): boolean {
  try { return Boolean(getPlatformCookie(platform)) } catch { return false }
}

/** 用户音质偏好 → 折算分（audioQualitySettings 的 preference 枚举映射） */
const PREFERENCE_SCORE: Record<string, number> = {
  standard: 60, high: 70, 'very-high': 85, lossless: 90, 'hi-res': 100,
}

/** 用户音质偏好 → 折算分（audioQualitySettings 的 preference 枚举映射）。
 *  读全局设置键（loadAudioQualitySettings 的落盘形状），auto 视为跟随会员档（0 = 不收紧） */
export function qualityPreferenceScoreOf(platform: MusicPlatform): number {
  try {
    const raw = localStorage.getItem('audioQualitySettings')
    if (!raw) return 0
    const parsed = JSON.parse(raw) as Record<string, string>
    return PREFERENCE_SCORE[parsed[platform]] ?? 0
  } catch { return 0 }
}

/**
 * 智能载体解析入口。
 * 返回载体 Song（供 audioSourceOverride 用），找不到返回 null。
 * 与老 resolvePlayableSong 的语义差异：QQ 原曲兜底由调用方处理（本函数只负责"找到的"）。
 */
export async function resolvePlayableSongSmart(
  song: Song,
  options: ResolveOptions = {},
): Promise<{ song: Song; platform: MusicPlatform; decision: ReturnType<typeof selectCarrier> } | null> {
  const originPlatform = options.originPlatform || song.platform || 'netease'
  const sources = (options.sources?.length ? options.sources : CARRIER_PLATFORMS)
    .filter(platform => platform !== originPlatform)

  if (sources.length === 0) return null

  const profiles: CarrierPlatformProfile[] = options.profiles
    ? options.profiles.filter(profile => sources.includes(profile.platform))
    : sources.map(platform => ({
      platform,
      loggedIn: platformLikelyLoggedIn(platform),
      tier: 'unknown' as const,
      qualityScore: options.qualityScoreOf?.(platform) ?? qualityPreferenceScoreOf(platform),
    }))

  const eligibleProfiles = profiles.filter(profile => profile.loggedIn)
  // 全部载体都未登录：没有任何可借的源
  if (eligibleProfiles.length === 0) return null

  const artistName = (song.artists || []).map(artist => artist.name).filter(Boolean).join(' ')
  const term = song.name || ''
  const normalizeMatch = await loadNormalizeMatch()
  if (!normalizeMatch(term)) return null  // 并行搜索所有候选源（老口径：每源 15 条）
  const results = await Promise.allSettled(
    eligibleProfiles.map(profile => searchSongsLazy(term, PER_SOURCE_LIMIT, profile.platform)),
  )

  // 匹配评分函数：与 findPlayableAppleSong 完全同口径（标题/艺人/时长）。
  // normalizeMatch 已从 appleCatalog 惰性取到（模块加载一次后恒命中缓存）。
  const matchScore = (candidate: Song): number => {
    const normalizedTitle = normalizeMatch(song.name)
    const normalizedArtist = normalizeMatch(artistName || song.name)
    const title = normalizeMatch(candidate.name)
    const artist = normalizeMatch((candidate.artists || []).map(a => a.name).join(' '))
    let score = 0
    if (title === normalizedTitle) score += 100
    else if (title && (title.includes(normalizedTitle) || normalizedTitle.includes(title))) score += 35
    if (normalizedArtist && artist === normalizedArtist) score += 40
    else if (normalizedArtist && artist && (artist.includes(normalizedArtist) || normalizedArtist.includes(artist))) score += 15
    if (song.duration && candidate.duration) {
      const diff = Math.abs(candidate.duration - song.duration)
      if (diff < 2000) score += 15
      else if (diff < 6000) score += 6
    }
    return score
  }

  const candidatesByPlatform: Record<string, CarrierCandidate[]> = {}
  results.forEach((result, index) => {
    if (result.status !== 'fulfilled') return
    const platform = eligibleProfiles[index].platform
    const songs = result.value?.songs
    if (!Array.isArray(songs)) return
    const candidates = songs
      .filter(candidate => matchScore(candidate) >= MATCH_THRESHOLD)
      .map(candidate => ({ song: candidate, tier: candidateTierOf(candidate) }))
    if (candidates.length > 0) candidatesByPlatform[platform] = candidates
  })

  if (Object.keys(candidatesByPlatform).length === 0) return null

  const decision = selectCarrier({
    originPlatform,
    profiles: eligibleProfiles,
    candidatesByPlatform,
    matchScoreOf: matchScore,
  })

  if (!decision.best) return null
  const winner = decision.best
  const winnerCandidates = candidatesByPlatform[winner.platform] || []
  if (winnerCandidates.length === 0) return null
  // selectCarrier 平台内取的是最高匹配分候选，这里取同一个
  const bestCandidate = winnerCandidates.reduce((acc, cur) =>
    matchScore(cur.song) > matchScore(acc.song) ? cur : acc)
  return { song: bestCandidate.song, platform: winner.platform, decision }
}

/**
 * 老签名兼容：与 resolvePlayableSong 行为一致但走智能算法。
 * QQ 原曲兜底语义保留（无可播载体时原样返回原曲）。
 */
export async function resolvePlayableSongWithAlgorithm(song: Song): Promise<Song | null> {
  if (!song) return null
  const platform = song.platform || 'netease'
  if (platform === 'netease') return song
  const resolved = await resolvePlayableSongSmart(song)
  if (resolved) return resolved.song
  return platform === 'qq' ? song : null
}
