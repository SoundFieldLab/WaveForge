/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity, AppWindow, AudioLines, CalendarRange, ChartNoAxesColumnIncreasing, Check, ChevronRight,
  ArrowDown, ArrowUp,
  Clock3, Cpu, ExternalLink, FolderOpen, Gauge, HardDrive, Heart, History, Library, ListMusic,
  LoaderCircle, MemoryStick, Music2, Pause, Play, Plus, Radio, RefreshCw, Rocket, Settings2,
  SkipForward, Speaker, Trash2, Volume1, Volume2, VolumeX, WandSparkles, X,
} from 'lucide-react'
import type { DesktopWidgetType } from '../services/desktopCustomization'
import type { MusicPlatform } from '../services/platforms'
import type { Song } from '../services/musicApi'
import { fetchExploreHome, fetchExploreRecommendationBatch } from '../services/exploreApi'
import { getNeteasePlaylistTrackPage, getPlaylistDetail } from '../services/playlistService'
import {
  clearDesktopMusicActivity,
  DESKTOP_MUSIC_ACTIVITY_EVENT,
  getDesktopSongKey,
  loadDesktopMusicActivity,
} from '../services/desktopMusicActivity'
import { registerDesktopSpectrumConsumer } from '../services/desktopSpectrum'

export interface DesktopWidgetPlaylist {
  id: string | number
  name: string
  coverImgUrl: string
  trackCount?: number
  isLike?: boolean
}

export interface DesktopMusicWidgetContext {
  currentSong: Song | null
  isPlaying: boolean
  queue: Song[]
  currentIndex: number
  playlists: DesktopWidgetPlaylist[]
  platform: MusicPlatform
  volume: number
  onVolumeChange: (volume: number) => void
  onPlayPause: () => void
  onNext: () => void
  onSongSelect: (song: Song, songs?: Song[]) => void
  onRemoveQueueItem: (index: number) => void
  onMoveQueueItem: (from: number, to: number) => void
  onPlaylistSelect: (playlist: DesktopWidgetPlaylist) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
}

interface LauncherItem {
  id: string
  label: string
  target: string
  kind: 'app' | 'folder' | 'url'
}

interface ExtraWidgetPreferences {
  itemCounts: Partial<Record<DesktopWidgetType, number>>
  pinnedPlaylistIds: string[]
  launcherItems: LauncherItem[]
  spectrumStyle: 'bars' | 'wave'
  systemRefreshSeconds: number
  recommendationPlatform: 'current' | 'netease' | 'qq'
  calendarWeeks: number
  volumeStep: number
}

interface SystemSnapshot {
  cpuUsage: number
  memoryUsed: number
  memoryTotal: number
  memoryPercent: number
  disks: Array<{ name: string; used: number; total: number; percent: number }>
  uptime: number
  platform: string
}

const PREFERENCES_KEY = 'desktopExtraWidgetPreferencesV1'
const defaultPreferences: ExtraWidgetPreferences = {
  itemCounts: {},
  pinnedPlaylistIds: [],
  launcherItems: [],
  spectrumStyle: 'bars',
  systemRefreshSeconds: 3,
  recommendationPlatform: 'current',
  calendarWeeks: 16,
  volumeStep: 5,
}

const WIDGET_META: Record<string, { title: string; subtitle: string; icon: typeof Music2 }> = {
  recentlyPlayed: { title: '最近播放', subtitle: '继续刚才的旋律', icon: History },
  dailyRecommendations: { title: '每日推荐', subtitle: '为你精选', icon: WandSparkles },
  playQueue: { title: '播放队列', subtitle: '接下来播放', icon: ListMusic },
  favoriteSongs: { title: '收藏速览', subtitle: '我喜欢的音乐', icon: Heart },
  playlistShortcuts: { title: '歌单入口', subtitle: '常用歌单', icon: Library },
  listeningStats: { title: '听歌统计', subtitle: '聆听足迹', icon: ChartNoAxesColumnIncreasing },
  musicCalendar: { title: '音乐日历', subtitle: '每日听歌热力', icon: CalendarRange },
  artistUpdates: { title: '歌手动态', subtitle: '最近关注', icon: Radio },
  spectrum: { title: '音频频谱', subtitle: '实时律动', icon: AudioLines },
  quickLauncher: { title: '快捷启动', subtitle: '应用与位置', icon: Rocket },
  systemStatus: { title: '系统状态', subtitle: '设备运行概览', icon: Cpu },
  volumeControl: { title: '音量控制', subtitle: 'WaveForge 输出', icon: Volume2 },
}

function loadPreferences(): ExtraWidgetPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || 'null') as Partial<ExtraWidgetPreferences> | null
    return saved ? { ...defaultPreferences, ...saved, itemCounts: saved.itemCounts || {}, launcherItems: saved.launcherItems || [], pinnedPlaylistIds: saved.pinnedPlaylistIds || [] } : defaultPreferences
  } catch {
    return defaultPreferences
  }
}

function usePreferences() {
  const [preferences, setPreferences] = useState(loadPreferences)
  const update = useCallback((next: Partial<ExtraWidgetPreferences>) => {
    setPreferences(current => {
      const value = { ...current, ...next }
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(value))
      window.dispatchEvent(new CustomEvent('desktopExtraWidgetPreferencesChanged', { detail: value }))
      return value
    })
  }, [])
  useEffect(() => {
    const sync = (event: Event) => setPreferences((event as CustomEvent<ExtraWidgetPreferences>).detail || loadPreferences())
    window.addEventListener('desktopExtraWidgetPreferencesChanged', sync)
    return () => window.removeEventListener('desktopExtraWidgetPreferencesChanged', sync)
  }, [])
  return { preferences, update }
}

const artistsText = (song: Song) => song.artists?.map(artist => artist.name).filter(Boolean).join(' / ') || '未知歌手'
const cover = (song?: Song | null) => song?.album?.picUrl || ''
const formatMinutes = (seconds: number) => seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`
const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function normalizePlaylistSongs(data: any, platform: MusicPlatform): Song[] {
  const raw = platform === 'qq' ? data?.songlist || data?.playlist?.tracks || [] : data?.playlist?.tracks || data?.songs || []
  return raw.map((item: any) => platform === 'qq' ? {
    id: Number(item.id || item.songid || 0), mid: item.mid || item.songmid, name: item.name || item.songname || '未知歌曲',
    artists: (item.artists || item.singer || []).map((artist: any) => ({ id: artist.id, mid: artist.mid, name: artist.name })),
    album: { id: item.album?.id || item.albumid, mid: item.album?.mid || item.albummid, name: item.album?.name || item.albumname || '', picUrl: item.album?.picUrl || (item.albummid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${item.albummid}.jpg` : '') },
    duration: Number(item.duration || item.interval || 0) * (Number(item.duration || 0) > 10000 ? 1 : 1000), platform: 'qq' as const,
  } : {
    id: Number(item.id || 0), name: item.name || '未知歌曲',
    artists: (item.ar || item.artists || []).map((artist: any) => ({ id: artist.id, name: artist.name })),
    album: { id: item.al?.id || item.album?.id, name: item.al?.name || item.album?.name || '', picUrl: item.al?.picUrl || item.album?.picUrl || '' },
    duration: Number(item.dt || item.duration || 0), platform: 'netease' as const,
  }).filter((song: Song) => song.id || song.mid)
}

function Shell({ children, cardBlurAmount, accentColor, onClick }: { children: React.ReactNode; cardBlurAmount: number; accentColor: string; onClick: () => void }) {
  return <div role="button" tabIndex={0} onClick={onClick} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick() } }} className="desktop-widget-card block w-full cursor-pointer overflow-hidden rounded-[28px] text-left text-white outline-none transition hover:scale-[1.018] focus-visible:ring-2 focus-visible:ring-white/70 active:scale-[.99]" style={{ background: `linear-gradient(145deg, ${accentColor}35, rgba(8,12,24,.58) 48%, rgba(255,255,255,.07))`, backdropFilter: `blur(${Math.max(14, cardBlurAmount + 8)}px) saturate(150%)`, WebkitBackdropFilter: `blur(${Math.max(14, cardBlurAmount + 8)}px) saturate(150%)`, boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.11),0 16px 42px rgba(15,23,42,.12)', contain: 'layout paint style', contentVisibility: 'auto', containIntrinsicSize: '220px' }}>{children}</div>
}

function Header({ type, accentColor, trailing }: { type: DesktopWidgetType; accentColor: string; trailing?: React.ReactNode }) {
  const meta = WIDGET_META[type]
  const Icon = meta.icon
  return <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ background: `${accentColor}26`, color: accentColor }}><Icon className="h-4 w-4" /></span><div className="min-w-0 flex-1"><div className="text-sm font-semibold">{meta.title}</div><div className="truncate text-[10px] text-white/38">{meta.subtitle}</div></div>{trailing}</div>
}

function SongRow({ song, index, active, onClick }: { song: Song; index?: number; active?: boolean; onClick: () => void }) {
  return <button type="button" onClick={event => { event.stopPropagation(); onClick() }} className="flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition hover:bg-white/8" style={{ background: active ? 'rgba(255,255,255,.08)' : undefined }}>
    {cover(song) ? <img src={cover(song)} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover" /> : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/8 text-white/35">{index === undefined ? <Music2 className="h-4 w-4" /> : index + 1}</span>}
    <span className="min-w-0 flex-1"><span className="block truncate text-sm text-white/86">{song.name}</span><span className="mt-0.5 block truncate text-[11px] text-white/38">{artistsText(song)}</span></span>
    <Play className="h-3.5 w-3.5 text-white/30" />
  </button>
}

function Modal({ open, type, accentColor, onClose, children, settings }: { open: boolean; type: DesktopWidgetType; accentColor: string; onClose: () => void; children: React.ReactNode; settings: React.ReactNode }) {
  const meta = WIDGET_META[type]
  const Icon = meta.icon
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, onClose])
  return <AnimatePresence>{open && <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[410] flex items-center justify-center bg-black/72 p-6 backdrop-blur-2xl" onMouseDown={event => event.target === event.currentTarget && onClose()}><motion.div initial={{ opacity: 0, y: 22, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 14, scale: .98 }} className="flex h-[min(760px,90vh)] w-[min(1040px,94vw)] flex-col overflow-hidden rounded-[34px] border border-white/12 bg-[#09101e]/98 text-white shadow-[0_40px_120px_rgba(0,0,0,.7)]">
    <header className="flex items-center gap-4 border-b border-white/10 px-6 py-5"><span className="flex h-11 w-11 items-center justify-center rounded-2xl" style={{ background: `${accentColor}28`, color: accentColor }}><Icon className="h-5 w-5" /></span><div className="flex-1"><div className="text-lg font-semibold">{meta.title}</div><div className="mt-1 text-xs text-white/38">{meta.subtitle} · 点击项目可立即执行</div></div><button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60 hover:bg-white/10"><X className="h-5 w-5" /></button></header>
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_280px]"><main className="min-h-0 overflow-y-auto p-5">{children}</main><aside className="min-h-0 overflow-y-auto border-l border-white/10 bg-white/[.025] p-5"><div className="mb-4 flex items-center gap-2 text-sm font-medium"><Settings2 className="h-4 w-4" style={{ color: accentColor }} />卡片设置</div>{settings}</aside></div>
  </motion.div></motion.div>}</AnimatePresence>
}

function SettingCount({ value, onChange, label = '卡片显示数量', min = 2, max = 12 }: { value: number; onChange: (value: number) => void; label?: string; min?: number; max?: number }) {
  return <label className="block rounded-2xl border border-white/8 bg-white/[.035] p-3 text-xs text-white/55"><span className="flex justify-between"><span>{label}</span><b className="text-white">{value}</b></span><input type="range" min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))} className="mt-3 w-full accent-cyan-300" /></label>
}

function useActivity(kind: DesktopWidgetType) {
  const enabled = kind === 'recentlyPlayed' || kind === 'listeningStats' || kind === 'musicCalendar' || kind === 'artistUpdates'
  const [activity, setActivity] = useState<ReturnType<typeof loadDesktopMusicActivity>>(() => enabled ? loadDesktopMusicActivity() : { history: [], days: {}, lastSongKey: '', lastStartedAt: 0 })
  const signatureRef = useRef('')
  useEffect(() => {
    if (!enabled) return
    const getSignature = (value: ReturnType<typeof loadDesktopMusicActivity>) => kind === 'recentlyPlayed' || kind === 'artistUpdates'
      ? value.history.map(entry => `${getDesktopSongKey(entry.song)}:${entry.playedAt}:${entry.playCount}`).join('|')
      : Object.values(value.days).map(day => `${day.date}:${day.listenedSeconds}:${day.songStarts}`).join('|')
    signatureRef.current = getSignature(activity)
    const sync = (event: Event) => {
      const next = (event as CustomEvent<ReturnType<typeof loadDesktopMusicActivity>>).detail || loadDesktopMusicActivity()
      const nextSignature = getSignature(next)
      if (nextSignature === signatureRef.current) return
      signatureRef.current = nextSignature
      setActivity(next)
    }
    window.addEventListener(DESKTOP_MUSIC_ACTIVITY_EVENT, sync)
    return () => window.removeEventListener(DESKTOP_MUSIC_ACTIVITY_EVENT, sync)
  }, [activity, enabled, kind])
  return activity
}
function useRecommendations(platform: MusicPlatform, enabled: boolean) {
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(false)
  const [batch, setBatch] = useState(1)
  const requestInFlight = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)
  const refresh = useCallback(async (next = false) => {
    if (!enabled || requestInFlight.current) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    requestInFlight.current = true
    setLoading(true)
    try {
      if (next) {
        const nextBatch = batch + 1
        const nextSongs = await fetchExploreRecommendationBatch(platform, nextBatch, songs.map(getDesktopSongKey), controller.signal)
        if (!controller.signal.aborted) {
          setSongs(nextSongs)
          setBatch(nextBatch)
        }
      } else {
        const home = await fetchExploreHome(platform, controller.signal)
        if (!controller.signal.aborted) setSongs(home.dailySongs.length ? home.dailySongs : home.radioSongs.length ? home.radioSongs : home.newSongs)
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') console.warn('[DesktopWidgets] 推荐加载失败', error)
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      requestInFlight.current = false
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [batch, enabled, platform, songs])
  useEffect(() => {
    if (!enabled) return
    void refresh(false)
    return () => controllerRef.current?.abort()
  }, [enabled, platform])
  return { songs, loading, refresh }
}

function Heatmap({ days, weeks, accentColor }: { days: Record<string, { listenedSeconds: number }>; weeks: number; accentColor: string }) {
  const cells = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const start = new Date(today); start.setDate(today.getDate() - weeks * 7 + 1)
    return Array.from({ length: weeks * 7 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; return { key, seconds: days[key]?.listenedSeconds || 0 } })
  }, [days, weeks])
  return <div className="grid grid-flow-col grid-rows-7 gap-1.5">{cells.map(cell => { const strength = Math.min(1, cell.seconds / 7200); return <div key={cell.key} title={`${cell.key} · ${formatMinutes(cell.seconds)}`} className="aspect-square rounded-[4px] border border-white/5" style={{ background: cell.seconds ? `${accentColor}${Math.round(45 + strength * 190).toString(16).padStart(2, '0')}` : 'rgba(255,255,255,.045)' }} /> })}</div>
}

function Spectrum({ accentColor, style, large = false }: { accentColor: string; style: 'bars' | 'wave'; large?: boolean }) {
  const [values, setValues] = useState<number[]>([.05, .08, .06, .1, .05])
  const pendingValuesRef = useRef<number[] | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const unregister = registerDesktopSpectrumConsumer()
    const update = (event: Event) => {
      pendingValuesRef.current = (event as CustomEvent<number[]>).detail
      if (frameRef.current !== null || document.visibilityState !== 'visible') return
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        const pending = pendingValuesRef.current
        if (pending?.length) setValues(Array.from(pending))
      })
    }
    window.addEventListener('desktopSpectrumChanged', update)
    return () => {
      unregister()
      window.removeEventListener('desktopSpectrumChanged', update)
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const expanded = useMemo(() => {
    const targetCount = large ? 44 : 18
    if (values.length <= 1) return Array(targetCount).fill(values[0] || .04)
    return Array.from({ length: targetCount }, (_, index) => {
      const sourcePosition = (index / Math.max(1, targetCount - 1)) * (values.length - 1)
      const left = Math.floor(sourcePosition)
      const right = Math.min(values.length - 1, left + 1)
      const mix = sourcePosition - left
      return (values[left] || .04) * (1 - mix) + (values[right] || .04) * mix
    })
  }, [large, values])
  const wavePath = useMemo(() => {
    const points = expanded.map((value, index) => {
      const x = (index / Math.max(1, expanded.length - 1)) * 1000
      const direction = index % 2 === 0 ? -1 : 1
      const y = 50 + direction * Math.min(.92, Math.max(.04, value)) * 42
      return { x, y }
    })
    if (!points.length) return 'M 0 50 L 1000 50'
    let path = `M ${points[0].x} ${points[0].y}`
    for (let index = 1; index < points.length - 1; index += 1) {
      const point = points[index]
      const next = points[index + 1]
      path += ` Q ${point.x} ${point.y} ${(point.x + next.x) / 2} ${(point.y + next.y) / 2}`
    }
    const last = points[points.length - 1]
    return `${path} T ${last.x} ${last.y}`
  }, [expanded])

  if (style === 'wave') {
    return <div className={`relative flex items-center ${large ? 'h-72' : 'h-20'}`}>
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="h-full w-full overflow-visible" aria-hidden="true">
        <motion.path animate={{ d: wavePath }} transition={{ duration: .1, ease: 'easeOut' }} fill="none" stroke={accentColor} strokeWidth={large ? 10 : 14} strokeLinecap="round" strokeLinejoin="round" opacity=".2" style={{ filter: `blur(${large ? 7 : 4}px)` }} />
        <motion.path animate={{ d: wavePath }} transition={{ duration: .1, ease: 'easeOut' }} fill="none" stroke={`url(#desktop-spectrum-wave-${large ? 'large' : 'card'})`} strokeWidth={large ? 3.5 : 5} strokeLinecap="round" strokeLinejoin="round" />
        <defs><linearGradient id={`desktop-spectrum-wave-${large ? 'large' : 'card'}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={accentColor} stopOpacity=".35" /><stop offset=".5" stopColor="#fff" stopOpacity=".95" /><stop offset="1" stopColor={accentColor} stopOpacity=".45" /></linearGradient></defs>
      </svg>
    </div>
  }

  return <div className={`flex items-end justify-center gap-1 overflow-hidden ${large ? 'h-72' : 'h-20'}`}>{expanded.map((value, index) => <span key={index} className="h-full w-2 origin-bottom rounded-md" style={{ background: `linear-gradient(to top, ${accentColor}, rgba(255,255,255,.9))`, opacity: .55 + (index % 4) * .1, boxShadow: `0 0 12px ${accentColor}55`, transform: `scaleY(${Math.max(large ? .03 : .1, Math.min(.9, value * .87))})`, transition: 'transform 100ms ease-out', willChange: 'transform' }} />)}</div>
}

export default function DesktopExtraWidget({ type, cardBlurAmount, accentColor, context, onOverlayOpenChange }: { type: DesktopWidgetType; cardBlurAmount: number; accentColor: string; context: DesktopMusicWidgetContext; onOverlayOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const { preferences, update } = usePreferences()
  const activity = useActivity(type)
  const count = preferences.itemCounts[type] || 4
  const setCount = (value: number) => update({ itemCounts: { ...preferences.itemCounts, [type]: value } })
  const recommendationPlatform = preferences.recommendationPlatform === 'current' ? context.platform : preferences.recommendationPlatform
  const recommendations = useRecommendations(recommendationPlatform, type === 'dailyRecommendations')
  const [favoriteSongs, setFavoriteSongs] = useState<Song[]>([])
  const [favoritesLoading, setFavoritesLoading] = useState(false)
  const [system, setSystem] = useState<SystemSnapshot | null>(null)
  const [artistFeed, setArtistFeed] = useState<Song[]>([])
  const [launcherDraft, setLauncherDraft] = useState({ label: '', target: '', kind: 'app' as LauncherItem['kind'] })
  const openModal = () => { setOpen(true); onOverlayOpenChange?.(true) }
  const closeModal = () => { setOpen(false); onOverlayOpenChange?.(false) }
  const play = (song: Song, songs?: Song[]) => context.onSongSelect(song, songs)

  const pinnedPlaylists = useMemo(() => {
    const explicit = preferences.pinnedPlaylistIds.map(id => context.playlists.find(item => String(item.id) === id)).filter(Boolean) as DesktopWidgetPlaylist[]
    return explicit.length ? explicit : context.playlists.slice(0, count)
  }, [context.playlists, count, preferences.pinnedPlaylistIds])

  useEffect(() => {
    if (type !== 'favoriteSongs') return
    const liked = context.playlists.find(playlist => playlist.isLike) || context.playlists[0]
    if (!liked) { setFavoriteSongs([]); return }
    // Apple 无"我喜欢"歌单接口（喜欢=音乐库，走 amp-api），组件留空
    if (context.platform === 'apple') { setFavoriteSongs([]); setFavoritesLoading(false); return }
    let active = true
    setFavoritesLoading(true)
    const request = context.platform === 'netease'
      ? getNeteasePlaylistTrackPage(liked.id, 0, 120).then(page => ({ playlist: { tracks: page.tracks } }))
      : getPlaylistDetail(String(liked.id), context.platform)
    request.then(data => { if (active) setFavoriteSongs(normalizePlaylistSongs(data, context.platform)) }).catch(() => { if (active) setFavoriteSongs([]) }).finally(() => { if (active) setFavoritesLoading(false) })
    return () => { active = false }
  }, [context.platform, context.playlists, type])

  useEffect(() => {
    if (type !== 'systemStatus') return
    let timer: number | null = null
    let disposed = false
    const intervalMs = Math.max(1, preferences.systemRefreshSeconds) * 1000
    const schedule = () => {
      if (disposed || document.visibilityState !== 'visible') return
      timer = window.setTimeout(load, intervalMs)
    }
    const load = () => {
      timer = null
      if (disposed || document.visibilityState !== 'visible') return
      void window.electron?.desktopWidgets?.getSystemStatus?.()
        .then(value => { if (!disposed) setSystem(value) })
        .catch(() => { if (!disposed) setSystem(null) })
        .finally(schedule)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        if (timer !== null) window.clearTimeout(timer)
        timer = null
        return
      }
      if (timer === null) load()
    }
    load()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      disposed = true
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [preferences.systemRefreshSeconds, type])

  const upcoming = context.queue.slice(Math.max(0, context.currentIndex), Math.max(0, context.currentIndex) + count)
  const recent = activity.history.slice(0, count)
  const todayKey = new Date().toLocaleDateString('sv-SE')
  const today = activity.days[todayKey] || { listenedSeconds: 0, songStarts: 0 }
  const weekSeconds = Object.values(activity.days).filter(day => Date.now() - new Date(`${day.date}T00:00:00`).getTime() < 7 * 86400000).reduce((sum, day) => sum + day.listenedSeconds, 0)
  const topArtists = useMemo(() => {
    const scores = new Map<string, { name: string; id?: number; platform: MusicPlatform; score: number }>()
    activity.history.forEach(entry => entry.song.artists.forEach(artist => { const key = `${entry.song.platform}:${artist.id || artist.name}`; const current = scores.get(key); scores.set(key, { name: artist.name, id: artist.id, platform: entry.song.platform || 'netease', score: (current?.score || 0) + entry.playCount }) }))
    return [...scores.values()].sort((a, b) => b.score - a.score)
  }, [activity.history])

  useEffect(() => {
    if (type !== 'artistUpdates') return
    let active = true
    fetchExploreHome(context.platform).then(home => {
      if (!active) return
      const names = new Set(topArtists.slice(0, 12).map(artist => artist.name))
      const matched = home.newSongs.filter(song => song.artists.some(artist => names.has(artist.name)))
      setArtistFeed((matched.length ? matched : home.newSongs).slice(0, 30))
    }).catch(() => { if (active) setArtistFeed([]) })
    return () => { active = false }
  }, [context.platform, topArtists, type])

  const addLauncher = async () => {
    let target = launcherDraft.target.trim()
    if (!target && launcherDraft.kind !== 'url') target = await window.electron?.desktopWidgets?.pickLauncherTarget?.(launcherDraft.kind) || ''
    if (!target) return
    const item: LauncherItem = { id: crypto.randomUUID(), label: launcherDraft.label.trim() || target.split(/[\\/]/).pop() || '快捷方式', target, kind: launcherDraft.kind }
    update({ launcherItems: [...preferences.launcherItems, item] }); setLauncherDraft({ label: '', target: '', kind: 'app' })
  }
  const launch = (item: LauncherItem) => void window.electron?.desktopWidgets?.openLauncherTarget?.(item.target, item.kind)
  const volumePercent = Math.round(context.volume * 100)

  let card: React.ReactNode = null
  let details: React.ReactNode = null
  let settings: React.ReactNode = <div className="rounded-2xl border border-white/8 bg-white/[.035] p-3 text-xs leading-5 text-white/42">此卡片会自动根据当前状态展示内容，无需设置显示数量。</div>

  if (type === 'recentlyPlayed') {
    card = <><Header type={type} accentColor={accentColor} trailing={<span className="text-xs text-white/35">{activity.history.length}</span>} /><div className="mt-3 space-y-1">{recent.map(entry => <SongRow key={getDesktopSongKey(entry.song)} song={entry.song} onClick={() => play(entry.song, activity.history.map(item => item.song))} />)}{!recent.length && <Empty text="播放歌曲后会出现在这里" />}</div></>
    details = <SongList songs={activity.history.map(entry => entry.song)} onPlay={song => play(song, activity.history.map(item => item.song))} />
    settings = <><SettingCount value={count} onChange={setCount} /><button type="button" onClick={() => clearDesktopMusicActivity()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-rose-300/15 bg-rose-400/8 py-3 text-xs text-rose-200/70"><Trash2 className="h-3.5 w-3.5" />清空播放足迹</button></>
  } else if (type === 'dailyRecommendations') {
    const songs = recommendations.songs
    card = <><Header type={type} accentColor={accentColor} trailing={recommendations.loading ? <LoaderCircle className="h-4 w-4 animate-spin text-white/40" /> : <button type="button" aria-label="换一批每日推荐" onClick={event => { event.stopPropagation(); void recommendations.refresh(true) }}><RefreshCw className="h-4 w-4 text-white/40" /></button>} /><div className="mt-3 space-y-1">{songs.slice(0, count).map(song => <SongRow key={getDesktopSongKey(song)} song={song} onClick={() => play(song, songs)} />)}{!songs.length && <Empty text="正在准备今日推荐" />}</div></>
    details = <><div className="mb-4 flex items-center justify-between rounded-2xl border border-white/8 bg-white/[.025] px-4 py-3"><span className="text-xs text-white/38">{recommendations.loading ? '正在获取新一批推荐，请稍候…' : `当前共 ${songs.length} 首推荐`}</span><button type="button" disabled={recommendations.loading} onClick={() => void recommendations.refresh(true)} className="flex min-w-24 items-center justify-center gap-2 rounded-full border border-white/10 px-4 py-2 text-xs text-white/65 transition hover:bg-white/8 disabled:cursor-wait disabled:opacity-55"><RefreshCw className={`h-3.5 w-3.5 ${recommendations.loading ? 'animate-spin' : ''}`} />{recommendations.loading ? '刷新中' : '换一批'}</button></div><SongList songs={songs} onPlay={song => play(song, songs)} /></>
    settings = <><SettingCount value={count} onChange={setCount} /><SelectSetting label="推荐来源" value={preferences.recommendationPlatform} onChange={value => update({ recommendationPlatform: value as ExtraWidgetPreferences['recommendationPlatform'] })} options={[['current','跟随桌面平台'],['netease','网易云音乐'],['qq','QQ 音乐']]} /></>
  } else if (type === 'playQueue') {
    card = <><Header type={type} accentColor={accentColor} trailing={<span className="text-xs text-white/35">{Math.max(0, context.queue.length - context.currentIndex)}</span>} /><div className="mt-3 space-y-1">{upcoming.map((song, index) => <SongRow key={`${getDesktopSongKey(song)}:${index}`} song={song} active={index === 0} onClick={() => play(song, context.queue)} />)}{!upcoming.length && <Empty text="当前队列为空" />}</div></>
    details = <div className="space-y-1">{context.queue.slice(0, 100).map((song, index) => { const active = index === context.currentIndex; return <div key={`${getDesktopSongKey(song)}:${index}`} className="flex items-center gap-1 rounded-2xl" style={{ background: active ? 'rgba(255,255,255,.08)' : undefined }}><div className="min-w-0 flex-1"><SongRow song={song} index={index} active={active} onClick={() => play(song, context.queue)} /></div><button type="button" disabled={index === 0} onClick={() => context.onMoveQueueItem(index, index - 1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 hover:bg-white/8 disabled:opacity-15"><ArrowUp className="h-3.5 w-3.5" /></button><button type="button" disabled={index === context.queue.length - 1} onClick={() => context.onMoveQueueItem(index, index + 1)} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/35 hover:bg-white/8 disabled:opacity-15"><ArrowDown className="h-3.5 w-3.5" /></button><button type="button" disabled={active} onClick={() => context.onRemoveQueueItem(index)} title={active ? '正在播放的歌曲不能直接移除' : '从队列移除'} className="flex h-8 w-8 items-center justify-center rounded-lg text-rose-300/45 hover:bg-rose-400/10 disabled:opacity-15"><Trash2 className="h-3.5 w-3.5" /></button></div> })}</div>
    settings = <SettingCount value={count} onChange={setCount} />
  } else if (type === 'favoriteSongs') {
    card = <><Header type={type} accentColor={accentColor} trailing={favoritesLoading ? <LoaderCircle className="h-4 w-4 animate-spin text-white/40" /> : <Heart className="h-4 w-4" fill={accentColor} style={{ color: accentColor }} />} /><div className="mt-3 space-y-1">{favoriteSongs.slice(0, count).map(song => <SongRow key={getDesktopSongKey(song)} song={song} onClick={() => play(song, favoriteSongs)} />)}{!favoriteSongs.length && <Empty text="登录后读取我喜欢的音乐" />}</div></>
    details = <SongList songs={favoriteSongs} onPlay={song => play(song, favoriteSongs)} />
    settings = <SettingCount value={count} onChange={setCount} />
  } else if (type === 'playlistShortcuts') {
    card = <><Header type={type} accentColor={accentColor} /><div className="mt-3 grid grid-cols-3 gap-2">{pinnedPlaylists.slice(0, count).map(item => <button key={item.id} type="button" onClick={event => { event.stopPropagation(); context.onPlaylistSelect(item) }} className="min-w-0"><img src={item.coverImgUrl} alt="" className="aspect-square w-full rounded-xl object-cover" /><span className="mt-1 block truncate text-[10px] text-white/55">{item.name}</span></button>)}</div></>
    details = <div className="grid grid-cols-3 gap-3">{context.playlists.map(item => <button key={item.id} type="button" onClick={() => context.onPlaylistSelect(item)} className="rounded-2xl border border-white/8 bg-white/[.035] p-3 text-left hover:bg-white/8"><img src={item.coverImgUrl} alt="" className="aspect-square w-full rounded-xl object-cover" /><div className="mt-2 truncate text-sm">{item.name}</div><div className="mt-1 text-[10px] text-white/35">{item.trackCount || 0} 首</div></button>)}</div>
    settings = <><SettingCount value={count} onChange={setCount} /><div className="mt-4 text-xs text-white/42">固定歌单</div><div className="mt-2 max-h-72 space-y-1 overflow-y-auto">{context.playlists.map(item => { const selected = preferences.pinnedPlaylistIds.includes(String(item.id)); return <button key={item.id} type="button" onClick={() => update({ pinnedPlaylistIds: selected ? preferences.pinnedPlaylistIds.filter(id => id !== String(item.id)) : [...preferences.pinnedPlaylistIds, String(item.id)] })} className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-xs hover:bg-white/8"><span className="flex h-5 w-5 items-center justify-center rounded-md border" style={{ borderColor: selected ? accentColor : 'rgba(255,255,255,.2)', background: selected ? accentColor : 'transparent' }}>{selected && <Check className="h-3 w-3 text-slate-950" />}</span><span className="truncate">{item.name}</span></button> })}</div></>
  } else if (type === 'listeningStats') {
    card = <><Header type={type} accentColor={accentColor} /><div className="mt-4 grid grid-cols-2 gap-2"><Stat label="今日" value={formatMinutes(today.listenedSeconds)} /><Stat label="本周" value={formatMinutes(weekSeconds)} /></div><div className="mt-2 text-[11px] text-white/38">今日开始播放 {today.songStarts} 首</div></>
    details = <div className="grid grid-cols-3 gap-3"><Stat large label="今日听歌" value={formatMinutes(today.listenedSeconds)} /><Stat large label="近 7 天" value={formatMinutes(weekSeconds)} /><Stat large label="累计歌曲" value={`${activity.history.length} 首`} /><div className="col-span-3 mt-3 rounded-3xl border border-white/8 bg-white/[.035] p-4"><div className="mb-3 text-sm font-medium">常听歌手</div>{topArtists.slice(0, 10).map((artist, index) => <div key={`${artist.platform}:${artist.id || artist.name}`} className="flex items-center gap-3 border-b border-white/6 py-3 last:border-0"><span className="w-6 text-xs text-white/30">{index + 1}</span><span className="flex-1 text-sm">{artist.name}</span><span className="text-xs text-white/35">{artist.score} 次</span></div>)}</div></div>
    settings = <div className="rounded-2xl border border-white/8 bg-white/[.035] p-3 text-xs leading-5 text-white/42">统计卡片固定展示今日、本周和播放次数，不使用歌曲数量设置。</div>
  } else if (type === 'musicCalendar') {
    card = <><Header type={type} accentColor={accentColor} /><div className="mt-4"><Heatmap days={activity.days} weeks={8} accentColor={accentColor} /></div></>
    details = <div className="rounded-3xl border border-white/8 bg-white/[.035] p-5"><div className="mb-5 flex justify-between text-sm"><span>近 {preferences.calendarWeeks} 周</span><span className="text-white/35">颜色越亮，听歌越久</span></div><Heatmap days={activity.days} weeks={preferences.calendarWeeks} accentColor={accentColor} /></div>
    settings = <SettingCount label="显示周数" min={8} max={40} value={preferences.calendarWeeks} onChange={value => update({ calendarWeeks: value })} />
  } else if (type === 'artistUpdates') {
    card = <><Header type={type} accentColor={accentColor} /><div className="mt-3 space-y-1">{artistFeed.slice(0, count).map(song => <SongRow key={getDesktopSongKey(song)} song={song} onClick={() => play(song, artistFeed)} />)}{!artistFeed.length && topArtists.slice(0, count).map(artist => <button key={`${artist.platform}:${artist.id || artist.name}`} type="button" onClick={event => { event.stopPropagation(); if (artist.id) context.onOpenArtist?.(String(artist.id), artist.platform) }} className="flex w-full items-center gap-3 rounded-2xl bg-white/[.035] px-3 py-2.5 text-left"><Radio className="h-4 w-4" style={{ color: accentColor }} /><span className="min-w-0 flex-1 truncate text-sm">{artist.name}</span><ChevronRight className="h-4 w-4 text-white/25" /></button>)}</div></>
    details = <><div className="mb-4 rounded-2xl border border-white/8 bg-white/[.035] p-4 text-xs leading-5 text-white/42">优先展示近期常听歌手的新歌；平台暂未返回匹配结果时，以最新发行补充。</div><SongList songs={artistFeed} onPlay={song => play(song, artistFeed)} /><div className="mt-5 text-sm font-medium">常听歌手</div><div className="mt-2 grid grid-cols-2 gap-2">{topArtists.slice(0, 12).map(artist => <button key={`${artist.platform}:${artist.id || artist.name}`} type="button" disabled={!artist.id} onClick={() => artist.id && context.onOpenArtist?.(String(artist.id), artist.platform)} className="flex items-center gap-2 rounded-2xl border border-white/8 bg-white/[.035] p-3 text-left disabled:opacity-50"><Radio className="h-4 w-4" style={{ color: accentColor }} /><span className="truncate text-xs">{artist.name}</span></button>)}</div></>
    settings = <SettingCount value={count} onChange={setCount} />
  } else if (type === 'spectrum') {
    card = <><Header type={type} accentColor={accentColor} trailing={<span className="text-[10px] text-white/35">{context.isPlaying ? 'LIVE' : 'PAUSED'}</span>} /><Spectrum accentColor={accentColor} style={preferences.spectrumStyle} /></>
    details = <div className="flex h-full flex-col justify-center rounded-3xl border border-white/8 bg-black/20 p-5"><Spectrum large accentColor={accentColor} style={preferences.spectrumStyle} /><div className="mt-5 text-center"><div className="text-lg font-medium">{context.currentSong?.name || '等待播放'}</div><div className="mt-1 text-xs text-white/38">{context.currentSong ? artistsText(context.currentSong) : '播放歌曲后显示实时频谱'}</div></div></div>
    settings = <SelectSetting label="频谱样式" value={preferences.spectrumStyle} onChange={value => update({ spectrumStyle: value as 'bars' | 'wave' })} options={[['bars','能量柱'],['wave','细波形']]} />
  } else if (type === 'quickLauncher') {
    card = <><Header type={type} accentColor={accentColor} /><div className="mt-3 grid grid-cols-4 gap-2">{preferences.launcherItems.slice(0, 4).map(item => <button key={item.id} type="button" onClick={event => { event.stopPropagation(); launch(item) }} title={item.label} className="flex aspect-square items-center justify-center rounded-2xl bg-white/[.06] text-white/70 hover:bg-white/12">{item.kind === 'url' ? <ExternalLink className="h-5 w-5" /> : item.kind === 'folder' ? <FolderOpen className="h-5 w-5" /> : <AppWindow className="h-5 w-5" />}</button>)}{!preferences.launcherItems.length && <button type="button" onClick={event => { event.stopPropagation(); openModal() }} className="flex aspect-square items-center justify-center rounded-2xl border border-dashed border-white/15 text-white/35"><Plus className="h-5 w-5" /></button>}</div></>
    details = <div className="grid grid-cols-3 gap-3">{preferences.launcherItems.map(item => <button key={item.id} type="button" onClick={() => launch(item)} className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[.035] p-4 text-left hover:bg-white/8">{item.kind === 'url' ? <ExternalLink className="h-5 w-5" /> : item.kind === 'folder' ? <FolderOpen className="h-5 w-5" /> : <AppWindow className="h-5 w-5" />}<span className="min-w-0 flex-1"><span className="block truncate text-sm">{item.label}</span><span className="mt-1 block truncate text-[10px] text-white/30">{item.target}</span></span></button>)}</div>
    settings = <><div className="space-y-2"><SelectSetting label="类型" value={launcherDraft.kind} onChange={value => setLauncherDraft(current => ({ ...current, kind: value as LauncherItem['kind'] }))} options={[['app','应用/文件'],['folder','文件夹'],['url','网页']]} /><input value={launcherDraft.label} onChange={event => setLauncherDraft(current => ({ ...current, label: event.target.value }))} placeholder="显示名称（可选）" className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs outline-none" /><input value={launcherDraft.target} onChange={event => setLauncherDraft(current => ({ ...current, target: event.target.value }))} placeholder={launcherDraft.kind === 'url' ? 'https://…' : '留空后点击添加以选择'} className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs outline-none" /><button type="button" onClick={() => void addLauncher()} className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-xs font-medium text-slate-950" style={{ background: accentColor }}><Plus className="h-3.5 w-3.5" />添加快捷方式</button></div><div className="mt-4 space-y-1">{preferences.launcherItems.map(item => <div key={item.id} className="flex items-center gap-2 rounded-xl bg-white/[.035] p-2 text-xs"><span className="min-w-0 flex-1 truncate">{item.label}</span><button type="button" onClick={() => update({ launcherItems: preferences.launcherItems.filter(entry => entry.id !== item.id) })}><Trash2 className="h-3.5 w-3.5 text-rose-300/60" /></button></div>)}</div></>
  } else if (type === 'systemStatus') {
    card = <><Header type={type} accentColor={accentColor} trailing={<Activity className="h-4 w-4 text-emerald-300" />} />{system ? <div className="mt-4 grid grid-cols-2 gap-2"><Meter label="CPU" value={system.cpuUsage} accentColor={accentColor} /><Meter label="内存" value={system.memoryPercent} accentColor={accentColor} /></div> : <Empty text="浏览器模式下不可读取系统状态" />}</>
    details = system ? <div className="space-y-3"><div className="grid grid-cols-2 gap-3"><SystemPanel icon={Gauge} label="CPU 使用率" value={`${system.cpuUsage.toFixed(1)}%`} /><SystemPanel icon={MemoryStick} label="内存" value={`${formatBytes(system.memoryUsed)} / ${formatBytes(system.memoryTotal)}`} /></div>{system.disks.map(disk => <div key={disk.name} className="rounded-2xl border border-white/8 bg-white/[.035] p-4"><div className="flex items-center gap-2"><HardDrive className="h-4 w-4" style={{ color: accentColor }} /><span className="flex-1 text-sm">{disk.name}</span><span className="text-xs text-white/40">{formatBytes(disk.used)} / {formatBytes(disk.total)}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full" style={{ width: `${disk.percent}%`, background: accentColor }} /></div></div>)}</div> : <Empty text="系统状态仅在桌面客户端可用" />
    settings = <SelectSetting label="刷新频率" value={String(preferences.systemRefreshSeconds)} onChange={value => update({ systemRefreshSeconds: Number(value) })} options={[['1','每秒'],['3','每 3 秒'],['5','每 5 秒'],['10','每 10 秒']]} />
  } else if (type === 'volumeControl') {
    card = <><Header type={type} accentColor={accentColor} trailing={<span className="text-xs font-semibold tabular-nums">{volumePercent}%</span>} /><div className="mt-4 flex items-center gap-3"><button type="button" onClick={event => { event.stopPropagation(); context.onVolumeChange(context.volume > 0 ? 0 : .7) }} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/8">{context.volume > 0 ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}</button><input type="range" min="0" max="100" value={volumePercent} onClick={event => event.stopPropagation()} onChange={event => context.onVolumeChange(Number(event.target.value) / 100)} className="w-full" style={{ accentColor }} /></div></>
    details = <div className="flex h-full flex-col items-center justify-center rounded-3xl border border-white/8 bg-white/[.025]"><button type="button" onClick={() => context.onVolumeChange(context.volume > 0 ? 0 : .7)} className="flex h-24 w-24 items-center justify-center rounded-full" style={{ background: `${accentColor}28`, color: accentColor }}>{context.volume > 0 ? <Speaker className="h-10 w-10" /> : <VolumeX className="h-10 w-10" />}</button><div className="mt-5 text-5xl font-semibold tabular-nums">{volumePercent}%</div><input type="range" min="0" max="100" value={volumePercent} onChange={event => context.onVolumeChange(Number(event.target.value) / 100)} className="mt-8 w-[min(480px,80%)]" style={{ accentColor }} /><div className="mt-5 flex gap-2">{[0,25,50,75,100].map(value => <button key={value} type="button" onClick={() => context.onVolumeChange(value / 100)} className="rounded-full border border-white/10 px-4 py-2 text-xs text-white/55 hover:bg-white/10">{value}%</button>)}</div></div>
    settings = <SelectSetting label="键盘调整步长" value={String(preferences.volumeStep)} onChange={value => update({ volumeStep: Number(value) })} options={[['1','1%'],['5','5%'],['10','10%'],['20','20%']]} />
  }

  if (!WIDGET_META[type]) return null
  return <><Shell cardBlurAmount={cardBlurAmount} accentColor={accentColor} onClick={openModal}><div className="p-4">{card}</div></Shell><Modal open={open} type={type} accentColor={accentColor} onClose={closeModal} settings={settings}>{details}</Modal></>
}

function Empty({ text }: { text: string }) { return <div className="py-5 text-center text-xs text-white/30">{text}</div> }
function Stat({ label, value, large = false }: { label: string; value: string; large?: boolean }) { return <div className={`rounded-2xl border border-white/7 bg-white/[.045] ${large ? 'p-5' : 'px-3 py-2.5'}`}><div className="text-[10px] text-white/35">{label}</div><div className={`mt-1 font-semibold tabular-nums ${large ? 'text-2xl' : 'text-base'}`}>{value}</div></div> }
function Meter({ label, value, accentColor }: { label: string; value: number; accentColor: string }) { return <div className="rounded-2xl bg-white/[.04] p-3"><div className="flex justify-between text-[10px] text-white/38"><span>{label}</span><span>{Math.round(value)}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full" style={{ width: `${value}%`, background: accentColor }} /></div></div> }
function SystemPanel({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string }) { return <div className="rounded-2xl border border-white/8 bg-white/[.035] p-5"><Icon className="h-5 w-5 text-white/45" /><div className="mt-4 text-xs text-white/35">{label}</div><div className="mt-1 text-xl font-semibold">{value}</div></div> }
function SongList({ songs, onPlay, activeKey = '' }: { songs: Song[]; onPlay: (song: Song) => void; activeKey?: string }) { return <div className="space-y-1">{songs.map((song, index) => <SongRow key={`${getDesktopSongKey(song)}:${index}`} song={song} index={index} active={getDesktopSongKey(song) === activeKey} onClick={() => onPlay(song)} />)}{!songs.length && <Empty text="暂无可显示的歌曲" />}</div> }
function SelectSetting({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return <div className="mt-3 rounded-2xl border border-white/8 bg-white/[.035] p-3 text-xs text-white/55"><div className="mb-2.5">{label}</div><div className="space-y-1.5">{options.map(([id, optionLabel]) => { const selected = value === id; return <button key={id} type="button" onClick={() => onChange(id)} className="flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition" style={{ borderColor: selected ? 'rgba(103,232,249,.42)' : 'rgba(255,255,255,.06)', background: selected ? 'linear-gradient(135deg, rgba(34,211,238,.18), rgba(59,130,246,.09))' : 'rgba(255,255,255,.025)', color: selected ? '#ecfeff' : 'rgba(255,255,255,.52)' }}><span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: selected ? '#67e8f9' : 'rgba(255,255,255,.2)', background: selected ? '#67e8f9' : 'transparent', boxShadow: selected ? '0 0 12px rgba(103,232,249,.35)' : 'none' }}>{selected && <Check className="h-2.5 w-2.5 text-slate-950" strokeWidth={3} />}</span><span className="flex-1">{optionLabel}</span></button> })}</div></div>
}




