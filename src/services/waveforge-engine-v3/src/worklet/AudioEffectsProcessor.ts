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
 *   - 构造：以全局 sampleRate 创建 EngineV3（2 声道）；
 *   - port.onmessage：接收主线程 {type:'params', params: V3EngineParams} 与
 *     {type:'reset'} 消息，参数快照语义（setParams 整体替换）；
 *   - 每 STATS_INTERVAL_CALLBACKS 次 process 回调（约 30×128 帧 ≈ 80ms @48kHz）
 *     向主线程回传一次 {type:'stats', stats: EngineStats}。
 */

import { EngineV3 } from '../engine/EngineV3'
import type { V3EngineParams } from '../types'

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

export class AudioEffectsProcessor extends AudioWorkletProcessor {
  private readonly engine: EngineV3
  private callbackCount = 0
  private scratch: Float32Array = new Float32Array(0)
  private silence: Float32Array = new Float32Array(0)

  constructor() {
    super()
    // 全局 sampleRate 在 AudioWorklet 全局作用域恒存在（48kHz/44.1kHz 等）
    this.engine = new EngineV3(sampleRate, 2)
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; params?: V3EngineParams }
      if (msg === null || typeof msg !== 'object') return
      if (msg.type === 'params' && msg.params) {
        this.engine.setParams(msg.params)
      } else if (msg.type === 'reset') {
        this.engine.reset()
      }
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>): boolean {
    const outChannels = outputs.length > 0 ? outputs[0] : []
    if (outChannels.length === 0) return true // 无输出通道，保持处理器存活
    const frameCount = outChannels[0].length
    // 缓冲按渲染量子预分配/按需扩容（仅尺寸变化时分配一次）
    if (this.silence.length < frameCount) this.silence = new Float32Array(frameCount)
    if (this.scratch.length < frameCount) this.scratch = new Float32Array(frameCount)

    const inChannels = inputs.length > 0 ? inputs[0] : []
    const l = inChannels[0] ?? this.silence // 无输入时静音
    const r = inChannels[1] ?? l // 单声道输入复制到双声道

    if (outChannels.length >= 2) {
      this.engine.process([l, r], [outChannels[0], outChannels[1]])
    } else {
      // 单声道输出：引擎按立体声处理，再把两声道各取半混合回单声道
      this.engine.process([l, r], [outChannels[0], this.scratch])
      for (let i = 0; i < frameCount; i++) {
        outChannels[0][i] = (outChannels[0][i] + this.scratch[i]) * 0.5
      }
    }

    this.callbackCount++
    if (this.callbackCount >= STATS_INTERVAL_CALLBACKS) {
      this.callbackCount = 0
      // stats + analysis 一并回传：worklet 模式下主线程引擎不接触音频流，
      // 频谱/特征只能由渲染线程回传（否则 UI 分析页频谱静止不动）
      this.port.postMessage({ type: 'stats', stats: this.engine.getStats(), analysis: this.engine.getAnalysis() })
    }
    return true // 保持处理器存活
  }
}

// AudioWorklet 全局作用域下才存在 registerProcessor；Node/测试环境跳过注册。
typeof registerProcessor !== 'undefined' &&
  registerProcessor(WORKLET_PROCESSOR_NAME, AudioEffectsProcessor)
