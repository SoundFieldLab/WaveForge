import { debugLog } from '../utils/debugLog'

/**
 * Album Gapless - 专辑无缝播放
 * 基于 Mineradio 的实现，使用尾部静音检测和 Equal Power Crossfade
 */

export interface AlbumGaplessSong {
  key: string
  url: string
  albumId?: string
  albumCover?: string
  duration?: number
}

export interface AlbumGaplessPreload {
  index: number
  key: string
  token: number
  serial: number
  media: HTMLAudioElement
  audioUrl: string
  song: AlbumGaplessSong
  sourceKey: string
  sourceIndex: number
  sourceDuration: number
  armedAt: number
  
  // 预加载状态
  prerollStarted: boolean
  prerollPlaying: boolean
  prerollFailed: boolean
  
  // 混音状态
  mixPending: boolean
  mixStarted: boolean
  mixStartedAt: number
  mixDurationMs: number
  fadeCompleted: boolean
  
  // 切换状态
  transitionToken?: number
  transitionIndex?: number
  previousAudio?: HTMLAudioElement
  releaseReason?: string
  
  // 静音检测
  quietSince: number
  directQuietSince: number
  
  // 内部
  fadeFrame?: number
  fadeWatchdogTimer?: number
  fadeResolve?: ((ok: boolean) => void) | null
  handoffTimer?: number
  cleanupTimer?: number
}

export interface AlbumGaplessState {
  enabled: boolean
  albumKey: string
  context: any
  disabledAlbumKey: string
  preload: AlbumGaplessPreload | null
  handoff: boolean
  serial: number
  monitorTimer?: number
}

// 常量配置
const ALBUM_GAPLESS_PREROLL_SECONDS = 8.5
const ALBUM_GAPLESS_MIX_SECONDS = 1.8
const ALBUM_GAPLESS_MIN_MIX_MS = 720
// 混音收尾余量（ms）：淡化必须在 source 结束前完成，预留少量余量吸收音频时钟漂移
const ALBUM_GAPLESS_MIX_END_MARGIN_MS = 80
// 混音时长绝对下限（ms）：剩余时间极短时仍保留最小淡化时长，配合 ended 兜底收尾
const ALBUM_GAPLESS_ABSOLUTE_MIN_MIX_MS = 60
const ALBUM_GAPLESS_MUTED_PREROLL_SECONDS = 2.2
const ALBUM_GAPLESS_BOUNDARY_RELEASE_SECONDS = 1.8
const ALBUM_GAPLESS_LONG_SILENCE_SECONDS = 1.05
const ALBUM_GAPLESS_BIND_AFTER_MIX_MS = 40
const ALBUM_GAPLESS_GAIN_STEP_MS = 8

// 静音检测阈值
const ALBUM_GAPLESS_SILENCE_LEVEL = 0.018
const ALBUM_GAPLESS_DIRECT_SILENCE_RMS = 0.0065
const ALBUM_GAPLESS_DEEP_SILENCE_RMS = 0.0032
const ALBUM_GAPLESS_DIRECT_SILENCE_PEAK = 0.030
const ALBUM_GAPLESS_DEEP_SILENCE_PEAK = 0.017
const ALBUM_GAPLESS_RESIDUAL_FREQ_AVG = 0.010
const ALBUM_GAPLESS_RESIDUAL_FREQ_PEAK = 0.075

// 静音检测持续时间
const ALBUM_GAPLESS_SILENCE_HOLD_MS = 180
const ALBUM_GAPLESS_FAST_SILENCE_HOLD_MS = 48
const ALBUM_GAPLESS_DIRECT_SILENCE_HOLD_MS = 112
const ALBUM_GAPLESS_DEEP_SILENCE_HOLD_MS = 56

export class AlbumGaplessService {
  private state: AlbumGaplessState = {
    enabled: false,
    albumKey: '',
    context: null,
    disabledAlbumKey: '',
    preload: null,
    handoff: false,
    serial: 0,
  }

  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private tailTimeData: Uint8Array | null = null
  private tailFreqData: Uint8Array | null = null
  private directJoinPreferred = false  // 专辑场景由第一种方案（直接拼接）接管时置位

  constructor(
    private deps: {
      getCurrentAudio: () => HTMLAudioElement | null
      getCurrentTime: () => number
      getCurrentIndex: () => number
      getCurrentTrackKey: () => string
      getTargetVolume: () => number
      setOutputGain: (gain: number) => void
      getOutputGain: () => number
      getPlayQueue: () => any[]
      canAdvance: (index: number) => boolean
      playAt: (index: number, options: any) => Promise<boolean>
      onTransitionStart?: (targetTrackKey: string, duration: number) => void
      onTransitionProgress?: (progress: number) => void
      onTransitionCancel?: () => void
    }
  ) {}

  initAudioContext(audioCtx: AudioContext, analyser: AnalyserNode): void {
    this.audioContext = audioCtx
    this.analyser = analyser
  }

  setEnabled(enabled: boolean, context?: any, albumKey?: string): boolean {
    // 第三种方案（交叉淡化）门控：专辑场景由第一种方案（直接拼接，头尾都不掐）
    // 接管，albumGapless 交叉淡化让路——即使被误调 setEnabled(true) 也不激活，
    // 避免其 monitor 在歌曲尾部抢先 startMix，挡住 useAudioPlayer 的首选拼接。
    if (this.directJoinPreferred) {
      this.state.enabled = false
      this.state.context = null
      this.state.albumKey = ''
      if (this.state.preload?.mixStarted) {
        this.restoreOutgoingAudio(120)
      }
      this.clearPreload('direct-join-preferred')
      return false
    }
    this.state.enabled = !!enabled
    this.state.context = context || null
    this.state.albumKey = enabled && albumKey ? albumKey : ''

    if (!this.state.enabled || !this.state.albumKey) {
      this.state.enabled = false
      if (this.state.preload?.mixStarted) {
        this.restoreOutgoingAudio(120)
      }
      this.clearPreload('disabled')
      return false
    }

    return true
  }

  // 专辑场景标记"第一种方案（直接拼接）优先"：置位后本服务（第三种方案）
  // 不再激活；非专辑场景可清除以恢复 albumGapless 交叉淡化能力。
  setDirectJoinPreferred(preferred: boolean): void {
    this.directJoinPreferred = preferred
    if (preferred) this.setEnabled(false, undefined, '')
  }

  getSongAlbumKey(song: AlbumGaplessSong): string {
    return song.albumId ? `${song.albumId}:${song.albumCover || ''}` : ''
  }

  canAdvanceInAlbum(currentIndex: number, queue: AlbumGaplessSong[]): boolean {
    if (!this.state.enabled || !this.state.albumKey) return false
    if (currentIndex < 0 || currentIndex + 1 >= queue.length) return false
    
    const currentKey = this.getSongAlbumKey(queue[currentIndex])
    const nextKey = this.getSongAlbumKey(queue[currentIndex + 1])
    
    return currentKey === this.state.albumKey && nextKey === this.state.albumKey
  }

  private isCurrentPreload(preload: AlbumGaplessPreload): boolean {
    return this.state.preload === preload
      && preload.serial === this.state.serial
      && preload.sourceKey === this.deps.getCurrentTrackKey()
      && preload.sourceIndex === this.deps.getCurrentIndex()
      && preload.index === preload.sourceIndex + 1
  }

  // Equal Power 增益曲线
  private equalPowerGains(progress: number, outgoingMax: number, incomingMax: number): { outgoing: number; incoming: number } {
    const theta = progress * Math.PI * 0.5
    return {
      outgoing: outgoingMax * Math.cos(theta),
      incoming: incomingMax * Math.sin(theta),
    }
  }

  // Equal Power Entry Progress（带缓动）
  private equalPowerEntryProgress(elapsedMs: number, durationMs: number): number {
    const progress = Math.max(0, Math.min(1, elapsedMs / Math.max(1, durationMs)))
    return progress * progress * (3 - 2 * progress)
  }

  // 尾部静音检测
  // 结果对象跨 tick 复用：监控循环每 70ms 调用一次，避免持续分配临时对象
  private tailProbeResult = { smoothedQuiet: false, directQuiet: false, deepQuiet: false, residualTail: false }

  probeTailSilence(remaining: number): {
    smoothedQuiet: boolean
    directQuiet: boolean
    deepQuiet: boolean
    residualTail: boolean
  } {
    const audio = this.deps.getCurrentAudio()
    const result = this.tailProbeResult
    if (!audio || !this.audioContext || !this.analyser) {
      result.smoothedQuiet = false
      result.directQuiet = false
      result.deepQuiet = false
      result.residualTail = false
      return result
    }

    // 初始化缓冲区
    if (!this.tailTimeData) {
      this.tailTimeData = new Uint8Array(this.analyser.frequencyBinCount)
    }
    if (!this.tailFreqData) {
      this.tailFreqData = new Uint8Array(this.analyser.frequencyBinCount)
    }

    // 获取时域和频域数据
    this.analyser.getByteTimeDomainData(this.tailTimeData)
    this.analyser.getByteFrequencyData(this.tailFreqData)

    // 计算 RMS 和峰值
    let sumSquares = 0
    let peak = 0
    for (let i = 0; i < this.tailTimeData.length; i++) {
      const normalized = (this.tailTimeData[i] - 128) / 128
      sumSquares += normalized * normalized
      peak = Math.max(peak, Math.abs(normalized))
    }
    const rms = Math.sqrt(sumSquares / this.tailTimeData.length)

    // 计算频谱残留
    let freqSum = 0
    let freqPeak = 0
    for (let i = 0; i < this.tailFreqData.length; i++) {
      const normalized = this.tailFreqData[i] / 255
      freqSum += normalized
      freqPeak = Math.max(freqPeak, normalized)
    }
    const freqAvg = freqSum / this.tailFreqData.length

    result.smoothedQuiet = rms < ALBUM_GAPLESS_SILENCE_LEVEL && peak < ALBUM_GAPLESS_SILENCE_LEVEL
    result.directQuiet = rms < ALBUM_GAPLESS_DIRECT_SILENCE_RMS && peak < ALBUM_GAPLESS_DIRECT_SILENCE_PEAK
    result.deepQuiet = rms < ALBUM_GAPLESS_DEEP_SILENCE_RMS && peak < ALBUM_GAPLESS_DEEP_SILENCE_PEAK
    result.residualTail = freqAvg > ALBUM_GAPLESS_RESIDUAL_FREQ_AVG || freqPeak > ALBUM_GAPLESS_RESIDUAL_FREQ_PEAK

    return result
  }

  // Equal Power Crossfade
  async runBalancedCrossfade(preload: AlbumGaplessPreload, durationMs: number): Promise<boolean> {
    if (!preload?.media) return false

    const media = preload.media
    const startCurrent = this.deps.getOutputGain()
    const initialTarget = Math.max(0.0001, this.deps.getTargetVolume())
    const outgoingRatio = Math.max(0, Math.min(1, startCurrent / initialTarget))

    try {
      media.muted = false
      media.volume = 0
    } catch (e) {
      console.warn('[AlbumGapless] 设置初始音量失败', e)
    }

    const started = performance.now()
    durationMs = Math.max(1, durationMs)
    preload.fadeCompleted = false

    return new Promise((resolve) => {
      let settled = false
      preload.fadeResolve = resolve

      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        
        if (preload.fadeResolve === resolve) preload.fadeResolve = null
        if (preload.fadeFrame) cancelAnimationFrame(preload.fadeFrame)
        if (preload.fadeWatchdogTimer) clearInterval(preload.fadeWatchdogTimer)
        
        preload.fadeFrame = 0
        preload.fadeWatchdogTimer = 0
        preload.fadeCompleted = !!ok
        resolve(!!ok)
      }

      const applyStep = (nowMs: number) => {
        if (settled || !preload.mixStarted || this.state.preload !== preload) {
          finish(false)
          return
        }

        const elapsedMs = Math.max(0, Math.min(durationMs, nowMs - started))
        const t = elapsedMs / durationMs
        const curveProgress = this.equalPowerEntryProgress(elapsedMs, durationMs)
        const liveTarget = this.deps.getTargetVolume()
        const gains = this.equalPowerGains(curveProgress, liveTarget * outgoingRatio, liveTarget)
        this.deps.onTransitionProgress?.(t)

        this.deps.setOutputGain(gains.outgoing)
        try {
          media.muted = false
          media.volume = gains.incoming
        } catch (e) {
          console.warn('[AlbumGapless] 调整音量失败', e)
        }

        // 兜底：混音时长被 remaining 截断后，source 仍可能在淡化中途先结束。
        // 此时直接完成混音，避免增益曲线在 source 已结束后继续跑。
        const outgoingMedia = this.deps.getCurrentAudio()
        const sourceEnded = !!outgoingMedia?.ended || !!media.ended
        if (t >= 1 || sourceEnded) {
          if (sourceEnded) {
            // source 提前结束：定格 incoming 满音量完成收尾，不再沿曲线跳变；
            // masterGain 保持当前帧的值（不再归零），避免上层接管前出现静音窗口。
            try {
              media.muted = false
              media.volume = liveTarget
            } catch (e) {
              console.warn('[AlbumGapless] 设置最终音量失败', e)
            }
            this.deps.onTransitionProgress?.(1)
          } else {
            // 混音正常完成：不把 masterGain 瞬间归零。主增益保持此刻剩余值，
            // 由已满音量的 preload.media 继续出声，直到上层 adoptExternalAudio
            // 完成接管（standby deck 重新 load + canplay 的等待期内不再静音）。
            try {
              media.muted = false
              media.volume = liveTarget
            } catch (e) {
              console.warn('[AlbumGapless] 设置最终音量失败', e)
            }
          }
          
          // 暂停旧音频
          const oldAudio = this.deps.getCurrentAudio()
          if (oldAudio && !oldAudio.paused) {
            debugLog('[AlbumGapless] 混音完成，暂停旧音频')
            oldAudio.pause()
          }
          
          finish(true)
        }
      }

      const tick = (nowMs: number) => {
        applyStep(nowMs)
        if (!settled) preload.fadeFrame = requestAnimationFrame(tick)
      }

      // 主驱动：rAF（~60fps）驱动音量赋值。此前 setInterval 与 rAF 双驱动，
      // 让 applyStep 以 ~125Hz 重复执行（1.8s 混音约 300+ 次），白白增加主线程
      // 负载。改为仅作超时看门狗：rAF 被浏览器/Electron 节流或暂停时兜底完成
      // 混音，不参与常规音量赋值。
      preload.fadeWatchdogTimer = window.setInterval(() => {
        if (settled) return
        const elapsedMs = performance.now() - started
        // 仅当混音已到期（rAF 未能在 t>=1 收尾）时才调用一次 applyStep 兜底；
        // 正常情况下 rAF 会在 t>=1 时 finish，看门狗不驱动任何音量变化。
        if (elapsedMs >= durationMs) {
          applyStep(performance.now())
        }
      }, ALBUM_GAPLESS_GAIN_STEP_MS)

      preload.fadeFrame = requestAnimationFrame(tick)
    })
  }

  // 开始混音
  async startMix(preload: AlbumGaplessPreload, reason: string, remaining?: number): Promise<boolean> {
    if (!preload?.media || !this.isCurrentPreload(preload) || preload.mixStarted || preload.mixPending || this.state.handoff) {
      return false
    }

    if (!this.deps.canAdvance(this.deps.getCurrentIndex())) {
      return false
    }

    const outgoingMedia = this.deps.getCurrentAudio()
    const currentIndex = this.deps.getCurrentIndex()

    preload.mixPending = true
    preload.releaseReason = reason

    // 如果需要重置，暂停并重置到开头
    if ((reason === 'boundary-crossmix-reset' || 
         reason === 'tail-silence-fast-crossmix' || 
         reason === 'tail-direct-silence-crossmix') && 
        preload.prerollStarted) {
      try {
        preload.media.pause()
        preload.media.currentTime = 0
      } catch (e) {
        console.warn('[AlbumGapless] 重置预加载失败', e)
      }
      preload.prerollPlaying = false
    }

    try {
      preload.media.muted = false
      preload.media.volume = 0
      await preload.media.play()
    } catch (err) {
      preload.mixPending = false
      preload.prerollFailed = true
      console.warn('[AlbumGapless] crossmix 开始失败:', err)
      return false
    }

    preload.mixPending = false
    preload.mixStarted = true
    preload.mixStartedAt = performance.now()
    preload.transitionToken = currentIndex
    preload.transitionIndex = currentIndex
    preload.previousAudio = outgoingMedia || undefined

    // 计算混音时长：淡化必须在 source 结束前完成，mixMs 上限受剩余时间约束
    let mixMs = Math.round(ALBUM_GAPLESS_MIX_SECONDS * 1000)
    if (isFinite(remaining || 0) && (remaining || 0) > 0) {
      // 预留少量余量吸收音频时钟漂移；剩余时间不足以支撑
      // ALBUM_GAPLESS_MIN_MIX_MS 时允许取更短的淡化时长，
      // 避免交叉淡化在 source 结束后还在跑、incoming 增益曲线中途跳变爆音。
      const remainingCap = Math.max(
        ALBUM_GAPLESS_ABSOLUTE_MIN_MIX_MS,
        Math.round((remaining || 0) * 1000) - ALBUM_GAPLESS_MIX_END_MARGIN_MS
      )
      mixMs = Math.min(mixMs, remainingCap)
      mixMs = Math.max(mixMs, Math.min(ALBUM_GAPLESS_MIN_MIX_MS, remainingCap))
    }
    preload.mixDurationMs = mixMs
    this.deps.onTransitionStart?.(preload.key, mixMs / 1000)

    const completed = await this.runBalancedCrossfade(preload, mixMs)

    if (!completed) {
      this.deps.onTransitionCancel?.()
      this.restoreOutgoingAudio(120)
      this.clearPreload('mix-cancelled')
      return false
    }

    if (this.state.preload !== preload || !preload.fadeCompleted) {
      return false
    }

    // 立即切换到下一首（不延迟）
    debugLog('[AlbumGapless] 混音完成，立即切换到下一首')
    void this.startHandoff(preload, reason)

    return true
  }

  // 切换到下一首
  async startHandoff(preload: AlbumGaplessPreload, reason: string): Promise<boolean> {
    if (!preload || this.state.preload !== preload) return false

    const currentIndex = this.deps.getCurrentIndex()
    if (preload.index !== currentIndex + 1) {
      this.clearPreload('handoff-invalid')
      return false
    }

    if (!preload.media) {
      // 混音完成时 masterGain 不再归零（保持淡化剩余值）；若 preload.media
      // 已缺失无法接管，需手动恢复主增益，避免图形输出停留在静音电平。
      debugLog('[AlbumGapless] handoff 时预加载媒体缺失，恢复输出增益')
      this.deps.setOutputGain(this.deps.getTargetVolume())
      this.clearPreload('handoff-no-media')
      return false
    }

    this.state.handoff = true
    this.consumePreload()

    try {
      // Keep the position reached during mixing; rewinding here replays an intro
      // the listener has already heard and can leave the mixed deck orphaned.
      
      const success = await this.deps.playAt(preload.index, {
        albumGaplessHandoff: true,
        albumGaplessMixed: !!preload.mixStarted,
        preloadedAudio: preload.media,
        preloadedAudioUrl: preload.audioUrl,
      })

      if (!success) {
        // The handoff was rejected; release the preloaded element's media
        // buffer so it does not stay pinned as an orphan.
        try {
          preload.media.pause()
          preload.media.removeAttribute('src')
          preload.media.load()
        } catch {
          // The element may already have been released.
        }
        // 接管被拒绝：混音已完成且旧音频已暂停，恢复主增益让回退路径有声
        this.deps.setOutputGain(this.deps.getTargetVolume())
      }

      return success
    } catch (err) {
      console.warn('[AlbumGapless] handoff 失败:', err)
      try {
        preload.media.pause()
        preload.media.removeAttribute('src')
        preload.media.load()
      } catch {
        // The element may already have been released.
      }
      this.deps.setOutputGain(this.deps.getTargetVolume())
      return false
    } finally {
      this.state.handoff = false
    }
  }

  // 开始预加载
  startPreroll(preload: AlbumGaplessPreload): void {
    if (!preload || preload.prerollStarted) return
    
    preload.prerollStarted = true
    try {
      preload.media.muted = true
      preload.media.volume = 0
      preload.media.play().then(() => {
        preload.prerollPlaying = true
      }).catch(() => {
        preload.prerollFailed = true
      })
    } catch (e) {
      preload.prerollFailed = true
    }
  }

  // 监控循环
  armMonitor(token: number): void {
    if (this.state.monitorTimer) {
      clearInterval(this.state.monitorTimer)
    }

    this.state.monitorTimer = window.setInterval(() => {
      const preload = this.state.preload
      if (!preload || preload.token !== token || !this.isCurrentPreload(preload) || !this.deps.canAdvance(this.deps.getCurrentIndex())) {
        this.clearPreload('monitor-invalid')
        return
      }

      const audio = this.deps.getCurrentAudio()
      if (!audio || !isFinite(audio.duration) || audio.duration <= 0) return

      const remaining = audio.duration - audio.currentTime

      // A newly selected track can briefly expose timing from the previous
      // resource. Do not mistake that transient value for a real boundary.
      const expectedDuration = preload.sourceDuration
      const justArmed = performance.now() - preload.armedAt < 2500
      const suspiciousEarlyBoundary = expectedDuration >= 30
        && audio.currentTime < Math.min(10, expectedDuration * 0.1)
        && remaining <= ALBUM_GAPLESS_BOUNDARY_RELEASE_SECONDS
      if (justArmed && suspiciousEarlyBoundary) return

      // Silence detection is meaningful only in the actual tail window. The
      // previous implementation observed the whole track, so decoder startup
      // silence or a quiet passage near the beginning could skip almost the
      // entire song.
      if (remaining > ALBUM_GAPLESS_PREROLL_SECONDS) {
        preload.quietSince = 0
        preload.directQuietSince = 0
        return
      }

      // 只在真正进入尾部窗口后升级为完整缓冲，仍保留 8.5 秒准备时间，
      // 不改变原有的静音预滚、混音时序或视觉动画。
      if (preload.media.preload !== 'auto') {
        preload.media.preload = 'auto'
        preload.media.load()
      }

      // 提前开始预播放
      if (remaining <= ALBUM_GAPLESS_MUTED_PREROLL_SECONDS) {
        this.startPreroll(preload)
      }

      if (!preload.media || preload.media.readyState < 2) return

      // 尾部静音检测
      const nowMs = performance.now()
      const tailProbe = this.probeTailSilence(remaining)
      const longTailSilence = remaining > ALBUM_GAPLESS_LONG_SILENCE_SECONDS

      // 平滑静音检测
      if (tailProbe.smoothedQuiet && (!longTailSilence || !tailProbe.residualTail)) {
        if (!preload.quietSince) preload.quietSince = nowMs
      } else {
        preload.quietSince = 0
      }

      // 直接静音检测
      if (tailProbe.directQuiet) {
        if (!preload.directQuietSince) preload.directQuietSince = nowMs
      } else {
        preload.directQuietSince = 0
      }

      const silenceHoldMs = longTailSilence ? ALBUM_GAPLESS_FAST_SILENCE_HOLD_MS : ALBUM_GAPLESS_SILENCE_HOLD_MS
      const smoothedSilenceReady = !!(preload.quietSince && nowMs - preload.quietSince >= silenceHoldMs)

      const directHoldMs = tailProbe.deepQuiet ? ALBUM_GAPLESS_DEEP_SILENCE_HOLD_MS : ALBUM_GAPLESS_DIRECT_SILENCE_HOLD_MS
      const directSilenceReady = !!(longTailSilence && preload.directQuietSince && nowMs - preload.directQuietSince >= directHoldMs)

      const silenceReady = smoothedSilenceReady || directSilenceReady
      const boundaryReady = remaining <= ALBUM_GAPLESS_BOUNDARY_RELEASE_SECONDS

      if (silenceReady || boundaryReady) {
        const reason = silenceReady
          ? (directSilenceReady ? 'tail-direct-silence-crossmix' : (longTailSilence ? 'tail-silence-fast-crossmix' : 'tail-silence-preroll-mix'))
          : 'boundary-crossmix-reset'
        
        void this.startMix(preload, reason, remaining)
      }
    }, 70)
  }

  // 预加载下一首
  async schedulePreload(token: number, nextIndex: number, nextSong: AlbumGaplessSong): Promise<boolean> {
    if (!this.state.enabled || !this.deps.canAdvance(this.deps.getCurrentIndex())) {
      this.clearPreload('not-eligible')
      return false
    }

    this.clearPreload('new-preload')
    const serial = ++this.state.serial

    let media: HTMLAudioElement | null = null
    try {
      media = new Audio()
      media.crossOrigin = 'anonymous'
      // 主播放器的 standby deck 已经在预载下一首；额外的 AlbumGapless deck
      // 平时只读取元数据，避免整首播放期间出现两套完整媒体缓冲。
      media.preload = 'metadata'
      media.volume = 0
      media.src = nextSong.url

      this.state.preload = {
        index: nextIndex,
        key: nextSong.key,
        token,
        serial,
        media,
        audioUrl: nextSong.url,
        song: nextSong,
        sourceKey: this.deps.getCurrentTrackKey(),
        sourceIndex: this.deps.getCurrentIndex(),
        sourceDuration: this.deps.getCurrentAudio()?.duration || 0,
        armedAt: performance.now(),
        prerollStarted: false,
        prerollPlaying: false,
        prerollFailed: false,
        mixPending: false,
        mixStarted: false,
        mixStartedAt: 0,
        mixDurationMs: 0,
        fadeCompleted: false,
        quietSince: 0,
        directQuietSince: 0,
      }

      this.armMonitor(token)
      return true
    } catch (err) {
      console.warn('[AlbumGapless] 预加载失败:', err)
      // 失败路径也要释放已创建的音频元素，避免媒体缓冲区残留
      if (media) {
        try {
          media.pause()
          media.removeAttribute('src')
          media.load()
        } catch {
          // 元素可能已处于释放状态
        }
      }
      return false
    }
  }

  private restoreOutgoingAudio(rampMs: number): void {
    const targetVol = this.deps.getTargetVolume()
    const currentGain = this.deps.getOutputGain()
    
    if (currentGain < targetVol) {
      // 简单的音量恢复
      this.deps.setOutputGain(targetVol)
    }
  }

  clearPreload(reason: string): void {
    this.state.serial++
    
    if (this.state.monitorTimer) {
      clearInterval(this.state.monitorTimer)
      this.state.monitorTimer = 0
    }

    const preload = this.state.preload
    this.state.preload = null

    if (preload) {
      if (preload.handoffTimer) clearTimeout(preload.handoffTimer)
      if (preload.cleanupTimer) clearTimeout(preload.cleanupTimer)
      if (preload.fadeFrame) cancelAnimationFrame(preload.fadeFrame)
      if (preload.fadeWatchdogTimer) clearInterval(preload.fadeWatchdogTimer)

      if (preload.fadeResolve) {
        preload.fadeResolve(false)
      }

      try {
        preload.media.pause()
        preload.media.removeAttribute('src')
        preload.media.load()
      } catch (e) {
        console.warn('[AlbumGapless] 清理失败', e)
      }
    }

    debugLog(`[AlbumGapless] 清理预加载: ${reason}`)
  }

  consumePreload(): AlbumGaplessPreload | null {
    const preload = this.state.preload
    this.state.preload = null
    return preload
  }

  snapshot(): AlbumGaplessState {
    return { ...this.state }
  }
}

