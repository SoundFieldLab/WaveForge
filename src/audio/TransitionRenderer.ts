/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { debugLog } from '../utils/debugLog'
import { refineTransitionWithStems } from '../services/autoMixStemService'
import type { TransitionPlan } from './types'

interface RenderProgress {
  stage: 'analyzing' | 'stretching' | 'mixing' | 'finalizing'
  progress: number
}

interface RenderResult {
  audioBuffer: AudioBuffer
  plan: TransitionPlan
  renderTime: number
  /** 渲染产物在磁盘上的路径：PCM 缓存 TTL 过期后可从此处重新解码恢复 */
  outputPath?: string
}

interface RenderCache {
  buffer: AudioBuffer
  timestamp: number
  plan: TransitionPlan
  bytes: number
}
/** AudioBuffer → 16bit PCM WAV（m4a/aac 等 libsndfile 不支持的格式转码用）。 */
export function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const numChannels = Math.max(1, buffer.numberOfChannels)
  const sampleRate = buffer.sampleRate
  const frames = buffer.length
  const blockAlign = numChannels * 2
  const dataSize = frames * blockAlign
  const arrayBuffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(arrayBuffer)
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  // 批量转换：先把每帧样本 scale 进一个 Int16Array，再一次 copy 到输出——
  // 逐样本 DataView.setInt16 在整曲（数百万帧）上是导出路径最贵的循环体。
  const pcm = new Int16Array(frames * numChannels)
  const channels: Float32Array[] = []
  for (let ch = 0; ch < numChannels; ch += 1) channels.push(buffer.getChannelData(ch))
  let idx = 0
  for (let i = 0; i < frames; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const sample = channels[ch][i]
      const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample
      pcm[idx] = (clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff) | 0
      idx += 1
    }
  }
  new Int16Array(arrayBuffer, 44, frames * numChannels).set(pcm)
  return arrayBuffer
}

export class TransitionRenderer {
  private audioContext: AudioContext
  private masterGain: GainNode | null = null
  private cache: Map<string, RenderCache> = new Map()
  private inFlightRenders = new Map<string, Promise<void>>()
  private activeSource: AudioBufferSourceNode | null = null
  private cacheCleanupTimer: ReturnType<typeof setInterval> | null = null
  private cacheBytes = 0
  // 渲染缓存常驻的是解码后的 PCM：AI 长混音 60s 立体声 48kHz 单条约 23MB。多数条目
  // 再也不会被命中（过渡本身是一次性的），常驻只需「当前过渡 + 预渲染的下一首 + 快速
  // 切歌时的在途替换」共 3 条；被挤出的条目可从磁盘持久层 rehydrate（loadPersisted）。
  // 48MB 字节上限：两条 AI 长混音（~46MB）可共存，普通短交叉（MB 级）则能放更多条。
  private readonly MAX_CACHE_SIZE = 3
  private readonly MAX_CACHE_BYTES = 48 * 1024 * 1024
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  constructor(audioContext: AudioContext, masterGain?: GainNode) {
    this.audioContext = audioContext
    this.masterGain = masterGain || null
    this.startCacheCleanup()
  }
  
  setMasterGain(masterGain: GainNode): void {
    this.masterGain = masterGain
  }

  private backendForPlan(plan: TransitionPlan): string {
    if (plan.strategy === 'smart-rendered-qq') {
      return `qq-${plan.qqAppliedTier || plan.qq?.tier || 'lite'}`
    }
    if (plan.strategy !== 'smart-rendered-v2') return 'standard-v1'
    return plan.v2?.backend || 'v2-dsp'
  }

  /** 渲染产物磁盘路径登记（PCM 缓存过期/逐出后仍可重新解码）。 */
  private persistedRenders = new Map<string, { outputPath: string; plan: TransitionPlan; timestamp: number }>()

  /** PCM 缓存过期后从磁盘产物恢复：重新 fetch + decode，刷新缓存并返回。 */
  private async rehydrateRendered(planId: string): Promise<RenderCache | null> {
    const persisted = this.persistedRenders.get(planId)
    if (!persisted) return null
    try {
      const renderApi = window.electron?.render
      if (!renderApi) return null
      let arrayBuffer: ArrayBuffer
      if (renderApi.getAudioUrl) {
        const audioUrl = await renderApi.getAudioUrl(persisted.outputPath)
        const response = await fetch(audioUrl)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        arrayBuffer = await response.arrayBuffer()
      } else {
        arrayBuffer = await renderApi.readAudioFile(persisted.outputPath)
      }
      const buffer = await this.audioContext.decodeAudioData(arrayBuffer)
      const bytes = this.getBufferBytes(buffer)
      const entry: RenderCache = { buffer, timestamp: Date.now(), plan: persisted.plan, bytes }
      // 走容量守卫：rehydrate 是缓存写入路径之一，绕过上限的话多条 AI 长混音 PCM
      // （各 ~23MB）可在 TTL 内不触发逐出持续累积
      while (
        this.cache.size >= this.MAX_CACHE_SIZE
        || (this.cacheBytes + bytes > this.MAX_CACHE_BYTES && this.cache.size > 0)
      ) {
        if (!this.evictOldestCacheEntry()) break
      }
      this.cache.set(planId, entry)
      this.cacheBytes += bytes
      this.persistedRenders.set(planId, { ...persisted, timestamp: Date.now() })
      debugLog(`[TransitionRenderer] Re-hydrated rendered transition ${planId} from disk`)
      return entry
    } catch (error) {
      // 磁盘产物可能已被主进程清理：放弃恢复，调用方按未准备降级
      debugLog('[TransitionRenderer] Re-hydrate rendered transition failed:', error)
      this.persistedRenders.delete(planId)
      return null
    }
  }

  async preRender(params: {
    sourceUrl: string
    targetUrl: string
    plan: TransitionPlan
    // 调用方传入的过期校验回调：当该请求已被新的准备批次取代（返回 true）时，
    // 渲染结果会被丢弃——不写入缓存、不触发播放，避免快速切歌时的资源堆积。
    isStale?: () => boolean
  }): Promise<void> {
    const { sourceUrl, targetUrl, plan, isStale } = params
    
    const backend = this.backendForPlan(plan)
    const renderKey = `${plan.id}:${backend}`
    const running = this.inFlightRenders.get(renderKey)
    if (running) {
      debugLog(`[TransitionRenderer] Joining in-flight render ${renderKey}`)
      return running
    }
    const renderPromise = (async () => {
      const cached = this.cache.get(plan.id)
      if (cached && cached.timestamp + this.CACHE_TTL > Date.now()
        && this.backendForPlan(cached.plan) === backend) {
        debugLog(`[TransitionRenderer] Pre-render: already cached ${plan.id}`)
        return
      }
      if (cached) this.deleteCacheEntry(plan.id)
      debugLog(`[TransitionRenderer] Pre-rendering transition ${plan.id}`)
      await this.renderTransition(plan, sourceUrl, targetUrl, undefined, undefined, undefined, isStale)
    })().finally(() => {
      this.inFlightRenders.delete(renderKey)
    })
    this.inFlightRenders.set(renderKey, renderPromise)
    return renderPromise
  }

  async renderTransition(
    plan: TransitionPlan,
    sourceUrl: string,
    targetUrl: string,
    sourceBuffer?: AudioBuffer,
    targetBuffer?: AudioBuffer,
    onProgress?: (progress: RenderProgress) => void,
    isStale?: () => boolean
  ): Promise<RenderResult> {
    const startTime = performance.now()
    if (!plan.id?.trim()) throw new Error('Transition plan requires a non-empty ID')
    if (!plan.sourceTrackKey?.trim() || !plan.targetTrackKey?.trim()) {
      throw new Error('Transition plan requires non-empty track keys')
    }

    // Check cache first
    const cached = this.cache.get(plan.id)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()
      && this.backendForPlan(cached.plan) === this.backendForPlan(plan)) {
      debugLog(`[TransitionRenderer] Cache hit for ${plan.id}`)
      return {
        audioBuffer: cached.buffer,
        plan: cached.plan,
        renderTime: performance.now() - startTime,
      }
    }
    if (cached) this.deleteCacheEntry(plan.id)

    debugLog(`[TransitionRenderer] Rendering transition with strategy: ${plan.strategy}`)

    // Route to appropriate renderer
    let audioBuffer: AudioBuffer
    let renderedPlan: TransitionPlan = plan
    let renderedOutputPath: string | undefined
    if (plan.strategy === 'smart-rendered' || plan.strategy === 'smart-rendered-v2' || plan.strategy === 'smart-rendered-qq') {
      const rendered = await this.renderSmartTransition(plan, sourceUrl, targetUrl, onProgress, isStale)
      audioBuffer = rendered.audioBuffer
      renderedPlan = rendered.plan
      renderedOutputPath = rendered.outputPath
    } else {
      // Fallback to browser crossfade if buffers are provided
      if (!sourceBuffer || !targetBuffer) {
        throw new Error('AudioBuffers required for crossfade strategy')
      }
      audioBuffer = await this.renderCrossfade(plan, sourceBuffer, targetBuffer, onProgress)
    }

    const renderTime = performance.now() - startTime
    debugLog(`[TransitionRenderer] Rendered in ${renderTime.toFixed(2)}ms`)

    // If this render was superseded by a newer request, discard the result:
    // do not write it into the cache so a stale AudioBuffer (tens of MB) is
    // not pinned in memory until TTL expiry.
    if (isStale?.()) {
      debugLog(`[TransitionRenderer] Discarding superseded render ${plan.id}`)
      return { audioBuffer, plan: renderedPlan, renderTime }
    }

    // Cache the result (a copy of the plan, never the caller's live object)
    this.addToCache(renderedPlan, audioBuffer, renderedOutputPath)

    return { audioBuffer, plan: renderedPlan, renderTime, outputPath: renderedOutputPath }
  }

  /**
   * 确保音频文件能被 Python 渲染/AI worker 读取：libsndfile 支持 wav/flac/ogg/mp3，
   * m4a/aac/opus 等格式在渲染进程用 Chromium decodeAudioData 解码后转 16bit WAV
   * 写回下载缓存（同 trackKey 复用，只转一次）。失败时原样返回，让 worker 尝试
   * （会失败并走既有降级链，且控制台可见原因）。
   */
  private async ensureRenderableAudio(filePath: string, trackKey: string, forceWav = false): Promise<string> {
    const match = /\.([a-z0-9]+)$/i.exec(filePath)
    const ext = match ? match[1].toLowerCase() : ''
    if (!forceWav && (ext === 'wav' || ext === 'flac' || ext === 'ogg' || ext === 'mp3')) return filePath
    if (forceWav && ext === 'wav') return filePath
    try {
      const mediaUrl = await window.electron?.audioDownload?.getMediaUrl?.(filePath)
      if (!mediaUrl) return filePath
      const response = await fetch(mediaUrl)
      if (!response.ok) return filePath
      const arrayBuffer = await response.arrayBuffer()
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer)
      const wavBytes = encodeWav(audioBuffer)
      const wavPath = await window.electron?.audioDownload?.saveWav?.(trackKey, wavBytes)
      debugLog(`[TransitionRenderer] 音频转码 ${ext || '未知格式'} → WAV 完成`)
      return wavPath || filePath
    } catch (error) {
      console.warn('[TransitionRenderer] 音频转码失败，交给渲染器尝试（可能降级）:', error)
      return filePath
    }
  }

  /**
   * AutoMix Enhanced 三档渲染（QQ 官方智能混音 Lite / Advanced / Extreme）。
   *
   * 时间轴由后端按 automix-lab 语义给出：源曲播到 transitionStart → 过渡 duration 秒 →
   * 目标曲从 targetStart + duration 续播。未登录 / 跨平台匹配不到 / 云端拒绝时后端内部
   * 已回退 Lite（effectiveTier=lite + fallback 原因）；整条链路不可用返回 null，
   * 由调用方回退 v2 DSP（与 Pro 一致的兜底）。
   */
  private async renderQQTransition(
    plan: TransitionPlan,
    sourceAudioPath: string,
    targetAudioPath: string,
    onProgress?: (progress: RenderProgress) => void,
  ): Promise<{
    outputPath: string
    transitionStart: number
    duration: number
    targetStart: number
    effectiveTier: string
    fallbackReason?: string
    /** 过渡手法说明（worker 渲染 meta 透传，过渡调试弹窗展示） */
    techniques: string[]
  } | null> {
    const qq = plan.qq
    const renderApi = window.electron?.render
    if (!qq || typeof renderApi?.qqAutomix !== 'function') return null
    onProgress?.({ stage: 'stretching', progress: 0.35 })
    try {
      const result = await renderApi.qqAutomix({
        tier: qq.tier,
        sourceAudioPath,
        targetAudioPath,
        sourceMid: qq.source.mid,
        targetMid: qq.target.mid,
        sourceTitle: qq.source.title,
        sourceArtist: qq.source.artist,
        sourceTrackId: qq.source.trackId,
        targetTitle: qq.target.title,
        targetArtist: qq.target.artist,
        targetTrackId: qq.target.trackId,
        // cue 时间轴唯一事实：App 已用它排触发点/续播点/UI 进度，渲染必须按同一时间轴产出，
        // 否则"触发点用 A、缓冲内容是 B"（cue 与 render 各自取云端决策 + 磁盘缓存先命中）。
        cueTransitionStartSeconds: plan.sourceStartTime,
        cueTransitionDurationSeconds: Math.max(0, plan.sourceEndTime - plan.sourceStartTime),
        cueTargetStartSeconds: plan.targetStartTime,
      })
      if (!result?.success || !result.outputPath) {
        debugLog('[TransitionRenderer] AutoMix Enhanced 渲染失败:', result?.error)
        return null
      }
      const transitionStart = Number(result.transitionStartSeconds)
      const duration = Number(result.transitionDurationSeconds)
      const targetStart = Number(result.targetStartSeconds)
      if (![transitionStart, duration, targetStart].every(value => Number.isFinite(value)) || duration <= 0) {
        debugLog('[TransitionRenderer] AutoMix Enhanced 返回的时间轴无效，回退 v2 DSP')
        return null
      }
      const effectiveTier = String(result.effectiveTier || qq.tier)
      if (result.fallback?.reason) {
        debugLog(`[TransitionRenderer] AutoMix Enhanced 已降级为 ${effectiveTier}：${result.fallback.reason}`)
      }
      return {
        outputPath: result.outputPath,
        transitionStart,
        duration,
        targetStart,
        effectiveTier,
        fallbackReason: result.fallback?.reason
          ? `AutoMix Enhanced 已降级为 ${effectiveTier}：${result.fallback.reason}`
          : undefined,
        techniques: Array.isArray(result.techniques)
          ? result.techniques.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [],
      }
    } catch (error) {
      debugLog('[TransitionRenderer] AutoMix Enhanced 渲染异常，回退 v2 DSP:', error)
      return null
    }
  }

  private async renderSmartTransition(
    plan: TransitionPlan,
    sourceUrl: string,
    targetUrl: string,
    onProgress?: (progress: RenderProgress) => void,
    isStale?: () => boolean
  ): Promise<{ audioBuffer: AudioBuffer; plan: TransitionPlan; outputPath: string }> {
    onProgress?.({ stage: 'analyzing', progress: 0.1 })

    // Step 1: Download audio files to local disk
    const audioDownload = window.electron?.audioDownload
    if (!audioDownload?.prepare) {
      throw new Error('智能过渡需要桌面音频下载桥，当前环境不可用')
    }
    debugLog('[TransitionRenderer] Downloading source audio...')
    const sourceAudioPath = await audioDownload.prepare(
      sourceUrl,
      plan.sourceTrackKey
    )
    // Bail out as early as possible once superseded: the downloaded temp file
    // is managed by the main-process download cache (cleanupOldFiles), and we
    // skip the expensive render + decode entirely.
    if (isStale?.()) throw new Error('Transition render superseded')

    onProgress?.({ stage: 'analyzing', progress: 0.2 })
    
    debugLog('[TransitionRenderer] Downloading target audio...')
    const targetAudioPath = await audioDownload.prepare(
      targetUrl,
      plan.targetTrackKey
    )
    if (isStale?.()) throw new Error('Transition render superseded')

    // m4a/aac/opus 等 libsndfile 打不开的格式：Chromium 解码 → 转 WAV → 写回下载缓存，
    // 否则 Python 渲染/AI worker 每次都会失败并降级成纯交叉淡化（真机「全交叉」主因之一）。
    const sourceRenderPath = await this.ensureRenderableAudio(sourceAudioPath, plan.sourceTrackKey)
    const targetRenderPath = await this.ensureRenderableAudio(targetAudioPath, plan.targetTrackKey)

    // Step 2: choose one heavyweight backend. DJTransGAN long mix and HTDemucs separation are
    // mutually exclusive so enabling the optional legacy AI does not run two models serially.
    const renderBridge = window.electron?.render
    if (!renderBridge?.transition) {
      throw new Error('智能过渡需要桌面渲染桥，当前环境不可用')
    }
    const djEnabled = plan.strategy === 'smart-rendered-v2' && plan.v2?.aiMix === true
    const djStatus = djEnabled && typeof renderBridge.aiMixStatus === 'function'
      ? await renderBridge.aiMixStatus().catch(() => null)
      : null
    const djAvailable = djEnabled && djStatus?.available === true
    const transitionAiMix = renderBridge.transitionAiMix
    const useAiMix = djAvailable
      && plan.sourceEndTime >= 40
      && typeof transitionAiMix === 'function'

    // Enhanced uses one heavyweight backend at a time. Folia is the default stem backend;
    // missing/invalid HTDemucs artifacts are recorded as an explicit v2 DSP fallback.
    let renderPlan: TransitionPlan = {
      ...plan,
      ...(plan.v2 ? { v2: { ...plan.v2 } } : {}),
    }
    const buildFoliaBasePlan = (): TransitionPlan => ({
      ...plan,
      rendererVersion: plan.rendererVersion.includes('folia')
        ? plan.rendererVersion
        : 'folia-beatthis-htdemucs-automix-v2-r1',
      v2: plan.v2 ? {
        ...plan.v2,
        aiMix: false,
        backend: 'folia-htdemucs',
        automation: undefined,
      } : undefined,
    })
    const buildDspFallbackPlan = (reason: string): TransitionPlan => ({
      ...plan,
      fallbackReason: reason,
      rendererVersion: 'automix-v2-dsp-r1',
      v2: plan.v2 ? {
        ...plan.v2,
        backend: undefined,
        beatProvider: plan.v2.beatProvider || 'fallback',
        aiMix: false,
        stemArtifacts: undefined,
        stemChoreography: undefined,
        stemFingerprint: undefined,
        automation: undefined,
      } : undefined,
    })
    const prepareStemPlan = async (): Promise<boolean> => {
      if (renderPlan.v2?.stemArtifacts || plan.strategy !== 'smart-rendered-v2') return Boolean(renderPlan.v2?.stemArtifacts)
      const stemStatus = await window.electron?.stems?.status?.().catch(() => null)
      if (!stemStatus?.available) return false
      const sourceStemPath = await this.ensureRenderableAudio(sourceAudioPath, `${plan.sourceTrackKey}-stem`, true)
      const targetStemPath = await this.ensureRenderableAudio(targetAudioPath, `${plan.targetTrackKey}-stem`, true)
      const stemResult = await refineTransitionWithStems({
        plan: {
          ...renderPlan,
          ...(renderPlan.v2 ? {
            v2: {
              ...renderPlan.v2,
              aiMix: false,
              backend: 'folia-htdemucs',
              beatProvider: renderPlan.v2.beatProvider || 'fallback',
              folia: renderPlan.v2.folia || {
                beatProvider: renderPlan.v2.beatProvider || 'fallback',
                maxStemWindowSeconds: 40,
                sourceDownbeats: plan.sourceBeatTimes?.filter((_, index) => index % 4 === 0) || [],
                targetDownbeats: plan.targetBeatTimes?.filter((_, index) => index % 4 === 0) || [],
              },
            },
          } : {}),
        },
        sourceAudioPath: sourceStemPath,
        targetAudioPath: targetStemPath,
        requestPrefix: `stem:${plan.id}`,
        isStale,
      })
      if (!stemResult) return false
      renderPlan = stemResult.plan
      debugLog(`[TransitionRenderer] HTDemucs stem refinement ready: ${renderPlan.v2?.stemChoreography?.style}`)
      return true
    }
    if (plan.strategy === 'smart-rendered-v2' && !djAvailable) {
      if (!await prepareStemPlan()) {
        renderPlan = buildDspFallbackPlan('Folia HTDemucs unavailable; using v2 DSP')
        debugLog('[TransitionRenderer] Folia unavailable; using v2 DSP fallback')
      }
    }

    onProgress?.({ stage: 'stretching', progress: 0.3 })

    // Step 3: render the selected backend.
    debugLog('[TransitionRenderer] Calling transition render worker...')

    // Short source windows are outside DJTransGAN's trained long-mix contract. Route them
    // directly to Folia so Torch and HTDemucs are never started for the same transition.
    if (djAvailable && !useAiMix) {
      renderPlan = buildFoliaBasePlan()
      if (!await prepareStemPlan()) {
        renderPlan = buildDspFallbackPlan('DJTransGAN requires a long source window; Folia unavailable')
      }
    }

    // AI 混音（DJTransGAN）路径：v2 计划 + 开启 aiMix + 引擎完整可用 + 源曲尾部足够长；
    // 引擎不可用/抛错时自动回退 stem-aware/v2 DSP，不中断过渡。
    if (!useAiMix && renderPlan.v2?.aiMix) {
      renderPlan = { ...renderPlan, v2: { ...renderPlan.v2, aiMix: false } }
    }
    let result: {
      success: boolean
      outputPath?: string
      stretchApplied?: boolean
      djEffectsApplied?: boolean
      stemMixApplied?: boolean
      targetResumeTime?: number
      transitionStart?: number
      mixSpeedRatio?: number
      /** 渲染缓冲真实时长（秒）；AI 长混音为模型窗口，DSP 为过渡窗口 */
      duration?: number
      backend?: 'folia-htdemucs' | 'folia-unavailable' | 'djtransgan' | 'v2-dsp'
      beatProvider?: 'beat_this' | 'fallback'
      error?: string
    }
    // overlap 窗口（秒）：>0 时缓冲尾段渐出，目标 deck 提前 overlap 秒淡入/提前缓冲，
    // 消除 handoff 时 seek 到 resume 的网络缓冲等待（流媒体）造成的界面切换断开。
    let aiOverlapSeconds = 0
    // DJTransGAN 学到的推子/EQ 曲线复用到 v2 短过渡（8~32 拍）：
    // 模型输出是闭式参数式曲线，可在任意长度重建，无需 60s 混音窗口、不渲染音频。
    // 仅当用户开启 DJ、引擎可用、且最终走 full-mix DSP 时注入——folia 路径由 stem
    // choreography 自己拥有过渡，注入会被 worker 忽略（render_worker.py 的 folia 分支）。
    const attachLearnedAutomation = async (): Promise<void> => {
      if (plan.v2?.aiMix !== true || !djAvailable) return
      if (renderPlan.v2?.automation) return
      if (renderPlan.v2?.backend === 'folia-htdemucs' || renderPlan.v2?.stemArtifacts) return
      const fetchAutomation = renderBridge.aiMixAutomation
      if (typeof fetchAutomation !== 'function') return
      try {
        const automation = await fetchAutomation(renderPlan, sourceRenderPath, targetRenderPath)
        if (!automation?.success || !Array.isArray(automation.params) || automation.params.length !== 2) {
          debugLog('[TransitionRenderer] Learned automation unavailable; using rule-based curves:', automation?.error)
          return
        }
        renderPlan = { ...renderPlan, v2: { ...renderPlan.v2, automation: automation.params } }
        debugLog('[TransitionRenderer] DJTransGAN learned fader/EQ automation applied to v2 short transition')
      } catch (error) {
        debugLog('[TransitionRenderer] Learned automation failed; using rule-based curves:', error)
      }
    }
    // Stem IPC / worker may reject instead of returning success=false. Collapse both shapes into the
    // same fallback: retry once with the original full-mix v2 plan, never degrade straight to crossfade.
    const renderDsp = async () => {
      await attachLearnedAutomation()
      try {
        return await renderBridge.transition(renderPlan, sourceRenderPath, targetRenderPath)
      } catch (error) {
        if (!renderPlan.v2?.stemArtifacts) throw error
        debugLog('[TransitionRenderer] Folia render IPC failed; retrying v2 DSP:', error)
        renderPlan = buildDspFallbackPlan(`Folia renderer failed: ${error instanceof Error ? error.message : String(error)}`)
        // 降级后的 full-mix 计划可重新尝试注入学习式曲线
        await attachLearnedAutomation()
        return renderBridge.transition(renderPlan, sourceRenderPath, targetRenderPath)
      }
    }
    // AI 长混音尾段速度比（prev/next BPM）：>0 时 handoff 用 deck.playbackRate 起步于此值
    // 并在 overlap 窗口内渐回 1.0（post-settle），消除「混音尾=source BPM → deck 原速」台阶。
    // DSP 路径（尾段=target 原速）恒为 0，不做变速。
    let aiMixSpeedRatio = 0

    // ── AutoMix Enhanced（QQ 官方智能混音三档）─────────────────────────────
    // 云端给切点/过渡时长，渲染走官方效果链（Lite 为本地方案，同样在这里渲染）。
    // 未登录 / 跨平台匹配不到 / 云端拒绝 → 渲染层内部已回退 Lite（meta.fallback 带回原因）；
    // 整条链路失败（如主进程渲染桥不可用）→ 回退 v2 DSP，绝不掉到纯交叉淡化。
    let qqOutcome: {
      outputPath: string
      transitionStart: number
      duration: number
      targetStart: number
      effectiveTier: string
      fallbackReason?: string
      /** 过渡手法说明（worker 渲染 meta 透传） */
      techniques: string[]
    } | null = null
    if (plan.strategy === 'smart-rendered-qq' && plan.qq) {
      qqOutcome = await this.renderQQTransition(plan, sourceRenderPath, targetRenderPath, onProgress)
      if (!qqOutcome) {
        debugLog('[TransitionRenderer] QQ Enhanced 渲染不可用，回退 v2 DSP')
        renderPlan = buildDspFallbackPlan('AutoMix Enhanced 不可用（未登录 / 未匹配到 / 云端或渲染失败）')
      }
      if (qqOutcome && qqOutcome.techniques.length > 0) {
        // 手法说明挂到渲染计划上：随 renderedPlan 进缓存，armed 时进 transitionDebug.effects
        renderPlan = { ...renderPlan, qqTechniques: qqOutcome.techniques }
      }
    }

    if (qqOutcome) {
      // 时间轴以云端决策为准（automix-lab 语义）：源曲播到 transitionStart → 过渡 duration 秒
      // → 目标曲从 targetStart + duration 续播。
      const start = qqOutcome.transitionStart
      const dur = qqOutcome.duration
      const targetStart = qqOutcome.targetStart
      renderPlan = {
        ...renderPlan,
        sourceStartTime: start,
        sourceEndTime: start + dur,
        targetStartTime: targetStart,
        targetEndTime: targetStart + dur,
        qqAppliedTier: qqOutcome.effectiveTier,
        ...(qqOutcome.fallbackReason ? { fallbackReason: qqOutcome.fallbackReason } : {}),
      }
      result = {
        success: true,
        outputPath: qqOutcome.outputPath,
        stretchApplied: true,
        djEffectsApplied: true,
        targetResumeTime: targetStart + dur,
        transitionStart: start,
        duration: dur,
      }
      debugLog(`[TransitionRenderer] AutoMix Enhanced 渲染完成（${qqOutcome.effectiveTier}，${dur.toFixed(2)}s）`)
    } else if (useAiMix) {
      try {
        const aiResult = await transitionAiMix(renderPlan, sourceRenderPath, targetRenderPath)
        if (!aiResult || !aiResult.success || !aiResult.outputPath) {
          debugLog('[TransitionRenderer] AI 混音不可用，尝试 HTDemucs / v2 DSP:', aiResult?.error)
          renderPlan = buildFoliaBasePlan()
          if (!await prepareStemPlan()) renderPlan = buildDspFallbackPlan(`DJTransGAN failed; Folia unavailable: ${aiResult?.error || 'unknown error'}`)
          result = await renderDsp()
          renderPlan = { ...renderPlan, v2: { ...renderPlan.v2, aiMix: false } }
          // AI 回退 DSP 后仍是 v2 智能过渡，按 DSP 短窗口给 overlap 兜底
          aiOverlapSeconds = 1.5
        } else {
          debugLog('[TransitionRenderer] AI 混音渲染完成（DJTransGAN 长混音）')
          result = { ...aiResult, stretchApplied: true, djEffectsApplied: true }
          // overlap handoff / post-settle：AI 混音尾段 target 内容以 source BPM 播放（模型
          // sync_bpm 行为），handoff 到真实 deck（target 原速）有速度台阶。deck 提前 15s
          // 启动并以混音尾速度起步（playbackRate=ratio），缓冲尾同窗口渐出；playbackRate
          // 在前 7s（结束前 15~8s）平滑渐回 1.0，最后 8s 保持原速与 deck 直接衔接
          // （用户明确要求：15-8 秒开始平滑减速，8 秒后衔接，非最后 1-2s 才减速）。
          const speedRatio = typeof aiResult.mixSpeedRatio === 'number' && aiResult.mixSpeedRatio > 0
            ? aiResult.mixSpeedRatio
            : plan.sourceBpm / Math.max(1, plan.targetBpm)
          aiMixSpeedRatio = speedRatio
          aiOverlapSeconds = 15
        }
      } catch (error) {
        debugLog('[TransitionRenderer] AI 混音异常，尝试 Folia / v2 DSP:', error)
        renderPlan = buildFoliaBasePlan()
        if (!await prepareStemPlan()) {
          renderPlan = buildDspFallbackPlan(`DJTransGAN failed; Folia unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
        result = await renderDsp()
        aiOverlapSeconds = 1.5
      }
    } else {
      result = await renderDsp()
      // DSP 智能过渡（v2）：末拍已回正、无速度台阶；overlap 的意义是
      // deck 提前启动缓冲 resume 区域 + 缓冲尾渐出，消除 handoff seek 的等待间隙。
      if (plan.strategy === 'smart-rendered-v2' && result?.success && result.stretchApplied) {
        aiOverlapSeconds = 1.5
      }
    }
    if ((!result?.success || !result.outputPath || result.stretchApplied !== true)
      && renderPlan.v2?.backend === 'folia-htdemucs') {
      const foliaError = result?.error || 'Folia stem renderer returned an invalid result'
      debugLog('[TransitionRenderer] Folia render failed; using explicit v2 DSP fallback:', foliaError)
      renderPlan = buildDspFallbackPlan(`Folia renderer failed: ${foliaError}`)
      // 经 renderDsp 以便 full-mix 回退同样注入学习式曲线
      result = await renderDsp()
      aiOverlapSeconds = result?.success && result.stretchApplied ? 1.5 : 0
    }
    // Legacy stem-aware v2 plans still retain their own compatibility fallback.
    if ((!result?.success || !result.outputPath || result.stretchApplied !== true)
      && renderPlan.v2?.stemArtifacts
      && renderPlan.v2?.backend !== 'folia-htdemucs') {
      debugLog('[TransitionRenderer] Stem render failed; retrying original v2 full-mix DSP:', result?.error)
      result = await renderBridge.transition(plan, sourceRenderPath, targetRenderPath)
      renderPlan = { ...plan, ...(plan.v2 ? { v2: { ...plan.v2, aiMix: false } } : {}) }
      aiOverlapSeconds = result?.success && result.stretchApplied ? 1.5 : 0
    }
    if (isStale?.()) throw new Error('Transition render superseded')

    if (!result.success || !result.outputPath || result.stretchApplied !== true) {
      throw new Error(result.error || 'Render failed')
    }
    if (plan.djEffects?.enabled && result.djEffectsApplied !== true && renderPlan.v2?.backend !== 'folia-htdemucs') {
      throw new Error('DJ effects were planned but not applied')
    }
    // Never mutate the caller's shared TransitionPlan. Compute a shallow copy
    // carrying the resolved resume time so the cache and playback hook share
    // one consistent object while the caller's plan stays untouched.
    // AI 混音路径还会替换过渡起点（模型固定 ~60s 窗口，从 transitionStart 开始）。
    const renderedPlan = (typeof result.targetResumeTime === 'number' && Number.isFinite(result.targetResumeTime))
      ? {
        ...renderPlan,
        sourceStartTime: typeof result.transitionStart === 'number' && Number.isFinite(result.transitionStart)
          ? result.transitionStart
          : renderPlan.sourceStartTime,
        targetEndTime: result.targetResumeTime,
        ...(aiOverlapSeconds > 0 ? { overlapSeconds: aiOverlapSeconds } : {}),
        ...(aiMixSpeedRatio > 0 ? { mixSpeedRatio: aiMixSpeedRatio } : {}),
        // 缓冲真实时长：动画窗口用它替代写死的模型窗口常量（AI 路径原为 60）
        ...(typeof result.duration === 'number' && Number.isFinite(result.duration) && result.duration > 0
          ? { renderedDuration: result.duration }
          : {}),
      }
      : renderPlan

    onProgress?.({ stage: 'finalizing', progress: 0.9 })

    // Step 3: Load the rendered audio file into AudioBuffer
    debugLog('[TransitionRenderer] Loading rendered audio from:', result.outputPath)
    const renderApi = window.electron?.render
    if (!renderApi) {
      throw new Error('智能过渡需要桌面渲染桥，当前环境不可用')
    }
    let arrayBuffer: ArrayBuffer
    if (renderApi.getAudioUrl) {
      try {
        const audioUrl = await renderApi.getAudioUrl(result.outputPath)
        const response = await fetch(audioUrl)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        arrayBuffer = await response.arrayBuffer()
      } catch (error) {
        // Keep the legacy IPC path as a compatibility/recovery fallback.
        debugLog('[TransitionRenderer] Streaming read failed, falling back to IPC:', error)
        arrayBuffer = await renderApi.readAudioFile(result.outputPath)
      }
    } else {
      arrayBuffer = await renderApi.readAudioFile(result.outputPath)
    }
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer)
    // Decode of a multi-MB AudioBuffer is expensive; if the request was
    // superseded meanwhile, drop the decoded result here instead of letting
    // the caller cache it.
    if (isStale?.()) throw new Error('Transition render superseded')

    onProgress?.({ stage: 'finalizing', progress: 1 })
    return { audioBuffer, plan: renderedPlan, outputPath: result.outputPath }
  }

  private async renderCrossfade(
    plan: TransitionPlan,
    sourceBuffer: AudioBuffer,
    targetBuffer: AudioBuffer,
    onProgress?: (progress: RenderProgress) => void
  ): Promise<AudioBuffer> {
    onProgress?.({ stage: 'mixing', progress: 0 })

    // The output buffer must cover the TARGET window span so the resume point
    // (plan.targetEndTime) matches what the listener heard at handoff. When
    // source and target BPM differ the spans differ, so the source window is
    // scaled across the output span below to keep beat alignment. Degenerate
    // target spans (targetEndTime <= targetStartTime) fall back to the previous
    // source-span behavior.
    const sourceSpan = plan.sourceEndTime - plan.sourceStartTime
    const targetSpan = plan.targetEndTime - plan.targetStartTime
    const duration = targetSpan > 0 ? targetSpan : sourceSpan
    const sampleRate = sourceBuffer.sampleRate
    const samples = Math.floor(duration * sampleRate)
    const channels = Math.max(sourceBuffer.numberOfChannels, targetBuffer.numberOfChannels)

    const outputBuffer = this.audioContext.createBuffer(channels, samples, sampleRate)

    const sourceStart = Math.floor(plan.sourceStartTime * sampleRate)
    const targetStart = Math.floor(plan.targetStartTime * sampleRate)

    // Apply gain curves
    const sourceGain = plan.gainCurve.source
    const targetGain = plan.gainCurve.target
    const curveLength = sourceGain.length

    for (let ch = 0; ch < channels; ch++) {
      const output = outputBuffer.getChannelData(ch)
      const sourceData = ch < sourceBuffer.numberOfChannels ? sourceBuffer.getChannelData(ch) : null
      const targetData = ch < targetBuffer.numberOfChannels ? targetBuffer.getChannelData(ch) : null

      for (let i = 0; i < samples; i++) {
        const progress = i / samples
        const curveIndex = Math.min(curveLength - 1, Math.floor(progress * curveLength))
        const sourceGainValue = sourceGain[curveIndex]
        const targetGainValue = targetGain[curveIndex]

        const sourceIndex = targetSpan > 0
          ? sourceStart + Math.floor(i * sourceSpan / targetSpan)
          : sourceStart + i
        const sourceSample = sourceData ? (sourceData[sourceIndex] || 0) : 0
        const targetSample = targetData ? (targetData[targetStart + i] || 0) : 0

        output[i] = sourceSample * sourceGainValue + targetSample * targetGainValue
      }

      onProgress?.({ stage: 'mixing', progress: (ch + 1) / channels })
    }

    return outputBuffer
  }

  private getBufferBytes(buffer: AudioBuffer): number {
    return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT
  }

  private deleteCacheEntry(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false
    this.cache.delete(key)
    this.cacheBytes = Math.max(0, this.cacheBytes - entry.bytes)
    return true
  }

  /**
   * 让已渲染的过渡全部失效（音质切换时调用）。
   *
   * 缓存键是 planId（由曲目对/档位/风格决定，**不含音质档**），内存 PCM 与磁盘产物
   * 两层命中都会直接复用。所以切到无损后，之前以 128k 渲染的成品仍会被拿去播——
   * 听感上就是「切了无损，但过渡那几秒还是糊的」。清掉内存与磁盘索引即可，
   * 磁盘文件由主进程的缓存清理回收。
   */
  clearRenderedCache(): void {
    this.cache.clear()
    this.cacheBytes = 0
    this.persistedRenders.clear()
  }

  private evictOldestCacheEntry(): boolean {
    let oldestKey: string | null = null
    let oldestTime = Number.POSITIVE_INFINITY
    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp
        oldestKey = key
      }
    }
    return oldestKey !== null && this.deleteCacheEntry(oldestKey)
  }

  private addToCache(plan: TransitionPlan, buffer: AudioBuffer, outputPath?: string): void {
    const bytes = this.getBufferBytes(buffer)
    this.deleteCacheEntry(plan.id)

    // A single unusually long transition must not pin more than the entire
    // decoded PCM budget. It can still be returned and played by the caller.
    if (bytes > this.MAX_CACHE_BYTES) return

    while (
      this.cache.size >= this.MAX_CACHE_SIZE
      || this.cacheBytes + bytes > this.MAX_CACHE_BYTES
    ) {
      if (!this.evictOldestCacheEntry()) break
    }

    this.cache.set(plan.id, {
      buffer,
      timestamp: Date.now(),
      plan,
      bytes,
    })
    this.cacheBytes += bytes
    // 记录磁盘产物路径：PCM 缓存 TTL 过期/被逐出后仍可重新解码恢复，
    // 避免触发时降级标准交叉淡化（目标曲会从 targetStartTime=0 播放 = "回到开头"）。
    if (outputPath) {
      this.persistedRenders.set(plan.id, { outputPath, plan, timestamp: Date.now() })
      while (this.persistedRenders.size > 8) {
        const oldest = this.persistedRenders.keys().next().value
        if (oldest === undefined) break
        this.persistedRenders.delete(oldest)
      }
    }
  }

  private startCacheCleanup(): void {
    this.cacheCleanupTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.cache.entries()) {
        if (entry.timestamp + this.CACHE_TTL < now) {
          this.deleteCacheEntry(key)
        }
      }
    }, 60000) // Cleanup every minute
  }

  getRendered(planId: string): AudioBuffer | null {
    const cached = this.cache.get(planId)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) {
      return cached.buffer
    }
    if (cached) this.deleteCacheEntry(planId)
    return null
  }

  /**
   * 取已渲染缓冲：内存缓存 → 磁盘产物（rehydrate）→ null。
   * startTransition 用它替代 getRendered：原实现只看内存缓存（TTL 5 分钟 / 最多 5 条），
   * 过期或被逐出后就直接降级为固定交叉淡化——而目标曲续播点会退回 targetStartTime
   *（lite 档 = 0，听感是"过渡完成又回到第二首开头"），磁盘上其实还有可复用的 WAV。
   */
  async ensureRendered(planId: string): Promise<AudioBuffer | null> {
    const cached = this.cache.get(planId)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) return cached.buffer
    if (cached) this.deleteCacheEntry(planId)
    const rehydrated = await this.rehydrateRendered(planId)
    return rehydrated ? rehydrated.buffer : null
  }

  /** 返回已缓存渲染对应的计划副本（含渲染器解析后的窗口调整），未命中返回 null。 */
  getRenderedPlan(planId: string): TransitionPlan | null {
    const cached = this.cache.get(planId)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) {
      return cached.plan
    }
    if (cached) this.deleteCacheEntry(planId)
    return null
  }

  async playTransition(
    planId: string,
    sourceCurrentTime: number,
    onEnded?: () => void,
    options?: { overlap?: number; handoffFadeSeconds?: number },
  ): Promise<{
    targetResumeTime: number
    playbackOffset: number
    remainingDuration: number
    /** 缓冲尾段渐出 + deck 提前渐入的重叠窗口（秒）；0 = 普通硬交接 */
    overlap?: number
    /** AI 长混音：混音尾段 target 内容相对原曲的播放速度比（deck 起步 playbackRate，渐回 1.0） */
    mixSpeedRatio?: number
    /** 缓冲在 AudioContext 时间轴上结束的时刻（ctx.currentTime 基准）。
     *  调用方把 deck 的增益渐入调度锚在这里 —— 与缓冲的尾段渐出同一条时钟，
     *  不再依赖 play() 的返回时机（旧实现的电平台阶/静音缝隙来源）。 */
    bufferEndCtxTime?: number
    /** 缓冲尾段实际渐出时长（秒）：deck 侧的交叉窗口与之对齐 */
    handoffFadeSeconds?: number
    /** true = 触发过晚（已越过缓冲 85%），缓冲未启动，调用方应回退交叉淡化 */
    tooLate?: boolean
  } | null> {
    let cached = this.cache.get(planId)
    if (cached && cached.timestamp + this.CACHE_TTL <= Date.now()) {
      this.deleteCacheEntry(planId)
      cached = undefined
    }
    if (!cached) {
      // TTL 过期/被逐出不等于产物丢失：磁盘上的渲染 WAV 还在，重新解码恢复。
      // 直接降级标准交叉淡化会让目标曲从 targetStartTime（lite 为 0）播放——
      // 实测表现为"过渡完成直接回到第二首开头"。
      cached = await this.rehydrateRendered(planId) ?? undefined
    }
    if (!cached) return null

    const plan = cached.plan
    const buffer = cached.buffer

    // 条目保留，不再"一进播放就从缓存删除"：删除会让同一 plan 的任何重排（暂停/改设置后
    // 重新准备）必然重新解码甚至重渲染；保留后由 TTL（5 分钟）与容量上限（5 条 / 64MB）
    // 兜住内存，source 结束时也会清空 buffer 引用（见下方 ended 回调）。

    // 迟到保护：触发点越过缓冲开头太多时，播放缓冲只剩"目标曲已抬头的段落"——
    // 快进/跳进度越过 cue 切点后触发，用户听到的是源曲还在正常放、目标曲突然
    // 满音量叠上来（实测反馈"第三首音乐叠加上去了"）。 Natural 触发的 offset 只有
    // timeupdate 粒度（≤0.3s）；超过 max(1.2s, 20%) 一律视为 seek 跳入，
    // 放弃缓冲让调用方回退标准交叉淡化（干净、可预期）。
    const rawOffset = Math.max(0, sourceCurrentTime - plan.sourceStartTime)
    if (rawOffset > Math.max(1.2, buffer.duration * 0.2)) {
      this.stopPlayback()
      debugLog(`[TransitionRenderer] Late trigger (offset ${rawOffset.toFixed(2)}s > max(1.2s, 20%) of ${buffer.duration.toFixed(2)}s), abandoning buffer`)
      return {
        targetResumeTime: plan.targetEndTime,
        playbackOffset: rawOffset,
        remainingDuration: 0.05,
        tooLate: true,
      }
    }

    // Create a buffer source to play the transition
    this.stopPlayback()
    const source = this.audioContext.createBufferSource()
    this.activeSource = source
    source.buffer = buffer
    
    const playbackOffset = Math.max(0, Math.min(rawOffset, Math.max(0, buffer.duration - 0.05)))
    // overlap handoff：缓冲尾段渐出 + 目标 deck 提前启动交叉。
    // 渐出曲线与前端 deck 节奏对齐：deck 先同速（~4s，与缓冲内容同步交叉）→ 开始减速；
    // 缓冲在 deck 减速窗口内**快速渐出**（从 1 → 0.12），deck 变速时缓冲已几乎无声，
    // 避免速度差大的场景（混音尾=source BPM vs deck 原速，可达 ±50%）错位成"二重奏"。
    // 结束时刻相对播放起点 = buffer.duration - playbackOffset。
    const bufferRemaining = Math.max(0.05, buffer.duration - playbackOffset)
    const overlapRequested = Math.max(0, Math.min(options?.overlap ?? 0, bufferRemaining * 0.35))
    // 交接交叉窗口：overlap 路径由 overlap 主导；无 overlap（QQ Enhanced / 旧版智能渲染）
    // 也要有一段「缓冲尾渐出 + live deck 渐入」的窗口，否则缓冲结束到 deck 出声之间是
    // 纯静音 + 硬起播（用户听感："过渡播完像跳过去"）。
    const handoffFadeRequested = Math.max(0, Math.min(
      options?.handoffFadeSeconds ?? 0,
      bufferRemaining * 0.2,
    ))
    const handoffFade = overlapRequested > 0.05 ? overlapRequested : handoffFadeRequested
    const endAtCtxTime = this.audioContext.currentTime + bufferRemaining
    let transitionGain: GainNode | null = null
    if (handoffFade > 0.05) {
      transitionGain = this.audioContext.createGain()
      const now = this.audioContext.currentTime
      const endAt = endAtCtxTime
      if (overlapRequested > 0.05) {
        const syncHoldS = overlapRequested * (4 / 15) // deck 同速期（~4s，overlap=15s 时）
        const decelS = overlapRequested * (4 / 15)    // deck 减速窗口（~4s）
        // 入场 400ms 渐入：automix 介入瞬间音量与源曲平滑交叉（源曲 deck 同时渐出），
        // 避免缓冲满音量硬切入导致"声音突然变小一大截"（用户明确要求曲线渐变）。
        transitionGain.gain.setValueAtTime(0.0001, now)
        transitionGain.gain.linearRampToValueAtTime(1, now + 0.4)
        // 同速期保持全响（deck 与缓冲内容同步，无错位）
        transitionGain.gain.setValueAtTime(1, Math.max(now + 0.4, endAt - overlapRequested + syncHoldS))
        // 减速窗口内快速渐出（deck 变速时缓冲已弱 → 无二重奏）
        transitionGain.gain.linearRampToValueAtTime(0.12, Math.max(now + 0.4, endAt - overlapRequested + syncHoldS + decelS))
        // 收尾到静音
        transitionGain.gain.linearRampToValueAtTime(0.0001, endAt)
      } else {
        // 无 overlap：缓冲头段保持满增益（与源曲 deck 60ms 静音交叉），
        // 只在最后 handoffFade 秒渐出，让已提前起播的 deck 接管。
        transitionGain.gain.setValueAtTime(1, now)
        transitionGain.gain.setValueAtTime(1, Math.max(now, endAt - handoffFade))
        transitionGain.gain.linearRampToValueAtTime(0.0001, endAt)
      }
      source.connect(transitionGain)
      if (this.masterGain) {
        transitionGain.connect(this.masterGain)
      } else {
        transitionGain.connect(this.audioContext.destination)
      }
    }
    
    // Connect through master gain if available, otherwise directly to destination
    if (!transitionGain) {
      if (this.masterGain) {
        source.connect(this.masterGain)
      } else {
        source.connect(this.audioContext.destination)
      }
    }
    
    source.addEventListener('ended', () => {
      if (this.activeSource === source) this.activeSource = null
      // Release the buffer reference from the source node so GC can reclaim it
      source.buffer = null
      if (transitionGain) {
        transitionGain.disconnect()
        transitionGain = null
      }
      source.disconnect()
      // 事件驱动 handoff：缓冲精确结束时通知调用方启动 target（消除 50ms 固定补偿的缝隙/双播）
      onEnded?.()
    }, { once: true })
    source.start(0, playbackOffset)

    // The rendered audio contains both tracks mixed together:
    // - Source: from sourceStartTime to sourceEndTime
    // - Target: from targetStartTime to targetEndTime
    // After playing the rendered transition, we should resume from targetEndTime
    const targetResumeTime = plan.targetEndTime
    const remainingDuration = bufferRemaining

    debugLog(`[TransitionRenderer] Playing cached transition ${planId}`)
    debugLog(`  - Transition buffer duration: ${buffer.duration.toFixed(2)}s`)
    debugLog(`  - Late-trigger offset: ${playbackOffset.toFixed(3)}s`)
    debugLog(`  - Target was mixed from ${plan.targetStartTime.toFixed(2)}s to ${plan.targetEndTime.toFixed(2)}s`)
    debugLog(`  - Will resume target at ${targetResumeTime.toFixed(2)}s`)
    if (overlapRequested > 0.05) {
      debugLog(`  - Overlap handoff: buffer tail fades out over ${overlapRequested.toFixed(2)}s, deck joins early`)
    } else if (handoffFade > 0.05) {
      debugLog(`  - Handoff crossfade: buffer tail fades out over ${handoffFade.toFixed(2)}s, deck joins early`)
    }

    return {
      targetResumeTime,
      playbackOffset,
      remainingDuration,
      overlap: overlapRequested,
      mixSpeedRatio: plan.mixSpeedRatio,
      bufferEndCtxTime: endAtCtxTime,
      handoffFadeSeconds: handoffFade,
    }
  }

  stopPlayback(): void {
    const source = this.activeSource
    this.activeSource = null
    if (!source) return
    try {
      source.stop()
    } catch {
      // The transition buffer may already have ended.
    }
    // Drop the buffer reference before disconnecting so the decoded audio
    // can be garbage collected when a transition is cancelled or replaced.
    source.buffer = null
    source.disconnect()
  }

  clearCache(): void {
    this.cache.clear()
    this.cacheBytes = 0
  }

  getCacheSize(): number {
    return this.cache.size
  }

  dispose(): void {
    this.stopPlayback()
    if (this.cacheCleanupTimer !== null) {
      clearInterval(this.cacheCleanupTimer)
      this.cacheCleanupTimer = null
    }
    this.clearCache()
  }
}
