import type { AudioBuffer } from '../dsp/audioBuffer'
import { Biquad } from '../dsp/biquad'
import type { BiquadType } from '../dsp/biquad'

/** Public extension seam for third-party script-side DSP nodes. */
export interface HseProcessingNode {
  /** Stable identifier used when replacing or unregistering a node. */
  readonly id: string
  /** Optional display name for host/UI diagnostics. */
  readonly name?: string
  /** Host may toggle this without removing the node from the chain. */
  enabled?: boolean
  /** Additional latency introduced by this node, in samples. */
  getLatencySamples?: () => number
  /** Reset streaming state at a track or engine boundary. */
  reset?: () => void
  /** In-place stereo processing. Do not allocate or block in this callback. */
  processStereo: (left: AudioBuffer, right: AudioBuffer) => void
}

export function assertProcessingNode(node: HseProcessingNode): void {
  if (!node || typeof node !== 'object' || typeof node.id !== 'string' || node.id.length === 0) {
    throw new Error('processing node requires a non-empty id')
  }
  if (typeof node.processStereo !== 'function') throw new Error(`processing node ${node.id} requires processStereo`)
}

/** 第三方节点只跨线程传输纯数据；DSP 工厂由可信的 TS 模块分别在两个线程注册。 */
export type HseNodeData = null | boolean | number | string | HseNodeData[] | { [key: string]: HseNodeData }
export type HseProcessingNodeFactory = (context: { id: string; data: HseNodeData; sampleRate: number }) => HseProcessingNode

// 分别打包的引擎与扩展模块共用当前 realm 的注册表，避免依赖打包器模块去重。
const FACTORIES = Symbol.for('hse.processing-node.factories.v1')
const scope = globalThis as unknown as { [key: symbol]: Map<string, HseProcessingNodeFactory> | undefined }
const factories = scope[FACTORIES] ?? (scope[FACTORIES] = new Map())

export function registerProcessingNodeFactory(type: string, factory: HseProcessingNodeFactory): () => void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(type) || typeof factory !== 'function') {
    throw new Error('processing node: invalid factory')
  }
  if (factories.has(type) && factories.get(type) !== factory) throw new Error(`processing node: factory already registered: ${type}`)
  factories.set(type, factory)
  return () => { if (factories.get(type) === factory) factories.delete(type) }
}

function copyNodeData(value: HseNodeData, budget = { remaining: 8192 }, depth = 0): HseNodeData {
  if (--budget.remaining < 0 || depth > 12) throw new Error('processing node: data capacity exceeded')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length <= 65536) return value
  if (Array.isArray(value)) {
    if (value.length > budget.remaining) throw new Error('processing node: data capacity exceeded')
    return value.map(item => copyNodeData(item, budget, depth + 1))
  }
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const entries = Object.entries(value)
    if (entries.length > budget.remaining) throw new Error('processing node: data capacity exceeded')
    const result: { [key: string]: HseNodeData } = Object.create(null)
    for (const [key, item] of entries) {
      if (key.length > 128 || key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('processing node: invalid data key')
      result[key] = copyNodeData(item, budget, depth + 1)
    }
    return result
  }
  throw new Error('processing node: expected finite plain data')
}

/** 可跨 postMessage 传递的内建节点描述；回调函数不进入音频线程消息。 */
export type HseSerializableNodeConfig =
  | { id: string; kind: 'custom'; enabled?: boolean; type: string; data: HseNodeData }
  | { id: string; kind: 'gain'; enabled?: boolean; leftGain: number; rightGain: number }
  | { id: string; kind: 'biquad'; enabled?: boolean; type: BiquadType; frequency: number; q: number; gainDb: number }
  | { id: string; kind: 'chain'; enabled?: boolean; nodes: HseSerializableNodeConfig[] }
  | { id: string; kind: 'matrix'; enabled?: boolean; ll: number; lr: number; rl: number; rr: number }
  | { id: string; kind: 'delay'; enabled?: boolean; samples: number }
  | { id: string; kind: 'fir'; enabled?: boolean; coefficients: number[] }
  | { id: string; kind: 'waveshaper'; enabled?: boolean; drive: number; mix: number }

const FILTER_TYPES: readonly BiquadType[] = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'bandpass', 'notch', 'allpass']

export function createSerializableProcessingNode(config: HseSerializableNodeConfig, sampleRate: number): HseProcessingNode {
  return compileNode(config, sampleRate, { remaining: 128 }, 0)
}

function compileNode(config: HseSerializableNodeConfig, sampleRate: number, budget: { remaining: number }, depth: number): HseProcessingNode {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('invalid sample rate')
  if (depth > 8 || --budget.remaining < 0) throw new Error('processing node: graph capacity exceeded')
  if (!config || typeof config.id !== 'string' || !config.id.trim()) throw new Error('processing node requires a non-empty id')
  if (config.kind === 'custom') {
    const factory = factories.get(config.type)
    if (!factory) throw new Error(`processing node: unknown factory: ${config.type}`)
    const node = factory({ id: config.id, data: copyNodeData(config.data), sampleRate })
    assertProcessingNode(node)
    if (node.id !== config.id) throw new Error('processing node: factory returned a different id')
    return { id: config.id, enabled: config.enabled !== false && node.enabled !== false,
      processStereo: node.processStereo.bind(node), reset: node.reset?.bind(node),
      getLatencySamples: node.getLatencySamples?.bind(node),
    }
  }
  if (config.kind === 'chain') {
    if (!Array.isArray(config.nodes) || config.nodes.length > 128) throw new Error('processing node: invalid chain')
    const nodes = config.nodes.map((child) => compileNode(child, sampleRate, budget, depth + 1))
    return { id: config.id, enabled: config.enabled !== false,
      getLatencySamples: () => nodes.reduce((sum, node) => sum + (node.enabled !== false ? node.getLatencySamples?.() ?? 0 : 0), 0),
      reset: () => { for (const node of nodes) node.reset?.() },
      processStereo: (left, right) => { for (const node of nodes) if (node.enabled !== false) node.processStereo(left, right) },
    }
  }
  if (config.kind === 'matrix') {
    const { ll, lr, rl, rr } = config
    if (![ll, lr, rl, rr].every((gain) => Number.isFinite(gain) && Math.abs(gain) <= 4)) throw new Error('processing node: invalid matrix')
    return { id: config.id, enabled: config.enabled !== false, processStereo: (left, right) => {
      for (let i = 0, n = Math.min(left.length, right.length); i < n; i++) {
        const l = left[i], r = right[i]
        left[i] = ll * l + lr * r; right[i] = rl * l + rr * r
      }
    } }
  }
  if (config.kind === 'delay' || config.kind === 'fir') {
    const delay = config.kind === 'delay' ? config.samples : 0
    if (config.kind === 'delay' && (!Number.isInteger(delay) || delay < 0 || delay > sampleRate * 2)) throw new Error('processing node: invalid delay')
    if (config.kind === 'fir' && (!Array.isArray(config.coefficients) || config.coefficients.length < 1
      || config.coefficients.length > 4096 || !config.coefficients.every((v) => Number.isFinite(v) && Math.abs(v) <= 16))) throw new Error('processing node: invalid FIR')
    const coefficients = config.kind === 'fir' ? Float64Array.from(config.coefficients) : null
    const length = coefficients?.length ?? Math.max(1, delay)
    const historyL = new Float64Array(length), historyR = new Float64Array(length)
    let position = 0
    return { id: config.id, enabled: config.enabled !== false,
      getLatencySamples: () => delay,
      reset: () => { historyL.fill(0); historyR.fill(0); position = 0 },
      processStereo: (left, right) => {
        if (!coefficients && delay === 0) return
        for (let i = 0, n = Math.min(left.length, right.length); i < n; i++) {
          const l = left[i], r = right[i]
          if (coefficients) {
            historyL[position] = l; historyR[position] = r
            let sumL = 0, sumR = 0, index = position
            for (let tap = 0; tap < length; tap++) {
              sumL += coefficients[tap] * historyL[index]; sumR += coefficients[tap] * historyR[index]
              if (--index < 0) index = length - 1
            }
            left[i] = sumL; right[i] = sumR
          } else {
            left[i] = historyL[position]; right[i] = historyR[position]
            historyL[position] = l; historyR[position] = r
          }
          if (++position === length) position = 0
        }
      },
    }
  }
  if (config.kind === 'waveshaper') {
    const { drive, mix } = config
    if (!Number.isFinite(drive) || drive < 0.1 || drive > 20 || !Number.isFinite(mix) || mix < 0 || mix > 1) throw new Error('processing node: invalid waveshaper')
    const normalization = Math.tanh(drive)
    return { id: config.id, enabled: config.enabled !== false, processStereo: (left, right) => {
      for (let i = 0, n = Math.min(left.length, right.length); i < n; i++) {
        left[i] += mix * (Math.tanh(drive * left[i]) / normalization - left[i])
        right[i] += mix * (Math.tanh(drive * right[i]) / normalization - right[i])
      }
    } }
  }
  if (config.kind === 'gain') {
    if (!Number.isFinite(config.leftGain) || !Number.isFinite(config.rightGain)
      || config.leftGain < 0 || config.leftGain > 4 || config.rightGain < 0 || config.rightGain > 4) {
      throw new Error('processing node: invalid channel gain')
    }
    const { leftGain, rightGain } = config
    return { id: config.id, enabled: config.enabled !== false, processStereo: (left, right) => {
      const length = Math.min(left.length, right.length)
      for (let i = 0; i < length; i++) { left[i] *= leftGain; right[i] *= rightGain }
    } }
  }
  if (config.kind === 'biquad') {
    if (!FILTER_TYPES.includes(config.type) || !Number.isFinite(config.frequency) || !Number.isFinite(config.q)
      || !Number.isFinite(config.gainDb) || config.frequency <= 0 || config.q <= 0) {
      throw new Error('processing node: invalid biquad parameters')
    }
    const leftFilter = new Biquad(config.type, config.frequency, config.q, config.gainDb, sampleRate)
    const rightFilter = new Biquad(config.type, config.frequency, config.q, config.gainDb, sampleRate)
    return { id: config.id, enabled: config.enabled !== false, reset: () => { leftFilter.reset(); rightFilter.reset() },
      processStereo: (left, right) => {
        const length = Math.min(left.length, right.length)
        for (let i = 0; i < length; i++) { left[i] = leftFilter.process(left[i]); right[i] = rightFilter.process(right[i]) }
      },
    }
  }
  throw new Error('processing node: unsupported kind')
}
