/**
 * TsConvolverBackend —— 空间渲染 TS 参考后端（兼 Rust/WASM 数值对拍 ground truth）
 *
 * 结构（每扬声器两枚 Convolver，复用 dsp/Convolver.ts 分区 FFT 卷积）：
 *   - 左耳卷积器：loadIR(该方向左耳 HRIR)，processStereo(扬声器信号, 静音) 的 l 通道 = 左耳湿路；
 *   - 右耳卷积器：loadIR(该方向右耳 HRIR)，processStereo(静音, 扬声器信号) 的 r 通道 = 右耳湿路；
 *   - 两枚 Convolver 均设 mix=1（纯湿），干湿混合在本 backend 层完成。
 * 干路：输入经 512 样本环形延迟线（= Convolver 分区长度，湿路块缓冲延迟），
 *   保证干湿对齐、无梳状滤波。
 *
 * 距离衰减模型（Rust 侧对拍基准，ref=1m、linear max=50m）：
 *   - inverse:      g = min(1, ref/max(d, ref))        —— 1m 内不衰减，之后 1/d；
 *   - linear:       g = max(0, 1-(d-ref)/(max-ref))    —— 1m 内不衰减，1..50m 线性到 0；
 *   - exponential:  g = pow(max(d,ref)/ref, -1)        —— 1m 内不衰减，之后 1/(d/ref)。
 * 另乘扬声器自身 gain（0..2，clamp）。空气吸收：每扬声器独立一阶低通状态，
 *   fc = 4000/(1+d) Hz（系数 a = 1−exp(−2π·fc/fs)，对扬声器信号先滤波后卷积）。
 *
 * 混合：out = ((1−amount)·dry + amount·Σ扬声器湿路) · masterGain，随后输出软限幅
 *   （0.85 软拐点 tanh 渐近 1.0——空间级位于引擎 Limiter 之后无下游保护）。
 * 爆音防护（三道）：① 湿总线能量归一化——同源总线按 1/max(1, √Σ distGain²)
 *   预缩放（多扬声器相干求和不超幅，1~2 只不放大）；② IR 重装载淡变——方向/
 *   布局变化触发 loadIR 前先淡出湿路（256 样本）、装载后淡入，消除 Convolver
 *   状态重置的硬切换；③ 标量增益（distGain/干湿混合）一阶平滑（τ=20ms）防
 *   滑块 zipper。HRIR 生成侧另按近耳 DC 增益 =1 归一（analyticHrtf）。
 * 房间模拟（§4.5 完整版：镜像声源法早期反射 + FDN 晚期混响）**在本 backend 内实现**
 * （roomSim.ts，与 Rust 侧逐位对拍）：config.room !== 'off' 且 roomAmount>0 且
 * 有扬声器时按预设参数表初始化；房间只处理"空间化后的信号"（每 speaker 湿路输出
 * 之后、干湿混合之前）；room=off 或 roomAmount≤0 时全旁路（输出与无房间逐位一致）。
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

import { Convolver } from '../dsp/Convolver'
import { TimeConvolver } from './TimeConvolver'
import type { StereoConvEngine } from './TimeConvolver'
import { sphericalHrtf } from './hrtfInterp'
import { RoomSim, roomParamsFromPreset } from './roomSim'
import type { HrtfGrid, HrtfInterpMode, ListenerState, DistanceModel, RoomPreset, SpatialRenderConfig, VirtualSpeaker } from './types'
import type { SpatialBackend } from './SpatialBackend'

/** 分区长度（与 Convolver 默认分区一致）：湿路块缓冲延迟 = 干路对齐延迟（样本） */
const PARTITION_SIZE = 512
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
 *  空间级位于引擎 Limiter 之后（第 15 级），输出无下游保护——多扬声器相干残余
 *  峰值（能量归一化后低频最坏仍可到 √N·单只）由本软限幅兜底，超幅表现为
 *  温和软压缩而非硬削爆破音。 */
const SOFTCLIP_THRESHOLD = 0.85
/** IR 重装载淡入淡出长度（样本，≈5.3ms @48k）：方向/布局变化触发 loadIR 时，
 *  先淡出旧湿路 → 装载 → 淡入新湿路，消除 Convolver 状态重置的硬切换爆音 */
const RELOAD_FADE_SAMPLES = 256
/** 标量增益平滑时间常数（秒）：distGain/干湿混合增益一阶平滑，防滑块快速拖动的 zipper 噪声 */
const GAIN_SMOOTH_TAU = 0.02

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

/**
 * 50/50 混合（就地于 a，§4.7 声源大小方向模糊）：a[j] = (a[j] + b[j])·0.5。
 * f64 中间量、f32 写回——与 Rust 侧 build_speaker 的混合公式逐位一致。
 */
function mixHalf(a: Float32Array, b: Float32Array): void {
  for (let j = 0; j < a.length; j++) {
    a[j] = (a[j] + b[j]) * 0.5
  }
}

export class TsConvolverBackend implements SpatialBackend {
  private fs = 48000 // 由 loadHrtf(grid.sampleRate) 覆盖
  private grid: HrtfGrid | null = null
  private speakers: VirtualSpeaker[] = []

  // 每扬声器：左/右耳卷积引擎（partitioned=Convolver 分区 FFT / time=TimeConvolver
  // 时域直接卷积，接口同构可互换）+ 空气吸收状态 + 标量增益
  private convL: StereoConvEngine[] = []
  private convR: StereoConvEngine[] = []
  /** 卷积模式：'partitioned'=分区 FFT（默认）/ 'time'=时域直接卷积（契约 spatial_set_convolution_mode） */
  private convMode: 'partitioned' | 'time' = 'partitioned'
  private airState: Float32Array = new Float32Array(0) // 一阶低通 y 状态（每扬声器一个标量）
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

  // 干路延迟线（环形，长度 = 分区长度，与湿路延迟对齐）
  private dryLineL: Float32Array = new Float32Array(0)
  private dryLineR: Float32Array = new Float32Array(0)
  private dryPos = 0

  // 工作 scratch（稳态零分配，仅按需扩容）
  private silenceL: Float32Array = new Float32Array(0) // 左耳卷积静音通道（就地写回会污染，需独立）
  private silenceR: Float32Array = new Float32Array(0) // 右耳卷积静音通道（同上）
  private srcL: Float32Array = new Float32Array(0) // 扬声器滤波信号（左耳卷积输入）
  private srcR: Float32Array = new Float32Array(0) // 同一信号的副本（右耳卷积输入）
  private wetL: Float32Array = new Float32Array(0)
  private wetR: Float32Array = new Float32Array(0)
  /** 湿总线分组 scratch：每扬声器所属组代表索引（-1 未分组；renderProcess 按输入引用分组） */
  private grpOf: Int32Array = new Int32Array(0)
  /** 湿总线分组 scratch：每扬声器组缩放系数（renderProcess 按输入引用分组计算） */
  private grpScale: Float32Array = new Float32Array(0)

  // 当前配置（混合参数）
  private amount = 1
  private masterGain = 1
  private distanceModel: DistanceModel = 'inverse'
  /** 距离衰减参考/最大距离（米，config 可配；缺省 REF_DISTANCE/LINEAR_MAX_DISTANCE） */
  private refDistance = REF_DISTANCE
  private maxDistance = LINEAR_MAX_DISTANCE
  /** 多普勒（§4.6，模式 C）：听者速度（null=未启用 → 直通） */
  private dopplerVelocity: { x: number; y: number; z: number } | null = null
  // 每扬声器重采样状态（小数延迟线，与 Rust 侧 SpeakerState 对齐）：
  private rsmpRing: Float32Array = new Float32Array(0) // 环形延迟线（n×RESAMP_LINE）
  private rsmpPos: Int32Array = new Int32Array(0) // 写指针（环内索引）
  private rsmpDelay: Float64Array = new Float64Array(0) // 小数延迟（样本，f64）
  private rsmpDirX: Float64Array = new Float64Array(0) // 方位单位向量（f64，setConfig 预计算）
  private rsmpDirY: Float64Array = new Float64Array(0)
  private rsmpDirZ: Float64Array = new Float64Array(0)

  // 声源大小 size（§4.7 扩散声源）：右耳去相关一阶线性插值小数延迟线（每 speaker 一条）
  private decorrRing: Float32Array = new Float32Array(0) // n×DECORR_LINE 环形缓冲
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
  private occState: Float32Array = new Float32Array(0)

  // 声源大小方向模糊 scratch（HRIR 对，长度 = hrirLength；loadHrtf 时分配）
  private sizeIrL: Float32Array = new Float32Array(0) // 球谐分支第二方向 HRIR（左耳）
  private sizeIrR: Float32Array = new Float32Array(0)
  private mixIrL: Float32Array = new Float32Array(0) // 最近邻分支 50/50 混合目标（左耳）
  private mixIrR: Float32Array = new Float32Array(0)

  // 房间模拟（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响，roomSim.ts 与 Rust 对拍）
  /** 房间处理器（config.room !== 'off' && roomAmount>0 && 有扬声器时创建；否则 null 旁路） */
  private room: RoomSim | null = null
  /** 上次 RoomSim 构造签名（preset + 扬声器几何 + 阶数）：签名不变时复用实例仅
   *  setAmount 更新混响量——避免每次 setConfig 重建截断 FDN 混响尾产生突变 */
  private roomSig = ''
  /** 早期反射阶数（默认 2；setRoomEarlyOrders 修改，内部/测试接口） */
  private roomEarlyOrders = 2

  /**
   * 上次 syncSpeakers 配置的扬声器数量（增量更新基准）。
   * 用于判定 setConfig 时哪些扬声器槽位是"新增"（需初始化）vs "保留"（状态连续）：
   * 数组本身只扩容不收缩，故 _configuredN（而非数组长度）才反映实际在用槽位数。
   * 仅在 syncSpeakers 末尾更新；显式 reset() 不触碰（配置未变，仅流式状态清零）。
   */
  private _configuredN = 0

  loadHrtf(grid: HrtfGrid): void {
    if (!grid || !Number.isFinite(grid.sampleRate) || grid.sampleRate <= 0) {
      throw new Error('invalid hrtf grid: sampleRate')
    }
    const azCount = grid.azimuths.length
    const elCount = grid.elevations.length
    const expect = elCount * azCount * grid.hrirLength
    if (azCount < 1 || elCount < 1 || grid.hrirLength < 1 || grid.left.length !== expect || grid.right.length !== expect) {
      throw new Error('invalid hrtf grid: layout')
    }
    this.grid = grid
    this.fs = grid.sampleRate
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
    if (this.speakers.length > 0) this.syncSpeakers(true)
  }

  setConfig(config: SpatialRenderConfig): void {
    if (!this.grid) {
      // 网格未装载时视为直通（loadHrtf 必须先于 setConfig，防御性分支）
      this.speakers = []
      return
    }
    this.speakers = config.speakers ?? []
    this.amount = Math.min(1, Math.max(0, config.amount ?? 1))
    this.masterGain = config.masterGain ?? 1
    this.distanceModel = config.distanceModel ?? 'inverse'
    // 距离衰减可配（规划书属性面板：衰减模型/参考距离/最大距离）；钳位防退化
    // （ref ≥ 0.1、max ≥ ref+0.1，linear 分母恒正）
    this.refDistance = Math.max(0.1, config.refDistance ?? REF_DISTANCE)
    this.maxDistance = Math.max(this.refDistance + 0.1, config.maxDistance ?? LINEAR_MAX_DISTANCE)
    // 多普勒（§4.6）：config.dopplerVelocity 缺省 = 无多普勒（复制快照，防外部篡改）
    this.dopplerVelocity = config.dopplerVelocity
      ? { x: config.dopplerVelocity.x, y: config.dopplerVelocity.y, z: config.dopplerVelocity.z }
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
      this.convMode = convMode
      this._configuredN = 0
      // 全新实例无 IR——必须立即装载（不可走淡出重装路径），hasIr 全部归零
      if (this.hasIr.length > 0) this.hasIr.fill(0)
    }
    // 遮挡（§4.7）：config.occlusionAmount（0..1 钳位；缺省/0 = 旁路，与现状逐位一致）
    this.occAmount = Math.min(1, Math.max(0, config.occlusionAmount ?? 0))
    // 插值模式：nearest=最近邻网格查表 / spherical=球谐插值（规划书 §4.1）
    this.interp = config.hrtfInterp === 'spherical' ? 'spherical' : 'nearest'
    // 房间（§4.5 完整版：镜像声源早期反射 + FDN 晚期混响，后端内置——不再由
    // 处理器/导出方叠加；预设参数表 roomSim.ts 与 Rust 侧一致，早期反射阶数默认 2）。
    // room=off 或 roomAmount≤0 或无扬声器 → null（全旁路，与无房间输出逐位一致）。
    // 重建判定按"预设 + 扬声器几何 + 阶数"签名：签名不变时复用旧实例（保留 FDN
    // 混响尾与早期反射历史），仅 setAmount 更新混响量——每次 setConfig 无脑 new
    // 会瞬间截断混响尾（可听突变/小爆音）。
    const roomPreset: RoomPreset = config.room ?? 'off'
    const roomAmount = Math.max(0, config.roomAmount ?? 0)
    const roomActive = roomPreset !== 'off' && roomAmount > 0 && this.speakers.length > 0
    const roomSig = roomActive
      ? roomPreset + '|' + this.roomEarlyOrders + '|' + this.speakers.map(sp =>
        `${Math.fround(sp.azimuthDeg)},${Math.fround(sp.elevationDeg)},${Math.fround(sp.distance)},${sp.channel}`).join(';')
      : ''
    if (roomActive) {
      if (this.room && this.roomSig === roomSig) {
        this.room.setAmount(roomAmount)
      } else {
        this.room = new RoomSim(this.fs, config.speakers, roomParamsFromPreset(roomPreset, this.roomEarlyOrders), roomAmount)
        this.roomSig = roomSig
      }
    } else {
      this.room = null
      this.roomSig = ''
    }
    this.syncSpeakers(false)
  }

  /**
   * 设置早期反射阶数（0=关闭早期反射，只保留 FDN；0..3 钳位）。
   * 内部/测试接口（对应 Rust ABI spatial_set_room 的 early_orders 参数）：
   * 须在 setConfig 之前调用（setConfig 时按当前值初始化房间）。
   */
  setRoomEarlyOrders(orders: number): void {
    this.roomEarlyOrders = Math.min(3, Math.max(0, Math.floor(orders)))
  }

  /** 按当前扬声器配置同步卷积器/状态（方向或网格变化时重装 IR，非热路径） */
  private syncSpeakers(forceReload: boolean): void {
    const grid = this.grid
    if (!grid) return
    const n = this.speakers.length

    // 卷积引擎实例：数量变化时分配/截断（配置变化不重建同索引实例，避免湿路历史抖动；
    // 模式切换已在 setConfig 全量重建）——partitioned=Convolver（分区 FFT）/
    // time=TimeConvolver（时域直接卷积，契约 spatial_set_convolution_mode）
    const mkConv = (): StereoConvEngine =>
      this.convMode === 'time'
        ? new TimeConvolver(this.fs, { partitionSize: PARTITION_SIZE })
        : new Convolver(this.fs, { partitionSize: PARTITION_SIZE })
    while (this.convL.length < n) {
      this.convL.push(mkConv())
      this.convR.push(mkConv())
    }
    if (this.convL.length > n) {
      this.convL.length = n
      this.convR.length = n
    }
    // 每扬声器状态数组按需扩容（保留旧值）
    if (this.airState.length < n) {
      const ns = new Float32Array(n)
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
      this.pendingIrL = pl
      this.pendingIrR = pr
    }
    if (this.occState.length < n) {
      const ns = new Float32Array(n)
      ns.set(this.occState.subarray(0, Math.min(this.occState.length, n)))
      this.occState = ns
    }

    // 干路延迟线（固定 512，湿路对齐）——仅首次分配；setConfig 不重置 dryLine
    // 内容与 dryPos（切场景/切模式保留已有干声数据 → 干路连续不静音；湿路
    // Convolver 若因方向变化 loadIR 重置则从零渐入，干路不受影响）。全量清零
    // 仅由显式 reset() 触发（见 reset()）。
    if (this.dryLineL.length !== PARTITION_SIZE) {
      this.dryLineL = new Float32Array(PARTITION_SIZE)
      this.dryLineR = new Float32Array(PARTITION_SIZE)
      this.dryPos = 0
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
      const newRing = new Float32Array(n * RESAMP_LINE)
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

    // 双耳去相关状态（§4.7）：增量扩容（保留旧数据）
    if (this.decorrRing.length < n * DECORR_LINE) {
      const newRing = new Float32Array(n * DECORR_LINE)
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
      this.decorrPos[s] = 0
      this.airState[s] = 0
      this.occState[s] = 0
      this.distGain[s] = 0
      this.distGainCur[s] = 0
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
      // 距离 f32 量化（O1 审计 1.4）：sp.distance 经 Math.fround 与 Rust ABI
      // VirtualSpeakerRaw.distance: f32 对齐；下游 distanceGain / 空气吸收 fc 公式
      // 均吃同一 f32 量化值，避免 f64 双精度在反距离增益/低通系数处产生 ~1e-7 偏差。
      const d = Math.fround(sp.distance)
      // 距离衰减（公式见文件头） × 扬声器自身增益（0..2 clamp） × 遮挡增益衰减
      this.distGain[s] = distanceGain(this.distanceModel, d, this.refDistance, this.maxDistance) * Math.min(2, Math.max(0, sp.gain ?? 1)) * this.occGain
      // 空气吸收：fc = 4000/(1+d) Hz → 一阶低通系数（d 已 f32 量化）
      const fc = AIR_FILTER_FC_BASE / (1 + Math.fround(d))
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
        if (needReload || forceReload) {
          if (size > 0) {
            const az1 = azF - sizeF * SIZE_BLUR_DEG
            const az2 = azF + sizeF * SIZE_BLUR_DEG
            sphericalHrtf(grid, az1, sp.elevationDeg, this.shIrL, this.shIrR)
            sphericalHrtf(grid, az2, sp.elevationDeg, this.sizeIrL, this.sizeIrR)
            mixHalf(this.shIrL, this.sizeIrL)
            mixHalf(this.shIrR, this.sizeIrR)
          } else {
            sphericalHrtf(grid, sp.azimuthDeg, sp.elevationDeg, this.shIrL, this.shIrR)
          }
          this.queueIr(s, this.shIrL, this.shIrR)
          this.lastShAz[s] = azF
          this.lastShEl[s] = elF
          this.lastShSize[s] = sizeF
        }
      } else {
        const { azIdx, elIdx } = nearestGridIndex(grid, sp.azimuthDeg, sp.elevationDeg)
        if (forceReload || this.lastAzIdx[s] !== azIdx || this.lastElIdx[s] !== elIdx || this.lastSize[s] !== size) {
          const azc = grid.azimuths.length
          const M = grid.hrirLength
          let irL: Float32Array
          let irR: Float32Array
          if (size > 0) {
            // 方向模糊：az ± size·30° 两方向最近邻 HRIR 对 50/50 混合（每耳）
            const az1 = Math.fround(sp.azimuthDeg) - Math.fround(size) * SIZE_BLUR_DEG
            const az2 = Math.fround(sp.azimuthDeg) + Math.fround(size) * SIZE_BLUR_DEG
            const a1 = nearestGridIndex(grid, az1, sp.elevationDeg)
            const a2 = nearestGridIndex(grid, az2, sp.elevationDeg)
            const b1 = (a1.elIdx * azc + a1.azIdx) * M
            const b2 = (a2.elIdx * azc + a2.azIdx) * M
            for (let j = 0; j < M; j++) {
              this.mixIrL[j] = (grid.left[b1 + j] + grid.left[b2 + j]) * 0.5
              this.mixIrR[j] = (grid.right[b1 + j] + grid.right[b2 + j]) * 0.5
            }
            irL = this.mixIrL
            irR = this.mixIrR
          } else {
            const base = (elIdx * azc + azIdx) * M
            irL = grid.left.subarray(base, base + M)
            irR = grid.right.subarray(base, base + M)
          }
          this.queueIr(s, irL, irR)
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
  private queueIr(s: number, irL: Float32Array, irR: Float32Array): void {
    const grid = this.grid
    if (!grid) return
    if (this.hasIr[s]) {
      const M = grid.hrirLength
      this.pendingIrL.set(irL, s * M)
      this.pendingIrR.set(irR, s * M)
      this.fadePhase[s] = 1
      this.fadeCount[s] = RELOAD_FADE_SAMPLES
    } else {
      this.convL[s].loadIR(irL, `sp${s}-L`)
      this.convR[s].loadIR(irR, `sp${s}-R`)
      this.hasIr[s] = 1
      // 淡入起点 = −512（放行重建期）——装载后 512 样本输出恒 0，恢复瞬间起淡入
      this.fadePhase[s] = 2
      this.fadeCount[s] = -PARTITION_SIZE
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
      sphericalHrtf(grid, azimuthDeg, elevationDeg, left, right)
    } else {
      // nearest：最近邻网格查表（与 setConfig 装载分支的 size=0 分支同路径）
      const { azIdx, elIdx } = nearestGridIndex(grid, azimuthDeg, elevationDeg)
      const base = (elIdx * grid.azimuths.length + azIdx) * M
      left.set(grid.left.subarray(base, base + M))
      right.set(grid.right.subarray(base, base + M))
    }
    return { left, right }
  }

  processStereo(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array): void {
    // 立体声：channel ≤ 0 → L 源，其余 → R 源（既有语义，逐位回归）
    this.renderProcess((s) => (this.speakers[s].channel <= 0 ? inL : inR), inL, inR, outL, outR)
  }

  /**
   * 多声道输入渲染（SpatialBackend.processMulti 可选方法）：N 路单声道输入 → 双耳。
   * 与 processStereo 同算法仅输入侧扩展——speaker.channel < inputs.length 时取对应
   * 输入；越界取 0 号输入；干路 = 0/1 号输入（立体声下混）。相同 speaker 配置下
   * 2 路输入与 processStereo 输出逐位一致（回归测试）。
   */
  processMulti(inputs: Float32Array[], outL: Float32Array, outR: Float32Array): void {
    if (inputs.length === 0) {
      // 防御：无输入（处理器多声道路径恒 ≥3 路，不会走到）→ 静音输出
      outL.fill(0)
      outR.fill(0)
      return
    }
    const inL = inputs[0]
    const inR = inputs.length > 1 ? inputs[1] : inputs[0] // 单路输入干路双耳同源
    this.renderProcess((s) => {
      const c = this.speakers[s].channel
      return c < inputs.length ? inputs[c] : inputs[0] // 越界取 0 号输入
    }, inL, inR, outL, outR)
  }

  /**
   * 公共渲染内核（processStereo / processMulti 共用；srcFor 只做源声道选择，
   * 全部 DSP 算术与顺序逐位一致）：
   * 干路延迟线（512 对齐）→ 逐扬声器吸收/距离增益/遮挡/多普勒/去相关/卷积 →
   * 房间早期反射 + FDN → 干湿混合。
   */
  private renderProcess(
    srcFor: (speakerIndex: number) => Float32Array,
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
  ): void {
    const B = Math.min(inL.length, inR.length, outL.length, outR.length)
    if (B <= 0) return
    const n = this.speakers.length
    if (n === 0) {
      // 无扬声器：直通（无额外延迟）
      outL.set(inL.subarray(0, B))
      outR.set(inR.subarray(0, B))
      return
    }
    // scratch 按需扩容（仅尺寸变化时分配一次）
    if (this.silenceL.length < B) {
      this.silenceL = new Float32Array(B)
      this.silenceR = new Float32Array(B)
    }
    if (this.srcL.length < B) {
      this.srcL = new Float32Array(B)
      this.srcR = new Float32Array(B)
    }
    if (this.wetL.length < B) {
      this.wetL = new Float32Array(B)
      this.wetR = new Float32Array(B)
    }
    if (this.grpOf.length < n) {
      this.grpOf = new Int32Array(n)
      this.grpScale = new Float32Array(n)
    }

    // 干路：512 样本延迟线（与湿路块缓冲延迟对齐），写入 out
    for (let i = 0; i < B; i++) {
      outL[i] = this.dryLineL[this.dryPos]
      outR[i] = this.dryLineR[this.dryPos]
      this.dryLineL[this.dryPos] = inL[i]
      this.dryLineR[this.dryPos] = inR[i]
      this.dryPos++
      if (this.dryPos >= PARTITION_SIZE) this.dryPos = 0
    }

    // 湿路：逐扬声器 —— 距离增益（一阶平滑）+ IR 重装载淡变 + 空气吸收 → 左右耳卷积 → 求和（+ 房间早期反射）
    if (this.room) this.room.beginBlock(B)
    this.wetL.fill(0)
    this.wetR.fill(0)
    // 标量增益每样本平滑系数（τ=20ms，防 zipper）
    const gainCoef = 1 - Math.exp(-1 / (this.fs * GAIN_SMOOTH_TAU))
    // —— 湿总线能量归一化（爆音主修复）：按 srcFor 返回的输入数组引用分组（同
    //    引用 = 真同源——多只扬声器吃同一输入时相干求和峰值随 N 增长，5.1 的 L
    //    总线 3 只、7.1.4 可达 7 只）。组内按 1/max(1, √Σ distGain²) 缩放：1~2 只
    //    不放大，多只时能量守恒（响度一致）；残余低频相干峰值（最坏 √N·单只）由
    //    输出软限幅兜底。引用分组对 processMulti 也成立：各 channel 是独立输入 →
    //    各自成组不缩放；越界路由（多个 channel 取同一输入）→ 同引用同组正确合并。
    //    n ≤ 16，O(n²) 分组每块开销可忽略。
    for (let s = 0; s < n; s++) this.grpOf[s] = -1
    for (let s = 0; s < n; s++) {
      if (this.grpOf[s] !== -1) continue
      const srcS = srcFor(s)
      let e = this.distGain[s] * this.distGain[s]
      for (let k = s + 1; k < n; k++) {
        if (this.grpOf[k] === -1 && srcFor(k) === srcS) {
          this.grpOf[k] = s
          e += this.distGain[k] * this.distGain[k]
        }
      }
      this.grpOf[s] = s
      const scale = e > 1 ? 1 / Math.sqrt(e) : 1
      this.grpScale[s] = scale
    }
    for (let s = 0; s < n; s++) {
      const src = srcFor(s) // 源声道选择（processStereo：0=L 其余=R；processMulti：按 channel 索引）
      // 拷贝 + 距离增益：g 一阶平滑逼近目标（目标 = distGain × 组归一化）
      const gTarget = this.distGain[s] * this.grpScale[this.grpOf[s]]
      let g = this.distGainCur[s]
      if (Number.isNaN(g)) g = gTarget // 新槽位/reset 后首块：直接跳完整目标（含组缩放）
      const a = this.airCoef[s]
      const sl = this.srcL.subarray(0, B) // 只喂本块 B 个样本，避免历史最大块长的陈旧尾部被重复卷积
      const sr = this.srcR.subarray(0, B)
      for (let i = 0; i < B; i++) {
        g += gainCoef * (gTarget - g)
        const v = src[i] * g
        sl[i] = v
        sr[i] = v
      }
      this.distGainCur[s] = g
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
      if (this.dopplerVelocity) {
        const rate = dopplerRate(this.dopplerVelocity, this.rsmpDirX[s], this.rsmpDirY[s], this.rsmpDirZ[s])
        if (rate !== 1) {
          this.resampleSpeaker(s, sl, B, rate)
          sr.set(sl.subarray(0, B))
        }
      }

      // 双耳去相关（§4.7 声源大小 size）：右耳源额外小数延迟 size·6 样本（一阶
      // 线性插值延迟线，每 speaker 状态；size=0 直通，不触碰延迟线——回归逐位）
      if (this.decorrDelay[s] > 0) {
        this.decorrRight(s, sr, B)
      }

      // 左耳：processStereo(信号, 静音) → l 通道 = 左耳湿路（就地覆盖 srcL）。
      // 注意：Convolver 就地写回输入数组，故静音通道会被污染——左右耳各用一块
      // 独立静音（silenceL/silenceR），且每扬声器只喂 subarray(0, B) 的 B 个样本，
      // 避免历史最大块长下 scratch 尾部陈旧样本被重复处理（湿路错位）。
      this.convL[s].processStereo(sl, this.silenceL.subarray(0, B))
      this.convR[s].processStereo(this.silenceR.subarray(0, B), sr)
      // IR 重装载淡变状态机（施加在湿路输出端——卷积输出有 512 样本固有块缓冲
      // 延迟，若乘在输入端，淡出要 512 样本后才表现在输出上，而 loadIR 中断放行
      // 是即时的：输出会先硬跳 0 再补跳，等于没淡）。phase1：输出 256 样本线性淡出
      // 到 0 → 此刻执行 loadIR（放行中断发生在该扬声器输出已为 0 时，无缝）→
      // phase2：count 从 −512（分区长）起步对齐放行恢复时刻——装载后 512 样本
      // 放行重建期间输出恒 0（fg=0 无副作用），恢复瞬间 fg 恰好从 0 渐强，盖住
      // 卷积零状态起播的暂态振铃；256 样本淡入完成后回稳态。
      let phase = this.fadePhase[s]
      if (phase !== 0) {
        let count = this.fadeCount[s]
        const M = this.grid ? this.grid.hrirLength : 0
        for (let i = 0; i < B; i++) {
          if (phase === 0) continue // 块内已达稳态：fg=1，后续样本不再触碰
          let fg = 1
          if (phase === 1) {
            count--
            fg = count > 0 ? count / RELOAD_FADE_SAMPLES : 0
            if (count <= 0) {
              this.convL[s].loadIR(this.pendingIrL.subarray(s * M, (s + 1) * M), `sp${s}-L`)
              this.convR[s].loadIR(this.pendingIrR.subarray(s * M, (s + 1) * M), `sp${s}-R`)
              phase = 2
              count = -PARTITION_SIZE
              fg = 0
            }
          } else {
            count++
            if (count >= RELOAD_FADE_SAMPLES) {
              phase = 0 // 稳态（fg=1；count 不再使用）
            } else {
              fg = count > 0 ? count / RELOAD_FADE_SAMPLES : 0
            }
          }
          if (fg !== 1) {
            sl[i] *= fg
            sr[i] *= fg
          }
        }
        this.fadePhase[s] = phase
        this.fadeCount[s] = count
      }
      for (let i = 0; i < B; i++) {
        this.wetL[i] += sl[i]
        this.wetR[i] += sr[i]
      }
      // 房间早期反射（§4.5，设计决策：早期反射施加在 speaker 的湿路输出之后、
      // 干湿混合之前——房间只处理"空间化后的信号"；镜像源抽头，见 roomSim.ts）
      if (this.room) this.room.early(s, sl, sr, B)
    }

    // 房间 FDN 晚期混响 + 混合（§4.5）：fdn 输入 = 湿总线/N，输出混回湿总线；
    // 就地改写 wetL/wetR（随后统一干湿混合）
    if (this.room) this.room.lateAndMix(this.wetL, this.wetR, B)

    // 混合：out = ((1−amount)·dry + amount·wetSum) · masterGain——dryG/wetG 样本级
    // 一阶平滑（NaN 首块直接跳目标），随后输出软限幅（空间级位于引擎 Limiter 之后，
    // 无下游保护；多扬声器相干残余峰值在此软压，超幅为温和压缩而非硬削爆音）
    const dryT = (1 - this.amount) * this.masterGain
    const wetT = this.amount * this.masterGain
    if (Number.isNaN(this.dryGState)) {
      this.dryGState = dryT
      this.wetGState = wetT
    }
    let dg = this.dryGState
    let wg = this.wetGState
    for (let i = 0; i < B; i++) {
      dg += gainCoef * (dryT - dg)
      wg += gainCoef * (wetT - wg)
      outL[i] = softClip(dg * outL[i] + wg * this.wetL[i])
      outR[i] = softClip(dg * outR[i] + wg * this.wetR[i])
    }
    this.dryGState = dg
    this.wetGState = wg
  }

  getLatencySamples(): number {
    // 有扬声器时 = 1 个分区长（湿路块缓冲延迟，干路已对齐）；无扬声器 = 0
    return this.speakers.length > 0 ? PARTITION_SIZE : 0
  }

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
  private resampleSpeaker(s: number, buf: Float32Array, n: number, rate: number): void {
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
  private decorrRight(s: number, buf: Float32Array, n: number): void {
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
    // 多普勒重采样状态清零（延迟线/写指针/小数延迟回初始；与 Rust reset_stream 一致）
    if (this.rsmpRing.length > 0) this.rsmpRing.fill(0)
    if (this.rsmpPos.length > 0) {
      this.rsmpPos.fill(0)
      this.rsmpDelay.fill(RESAMP_START_DELAY)
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
    if (this.fadePhase.length > 0) {
      const M = this.grid ? this.grid.hrirLength : 0
      for (let s = 0; s < this.fadePhase.length; s++) {
        if (this.fadePhase[s] === 1) {
          // 淡出中未完成的待装 IR 立即装载（丢弃会让卷积器停留在旧 IR——配置语义
          // 错误：声称 size/方向已变实际没变）；reset 已清全部流式状态，无爆音顾虑
          this.convL[s].loadIR(this.pendingIrL.subarray(s * M, (s + 1) * M), `sp${s}-L`)
          this.convR[s].loadIR(this.pendingIrR.subarray(s * M, (s + 1) * M), `sp${s}-R`)
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
