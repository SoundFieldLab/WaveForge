// 网易云 PC 客户端「我的音乐库」集合页复刻（我喜欢的音乐 / 最近播放 / 我的播客 / 我的收藏 /
// 我的音乐云盘）。
//
// 为什么一个文件容纳多个页面：它们在官方客户端里共用同一套页签 + 操作条 + 表格/网格骨架，
// 差别只在数据源与页签文案；放在一起可以共享归一化与空态工具，避免多份重复代码。
// 每个 kind 各自独立取数、独立 loading/空态；未登录或接口失败时一律给空态，不白屏、不造假数据。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import {
  Headphones, LogIn, MoreHorizontal, RefreshCw, Trash2,
} from 'lucide-react'
import { fetchExplorePlaylist, type ExplorePlaylist } from '../../services/exploreApi'
import { getLikedSongs, getNeteasePlaylistTrackPage, getUserPlaylists } from '../../services/playlistService'
import { fetchNeteaseRecentSongs } from '../../services/neteaseRecentPlayback'
import { getNeteaseDjSublist, getNeteaseMvSublist, getSubscribedAlbums } from '../../services/musicApi'
import { getPlatformCookie } from '../../services/platforms'
import { getApiBase } from '../../services/apiConfig'
import { cookieHeaders } from '../../services/cookieRequest'
import { fetchNeteaseMyPodcasts } from '../neteaseExplore/discover'
import type { NeteaseNativeResource } from '../neteaseExplore/model'
import type { Song } from '../../services/musicApi'
import {
  PcCardGrid, PcDetailHeader, PcEmpty, PcGhostButton, PcIconButton, PcListFooter, PcNoticeBar,
  PcPageTitle, PcPrimaryButton, PcRowAction, PcSongTable, PcTableSearch, PcTabs, pcDuration,
  pcTheme, type PcTheme,
} from './pcKit'
import type { PcAccount, PcActions, PcChrome } from './types'

export type NeteaseCollectionKind = 'liked' | 'recent' | 'mypodcast' | 'collect' | 'cloud'

export interface NeteasePcCollectionProps {
  kind: NeteaseCollectionKind
  chrome: PcChrome
  account: PcAccount
  actions: PcActions
  authRevision?: number
  /** 隐藏保活页为 false：非 active 时不拉数据 */
  active?: boolean
}

/** 歌单页表格一次渲染的行数：官方是虚拟列表，这里用分批渲染换取零依赖（滚到底再追加）。 */
const RENDER_STEP = 300
/** 最近播放拉取条数（服务端最多给 100）。 */
const RECENT_LIMIT = 100
/** 补齐歌单曲目时的单页大小与最大页数（防止超大歌单把本地服务打满）。 */
const TRACK_PAGE_SIZE = 200
const TRACK_PAGE_LIMIT = 10

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 创建时间：官方「我喜欢的音乐」头部是 2026-07-08 这种紧凑日期 + 「创建」。 */
function formatCreatedAt(ms?: number): string {
  const value = Number(ms || 0)
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 网易云原始曲目 → Song（探索层同款字段，但那份 normalize 未导出，列表页不能改它们）。 */
function mapNeteaseTracks(tracks: unknown): Song[] {
  if (!Array.isArray(tracks)) return []
  const songs: Song[] = []
  for (const raw of tracks) {
    const track = raw?.song || raw || {}
    const id = Number(track.id || 0)
    const name = String(track.name || '')
    if (!id || !name) continue
    const artists = Array.isArray(track.ar) ? track.ar : Array.isArray(track.artists) ? track.artists : []
    const album = track.al || track.album || {}
    songs.push({
      id,
      name,
      artists: (artists.length ? artists : [{ name: '未知歌手' }]).map((artist: any) => ({ id: Number(artist?.id) || undefined, name: String(artist?.name || '未知歌手') })),
      album: { id: Number(album?.id) || undefined, name: String(album?.name || ''), picUrl: String(album?.picUrl || album?.blurPicUrl || '') },
      duration: Number(track.dt || track.duration || 0),
      platform: 'netease',
      vip: Number(track.fee) === 1,
      fee: Number(track.fee) || 0,
      noCopyright: Number(track.privilege?.st) < 0,
    })
  }
  return songs
}

/** 追加去重：分页补齐时同一首歌可能已由首批返回。 */
function mergeSongs(base: Song[], extra: Song[]): Song[] {
  if (!extra.length) return base
  const seen = new Set(base.map(song => String(song.id)))
  const merged = [...base]
  for (const song of extra) {
    const id = String(song.id)
    if (seen.has(id)) continue
    seen.add(id)
    merged.push(song)
  }
  return merged
}

/** 列表底部/加载中的统一占位。 */
function PanelLoading({ theme, label }: { theme: PcTheme; label: string }) {
  return <div className={`py-16 text-center text-[13px] ${theme.faint}`}>{label}</div>
}

/** 未登录空态（所有需要账号的 kind 共用）。 */
function LoginEmpty({ theme, accent, title, description, onLogin }: { theme: PcTheme; accent: string; title: string; description: string; onLogin?: () => void }) {
  return (
    <PcEmpty
      theme={theme}
      title={title}
      description={description}
      action={<PcPrimaryButton label="立即登录" icon={<LogIn className="h-3.5 w-3.5" />} accent={accent} onClick={onLogin} />}
    />
  )
}

/** 接口失败/无数据空态（带重试）。 */
function RetryEmpty({ theme, title, description, onRetry, retrying }: { theme: PcTheme; title: string; description?: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <PcEmpty
      theme={theme}
      title={title}
      description={description}
      action={onRetry ? (
        <PcGhostButton
          label="重试"
          icon={<RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />}
          theme={theme}
          onClick={onRetry}
          disabled={retrying}
        />
      ) : undefined}
    />
  )
}

/** 页签 + 右端工具（操作条/搜索）的公共外壳，官方客户端所有列表页都是这个骨架。 */
function TabBar({ theme, tabs, active, onChange, accent, right }: { theme: PcTheme; tabs: Array<{ key: string; label: string; count?: number }>; active: string; onChange: (key: string) => void; accent: string; right?: ReactNode }) {
  return (
    <div className={`mb-4 flex flex-wrap items-end justify-between gap-4 border-b pb-2 ${theme.divider}`}>
      <PcTabs items={tabs} value={active} onChange={onChange} accent={accent} theme={theme} />
      {right ? <div className="flex items-center gap-2 pb-0.5">{right}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 我喜欢的音乐
 * ------------------------------------------------------------------ */

interface LikedMeta {
  id: string
  name: string
  coverUrl: string
  description: string
  createTime?: number
  trackCount: number
  playCount?: number
  creator?: { userId?: string | number; nickname?: string; avatarUrl?: string }
}

/**
 * 补齐歌单剩余曲目：探索层歌单详情单次最多返回 500 首（服务端分页分支的上限），
 * 这里从已拿到的位置继续按页追加，保证「歌曲 N」与「播放全部」覆盖整个歌单。
 */
async function appendRemainingTracks(playlistId: string, offset: number, signal: AbortSignal, append: (songs: Song[]) => void) {
  let cursor = offset
  for (let page = 0; page < TRACK_PAGE_LIMIT; page += 1) {
    if (signal.aborted) return
    const result = await getNeteasePlaylistTrackPage(playlistId, cursor, TRACK_PAGE_SIZE, signal)
    const songs = mapNeteaseTracks(result.tracks)
    if (songs.length) append(songs)
    if (!result.more || result.nextOffset <= cursor) return
    cursor = result.nextOffset
  }
}

function LikedPanel({ chrome, account, actions, authRevision, active = true }: Omit<NeteasePcCollectionProps, 'kind'>) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const loggedIn = Boolean(account.loggedIn)

  const [meta, setMeta] = useState<LikedMeta | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [tab, setTab] = useState('songs')
  const [keyword, setKeyword] = useState('')
  const [visible, setVisible] = useState(RENDER_STEP)
  const [noticeHidden, setNoticeHidden] = useState(false)
  // 没有 specialType 5 歌单时，likelist 只给标识符（不能当歌曲列表），这里只拿它做数量展示
  const [likeIdCount, setLikeIdCount] = useState(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // 「更多」按钮在头部操作条里，右键菜单需要它的屏幕坐标作为弹出锚点
  const moreRef = useRef<HTMLSpanElement>(null)

  const refresh = useCallback(() => setReloadToken(value => value + 1), [])
  const userId = String(account.userId || '')

  useEffect(() => {
    if (!active || !loggedIn) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setKeyword('')
    setVisible(RENDER_STEP)
    const append = (extra: Song[]) => setSongs(prev => mergeSongs(prev, extra))

    void (async () => {
      try {
        if (!userId) {
          setMeta(null)
          setSongs([])
          setError('未获取到账号 ID，请重新登录网易云音乐')
          setLoading(false)
          return
        }
        const lists = await getUserPlaylists('netease', userId, account.username)
        const liked = (lists || []).find(item => item?.isLike === true)
          || (lists || []).find(item => /我喜欢的音乐/.test(String(item?.name || '')))
        if (controller.signal.aborted) return
        if (!liked) {
          let count = 0
          try {
            const likedIds = await getLikedSongs(userId, 'netease')
            count = Array.isArray(likedIds?.ids) ? likedIds.ids.length : 0
          } catch {
            count = 0
          }
          if (controller.signal.aborted) return
          setMeta(null)
          setSongs([])
          setLikeIdCount(count)
          setError('未读取到「我喜欢的音乐」歌单，请稍后重试')
          setLoading(false)
          return
        }
        // 探索层的歌单详情：元数据 + 首批曲目（最多 500 首），与歌单页走同一条链路。
        // 额外字段（isLike/trackCount/creator）靠 Record 声明放开，方便原样透传到 detail.playlist
        const likedInput: ExplorePlaylist & Record<string, unknown> = {
          id: String(liked.id),
          name: String(liked.name || '我喜欢的音乐'),
          coverUrl: String(liked.coverImgUrl || liked.coverUrl || ''),
          platform: 'netease',
          trackCount: Number(liked.trackCount) || undefined,
          description: String(liked.description || liked.desc || ''),
          isLike: true,
          creator: liked.creator,
        }
        const detail = await fetchExplorePlaylist(likedInput, controller.signal)
        if (controller.signal.aborted) return
        const nextMeta: LikedMeta = {
          id: String(liked.id),
          name: detail.playlist.name || String(liked.name || '我喜欢的音乐'),
          coverUrl: detail.playlist.coverImgUrl || String(liked.coverImgUrl || liked.coverUrl || ''),
          description: detail.playlist.description || String(liked.description || liked.desc || ''),
          // 分页分支不回 createTime：优先用歌单列表里的原始创建时间
          createTime: Number(liked.createTime || detail.playlist.createTime || 0) || undefined,
          trackCount: Number(detail.playlist.trackCount || detail.songs.length || liked.trackCount || 0),
          playCount: Number(detail.playlist.playCount || liked.playCount || 0) || undefined,
          creator: detail.playlist.creator || liked.creator,
        }
        setMeta(nextMeta)
        setLikeIdCount(0)
        setSongs(detail.songs)
        setLoading(false)
        if (nextMeta.trackCount > detail.songs.length) {
          // 探索层单次上限 500 首、或首批返回空时，用服务层分页把曲目补齐（失败不影响已显示的列表）
          void appendRemainingTracks(nextMeta.id, detail.songs.length, controller.signal, append).catch(() => undefined)
        }
      } catch (err: unknown) {
        if (controller.signal.aborted) return
        setMeta(null)
        setSongs([])
        setError(err instanceof Error ? err.message : '我喜欢的音乐加载失败')
        setLoading(false)
      }
    })()

    return () => controller.abort()
    // append（setSongs 包装）在渲染间是稳定语义，无需进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loggedIn, userId, account.username, authRevision, reloadToken])

  const filtered = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase()
    if (!trimmed) return songs
    return songs.filter(song =>
      song.name.toLowerCase().includes(trimmed)
      || (song.artists || []).some(artist => (artist.name || '').toLowerCase().includes(trimmed))
      || (song.album?.name || '').toLowerCase().includes(trimmed))
  }, [songs, keyword])

  useEffect(() => { setVisible(RENDER_STEP) }, [keyword])

  // 长歌单分批渲染：滚到底部哨兵进入视口就追加下一批
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const total = filtered.length
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(count => (count < total ? Math.min(total, count + RENDER_STEP) : count))
    }, { rootMargin: '400px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [filtered.length])

  const visibleSongs = useMemo(() => filtered.slice(0, visible), [filtered, visible])
  const trackCount = meta?.trackCount || songs.length || likeIdCount
  const playAll = useCallback(() => {
    if (!songs.length) return
    actions.onPlaySongs(songs[0], songs, 0)
  }, [songs, actions])

  if (!loggedIn) {
    return (
      <div className="pb-8">
        <PcPageTitle theme={theme} title="我喜欢的音乐" subtitle="登录后同步你的红心歌曲" />
        <LoginEmpty theme={theme} accent={accent} title="登录后查看我喜欢的音乐" description="红心歌曲会实时同步到网易云音乐账号" onLogin={() => actions.onLogin?.()} />
      </div>
    )
  }

  const creatorName = meta?.creator?.nickname || account.username || ''
  const creatorAvatar = meta?.creator?.avatarUrl || account.avatar
  const createdLabel = meta?.createTime ? `${formatCreatedAt(meta.createTime)} 创建` : ''

  return (
    <div className="pb-8">
      <PcDetailHeader
        theme={theme}
        skin={chrome.skin}
        coverUrl={meta?.coverUrl}
        title="我喜欢的音乐"
        playCount={meta?.playCount}
        description={meta?.description}
        meta={createdLabel}
        creator={creatorName ? {
          name: creatorName,
          avatar: creatorAvatar,
          onClick: () => actions.onNavigate({ kind: 'netease', page: 'profile' }),
        } : undefined}
        actions={(
          <>
            <PcPrimaryButton label="播放全部" accent={accent} onClick={playAll} disabled={!songs.length} />
            <span ref={moreRef} className="inline-flex">
              <PcIconButton
                theme={theme}
                title="更多"
                onClick={() => {
                  // 复用歌单右键菜单通道（页面不自己造菜单），锚点取按钮位置
                  const rect = moreRef.current?.getBoundingClientRect()
                  actions.onPlaylistMenu?.({
                    show: true,
                    x: rect?.left ?? 0,
                    y: rect?.bottom ?? 0,
                    playlist: { id: meta?.id, name: '我喜欢的音乐', coverUrl: meta?.coverUrl, isLike: true, platform: 'netease' },
                  })
                }}
              >
                <MoreHorizontal className="h-4 w-4" />
              </PcIconButton>
            </span>
          </>
        )}
      />

      {/* 官方还有「评论 / 收藏者」页签，但这两类歌单级接口都不存在：只留有数据的「歌曲」 */}
      <TabBar
        theme={theme}
        accent={accent}
        active={tab}
        onChange={setTab}
        tabs={[{ key: 'songs', label: '歌曲', count: trackCount || undefined }]}
        right={(
          <PcTableSearch
            value={keyword}
            onChange={setKeyword}
            theme={theme}
            accent={accent}
            placeholder="搜索"
            onSearch={() => {
              const next = keyword.trim()
              // 回车走平台搜索；输入过程中只做本列表过滤（与官方客户端一致）
              if (next) actions.onNavigate({ kind: 'netease', page: 'search', keyword: next })
            }}
          />
        )}
      />

      {!noticeHidden && (
        <PcNoticeBar theme={theme} onClose={() => setNoticeHidden(true)}>
          <span className="truncate">关注的歌手请至 我的主页-关注&gt;歌手</span>
        </PcNoticeBar>
      )}

      {tab === 'songs' && (
        <>
          {error && !songs.length ? (
            <RetryEmpty theme={theme} title="我喜欢的音乐加载失败" description={error} onRetry={refresh} retrying={loading} />
          ) : (
            <>
              <PcSongTable
                songs={visibleSongs}
                skin={chrome.skin}
                theme={theme}
                accent={accent}
                loading={loading && !songs.length}
                columns={{ index: true, like: true, album: true, duration: true }}
                playingKey={actions.currentSongKey}
                isPlaying={actions.isPlaying}
                onPlay={(song, index) => actions.onPlaySongs(song, filtered, index)}
                onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: filtered }) }}
                likedKeys={actions.likedKeys}
                onToggleLike={actions.onToggleLike}
                empty={(
                  <PcEmpty
                    theme={theme}
                    title={keyword.trim() ? '没有匹配的歌曲' : '还没有喜欢的歌曲'}
                    description={keyword.trim() ? `当前列表里没有包含「${keyword.trim()}」的歌曲` : '在歌曲上点红心，就会出现在这里'}
                  />
                )}
              />
              <div ref={sentinelRef} />
              {visible < filtered.length && (
                <PcListFooter theme={theme} label={`已显示 ${visibleSongs.length} / ${filtered.length} 首，继续下滑加载更多`} />
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 最近播放
 * ------------------------------------------------------------------ */

type RecentSong = Song & { playedAt?: number }
/** 内容类最近播放（服务端 /netease/record/recent/:type 支持的类型，song 单列在上面的歌曲表）。 */
type RecentContentType = 'playlist' | 'album' | 'dj'

const RECENT_TYPE_LABEL: Record<RecentContentType, string> = { playlist: '歌单', album: '专辑', dj: '电台节目' }

/** 内容类记录的模块级短 TTL 缓存：页签来回切换不重发请求（账号级数据 30s 足够新鲜）。 */
const RECENT_LIST_CACHE_TTL = 30_000
const recentListCache = new Map<string, { rows: any[]; expiresAt: number }>()

/** 最近播放的歌单/专辑/电台节目记录行（服务端与 neteaseRecentPlayback 同一条路由，type 不同）。 */
async function fetchRecentListRows(type: RecentContentType): Promise<any[]> {
  const cached = recentListCache.get(type)
  if (cached && cached.expiresAt > Date.now()) return cached.rows
  if (cached) recentListCache.delete(type)
  const cookie = getPlatformCookie('netease')
  if (!cookie) throw new Error('请先登录网易云音乐')
  const response = await fetch(`${getApiBase()}/netease/record/recent/${type}?limit=${RECENT_LIMIT}`, { cache: 'no-store' })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) throw new Error(payload?.error || `最近${RECENT_TYPE_LABEL[type]}读取失败（HTTP ${response.status}）`)
  const candidates = [payload?.data?.list, payload?.data?.records, payload?.data, payload?.list, payload?.records]
  const rows = candidates.find(Array.isArray) || []
  recentListCache.set(type, { rows, expiresAt: Date.now() + RECENT_LIST_CACHE_TTL })
  return rows
}

/** 最近播放内容卡（歌单/专辑/电台节目共用的网格卡）。 */
interface RecentCard {
  key: string
  coverUrl?: string
  title: string
  subtitle?: string
  playCount?: number | null
  onClick?: () => void
  onContextMenu?: (event: ReactMouseEvent) => void
}

/** 最近播放的歌单行 → 卡片：副标题「N 首」，点击走歌单通道打开。 */
function recentPlaylistCards(rows: any[], actions: PcActions): RecentCard[] {
  const cards: RecentCard[] = []
  for (const row of rows) {
    const resource = row?.resource || row?.data || row
    const id = String(resource?.id || row?.resourceId || '')
    const name = String(resource?.name || '')
    if (!id || !name) continue
    const coverUrl = String(resource?.coverImgUrl || resource?.picUrl || resource?.coverUrl || '')
    const trackCount = Number(resource?.trackCount || resource?.size || 0) || undefined
    const raw = { id, name, coverUrl, platform: 'netease', trackCount }
    cards.push({
      key: `recent-playlist:${id}`,
      coverUrl,
      title: name,
      subtitle: trackCount ? `${trackCount} 首` : undefined,
      playCount: Number(resource?.playCount || 0) || undefined,
      onClick: () => actions.onOpenPlaylist(raw),
      onContextMenu: event => {
        event.preventDefault()
        actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: raw })
      },
    })
  }
  return cards
}

/** 最近播放的专辑行 → 卡片：副标题是歌手名（官方专辑卡同款），点击进专辑详情。 */
function recentAlbumCards(rows: any[], actions: PcActions): RecentCard[] {
  const cards: RecentCard[] = []
  for (const row of rows) {
    const resource = row?.resource || row?.data || row
    const id = String(resource?.id || row?.resourceId || '')
    const name = String(resource?.name || '')
    if (!id || !name) continue
    const artists = Array.isArray(resource?.artists) ? resource.artists : resource?.artist ? [resource.artist] : []
    cards.push({
      key: `recent-album:${id}`,
      coverUrl: String(resource?.picUrl || resource?.blurPicUrl || resource?.coverUrl || ''),
      title: name,
      subtitle: artists.map((artist: any) => artist?.name).filter(Boolean).join(' / ') || String(resource?.company || '') || undefined,
      onClick: () => actions.onOpenAlbum?.(id, 'netease'),
    })
  }
  return cards
}

/**
 * 最近播放的电台节目行 → 卡片：节目本身没有独立的打开通道（PcActions 无 channel），
 * 按本文件播客页签的约定打开所属电台（走歌单通道，isRadio）；行里没有电台信息就不给点击。
 */
function recentDjCards(rows: any[], actions: PcActions): RecentCard[] {
  const cards: RecentCard[] = []
  for (const row of rows) {
    const resource = row?.resource || row?.data || row
    const radio = resource?.radio || resource?.djRadio || {}
    const programId = String(resource?.programId || resource?.id || row?.resourceId || '')
    const name = String(resource?.programName || resource?.name || '')
    if (!programId || !name) continue
    const coverUrl = String(resource?.coverUrl || resource?.picUrl || resource?.mainSong?.coverUrl || radio?.picUrl || '')
    const radioId = String(radio?.id || '')
    const radioName = String(radio?.name || '')
    cards.push({
      key: `recent-dj:${programId}`,
      coverUrl,
      title: name,
      subtitle: radioName || undefined,
      onClick: radioId
        ? () => actions.onOpenPlaylist({ id: radioId, name: radioName || '播客', coverUrl: String(radio?.picUrl || coverUrl), platform: 'netease', isRadio: true })
        : undefined,
    })
  }
  return cards
}

/**
 * 「播放时间」列：neteaseRecentPlayback 的归一化结果只保留可播放字段，不带时间戳，
 * 所以按同一接口的原始行再取一次 playTime，按歌曲 id 建映射。
 * 失败就退化为没有时间内容（列表照常显示），不阻塞主流程。
 */
async function fetchRecentPlayTimes(cookie: string): Promise<Map<string, number>> {
  const response = await fetch(`${getApiBase()}/netease/record/recent/song?limit=${RECENT_LIMIT}`, { cache: 'no-store', headers: cookieHeaders(cookie) })
  const payload = await response.json()
  const candidates = [
    payload?.data?.list, payload?.data?.records, payload?.data?.songs, payload?.data,
    payload?.list, payload?.records, payload?.songs, payload?.weekData, payload?.allData,
  ]
  const rows = candidates.find(Array.isArray) || []
  const map = new Map<string, number>()
  for (const row of rows as any[]) {
    const song = row?.song || row?.resource || row?.data || row
    const id = String(song?.id ?? row?.songId ?? row?.resourceId ?? '')
    let time = Number(row?.playTime ?? row?.playedAt ?? row?.playtime ?? row?.createTime ?? row?.timestamp ?? 0)
    // 官方 playTime 是毫秒；万一返回秒级（10 位）就补成毫秒，pcDateTime 只认毫秒
    if (time > 0 && time < 1e12) time *= 1000
    if (id && time > 0) map.set(id, time)
  }
  return map
}

function RecentPanel({ chrome, account, actions, authRevision, active = true }: Omit<NeteasePcCollectionProps, 'kind'>) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const loggedIn = Boolean(account.loggedIn)

  const [songs, setSongs] = useState<RecentSong[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [tab, setTab] = useState('songs')

  // 内容类记录（歌单/专辑/电台节目）按页签独立取数，互不阻塞
  const [contentCards, setContentCards] = useState<Partial<Record<RecentContentType, RecentCard[]>>>({})
  const [contentLoading, setContentLoading] = useState<Partial<Record<RecentContentType, boolean>>>({})
  const [contentError, setContentError] = useState<Partial<Record<RecentContentType, string>>>({})

  const refresh = useCallback(() => setReloadToken(value => value + 1), [])
  // 已加载标记：页签来回切换时不重复打接口（authRevision / 刷新按钮变化才重新拉）
  const loadKey = `${authRevision ?? 0}:${reloadToken}`
  const songsKeyRef = useRef('')
  const contentKeyRefs = useRef<Partial<Record<RecentContentType, string>>>({})
  // actions 是父层每次渲染都可能变的新对象：进 ref，避免失败重拉被无关状态变化放大（repo 惯例见 QQPcCollection）
  const actionsRef = useRef(actions)
  useEffect(() => { actionsRef.current = actions })

  useEffect(() => {
    if (!active || !loggedIn || tab !== 'songs') return
    if (songsKeyRef.current === loadKey) return
    songsKeyRef.current = loadKey
    let cancelled = false
    setLoading(true)
    setError('')
    const cookie = getPlatformCookie('netease')
    void (async () => {
      try {
        const result = await fetchNeteaseRecentSongs(cookie, RECENT_LIMIT)
        // 时间列单独补一次原始行；拿不到就只少一列内容
        const times = await fetchRecentPlayTimes(cookie).catch(() => new Map<string, number>())
        if (cancelled) return
        setSongs(result.songs.map(song => ({ ...song, playedAt: times.get(String(song.id)) })) as RecentSong[])
        setLoading(false)
      } catch (err: unknown) {
        if (cancelled) return
        setSongs([])
        setError(err instanceof Error ? err.message : '最近播放加载失败')
        setLoading(false)
        // 失败不留请求锁：下次激活/重进页签时能自动重试（与内容页签同口径）
        songsKeyRef.current = ''
      }
    })()
    return () => { cancelled = true }
  }, [active, loggedIn, tab, loadKey])

  // 歌单/专辑/电台节目记录：选中页签才拉，每个类型各自独立 loading/空态
  useEffect(() => {
    if (!active || !loggedIn) return
    if (tab !== 'playlist' && tab !== 'album' && tab !== 'dj') return
    const type = tab
    if (contentKeyRefs.current[type] === loadKey) return
    let cancelled = false
    setContentLoading(prev => ({ ...prev, [type]: true }))
    setContentError(prev => ({ ...prev, [type]: '' }))
    fetchRecentListRows(type)
      .then(rows => {
        if (cancelled) return
        contentKeyRefs.current[type] = loadKey
        const cards = type === 'playlist'
          ? recentPlaylistCards(rows, actionsRef.current)
          : type === 'album'
            ? recentAlbumCards(rows, actionsRef.current)
            : recentDjCards(rows, actionsRef.current)
        setContentCards(prev => ({ ...prev, [type]: cards }))
        setContentLoading(prev => ({ ...prev, [type]: false }))
        // 空结果不是错误：渲染成普通空态，不带「重试」按钮（error 只留给真正的失败）
      })
      .catch(() => {
        if (cancelled) return
        setContentCards(prev => ({ ...prev, [type]: [] }))
        setContentError(prev => ({ ...prev, [type]: `最近${RECENT_TYPE_LABEL[type]}加载失败` }))
        setContentLoading(prev => ({ ...prev, [type]: false }))
      })
    return () => { cancelled = true }
  }, [active, loggedIn, tab, loadKey])

  const playAll = useCallback(() => {
    if (!songs.length) return
    actions.onPlaySongs(songs[0], songs, 0)
  }, [songs, actions])

  if (!loggedIn) {
    return (
      <div className="pb-8">
        <PcPageTitle theme={theme} title="最近播放" subtitle="登录后同步网易云音乐的播放记录" />
        <LoginEmpty theme={theme} accent={accent} title="登录后查看最近播放" description="播放记录来自网易云音乐账号的最近播放列表" onLogin={() => actions.onLogin?.()} />
      </div>
    )
  }

  // 官方最近播放还有 声音/视频 两条记录线（服务端 voice/video 类型也存在），
  // 但本软件没有对应的打开/播放通道，不做死页签；歌单/专辑/电台节目有真实记录接口，全部保留。
  const tabs = [
    { key: 'songs', label: '单曲', count: songs.length || undefined },
    { key: 'playlist', label: '歌单', count: contentCards.playlist?.length || undefined },
    { key: 'album', label: '专辑', count: contentCards.album?.length || undefined },
    { key: 'dj', label: '电台节目', count: contentCards.dj?.length || undefined },
  ]

  // 当前选中的内容类页签（非歌曲表），渲染分支要用
  const contentType: RecentContentType | null = tab === 'playlist' || tab === 'album' || tab === 'dj' ? tab : null
  const activeCards = (contentType && contentCards[contentType]) || []
  const activeTypeLoading = (contentType && contentLoading[contentType]) || false
  const activeTypeError = (contentType && contentError[contentType]) || ''

  return (
    <div className="pb-8">
      <TabBar
        theme={theme}
        accent={accent}
        active={tab}
        onChange={setTab}
        tabs={tabs}
        right={(
          <>
            {/* 播放全部只属于单曲页签（歌单/专辑/电台节目是内容卡，没有整块播放语义） */}
            {tab === 'songs' && <PcPrimaryButton label="播放全部" accent={accent} onClick={playAll} disabled={!songs.length} />}
            <PcGhostButton
              label="刷新"
              icon={<RefreshCw className={`h-3.5 w-3.5 ${loading || activeTypeLoading ? 'animate-spin' : ''}`} />}
              theme={theme}
              onClick={refresh}
              disabled={loading || activeTypeLoading}
            />
          </>
        )}
      />

      {tab === 'songs' && (
        error && !songs.length ? (
          <RetryEmpty theme={theme} title="最近播放加载失败" description={error} onRetry={refresh} retrying={loading} />
        ) : (
          <PcSongTable
            songs={songs}
            skin={chrome.skin}
            theme={theme}
            accent={accent}
            loading={loading && !songs.length}
            columns={{ index: true, like: true, album: true, playedAt: true, duration: true }}
            playingKey={actions.currentSongKey}
            isPlaying={actions.isPlaying}
            onPlay={(song, index) => actions.onPlaySongs(song, songs, index)}
            onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs }) }}
            likedKeys={actions.likedKeys}
            onToggleLike={actions.onToggleLike}
            empty={<PcEmpty theme={theme} title="还没有最近播放记录" description="在网易云音乐里播放过的歌曲会出现在这里" />}
          />
        )
      )}

      {/* 歌单/专辑/电台节目：内容卡网格（点击进歌单/专辑详情；电台节目打开所属电台） */}
      {contentType && (
        activeTypeLoading && !activeCards.length ? (
          <PanelLoading theme={theme} label={`正在加载最近${RECENT_TYPE_LABEL[contentType]}…`} />
        ) : activeCards.length ? (
          <PcCardGrid items={activeCards} theme={theme} accent={accent} columns={6} />
        ) : (
          <RetryEmpty
            theme={theme}
            title={activeTypeError || `还没有最近播放的${RECENT_TYPE_LABEL[contentType]}`}
            description={`在网易云音乐里播放过的${RECENT_TYPE_LABEL[contentType]}会出现在这里`}
            onRetry={refresh}
            retrying={activeTypeLoading}
          />
        )
      )}

    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 我的播客
 * ------------------------------------------------------------------ */

interface PodcastCard {
  key: string
  coverUrl?: string
  title: string
  subtitle?: string
  playCount?: number | null
  raw: any
}

function MyPodcastPanel({ chrome, account, actions, authRevision, active = true }: Omit<NeteasePcCollectionProps, 'kind'>) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const loggedIn = Boolean(account.loggedIn)
  const userId = String(account.userId || '')

  const [tab, setTab] = useState('subscribed')
  const [reloadToken, setReloadToken] = useState(0)
  const refresh = useCallback(() => setReloadToken(value => value + 1), [])

  const [subscribed, setSubscribed] = useState<PodcastCard[]>([])
  const [subscribedLoading, setSubscribedLoading] = useState(false)
  const [subscribedError, setSubscribedError] = useState('')

  const [mine, setMine] = useState<PodcastCard[]>([])
  const [mineLoading, setMineLoading] = useState(false)
  const [mineError, setMineError] = useState('')

  // 已加载标记：页签来回切换时不重复打接口（authRevision / 刷新按钮变化才重新拉）
  const loadKey = `${authRevision ?? 0}:${reloadToken}`
  const subscribedKeyRef = useRef('')
  const mineKeyRef = useRef('')

  // 收藏的播客：订阅电台列表（dj/sublist）
  useEffect(() => {
    if (!active || !loggedIn || tab !== 'subscribed') return
    if (subscribedKeyRef.current === loadKey) return
    let cancelled = false
    setSubscribedLoading(true)
    setSubscribedError('')
    getNeteaseDjSublist({ cookie: getPlatformCookie('netease'), limit: 100 })
      .then(payload => {
        if (cancelled) return
        subscribedKeyRef.current = loadKey
        const candidates = [payload?.djRadios, payload?.data?.djRadios, payload?.data?.list, payload?.data]
        const list = candidates.find(Array.isArray) || []
        const cards: PodcastCard[] = (list as any[]).map((item: any): PodcastCard | null => {
          const radio = item?.dj ? { ...item, ...item.dj } : item
          const id = String(radio?.id || radio?.radioId || '')
          if (!id || !radio?.name) return null
          return {
            key: `dj:${id}`,
            coverUrl: String(radio?.picUrl || radio?.coverUrl || ''),
            title: String(radio?.name || ''),
            subtitle: Number(radio?.programCount) ? `${Number(radio.programCount)} 期` : String(radio?.desc || radio?.rcmdText || ''),
            playCount: Number(radio?.playCount || radio?.subCount || 0) || undefined,
            raw: { id, name: String(radio.name), coverUrl: String(radio?.picUrl || radio?.coverUrl || ''), platform: 'netease', isRadio: true },
          }
        }).filter((card): card is PodcastCard => Boolean(card))
        setSubscribed(cards)
        setSubscribedLoading(false)
        if (!cards.length) setSubscribedError('没有读取到收藏的播客')
      })
      .catch(() => {
        if (cancelled) return
        setSubscribed([])
        setSubscribedError('收藏的播客加载失败')
        setSubscribedLoading(false)
      })
    return () => { cancelled = true }
  }, [active, loggedIn, tab, authRevision, reloadToken, loadKey])

  // 创建/订阅：账号播客（native my-podcasts）
  useEffect(() => {
    if (!active || !loggedIn || tab !== 'mine') return
    if (mineKeyRef.current === loadKey) return
    let cancelled = false
    setMineLoading(true)
    setMineError('')
    fetchNeteaseMyPodcasts(userId)
      .then((resources: NeteaseNativeResource[]) => {
        if (cancelled) return
        mineKeyRef.current = loadKey
        const cards: PodcastCard[] = resources.map(resource => ({
          key: `radio:${resource.id}`,
          coverUrl: resource.coverUrl,
          title: resource.title,
          subtitle: resource.subtitle || (resource.playCount ? '' : '我的播客'),
          playCount: resource.playCount ?? undefined,
          raw: { id: resource.id, name: resource.title, coverUrl: resource.coverUrl, platform: 'netease', isRadio: true },
        }))
        setMine(cards)
        setMineLoading(false)
        if (!cards.length) setMineError('没有读取到我的播客')
      })
      .catch(() => {
        if (cancelled) return
        setMine([])
        setMineError('我的播客加载失败')
        setMineLoading(false)
      })
    return () => { cancelled = true }
  }, [active, loggedIn, tab, userId, authRevision, reloadToken, loadKey])

  if (!loggedIn) {
    return (
      <div className="pb-8">
        <PcPageTitle theme={theme} title="我的播客" subtitle="登录后查看收藏与创建的播客" />
        <LoginEmpty theme={theme} accent={accent} title="登录后查看我的播客" description="播客收藏与创建列表来自网易云音乐账号" onLogin={() => actions.onLogin?.()} />
      </div>
    )
  }

  const cards = tab === 'subscribed' ? subscribed : mine
  const loading = tab === 'subscribed' ? subscribedLoading : mineLoading
  const error = tab === 'subscribed' ? subscribedError : mineError

  const renderGrid = (items: PodcastCard[]) => (
    <PcCardGrid
      items={items.map(card => ({
        key: card.key,
        coverUrl: card.coverUrl,
        title: card.title,
        subtitle: card.subtitle,
        playCount: card.playCount ?? undefined,
        // 网易云电台没有独立动作通道（PcActions 无 channel），按约定走歌单通道打开
        onClick: () => actions.onOpenPlaylist(card.raw),
        onContextMenu: event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: card.raw }) },
      }))}
      theme={theme}
      accent={accent}
      columns={6}
    />
  )

  return (
    <div className="pb-8">
      <PcPageTitle theme={theme} title="我的播客" subtitle="收藏的播客与创建的播客" />
      <TabBar
        theme={theme}
        accent={accent}
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'subscribed', label: '收藏的播客', count: subscribed.length || undefined },
          { key: 'mine', label: '创建/订阅', count: mine.length || undefined },
        ]}
        right={<PcGhostButton label="刷新" icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />} theme={theme} onClick={refresh} disabled={loading} />}
      />
      {loading && !cards.length ? (
        <PanelLoading theme={theme} label="正在加载播客…" />
      ) : cards.length === 0 ? (
        <RetryEmpty
          theme={theme}
          title={tab === 'subscribed' ? '还没有收藏的播客' : '还没有创建/订阅的播客'}
          description={error || '在播客页收藏或创建播客后，这里会显示它们'}
          onRetry={refresh}
          retrying={loading}
        />
      ) : renderGrid(cards)}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 我的收藏
 * ------------------------------------------------------------------ */

interface AlbumCard {
  key: string
  coverUrl?: string
  title: string
  subtitle?: string
  albumId: string
}

/** 收藏的 MV 卡（mv/sublist 行 → PcCardGrid）。 */
interface MvCard {
  key: string
  coverUrl?: string
  title: string
  subtitle?: string
  mvId: string
}

function CollectPanel({ chrome, account, actions, authRevision, active = true }: Omit<NeteasePcCollectionProps, 'kind'>) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const loggedIn = Boolean(account.loggedIn)

  const [tab, setTab] = useState('album')
  const [chip, setChip] = useState('collected')
  const [reloadToken, setReloadToken] = useState(0)
  const [albums, setAlbums] = useState<AlbumCard[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mvs, setMvs] = useState<MvCard[]>([])
  const [mvLoading, setMvLoading] = useState(false)
  const [mvError, setMvError] = useState('')
  const refresh = useCallback(() => setReloadToken(value => value + 1), [])
  // 已加载标记：页签/胶囊来回切换不重复打接口
  const loadKey = `${authRevision ?? 0}:${reloadToken}`
  const loadedKeyRef = useRef('')
  const mvsKeyRef = useRef('')

  useEffect(() => {
    if (!active || !loggedIn) return
    if (tab !== 'album' || chip !== 'collected') return
    if (loadedKeyRef.current === loadKey) return
    let cancelled = false
    setLoading(true)
    setError('')
    getSubscribedAlbums('netease', { cookie: getPlatformCookie('netease') })
      .then(payload => {
        if (cancelled) return
        loadedKeyRef.current = loadKey
        const candidates = [payload?.data?.list, payload?.data?.data, payload?.data, payload?.list]
        const list = candidates.find(Array.isArray) || []
        const cards: AlbumCard[] = (list as any[]).map((item: any): AlbumCard | null => {
          const id = String(item?.id || item?.albumId || '')
          if (!id || !item?.name) return null
          const artists = Array.isArray(item?.artists) ? item.artists : Array.isArray(item?.artist?.name) ? [item.artist] : []
          return {
            key: `album:${id}`,
            coverUrl: String(item?.picUrl || item?.blurPicUrl || ''),
            title: String(item.name),
            // 官方专辑卡副标题就是歌手名（没有歌手信息时用发行公司兜底）
            subtitle: artists.length
              ? artists.map((artist: any) => artist?.name).filter(Boolean).join(' / ')
              : String(item?.company || ''),
            albumId: id,
          }
        }).filter((card): card is AlbumCard => Boolean(card))
        setAlbums(cards)
        setLoading(false)
        if (!cards.length) setError('没有读取到收藏的专辑')
      })
      .catch(() => {
        if (cancelled) return
        setAlbums([])
        setError('收藏的专辑加载失败')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [active, loggedIn, tab, chip, authRevision, reloadToken, loadKey])

  // 收藏的 MV：mv/sublist 服务层包装（getNeteaseMvSublist 内部失败返回 []，不抛错）
  useEffect(() => {
    if (!active || !loggedIn || tab !== 'mv') return
    if (mvsKeyRef.current === loadKey) return
    let cancelled = false
    setMvLoading(true)
    setMvError('')
    getNeteaseMvSublist({ cookie: getPlatformCookie('netease') })
      .then(payload => {
        if (cancelled) return
        mvsKeyRef.current = loadKey
        // 包装层返回 data.data（可能是 { list: [...] } 也可能直接是数组），行字段兼容新旧两代
        const candidates = [payload, payload?.list, payload?.data, payload?.data?.list]
        const list = candidates.find(Array.isArray) || []
        const cards: MvCard[] = (list as any[]).map((item: any): MvCard | null => {
          const id = String(item?.mvId ?? item?.vid ?? item?.id ?? '')
          const name = String(item?.mvName ?? item?.name ?? '')
          if (!id || !name) return null
          const artists = Array.isArray(item?.artists)
            ? item.artists.map((artist: any) => artist?.name).filter(Boolean).join(' / ')
            : String(item?.artistName || '')
          const durationMs = Number(item?.duration || 0) || 0
          return {
            key: `mv:${id}`,
            coverUrl: String(item?.cover || item?.coverUrl || item?.picUrl || ''),
            title: name,
            subtitle: [artists, durationMs ? pcDuration(durationMs) : ''].filter(Boolean).join(' · ') || undefined,
            mvId: id,
          }
        }).filter((card): card is MvCard => Boolean(card))
        setMvs(cards)
        setMvLoading(false)
        if (!cards.length) setMvError('没有读取到收藏的 MV')
      })
      .catch(() => {
        if (cancelled) return
        setMvs([])
        setMvError('收藏的 MV 加载失败')
        setMvLoading(false)
      })
    return () => { cancelled = true }
  }, [active, loggedIn, tab, authRevision, reloadToken, loadKey])

  if (!loggedIn) {
    return (
      <div className="pb-8">
        <PcPageTitle theme={theme} title="我的收藏" subtitle="登录后查看收藏的专辑" />
        <LoginEmpty theme={theme} accent={accent} title="登录后查看我的收藏" description="收藏专辑来自网易云音乐账号" onLogin={() => actions.onLogin?.()} />
      </div>
    )
  }

  return (
    <div className="pb-8">
      {/* 官方是「专辑 / MV」两页签 + 「收藏专辑 / 已购专辑」两胶囊；已购专辑按产品决策永久不做，胶囊不做 */}
      <PcPageTitle theme={theme} title="我的收藏" subtitle="收藏的专辑与收藏的 MV" />
      <TabBar
        theme={theme}
        accent={accent}
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'album', label: '收藏的专辑', count: albums.length || undefined },
          { key: 'mv', label: '收藏的 MV', count: mvs.length || undefined },
        ]}
        right={(
          <PcGhostButton
            label="刷新"
            icon={<RefreshCw className={`h-3.5 w-3.5 ${loading || mvLoading ? 'animate-spin' : ''}`} />}
            theme={theme}
            onClick={refresh}
            disabled={loading || mvLoading}
          />
        )}
      />

      {tab === 'album' && (
        <>
          {loading && !albums.length ? (
            <PanelLoading theme={theme} label="正在加载收藏专辑…" />
          ) : albums.length === 0 ? (
            <RetryEmpty theme={theme} title="还没有收藏专辑" description={error || '在专辑页点收藏后，这里会显示它们'} onRetry={refresh} retrying={loading} />
          ) : (
            <PcCardGrid
              items={albums.map(album => ({
                key: album.key,
                coverUrl: album.coverUrl,
                title: album.title,
                subtitle: album.subtitle,
                onClick: () => actions.onOpenAlbum?.(album.albumId, 'netease'),
              }))}
              theme={theme}
              accent={accent}
              columns={6}
            />
          )}
        </>
      )}

      {tab === 'mv' && (
        mvLoading && !mvs.length ? (
          <PanelLoading theme={theme} label="正在加载收藏的 MV…" />
        ) : mvs.length === 0 ? (
          <RetryEmpty theme={theme} title="还没有收藏的 MV" description={mvError || '在 MV 页点收藏后，这里会显示它们'} onRetry={refresh} retrying={mvLoading} />
        ) : (
          <PcCardGrid
            items={mvs.map(mv => ({
              key: mv.key,
              coverUrl: mv.coverUrl,
              title: mv.title,
              subtitle: mv.subtitle,
              // MV 直接进弹窗播放通道（TraditionalView 的 mvModal，netease MV id）
              onClick: () => actions.onOpenMv?.(mv.mvId, 'netease'),
            }))}
            theme={theme}
            accent={accent}
            columns={6}
          />
        )
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 我的音乐云盘
 * ------------------------------------------------------------------ */

type CloudSong = Song & { fileSize?: number }

interface CloudResult {
  songs: CloudSong[]
  /** 已用/总容量（MB）。接口不给容量信息时为 undefined，页面只显示文件数 */
  usedMb?: number
  totalMb?: number
}

/**
 * 云盘列表：后端路由已存在（local-server.mjs 的 /api/netease/cloud/list），前端就地包一层最小 fetch。
 * 上传链路本软件没有，不做；删除走 /api/netease/cloud/delete（见下方 deleteCloudSong），
 * 试听走 /api/netease/cloud/url（见下方 fetchCloudSongUrl）。
 */
async function fetchCloudList(signal: AbortSignal): Promise<CloudResult> {
  const cookie = getPlatformCookie('netease')
  if (!cookie) throw new Error('请先登录网易云音乐')
  const response = await fetch(`${getApiBase()}/netease/cloud/list?limit=200&offset=0`, { signal, cache: 'no-store', headers: cookieHeaders(cookie) })
  const payload = await response.json()
  if (!response.ok || payload?.error) throw new Error(payload?.error || `云盘列表读取失败（HTTP ${response.status}）`)
  const candidates = [payload?.data?.list, payload?.data?.songs, payload?.data, payload?.list, payload?.songs]
  const rows = candidates.find(Array.isArray) || []
  const songs: CloudSong[] = []
  for (const row of rows as any[]) {
    const simple = row?.simpleSong || row?.song || {}
    const id = Number(row?.songId ?? simple?.id ?? row?.id ?? 0)
    const name = String(row?.songName ?? simple?.name ?? '')
    // 云盘行只有 songId/songName 是稳定字段，缺任一就跳过（不猜歌名）
    if (!id || !name) continue
    const artists = Array.isArray(simple?.ar) ? simple.ar : Array.isArray(simple?.artists) ? simple.artists : []
    songs.push({
      id,
      name,
      artists: [{ name: String(row?.artist || artists.map((artist: any) => artist?.name).filter(Boolean).join(' / ') || '未知歌手') }],
      album: {
        id: Number(simple?.al?.id) || undefined,
        name: String(row?.album || simple?.al?.name || ''),
        picUrl: String(simple?.al?.picUrl || ''),
      },
      duration: Number(simple?.dt || simple?.duration || row?.duration || 0),
      platform: 'netease',
      fileSize: Number(row?.fileSize || 0) || undefined,
    })
  }
  const container = payload?.data && !Array.isArray(payload.data) ? payload.data : {}
  // size/maxSize 的上游单位是字节（实测 maxSize=107374182400 表示 100G）：
  // 超过 1e6 一律按字节换算成 MB，否则会出现「104857600G」这种天文数字
  const toMb = (value: unknown): number | undefined => {
    const num = Number(value ?? 0) || 0
    if (!num) return undefined
    return num > 1e6 ? Math.round(num / 1048576) : num
  }
  const usedMb = toMb(payload?.size ?? container?.size)
  const totalMb = toMb(payload?.maxSize ?? container?.maxSize)
  return { songs, usedMb, totalMb }
}

/** 容量文案：官方是 0G/5G 这种粒度（接口给的是 MB）。 */
function formatCapacity(mb?: number): string {
  const value = Number(mb || 0)
  if (!value) return '0G'
  if (value < 1024) return `${Math.round(value)}M`
  const gb = value / 1024
  return `${Number(gb.toFixed(gb < 10 ? 1 : 0))}G`
}

/* 云盘文件播放地址（服务端 /api/netease/cloud/url，参数 id + cookie）：
   返回的直链带有效期（上游 expi 600s），这里给 5 分钟的模块级缓存，
   同一首反复点试听不重发请求；过期自动重取。 */
const CLOUD_URL_CACHE_TTL = 5 * 60_000
const cloudUrlCache = new Map<string, { url: string; expiresAt: number }>()

async function fetchCloudSongUrl(songId: number | string): Promise<string> {
  const key = String(songId)
  const cached = cloudUrlCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.url
  if (cached) cloudUrlCache.delete(key)
  const cookie = getPlatformCookie('netease')
  if (!cookie) throw new Error('请先登录网易云音乐')
  const response = await fetch(`${getApiBase()}/netease/cloud/url?id=${encodeURIComponent(key)}`, { cache: 'no-store', headers: cookieHeaders(cookie) })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) throw new Error(payload?.error || `云盘文件地址获取失败（HTTP ${response.status}）`)
  // 服务端把上游 http 直链转成了 https；data 主体兼容对象/数组两种返回形态
  const url = String(payload?.data?.url || (Array.isArray(payload?.data) ? payload.data[0]?.url : '') || '')
  if (!url) throw new Error('该云盘文件暂时没有可用的播放地址')
  cloudUrlCache.set(key, { url, expiresAt: Date.now() + CLOUD_URL_CACHE_TTL })
  return url
}

/* 云盘试听：正式播放链路按平台歌曲解析地址，而云盘专属文件不在公共曲库（song/url 常拿不到流），
   所以用页面内独立的 Audio 元素直接放云盘直链；同一时间只播一个，切换/卸载都要停掉。 */
let cloudPreviewAudio: HTMLAudioElement | null = null
let cloudPreviewToken = 0

function stopCloudPreview() {
  cloudPreviewToken += 1
  if (cloudPreviewAudio) {
    cloudPreviewAudio.pause()
    cloudPreviewAudio.removeAttribute('src')
    cloudPreviewAudio = null
  }
}

/** 返回 true 表示真的开始播放了（false = 取地址期间被别的点击/停止顶掉）。 */
async function playCloudPreview(songId: number | string, onEnded?: () => void): Promise<boolean> {
  stopCloudPreview()
  const token = cloudPreviewToken
  const url = await fetchCloudSongUrl(songId)
  // 取地址期间用户又点了别的（或停止）：这次结果直接作废
  if (token !== cloudPreviewToken) return false
  const audio = new Audio(url)
  cloudPreviewAudio = audio
  audio.onended = () => {
    if (cloudPreviewAudio === audio) cloudPreviewAudio = null
    onEnded?.()
  }
  try {
    await audio.play()
  } catch {
    if (cloudPreviewAudio === audio) cloudPreviewAudio = null
    throw new Error('浏览器未能播放云盘文件，请重试')
  }
  return true
}

/** 云盘删除（服务端 POST /api/netease/cloud/delete，参数 id + cookie）。 */
async function deleteCloudSong(songId: number | string): Promise<void> {
  const cookie = getPlatformCookie('netease')
  if (!cookie) throw new Error('请先登录网易云音乐')
  const response = await fetch(`${getApiBase()}/netease/cloud/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: String(songId), cookie }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.error) throw new Error(payload?.error || `云盘删除失败（HTTP ${response.status}）`)
}

function CloudPanel({ chrome, account, actions, authRevision, active = true }: Omit<NeteasePcCollectionProps, 'kind'>) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const loggedIn = Boolean(account.loggedIn)

  const [tab, setTab] = useState('uploaded')
  const [result, setResult] = useState<CloudResult>({ songs: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [keyword, setKeyword] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  // 行内动作状态：正在试听 / 正在删除的 songId（行 hover 动作的高亮与禁噪）
  const [previewId, setPreviewId] = useState('')
  const [deletingId, setDeletingId] = useState('')
  const refresh = useCallback(() => setReloadToken(value => value + 1), [])

  useEffect(() => {
    if (!active || !loggedIn) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetchCloudList(controller.signal)
      .then(next => {
        if (controller.signal.aborted) return
        setResult(next)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return
        setResult({ songs: [] })
        setError(err instanceof Error ? err.message : '云盘列表加载失败')
        setLoading(false)
      })
    return () => controller.abort()
  }, [active, loggedIn, authRevision, reloadToken])

  const songs = result.songs
  // 云盘歌曲数通常不多，搜索直接在前端过滤（不打接口）
  const filteredSongs = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase()
    if (!trimmed) return songs
    return songs.filter(song =>
      song.name.toLowerCase().includes(trimmed)
      || (song.artists || []).some(artist => (artist.name || '').toLowerCase().includes(trimmed))
      || (song.album?.name || '').toLowerCase().includes(trimmed))
  }, [songs, keyword])
  const playAll = useCallback(() => {
    if (!songs.length) return
    actions.onPlaySongs(songs[0], songs, 0)
  }, [songs, actions])

  // 面板卸载时停掉试听：直链属于页面内的临时播放，不进全局播放器
  useEffect(() => () => stopCloudPreview(), [])
  // 页面被隐藏（用户切走页面/切平台，TraditionalView 对历史页只是 display:none 保活）时也要停：
  // 模块级 Audio 不在 DOM 里，visibility 管不住它，否则会一直压过全局播放器
  useEffect(() => {
    if (!active) {
      stopCloudPreview()
      setPreviewId('')
    }
  }, [active])

  /** 云盘试听：云盘专属文件不在公共曲库，正式播放链路常常取不到流，这里直接放云盘直链。 */
  const handlePreview = useCallback(async (song: CloudSong) => {
    const id = String(song.id)
    if (previewId === id) {
      // 正在试听同一首：再点一次就是停止
      stopCloudPreview()
      setPreviewId('')
      return
    }
    setPreviewId(id)
    try {
      const started = await playCloudPreview(song.id, () => setPreviewId(''))
      if (started) {
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `正在试听云盘文件「${song.name}」`, type: 'info' } }))
      }
    } catch (err: unknown) {
      // 只有还停在当前这首时才清高亮（期间可能已切到别的曲目）
      setPreviewId(prev => (prev === id ? '' : prev))
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: err instanceof Error ? err.message : '云盘试听失败', type: 'error' } }))
    }
  }, [previewId])

  /** 从云盘删除：确认 → 删除 → 停掉对应试听 → 刷新列表（toast 反馈结果）。 */
  const handleDelete = useCallback(async (song: CloudSong) => {
    const id = String(song.id)
    // 同一首歌删除在途时直接吞掉再次点击：confirm + POST 都不能重复提交
    if (deletingId === id) return
    if (!window.confirm(`确定从云盘删除「${song.name}」吗？删除后需要重新上传。`)) return
    setDeletingId(id)
    try {
      await deleteCloudSong(song.id)
      cloudUrlCache.delete(id)
      if (previewId === id) {
        // 文件已删：正在试听的话立刻停掉（地址已失效）
        stopCloudPreview()
        setPreviewId('')
      }
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已从云盘删除「${song.name}」`, type: 'success' } }))
      refresh()
    } catch (err: unknown) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: err instanceof Error ? err.message : '云盘删除失败', type: 'error' } }))
    } finally {
      setDeletingId('')
    }
  }, [deletingId, previewId, refresh])

  if (!loggedIn) {
    return (
      <div className="pb-8">
        <PcPageTitle theme={theme} title="我的音乐云盘" subtitle="登录后查看已上传的音乐" />
        <LoginEmpty theme={theme} accent={accent} title="登录后查看我的音乐云盘" description="云盘容量与已上传歌曲来自网易云音乐账号" onLogin={() => actions.onLogin?.()} />
      </div>
    )
  }

  const hasCapacity = Boolean(result.totalMb)

  return (
    <div className="pb-8">
      {/* 官方是「已上传单曲 / 正在上传」两页签；本版本没有上传链路，只保留已上传单曲 */}
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className={`text-[24px] font-semibold ${theme.text}`}>已上传单曲{songs.length ? <span className={`ml-2 text-[13px] font-normal ${theme.subtle}`}>{songs.length}</span> : null}</h1>
        <PcTableSearch value={keyword} onChange={setKeyword} theme={theme} accent={accent} placeholder="搜索" />
      </div>

      {tab === 'uploaded' && (
        <>
          {/* 容量条：接口给容量才显示；拿不到就只说明文件数（不编造容量） */}
          <div className="mb-4 flex items-center gap-3">
            <span className={`shrink-0 text-[12px] ${theme.subtle}`}>网盘容量</span>
            {hasCapacity ? (
              <>
                <span className={`h-1.5 w-[220px] overflow-hidden rounded-full ${theme.surface}`}>
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${Math.min(100, Math.max(0, ((result.usedMb || 0) / (result.totalMb || 1)) * 100))}%`, background: accent }}
                  />
                </span>
                <span className={`shrink-0 text-[12px] ${theme.faint}`}>{formatCapacity(result.usedMb)}/{formatCapacity(result.totalMb)}</span>
              </>
            ) : (
              <span className={`text-[12px] ${theme.faint}`}>{loading ? '正在读取云盘…' : `已上传 ${songs.length} 首`}</span>
            )}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <PcPrimaryButton label="播放全部" accent={accent} onClick={playAll} disabled={!songs.length} />
            {/* 上传与本软件无关（无上传链路）：整体不渲染，避免留下点了只弹提示的假入口 */}
          </div>

          {error && !songs.length ? (
            <RetryEmpty theme={theme} title="云盘列表加载失败" description={error} onRetry={refresh} retrying={loading} />
          ) : (
            <PcSongTable
              songs={filteredSongs}
              skin={chrome.skin}
              theme={theme}
              accent={accent}
              loading={loading && !songs.length}
              columns={{ index: true, like: false, album: true, duration: true, size: true }}
              playingKey={actions.currentSongKey}
              isPlaying={actions.isPlaying}
              onPlay={(song, index) => actions.onPlaySongs(song, filteredSongs, index)}
              onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: filteredSongs }) }}
              rowActions={song => (
                <>
                  <PcRowAction theme={theme} title={previewId === String(song.id) ? '停止试听' : '云盘试听'} onClick={() => void handlePreview(song)}>
                    <Headphones className="h-3 w-3" />
                  </PcRowAction>
                  <PcRowAction theme={theme} title={deletingId === String(song.id) ? '删除中…' : '从云盘删除'} onClick={() => void handleDelete(song)}>
                    <Trash2 className={`h-3 w-3 ${deletingId === String(song.id) ? 'animate-pulse' : ''}`} />
                  </PcRowAction>
                </>
              )}
              empty={(
                <PcEmpty
                  theme={theme}
                  title={keyword.trim() ? '没有匹配的歌曲' : '空空如也'}
                  description={keyword.trim() ? `云盘里没有包含「${keyword.trim()}」的歌曲` : '还没有上传过音乐，云盘支持上传本地歌曲'}
                  /* 官方空态有「添加音乐」：上传链路未接入，不放点了没反应的入口 */
                />
              )}
            />
          )}
        </>
      )}

    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 分发
 * ------------------------------------------------------------------ */

function NeteasePcCollection({ kind, ...rest }: NeteasePcCollectionProps) {
  if (kind === 'liked') return <LikedPanel {...rest} />
  if (kind === 'recent') return <RecentPanel {...rest} />
  if (kind === 'mypodcast') return <MyPodcastPanel {...rest} />
  if (kind === 'collect') return <CollectPanel {...rest} />
  return <CloudPanel {...rest} />
}

export default memo(NeteasePcCollection)
