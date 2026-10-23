import { debugLog } from '../utils/debugLog'
import { isGameModeFrozen } from '../services/gameModeRuntime'
import { isTvModeActive } from '../platform'
import { PLAYBACK_SPEED_OPTIONS, PLAYBACK_SPEED_SETTINGS_EVENT, PLAYBACK_SPEED_TRANSITION_EVENT, setEffectivePlaybackSpeed } from '../services/playbackSpeedSettings'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  onStateChange as onBridgeStateChange,
  getState as getBridgeState,
  bridgePause,
  bridgeResume,
  bridgeSeek,
  bridgeVolume,
  bridgeFade,
  bridgeStopPlayback,
} from '../services/appleWebViewBridge'
import { autoMixAnalysisService } from '../services/autoMixAnalysisService'
import { releaseAppleNativeStream, type AppleNativeStream } from '../services/applePlayback'
import { isHlsUrl, attachAppleHls, detachAppleHls, getActiveAppleStream, getActiveHls } from '../services/appleHlsPlayer'
import { planTransition, planTransitionV2 } from '../audio/transitionPlanner'
import { TransitionRenderer } from '../audio/TransitionRenderer'
import { TrackStemMixer, TRACK_STEMS, UNITY_RECONSTRUCTION_GAINS, type TrackStemGains, type TrackStemName } from '../audio/trackStemMixer'
import { createPlaybackTimeStore } from '../audio/playbackTimeStore'
import { createTransitionVisualStore } from '../audio/transitionVisualStore'
import { GaplessIntegration } from '../services/gaplessIntegration'
import { createSeamlessJoinController, type SeamlessJoinController } from '../services/gapless/seamlessJoinController'
import { runGaplessDeckFade } from '../services/gapless/gaplessTransition'
import { GAPLESS_SEAMLESS_WARMUP_SECONDS } from '../services/gapless/gaplessConstants'
import { getProxiedAudioUrl } from '../services/musicApi'
import type { GaplessSettings } from '../services/gapless/gaplessConstants'
import type {
  PlaybackEngineState,
  PreloadTrack,
  TrackAnalysis,
  TransitionCommit,
  TransitionDebugInfo,
  TransitionPlan,
  TransitionState,
  TransitionStrategy,
} from '../audio/types'

export type AudioPlayerState = PlaybackEngineState

export interface TrackStemControlState {
  status: 'unavailable' | 'idle' | 'separating' | 'partial' | 'ready' | 'failed'
  gains: TrackStemGains
  availableStems: TrackStemName[]
  progress: number
  active: boolean
  locked: boolean
  reason?: string
}

export interface CrossfadeSettings {
  enabled: boolean
  duration: number
}

// GaplessSettings 已移入 src/services/gapless/gaplessConstants（本文件 re-export 保持兼容）

/** AutoMix Enhanced：把播放器曲目对象映射成云端档匹配所需的身份。
 *  QQ 曲库曲目直接给 mid；网易云/本地等其他平台留空 mid，由后端按「歌名 + 歌手」联想匹配。
 *  ⚠️ 跨平台补源（audioSourceOverride）时**渲染/下载用的音频来自 override 平台**，
 *  mid 必须取 override 的 id（QQ 的真实 songmid）——若拿原平台（如汽水）的 mid 当 QQ mid，
 *  云端会按完全无关的 QQ 歌给切点，过渡错位且无法被时长钳制发现（两版曲长可能恰好都在界内）。 */
function qqTrackRef(song: unknown): { mid?: string; title?: string; artist?: string; trackId?: string } {
  const s = song as {
    mid?: string; songmid?: string; songMid?: string; name?: string
    id?: string | number; artists?: Array<{ name?: string }>
    audioSourceOverride?: { platform?: string; id?: string | number }
  } | null | undefined
  if (!s) return {}
  const override = s.audioSourceOverride
  // 音源被补成 QQ 时，override.id 就是实际发声的 QQ 曲目 mid；此时原平台的 mid 不能用。
  const overrideIsQQ = override?.platform === 'qq' && String(override.id || '').trim().length > 0
  const mid = overrideIsQQ
    ? String(override!.id)
    : ([s.mid, s.songmid, s.songMid].find(value => typeof value === 'string' && value.length > 0) as string | undefined)
  const artist = Array.isArray(s.artists) ? s.artists.map(a => a?.name).filter(Boolean).join(' / ') : ''
  return {
    ...(mid ? { mid } : {}),
    ...(s.name ? { title: s.name } : {}),
    ...(artist ? { artist } : {}),
    ...(s.id != null ? { trackId: String(s.id) } : {}),
  }
}

export interface AutoMixSettings {
  enabled: boolean
  mode: 'auto' | 'manual'
  enableBeatMatching: boolean
  skipSilence: boolean
  minDuration?: number
  maxDuration?: number
  /** AutoMix Pro（v2）引擎开关：false/缺省 = 标准 v1（行为与历史一致） */
  enhanced?: boolean
  /** 过渡引擎三选一（standard / pro / enhanced）；缺省时按 enhanced 布尔值推导 */
  engine?: 'standard' | 'pro' | 'enhanced'
  /** AutoMix Enhanced 档位（Lite / Advanced / Extreme） */
  enhancedTier?: 'lite' | 'advanced' | 'extreme'
  /** v2 特效强度档位 */
  intensity?: 'subtle' | 'standard' | 'strong'
  /** v2 可选 AI 混音（DJTransGAN）开关 */
  aiMix?: boolean
}

// 音频图就绪后交给外部（音效引擎）的句柄
export interface AudioGraphHandle {
  audioContext: AudioContext
  masterGain: GainNode
  analyser: AnalyserNode
  /** 最终输出增益节点（analyser 之后、destination 之前）：AirPlay 投送时置 0 静音本机，
   *  不影响 masterGain（采集点在其后，采集到完整声音投送给音箱） */
  outputGain?: GainNode
  /** DG-LAB 立体声采集（analyser 输出之后、音效后信号）：左/右声道分析器（仅采集，不接 destination） */
  leftAnalyserNode?: AnalyserNode
  rightAnalyserNode?: AnalyserNode
  /** 左右声道分析器的输入分路；v3 接管音频图时需要将其重新接到处理后输出。 */
  channelSplitterNode?: ChannelSplitterNode
}

interface DeckMetadata extends PreloadTrack {
  analysis?: TrackAnalysis
}

const DEFAULT_VOLUME = 0.7
const CURVE_POINTS = 64
const EXTERNAL_HANDOFF_FADE_MS = 72
const EXTERNAL_HANDOFF_SYNC_TOLERANCE_SECONDS = 0.025
const CURRENT_MEDIA_LOAD_TIMEOUT_MS = 18_000
const PRELOAD_MEDIA_LOAD_TIMEOUT_MS = 15_000
// 过渡动画提前量：动画（倒计时/流光/渐变）最多提前这么久进入，
// 与音频过渡起点（可能是 AI 长混音的 ~60s 前）解耦。
const ANIMATION_LEAD_SECONDS = 10
/** 无 overlap 的渲染过渡（QQ Enhanced / 旧版智能渲染）：缓冲结束前这么久把目标 deck
 *  以 0 增益起播。预载 seek 早已落在 resume 附近，因此这里只是「按播放键」，
 *  数据已就绪 → 交接不再需要 seek + waitForPlayable（旧实现在缓冲结束后才起播，
 *  一路静音到 play() 成功，听感就是"过渡播完跳过去"）。 */
const RENDERED_HANDOFF_LEAD_SECONDS = 0.6
/** 交接交叉窗口：缓冲尾渐出 ↔ 目标 deck 渐入的重叠时长（与渲染器 handoffFadeSeconds 对齐） */
const RENDERED_HANDOFF_FADE_SECONDS = 0.35
/** DJTransGAN 训练窗口（秒）：渲染器未回填真实时长时的动画窗口兜底值 */
const AI_MIX_WINDOW_SECONDS = 60
/** AI 长混音动画窗口只覆盖混音尾部这么多秒（前段仅进度条推进，避免数十秒视觉占用） */
const ANIMATION_TAIL_SECONDS = 20
// REPREPARE（借鉴 QQ 音乐 FromInfo PREPARE_NEXT→REPREPARE_NEXT 441/442、469/470）：
// 分析/渲染失败属瞬时性（python worker 冷启动、网络抖动），只降级不重试会让整曲
// 周期停留在 fallback。失败后延时单次重试；冷却期防抖；最多 2 次尝试。
const AUTO_MIX_REPREPARE_DELAY_MS = 20_000
const AUTO_MIX_REPREPARE_COOLDOWN_MS = 15_000
const AUTO_MIX_MAX_PREPARE_ATTEMPTS = 2

function asPreloadTrack(input: string | PreloadTrack): PreloadTrack {
  return typeof input === 'string' ? { url: input } : input
}

export function resolvePairTransitionStrategy(
  current: Pick<PreloadTrack, 'appleHls'> | null | undefined,
  next: Pick<PreloadTrack, 'appleHls'> | null | undefined,
  settings: { autoMix: boolean; crossfade: boolean; gapless: boolean },
): TransitionStrategy | 'automix' {
  const applePair = Boolean(current?.appleHls || next?.appleHls)
  if (settings.autoMix) return applePair ? 'gapless' : 'automix'
  if (settings.crossfade) return 'fixed-crossfade'
  if (settings.gapless) return 'gapless'
  return 'none'
}

/**
 * 边界（曲尾交界）策略：专辑优先级必须落在**分流**上——同专辑相邻曲即使 AutoMix 开启也走
 * 无缝拼接（正式 gapless）。历史缺陷：触发/`handleEnded` 分支按字面量比较
 * `pairStrategy === 'automix' && !albumPlayback`，而 gapless 分支要求 `=== 'gapless'`，
 * 于是"专辑 + AutoMix"两条都不命中 → 每次换歌变成硬切 + 整曲重载的静音缝。
 */
export function resolveBoundaryStrategyFor(
  pair: TransitionStrategy | 'automix' | 'none',
  albumPlayback: boolean,
): TransitionStrategy | 'automix' | 'none' {
  if (pair === 'automix' && albumPlayback) return 'gapless'
  return pair
}

function equalPowerCurve(fadeIn: boolean): Float32Array {
  const curve = new Float32Array(CURVE_POINTS)
  for (let i = 0; i < CURVE_POINTS; i += 1) {
    const progress = i / (CURVE_POINTS - 1)
    curve[i] = fadeIn ? Math.sin(progress * Math.PI / 2) : Math.cos(progress * Math.PI / 2)
  }
  return curve
}

/** ③ 格式/一致性预检（借鉴 QQ 音乐 addPlayer 前的格式 gate：声道不符直接放弃混音）。
 *  返回拦截原因；null = 放行。"明知会失败的组合"不进智能渲染，提前安静降级固定交叉。 */
export function describeTransitionCompatibilityIssue(
  source: TrackAnalysis,
  target: TrackAnalysis,
  current: DeckMetadata | null,
  next: DeckMetadata | null,
): string | null {
  const metadataIssue = (analysis: TrackAnalysis, label: string): string | null =>
    analysis.provider === 'metadata-only' || analysis.provider === 'tv-metadata-only' || analysis.provider === 'electron-unavailable'
      ? `${label}分析为元数据降级（provider=${analysis.provider}），无节拍网格可用`
      : null
  const providerIssue = metadataIssue(source, '当前曲') ?? metadataIssue(target, '下一曲')
  if (providerIssue) return providerIssue

  // 分析时长与流时长不一致（旧缓存/换源）：渲染窗口可能越过真实音频末尾，
  // AudioFile 读越界 → 渲染中途失败 → 只能在窗口起点后才发现
  // ⚠️ 只拦"分析比流短"（真截断：试听片段被钉进缓存）。"分析比流长"是元数据虚高
  // （QQ 真机实测元数据比实际文件普遍长 ~10s，2026-10-19 日志 4/4 首），不是陈旧缓存——
  // 双向 abs 比较会触发 stale-invalidate → 删缓存重下 → 依旧差 10s → REPREPARE 死循环
  //（真机表现：过渡药丸不显示、每次过渡直接跳过）。
  const durationIssue = (analysis: TrackAnalysis, stream: number, label: string): string | null => {
    if (!Number.isFinite(stream) || stream <= 0) return null
    if (!Number.isFinite(analysis.duration)) return null
    if (analysis.duration >= stream - 1.5) return null
    return `${label}分析时长与流时长不一致（analysis=${analysis.duration.toFixed(1)}s vs stream=${stream.toFixed(1)}s），疑似过期缓存或换源`
  }
  const streamIssue = durationIssue(source, Number(current?.duration) || 0, '当前曲')
    ?? durationIssue(target, Number(next?.duration) || 0, '下一曲')
  if (streamIssue) return streamIssue

  // 多声道（>2ch）：渲染管线（ensure_stereo 只上混单声道）按立体声数学处理，不做盲混
  const sourceChannels = source.audioFormat?.channels
  const targetChannels = target.audioFormat?.channels
  if (sourceChannels && sourceChannels > 2) return `当前曲为多声道音频（${sourceChannels}ch），智能混音仅支持立体声`
  if (targetChannels && targetChannels > 2) return `下一曲为多声道音频（${targetChannels}ch），智能混音仅支持立体声`
  return null
}

/** 渲染端 automix 事件写入后端日志文件（automix-backend.log），便于前后端合并定位。 */
function logAutomixBackend(scope: string, message: string): void {
  window.electron?.automixLog?.(scope, message).catch(() => undefined)
}

/**
 * 4 秒固定交叉安全网（格式预检拦截 / 准备失败 / 节流兜底 / 用户跳过智能混音 共用）。
 * 注意：窗口固定 4 秒，而真正执行时的淡化时长会按设置里的交叉时长收拢（见 startTransition），
 * 因此跳过智能混音时这首歌几乎完整播完，只在尾巴上做一次短交叉。
 */
function buildFallbackCrossfadePlanFor(
  current: { trackKey?: string; duration?: number },
  next: { trackKey?: string },
  activeDuration: number,
  reason: string,
): TransitionPlan {
  const fallbackDuration = 4
  const sourceTrackKey = String(current.trackKey || '')
  const targetTrackKey = String(next.trackKey || '')
  const sourceDuration = activeDuration || current.duration || 0
  return {
    id: `${sourceTrackKey}->${targetTrackKey}:fallback`,
    sourceTrackKey,
    targetTrackKey,
    sourceStartTime: Math.max(0, sourceDuration - fallbackDuration),
    sourceEndTime: sourceDuration,
    targetStartTime: 0,
    targetEndTime: fallbackDuration,
    beatCount: 0,
    sourceBpm: 120,
    targetBpm: 120,
    tempoRamp: [],
    sourceDownbeatIndex: 0,
    targetDownbeatIndex: 0,
    gainCurve: { source: [], target: [] },
    confidence: 0,
    strategy: 'fixed-crossfade',
    fallbackReason: reason,
    analysisVersion: 'unavailable',
    rendererVersion: 'browser-crossfade-v1',
  }
}

/** 从过渡计划构建调试信息（过渡调试弹窗展示用）。 */
function buildTransitionDebug(
  plan: TransitionPlan,
  engine: 'v1' | 'v2' | 'fallback',
  sourceAnalysis?: TrackAnalysis,
  targetAnalysis?: TrackAnalysis,
): TransitionDebugInfo {
  const effects: string[] = []
  if (plan.strategy === 'smart-rendered-qq') {
    const requested = plan.qq?.tier || 'lite'
    const applied = plan.qqAppliedTier || requested
    effects.push(`AutoMix Enhanced（${applied === requested ? requested : `${requested} → ${applied}`}）`)
    effects.push('云端智能混音链路：云端切点 + 效果链渲染（Lite 为本地自主优化版）')
    // 渲染 worker 透传的过渡手法（与 automix-lab recipes 的技术证据一致）
    for (const technique of plan.qqTechniques || []) {
      if (typeof technique === 'string' && technique.trim()) effects.push(technique.trim())
    }
  } else if (plan.strategy === 'smart-rendered-v2' && plan.v2?.aiMix === true) {
    // AI 混音：音频由 DJTransGAN 模型生成（推子+EQ 自动化），不叠加 DSP 特效清单
    effects.push('AI 混音（DJTransGAN 模型推子+EQ，60s 长混音）')
  } else if (plan.strategy === 'smart-rendered' || plan.strategy === 'smart-rendered-v2') {
    if (plan.djEffects?.enabled) {
      if (plan.djEffects.bassSwap) effects.push('低音互换')
      if (plan.djEffects.filterSweep) effects.push('滤波扫频')
      if (plan.djEffects.echoOut) effects.push('回声淡出')
      if (plan.djEffects.sweepFx) effects.push('噪声扫频')
    }
    if (plan.v2?.stemChoreography) {
      const stem = plan.v2.stemChoreography
      effects.push(`分轨交接（${stem.style}）`)
      effects.push(`鼓组@${stem.drumSwap.time.toFixed(1)}s`)
      effects.push(`贝斯@${stem.bassSwap.time.toFixed(1)}s`)
    }
    if (plan.v2?.choreography) {
      const choreography = plan.v2.choreography
      if (choreography.tempoRampUp) effects.push('加速')
      if (choreography.drumFill) effects.push(`鼓点填充×${choreography.drumFillBeats}拍`)
      if (choreography.riser) effects.push('Riser 渐强')
      if (choreography.reverbDip) effects.push('混响虚化')
    }
  }
  return {
    engine,
    strategy: plan.strategy,
    fallbackReason: plan.fallbackReason,
    sourceTrackKey: plan.sourceTrackKey,
    targetTrackKey: plan.targetTrackKey,
    beatCount: plan.beatCount,
    sourceBpm: plan.sourceBpm,
    targetBpm: plan.targetBpm,
    confidence: plan.confidence,
    rendererVersion: plan.rendererVersion,
    sourceStartTime: plan.sourceStartTime,
    sourceEndTime: plan.sourceEndTime,
    targetStartTime: plan.targetStartTime,
    targetEndTime: plan.targetEndTime,
    style: plan.v2?.choreography?.style,
    intensity: plan.v2?.intensity,
    effects,
    keyCompat: plan.v2?.choreography?.keyCompat,
    gainOffsetDb: plan.gainOffsetDb,
    sourceProvider: sourceAnalysis?.provider,
    targetProvider: targetAnalysis?.provider,
    // Enhanced 档位可见性：请求档位与实际生效档位不一致时，UI 必须能显示降级与原因
    qqAppliedTier: plan.strategy === 'smart-rendered-qq' ? (plan.qqAppliedTier || plan.qq?.tier) : undefined,
    tierFallbackReason: plan.strategy === 'smart-rendered-qq' ? plan.fallbackReason : undefined,
  }
}

function waitForSeek(audio: HTMLAudioElement, timeoutMs = 120): Promise<void> {
  if (!audio.seeking) return Promise.resolve()

  return new Promise(resolve => {
    let timeoutId = 0
    const finish = () => {
      audio.removeEventListener('seeked', finish)
      if (timeoutId) window.clearTimeout(timeoutId)
      resolve()
    }

    audio.addEventListener('seeked', finish, { once: true })
    timeoutId = window.setTimeout(finish, timeoutMs)
  })
}

/**
 * 等待音频元素在当前位置具备可播数据（readyState ≥ HAVE_CURRENT_DATA）。
 * handoff 时 seek 到 AI 混音恢复点（目标曲深处，可能超出预缓冲范围）后，
 * play() 前必须确认数据就绪，否则会在未缓冲位置出声失败 → 静音断开一次。
 * 本地缓存文件瞬时返回；网络流等待 canplay（最多 timeoutMs，超时也放行，
 * 交由浏览器尽力缓冲，避免无限阻塞过渡）。
 */
function waitForPlayable(audio: HTMLAudioElement, timeoutMs = 3000): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve()
  if (!audio.src && !audio.currentSrc) return Promise.resolve()

  return new Promise(resolve => {
    let timeoutId = 0
    const cleanup = () => {
      audio.removeEventListener('canplay', finish)
      audio.removeEventListener('canplaythrough', finish)
      audio.removeEventListener('error', finish)
      if (timeoutId) window.clearTimeout(timeoutId)
    }
    const finish = () => {
      cleanup()
      resolve()
    }
    audio.addEventListener('canplay', finish, { once: true })
    audio.addEventListener('canplaythrough', finish, { once: true })
    audio.addEventListener('error', finish, { once: true })
    timeoutId = window.setTimeout(finish, timeoutMs)
  })
}

export function useAudioPlayer(
  onStateChange: (state: Partial<AudioPlayerState>) => void,
  crossfadeSettings: CrossfadeSettings = { enabled: false, duration: 4 },
  gaplessSettings: GaplessSettings = { enabled: false, albumGapless: false },
  autoMixSettings: AutoMixSettings = {
    enabled: false,
    mode: 'auto',
    enableBeatMatching: true,
    skipSilence: true,
  },
  onAudioGraphReady?: (handle: AudioGraphHandle) => void
) {
  const primaryRef = useRef<HTMLAudioElement | null>(null)
  const secondaryRef = useRef<HTMLAudioElement | null>(null)
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)
  const activePrimaryRef = useRef(true)
  const onStateChangeRef = useRef(onStateChange)
  const crossfadeRef = useRef(crossfadeSettings)
  const gaplessRef = useRef(gaplessSettings)
  const autoMixRef = useRef(autoMixSettings)
  const onAudioGraphReadyRef = useRef(onAudioGraphReady)
  const volumeRef = useRef(DEFAULT_VOLUME)
  const transitionStateRef = useRef<TransitionState>('idle')
  /** 时钟停滞看门（见 emit）：{at: 上次采样时刻, value: 上次采样时间} */
  const clockStallWatchRef = useRef({ at: 0, value: -1 })
  /** 看歌挂起（App 进出看歌时置位）：挂起期间引擎不准备/不启动任何自动过渡，
   *  保证看歌期间歌曲不会因 automix 自动推进（切回仍是原歌），退出看歌时解除 */
  const watchHoldRef = useRef(false)
  const transitionPlanRef = useRef<TransitionPlan | null>(null)
  // 过渡缓冲播放中标记：源曲 deck 静音保持播放（驱动 UI 时间线）时会先于缓冲 ended，
  // handleEnded 据此忽略提前的源曲 ended，交由缓冲 ended → handoff 接管。
  const transitionBufferActiveRef = useRef(false)
  const transitionTimerRef = useRef<number | null>(null)
  // overlap handoff：deck 提前淡入的启动 timer（AI 长混音缓冲结束前 overlap 秒触发）
  const transitionDeckStartTimerRef = useRef<number | null>(null)
  const fallbackAnimationRef = useRef<number | null>(null)
  const transitionProgressAnimationRef = useRef<number | null>(null)  // 过渡进度动画帧
  const transitionStartTimeRef = useRef<number | null>(null)  // 过渡开始时间
  /** 卡死看门狗截止时间：running-transition 超过「过渡时长 + 余量」仍未提交时强制收尾。
   *  背景：提交由多条路径触发（缓冲 ended / 兜底 timer / 视觉提交批次），任何一条被
   *  竞态守卫拦下都不会重试——用户反馈的「过渡后歌词/时间冻结、音频却还在放」即由此类
   *  悬置状态造成（渲染路径尤其明显）。看门狗按期兜底，把 UI 与被听见的那条轨道重新对齐。 */
  const transitionStuckDeadlineRef = useRef<number | null>(null)
  /** 当前过渡策略（看门狗强制收尾时用来构造 transitionCommit）。 */
  const transitionStrategyRef = useRef<TransitionStrategy>('gapless')
  // 过渡进度 emit 节流：rAF 仍每帧驱动，但仅当距上次 emit ≥30ms 才 emit（约 30fps），
  // 降低 App 整树重渲染频率；progress 到达 1 时强制 emit 最终值确保状态复位
  const transitionProgressEmitTimeRef = useRef(0)
  const retiredDeckCleanupTimerRef = useRef<number | null>(null)
  const preparationAbortRef = useRef<AbortController | null>(null)
  const autoMixPreparationKeyRef = useRef<string | null>(null)
  const acceptanceAutoMixAnalysisStartsRef = useRef(0)
  // REPREPARE 状态：组合级"已就绪"集合 + 失败尝试记录 + 定时重试句柄
  // 会话集合上限：preparationKey 是 12 字段拼的长串，数百曲的长会话只增不减会缓慢积内存
  //（preparedOk 只在失败时 delete）。超限按插入序淘汰最旧（FIFO，语义近似会话遗忘）。
  const AUTO_MIX_SESSION_SET_MAX = 120
  const autoMixPreparedOkRef = useRef<Set<string>>(new Set())
  /** 用户在 HUD 点「关闭」跳过的曲对（`source->target`）：这对曲目不做智能混音，只在末尾做一次
   *  短交叉，让这首歌完整播完。按曲对记，下一首自己的过渡不受影响。 */
  const autoMixSkippedPairsRef = useRef<Set<string>>(new Set())
  const autoMixPreparationAttemptsRef = useRef<Map<string, { attempts: number; lastAt: number }>>(new Map())
  const autoMixPrepareRetryTimerRef = useRef<number | null>(null)
  const prepareAutoMixRef = useRef<() => void>(() => {})
  /** 无缝衔接智能短交叉的准备入口（ref 化，供 preload effect 稳定引用）。 */
  const prepareGaplessCrossfadeRef = useRef<() => void>(() => {})
  const preparationRevisionRef = useRef(0)
  const transitionExecutionRevisionRef = useRef(0)
  /** 无缝衔接的「智能短交叉」计划（独立于 AutoMix 的规划）。由 prepareGaplessCrossfade 用
   *  与 AutoMix 同一套分析/规划机制算出的 1.5–4s 窗口：交叉时长、交叉位置（节拍对齐、
   *  尾部静音裁剪）与前后取量都是分析运算的结果，不是固定值。id 带 `gapless` 前缀，
   *  交叉执行时据此豁免「按交叉设置收拢窗口」的降级。 */
  const gaplessPlanRef = useRef<TransitionPlan | null>(null)
  const visualSwitchTimerRef = useRef<number | null>(null)
  const preloadReadyCleanupRef = useRef<(() => void) | null>(null)
  const currentLoadWaitCancelRef = useRef<(() => void) | null>(null)
  // adoptExternalAudio 接管淡出的动画帧 id：用于卸载/取消路径 cancelAnimationFrame，防止 rAF 自循环泄漏
  const externalHandoffFadeFrameRef = useRef<number | null>(null)
  const transitionStartingRef = useRef(false)
  const isLoadingRef = useRef(false)
  const currentLoadRevisionRef = useRef(0)
  const currentMetadataRef = useRef<DeckMetadata | null>(null)
  const nextMetadataRef = useRef<DeckMetadata | null>(null)
  /** 当前曲是否为直播流（Apple 电台）：时长按 Infinity 处理，UI 显示直播态 */
  const isLiveRef = useRef(false)
  const audioContextRef = useRef<AudioContext | null>(null)
  const gainNodesRef = useRef<[GainNode | null, GainNode | null]>([null, null])
  // 元素→音频图的 MediaElementAudioSourceNode 引用。必须持有：它们没有其它 JS 引用时
  // 会被浏览器回收，一旦回收元素就脱离音频图——此后所有 setDeckGain 的 gain 淡化/静音
  // 全部失效（元素以 element.volume 直出），而 setDeckGain 还会把 volume 强制成 1，
  // 表现为"过渡期两首歌一起响、只能靠暂停清掉"。
  const mediaSourcesRef = useRef<[MediaElementAudioSourceNode | null, MediaElementAudioSourceNode | null]>([null, null])
  /** handoff 在途计数：异步续体（waitForSeek/waitForPlayable）期间的源曲 ended 不能被当作
   *  自然播完（否则 App 会整曲重载下一首，与随后 target.play() 打架）。用计数而非布尔，
   *  这样过期续体的收尾不会清掉"新过渡"的在途标记。 */
  const handoffPendingCountRef = useRef(0)
  /** 过渡进行中修改了 AutoMix 设置：延后到本次过渡结束后再重排（当场 cancel 会把源曲增益
   *  写回 1、停掉过渡缓冲，听感是"淡出到一半突然弹回原曲满音量"）。 */
  const pendingReprepareRef = useRef(false)
  const masterGainRef = useRef<GainNode | null>(null)
  const analyserNodeRef = useRef<AnalyserNode | null>(null)
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null)
  const leftAnalyserNodeRef = useRef<AnalyserNode | null>(null)
  const rightAnalyserNodeRef = useRef<AnalyserNode | null>(null)
  const [leftAnalyserNode, setLeftAnalyserNode] = useState<AnalyserNode | null>(null)
  const [rightAnalyserNode, setRightAnalyserNode] = useState<AnalyserNode | null>(null)
  const transitionRendererRef = useRef<TransitionRenderer | null>(null)
  const trackStemMixerRef = useRef<TrackStemMixer | null>(null)
  const trackStemGenerationRef = useRef(0)
  const trackStemInputPathRef = useRef<string | null>(null)
  const trackStemManifestRef = useRef<import('../electron').TrackStemManifest | null>(null)
  const trackStemPumpTimerRef = useRef<number | null>(null)
  const trackStemResumePendingRef = useRef<Promise<boolean> | null>(null)
  const [trackStemControl, setTrackStemControl] = useState<TrackStemControlState>({
    status: 'idle', gains: { ...UNITY_RECONSTRUCTION_GAINS }, availableStems: [...TRACK_STEMS], progress: 0, active: false, locked: false,
  })
  const trackStemControlRef = useRef(trackStemControl)
  trackStemControlRef.current = trackStemControl
  const trackStemDesiredRef = useRef(false)
  // 用户是否主动开启过分轨（区别于 desired 的运行时门控）：变速播放会把 desired
  // 清成 false，恢复原速时按这个标记把分轨接回来——否则倍速过一次分轨就永久失效。
  const trackStemUserWantedRef = useRef(false)
  const gaplessIntegrationRef = useRef<GaplessIntegration | null>(null)
  // Gapless 首选无缝拼接控制器（独立模块，逻辑见 src/services/gapless/）
  const seamlessJoinControllerRef = useRef<SeamlessJoinController | null>(null)
  const playAtCallbackRef = useRef<((index: number, options: any) => Promise<boolean>) | null>(null)
  const [playbackTimeStore] = useState(createPlaybackTimeStore)
  /** 过渡视觉轨道：逐帧进度/时间线/视觉切换标记（叶子组件订阅，避免 App 整树 30fps 重渲染）。 */
  const [transitionVisualStore] = useState(createTransitionVisualStore)

  // ── 外部播放源模式（WebView2 播放面）──
  // 音频在 WebView2 兼容播放窗口中解密播放，本地 deck 无 src；
  // 状态经 bridge 轮询 → emit 管线分发，控制命令转发 bridge（见 togglePlay/seek/setVolume 分流）。
  const externalActiveRef = useRef(false)
  const externalUnsubscribeRef = useRef<(() => void) | null>(null)
  const externalEndedFiredRef = useRef(false)
  const externalDurationRef = useRef(0)
  /** 基础交叉淡化：淡出斜坡在途标记（seek 出窗口/暂停时复位并恢复音量） */
  const externalFadeActiveRef = useRef(false)
  /** 上一首带淡出尾自然结束 → 下一首（Apple 或本地 deck）做淡入头（基础交叉的"入"半边） */
  const externalEndedWithFadeRef = useRef(false)
  useEffect(() => () => { try { externalUnsubscribeRef.current?.() } catch { /* 卸载清理 */ } }, [])

  useEffect(() => { onStateChangeRef.current = onStateChange }, [onStateChange])
  useEffect(() => { crossfadeRef.current = crossfadeSettings }, [crossfadeSettings])
  useEffect(() => { gaplessRef.current = gaplessSettings }, [gaplessSettings])
  useEffect(() => { autoMixRef.current = autoMixSettings }, [autoMixSettings])
  useEffect(() => { onAudioGraphReadyRef.current = onAudioGraphReady }, [onAudioGraphReady])

  const emit = useCallback((state: Partial<AudioPlayerState>) => {
    if (state.currentTime !== undefined || state.duration !== undefined || state.isPlaying !== undefined) {
      playbackTimeStore.publish({
        ...(state.currentTime !== undefined ? { currentTime: state.currentTime } : {}),
        ...(state.duration !== undefined ? { duration: state.duration } : {}),
        ...(state.isPlaying !== undefined ? { isPlaying: state.isPlaying } : {}),
      })
    }
    // 时钟停滞诊断：播放中但 emit 的时间连续 5 秒不前进 → 落盘一次（含过渡状态与活动 deck）。
    // 用于定位「过渡后音频在放、UI/歌词时钟冻结」类问题——先证明哪个时钟停了。
    if (state.currentTime !== undefined) {
      const watch = clockStallWatchRef.current
      const nowMs = performance.now()
      if (watch.value < 0) {
        watch.value = state.currentTime
        watch.at = nowMs
      } else if (nowMs - watch.at >= 5000) {
        const playingNow = state.isPlaying ?? playbackTimeStore.getSnapshot().isPlaying
        if (playingNow && state.currentTime === watch.value) {
          const activeDeck = activePrimaryRef.current ? primaryRef.current : secondaryRef.current
          logAutomixBackend(
            'clock:stall',
            `t=${state.currentTime.toFixed(2)} state=${transitionStateRef.current} paused=${activeDeck?.paused} src=…${String(activeDeck?.currentSrc || '').slice(-36)}`,
          )
        }
        watch.at = nowMs
        watch.value = state.currentTime
      }
    }
    // 逐帧过渡进度不进 React 状态（App 层那 10fps 节流正是"过渡看起来卡"的来源），
    // 改由视觉轨道 store 直接广播给订阅它的叶子组件。
    if (state.transitionProgress !== undefined) {
      transitionVisualStore.publish({
        active: true,
        progress: state.transitionProgress,
        ...(state.transitionDuration !== undefined ? { duration: state.transitionDuration } : {}),
        ...(state.transitionTargetTime !== undefined ? { targetTime: state.transitionTargetTime } : {}),
        // 过渡期间 emit 的 currentTime 就是"源曲时间轴上的合成时间"
        ...(state.currentTime !== undefined ? { sourceTime: state.currentTime } : {}),
      })
    }
    onStateChangeRef.current(state)
  }, [transitionVisualStore])

  /** 直播流（HLS Infinity）等异常时长收敛为 0（UI 依赖有限值显示/拖动） */
  const finiteDuration = useCallback((value: number | undefined): number => {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  }, [])

  const setTransitionState = useCallback((state: TransitionState, extra: Partial<AudioPlayerState> = {}) => {
    transitionStateRef.current = state
    // 过渡窗口终点随状态一起下发：AI 长混音的合成时间超过源曲时长，进度条需要
    // 用 plan.sourceEndTime（而不是 duration）做分母，否则恒 100%。
    if (state === 'armed' || state === 'running-transition') {
      extra.transitionSourceEndTime = transitionPlanRef.current?.sourceEndTime ?? null
    } else if (extra.transitionSourceEndTime === undefined) {
      extra.transitionSourceEndTime = null
    }
    if (state === 'running-transition') {
      // 视觉轨道开跑：从这一帧起进度/时间线由 rAF 逐帧发布；真实时长由随后的帧回填。
      // animationLeadSeconds 必须与 App 侧算动画窗口的口径一致（AI 长混音 20s，其余 10s），
      // 否则叠加层的窗口门控会与 transitionStartTime 错位。
      const activePlan = transitionPlanRef.current
      const animationLead = activePlan && activePlan.strategy === 'smart-rendered-v2' && activePlan.v2?.aiMix === true
        ? ANIMATION_TAIL_SECONDS
        : ANIMATION_LEAD_SECONDS
      transitionVisualStore.begin({
        fromTrackKey: currentMetadataRef.current?.trackKey || '',
        toTrackKey: nextMetadataRef.current?.trackKey || String(extra.transitionToTrackKey || ''),
        duration: 0,
        animationLeadSeconds: animationLead,
      })
      trackStemDesiredRef.current = false
      trackStemGenerationRef.current += 1
      if (trackStemPumpTimerRef.current !== null) window.clearInterval(trackStemPumpTimerRef.current)
      trackStemPumpTimerRef.current = null
      const trackId = currentMetadataRef.current?.trackKey
      if (trackId) void window.electron?.trackStems?.cancel?.({ trackId })
      trackStemMixerRef.current?.returnToOriginal()
      setTrackStemControl(current => ({ ...current, active: false, locked: true, reason: 'AutoMix 过渡期间已冻结分轨增益' }))
    } else if (state === 'playing' || state === 'cancelled' || state === 'failed') {
      setTrackStemControl(current => ({ ...current, locked: false, reason: current.status === 'unavailable' ? current.reason : undefined }))
      // 提交（playing）保留最后一帧：提交帧与"视觉已切到目标曲"同批，叠加层此刻与 canonical
      // 内容一致，保帧可避免"叠加层先消失再换成新曲"的闪动；取消/失败则直接收起。
      transitionVisualStore.end(state === 'playing')
    } else if (state === 'idle') {
      transitionVisualStore.end(false)
    }
    emit({ transitionState: state, ...extra })
  }, [emit, transitionVisualStore])

  const getActiveAudio = useCallback(() => activePrimaryRef.current ? primaryRef.current : secondaryRef.current, [])
  const getStandbyAudio = useCallback(() => activePrimaryRef.current ? secondaryRef.current : primaryRef.current, [])
  const getActiveGain = useCallback(() => gainNodesRef.current[activePrimaryRef.current ? 0 : 1], [])
  const getStandbyGain = useCallback(() => gainNodesRef.current[activePrimaryRef.current ? 1 : 0], [])

  // 专辑播放判定（三方案分流依据）：当前曲与下一曲属于同一专辑
  // （albumId 都存在且相等）→ 专辑场景；否则为非专辑（普通列表）场景。
  // 同专辑时即使 AutoMix 启用也优先走首尾拼接无缝方案（预热 20s + ended 拼接），
  // AutoMix 智能过渡只接管非专辑场景。
  const isAlbumPlayback = useCallback(() => {
    const currentMeta = currentMetadataRef.current
    const nextMeta = nextMetadataRef.current
    return Boolean(currentMeta?.albumId && nextMeta?.albumId && currentMeta.albumId === nextMeta.albumId)
  }, [])

  /**
   * 边界（曲尾交界）处理策略——专辑优先级必须落在**分流**上，而不是只在"是否准备"里排除。
   * 历史缺陷：触发分支要求 `pairStrategy === 'automix' && !albumPlayback`，而 gapless 分支要求
   * `pairStrategy === 'gapless'`；AutoMix 开启时 pairStrategy 恒为 'automix' ⇒ 同专辑相邻曲
   * 两条分支都不走，`handleEnded` 同样落空 → 每首歌边界都变成硬切 + 整曲重载的静音缝。
   */
  const resolveBoundaryStrategy = useCallback((): TransitionStrategy | 'automix' | 'none' => {
    const pair = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
      autoMix: autoMixRef.current.enabled,
      crossfade: crossfadeRef.current.enabled,
      gapless: gaplessRef.current.enabled,
    })
    return resolveBoundaryStrategyFor(pair, isAlbumPlayback())
  }, [isAlbumPlayback])

  /** 该 deck 是否仍确实接在音频图上（源节点被持有、context 未释放、且与元素配对）。
   *  用于 setDeckGain 决定"靠 gain 控音量"还是"退化为元素音量"。 */
  const isDeckRouted = useCallback((audio: HTMLAudioElement | null): boolean => {
    const ctx = audioContextRef.current
    if (!audio || !ctx || ctx.state === 'closed') return false
    if (audio === primaryRef.current) {
      const source = mediaSourcesRef.current[0]
      return Boolean(source && source.context === ctx)
    }
    if (audio === secondaryRef.current) {
      const source = mediaSourcesRef.current[1]
      return Boolean(source && source.context === ctx)
    }
    return false
  }, [])

  const setDeckGain = useCallback((gain: GainNode | null, audio: HTMLAudioElement | null, value: number) => {
    const next = Math.max(0, Math.min(1, value))
    // 仅在"确实接着音频图"时把元素音量置 1、由 gain 承担全部响度控制；
    // 一旦脱钩（源节点被回收 / context 已释放），必须退化为元素音量控制——
    // 否则 element.volume 停在 1、gain 又不起作用，静音与淡化会整体失效。
    if (gain && audioContextRef.current && isDeckRouted(audio)) {
      gain.gain.cancelScheduledValues(audioContextRef.current.currentTime)
      gain.gain.setValueAtTime(next, audioContextRef.current.currentTime)
      if (audio) audio.volume = 1
    } else if (audio) {
      audio.volume = next * volumeRef.current
    }
  }, [isDeckRouted])

  const ensureAudioGraph = useCallback(async () => {
    if (audioContextRef.current) {
      if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume().catch(() => undefined)
      return
    }
    const first = primaryRef.current
    const second = secondaryRef.current
    const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!first || !second || !AudioContextCtor) return
    let context: AudioContext | null = null
    try {
      // TV：playback 延迟提示让音频线程用更大缓冲——弱机 SoC 上显著减少唤醒频率与爆音。
      // 代价是输出延迟略增（约几十 ms，歌词/进度观感无差）；桌面端保持默认（低延迟）。
      context = isTvModeActive()
        ? new AudioContextCtor({ latencyHint: 'playback' })
        : new AudioContextCtor()
      const master = context.createGain()
      const firstGain = context.createGain()
      const secondGain = context.createGain()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.minDecibels = -90
      analyser.maxDecibels = -8
      analyser.smoothingTimeConstant = 0.58
      // 最终输出增益节点：AirPlay 投送时置 0 静音本机输出；采集点在 analyser 之后
      //（取完整混音），不受本节点影响，投送给音箱的仍是完整声音
      const outputGain = context.createGain()
      outputGain.gain.value = 1
      const firstSource = context.createMediaElementSource(first)
      firstSource.connect(firstGain).connect(master)
      const secondSource = context.createMediaElementSource(second)
      secondSource.connect(secondGain).connect(master)
      // 必须持有引用：MediaElementAudioSourceNode 无 JS 引用时可能被回收，元素随即脱离
      // 音频图（gain 淡化/静音全部失效，且元素以 volume=1 直出）。
      mediaSourcesRef.current = [firstSource, secondSource]
      master.connect(analyser).connect(outputGain).connect(context.destination)
      // DG-LAB 立体声采集：ChannelSplitter 挂在 **analyser 之后**（不是 master）。
      // 此前从 master 直接取：三引擎 attach 第一步 masterGain.disconnect()（无参全断）
      // 会连同 master→splitter 一起断开，dispose 只恢复 master→analyser —— 左右声道
      // 分析自首次 attach 起就永久断流（立体声体感/可视化失效）。挂在 analyser 后，
      // 引擎恢复 master→analyser 直连时采集支路随之自动恢复。
      // 体感强度与左右声像同源（效果链后）；EQ/压缩类效果不影响声像，语义不变。
      const splitter = context.createChannelSplitter(2)
      const leftAnalyser = context.createAnalyser()
      const rightAnalyser = context.createAnalyser()
      leftAnalyser.fftSize = 1024
      leftAnalyser.minDecibels = -90
      leftAnalyser.maxDecibels = -8
      leftAnalyser.smoothingTimeConstant = 0.58
      rightAnalyser.fftSize = 1024
      rightAnalyser.minDecibels = -90
      rightAnalyser.maxDecibels = -8
      rightAnalyser.smoothingTimeConstant = 0.58
      const silentL = context.createGain()
      const silentR = context.createGain()
      silentL.gain.value = 0
      silentR.gain.value = 0
      analyser.connect(splitter)
      splitter.connect(leftAnalyser, 0)
      splitter.connect(rightAnalyser, 1)
      leftAnalyser.connect(silentL).connect(context.destination)
      rightAnalyser.connect(silentR).connect(context.destination)
      master.gain.value = volumeRef.current
      firstGain.gain.value = activePrimaryRef.current ? 1 : 0
      secondGain.gain.value = activePrimaryRef.current ? 0 : 1
      first.volume = 1
      second.volume = 1
      audioContextRef.current = context
      gainNodesRef.current = [firstGain, secondGain]
      masterGainRef.current = master
      analyserNodeRef.current = analyser
      setAnalyserNode(analyser)
      leftAnalyserNodeRef.current = leftAnalyser
      rightAnalyserNodeRef.current = rightAnalyser
      setLeftAnalyserNode(leftAnalyser)
      setRightAnalyserNode(rightAnalyser)
      // 应用用户选择的音频输出设备（AudioContext.setSinkId，整体切换输出）
      void import('../services/audioOutput').then(({ applyStoredOutputDevice, registerActiveAudioContext }) => {
        registerActiveAudioContext(context)
        void applyStoredOutputDevice(context)
      })
      transitionRendererRef.current = new TransitionRenderer(context, master)
      
      // 初始化 Gapless Integration
      if (gaplessIntegrationRef.current) {
        gaplessIntegrationRef.current.initAudioContext(context, analyser)
      }
      
      // 通知外部音效引擎：音频图已就绪（在 masterGain 与 analyser 之间插入效果链）
      onAudioGraphReadyRef.current?.({ audioContext: context, masterGain: master, analyser, outputGain, leftAnalyserNode: leftAnalyser, rightAnalyserNode: rightAnalyser, channelSplitterNode: splitter })
      
      if (context.state === 'suspended') await context.resume().catch(() => undefined)
    } catch (error) {
      console.warn('[PlaybackEngine] Web Audio gain graph unavailable, using media volume fallback', error)
      if (context && context.state !== 'closed') void context.close()
      audioContextRef.current = null
      gainNodesRef.current = [null, null]
      masterGainRef.current = null
      analyserNodeRef.current = null
      leftAnalyserNodeRef.current = null
      rightAnalyserNodeRef.current = null
      setAnalyserNode(null)
      setLeftAnalyserNode(null)
      setRightAnalyserNode(null)
    }
  }, [])

  const resetTrackStemMixer = useCallback((status: TrackStemControlState['status'] = 'idle', reason?: string) => {
    if (trackStemPumpTimerRef.current !== null) window.clearInterval(trackStemPumpTimerRef.current)
    trackStemPumpTimerRef.current = null
    trackStemResumePendingRef.current = null
    const currentTrackId = currentMetadataRef.current?.trackKey
    if (currentTrackId) void window.electron?.trackStems?.cancel?.({ trackId: currentTrackId })
    const retiringMixer = trackStemMixerRef.current
    retiringMixer?.returnToOriginal()
    if (retiringMixer) window.setTimeout(() => retiringMixer.dispose(), 90)
    trackStemMixerRef.current = null
    trackStemInputPathRef.current = null
    trackStemManifestRef.current = null
    trackStemGenerationRef.current += 1
    trackStemDesiredRef.current = false
    // 切歌重置 = 换歌后的全新分轨会话：用户意图标记一并复位
    trackStemUserWantedRef.current = false
    setTrackStemControl({
      status,
      gains: { ...UNITY_RECONSTRUCTION_GAINS },
      availableStems: [],
      progress: 0,
      active: false,
      locked: false,
      ...(reason ? { reason } : {}),
    })
  }, [])

  const ensureTrackStemInput = useCallback(async (metadata: DeckMetadata): Promise<string> => {
    const bridge = window.electron?.audioDownload
    if (!bridge?.prepare) throw new Error('音频缓存服务不可用')
    // 整曲 runtime 对 WAV 随机读取；MP3/FLAC 等由打包的 Python/Pedalboard 辅助进程
    // 只解码目标20秒窗口，不在渲染进程展开整首 PCM。
    return bridge.prepare(metadata.url, metadata.trackKey || metadata.url)
  }, [])

  // ===== 用户倍速（歌曲本体）：与引擎 BPM 变速（AI 混音 playbackRate）互斥 =====
  // 过渡（preparing-next/armed/running-transition/committed）期间用户倍速必须让位：引擎在
  // overlap 窗口以 speedRatio 驱动 deck。applyUserPlaybackSpeed 只在 playing/idle 应用；
  // 过渡开始时 App 广播 PLAYBACK_SPEED_TRANSITION_EVENT，这里把元素归 1，过渡结束（回 playing）
  // 再恢复用户倍速——避免过渡段被用户倍速二次叠加导致 BPM 失配。
  const userSpeedRef = useRef(1)
  const applyUserPlaybackSpeed = useCallback((speed: number) => {
    const clamped = PLAYBACK_SPEED_OPTIONS.includes(speed as never) ? speed : 1
    userSpeedRef.current = clamped
    setEffectivePlaybackSpeed(clamped)
    const audio = getActiveAudio()
    // armed（automix 已排定下一首但当前曲还在正常播）也要应用：否则 AutoMix 开着时
    // 用户改倍速完全无效（界面变了、声音没变——用户实测反馈）。running-transition 仍让位。
    // preparing-next 同理：预载下一首期间当前曲还在正常播，忽略倍速会"UI 显示新倍速、
    // 实际 1.0"直到下一次 play/过渡提交（无补应用的出口）。
    if (audio && (transitionStateRef.current === 'playing' || transitionStateRef.current === 'idle' || transitionStateRef.current === 'loading-current' || transitionStateRef.current === 'armed' || transitionStateRef.current === 'preparing-next')) {
      audio.playbackRate = clamped
    }
  }, [getActiveAudio])

  useEffect(() => {
    const onSettings = (event: Event) => {
      const speed = (event as CustomEvent<number>).detail
      if (typeof speed === 'number') applyUserPlaybackSpeed(speed)
    }
    const onTransitionReset = () => {
      // 过渡开始：引擎要接管 playbackRate（BPM 变速），用户倍速先归 1（注册表同步为生效值 1）
      setEffectivePlaybackSpeed(1)
      for (const audio of [primaryRef.current, secondaryRef.current]) {
        if (audio) audio.playbackRate = 1
      }
    }
    window.addEventListener(PLAYBACK_SPEED_SETTINGS_EVENT, onSettings)
    window.addEventListener(PLAYBACK_SPEED_TRANSITION_EVENT, onTransitionReset)
    return () => {
      window.removeEventListener(PLAYBACK_SPEED_SETTINGS_EVENT, onSettings)
      window.removeEventListener(PLAYBACK_SPEED_TRANSITION_EVENT, onTransitionReset)
    }
  }, [applyUserPlaybackSpeed])

  // 播放启动时应用用户倍速（新 audio 元素/换曲后 playbackRate 回到默认 1）；
  // 过渡状态下跳过（running-transition/committed 时引擎正以变速驱动，恢复交给过渡收尾）
  useEffect(() => {
    const applySpeedOnPlay = () => {
      const state = transitionStateRef.current
      const audio = getActiveAudio()
      if (audio && userSpeedRef.current !== 1
        && (state === 'playing' || state === 'idle' || state === 'loading-current' || state === 'preparing-next')) {
        audio.playbackRate = userSpeedRef.current
        setEffectivePlaybackSpeed(userSpeedRef.current)
      }
    }
    window.addEventListener('play', applySpeedOnPlay, true)
    return () => window.removeEventListener('play', applySpeedOnPlay, true)
  }, [getActiveAudio])

  // 分轨启用防重入：enable 是重活（换 generation 会 kill 上一个 worker），连发会自踩。
  // 播放页滑块/学歌伴奏模式/预载路径可能短时间内多次触发，这里收敛为单个 in-flight
  // promise，后来的调用直接等它完成并复用结果——不换 generation、不杀 worker。
  const trackStemEnableInFlightRef = useRef<Promise<boolean> | null>(null)

  const enableTrackStems = useCallback(async (): Promise<boolean> => {
    if (trackStemEnableInFlightRef.current) return trackStemEnableInFlightRef.current
    const attempt = (async () => {
      return await enableTrackStemsInner()
    })()
    trackStemEnableInFlightRef.current = attempt
    try {
      return await attempt
    } finally {
      // 清理让下一次真实重试成为可能；失败也清（failed 状态允许用户重试）
      if (trackStemEnableInFlightRef.current === attempt) trackStemEnableInFlightRef.current = null
    }
  }, [])

  const enableTrackStemsInner = useCallback(async (): Promise<boolean> => {
    const metadata = currentMetadataRef.current
    const audio = getActiveAudio()
    if (!metadata?.url || !metadata.trackKey || !audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
      trackStemDesiredRef.current = false
      setTrackStemControl(current => ({ ...current, status: 'unavailable', active: false, reason: '当前音源不支持分轨' }))
      return false
    }
    if (externalActiveRef.current || getActiveHls(audio) || isLiveRef.current) {
      trackStemDesiredRef.current = false
      setTrackStemControl(current => ({ ...current, status: 'unavailable', active: false, reason: 'DRM、HLS 或直播音源暂不支持分轨' }))
      return false
    }
    if (transitionStateRef.current === 'running-transition') {
      setTrackStemControl(current => ({ ...current, locked: true, reason: 'AutoMix 过渡期间暂不可调整' }))
      return false
    }
    if (trackStemMixerRef.current && trackStemControlRef.current.status !== 'failed') {
      const resumed = await trackStemMixerRef.current.play(audio.currentTime).catch(() => false)
      if (resumed) {
        trackStemDesiredRef.current = true
        trackStemUserWantedRef.current = true
        setTrackStemControl(current => ({ ...current, active: true, reason: undefined }))
        return true
      }
    }
    await ensureAudioGraph()
    const context = audioContextRef.current
    const master = masterGainRef.current
    const originalGain = getActiveGain()
    const bridge = window.electron?.trackStems
    const runtimeStatus = await bridge?.status?.().catch(() => null)
    if (!context || !master || !originalGain || !bridge?.ensureWindow || !runtimeStatus?.available) {
      trackStemDesiredRef.current = false
      setTrackStemControl(current => ({ ...current, status: 'unavailable', active: false, reason: '请先在设置中安装 HTDemucs 分轨模型' }))
      return false
    }

    const generation = ++trackStemGenerationRef.current
    trackStemDesiredRef.current = true
    trackStemUserWantedRef.current = true
    setTrackStemControl(current => ({ ...current, status: 'separating', progress: 0, active: false, locked: false, reason: undefined }))
    // 真实进度代替恒 0%：首次分离要加载模型 + 推理首个 20s 分段（约 10–20s），界面一直显示 0%
    // 会被当成卡死（用户实测"点了没反应"）。这里按**已就绪的分段数**推进，激活后再交给泵接管。
    const totalCores = Math.max(1, Math.ceil(audio.duration / 20))
    const countedCores = new Set<number>()
    let preparedCores = 0
    try {
      const inputPath = await ensureTrackStemInput(metadata)
      if (generation !== trackStemGenerationRef.current) return false
      trackStemInputPathRef.current = inputPath
      const manifestPromises = new Map<number, Promise<import('../electron').TrackStemManifest | null>>()
      const detected = new Set<TrackStemName>()
      const provider = async ({ track, stem, chunkIndex, startTime, signal }: import('../audio/trackStemMixer').StemChunkRequest) => {
        if (signal.aborted || generation !== trackStemGenerationRef.current) return null
        const coreStart = Math.floor(startTime / 20) * 20
        const coreIndex = Math.floor(coreStart / 20)
        let pending = manifestPromises.get(coreIndex)
        if (!pending) {
          pending = bridge.ensureWindow({
            inputPath,
            trackId: track.id,
            generationToken: String(generation),
            requestId: `${track.id}:${generation}:core-${coreIndex}`,
            chunkSeconds: 5,
            start: coreStart,
            duration: Math.min(20, Math.max(0.05, track.duration - coreStart)),
            priority: 1_000_000,
          }).catch(error => {
            manifestPromises.delete(coreIndex)
            throw error
          })
          manifestPromises.set(coreIndex, pending)
        }
        const manifest = await pending
        if (!manifest || signal.aborted || generation !== trackStemGenerationRef.current) return null
        trackStemManifestRef.current = manifest
        // 同一分段的多个 chunk 请求共享同一个 manifest promise，按分段去重计数，避免进度虚高
        if (!countedCores.has(coreIndex)) {
          countedCores.add(coreIndex)
          preparedCores += 1
          setTrackStemControl(current => current.status === 'separating'
            ? { ...current, progress: Math.min(0.95, preparedCores / totalCores) }
            : current)
        }
        const chunk = manifest.chunks.find(item => Math.abs(item.startSeconds - startTime) < 0.02)
        const file = chunk?.files?.[stem]
        if (!file) return null
        const buffer = await bridge.readChunk(file)
        const decoded = await context.decodeAudioData(buffer.slice(0))
        if (signal.aborted || generation !== trackStemGenerationRef.current) return null
        let energy = 0
        for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
          const data = decoded.getChannelData(channel)
          for (let index = 0; index < data.length; index += Math.max(1, Math.floor(data.length / 2048))) energy += data[index] * data[index]
        }
        if (energy > 1e-5) {
          detected.add(stem)
          setTrackStemControl(current => ({ ...current, availableStems: TRACK_STEMS.filter(name => detected.has(name)) }))
        }
        return decoded
      }
      trackStemMixerRef.current?.dispose()
      const mixer = new TrackStemMixer({
        context, provider, master, originalGain,
        positionProvider: () => getActiveAudio()?.currentTime ?? 0,
        onBufferUnderrun: () => {
          trackStemMixerRef.current?.returnToOriginal()
          setDeckGain(getActiveGain(), getActiveAudio(), 1)
          setTrackStemControl(current => ({ ...current, active: false, status: 'partial', reason: '前方分轨尚未准备好，已临时恢复原声' }))
        },
        chunkDuration: 5, prepareDuration: 20, maxBufferedChunks: 32,
      })
      trackStemMixerRef.current = mixer
      mixer.loadTrack({ id: metadata.trackKey, duration: audio.duration, chunkDuration: 5 })
      const resumeMixerAtLivePosition = () => {
        if (trackStemResumePendingRef.current) return trackStemResumePendingRef.current
        const pending = mixer.play(audio.currentTime)
        trackStemResumePendingRef.current = pending
        void pending.finally(() => {
          if (trackStemResumePendingRef.current === pending) trackStemResumePendingRef.current = null
        }).catch(() => undefined)
        return pending
      }
      const played = audio.paused
        ? (await mixer.prepareWindow(audio.currentTime, 20), true)
        : await resumeMixerAtLivePosition()
      if (!played || generation !== trackStemGenerationRef.current) throw new Error('当前位置分轨尚未准备完成')
      setTrackStemControl(current => ({ ...current, status: 'partial', progress: Math.min(1, (audio.currentTime + 20) / audio.duration), active: true, gains: mixer.getSnapshot().gains }))

      trackStemPumpTimerRef.current = window.setInterval(() => {
        const liveAudio = getActiveAudio()
        const liveMixer = trackStemMixerRef.current
        if (!liveAudio || !liveMixer || generation !== trackStemGenerationRef.current || liveAudio.paused) return
        const drift = Math.abs(liveMixer.getSnapshot().position - liveAudio.currentTime)
        if (drift > 0.12) {
          liveMixer.returnToOriginal()
          liveMixer.seek(liveAudio.currentTime)
          setDeckGain(getActiveGain(), liveAudio, 1)
          void resumeMixerAtLivePosition().then(ready => {
            if (ready && generation === trackStemGenerationRef.current) {
              setTrackStemControl(current => ({ ...current, active: true }))
            }
          }).catch(() => undefined)
          return
        }
        void liveMixer.prepareWindow(liveAudio.currentTime, 20).then(async () => {
          if (generation !== trackStemGenerationRef.current) return
          if (trackStemDesiredRef.current && !trackStemControlRef.current.active) {
            const ready = await resumeMixerAtLivePosition()
            if (ready && generation === trackStemGenerationRef.current) {
              setTrackStemControl(current => ({ ...current, active: true, reason: undefined }))
            }
          }
          setTrackStemControl(current => ({ ...current, progress: Math.min(1, (liveAudio.currentTime + 20) / Math.max(1, liveAudio.duration)) }))
        }).catch(() => undefined)
      }, 3000)

      void bridge.materialize({
        inputPath,
        trackId: metadata.trackKey,
        generationToken: String(generation),
        requestId: `${metadata.trackKey}:${generation}:background`,
        chunkSeconds: 5,
        windows: [
          { start: Math.floor(audio.currentTime / 20) * 20, duration: Math.max(0.05, audio.duration - Math.floor(audio.currentTime / 20) * 20) },
          ...(audio.currentTime > 0.05 ? [{ start: 0, duration: Math.floor(audio.currentTime / 20) * 20 }] : []),
        ],
        priority: -100,
      }).then(manifest => {
        if (!manifest || generation !== trackStemGenerationRef.current) return
        trackStemManifestRef.current = manifest
        setTrackStemControl(current => ({ ...current, status: 'ready', progress: 1 }))
      }).catch(() => undefined)
      return true
    } catch (error) {
      if (generation !== trackStemGenerationRef.current) return false
      trackStemDesiredRef.current = false
      trackStemMixerRef.current?.returnToOriginal()
      trackStemMixerRef.current?.dispose()
      trackStemMixerRef.current = null
      setTrackStemControl(current => ({ ...current, status: 'failed', active: false, reason: error instanceof Error ? error.message : '分轨失败' }))
      return false
    }
  }, [ensureAudioGraph, ensureTrackStemInput, getActiveAudio, getActiveGain])

  const setTrackStemGains = useCallback((gains: Partial<TrackStemGains>) => {
    const mixer = trackStemMixerRef.current
    if (!mixer || transitionStateRef.current === 'running-transition') return
    const next = mixer.setStemGains(gains)
    setTrackStemControl(current => ({ ...current, gains: next }))
  }, [])

  const setTrackVocalLevel = useCallback((gain: number) => {
    setTrackStemGains({ vocals: gain })
  }, [setTrackStemGains])

  const returnTrackStemsToOriginal = useCallback(() => {
    resetTrackStemMixer('idle')
  }, [resetTrackStemMixer])

  useEffect(() => {
    const handleStemCacheClearing = () => resetTrackStemMixer('idle')
    window.addEventListener('waveforge:track-stem-cache-clearing', handleStemCacheClearing)
    return () => window.removeEventListener('waveforge:track-stem-cache-clearing', handleStemCacheClearing)
  }, [resetTrackStemMixer])

  const cancelScheduledTransition = useCallback((reason = 'playback intent changed', preserveNext = true, announceCancellation = true) => {
    preparationRevisionRef.current += 1
    transitionExecutionRevisionRef.current += 1
    transitionStartingRef.current = false
    transitionStuckDeadlineRef.current = null
    gaplessPlanRef.current = null
    preparationAbortRef.current?.abort()
    preparationAbortRef.current = null
    autoMixPreparationKeyRef.current = null
    if (autoMixPrepareRetryTimerRef.current !== null) {
      window.clearTimeout(autoMixPrepareRetryTimerRef.current)
      autoMixPrepareRetryTimerRef.current = null
    }
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = null
    if (transitionDeckStartTimerRef.current !== null) window.clearTimeout(transitionDeckStartTimerRef.current)
    transitionDeckStartTimerRef.current = null
    if (visualSwitchTimerRef.current !== null) window.clearTimeout(visualSwitchTimerRef.current)
    visualSwitchTimerRef.current = null
    preloadReadyCleanupRef.current?.()
    preloadReadyCleanupRef.current = null
    if (externalHandoffFadeFrameRef.current !== null) {
      cancelAnimationFrame(externalHandoffFadeFrameRef.current)
      externalHandoffFadeFrameRef.current = null
    }
    seamlessJoinControllerRef.current?.reset()
    // albumGapless 的外部预载 deck / masterGain 也必须复位：它们不在 seamlessJoinController
    // 的管辖内，若混音中 seek，外部 deck 会继续从旧位置出声且输出增益停在混音中途值。
    gaplessIntegrationRef.current?.reset()
    transitionRendererRef.current?.stopPlayback()
    transitionBufferActiveRef.current = false
    if (fallbackAnimationRef.current !== null) cancelAnimationFrame(fallbackAnimationRef.current)
    fallbackAnimationRef.current = null
    if (transitionProgressAnimationRef.current !== null) cancelAnimationFrame(transitionProgressAnimationRef.current)
    transitionProgressAnimationRef.current = null
    transitionStartTimeRef.current = null
    if (retiredDeckCleanupTimerRef.current !== null) window.clearTimeout(retiredDeckCleanupTimerRef.current)
    retiredDeckCleanupTimerRef.current = null
    const active = getActiveAudio()
    const standby = getStandbyAudio()
    setDeckGain(getActiveGain(), active, 1)
    setDeckGain(getStandbyGain(), standby, 0)
    if (standby && !standby.paused) standby.pause()
    // 归位变速：AI 混音 overlap 期间 deck 可能以 playbackRate≠1 启动后被取消（seek/暂停），
    // 残留速率会在 standby 被后续 gapless 预载复用（sameTrackAlreadyAttached 路径不重置）时整曲变速
    if (standby && standby.playbackRate !== 1) {
      standby.playbackRate = 1
      if ('preservePitch' in standby) standby.preservePitch = true
    }
    transitionPlanRef.current = null
    if (!preserveNext) {
      const abandonedStream = nextMetadataRef.current?.appleHls
      const attachedStream = getActiveAppleStream(standby)
      if (standby) {
        detachAppleHls(standby)
        standby.removeAttribute('src')
        standby.load()
      }
      if (abandonedStream && attachedStream !== abandonedStream) releaseAppleNativeStream(abandonedStream)
      nextMetadataRef.current = null
    }
    if (announceCancellation && transitionStateRef.current !== 'idle' && transitionStateRef.current !== 'playing') {
      setTransitionState('cancelled', { transitioning: false, fallbackReason: reason, transitionStartTime: null })
      setTransitionState(active?.src ? 'playing' : 'idle', { transitioning: false, transitionStartTime: null })
    }
  }, [getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState])

  const runFallbackGainAnimation = useCallback((source: HTMLAudioElement, target: HTMLAudioElement, duration: number, onDone: () => void) => {
    const startedAt = performance.now()
    const animate = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / Math.max(1, duration * 1000))
      source.volume = Math.cos(progress * Math.PI / 2) * volumeRef.current
      target.volume = Math.sin(progress * Math.PI / 2) * volumeRef.current
      if (progress < 1) fallbackAnimationRef.current = requestAnimationFrame(animate)
      else {
        fallbackAnimationRef.current = null
        onDone()
      }
    }
    animate()
  }, [])

  const commitTransition = useCallback((strategy: TransitionStrategy, targetTime: number, executionRevision = transitionExecutionRevisionRef.current) => {
    debugLog('✅ [Transition] commitTransition 被调用')
    debugLog('   策略:', strategy)
    debugLog('   目标时间:', targetTime.toFixed(2), 's')
    debugLog('   执行版本:', executionRevision)
    debugLog('   当前过渡状态:', transitionStateRef.current)
    
    if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
      debugLog('⚠️ [Transition] 执行版本不匹配或状态已变更，跳过提交')
      // 落盘诊断：悬置状态（想提交但被守卫拦下）是「过渡后 UI 冻结」类问题的关键线索，
      // 记录被拦原因与版本号；若状态仍停在 running-transition，看门狗随后会自动收尾。
      logAutomixBackend(
        'transition:commit-guard',
        `skipped strategy=${strategy} revision=${executionRevision} currentRevision=${transitionExecutionRevisionRef.current} state=${transitionStateRef.current}`,
      )
      return
    }
    
    const source = getActiveAudio()
    const target = getStandbyAudio()
    const sourceMetadata = currentMetadataRef.current
    const targetMetadata = nextMetadataRef.current
    if (!target || !targetMetadata) {
      debugLog('❌ [Transition] 缺少目标音频或元数据，取消提交')
      return
    }

    debugLog('🔄 [Transition] 切换音频轨道...')
    resetTrackStemMixer('idle')
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = null
    if (transitionDeckStartTimerRef.current !== null) window.clearTimeout(transitionDeckStartTimerRef.current)
    transitionDeckStartTimerRef.current = null

    // 缓冲残留兜底：正常路径缓冲已自然 ended（事件驱动 handoff，stopPlayback 是空操作），
    // 但 timer 兜底 / ended 丢失时缓冲可能仍在出声——提交瞬间强制停掉，
    // 否则「过渡缓冲尾 + 新 deck」同时响 = 双重奏。
    transitionRendererRef.current?.stopPlayback()
    transitionBufferActiveRef.current = false

    // 清理过渡进度追踪动画
    if (transitionProgressAnimationRef.current !== null) {
      cancelAnimationFrame(transitionProgressAnimationRef.current)
      transitionProgressAnimationRef.current = null
    }
    transitionStartTimeRef.current = null
    transitionStuckDeadlineRef.current = null
    gaplessPlanRef.current = null
    
    // 在 gapless 模式下，source 已经在 startTransition 中被停止了
    // 避免再次调用 load()，这会导致音频上下文短暂中断造成卡顿
    if (strategy !== 'gapless') {
      source?.pause()
      if (source) {
        detachAppleHls(source)
        source.currentTime = 0
        source.removeAttribute('src')
        source.load()
      }
    } else {
      // Gapless 模式需要给解码器留出极短的尾帧时间，再释放已经退出的媒体管线。
      // 定时器使用 deck 身份和 URL 双重校验，避免误清理随后预载到该 deck 的下一首。
      if (source) {
        const retiredSource = source.currentSrc || source.src
        source.currentTime = 0
        if (retiredDeckCleanupTimerRef.current !== null) {
          window.clearTimeout(retiredDeckCleanupTimerRef.current)
        }
        retiredDeckCleanupTimerRef.current = window.setTimeout(() => {
          retiredDeckCleanupTimerRef.current = null
          const stillStandby = getStandbyAudio() === source
          const sourceUnchanged = (source.currentSrc || source.src) === retiredSource
          if (stillStandby && sourceUnchanged && source.paused) {
            detachAppleHls(source)
            source.removeAttribute('src')
            source.load()
          }
        }, 350)
      }
    }
    setDeckGain(getActiveGain(), source, 0)
    setDeckGain(getStandbyGain(), target, 1)
    activePrimaryRef.current = !activePrimaryRef.current
    currentMetadataRef.current = targetMetadata
    nextMetadataRef.current = null
    transitionPlanRef.current = null
    setAudioElement(target)
    debugLog('✅ [Transition] 过渡提交完成，现在播放下一首')
    debugLog('   新的当前歌曲:', targetMetadata.trackKey)
    
    // 构造 TransitionCommit 对象，触发 UI 更新
    const transitionCommit: TransitionCommit = {
      sourceTrackKey: sourceMetadata?.trackKey || '',
      targetTrackKey: targetMetadata.trackKey || '',
      targetIndex: targetMetadata.index,
      targetTime: targetTime,
      strategy: strategy,
      isVisualSwitch: false,
    }
    
    // 使用单次状态更新，避免多次渲染导致的卡顿
    setTransitionState('playing', {
      isPlaying: !target.paused,
      currentTime: target.currentTime,
      duration: target.duration || targetMetadata.duration || 0,
      ended: false,
      transitioning: false,
      transitionCommit: transitionCommit,
      transitionStrategy: strategy,
      transitionStartTime: null,
    })
    // 过渡收尾：恢复用户倍速（过渡开始时被归 1 让位 BPM 变速；此后无 'play' 事件，
    // 不在这里恢复的话用户倍速静默失效到下一次 play/换曲）
    if (userSpeedRef.current !== 1) {
      target.playbackRate = userSpeedRef.current
      setEffectivePlaybackSpeed(userSpeedRef.current)
    }
    // 消费"过渡期间被延后的设置变更"：提交已完成，此时重排新设置才安全
    //（当场重排会掐断过渡并把源曲增益弹回 1）。
    if (pendingReprepareRef.current) {
      pendingReprepareRef.current = false
      void prepareAutoMixRef.current()
    }
  }, [getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, resetTrackStemMixer, setDeckGain, setTransitionState])

  /**
   * 卡死看门狗收尾：过渡悬置超过截止时间仍在 running-transition 时调用。
   * 把 UI 与「实际在响的那条 deck」重新对齐——交接已发生时（待机 deck 在响）
   * 把它提升为正式当前曲并补发 transitionCommit；否则仅退出过渡态、恢复时间喂食。
   */
  const forceEndStuckTransition = useCallback((reason: string) => {
    if (transitionStateRef.current !== 'running-transition') return
    logAutomixBackend('transition:watchdog', `${reason} · strategy=${transitionStrategyRef.current} · 悬置超过截止时间，强制收尾对齐 UI`)
    // 看门狗收尾必须失效在途 handoff 续体：不递增 revision 的话，迟到的
    // startTargetAfterBuffer 仍会把目标 deck 拉满增益起播（提交被状态守卫丢弃 →
    // "听到下一首、界面停在上一首"）；不清 handoffPendingCount 会让源曲 ended 被永久忽略。
    transitionExecutionRevisionRef.current += 1
    handoffPendingCountRef.current = 0
    if (transitionProgressAnimationRef.current !== null) {
      cancelAnimationFrame(transitionProgressAnimationRef.current)
      transitionProgressAnimationRef.current = null
    }
    if (transitionTimerRef.current !== null) { window.clearTimeout(transitionTimerRef.current); transitionTimerRef.current = null }
    if (transitionDeckStartTimerRef.current !== null) { window.clearTimeout(transitionDeckStartTimerRef.current); transitionDeckStartTimerRef.current = null }
    transitionRendererRef.current?.stopPlayback()
    transitionBufferActiveRef.current = false
    transitionStartTimeRef.current = null
    transitionStuckDeadlineRef.current = null
    gaplessPlanRef.current = null
    try { transitionVisualStore.end(false) } catch { /* 视觉轨道收尾失败不阻塞恢复 */ }

    const primary = primaryRef.current
    const secondary = secondaryRef.current
    const audible = primary && !primary.paused && (primary.currentSrc || primary.src)
      ? primary
      : (secondary && !secondary.paused && (secondary.currentSrc || secondary.src) ? secondary : null)
    const previousMetadata = currentMetadataRef.current
    const pendingNext = nextMetadataRef.current
    const handoverHappened = Boolean(audible && pendingNext && audible === getStandbyAudio())
    if (handoverHappened && audible && pendingNext) {
      // 交接已发生（待机 deck 正在响）但提交被拦：提升为正式当前曲，UI 与声音对齐
      setDeckGain(getActiveGain(), getActiveAudio(), 0)
      setDeckGain(getStandbyGain(), audible, 1)
      activePrimaryRef.current = !activePrimaryRef.current
      currentMetadataRef.current = pendingNext
      nextMetadataRef.current = null
      setAudioElement(audible)
    }
    // 无论交接是否发生都补发 transitionCommit：App 侧据此清理过渡视觉轨道/进度/暗态，
    // 否则 overlayProgress 残留会让歌词继续停在过渡的暗态时钟上（这正是「冻结」的外观）。
    const commitTarget = handoverHappened && pendingNext ? pendingNext : previousMetadata
    const commit: TransitionCommit = {
      sourceTrackKey: previousMetadata?.trackKey || '',
      targetTrackKey: commitTarget?.trackKey || previousMetadata?.trackKey || '',
      targetIndex: commitTarget?.index,
      targetTime: audible?.currentTime || 0,
      strategy: transitionStrategyRef.current,
      isVisualSwitch: false,
    }
    setTransitionState('playing', {
      isPlaying: Boolean(audible && !audible.paused),
      currentTime: audible?.currentTime || 0,
      duration: finiteDuration(audible?.duration) || previousMetadata?.duration || 0,
      ended: false,
      transitioning: false,
      transitionStartTime: null,
      transitionCommit: commit,
    })
  }, [finiteDuration, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setAudioElement, setDeckGain, setTransitionState, transitionVisualStore])

  // 看门狗轮询：running-transition 悬置超过截止时间（过渡时长 + 余量）即强制收尾。
  // 轮询 2s 一次、只在过渡态下做一次时间比较，开销可忽略。
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (transitionStateRef.current !== 'running-transition') return
      const deadline = transitionStuckDeadlineRef.current
      if (deadline === null || performance.now() < deadline) return
      forceEndStuckTransition('stuck running-transition')
    }, 2000)
    return () => window.clearInterval(interval)
  }, [forceEndStuckTransition])

  const startTransition = useCallback(async (strategy: TransitionStrategy, plan?: TransitionPlan) => {
    debugLog('🚀 [Transition] startTransition 被调用')
    debugLog('   策略:', strategy)
    debugLog('   计划:', plan)
    debugLog('   当前过渡状态:', transitionStateRef.current)
    
    if (transitionStateRef.current === 'running-transition' || transitionStartingRef.current) {
      debugLog('⚠️ [Transition] 已经在进行过渡中，跳过')
      return
    }
    if (watchHoldRef.current) {
      // 看歌挂起：即使已武装的定时器漏网，过渡启动也被拦下（提交=切歌，看歌期间禁止）
      debugLog('⏸ [Transition] 看歌挂起：忽略 startTransition')
      return
    }
    const source = getActiveAudio()
    const target = getStandbyAudio()
    const targetMetadata = nextMetadataRef.current
    
    debugLog('🔍 [Transition] 检查音频元素:')
    debugLog('   source:', source ? '存在' : '不存在')
    debugLog('   target:', target ? '存在' : '不存在')
    debugLog('   target.src:', target?.src || '无')
    debugLog('   targetMetadata:', targetMetadata ? '存在' : '不存在')
    
    if (!source || !target || !target.src || !targetMetadata) {
      debugLog('❌ [Transition] 缺少必要的音频元素或元数据，取消过渡')
      return
    }

    // 音频过渡时长（gapless 为 0，即音频立即切换）
    const targetAudioEnd = Math.max(0, (target.duration || targetMetadata.duration || 0) - 0.1)
    let audioDuration = strategy === 'gapless' ? 0 : Math.max(0.25,
      plan ? plan.sourceEndTime - plan.sourceStartTime :
      strategy === 'fixed-crossfade' ? crossfadeRef.current.duration :
      4) // 默认 4 秒作为 fallback
    
    // 视觉过渡时长（gapless 模式下仍需要视觉动画）
    // 0.4s 快到肉眼看不见（用户反馈「无缝过渡没有转场动画」）；0.8s 让进度条流光/渐变
    // 能被感知，同时 UI 切到下一首的延迟仍 <1s，不破坏「无缝」的体感。
    let visualDuration = strategy === 'gapless' ? 0.8 : audioDuration
    
    // 目标起播位置：有 plan 用 plan 的（automix/gapless 智能计划已含 introSkip）；
    // 无 plan 的 gapless（备选 60ms 淡入淡出：超时回退/竞态兜底等）——直接查下一首的
    // introSilence，跳过烧死的前奏静音（与首选拼接的 joinOffset 同口径），否则备选
    // 路径从绝对 0 起播，接缝照放空白（审查 D 项）。
    const gaplessFallbackIntroSkip = strategy === 'gapless' && !plan
      ? (() => {
          const silence = autoMixAnalysisService.peekSilenceBounds(nextMetadataRef.current?.trackKey || '')
          return silence ? Math.max(0, Math.min(2, silence.introSilence || 0)) : 0
        })()
      : 0
    let targetTime = Math.max(0, Math.min(plan?.targetStartTime || gaplessFallbackIntroSkip, targetAudioEnd))

    debugLog('⏱️ [Transition] 过渡参数:')
    debugLog('   音频过渡时长:', audioDuration.toFixed(2), 's')
    debugLog('   视觉过渡时长:', visualDuration.toFixed(2), 's')
    debugLog('   目标开始时间:', targetTime.toFixed(2), 's')

    const executionRevision = ++transitionExecutionRevisionRef.current
    const targetSourceAtStart = target.currentSrc || target.src
    transitionStartingRef.current = true
    transitionStrategyRef.current = strategy
    // 看门狗截止：过渡时长 + 8s 余量（下限 15s）；渲染缓冲路径会在进入分支后按真实缓冲时长刷新
    transitionStuckDeadlineRef.current = performance.now() + Math.max(15_000, (Math.max(audioDuration, visualDuration, 2) + 8) * 1000)
    const isExecutionCurrent = () => executionRevision === transitionExecutionRevisionRef.current
      && getActiveAudio() === source
      && getStandbyAudio() === target
      && nextMetadataRef.current?.trackKey === targetMetadata.trackKey
    try {
      debugLog('🎨 [Transition] 确保音频图已初始化...')
      await ensureAudioGraph()
      if (!isExecutionCurrent()) return
      
      // Check if we have a smart-rendered transition ready
      if ((strategy === 'smart-rendered' || strategy === 'smart-rendered-v2' || strategy === 'smart-rendered-qq') && plan && transitionRendererRef.current) {
        debugLog('🎨 [Transition] 检查智能渲染的过渡音频...')
          // ensureRendered：内存缓存 → 磁盘产物 rehydrate → null。原实现只看内存缓存，
          // TTL 过期/被逐出后直接降级为固定交叉淡化（目标续播点退回 targetStartTime，
          // lite 档听感是"过渡完成又回到第二首开头"），磁盘上其实还有可复用的 WAV。
          const rendered = await transitionRendererRef.current.ensureRendered(plan.id)
          if (!isExecutionCurrent()) return
          if (!rendered) {
            console.warn('[AutoMix] 智能过渡音频不可用（内存与磁盘产物均未命中），本次降级为交叉淡化')
            logAutomixBackend('render:buffer-unavailable', `${plan.id} strategy=${strategy}`)
          }
          if (rendered) {
          debugLog('✅ [Transition] 找到预渲染的过渡音频，开始播放')
          
          // Get the transition duration from the rendered buffer
          const playbackOffset = Math.max(0, Math.min(
            Math.max(0, (source.currentTime || 0) - plan.sourceStartTime),
            Math.max(0, rendered.duration - 0.05),
          ))
          const transitionAudioDuration = Math.max(0.05, rendered.duration - playbackOffset)
          debugLog('   过渡音频时长:', transitionAudioDuration.toFixed(2), 's')
          // 渲染缓冲可能远长于计划窗口（AI 长混音等）：看门狗截止按真实缓冲时长刷新
          transitionStuckDeadlineRef.current = performance.now() + Math.max(15_000, (transitionAudioDuration + 8) * 1000)
          
          // Start transition progress tracking
          const transitionStartTime = performance.now()
          transitionStartTimeRef.current = transitionStartTime
          
          // Set transition state with progress tracking
          setTransitionState('running-transition', {
            transitioning: true,
            seamlessTransition: true,
            transitionStrategy: strategy,
            fallbackReason: plan?.fallbackReason,
            transitionProgress: 0,
            transitionDuration: transitionAudioDuration,
            transitionFromTrackKey: currentMetadataRef.current?.trackKey || '',
            transitionToTrackKey: targetMetadata.trackKey || '',
          })
          
          // Start progress animation for visual feedback
          let visualSwitchSent = false
          const updateTransitionProgress = () => {
            if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
              return
            }
            
            const elapsed = (performance.now() - transitionStartTime) / 1000
            const progress = Math.min(elapsed / transitionAudioDuration, 1)
            // 合成当前时间：过渡缓冲驱动时间线（AI 长混音超过源曲自然结尾时 timeupdate 会停）。
            // 起点必须加 playbackOffset（seek/快进触发时缓冲从中间开始），否则进度条会回跳到
            // AI 窗口起点 → 动画窗口判定（currentTime >= transitionStartTime）被推后几十秒 → 过渡动画消失。
            // 上限 = max(源曲时长, 过渡真实结束时间)：AI 过渡从源曲深处起步会超过源曲末尾，
            // 此时进度条时间应自适应上探到过渡结束点，而不是顶着源曲时长不动。
            const syntheticCap = Math.max(
              source?.duration || 0,
              (plan?.sourceStartTime || 0) + transitionAudioDuration,
            )
            const syntheticTime = Math.min(
              (plan?.sourceStartTime || 0) + playbackOffset + progress * transitionAudioDuration,
              syntheticCap,
            )
            // 这条 rAF 循环是 30fps 节流，直接发未量化的合成时间会让订阅 playbackTimeStore 的
            // 大组件（歌词页 / 播放控制条）跟着 30fps 重渲染，而 AI 长混音过渡可持续 8–60s。
            // 与 handleTimeUpdate 的稳态路径一致量化到 ~250ms；进度条与歌词各自有插值，视觉无变化。
            const publishTime = Math.round(syntheticTime * 4) / 4

            const targetSpan = Math.max(0, (plan?.targetEndTime || 0) - (plan?.targetStartTime || 0))
            const transitionTargetTime = (plan?.targetStartTime || 0) + progress * targetSpan
            // 视觉轨道：切换后 UI 时间线直接用目标曲时间轴。缓冲结束（progress=1）时它恰好
            // 等于目标 deck 的续播点 targetEndTime，所以真正提交时时间线连续、进度条与歌词都不跳。
            const visualSwitchedNow = transitionVisualStore.getSnapshot().switched
            const uiTime = visualSwitchedNow ? transitionTargetTime : publishTime
            const targetDurationForUi = finiteDuration(target.duration) || (targetMetadata.duration || 0)
            
            // When progress reaches 90%, send visualSwitchCommit to update UI early
            // This prevents visual glitch when commitTransition is called
            if (!visualSwitchSent && progress >= 0.9) {
              visualSwitchSent = true
              // 视觉轨道切换到目标曲：此后歌名/封面/歌词/MV/时间线都属于目标曲，
              // 真正提交时画面无需再改任何东西（消除"过渡完毕整屏刷新"的观感）。
              transitionVisualStore.markSwitched()
              // 目标曲视觉进度 = 其在缓冲内的实时位置（90% 处 ≈ 目标曲窗口的 90%），
              // 缓冲结束（100%）自然落到 targetEndTime，与真实恢复点一致，避免 0→100% 跳变。
              const visualTargetTime = transitionTargetTime
              const visualCommit: TransitionCommit = {
                sourceTrackKey: currentMetadataRef.current?.trackKey || '',
                targetTrackKey: targetMetadata.trackKey || '',
                targetIndex: targetMetadata.index,
                targetTime: visualTargetTime,
                strategy: strategy,
                isVisualSwitch: true, // Mark this as visual-only update
              }
              debugLog('🎨 [Transition] 视觉轨道切换 (进度 90%) →', targetMetadata.trackKey, '@', visualTargetTime.toFixed(2), 's')
              emit({
                transitionProgress: progress,
                transitionDuration: transitionAudioDuration,
                transitionTargetTime,
                visualSwitchCommit: visualCommit,
                currentTime: visualTargetTime,
                ...(targetDurationForUi > 0 ? { duration: targetDurationForUi } : {}),
              })
              // 一次性关键事件不节流，但刷新节流基准避免紧随其后的普通帧重复发
              transitionProgressEmitTimeRef.current = performance.now()
            } else {
              const now = performance.now()
              // 30fps 节流：距上次 emit ≥30ms 才 emit；progress 到达 1 强制发最终值
              if (progress >= 1 || now - transitionProgressEmitTimeRef.current >= 30) {
                emit({
                  transitionProgress: progress,
                  transitionDuration: transitionAudioDuration,
                  transitionTargetTime,
                  currentTime: uiTime,
                  ...(visualSwitchedNow && targetDurationForUi > 0 ? { duration: targetDurationForUi } : {}),
                })
                transitionProgressEmitTimeRef.current = now
              }
            }
            
            if (progress < 1) {
              transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)
            }
          }
          
          transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)
          
          // Play the pre-rendered transition buffer
          // 事件驱动 handoff：缓冲 ended 时精确启动 target，替代 50ms 固定补偿
          // （消除 timer 早到双播 / 晚到静音缝隙）。
          // AI 长混音（plan.overlapSeconds>0）：缓冲尾段渐出 + deck 提前淡入，
          // 掩蔽混音尾段（source BPM）与真实 deck（target 原速）之间的速度台阶。
          let handoff: (() => void) | null = null
          const result = await transitionRendererRef.current.playTransition(
            plan.id,
            source?.currentTime || 0,
            () => { if (handoff) void handoff() },
            { overlap: plan.overlapSeconds, handoffFadeSeconds: RENDERED_HANDOFF_FADE_SECONDS },
          )
          // playTransition 内部 rehydrate（磁盘读取 + decodeAudioData）可耗时数秒；
          // 期间用户 seek/暂停/切歌会让本执行失效（cancelScheduledTransition 已 stop
          // 届时的 activeSource，但取消发生在 source.start 之前时缓冲随后仍会起播）。
          // 返回后必须立即复查：失效则停掉刚起的缓冲并恢复源曲增益，否则
          // ① 过渡音频满音量叠上用户已 seek 的源曲；② 源曲被下方静音且 handoff
          // 因 revision 校验不再提交 → 源曲静音卡死直到缓冲自然播完。
          if (!isExecutionCurrent()) {
            transitionRendererRef.current?.stopPlayback()
            if (source) setDeckGain(getActiveGain(), source, 1)
            debugLog('⏹️ [Transition] 缓冲启动后执行已失效（seek/暂停竞态），已停止缓冲并恢复源曲增益')
            return
          }
          if (result) {
            if (result.tooLate) {
              // 迟到保护（seek 越过切点）：缓冲未启动，source 仍在播放 → 回退标准交叉淡化。
              // 目标曲不回到 targetStartTime（lite 为 0 = "过渡完回到第二首开头"），
              // 而是接上混音本应到达的位置；交叉时长压缩到剩余源曲与 4s 的较小值，
              // 避免源曲先播完出现静音段。
              console.warn('⚠️ [Transition] 过渡触发过晚（seek 越过切点），回退交叉淡化')
              strategy = 'fixed-crossfade'
              plan.strategy = 'fixed-crossfade'
              plan.fallbackReason = 'Transition triggered too late; using fixed crossfade'
              const skipped = Math.max(0, playbackOffset)
              const targetSpan = Math.max(0.5, (plan.targetEndTime || 0) - (plan.targetStartTime || 0))
              plan.targetStartTime = Math.min(
                (plan.targetStartTime || 0) + skipped,
                Math.max(0, (plan.targetEndTime || 0) - 0.5),
              )
              const remainingSource = Math.max(0.5, (plan.sourceEndTime || 0) - (source.currentTime || 0))
              plan.sourceStartTime = Math.max(0, (plan.sourceEndTime || 0) - Math.min(4, remainingSource))
              audioDuration = Math.max(0.25, plan.sourceEndTime - plan.sourceStartTime)
              visualDuration = audioDuration
              targetTime = Math.max(0, Math.min(plan.targetStartTime, targetAudioEnd))
              debugLog('   目标续播位置:', targetTime.toFixed(2), 's，交叉时长:', audioDuration.toFixed(2), 's')
            } else {
              debugLog('✅ [Transition] 智能渲染过渡缓冲已启动')
              debugLog('   目标恢复时间:', result.targetResumeTime.toFixed(2), 's')
              debugLog('   过渡剩余时长:', result.remainingDuration.toFixed(2), 's')

              // 过渡缓冲内含源曲结尾：把 source deck 立即静音但**保持播放**——
              // 音频元素 currentTime 继续推进，timeupdate 持续触发，歌词/MV/进度条
              // 时间线存活（AI 60s 长混音期间 UI 不会冻结）。
              // 必须立即归零而不是长渐出：缓冲的源曲侧内容与 deck 当前播放的是同一段
              // 音乐，位置差 ≤0.3s（timeupdate 粒度），两路同播会产生梳状滤波相位污染
              // ——实测为"介入瞬间奇怪的噪音/音质破损"（automix-lab 无此问题，因为
              // 它没有 deck 同播层）。平滑感由缓冲自身的 400ms 渐入保证，无硬切。
              if (source) {
                const activeGain = getActiveGain()
                const ctx = audioContextRef.current
                if (activeGain && ctx) {
                  const now = ctx.currentTime
                  activeGain.gain.cancelScheduledValues(now)
                  activeGain.gain.setValueAtTime(Math.max(activeGain.gain.value, 0.0001), now)
                  activeGain.gain.linearRampToValueAtTime(0.0001, now + 0.06)
                } else {
                  setDeckGain(getActiveGain(), source, 0)
                }
                debugLog('⏸️ [Transition] 源曲 deck 立即静音（保持播放以驱动 UI 时间线）')
              }
              transitionBufferActiveRef.current = true

              const overlap = typeof result.overlap === 'number' && result.overlap > 0.05 ? result.overlap : 0

              // 预载 target 的 resume 区域：提前把 standby deck 定位到恢复点附近，
              // 触发浏览器 Range 缓冲请求（流媒体）。handoff 时 seek+play 落在已缓冲
              // 区域内，不再有「seek 到未缓冲位置 → 等待 → 静音断开」的空窗。
              // （v1 交叉过渡不断开正是因为它无 seek；这里把智能过渡的 seek 也变成零等待。
              // 预载位置 = resume - max(0.5, overlap) × 混音尾速度比（AI 路径 deck 提前启动位置）。）
              const preSeekRatio = typeof result.mixSpeedRatio === 'number' && result.mixSpeedRatio > 0
                ? result.mixSpeedRatio
                : 1
              if (target && result.targetResumeTime > 5) {
                try {
                  // 预载位置 = deck 提前起播的位置（无 overlap 时也要留出 HANDOFF_LEAD），
                  // 保证 handoff 时刻只是"按播放键"，落点已在已缓冲区域。
                  const deckLead = overlap > 0 ? overlap : RENDERED_HANDOFF_LEAD_SECONDS
                  const preSeek = Math.max(0, result.targetResumeTime - deckLead * preSeekRatio)
                  if (Math.abs((target.currentTime || 0) - preSeek) > 0.05) target.currentTime = preSeek
                } catch (err) {
                  debugLog('⚠️ [Transition] resume 区域预载 seek 失败:', err)
                }
              }
              let handedOff = false
              let deckStarted = false
              // 提前启动在途标记：deckStarted 必须在 play() 成功后才置位——
              // 否则 handoff 会以"deck 已在播"的名义提交一个仍在 paused 的 deck
              // （commitTransition 不调用 play()）→ 永久静音但状态是"播放中"。
              let deckStartInFlight = false
              // 起播结算通知器：handoff 等待 deck 提前起播的结果时挂起在该 Promise 上，
              // 起播路径 settle（成功/失败）时 resolve——替代旧的 15ms 忙等轮询（最多 30 个定时器续体）。
              let notifyDeckStartSettled: (() => void) | null = null
              const deckStartSettled = new Promise<void>(resolve => { notifyDeckStartSettled = resolve })
              // 提前起播的提前量/交叉窗口：overlap 路径沿用混音尾速度同步窗口，
              // 无 overlap（QQ Enhanced 等）走固定 0.6s 提前 + 0.35s 交叉窗口。
              const deckStartLead = overlap > 0 ? overlap : RENDERED_HANDOFF_LEAD_SECONDS
              const handoffFadeSeconds = typeof result.handoffFadeSeconds === 'number' && result.handoffFadeSeconds > 0.05
                ? result.handoffFadeSeconds
                : RENDERED_HANDOFF_FADE_SECONDS

              // 提前启动 target deck（缓冲结束前 deckStartLead 秒）。
              // overlap 路径：混音尾 = target 内容以 source BPM 播放，deck 起始内容位置
              // = resume - overlap × 混音尾速度比，与混音尾**同位置同速**（不重唱/不跳词）。
              // 无 overlap 路径：缓冲尾已是 target 内容，deck 位置 = resume - lead；
              // 增益渐入锚在 AudioContext 时钟的缓冲结束点上（与缓冲尾渐出同一条时间线），
              // 不再依赖 play() 返回时机 —— 这是"过渡播完像跳过去 / 差一瞬没接上"的根因。
              const startDeckEarly = () => {
                if (deckStarted || handedOff || deckStartInFlight) return
                deckStartInFlight = true
                debugLog(`🎼 [Transition] handoff：deck 提前 ${deckStartLead.toFixed(2)}s 起播（缓冲尾 ${handoffFadeSeconds.toFixed(2)}s 渐出交叉）`)
                void (async () => {
                  try {
                    // 过渡已被取消/替换（如 seek/切歌）时不启动
                    if (executionRevision !== transitionExecutionRevisionRef.current) return
                    const speedRatio = typeof result.mixSpeedRatio === 'number' && result.mixSpeedRatio > 0
                      && Math.abs(result.mixSpeedRatio - 1) > 0.005
                      ? result.mixSpeedRatio
                      : 1
                    const deckStart = Math.max(0, result.targetResumeTime - deckStartLead * speedRatio)
                    if (Math.abs((target.currentTime || 0) - deckStart) > 0.05) {
                      target.currentTime = deckStart
                      await waitForSeek(target, 400)
                      // 等待 deck 在 deckStart 位置具备可播数据（预载 seek 后仍可能未缓冲完）
                      await waitForPlayable(target, 3000)
                    }
                    if (handedOff || executionRevision !== transitionExecutionRevisionRef.current) return
                    const standbyGain = getStandbyGain()
                    setDeckGain(standbyGain, target, 0)
                    if (speedRatio !== 1 && 'preservePitch' in target) target.preservePitch = true
                    target.playbackRate = speedRatio
                    await target.play()
                    // play() 成功后才算"已开始播放"：handoff 据此提交
                    deckStarted = true
                    deckStartInFlight = false
                    notifyDeckStartSettled?.()
                    const ctx = audioContextRef.current
                    const bufferEndCtx = typeof result.bufferEndCtxTime === 'number' ? result.bufferEndCtxTime : null
                    if (standbyGain && ctx && bufferEndCtx !== null) {
                      // 与缓冲尾渐出共用 AudioContext 时钟：deck 静音等到交叉窗口起点，
                      // 再线性升到满增益，正好在缓冲结束那一刻接管（无静音缝、无电平台阶）。
                      const now = ctx.currentTime
                      const fadeStart = Math.max(now, bufferEndCtx - handoffFadeSeconds)
                      standbyGain.gain.cancelScheduledValues(now)
                      standbyGain.gain.setValueAtTime(0, now)
                      if (fadeStart > now) standbyGain.gain.setValueAtTime(0, fadeStart)
                      standbyGain.gain.linearRampToValueAtTime(1, Math.max(fadeStart + 0.05, bufferEndCtx))
                    } else if (standbyGain && ctx) {
                      const now = ctx.currentTime
                      standbyGain.gain.cancelScheduledValues(now)
                      standbyGain.gain.setValueAtTime(0, now)
                      standbyGain.gain.linearRampToValueAtTime(1, now + handoffFadeSeconds)
                    } else if (target) {
                      target.volume = 1
                    }
                    // playbackRate post-settle（消除双重奏 + 满足减速时机）：
                    // deck 先以混音尾速度（ratio）同速播放 ~4s——与缓冲尾内容完全同步，
                    // 重叠期不产生"两层"错位；随后 4s 内平滑减速到 1.0（此时缓冲已渐出
                    // 1/3 以上，速度差被渐出掩盖，不可闻）；最后 ~7s 保持原速与 deck 直接衔接。
                    // 用户要求"15-8 秒开始平滑减速、8 秒后衔接"——4s 同速 + 4s 减速 + 7s 原速。
                    if (speedRatio !== 1) {
                      const settleStart = performance.now()
                      const syncHoldMs = Math.max(500, overlap * 1000 * (4 / 15))
                      const decelMs = Math.max(500, overlap * 1000 * (4 / 15))
                      const rampPlaybackRate = () => {
                        if (handedOff || executionRevision !== transitionExecutionRevisionRef.current) return
                        const t = performance.now() - settleStart
                        if (t < syncHoldMs) {
                          target.playbackRate = speedRatio
                          requestAnimationFrame(rampPlaybackRate)
                          return
                        }
                        const p = Math.min(1, (t - syncHoldMs) / decelMs)
                        target.playbackRate = speedRatio + (1 - speedRatio) * p
                        if (p < 1) requestAnimationFrame(rampPlaybackRate)
                      }
                      requestAnimationFrame(rampPlaybackRate)
                      debugLog(`🎛️ [Transition] deck playbackRate ${speedRatio.toFixed(3)}（先同速 ${(syncHoldMs / 1000).toFixed(1)}s 再平滑减速 ${(decelMs / 1000).toFixed(1)}s → 1.0，避免重叠期双重奏）`)
                    }
                    debugLog('   目标轨道提前播放，位置:', target.currentTime.toFixed(2), 's')
                  } catch (err) {
                    // 提前启动失败：若 deck 尚未真正出声（play 未成功），标记清除让 handoff
                    // 走原 seek+play 路径；若 play 已成功（仅后续 gain 调度抛错），保持
                    // deckStarted=true，避免 handoff 再次启动造成双播（双重奏）。
                    const alreadyPlaying = target && !target.paused
                    if (!alreadyPlaying) deckStarted = false
                    deckStartInFlight = false
                    notifyDeckStartSettled?.()
                    target.playbackRate = 1
                    console.error('❌ [Transition] overlap 提前启动目标失败:', err, alreadyPlaying ? '（deck 已在播放，保留接管）' : '')
                  }
                })()
              }

              // 兜底起见：先行声明（在 handoff 内部赋值），保证解构处的类型收窄生效
              let startTargetAfterBuffer: (() => Promise<void>) | null = null

              handoff = () => {
                if (handedOff) return
                handedOff = true
                // 缓冲活跃标记保持到真正提交/失败：异步续体（waitForSeek/waitForPlayable）期间
                // 源曲 ended 必须继续被忽略，否则 App 会按"自然播完"整曲重载下一首，与随后的
                // target.play() 打架（碎片重播/跳曲）。
                handoffPendingCountRef.current += 1
                const releaseHandoff = () => {
                  handoffPendingCountRef.current = Math.max(0, handoffPendingCountRef.current - 1)
                }
                if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
                transitionTimerRef.current = null
                if (transitionDeckStartTimerRef.current !== null) window.clearTimeout(transitionDeckStartTimerRef.current)
                transitionDeckStartTimerRef.current = null
                // 过渡已被取消/替换（如 seek/切歌）时不再启动 target。
                // 过期续体只回收自己的计数，绝不动"新过渡"的 bufferActive/状态。
                if (executionRevision !== transitionExecutionRevisionRef.current) {
                  releaseHandoff()
                  return
                }
                // deck 已提前起播（任何路径：overlap 或固定 0.6s 提前）：缓冲结束即满增益提交。
                // 这是唯一"无静音缝"的交接路径：deck 在缓冲尾渐出窗口内已经出声，
                // 这里只把增益钉到 1 并提交，不做 seek / play（旧实现在此 seek+play，
                // 一路静音到 play() 成功 —— 用户听感"过渡播完像跳过去"）。
                const commitLiveDeck = () => {
                  debugLog('✅ [Transition] 过渡缓冲结束（deck 已提前起播），提交目标轨道')
                  target.playbackRate = 1 // post-settle 渐变兜底：确保原速交接
                  setDeckGain(getStandbyGain(), target, 1)
                  releaseHandoff()
                  commitTransition(strategy, result.targetResumeTime, executionRevision)
                }
                if (deckStarted && !target.paused) {
                  commitLiveDeck()
                  return
                }
                // 目标轨道启动续体（原实现被误放在函数末尾 return 之后成为死代码，
                // 导致两处 startTargetAfterBuffer?.() 调用空转——过渡后目标轨道无法起播）
                startTargetAfterBuffer = async () => {
                  // 闭包内显式绑定（外层的类型收窄不跨函数边界）：缺 deck/结果时只回收计数
                  const targetDeck = target
                  const transitionResult = result
                  if (!targetDeck || !transitionResult) {
                    handoffPendingCountRef.current = Math.max(0, handoffPendingCountRef.current - 1)
                    return
                  }
                  try {
                    // 先定位再等 seek 完成，避免在未缓冲位置 play() 造成空隙
                    targetDeck.currentTime = transitionResult.targetResumeTime
                    await waitForSeek(targetDeck, 400)
                    // 等待当前位置数据就绪（AI 混音恢复点在目标曲深处，可能超出预缓冲）；
                    // 数据就绪前不 play，从根源消除"seek 到未缓冲位置 → 静音断开"的空窗。
                    // 快路径：预载已把该位置缓冲好（readyState ≥ HAVE_FUTURE_DATA）时直接起播——
                    // 每次多余 await 都会把交接推后几十毫秒，是"过渡后偶尔差那么一瞬没接上"的来源之一。
                    if (targetDeck.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
                      await waitForPlayable(targetDeck, 3000)
                    }
                    // await 间隙内可能已被取消（暂停/seek/切歌/预载重跑）：不能把 targetDeck 拉满
                    // 增益起播，否则表现为"暂停中放下一首 / seek 后双 deck 齐奏"且无人纠正。
                    if (!isExecutionCurrent()) {
                      debugLog('⏭️ [Transition] handoff 续体在等待期间已失效，放弃启动目标轨道')
                      handoffPendingCountRef.current = Math.max(0, handoffPendingCountRef.current - 1)
                      if (!targetDeck.paused) targetDeck.pause()
                      setDeckGain(getStandbyGain(), targetDeck, 0)
                      return
                    }
                    setDeckGain(getStandbyGain(), targetDeck, 1) // 缓冲已结束，targetDeck 满增益
                    await targetDeck.play()
                    if (!isExecutionCurrent()) {
                      // play() 期间被取消：收回已起播的 deck，避免无人纠正的满增益播放
                      debugLog('⏭️ [Transition] play() 期间过渡被取消，收回目标轨道')
                      if (!targetDeck.paused) targetDeck.pause()
                      setDeckGain(getStandbyGain(), targetDeck, 0)
                      return
                    }
                    targetDeck.playbackRate = 1 // 兜底：确保下一曲以原速播放（post-settle 残留防护）
                    debugLog('   目标轨道开始播放，位置:', targetDeck.currentTime.toFixed(2), 's')
                  } catch (err) {
                    console.error('❌ [Transition] 目标轨道启动失败:', err)
                    // 只在"仍然拥有当前过渡"时改写状态，避免过期续体覆盖新过渡
                    if (isExecutionCurrent()) {
                      transitionBufferActiveRef.current = false
                      const src = getActiveAudio()
                      if (src?.ended) {
                        // 源曲已播完且无缓冲接管：交还给 App 的"自然结束"推进路径
                        setTransitionState('idle', { isPlaying: false, ended: true, seamlessTransition: false, transitioning: false })
                      } else {
                        // 交还源曲并把增益恢复，避免停在"静音但状态异常"
                        if (src && !src.paused) setDeckGain(getActiveGain(), src, 1)
                        setTransitionState('failed', {
                          isPlaying: Boolean(src && !src.paused),
                          ended: false,
                          transitioning: false,
                          transitionStrategy: strategy,
                          fallbackReason: err instanceof Error ? err.message : 'target deck failed to start',
                        })
                      }
                    }
                    return
                  } finally {
                    handoffPendingCountRef.current = Math.max(0, handoffPendingCountRef.current - 1)
                  }
                  commitTransition(strategy, transitionResult.targetResumeTime, executionRevision)
                }
                if (deckStartInFlight) {
                  // 提前起播仍在途（seek/缓冲慢）：等它结算（正常 <100ms），不要抢同一个 deck
                  // 各起播一次（会双重奏/互相 seek）。450ms 超时后仍退回 seek+play 兜底路径。
                  // 等待用一次性 resolver（起播路径 settle 时 notify），不再 15ms 轮询。
                  void (async () => {
                    const timeout = window.setTimeout(() => notifyDeckStartSettled?.(), 450)
                    await deckStartSettled
                    window.clearTimeout(timeout)
                    if (executionRevision !== transitionExecutionRevisionRef.current) {
                      releaseHandoff()
                      return
                    }
                    if (deckStarted && !target.paused) {
                      commitLiveDeck()
                      return
                    }
                    await startTargetAfterBuffer?.()
                  })()
                  return
                }
                debugLog('✅ [Transition] 过渡缓冲结束（ended 驱动），启动目标轨道')
                void startTargetAfterBuffer?.()
                return
              }
              // deck 提前起播 timer：任何渲染过渡路径都要提前起播（overlap 用 overlap 秒，
              // 无 overlap 用固定 0.6s）——否则缓冲结束后才 seek+play，中间是纯静音。
              transitionDeckStartTimerRef.current = window.setTimeout(() => {
                if (!handedOff) startDeckEarly()
              }, Math.max(0, result.remainingDuration - deckStartLead) * 1000)
              // 兜底 timer（300ms 余量）：ended 事件丢失或播放前就已结束时仍能交接
              transitionTimerRef.current = window.setTimeout(() => {
                if (handoff) void handoff()
              }, Math.max(0, result.remainingDuration * 1000) + 300)

              return
            }
          } else {
            // Fall through to regular crossfade if rendering not available
            console.warn('⚠️ [Transition] 智能渲染音频未准备好，回退到普通交叉淡化')
            strategy = 'fixed-crossfade'
            plan.strategy = 'fixed-crossfade'
            plan.fallbackReason = 'Rendered transition was not ready at playback time'
          }
        }
        // 到这里说明智能渲染不可用/过晚/缓冲丢失 → 走标准交叉淡化
        // 上面在 playTransition 之前已启动过一条进度 rAF；它的闭包持有旧的
        // transitionStartTime / transitionAudioDuration。若不取消，下方标准交叉淡化会再启动
        // 第二条 rAF，两者同时以不同分母 emit transitionProgress → 进度抖动 + 双倍 setState。
        if (transitionProgressAnimationRef.current !== null) {
          cancelAnimationFrame(transitionProgressAnimationRef.current)
          transitionProgressAnimationRef.current = null
        }
        console.warn('⚠️ [Transition] 智能渲染不可用或缓冲未就绪，回退交叉淡化')
        strategy = 'fixed-crossfade'
        plan.strategy = 'fixed-crossfade'
        plan.fallbackReason = plan.fallbackReason || 'Rendered transition was not ready at playback time'
      }

      // 降级到固定交叉淡化时，过渡时长必须回到「设置里的交叉时长」。
      // audioDuration 在上面是按【计划窗口】算的（智能渲染计划 = 8~60s）——
      // 直接用它做等功率交叉 = 两首歌同时满响十几秒（用户听感就是「双重奏」），
      // 这里改成按设置值收拢窗口，并把目标曲起点同步回推，
      // 使淡化结束时正好落在原定续播点（plan.targetEndTime）。
      // 节拍匹配关闭时同理：规划器仍可能给出 beat-crossfade（带节拍窗口的等功率交叉），
      // 但用户关掉节拍匹配的意图就是"短而干净的交叉"，会沿用设置时长而不是 8~20s 窗口。
      const isDeckCrossfade = strategy === 'fixed-crossfade'
        || (strategy === 'beat-crossfade' && autoMixRef.current.enableBeatMatching === false)
      // 无缝衔接的智能短交叉计划带 `gapless:` 前缀：其窗口是分析运算结果，豁免「按交叉设置
      // 收拢时长」的降级（否则会退回固定 4s，丢掉节拍对齐与静音裁剪的智能定位）。
      const isGaplessSmartPlan = String(plan?.id || '').startsWith('gapless:')
      if (isDeckCrossfade && !isGaplessSmartPlan) {
        const configured = Math.max(0.25, crossfadeRef.current.duration)
        if (Math.abs(configured - audioDuration) > 0.05) {
          debugLog(`   ↳ 卡座交叉淡化：过渡时长按设置收敛 ${audioDuration.toFixed(2)}s → ${configured.toFixed(2)}s（${strategy}）`)
        }
        audioDuration = configured
        visualDuration = configured
        const plannedTargetEnd = Number.isFinite(plan?.targetEndTime) ? (plan?.targetEndTime || 0) : targetTime + configured
        targetTime = Math.max(0, Math.min(plannedTargetEnd - configured, targetAudioEnd))
      }

      debugLog('🎵 [Transition] 开始标准交叉淡化过渡')
      target.currentTime = targetTime
      // gapless 也先以 0 增益启动 standby，随后在 gapless 分支做 60ms 淡入，
      // 避免以满音量硬起产生爆音（非 gapless 策略原本就是 0，语义不变）
      setDeckGain(getStandbyGain(), target, 0)
      debugLog('▶️ [Transition] 开始播放下一首歌曲...')
      await target.play()
      if (!isExecutionCurrent()) {
        const targetStillOwnedByOldRequest = getStandbyAudio() === target
          && (target.currentSrc || target.src) === targetSourceAtStart
          && nextMetadataRef.current?.trackKey === targetMetadata.trackKey
        if (targetStillOwnedByOldRequest && !target.paused) target.pause()
        return
      }
      debugLog('✅ [Transition] 下一首歌曲开始播放')
      
      // 开始过渡进度追踪
      const transitionStartTime = performance.now()
      transitionStartTimeRef.current = transitionStartTime
      
      setTransitionState('running-transition', {
        transitioning: true,
        seamlessTransition: true,
        transitionStrategy: strategy,
        fallbackReason: plan?.fallbackReason,
        transitionProgress: 0,
        transitionDuration: visualDuration,
        transitionFromTrackKey: currentMetadataRef.current?.trackKey || '',
        transitionToTrackKey: targetMetadata.trackKey || '',
      })

      // Gapless 模式：音频立即切换，但仍需视觉过渡动画
      if (strategy === 'gapless') {
        debugLog('⚡ [Transition] Gapless 模式：音频已切换，开始视觉过渡动画')
        // BUG-A1：原实现让 target.play() 满音量硬起、source.pause() 立即硬停，
        // 数字硬切落在非零交叉点会产生咔哒/爆音。这里在切换瞬间加入极短（60ms）
        // 等功率淡入淡出：source 淡出 + standby 淡入同时开始，双 deck 短暂同声，
        // 消除爆音且短到人耳听不出任何滞后（逻辑已抽到 gapless/gaplessTransition.ts）。
        runGaplessDeckFade({
          context: audioContextRef.current,
          sourceGain: getActiveGain(),
          targetGain: getStandbyGain(),
          source,
          target,
          isCurrentRevision: () => executionRevision === transitionExecutionRevisionRef.current,
          equalPowerCurve,
          runFallbackFade: runFallbackGainAnimation,
        })
        
        // 启动视觉过渡进度追踪
        let visualSwitchSent = false
        const updateVisualProgress = () => {
          if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
            return
          }
          
          const elapsed = (performance.now() - transitionStartTime) / 1000
          const progress = Math.min(elapsed / visualDuration, 1)
          // 与交叉淡化路径一致：过渡期间 timeupdate 被抑制，这里补发源曲 deck 的合成时间，
          // 避免进度条在过渡窗口内冻结（gapless 仅 0.4s，属兜底一致性）。
          const followAudio = source && !source.paused ? source : null
          const sourceFeedTime = followAudio ? Math.round(followAudio.currentTime * 4) / 4 : undefined
          // 视觉轨道：gapless 的音频在过渡开始时就已切到目标 deck（targetTime 为其起点）
          const visualSwitchedNow = transitionVisualStore.getSnapshot().switched
          const transitionTargetTime = targetTime + progress * visualDuration
          const targetDurationForUi = finiteDuration(target.duration) || (targetMetadata.duration || 0)
          const feedTime = visualSwitchedNow ? transitionTargetTime : sourceFeedTime
          const feedDuration = visualSwitchedNow && targetDurationForUi > 0 ? targetDurationForUi : undefined
          
          // When progress reaches 90%, send visualSwitchCommit to update UI early
          if (!visualSwitchSent && progress >= 0.9) {
            visualSwitchSent = true
            transitionVisualStore.markSwitched()
            const visualCommit: TransitionCommit = {
              sourceTrackKey: currentMetadataRef.current?.trackKey || '',
              targetTrackKey: targetMetadata.trackKey || '',
              targetIndex: targetMetadata.index,
              targetTime: targetTime,
              strategy: strategy,
              isVisualSwitch: true,
            }
            debugLog('🎨 [Transition] 视觉轨道切换 (gapless 90%) →', targetMetadata.trackKey)
            emit({
              transitionProgress: progress,
              transitionDuration: visualDuration,
              transitionTargetTime,
              visualSwitchCommit: visualCommit,
              currentTime: transitionTargetTime,
              ...(targetDurationForUi > 0 ? { duration: targetDurationForUi } : {}),
            })
            // 一次性关键事件不节流，但刷新节流基准
            transitionProgressEmitTimeRef.current = performance.now()
          } else {
            const now = performance.now()
            // 30fps 节流：距上次 emit ≥30ms 才 emit；progress 到达 1 强制发最终值
            if (progress >= 1 || now - transitionProgressEmitTimeRef.current >= 30) {
              emit({
                transitionProgress: progress,
                transitionDuration: visualDuration,
                transitionTargetTime,
                ...(feedTime !== undefined ? { currentTime: feedTime } : {}),
                ...(feedDuration !== undefined ? { duration: feedDuration } : {}),
              })
              transitionProgressEmitTimeRef.current = now
            }
          }
          
          if (progress < 1) {
            transitionProgressAnimationRef.current = requestAnimationFrame(updateVisualProgress)
          }
        }
        
        transitionProgressAnimationRef.current = requestAnimationFrame(updateVisualProgress)
        
        // 视觉过渡完成后提交
        transitionTimerRef.current = window.setTimeout(() => {
          commitTransition(strategy, targetTime, executionRevision)
        }, visualDuration * 1000)
        
        return
      }
      
      if (audioDuration <= 0.05) {
        debugLog('⚡ [Transition] 过渡时长过短，立即提交')
        commitTransition(strategy, targetTime, executionRevision)
        return
      }
      
      // 启动进度追踪动画
      let visualSwitchSent = false
      const updateTransitionProgress = () => {
        if (executionRevision !== transitionExecutionRevisionRef.current || transitionStateRef.current !== 'running-transition') {
          return
        }
        
        const elapsed = (performance.now() - transitionStartTime) / 1000
        const progress = Math.min(elapsed / audioDuration, 1)
        // 时间线合成：running-transition 期间 handleTimeUpdate 被抑制，而交叉淡化路径原本只发
        // transitionProgress ⇒ 进度条/已播时间整段冻结、commit 时一次性跳变（用户可见"卡住再跳"）。
        // 这里按源曲 deck 的真实位置补发 currentTime（渲染缓冲路径早有同类合成）。
        const followAudio = source && !source.paused ? source : null
        const sourceFeedTime = followAudio ? Math.round(followAudio.currentTime * 4) / 4 : undefined
        // 视觉轨道：目标 deck 从 targetTime 起播，其时间轴 = targetTime + 已过时长；
        // 切换后 UI 时间线用它，提交时恰好接上 deck 的真实位置（连续、不跳）。
        const visualSwitchedNow = transitionVisualStore.getSnapshot().switched
        const transitionTargetTime = targetTime + progress * audioDuration
        const targetDurationForUi = finiteDuration(target.duration) || (targetMetadata.duration || 0)
        const feedTime = visualSwitchedNow ? transitionTargetTime : sourceFeedTime
        const feedDuration = visualSwitchedNow && targetDurationForUi > 0 ? targetDurationForUi : undefined
        
        // When progress reaches 90%, send visualSwitchCommit to update UI early
        if (!visualSwitchSent && progress >= 0.9) {
          visualSwitchSent = true
          transitionVisualStore.markSwitched()
          const visualCommit: TransitionCommit = {
            sourceTrackKey: currentMetadataRef.current?.trackKey || '',
            targetTrackKey: targetMetadata.trackKey || '',
            targetIndex: targetMetadata.index,
            targetTime: targetTime,
            strategy: strategy,
            isVisualSwitch: true,
          }
          debugLog('🎨 [Transition] 视觉轨道切换 (交叉淡化 90%) →', targetMetadata.trackKey)
          emit({
            transitionProgress: progress,
            transitionDuration: audioDuration,
            transitionTargetTime,
            visualSwitchCommit: visualCommit,
            currentTime: transitionTargetTime,
            ...(targetDurationForUi > 0 ? { duration: targetDurationForUi } : {}),
          })
          // 一次性关键事件不节流，但刷新节流基准
          transitionProgressEmitTimeRef.current = performance.now()
        } else {
          const now = performance.now()
          // 30fps 节流：距上次 emit ≥30ms 才 emit；progress 到达 1 强制发最终值
          if (progress >= 1 || now - transitionProgressEmitTimeRef.current >= 30) {
            emit({
              transitionProgress: progress,
              transitionDuration: audioDuration,
              transitionTargetTime,
              ...(feedTime !== undefined ? { currentTime: feedTime } : {}),
              ...(feedDuration !== undefined ? { duration: feedDuration } : {}),
            })
            transitionProgressEmitTimeRef.current = now
          }
        }
        
        if (progress < 1) {
          transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)
        }
      }
      
      transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)

      const context = audioContextRef.current
      const sourceGain = getActiveGain()
      const targetGain = getStandbyGain()
      if (context && sourceGain && targetGain) {
        debugLog('🎚️ [Transition] 使用 Web Audio API 进行增益曲线过渡')
        const now = context.currentTime
        sourceGain.gain.cancelScheduledValues(now)
        targetGain.gain.cancelScheduledValues(now)
        sourceGain.gain.setValueAtTime(Math.max(0.0001, sourceGain.gain.value), now)
        targetGain.gain.setValueAtTime(0.0001, now)
        sourceGain.gain.setValueCurveAtTime(equalPowerCurve(false), now, audioDuration)
        targetGain.gain.setValueCurveAtTime(equalPowerCurve(true), now, audioDuration)
        
        // 在过渡中点（50%）切换视觉信息
        const midTransitionDelay = (audioDuration * 1000) / 2
        debugLog('⏰ [Transition] 设置视觉切换定时器，', (audioDuration / 2).toFixed(2), '秒后切换显示信息')
        visualSwitchTimerRef.current = window.setTimeout(() => {
          visualSwitchTimerRef.current = null
          if (executionRevision === transitionExecutionRevisionRef.current && transitionStateRef.current === 'running-transition') {
            debugLog('🎨 [Transition] 在过渡中点切换视觉信息到下一首')
            setTransitionState('running-transition', {
              transitioning: true,
              seamlessTransition: true,
              transitionStrategy: strategy,
              fallbackReason: plan?.fallbackReason,
              visualSwitchCommit: {
                sourceTrackKey: currentMetadataRef.current?.trackKey || '',
                targetTrackKey: targetMetadata.trackKey || '',
                targetIndex: targetMetadata.index,
                targetTime: targetTime + (audioDuration / 2),
                strategy,
                isVisualSwitch: true,  // 标记为视觉切换
              },
            })
          }
        }, midTransitionDelay)
        
        debugLog('⏰ [Transition] 设置过渡完成定时器，', audioDuration.toFixed(2), '秒后提交')
        transitionTimerRef.current = window.setTimeout(() => commitTransition(strategy, targetTime + audioDuration, executionRevision), audioDuration * 1000)
      } else {
        debugLog('🎚️ [Transition] Web Audio API 不可用，使用回退动画')
        runFallbackGainAnimation(source, target, audioDuration, () => commitTransition(strategy, targetTime + audioDuration, executionRevision))
      }
    } catch (error) {
      if (!isExecutionCurrent()) return
      console.error('❌ [Transition] 过渡失败:', error)
      // 落盘诊断（用户反馈「节点显示了时间但实际没过渡」类问题全靠它定位）：
      logAutomixBackend('transition:failed', `strategy=${strategy} · ${error instanceof Error ? error.message : String(error)}`)
      target.pause()
      if (nextMetadataRef.current?.trackKey === targetMetadata.trackKey) {
        detachAppleHls(target)
        nextMetadataRef.current = null
      }
      setDeckGain(getStandbyGain(), target, 0)
      setDeckGain(getActiveGain(), source, 1)
      setTransitionState('failed', {
        transitioning: false,
        transitionStrategy: strategy,
        fallbackReason: error instanceof Error ? error.message : 'next deck failed to start',
      })
    } finally {
      if (executionRevision === transitionExecutionRevisionRef.current) {
        transitionStartingRef.current = false
      }
    }
  }, [commitTransition, ensureAudioGraph, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, runFallbackGainAnimation, setDeckGain, setTransitionState])

  const prepareAutoMix = useCallback(async () => {
    // 看歌挂起（见 setWatchHold）：看歌期间引擎时间线静止，任何自动过渡的“准备→提交”
    // 都不允许发生——否则已武装的过渡会在看歌期间照常 commit → 切回时已经是下一首
    //（用户实测：Shelter 进看歌约 1.8s 后自动切到下一曲）
    if (watchHoldRef.current) {
      debugLog('⏸ [AutoMix] 看歌挂起：跳过 prepareAutoMix')
      return
    }
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    const pairStrategy = resolvePairTransitionStrategy(current, next, {
      autoMix: autoMixRef.current.enabled,
      crossfade: crossfadeRef.current.enabled,
      gapless: gaplessRef.current.enabled,
    })
    if (pairStrategy === 'gapless' && (current?.appleHls || next?.appleHls)) {
      preparationRevisionRef.current += 1
      preparationAbortRef.current?.abort()
      preparationAbortRef.current = null
      autoMixPreparationKeyRef.current = null
      transitionPlanRef.current = null
      debugLog('🍎 [AutoMix] Apple CENC 相邻边降级为 Gapless，不执行离线分析或渲染')
      setTransitionState('armed', {
        transitioning: false,
        transitionStrategy: 'gapless',
        fallbackReason: 'Apple CENC pair uses gapless',
        transitionStartTime: current?.duration || null,
      })
      return
    }
    
    debugLog('🔍 [AutoMix] prepareAutoMix 被调用')
    debugLog('🔍 [AutoMix] autoMix 设置:', autoMixRef.current)
    debugLog('🔍 [AutoMix] 当前歌曲:', current)
    debugLog('🔍 [AutoMix] 下一首歌曲:', next)

    const settings = autoMixRef.current
    const callerStack = new Error().stack?.split('\n').slice(2, 5).map(l => l.trim().replace(/^at /, '').split(' ')[0]).join('|') || '?'
    logAutomixBackend('prepareAutoMix:entry', [
      `enabled=${settings.enabled}`,
      `enhanced=${settings.enhanced === true}`,
      `aiMix=${settings.aiMix === true}`,
      `intensity=${settings.intensity ?? 'standard'}`,
      `beatMatching=${settings.enableBeatMatching}`,
      `current=${String(current?.trackKey || '').slice(0, 40)}`,
      `next=${String(next?.trackKey || '').slice(0, 40)}`,
      `caller=${callerStack}`,
    ].join(' '))

    if (!autoMixRef.current.enabled) {
      debugLog('⚠️ [AutoMix] 智能混音功能未启用，退出')
      logAutomixBackend('prepareAutoMix:exit', 'automix 未启用')
      return
    }
    
    if (!current?.url || !current.trackKey) {
      debugLog('⚠️ [AutoMix] 当前歌曲信息不完整，退出')
      logAutomixBackend('prepareAutoMix:exit', '当前歌曲信息不完整')
      return
    }
    
    if (!next?.url || !next.trackKey) {
      debugLog('⚠️ [AutoMix] 下一首歌曲信息不完整，退出')
      logAutomixBackend('prepareAutoMix:exit', '下一首歌曲信息不完整')
      return
    }
    const preparationKey = [
      current.trackKey,
      next.trackKey,
      current.url,
      next.url,
      settings.enableBeatMatching,
      settings.skipSilence,
      settings.minDuration,
      settings.maxDuration,
      settings.enhanced === true,
      settings.intensity,
      settings.aiMix === true,
      // 引擎与 Enhanced 档位必须参与 key：否则运行中切 standard/pro/enhanced 或切档位时，
      // 同一组合会被判定"已准备"，继续沿用旧引擎/旧档位的渲染结果。
      settings.engine ?? '',
      settings.enhancedTier ?? '',
    ].join(':')
    if (autoMixPreparationKeyRef.current === preparationKey) {
      debugLog('⏭️ [AutoMix] 相同歌曲组合正在准备，跳过重复分析')
      return
    }
    // 兜底计划（模块级实现；这里绑定当前曲对与活跃 deck 时长）
    const buildFallbackCrossfadePlan = (reason: string): TransitionPlan =>
      buildFallbackCrossfadePlanFor(current, next, getActiveAudio()?.duration || current.duration || 0, reason)
    /** 武装兜底计划（覆盖式）：任何"准备不成功"的出口都必须保证"至少有一次过渡"，
     *  否则本曲会退化为硬切 + 整曲重载的静音缝。 */
    const armFallbackCrossfade = (reason: string): TransitionPlan => {
      const fallbackPlan = buildFallbackCrossfadePlan(reason)
      transitionPlanRef.current = fallbackPlan
      const fallbackAnimationStart = Math.max(fallbackPlan.sourceStartTime, fallbackPlan.sourceEndTime - ANIMATION_LEAD_SECONDS)
      setTransitionState('armed', {
        transitionStrategy: 'fixed-crossfade',
        fallbackReason: fallbackPlan.fallbackReason,
        transitionStartTime: fallbackAnimationStart,
        transitionDebug: buildTransitionDebug(fallbackPlan, 'fallback'),
      })
      return fallbackPlan
    }
    // 用户已跳过这对曲目的智能混音（HUD「关闭」= 想完整听完这首歌）：
    // 优先于"已准备/已缓存"判断——直接武装末尾短交叉安全网，不做分析/渲染，也不进入节流重试链。
    if (autoMixSkippedPairsRef.current.has(`${String(current.trackKey)}->${String(next.trackKey)}`)) {
      debugLog('⏭️ [AutoMix] 本曲对已被用户跳过（想完整听完本曲），武装末尾短交叉')
      armFallbackCrossfade('用户跳过本曲智能混音（完整播放本曲）')
      return
    }
    if (autoMixPreparedOkRef.current.has(preparationKey) && transitionPlanRef.current) {
      debugLog('⏭️ [AutoMix] 相同歌曲组合已准备且计划仍有效，跳过重复分析')
      return
    }
    // REPREPARE 节流：失败后冷却期内不重复尝试（worker 冷启动窗口）；同一组合最多重试 1 次。
    // 早退前必须重新武装兜底：seek/暂停会把 transitionPlanRef 清空，若此处"空手 return"，
    // 该曲对在冷却期/上限内就再也没有任何过渡（用户听感：整曲硬切且无任何提示）。
    const previousAttempts = autoMixPreparationAttemptsRef.current.get(preparationKey)
    if (previousAttempts
      && (previousAttempts.attempts >= AUTO_MIX_MAX_PREPARE_ATTEMPTS
        || Date.now() - previousAttempts.lastAt < AUTO_MIX_REPREPARE_COOLDOWN_MS)) {
      debugLog(`⏭️ [AutoMix] 组合此前已失败 ${previousAttempts.attempts} 次，冷却/上限期内不重试`)
      if (!transitionPlanRef.current) armFallbackCrossfade('AutoMix preparation throttled (previous attempts failed)')
      return
    }
    autoMixPreparationKeyRef.current = preparationKey
    
    debugLog('✅ [AutoMix] 开始准备智能混音过渡')
    const revision = ++preparationRevisionRef.current
    preparationAbortRef.current?.abort()
    const controller = new AbortController()
    preparationAbortRef.current = controller
    // REPREPARE 记录器：失败尝试入账 + 定时重试（revision 过期即静默放弃）
    const recordFailureAndScheduleRetry = (reason: string) => {
      const attempts = (autoMixPreparationAttemptsRef.current.get(preparationKey)?.attempts ?? 0) + 1
      autoMixPreparationAttemptsRef.current.set(preparationKey, { attempts, lastAt: Date.now() })
      while (autoMixPreparationAttemptsRef.current.size > AUTO_MIX_SESSION_SET_MAX) {
        const oldest = autoMixPreparationAttemptsRef.current.keys().next().value
        if (oldest === undefined) break
        autoMixPreparationAttemptsRef.current.delete(oldest)
      }
      autoMixPreparedOkRef.current.delete(preparationKey)
      autoMixPreparationKeyRef.current = null
      logAutomixBackend('prepareAutoMix:reprepare', `attempts=${attempts} reason=${reason}`)
      if (attempts < AUTO_MIX_MAX_PREPARE_ATTEMPTS && autoMixPrepareRetryTimerRef.current === null) {
        const revisionAtFailure = revision
        autoMixPrepareRetryTimerRef.current = window.setTimeout(() => {
          autoMixPrepareRetryTimerRef.current = null
          if (revisionAtFailure !== preparationRevisionRef.current) return
          debugLog('🔁 [AutoMix] REPREPARE：定时重试准备过渡')
          prepareAutoMixRef.current()
        }, AUTO_MIX_REPREPARE_DELAY_MS)
      }
    }
    setTransitionState('preparing-next', { transitioning: false, fallbackReason: undefined, transitionStartTime: null })
    acceptanceAutoMixAnalysisStartsRef.current += 1
    try {
      debugLog('🎵 [AutoMix] 开始分析歌曲节拍和 BPM...')
      const [sourceAnalysis, targetAnalysis] = await Promise.all([
        current.analysis || autoMixAnalysisService.analyze({ trackKey: current.trackKey, url: current.url, duration: current.duration, signal: controller.signal }),
        next.analysis || autoMixAnalysisService.analyze({ trackKey: next.trackKey, url: next.url, duration: next.duration, signal: controller.signal }),
      ])
      if (controller.signal.aborted || revision !== preparationRevisionRef.current) return
      
      // 检查分析结果是否有效
      if (!sourceAnalysis || !targetAnalysis) {
        console.error('❌ [AutoMix] 分析结果无效，使用回退方案')
        debugLog('   sourceAnalysis:', sourceAnalysis)
        debugLog('   targetAnalysis:', targetAnalysis)
        throw new Error('Analysis failed: invalid results')
      }
      
      debugLog('✅ [AutoMix] 歌曲分析完成:')
      debugLog('   当前歌曲 BPM:', sourceAnalysis.estimatedBpm, 'provider:', sourceAnalysis.provider)
      debugLog('   下一首 BPM:', targetAnalysis.estimatedBpm, 'provider:', targetAnalysis.provider)
      
      current.analysis = sourceAnalysis
      next.analysis = targetAnalysis

      // ③ 格式/一致性预检：provider/时长/声道 sanity——拦截即提前武装固定交叉（确定性，不重试）
      const compatibilityIssue = describeTransitionCompatibilityIssue(sourceAnalysis, targetAnalysis, current, next)
      if (compatibilityIssue) {
        // 时长不一致（分析时长 vs 流时长）＝ 陈旧缓存特征：早前无会员/换源时下载的
        // 30s 试听片段被 trackKey 音频缓存钉死，分析自然跟着 30s。确定性降级会让
        // AutoMix 整个会话失效（preparedOk 永久跳过）。这里失效陈旧缓存后走
        // REPREPARE 重试一次（重试会按当前流 URL 重新下载完整音频并重新分析）；
        // 其余 compat 原因维持原确定性降级。
        const staleAudioIssue = /分析时长与流时长不一致/.test(compatibilityIssue)
        const staleIsSource = staleAudioIssue && compatibilityIssue.startsWith('当前曲')
        const staleTrackKey = staleAudioIssue ? String((staleIsSource ? current : next)?.trackKey || '').trim() : ''
        transitionPlanRef.current = buildFallbackCrossfadePlan(compatibilityIssue)
        const blockedPlan = transitionPlanRef.current
        console.warn(`⛔ [AutoMix] 格式预检拦截，降级固定交叉：${compatibilityIssue}`)
        logAutomixBackend('prepareAutoMix:compat-block', compatibilityIssue)
        const blockedAnimationStart = Math.max(blockedPlan.sourceStartTime, blockedPlan.sourceEndTime - ANIMATION_LEAD_SECONDS)
        setTransitionState('armed', {
          transitionStrategy: 'fixed-crossfade',
          fallbackReason: blockedPlan.fallbackReason,
          transitionStartTime: blockedAnimationStart,
          transitionDebug: buildTransitionDebug(blockedPlan, 'fallback'),
        })
        if (staleAudioIssue && staleTrackKey) {
          logAutomixBackend('prepareAutoMix:stale-invalidate', `trackKey=${staleTrackKey}`)
          autoMixAnalysisService.invalidateTrack(staleTrackKey)
          void window.electron?.audioDownload?.deleteCached?.(staleTrackKey)?.catch(() => undefined)
          if (staleIsSource) current.analysis = undefined
          else next.analysis = undefined
          recordFailureAndScheduleRetry(compatibilityIssue)
        } else {
          autoMixPreparedOkRef.current.add(preparationKey)
          while (autoMixPreparedOkRef.current.size > AUTO_MIX_SESSION_SET_MAX) {
            const oldestPrepared = autoMixPreparedOkRef.current.keys().next().value
            if (oldestPrepared === undefined) break
            autoMixPreparedOkRef.current.delete(oldestPrepared)
          }
          autoMixPreparationAttemptsRef.current.delete(preparationKey)
        }
        return
      }

      const isEnhanced = autoMixRef.current.enhanced === true
      const plan = isEnhanced
        ? planTransitionV2(sourceAnalysis, targetAnalysis, {
          beatMatching: autoMixRef.current.enableBeatMatching,
          skipSilence: autoMixRef.current.skipSilence,
          minDuration: autoMixRef.current.minDuration,
          maxDuration: autoMixRef.current.maxDuration,
          intensity: autoMixRef.current.intensity,
          aiMix: autoMixRef.current.aiMix,
        }, 'smart-rendered-v2')
        : planTransition(sourceAnalysis, targetAnalysis, {
          beatMatching: autoMixRef.current.enableBeatMatching,
          skipSilence: autoMixRef.current.skipSilence,
          minDuration: autoMixRef.current.minDuration,
          maxDuration: autoMixRef.current.maxDuration,
        }, 'smart-rendered')
      // 渲染下载缓存时长闸的全曲时长基准（Enhanced 云端切点会落在曲中，
      // plan.sourceEndTime/targetEndTime 只是过渡段终点，不是全曲——
      // 拿它当期望时长会把 236s 的整曲误判成"29s 截断"→ 永久降级固定交叉）。
      // ⚠️ 优先用 analysis.duration（从实际文件解码得出）而不是队列元数据：
      // QQ 元数据时长普遍比实际文件虚高 ~10s（真机 2026-10-19 日志 4/4 首
      // actual = 元数据 - 10），拿元数据做期望会把完整文件误判成截断。
      plan.sourceTrackDuration = Number(sourceAnalysis.duration) || Number(current.duration) || undefined
      plan.targetTrackDuration = Number(targetAnalysis.duration) || Number(next.duration) || undefined

      // AutoMix Enhanced（三档）：走 QQ 官方智能混音链路。
      // 计划里的时间轴先由本地规划器给出占位，实际切点/时长以渲染结果为准
      // （TransitionRenderer 会用后端返回的云端值时回填）。
      const engine = autoMixRef.current.engine ?? (isEnhanced ? 'pro' : 'standard')
      if (engine === 'enhanced') {
        plan.strategy = 'smart-rendered-qq'
        plan.qq = {
          tier: autoMixRef.current.enhancedTier || 'lite',
          source: qqTrackRef(current),
          target: qqTrackRef(next),
        }
        plan.qqAppliedTier = undefined
        plan.rendererVersion = `qq-automix-${plan.qq.tier}-r1`
        // 计划 id 参与渲染缓存键：加档位后缀，避免与 Pro/其他档位互相命中
        plan.id = `${plan.id}-qq-${plan.qq.tier}`
        debugLog(`[AutoMix] Enhanced 档位: ${plan.qq.tier}（云端档需 QQ 登录，不可用则自动回退 Lite）`)

        // 云端切点必须在渲染前拿到：计划的过渡起点/时长决定播放调度与动画窗口；
        // 若等渲染完再回填，云端切点可能已经过去（会立刻切歌）。
        // 未登录 / 匹配不到 / 云端不可用时后端直接给 Lite 时间轴（effectiveTier=lite）。
        try {
          const audioDownload = window.electron?.audioDownload
          const renderApi = window.electron?.render
          if (audioDownload?.prepare && typeof renderApi?.qqAutomixCue === 'function') {
            const [qqSourcePath, qqTargetPath] = await Promise.all([
              audioDownload.prepare(current.url, plan.sourceTrackKey, { expectedDuration: current.duration }),
              audioDownload.prepare(next.url, plan.targetTrackKey, { expectedDuration: next.duration }),
            ])
            const cue = await renderApi.qqAutomixCue({
              tier: plan.qq.tier,
              sourceAudioPath: qqSourcePath,
              targetAudioPath: qqTargetPath,
              sourceMid: plan.qq.source.mid,
              sourceTitle: plan.qq.source.title,
              sourceArtist: plan.qq.source.artist,
              sourceTrackId: plan.qq.source.trackId,
              targetMid: plan.qq.target.mid,
              targetTitle: plan.qq.target.title,
              targetArtist: plan.qq.target.artist,
              targetTrackId: plan.qq.target.trackId,
            })
            const start = Number(cue?.transition_start_s)
            const duration = Number(cue?.transition_duration_s)
            const targetStart = Number(cue?.target_start_s) || 0
            if (cue?.success && Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
              // 云端 sanity 钳制：云端曲库的曲长与本地文件（试听片段/不同版本/地区版）可能不一致，
              // OutCue/InCue 照单全收会让过渡窗口越过本地音频末尾——渲染产物含静音尾、
              // 播放调度在源曲自然结束前就试图切歌（听感"突然静音又切走"）。
              // 按本地全曲时长把窗口压回曲内（保留至少 0.5s 尾余量），越界幅度 > 3s 视为
              // 云端/本地曲长严重错配，直接退回 Pro（v2）链路。
              // ⚠️ 时长基准用 analysis.duration（实际文件解码）优先：元数据在补源场景
              // （audioSourceOverride）是**原平台**的时长，与实际 QQ 音频可能差几十秒——
              // 用它钳制会把"本应退 Pro"的错配 cue 放过去（钳制变松）。
              const srcDur = Number(sourceAnalysis.duration) || Number(current.duration) || 0
              const tgtDur = Number(targetAnalysis.duration) || Number(next.duration) || 0
              const clampedStart = srcDur > 0 ? Math.max(0, Math.min(start, srcDur - 0.5)) : Math.max(0, start)
              const clampedDuration = srcDur > 0 ? Math.max(0.5, Math.min(duration, srcDur - 0.5 - clampedStart)) : duration
              const clampedTargetStart = tgtDur > 0 ? Math.max(0, Math.min(targetStart, Math.max(0, tgtDur - 0.5))) : Math.max(0, targetStart)
              const cueOutOfRange = srcDur > 0 && (start > srcDur - 0.5 || (start + duration) > srcDur + 3)
                || (tgtDur > 0 && (targetStart > tgtDur - 0.5 || (targetStart + duration) > tgtDur + 3))
              if (cueOutOfRange) {
                logAutomixBackend('prepareAutoMix:cue-out-of-range', `start=${start.toFixed(2)} dur=${duration.toFixed(2)} targetStart=${targetStart.toFixed(2)} src=${srcDur.toFixed(1)} tgt=${tgtDur.toFixed(1)} → 退回 Pro`)
                plan.strategy = 'smart-rendered-v2'
                plan.qq = undefined
                plan.qqAppliedTier = undefined
                plan.rendererVersion = 'automix-v2-dsp-r1'
              } else {
                plan.sourceStartTime = clampedStart
                plan.sourceEndTime = clampedStart + clampedDuration
                plan.targetStartTime = clampedTargetStart
                plan.targetEndTime = clampedTargetStart + clampedDuration
                plan.qqAppliedTier = String(cue.effectiveTier || plan.qq.tier)
                debugLog(`[AutoMix] Enhanced 交接计划（${plan.qqAppliedTier}）：源 ${clampedStart.toFixed(2)}s + 过渡 ${clampedDuration.toFixed(2)}s，目标从 ${clampedTargetStart.toFixed(2)}s 续播`)
                if (cue.fallback?.reason) {
                  debugLog(`[AutoMix] Enhanced 已降级为 ${plan.qqAppliedTier}：${cue.fallback.reason}`)
                }
              }
            } else {
              // 取不到云端交接计划时不能只渲染不排期：计划与音频时间轴会不一致
              // （切点可能已经过去 → 立刻切歌）。整体退回 Pro（v2）链路。
              plan.strategy = 'smart-rendered-v2'
              plan.qq = undefined
              plan.qqAppliedTier = undefined
              plan.rendererVersion = 'automix-v2-dsp-r1'
              debugLog('[AutoMix] Enhanced 交接计划不可用，本次退回 Pro（v2）渲染:', cue?.error || 'invalid cue')
            }
          }
        } catch (error) {
          // 同上：拿不到云端交接计划就整体退回 Pro，绝不让计划与音频时间轴不一致
          plan.strategy = 'smart-rendered-v2'
          plan.qq = undefined
          plan.qqAppliedTier = undefined
          plan.rendererVersion = 'automix-v2-dsp-r1'
          debugLog('[AutoMix] Enhanced 交接计划获取失败，本次退回 Pro（v2）渲染:', error)
        }
      }

      // Echo 借鉴：剩余时间过短（<12s）时放弃 AutoMix，让 Gapless/Crossfade 接管。
      // 智能过渡段通常 8~16s，剩余时间不够播放完整过渡，且会挤压下一首预加载窗口。
      // AI 混音（GAN）除外：模型窗口向源尾回伸 ~34s，天然有足够跑道，不适用此检查。
      const remainingBeforeTransition = Math.max(0, (Number(current.duration) || 0) - plan.sourceStartTime)
      if (remainingBeforeTransition < 12 && (plan.strategy === 'smart-rendered' || plan.strategy === 'smart-rendered-v2') && plan.v2?.aiMix !== true) {
        debugLog(`⏭️ [AutoMix] 剩余时间过短（${remainingBeforeTransition.toFixed(1)}s < 12s），放弃 AutoMix 走 Crossfade`)
        plan.strategy = 'fixed-crossfade'
        plan.fallbackReason = 'Too little time before transition; using crossfade'
      }
      
      debugLog('📋 [AutoMix] 过渡计划生成:')
      debugLog('   计划ID:', plan.id)
      debugLog('   策略:', plan.strategy)
      debugLog('   置信度:', plan.confidence)
      debugLog('   过渡开始时间:', plan.sourceStartTime, 's')
      debugLog('   过渡结束时间:', plan.sourceEndTime, 's')
      debugLog('   节拍数:', plan.beatCount)
      if (plan.djEffects?.enabled) {
        debugLog('   DJ FX:', plan.djEffects)
      }
      
      // The planner is the single source of truth for smart-render eligibility.
      let retryableFailure: string | null = null
      const requiresSmartRender = plan.strategy === 'smart-rendered' || plan.strategy === 'smart-rendered-v2' || plan.strategy === 'smart-rendered-qq'
      if (requiresSmartRender && transitionRendererRef.current) {
        debugLog('🎨 [AutoMix] 尝试智能渲染...')
        try {
          await transitionRendererRef.current.preRender({
            sourceUrl: current.url,
            targetUrl: next.url,
            plan,
            isStale: () => revision !== preparationRevisionRef.current,
          })
          // 渲染期间可能已被新的准备请求（如快速切歌）取代：
          // 该批次号已过期时丢弃结果，避免旧过渡计划覆盖新状态。
          if (revision !== preparationRevisionRef.current) {
            debugLog('⏭️ [AutoMix] 预渲染期间已被新请求取代，丢弃本结果')
            return
          }
          debugLog('✅ [AutoMix] 智能渲染完成，过渡音频已缓存:', plan.id)
          logAutomixBackend('prepareAutoMix:render-ok', plan.id)
        } catch (renderError) {
          // 过期中止的错误不应触发回退逻辑（新请求正在准备中）
          if (revision !== preparationRevisionRef.current) return
          const renderReason = renderError instanceof Error ? renderError.message : String(renderError)
          console.warn('⚠️ [AutoMix] 智能渲染失败，回退到普通交叉淡化:', renderReason)
          logAutomixBackend('prepareAutoMix:render-fail', renderReason)
          plan.strategy = 'fixed-crossfade'
          plan.fallbackReason = `Smart rendering failed: ${renderReason}`
          // 渲染失败属瞬时性（python worker 未就绪等）：先武装 fallback 保证有过渡，
          // 同时进入 REPREPARE 重试，成功后本次组合升级回智能过渡
          retryableFailure = renderReason
        }
      } else if (requiresSmartRender) {
        debugLog('⚠️ [AutoMix] 智能渲染器不可用，回退到普通交叉淡化')
        plan.strategy = 'fixed-crossfade'
        plan.fallbackReason = 'Smart renderer unavailable; using crossfade'
      }
      
      debugLog('🎯 [AutoMix] 最终过渡策略:', plan.strategy)
      if (plan.fallbackReason) {
        debugLog('   回退原因:', plan.fallbackReason)
      }
      // 不依赖「过渡调试」开关的可见警告：DevTools 控制台默认输出，方便定位降级原因
      if ((plan.strategy === 'fixed-crossfade' || plan.strategy === 'beat-crossfade') && plan.fallbackReason) {
        console.warn(`[AutoMix] 本次过渡降级为 ${plan.strategy}：${plan.fallbackReason}`)
      }
      logAutomixBackend('prepareAutoMix:plan', [
        `strategy=${plan.strategy}`,
        `fallback=${plan.fallbackReason ?? 'none'}`,
        `confidence=${plan.confidence.toFixed(3)}`,
        `bpm=${plan.sourceBpm}->${plan.targetBpm}`,
        `beatCount=${plan.beatCount}`,
        `aiMix=${plan.v2?.aiMix === true}`,
        `style=${plan.v2?.choreography?.style ?? '-'}`,
        `analysis=${sourceAnalysis.provider}->${targetAnalysis.provider}`,
      ].join(' '))

      // AI 混音（DJTransGAN）渲染器把过渡窗口替换为模型自身的长混音窗口
      // （~60s，起点在源尾 ~34s 处）。armed 触发点必须用解析后的窗口，
      // 否则过渡 buffer 会在错误时机启动。
      const dspSourceStart = plan.sourceStartTime
      const dspTargetEnd = plan.targetEndTime
      if (transitionRendererRef.current) {
        const renderedPlan = transitionRendererRef.current.getRenderedPlan(plan.id)
        if (renderedPlan) {
          if (plan.v2 && renderedPlan.v2) {
            plan.v2 = { ...plan.v2, ...renderedPlan.v2 }
            plan.rendererVersion = renderedPlan.rendererVersion
          }
          // QQ Enhanced 渲染 worker 透传的过渡手法 → 调试弹窗 effects
          if (plan.strategy === 'smart-rendered-qq'
            && Array.isArray(renderedPlan.qqTechniques) && renderedPlan.qqTechniques.length > 0) {
            plan.qqTechniques = renderedPlan.qqTechniques
          }
          // 渲染器真身与降级原因必须回填：否则调试面板/切歌提示显示的档位、版本与
          // fallback 原因都停留在本地规划器的占位值（用户看到"Enhanced extreme"而实际是 lite）。
          if (typeof renderedPlan.qqAppliedTier === 'string' && renderedPlan.qqAppliedTier) {
            plan.qqAppliedTier = renderedPlan.qqAppliedTier
          }
          if (typeof renderedPlan.rendererVersion === 'string' && renderedPlan.rendererVersion && plan.strategy !== 'smart-rendered-qq') {
            plan.rendererVersion = renderedPlan.rendererVersion
          }
          if (!plan.fallbackReason && renderedPlan.fallbackReason) {
            plan.fallbackReason = renderedPlan.fallbackReason
          }
          if (typeof renderedPlan.renderedDuration === 'number' && renderedPlan.renderedDuration > 0) {
            plan.renderedDuration = renderedPlan.renderedDuration
          }
          // QQ 档时间轴一致性：App 的触发点/续播点/UI 进度都用 plan 的四个时间字段，
          // 而播放的是渲染产物。若渲染侧给出的时间轴不同（cue 与 render 各自取云端决策
          // 或命中了不同窗口的磁盘缓存），必须以渲染产物为准，否则"触发点错位、交接跳段"。
          if (plan.strategy === 'smart-rendered-qq'
            && Number.isFinite(renderedPlan.sourceStartTime)
            && Number.isFinite(renderedPlan.sourceEndTime)
            && Number.isFinite(renderedPlan.targetStartTime)
            && Number.isFinite(renderedPlan.targetEndTime)) {
            const drift = Math.max(
              Math.abs(renderedPlan.sourceStartTime - plan.sourceStartTime),
              Math.abs(renderedPlan.targetEndTime - plan.targetEndTime),
            )
            if (drift > 0.15) {
              console.warn(`[AutoMix] Enhanced 时间轴与渲染产物不一致（偏差 ${drift.toFixed(2)}s），以渲染产物为准`)
              logAutomixBackend('prepareAutoMix:timeline-drift', `drift=${drift.toFixed(3)} sourceStart ${plan.sourceStartTime.toFixed(2)}->${renderedPlan.sourceStartTime.toFixed(2)} targetEnd ${plan.targetEndTime.toFixed(2)}->${renderedPlan.targetEndTime.toFixed(2)}`)
              plan.sourceStartTime = renderedPlan.sourceStartTime
              plan.sourceEndTime = renderedPlan.sourceEndTime
              plan.targetStartTime = renderedPlan.targetStartTime
              plan.targetEndTime = renderedPlan.targetEndTime
              plan.fallbackReason = plan.fallbackReason || 'Timeline aligned to rendered artifact'
            }
          }
          // overlap 窗口（缓冲尾渐出 + deck 提前启动）由渲染结果携带，
          // 必须回填到计划，playTransition 时才会启用（AI 与 DSP 智能过渡都适用）。
          if (typeof renderedPlan.overlapSeconds === 'number' && renderedPlan.overlapSeconds > 0) {
            plan.overlapSeconds = renderedPlan.overlapSeconds
            debugLog(`🎼 [AutoMix] overlap handoff 窗口: ${plan.overlapSeconds.toFixed(1)}s`)
          }
          if (plan.v2?.aiMix === true && Number.isFinite(renderedPlan.sourceStartTime)) {
            plan.sourceStartTime = renderedPlan.sourceStartTime
            plan.targetEndTime = renderedPlan.targetEndTime
            debugLog(`🎬 [AutoMix] AI 混音窗口: sourceStart=${plan.sourceStartTime.toFixed(1)}s, targetResume=${plan.targetEndTime.toFixed(1)}s`)
          }
        }
      }
      // 用户 seek/快进已进入 AI 过渡窗口：不再降级为交叉——playTransition 会按当前
      // offset 从缓冲剩余部分继续播放（事件驱动 handoff + 合成时间线已消除旧版"seek 卡死"），
      // 只有 offset 越过缓冲 85% 时由 playTransition 的 tooLate 保护回退交叉（合理兜底）。
      // （历史降级逻辑导致：seek/左右键快进后全部变成交叉过渡，用户听不到智能过渡，
      //  且 automix 介入状态也不显示——已移除。）
      
      transitionPlanRef.current = plan
      // 过渡动画时机独立于音频过渡：AI 长混音（~60s）从 sourceStartTime 就开始，
      // 动画若跟随则长达数十秒影响观感。动画（倒计时/流光/渐变）最多提前
      // ANIMATION_LEAD_SECONDS 进入；音频触发仍由 handleTimeUpdate 按 sourceStartTime 决定。
      // AI 路径的窗口末尾 = 模型固定 ~60s（sourceEndTime 仍是 DSP 窗口，不能用来算动画起点）。
      // 动画窗口 = 混音最后 20s（用户反馈"介入好久才进动画"——10s 太晚、叠加过程太短像"直接变"）。
      const animationStartTime = plan.strategy === 'smart-rendered-v2' && plan.v2?.aiMix === true
        // AI 长混音：动画窗口 = 混音最后 20s。窗口长度优先取渲染器返回的真实缓冲时长
        // （renderedDuration），模型窗口变化时不再与写死的 60 错位；缺失时按 60 兜底
        // （DJTransGAN 训练窗口语义，实测 140 次渲染恒为 60.0s）。
        ? Math.max(
            plan.sourceStartTime,
            plan.sourceStartTime + (plan.renderedDuration ?? AI_MIX_WINDOW_SECONDS) - ANIMATION_TAIL_SECONDS,
          )
        : Math.max(plan.sourceStartTime, plan.sourceEndTime - ANIMATION_LEAD_SECONDS)
      setTransitionState('armed', {
        transitionStrategy: plan.strategy,
        fallbackReason: plan.fallbackReason,
        transitioning: false,
        transitionStartTime: animationStartTime,
        transitionStyle: plan.v2?.choreography?.style,
        // armed 即下发过渡轨道 key：MV 背景预载提前到准备阶段，
        // 否则短过渡（DSP 8~12s）预载时间不足 → commit 时未就绪 → 封面重载数秒
        transitionFromTrackKey: current.trackKey,
        transitionToTrackKey: next.trackKey,
        transitionDebug: buildTransitionDebug(plan, isEnhanced ? 'v2' : 'v1', sourceAnalysis, targetAnalysis),
      })
      if (retryableFailure) {
        recordFailureAndScheduleRetry(retryableFailure)
      } else {
        // 成功或确定性降级（置信度/剩余时间/格式预检）：本组合不再重试。
        // 同时清"正在准备"标记：seek 越过过渡窗口会清 plan 并重调 prepareAutoMix，
        // 若 key 还挂着，2279 行的"相同组合正在准备"会把重入拦截掉——本曲剩余
        // 时间完全失去过渡（硬切 + 静音缝）。
        autoMixPreparedOkRef.current.add(preparationKey)
        autoMixPreparationKeyRef.current = null
        while (autoMixPreparedOkRef.current.size > AUTO_MIX_SESSION_SET_MAX) {
          const oldestPrepared = autoMixPreparedOkRef.current.keys().next().value
          if (oldestPrepared === undefined) break
          autoMixPreparedOkRef.current.delete(oldestPrepared)
        }
        autoMixPreparationAttemptsRef.current.delete(preparationKey)
      }
      debugLog('✅ [AutoMix] 过渡已准备就绪（armed），等待播放到过渡点...')
    } catch (error) {
      if (controller.signal.aborted || revision !== preparationRevisionRef.current) return
      console.error('❌ [AutoMix] 准备过渡失败:', error)
      // REPREPARE：分析/准备失败入账并定时重试一次；fallback plan 照常武装（安全网）
      const failureReason = error instanceof Error ? error.message : 'analysis failed'
      recordFailureAndScheduleRetry(failureReason)
      transitionPlanRef.current = buildFallbackCrossfadePlan(failureReason)
      debugLog('🔄 [AutoMix] 使用回退方案: fixed-crossfade')
      logAutomixBackend('prepareAutoMix:fallback', transitionPlanRef.current.fallbackReason ?? 'analysis failed')
      const fallbackPlan = transitionPlanRef.current
      const fallbackAnimationStart = Math.max(fallbackPlan.sourceStartTime, fallbackPlan.sourceEndTime - ANIMATION_LEAD_SECONDS)
      setTransitionState('armed', {
        transitionStrategy: 'fixed-crossfade',
        fallbackReason: fallbackPlan.fallbackReason,
        transitionStartTime: fallbackAnimationStart,
        transitionDebug: buildTransitionDebug(fallbackPlan, 'fallback'),
      })
    }
  }, [getActiveAudio, setTransitionState])
  // REPREPARE 定时器通过 ref 调用最新渲染的 prepareAutoMix（避免 useCallback 自引用）
  prepareAutoMixRef.current = prepareAutoMix

  /**
   * 无缝衔接的「智能短交叉」准备（跨专辑边界；独立于 AutoMix 的功能）。
   *
   * 复用与 AutoMix 同一套机制：autoMixAnalysisService 的轨迹分析（BPM/节拍/首尾静音/
   * 音色与和声特征） + transitionPlanner 的窗口规划（节拍对齐、静音裁剪、候选窗口按
   * 相似度/响度/人声度打分）。与 AutoMix 的区别是**设计参数**：
   *   · 窗口时长锁在无缝衔接自己的区间 1.5–4s（短交叉，不做 DJ 式长混音）；
   *   · 无效果链、无渲染、无 stem——就是一次智能定位的等功率交叉；
   *   · 窗口落在「有声内容尾部」（skipSilence），交叉位置/前后取量均由分析结果决定。
   * 计划就绪后以 armed 状态登记（transitionStartTime = 交叉起点），
   * 播放到窗口起点时由 handleTimeUpdate 触发 beat-crossfade 执行。
   */
  const prepareGaplessCrossfade = useCallback(async () => {
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    if (!gaplessRef.current.enabled || autoMixRef.current.enabled) return
    if (!current?.url || !current.trackKey || !next?.url || !next.trackKey) return
    const pairKey = `${current.trackKey}->${next.trackKey}`
    if (autoMixSkippedPairsRef.current.has(pairKey)) return
    // 同专辑留给「直接拼接」三方案（专辑连续性），不走交叉
    if (current.albumId && next.albumId && current.albumId === next.albumId) return

    const revision = preparationRevisionRef.current
    const controller = new AbortController()
    preparationAbortRef.current?.abort()
    preparationAbortRef.current = controller
    try {
      const [sourceAnalysis, targetAnalysis] = await Promise.all([
        current.analysis || autoMixAnalysisService.analyze({ trackKey: current.trackKey, url: current.url, duration: current.duration, signal: controller.signal }),
        next.analysis || autoMixAnalysisService.analyze({ trackKey: next.trackKey, url: next.url, duration: next.duration, signal: controller.signal }),
      ])
      if (controller.signal.aborted || revision !== preparationRevisionRef.current) return
      if (!sourceAnalysis || !targetAnalysis) throw new Error('gapless analysis failed')
      current.analysis = sourceAnalysis
      next.analysis = targetAnalysis
      const plan = planTransition(sourceAnalysis, targetAnalysis, {
        beatMatching: true,
        skipSilence: true,
        minDuration: 1.5,
        maxDuration: 4,
      }, 'beat-crossfade')
      // 无缝衔接语义（用户定稿）：
      //   · 交叉锚定在**歌曲最末尾的空白处**——源窗口以原始曲末为终点，绝不提前到中段；
      //   · 窗口“长度”（交叉多少秒）仍取规划器的智能结果（节拍网格/节奏相似度，1.5–4s）；
      //   · 下一首从头进入（只跳过静音前奏，上限 2s），不用混音入点、不 seek 未缓冲位置。
      const windowLength = Math.max(0.5, Math.min(4, plan.sourceEndTime - plan.sourceStartTime))
      const sourceEnd = Math.max(windowLength, current.duration || plan.sourceEndTime)
      plan.sourceStartTime = Math.max(0, sourceEnd - windowLength)
      plan.sourceEndTime = sourceEnd
      const introSkip = Number.isFinite(targetAnalysis.introSilence)
        ? Math.max(0, Math.min(2, targetAnalysis.introSilence))
        : 0
      plan.targetStartTime = introSkip
      plan.targetEndTime = introSkip + windowLength
      // 标记为无缝衔接计划：交叉执行时豁免「按交叉设置收拢窗口」的降级
      plan.id = `gapless:${plan.id}`
      gaplessPlanRef.current = plan
      logAutomixBackend(
        'gapless:crossfade-plan',
        `${pairKey} start=${plan.sourceStartTime.toFixed(2)} end=${plan.sourceEndTime.toFixed(2)} dur=${(plan.sourceEndTime - plan.sourceStartTime).toFixed(2)}s targetStart=${plan.targetStartTime.toFixed(2)} confidence=${plan.confidence.toFixed(2)}`,
      )
      setTransitionState('armed', {
        transitionStrategy: 'gapless',
        fallbackReason: plan.fallbackReason,
        transitionStartTime: plan.sourceStartTime,
        transitionDebug: buildTransitionDebug(plan, 'fallback'),
      })
    } catch (error) {
      if (controller.signal.aborted || revision !== preparationRevisionRef.current) return
      // 分析不可用：不武装计划，播放到边界时走 handleTimeUpdate 的兜底触发（静音裁剪 + 默认短窗）
      logAutomixBackend('gapless:crossfade-plan-failed', error instanceof Error ? error.message : 'analysis failed')
    }
  }, [setTransitionState])
  prepareGaplessCrossfadeRef.current = () => { void prepareGaplessCrossfade() }

  /**
   * 用户在 HUD 点「关闭」：本次「当前曲 → 下一曲」不做智能混音（想完整听完这首歌）。
   * 语义：
   *   - 记入跳过集合（按曲对），本曲后续的 prepareAutoMix 会优先走"末尾短交叉"，不再分析/渲染；
   *   - 立即把已武装的智能计划换成短交叉安全网（丢掉在飞的渲染，保留 standby 与元数据不重载音频）；
   *   - 只影响这一对曲目：下一首自己的过渡仍按设置走智能混音。
   */
  const skipAutoMixForCurrentPair = useCallback(() => {
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    if (!current?.trackKey || !next?.trackKey) return
    const pairKey = `${current.trackKey}->${next.trackKey}`
    autoMixSkippedPairsRef.current.add(pairKey)
    while (autoMixSkippedPairsRef.current.size > AUTO_MIX_SESSION_SET_MAX) {
      const oldestPair = autoMixSkippedPairsRef.current.keys().next().value
      if (oldestPair === undefined) break
      autoMixSkippedPairsRef.current.delete(oldestPair)
    }
    logAutomixBackend('automix:skipped-by-user', pairKey)
    // 丢掉在飞的准备/渲染与定时器；preserveNext=true 保住待机 deck 的源与元数据（不重载音频），
    // announce=false 不对外播「cancelled」状态（避免播放页闪一下过渡态又消失）。
    cancelScheduledTransition('user skipped automix for this pair', true, false)
    const fallbackPlan = buildFallbackCrossfadePlanFor(
      current,
      next,
      getActiveAudio()?.duration || current.duration || 0,
      '用户跳过本曲智能混音（完整播放本曲）',
    )
    transitionPlanRef.current = fallbackPlan
    const animationStart = Math.max(fallbackPlan.sourceStartTime, fallbackPlan.sourceEndTime - ANIMATION_LEAD_SECONDS)
    setTransitionState('armed', {
      transitioning: false,
      transitionStrategy: 'fixed-crossfade',
      fallbackReason: fallbackPlan.fallbackReason,
      transitionStartTime: animationStart,
      transitionDebug: buildTransitionDebug(fallbackPlan, 'fallback'),
      transitionFromTrackKey: current.trackKey,
      transitionToTrackKey: next.trackKey,
    })
    debugLog('⏭️ [AutoMix] 用户跳过本曲智能混音，改为末尾短交叉:', pairKey)
  }, [cancelScheduledTransition, getActiveAudio, setTransitionState])

  const prepareGaplessTransition = useCallback(async () => {
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    if (current?.appleHls || next?.appleHls) {
      transitionPlanRef.current = null
      debugLog('🍎 [Gapless] Apple CENC 相邻边使用 managed 双 deck 无缝衔接')
      setTransitionState('armed', {
        transitionStrategy: 'gapless',
        fallbackReason: undefined,
        transitioning: false,
        transitionStartTime: current?.duration || null,
      })
      return
    }
    
    debugLog('[Gapless] prepareGaplessTransition 被调用')
    debugLog('[Gapless] 当前歌曲:', current)
    debugLog('[Gapless] 下一首歌曲:', next)
    
    if (!gaplessRef.current.enabled || !gaplessIntegrationRef.current) {
      debugLog('[Gapless] 无缝衔接未启用或未初始化')
      return
    }
    
    if (!current?.url || !current.trackKey) {
      debugLog('[Gapless] 当前歌曲信息不完整')
      return
    }
    
    if (!next?.url || !next.trackKey) {
      debugLog('[Gapless] 下一首歌曲信息不完整')
      return
    }
    
    setTransitionState('preparing-next', { transitioning: false, fallbackReason: undefined, transitionStartTime: null })
    
    try {
      const result = await gaplessIntegrationRef.current.prepareTransition({
        token: Date.now(),
        currentIndex: current.index || 0,
        nextIndex: next.index || 1,
        currentSong: {
          key: current.trackKey,
          url: current.url,
          duration: current.duration || 0,
          albumId: current.albumId,
          album: current.albumCover,
        },
        nextSong: {
          key: next.trackKey,
          url: next.url,
          duration: next.duration || 0,
          albumId: next.albumId,
          album: next.albumCover,
        },
      })
      
      if (result.success) {
        debugLog(`[Gapless] 过渡准备成功，模式: ${result.mode}`)
        setTransitionState('armed', {
          transitionStrategy: 'gapless',
          fallbackReason: undefined,
          transitioning: false,
          transitionStartTime: Math.max(0, (current.duration || 0) - (result.mode === 'album-gapless' ? 1.8 : 0)),
        })
      } else {
        debugLog('[Gapless] 当前歌曲不使用专辑融合，使用普通 gapless')
        setTransitionState('armed', {
          transitionStrategy: 'gapless',
          fallbackReason: undefined,
          transitioning: false,
          transitionStartTime: current.duration || null,
        })
      }
    } catch (error) {
      console.error('[Gapless] 准备过渡失败:', error)
      setTransitionState('armed', {
        transitionStrategy: 'gapless',
        fallbackReason: error instanceof Error ? error.message : 'preparation failed',
        transitioning: false,
        transitionStartTime: current.duration || null,
      })
    }
  }, [setTransitionState])

  useEffect(() => {
    const primary = new Audio()
    const secondary = new Audio()
    for (const audio of [primary, secondary]) {
      audio.crossOrigin = 'anonymous'
      audio.preload = 'auto'
      audio.volume = 0
    }
    primary.volume = volumeRef.current
    primaryRef.current = primary
    secondaryRef.current = secondary
    setAudioElement(primary)
    
    // 初始化 Gapless Integration
    gaplessIntegrationRef.current = new GaplessIntegration({
      enabled: gaplessSettings.enabled,
      albumGaplessEnabled: gaplessSettings.albumGapless,
      getCurrentAudio: getActiveAudio,
      getCurrentTime: () => getActiveAudio()?.currentTime || 0,
      getCurrentIndex: () => currentMetadataRef.current?.index || 0,
      getCurrentTrackKey: () => currentMetadataRef.current?.trackKey || '',
      getTargetVolume: () => volumeRef.current,
      setOutputGain: (gain) => {
        if (masterGainRef.current) {
          masterGainRef.current.gain.value = gain
        }
      },
      getOutputGain: () => masterGainRef.current?.gain.value || volumeRef.current,
      getPlayQueue: () => {
        const current = currentMetadataRef.current
        const next = nextMetadataRef.current
        const queue: DeckMetadata[] = []
        if (current && Number.isInteger(current.index) && current.index! >= 0) queue[current.index!] = current
        if (next && Number.isInteger(next.index) && next.index! >= 0) queue[next.index!] = next
        return queue
      },
      canAdvance: (index) => {
        const current = currentMetadataRef.current
        const next = nextMetadataRef.current
        return Boolean(current && next && current.index === index && next.url && next.trackKey)
      },
      playAt: async (index: number, options: any) => {
        // 调用外部传入的 playAt 回调
        if (playAtCallbackRef.current) {
          return await playAtCallbackRef.current(index, options)
        }
        return false
      },
      // albumGapless handoff 被拒/失败后的看门狗出口：deadline 只在 startTransition 设置，
      // albumGapless 路径不经它 → 无人设 deadline，handleTimeUpdate 又在过渡态直接 return，
      // 表现为静音 + 歌词/进度冻结。失败时把 deadline 拨到"现在"，看门狗下一拍立即收尾。
      onStuckDeadline: (deadline: number | null) => {
        transitionStuckDeadlineRef.current = deadline
      },
      prepareAudioUrl: async (song) => {
        try {
          const prepared = await window.electron?.audioDownload?.prepare?.(song.url, song.key, { expectedDuration: song.duration })
          if (!prepared) return song.url
          return await window.electron?.audioDownload?.getMediaUrl?.(prepared) || song.url
        } catch {
          return song.url
        }
      },
      onStateChange: state => {
        const { transitionState, ...extra } = state
        if (transitionState) setTransitionState(transitionState, extra)
        else emit(extra)
      },
      // 专辑融合确定性裁剪：复用 AutoMix 分析缓存的首尾静音边界（无缓存时 albumGapless 维持探测路径）
      getTrackAnalysis: key => autoMixAnalysisService.peekSilenceBounds(key),
    })

    // 首选预热/边界调度/ended 拼接逻辑已抽离到 src/services/gapless/seamlessJoinController.ts
    // （createSeamlessJoinController），本 effect 只负责创建控制器并接线。
    seamlessJoinControllerRef.current = createSeamlessJoinController({
      getActiveAudio,
      getStandbyAudio,
      getStandbyGain,
      setDeckGain,
      // 与 handleTimeUpdate 的分流保持一致：专辑 + AutoMix 也算"走 gapless 边界"，
      // 否则控制器的 warmup/scheduleBoundary/onEnded 三处门控全为 false（专辑场景彻底没有过渡）。
      isGaplessEnabled: () => resolveBoundaryStrategy() === 'gapless',
      isTransitionRunning: () => transitionStateRef.current === 'running-transition',
      hasActiveTransition: () => Boolean(gaplessIntegrationRef.current?.hasActiveTransition()),
      getRevision: () => transitionExecutionRevisionRef.current,
      commitTransition,
      startGaplessTransition: () => void startTransition('gapless'),
      resetGaplessIntegration: () => gaplessIntegrationRef.current?.reset(),
      setTransitionState: (state, extra) => setTransitionState(state, (extra ?? {}) as never),
      setBoundaryTimer: (timer) => { transitionTimerRef.current = timer },
      getBoundaryTimer: () => transitionTimerRef.current,
    })

    const handleTimeUpdate = (event: Event) => {
      const active = getActiveAudio()
      if (event.currentTarget !== active || !active) return
      const remaining = (active.duration || 0) - active.currentTime
      const standby = getStandbyAudio()
      const plan = transitionPlanRef.current
      // 专辑播放检测（三方案分流依据）——同专辑时即使 AutoMix 启用也优先走首尾拼接，
      // AutoMix 过渡（timeupdate 触发与预分析）只接管非专辑场景。
      // 分流必须用 resolveBoundaryStrategy（专辑 + AutoMix → gapless），否则专辑场景两条分支都不命中。
      const albumPlayback = isAlbumPlayback()
      const pairStrategy = resolveBoundaryStrategy()
      const applePair = Boolean(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)
      if (standby?.src && transitionStateRef.current !== 'running-transition') {
        if (pairStrategy === 'automix' && !albumPlayback && plan && (transitionStateRef.current === 'armed' || transitionStateRef.current === 'playing')) {
          if (active.currentTime >= plan.sourceStartTime) {
            debugLog('🎬 [AutoMix] 到达过渡点！')
            debugLog('   当前时间:', active.currentTime.toFixed(2), 's')
            debugLog('   过渡开始时间:', plan.sourceStartTime.toFixed(2), 's')
            debugLog('   过渡策略:', plan.strategy)
            debugLog('   过渡状态:', transitionStateRef.current)
            void startTransition(plan.strategy, plan)
          }
        } else if (pairStrategy === 'fixed-crossfade' && remaining <= Math.max(0.25, crossfadeRef.current.duration)) {
          debugLog('🎬 [Crossfade] 到达交叉淡化点，剩余时间:', remaining.toFixed(2), 's')
          void startTransition('fixed-crossfade')
        } else if (pairStrategy === 'gapless' && Number.isFinite(remaining)) {
          // 无缝衔接边界分流（独立于 AutoMix 的智能功能）：
          //   · 同专辑 → 「直接拼接」三方案（预热 → scheduleBoundary，头尾不掐），
          //     专辑连续性是 gapless 的本义，交叉淡化会破坏乐章边界；
          //   · 跨专辑 → **智能短交叉**：prepareGaplessCrossfade 用与 AutoMix 同一套
          //     分析/规划机制算出 1.5–4s 窗口（节拍对齐 + 首尾静音裁剪 + 相似度打分），
          //     到达窗口起点执行 beat-crossfade；计划不可用时兜底 2.5s 短窗。
          // 节点「关闭」= 本曲不做无缝衔接：不预热/不交叉，源曲完整播完后自然切歌。
          const skippedPair = autoMixSkippedPairsRef.current.has(
            `${currentMetadataRef.current?.trackKey}->${nextMetadataRef.current?.trackKey}`
          )
          if (!skippedPair) {
            const albumDirectJoin = albumPlayback && !applePair
            const controller = seamlessJoinControllerRef.current
            if (albumDirectJoin) {
              if (controller) {
                // 尾静音裁剪：平台文件普遍烧死几秒尾部静音，拼接/交叉点提前到
                // 有声内容结束处（outroSilence，上限 5s 防异常分析值吃掉整曲尾段）；
                // joinOffset = 下一首 introSilence（上限 2s，与 automix gapless 同口径）。
                // 两个字段来自**不同歌**的分析：outroSilence 查源曲、introSilence 查下一首
                const sourceSilence = autoMixAnalysisService.peekSilenceBounds(currentMetadataRef.current?.trackKey || '')
                const nextSilence = autoMixAnalysisService.peekSilenceBounds(nextMetadataRef.current?.trackKey || '')
                const outroSilence = sourceSilence ? Math.max(0, Math.min(5, sourceSilence.outroSilence || 0)) : 0
                const joinOffset = nextSilence ? Math.max(0, Math.min(2, nextSilence.introSilence || 0)) : 0
                const audibleRemaining = Math.max(0, remaining - outroSilence)
                if (audibleRemaining > 1 && remaining <= GAPLESS_SEAMLESS_WARMUP_SECONDS) {
                  controller.warmup()
                } else if (audibleRemaining > 0 && audibleRemaining <= 1) {
                  controller.scheduleBoundary({ active, remaining: audibleRemaining, albumPlayback: true, joinOffset })
                }
                // 提前 ended：烧死的尾静音不值得等——有声内容已结束（remaining ≤ outroSilence）
                // 且首选已武装时，直接执行拼接（ended 事件将来还会来，但 armed 已被消费，
                // onEnded 返回 false 落到普通分支也只是重复停一个已停的 deck）。
                // onEnded false（armed 未置位：seek 直落尾静音区会清掉边界调度）→
                // 立即补武装一次：scheduleBoundary remaining=0，首选分支下一拍拼接、
                // 备选分支 timer 立即过渡——否则该曲边白等最长 5s 尾静音 + 不跳 intro。
                if (outroSilence > 0.05 && audibleRemaining <= 0) {
                  const standbyAudio = getStandbyAudio()
                  if (controller.onEnded(standbyAudio, joinOffset)) {
                    debugLog(`⚡ [Gapless] 有声内容结束（尾静音 ${outroSilence.toFixed(2)}s 不播），提前拼接`)
                    return
                  }
                  if (!standbyAudio?.paused && standbyAudio?.src) {
                    controller.scheduleBoundary({ active, remaining: 0, albumPlayback: true, joinOffset })
                  }
                }
              }
            } else {
              // 跨专辑：无缝衔接的「智能短交叉」——
              // 首选已准备的计划（分析+规划算出的 1.5–4s 窗口：节拍对齐、尾部静音裁剪、
              // 交叉位置与前后取量均来自分析结果）；播放到窗口起点即执行 beat-crossfade。
              const gaplessPlan = gaplessPlanRef.current
              if (gaplessPlan && active.currentTime >= gaplessPlan.sourceStartTime) {
                debugLog(`🎬 [Gapless] 到达智能交叉窗口（${(gaplessPlan.sourceEndTime - gaplessPlan.sourceStartTime).toFixed(2)}s @ ${gaplessPlan.sourceStartTime.toFixed(2)}s）`)
                logAutomixBackend(
                  'gapless:crossfade-trigger',
                  `${currentMetadataRef.current?.trackKey}->${nextMetadataRef.current?.trackKey} at=${active.currentTime.toFixed(2)} start=${gaplessPlan.sourceStartTime.toFixed(2)} dur=${(gaplessPlan.sourceEndTime - gaplessPlan.sourceStartTime).toFixed(2)} targetStart=${gaplessPlan.targetStartTime.toFixed(2)}`,
                )
                gaplessPlanRef.current = null
                void startTransition('beat-crossfade', gaplessPlan)
              } else if (!gaplessPlan) {
                // 兜底：分析不可用/计划未就绪——2.5s 短窗，同样锚定原始曲末（末尾空白处交叉），
                // 以计划对象走同一执行链路（同样豁免「按交叉设置收拢」的降级）
                const fallbackDuration = 2.5
                if (remaining <= fallbackDuration + 0.5) {
                  const end = Math.max(fallbackDuration, active.duration || 0)
                  const fallbackPlan = buildFallbackCrossfadePlanFor(
                    currentMetadataRef.current || {}, nextMetadataRef.current || {}, end, '无缝衔接兜底（分析不可用）',
                  )
                  fallbackPlan.sourceStartTime = Math.max(0, end - fallbackDuration)
                  fallbackPlan.sourceEndTime = end
                  fallbackPlan.targetStartTime = 0
                  fallbackPlan.targetEndTime = fallbackDuration
                  fallbackPlan.id = `gapless:${fallbackPlan.id}`
                  gaplessPlanRef.current = fallbackPlan
                  debugLog(`🎬 [Gapless] 智能计划缺省 → 兜底 ${fallbackDuration}s 短交叉（锚定曲末）`)
                  logAutomixBackend(
                    'gapless:crossfade-trigger',
                    `${currentMetadataRef.current?.trackKey}->${nextMetadataRef.current?.trackKey} fallback at=${active.currentTime.toFixed(2)} start=${fallbackPlan.sourceStartTime.toFixed(2)} end=${fallbackPlan.sourceEndTime.toFixed(2)} dur=${fallbackDuration}`,
                  )
                }
              }
            }
          }
        }
      }
      let buffered = 0
      if (active.buffered.length) buffered = active.buffered.end(active.buffered.length - 1)
      // 过渡期间（running-transition）：源曲 deck 静音但继续播放，其 timeupdate 位置
      // 与 rAF 合成时间（过渡缓冲驱动）是两个来源，交替 emit 会让进度/倒计时数字
      // 来回抽动（如 2:35→2:36 时 565 闪）。过渡时间线统一由 rAF 合成时间驱动。
      if (transitionStateRef.current === 'running-transition') {
        return
      }
      // 量化播放时间到 ~250ms，避免高频 timeupdate 触发多个大组件重渲染；
      // 进度条/歌词内部已有各自的平滑插值，视觉无变化。
      // 游戏模式冻结（主窗隐藏到托盘）：量化到 1s——反正没人看得见，把大组件重渲染
      // 从 4Hz 降到 1Hz，与歌词岛/任务栏的 1Hz 兜底推送同一节奏。
      const timeStep = isGameModeFrozen() ? 1 : 0.25
      const quantizedTime = Math.round(active.currentTime / timeStep) * timeStep
      emit({ currentTime: quantizedTime, duration: finiteDuration(active.duration), buffered, live: isLiveRef.current })
    }

    const handlePlay = (event: Event) => {
      if (event.currentTarget !== getActiveAudio()) return
      if (trackStemDesiredRef.current && trackStemMixerRef.current && !trackStemMixerRef.current.getSnapshot().playing && !trackStemResumePendingRef.current) {
        const active = getActiveAudio()
        if (active) {
          const pending = trackStemMixerRef.current.play(active.currentTime)
          trackStemResumePendingRef.current = pending
          void pending.catch(() => {
            trackStemMixerRef.current?.returnToOriginal()
            setDeckGain(getActiveGain(), active, 1)
            setTrackStemControl(current => ({ ...current, active: false, status: 'failed', reason: '恢复分轨播放失败' }))
          }).finally(() => {
            if (trackStemResumePendingRef.current === pending) trackStemResumePendingRef.current = null
          })
        }
      }
      emit({ isPlaying: true, ended: false })
    }
    const handlePause = (event: Event) => {
      if (
        event.currentTarget === getActiveAudio()
        && transitionStateRef.current !== 'committed'
        && transitionStateRef.current !== 'running-transition'
      ) {
        const active = getActiveAudio()
        if (trackStemControlRef.current.active && trackStemMixerRef.current) {
          trackStemMixerRef.current.pause()
          setDeckGain(getActiveGain(), active, 1)
        }
        emit({
          isPlaying: false,
          currentTime: active?.currentTime || 0,
          duration: finiteDuration(active?.duration),
        })
      }
    }
    const handleTransportInterruption = (event: Event) => {
      if (event.currentTarget !== getActiveAudio() || !trackStemDesiredRef.current || !trackStemMixerRef.current) return
      const active = getActiveAudio()
      trackStemMixerRef.current.pause()
      setDeckGain(getActiveGain(), active, 1)
      setTrackStemControl(current => ({ ...current, active: false, status: 'partial', reason: '音频缓冲中，已临时恢复原声' }))
    }
    const handleRateChange = (event: Event) => {
      const active = getActiveAudio()
      if (event.currentTarget !== active || !active || !trackStemMixerRef.current) return
      // 回到原速时自动把分轨接回来（若用户此前开着分轨）：否则倍速过一次歌
      // 分轨就永久失效，表现为"时好时坏"。desired 会被下方变速分支清成 false，
      // 所以恢复判定用 userWanted（用户主动开启过的标记）而不是 desired。
      if (Math.abs(active.playbackRate - 1) < 0.001) {
        if (trackStemUserWantedRef.current) {
          trackStemDesiredRef.current = true
          if (!trackStemControlRef.current.active && transitionStateRef.current !== 'running-transition') {
            const mixer = trackStemMixerRef.current
            void mixer.play(active.currentTime).then(ready => {
              if (ready && trackStemDesiredRef.current) setTrackStemControl(current => ({ ...current, active: true, status: 'partial', reason: undefined }))
            }).catch(() => undefined)
          }
        }
        return
      }
      trackStemDesiredRef.current = false
      // 变速时同时停掉分轨预载泵：泵的循环体只按 generation/desired 门控激活，
      // prepareWindow 照跑——倍速播放期间后台每 3s 白做一轮 HTDemucs 窗口解码。
      if (trackStemPumpTimerRef.current !== null) {
        window.clearInterval(trackStemPumpTimerRef.current)
        trackStemPumpTimerRef.current = null
      }
      trackStemMixerRef.current.returnToOriginal()
      setDeckGain(getActiveGain(), active, 1)
      setTrackStemControl(current => ({ ...current, active: false, status: 'unavailable', reason: '变速播放期间暂不支持分轨调节' }))
    }
    const handleMetadata = (event: Event) => {
      if (event.currentTarget === getActiveAudio()) emit({ duration: finiteDuration(getActiveAudio()?.duration), live: isLiveRef.current })
    }
    const handleEnded = (event: Event) => {
      debugLog('🏁 [Event] handleEnded 被触发')
      debugLog('   当前加载状态:', isLoadingRef.current)
      debugLog('   事件目标是活动音频?', event.currentTarget === getActiveAudio())
      
      if (isLoadingRef.current || event.currentTarget !== getActiveAudio()) return
      resetTrackStemMixer('idle')

      // 首选：已武装的 managed 双 deck（含 Apple CENC standby）在边界接管；
      // 若 Apple standby 未就绪/失败，则落到末尾的 ended=true，由 App 走完整加载回退链。
      // 过渡缓冲播放期间（AI 长混音等），源曲 deck 保持播放以驱动 UI 时间线，
      // 会先于缓冲自然播完触发 ended——此时不能提前提交（缓冲仍是权威音频源），
      // 由缓冲 ended → handoff 精确接管。
      if (transitionBufferActiveRef.current || handoffPendingCountRef.current > 0) {
        debugLog('⏸️ [Event] 过渡缓冲仍在播放（或 handoff 在途），忽略源曲 ended（由 handoff 接管）')
        return
      }

      // A timer normally performs the boundary handoff. If `ended` wins the race, cancel the
      // timer and execute immediately so a delayed callback cannot start the same deck twice.
      // （边界 timer 与竞态互斥由 seamlessJoinController 管理）
      seamlessJoinControllerRef.current?.cancelBoundaryTimer()

      // 看歌挂起：切歌类提交（首选拼接/ended 兜底提交）一律冻结——看歌进入时已
      // cancelScheduledTransition，但 ended 与取消存在同拍竞态，onEnded 首选拼接
      // 内部会自己 standby.play() 把下一首放出声（绕过 startTransition 的 watchHold
      // 拦截）。挂起期间不提交：保留 ended 语义交给退出看歌后的重武装链收尾。
      if (watchHoldRef.current) {
        debugLog('⏸ [Event] 看歌挂起：忽略源曲 ended（退出看歌后由重武装链接管）')
        return
      }

      const standby = getStandbyAudio()
      debugLog('🔍 [Event] 检查过渡状态:', transitionStateRef.current)
      debugLog('   待机音频:', standby ? '存在' : '不存在')
      debugLog('   待机音频暂停?', standby?.paused)
      debugLog('   待机音频 src:', standby?.src || '无')

      // ── 首选：无缝拼接（源曲尾静音不播，standby 跳过烧死的前静音）──
      // source 已播到 ended。standby 可能处于三种就绪形态：PREROLL 静音预启动中、
      // 预热完成后暂停回拨 joinOffset、或已缓冲暂停。控制器统一"确保 standby 从
      // joinOffset（下一首 introSilence，无分析缓存时 0）播放"：未在播则启动，
      // seek 后瞬时切换增益——不做任何淡入淡出、不掐 source 有声尾部。
      // joinOffset 查的是**下一首**的 introSilence（源曲的是 outroSilence，别混）
      const nextSilenceForJoin = autoMixAnalysisService.peekSilenceBounds(nextMetadataRef.current?.trackKey || '')
      const joinOffset = nextSilenceForJoin ? Math.max(0, Math.min(2, nextSilenceForJoin.introSilence || 0)) : 0
      if (seamlessJoinControllerRef.current?.onEnded(standby, joinOffset)) return

      if (transitionStateRef.current === 'running-transition' && standby && !standby.paused) {
        debugLog('✅ [Event] 过渡正在进行中，提交过渡')
        // 策略优先取正在跑的那一次过渡的真实策略（transitionStrategyRef 在 startTransition 写入）；
        // 旧的启发式猜测会把「无缝衔接触发的交叉淡化」误标成 gapless（提交日志/覆盖率提示错名）。
        const strategy = transitionStrategyRef.current
          || transitionPlanRef.current?.strategy
          || (crossfadeRef.current.enabled ? 'fixed-crossfade' : 'gapless')
        commitTransition(strategy, standby.currentTime, transitionExecutionRevisionRef.current)
      } else if (standby?.src && resolveBoundaryStrategy() === 'gapless') {
        debugLog('⏭️ [Event] 待机音频就绪且当前相邻边使用 Gapless')
        const applePair = Boolean(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)
        if (gaplessIntegrationRef.current && !applePair) {
          // 使用 Cuefield/Album Gapless 执行过渡
          const result = gaplessIntegrationRef.current.executeTransition()
          if (result.success) {
            debugLog(`[Gapless] 使用 ${result.mode} 模式执行过渡`)
            // 如果成功执行了无缝，这里不要再调用 startTransition，避免双音轨同时播放
          } else {
            debugLog('[Gapless] 使用简单模式执行过渡')
            void startTransition('gapless')
          }
        } else {
          void startTransition('gapless')
        }
      } else {
        debugLog('⏸️ [Event] 无过渡计划，歌曲结束')
        setTransitionState('idle', { isPlaying: false, ended: true, seamlessTransition: false, transitioning: false })
      }
    }
    const handleError = (event: Event) => {
      if (event.currentTarget === getActiveAudio()) {
        setTransitionState('failed', { isPlaying: false, fallbackReason: getActiveAudio()?.error?.message || 'media decode failed' })
        // 通知上层（App 显示 toast / 触发重取 URL），普通歌曲播放失败不再无声无息
        try {
          window.dispatchEvent(new CustomEvent('waveforge:playback-media-error', {
            detail: { message: getActiveAudio()?.error?.message || 'media decode failed', src: getActiveAudio()?.currentSrc || '' },
          }))
        } catch { /* ignore */ }
      }
    }

    for (const audio of [primary, secondary]) {
      audio.addEventListener('timeupdate', handleTimeUpdate)
      audio.addEventListener('play', handlePlay)
      audio.addEventListener('playing', handlePlay)
      audio.addEventListener('pause', handlePause)
      audio.addEventListener('waiting', handleTransportInterruption)
      audio.addEventListener('stalled', handleTransportInterruption)
      audio.addEventListener('seeking', handleTransportInterruption)
      audio.addEventListener('ratechange', handleRateChange)
      audio.addEventListener('loadedmetadata', handleMetadata)
      audio.addEventListener('ended', handleEnded)
      audio.addEventListener('error', handleError)
    }

    return () => {
      preparationAbortRef.current?.abort()
      cancelScheduledTransition('audio player unmounted', false, false)
      // 卸载时销毁可能挂载的 Apple HLS 实例，释放 MSE 与 EME 会话
      detachAppleHls(primary)
      detachAppleHls(secondary)
      if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
      if (visualSwitchTimerRef.current !== null) window.clearTimeout(visualSwitchTimerRef.current)
      preloadReadyCleanupRef.current?.()
      preloadReadyCleanupRef.current = null
      currentLoadRevisionRef.current += 1
      currentLoadWaitCancelRef.current?.()
      currentLoadWaitCancelRef.current = null
      seamlessJoinControllerRef.current?.reset()
      if (fallbackAnimationRef.current !== null) cancelAnimationFrame(fallbackAnimationRef.current)
      if (transitionProgressAnimationRef.current !== null) cancelAnimationFrame(transitionProgressAnimationRef.current)
      transitionProgressAnimationRef.current = null
      if (externalHandoffFadeFrameRef.current !== null) {
        cancelAnimationFrame(externalHandoffFadeFrameRef.current)
        externalHandoffFadeFrameRef.current = null
      }
      transitionStartTimeRef.current = null
      if (retiredDeckCleanupTimerRef.current !== null) window.clearTimeout(retiredDeckCleanupTimerRef.current)
      retiredDeckCleanupTimerRef.current = null
      transitionRendererRef.current?.dispose()
      transitionRendererRef.current = null
      if (trackStemPumpTimerRef.current !== null) window.clearInterval(trackStemPumpTimerRef.current)
      trackStemPumpTimerRef.current = null
      trackStemMixerRef.current?.dispose()
      trackStemMixerRef.current = null
      gaplessIntegrationRef.current?.dispose()
      gaplessIntegrationRef.current = null
      for (const audio of [primary, secondary]) {
        audio.removeEventListener('timeupdate', handleTimeUpdate)
        audio.removeEventListener('play', handlePlay)
        audio.removeEventListener('playing', handlePlay)
        audio.removeEventListener('pause', handlePause)
        audio.removeEventListener('waiting', handleTransportInterruption)
        audio.removeEventListener('stalled', handleTransportInterruption)
        audio.removeEventListener('seeking', handleTransportInterruption)
        audio.removeEventListener('ratechange', handleRateChange)
        audio.removeEventListener('loadedmetadata', handleMetadata)
        audio.removeEventListener('ended', handleEnded)
        audio.removeEventListener('error', handleError)
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
      void audioContextRef.current?.close()
      audioContextRef.current = null
      analyserNodeRef.current = null
      leftAnalyserNodeRef.current = null
      rightAnalyserNodeRef.current = null
      gainNodesRef.current = [null, null]
      mediaSourcesRef.current = [null, null]
      masterGainRef.current = null
    }
  }, [commitTransition, emit, getActiveAudio, getActiveGain, getStandbyAudio, resetTrackStemMixer, resolveBoundaryStrategy, setDeckGain, setTransitionState, startTransition, finiteDuration])

  useEffect(() => {
    if (gaplessIntegrationRef.current) {
      gaplessIntegrationRef.current.updateSettings({
        enabled: gaplessSettings.enabled,
        albumGapless: gaplessSettings.albumGapless,
      })
    }
  }, [gaplessSettings.enabled, gaplessSettings.albumGapless])

  useEffect(() => {
    if (!nextMetadataRef.current?.url) return
    // 过渡进行中改设置：延后重排，不要当场 cancel（否则源曲增益被写回 1、缓冲被停，
    // 听感是"淡出到一半突然弹回原曲满音量"，随后边界处还会再来第二次过渡）。
    if (transitionStateRef.current === 'running-transition') {
      pendingReprepareRef.current = true
      debugLog('⏸ [AutoMix] 过渡进行中：设置变更延后到本次过渡结束后重排')
      return
    }
    cancelScheduledTransition('transition settings changed')
    const strategy = resolveBoundaryStrategy()
    if (strategy === 'automix') {
      void prepareAutoMix()
      return
    }
    if (strategy === 'gapless' && !(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)) {
      void prepareGaplessTransition()
      return
    }
    setTransitionState('armed', {
      transitioning: false,
      fallbackReason: strategy === 'gapless' && autoMixSettings.enabled ? 'Apple CENC pair uses gapless' : undefined,
      transitionStrategy: strategy,
    })
  }, [
    autoMixSettings.enabled,
    autoMixSettings.enableBeatMatching,
    autoMixSettings.skipSilence,
    autoMixSettings.minDuration,
    autoMixSettings.maxDuration,
    autoMixSettings.enhanced,
    autoMixSettings.intensity,
    autoMixSettings.aiMix,
    // 引擎 / Enhanced 档位必须进依赖：否则运行中切换后当前相邻边仍按旧引擎出音
    autoMixSettings.engine,
    autoMixSettings.enhancedTier,
    crossfadeSettings.enabled,
    crossfadeSettings.duration,
    gaplessSettings.enabled,
    gaplessSettings.albumGapless,
    cancelScheduledTransition,
    prepareAutoMix,
    prepareGaplessTransition,
    resolveBoundaryStrategy,
    setTransitionState,
  ])

  const preloadNext = useCallback((input: string | PreloadTrack) => {
    const track = asPreloadTrack(input)
    debugLog('📥 [Preload] preloadNext 被调用')
    debugLog('   下一首歌曲:', track)
    const standby = getStandbyAudio()
    if (!standby || !track.url) {
      debugLog('❌ [Preload] 缺少待机音频元素或 URL')
      releaseAppleNativeStream(track.appleHls)
      return
    }
    const appleHls = track.appleHls
    const hlsPreload = Boolean(appleHls) && isHlsUrl(track.url) && !appleHls?.live
    if (isHlsUrl(track.url) && !hlsPreload) {
      debugLog('🛑 [Preload] 非预载型 HLS 音源跳过待机预载')
      releaseAppleNativeStream(appleHls)
      return
    }
    const existingNext = nextMetadataRef.current
    const sameTrackAlreadyAttached = Boolean(
      existingNext
      && existingNext.url === track.url
      && existingNext.trackKey === track.trackKey
      && existingNext.index === track.index
      && (hlsPreload
        ? getActiveAppleStream(standby) === appleHls
        : Boolean((standby.currentSrc || standby.getAttribute('src'))
          && standby.networkState !== HTMLMediaElement.NETWORK_EMPTY
          && !standby.error))
    )
    if (sameTrackAlreadyAttached) {
      // Queue-related effects can run more than once for the same next track. Keep the
      // existing media pipeline and any in-flight canplay/AutoMix preparation intact.
      // 复用前兜底归位变速（防 canceled overlap 残留 playbackRate≠1）
      if (standby.playbackRate !== 1) {
        standby.playbackRate = 1
        if ('preservePitch' in standby) standby.preservePitch = true
      }
      nextMetadataRef.current = { ...existingNext, ...track }
      // 复用分支同样要保证 standby 处于"静音待命"：过渡/交接被中断后它可能停在满增益播放，
      // 若不复位，异常状态会被这次复用固化（下一首在后台出声、UI 与音频不一致）。
      if (transitionStateRef.current !== 'running-transition' && handoffPendingCountRef.current === 0 && !standby.paused) {
        debugLog('♻️ [Preload] 复用分支发现待在播的 standby：复位为静音待命')
        standby.pause()
        standby.currentTime = 0
        setDeckGain(getStandbyGain(), standby, 0)
      }
      debugLog('♻️ [Preload] 下一首未变化，复用现有待机媒体管线')
      return
    }

    cancelScheduledTransition('next track changed', true)
    const previousStream = nextMetadataRef.current?.appleHls
    const attachedPreviousStream = getActiveAppleStream(standby)
    detachAppleHls(standby)
    if (previousStream && previousStream !== attachedPreviousStream) releaseAppleNativeStream(previousStream)
    nextMetadataRef.current = { ...track }
    standby.pause()
    standby.currentTime = 0
    standby.playbackRate = 1 // post-settle 残留防护：新歌一律原速
    setDeckGain(getStandbyGain(), standby, 0)
    debugLog('⏳ [Preload] 开始加载下一首歌曲...')
    setTransitionState('preparing-next', { transitioning: false, transitionStartTime: null })
    const preloadMetadataMatches = () => Boolean(
      nextMetadataRef.current?.url === track.url
      && nextMetadataRef.current?.trackKey === track.trackKey
      && nextMetadataRef.current?.index === track.index
    )
    const isCurrentPreload = () => Boolean(
      preloadMetadataMatches()
      && (!hlsPreload || getActiveAppleStream(standby) === appleHls)
    )
    let timeoutId = 0
    const cleanupReady = () => {
      standby.removeEventListener('canplay', ready)
      standby.removeEventListener('error', failed)
      if (timeoutId) window.clearTimeout(timeoutId)
    }
    const ready = () => {
      cleanupReady()
      if (preloadReadyCleanupRef.current === cleanupReady) preloadReadyCleanupRef.current = null
      if (!isCurrentPreload()) return
      track.onPreloadSettled?.(true)
      debugLog('🎵 [Preload] 预加载歌曲就绪')
      const pairStrategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
        autoMix: autoMixRef.current.enabled,
        crossfade: crossfadeRef.current.enabled,
        gapless: gaplessRef.current.enabled,
      })
      if (pairStrategy === 'automix') {
        if (!isAlbumPlayback()) {
          debugLog('🎵 [Preload] AutoMix 已启用，调用 prepareAutoMix()')
          void prepareAutoMix()
        } else {
          debugLog('🎵 [Preload] 同专辑 + AutoMix：走首尾拼接无缝方案')
          setTransitionState('armed', { transitionStrategy: 'gapless' })
        }
      } else if (pairStrategy === 'gapless') {
        if (currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls) {
          debugLog('🍎 [Preload] Apple 相邻边已武装 managed Gapless')
          setTransitionState('armed', {
            transitionStrategy: 'gapless',
            fallbackReason: autoMixRef.current.enabled ? 'Apple CENC pair uses gapless' : undefined,
          })
        } else if (isAlbumPlayback() && gaplessIntegrationRef.current) {
          // 同专辑：控制器的「直接拼接」三方案（预热 → scheduleBoundary）
          debugLog('🎵 [Preload] 准备无缝衔接，调用 GaplessIntegration')
          void prepareGaplessTransition()
        } else {
          // 跨专辑：无缝衔接的智能短交叉（分析与规划，独立于 AutoMix）
          debugLog('🎵 [Preload] 准备无缝衔接（智能短交叉）')
          void prepareGaplessCrossfadeRef.current()
        }
      } else {
        setTransitionState('armed', { transitionStrategy: pairStrategy })
      }
    }
    const failed = () => {
      cleanupReady()
      if (preloadReadyCleanupRef.current === cleanupReady) preloadReadyCleanupRef.current = null
      if (!preloadMetadataMatches()) return
      track.onPreloadSettled?.(false)
      console.warn('[Preload] Next track media failed to load or timed out; normal end-of-track loading will be used')
      const failedStream = nextMetadataRef.current?.appleHls
      cancelScheduledTransition('next Apple HLS failed', false, false)
      releaseAppleNativeStream(failedStream)
      const active = getActiveAudio()
      setDeckGain(getActiveGain(), active, 1)
      setTransitionState(active?.src ? 'playing' : 'idle', {
        transitioning: false,
        transitionStartTime: null,
        fallbackReason: 'next track preload failed',
      })
    }
    preloadReadyCleanupRef.current?.()
    preloadReadyCleanupRef.current = cleanupReady
    if (hlsPreload) {
      void attachAppleHls(standby, appleHls!, () => {
        if (!preloadMetadataMatches()) return
        failed()
      }).then(ready, failed)
    } else {
      standby.src = track.appleHls ? track.url : getProxiedAudioUrl(track.url)
      standby.preload = 'auto'
      standby.addEventListener('canplay', ready, { once: true })
      standby.addEventListener('error', failed, { once: true })
      timeoutId = window.setTimeout(failed, PRELOAD_MEDIA_LOAD_TIMEOUT_MS)
      standby.load()
    }
  }, [cancelScheduledTransition, getActiveAudio, getStandbyAudio, getStandbyGain, prepareAutoMix, prepareGaplessTransition, setDeckGain, setTransitionState])

  const loadAndPlay = useCallback(async (
    url: string,
    startVolume = DEFAULT_VOLUME,
    track?: Omit<PreloadTrack, 'url'>
  ) => {
    debugLog('🎵 [LoadAndPlay] loadAndPlay 被调用')
    debugLog('   URL:', url)
    debugLog('   音量:', startVolume)
    debugLog('   歌曲信息:', track)
    const loadRevision = ++currentLoadRevisionRef.current
    currentLoadWaitCancelRef.current?.()
    currentLoadWaitCancelRef.current = null
    resetTrackStemMixer('idle')
    
    const active = getActiveAudio()
    const standby = getStandbyAudio()
    if (!active) throw new Error('Audio deck is not initialized')
    isLoadingRef.current = true
    cancelScheduledTransition('new current track loaded', false)
    setTransitionState('loading-current', { currentTime: 0, duration: 0, ended: false, transitioning: false, transitionStartTime: null })
    volumeRef.current = Math.max(0, Math.min(1, startVolume))
    try {
      // 停止所有音频
      if (standby && !standby.paused) {
        debugLog('⏸️ [LoadAndPlay] 停止 standby 音频')
        standby.pause()
        standby.currentTime = 0
      }
      standby?.pause()
      active.pause()
      active.currentTime = 0
      // 先显式卸载旧资源。仅覆盖 src 会让 Chromium 的旧媒体管线等待 GC，
      // 快速切歌时会形成明显的阶梯式内存增长。
      detachAppleHls(active) // 若上一首是 Apple HLS，先销毁其 MSE 管线
      active.removeAttribute('src')
      active.load()
      // 重置 GaplessIntegration，停止所有预加载的音频
      if (gaplessIntegrationRef.current) {
        debugLog('🧹 [LoadAndPlay] 重置 GaplessIntegration')
        gaplessIntegrationRef.current.reset()
      }
      const appleHls = (track as { appleHls?: import('../services/applePlayback').AppleNativeStream } | undefined)?.appleHls
      const hlsMode = Boolean(appleHls) && isHlsUrl(url)
      // 直播流（Apple 电台）：HLS 时长为 Infinity（liveDurationInfinity），
      // 记录到 ref 供 timeupdate/metadata 输出 live 状态与 0 时长（UI 显示直播态）
      isLiveRef.current = Boolean(appleHls?.live)
      active.playbackRate = 1 // post-settle 残留防护：新歌一律原速
      currentMetadataRef.current = { url, ...track }
      setAudioElement(active)
      await ensureAudioGraph()
      if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.setValueAtTime(volumeRef.current, audioContextRef.current.currentTime)
      }
      setDeckGain(getActiveGain(), active, 1)
      setDeckGain(getStandbyGain(), standby, 0)
      if (hlsMode) {
        // Apple Music 原生 HLS（Widevine EME）：hls.js 接管 src 与缓冲，
        // attachAppleHls 自行等待首个分片就绪（含 license 协商），随后照常 play()
        debugLog('📡 [LoadAndPlay] Apple HLS 原生音源，由 hls.js 接管')
        await attachAppleHls(active, appleHls!, error => {
          if (getActiveAudio() !== active || currentMetadataRef.current?.appleHls !== appleHls) return
          console.warn('[AppleHLS] Current stream failed after startup:', error)
          cancelScheduledTransition('current Apple HLS failed', false, false)
          setTransitionState('failed', {
            isPlaying: false,
            ended: true,
            transitioning: false,
            fallbackReason: error.message,
          })
        })
      } else {
        debugLog('⏳ [LoadAndPlay] 加载音频文件...')
        active.src = url
        active.preload = 'auto'
        await new Promise<void>((resolve, reject) => {
          let settled = false
          let timeoutId = 0
          const cleanup = () => {
            active.removeEventListener('canplay', canPlay)
            active.removeEventListener('error', failed)
            if (timeoutId) window.clearTimeout(timeoutId)
            if (currentLoadWaitCancelRef.current === cancelled) currentLoadWaitCancelRef.current = null
          }
          const settle = (callback: () => void) => {
            if (settled) return
            settled = true
            cleanup()
            callback()
          }
          const canPlay = () => settle(resolve)
          // MediaError 不是 Error 实例：直接 reject(active.error) 后 console.error 只会打出
          // `{}`（code/message 在原型上，JSON.stringify 看不到），线上日志因此完全无法判断
          // 是解码失败、格式不支持还是网络中断。这里拍平成带 code 的可读 Error。
          const failed = () => settle(() => {
            const mediaError = active.error
            const code = Number(mediaError?.code ?? 0)
            const codeLabel = code === 1 ? 'ABORTED'
              : code === 2 ? 'NETWORK'
                : code === 3 ? 'DECODE'
                  : code === 4 ? 'SRC_NOT_SUPPORTED'
                    : 'UNKNOWN'
            const src = String(active.currentSrc || active.src || '')
            const error = new Error(
              `media load failed: code=${code}(${codeLabel})`
              + `${mediaError?.message ? ` message=${mediaError.message}` : ''}`
              + ` src=${src.slice(0, 140)}`,
            ) as Error & { mediaCode?: number }
            // 调用方据此决定是否降档重试：code=3/4 说明这份文件本身不可解码，
            // 换一条同档位的新 URL 仍然会失败（实测 flac 换新 vkey 依旧 code=4）。
            error.mediaCode = code
            reject(error)
          })
          const cancelled = () => settle(resolve)
          currentLoadWaitCancelRef.current = cancelled
          active.addEventListener('canplay', canPlay, { once: true })
          active.addEventListener('error', failed, { once: true })
          timeoutId = window.setTimeout(
            () => settle(() => reject(new Error('media load timed out'))),
            CURRENT_MEDIA_LOAD_TIMEOUT_MS,
          )
          active.load()
        })
      }
      if (loadRevision !== currentLoadRevisionRef.current) {
        if (appleHls && getActiveAppleStream(active) === appleHls) detachAppleHls(active)
        return false
      }
      debugLog('▶️ [LoadAndPlay] 开始播放...')
      await active.play()
      if (loadRevision !== currentLoadRevisionRef.current) {
        if (appleHls && getActiveAppleStream(active) === appleHls) detachAppleHls(active)
        return false
      }
      isLoadingRef.current = false
      debugLog('✅ [LoadAndPlay] 播放成功')
      setTransitionState('playing', { isPlaying: true, duration: finiteDuration(active.duration) || track?.duration || 0, ended: false, live: isLiveRef.current })
      // 基础交叉"入"半边（Apple 淡出尾的自然衔接）：上一首 Apple 歌曲带淡出尾结束、
      // 下一首走本地 deck 时，deck 增益从 0 线性渐起到目标音量（EME 下无重叠交叉，顺序淡入淡出）
      if (externalEndedWithFadeRef.current) {
        externalEndedWithFadeRef.current = false
        const fadeDur = externalFadeDuration()
        const context = audioContextRef.current
        const gain = getActiveGain()
        if (fadeDur > 0 && context && gain) {
          const t0 = context.currentTime
          try {
            gain.gain.cancelScheduledValues(t0)
            gain.gain.setValueAtTime(0.0001, t0)
            // 淡入终点必须是 1（deck 相对增益）而不是 volumeRef：masterGain 已承载
            // 全局音量，deck 增益再乘一遍 volumeRef 会把整曲响度压成 volume²
            // （70% 音量实际只有 49%，-6dB）。与上方 setDeckGain(..., 1) 同口径。
            gain.gain.linearRampToValueAtTime(1, t0 + fadeDur)
            debugLog(`🎚️ [LoadAndPlay] 淡入头 ${fadeDur}s（衔接上一首 Apple 淡出尾）`)
          } catch { /* 增益自动化失败则按原音量起播 */ }
        }
      }
      
      // Prepare the next edge without changing the user's global mode. Apple CENC pairs
      // downgrade AutoMix to managed gapless; non-Apple pairs keep the full analysis path.
      if (nextMetadataRef.current?.url) {
        const strategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
          autoMix: autoMixRef.current.enabled,
          crossfade: crossfadeRef.current.enabled,
          gapless: gaplessRef.current.enabled,
        })
        if (strategy === 'automix' && !isAlbumPlayback()) {
          debugLog('🎵 [LoadAndPlay] 检测到下一首歌曲且 AutoMix 已启用，调用 prepareAutoMix()')
          void prepareAutoMix()
        } else if (strategy === 'gapless' && (currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)) {
          setTransitionState('armed', {
            transitionStrategy: 'gapless',
            fallbackReason: autoMixRef.current.enabled ? 'Apple CENC pair uses gapless' : undefined,
          })
        }
      } else {
        debugLog('⏭️ [LoadAndPlay] 下一首: 不存在')
      }
      return true
    } catch (error) {
      if (loadRevision !== currentLoadRevisionRef.current) return false
      const err = error instanceof Error ? error : null
      detachAppleHls(active)
      // 用户在加载/播放中暂停会中止在途的 play()（媒体元素以 AbortError 拒绝）——
      // 这是正常打断，只清 loading 标志，静默返回 false（暂停状态已由 togglePlay 发布）。
      // NotAllowedError 表示浏览器/用户手势策略阻止了播放，歌曲实际不会出声，是真实失败：
      // 不能静默，必须走失败路径（App 会提示 + 重试一次），否则播放器卡在 loading 态无反馈。
      if (err && err.name === 'AbortError') {
        isLoadingRef.current = false
        return false
      }
      console.error('❌ [LoadAndPlay] 播放失败:', error)
      isLoadingRef.current = false
      setTransitionState('failed', { isPlaying: false, fallbackReason: err ? err.message : 'playback failed' })
      throw error
    }
  }, [cancelScheduledTransition, ensureAudioGraph, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, resetTrackStemMixer, setDeckGain, setTransitionState, prepareAutoMix, finiteDuration])

  // ── 外部播放源开关（由 App.loadAndPlaySong 在 WebView2 播放成功/切歌时调用）──
  /** 基础交叉淡化时长（外部源专用）：固定淡入淡出/无缝衔接/AutoMix 任一启用即生效，
   *  统一走 MusicKit 音量斜坡（EME 限制下无法采样级拼接，音量交叉是唯一可行路径）；
   *  三模式全关 → 0（按设置硬切）。固定淡入淡出档用其时长，其余用 6s 缺省。 */
  const externalFadeDuration = useCallback(() => {
    if (!crossfadeRef.current.enabled && !gaplessRef.current.enabled && !autoMixRef.current.enabled) return 0
    const d = crossfadeRef.current.enabled ? Number(crossfadeRef.current.duration) || 0 : 6
    return Math.min(12, Math.max(2, d))
  }, [])

  const enableExternalPlayback = useCallback(({ duration }: { duration?: number } = {}) => {
    externalDurationRef.current = duration && duration > 0 ? duration : 0
    externalEndedFiredRef.current = false
    externalFadeActiveRef.current = false
    if (externalActiveRef.current) return
    resetTrackStemMixer('unavailable', 'DRM、HLS 或直播音源暂不支持分轨')
    externalActiveRef.current = true
    // 本地 deck 若有声先停掉（外部源模式下 deck 无 src，这里只是保险）
    try {
      cancelScheduledTransition('switch to external playback source')
      const active = getActiveAudio()
      if (active && !active.paused) active.pause()
    } catch { /* 忽略 */ }
    // 淡入头：上一首 Apple 歌曲带淡出尾自然结束 → 本首从 0 渐起
    const fadeIn = externalEndedWithFadeRef.current ? externalFadeDuration() : 0
    externalEndedWithFadeRef.current = false
    if (fadeIn > 0) {
      void bridgeVolume(0)
      void bridgeFade(volumeRef.current, fadeIn * 1000)
    } else {
      // 音量推给播放面（MusicKit 音量独立于本地增益链）
      void bridgeVolume(volumeRef.current)
    }
    // 乐观首发，随后由 bridge 轮询回填（200ms 轮询 + 播放面 0.3s 采样）
    emit({ currentTime: 0, duration: finiteDuration(externalDurationRef.current), isPlaying: true, live: false })
    externalUnsubscribeRef.current = onBridgeStateChange((s) => {
      if (!externalActiveRef.current || !s.ready) return
      const duration = s.duration > 0 ? s.duration : externalDurationRef.current
      emit({
        currentTime: s.position,
        duration: finiteDuration(duration),
        // 缓冲/seek 等瞬态（loading=1 seeking=6 waiting=8）按「播放中」呈现，
        // 避免 UI 播放按钮在起播/拖动后 1 秒闪回暂停态
        isPlaying: s.playing || [1, 6, 8].includes(Number(s.status)),
        live: false,
      })
      if (s.playing) externalEndedFiredRef.current = false
      // 基础交叉"出"半边：进入结尾淡出窗口 → MusicKit 音量线性降到 0
      const fadeDur = externalFadeDuration()
      const inTail = fadeDur > 0 && s.duration > fadeDur + 1 && s.position >= s.duration - fadeDur
      if (inTail && !externalFadeActiveRef.current) {
        externalFadeActiveRef.current = true
        const remaining = Math.max(0.5, s.duration - s.position)
        void bridgeFade(0, remaining * 1000)
      } else if (!inTail && externalFadeActiveRef.current) {
        // seek 回退离开淡出窗口：恢复音量（重新进窗口会再次触发）
        externalFadeActiveRef.current = false
        void bridgeVolume(volumeRef.current)
      }
      // 歌曲结束：与 Apple HLS ended 语义一致（置 idle 交上层切歌/单曲循环）。
      // 只认"正在播放"时到达结尾：用户暂停在结尾（s.playing=false）不该被误判成
      // ended 而直接切下一首——恢复播放由 bridge 的 playing 事件清除标记重新评估。
      if (!externalEndedFiredRef.current && s.playing && s.duration > 0 && (s.ended || s.position >= s.duration - 0.5)) {
        externalEndedFiredRef.current = true
        // 带淡出尾自然结束 → 记录标记，下一首（Apple 播放面或本地 deck）做淡入头
        externalEndedWithFadeRef.current = externalFadeActiveRef.current
        setTransitionState('idle', { isPlaying: false, ended: true, transitioning: false, seamlessTransition: false })
      }
    })
  }, [cancelScheduledTransition, emit, externalFadeDuration, finiteDuration, getActiveAudio, resetTrackStemMixer, setTransitionState])

  const disableExternalPlayback = useCallback(() => {
    if (!externalActiveRef.current) return
    externalActiveRef.current = false
    try { externalUnsubscribeRef.current?.() } catch { /* 忽略 */ }
    externalUnsubscribeRef.current = null
    externalEndedFiredRef.current = false
    externalFadeActiveRef.current = false
    emit({ live: false })
    // 注意：externalEndedWithFadeRef 不清——供 loadAndPlay/enable 做淡入头
    // 停掉播放面声音（best-effort；切到非 Apple 歌时避免 WebView2 继续出声）
    void bridgeStopPlayback()
  }, [])

  const togglePlay = useCallback(async () => {
    // 外部播放源（WebView2 播放面）：控制转发 bridge，本地无媒体
    if (externalActiveRef.current) {
      if (getBridgeState().playing) {
        emit({ isPlaying: false })
        // 暂停时若在淡出尾：取消斜坡并恢复音量，恢复播放后按剩余时间重新淡出
        if (externalFadeActiveRef.current) {
          externalFadeActiveRef.current = false
          void bridgeVolume(volumeRef.current)
        }
        await bridgePause()
      } else {
        emit({ isPlaying: true })
        externalEndedFiredRef.current = false
        externalFadeActiveRef.current = false // 恢复播放后由轮询按剩余时间重新触发淡出
        await bridgeResume()
      }
      return
    }
    const active = getActiveAudio()
    if (!active?.src) return
    try {
      await ensureAudioGraph()
      if (gaplessIntegrationRef.current?.hasActiveTransition()) {
        cancelScheduledTransition('paused during gapless transition')
        active.pause()
        gaplessIntegrationRef.current.reset()
        emit({ isPlaying: false })
        return
      }
      if (transitionStateRef.current === 'running-transition' || handoffPendingCountRef.current > 0 || transitionBufferActiveRef.current) {
        // AutoMix/AI 长混音过渡中的暂停：源 deck 被静音但继续驱动时间线，**已 ended 的
        // 源 deck** 若走下方 active.paused → play() 分支会从头起播并让过渡继续——
        // 用户的"暂停"被吞掉。统一走取消路径：杀掉在途过渡与续体，暂停当前在响的 deck。
        cancelScheduledTransition('paused during running transition')
        const audible = [getActiveAudio(), getStandbyAudio()].find(deck =>
          deck && !deck.paused && (deck.currentSrc || deck.src)) || getActiveAudio()
        audible?.pause()
        transitionBufferActiveRef.current = false
        gaplessIntegrationRef.current?.reset()
        try { transitionVisualStore.end(false) } catch { /* 视觉收尾失败不阻塞 */ }
        emit({ isPlaying: false })
        return
      }
      if (active.paused) {
        await active.play()
        setTransitionState('playing', { isPlaying: true })
        if (nextMetadataRef.current?.url) {
          const strategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
            autoMix: autoMixRef.current.enabled,
            crossfade: crossfadeRef.current.enabled,
            gapless: gaplessRef.current.enabled,
          })
          if (strategy === 'automix') void prepareAutoMix()
          else if (strategy === 'gapless' && !(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)) void prepareGaplessTransition()
          else setTransitionState('armed', {
            isPlaying: true,
            transitionStrategy: strategy,
            fallbackReason: strategy === 'gapless' && autoMixRef.current.enabled ? 'Apple CENC pair uses gapless' : undefined,
          })
        }
      } else {
        if (trackStemControlRef.current.active && trackStemMixerRef.current) {
          trackStemMixerRef.current.pause()
          setDeckGain(getActiveGain(), active, 1)
        }
        cancelScheduledTransition('paused during transition')
        active.pause()
        // 同时暂停 standby 音频
        const standby = getStandbyAudio()
        if (standby && !standby.paused) {
          standby.pause()
        }
        // 重置 GaplessIntegration，停止所有预加载的音频
        if (gaplessIntegrationRef.current) {
          gaplessIntegrationRef.current.reset()
        }
        emit({ isPlaying: false })
        // 暂停完成且已确认无进行中的过渡/无缝混音任务后 suspend 音频上下文（省电）：
        // hasActiveTransition() 已在上方分支早退（有进行中任务不走到这里）；
        // cancelScheduledTransition 已停止 TransitionRenderer 缓冲源、清除边界/预热 timer，
        // 双 deck（active/standby）均已 pause，gaplessIntegration.reset() 已取消 albumGapless 混音
        // 与 preload 媒体——无任何源会继续发声，suspend 不会造成断声/杂音。
        // 吞掉可能抛出的错误（上下文可能已被关闭）。
        if (
          audioContextRef.current
          && audioContextRef.current.state !== 'suspended'
          && audioContextRef.current.state !== 'closed'
        ) {
          void audioContextRef.current.suspend().catch(() => undefined)
        }
      }
    } catch (error) {
      console.error('[PlaybackEngine] play/pause failed', error)
    }
  }, [cancelScheduledTransition, emit, ensureAudioGraph, getActiveAudio, getActiveGain, prepareAutoMix, prepareGaplessTransition, setDeckGain, setTransitionState])

  const seek = useCallback((time: number) => {
    // 外部播放源：转发 bridge，本地无媒体可定位
    if (externalActiveRef.current) {
      const bridgeDuration = getBridgeState().duration || externalDurationRef.current
      const pos = bridgeDuration > 0 ? Math.max(0, Math.min(time, bridgeDuration)) : Math.max(0, time)
      externalEndedFiredRef.current = false
      // seek 撞销在途淡出斜坡并恢复音量（seek 进尾部由轮询按剩余时间重新淡出）
      if (externalFadeActiveRef.current) {
        externalFadeActiveRef.current = false
        void bridgeVolume(volumeRef.current)
      }
      emit({ currentTime: pos, duration: finiteDuration(bridgeDuration) })
      void bridgeSeek(pos)
      return
    }
    const active = getActiveAudio()
    if (!active) return
    // 过渡动画窗口内（视觉已切到目标曲）：time 是目标曲时间轴上的值，写进源 deck
    // 会按源曲时长截断且听感错位。统一取消过渡后按视觉轨道选 deck 定位。
    const visual = transitionVisualStore.getSnapshot()
    const standbyDeck = getStandbyAudio()
    if (visual.active && visual.switched && standbyDeck) {
      const target = standbyDeck
      cancelScheduledTransition('seek during transition (visual on target)')
      transitionBufferActiveRef.current = false
      const targetDuration = Number.isFinite(target.duration) && target.duration > 0 ? target.duration : Infinity
      target.currentTime = Math.max(0, Math.min(time, targetDuration))
      if (target.paused && transitionStateRef.current !== 'idle') {
        void target.play().catch(() => undefined)
      }
      // 提升 target 为当前 deck（与 handoff 提升同款），UI/后续 seek 落在正确时间轴
      setDeckGain(getActiveGain(), getActiveAudio(), 0)
      setDeckGain(getStandbyGain(), target, 1)
      activePrimaryRef.current = !activePrimaryRef.current
      if (nextMetadataRef.current) {
        currentMetadataRef.current = nextMetadataRef.current
        nextMetadataRef.current = null
      }
      setAudioElement(target)
      try { transitionVisualStore.end(true) } catch { /* 视觉收尾失败不阻塞 */ }
      emit({ currentTime: target.currentTime, duration: finiteDuration(target.duration) })
      return
    }
    const wasPlaying = !active.paused
    // 先取出当前计划：cancelScheduledTransition 会把它清空，而"seek 落在过渡窗口之前"时
    // 旧计划仍然可用（preserveNext 默认 true，standby 的 src 与元数据都保留），无需重新
    // 分析/重渲染，也避免经历"重排期间没有任何过渡可用"的空窗。
    const planBeforeSeek = transitionPlanRef.current
    // 无缝衔接的智能计划同样先取出：cancelScheduledTransition 会清空它，
    // 而 seek 落在窗口之前时计划仍然可用（窗口/缓存都没变），无需重新分析。
    const gaplessPlanBeforeSeek = gaplessPlanRef.current
    cancelScheduledTransition('seek changed transition timing')
    // 元数据未加载（duration 未知）时直接定位，不做 0 上限裁剪，避免拖动归零
    const duration = Number.isFinite(active.duration) && active.duration > 0 ? active.duration : Infinity
    active.currentTime = Math.max(0, Math.min(time, duration))
    if (trackStemControlRef.current.active && trackStemMixerRef.current) {
      const mixer = trackStemMixerRef.current
      mixer.returnToOriginal()
      mixer.seek(active.currentTime)
      setDeckGain(getActiveGain(), active, 1)
      setTrackStemControl(current => ({ ...current, status: 'separating', active: false, progress: Math.min(1, (active.currentTime + 20) / Math.max(1, active.duration)) }))
      if (wasPlaying) {
        void mixer.play(active.currentTime).then(ready => {
          if (ready) setTrackStemControl(current => ({ ...current, status: 'partial', active: true }))
        }).catch(error => {
          mixer.returnToOriginal()
          setTrackStemControl(current => ({ ...current, status: 'failed', active: false, reason: error instanceof Error ? error.message : '定位处分轨失败' }))
        })
      }
    }
    // seek 落在已计划的过渡起点**之前**：计划仍可用（触发点、窗口、缓冲缓存都没变），
    // 直接重新武装即可，不重新规划。只有越过/进入窗口时才作废旧计划重排——
    // 原实现因为 cancel 已经清空了 transitionPlanRef，这个判断恒假（计划总是被作废），
    // 于是任何一次拖动进度条都会触发重排，并叠加失败节流时会让本曲彻底没有过渡。
    const canReusePlan = Boolean(
      planBeforeSeek
      && nextMetadataRef.current?.url
      && currentMetadataRef.current?.trackKey === planBeforeSeek.sourceTrackKey
      && nextMetadataRef.current?.trackKey === planBeforeSeek.targetTrackKey
      && active.currentTime < planBeforeSeek.sourceStartTime - 0.5,
    )
    if (canReusePlan && planBeforeSeek) {
      transitionPlanRef.current = planBeforeSeek
      const animationStart = planBeforeSeek.strategy === 'smart-rendered-v2' && planBeforeSeek.v2?.aiMix === true
        ? Math.max(
            planBeforeSeek.sourceStartTime,
            planBeforeSeek.sourceStartTime + (planBeforeSeek.renderedDuration ?? AI_MIX_WINDOW_SECONDS) - ANIMATION_TAIL_SECONDS,
          )
        : Math.max(planBeforeSeek.sourceStartTime, planBeforeSeek.sourceEndTime - ANIMATION_LEAD_SECONDS)
      setTransitionState('armed', {
        transitioning: false,
        transitionStrategy: planBeforeSeek.strategy,
        fallbackReason: planBeforeSeek.fallbackReason,
        transitionStartTime: animationStart,
        transitionStyle: planBeforeSeek.v2?.choreography?.style,
        transitionFromTrackKey: currentMetadataRef.current?.trackKey,
        transitionToTrackKey: nextMetadataRef.current?.trackKey,
      })
      debugLog('⏭️ [AutoMix] seek 落在过渡窗口之前：保留现有计划（不重新分析/渲染）')
    } else {
      // 无缝衔接：seek 落在智能交叉窗口之前且曲对不变 → 同样保留原计划（窗口/缓冲都没变）。
      // 实测（2026-10-05 用户日志）：拖动进度条会 cancel 掉计划，导致边界退化成 2.5s 兜底；
      // 这里与 AutoMix 同口径做「窗口前 seek 保留计划」。
      const keepGaplessPlan = Boolean(
        gaplessPlanBeforeSeek
        && nextMetadataRef.current?.trackKey === gaplessPlanBeforeSeek.targetTrackKey
        && active.currentTime < gaplessPlanBeforeSeek.sourceStartTime - 0.5,
      )
      if (keepGaplessPlan && gaplessPlanBeforeSeek) {
        gaplessPlanRef.current = gaplessPlanBeforeSeek
        debugLog('⏭️ [Gapless] seek 落在交叉窗口之前：保留智能短交叉计划（不重新分析）')
        setTransitionState('armed', {
          transitioning: false,
          transitionStrategy: 'gapless',
          fallbackReason: gaplessPlanBeforeSeek.fallbackReason,
          transitionStartTime: gaplessPlanBeforeSeek.sourceStartTime,
          transitionDebug: buildTransitionDebug(gaplessPlanBeforeSeek, 'fallback'),
        })
      } else {
        // 越过或进入过渡窗口：旧计划不可用，清空后从当前位置重新规划。
        if (planBeforeSeek) transitionPlanRef.current = null
        emit({ currentTime: active.currentTime, duration: finiteDuration(active.duration), live: isLiveRef.current })
        if (nextMetadataRef.current?.url) {
          const strategy = resolveBoundaryStrategy()
          if (strategy === 'automix') void prepareAutoMix()
          else if (strategy === 'gapless' && !(currentMetadataRef.current?.appleHls || nextMetadataRef.current?.appleHls)) {
            // 跨专辑重排智能短交叉计划（分析有缓存，通常秒回）；同专辑走控制器预热
            if (isAlbumPlayback() && gaplessIntegrationRef.current) void prepareGaplessTransition()
            else void prepareGaplessCrossfadeRef.current()
          }
          else setTransitionState('armed', {
            transitionStrategy: strategy,
            fallbackReason: strategy === 'gapless' && autoMixRef.current.enabled ? 'Apple CENC pair uses gapless' : undefined,
          })
        } else if (wasPlaying && active.paused) {
          void active.play().catch(() => undefined)
        }
        return
      }
    }
    emit({ currentTime: active.currentTime, duration: finiteDuration(active.duration), live: isLiveRef.current })
    if (wasPlaying && active.paused) {
      void active.play().catch(() => undefined)
    }
  }, [cancelScheduledTransition, emit, getActiveAudio, getActiveGain, isAlbumPlayback, prepareAutoMix, prepareGaplessTransition, resolveBoundaryStrategy, setDeckGain, setTransitionState, finiteDuration, transitionVisualStore])

  const setVolume = useCallback((volume: number) => {
    const clamped = Math.max(0, Math.min(1, volume))
    volumeRef.current = clamped
    // 外部播放源：音量作用于 WebView2 播放面
    if (externalActiveRef.current) {
      void bridgeVolume(clamped)
      emit({ volume: clamped })
      // 淡出尾中拖音量会撞销在途斜坡：按剩余时间以新音量为起点重新淡出。
      // else 分支必须终止在途斜坡：duration 未知（电台/WebView2 初期未回填）时
      // 窗口判定不成立，若只置 flag 不发指令，已发出的 fade(0) 斜坡会继续降到 0，
      // 出现"音量条满格但没声音"（bridge 层新 fade 指令会覆盖在途斜坡）。
      if (externalFadeActiveRef.current) {
        const s = getBridgeState()
        const fadeDur = externalFadeDuration()
        if (fadeDur > 0 && s.duration > fadeDur + 1 && s.position >= s.duration - fadeDur) {
          void bridgeFade(0, Math.max(0.5, s.duration - s.position) * 1000)
        } else {
          externalFadeActiveRef.current = false
          void bridgeFade(clamped, 0)
        }
      }
      return
    }
    const context = audioContextRef.current
    const master = masterGainRef.current
    if (context && master) {
      master.gain.setValueAtTime(clamped, context.currentTime)
      const active = getActiveAudio()
      if (active) active.volume = 1
    } else {
      const active = getActiveAudio()
      if (active) active.volume = clamped
    }
    emit({ volume: clamped })
  }, [emit, getActiveAudio])

  const setPlayAtCallback = useCallback((callback: (index: number, options: any) => Promise<boolean>) => {
    playAtCallbackRef.current = callback
  }, [])

  const resetGaplessIntegration = useCallback(() => {
    if (gaplessIntegrationRef.current) {
      debugLog('[Gapless] 重置 GaplessIntegration')
      gaplessIntegrationRef.current.reset()
    }
  }, [])

  const adoptExternalAudio = useCallback(async (externalAudio: HTMLAudioElement, metadata: DeckMetadata) => {
    debugLog('[AdoptAudio] 接管外部音频元素')
    debugLog('   URL:', metadata.url)
    debugLog('   当前时间:', externalAudio.currentTime.toFixed(2))
    debugLog('   是否暂停:', externalAudio.paused)

    const active = getActiveAudio()
    const target = getStandbyAudio()
    if (!active || !target) throw new Error('Audio deck is not initialized')
    const initialResumeTime = Math.max(0, externalAudio.currentTime || 0)

    isLoadingRef.current = false
    cancelScheduledTransition('external audio adopted', true, false)
    // Keep the already-audible transition deck alive until the managed deck
    // has started at the same position, otherwise handoff creates a gap.
    gaplessIntegrationRef.current?.reset(externalAudio)

    try {
      // Move playback back onto a managed deck so pause, seek and ended events
      // keep controlling the same audio after the seamless handoff.
      active.pause()
      // BUG-A3：AlbumGapless 混音完成时会把 masterGain 归零（albumGapless.ts
      // runBalancedCrossfade 的 finish 分支）。若下面因 standby src 不匹配进入
      // canplay 等待，等待期间整条托管链路就会静音，严重时达数秒。进入等待前
      // 先把 masterGain 恢复到目标音量，确保等 canplay 期间始终有声。
      if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.setValueAtTime(volumeRef.current, audioContextRef.current.currentTime)
      }
      if (target.src !== metadata.url) {
        target.src = metadata.url
        target.preload = 'auto'
        target.load()
        await new Promise<void>((resolve, reject) => {
          const ready = () => { cleanup(); resolve() }
          const failed = () => { cleanup(); reject(target.error || new Error('media load failed')) }
          const cleanup = () => {
            target.removeEventListener('canplay', ready)
            target.removeEventListener('error', failed)
            if (timeoutId !== null) window.clearTimeout(timeoutId)
          }
          // 无缝接管时 CDN 卡住/加载被新播放打断可能永远不触发 canplay → 超时放弃并回退普通加载
          let timeoutId: number | null = window.setTimeout(() => {
            timeoutId = null
            cleanup()
            reject(new Error('adopt external audio timed out'))
          }, 12000)
          target.addEventListener('canplay', ready, { once: true })
          target.addEventListener('error', failed, { once: true })
        })
      }

      const getLiveHandoffTime = () => {
        const liveExternalTime = Math.max(initialResumeTime, externalAudio.currentTime || 0)
        const latestAllowedTime = Math.max(0, (target.duration || metadata.duration || liveExternalTime + 0.1) - 0.1)
        return Math.min(liveExternalTime, latestAllowedTime)
      }

      setDeckGain(getActiveGain(), active, 0)
      setDeckGain(getStandbyGain(), target, 0)
      target.currentTime = getLiveHandoffTime()
      await target.play()

      // The external deck keeps advancing while the managed deck starts. Align
      // again after play() resolves so the handoff does not replay or skip the
      // last decoder frames at the exact moment the visual transition ends.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const liveHandoffTime = getLiveHandoffTime()
        if (Math.abs(target.currentTime - liveHandoffTime) <= EXTERNAL_HANDOFF_SYNC_TOLERANCE_SECONDS) break
        target.currentTime = liveHandoffTime
        await waitForSeek(target)
      }

      const standbyGain = getStandbyGain()
      const context = audioContextRef.current
      const externalStartVolume = externalAudio.muted ? 0 : externalAudio.volume
      if (standbyGain && context) {
        standbyGain.gain.cancelScheduledValues(context.currentTime)
      }

      // BUG-A4：external deck（AlbumGapless/Cuefield 的 preload.media）与 managed
      // standby deck 会短暂同声——这个重叠能消除元素级硬切爆音，予以保留，但两侧
      // 淡入淡出必须由同一帧驱动同步，否则音量曲线帧级错位会产生可闻的增益抖动/
      // 混叠。播放位置已由上面的 waitForSeek 对齐循环保证（EXTERNAL_HANDOFF_SYNC_TOLERANCE_SECONDS）。
      await new Promise<void>(resolve => {
        const startedAt = performance.now()
        const tick = () => {
          const progress = Math.min(1, (performance.now() - startedAt) / EXTERNAL_HANDOFF_FADE_MS)
          externalAudio.volume = externalStartVolume * Math.cos(progress * Math.PI / 2)
          if (standbyGain && context) {
            standbyGain.gain.setValueAtTime(Math.sin(progress * Math.PI / 2), context.currentTime)
          } else {
            target.volume = Math.sin(progress * Math.PI / 2) * volumeRef.current
          }

          if (progress < 1) {
            // 帧 id 存入 ref：卸载/取消路径据此 cancelAnimationFrame，避免自循环 rAF 泄漏
            externalHandoffFadeFrameRef.current = requestAnimationFrame(tick)
          } else {
            externalHandoffFadeFrameRef.current = null
            resolve()
          }
        }
        tick()
      })

      setDeckGain(standbyGain, target, 1)

      externalAudio.pause()
      externalAudio.removeAttribute('src')
      externalAudio.load()
      active.currentTime = 0
      active.removeAttribute('src')
      active.load()
      activePrimaryRef.current = !activePrimaryRef.current
      currentMetadataRef.current = { ...metadata }
      nextMetadataRef.current = null
      setAudioElement(target)

      setTransitionState('committed', {
        isPlaying: true,
        currentTime: target.currentTime,
        duration: target.duration || metadata.duration || 0,
        ended: false,
        transitioning: false,
        seamlessTransition: true,
        transitionStrategy: 'gapless',
      })
      setTransitionState('playing', {
        isPlaying: true,
        transitioning: false,
        transitionStrategy: 'gapless',
      })
      // 过渡收尾：恢复用户倍速。过渡开始时 onTransitionReset 把 deck 归 1（让位 BPM
      // 变速），此后音频持续播放不会再触发 'play' 事件——不在这里恢复的话，用户倍速
      // 静默失效直到下一次 play/换曲。
      if (userSpeedRef.current !== 1) {
        target.playbackRate = userSpeedRef.current
        setEffectivePlaybackSpeed(userSpeedRef.current)
      }

      debugLog('[AdoptAudio] 接管完成，当前播放位置:', target.currentTime.toFixed(2))
      return true
    } catch (error) {
      console.error('[AdoptAudio] 接管失败:', error)
      target.pause()
      setDeckGain(getStandbyGain(), target, 0)
      externalAudio.pause()
      externalAudio.removeAttribute('src')
      externalAudio.load()
      return false
    }
  }, [cancelScheduledTransition, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState])

  return {
    loadAndPlay,
    togglePlay,
    seek,
    setVolume,
    /** WebView2 播放面外部播放源：enable/disable 由 App.loadAndPlaySong 调用 */
    enableExternalPlayback,
    disableExternalPlayback,
    isExternalPlaybackActive: () => externalActiveRef.current,
    preloadNext,
    cancelTransition: cancelScheduledTransition,
    /** 看歌挂起开关：true=引擎进入"看歌时间线"——取消在途过渡且期间禁止 prepare/启动
     *  自动过渡（看歌中歌曲不被 automix 推进）；false=恢复正常（引擎可重新为当前歌准备） */
    setWatchHold: (hold: boolean) => {
      if (hold === watchHoldRef.current) return
      watchHoldRef.current = hold
      if (hold) {
        cancelScheduledTransition('enter watch mode (hold)')
      } else {
        // 切出看歌：必须为当前歌**重新武装**边界过渡。进入看歌后引擎的加载链路触发过
        // prepareAutoMix，但被本闸门跳过且不会重跑（元数据此后不再变化、调度 effect
        // 也不再触发）——不补武装的话本曲结尾 automix 整体失灵、硬切下一首，而 HUD
        // 还挂着上一曲残留的「即将过渡」（用户实测：看歌里听完自动切下一首、看了一段
        // 切回歌词页，本曲放完无过渡，再下一首才恢复）。重走统一入口：按当前对策略
        // 决定 prepare / gapless / 降级，顺带把过渡状态刷新成真实情况（HUD 不再过期）。
        if (transitionStateRef.current !== 'running-transition') {
          const strategy = resolveBoundaryStrategy()
          if (strategy === 'automix') {
            void prepareAutoMix()
          } else if (strategy === 'gapless') {
            void prepareGaplessTransition()
          } else {
            setTransitionState('armed', {
              transitioning: false,
              transitionStrategy: strategy,
            })
          }
        }
      }
    },
    getAudioElement: getActiveAudio,
    /** 恢复/接管播放前确保 AudioContext 就绪（看歌切回、外部接管等场景） */
    ensureAudioGraph,
    audioElement,
    playbackTimeStore,
    transitionVisualStore,
    analyserNode,
    leftAnalyserNode,
    rightAnalyserNode,
    nextAudioElement: getStandbyAudio(),
    setPlayAtCallback,
    resetGaplessIntegration,
    /** HUD「关闭」：本曲对不做智能混音（完整播放本曲，末尾只留短交叉） */
    skipAutoMixForCurrentPair,
    /** 音质切换后让已渲染的过渡失效（见 TransitionRenderer.clearRenderedCache） */
    clearTransitionRenders: () => {
      transitionRendererRef.current?.clearRenderedCache()
    },
    adoptExternalAudio,
    getAcceptanceState: () => {
      const active = getActiveAudio()
      const standby = getStandbyAudio()
      return {
        transitionState: transitionStateRef.current,
        activeAppleHls: Boolean(getActiveAppleStream(active)),
        standbyAppleHls: Boolean(getActiveAppleStream(standby)),
        activePaused: active?.paused ?? true,
        standbyPaused: standby?.paused ?? true,
        activeReadyState: active?.readyState ?? 0,
        standbyReadyState: standby?.readyState ?? 0,
        hasCurrentMetadata: Boolean(currentMetadataRef.current),
        hasNextMetadata: Boolean(nextMetadataRef.current),
        autoMixEnabled: autoMixRef.current.enabled,
        resolvedPairStrategy: resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
          autoMix: autoMixRef.current.enabled,
          crossfade: crossfadeRef.current.enabled,
          gapless: gaplessRef.current.enabled,
        }),
        autoMixAnalysisStarts: acceptanceAutoMixAnalysisStartsRef.current,
      }
    },
    resetAcceptanceState: () => {
      acceptanceAutoMixAnalysisStartsRef.current = 0
    },
    runAcceptanceTransition: async () => {
      const strategy = resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current, {
        autoMix: autoMixRef.current.enabled,
        crossfade: crossfadeRef.current.enabled,
        gapless: gaplessRef.current.enabled,
      })
      if (strategy === 'none' || strategy === 'automix') {
        throw new Error(`Acceptance transition is not armed: ${strategy}`)
      }
      await startTransition(strategy)
      return strategy
    },
    releaseAcceptanceDecks: () => {
      cancelScheduledTransition('acceptance cleanup', false)
      const decks = [getActiveAudio(), getStandbyAudio()]
      for (const audio of decks) {
        if (!audio) continue
        audio.pause()
        detachAppleHls(audio)
        audio.removeAttribute('src')
        audio.load()
      }
      currentMetadataRef.current = null
      nextMetadataRef.current = null
    },
    trackStems: {
      state: trackStemControl,
      enable: enableTrackStems,
      setVocalLevel: setTrackVocalLevel,
      setStemGains: setTrackStemGains,
      returnToOriginal: returnTrackStemsToOriginal,
      /** 学歌伴奏导出：拿整曲音频的本地缓存路径。当前曲直接复用已准备好的 metadata.url；
       *  其余歌曲（历史记录跳回等场景）抛错提示先播放该曲——导出本来就只在当前曲上操作。 */
      prepareInput: async (song: { platform?: string; mid?: string; id?: number; name?: string }) => {
        const metadata = currentMetadataRef.current
        if (metadata?.url && (!song || metadata.name === song.name)) {
          return ensureTrackStemInput(metadata)
        }
        throw new Error('请先播放这首歌，再导出伴奏（导出只针对当前播放的曲目）')
      },
    },
    /** 用户倍速（歌曲本体）：仅 playing/idle 应用；过渡期间自动让位给引擎 BPM 变速 */
    playbackSpeed: {
      apply: applyUserPlaybackSpeed,
      get: () => userSpeedRef.current,
    },
  }
}
