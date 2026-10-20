/**
 * 空间双耳分区卷积：两耳 IR 共用同一声源块时只做一次输入 FFT，频域历史也共用。
 * 声源大小启用右耳去相关后，首次分离输入时复制既有历史，再各自更新历史。
 * 两耳仍各做一次 IFFT；可使用短计算分区并补齐输出延迟，避免长分区集中结算。
 *
 * 可选内部精度（setPrecision）：float64 下频谱/历史/工作/延迟缓冲全部为
 * Float64Array，FFT 走 fft.ts 的双精度蝶形。默认 float32 的分配与算术顺序与
 * 旧实现完全一致（prepared 路径逐位回归）。
 */
import { fft, nextPow2 } from '../dsp/fft'
import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from '../dsp/audioBuffer'

/** 控制线程生成的独占缓冲；接收端可接管，发送端转移后不能继续使用。 */
export interface PreparedBinauralIR {
  /** 数据精度：生产端写入；接收端据此校验每块缓冲构造器并沿用同一精度。 */
  precision: Precision
  partitionSize: number
  latencySamples: number
  fftSize: number
  partitions: number
  irRealL: AudioBuffer
  irImagL: AudioBuffer
  irRealR: AudioBuffer
  irImagR: AudioBuffer
  targetRealL: AudioBuffer
  targetImagL: AudioBuffer
  targetRealR: AudioBuffer
  targetImagR: AudioBuffer
  historyRealL: AudioBuffer
  historyImagL: AudioBuffer
  historyRealR: AudioBuffer
  historyImagR: AudioBuffer
  inputL: AudioBuffer
  inputR: AudioBuffer
  pendingL: AudioBuffer
  pendingR: AudioBuffer
  overlapL: AudioBuffer
  overlapR: AudioBuffer
  workReal: AudioBuffer
  workImag: AudioBuffer
  sumReal: Float64Array
  sumImag: Float64Array
  outputDelayL: AudioBuffer
  outputDelayR: AudioBuffer
}

const SPECTRAL_KEYS = ['irRealL', 'irImagL', 'irRealR', 'irImagR',
  'targetRealL', 'targetImagL', 'targetRealR', 'targetImagR'] as const
const HISTORY_KEYS = ['historyRealL', 'historyImagL', 'historyRealR', 'historyImagR'] as const
const BLOCK_KEYS = ['inputL', 'inputR', 'pendingL', 'pendingR', 'overlapL', 'overlapR'] as const

/** 结构校验不执行 FFT；限制尺寸并拒绝别名/截断视图及非有限频谱。 */
function validPreparedIR(value: unknown, partitionSize: number, latencySamples: number,
  expectedPrecision?: Precision): value is PreparedBinauralIR {
  if (!value || typeof value !== 'object') return false
  const p = value as PreparedBinauralIR
  if (p.partitionSize !== partitionSize || p.latencySamples !== latencySamples || p.fftSize !== partitionSize * 2
    || !Number.isInteger(p.partitions) || p.partitions < 1 || p.partitions > 32768
    || p.partitions * p.fftSize > 4 * 1024 * 1024) return false
  const precision = normalizePrecision(p.precision)
  if (expectedPrecision !== undefined && precision !== expectedPrecision) return false
  const single = (array: unknown, length: number): boolean => precision === 'float64'
    ? array instanceof Float64Array && array.length === length
    : array instanceof Float32Array && array.length === length
  const buffers = new Set<ArrayBuffer>()
  const standalone = (array: AudioBuffer, length: number): boolean => {
    if (!(array.buffer instanceof ArrayBuffer) || array.length !== length || array.byteOffset !== 0
      || array.buffer.byteLength !== array.byteLength || buffers.has(array.buffer)) return false
    buffers.add(array.buffer)
    return true
  }
  const spectralLength = p.partitions * p.fftSize
  let activeLeft = false
  let activeRight = false
  for (const key of SPECTRAL_KEYS) {
    const array = p[key]
    if (!single(array, spectralLength) || !standalone(array as AudioBuffer, spectralLength)) return false
    // 显式循环避免 typed-array every 对每个 bin 调用一次 JS 回调；数值校验仍覆盖全部八个频谱。
    let active = false
    for (let i = 0; i < spectralLength; i++) {
      const sample = array[i]
      if (!Number.isFinite(sample)) return false
      active ||= sample !== 0
    }
    if (key === 'irRealL' || key === 'irImagL') activeLeft ||= active
    else if (key === 'irRealR' || key === 'irImagR') activeRight ||= active
  }
  // 两耳必须各有非静音频谱，保持与 loadIR 对全零 HRIR 的拒绝约定。
  if (!activeLeft || !activeRight) return false
  for (const key of HISTORY_KEYS) {
    if (!single(p[key], spectralLength) || !standalone(p[key] as AudioBuffer, spectralLength)) return false
  }
  for (const key of BLOCK_KEYS) {
    if (!single(p[key], partitionSize) || !standalone(p[key] as AudioBuffer, partitionSize)) return false
  }
  if (!single(p.workReal, p.fftSize) || !standalone(p.workReal, p.fftSize)
    || !single(p.workImag, p.fftSize) || !standalone(p.workImag, p.fftSize)
    || !(p.sumReal instanceof Float64Array) || !standalone(p.sumReal, p.fftSize)
    || !(p.sumImag instanceof Float64Array) || !standalone(p.sumImag, p.fftSize)
    || !single(p.outputDelayL, latencySamples - partitionSize) || !standalone(p.outputDelayL, latencySamples - partitionSize)
    || !single(p.outputDelayR, latencySamples - partitionSize) || !standalone(p.outputDelayR, latencySamples - partitionSize)) return false
  return true
}

/** 同长复用已有缓冲；精度变化或长度变化时重新分配（仅非实时路径调用）。 */
function reuseBuffer(buffer: AudioBuffer | null, length: number, precision: Precision): AudioBuffer {
  if (buffer && buffer.length === length
    && (precision === 'float64' ? buffer instanceof Float64Array : buffer instanceof Float32Array)) return buffer
  return allocBuffer(length, precision)
}

export class BinauralConvolver {
  private readonly partitionSize: number
  private precision: Precision
  private fftSize = 0
  private partitions = 0
  private irRealL: AudioBuffer = new Float32Array(0)
  private irImagL: AudioBuffer = new Float32Array(0)
  private irRealR: AudioBuffer = new Float32Array(0)
  private irImagR: AudioBuffer = new Float32Array(0)
  private targetRealL: AudioBuffer = new Float32Array(0)
  private targetImagL: AudioBuffer = new Float32Array(0)
  private targetRealR: AudioBuffer = new Float32Array(0)
  private targetImagR: AudioBuffer = new Float32Array(0)
  private morphBlocks = 0
  private historyRealL: AudioBuffer = new Float32Array(0)
  private historyImagL: AudioBuffer = new Float32Array(0)
  private historyRealR: AudioBuffer | null = null
  private historyImagR: AudioBuffer | null = null
  private historyPos = 0
  private inputPos = 0
  private inputL: AudioBuffer = new Float32Array(0)
  private inputR: AudioBuffer = new Float32Array(0)
  private pendingL: AudioBuffer = new Float32Array(0)
  private pendingR: AudioBuffer = new Float32Array(0)
  private overlapL: AudioBuffer = new Float32Array(0)
  private overlapR: AudioBuffer = new Float32Array(0)
  private workReal: AudioBuffer = new Float32Array(0)
  private workImag: AudioBuffer = new Float32Array(0)
  private sumReal = new Float64Array(0)
  private sumImag = new Float64Array(0)
  private outputDelayL: AudioBuffer
  private outputDelayR: AudioBuffer
  private outputDelayPos = 0

  constructor(partitionSize = 512, latencySamples = partitionSize, precision: Precision = 'float32') {
    if (!Number.isInteger(partitionSize) || partitionSize < 1 || partitionSize > 8192
      || (partitionSize & (partitionSize - 1)) !== 0) throw new Error('invalid binaural partition size')
    if (!Number.isInteger(latencySamples) || latencySamples < partitionSize || latencySamples > 8192) {
      throw new Error('invalid binaural output latency')
    }
    this.partitionSize = partitionSize
    this.precision = normalizePrecision(precision)
    this.outputDelayL = allocBuffer(latencySamples - partitionSize, this.precision)
    this.outputDelayR = allocBuffer(latencySamples - partitionSize, this.precision)
  }

  /** 当前内部精度。 */
  getPrecision(): Precision {
    return this.precision
  }

  /**
   * 切换内部精度（幂等）：重置流式状态并按新精度重建频谱/历史/工作/延迟缓冲。
   * 已装载的频谱数值按元素转换（不重跑 FFT），滤波器语义不变；若调用方需要
   * 由时域 IR 重新量化，应在切换后重新 loadIR。
   */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    const convert = (buffer: AudioBuffer): AudioBuffer => {
      if (next === 'float64') return buffer instanceof Float64Array ? buffer : Float64Array.from(buffer)
      return buffer instanceof Float32Array ? buffer : Float32Array.from(buffer)
    }
    this.irRealL = convert(this.irRealL); this.irImagL = convert(this.irImagL)
    this.irRealR = convert(this.irRealR); this.irImagR = convert(this.irImagR)
    this.targetRealL = convert(this.targetRealL); this.targetImagL = convert(this.targetImagL)
    this.targetRealR = convert(this.targetRealR); this.targetImagR = convert(this.targetImagR)
    this.historyRealL = convert(this.historyRealL); this.historyImagL = convert(this.historyImagL)
    if (this.historyRealR) this.historyRealR = convert(this.historyRealR)
    if (this.historyImagR) this.historyImagR = convert(this.historyImagR)
    this.inputL = convert(this.inputL); this.inputR = convert(this.inputR)
    this.pendingL = convert(this.pendingL); this.pendingR = convert(this.pendingR)
    this.overlapL = convert(this.overlapL); this.overlapR = convert(this.overlapR)
    this.workReal = allocBuffer(this.workReal.length, next)
    this.workImag = allocBuffer(this.workImag.length, next)
    this.sumReal = new Float64Array(this.sumReal.length)
    this.sumImag = new Float64Array(this.sumImag.length)
    this.outputDelayL = allocBuffer(this.outputDelayL.length, next)
    this.outputDelayR = allocBuffer(this.outputDelayR.length, next)
    this.reset()
  }

  /** 只在控制线程调用；FFT 与全部流式工作区在发送前准备。 */
  static prepareIR(left: Float32Array, right: Float32Array,
    partitionSize = 512, latencySamples = partitionSize, precision: Precision = 'float32'): PreparedBinauralIR {
    const convolver = new BinauralConvolver(partitionSize, latencySamples, precision)
    convolver.loadIR(left, right, true)
    return convolver.createPreparedIRTransfer()
  }

  /** 导出最终目标，而不是形变到一半的系数；所有数组均独立，历史从零开始。 */
  createPreparedIRTransfer(): PreparedBinauralIR {
    if (!this.partitions) throw new Error('no binaural impulse response loaded')
    const spectralLength = this.partitions * this.fftSize
    const target = this.morphBlocks > 0
    const precision = this.precision
    const realL = target ? this.targetRealL : this.irRealL
    const imagL = target ? this.targetImagL : this.irImagL
    const realR = target ? this.targetRealR : this.irRealR
    const imagR = target ? this.targetImagR : this.irImagR
    const L = this.partitionSize
    return {
      precision,
      partitionSize: L, latencySamples: L + this.outputDelayL.length,
      fftSize: this.fftSize, partitions: this.partitions,
      irRealL: realL.slice(), irImagL: imagL.slice(), irRealR: realR.slice(), irImagR: imagR.slice(),
      targetRealL: realL.slice(), targetImagL: imagL.slice(), targetRealR: realR.slice(), targetImagR: imagR.slice(),
      historyRealL: allocBuffer(spectralLength, precision), historyImagL: allocBuffer(spectralLength, precision),
      historyRealR: allocBuffer(spectralLength, precision), historyImagR: allocBuffer(spectralLength, precision),
      inputL: allocBuffer(L, precision), inputR: allocBuffer(L, precision),
      pendingL: allocBuffer(L, precision), pendingR: allocBuffer(L, precision),
      overlapL: allocBuffer(L, precision), overlapR: allocBuffer(L, precision),
      workReal: allocBuffer(this.fftSize, precision), workImag: allocBuffer(this.fftSize, precision),
      sumReal: new Float64Array(this.fftSize), sumImag: new Float64Array(this.fftSize),
      outputDelayL: allocBuffer(this.outputDelayL.length, precision), outputDelayR: allocBuffer(this.outputDelayR.length, precision),
    }
  }

  /** 渲染线程初装：仅接管独占频谱及工作区，不执行 IR FFT 或创建大数组。 */
  loadPreparedIR(prepared: PreparedBinauralIR): boolean {
    if (!validPreparedIR(prepared, this.partitionSize, this.partitionSize + this.outputDelayL.length)) return false
    this.adoptPreparedIR(prepared)
    return true
  }

  /** 只供通过完整校验的装载/换容量路径调用，避免同一消息扫描两次频谱。 */
  private adoptPreparedIR(prepared: PreparedBinauralIR): void {
    // prepared 自带精度：接管后实例精度与数据一致。
    this.precision = normalizePrecision(prepared.precision)
    this.fftSize = prepared.fftSize
    this.partitions = prepared.partitions
    this.irRealL = prepared.irRealL; this.irImagL = prepared.irImagL
    this.irRealR = prepared.irRealR; this.irImagR = prepared.irImagR
    this.targetRealL = prepared.targetRealL; this.targetImagL = prepared.targetImagL
    this.targetRealR = prepared.targetRealR; this.targetImagR = prepared.targetImagR
    this.historyRealL = prepared.historyRealL; this.historyImagL = prepared.historyImagL
    this.historyRealR = prepared.historyRealR; this.historyImagR = prepared.historyImagR
    this.inputL = prepared.inputL; this.inputR = prepared.inputR
    this.pendingL = prepared.pendingL; this.pendingR = prepared.pendingR
    this.overlapL = prepared.overlapL; this.overlapR = prepared.overlapR
    this.workReal = prepared.workReal; this.workImag = prepared.workImag
    this.sumReal = prepared.sumReal; this.sumImag = prepared.sumImag
    this.outputDelayL = prepared.outputDelayL; this.outputDelayR = prepared.outputDelayR
    this.morphBlocks = 0
    this.reset()
  }

  /** 同容量只覆盖目标频谱；保留输入历史、待输出、重叠尾及当前形变系数。 */
  updatePreparedIR(prepared: PreparedBinauralIR, transitionSamples = 960): boolean {
    // 同容量更新会写入本实例自己的目标频谱，必须与实例精度一致。
    if (!validPreparedIR(prepared, this.partitionSize, this.partitionSize + this.outputDelayL.length, this.precision)) return false
    if (!this.partitions || prepared.partitions !== this.partitions) {
      this.adoptPreparedIR(prepared)
      return true
    }
    if (!this.historyRealR || !this.historyImagR) {
      // 普通 loadIR(false) 的兼容路径：接管准备好的右耳历史空间并复制现有公共历史。
      this.historyRealR = prepared.historyRealR; this.historyImagR = prepared.historyImagR
      this.historyRealR.set(this.historyRealL); this.historyImagR.set(this.historyImagL)
    }
    this.targetRealL.set(prepared.irRealL); this.targetImagL.set(prepared.irImagL)
    this.targetRealR.set(prepared.irRealR); this.targetImagR.set(prepared.irImagR)
    this.morphBlocks = Math.max(1, Math.ceil((Number.isFinite(transitionSamples) ? Math.max(0, transitionSamples) : 960) / this.partitionSize))
    return true
  }

  loadIR(left: Float32Array, right: Float32Array, separateInput = false): void {
    if (!left.length || left.length !== right.length) throw new Error('invalid binaural impulse response length')
    for (const ir of [left, right]) {
      let active = false
      for (const sample of ir) {
        if (!Number.isFinite(sample)) throw new Error('invalid binaural impulse response sample')
        active ||= sample !== 0
      }
      if (!active) throw new Error('invalid binaural impulse response: all zero')
    }
    const L = this.partitionSize
    const N = nextPow2(L * 2)
    const P = Math.ceil(left.length / L)
    const precision = this.precision
    this.fftSize = N
    this.partitions = P
    // 移动声源的 HRIR 长度通常固定；复用频谱/历史/scratch，避免每次重装创建 18 个缓冲。
    // IR 频谱随后全部覆盖，流式历史由 reset() 清零，保持与新实例相同的装载语义。
    this.irRealL = reuseBuffer(this.irRealL, P * N, precision)
    this.irImagL = reuseBuffer(this.irImagL, P * N, precision)
    this.irRealR = reuseBuffer(this.irRealR, P * N, precision)
    this.irImagR = reuseBuffer(this.irImagR, P * N, precision)
    this.targetRealL = reuseBuffer(this.targetRealL, P * N, precision)
    this.targetImagL = reuseBuffer(this.targetImagL, P * N, precision)
    this.targetRealR = reuseBuffer(this.targetRealR, P * N, precision)
    this.targetImagR = reuseBuffer(this.targetImagR, P * N, precision)
    this.historyRealL = reuseBuffer(this.historyRealL, P * N, precision)
    this.historyImagL = reuseBuffer(this.historyImagL, P * N, precision)
    // 声源大小会让右耳输入去相关；在非实时的 IR 配置阶段预留独立历史。
    this.historyRealR = separateInput ? reuseBuffer(this.historyRealR, P * N, precision) : null
    this.historyImagR = separateInput ? reuseBuffer(this.historyImagR, P * N, precision) : null
    this.inputL = reuseBuffer(this.inputL, L, precision)
    this.inputR = reuseBuffer(this.inputR, L, precision)
    this.pendingL = reuseBuffer(this.pendingL, L, precision)
    this.pendingR = reuseBuffer(this.pendingR, L, precision)
    this.overlapL = reuseBuffer(this.overlapL, L, precision)
    this.overlapR = reuseBuffer(this.overlapR, L, precision)
    this.workReal = reuseBuffer(this.workReal, N, precision)
    this.workImag = reuseBuffer(this.workImag, N, precision)
    this.sumReal = this.sumReal.length === N ? this.sumReal : new Float64Array(N)
    this.sumImag = this.sumImag.length === N ? this.sumImag : new Float64Array(N)
    for (let p = 0; p < P; p++) {
      for (const [ir, real, imaginary] of [
        [left, this.irRealL, this.irImagL], [right, this.irRealR, this.irImagR],
      ] as const) {
        this.workReal.fill(0)
        this.workImag.fill(0)
        const count = Math.min(L, ir.length - p * L)
        for (let i = 0; i < count; i++) this.workReal[i] = ir[p * L + i]
        fft(this.workReal, this.workImag, false)
        real.set(this.workReal, p * N)
        imaginary.set(this.workImag, p * N)
      }
    }
    this.morphBlocks = 0
    this.reset()
  }

  /** 同容量方向更新：保留输入频谱、待输出和重叠尾，20ms 内渐变滤波器。 */
  updateIR(left: Float32Array, right: Float32Array, separateInput = false, transitionSamples = 960): void {
    if (!this.partitions || Math.ceil(left.length / this.partitionSize) !== this.partitions || left.length !== right.length) {
      this.loadIR(left, right, separateInput)
      return
    }
    for (const ir of [left, right]) {
      if (!ir.some(value => value !== 0) || !ir.every(Number.isFinite)) throw new Error('invalid binaural impulse response')
    }
    if (separateInput && !this.historyRealR) {
      this.historyRealR = this.historyRealL.slice(); this.historyImagR = this.historyImagL.slice()
    }
    for (let p = 0; p < this.partitions; p++) {
      for (const [ir, real, imaginary] of [
        [left, this.targetRealL, this.targetImagL], [right, this.targetRealR, this.targetImagR],
      ] as const) {
        this.workReal.fill(0); this.workImag.fill(0)
        for (let i = 0, count = Math.min(this.partitionSize, ir.length - p * this.partitionSize); i < count; i++) {
          this.workReal[i] = ir[p * this.partitionSize + i]
        }
        fft(this.workReal, this.workImag, false)
        real.set(this.workReal, p * this.fftSize); imaginary.set(this.workImag, p * this.fftSize)
      }
    }
    this.morphBlocks = Math.max(1, Math.ceil(transitionSamples / this.partitionSize))
  }

  processStereo(left: AudioBuffer, right: AudioBuffer): void {
    if (!this.partitions) throw new Error('no binaural impulse response loaded')
    const count = Math.min(left.length, right.length)
    const L = this.partitionSize
    const inputL = this.inputL, inputR = this.inputR
    const pendingL = this.pendingL, pendingR = this.pendingR
    const delayL = this.outputDelayL, delayR = this.outputDelayR
    const delayLength = delayL.length
    let i = 0
    while (i < count) {
      // 一个连续片段内没有卷积结算，缓存引用并在块边界统一提交游标。
      const start = this.inputPos
      const end = start + Math.min(L - start, count - i)
      if (delayLength > 0) {
        let read = this.outputDelayPos
        for (let pos = start; pos < end; pos++, i++) {
          inputL[pos] = left[i]; inputR[pos] = right[i]
          left[i] = delayL[read]; right[i] = delayR[read]
          delayL[read] = pendingL[pos]; delayR[read] = pendingR[pos]
          if (++read === delayLength) read = 0
        }
        this.outputDelayPos = read
      } else {
        for (let pos = start; pos < end; pos++, i++) {
          inputL[pos] = left[i]; inputR[pos] = right[i]
          left[i] = pendingL[pos]; right[i] = pendingR[pos]
        }
      }
      this.inputPos = end
      if (end === L) {
        this.processBlock()
        this.inputPos = 0
      }
    }
  }

  private processBlock(): void {
    const L = this.partitionSize
    const N = this.fftSize
    if (this.morphBlocks > 0) {
      const step = 1 / this.morphBlocks--
      for (let i = 0; i < this.irRealL.length; i++) {
        this.irRealL[i] += (this.targetRealL[i] - this.irRealL[i]) * step
        this.irImagL[i] += (this.targetImagL[i] - this.irImagL[i]) * step
        this.irRealR[i] += (this.targetRealR[i] - this.irRealR[i]) * step
        this.irImagR[i] += (this.targetImagR[i] - this.irImagR[i]) * step
      }
      // 系数变化时也用同一滤波器重算上一输入块的重叠尾；否则到达时间
      // 改变会在新块头部造成能量缺口。输入频谱仍是原有连续历史。
      const current = this.historyPos
      this.historyPos = (current + this.partitions - 1) % this.partitions
      this.renderEar(this.irRealL, this.irImagL, this.historyRealL, this.historyImagL, this.pendingL, this.overlapL)
      this.renderEar(this.irRealR, this.irImagR, this.historyRealR ?? this.historyRealL,
        this.historyImagR ?? this.historyImagL, this.pendingR, this.overlapR)
      this.historyPos = current
    }
    let common = true
    for (let i = 0; i < L; i++) {
      if (this.inputL[i] !== this.inputR[i]) { common = false; break }
    }
    this.workReal.set(this.inputL)
    this.workReal.fill(0, L)
    this.workImag.fill(0)
    fft(this.workReal, this.workImag, false)
    const offset = this.historyPos * N
    this.historyRealL.set(this.workReal, offset)
    this.historyImagL.set(this.workImag, offset)
    if (!common) {
      if (!this.historyRealR || !this.historyImagR) {
        this.historyRealR = this.historyRealL.slice()
        this.historyImagR = this.historyImagL.slice()
      }
      this.workReal.set(this.inputR)
      this.workReal.fill(0, L)
      this.workImag.fill(0)
      fft(this.workReal, this.workImag, false)
      this.historyRealR.set(this.workReal, offset)
      this.historyImagR.set(this.workImag, offset)
    } else if (this.historyRealR && this.historyImagR) {
      this.historyRealR.set(this.workReal, offset)
      this.historyImagR.set(this.workImag, offset)
    }
    this.renderEar(this.irRealL, this.irImagL, this.historyRealL, this.historyImagL, this.pendingL, this.overlapL)
    this.renderEar(this.irRealR, this.irImagR,
      this.historyRealR ?? this.historyRealL, this.historyImagR ?? this.historyImagL, this.pendingR, this.overlapR)
    this.historyPos = (this.historyPos + 1) % this.partitions
  }

  private renderEar(irReal: AudioBuffer, irImag: AudioBuffer,
    histReal: AudioBuffer, histImag: AudioBuffer, pending: AudioBuffer, overlap: AudioBuffer): void {
    const N = this.fftSize
    const sumReal = this.sumReal, sumImag = this.sumImag
    sumReal.fill(0)
    sumImag.fill(0)
    let history = this.historyPos
    for (let p = 0; p < this.partitions; p++) {
      const h = p * N
      const x = history * N
      for (let k = 0; k < N; k++) {
        const xr = histReal[x + k]
        const xi = histImag[x + k]
        const hr = irReal[h + k]
        const hi = irImag[h + k]
        sumReal[k] += xr * hr - xi * hi
        sumImag[k] += xr * hi + xi * hr
      }
      if (--history < 0) history = this.partitions - 1
    }
    this.workReal.set(sumReal)
    this.workImag.set(sumImag)
    fft(this.workReal, this.workImag, true)
    for (let i = 0; i < this.partitionSize; i++) {
      pending[i] = overlap[i] + this.workReal[i]
      overlap[i] = this.workReal[this.partitionSize + i]
    }
  }

  reset(): void {
    if (this.morphBlocks) {
      this.irRealL.set(this.targetRealL); this.irImagL.set(this.targetImagL)
      this.irRealR.set(this.targetRealR); this.irImagR.set(this.targetImagR)
      this.morphBlocks = 0
    }
    this.historyPos = 0
    this.inputPos = 0
    this.outputDelayPos = 0
    this.outputDelayL.fill(0)
    this.outputDelayR.fill(0)
    this.historyRealL.fill(0)
    this.historyImagL.fill(0)
    this.historyRealR?.fill(0)
    this.historyImagR?.fill(0)
    this.inputL.fill(0)
    this.inputR.fill(0)
    this.pendingL.fill(0)
    this.pendingR.fill(0)
    this.overlapL.fill(0)
    this.overlapR.fill(0)
  }
}
