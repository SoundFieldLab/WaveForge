/**
 * roomSim —— 完整房间模拟（规划书 §4.5：镜像声源法早期反射 1-3 阶 + FDN 晚期混响）
 *
 * 镜像源边界、方向性早期反射与 FDN 能量归一化已调整；Rust 侧须同步后再做数值对拍。
 * 原 Rust 侧 rust/hrtf-core/src/lib.rs 的 RoomState 算法约定：
 *   - 预设参数表 ROOM_PRESETS 与 Rust 侧 ROOM_PRESETS 完全一致（改一处必须同步另一处）；
 *   - 镜像声源枚举沿用逐轴逐阶顺序；反射延迟是镜像与直达路程差，
 *     增益按声压距离比修正，并从镜像方向 HRIR 提取双耳能量与到达时间；
 *   - FDN 一致：8 条质数延迟线（按 fs 缩放）、Hadamard 8×8/√8 正交反馈矩阵、
 *     每线 4000Hz 阻尼一阶低通、反馈增益 g = 10^(-3·delay_sec/rt60)（Schroeder 公式）；
 *   - 全程 f64 中间量 + f32 存储（Math.fround 显式舍入），与 Rust 侧 f32 写回语义一致。
 *
 * 信号流：每 speaker 的吸收/距离后的声源分别进入直达 HRTF 和镜像反射。
 *   反射抽头按镜像方向独立设置左右耳能量与到达时间，并与直达卷积延迟对齐；
 *   湿总线（N 个 speaker 湿路和）→ FDN 输入（/N，八路 I/O 各乘 1/√8）→ 输出混回湿总线；
 *   wet = wetSum + roomAmount·(earlyBus + fdnOut)，最终干湿混合
 *   out = ((1−amount)·dry + amount·wet)·masterGain。
 * room=off、无扬声器或初始 roomAmount≤0 全旁路；热更新至 0 则先平滑退场。
 *
 * 热路径（early/lateAndMix）：稳态零分配（scratch 按需扩容）。
 * 确定性：同输入同配置必同输出（无随机、无时间依赖）。
 */

import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from '../dsp/audioBuffer'
import type { ListenerState, RoomPreset, VirtualSpeaker } from './types'
import { computeRelativeDirection } from './controller'

/** 声速（m/s；与 Rust 侧 DOPPLER_C 一致） */
const SPEED_OF_SOUND = 343
/** 度 → 弧度（f64） */
const DEG2RAD = Math.PI / 180
/** 早期反射一阶低通截止基准（Hz）：fc = 8000/(1+阶)，高频吸收随反射次数（与 Rust 侧一致） */
const EARLY_LP_FC_BASE = 8000
/** FDN 阻尼低通截止（Hz，每线相同；与 Rust 侧 FDN_LP_FC 一致） */
const FDN_LP_FC = 4000
/** FDN 质数延迟（样本 @48kHz；按 fs 缩放后四舍五入；与 Rust 侧 FDN_PRIMES 一致） */
const FDN_PRIMES = [179, 211, 251, 307, 359, 419, 467, 521]
/** 八路 FDN 输入/输出用单位范数向量耦合；反馈矩阵本身已正交归一。 */
const FDN_IO_GAIN = 1 / Math.sqrt(FDN_PRIMES.length)
const FAST_EARLY_BLOCK = 128

/** 房间预设参数（与 Rust 侧 ROOM_PRESETS 元组同值——改一处必须同步另一处） */
export interface RoomPresetParams {
  width: number
  height: number
  depth: number
  /** 反射系数（0..1，逐次反射乘一次） */
  reflectivity: number
  /** 混响时间（秒，FDN 反馈增益基准） */
  rt60: number
}

/** 预设参数表（studio/hall/stage/church/outdoor/bathroom/corridor；与 Rust 侧 ROOM_PRESETS 完全一致） */
export const ROOM_PRESETS: Record<Exclude<RoomPreset, 'off'>, RoomPresetParams> = {
  studio: { width: 5, height: 3, depth: 4, reflectivity: 0.25, rt60: 0.45 }, // 录音棚：小空间短尾
  hall: { width: 25, height: 12, depth: 18, reflectivity: 0.6, rt60: 2.2 }, // 音乐厅：大空间长尾
  stage: { width: 18, height: 8, depth: 14, reflectivity: 0.5, rt60: 1.4 }, // 舞台：纵深宽声场
  church: { width: 30, height: 18, depth: 40, reflectivity: 0.75, rt60: 4.5 }, // 教堂：超长尾
  outdoor: { width: 80, height: 30, depth: 60, reflectivity: 0.15, rt60: 1.2 }, // 户外：弱反射、长延迟
  bathroom: { width: 2.5, height: 2.6, depth: 2.2, reflectivity: 0.9, rt60: 1.8 }, // 浴室：瓷砖高反射
  corridor: { width: 2.2, height: 2.8, depth: 18, reflectivity: 0.5, rt60: 1.6 }, // 走廊：窄长通道
}

/** 房间几何/混响参数（null = 旁路） */
export interface RoomSimParams {
  width: number
  height: number
  depth: number
  reflectivity: number
  /** 早期反射阶数（0..3；0 = 关闭早期反射，只保留 FDN） */
  earlyOrders: number
  rt60: number
  /** 完整镜像方向 HRIR；默认 false 保持轻量时间/能量线索模式。 */
  spectralEarly?: boolean
}

/** 预设 → 房间参数（off → null；earlyOrders 为早期反射阶数，预设默认 2） */
export function roomParamsFromPreset(preset: RoomPreset, earlyOrders: number, scale = 1): RoomSimParams | null {
  if (preset === 'off') return null
  const p = (ROOM_PRESETS as Record<string, RoomPresetParams>)[preset]
  if (!p || !Number.isFinite(p.width) || !Number.isFinite(p.depth)) return null
  const size = Number.isFinite(scale) ? Math.max(0.5, Math.min(2, scale)) : 1
  return { width: p.width * size, height: p.height * size, depth: p.depth * size,
    reflectivity: p.reflectivity, earlyOrders, rt60: p.rt60 * Math.sqrt(size) }
}

/** 镜像声源早期反射抽头：几何延迟/损耗共用，双耳方向线索与低通状态独立。 */
interface EarlyTap {
  /** 输入已受直达距离衰减；增益为反射损耗 × 镜像/直达振幅距离比。 */
  gain: number
  /** 镜像方向的左右耳总延迟（直达卷积延迟 + 几何差 + HRIR 到达时间）与能量。 */
  delayL: number
  delayR: number
  earGainL: number
  earGainR: number
  /** 配置时预乘的双耳反射增益，热路径少一次乘法。 */
  mixGainL: number
  mixGainR: number
  /** 一阶低通系数 a = exp(-2π·fc/fs)，fc = 8000/(1+阶)（f32 存储） */
  lpCoef: number
  oneMinusLp: number
  lpStateL: number
  lpStateR: number
}

/** 房间反射只需要 HRIR 的双耳能量与主峰样本位置。 */
export interface RoomHrirCues {
  peakL: number
  peakR: number
  energyL: number
  energyR: number
}

/**
 * 每扬声器早期反射状态（setConfig 时重建，fresh 零状态）。
 * 双耳**各用独立写指针**（histPosL/histPosR）——若共享指针，两耳 pass 在
 * 块边界交错会导致各自历史环出现永久空洞（某些位置从未被本耳写过，读到陈旧
 * 零值），早期总线输出将与块长相关；独立指针下每耳环随时间连续覆盖，
 * 延迟读与块长无关（与 Rust 侧 SpeakerRoomState 一致）。
 */
interface SpeakerRoomState {
  histL: AudioBuffer
  histR: AudioBuffer
  histPosL: number
  histPosR: number
  taps: EarlyTap[]
  minDelay: number
  spectral?: ReflectionConvolver
}

/**
 * 控制线程准备的反射卷积数据；所有数组可 structuredClone / Transferable。
 * headL/headR 是前 128 抽头 FIR 系数（HRIR 数据，保持 Float32）；频谱、历史、
 * 输入/待发/重叠、FFT 工作缓冲跟随 precision（float64 时为 Float64Array）；
 * sumReal/sumImag 恒为 Float64Array 累加。
 */
export interface PreparedReflectionConvolver {
  /** 频谱与信号缓冲精度；接收端据此校验并沿用。 */
  precision: Precision
  partitionCount: number
  headL: Float32Array
  headR: Float32Array
  headStart: number
  headEnd: number
  activePartitions: Int32Array
  irRealL: AudioBuffer
  irImagL: AudioBuffer
  irRealR: AudioBuffer
  irImagR: AudioBuffer
  historyRealL: AudioBuffer
  historyImagL: AudioBuffer
  historyRealR: AudioBuffer
  historyImagR: AudioBuffer
  headHistoryL: AudioBuffer
  headHistoryR: AudioBuffer
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
  fftTwiddles: Float64Array
}

export interface PreparedRoomEarly {
  /** 包含采样率、几何、姿态、房间参数与直达延迟；接管时严格匹配。 */
  signature: string
  speakers: Array<PreparedReflectionConvolver | null>
}

/** 缓冲类型是否与精度匹配（避免跨精度复用 f32/f64 数组）。 */
function sameBufferKind(buffer: AudioBuffer, precision: Precision): boolean {
  return precision === 'float64' ? buffer instanceof Float64Array : buffer instanceof Float32Array
}

const REFLECTION_PARTITION = 128
const REFLECTION_FFT = REFLECTION_PARTITION * 2

/** 接收路径只校验结构和头部有限值；完整频谱数值由受信任的控制线程生成。 */
function validPreparedReflection(value: unknown, expectedPrecision?: Precision): value is PreparedReflectionConvolver {
  if (!value || typeof value !== 'object') return false
  const data = value as PreparedReflectionConvolver
  const precision = normalizePrecision(data.precision)
  if (expectedPrecision !== undefined && precision !== expectedPrecision) return false
  const count = data.partitionCount
  if (!Number.isInteger(count) || count < 0 || count > 32768 ||
    !Number.isInteger(data.headStart) || !Number.isInteger(data.headEnd) ||
    data.headStart < 0 || data.headStart > REFLECTION_PARTITION ||
    data.headEnd < 0 || data.headEnd > REFLECTION_PARTITION) return false
  if (!(data.headL instanceof Float32Array) || !(data.headR instanceof Float32Array) ||
    data.headL.length !== REFLECTION_PARTITION || data.headR.length !== REFLECTION_PARTITION) return false
  for (let i = 0; i < REFLECTION_PARTITION; i++)
    if (!Number.isFinite(data.headL[i]) || !Number.isFinite(data.headR[i])) return false
  if (!(data.activePartitions instanceof Int32Array) || data.activePartitions.length > count) return false
  let previous = -1
  for (const partition of data.activePartitions) {
    if (partition <= previous || partition >= count) return false
    previous = partition
  }
  const spectralLength = count * REFLECTION_FFT
  // 接收校验不创建临时 buffer 列表；尺寸与有限值校验范围保持不变。
  if (!bufferLength(data.irRealL, spectralLength, precision) || !bufferLength(data.irImagL, spectralLength, precision) ||
    !bufferLength(data.irRealR, spectralLength, precision) || !bufferLength(data.irImagR, spectralLength, precision) ||
    !bufferLength(data.historyRealL, spectralLength, precision) || !bufferLength(data.historyImagL, spectralLength, precision) ||
    !bufferLength(data.historyRealR, spectralLength, precision) || !bufferLength(data.historyImagR, spectralLength, precision) ||
    !bufferLength(data.headHistoryL, REFLECTION_PARTITION, precision) || !bufferLength(data.headHistoryR, REFLECTION_PARTITION, precision) ||
    !bufferLength(data.inputL, REFLECTION_PARTITION, precision) || !bufferLength(data.inputR, REFLECTION_PARTITION, precision) ||
    !bufferLength(data.pendingL, REFLECTION_PARTITION, precision) || !bufferLength(data.pendingR, REFLECTION_PARTITION, precision) ||
    !bufferLength(data.overlapL, REFLECTION_PARTITION, precision) || !bufferLength(data.overlapR, REFLECTION_PARTITION, precision)) return false
  if (!bufferLength(data.workReal, REFLECTION_FFT, precision) ||
    !bufferLength(data.workImag, REFLECTION_FFT, precision) ||
    !(data.sumReal instanceof Float64Array) || data.sumReal.length !== REFLECTION_FFT ||
    !(data.sumImag instanceof Float64Array) || data.sumImag.length !== REFLECTION_FFT ||
    !(data.fftTwiddles instanceof Float64Array) || data.fftTwiddles.length !== 2 * (REFLECTION_FFT - 1)) return false
  for (let i = 0; i < data.fftTwiddles.length; i++) if (!Number.isFinite(data.fftTwiddles[i])) return false
  return true
}

function bufferLength(value: unknown, length: number, precision: Precision): boolean {
  return precision === 'float64'
    ? value instanceof Float64Array && value.length === length
    : value instanceof Float32Array && value.length === length
}

function freshReflectionBuffers(partitionCount: number, precision: Precision) {
  const length = partitionCount * REFLECTION_FFT
  return {
    historyRealL: allocBuffer(length, precision), historyImagL: allocBuffer(length, precision),
    historyRealR: allocBuffer(length, precision), historyImagR: allocBuffer(length, precision),
    headHistoryL: allocBuffer(REFLECTION_PARTITION, precision), headHistoryR: allocBuffer(REFLECTION_PARTITION, precision),
    inputL: allocBuffer(REFLECTION_PARTITION, precision), inputR: allocBuffer(REFLECTION_PARTITION, precision),
    pendingL: allocBuffer(REFLECTION_PARTITION, precision), pendingR: allocBuffer(REFLECTION_PARTITION, precision),
    overlapL: allocBuffer(REFLECTION_PARTITION, precision), overlapR: allocBuffer(REFLECTION_PARTITION, precision),
    workReal: allocBuffer(REFLECTION_FFT, precision), workImag: allocBuffer(REFLECTION_FFT, precision),
    sumReal: new Float64Array(REFLECTION_FFT), sumImag: new Float64Array(REFLECTION_FFT),
  }
}

/** 分区 FFT 因子一并转移，接收线程首次 FFT 也不触发模块缓存分配。 */
function reflectionTwiddles(): Float64Array {
  const result = new Float64Array(2 * (REFLECTION_FFT - 1))
  let offset = 0
  for (let size = 2; size <= REFLECTION_FFT; size *= 2) {
    for (let i = 0; i < size / 2; i++) {
      result[offset++] = Math.cos(2 * Math.PI * i / size)
      result[offset++] = Math.sin(2 * Math.PI * i / size)
    }
  }
  return result
}

/** 固定 256 点原位 radix-2 FFT；所有工作区及因子均由准备数据提供。 */
function reflectionFft(real: AudioBuffer, imag: AudioBuffer, inverse: boolean, twiddles: Float64Array): void {
  const n = REFLECTION_FFT
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const r = real[i], m = imag[i]
      real[i] = real[j]; imag[i] = imag[j]; real[j] = r; imag[j] = m
    }
  }
  let offset = 0
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2
    for (let base = 0; base < n; base += size) {
      for (let k = 0; k < half; k++) {
        const wr = twiddles[offset + k * 2], wi = twiddles[offset + k * 2 + 1] * (inverse ? 1 : -1)
        const a = base + k, b = a + half
        const vr = real[b] * wr - imag[b] * wi, vi = real[b] * wi + imag[b] * wr
        const ur = real[a], ui = imag[a]
        real[a] = ur + vr; imag[a] = ui + vi; real[b] = ur - vr; imag[b] = ui - vi
      }
    }
    offset += size
  }
  if (inverse) for (let i = 0; i < n; i++) { real[i] /= n; imag[i] /= n }
}

/**
 * 聚合 FIR 的前 128 样本直接卷积 + 稀疏均匀分区尾部。
 * 尾部先剥掉 128 样本，再由一个分区的调度延迟补回，故无额外算法延迟。
 * 处理量与聚合 IR 长度有关，不按每个镜像反射重复 HRIR 卷积。
 */
class ReflectionConvolver {
  private inputPos = 0
  private historyPos = 0
  /** 跨任意调用块边界保留该 FFT 输入分区是否逐样本相同。 */
  private identicalInput = true
  constructor(private readonly data: PreparedReflectionConvolver) {}

  getPrecision(): Precision {
    return normalizePrecision(this.data.precision)
  }

  /**
   * 切换反射卷积精度（幂等）：频谱按元素转换、信号/工作缓冲按新精度重建并 reset。
   * 已接管数据在回调路径上不再重跑 IR FFT；滤波器语义不变。
   */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.getPrecision()) return
    const d = this.data
    const convert = (buffer: AudioBuffer): AudioBuffer => {
      if (next === 'float64') return buffer instanceof Float64Array ? buffer : Float64Array.from(buffer)
      return buffer instanceof Float32Array ? buffer : Float32Array.from(buffer)
    }
    d.precision = next
    d.irRealL = convert(d.irRealL); d.irImagL = convert(d.irImagL)
    d.irRealR = convert(d.irRealR); d.irImagR = convert(d.irImagR)
    const fresh = freshReflectionBuffers(d.partitionCount, next)
    d.historyRealL = fresh.historyRealL; d.historyImagL = fresh.historyImagL
    d.historyRealR = fresh.historyRealR; d.historyImagR = fresh.historyImagR
    d.headHistoryL = fresh.headHistoryL; d.headHistoryR = fresh.headHistoryR
    d.inputL = fresh.inputL; d.inputR = fresh.inputR
    d.pendingL = fresh.pendingL; d.pendingR = fresh.pendingR
    d.overlapL = fresh.overlapL; d.overlapR = fresh.overlapR
    d.workReal = fresh.workReal; d.workImag = fresh.workImag
    d.sumReal = fresh.sumReal; d.sumImag = fresh.sumImag
    this.reset()
  }

  static fromIR(left: Float32Array, right: Float32Array, precision: Precision = 'float32'): ReflectionConvolver {
    const L = REFLECTION_PARTITION, N = REFLECTION_FFT
    const count = Math.max(0, Math.ceil((Math.max(left.length, right.length) - L) / L))
    const p = normalizePrecision(precision)
    const data: PreparedReflectionConvolver = {
      precision: p,
      partitionCount: count,
      headL: new Float32Array(L), headR: new Float32Array(L), headStart: L, headEnd: 0,
      activePartitions: new Int32Array(0),
      irRealL: allocBuffer(count * N, p), irImagL: allocBuffer(count * N, p),
      irRealR: allocBuffer(count * N, p), irImagR: allocBuffer(count * N, p),
      fftTwiddles: reflectionTwiddles(),
      ...freshReflectionBuffers(count, p),
    }
    data.headL.set(left.subarray(0, L)); data.headR.set(right.subarray(0, L))
    for (let j = 0; j < L; j++) {
      if (data.headL[j] !== 0 || data.headR[j] !== 0) {
        data.headStart = Math.min(data.headStart, j); data.headEnd = j + 1
      }
    }
    const active: number[] = []
    for (let p = 0; p < count; p++) {
      let nonzero = false
      for (let ear = 0; ear < 2; ear++) {
        const ir = ear === 0 ? left : right
        const real = ear === 0 ? data.irRealL : data.irRealR
        const imag = ear === 0 ? data.irImagL : data.irImagR
        data.workReal.fill(0); data.workImag.fill(0)
        for (let j = 0; j < L; j++) {
          const value = ir[L + p * L + j] ?? 0
          data.workReal[j] = value
          if (value !== 0) nonzero = true
        }
        reflectionFft(data.workReal, data.workImag, false, data.fftTwiddles)
        real.set(data.workReal, p * N); imag.set(data.workImag, p * N)
      }
      if (nonzero) active.push(p)
    }
    data.activePartitions = Int32Array.from(active)
    return new ReflectionConvolver(data)
  }

  createTransfer(): PreparedReflectionConvolver {
    const d = this.data
    const precision = this.getPrecision()
    return {
      precision,
      partitionCount: d.partitionCount, headStart: d.headStart, headEnd: d.headEnd,
      headL: d.headL.slice(), headR: d.headR.slice(), activePartitions: d.activePartitions.slice(),
      irRealL: d.irRealL.slice(), irImagL: d.irImagL.slice(),
      irRealR: d.irRealR.slice(), irImagR: d.irImagR.slice(),
      fftTwiddles: d.fftTwiddles.slice(),
      ...freshReflectionBuffers(d.partitionCount, precision),
    }
  }

  /** 移动时保留已输入的历史和待发尾部；环长变化按“距最新块的年龄”搬迁。 */
  carryStateFrom(previous: ReflectionConvolver): void {
    // 精度切换本身会 reset；跨精度不搬运历史（值语义不同，避免无意义截断）。
    if (previous.getPrecision() !== this.getPrecision()) { this.reset(); return }
    const d = this.data, old = previous.data, N = REFLECTION_FFT
    this.inputPos = previous.inputPos
    this.identicalInput = previous.identicalInput
    d.headHistoryL.set(old.headHistoryL); d.headHistoryR.set(old.headHistoryR)
    d.inputL.set(old.inputL); d.inputR.set(old.inputR)
    if (d.partitionCount > 0) {
      d.pendingL.set(old.pendingL); d.pendingR.set(old.pendingR)
      d.overlapL.set(old.overlapL); d.overlapR.set(old.overlapR)
      for (let age = 1; age <= Math.min(d.partitionCount, old.partitionCount); age++) {
        const from = ((previous.historyPos - age + old.partitionCount) % old.partitionCount) * N
        const to = ((this.historyPos - age + d.partitionCount) % d.partitionCount) * N
        d.historyRealL.set(old.historyRealL.subarray(from, from + N), to)
        d.historyImagL.set(old.historyImagL.subarray(from, from + N), to)
        d.historyRealR.set(old.historyRealR.subarray(from, from + N), to)
        d.historyImagR.set(old.historyImagR.subarray(from, from + N), to)
      }
    }
  }

  process(left: AudioBuffer, right: AudioBuffer, outL: AudioBuffer, outR: AudioBuffer, n: number): void {
    const d = this.data, L = REFLECTION_PARTITION
    for (let i = 0; i < n; i++) {
      const at = this.inputPos
      d.headHistoryL[at] = d.inputL[at] = left[i]
      d.headHistoryR[at] = d.inputR[at] = right[i]
      if (left[i] !== right[i]) this.identicalInput = false
      let valueL = d.pendingL[at], valueR = d.pendingR[at]
      for (let h = d.headStart; h < d.headEnd; h++) {
        const read = (at - h) & (L - 1)
        valueL += d.headL[h] * d.headHistoryL[read]
        valueR += d.headR[h] * d.headHistoryR[read]
      }
      outL[i] += valueL; outR[i] += valueR
      if (++this.inputPos === L) {
        if (d.partitionCount > 0) {
          this.processPartition(0); this.processPartition(1)
          if (++this.historyPos === d.partitionCount) this.historyPos = 0
        }
        this.inputPos = 0
        this.identicalInput = true
      }
    }
  }

  private processPartition(ear: number): void {
    const d = this.data, L = REFLECTION_PARTITION, N = REFLECTION_FFT
    const input = ear === 0 ? d.inputL : d.inputR
    const historyReal = ear === 0 ? d.historyRealL : d.historyRealR
    const historyImag = ear === 0 ? d.historyImagL : d.historyImagR
    const irReal = ear === 0 ? d.irRealL : d.irRealR, irImag = ear === 0 ? d.irImagL : d.irImagR
    const pending = ear === 0 ? d.pendingL : d.pendingR, overlap = ear === 0 ? d.overlapL : d.overlapR
    const offset = this.historyPos * N
    if (ear === 1 && this.identicalInput) {
      // 后端的单声源双耳输入通常相同；只复用输入 FFT，左右 IR 仍独立完整卷积。
      // 左耳已写入本分区历史；逐项拷贝避免实时创建 subarray 视图。
      for (let k = 0; k < N; k++) {
        historyReal[offset + k] = d.historyRealL[offset + k]
        historyImag[offset + k] = d.historyImagL[offset + k]
      }
    } else {
      d.workReal.fill(0); d.workImag.fill(0); d.workReal.set(input)
      reflectionFft(d.workReal, d.workImag, false, d.fftTwiddles)
      historyReal.set(d.workReal, offset); historyImag.set(d.workImag, offset)
    }
    d.sumReal.fill(0); d.sumImag.fill(0)
    for (let a = 0; a < d.activePartitions.length; a++) {
      const p = d.activePartitions[a]
      const historyOffset = ((this.historyPos - p + d.partitionCount) % d.partitionCount) * N
      const irOffset = p * N
      for (let k = 0; k < N; k++) {
        const xr = historyReal[historyOffset + k], xi = historyImag[historyOffset + k]
        const hr = irReal[irOffset + k], hi = irImag[irOffset + k]
        d.sumReal[k] += xr * hr - xi * hi
        d.sumImag[k] += xr * hi + xi * hr
      }
    }
    d.workReal.set(d.sumReal); d.workImag.set(d.sumImag)
    reflectionFft(d.workReal, d.workImag, true, d.fftTwiddles)
    for (let j = 0; j < L; j++) {
      pending[j] = d.workReal[j] + overlap[j]
      overlap[j] = d.workReal[j + L]
    }
  }

  reset(): void {
    const d = this.data
    d.historyRealL.fill(0); d.historyImagL.fill(0); d.historyRealR.fill(0); d.historyImagR.fill(0)
    d.headHistoryL.fill(0); d.headHistoryR.fill(0); d.inputL.fill(0); d.inputR.fill(0)
    d.pendingL.fill(0); d.pendingR.fill(0); d.overlapL.fill(0); d.overlapR.fill(0)
    this.inputPos = this.historyPos = 0
    this.identicalInput = true
  }
}

interface SpectralReflection { delay: number; gain: number; pole: number; left: Float32Array; right: Float32Array }

/** 配置路径：把每个 HRIR 与墙面低通卷积后累加，不裁掉 HRIR 的负瓣或共同延迟。 */
function aggregateReflections(reflections: SpectralReflection[], precision: Precision): ReflectionConvolver {
  let length = 1
  for (const reflection of reflections) {
    const tail = Math.ceil(Math.log(1e-8) / Math.log(reflection.pole))
    length = Math.max(length, reflection.delay + Math.max(reflection.left.length, reflection.right.length) + tail)
  }
  const left = new Float32Array(length), right = new Float32Array(length)
  for (const reflection of reflections) {
    for (let ear = 0; ear < 2; ear++) {
      const hrir = ear === 0 ? reflection.left : reflection.right, output = ear === 0 ? left : right
      const tail = Math.ceil(Math.log(1e-8) / Math.log(reflection.pole))
      let state = 0
      for (let h = 0; h < hrir.length + tail; h++) {
        state = (1 - reflection.pole) * (hrir[h] ?? 0) + reflection.pole * state
        output[reflection.delay + h] += reflection.gain * state
      }
    }
  }
  return ReflectionConvolver.fromIR(left, right, precision)
}

/** 几何更新时按“距离当前写指针的样本龄”搬迁历史，延迟语义不依赖环长。 */
function carryHistory(oldRing: AudioBuffer, oldPos: number, nextRing: AudioBuffer): number {
  if (oldRing.length >= nextRing.length) return oldPos
  const count = Math.min(oldRing.length, nextRing.length)
  for (let age = 1; age <= count; age++) {
    const oldIndex = (oldPos - age + oldRing.length) % oldRing.length
    nextRing[nextRing.length - age] = oldRing[oldIndex]
  }
  return 0
}

/** FDN 晚期混响状态（每耳 8 条质数延迟线；setConfig 时重建，fresh 零状态） */
class FdnState {
  /** 反馈增益/阻尼系数是控制量（非信号路径），保持 Float32；延迟线与滤波状态跟随精度。 */
  private readonly targetGains = new Float32Array(8)
  private readonly alpha: number
  private precision: Precision
  readonly delays: number[]
  readonly gains: Float32Array
  readonly lpCoefs: Float32Array
  readonly linesL: AudioBuffer[] = []
  readonly linesR: AudioBuffer[] = []
  readonly posL: Int32Array
  readonly posR: Int32Array
  lpStateL: AudioBuffer
  lpStateR: AudioBuffer
  /** 八路正交反馈的输入与蝶形 scratch；无逐样本矩阵乘法。 */
  private readonly v = new Float64Array(8)
  private readonly feedback = new Float64Array(8)

  constructor(fs: number, rt60: number, precision: Precision = 'float32') {
    this.alpha = 1 - Math.exp(-1 / (fs * 0.02))
    this.precision = normalizePrecision(precision)
    const scale = fs / 48000
    this.delays = FDN_PRIMES.map((p) => Math.max(1, Math.round(p * scale)))
    this.gains = new Float32Array(8)
    this.lpCoefs = new Float32Array(8)
    for (let i = 0; i < 8; i++) {
      const d = this.delays[i]
      // 反馈增益（Schroeder 公式，注释公式）：g = 10^(-3·delay_sec/rt60)
      this.gains[i] = Math.pow(10, (-3 * (d / fs)) / rt60)
      this.targetGains[i] = this.gains[i]
      // 阻尼一阶低通：fc = 4000Hz（每线相同）
      this.lpCoefs[i] = Math.exp((-2 * Math.PI * FDN_LP_FC) / fs)
      this.linesL.push(allocBuffer(d, this.precision))
      this.linesR.push(allocBuffer(d, this.precision))
    }
    this.posL = new Int32Array(8)
    this.posR = new Int32Array(8)
    this.lpStateL = allocBuffer(8, this.precision)
    this.lpStateR = allocBuffer(8, this.precision)
  }

  getPrecision(): Precision {
    return this.precision
  }

  /** 切换 FDN 精度（幂等）：按新精度重建 8 条延迟线与低通状态并清零。 */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    for (let i = 0; i < 8; i++) {
      const d = this.delays[i]
      this.linesL[i] = allocBuffer(d, next)
      this.linesR[i] = allocBuffer(d, next)
    }
    this.lpStateL = allocBuffer(8, next)
    this.lpStateR = allocBuffer(8, next)
    this.posL.fill(0)
    this.posR.fill(0)
  }

  /**
   * 处理单样本（ear=0 左 / 1 右；input 为已除扬声器数的湿总线样本，f64）。
   * 每样本：①读各线输出 + 阻尼低通 ②矩阵混合 + 反馈写回
   * ③输出 = Σ 阻尼后线输出。输入和输出各乘 1/√8，防 8 路同相信号
   * 叠加时使晚期混响平白放大约 8 倍；此处需同步 Rust 实现后再对拍。
   */
  processSample(ear: number, input: number): number {
    const lines = ear === 0 ? this.linesL : this.linesR
    const pos = ear === 0 ? this.posL : this.posR
    const lpStates = ear === 0 ? this.lpStateL : this.lpStateR
    const v = this.v
    const drive = input * FDN_IO_GAIN
    // ① 读 + 阻尼
    for (let i = 0; i < 8; i++) {
      if (ear === 0) this.gains[i] += this.alpha * (this.targetGains[i] - this.gains[i])
      const p = pos[i]
      const read = lines[i][p]
      const a = this.lpCoefs[i]
      const lp = (1 - a) * read + a * lpStates[i]
      lpStates[i] = lp
      v[i] = lp
    }
    // ② 8 点快速 Hadamard 蝶形：三层、每层四对加减，等价于
    // H[i][k]=(-1)^popcount(i&k)，最后乘 1/√8 保持正交归一。
    const feedback = this.feedback
    // 固定八路展开；保持三层蝶形原来的加减顺序与 f64 中间精度。
    const a0 = v[0] + v[1], a1 = v[0] - v[1], a2 = v[2] + v[3], a3 = v[2] - v[3]
    const a4 = v[4] + v[5], a5 = v[4] - v[5], a6 = v[6] + v[7], a7 = v[6] - v[7]
    const b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3
    const b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7
    feedback[0] = b0 + b4; feedback[1] = b1 + b5; feedback[2] = b2 + b6; feedback[3] = b3 + b7
    feedback[4] = b0 - b4; feedback[5] = b1 - b5; feedback[6] = b2 - b6; feedback[7] = b3 - b7
    for (let i = 0; i < 8; i++) {
      const p = pos[i]
      lines[i][p] = drive + this.gains[i] * (feedback[i] * FDN_IO_GAIN)
      const np = p + 1
      pos[i] = np >= this.delays[i] ? 0 : np
    }
    // ③ 输出
    let out = 0
    for (let i = 0; i < 8; i++) out += v[i]
    return out * FDN_IO_GAIN
  }

  setRt60(fs: number, rt60: number): void {
    for (let i = 0; i < 8; i++) this.targetGains[i] = Math.pow(10, (-3 * this.delays[i] / fs) / rt60)
  }
}

/**
 * 某轴的镜像声源坐标（含该轴反射阶数）：轴上镜像坐标 = 2k·dim ± coord，
 * 按阶分组（顺序与 Rust 侧 axis_images 完全一致）：
 *   0 阶：[coord]（声源自身）；1 阶：[-coord, 2·dim−coord]（两壁各一次）；
 *   2 阶：[2·dim+coord, coord−2·dim]；3 阶：[4·dim−coord, −2·dim−coord]
 */
function axisImages(coord: number, dim: number, order: number): Array<[number, number]> {
  switch (order) {
    case 0:
      return [[coord, 0]]
    case 1:
      return [
        [-coord, 1],
        [2 * dim - coord, 1],
      ]
    case 2:
      return [
        [2 * dim + coord, 2],
        [coord - 2 * dim, 2],
      ]
    default:
      return [
        [4 * dim - coord, 3],
        [-2 * dim - coord, 3],
      ]
  }
}

/** 完整房间模拟（§4.5）：早期反射 + FDN。由后端 setConfig 时创建/重建（fresh 状态）。 */
export class RoomSim {
  private readonly spectralRequested: boolean
  private readonly earlySignature: string
  private fallbackReason: string | null = null
  private earlyAmount = 1
  private lateAmount = 1
  private earlyCur = 1
  private lateCur = 1
  private readonly directLatency: number
  /** 房间混合量（config.roomAmount；≤0 或 off 时旁路）——可变：签名不变复用实例时经
   *  setAmount 热更新（避免重建截断 FDN 混响尾），构造后由后端按配置维护 */
  private roomAmount: number
  /** 当前混合量；热更新按 20ms 平滑，避免整个反射/混响尾在滑块跳变时咔哒。 */
  private roomAmountCur: number
  private readonly amountCoef: number
  private readonly active: boolean
  private readonly speakerCount: number
  private readonly speakerChannels: number[]
  private readonly speakerIds: (string | undefined)[]
  private readonly speakerAzimuths: number[]
  private readonly speakerElevations: number[]
  private readonly speakerDistances: number[]
  private readonly states: SpeakerRoomState[] = []
  private readonly fdn: FdnState | null
  /** 内部精度：早期反射总线/历史环跟随空间后端精度；FDN 与完整谱反射内部仍为
   *  Float32（与 Rust 对拍契约的系数/尾音路径，见 HANDOVER 精度边界）。 */
  private precision: Precision
  /** 早期反射累加总线（每块零化，双耳；按需扩容，类型跟随精度） */
  private earlyL: AudioBuffer
  private earlyR: AudioBuffer

  constructor(fs: number, speakers: VirtualSpeaker[], params: RoomSimParams | null, roomAmount: number,
    hrirAt?: (azimuthDeg: number, elevationDeg: number) =>
      { left: Float32Array; right: Float32Array } | RoomHrirCues,
    directLatency = 0, previous?: RoomSim, reuseTaps = true, listener?: ListenerState, preparedEarly?: PreparedRoomEarly,
    precision: Precision = 'float32') {
    this.spectralRequested = params?.spectralEarly === true
    this.earlySignature = JSON.stringify([fs, speakers, params, directLatency, listener ?? null])
    this.precision = normalizePrecision(precision)
    const reuseEarly = previous && sameBufferKind(previous.earlyL, this.precision)
    this.earlyL = reuseEarly ? previous!.earlyL : allocBuffer(128, this.precision)
    this.earlyR = reuseEarly ? previous!.earlyR : allocBuffer(128, this.precision)
    this.directLatency = Math.max(0, Math.floor(directLatency))
    this.roomAmount = Math.min(1, Math.max(0, roomAmount))
    this.roomAmountCur = previous?.roomAmountCur ?? this.roomAmount
    this.amountCoef = 1 - Math.exp(-1 / (fs * 0.02))
    this.speakerCount = speakers.length
    this.speakerChannels = speakers.map(sp => sp.channel)
    this.speakerIds = speakers.map(sp => sp.id)
    this.speakerAzimuths = speakers.map(sp => Math.fround(sp.azimuthDeg))
    this.speakerElevations = speakers.map(sp => Math.fround(sp.elevationDeg))
    this.speakerDistances = speakers.map(sp => Math.fround(sp.distance))
    // room=off（params null）/ roomAmount≤0 / 无扬声器 → 全旁路（输出与无房间逐位一致）
    const active = params !== null && (roomAmount > 0 || previous?.active === true) && speakers.length > 0
    this.active = active
    if (!active) {
      this.fdn = null
      return
    }
    // 每扬声器镜像声源抽头：听者位于房间中心；声源位置 = 中心 + 距离·方位单位向量
    // （dir 与多普勒 dopplerRate 同构：f32 方位角量化后 f64 计算，显式归一化）
    const cx = listener ? Math.max(0.01, Math.min(params.width - 0.01, params.width / 2 + listener.position.x)) : params.width / 2
    const cy = listener ? Math.max(0.01, Math.min(params.height - 0.01, listener.position.y)) : params.height / 2
    const cz = listener ? Math.max(0.01, Math.min(params.depth - 0.01, params.depth / 2 + listener.position.z)) : params.depth / 2
    const orders = params.earlyOrders
    for (let speakerIndex = 0; speakerIndex < speakers.length; speakerIndex++) {
      const sp = speakers[speakerIndex]
      const old = previous?.states[speakerIndex]
      const candidate = preparedEarly?.signature === this.earlySignature && Array.isArray(preparedEarly.speakers)
        ? preparedEarly.speakers[speakerIndex] : undefined
      const prepared = validPreparedReflection(candidate, this.precision) ? candidate : undefined
      if (candidate && !prepared) this.fallbackReason = '预计算反射数据结构无效，已回退本地重新准备。'
      if (this.spectralRequested && prepared) {
        this.states.push({
          histL: allocBuffer(0, this.precision), histR: allocBuffer(0, this.precision), histPosL: 0, histPosR: 0,
          taps: [], minDelay: Infinity, spectral: new ReflectionConvolver(prepared),
        })
        continue
      }
      if (reuseTaps && old && previous.spectralRequested === this.spectralRequested && previous.speakerChannels[speakerIndex] === this.speakerChannels[speakerIndex]
        && previous.speakerIds[speakerIndex] === this.speakerIds[speakerIndex]
        && previous.speakerAzimuths[speakerIndex] === this.speakerAzimuths[speakerIndex]
        && previous.speakerElevations[speakerIndex] === this.speakerElevations[speakerIndex]
        && previous.speakerDistances[speakerIndex] === this.speakerDistances[speakerIndex]) {
        // The room geometry for this source is unchanged; retain its reflection taps,
        // history ring, and filter state without rebuilding the image-source set.
        // 复用旧状态时保证反射卷积精度与当前房间一致（后端 setPrecision 已传播，
        // 此处防御构造顺序差异）。
        if (old.spectral && old.spectral.getPrecision() !== this.precision) old.spectral.setPrecision(this.precision)
        this.states.push(old)
        if (this.spectralRequested && !old.spectral) this.fallbackReason = previous.spectralFallbackReason
        continue
      }
      const azRad = Math.fround(sp.azimuthDeg) * DEG2RAD
      const elRad = Math.fround(sp.elevationDeg) * DEG2RAD
      const d0 = Math.cos(elRad) * Math.sin(azRad)
      const d1 = Math.sin(elRad)
      const d2 = Math.cos(elRad) * Math.cos(azRad)
      const dlen = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2)
      // 镜像声源法要求声源在房间内。世界漫游/舞台可把声源放到预设墙外，
      // 未钳位时镜像点甚至与听者重合（1/dist² → Infinity，湿路变为 NaN）。
      const sx = Math.min(params.width, Math.max(0, sp.roomPosition ? params.width / 2 + sp.roomPosition.x : cx + sp.distance * (d0 / dlen)))
      const sy = Math.min(params.height, Math.max(0, sp.roomPosition ? sp.roomPosition.y : cy + sp.distance * (d1 / dlen)))
      const sz = Math.min(params.depth, Math.max(0, sp.roomPosition ? params.depth / 2 + sp.roomPosition.z : cz + sp.distance * (d2 / dlen)))
      const directDistance = Math.hypot(sx - cx, sy - cy, sz - cz)
      const taps: EarlyTap[] = []
      const spectralReflections: SpectralReflection[] = []
      let spectralAvailable = this.spectralRequested && Boolean(hrirAt)
      if (this.spectralRequested && !hrirAt) this.fallbackReason = '缺少完整 HRIR 回调，已回退双耳时间/能量线索模式。'
      let maxDelay = 1
      const xImages: Array<Array<[number, number]>> = []
      const yImages: Array<Array<[number, number]>> = []
      const zImages: Array<Array<[number, number]>> = []
      for (let order = 0; order <= orders; order++) {
        xImages.push(axisImages(sx, params.width, order))
        yImages.push(axisImages(sy, params.height, order))
        zImages.push(axisImages(sz, params.depth, order))
      }
      // 逐轴逐阶嵌套枚举（顺序与 Rust 侧 build_speaker_room 完全一致）
      for (let ox = 0; ox <= orders; ox++) {
        const xs = xImages[ox]
        for (let xi = 0; xi < xs.length; xi++) {
          for (let oy = 0; oy <= orders; oy++) {
            const ys = yImages[oy]
            for (let yi = 0; yi < ys.length; yi++) {
              for (let oz = 0; oz <= orders; oz++) {
                const zs = zImages[oz]
                for (let zi = 0; zi < zs.length; zi++) {
                  const o = xs[xi][1] + ys[yi][1] + zs[zi][1]
                  if (o < 1 || o > orders) continue
                  const dx = xs[xi][0] - cx
                  const dy = ys[yi][0] - cy
                  const dz = zs[zi][0] - cz
                  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
                  // 直达路程已由上游 HRTF 输出体现；只加入反射多走的路程。
                  let delay = Math.floor(((dist - directDistance) * fs) / SPEED_OF_SOUND + 0.5)
                  if (delay < 1) delay = 1
                  if (delay > maxDelay) maxDelay = delay
                  // 声压随 1/r 衰减。上游湿声已经带直达距离增益，故以直达/镜像
                  // 路程比修正，避免再把反射按 1/r² 衰减一次。
                  let rp = 1
                  for (let k = 0; k < o; k++) rp *= params.reflectivity
                  const gain = rp * Math.max(1, directDistance) / Math.max(1, dist)
                  let delayL = 0, delayR = 0, earGainL = 1, earGainR = 1
                  let fullHrir: { left: Float32Array; right: Float32Array } | null = null
                  if (hrirAt) {
                    const relative = listener ? computeRelativeDirection({ ...listener, position: { x: 0, y: 0, z: 0 } }, { x: dx, y: dy, z: dz }) : null
                    const hrir = hrirAt(relative?.azimuthDeg ?? Math.atan2(dx, dz) / DEG2RAD,
                      relative?.elevationDeg ?? Math.atan2(dy, Math.hypot(dx, dz)) / DEG2RAD)
                    let peakL = 0, peakR = 0, energyL = 0, energyR = 0
                    if ('left' in hrir) {
                      if (this.spectralRequested && hrir.left.length > 0 && hrir.right.length > 0
                        && hrir.left.every(Number.isFinite) && hrir.right.every(Number.isFinite)) {
                        // 回调可复用 scratch；合成前必须保留该方向的独立 HRIR。
                        fullHrir = { left: hrir.left.slice(), right: hrir.right.slice() }
                      } else if (this.spectralRequested) {
                        spectralAvailable = false
                        this.fallbackReason = '镜像方向 HRIR 非法或为空，已回退双耳时间/能量线索模式。'
                      }
                      let maxL = -1, maxR = -1
                      for (let h = 0; h < Math.max(hrir.left.length, hrir.right.length); h++) {
                        const l = hrir.left[h] ?? 0, r = hrir.right[h] ?? 0
                        energyL += l * l
                        energyR += r * r
                        if (Math.abs(l) > maxL) { maxL = Math.abs(l); peakL = h }
                        if (Math.abs(r) > maxR) { maxR = Math.abs(r); peakR = h }
                      }
                    } else {
                      if (this.spectralRequested) {
                        spectralAvailable = false
                        this.fallbackReason = 'HRIR 回调只提供时间/能量线索，已回退快速模式；未执行完整频谱反射。'
                      }
                      peakL = hrir.peakL
                      peakR = hrir.peakR
                      energyL = hrir.energyL
                      energyR = hrir.energyR
                    }
                    const total = energyL + energyR
                    if (total > 0) {
                      earGainL = Math.sqrt(2 * energyL / total)
                      earGainR = Math.sqrt(2 * energyR / total)
                      // 保留测量 IR 的共同到达延迟：直达卷积也包含它，若两耳各减去
                      // 最早峰值，反射将比同一数据集中的直达路径系统性提前。
                      delayL = peakL
                      delayR = peakR
                    }
                  }
                  // 高频吸收随反射次数：fc = 8000/(1+阶) Hz
                  const fc = EARLY_LP_FC_BASE / (1 + o)
                  const lpCoef = Math.exp((-2 * Math.PI * fc) / fs)
                  if (fullHrir) spectralReflections.push({
                    delay: delay + this.directLatency, gain, pole: lpCoef, left: fullHrir.left, right: fullHrir.right,
                  })
                  delayL += delay + this.directLatency
                  delayR += delay + this.directLatency
                  const gainF = Math.fround(gain)
                  const earGainLF = Math.fround(earGainL)
                  const earGainRF = Math.fround(earGainR)
                  const lpCoefF = Math.fround(lpCoef)
                  taps.push({ gain: gainF, delayL, delayR,
                    earGainL: earGainLF, earGainR: earGainRF,
                    mixGainL: gainF * earGainLF, mixGainR: gainF * earGainRF,
                    lpCoef: lpCoefF, oneMinusLp: 1 - lpCoefF, lpStateL: 0, lpStateR: 0 })
                  maxDelay = Math.max(maxDelay, delayL, delayR)
                }
              }
            }
          }
        }
      }
      // 写入当前样本后再读取历史，环长必须比最大延迟多 1；相等时最远抽头会
      // 读回刚写入的位置，让最晚反射错误地在当拍出现。
      // 块写入先于抽头读取时，需留出整个实时量子的历史余量。
      const requiredHistory = maxDelay + FAST_EARLY_BLOCK + 1
      const reuseHistory = old && previous.speakerChannels[speakerIndex] === this.speakerChannels[speakerIndex]
        && previous.speakerIds[speakerIndex] === this.speakerIds[speakerIndex]
        && old.histL.length >= requiredHistory && sameBufferKind(old.histL, this.precision)
      // 新环预留 1.5× 余量：头姿态/听者微移只改变镜像源延迟时，历史环容量足够，
      // 后续配置帧直接复用旧环（实时配置帧不再逐次分配 Float32/Float64 数组）。
      const historyLength = reuseHistory ? old.histL.length
        : Math.max(requiredHistory, Math.ceil(requiredHistory * 1.5))
      this.states.push({
        histL: reuseHistory ? old.histL : allocBuffer(historyLength, this.precision),
        histR: reuseHistory ? old.histR : allocBuffer(historyLength, this.precision),
        histPosL: reuseHistory ? old.histPosL : 0,
        histPosR: reuseHistory ? old.histPosR : 0,
        taps,
        minDelay: taps.reduce((min, tap) => Math.min(min, tap.delayL, tap.delayR), Infinity),
        spectral: spectralAvailable ? aggregateReflections(spectralReflections, this.precision) : undefined,
      })
    }
    // 同一房间/采样率下，位置或反射阶数变化只重建镜像源几何；保留 FDN 尾音。
    // 扬声器输入绑定不变时也保留延迟历史与低通状态，移动中已发出的反射不会消失。
    if (previous?.active) {
      for (let s = 0; s < this.states.length; s++) {
        const old = previous.states[s]
        const next = this.states[s]
        if (!old || previous.speakerChannels[s] !== this.speakerChannels[s]
          || previous.speakerIds[s] !== this.speakerIds[s]) continue
        if (next.spectral && old.spectral && next.spectral !== old.spectral) next.spectral.carryStateFrom(old.spectral)
        if (old.histL.length >= next.histL.length && sameBufferKind(old.histL, this.precision)) {
          next.histL = old.histL
          next.histR = old.histR
          next.histPosL = old.histPosL
          next.histPosR = old.histPosR
        } else {
          next.histPosL = carryHistory(old.histL, old.histPosL, next.histL)
          next.histPosR = carryHistory(old.histR, old.histPosR, next.histR)
        }
        for (let t = 0; reuseTaps && t < Math.min(old.taps.length, next.taps.length); t++) {
          next.taps[t].lpStateL = old.taps[t].lpStateL
          next.taps[t].lpStateR = old.taps[t].lpStateR
        }
      }
    }
    this.fdn = previous?.fdn ?? new FdnState(fs, params.rt60, this.precision)
    // 复用上一实例的 FDN 时保证精度一致（后端 setPrecision 也会传播；此处防御）。
    if (this.fdn.getPrecision() !== this.precision) this.fdn.setPrecision(this.precision)
    this.fdn.setRt60(fs, params.rt60)
  }

  get earlyReflectionMode(): 'cues' | 'spectral' | 'mixed' {
    const spectral = this.states.filter(state => Boolean(state.spectral)).length
    return spectral === 0 ? 'cues' : spectral === this.states.length ? 'spectral' : 'mixed'
  }

  get spectralFallbackReason(): string | null { return this.fallbackReason }

  /** 控制线程调用；Worklet 构造时通过末尾 preparedEarly 接管，不重新合成 IR/FFT。 */
  createPreparedEarlyTransfer(): PreparedRoomEarly | undefined {
    if (!this.states.some(state => Boolean(state.spectral))) return undefined
    return { signature: this.earlySignature, speakers: this.states.map(state => state.spectral?.createTransfer() ?? null) }
  }

  /**
   * 热更新房间混合量（0..1 钳位）：房间签名（预设+扬声器几何+阶数）不变时由后端
   * 复用实例调用——重建会瞬间截断 FDN 混响尾与早期反射历史（可听突变）。
   * active 判定（构造时）不随 amount 热更新：off↔on 切换由后端重建实例表达。
   */
  setAmount(v: number): void {
    this.roomAmount = Math.min(1, Math.max(0, v))
  }

  /** 退场完成后可释放：-100dB 以下的混合量不再可听，后端避免持续计算零湿路。 */
  get isSilent(): boolean {
    return this.roomAmount === 0 && this.roomAmountCur < 1e-5
  }

  /** 当前内部精度（早期反射总线/历史环、FDN 延迟线、谱反射内部缓冲）。 */
  getPrecision(): Precision {
    return this.precision
  }

  /** 切换内部精度（幂等）：重建早期反射总线/历史环/FDN/谱反射缓冲并 reset。 */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    this.earlyL = allocBuffer(this.earlyL.length, next)
    this.earlyR = allocBuffer(this.earlyR.length, next)
    for (const state of this.states) {
      state.histL = allocBuffer(state.histL.length, next)
      state.histR = allocBuffer(state.histR.length, next)
      // 完整谱反射的分区卷积内部频谱/历史/工作/重叠缓冲同样跟随精度。
      state.spectral?.setPrecision(next)
    }
    // FDN 晚混响的 8 条延迟线与低通状态跟随精度。
    this.fdn?.setPrecision(next)
    this.reset()
  }

  /** 每块开始时零化早期总线（须早于任何 early() 调用；热路径零分配） */
  beginBlock(n: number): void {
    if (this.earlyL.length < n || !sameBufferKind(this.earlyL, this.precision)) {
      this.earlyL = allocBuffer(n, this.precision)
      this.earlyR = allocBuffer(n, this.precision)
    }
    this.earlyL.fill(0, 0, n)
    this.earlyR.fill(0, 0, n)
  }

  /**
   * 处理一个扬声器的早期反射（si = 扬声器索引；wetL/wetR = 卷积前的声源块，
   * 只读不修改）。每耳整块处理（各自独立写指针）：写历史环 → 逐抽头延迟读/
   * 低通/累加进早期总线。默认只提取时间/能量；spectralEarly 模式
   * 使用配置时聚合的完整双耳反射 IR，实时路径执行预分配分区卷积。
   */
  early(si: number, wetL: AudioBuffer, wetR: AudioBuffer, n: number): void {
    if (!this.active) return
    const st = this.states[si]
    if (st.spectral) { st.spectral.process(wetL, wetR, this.earlyL, this.earlyR, n); return }
    const maxD = st.histL.length
    const taps = st.taps
    const earlyL = this.earlyL
    const earlyR = this.earlyR
    if (n <= FAST_EARLY_BLOCK && st.minDelay >= n) {
      // 实时 128 样本块的反射均晚于当前块：先写整块历史，再按抽头顺序
      // 连续读取。每条抽头只取一次对象/状态，保留每个样本原来的累加顺序。
      const startL = st.histPosL
      const startR = st.histPosR
      let writeL = startL
      let writeR = startR
      for (let j = 0; j < n; j++) {
        st.histL[writeL] = wetL[j]
        st.histR[writeR] = wetR[j]
        if (++writeL >= maxD) writeL = 0
        if (++writeR >= maxD) writeR = 0
      }
      st.histPosL = writeL
      st.histPosR = writeR
      for (let t = 0; t < taps.length; t++) {
        const tap = taps[t]
        let readL = startL - tap.delayL
        let readR = startR - tap.delayR
        if (readL < 0) readL += maxD
        if (readR < 0) readR += maxD
        let stateL = tap.lpStateL
        let stateR = tap.lpStateR
        const a = tap.lpCoef
        const b = tap.oneMinusLp
        const gainL = tap.mixGainL
        const gainR = tap.mixGainR
        for (let j = 0; j < n; j++) {
          const lpL = b * st.histL[readL] + a * stateL
          const lpR = b * st.histR[readR] + a * stateR
          stateL = Math.fround(lpL)
          stateR = Math.fround(lpR)
          earlyL[j] += gainL * lpL
          earlyR[j] += gainR * lpR
          if (++readL >= maxD) readL = 0
          if (++readR >= maxD) readR = 0
        }
        tap.lpStateL = stateL
        tap.lpStateR = stateR
      }
      return
    }
    // 左耳整块（独立写指针 histPosL）
    let wp = st.histPosL
    const histL = st.histL
    for (let j = 0; j < n; j++) {
      const w = wetL[j]
      histL[wp] = w
      for (let t = 0; t < taps.length; t++) {
        const tap = taps[t]
        // 延迟读（历史环：写当前样本后回读 delay 前的样本）
        let readAt = wp - tap.delayL
        if (readAt < 0) readAt += maxD
        const read = histL[readAt]
        // 一阶低通（高频吸收随反射次数）：y = (1-a)·x + a·y[n-1]
        const lp = tap.oneMinusLp * read + tap.lpCoef * tap.lpStateL
        tap.lpStateL = Math.fround(lp)
        // 累加进早期总线（f32 存储，与 Rust 侧一致）
        earlyL[j] += tap.mixGainL * lp
      }
      wp++
      if (wp >= maxD) wp = 0
    }
    st.histPosL = wp
    // 右耳整块（独立写指针 histPosR）
    const histR = st.histR
    wp = st.histPosR
    for (let j = 0; j < n; j++) {
      const w = wetR[j]
      histR[wp] = w
      for (let t = 0; t < taps.length; t++) {
        const tap = taps[t]
        let readAt = wp - tap.delayR
        if (readAt < 0) readAt += maxD
        const read = histR[readAt]
        const lp = tap.oneMinusLp * read + tap.lpCoef * tap.lpStateR
        tap.lpStateR = Math.fround(lp)
        earlyR[j] += tap.mixGainR * lp
      }
      wp++
      if (wp >= maxD) wp = 0
    }
    st.histPosR = wp
  }

  /**
   * FDN 晚期混响 + 混合（就地改写 wetL/wetR，须在所有 speaker 的 early() 之后调用）：
   *   wet += roomAmount·(earlyBus + fdnOut)，fdn 输入 = 湿总线/N（N = 扬声器数）。
   * 两耳共用逐样本混合量平滑；FDN 的归一化与几何保护需同步 Rust 后再对拍。
   */
  setBalance(early: number, late: number): void {
    this.earlyAmount = Number.isFinite(early) ? Math.max(0, Math.min(1, early)) : 1
    this.lateAmount = Number.isFinite(late) ? Math.max(0, Math.min(1, late)) : 1
  }

  lateAndMix(wetL: AudioBuffer, wetR: AudioBuffer, n: number): void {
    if (!this.active || !this.fdn) return
    const roomAmount = this.roomAmount
    const ns = this.speakerCount
    const earlyL = this.earlyL
    const earlyR = this.earlyR
    let amount = this.roomAmountCur
    for (let j = 0; j < n; j++) {
      amount += this.amountCoef * (roomAmount - amount)
      const xL = wetL[j]
      const xR = wetR[j]
      const fdnL = this.fdn.processSample(0, xL / ns)
      const fdnR = this.fdn.processSample(1, xR / ns)
      this.earlyCur += this.amountCoef * (this.earlyAmount - this.earlyCur)
      this.lateCur += this.amountCoef * (this.lateAmount - this.lateCur)
      wetL[j] = xL + amount * (earlyL[j] * this.earlyCur + fdnL * this.lateCur)
      wetR[j] = xR + amount * (earlyR[j] * this.earlyCur + fdnR * this.lateCur)
    }
    this.roomAmountCur = amount
  }

  /** 清零流式状态（历史环/低通状态/FDN 延迟线与指针；参数保留） */
  reset(): void {
    this.earlyCur = this.earlyAmount; this.lateCur = this.lateAmount
    this.roomAmountCur = this.roomAmount
    for (const st of this.states) {
      st.spectral?.reset()
      st.histL.fill(0)
      st.histR.fill(0)
      st.histPosL = 0
      st.histPosR = 0
      for (const t of st.taps) {
        t.lpStateL = 0
        t.lpStateR = 0
      }
    }
    if (this.fdn) {
      for (let i = 0; i < 8; i++) {
        this.fdn.linesL[i].fill(0)
        this.fdn.linesR[i].fill(0)
      }
      this.fdn.posL.fill(0)
      this.fdn.posR.fill(0)
      this.fdn.lpStateL.fill(0)
      this.fdn.lpStateR.fill(0)
    }
  }
}