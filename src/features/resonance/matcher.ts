/**
 * 「共振」跨平台匹配器：把房间里的规范曲目解析成**本机能播的版本**。
 *
 * 铁律（对应免责声明第 1、2 条）：
 * - 只在本机已登录、且**本机自己有权限**的平台里找同款；绝不借用他人账号、绝不打折会员限制。
 * - 找不到就返回不可播 + 明确原因（没登录 / 需要会员 / 平台没有），由 UI 静音跟随并提示。
 *
 * 解析顺序：
 *   1) 房间带来的候选源（fusedSources / 点歌方的平台版本）里，挑本机有权限且时长兼容的；
 *   2) 候选都不行 → 在本机已登录的平台上按「标题 + 歌手」搜索，用规范键 + 时长护栏确认是同一首；
 *   3) 选中的版本用 getSongUrl 实测可播（网易云/QQ/酷狗/汽水）；Apple/Spotify 交给 App 现有播放链，
 *      只要已登录且搜到就视为可播（其会员判定在各自播放链里）。
 */
import type { MusicPlatform } from '../../services/platforms'
import type { Song } from '../../services/musicApi'
import { getSongUrl, searchSongs } from '../../services/musicApi'
import { entitlementSatisfies, getSongRequiredTier, type EntitlementTier } from '../../utils/musicEntitlements'
import { canonicalTrackKey, trackDurationCompatible, type ResonanceTrack } from './model'

export type ResonanceUnplayableReason =
  | 'no-platform'      // 本机没有任何可用平台（全部未登录）
  | 'locked'           // 有这首歌，但需要会员/版权受限
  | 'missing'          // 本机平台都没有这首歌
  | 'unavailable'      // 有权限但取流失败（下架/网络）
  | 'error'

export interface ResonanceLocalTrack {
  playable: boolean
  reason?: ResonanceUnplayableReason
  /** 这首歌在本机需要的会员档位（用于提示"需要 VIP，你是 free"） */
  tier?: EntitlementTier
  /** 可直接交给播放器的本机版本 */
  song?: Song
  /** 是否用了另一个平台的替代版本（UI 可提示"已用 QQ 音乐版本播放"） */
  substituted?: boolean
  /** 命中的平台 */
  platform?: MusicPlatform
  /** 本机版本时长与房间版本的差值（ms），非 0 说明版本不同 */
  durationDeltaMs?: number
}

export interface ResonancePlatformAccount {
  platform: MusicPlatform
  loggedIn: boolean
  tier: EntitlementTier
}

/** 直接取流验证的平台（其余平台由各自的播放链验证） */
const URL_VERIFIED_PLATFORMS: MusicPlatform[] = ['netease', 'qq', 'kugou', 'soda']

function accountOf(accounts: ResonancePlatformAccount[], platform: MusicPlatform): ResonancePlatformAccount | undefined {
  return accounts.find(account => account.platform === platform)
}

/** 候选排序分：已登录 +10，会员档越高越好，无版权判负，时长越接近越好 */
function candidateScore(
  candidate: { platform: MusicPlatform; id: number; mid?: string; vip?: boolean; noCopyright?: boolean },
  track: ResonanceTrack,
  accounts: ResonancePlatformAccount[],
  candidateDurationMs?: number,
): number {
  const account = accountOf(accounts, candidate.platform)
  if (!account?.loggedIn) return Number.NEGATIVE_INFINITY
  if (candidate.noCopyright) return Number.NEGATIVE_INFINITY
  let score = 10 + (account.tier === 'svip' ? 4 : account.tier === 'vip' ? 2 : 0)
  if (candidate.id === 0 && !candidate.mid) score -= 2
  const duration = candidateDurationMs || track.durationMs
  if (duration > 0 && track.durationMs > 0) {
    const delta = Math.abs(duration - track.durationMs)
    score -= Math.min(6, delta / 5000)
  }
  return score
}

/**
 * 解析房间曲目 → 本机可播版本。
 * @param track 房间里的规范曲目（含候选源）
 * @param accounts 本机各平台登录与会员状态（来自 App 的 platformEntitlements + *LoggedIn）
 */
export async function resolveLocalTrack(
  track: ResonanceTrack,
  accounts: ResonancePlatformAccount[],
): Promise<ResonanceLocalTrack> {
  const usable = accounts.filter(account => account.loggedIn)
  if (usable.length === 0) return { playable: false, reason: 'no-platform' }

  const key = track.key || canonicalTrackKey(track)
  const candidates = [...(track.sources || [])]
    .map(source => ({ source, score: candidateScore(source, track, accounts) }))
    .filter(item => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score)

  // 1) 先用房间自带候选源
  let sawLocked = false
  let sawUnavailable = false
  for (const { source } of candidates) {
    const account = accountOf(accounts, source.platform)
    if (!account) continue
    const requiredTier: EntitlementTier = source.vip ? 'vip' : 'free'
    if (!entitlementSatisfies(account.tier, requiredTier) && account.tier !== 'unknown') {
      sawLocked = true
      continue
    }
    const resolved = await materializeCandidate(track, source, account)
    if (resolved.playable) return resolved
    if (resolved.reason === 'locked') sawLocked = true
    if (resolved.reason === 'unavailable') sawUnavailable = true
  }

  // 2) 候选不行 → 在本机可用平台按标题+歌手搜索
  for (const account of usable) {
    const found = await searchLocalPlatform(track, account)
    if (found) return found
  }

  // 3) 全部失败：给出最具体的原因
  if (sawLocked) return { playable: false, reason: 'locked', tier: 'vip' }
  if (sawUnavailable) return { playable: false, reason: 'unavailable' }
  return { playable: false, reason: 'missing' }
}

/** 把某个平台候选变成可播 Song（必要时实测取流） */
async function materializeCandidate(
  track: ResonanceTrack,
  source: { platform: MusicPlatform; id: number; mid?: string; appleId?: string; vip?: boolean },
  account: ResonancePlatformAccount,
): Promise<ResonanceLocalTrack> {
  const song = await songFromSource(track, source)
  if (!song) return { playable: false, reason: 'unavailable' }
  const requiredTier = getSongRequiredTier(song)
  if (requiredTier !== 'unknown' && !entitlementSatisfies(account.tier, requiredTier) && account.tier !== 'unknown') {
    return { playable: false, reason: 'locked', tier: requiredTier, platform: source.platform }
  }
  if (URL_VERIFIED_PLATFORMS.includes(source.platform)) {
    const url = await getSongUrl(source.platform === 'qq' ? (song.mid || song.id) : song.id, source.platform)
    if (!url || url === 'SONG_UNAVAILABLE') {
      return { playable: false, reason: account.tier === 'unknown' ? 'locked' : 'unavailable', tier: requiredTier, platform: source.platform }
    }
  }
  return {
    playable: true,
    song,
    platform: source.platform,
    tier: requiredTier,
    durationDeltaMs: song.duration && track.durationMs ? song.duration - track.durationMs : 0,
  }
}

/** 用平台 id 拿到 Song：网易云走详情接口，其余平台用搜索按规范键回填 */
async function songFromSource(
  track: ResonanceTrack,
  source: { platform: MusicPlatform; id: number; mid?: string; appleId?: string },
): Promise<Song | null> {
  if (source.platform === 'netease' && source.id) {
    const { fetchNeteaseSongDetail } = await import('../neteaseExplore/api')
    const [song] = await fetchNeteaseSongDetail([source.id])
    if (song) return song
  }
  if (source.mid || source.appleId || source.id) {
    const searched = await searchLocalPlatform(track, { platform: source.platform, loggedIn: true, tier: 'unknown' })
    if (searched?.song) return searched.song
  }
  return null
}

/** 在某个平台按标题+歌手搜索，用规范键 + 时长护栏确认是同一首 */
async function searchLocalPlatform(track: ResonanceTrack, account: ResonancePlatformAccount): Promise<ResonanceLocalTrack | null> {
  const keyword = [track.title, (track.artists || [])[0]].filter(Boolean).join(' ').trim()
  if (!keyword) return null
  let results: Song[] = []
  try {
    const payload = await searchSongs(keyword, 12, account.platform)
    results = Array.isArray(payload?.songs) ? payload.songs : []
  } catch {
    return null
  }
  const target = track.key || canonicalTrackKey(track)
  const matched = results.find(song => {
    const candidateKey = canonicalTrackKey({ title: song.name, artists: (song.artists || []).map(artist => artist.name) })
    if (candidateKey !== target) return false
    return trackDurationCompatible(song.duration, track.durationMs)
  })
  if (!matched) return null
  const requiredTier = getSongRequiredTier(matched)
  if (requiredTier !== 'unknown' && !entitlementSatisfies(account.tier, requiredTier) && account.tier !== 'unknown') {
    return { playable: false, reason: 'locked', tier: requiredTier, platform: account.platform }
  }
  if (URL_VERIFIED_PLATFORMS.includes(account.platform)) {
    const url = await getSongUrl(account.platform === 'qq' ? (matched.mid || matched.id) : matched.id, account.platform)
    if (!url || url === 'SONG_UNAVAILABLE') {
      return { playable: false, reason: 'unavailable', tier: requiredTier, platform: account.platform }
    }
  }
  return {
    playable: true,
    song: matched,
    platform: account.platform,
    tier: requiredTier,
    substituted: true,
    durationDeltaMs: matched.duration && track.durationMs ? matched.duration - track.durationMs : 0,
  }
}

/** 人类可读的原因文案（UI 提示用，避免各处自己拼） */
export function unplayableText(result: ResonanceLocalTrack, platformLabel?: (platform: MusicPlatform) => string): string {
  switch (result.reason) {
    case 'no-platform':
      return '你还没有登录任何音乐平台，已静音跟随'
    case 'locked':
      return result.tier === 'svip' ? '这首需要 SVIP，你当前没有该权益' : '这首需要 VIP，你当前没有该权益'
    case 'missing':
      return '你已登录的平台里没有这首歌'
    case 'unavailable':
      return result.platform
        ? `${platformLabel ? platformLabel(result.platform) : result.platform} 上这首暂时无法播放（可能已下架）`
        : '这首暂时无法播放'
    default:
      return '这首暂时无法播放'
  }
}
