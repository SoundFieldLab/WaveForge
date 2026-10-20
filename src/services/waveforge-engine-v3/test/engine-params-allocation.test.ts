/**
 * EngineV3.setParams 结构化同步回归：
 *  - 连续相同快照不新建对象/数组（快照引用与所有子对象/数组保持同一引用）；
 *  - 调用方后续修改参数对象不影响引擎快照；
 *  - 只改一个模块字段时，其它模块的配置 setter 不被调用，且改动真实进入 PCM。
 */
import { describe, expect, it, vi } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams } from '../src/types'
import type { V3EngineParams } from '../src/types'

interface AllocationProbe {
  result: void
  f32: number
  f64: number
  array: number
}

/** 在同步区间内统计 typed array / Array 构造次数（Proxy 保留原生原型与 instanceof 语义）。 */
function measureAllocations(run: () => void): AllocationProbe {
  const nativeF32 = globalThis.Float32Array
  const nativeF64 = globalThis.Float64Array
  const nativeArray = globalThis.Array
  let f32 = 0
  let f64 = 0
  let array = 0
  const CountingF32 = new Proxy(nativeF32, {
    construct(target, args) {
      f32++
      return Reflect.construct(target, args)
    },
  })
  const CountingF64 = new Proxy(nativeF64, {
    construct(target, args) {
      f64++
      return Reflect.construct(target, args)
    },
  })
  const CountingArray = new Proxy(nativeArray, {
    construct(target, args) {
      array++
      return Reflect.construct(target, args)
    },
    apply(target, thisArg, args) {
      array++
      return Reflect.apply(target, thisArg, args)
    },
  })
  globalThis.Float32Array = CountingF32
  globalThis.Float64Array = CountingF64
  globalThis.Array = CountingArray
  try {
    run()
    return { result: undefined, f32, f64, array }
  } finally {
    globalThis.Float32Array = nativeF32
    globalThis.Float64Array = nativeF64
    globalThis.Array = nativeArray
  }
}

function lcg(seed: number, n: number): Float32Array {
  const out = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = (s / 0xffffffff) * 2 - 1
  }
  return out
}

function baseParams(fs = 48000): ReturnType<typeof createDefaultParams> {
  const params = createDefaultParams(fs)
  params.limiter.enabled = false
  // 启用可被观察的模块，验证“只改 EQ”不会触发其它模块重配。
  params.dynamicEq = { enabled: true, frequency: 1000, q: 1, thresholdDb: -30, ratio: 4,
    maxReductionDb: 12, attackMs: 10, releaseMs: 150 }
  params.crossfeed = { enabled: true, amount: 0.3, cutoffHz: 700, delayMs: 0.2 }
  params.deesser.enabled = true
  params.bassEnhancer.enabled = true
  params.loudnessCompensation.enabled = true
  params.subsonicEnabled = true
  params.spatial!.mode = 'instant'
  params.spatial!.instant.amount = 0.6
  return params
}

describe('EngineV3.setParams 零分配结构化同步', () => {
  it('连续 100 次相同 setParams 不新建 typed array / 数组，快照引用保持不变', () => {
    const engine = new EngineV3(48000)
    const params = baseParams()
    engine.setParams(params)
    const inner = engine as unknown as {
      _params: V3EngineParams
      _processingOrder: readonly string[]
      _spatialViews: readonly (readonly unknown[])[]
      _spatialOutL: unknown
      _spatialMultiViews: readonly (readonly unknown[])[]
    }
    const paramsRef = inner._params
    const eqRef = paramsRef.eq
    const proBandsRef = paramsRef.eq.proBands
    const simpleBandsRef = paramsRef.eq.simpleBands
    const dynamicEqRef = paramsRef.dynamicEq
    const compressorRef = paramsRef.compressor
    const multibandRef = paramsRef.compressor.multiband
    const reverbRef = paramsRef.reverb
    const spatialRef = paramsRef.spatial
    const spatialSpeakersRef = paramsRef.spatial!.headLocked.speakers
    const spatialSourcesRef = paramsRef.spatial!.world.sources
    const spatialRatiosRef = paramsRef.spatial!.ambisonicTransform!.orderGains
    const orderRef = inner._processingOrder
    const viewsRef = inner._spatialViews
    const outLRef = inner._spatialOutL
    const multiViewsRef = inner._spatialMultiViews

    const probe = measureAllocations(() => {
      for (let i = 0; i < 100; i++) engine.setParams(params)
    })

    expect(probe.f32).toBe(0)
    expect(probe.f64).toBe(0)
    expect(probe.array).toBe(0)
    expect(inner._params).toBe(paramsRef)
    expect(paramsRef.eq).toBe(eqRef)
    expect(paramsRef.eq.proBands).toBe(proBandsRef)
    expect(paramsRef.eq.simpleBands).toBe(simpleBandsRef)
    expect(paramsRef.dynamicEq).toBe(dynamicEqRef)
    expect(paramsRef.compressor).toBe(compressorRef)
    expect(paramsRef.compressor.multiband).toBe(multibandRef)
    expect(paramsRef.reverb).toBe(reverbRef)
    expect(paramsRef.spatial).toBe(spatialRef)
    expect(paramsRef.spatial!.headLocked.speakers).toBe(spatialSpeakersRef)
    expect(paramsRef.spatial!.world.sources).toBe(spatialSourcesRef)
    expect(paramsRef.spatial!.ambisonicTransform!.orderGains).toBe(spatialRatiosRef)
    expect(inner._processingOrder).toBe(orderRef)
    expect(inner._spatialViews).toBe(viewsRef)
    expect(inner._spatialOutL).toBe(outLRef)
    expect(inner._spatialMultiViews).toBe(multiViewsRef)
  })

  it('调用方在 setParams 之后修改参数对象不影响引擎快照', () => {
    const engine = new EngineV3(48000)
    const params = baseParams()
    engine.setParams(params)
    const snapshot = engine as unknown as { _params: V3EngineParams }

    params.eq.proBands[3] = { frequency: 9000, gain: 12, q: 3 }
    params.deesser.enabled = false
    params.spatial!.headLocked.speakers.push({ azimuthDeg: 40, elevationDeg: 0, distance: 1, gain: 1, size: 0 })

    expect(snapshot._params.eq.proBands[3].frequency).toBe(250)
    expect(snapshot._params.deesser.enabled).toBe(true)
    const speakers = snapshot._params.spatial!.headLocked.speakers
    expect(speakers.length).toBe(params.spatial!.headLocked.speakers.length - 1)
    // 同时保证原始参数对象没有被引擎改写。
    expect(params.eq.proBands[3]).toEqual({ frequency: 9000, gain: 12, q: 3 })
  })

  it('只改 EQ 一个频段增益时，其它模块 setter 不被重复调用且 PCM 正确更新', () => {
    const fs = 48000
    const engine = new EngineV3(fs)
    const params = baseParams(fs)
    engine.setParams(params)

    const inner = engine as unknown as {
      _eqChain: { setBands: (bands: unknown) => void }
      _dynamicEq: { setParams: (value: unknown) => void }
      _crossfeed: { setParams: (value: unknown) => void }
      _deesser: { setParams: (value: unknown) => void }
      _compressor: { setParams: (value: unknown) => void }
      _multibandCompressor: { setParams: (...args: unknown[]) => void }
      _limiter: { setParams: (value: unknown) => void }
      _bass: { setParams: (value: unknown) => void }
      _subsonic: { setParams: (value: unknown) => void }
      _loudnessComp: { setParams: (value: unknown) => void }
      _midSide: { setParams: (...args: unknown[]) => void }
      _reverbSimple: { setParams: (value: unknown) => void }
      _ieqChain: { setBands: (value: unknown) => void }
      _speakerCancellation: { setParams: (value: unknown) => void }
    }
    const eqSetBands = vi.spyOn(inner._eqChain, 'setBands')
    const other = {
      dynamicEq: vi.spyOn(inner._dynamicEq, 'setParams'),
      crossfeed: vi.spyOn(inner._crossfeed, 'setParams'),
      deesser: vi.spyOn(inner._deesser, 'setParams'),
      compressor: vi.spyOn(inner._compressor, 'setParams'),
      multiband: vi.spyOn(inner._multibandCompressor, 'setParams'),
      limiter: vi.spyOn(inner._limiter, 'setParams'),
      bass: vi.spyOn(inner._bass, 'setParams'),
      subsonic: vi.spyOn(inner._subsonic, 'setParams'),
      loudnessComp: vi.spyOn(inner._loudnessComp, 'setParams'),
      midSide: vi.spyOn(inner._midSide, 'setParams'),
      reverb: vi.spyOn(inner._reverbSimple, 'setParams'),
      ieq: vi.spyOn(inner._ieqChain, 'setBands'),
      cancellation: vi.spyOn(inner._speakerCancellation, 'setParams'),
    }

    const changed: V3EngineParams = structuredClone(params)
    changed.eq.proBands[3] = { ...changed.eq.proBands[3], gain: 9 }
    engine.setParams(changed)

    expect(eqSetBands).toHaveBeenCalledTimes(1)
    for (const [name, spy] of Object.entries(other)) expect(spy, name).not.toHaveBeenCalled()

    // PCM 正确性：reset 提交最新配置后与“从启动就只有新参数”的引擎逐样本一致。
    engine.reset()
    const reference = new EngineV3(fs)
    reference.setParams(changed)
    reference.reset()
    const inputL = lcg(1234, 2048)
    const inputR = Float32Array.from(inputL, (value, index) => Math.cos(index * 0.05) * 0.3 + value * 0.2)
    const outA = new Float32Array(2048)
    const outB = new Float32Array(2048)
    const refA = new Float32Array(2048)
    const refB = new Float32Array(2048)
    engine.process([inputL, inputR], [outA, outB])
    reference.process([inputL, inputR], [refA, refB])
    expect(outA.every(Number.isFinite)).toBe(true)
    expect(Array.from(outA)).toEqual(Array.from(refA))
    expect(Array.from(outB)).toEqual(Array.from(refB))
    // 与未修改的原始参数相比，EQ 增益确实进入 PCM。
    const untouched = new EngineV3(fs)
    untouched.setParams(params)
    untouched.reset()
    const baseA = new Float32Array(2048)
    const baseB = new Float32Array(2048)
    untouched.process([inputL, inputR], [baseA, baseB])
    let diff = 0
    for (let i = 0; i < 2048; i++) diff += Math.abs(outA[i] - baseA[i])
    expect(diff).toBeGreaterThan(1)
  })
})
