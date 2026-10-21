/**
 * WaveForge 音频效果引擎 v3 —— AudioWorklet 处理器（实时渲染线程）
 *
 * 出处/许可：架构借鉴 Tone.js(MIT) 的 AudioWorklet 消息管道思路（设计文档 §15 /
 *   映射表 #20 🟡 借鉴架构），处理器本体为自研封装，不含第三方代码。
 *
 * 融合打包注意：AudioWorklet 全局作用域**不支持裸 import/export**——引擎与全部 DSP
 *   依赖必须内联进单个处理器文件（esbuild / vite worklet 插件打包后替换本文件内容），
 *   并保留文件末尾的 registerProcessor 守卫；本文件以源码形态给出，便于阅读与单测。
 *
 * 线程模型：
 *   - 构造：以全局 sampleRate 创建 EngineV3；输入按离散声道保留，空间级可接收最多 32 声道；
 *   - port.onmessage：接收主线程参数快照与可选的预分区 IR Transferable；大 IR 的频谱/工作区在
 *     控制线程准备，Worklet 只在下一渲染帧接管并应用配置；另接收 {type:'reset'}；
 *   - 每 STATS_INTERVAL_CALLBACKS 次 process 回调（约 30×128 帧 ≈ 80ms @48kHz）
 *     向主线程回传一次 {type:'stats', stats: EngineStats}。
 */

import { EngineV3 } from '../engine/EngineV3'
import type { EngineConfigWork } from '../engine/EngineV3'
import { createSerializableProcessingNode } from '../integration/ProcessingNode'
import type { HseSerializableNodeConfig } from '../integration/ProcessingNode'
import type { V3EngineParams, EngineStats, EngineAnalysis } from '../types'
import type { PreparedRoomHrir } from '../spatial/TsConvolverBackend'
import type { HrtfGrid } from '../spatial/types'
import type { HeadPose } from '../spatial/HeadPose'
import type { PreparedConvolverIR } from '../dsp/Convolver'

export const WORKLET_PROCESSOR_NAME = 'waveforge-v3-effects'

/** AudioWorklet 全局作用域环境声明（lib.dom 未内置这些全局符号，故本地声明） */
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  readonly currentTime: number
  readonly currentFrame: number
  readonly sampleRate: number
  constructor(options?: AudioWorkletProcessorOptions)
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}

interface AudioWorkletProcessorOptions {
  numberOfInputs: number
  numberOfOutputs: number
  outputChannelCount: number[]
  parameterData: Record<string, number>
  processorOptions: unknown
}

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: new (options?: AudioWorkletProcessorOptions) => AudioWorkletProcessor): void

/** stats 回传周期（process 回调次数） */
const STATS_INTERVAL_CALLBACKS = 30
/**
 * 待处理房间 HRIR 增量缓冲的固定容量（单类消息）。容量依据：Worklet 渲染量子最长 128 帧，
 * 48kHz 下配置间隔 ≥2.67ms；主线程只在空间配置/姿态/数据集变化时附带增量线索，一帧内
 * 累积 256 条已远超真实交互（连续拖动 + 头追上限约数百 Hz）。超出时丢弃最旧条目并累计
 * droppedRoomHrir，避免长跑不限增长；丢弃只损失“预准备优化提示”（接收端仍按 revision /
 * gridSignature 校验并回退本地插值），不影响音频正确性。
 *
 * 同帧一致性：spatial-hrtf 数据集缓冲按协议只保留最新 1 条（新数据集替换旧数据集，网格与
 * 姿态由同帧的 pendingSpatialHrtf/pendingHeadPose 一并提交），不会被“丢最旧”拆散；room 增量
 * 与网格顺序固定为“数据集线索 → 增量到达顺序”，逐类丢弃不会改变必须同时提交的组合。
 */
const PENDING_ROOM_HRIR_CAPACITY = 256
/** 帧边界合并后的房间 HRIR 上限（数据集 1 条 + 每类增量最多 256 条，预留双份余量，正常不可达）。 */
const ROOM_HRIR_FRAME_CAPACITY = 512
/** 空声道列表常量：process 内不得出现数组字面量，空输入/空输出时复用只读常量。 */
const EMPTY_CHANNELS: Float32Array[] = []
/** 空房间 HRIR 列表常量：无待处理数据时传给引擎的只读常量（引擎只读遍历）。 */
const EMPTY_ROOM_HRIR: PreparedRoomHrir[] = []
const HIGH_RES_CLOCK = typeof globalThis.performance?.now === 'function'
const CLOCK_RESOLUTION_MS = HIGH_RES_CLOCK ? 0 : 1
const processClock = HIGH_RES_CLOCK ? () => globalThis.performance.now() : () => Date.now()

export class AudioEffectsProcessor extends AudioWorkletProcessor {
  private readonly engine: EngineV3
  private activeIr: Float32Array | null = null
  private pendingParams: V3EngineParams | null = null
  private pendingReset = false
  private pendingSpatialHrtf: HrtfGrid | null | undefined
  /** 预分配待处理缓冲：只移动计数，不在帧边界新建/丢弃数组。 */
  private readonly pendingSpatialHrtfRoom: PreparedRoomHrir[] = new Array(PENDING_ROOM_HRIR_CAPACITY)
  private pendingSpatialHrtfRoomCount = 0
  private pendingHeadPose: HeadPose | null | undefined
  private readonly pendingRoomHrir: PreparedRoomHrir[] = new Array(PENDING_ROOM_HRIR_CAPACITY)
  private pendingRoomHrirCount = 0
  /** 帧边界合并输出（复用同一对象；只改 length/槽位，引擎按数组 content 只读消费）。 */
  private readonly roomHrirFrame: PreparedRoomHrir[] = new Array(ROOM_HRIR_FRAME_CAPACITY)
  /** 超过容量被丢弃的条目总数（诊断用，不进入音频输出）。 */
  private droppedRoomHrir = 0
  private pendingPreparedConvolverIR: PreparedConvolverIR | null = null
  private callbackCount = 0
  private timingCallbacks = 0
  private maxProcessMs = 0
  private maxConfigMs = 0
  private maxDspMs = 0
  private overrunCount = 0
  // —— 超预算归因计数（每次 stats 回传后清零；只递增，不参与音频输出） ——
  private overrunConfig = 0
  private overrunSteady = 0
  private configCallbacks = 0
  private preparedIrCallbacks = 0
  private hrtfCallbacks = 0
  private poseCallbacks = 0
  private resetCallbacks = 0
  /** 引擎配置工作量计数（复用对象，每次遥测读取后清零）。 */
  private readonly configWork: EngineConfigWork = {
    paramsApplied: 0, poseUpdates: 0, roomHrirItems: 0, hrtfLoads: 0, spatialConfigs: 0,
    preparedIrLoads: 0, localIrLoads: 0, spatialConfigMs: 0, reverbConfigMs: 0, blockConfigMs: 0,
    directPreparedHits: 0, directPreparedMisses: 0, preparedSpeakerIrs: 0, localSpeakerIrs: 0,
    roomPreparedHits: 0, roomPreparedMisses: 0, roomRebuilds: 0, convolverInstances: 0,
    preparedPrimes: 0, preparedEntries: 0,
  }
  /** 本 stats 窗口内块内配置耗时（毫秒，含延迟过渡提交）。 */
  private blockConfigMsTotal = 0
  private maxBlockConfigMs = 0
  private lastInputChannels = 0
  private scratch: Float32Array = new Float32Array(128)
  private silence: Float32Array = new Float32Array(128)
  private readonly inputPair: Float32Array[] = [this.silence, this.silence]
  private readonly outputPair: Float32Array[] = [this.scratch, this.scratch]
  private readonly report = {
    type: 'stats',
    stats: {} as EngineStats,
    analysis: { spectrum: null, features: null } as EngineAnalysis,
    inputChannels: 0,
    timing: { clock: HIGH_RES_CLOCK ? 'performance' : 'date', resolutionMs: CLOCK_RESOLUTION_MS,
      maxProcessMs: 0, maxConfigMs: 0, maxDspMs: 0, blockBudgetMs: 0, overruns: 0, callbacks: 0,
      // 超限丢弃计数：只递增、不在音频线程打日志（避免刷屏），随 stats 周期回传。
      droppedRoomHrir: 0,
      // 超预算归因：配置回调 vs 稳态 DSP；以及本窗口配置事件计数。
      overrunConfig: 0, overrunSteady: 0,
      configCallbacks: 0, preparedIrCallbacks: 0, hrtfCallbacks: 0, poseCallbacks: 0, resetCallbacks: 0,
      paramsApplied: 0, poseUpdates: 0, roomHrirItems: 0, hrtfLoads: 0, spatialConfigs: 0,
      preparedIrLoads: 0, localIrLoads: 0,
      spatialConfigMs: 0, reverbConfigMs: 0, blockConfigMs: 0, maxBlockConfigMs: 0,
      directPreparedHits: 0, directPreparedMisses: 0, preparedSpeakerIrs: 0, localSpeakerIrs: 0,
      roomPreparedHits: 0, roomPreparedMisses: 0, roomRebuilds: 0, convolverInstances: 0,
      preparedPrimes: 0, preparedEntries: 0 },
  }

  constructor() {
    super()
    // 全局 sampleRate 在 AudioWorklet 全局作用域恒存在（48kHz/44.1kHz 等）
    this.engine = new EngineV3(sampleRate, 2)
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; params?: V3EngineParams; reuseIr?: boolean; irChanged?: boolean;
        preparedConvolverIR?: PreparedConvolverIR; config?: HseSerializableNodeConfig; id?: string; roomHrir?: PreparedRoomHrir; grid?: HrtfGrid | null; pose?: HeadPose | null }
      if (msg === null || typeof msg !== 'object') return
      if (msg.type === 'params' && msg.params) {
        // 合流时累积缓存增量，避免跳过中间参数后丢失可复用方向。
        if (msg.roomHrir) this.pendingRoomHrirCount = this.pushPendingRoomHrir(this.pendingRoomHrir, this.pendingRoomHrirCount, msg.roomHrir)
        const params = msg.params
        // 参数消息是 MessagePort 结构化克隆出的私有副本：直接就地写回 IR 字段，
        // 不再逐消息展开 reverb/convolution（原实现每消息 3 个临时对象）。
        // activeIr 仍按原语义：每次新 prepared IR 用新的 1 样本标记维持引擎 identity 判定。
        if (msg.preparedConvolverIR) {
          // 唯一标记用于引擎内 IR identity/reuse；原始长时域 IR 不随参数消息复制。
          this.activeIr = new Float32Array(1)
          params.reverb.convolution.ir = this.activeIr
        } else if (msg.reuseIr) {
          params.reverb.convolution.ir = this.activeIr
        } else {
          this.activeIr = params.reverb.convolution.ir
        }
        if (msg.irChanged) this.pendingPreparedConvolverIR = msg.preparedConvolverIR ?? null
        else if (msg.preparedConvolverIR) this.pendingPreparedConvolverIR = msg.preparedConvolverIR
        // 主线程连续拖动时只保留最后一份完整快照；在下一渲染帧边界统一应用。
        this.pendingParams = params
      } else if (msg.type === 'spatial-hrtf') {
        this.pendingSpatialHrtf = msg.grid ?? null
        // 协议上该消息只携带一条 roomHrir；用计数槽位替换数组字面量 [msg.roomHrir]。
        if (msg.roomHrir) { this.pendingSpatialHrtfRoom[0] = msg.roomHrir; this.pendingSpatialHrtfRoomCount = 1 }
        else this.pendingSpatialHrtfRoomCount = 0
      } else if (msg.type === 'head-pose') {
        this.pendingHeadPose = msg.pose ?? null
        if (msg.roomHrir) this.pendingRoomHrirCount = this.pushPendingRoomHrir(this.pendingRoomHrir, this.pendingRoomHrirCount, msg.roomHrir)
      } else if (msg.type === 'reset') {
        // reset 只清流式历史，不取消已接收的参数；两者都在渲染帧边界提交。
        this.pendingReset = true
      } else if (msg.type === 'register-node' && msg.config) {
        this.engine.registerProcessingNode(createSerializableProcessingNode(msg.config, sampleRate))
      } else if (msg.type === 'unregister-node' && typeof msg.id === 'string') {
        this.engine.unregisterProcessingNode(msg.id)
      }
    }
  }

  /** 追加一条预准备房间线索：固定容量内写槽位，超限丢弃最旧并计数（只在消息到达时执行）。 */
  private pushPendingRoomHrir(list: PreparedRoomHrir[], count: number, item: PreparedRoomHrir): number {
    if (count < PENDING_ROOM_HRIR_CAPACITY) {
      list[count] = item
      return count + 1
    }
    for (let i = 1; i < PENDING_ROOM_HRIR_CAPACITY; i++) list[i - 1] = list[i]
    list[PENDING_ROOM_HRIR_CAPACITY - 1] = item
    this.droppedRoomHrir++
    return count
  }

  /**
   * 帧边界把 spatial-hrtf 线索与增量线索按到达顺序搬进复用缓冲。
   * 返回的数组只在本次配置调用（setParams/setSpatialHrtf/setSpatialHeadPose）期间有效；
   * 引擎只读遍历并复制引用，不会保留该数组本身。无数据时返回共享空常量。
   */
  private buildFrameRoomHrir(gridPending: boolean): PreparedRoomHrir[] {
    let n = 0
    if (gridPending) {
      for (let i = 0; i < this.pendingSpatialHrtfRoomCount; i++) this.roomHrirFrame[n++] = this.pendingSpatialHrtfRoom[i]
      this.pendingSpatialHrtfRoomCount = 0
    }
    for (let i = 0; i < this.pendingRoomHrirCount; i++) {
      if (n >= ROOM_HRIR_FRAME_CAPACITY) { this.droppedRoomHrir++; continue } // 防御分支：容量已按双份上限预留，正常不可达
      this.roomHrirFrame[n++] = this.pendingRoomHrir[i]
    }
    this.pendingRoomHrirCount = 0
    if (n === 0) return EMPTY_ROOM_HRIR
    // 只改 length：槽位对象均为外部传入的预准备数据引用，不产生新数组。
    this.roomHrirFrame.length = n
    return this.roomHrirFrame
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const startedAt = processClock()
    const hadParams = this.pendingParams !== null
    const hadReset = this.pendingReset
    const hadHrtf = this.pendingSpatialHrtf !== undefined
    const hadPose = this.pendingHeadPose !== undefined
    const hadPreparedIr = this.pendingPreparedConvolverIR !== null
    const configuring = hadParams || hadReset || hadHrtf || hadPose
    if (configuring) {
      this.configCallbacks++
      if (hadPreparedIr) this.preparedIrCallbacks++
      if (hadHrtf) this.hrtfCallbacks++
      if (hadPose && !hadParams) this.poseCallbacks++
      if (hadReset) this.resetCallbacks++
    }
    const observedInputChannels = inputs[0]?.length ?? 0
    if (observedInputChannels) this.engine.setSpatialInputChannelCount(observedInputChannels, configuring)
    if (configuring) {
    const gridPending = this.pendingSpatialHrtf !== undefined
    const pose = this.pendingHeadPose
    this.pendingHeadPose = undefined
    // 帧边界只搬运计数到预分配缓冲：不新建合并数组、不清空重建待处理列表。
    const roomHrir = this.buildFrameRoomHrir(gridPending)
    if (this.pendingParams) {
      const next = this.pendingParams
      this.pendingParams = null
      const preparedConvolverIR = this.pendingPreparedConvolverIR
      this.pendingPreparedConvolverIR = null
      // 同帧参数和姿态按最终快照只配置一次，预计算数据不会被旧参数提前消耗。
      this.engine.setParams(next, roomHrir, preparedConvolverIR ?? undefined, pose, gridPending)
    } else if (pose !== undefined) this.engine.setSpatialHeadPose(pose, roomHrir, gridPending)
    if (gridPending) {
      const grid = this.pendingSpatialHrtf; this.pendingSpatialHrtf = undefined
      // pendingSpatialHrtfRoom 已在 buildFrameRoomHrir 中消费并清零计数。
      this.engine.setSpatialHrtf(grid ?? null, roomHrir)
    }
    if (this.pendingReset) {
      this.pendingReset = false
      this.engine.reset()
    }
    }
    if (configuring) {
      this.maxConfigMs = Math.max(this.maxConfigMs, Math.max(0, processClock() - startedAt))
    }
    const dspStartedAt = processClock()
    const outChannels = outputs.length > 0 ? outputs[0] : EMPTY_CHANNELS
    if (outChannels.length === 0) return true // 无输出通道，保持处理器存活
    const frameCount = outChannels[0].length
    // 缓冲按渲染量子预分配/按需扩容（仅尺寸变化时分配一次）
    if (this.silence.length < frameCount) this.silence = new Float32Array(frameCount)
    if (this.scratch.length < frameCount) this.scratch = new Float32Array(frameCount)

    const inChannels = inputs.length > 0 ? inputs[0] : EMPTY_CHANNELS
    this.lastInputChannels = inChannels.length
    const l = inChannels[0] ?? this.silence // 无输入时静音
    const r = inChannels[1] ?? l // 单声道输入复制到双声道

    this.inputPair[0] = l
    this.inputPair[1] = r
    this.outputPair[0] = outChannels[0]
    this.outputPair[1] = outChannels.length >= 2 ? outChannels[1] : this.scratch
    this.engine.process(inChannels.length > 2 ? inChannels : this.inputPair, this.outputPair)
    // 过渡提交等延迟配置发生在 process 内：累计块内配置耗时用于超预算归因。
    const blockConfigMs = this.engine.getBlockConfigMs()
    this.blockConfigMsTotal += blockConfigMs
    if (blockConfigMs > this.maxBlockConfigMs) this.maxBlockConfigMs = blockConfigMs
    if (outChannels.length < 2) {
      // 单声道输出：引擎按立体声处理，再把两声道各取半混合回单声道
      for (let i = 0; i < frameCount; i++) {
        outChannels[0][i] = (outChannels[0][i] + this.scratch[i]) * 0.5
      }
    }

    const blockBudgetMs = frameCount / sampleRate * 1000
    const endedAt = processClock()
    const elapsed = Math.max(0, endedAt - startedAt)
    this.maxDspMs = Math.max(this.maxDspMs, Math.max(0, endedAt - dspStartedAt))
    this.maxProcessMs = Math.max(this.maxProcessMs, elapsed)
    // 毫秒时钟存在量化误差，只把超出一个时钟粒度的样本计为确定超时。
    if (elapsed > blockBudgetMs + CLOCK_RESOLUTION_MS) {
      this.overrunCount++
      // 归因：配置回调，或本帧内发生（含延迟过渡提交的）配置工作时计入配置类。
      if (configuring || blockConfigMs > 0.5) this.overrunConfig++
      else this.overrunSteady++
    }
    this.timingCallbacks++
    this.callbackCount++
    if (this.callbackCount >= STATS_INTERVAL_CALLBACKS) {
      this.callbackCount = 0
      // stats + analysis 一并回传：worklet 模式下主线程引擎不接触音频流，
      // 频谱/特征只能由渲染线程回传（否则 UI 分析页频谱静止不动）
      this.engine.getStats(this.report.stats)
      this.engine.getAnalysis(this.report.analysis)
      this.report.inputChannels = this.lastInputChannels
      const timing = this.report.timing
      timing.maxProcessMs = this.maxProcessMs
      timing.maxConfigMs = this.maxConfigMs
      timing.maxDspMs = this.maxDspMs
      timing.blockBudgetMs = blockBudgetMs
      timing.overruns = this.overrunCount
      timing.callbacks = this.timingCallbacks
      timing.droppedRoomHrir = this.droppedRoomHrir
      timing.overrunConfig = this.overrunConfig
      timing.overrunSteady = this.overrunSteady
      timing.configCallbacks = this.configCallbacks
      timing.preparedIrCallbacks = this.preparedIrCallbacks
      timing.hrtfCallbacks = this.hrtfCallbacks
      timing.poseCallbacks = this.poseCallbacks
      timing.resetCallbacks = this.resetCallbacks
      this.engine.getConfigWork(this.configWork)
      this.engine.resetConfigWork()
      timing.paramsApplied = this.configWork.paramsApplied
      timing.poseUpdates = this.configWork.poseUpdates
      timing.roomHrirItems = this.configWork.roomHrirItems
      timing.hrtfLoads = this.configWork.hrtfLoads
      timing.spatialConfigs = this.configWork.spatialConfigs
      timing.preparedIrLoads = this.configWork.preparedIrLoads
      timing.localIrLoads = this.configWork.localIrLoads
      timing.spatialConfigMs = this.configWork.spatialConfigMs
      timing.reverbConfigMs = this.configWork.reverbConfigMs
      timing.blockConfigMs = this.blockConfigMsTotal
      timing.maxBlockConfigMs = this.maxBlockConfigMs
      timing.directPreparedHits = this.configWork.directPreparedHits
      timing.directPreparedMisses = this.configWork.directPreparedMisses
      timing.preparedSpeakerIrs = this.configWork.preparedSpeakerIrs
      timing.localSpeakerIrs = this.configWork.localSpeakerIrs
      timing.roomPreparedHits = this.configWork.roomPreparedHits
      timing.roomPreparedMisses = this.configWork.roomPreparedMisses
      timing.roomRebuilds = this.configWork.roomRebuilds
      timing.convolverInstances = this.configWork.convolverInstances
      timing.preparedPrimes = this.configWork.preparedPrimes
      timing.preparedEntries = this.configWork.preparedEntries
      // MessagePort在返回前已结构化克隆；下次更新存储不会改写已投递的快照。
      this.port.postMessage(this.report)
      this.maxProcessMs = 0
      this.maxConfigMs = 0
      this.maxDspMs = 0
      this.overrunCount = 0
      this.timingCallbacks = 0
      this.overrunConfig = 0
      this.overrunSteady = 0
      this.configCallbacks = 0
      this.preparedIrCallbacks = 0
      this.hrtfCallbacks = 0
      this.poseCallbacks = 0
      this.resetCallbacks = 0
      this.blockConfigMsTotal = 0
      this.maxBlockConfigMs = 0
    }
    return true // 保持处理器存活
  }
}

// AudioWorklet 全局作用域下才存在 registerProcessor；Node/测试环境跳过注册。
typeof registerProcessor !== 'undefined' &&
  registerProcessor(WORKLET_PROCESSOR_NAME, AudioEffectsProcessor)