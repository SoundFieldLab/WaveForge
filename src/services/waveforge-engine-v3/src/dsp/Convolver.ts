/**
 * Convolver —— 均匀分区卷积混响 + IR 去周期化（模块 9）
 *
 * 出处/许可：
 *  - 分区卷积（uniform partitioned convolution, overlap-add）思路源自
 *    W. Gardner《Efficient Convolution without Input-Output Delay》(JAES 1995)
 *    与 DAFX-03 论文（Wefers 等，分区卷积混响经典方案，
 *    https://www.dafx.de/paper-archive/2003/DAFX03_Paper_Wefers.pdf），
 *    以及 Rust fft-convolver(MIT) 的分区调度思路（本实现为独立推导的自研代码）。
 *  - FFT 内核使用本项目 src/dsp/fft.ts（自研基-2 蝶形，参考 kissfft 思路，BSD-3）。
 *  - IR 去周期化（尾部指数衰减窗）为本项目自研方法（技术文档 §2.1）。
 *
 * 实现要点：
 *  - 均匀分区：分区长 L（默认 512），IR 分成 P = ceil(M/L) 块，每块预计算 2L 点
 *    复频谱（N = nextPow2(2L)）；每个输入块与各分区频谱复乘、IFFT、按分区索引
 *    延迟累加（overlap-add）。数学上等价于完整线性卷积，输出长度 = 输入长度 + IR 尾。
 *  - 流式路径（processStereo）：输出块 i 在输入块 i 的 FFT 完成后立即可得，
 *    因此湿路存在一个分区长的缓冲延迟 L，getLatencySamples() 返回 L；
 *    干路不延迟（mix=0 时恒等）。
 *  - 去周期化：从 IR 能量包络峰值后 -60dB 点起乘 exp 衰减（τ≈50ms），
 *    消除尾部硬截断导致的周期伪影。
 *
 * 确定性：同输入同 IR 同参数必同输出；无随机、无 Date、无 console。
 */

import { fft, nextPow2 } from './fft'

/** 构造选项：分区长（默认 512）与是否对 IR 做去周期化（默认 true） */
export interface ConvolverOptions {
  partitionSize?: number
  dePeriodize?: boolean
}

export class Convolver {
  private readonly fs: number
  private readonly partitionSize: number
  private readonly dePeriodize: boolean

  private irLoaded = false
  /** IR 去周期化后的长度 M */
  private irLength = 0
  private irName: string | null = null
  /** 分区数 P */
  private numPartitions = 0
  /** FFT 长度 N = nextPow2(2L) */
  private fftSize = 0

  /** 各分区预计算的频谱（实部/虚部），长度 P*N */
  private irSpecReal: Float32Array = new Float32Array(0)
  private irSpecImag: Float32Array = new Float32Array(0)

  /** 干湿混合 0..1：out = (1-mix)·dry + mix·wet */
  private mix = 1
  private preDelaySamples = 0

  // ---- 流式（processStereo）状态，全部预分配 ----
  private inputBlockL: Float32Array = new Float32Array(0)
  private inputBlockR: Float32Array = new Float32Array(0)
  private inputPos = 0
  // outAccum 每通道独立：两通道串行处理且各左移一次，
  // 共用累加器会导致分区历史被后处理通道提前消耗（湿路内容错位/丢失）
  private outAccumL: Float32Array = new Float32Array(0)
  private outAccumR: Float32Array = new Float32Array(0)
  private pendingWetL: Float32Array = new Float32Array(0)
  private pendingWetR: Float32Array = new Float32Array(0)
  private pendingLen = 0
  private pendingPos = 0
  private wetDelayL: Float32Array = new Float32Array(0)
  private wetDelayR: Float32Array = new Float32Array(0)
  private wetDelayPos = 0
  /** 已送入的输入样本总数（累计，仅统计用） */
  private totalIn = 0
  /** 已放行的湿路样本总数 */
  private totalWetOut = 0
  /** 已完成的输入块数（块完成时 +1）：湿路放行的"已产出"依据 */
  private completedBlocks = 0
  /** 已输出的样本总数（跨调用累计）：湿路放行的"位置"依据（逐样本，支持任意块长） */
  private totalOut = 0

  // ---- 工作缓冲（复用，零分配） ----
  private workReal: Float32Array = new Float32Array(0)
  private workImag: Float32Array = new Float32Array(0)
  private inSpecReal: Float32Array = new Float32Array(0)
  private inSpecImag: Float32Array = new Float32Array(0)
  private prodReal: Float32Array = new Float32Array(0)
  private prodImag: Float32Array = new Float32Array(0)

  constructor(fs: number, opts?: ConvolverOptions) {
    if (fs <= 0 || !Number.isFinite(fs)) {
      throw new Error('invalid sample rate')
    }
    this.fs = fs
    let L = opts && opts.partitionSize !== undefined ? Math.round(opts.partitionSize) : 512
    if (!Number.isFinite(L) || L < 1) L = 512
    // 分区长取合理范围 [32, 8192]（过小 FFT 开销大、过大延迟高）
    this.partitionSize = Math.min(8192, Math.max(32, L))
    this.dePeriodize = opts ? opts.dePeriodize !== false : true

    // 延迟线按最大 1s 预分配（preDelayMs 上限 1000ms）
    const maxDelay = fs
    this.wetDelayL = new Float32Array(maxDelay)
    this.wetDelayR = new Float32Array(maxDelay)
  }

  /**
   * 载入单声道 IR。dePeriodize=true 时先做去周期化（尾部指数衰减窗）。
   * 空 / 全零 / 非法 IR 抛 Error。
   */
  loadIR(ir: Float32Array, irName?: string): void {
    if (!ir || ir.length === 0) {
      throw new Error('invalid impulse response: empty')
    }
    // 校验：有限值且非全零
    let anyNonZero = false
    for (let i = 0; i < ir.length; i++) {
      const v = ir[i]
      if (!Number.isFinite(v)) {
        throw new Error('invalid impulse response: contains NaN/Infinity')
      }
      if (v !== 0) anyNonZero = true
    }
    if (!anyNonZero) {
      throw new Error('invalid impulse response: all zero')
    }

    const L = this.partitionSize
    const src = this.dePeriodize ? this.dePeriodizeIR(ir) : ir
    const M = src.length
    const P = Math.max(1, Math.ceil(M / L))
    const N = nextPow2(2 * L)

    this.irLength = M
    this.irName = irName !== undefined ? irName : null
    this.numPartitions = P
    this.fftSize = N

    // 预计算分区频谱（loadIR 非实时路径，允许分配）
    this.irSpecReal = new Float32Array(P * N)
    this.irSpecImag = new Float32Array(P * N)
    const workR = new Float32Array(N)
    const workI = new Float32Array(N)
    for (let p = 0; p < P; p++) {
      workR.fill(0)
      workI.fill(0)
      const base = p * L
      const count = Math.min(L, M - base)
      for (let j = 0; j < count; j++) workR[j] = src[base + j]
      fft(workR, workI, false)
      this.irSpecReal.set(workR, p * N)
      this.irSpecImag.set(workI, p * N)
    }

    // （重新）分配流式缓冲与工作缓冲
    const accLen = (P + 1) * L
    this.inputBlockL = new Float32Array(L)
    this.inputBlockR = new Float32Array(L)
    this.outAccumL = new Float32Array(accLen)
    this.outAccumR = new Float32Array(accLen)
    // pending 缓冲：队列容量 = (P+2)·L（在途块 + 一个正在生成的块 + 余量）
    this.pendingWetL = new Float32Array((P + 2) * L)
    this.pendingWetR = new Float32Array((P + 2) * L)
    this.workReal = new Float32Array(N)
    this.workImag = new Float32Array(N)
    this.inSpecReal = new Float32Array(N)
    this.inSpecImag = new Float32Array(N)
    this.prodReal = new Float32Array(N)
    this.prodImag = new Float32Array(N)

    this.inputPos = 0
    this.pendingLen = 0
    this.pendingPos = 0
    this.totalIn = 0
    this.totalWetOut = 0
    this.completedBlocks = 0
    this.totalOut = 0
    this.outAccumL.fill(0)
    this.outAccumR.fill(0)
    this.irLoaded = true
  }

  /** 设置干湿混合 0..1（1=纯湿） */
  setMix(mix: number): void {
    this.mix = Math.min(1, Math.max(0, mix))
  }

  /** 设置湿路预延迟 ms（0..1000） */
  setPreDelayMs(ms: number): void {
    const clamped = Math.min(1000, Math.max(0, ms))
    this.preDelaySamples = Math.round((clamped * this.fs) / 1000)
  }

  /**
   * 单声道一次完整卷积（有限块语义，从零状态开始）：
   * 返回新 Float32Array，长度 = 输入长度 + IR 尾 + preDelay 样本。
   * 未载入 IR 时抛错（调用方应先 loadIR）。
   */
  process(x: Float32Array): Float32Array {
    if (!this.irLoaded) {
      throw new Error('no impulse response loaded')
    }
    const L = this.partitionSize
    const P = this.numPartitions
    const N = this.fftSize
    const I = Math.ceil(x.length / L)
    const convLen = x.length + this.irLength - 1
    const total = convLen + this.preDelaySamples
    const out = new Float32Array(total)

    for (let i = 0; i < I; i++) {
      // 填充当前输入块（尾部补零）
      this.workReal.fill(0)
      this.workImag.fill(0)
      const start = i * L
      const end = Math.min(start + L, x.length)
      for (let j = start; j < end; j++) this.workReal[j - start] = x[j]
      fft(this.workReal, this.workImag, false)
      this.inSpecReal.set(this.workReal)
      this.inSpecImag.set(this.workImag)

      for (let p = 0; p < P; p++) {
        const specBase = p * N
        // 频域复乘：输入频谱 × 分区 p 频谱
        for (let k = 0; k < N; k++) {
          const r1 = this.inSpecReal[k]
          const i1 = this.inSpecImag[k]
          const r2 = this.irSpecReal[specBase + k]
          const i2 = this.irSpecImag[specBase + k]
          this.prodReal[k] = r1 * r2 - i1 * i2
          this.prodImag[k] = r1 * i2 + i1 * r2
        }
        fft(this.prodReal, this.prodImag, true) // 逆变换（含 ÷N）
        // overlap-add：前半 → 输出块 (i+p)，后半 → 输出块 (i+p+1)
        const base1 = (i + p) * L
        const base2 = base1 + L
        for (let j = 0; j < L; j++) {
          out[base1 + j] += this.prodReal[j]
          out[base2 + j] += this.prodReal[L + j]
        }
      }
    }

    // 施加 preDelay：卷积结果整体右移
    if (this.preDelaySamples > 0) {
      for (let i = convLen - 1; i >= 0; i--) out[i + this.preDelaySamples] = out[i]
      out.fill(0, 0, this.preDelaySamples)
    }
    return out
  }

  /**
   * 流式立体声就地处理（引擎实时路径）。
   * 湿路 = 分区卷积 + preDelay；干路 = 输入本身（不延迟）。
   * out[i] = (1-mix)·dry[i] + mix·wet[i]；wet 相对 dry 延迟 L + preDelay 样本。
   * 未载入 IR 时抛错。
   */
  processStereo(l: Float32Array, r: Float32Array): void {
    if (!this.irLoaded) {
      throw new Error('no impulse response loaded')
    }
    const B = Math.min(l.length, r.length)
    const L = this.partitionSize
    const dryGain = 1 - this.mix
    const wetGain = this.mix

    // 先喂入输入块；块满时跑分区卷积产出湿块。
    // 注意：左右声道队列是并行的（同一 pendPos/pendLen 记账），
    // 写位置必须两声道共用同一 writeAt，且 pendingLen 每块只加一次 L。
    // pending 是"滑动窗口"队列：写前若队尾越界则把未读内容压缩到头部（copyWithin），
    // 保证 pendingPos 永远 < 容量、未读内容连续（修复长流越界读 undefined → NaN）。
    for (let i = 0; i < B; i++) {
      this.inputBlockL[this.inputPos] = l[i]
      this.inputBlockR[this.inputPos] = r[i]
      this.inputPos++
      if (this.inputPos >= L) {
        const cap = this.pendingWetL.length
        if (this.pendingPos + this.pendingLen + L > cap) {
          // 压缩：未读内容移到头部（摊还 O(L)/块）
          const remain = this.pendingLen
          if (remain > 0 && this.pendingPos > 0) {
            this.pendingWetL.copyWithin(0, this.pendingPos, this.pendingPos + remain)
            this.pendingWetR.copyWithin(0, this.pendingPos, this.pendingPos + remain)
          }
          this.pendingPos = 0
          // 突发（单次调用多块产出）超出容量时动态扩容——修复 B>容量 时的越界写（静默丢块 → NaN）
          if (this.pendingLen + L > this.pendingWetL.length) {
            const newCap = Math.max(cap * 2, this.pendingLen + L)
            const nl = new Float32Array(newCap)
            nl.set(this.pendingWetL.subarray(0, this.pendingLen))
            this.pendingWetL = nl
            const nr = new Float32Array(newCap)
            nr.set(this.pendingWetR.subarray(0, this.pendingLen))
            this.pendingWetR = nr
          }
        }
        const writeAt = this.pendingPos + this.pendingLen
        this.processWetBlock(this.inputBlockL, this.pendingWetL, writeAt, this.outAccumL)
        this.processWetBlock(this.inputBlockR, this.pendingWetR, writeAt, this.outAccumR)
        this.pendingLen += L
        this.completedBlocks++
        this.inputPos = 0
      }
    }
    this.totalIn += B

    // 再按序取出 B 个湿样本（不足补零）并与干路混合。
    // 放行约束（逐样本，支持任意块长——修复 B>L 丢块/发散）：
    //   位置 i 的湿输出 = 输入位置 i−L 的卷积 → 湿序 wetIdx = totalOut − L；
    //   放行条件：wetIdx ≥ 0（延迟 L）且 wetIdx < completedBlocks·L（对应输入块已产出）
    //   且 totalWetOut === wetIdx（严格按序放行，防止同一次调用内多块提前放行）。
    for (let i = 0; i < B; i++) {
      let wetL = 0
      let wetR = 0
      const wetIdx = this.totalOut - L
      if (
        this.pendingLen > 0 &&
        wetIdx >= 0 &&
        wetIdx < this.completedBlocks * L &&
        this.totalWetOut === wetIdx
      ) {
        wetL = this.pendingWetL[this.pendingPos]
        wetR = this.pendingWetR[this.pendingPos]
        this.pendingPos++
        this.pendingLen--
        this.totalWetOut++
        if (this.pendingLen === 0) this.pendingPos = 0
      }
      this.totalOut++
      // preDelay
      wetL = this.pushDelay(this.wetDelayL, wetL)
      wetR = this.pushDelay(this.wetDelayR, wetR)
      l[i] = dryGain * l[i] + wetGain * wetL
      r[i] = dryGain * r[i] + wetGain * wetR
    }
  }

  /** 湿路引入的延迟（样本数）= 一个分区长（块缓冲延迟），引擎可据此补偿 */
  getLatencySamples(): number {
    return this.partitionSize
  }

  reset(): void {
    this.inputPos = 0
    this.pendingLen = 0
    this.pendingPos = 0
    this.totalIn = 0
    this.totalWetOut = 0
    this.completedBlocks = 0
    this.totalOut = 0
    this.wetDelayPos = 0
    if (this.outAccumL.length > 0) {
      this.outAccumL.fill(0)
      this.outAccumR.fill(0)
    }
    if (this.pendingWetL.length > 0) {
      this.pendingWetL.fill(0)
      this.pendingWetR.fill(0)
    }
    if (this.wetDelayL.length > 0) {
      this.wetDelayL.fill(0)
      this.wetDelayR.fill(0)
    }
    if (this.inputBlockL.length > 0) {
      this.inputBlockL.fill(0)
      this.inputBlockR.fill(0)
    }
  }

  /** 当前 IR 名称（未载入返回 null） */
  getIrName(): string | null {
    return this.irName
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 处理一个完整输入块：FFT → 与各分区复乘 → IFFT → overlap-add 到 outAccum，
   * 取出 outAccum[0..L)（= 输出块）追加到 pending，并左移 outAccum。
   */
  /**
   * 处理一个完整输入块：FFT → 与各分区复乘 → IFFT → overlap-add 到 outAccum，
   * 取出 outAccum[0..L)（= 输出块）写入 pending[writeAt..writeAt+L)。
   * 注意：左右声道队列并行共享同一记账（pendingPos/pendingLen），
   * 写位置由调用方统一计算（writeAt = pendingPos + pendingLen），
   * pendingLen 由调用方在两次调用后只加一次 L（此处不记账）。
   */
  /** 处理一个完整输入块并把输出块写入 pending[writeAt..writeAt+L)；outAccum 为通道独立累加器 */
  private processWetBlock(blk: Float32Array, pending: Float32Array, writeAt: number, outAccum: Float32Array): void {
    const L = this.partitionSize
    const P = this.numPartitions
    const N = this.fftSize

    this.workReal.fill(0)
    this.workImag.fill(0)
    this.workReal.set(blk)
    fft(this.workReal, this.workImag, false)
    this.inSpecReal.set(this.workReal)
    this.inSpecImag.set(this.workImag)

    // 注意：outAccum 是跨块 overlap-add 累加器，块处理前**不能** fill(0)——
    // 上一块左移后保留的 [0..P·L) 正是分区 1..P 的历史贡献（Gardner 分区卷积语义）；
    // 若清空，IR 长于一个分区时湿路只剩分区 0 的前 L 个 tap（长混响湿声缺失）。
    // outAccum 仅在 loadIR 时清零一次，每块处理后左移并清尾（见下）。
    for (let p = 0; p < P; p++) {
      const specBase = p * N
      for (let k = 0; k < N; k++) {
        const r1 = this.inSpecReal[k]
        const i1 = this.inSpecImag[k]
        const r2 = this.irSpecReal[specBase + k]
        const i2 = this.irSpecImag[specBase + k]
        this.prodReal[k] = r1 * r2 - i1 * i2
        this.prodImag[k] = r1 * i2 + i1 * r2
      }
      fft(this.prodReal, this.prodImag, true)
      const base1 = p * L
      const base2 = base1 + L
      for (let j = 0; j < L; j++) {
        outAccum[base1 + j] += this.prodReal[j]
        outAccum[base2 + j] += this.prodReal[L + j]
      }
    }

    for (let j = 0; j < L; j++) pending[writeAt + j] = outAccum[j]

    // 左移：块 1..P → 0..P-1，尾部清零（为下一块保留分区 1..P 的历史贡献）
    outAccum.copyWithin(0, L, (P + 1) * L)
    outAccum.fill(0, P * L, (P + 1) * L)
  }

  /** 环形延迟线：写入 x，返回 preDelaySamples 前的样本（preDelay=0 直接返回 x） */
  private pushDelay(line: Float32Array, x: number): number {
    if (this.preDelaySamples === 0) return x
    const size = line.length
    let readPos = this.wetDelayPos - this.preDelaySamples
    if (readPos < 0) readPos += size
    const out = line[readPos]
    line[this.wetDelayPos] = x
    this.wetDelayPos++
    if (this.wetDelayPos >= size) this.wetDelayPos = 0
    return out
  }

  /**
   * IR 去周期化：检测能量包络峰值，从峰值后 -60dB 点起乘 exp 衰减（τ≈50ms）。
   * 返回新数组（不改动调用方传入的 IR）。
   */
  private dePeriodizeIR(ir: Float32Array): Float32Array {
    const M = ir.length
    const out = new Float32Array(M)
    out.set(ir)
    const W = Math.max(4, Math.round(0.01 * this.fs)) // 10ms 包络窗
    const half = W >> 1

    // 能量包络（移动平均 RMS）
    let peakIdx = 0
    let peakVal = -1
    for (let n = 0; n < M; n++) {
      let sum = 0
      const lo = Math.max(0, n - half)
      const hi = Math.min(M, n + half + 1)
      const cnt = hi - lo
      for (let j = lo; j < hi; j++) sum += ir[j] * ir[j]
      const env = Math.sqrt(sum / cnt)
      if (env > peakVal) {
        peakVal = env
        peakIdx = n
      }
    }
    if (peakVal <= 1e-12) return out // 极静 IR（loadIR 已挡全零，防御性分支）

    // -60dB 点：包络最后一次高于峰值-60dB 之后的第一个样本（此后包络保持低于阈值）。
    // 用"后缀"判定而非"首次低于"，避免稀疏 IR（如延迟冲激）被误衰减。
    const threshold = peakVal * 1e-3
    let lastAbove = peakIdx
    for (let n = peakIdx; n < M; n++) {
      let sum = 0
      const lo = Math.max(0, n - half)
      const hi = Math.min(M, n + half + 1)
      const cnt = hi - lo
      for (let j = lo; j < hi; j++) sum += ir[j] * ir[j]
      if (Math.sqrt(sum / cnt) > threshold) lastAbove = n
    }
    const n0 = lastAbove + 1
    if (n0 >= M) return out // 尾部未掉到 -60dB 以下，无需处理

    // 从 n0 起乘 exp 衰减，τ≈50ms
    const tau = 0.05 * this.fs
    for (let n = n0; n < M; n++) {
      out[n] *= Math.exp(-(n - n0) / tau)
    }
    return out
  }
}