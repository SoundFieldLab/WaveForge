import { useCallback, useEffect, useRef, useState } from 'react'
import { Disc3, ListMusic, Music2, Play, RefreshCw } from 'lucide-react'
import type { Song } from '../services/musicApi'
import {
  fetchExploreChart,
  fetchExploreHome,
  type ExploreAlbum,
  type ExploreChart,
  type ExplorePayload,
} from '../services/exploreApi'
import type { MusicPlatform } from '../services/platforms'
import CachedImage from './CachedImage'

/**
 * 桌面探索小组件自己的「上次结果」镜像（仅内存，不落盘）。
 * fetchExploreHome / fetchExploreChart 在服务层已有 TTL 缓存，但组件此前会在切平台时先
 * setData(null) / setSongs([])，于是即便请求命中缓存也会先闪一下空白。这里保存每个 key 的
 * 上一次成功结果，重进/切回时直接铺上，请求照常在后台校准。
 * 都是账号相关数据：waveforge-auth-changed 时整体清空。
 */
const DESKTOP_EXPLORE_HOME_CACHE_MAX = 6
const DESKTOP_CHART_SONGS_CACHE_MAX = 12
const desktopExploreHomeCache = new Map<string, ExplorePayload>()
const desktopChartSongsCache = new Map<string, Song[]>()

function hasExploreHomeContent(payload: ExplorePayload): boolean {
  return payload.newSongs.length > 0
    || payload.charts.length > 0
    || payload.albums.length > 0
    || payload.dailySongs.length > 0
    || payload.radioSongs.length > 0
}

function writeBoundedCache<T>(cache: Map<string, T>, key: string, value: T, max: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', () => {
    desktopExploreHomeCache.clear()
    desktopChartSongsCache.clear()
  })
}

export function useDesktopExploreHome(platform: MusicPlatform, enabled: boolean) {
  const [data, setData] = useState<ExplorePayload | null>(() => desktopExploreHomeCache.get(platform) ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async (forceRefresh = false) => {
    if (!enabled) return
    const generation = generationRef.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError('')
    try {
      const payload = await fetchExploreHome(platform, controller.signal, { forceRefresh })
      if (!controller.signal.aborted && generation === generationRef.current) {
        if (hasExploreHomeContent(payload)) writeBoundedCache(desktopExploreHomeCache, platform, payload, DESKTOP_EXPLORE_HOME_CACHE_MAX)
        setData(payload)
      }
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError' && generation === generationRef.current) {
        setError((cause as Error).message || '当前平台内容暂时不可用')
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (!controller.signal.aborted && generation === generationRef.current) setLoading(false)
    }
  }, [enabled, platform])

  useEffect(() => {
    generationRef.current += 1
    controllerRef.current?.abort()
    // 同平台已有结果就保留（不再先清空），平台变了才回落到空。
    setData(desktopExploreHomeCache.get(platform) ?? null)
    setError('')
    setLoading(false)
    if (!enabled) return
    void refresh(false)
    return () => controllerRef.current?.abort()
  }, [enabled, platform, refresh])

  return { data, loading, error, refresh }
}

const artistsText = (song: Song) => song.artists.map(artist => artist.name).filter(Boolean).join(' / ') || '未知歌手'
const songKey = (song: Song, index: number) => `${song.platform || 'unknown'}:${song.mid || song.appleId || song.id}:${index}`

export function DesktopNewSongsView({ songs, compact, onPlay }: { songs: Song[]; compact: boolean; onPlay: (song: Song) => void }) {
  return <div className="space-y-1">{songs.map((song, index) => <button key={songKey(song, index)} type="button" onClick={event => { event.stopPropagation(); onPlay(song) }} className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition hover:bg-white/8">
    {song.album.picUrl ? <CachedImage src={song.album.picUrl} alt="" className={`${compact ? 'h-9 w-9' : 'h-11 w-11'} shrink-0 rounded-xl`} role="row" priority="visible" fallback={<span className={`${compact ? 'h-9 w-9' : 'h-11 w-11'} flex shrink-0 items-center justify-center rounded-xl bg-white/8`}><Music2 className="h-4 w-4 text-white/35" /></span>} /> : <span className={`${compact ? 'h-9 w-9' : 'h-11 w-11'} flex shrink-0 items-center justify-center rounded-xl bg-white/8`}><Music2 className="h-4 w-4 text-white/35" /></span>}
    <span className="min-w-0 flex-1"><span className="block truncate text-sm text-white/86">{song.name}</span><span className="mt-0.5 block truncate text-[11px] text-white/38">{artistsText(song)}</span></span><Play className="h-3.5 w-3.5 text-white/30" />
  </button>)}</div>
}

export function DesktopChartsView({ charts, compact, selectedId, onSelect }: { charts: ExploreChart[]; compact: boolean; selectedId?: string; onSelect: (chart: ExploreChart) => void }) {
  return <div className={compact ? 'space-y-1' : 'grid grid-cols-2 gap-3'}>{charts.map(chart => <button key={`${chart.platform}:${chart.id}`} type="button" onClick={event => { event.stopPropagation(); onSelect(chart) }} className={`flex items-center gap-3 rounded-2xl border p-3 text-left transition hover:bg-white/8 ${selectedId === chart.id ? 'border-cyan-200/35 bg-cyan-300/8' : 'border-white/7 bg-white/[.035]'}`}>
    {chart.coverUrl ? <CachedImage src={chart.coverUrl} alt="" className={`${compact ? 'h-10 w-10' : 'h-14 w-14'} shrink-0 rounded-xl`} role="compact" priority="visible" fallback={<span className={`${compact ? 'h-10 w-10' : 'h-14 w-14'} flex shrink-0 items-center justify-center rounded-xl bg-white/8`}><ListMusic className="h-4 w-4 text-white/35" /></span>} /> : <span className={`${compact ? 'h-10 w-10' : 'h-14 w-14'} flex shrink-0 items-center justify-center rounded-xl bg-white/8`}><ListMusic className="h-4 w-4 text-white/35" /></span>}
    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{chart.name}</span><span className="mt-1 block truncate text-[10px] text-white/35">{chart.updateText || chart.group || `${chart.songs.length} 首预览`}</span></span>
  </button>)}</div>
}

export function useDesktopChartDetail() {
  const [chart, setChart] = useState<ExploreChart | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const controllerRef = useRef<AbortController | null>(null)

  const selectChart = useCallback(async (next: ExploreChart) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    // 同一个榜单刚看过：先铺上已有曲目（不再清空），详情请求在后台照常进行。
    const cacheKey = `${next.platform || ''}:${String(next.id)}`
    const cachedSongs = desktopChartSongsCache.get(cacheKey)
    setChart(next)
    setSongs(cachedSongs ?? [])
    setLoading(!cachedSongs)
    setError('')
    try {
      const detail = await fetchExploreChart(next, controller.signal)
      if (!controller.signal.aborted) {
        if (detail.songs.length > 0) writeBoundedCache(desktopChartSongsCache, cacheKey, detail.songs, DESKTOP_CHART_SONGS_CACHE_MAX)
        setSongs(detail.songs)
      }
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError((cause as Error).message || '榜单详情暂时不可用')
    } finally {
      if (controllerRef.current === controller) { controllerRef.current = null; setLoading(false) }
    }
  }, [])

  useEffect(() => () => controllerRef.current?.abort(), [])
  return { chart, songs, loading, error, selectChart }
}

// 日期 formatter 提到模块级复用：此前每张专辑卡渲染都 new 一次 Intl.DateTimeFormat
const PUBLISH_DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })

const formatPublishDate = (value: ExploreAlbum['publishTime']) => {
  if (!value) return '发行日期待更新'
  const date = new Date(typeof value === 'number' ? value : value)
  return Number.isNaN(date.getTime()) ? String(value) : PUBLISH_DATE_FORMATTER.format(date)
}

export function DesktopAlbumsView({ albums, compact, onOpen }: { albums: ExploreAlbum[]; compact: boolean; onOpen: (album: ExploreAlbum) => void }) {
  return <div className={compact ? 'grid grid-cols-3 gap-2' : 'grid grid-cols-3 gap-3'}>{albums.map(album => <button key={`${album.platform}:${album.mid || album.id}`} type="button" onClick={event => { event.stopPropagation(); onOpen(album) }} className="min-w-0 rounded-2xl p-1 text-left transition hover:bg-white/8">
    {album.coverUrl ? <CachedImage src={album.coverUrl} alt="" className="aspect-square w-full rounded-xl" role="card" priority="visible" fallback={<span className="flex aspect-square w-full items-center justify-center rounded-xl bg-white/8"><Disc3 className="h-6 w-6 text-white/30" /></span>} /> : <span className="flex aspect-square w-full items-center justify-center rounded-xl bg-white/8"><Disc3 className="h-6 w-6 text-white/30" /></span>}
    <span className="mt-2 block truncate text-xs font-medium text-white/82">{album.name}</span><span className="mt-0.5 block truncate text-[10px] text-white/35">{compact ? album.artist : `${album.artist} · ${formatPublishDate(album.publishTime)}`}</span>
  </button>)}</div>
}

export function DesktopExploreStatus({ loading, error, empty, onRetry }: { loading: boolean; error: string; empty: string; onRetry: () => void }) {
  if (loading) return <div className="flex items-center justify-center gap-2 py-5 text-xs text-white/38"><RefreshCw className="h-3.5 w-3.5 animate-spin" />正在读取当前平台</div>
  if (error) return <button type="button" onClick={event => { event.stopPropagation(); onRetry() }} className="w-full rounded-xl border border-rose-300/12 bg-rose-400/7 px-3 py-3 text-xs text-rose-100/65">{error} · 点击重试</button>
  return <div className="py-5 text-center text-xs text-white/30">{empty}</div>
}
