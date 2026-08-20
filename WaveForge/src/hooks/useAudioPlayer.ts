import { debugLog } from '../utils/debugLog'
import { useCallback, useEffect, useRef, useState } from 'react'
import { autoMixAnalysisService } from '../services/autoMixAnalysisService'
import { planTransition, planTransitionV2 } from '../audio/transitionPlanner'
import { TransitionRenderer } from '../audio/TransitionRenderer'
import { createPlaybackTimeStore } from '../audio/playbackTimeStore'
import { GaplessIntegration } from '../services/gaplessIntegration'
import { createSeamlessJoinController, type SeamlessJoinController } from '../services/gapless/seamlessJoinController'
import { runGaplessDeckFade } from '../services/gapless/gaplessTransition'
import { GAPLESS_SEAMLESS_WARMUP_SECONDS } from '../services/gapless/gaplessConstants'
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

export interface CrossfadeSettings {
  enabled: boolean
  duration: number
}

// GaplessSettings 已移入 src/services/gapless/gaplessConstants（本文件 re-export 保持兼容）

export interface AutoMixSettings {
  enabled: boolean
  mode: 'auto' | 'manual'
  enableBeatMatching: boolean
  skipSilence: boolean
  minDuration?: number
  maxDuration?: number
  /** AutoMix 增强版（v2）引擎开关：false/缺省 = 标准 v1（行为与历史一致） */
  enhanced?: boolean
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

function asPreloadTrack(input: string | PreloadTrack): PreloadTrack {
  return typeof input === 'string' ? { url: input } : input
}

function equalPowerCurve(fadeIn: boolean): Float32Array {
  const curve = new Float32Array(CURVE_POINTS)
  for (let i = 0; i < CURVE_POINTS; i += 1) {
    const progress = i / (CURVE_POINTS - 1)
    curve[i] = fadeIn ? Math.sin(progress * Math.PI / 2) : Math.cos(progress * Math.PI / 2)
  }
  return curve
}

/** 渲染端 automix 事件写入后端日志文件（automix-backend.log），便于前后端合并定位。 */
function logAutomixBackend(scope: string, message: string): void {
  window.electron?.automixLog?.(scope, message).catch(() => undefined)
}

/** 从过渡计划构建调试信息（过渡调试弹窗展示用）。 */
function buildTransitionDebug(
  plan: TransitionPlan,
  engine: 'v1' | 'v2' | 'fallback',
  sourceAnalysis?: TrackAnalysis,
  targetAnalysis?: TrackAnalysis,
): TransitionDebugInfo {
  const effects: string[] = []
  if (plan.strategy === 'smart-rendered-v2' && plan.v2?.aiMix === true) {
    // AI 混音：音频由 DJTransGAN 模型生成（推子+EQ 自动化），不叠加 DSP 特效清单
    effects.push('AI 混音（DJTransGAN 模型推子+EQ，60s 长混音）')
  } else if (plan.strategy === 'smart-rendered' || plan.strategy === 'smart-rendered-v2') {
    if (plan.djEffects?.enabled) {
      if (plan.djEffects.bassSwap) effects.push('低音互换')
      if (plan.djEffects.filterSweep) effects.push('滤波扫频')
      if (plan.djEffects.echoOut) effects.push('回声淡出')
      if (plan.djEffects.sweepFx) effects.push('噪声扫频')
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
  // 过渡进度 emit 节流：rAF 仍每帧驱动，但仅当距上次 emit ≥30ms 才 emit（约 30fps），
  // 降低 App 整树重渲染频率；progress 到达 1 时强制 emit 最终值确保状态复位
  const transitionProgressEmitTimeRef = useRef(0)
  const retiredDeckCleanupTimerRef = useRef<number | null>(null)
  const preparationAbortRef = useRef<AbortController | null>(null)
  const autoMixPreparationKeyRef = useRef<string | null>(null)
  const preparationRevisionRef = useRef(0)
  const transitionExecutionRevisionRef = useRef(0)
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
  const audioContextRef = useRef<AudioContext | null>(null)
  const gainNodesRef = useRef<[GainNode | null, GainNode | null]>([null, null])
  const masterGainRef = useRef<GainNode | null>(null)
  const analyserNodeRef = useRef<AnalyserNode | null>(null)
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null)
  const transitionRendererRef = useRef<TransitionRenderer | null>(null)
  const gaplessIntegrationRef = useRef<GaplessIntegration | null>(null)
  // Gapless 首选无缝拼接控制器（独立模块，逻辑见 src/services/gapless/）
  const seamlessJoinControllerRef = useRef<SeamlessJoinController | null>(null)
  const playAtCallbackRef = useRef<((index: number, options: any) => Promise<boolean>) | null>(null)
  const [playbackTimeStore] = useState(createPlaybackTimeStore)

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
    onStateChangeRef.current(state)
  }, [])

  const setTransitionState = useCallback((state: TransitionState, extra: Partial<AudioPlayerState> = {}) => {
    transitionStateRef.current = state
    emit({ transitionState: state, ...extra })
  }, [emit])

  const getActiveAudio = useCallback(() => activePrimaryRef.current ? primaryRef.current : secondaryRef.current, [])
  const getStandbyAudio = useCallback(() => activePrimaryRef.current ? secondaryRef.current : primaryRef.current, [])
  const getActiveGain = useCallback(() => gainNodesRef.current[activePrimaryRef.current ? 0 : 1], [])
  const getStandbyGain = useCallback(() => gainNodesRef.current[activePrimaryRef.current ? 1 : 0], [])

  const setDeckGain = useCallback((gain: GainNode | null, audio: HTMLAudioElement | null, value: number) => {
    const next = Math.max(0, Math.min(1, value))
    if (gain && audioContextRef.current) {
      gain.gain.cancelScheduledValues(audioContextRef.current.currentTime)
      gain.gain.setValueAtTime(next, audioContextRef.current.currentTime)
      if (audio) audio.volume = 1
    } else if (audio) {
      audio.volume = next * volumeRef.current
    }
  }, [])

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
      context = new AudioContextCtor()
      const master = context.createGain()
      const firstGain = context.createGain()
      const secondGain = context.createGain()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.72
      // 最终输出增益节点：AirPlay 投送时置 0 静音本机输出；采集点在 analyser 之后
      //（取完整混音），不受本节点影响，投送给音箱的仍是完整声音
      const outputGain = context.createGain()
      outputGain.gain.value = 1
      context.createMediaElementSource(first).connect(firstGain).connect(master)
      context.createMediaElementSource(second).connect(secondGain).connect(master)
      master.connect(analyser).connect(outputGain).connect(context.destination)
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
      onAudioGraphReadyRef.current?.({ audioContext: context, masterGain: master, analyser, outputGain })
      
      if (context.state === 'suspended') await context.resume().catch(() => undefined)
    } catch (error) {
      console.warn('[PlaybackEngine] Web Audio gain graph unavailable, using media volume fallback', error)
      if (context && context.state !== 'closed') void context.close()
      audioContextRef.current = null
      gainNodesRef.current = [null, null]
      masterGainRef.current = null
      analyserNodeRef.current = null
      setAnalyserNode(null)
    }
  }, [])

  const cancelScheduledTransition = useCallback((reason = 'playback intent changed', preserveNext = true, announceCancellation = true) => {
    preparationRevisionRef.current += 1
    transitionExecutionRevisionRef.current += 1
    preparationAbortRef.current?.abort()
    preparationAbortRef.current = null
    autoMixPreparationKeyRef.current = null
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
    transitionPlanRef.current = null
    if (!preserveNext) {
      if (standby) {
        standby.removeAttribute('src')
        standby.load()
      }
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
    if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
    transitionTimerRef.current = null
    if (transitionDeckStartTimerRef.current !== null) window.clearTimeout(transitionDeckStartTimerRef.current)
    transitionDeckStartTimerRef.current = null
    
    // 清理过渡进度追踪动画
    if (transitionProgressAnimationRef.current !== null) {
      cancelAnimationFrame(transitionProgressAnimationRef.current)
      transitionProgressAnimationRef.current = null
    }
    transitionStartTimeRef.current = null
    
    // 在 gapless 模式下，source 已经在 startTransition 中被停止了
    // 避免再次调用 load()，这会导致音频上下文短暂中断造成卡顿
    if (strategy !== 'gapless') {
      source?.pause()
      if (source) {
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
  }, [getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState])

  const startTransition = useCallback(async (strategy: TransitionStrategy, plan?: TransitionPlan) => {
    debugLog('🚀 [Transition] startTransition 被调用')
    debugLog('   策略:', strategy)
    debugLog('   计划:', plan)
    debugLog('   当前过渡状态:', transitionStateRef.current)
    
    if (transitionStateRef.current === 'running-transition' || transitionStartingRef.current) {
      debugLog('⚠️ [Transition] 已经在进行过渡中，跳过')
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
    const audioDuration = strategy === 'gapless' ? 0 : Math.max(0.25,
      plan ? plan.sourceEndTime - plan.sourceStartTime :
      strategy === 'fixed-crossfade' ? crossfadeRef.current.duration :
      4) // 默认 4 秒作为 fallback
    
    // 视觉过渡时长（gapless 模式下仍需要视觉动画）
    const visualDuration = strategy === 'gapless' ? 0.4 : audioDuration
    
    const targetTime = Math.max(0, Math.min(plan?.targetStartTime || 0, Math.max(0, (target.duration || targetMetadata.duration || 0) - 0.1)))

    debugLog('⏱️ [Transition] 过渡参数:')
    debugLog('   音频过渡时长:', audioDuration.toFixed(2), 's')
    debugLog('   视觉过渡时长:', visualDuration.toFixed(2), 's')
    debugLog('   目标开始时间:', targetTime.toFixed(2), 's')

    const executionRevision = ++transitionExecutionRevisionRef.current
    transitionStartingRef.current = true
    try {
      debugLog('🎨 [Transition] 确保音频图已初始化...')
      await ensureAudioGraph()
      
      // Check if we have a smart-rendered transition ready
      if ((strategy === 'smart-rendered' || strategy === 'smart-rendered-v2') && plan && transitionRendererRef.current) {
        debugLog('🎨 [Transition] 检查智能渲染的过渡音频...')
        const rendered = await transitionRendererRef.current.getRendered(plan.id)
        if (rendered) {
          debugLog('✅ [Transition] 找到预渲染的过渡音频，开始播放')
          
          // Get the transition duration from the rendered buffer
          const playbackOffset = Math.max(0, Math.min(
            Math.max(0, (source.currentTime || 0) - plan.sourceStartTime),
            Math.max(0, rendered.duration - 0.05),
          ))
          const transitionAudioDuration = Math.max(0.05, rendered.duration - playbackOffset)
          debugLog('   过渡音频时长:', transitionAudioDuration.toFixed(2), 's')
          
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
            
            // When progress reaches 90%, send visualSwitchCommit to update UI early
            // This prevents visual glitch when commitTransition is called
            if (!visualSwitchSent && progress >= 0.9) {
              visualSwitchSent = true
              // 目标曲视觉进度 = 其在缓冲内的实时位置（90% 处 ≈ 目标曲窗口的 90%），
              // 缓冲结束（100%）自然落到 targetEndTime，与真实恢复点一致，避免 0→100% 跳变。
              const targetSpan = Math.max(0, (plan?.targetEndTime || 0) - (plan?.targetStartTime || 0))
              const visualTargetTime = (plan?.targetStartTime || 0) + 0.9 * targetSpan
              const visualCommit: TransitionCommit = {
                sourceTrackKey: currentMetadataRef.current?.trackKey || '',
                targetTrackKey: targetMetadata.trackKey || '',
                targetIndex: targetMetadata.index,
                targetTime: visualTargetTime,
                strategy: strategy,
                isVisualSwitch: true, // Mark this as visual-only update
              }
              debugLog('🎨 [Transition] 发送 visualSwitchCommit (进度 90%)')
              debugLog('   目标歌曲:', targetMetadata.trackKey)
              debugLog('   目标时间:', visualCommit.targetTime.toFixed(2), 's')
              emit({
                transitionProgress: progress,
                transitionDuration: transitionAudioDuration,
                visualSwitchCommit: visualCommit,
                currentTime: syntheticTime,
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
                  currentTime: syntheticTime,
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
            { overlap: plan.overlapSeconds },
          )
          if (result) {
            if (result.tooLate) {
              // 迟到保护：缓冲未启动，source 仍在播放 → 回退标准交叉淡化
              console.warn('⚠️ [Transition] 过渡触发过晚（>85% 缓冲），回退交叉淡化')
              strategy = 'fixed-crossfade'
              plan.strategy = 'fixed-crossfade'
              plan.fallbackReason = 'Transition triggered too late; using fixed crossfade'
            } else {
              debugLog('✅ [Transition] 智能渲染过渡缓冲已启动')
              debugLog('   目标恢复时间:', result.targetResumeTime.toFixed(2), 's')
              debugLog('   过渡剩余时长:', result.remainingDuration.toFixed(2), 's')

              // 过渡缓冲内含源曲结尾：把 source deck 静音但**保持播放**——
              // 音频元素 currentTime 继续推进，timeupdate 持续触发，歌词/MV/进度条
              // 时间线存活（AI 60s 长混音期间 UI 不会冻结）。
              // 音量用 ~400ms 渐出而非立即归零：automix 介入瞬间音量平滑衰减，
              // 不出现"刚介入就突然变轻"的硬切（用户明确要求曲线渐变）。
              if (source) {
                const activeGain = getActiveGain()
                const ctx = audioContextRef.current
                if (activeGain && ctx) {
                  const now = ctx.currentTime
                  activeGain.gain.cancelScheduledValues(now)
                  activeGain.gain.setValueAtTime(Math.max(activeGain.gain.value, 0.0001), now)
                  activeGain.gain.linearRampToValueAtTime(0.0001, now + 0.4)
                } else {
                  setDeckGain(getActiveGain(), source, 0)
                }
                debugLog('⏸️ [Transition] 源曲 deck 渐出静音（保持播放以驱动 UI 时间线），避免双重奏与介入音量突变')
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
                  const preSeek = Math.max(0, result.targetResumeTime - Math.max(0.5, overlap) * preSeekRatio)
                  if (Math.abs((target.currentTime || 0) - preSeek) > 0.05) target.currentTime = preSeek
                } catch (err) {
                  debugLog('⚠️ [Transition] resume 区域预载 seek 失败:', err)
                }
              }
              let handedOff = false
              let deckStarted = false

              // overlap handoff：缓冲结束前 overlap 秒启动 target deck。
              // deck 起始内容位置 = resume - overlap × 混音尾速度比（AI 路径），与混音尾
              // 正在播的内容**同位置同速**（混音尾 = target 内容以 source BPM 播放），
              // 交叉期间不重唱/不跳词；随后 playbackRate 渐回 1.0（post-settle）。
              // DSP 路径（ratio=1）退化为原 resume - overlap。
              const startDeckEarly = () => {
                if (deckStarted || handedOff) return
                deckStarted = true
                debugLog(`🎼 [Transition] overlap handoff：deck 提前 ${overlap.toFixed(2)}s 淡入（缓冲尾同步淡出）`)
                void (async () => {
                  try {
                    // 过渡已被取消/替换（如 seek/切歌）时不启动
                    if (executionRevision !== transitionExecutionRevisionRef.current) return
                    const speedRatio = typeof result.mixSpeedRatio === 'number' && result.mixSpeedRatio > 0
                      && Math.abs(result.mixSpeedRatio - 1) > 0.005
                      ? result.mixSpeedRatio
                      : 1
                    const deckStart = Math.max(0, result.targetResumeTime - overlap * speedRatio)
                    target.currentTime = deckStart
                    await waitForSeek(target, 400)
                    // 等待 deck 在 deckStart 位置具备可播数据（预载 seek 后仍可能未缓冲完）
                    await waitForPlayable(target, 3000)
                    if (handedOff || executionRevision !== transitionExecutionRevisionRef.current) return
                    const standbyGain = getStandbyGain()
                    setDeckGain(standbyGain, target, 0)
                    if (speedRatio !== 1 && 'preservePitch' in target) target.preservePitch = true
                    target.playbackRate = speedRatio
                    await target.play()
                    const ctx = audioContextRef.current
                    if (standbyGain && ctx) {
                      const now = ctx.currentTime
                      standbyGain.gain.cancelScheduledValues(now)
                      standbyGain.gain.setValueAtTime(0, now)
                      standbyGain.gain.linearRampToValueAtTime(1, now + overlap)
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
                    target.playbackRate = 1
                    console.error('❌ [Transition] overlap 提前启动目标失败:', err, alreadyPlaying ? '（deck 已在播放，保留接管）' : '')
                  }
                })()
              }

              handoff = () => {
                if (handedOff) return
                handedOff = true
                transitionBufferActiveRef.current = false
                if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current)
                transitionTimerRef.current = null
                if (transitionDeckStartTimerRef.current !== null) window.clearTimeout(transitionDeckStartTimerRef.current)
                transitionDeckStartTimerRef.current = null
                // 过渡已被取消/替换（如 seek/切歌）时不再启动 target
                if (executionRevision !== transitionExecutionRevisionRef.current) return
                if (overlap > 0 && deckStarted) {
                  // deck 已提前在 resume-overlap→resume 区间播放，缓冲结束即满增益 + 提交
                  debugLog('✅ [Transition] 过渡缓冲结束（overlap handoff），提交目标轨道')
                  target.playbackRate = 1 // post-settle 渐变兜底：确保原速交接
                  setDeckGain(getStandbyGain(), target, 1)
                  commitTransition(strategy, result.targetResumeTime, executionRevision)
                  return
                }
                debugLog('✅ [Transition] 过渡缓冲结束（ended 驱动），启动目标轨道')
                void (async () => {
                  try {
                    // 先定位再等 seek 完成，避免在未缓冲位置 play() 造成空隙
                    target.currentTime = result.targetResumeTime
                    await waitForSeek(target, 400)
                    // 等待当前位置数据就绪（AI 混音恢复点在目标曲深处，可能超出预缓冲）；
                    // 数据就绪前不 play，从根源消除"seek 到未缓冲位置 → 静音断开"的空窗。
                    await waitForPlayable(target, 3000)
                    setDeckGain(getStandbyGain(), target, 1) // 缓冲已结束，target 满增益
                    await target.play()
                    target.playbackRate = 1 // 兜底：确保下一曲以原速播放（post-settle 残留防护）
                    debugLog('   目标轨道开始播放，位置:', target.currentTime.toFixed(2), 's')
                  } catch (err) {
                    console.error('❌ [Transition] 目标轨道启动失败:', err)
                    setTransitionState('failed', {
                      isPlaying: false,
                      ended: true,
                      transitioning: false,
                      transitionStrategy: strategy,
                      fallbackReason: err instanceof Error ? err.message : 'target deck failed to start',
                    })
                    return
                  }
                  commitTransition(strategy, result.targetResumeTime, executionRevision)
                })()
              }
              if (overlap > 0) {
                // deck 提前启动 timer（缓冲结束前 overlap 秒）
                transitionDeckStartTimerRef.current = window.setTimeout(() => {
                  if (!handedOff) startDeckEarly()
                }, Math.max(0, result.remainingDuration - overlap) * 1000)
              }
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
        console.warn('⚠️ [Transition] 智能渲染不可用或缓冲未就绪，回退交叉淡化')
        strategy = 'fixed-crossfade'
        plan.strategy = 'fixed-crossfade'
        plan.fallbackReason = plan.fallbackReason || 'Rendered transition was not ready at playback time'
      }

      debugLog('🎵 [Transition] 开始标准交叉淡化过渡')
      target.currentTime = targetTime
      // gapless 也先以 0 增益启动 standby，随后在 gapless 分支做 60ms 淡入，
      // 避免以满音量硬起产生爆音（非 gapless 策略原本就是 0，语义不变）
      setDeckGain(getStandbyGain(), target, 0)
      debugLog('▶️ [Transition] 开始播放下一首歌曲...')
      await target.play()
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
          
          // When progress reaches 90%, send visualSwitchCommit to update UI early
          if (!visualSwitchSent && progress >= 0.9) {
            visualSwitchSent = true
            const visualCommit: TransitionCommit = {
              sourceTrackKey: currentMetadataRef.current?.trackKey || '',
              targetTrackKey: targetMetadata.trackKey || '',
              targetIndex: targetMetadata.index,
              targetTime: targetTime,
              strategy: strategy,
              isVisualSwitch: true,
            }
            emit({
              transitionProgress: progress,
              transitionDuration: visualDuration,
              visualSwitchCommit: visualCommit,
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
        
        // When progress reaches 90%, send visualSwitchCommit to update UI early
        if (!visualSwitchSent && progress >= 0.9) {
          visualSwitchSent = true
          const visualCommit: TransitionCommit = {
            sourceTrackKey: currentMetadataRef.current?.trackKey || '',
            targetTrackKey: targetMetadata.trackKey || '',
            targetIndex: targetMetadata.index,
            targetTime: targetTime,
            strategy: strategy,
            isVisualSwitch: true,
          }
          emit({
            transitionProgress: progress,
            transitionDuration: audioDuration,
            visualSwitchCommit: visualCommit,
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
      console.error('❌ [Transition] 过渡失败:', error)
      target.pause()
      setDeckGain(getStandbyGain(), target, 0)
      setDeckGain(getActiveGain(), source, 1)
      setTransitionState('failed', {
        transitioning: false,
        transitionStrategy: strategy,
        fallbackReason: error instanceof Error ? error.message : 'next deck failed to start',
      })
    } finally {
      transitionStartingRef.current = false
    }
  }, [commitTransition, ensureAudioGraph, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, runFallbackGainAnimation, setDeckGain, setTransitionState])

  const prepareAutoMix = useCallback(async () => {
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    
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
      settings.enableBeatMatching,
      settings.skipSilence,
      settings.minDuration,
      settings.maxDuration,
      settings.enhanced === true,
      settings.intensity,
      settings.aiMix === true,
    ].join(':')
    if (autoMixPreparationKeyRef.current === preparationKey) {
      debugLog('⏭️ [AutoMix] 相同歌曲组合已在准备或已就绪，跳过重复分析')
      return
    }
    autoMixPreparationKeyRef.current = preparationKey
    
    debugLog('✅ [AutoMix] 开始准备智能混音过渡')
    const revision = ++preparationRevisionRef.current
    preparationAbortRef.current?.abort()
    const controller = new AbortController()
    preparationAbortRef.current = controller
    setTransitionState('preparing-next', { transitioning: false, fallbackReason: undefined, transitionStartTime: null })
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
      
      // Try smart rendering if confidence is high and renderer available
      if ((plan.strategy === 'smart-rendered' || plan.strategy === 'smart-rendered-v2') && plan.confidence >= 0.5 && transitionRendererRef.current) {
        debugLog('🎨 [AutoMix] 尝试智能渲染（置信度 >= 0.5）...')
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
        }
      } else if ((plan.strategy === 'smart-rendered' || plan.strategy === 'smart-rendered-v2') && plan.confidence < 0.5) {
        debugLog('⚠️ [AutoMix] 置信度不足（< 0.5），回退到节拍交叉淡化')
        plan.strategy = 'beat-crossfade'
        plan.fallbackReason = 'Confidence below smart-render threshold; using beat-aligned crossfade'
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
      const animationStartTime = plan.v2?.aiMix === true
        ? plan.sourceStartTime + 60 - 20
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
      debugLog('✅ [AutoMix] 过渡已准备就绪（armed），等待播放到过渡点...')
    } catch (error) {
      if (controller.signal.aborted || revision !== preparationRevisionRef.current) return
      console.error('❌ [AutoMix] 准备过渡失败:', error)
      const active = getActiveAudio()
      const fallbackDuration = 4 // 固定 4 秒作为 fallback
      transitionPlanRef.current = {
        id: `${current.trackKey}->${next.trackKey}:fallback`,
        sourceTrackKey: current.trackKey,
        targetTrackKey: next.trackKey,
        sourceStartTime: Math.max(0, (active?.duration || current.duration || 0) - fallbackDuration),
        sourceEndTime: active?.duration || current.duration || 0,
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
        fallbackReason: error instanceof Error ? error.message : 'analysis failed',
        analysisVersion: 'unavailable',
        rendererVersion: 'browser-crossfade-v1',
      }
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

  const prepareGaplessTransition = useCallback(async () => {
    const current = currentMetadataRef.current
    const next = nextMetadataRef.current
    
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
      prepareAudioUrl: async (song) => song.url,
      onStateChange: state => {
        const { transitionState, ...extra } = state
        if (transitionState) setTransitionState(transitionState, extra)
        else emit(extra)
      },
    })

    // 首选预热/边界调度/ended 拼接逻辑已抽离到 src/services/gapless/seamlessJoinController.ts
    // （createSeamlessJoinController），本 effect 只负责创建控制器并接线。
    seamlessJoinControllerRef.current = createSeamlessJoinController({
      getActiveAudio,
      getStandbyAudio,
      getStandbyGain,
      setDeckGain,
      isGaplessEnabled: () => gaplessRef.current.enabled,
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
      // 专辑播放检测（三方案分流依据）：当前曲与下一曲属于同一专辑
      // （albumId 都存在且相等）→ 专辑场景；否则为非专辑（普通列表）场景。
      const currentMeta = currentMetadataRef.current
      const nextMeta = nextMetadataRef.current
      const albumPlayback = Boolean(currentMeta?.albumId && nextMeta?.albumId && currentMeta.albumId === nextMeta.albumId)
      if (standby?.src && transitionStateRef.current !== 'running-transition') {
        if (autoMixRef.current.enabled && plan && (transitionStateRef.current === 'armed' || transitionStateRef.current === 'playing')) {
          if (active.currentTime >= plan.sourceStartTime) {
            debugLog('🎬 [AutoMix] 到达过渡点！')
            debugLog('   当前时间:', active.currentTime.toFixed(2), 's')
            debugLog('   过渡开始时间:', plan.sourceStartTime.toFixed(2), 's')
            debugLog('   过渡策略:', plan.strategy)
            debugLog('   过渡状态:', transitionStateRef.current)
            void startTransition(plan.strategy, plan)
          }
        } else if (crossfadeRef.current.enabled && remaining <= Math.max(0.25, crossfadeRef.current.duration)) {
          debugLog('🎬 [Crossfade] 到达交叉淡化点，剩余时间:', remaining.toFixed(2), 's')
          void startTransition('fixed-crossfade')
        } else if (gaplessRef.current.enabled && Number.isFinite(remaining)) {
          // Gapless 三方案分流已抽离到 src/services/gapless/seamlessJoinController.ts：
          //   remaining ∈ (1, 20] 且专辑 → 预热缓存前 10s（保证首选拼接就绪）
          //   remaining ∈ (0, 1]     → scheduleBoundary（首选直接拼接 / 备选 60ms 淡入淡出）
          // 控制器内部自带 hasActiveTransition / boundaryScheduled 互斥检查。
          const controller = seamlessJoinControllerRef.current
          if (controller) {
            if (remaining > 1 && remaining <= GAPLESS_SEAMLESS_WARMUP_SECONDS && albumPlayback) {
              controller.warmup()
            } else if (remaining > 0 && remaining <= 1) {
              controller.scheduleBoundary({ active, remaining, albumPlayback })
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
      const quantizedTime = Math.round(active.currentTime * 4) / 4
      emit({ currentTime: quantizedTime, duration: active.duration || 0, buffered })
    }

    const handlePlay = (event: Event) => {
      if (event.currentTarget === getActiveAudio()) emit({ isPlaying: true, ended: false })
    }
    const handlePause = (event: Event) => {
      if (
        event.currentTarget === getActiveAudio()
        && transitionStateRef.current !== 'committed'
        && transitionStateRef.current !== 'running-transition'
      ) {
        const active = getActiveAudio()
        emit({
          isPlaying: false,
          currentTime: active?.currentTime || 0,
          duration: active?.duration || 0,
        })
      }
    }
    const handleMetadata = (event: Event) => {
      if (event.currentTarget === getActiveAudio()) emit({ duration: getActiveAudio()?.duration || 0 })
    }
    const handleEnded = (event: Event) => {
      debugLog('🏁 [Event] handleEnded 被触发')
      debugLog('   当前加载状态:', isLoadingRef.current)
      debugLog('   事件目标是活动音频?', event.currentTarget === getActiveAudio())
      
      if (isLoadingRef.current || event.currentTarget !== getActiveAudio()) return

      // 过渡缓冲播放期间（AI 长混音等），源曲 deck 保持播放以驱动 UI 时间线，
      // 会先于缓冲自然播完触发 ended——此时不能提前提交（缓冲仍是权威音频源），
      // 由缓冲 ended → handoff 精确接管。
      if (transitionBufferActiveRef.current) {
        debugLog('⏸️ [Event] 过渡缓冲仍在播放，忽略源曲 ended（由 handoff 接管）')
        return
      }

      // A timer normally performs the boundary handoff. If `ended` wins the race, cancel the
      // timer and execute immediately so a delayed callback cannot start the same deck twice.
      // （边界 timer 与竞态互斥由 seamlessJoinController 管理）
      seamlessJoinControllerRef.current?.cancelBoundaryTimer()

      const standby = getStandbyAudio()
      debugLog('🔍 [Event] 检查过渡状态:', transitionStateRef.current)
      debugLog('   待机音频:', standby ? '存在' : '不存在')
      debugLog('   待机音频暂停?', standby?.paused)
      debugLog('   待机音频 src:', standby?.src || '无')

      // ── 首选：无缝拼接（头尾都不掐）──
      // source 已完整播到 ended。standby 可能处于三种就绪形态：PREROLL 静音预启动中、
      // 预热完成后暂停回拨 0、或已缓冲暂停。控制器统一"确保 standby 从头播放"：
      // 未在播则启动（0 位置已缓冲 → 快），回拨 0 后瞬时切换增益——
      // 不做任何淡入淡出、不掐 source 尾部、不跳过 standby 开头。
      if (seamlessJoinControllerRef.current?.onEnded(standby)) return

      if (transitionStateRef.current === 'running-transition' && standby && !standby.paused) {
        debugLog('✅ [Event] 过渡正在进行中，提交过渡')
        const strategy = transitionPlanRef.current?.strategy || (crossfadeRef.current.enabled ? 'fixed-crossfade' : 'gapless')
        commitTransition(strategy, standby.currentTime, transitionExecutionRevisionRef.current)
      } else if (standby?.src && gaplessRef.current.enabled) {
        debugLog('⏭️ [Event] 待机音频就绪且无缝衔接已启用')
        if (gaplessIntegrationRef.current) {
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
      }
    }

    for (const audio of [primary, secondary]) {
      audio.addEventListener('timeupdate', handleTimeUpdate)
      audio.addEventListener('play', handlePlay)
      audio.addEventListener('pause', handlePause)
      audio.addEventListener('loadedmetadata', handleMetadata)
      audio.addEventListener('ended', handleEnded)
      audio.addEventListener('error', handleError)
    }

    return () => {
      preparationAbortRef.current?.abort()
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
      gaplessIntegrationRef.current?.dispose()
      gaplessIntegrationRef.current = null
      for (const audio of [primary, secondary]) {
        audio.removeEventListener('timeupdate', handleTimeUpdate)
        audio.removeEventListener('play', handlePlay)
        audio.removeEventListener('pause', handlePause)
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
      gainNodesRef.current = [null, null]
      masterGainRef.current = null
    }
  }, [commitTransition, emit, getActiveAudio, getStandbyAudio, setTransitionState, startTransition])

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
    cancelScheduledTransition('transition settings changed')
    if (autoMixSettings.enabled) {
      void prepareAutoMix()
      return
    }
    setTransitionState('armed', {
      transitioning: false,
      fallbackReason: undefined,
      transitionStrategy: crossfadeSettings.enabled
        ? 'fixed-crossfade'
        : gaplessSettings.enabled
          ? 'gapless'
          : 'none',
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
    crossfadeSettings.enabled,
    crossfadeSettings.duration,
    gaplessSettings.enabled,
    gaplessSettings.albumGapless,
    cancelScheduledTransition,
    prepareAutoMix,
    setTransitionState,
  ])

  const preloadNext = useCallback((input: string | PreloadTrack) => {
    const track = asPreloadTrack(input)
    debugLog('📥 [Preload] preloadNext 被调用')
    debugLog('   下一首歌曲:', track)
    const standby = getStandbyAudio()
    if (!standby || !track.url) {
      debugLog('❌ [Preload] 缺少待机音频元素或 URL')
      return
    }
    const existingNext = nextMetadataRef.current
    const sameTrackAlreadyAttached = Boolean(
      existingNext
      && existingNext.url === track.url
      && existingNext.trackKey === track.trackKey
      && existingNext.index === track.index
      && (standby.currentSrc || standby.getAttribute('src'))
      && standby.networkState !== HTMLMediaElement.NETWORK_EMPTY
      && !standby.error
    )
    if (sameTrackAlreadyAttached) {
      // Queue-related effects can run more than once for the same next track. Keep the
      // existing media pipeline and any in-flight canplay/AutoMix preparation intact.
      nextMetadataRef.current = { ...existingNext, ...track }
      debugLog('♻️ [Preload] 下一首未变化，复用现有待机媒体管线')
      return
    }

    // Preserve the old standby source until assigning the replacement below. Clearing
    // it first would make Chromium tear down one pipeline and immediately create another.
    cancelScheduledTransition('next track changed', true)
    nextMetadataRef.current = { ...track }
    standby.pause()
    standby.currentTime = 0
    standby.playbackRate = 1 // post-settle 残留防护：新歌一律原速
    standby.src = track.url
    standby.preload = 'auto'
    setDeckGain(getStandbyGain(), standby, 0)
    debugLog('⏳ [Preload] 开始加载下一首歌曲...')
    setTransitionState('preparing-next', { transitioning: false, transitionStartTime: null })
    const isCurrentPreload = () => Boolean(
      nextMetadataRef.current?.url === track.url
      && nextMetadataRef.current?.trackKey === track.trackKey
      && nextMetadataRef.current?.index === track.index
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
      debugLog('🎵 [Preload] 预加载歌曲就绪')
      if (autoMixRef.current.enabled) {
        debugLog('🎵 [Preload] autoMix 已启用，调用 prepareAutoMix()')
        void prepareAutoMix()
      }
      else if (gaplessRef.current.enabled && gaplessIntegrationRef.current) {
        debugLog('🎵 [Preload] 准备无缝衔接，调用 GaplessIntegration')
        void prepareGaplessTransition()
      }
      else {
        debugLog('🎵 [Preload] 无衔接方案，歌曲已 armed')
        setTransitionState('armed', {
          transitionStrategy: crossfadeRef.current.enabled ? 'fixed-crossfade' : 'none',
        })
      }
    }
    const failed = () => {
      cleanupReady()
      if (preloadReadyCleanupRef.current === cleanupReady) preloadReadyCleanupRef.current = null
      if (!isCurrentPreload()) return
      console.warn('[Preload] Next track media failed to load or timed out; normal end-of-track loading will be used')
      nextMetadataRef.current = null
      standby.pause()
      standby.removeAttribute('src')
      standby.load()
      const active = getActiveAudio()
      setTransitionState(active?.src ? 'playing' : 'idle', {
        transitioning: false,
        transitionStartTime: null,
        fallbackReason: 'next track preload failed',
      })
    }
    preloadReadyCleanupRef.current?.()
    preloadReadyCleanupRef.current = cleanupReady
    standby.addEventListener('canplay', ready, { once: true })
    standby.addEventListener('error', failed, { once: true })
    timeoutId = window.setTimeout(failed, PRELOAD_MEDIA_LOAD_TIMEOUT_MS)
    standby.load()
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
      active.removeAttribute('src')
      active.load()
      // 重置 GaplessIntegration，停止所有预加载的音频
      if (gaplessIntegrationRef.current) {
        debugLog('🧹 [LoadAndPlay] 重置 GaplessIntegration')
        gaplessIntegrationRef.current.reset()
      }
      active.src = url
      active.preload = 'auto'
      active.playbackRate = 1 // post-settle 残留防护：新歌一律原速
      currentMetadataRef.current = { url, ...track }
      setAudioElement(active)
      await ensureAudioGraph()
      if (masterGainRef.current && audioContextRef.current) {
        masterGainRef.current.gain.setValueAtTime(volumeRef.current, audioContextRef.current.currentTime)
      }
      setDeckGain(getActiveGain(), active, 1)
      setDeckGain(getStandbyGain(), standby, 0)
      debugLog('⏳ [LoadAndPlay] 加载音频文件...')
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
        const failed = () => settle(() => reject(active.error || new Error('media load failed')))
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
      if (loadRevision !== currentLoadRevisionRef.current) return false
      debugLog('▶️ [LoadAndPlay] 开始播放...')
      await active.play()
      if (loadRevision !== currentLoadRevisionRef.current) return false
      isLoadingRef.current = false
      debugLog('✅ [LoadAndPlay] 播放成功')
      setTransitionState('playing', { isPlaying: true, duration: active.duration || track?.duration || 0, ended: false })
      
      // Prepare auto mix for next track if available
      if (nextMetadataRef.current?.url && autoMixRef.current.enabled) {
        debugLog('🎵 [LoadAndPlay] 检测到下一首歌曲且 autoMix 已启用，调用 prepareAutoMix()')
        void prepareAutoMix()
      } else {
        debugLog('⏭️ [LoadAndPlay] 下一首:', nextMetadataRef.current ? '存在' : '不存在', ', autoMix:', autoMixRef.current.enabled ? '启用' : '禁用')
      }
      return true
    } catch (error) {
      if (loadRevision !== currentLoadRevisionRef.current) return false
      const err = error instanceof Error ? error : null
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
  }, [cancelScheduledTransition, ensureAudioGraph, getActiveAudio, getActiveGain, getStandbyAudio, getStandbyGain, setDeckGain, setTransitionState, prepareAutoMix])

  const togglePlay = useCallback(async () => {
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
      if (active.paused) {
        await active.play()
        setTransitionState('playing', { isPlaying: true })
        if (nextMetadataRef.current?.url) {
          if (autoMixRef.current.enabled) void prepareAutoMix()
          else if (gaplessRef.current.enabled) void prepareGaplessTransition()
          else setTransitionState('armed', {
            isPlaying: true,
            transitionStrategy: crossfadeRef.current.enabled
              ? 'fixed-crossfade'
              : gaplessRef.current.enabled
                ? 'gapless'
                : 'none',
          })
        }
      } else {
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
  }, [cancelScheduledTransition, emit, ensureAudioGraph, getActiveAudio, prepareAutoMix, prepareGaplessTransition, setTransitionState])

  const seek = useCallback((time: number) => {
    const active = getActiveAudio()
    if (!active) return
    const wasPlaying = !active.paused
    cancelScheduledTransition('seek changed transition timing')
    active.currentTime = Math.max(0, Math.min(time, active.duration || 0))
    // seek 越过已计划的过渡点后，旧计划已不可用（播放过期过渡会卡住/错位）：
    // 清空计划，让 prepareAutoMix 从当前位置重新规划（v1 行为：立刻可从当前进度 automix）。
    const plan = transitionPlanRef.current
    if (plan && active.currentTime >= plan.sourceStartTime) {
      transitionPlanRef.current = null
    }
    emit({ currentTime: active.currentTime, duration: active.duration || 0 })
    if (nextMetadataRef.current?.url && autoMixRef.current.enabled) {
      void prepareAutoMix()
    } else if (wasPlaying && active.paused) {
      void active.play().catch(() => undefined)
    }
  }, [cancelScheduledTransition, emit, getActiveAudio, prepareAutoMix])

  const setVolume = useCallback((volume: number) => {
    const clamped = Math.max(0, Math.min(1, volume))
    volumeRef.current = clamped
    const context = audioContextRef.current
    const master = masterGainRef.current
    if (context && master) master.gain.setValueAtTime(clamped, context.currentTime)
    else {
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
          }
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
    preloadNext,
    cancelTransition: cancelScheduledTransition,
    getAudioElement: getActiveAudio,
    audioElement,
    playbackTimeStore,
    analyserNode,
    nextAudioElement: getStandbyAudio(),
    setPlayAtCallback,
    resetGaplessIntegration,
    adoptExternalAudio,
  }
}
