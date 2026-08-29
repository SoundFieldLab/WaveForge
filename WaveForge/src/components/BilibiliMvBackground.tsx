/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
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
import { computeMvSyncTarget } from '../services/mvBackground'
import {
  ensureMvAlignment,
  getMvAlignment,
  prewarmMvBeatAnalysis,
  MIN_ALIGNMENT_CONFIDENCE,
} from '../services/mvAlignment'
import type { BilibiliVideo, CandidateSignals } from '../services/bilibiliApi'
import type { LyricLine } from '../services/musicApi'

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
  /**
   * 外部遮挡（看歌模式等）时仅隐藏 + 暂停，保留已缓冲的视频与搜索/加载状态；
   * 恢复后立即续播同一视频，不重新搜索/拉流。区别于 enabled（用户开关）。
   */
  hidden?: boolean
  /** 本地歌词（MV↔歌曲对齐的字幕文本匹配用；无歌词时对齐只走节拍路径） */
  lyrics?: LyricLine[]
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

/**
 * 预载对齐：解析目标 MV 的 cid/播放地址，提前下载+解码其音频（最慢的一步），
 * commit 时 ensureMvAlignment 的 MV 侧 analyze 命中缓存 → 对齐秒算、视频直接就位。
 * 与 loadVideo 用同一套 cid 解析（含多 P 选段）与音质设置，保证预载与正式播放
 * 指向同一音频流。失败静默（commit 时正常路径会再算）。
 */
async function resolveAndPrewarmAlignment(
  targetSongKey: string,
  candidate: CandidateScore,
  duration: number,
  targetTitle: string,
  targetArtists: string[],
  trackKey?: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    let cid = candidate.cid || 0
    if (!cid) {
      const view = await getBilibiliView(candidate.video.bvid, signal)
      if (view.code !== 0) return
      if (Array.isArray(view.data.pages) && view.data.pages.length > 1) {
        const chosen = view.data.pages[pickBestPage(view.data.pages, { songTitle: targetTitle, artists: targetArtists })]
        if (chosen?.cid) cid = chosen.cid
      }
      if (!cid) cid = view.data.cid
    }
    if (!cid) return
    const settings = getBilibiliWatchSettings()
    const qn = settings.targetQuality === 'auto' ? 127 : settings.targetQuality
    const playInfo = await getBilibiliPlayUrl(candidate.video.bvid, cid, qn, signal)
    if (playInfo.code !== 0 || !playInfo.cacheKey) return
    await prewarmMvBeatAnalysis({
      songKey: targetSongKey,
      trackKey,
      bvid: candidate.video.bvid,
      videoUrl: bilibiliStreamUrl(playInfo.cacheKey, 'audio'),
      duration,
      candidateType: candidate.type,
    })
  } catch {
    /* 预载对齐失败静默：commit 时正常路径会再算 */
  }
}

/** 兜底搜索：B站无匹配时，查网易云歌曲详情获取 MV 地址 */
async function findFallbackMvUrl(ctx: { songTitle: string; artists: string[]; songDuration: number; platform?: string }): Promise<string | null> {
  const title = ctx.songTitle?.trim()
  const artist = (ctx.artists || []).join(' ').trim()
  if (!title) return null
  try {
    // 1. 网易云搜索（取前 5 条，匹配标题+歌手）
    const searchUrl = `http://localhost:3001/api/netease/search?keyword=${encodeURIComponent(`${title} ${artist}`)}&limit=5`
    const searchResp = await fetch(searchUrl)
    if (!searchResp.ok) return null
    const searchJson = await searchResp.json()
    const songs = searchJson?.result?.songs || []
    // 匹配：标题相似 + 歌手包含
    const norm = (s: string) => (s || '').toLowerCase().replace(/[\s·•\-–—()（）\[\]【】「」『』<>《》"'`,.，。！？!?&/|:：]+/g, '')
    const match = songs.find((s: any) => {
      const tn = norm(s.name)
      const an = norm((s.artists || s.ar || []).map((a: any) => a.name).join(' '))
      return tn.includes(norm(title)) || norm(title).includes(tn) || an.includes(norm(artist))
    })
    if (!match?.mv) return null
    // 2. 获取 MV 播放地址
    const mvUrl = `http://localhost:3001/api/netease/mv/url?id=${match.mv}`
    const mvResp = await fetch(mvUrl)
    if (!mvResp.ok) return null
    const mvJson = await mvResp.json()
    const url = mvJson?.data?.url || mvJson?.url || ''
    if (url) console.log('[MvBackground] 兜底命中 网易云 MV:', match.name, '→', url.slice(0, 60) + '…')
    return url || null
  } catch (error) {
    console.warn('[MvBackground] 兜底搜索失败:', error)
    return null
  }
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
  hidden = false,
  lyrics = [],
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
  /** fallback 链所属的歌曲 key——预载会把链覆盖成"目标歌"的候选，当前歌的 fallback
   *  推进必须校验链属于当前歌，否则会用上一首/下一首的候选（"错位一首"的根因） */
  const fallbackChainSongRef = useRef('')
  // 看歌无缝接管：最新播放状态经 ref 上报（含实时进度）
  const onPlayStateChangeRef = useRef(onPlayStateChange)
  onPlayStateChangeRef.current = onPlayStateChange
  const lastPlayStateRef = useRef<{ bvid: string; cid: number; videoUrl: string; cacheKey: string; type?: string } | null>(null)
  const failedBvidsRef = useRef<Set<string>>(new Set())
  // getAudioElement 每次渲染都是新函数，同步循环里经 ref 读取避免 effect 反复重建
  const getAudioRef = useRef(getAudioElement)
  getAudioRef.current = getAudioElement
  // 歌曲元数据经 ref 读取：App 每次渲染 songArtists 都是新数组引用，
  // 若进 effect 依赖会导致搜索/加载每帧重跑、video 反复卸载重建（闪烁）。仅 songKey 变化才重新匹配。
  // 异步加载完成后的歌曲 key 校验：songKey 可能在异步期间变化（切歌），
// 用 ref 而非闭包捕获——否则旧歌的 loadVideo 会把新歌的槽位灌入错误 MV
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
  // 槽位 URL 清除时释放 GPU 视频解码器（不清除会累积解码帧，导致渐卡并最终耗尽）
  useEffect(() => { if (!slotAUrl && slotARef.current) slotARef.current.load() }, [slotAUrl])
  useEffect(() => { if (!slotBUrl && slotBRef.current) slotBRef.current.load() }, [slotBUrl])
  const [activeSlot, setActiveSlot] = useState<'A' | 'B'>('A')
  const activeSlotRef = useRef<'A' | 'B'>('A')
  /** 每个槽位当前加载的视频 bvid（同步循环按活跃槽的 bvid 查对齐结果） */
  const slotBvidRef = useRef<{ A: string; B: string }>({ A: '', B: '' })
  /** 每个槽位视频的完整播放状态：预载晋升属于"换槽"，对齐 effect 必须读**当前活跃槽**的
   *  状态而非 lastPlayStateRef——预载晋升后 lastPlayStateRef 还停在上一首歌的视频上，
   *  会对齐成"新歌×旧视频"（白下音频+污染缓存） */
  const slotPlayStateRef = useRef<{ A: { bvid: string; cid: number; videoUrl: string; cacheKey: string; type?: string } | null; B: { bvid: string; cid: number; videoUrl: string; cacheKey: string; type?: string } | null }>({ A: null, B: null })
  /** 当前实际加载的视频 bvid（对齐 effect 依赖它——fallback/预载换视频后必须重算对齐，
   *  否则对齐停留在"最佳候选"的偏移，套到 fallback 视频上就错位了） */
  const [loadedVideoBvid, setLoadedVideoBvid] = useState('')
  /** 刚切歌（hideOldMv 已清 active 槽）：下个 loadVideo 直接进 active 槽替换，
   *  不等交叉淡化——否则新视频进另一槽、淡入被快速切歌打断 → 背景空白 */
  const songSwitchedRef = useRef(false)
  // 正在盖在旧视频上渐入的新槽（opacity 0→1，promote 后成为 active 并清掉旧槽）
  const [incomingSlot, setIncomingSlot] = useState<'A' | 'B' | null>(null)
  const incomingSlotRef = useRef<'A' | 'B' | null>(null)
  // 首个视频渐入：组件刚启用/首首歌时没有旧视频可叠，视频在封面上方从透明渐入
  const [firstFadeDone, setFirstFadeDone] = useState(false)
  const firstFadeDoneRef = useRef(false)
  // 已放入但未淡入的槽位（等待 canplay / 过渡期由 transitionProgress 驱动）
  const stagedSlotRef = useRef<'A' | 'B' | null>(null)
  /** 已 commit 接管、正在等待晋升的预载槽：新预载不得顶掉它（否则"连环预载"顶掉
   *  上一首待晋升的视频 → 背景空白）；等它晋升完（beginCrossfade）或清槽后释放 */
  const pendingPromotionRef = useRef<'A' | 'B' | null>(null)
  /** 每个槽位视频属于哪首歌（songKeyOf 格式）：接管/过渡结束/看门狗晋升前必须校验
   *  归属——预载槽可能被后续预载覆盖成别歌的视频，不加校验会把"下一首的 MV"晋升到
   *  当前歌（张冠李戴）。owner='' 表示槽空。 */
  const slotOwnerRef = useRef<{ A: string; B: string }>({ A: '', B: '' })
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
  /** 当前预载（stagedOnly）loadVideo 自己的 controller：预载被替换时只中止它**自己**的
   *  异步链——绝不 abort searchControllerRef（那可能是**当前歌正在进行的搜索**的控制器，
   *  误杀 → 首歌永远没有背景，实测日志整段无匹配完成） */
  const bgPreloadCtrlRef = useRef<AbortController | null>(null)
  // 最新过渡目标（ref）：预载 effect 的 cleanup 需要判断"是过渡目标被替换还是 commit"。
  // React 先跑旧 effect 的 cleanup 再跑新 effect——commit 时 songTrackKey 变化也会触发
  // 该 effect 重跑，若 cleanup 无脑清预载，主路径接管时预载已丢失 → 封面重载数秒。
  const transitionTargetRef = useRef(transitionToTrack)
  transitionTargetRef.current = transitionToTrack
  const [candidates, setCandidates] = useState<CandidateScore[]>([])
  const [showCandidates, setShowCandidates] = useState(false)
  const [notice, setNotice] = useState('')

  const songKey = songKeyOf({ songTitle, artists: songArtists, songDuration, platform, id: songId })
  // 异步加载完成后的歌曲 key 校验 ref：songKey 可能在异步期间变化（切歌），
  // 用 ref 而非闭包捕获——否则旧歌的 loadVideo 会把新歌的槽位灌入错误 MV
  const songKeyRef = useRef(songKey)
  songKeyRef.current = songKey
  // 对齐检测读取最新歌词（App 每渲染传新引用，进依赖会导致效果反复重跑）
  const lyricsRef = useRef<LyricLine[]>(lyrics)
  lyricsRef.current = lyrics
  const lyricsReady = lyrics.length > 0
  /** 同步校正冷却：距上次 seek 校正 ≥10s 才允许再次校正（每次 seek 触发重缓冲 = "卡一下"） */
  const lastSyncCorrectionRef = useRef(0)
  /** 上一次渲染的 hidden 值：从看歌切回（hidden true→false）时做一次性硬同步 */
  const prevHiddenRef = useRef(hidden)
  /** 看歌切回硬同步的重试定时器（隐藏期缓冲可能被回收，视频暂不可 seek 时稍后重试） */
  const returnSyncTimerRef = useRef<number | null>(null)
  /** 过渡预载进行中（stagedOnly）：底部"MV 加载中"徽标不显示（预载是后台行为，不打扰） */
  const preloadActiveRef = useRef(false)

  const showNotice = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 4000)
  }, [])

  /**
   * 对齐就绪/已缓存时的一次性跳转：把持有该 bvid 的槽位（活跃或 staged）seek 到
   * 对齐位置。冷启动首曲等"先播后对齐"场景用——MV 立即开播，对齐算完立刻跳转，
   * 不等 1.5s 周期循环（后者只在漂移 >3s 且冷却 ≥10s 时校正，首次可能拖 10s+）。
   * 与同步循环共用 lastSyncCorrectionRef 冷却，避免连跳。
   */
  const jumpToAlignedPosition = useCallback((bvid: string, minJumpSec = 1.5) => {
    const alignment = getMvAlignment(songKey, bvid)
    if (!alignment || alignment.confidence < MIN_ALIGNMENT_CONFIDENCE) return
    const audio = getAudioRef.current()
    if (!audio) return
    for (const [ref, slot] of [[slotARef, 'A'], [slotBRef, 'B']] as const) {
      const video = ref.current
      if (!video || video.readyState < 2) continue
      if (slotBvidRef.current[slot] !== bvid) continue
      if (Number.isNaN(video.duration)) continue
      const target = computeMvSyncTarget(audio.currentTime + alignment.offsetSeconds, video.duration)
      if (target !== null && Math.abs(video.currentTime - target) > minJumpSec) {
        void window.electron?.automixLog?.('MvAlign', `[背景] 跳转对齐 ${bvid} offset=${alignment.offsetSeconds}s conf=${alignment.confidence.toFixed(2)} audio=${audio.currentTime.toFixed(1)}s → video seek ${target.toFixed(1)}s（原 ${video.currentTime.toFixed(1)}s，槽${slot} src=${(video.currentSrc || video.src || '空').slice(-40)}）`)?.catch?.(() => undefined)
        lastSyncCorrectionRef.current = performance.now()
        video.currentTime = target
        if (video.paused && video.readyState >= 3) void video.play().catch(() => undefined)
      }
    }
  }, [songKey])

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
    (candidate: CandidateScore, chainIndex = 0, stagedOnly = false, ownerSongKey?: string) => {
      const controller = new AbortController()
      // 预载（stagedOnly）是后台任务：**不得 abort 当前歌正在进行的搜索**——否则首歌的
      // 匹配中途被杀掉（searchedSongKeyRef 已锁定该歌、effect 不会重跑），首歌就永远
      // 没有背景（日志实测：整段会话无匹配完成、active 槽空、只剩预载残留视频顶上）。
      if (!stagedOnly) searchControllerRef.current?.abort()
      searchControllerRef.current = controller
      // stagedOnly 预载登记自己的控制器，供预载被替换时精准中止（不误伤搜索）
      bgPreloadCtrlRef.current = stagedOnly ? controller : null
      setStatus('loading')
      const { songTitle: st, songArtists: sa, songDuration: sd } = songRef.current

      const promise = (async () => {
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
          // 异步期间歌曲已切换：丢弃旧结果（否则旧歌 MV 灌入新歌槽位 → 张冠李戴）
          if (controller.signal.aborted) return
          if (songKeyRef.current !== songKey) {
            console.log('[MvBackground] loadVideo 弃结果：歌曲已切换', songKey, '→', songKeyRef.current)
            return
          }
          const newVideoUrl = bilibiliStreamUrl(playInfo.cacheKey, 'video')
          const playState = { bvid: candidate.video.bvid, cid, videoUrl: newVideoUrl, cacheKey: playInfo.cacheKey, type: candidate.type }
          // 预载（stagedOnly）属于下一首歌：不得覆盖当前歌的播放状态（对齐/续播会读到错误 bvid）
          if (!stagedOnly) {
            lastPlayStateRef.current = playState
          }
          const currentActiveEl = activeEl()
          const currentActiveUrl = currentActiveEl?.currentSrc || currentActiveEl?.src || null
          // 预载（stagedOnly）绝不进入“直接进槽”分支——它属于下一首歌，
          // 若吃掉 songSwitchedRef 会把下一首的候选直塞进当前歌的 active 槽（错位一首）。
          const songJustSwitched = !stagedOnly && songSwitchedRef.current
          if (!stagedOnly) songSwitchedRef.current = false
          if (!currentActiveUrl || currentActiveUrl === newVideoUrl || songJustSwitched) {
            // 首个视频 / 同一视频 / 刚切歌（旧视频已隐藏）：直接进当前槽位替换，无需过渡。
            // 刚切歌时不等交叉淡化——否则新视频进另一槽、淡入被快速切歌打断 → 背景空白
            if (activeSlotRef.current === 'A') {
              setSlotAUrl(newVideoUrl); slotBvidRef.current.A = candidate.video.bvid
              slotPlayStateRef.current.A = playState
              slotOwnerRef.current.A = ownerSongKey || songKey
              if (songJustSwitched) { setSlotBUrl(null); slotPlayStateRef.current.B = null; slotOwnerRef.current.B = '' }
            } else {
              setSlotBUrl(newVideoUrl); slotBvidRef.current.B = candidate.video.bvid
              slotPlayStateRef.current.B = playState
              slotOwnerRef.current.B = ownerSongKey || songKey
              if (songJustSwitched) { setSlotAUrl(null); slotPlayStateRef.current.A = null; slotOwnerRef.current.A = '' }
            }
            stagedSlotRef.current = null
            setLoadedVideoBvid(candidate.video.bvid)
            if (songJustSwitched) {
              void window.electron?.automixLog?.('MvAlign', `[背景] 直接进槽 ${songKey} ${candidate.video.bvid} → 槽${activeSlotRef.current} url=${newVideoUrl.slice(-36)}（切歌直连）`)?.catch?.(() => undefined)
            }
          } else {
            // 换歌：新视频放另一槽位（隐藏缓冲），canplay 后盖在旧视频上渐入。
            // 预载（stagedOnly）**绝不打断正在晋升的槽**：刚 commit 的当前歌 takeover 正
            // 在 1s 交叉淡化把预载视频上位（incoming），下一首过渡预载 1-2s 内就落槽——
            // 取消晋升定时器+重置 incoming 会把当前歌刚上位的视频打回隐藏槽 → 背景又变
            // 封面（automix 连环过渡时每首必现：用户实测"切歌后 1 秒 MV 背景 → 变封面"）。
            // 等晋升尘埃落定（≤2.5s，active 翻转、incoming 清空）再重新选空槽落子。
            if (stagedOnly && incomingSlotRef.current) {
              const promoteDeadline = Date.now() + 2500
              while (incomingSlotRef.current && Date.now() < promoteDeadline) {
                if (controller.signal.aborted) return
                await new Promise((r) => setTimeout(r, 120))
              }
            }
            const stage = otherSlot(activeSlotRef.current)
            stagedSlotRef.current = stage
            // 该槽正作为新视频淡入/待晋升：新目标顶掉它，取消旧晋升定时器并重置 incoming（避免残留 opacity:1 直接弹出）
            //（stagedOnly 经上方等待后 incoming 已清空、此处对预载恒为 no-op；真实换槽仍是覆盖语义）
            if (crossfadeTimerRef.current) {
              window.clearTimeout(crossfadeTimerRef.current)
              crossfadeTimerRef.current = null
            }
            if (incomingSlotRef.current === stage) {
              incomingSlotRef.current = null
              setIncomingSlot(null)
            }
            if (stage === 'A') { setSlotAUrl(newVideoUrl); slotBvidRef.current.A = candidate.video.bvid; slotPlayStateRef.current.A = playState; slotOwnerRef.current.A = ownerSongKey || songKey }
            else { setSlotBUrl(newVideoUrl); slotBvidRef.current.B = candidate.video.bvid; slotPlayStateRef.current.B = playState; slotOwnerRef.current.B = ownerSongKey || songKey }
            setLoadedVideoBvid(candidate.video.bvid)
            // 诊断：新歌换槽后槽位元素的实际 src / 位置（排查"切歌后旧 MV 残留"）
            const dbgEl = slotEl(stage)
            void window.electron?.automixLog?.('MvAlign', `[背景] 换槽 ${songKey} ${candidate.video.bvid} → 槽${stage} url=${newVideoUrl.slice(-40)} 元素src=${dbgEl ? (dbgEl.currentSrc || dbgEl.src || '空').slice(-40) : '无'} t=${dbgEl ? dbgEl.currentTime.toFixed(1) : '-'} active=${activeSlotRef.current}${stagedOnly ? '（过渡预载）' : ''}`)?.catch?.(() => undefined)
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
          if (lastPlayStateRef.current) {
            onPlayStateChangeRef.current?.({ ...lastPlayStateRef.current, currentTime: activeEl()?.currentTime || 0 })
          }
          // 异步触发 MV↔歌曲对齐检测（字幕文本匹配快 / 节拍分析慢；结果进 mvAlignment 缓存，
          // 同步循环据此决定是否做位置校正；对不上的视频自由播放、不做校正）
          // 对齐就绪后一次性 seek：冷启动首曲"先播后对齐"，算完立刻跳到对齐位置。
          // stagedOnly（过渡预载）跳过：此时对齐对应是"旧歌×目标MV"，无意义还白下音频，
          // 目标歌的对齐由 resolveAndPrewarmAlignment 预载、commit 后由兜底 effect 精算。
          if (!stagedOnly) {
            void ensureMvAlignment({
              songKey,
              songTitle: songRef.current.songTitle,
              songArtists: songRef.current.songArtists,
              songDuration: songRef.current.songDuration,
              songUrl: getAudioRef.current()?.src || '',
              lyrics: lyricsRef.current,
              bvid: candidate.video.bvid,
              cid,
              videoUrl: playInfo.cacheKey ? bilibiliStreamUrl(playInfo.cacheKey, 'audio') : '',
              candidateType: candidate.type,
              signal: controller.signal,
            }).then(() => jumpToAlignedPosition(candidate.video.bvid)).catch(() => { /* 对齐失败静默（自由播放） */ })
          }
        } catch (error) {
          if (controller.signal.aborted) return
          if (getBilibiliOverride(songKey) === candidate.video.bvid) clearBilibiliOverride(songKey)
          if (stagedOnly) return // 后台预载失败静默：不影响当前播放，也不弹错误提示
          const message = error instanceof Error ? error.message : 'MV 加载失败'
          failedBvidsRef.current.add(candidate.video.bvid)
          // fallback 链必须属于当前歌——预载会把链覆盖成"目标歌"的候选，直接推进会
          // 用上一首/下一首的候选（用户实测"错位一首"）。链不属于当前歌 → 放弃推进
          const chainIsCurrent = fallbackChainSongRef.current === songKey
          const nextIndex = chainIsCurrent
            ? fallbackChainRef.current.findIndex((c, i) => i > chainIndex && !failedBvidsRef.current.has(c.video.bvid))
            : -1
          if (nextIndex >= 0) {
            void loadVideo(fallbackChainRef.current[nextIndex], nextIndex)
            return
          }
          setStatus('error')
          showNotice(message)
        }
      })()
      return promise
    },
    [songKey, showNotice],
  )

  // 待淡入槽位的视频缓冲完成 → 开始过渡：新槽盖在旧槽上 0→1 渐现（封面式"视频过渡"），
  // 完成后新槽晋升为 active 并释放旧槽。快速切歌时该槽若已被新目标顶掉，定时器直接放弃本次晋升。
  const beginCrossfade = (slot: 'A' | 'B') => {
    if (stagedSlotRef.current !== slot) return
    const prevActive = activeSlotRef.current
    stagedSlotRef.current = null
    pendingPromotionRef.current = null
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
    // 开关重开且同一首歌的缓冲还在：直接续播，不重新搜索/重拉流。否则每次开关切换都会
    // hideOldMv + 重新请求 playurl + 重缓冲——出现封面闪烁窗口，网络慢/失败时直接"变回封面背景"
    //（缓冲丢失/加载失败时 activeEl 无 src 或 readyState 不足，仍会走下方重搜重试）
    if (enabled && searchedSongKeyRef.current === songKey) {
      const resumedEl = slotEl(activeSlotRef.current)
      if (resumedEl && (resumedEl.currentSrc || resumedEl.src) && resumedEl.readyState >= 1) return
    }
    searchedSongKeyRef.current = songKey
    // 新歌就位：过渡目标去重标记重置，后续同目标的过渡重新预载
    lastTransitionTargetRef.current = ''
    // 歌曲已切换：若新歌 MV 未就绪，立即隐藏旧歌 MV（封面兜底），
    // 避免"过渡完毕到下一曲"后仍显示上一曲 MV；新 MV 就绪后由 canplay 淡入
    const hideOldMv = () => {
      // 切歌：清空**两个**槽（旧的视频彻底释放，不留残留），并标记下个 loadVideo
      // 直接进 active 槽替换（不等交叉淡化——淡入被快速切歌打断会一直空白）
      songSwitchedRef.current = true
      setSlotAUrl(null)
      setSlotBUrl(null)
      slotBvidRef.current.A = ''
      slotBvidRef.current.B = ''
      slotPlayStateRef.current.A = null
      slotPlayStateRef.current.B = null
      slotOwnerRef.current.A = ''
      slotOwnerRef.current.B = ''
      pendingPromotionRef.current = null
    }
    // 过渡预载接管：预载目标即当前歌时直接晋升预载视频（就绪即过渡、未就绪等 canplay），
    // 跳过重新搜索/拉流——否则 commit 瞬间会重拉 playurl + 视频重载，旧 MV 回显约 1s。
    // 用 songTrackKeyRef（最新渲染值）而非本 effect 闭包捕获的 songTrackKey——commit 时
    // 若 App 的 currentSong 更新与本 effect 触发不在同一渲染，闭包可能还是**上一曲**的 key，
    // 预载（下一曲）与之不匹配 → 重新搜索旧歌 MV → commit 后显示上一曲 MV（用户实测"张冠李戴"）。
    const preload = transitionPreloadRef.current
    transitionPreloadRef.current = null
    const currentKey = songTrackKeyRef.current
    // —— 重新搜索兜底（切歌/预载不可用/归属不符/预载超时未落槽）：隐藏旧画面 + 全量匹配 + 加载 ——
    let cancelled = false
    const searchAndLoad = () => {
      hideOldMv()
      const controller = new AbortController()
      searchControllerRef.current?.abort()
      searchControllerRef.current = controller
      failedBvidsRef.current = new Set()
      fallbackChainRef.current = []
      fallbackChainSongRef.current = songKey
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
        const svBgLog = (msg: string) => { void window.electron?.automixLog?.('MvAlign', msg)?.catch?.(() => undefined) }
        svBgLog(`[背景] 匹配完成 歌曲=${st} best=${result.best ? `${result.best.video.bvid} ${result.best.video.title.slice(0, 30)} dur=${result.best.video.duration}s score=${Math.round(result.best.score)} type=${result.best.type}` : 'none'} 候选=${result.candidates.length}`)
        if (result.status === 'auto' && result.best) {
          fallbackChainRef.current = result.fallbackChain
          fallbackChainSongRef.current = songKey
          loadVideo(result.best)
        } else if (result.status === 'confirm') {
          setCandidates(result.candidates)
          setStatus('confirm')
          setShowCandidates(true)
        } else if (result.status === 'none') {
          // B站无匹配 → 兜底搜索其他平台（网易云/QQ/酷狗等）
          setStatus('searching')
          const fallbackUrl = await findFallbackMvUrl(ctx)
          if (cancelled || controller.signal.aborted) return
          if (fallbackUrl) {
            // 构造虚拟候选：直接播放兜底 MV，不走 B站评分/缓冲链
            const fakeVideo: BilibiliVideo = { bvid: `fallback-${sid}`, title: st, duration: sd, play: 0, author: sa.join(', '), pic: '' }
            const fakeCandidate: CandidateScore = { video: fakeVideo, score: 0, signals: { officialMarker: false, mvMarker: false, negativeHit: false, hasArtist: false, nearDuration: false, hdMarker: false, uploaderMatchesArtist: false, ccSubtitle: false }, rank: 0, officialVerifyType: -1, manualZhSubtitle: false, autoSubtitle: false, type: 'other' }
            // 直接 set URL 到当前槽位，不走 B站 playurl 拉流
            const stage = activeSlotRef.current === 'A' ? 'B' : 'A'
            if (stage === 'A') { setSlotAUrl(fallbackUrl); slotBvidRef.current.A = fakeCandidate.video.bvid; slotOwnerRef.current.A = songKey }
            else { setSlotBUrl(fallbackUrl); slotBvidRef.current.B = fakeCandidate.video.bvid; slotOwnerRef.current.B = songKey }
            fallbackChainRef.current = [fakeCandidate]
            fallbackChainSongRef.current = songKey
            setStatus('playing')
          } else {
            setStatus('none')
            showNotice('未找到相关 MV')
          }
        } else {
          setStatus('error')
          showNotice(result.error || 'MV 匹配失败')
        }
      })()
    }
    let landTimer: number | null = null
    if (preload && !preload.failed && preload.trackKey === currentKey) {
      const mvBgLog = (msg: string) => { void window.electron?.automixLog?.('MvAlign', msg)?.catch?.(() => undefined) }
      // 只隐藏**旧 active 槽**（上一曲画面不能留在新歌上），**绝不清 staged 槽**：
      // staged 槽是预载好的新歌视频，hideOldMv 清两槽会把刚缓冲的视频销毁 →
      // 过渡期预载视频淡入（"有一瞬间是有的"）→ commit 后被清空 → 背景空白。
      // 新歌视频就绪（canplay/过渡结束兜底）后由 beginCrossfade 上位。
      const oldSlot = activeSlotRef.current
      if (oldSlot === 'A') { setSlotAUrl(null); slotBvidRef.current.A = ''; slotPlayStateRef.current.A = null; slotOwnerRef.current.A = '' }
      else { setSlotBUrl(null); slotBvidRef.current.B = ''; slotPlayStateRef.current.B = null; slotOwnerRef.current.B = '' }
      const staged = stagedSlotRef.current
      if (staged) {
        const stagedOwner = slotOwnerRef.current[staged]
        const stagedState = slotPlayStateRef.current[staged]
        const stagedEl = slotEl(staged)
        mvBgLog(`[背景] 接管预载 ✓ staged=槽${staged} owner=${stagedOwner || '空'} ready=${stagedEl ? stagedEl.readyState : '-'} songKey=${songKey}`)
        // 预载槽可能被后续预载覆盖成**别歌的视频**（归属不符）：绝不能晋升——
        // 否则当前歌显示下一首的 MV（用户实测错位）。立即重新搜索。
        if (stagedOwner && stagedOwner !== songKey) {
          mvBgLog(`[背景] 接管预载归属不符 owner=${stagedOwner}≠${songKey} → 放弃预载，重新搜索`)
          searchAndLoad()
          return
        }
        if (stagedState) {
          // 接管后本条视频即当前歌的"已加载视频"：更新 lastPlayStateRef 并上报看歌播放状态
          lastPlayStateRef.current = stagedState
          onPlayStateChangeRef.current?.({ ...stagedState, currentTime: stagedEl?.currentTime || 0 })
        }
        if (stagedEl && stagedEl.readyState >= 2) {
          beginCrossfade(staged)
          setStatus('playing')
          return
        }
        // 已放 URL 未就绪：保留缓冲，等 canplay → beginCrossfade（不重拉流丢弃已缓冲数据）
        pendingPromotionRef.current = staged
        setStatus('playing')
        return
      }
      // 预载目标匹配但槽里没有视频（拉流未落地）：automix 标准版过渡窗口短，预载常在
      // commit 前后才完成。给 ~1.5s 等它落槽 → 直接走过渡叠加（不闪封面、不重复拉流）；
      // 超时仍未落槽（拉流失败/被清）才走全量搜索兜底，保证当前歌必有背景。
      mvBgLog('[背景] 接管预载但无 staged 槽 → 等预载落槽（1.5s）')
      const takeSongKey = songKey
      landTimer = window.setTimeout(() => {
        landTimer = null
        if (songKeyRef.current !== takeSongKey) return
        for (const s of ['A', 'B'] as const) {
          const landedEl = slotEl(s)
          if (slotOwnerRef.current[s] === takeSongKey && landedEl?.readyState != null && landedEl.readyState >= 2) {
            mvBgLog(`[背景] 预载落槽 → 晋升 槽${s}`)
            beginCrossfade(s)
            setStatus('playing')
            return
          }
        }
        mvBgLog('[背景] 预载 1.5s 未落槽 → 重新搜索兜底')
        searchAndLoad()
      }, 1500)
      return
    }
    // 无预载（普通切歌/预载失败）：旧 MV 立即隐藏，等新 MV 搜索加载好后淡入
    if (!preload) {
      console.log('[MvBackground] commit 时无预载（未触发/已消费）→ 重新搜索', songTrackKey)
    } else {
      console.log('[MvBackground] commit 预载不可用（failed 或目标不匹配）', preload.trackKey, '≠', songTrackKey)
    }
    searchAndLoad()

    return () => {
      cancelled = true
      if (landTimer !== null) {
        window.clearTimeout(landTimer)
        landTimer = null
      }
      searchControllerRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey, enabled])

  // 预加载：为即将播放的歌曲提前匹配评分高的视频（findBestBilibiliMv 结果按歌缓存 24h，
  // 切到该歌时直接命中缓存秒播；与看歌模式同款逻辑，不阻塞当前播放）。
  // 紧邻下一首额外预载对齐（提前下载+解码 MV 音频）——切到该歌时对齐秒算、直接就位。
  useEffect(() => {
    if (!enabled && !wasEnabledRef.current) return
    if (!upcomingSongs?.length) return
    const preloadController = new AbortController()
    for (const [index, upcoming] of upcomingSongs.slice(0, 2).entries()) {
      void (async () => {
        try {
          const result = await findBestBilibiliMv(
            { songTitle: upcoming.songTitle, artists: upcoming.songArtists, songDuration: upcoming.songDuration, platform: upcoming.platform, id: upcoming.id },
            { signal: preloadController.signal, settings: getBilibiliWatchSettings() },
          )
          if (preloadController.signal.aborted || result.status !== 'auto' || !result.best) return
          // 只预载紧邻下一首的对齐，避免为整列表每首下载数 MB 音频 + 整曲解码
          if (index === 0) {
            await resolveAndPrewarmAlignment(
              songKeyOf({ songTitle: upcoming.songTitle, artists: upcoming.songArtists, songDuration: upcoming.songDuration, platform: upcoming.platform, id: upcoming.id }),
              result.best,
              upcoming.songDuration,
              upcoming.songTitle,
              upcoming.songArtists,
              undefined,
              preloadController.signal,
            )
          }
        } catch {
          /* 预加载失败静默 */
        }
      })()
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
    if (hidden) return
    if (target.trackKey === songTrackKey) return
    if (target.trackKey === lastTransitionTargetRef.current) return
    lastTransitionTargetRef.current = target.trackKey
    const controller = new AbortController()
    // 预载是后台任务：**不得 abort 当前歌正在进行的搜索**（否则首歌的匹配被杀掉、
    // searchedSongKeyRef 锁定该歌后 effect 不再重跑 → 首歌永远无背景，实测整段会话无匹配完成）
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
        const targetArtists = (target.artist || '').split(',').map((s) => s.trim()).filter(Boolean)
        const targetDuration = typeof target.duration === 'number' && target.duration > 0
          ? target.duration
          : songRef.current.songDuration
        const ctx: MatchContext = {
          songTitle: target.title || '',
          artists: targetArtists,
          songDuration: targetDuration,
          platform: target.platform,
          id: target.id,
        }
        const result = await findBestBilibiliMv(ctx, { signal: controller.signal })
        if (controller.signal.aborted || searchControllerRef.current !== controller) return
        if (result.status === 'auto' && result.best) {
          console.log('[MvBackground] 过渡预载命中 →', result.best.video.title || result.best.video.bvid, '| 开始拉流（仅缓冲，不切换）')
          // 预载链属于**目标歌**（当前歌的 fallback 推进必须拒绝它——否则用下一首的候选）
          fallbackChainRef.current = result.fallbackChain
          fallbackChainSongRef.current = songKeyOf(ctx)
          preloadActiveRef.current = true // 预载期间隐藏"MV 加载中"徽标（后台行为，不打扰）
          // 别顶掉**当前歌待晋升**的预载槽：commit 接管后 staged 视频未就绪时它还在槽里
          // 等 canplay/过渡结束晋升；连环切歌时新预载立刻落槽会把上一首待晋升的视频覆盖 →
          // 背景空白。等该槽晋升完（最长 ~8s，超时视为死链直接覆盖）再落新预载。
          if (pendingPromotionRef.current && stagedSlotRef.current === pendingPromotionRef.current) {
            let waited = 0
            while (stagedSlotRef.current === pendingPromotionRef.current && waited < 8000) {
              if (controller.signal.aborted) return
              await new Promise((r) => setTimeout(r, 250))
              waited += 250
            }
          }
          loadVideo(result.best, 0, true, songKeyOf(ctx)).finally(() => { preloadActiveRef.current = false })
          // 预载对齐：提前下载+解码目标 MV 音频（最慢一步），commit 时对齐秒算、
          // 视频直接就位（过渡动画内新 MV 渐入即对齐，不出现"先错位后跳变"）
          void resolveAndPrewarmAlignment(
            songKeyOf({ songTitle: target.title || '', artists: targetArtists, songDuration: targetDuration, platform: target.platform, id: target.id }),
            result.best,
            targetDuration,
            target.title || '',
            targetArtists,
            target.trackKey,
            controller.signal,
          )
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
	        // 只中止旧预载自己的 loadVideo 异步链——绝不能 abort searchControllerRef，
	        // 那可能是当前歌正在进行的搜索的控制器（误杀 → 首歌永远无背景）
	        bgPreloadCtrlRef.current?.abort()
	        bgPreloadCtrlRef.current = null
	        const staged = stagedSlotRef.current
        if (staged) {
          stagedSlotRef.current = null
          slotBvidRef.current[staged] = ''
          slotPlayStateRef.current[staged] = null
          slotOwnerRef.current[staged] = ''
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

  // 位置跟随：仅对「已确认对齐」的 MV 做音频时钟校正（歌曲位置 + 偏移 → 视频位置）。
  // 对不上的视频（现场版/翻唱/无对齐结果）自由循环播放、不做任何周期性 seek——
  // 盲目按「音频位置 % 视频时长」校正会让对不上的视频反复 seek，而每次 seek 都触发
  // 视频重缓冲（"放着放着卡一下"）；克制策略（漂移超 3s + 距上次校正 ≥10s）消除该死循环。
  // 看歌模式自身不跑此循环（由 DASH 音频轨同步），此循环只管背景层。
  useEffect(() => {
    if (!isPlaying || !enabled || hidden) {
      for (const ref of [slotARef, slotBRef]) {
        if (ref.current && !ref.current.paused) ref.current.pause()
      }
      prevHiddenRef.current = hidden
      return
    }
    // 从看歌切回（hidden true→false）：视频被隐藏期间缓冲可能被系统回收/位置陈旧，
    // 做一次**硬同步**（seek 到音频对齐位置）强制重缓冲并回到正确帧——
    // 否则会停留在上次隐藏前的旧画面，直到手动拖进度才恢复。
    const returningFromHidden = prevHiddenRef.current === true
    prevHiddenRef.current = false
    if (returningFromHidden) {
      const audio = getAudioRef.current()
      const applyReturnSync = (): boolean => {
        if (!audio) return false
        const v = slotEl(activeSlotRef.current)
        if (!v || v.readyState < 1 || !Number.isFinite(v.duration) || v.duration <= 0) return false
        const activeBvid = slotBvidRef.current[activeSlotRef.current]
        const alignment = getMvAlignment(songKey, activeBvid)
        const offset = alignment && alignment.confidence >= MIN_ALIGNMENT_CONFIDENCE ? alignment.offsetSeconds : 0
        const target = computeMvSyncTarget(audio.currentTime + offset, v.duration)
        if (target === null) return false
        // 从看歌切回：**无条件** seek 到音频对齐位置——即使偏差只有 0.5s 也要校正，
        // 否则视频从隐藏前的旧位置续播、小偏移逐次累积变大（实测切 2 次后慢 ~10s）
        lastSyncCorrectionRef.current = performance.now()
        v.currentTime = target
        if (v.paused) void v.play().catch(() => undefined)
        return true
      }
      // 隐藏期视频缓冲可能被系统回收、暂不可 seek：立即尝试 + 每 500ms 重试，
      // 直到视频就位并同步到看歌结束时的位置（最多约 2s，避免"切回还停在旧画面"）。
      if (!applyReturnSync()) {
        let retries = 0
        returnSyncTimerRef.current = window.setInterval(() => {
          retries += 1
          if (applyReturnSync() || retries >= 4) {
            if (returnSyncTimerRef.current !== null) {
              window.clearInterval(returnSyncTimerRef.current)
              returnSyncTimerRef.current = null
            }
          }
        }, 500)
      }
    }
    // 恢复播放：活跃槽 + 已 staged 槽
    for (const ref of [slotARef, slotBRef]) {
      const video = ref.current
      if (video && video.paused && video.readyState >= 2) void video.play().catch(() => undefined)
    }
    if (returningFromHidden) {
      const audio = getAudioRef.current()
      const video = slotEl(activeSlotRef.current)
      if (audio && video && video.readyState >= 1 && !Number.isNaN(video.duration)) {
        const activeBvid = slotBvidRef.current[activeSlotRef.current]
        const alignment = getMvAlignment(songKey, activeBvid)
        const offset = alignment && alignment.confidence >= MIN_ALIGNMENT_CONFIDENCE ? alignment.offsetSeconds : 0
        const target = computeMvSyncTarget(audio.currentTime + offset, video.duration)
        if (target !== null) {
          lastSyncCorrectionRef.current = performance.now()
          video.currentTime = target
          if (video.paused) void video.play().catch(() => undefined)
        }
      }
    }
    // 周期性校正（1.5s 检查一次）：只校正当前可见槽、且该槽视频已确认对齐
    const interval = window.setInterval(() => {
      const audio = getAudioRef.current()
      if (!audio) return
      const now = performance.now()
      // 换歌过渡期（交叉淡化）：staged 槽就是新歌 MV。
      // 普通切歌时音频已切到新歌 → 按对齐位置校正 staged 槽（淡入前就位，无跳变）；
      // automix/无缝过渡期音频还是旧歌 → 不校正（commit 后由主路径接管时就位）。
      if (stagedSlotRef.current !== null) {
        if (!transitionActiveRef.current) {
          const staged = stagedSlotRef.current
          const stagedBvid = slotBvidRef.current[staged]
          const stagedAlign = getMvAlignment(songKey, stagedBvid)
          const stagedVideo = slotEl(staged)
          // 晋升看门狗：commit 接管后待晋升（pendingPromotionRef）的预载视频一旦就绪就上位。
          // 覆盖 canplay 被过渡动画跳过（transitionActive → handleCanPlay 返回）且不再触发
          // 的边角——否则预载视频永远停在隐藏槽，背景空白等待下一首。
          if (pendingPromotionRef.current === staged && stagedVideo && stagedVideo.readyState >= 2 && (stagedVideo.currentSrc || stagedVideo.src)) {
            pendingPromotionRef.current = null
            void window.electron?.automixLog?.('MvAlign', `[背景] 晋升看门狗 槽${staged}（接管后就绪）`)?.catch?.(() => undefined)
            beginCrossfade(staged)
            return
          }
          // 无对齐结果（自由播放）时仍按 offset=0 跟随音频位置：背景视频是静音纯视觉，
          // 歌词跳转/进度拖动时画面必须跟着歌曲走（否则背景冻结在旧位置）
          const stagedOffset = stagedAlign && stagedAlign.confidence >= MIN_ALIGNMENT_CONFIDENCE ? stagedAlign.offsetSeconds : 0
          if (stagedVideo && stagedVideo.readyState >= 2 && !Number.isNaN(stagedVideo.duration)) {
            const stagedTarget = computeMvSyncTarget(audio.currentTime + stagedOffset, stagedVideo.duration)
            if (stagedTarget !== null && Math.abs(stagedVideo.currentTime - stagedTarget) > 1.5 && now - lastSyncCorrectionRef.current > 5000) {
              lastSyncCorrectionRef.current = now
              stagedVideo.currentTime = stagedTarget
            }
          }
        }
        return
      }
      const activeBvid = slotBvidRef.current[activeSlotRef.current]
      const alignment = getMvAlignment(songKey, activeBvid)
      // 无对齐结果（现场/翻唱/对不上）→ 按 offset=0 自由跟随音频位置，而不是完全不校正：
      // 否则用户拖进度条/跳歌词后视频停留在旧位置（实测 宮 现场版跳转不跟随）
      const offset = alignment && alignment.confidence >= MIN_ALIGNMENT_CONFIDENCE ? alignment.offsetSeconds : 0
      const video = slotEl(activeSlotRef.current)
      if (!video || video.readyState < 2) return
      // 自愈：视频因网络停顿/缓冲被暂停时恢复播放（否则会冻结在当前帧）
      if (video.paused && !video.seeking) void video.play().catch(() => undefined)
      if (video.seeking) return
      const target = computeMvSyncTarget(audio.currentTime + offset, video.duration)
      if (target === null) return
      if (Math.abs(video.currentTime - target) > 3 && now - lastSyncCorrectionRef.current > 10000) {
        lastSyncCorrectionRef.current = now
        video.currentTime = target
      }
    }, 1500)
    // 拖进度条/快进时一次性跳转（无对齐结果也按 offset=0 跟随——背景是静音纯视觉，
    // 音频跳转时画面必须同步跳，否则背景停留在旧位置；暂停态也恢复播放）
    const onSeek = () => {
      const audio = getAudioRef.current()
      if (!audio) return
      const activeBvid = slotBvidRef.current[activeSlotRef.current]
      const alignment = getMvAlignment(songKey, activeBvid)
      const offset = alignment && alignment.confidence >= MIN_ALIGNMENT_CONFIDENCE ? alignment.offsetSeconds : 0
      for (const [ref, slot] of [[slotARef, 'A'], [slotBRef, 'B']] as const) {
        const video = ref.current
        if (!video || video.readyState < 2) continue
        if (slot !== activeSlotRef.current) continue
        const target = computeMvSyncTarget(audio.currentTime + offset, video.duration)
        if (target !== null && Math.abs(video.currentTime - target) > 1.5) {
          void window.electron?.automixLog?.('MvAlign', `[背景] seek跟随 audio=${audio.currentTime.toFixed(1)}s offset=${offset}s → video ${video.currentTime.toFixed(1)}s→${target.toFixed(1)}s`)?.catch?.(() => undefined)
          video.currentTime = target
          if (video.paused) void video.play().catch(() => undefined)
        }
      }
    }
    const audio = getAudioRef.current()
    if (audio) {
      audio.addEventListener('seeked', onSeek)
      audio.addEventListener('seeking', onSeek)
    }
    return () => {
      window.clearInterval(interval)
      if (returnSyncTimerRef.current !== null) {
        window.clearInterval(returnSyncTimerRef.current)
        returnSyncTimerRef.current = null
      }
      if (audio) {
        audio.removeEventListener('seeked', onSeek)
        audio.removeEventListener('seeking', onSeek)
      }
    }
  }, [isPlaying, enabled, hidden, songKey])

  // MV↔歌曲对齐检测兜底：loadVideo 已触发一次（无歌词时字幕路径跳过）；歌词到达、
  // 从看歌切回、开关重开等时机补触发。ensureMvAlignment 幂等（结果缓存 + 在途去重）。
  // 过渡预载进行中且目标 ≠ 当前歌时跳过：此时 lastPlayState 是目标 MV，用旧歌 songKey
  // 算"旧歌×目标MV"是白下载（目标歌对齐由 resolveAndPrewarmAlignment 预载，commit 后
  // 主路径消费预载、songKey 变化再触发本 effect 时才会算正确的"新歌×目标MV"）。
  // 读取**当前活跃槽**的播放状态而非 lastPlayStateRef：预载晋升（换槽）后 lastPlayStateRef
  // 仍停在上一首歌的视频上，会对齐"新歌×旧视频"（白下音频+污染对齐缓存）。
  useEffect(() => {
    if (!enabled || hidden) return
    if (status !== 'playing') return
    if (transitionPreloadRef.current && transitionPreloadRef.current.trackKey !== songTrackKeyRef.current) return
    const mvState = slotPlayStateRef.current[activeSlotRef.current]
    if (!mvState?.bvid || !mvState.cid) return
    void ensureMvAlignment({
      songKey,
      songTitle: songRef.current.songTitle,
      songArtists: songRef.current.songArtists,
      songDuration: songRef.current.songDuration,
      songUrl: getAudioRef.current()?.src || '',
      lyrics: lyricsRef.current,
      bvid: mvState.bvid,
      cid: mvState.cid,
      videoUrl: mvState.cacheKey ? bilibiliStreamUrl(mvState.cacheKey, 'audio') : '',
      candidateType: mvState.type,
    }).then(() => jumpToAlignedPosition(mvState.bvid)).catch(() => { /* 对齐失败静默（自由播放） */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey, enabled, hidden, status, lyricsReady, loadedVideoBvid, activeSlot])

  // 过渡结束补晋升：commit 接管后 staged 槽未就绪、或 canplay 时过渡动画仍在（transitionActive
  // → handleCanPlay 跳过晋升），过渡结束（transitionToTrack 清空）后补一次晋升。
  // 只晋升**属于当前歌**的 staged 视频（slotOwnerRef 校验）——预载槽可能被后续预载覆盖成
  // 别歌的视频，无脑晋升 = 张冠李戴（当前歌显示下一首的 MV）。
  useEffect(() => {
    if (transitionToTrack?.trackKey) return // 过渡进行中：staged 由 transitionProgress 驱动
    const staged = stagedSlotRef.current
    if (!staged) return
    const pending = transitionPreloadRef.current
    if (pending && !pending.failed && pending.trackKey !== songTrackKeyRef.current) return
    const owner = slotOwnerRef.current[staged]
    if (owner && owner !== songKeyRef.current) return // 别歌的预载视频：不晋升
    const el = slotEl(staged)
    if (el && (el.currentSrc || el.src) && el.readyState >= 2) {
      void window.electron?.automixLog?.('MvAlign', `[背景] 过渡结束补晋升 槽${staged} owner=${owner || '空'} → 当前歌`)?.catch?.(() => undefined)
      beginCrossfade(staged)
      setStatus('playing')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitionToTrack?.trackKey])

  // 组件挂载时清空槽位（常驻挂载，看歌模式仅隐藏不卸载；卸载/重挂载时确保槽位干净）
  useEffect(() => {
    setSlotAUrl(null); setSlotBUrl(null)
    stagedSlotRef.current = null
    incomingSlotRef.current = null
    slotOwnerRef.current.A = ''
    slotOwnerRef.current.B = ''
    return () => {
      searchControllerRef.current?.abort()
      for (const ref of [slotARef, slotBRef]) {
        if (ref.current) { ref.current.pause(); ref.current.removeAttribute('src'); ref.current.load() }
      }
      if (crossfadeTimerRef.current) window.clearTimeout(crossfadeTimerRef.current)
    }
  }, [])

  const selectCandidate = (candidate: CandidateScore) => {
    setBilibiliOverride(songKey, candidate.video.bvid)
    setShowCandidates(false)
    setCandidates([])
    fallbackChainRef.current = [candidate, ...fallbackChainRef.current.filter((c) => c.video.bvid !== candidate.video.bvid)]
    fallbackChainSongRef.current = songKey
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
    if (pendingPromotionRef.current === slot) pendingPromotionRef.current = null
    slotOwnerRef.current[slot] = ''
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
      style={enabled && !hidden ? undefined : { display: 'none' }}
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

      {/* 搜索/加载指示（过渡预载期间隐藏：后台缓冲不打扰） */}
      {!preloadActiveRef.current && (status === 'searching' || status === 'loading') && (
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
