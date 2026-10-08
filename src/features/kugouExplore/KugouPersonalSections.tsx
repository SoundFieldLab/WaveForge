/**
 * 酷狗个人中心扩展面板（3.C）：云盘 / 已购音乐。
 * 数据来自概念版独立通道（mcloudservice / openapi 已购），未登录或上游为空时展示空态，
 * 不造假数据；所有请求都经 kugouService 薄封装（组件不直接 fetch）。
 */
import { useEffect, useState } from 'react'
import { Cloud, Disc3, Music2, RefreshCw } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import type { MusicPlatform } from '../../services/platforms'
import CachedImage from '../../components/CachedImage'
import {
  fetchKugouPurchasedAlbums,
  fetchKugouPurchasedSongs,
  fetchKugouUserCloud,
  hasKugouConceptCredential,
  kugouTrackToSong,
  type KugouCloudSong,
  type KugouPurchasedAlbum,
  type KugouPurchasedSong,
} from '../../services/kugouService'

interface KugouPersonalPanelProps {
  onSongSelect: (song: Song, playlist?: Song[]) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  accentColor?: string
}

function formatDuration(duration?: number): string {
  if (!duration || duration <= 0) return ''
  const minutes = Math.floor(duration / 60)
  const seconds = Math.floor(duration % 60)
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatFilesize(size?: number): string {
  if (!size || size <= 0) return ''
  if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

function PanelShell({
  title,
  hint,
  loading,
  error,
  empty,
  emptyText,
  onRetry,
  children,
}: {
  title: string
  hint?: string
  loading: boolean
  error?: string
  empty: boolean
  emptyText: string
  onRetry: () => void
  children: React.ReactNode
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold text-white">{title}</h3>
          {hint ? <p className="mt-1 text-xs text-white/45">{hint}</p> : null}
        </div>
        <button
          onClick={onRetry}
          className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm text-white/80 hover:bg-white/15"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>
      {loading ? (
        <div className="py-16 text-center text-white/55">正在加载…</div>
      ) : error ? (
        <div className="rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>
      ) : empty ? (
        <div className="py-16 text-center text-white/45">{emptyText}</div>
      ) : (
        children
      )}
    </div>
  )
}

/** 云盘：概念版独立加密通道（空盘 data.list === ''） */
export function KugouCloudPanel({ onSongSelect, accentColor = '#22c55e' }: KugouPersonalPanelProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [songs, setSongs] = useState<KugouCloudSong[]>([])
  const [empty, setEmpty] = useState(true)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await fetchKugouUserCloud(1, 100)
      if (result.error) setError(result.error)
      setSongs(result.songs)
      setEmpty(result.empty)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!hasKugouConceptCredential()) return
    void load()
    // 仅在挂载时拉取；刷新由按钮触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!hasKugouConceptCredential()) {
    return <div className="py-16 text-center text-white/45">请先登录酷狗音乐（概念版扫码），云盘需要登录态</div>
  }

  const playable = songs.filter((item): item is KugouCloudSong => Boolean(item.track?.hash))

  return (
    <PanelShell
      title="音乐云盘"
      hint="酷狗概念版云盘（mcloudservice）；未上传歌曲时为空态"
      loading={loading}
      error={error}
      empty={empty || playable.length === 0}
      emptyText="云盘为空：上传到酷狗云盘的音乐会显示在这里"
      onRetry={() => void load()}
    >
      <div className="space-y-1">
        {playable.map((item, index) => (
          <button
            key={`${item.track.hash}-${index}`}
            onClick={() => onSongSelect(kugouTrackToSong(item.track), playable.map(song => kugouTrackToSong(song.track)))}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/5"
          >
            <span className="w-6 text-center text-xs text-white/35">{index + 1}</span>
            <span className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-white/5">
              {item.track.coverUrl ? (
                <CachedImage src={item.track.coverUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center"><Music2 className="h-4 w-4 text-white/40" /></span>
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-white/90">{item.track.songName}</span>
              <span className="block truncate text-xs text-white/45">{item.track.singerName || '未知歌手'}</span>
            </span>
            <span className="shrink-0 text-xs text-white/40">{formatFilesize(item.filesize)}</span>
            <span className="w-12 shrink-0 text-right text-xs text-white/40">{formatDuration(item.track.duration)}</span>
          </button>
        ))}
      </div>
      <p className="text-xs text-white/30" style={{ color: accentColor }}>共 {playable.length} 首</p>
    </PanelShell>
  )
}

/** 已购音乐：已购单曲 + 已购专辑（openapi 无签名路径；上游无数据时双空态） */
export function KugouPurchasedPanel({ onSongSelect, onOpenAlbum, accentColor = '#f59e0b' }: KugouPersonalPanelProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [songs, setSongs] = useState<KugouPurchasedSong[]>([])
  const [albums, setAlbums] = useState<KugouPurchasedAlbum[]>([])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [songsResult, albumsResult] = await Promise.all([
        fetchKugouPurchasedSongs(1, 100),
        fetchKugouPurchasedAlbums(1, 50),
      ])
      const failure = songsResult.error && albumsResult.error
        ? (songsResult.error || albumsResult.error)
        : ''
      setError(failure || '')
      setSongs(songsResult.songs)
      setAlbums(albumsResult.albums)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!hasKugouConceptCredential()) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!hasKugouConceptCredential()) {
    return <div className="py-16 text-center text-white/45">请先登录酷狗音乐（概念版扫码），已购音乐需要登录态</div>
  }

  if (loading) return <div className="py-16 text-center text-white/55">正在加载…</div>
  if (error) return <div className="rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-semibold text-white">已购音乐</h3>
          <p className="mt-1 text-xs text-white/45">单曲与数字专辑（酷狗 openapi 独立通道）</p>
        </div>
        <button onClick={() => void load()} className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm text-white/80 hover:bg-white/15">
          <RefreshCw className="h-4 w-4" />
          刷新
        </button>
      </div>

      <section>
        <h4 className="mb-3 flex items-center gap-2 text-sm font-medium text-white/75"><Music2 className="h-4 w-4" />已购单曲 ({songs.length})</h4>
        {songs.length === 0 ? (
          <div className="rounded-xl border border-white/8 bg-white/[0.03] py-10 text-center text-sm text-white/40">暂无已购单曲</div>
        ) : (
          <div className="space-y-1">
            {songs.map((item, index) => (
              <button
                key={`${item.track.hash}-${index}`}
                onClick={() => onSongSelect(kugouTrackToSong(item.track), songs.map(song => kugouTrackToSong(song.track)))}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/5"
              >
                <span className="w-6 text-center text-xs text-white/35">{index + 1}</span>
                <span className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-white/5">
                  {item.track.coverUrl ? (
                    <CachedImage src={item.track.coverUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center"><Music2 className="h-4 w-4 text-white/40" /></span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-white/90">{item.track.songName}</span>
                  <span className="block truncate text-xs text-white/45">{item.track.singerName || '未知歌手'}</span>
                </span>
                <span className="w-12 shrink-0 text-right text-xs text-white/40">{formatDuration(item.track.duration)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section>
        <h4 className="mb-3 flex items-center gap-2 text-sm font-medium text-white/75"><Disc3 className="h-4 w-4" />已购专辑 ({albums.length})</h4>
        {albums.length === 0 ? (
          <div className="rounded-xl border border-white/8 bg-white/[0.03] py-10 text-center text-sm text-white/40">暂无已购专辑</div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {albums.map(album => (
              <button
                key={album.albumId}
                onClick={() => onOpenAlbum?.(album.albumId, 'kugou')}
                className="group text-left"
                style={{ cursor: onOpenAlbum ? 'pointer' : 'default' }}
              >
                <span className="block aspect-square overflow-hidden rounded-xl bg-white/5">
                  {album.coverUrl ? (
                    <CachedImage src={album.coverUrl} alt="" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center"><Cloud className="h-8 w-8 text-white/30" /></span>
                  )}
                </span>
                <span className="mt-2 block truncate text-sm text-white/85">{album.name}</span>
                <span className="block truncate text-xs text-white/45">{album.singerName || '未知歌手'}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs" style={{ color: accentColor }}>注：上游未返回数据时保持空态，不做假数据</p>
    </div>
  )
}
