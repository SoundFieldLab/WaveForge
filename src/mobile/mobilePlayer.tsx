/**
 * 移动端播放器上下文：基于 useAudioPlayer（桌面/TV 同一引擎）驱动的精简接线。
 *
 * 与桌面 App 的差异（移动端逻辑优化）：
 *  - 交叉淡化 / 无缝衔接 / AutoMix 全部关闭 —— 移动端不做曲间智能混音，
 *    减少内存/CPU 占用与预热流量；边界行为 = 自然播完自动切下一首。
 *  - 队列、播放模式、音量、最近播放本地持久化（localStorage），冷启动恢复但不自动续播。
 *  - 锁屏/通知栏媒体控制（navigator.mediaSession）。
 *  - 取流失败自动跳下一首（连续失败 ≥3 次停止，避免无网时队列空转）。
 */
import {
  createContext, memo, useContext, useEffect, useMemo, useRef, useState, useCallback, type ReactNode,
} from 'react'
import { useAudioPlayer } from '../hooks/useAudioPlayer'
import {
  getSongUrl, getSodaPlaybackInfo, getProxiedAudioUrl, isSameSong,
  type Song,
} from '../services/musicApi'
import { platformLabel, type MusicPlatform } from '../services/platforms'
import { likeSong } from '../services/playlistService'
import {
  loadFavoriteIdentifiers, peekSongFavoriteStatus, applyFavoriteMutation, getFavoriteUserId,
} from '../services/favoriteStatusService'
import { setSecureToken } from '../services/secureTokenStore'
import { recordLogin } from '../services/loginExpiry'
import { mobileToast, songCoverUrl } from './ui'
import { getMobileEffectsScene, attachMobileEffects } from './mobileEffects'

export type MobilePlayMode = 'list' | 'random' | 'single'
/** 切歌衔接方式：直切 / 交叉淡化 / 无缝衔接（引擎原生能力，无需 Python）。 */
export type MobileTransitionMode = 'cut' | 'crossfade' | 'gapless'
const PLAY_MODE_ORDER: MobilePlayMode[] = ['list', 'random', 'single']
const TRANSITION_KEY = 'waveforge:mobile-transition'

const QUEUE_KEY = 'waveforge:mobile-queue'
const VOLUME_KEY = 'waveforge:mobile-volume'
const MODE_KEY = 'waveforge:mobile-playmode'
const RECENT_KEY = 'waveforge:mobile-recent'
const QUEUE_LIMIT = 500
const RECENT_LIMIT = 100

interface PersistedQueue {
  queue: Song[]
  index: number
  label: string
  time: number
}

function readJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function songKeyOf(song: Song): string {
  const platform = song.platform || 'netease'
  const id = platform === 'qq' ? (song.mid || song.id) : (song.appleId || song.id)
  return `${platform}:${id || ''}:${song.name}`
}

function platformUserIdOf(platform: MusicPlatform): string {
  try {
    const key = platform === 'qq' ? 'qq_user_id'
      : platform === 'netease' ? 'netease_user_id'
        : platform === 'kugou' ? 'kugou_user_id'
          : platform === 'soda' ? 'soda_user_id'
            : platform === 'spotify' ? 'spotify_user_id' : ''
    return key ? (localStorage.getItem(key) || '') : ''
  } catch {
    return ''
  }
}

/** 平台是否可在移动端播放（Apple/Spotify 取流管线暂未适配移动端）。 */
export function isMobilePlayablePlatform(platform: MusicPlatform): boolean {
  return platform === 'netease' || platform === 'qq' || platform === 'kugou' || platform === 'soda'
}

async function resolveTrackUrl(song: Song): Promise<string> {
  const platform = (song.platform || 'netease') as MusicPlatform
  if (!isMobilePlayablePlatform(platform)) {
    throw new Error(`${platformLabel(platform)}音源暂未适配移动端播放`)
  }
  if (platform === 'soda') {
    const info = await getSodaPlaybackInfo(song.id ?? song.mid ?? '', song)
    if (!info.url) throw new Error(info.vipLabel || info.reason || '汽水音源获取失败（可能需要登录）')
    return getProxiedAudioUrl(info.url)
  }
  const id = platform === 'qq' ? (song.mid || song.id) : song.id
  const raw = await getSongUrl(id, platform, 2, song)
  if (!raw) throw new Error('无法获取播放链接（可能需要登录或版权受限）')
  return getProxiedAudioUrl(raw)
}

export interface MobilePlayerApi {
  queue: Song[]
  index: number
  currentSong: Song | null
  isPlaying: boolean
  duration: number
  volume: number
  playMode: MobilePlayMode
  transitionMode: MobileTransitionMode
  contextLabel: string
  favorite: boolean
  playSongs: (songs: Song[], startIndex?: number, label?: string) => void
  playAt: (index: number) => void
  toggle: () => void
  next: () => void
  prev: () => void
  seekTo: (t: number) => void
  changeVolume: (v: number) => void
  cyclePlayMode: () => void
  setTransitionMode: (mode: MobileTransitionMode) => void
  /** 下一首播放：插入到当前曲之后。 */
  insertNext: (song: Song) => void
  /** 加入队列末尾。 */
  appendToQueue: (song: Song) => void
  /** 针对任意歌曲切喜欢（动作面板用；currentLike 为当前状态）。 */
  toggleFavoriteFor: (song: Song, currentLike: boolean) => Promise<void>
  removeAt: (index: number) => void
  toggleFavorite: () => Promise<void>
}

export interface MobileTimeApi {
  /** 播放进度（秒）：引擎 timeupdate 驱动，约 4 次/秒。 */
  currentTime: number
  /** 取流/缓冲中。 */
  isBuffering: boolean
}

const MobilePlayerContext = createContext<MobilePlayerApi | null>(null)
const MobileTimeContext = createContext<MobileTimeApi>({ currentTime: 0, isBuffering: false })

export function useMobilePlayer(): MobilePlayerApi {
  const ctx = useContext(MobilePlayerContext)
  if (!ctx) throw new Error('useMobilePlayer 必须在 MobilePlayerProvider 内使用 @ ' + String(new Error().stack).slice(0, 300))
  return ctx
}

/**
 * 播放进度/缓冲态（约 4 次/秒更新）。与 MobilePlayerApi 拆成两个 context：
 * 页面级组件（发现/搜索/我的/详情/设置）只订阅 useMobilePlayer——进度每 tick
 * 变化若混在同一 context，整个可见页面树都会跟着每秒重渲染 4 次（低端机明显掉帧）。
 * 只有迷你条/播放页这类真正显示进度的组件才订阅本 hook。
 */
export function useMobileTime(): MobileTimeApi {
  return useContext(MobileTimeContext)
}

export const MobilePlayerProvider = memo(function MobilePlayerProvider({ children }: { children: ReactNode }) {
  // ── 恢复持久化状态（一次性初始化，不做自动续播）──
  const restoredRef = useRef<PersistedQueue | null>(readJSON<PersistedQueue>(QUEUE_KEY))
  const [queue, setQueue] = useState<Song[]>(() => restoredRef.current?.queue?.filter(s => s && s.name) || [])
  const [index, setIndex] = useState<number>(() => {
    const r = restoredRef.current
    return r && r.queue?.length ? Math.min(Math.max(r.index || 0, 0), r.queue.length - 1) : -1
  })
  const [contextLabel, setContextLabel] = useState<string>(() => restoredRef.current?.label || '')
  const [isPlaying, setIsPlaying] = useState(false)
  const [isBuffering, setIsBuffering] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState<number>(() => {
    const v = Number(localStorage.getItem(VOLUME_KEY))
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.8
  })
  const [playMode, setPlayMode] = useState<MobilePlayMode>(() => {
    const v = localStorage.getItem(MODE_KEY)
    return v === 'random' || v === 'single' ? v : 'list'
  })
  // 切歌衔接：引擎原生能力（cut / 交叉淡化 / 无缝拼接）。开启后歌曲边界由引擎自动
  // 过渡（standby 起播 + 淡化/拼接），不再派发 ended，改派 transitionCommit。
  // ⚠️ 移动端固定直切：双 deck 预载在 Android WebAudio 上会偶发待机 deck 出声
  // （爆音/杂音/进度条与听感不一致），且双流抢带宽卡顿；引擎侧 preloadNext 已 no-op。
  const [transitionMode, setTransitionModeState] = useState<MobileTransitionMode>('cut')
  const [favorite, setFavorite] = useState(false)

  const queueRef = useRef(queue)
  queueRef.current = queue
  const indexRef = useRef(index)
  indexRef.current = index
  const playModeRef = useRef(playMode)
  playModeRef.current = playMode
  const volumeRef = useRef(volume)
  volumeRef.current = volume
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying
  // 进度/时长镜像（回调内部读 ref，避免回调身份随每 tick 变化 →
  // 依赖它们的 mediaSession 注册/页面 memo 全部跟着抖动）
  const currentTimeRef = useRef(currentTime)
  currentTimeRef.current = currentTime
  const durationRef = useRef(duration)
  durationRef.current = duration
  const currentSong = index >= 0 && index < queue.length ? queue[index] : null
  const currentSongRef = useRef<Song | null>(currentSong)
  currentSongRef.current = currentSong

  const consecutiveFailuresRef = useRef(0)
  const restoreSeekRef = useRef<number | null>(null)
  const recentRecordedRef = useRef<Set<string>>(new Set())

  // ── 引擎状态回灌 ──
  const onStateChange = useCallback((state: Partial<import('../audio/types').PlaybackEngineState>) => {
    if (state.isPlaying !== undefined) {
      setIsPlaying(state.isPlaying)
      if (state.isPlaying) setIsBuffering(false)
      // 播放期前台服务：进程提到 FOREGROUND，防 vivo 切后台直接清进程
      try {
        ;(window as any).WaveForgeNative?.setPlaybackActive?.(Boolean(state.isPlaying))
      } catch { /* 桥不可用忽略 */ }
    }
    if (state.currentTime !== undefined) setCurrentTime(state.currentTime)
    if (state.duration !== undefined) setDuration(state.duration)
    if (state.volume !== undefined && Number.isFinite(state.volume)) {
      setVolumeState(Math.max(0, Math.min(1, state.volume)))
    }
    // 引擎完成边界过渡（交叉淡化/无缝拼接开启时不再派发 ended）：按 targetTrackKey
    // 回写队列下标与 UI 状态；匹配不到时按顺序下一曲兜底。
    const commit = state.transitionCommit
    if (commit && !commit.isVisualSwitch) {
      const q = queueRef.current
      const targetIdx = q.findIndex(s => songKeyOf(s) === commit.targetTrackKey)
      const nextIdx = targetIdx >= 0 ? targetIdx : Math.min(indexRef.current + 1, q.length - 1)
      if (nextIdx >= 0 && nextIdx < q.length && nextIdx !== indexRef.current) {
        setIndex(nextIdx)
        indexRef.current = nextIdx
        const song = q[nextIdx]
        setDuration(Number(song.duration) > 0 ? Number(song.duration) / 1000 : 0)
        setCurrentTime(commit.targetTime || 0)
      }
    }
    if (state.ended) {
      // 直切模式（或过渡预载失败回退）自然播完：上层手动切歌
      handleEndedRef.current()
    }
  }, [])
  const handleEndedRef = useRef<() => void>(() => {})

  const crossfadeSettings = useMemo(() => (
    transitionMode === 'crossfade' ? { enabled: true, duration: 4 } : { enabled: false, duration: 4 }
  ), [transitionMode])
  const gaplessSettings = useMemo(() => (
    transitionMode === 'gapless' ? { enabled: true, albumGapless: true } : { enabled: false, albumGapless: false }
  ), [transitionMode])

  const audioPlayer = useAudioPlayer(onStateChange, crossfadeSettings, gaplessSettings, undefined, (handle: import('../hooks/useAudioPlayer').AudioGraphHandle) => {
    // 音效引擎（v2，纯 Web Audio）：场景非 off 时接入音频图
    try {
      if (getMobileEffectsScene() !== 'off') attachMobileEffects(handle)
    } catch { /* 音效失败不影响播放 */ }
  })
  // 引擎 handle 每次渲染都是新对象（useAudioPlayer 返回未 memo 的字面量）：
  // 回调一律经 ref 取最新 handle，依赖只留 [audioPlayerRef]，身份才可能稳定。
  const audioPlayerRef = useRef(audioPlayer)
  audioPlayerRef.current = audioPlayer

  // ── 加载并播放指定队列下标 ──
  const loadAndPlayIndex = useCallback(async (targetIndex: number, restoredSeek?: number) => {
    const q = queueRef.current
    if (targetIndex < 0 || targetIndex >= q.length) return
    const song = q[targetIndex]
    setIndex(targetIndex)
    indexRef.current = targetIndex
    setIsBuffering(true)
    setCurrentTime(0)
    setDuration(Number(song.duration) > 0 ? Number(song.duration) / 1000 : 0)
    try {
      const url = await resolveTrackUrl(song)
      const started = await audioPlayerRef.current.loadAndPlay(url, volumeRef.current, {
        trackKey: songKeyOf(song),
        duration: Number(song.duration) > 0 ? Number(song.duration) / 1000 : undefined,
        name: song.name,
        artists: (song.artists || []).map(a => a.name),
        songId: song.platform === 'qq' ? (song.mid || song.id) : song.id,
        mid: song.mid,
      })
      if (started) {
        consecutiveFailuresRef.current = 0
        if (restoredSeek && restoredSeek > 3) restoreSeekRef.current = restoredSeek
      }
    } catch (err) {
      setIsBuffering(false)
      const message = err instanceof Error ? err.message : '播放失败'
      mobileToast(message, 'error')
      consecutiveFailuresRef.current += 1
      // 自动链路（播完跳下一首）失败时顺延，无网/全 VIP 队列避免死循环
      if (consecutiveFailuresRef.current < 3) {
        window.setTimeout(() => { advanceRef.current(true) }, 900)
      } else {
        consecutiveFailuresRef.current = 0
      }
    }
  }, [])

  // ── 前进/后退 ──
  const advanceRef = useRef<(auto: boolean) => void>(() => {})
  const advance = useCallback((auto: boolean) => {
    const q = queueRef.current
    if (!q.length) return
    // 单曲循环：自动播完 → 回到本曲开头；手动下一首 → 顺序下一曲
    if (auto && playModeRef.current === 'single') {
      audioPlayerRef.current.seek(0)
      return
    }
    let nextIndex: number
    if (playModeRef.current === 'random' && q.length > 1) {
      do {
        nextIndex = Math.floor(Math.random() * q.length)
      } while (nextIndex === indexRef.current)
    } else {
      nextIndex = (indexRef.current + 1) % q.length
      // 顺序模式播完最后一首：停在队尾并暂停（不循环），手动点下一首才回到第一首
      if (auto && playModeRef.current === 'list' && indexRef.current === q.length - 1) {
        setIsPlaying(false)
        setCurrentTime(0)
        return
      }
    }
    void loadAndPlayIndex(nextIndex)
  }, [loadAndPlayIndex])
  advanceRef.current = advance

  const previous = useCallback(() => {
    const q = queueRef.current
    if (!q.length) return
    // 播放超过 3 秒 → 回到本曲开头（音乐 App 惯例）；读 ref 避免身份随进度抖动
    if (currentTimeRef.current > 3) {
      audioPlayerRef.current.seek(0)
      return
    }
    const prevIndex = (indexRef.current - 1 + q.length) % q.length
    void loadAndPlayIndex(prevIndex)
  }, [loadAndPlayIndex])

  handleEndedRef.current = () => { advance(true) }

  // 恢复播放（冷启动恢复队列后按播放键）：重新取流并回到上次进度
  const resumeFromRestore = useCallback(() => {
    if (indexRef.current >= 0) {
      void loadAndPlayIndex(indexRef.current, restoredRef.current?.time || 0)
    }
  }, [loadAndPlayIndex])

  const toggle = useCallback(() => {
    if (indexRef.current < 0 || !queueRef.current.length) {
      mobileToast('播放列表为空')
      return
    }
    if (!isPlayingRef.current && !currentSongRef.current) return
    // 冷启动恢复态：当前曲尚未装载（无 URL），从恢复点续播。
    // 判定读 ref（duration/currentTime 镜像），保持回调身份稳定。
    if (!isPlayingRef.current && currentSongRef.current && currentTimeRef.current < 0.2 && durationRef.current <= 0) {
      resumeFromRestore()
      return
    }
    audioPlayerRef.current.togglePlay()
  }, [resumeFromRestore])

  const playSongs = useCallback((songs: Song[], startIndex = 0, label = '') => {
    const normalized = songs.filter(s => s && s.name).slice(0, QUEUE_LIMIT)
    if (!normalized.length) {
      mobileToast('没有可播放的歌曲', 'error')
      return
    }
    const start = Math.min(Math.max(startIndex, 0), normalized.length - 1)
    setQueue(normalized)
    queueRef.current = normalized
    setContextLabel(label)
    void loadAndPlayIndex(start)
  }, [loadAndPlayIndex])

  const playAt = useCallback((targetIndex: number) => {
    void loadAndPlayIndex(targetIndex)
  }, [loadAndPlayIndex])

  const seekTo = useCallback((t: number) => {
    audioPlayerRef.current.seek(Math.max(0, t))
  }, [])

  const changeVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    setVolumeState(clamped)
    audioPlayerRef.current.setVolume(clamped)
    try { localStorage.setItem(VOLUME_KEY, String(clamped)) } catch { /* ignore */ }
  }, [])

  const cyclePlayMode = useCallback(() => {
    setPlayMode(prev => {
      const nextMode = PLAY_MODE_ORDER[(PLAY_MODE_ORDER.indexOf(prev) + 1) % PLAY_MODE_ORDER.length]
      try { localStorage.setItem(MODE_KEY, nextMode) } catch { /* ignore */ }
      mobileToast(nextMode === 'list' ? '顺序播放' : nextMode === 'random' ? '随机播放' : '单曲循环')
      return nextMode
    })
  }, [])

  const removeAt = useCallback((targetIndex: number) => {
    const q = queueRef.current
    if (targetIndex < 0 || targetIndex >= q.length) return
    const nextQueue = q.filter((_, i) => i !== targetIndex)
    setQueue(nextQueue)
    queueRef.current = nextQueue
    if (targetIndex === indexRef.current) {
      if (!nextQueue.length) {
        setIndex(-1)
        indexRef.current = -1
        if (isPlayingRef.current) audioPlayerRef.current.togglePlay()
      } else {
        const nextIndex = Math.min(targetIndex, nextQueue.length - 1)
        void loadAndPlayIndex(nextIndex)
      }
    } else if (targetIndex < indexRef.current) {
      setIndex(indexRef.current - 1)
    }
  }, [loadAndPlayIndex])

  // ── 红心状态 ──
  useEffect(() => {
    const song = currentSong
    const platform = (song?.platform || 'netease') as MusicPlatform
    if (!song || !isMobilePlayablePlatform(platform)) {
      setFavorite(false)
      return
    }
    const userId = platformUserIdOf(platform)
    if (!userId) {
      setFavorite(false)
      return
    }
    let alive = true
    setFavorite(Boolean(peekSongFavoriteStatus(song, platform, userId)))
    loadFavoriteIdentifiers(platform, userId).then(() => {
      if (alive) setFavorite(Boolean(peekSongFavoriteStatus(song, platform, userId)))
    }).catch(() => undefined)
    return () => { alive = false }
  }, [currentSong])

  const toggleFavorite = useCallback(async () => {
    const song = currentSongRef.current
    if (!song) return
    const platform = (song.platform || 'netease') as MusicPlatform
    if (!isMobilePlayablePlatform(platform)) {
      mobileToast('该平台暂不支持在移动端收藏', 'error')
      return
    }
    const userId = platformUserIdOf(platform)
    if (!userId) {
      mobileToast(`请先登录${platformLabel(platform)}`, 'error')
      return
    }
    try {
      const like = !peekSongFavoriteStatus(song, platform, userId)
      const result = await likeSong(String(song.platform === 'qq' ? (song.mid || song.id) : song.id), userId, platform, like, {
        songMid: song.mid,
        songType: song.songType,
        songName: song.name,
        songArtists: song.artists,
        songAlbumId: song.album?.id != null ? String(song.album.id) : undefined,
      })
      if (result?.code === 200 || result?.result === 100 || result?.ok) {
        setFavorite(like)
        applyFavoriteMutation({ platform, type: like ? 'like' : 'unlike', songId: String(song.id) })
        window.dispatchEvent(new CustomEvent('playlist-content-changed', {
          detail: { platform, type: like ? 'like' : 'unlike', songId: song.id, songMid: song.mid },
        }))
        mobileToast(like ? '已添加到我喜欢的音乐' : '已取消喜欢', 'success')
      } else {
        mobileToast(result?.message || result?.errorTip || '操作失败', 'error')
      }
    } catch {
      mobileToast('操作失败，请检查网络', 'error')
    }
  }, [])

  // ── 持久化队列 ──
  // 结构变化（队列/下标/上下文）立即写；播放进度**节流**写（进度每 tick 变化，
  // 原实现 4 次/秒 JSON.stringify 整个队列——500 首时每次几百 KB 序列化，纯耗电）。
  const persistQueue = useCallback((time: number) => {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify({
        queue: queueRef.current.slice(0, QUEUE_LIMIT), index: indexRef.current, label: contextLabelRef.current, time,
      } satisfies PersistedQueue))
    } catch {
      // 容量超限（封面 URL 过长等）：降级只存前 100 首
      try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify({
          queue: queueRef.current.slice(0, 100), index: Math.min(indexRef.current, 99), label: contextLabelRef.current, time,
        } satisfies PersistedQueue))
      } catch { /* ignore */ }
    }
  }, [])
  const contextLabelRef = useRef(contextLabel)
  contextLabelRef.current = contextLabel
  useEffect(() => { persistQueue(currentTimeRef.current) }, [queue, index, contextLabel, persistQueue])
  // 播放中每 10s 落一次进度；切后台/锁屏瞬间再落一次（避免丢恢复点）
  useEffect(() => {
    if (!isPlaying) return
    const timer = window.setInterval(() => persistQueue(currentTimeRef.current), 10_000)
    const onHide = () => { if (document.visibilityState === 'hidden') persistQueue(currentTimeRef.current) }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onHide)
      // 卸载（切歌收尾/关页）时补一次，恢复点不落后于最后状态
      persistQueue(currentTimeRef.current)
    }
  }, [isPlaying, persistQueue])

  // ── 最近播放（单曲粒度，去重保序，播放 20s 后记入）──
  useEffect(() => {
    const song = currentSong
    if (!song || !isPlaying || currentTime < 20) return
    const key = songKeyOf(song)
    if (recentRecordedRef.current.has(key)) return
    recentRecordedRef.current.add(key)
    try {
      const recent = readJSON<Song[]>(RECENT_KEY) || []
      const next = [song, ...recent.filter(s => !isSameSong(s, song))].slice(0, RECENT_LIMIT)
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch { /* ignore */ }
  }, [currentSong, isPlaying, currentTime])

  // ── 恢复进度一次性 seek ──
  useEffect(() => {
    if (restoreSeekRef.current != null && isPlaying && duration > 0) {
      const t = restoreSeekRef.current
      restoreSeekRef.current = null
      audioPlayerRef.current.seek(t)
    }
  }, [isPlaying, duration])

  // ── 预加载下一首（已起播后静默解析 URL，交给引擎预热）──
  const preloadedKeyRef = useRef('')
  useEffect(() => {
    if (!isPlaying || !currentSong) return
    // 直切模式不预载：移动网络下双流并发会与当前曲抢带宽（实测卡顿根源），
    // 仅在开启交叉淡化/无缝衔接（引擎边界过渡依赖预载）时才预热下一首。
    if (transitionMode === 'cut') return
    const q = queueRef.current
    if (q.length < 2 || playModeRef.current === 'single') return
    let nextSong: Song | undefined
    if (playModeRef.current === 'random') {
      nextSong = q[Math.floor(Math.random() * q.length)]
    } else {
      nextSong = indexRef.current + 1 < q.length ? q[indexRef.current + 1] : undefined
    }
    if (!nextSong) return
    const preloadKey = songKeyOf(nextSong)
    if (preloadedKeyRef.current === preloadKey) return
    preloadedKeyRef.current = preloadKey
    resolveTrackUrl(nextSong).then(url => {
      audioPlayerRef.current.preloadNext({
        url,
        trackKey: preloadKey,
        duration: Number(nextSong!.duration) > 0 ? Number(nextSong!.duration) / 1000 : undefined,
        name: nextSong!.name,
        artists: (nextSong!.artists || []).map(a => a.name),
      })
    }).catch(() => undefined)
  }, [isPlaying, currentSong, transitionMode])

  // ── 锁屏 / 通知栏媒体控制 ──
  // toggle/advance/previous/seekTo 身份稳定（回调读 ref）：本 effect 不再随播放进度
  // 每 tick 重跑（原实现 4 次/秒重建 MediaMetadata + 重挂全部 action handler）。
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    if (currentSong) {
      ms.metadata = new MediaMetadata({
        title: currentSong.name || '未知歌曲',
        artist: (currentSong.artists || []).map(a => a.name).join(' / '),
        album: currentSong.album?.name || '',
        artwork: songCoverUrl(currentSong, 300)
          ? [{ src: songCoverUrl(currentSong, 300), sizes: '300x300' }]
          : [],
      })
    }
    ms.playbackState = isPlaying ? 'playing' : 'paused'
    try {
      ms.setActionHandler('play', () => toggle())
      ms.setActionHandler('pause', () => toggle())
      ms.setActionHandler('nexttrack', () => advance(false))
      ms.setActionHandler('previoustrack', () => previous())
      ms.setActionHandler('seekto', details => {
        if (details.seekTime != null) seekTo(details.seekTime)
      })
    } catch { /* 部分内核不支持全部动作 */ }
  }, [currentSong, isPlaying, toggle, advance, previous, seekTo])

  const setTransitionMode = useCallback((mode: MobileTransitionMode) => {
    // 移动端固定直切（双 deck 预载在 Android 上不稳定，见初始 state 注释）
    void mode
    setTransitionModeState('cut')
    try { localStorage.removeItem(TRANSITION_KEY) } catch { /* ignore */ }
  }, [])

  const insertNext = useCallback((song: Song) => {
    const q = [...queueRef.current]
    if (!q.length) {
      setQueue([song]); queueRef.current = [song]
      setIndex(0); indexRef.current = 0
      void loadAndPlayIndex(0)
      return
    }
    const at = Math.max(0, Math.min(indexRef.current + 1, q.length))
    q.splice(at, 0, song)
    setQueue(q); queueRef.current = q
    if (indexRef.current >= at) { setIndex(indexRef.current + 1); indexRef.current += 1 }
    mobileToast('将在下一首播放', 'success')
  }, [loadAndPlayIndex])

  const appendToQueue = useCallback((song: Song) => {
    const q = [...queueRef.current, song]
    setQueue(q); queueRef.current = q
    if (indexRef.current < 0) { setIndex(0); indexRef.current = 0; void loadAndPlayIndex(0) }
    mobileToast('已加入队列末尾', 'success')
  }, [loadAndPlayIndex])

  const toggleFavoriteFor = useCallback(async (song: Song, currentLike: boolean) => {
    const platform = (song.platform || 'netease') as MusicPlatform
    const userId = platformUserIdOf(platform)
    if (!userId) { mobileToast(`请先登录${platformLabel(platform)}`, 'error'); return }
    try {
      const result = await likeSong(String(song.platform === 'qq' ? (song.mid || song.id) : song.id), userId, platform, !currentLike, {
        songMid: song.mid,
        songType: song.songType,
        songName: song.name,
        songArtists: song.artists,
        songAlbumId: song.album?.id != null ? String(song.album.id) : undefined,
      })
      if (result?.code === 200 || result?.result === 100 || result?.ok) {
        applyFavoriteMutation({ platform, type: !currentLike ? 'like' : 'unlike', songId: String(song.id) })
        window.dispatchEvent(new CustomEvent('playlist-content-changed', {
          detail: { platform, type: !currentLike ? 'like' : 'unlike', songId: song.id, songMid: song.mid },
        }))
        mobileToast(!currentLike ? '已添加到我喜欢的音乐' : '已取消喜欢', 'success')
      } else {
        mobileToast(result?.message || '操作失败', 'error')
      }
    } catch { mobileToast('操作失败，请检查网络', 'error') }
  }, [])

  const api: MobilePlayerApi = useMemo(() => ({
    queue, index, currentSong, isPlaying, duration, volume,
    playMode, transitionMode, contextLabel, favorite,
    playSongs, playAt, toggle, next: () => advanceRef.current(false), prev: previous, seekTo,
    changeVolume, cyclePlayMode, setTransitionMode, insertNext, appendToQueue, toggleFavoriteFor,
    removeAt, toggleFavorite,
  }), [queue, index, currentSong, isPlaying, duration, volume, playMode, transitionMode, contextLabel,
    favorite, playSongs, playAt, toggle, previous, seekTo, changeVolume, cyclePlayMode, setTransitionMode,
    insertNext, appendToQueue, toggleFavoriteFor, removeAt, toggleFavorite])

  const timeApi = useMemo(() => ({ currentTime, isBuffering }), [currentTime, isBuffering])

  return (
    <MobilePlayerContext.Provider value={api}>
      <MobileTimeContext.Provider value={timeApi}>{children}</MobileTimeContext.Provider>
    </MobilePlayerContext.Provider>
  )
})

// 重导出常用工具（登录态初始化用）
export { setSecureToken, recordLogin, platformUserIdOf, getFavoriteUserId }
