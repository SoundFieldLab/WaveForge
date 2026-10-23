/**
 * EngineV3Host —— v3 引擎宿主接线模块（供 WaveForge 引擎切换逻辑使用）
 *
 * 定位：v2 与 v3 是**完全独立的两个引擎**，本模块不做任何 API 兼容层；
 * 只保证一件事：**切换时能正常切到 v3 进行处理**。
 * 切换语义（与 v2 dispose 相同的关键约束，防新旧双链并联打架）：
 *  - attach：masterGain 全断 → 接入 v3 处理节点 → 连 analyser；
 *  - dispose：断开处理节点 → masterGain 全断 → 恢复 masterGain→analyser 直连；
 *  - 幂等：重复 attach 同一 handle 直接 return；
 *  - 竞态：attach 的异步注册期间被 dispose → 完成后放弃接线（防旧节点插进新图）。
 *
 * 接入模式：
 *  - 'worklet'：AudioWorklet 处理器（`worklet/AudioEffectsProcessor.ts`，需先打包单文件）——
 *    参数经 `port.postMessage({type:'params'})` 下发，大型卷积 IR 以预计算 Transferable 一并发送，`stats` 周期回传；
 *  - 'script'：ScriptProcessorNode 兜底（已废弃但 Electron/Chromium 可用），
 *    onaudioprocess 内直接调 EngineV3.process（同一纯 TS 内核，无需打包）；
 *  - 'auto'：优先 worklet，失败自动回退 script（默认）。
 *
 * 确定性/测试：AudioNode 均为鸭子类型（最小接口），Node 测试环境可 stub 验证接线语义。
 */

import { EngineV3 } from '../engine/EngineV3'
import type { V3EngineParams, EngineStats, EngineAnalysis } from '../types'
import type { PreparedConvolverIR } from '../dsp/Convolver'
import type { HrtfGrid } from '../spatial/types'
import type { HeadPose } from '../spatial/HeadPose'
import type { HseProcessingNode, HseSerializableNodeConfig } from './ProcessingNode'
import { createSerializableProcessingNode } from './ProcessingNode'

/** 卷积分区长度的合法集合（避免每次下发参数时重建数组字面量做 includes）。 */
const WORKLET_PARTITION_SIZES = [128, 256, 512, 1024]
/** 空 transfer 常量：无 Transferable 时不构造 Set/空数组。 */
const EMPTY_TRANSFER: Transferable[] = []

export type V3HostMode = 'worklet' | 'script' | 'auto'

/** 最小 AudioNode 接口（鸭子类型；Node 测试环境可用 stub 实现） */
export interface V3AudioNodeLike {
  channelInterpretation?: 'speakers' | 'discrete'
  connect?(dest: unknown): unknown
  disconnect?(): unknown
  port?: {
    postMessage(msg: unknown, transfer?: Transferable[]): void
    onmessage?: ((e: { data: unknown }) => void) | null
  }
  onaudioprocess?: (e: {
    inputBuffer: { getChannelData(ch: number): Float32Array }
    outputBuffer: { getChannelData(ch: number): Float32Array }
  }) => void
}

export interface V3AudioContextLike {
  sampleRate: number
  audioWorklet?: { addModule(url: string): Promise<void> }
  createScriptProcessor?(bufferSize: number, inCh: number, outCh: number): V3AudioNodeLike
}

export interface V3HostHandle {
  /** 解码器确认的离散输入声道数；尤其供 ScriptProcessor 回退使用。 */
  inputChannels?: number
  audioContext: V3AudioContextLike
  masterGain: V3AudioNodeLike
  analyser: V3AudioNodeLike
  channelSplitterNode?: V3AudioNodeLike
}

export interface V3HostOptions {
  /** 接入模式，默认 'auto'（worklet 优先，失败回退 script） */
  mode?: V3HostMode
  /** worklet 打包产物 URL（worklet 模式必需） */
  workletUrl?: string
  /** 可信第三方 DSP 模块的打包 URL；各模块须注册与主线程同名的工厂。 */
  processingModuleUrls?: readonly string[]
  /** worklet 处理器注册名，默认 'waveforge-v3-effects' */
  processorName?: string
  /** script 兜底模式的块长，默认 4096 */
  blockSize?: number
  /** 注入引擎实例（测试/离线复用，采样率由调用方保证与上下文一致）；缺省时宿主按上下文采样率自建 */
  engine?: EngineV3
}

export class EngineV3Host {
  private engineRef: EngineV3 | null
  private readonly engineInjected: boolean
  private readonly defaultMode: V3HostMode
  private readonly workletUrl: string | undefined
  private readonly processingModuleUrls: readonly string[]
  private readonly processorName: string
  private readonly blockSize: number

  private handle: V3HostHandle | null = null
  private node: V3AudioNodeLike | null = null
  private activeMode: 'worklet' | 'script' | null = null
  private lastParams: V3EngineParams | null = null
  private lastStats: EngineStats | null = null
  private lastAnalysis: EngineAnalysis | null = null
  private workletIrRef: Float32Array | null = null
  private workletIrConfigKey = ''
  private workletNeedsRoomCache = true
  /** Worklet 参数消息骨架：postMessage 在返回前结构化克隆，骨架对象可原地更新复用。 */
  private workletMessage: Record<string, unknown> | null = null
  /** 已下发消息的缓存状态；内容未变化时直接重发同一对象，零对象展开/零 Set。 */
  private workletCacheValid = false
  private workletCacheSource: V3EngineParams | null = null
  private workletCacheIr: Float32Array | null = null
  private workletCacheConfigKey = ''
  private workletCacheReuseIr = false
  private workletCacheIrState = false
  /** 无 IR 参数副本缓存（reuseIr/deferIR/preparedIR 三种路径共用同一份，按快照身份失效）。 */
  private workletParamsVariantSource: V3EngineParams | null = null
  private workletParamsVariant: V3EngineParams | null = null
  /** roomEarlyTransferList 结果缓存：仅预准备快照变化时重建。 */
  private roomTransferSource: unknown = null
  private roomTransferCache: Transferable[] | null = null
  private readonly serializableNodes = new Map<string, HseSerializableNodeConfig>()
  private hostFs = 0
  private attachSeq = 0
  private disposed = false
  private spatialHrtf: HrtfGrid | null = null
  private headPose: HeadPose | null = null
  private spatialInputChannels = 2

  constructor(opts?: V3HostOptions) {
    this.defaultMode = opts?.mode ?? 'auto'
    this.processingModuleUrls = [...(opts?.processingModuleUrls ?? [])]
    if (this.processingModuleUrls.length > 32 || this.processingModuleUrls.some(url => typeof url !== 'string' || !url.trim())) throw new Error('invalid processing module URLs')
    this.workletUrl = opts?.workletUrl
    this.processorName = opts?.processorName ?? 'waveforge-v3-effects'
    this.blockSize = opts?.blockSize ?? 4096
    this.engineInjected = opts?.engine != null
    this.engineRef = opts?.engine ?? null
    if (opts?.engine) this.hostFs = NaN // 注入引擎：采样率未知，attach 时不做重建
  }

  /** 引擎实例（惰性创建：attach 时按上下文采样率自建，或返回注入实例） */
  get engine(): EngineV3 {
    if (!this.engineRef) this.engineRef = new EngineV3(this.hostFs > 0 ? this.hostFs : 48000, 2)
    return this.engineRef
  }

  /**
   * 把 v3 引擎接入音频图（幂等：同一 handle 重复调用直接 return）。
   * 语义：masterGain 全断 → 接 v3 处理节点 → 连 analyser；防新旧双链并联。
   */
  async attach(handle: V3HostHandle, params?: V3EngineParams): Promise<void> {
    if (this.handle === handle) {
      if (params) this.setParams(params)
      return
    }
    const seq = ++this.attachSeq
    this.disposed = false
    const ctx = handle.audioContext
    if (Number.isInteger(handle.inputChannels) && handle.inputChannels! > 0 && handle.inputChannels! <= 32)
      this.spatialInputChannels = handle.inputChannels!

    // 采样率校准（仅自建引擎；注入引擎由调用方保证一致）
    if (!this.engineInjected) {
      if (this.engineRef === null || Math.abs(this.hostFs - ctx.sampleRate) > 1) {
        const previousNodes = this.engineRef?.getProcessingNodes() ?? []
        this.engineRef = new EngineV3(ctx.sampleRate, 2)
        this.hostFs = ctx.sampleRate
        if (this.lastParams) this.engineRef.setParams(this.lastParams)
        // 保留注册顺序；描述节点按新采样率重建，函数节点由调用方持有并清理流式状态。
        for (const previous of previousNodes) {
          const config = this.serializableNodes.get(previous.id)
          const node = config ? createSerializableProcessingNode(config, ctx.sampleRate) : previous
          if (!config) node.reset?.()
          this.engineRef.registerProcessingNode(node)
        }
      }
    }

    // 在主线程先完成配置，随后把精确房间线索与参数一起下发。
    const effective = params ?? this.lastParams
    if (effective) this.engine.setParams(effective)
    if (this.spatialHrtf) this.engine.setSpatialHrtf(this.spatialHrtf)

    // ★ 尽早记录 handle：attach 的异步注册期间若被 dispose，
    //   dispose 也能据此恢复 masterGain→analyser 直连（否则音频会死）
    this.handle = handle

    // 先全断 masterGain（v2 同款语义：避免与旧引擎并联打架）
    try {
      handle.masterGain.disconnect?.()
    } catch {
      /* noop */
    }

    let node: V3AudioNodeLike | null = null
    let mode: 'worklet' | 'script' | null = null

    // worklet 路径
    if (this.defaultMode === 'auto' || this.defaultMode === 'worklet') {
      const AWNode = (globalThis as { AudioWorkletNode?: new (ctx: unknown, name: string, opts: unknown) => V3AudioNodeLike })
        .AudioWorkletNode
      if (ctx.audioWorklet?.addModule && AWNode && this.workletUrl) {
        try {
          await ctx.audioWorklet.addModule(this.workletUrl)
          for (const url of this.processingModuleUrls) await ctx.audioWorklet.addModule(url)
          // 竞态防护：注册期间被 dispose/重 attach → 放弃接线。
          // dispose 路径会恢复直连；**重 attach 到另一 handle**（seq 过期）不经过 dispose，
          // 本 handle 的 masterGain 已被上方 disconnect 断开——过期分支必须自己恢复，
          // 否则旧 handle 的音频永久悬空。
          if (this.disposed || seq !== this.attachSeq) {
            try { handle.masterGain.connect?.(handle.analyser) } catch { /* noop */ }
            return
          }
          node = new AWNode(ctx, this.processorName, {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
            channelCount: 32, channelCountMode: 'max', channelInterpretation: 'discrete',
          })
          const port = node.port
          if (port) {
            port.onmessage = (e: { data: unknown }) => {
              const d = e.data as { type?: string; stats?: EngineStats; analysis?: EngineAnalysis }
              if (d?.type === 'stats') {
                if (d.stats) {
                  this.lastStats = d.stats
                  const observed = d.stats.inputChannels
                  if (observed && observed !== this.spatialInputChannels) this.setSpatialInputChannelCount(observed)
                }
                if (d.analysis) this.lastAnalysis = d.analysis
              }
            }
            this.workletIrRef = null
            this.workletIrConfigKey = ''
            this.workletNeedsRoomCache = true
            this.invalidateWorkletParamsCache()
            const p = params ?? this.lastParams
            if (this.spatialHrtf) {
              // 无预准备数据时传纯消息（不构造空 transfer 数组）。
              const roomHrir = this.engine.takePreparedRoomHrir(true)
              const message = { type: 'spatial-hrtf', grid: this.spatialHrtf, roomHrir }
              const transfer = roomHrir === undefined ? EMPTY_TRANSFER : this.roomEarlyTransferList(roomHrir)
              if (transfer.length) port.postMessage(message, transfer)
              else port.postMessage(message)
            }
            if (this.headPose) port.postMessage({ type: 'head-pose', pose: this.headPose })
            if (p) this.postWorkletParams(port, p)
            for (const config of this.serializableNodes.values()) port.postMessage({ type: 'register-node', config })
          }
          mode = 'worklet'
        } catch {
          node = null
        }
      }
    }

    // script 兜底路径（同一纯 TS 内核）
    if (!node && (this.defaultMode === 'auto' || this.defaultMode === 'script') && ctx.createScriptProcessor) {
      // 显式遥测：script 兜底意味着 15 级 DSP 链（含 HRTF 卷积）跑在主线程逐样本回调里，
      // 此前是静默回退，用户可能长期跑在降级模式而无感知。mode 本身仍按原样工作（不改变音频行为）。
      console.warn('[V3Host] AudioWorklet 不可用，回退 ScriptProcessor 主线程 DSP 模式（空间音频/卷积将占用主线程；请检查 worklet 资源加载）')
      const sp = ctx.createScriptProcessor(this.blockSize, 32, 2)
      sp.channelInterpretation = 'discrete'
      const scriptInputs: Float32Array[] = new Array(32)
      const scriptOutputs: Float32Array[] = new Array(2)
      sp.onaudioprocess = (e) => {
        const count = this.spatialInputChannels
        scriptInputs.length = count
        for (let channel = 0; channel < count; channel++) scriptInputs[channel] = e.inputBuffer.getChannelData(channel)
        const outL = e.outputBuffer.getChannelData(0)
        const outR = e.outputBuffer.getChannelData(1)
        scriptOutputs[0] = outL; scriptOutputs[1] = outR
        this.engine.process(scriptInputs, scriptOutputs)
      }
      node = sp
      mode = 'script'
    }

    if (!node) {
      // 无可用音频通路：恢复 masterGain 直连后抛错（handle 已提前记录）
      try {
        handle.masterGain.disconnect?.()
      } catch {
        /* noop */
      }
      try {
        handle.masterGain.connect?.(handle.analyser)
        if (handle.channelSplitterNode) handle.masterGain.connect?.(handle.channelSplitterNode)
      } catch {
        /* noop */
      }
      this.handle = null
      throw new Error('v3 host: no audio path available（worklet 未打包或 script 不可用）')
    }

    handle.masterGain.connect?.(node)
    node.connect?.(handle.analyser)
    if (handle.channelSplitterNode) node.connect?.(handle.channelSplitterNode)
    this.node = node
    this.activeMode = mode
    if (params) this.lastParams = params
  }

  /** 下发参数：主线程引擎与 worklet 处理器同步更新 */
  setParams(p: V3EngineParams): void {
    this.lastParams = p
    this.engine.setParams(p)
    if (this.node?.port) this.postWorkletParams(this.node.port, p)
  }

  setSpatialHrtf(grid: HrtfGrid | null): void {
    this.engine.setSpatialHrtf(grid)
    this.spatialHrtf = grid
    const roomHrir = this.engine.takePreparedRoomHrir(true)
    const port = this.node?.port
    if (!port) return
    const message = { type: 'spatial-hrtf', grid, roomHrir }
    const transfer = roomHrir === undefined ? EMPTY_TRANSFER : this.roomEarlyTransferList(roomHrir)
    if (transfer.length) port.postMessage(message, transfer)
    else port.postMessage(message)
  }

  setSpatialHeadPose(pose: HeadPose | null): void {
    this.headPose = pose
    this.engine.setSpatialHeadPose(pose)
    const roomHrir = this.engine.takePreparedRoomHrir()
    const port = this.node?.port
    if (!port) return
    const message = { type: 'head-pose', pose, roomHrir }
    const transfer = roomHrir === undefined ? EMPTY_TRANSFER : this.roomEarlyTransferList(roomHrir)
    if (transfer.length) port.postMessage(message, transfer)
    else port.postMessage(message)
  }

  /** 解码器已知声道数时可提前准备；统计回传也会自动修正该提示。 */
  setSpatialInputChannelCount(channels: number): void {
    if (!Number.isInteger(channels) || channels < 1 || channels > 32) return
    this.spatialInputChannels = channels
    this.engine.setSpatialInputChannelCount(channels)
    if (this.node?.port && this.lastParams) this.postWorkletParams(this.node.port, this.lastParams)
  }

  /** 已装载的 IR 留在 Worklet 侧；调其他效果时只发送轻量参数快照。 */
  private postWorkletParams(port: NonNullable<V3AudioNodeLike['port']>, p: V3EngineParams): void {
    this.engine.setSpatialInputChannelCount(this.spatialInputChannels)
    const roomHrir = this.engine.takePreparedRoomHrir(this.workletNeedsRoomCache)
    this.workletNeedsRoomCache = false
    const ir = p.reverb.convolution.ir
    const convolution = p.reverb.convolution
    const requestedPartitionSize = convolution.partitionSize ?? 512
    const partitionSize = WORKLET_PARTITION_SIZES.includes(requestedPartitionSize) ? requestedPartitionSize : 512
    const dePeriodize = (convolution.purpose ?? 'reverb') === 'reverb' && convolution.dePeriodize
    const activeConvolution = !!ir && p.reverb.enabled && p.reverb.mode === 'convolution'
    const configKey = activeConvolution
      ? `${p.sampleRate}:${ir!.length}:${convolution.irName ?? ''}:${partitionSize}:${dePeriodize}`
      : ''
    const sameCachedIR = !!ir && ir === this.workletIrRef
    const reuseIr = this.workletIrRef !== null && (!activeConvolution
      || (sameCachedIR && configKey === this.workletIrConfigKey))
    const prepareOnControlThread = activeConvolution && ir!.length > partitionSize * 4
    const needsPreparedIR = !reuseIr && prepareOnControlThread
    const deferIR = !activeConvolution
    const irStatePresent = !!ir || this.workletIrRef !== null
    // 快路径：同一参数快照 + 相同 IR/路由状态 + 没有新的预准备数据 ⇒ 直接重发缓存消息。
    // 复用对象是安全的：postMessage 返回前已完成结构化克隆，音频线程只会拿到独立副本。
    if (roomHrir === undefined && !needsPreparedIR && this.workletCacheValid
      && this.workletCacheSource === p && this.workletCacheIr === ir
      && this.workletCacheConfigKey === configKey && this.workletCacheReuseIr === reuseIr
      && this.workletCacheIrState === irStatePresent) {
      port.postMessage(this.workletMessage)
      return
    }
    const preparedIR = needsPreparedIR ? this.engine.createPreparedConvolverIRTransfer() : null
    // 消息骨架复用：只改字段，不再每次调用展开多个对象；缺省字段删除以保持消息形状稳定。
    const message = this.workletMessage ?? (this.workletMessage = { type: 'params', params: p })
    message.params = reuseIr || deferIR || preparedIR ? this.irNullParamsVariant(p) : p
    if (roomHrir !== undefined) message.roomHrir = roomHrir
    else delete message.roomHrir
    if (irStatePresent) {
      message.reuseIr = reuseIr
      message.irChanged = !reuseIr
    } else {
      delete message.reuseIr
      delete message.irChanged
    }
    if (preparedIR) message.preparedConvolverIR = preparedIR
    else delete message.preparedConvolverIR
    // 只有真正存在 Transferable 时才构造列表；无预准备数据时零 Set、零空数组。
    const roomTransfer = roomHrir === undefined ? null : this.roomEarlyTransferList(roomHrir)
    const irTransfer = preparedIR ? this.convolverIrTransferList(preparedIR) : null
    const transfer = roomTransfer && irTransfer ? [...roomTransfer, ...irTransfer] : (roomTransfer ?? irTransfer)
    if (transfer && transfer.length) port.postMessage(message, transfer)
    else port.postMessage(message)
    // 缓存仅在无 transfer 时可复用：转移后的 buffer 已脱离主线程，不能再投递。
    this.workletCacheSource = p
    this.workletCacheIr = ir
    this.workletCacheConfigKey = configKey
    this.workletCacheReuseIr = reuseIr
    this.workletCacheIrState = irStatePresent
    this.workletCacheValid = !(transfer && transfer.length)
    if (activeConvolution) {
      this.workletIrRef = ir
      this.workletIrConfigKey = configKey
    } else if (!reuseIr) {
      // Worklet no longer retains a reusable identity for this IR; defer loading until convolution is enabled.
      this.workletIrRef = null
      this.workletIrConfigKey = ''
    }
  }

  /** 无 IR 参数副本（ir=null）：reuseIr/deferIR/preparedIR 三条路径共用，按快照身份缓存。 */
  private irNullParamsVariant(p: V3EngineParams): V3EngineParams {
    if (this.workletParamsVariantSource !== p || this.workletParamsVariant === null) {
      this.workletParamsVariantSource = p
      this.workletParamsVariant = { ...p, reverb: { ...p.reverb,
        convolution: { ...p.reverb.convolution, ir: null } } }
    }
    return this.workletParamsVariant
  }

  /** 清空 Worklet 参数消息缓存（重连/dispose/采样率重建后重新下发）。 */
  private invalidateWorkletParamsCache(): void {
    this.workletCacheValid = false
    this.workletCacheSource = null
    this.workletCacheIr = null
    this.workletCacheConfigKey = ''
    this.workletCacheReuseIr = false
    this.workletCacheIrState = false
    this.workletParamsVariantSource = null
    this.workletParamsVariant = null
    this.roomTransferSource = null
    this.roomTransferCache = null
  }

  /** 只遍历主线程刚生成的可转移快照；频谱与工作缓冲不在音频线程重新分配。
   *  同一个预准备快照对象的结果缓存复用（快照是一次性的，调用方每个快照只取一次）。 */
  private roomEarlyTransferList(prepared: unknown): Transferable[] {
    if (prepared === undefined) return EMPTY_TRANSFER
    if (prepared === this.roomTransferSource && this.roomTransferCache) return this.roomTransferCache
    const buffers = new Set<ArrayBuffer>()
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      if (ArrayBuffer.isView(value)) { if (value.buffer instanceof ArrayBuffer) buffers.add(value.buffer); return }
      for (const child of Object.values(value)) visit(child)
    }
    visit(prepared)
    const list = [...buffers]
    this.roomTransferSource = prepared
    this.roomTransferCache = list
    return list
  }

  private convolverIrTransferList(ir: PreparedConvolverIR): Transferable[] {
    return [
      ir.irSpecReal.buffer, ir.irSpecImag.buffer,
      ir.workReal.buffer, ir.workImag.buffer, ir.sumReal.buffer, ir.sumImag.buffer,
      ir.simdProductReal.buffer, ir.simdProductImag.buffer,
      ir.historyRealL.buffer, ir.historyImagL.buffer, ir.historyRealR.buffer, ir.historyImagR.buffer,
      ir.overlapL.buffer, ir.overlapR.buffer, ir.inputBlockL.buffer, ir.inputBlockR.buffer,
      ir.pendingWetL.buffer, ir.pendingWetR.buffer,
      ir.wetDelayL.buffer, ir.wetDelayR.buffer,
    ]
  }

  /** 可序列化节点同时进入主线程参照引擎和 Worklet 实际音频链。 */
  registerSerializableProcessingNode(config: HseSerializableNodeConfig): void {
    const copy = structuredClone(config)
    const fs = this.handle?.audioContext.sampleRate ?? (this.hostFs > 0 ? this.hostFs : 48000)
    const node = createSerializableProcessingNode(copy, fs)
    this.serializableNodes.set(copy.id, copy)
    this.engine.registerProcessingNode(node)
    this.node?.port?.postMessage({ type: 'register-node', config: copy })
  }

  /** 函数回调仅可在 ScriptProcessor 模式注册，避免 Worklet 播放静默跳过。 */
  registerProcessingNode(node: HseProcessingNode): void {
    if (this.activeMode === 'worklet' || (this.activeMode === null && this.defaultMode !== 'script')) {
      throw new Error('函数处理节点仅支持 script 模式；Worklet 请注册可序列化节点')
    }
    this.engine.registerProcessingNode(node)
    this.serializableNodes.delete(node.id)
  }

  unregisterProcessingNode(id: string): boolean {
    const removed = this.engine.unregisterProcessingNode(id)
    if (this.serializableNodes.delete(id)) this.node?.port?.postMessage({ type: 'unregister-node', id })
    return removed
  }

  /** 拆除 v3 链路并恢复 masterGain→analyser 直连（v2 dispose 同款语义） */
  dispose(): void {
    this.disposed = true
    this.attachSeq++
    const h = this.handle
    const n = this.node
    this.node = null
    this.handle = null
    this.activeMode = null
    this.lastAnalysis = null
    this.workletIrRef = null
    this.workletIrConfigKey = ''
    this.invalidateWorkletParamsCache()
    if (n) {
      try {
        n.disconnect?.()
      } catch {
        /* noop */
      }
    }
    if (h) {
      try {
        h.masterGain.disconnect?.()
      } catch {
        /* noop */
      }
      try {
        h.masterGain.connect?.(h.analyser)
        if (h.channelSplitterNode) h.masterGain.connect?.(h.channelSplitterNode)
      } catch {
        /* noop */
      }
    }
  }

  /** 当前接入模式（未接入返回 null） */
  getMode(): 'worklet' | 'script' | null {
    return this.activeMode
  }

  /** 最近一次 worklet 回传的统计（script 模式为 null） */
  getLastStats(): EngineStats | null {
    return this.lastStats
  }

  /** 最近一次 worklet 回传的频谱/特征（script 模式为 null；主线程引擎自身可分析） */
  getLastAnalysis(): EngineAnalysis | null {
    return this.lastAnalysis
  }

  /** 当前 v3 处理节点（未接入返回 null）。供融合层在 masterGain 与处理节点之间
   *  插入前置节点（如 SoundTouch 变速变调），接线方负责断开重连语义。 */
  getAudioNode(): V3AudioNodeLike | null {
    return this.node
  }
}