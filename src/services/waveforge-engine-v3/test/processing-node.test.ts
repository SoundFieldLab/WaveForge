import { describe, expect, it } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import type { HseProcessingNode } from '../src/index'
import { createDefaultParams } from '../src/types'
import type { HseSerializableNodeConfig } from '../src/integration/ProcessingNode'
import { createSerializableProcessingNode, registerProcessingNodeFactory } from '../src/integration/ProcessingNode'

describe('可扩展处理节点接口', () => {
  it('可序列化增益/滤波器节点在脚本与 Worklet 中共享同一描述', () => {
    const node = createSerializableProcessingNode({ id: 'left-only', kind: 'gain', leftGain: 0.5, rightGain: 1 }, 48000)
    const left = new Float32Array([0.4])
    const right = new Float32Array([0.4])
    node.processStereo(left, right)
    expect(left[0]).toBeCloseTo(0.2)
    expect(right[0]).toBeCloseTo(0.4)
    expect(() => createSerializableProcessingNode({ id: 'bad', kind: 'gain', leftGain: Infinity, rightGain: 1 }, 48000)).toThrow()
    const filter = createSerializableProcessingNode({ id: 'filter', kind: 'biquad', type: 'lowpass', frequency: 1000, q: 0.707, gainDb: 0 }, 48000)
    filter.processStereo(new Float32Array([0.5]), new Float32Array([0.5]))
    filter.reset?.()
  })
  it('按注册顺序处理、可替换/停用/注销，并把延迟计入统计', () => {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.eq.enabled = false
    params.limiter.enabled = false
    engine.setParams(params)
    let calls = 0
    let resets = 0
    const node: HseProcessingNode = {
      id: 'test-gain',
      name: '测试增益',
      getLatencySamples: () => 7,
      reset: () => { resets++ },
      processStereo: (left, right) => {
        calls++
        for (let i = 0; i < left.length; i++) { left[i] *= 0.5; right[i] *= 0.5 }
      },
    }
    engine.registerProcessingNode(node)
    const left = new Float32Array(128).fill(0.4)
    const right = new Float32Array(128).fill(-0.2)
    const outL = new Float32Array(128)
    const outR = new Float32Array(128)
    engine.process([left, right], [outL, outR])
    expect(calls).toBe(1)
    expect(outL[0]).toBeCloseTo(0.2, 5)
    expect(outR[0]).toBeCloseTo(-0.1, 5)
    expect(engine.getLatencySamples()).toBe(7)
    expect(engine.getProcessingNodes().map((item) => item.id)).toEqual(['test-gain'])

    node.enabled = false
    engine.process([left, right], [outL, outR])
    expect(calls).toBe(1)
    engine.reset()
    expect(resets).toBe(1)
    expect(engine.unregisterProcessingNode('missing')).toBe(false)
    expect(engine.unregisterProcessingNode('test-gain')).toBe(true)
    expect(engine.getProcessingNodes()).toHaveLength(0)
  })

  it('同 id 注册会替换节点，非法节点被拒绝', () => {
    const engine = new EngineV3(48000)
    const first: HseProcessingNode = { id: 'replace', processStereo: () => undefined }
    const second: HseProcessingNode = { id: 'replace', processStereo: () => undefined }
    engine.registerProcessingNode(first)
    engine.registerProcessingNode(second)
    expect(engine.getProcessingNodes()).toEqual([second])
    expect(() => engine.registerProcessingNode({ id: '', processStereo: () => undefined })).toThrow()
    expect(() => engine.registerProcessingNode({ id: 'bad', processStereo: undefined as never })).toThrow()
  })
})


describe('可序列化 DSP 组合节点', () => {
  it('矩阵、增益、FIR、延迟按声明顺序处理，延迟计入真实引擎统计', () => {
    const config: HseSerializableNodeConfig = { id: 'custom', kind: 'chain', nodes: [
      { id: 'swap', kind: 'matrix', ll: 0, lr: 1, rl: 1, rr: 0 },
      { id: 'gain', kind: 'gain', leftGain: 0.5, rightGain: 0.25 },
      { id: 'fir', kind: 'fir', coefficients: [1, 0.5, -0.25] },
      { id: 'delay', kind: 'delay', samples: 3 },
      { id: 'disabled', kind: 'delay', samples: 99, enabled: false },
    ] }
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.eq.enabled = false
    params.limiter.enabled = false
    engine.setParams(params)
    engine.registerProcessingNode(createSerializableProcessingNode(config, 48000))
    const left = new Float32Array(16), right = new Float32Array(16)
    left[0] = 0.4; right[0] = 0.8
    const outL = new Float32Array(16), outR = new Float32Array(16)
    engine.process([left, right], [outL, outR])
    expect(engine.getLatencySamples()).toBe(3)
    expect(Array.from(outL).slice(0, 7)).toEqual([0, 0, 0, expect.closeTo(0.4), expect.closeTo(0.2), expect.closeTo(-0.1), 0])
    expect(outR[3]).toBeCloseTo(0.1, 6)
    expect(outR[4]).toBeCloseTo(0.05, 6)
    expect(outR[5]).toBeCloseTo(-0.025, 6)
  })

  it('FIR/延迟跨任意块长与整块一致，重置后清除尾音，配置数组被复制', () => {
    const config: HseSerializableNodeConfig = { id: 'stream', kind: 'chain', nodes: [
      { id: 'fir', kind: 'fir', coefficients: [0.5, 0.25, -0.125, 0.1] },
      { id: 'delay', kind: 'delay', samples: 131 },
    ] }
    const whole = createSerializableProcessingNode(config, 48000)
    const split = createSerializableProcessingNode(config, 48000)
    if (config.nodes[0].kind === 'fir') config.nodes[0].coefficients.fill(0)
    const signal = Float64Array.from({ length: 1025 }, (_, i) => 0.3 * Math.sin(i * 0.17))
    const left = signal.slice(), right = Float64Array.from(signal, x => -x)
    whole.processStereo(left, right)
    const splitL = signal.slice(), splitR = Float64Array.from(signal, x => -x)
    let offset = 0
    for (const length of [1, 17, 128, 255, 624]) {
      split.processStereo(splitL.subarray(offset, offset + length), splitR.subarray(offset, offset + length))
      offset += length
    }
    expect(splitL).toEqual(left); expect(splitR).toEqual(right)
    expect(left.some(x => Math.abs(x) > 0.01)).toBe(true)
    split.reset?.()
    const zerosL = new Float32Array(256), zerosR = new Float32Array(256)
    split.processStereo(zerosL, zerosR)
    expect(zerosL.every(x => x === 0) && zerosR.every(x => x === 0)).toBe(true)
  })

  it('波形整形支持干湿、奇对称和有界输出，零延迟直通不丢样本', () => {
    const signal = new Float32Array([-2, -0.5, 0, 0.5, 2])
    const dry = createSerializableProcessingNode({ id: 'dry', kind: 'waveshaper', drive: 3, mix: 0 }, 48000)
    const left = signal.slice(), right = signal.slice()
    dry.processStereo(left, right)
    expect(left).toEqual(signal)
    const wet = createSerializableProcessingNode({ id: 'wet', kind: 'waveshaper', drive: 3, mix: 1 }, 48000)
    wet.processStereo(left, right)
    expect(left[0]).toBeCloseTo(-left[4], 6)
    expect(left[1]).toBeCloseTo(-left[3], 6)
    expect(left[3]).toBeGreaterThan(0.5)
    expect(left.every(x => Number.isFinite(x) && Math.abs(x) < 1.01)).toBe(true)
    const delay = createSerializableProcessingNode({ id: 'zero', kind: 'delay', samples: 0 }, 48000)
    const straight = signal.slice()
    delay.processStereo(straight, straight.slice())
    expect(straight).toEqual(signal)
  })

  it('非法系数、延迟、深度、循环引用及超大组合在注册前被拒绝', () => {
    const invalid: HseSerializableNodeConfig[] = [
      { id: 'fir', kind: 'fir', coefficients: [NaN] },
      { id: 'fir', kind: 'fir', coefficients: [] },
      { id: 'fir', kind: 'fir', coefficients: Array(4097).fill(1) },
      { id: 'delay', kind: 'delay', samples: -1 },
      { id: 'delay', kind: 'delay', samples: 96001 },
      { id: 'matrix', kind: 'matrix', ll: Infinity, lr: 0, rl: 0, rr: 1 },
      { id: 'shape', kind: 'waveshaper', drive: 0, mix: 1 },
      { id: 'shape', kind: 'waveshaper', drive: 1, mix: 2 },
    ]
    for (const config of invalid) expect(() => createSerializableProcessingNode(config, 48000)).toThrow()
    const cycle: HseSerializableNodeConfig = { id: 'cycle', kind: 'chain', nodes: [] }
    cycle.nodes.push(cycle)
    expect(() => createSerializableProcessingNode(cycle, 48000)).toThrow(/capacity/)
    const oversized: HseSerializableNodeConfig = { id: 'large', kind: 'chain', nodes:
      Array.from({ length: 128 }, (_, i) => ({ id: String(i), kind: 'delay', samples: 0 })) }
    expect(() => createSerializableProcessingNode(oversized, 48000)).toThrow(/capacity/)
  })
})


describe('第三方 TS 节点工厂协议', () => {
  it('纯数据参数在工厂边界深拷贝，保留方法绑定与 reset/latency', () => {
    const remove = registerProcessingNodeFactory('test/offset', ({ id, data, sampleRate }) => {
      const config = data as { offsets: number[] }
      return { id, name: 'bound', getLatencySamples() { return this.name === 'bound' ? 3 : 99 },
        processStereo(left, right) {
          for (let i = 0; i < left.length; i++) { left[i] += config.offsets[0]; right[i] += sampleRate / 480000 }
        } }
    })
    try {
      const config: HseSerializableNodeConfig = { id: 'custom', kind: 'custom', type: 'test/offset', data: { offsets: [0.1] } }
      const node = createSerializableProcessingNode(config, 48000)
      ;(config.data as { offsets: number[] }).offsets[0] = 2
      const left = new Float32Array(1), right = new Float32Array(1)
      node.processStereo(left, right)
      expect(left[0]).toBeCloseTo(0.1); expect(right[0]).toBeCloseTo(0.1)
      expect(node.getLatencySamples?.()).toBe(3)
    } finally { remove() }
    expect(() => createSerializableProcessingNode({ id: 'custom', kind: 'custom', type: 'test/offset', data: null }, 48000)).toThrow(/unknown factory/)
  })

  it('未知工厂、非纯数据、错误返回 id 与重复类型被拒绝', () => {
    const remove = registerProcessingNodeFactory('test/data', ({ id }) => ({ id, processStereo: () => {} }))
    try {
      const config = (data: any): HseSerializableNodeConfig => ({ id: 'x', kind: 'custom', type: 'test/data', data })
      expect(() => createSerializableProcessingNode(config({ bad: NaN }), 48000)).toThrow(/plain data/)
      expect(() => createSerializableProcessingNode(config(new Date()), 48000)).toThrow(/plain data/)
      const cycle: any = {}; cycle.self = cycle
      expect(() => createSerializableProcessingNode(config(cycle), 48000)).toThrow(/capacity/)
      expect(() => registerProcessingNodeFactory('test/data', () => ({ id: 'wrong', processStereo: () => {} }))).toThrow(/already registered/)
    } finally { remove() }
    const wrong = registerProcessingNodeFactory('test/wrong', () => ({ id: 'wrong', processStereo: () => {} }))
    try { expect(() => createSerializableProcessingNode({ id: 'x', kind: 'custom', type: 'test/wrong', data: null }, 48000)).toThrow(/different id/) }
    finally { wrong() }
  })
})
