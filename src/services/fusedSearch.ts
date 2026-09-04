import type { Album, Artist, Song } from './musicApi'
import type { MusicPlatform } from './platforms'

export type { MusicPlatform } from './platforms'
export type FusedSearchIntent = 'artist' | 'album' | 'song' | 'mixed'

export interface PlatformEntitlement {
  loggedIn: boolean
  vip: boolean
}

/** 平台权益表：已知平台必填；额外平台键（spotify/kugou/soda 等占位）允许存在，待接入后加入 MusicPlatform */
export type FusionEntitlements = Record<MusicPlatform, PlatformEntitlement> & { [key: string]: PlatformEntitlement | undefined }

export interface FusedSearchInput {
  keyword: string
  songs: Song[]
  artists: Artist[]
  albums: Album[]
  entitlements: FusionEntitlements
}

export interface FusedSearchOutput {
  songs: Song[]
  artists: Artist[]
  albums: Album[]
  intent: FusedSearchIntent
  intentConfidence: number
}

const platformOf = (item: { platform?: MusicPlatform }): MusicPlatform => (
  item.platform === 'qq' || item.platform === 'apple' || item.platform === 'spotify' || item.platform === 'kugou' || item.platform === 'soda'
    ? (item.platform as MusicPlatform)
    : 'netease'
)

/** NFKC lets full-width/half-width text match; punctuation and spacing should not affect equality. */
export const normalizeSearchText = (value = '') => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[\p{P}\p{S}\s]+/gu, '')

const diceCoefficient = (left: string, right: string) => {
  if (!left || !right) return 0
  if (left === right) return 1
  if (left.length === 1 || right.length === 1) return left.includes(right) || right.includes(left) ? 0.7 : 0

  const counts = new Map<string, number>()
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2)
    counts.set(pair, (counts.get(pair) || 0) + 1)
  }
  let overlap = 0
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2)
    const count = counts.get(pair) || 0
    if (count > 0) {
      overlap += 1
      counts.set(pair, count - 1)
    }
  }
  return (2 * overlap) / (left.length + right.length - 2)
}

export const textMatchScore = (keyword: string, candidate: string) => {
  const query = normalizeSearchText(keyword)
  const value = normalizeSearchText(candidate)
  if (!query || !value) return 0
  if (query === value) return 1
  if (value.startsWith(query)) return 0.94
  if (value.includes(query)) return 0.86
  if (query.includes(value)) return 0.78
  return diceCoefficient(query, value) * 0.72
}

const bestMatch = (keyword: string, values: Array<string | undefined>) => Math.max(
  0,
  ...values.map(value => textMatchScore(keyword, value || '')),
)

const sourcePreference = (
  item: { platform?: MusicPlatform; vip?: boolean; noCopyright?: boolean },
  entitlements: FusionEntitlements,
) => {
  const platform = platformOf(item)
  const account = entitlements[platform] || { loggedIn: false, vip: false }
  if (item.noCopyright) return -100

  // A subscribed platform is deliberately preferred, while a free playable version
  // still beats a locked VIP version on a platform without membership.
  const playability = item.vip ? (account.vip ? 35 : -20) : 25
  return playability + (account.vip ? 12 : 0) + (account.loggedIn ? 5 : 0)
}

const uniquePlatforms = (platforms: MusicPlatform[]) => Array.from(new Set(platforms))

const artistIdentity = (artist: Artist) => normalizeSearchText(artist.name)
const albumIdentity = (album: Album) => `${normalizeSearchText(album.name)}|${normalizeSearchText(album.artist?.name || '')}`
const songIdentity = (song: Song) => {
  const artistNames = (song.artists || []).map(artist => normalizeSearchText(artist.name)).filter(Boolean).sort()
  return `${normalizeSearchText(song.name)}|${artistNames.join('&')}`
}

const inferSearchIntent = (keyword: string, songs: Song[], artists: Artist[], albums: Album[]) => {
  const artistConfidence = Math.max(0, ...artists.map(artist => bestMatch(keyword, [artist.name, ...(artist.alias || [])])))
  const albumConfidence = Math.max(0, ...albums.map(album => textMatchScore(keyword, album.name)))
  const songConfidence = Math.max(0, ...songs.map(song => textMatchScore(keyword, song.name)))
  const exactArtistPlatforms = new Set(artists
    .filter(artist => bestMatch(keyword, [artist.name, ...(artist.alias || [])]) >= 0.995)
    .map(platformOf))
  const exactAlbumPlatforms = new Set(albums
    .filter(album => textMatchScore(keyword, album.name) >= 0.995)
    .map(platformOf))
  const exactSongPlatforms = new Set(songs
    .filter(song => textMatchScore(keyword, song.name) >= 0.995)
    .map(platformOf))

  // 两个平台都精确命中同名艺人时，这是最可靠的“在搜艺人”信号，
  // 可避免同名歌曲/专辑偶然命中后把结果误判为综合搜索。
  if (exactArtistPlatforms.size >= 2) return { intent: 'artist' as FusedSearchIntent, confidence: 1 }
  if (exactAlbumPlatforms.size >= 2 && exactSongPlatforms.size < 2) return { intent: 'album' as FusedSearchIntent, confidence: 1 }
  if (exactSongPlatforms.size >= 2 && exactAlbumPlatforms.size < 2) return { intent: 'song' as FusedSearchIntent, confidence: 1 }
  const ranked = [
    { intent: 'artist' as const, score: artistConfidence },
    { intent: 'album' as const, score: albumConfidence },
    { intent: 'song' as const, score: songConfidence },
  ].sort((left, right) => right.score - left.score)

  if (ranked[0].score >= 0.82 && ranked[0].score - ranked[1].score >= 0.05) {
    return { intent: ranked[0].intent as FusedSearchIntent, confidence: ranked[0].score }
  }
  return { intent: 'mixed' as FusedSearchIntent, confidence: ranked[0].score }
}

const rankAndMergeArtists = (
  keyword: string,
  artists: Artist[],
  entitlements: FusionEntitlements,
  intent: FusedSearchIntent,
) => {
  const groups = new Map<string, Array<{ item: Artist; sourceIndex: number }>>()
  artists.forEach((artist, sourceIndex) => {
    // 艺人必须按平台保留独立入口；同名艺人的 QQ/网易云 ID 不可互相替代。
    const key = `${platformOf(artist)}|${artistIdentity(artist)}`
    if (!key) return
    const group = groups.get(key) || []
    group.push({ item: artist, sourceIndex })
    groups.set(key, group)
  })

  return Array.from(groups.values()).map(group => {
    const ranked = [...group].sort((left, right) => (
      sourcePreference(right.item, entitlements) - sourcePreference(left.item, entitlements)
      || left.sourceIndex - right.sourceIndex
    ))
    const preferred = ranked[0].item
    const score = bestMatch(keyword, [preferred.name, ...(preferred.alias || [])])
    const account = entitlements[platformOf(preferred)] || { loggedIn: false, vip: false }
    return {
      item: {
        ...preferred,
        sourcePlatforms: uniquePlatforms(ranked.map(entry => platformOf(entry.item))),
      },
      score,
      rankScore: score + (account.vip ? 0.035 : account.loggedIn ? 0.01 : 0),
      sourceIndex: Math.min(...group.map(entry => entry.sourceIndex)),
    }
  }).filter(entry => entry.score >= 0.62)
    .sort((left, right) => right.rankScore - left.rankScore || left.sourceIndex - right.sourceIndex)
    .filter((entry, _index, entries) => {
      const exactMatches = entries.filter(candidate => candidate.score >= 0.995)
      if (exactMatches.length > 0) return entry.score >= 0.995
      const topScore = entries[0]?.score || 0
      const minimumScore = intent === 'artist' ? 0.62 : 0.82
      return entry.score >= Math.max(minimumScore, topScore - 0.08)
    })
    .slice(0, 6)
    .map(entry => entry.item)
}

const rankAndMergeAlbums = (
  keyword: string,
  albums: Album[],
  entitlements: FusionEntitlements,
  intent: FusedSearchIntent,
) => {
  const groups = new Map<string, Array<{ item: Album; sourceIndex: number }>>()
  albums.forEach((album, sourceIndex) => {
    const key = albumIdentity(album)
    if (!key) return
    const group = groups.get(key) || []
    group.push({ item: album, sourceIndex })
    groups.set(key, group)
  })

  return Array.from(groups.values()).map(group => {
    const ranked = [...group].sort((left, right) => (
      sourcePreference(right.item, entitlements) - sourcePreference(left.item, entitlements)
      || left.sourceIndex - right.sourceIndex
    ))
    const preferred = ranked[0].item
    const titleScore = textMatchScore(keyword, preferred.name)
    const artistScore = textMatchScore(keyword, preferred.artist?.name || '')
    const score = Math.max(titleScore, artistScore * 0.9)
    const account = entitlements[platformOf(preferred)] || { loggedIn: false, vip: false }
    return {
      item: {
        ...preferred,
        sourcePlatforms: uniquePlatforms(ranked.map(entry => platformOf(entry.item))),
      },
      score,
      titleScore,
      artistScore,
      rankScore: score * 1000 + (account.vip ? 160 : account.loggedIn ? 30 : 0),
      sourceIndex: Math.min(...group.map(entry => entry.sourceIndex)),
    }
  }).filter(entry => entry.score >= 0.55)
    .sort((left, right) => right.rankScore - left.rankScore || left.sourceIndex - right.sourceIndex)
    .filter((entry, _index, entries) => {
      if (intent === 'artist') return entry.artistScore >= 0.92
      if (intent === 'song') return entry.titleScore >= 0.88
      const exactTitles = entries.filter(candidate => candidate.titleScore >= 0.995)
      if (exactTitles.length > 0) return entry.titleScore >= 0.92
      const topScore = entries[0]?.score || 0
      return entry.score >= Math.max(intent === 'album' ? 0.65 : 0.72, topScore - 0.10)
    })
    .slice(0, intent === 'artist' ? 3 : intent === 'song' ? 2 : 6)
    .map(entry => entry.item)
}

const rankAndMergeSongs = (keyword: string, songs: Song[], entitlements: FusionEntitlements) => {
  const groups = new Map<string, Array<{ item: Song; sourceIndex: number }>>()
  songs.forEach((song, sourceIndex) => {
    let key = songIdentity(song)
    if (!key) return

    // Avoid collapsing two genuinely different recordings that happen to share a title.
    const existing = groups.get(key)
    const durationDiffers = existing?.some(({ item }) => (
      item.duration > 0 && song.duration > 0 && Math.abs(item.duration - song.duration) > 15_000
    ))
    if (durationDiffers) key = `${key}|${Math.round(song.duration / 15_000)}`

    const group = groups.get(key) || []
    group.push({ item: song, sourceIndex })
    groups.set(key, group)
  })

  return Array.from(groups.values()).map(group => {
    const ranked = [...group].sort((left, right) => (
      sourcePreference(right.item, entitlements) - sourcePreference(left.item, entitlements)
      || left.sourceIndex - right.sourceIndex
    ))
    const preferred = ranked[0].item
    const titleScore = textMatchScore(keyword, preferred.name)
    const artistScore = bestMatch(keyword, preferred.artists?.map(artist => artist.name) || [])
    const albumScore = textMatchScore(keyword, preferred.album?.name || '')
    const relevance = Math.max(titleScore, artistScore * 0.94, albumScore * 0.8)
    const apiRank = 1 - Math.min(group[0].sourceIndex, 99) / 100
    const preference = sourcePreference(preferred, entitlements)
    const account = entitlements[platformOf(preferred)] || { loggedIn: false, vip: false }
    // VIP 平台在整份榜单中也应有明显优势，而非只在重复歌曲二选一时生效。
    const entitlementBoost = account.vip ? 180 : account.loggedIn ? 35 : 0
    const accessBoost = preferred.noCopyright ? -300 : preferred.vip ? (account.vip ? 50 : -120) : 20

    return {
      item: {
        ...preferred,
        fusedSources: ranked.map(({ item }) => ({
          platform: platformOf(item),
          id: item.id,
          mid: item.mid,
          appleId: item.appleId,
          vip: item.vip,
          noCopyright: item.noCopyright,
        })),
      },
      // Relevance remains the dominant signal; entitlement and original API order break close matches.
      score: relevance * 1000 + entitlementBoost + accessBoost + preference + apiRank * 8,
    }
  }).sort((left, right) => right.score - left.score).map(entry => entry.item)
}

export const mergeFusedSearchResults = ({
  keyword,
  songs,
  artists,
  albums,
  entitlements,
}: FusedSearchInput): FusedSearchOutput => {
  const inferred = inferSearchIntent(keyword, songs, artists, albums)
  return {
    artists: rankAndMergeArtists(keyword, artists, entitlements, inferred.intent),
    albums: rankAndMergeAlbums(keyword, albums, entitlements, inferred.intent),
    songs: rankAndMergeSongs(keyword, songs, entitlements),
    intent: inferred.intent,
    intentConfidence: inferred.confidence,
  }
}
