/**
 * 学歌插件 · 音高检测核心（纯逻辑，无 DOM 依赖，可单测）。
 *
 * 算法：YIN（de Cheveigné & Kawahara, 2002）改进版自相关音高检测：
 *   1. 差分函数 d(τ)：窗口内 squared difference；
 *   2. 累积均值归一化 d'(τ)；
 *   3. 取第一个低于阈值（0.12）的谷底，再做抛物线插值亚帧精化；
 *   4. f0 = sampleRate / τ。
 *
 * 为什么不用 FFT 峰值：人声基频 80~800Hz，8192 点 FFT 在 44.1kHz 下
 * 分辨率约 5.4Hz，对 100Hz 附近的低音男声误差超过一个半音；YIN 时域法
 * 在这个频段精度远高于频域法。
 */

export const PITCH_MIN_HZ = 75
export const PITCH_MAX_HZ = 800

/** YIN 阈值：低于此累积归一化差分视为周期性良好（越小越严格）。 */
const YIN_THRESHOLD = 0.12
/** 插值搜索的滞后范围：sampleRate / PITCH_MIN_HZ 上限再放宽 10%。 */
function maxLagFor(sampleRate: number): number {
  return Math.min(2048, Math.ceil((sampleRate / PITCH_MIN_HZ) * 1.1))
}
function minLagFor(sampleRate: number): number {
  return Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ))
}

/**
 * 对一帧（建议 2048 采样 ≈ 46ms@44.1kHz）做 YIN 音高检测。
 * 返回检测到的基频（Hz）；无周期性（静音/噪声/清音）返回 null。
 */
export function detectPitchYin(frame: Float32Array, sampleRate: number): number | null {
  if (frame.length < 256) return null
  const maxLag = Math.min(maxLagFor(sampleRate), Math.floor(frame.length / 2))
  const minLag = minLagFor(sampleRate)
  if (maxLag <= minLag) return null

  // 快速能量门：RMS 过低的帧不检测（静音/呼吸声）
  let energy = 0
  for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i]
  const rms = Math.sqrt(energy / frame.length)
  if (rms < 0.006) return null

  // 差分函数 + 累积均值归一化（CMND）
  const cmnd = new Float32Array(maxLag)
  cmnd[0] = 1
  let runningSum = 0
  for (let lag = 1; lag < maxLag; lag += 1) {
    let diff = 0
    for (let i = 0; i < maxLag; i += 1) {
      const delta = frame[i] - frame[i + lag]
      diff += delta * delta
    }
    runningSum += diff
    cmnd[lag] = runningSum > 0 ? diff * lag / runningSum : 1
  }

  // 第一个低于阈值的谷底
  let bestLag = -1
  for (let lag = minLag; lag < maxLag - 1; lag += 1) {
    if (cmnd[lag] < YIN_THRESHOLD) {
      while (lag + 1 < maxLag - 1 && cmnd[lag + 1] < cmnd[lag]) lag += 1
      bestLag = lag
      break
    }
  }
  // 宽松兜底：无谷底过阈时取全局最小（避免响亮但略跑调的帧被判无效）
  if (bestLag < 0) {
    let min = 1
    for (let lag = minLag; lag < maxLag - 1; lag += 1) {
      if (cmnd[lag] < min) { min = cmnd[lag]; bestLag = lag }
    }
    if (bestLag < 0 || min > 0.5) return null
  }

  // 抛物线插值：用谷底两侧点精化滞后，亚采样精度
  const lag = bestLag
  const left = lag > 0 ? cmnd[lag - 1] : cmnd[lag]
  const center = cmnd[lag]
  const right = lag + 1 < maxLag ? cmnd[lag + 1] : cmnd[lag]
  const denominator = left + right - 2 * center
  const shift = denominator !== 0 ? 0.5 * (left - right) / denominator : 0
  const refinedLag = lag + Math.max(-1, Math.min(1, shift))
  const frequency = sampleRate / refinedLag
  if (frequency < PITCH_MIN_HZ || frequency > PITCH_MAX_HZ) return null
  return frequency
}

/* ---------------------------------- 音名与音分 ---------------------------------- */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** 频率 → MIDI 编号（A4=69，四舍五入）。 */
export function frequencyToMidi(frequency: number): number {
  return Math.round(69 + 12 * Math.log2(frequency / 440))
}

/** MIDI 编号 → 音名（如 C4、A4、F#3）。 */
export function midiToNoteName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  return `${name}${octave}`
}

/** 频率 → 音名（无周期性时返回 null）。 */
export function frequencyToNoteName(frequency: number): string | null {
  if (!Number.isFinite(frequency) || frequency <= 0) return null
  return midiToNoteName(frequencyToMidi(frequency))
}

/**
 * 频率 → MIDI 编号 + 音分偏差（-50..+50，负=偏低）。
 * 偏差 = (实际频率对应的连续 midi 值 - 最近整数 midi) * 100。
 */
export function frequencyToMidiCents(frequency: number): { midi: number; cents: number } | null {
  if (!Number.isFinite(frequency) || frequency <= 0) return null
  const continuous = 69 + 12 * Math.log2(frequency / 440)
  const midi = Math.round(continuous)
  return { midi, cents: Math.max(-50, Math.min(50, (continuous - midi) * 100)) }
}

/* ---------------------------------- 音分误差与评分 ---------------------------------- */

/**
 * 两个频率之间的音分差（有符号）：target 比 actual 高多少音分。
 * 正值 = 用户唱低了 100×|差| 音分以内时取负？——约定：返回 userHz 相对 targetHz 的偏差，
 * 正 = 唱高、负 = 唱低。计算：1200 × log2(user / target)。
 */
export function centsBetween(userHz: number, targetHz: number): number {
  if (!(userHz > 0) || !(targetHz > 0)) return 0
  return 1200 * Math.log2(userHz / targetHz)
}

/**
 * 音分误差 → 单帧得分（0..1）。
 * ±30 音分内满分（普通人耳对音高的辨识阈值约 10~25 音分，30 内算准），
 * 100 音分（一个半音）及以上不得分，之间线性下降。
 */
export function centsToScore(cents: number): number {
  const abs = Math.abs(cents)
  if (abs <= 30) return 1
  if (abs >= 100) return 0
  return (100 - abs) / 70
}

/** 一行歌词的跟唱评分结果。 */
export interface LineScore {
  /** 0..100 综合分（音准 70% + 节奏 30%）。 */
  total: number
  /** 音准分 0..100（有音高参照时才计算，否则 0）。 */
  pitch: number
  /** 节奏分 0..100（用户开口时间与歌词时间窗的重合度）。 */
  rhythm: number
  /** 用户有效发声帧数。 */
  voicedFrames: number
  /** 参照可用帧数。 */
  targetFrames: number
}

export interface LineScoringInput {
  /** 每个采样点：用户音高（Hz 或 null）。 */
  userPitches: (number | null)[]
  /** 每个采样点：参照音高（Hz 或 null）。 */
  targetPitches: (number | null)[]
  /** 每个采样点：用户该帧是否有足够能量（开口了）。 */
  voicedMask: boolean[]
  /** 音准权重（默认 0.7，节奏 1 - 权重）。 */
  pitchWeight?: number
}

/**
 * 汇总一行歌词的评分。
 *
 * - 音准：双方都有音高的帧上取 |centsBetween| → centsToScore 平均；
 *   若无参照音高（无音高参照模式），音准分不可得，总分退化为节奏分。
 * - 节奏：开口帧覆盖歌词活跃帧的比例（用户在唱的时间 ÷ 应唱的时间，
 *   超唱不扣分、漏唱扣分）。
 */
export function scoreLine(input: LineScoringInput): LineScore {
  const { userPitches, targetPitches, voicedMask } = input
  const pitchWeight = input.pitchWeight ?? 0.7

  let pitchFrames = 0
  let pitchSum = 0
  const n = Math.min(userPitches.length, targetPitches.length, voicedMask.length)
  for (let i = 0; i < n; i += 1) {
    const user = userPitches[i]
    const target = targetPitches[i]
    if (user != null && target != null && voicedMask[i]) {
      pitchFrames += 1
      pitchSum += centsToScore(centsBetween(user, target))
    }
  }
  const pitchScore = pitchFrames > 0 ? pitchSum / pitchFrames * 100 : 0

  let activeFrames = 0
  let voicedFrames = 0
  // 应唱窗口：有参照 → 参照有声的槽；无参照 → 整行所有槽。
  // 无参照时不能把「用户唱了的槽」当应唱窗口——那是恒 100 的循环论证，
  // 节奏分必须衡量开口覆盖（漏唱扣分、超唱不扣分）。
  const hasReferenceTrack = targetPitches.some(p => p != null)
  for (let i = 0; i < n; i += 1) {
    if (hasReferenceTrack ? targetPitches[i] != null : true) {
      activeFrames += 1
      if (voicedMask[i]) voicedFrames += 1
    }
  }
  const rhythmScore = activeFrames > 0 ? Math.min(1, voicedFrames / activeFrames) * 100 : 0

  const hasPitchReference = pitchFrames > 0
  const total = hasPitchReference
    ? (pitchScore * pitchWeight + rhythmScore * (1 - pitchWeight))
    : rhythmScore

  return {
    total: Math.round(total),
    pitch: Math.round(pitchScore),
    rhythm: Math.round(rhythmScore),
    voicedFrames,
    targetFrames: pitchFrames,
  }
}

/** 全曲汇总：多行评分的加权平均（按行权重，缺省等权）。 */
export function aggregateLineScores(lines: LineScore[], weights?: number[]): { total: number; pitch: number; rhythm: number } {
  if (lines.length === 0) return { total: 0, pitch: 0, rhythm: 0 }
  const n = lines.length
  const w = weights && weights.length === n ? weights : Array(n).fill(1)
  const wSum = w.reduce((sum, weight) => sum + weight, 0) || 1
  const acc = lines.reduce((acc, line, i) => ({
    total: acc.total + line.total * w[i],
    pitch: acc.pitch + line.pitch * w[i],
    rhythm: acc.rhythm + line.rhythm * w[i],
  }), { total: 0, pitch: 0, rhythm: 0 })
  return {
    total: Math.round(acc.total / wSum),
    pitch: Math.round(acc.pitch / wSum),
    rhythm: Math.round(acc.rhythm / wSum),
  }
}

/** 分数 → 评价文案。 */
export function scoreLabel(score: number): string {
  if (score >= 95) return '歌神降临'
  if (score >= 85) return '麦霸水准'
  if (score >= 70) return '渐入佳境'
  if (score >= 50) return '继续加油'
  return '多练几遍'
}

/**
 * 音高稳定器（修"鬼畜"）：实时音高检测的原始输出天然带毛刺——
 * 清音/气声帧偶发错检、八度翻倍（YIN 对谐波结构的 2f/3f 误锁）、帧间抖动。
 * 直接显示就是指针乱跳。这里做三层：
 *   1. 八度纠错：新检测值与参考值差接近 ±1 个八度（±1200 音分）时折回同八度；
 *   2. 跳变门限：与平滑值差超过 gate 音分且不是持续趋势 → 视为毛刺丢弃；
 *   3. 指数平滑：剩余抖动按 alpha 慢速跟随（唱准的音名显示基本不动）。
 */
export class PitchStabilizer {
  private smoothed: number | null = null
  private recent: number[] = []

  constructor(
    /** 跳变门限（音分）：超过视为毛刺，除非连续 stabilityN 帧都偏向同一侧。 */
    private gateCents = 250,
    /** 连续 N 帧同向偏移才承认是真跳音（换字/换音高）。 */
    private stabilityN = 3,
    /** 平滑系数：越大越跟手、越小越稳。 */
    private alpha = 0.35,
  ) {}

  /** 输入原始检测值，返回稳定后的显示值（null = 不发声）。 */
  push(frequency: number | null): number | null {
    if (frequency == null || !Number.isFinite(frequency) || frequency <= 0) {
      // 短暂丢帧不立即清零（唱歌换气间隙），连续空帧在 view 层按超时隐藏
      this.recent = []
      return this.smoothed
    }
    // 八度纠错：以平滑值为参考，把 ±0.5~1.5 个八度的离群值折回来
    let corrected = frequency
    if (this.smoothed != null && this.smoothed > 0) {
      const cents = centsBetween(corrected, this.smoothed)
      if (cents > 500 && cents < 1900) corrected /= 2
      else if (cents < -500 && cents > -1900) corrected *= 2
    }
    // 跳变门限：与平滑值差太多 → 先记着，连续 stabilityN 帧同向才认为是真跳
    if (this.smoothed != null) {
      const offsetCents = centsBetween(corrected, this.smoothed)
      if (Math.abs(offsetCents) > this.gateCents) {
        this.recent.push(offsetCents)
        if (this.recent.length < this.stabilityN) {
          return this.smoothed
        }
        // 连续同向大偏移：真跳音，直接吸附过去
        const allSameDirection = this.recent.every(value => value > 0) || this.recent.every(value => value < 0)
        if (allSameDirection) {
          this.smoothed = corrected
          this.recent = []
          return this.smoothed
        }
        this.recent = []
        return this.smoothed
      }
    }
    this.recent = []
    // 指数平滑
    this.smoothed = this.smoothed == null ? corrected : this.smoothed + (corrected - this.smoothed) * this.alpha
    return this.smoothed
  }

  reset() {
    this.smoothed = null
    this.recent = []
  }
}
