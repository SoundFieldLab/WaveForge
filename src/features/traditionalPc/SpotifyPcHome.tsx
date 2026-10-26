// 传统模式「Spotify 客户端」主页（官方桌面客户端首页 1:1）。
//
// 数据源：官方桌面客户端 home feed（partner 桥 home_snapshot 操作，返回官方
// HomeResponsePayload —— 从官方客户端 react-query 缓存导出，scripts/export-official-home.cjs
// 可随时刷新；官方客户端开着时数据自动更新）。官方结构：
//   greeting 问候 + 「全部/音乐/播客」页签 + 各分区（你的歌单/热门电台/当红艺人/
//   最近播放/热门专辑与单曲/新歌热播/秋之惬意纯音乐/今週のスポットライト），
//   每分区右上角「显示全部」（全部 → 分类页/歌单详情；区块 items 点击进官方详情链）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Info, X, Music2 } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { spotifyPcTheme } from './spotifyPcKit'
import type { PcActions } from './types'

export interface HomeSectionItemPublic extends HomeSectionItem {}

/** 官方同款横排交互：按住鼠标左右拖动滚动（Apple 传统页同款手感）。
 *  拖动超过 5px 视为拖拽，捕获阶段吞掉后续 click，避免松手误触卡片。 */
function useDragScroll() {
  return useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    let startX = 0
    let startLeft = 0
    let dragging = false
    let moved = false
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.button !== 0) return
      dragging = true
      moved = false
      startX = e.clientX
      startLeft = el.scrollLeft
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!dragging) return
      const dx = e.clientX - startX
      if (!moved && Math.abs(dx) > 5) {
        moved = true
        el.style.cursor = 'grabbing'
      }
      if (moved) el.scrollLeft = startLeft - dx
    }
    const up = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      el.style.cursor = ''
      try { el.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    const clickCapture = (e: MouseEvent) => {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false }
    }
    el.style.cursor = 'grab'
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('click', clickCapture, true)
  }, [])
}

export interface SpotifyPcHomeProps {
  tone: 'dark' | 'light'
  accent: string
  loggedIn: boolean
  username: string
  avatar?: string
  actions: PcActions
  active: boolean
  currentSong: Song | null
  onLoginClick?: () => void
  /** 打开歌单详情（外壳内嵌详情或全局链） */
  onOpenPlaylist?: (playlistId: string) => void
  /** 打开艺人页 */
  onOpenArtist?: (artistId: string) => void
  /** 打开专辑页 */
  onOpenAlbum?: (albumId: string) => void
  /** 浏览全部磁贴点击 → 官方分类页 */
  onOpenCategory?: (title: string, bg: string, accent: string) => void
  /** 分区「显示全部」→ 官方二级分区详情页 */
  onOpenSection?: (title: string, items: HomeSectionItem[]) => void
}

/** 官方 home payload（partner 桥 home_snapshot 返回）的本地类型（渲染层只读所需字段） */
interface HomeSectionItem {
  uri?: string
  content?: {
    __typename?: string
    data?: {
      __typename?: string
      name?: string
      uri?: string
      description?: string
      profile?: { name?: string }
      ownerV2?: { data?: { name?: string; uri?: string } }
      images?: { items?: Array<{ sources?: Array<{ url?: string }> }> }
      coverArt?: { sources?: Array<{ url?: string }> }
      visuals?: { avatarImage?: { sources?: Array<{ url?: string }> }; sources?: Array<{ url?: string }> }
      date?: { year?: number; isoString?: string }
      artists?: { items?: Array<{ uri?: string; profile?: { name?: string } }> }
      trackCount?: number
    }
  }
}
interface HomeSection {
  uri?: string
  data?: {
    __typename?: string
    title?: { transformedLabel?: string }
    subtitle?: { transformedLabel?: string }
  }
  sectionItems?: { items?: HomeSectionItem[] }
}
interface HomePayload {
  home?: {
    greeting?: { transformedLabel?: string }
    sectionContainer?: { sections?: { totalCount?: number; items?: HomeSection[] } }
  }
}

type HomeTab = 'all' | 'music' | 'podcasts'

/** 官方浏览页分类磁贴（官方类目 + 官方配色，取自官方客户端浏览页截图） */
export const SPOTIFY_BROWSE_CATEGORIES: Array<{ title: string; bg: string; accent: string }> = [
  { title: '音乐', bg: '#e8115b', accent: '#ff69b4' },
  { title: '播客', bg: '#006450', accent: '#27b43d' },
  { title: 'Spotify On Stage 2026', bg: '#0d73ec', accent: '#148a08' },
  { title: '为你打造', bg: '#1e3264', accent: '#e13300' },
  { title: '新歌热播', bg: '#e91429', accent: '#8d67ab' },
  { title: '日文歌曲', bg: '#8d67ab', accent: '#e8115b' },
  { title: '流行', bg: '#dc148c', accent: '#056952' },
  { title: '排行榜', bg: '#8d67ab', accent: '#e91429' },
  { title: '播客排行榜', bg: '#503750', accent: '#b02897' },
  { title: 'Radio Shows', bg: '#e91429', accent: '#1e3264' },
  { title: '教育', bg: '#537aa1', accent: '#477d95' },
  { title: '驾车', bg: '#2828a5', accent: '#0d73ec' },
  { title: '嘻哈', bg: '#ba5d07', accent: '#e8115b' },
  { title: 'RADAR', bg: '#af2896', accent: '#dc148c' },
  { title: '情绪', bg: '#e8115b', accent: '#1e3264' },
  { title: '发现', bg: '#dc148c', accent: '#7358ff' },
  { title: 'Fresh Finds', bg: '#0d73ec', accent: '#158a08' },
  { title: '动漫', bg: '#056952', accent: '#af2896' },
  { title: '年代', bg: '#7358ff', accent: '#e91429' },
]

const extractCover = (d: NonNullable<HomeSectionItem['content']>['data']): string => {
  if (!d) return ''
  return (
    d.coverArt?.sources?.[0]?.url ??
    d.images?.items?.[0]?.sources?.[0]?.url ??
    d.visuals?.avatarImage?.sources?.[0]?.url ??
    d.visuals?.sources?.[0]?.url ??
    // 电台卡封面在 attributes image_url
    ''
  )
}

export const idOf = (uri?: string, type?: string): string => {
  if (!uri) return ''
  const m = /^spotify:([^:]+):(.+)$/.exec(uri)
  return m ? m[2] : ''
}

const sectionKind = (item: HomeSectionItem): 'playlist' | 'artist' | 'album' | 'unknown' => {
  const tn = item.content?.__typename ?? ''
  if (tn.includes('Playlist')) return 'playlist'
  if (tn.includes('Artist')) return 'artist'
  if (tn.includes('Album')) return 'album'
  const uri = item.uri ?? item.content?.data?.uri ?? ''
  if (uri.startsWith('spotify:playlist:')) return 'playlist'
  if (uri.startsWith('spotify:artist:')) return 'artist'
  if (uri.startsWith('spotify:album:')) return 'album'
  return 'unknown'
}

export default function SpotifyPcHome({
  tone, accent, loggedIn, username, actions, active, currentSong, onLoginClick, onOpenPlaylist, onOpenArtist, onOpenAlbum, onOpenCategory, onOpenSection,
}: SpotifyPcHomeProps) {
  void actions
  void currentSong
  const theme = useMemo(() => spotifyPcTheme(tone), [tone])
  // 横排拖动滚动：一个 ref 回调可同时挂到每行 carousel（官方/Apple 同款交互）
  const dragScrollRef = useDragScroll()
  const [payload, setPayload] = useState<HomePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<HomeTab>('all')
  const [showBanner, setShowBanner] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const b = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<unknown> } } }).electron?.spotifyPartner
      if (!b) { setPayload(null); return }
      const res = (await b.request('home_snapshot', { facet: tab === 'music' ? 'music' : 'all' })) as { ok?: boolean; data?: HomePayload } | HomePayload | null
      // 桥返回 { ok, data } 包装：解包 data
      setPayload((res as { data?: HomePayload })?.data ?? (res as HomePayload | null))
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { if (active) void load() }, [active, load])

  const sections = useMemo(() => {
    const items = payload?.home?.sectionContainer?.sections?.items ?? []
    // 官方「全部」页签含「最近播放」分区（ListResponseWrapper 结构特殊），先渲染其余标准分区
    return items.filter(s => (s.sectionItems?.items ?? []).length > 0)
  }, [payload])
  const greeting = payload?.home?.greeting?.transformedLabel

  const openEntity = (item: HomeSectionItem) => {
    const kind = sectionKind(item)
    const uri = item.uri ?? item.content?.data?.uri ?? ''
    if (kind === 'playlist') { const id = idOf(uri, 'playlist'); if (id) onOpenPlaylist?.(id) }
    else if (kind === 'artist') { const id = idOf(uri, 'artist'); if (id) onOpenArtist?.(id) }
    else if (kind === 'album') { const id = idOf(uri, 'album'); if (id) onOpenAlbum?.(id) }
  }

  const SectionCard = ({ item }: { item: HomeSectionItem }) => {
    const kind = sectionKind(item)
    const d = item.content?.data
    const name = d?.name ?? d?.profile?.name ?? ''
    const cover = extractCover(d)
    const round = kind === 'artist'
    const sub = kind === 'playlist'
      ? `歌单 · ${d?.ownerV2?.data?.name ?? ''}`
      : kind === 'artist'
        ? '艺人'
        : kind === 'album'
          ? `${d?.date?.year ? `${d.date.year} · ` : ''}${(d?.artists?.items ?? []).map(a => a?.profile?.name ?? '').filter(Boolean).join(' / ')}`
          : ''
    return (
      <button type="button" onClick={() => openEntity(item)} className="group w-full text-left">
        <span className={`relative mb-3 block aspect-square w-full overflow-hidden shadow-lg ${round ? 'rounded-full' : 'rounded-md'}`} style={{ background: theme.panel }}>
          {cover
            ? <img src={cover} alt="" className="h-full w-full object-cover transition group-hover:brightness-110" />
            : <span className="flex h-full w-full items-center justify-center"><Music2 className="h-10 w-10" style={{ color: theme.secondary }} /></span>}
          <span className="absolute bottom-2 right-2 flex h-12 w-12 translate-y-2 items-center justify-center rounded-full opacity-0 shadow-xl transition-all group-hover:translate-y-0 group-hover:opacity-100"
            style={{ background: theme.accent }}>
            <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="#000"><path d="M8 5v14l11-7z" /></svg>
          </span>
        </span>
        <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{name}</span>
        <span className="mt-1 block truncate text-xs" style={{ color: theme.secondary }}>{sub}</span>
      </button>
    )
  }

  if (!loggedIn) {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: theme.background }}>
        <button type="button" onClick={onLoginClick}
          className="rounded-full px-8 py-3 text-sm font-bold text-black transition hover:brightness-110"
          style={{ background: theme.accent }}>
          登录 Spotify
        </button>
      </div>
    )
  }

  return (
    <div style={{ background: theme.background }} data-active={active}>
      {/* 官方渐变头 */}
      <div style={{ background: 'linear-gradient(180deg, rgba(80,56,160,.4), rgba(18,18,18,0) 320px)' }}>
        {/* 新增内容蓝色提示条（官方首屏固定横幅） */}
        {showBanner && (
          <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg px-4 py-3" style={{ background: '#3d54e6' }}>
            <Info className="h-5 w-5 shrink-0 text-white" />
            <p className="min-w-0 flex-1 truncate text-sm text-white">想寻找所关注创作者的最新作品？在主页查看音乐或播客动态</p>
            <button type="button" aria-label="关闭提示" onClick={() => setShowBanner(false)} className="p-1 text-white transition hover:opacity-70">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* 官方问候 + 页签（全部/音乐/播客） */}
        <div className="px-6 pt-6">
          <h1 className="mb-4 text-2xl font-bold" style={{ color: theme.text }}>{greeting ?? `晚上好`}</h1>
          <div className="mb-6 flex gap-2">
            {([['all', '全部'], ['music', '音乐'], ['podcasts', '播客']] as const).map(([key, label]) => (
              <button key={key} type="button" onClick={() => setTab(key)}
                className="rounded-full px-4 py-1.5 text-sm font-semibold transition"
                style={{ background: tab === key ? '#ffffff' : theme.panel, color: tab === key ? '#000000' : theme.text }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 官方分区（官方形态：每分区单行横向 carousel，右滑看更多；「显示全部」进分区二级页） */}
        {loading && <p className="px-6 py-10 text-center text-sm" style={{ color: theme.secondary }}>加载中…</p>}
        {!loading && sections.length === 0 && (
          <p className="px-6 py-10 text-center text-sm" style={{ color: theme.secondary }}>
            {tab === 'podcasts' ? '官方播客分区内容为空（收听播客后出现在这里）' : '暂无内容'}
          </p>
        )}
        {sections.map(section => {
          const title = section.data?.title?.transformedLabel ?? ''
          // 官方「最近播放」等特殊分区（ListResponseWrapper）无标准卡片，跳过渲染
          const items = (section.sectionItems?.items ?? []).filter(it => sectionKind(it) !== 'unknown')
          if (!title || items.length === 0) return null
          return (
            <div key={section.uri ?? title} className="px-6 pb-8">
              <div className="mb-3 flex items-end justify-between">
                <h2 className="text-2xl font-bold hover:underline cursor-pointer" style={{ color: theme.text }}
                  onClick={() => onOpenSection?.(title, items)}>{title}</h2>
                <button type="button" className="flex items-center text-xs font-bold transition hover:opacity-80" style={{ color: theme.secondary }}
                  onClick={() => onOpenSection?.(title, items)}>
                  显示全部 <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* 官方横向 carousel：单行，按住鼠标左右拖动滚动（官方/Apple 同款，无滚动条） */}
              <div ref={dragScrollRef} className="drag-scroll-x flex gap-4 overflow-x-auto pb-2 carousel-row">
                {items.map((item, i) => (
                  <div key={(item.uri ?? '') + i} className="w-[172px] shrink-0">
                    <SectionCard item={item} />
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
