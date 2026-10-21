/**
 * WaveForge 音频引擎 v3 —— 引擎总成（EngineV3）
 *
 * 出处/许可：
 *  - 链式架构与参数模型：本项目《音频算法设计文档.md》§2 总体架构（自研）；
 *  - 链内各 DSP 模块（EqChain/MidSide/Deesser/Compressor/Limiter/BassEnhancer/
 *    Convolver/ReverbSimple/LufsMeter/LoudnessComp/Stretch/FFT/features）
 *    的概念来源与许可见各自源文件头部注释（RBJ Cookbook / DSPFilters(MIT) /
 *    kissfft(BSD-3) / stk FreeVerb(MIT) / ITU-R BS.1770 / ISO 226 等）；
 *  - 智能均衡 IEQ（Post）为本文件内置实现，思路参考技术文档 §1.4（自研）；
 *  - 夜间模式（压缩增强 + 6kHz 高频衰减）为 v2 兼容语义（本项目历史功能，自研）。
 *
 * 处理链（顺序固定，见 API_SPEC 辅助模块 A）：
 *   输入 → 响度归一化增益 → 3D 环绕(轻量立体声旋转) → M/S(width + voiceBalance)
 *   → Pre-EQ(用户 EQ) → Deesser → Compressor → NightMode
 *   → 混响(卷积|算法|off 三路路由) → BassEnhancer → LoudnessComp
 *   → IEQ(Post) → [LUFS 采样点] → 空间音频(启用时) → 自定义节点
 *   → 次声高通(可选) → 最终 Limiter → 输出
 *
 * 说明：
 *  - LUFS 采样点严格位于 Limiter 之前（API_SPEC 要求），测的是压限前的节目响度；
 *  - getAnalysis 的内部 2048 点 FFT 取样于 IEQ 之后、Limiter 之前，
 *    按左右平均功率分析（反相信号不会抵消），每累计 2048 样本更新一次；
 *  - Stretch（变速/变调）不内联进主链，仅经 getStretch() 供 gapless/过渡场景调用；
 *  - PCM 工作缓冲按块长缓存复用；setParams 对同一快照重复调用零分配（结构化同步，
 *    不再深拷贝参数/JSON 比较）；IEQ 系数更新、空间配置推导与遥测快照仍在控制周期
 *    创建对象，不宣称整个 process/遥测路径绝对零分配；
 *  - 确定性：同输入同参数必同输出（无随机、无 Date、无 console）。
 */

import type {
  V3EngineParams,
  EngineStats,
  EngineAnalysis,
  EqBand,
  SpectralFeatures,
  CompressorSettings,
  MultibandBandSettings,
  MultibandCompressorSettings,
  DynamicEqSettings,
  DynamicEqBandSettings,
  CrossfeedSettings,
  ChannelCalibrationSettings,
  ReverbSettings,
  IeqTargetCurve,
  SpatialSettings,
  InternalPrecision,
  ProcessingModuleKey,
} from '../types'
import {
  SIMPLE_EQ_FREQUENCIES,
  DEFAULT_PROCESSING_ORDER,
  MAX_PRO_EQ_BANDS,
  createDefaultParams,
  createDefaultSpatialSettings,
} from '../types'
import { EqChain } from '../dsp/EqChain'
import { DynamicEqBank } from '../dsp/DynamicEq'
import { downmixToStereo } from '../dsp/ChannelDownmix'
import type { AudioBuffer } from '../dsp/audioBuffer'
import { Crossfeed } from '../dsp/Crossfeed'
import { EffectTransition, type StereoRender } from '../dsp/EffectTransition'
import { MidSide } from '../dsp/MidSide'
import { Deesser } from '../dsp/Deesser'
import { Compressor } from '../dsp/Compressor'
import { MultibandCompressor } from '../dsp/MultibandCompressor'
import { Limiter } from '../dsp/Limiter'
import { BassEnhancer } from '../dsp/BassEnhancer'
import { SubsonicHighpass } from '../dsp/LowFrequency'
import { Convolver } from '../dsp/Convolver'
import type { PreparedConvolverIR } from '../dsp/Convolver'
import { ReverbSimple } from '../dsp/ReverbSimple'
import { LufsMeter } from '../dsp/LufsMeter'
import { LoudnessComp } from '../dsp/LoudnessComp'
import { Biquad } from '../dsp/biquad'
import { Stretch } from '../dsp/Stretch'
import { fft, hannWindow, frequencyBins } from '../dsp/fft'
import {
  computeRms,
  computeZcr,
  spectralCentroid,
  spectralRolloff,
  spectralFlatness,
  spectralCrest,
} from '../dsp/features'
// —— 第 15 级：空间音频（纯 TS 内联；复用 src/spatial/* 纯模块，无浏览器依赖） ——
import { TsConvolverBackend } from '../spatial/TsConvolverBackend'
import type { PreparedRoomHrir } from '../spatial/TsConvolverBackend'
import { generateAnalyticHrtfGrid } from '../spatial/analyticHrtf'
import { createMeasuredHrtfGrid } from '../spatial/measuredHrtf'
import { instantSpeakers } from '../spatial/types'
import { createMultichannelSpeakers, detectMultichannelLayout, headLockedSpeakers } from '../spatial/layouts'
import { stageSpeakers, stageRoom } from '../spatial/scenes'
import { computeRelativeDirection, computeTrajectoryPosition } from '../spatial/controller'
import type { HseProcessingNode } from '../integration/ProcessingNode'
import { assertProcessingNode } from '../integration/ProcessingNode'
import { resolveMusicSourceRoute } from '../spatial/worldRouting'
import { AmbisonicDecoder, getAmbisonicSpeakers, type SpatialInputFormat } from '../spatial/AmbisonicDecoder'
import { prepareHrtfGrid } from '../spatial/HrtfDataset'
import type { HrtfGrid } from '../spatial/types'
import { CrosstalkCancellation } from '../spatial/CrosstalkCancellation'
import { StereoUpmixer } from '../spatial/StereoUpmixer'
import { StereoDecorrelator } from '../spatial/StereoDecorrelator'
import type { HeadPose } from '../spatial/HeadPose'
import type {
  AudioObject,
  VirtualSpeaker,
  VirtualSpeakerCfg,
  SpeakerRoute,
  TrajectoryKeyframes,
  ListenerState,
  InstantSpatialSettings,
  HeadLockedSettings,
  StageSettings,
  AmbienceSettings,
  WorldSettings,
  SpatialRenderConfig,
} from '../spatial/types'

/** 引擎内部 FFT 分析窗长（2 的幂，N/2+1 = 1025 个 bin） */
const ANALYSIS_WINDOW = 2048
/** 用户 Pre-EQ 的预分配容量；实际只处理启用的频段数。 */
const MAX_PRE_EQ_BANDS = MAX_PRO_EQ_BANDS
/** IEQ（Post）内部参数 EQ 段数（1 倍频程 10 段） */
const IEQ_BAND_COUNT = 10
/** IEQ 控制频率（1 倍频程，与 v2 专业 10 段一致） */
const IEQ_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
/** 响度归一化实时增益平滑时间常数（秒），防抽吸（技术文档 §7.2 慢速 AGC） */
const NORM_SMOOTH_SEC = 3.0
/** 手动音量（调音室音量滑块 externalGainDb）平滑时间常数（秒）：
 *  跟手（~80ms 到位）又不产生咔哒声；自动归一化仍走 NORM_SMOOTH_SEC 慢速防抽吸 */
const MANUAL_GAIN_SMOOTH_SEC = 0.08

// ==================== setParams 结构化同步（无整份深拷贝） ====================
// 引擎持有唯一参数快照，setParams 只把发生变化的字段/子树写入引擎自有对象：
//  - 未变化的字段、子对象与数组保持原引用（连续相同 setParams 零分配）；
//  - 数组同长度时逐元素就地更新，只有长度变化才重新分配骨架；
//  - 卷积 IR 仍按引用比较/保留，不参与 JSON 或深比较；
//  - 调用方对象只读，引擎快照不持有调用方的可变数组（IR 按设计共享引用）。

/** 无房间 HRIR 时的共享空数组：避免 setParams 默认参数每次调用分配新数组。 */
const EMPTY_ROOM_HRIR: readonly PreparedRoomHrir[] = []

/** 旧快照缺少可选模块时的引擎内置默认值（只读，不写入调用方对象）。 */
const DEFAULT_DYNAMIC_EQ: DynamicEqSettings = {
  enabled: false, frequency: 1000, q: 1, thresholdDb: -30, ratio: 4,
  maxReductionDb: 12, attackMs: 10, releaseMs: 150,
}
const DEFAULT_CROSSFEED: CrossfeedSettings = { enabled: false, amount: 0.3, cutoffHz: 700, delayMs: 0.2 }

/** 三段压缩缺省频段参数：旧快照未带 multiband 时不再每次新建一整套默认参数。 */
const DEFAULT_MULTIBAND: MultibandCompressorSettings = {
  lowMidHz: 180,
  midHighHz: 4000,
  low: { thresholdDb: -24, ratio: 3, kneeDb: 6, attackMs: 12, releaseMs: 180, makeupDb: 0 },
  mid: { thresholdDb: -20, ratio: 2.5, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0 },
  high: { thresholdDb: -24, ratio: 2, kneeDb: 6, attackMs: 5, releaseMs: 100, makeupDb: 0 },
}

/** IEQ 目标曲线常量：按曲线复制进引擎数组，不每次改参新建数组。 */
const IEQ_TARGETS: Record<IeqTargetCurve, readonly number[]> = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  warm: [4, 3.5, 2.5, 1.5, 0.5, 0, -0.5, -1.5, -2.5, -3.5],
  bright: [-3.5, -2.5, -1.5, -0.5, 0, 0.5, 1.5, 2.5, 3.5, 4],
  vocal: [-1.5, -1, 0, 1, 2, 2.5, 2, 1, 0, -0.5],
}

/** 字符串哈希（FNV-1a 32 位）：把配置中的枚举/ID 写入数值签名，不创建字符串。 */
function hashText(text: string | undefined): number {
  let hash = 2166136261
  if (text !== undefined) {
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  }
  return hash >>> 0
}

/** 写入空间渲染配置签名（无对象分配），返回有效长度；用于替代 JSON.stringify 比较。 */
function writeSpatialSignature(config: SpatialRenderConfig, signature: Float64Array): number {
  let i = 0
  signature[i++] = hashText(config.ambienceExtraction)
  signature[i++] = config.earlyReflectionOrders ?? -1
  signature[i++] = config.multichannelAuto === true ? 1 : 0
  signature[i++] = config.lfeChannel ?? -2
  signature[i++] = hashText(config.room)
  signature[i++] = config.roomAmount
  signature[i++] = config.roomSize ?? 1
  const listener = config.roomListener
  signature[i++] = listener === undefined ? 0 : 1
  if (listener !== undefined) {
    signature[i++] = listener.position.x
    signature[i++] = listener.position.y
    signature[i++] = listener.position.z
    signature[i++] = listener.yaw
    signature[i++] = listener.pitch
    signature[i++] = listener.roll
  }
  signature[i++] = config.earlyAmount ?? 1
  signature[i++] = config.lateAmount ?? 1
  signature[i++] = hashText(config.earlyReflectionModel)
  signature[i++] = config.amount
  signature[i++] = hashText(config.distanceModel)
  signature[i++] = config.refDistance ?? 1
  signature[i++] = config.maxDistance ?? 50
  signature[i++] = hashText(config.hrtfInterp)
  signature[i++] = hashText(config.convolution)
  signature[i++] = config.masterGain
  signature[i++] = hashText(config.airAbsorption)
  signature[i++] = config.coherentInputNormalization === true ? 1 : 0
  signature[i++] = config.musicBedMidCrossoverHz ?? 0
  signature[i++] = config.stereoPreservation ?? 0
  signature[i++] = config.occlusionAmount ?? -1
  const speakers = config.speakers
  signature[i++] = speakers.length
  for (let s = 0; s < speakers.length; s++) {
    const speaker = speakers[s]
    signature[i++] = speaker.channel
    signature[i++] = speaker.azimuthDeg
    signature[i++] = speaker.elevationDeg
    signature[i++] = speaker.distance
    signature[i++] = speaker.gain
    signature[i++] = speaker.size
    signature[i++] = speaker.ambience === true ? 1 : 0
    signature[i++] = speaker.diffuse ?? 0
    signature[i++] = speaker.polarity ?? 1
    signature[i++] = speaker.propagation === true ? 1 : 0
    const roomPosition = speaker.roomPosition
    signature[i++] = roomPosition === undefined ? 0 : 1
    if (roomPosition !== undefined) {
      signature[i++] = roomPosition.x
      signature[i++] = roomPosition.y
      signature[i++] = roomPosition.z
    }
    signature[i++] = speaker.propagationVelocity ?? Number.NaN
    signature[i++] = hashText(speaker.id)
    signature[i++] = hashText(speaker.route)
  }
  return i
}

/** 引擎侧时钟：优先高分辨率 performance.now（Worklet 与 Node 均可），退化到 Date。 */
const engineClock = typeof globalThis.performance?.now === 'function'
  ? () => globalThis.performance.now()
  : () => Date.now()

/**
 * 音频线程配置工作量计数（诊断用）：只递增、读取后由调用方清零，不参与音频输出。
 * 用于区分超预算尖峰发生在「参数/空间配置」还是稳态 DSP。
 */
export interface EngineConfigWork {
  paramsApplied: number
  poseUpdates: number
  roomHrirItems: number
  hrtfLoads: number
  spatialConfigs: number
  preparedIrLoads: number
  localIrLoads: number
  /** 空间后端配置耗时（毫秒，含 setConfig 内 HRIR/房间/卷积器装载）。 */
  spatialConfigMs: number
  reverbConfigMs: number
  /** 上一次 process 回调内发生的配置耗时（含过渡提交的延迟配置）。 */
  blockConfigMs: number
  // —— 空间后端 prepared/local 归因（来自 TsConvolverBackend.configWork） ——
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

/** 单次 setParams 的逐模块变化标志；替代原先的 JSON key 比较。 */
interface ParamChanges {
  preEq: boolean
  eqEnabled: boolean
  dynamicEq: boolean
  crossfeed: boolean
  channelCalibration: boolean
  deesser: boolean
  compressor: boolean
  nightMode: boolean
  reverb: boolean
  reverbRoute: boolean
  bass: boolean
  bassHeadroom: boolean
  subsonic: boolean
  loudnessCompensation: boolean
  limiter: boolean
  ieq: boolean
  surround: boolean
  midSide: boolean
  spatial: boolean
  ambisonicTransform: boolean
  spatialInputFormat: boolean
  processingOrder: boolean
}

function emptyParamChanges(): ParamChanges {
  return {
    preEq: false, eqEnabled: false, dynamicEq: false, crossfeed: false, channelCalibration: false,
    deesser: false, compressor: false, nightMode: false, reverb: false, reverbRoute: false,
    bass: false, bassHeadroom: false, subsonic: false, loudnessCompensation: false, limiter: false,
    ieq: false, surround: false, midSide: false, spatial: false, ambisonicTransform: false,
    spatialInputFormat: false, processingOrder: false,
  }
}

/** 单字段同步：值相同则保留原值，返回是否变化。 */
function assignField<T extends object, K extends keyof T>(target: T, key: K, value: T[K]): boolean {
  if (Object.is(target[key], value)) return false
  target[key] = value
  return true
}

/** 原始值数组同步：同长度就地更新，长度变化才重新分配。 */
function syncPrimitiveArray<T extends string | number>(target: T[], source: readonly T[]): boolean {
  const lengthChanged = target.length !== source.length
  if (lengthChanged) target.length = source.length
  let changed = lengthChanged
  for (let i = 0; i < source.length; i++) {
    if (!Object.is(target[i], source[i])) {
      target[i] = source[i]
      changed = true
    }
  }
  return changed
}

/** 对象数组同步：复用已有元素对象，只有新增长度才创建新元素。 */
function syncObjectArray<T extends object>(target: T[], source: readonly T[],
  create: () => T, syncOne: (destination: T, origin: T) => boolean): boolean {
  const lengthChanged = target.length !== source.length
  if (lengthChanged) target.length = source.length
  let changed = lengthChanged
  for (let i = 0; i < source.length; i++) {
    let destination = target[i]
    if (destination === undefined) {
      destination = create()
      target[i] = destination
      changed = true
    }
    if (syncOne(destination, source[i])) changed = true
  }
  return changed
}

function createEqBand(): EqBand {
  return { frequency: 1000, gain: 0, q: 1 }
}

function syncEqBand(destination: EqBand, source: EqBand): boolean {
  let changed = assignField(destination, 'frequency', source.frequency)
  changed = assignField(destination, 'gain', source.gain) || changed
  changed = assignField(destination, 'q', source.q) || changed
  changed = assignField(destination, 'type', source.type) || changed
  return changed
}

function createDynamicEqBand(): DynamicEqBandSettings {
  return { enabled: false, frequency: 1000, q: 1, thresholdDb: -30, ratio: 4,
    maxReductionDb: 12, attackMs: 10, releaseMs: 150 }
}

function syncDynamicEqBand(destination: DynamicEqBandSettings,
  source: DynamicEqBandSettings): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'frequency', source.frequency) || changed
  changed = assignField(destination, 'q', source.q) || changed
  changed = assignField(destination, 'thresholdDb', source.thresholdDb) || changed
  changed = assignField(destination, 'ratio', source.ratio) || changed
  changed = assignField(destination, 'maxReductionDb', source.maxReductionDb) || changed
  changed = assignField(destination, 'attackMs', source.attackMs) || changed
  changed = assignField(destination, 'releaseMs', source.releaseMs) || changed
  return changed
}

function createDynamicEq(source: DynamicEqSettings): DynamicEqSettings {
  const target: DynamicEqSettings = {
    enabled: source.enabled, frequency: source.frequency, q: source.q,
    thresholdDb: source.thresholdDb, ratio: source.ratio, maxReductionDb: source.maxReductionDb,
    attackMs: source.attackMs, releaseMs: source.releaseMs,
  }
  if (source.bands !== undefined) target.bands = source.bands.map((band) => ({ ...band }))
  return target
}

function syncDynamicEq(destination: DynamicEqSettings, source: DynamicEqSettings): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'frequency', source.frequency) || changed
  changed = assignField(destination, 'q', source.q) || changed
  changed = assignField(destination, 'thresholdDb', source.thresholdDb) || changed
  changed = assignField(destination, 'ratio', source.ratio) || changed
  changed = assignField(destination, 'maxReductionDb', source.maxReductionDb) || changed
  changed = assignField(destination, 'attackMs', source.attackMs) || changed
  changed = assignField(destination, 'releaseMs', source.releaseMs) || changed
  if (source.bands === undefined) {
    if (destination.bands !== undefined) {
      destination.bands = undefined
      changed = true
    }
  } else if (destination.bands === undefined) {
    destination.bands = source.bands.map((band) => ({ ...band }))
    changed = true
  } else {
    changed = syncObjectArray(destination.bands, source.bands, createDynamicEqBand, syncDynamicEqBand) || changed
  }
  return changed
}

function syncCrossfeed(destination: CrossfeedSettings, source: CrossfeedSettings): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'amount', source.amount) || changed
  changed = assignField(destination, 'cutoffHz', source.cutoffHz) || changed
  changed = assignField(destination, 'delayMs', source.delayMs) || changed
  return changed
}

function syncChannelCalibration(destination: ChannelCalibrationSettings,
  source: ChannelCalibrationSettings): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'leftDb', source.leftDb) || changed
  changed = assignField(destination, 'rightDb', source.rightDb) || changed
  return changed
}

function syncDeesser(destination: V3EngineParams['deesser'], source: V3EngineParams['deesser']): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'centerHz', source.centerHz) || changed
  changed = assignField(destination, 'q', source.q) || changed
  changed = assignField(destination, 'thresholdDb', source.thresholdDb) || changed
  changed = assignField(destination, 'ratio', source.ratio) || changed
  changed = assignField(destination, 'attackMs', source.attackMs) || changed
  changed = assignField(destination, 'releaseMs', source.releaseMs) || changed
  changed = assignField(destination, 'splitBand', source.splitBand) || changed
  changed = assignField(destination, 'mix', source.mix) || changed
  return changed
}

function createMultibandBand(): MultibandBandSettings {
  return { thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0 }
}

function syncMultibandBand(destination: MultibandBandSettings, source: MultibandBandSettings): boolean {
  let changed = assignField(destination, 'thresholdDb', source.thresholdDb)
  changed = assignField(destination, 'ratio', source.ratio) || changed
  changed = assignField(destination, 'kneeDb', source.kneeDb) || changed
  changed = assignField(destination, 'attackMs', source.attackMs) || changed
  changed = assignField(destination, 'releaseMs', source.releaseMs) || changed
  changed = assignField(destination, 'makeupDb', source.makeupDb) || changed
  return changed
}

function createMultiband(): MultibandCompressorSettings {
  return {
    lowMidHz: 180,
    midHighHz: 4000,
    low: createMultibandBand(),
    mid: createMultibandBand(),
    high: createMultibandBand(),
  }
}

function syncMultiband(destination: MultibandCompressorSettings,
  source: MultibandCompressorSettings): boolean {
  let changed = assignField(destination, 'lowMidHz', source.lowMidHz)
  changed = assignField(destination, 'midHighHz', source.midHighHz) || changed
  changed = syncMultibandBand(destination.low, source.low) || changed
  changed = syncMultibandBand(destination.mid, source.mid) || changed
  changed = syncMultibandBand(destination.high, source.high) || changed
  return changed
}

function syncCompressor(destination: CompressorSettings, source: CompressorSettings): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'mode', source.mode) || changed
  changed = assignField(destination, 'upwardMaxGainDb', source.upwardMaxGainDb) || changed
  changed = assignField(destination, 'transientPreserve', source.transientPreserve) || changed
  changed = assignField(destination, 'thresholdDb', source.thresholdDb) || changed
  changed = assignField(destination, 'ratio', source.ratio) || changed
  changed = assignField(destination, 'kneeDb', source.kneeDb) || changed
  changed = assignField(destination, 'attackMs', source.attackMs) || changed
  changed = assignField(destination, 'releaseMs', source.releaseMs) || changed
  changed = assignField(destination, 'makeupDb', source.makeupDb) || changed
  changed = assignField(destination, 'outputGain', source.outputGain) || changed
  if (source.multiband === undefined) {
    if (destination.multiband !== undefined) {
      destination.multiband = undefined
      changed = true
    }
  } else if (destination.multiband === undefined) {
    destination.multiband = {
      lowMidHz: source.multiband.lowMidHz,
      midHighHz: source.multiband.midHighHz,
      low: { ...source.multiband.low },
      mid: { ...source.multiband.mid },
      high: { ...source.multiband.high },
    }
    changed = true
  } else {
    changed = syncMultiband(destination.multiband, source.multiband) || changed
  }
  return changed
}

/** 混响同步：IR 只复制引用；其余字段逐项比较，路由相关字段单独标记。 */
function syncReverb(destination: ReverbSettings, source: ReverbSettings, changes: ParamChanges): void {
  const enabledChanged = assignField(destination, 'enabled', source.enabled)
  const modeChanged = assignField(destination, 'mode', source.mode)
  const algorithmic = destination.algorithmic
  const algorithmicSource = source.algorithmic
  let algorithmicChanged = assignField(algorithmic, 'type', algorithmicSource.type)
  algorithmicChanged = assignField(algorithmic, 'roomSize', algorithmicSource.roomSize) || algorithmicChanged
  algorithmicChanged = assignField(algorithmic, 'damping', algorithmicSource.damping) || algorithmicChanged
  algorithmicChanged = assignField(algorithmic, 'wet', algorithmicSource.wet) || algorithmicChanged
  algorithmicChanged = assignField(algorithmic, 'dry', algorithmicSource.dry) || algorithmicChanged
  algorithmicChanged = assignField(algorithmic, 'preDelayMs', algorithmicSource.preDelayMs) || algorithmicChanged
  algorithmicChanged = assignField(algorithmic, 'width', algorithmicSource.width) || algorithmicChanged
  const convolution = destination.convolution
  const convolutionSource = source.convolution
  // IR 引用按设计共享（数百万样本不复制），变化由 setParams 单独判定。
  assignField(convolution, 'ir', convolutionSource.ir)
  const irIdChanged = assignField(convolution, 'irId', convolutionSource.irId)
  const irNameChanged = assignField(convolution, 'irName', convolutionSource.irName)
  const purposeChanged = assignField(convolution, 'purpose', convolutionSource.purpose)
  const mixChanged = assignField(convolution, 'mix', convolutionSource.mix)
  const preDelayChanged = assignField(convolution, 'preDelayMs', convolutionSource.preDelayMs)
  const partitionChanged = assignField(convolution, 'partitionSize', convolutionSource.partitionSize)
  const dePeriodizeChanged = assignField(convolution, 'dePeriodize', convolutionSource.dePeriodize)
  changes.reverbRoute = enabledChanged || modeChanged || partitionChanged || dePeriodizeChanged || purposeChanged
  changes.reverb = changes.reverbRoute || algorithmicChanged || irIdChanged || irNameChanged
    || mixChanged || preDelayChanged
}

function syncBassEnhancer(destination: V3EngineParams['bassEnhancer'],
  source: V3EngineParams['bassEnhancer']): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'cutoffHz', source.cutoffHz) || changed
  changed = assignField(destination, 'q', source.q) || changed
  changed = assignField(destination, 'harmonicType', source.harmonicType) || changed
  changed = assignField(destination, 'harmonicGain', source.harmonicGain) || changed
  changed = assignField(destination, 'mix', source.mix) || changed
  changed = assignField(destination, 'levelDb', source.levelDb) || changed
  changed = assignField(destination, 'lowBoostDb', source.lowBoostDb) || changed
  return changed
}

function createLoudnessCompBand(): { frequency: number; gain: number } {
  return { frequency: 1000, gain: 0 }
}

function syncLoudnessCompBand(destination: { frequency: number; gain: number },
  source: { frequency: number; gain: number }): boolean {
  let changed = assignField(destination, 'frequency', source.frequency)
  changed = assignField(destination, 'gain', source.gain) || changed
  return changed
}

function syncLoudnessCompensation(destination: V3EngineParams['loudnessCompensation'],
  source: V3EngineParams['loudnessCompensation']): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'mode', source.mode) || changed
  changed = assignField(destination, 'preset', source.preset) || changed
  changed = assignField(destination, 'volumePercent', source.volumePercent) || changed
  changed = assignField(destination, 'maxBoostDb', source.maxBoostDb) || changed
  changed = assignField(destination, 'smoothingSeconds', source.smoothingSeconds) || changed
  changed = syncObjectArray(destination.bands, source.bands, createLoudnessCompBand, syncLoudnessCompBand) || changed
  return changed
}

function syncLoudnessNormalization(destination: V3EngineParams['loudnessNormalization'],
  source: V3EngineParams['loudnessNormalization']): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'targetLufs', source.targetLufs) || changed
  changed = assignField(destination, 'maxGainDb', source.maxGainDb) || changed
  changed = assignField(destination, 'minGainDb', source.minGainDb) || changed
  changed = assignField(destination, 'useRealtimeMeter', source.useRealtimeMeter) || changed
  changed = assignField(destination, 'externalGainDb', source.externalGainDb) || changed
  changed = assignField(destination, 'replayGainMode', source.replayGainMode) || changed
  changed = assignField(destination, 'replayGainDb', source.replayGainDb) || changed
  return changed
}

function syncIeq(destination: V3EngineParams['ieq'], source: V3EngineParams['ieq']): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'strength', source.strength) || changed
  changed = assignField(destination, 'targetCurve', source.targetCurve) || changed
  changed = assignField(destination, 'timeConstantSec', source.timeConstantSec) || changed
  return changed
}

function syncSurround(destination: V3EngineParams['surround3d'],
  source: V3EngineParams['surround3d']): boolean {
  let changed = assignField(destination, 'enabled', source.enabled)
  changed = assignField(destination, 'distance', source.distance) || changed
  changed = assignField(destination, 'speed', source.speed) || changed
  changed = assignField(destination, 'angle', source.angle) || changed
  changed = assignField(destination, 'direction', source.direction) || changed
  return changed
}

function syncPosition(destination: { x: number; y: number; z: number },
  source: { x: number; y: number; z: number }): boolean {
  let changed = assignField(destination, 'x', source.x)
  changed = assignField(destination, 'y', source.y) || changed
  changed = assignField(destination, 'z', source.z) || changed
  return changed
}

function syncListener(destination: ListenerState, source: ListenerState): boolean {
  let changed = syncPosition(destination.position, source.position)
  changed = assignField(destination, 'yaw', source.yaw) || changed
  changed = assignField(destination, 'pitch', source.pitch) || changed
  changed = assignField(destination, 'roll', source.roll) || changed
  return changed
}

function createAudioObject(): AudioObject {
  return { id: '', position: { x: 0, y: 0, z: 0 }, gain: 1, size: 0 }
}

function syncAudioObject(destination: AudioObject, source: AudioObject): boolean {
  let changed = assignField(destination, 'id', source.id)
  changed = syncPosition(destination.position, source.position) || changed
  changed = assignField(destination, 'gain', source.gain) || changed
  changed = assignField(destination, 'size', source.size) || changed
  changed = assignField(destination, 'diffuse', source.diffuse) || changed
  changed = assignField(destination, 'polarity', source.polarity) || changed
  changed = assignField(destination, 'route', source.route) || changed
  return changed
}

function createSpeakerCfg(): VirtualSpeakerCfg {
  return { azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0 }
}

function syncSpeakerCfg(destination: VirtualSpeakerCfg, source: VirtualSpeakerCfg): boolean {
  let changed = assignField(destination, 'azimuthDeg', source.azimuthDeg)
  changed = assignField(destination, 'elevationDeg', source.elevationDeg) || changed
  changed = assignField(destination, 'distance', source.distance) || changed
  changed = assignField(destination, 'gain', source.gain) || changed
  changed = assignField(destination, 'size', source.size) || changed
  changed = assignField(destination, 'diffuse', source.diffuse) || changed
  changed = assignField(destination, 'polarity', source.polarity) || changed
  changed = assignField(destination, 'route', source.route) || changed
  changed = assignField(destination, 'muted', source.muted) || changed
  return changed
}

function createTrajectoryKeyframe(): { t: number; position: { x: number; y: number; z: number } } {
  return { t: 0, position: { x: 0, y: 0, z: 0 } }
}

function syncTrajectoryKeyframe(destination: { t: number; position: { x: number; y: number; z: number } },
  source: { t: number; position: { x: number; y: number; z: number } }): boolean {
  let changed = assignField(destination, 't', source.t)
  changed = syncPosition(destination.position, source.position) || changed
  return changed
}

function createTrajectory(): TrajectoryKeyframes {
  return { sourceId: '', keyframes: [] }
}

function syncTrajectory(destination: TrajectoryKeyframes, source: TrajectoryKeyframes): boolean {
  let changed = assignField(destination, 'sourceId', source.sourceId)
  changed = syncObjectArray(destination.keyframes, source.keyframes, createTrajectoryKeyframe, syncTrajectoryKeyframe) || changed
  return changed
}

function syncInstant(destination: InstantSpatialSettings, source: InstantSpatialSettings): boolean {
  let changed = assignField(destination, 'spreadDeg', source.spreadDeg)
  changed = assignField(destination, 'amount', source.amount) || changed
  changed = assignField(destination, 'room', source.room) || changed
  changed = assignField(destination, 'roomAmount', source.roomAmount) || changed
  changed = assignField(destination, 'multichannelAuto', source.multichannelAuto) || changed
  changed = assignField(destination, 'multichannelLayout', source.multichannelLayout) || changed
  return changed
}

function syncHeadLocked(destination: HeadLockedSettings, source: HeadLockedSettings): boolean {
  let changed = assignField(destination, 'layout', source.layout)
  changed = assignField(destination, 'heightLayer', source.heightLayer) || changed
  changed = assignField(destination, 'bottomLayer', source.bottomLayer) || changed
  changed = syncObjectArray(destination.speakers, source.speakers, createSpeakerCfg, syncSpeakerCfg) || changed
  changed = syncPrimitiveArray(destination.routes, source.routes) || changed
  return changed
}

function syncWorld(destination: WorldSettings, source: WorldSettings): boolean {
  let changed = assignField(destination, 'propagation', source.propagation)
  changed = assignField(destination, 'moveSpeed', source.moveSpeed) || changed
  changed = syncListener(destination.listener, source.listener) || changed
  changed = syncObjectArray(destination.sources, source.sources, createAudioObject, syncAudioObject) || changed
  changed = syncObjectArray(destination.trajectories, source.trajectories, createTrajectory, syncTrajectory) || changed
  changed = assignField(destination, 'playhead', source.playhead) || changed
  changed = assignField(destination, 'occlusion', source.occlusion) || changed
  return changed
}

function syncStage(destination: StageSettings, source: StageSettings): boolean {
  let changed = assignField(destination, 'preset', source.preset)
  changed = assignField(destination, 'seat', source.seat) || changed
  changed = assignField(destination, 'roomSize', source.roomSize) || changed
  changed = assignField(destination, 'reverbAmount', source.reverbAmount) || changed
  changed = syncObjectArray(destination.customSources, source.customSources, createAudioObject, syncAudioObject) || changed
  return changed
}

function syncAmbience(destination: AmbienceSettings, source: AmbienceSettings): boolean {
  let changed = assignField(destination, 'extraction', source.extraction)
  changed = assignField(destination, 'enabled', source.enabled) || changed
  changed = assignField(destination, 'amount', source.amount) || changed
  return changed
}

/** 空间设置同步：字段/数组就地更新；变换与输入格式变化单独标记供引擎做结构动作。 */
function syncSpatialSettings(destination: SpatialSettings, source: SpatialSettings,
  changes: ParamChanges): void {
  let changed = false
  const inputFormatChanged = assignField(destination, 'inputFormat', source.inputFormat)
  changes.spatialInputFormat = inputFormatChanged
  changed = inputFormatChanged || changed
  changed = assignField(destination, 'renderStyle', source.renderStyle) || changed
  changed = assignField(destination, 'earlyAmount', source.earlyAmount) || changed
  changed = assignField(destination, 'lateAmount', source.lateAmount) || changed
  changed = assignField(destination, 'decorrelation', source.decorrelation) || changed
  changed = assignField(destination, 'earlyReflectionModel', source.earlyReflectionModel) || changed
  changed = assignField(destination, 'budgetMode', source.budgetMode) || changed
  changed = assignField(destination, 'mode', source.mode) || changed
  changed = assignField(destination, 'masterGain', source.masterGain) || changed
  changed = assignField(destination, 'convolution', source.convolution) || changed
  changed = assignField(destination, 'hrtfInterp', source.hrtfInterp) || changed
  changed = assignField(destination, 'distanceModel', source.distanceModel) || changed
  changed = assignField(destination, 'refDistance', source.refDistance) || changed
  changed = assignField(destination, 'maxDistance', source.maxDistance) || changed
  changed = syncInstant(destination.instant, source.instant) || changed
  changed = syncHeadLocked(destination.headLocked, source.headLocked) || changed
  changed = syncWorld(destination.world, source.world) || changed
  changed = syncStage(destination.stage, source.stage) || changed
  changed = syncAmbience(destination.ambience, source.ambience) || changed

  let transformChanged = false
  if (source.ambisonicTransform === undefined) {
    if (destination.ambisonicTransform !== undefined) {
      destination.ambisonicTransform = undefined
      transformChanged = true
    }
  } else {
    let transform = destination.ambisonicTransform
    if (transform === undefined) {
      transform = { yawDeg: 0, pitchDeg: 0, rollDeg: 0, orderGains: [] }
      destination.ambisonicTransform = transform
      transformChanged = true
    }
    transformChanged = assignField(transform, 'yawDeg', source.ambisonicTransform.yawDeg) || transformChanged
    transformChanged = assignField(transform, 'pitchDeg', source.ambisonicTransform.pitchDeg) || transformChanged
    transformChanged = assignField(transform, 'rollDeg', source.ambisonicTransform.rollDeg) || transformChanged
    transformChanged = syncPrimitiveArray(transform.orderGains, source.ambisonicTransform.orderGains) || transformChanged
  }
  changes.ambisonicTransform = transformChanged
  changed = transformChanged || changed

  if (source.speakerCancellation === undefined) {
    if (destination.speakerCancellation !== undefined) {
      destination.speakerCancellation = undefined
      changed = true
    }
  } else {
    let cancellation = destination.speakerCancellation
    if (cancellation === undefined) {
      cancellation = { enabled: false, amount: 0, delayMs: 0, cutoffHz: 0 }
      destination.speakerCancellation = cancellation
      changed = true
    }
    changed = assignField(cancellation, 'enabled', source.speakerCancellation.enabled) || changed
    changed = assignField(cancellation, 'amount', source.speakerCancellation.amount) || changed
    changed = assignField(cancellation, 'delayMs', source.speakerCancellation.delayMs) || changed
    changed = assignField(cancellation, 'cutoffHz', source.speakerCancellation.cutoffHz) || changed
  }
  changes.spatial = changed
}

// ==================== 第 15 级：空间音频配置推导（port 自 spatial/fusion.ts） ====================
// fusion.ts 含浏览器/worklet 副作用（SpatialNode/localStorage/backendIndex），不可被纯 DSP
// 内核 EngineV3 导入；以下为 fusion.spatialConfigFromParams / speakersFromParams 的纯函数移植，
// 复用 layouts/scenes/controller 纯模块，行为与 fusion 逐支一致。
// 差异（EngineV3 为立体声内核）：① 无 output 分支（无该字段）；② hrtfInterp 直接由 settings
// 给出（无 perfMode 映射）；③ 多声道模式消费实际离散输入并支持按声道数选择标准布局；
// ④ 不附加 ambience 扬声器（FOA 动态混合是处理器层能力，内联级不实现，ambience 字段保留待扩展）。

/** 扬声器方位角 → 输入声道索引（az≤0→左源 0、az>0→右源 1） */
function headLockedChannel(azimuthDeg: number): number {
  return azimuthDeg <= 0 ? 0 : 1
}

/**
 * headLocked 预设多声道布局：普通立体声节目下由 EngineV3 内部上混成真实多声道，
 * 再逐声道经 TsConvolverBackend HRTF 渲染（中心/环绕/顶置不再只是 L/R 的复制）。
 * 自定义布局没有标准声道映射，仍按 routes/方位就近路由。
 */
type HeadLockedUpmixLayout = '51' | '514' | '71' | '714'

/**
 * 预设扬声器索引 → 上混器输出声道（HSE 内部顺序）：
 * 布局顺序取自 layouts.ts（C/FL/FR/SL/SR[/RL/RR][/TFL/TFR/TRL/TRR]），
 * 上混器顺序为 WAVE（5.1: FL FR FC LFE SL SR；7.1/7.1.4 的后环在 SL/SR 之前），
 * 7.1/7.1.4 由 _upmix71Channels/_upmix714Channels 重排后交给后端。
 */
const HEAD_LOCKED_UPMIX_CHANNELS: Record<HeadLockedUpmixLayout, readonly number[]> = {
  '51': [2, 0, 1, 4, 5],
  '514': [2, 0, 1, 4, 5, 6, 7, 8, 9],
  '71': [2, 0, 1, 6, 7, 4, 5],
  '714': [2, 0, 1, 6, 7, 4, 5, 8, 9, 10, 11],
}

/** 预设扬声器对应的节目侧（仅供干声静音闸门使用；不影响后端声道选择）。 */
const HEAD_LOCKED_UPMIX_SIDES: Record<HeadLockedUpmixLayout, readonly SpeakerRoute[]> = {
  '51': ['both', 'l', 'r', 'l', 'r'],
  '514': ['both', 'l', 'r', 'l', 'r', 'l', 'r', 'l', 'r'],
  '71': ['both', 'l', 'r', 'l', 'r', 'l', 'r'],
  '714': ['both', 'l', 'r', 'l', 'r', 'l', 'r', 'l', 'r', 'l', 'r'],
}

/**
 * 是否需要为 headLocked 布局建立内部立体声上混：
 * 仅四套预设布局 + 普通立体声节目（≤2 声道）且输入格式未显式声明为多声道/Ambisonics。
 * 关闭顶置层的 .4 布局退回地面层上混（否则顶置通道会白白抽走前方高频）。
 */
function headLockedUpmixLayout(s: SpatialSettings, inputChannels: number): HeadLockedUpmixLayout | null {
  if (s.mode !== 'headLocked' || inputChannels > 2) return null
  const format = s.inputFormat
  if (format !== undefined && format !== 'channels') return null
  switch (s.headLocked.layout) {
    case '51': return '51'
    case '514': return s.headLocked.heightLayer ? '514' : '51'
    case '71': return '71'
    case '714': return s.headLocked.heightLayer ? '714' : '71'
    default: return null
  }
}

/** headLocked 预设布局 → 上混声道驱动的虚拟扬声器（顺序与 layouts.ts 预设一致）。 */
function headLockedUpmixSpeakers(s: SpatialSettings, layout: HeadLockedUpmixLayout): VirtualSpeaker[] {
  const configs = headLockedSpeakers(s.headLocked)
  const channels = HEAD_LOCKED_UPMIX_CHANNELS[layout]
  const sides = HEAD_LOCKED_UPMIX_SIDES[layout]
  const speakers: VirtualSpeaker[] = []
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]
    speakers.push({
      channel: channels[i] ?? 2,
      azimuthDeg: cfg.azimuthDeg,
      elevationDeg: cfg.elevationDeg,
      distance: cfg.distance,
      gain: cfg.muted ? 0 : cfg.gain,
      size: cfg.size,
      diffuse: cfg.diffuse,
      polarity: cfg.polarity,
      route: sides[i] ?? 'both',
    })
  }
  return speakers
}

/** 模式 B 单只扬声器按路由展开（'l'→0、'r'→1、'both'→两只半增益、undefined→就近） */
function routeSpeaker(cfg: VirtualSpeakerCfg, route: VirtualSpeakerCfg['route']): VirtualSpeaker[] {
  const sourceRoute = route ?? cfg.route ?? (Math.abs(cfg.azimuthDeg) < 0.001 ? 'both' : undefined)
  const base = {
    azimuthDeg: cfg.azimuthDeg,
    elevationDeg: cfg.elevationDeg,
    distance: cfg.distance,
    gain: cfg.gain,
    size: cfg.size,
    diffuse: cfg.diffuse,
    polarity: cfg.polarity,
  }
  if (sourceRoute === 'both') {
    return [
      { ...base, channel: 0, gain: cfg.gain * 0.5 },
      { ...base, channel: 1, gain: cfg.gain * 0.5 },
    ]
  }
  const channel = sourceRoute === 'side' ? 2 : sourceRoute === 'r' ? 1 : sourceRoute === 'l' ? 0 : headLockedChannel(cfg.azimuthDeg)
  return [{ ...base, channel }]
}

/** 世界/舞台对象使用固定节目输入；移动只改变方位，不会在正前方切换 L/R 内容。 */
function routeObjectSpeaker(src: AudioObject, direction: { azimuthDeg: number; elevationDeg: number; distance: number }, propagation = false,
  propagationVelocity?: number): VirtualSpeaker[] {
  const base = { ...direction, id: src.id, gain: src.gain, size: src.size, diffuse: src.diffuse, polarity: src.polarity, propagation, propagationVelocity }
  const route = resolveMusicSourceRoute(src)
  if (route === 'both') {
    return [
      { ...base, channel: 0, gain: src.gain * 0.5 },
      { ...base, channel: 1, gain: src.gain * 0.5 },
    ]
  }
  return [{ ...base, channel: route === 'side' ? 2 : route === 'r' ? 1 : 0 }]
}

/** 模式 C 声源轨迹查询（轨迹优先，无匹配→null 回退静态位置） */
function trajectoryPosition(world: WorldSettings, sourceId: string): { x: number; y: number; z: number } | null {
  const traj = world.trajectories.find((t) => t.sourceId === sourceId)
  if (!traj) return null
  return computeTrajectoryPosition(traj.keyframes, world.playhead)
}

/** 按轨迹求径向速度，供传播读头连续运动；听者转头不改变径向速度。 */
function trajectoryRadialVelocity(world: WorldSettings, sourceId: string): number {
  const trajectory = world.trajectories.find((item) => item.sourceId === sourceId)
  if (!trajectory || trajectory.keyframes.length < 2) return 0
  const halfWindow = 0.01
  const before = computeTrajectoryPosition(trajectory.keyframes, world.playhead - halfWindow)
  const after = computeTrajectoryPosition(trajectory.keyframes, world.playhead + halfWindow)
  const listener = world.listener.position
  const distance = (position: typeof before) => Math.hypot(position.x - listener.x, position.y - listener.y, position.z - listener.z)
  const velocity = (distance(after) - distance(before)) / (2 * halfWindow)
  return Number.isFinite(velocity) ? Math.max(-342, Math.min(342, velocity)) : 0
}

/** SpatialSettings → 虚拟扬声器列表（port 自 fusion.speakersFromParams） */
function isAmbisonicFormat(format: SpatialSettings['inputFormat']): format is Exclude<SpatialInputFormat, 'channels'> {
  return format === 'ambix' || format === 'ambix1' || format === 'ambix2' || format === 'ambix3' || format === 'fuma'
}
function speakersFromSettings(s: SpatialSettings, inputChannels = 2): VirtualSpeaker[] {
  if (isAmbisonicFormat(s.inputFormat)) return getAmbisonicSpeakers(s.inputFormat).map(speaker => ({ ...speaker }))
  if (s.inputFormat === 'stereo51') return createMultichannelSpeakers('51')
  if (s.inputFormat === 'stereo71') return createMultichannelSpeakers('71')
  if (s.mode === 'instant') {
    if (s.instant.multichannelAuto) return createMultichannelSpeakers(s.instant.multichannelLayout === 'auto' ? detectMultichannelLayout(inputChannels) : s.instant.multichannelLayout)
    return instantSpeakers(s.instant)
  }
  if (s.mode === 'headLocked') {
    // 5.1/5.1.4/7.1/7.1.4 预设 + 普通立体声：先矩阵上混到布局声道，再逐只 HRTF。
    const upmix = headLockedUpmixLayout(s, inputChannels)
    if (upmix !== null) return headLockedUpmixSpeakers(s, upmix)
    const routes = s.headLocked.routes
    return headLockedSpeakers(s.headLocked).flatMap((cfg, i) =>
      routeSpeaker(cfg.muted ? { ...cfg, gain: 0 } : cfg, s.headLocked.layout === 'custom' && i < routes.length ? routes[i] : undefined),
    )
  }
  if (s.mode === 'stage') {
    const custom = s.stage.customSources.flatMap((src) => {
      const rel = computeRelativeDirection(
        { position: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0 },
        src.position,
      )
      return routeObjectSpeaker(src, rel)
    })
    return [
      ...stageSpeakers(s.stage).flatMap(cfg => routeSpeaker(cfg, cfg.route)),
      ...custom,
    ]
  }
  if (s.mode === 'world') {
    return s.world.sources.flatMap((src) => {
      const pos = trajectoryPosition(s.world, src.id) ?? src.position
      const rel = computeRelativeDirection(s.world.listener, pos)
      const velocity = s.world.propagation === true ? trajectoryRadialVelocity(s.world, src.id) : undefined
      return routeObjectSpeaker(src, rel, s.world.propagation === true, velocity).map(speaker => ({ ...speaker, roomPosition: { ...pos } }))
    })
  }
  return []
}

/**
 * 头锁定 / 世界 / 舞台模式下，虚拟声源就是节目声道的唯一路由：
 * 当路由到某声道的虚拟声源全部被静音（muted 或音量 0）时，干声床对应声道也必须静音，
 * 否则「静音」只消掉湿声，原声仍从耳机输出（用户实测反馈）。
 */
function dryGateTargetsFromSpeakers(
  speakers: readonly VirtualSpeaker[],
  mode: SpatialSettings['mode'],
): { l: number; r: number } {
  if (mode !== 'headLocked' && mode !== 'world' && mode !== 'stage') return { l: 1, r: 1 }
  let totalL = 0, totalR = 0, activeL = 0, activeR = 0
  for (const speaker of speakers) {
    // 上混布局的 channel 指向上混声道；节目侧由 route 标记（中心=both），
    // 这样「所有扬声器静音 → 干声也静音」的语义在 5.1/7.1 布局下继续成立。
    const feedsLeft = speaker.route === 'l' || speaker.route === 'both' || speaker.route === 'side'
      || (speaker.route === undefined && speaker.channel <= 0)
    const feedsRight = speaker.route === 'r' || speaker.route === 'both' || speaker.route === 'side'
      || (speaker.route === undefined && speaker.channel === 1)
    if (feedsLeft) { totalL++; if (speaker.gain > 1e-6) activeL++ }
    if (feedsRight) { totalR++; if (speaker.gain > 1e-6) activeR++ }
  }
  return {
    l: totalL > 0 ? (activeL > 0 ? 1 : 0) : 1,
    r: totalR > 0 ? (activeR > 0 ? 1 : 0) : 1,
  }
}

/**
 * SpatialSettings → 后端渲染配置（port 自 fusion.spatialConfigFromParams）。
 * stage 模式 room/roomAmount 取场景预设（与 instant 全局房间解耦）；wet/dry amount
 * 恒取 instant.amount（与 fusion 一致——空间化强度全局由 instant.amount 控制）。
 * world 模式透传遮挡量 + 默认静止听者速度（多普勒 UI 驱动后续经 setParams 更新）。
 */
function spatialConfigFromSettings(s: SpatialSettings, inputChannels = 2, sampleRate = 48000, pose?: HeadPose): SpatialRenderConfig {
  const stageActive = s.mode === 'stage'
  const speakers = speakersFromSettings(s, inputChannels)
  const foa = isAmbisonicFormat(s.inputFormat)
  const stereoUpmix = s.inputFormat === 'stereo51' || s.inputFormat === 'stereo71'
  // headLocked 预设多声道布局的节目上混：输入本身已是真实多声道，按全湿处理
  // （音乐床分频会只保留 3.5kHz 以下干声的中频，正好抵掉中心声道内容）。
  const headLockedUpmix = headLockedUpmixLayout(s, inputChannels)
  const discrete = foa || stereoUpmix || headLockedUpmix !== null
    || (s.mode === 'instant' && s.instant.multichannelAuto && inputChannels > 2)
  const natural = s.renderStyle !== 'focused' && !discrete
  if (s.ambience.enabled && s.ambience.amount > 0) {
    for (const azimuthDeg of [-65, 65, -140, 140]) speakers.push({
      id: `ambience-${azimuthDeg}`, channel: azimuthDeg < 0 ? 0 : 1, azimuthDeg,
      elevationDeg: 10, distance: 2.5, gain: s.ambience.amount * 0.25,
      size: 0.8, ambience: true, diffuse: s.ambience.extraction === 'difference' ? 1 : 0,
      polarity: s.ambience.extraction === 'difference' && azimuthDeg >= 0 ? -1 : 1,
    })
  }
  if (pose && s.mode !== 'headLocked') {
    for (const speaker of speakers) {
      const az = speaker.azimuthDeg * Math.PI / 180, el = speaker.elevationDeg * Math.PI / 180
      const direction = computeRelativeDirection({ ...pose, position: { x: 0, y: 0, z: 0 } }, {
        x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: Math.cos(az) * Math.cos(el),
      })
      speaker.azimuthDeg = direction.azimuthDeg; speaker.elevationDeg = direction.elevationDeg
    }
  }
  return {
    speakers,
    ambienceExtraction: s.ambience.extraction ?? 'pca',
    earlyReflectionOrders: s.budgetMode === 'lowLatency' ? 0
      : s.budgetMode === 'auto' && sampleRate >= 96000 && speakers.length >= 8 ? 1 : 2,
    multichannelAuto: foa || stereoUpmix || headLockedUpmix !== null
      || (s.mode === 'instant' && s.instant.multichannelAuto),
    lfeChannel: foa ? -1 : 3,
    room: stageActive ? stageRoom(s.stage) : s.instant.room,
    roomAmount: stageActive ? s.stage.reverbAmount : s.instant.roomAmount,
    roomSize: stageActive ? s.stage.roomSize : 1,
    roomListener: s.mode === 'world' ? { ...s.world.listener, yaw: s.world.listener.yaw + (pose?.yaw ?? 0),
      pitch: s.world.listener.pitch + (pose?.pitch ?? 0), roll: s.world.listener.roll + (pose?.roll ?? 0) } : undefined,
    earlyAmount: s.earlyAmount ?? 1,
    lateAmount: s.lateAmount ?? 1,
    earlyReflectionModel: s.earlyReflectionModel ?? 'cues',
    // 离线引擎各模式都处理同一首立体声音乐，世界对象也不是独立分轨。
    // 保留至少约三分之二直达声，避免多扬声器 HRTF 与原声深度相消。
    // 自然外化不再压得过低：默认 70% 强度时湿声约 0.6（旧约 0.28），保留约 40% 原声保证自然度；
    // 100% 强度时全湿。清晰定位（focused）仍按用户强度全量。
    amount: natural ? s.instant.amount * (0.5 + 0.5 * s.instant.amount) : s.instant.amount,
    distanceModel: s.distanceModel ?? 'inverse',
    refDistance: s.refDistance,
    maxDistance: s.maxDistance,
    hrtfInterp: s.hrtfInterp,
    convolution: s.convolution,
    masterGain: s.masterGain,
    airAbsorption: 'natural',
    coherentInputNormalization: true,
    musicBedMidCrossoverHz: natural ? 3500 : 0,
    stereoPreservation: natural ? 0.2 : 0,
    occlusionAmount: s.mode === 'world' ? s.world.occlusion : undefined,
  }
}

export class EngineV3 {
  private readonly _fs: number
  private readonly _channels: number
  private _lastInputChannels = 2
  private _spatialInputFormatValid = true
  private readonly _ambisonic: AmbisonicDecoder
  private readonly _stereoUpmixer51: StereoUpmixer
  private readonly _stereoUpmixer71: StereoUpmixer
  private readonly _stereoUpmixer514: StereoUpmixer
  private readonly _stereoUpmixer714: StereoUpmixer
  /** headLocked 虚拟扬声器环绕声道的早期反射式去相关。 */
  private readonly _spatialDecorrelator: StereoDecorrelator
  private readonly _upmix71Channels: AudioBuffer[] = []
  private readonly _upmix714Channels: AudioBuffer[] = []
  /** 当前生效的 headLocked 内部上混布局（null = 未启用，按原 L/R 路由）。 */
  private _spatialHeadLockedUpmix: HeadLockedUpmixLayout | null = null
  private _headPose: HeadPose | undefined
  private _spatialHrtfPending = false
  private _pendingHrtfRoomHrir: PreparedRoomHrir[] = []
  private readonly _speakerCancellation: CrosstalkCancellation
  private _params: V3EngineParams
  /** 引擎自有参数快照的逐模块变化标志（复用对象，避免每次 setParams 新建）。 */
  private readonly _paramChanges: ParamChanges = emptyParamChanges()
  /** 配置工作量计数（诊断；读取后由 Worklet 清零）。 */
  private readonly _configWork: EngineConfigWork = {
    paramsApplied: 0, poseUpdates: 0, roomHrirItems: 0, hrtfLoads: 0, spatialConfigs: 0,
    preparedIrLoads: 0, localIrLoads: 0, spatialConfigMs: 0, reverbConfigMs: 0, blockConfigMs: 0,
    directPreparedHits: 0, directPreparedMisses: 0, preparedSpeakerIrs: 0, localSpeakerIrs: 0,
    roomPreparedHits: 0, roomPreparedMisses: 0, roomRebuilds: 0, convolverInstances: 0,
    preparedPrimes: 0, preparedEntries: 0,
  }
  /** 首次 setParams 需要完整下发所有模块配置。 */
  private _paramsInitialized = false
  private readonly _transitions: Record<string, EffectTransition> = {}
  private _compressorMode = 'downward'
  private _surroundSettings: V3EngineParams['surround3d'] = {
    enabled: false, distance: 0.5, speed: 1, angle: 0, direction: 1,
  }
  private _spatialBlockChannels: readonly AudioBuffer[] | null = null
  private _spatialBlockOffset = 0
  private _spatialInputLayout = '51'
  private readonly _spatialViews: AudioBuffer[][] = []
  private _spatialMultiViews: AudioBuffer[][] = []
  private readonly _spatialViewsByChannelCount: AudioBuffer[][][] = []
  /** 空间多声道输入当前使用的声道数（select 后复用对应视图，精度切换时重建）。 */
  private _spatialMultiChannelCount = 6
  private readonly _renderers: Record<string, StereoRender> = {
    eq: (l, r) => this._eqChain.processStereo(l, r),
    dynamicEq: (l, r) => this._dynamicEq.processStereo(l, r),
    deesser: (l, r) => this._deesser.processStereo(l, r),
    compressor: (l, r) => this._compressorMode === 'multiband'
      ? this._multibandCompressor.processStereo(l, r) : this._compressor.processStereo(l, r),
    nightMode: (l, r) => { this._nightCompressor.processStereo(l, r); this._nightShelfL.processBlock(l, l); this._nightShelfR.processBlock(r, r) },
    reverb: (l, r) => this._useConvolver ? this._convolver.processStereo(l, r) : this._reverbSimple.processStereo(l, r),
    bassEnhancer: (l, r) => this._bass.processStereo(l, r),
    loudnessCompensation: (l, r) => this._loudnessComp.processStereo(l, r),
    ieq: (l, r) => this._ieqChain.processStereo(l, r),
    crossfeed: (l, r) => this._crossfeed.processStereo(l, r),
    midSide: (l, r) => this._midSide.processStereo(l, r),
    surround: (l, r) => this.renderSurround(l, r),
    subsonic: (l, r) => this._subsonic.processStereo(l, r),
    spatial: (l, r, offset = 0) => this.renderSpatial(l, r, offset),
  }

  // —— 链上 DSP 模块（构造时固定采样率，setParams 只重算系数） ——
  private readonly _eqChain: EqChain
  private readonly _dynamicEq: DynamicEqBank
  private readonly _crossfeed: Crossfeed
  private readonly _midSide: MidSide
  private _channelCalibEnabled = false
  private _channelTargetL = 1
  private _channelTargetR = 1
  private _channelGainL = 1
  private _channelGainR = 1
  private readonly _channelGainAlpha: number
  private readonly _deesser: Deesser
  private readonly _compressor: Compressor
  private readonly _multibandCompressor: MultibandCompressor
  private readonly _limiter: Limiter
  private readonly _bass: BassEnhancer
  private readonly _subsonic: SubsonicHighpass
  private _convolver: Convolver // 非 readonly：dePeriodize 选项变化时重建（死参数修复）
  private _convolverDePeriodize = true
  private _convolverPartitionSize = 512
  private readonly _reverbSimple: ReverbSimple
  private readonly _lufs: LufsMeter
  /** 归一化测输入响度，避免把自身增益再次计入反馈而只补偿一半。 */
  private readonly _normMeter: LufsMeter
  private readonly _loudnessComp: LoudnessComp
  private readonly _stretch: Stretch

  // —— 夜间模式（压缩增强 + 6kHz 高频 shelf，v2 兼容语义） ——
  private readonly _nightCompressor: Compressor
  private readonly _nightShelfL: Biquad
  private readonly _nightShelfR: Biquad
  private _nightActive = false

  // —— IEQ（Post）：内部实现，参考技术文档 §1.4 ——
  private readonly _ieqChain: EqChain
  private _ieqActive = false
  private _ieqStrength = 0.5
  private _ieqSmooth = 0.01
  private readonly _ieqGains = new Float32Array(IEQ_BAND_COUNT)
  private readonly _ieqLevels = new Float32Array(IEQ_BAND_COUNT)
  private readonly _ieqBands: EqBand[] = []
  private readonly _ieqZeroBands: EqBand[] = []
  private _ieqTargets: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  private readonly _ieqBinRanges: Array<[number, number]> = []

  // —— 分析路径（2048 点 FFT，每累计一窗更新一次） ——
  private readonly _ring: Float32Array
  private readonly _ringR: Float32Array
  private readonly _timeBufR: Float32Array
  private _ringPos = 0
  private _analysisPos = 0
  private _analysisReady = false
  private readonly _timeBuf: Float32Array
  private readonly _real: Float32Array
  private readonly _imag: Float32Array
  private readonly _magBuf: Float32Array
  private readonly _hann: Float32Array
  private readonly _binFreqs: Float32Array
  private readonly _featCache: SpectralFeatures

  // —— 工作缓冲（惰性扩容，稳态零分配） ——
  private _workL: AudioBuffer = new Float32Array(0)
  private _workR: AudioBuffer = new Float32Array(0)
  /** 最近一次处理的块长：精度切换后把工作缓冲指回对应视图。 */
  private _workBlockLength = 128
  private _precisionMode: InternalPrecision = 'float32'
  /** 已下发给各后端的精度；null 表示尚未下发（初始配置必须下发一次）。 */
  private _precisionApplied: InternalPrecision | null = null
  private _processingOrder: ProcessingModuleKey[] = [...DEFAULT_PROCESSING_ORDER]

  // —— 运行时状态 ——
  private _preEqActive = false
  /** Pre-EQ 频段对象池与输出缓冲：setParams 只改数值，不新建对象/数组。 */
  private readonly _preEqBandPool: EqBand[] = []
  private readonly _preEqBands: EqBand[] = []
  /** 夜间模式压缩参数对象：复用，避免每次改参新建。 */
  private readonly _nightSettings: CompressorSettings = {
    enabled: true, mode: 'downward', thresholdDb: -20, ratio: 4, kneeDb: 6,
    attackMs: 10, releaseMs: 150, makeupDb: 0, outputGain: 1,
  }
  /** 双音箱串扰参数对象：复用，避免每次空间改参新建。 */
  private readonly _cancellationSettings = { enabled: false, amount: 0, delayMs: 0, cutoffHz: 0 }
  private _useConvolver = false
  private _loadedIr: Float32Array | null = null
  private _normGain = 1
  private _normTarget = 1
  private _normSamples = 0
  private readonly _normHop: number
  private readonly _manualGainAlpha: number
  private readonly _autoGainAlpha: number
  private readonly _workViews = new Map<number, [AudioBuffer, AudioBuffer]>()
  private _surroundPhase = 0

  // —— 第 15 级：空间音频（纯 TS；TsConvolverBackend + 合成 HRTF 兜底网格） ——
  private readonly _spatialBackend: TsConvolverBackend
  private readonly _processingNodes: HseProcessingNode[] = []
  private _spatialActive = false
  private _spatialWanted = false
  private _spatialMix = 0
  private _spatialWarmup = 0
  /** 干声床闸门：头锁定/世界/舞台模式下，某声道的虚拟声源全部静音时干声也静音。 */
  private _spatialDryGateL = 1
  private _spatialDryGateR = 1
  private _spatialDryTargetL = 1
  private _spatialDryTargetR = 1
  /** 空间渲染配置签名：写入预分配 Float64Array 比较，避免每帧 JSON.stringify 分配。
   *  仅当配置实际变化时才 setConfig，避免非空间参数变更触发后端状态清零造成咔哒声。 */
  private _spatialSignature = new Float64Array(0)
  private _spatialSignaturePrevious = new Float64Array(0)
  private _spatialSignatureLength = -1
  private _spatialOutL: AudioBuffer = new Float32Array(0)
  private _spatialOutR: AudioBuffer = new Float32Array(0)
  private _spatialSide: AudioBuffer = new Float32Array(0)
  private _spatialInputL: AudioBuffer = new Float32Array(0)
  private _spatialInputR: AudioBuffer = new Float32Array(0)
  private readonly _spatialInputs: AudioBuffer[] = []
  private _spatialUsesSide = false
  private _spatialUsesMultichannel = false
  private _spatialMultiInputs: AudioBuffer[] = []
  private _reverbPreparedForIR: { ir: Float32Array; prepared: PreparedConvolverIR } | null = null
  private _reverbIrRef: Float32Array | null | undefined

  constructor(sampleRate: number, channelCount = 2) {
    this._ambisonic = new AmbisonicDecoder(sampleRate, this._precisionMode)
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('invalid sample rate')
    }
    this._fs = sampleRate
    this._channels = channelCount > 0 ? channelCount : 2
    for (const key of Object.keys(this._renderers)) this._transitions[key] = new EffectTransition(sampleRate)
    this._normHop = Math.max(1, Math.round(sampleRate * 0.1))
    this._manualGainAlpha = 1 - Math.exp(-1 / (sampleRate * MANUAL_GAIN_SMOOTH_SEC))
    this._autoGainAlpha = 1 - Math.exp(-1 / (sampleRate * NORM_SMOOTH_SEC))

    this._eqChain = new EqChain(sampleRate, MAX_PRE_EQ_BANDS)
    this._dynamicEq = new DynamicEqBank(sampleRate)
    this._crossfeed = new Crossfeed(sampleRate)
    this._midSide = new MidSide(sampleRate)
    this._channelGainAlpha = 1 - Math.exp(-1 / (sampleRate * 0.02))
    this._deesser = new Deesser(sampleRate)
    this._compressor = new Compressor(sampleRate)
    this._multibandCompressor = new MultibandCompressor(sampleRate)
    this._limiter = new Limiter(sampleRate)
    this._bass = new BassEnhancer(sampleRate)
    this._subsonic = new SubsonicHighpass(sampleRate)
    this._convolver = new Convolver(sampleRate, { precision: this._precisionMode })
    this._reverbSimple = new ReverbSimple(sampleRate)
    this._lufs = new LufsMeter(sampleRate)
    this._normMeter = new LufsMeter(sampleRate, { trackTruePeak: false })
    this._loudnessComp = new LoudnessComp(sampleRate)
    this._stretch = new Stretch(sampleRate, 2)

    this._nightCompressor = new Compressor(sampleRate)
    this._nightShelfL = new Biquad('highshelf', 6000, 0.707, 0, sampleRate)
    this._nightShelfR = new Biquad('highshelf', 6000, 0.707, 0, sampleRate)

    this._ieqChain = new EqChain(sampleRate, IEQ_BAND_COUNT)
    for (let i = 0; i < IEQ_BAND_COUNT; i++) {
      this._ieqBands.push({ frequency: IEQ_FREQS[i], gain: 0, q: 1.1 })
      this._ieqZeroBands.push({ frequency: IEQ_FREQS[i], gain: 0, q: 1.1 })
    }
    // 预计算各频段的 bin 范围（相邻中心频率几何中点作为边界）
    const binHz = sampleRate / ANALYSIS_WINDOW
    for (let i = 0; i < IEQ_BAND_COUNT; i++) {
      const loEdge = i === 0 ? 20 : Math.sqrt(IEQ_FREQS[i - 1] * IEQ_FREQS[i])
      const hiEdge =
        i === IEQ_BAND_COUNT - 1 ? sampleRate / 2 : Math.sqrt(IEQ_FREQS[i] * IEQ_FREQS[i + 1])
      const lo = Math.max(0, Math.floor(loEdge / binHz))
      const hi = Math.min(ANALYSIS_WINDOW / 2, Math.ceil(hiEdge / binHz))
      this._ieqBinRanges.push([lo, hi])
    }

    this._ring = new Float32Array(ANALYSIS_WINDOW)
    this._ringR = new Float32Array(ANALYSIS_WINDOW)
    this._timeBufR = new Float32Array(ANALYSIS_WINDOW)
    this._timeBuf = new Float32Array(ANALYSIS_WINDOW)
    this._real = new Float32Array(ANALYSIS_WINDOW)
    this._imag = new Float32Array(ANALYSIS_WINDOW)
    this._magBuf = new Float32Array(ANALYSIS_WINDOW / 2 + 1)
    this._hann = hannWindow(ANALYSIS_WINDOW)
    this._binFreqs = frequencyBins(ANALYSIS_WINDOW, sampleRate)
    this._featCache = { rms: 0, zcr: 0, centroidHz: 0, rolloffHz: 0, flatness: 0, crest: 0 }

    // 第 15 级：MIT KEMAR 实测 HRIR（8–192kHz）；设备采样率超出测量转换范围时用解析网格。
    this._spatialBackend = new TsConvolverBackend()
    // 上混器输出按当前内部精度分配（float64 模式下为 Float64Array）。
    this._stereoUpmixer51 = new StereoUpmixer({
      layout: '5.1', sampleRate, blockSize: 128, precision: this._precisionMode,
    })
    this._stereoUpmixer71 = new StereoUpmixer({
      layout: '7.1', sampleRate, blockSize: 128, precision: this._precisionMode,
    })
    // headLocked 5.1.4/7.1.4 的顶置层由上混器 mid/side 高频派生（普通立体声节目）。
    this._stereoUpmixer514 = new StereoUpmixer({
      layout: '5.1.4', sampleRate, blockSize: 128, precision: this._precisionMode,
    })
    this._stereoUpmixer714 = new StereoUpmixer({
      layout: '7.1.4', sampleRate, blockSize: 128, precision: this._precisionMode,
    })
    this._spatialDecorrelator = new StereoDecorrelator(sampleRate)
    this.refreshUpmix71Channels()
    this.refreshUpmix714Channels()
    this._speakerCancellation = new CrosstalkCancellation(sampleRate)
    this._spatialBackend.loadHrtf(sampleRate >= 8000 && sampleRate <= 192000
      ? createMeasuredHrtfGrid(sampleRate)
      : generateAnalyticHrtfGrid(sampleRate))

    // Pre-EQ 频段对象池：setParams 只改其中数值，不新建对象。
    for (let i = 0; i < MAX_PRE_EQ_BANDS; i++) this._preEqBandPool.push({ frequency: 1000, gain: 0, q: 1 })

    // 实时处理块最多 128 帧；构造期按当前精度备齐不同尾块长度的视图与空间缓冲。
    this.prepareWorkViews()
    this.prepareSpatialViews()

    // 初始快照：默认参数
    this._params = createDefaultParams(sampleRate)
    this.setParams(this._params)
  }

  /**
   * 参数更新：结构化同步进引擎自有快照，数值渐变或效果退场到零湿声后提交。
   * 初始/复位配置即时生效；不修改传入的 p，连续相同快照不产生新对象/数组。
   */
  setParams(p: V3EngineParams, roomHrir: readonly PreparedRoomHrir[] = EMPTY_ROOM_HRIR,
    preparedConvolverIR?: PreparedConvolverIR, headPose?: HeadPose | null, deferSpatial = false): void {
    this._configWork.paramsApplied++
    this._configWork.roomHrirItems += roomHrir.length
    for (let i = 0; i < roomHrir.length; i++) this._spatialBackend.primeRoomHrir(roomHrir[i])
    if (this._spatialHrtfPending) {
      for (let i = 0; i < roomHrir.length; i++) this._pendingHrtfRoomHrir.push(roomHrir[i])
    }
    // 头姿复用引擎自有对象：每帧消息不再新建 { ...headPose }。
    let poseChanged = false
    if (headPose !== undefined) {
      if (headPose === null) {
        poseChanged = this._headPose !== undefined
        this._headPose = undefined
      } else if (Number.isFinite(headPose.yaw) && Number.isFinite(headPose.pitch) && Number.isFinite(headPose.roll)) {
        const currentPose = this._headPose
        if (currentPose === undefined) {
          this._headPose = { yaw: headPose.yaw, pitch: headPose.pitch, roll: headPose.roll }
          poseChanged = true
          this._configWork.poseUpdates++
        } else {
          poseChanged = currentPose.yaw !== headPose.yaw || currentPose.pitch !== headPose.pitch
            || currentPose.roll !== headPose.roll
          currentPose.yaw = headPose.yaw
          currentPose.pitch = headPose.pitch
          currentPose.roll = headPose.roll
          if (poseChanged) this._configWork.poseUpdates++
        }
      }
    }
    const previousNormEnabled = this._params.loudnessNormalization.enabled
    const previousNormRealtime = this._params.loudnessNormalization.useRealtimeMeter
    const previousSpatialMode = this._params.spatial?.mode
    const previousSpatialConvolution = this._params.spatial?.convolution
    const wasBypassed = this._params.bitPerfectBypass === true
    const wasDynamicEqEnabled = this._params.dynamicEq?.enabled === true
    const changes = this.syncParamSnapshot(p)
    const p2 = this._params
    if (changes.ambisonicTransform) this._ambisonic.setTransform(p2.spatial?.ambisonicTransform ?? {})
    if (changes.spatialInputFormat) {
      this._stereoUpmixer51.reset()
      this._stereoUpmixer71.reset()
      this._stereoUpmixer514.reset()
      this._stereoUpmixer714.reset()
    }
    // 串扰参数只在空间设置变化时重算；复用参数对象避免每次 setParams 新建。
    if (changes.spatial) {
      const cancellation = p2.spatial?.speakerCancellation
      const cancellationTarget = this._cancellationSettings
      cancellationTarget.enabled = cancellation !== undefined && cancellation.enabled
        && p2.spatial!.mode !== 'off' && p2.spatial!.instant.amount > 0
      cancellationTarget.amount = cancellation?.amount ?? 0
      cancellationTarget.delayMs = cancellation?.delayMs ?? 0
      cancellationTarget.cutoffHz = cancellation?.cutoffHz ?? 0
      this._speakerCancellation.setParams(cancellation !== undefined ? cancellationTarget : undefined)
    }
    const nextPrecision: InternalPrecision = p2.precision === 'float64' ? 'float64' : 'float32'
    if (nextPrecision !== this._precisionMode) {
      this._precisionMode = nextPrecision
      this.prepareWorkViews()
      this.prepareSpatialViews()
      this.setSpatialUpmixerPrecision(nextPrecision)
    }
    // 初始配置也下发一次精度；变化时同步卷积/多段压缩/空间后端的内部工作数组。
    if (nextPrecision !== this._precisionApplied) {
      this._precisionApplied = nextPrecision
      this._convolver.setPrecision(nextPrecision)
      this._multibandCompressor.setPrecision(nextPrecision)
      this._spatialBackend.setPrecision(nextPrecision)
      this._ambisonic.setPrecision(nextPrecision)
    }
    if (changes.processingOrder || this._processingOrder.length === 0) {
      const requestedOrder = p2.processingOrder ?? DEFAULT_PROCESSING_ORDER
      const order = this._processingOrder
      order.length = 0
      for (let i = 0; i < requestedOrder.length; i++) {
        const key = requestedOrder[i]
        if (DEFAULT_PROCESSING_ORDER.includes(key) && order.indexOf(key) < 0) order.push(key)
      }
      for (const key of DEFAULT_PROCESSING_ORDER) if (order.indexOf(key) < 0) order.push(key)
    }

    // —— Pre-EQ：用户 EQ（simple/pro）——
    if (changes.preEq) {
      this._eqChain.setBands(this.buildPreEqBands(p2))
      this._eqChain.setQCompensation(p2.eq.qCompensation)
    }
    if (changes.eqEnabled) this._transitions.eq.configure(p2.eq.enabled,
      () => {
        if (p2.eq.enabled && !this._transitions.eq.isEnabled()) this._eqChain.reset()
        this._preEqActive = p2.eq.enabled
      })
    if (changes.dynamicEq) {
      const dynamicEq = p2.dynamicEq ?? DEFAULT_DYNAMIC_EQ
      this._transitions.dynamicEq.configure(dynamicEq.enabled, () => {
        if (dynamicEq.enabled !== wasDynamicEqEnabled) this._dynamicEq.reset()
        this._dynamicEq.setParams(dynamicEq)
      })
    }
    if (changes.crossfeed) {
      const crossfeed = p2.crossfeed ?? DEFAULT_CROSSFEED
      this._transitions.crossfeed.configure(crossfeed.enabled, () => this._crossfeed.setParams(crossfeed))
    }
    const channel = p2.channelCalibration
    if (changes.channelCalibration) {
      this._channelCalibEnabled = channel?.enabled === true
      if (this._channelCalibEnabled) {
        const leftDb = Number.isFinite(channel?.leftDb) ? Math.min(24, Math.max(-24, channel!.leftDb)) : 0
        const rightDb = Number.isFinite(channel?.rightDb) ? Math.min(24, Math.max(-24, channel!.rightDb)) : 0
        this._channelTargetL = Math.pow(10, leftDb / 20)
        this._channelTargetR = Math.pow(10, rightDb / 20)
      } else {
        this._channelTargetL = 1
        this._channelTargetR = 1
      }
    }

    // —— Deesser / Compressor ——
    if (changes.deesser) this._transitions.deesser.configure(p2.deesser.enabled, () => this._deesser.setParams(p2.deesser))
    if (changes.compressor) {
      this._transitions.compressor.configure(p2.compressor.enabled, () => {
        const mode = p2.compressor.mode ?? 'downward'
        if (mode !== this._compressorMode) {
          this._compressor.reset(); this._multibandCompressor.reset()
        }
        this._compressorMode = mode

        this._compressor.setParams(p2.compressor)
        const multiband = p2.compressor.multiband ?? DEFAULT_MULTIBAND
        this._multibandCompressor.setParams(multiband, p2.compressor.enabled && p2.compressor.mode === 'multiband',
          p2.compressor.makeupDb, p2.compressor.outputGain, p2.compressor.transientPreserve ?? 0)
      })
    }

    // —— NightMode：压缩增强(ratio×1.5, threshold−6dB) + 6kHz 高频 shelf 衰减(amount×1.5dB) ——
    const nm = p2.nightMode
    if (changes.nightMode) {
      this._transitions.nightMode.configure(nm.enabled && nm.amount > 0, () => {
        this._nightActive = nm.enabled && nm.amount > 0
        if (this._nightActive) {
          if (!this._transitions.nightMode.isEnabled()) {
            this._nightCompressor.reset(); this._nightShelfL.reset(); this._nightShelfR.reset()
          }
          const k = nm.amount / 10 // 强度 0..1
          const base = p2.compressor
          // 复用参数对象：改参不再每次新建 CompressorSettings。
          const night = this._nightSettings
          night.enabled = true
          night.mode = 'downward'
          night.thresholdDb = base.thresholdDb - 6 * k
          night.ratio = Math.max(1, base.ratio * (1 + 0.5 * k)) // 满强度时 ratio×1.5
          night.kneeDb = base.kneeDb
          night.attackMs = base.attackMs
          night.releaseMs = base.releaseMs
          night.makeupDb = base.makeupDb
          night.outputGain = 1
          this._nightCompressor.setParams(night)
          const shelfGainDb = -1.5 * nm.amount // 衰减 amount×1.5 dB
          this._nightShelfL.setParams('highshelf', 6000, 0.707, shelfGainDb)
          this._nightShelfR.setParams('highshelf', 6000, 0.707, shelfGainDb)
        }
      })
    }

    // —— 混响三路路由：convolution | algorithmic | off ——
    // IR 可能有数百万个样本，不把它交给 JSON.stringify；引用变化单独判定。
    const irRef = p2.reverb.convolution.ir
    if (this._reverbPreparedForIR?.ir !== irRef) this._reverbPreparedForIR = null
    if (preparedConvolverIR && irRef) {
      if (this._reverbPreparedForIR) this._reverbPreparedForIR.prepared = preparedConvolverIR
      else this._reverbPreparedForIR = { ir: irRef, prepared: preparedConvolverIR }
    }
    const preparedForIR = this._reverbPreparedForIR?.prepared
    const reverbChanged = changes.reverb
    const reverbRouteChanged = changes.reverbRoute
    if (reverbRouteChanged || irRef !== this._reverbIrRef) {
      this._transitions.reverb.configure(p2.reverb.enabled && p2.reverb.mode !== 'off',
        () => this.configureReverb(p2.reverb, preparedForIR), () => this._useConvolver ? this._convolver.getLatencySamples() : 0)
    } else if (reverbChanged) {
      // 算法混响和卷积 mix/preDelay 已逐样本平滑；更新在途路由的最新参数时仍合流。
      this._transitions.reverb.update(() => this.configureReverb(p2.reverb, preparedForIR))
    }
    this._reverbIrRef = irRef

    // —— BassEnhancer / LoudnessComp / Limiter ——
    const bassChanged = changes.bass
    if (changes.subsonic) {
      this._transitions.subsonic.configure(p2.subsonicEnabled === true, () => {
        this._subsonic.setParams(p2.subsonicEnabled ?? false, p2.subsonicCutoffHz ?? 20)
        if (p2.subsonicEnabled && !this._transitions.subsonic.isEnabled()) this._subsonic.reset()
      })
    }
    if (changes.loudnessCompensation) this._transitions.loudnessCompensation.configure(p2.loudnessCompensation.enabled, () => {
      this._loudnessComp.setParams(p2.loudnessCompensation)
      if (p2.loudnessCompensation.enabled && !this._transitions.loudnessCompensation.isEnabled()) this._loudnessComp.reset()
    })
    if (changes.limiter) this._limiter.setParams(p2.limiter)
    const limiterThresholdDb = Number.isFinite(p2.limiter.thresholdDb)
      ? Math.min(Math.max(p2.limiter.thresholdDb, -60), 0) : -1
    const bassHeadroom = p2.limiter.enabled && p2.limiter.truePeak
      ? Math.pow(10, (limiterThresholdDb - 0.5) / 20) : 1
    if (changes.bassHeadroom || bassChanged) {
      this._transitions.bassEnhancer.configure(p2.bassEnhancer.enabled, () => {
        this._bass.setParams(p2.bassEnhancer); this._bass.setHeadroomCeiling(bassHeadroom)
      })
    }

    // —— IEQ（Post）配置 ——
    if (changes.ieq) {
      this._transitions.ieq.configure(p2.ieq.enabled, () => {
        if (p2.ieq.enabled && !this._transitions.ieq.isEnabled()) this._ieqChain.reset()
        this._ieqActive = p2.ieq.enabled
        this._ieqStrength = p2.ieq.strength
        this.fillIeqTargetCurve(p2.ieq.targetCurve)
        // 增益平滑系数：α = 1 − exp(−分析间隔/时间常数)，时间常数默认 3s 防抽吸
        const intervalSec = ANALYSIS_WINDOW / this._fs
        this._ieqSmooth = 1 - Math.exp(-intervalSec / Math.max(0.1, p2.ieq.timeConstantSec))
        if (!this._ieqActive) {
          this._ieqGains.fill(0)
          this._ieqChain.setBands(this._ieqZeroBands)
        }
      })
    }

    // —— 响度归一化 ——
    const ln = p2.loudnessNormalization
    if (!ln.enabled) {
      this._normTarget = 1
    } else if (!ln.useRealtimeMeter) {
      this._normTarget = Math.pow(10, this.resolveManualGainDb(ln) / 20)
    }
    if (ln.enabled !== previousNormEnabled || ln.useRealtimeMeter !== previousNormRealtime) {
      this._normMeter.reset()
      this._normSamples = 0
      if (ln.useRealtimeMeter) this._normTarget = 1
    }

    if (changes.surround) this._transitions.surround.configure(p2.surround3d.enabled, () => {
      // 提交时才写入目标值：参数快照会被下一次 setParams 原地更新，不能直接持有其引用。
      const source = p2.surround3d
      const settings = this._surroundSettings
      settings.enabled = source.enabled
      settings.distance = source.distance
      settings.speed = source.speed
      settings.angle = source.angle
      settings.direction = source.direction
    })
    const voiceBalance = p2.pitch.enabled ? p2.pitch.voiceBalance : 0
    if (changes.midSide) {
      this._transitions.midSide.configure(true, () => this._midSide.setParams(p2.stereoWidth, voiceBalance,
        p2.lowMonoCutoffHz, p2.lowMonoAmount))
    }
    const spatialChanged = changes.spatial
    if ((spatialChanged || poseChanged) && !deferSpatial && !this._spatialHrtfPending) {
      const sp = p2.spatial
      const active = !!sp && sp.mode !== 'off' && sp.instant.amount > 0
      // 方位、距离、混合量等由空间后端连续更新；不反复退回无延迟节目。
      if (active === this._spatialWanted && active && sp?.mode === previousSpatialMode
        && sp?.convolution === previousSpatialConvolution) this.syncSpatialConfig(sp)
      else this._transitions.spatial.configure(active, () => this.syncSpatialConfig(sp))
    }
    if (wasBypassed && !p2.bitPerfectBypass) this.reset()
  }

  /**
   * 结构化同步调用方快照到引擎自有参数对象：
   * 只写入变化字段/子树，未变化对象与数组复用引用；返回逐模块变化标志。
   * 首次调用强制全部标志为 true，保证初始配置完整下发。
   */
  private syncParamSnapshot(p: V3EngineParams): ParamChanges {
    const changes = this._paramChanges
    changes.preEq = false
    changes.eqEnabled = false
    changes.dynamicEq = false
    changes.crossfeed = false
    changes.channelCalibration = false
    changes.deesser = false
    changes.compressor = false
    changes.nightMode = false
    changes.reverb = false
    changes.reverbRoute = false
    changes.bass = false
    changes.bassHeadroom = false
    changes.subsonic = false
    changes.loudnessCompensation = false
    changes.limiter = false
    changes.ieq = false
    changes.surround = false
    changes.midSide = false
    changes.spatial = false
    changes.ambisonicTransform = false
    changes.spatialInputFormat = false
    changes.processingOrder = false
    const initial = !this._paramsInitialized
    this._paramsInitialized = true
    const target = this._params

    assignField(target, 'sampleRate', p.sampleRate)
    assignField(target, 'bitPerfectBypass', p.bitPerfectBypass)
    assignField(target, 'precision', p.precision)
    assignField(target, 'sceneId', p.sceneId)
    assignField(target, 'customized', p.customized)
    assignField(target.hearing, 'enabled', p.hearing.enabled)

    // —— 模块处理顺序：同长度就地更新，只有长度变化才重新分配 ——
    if (p.processingOrder === undefined) {
      if (target.processingOrder !== undefined) {
        target.processingOrder = undefined
        changes.processingOrder = true
      }
    } else if (target.processingOrder === undefined) {
      target.processingOrder = p.processingOrder.slice()
      changes.processingOrder = true
    } else {
      changes.processingOrder = syncPrimitiveArray(target.processingOrder, p.processingOrder)
    }

    // —— Pre-EQ：频段值就地同步；变化标志兼顾启用/模式/段数/Q 补偿 ——
    const eq = target.eq
    const eqSource = p.eq
    const eqEnabledChanged = assignField(eq, 'enabled', eqSource.enabled)
    const eqModeChanged = assignField(eq, 'mode', eqSource.mode)
    const eqBandCountChanged = assignField(eq, 'bandCount', eqSource.bandCount)
    const eqQCompChanged = assignField(eq, 'qCompensation', eqSource.qCompensation)
    assignField(eq, 'locked', eqSource.locked)
    const eqSimpleChanged = syncPrimitiveArray(eq.simpleBands, eqSource.simpleBands)
    const eqProChanged = syncObjectArray(eq.proBands, eqSource.proBands, createEqBand, syncEqBand)
    changes.eqEnabled = eqEnabledChanged
    changes.preEq = eqEnabledChanged || eqModeChanged || eqBandCountChanged || eqQCompChanged
      || eqSimpleChanged || eqProChanged

    // —— 可选模块：缺失时释放引用，出现时创建一次 ——
    if (p.dynamicEq === undefined) {
      if (target.dynamicEq !== undefined) {
        target.dynamicEq = undefined
        changes.dynamicEq = true
      }
    } else if (target.dynamicEq === undefined) {
      target.dynamicEq = createDynamicEq(p.dynamicEq)
      changes.dynamicEq = true
    } else {
      changes.dynamicEq = syncDynamicEq(target.dynamicEq, p.dynamicEq)
    }
    if (p.crossfeed === undefined) {
      if (target.crossfeed !== undefined) {
        target.crossfeed = undefined
        changes.crossfeed = true
      }
    } else if (target.crossfeed === undefined) {
      target.crossfeed = { ...p.crossfeed }
      changes.crossfeed = true
    } else {
      changes.crossfeed = syncCrossfeed(target.crossfeed, p.crossfeed)
    }
    if (p.channelCalibration === undefined) {
      if (target.channelCalibration !== undefined) {
        target.channelCalibration = undefined
        changes.channelCalibration = true
      }
    } else if (target.channelCalibration === undefined) {
      target.channelCalibration = { ...p.channelCalibration }
      changes.channelCalibration = true
    } else {
      changes.channelCalibration = syncChannelCalibration(target.channelCalibration, p.channelCalibration)
    }

    changes.deesser = syncDeesser(target.deesser, p.deesser)
    changes.compressor = syncCompressor(target.compressor, p.compressor)
    // 夜间模式依赖主压缩器（阈值/比率/时间来自 compressor）。
    const nightEnabledChanged = assignField(target.nightMode, 'enabled', p.nightMode.enabled)
    const nightAmountChanged = assignField(target.nightMode, 'amount', p.nightMode.amount)
    changes.nightMode = nightEnabledChanged || nightAmountChanged || changes.compressor
    syncReverb(target.reverb, p.reverb, changes)
    changes.bass = syncBassEnhancer(target.bassEnhancer, p.bassEnhancer)
    const subsonicEnabledChanged = assignField(target, 'subsonicEnabled', p.subsonicEnabled)
    const subsonicCutoffChanged = assignField(target, 'subsonicCutoffHz', p.subsonicCutoffHz)
    changes.subsonic = subsonicEnabledChanged || subsonicCutoffChanged
    changes.loudnessCompensation = syncLoudnessCompensation(target.loudnessCompensation, p.loudnessCompensation)

    // —— Limiter：同时记录低音余量相关字段 ——
    const limiter = target.limiter
    const limiterSource = p.limiter
    const limiterEnabled = assignField(limiter, 'enabled', limiterSource.enabled)
    const limiterThreshold = assignField(limiter, 'thresholdDb', limiterSource.thresholdDb)
    const limiterTruePeak = assignField(limiter, 'truePeak', limiterSource.truePeak)
    const limiterLookahead = assignField(limiter, 'lookaheadMs', limiterSource.lookaheadMs)
    const limiterAttack = assignField(limiter, 'attackMs', limiterSource.attackMs)
    const limiterRelease = assignField(limiter, 'releaseMs', limiterSource.releaseMs)
    changes.limiter = limiterEnabled || limiterThreshold || limiterTruePeak
      || limiterLookahead || limiterAttack || limiterRelease
    changes.bassHeadroom = limiterEnabled || limiterThreshold || limiterTruePeak

    changes.ieq = syncIeq(target.ieq, p.ieq)
    changes.surround = syncSurround(target.surround3d, p.surround3d)
    const stereoWidthChanged = assignField(target, 'stereoWidth', p.stereoWidth)
    const lowMonoCutoffChanged = assignField(target, 'lowMonoCutoffHz', p.lowMonoCutoffHz)
    const lowMonoAmountChanged = assignField(target, 'lowMonoAmount', p.lowMonoAmount)

    // —— M/S：voiceBalance 依赖 pitch.enabled，按原 changed 语义比较归一化值 ——
    const previousVoiceBalance = target.pitch.enabled ? target.pitch.voiceBalance : 0
    assignField(target.pitch, 'enabled', p.pitch.enabled)
    assignField(target.pitch, 'voiceBalance', p.pitch.voiceBalance)
    assignField(target.pitch, 'semitones', p.pitch.semitones)
    assignField(target.pitch, 'rate', p.pitch.rate)
    const voiceBalance = target.pitch.enabled ? target.pitch.voiceBalance : 0
    changes.midSide = stereoWidthChanged || lowMonoCutoffChanged || lowMonoAmountChanged
      || previousVoiceBalance !== voiceBalance

    syncLoudnessNormalization(target.loudnessNormalization, p.loudnessNormalization)

    // —— 空间设置：深比较后逐字段同步；IR/数组长度变化才分配 ——
    if (p.spatial === undefined) {
      if (target.spatial !== undefined) {
        target.spatial = undefined
        changes.spatial = true
        changes.ambisonicTransform = true
        changes.spatialInputFormat = true
      }
    } else {
      let spatial = target.spatial
      if (spatial === undefined) {
        spatial = createDefaultSpatialSettings()
        target.spatial = spatial
        changes.spatial = true
      }
      syncSpatialSettings(spatial, p.spatial, changes)
    }

    if (initial) {
      changes.preEq = true
      changes.eqEnabled = true
      changes.dynamicEq = true
      changes.crossfeed = true
      changes.channelCalibration = true
      changes.deesser = true
      changes.compressor = true
      changes.nightMode = true
      changes.reverb = true
      changes.reverbRoute = true
      changes.bass = true
      changes.bassHeadroom = true
      changes.subsonic = true
      changes.loudnessCompensation = true
      changes.limiter = true
      changes.ieq = true
      changes.surround = true
      changes.midSide = true
      changes.spatial = true
      changes.ambisonicTransform = true
      changes.spatialInputFormat = true
      changes.processingOrder = true
    }
    return changes
  }

  /** 仅同步空间级；输入声道数变化不应重设其余 DSP 或复制整份参数。 */
  private syncSpatialConfig(sp = this._params.spatial): void {
    const configStartedAt = engineClock()
    // —— 第 15 级：空间音频配置同步（纯 TS；仅当 SpatialSettings 实际变化时 setConfig，
    //    避免非空间参数变更触发后端状态清零）——mode='off' 或缺省 spatial 时旁路。
    //    HRTF 网格随采样率固定（ctor 装载），setConfig 复用。
    //    刚从 off→on（_spatialActive 之前为 false）时先 reset() 后端流式状态：
    //    空间音频关闭期间后端不被调用，dryLine/卷积历史残留上次会话内容，若不清空，
    //    重新启用瞬间会从 dryLine 吐出旧音频。reset 后保留原声，待卷积路径填满
    //    再平滑淡入，避免起播空白。
    const active = !!sp && sp.mode !== 'off' && sp.instant.amount > 0
    const wasActive = this._spatialActive
    this._spatialWanted = active
    if (active && sp) {
      const config = spatialConfigFromSettings(sp, this._lastInputChannels, this._fs, this._headPose)
      // 上混布局与空间配置一起提交：布局切换时清零上混器流式状态（LFE/顶置滤波）。
      const nextUpmix = headLockedUpmixLayout(sp, this._lastInputChannels)
      if (nextUpmix !== this._spatialHeadLockedUpmix) {
        this._spatialHeadLockedUpmix = nextUpmix
        this._stereoUpmixer51.reset()
        this._stereoUpmixer71.reset()
        this._stereoUpmixer514.reset()
        this._stereoUpmixer714.reset()
      }
      if (this.spatialConfigChanged(config)) {
        this._configWork.spatialConfigs++
        if (!wasActive) this._spatialBackend.reset()
        this._spatialInputLayout = sp.instant.multichannelLayout
        this._spatialBackend.setConfig(config)
        const dryGates = dryGateTargetsFromSpeakers(config.speakers, sp.mode)
        this._spatialDryTargetL = dryGates.l
        this._spatialDryTargetR = dryGates.r
        this._spatialUsesMultichannel = config.multichannelAuto === true
        let usesSide = false
        let channelCount = 4
        for (let i = 0; i < config.speakers.length; i++) {
          const speaker = config.speakers[i]
          if (speaker.channel === 2) usesSide = true
          if (speaker.channel + 1 > channelCount) channelCount = speaker.channel + 1
        }
        this._spatialUsesSide = !this._spatialUsesMultichannel && usesSide
        if (this._spatialUsesMultichannel) {
          this._spatialMultiChannelCount = Math.min(32, channelCount)
          this._spatialMultiViews = this._spatialViewsByChannelCount[this._spatialMultiChannelCount]
        }
      }
      this._spatialActive = true
      if (!wasActive) {
        this._spatialMix = 0
        this._spatialWarmup = this._spatialBackend.getLatencySamples()
      }
    } else {
      this._spatialMix = 0
      this._spatialActive = false
      this._spatialSignatureLength = -1
      this._spatialDryTargetL = 1
      this._spatialDryTargetR = 1
      this._spatialHeadLockedUpmix = null
    }
    const configMs = Math.max(0, engineClock() - configStartedAt)
    this._configWork.spatialConfigMs += configMs
    this._configWork.blockConfigMs += configMs
  }

  /** 宿主配置完成后提取精确线索，避免 Worklet 再次进行房间 HRIR 插值。 */
  takePreparedRoomHrir(full = false): PreparedRoomHrir | undefined {
    return this._spatialBackend.takePreparedRoomHrir(full)
  }

  /** 数据集留在运行时，不混入效果参数或场景分享。 */
  setSpatialHrtf(grid: HrtfGrid | null, roomHrir: readonly PreparedRoomHrir[] = EMPTY_ROOM_HRIR): void {
    this._configWork.hrtfLoads++
    const prepared = grid ? prepareHrtfGrid(grid, this._fs) : createMeasuredHrtfGrid(this._fs)
    this._spatialHrtfPending = true
    this._pendingHrtfRoomHrir.length = 0
    for (let i = 0; i < roomHrir.length; i++) this._pendingHrtfRoomHrir.push(roomHrir[i])
    const active = !!this._params.spatial && this._params.spatial.mode !== 'off' && this._params.spatial.instant.amount > 0
    this._transitions.spatial.configure(active, () => {
      this._spatialBackend.loadHrtf(prepared, true)
      for (const room of this._pendingHrtfRoomHrir) this._spatialBackend.primeRoomHrir(room)
      this._pendingHrtfRoomHrir = []
      this._spatialHrtfPending = false
      this._spatialSignatureLength = -1; this._spatialActive = false
      this.syncSpatialConfig()
    }, () => this._spatialBackend.getLatencySamples())
  }

  getSpatialHrtfSource(): string { return this._spatialBackend.getHrtfSource() }

  /** 宿主已知实际离散输入数时，在控制线程同步布局，避免参照引擎始终按双声道准备。 */
  setSpatialInputChannelCount(channels: number, deferSpatial = false): void {
    if (!Number.isInteger(channels) || channels < 1 || channels > 32 || channels === this._lastInputChannels) return
    this._lastInputChannels = channels
    if (!deferSpatial && !this._spatialHrtfPending) this.syncSpatialConfig()
  }

  setSpatialHeadPose(pose: HeadPose | null, roomHrir: readonly PreparedRoomHrir[] = EMPTY_ROOM_HRIR,
    deferSpatial = false): void {
    for (let i = 0; i < roomHrir.length; i++) this._spatialBackend.primeRoomHrir(roomHrir[i])
    if (pose && !(Number.isFinite(pose.yaw) && Number.isFinite(pose.pitch) && Number.isFinite(pose.roll))) return
    if (pose === null) {
      this._headPose = undefined
    } else {
      const currentPose = this._headPose
      if (currentPose === undefined) this._headPose = { yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll }
      else {
        currentPose.yaw = pose.yaw
        currentPose.pitch = pose.pitch
        currentPose.roll = pose.roll
      }
    }
    if (this._spatialHrtfPending) {
      for (let i = 0; i < roomHrir.length; i++) this._pendingHrtfRoomHrir.push(roomHrir[i])
    }
    if (!deferSpatial && !this._spatialHrtfPending) this.syncSpatialConfig()
  }

  /** 就地处理；内部最多 128 样本，分析和自动增益在固定采样边界更新。 */
  process(inputs: Float32Array[], outputs: Float32Array[]): void {
    // 每帧重置块内配置耗时：过渡提交等延迟配置也计入本帧。
    this._configWork.blockConfigMs = 0
    const inputCountChanged = this._lastInputChannels !== inputs.length
    this._lastInputChannels = inputs.length || 0
    const spatial = this._params.spatial
    const format = spatial?.inputFormat
    const expected = format === 'ambix2' ? 9 : format === 'ambix3' ? 16 : isAmbisonicFormat(format) ? 4
      : format === 'stereo51' || format === 'stereo71' ? 2 : inputs.length
    const valid = inputs.length === expected
    if (valid !== this._spatialInputFormatValid) {
      this._spatialBackend.reset()
      this._spatialWarmup = this._spatialBackend.getLatencySamples()
      this._spatialMix = 0
    }
    this._spatialInputFormatValid = valid
    if (inputCountChanged && spatial?.mode === 'instant' && spatial.instant.multichannelAuto
      && spatial.instant.multichannelLayout === 'auto' && !this._params.bitPerfectBypass) {
      this._transitions.spatial.configure(true, () => this.syncSpatialConfig(spatial))
    }
    // headLocked 预设布局是否上混取决于实际输入声道数（立体声 → 上混；真实多声道 → 直通）。
    if (inputCountChanged && spatial?.mode === 'headLocked' && !this._params.bitPerfectBypass) {
      const nextUpmix = headLockedUpmixLayout(spatial, this._lastInputChannels)
      if (nextUpmix !== this._spatialHeadLockedUpmix) {
        this._transitions.spatial.configure(this._spatialWanted, () => this.syncSpatialConfig(spatial))
      }
    }
    if (this._params.bitPerfectBypass) {
      if (inputs.length > 2 && outputs.length === 2 && outputs[0] && outputs[1]) {
        let count = Math.min(outputs[0].length, outputs[1].length)
        for (let i = 0; i < inputs.length; i++) if (inputs[i]) count = Math.min(count, inputs[i].length)
        downmixToStereo(inputs, outputs[0], outputs[1], 0, count)
        outputs[0].fill(0, count)
        outputs[1].fill(0, count)
        return
      }
      for (let channel = 0; channel < outputs.length; channel++) {
        const output = outputs[channel]
        if (!output) continue
        const input = inputs[channel] ?? (channel === 1 ? inputs[0] : undefined)
        if (!input) { output.fill(0); continue }
        if (input === output) continue
        if (input.length === output.length) output.set(input)
        else {
          const count = Math.min(input.length, output.length)
          for (let i = 0; i < count; i++) output[i] = input[i]
          output.fill(0, count)
        }
      }
      return
    }
    let n = Infinity
    for (let i = 0; i < inputs.length; i++) if (inputs[i]) n = Math.min(n, inputs[i].length)
    for (let i = 0; i < outputs.length; i++) if (outputs[i]) n = Math.min(n, outputs[i].length)
    if (!Number.isFinite(n) || n <= 0) return
    const inL = inputs[0]
    const inR = this._channels > 1 ? inputs[1] : undefined
    let offset = 0
    while (offset < n) {
      let count = Math.min(128, n - offset, ANALYSIS_WINDOW - this._analysisPos)
      const ln = this._params.loudnessNormalization
      if (ln.enabled && ln.useRealtimeMeter) count = Math.min(count, this._normHop - this._normSamples)
      this.processChunk(inL, inR, outputs[0], outputs[1], offset, count, inputs.length > 2 ? inputs : null)
      offset += count
    }
  }

  private processChunk(inL: Float32Array | undefined, inR: Float32Array | undefined,
    outL: Float32Array | undefined, outR: Float32Array | undefined, offset: number, n: number,
    channels: Float32Array[] | null): void {
    this.ensureCapacity(n)
    const L = this._workL
    const R = this._workR
    if (channels) {
      const inputFormat = this._params.spatial?.inputFormat
      if (isAmbisonicFormat(inputFormat) && this._spatialInputFormatValid) {
        this._ambisonic.decode(channels, offset, n, inputFormat)
        for (let i = 0; i < n; i++) { L[i] = this._ambisonic.left[i]; R[i] = this._ambisonic.right[i] }
      } else downmixToStereo(channels, L, R, offset, n)
    } else {
      for (let i = 0; i < n; i++) L[i] = inL ? inL[offset + i] : 0
      for (let i = 0; i < n; i++) R[i] = inR ? inR[offset + i] : 0
    }

    // 空间是输入解码阶段；归一化、音色/动态及声道校准统一作用于最终双耳总线。
    // 避免多声道原始输入在末级重新覆盖已经调好的音量和效果。
    const inputFormat = this._params.spatial?.inputFormat
    const foa = isAmbisonicFormat(inputFormat)
    const upmix51 = inputFormat === 'stereo51'
    const upmix71 = inputFormat === 'stereo71'
    const headLockedUpmix = this._spatialHeadLockedUpmix
    if ((upmix51 || upmix71) && this._spatialInputFormatValid) {
      // 上混只进入空间湿路，原立体声干路不重复叠加中心与低频。
      for (let i = 0; i < n; i++) { this._spatialInputL[i] = L[i]; this._spatialInputR[i] = R[i] }
      this._spatialBlockChannels = (upmix51 ? this._stereoUpmixer51 : this._stereoUpmixer71)
        .process(this._spatialViews[n][2], this._spatialViews[n][3], n)
      if (upmix71) {
        // 上混器为 WAVE 顺序 BL/BR/SL/SR，HSE 内部为 SL/SR/BL/BR。
        this._spatialBlockChannels = this._upmix71Channels
      }
      this._spatialBlockOffset = 0
    } else if (headLockedUpmix !== null && this._spatialInputFormatValid) {
      // headLocked 预设 5.1/5.1.4/7.1/7.1.4：普通立体声节目先矩阵上混到布局声道
      // （center/surround/height/LFE），再由 renderSpatial 走 processMulti 逐只 HRTF。
      if (this._lastInputChannels <= 1) {
        // 单声道按双单声道上混：否则 R=0 会被当成反相立体声，环绕/侧向残差错位。
        for (let i = 0; i < n; i++) { const sample = L[i]; this._spatialInputL[i] = sample; this._spatialInputR[i] = sample }
      } else {
        for (let i = 0; i < n; i++) { this._spatialInputL[i] = L[i]; this._spatialInputR[i] = R[i] }
      }
      const leftView = this._spatialViews[n][2]
      const rightView = this._spatialViews[n][3]
      if (headLockedUpmix === '51') {
        this._spatialBlockChannels = this._stereoUpmixer51.process(leftView, rightView, n)
      } else if (headLockedUpmix === '514') {
        this._spatialBlockChannels = this._stereoUpmixer514.process(leftView, rightView, n)
      } else if (headLockedUpmix === '71') {
        this._stereoUpmixer71.process(leftView, rightView, n)
        this._spatialBlockChannels = this._upmix71Channels
      } else {
        this._stereoUpmixer714.process(leftView, rightView, n)
        this._spatialBlockChannels = this._upmix714Channels
      }
      this._spatialDecorrelator.process(this._spatialBlockChannels, leftView, rightView, n, headLockedUpmix,
        this._params.spatial?.decorrelation ?? 0)
      this._spatialBlockOffset = 0
    } else {
      this._spatialBlockChannels = foa && channels ? this._ambisonic.channels : channels
      this._spatialBlockOffset = foa && channels ? 0 : offset
    }
    if (this._spatialInputFormatValid) this._transitions.spatial.process(L, R, this._renderers.spatial)

    // 1) 自动模式测未经本级增益处理的输入；每 100ms 更新目标，逐样本平滑。
    const ln = this._params.loudnessNormalization
    if (ln.enabled || this._normGain !== 1) {
      const automatic = ln.enabled && ln.useRealtimeMeter
      if (automatic) this._normMeter.processStereo(L, R)
      const alpha = automatic ? this._autoGainAlpha : this._manualGainAlpha
      for (let i = 0; i < n; i++) {
        this._normGain += alpha * (this._normTarget - this._normGain)
        L[i] *= this._normGain
        R[i] *= this._normGain
      }
      if (automatic) {
        this._normSamples += n
        if (this._normSamples === this._normHop) {
          this._normSamples = 0
          const measured = this._normMeter.getIntegratedLufs()
          const gainDb = Number.isFinite(measured)
            ? Math.min(ln.maxGainDb, Math.max(ln.minGainDb, ln.targetLufs - measured)) : 0
          this._normTarget = Math.pow(10, gainDb / 20)
        }
      }
    }

    this._transitions.surround.process(L, R, this._renderers.surround)
    this._transitions.midSide.process(L, R, this._renderers.midSide)
    if (this._channelCalibEnabled || this._channelGainL !== 1 || this._channelGainR !== 1) {
      for (let i = 0; i < n; i++) {
        this._channelGainL += this._channelGainAlpha * (this._channelTargetL - this._channelGainL)
        this._channelGainR += this._channelGainAlpha * (this._channelTargetR - this._channelGainR)
        L[i] *= this._channelGainL
        R[i] *= this._channelGainR
      }
      if (!this._channelCalibEnabled && Math.abs(this._channelGainL - 1) < 1e-5 && Math.abs(this._channelGainR - 1) < 1e-5) {
        this._channelGainL = 1
        this._channelGainR = 1
      }
    }

    const order = this._processingOrder
    for (let i = 0; i < order.length; i++) this._transitions[order[i]].process(L, R, this._renderers[order[i]])

    // 11) 分析取样（IEQ 处理后——闭环修正）：取样点在 IEQ 之后，
    //    IEQ 抬高/压低频段后分析能看到修正结果，增益随修正收敛到目标曲线
    //    （原取样点在 IEQ 之前为开环：增益只增不减，一路推到 ±12 clamp 过冲）
    this.feedAnalysis(L, R, n)

    // 13) LUFS 采样点（Limiter 之前，API_SPEC 要求）
    this._lufs.processStereo(L, R)

    this._transitions.crossfeed.process(L, R, this._renderers.crossfeed)

    // Third-party script nodes run immediately before the final limiter so their output is protected.
    for (let i = 0; i < this._processingNodes.length; i++) {
      const node = this._processingNodes[i]
      if (node.enabled !== false) node.processStereo(L, R)
    }

    this._transitions.subsonic.process(L, R, this._renderers.subsonic)
    this._speakerCancellation.processStereo(L, R)

    // 15) 最终 Limiter：空间扬声器叠加、房间反射与干湿混合也受同一真峰值阈值保护。
    this._limiter.processStereo(L, R)

    if (outL) for (let i = 0; i < n; i++) outL[offset + i] = L[i]
    if (outR) for (let i = 0; i < n; i++) outR[offset + i] = R[i]
  }

  private renderSurround(L: AudioBuffer, R: AudioBuffer): void {
    const n = L.length
    const s3 = this._surroundSettings
    if (s3.enabled) {
      const step = 2 * Math.PI * s3.speed * 0.125 / this._fs
      const angle = s3.angle * Math.PI / 180
      const scale = 0.5 + 0.5 * s3.distance
      // 振荡器逐样本推进；递推旋转只需每块一对 sin/cos，不再按块阶跃声像。
      const delta = s3.direction * step
      const dc = Math.cos(delta)
      const ds = Math.sin(delta)
      let c = Math.cos(angle + s3.direction * this._surroundPhase)
      let s = Math.sin(angle + s3.direction * this._surroundPhase)
      for (let i = 0; i < n; i++) {
        const l = L[i]
        const r = R[i]
        L[i] = (l * c - r * s) * scale
        R[i] = (l * s + r * c) * scale
        const nextC = c * dc - s * ds
        s = s * dc + c * ds
        c = nextC
        this._surroundPhase += step
        if (this._surroundPhase >= 2 * Math.PI) this._surroundPhase -= 2 * Math.PI
      }
    }

  }

  private renderSpatial(L: AudioBuffer, R: AudioBuffer, localOffset: number): void {
    const n = L.length, channels = this._spatialBlockChannels, offset = this._spatialBlockOffset + localOffset
    if (this._spatialActive) {
      // 按索引取视图，避免数组解构的迭代器分配。
      const views = this._spatialViews[n]
      const oL = views[0]
      const oR = views[1]
      const spatialL = views[2]
      const spatialR = views[3]
      const side = views[4]
      // 静音闸门在「进入空间后端之前」生效：被静音声道的节目信号连同干声一起消失，
      // 但仍保留其它声道经 HRTF 串到该耳的交叉声（否则就不是空间音频而是砍耳朵）。
      const gateStep = Math.min(1, n / Math.max(1, Math.round(this._fs * 0.02)))
      this._spatialDryGateL += (this._spatialDryTargetL - this._spatialDryGateL) * gateStep
      this._spatialDryGateR += (this._spatialDryTargetR - this._spatialDryGateR) * gateStep
      const gateL = this._spatialDryGateL
      const gateR = this._spatialDryGateR
      for (let i = 0; i < n; i++) {
        spatialL[i] = L[i] * gateL
        spatialR[i] = R[i] * gateR
      }
      if (this._spatialUsesMultichannel) {
        const multi = this._spatialMultiViews[n]
        const inputCount = channels?.length ?? 0
        for (let channel = 0; channel < multi.length; channel++) {
          const target = multi[channel]
          const source = channels?.[channel]
          if (source) {
            for (let i = 0; i < n; i++) target[i] = source[offset + i] ?? 0
          } else {
            target.fill(0, 0, n)
          }
        }
        // Stereo input remains supported: keep the front pair and add a centre fill.
        if (inputCount <= 2) {
          for (let i = 0; i < n; i++) {
            multi[0][i] = spatialL[i]
            multi[1][i] = spatialR[i]
            if (multi.length > 2 && this._spatialInputLayout !== 'quad'
              && this._spatialInputLayout !== 'auto') {
              multi[2][i] = (spatialL[i] + spatialR[i]) * Math.SQRT1_2
            }
          }
        }
        this._spatialBackend.processMulti(multi, oL, oR, spatialL, spatialR)
      } else if (this._spatialUsesSide) {
        for (let i = 0; i < n; i++) side[i] = (spatialL[i] - spatialR[i]) * 0.5
        this._spatialInputs[0] = spatialL
        this._spatialInputs[1] = spatialR
        this._spatialInputs[2] = side
        this._spatialBackend.processMulti(this._spatialInputs, oL, oR)
      } else {
        this._spatialBackend.processStereo(spatialL, spatialR, oL, oR)
      }
      const fadeStep = 1 / Math.max(1, Math.round(this._fs * 0.025))
      for (let i = 0; i < n; i++) {
        if (this._spatialWarmup > 0) this._spatialWarmup--
        else if (this._spatialWanted) this._spatialMix = Math.min(1, this._spatialMix + fadeStep)
        else this._spatialMix = Math.max(0, this._spatialMix - fadeStep)
        const mix = this._spatialMix
        const dryL = L[i] * gateL
        const dryR = R[i] * gateR
        L[i] = dryL + (oL[i] - dryL) * mix
        R[i] = dryR + (oR[i] - dryR) * mix
      }
      if (!this._spatialWanted && this._spatialMix === 0) {
        this._spatialActive = false
        this._spatialSignatureLength = -1
      }
    }

  }

  /** 读取配置工作量计数到调用方对象（不分配；Worklet 遥测用）。 */
  getConfigWork(target: EngineConfigWork): void {
    this._spatialBackend.getConfigWork(target)
    target.spatialConfigMs = this._configWork.spatialConfigMs
    target.reverbConfigMs = this._configWork.reverbConfigMs
    target.blockConfigMs = this._configWork.blockConfigMs
    target.paramsApplied = this._configWork.paramsApplied
    target.poseUpdates = this._configWork.poseUpdates
    target.roomHrirItems = this._configWork.roomHrirItems
    target.hrtfLoads = this._configWork.hrtfLoads
    target.spatialConfigs = this._configWork.spatialConfigs
    target.preparedIrLoads = this._configWork.preparedIrLoads
    target.localIrLoads = this._configWork.localIrLoads
  }

  /** 清零配置工作量计数（每次遥测回传后调用）。 */
  resetConfigWork(): void {
    this._configWork.paramsApplied = 0
    this._configWork.poseUpdates = 0
    this._configWork.roomHrirItems = 0
    this._configWork.hrtfLoads = 0
    this._configWork.spatialConfigs = 0
    this._configWork.preparedIrLoads = 0
    this._configWork.localIrLoads = 0
    this._configWork.spatialConfigMs = 0
    this._configWork.reverbConfigMs = 0
    this._spatialBackend.resetConfigWork()
  }

  /** 上一次 process 回调内的配置耗时（毫秒）；Worklet 据此归因延迟过渡提交。 */
  getBlockConfigMs(): number {
    return this._configWork.blockConfigMs
  }

  /** 不传target时仍返回独立快照；Worklet可提供自己的可复用消息存储。 */
  getStats(target: EngineStats = {} as EngineStats): EngineStats {
    target.lufsIntegrated = this._lufs.getIntegratedLufs()
    target.lufsMomentary = this._lufs.getMomentaryLufs()
    target.lra = this._lufs.getLra()
    target.peakDb = this._lufs.getPeakDb()
    target.truePeakDb = this._lufs.getTruePeakDb()
    target.limiterReductionDb = this._limiter.getReductionDb()
    target.engineLatencySamples = this.getLatencySamples()
    target.inputChannels = this._lastInputChannels
    target.spatialHrtfSource = this.getSpatialHrtfSource()
    target.spatialInputFormatValid = this._spatialInputFormatValid
    // 精度自检：Worklet/宿主可据统计确认当前引擎内部精度（与各后端 getPrecision 一致）。
    target.internalPrecision = this._precisionMode
    return target
  }

  /** 在控制线程复制已预计算的卷积 IR 与 Worklet 独占 scratch，供一次性 transfer 下发。 */
  createPreparedConvolverIRTransfer(): PreparedConvolverIR | null {
    return this._convolver.createPreparedIRTransfer()
  }

  /** 最近一帧频谱 + 特征（内部 2048 点 FFT + Hann 窗）。未测到返回 null。 */
  getAnalysis(target: EngineAnalysis = { spectrum: null, features: null }): EngineAnalysis {
    if (!this._analysisReady) {
      target.spectrum = null; target.features = null
      return target
    }
    if (!target.spectrum || target.spectrum.length !== this._magBuf.length)
      target.spectrum = new Float32Array(this._magBuf.length)
    target.spectrum.set(this._magBuf)
    if (target.features) Object.assign(target.features, this._featCache)
    else target.features = { ...this._featCache }
    return target
  }

  /** 引擎引入的延迟（样本数）= 限幅器前瞻 + 混响延迟 + 空间音频分区延迟。 */
  getLatencySamples(): number {
    let lat = 0
    const p = this._params
    if (p.limiter.enabled) lat += this._limiter.getLatencySamples()
    if (p.reverb.enabled) {
      if (this._useConvolver) lat += this._convolver.getLatencySamples()
      else if (p.reverb.mode === 'algorithmic') {
        lat += Math.round((p.reverb.algorithmic.preDelayMs / 1000) * this._fs)
      }
    }
    // 第 15 级：空间音频延迟包含卷积分区与实测 HRIR 主到达时间。
    if (this._spatialActive) lat += this._spatialBackend.getLatencySamples()
    for (let i = 0; i < this._processingNodes.length; i++) {
      const node = this._processingNodes[i]
      if (node.enabled === false) continue
      const value = node.getLatencySamples?.()
      if (value !== undefined && Number.isFinite(value) && value > 0) lat += value
    }
    return lat
  }

  /** Register or replace a script-side extension node. Registration is a control-thread operation. */
  registerProcessingNode(node: HseProcessingNode): void {
    assertProcessingNode(node)
    const existing = this._processingNodes.findIndex((item) => item.id === node.id)
    if (existing >= 0) this._processingNodes[existing] = node
    else this._processingNodes.push(node)
  }

  unregisterProcessingNode(id: string): boolean {
    const index = this._processingNodes.findIndex((node) => node.id === id)
    if (index < 0) return false
    this._processingNodes.splice(index, 1)
    return true
  }

  getProcessingNodes(): readonly HseProcessingNode[] {
    return this._processingNodes.slice()
  }

  /** 变速/变调处理器（不内联进主链，供 gapless/过渡场景调用）。 */
  getStretch(): Stretch {
    return this._stretch
  }

  /** 复位所有模块与内部状态。 */
  reset(): void {
    for (const transition of Object.values(this._transitions)) transition.reset()
    this._eqChain.reset()
    this._dynamicEq.reset()
    this._crossfeed.reset()
    this._midSide.reset()
    this._deesser.reset()
    this._compressor.reset()
    this._multibandCompressor.reset()
    this._limiter.reset()
    this._subsonic.reset()
    this._bass.reset()
    this._convolver.reset()
    this._reverbSimple.reset()
    this._lufs.reset()
    this._normMeter.reset()
    this._normSamples = 0
    this._loudnessComp.reset()
    this._nightCompressor.reset()
    this._nightShelfL.reset()
    this._nightShelfR.reset()
    this._ieqChain.reset()
    this._stretch.reset()
    // 第 15 级：空间音频后端流式状态清零（卷积历史/延迟线/房间 FDN；配置与 IR 保留）
    this._spatialBackend.reset()
    this._speakerCancellation.reset()
    this._ambisonic.reset()
    this._stereoUpmixer51.reset()
    this._stereoUpmixer71.reset()
    this._stereoUpmixer514.reset()
    this._stereoUpmixer714.reset()
    this._spatialDecorrelator.reset()
    this._channelGainL = 1
    this._channelGainR = 1
    for (let i = 0; i < this._processingNodes.length; i++) this._processingNodes[i].reset?.()
    this._spatialMix = 0
    this._spatialWarmup = this._spatialWanted ? this._spatialBackend.getLatencySamples() : 0
    this._normGain = 1
    const ln = this._params.loudnessNormalization
    this._normTarget = ln.enabled && !ln.useRealtimeMeter ? Math.pow(10, this.resolveManualGainDb(ln) / 20) : 1
    this._surroundPhase = 0
    this._ringPos = 0
    this._analysisPos = 0
    this._analysisReady = false
    this._ring.fill(0)
    this._ringR.fill(0)
    this._magBuf.fill(0)
    this._ieqGains.fill(0)
    for (const band of this._ieqBands) band.gain = 0
    this._ieqChain.setBands(this._ieqZeroBands)
    const f = this._featCache
    f.rms = 0
    f.zcr = 0
    f.centroidHz = 0
    f.rolloffHz = 0
    f.flatness = 0
    f.crest = 0
  }

  // ==================== 内部实现 ====================

  private ensureCapacity(n: number): void {
    // 内部块上限 128；每种长度只分配一次，尾块不会重放大缓冲中的陈旧样本。
    let views = this._workViews.get(n)
    if (!views) {
      views = this._precisionMode === 'float64'
        ? [new Float64Array(n), new Float64Array(n)]
        : [new Float32Array(n), new Float32Array(n)]
      this._workViews.set(n, views)
    }
    this._workL = views[0]
    this._workR = views[1]
    this._workBlockLength = n
  }

  private prepareWorkViews(): void {
    this._workViews.clear()
    for (let n = 1; n <= 128; n++) {
      this._workViews.set(n, [this.allocateWorkBuffer(n), this.allocateWorkBuffer(n)])
    }
    // 精度切换后立即指回当前块长视图，不必等到下一次 process 才反映新类型。
    const views = this._workViews.get(this._workBlockLength)
    if (views) {
      this._workL = views[0]
      this._workR = views[1]
    }
  }

  /** 按当前精度分配工作缓冲（Float32/Float64）。 */
  private allocateWorkBuffer(length: number): AudioBuffer {
    return this._precisionMode === 'float64' ? new Float64Array(length) : new Float32Array(length)
  }

  /**
   * 按当前精度重建空间输入/输出工作视图（1..128 帧）与多声道输入缓冲。
   * 仅构造期与精度切换时调用；稳态渲染复用同一批视图。
   */
  private prepareSpatialViews(): void {
    this._spatialOutL = this.allocateWorkBuffer(128)
    this._spatialOutR = this.allocateWorkBuffer(128)
    this._spatialInputL = this.allocateWorkBuffer(128)
    this._spatialInputR = this.allocateWorkBuffer(128)
    this._spatialSide = this.allocateWorkBuffer(128)
    this._spatialViews.length = 0
    for (let n = 0; n <= 128; n++) {
      this._spatialViews.push([
        this._spatialOutL.subarray(0, n),
        this._spatialOutR.subarray(0, n),
        this._spatialInputL.subarray(0, n),
        this._spatialInputR.subarray(0, n),
        this._spatialSide.subarray(0, n),
      ])
    }
    // 多声道离散输入：32 路 × 1..128 帧视图，按实际声道数切片复用。
    this._spatialMultiInputs = []
    for (let channel = 0; channel < 32; channel++) this._spatialMultiInputs.push(this.allocateWorkBuffer(128))
    const multiViews: AudioBuffer[][] = []
    for (let n = 0; n <= 128; n++) {
      const views: AudioBuffer[] = []
      for (let channel = 0; channel < 32; channel++) views.push(this._spatialMultiInputs[channel].subarray(0, n))
      multiViews.push(views)
    }
    this._spatialViewsByChannelCount.length = 0
    for (let count = 0; count <= 32; count++) {
      const byLength: AudioBuffer[][] = []
      for (let n = 0; n <= 128; n++) byLength.push(multiViews[n].slice(0, count))
      this._spatialViewsByChannelCount.push(byLength)
    }
    this._spatialMultiViews = this._spatialViewsByChannelCount[this._spatialMultiChannelCount]
    this._spatialInputs.length = 0
  }

  /** 上混器输出声道精度切换（引擎自有精度变化时调用；同精度由后端幂等处理）。 */
  private setSpatialUpmixerPrecision(precision: InternalPrecision): void {
    this._stereoUpmixer51.setPrecision(precision)
    this._stereoUpmixer71.setPrecision(precision)
    this._stereoUpmixer514.setPrecision(precision)
    this._stereoUpmixer714.setPrecision(precision)
    this.refreshUpmix71Channels()
    this.refreshUpmix714Channels()
  }

  /** 重建 7.1 上混输出的 HSE 声道顺序引用（精度切换会重建上混器输出缓冲）。 */
  private refreshUpmix71Channels(): void {
    const channels = this._stereoUpmixer71.outputChannels
    const order = this._upmix71Channels
    order.length = 0
    order.push(channels[0], channels[1], channels[2], channels[3], channels[6], channels[7], channels[4], channels[5])
  }

  /** 7.1.4 上混输出的 HSE 声道顺序：WAVE 的 BL/BR 与 SL/SR 互换，顶置层保持。 */
  private refreshUpmix714Channels(): void {
    const channels = this._stereoUpmixer714.outputChannels
    const order = this._upmix714Channels
    order.length = 0
    order.push(channels[0], channels[1], channels[2], channels[3], channels[6], channels[7],
      channels[4], channels[5], channels[8], channels[9], channels[10], channels[11])
  }

  /** 比较空间渲染配置签名；变化时保存新签名供下次比较（无字符串/对象分配）。 */
  private spatialConfigChanged(config: SpatialRenderConfig): boolean {
    const needed = 40 + config.speakers.length * 18
    if (this._spatialSignature.length < needed) {
      this._spatialSignature = new Float64Array(needed)
      this._spatialSignaturePrevious = new Float64Array(needed)
      this._spatialSignatureLength = -1
    }
    const current = this._spatialSignature
    const length = writeSpatialSignature(config, current)
    const previous = this._spatialSignaturePrevious
    let changed = this._spatialSignatureLength !== length
    if (!changed) {
      for (let i = 0; i < length; i++) {
        if (!Object.is(current[i], previous[i])) {
          changed = true
          break
        }
      }
    }
    if (changed) {
      previous.set(current)
      this._spatialSignatureLength = length
    }
    return changed
  }

  private resolveManualGainDb(ln: V3EngineParams['loudnessNormalization']): number {
    const replay = ln.replayGainMode && ln.replayGainMode !== 'off' && Number.isFinite(ln.replayGainDb)
      ? (ln.replayGainDb as number) : 0
    return Math.min(ln.maxGainDb, Math.max(ln.minGainDb, ln.externalGainDb + replay))
  }

  /**
   * 收集用户 EQ（simple/pro）bands，上限由 MAX_PRE_EQ_BANDS 定义。
   * 复用频段对象池与输出数组：只有段数变化才改变返回数组长度，不新建对象。
   */
  private buildPreEqBands(p: V3EngineParams): EqBand[] {
    const bands = this._preEqBands
    // 用户 EQ 仅在 eq.enabled 时并入（eq 关闭时不得泄漏——审计修复）；
    // 机型补偿已移除（由 LoudnessComp 音量曲线承担）
    if (!p.eq.enabled) {
      bands.length = 0
      return bands
    }
    const pool = this._preEqBandPool
    if (p.eq.mode === 'simple') {
      for (let i = 0; i < SIMPLE_EQ_FREQUENCIES.length; i++) {
        const band = pool[i]
        band.frequency = SIMPLE_EQ_FREQUENCIES[i]
        band.gain = p.eq.simpleBands[i] ?? 0
        band.q = 1.1
        band.type = undefined
        bands[i] = band
      }
      bands.length = SIMPLE_EQ_FREQUENCIES.length
      return bands
    }
    const count = Math.min(
      Number.isFinite(p.eq.bandCount) ? Math.max(1, Math.floor(p.eq.bandCount)) : 10,
      p.eq.proBands.length, MAX_PRE_EQ_BANDS)
    for (let i = 0; i < count; i++) {
      const source = p.eq.proBands[i]
      const band = pool[i]
      band.frequency = source.frequency
      band.gain = source.gain
      band.q = source.q
      band.type = source.type
      bands[i] = band
    }
    bands.length = count
    return bands
  }

  /** 混响路由配置：convolution 且 IR 有效 → 卷积；否则算法混响（含自动回退）。 */
  private configureReverb(rv: ReverbSettings, preparedConvolverIR?: PreparedConvolverIR): void {
    const configStartedAt = engineClock()
    const reactivating = rv.enabled && rv.mode !== 'off' && !this._transitions.reverb.isEnabled()
    const previousConvolver = this._convolver
    const previousIR = this._loadedIr
    this._reverbSimple.setParams({ ...rv.algorithmic })
    this._useConvolver = false
    // dePeriodize 参数化（死参数修复）：选项变化时重建 Convolver 并强制重载 IR
    const wantDeP = (rv.convolution.purpose ?? 'reverb') === 'reverb' && rv.convolution.dePeriodize
    const requestedPartition = rv.convolution.partitionSize ?? 512
    const wantPartition = requestedPartition === 128 || requestedPartition === 256
      || requestedPartition === 512 || requestedPartition === 1024 ? requestedPartition : 512
    if (wantDeP !== this._convolverDePeriodize || wantPartition !== this._convolverPartitionSize) {
      // 重建实例必须带上当前内部精度，否则会把 float64 静默降回 float32。
      this._convolver = new Convolver(this._fs, {
        dePeriodize: wantDeP, partitionSize: wantPartition, precision: this._precisionMode,
      })
      this._convolverDePeriodize = wantDeP
      this._convolverPartitionSize = wantPartition
      this._loadedIr = null // 新实例无 IR，强制重载
    }
    if (rv.enabled && rv.mode === 'convolution') {
      const ir = rv.convolution.ir
      if (ir && ir.length > 0) {
        try {
          if (ir !== this._loadedIr) {
            const preparedLoaded = preparedConvolverIR ? this._convolver.loadPreparedIR(preparedConvolverIR) : false
            if (!preparedLoaded) {
              // Convolver.loadIR 内部会复制源 IR，不修改调用方数组；准备数据无效时安全回退。
              this._convolver.loadIR(ir, rv.convolution.irName ?? undefined)
              this._configWork.localIrLoads++
            } else this._configWork.preparedIrLoads++
            this._loadedIr = ir
          }
        // 校正 IR（房间/扬声器/耳机）描述的是整条传递函数，默认全湿；
        // 普通混响仍保留用户可调的干湿混合。
        const purpose = rv.convolution.purpose ?? 'reverb'
        this._convolver.setMix(purpose === 'reverb' ? rv.convolution.mix : 1)
          this._convolver.setPreDelayMs(rv.convolution.preDelayMs)
          this._useConvolver = true
        } catch {
          // 空/非法 IR（模块抛错）：自动回退算法混响
          this._useConvolver = false
        }
      }
    }
    if (reactivating) {
      if (!this._useConvolver) this._reverbSimple.reset()
      else if (this._convolver === previousConvolver && this._loadedIr === previousIR) this._convolver.reset()
    }
    const configMs = Math.max(0, engineClock() - configStartedAt)
    this._configWork.reverbConfigMs += configMs
    this._configWork.blockConfigMs += configMs
  }

  /** 把单声道下混写入环形分析缓冲；每次填满一窗立即分析，避免大块输入重复分析末窗。 */
  private feedAnalysis(l: AudioBuffer, r: AudioBuffer, n: number): void {
    const W = ANALYSIS_WINDOW
    for (let i = 0; i < n; i++) {
      this._ring[this._ringPos] = l[i]
      this._ringR[this._ringPos] = r[i]
      this._ringPos++
      if (this._ringPos === W) this._ringPos = 0
      this._analysisPos++
      if (this._analysisPos === W) {
        this._analysisPos = 0
        this.runAnalysis()
      }
    }
  }

  /** 对最近一窗做 2048 点 FFT（Hann 窗），计算幅度谱与特征，并更新 IEQ。 */
  private runAnalysis(): void {
    const W = ANALYSIS_WINDOW
    for (let i = 0; i < W; i++) {
      const index = (this._ringPos + i) % W
      this._timeBuf[i] = this._ring[index]
      this._timeBufR[i] = this._ringR[index]
      // 一次复 FFT 同时编码两个实声道；镜像 bin 可恢复平均声道功率。
      this._real[i] = this._timeBuf[i] * this._hann[i]
      this._imag[i] = this._timeBufR[i] * this._hann[i]
    }
    fft(this._real, this._imag, false)
    const half = W / 2
    const mag = this._magBuf
    for (let k = 0; k <= half; k++) {
      const mirror = (W - k) % W
      const re = this._real[k]
      const im = this._imag[k]
      const mr = this._real[mirror]
      const mi = this._imag[mirror]
      mag[k] = 0.5 * Math.sqrt(re * re + im * im + mr * mr + mi * mi)
    }
    const f = this._featCache
    const rmsL = computeRms(this._timeBuf)
    const rmsR = computeRms(this._timeBufR)
    f.rms = Math.sqrt((rmsL * rmsL + rmsR * rmsR) * 0.5)
    f.zcr = (computeZcr(this._timeBuf) + computeZcr(this._timeBufR)) * 0.5
    f.centroidHz = spectralCentroid(mag, this._binFreqs)
    f.rolloffHz = spectralRolloff(mag, this._binFreqs)
    f.flatness = spectralFlatness(mag)
    f.crest = spectralCrest(mag)
    this._analysisReady = true
    if (this._ieqActive && f.rms > 1e-5) this.updateIeq(mag)
  }

  /** IEQ：长时频谱与目标曲线之差 → 平滑增益 → 写入内部参数 EQ。 */
  private updateIeq(mag: Float32Array): void {
    const levels = this._ieqLevels
    let overall = 0
    for (let i = 0; i < IEQ_BAND_COUNT; i++) {
      const [lo, hi] = this._ieqBinRanges[i]
      // 频段电平用 RMS（能量平均）而非线性幅度平均：稀疏频谱（纯音/稀疏乐器）下
      // 线性平均会把少数尖峰稀释到接近噪声底（实测 4kHz 单 bin 频段被摊到 -80dB），
      // 驱动 IEQ 增益在两个 ±12dB 极端 clamp 间振荡、输出过度整形；RMS 对尖峰
      // 敏感（平方项），稀释效应小约一个量级。噪声底 clamp 防 -126dB 极端值。
      let sumSq = 0
      for (let k = lo; k <= hi; k++) sumSq += mag[k] * mag[k]
      const rms = Math.sqrt(sumSq / (hi - lo + 1))
      levels[i] = 20 * Math.log10(Math.max(rms, 1e-4)) // -80dB 噪声底
      overall += levels[i]
    }
    overall /= IEQ_BAND_COUNT
    const alpha = this._ieqSmooth
    const strength = this._ieqStrength
    for (let i = 0; i < IEQ_BAND_COUNT; i++) {
      const relative = levels[i] - overall // 相对频谱形状（去掉整体电平偏移）
      const desired = strength * (this._ieqTargets[i] - relative)
      let g = this._ieqGains[i] + alpha * (desired - this._ieqGains[i])
      if (g > 12) g = 12
      else if (g < -12) g = -12
      this._ieqGains[i] = g
      this._ieqBands[i].gain = g
    }
    this._ieqChain.setBands(this._ieqBands)
  }

  /** IEQ 目标曲线（dB，按 1 倍频程 10 段）写入预分配数组，避免每次改参新建数组。 */
  private fillIeqTargetCurve(curve: IeqTargetCurve): void {
    const source = IEQ_TARGETS[curve]
    const targets = this._ieqTargets
    for (let i = 0; i < IEQ_BAND_COUNT; i++) targets[i] = source[i]
  }
}
