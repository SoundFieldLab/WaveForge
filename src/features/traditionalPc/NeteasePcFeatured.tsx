// 网易云音乐 PC 客户端「精选」页复刻（传统模式中栏）。
//
// 顶部是横排频道文字页签（选中加粗 + 强调色，不是胶囊），「更多」是独立频道页（官方「更多∨」
// 的全分类视图）；子页分工：精选 = 官方歌单大卡 + 最新音乐三列 + 排行榜；歌单广场/分类 = 分类 +
// 封面墙分页；排行榜 = 榜单卡；歌手 = 地区/性别分类 + 歌手列表。VIP 会员页按产品决策移除（2026-10-08）。
// 数据全部走已有接口；某一路没有数据时只降级该区块（空态），不挡其它区块。
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Loader2, Play, UserRound } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { fetchNeteaseSongDetail } from '../neteaseExplore/api'
import { getApiBase } from '../../services/apiConfig'
import {
  fetchNeteaseLinkPage, fetchNeteasePlaylistSquare, fetchNeteaseToplist, normalizeNeteaseSquareBlocks, normalizeNeteaseToplistBlocks,
} from '../neteaseExplore/discover'
import { neteaseResourceArtwork, type NeteaseNativeBlock, type NeteaseNativeResource } from '../neteaseExplore/model'
import {
  PcCardGrid, PcChips, PcCountBadge, PcCover, PcEmpty, PcGhostButton, PcSectionTitle, PcSongBadges,
  pcSongArtwork, pcSongKey, pcTheme, type PcCardItem, type PcTheme, type PcTone,
} from './pcKit'
import type { PcAccount, PcActions } from './types'

export interface NeteasePcPageProps {
  chrome: { tone: PcTone; skin: 'netease'; accent: string }
  account: PcAccount
  actions: PcActions
  authRevision?: number
  active?: boolean
  currentSongKey?: string
  currentSong?: Song | null
  /** 可选：入口指定初始频道（例如「私人雷达」兜底跳到排行榜） */
  initialChannel?: string
}

type ChannelKey = 'featured' | 'square' | 'categories' | 'charts' | 'artist' | 'classic' | 'western' | 'cantonese' | 'drive' | 'global'

interface ChannelDef { key: ChannelKey; label: string; category?: string }

// 官方频道顺序；曲风类频道没有独立数据源，直接复用歌单广场的分类查询。
// 「更多」是独立频道（客户端「更多∨」展开的全分类视图），不再是页内下拉。
const CHANNELS: ChannelDef[] = [
  { key: 'featured', label: '精选' },
  { key: 'square', label: '歌单广场' },
  { key: 'charts', label: '排行榜' },
  { key: 'artist', label: '歌手' },
  { key: 'categories', label: '更多' },
  { key: 'classic', label: '经典', category: '经典' },
  { key: 'western', label: '欧美', category: '欧美' },
  { key: 'cantonese', label: '粤语', category: '粤语' },
  { key: 'drive', label: '驾车', category: '驾车' },
  { key: 'global', label: '全球', category: '全球' },
]

const FALLBACK_CATEGORIES = ['全部', '华语', '欧美', '电子', '流行', '摇滚', '民谣', '古典', '说唱', '古风', '轻音乐', '爵士']

const ARTIST_AREAS = [{ label: '全部', id: -1 }, { label: '华语', id: 7 }, { label: '欧美', id: 96 }, { label: '日本', id: 8 }, { label: '韩国', id: 16 }, { label: '其他', id: 0 }]
const ARTIST_TYPES = [{ label: '全部', id: -1 }, { label: '男', id: 1 }, { label: '女', id: 2 }, { label: '乐队/组合', id: 3 }]

/** 站点公开数据（精品歌单/新歌/歌手/catlist）无需 cookie，直接走本地网关。 */
async function fetchPublicJson(path: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(`${getApiBase()}${path}`, { signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`)
  return data
}

/** 歌单卡片去重（歌单广场翻页与分类切换都会重复下发同一批高热歌单）。 */
function dedupePlaylists<T extends { id: string | number }>(list: T[]): T[] {
  const seen = new Set<string>()
  return list.filter(item => {
    const key = String(item.id)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 新歌接口 result[] → 本地 Song（PC 端字段与 App 侧不同，这里单独归一化）。 */
function normalizeNewsongSongs(payload: any): Song[] {
  const list = Array.isArray(payload?.result) ? payload.result : []
  const songs = list.map((entry: any) => {
    const track = entry?.song || entry || {}
    const album = track?.al || track?.album || {}
    const artists = track?.ar || track?.artists || entry?.artists || []
    return {
      id: Number(track?.id || entry?.id || 0),
      name: String(track?.name || entry?.name || ''),
      artists: (Array.isArray(artists) ? artists : []).map((artist: any) => ({ id: Number(artist?.id) || undefined, name: String(artist?.name || '未知歌手') })),
      album: {
        id: Number(album?.id) || undefined,
        name: String(album?.name || ''),
        picUrl: String(album?.picUrl || album?.blurPicUrl || entry?.picUrl || '').replace(/^http:/, 'https:'),
      },
      duration: Number(track?.dt || track?.duration || 0),
      platform: 'netease' as const,
      fee: Number(track?.fee || 0),
      vip: Number(track?.fee) === 1,
      requiredTier: Number(track?.fee) === 1 ? 'vip' as const : 'free' as const,
    }
  }).filter((song: Song) => song.id && song.name)
  return dedupePlaylists(songs)
}

/** 歌单资源 → 传统模式歌单页形状（TraditionalView 按 id + platform 拉曲目）。 */
function playlistOf(resource: NeteaseNativeResource, source: string) {
  const playlist = resource.playlist
  if (!playlist?.id) return null
  return {
    ...playlist,
    name: playlist.name || resource.title || '歌单',
    coverUrl: playlist.coverUrl || neteaseResourceArtwork(resource),
    playCount: playlist.playCount ?? resource.playCount,
    platform: 'netease' as const,
    source,
  }
}

/** 榜单资源 → onOpenChart 载荷（不带预览曲目，由 TraditionalView 自己拉全量）。 */
function chartOf(resource: NeteaseNativeResource) {
  return {
    id: resource.id,
    name: resource.title || '排行榜',
    group: '',
    coverUrl: neteaseResourceArtwork(resource),
    platform: 'netease' as const,
    songs: [] as Array<{ id?: number; name: string; artist: string }>,
  }
}

/* ------------------------------------------------------------------ *
 * 精选子页
 * ------------------------------------------------------------------ */

/**
 * 官方精选（发现-音乐）首屏 banner 轮播：Link Platform `PAGE_DISCOVERY_BANNER` 块
 * nativeData.banners[]（bannerId/pic/imgUrls/targetType/targetId/url/typeTitle）。
 * 全部是站内 orpheus 协议（song/playlist/album）或新碟/新歌推广位，无外链广告；
 * targetType: 1006=按 url orpheus 协议解析（song/playlist/album）。
 */
function DiscoveryBannerCarousel({ theme, accent, actions, active }: {
  theme: PcTheme
  accent: string
  actions: PcActions
  active: boolean
}) {
  const [banners, setBanners] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [index, setIndex] = useState(0)
  const [hover, setHover] = useState(false)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    fetchNeteaseLinkPage('HOME_DISCOVERY_PAGE', '0', false, controller.signal)
      .then(payload => {
        if (controller.signal.aborted) return
        const block = (Array.isArray(payload?.data?.blocks) ? payload.data.blocks : [])
          .find((block: any) => String(block?.positionCode || '') === 'PAGE_DISCOVERY_BANNER')
        const list = Array.isArray(block?.nativeData?.banners) ? block.nativeData.banners : []
        setBanners(list.filter((banner: any) => banner?.pic || banner?.imgUrls?.[0]))
      })
      .catch(() => { if (!controller.signal.aborted) setBanners([]) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active])

  // 自动轮播：6s 一张，悬停暂停（官方 PC 行为）
  useEffect(() => {
    if (!active || hover || banners.length <= 1) return
    const timer = window.setInterval(() => setIndex(value => (value + 1) % banners.length), 6000)
    return () => window.clearInterval(timer)
  }, [active, hover, banners.length])

  // orpheus 协议 → 站内动作（song 播放 / playlist 歌单页 / album 专辑页）
  const openBanner = useCallback((banner: any) => {
    const url = String(banner?.url || '')
    const songMatch = url.match(/^orpheus:\/\/(?:nm\/)?song\/(\d+)/i)
    if (songMatch) {
      void fetchNeteaseSongDetail([songMatch[1]])
        .then(([song]) => { if (song) actions.onPlaySongs(song, [song], 0) })
        .catch(() => undefined)
      return
    }
    const playlistMatch = url.match(/^orpheus:\/\/(?:nm\/)?playlist\/(\d+)/i)
    if (playlistMatch) {
      actions.onOpenPlaylist({
        id: playlistMatch[1],
        name: String(banner?.typeTitle || '歌单'),
        coverUrl: String(banner?.pic || ''),
        platform: 'netease',
        source: 'netease-discovery-banner',
      })
      return
    }
    const albumMatch = url.match(/^orpheus:\/\/(?:nm\/)?album\/(\d+)/i)
    if (albumMatch) { actions.onOpenAlbum?.(albumMatch[1], 'netease'); return }
  }, [actions])

  if (loading) {
    return <span className={`mb-8 block aspect-[13/5] w-full animate-pulse rounded-lg ${theme.surface}`} />
  }
  if (banners.length === 0) return null

  const current = banners[Math.min(index, banners.length - 1)]
  const cover = String(current?.pic || current?.imgUrls?.[0] || '').replace(/^http:/, 'https:')
  const label = String(current?.typeTitle || '')

  return (
    <section
      className="mb-8"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* 官方同款大图轮播（约 2.6:1）：整图可点击打开；底部渐变角标 + 圆点指示器 + 悬停切换箭头 */}
      <div className="relative overflow-hidden rounded-lg">
        <button
          type="button"
          aria-label={label ? `打开 ${label}` : '打开精选内容'}
          onClick={() => openBanner(current)}
          className="group block w-full cursor-pointer text-left"
        >
          <PcCover
            src={cover}
            alt={label || '精选推荐'}
            eager
            className="aspect-[13/5] w-full"
            rounded="rounded-lg"
            overlay={label ? (
              <span className="absolute inset-x-0 bottom-0 flex items-end justify-between bg-gradient-to-t from-black/70 to-transparent px-4 pb-3 pt-10">
                <span className="truncate text-[13px] font-medium text-white/95">{label}</span>
              </span>
            ) : undefined}
          />
        </button>
        {/* 圆点指示器（客户端同款右下角） */}
        {banners.length > 1 && (
          <div className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5">
            {banners.map((banner, dot) => (
              <button
                key={`banner-dot:${banner?.bannerId || dot}`}
                type="button"
                aria-label={`第 ${dot + 1} 张`}
                onClick={() => setIndex(dot)}
                className="h-1.5 rounded-full transition-all"
                style={{ width: dot === index ? 16 : 6, background: dot === index ? accent : 'rgba(255,255,255,.55)' }}
              />
            ))}
          </div>
        )}
        {/* 左右切换箭头（悬停出现） */}
        {banners.length > 1 && hover && (
          <>
            <button
              type="button"
              aria-label="上一张"
              onClick={() => setIndex(value => (value - 1 + banners.length) % banners.length)}
              className="absolute left-3 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="下一张"
              onClick={() => setIndex(value => (value + 1) % banners.length)}
              className="absolute right-3 top-1/2 z-10 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}
      </div>
    </section>
  )
}

function FeaturedPanel({ theme, accent, actions, active, onOpenChannel }: {
  theme: PcTheme
  accent: string
  actions: PcActions
  active: boolean
  onOpenChannel: (key: ChannelKey) => void
}) {
  const [official, setOfficial] = useState<any[]>([])
  const [officialLoading, setOfficialLoading] = useState(true)
  const [songs, setSongs] = useState<Song[]>([])
  const [songsLoading, setSongsLoading] = useState(true)
  const [charts, setCharts] = useState<NeteaseNativeResource[]>([])
  const [chartsLoading, setChartsLoading] = useState(true)

  // 官方歌单：精品歌单（公开）优先，空则退热门歌单
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setOfficialLoading(true)
    void (async () => {
      let list: any[] = []
      try {
        const data = await fetchPublicJson('/netease/playlist/highquality?limit=12', controller.signal)
        list = Array.isArray(data?.playlists) ? data.playlists : []
      } catch { /* 退热门歌单 */ }
      if (controller.signal.aborted) return
      if (list.length === 0) {
        try {
          const data = await fetchPublicJson('/netease/playlist/hot?limit=12', controller.signal)
          list = Array.isArray(data?.playlists) ? data.playlists : []
        } catch { /* 空态 */ }
      }
      if (controller.signal.aborted) return
      setOfficial(list.slice(0, 6))
      setOfficialLoading(false)
    })()
    return () => controller.abort()
  }, [active])

  // 最新音乐
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setSongsLoading(true)
    fetchPublicJson('/netease/personalized/newsong?limit=30', controller.signal)
      .then(data => { if (!controller.signal.aborted) setSongs(normalizeNewsongSongs(data)) })
      .catch(() => { if (!controller.signal.aborted) setSongs([]) })
      .finally(() => { if (!controller.signal.aborted) setSongsLoading(false) })
    return () => controller.abort()
  }, [active])

  // 排行榜（原生 toplist，取前 6 个）
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setChartsLoading(true)
    fetchNeteaseToplist(controller.signal)
      .then(list => {
        if (controller.signal.aborted) return
        const blocks = normalizeNeteaseToplistBlocks(Array.isArray(list) ? list : [])
        setCharts(blocks.flatMap(block => block.resources).slice(0, 6))
      })
      .catch(() => { if (!controller.signal.aborted) setCharts([]) })
      .finally(() => { if (!controller.signal.aborted) setChartsLoading(false) })
    return () => controller.abort()
  }, [active])

  return (
    <div className="space-y-8">
      {/* 官方精选首屏 banner 轮播（发现-音乐同位） */}
      <DiscoveryBannerCarousel theme={theme} accent={accent} actions={actions} active={active} />

      {/* 官方歌单：一行 6 张大卡（封面中央大字标题 + 底部深色说明条） */}
      <section>
        <PcSectionTitle title="官方歌单" more="更多" onMore={() => onOpenChannel('square')} theme={theme} />
        {officialLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => <span key={`official-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
          </div>
        ) : official.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {official.map((raw, index) => {
              const name = String(raw?.name || '歌单')
              const subtitle = String(raw?.copywriter || raw?.description || raw?.creator?.nickname || '').trim()
              const playlist = {
                id: String(raw?.id || ''),
                name,
                coverUrl: String(raw?.coverImgUrl || raw?.coverUrl || '').replace(/^http:/, 'https:'),
                description: String(raw?.description || raw?.copywriter || '') || undefined,
                playCount: Number(raw?.playCount || 0) || undefined,
                trackCount: Number(raw?.trackCount || 0) || undefined,
                creator: raw?.creator?.nickname ? String(raw.creator.nickname) : undefined,
                platform: 'netease' as const,
                source: 'netease-highquality',
              }
              if (!playlist.id) return null
              return (
                <button
                  key={`official:${playlist.id}`}
                  type="button"
                  onClick={() => actions.onOpenPlaylist(playlist)}
                  onContextMenu={event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist }) }}
                  className="group block text-left"
                >
                  <PcCover
                    src={playlist.coverUrl}
                    alt={name}
                    eager={index < 3}
                    className="aspect-square w-full"
                    rounded="rounded-lg"
                    overlay={(
                      <>
                        <PcCountBadge value={playlist.playCount} />
                        {/* 中央大字标题 + 底部说明条都压在封面内（官方同款）：
                            说明条放封面外时，长文案会把该行卡片撑高、整行高度不齐 */}
                        <span className="absolute inset-x-0 bottom-0 flex flex-col justify-end bg-gradient-to-t from-black/75 via-black/45 to-transparent px-2 pb-2 pt-6">
                          <span className="line-clamp-2 text-[11px] leading-snug text-white/90">
                            {subtitle ? `${name} | ${subtitle}` : name}
                          </span>
                        </span>
                        <span className="absolute inset-0 flex items-center justify-center px-3 pb-14">
                          <span className="line-clamp-2 text-center text-[19px] font-semibold leading-tight text-white drop-shadow-[0_1px_6px_rgba(0,0,0,.65)]">{name}</span>
                        </span>
                      </>
                    )}
                  />
                </button>
              )
            })}
          </div>
        ) : (
          <PcEmpty theme={theme} title="暂无官方歌单" />
        )}
      </section>

      {/* 最新音乐：3 列歌曲行（双击播放 / 右键菜单） */}
      <section>
        <PcSectionTitle title="最新音乐" theme={theme} />
        {songsLoading ? (
          <div className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 9 }).map((_, index) => <span key={`newsong-skeleton:${index}`} className={`block h-14 animate-pulse rounded-md ${theme.surface}`} />)}
          </div>
        ) : songs.length > 0 ? (
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-3">
            {songs.slice(0, 21).map((song, index) => (
              <div
                key={`new:${pcSongKey(song)}:${index}`}
                onDoubleClick={() => actions.onPlaySongs(song, songs, index)}
                onContextMenu={event => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song }) }}
                className={`group flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 transition ${theme.hover}`}
              >
                <span className="relative shrink-0">
                  <PcCover src={pcSongArtwork(song)} alt={song.name} className="h-10 w-10" rounded="rounded-md" />
                  <button
                    type="button"
                    onClick={() => actions.onPlaySongs(song, songs, index)}
                    aria-label={`播放 ${song.name}`}
                    className="absolute inset-0 flex items-center justify-center rounded-md bg-black/45 opacity-0 transition group-hover:opacity-100"
                  >
                    <Play className="h-3.5 w-3.5 fill-current text-white" />
                  </button>
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`flex items-center gap-1.5 text-[13px] ${theme.text}`}>
                    <span className="truncate">{song.name}</span>
                    <PcSongBadges song={song} skin="netease" />
                  </span>
                  <span className={`mt-[2px] block truncate text-[12px] ${theme.subtle}`}>
                    {(song.artists || []).map(artist => artist.name).filter(Boolean).join(' / ')}
                  </span>
                </span>
                <span className={`hidden w-[30%] shrink-0 truncate text-right text-[12px] lg:block ${theme.faint}`}>{song.album?.name || ''}</span>
              </div>
            ))}
          </div>
        ) : (
          <PcEmpty theme={theme} title="暂无最新音乐" />
        )}
      </section>

      {/* 排行榜：前 6 张榜单卡 */}
      <section>
        <PcSectionTitle title="排行榜" more="更多" onMore={() => onOpenChannel('charts')} theme={theme} />
        {chartsLoading ? (
          <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => <span key={`chart-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
          </div>
        ) : charts.length > 0 ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 lg:grid-cols-6">
            {charts.map(resource => (
              <button key={`chart:${resource.id}`} type="button" onClick={() => actions.onOpenChart?.(chartOf(resource), false)} className="group block text-left">
                <PcCover
                  src={neteaseResourceArtwork(resource)}
                  alt={resource.title}
                  className="aspect-square w-full"
                  rounded="rounded-lg"
                  overlay={(
                    <>
                      <PcCountBadge value={resource.playCount} />
                      <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                        <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                      </span>
                    </>
                  )}
                />
                <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{resource.title}</span>
                <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{resource.subtitle || '网易云音乐榜'}</span>
              </button>
            ))}
          </div>
        ) : (
          <PcEmpty theme={theme} title="暂无排行榜" />
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 歌单广场（歌单广场 + 曲风频道共用）
 * ------------------------------------------------------------------ */

function SquarePanel({ theme, accent, actions, active, category, categories, onCategory, showChips = true, title }: {
  theme: PcTheme
  accent: string
  actions: PcActions
  active: boolean
  category: string
  categories: string[]
  onCategory: (next: string) => void
  showChips?: boolean
  title?: string
}) {
  const PAGE_SIZE = 30
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  // 官方的「全部」= 广场默认推荐流
  const queryCategory = category === '全部' ? '推荐' : category

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    setItems([])
    setOffset(0)
    fetchNeteasePlaylistSquare(queryCategory, 0, PAGE_SIZE, controller.signal)
      .then(payload => {
        if (controller.signal.aborted) return
        const blocks = normalizeNeteaseSquareBlocks(payload)
        const list = blocks.flatMap(block => block.resources)
          .map(resource => playlistOf(resource, 'netease-playlist-square'))
          .filter((item): item is NonNullable<typeof item> => Boolean(item))
        setItems(dedupePlaylists(list))
        setOffset(PAGE_SIZE)
        setHasMore(payload?.data?.hasMore !== false && list.length > 0)
      })
      .catch(() => { if (!controller.signal.aborted) { setItems([]); setHasMore(false) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active, queryCategory])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const payload = await fetchNeteasePlaylistSquare(queryCategory, offset, PAGE_SIZE)
      const list = normalizeNeteaseSquareBlocks(payload).flatMap(block => block.resources)
        .map(resource => playlistOf(resource, 'netease-playlist-square'))
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
      setItems(previous => dedupePlaylists([...previous, ...list]))
      setOffset(value => value + PAGE_SIZE)
      setHasMore(payload?.data?.hasMore !== false && list.length > 0)
    } catch { /* 加载更多失败：保留已有内容 */ } finally { setLoadingMore(false) }
  }, [hasMore, loadingMore, offset, queryCategory])

  const cards: PcCardItem[] = useMemo(() => items.map(item => ({
    key: `square:${item.id}`,
    coverUrl: item.coverUrl,
    title: item.name,
    subtitle: item.trackCount ? `${item.trackCount} 首` : (item.creator || ''),
    playCount: item.playCount,
    onClick: () => actions.onOpenPlaylist(item),
    onContextMenu: event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: item }) },
  })), [actions, items])

  return (
    <div className="space-y-4">
      {title && <PcSectionTitle title={title} theme={theme} />}
      {showChips && (
        <PcChips
          items={categories.map(name => ({ key: name, label: name }))}
          value={category}
          onChange={onCategory}
          accent={accent}
          theme={theme}
        />
      )}
      {loading ? (
        <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, index) => <span key={`square-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
        </div>
      ) : cards.length > 0 ? (
        <>
          <PcCardGrid items={cards} theme={theme} accent={accent} columns={6} />
          <div className="flex justify-center pt-2">
            {hasMore
              ? (
                <PcGhostButton
                  theme={theme}
                  label={loadingMore ? '正在加载…' : '加载更多'}
                  icon={loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  onClick={() => { void loadMore() }}
                  disabled={loadingMore}
                />
              )
              : <span className={`py-4 text-[12px] ${theme.faint}`}>没有更多了</span>}
          </div>
        </>
      ) : (
        <PcEmpty theme={theme} title="该分类暂无歌单" description="换个分类试试" />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 排行榜子页
 * ------------------------------------------------------------------ */

function ChartsPanel({ theme, accent, actions, active }: { theme: PcTheme; accent: string; actions: PcActions; active: boolean }) {
  const [blocks, setBlocks] = useState<NeteaseNativeBlock[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    fetchNeteaseToplist(controller.signal)
      .then(list => { if (!controller.signal.aborted) setBlocks(normalizeNeteaseToplistBlocks(Array.isArray(list) ? list : [])) })
      .catch(() => { if (!controller.signal.aborted) setBlocks([]) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active])

  if (loading) {
    return (
      <div className="grid grid-cols-3 gap-x-3 gap-y-5 lg:grid-cols-6">
        {Array.from({ length: 12 }).map((_, index) => <span key={`charts-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
      </div>
    )
  }

  if (blocks.length === 0) return <PcEmpty theme={theme} title="暂无排行榜" />

  return (
    <div className="space-y-8">
      {blocks.map(block => (
        <section key={block.id}>
          <PcSectionTitle title={block.title || '排行榜'} theme={theme} />
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
            {block.resources.map(resource => (
              <button key={`chart-all:${resource.id}`} type="button" onClick={() => actions.onOpenChart?.(chartOf(resource), false)} className="group block text-left">
                <PcCover
                  src={neteaseResourceArtwork(resource)}
                  alt={resource.title}
                  className="aspect-square w-full"
                  rounded="rounded-lg"
                  overlay={(
                    <>
                      <PcCountBadge value={resource.playCount} />
                      <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                        <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                      </span>
                    </>
                  )}
                />
                <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{resource.title}</span>
                <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{resource.subtitle || '网易云音乐榜'}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 歌手子页
 * ------------------------------------------------------------------ */

function ArtistPanel({ theme, accent, actions, active }: { theme: PcTheme; accent: string; actions: PcActions; active: boolean }) {
  const [area, setArea] = useState(-1)
  const [type, setType] = useState(-1)
  const [artists, setArtists] = useState<Array<{ id: number; name: string; picUrl: string; alias?: string }>>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setLoading(true)
    fetchPublicJson(`/netease/artist/list?type=${type}&area=${area}&limit=60&offset=0`, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        const list = (Array.isArray(data?.artists) ? data.artists : []).map((item: any) => ({
          id: Number(item?.id || 0),
          name: String(item?.name || ''),
          picUrl: String(item?.picUrl || '').replace(/^http:/, 'https:'),
          alias: Array.isArray(item?.alias) ? String(item.alias[0] || '') : '',
        })).filter((item: { id: number; name: string }) => item.id && item.name)
        setArtists(list)
        setHasMore(list.length >= 60)
      })
      .catch(() => { if (!controller.signal.aborted) { setArtists([]); setHasMore(false) } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [active, area, type])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const data = await fetchPublicJson(`/netease/artist/list?type=${type}&area=${area}&limit=60&offset=${artists.length}`)
      const list = (Array.isArray(data?.artists) ? data.artists : []).map((item: any) => ({
        id: Number(item?.id || 0),
        name: String(item?.name || ''),
        picUrl: String(item?.picUrl || '').replace(/^http:/, 'https:'),
        alias: Array.isArray(item?.alias) ? String(item.alias[0] || '') : '',
      })).filter((item: { id: number; name: string }) => item.id && item.name)
      setArtists(previous => {
        const seen = new Set(previous.map(item => item.id))
        return [...previous, ...list.filter((item: { id: number }) => !seen.has(item.id))]
      })
      setHasMore(list.length >= 60)
    } catch { /* 保留已有列表 */ } finally { setLoadingMore(false) }
  }, [area, artists.length, hasMore, loadingMore, type])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <PcChips
          items={ARTIST_AREAS.map(item => ({ key: String(item.id), label: item.label }))}
          value={String(area)}
          onChange={next => setArea(Number(next))}
          accent={accent}
          theme={theme}
        />
        <PcChips
          items={ARTIST_TYPES.map(item => ({ key: String(item.id), label: item.label }))}
          value={String(type)}
          onChange={next => setType(Number(next))}
          accent={accent}
          theme={theme}
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {Array.from({ length: 16 }).map((_, index) => <span key={`artist-skeleton:${index}`} className={`block aspect-square w-full animate-pulse rounded-full ${theme.surface}`} />)}
        </div>
      ) : artists.length > 0 ? (
        <>
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
            {artists.map(artist => (
              <button key={`artist:${artist.id}`} type="button" onClick={() => actions.onOpenArtist?.(String(artist.id), 'netease')} className="group block text-center">
                <PcCover
                  src={artist.picUrl}
                  alt={artist.name}
                  className="aspect-square w-full"
                  rounded="rounded-full"
                  overlay={(
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-black/25 opacity-0 transition group-hover:opacity-100">
                      <UserRound className="h-6 w-6 text-white/90" />
                    </span>
                  )}
                />
                <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{artist.name}</span>
                {artist.alias ? <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{artist.alias}</span> : null}
              </button>
            ))}
          </div>
          <div className="flex justify-center pt-2">
            {hasMore
              ? (
                <PcGhostButton
                  theme={theme}
                  label={loadingMore ? '正在加载…' : '加载更多'}
                  icon={loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  onClick={() => { void loadMore() }}
                  disabled={loadingMore}
                />
              )
              : <span className={`py-4 text-[12px] ${theme.faint}`}>没有更多了</span>}
          </div>
        </>
      ) : (
        <PcEmpty theme={theme} title="该分类暂无歌手" />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 全部分类子页（「更多」频道）：官方「更多∨」展开的分类全集，独立成页
 * ------------------------------------------------------------------ */

/** 官方分类页的大分组顺序（catlist 的 hot 分类就是这几类，按热歌单广场一级标签组织）。 */
const CATEGORY_GROUPS: Array<{ title: string; pattern: RegExp; fallback: string[] }> = [
  { title: '语种', pattern: /^(华语|欧美|日语|韩语|粤语|小语种|方言)$/, fallback: ['华语', '欧美', '日语', '韩语', '粤语', '小语种'] },
  { title: '风格', pattern: /^(流行|摇滚|民谣|电子|舞曲|说唱|金属|爵士|R&B|古典|轻音乐|世界音乐|蓝调|拉丁|雷鬼|乡村|民谣\/乡村)$/, fallback: ['流行', '摇滚', '民谣', '电子', '舞曲', '说唱', '爵士', '古典', '轻音乐', 'R&B'] },
  { title: '场景 / 心境', pattern: /(学习|工作|睡前|清晨|夜晚|驾车|运动|旅行|散步|咖啡馆|雨天|治愈|放松|伤感|怀旧|快乐|安静|思念|浪漫|助眠)/, fallback: ['学习', '工作', '睡前', '驾车', '运动', '旅行', '雨天', '治愈', '伤感', '怀旧'] },
  { title: '主题', pattern: /(影视|游戏|动漫|二次元|ACG|儿歌|胎教|校园|毕业|婚礼|军旅|戏曲|综艺|圣诞|新年)/, fallback: ['影视原声', '游戏', '动漫', '二次元', '儿歌', '校园', '婚礼', '戏曲'] },
]

function CategoriesPanel({ theme, accent, actions, active, categories, category, onCategory }: {
  theme: PcTheme
  accent: string
  actions: PcActions
  active: boolean
  categories: string[]
  category: string
  onCategory: (next: string) => void
}) {
  // 服务端拿不到分类时用固定兜底分组，保证「更多」页永远有内容
  const groups = useMemo(() => {
    if (categories.length <= 1) {
      return CATEGORY_GROUPS.map(group => ({ title: group.title, items: group.fallback.filter(item => item !== '全部') }))
    }
    const names = categories.filter(name => name !== '全部')
    const used = new Set<string>()
    const out: Array<{ title: string; items: string[] }> = []
    for (const group of CATEGORY_GROUPS) {
      const items = names.filter(name => {
        if (used.has(name) || !group.pattern.test(name)) return false
        used.add(name)
        return true
      })
      if (items.length > 0) out.push({ title: group.title, items })
    }
    const rest = names.filter(name => !used.has(name))
    if (rest.length > 0) out.push({ title: '其它', items: rest })
    return out
  }, [categories])

  return (
    <div className="space-y-5">
      <p className={`text-[12px] ${theme.subtle}`}>选择一个分类进入对应歌单墙</p>
      {groups.map(group => (
        <section key={group.title}>
          <PcSectionTitle title={group.title} theme={theme} />
          <div className="flex flex-wrap gap-2">
            {group.items.map(name => {
              const selected = name === category
              return (
                <button
                  key={`category:${name}`}
                  type="button"
                  onClick={() => { onCategory(name); actions.onNavigate({ kind: 'netease', page: 'featured', detail: 'square' }) }}
                  className={`rounded-full px-3.5 py-1.5 text-[13px] transition ${selected ? 'font-medium text-white' : theme.chipIdle}`}
                  style={selected ? { background: accent } : undefined}
                >
                  {name}
                </button>
              )
            })}
          </div>
        </section>
      ))}
      {active && null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

function NeteasePcFeatured({ chrome, account, actions, active = true, initialChannel }: NeteasePcPageProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const [channel, setChannel] = useState<ChannelKey>(() => (CHANNELS.some(item => item.key === initialChannel) ? initialChannel as ChannelKey : 'featured'))
  const [squareCategory, setSquareCategory] = useState('全部')
  const [categories, setCategories] = useState<string[]>(FALLBACK_CATEGORIES)

  // 入口指定频道（如「私人雷达」兜底跳排行榜）
  useEffect(() => {
    if (initialChannel && CHANNELS.some(item => item.key === initialChannel)) setChannel(initialChannel as ChannelKey)
  }, [initialChannel])

  // 分类全集（公开接口）：全部分类页与歌单广场分类条共用，拿不到就用固定分类
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    fetchPublicJson('/netease/playlist/catlist', controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        const sub: string[] = Array.isArray(data?.sub) ? data.sub.map((item: any) => String(item?.name || '')).filter((name: string) => Boolean(name)) : []
        if (sub.length > 0) setCategories(['全部', ...Array.from(new Set<string>(sub))])
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [active])

  // 切到曲风频道时同步歌单广场分类，保证点了频道不空白
  useEffect(() => {
    const target = CHANNELS.find(item => item.key === channel)
    if (target?.category) setSquareCategory(target.category)
  }, [channel])

  const activeDef = CHANNELS.find(item => item.key === channel)

  return (
    <div className="pb-6">
      {/* 频道页签：横排文字 + 选中加粗（官方 PC「精选」页顶部）。「更多」是独立频道页。 */}
      <div className="mb-6 flex items-center gap-6">
        <div className="flex min-w-0 flex-1 items-center gap-6 overflow-x-auto">
          {CHANNELS.map(item => {
            const selected = item.key === channel
            return (
              <button
                key={`channel:${item.key}`}
                type="button"
                onClick={() => setChannel(item.key)}
                className={`shrink-0 whitespace-nowrap pb-1 text-[15px] transition ${selected ? 'font-semibold' : theme.tabIdle}`}
                style={selected ? { color: accent } : undefined}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      </div>

      {channel === 'featured' && <FeaturedPanel theme={theme} accent={accent} actions={actions} active={active} onOpenChannel={setChannel} />}

      {channel === 'square' && (
        <SquarePanel
          theme={theme} accent={accent} actions={actions} active={active}
          category={squareCategory} categories={categories} onCategory={setSquareCategory}
        />
      )}

      {channel === 'categories' && (
        <CategoriesPanel
          theme={theme} accent={accent} actions={actions} active={active}
          categories={categories} category={squareCategory} onCategory={setSquareCategory}
        />
      )}

      {channel === 'charts' && <ChartsPanel theme={theme} accent={accent} actions={actions} active={active} />}

      {channel === 'artist' && <ArtistPanel theme={theme} accent={accent} actions={actions} active={active} />}

      {/* 经典/欧美/粤语/驾车/全球：官方是独立曲风页，这里用同名分类的歌单广场结果，保证点了有内容 */}
      {activeDef?.category && (
        <SquarePanel
          theme={theme} accent={accent} actions={actions} active={active}
          category={activeDef.category} categories={categories} onCategory={setSquareCategory}
          showChips={false} title={`${activeDef.label}歌单`}
        />
      )}
    </div>
  )
}

export default memo(NeteasePcFeatured)
