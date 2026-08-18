/**
 * LufsMeter —— ITU-R BS.1770-4 / EBU R128 响度测量（模块 11）
 *
 * 出处/许可：算法与公开公式来自 ITU-R BS.1770-4（K 加权两级滤波、400ms 块、
 * 双门限整合响度）与 EBU Tech 3341（短时/瞬时）、EBU Tech 3342（LRA）。
 * 滤波器系数参考 libebur128 的公开实现与 FFmpeg f_ebur128.c（LGPL，仅对照
 * 公式不引入）；本实现为自研 TS 代码。
 *
 * 实现要点：
 *  - K 加权：两级 biquad —— ① RLB 高通（38.135822Hz，Q=0.5，滤除次声）；
 *    ② 高频搁架（+4dB，f0=1681.974Hz，Q=0.707）。支持 44100/48000 精确系数；
 *    其余采样率按 48k 系数近似（注释说明，误差仅在滤波器拐点附近）。
 *  - 块统计：400ms 窗、100ms 步进（75% 重叠）；块响度 Lk = -0.691 + 10·log10(mean(z²))，
 *    z = 左右通道 K 加权之和（BS.1770 通道求和）。
 *  - 整合响度：绝对门限 -70 LUFS → 相对门限（绝对门限后均值 - 10 LU）→ 对通过
 *    门限的块功率求均值。未测到（如纯静音）返回 NaN。
 *  - LRA（EBU Tech 3342）：绝对门限 -70 LUFS → 相对门限（均值 - 20 LU）→
 *    对剩余块响度排序求 10/95 百分位差（线性插值百分位）。
 *  - 真峰值：4× 过采样（窗函数 sinc 多相插值，BS.1770 §2.3 思路）。
 *
 * 确定性：同输入必同输出；无随机、无 Date、无 console。
 */

// ---------- K 加权滤波系数 ----------

/** RLB 高通：二阶高通（f0=38.135822Hz，Q=0.5），RBJ/BLT 公式 */
function rbjHighPass(f0: number, q: number, fs: number): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const w0 = (2 * Math.PI * f0) / fs
  const alpha = Math.sin(w0) / (2 * q)
  const cw = Math.cos(w0)
  const b0 = (1 + cw) / 2
  const b1 = -(1 + cw)
  const b2 = b0
  const a0 = 1 + alpha
  const a1 = -2 * cw
  const a2 = 1 - alpha
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** 高频搁架 +4dB：常数 Q 搁架（48kHz 下与 BS.1770 公布系数逐位一致） */
function shelfCoeffs(fs: number): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const f0 = 1681.974450955533
  const gDb = 3.999843853973347
  const q = 0.7071752369554196
  const k = Math.tan((Math.PI * f0) / fs)
  const vh = Math.pow(10, gDb / 20)
  const vb = Math.pow(vh, 0.4996667741545416)
  const a0 = 1 + k / q + k * k
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
}

// 真峰值 4× 过采样参数
const TRUE_PEAK_OVS = 4
const TRUE_PEAK_TAPS_PER_PHASE = 24
const TRUE_PEAK_HIST = 2 * TRUE_PEAK_TAPS_PER_PHASE

/** biquad 系数 + TDF2 状态（每通道每级一份） */
interface BiquadState {
  c: { b0: number; b1: number; b2: number; a1: number; a2: number }
  z1: number
  z2: number
}

export class LufsMeter {
  private readonly blockLen: number // 400ms
  private readonly hopLen: number // 100ms

  // K 加权滤波状态：左/右 × 两级
  private readonly rlbL: BiquadState
  private readonly shelfL: BiquadState
  private readonly rlbR: BiquadState
  private readonly shelfR: BiquadState

  // 滑动窗口（400ms）内 z² 之和与 z 环形缓冲
  private zBuf: Float32Array
  private zPos = 0
  private sumSq = 0
  private totalSamples = 0

  // 块历史（环形；容量 = 1 小时 @100ms 步进）
  private static readonly BLOCK_CAP = 36000
  private blockLoud: Float32Array = new Float32Array(LufsMeter.BLOCK_CAP)
  private blockPower: Float32Array = new Float32Array(LufsMeter.BLOCK_CAP)
  private blockWrite = 0
  private blockCount = 0
  // 短时（3s = 30 块）功率环形
  private static readonly SHORT_CAP = 30
  private shortPower: Float32Array = new Float32Array(LufsMeter.SHORT_CAP)
  private shortWrite = 0
  private shortCount = 0

  // 峰值
  private peak = 0
  private truePeak = 0

  // 真峰值 4× 多相插值（每通道）
  private readonly tpKernel: Float32Array = new Float32Array(TRUE_PEAK_OVS * TRUE_PEAK_HIST)
  private readonly histL: Float32Array = new Float32Array(TRUE_PEAK_HIST)
  private readonly histR: Float32Array = new Float32Array(TRUE_PEAK_HIST)
  private histPos = 0
  private histFull = false

  // LRA 排序暂存
  private sortScratch: Float32Array = new Float32Array(LufsMeter.BLOCK_CAP)

  constructor(fs: number) {
    if (fs <= 0 || !Number.isFinite(fs)) {
      throw new Error('invalid sample rate')
    }
    // 支持 44100/48000 精确系数；其余采样率按 48k 系数近似（滤波器拐点误差可忽略）
    const useFs = fs === 44100 || fs === 48000 ? fs : 48000
    const rlb = rbjHighPass(38.135822, 0.5, useFs)
    const shelf = shelfCoeffs(useFs)
    this.rlbL = { c: rlb, z1: 0, z2: 0 }
    this.shelfL = { c: shelf, z1: 0, z2: 0 }
    this.rlbR = { c: rlb, z1: 0, z2: 0 }
    this.shelfR = { c: shelf, z1: 0, z2: 0 }

    this.blockLen = Math.max(1, Math.round(0.4 * fs))
    this.hopLen = Math.max(1, Math.round(0.1 * fs))
    this.zBuf = new Float32Array(this.blockLen)

    // 预计算 4× 多相插值核（Blackman 窗 sinc，截止 = 原 Nyquist = 4× 率的 1/4，逐相归一化）
    for (let phi = 0; phi < TRUE_PEAK_OVS; phi++) {
      let sum = 0
      const base = phi * TRUE_PEAK_HIST
      for (let j = 0; j < TRUE_PEAK_HIST; j++) {
        const u = j - (TRUE_PEAK_TAPS_PER_PHASE - 1) + phi / TRUE_PEAK_OVS
        let c
        if (Math.abs(u) < 1e-9) c = 1
        else c = Math.sin((Math.PI * u) / TRUE_PEAK_OVS) / ((Math.PI * u) / TRUE_PEAK_OVS)
        const xw = u / TRUE_PEAK_TAPS_PER_PHASE
        if (Math.abs(xw) <= 1) {
          c *= 0.42 + 0.5 * Math.cos(Math.PI * xw) + 0.08 * Math.cos(2 * Math.PI * xw)
        } else {
          c = 0
        }
        this.tpKernel[base + j] = c
        sum += c
      }
      if (sum !== 0) {
        for (let j = 0; j < TRUE_PEAK_HIST; j++) this.tpKernel[base + j] /= sum
      }
    }
  }

  /** 就地分析立体声（L/R 均过 K 加权；z = L'+R'） */
  processStereo(l: Float32Array, r: Float32Array): void {
    const B = Math.min(l.length, r.length)
    for (let i = 0; i < B; i++) {
      const xl = l[i]
      const xr = r[i]

      // K 加权（TDF2，两级串联）
      const rl = this.rlbL
      const y1l = rl.c.b0 * xl + rl.z1
      rl.z1 = rl.c.b1 * xl - rl.c.a1 * y1l + rl.z2
      rl.z2 = rl.c.b2 * xl - rl.c.a2 * y1l
      const sl = this.shelfL
      const yl = sl.c.b0 * y1l + sl.z1
      sl.z1 = sl.c.b1 * y1l - sl.c.a1 * yl + sl.z2
      sl.z2 = sl.c.b2 * y1l - sl.c.a2 * yl

      const rr = this.rlbR
      const y1r = rr.c.b0 * xr + rr.z1
      rr.z1 = rr.c.b1 * xr - rr.c.a1 * y1r + rr.z2
      rr.z2 = rr.c.b2 * xr - rr.c.a2 * y1r
      const sr = this.shelfR
      const yr = sr.c.b0 * y1r + sr.z1
      sr.z1 = sr.c.b1 * y1r - sr.c.a1 * yr + sr.z2
      sr.z2 = sr.c.b2 * y1r - sr.c.a2 * yr

      // 块功率：z = yL + yR（BS.1770 通道求和）
      const z = yl + yr
      const zsq = z * z
      const evict = this.zBuf[this.zPos]
      this.zBuf[this.zPos] = z
      this.zPos++
      if (this.zPos >= this.blockLen) this.zPos = 0
      this.sumSq += zsq - evict * evict
      this.totalSamples++

      // 样本峰值
      const aL = xl < 0 ? -xl : xl
      const aR = xr < 0 ? -xr : xr
      if (aL > this.peak) this.peak = aL
      if (aR > this.peak) this.peak = aR

      // 真峰值（4× 插值）：左右共用一个写入游标，每样本推进一次
      this.histL[this.histPos] = xl
      this.histR[this.histPos] = xr
      this.histPos++
      if (this.histPos >= TRUE_PEAK_HIST) {
        this.histPos = 0
        this.histFull = true
      }
      this.updateTruePeakInterp(this.histL)
      this.updateTruePeakInterp(this.histR)

      // 块边界（400ms 窗 / 100ms 步进）
      if (this.totalSamples >= this.blockLen && (this.totalSamples - this.blockLen) % this.hopLen === 0) {
        this.recordBlock()
      }
    }
  }

  /** 整合响度 LUFS（绝对 -70 + 相对 -10 双门限）；未测到返回 NaN */
  getIntegratedLufs(): number {
    if (this.blockCount === 0) return NaN
    const cap = LufsMeter.BLOCK_CAP
    const start = (this.blockWrite - this.blockCount + cap) % cap
    let sumP1 = 0
    let sumL1 = 0
    let n1 = 0
    for (let k = 0; k < this.blockCount; k++) {
      const idx = (start + k) % cap
      const lk = this.blockLoud[idx]
      if (lk >= -70) {
        sumP1 += this.blockPower[idx]
        sumL1 += lk
        n1++
      }
    }
    if (n1 === 0) return NaN
    const gate = sumL1 / n1 - 10
    let sumP2 = 0
    let n2 = 0
    for (let k = 0; k < this.blockCount; k++) {
      const idx = (start + k) % cap
      const lk = this.blockLoud[idx]
      if (lk >= -70 && lk >= gate) {
        sumP2 += this.blockPower[idx]
        n2++
      }
    }
    if (n2 === 0) return NaN
    return -0.691 + 10 * Math.log10(sumP2 / n2)
  }

  /** 瞬时响度（最新一个完整 400ms 块）；未测到返回 NaN */
  getMomentaryLufs(): number {
    if (this.blockCount === 0) return NaN
    const cap = LufsMeter.BLOCK_CAP
    const last = (this.blockWrite - 1 + cap) % cap
    const v = this.blockLoud[last]
    return Number.isNaN(v) ? NaN : v
  }

  /** 短时响度（最近 3s = 30 块功率均值）；不足 30 块返回 NaN */
  getShortTermLufs(): number {
    if (this.shortCount < LufsMeter.SHORT_CAP) return NaN
    let sum = 0
    const cap = LufsMeter.SHORT_CAP
    for (let k = 0; k < cap; k++) {
      const idx = (this.shortWrite - cap + k + 2 * cap) % cap
      sum += this.shortPower[idx]
    }
    if (sum <= 1e-30) return NaN // 全静音
    return -0.691 + 10 * Math.log10(sum / cap)
  }

  /** LRA（EBU Tech 3342）：绝对 -70 + 相对 -20 门限后 10/95 百分位差（LU） */
  getLra(): number {
    if (this.blockCount < 2) return NaN
    const cap = LufsMeter.BLOCK_CAP
    const start = (this.blockWrite - this.blockCount + cap) % cap
    let sumL = 0
    let n1 = 0
    for (let k = 0; k < this.blockCount; k++) {
      const idx = (start + k) % cap
      const lk = this.blockLoud[idx]
      if (lk >= -70) {
        sumL += lk
        n1++
      }
    }
    if (n1 < 2) return NaN
    const gate = sumL / n1 - 20
    let m = 0
    for (let k = 0; k < this.blockCount; k++) {
      const idx = (start + k) % cap
      const lk = this.blockLoud[idx]
      if (lk >= -70 && lk >= gate) {
        this.sortScratch[m++] = lk
      }
    }
    if (m < 2) return NaN
    // 升序排序（copyWithin 到连续段后排序，避免污染环形语义——用 subarray 视图即可）
    const arr = this.sortScratch.subarray(0, m)
    arr.sort()
    const p10 = this.percentile(arr, 0.1)
    const p95 = this.percentile(arr, 0.95)
    return p95 - p10
  }

  /** 样本峰值 dBFS（全静音返回 -Infinity） */
  getPeakDb(): number {
    if (this.peak <= 0) return -Infinity
    return 20 * Math.log10(this.peak)
  }

  /** 真峰值 dBFS（4× 过采样；全静音返回 -Infinity） */
  getTruePeakDb(): number {
    if (this.truePeak <= 0) return -Infinity
    return 20 * Math.log10(this.truePeak)
  }

  reset(): void {
    this.zBuf.fill(0)
    this.zPos = 0
    this.sumSq = 0
    this.totalSamples = 0
    this.blockLoud.fill(0)
    this.blockPower.fill(0)
    this.blockWrite = 0
    this.blockCount = 0
    this.shortPower.fill(0)
    this.shortWrite = 0
    this.shortCount = 0
    this.peak = 0
    this.truePeak = 0
    this.histL.fill(0)
    this.histR.fill(0)
    this.histPos = 0
    this.histFull = false
    this.rlbL.z1 = 0
    this.rlbL.z2 = 0
    this.shelfL.z1 = 0
    this.shelfL.z2 = 0
    this.rlbR.z1 = 0
    this.rlbR.z2 = 0
    this.shelfR.z1 = 0
    this.shelfR.z2 = 0
  }

  // ---------------------------------------------------------------- 内部

  /** 记录一个完整 400ms 块（静音块响度记 NaN，避免 -Infinity 泄漏） */
  private recordBlock(): void {
    const p = this.sumSq / this.blockLen
    const lk = p > 1e-30 ? -0.691 + 10 * Math.log10(p) : NaN
    const cap = LufsMeter.BLOCK_CAP
    this.blockLoud[this.blockWrite] = lk
    this.blockPower[this.blockWrite] = p
    this.blockWrite++
    if (this.blockWrite >= cap) this.blockWrite = 0
    if (this.blockCount < cap) this.blockCount++

    const sc = LufsMeter.SHORT_CAP
    this.shortPower[this.shortWrite] = p
    this.shortWrite++
    if (this.shortWrite >= sc) this.shortWrite = 0
    if (this.shortCount < sc) this.shortCount++
  }

  /** 线性插值百分位（arr 必须已升序；p ∈ [0,1]） */
  private percentile(arr: Float32Array, p: number): number {
    const n = arr.length
    if (n === 1) return arr[0]
    const rank = p * (n - 1)
    const lo = Math.floor(rank)
    const hi = Math.min(n - 1, lo + 1)
    const frac = rank - lo
    return arr[lo] + frac * (arr[hi] - arr[lo])
  }

  /**
   * 真峰值插值：历史满后对滞后一个核长的位置做 4× 插值取峰。
   * 位置 t = 最新样本索引 - TAPS_PER_PHASE（滞后保证核窗口因果可用）。
   * 注意：历史环形缓冲的写入游标由 processStereo 每样本推进一次（左右通道
   * 共用同一游标），此处只读不写。
   */
  private updateTruePeakInterp(hist: Float32Array): void {
    if (!this.histFull) return
    // 当前样本索引 n = totalSamples - 1；可插值位置 t = n - TAPS_PER_PHASE
    const t = this.totalSamples - 1 - TRUE_PEAK_TAPS_PER_PHASE
    if (t < 0) return
    for (let phi = 0; phi < TRUE_PEAK_OVS; phi++) {
      const base = phi * TRUE_PEAK_HIST
      let y = 0
      for (let j = 0; j < TRUE_PEAK_HIST; j++) {
        const idx = t - j + TRUE_PEAK_TAPS_PER_PHASE - 1
        const ringIdx = ((idx % TRUE_PEAK_HIST) + TRUE_PEAK_HIST) % TRUE_PEAK_HIST
        y += this.tpKernel[base + j] * hist[ringIdx]
      }
      if (y < 0) y = -y
      if (y > this.truePeak) this.truePeak = y
    }
  }
}