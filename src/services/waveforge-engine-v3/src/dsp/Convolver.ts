import { SampleRamp } from './SampleRamp'
import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from './audioBuffer'
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
 *  - 均匀分区 + 频域延迟线（FDL）：各历史输入频谱与对应 IR 分区相乘，先求和再
 *    逆变换。每声道每块只需一次正向 FFT 和一次 IFFT，而非每分区一次 IFFT。
 *  - 流式湿路固定延迟一个分区长，再接预延迟；干路保持不延迟，mix=0 恒等。
 *    输入/输出逐样本交错调度，无需随调用块长增长的 pending 队列。
 *  - IR 去周期化采用滑动能量窗，载入复杂度 O(M)，不修改调用方 IR。
 *  - 确定性：同输入同 IR 同参数必同输出；无随机、无 Date、无 console。
 *  - 可选内部精度（setPrecision）：float64 时频谱/历史/OLA/工作缓冲全部使用
 *    Float64Array，频域累加不再逐分区截断。源 IR 保存在本实例中，切换精度时
 *    按其重算全部频谱并 reset；默认 float32 的分配与算术顺序保持不变。
 */

import { fft, nextPow2 } from './fft'
import { UnrolledComplexProduct, type VectorComplexProduct } from './vectorKernel'

/** 构造选项：分区长（默认 512）与是否对 IR 做去周期化（默认 true） */
export interface ConvolverOptions {
  partitionSize?: number
  dePeriodize?: boolean
  /** Four-lane TypeScript complex-product kernel; false forces the scalar reference path. */
  vectorized?: boolean
  /** 初始内部精度（缺省 float32；切回默认路径仍可由 setPrecision 恢复）。 */
  precision?: Precision
}

/**
 * 控制线程预计算的 IR 频谱与 Worklet 专属零状态缓冲。
 * float32 实例的字段为 Float32Array（sumReal/sumImag 例外：历史实现即为 Float64
 * 累加）；float64 实例全部为 Float64Array。接收端按 precision 字段校验。
 */
export interface PreparedConvolverIR {
  /** 数据精度：由生产端写入，接收端按此校验每块缓冲的构造器。 */
  precision: Precision
  sampleRate: number
  partitionSize: number
  dePeriodize: boolean
  irLength: number
  irName: string | null
  numPartitions: number
  fftSize: number
  irSpecReal: AudioBuffer
  irSpecImag: AudioBuffer
  workReal: AudioBuffer
  workImag: AudioBuffer
  sumReal: Float64Array
  sumImag: Float64Array
  simdProductReal: AudioBuffer
  simdProductImag: AudioBuffer
  historyRealL: AudioBuffer
  historyImagL: AudioBuffer
  historyRealR: AudioBuffer
  historyImagR: AudioBuffer
  overlapL: AudioBuffer
  overlapR: AudioBuffer
  inputBlockL: AudioBuffer
  inputBlockR: AudioBuffer
  pendingWetL: AudioBuffer
  pendingWetR: AudioBuffer
  wetDelayL: AudioBuffer
  wetDelayR: AudioBuffer
}

export class Convolver {
  private readonly mixRamp: SampleRamp
  private readonly delayRamp: SampleRamp
  private readonly fs: number
  private readonly partitionSize: number
  private readonly dePeriodize: boolean
  private readonly vectorKernel: VectorComplexProduct | null
  private precision: Precision
  private irLoaded = false
  private irLength = 0
  private irName: string | null = null
  private numPartitions = 0
  private fftSize = 0
  /** 源 IR 副本（去周期化之前）：setPrecision 重算频谱的唯一依据。 */
  private sourceIr: Float32Array | null = null
  private irSpecReal: AudioBuffer = new Float32Array(0)
  private irSpecImag: AudioBuffer = new Float32Array(0)
  private mix = 1
  private preDelaySamples = 0

  // 两声道各自保存输入历史频谱及 OLA 尾部，共享块时钟。
  private historyRealL: AudioBuffer = new Float32Array(0)
  private historyImagL: AudioBuffer = new Float32Array(0)
  private historyRealR: AudioBuffer = new Float32Array(0)
  private historyImagR: AudioBuffer = new Float32Array(0)
  private historyPos = 0
  private overlapL: AudioBuffer = new Float32Array(0)
  private overlapR: AudioBuffer = new Float32Array(0)
  private inputBlockL: AudioBuffer = new Float32Array(0)
  private inputBlockR: AudioBuffer = new Float32Array(0)
  private inputPos = 0
  private pendingWetL: AudioBuffer = new Float32Array(0)
  private pendingWetR: AudioBuffer = new Float32Array(0)
  private wetDelayL: AudioBuffer
  private wetDelayR: AudioBuffer
  private wetDelayPos = 0

  // 频域累加：float32 模式下仍用 Float64 累加（历史行为），float64 模式全部
  // 双精度；FFT 接口按缓冲类型自动走 float32 / float64 蝶形。
  private workReal: AudioBuffer = new Float32Array(0)
  private workImag: AudioBuffer = new Float32Array(0)
  private sumReal = new Float64Array(0)
  private sumImag = new Float64Array(0)
  private simdProductReal: AudioBuffer = new Float32Array(0)
  private simdProductImag: AudioBuffer = new Float32Array(0)

  constructor(fs: number, opts?: ConvolverOptions) {
    if (fs <= 0 || !Number.isFinite(fs)) throw new Error('invalid sample rate')
    this.fs = fs
    this.precision = normalizePrecision(opts?.precision)
    this.mixRamp = new SampleRamp(fs, 1)
    this.delayRamp = new SampleRamp(fs, 0)
    let size = Math.round(opts?.partitionSize ?? 512)
    if (!Number.isFinite(size)) size = 512
    this.partitionSize = Math.min(8192, Math.max(32, size))
    this.dePeriodize = opts?.dePeriodize !== false
    this.vectorKernel = opts?.vectorized === false ? null : new UnrolledComplexProduct()
    // +1 使最大预延迟也有独立的读写位置。
    const maxDelay = Math.ceil(fs) + 1
    this.wetDelayL = allocBuffer(maxDelay, this.precision)
    this.wetDelayR = allocBuffer(maxDelay, this.precision)
  }

  /** 当前内部精度。 */
  getPrecision(): Precision {
    return this.precision
  }

  /**
   * 切换内部精度（幂等）：保留源 IR 并按新精度重算分区频谱、历史/OLA/工作缓冲，
   * 随后 reset。没有源 IR（由 prepared 接管、或尚未装载）时改为逐元素转换现有
   * 频谱的存储类型并 reset——不能在不做 IR FFT 的实时线程重建频谱。
   */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    if (this.sourceIr) {
      // 非实时路径：按新精度重算频谱（源 IR 保留，不损失精度）。
      this.buildIR(this.sourceIr, this.irName)
      return
    }
    this.convertBuffersTo(next)
    this.reset()
  }

  /** 载入单声道 IR；空、全零或非有限 IR 抛错。 */
  loadIR(ir: Float32Array, irName?: string): void {
    if (!ir || ir.length === 0) throw new Error('invalid impulse response: empty')
    let anyNonZero = false
    for (let i = 0; i < ir.length; i++) {
      if (!Number.isFinite(ir[i])) throw new Error('invalid impulse response: contains NaN/Infinity')
      if (ir[i] !== 0) anyNonZero = true
    }
    if (!anyNonZero) throw new Error('invalid impulse response: all zero')
    // 复制一份源 IR：调用方数组可复用，且 setPrecision 可据其重算频谱。
    this.sourceIr = new Float32Array(ir)
    this.buildIR(this.sourceIr, irName)
  }

  /** 由源 IR 分配/重算全部分区频谱与流式缓冲（非实时路径）。 */
  private buildIR(ir: Float32Array, irName?: string | null): void {
    const src = this.dePeriodize ? this.dePeriodizeIR(ir) : ir
    const L = this.partitionSize
    const P = Math.ceil(src.length / L)
    const N = nextPow2(2 * L)
    const precision = this.precision
    this.irLength = src.length
    this.irName = irName ?? null
    this.numPartitions = P
    this.fftSize = N
    this.irSpecReal = allocBuffer(P * N, precision)
    this.irSpecImag = allocBuffer(P * N, precision)
    this.workReal = allocBuffer(N, precision)
    this.workImag = allocBuffer(N, precision)
    this.sumReal = new Float64Array(N)
    this.sumImag = new Float64Array(N)
    this.simdProductReal = allocBuffer(N, precision)
    this.simdProductImag = allocBuffer(N, precision)
    for (let p = 0; p < P; p++) {
      this.workReal.fill(0)
      this.workImag.fill(0)
      const count = Math.min(L, src.length - p * L)
      for (let j = 0; j < count; j++) this.workReal[j] = src[p * L + j]
      fft(this.workReal, this.workImag, false)
      this.irSpecReal.set(this.workReal, p * N)
      this.irSpecImag.set(this.workImag, p * N)
    }
    this.historyRealL = allocBuffer(P * N, precision)
    this.historyImagL = allocBuffer(P * N, precision)
    this.historyRealR = allocBuffer(P * N, precision)
    this.historyImagR = allocBuffer(P * N, precision)
    this.overlapL = allocBuffer(L, precision)
    this.overlapR = allocBuffer(L, precision)
    this.inputBlockL = allocBuffer(L, precision)
    this.inputBlockR = allocBuffer(L, precision)
    this.pendingWetL = allocBuffer(L, precision)
    this.pendingWetR = allocBuffer(L, precision)
    this.wetDelayL = allocBuffer(this.wetDelayL.length, precision)
    this.wetDelayR = allocBuffer(this.wetDelayR.length, precision)
    this.reset()
    this.irLoaded = true
  }

  /** 无源 IR 时的精度切换：保持频谱数值、只改变存储构造器并重置流状态。 */
  private convertBuffersTo(precision: Precision): void {
    const convert = (buffer: AudioBuffer): AudioBuffer => {
      if (precision === 'float64') {
        return buffer instanceof Float64Array ? buffer : Float64Array.from(buffer)
      }
      return buffer instanceof Float32Array ? buffer : Float32Array.from(buffer)
    }
    this.irSpecReal = convert(this.irSpecReal)
    this.irSpecImag = convert(this.irSpecImag)
    this.workReal = allocBuffer(this.workReal.length, precision)
    this.workImag = allocBuffer(this.workImag.length, precision)
    this.simdProductReal = allocBuffer(this.simdProductReal.length, precision)
    this.simdProductImag = allocBuffer(this.simdProductImag.length, precision)
    this.historyRealL = convert(this.historyRealL)
    this.historyImagL = convert(this.historyImagL)
    this.historyRealR = convert(this.historyRealR)
    this.historyImagR = convert(this.historyImagR)
    this.overlapL = convert(this.overlapL)
    this.overlapR = convert(this.overlapR)
    this.inputBlockL = convert(this.inputBlockL)
    this.inputBlockR = convert(this.inputBlockR)
    this.pendingWetL = convert(this.pendingWetL)
    this.pendingWetR = convert(this.pendingWetR)
    this.wetDelayL = allocBuffer(this.wetDelayL.length, precision)
    this.wetDelayR = allocBuffer(this.wetDelayR.length, precision)
  }

  /** 在控制线程生成可转移的 IR 频谱和流式 scratch；源 Convolver 不会被 detach。 */
  createPreparedIRTransfer(): PreparedConvolverIR | null {
    if (!this.irLoaded) return null
    const L = this.partitionSize
    const N = this.fftSize
    const historyLength = this.numPartitions * N
    const precision = this.precision
    return {
      precision,
      sampleRate: this.fs,
      partitionSize: L,
      dePeriodize: this.dePeriodize,
      irLength: this.irLength,
      irName: this.irName,
      numPartitions: this.numPartitions,
      fftSize: N,
      irSpecReal: this.irSpecReal.slice(),
      irSpecImag: this.irSpecImag.slice(),
      workReal: allocBuffer(N, precision),
      workImag: allocBuffer(N, precision),
      sumReal: new Float64Array(N),
      sumImag: new Float64Array(N),
      simdProductReal: allocBuffer(N, precision),
      simdProductImag: allocBuffer(N, precision),
      historyRealL: allocBuffer(historyLength, precision),
      historyImagL: allocBuffer(historyLength, precision),
      historyRealR: allocBuffer(historyLength, precision),
      historyImagR: allocBuffer(historyLength, precision),
      overlapL: allocBuffer(L, precision),
      overlapR: allocBuffer(L, precision),
      inputBlockL: allocBuffer(L, precision),
      inputBlockR: allocBuffer(L, precision),
      pendingWetL: allocBuffer(L, precision),
      pendingWetR: allocBuffer(L, precision),
      wetDelayL: allocBuffer(this.wetDelayL.length, precision),
      wetDelayR: allocBuffer(this.wetDelayR.length, precision),
    }
  }

  /** Worklet 侧接管控制线程准备的数组；校验失败时调用者应回退 loadIR。 */
  loadPreparedIR(prepared: PreparedConvolverIR): boolean {
    const L = this.partitionSize
    const expectedN = nextPow2(2 * L)
    const expectedP = Math.ceil(prepared.irLength / L)
    const historyLength = expectedP * expectedN
    const precision = normalizePrecision(prepared.precision)
    const single = (value: unknown, length: number): boolean => precision === 'float64'
      ? value instanceof Float64Array && value.length === length
      : value instanceof Float32Array && value.length === length
    const sum = (value: unknown, length: number): boolean => value instanceof Float64Array && value.length === length
    if (prepared.sampleRate !== this.fs || prepared.partitionSize !== L || prepared.dePeriodize !== this.dePeriodize
      || !Number.isInteger(prepared.irLength) || prepared.irLength <= 0
      || prepared.fftSize !== expectedN || prepared.numPartitions !== expectedP
      || !single(prepared.irSpecReal, historyLength) || !single(prepared.irSpecImag, historyLength)
      || !single(prepared.workReal, expectedN) || !single(prepared.workImag, expectedN)
      || !sum(prepared.sumReal, expectedN) || !sum(prepared.sumImag, expectedN)
      || !single(prepared.simdProductReal, expectedN) || !single(prepared.simdProductImag, expectedN)
      || !single(prepared.historyRealL, historyLength) || !single(prepared.historyImagL, historyLength)
      || !single(prepared.historyRealR, historyLength) || !single(prepared.historyImagR, historyLength)
      || !single(prepared.overlapL, L) || !single(prepared.overlapR, L)
      || !single(prepared.inputBlockL, L) || !single(prepared.inputBlockR, L)
      || !single(prepared.pendingWetL, L) || !single(prepared.pendingWetR, L)
      || !single(prepared.wetDelayL, this.wetDelayL.length) || !single(prepared.wetDelayR, this.wetDelayR.length)) return false

    // prepared 自带精度描述：接管后实例精度与数据一致（调用方随后按同精度处理）。
    this.precision = precision
    this.sourceIr = null
    this.irLength = prepared.irLength
    this.irName = prepared.irName
    this.numPartitions = expectedP
    this.fftSize = expectedN
    this.irSpecReal = prepared.irSpecReal
    this.irSpecImag = prepared.irSpecImag
    this.workReal = prepared.workReal
    this.workImag = prepared.workImag
    this.sumReal = prepared.sumReal
    this.sumImag = prepared.sumImag
    this.simdProductReal = prepared.simdProductReal
    this.simdProductImag = prepared.simdProductImag
    this.historyRealL = prepared.historyRealL
    this.historyImagL = prepared.historyImagL
    this.historyRealR = prepared.historyRealR
    this.historyImagR = prepared.historyImagR
    this.overlapL = prepared.overlapL
    this.overlapR = prepared.overlapR
    this.inputBlockL = prepared.inputBlockL
    this.inputBlockR = prepared.inputBlockR
    this.pendingWetL = prepared.pendingWetL
    this.pendingWetR = prepared.pendingWetR
    this.wetDelayL = prepared.wetDelayL
    this.wetDelayR = prepared.wetDelayR
    this.mixRamp.reset(); this.delayRamp.reset()
    // 传入的所有状态数组由控制线程新建为零数组，直接归零游标，无需在 Worklet 线程清空长历史。
    this.inputPos = 0
    this.historyPos = 0
    this.wetDelayPos = 0
    this.irLoaded = true
    return true
  }

  setMix(mix: number): void {
    this.mix = Number.isFinite(mix) ? Math.min(1, Math.max(0, mix)) : 0
    this.mixRamp.set(this.mix)
  }

  /** 湿路预延迟 0..1000ms。 */
  setPreDelayMs(ms: number): void {
    const clamped = Number.isFinite(ms) ? Math.min(1000, Math.max(0, ms)) : 0
    this.preDelaySamples = Math.round(clamped * this.fs / 1000)
    this.delayRamp.set(this.preDelaySamples)
  }

  /** 有限块单声道纯卷积：独立零状态，返回完整 IR 尾和预延迟，不影响流式历史。 */
  process(x: Float32Array): Float32Array {
    if (!this.irLoaded) throw new Error('no impulse response loaded')
    if (x.length === 0) return new Float32Array(0)
    const L = this.partitionSize
    const convLen = x.length + this.irLength - 1
    const out = new Float32Array(convLen + this.preDelaySamples)
    const precision = this.precision
    const historyReal = allocBuffer(this.numPartitions * this.fftSize, precision)
    const historyImag = allocBuffer(historyReal.length, precision)
    const overlap = allocBuffer(L, precision)
    const input = allocBuffer(L, precision)
    const wet = allocBuffer(L, precision)
    let position = 0
    for (let offset = 0; offset < convLen; offset += L) {
      input.fill(0)
      for (let j = 0; j < L && offset + j < x.length; j++) input[j] = x[offset + j]
      this.processWetBlock(input, wet, historyReal, historyImag, overlap, position)
      for (let j = 0; j < L && offset + j < convLen; j++) {
        out[this.preDelaySamples + offset + j] = wet[j]
      }
      position = (position + 1) % this.numPartitions
    }
    return out
  }

  /** 流式立体声；湿路延迟 L+preDelay，干路恒等。任意块长使用同一采样时钟。 */
  processStereo(l: AudioBuffer, r: AudioBuffer): void {
    if (!this.irLoaded) throw new Error('no impulse response loaded')
    const B = Math.min(l.length, r.length)
    const L = this.partitionSize
    for (let i = 0; i < B; i++) {
      const dryL = l[i]
      const dryR = r[i]
      let wetL = this.pendingWetL[this.inputPos]
      let wetR = this.pendingWetR[this.inputPos]
      this.inputBlockL[this.inputPos] = dryL
      this.inputBlockR[this.inputPos] = dryR
      const mix = this.mixRamp.next(), delay = this.delayRamp.next()
      // 先写当前湿声，再从连续读点插值；零预延迟也保持同一历史时钟。
      this.wetDelayL[this.wetDelayPos] = wetL
      this.wetDelayR[this.wetDelayPos] = wetR
      const read = (this.wetDelayPos - delay + this.wetDelayL.length) % this.wetDelayL.length
      const read0 = Math.floor(read), fraction = read - read0, read1 = (read0 + 1) % this.wetDelayL.length
      wetL = this.wetDelayL[read0] + fraction * (this.wetDelayL[read1] - this.wetDelayL[read0])
      wetR = this.wetDelayR[read0] + fraction * (this.wetDelayR[read1] - this.wetDelayR[read0])
      this.wetDelayPos++
      if (this.wetDelayPos === this.wetDelayL.length) this.wetDelayPos = 0
      l[i] = (1 - mix) * dryL + mix * wetL
      r[i] = (1 - mix) * dryR + mix * wetR
      this.inputPos++
      if (this.inputPos === L) {
        this.processWetBlock(this.inputBlockL, this.pendingWetL,
          this.historyRealL, this.historyImagL, this.overlapL, this.historyPos)
        this.processWetBlock(this.inputBlockR, this.pendingWetR,
          this.historyRealR, this.historyImagR, this.overlapR, this.historyPos)
        this.inputPos = 0
        this.historyPos = (this.historyPos + 1) % this.numPartitions
      }
    }
  }

  getLatencySamples(): number {
    return this.partitionSize + this.preDelaySamples
  }

  reset(): void {
    this.mixRamp.reset(); this.delayRamp.reset()
    this.inputPos = 0
    this.historyPos = 0
    this.wetDelayPos = 0
    this.historyRealL.fill(0)
    this.historyImagL.fill(0)
    this.historyRealR.fill(0)
    this.historyImagR.fill(0)
    this.overlapL.fill(0)
    this.overlapR.fill(0)
    this.inputBlockL.fill(0)
    this.inputBlockR.fill(0)
    this.pendingWetL.fill(0)
    this.pendingWetR.fill(0)
    this.wetDelayL.fill(0)
    this.wetDelayR.fill(0)
  }

  getIrName(): string | null {
    return this.irName
  }

  /** Y_b=Σ_p H_p·X_(b−p)，再做一次 IFFT 和 OLA。 */
  private processWetBlock(input: AudioBuffer, wet: AudioBuffer,
    historyReal: AudioBuffer, historyImag: AudioBuffer,
    overlap: AudioBuffer, position: number): void {
    const L = this.partitionSize
    const N = this.fftSize
    this.workReal.fill(0)
    this.workImag.fill(0)
    this.workReal.set(input)
    fft(this.workReal, this.workImag, false)
    historyReal.set(this.workReal, position * N)
    historyImag.set(this.workImag, position * N)
    this.sumReal.fill(0)
    this.sumImag.fill(0)
    // 向量内核按精度分派：float32 走 f32 四路展开（WASM SIMD 可用时由门面自动
    // 选择，输出逐位一致），float64 走 processDouble（f64x2 / double TS）。两者
    // 都复用预分配的 simdProduct scratch，逐块零分配；返回 false 时回退标量循环。
    const useDouble = this.precision === 'float64'
    const useVector = this.vectorKernel !== null
    let history = position
    for (let p = 0; p < this.numPartitions; p++) {
      const h = p * N
      const x = history * N
      const vectorized = useVector && (useDouble
        ? this.vectorKernel!.processDouble?.(
          historyReal as Float64Array, historyImag as Float64Array,
          this.irSpecReal as Float64Array, this.irSpecImag as Float64Array,
          this.simdProductReal as Float64Array, this.simdProductImag as Float64Array, N,
          x, x, h, h,
        ) === true
        : this.vectorKernel!.process(
          historyReal as Float32Array, historyImag as Float32Array,
          this.irSpecReal as Float32Array, this.irSpecImag as Float32Array,
          this.simdProductReal as Float32Array, this.simdProductImag as Float32Array, N,
          x, x, h, h,
        ) === true)
      if (vectorized) {
        for (let k = 0; k < N; k++) {
          this.sumReal[k] += this.simdProductReal[k]
          this.sumImag[k] += this.simdProductImag[k]
        }
      } else {
        for (let k = 0; k < N; k++) {
          const xr = historyReal[x + k]
          const xi = historyImag[x + k]
          const hr = this.irSpecReal[h + k]
          const hi = this.irSpecImag[h + k]
          this.sumReal[k] += xr * hr - xi * hi
          this.sumImag[k] += xr * hi + xi * hr
        }
      }
      if (--history < 0) history = this.numPartitions - 1
    }
    this.workReal.set(this.sumReal)
    this.workImag.set(this.sumImag)
    fft(this.workReal, this.workImag, true)
    for (let i = 0; i < L; i++) {
      wet[i] = overlap[i] + this.workReal[i]
      overlap[i] = this.workReal[L + i]
    }
  }

  /** 移动 RMS 窗寻找最后一个超过峰值 −60dB 的位置，然后对尾部施指数窗。 */
  private dePeriodizeIR(ir: Float32Array): Float32Array {
    const M = ir.length
    const out = new Float32Array(ir)
    const half = Math.max(4, Math.round(0.01 * this.fs)) >> 1
    const energy = new Float64Array(M)
    let sum = 0
    let left = 0
    let right = Math.min(M, half + 1)
    for (let i = 0; i < right; i++) sum += ir[i] * ir[i]
    let peak = 0
    for (let i = 0; i < M; i++) {
      const lo = Math.max(0, i - half)
      const hi = Math.min(M, i + half + 1)
      while (left < lo) { sum -= ir[left] * ir[left]; left++ }
      while (right < hi) { sum += ir[right] * ir[right]; right++ }
      energy[i] = Math.max(0, sum) / (hi - lo)
      if (energy[i] > peak) peak = energy[i]
    }
    if (peak <= 1e-24) return out
    let lastAbove = M - 1
    while (lastAbove >= 0 && energy[lastAbove] <= peak * 1e-6) lastAbove--
    const start = lastAbove + 1
    const tau = 0.05 * this.fs
    for (let i = start; i < M; i++) out[i] *= Math.exp(-(i - start) / tau)
    return out
  }
}
