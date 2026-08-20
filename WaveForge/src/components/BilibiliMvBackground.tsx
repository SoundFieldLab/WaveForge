/**
 * 哔哩哔哩「MV 背景」层（ECHO NEXT 风格）
 *
 * 作为歌词页/播放页的背景层：匹配当前歌曲的 B 站视频，静音循环播放，
 * 画面时间跟随本地音频时钟（偏差超阈值才 seek 校正一次），歌曲音频始终由本地引擎播放。
 * - auto → 直接播放（高置信）
 * - confirm → 底部轻量候选条（点选即播放并记忆）
 * - none/error → 保持透明，短暂提示
 * - 播放失败 → 沿 fallbackChain 自动尝试下一候选
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Search, X, Clock, Eye } from 'lucide-react'
import {
  findBestBilibiliMv,
  getBilibiliView,
  getBilibiliPlayUrl,
  bilibiliStreamUrl,
  pickBestPage,
  songKeyOf,
  setBilibiliOverride,
  getBilibiliOverride,
  clearBilibiliOverride,
  getBilibiliWatchSettings,
  resolveBiliPic,
  formatBiliTime,
  type MatchContext,
  type CandidateScore,
  type CandidateType,
} from '../services/bilibiliApi'
import { computeMvSyncTarget, shouldSeekMvVideo } from '../services/mvBackground'

type MvBackgroundStatus = 'idle' | 'searching' | 'loading' | 'playing' | 'confirm' | 'none' | 'error'

/** 即将播放的歌曲（预加载评分高的视频，与看歌模式同一数据源） */
export interface MvBackgroundUpcomingSong {
  songTitle: string
  songArtists: string[]
  songDuration: number
  platform?: string
  id?: string | number
}

interface BilibiliMvBackgroundProps {
  songTitle: string
  songArtists: string[]
  /** 歌曲时长（秒） */
  songDuration: number
  platform?: string
  songId?: string | number
  isPlaying: boolean
  getAudioElement: () => HTMLAudioElement | null
  playerTheme?: 'light' | 'dark'
  /** 即将播放的歌曲：提前匹配 MV 填充缓存（切到该歌时秒播） */
  upcomingSongs?: MvBackgroundUpcomingSong[]
  /**
   * 未找到 MV / 播放失败时的回退回调：true = 请外部切回普通封面背景。
   * 组件进入死胡同（none/error/候选条被关闭）时上报 true；恢复播放时上报 false。
   */
  onFallbackChange?: (fallback: boolean) => void
  /**
   * 已加载视频上报：切到看歌时复用同一视频流，避免重新搜索/拉流卡顿。
   * 加载成功上报 {bvid, cid, videoUrl, cacheKey, currentTime}；失败/死胡同/卸载时上报 null。
   */
  onPlayStateChange?: (state: { bvid: string; cid: number; videoUrl: string; cacheKey: string; currentTime: number } | null) => void
  /**
   * 开关关闭时不清空已缓冲的视频（display:none 隐藏 + 暂停），重开秒播不重新加载。
   * 默认 true；置 false 只隐藏，搜索/加载照常，恢复后立即续播。
   */
  enabled?: boolean
  /** 视频背景模糊度（px，独立于封面背景的模糊设置；默认 0 = 视频清晰显示） */
  blur?: number
  /**
   * 过渡目标歌曲（automix/无缝/普通切歌的 audio 过渡期间由 App 下发）。
   * 过渡进行时提前匹配并预载目标 MV（新 MV 叠旧 MV 渐现，与封面过渡一致），
   * 过渡提交后由主路径（songKey 变化）无缝接管。null = 无过渡。
   */
  transitionToTrack?: {
    trackKey: string
    coverUrl: string
    title: string
    artist: string
    dominantColor?: string | null
    duration?: number
    platform?: string
    id?: string | number
  } | null
  /** 过渡进度 0-1：过渡期预载的 MV 以其为透明度叠在旧 MV 上渐入 */
  transitionProgress?: number
  /** 当前歌曲在 App 层的稳定 trackKey（用于跳过"过渡目标就是当前歌"的重复预载） */
  songTrackKey?: string
}

/** 上报给外部的播放状态（用于看歌无缝接管） */
export interface MvBackgroundPlayState {
  bvid: string
  cid: number
  videoUrl: string
  /** 播放接口的 cacheKey：看歌据此直接生成音频流 URL，跳过重新请求播放地址 */
  cacheKey: string
  currentTime: number
}

const TYPE_BADGES: Record<CandidateType, { label: string; color: string }> = {
  official: { label: '官方', color: '#FB7299' },
  live: { label: '现场', color: '#4C8DFF' },
  cover: { label: '翻唱', color: '#F5A623' },
  instrumental: { label: '演奏', color: '#8B7CF6' },
  lyrics: { label: '字幕', color: '#52C41A' },
  other: { label: '其他', color: '#8A8F99' },
}

function formatPlayCount(play: number): string {
  if (play >= 100000000) return `${(play / 100000000).toFixed(1)}亿`
  if (play >= 10000) return `${(play / 10000).toFixed(1)}万`
  return String(play || 0)
}

export default function BilibiliMvBackground({
  songTitle,
  songArtists,
  songDuration,
  platform,
  songId,
  isPlaying,
  getAudioElement,
  playerTheme = 'dark',
  upcomingSongs = [],
  onFallbackChange,
  onPlayStateChange,
  enabled = true,
  blur = 0,
  transitionToTrack = null,
  transitionProgress = 0,
  songTrackKey = '',
}: BilibiliMvBackgroundProps) {
  const slotARef = useRef<HTMLVideoElement>(null)
  const slotBRef = useRef<HTMLVideoElement>(null)
  const searchControllerRef = useRef<AbortController | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const fallbackChainRef = useRef<CandidateScore[]>([])
  // 看歌无缝接管：最新播放状态经 ref 上报（含实时进度）
  const onPlayStateChangeRef = useRef(onPlayStateChange)
  onPlayStateChangeRef.current = onPlayStateChange
  const lastPlayStateRef = useRef<{ bvid: string; cid: number; videoUrl: string; cacheKey: string } | null>(null)
  const failedBvidsRef = useRef<Set<string>>(new Set())
  // getAudioElement 每次渲染都是新函数，同步循环里经 ref 读取避免 effect 反复重建
  const getAudioRef = useRef(getAudioElement)
  getAudioRef.current = getAudioElement
  // 歌曲元数据经 ref 读取：App 每次渲染 songArtists 都是新数组引用，
  // 若进 effect 依赖会导致搜索/加载每帧重跑、video 反复卸载重建（闪烁）。仅 songKey 变化才重新匹配。
  const songRef = useRef({ songTitle, songArtists, songDuration, platform, songId })
  songRef.current = { songTitle, songArtists, songDuration, platform, songId }

  const [status, setStatus] = useState<MvBackgroundStatus>('idle')
  // MV 从未启用过就不搜索（避免开关关闭时每首歌白调 B 站接口）；启用过则保持视频缓冲待用
  const wasEnabledRef = useRef(enabled)
  wasEnabledRef.current = wasEnabledRef.current || enabled
  const searchedSongKeyRef = useRef('')
  // A/B 双视频槽位：切歌时旧视频继续播放，新视频在另一槽位缓冲好后盖在旧视频上渐入（封面式过渡，无黑屏）
  const [slotAUrl, setSlotAUrl] = useState<string | null>(null)
  const [slotBUrl, setSlotBUrl] = useState<string | null>(null)
  const [activeSlot, setActiveSlot] = useState<'A' | 'B'>('A')
  const activeSlotRef = useRef<'A' | 'B'>('A')
  // 正在盖在旧视频上渐入的新槽（opacity 0→1，promote 后成为 active 并清掉旧槽）
  const [incomingSlot, setIncomingSlot] = useState<'A' | 'B' | null>(null)
  const incomingSlotRef = useRef<'A' | 'B' | null>(null)
  // 首个视频渐入：组件刚启用/首首歌时没有旧视频可叠，视频在封面上方从透明渐入
  const [firstFadeDone, setFirstFadeDone] = useState(false)
  const firstFadeDoneRef = useRef(false)
  // 已放入但未淡入的槽位（等待 canplay / 过渡期由 transitionProgress 驱动）
  const stagedSlotRef = useRef<'A' | 'B' | null>(null)
  const crossfadeTimerRef = useRef<number | null>(null)
  // 过渡目标去重：同一目标只预载一次（切歌/过渡结束在主路径重置）
  const lastTransitionTargetRef = useRef('')
  // 过渡激活状态经 ref 读取：同步循环/事件处理器等长生命闭包需要最新值（effect 依赖不含该 prop）
  const transitionActiveRef = useRef(false)
  // 当前歌曲 key 的最新渲染值：主路径 effect 的闭包可能捕获旧 songTrackKey（commit 时序），
  // 接管判断必须用 ref 读取最新值，否则预载（下一曲）与旧 key 不匹配 → 显示上一曲 MV
  const songTrackKeyRef = useRef(songTrackKey)
  songTrackKeyRef.current = songTrackKey
  // 过渡预载状态：commit 时主路径据此直接接管预载视频（跳过重新搜索/拉流），
  // 避免过渡结束后重拉 playurl + 视频重载导致旧 MV 回显约 1s；failed 时主路径走正常流程
  const transitionPreloadRef = useRef<{ trackKey: string; failed: boolean } | null>(null)
  // 最新过渡目标（ref）：预载 effect 的 cleanup 需要判断"是过渡目标被替换还是 commit"。
  // React 先跑旧 effect 的 cleanup 再跑新 effect——commit 时 songTrackKey 变化也会触发
  // 该 effect 重跑，若 cleanup 无脑清预载，主路径接管时预载已丢失 → 封面重载数秒。
  const transitionTargetRef = useRef(transitionToTrack)
  transitionTargetRef.current = transitionToTrack
  const [candidates, setCandidates] = useState<CandidateScore[]>([])
  const [showCandidates, setShowCandidates] = useState(false)
  const [notice, setNotice] = useState('')

  const songKey = songKeyOf({ songTitle, artists: songArtists, songDuration, platform, id: songId })

  const showNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 4000)
  }, [])

  const slotUrl = (slot: 'A' | 'B') => (slot === 'A' ? slotAUrl : slotBUrl)
  // 过渡期（automix/无缝/普通切歌的 audio 过渡期间）为 true：预载的目标 MV 以 transitionProgress 叠在旧 MV 上渐入
  const transitionActive = Boolean(transitionToTrack?.trackKey)
  transitionActiveRef.current = transitionActive
  const slotOpacity = (slot: 'A' | 'B') => {
    if (slot === incomingSlot) return 1
    if (slot === activeSlot) return firstFadeDone ? 1 : 0
    if (transitionActive && stagedSlotRef.current === slot) return transitionProgress
    return 0
  }
  // 过渡期槽位透明度跟随 progress（~30ms 级更新）用短过渡平滑；其余槽位保持常规 0.65s 渐入
  const slotTransition = (slot: 'A' | 'B') =>
    transitionActive && stagedSlotRef.current === slot ? 'opacity 120ms linear' : 'opacity 0.65s ease'
  // 分层：正在渐入的新视频（incoming / 过渡期预载槽）必须置顶，否则会被 opacity:1 的旧视频盖住
  // （A/B 槽 DOM 顺序固定，B 天然在 A 之上；不显式分层时"新盖旧"只在 B 槽才可见）
  const slotZIndex = (slot: 'A' | 'B') => {
    if (slot === incomingSlot) return 2
    if (transitionActive && stagedSlotRef.current === slot) return 2
    if (slot === activeSlot) return 1
    return 0
  }
  const slotEl = (slot: 'A' | 'B') => (slot === 'A' ? slotARef.current : slotBRef.current)
  const activeEl = () => slotEl(activeSlotRef.current)
  const otherSlot = (slot: 'A' | 'B') => (slot === 'A' ? 'B' : 'A')

  const loadVideo = useCallback(
    (candidate: CandidateScore, chainIndex = 0, stagedOnly = false) => {
      const controller = new AbortController()
      searchControllerRef.current?.abort()
      searchControllerRef.current = controller
      setStatus('loading')
      const { songTitle: st, songArtists: sa, songDuration: sd } = songRef.current

      void (async () => {
        try {
          let cid = candidate.cid || 0
          if (!cid) {
            const view = await getBilibiliView(candidate.video.bvid, controller.signal)
            if (view.code !== 0) throw new Error(view.code === -404 ? '视频已失效或删除' : '获取视频信息失败')
            // 多 P（选集）视频：挑选最匹配歌曲的分 P（on vocal/歌名命中优先）
            if (Array.isArray(view.data.pages) && view.data.pages.length > 1) {
              const bestIndex = pickBestPage(view.data.pages, { songTitle: st, artists: sa })
              const chosen = view.data.pages[bestIndex]
              if (chosen?.cid) cid = chosen.cid
            }
            if (!cid) cid = view.data.cid
          }
          const settings = getBilibiliWatchSettings()
          const qn = settings.targetQuality === 'auto' ? 127 : settings.targetQuality
          const playInfo = await getBilibiliPlayUrl(candidate.video.bvid, cid, qn, controller.signal)
          if (playInfo.code === -404) throw new Error('视频已失效或删除')
          if (playInfo.code !== 0 || !playInfo.cacheKey) throw new Error(playInfo.error || '获取播放地址失败')
          const newVideoUrl = bilibiliStreamUrl(playInfo.cacheKey, 'video')
          lastPlayStateRef.current = { bvid: candidate.video.bvid, cid, videoUrl: newVideoUrl, cacheKey: playInfo.cacheKey }
          const currentActiveEl = activeEl()
          const currentActiveUrl = currentActiveEl?.currentSrc || currentActiveEl?.src || null
          if (!currentActiveUrl || currentActiveUrl === newVideoUrl) {
            // 首个视频 / 同一视频：直接进当前槽位，无需过渡
            if (activeSlotRef.current === 'A') setSlotAUrl(newVideoUrl)
            else setSlotBUrl(newVideoUrl)
            stagedSlotRef.current = null
          } else {
            // 换歌：新视频放另一槽位（隐藏缓冲），canplay 后盖在旧视频上渐入
            const stage = otherSlot(activeSlotRef.current)
            stagedSlotRef.current = stage
            // 该槽正作为新视频淡入/待晋升：新目标顶掉它，取消旧晋升定时器并重置 incoming（避免残留 opacity:1 直接弹出）
            if (crossfadeTimerRef.current) {
              window.clearTimeout(crossfadeTimerRef.current)
              crossfadeTimerRef.current = null
            }
            if (incomingSlotRef.current === stage) {
              incomingSlotRef.current = null
              setIncomingSlot(null)
            }
            if (stage === 'A') setSlotAUrl(newVideoUrl)
            else setSlotBUrl(newVideoUrl)
            // 过渡期预载的目标视频已在槽内且就绪：canplay 不会再次触发。
            // stagedOnly（预载路径）时**不 beginCrossfade**——预载只需缓冲，active 槽
            // 切换必须等 commit 时主路径接管；否则 active 提前切到下一曲、旧槽 1s 后被
            // 清空 → commit 时 staged 已消费、无槽可接管 → 重新搜索 → MV 残留/张冠李戴。
            const stageEl = slotEl(stage)
            if (stageEl && (stageEl.currentSrc || stageEl.src) === newVideoUrl && stageEl.readyState >= 2) {
              if (!stagedOnly) beginCrossfade(stage)
            }
          }
          setStatus('playing')
          onPlayStateChangeRef.current?.({ ...lastPlayStateRef.current, currentTime: activeEl()?.currentTime || 0 })
        } catch (error) {
          if (controller.signal.aborted) return
          // 手动记住的视频失效 → 清除记忆，避免每次切到这首歌都卡住
          if (getBilibiliOverride(songKey) === candidate.video.bvid) clearBilibiliOverride(songKey)
          const message = error instanceof Error ? error.message : 'MV 加载失败'
          failedBvidsRef.current.add(candidate.video.bvid)
          const nextIndex = fallbackChainRef.current.findIndex((c, i) => i > chainIndex && !failedBvidsRef.current.has(c.video.bvid))
          if (nextIndex >= 0) {
            void loadVideo(fallbackChainRef.current[nextIndex], nextIndex)
            return
          }
          setStatus('error')
          showNotice(message)
        }
      })()
    },
    [songKey, showNotice],
  )

  // 待淡入槽位的视频缓冲完成 → 开始过渡：新槽盖在旧槽上 0→1 渐现（封面式"视频过渡"），
  // 完成后新槽晋升为 active 并释放旧槽。快速切歌时该槽若已被新目标顶掉，定时器直接放弃本次晋升。
  const beginCrossfade = (slot: 'A' | 'B') => {
    if (stagedSlotRef.current !== slot) return
    const prevActive = activeSlotRef.current
    stagedSlotRef.current = null
    incomingSlotRef.current = slot
    setIncomingSlot(slot)
    setStatus('playing')
    if (crossfadeTimerRef.current) window.clearTimeout(crossfadeTimerRef.current)
    crossfadeTimerRef.current = window.setTimeout(() => {
      crossfadeTimerRef.current = null
      // 该槽已被更新的目标顶掉（incoming 被重置）：放弃本次晋升
      if (incomingSlotRef.current !== slot) return
      activeSlotRef.current = slot
      incomingSlotRef.current = null
      setActiveSlot(slot)
      setIncomingSlot(null)
      firstFadeDoneRef.current = true
      setFirstFadeDone(true)
      // 旧槽已被新槽盖住：清空释放（快速切歌时该槽可能已被新视频复用，复用则跳过）
      if (prevActive === 'A' && activeSlotRef.current !== 'A') setSlotAUrl(null)
      else if (prevActive === 'B' && activeSlotRef.current !== 'B') setSlotBUrl(null)
    }, 1000)
  }

  // 切歌/首次挂载：自动匹配当前歌曲（仅 songKey 变化才重跑，避免 App 每 ~1s 重渲染导致视频反复卸载）。
  // MV 从未启用过（开关关闭且没启用过）则不搜索，避免每首歌白调 B 站接口；开关关→开时补搜一次。
  useEffect(() => {
    if (!enabled && !wasEnabledRef.current) return
    // 开关关闭但此前启用过：保留已加载视频，不重复搜索（开关打开时 enabled 变化会再触发）
    if (!enabled && searchedSongKeyRef.current === songKey) return
    searchedSongKeyRef.current = songKey
    // 新歌就位：过渡目标去重标记重置，后续同目标的过渡重新预载
    lastTransitionTargetRef.current = ''
    // 歌曲已切换：若新歌 MV 未就绪，立即隐藏旧歌 MV（封面兜底），
    // 避免"过渡完毕到下一曲"后仍显示上一曲 MV；新 MV 就绪后由 canplay 淡入
    const hideOldMv = () => {
      const active = activeSlotRef.current
      if (active === 'A') setSlotAUrl(null)
      else setSlotBUrl(null)
    }
    // 过渡预载接管：预载目标即当前歌时直接晋升预载视频（就绪即过渡、未就绪等 canplay），
    // 跳过重新搜索/拉流——否则 commit 瞬间会重拉 playurl + 视频重载，旧 MV 回显约 1s。
    // 用 songTrackKeyRef（最新渲染值）而非本 effect 闭包捕获的 songTrackKey——commit 时
    // 若 App 的 currentSong 更新与本 effect 触发不在同一渲染，闭包可能还是**上一曲**的 key，
    // 预载（下一曲）与之不匹配 → 重新搜索旧歌 MV → commit 后显示上一曲 MV（用户实测"张冠李戴"）。
    const preload = transitionPreloadRef.current
    transitionPreloadRef.current = null
    const currentKey = songTrackKeyRef.current
    if (preload && !preload.failed && preload.trackKey === currentKey) {
      const staged = stagedSlotRef.current
      console.log('[MvBackground] commit 接管预载 ✓', songTrackKey, '| staged:', staged || '无', '| readyState:', staged ? slotEl(staged)?.readyState : '-')
      if (staged) {
        const stagedEl = slotEl(staged)
        if (stagedEl && stagedEl.readyState >= 2) {
          beginCrossfade(staged)
          setStatus('playing')
          return
        }
        // 已放 URL 未就绪：保留缓冲，等 canplay → beginCrossfade（不重拉流丢弃已缓冲数据）
        hideOldMv()
        return
      }
      // 预载拉流中（尚未放 URL）：不打断，预载 loadVideo 完成后由 canplay 接管
      hideOldMv()
      return
    }
    // 无预载（普通切歌/预载失败）：旧 MV 立即隐藏，等新 MV 搜索加载好后淡入
    if (!preload) {
      console.log('[MvBackground] commit 时无预载（未触发/已消费）→ 重新搜索', songTrackKey)
    } else {
      console.log('[MvBackground] commit 预载不可用（failed 或目标不匹配）', preload.trackKey, '≠', songTrackKey)
    }
    hideOldMv()
    let cancelled = false
    const controller = new AbortController()
    searchControllerRef.current?.abort()
    searchControllerRef.current = controller
    failedBvidsRef.current = new Set()
    fallbackChainRef.current = []
    lastPlayStateRef.current = null
    onPlayStateChangeRef.current?.(null) // 旧歌曲视频作废，切看歌时不复用
    // 旧 MV 已在上方隐藏（封面兜底）：歌曲已切换，不能再展示上一曲画面；
    // 新 MV 搜索加载好后由 canplay → beginCrossfade 淡入
    setStatus('searching')
    setShowCandidates(false)
    setCandidates([])

    void (async () => {
      const { songTitle: st, songArtists: sa, songDuration: sd, platform: pf, songId: sid } = songRef.current
      const ctx: MatchContext = { songTitle: st, artists: sa, songDuration: sd, platform: pf, id: sid }
      const result = await findBestBilibiliMv(ctx, { signal: controller.signal })
      if (cancelled || controller.signal.aborted) return
      if (result.status === 'auto' && result.best) {
        fallbackChainRef.current = result.fallbackChain
        loadVideo(result.best)
      } else if (result.status === 'confirm') {
        setCandidates(result.candidates)
        setStatus('confirm')
        setShowCandidates(true)
      } else if (result.status === 'none') {
        setStatus('none')
        showNotice('未找到相关 MV')
      } else {
        setStatus('error')
        showNotice(result.error || 'MV 匹配失败')
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey, enabled])

  // 预加载：为即将播放的歌曲提前匹配评分高的视频（findBestBilibiliMv 结果按歌缓存 24h，
  // 切到该歌时直接命中缓存秒播；与看歌模式同款逻辑，不阻塞当前播放）
  useEffect(() => {
    if (!enabled && !wasEnabledRef.current) return
    if (!upcomingSongs?.length) return
    const preloadController = new AbortController()
    for (const upcoming of upcomingSongs.slice(0, 2)) {
      void findBestBilibiliMv(
        { songTitle: upcoming.songTitle, artists: upcoming.songArtists, songDuration: upcoming.songDuration, platform: upcoming.platform, id: upcoming.id },
        { signal: preloadController.signal, settings: getBilibiliWatchSettings() },
      ).catch(() => { /* 预加载失败静默 */ })
    }
    return () => preloadController.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey, JSON.stringify(upcomingSongs || [])])

  // 过渡目标预载：automix/无缝/普通切歌的 audio 过渡期间（commit 之前 currentSong 未变），
  // App 下发 transitionToTrack——提前匹配并缓冲目标歌 MV，用 transitionProgress 盖在旧 MV 上渐现，
  // 与封面过渡同步；过渡提交后主路径（songKey 变化）无缝接管。目标即当前歌/未启用时跳过。
  useEffect(() => {
    const target = transitionToTrack
    if (!target?.trackKey) return
    if (!enabled) return
    if (target.trackKey === songTrackKey) return
    if (target.trackKey === lastTransitionTargetRef.current) return
    lastTransitionTargetRef.current = target.trackKey
    const controller = new AbortController()
    searchControllerRef.current?.abort()
    searchControllerRef.current = controller
    // 标记预载进行中：commit 时主路径据此直接接管，跳过重新搜索/拉流（避免旧 MV 回显 1s）
    transitionPreloadRef.current = { trackKey: target.trackKey, failed: false }
    console.log('[MvBackground] 过渡预载开始 →', target.trackKey, '| 当前歌:', songTrackKey)
    const markFailed = () => {
      if (transitionPreloadRef.current?.trackKey === target.trackKey) {
        transitionPreloadRef.current = { trackKey: target.trackKey, failed: true }
      }
    }
    void (async () => {
      try {
        const ctx: MatchContext = {
          songTitle: target.title || '',
          artists: (target.artist || '').split(',').map((s) => s.trim()).filter(Boolean),
          songDuration: typeof target.duration === 'number' && target.duration > 0
            ? target.duration
            : songRef.current.songDuration,
          platform: target.platform,
          id: target.id,
        }
        const result = await findBestBilibiliMv(ctx, { signal: controller.signal })
        if (controller.signal.aborted || searchControllerRef.current !== controller) return
        if (result.status === 'auto' && result.best) {
          console.log('[MvBackground] 过渡预载命中 →', result.best.video.title || result.best.video.bvid, '| 开始拉流（仅缓冲，不切换）')
          fallbackChainRef.current = result.fallbackChain
          loadVideo(result.best, 0, true)
        } else {
          // confirm/none/error 静默：标记失败，让主路径在提交后用完整上下文重新匹配（结果按歌缓存 24h）
          console.log('[MvBackground] 过渡预载未命中（confirm/none/error）', result.status)
          markFailed()
        }
      } catch {
        markFailed()
      }
    })()
    return () => {
      // 过渡目标被替换成**另一首有效歌曲**时才清理旧目标的预载/缓冲槽；
      // transitionToTrack 被清空（commit 后 App 释放目标引用）时**保留**预载——
      // 主路径（songKey 变化）在 commit 后无缝接管，否则预载视频被丢弃 →
      // 重新搜索 → 封面背景重载数秒（用户反复反馈的问题）。
      const currentTarget = transitionTargetRef.current
      if (currentTarget?.trackKey && currentTarget.trackKey !== target.trackKey) {
        console.log('[MvBackground] 过渡目标被替换，清理旧预载', target.trackKey, '→', currentTarget.trackKey)
        transitionPreloadRef.current = null
        controller.abort()
        const staged = stagedSlotRef.current
        if (staged) {
          stagedSlotRef.current = null
          if (staged === 'A') setSlotAUrl(null)
          else setSlotBUrl(null)
        }
      } else if (transitionTargetRef.current === null || transitionTargetRef.current?.trackKey === undefined) {
        console.log('[MvBackground] commit 后目标清空，保留预载给主路径接管', target.trackKey)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitionToTrack?.trackKey, songTrackKey, enabled])

  // 死胡同状态（未找到 / 匹配失败 / 播放失败 / 候选条被关闭）→ 通知外部回退到普通封面背景；
  // 恢复播放（搜索中/加载中/候选选择中）→ 通知取消回退。外部据此在 MV 层与封面层之间切换。
  useEffect(() => {
    const fallbackActive = status === 'none' || status === 'error' || (status === 'confirm' && !showCandidates)
    onFallbackChange?.(fallbackActive)
  }, [status, showCandidates, onFallbackChange])

  // 同步循环：视频时间 = 音频位置 % 视频时长，偏差超阈值才 seek。
  // fMP4 的 duration 在缓冲期不稳定，且反复 seek 会触发重新缓冲（黑屏）；
  // 因此只在 readyState>=2、非 seeking、时长有限时校正，阈值 0.9s（原 1.5s 时漂移可感知）。
  // 双槽位：pendingStage 期间当前槽自由播放（避免被 seek 到新歌位置跳变），
  // 过渡期预载槽同样自由播放，等提交后主路径接管再同步。
  useEffect(() => {
    if (!isPlaying || !enabled) {
      for (const ref of [slotARef, slotBRef]) {
        if (ref.current && !ref.current.paused) ref.current.pause()
      }
      return
    }
    let raf = 0
    let lastReport = 0
    const tick = () => {
      const audio = getAudioRef.current()
      const pendingStage = stagedSlotRef.current !== null
      for (const [ref, slot] of [[slotARef, 'A'], [slotBRef, 'B']] as const) {
        const video = ref.current
        if (!video || !audio) continue
        const isActive = slot === activeSlotRef.current
        if (pendingStage && isActive) continue
        // 过渡期预载的目标 MV（盖在旧 MV 上渐入中）：自由播放，等提交后主路径接管再同步，避免 seek 到旧歌位置跳变
        if (transitionActiveRef.current && stagedSlotRef.current === slot) continue
        const target = computeMvSyncTarget(audio.currentTime, video.duration)
        if (target !== null && video.readyState >= 2 && !video.seeking && shouldSeekMvVideo(video.currentTime, target, 0.9)) {
          video.currentTime = target
        }
        if (video.paused && video.readyState >= 2) void video.play().catch(() => undefined)
      }
      // 节流上报实时进度（约 1s 一次），供切到看歌时无缝续播
      const now = performance.now()
      const active = activeEl()
      if (lastPlayStateRef.current && active && now - lastReport > 1000) {
        lastReport = now
        onPlayStateChangeRef.current?.({ ...lastPlayStateRef.current, currentTime: active.currentTime || 0 })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, enabled])

  // 卸载清理
  useEffect(() => {
    return () => {
      searchControllerRef.current?.abort()
      for (const ref of [slotARef, slotBRef]) {
        if (ref.current) {
          ref.current.pause()
          ref.current.removeAttribute('src')
          ref.current.load()
        }
      }
      if (crossfadeTimerRef.current) window.clearTimeout(crossfadeTimerRef.current)
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
      // 组件卸载（切看歌/关开关/回退）时作废复用缓存
      onPlayStateChangeRef.current?.(null)
    }
  }, [])

  const selectCandidate = (candidate: CandidateScore) => {
    setBilibiliOverride(songKey, candidate.video.bvid)
    setShowCandidates(false)
    setCandidates([])
    fallbackChainRef.current = [candidate, ...fallbackChainRef.current.filter((c) => c.video.bvid !== candidate.video.bvid)]
    loadVideo(candidate)
  }

  // 视频缓冲完成：
  // - staged 槽：过渡期由 transitionProgress 驱动渐入（提交后主路径接管）；否则开始盖在旧视频上的渐入过渡
  // - 直进当前槽（首个视频/同一视频）：未渐入过则触发首个渐入（封面兜底→视频淡入）
  const handleCanPlay = (slot: 'A' | 'B') => {
    if (stagedSlotRef.current === slot) {
      // staged 槽是"过渡预载"（transitionPreloadRef 未消费）或过渡动画进行中时：
      // 一律不在此切换 active——预载只需缓冲，切换统一由 commit 后主路径接管
      // （beginCrossfade），否则 active 提前切走/旧槽被清，commit 时无槽可接管 → MV 残留。
      const preloading = Boolean(transitionPreloadRef.current && !transitionPreloadRef.current.failed)
      if (transitionActive || preloading) return
      beginCrossfade(slot)
      return
    }
    if (slot === activeSlotRef.current && !firstFadeDoneRef.current) {
      firstFadeDoneRef.current = true
      setFirstFadeDone(true)
    }
  }

  // 视频加载失败：清掉该槽的 staged/incoming 标记并释放 URL；若正是当前播放槽则进入 error 回退
  const handleVideoError = (slot: 'A' | 'B') => {
    if (stagedSlotRef.current === slot) stagedSlotRef.current = null
    if (incomingSlotRef.current === slot) {
      incomingSlotRef.current = null
      setIncomingSlot(null)
    }
    if (slot === 'A') setSlotAUrl(null)
    else setSlotBUrl(null)
    if (activeSlotRef.current === slot) {
      setStatus('error')
      showNotice('MV 播放失败')
    }
  }

  const dark = playerTheme !== 'light'

  return (
    <div
      className="absolute inset-0 z-0 overflow-hidden pointer-events-none"
      style={enabled ? undefined : { display: 'none' }}
    >
      {/* A 槽视频 */}
      <video
        ref={slotARef}
        src={slotAUrl ?? undefined}
        autoPlay={isPlaying}
        loop
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
        style={{
          opacity: slotOpacity('A'),
          transition: slotTransition('A'),
          zIndex: slotZIndex('A'),
          display: slotAUrl ? undefined : 'none',
          // scale() 不是合法的 filter 函数（filter 里写 blur+scale 整条被浏览器丢弃，模糊永不生效），
          // 放大 1.08 盖住模糊边缘改用 transform 承担
          filter: blur > 0 ? `blur(${blur}px)` : undefined,
          transform: blur > 0 ? 'scale(1.08)' : undefined,
        }}
        onCanPlay={() => handleCanPlay('A')}
        onError={() => handleVideoError('A')}
      />
      {/* B 槽视频：换歌时新视频在此缓冲后盖在旧视频上渐入 */}
      <video
        ref={slotBRef}
        src={slotBUrl ?? undefined}
        autoPlay={isPlaying}
        loop
        muted
        playsInline
        className="absolute inset-0 h-full w-full object-cover"
        style={{
          opacity: slotOpacity('B'),
          transition: slotTransition('B'),
          zIndex: slotZIndex('B'),
          display: slotBUrl ? undefined : 'none',
          filter: blur > 0 ? `blur(${blur}px)` : undefined,
          transform: blur > 0 ? 'scale(1.08)' : undefined,
        }}
        onCanPlay={() => handleCanPlay('B')}
        onError={() => handleVideoError('B')}
      />

      {/* 搜索/加载指示 */}
      {(status === 'searching' || status === 'loading') && (
        <div className="absolute right-6 bottom-6 z-30 flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs backdrop-blur-md"
          style={{
            backgroundColor: dark ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.5)',
            borderColor: dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
            color: dark ? '#fff' : '#000',
          }}>
          <Search className="w-3.5 h-3.5 animate-pulse" />
          {status === 'loading' ? 'MV 加载中' : 'MV 匹配中'}
        </div>
      )}

      {/* 轻量候选条（低置信确认） */}
      {showCandidates && candidates.length > 0 && (
        <div className="pointer-events-auto absolute bottom-6 left-1/2 -translate-x-1/2 z-30 w-[min(92vw,760px)]"
          style={{
            backgroundColor: dark ? 'rgba(10,12,18,0.88)' : 'rgba(255,255,255,0.92)',
            border: `1px solid ${dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)'}`,
            borderRadius: 14,
            boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
          }}>
          <div className="flex items-center gap-2 px-3 py-2 text-xs"
            style={{ color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)' }}>
            <span className="font-medium">匹配置信度不足，选择要作为背景的 MV</span>
            <button
              type="button"
              aria-label="关闭候选列表"
              onClick={() => setShowCandidates(false)}
              className="ml-auto rounded-full p-1 transition-colors hover:bg-black/10"
              style={{ color: dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto px-3 pb-3">
            {candidates.map((c) => (
              <button
                key={c.video.bvid}
                type="button"
                onClick={() => selectCandidate(c)}
                className="group w-36 shrink-0 overflow-hidden rounded-lg text-left transition-transform hover:scale-[1.03]"
                style={{ backgroundColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}
              >
                <div className="relative aspect-video w-full overflow-hidden">
                  <img src={resolveBiliPic(c.video.pic)} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  <span
                    className="absolute left-1 top-1 rounded px-1 py-0.5 text-[10px] font-medium text-white"
                    style={{ backgroundColor: TYPE_BADGES[c.type].color }}
                  >
                    {TYPE_BADGES[c.type].label}
                  </span>
                  <span className="absolute right-1 bottom-1 flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">
                    <Clock className="w-2.5 h-2.5" />
                    {formatBiliTime(c.video.duration)}
                  </span>
                </div>
                <div className="truncate px-1.5 pt-1 text-xs font-medium" style={{ color: dark ? '#fff' : '#000' }}>
                  {c.video.title}
                </div>
                <div className="flex items-center gap-1 truncate px-1.5 pb-1.5 text-[11px]"
                  style={{ color: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)' }}>
                  <span className="truncate">{c.video.author}</span>
                  <span className="flex items-center gap-0.5 shrink-0">
                    <Eye className="w-2.5 h-2.5" />
                    {formatPlayCount(c.video.play)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 短暂提示 */}
      {notice && (
        <div className="pointer-events-auto absolute top-24 left-1/2 -translate-x-1/2 z-40 rounded-full border px-4 py-2 text-sm backdrop-blur-md"
          style={{
            backgroundColor: dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.75)',
            borderColor: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)',
            color: dark ? '#fff' : '#000',
          }}>
          {notice}
        </div>
      )}
    </div>
  )
}
