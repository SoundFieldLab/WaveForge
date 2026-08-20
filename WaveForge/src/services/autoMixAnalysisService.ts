import { debugLog } from '../utils/debugLog'
import { isTvModeActive } from '../platform'
import type { BeatFeatureFrame, SectionMarker, TrackAnalysis } from '../audio/types'

export interface TrackAnalysisInput {
  trackKey: string
  url: string
  duration?: number
  sourceSignature?: string
  signal?: AbortSignal
}

const ANALYSIS_VERSION = 'fallback-dsp-v1'
const PYTHON_ANALYSIS_VERSION = 'librosa-dsp-v2'
const memoryCache = new Map<string, TrackAnalysis>()
const inFlightAnalyses = new Map<string, Promise<TrackAnalysis>>()
const MAX_MEMORY_CACHE_ENTRIES = 32
const PYTHON_BEAT_SERVICE_URL = 'http://localhost:3002'
const PYTHON_ANALYSIS_TIMEOUT_MS = 120_000
const PYTHON_HEALTH_TIMEOUT_MS = 2_000
const PYTHON_HEALTHY_CACHE_MS = 30_000
const PYTHON_UNAVAILABLE_RETRY_MS = 5_000

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

function cacheKey(input: TrackAnalysisInput): string {
  return `${input.trackKey}:${Math.round(input.duration || 0)}:${input.sourceSignature || ''}:${ANALYSIS_VERSION}`
}

function cacheInMemory(key: string, analysis: TrackAnalysis): void {
  memoryCache.delete(key)
  memoryCache.set(key, analysis)
  while (memoryCache.size > MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value
    if (oldestKey === undefined) break
    memoryCache.delete(oldestKey)
  }
}

function isSupportedAnalysis(analysis: TrackAnalysis): boolean {
  return analysis.analysisVersion === ANALYSIS_VERSION || analysis.analysisVersion === PYTHON_ANALYSIS_VERSION
}

/** 分析结果是否带可用节拍网格（空网格 = 解码失败/元数据兜底，不能用于智能混音规划） */
function hasUsableBeats(analysis: TrackAnalysis | null | undefined): boolean {
  return Boolean(analysis && Array.isArray(analysis.beats) && analysis.beats.length >= 8 && Array.isArray(analysis.downbeats) && analysis.downbeats.length >= 2)
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason
  return new DOMException('Analysis was cancelled', 'AbortError')
}

function waitForAnalysis<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) },
    )
  })
}

function rms(samples: Float32Array, start: number, end: number): number {
  let sum = 0
  const stop = Math.min(samples.length, Math.max(start + 1, end))
  for (let i = Math.max(0, start); i < stop; i += 1) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, stop - start))
}

function zeroCrossing(samples: Float32Array, start: number, end: number): number {
  const stop = Math.min(samples.length, end)
  let changes = 0
  for (let i = Math.max(1, start + 1); i < stop; i += 1) {
    if ((samples[i - 1] >= 0) !== (samples[i] >= 0)) changes += 1
  }
  return changes / Math.max(1, stop - start)
}

function goertzel(samples: Float32Array, start: number, end: number, sampleRate: number, frequency: number): number {
  const length = Math.max(1, end - start)
  const step = Math.max(1, Math.floor(length / 768))
  const omega = (2 * Math.PI * frequency) / sampleRate
  const coeff = 2 * Math.cos(omega * step)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = start; i < end && i < samples.length; i += step) {
    s0 = samples[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / Math.max(1, length / step)
}

function normalize(values: number[]): number[] {
  const max = Math.max(...values, 1e-9)
  return values.map(value => clamp01(value / max))
}

function spectralFeatures(samples: Float32Array, start: number, end: number, sampleRate: number) {
  const chroma = new Array(12).fill(0)
  for (let midi = 36; midi <= 84; midi += 1) {
    const frequency = 440 * Math.pow(2, (midi - 69) / 12)
    chroma[midi % 12] += goertzel(samples, start, end, sampleRate, frequency)
  }
  const bandFrequencies = [80, 180, 420, 950, 2200, 5200]
  const timbre = normalize(bandFrequencies.map(frequency => goertzel(samples, start, end, sampleRate, frequency)))
  return { chroma: normalize(chroma), timbre }
}

function detectTempo(onset: number[], frameRate: number) {
  let bestLag = 0
  let bestScore = 0
  let total = 0
  for (const value of onset) total += value * value
  const minLag = Math.max(1, Math.floor(frameRate * 60 / 190))
  const maxLag = Math.min(onset.length - 1, Math.ceil(frameRate * 60 / 55))
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0
    for (let i = lag; i < onset.length; i += 1) score += onset[i] * onset[i - lag]
    score /= Math.max(1, onset.length - lag)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  const bpm = bestLag > 0 ? 60 * frameRate / bestLag : 120
  const normalizedConfidence = total > 0 ? clamp01(bestScore / (total / Math.max(1, onset.length)) / 3) : 0
  return { bpm: Math.max(55, Math.min(190, bpm)), period: bestLag / frameRate, confidence: normalizedConfidence }
}

function detectSilence(frameRms: number[], frameDuration: number, duration: number) {
  const sorted = [...frameRms].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  const threshold = Math.max(0.0015, median * 0.12)
  let first = 0
  while (first < frameRms.length && frameRms[first] <= threshold) first += 1
  let last = frameRms.length - 1
  while (last >= 0 && frameRms[last] <= threshold) last -= 1
  return {
    introSilence: Math.min(duration, first * frameDuration),
    outroSilence: Math.max(0, duration - (last + 1) * frameDuration),
  }
}

function buildBeatGrid(onset: number[], frameRate: number, period: number, duration: number) {
  if (!Number.isFinite(period) || period <= 0) return { beats: [] as number[], downbeats: [] as number[] }
  const searchFrames = Math.min(onset.length, Math.ceil(frameRate * 12))
  let anchorFrame = 0
  for (let i = 1; i < searchFrames; i += 1) if (onset[i] > onset[anchorFrame]) anchorFrame = i
  const anchor = anchorFrame / frameRate
  const beats: number[] = []
  for (let time = anchor; time >= 0; time -= period) beats.unshift(time)
  for (let time = anchor + period; time <= duration; time += period) beats.push(time)
  let bestPhase = 0
  let bestPhaseScore = -1
  for (let phase = 0; phase < 4; phase += 1) {
    let score = 0
    for (let index = phase; index < beats.length; index += 4) {
      const frame = Math.min(onset.length - 1, Math.max(0, Math.round(beats[index] * frameRate)))
      score += onset[frame] || 0
    }
    if (score > bestPhaseScore) {
      bestPhaseScore = score
      bestPhase = phase
    }
  }
  return { beats, downbeats: beats.filter((_, index) => index % 4 === bestPhase) }
}

function buildSections(beatFeatures: BeatFeatureFrame[], duration: number): SectionMarker[] {
  const sections: SectionMarker[] = [{ time: 0, beatIndex: 0, type: 'intro', confidence: 0.55 }]
  const novelty: number[] = []
  for (let i = 1; i < beatFeatures.length; i += 1) {
    const before = beatFeatures[i - 1]
    const after = beatFeatures[i]
    const timbreDelta = before.timbre.reduce((sum, value, index) => sum + Math.abs(value - (after.timbre[index] || 0)), 0) / Math.max(1, before.timbre.length)
    novelty.push(timbreDelta * 0.55 + Math.abs(after.energy - before.energy) * 0.45)
  }
  const mean = novelty.reduce((sum, value) => sum + value, 0) / Math.max(1, novelty.length)
  const variance = novelty.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / Math.max(1, novelty.length)
  const threshold = mean + Math.sqrt(variance) * 1.1
  let lastTime = 0
  novelty.forEach((value, index) => {
    const frame = beatFeatures[index + 1]
    if (!frame || frame.time < 15 || frame.time - lastTime < 8 || value < threshold) return
    const previousEnergy = beatFeatures[Math.max(0, index - 3)]?.energy ?? frame.energy
    const type: SectionMarker['type'] = frame.energy - previousEnergy > 0.18 ? 'drop' : frame.energy < 0.25 ? 'break' : 'unknown'
    sections.push({ time: frame.time, beatIndex: frame.beatIndex, type, confidence: clamp01(0.45 + value) })
    lastTime = frame.time
  })
  if (duration > 20) sections.push({ time: Math.max(0, duration * 0.82), beatIndex: Math.max(0, beatFeatures.length - 1), type: 'outro', confidence: 0.45 })
  return sections
}

// 保守降采样：单声道 + 22050Hz，供浏览器本地节拍检测使用。
// 直接整曲解码（数分钟 48kHz 立体声 ≈ 数十 MB Float32）在播放/切歌热路径
// 会形成内存峰值；降采样后的单声道 buffer 大幅缩减峰值，且分析的频带最高到
// 5200Hz（22050Hz 奈奎斯特 11025Hz 完整覆盖），BPM/能量/静音等结果语义不变。
// 已经是单声道且采样率不超过目标值时直接复用原 buffer，避免多余拷贝。
function toMonoDownsampled(buffer: AudioBuffer, context: AudioContext, targetRate = 22050): AudioBuffer {
  const channels = buffer.numberOfChannels
  const sourceRate = buffer.sampleRate
  if (channels === 1 && sourceRate <= targetRate) return buffer

  const outLength = Math.max(1, Math.floor(buffer.duration * targetRate))
  const output = context.createBuffer(1, outLength, targetRate)
  const outData = output.getChannelData(0)
  const ratio = sourceRate / targetRate
  // 盒式滤波降采样：对每个输出样本取对应输入区间内各声道样本的平均，
  // 既完成单声道混合，又抑制高频混叠并平滑包络。
  for (let i = 0; i < outLength; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(buffer.length, Math.ceil((i + 1) * ratio))
    let sum = 0
    for (let ch = 0; ch < channels; ch += 1) {
      const data = buffer.getChannelData(ch)
      for (let j = start; j < end; j += 1) sum += data[j]
    }
    outData[i] = sum / Math.max(1, (end - start) * channels)
  }
  return output
}

async function decodeUrl(url: string, signal?: AbortSignal): Promise<AudioBuffer> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`)
  const data = await response.arrayBuffer()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('Web Audio is unavailable')
  const context = new AudioContextCtor()
  try {
    const decoded = await context.decodeAudioData(data)
    // 解码后立即降采样为单声道，避免整曲立体声 PCM 留在内存里
    return toMonoDownsampled(decoded, context)
  } finally {
    void context.close()
  }
}

function metadataOnly(input: TrackAnalysisInput, reason: TrackAnalysis['provider'] = 'metadata-only'): TrackAnalysis {
  const now = Date.now()
  const duration = Math.max(0, input.duration || 0)
  return {
    schemaVersion: 1,
    trackKey: input.trackKey,
    duration,
    provider: reason,
    beats: [],
    downbeats: [],
    beatConfidence: [],
    downbeatConfidence: [],
    estimatedBpm: 120,
    meter: 4,
    confidence: 0,
    sections: [],
    beatFeatures: [],
    introSilence: 0,
    outroSilence: 0,
    sourceSignature: input.sourceSignature,
    analysisVersion: ANALYSIS_VERSION,
    createdAt: now,
    lastAccessAt: now,
  }
}

function analyzeBuffer(input: TrackAnalysisInput, buffer: AudioBuffer): TrackAnalysis {
  const channel = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const duration = buffer.duration
  const hop = Math.max(256, Math.round(sampleRate * 0.02))
  const frameSize = Math.max(hop * 2, 1024)
  const frameRate = sampleRate / hop
  const frameRms: number[] = []
  const onset: number[] = []
  let previous = 0
  for (let start = 0; start < channel.length; start += hop) {
    const value = rms(channel, start, start + frameSize)
    frameRms.push(value)
    onset.push(Math.max(0, value - previous) + Math.max(0, value - (frameRms[frameRms.length - 3] || value)) * 0.35)
    previous = value
  }
  const tempo = detectTempo(onset, frameRate)
  const grid = buildBeatGrid(onset, frameRate, tempo.period, duration)
  const silence = detectSilence(frameRms, hop / sampleRate, duration)
  const rawFeatures = grid.beats.map((time, beatIndex) => {
    const nextTime = grid.beats[beatIndex + 1] ?? Math.min(duration, time + tempo.period)
    const start = Math.max(0, Math.floor(time * sampleRate))
    const end = Math.min(channel.length, Math.max(start + 1, Math.floor(nextTime * sampleRate)))
    const beatRms = rms(channel, start, end)
    const spectral = spectralFeatures(channel, start, end, sampleRate)
    const zcr = zeroCrossing(channel, start, end)
    const mid = (spectral.timbre[2] || 0) + (spectral.timbre[3] || 0)
    const edge = (spectral.timbre[0] || 0) + (spectral.timbre[5] || 0)
    return { beatIndex, time, rms: beatRms, loudness: beatRms, energy: beatRms, chroma: spectral.chroma, timbre: spectral.timbre, vocalness: clamp01(mid / Math.max(0.01, mid + edge) * (1 - Math.min(1, zcr * 12))) }
  })
  const maxRms = Math.max(...rawFeatures.map(frame => frame.rms), 1e-6)
  const beatFeatures = rawFeatures.map(frame => ({ ...frame, loudness: clamp01(frame.loudness / maxRms), energy: clamp01(frame.energy / maxRms) }))
  const confidence = clamp01(tempo.confidence * (grid.downbeats.length >= 4 ? 1 : 0.5))
  const now = Date.now()
  return {
    schemaVersion: 1,
    trackKey: input.trackKey,
    duration,
    provider: 'browser-fallback',
    beats: grid.beats,
    downbeats: grid.downbeats,
    beatConfidence: grid.beats.map(() => confidence),
    downbeatConfidence: grid.downbeats.map(() => confidence * 0.85),
    estimatedBpm: tempo.bpm,
    meter: 4,
    confidence,
    sections: buildSections(beatFeatures, duration),
    beatFeatures,
    introSilence: silence.introSilence,
    outroSilence: silence.outroSilence,
    sourceSignature: input.sourceSignature,
    analysisVersion: ANALYSIS_VERSION,
    createdAt: now,
    lastAccessAt: now,
  }
}

class AutoMixAnalysisService {
  private pythonServiceAvailable: boolean | null = null
  private pythonServiceCheckedAt = 0
  private pythonHealthCheck: Promise<boolean> | null = null
  
  async checkPythonService(): Promise<boolean> {
    const cacheDuration = this.pythonServiceAvailable
      ? PYTHON_HEALTHY_CACHE_MS
      : PYTHON_UNAVAILABLE_RETRY_MS
    if (this.pythonServiceAvailable !== null && Date.now() - this.pythonServiceCheckedAt < cacheDuration) {
      return this.pythonServiceAvailable
    }
    if (this.pythonHealthCheck) return this.pythonHealthCheck

    const check = this.probePythonService()
    this.pythonHealthCheck = check
    try {
      return await check
    } finally {
      if (this.pythonHealthCheck === check) this.pythonHealthCheck = null
    }
  }

  private async probePythonService(): Promise<boolean> {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), PYTHON_HEALTH_TIMEOUT_MS)
    try {
      const response = await fetch(`${PYTHON_BEAT_SERVICE_URL}/health`, {
        signal: controller.signal
      })

      if (response.ok) {
        const data = await response.json()
        this.pythonServiceAvailable = data.status === 'ok'
        if (this.pythonServiceAvailable) debugLog('✅ [AutoMix] Python Beat Service 可用:', data.version)
      } else {
        this.pythonServiceAvailable = false
      }
    } catch {
      this.pythonServiceAvailable = false
    } finally {
      window.clearTimeout(timeoutId)
      this.pythonServiceCheckedAt = Date.now()
    }

    return this.pythonServiceAvailable === true
  }
  
  async tryPythonBeatService(input: TrackAnalysisInput): Promise<TrackAnalysis | null> {
    const isAvailable = await this.checkPythonService()
    if (!isAvailable) {
      return null
    }
    
    const controller = new AbortController()
    let timedOut = false
    const abortFromCaller = () => controller.abort(input.signal?.reason)
    if (input.signal?.aborted) throw abortReason(input.signal)
    input.signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeoutId = window.setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('Python analysis timed out', 'TimeoutError'))
    }, PYTHON_ANALYSIS_TIMEOUT_MS)

    try {
      let audioPath = input.url
      
      // 如果是 URL，先下载到本地缓存
      if (input.url.startsWith('http://') || input.url.startsWith('https://')) {
        debugLog('⏳ [AutoMix] 下载音频文件到本地缓存...')
        
        // 使用 Electron 的音频下载服务
        if (window.electron?.audioDownload) {
          try {
            audioPath = await window.electron.audioDownload.prepare(input.url, input.trackKey)
            debugLog('✅ [AutoMix] 音频文件已缓存:', audioPath)
          } catch (error) {
            console.warn('⚠️ [AutoMix] 音频下载失败:', error)
            return null
          }
        } else {
          console.warn('⚠️ [AutoMix] Electron 音频下载服务不可用')
          return null
        }
      }
      
      const response = await fetch(`${PYTHON_BEAT_SERVICE_URL}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          trackKey: input.trackKey,
          audioPath: audioPath,
          duration: input.duration || 0
        }),
        signal: controller.signal
      })
      
      if (response.ok) {
        const result = await response.json()
        if (!isSupportedAnalysis(result)) {
          console.warn('⚠️ [AutoMix] Python 分析版本已过期，忽略结果:', result.analysisVersion)
          return null
        }
        debugLog('✅ [AutoMix] Python 分析完成:', {
          trackKey: result.trackKey,
          bpm: result.estimatedBpm,
          beats: result.beats?.length || 0,
          confidence: result.confidence
        })
        return result
      } else {
        const errorData = await response.json().catch(() => ({}))
        console.error('❌ [AutoMix] Python 服务错误:', response.status)
        console.error('   错误信息:', errorData.error)
        console.error('   音频路径:', errorData.audioPath)
        if (errorData.traceback) {
          console.error('   堆栈跟踪:')
          console.error(errorData.traceback)
        }
        return null
      }
    } catch (error) {
      if (input.signal?.aborted) throw abortReason(input.signal)
      if (timedOut) {
        console.warn(`⚠️ [AutoMix] Python 分析超过 ${PYTHON_ANALYSIS_TIMEOUT_MS / 1000} 秒，使用回退分析`)
        return null
      }
      console.warn('⚠️ [AutoMix] Python 服务调用失败:', error)
      // A request failure is not a permanent service verdict; health will be retried.
      this.pythonServiceAvailable = null
      this.pythonServiceCheckedAt = 0
      return null
    } finally {
      window.clearTimeout(timeoutId)
      input.signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  async getCached(trackKey: string): Promise<TrackAnalysis | null> {
    const normalizedTrackKey = trackKey.trim()
    if (!normalizedTrackKey) return null
    for (const [key, analysis] of memoryCache.entries()) {
      if (analysis.trackKey === normalizedTrackKey && isSupportedAnalysis(analysis)) {
        cacheInMemory(key, analysis)
        return { ...analysis, lastAccessAt: Date.now() }
      }
    }
    try {
      return await window.electron?.analysis?.getTrackAnalysis(normalizedTrackKey) || null
    } catch {
      return null
    }
  }

  /**
   * 浏览器端整曲分析（Chromium decodeAudioData 原生支持 m4a/aac——Python/librosa
   * 侧 libsndfile 打不开这些格式，是桌面端分析失败的主要原因）。
   * 优先解码已下载的本地文件（waveforge-media://），失败再回退直接抓取原始 URL。
   * 桌面端仅当 Python/Electron 分析产出空节拍网格时才走此路径；结果会正常缓存，
   * 同一首歌只解码一次。
   */
  private async analyzeInBrowser(input: TrackAnalysisInput): Promise<TrackAnalysis> {
    try {
      const localPath = await window.electron?.audioDownload?.prepare?.(input.url, input.trackKey)
      const mediaUrl = localPath ? await window.electron?.audioDownload?.getMediaUrl?.(localPath) : undefined
      if (mediaUrl) {
        debugLog('🎧 [AutoMix] 浏览器解码本地文件（可支持 m4a/aac）:', localPath)
        return analyzeBuffer(input, await decodeUrl(mediaUrl, input.signal))
      }
    } catch (error) {
      debugLog('⚠️ [AutoMix] 本地文件解码失败，尝试直接抓取 URL:', error)
    }
    debugLog('🎧 [AutoMix] 直接抓取原始 URL 解码')
    return analyzeBuffer(input, await decodeUrl(input.url, input.signal))
  }

  private async analyzeAndCache(input: TrackAnalysisInput, key: string): Promise<TrackAnalysis> {
    const persisted = await this.getCached(input.trackKey)
    const signatureMatches = !input.sourceSignature || persisted?.sourceSignature === input.sourceSignature
    if (persisted && signatureMatches && isSupportedAnalysis(persisted) && Math.abs(persisted.duration - (input.duration || persisted.duration)) < 2) {
      cacheInMemory(key, persisted)
      return persisted
    }

    let analysis: TrackAnalysis
    // Transient failures (Python service down/timed out, Electron analysis
    // empty) must not be cached or persisted; doing so would permanently
    // replace a later good analysis until cache eviction.
    let isTransientFallback = false
    try {
      // 优先尝试独立的 Python API 服务
      debugLog('🔍 [AutoMix] 尝试使用 Python Beat Service...')
      const pythonResult = await this.tryPythonBeatService(input)
      if (pythonResult && hasUsableBeats(pythonResult)) {
        debugLog('✅ [AutoMix] Python Beat Service 分析成功')
        analysis = pythonResult
      } else {
        // 回退到 Electron 内置分析
        const runtime = await window.electron?.analysis?.getStatus()
        if (runtime?.available || runtime?.pythonAvailable) {
          debugLog('⚠️ [AutoMix] Python Beat Service 不可用，使用 Electron 内置分析')
          const job = await window.electron?.analysis?.startTrackAnalysis({
            trackKey: input.trackKey,
            audioPath: input.url,
            duration: input.duration,
            sourceSignature: input.sourceSignature,
          })
          if (job?.result && hasUsableBeats(job.result)) {
            analysis = job.result
          } else {
            // Electron/Python 分析失败或产出空节拍网格（常见：m4a/aac 等
            // libsndfile 不支持格式解码失败 → worker 返回 metadata-only）。
            // 回退浏览器整曲解码分析——Chromium 原生支持 m4a/aac。
            // 该分析结果会正常缓存，同一首歌只解码一次；正常歌曲不触发此路径。
            debugLog('⚠️ [AutoMix] Electron 分析结果无效，回退浏览器本地检测')
            try {
              analysis = await this.analyzeInBrowser(input)
            } catch (browserError) {
              debugLog('⚠️ [AutoMix] 浏览器分析失败，使用元数据回退:', browserError)
              isTransientFallback = true
              analysis = metadataOnly(input, 'electron-unavailable')
            }
          }
        } else if (window.electron?.analysis) {
          debugLog('⚠️ [AutoMix] Electron 分析不可用，回退浏览器本地检测')
          try {
            analysis = await this.analyzeInBrowser(input)
          } catch (browserError) {
            debugLog('⚠️ [AutoMix] 浏览器分析失败，使用元数据回退:', browserError)
            isTransientFallback = true
            analysis = metadataOnly(input, 'electron-unavailable')
          }
        } else if (isTvModeActive()) {
          // TV 弱机：没有独立分析进程，且浏览器整曲 decodeAudioData 在 WebView 里
          // 是数百 MB 级开销（每次 AutoMix 过渡都会触发）。直接元数据回退，
          // 保持 fixed-crossfade 可用，不再走渲染进程整曲解码。
          debugLog('⚠️ [AutoMix] TV 端跳过浏览器整曲解码，使用元数据回退')
          isTransientFallback = true
          analysis = metadataOnly(input, 'metadata-only')
        } else {
          // Web 版没有独立分析进程，才使用浏览器本地检测。
          debugLog('⚠️ [AutoMix] 使用浏览器本地节拍检测')
          analysis = analyzeBuffer(input, await decodeUrl(input.url, input.signal))
        }
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      console.warn('⚠️ [AutoMix] 所有分析方法失败，使用保守回退方案', error)
      isTransientFallback = true
      analysis = metadataOnly(input, window.electron?.analysis ? 'electron-unavailable' : 'metadata-only')
    }

    // Only cache/persist genuine analyses. A transient metadata-only fallback
    // is still returned so the current transition keeps working via the
    // fallback, but it is not stored under the normal key: caching it would pin
    // the track to an empty beat grid (fixed-crossfade) until eviction and mask
    // any later good analysis.
    if (!isTransientFallback) {
      cacheInMemory(key, analysis)
      try {
        await window.electron?.analysis?.saveTrackAnalysis(analysis)
      } catch {
        // Browser mode and read-only runtimes intentionally use memory cache only.
      }
    }
    return analysis
  }

  async analyze(input: TrackAnalysisInput): Promise<TrackAnalysis> {
    if (input.signal?.aborted) throw abortReason(input.signal)

    const trackKey = input.trackKey.trim()
    const url = input.url.trim()
    if (!trackKey) throw new Error('Track analysis requires a non-empty track key')
    if (!url) throw new Error('Track analysis requires a non-empty audio URL or path')
    input = { ...input, trackKey, url }

    const key = cacheKey(input)
    const inMemory = memoryCache.get(key)
    if (inMemory && isSupportedAnalysis(inMemory)) {
      cacheInMemory(key, inMemory)
      return { ...inMemory, lastAccessAt: Date.now() }
    }
    if (inMemory) memoryCache.delete(key)

    let analysisPromise = inFlightAnalyses.get(key)
    if (!analysisPromise) {
      // The shared job is intentionally independent of any single caller. Each
      // caller can cancel its own wait without spawning or killing duplicate work.
      analysisPromise = this.analyzeAndCache({ ...input, signal: undefined }, key)
      inFlightAnalyses.set(key, analysisPromise)
      analysisPromise.then(
        () => { if (inFlightAnalyses.get(key) === analysisPromise) inFlightAnalyses.delete(key) },
        () => { if (inFlightAnalyses.get(key) === analysisPromise) inFlightAnalyses.delete(key) },
      )
    }

    return waitForAnalysis(analysisPromise, input.signal)
  }

  clearMemoryCache() {
    memoryCache.clear()
  }

  /**
   * 只读内存缓存中的节拍时间点（秒）：看歌视频漂移校正吸附到最近节拍用。
   * 不触发任何分析/网络请求——仅当 automix 已分析过这首歌（beat_this/librosa）才有数据。
   */
  getCachedBeats(trackKey: string, url: string, duration?: number): number[] | null {
    const analysis = memoryCache.get(cacheKey({ trackKey, url, duration }))
    if (analysis && isSupportedAnalysis(analysis) && Array.isArray(analysis.beats) && analysis.beats.length > 0) {
      return analysis.beats
    }
    return null
  }

  async clearCache() {
    this.clearMemoryCache()
    await window.electron?.analysis?.clearCache()
  }
}

export const autoMixAnalysisService = new AutoMixAnalysisService()
