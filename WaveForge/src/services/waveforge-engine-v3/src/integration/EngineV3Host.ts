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
 *    参数经 `port.postMessage({type:'params'})` 下发，`stats` 周期回传；
 *  - 'script'：ScriptProcessorNode 兜底（已废弃但 Electron/Chromium 可用），
 *    onaudioprocess 内直接调 EngineV3.process（同一纯 TS 内核，无需打包）；
 *  - 'auto'：优先 worklet，失败自动回退 script（默认）。
 *
 * 确定性/测试：AudioNode 均为鸭子类型（最小接口），Node 测试环境可 stub 验证接线语义。
 */

import { EngineV3 } from '../engine/EngineV3'
import type { V3EngineParams, EngineStats, EngineAnalysis } from '../types'

export type V3HostMode = 'worklet' | 'script' | 'auto'

/** 最小 AudioNode 接口（鸭子类型；Node 测试环境可用 stub 实现） */
export interface V3AudioNodeLike {
  connect?(dest: unknown): unknown
  disconnect?(): unknown
  port?: {
    postMessage(msg: unknown): void
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
  audioContext: V3AudioContextLike
  masterGain: V3AudioNodeLike
  analyser: V3AudioNodeLike
}

export interface V3HostOptions {
  /** 接入模式，默认 'auto'（worklet 优先，失败回退 script） */
  mode?: V3HostMode
  /** worklet 打包产物 URL（worklet 模式必需） */
  workletUrl?: string
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
  private readonly processorName: string
  private readonly blockSize: number

  private handle: V3HostHandle | null = null
  private node: V3AudioNodeLike | null = null
  private activeMode: 'worklet' | 'script' | null = null
  private lastParams: V3EngineParams | null = null
  private lastStats: EngineStats | null = null
  private lastAnalysis: EngineAnalysis | null = null
  private hostFs = 0
  private attachSeq = 0
  private disposed = false

  constructor(opts?: V3HostOptions) {
    this.defaultMode = opts?.mode ?? 'auto'
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

    // 采样率校准（仅自建引擎；注入引擎由调用方保证一致）
    if (!this.engineInjected) {
      if (this.engineRef === null || Math.abs(this.hostFs - ctx.sampleRate) > 1) {
        this.engineRef = new EngineV3(ctx.sampleRate, 2)
        this.hostFs = ctx.sampleRate
        if (this.lastParams) this.engineRef.setParams(this.lastParams)
      }
    }

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
          // 竞态防护：注册期间被 dispose/重 attach → 放弃接线
          if (this.disposed || seq !== this.attachSeq) return
          node = new AWNode(ctx, this.processorName, { outputChannelCount: [2] })
          const port = node.port
          if (port) {
            port.onmessage = (e: { data: unknown }) => {
              const d = e.data as { type?: string; stats?: EngineStats; analysis?: EngineAnalysis }
              if (d?.type === 'stats') {
                if (d.stats) this.lastStats = d.stats
                if (d.analysis) this.lastAnalysis = d.analysis
              }
            }
            const p = params ?? this.lastParams
            if (p) port.postMessage({ type: 'params', params: p })
          }
          mode = 'worklet'
        } catch {
          node = null
        }
      }
    }

    // script 兜底路径（同一纯 TS 内核）
    if (!node && (this.defaultMode === 'auto' || this.defaultMode === 'script') && ctx.createScriptProcessor) {
      const sp = ctx.createScriptProcessor(this.blockSize, 2, 2)
      sp.onaudioprocess = (e) => {
        const inL = e.inputBuffer.getChannelData(0)
        const inR = e.inputBuffer.getChannelData(1)
        const outL = e.outputBuffer.getChannelData(0)
        const outR = e.outputBuffer.getChannelData(1)
        this.engine.process([inL, inR], [outL, outR])
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
      } catch {
        /* noop */
      }
      this.handle = null
      throw new Error('v3 host: no audio path available（worklet 未打包或 script 不可用）')
    }

    handle.masterGain.connect?.(node)
    node.connect?.(handle.analyser)
    this.node = node
    this.activeMode = mode
    if (params) this.lastParams = params
  }

  /** 下发参数：主线程引擎与 worklet 处理器同步更新 */
  setParams(p: V3EngineParams): void {
    this.lastParams = p
    this.engine.setParams(p)
    if (this.node?.port) this.node.port.postMessage({ type: 'params', params: p })
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