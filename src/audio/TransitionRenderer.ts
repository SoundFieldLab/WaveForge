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

  const channels: Float32Array[] = []
  for (let ch = 0; ch < numChannels; ch += 1) channels.push(buffer.getChannelData(ch))
  let offset = 44
  for (let i = 0; i < frames; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return arrayBuffer
}

export class TransitionRenderer {
  private audioContext: AudioContext
  private masterGain: GainNode | null = null
  private cache: Map<string, RenderCache> = new Map()
  private activeSource: AudioBufferSourceNode | null = null
  private cacheCleanupTimer: ReturnType<typeof setInterval> | null = null
  private cacheBytes = 0
  private readonly MAX_CACHE_SIZE = 10
  private readonly MAX_CACHE_BYTES = 128 * 1024 * 1024
  private readonly CACHE_TTL = 5 * 60 * 1000 // 5 minutes

  constructor(audioContext: AudioContext, masterGain?: GainNode) {
    this.audioContext = audioContext
    this.masterGain = masterGain || null
    this.startCacheCleanup()
  }
  
  setMasterGain(masterGain: GainNode): void {
    this.masterGain = masterGain
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
    
    // Check if already cached
    const cached = this.cache.get(plan.id)
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) {
      debugLog(`[TransitionRenderer] Pre-render: already cached ${plan.id}`)
      return
    }
    if (cached) this.deleteCacheEntry(plan.id)
    
    debugLog(`[TransitionRenderer] Pre-rendering transition ${plan.id}`)
    
    // Trigger the render without waiting for the AudioBuffer
    // This will download files and render to backend cache
    await this.renderTransition(plan, sourceUrl, targetUrl, undefined, undefined, undefined, isStale)
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
    if (cached && cached.timestamp + this.CACHE_TTL > Date.now()) {
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
    if (plan.strategy === 'smart-rendered' || plan.strategy === 'smart-rendered-v2') {
      const rendered = await this.renderSmartTransition(plan, sourceUrl, targetUrl, onProgress, isStale)
      audioBuffer = rendered.audioBuffer
      renderedPlan = rendered.plan
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
    this.addToCache(renderedPlan, audioBuffer)

    return { audioBuffer, plan: renderedPlan, renderTime }
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

  private async renderSmartTransition(
    plan: TransitionPlan,
    sourceUrl: string,
    targetUrl: string,
    onProgress?: (progress: RenderProgress) => void,
    isStale?: () => boolean
  ): Promise<{ audioBuffer: AudioBuffer; plan: TransitionPlan }> {
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

    // AutoMix Enhanced 优先做 HTDemucs 二阶段精炼：有模型时按真实 vocals/drums/bass/other
    // 规划分轨交接；无模型、超时或失败时保持原 plan，继续走现有 full-mix v2 DSP。
    let renderPlan: TransitionPlan = {
      ...plan,
      ...(plan.v2 ? { v2: { ...plan.v2 } } : {}),
    }
    const prepareStemPlan = async (): Promise<boolean> => {
      if (renderPlan.v2?.stemArtifacts || plan.strategy !== 'smart-rendered-v2') return Boolean(renderPlan.v2?.stemArtifacts)
      const stemStatus = await window.electron?.stems?.status?.().catch(() => null)
      if (!stemStatus?.available) return false
      const sourceStemPath = await this.ensureRenderableAudio(sourceAudioPath, `${plan.sourceTrackKey}-stem`, true)
      const targetStemPath = await this.ensureRenderableAudio(targetAudioPath, `${plan.targetTrackKey}-stem`, true)
      const stemResult = await refineTransitionWithStems({
        plan: { ...plan, ...(plan.v2 ? { v2: { ...plan.v2, aiMix: false } } : {}) },
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
      if (!await prepareStemPlan()) debugLog('[TransitionRenderer] HTDemucs unavailable; using existing v2 full-mix DSP')
    }

    onProgress?.({ stage: 'stretching', progress: 0.3 })

    // Step 3: render the selected backend.
    debugLog('[TransitionRenderer] Calling transition render worker...')

    // DJTransGAN automation is used only when the user explicitly enabled the optional engine and
    // the fixed 60s long-mix path is ineligible. The common long-mix path does not redundantly run
    // automation first.
    let djAutomationApplied = false
    if (djAvailable && !useAiMix && typeof renderBridge.aiMixAutomation === 'function') {
      try {
        // 引擎缺失/半装（有 torch 无权重、worker 启动卡住）时 automation 可能长时间挂起，
        // 阻塞整个过渡渲染（内部超时 180s）。加 8s 竞速超时：拿不到就回退规则曲线，
        // 不让可疑引擎拖垮 DSP 过渡（无模型时增强版出现"过渡噪音/割裂"的防御性修复）。
        const automation = await Promise.race([
          renderBridge.aiMixAutomation(renderPlan, sourceRenderPath, targetRenderPath),
          new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), 8000)
          }),
        ])
        if (isStale?.()) throw new Error('Transition render superseded')
        if (automation?.success && Array.isArray(automation.params) && automation.params.length === 2) {
          renderPlan.v2 = { ...renderPlan.v2, automation: automation.params }
          djAutomationApplied = true
          debugLog('[TransitionRenderer] AI 学习式推子/EQ 自动化已注入 v2 DSP 渲染')
        }
      } catch (error) {
        debugLog('[TransitionRenderer] AI 自动化提取失败（回退规则曲线）:', error)
      }
    }
    if (djAvailable && !useAiMix && !djAutomationApplied) {
      debugLog('[TransitionRenderer] DJ automation unavailable; trying HTDemucs stem refinement')
      await prepareStemPlan()
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
      error?: string
    }
    // overlap 窗口（秒）：>0 时缓冲尾段渐出，目标 deck 提前 overlap 秒淡入/提前缓冲，
    // 消除 handoff 时 seek 到 resume 的网络缓冲等待（流媒体）造成的界面切换断开。
    let aiOverlapSeconds = 0
    // Stem IPC / worker may reject instead of returning success=false. Collapse both shapes into the
    // same fallback: retry once with the original full-mix v2 plan, never degrade straight to crossfade.
    const renderDsp = async () => {
      try {
        return await renderBridge.transition(renderPlan, sourceRenderPath, targetRenderPath)
      } catch (error) {
        if (!renderPlan.v2?.stemArtifacts) throw error
        debugLog('[TransitionRenderer] Stem DSP IPC failed; retrying original v2 full-mix DSP:', error)
        renderPlan = { ...plan, ...(plan.v2 ? { v2: { ...plan.v2, aiMix: false } } : {}) }
        return renderBridge.transition(renderPlan, sourceRenderPath, targetRenderPath)
      }
    }
    // AI 长混音尾段速度比（prev/next BPM）：>0 时 handoff 用 deck.playbackRate 起步于此值
    // 并在 overlap 窗口内渐回 1.0（post-settle），消除「混音尾=source BPM → deck 原速」台阶。
    // DSP 路径（尾段=target 原速）恒为 0，不做变速。
    let aiMixSpeedRatio = 0
    if (useAiMix) {
      try {
        const aiResult = await transitionAiMix(renderPlan, sourceRenderPath, targetRenderPath)
        if (!aiResult || !aiResult.success || !aiResult.outputPath) {
          debugLog('[TransitionRenderer] AI 混音不可用，尝试 HTDemucs / v2 DSP:', aiResult?.error)
          renderPlan = { ...plan, ...(plan.v2 ? { v2: { ...plan.v2, aiMix: false } } : {}) }
          await prepareStemPlan()
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
        debugLog('[TransitionRenderer] AI 混音异常，尝试 HTDemucs / v2 DSP:', error)
        renderPlan = { ...plan, ...(plan.v2 ? { v2: { ...plan.v2, aiMix: false } } : {}) }
        await prepareStemPlan()
        result = await renderDsp()
        renderPlan = { ...renderPlan, v2: { ...renderPlan.v2, aiMix: false } }
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
    // Stem-aware 后端是增强项而不是单点故障：artifacts/读取/渲染任一失败，
    // 同一次准备立即重跑原 v2 full-mix DSP，不把用户降到标准交叉。
    if ((!result?.success || !result.outputPath || result.stretchApplied !== true)
      && renderPlan.v2?.stemArtifacts) {
      debugLog('[TransitionRenderer] Stem render failed; retrying original v2 full-mix DSP:', result?.error)
      result = await renderBridge.transition(plan, sourceRenderPath, targetRenderPath)
      renderPlan = { ...plan, ...(plan.v2 ? { v2: { ...plan.v2, aiMix: false } } : {}) }
      aiOverlapSeconds = result?.success && result.stretchApplied ? 1.5 : 0
    }
    if (isStale?.()) throw new Error('Transition render superseded')

    if (!result.success || !result.outputPath || result.stretchApplied !== true) {
      throw new Error(result.error || 'Render failed')
    }
    if (plan.djEffects?.enabled && result.djEffectsApplied !== true) {
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
    return { audioBuffer, plan: renderedPlan }
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

  private addToCache(plan: TransitionPlan, buffer: AudioBuffer): void {
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
    options?: { overlap?: number },
  ): Promise<{
    targetResumeTime: number
    playbackOffset: number
    remainingDuration: number
    /** 缓冲尾段渐出 + deck 提前渐入的重叠窗口（秒）；0 = 普通硬交接 */
    overlap?: number
    /** AI 长混音：混音尾段 target 内容相对原曲的播放速度比（deck 起步 playbackRate，渐回 1.0） */
    mixSpeedRatio?: number
    /** true = 触发过晚（已越过缓冲 85%），缓冲未启动，调用方应回退交叉淡化 */
    tooLate?: boolean
  } | null> {
    const cached = this.cache.get(planId)
    if (!cached || cached.timestamp + this.CACHE_TTL <= Date.now()) {
      if (cached) this.deleteCacheEntry(planId)
      return null
    }

    const plan = cached.plan
    const buffer = cached.buffer

    // Transition is one-shot: remove from cache immediately to release the
    // decoded AudioBuffer as soon as the source node finishes with it.
    this.deleteCacheEntry(planId)

    // 迟到保护：触发已越过缓冲 85% 时，播放缓冲只剩极小一段（近似硬切 + 音量阶梯），
    // 放弃缓冲让调用方回退标准交叉淡化。
    const rawOffset = Math.max(0, sourceCurrentTime - plan.sourceStartTime)
    if (rawOffset > buffer.duration * 0.85) {
      this.stopPlayback()
      debugLog(`[TransitionRenderer] Late trigger (offset ${rawOffset.toFixed(2)}s > 85% of ${buffer.duration.toFixed(2)}s), abandoning buffer`)
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
    let transitionGain: GainNode | null = null
    if (overlapRequested > 0.05) {
      transitionGain = this.audioContext.createGain()
      const now = this.audioContext.currentTime
      const endAt = now + bufferRemaining
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
    }

    return {
      targetResumeTime,
      playbackOffset,
      remainingDuration,
      overlap: overlapRequested,
      mixSpeedRatio: plan.mixSpeedRatio,
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
