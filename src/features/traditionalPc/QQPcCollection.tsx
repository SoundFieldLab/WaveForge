// QQ 音乐 PC 客户端「喜欢 / 最近播放」列表页集合。
//
// 两个页面共用同一套骨架：大标题 → 下划线页签（带真实计数）→ 播放操作条 + 右端搜索
// → 歌曲表格或封面网格（最近播放多一列「播放时间」）。所以用组件 + kind 收敛，避免两份页面样式漂移。
//
// 数据诚实性：「视频」= 收藏的 MV（music.musicasset.MVFavRead.getMyFavMV，2026-10-07 接入真实数据，
// 与客户端 喜欢→视频 同一数据源）；「有声节目」与本地扫描/下载/已购/试听记录依旧无公开数据源
// （对应页面按官方结构如实空态，见 QQPcExtras.tsx），绝不伪造数据。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Search } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { getQQSubscribedAlbums } from '../../services/musicApi'
import { fetchExplorePlaylist } from '../../services/exploreApi'
import { loadFavoriteIdentifiers } from '../../services/favoriteStatusService'
import { getUserPlaylists } from '../../services/playlistService'
import { getPlatformCookie } from '../../services/platforms'
import { getApiBase } from '../../services/apiConfig'
import {
  PcCardGrid, PcCover, PcEmpty, PcIconButton, PcListFooter, PcPageTitle, PcPrimaryButton, PcSongTable,
  PcTabs, pcSongKey, pcTheme, type PcSkin, type PcTabItem, type PcTone,
} from './pcKit'
import type { PcActions, PcAccount } from './types'

export type QQPcCollectionKind = 'liked' | 'recent'

export interface QQPcCollectionProps {
  kind: QQPcCollectionKind
  /** 皮肤与强调色（skin 用宽类型接父层的 chrome，页面本身只渲染 QQ 形态） */
  chrome: { tone: PcTone; skin: PcSkin; accent: string }
  account: PcAccount
  actions: PcActions
  /** 登录态变化时用来触发重取 */
  authRevision?: number
  /** 页面是否可见（隐藏保活页为 false，用于跳过请求） */
  active?: boolean
  /** 把喜欢的歌曲键集合回传父层（键口径 = pcSongKey） */
  onLikedChange?: (keys: Set<string>) => void
}

/** 带客户端扩展字段的歌曲（播放时间/文件大小由页面侧补，pcKit 表格按可选字段读取）。 */
type CollectionSong = Song & { playedAt?: number; fileSize?: number }

const PAGE_TITLES: Record<QQPcCollectionKind, string> = {
  liked: '喜欢',
  recent: '最近播放',
}

const TAB_DEFS: Record<QQPcCollectionKind, PcTabItem[]> = {
  // 官方喜欢页页签（客户端实测）：歌曲 / 歌单 / 专辑 / 有声节目 / 视频。
  liked: [
    { key: 'songs', label: '歌曲' },
    { key: 'playlists', label: '歌单' },
    { key: 'albums', label: '专辑' },
    { key: 'podcasts', label: '有声节目' },
    { key: 'mvs', label: '视频' },
  ],
  recent: [{ key: 'songs', label: '歌曲' }],
}

/** 操作条只在有歌曲的列表页出现 */
const TOOLBAR_KINDS: QQPcCollectionKind[] = ['liked', 'recent']

/** 本会话缓存：切走再回来不该重打一遍接口（与 TraditionalView 的最近播放缓存同款做法）。 */
const likedCollectionCache = new Map<string, { songs: CollectionSong[]; playlists: any[] }>()
const recentSongsCache = new Map<string, CollectionSong[]>()
const collectedAlbumsCache = new Map<string, any[]>()
/** 收藏 MV（喜欢→视频 页签）；条目结构与 /api/qq/fav/mv 返回一致。 */
const likedMvsCache = new Map<string, Array<{ vid: string; name: string; singer: string; coverUrl: string; duration: number; playCount: number }>>()

const FALLBACK_ACTIONS: PcActions = {
  onPlaySongs: () => {},
  onSongMenu: () => {},
  onOpenPlaylist: () => {},
  onNavigate: () => {},
}

/** 最近播放时间：网关把记录时间放在记录行上，秒/毫秒两种形态都要归一成毫秒。 */
function normalizePlayedAt(value: unknown): number {
  const raw = Number(value || 0)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  // 小于 1e11 只可能是「秒」（1e11 秒 ≈ 公元 5138 年，1e11 毫秒 = 1973 年）
  return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw)
}

/** 收藏专辑列表字段在各版本网关里命名不一，这里做一次宽容映射。 */
function mapCollectedAlbum(album: any, index: number) {
  const mid = String(album?.albumMid || album?.album_mid || album?.mid || album?.MID || album?.album?.mid || '')
  const id = album?.albumId || album?.album_id || album?.id || album?.ID
  const name = album?.albumName || album?.albumname || album?.name || album?.album?.name || '未知专辑'
  return {
    key: `album:${mid || id || name}:${index}`,
    albumId: mid || (id !== undefined && id !== null ? String(id) : ''),
    coverUrl: album?.albumPic || album?.picUrl || album?.pic || album?.cover || album?.album?.picUrl || '',
    title: name,
    subtitle: album?.singerName || album?.singername || album?.artist?.name || album?.singer?.[0]?.name || '',
  }
}

function QQPcCollection({
  kind, chrome, account, actions, authRevision = 0, active = true, onLikedChange,
}: QQPcCollectionProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const act = actions || FALLBACK_ACTIONS
  const loggedIn = Boolean(account?.loggedIn)
  const userId = account?.userId || ''

  const tabDefs = TAB_DEFS[kind]
  const [tab, setTab] = useState(tabDefs[0]?.key || 'songs')
  const [songs, setSongs] = useState<CollectionSong[]>([])
  const [playlists, setPlaylists] = useState<any[]>([])
  const [albums, setAlbums] = useState<any[]>([])
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [albumsState, setAlbumsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  /** 喜欢→视频 页签：收藏的 MV（官方同源模块 MVFavRead.getMyFavMV）。 */
  const [mvs, setMvs] = useState<Array<{ vid: string; name: string; singer: string; coverUrl: string; duration: number; playCount: number }>>([])
  const [mvsState, setMvsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const requestRef = useRef(0)
  const albumsRequestRef = useRef('')
  const mvsRequestRef = useRef('')
  // 回调放 ref：父层传内联箭头函数时，不会因为依赖变化把 effect 打成死循环
  const likedChangeRef = useRef(onLikedChange)
  useEffect(() => { likedChangeRef.current = onLikedChange }, [onLikedChange])

  // kind 变化时页签回到第一项（同一实例被复用到别的页面时不会停在失效页签）
  useEffect(() => { setTab(TAB_DEFS[kind][0]?.key || 'songs') }, [kind])

  const likedCacheKey = `liked:${userId}:${authRevision}`
  const recentCacheKey = `recent:${userId}:${authRevision}`
  const albumsCacheKey = `albums:${userId}:${authRevision}`
  const mvsCacheKey = `liked-mvs:${userId}:${authRevision}`

  /**
   * 把「喜欢标识 → 歌曲键」回传父层（红心列口径）。
   * 标识走 favoriteStatusService 的共享缓存：全局红心状态已经拉过就不会重复请求。
   * markAllWhenNoIds：喜欢页专用兜底——接口没返回任何标识时，歌单里的曲目本身就是喜欢的。
   */
  const emitLikedKeys = useCallback(async (list: CollectionSong[], markAllWhenNoIds: boolean) => {
    if (!userId) return
    const ids = await loadFavoriteIdentifiers('qq', userId).catch(() => new Set<string>())
    const usable = ids instanceof Set ? ids : new Set<string>()
    setFavoriteIds(usable)
    const keys = new Set<string>()
    for (const song of list) {
      const matched = (markAllWhenNoIds && usable.size === 0)
        || usable.has(String(song.id))
        || (song.mid ? usable.has(String(song.mid)) : false)
      if (matched) keys.add(pcSongKey(song))
    }
    likedChangeRef.current?.(keys)
  }, [userId])

  /* ── 喜欢页：我喜欢歌单曲目（本会话缓存，登录态变化即失效） ── */
  useEffect(() => {
    if (!active || kind !== 'liked') return
    if (!loggedIn || !userId) {
      setSongs([])
      setPlaylists([])
      setAlbums([])
      setError('')
      setLoading(false)
      likedChangeRef.current?.(new Set())
      return
    }
    const cached = likedCollectionCache.get(likedCacheKey)
    if (cached) {
      setSongs(cached.songs)
      setPlaylists(cached.playlists)
      setLoading(false)
      setError('')
      void emitLikedKeys(cached.songs, true)
      return
    }
    const requestId = ++requestRef.current
    let cancelled = false
    setLoading(true)
    setError('')
    void (async () => {
      let loaded: CollectionSong[] = []
      let others: any[] = []
      try {
        // 官方「我喜欢」是一个系统歌单：列表接口只给 ids/mids，曲目得走歌单详情
        // （探索网关返回归一化 Song，含封面与毫秒时长）
        const rawLists = await getUserPlaylists('qq', userId).catch(() => [] as any[])
        const lists = Array.isArray(rawLists) ? rawLists : []
        const likedPlaylist = lists.find((item: any) => item?.isLike)
        // 「歌单」页签 = 收藏的歌单（客户端这个页签就是收藏夹口径，实测数量也对得上：
        // 客户端 58 = 我们的 (自建 21 + 收藏 58) - 自建 21；自建歌单归左栏「自建歌单」列表）
        others = lists.filter((item: any) => item !== likedPlaylist && (item?.isCollected || item?.subscribed))
        if (likedPlaylist) {
          const detail = await fetchExplorePlaylist({
            id: String(likedPlaylist.id || likedPlaylist.dirId || ''),
            name: likedPlaylist.name || '我喜欢',
            coverUrl: likedPlaylist.coverImgUrl || likedPlaylist.coverUrl || '',
            trackCount: Number(likedPlaylist.trackCount || 0),
            platform: 'qq',
          })
          loaded = (Array.isArray(detail?.songs) ? detail.songs : []).filter(Boolean) as CollectionSong[]
        }
      } catch (loadError) {
        if (cancelled || requestId !== requestRef.current) return
        setSongs([])
        setPlaylists([])
        setLoading(false)
        setError(loadError instanceof Error ? loadError.message : '我喜欢加载失败')
        return
      }
      if (cancelled || requestId !== requestRef.current) return
      likedCollectionCache.set(likedCacheKey, { songs: loaded, playlists: others })
      setSongs(loaded)
      setPlaylists(others)
      setLoading(false)
      setError('')
      void emitLikedKeys(loaded, true)
    })()
    return () => { cancelled = true }
  }, [active, kind, loggedIn, userId, likedCacheKey, emitLikedKeys])

  /* ── 最近播放：与 TraditionalView 的 TraditionalRecent 同源同映射 ── */
  useEffect(() => {
    if (!active || kind !== 'recent') return
    if (!loggedIn) {
      setSongs([])
      setError('')
      setLoading(false)
      return
    }
    const cached = recentSongsCache.get(recentCacheKey)
    if (cached) {
      setSongs(cached)
      setLoading(false)
      setError('')
      void emitLikedKeys(cached, false)
      return
    }
    const requestId = ++requestRef.current
    let cancelled = false
    setLoading(true)
    setError('')
    const cookie = getPlatformCookie('qq')
    const endpoint = `${getApiBase()}/qq/record/recent/song?limit=100${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`
    fetch(endpoint, { cache: 'no-store' })
      .then(response => response.json().catch(() => null).then(payload => ({ response, payload })))
      .then(({ response, payload }) => {
        if (cancelled || requestId !== requestRef.current) return
        if (!response.ok || payload?.error) throw new Error(payload?.error || '最近播放加载失败')
        const rows = Array.isArray(payload?.records)
          ? payload.records
          : (Array.isArray(payload?.songlist) ? payload.songlist.map((song: any) => ({ song })) : [])
        const list = rows.map((row: any, index: number): CollectionSong | null => {
          const song = row?.song || row
          if (!song?.name) return null
          const artists = Array.isArray(song?.artists) ? song.artists : (Array.isArray(song?.singer) ? song.singer : [])
          return {
            id: Number(song?.id ?? index) || index,
            mid: String(song?.mid || ''),
            name: song.name,
            artists: artists.map((artist: any) => ({ id: artist?.id, name: artist?.name || '', mid: artist?.mid })),
            album: { name: song?.album?.name || '', picUrl: String(song?.album?.picUrl || song?.albumpic || song?.picUrl || '') },
            duration: Number(song?.duration || song?.interval || 0) * (song?.interval ? 1000 : 1),
            platform: 'qq' as const,
            // 记录行上的播放时间（网关字段名有几种），归一成毫秒给「播放时间」列
            playedAt: normalizePlayedAt(row?.playTime ?? row?.lastTime ?? row?.updateTime ?? row?.listenTime),
            vip: Boolean(song?.vip || song?.pay?.payplay === 1),
            noCopyright: Boolean(song?.noCopyright),
            songType: Number(song?.songType) || undefined,
          } as CollectionSong
        }).filter((item: CollectionSong | null): item is CollectionSong => Boolean(item))
        recentSongsCache.set(recentCacheKey, list)
        setSongs(list)
        setLoading(false)
        setError('')
        void emitLikedKeys(list, false)
      })
      .catch((loadError: unknown) => {
        if (cancelled || requestId !== requestRef.current) return
        setSongs([])
        setLoading(false)
        setError(loadError instanceof Error ? loadError.message : '最近播放加载失败')
      })
    return () => { cancelled = true }
  }, [active, kind, loggedIn, userId, recentCacheKey, emitLikedKeys])

  /* ── 收藏专辑页签：懒加载（只在该页签被打开时请求） ── */
  useEffect(() => {
    if (!active || kind !== 'liked' || tab !== 'albums') return
    if (!loggedIn) { setAlbums([]); setAlbumsState('ready'); return }
    const cached = collectedAlbumsCache.get(albumsCacheKey)
    if (cached) { setAlbums(cached); setAlbumsState('ready'); return }
    if (albumsRequestRef.current === albumsCacheKey) return
    albumsRequestRef.current = albumsCacheKey
    let cancelled = false
    setAlbumsState('loading')
    void getQQSubscribedAlbums().then(data => {
      if (cancelled) return
      const list = Array.isArray(data?.data?.list) ? data.data.list : (Array.isArray(data?.data) ? data.data : [])
      collectedAlbumsCache.set(albumsCacheKey, list)
      setAlbums(list)
      setAlbumsState('ready')
    }).catch(() => {
      if (cancelled) return
      // 失败不留请求锁：切走再回来允许重试
      albumsRequestRef.current = ''
      setAlbums([])
      setAlbumsState('error')
    })
    return () => { cancelled = true }
  }, [active, kind, tab, loggedIn, albumsCacheKey])

  /* ── 收藏 MV（喜欢→视频 页签）：官方同源模块，进入页签才请求，本会话缓存 ── */
  useEffect(() => {
    if (!active || kind !== 'liked' || tab !== 'mvs' || !loggedIn) return
    const cached = likedMvsCache.get(mvsCacheKey)
    if (cached) {
      setMvs(cached)
      setMvsState('ready')
      return
    }
    if (mvsRequestRef.current === mvsCacheKey) return
    mvsRequestRef.current = mvsCacheKey
    let cancelled = false
    setMvsState('loading')
    const cookie = getPlatformCookie('qq')
    fetch(`${getApiBase()}/qq/fav/mv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie }),
      cache: 'no-store',
    })
      .then(response => response.json().catch(() => null))
      .then(payload => {
        if (cancelled) return
        const list = Array.isArray(payload?.list) ? payload.list : []
        likedMvsCache.set(mvsCacheKey, list)
        setMvs(list)
        setMvsState('ready')
      })
      .catch(() => {
        if (cancelled) return
        // 失败不留请求锁：切走再回来允许重试
        mvsRequestRef.current = ''
        setMvs([])
        setMvsState('error')
      })
    return () => { cancelled = true }
  }, [active, kind, tab, loggedIn, mvsCacheKey])

  /* ── 表格数据与回调 ── */

  // 本地算出的喜欢键 + 父层 likedKeys：喜欢页的红心必须与自己的列表一致
  const likedKeys = useMemo(() => {
    const merged = new Set<string>(act.likedKeys || [])
    const usable = favoriteIds
    if (usable.size || kind === 'liked') {
      for (const song of songs) {
        const matched = (kind === 'liked' && usable.size === 0)
          || usable.has(String(song.id))
          || (song.mid ? usable.has(String(song.mid)) : false)
        if (matched) merged.add(pcSongKey(song))
      }
    }
    return merged
  }, [act.likedKeys, favoriteIds, kind, songs])

  const tabCounts = useMemo<Record<string, number | undefined>>(() => {
    if (kind === 'liked') {
      return {
        songs: songs.length || undefined,
        playlists: playlists.length || undefined,
        albums: albums.length || undefined,
        // 官方喜欢页「有声节目0」照实显示 0（该通道无数据源，恒空态）
        podcasts: 0,
        mvs: mvs.length || undefined,
      }
    }
    if (kind === 'recent') return { songs: songs.length || undefined }
    return {}
  }, [kind, songs.length, playlists.length, albums.length, mvs.length])

  const tabs = useMemo(() => tabDefs.map(item => {
    const count = tabCounts[item.key]
    return typeof count === 'number' ? { ...item, count } : item
  }), [tabDefs, tabCounts])

  const playableSongs = tab === 'songs' ? songs : []
  const playAll = useCallback(() => {
    if (playableSongs.length) act.onPlaySongs(playableSongs[0], playableSongs, 0)
  }, [act, playableSongs])

  const columns = useMemo(() => ({
    index: true,
    like: true,
    album: true,
    duration: true,
    playedAt: kind === 'recent',
  }), [kind])

  const loginEmpty = (
    <PcEmpty
      theme={theme}
      title={kind === 'recent' ? '登录后同步最近播放记录' : '登录后查看我喜欢的音乐'}
      description="登录 QQ 音乐后即可查看云端数据"
      action={act.onLogin ? <PcPrimaryButton label="立即登录" onClick={act.onLogin} accent={accent} /> : undefined}
    />
  )
  const songEmpty = (
    <PcEmpty
      theme={theme}
      title={kind === 'recent' ? '暂无最近播放记录' : '暂无喜欢的歌曲'}
      description={error || (kind === 'recent' ? '客户端播放过的歌曲会同步到这里' : '在歌曲上点红心就会出现在这里')}
    />
  )

  // 表格直接吃原始 Song（时长已是毫秒，pcKit 的时长列自己负责格式化）
  const songTable = (
    <PcSongTable
      songs={songs}
      skin="qq"
      theme={theme}
      accent={accent}
      columns={columns}
      loading={loading && !songs.length}
      playingKey={act.currentSongKey}
      isPlaying={act.isPlaying}
      likedKeys={likedKeys}
      empty={songEmpty}
      onPlay={(song, index) => act.onPlaySongs(song, songs, index)}
      onMenu={(event, song) => {
        event.preventDefault()
        act.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs })
      }}
      onToggleLike={(song, next) => act.onToggleLike?.(song, next)}
    />
  )

  return (
    <div className="pb-8">
      <PcPageTitle title={PAGE_TITLES[kind]} theme={theme} />

      {tabs.length ? (
        <div className={`mb-4 border-b ${theme.divider}`}>
          <PcTabs items={tabs} value={tab} onChange={setTab} accent={accent} theme={theme} />
        </div>
      ) : null}

      {TOOLBAR_KINDS.includes(kind) && (
        <div className="mb-4 flex items-center gap-2">
          <PcPrimaryButton label="播放" accent={accent} disabled={!playableSongs.length} onClick={playAll} />
          {/* 下载/批量在本版本没有链路：整体不渲染，避免留下点了没反应的按钮 */}
          <div className="ml-auto flex items-center gap-1">
            <PcIconButton theme={theme} title="搜索" onClick={() => act.onNavigate({ kind: 'qq', page: 'search' })}>
              <Search className="h-4 w-4" />
            </PcIconButton>
          </div>
        </div>
      )}

      {/* ── 内容区：任何分支都只是「表格 or 空态」，接口失败也只降级成空态 ── */}

      {kind === 'liked' && tab === 'songs' && (!loggedIn ? loginEmpty : songTable)}

      {kind === 'liked' && tab === 'playlists' && (
        !loggedIn ? loginEmpty : (
          playlists.length ? (
            <PcCardGrid
              items={playlists.map((playlist: any) => ({
                key: `qq:${playlist.id || playlist.dirId || playlist.name}`,
                coverUrl: playlist.coverImgUrl || playlist.coverUrl,
                title: playlist.name || '歌单',
                subtitle: playlist.trackCount ? `${playlist.trackCount} 首` : undefined,
                playCount: playlist.playCount,
                onClick: () => act.onOpenPlaylist(playlist),
                onContextMenu: (event: ReactMouseEvent) => {
                  event.preventDefault()
                  act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist })
                },
              }))}
              theme={theme}
              accent={accent}
              columns={6}
            />
          ) : <PcEmpty theme={theme} title="暂无歌单" description="创建或收藏的歌单会出现在这里" />
        )
      )}

      {kind === 'liked' && tab === 'albums' && (
        !loggedIn ? loginEmpty : (
          albumsState === 'loading' ? (
            <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>
          ) : albums.length ? (
            <PcCardGrid
              items={albums.map(mapCollectedAlbum).map(item => ({
                key: item.key,
                coverUrl: item.coverUrl,
                title: item.title,
                subtitle: item.subtitle,
                onClick: () => { if (item.albumId) act.onOpenAlbum?.(item.albumId, 'qq') },
              }))}
              theme={theme}
              accent={accent}
              columns={6}
              showPlayOnHover={false}
            />
          ) : (
            <PcEmpty
              theme={theme}
              title="暂无收藏专辑"
              description={albumsState === 'error' ? '收藏专辑加载失败，稍后重试' : '在专辑页点收藏后会出现在这里'}
            />
          )
        )
      )}

      {kind === 'liked' && tab === 'mvs' && (
        !loggedIn ? loginEmpty : (
          mvsState === 'loading' ? (
            <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>
          ) : mvs.length ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {mvs.map(mv => (
                <button
                  key={`mv:${mv.vid}`}
                  type="button"
                  onClick={() => act.onOpenMv?.(mv.vid, 'qq')}
                  className="group min-w-0 text-left"
                  title={mv.name}
                >
                  <PcCover src={mv.coverUrl} alt={mv.name} className="aspect-video w-full" rounded="rounded-lg" />
                  <span className={`mt-2 line-clamp-2 text-[13px] leading-snug ${theme.text}`}>{mv.name}</span>
                  {mv.singer ? <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{mv.singer}</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <PcEmpty
              theme={theme}
              title="暂无收藏视频"
              description={mvsState === 'error' ? '收藏视频加载失败，稍后重试' : '在 MV 页点收藏后会出现在这里'}
            />
          )
        )
      )}

      {/* 有声节目：官方同页签同样是空的（该账号 0 条）；通道无数据源，如实空态 */}
      {kind === 'liked' && tab === 'podcasts' && (
        !loggedIn ? loginEmpty : <PcEmpty theme={theme} title="暂无声节目" description="有声节目收藏暂无可用数据源" />
      )}

      {kind === 'recent' && tab === 'songs' && (
        !loggedIn ? loginEmpty : (
          <>
            {songTable}
            {songs.length ? <PcListFooter theme={theme} label="已同步其他设备播放过的歌曲" /> : null}
          </>
        )
      )}

    </div>
  )
}

export default memo(QQPcCollection)
