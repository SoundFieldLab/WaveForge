// 网易云音乐 PC 客户端「推荐」页复刻（传统模式中栏）。
//
// 官方推荐页自上而下：7 张快捷卡 → 推荐歌单 → 精选活动（横滚条带）→ 雷达歌单 → 心情氛围歌单 →
// 播客/节目推荐 → 个性化单曲行（「感受 xx 世界」）→ 排行榜 → 你的专属推荐歌单 → 每周新热趋势…
// 数据：Link Platform 推荐页（首屏一页 + 按 order/loaded 链后台翻两页拿全量区块）+ banner（精选活动）。
// banner 只保留可站内打开的（歌单/歌曲/专辑），跳外部浏览器的运营活动位一律不渲染。
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CalendarDays, Compass, Loader2, Mic2, Music2, Play, Radar, RefreshCw, Sparkles, Waves,
} from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { getApiBase } from '../../services/apiConfig'
import { getUserPlaylists } from '../../services/playlistService'
import {
  fetchNeteaseDailySongs, fetchNeteaseDailyStyleConfig, fetchNeteaseDailyStyleSongs,
  fetchNeteaseNativeHome, fetchNeteaseProgramSong, fetchNeteaseSimilarSongs, fetchNeteaseSongDetail,
} from '../neteaseExplore/api'
import { fetchNeteaseLinkPage } from '../neteaseExplore/discover'
import {
  neteaseBlockMoreTarget, neteaseResourceArtwork, neteaseResourceKey, neteaseShortcutKind,
  normalizeNeteaseLinkPage, normalizeNeteaseShortcuts,
  type NeteaseBlockMoreTarget, type NeteaseNativeBlock, type NeteaseNativeResource,
  type NeteaseShortcutKind,
} from '../neteaseExplore/model'
import {
  PcCountBadge, PcCover, PcEmpty, PcIconButton, PcNoticeBar, PcSectionTitle, pcTheme,
  type PcTheme, type PcTone,
} from './pcKit'
import type { PcAccount, PcActions } from './types'

/** 三个 PC 复刻页面共用的 props（TraditionalView 统一接线）。 */
export interface NeteasePcPageProps {
  chrome: { tone: PcTone; skin: 'netease'; accent: string }
  account: PcAccount
  actions: PcActions
  authRevision?: number
  /** 隐藏保活页为 false：非 active 时不发任何请求 */
  active?: boolean
  currentSongKey?: string
  /** 「相似歌曲」等需要种子的入口使用 */
  currentSong?: Song | null
}

interface QuickCard {
  key: string
  title: string
  subtitle: string
  Icon: typeof CalendarDays
}

// 官方顶部 7 张卡（标题/副标题与实机一致）；顺序与 PC 客户端一致
const QUICK_CARDS: QuickCard[] = [
  { key: 'daily', title: '每日推荐', subtitle: '今日限定好歌推荐', Icon: CalendarDays },
  { key: 'roam', title: '私人漫游', subtitle: '多样频道无限畅听', Icon: Compass },
  { key: 'radar', title: '私人雷达', subtitle: '反复聆听你爱的歌', Icon: Radar },
  { key: 'similar', title: '相似歌曲', subtitle: '从你喜欢的歌听起', Icon: Waves },
  { key: 'style', title: '华语流行日推', subtitle: '每天为你精选的华语好歌', Icon: Sparkles },
  { key: 'mood', title: '心情氛围歌单', subtitle: '跟着心情换歌单', Icon: Music2 },
  { key: 'podcast', title: '音乐播客', subtitle: '音乐背后的故事', Icon: Mic2 },
]

/** 站点公开数据（banner / 歌单热榜）无需 cookie，直接走本地网关。 */
async function fetchPublicJson(path: string, signal: AbortSignal): Promise<any> {
  const response = await fetch(`${getApiBase()}${path}`, { signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`)
  return data
}

/** 原始歌单（用户歌单 / 公开接口）→ 传统模式歌单页所需的 ExplorePlaylist 形状。 */
function playlistFromRaw(raw: any, source: string) {
  return {
    id: String(raw?.id ?? raw?.playlistId ?? ''),
    name: String(raw?.name || raw?.title || '歌单'),
    coverUrl: String(raw?.coverImgUrl || raw?.coverUrl || raw?.picUrl || '').replace(/^http:/, 'https:'),
    description: String(raw?.description || raw?.copywriter || '') || undefined,
    playCount: Number(raw?.playCount || 0) || undefined,
    trackCount: Number(raw?.trackCount || raw?.songCount || 0) || undefined,
    creator: raw?.creator?.nickname ? String(raw.creator.nickname) : undefined,
    platform: 'netease' as const,
    source,
  }
}

/**
 * 精选活动 banner 的站内/广告判定：官方 targetType 1000=歌单、1=歌曲、10=专辑、17=节目（可站内打开），
 * 3000=网页外链（运营活动，客户端在应用内开 H5，我们只能弹系统浏览器）——这类整条过滤。
 */
function isAdBanner(banner: any): boolean {
  const type = Number(banner?.targetType)
  return !(type === 1000 || type === 1 || type === 10 || type === 17)
}

/** 骨架块：各区块独立 loading，互不阻塞。 */
function PcSkeleton({ theme, className }: { theme: PcTheme; className: string }) {
  return <span className={`block animate-pulse rounded-lg ${theme.surface} ${className}`} />
}

/** Link Platform 翻页块的标题散在 dslData.<模块>.header.title（normalize 不提取），这里补一手。 */
function blockTitleOf(block: NeteaseNativeBlock): string {
  if (block.title) return block.title
  const dsl = block.raw?.dslData
  if (dsl && typeof dsl === 'object') {
    for (const node of Object.values(dsl)) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue
      const header = (node as any).header
      const title = typeof header?.title === 'string' ? header.title : String((node as any).title?.title || '')
      if (title.trim()) return title.trim()
    }
  }
  return ''
}

/** 歌单横排货架：官方一行 6 张（窄屏自动减列），角标播放量 + hover 播放键。 */
function PlaylistShelf({ theme, accent, resources, onOpenResource, onResourceMenu, skeleton }: {
  theme: PcTheme
  accent: string
  resources: NeteaseNativeResource[]
  onOpenResource: (resource: NeteaseNativeResource) => void
  onResourceMenu?: (event: React.MouseEvent, resource: NeteaseNativeResource) => void
  skeleton?: boolean
}) {
  if (skeleton) {
    return (
      <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={`shelf-skeleton:${index}`}>
            <PcSkeleton theme={theme} className="aspect-square w-full" />
            <PcSkeleton theme={theme} className="mt-2 h-3 w-4/5" />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
      {resources.map((resource, index) => {
        const playlist = resource.playlist as any
        const cover = neteaseResourceArtwork(resource) || playlist?.coverUrl || ''
        const name = resource.title || playlist?.name || '歌单'
        const tag = Array.isArray(resource.raw?.tags) && resource.raw.tags.length > 0 ? String(resource.raw.tags[0]) : resource.subtitle
        return (
          <button
            key={`shelf:${neteaseResourceKey(resource)}:${index}`}
            type="button"
            onClick={() => onOpenResource(resource)}
            onContextMenu={event => { event.preventDefault(); onResourceMenu?.(event, resource) }}
            className="group block text-left"
          >
            <PcCover
              src={cover}
              alt={name}
              eager={index < 4}
              className="aspect-square w-full"
              rounded="rounded-lg"
              overlay={(
                <>
                  <PcCountBadge value={resource.playCount ?? playlist?.playCount} />
                  {resource.coverLabel && (
                    <span className="pointer-events-none absolute left-1.5 top-9 flex flex-col items-start gap-0.5">
                      {resource.coverLabel.map(label => (
                        <span key={label} className="rounded-[3px] bg-black/35 px-1 py-[1px] text-[10px] leading-[14px] text-white/95">{label}</span>
                      ))}
                    </span>
                  )}
                  <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                    <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                  </span>
                </>
              )}
            />
            <span className={`mt-2 line-clamp-2 text-[12px] leading-snug ${theme.text}`}>{name}</span>
            {tag && tag !== name ? <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{tag}</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/** 个性化单曲行：三列歌曲卡（封面 + 标题/歌手 + 红色推荐理由），客户端「每天免费听VIP歌曲」同款。 */
function SongRows({ theme, resources, onPlayResource }: {
  theme: PcTheme
  resources: NeteaseNativeResource[]
  onPlayResource: (resource: NeteaseNativeResource) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2 xl:grid-cols-3">
      {resources.map((resource, index) => {
        const song = resource.song
        if (!song) return null
        return (
          <div
            key={`song-row:${neteaseResourceKey(resource)}:${index}`}
            onDoubleClick={() => onPlayResource(resource)}
            className={`group flex cursor-default items-center gap-3 rounded-md px-2 py-1.5 transition ${theme.hover}`}
          >
            <span className="relative shrink-0">
              <PcCover src={song.album?.picUrl || neteaseResourceArtwork(resource)} alt={song.name} className="h-10 w-10" rounded="rounded-md" />
              <button
                type="button"
                onClick={() => onPlayResource(resource)}
                aria-label={`播放 ${song.name}`}
                className="absolute inset-0 flex items-center justify-center rounded-md bg-black/45 opacity-0 transition group-hover:opacity-100"
              >
                <Play className="h-3.5 w-3.5 fill-current text-white" />
              </button>
            </span>
            <span className="min-w-0 flex-1">
              <span className={`flex items-center gap-1.5 text-[13px] ${theme.text}`}>
                <span className="truncate">{song.name}</span>
                {song.vip && <span className="shrink-0 rounded-[3px] border border-[#e0513f]/50 px-1 py-[1px] text-[10px] leading-[13px] text-[#e0513f]">VIP</span>}
                {resource.badge && resource.badge !== 'VIP' ? (
                  <span className={`shrink-0 rounded-[3px] px-1 py-[1px] text-[10px] leading-[13px] ${theme.faint}`}>{resource.badge}</span>
                ) : null}
              </span>
              <span className={`mt-[2px] flex items-center gap-2 truncate text-[12px] ${theme.subtle}`}>
                <span className="truncate">{(song.artists || []).map(artist => artist.name).filter(Boolean).join(' / ')}</span>
                {resource.reason && <span className="shrink-0 truncate text-[11px] text-[#e0513f]">{resource.reason}</span>}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** 播客/节目横排卡：封面 + 标题 + 分类/推荐语（「从你喜欢的音乐听播客」条带）。 */
function PodcastShelf({ theme, accent, resources, onOpenResource }: {
  theme: PcTheme
  accent: string
  resources: NeteaseNativeResource[]
  onOpenResource: (resource: NeteaseNativeResource) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      {resources.slice(0, 12).map((resource, index) => (
        <button
          key={`podcast:${neteaseResourceKey(resource)}:${index}`}
          type="button"
          onClick={() => onOpenResource(resource)}
          className="group block text-left"
        >
          <PcCover
            src={neteaseResourceArtwork(resource)}
            alt={resource.title || '播客'}
            eager={index < 4}
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
          <span className={`mt-2 line-clamp-2 text-[12px] leading-snug ${theme.text}`}>{resource.title || '播客'}</span>
          {resource.subtitle ? <span className={`mt-0.5 line-clamp-1 text-[11px] ${theme.faint}`}>{resource.subtitle}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** 排行榜横排卡（热歌榜/原创榜…），点击进榜单详情（歌单通道全量曲目）。 */
function ChartShelf({ theme, accent, resources, onOpenChart }: {
  theme: PcTheme
  accent: string
  resources: NeteaseNativeResource[]
  onOpenChart: (resource: NeteaseNativeResource) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
      {resources.slice(0, 6).map(resource => (
        <button key={`chart:${neteaseResourceKey(resource)}`} type="button" onClick={() => onOpenChart(resource)} className="group block text-left">
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
          {resource.subtitle ? <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{resource.subtitle}</span> : null}
        </button>
      ))}
    </div>
  )
}

function NeteasePcHome({ chrome, account, actions, authRevision = 0, active = true, currentSong }: NeteasePcPageProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent

  const [blocks, setBlocks] = useState<NeteaseNativeBlock[]>([])
  const [shortcuts, setShortcuts] = useState<NeteaseNativeResource[]>([])
  const [homeLoading, setHomeLoading] = useState(true)
  const [flowLoading, setFlowLoading] = useState(false)
  const [hotPlaylists, setHotPlaylists] = useState<any[]>([])
  const [hotLoading, setHotLoading] = useState(false)
  const [banners, setBanners] = useState<any[]>([])
  const [bannersLoading, setBannersLoading] = useState(true)
  const [busyKey, setBusyKey] = useState('')
  const [notice, setNotice] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  // 已挂载后跳过翻页（刷新/登录态变化时重置），避免切页返回时重复拉两页推荐流
  const flowLoadedRef = useRef(false)
  // 翻页链暂存（首屏 effect 写入，翻页 effect 消费）：order 与已展示位必须原样回传，服务端才推进下一屏
  const firstPageRef = useRef<{ order: string[]; loaded: string[]; cursor: string; hasMore: boolean }>({ order: [], loaded: [], cursor: '', hasMore: false })

  // 快捷卡与首屏区块同源（Link Platform 推荐页），失败再退旧协议 homepage；两路都失败也不报错。
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    flowLoadedRef.current = false
    setHomeLoading(true)
    void (async () => {
      let nextBlocks: NeteaseNativeBlock[] = []
      let nextShortcuts: NeteaseNativeResource[] = []
      try {
        const payload = await fetchNeteaseLinkPage('HOME_RECOMMEND_PAGE', '0', false, controller.signal)
        nextBlocks = normalizeNeteaseLinkPage(payload).blocks
        nextShortcuts = normalizeNeteaseShortcuts(payload)
        const data = payload?.data || {}
        firstPageRef.current = {
          order: typeof data.blockCodeOrderList === 'string'
            ? JSON.parse(data.blockCodeOrderList)
            : (Array.isArray(data.blockCodeOrderList) ? data.blockCodeOrderList : []),
          loaded: (Array.isArray(data.blocks) ? data.blocks : []).map((block: any) => String(block?.positionCode || '')),
          cursor: String(data.cursor ?? ''),
          hasMore: data.hasMore === true,
        }
      } catch { /* 静默降级：旧协议或纯公开兜底 */ }
      if (controller.signal.aborted) return
      if (nextBlocks.length === 0) {
        try {
          const home = await fetchNeteaseNativeHome(false, controller.signal)
          nextBlocks = home.blocks
          if (nextShortcuts.length === 0) nextShortcuts = normalizeNeteaseShortcuts(home.rawBlocks ? { data: { blocks: home.rawBlocks } } : {})
        } catch { /* 兜底货架在后面处理 */ }
      }
      if (controller.signal.aborted) return
      setBlocks(nextBlocks)
      setShortcuts(nextShortcuts)
      setHomeLoading(false)
    })()
    return () => controller.abort()
  }, [active, authRevision, reloadToken])

  // 官方推荐页下方还有大量区块（雷达歌单/播客推荐/排行榜/专属歌单…）在第二、三屏：
  // 首屏渲染完成后按 order/loaded 链后台翻页（最多两页），逐块补进内容流。
  useEffect(() => {
    if (!active || homeLoading) return
    if (flowLoadedRef.current) return
    if (!firstPageRef.current.hasMore || !firstPageRef.current.cursor) { flowLoadedRef.current = true; return }
    const controller = new AbortController()
    setFlowLoading(true)
    void (async () => {
      const merged: NeteaseNativeBlock[] = []
      let { order, loaded, cursor, hasMore } = firstPageRef.current
      for (let page = 0; page < 2 && !controller.signal.aborted; page += 1) {
        try {
          const payload = await fetchNeteaseLinkPage('HOME_RECOMMEND_PAGE', cursor, false, controller.signal, order, loaded)
          const next = normalizeNeteaseLinkPage(payload).blocks
          if (controller.signal.aborted) return
          merged.push(...next)
          const data = payload?.data || {}
          order = typeof data.blockCodeOrderList === 'string' ? JSON.parse(data.blockCodeOrderList) : (Array.isArray(data.blockCodeOrderList) ? data.blockCodeOrderList : order)
          const positions = (Array.isArray(data.blocks) ? data.blocks : []).map((block: any) => String(block?.positionCode || ''))
          loaded = [...loaded, ...positions]
          cursor = String(data.cursor ?? '')
          hasMore = data.hasMore === true
          if (!hasMore || !cursor) break
        } catch { /* 翻页失败：保住已有内容 */ }
      }
      if (controller.signal.aborted) return
      flowLoadedRef.current = true
      if (merged.length > 0) {
        setBlocks(previous => {
          const seen = new Set(previous.map(block => block.id))
          return [...previous, ...merged.filter(block => !seen.has(block.id))]
        })
      }
      setFlowLoading(false)
    })()
    return () => controller.abort()
  }, [active, homeLoading, reloadToken])

  // 精选活动：PC banner（type=2）是公开接口，未登录也能出图；无数据就整块不渲染。
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setBannersLoading(true)
    fetchPublicJson('/netease/banner?type=2', controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        const list = Array.isArray(data?.banners) ? data.banners : []
        // 只留站内能打开的（歌单/歌曲/专辑），跳外部浏览器的运营活动整条去掉
        setBanners(list.filter((banner: any) => !isAdBanner(banner)))
      })
      .catch(() => { if (!controller.signal.aborted) setBanners([]) })
      .finally(() => { if (!controller.signal.aborted) setBannersLoading(false) })
    return () => controller.abort()
  }, [active, reloadToken])

  const needHotFallback = !homeLoading && blocks.length === 0

  // 只在整页都缺数据时兜底，避免每次都多打一路接口
  useEffect(() => {
    if (!active || !needHotFallback) return
    const controller = new AbortController()
    setHotLoading(true)
    fetchPublicJson('/netease/playlist/hot?limit=12', controller.signal)
      .then(data => { if (!controller.signal.aborted) setHotPlaylists(Array.isArray(data?.playlists) ? data.playlists : []) })
      .catch(() => { if (!controller.signal.aborted) setHotPlaylists([]) })
      .finally(() => { if (!controller.signal.aborted) setHotLoading(false) })
    return () => controller.abort()
  }, [active, needHotFallback, reloadToken])

  const shortcutOf = useCallback((kind: NeteaseShortcutKind) => shortcuts.find(resource => neteaseShortcutKind(resource) === kind), [shortcuts])
  const dailyFallbackCover = useMemo(
    () => neteaseResourceArtwork(blocks.find(block => /DAILY_RECOMMEND/i.test(block.blockCode))?.resources[0] || ({} as NeteaseNativeResource)),
    [blocks],
  )
  const moodBlock = useMemo(
    () => blocks.find(block => /MOOD_PLAYLIST|FEELING_PLAYLIST|心情氛围/i.test(`${block.blockCode} ${block.showType} ${block.title}`)),
    [blocks],
  )

  // 每张卡各自加载：卡片自身显示转圈，失败只在顶部提示条里说明，不影响其它卡
  const runCard = useCallback(async (key: string, task: () => Promise<void>) => {
    if (busyKey) return
    setNotice('')
    setBusyKey(key)
    try { await task() } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : '暂时无法打开，请稍后再试')
    } finally { setBusyKey('') }
  }, [busyKey])

  const openDaily = () => { void runCard('daily', async () => {
    if (!account.loggedIn) { actions.onLogin?.(); setNotice('登录后可查看「每日推荐」'); return }
    const songs = await fetchNeteaseDailySongs()
    if (!songs.length) throw new Error('今日暂无每日推荐')
    actions.onPlaySongs(songs[0], songs, 0)
  }) }

  const openRadar = () => { void runCard('radar', async () => {
    // 先找账号里名字带「雷达」的歌单（官方雷达歌单就是普通歌单），没有再落到榜单页
    if (account.loggedIn && account.userId) {
      const lists = await getUserPlaylists('netease', account.userId).catch(() => [])
      const radar = (Array.isArray(lists) ? lists : []).find(item => /雷达/.test(String(item?.name || '')))
      if (radar?.id) { actions.onOpenPlaylist(playlistFromRaw(radar, 'netease-radar')); return }
    }
    actions.onNavigate({ kind: 'netease', page: 'featured', detail: 'charts' })
  }) }

  const openSimilar = () => { void runCard('similar', async () => {
    if (!currentSong?.id) { setNotice('播放一首歌后可用「相似歌曲」'); return }
    const songs = await fetchNeteaseSimilarSongs([currentSong.id])
    if (!songs.length) throw new Error('相似歌曲暂无内容')
    actions.onPlaySongs(songs[0], songs, 0)
  }) }

  const openStyleDaily = () => { void runCard('style', async () => {
    const categories = await fetchNeteaseDailyStyleConfig()
    const category = categories.find(item => /华语/.test(item.categoryName)) || categories[0]
    const tag = category?.tags[0]
    if (!category || !tag) throw new Error('风格日推暂不可用')
    const songs = await fetchNeteaseDailyStyleSongs(category.categoryId, tag.tagId)
    if (!songs.length) throw new Error('风格日推暂无歌曲')
    actions.onPlaySongs(songs[0], songs, 0)
  }) }

  const openMood = () => { void runCard('mood', async () => {
    const resource = moodBlock?.resources.find(item => Boolean(item.playlist)) || moodBlock?.resources[0]
    const playlist = resource?.playlist
    if (resource && playlist?.id) {
      actions.onOpenPlaylist({ ...playlist, coverUrl: playlist.coverUrl || neteaseResourceArtwork(resource) })
      return
    }
    actions.onNavigate({ kind: 'netease', page: 'featured' })
  }) }

  const cardArtwork = useCallback((key: string): string => {
    if (key === 'daily') return neteaseResourceArtwork(shortcutOf('daily') || ({} as NeteaseNativeResource)) || dailyFallbackCover
    if (key === 'roam') return neteaseResourceArtwork(shortcutOf('roam') || ({} as NeteaseNativeResource))
    if (key === 'radar') return neteaseResourceArtwork(shortcutOf('radar') || ({} as NeteaseNativeResource))
    if (key === 'similar') return neteaseResourceArtwork(shortcutOf('similar') || ({} as NeteaseNativeResource)) || currentSong?.album?.picUrl || ''
    if (key === 'mood') return neteaseResourceArtwork(moodBlock?.resources[0] || ({} as NeteaseNativeResource))
    if (key === 'podcast') return neteaseResourceArtwork(shortcutOf('podcast') || ({} as NeteaseNativeResource))
    return ''
  }, [currentSong?.album?.picUrl, dailyFallbackCover, moodBlock, shortcutOf])

  const cardSubtitle = useCallback((card: QuickCard): string => {
    const kind: NeteaseShortcutKind = card.key === 'daily' ? 'daily' : card.key === 'roam' ? 'roam' : card.key === 'radar' ? 'radar' : card.key === 'similar' ? 'similar' : card.key === 'podcast' ? 'podcast' : null
    const resource = kind ? shortcutOf(kind) : undefined
    const remote = (resource?.subtitle || '').trim()
    // 原生资源的 subtitle 有时就是标题本身（私人漫游/私人雷达），照抄会出现「私人漫游 | 私人漫游」，
    // 这种退化情况用本地兜底文案更有信息量
    if (remote && remote !== card.title) return remote
    return card.subtitle
  }, [shortcutOf])

  const onQuickCard = (key: string) => {
    switch (key) {
      case 'daily': openDaily(); return
      case 'roam': actions.onNavigate({ kind: 'netease', page: 'roam' }); return
      case 'radar': openRadar(); return
      case 'similar': openSimilar(); return
      case 'style': openStyleDaily(); return
      case 'mood': openMood(); return
      case 'podcast': actions.onNavigate({ kind: 'netease', page: 'podcast' }); return
      default: return
    }
  }

  /** 区块内资源统一打开：歌单→歌单页；单曲→整栏队列播放；节目→拉音频后播放；电台→电台详情（歌单通道）。 */
  const openResource = useCallback((resource: NeteaseNativeResource, block?: NeteaseNativeBlock) => {
    setNotice('')
    if (resource.song) {
      // 官方点一张单曲卡播的是整栏队列（playBtn 自带 songIds）；补齐详情后按点击位起播
      if (resource.playQueue && resource.playQueue.ids.length > 0) {
        void (async () => {
          const queue = await fetchNeteaseSongDetail(resource.playQueue!.ids).catch(() => [] as Song[])
          if (queue.length > 0) {
            const targetId = Number(resource.playQueue!.ids[resource.playQueue!.start] || 0)
            const startIndex = queue.findIndex(song => song.id === targetId)
            actions.onPlaySongs(resource.song!, queue, startIndex >= 0 ? startIndex : 0)
            return
          }
          actions.onPlaySongs(resource.song!, [resource.song!], 0)
        })()
        return
      }
      const siblings = (block?.resources || []).map(item => item.song).filter((song): song is Song => Boolean(song))
      actions.onPlaySongs(resource.song, siblings.length > 0 ? siblings : [resource.song], Math.max(0, siblings.indexOf(resource.song)))
      return
    }
    if (resource.playlist?.id) {
      actions.onOpenPlaylist({
        ...resource.playlist,
        name: resource.playlist.name || resource.title || '歌单',
        coverUrl: resource.playlist.coverUrl || neteaseResourceArtwork(resource),
        playCount: resource.playlist.playCount ?? resource.playCount,
        source: 'netease-home-block',
      })
      return
    }
    const action = resource.action
    if (action.type === 'program') {
      void fetchNeteaseProgramSong(action.id)
        .then(song => { if (song) actions.onPlaySongs(song, [song], 0); else setNotice('该节目暂无法播放') })
        .catch(() => setNotice('该节目暂无法播放'))
      return
    }
    if (action.type === 'radio') {
      actions.onOpenPlaylist({
        id: action.channel.id,
        name: resource.title || action.channel.name || '播客',
        coverUrl: neteaseResourceArtwork(resource) || action.channel.coverUrl,
        description: resource.subtitle || action.channel.description || undefined,
        playCount: resource.playCount ?? action.channel.playCount,
        platform: 'netease',
        source: 'netease-home-radio',
      })
      return
    }
    if (action.type === 'album') { actions.onOpenAlbum?.(action.id, 'netease'); return }
    if (action.type === 'artist') { actions.onOpenArtist?.(action.id, 'netease'); return }
    if (action.type === 'web') {
      if (typeof window !== 'undefined') window.open(action.url, '_blank', 'noopener,noreferrer')
      return
    }
    setNotice(`${resource.title || '该内容'}暂不支持在 WaveForge 内打开`)
  }, [actions])

  /** 榜单卡：不带预览曲目，TraditionalView 的 onOpenChart 自己拉全量。 */
  const openChart = useCallback((resource: NeteaseNativeResource) => {
    actions.onOpenChart?.({
      id: resource.playlist?.id || resource.id,
      name: resource.title || '排行榜',
      group: '',
      coverUrl: neteaseResourceArtwork(resource),
      platform: 'netease',
      songs: [],
    }, false)
  }, [actions])

  /** 区块「更多」按钮：按服务端 showMore.action 落到站内对应页；解析不了就不渲染按钮。 */
  const openBlockMore = useCallback((target: NeteaseBlockMoreTarget) => {
    if (target.kind === 'artist') { actions.onOpenArtist?.(target.artistId, 'netease'); return }
    if (target.tab === 'podcast') { actions.onNavigate({ kind: 'netease', page: 'podcast' }); return }
    if (target.channelCode === 'chart') { actions.onNavigate({ kind: 'netease', page: 'featured', detail: 'charts' }); return }
    if (target.channelCode === 'playlist') { actions.onNavigate({ kind: 'netease', page: 'featured', detail: 'square' }); return }
    actions.onNavigate({ kind: 'netease', page: 'featured' })
  }, [actions])

  /** 精选活动 banner 打开：歌单类进详情（歌曲/专辑各自通道）；广告类已被过滤不会渲染。 */
  const bannerCover = (banner: any) => String(banner?.pic || banner?.imageUrl || '').replace(/^http:/, 'https:')
  const openBanner = (banner: any) => {
    const type = Number(banner?.targetType)
    const id = String(banner?.targetId || '')
    if (id && id !== '0' && type === 1000) {
      actions.onOpenPlaylist({
        id,
        name: String(banner?.typeTitle || banner?.title || '精选活动'),
        coverUrl: bannerCover(banner),
        platform: 'netease',
        source: 'netease-banner',
      })
      return
    }
    if (type === 1 && id) {
      void fetchNeteaseSongDetail([id])
        .then(([song]) => { if (song) actions.onPlaySongs(song, [song], 0) })
        .catch(() => setNotice('该歌曲暂无法播放'))
      return
    }
    if (type === 10 && id) { actions.onOpenAlbum?.(id, 'netease'); return }
  }

  /** 内容流区块：服务端顺序即官方顺序。问候/快捷卡/每日推荐块由顶部固定区承担，不再重复渲染。 */
  const contentBlocks = useMemo(
    () => blocks.filter(block => !/GREETING|DAILY_RECOMMEND|SHORTCUT/i.test(block.blockCode) && block.resources.length > 0),
    [blocks],
  )

  /** 官方「精选活动」插在「推荐歌单」块之后（客户端同位置）。 */
  const isRecommendPlaylistBlock = useCallback(
    (block: NeteaseNativeBlock) => /SPECIAL_CLOUD_VILLAGE|推荐歌单/i.test(`${block.blockCode} ${blockTitleOf(block)}`),
    [],
  )

  const refreshButton = (
    <PcIconButton theme={theme} title="刷新推荐" onClick={() => setReloadToken(token => token + 1)}>
      <RefreshCw className="h-4 w-4" />
    </PcIconButton>
  )

  /** 按资源构成分发渲染形态：单曲行 / 榜单卡 / 播客条带 / 歌单货架。 */
  const renderBlock = (block: NeteaseNativeBlock, index: number) => {
    const resources = block.resources
    if (resources.length === 0) return null
    const title = blockTitleOf(block)
    const songResources = resources.filter(resource => resource.song)
    const chartResources = resources.filter(resource => resource.type === 'toplist')
    const podcastResources = resources.filter(resource => resource.action.type === 'program' || resource.action.type === 'radio' || resource.type === 'voicelist')
    const moreTarget = neteaseBlockMoreTarget(block)
    const heading = (title || index === 0) ? (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {title && (
            <PcSectionTitle
              title={title}
              more={moreTarget ? '更多' : undefined}
              onMore={moreTarget ? () => openBlockMore(moreTarget) : undefined}
              theme={theme}
              className="mb-3"
            />
          )}
        </div>
        {/* 官方每节标题右侧的刷新（整页重拉，与旧行为一致） */}
        {index === 0 && refreshButton}
      </div>
    ) : null

    let body: React.ReactNode = null
    if (songResources.length >= Math.max(2, resources.length * 0.6) && !/PODCAST/i.test(block.blockCode)) {
      body = <SongRows theme={theme} resources={resources} onPlayResource={resource => openResource(resource, block)} />
    } else if (chartResources.length >= Math.max(1, resources.length * 0.6)) {
      body = <ChartShelf theme={theme} accent={accent} resources={chartResources} onOpenChart={openChart} />
    } else if (podcastResources.length >= Math.max(2, resources.length * 0.6) || /PODCAST/i.test(block.blockCode)) {
      body = <PodcastShelf theme={theme} accent={accent} resources={podcastResources.length > 0 ? podcastResources : resources} onOpenResource={resource => openResource(resource, block)} />
    } else {
      body = (
        <PlaylistShelf
          theme={theme}
          accent={accent}
          resources={resources}
          onOpenResource={resource => openResource(resource, block)}
          onResourceMenu={(event, resource) => {
            const playlist = resource.playlist
            if (playlist) actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: { ...playlist, coverUrl: playlist.coverUrl || neteaseResourceArtwork(resource) } })
          }}
        />
      )
    }

    return (
      <section key={`block:${block.id}`} className="mb-8">
        {heading}
        {body}
      </section>
    )
  }

  /** 官方「精选活动」：横滚条带（客户端同款固定卡宽，超出横向滚动）。 */
  const featuredActivities = (bannersLoading || banners.length > 0) && (
    <section className="mb-8">
      <PcSectionTitle title="精选活动" theme={theme} />
      {bannersLoading ? (
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 4 }).map((_, index) => (
            <PcSkeleton key={`banner-skeleton:${index}`} theme={theme} className="aspect-[13/5] w-[286px] shrink-0" />
          ))}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {banners.map((banner, index) => {
            const cover = bannerCover(banner)
            if (!cover) return null
            const label = String(banner?.typeTitle || '')
            return (
              <button
                key={`banner:${banner?.bannerId || banner?.targetId || index}`}
                type="button"
                onClick={() => openBanner(banner)}
                className="group block w-[286px] shrink-0 overflow-hidden rounded-lg text-left transition hover:-translate-y-0.5"
              >
                <PcCover
                  src={cover}
                  alt={label || `精选活动 ${index + 1}`}
                  eager={index < 3}
                  className="aspect-[13/5] w-full"
                  rounded="rounded-lg"
                  overlay={label ? (
                    <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-[11px] text-white/90">{label}</span>
                  ) : undefined}
                />
              </button>
            )
          })}
        </div>
      )}
    </section>
  )

  return (
    <div className="pb-6">
      {notice && <PcNoticeBar theme={theme} onClose={() => setNotice('')}>{notice}</PcNoticeBar>}

      {/* 顶部 7 张快捷卡：宽屏一行铺满（官方同款），窄屏自动折行 */}
      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {QUICK_CARDS.map((card, index) => {
          const artwork = cardArtwork(card.key)
          const busy = busyKey === card.key
          const { Icon } = card
          return (
            <button
              key={card.key}
              type="button"
              disabled={busy}
              onClick={() => onQuickCard(card.key)}
              className="group relative block overflow-hidden rounded-lg text-left transition hover:-translate-y-0.5 disabled:opacity-80"
            >
              <PcCover
                src={artwork}
                alt={card.title}
                eager={index < 4}
                className="aspect-square w-full"
                rounded="rounded-lg"
                overlay={(
                  <>
                    {/* 无真实资源时用本地兜底：强调色渐变 + 功能图标，仍可点 */}
                    {!artwork && (
                      <span className="absolute inset-0 flex items-center justify-center" style={{ background: `linear-gradient(140deg, ${accent}30, ${accent}0d)` }}>
                        <Icon className="h-9 w-9" style={{ color: accent }} />
                      </span>
                    )}
                    <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-[5px] bg-black/45 text-white/90 backdrop-blur-sm">
                      <Icon className="h-3 w-3" />
                    </span>
                    <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-black/55 px-2 py-1.5 backdrop-blur-sm">
                      {/* 官方同款说明条：标题 | 副标题 */}
                      <span className="line-clamp-2 min-w-0 text-[11px] font-medium leading-tight text-white/95">
                        {card.title}
                        <span className="font-normal text-white/60"> | {cardSubtitle(card)}</span>
                      </span>
                      {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/85" />}
                    </span>
                  </>
                )}
              />
            </button>
          )
        })}
      </section>

      {/* 内容流：官方区块顺序（推荐歌单 → 精选活动 → 雷达歌单 → 心情氛围 → 播客/单曲/榜单/专属…），
          全部区块缺失时才退热门歌单兜底。 */}
      {homeLoading ? (
        <section className="mb-8">
          <div className="flex items-start justify-between gap-3">
            <PcSectionTitle title="推荐歌单" theme={theme} />
            {refreshButton}
          </div>
          <PlaylistShelf theme={theme} accent={accent} resources={[]} onOpenResource={() => {}} skeleton />
        </section>
      ) : contentBlocks.length > 0 ? (
        <>
          {contentBlocks.map((block, index) => (
            <Fragment key={`flow:${block.id}`}>
              {renderBlock(block, index)}
              {isRecommendPlaylistBlock(block) && featuredActivities}
            </Fragment>
          ))}
          {flowLoading && (
            <p className={`mb-8 flex items-center justify-center gap-2 text-[12px] ${theme.faint}`}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载更多推荐…
            </p>
          )}
          {/* 服务端把精选活动排在流外时的兜底位置 */}
          {!contentBlocks.some(block => isRecommendPlaylistBlock(block)) && featuredActivities}
        </>
      ) : hotLoading ? (
        <section className="mb-8">
          <div className="flex items-start justify-between gap-3">
            <PcSectionTitle title="推荐歌单" theme={theme} />
            {refreshButton}
          </div>
          <PlaylistShelf theme={theme} accent={accent} resources={[]} onOpenResource={() => {}} skeleton />
        </section>
      ) : hotPlaylists.length > 0 ? (
        <section className="mb-8">
          <div className="flex items-start justify-between gap-3">
            <PcSectionTitle title="推荐歌单" more="更多" onMore={() => actions.onNavigate({ kind: 'netease', page: 'featured', detail: 'square' })} theme={theme} />
            {refreshButton}
          </div>
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
            {hotPlaylists.map(raw => {
              const playlist = playlistFromRaw(raw, 'netease-hot-playlist')
              if (!playlist.id) return null
              return (
                <button
                  key={`hot-playlist:${playlist.id}`}
                  type="button"
                  onClick={() => actions.onOpenPlaylist(playlist)}
                  onContextMenu={event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist }) }}
                  className="group block text-left"
                >
                  <PcCover
                    src={playlist.coverUrl}
                    alt={playlist.name}
                    className="aspect-square w-full"
                    rounded="rounded-lg"
                    overlay={(
                      <>
                        <PcCountBadge value={playlist.playCount} />
                        <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                          <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                        </span>
                      </>
                    )}
                  />
                  <span className={`mt-2 line-clamp-2 text-[12px] leading-snug ${theme.text}`}>{playlist.name}</span>
                </button>
              )
            })}
          </div>
        </section>
      ) : (
        <PcEmpty theme={theme} title="暂无推荐内容" description={account.loggedIn ? '稍后再试试' : '登录后可解锁个性化推荐'} />
      )}
    </div>
  )
}

export default memo(NeteasePcHome)
