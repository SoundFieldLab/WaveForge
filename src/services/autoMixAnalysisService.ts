/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { debugLog } from '../utils/debugLog'
import { isTvModeActive } from '../platform'
import type { BeatFeatureFrame, SectionMarker, TrackAnalysis } from '../audio/types'

/** MV 网格调试日志（automix-backend.log 的 [renderer:MvAlign]），人工核对对齐质量用 */
const mvGridLog = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log('[MvAlign]', msg)
  void window.electron?.automixLog?.('MvAlign', msg)?.catch?.(() => undefined)
}

export interface TrackAnalysisInput {
  trackKey: string
  url: string
  duration?: number
  /**
   * 期望 BPM（可选）。MV 对齐等场景：MV 音频与歌曲同源时，用歌曲 BPM 重建 MV
   * 节拍网格，避免浏览器回退 DSP 锁到 2x/3x 慢拍子谐波，导致两套节拍对不上。
   * 提示错误时网格贴合度（confidence）会很低，下游自然拒绝，不会误伤。
   */
  bpmHint?: number
  /**
   * 期望拍点模式（可选，秒）：歌曲的真实节拍时间序列。MV 与歌曲同源 → MV 的拍点
   * 就是「歌曲拍点 + 整体偏移」。规则网格在歌曲变速/漂移（librosa BPM 只是平均
   * 节奏，实测一首歌累积漂移可达 4s+）时与真实拍点失配，紧容差匹配必失败；
   * 用真实拍点模式在 MV onset 上滑动相关求偏移，对变速鲁棒。
   */
  beatTimesHint?: number[]
  /**
   * 与 beatTimesHint 逐拍对应的能量权重（歌曲分析 beatFeatures[].energy）。
   * 整条拍点模式平移整数个拍周期仍能对上相邻拍 onset（稳定节拍下各峰几乎等高），
   * 造成偏移歧义（实测可错 2 句歌词）。加权相关让强拍/段落强弱差异打破混叠。
   */
  beatWeightsHint?: number[]
  /**
   * 歌曲音频的逐帧 RMS 包络（可选）：MV 与歌曲同源 → 两者的包络一致（相差偏移）。
   * 提供时用包络互相关求精确偏移——对安静前奏/节拍混叠最鲁棒（onset 相关在安静
   * 前奏区噪声大，实测 rainy tone 偏移晚 ~10s）。
   */
  rmsEnvelopeHint?: number[]
  sourceSignature?: string
  signal?: AbortSignal
}

const ANALYSIS_VERSION = 'fallback-dsp-v1'
const PYTHON_ANALYSIS_VERSIONS = new Set(['librosa-dsp-v3', 'beat-this-dsp-v1'])
/** 低于该置信度的 browser-fallback 结果视为节拍网格不可信，不缓存/不复用 */
const BROWSER_FALLBACK_MIN_PERSIST_CONFIDENCE = 0.4
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
  // rmsEnvelopeHint 是否携带也入键：预热分析（无歌曲包络 → 音乐起始锚点）与 commit
  // 分析（有歌曲包络 → 包络互相关锚点）算出的网格不同，混用会让预热结果污染精确结果
  // （实测ニコカラ 14.34s 被预热结果覆盖成 12.91s）。
  const hasEnvelopeHint = Array.isArray(input.rmsEnvelopeHint) && input.rmsEnvelopeHint.length > 0 ? 'rms1' : 'rms0'
  return `${input.trackKey}:${Math.round(input.duration || 0)}:${input.sourceSignature || ''}:${input.bpmHint || ''}:${hasEnvelopeHint}:${ANALYSIS_VERSION}`
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
  return analysis.analysisVersion === ANALYSIS_VERSION || PYTHON_ANALYSIS_VERSIONS.has(analysis.analysisVersion)
}

/**
 * 弱 browser-fallback 结果（置信度过低的节拍网格，如 B 站 MV 音频被 DSP 锁到
 * 慢拍子谐波时的 55 BPM 假网格）。这类结果不可信，不能进入缓存：一旦持久化会被
 * 复用 30 天，把歌曲钉死在空/坏网格上；也不应从缓存里取出来复用。
 * 例外：带拍点模式签名（pattern:）的结果网格锚定歌曲真实节拍，其质量由对齐判定
 * （detectOffsetFromBeats + 网格贴合度把关）把关，不受 0.4 阈值误伤（否则每次会话重算）。
 */
function isWeakBrowserFallback(analysis: TrackAnalysis | null | undefined): boolean {
  if (!analysis || analysis.provider !== 'browser-fallback') return false
  if (typeof analysis.sourceSignature === 'string' && analysis.sourceSignature.startsWith('pattern:')) return false
  return (analysis.confidence ?? 0) < BROWSER_FALLBACK_MIN_PERSIST_CONFIDENCE
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
  let total = 0
  for (const value of onset) total += value * value
  const minLag = Math.max(1, Math.floor(frameRate * 60 / 190))
  const maxLag = Math.min(onset.length - 1, Math.ceil(frameRate * 60 / 55))
  const scores: number[] = []
  let bestLag = 0
  let bestScore = 0
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0
    for (let i = lag; i < onset.length; i += 1) score += onset[i] * onset[i - lag]
    score /= Math.max(1, onset.length - lag)
    scores[lag] = score
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  // 慢拍子谐波纠偏：MV 音频这类包络强分组的信号，自相关峰值常落在 2x/3x 的慢拍
  // 周期上（实测 161.5 BPM 的歌被锁成 55 BPM ≈ 3 倍周期）。若最佳 lag 接近更短
  // lag 的整数倍、且该短 lag 得分不低于最佳得分的 80%，取其中得分最高者——真实
  // 节拍周期的自相关通常强于其整数倍周期。
  if (bestLag > 0) {
    let bestSubLag = 0
    let bestSubScore = 0
    for (const divisor of [2, 3, 4]) {
      const sub = bestLag / divisor
      if (sub < minLag) break
      const rounded = Math.round(sub)
      if (rounded <= 0 || Math.abs(sub - rounded) / rounded > 0.04) continue
      const subScore = scores[rounded] || 0
      if (subScore >= bestScore * 0.8 && subScore > bestSubScore) {
        bestSubLag = rounded
        bestSubScore = subScore
      }
    }
    if (bestSubLag > 0) {
      bestLag = bestSubLag
      bestScore = bestSubScore
    }
  }
  const bpm = bestLag > 0 ? 60 * frameRate / bestLag : 120
  const normalizedConfidence = total > 0 ? clamp01(bestScore / (total / Math.max(1, onset.length)) / 3) : 0
  return { bpm: Math.max(55, Math.min(190, bpm)), period: bestLag / frameRate, confidence: normalizedConfidence }
}

/**
 * 节拍网格与 onset 能量的贴合度：网格位置（±3 帧窗口）上的 onset 均值相对全局基线
 * 的抬升。bpmHint/beatTimesHint 场景用它判断"提示是否正确"——MV 与歌曲同源则网格
 * 压在 onset 上（高分），错拍/对不上则网格落空（低分），下游据此取舍。
 * 窗口容忍亚帧/小幅偏移残差（精确帧取值对 0.05s 级残差过于敏感，会误杀正确对齐）。
 */
function gridOnsetConfidence(onset: number[], frameRate: number, beats: number[]): number {
  const WINDOW_FRAMES = 3
  const frameSet = new Set<number>()
  for (const time of beats) {
    const center = Math.min(onset.length - 1, Math.max(0, Math.round(time * frameRate)))
    const from = Math.max(0, center - WINDOW_FRAMES)
    const to = Math.min(onset.length - 1, center + WINDOW_FRAMES)
    for (let f = from; f <= to; f += 1) frameSet.add(f)
  }
  if (frameSet.size < 4) return 0
  let gridSum = 0
  let totalSum = 0
  for (const [index, value] of onset.entries()) {
    totalSum += value
    if (frameSet.has(index)) gridSum += value
  }
  const overall = totalSum / Math.max(1, onset.length)
  const atGrid = gridSum / frameSet.size
  if (overall <= 1e-9) return 0
  return clamp01((atGrid / overall - 1) / 2)
}

/**
 * 检测 MV 音频的音乐起始点（秒）：基于帧 RMS 电平（音频强度）而非 onset 瞬态。
 * 音乐（即便安静前奏）有持续低电平，静音/台词区电平极低——电平上升是最可靠的
 * "音乐开始"信号。onset 强帧法会把安静前奏的起始推迟到强拍区（实测 rainy tone
 * 晚 ~10s ≈ 2 句歌词：前摇实为 15-18s 而强帧法找 27s）。
 * 阈值取 max(底噪×4, 峰值×5%)；底噪用 5% 分位数（排除安静前奏污染）。
 */
export function detectMusicStart(rms: number[], frameRate: number): number {
  const n = rms.length
  if (n < frameRate * 2) return 0
  let maxV = 0
  for (const v of rms) if (v > maxV) maxV = v
  if (maxV <= 1e-6) return 0
  const sorted = [...rms].sort((a, b) => a - b)
  const floor = sorted[Math.min(n - 1, Math.floor(n * 0.05))]
  const threshold = Math.max(floor * 4, maxV * 0.05)
  const win = Math.max(1, Math.round(frameRate * 0.5))
  let sum = 0
  for (let i = 0; i < win && i < n; i++) sum += rms[i]
  for (let i = 0; i <= n - win; i++) {
    if (sum / win > threshold) {
      // 持续检查：接下来 6s 里至少 4 个 1s 窗口均值高于阈值——台词爆发（短促且
      // 随后长静音）被拒，音乐（持续不断）通过。rainy tone 实测 2-4s 台词电平
      // 高于 15-27s 的安静前奏，仅靠电平会把起始误判到台词处。
      const secWin = Math.max(1, Math.round(frameRate))
      let above = 0
      let total = 0
      for (let j = i + win; j + secWin <= n && total < 6; j += secWin) {
        let s2 = 0
        for (let k = j; k < Math.min(n, j + secWin); k++) s2 += rms[k]
        if (s2 / secWin > threshold) above++
        total++
      }
      if (above >= 4 && total >= 4) return i / frameRate
    }
    sum -= rms[i]
    if (i + win < n) sum += rms[i + win]
  }
  return 0
}

/**
 * 现场/翻唱 MV 的"音乐/歌声入口"检测（live 前奏补偿专用）。
 * detectMusicStart 用绝对电平阈值（floor×4），对动态压缩的现场版不稳定（实测同一现场版
 * 在 12kHz 与 22050Hz 解码下分别得到 22.4s 与 55.4s）。这里用全局 60 分位 + 持续判定：
 * 首个 ≥1s 的 RMS 均值超 60 分位、且其后 6s 内 ≥3 个 1s 窗口同样超阈值——对短促的人群/
 * 掌声爆发免疫，且在两种采样率下结果一致（实测 20.9s / 21.8s ≈ 真实音乐入口）。
 */
export function detectLiveMusicEntry(rms: number[], frameRate: number): number {
  const n = rms.length
  if (n < frameRate * 2) return 0
  const sorted = [...rms].sort((a, b) => a - b)
  const threshold = sorted[Math.min(n - 1, Math.floor(n * 0.6))]
  const win = Math.max(1, Math.round(frameRate))
  if (threshold <= 1e-6) return 0
  for (let i = 0; i + win <= n; i++) {
    let sum = 0
    for (let k = i; k < i + win; k++) sum += rms[k]
    if (sum / win <= threshold) continue
    let above = 0
    let total = 0
    for (let j = i + win; j + win <= n && total < 6; j += win) {
      let s2 = 0
      for (let k = j; k < j + win; k++) s2 += rms[k]
      if (s2 / win > threshold) above++
      total++
    }
    if (above >= 3 && total >= 3) return i / frameRate
  }
  return 0
}

/** 旧版 onset 强帧法（无 RMS 数据时的兜底） */
function detectMusicStartOnset(onset: number[], frameRate: number): number {
  const n = onset.length
  if (n < frameRate * 2) return 0
  let maxV = 0
  for (const v of onset) if (v > maxV) maxV = v
  if (maxV <= 1e-9) return 0
  const strongThreshold = maxV * 0.2
  const win = Math.round(frameRate)
  const needStrong = 3
  const sustainWin = Math.round(frameRate * 3)
  const needSustain = 3
  let strong = 0
  for (let i = 0; i < win && i < n; i++) if (onset[i] > strongThreshold) strong++
  for (let i = 0; i <= n - win; i++) {
    if (strong >= needStrong) {
      let next = 0
      const nextEnd = Math.min(n, i + win + sustainWin)
      for (let j = i + win; j < nextEnd; j++) if (onset[j] > strongThreshold) next++
      if (next >= needSustain) {
        for (let j = i; j < i + win; j++) if (onset[j] > strongThreshold) return j / frameRate
      }
    }
    if (onset[i] > strongThreshold) strong--
    if (i + win < n && onset[i + win] > strongThreshold) strong++
  }
  return 0
}

/**
 * 用歌曲真实拍点模式在 MV onset 上滑动相关求偏移（beatTimesHint 路径）。
 * MV 与歌曲同源 → MV 的拍点 = 歌曲拍点 + 整体偏移 δ。规则网格在歌曲变速/漂移时
 * 与真实拍点失配（实测累积漂移可达 4s+），这里直接按拍点模式逐 δ 计算
 * 「落在拍点上的 onset 均值」，取峰值 δ 即精确偏移；对变速/漂移鲁棒。
 * 搜索范围对齐 MAX_SANE_OFFSET_SECONDS（±45s），粗扫 0.05s + 峰值邻域 0.01s 精化。
 *
 * 混叠防护（"不是每首歌都这样"的智能判断）：
 * - weights（歌曲逐拍能量）：强拍/段落强弱差异加权，弱化"整条模式平移整数拍仍能对上
 *   相邻拍 onset"的歧义。
 * - 音乐起始锚点软偏置：前摇（台词/空白）场景下，音乐开始处就是偏移的锚；给锚点附近
 *   的候选 δ 加窄高斯偏置，让 argmax 倾向真峰。
 * - 峰唯一性：次峰（距主峰 ≥1.5 拍周期）与主峰几乎等高时偏移不可信 → 置信度下调
 *   （宁可自由播放也不套错偏移；货不对板 MV 的曲线整体平坦 → 自然被拒）。
 */
function findBeatPatternGrid(
  onset: number[],
  frameRate: number,
  pattern: number[],
  duration: number,
  weights?: number[],
  rms?: number[],
  songRms?: number[],
): {
  beats: number[]
  downbeats: number[]
  offset: number
  confidence: number
  /** 包络互相关峰值（无可信包络时为 undefined）：网格因 MV 节拍缺失而失效时，
   *  峰值 ≥0.6 的包络偏移是"同录音"的强证据，调用方可兜底使用 */
  envelopePeak?: number
  /** 包络互相关偏移（秒，envelopePeak ≥0.6 时才可信） */
  envelopeOffset?: number
} {
  const minOffset = -45
  const maxOffset = 45
  // 包络强相关时随结果带出（函数级变量：if 块内的 env 在 return 处不可见）
  let envelopePeak: number | undefined
  let envelopeOffset: number | undefined
  // onset 脉冲宽约 2-5 帧。窗口必须远小于相邻拍距（129BPM 约 23 帧），否则会捞到
  // 相邻拍的 onset 造成"偏移错一拍的假峰"；粗扫步长取 0.05s（2.5 帧）确保命中峰。
  const WINDOW_FRAMES = 3
  const scoreAt = (offset: number): number => {
    let sum = 0
    let weightSum = 0
    for (let i = 0; i < pattern.length; i += 1) {
      const t = pattern[i] + offset
      if (t < 0 || t > duration) continue
      const frame = Math.round(t * frameRate)
      let local = 0
      const from = Math.max(0, frame - WINDOW_FRAMES)
      const to = Math.min(onset.length - 1, frame + WINDOW_FRAMES)
      for (let f = from; f <= to; f += 1) {
        if (onset[f] > local) local = onset[f]
      }
      const w = weights && weights[i] > 0 ? weights[i] : 1
      sum += w * local
      weightSum += w
    }
    return weightSum > 0 ? sum / weightSum : 0
  }
  // 音乐起始锚点：有歌曲包络提示时优先用包络互相关（最精确）——但仅当相关峰够强
  // （≥0.6，MV 音频≈同一录音）才可信。弱峰（不同混音/翻唱/压扁动态的搬运，如音量减半的
  // 中文字幕版）会在噪声处找到假偏移（实测把 0 偏移的视频错对齐到 ~9.5s → 慢 2 句歌词），
  // 此时回退 RMS 音乐起始锚点——对同录音 MV 它仍≈前摇长度，对不同混音 MV 它给出≈0。
  // 窄高斯偏置让粗扫选峰倾向锚点，打破"偏移错整数拍仍能对上相邻拍"的混叠。
  // 歌曲音乐起始：优先 detectMusicStart(songRms)（首拍可能与音乐起始差数秒，如 PLACEBO
  // 首拍 5.04s 而音乐 7.38s 起，用首拍会让锚点偏 2.3s → 差一句歌词）；与首拍差异过大
  // （>4s，detectMusicStart 对极安静前奏会误判到后段响部）则回退首拍。
  const songStartEstimate = (() => {
    if (!songRms || songRms.length === 0) return pattern[0] ?? 0
    const songStart = detectMusicStart(songRms, frameRate)
    const p0 = pattern[0] ?? 0
    return Math.abs(songStart - p0) <= 4 ? songStart : p0
  })()
  let anchor: number
  let anchorKind = 'onset'
  if (songRms && songRms.length > 0 && rms && rms.length > 0) {
    const env = envelopeOffsetOf(rms, songRms, frameRate)
    if (env.peak >= 0.6) {
      anchor = env.offset
      anchorKind = `envelope(peak=${env.peak.toFixed(2)})`
      envelopePeak = env.peak
      envelopeOffset = env.offset
    } else {
      anchor = detectMusicStart(rms, frameRate) - songStartEstimate
      anchorKind = `musicStart(envPeak=${env.peak.toFixed(2)}<0.6回退, 歌曲起始=${songStartEstimate.toFixed(2)}s)`
    }
  } else {
    const musicStart = rms && rms.length > 0 ? detectMusicStart(rms, frameRate) : detectMusicStartOnset(onset, frameRate)
    anchor = musicStart - songStartEstimate
    anchorKind = rms && rms.length > 0 ? `musicStart(${musicStart.toFixed(2)}s, 歌曲起始=${songStartEstimate.toFixed(2)}s)` : `onset(${musicStart.toFixed(2)}s)`
  }
  mvGridLog(`锚点: ${anchorKind} anchor=${anchor.toFixed(2)}s pattern[0]=${(pattern[0] ?? 0).toFixed(2)}s`)
  const ANCHOR_SIGMA = 1.0
  const ANCHOR_BIAS = 0.04
  const biasedScore = (offset: number): number =>
    scoreAt(offset) + ANCHOR_BIAS * Math.exp(-0.5 * Math.pow((offset - anchor) / ANCHOR_SIGMA, 2))

  let bestOffset = 0
  let bestScore = -1
  for (let offset = minOffset; offset <= maxOffset + 1e-9; offset += 0.05) {
    const score = biasedScore(offset)
    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }
  // 精化同样用带锚点偏置的分数：弱 onset 的 MV（全局均值极低）原始分数峰平坦/噪声大，
  // 纯 raw 精化会漂移出锚点（实测フラジール 从 0 漂到 -0.10 → 网格贴合度归零）。
  // 锚点（音乐起始）已被真实数据验证准确（±0.1-0.3s），精化保持在其邻域。
  for (let d = -0.05; d <= 0.05 + 1e-9; d += 0.01) {
    const offset = bestOffset + d
    const score = biasedScore(offset)
    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }
  // 次峰：距主峰 ≥1.5 个拍周期（跳过主峰邻域）的最高分；两者接近 → 混叠歧义
  const medianInterval = pattern.length > 8 ? medianOf(pattern.slice(1).map((t, i) => t - pattern[i])) : 0.4
  const minGap = Math.max(0.6, medianInterval * 1.5)
  let secondBest = 0
  for (let offset = minOffset; offset <= maxOffset + 1e-9; offset += 0.05) {
    if (Math.abs(offset - bestOffset) < minGap) continue
    const score = scoreAt(offset)
    if (score > secondBest) secondBest = score
  }
  const clarity = bestScore > 0 ? (bestScore - secondBest) / bestScore : 0
  const beats = pattern
    .map((beat) => beat + bestOffset)
    .filter((t) => t >= 0 && t <= duration)
    .sort((a, b) => a - b)
  const baseConfidence = gridOnsetConfidence(onset, frameRate, beats)
  // 峰唯一性缩放：只按比例衰减、不归零——无前摇官方 MV 相关曲线对称（±拍次峰
  // 等高），归零会把"offset≈0 的正确对齐"也杀掉（实测フラジール conf 0.000）。
  // 货不对板/不同录音由 baseConfidence（网格与 MV 贴合度）主判定 + detectViaBeats
  // 0.15 门槛把关，清晰度是辅助衰减。
  const clarityFactor = 0.35 + 0.65 * clamp01((clarity - 0.01) / 0.04)
  const confidence = baseConfidence * clarityFactor
  mvGridLog(`网格结果: offset=${bestOffset.toFixed(2)}s baseConf=${baseConfidence.toFixed(3)} clarity=${clarity.toFixed(3)} factor=${clarityFactor.toFixed(2)} → conf=${confidence.toFixed(3)} beats=${beats.length}`)
  return {
    beats,
    downbeats: beats.filter((_, index) => index % 4 === 0),
    offset: bestOffset,
    confidence,
    // 包络信息随结果返回：MV 节拍缺失（metadata-only）时网格置信度无意义，
    // 但强包络相关（peak≥0.6）证明 MV 与歌曲同录音 → 调用方可用包络偏移兜底
    ...(envelopePeak !== undefined ? { envelopePeak, envelopeOffset } : {}),
  }
}

/** 中位数（findBeatPatternGrid 拍周期估计用） */
function medianOf(values: number[]): number {
  if (!values.length) return 0.4
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 包络互相关求偏移（歌曲 RMS 包络提示存在时）：MV 与歌曲同源 → 两者的 RMS 包络一致，
 * 相差一个偏移。皮尔逊相关对幅度不敏感，安静前奏/节拍混叠下最鲁棒（onset 相关在
 * 安静前奏区噪声大，实测 rainy tone 偏移晚 ~10s）。先降采样到 10fps，粗扫 0.25s + 精化。
 */
export function envelopeOffsetOf(mvRms: number[], songRms: number[], frameRate: number): { offset: number; peak: number } {
  const step = Math.max(1, Math.round(frameRate / 10))
  const song: number[] = []
  for (let i = 0; i < songRms.length; i += step) song.push(songRms[i])
  const mv: number[] = []
  for (let i = 0; i < mvRms.length; i += step) mv.push(mvRms[i])
  const pearson = (deltaFrames: number): number => {
    const a: number[] = []
    const b: number[] = []
    for (let i = 0; i < song.length; i += 1) {
      const j = i + deltaFrames
      if (j < 0 || j >= mv.length) continue
      a.push(song[i])
      b.push(mv[j])
    }
    const n = a.length
    if (n < 64) return -1
    let ma = 0
    let mb = 0
    for (let k = 0; k < n; k += 1) { ma += a[k]; mb += b[k] }
    ma /= n
    mb /= n
    let num = 0
    let da = 0
    let db = 0
    for (let k = 0; k < n; k += 1) {
      const x = a[k] - ma
      const y = b[k] - mb
      num += x * y
      da += x * x
      db += y * y
    }
    return da * db > 0 ? num / Math.sqrt(da * db) : -1
  }
  const coarse = Math.round(2.5) // 0.25s @10fps
  const minF = Math.round(-45 * 10)
  const maxF = Math.round(45 * 10)
  let bestF = 0
  let bestS = -1
  for (let f = minF; f <= maxF; f += coarse) {
    const s = pearson(f)
    if (s > bestS) { bestS = s; bestF = f }
  }
  for (let d = -coarse; d <= coarse; d += 1) {
    const s = pearson(bestF + d)
    if (s > bestS) { bestS = s; bestF = bestF + d }
  }
  return { offset: bestF / 10, peak: bestS }
}

function detectSilence(frameRms: number[], frameDuration: number, duration: number) {
  // 固定绝对阈值（-45dBFS）：与 Python 分析（beat_analyzer.py _detect_silence_bounds）同一语义。
  // 不用相对中位数自适应——安静乐段会被误判成静音，裁剪点随曲目漂移；
  // 过渡入点/无缝拼接需要的是确定性的"真静音"边界。
  const amplitudeThreshold = 10 ** (-45 / 20)
  let first = 0
  while (first < frameRms.length && frameRms[first] <= amplitudeThreshold) first += 1
  let last = frameRms.length - 1
  while (last >= 0 && frameRms[last] <= amplitudeThreshold) last -= 1
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

/** 解码产物：buffer 为降采样单声道分析载体；format 保留解码前容器真实格式 */
export interface DecodedAudio {
  buffer: AudioBuffer
  format: { sampleRate: number; channels: number }
}

export async function decodeAudioUrl(url: string, signal?: AbortSignal): Promise<DecodedAudio> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`audio fetch failed: ${response.status}`)
  const data = await response.arrayBuffer()
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('Web Audio is unavailable')
  const context = new AudioContextCtor()
  try {
    const decoded = await context.decodeAudioData(data)
    // 记录解码前容器的真实格式（声道数/采样率）——过渡格式预检消费；
    // 随后立即降采样为单声道，避免整曲立体声 PCM 留在内存里
    const format = { sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels }
    return { buffer: toMonoDownsampled(decoded, context), format }
  } finally {
    void context.close()
  }
}

/** 计算单声道 buffer 的逐帧 RMS 与 onset 包络（MV 对齐用；导出供歌曲包络互相关） */
export function computeFrameEnvelope(buffer: AudioBuffer): { frameRms: number[]; onset: number[]; frameRate: number } {
  const channel = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
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
  return { frameRms, onset, frameRate }
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

function analyzeBuffer(input: TrackAnalysisInput, buffer: AudioBuffer, format?: { sampleRate: number; channels: number }): TrackAnalysis {
  const channel = buffer.getChannelData(0)
  const sampleRate = buffer.sampleRate
  const duration = buffer.duration
  const { frameRms, onset, frameRate } = computeFrameEnvelope(buffer)
  const tempo = detectTempo(onset, frameRate)
  // beatTimesHint（MV 对齐等场景）：用歌曲真实拍点模式在 MV onset 上滑动相关求偏移，
  // 对歌曲变速/漂移鲁棒（规则网格会因累积漂移失配）；beatWeightsHint 逐拍能量加权
  // 打破拍周期混叠。bpmHint 是规则网格兜底。
  const rawPattern = Array.isArray(input.beatTimesHint) ? input.beatTimesHint : []
  const rawWeights = Array.isArray(input.beatWeightsHint) ? input.beatWeightsHint : []
  let beatPattern: number[] | null = null
  let beatWeights: number[] | undefined
  if (rawPattern.length >= 8) {
    const entries = rawPattern
      .map((t, index) => ({ t, w: rawWeights[index] }))
      .filter((entry) => Number.isFinite(entry.t) && entry.t >= 0)
      .sort((a, b) => a.t - b.t)
    beatPattern = entries.map((entry) => entry.t)
    beatWeights = entries.some((entry) => typeof entry.w === 'number' && entry.w > 0)
      ? entries.map((entry) => (typeof entry.w === 'number' && entry.w > 0 ? entry.w : 1))
      : undefined
  }
  const hintBpm = typeof input.bpmHint === 'number' && Number.isFinite(input.bpmHint)
    ? Math.min(190, Math.max(55, input.bpmHint))
    : null
  let grid: { beats: number[]; downbeats: number[] }
  let reportedBpm: number
  let confidence: number
  let gridEnvelopePeak: number | undefined
  let gridEnvelopeOffset: number | undefined
  if (beatPattern) {
    const found = findBeatPatternGrid(onset, frameRate, beatPattern, duration, beatWeights, frameRms, input.rmsEnvelopeHint)
    grid = { beats: found.beats, downbeats: found.downbeats }
    reportedBpm = hintBpm ?? tempo.bpm
    confidence = found.confidence
    gridEnvelopePeak = found.envelopePeak
    gridEnvelopeOffset = found.envelopeOffset
  } else {
    const gridPeriod = hintBpm ? 60 / hintBpm : tempo.period
    grid = buildBeatGrid(onset, frameRate, gridPeriod, duration)
    reportedBpm = hintBpm ?? tempo.bpm
    confidence = hintBpm
      ? gridOnsetConfidence(onset, frameRate, grid.beats)
      : clamp01(tempo.confidence * (grid.downbeats.length >= 4 ? 1 : 0.5))
  }
  const silence = detectSilence(frameRms, 1 / frameRate, duration)
  const rawFeatures = grid.beats.map((time, beatIndex) => {
    const nextTime = grid.beats[beatIndex + 1] ?? Math.min(duration, time + (hintBpm ? 60 / hintBpm : tempo.period))
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
    estimatedBpm: hintBpm ?? tempo.bpm,
    meter: 4,
    confidence,
    sections: buildSections(beatFeatures, duration),
    beatFeatures,
    introSilence: silence.introSilence,
    outroSilence: silence.outroSilence,
    audioFormat: format,
    rmsEnvelope: frameRms,
    sourceSignature: input.sourceSignature,
    analysisVersion: ANALYSIS_VERSION,
    createdAt: now,
    lastAccessAt: now,
    // 包络强相关（同录音）时透传给调用方，供网格置信度失效时的兜底对齐
    ...(gridEnvelopePeak !== undefined ? { envelopePeak: gridEnvelopePeak, envelopeOffset: gridEnvelopeOffset } : {}),
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
    try {
      if (window.electron?.localPython && !await window.electron.localPython.ensure('beat')) {
        this.pythonServiceAvailable = false
        return false
      }
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
      } finally {
        window.clearTimeout(timeoutId)
      }
    } catch {
      this.pythonServiceAvailable = false
    } finally {
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
          duration: input.duration || 0,
          sourceSignature: input.sourceSignature || '',
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

  /** 同步快查首尾静音边界（仅内存层，不触发磁盘/网络）：
   *  无缝衔接的确定性裁剪触发用——分析由 AutoMix 正常产生后无缝免费复用，
   *  无缓存时返回 null，消费方维持原有运行时探测行为。 */
  peekSilenceBounds(trackKey: string): { introSilence: number; outroSilence: number } | null {
    const normalized = trackKey.trim()
    if (!normalized) return null
    for (const analysis of memoryCache.values()) {
      if (analysis.trackKey !== normalized || !isSupportedAnalysis(analysis)) continue
      // metadata-only 等降级产物没有真实静音数据（恒为 0），不作为有效边界
      if (analysis.provider === 'metadata-only' || analysis.provider === 'tv-metadata-only' || analysis.provider === 'electron-unavailable') continue
      if (!Number.isFinite(analysis.introSilence) || !Number.isFinite(analysis.outroSilence)) continue
      return { introSilence: analysis.introSilence, outroSilence: analysis.outroSilence }
    }
    return null
  }

  async getCached(trackKey: string): Promise<TrackAnalysis | null> {
    const normalizedTrackKey = trackKey.trim()
    if (!normalizedTrackKey) return null
    // 只认"带可用节拍网格"的缓存：空节拍（metadata-only 等解码失败降级）一旦命中会
    // 把 m4a/aac 的浏览器解码回退（唯一能解的路）永远挡掉——MV 背景对不上的根因之一。
    for (const [key, analysis] of memoryCache.entries()) {
      if (analysis.trackKey === normalizedTrackKey && isSupportedAnalysis(analysis) && hasUsableBeats(analysis) && !isWeakBrowserFallback(analysis)) {
        cacheInMemory(key, analysis)
        return { ...analysis, lastAccessAt: Date.now() }
      }
    }
    try {
      const persisted = await window.electron?.analysis?.getTrackAnalysis(normalizedTrackKey) || null
      return persisted && hasUsableBeats(persisted) && !isWeakBrowserFallback(persisted) ? persisted : null
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
        const decoded = await decodeAudioUrl(mediaUrl, input.signal)
        return analyzeBuffer(input, decoded.buffer, decoded.format)
      }
    } catch (error) {
      debugLog('⚠️ [AutoMix] 本地文件解码失败，尝试直接抓取 URL:', error)
    }
    debugLog('🎧 [AutoMix] 直接抓取原始 URL 解码')
    const decoded = await decodeAudioUrl(input.url, input.signal)
    return analyzeBuffer(input, decoded.buffer, decoded.format)
  }

  private async analyzeAndCache(input: TrackAnalysisInput, key: string): Promise<TrackAnalysis> {
    const persisted = await this.getCached(input.trackKey)
    const signatureMatches = !input.sourceSignature || persisted?.sourceSignature === input.sourceSignature
    if (persisted && signatureMatches && isSupportedAnalysis(persisted) && !isWeakBrowserFallback(persisted) && Math.abs(persisted.duration - (input.duration || persisted.duration)) < 2) {
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
          const decoded = await decodeAudioUrl(input.url, input.signal)
          analysis = analyzeBuffer(input, decoded.buffer, decoded.format)
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
    // any later good analysis. The same applies to weak browser-fallback grids
    // (低置信度节拍网格，如 MV 音频被锁到慢拍子谐波时的假网格)。
    if (!isTransientFallback && !isWeakBrowserFallback(analysis)) {
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
    if (inMemory && isSupportedAnalysis(inMemory) && hasUsableBeats(inMemory) && !isWeakBrowserFallback(inMemory)) {
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
