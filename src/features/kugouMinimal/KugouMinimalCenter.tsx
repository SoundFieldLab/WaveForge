/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 *
 * 简约模式-酷狗「个人中心」浮层。
 *
 * 为什么单开：简约模式里其它平台的个人中心复用 ProfileView（网易/QQ/Apple/汽水），
 * 酷狗没有对应分支（点「个人中心」只弹「该平台暂不支持查看个人主页」）。这里按同一粒度
 * 给酷狗自己的资料 + 最近播放 + 收藏（我喜欢曲目 / 收藏的歌单），数据全走 kugouService
 * 的概念版通道，不新造接口；听书页签复用 kugouLongaudio 的板块与独立播放器。
 *
 * 平台隔离：组件只在 HomeView 的 kugou 分支挂载，其它平台的渲染路径不受影响。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  BookAudio,
  Cloud,
  Crown,
  Disc3,
  ExternalLink,
  Heart,
  History,
  ListMusic,
  Loader2,
  Music,
  Play,
  RefreshCw,
  User,
  X,
} from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import type { Song } from '../../services/musicApi'
import {
  fetchKugouPlayRecords,
  fetchKugouUserPlaylistTracks,
  fetchKugouUserPlaylists,
  getKugouConceptCredential,
  kugouTrackToSong,
} from '../../services/kugouService'
import KugouLongaudioBoard from '../kugouLongaudio/KugouLongaudioBoard'
// 云盘/已购面板：传统模式同一份组件（数据自加载），这里只注入简约模式的播放回调
import { KugouPurchasedPanel } from '../traditionalPc/KugouPcPersonal'
import { pcTheme } from '../traditionalPc/pcKit'
import { useModeParked } from '../../utils/modeLayer'

const ACCENT = '#FF7A00'

/** 听书板块的 section 钩子：简约模式里没有探索页的区块配置，恒显示、无额外样式 */
const SECTION_STYLE = () => ({})
const SECTION_VISIBLE = () => true

// 「云盘」页签已随下载功能下线一起移除（不做云盘上传/管理）
export type KugouMinimalTab = 'longaudio' | 'recent' | 'liked' | 'playlists' | 'purchased'

export interface KugouMinimalPlaylist {
  id: string
  listid: string
  name: string
  coverImgUrl: string
  trackCount: number
  playCount: number
  platform: 'kugou'
  isMine: boolean
  isLike: boolean
}

export interface KugouMinimalCenterProps {
  open: boolean
  tab: KugouMinimalTab
  onTabChange: (tab: KugouMinimalTab) => void
  onClose: () => void
  loggedIn: boolean
  username?: string
  avatar?: string
  userId?: string
  /** 首页被播放页覆盖（HomeView 的 suspended）：portal 挂在 body 上，CSS 管不到，必须显式让位 */
  suspended?: boolean
  onLoginClick?: () => void
  onPlaySongs: (songs: Song[], index: number) => void
  onOpenPlaylist?: (playlist: KugouMinimalPlaylist) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => boolean | Promise<boolean>
}

interface RecentRow {
  song: Song
  /** 播放次数（上游 pc） */
  playCount: number
  /** 最近一次播放时间（上游 ot，秒） */
  playedAt: number
}

const formatDuration = (seconds?: number): string => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const formatCount = (value?: number): string => {
  const count = Number(value || 0)
  if (!count) return ''
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)}亿`
  if (count >= 10_000) return `${(count / 10_000).toFixed(1)}万`
  return String(count)
}

/** 「我喜欢」是系统默认歌单：上游 listid=2，名字固定为「我喜欢」（与 KugouPcShell 同一判定） */
export const isLikedKugouPlaylist = (playlist: { listid?: string; name?: string }): boolean =>
  playlist.listid === '2' || /我喜欢/.test(playlist.name || '')

const mapPlaylist = (item: { specialid: string; listid?: string; name: string; coverUrl?: string; songcount?: number; playcount?: number; isMine?: boolean }): KugouMinimalPlaylist => ({
  id: item.specialid,
  listid: item.listid || '',
  name: item.name,
  coverImgUrl: item.coverUrl || '',
  trackCount: item.songcount || 0,
  playCount: item.playcount || 0,
  platform: 'kugou',
  isMine: item.isMine === true,
  isLike: isLikedKugouPlaylist(item),
})

const TAB_LABEL: Record<KugouMinimalTab, string> = {
  longaudio: '听书',
  recent: '最近播放',
  liked: '我喜欢',
  playlists: '收藏歌单',
  purchased: '已购',
}

const TAB_ICON: Record<KugouMinimalTab, typeof History> = {
  longaudio: BookAudio,
  recent: History,
  liked: Heart,
  playlists: ListMusic,
  purchased: Disc3,
}

export default function KugouMinimalCenter({
  open,
  tab,
  onTabChange,
  onClose,
  loggedIn,
  username,
  avatar,
  userId,
  suspended = false,
  onLoginClick,
  onPlaySongs,
  onOpenPlaylist,
  onAddToFavorites,
  onRemoveFromFavorites,
}: KugouMinimalCenterProps) {
  const parked = useModeParked()
  const [playlists, setPlaylists] = useState<KugouMinimalPlaylist[]>([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [playlistsError, setPlaylistsError] = useState('')
  const [recentRows, setRecentRows] = useState<RecentRow[]>([])
  const [recentBp, setRecentBp] = useState('')
  const [recentHasMore, setRecentHasMore] = useState(false)
  const [recentLoading, setRecentLoading] = useState(false)
  const [recentLoadingMore, setRecentLoadingMore] = useState(false)
  const [likedSongs, setLikedSongs] = useState<Song[]>([])
  const [likedLoading, setLikedLoading] = useState(false)
  const [likedError, setLikedError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)

  const likedPlaylist = useMemo(() => playlists.find(item => item.isLike) || null, [playlists])
  const collectedPlaylists = useMemo(() => playlists.filter(item => !item.isLike && !item.isMine), [playlists])

  // 资料兜底：App 传入的昵称/头像来自登录回调；概念版凭据里也带着同一份（跨会话恢复时用）
  const credential = useMemo(() => (open ? getKugouConceptCredential() : null), [open])
  const displayName = username || credential?.nickname || '酷狗用户'
  const displayAvatar = avatar || credential?.avatar || ''
  const displayUserId = userId || credential?.userid || ''

  useEffect(() => {
    if (!open || !loggedIn) return
    let cancelled = false
    setPlaylistsLoading(true)
    setPlaylistsError('')
    setLikedLoading(true)
    setLikedError('')
    setRecentLoading(true)
    void (async () => {
      // 歌单列表（自建 + 收藏，含「我喜欢」）与最近播放并行；任一失败不影响另一个页签
      const [listResult, recentResult] = await Promise.allSettled([
        fetchKugouUserPlaylists(),
        fetchKugouPlayRecords(),
      ])
      if (cancelled) return
      const mapped = listResult.status === 'fulfilled' ? listResult.value.map(mapPlaylist) : []
      if (listResult.status === 'rejected') {
        setPlaylistsError(listResult.reason instanceof Error ? listResult.reason.message : '酷狗歌单加载失败')
      }
      setPlaylists(mapped)
      setPlaylistsLoading(false)
      if (recentResult.status === 'fulfilled') {
        setRecentRows(recentResult.value.records.map(record => ({
          song: kugouTrackToSong(record.track),
          playCount: record.pc,
          playedAt: record.ot,
        })))
        setRecentBp(recentResult.value.bp)
        setRecentHasMore(recentResult.value.hasMore)
      }
      setRecentLoading(false)

      const liked = mapped.find(item => item.isLike)
      if (!liked) {
        setLikedSongs([])
        setLikedLoading(false)
        return
      }
      const tracks = await fetchKugouUserPlaylistTracks(liked.id)
      if (cancelled) return
      setLikedSongs(tracks.map(kugouTrackToSong))
      setLikedLoading(false)
    })().catch(error => {
      if (cancelled) return
      setLikedError(error instanceof Error ? error.message : '「我喜欢」加载失败')
      setPlaylistsLoading(false)
      setRecentLoading(false)
      setLikedLoading(false)
    })
    return () => { cancelled = true }
  }, [open, loggedIn, reloadToken])

  useEffect(() => {
    if (!open || parked) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, parked, onClose])

  const loadMoreRecent = useCallback(async () => {
    if (recentLoadingMore || !recentHasMore || !recentBp) return
    setRecentLoadingMore(true)
    try {
      const result = await fetchKugouPlayRecords(recentBp)
      setRecentRows(previous => {
        const seen = new Set(previous.map(row => row.song.mid || String(row.song.id)))
        return [
          ...previous,
          ...result.records
            .map(record => ({ song: kugouTrackToSong(record.track), playCount: record.pc, playedAt: record.ot }))
            .filter(row => !seen.has(row.song.mid || String(row.song.id))),
        ]
      })
      setRecentBp(result.bp)
      setRecentHasMore(result.hasMore)
    } finally {
      setRecentLoadingMore(false)
    }
  }, [recentLoadingMore, recentHasMore, recentBp])

  const toggleLike = useCallback(async (song: Song) => {
    const key = song.mid || String(song.id)
    const liked = likedSongs.some(item => (item.mid || String(item.id)) === key)
    // 没有对应回调时只读展示：本地乐观更新会显示成假成功
    if (liked) {
      if (!onRemoveFromFavorites) return
      const removed = await onRemoveFromFavorites(song)
      if (removed === false) return
      setLikedSongs(previous => previous.filter(item => (item.mid || String(item.id)) !== key))
    } else {
      if (!onAddToFavorites) return
      onAddToFavorites(song)
      setLikedSongs(previous => [song, ...previous])
    }
  }, [likedSongs, onAddToFavorites, onRemoveFromFavorites])

  if (!open || parked || suspended) return null

  const recentSongs = recentRows.map(row => row.song)
  const openTabLabel = TAB_LABEL[tab]

  const renderSongList = (
    songs: Song[],
    options: { loading: boolean; emptyTitle: string; emptyHint: string; playCounts?: Map<string, number> },
  ) => {
    if (options.loading && songs.length === 0) {
      return (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-white/45">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在加载{openTabLabel}…
        </div>
      )
    }
    if (songs.length === 0) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[22px] border border-white/[0.07] bg-white/[0.03] px-6 py-16 text-center">
          <Music className="h-7 w-7 text-white/22" />
          <p className="text-sm font-medium text-white/70">{options.emptyTitle}</p>
          <p className="max-w-md text-xs text-white/38">{options.emptyHint}</p>
        </div>
      )
    }
    const likedKeys = new Set(likedSongs.map(item => item.mid || String(item.id)))
    return (
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onPlaySongs(songs, 0)}
            className="flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold text-[#081017] transition hover:brightness-110"
            style={{ background: ACCENT }}
          >
            <Play className="h-3.5 w-3.5 fill-current" /> 播放全部
          </button>
          <span className="text-xs text-white/36">共 {songs.length} 首</span>
        </div>
        {songs.map((song, index) => {
          const key = song.mid || String(song.id)
          const liked = likedKeys.has(key)
          const playCount = options.playCounts?.get(key)
          return (
            <div
              key={`${key}-${index}`}
              className="group flex items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-white/[0.05]"
            >
              <button
                type="button"
                onClick={() => onPlaySongs(songs, index)}
                className="flex w-6 shrink-0 items-center justify-center text-xs text-white/35 transition group-hover:text-white"
                aria-label={`播放 ${song.name}`}
              >
                <Play className="h-3.5 w-3.5 fill-current" />
              </button>
              <CachedImage
                src={song.album?.picUrl || ''}
                alt={song.name}
                className="h-10 w-10 shrink-0 rounded-lg object-cover"
                role="compact"
                size={64}
                priority="visible"
                lazy
                platform="kugou"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-white/86">{song.name}</p>
                <p className="mt-0.5 truncate text-xs text-white/38">{song.artists?.map(artist => artist.name).filter(Boolean).join(' / ') || '未知歌手'}</p>
              </div>
              {playCount ? <span className="hidden w-[86px] shrink-0 text-right text-xs text-white/32 md:block">听过{playCount}次</span> : null}
              <span className="w-[52px] shrink-0 text-right text-xs tabular-nums text-white/32">{formatDuration((song.duration || 0) / 1000)}</span>
              <button
                type="button"
                onClick={() => void toggleLike(song)}
                aria-label={liked ? `取消喜欢 ${song.name}` : `喜欢 ${song.name}`}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition hover:bg-white/[0.08]"
              >
                <Heart
                  className={`h-3.5 w-3.5 ${liked ? '' : 'text-white/32'}`}
                  style={liked ? { color: ACCENT, fill: ACCENT } : undefined}
                />
              </button>
            </div>
          )
        })}
      </div>
    )
  }

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[128] flex flex-col bg-[#0a0c11]/97 text-white backdrop-blur-2xl"
      data-kugou-minimal-center=""
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.07] px-5 py-3.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `linear-gradient(135deg, ${ACCENT}, rgba(255,122,0,0.55))` }}>
          <User className="h-5 w-5 text-[#081017]" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold">个人中心</h1>
            <span className="rounded-full border border-white/[0.1] bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/45">酷狗音乐</span>
          </div>
          <p className="truncate text-xs text-white/40">
            {loggedIn ? '资料 / 最近播放 / 我喜欢 / 收藏歌单 / 云盘 / 已购（概念版通道）' : '登录后同步酷狗账号数据'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setReloadToken(token => token + 1)}
            disabled={!loggedIn}
            className="flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 text-xs text-white/62 transition hover:bg-white/[0.1] hover:text-white disabled:opacity-40"
            aria-label="刷新酷狗个人中心"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${playlistsLoading ? 'animate-spin' : ''}`} /> 刷新
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.05] text-white/60 transition hover:bg-white/[0.12] hover:text-white"
            aria-label="关闭个人中心"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {!loggedIn ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <User className="h-8 w-8 text-white/22" />
          <p className="text-sm font-medium text-white/70">登录后查看酷狗个人中心</p>
          <p className="max-w-md text-xs leading-relaxed text-white/38">资料、最近播放与收藏都来自酷狗概念版账号，登录（扫码）后即可同步。</p>
          <button
            type="button"
            onClick={onLoginClick}
            className="mt-1 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold text-[#081017] transition hover:brightness-110"
            style={{ background: ACCENT }}
          >
            <ExternalLink className="h-3.5 w-3.5" /> 酷狗音乐登录
          </button>
        </div>
      ) : (
        <>
          {/* 资料卡：昵称/头像/ID + 三个收藏统计（与页签内容同源，不额外请求） */}
          <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-white/[0.07] px-5 py-4">
            <div className="h-14 w-14 overflow-hidden rounded-full border border-white/[0.12] bg-white/[0.05]">
              {displayAvatar ? (
                <CachedImage src={displayAvatar} alt={displayName} className="h-full w-full object-cover" role="compact" size={128} priority="visible" />
              ) : (
                <div className="flex h-full w-full items-center justify-center"><Music className="h-6 w-6 text-white/22" /></div>
              )}
            </div>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-base font-semibold text-white/90">
                {displayName}
                <Crown className="h-4 w-4 text-white/20" />
              </p>
              <p className="mt-0.5 truncate text-xs text-white/38">酷狗ID: {displayUserId || '—'}</p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-white/45">
              <span>最近播放 {recentRows.length} 首</span>
              <span>我喜欢 {likedSongs.length} 首</span>
              <span>收藏歌单 {collectedPlaylists.length} 个</span>
            </div>
          </div>

          {/* 页签：听书（复用 kugouLongaudio 板块与独立播放器）/ 最近播放 / 我喜欢 / 收藏歌单 */}
          <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-white/[0.07] px-5 py-3">
            {(Object.keys(TAB_LABEL) as KugouMinimalTab[]).map(key => {
              const Icon = TAB_ICON[key]
              const active = key === tab
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onTabChange(key)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs transition ${active ? 'font-semibold text-[#081017]' : 'border border-white/[0.1] bg-white/[0.05] text-white/62 hover:bg-white/[0.1] hover:text-white'}`}
                  style={active ? { background: ACCENT } : undefined}
                >
                  <Icon className="h-3.5 w-3.5" /> {TAB_LABEL[key]}
                </button>
              )
            })}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-4">
            {tab === 'longaudio' ? (
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                {/* 听书板块自带「进入听书 / 我的听书」入口，点卡片直接打开独立播放器 */}
                <KugouLongaudioBoard
                  accent={ACCENT}
                  compactCards
                  showSubtitles={false}
                  expandedHome
                  exploreCardBg="rgba(255,255,255,0.04)"
                  sectionStyle={SECTION_STYLE}
                  sectionVisible={SECTION_VISIBLE}
                />
              </div>
            ) : tab === 'purchased' ? (
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <KugouPurchasedPanel
                  theme={pcTheme('dark')}
                  accent={ACCENT}
                  showHeader={false}
                  actions={{ onPlaySongs: (song, songs, index) => onPlaySongs(songs, index ?? 0) }}
                />
              </div>
            ) : tab === 'recent' ? (
              renderSongList(recentSongs, {
                loading: recentLoading,
                emptyTitle: '暂无最近播放记录',
                emptyHint: '酷狗客户端播放过的歌曲会同步到这里；也可以先用主播放器播放酷狗歌曲。',
                playCounts: new Map(recentRows.map(row => [row.song.mid || String(row.song.id), row.playCount])),
              })
            ) : tab === 'liked' ? (
              likedError && likedSongs.length === 0
                ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[22px] border border-white/[0.07] bg-white/[0.03] px-6 py-16 text-center">
                    <Heart className="h-7 w-7 text-white/22" />
                    <p className="text-sm font-medium text-white/70">「我喜欢」加载失败</p>
                    <p className="max-w-md text-xs text-white/38">{likedError}</p>
                    <button
                      type="button"
                      onClick={() => setReloadToken(token => token + 1)}
                      className="mt-1 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[#081017]"
                      style={{ background: ACCENT }}
                    >
                      <RefreshCw className="h-3.5 w-3.5" /> 重试
                    </button>
                  </div>
                )
                : renderSongList(likedSongs, {
                  loading: likedLoading || playlistsLoading,
                  emptyTitle: '暂无喜欢的歌曲',
                  emptyHint: '在歌曲上点红心就会出现在「我喜欢」里（酷狗概念版账号）。',
                })
            ) : (
              playlistsLoading && playlists.length === 0 ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-sm text-white/45">
                  <Loader2 className="h-4 w-4 animate-spin" /> 正在加载收藏歌单…
                </div>
              ) : collectedPlaylists.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[22px] border border-white/[0.07] bg-white/[0.03] px-6 py-16 text-center">
                  <ListMusic className="h-7 w-7 text-white/22" />
                  <p className="text-sm font-medium text-white/70">暂无收藏歌单</p>
                  <p className="max-w-md text-xs text-white/38">{playlistsError || '在歌单详情页点收藏后会出现在这里。'}</p>
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                  <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                    {collectedPlaylists.map(playlist => (
                      <button
                        key={playlist.id}
                        type="button"
                        onClick={() => onOpenPlaylist?.(playlist)}
                        className="group min-w-0 text-left"
                      >
                        <div className="relative aspect-square overflow-hidden rounded-[18px] border border-white/[0.08] bg-white/[0.04]">
                          {playlist.coverImgUrl ? (
                            <CachedImage
                              src={playlist.coverImgUrl}
                              alt={playlist.name}
                              className="h-full w-full object-cover transition duration-500 group-hover:scale-105"
                              role="card"
                              size={256}
                              priority="visible"
                              lazy
                              platform="kugou"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center"><ListMusic className="h-6 w-6 text-white/20" /></div>
                          )}
                          {playlist.playCount ? (
                            <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/80">{formatCount(playlist.playCount)}</span>
                          ) : null}
                        </div>
                        <p className="mt-2.5 line-clamp-2 text-sm font-medium leading-snug text-white/86">{playlist.name}</p>
                        <p className="mt-1 truncate text-xs text-white/38">{playlist.trackCount || 0} 首 · 收藏的歌单</p>
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}

            {tab === 'recent' && recentHasMore && (
              <div className="mt-3 flex shrink-0 justify-center">
                <button
                  type="button"
                  disabled={recentLoadingMore}
                  onClick={() => void loadMoreRecent()}
                  className="rounded-full border border-white/[0.1] bg-white/[0.05] px-5 py-2 text-xs text-white/62 transition hover:bg-white/[0.1] hover:text-white disabled:opacity-50"
                >
                  {recentLoadingMore ? '正在加载…' : '加载更多'}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </motion.div>,
    document.body,
  )
}
