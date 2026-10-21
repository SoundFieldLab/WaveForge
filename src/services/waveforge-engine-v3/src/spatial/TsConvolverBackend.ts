/**
 * TsConvolverBackend —— 空间渲染 TS 参考后端（兼 Rust/WASM 数值对拍 ground truth）
 *
 * 分区模式每扬声器使用一枚 BinauralConvolver：左右耳共享相同声源块的输入
 * FFT/频域历史，分别应用 HRIR 并逆变换；右耳去相关时自动分离历史。
 * 时域模式仍用两枚 TimeConvolver，干湿混合在本 backend 层完成。
 * 干路：输入经卷积分区长度加实测 HRIR 主到达时间的环形延迟线；解析网格
 *   只延迟 512 样本。音乐模式限制湿声比例，降低 HRTF 相位造成的凹陷。
 *
 * 距离衰减模型（Rust 侧对拍基准，ref=1m、linear max=50m）：
 *   - inverse:      g = min(1, ref/max(d, ref))        —— 1m 内不衰减，之后 1/d；
 *   - linear:       g = max(0, 1-(d-ref)/(max-ref))    —— 1m 内不衰减，1..50m 线性到 0；
 *   - exponential:  g = pow(max(d,ref)/ref, -1)        —— 1m 内不衰减，之后 1/(d/ref)。
 * 另乘扬声器自身 gain（0..2，clamp）。空气吸收：每扬声器独立一阶低通状态，
 *   fc = 4000/(1+d) Hz（系数 a = 1−exp(−2π·fc/fs)，对扬声器信号先滤波后卷积）。
 *
 * 混合：out = ((1−amount)·dry + amount·Σ扬声器湿路) · masterGain，随后输出软限幅
 *   （0.85 软拐点 tanh 渐近 1.0）；引擎最终限幅器位于空间级之后。
 * 爆音防护（三道）：① 湿总线同源归一化——旧模式按能量，立体声音乐床按
 *   幅度和预缩放；② IR 重装载淡变——方向/
 *   布局变化触发 loadIR 前先淡出湿路（256 样本）、装载后淡入，消除 Convolver
 *   状态重置的硬切换；③ 标量增益（distGain/干湿混合）一阶平滑（τ=20ms）防
 *   滑块 zipper。HRIR 生成侧另按近耳 DC 增益 =1 归一（analyticHrtf）。
 * 房间模拟（§4.5 镜像声源早期反射 + FDN 晚期混响）在本 backend 内实现：
 * 早期反射读取卷积前声源，按镜像方向提取双耳 HRIR 线索；晚期混响读取空间湿总线。
 * room=off 或初始 roomAmount=0 时旁路，热更新至 0 则平滑退场。
 * roomSim 的几何保护/FDN 归一化须同步 Rust 后再做数值对拍。
 * 早期反射阶数默认 2（setRoomEarlyOrders 可改，内部/测试接口）。
 *
 * 多普勒（§4.6，模式 C）：config.dopplerVelocity 存在时启用——每扬声器在
 * 距离增益 + 空气吸收之后、卷积之前做时变重采样（小数延迟线 + 线性插值）：
 *   playback_rate = clamp(c / (c − v·dir), 0.5, 2.0)，c=343 m/s，v=听者速度、
 *   dir=扬声器方位单位向量；rate==1 直通（与无多普勒逐位相等）。重采样逻辑与
 *   Rust 侧 process_block 逐位对齐（同 f32 量化、同 f64 运算顺序、同钳位）。
 *
 * 声源大小 size（§4.7 扩散声源，0..1）：
 *   - 方向模糊：setConfig 时 size>0 的 speaker 用 az ± size·30° 两个方向的 HRIR 对
 *     每耳各 50% 混合后作该 speaker 的 HRIR（size=0 → 原方向单 HRIR，与现状逐位一致）；
 *   - 双耳去相关：右耳额外小数延迟 size·6 样本（一阶线性插值延迟线，每 speaker
 *     状态；size=0 直通）。公式见 decorrRight 注释。
 * 遮挡/衍射简化（§4.7，契约 spatial_set_occlusion）：config.occlusionAmount 0..1
 * 全局遮挡量 → 每 speaker 增益衰减 gain·(1−0.8·occlusion)（并入 distGain）+
 * 空气式低通 fc = 12000·(1−occlusion) Hz（钳位 ≥1Hz；系数公式与空气吸收同族、
 * 独立状态）。occlusion=0 全旁路（与现状逐位一致）。
 * 卷积模式（契约 spatial_set_convolution_mode）：'partitioned'=分区 FFT（默认）/
 * 'time'=时域直接卷积（TimeConvolver.ts，与分区模式同块调度同放行——干湿对齐
 * 一致、脉冲位置一致，仅差 FFT 圆整 ≤1e-4；getLatencySamples 两模式均 512）。
 * 契约两函数（规划书 §3.2）：getHrir 查询指定方向 HRIR 对（与渲染同网格/同插值
 * 路径，对应 Rust 侧 spatial_get_hrir——nearest=网格原段、spherical=hrtfInterp）。
 *
 * 热路径（processStereo）：稳态零分配（scratch 全部预分配/按需扩容），
 * 每块调用一次，outL/outR 完整写入。setConfig / loadHrtf 非实时路径允许分配。
 * 确定性：同输入同配置必同输出（无随机、无时间依赖）。
 */

import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from '../dsp/audioBuffer'
import { BinauralConvolver } from './BinauralConvolver'
import type { PreparedBinauralIR } from './BinauralConvolver'
import { PropagationDelay } from './PropagationDelay'
import { StereoAmbienceExtractor } from './StereoAmbienceExtractor'
import { TimeConvolver } from './TimeConvolver'
import type { StereoConvEngine } from './TimeConvolver'
import { sphericalHrtf } from './hrtfInterp'
import { interpolateMeasuredHrtf, nearestMeasuredIndex } from './measuredHrtfInterp'
import { ROOM_PRESETS, RoomSim, roomParamsFromPreset } from './roomSim'
import type { RoomHrirCues, PreparedRoomEarly } from './roomSim'
import type { HrtfGrid, HrtfInterpMode, ListenerState, DistanceModel, RoomPreset, SpatialRenderConfig, VirtualSpeaker } from './types'
import type { SpatialBackend } from './SpatialBackend'

/** 分区长度（与 Convolver 默认分区一致）：湿路块缓冲延迟 = 干路对齐延迟（样本） */
const PARTITION_SIZE = 512
/** 计算分区按 AudioWorklet 量子结算，输出仍补齐至 PARTITION_SIZE 保持既有对齐。 */
const COMPUTE_PARTITION_SIZE = 128
/** 距离衰减参考距离（米） */
const REF_DISTANCE = 1
/** 线性衰减最大距离（米） */
const LINEAR_MAX_DISTANCE = 50
/** 空气吸收截止频率基准（Hz）：fc = 4000/(1+d) */
const AIR_FILTER_FC_BASE = 4000
/** 空气声速（m/s，多普勒公式 c；与 Rust 侧 DOPPLER_C 一致） */
const SPEED_OF_SOUND = 343
/** 多普勒 playback_rate 钳位范围（与 Rust 侧一致） */
const DOPPLER_RATE_MIN = 0.5
const DOPPLER_RATE_MAX = 2.0
/** 度 → 弧度（f64，与 Rust 侧 DEG2RAD 一致） */
const DEG2RAD = Math.PI / 180
/** 多普勒重采样环形延迟线长度（每扬声器一条，与 Rust 侧 RESAMP_LINE 一致） */
const RESAMP_LINE = 1024
/** 重采样初始小数延迟（样本）：rate≠1 起播的固定延迟（与 Rust 侧一致） */
const RESAMP_START_DELAY = 512
/** 延迟钳位下界（保持 ≥1：读指针不越过最新样本） */
const RESAMP_MIN_DELAY = 1
/** 延迟钳位上界（DLINE−2：线性插值双抽头始终落在环内） */
const RESAMP_MAX_DELAY = RESAMP_LINE - 2
/** 声源大小方向模糊角度系数（度）：HRIR 对取 az ± size·30° 两方向 50/50 混合（§4.7） */
const SIZE_BLUR_DEG = 30
/** 双耳去相关延迟线长度（每 speaker 一条；最大延迟 size·6=6 样本 + 双抽头余量，与 Rust 侧一致） */
const DECORR_LINE = 16
/** 遮挡增益衰减系数（§4.7）：gain·(1 − 0.8·occlusion) */
const OCC_GAIN_FACTOR = 0.8
/** 遮挡空气式低通截止基准（Hz）：fc = 12000·(1 − occlusion) */
const OCC_FC_BASE = 12000
/** 遮挡低通截止钳位下界（Hz）：防系数 a=0 退化为纯保持/全静音（"遮挡=1 增益≈0.2"语义） */
const OCC_FC_MIN = 1
/** 输出软限幅软拐点阈值（|x| ≤ T 完全线性零失真；超阈值 tanh 软压渐近 1.0）。
 *  它限制多扬声器相干残余峰值，并在用户关闭最终 Limiter 时继续防止硬削波。 */
const SOFTCLIP_THRESHOLD = 0.85
/** IR 重装载淡入淡出长度（样本，≈5.3ms @48k）：方向/布局变化触发 loadIR 时，
 *  先淡出旧湿路 → 装载 → 淡入新湿路，消除 Convolver 状态重置的硬切换爆音 */
const RELOAD_FADE_SAMPLES = 256
const ROOM_HRIR_CACHE_MAX = 4096
/** 标量增益平滑时间常数（秒）：distGain/干湿混合增益一阶平滑，防滑块快速拖动的 zipper 噪声 */
const GAIN_SMOOTH_TAU = 0.02

function finiteRange(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value)) : fallback
}

function normalizedAngle(value: number): number {
  const az = Number.isFinite(value) ? value : 0
  return ((((az + 180) % 360) + 360) % 360) - 180
}

/** 输出软限幅（软拐点）：|x| ≤ T 线性；超阈值 sign·(T + (1−T)·tanh((|x|−T)/(1−T))) */
function softClip(x: number): number {
  const ax = x < 0 ? -x : x
  if (ax <= SOFTCLIP_THRESHOLD) return x
  const t = SOFTCLIP_THRESHOLD
  const y = t + (1 - t) * Math.tanh((ax - t) / (1 - t))
  return x < 0 ? -y : y
}

/** 距离衰减增益（公式注释见文件头；ref/max 可配（config.refDistance/maxDistance，
 *  缺省 REF_DISTANCE/LINEAR_MAX_DISTANCE 常量——旧调用兼容）） */
export function distanceGain(model: DistanceModel, d: number, ref = REF_DISTANCE, max = LINEAR_MAX_DISTANCE): number {
  switch (model) {
    case 'inverse':
      // min(1, ref/max(d, ref))：ref 内不衰减，之后 1/d
      return Math.min(1, ref / Math.max(d, ref))
    case 'linear':
      // max(0, 1-(d-ref)/(max-ref))：ref 内不衰减，ref..max 线性衰减到 0
      return Math.max(0, 1 - (d - ref) / (Math.max(max, ref + 0.1) - ref))
    case 'exponential':
      // pow(max(d,ref)/ref, -1)：ref 内不衰减，之后 1/(d/ref)
      return Math.pow(Math.max(d, ref) / ref, -1)
  }
}

/**
 * 多普勒 playback_rate（f64，与 Rust 侧逐位对齐）：
 *   doppler_factor = c / (c + dot(−v, dir)) = c / (c − v·dir)，c=343 m/s
 *   playback_rate = clamp(factor, 0.5, 2.0)
 * v = 听者速度（世界坐标 m/s，经 f32 量化——Rust ABI 参数为 f32，Math.fround 等价）；
 * dir = 声源方向单位向量（speaker 方位，方向从听者指向声源）。
 * 速率语义：rate>1 听者接近声源 → 音调升高/时间压缩（重采样读指针前移）；
 * rate<1 远离 → 音调降低；rate==1 后端直通（与无多普勒输出逐位相等）。
 */
export function dopplerRate(vel: { x: number; y: number; z: number }, dirX: number, dirY: number, dirZ: number): number {
  const vx = Math.fround(vel.x)
  const vy = Math.fround(vel.y)
  const vz = Math.fround(vel.z)
  const m = -vx * dirX - vy * dirY - vz * dirZ
  const factor = SPEED_OF_SOUND / (SPEED_OF_SOUND + m)
  return Math.min(DOPPLER_RATE_MAX, Math.max(DOPPLER_RATE_MIN, factor))
}

/**
 * HRTF 网格最近邻查表（方位角/仰角 → 网格索引）。
 * 方位角先归一化到 [-180, 180)，按环形角距取最近邻（网格 72 项，线性扫描足够）。
 */
export function nearestGridIndex(
  grid: HrtfGrid,
  azimuthDeg: number,
  elevationDeg: number,
): { azIdx: number; elIdx: number } {
  const azs = grid.azimuths
  const els = grid.elevations
  // 归一化到 [-180, 180)
  const az = ((((azimuthDeg + 180) % 360) + 360) % 360) - 180
  let azIdx = 0
  let bestAz = Infinity
  for (let i = 0; i < azs.length; i++) {
    const diff = Math.abs(az - azs[i])
    const angDist = Math.min(diff, 360 - diff) // 环形角距（-180 与 180 相邻）
    if (angDist < bestAz) {
      bestAz = angDist
      azIdx = i
    }
  }
  // 仰角钳制到网格范围后取最近邻
  const elClamped = Math.min(els[els.length - 1], Math.max(els[0], elevationDeg))
  let elIdx = 0
  let bestEl = Infinity
  for (let i = 0; i < els.length; i++) {
    const diff = Math.abs(elClamped - els[i])
    if (diff < bestEl) {
      bestEl = diff
      elIdx = i
    }
  }
  return { azIdx, elIdx }
}

function nearestDirection(grid: HrtfGrid, azimuthDeg: number, elevationDeg: number): { index: number; azIdx: number; elIdx: number } {
  if (grid.rings?.length) {
    const index = nearestMeasuredIndex(grid, azimuthDeg, elevationDeg)
    return { index, azIdx: index, elIdx: 0 }
  }
  const { azIdx, elIdx } = nearestGridIndex(grid, azimuthDeg, elevationDeg)
  return { index: elIdx * grid.azimuths.length + azIdx, azIdx, elIdx }
}

function continuousHrtf(grid: HrtfGrid, azimuthDeg: number, elevationDeg: number, outL: Float32Array, outR: Float32Array): void {
  if (grid.rings?.length) interpolateMeasuredHrtf(grid, azimuthDeg, elevationDeg, outL, outR)
  else sphericalHrtf(grid, azimuthDeg, elevationDeg, outL, outR)
}

/**
 * 50/50 混合（就地于 a，§4.7 声源大小方向模糊）：a[j] = (a[j] + b[j])·0.5。
 * f64 中间量、f32 写回——与 Rust 侧 build_speaker 的混合公式逐位一致。
 */
function mixHalf(a: Float32Array, b: Float32Array): void {
  for (let j = 0; j < a.length; j++) {
    a[j] = (a[j] + b[j]) * 0.5
  }
}

/** 同一采样率/网格版本下，主线程已精确计算的房间双耳线索。 */
export interface PreparedRoomHrir {
  sampleRate: number
  revision: number
  hrirLength: number
  gridSignature: string
  entries: Array<[string, RoomHrirCues]>
  early?: PreparedRoomEarly
  direct?: { signature: string; entries: Array<[number, PreparedBinauralIR]>;
    /** 与频谱相同目标的时域 HRIR，避免接管端重新做方向插值；旧消息可缺省。 */
    hrirs?: Array<[number, Float32Array, Float32Array]> }
}

/** 装载时计算一次数据指纹，防止同采样率/长度的其他 HRIR 数据误用缓存。 */
function roomGridSignature(grid: HrtfGrid): string {
  let hash = 0x811c9dc5
  const layout = JSON.stringify([grid.sampleRate, grid.hrirLength, grid.azimuths, grid.elevations, grid.rings])
  for (let i = 0; i < layout.length; i++) hash = Math.imul(hash ^ layout.charCodeAt(i), 0x01000193)
  for (const plane of [grid.left, grid.right]) {
    const bits = new Uint32Array(plane.buffer, plane.byteOffset, plane.length)
    for (let i = 0; i < bits.length; i++) hash = Math.imul(hash ^ bits[i], 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** 空间后端配置工作量计数（诊断用；读取后由调用方清零，不参与音频输出）。 */
export interface SpatialConfigWork {
  directPreparedHits: number
  directPreparedMisses: number
  preparedSpeakerIrs: number
  localSpeakerIrs: number
  roomPreparedHits: number
  roomPreparedMisses: number
  roomRebuilds: number
  convolverInstances: number
  preparedPrimes: number
  preparedEntries: number
}

export class TsConvolverBackend implements SpatialBackend {
  private fs = 48000 // 由 loadHrtf(grid.sampleRate) 覆盖
  /** 配置工作量计数（区分 prepared 接管与本地重算）。 */
  readonly configWork: SpatialConfigWork = {
    directPreparedHits: 0, directPreparedMisses: 0, preparedSpeakerIrs: 0, localSpeakerIrs: 0,
    roomPreparedHits: 0, roomPreparedMisses: 0, roomRebuilds: 0, convolverInstances: 0,
    preparedPrimes: 0, preparedEntries: 0,
  }
  /** 内部精度：直连/湿总线/干路延迟线/环境声/反射总线等信号路径缓冲按此分配。
   *  HRIR 网格系数（grid.left/right）与控制线程 prepared 的时域 HRIR 仍为 Float32。 */
  private precision: Precision = 'float32'
  private discreteInput = false
  private lfeChannel = 3
  private lfeState = 0
  private lfePole = 0
  private lfeLine: AudioBuffer = new Float32Array(0)
  private lfePos = 0
  private grid: HrtfGrid | null = null
  private speakers: VirtualSpeaker[] = []

  // 分区模式每扬声器一枚共享输入历史的双耳卷积器；时域模式保留左右耳独立实例。
  private convL: StereoConvEngine[] = []
  private convR: StereoConvEngine[] = []
  private convDual: BinauralConvolver[] = []
  /** 卷积模式：'partitioned'=分区 FFT（默认）/ 'time'=时域直接卷积（契约 spatial_set_convolution_mode） */
  private convMode: 'partitioned' | 'time' = 'partitioned'
  private airState: AudioBuffer = new Float32Array(0) // 一阶低通 y 状态（每扬声器一个标量；类型跟随精度）
  private airCoef: Float32Array = new Float32Array(0) // 一阶低通系数 a（每扬声器）
  private distGain: Float32Array = new Float32Array(0) // 距离衰减 × 扬声器 gain × 遮挡增益（每扬声器标量，目标值）
  /** distGain 的当前平滑值（f64 存储——跨块保存平滑状态若经 f32 截断，分块与
   *  整块处理路径会产生 ~1e-7 漂移，破坏逐位确定性；renderProcess 逐样本逼近目标） */
  private distGainCur: Float64Array = new Float64Array(0)
  private lastAzIdx: Int32Array = new Int32Array(0) // 已装载 IR 的网格索引（防重复 loadIR）
  private lastElIdx: Int32Array = new Int32Array(0)
  /** 已装载 IR 的声源大小（防重复 loadIR；与 lastAzIdx/lastElIdx 同语义） */
  private lastSize: Float32Array = new Float32Array(0) // NaN 初始化强制新槽位首装载
  /** spherical 插值方向去重：上次装载方向/size（NaN 初始化强制首装载；|Δaz|+|Δel| < 0.5° 跳过重装） */
  private lastShAz: Float32Array = new Float32Array(0)
  private lastShEl: Float32Array = new Float32Array(0)
  private lastShSize: Float32Array = new Float32Array(0)

  // —— IR 重装载状态机（爆音修复：淡出 → loadIR → 淡入）——
  /** 槽位卷积实例已装载过 IR（0=全新实例必须立即装载，否则 processStereo 抛错；1=已有 IR，可走淡出重装） */
  private hasIr: Uint8Array = new Uint8Array(0)
  /** 淡出/淡入相位：0=稳态满增益 1=淡出中（计数值递减）2=淡入中（计数值递增） */
  private fadePhase: Uint8Array = new Uint8Array(0)
  /** 淡变已推进样本数（phase1 从 RELOAD_FADE_SAMPLES 递减到 0 时执行装载转 phase2；phase2 递增到上限转 phase0） */
  private fadeCount: Int32Array = new Int32Array(0)
  /** 待装载 IR（n × hrirLength 布局，syncSpeakers 拷贝入队，renderProcess 淡出完成后装载） */
  private pendingIrL: Float32Array = new Float32Array(0)
  private pendingIrR: Float32Array = new Float32Array(0)
  /** 干湿混合增益平滑状态（NaN = 首块直接跳到目标） */
  private dryGState = NaN
  private wetGState = NaN
  /** 插值模式：nearest=网格查表（波 1 原逻辑）/ spherical=球谐插值（见 hrtfInterp.ts） */
  private interp: HrtfInterpMode = 'nearest'
  /** 球谐插值 scratch（HRIR 对，长度 = hrirLength；loadHrtf 时分配） */
  private shIrL: Float32Array = new Float32Array(0)
  private shIrR: Float32Array = new Float32Array(0)

  // 干路延迟线（环形，长度 = 分区长度 + 实测 HRIR 主到达时间）
  private dryLineL: AudioBuffer = new Float32Array(0)
  private dryLineR: AudioBuffer = new Float32Array(0)
  private dryPos = 0

  // 工作 scratch（稳态零分配，仅按需扩容）
  private silenceL: AudioBuffer = new Float32Array(128) // 左耳卷积静音通道（就地写回会污染，需独立）
  private silenceR: AudioBuffer = new Float32Array(128) // 右耳卷积静音通道（同上）
  private srcL: AudioBuffer = new Float32Array(128) // 扬声器滤波信号（左耳卷积输入）
  private srcR: AudioBuffer = new Float32Array(128) // 同一信号的副本（右耳卷积输入）
  private wetL: AudioBuffer = new Float32Array(128)
  private wetR: AudioBuffer = new Float32Array(128)
  private readonly sourceViews = Array.from({ length: 129 }, (_, n) =>
    [this.srcL.subarray(0, n), this.srcR.subarray(0, n)] as const)
  private readonly silenceViews = Array.from({ length: 129 }, (_, n) =>
    [this.silenceL.subarray(0, n), this.silenceR.subarray(0, n)] as const)
  /** 湿总线分组 scratch：每扬声器所属组代表索引（-1 未分组；renderProcess 按输入引用分组） */
  private grpOf: Int32Array = new Int32Array(0)
  /** 湿总线分组 scratch：每扬声器组缩放系数（renderProcess 按输入引用分组计算） */
  private grpScale: Float32Array = new Float32Array(0)

  // 当前配置（混合参数）
  private amount = 1
  private masterGain = 1
  private airAbsorption: 'natural' | 'legacy' = 'legacy'
  private coherentInputNormalization = false
  private musicBedMidAlpha = 0
  private musicBedMidLow1 = 0
  private musicBedMidLow2 = 0
  private stereoPreservation = 0
  private stereoPreservationTarget = 0
  private distanceModel: DistanceModel = 'inverse'
  /** 距离衰减参考/最大距离（米，config 可配；缺省 REF_DISTANCE/LINEAR_MAX_DISTANCE） */
  private refDistance = REF_DISTANCE
  private maxDistance = LINEAR_MAX_DISTANCE
  /** 多普勒（§4.6，模式 C）：听者速度（null=未启用 → 直通） */
  private dopplerVelocity: { x: number; y: number; z: number } | null = null
  // 每扬声器重采样状态（小数延迟线，与 Rust 侧 SpeakerState 对齐）：
  private rsmpRing: AudioBuffer = new Float32Array(0) // 环形延迟线（n×RESAMP_LINE；类型跟随精度）
  private rsmpPos: Int32Array = new Int32Array(0) // 写指针（环内索引）
  private rsmpDelay: Float64Array = new Float64Array(0) // 小数延迟（样本，f64）
  private rsmpDirX: Float64Array = new Float64Array(0) // 方位单位向量（f64，setConfig 预计算）
  private rsmpDirY: Float64Array = new Float64Array(0)
  private rsmpDirZ: Float64Array = new Float64Array(0)
  /** 仅在对象明确启用传播时分配；普通立体声布局不额外占用延迟环。 */
  private propagation: (PropagationDelay | null)[] = []
  private propagationOwners: string[] = []
  private propagationBlend = new Float64Array(0)
  private propagationTarget = new Uint8Array(0)
  private propagationBlendStep = 1 / 1200
  private speakerOwners: string[] = []
  private diffuseCur: Float64Array = new Float64Array(0)
  private polarityCur: Float64Array = new Float64Array(0)

  // 声源大小 size（§4.7 扩散声源）：右耳去相关一阶线性插值小数延迟线（每 speaker 一条）
  private decorrRing: AudioBuffer = new Float32Array(0) // n×DECORR_LINE 环形缓冲（类型跟随精度）
  private decorrPos: Int32Array = new Int32Array(0) // 写指针（环内索引）
  private decorrDelay: Float64Array = new Float64Array(0) // 延迟样本 = size·6（f64；size 经 f32 量化）

  // 遮挡（§4.7，契约 spatial_set_occlusion）：全局量 → 每 speaker 增益衰减 + 空气式低通
  /** 遮挡量 0..1（config.occlusionAmount 钳位；0=旁路，与现状逐位一致） */
  private occAmount = 0
  /** 遮挡是否激活（occAmount > 0） */
  private occActive = false
  /** 空气式低通系数 a = 1−exp(−2π·fc/fs)，fc = max(12000·(1−occ), 1) Hz（f32 量化，与 Rust 侧 occ_alpha 对齐） */
  private occCoef = 0
  /** 增益衰减 (1 − 0.8·occ)（f32 量化；并入 distGain） */
  private occGain = 1
  /** 每 speaker 遮挡低通状态 y[n−1] */
  private occState: AudioBuffer = new Float32Array(0)

  // 声源大小方向模糊 scratch（HRIR 对，长度 = hrirLength；loadHrtf 时分配）
  private sizeIrL: Float32Array = new Float32Array(0) // 球谐分支第二方向 HRIR（左耳）
  private sizeIrR: Float32Array = new Float32Array(0)
  private mixIrL: Float32Array = new Float32Array(0) // 最近邻分支 50/50 混合目标（左耳）
  private mixIrR: Float32Array = new Float32Array(0)

  // 房间模拟（§4.5 镜像声源早期反射 + FDN 晚期混响；Rust 数值对拍待同步新增保护/归一化）
  /** 房间处理器（config.room !== 'off' && roomAmount>0 && 有扬声器时创建；否则 null 旁路） */
  private room: RoomSim | null = null
  private roomPreset: RoomPreset = 'off'
  private roomAmount = 0
  /** 上次 RoomSim 构造签名（preset + 扬声器几何 + 阶数）：签名不变时复用实例仅
   *  setAmount 更新混响量——避免每次 setConfig 重建截断 FDN 混响尾产生突变 */
  private roomSig = ''
  /** 不含声源几何的房间签名；只在此部分相同的重建中继承混响状态。 */
  private roomBaseSig = ''
  private hrtfRevision = 0
  /** 房间反射只消费 HRIR 的双耳能量/主峰；缓存紧凑线索避免移动时保留整段 IR。 */
  private readonly roomHrirCache = new Map<string, RoomHrirCues>()
  private readonly roomHrirUpdates = new Map<string, RoomHrirCues>()
  private preparedRoomEarly: PreparedRoomEarly | undefined
  private roomEarlyDirty = false
  private directPrepared: PreparedRoomHrir['direct']
  private activeDirectPrepared = new Map<number, PreparedBinauralIR>()
  private activeDirectHrirs = new Map<number, readonly [Float32Array, Float32Array]>()
  private readonly directIrDirty = new Set<number>()
  private hrtfNeedsReload = false
  private ambienceExtractor: StereoAmbienceExtractor | null = null
  private ambiencePca = false
  private ambientL: AudioBuffer = new Float32Array(128)
  private ambientR: AudioBuffer = new Float32Array(128)
  private roomGridSignature = ''
  private roomIrL = new Float32Array(0)
  private roomIrR = new Float32Array(0)
  /** 早期反射阶数（默认 2；setRoomEarlyOrders 修改，内部/测试接口） */
  private roomEarlyOrders = 2

  /**
   * 上次 syncSpeakers 配置的扬声器数量（增量更新基准）。
   * 用于判定 setConfig 时哪些扬声器槽位是"新增"（需初始化）vs "保留"（状态连续）：
   * 数组本身只扩容不收缩，故 _configuredN（而非数组长度）才反映实际在用槽位数。
   * 仅在 syncSpeakers 末尾更新；显式 reset() 不触碰（配置未变，仅流式状态清零）。
   */
  private _configuredN = 0

  loadHrtf(grid: HrtfGrid, deferConfiguration = false): void {
    if (!grid || !Number.isFinite(grid.sampleRate) || grid.sampleRate <= 0) {
      throw new Error('invalid hrtf grid: sampleRate')
    }
    const azCount = grid.azimuths.length
    const elCount = grid.elevations.length
    const rings = grid.rings
    const validRings = !!rings?.length && rings.length === elCount && rings.every((ring, i) =>
      ring.elevation === grid.elevations[i] && ring.azimuths.length > 0 &&
      ring.offset === (i === 0 ? 0 : rings[i - 1].offset + rings[i - 1].azimuths.length) &&
      (i === 0 || ring.elevation > rings[i - 1].elevation) &&
      ring.azimuths.every((az, j) => Number.isFinite(az) && (j === 0 || az > ring.azimuths[j - 1])))
    const directionCount = validRings ? rings![rings!.length - 1].offset + rings![rings!.length - 1].azimuths.length : azCount * elCount
    const expect = directionCount * grid.hrirLength
    if ((!validRings && (azCount < 1 || elCount < 1)) || !Number.isInteger(grid.hrirLength) || grid.hrirLength < 1 ||
        grid.left.length !== expect || grid.right.length !== expect) {
      throw new Error('invalid hrtf grid: layout')
    }
    const rateChanged = this.fs !== grid.sampleRate
    this.grid = grid
    this.roomGridSignature = roomGridSignature(grid)
    this.fs = grid.sampleRate
    if (rateChanged || !this.ambienceExtractor) {
      this.ambienceExtractor = new StereoAmbienceExtractor({ sampleRate: this.fs, precision: this.precision })
    }
    this.propagationBlendStep = 1 / Math.max(1, Math.round(this.fs * 0.025))
    this.hrtfRevision++
    this.roomHrirCache.clear()
    this.roomHrirUpdates.clear()
    this.directPrepared = undefined
    this.activeDirectPrepared.clear()
    this.activeDirectHrirs.clear()
    this.directIrDirty.clear()
    if (this.roomIrL.length !== grid.hrirLength) {
      this.roomIrL = new Float32Array(grid.hrirLength)
      this.roomIrR = new Float32Array(grid.hrirLength)
    }
    if (rateChanged && this.speakers.length > 0) {
      // 分区引擎/吸收系数/FDN 都依赖采样率；新网格必须从零构建流式状态。
      this.convL = []
      this.convR = []
      this.convDual = []
      this.propagation = []
      this.propagationOwners = []
      this._configuredN = 0
      this.hasIr.fill(0)
      this.dryLineL.fill(0)
      this.dryLineR.fill(0)
      this.dryPos = 0
      if (deferConfiguration) { this.room = null; this.roomSig = ''; this.roomBaseSig = '' }
      else if (this.room && this.roomPreset !== 'off') {
        this.room = new RoomSim(this.fs, this.speakers, roomParamsFromPreset(this.roomPreset, this.roomEarlyOrders),
          this.roomAmount, (az, el) => this.getRoomHrir(az, el), PARTITION_SIZE)
        this.room.setPrecision(this.precision)
        this.roomSig = '' // 下次 setConfig 按新速率重新确认房间签名
        this.roomBaseSig = ''
      }
    }
    // 球谐插值/方向模糊 scratch 随网格尺寸分配（spherical 分支写 HRIR 对用）
    if (this.shIrL.length !== grid.hrirLength) {
      this.shIrL = new Float32Array(grid.hrirLength)
      this.shIrR = new Float32Array(grid.hrirLength)
      this.sizeIrL = new Float32Array(grid.hrirLength)
      this.sizeIrR = new Float32Array(grid.hrirLength)
      this.mixIrL = new Float32Array(grid.hrirLength)
      this.mixIrR = new Float32Array(grid.hrirLength)
    }
    // 换数据集：已有扬声器配置时强制重装 IR（方向索引全部作废）
    this.hrtfNeedsReload = deferConfiguration
    if (this.speakers.length > 0 && !deferConfiguration) this.syncSpeakers(true)
  }

  /** 当前内部精度。 */
  getPrecision(): Precision {
    return this.precision
  }

  /** 读取配置工作量计数到调用方对象（不分配）。 */
  getConfigWork(target: SpatialConfigWork): void {
    const work = this.configWork
    target.directPreparedHits = work.directPreparedHits
    target.directPreparedMisses = work.directPreparedMisses
    target.preparedSpeakerIrs = work.preparedSpeakerIrs
    target.localSpeakerIrs = work.localSpeakerIrs
    target.roomPreparedHits = work.roomPreparedHits
    target.roomPreparedMisses = work.roomPreparedMisses
    target.roomRebuilds = work.roomRebuilds
    target.convolverInstances = work.convolverInstances
    target.preparedPrimes = work.preparedPrimes
    target.preparedEntries = work.preparedEntries
  }

  /** 清零配置工作量计数。 */
  resetConfigWork(): void {
    const work = this.configWork
    work.directPreparedHits = 0
    work.directPreparedMisses = 0
    work.preparedSpeakerIrs = 0
    work.localSpeakerIrs = 0
    work.roomPreparedHits = 0
    work.roomPreparedMisses = 0
    work.roomRebuilds = 0
    work.convolverInstances = 0
    work.preparedPrimes = 0
    work.preparedEntries = 0
  }

  /**
   * 切换内部精度（幂等）：信号路径 scratch（直连/湿总线/干路延迟线/环境声/
   * 反射总线/多普勒与去相关延迟线/静音通道）按新精度重分配；空间卷积引擎与
   * 其 IR 频谱按新精度重建并从已缓存的时域 IR 重新装载。prepared 双耳频谱与
   * 直接 IR 缓存与精度绑定，切换时丢弃并由本地路径重建（调用方随后可再下发
   * 同精度 prepared）。源 HRIR 网格系数保持 Float32。
   */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    this.silenceL = allocBuffer(this.silenceL.length, next)
    this.silenceR = allocBuffer(this.silenceR.length, next)
    this.srcL = allocBuffer(this.srcL.length, next)
    this.srcR = allocBuffer(this.srcR.length, next)
    this.wetL = allocBuffer(this.wetL.length, next)
    this.wetR = allocBuffer(this.wetR.length, next)
    this.ambientL = allocBuffer(this.ambientL.length, next)
    this.ambientR = allocBuffer(this.ambientR.length, next)
    for (let n = 0; n <= 128; n++) {
      this.sourceViews[n] = [this.srcL.subarray(0, n), this.srcR.subarray(0, n)]
      this.silenceViews[n] = [this.silenceL.subarray(0, n), this.silenceR.subarray(0, n)]
    }
    this.dryLineL = allocBuffer(this.dryLineL.length, next)
    this.dryLineR = allocBuffer(this.dryLineR.length, next)
    this.lfeLine = allocBuffer(this.lfeLine.length, next)
    // 多普勒重采样环、双耳去相关环与逐扬声器滤波状态同样是信号路径缓冲，
    // 必须跟随精度重建（否则 syncSpeakers 因容量已够而保留旧 f32 数组）。
    this.rsmpRing = allocBuffer(this.rsmpRing.length, next)
    this.decorrRing = allocBuffer(this.decorrRing.length, next)
    this.airState = allocBuffer(this.airState.length, next)
    this.occState = allocBuffer(this.occState.length, next)
    // 卷积引擎与 IR 频谱精度绑定：清空引擎与装载标记，由 syncSpeakers 重建并
    // 从 pendingIrL/R（时域 Float32 HRIR 缓存）重新装载。
    this.convL = []
    this.convR = []
    this.convDual = []
    this.propagation = []
    this.propagationOwners = []
    this._configuredN = 0
    this.hasIr.fill(0)
    this.fadePhase.fill(0)
    this.fadeCount.fill(0)
    this.activeDirectPrepared.clear()
    this.activeDirectHrirs.clear()
    this.directPrepared = undefined
    // 控制线程 prepared 的完整谱反射同样与精度绑定：清空后由本地路径重算/等待新下发。
    this.preparedRoomEarly = undefined
    // 环境声提取输出缓冲也属于空间信号路径（输出被复制进 ambientL/R）。
    this.ambienceExtractor?.setPrecision(next)
    this.room?.setPrecision(next)
    if (this.grid && this.speakers.length > 0) this.syncSpeakers(true)
    this.reset()
  }

  setConfig(config: SpatialRenderConfig): void {
    if (!this.grid) {
      // 网格未装载时视为直通（loadHrtf 必须先于 setConfig，防御性分支）
      this.speakers = []
      return
    }
    this.discreteInput = config.multichannelAuto === true
    this.lfeChannel = config.lfeChannel ?? 3
    this.lfePole = Math.exp(-2 * Math.PI * 120 / this.fs)
    this.speakers = (config.speakers ?? []).map(sp => ({
      ...sp,
      channel: Math.round(finiteRange(sp.channel, 0, 0, 31)),
      azimuthDeg: normalizedAngle(sp.azimuthDeg),
      elevationDeg: finiteRange(sp.elevationDeg, 0, -90, 90),
      distance: finiteRange(sp.distance, 1, 0, 200),
      gain: finiteRange(sp.gain, 1, 0, 2),
      size: finiteRange(sp.size, 0, 0, 1),
      diffuse: finiteRange(sp.diffuse, 0, 0, 1),
      polarity: finiteRange(sp.polarity, 1, -1, 1),
      propagationVelocity: finiteRange(sp.propagationVelocity, 0, -342, 342),
    }))
    const ambiencePca = config.ambienceExtraction !== 'difference' && this.speakers.some(speaker => speaker.ambience)
    if (ambiencePca !== this.ambiencePca) this.ambienceExtractor?.reset()
    this.ambiencePca = ambiencePca
    this.amount = finiteRange(config.amount, 1, 0, 1)
    this.masterGain = finiteRange(config.masterGain, 1, 0.5, 1)
    this.airAbsorption = config.airAbsorption === 'legacy' ? 'legacy'
      : config.airAbsorption === 'natural' || !!this.grid.rings?.length ? 'natural' : 'legacy'
    this.coherentInputNormalization = config.coherentInputNormalization === true
    const midCrossover = finiteRange(config.musicBedMidCrossoverHz, 0, 0, this.fs * 0.45)
    this.musicBedMidAlpha = midCrossover > 0 ? 1 - Math.exp(-2 * Math.PI * midCrossover / this.fs) : 0
    this.stereoPreservationTarget = finiteRange(config.stereoPreservation, 0, 0, 1)
    this.distanceModel = config.distanceModel === 'linear' || config.distanceModel === 'exponential'
      ? config.distanceModel : 'inverse'
    // 距离衰减可配（规划书属性面板：衰减模型/参考距离/最大距离）；钳位防退化
    // （ref ≥ 0.1、max ≥ ref+0.1，linear 分母恒正）
    this.refDistance = finiteRange(config.refDistance, REF_DISTANCE, 0.1, 100)
    this.maxDistance = Math.max(this.refDistance + 0.1, finiteRange(config.maxDistance, LINEAR_MAX_DISTANCE, 0.2, 1000))
    // 多普勒（§4.6）：保留旧接口到声速 ±343m/s 的测试/设计边界；
    // 非有限输入回退 0，复制快照以免外部对象热修改绕过归一化。
    this.dopplerVelocity = config.dopplerVelocity
      ? {
        x: finiteRange(config.dopplerVelocity.x, 0, -SPEED_OF_SOUND, SPEED_OF_SOUND),
        y: finiteRange(config.dopplerVelocity.y, 0, -SPEED_OF_SOUND, SPEED_OF_SOUND),
        z: finiteRange(config.dopplerVelocity.z, 0, -SPEED_OF_SOUND, SPEED_OF_SOUND),
      }
      : null
    // 卷积模式（契约 spatial_set_convolution_mode）：'partitioned'→分区 FFT（默认）/
    // 'time'→时域直接卷积（TimeConvolver）。模式切换 → 引擎类型变化，全量重建
    // （旧实例不可复用；同模式下保持既有"不重建同索引实例"语义，湿路历史不抖动）。
    // 模式切换后 convL/convR 全部清空 → 所有槽位需重新装载 IR（newSlotInit 依赖
    // _configuredN=0 强制 lastAzIdx=-1 → loadIR，否则新 Convolver 无 IR 会抛错）。
    const convMode: 'partitioned' | 'time' = config.convolution === 'time' ? 'time' : 'partitioned'
    if (convMode !== this.convMode) {
      this.convL = []
      this.convR = []
      this.convDual = []
      this.convMode = convMode
      this._configuredN = 0
      // 全新实例无 IR——必须立即装载（不可走淡出重装路径），hasIr 全部归零
      if (this.hasIr.length > 0) this.hasIr.fill(0)
    }
    // 遮挡（§4.7）：config.occlusionAmount（0..1 钳位；缺省/0 = 旁路，与现状逐位一致）
    this.occAmount = finiteRange(config.occlusionAmount, 0, 0, 1)
    // 插值模式变化时，即使目标角度/网格索引未变，也必须重装另一算法的 IR。
    const nextInterp = config.hrtfInterp === 'spherical' ? 'spherical' : 'nearest'
    const interpChanged = nextInterp !== this.interp
    this.interp = nextInterp
    this.activeDirectPrepared.clear()
    this.activeDirectHrirs.clear()
    if (this.directPrepared?.signature === this.directConfigSignature()) {
      this.configWork.directPreparedHits++
      for (const [index, prepared] of this.directPrepared.entries) this.activeDirectPrepared.set(index, prepared)
      for (const [index, left, right] of this.directPrepared.hrirs ?? [])
        this.activeDirectHrirs.set(index, [left, right])
    } else if (this.directPrepared) this.configWork.directPreparedMisses++
    this.directPrepared = undefined
    // 键已包含插值模式；保留有界条目，也保留刚收到的预计算线索。
    // 房间（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响，后端内置——不再由
    // 处理器/导出方叠加；预设参数表 roomSim.ts 与 Rust 侧一致，早期反射阶数默认 2）。
    // 首次 roomAmount=0 不创建房间（逐位旁路）；活跃房间设为 0 时保留旧状态
    // 并平滑退场，避免仍在发声的反射/尾音被当拍截断。room=off 则显式旁路。
    // 重建判定按"预设 + 扬声器几何 + 阶数"签名：签名不变时复用旧实例（保留 FDN
    // 混响尾与早期反射历史），仅 setAmount 更新混响量——每次 setConfig 无脑 new
    // 会瞬间截断混响尾（可听突变/小爆音）。
    if (config.earlyReflectionOrders !== undefined) this.setRoomEarlyOrders(config.earlyReflectionOrders)
    const roomPreset: RoomPreset = config.room && config.room in ROOM_PRESETS ? config.room : 'off'
    const roomAmount = finiteRange(config.roomAmount, 0, 0, 1)
    const roomSize = finiteRange(config.roomSize, 1, 0.5, 2)
    const sameRoomPreset = this.roomPreset === roomPreset
    this.roomPreset = roomPreset
    this.roomAmount = roomAmount
    const roomBaseSig = roomPreset !== 'off' && this.speakers.length > 0
      ? roomPreset + '|' + this.fs + '|' + this.interp + '|' + this.roomEarlyOrders + '|' + this.hrtfRevision + '|' + roomSize + '|' + (config.earlyReflectionModel ?? 'cues') + '|' + JSON.stringify(config.roomListener ?? null)
      : ''
    const roomSig = roomBaseSig
      ? roomBaseSig + '|' + this.speakers.map(sp =>
        `${Math.fround(sp.azimuthDeg)},${Math.fround(sp.elevationDeg)},${Math.fround(sp.distance)},${sp.channel},${sp.id ?? ''},${JSON.stringify(sp.roomPosition ?? null)}`).join(';')
      : ''
    const roomActive = !!roomSig && (roomAmount > 0 || (this.room !== null && sameRoomPreset))
    if (roomActive) {
      if (this.room && this.roomSig === roomSig) {
        this.room.setAmount(roomAmount)
      } else {
        const previous = this.room && sameRoomPreset ? this.room : undefined
        const roomParams = roomParamsFromPreset(roomPreset, this.roomEarlyOrders, roomSize)
        if (roomParams) roomParams.spectralEarly = config.earlyReflectionModel === 'spectral'
        if (this.preparedRoomEarly) this.configWork.roomPreparedHits++
        else this.configWork.roomPreparedMisses++
        this.configWork.roomRebuilds++
        this.room = new RoomSim(this.fs, this.speakers, roomParams,
          roomAmount, (az, el) => config.earlyReflectionModel === 'spectral' ? this.getHrir(az, el) : this.getRoomHrir(az, el),
          PARTITION_SIZE, previous, this.roomBaseSig === roomBaseSig, config.roomListener, this.preparedRoomEarly)
        this.room.setPrecision(this.precision)
        this.preparedRoomEarly = undefined
        this.roomEarlyDirty = true
        this.roomSig = roomSig
        this.roomBaseSig = roomBaseSig
      }
    } else {
      this.room = null
      this.roomSig = ''
      this.roomBaseSig = ''
    }
    this.room?.setBalance(config.earlyAmount ?? 1, config.lateAmount ?? 1)
    this.syncSpeakers(interpChanged || this.hrtfNeedsReload)
    this.hrtfNeedsReload = false
  }

  /**
   * 设置早期反射阶数（0=关闭早期反射，只保留 FDN；0..3 钳位）。
   * 内部/测试接口（对应 Rust ABI spatial_set_room 的 early_orders 参数）：
   * 须在 setConfig 之前调用（setConfig 时按当前值初始化房间）。
   */
  setRoomEarlyOrders(orders: number): void {
    this.roomEarlyOrders = Math.floor(finiteRange(orders, 2, 0, 3))
  }

  /** 按当前扬声器配置同步卷积器/状态（方向或网格变化时重装 IR，非热路径） */
  private syncSpeakers(forceReload: boolean): void {
    const grid = this.grid
    if (!grid) return
    const n = this.speakers.length

    // 卷积引擎实例：数量变化时分配/截断（配置变化不重建同索引实例，避免湿路历史抖动；
    // 模式切换已在 setConfig 全量重建）——partitioned=双耳共享频谱 / time=时域直接卷积。
    if (this.convMode === 'partitioned') {
      while (this.convDual.length < n) {
        this.convDual.push(new BinauralConvolver(COMPUTE_PARTITION_SIZE, PARTITION_SIZE, this.precision))
        this.configWork.convolverInstances++
      }
      this.convDual.length = n
    } else {
      while (this.convL.length < n) {
        this.convL.push(new TimeConvolver(this.fs, { partitionSize: PARTITION_SIZE, precision: this.precision }))
        this.convR.push(new TimeConvolver(this.fs, { partitionSize: PARTITION_SIZE, precision: this.precision }))
      }
      this.convL.length = n
      this.convR.length = n
    }
    // 每扬声器状态数组按需扩容（保留旧值）
    if (this.airState.length < n) {
      const ns = allocBuffer(n, this.precision)
      ns.set(this.airState.subarray(0, Math.min(this.airState.length, n)))
      this.airState = ns
    }
    if (this.airCoef.length < n) {
      const nc = new Float32Array(n)
      nc.set(this.airCoef.subarray(0, Math.min(this.airCoef.length, n)))
      this.airCoef = nc
    }
    if (this.distGain.length < n) {
      const ng = new Float32Array(n)
      ng.set(this.distGain.subarray(0, Math.min(this.distGain.length, n)))
      this.distGain = ng
      // 平滑当前值同步扩容：新槽位 0 起步平滑升到目标（自带淡入语义）
      const nc2 = new Float64Array(n)
      nc2.set(this.distGainCur.subarray(0, Math.min(this.distGainCur.length, n)))
      this.distGainCur = nc2
    }
    if (this.lastAzIdx.length < n) {
      const na = new Int32Array(n)
      na.set(this.lastAzIdx.subarray(0, Math.min(this.lastAzIdx.length, n)))
      this.lastAzIdx = na
    }
    if (this.lastElIdx.length < n) {
      const ne = new Int32Array(n)
      ne.set(this.lastElIdx.subarray(0, Math.min(this.lastElIdx.length, n)))
      this.lastElIdx = ne
    }
    if (this.lastSize.length < n) {
      const ns = new Float32Array(n)
      ns.fill(NaN) // NaN !== 任何值 → 新槽位强制首装载（防 azIdx=0 网格漏装载）
      ns.set(this.lastSize.subarray(0, Math.min(this.lastSize.length, n)))
      this.lastSize = ns
    }
    if (this.lastShAz.length < n) {
      // spherical 去重哨兵：NaN 强制新槽位首装载
      const a = new Float32Array(n)
      const e = new Float32Array(n)
      const sz = new Float32Array(n)
      a.fill(NaN)
      e.fill(NaN)
      sz.fill(NaN)
      a.set(this.lastShAz)
      e.set(this.lastShEl)
      sz.set(this.lastShSize)
      this.lastShAz = a
      this.lastShEl = e
      this.lastShSize = sz
    }
    if (this.hasIr.length < n) {
      const hi = new Uint8Array(n)
      hi.set(this.hasIr.subarray(0, Math.min(this.hasIr.length, n)))
      this.hasIr = hi
      const fp = new Uint8Array(n)
      fp.set(this.fadePhase.subarray(0, Math.min(this.fadePhase.length, n)))
      this.fadePhase = fp
      const fc = new Int32Array(n)
      fc.set(this.fadeCount.subarray(0, Math.min(this.fadeCount.length, n)))
      this.fadeCount = fc
    }
    if (grid && this.pendingIrL.length < n * grid.hrirLength) {
      const M = grid.hrirLength
      const pl = new Float32Array(n * M)
      const pr = new Float32Array(n * M)
      pl.set(this.pendingIrL)
      pr.set(this.pendingIrR)
      this.pendingIrL = pl
      this.pendingIrR = pr
    }
    if (this.occState.length < n) {
      const ns = allocBuffer(n, this.precision)
      ns.set(this.occState.subarray(0, Math.min(this.occState.length, n)))
      this.occState = ns
    }
    if (this.diffuseCur.length < n) {
      const diffuse = new Float64Array(n)
      diffuse.set(this.diffuseCur.subarray(0, Math.min(this.diffuseCur.length, n)))
      this.diffuseCur = diffuse
      const polarity = new Float64Array(n)
      polarity.fill(1)
      polarity.set(this.polarityCur.subarray(0, Math.min(this.polarityCur.length, n)))
      this.polarityCur = polarity
    }

    // 干路延迟线（分区延迟 + 实测 HRIR 主到达时间）；setConfig 不重置 dryLine
    // 内容与 dryPos（切场景/切模式保留已有干声数据 → 干路连续不静音；湿路
    // Convolver 若因方向变化 loadIR 重置则从零渐入，干路不受影响）。全量清零
    // 仅由显式 reset() 触发（见 reset()）。
    const dryDelay = PARTITION_SIZE + Math.max(0, Math.round(grid?.referenceDelaySamples ?? 0))
    if (this.dryLineL.length !== dryDelay) {
      this.dryLineL = allocBuffer(dryDelay, this.precision)
      this.dryLineR = allocBuffer(dryDelay, this.precision)
      this.dryPos = 0
      this.lfeLine = allocBuffer(dryDelay, this.precision)
      this.lfePos = 0
    }

    // —— 增量更新（修复切场景/切模式爆音与静音）——
    // 切场景/切模式（setConfig）不再全量清零流式状态，仅扩容 + 初始化新增扬声器
    // 槽位；已有扬声器 [0..oldN) 的延迟线/位置/状态全部保留 → 流式连续不爆音。
    // 数量缩减时旧槽位数据保留但不参与处理；下次扩容复用同索引槽位时由
    // newSlotInit 清零（避免跨配置污染）。Rust 侧 reset_stream 全量清零语义仅用于
    // 显式 reset()，配置热更新走增量。
    const oldN = this._configuredN

    // 多普勒重采样状态（§4.6）：增量扩容（保留旧数据）
    if (this.rsmpRing.length < n * RESAMP_LINE) {
      const newRing = allocBuffer(n * RESAMP_LINE, this.precision)
      const copyS = Math.min(oldN, n)
      if (copyS > 0) newRing.set(this.rsmpRing.subarray(0, copyS * RESAMP_LINE))
      this.rsmpRing = newRing
    }
    if (this.rsmpPos.length < n) {
      const np = new Int32Array(n)
      np.set(this.rsmpPos.subarray(0, Math.min(this.rsmpPos.length, n)))
      this.rsmpPos = np
      const nd = new Float64Array(n)
      nd.set(this.rsmpDelay.subarray(0, Math.min(this.rsmpDelay.length, n)))
      this.rsmpDelay = nd
      const ndx = new Float64Array(n)
      ndx.set(this.rsmpDirX.subarray(0, Math.min(this.rsmpDirX.length, n)))
      this.rsmpDirX = ndx
      const ndy = new Float64Array(n)
      ndy.set(this.rsmpDirY.subarray(0, Math.min(this.rsmpDirY.length, n)))
      this.rsmpDirY = ndy
      const ndz = new Float64Array(n)
      ndz.set(this.rsmpDirZ.subarray(0, Math.min(this.rsmpDirZ.length, n)))
      this.rsmpDirZ = ndz
    }
    this.propagation.length = n
    this.propagationOwners.length = n
    this.speakerOwners.length = n
    if (this.propagationBlend.length < n) {
      const blend = new Float64Array(n)
      blend.set(this.propagationBlend)
      this.propagationBlend = blend
      const target = new Uint8Array(n)
      target.set(this.propagationTarget)
      this.propagationTarget = target
    }

    // 双耳去相关状态（§4.7）：增量扩容（保留旧数据）
    if (this.decorrRing.length < n * DECORR_LINE) {
      const newRing = allocBuffer(n * DECORR_LINE, this.precision)
      const copyS = Math.min(oldN, n)
      if (copyS > 0) newRing.set(this.decorrRing.subarray(0, copyS * DECORR_LINE))
      this.decorrRing = newRing
    }
    if (this.decorrPos.length < n) {
      const np = new Int32Array(n)
      np.set(this.decorrPos.subarray(0, Math.min(this.decorrPos.length, n)))
      this.decorrPos = np
      const nd = new Float64Array(n)
      nd.set(this.decorrDelay.subarray(0, Math.min(this.decorrDelay.length, n)))
      this.decorrDelay = nd
    }

    // 新增扬声器槽位初始化（[oldN..n)）：流式状态归零 + IR 索引哨兵强制 loadIR。
    // 防止数量缩减后复用同索引槽位时旧数据污染——lastAzIdx 哨兵 -1 强制 loadIR
    // （否则新 Convolver 无 IR → processStereo 抛错）；rsmpPos/decorrPos 错位 → 爆音；
    // airState/occState 残留旧扬声器的滤波状态。已有槽位 [0..oldN) 全部保留。
    for (let s = oldN; s < n; s++) {
      this.rsmpRing.fill(0, s * RESAMP_LINE, (s + 1) * RESAMP_LINE)
      this.decorrRing.fill(0, s * DECORR_LINE, (s + 1) * DECORR_LINE)
      this.rsmpPos[s] = 0
      this.rsmpDelay[s] = RESAMP_START_DELAY
      this.propagation[s] = null
      this.propagationOwners[s] = ''
      this.propagationBlend[s] = this.speakers[s].propagation === true ? 1 : 0
      this.propagationTarget[s] = this.speakers[s].propagation === true ? 1 : 0
      this.speakerOwners[s] = ''
      this.decorrPos[s] = 0
      this.airState[s] = 0
      this.occState[s] = 0
      this.distGain[s] = 0
      this.distGainCur[s] = 0
      this.diffuseCur[s] = this.speakers[s].diffuse ?? 0
      this.polarityCur[s] = this.speakers[s].polarity ?? 1
      this.lastAzIdx[s] = -1
      this.lastElIdx[s] = -1
      this.lastSize[s] = NaN
      this.lastShAz[s] = NaN
      this.lastShEl[s] = NaN
      this.lastShSize[s] = NaN
      this.hasIr[s] = 0
      this.fadePhase[s] = 0
      this.fadeCount[s] = 0
    }
    this._configuredN = n

    // 遮挡（§4.7）：全局参数——增益衰减 (1−0.8·occ)（并入 distGain）+ 空气式低通
    // 系数 a = 1−exp(−2π·fc/fs)，fc = max(12000·(1−occ), 1) Hz（与空气吸收同系数
    // 公式、独立状态）。occ=0 → occGain=1、滤波旁路——与现状逐位一致。
    const occ = this.occAmount
    this.occActive = occ > 0
    this.occGain = Math.fround(occ > 0 ? 1 - OCC_GAIN_FACTOR * occ : 1)
    this.occCoef = Math.fround(1 - Math.exp((-2 * Math.PI * Math.max(OCC_FC_BASE * (1 - occ), OCC_FC_MIN)) / this.fs))

    for (let s = 0; s < n; s++) {
      const sp = this.speakers[s]
      const owner = sp.id ?? ''
      const identityChanged = s < oldN && owner !== '' && this.speakerOwners[s] !== ''
        && this.speakerOwners[s] !== owner
      if (identityChanged) {
        this.airState[s] = 0
        this.occState[s] = 0
        this.rsmpRing.fill(0, s * RESAMP_LINE, (s + 1) * RESAMP_LINE)
        this.rsmpPos[s] = 0
        this.rsmpDelay[s] = RESAMP_START_DELAY
        this.decorrRing.fill(0, s * DECORR_LINE, (s + 1) * DECORR_LINE)
        this.decorrPos[s] = 0
        this.diffuseCur[s] = sp.diffuse ?? 0
        this.polarityCur[s] = sp.polarity ?? 1
      }
      this.speakerOwners[s] = owner
      // 距离 f32 量化（O1 审计 1.4）：sp.distance 经 Math.fround 与 Rust ABI
      // VirtualSpeakerRaw.distance: f32 对齐；下游 distanceGain / 空气吸收 fc 公式
      // 均吃同一 f32 量化值，避免 f64 双精度在反距离增益/低通系数处产生 ~1e-7 偏差。
      const d = Math.fround(sp.distance)
      // 距离衰减（公式见文件头） × 扬声器自身增益（0..2 clamp） × 遮挡增益衰减
      this.distGain[s] = distanceGain(this.distanceModel, d, this.refDistance, this.maxDistance) * Math.min(2, Math.max(0, sp.gain ?? 1)) * this.occGain
      // 空气吸收：fc = 4000/(1+d) Hz → 一阶低通系数（d 已 f32 量化）
      const fc = this.airAbsorption === 'natural'
        ? Math.max(1800, 20000 / (1 + 0.025 * Math.pow(Math.max(0, d - 1), 1.3)))
        : AIR_FILTER_FC_BASE / (1 + Math.fround(d))
      this.airCoef[s] = 1 - Math.exp((-2 * Math.PI * fc) / this.fs)

      // 声源大小（§4.7 扩散声源）：0..1 钳位——方向模糊（az ± size·30° 两方向 HRIR
      // 50/50 混合，见下方装载分支）+ 右耳去相关（size·6 样本，processStereo 施加）
      const size = Math.min(1, Math.max(0, sp.size ?? 0))
      // 右耳去相关延迟（f32 量化与 Rust ABI size 一致）：delay = size·6 样本
      this.decorrDelay[s] = Math.fround(size) * 6

      // 多普勒方位单位向量（f64）：az/el 经 f32 量化（与 Rust VirtualSpeakerRaw f32
      // 一致），显式归一化保证两实现逐位一致（f32 方位角舍入下长度≈1）
      const azRad = Math.fround(sp.azimuthDeg) * DEG2RAD
      const elRad = Math.fround(sp.elevationDeg) * DEG2RAD
      const dRawX = Math.cos(elRad) * Math.sin(azRad)
      const dRawY = Math.sin(elRad)
      const dRawZ = Math.cos(elRad) * Math.cos(azRad)
      const dLen = Math.sqrt(dRawX * dRawX + dRawY * dRawY + dRawZ * dRawZ)
      this.rsmpDirX[s] = dRawX / dLen
      this.rsmpDirY[s] = dRawY / dLen
      this.rsmpDirZ[s] = dRawZ / dLen
      if (sp.propagation === true) {
        const owner = `${sp.id ?? ''}|${sp.channel}`
        if (this.propagationOwners[s] !== owner) this.propagation[s] = null
        this.propagation[s] ??= new PropagationDelay(this.fs, this.precision)
        this.propagation[s]!.setDistance(sp.distance, sp.propagationVelocity)
        this.propagationOwners[s] = owner
        this.propagationTarget[s] = 1
      } else {
        this.propagationTarget[s] = 0
        if (this.propagationBlend[s] === 0) {
          this.propagation[s] = null
          this.propagationOwners[s] = ''
        }
      }

      // HRIR 对装载：按插值模式分两支——
      // ① spherical（球谐插值，hrtfInterp.ts）：按目标方向（连续角度，不限于网格点）
      //    生成 HRIR 对。方向变化超阈值（|Δaz| 环形 + |Δel| < 0.5°）或 size 变化才
      //    重装——原实现每次 setConfig 无条件全量 loadIR，播放中改任何参数（如仅改
      //    一只扬声器 gain）都会让全部扬声器湿路同时塌陷再跳回（满幅级爆音）。
      // ② nearest（最近邻网格查表，波 1 原逻辑）：az/el → 网格索引 → 方向/size
      //    变化时才重装（size 参与去重——模糊后的 IR 依赖 size）。
      // 声源大小（§4.7）：size>0 时方向模糊——az ± size·30° 两方向的 HRIR 对
      // 每耳各 50% 混合（混合公式 (h1+h2)·0.5，f64 中间量、f32 写回，与 Rust 一致）；
      // size=0 → 原方向单 HRIR（与现状逐位一致）。
      // 装载统一经 queueIr：已有 IR 的槽位走"淡出→装载→淡入"（消除 Convolver 状态
      // 重置的硬切换爆音）；全新槽位/实例立即装载 + 淡入。
      if (this.interp === 'spherical') {
        const azF = Math.fround(sp.azimuthDeg)
        const elF = Math.fround(sp.elevationDeg)
        const sizeF = Math.fround(size)
        const lastAz = this.lastShAz[s]
        const azDiff = Math.abs(((azF - lastAz + 540) % 360) - 180) // 环形角距
        const needReload = !Number.isFinite(lastAz)
          || azDiff >= 0.5
          || Math.abs(elF - this.lastShEl[s]) >= 0.5
          || sizeF !== this.lastShSize[s]
        if (needReload || forceReload || identityChanged) {
          const preparedHrir = this.activeDirectHrirs.get(s)
          if (preparedHrir) {
            this.queueIr(s, preparedHrir[0], preparedHrir[1], identityChanged)
          } else {
            if (size > 0) {
              const az1 = azF - sizeF * SIZE_BLUR_DEG
              const az2 = azF + sizeF * SIZE_BLUR_DEG
              continuousHrtf(grid, az1, sp.elevationDeg, this.shIrL, this.shIrR)
              continuousHrtf(grid, az2, sp.elevationDeg, this.sizeIrL, this.sizeIrR)
              mixHalf(this.shIrL, this.sizeIrL)
              mixHalf(this.shIrR, this.sizeIrR)
            } else {
              continuousHrtf(grid, sp.azimuthDeg, sp.elevationDeg, this.shIrL, this.shIrR)
            }
            this.queueIr(s, this.shIrL, this.shIrR, identityChanged)
          }
          this.lastShAz[s] = azF
          this.lastShEl[s] = elF
          this.lastShSize[s] = sizeF
        }
      } else {
        const { index, azIdx, elIdx } = nearestDirection(grid, sp.azimuthDeg, sp.elevationDeg)
        if (forceReload || identityChanged || this.lastAzIdx[s] !== azIdx || this.lastElIdx[s] !== elIdx || this.lastSize[s] !== size) {
          const M = grid.hrirLength
          let irL: Float32Array
          let irR: Float32Array
          const preparedHrir = this.activeDirectHrirs.get(s)
          if (preparedHrir) {
            irL = preparedHrir[0]; irR = preparedHrir[1]
          } else if (size > 0) {
            // 方向模糊：az ± size·30° 两方向最近邻 HRIR 对 50/50 混合（每耳）
            const az1 = Math.fround(sp.azimuthDeg) - Math.fround(size) * SIZE_BLUR_DEG
            const az2 = Math.fround(sp.azimuthDeg) + Math.fround(size) * SIZE_BLUR_DEG
            const a1 = nearestDirection(grid, az1, sp.elevationDeg)
            const a2 = nearestDirection(grid, az2, sp.elevationDeg)
            const b1 = a1.index * M
            const b2 = a2.index * M
            for (let j = 0; j < M; j++) {
              this.mixIrL[j] = (grid.left[b1 + j] + grid.left[b2 + j]) * 0.5
              this.mixIrR[j] = (grid.right[b1 + j] + grid.right[b2 + j]) * 0.5
            }
            irL = this.mixIrL
            irR = this.mixIrR
          } else {
            const base = index * M
            irL = grid.left.subarray(base, base + M)
            irR = grid.right.subarray(base, base + M)
          }
          this.queueIr(s, irL, irR, identityChanged)
          this.lastAzIdx[s] = azIdx
          this.lastElIdx[s] = elIdx
          this.lastSize[s] = size
        }
      }
    }

    // —— 湿总线能量归一化在 renderProcess 按实际输入源分组进行（见该处注释）：
    //    预计算按 channel 两总线分组对 processMulti 不成立（各 channel 是独立输入
    //    源，不同源不该合并缩放；越界路由的多 channel 又确实同源）。新槽位平滑
    //    当前值置 NaN 哨兵——renderProcess 首块直接跳到"distGain × 组缩放"完整
    //    目标（组缩放只在渲染时可知，且全新配置无旧增益可渐变）。
    for (let s = oldN; s < n; s++) {
      this.distGainCur[s] = NaN
    }
  }

  /**
   * IR 装载入队（爆音修复）：已有 IR 的槽位不立即 loadIR——Convolver.loadIR 会
   * 重置流式状态（湿路瞬间静默 512 样本再全幅跳回 = 硬切换爆音），改为暂存 IR
   * 并进入淡出相位，由 renderProcess 在湿路淡出到 0 后执行装载、再淡入。
   * 全新槽位/实例（hasIr=0，processStereo 对无 IR 实例会抛错）立即装载并从 0
   * 淡入——卷积零状态虽自然渐入，但满增益起步在多扬声器布局下（一次新增 11 只）
   * 首块即可观爬升（实测相邻样本跳变 0.76），淡入 256 样本彻底压平。
   */
  private queueIr(s: number, irL: Float32Array, irR: Float32Array, replaced = false): void {
    const grid = this.grid
    if (!grid) return
    this.directIrDirty.add(s)
    this.pendingIrL.set(irL, s * grid.hrirLength)
    this.pendingIrR.set(irR, s * grid.hrirLength)
    if (this.hasIr[s]) {
      if (this.convMode === 'partitioned' && !replaced) {
        const prepared = this.activeDirectPrepared.get(s)
        if (prepared && this.preparedMatchesPrecision(prepared)
          && this.convDual[s].updatePreparedIR(prepared, Math.round(this.fs * 0.02))) {
          this.configWork.preparedSpeakerIrs++
          this.directIrDirty.delete(s)
        } else {
          this.configWork.localSpeakerIrs++
          this.convDual[s].updateIR(irL, irR, this.decorrDelay[s] > 0, Math.round(this.fs * 0.02))
        }
        return
      }
      if (this.convMode === 'time' && !replaced) {
        this.convL[s].updateIR?.(irL, `sp${s}-L`)
        this.convR[s].updateIR?.(irR, `sp${s}-R`)
        return
      }
      const M = grid.hrirLength
      this.pendingIrL.set(irL, s * M)
      this.pendingIrR.set(irR, s * M)
      // 连续拖动方向时保留当前湿路包络：淡出中只换待装 IR，不重启计时；
      // 淡入中从当前增益反向淡出，避免包络瞬间跳回满幅。
      if (this.fadePhase[s] !== 1) {
        this.fadeCount[s] = this.fadePhase[s] === 2
          ? Math.max(1, Math.min(RELOAD_FADE_SAMPLES, this.fadeCount[s]))
          : RELOAD_FADE_SAMPLES
        this.fadePhase[s] = 1
      }
    } else {
      this.loadSpeakerIr(s, irL, irR)
      this.hasIr[s] = 1
      // 淡入起点 = −512（放行重建期）——装载后 512 样本输出恒 0，恢复瞬间起淡入
      this.fadePhase[s] = 2
      this.fadeCount[s] = -PARTITION_SIZE
    }
  }

  /** prepared 双耳频谱与实例精度绑定；不匹配时回退本地时域 IR FFT。 */
  private preparedMatchesPrecision(prepared: PreparedBinauralIR): boolean {
    return normalizePrecision(prepared.precision) === this.precision
  }

  private loadSpeakerIr(s: number, left: Float32Array, right: Float32Array): void {
    if (this.convMode === 'partitioned') {
      const prepared = this.activeDirectPrepared.get(s)
      if (prepared && this.preparedMatchesPrecision(prepared) && this.convDual[s].loadPreparedIR(prepared)) {
        this.configWork.preparedSpeakerIrs++
        this.directIrDirty.delete(s)
      } else {
        this.configWork.localSpeakerIrs++
        this.convDual[s].loadIR(left, right, this.decorrDelay[s] > 0)
      }
    }
    else {
      this.convL[s].loadIR(left, `sp${s}-L`)
      this.convR[s].loadIR(right, `sp${s}-R`)
    }
  }

  /** 房间构建只需方向能量和到达峰值；插值与直达声使用相同算法。 */
  private getRoomHrir(azimuthDeg: number, elevationDeg: number): RoomHrirCues {
    const key = `${this.hrtfRevision}|${this.interp}|${Math.fround(azimuthDeg)}|${Math.fround(elevationDeg)}`
    const cached = this.roomHrirCache.get(key)
    if (cached) return cached
    const grid = this.grid!
    const left = this.roomIrL
    const right = this.roomIrR
    if (this.interp === 'spherical') continuousHrtf(grid, azimuthDeg, elevationDeg, left, right)
    else {
      const { index } = nearestDirection(grid, azimuthDeg, elevationDeg)
      const base = index * grid.hrirLength
      for (let i = 0; i < grid.hrirLength; i++) {
        left[i] = grid.left[base + i]
        right[i] = grid.right[base + i]
      }
    }
    let peakL = 0, peakR = 0, maxL = -1, maxR = -1
    let energyL = 0, energyR = 0
    for (let i = 0; i < left.length; i++) {
      const l = left[i], r = right[i]
      energyL += l * l
      energyR += r * r
      if (Math.abs(l) > maxL) { maxL = Math.abs(l); peakL = i }
      if (Math.abs(r) > maxR) { maxR = Math.abs(r); peakR = i }
    }
    const cues = { peakL, peakR, energyL, energyR }
    if (this.roomHrirCache.size >= ROOM_HRIR_CACHE_MAX) {
      const oldest = this.roomHrirCache.keys().next().value
      if (oldest !== undefined) {
        this.roomHrirCache.delete(oldest)
        this.roomHrirUpdates.delete(oldest)
      }
    }
    this.roomHrirCache.set(key, cues)
    this.roomHrirUpdates.set(key, cues)
    return cues
  }

  /** 新 Worklet 取全量缓存，后续只发送主线程新增的方向线索。 */
  takePreparedRoomHrir(full = false): PreparedRoomHrir | undefined {
    const entries = Array.from(full ? this.roomHrirCache : this.roomHrirUpdates,
      ([key, cues]): [string, RoomHrirCues] => [key, { ...cues }])
    this.roomHrirUpdates.clear()
    const early = full || this.roomEarlyDirty ? this.room?.createPreparedEarlyTransfer() : undefined
    this.roomEarlyDirty = false
    const directEntries: Array<[number, PreparedBinauralIR]> = []
    const directHrirs: Array<[number, Float32Array, Float32Array]> = []
    if (this.convMode === 'partitioned' && this.grid && (full || this.directIrDirty.size > 0)) {
      for (let s = 0; s < this.speakers.length; s++) {
        const M = this.grid.hrirLength
        const prepared = this.fadePhase[s] === 1
          ? BinauralConvolver.prepareIR(this.pendingIrL.subarray(s * M, (s + 1) * M),
            this.pendingIrR.subarray(s * M, (s + 1) * M), 128, PARTITION_SIZE, this.precision)
          : this.convDual[s].createPreparedIRTransfer()
        directEntries.push([s, prepared])
        directHrirs.push([s, this.pendingIrL.slice(s * M, (s + 1) * M), this.pendingIrR.slice(s * M, (s + 1) * M)])
      }
    }
    this.directIrDirty.clear()
    const direct = directEntries.length ? { signature: this.directConfigSignature(), entries: directEntries, hrirs: directHrirs } : undefined
    if (!this.grid || (entries.length === 0 && !early && !direct)) return undefined
    return { sampleRate: this.fs, revision: this.hrtfRevision, hrirLength: this.grid.hrirLength,
      gridSignature: this.roomGridSignature, entries, ...(early ? { early } : {}), ...(direct ? { direct } : {}) }
  }

  private directConfigSignature(): string {
    // 精度包含在签名内：不同精度的 prepared 频谱不能复用到同一缓存槽位。
    return JSON.stringify([this.fs, this.roomGridSignature, this.interp, this.convMode, this.precision, this.speakers])
  }

  /** 在参数应用前填充精确缓存；无效/过期数据回退本地计算。 */
  primeRoomHrir(prepared: PreparedRoomHrir): void {
    this.configWork.preparedPrimes++
    this.configWork.preparedEntries += prepared?.entries?.length ?? 0
    if (!this.grid || !prepared || prepared.sampleRate !== this.fs
      || !Number.isSafeInteger(prepared.revision) || prepared.revision < 1 || prepared.hrirLength !== this.grid.hrirLength
      || prepared.gridSignature !== this.roomGridSignature
      || !Array.isArray(prepared.entries) || prepared.entries.length > ROOM_HRIR_CACHE_MAX) return
    // revision 是每个后端自己的装载序号，Worklet 重建/消息合流后不必相同。
    // 实际数据由 sampleRate/长度/网格指纹确认；条目仍须属于生产端声明的序号，
    // 接收后映射为本地序号，避免本地查询 miss 并回退实时插值。
    const producerPrefix = `${prepared.revision}|`
    if (prepared.early) this.preparedRoomEarly = prepared.early
    if (prepared.direct && typeof prepared.direct.signature === 'string' && prepared.direct.signature.length <= 65536
      && Array.isArray(prepared.direct.entries) && prepared.direct.entries.length <= 128
      && prepared.direct.entries.every(entry => Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) && entry[0] >= 0 && entry[0] < 128))
      {
        this.directPrepared = prepared.direct
        // 时域缓存只用于匹配配置的目标 IR；非法项单独丢弃，频谱仍可正常接管。
        const hrirs = prepared.direct.hrirs
        if (hrirs) {
          const valid = Array.isArray(hrirs) && hrirs.length <= 128
            ? hrirs.filter(entry => {
              if (!Array.isArray(entry) || entry.length !== 3 || !Number.isInteger(entry[0]) || entry[0] < 0 || entry[0] >= 128) return false
              const left = entry[1], right = entry[2]
              if (!(left instanceof Float32Array) || !(right instanceof Float32Array)
                || left.length !== this.grid!.hrirLength || right.length !== this.grid!.hrirLength) return false
              let nonzeroL = false, nonzeroR = false
              for (let i = 0; i < left.length; i++) {
                if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) return false
                nonzeroL ||= left[i] !== 0; nonzeroR ||= right[i] !== 0
              }
              return nonzeroL && nonzeroR
            }) : []
          this.directPrepared = { ...prepared.direct, hrirs: valid }
        }
      }
    for (const entry of prepared.entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [key, cues] = entry
      if (typeof key !== 'string' || key.length > 160 || !cues
        || !(key.startsWith(`${producerPrefix}nearest|`) || key.startsWith(`${producerPrefix}spherical|`))
        || !Number.isInteger(cues.peakL) || !Number.isInteger(cues.peakR)
        || cues.peakL < 0 || cues.peakL >= this.grid.hrirLength
        || cues.peakR < 0 || cues.peakR >= this.grid.hrirLength
        || !Number.isFinite(cues.energyL) || !Number.isFinite(cues.energyR)
        || cues.energyL < 0 || cues.energyR < 0 || cues.energyL + cues.energyR <= 0) continue
      const localKey = `${this.hrtfRevision}|${key.slice(producerPrefix.length)}`
      if (!this.roomHrirCache.has(localKey) && this.roomHrirCache.size >= ROOM_HRIR_CACHE_MAX) {
        const oldest = this.roomHrirCache.keys().next().value
        if (oldest !== undefined) {
          this.roomHrirCache.delete(oldest)
          this.roomHrirUpdates.delete(oldest)
        }
      }
      this.roomHrirCache.set(localKey, { peakL: cues.peakL, peakR: cues.peakR, energyL: cues.energyL, energyR: cues.energyR })
    }
  }

  setListener(_listener: ListenerState): void {
    // 波 1 各模式固定原点朝前，头锁定由融合层在虚拟扬声器方位上体现，后端忽略
  }

  /**
   * 查询指定方向的 HRIR 对（规划书 §3.2 契约）：与渲染同网格/同插值路径——
   * nearest=最近邻网格查表（nearestGridIndex，返回网格原数据段拷贝）/
   * spherical=球谐插值（hrtfInterp.sphericalHrtf）。返回 { left, right }
   * （各为长度 = grid.hrirLength 的新 Float32Array）。
   * 对应 Rust 侧 spatial_get_hrir（ABI 契约；与 Rust build_speaker 装载分支
   * 同源同路径——注释互标）。
   */
  getHrir(azimuthDeg: number, elevationDeg: number): { left: Float32Array; right: Float32Array } {
    const grid = this.grid
    if (!grid) {
      throw new Error('TsConvolverBackend: 尚未 loadHrtf（getHrir 需先装载网格）')
    }
    const M = grid.hrirLength
    const left = new Float32Array(M)
    const right = new Float32Array(M)
    if (this.interp === 'spherical') {
      // spherical：球谐插值（连续角度求值，与 setConfig 装载分支同路径）
      continuousHrtf(grid, azimuthDeg, elevationDeg, left, right)
    } else {
      // nearest：最近邻网格查表（与 setConfig 装载分支的 size=0 分支同路径）
      const { index } = nearestDirection(grid, azimuthDeg, elevationDeg)
      const base = index * M
      left.set(grid.left.subarray(base, base + M))
      right.set(grid.right.subarray(base, base + M))
    }
    return { left, right }
  }

  processStereo(inL: AudioBuffer, inR: AudioBuffer, outL: AudioBuffer, outR: AudioBuffer): void {
    // 立体声：channel ≤ 0 → L 源，其余 → R 源（既有语义，逐位回归）
    this.renderProcess(null, inL, inR, outL, outR)
  }

  /**
   * 多声道输入渲染（SpatialBackend.processMulti 可选方法）：N 路单声道输入 → 双耳。
   * 与 processStereo 同算法仅输入侧扩展——speaker.channel < inputs.length 时取对应
   * 输入；越界取 0 号输入；干路 = 0/1 号输入（立体声下混）。相同 speaker 配置下
   * 2 路输入与 processStereo 输出逐位一致（回归测试）。
   */
  processMulti(inputs: AudioBuffer[], outL: AudioBuffer, outR: AudioBuffer, dryL?: AudioBuffer, dryR?: AudioBuffer): void {
    if (inputs.length === 0) {
      // 防御：无输入（处理器多声道路径恒 ≥3 路，不会走到）→ 静音输出
      outL.fill(0)
      outR.fill(0)
      return
    }
    const inL = inputs[0]
    const inR = inputs.length > 1 ? inputs[1] : inputs[0] // 单路输入干路双耳同源
    this.renderProcess(inputs, inL, inR, outL, outR, dryL, dryR)
  }

  /**
   * 公共渲染内核（processStereo / processMulti 共用；inputs 只做源声道选择，
   * 全部 DSP 算术与顺序逐位一致）：
   * 干路延迟线（分区 + HRIR 对齐）→ 逐扬声器吸收/距离增益/遮挡/多普勒/去相关/卷积 →
   * 房间早期反射 + FDN → 干湿混合。
   */
  private renderProcess(
    inputs: AudioBuffer[] | null,
    inL: AudioBuffer,
    inR: AudioBuffer,
    outL: AudioBuffer,
    outR: AudioBuffer,
    dryL = inL,
    dryR = inR,
  ): void {
    const B = Math.min(inL.length, inR.length, outL.length, outR.length)
    if (B <= 0) return
    if (this.ambiencePca && this.ambienceExtractor) {
      if (this.ambientL.length < B) { this.ambientL = allocBuffer(B, this.precision); this.ambientR = allocBuffer(B, this.precision) }
      for (let start = 0; start < B; start += 128) {
        const count = Math.min(128, B - start)
        this.ambienceExtractor.process(start === 0 && B <= 128 ? dryL : dryL.subarray(start, start + count),
          start === 0 && B <= 128 ? dryR : dryR.subarray(start, start + count), count)
        for (let i = 0; i < count; i++) {
          this.ambientL[start + i] = this.ambienceExtractor.buffers.left[i]
          this.ambientR[start + i] = this.ambienceExtractor.buffers.right[i]
        }
      }
    }
    const n = this.speakers.length
    if (n === 0) {
      // 无扬声器：直通（无额外延迟）
      if (inL.length === B && inR.length === B) {
        outL.set(inL)
        outR.set(inR)
      } else {
        outL.set(inL.subarray(0, B))
        outR.set(inR.subarray(0, B))
      }
      return
    }
    // scratch 按需扩容（仅尺寸变化时分配一次）
    if (this.silenceL.length < B) {
      this.silenceL = allocBuffer(B, this.precision)
      this.silenceR = allocBuffer(B, this.precision)
      for (let n = 0; n <= 128; n++)
        this.silenceViews[n] = [this.silenceL.subarray(0, n), this.silenceR.subarray(0, n)]
    }
    if (this.srcL.length < B) {
      this.srcL = allocBuffer(B, this.precision)
      this.srcR = allocBuffer(B, this.precision)
      for (let n = 0; n <= 128; n++)
        this.sourceViews[n] = [this.srcL.subarray(0, n), this.srcR.subarray(0, n)]
    }
    if (this.wetL.length < B) {
      this.wetL = allocBuffer(B, this.precision)
      this.wetR = allocBuffer(B, this.precision)
    }
    if (this.grpOf.length < n) {
      this.grpOf = new Int32Array(n)
      this.grpScale = new Float32Array(n)
    }

    // 干路：分区延迟加实测 HRIR 主到达时间，写入 out
    for (let i = 0; i < B; i++) {
      outL[i] = this.dryLineL[this.dryPos]
      outR[i] = this.dryLineR[this.dryPos]
      this.dryLineL[this.dryPos] = dryL[i]
      this.dryLineR[this.dryPos] = dryR[i]
      this.dryPos++
      if (this.dryPos >= this.dryLineL.length) this.dryPos = 0
    }

    // 湿路：逐扬声器 —— 距离增益（一阶平滑）+ IR 重装载淡变 + 空气吸收 → 左右耳卷积 → 求和（+ 房间早期反射）
    if (this.room) this.room.beginBlock(B)
    this.wetL.fill(0, 0, B)
    this.wetR.fill(0, 0, B)
    // 标量增益每样本平滑系数（τ=20ms，防 zipper）
    const gainCoef = 1 - Math.exp(-1 / (this.fs * GAIN_SMOOTH_TAU))
    // —— 湿总线同源归一化：按输入数组引用分组（同
    //    引用 = 真同源——多只扬声器吃同一输入时相干求和峰值随 N 增长，5.1 的 L
    //    总线 3 只、7.1.4 可达 7 只）。旧数值对拍按 1/max(1, √Σ distGain²)
    //    保持能量；立体声音乐按 1/max(1, Σ distGain) 保持同源幅度。残余峰值由
    //    输出软限幅兜底。引用分组对 processMulti 也成立：各 channel 是独立输入 →
    //    各自成组不缩放；越界路由（多个 channel 取同一输入）→ 同引用同组正确合并。
    //    n ≤ 16，O(n²) 分组每块开销可忽略。
    for (let s = 0; s < n; s++) this.grpOf[s] = -1
    for (let s = 0; s < n; s++) {
      if (this.grpOf[s] !== -1) continue
      const channelS = this.speakers[s].channel
      const srcS = this.speakers[s].ambience && this.ambiencePca ? (channelS <= 0 ? this.ambientL : this.ambientR)
        : inputs ? (channelS < inputs.length ? inputs[channelS] : inputs[0]) : (channelS <= 0 ? inL : inR)
      const speakerS = this.speakers[s]
      let e = this.coherentInputNormalization ? this.distGain[s] : this.distGain[s] * this.distGain[s]
      for (let k = s + 1; k < n; k++) {
        const channelK = this.speakers[k].channel
        const srcK = this.speakers[k].ambience && this.ambiencePca ? (channelK <= 0 ? this.ambientL : this.ambientR)
          : inputs ? (channelK < inputs.length ? inputs[channelK] : inputs[0]) : (channelK <= 0 ? inL : inR)
        const speakerK = this.speakers[k]
        if (this.grpOf[k] === -1 && srcK === srcS
          && speakerK.diffuse === speakerS.diffuse && speakerK.polarity === speakerS.polarity) {
          this.grpOf[k] = s
          e += this.coherentInputNormalization ? this.distGain[k] : this.distGain[k] * this.distGain[k]
        }
      }
      this.grpOf[s] = s
      const scale = e > 1 ? (this.coherentInputNormalization ? 1 / e : 1 / Math.sqrt(e)) : 1
      this.grpScale[s] = scale
    }
    const sl = B <= 128 ? this.sourceViews[B][0] : this.srcL.length === B ? this.srcL : this.srcL.subarray(0, B)
    const sr = B <= 128 ? this.sourceViews[B][1] : this.srcR.length === B ? this.srcR : this.srcR.subarray(0, B)
    for (let s = 0; s < n; s++) {
      const channel = this.speakers[s].channel
      const src = this.speakers[s].ambience && this.ambiencePca ? (channel <= 0 ? this.ambientL : this.ambientR)
        : inputs ? (channel < inputs.length ? inputs[channel] : inputs[0]) : (channel <= 0 ? inL : inR)
      const diffuseTarget = this.speakers[s].diffuse ?? 0
      const polarityTarget = this.speakers[s].polarity ?? 1
      // 拷贝 + 距离增益：g 一阶平滑逼近目标（目标 = distGain × 组归一化）
      const gTarget = this.distGain[s] * this.grpScale[this.grpOf[s]]
      let g = this.distGainCur[s]
      if (Number.isNaN(g)) g = gTarget // 新槽位/reset 后首块：直接跳完整目标（含组缩放）
      const a = this.airCoef[s]
      // 引擎的分析/控制边界会把128帧量子拆短；短块共用构造时预分配的精确长度视图。
      let diffuse = this.diffuseCur[s]
      let polarity = this.polarityCur[s]
      for (let i = 0; i < B; i++) {
        g += gainCoef * (gTarget - g)
        let inputSample = src[i]
        diffuse += gainCoef * (diffuseTarget - diffuse)
        polarity += gainCoef * (polarityTarget - polarity)
        if (diffuse > 1e-8) {
          // Diffuse surround/height feeds the stereo difference residual instead of
          // duplicating a full L/R programme channel into every virtual speaker.
          const sideResidual = (inL[i] - inR[i]) * 0.5 * polarity
          inputSample += diffuse * (sideResidual - inputSample)
        }
        const v = inputSample * g
        sl[i] = v
        sr[i] = v
      }
      this.distGainCur[s] = g
      this.diffuseCur[s] = diffuse
      this.polarityCur[s] = polarity
      // 空气吸收（一阶低通，每扬声器独立状态；就地于 srcL，再同步到 srcR）
      // 状态 f32 截断对齐（O1 审计 1.1）：Rust 侧 `s.absorb_state = y` 每样本把状态
      // 写回 f32，下一样本读 f32 状态——TS 原实现 `let y = this.airState[s]` 在块内
      // 持 f64 carry，状态跨样本不截断，与 Rust 每样本截断产生 ~1e-7 偏差（高扬声器
      // 数/大距离/窄带相干输入敏感度上升）。改为每样本写回 + 重读 this.airState[s]，
      // 强制 f32 状态与 Rust 逐位对齐。
      for (let i = 0; i < B; i++) {
        let y = this.airState[s] // 重读 f32 状态（上一样本已截断写回）
        y += a * (sl[i] - y)
        this.airState[s] = y // 写回 f32（Float32Array 赋值自动截断）
        sl[i] = y
        sr[i] = y
      }

      // 遮挡（§4.7，契约 spatial_set_occlusion）：空气式一阶低通
      // fc = 12000·(1−occ) Hz（系数公式与空气吸收同族、状态每 speaker 独立；
      // 增益衰减 (1−0.8·occ) 已并入 distGain）。occ=0 → 旁路（与现状逐位一致）。
      if (this.occActive) {
        let oy = this.occState[s]
        const oa = this.occCoef
        for (let i = 0; i < B; i++) {
          oy += oa * (sl[i] - oy)
          sl[i] = oy
          sr[i] = oy
        }
        this.occState[s] = oy
      }

      // 多普勒重采样（§4.6，模式 C）：全局听者速度 + 每 speaker 方位 → playback_rate，
      // 位于距离增益/空气吸收之后、卷积之前（与 Rust 侧 process_block 逐位对齐）。
      // rate==1 直通（不触碰延迟线状态）；rate≠1 时小数延迟线重采样后同步右耳副本。
      if (this.dopplerVelocity && !this.propagationTarget[s]) {
        const rate = dopplerRate(this.dopplerVelocity, this.rsmpDirX[s], this.rsmpDirY[s], this.rsmpDirZ[s])
        if (rate !== 1) {
          this.resampleSpeaker(s, sl, B, rate)
          sr.set(sl)
        }
      }

      const propagation = this.propagation[s]
      if (propagation) {
        propagation.process(sl)
        let blend = this.propagationBlend[s]
        const target = this.propagationTarget[s]
        const step = this.propagationBlendStep
        for (let i = 0; i < B; i++) {
          blend = target ? Math.min(1, blend + step) : Math.max(0, blend - step)
          sl[i] = sr[i] + (sl[i] - sr[i]) * blend
        }
        this.propagationBlend[s] = blend
        if (!target && blend === 0) {
          this.propagation[s] = null
          this.propagationOwners[s] = ''
        }
        sr.set(sl)
      }

      // 反射使用卷积前声源；其抽头内含一个分区的直达卷积延迟。
      // 镜像方向的双耳时间/能量线索由 RoomSim 在配置时预计算。
      if (this.room) this.room.early(s, sl, sr, B)

      // 双耳去相关（§4.7 声源大小 size）：右耳源额外小数延迟 size·6 样本（一阶
      // 线性插值延迟线，每 speaker 状态；size=0 直通，不触碰延迟线——回归逐位）
      if (this.decorrDelay[s] > 0) {
        this.decorrRight(s, sr, B)
      }

      // 左耳：processStereo(信号, 静音) → l 通道 = 左耳湿路（就地覆盖 srcL）。
      // 注意：Convolver 就地写回输入数组，故静音通道会被污染——左右耳各用一块
      // 独立静音（silenceL/silenceR），且只喂本块 B 个样本，避免历史
      // 最大块长下 scratch 尾部陈旧样本被重复处理（湿路错位）。
      // IR 重装载必须在卷积输入的相同样本边界发生。先处理整个 B 再在输出
      // 淡出末尾 loadIR 会把本块余下的输入喂给旧 IR，重建后又丢掉该段历史；
      // 大块与 128 样本分块因而产生不同输出。只在淡出边界拆一次块，之后
      // 新 IR 从下一样本开始接收输入，淡入计数仍对齐卷积的 512 样本延迟。
      let phase = this.fadePhase[s]
      let count = this.fadeCount[s]
      let off = 0
      while (off < B) {
        const end = phase === 1 ? Math.min(B, off + count) : B
        if (this.convMode === 'partitioned') {
          this.convDual[s].processStereo(off === 0 && end === B ? sl : sl.subarray(off, end),
            off === 0 && end === B ? sr : sr.subarray(off, end))
        } else {
          const fullBlock = off === 0 && end === B
          const silentL = fullBlock && B <= 128 ? this.silenceViews[B][0]
            : fullBlock && this.silenceL.length === B ? this.silenceL : this.silenceL.subarray(off, end)
          const silentR = fullBlock && B <= 128 ? this.silenceViews[B][1]
            : fullBlock && this.silenceR.length === B ? this.silenceR : this.silenceR.subarray(off, end)
          this.convL[s].processStereo(fullBlock ? sl : sl.subarray(off, end), silentL)
          this.convR[s].processStereo(silentR, fullBlock ? sr : sr.subarray(off, end))
        }
        for (let i = off; i < end; i++) {
          let fg = 1
          if (phase === 1) {
            count--
            fg = count > 0 ? count / RELOAD_FADE_SAMPLES : 0
          } else if (phase === 2) {
            count++
            if (count >= RELOAD_FADE_SAMPLES) phase = 0
            else fg = count > 0 ? count / RELOAD_FADE_SAMPLES : 0
          }
          if (fg !== 1) {
            sl[i] *= fg
            sr[i] *= fg
          }
        }
        off = end
        if (phase === 1 && count === 0) {
          const M = this.grid ? this.grid.hrirLength : 0
          this.loadSpeakerIr(s, this.pendingIrL.subarray(s * M, (s + 1) * M), this.pendingIrR.subarray(s * M, (s + 1) * M))
          phase = 2
          count = -PARTITION_SIZE
        }
      }
      this.fadePhase[s] = phase
      this.fadeCount[s] = count
      for (let i = 0; i < B; i++) {
        this.wetL[i] += sl[i]
        this.wetR[i] += sr[i]
      }
    }

    // LFE 不作为有方向的扬声器；低通后以等电平、同延迟加入双耳湿路。
    if (this.discreteInput && this.lfeChannel >= 0 && inputs && inputs.length > 4 && inputs[this.lfeChannel]) {
      for (let i = 0; i < B; i++) {
        this.lfeState = this.lfePole * this.lfeState + (1 - this.lfePole) * inputs[this.lfeChannel][i]
        const delayed = this.lfeLine[this.lfePos]
        this.lfeLine[this.lfePos] = this.lfeState * 0.25
        if (++this.lfePos === this.lfeLine.length) this.lfePos = 0
        this.wetL[i] += delayed; this.wetR[i] += delayed
      }
    }

    // 房间 FDN 晚期混响 + 混合（§4.5）：fdn 输入 = 湿总线/N，输出混回湿总线；
    // 就地改写 wetL/wetR（随后统一干湿混合）
    if (this.room) {
      this.room.lateAndMix(this.wetL, this.wetR, B)
      if (this.room.isSilent) {
        this.room = null
        this.roomSig = ''
        this.roomBaseSig = ''
      }
    }

    // 混合：out = ((1−amount)·dry + amount·wetSum) · masterGain——dryG/wetG 样本级
    // 一阶平滑（NaN 首块直接跳目标），随后输出软限幅；引擎最终 Limiter
    // 位于本级之后，关闭 Limiter 时软限幅仍防多扬声器相干叠加硬削波。
    const dryT = (1 - this.amount) * this.masterGain
    const wetT = this.amount * this.masterGain
    if (Number.isNaN(this.dryGState)) {
      this.dryGState = dryT
      this.wetGState = wetT
    }
    let dg = this.dryGState
    let wg = this.wetGState
    if (this.musicBedMidAlpha > 0) {
      const alpha = this.musicBedMidAlpha
      let stereoPreservation = this.stereoPreservation
      let low1 = this.musicBedMidLow1
      let low2 = this.musicBedMidLow2
      for (let i = 0; i < B; i++) {
        dg += gainCoef * (dryT - dg)
        wg += gainCoef * (wetT - wg)
        stereoPreservation += gainCoef * (this.stereoPreservationTarget - stereoPreservation)
        const dryMid = (outL[i] + outR[i]) * 0.5
        const drySide = (outL[i] - outR[i]) * 0.5
        const wetMid = (this.wetL[i] + this.wetR[i]) * 0.5
        const wetSide = (this.wetL[i] - this.wetR[i]) * 0.5
        low1 += alpha * (wetMid - dryMid - low1)
        low2 += alpha * (low1 - low2)
        const mid = (dg + wg) * dryMid + wg * low2
        const preservedWetSide = wetSide + stereoPreservation * (drySide - wetSide)
        const side = dg * drySide + wg * preservedWetSide
        outL[i] = softClip(mid + side)
        outR[i] = softClip(mid - side)
      }
      this.stereoPreservation = stereoPreservation
      this.musicBedMidLow1 = low1
      this.musicBedMidLow2 = low2
    } else {
      let preservation = this.stereoPreservation
      for (let i = 0; i < B; i++) {
        dg += gainCoef * (dryT - dg)
        wg += gainCoef * (wetT - wg)
        preservation += gainCoef * (this.stereoPreservationTarget - preservation)
        const sideCorrection = preservation * ((outL[i] - outR[i]) - (this.wetL[i] - this.wetR[i])) * 0.5
        outL[i] = softClip(dg * outL[i] + wg * (this.wetL[i] + sideCorrection))
        outR[i] = softClip(dg * outR[i] + wg * (this.wetR[i] - sideCorrection))
      }
      this.stereoPreservation = preservation
    }
    this.dryGState = dg
    this.wetGState = wg
  }

  getLatencySamples(): number {
    // 实测 HRIR 的主到达时间计入播放位置补偿；解析/合成网格仍为 512。
    return this.speakers.length > 0 ? this.dryLineL.length : 0
  }

  getHrtfSource(): string { return this.grid?.source ?? 'MIT KEMAR compact' }

  /**
   * 时变重采样（小数延迟线 + 线性插值，与 Rust 侧逐位对齐）：buf 就地重采样 n 个样本，
   * 每输出样本依次——
   *   1) 输入样本写入环形延迟线（写指针 +1）；
   *   2) delay += 1 − rate（rate>1 读指针前移 → 时间压缩/音调升高；<1 后移 → 拉伸）；
   *   3) delay 钳位 [RESAMP_MIN_DELAY, RESAMP_MAX_DELAY]——延迟线饱和后速率回落 1
   *      （恒定速率下效果持续约 (MAX−START)/|rate−1| 样本，规划书 §4.6 简化模型）；
   *   4) 读指针 pos = 最新样本索引 − (delay − 1)，floor/frac 线性插值（f64 计算、f32 写回）。
   * rate==1 直通（调用方保证不进入本方法）。
   */
  private resampleSpeaker(s: number, buf: AudioBuffer, n: number, rate: number): void {
    const DLINE = RESAMP_LINE
    const base = s * DLINE
    let wp = this.rsmpPos[s]
    let delay = this.rsmpDelay[s]
    for (let i = 0; i < n; i++) {
      this.rsmpRing[base + wp] = buf[i]
      wp = (wp + 1) % DLINE
      delay += 1 - rate
      if (delay < RESAMP_MIN_DELAY) delay = RESAMP_MIN_DELAY
      else if (delay > RESAMP_MAX_DELAY) delay = RESAMP_MAX_DELAY
      const pos = (wp - 1 + DLINE) % DLINE - (delay - 1)
      const i0 = Math.floor(pos)
      const frac = pos - i0
      let idx0 = i0 % DLINE
      if (idx0 < 0) idx0 += DLINE
      let idx1 = idx0 + 1
      if (idx1 >= DLINE) idx1 = 0
      buf[i] = this.rsmpRing[base + idx0] * (1 - frac) + this.rsmpRing[base + idx1] * frac
    }
    this.rsmpPos[s] = wp
    this.rsmpDelay[s] = delay
  }

  /**
   * 双耳去相关（§4.7 声源大小 size）：buf 就地延迟 size·6 样本（一阶线性插值延迟线，
   * 与 Rust 侧 SpeakerState::decorr_next 逐位对齐）——
   *   1) 输入样本写入环形延迟线（写指针 +1）；
   *   2) 读指针 pos = 最新样本索引 − delay（delay = size·6 ∈ (0, 6]；
   *      delay>0 时 pos < newest，双抽头均为已写样本）；
   *   3) floor/frac 线性插值（f64 计算、f32 写回）。
   * 仅右耳源调用（左耳不延迟，产生双耳去相关的"更宽方向感"）；size=0 时调用方
   * 跳过（直通，不触碰延迟线状态）。
   */
  private decorrRight(s: number, buf: AudioBuffer, n: number): void {
    const DLINE = DECORR_LINE
    const base = s * DLINE
    const d = this.decorrDelay[s]
    let wp = this.decorrPos[s]
    for (let i = 0; i < n; i++) {
      this.decorrRing[base + wp] = buf[i]
      wp = (wp + 1) % DLINE
      const newest = (wp + DLINE - 1) % DLINE
      const pos = newest - d
      const i0 = Math.floor(pos)
      const frac = pos - i0
      let idx0 = i0 % DLINE
      if (idx0 < 0) idx0 += DLINE
      let idx1 = idx0 + 1
      if (idx1 >= DLINE) idx1 = 0
      buf[i] = this.decorrRing[base + idx0] * (1 - frac) + this.decorrRing[base + idx1] * frac
    }
    this.decorrPos[s] = wp
  }

  reset(): void {
    this.ambienceExtractor?.reset()
    this.lfeState = 0; this.lfePos = 0; this.lfeLine.fill(0)
    for (const convolution of this.convDual) convolution.reset()
    for (let s = 0; s < this.convL.length; s++) {
      this.convL[s].reset()
      this.convR[s].reset()
    }
    if (this.airState.length > 0) this.airState.fill(0)
    if (this.occState.length > 0) this.occState.fill(0)
    if (this.dryLineL.length > 0) {
      this.dryLineL.fill(0)
      this.dryLineR.fill(0)
    }
    this.dryPos = 0
    this.musicBedMidLow1 = 0
    this.musicBedMidLow2 = 0
    this.stereoPreservation = this.stereoPreservationTarget
    // 多普勒重采样状态清零（延迟线/写指针/小数延迟回初始；与 Rust reset_stream 一致）
    if (this.rsmpRing.length > 0) this.rsmpRing.fill(0)
    if (this.rsmpPos.length > 0) {
      this.rsmpPos.fill(0)
      this.rsmpDelay.fill(RESAMP_START_DELAY)
    }
    for (let s = 0; s < this.propagation.length; s++) {
      this.propagation[s]?.reset()
      this.propagationBlend[s] = this.propagationTarget[s]
    }
    // 双耳去相关状态清零（延迟线/写指针；与 Rust reset_stream 一致）
    if (this.decorrRing.length > 0) this.decorrRing.fill(0)
    if (this.decorrPos.length > 0) this.decorrPos.fill(0)
    // 增益平滑/IR 重装载状态机回稳态：干湿混合增益与 distGain 当前值置 NaN
    // （renderProcess 首块直接跳到完整目标——组缩放渲染时才可知）。淡出中
    // （phase=1）未完成的待装 IR 必须立即装载——丢弃会让卷积器停留在旧 IR
    // （配置语义错误：声称 size/方向已变实际没变），reset 已清全部流式状态，
    // 此刻装载无爆音顾虑。
    this.dryGState = NaN
    this.wetGState = NaN
    for (let s = 0; s < this.distGainCur.length; s++) this.distGainCur[s] = NaN
    for (let s = 0; s < this._configuredN; s++) {
      this.diffuseCur[s] = this.speakers[s].diffuse ?? 0
      this.polarityCur[s] = this.speakers[s].polarity ?? 1
    }
    if (this.fadePhase.length > 0) {
      const M = this.grid ? this.grid.hrirLength : 0
      for (let s = 0; s < this._configuredN; s++) {
        if (this.fadePhase[s] === 1) {
          // 淡出中未完成的待装 IR 立即装载（丢弃会让卷积器停留在旧 IR——配置语义
          // 错误：声称 size/方向已变实际没变）；reset 已清全部流式状态，无爆音顾虑
          this.loadSpeakerIr(s, this.pendingIrL.subarray(s * M, (s + 1) * M), this.pendingIrR.subarray(s * M, (s + 1) * M))
        }
        if (this.hasIr[s]) {
          // 与全新后端 setConfig 后状态对齐（"reset 后与全新逐位一致"回归）：
          // 装载过的槽位统一回到"放行重建期 + 淡入"起点
          this.fadePhase[s] = 2
          this.fadeCount[s] = -PARTITION_SIZE
        } else {
          this.fadePhase[s] = 0
          this.fadeCount[s] = 0
        }
      }
    }
    // 房间状态清零（历史环/低通状态/FDN 延迟线与指针；与 Rust reset_stream 一致）
    this.room?.reset()
    // 配置/扬声器/IR 保留（reset 仅清流式状态）
  }
}
