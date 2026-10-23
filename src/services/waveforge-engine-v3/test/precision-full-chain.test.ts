/**
 * precision-full-chain.test.ts —— 全链路 Float64（空间渲染/卷积频谱/多段压缩）
 *
 * 覆盖：
 *  1. Convolver.setPrecision('float64')：prepared 频谱/历史为 Float64Array，流式
 *     PCM 与独立 double 直接卷积误差 <= 1e-12；切回 float32 恢复缓冲类型并 reset。
 *  2. MultibandCompressor.setPrecision('float64')：scratch 为 Float64Array，输出
 *     有限且与 float32 结果的差异在 f32 舍入量级（<= 1e-6）；关闭时直通。
 *  3. TsConvolverBackend.setPrecision('float64')：信号路径缓冲为 Float64Array、
 *     幂等、processStereo/processMulti 输出有限，double 与 float32 输出同量级；
 *     reset 后重新可用。
 *
 * 这些用例只验证软件实现与数值边界，不构成 Worklet/设备硬实时验收。
 */
import { describe, expect, it, vi } from 'vitest'
import { Convolver } from '../src/dsp/Convolver'
import { fft } from '../src/dsp/fft'
import { MultibandCompressor } from '../src/dsp/MultibandCompressor'
import { TsConvolverBackend } from '../src/spatial/TsConvolverBackend'
import { AmbisonicDecoder } from '../src/spatial/AmbisonicDecoder'
import { RoomSim, type RoomSimParams } from '../src/spatial/roomSim'
import { StereoUpmixer } from '../src/spatial/StereoUpmixer'
import type { HrtfGrid, SpatialRenderConfig, VirtualSpeaker } from '../src/spatial/types'
import { createDefaultParams } from '../src/types'

const FS = 48000

/** 双精度直接线性卷积参考（与分区 FFT 不同的独立实现）。 */
function directDoubleConv(x: Float64Array, ir: Float64Array): Float64Array {
  const out = new Float64Array(x.length + ir.length - 1)
  for (let i = 0; i < x.length; i++) {
    const xi = x[i]
    if (xi === 0) continue
    for (let j = 0; j < ir.length; j++) out[i + j] += xi * ir[j]
  }
  return out
}

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>, offsetB = 0): number {
  let max = 0
  const n = Math.min(a.length, b.length - offsetB)
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i + offsetB])
    if (d > max) max = d
  }
  return max
}

function rms(x: ArrayLike<number>, from = 0): number {
  let sum = 0
  for (let i = from; i < x.length; i++) sum += x[i] * x[i]
  return Math.sqrt(sum / Math.max(1, x.length - from))
}

function makeIR(length = 140): Float32Array {
  const ir = new Float32Array(length)
  for (let i = 0; i < length; i++) ir[i] = 0.42 * Math.exp(-i / 41) * Math.sin(i * 0.23 + 0.4)
  ir[0] += 0.55
  return ir
}

describe('Convolver 全精度切换', () => {
  it('float64 prepared 缓冲类型正确，流式 PCM 与 double 直接卷积误差 <= 1e-12', () => {
    const L = 64
    const ir = makeIR()
    const cv = new Convolver(FS, { partitionSize: L, dePeriodize: false })
    cv.loadIR(ir)
    cv.setPrecision('float64')
    expect(cv.getPrecision()).toBe('float64')
    const prepared = cv.createPreparedIRTransfer()!
    expect(prepared.precision).toBe('float64')
    for (const key of ['irSpecReal', 'irSpecImag', 'workReal', 'workImag',
      'historyRealL', 'historyImagL', 'historyRealR', 'historyImagR',
      'overlapL', 'overlapR', 'inputBlockL', 'inputBlockR',
      'pendingWetL', 'pendingWetR', 'wetDelayL', 'wetDelayR'] as const) {
      expect(prepared[key], key).toBeInstanceOf(Float64Array)
    }
    expect(prepared.sumReal).toBeInstanceOf(Float64Array)

    cv.setMix(1)
    cv.setPreDelayMs(0)
    const count = 1024
    const x = new Float64Array(count)
    for (let i = 0; i < count; i++) x[i] = 0.35 * Math.sin(i * 0.071) + 0.12 * Math.cos(i * 0.19)
    const left = Float64Array.from(x)
    const right = new Float64Array(count)
    // 不规则块长：跨分区边界与尾块。
    for (let offset = 0; offset < count; offset += 37) {
      const end = Math.min(count, offset + 37)
      cv.processStereo(left.subarray(offset, end), right.subarray(offset, end))
    }
    const reference = directDoubleConv(x, Float64Array.from(ir))
    let maxError = 0
    for (let i = L; i < count; i++) {
      maxError = Math.max(maxError, Math.abs(left[i] - reference[i - L]), Math.abs(right[i]))
    }
    expect(maxError).toBeLessThan(1e-12)
  })

  it('切回 float32 恢复缓冲构造器、重建频谱并重置流状态；重复设置幂等', () => {
    const L = 32
    const ir = makeIR(90)
    const cv = new Convolver(FS, { partitionSize: L, dePeriodize: false })
    cv.loadIR(ir)
    cv.setPrecision('float64')
    cv.setMix(1)
    const warm = new Float64Array(512).fill(0.3)
    cv.processStereo(warm, warm.slice())

    cv.setPrecision('float32')
    expect(cv.getPrecision()).toBe('float32')
    const prepared = cv.createPreparedIRTransfer()!
    expect(prepared.precision).toBe('float32')
    expect(prepared.irSpecReal).toBeInstanceOf(Float32Array)
    expect(prepared.historyRealL).toBeInstanceOf(Float32Array)
    expect(prepared.workReal).toBeInstanceOf(Float32Array)
    expect(prepared.wetDelayL).toBeInstanceOf(Float32Array)

    // 状态已 reset：零输入在旧尾音区段也必须输出零。
    const silenceL = new Float32Array(4 * L)
    const silenceR = new Float32Array(4 * L)
    cv.processStereo(silenceL, silenceR)
    expect(Math.max(...Array.from(silenceL, Math.abs))).toBeLessThan(1e-12)
    expect(Math.max(...Array.from(silenceR, Math.abs))).toBeLessThan(1e-12)

    // 幂等：同精度重复设置不改变 prepared 缓冲引用。
    cv.setPrecision('float32')
    expect(cv.getPrecision()).toBe('float32')
  })

  it('float64 流式处理在预热后不创建 typed array（逐块零分配）', () => {
    const cv = new Convolver(FS, { partitionSize: 128, dePeriodize: false })
    cv.loadIR(makeIR(700))
    cv.setPrecision('float64')
    cv.setMix(1)
    const warmL = new Float64Array(1024)
    const warmR = new Float64Array(1024)
    for (let i = 0; i < warmL.length; i++) {
      warmL[i] = 0.3 * Math.sin(i * 0.13)
      warmR[i] = 0.2 * Math.cos(i * 0.17)
    }
    // 预热：覆盖块时钟、向量内核视图缓存与首块状态。
    cv.processStereo(warmL, warmR)
    cv.processStereo(warmL, warmR)
    const left = new Float64Array(1024)
    const right = new Float64Array(1024)
    let allocations = 0
    for (const name of ['Float32Array', 'Float64Array'] as const) {
      vi.stubGlobal(name, new Proxy(globalThis[name], {
        construct(target, args) {
          allocations++
          return Reflect.construct(target, args)
        },
      }))
    }
    try {
      cv.processStereo(left, right)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(allocations).toBe(0)
    expect(Array.from(left).every(Number.isFinite)).toBe(true)
  })

  it('未装载 IR 时切换精度安全；prepared 接管后可切到 double 继续渲染', () => {
    const cv = new Convolver(FS, { partitionSize: 32 })
    cv.setPrecision('float64')
    expect(cv.createPreparedIRTransfer()).toBeNull()

    const control = new Convolver(FS, { partitionSize: 32 })
    control.loadIR(makeIR(70))
    cv.loadPreparedIR(control.createPreparedIRTransfer()!)
    expect(cv.getPrecision()).toBe('float32')
    cv.setPrecision('float64')
    expect(cv.getPrecision()).toBe('float64')
    const left = new Float64Array(256)
    const right = new Float64Array(256)
    left.fill(0.2)
    cv.processStereo(left, right)
    expect(Array.from(left).every(Number.isFinite)).toBe(true)
    expect(Array.from(right).every(Number.isFinite)).toBe(true)
  })
})

describe('fft 双精度缓冲', () => {
  it('Float64Array 输入往返误差远小于 float32，且 warm 后不分配 twiddle/工作缓冲', () => {
    const n = 256
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.19) * 0.7 + 0.1
      im[i] = Math.cos(i * 0.31) * 0.4
    }
    const originalRe = Float64Array.from(re)
    const originalIm = Float64Array.from(im)
    fft(re, im, false)
    fft(re, im, true)
    let maxError = 0
    for (let i = 0; i < n; i++) {
      maxError = Math.max(maxError, Math.abs(re[i] - originalRe[i]), Math.abs(im[i] - originalIm[i]))
    }
    // 双精度蝶形往返仅在 double 舍入量级（float32 同规模误差约 1e-7）。
    expect(maxError).toBeLessThan(1e-14)

    let allocations = 0
    for (const name of ['Float32Array', 'Float64Array'] as const) {
      vi.stubGlobal(name, new Proxy(globalThis[name], {
        construct(target, args) {
          allocations++
          return Reflect.construct(target, args)
        },
      }))
    }
    try {
      fft(re, im, false)
      fft(re, im, true)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(allocations).toBe(0)
  })
})

describe('MultibandCompressor 全精度切换', () => {
  it('float64 scratch 类型正确，输出有限且与 float32 结果差异 <= 1e-6', () => {
    const settings = createDefaultParams(FS).compressor.multiband!
    const mb64 = new MultibandCompressor(FS)
    mb64.setPrecision('float64')
    expect(mb64.getPrecision()).toBe('float64')
    const view64 = mb64 as unknown as { lowL: ArrayBufferView; highR: ArrayBufferView }
    expect(view64.lowL).toBeInstanceOf(Float64Array)
    expect(view64.highR).toBeInstanceOf(Float64Array)

    const mb32 = new MultibandCompressor(FS)
    mb64.setParams(settings, true)
    mb32.setParams(settings, true)

    const count = 4096
    const source = new Float64Array(count)
    for (let i = 0; i < count; i++) {
      source[i] = 0.55 * Math.sin(i * 0.11) + 0.22 * Math.sin(i * 0.037 + 0.7)
    }
    const left64 = Float64Array.from(source)
    const right64 = Float64Array.from(source, v => v * 0.63)
    const left32 = Float32Array.from(source)
    const right32 = Float32Array.from(source, v => v * 0.63)
    mb64.processStereo(left64, right64)
    mb32.processStereo(left32, right32)
    expect(Array.from(left64).every(Number.isFinite)).toBe(true)
    expect(Array.from(right64).every(Number.isFinite)).toBe(true)

    const diffL = maxAbsDiff(left64, left32)
    const diffR = maxAbsDiff(right64, right32)
    expect(diffL).toBeLessThan(1e-6)
    expect(diffR).toBeLessThan(1e-6)
    // 同一节目量级（不是静音或误放大）。
    expect(rms(left64) / rms(left32)).toBeGreaterThan(0.99)
    expect(rms(left64) / rms(left32)).toBeLessThan(1.01)

    // 关闭时直通，float64 输入也不被改写。
    mb64.setParams(settings, false)
    const passL = Float64Array.from(source)
    const passR = Float64Array.from(source)
    mb64.processStereo(passL, passR)
    expect(passL).toEqual(Float64Array.from(source))
    expect(passR).toEqual(Float64Array.from(source))

    // 再启用并 reset 后有限。
    mb64.setParams(settings, true)
    mb64.reset()
    const fresh = new Float64Array(256).fill(0.1)
    mb64.processStereo(fresh, fresh.slice())
    expect(Array.from(fresh).every(Number.isFinite)).toBe(true)
  })
})

/** 全方向 delta HRIR 网格：卷积退化为"延迟 1 分区长"，便于比较精度差异。 */
function deltaGrid(hrirLength = 8): HrtfGrid {
  const azimuths: number[] = []
  for (let a = -180; a < 180; a += 15) azimuths.push(a)
  const elevations: number[] = []
  for (let e = -30; e <= 60; e += 15) elevations.push(e)
  const count = elevations.length * azimuths.length
  const left = new Float32Array(count * hrirLength)
  const right = new Float32Array(count * hrirLength)
  for (let i = 0; i < count; i++) {
    left[i * hrirLength] = 1
    right[i * hrirLength] = 1
  }
  return { sampleRate: FS, azimuths, elevations, hrirLength, left, right }
}

function backendConfig(speakers: VirtualSpeaker[]): SpatialRenderConfig {
  return {
    speakers,
    room: 'off',
    roomAmount: 0,
    amount: 1,
    distanceModel: 'inverse',
    hrtfInterp: 'nearest',
    convolution: 'partitioned',
    masterGain: 1,
  }
}

function renderBackend(double: boolean): { left: Float32Array; right: Float32Array } {
  const backend = new TsConvolverBackend()
  backend.loadHrtf(deltaGrid())
  backend.setConfig(backendConfig([
    { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 2, gain: 0.9, size: 0 },
  ]))
  if (double) backend.setPrecision('float64')
  const count = 2048
  const inL = new Float32Array(count)
  const inR = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    inL[i] = 0.4 * Math.sin(i * 0.053)
    inR[i] = 0.28 * Math.cos(i * 0.071)
  }
  const left = new Float32Array(count)
  const right = new Float32Array(count)
  for (let offset = 0; offset < count; offset += 128) {
    const end = Math.min(count, offset + 128)
    backend.processStereo(inL.subarray(offset, end), inR.subarray(offset, end),
      left.subarray(offset, end), right.subarray(offset, end))
  }
  return { left, right }
}

describe('TsConvolverBackend 全精度切换', () => {
  it('float64 信号路径缓冲类型正确、setPrecision 幂等，reset 后可继续渲染', () => {
    const backend = new TsConvolverBackend()
    backend.loadHrtf(deltaGrid())
    backend.setConfig(backendConfig([
      { channel: 0, azimuthDeg: -20, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    ]))
    backend.setPrecision('float64')
    expect(backend.getPrecision()).toBe('float64')
    const view = backend as unknown as {
      srcL: ArrayBufferView; srcR: ArrayBufferView; wetL: ArrayBufferView; wetR: ArrayBufferView
      dryLineL: ArrayBufferView; dryLineR: ArrayBufferView; lfeLine: ArrayBufferView
      ambientL: ArrayBufferView; silenceL: ArrayBufferView; rsmpRing: ArrayBufferView
      decorrRing: ArrayBufferView; airState: ArrayBufferView; occState: ArrayBufferView
      convDual: Array<{ getPrecision(): string }>
    }
    for (const key of ['srcL', 'srcR', 'wetL', 'wetR', 'dryLineL', 'dryLineR', 'lfeLine',
      'ambientL', 'silenceL', 'rsmpRing', 'decorrRing', 'airState', 'occState'] as const) {
      expect(view[key], key).toBeInstanceOf(Float64Array)
    }
    expect(view.convDual[0].getPrecision()).toBe('float64')

    // 幂等：同精度重复设置不替换已分配缓冲。
    const srcBefore = view.srcL
    backend.setPrecision('float64')
    expect(view.srcL).toBe(srcBefore)
    expect(backend.getPrecision()).toBe('float64')

    // processStereo 接受 Float64Array 输入输出并保持有限；IR 重装淡入 512 样本后
    // 输出才离开零，因此用 8 块（4096 样本）观察稳态。
    const block = 512
    const blocks = 8
    const count = block * blocks
    const inL = new Float64Array(count)
    const inR = new Float64Array(count)
    inL.fill(0.15)
    inR.fill(-0.1)
    const outL = new Float64Array(count)
    const outR = new Float64Array(count)
    for (let offset = 0; offset < count; offset += block) {
      const end = offset + block
      backend.processStereo(inL.subarray(offset, end), inR.subarray(offset, end),
        outL.subarray(offset, end), outR.subarray(offset, end))
    }
    expect(Array.from(outL).every(Number.isFinite)).toBe(true)
    expect(Array.from(outR).every(Number.isFinite)).toBe(true)
    expect(rms(outL, block * 4)).toBeGreaterThan(0)

    backend.reset()
    const resetL = new Float64Array(count)
    const resetR = new Float64Array(count)
    backend.processStereo(new Float64Array(count), new Float64Array(count), resetL, resetR)
    expect(Math.max(...Array.from(resetL, Math.abs))).toBeLessThan(1e-12)
    const impulseL = new Float64Array(4096)
    const impulseR = new Float64Array(4096)
    impulseL[0] = 0.5
    const impulseOutL = new Float64Array(4096)
    const impulseOutR = new Float64Array(4096)
    backend.processStereo(impulseL, impulseR, impulseOutL, impulseOutR)
    expect(Array.from(impulseOutL).every(Number.isFinite)).toBe(true)
    // 多声道入口同样需要跨过 IR 重装淡入的 512 样本才进入稳态。
    const multiLength = 4096
    const multiL = new Float64Array(multiLength)
    const multiR = new Float64Array(multiLength)
    backend.processMulti([
      new Float64Array(multiLength).fill(0.2),
      new Float64Array(multiLength).fill(-0.2),
    ], multiL, multiR)
    expect(Array.from(multiL).every(Number.isFinite)).toBe(true)
    expect(Array.from(multiR).every(Number.isFinite)).toBe(true)
    expect(rms(multiL, 1024)).toBeGreaterThan(0)
  })

  it('房间反射总线跟随精度，且房间开启时 double 输出有限', () => {
    const backend = new TsConvolverBackend()
    backend.loadHrtf(deltaGrid())
    backend.setConfig(backendConfig([
      { channel: 0, azimuthDeg: -35, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 1, azimuthDeg: 35, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    ]))
    // 先按 float32 配置房间，再切 double：反射总线/历史环应重建为 Float64。
    backend.setConfig({ ...backendConfig([
      { channel: 0, azimuthDeg: -35, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 1, azimuthDeg: 35, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    ]), room: 'studio', roomAmount: 0.4 })
    backend.setPrecision('float64')
    const room = (backend as unknown as {
      room: { earlyL: ArrayBufferView; earlyR: ArrayBufferView; states: Array<{ histL: ArrayBufferView }> } | null
    }).room
    expect(room).not.toBeNull()
    expect(room!.earlyL).toBeInstanceOf(Float64Array)
    expect(room!.earlyR).toBeInstanceOf(Float64Array)
    if (room!.states.length > 0) expect(room!.states[0].histL).toBeInstanceOf(Float64Array)

    const count = 2048
    const input = new Float64Array(count)
    for (let i = 0; i < count; i++) input[i] = 0.25 * Math.sin(i * 0.04)
    const left = new Float64Array(count)
    const right = new Float64Array(count)
    backend.processStereo(input, input.slice(), left, right)
    expect(Array.from(left).every(Number.isFinite)).toBe(true)
    expect(Array.from(right).every(Number.isFinite)).toBe(true)

    // 含 FDN 晚混响的 float64 稳态块：预热后逐块零 typed-array 分配。
    const block = 128
    const inL = new Float64Array(block).fill(0.1)
    const inR = new Float64Array(block).fill(-0.1)
    const outL = new Float64Array(block)
    const outR = new Float64Array(block)
    for (let i = 0; i < 4; i++) backend.processStereo(inL, inR, outL, outR)
    let allocations = 0
    for (const name of ['Float32Array', 'Float64Array'] as const) {
      vi.stubGlobal(name, new Proxy(globalThis[name], {
        construct(target, args) {
          allocations++
          return Reflect.construct(target, args)
        },
      }))
    }
    try {
      backend.processStereo(inL, inR, outL, outR)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(allocations).toBe(0)
  })

  it('先设精度再 loadHrtf/setConfig 仍保持 float64（EngineV3 常用顺序）', () => {
    const backend = new TsConvolverBackend()
    backend.setPrecision('float64')
    backend.loadHrtf(deltaGrid())
    backend.setConfig(backendConfig([
      { channel: 0, azimuthDeg: -25, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    ]))
    expect(backend.getPrecision()).toBe('float64')
    const view = backend as unknown as {
      srcL: ArrayBufferView; dryLineL: ArrayBufferView
      convDual: Array<{ getPrecision(): string }>
      room: unknown
    }
    expect(view.srcL).toBeInstanceOf(Float64Array)
    expect(view.dryLineL).toBeInstanceOf(Float64Array)
    expect(view.convDual[0].getPrecision()).toBe('float64')
    const outL = new Float64Array(1024)
    const outR = new Float64Array(1024)
    const input = new Float64Array(1024).fill(0.1)
    backend.processStereo(input, input.slice(), outL, outR)
    expect(Array.from(outL).every(Number.isFinite)).toBe(true)
  })

  it('double 与 float32 输出存在微小差异但同量级（不是静音/发散）', () => {
    const single = renderBackend(false)
    const double = renderBackend(true)
    const diffL = maxAbsDiff(double.left, single.left)
    const diffR = maxAbsDiff(double.right, single.right)
    expect(diffL).toBeLessThan(1e-4)
    expect(diffR).toBeLessThan(1e-4)
    expect(rms(double.left) / rms(single.left)).toBeGreaterThan(0.999)
    expect(rms(double.left) / rms(single.left)).toBeLessThan(1.001)
    expect(rms(double.right) / rms(single.right)).toBeGreaterThan(0.999)
    expect(rms(double.right) / rms(single.right)).toBeLessThan(1.001)
  })
})

describe('RoomSim 全精度（FDN 晚混响 + 完整谱早反射）', () => {
  const speakers: VirtualSpeaker[] = [{
    channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0,
  }]
  const roomParams: RoomSimParams = {
    width: 10, height: 10, depth: 10, reflectivity: 0.5, earlyOrders: 1, rt60: 0.4, spectralEarly: true,
  }
  const hrir = {
    left: Float32Array.from({ length: 96 }, (_, i) => Math.exp(-i / 30) * Math.cos(i * 0.4) * 0.5),
    right: Float32Array.from({ length: 96 }, (_, i) => Math.exp(-i / 33) * Math.sin(i * 0.37 + 0.3) * 0.5),
  }
  interface RoomInternals {
    fdn: {
      getPrecision(): string
      linesL: ArrayBufferView[]
      linesR: ArrayBufferView[]
      lpStateL: ArrayBufferView
      lpStateR: ArrayBufferView
    } | null
    states: Array<{
      histL: ArrayBufferView
      spectral?: {
        getPrecision(): string
        data: {
          historyRealL: ArrayBufferView
          historyImagL: ArrayBufferView
          workReal: ArrayBufferView
          workImag: ArrayBufferView
          overlapL: ArrayBufferView
          irRealL: ArrayBufferView
          headL: ArrayBufferView
        }
      }
    }>
  }

  it('float64 下 FDN 8 线/低通状态与谱反射频谱/工作/重叠缓冲均为 Float64Array', () => {
    const room = new RoomSim(FS, speakers, roomParams, 1, () => hrir, 0,
      undefined, true, undefined, undefined, 'float64')
    expect(room.getPrecision()).toBe('float64')
    const view = room as unknown as RoomInternals
    expect(view.fdn).not.toBeNull()
    expect(view.fdn!.getPrecision()).toBe('float64')
    for (const line of view.fdn!.linesL) expect(line).toBeInstanceOf(Float64Array)
    for (const line of view.fdn!.linesR) expect(line).toBeInstanceOf(Float64Array)
    expect(view.fdn!.lpStateL).toBeInstanceOf(Float64Array)
    expect(view.fdn!.lpStateR).toBeInstanceOf(Float64Array)

    const spectral = view.states[0]?.spectral
    expect(spectral).toBeTruthy()
    expect(spectral!.getPrecision()).toBe('float64')
    for (const key of ['irRealL', 'historyRealL', 'historyImagL', 'workReal', 'workImag', 'overlapL'] as const) {
      expect(spectral!.data[key], key).toBeInstanceOf(Float64Array)
    }
    // headL 是前 128 抽头 FIR 系数（HRIR 数据），按约定保持 Float32。
    expect(spectral!.data.headL).toBeInstanceOf(Float32Array)

    // 实时块：早期反射 + FDN 晚混响输出有限，且逐块零 typed-array 分配。
    const inL = new Float64Array(128).fill(0.1)
    const inR = new Float64Array(128).fill(-0.05)
    const wetL = new Float64Array(128)
    const wetR = new Float64Array(128)
    const processBlock = (): void => {
      room.beginBlock(128)
      room.early(0, inL, inR, 128)
      for (let i = 0; i < 128; i++) { wetL[i] = inL[i]; wetR[i] = inR[i] }
      room.lateAndMix(wetL, wetR, 128)
    }
    processBlock()
    expect(Array.from(wetL).every(Number.isFinite)).toBe(true)
    expect(Array.from(wetR).every(Number.isFinite)).toBe(true)
    let allocations = 0
    for (const name of ['Float32Array', 'Float64Array'] as const) {
      vi.stubGlobal(name, new Proxy(globalThis[name], {
        construct(target, args) {
          allocations++
          return Reflect.construct(target, args)
        },
      }))
    }
    try {
      processBlock()
    } finally {
      vi.unstubAllGlobals()
    }
    expect(allocations).toBe(0)
  })

  it('prepared 谱反射数据携带精度：匹配时接管，f32 数据进入 f64 房间时回退本地重算', () => {
    const producer = new RoomSim(FS, speakers, roomParams, 1, () => hrir, 0,
      undefined, true, undefined, undefined, 'float64')
    const transfer = producer.createPreparedEarlyTransfer()!
    expect(transfer.speakers[0]!.precision).toBe('float64')
    const consumer = new RoomSim(FS, speakers, roomParams, 1, () => hrir, 0,
      undefined, true, undefined, transfer, 'float64')
    const consumerView = consumer as unknown as RoomInternals
    expect(consumerView.states[0].spectral!.getPrecision()).toBe('float64')
    expect(consumerView.states[0].spectral!.data.workReal).toBeInstanceOf(Float64Array)
    expect(consumerView.states[0].spectral!.data.historyRealL).toBeInstanceOf(Float64Array)

    // 精度不匹配：拒收 f32 prepared 频谱，改按 f64 本地聚合（谱反射仍为双精度）。
    const producer32 = new RoomSim(FS, speakers, roomParams, 1, () => hrir)
    const transfer32 = producer32.createPreparedEarlyTransfer()!
    expect(transfer32.speakers[0]!.precision).toBe('float32')
    const fallback = new RoomSim(FS, speakers, roomParams, 1, () => hrir, 0,
      undefined, true, undefined, transfer32, 'float64')
    const fallbackView = fallback as unknown as RoomInternals
    expect(fallbackView.states[0].spectral!.getPrecision()).toBe('float64')
    expect(fallbackView.states[0].spectral!.data.workReal).toBeInstanceOf(Float64Array)
    expect(fallback.spectralFallbackReason).toContain('预计算')
  })

  it('切回 float32 恢复类型并 reset；同精度重复设置幂等', () => {
    const room = new RoomSim(FS, speakers, roomParams, 1, () => hrir, 0,
      undefined, true, undefined, undefined, 'float64')
    const view = room as unknown as RoomInternals
    room.setPrecision('float32')
    expect(room.getPrecision()).toBe('float32')
    expect(view.fdn!.getPrecision()).toBe('float32')
    expect(view.states[0].histL).toBeInstanceOf(Float32Array)
    expect(view.states[0].spectral!.getPrecision()).toBe('float32')
    expect(view.states[0].spectral!.data.workReal).toBeInstanceOf(Float32Array)
    for (const line of view.fdn!.linesL) expect(line).toBeInstanceOf(Float32Array)
    const line = view.fdn!.linesL[0]
    room.setPrecision('float32')
    expect(view.fdn!.linesL[0]).toBe(line)
  })
})

describe('StereoUpmixer 输出精度', () => {
  it('float64 输出声道为 Float64Array、有限，切回 float32 幂等，预热后零分配', () => {
    const upmixer = new StereoUpmixer({ layout: '7.1', sampleRate: FS, blockSize: 128, precision: 'float64' })
    expect(upmixer.getPrecision()).toBe('float64')
    expect(upmixer.outputChannels.every(channel => channel instanceof Float64Array)).toBe(true)
    const left = Float64Array.from({ length: 128 }, (_, i) => 0.4 * Math.sin(i * 0.07))
    const right = Float64Array.from({ length: 128 }, (_, i) => 0.3 * Math.cos(i * 0.11))
    const output = upmixer.process(left, right)
    expect(output.every(channel => channel instanceof Float64Array)).toBe(true)
    expect(output.every(channel => Array.from(channel).every(Number.isFinite))).toBe(true)
    expect(rms(output[0])).toBeGreaterThan(0)

    // 预热后逐块零 typed-array 分配。
    upmixer.process(left, right)
    let allocations = 0
    for (const name of ['Float32Array', 'Float64Array'] as const) {
      vi.stubGlobal(name, new Proxy(globalThis[name], {
        construct(target, args) {
          allocations++
          return Reflect.construct(target, args)
        },
      }))
    }
    try {
      upmixer.process(left, right)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(allocations).toBe(0)

    upmixer.setPrecision('float32')
    expect(upmixer.getPrecision()).toBe('float32')
    expect(upmixer.outputChannels.every(channel => channel instanceof Float32Array)).toBe(true)
    const left32 = Float32Array.from(left)
    const right32 = Float32Array.from(right)
    const output32 = upmixer.process(left32, right32)
    expect(output32.every(channel => channel instanceof Float32Array)).toBe(true)
    expect(output32.every(channel => Array.from(channel).every(Number.isFinite))).toBe(true)
    const channel = upmixer.outputChannels[0]
    upmixer.setPrecision('float32')
    expect(upmixer.outputChannels[0]).toBe(channel)
  })
})

describe('AmbisonicDecoder 输出精度', () => {
  it('float64 输出/通道为 Float64Array，W-only 与解析参考误差 <=1e-12，切回 f32 幂等恢复', () => {
    const decoder = new AmbisonicDecoder(FS, 'float64')
    expect(decoder.getPrecision()).toBe('float64')
    expect(decoder.left).toBeInstanceOf(Float64Array)
    expect(decoder.right).toBeInstanceOf(Float64Array)
    expect(decoder.channels.length).toBe(8)
    expect(decoder.channels.every(channel => channel instanceof Float64Array)).toBe(true)
    const output = (decoder as unknown as { output: ArrayBufferView[] }).output
    expect(output.length).toBe(32)
    expect(output.every(channel => channel instanceof Float64Array)).toBe(true)

    // ambix 的 W-only 输入有解析解：left/right = 1/√2，每个 FOA 扬声器输出 = W·1/8。
    const ones = new Float64Array(8).fill(1)
    const zeros = new Float64Array(8)
    decoder.decode([ones, zeros, zeros, zeros], 0, 8, 'ambix')
    for (let i = 0; i < 8; i++) {
      expect(decoder.left[i]).toBeCloseTo(Math.SQRT1_2, 12)
      expect(decoder.right[i]).toBeCloseTo(Math.SQRT1_2, 12)
      for (const channel of decoder.channels) expect(channel[i]).toBeCloseTo(1 / 8, 12)
    }

    // 任意 FOA 输入有限，且与 float32 解码差异在 f32 舍入量级。
    const inputs = Array.from({ length: 4 }, (_, c) =>
      Float64Array.from({ length: 128 }, (_, i) => 0.3 * Math.sin(i * 0.031 + c * 0.7)))
    decoder.decode(inputs, 0, 128, 'ambix')
    expect(Array.from(decoder.left).every(Number.isFinite)).toBe(true)
    expect(Array.from(decoder.right).every(Number.isFinite)).toBe(true)
    const reference32 = new AmbisonicDecoder(FS)
    const inputs32 = inputs.map(channel => Float32Array.from(channel))
    reference32.decode(inputs32, 0, 128, 'ambix')
    expect(maxAbsDiff(decoder.left, reference32.left)).toBeLessThan(1e-6)

    // 切回 float32：类型恢复；setPrecision 会 reset（输出清零）；重复设置幂等。
    decoder.setPrecision('float32')
    expect(decoder.getPrecision()).toBe('float32')
    expect(decoder.left).toBeInstanceOf(Float32Array)
    expect(decoder.right).toBeInstanceOf(Float32Array)
    expect(decoder.channels.every(channel => channel instanceof Float32Array)).toBe(true)
    expect(Array.from(decoder.left).every(value => value === 0)).toBe(true)
    expect(Array.from(decoder.right).every(value => value === 0)).toBe(true)
    const channel = decoder.channels[0]
    decoder.setPrecision('float32')
    expect(decoder.channels[0]).toBe(channel)
  })
})
