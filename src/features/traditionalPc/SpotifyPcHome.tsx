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

const idOf = (uri?: string, type?: string): string => {
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
              {/* 官方横向 carousel：单行，横向滚动 */}
              <div className="flex gap-4 overflow-x-auto pb-2 carousel-row">
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
