import { afterEach, describe, expect, it, vi } from 'vitest'
import { BinauralConvolver, type PreparedBinauralIR } from '../BinauralConvolver'
import { fft } from '../../dsp/fft'

vi.mock('../../dsp/fft', async importOriginal => {
  const actual = await importOriginal<typeof import('../../dsp/fft')>()
  return { ...actual, fft: vi.fn(actual.fft) }
})

const ir = (length = 350, phase = 0): [Float32Array, Float32Array] => [
  Float32Array.from({ length }, (_, i) => Math.exp(-i / 55) * Math.cos(i * 0.21 + phase) * 0.2),
  Float32Array.from({ length }, (_, i) => Math.exp(-i / 63) * Math.sin(i * 0.27 + phase + 0.1) * 0.18),
]
const input = (length = 2200, separate = false): [Float32Array, Float32Array] => {
  const left = Float32Array.from({ length }, (_, i) => Math.sin(i * 0.073) * 0.1)
  return [left, separate ? Float32Array.from({ length }, (_, i) => Math.cos(i * 0.087) * 0.09) : left.slice()]
}
const transfers = (prepared: PreparedBinauralIR): ArrayBuffer[] =>
  Object.values(prepared).filter(ArrayBuffer.isView).map(view => view.buffer as ArrayBuffer)

afterEach(() => { vi.unstubAllGlobals() })

describe('BinauralConvolver control-thread preparation', () => {
  it.each([false, true])('prepared 初装与普通装载 PCM 逐位相同，separate=%s', separate => {
    const ordinary = new BinauralConvolver(128, 512), prepared = new BinauralConvolver(128, 512)
    const [left, right] = ir()
    ordinary.loadIR(left, right, separate)
    expect(prepared.loadPreparedIR(BinauralConvolver.prepareIR(left, right, 128, 512))).toBe(true)
    const a = input(2200, separate), b = a.map(channel => channel.slice()) as [Float32Array, Float32Array]
    ordinary.processStereo(...a)
    for (let at = 0; at < b[0].length; at += 73) prepared.processStereo(b[0].subarray(at, at + 73), b[1].subarray(at, at + 73))
    expect(b).toEqual(a)
  })

  it('普通公共输入在 prepared 更新后切为分离输入，保留完整既有历史', () => {
    const ordinary = new BinauralConvolver(128, 512), prepared = new BinauralConvolver(128, 512)
    const initial = ir(), target = ir(350, 1)
    ordinary.loadIR(...initial); prepared.loadIR(...initial)
    const a = input(703), b = a.map(channel => channel.slice()) as [Float32Array, Float32Array]
    ordinary.processStereo(...a); prepared.processStereo(...b)
    ordinary.updateIR(...target, true, 960)
    expect(prepared.updatePreparedIR(BinauralConvolver.prepareIR(...target, 128, 512), 960)).toBe(true)
    const nextA = input(2500, true), nextB = nextA.map(channel => channel.slice()) as [Float32Array, Float32Array]
    ordinary.processStereo(...nextA)
    for (let at = 0; at < nextB[0].length; at += 83) prepared.processStereo(nextB[0].subarray(at, at + 83), nextB[1].subarray(at, at + 83))
    expect(nextB).toEqual(nextA)
  })

  it('连续 prepared 移动更新与普通 updateIR 结果逐位相同', () => {
    const ordinary = new BinauralConvolver(128, 512), prepared = new BinauralConvolver(128, 512)
    const initial = ir()
    ordinary.loadIR(...initial, true)
    prepared.loadPreparedIR(BinauralConvolver.prepareIR(...initial, 128, 512))
    for (const [length, phase] of [[137, 0.3], [211, -0.8], [1700, 1.2]]) {
      const next = ir(350, phase)
      ordinary.updateIR(...next, true, 960)
      expect(prepared.updatePreparedIR(BinauralConvolver.prepareIR(...next, 128, 512))).toBe(true)
      const a = input(length, true), b = a.map(channel => channel.slice()) as [Float32Array, Float32Array]
      ordinary.processStereo(...a); prepared.processStereo(...b)
      expect(b).toEqual(a)
    }
  })

  it('导出形变目标而不是当前混合频谱，历史和延迟输出全为零', () => {
    const source = new BinauralConvolver(128, 512), targetReference = new BinauralConvolver(128, 512)
    source.loadIR(...ir(), true)
    source.processStereo(...input(513, true))
    const target = ir(350, 1.1)
    source.updateIR(...target, true, 960)
    source.processStereo(...input(128, true))
    const exported = source.createPreparedIRTransfer()
    const received = new BinauralConvolver(128, 512)
    expect(received.loadPreparedIR(exported)).toBe(true)
    targetReference.loadIR(...target, true)
    const a = input(2300, true), b = a.map(channel => channel.slice()) as [Float32Array, Float32Array]
    received.processStereo(...a); targetReference.processStereo(...b)
    expect(a).toEqual(b)
  })

  it('导出缓冲全独占，可转移而不 detach 准备端仍在使用的频谱与历史', () => {
    const source = new BinauralConvolver(128, 512), reference = new BinauralConvolver(128, 512)
    const initial = ir()
    source.loadIR(...initial, true); reference.loadIR(...initial, true)
    const payload = source.createPreparedIRTransfer(), buffers = transfers(payload)
    expect(new Set(buffers).size).toBe(buffers.length)
    const received = structuredClone(payload, { transfer: buffers })
    expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true)
    expect(received.irRealL.byteLength).toBeGreaterThan(0)
    const a = input(), b = a.map(channel => channel.slice()) as [Float32Array, Float32Array]
    source.processStereo(...a); reference.processStereo(...b)
    expect(a).toEqual(b)
    const receiver = new BinauralConvolver(128, 512)
    expect(receiver.loadPreparedIR(received)).toBe(true)
  })

  it('接管与同容量 prepared 更新不创建 typed arrays 或执行 IR FFT', () => {
    const initial = BinauralConvolver.prepareIR(...ir(), 128, 512)
    const next = BinauralConvolver.prepareIR(...ir(350, 0.9), 128, 512)
    const convolver = new BinauralConvolver(128, 512)
    let allocations = 0
    for (const name of ['Float32Array', 'Float64Array'] as const) {
      const original = globalThis[name]
      vi.stubGlobal(name, new Proxy(original, { construct(target, args) {
        allocations++
        return Reflect.construct(target, args)
      } }))
    }
    vi.mocked(fft).mockClear()
    expect(convolver.loadPreparedIR(initial)).toBe(true)
    expect(convolver.updatePreparedIR(next)).toBe(true)
    expect(allocations).toBe(0)
    expect(fft).not.toHaveBeenCalled()
  })

  it('容量变化可接管新的预分配历史；计算分区或延迟不匹配则拒绝', () => {
    const convolver = new BinauralConvolver(128, 512)
    convolver.loadIR(...ir())
    expect(convolver.updatePreparedIR(BinauralConvolver.prepareIR(...ir(700), 128, 512))).toBe(true)
    const fresh = new BinauralConvolver(128, 512)
    fresh.loadIR(...ir(700), true)
    const a = input(2600, true), b = a.map(channel => channel.slice()) as [Float32Array, Float32Array]
    convolver.processStereo(...a); fresh.processStereo(...b)
    expect(a).toEqual(b)
    expect(convolver.loadPreparedIR(BinauralConvolver.prepareIR(...ir(), 256, 512))).toBe(false)
    expect(convolver.loadPreparedIR(BinauralConvolver.prepareIR(...ir(), 128, 128))).toBe(false)
  })

  it('拒绝非法尺寸、缺失字段、频谱 NaN/Infinity、别名与截断视图且保持现有流', () => {
    const convolver = new BinauralConvolver(128, 512), reference = new BinauralConvolver(128, 512)
    convolver.loadIR(...ir(), true); reference.loadIR(...ir(), true)
    const cases: Array<(payload: PreparedBinauralIR) => unknown> = [
      payload => ({ ...payload, partitions: 2 ** 40 }),
      payload => ({ ...payload, fftSize: 255 }),
      payload => ({ ...payload, workReal: undefined }),
      payload => { payload.irRealL[0] = NaN; return payload },
      payload => { payload.targetImagR[0] = Infinity; return payload },
      payload => ({ ...payload, historyRealR: payload.historyRealL }),
      payload => ({ ...payload, irRealL: new Float32Array(payload.irRealL.length + 1).subarray(1) }),
      payload => ({ ...payload, irRealL: new Float32Array(payload.irRealL.length), irImagL: new Float32Array(payload.irImagL.length) }),
    ]
    for (const mutate of cases) {
      const invalid = mutate(BinauralConvolver.prepareIR(...ir(), 128, 512)) as PreparedBinauralIR
      expect(convolver.loadPreparedIR(invalid)).toBe(false)
      expect(convolver.updatePreparedIR(invalid)).toBe(false)
    }
    expect(convolver.loadPreparedIR(null as unknown as PreparedBinauralIR)).toBe(false)
    const a = input(1800, true), b = a.map(channel => channel.slice()) as [Float32Array, Float32Array]
    convolver.processStereo(...a); reference.processStereo(...b)
    expect(a).toEqual(b)
  })

  it('八个频谱的末尾非有限值都拒绝，非 Hermitian 的有限频谱仍按原契约接收', () => {
    const convolver = new BinauralConvolver(128, 512)
    for (const key of ['irRealL', 'irImagL', 'irRealR', 'irImagR',
      'targetRealL', 'targetImagL', 'targetRealR', 'targetImagR'] as const) {
      for (const invalid of [NaN, Infinity, -Infinity]) {
        const payload = BinauralConvolver.prepareIR(...ir(), 128, 512)
        payload[key][payload[key].length - 1] = invalid
        expect(convolver.loadPreparedIR(payload), `${key}: ${invalid}`).toBe(false)
        expect(convolver.updatePreparedIR(payload), `${key}: ${invalid}`).toBe(false)
      }
    }
    const finiteComplex = BinauralConvolver.prepareIR(...ir(), 128, 512)
    finiteComplex.irRealL.fill(0)
    finiteComplex.irImagL.fill(0)
    finiteComplex.irImagL[finiteComplex.irImagL.length - 1] = .3
    expect(convolver.loadPreparedIR(finiteComplex)).toBe(true)
    const pcm = input(1700, true)
    convolver.processStereo(...pcm)
    expect(pcm.every(channel => channel.every(Number.isFinite))).toBe(true)
  })

  it.each([1, 32, 128, 512])('分区 %s：非整分区延迟、跨环回与中途 morph 的分块结果逐位相同', partition => {
    const latency = partition + 13
    const bulk = new BinauralConvolver(partition, latency)
    const singles = new BinauralConvolver(partition, latency)
    const initial = ir(193), target = ir(193, .8)
    bulk.loadPreparedIR(BinauralConvolver.prepareIR(...initial, partition, latency))
    singles.loadPreparedIR(BinauralConvolver.prepareIR(...initial, partition, latency))
    for (const length of [157, 211, 1703]) {
      const prepared = BinauralConvolver.prepareIR(...target, partition, latency)
      expect(bulk.updatePreparedIR(structuredClone(prepared), 71)).toBe(true)
      expect(singles.updatePreparedIR(prepared, 71)).toBe(true)
      const a = input(length, true), b = a.map(channel => channel.slice()) as [Float32Array, Float32Array]
      // 不规则调用跨过计算块与延迟环边界；参考路径每次只推进一个样本。
      for (let offset = 0; offset < length; offset += 73) {
        bulk.processStereo(a[0].subarray(offset, offset + 73), a[1].subarray(offset, offset + 73))
      }
      for (let offset = 0; offset < length; offset++) {
        singles.processStereo(b[0].subarray(offset, offset + 1), b[1].subarray(offset, offset + 1))
      }
      expect(a).toEqual(b)
    }
    bulk.reset()
    const pulseL = new Float32Array(latency + 193 + partition), pulseR = pulseL.slice()
    pulseL[0] = pulseR[0] = 1
    bulk.processStereo(pulseL, pulseR)
    for (let i = 0; i < pulseL.length; i++) {
      const tap = i - latency
      expect(Math.abs(pulseL[i] - (tap >= 0 && tap < 193 ? target[0][tap] : 0))).toBeLessThan(1e-6)
      expect(Math.abs(pulseR[i] - (tap >= 0 && tap < 193 ? target[1][tap] : 0))).toBeLessThan(1e-6)
    }
  })

  it('prepared 双耳在不规则块、独立输入和 morph 的渲染过程不创建 typed arrays', () => {
    const convolver = new BinauralConvolver(128, 512)
    convolver.loadPreparedIR(BinauralConvolver.prepareIR(...ir(), 128, 512))
    convolver.updatePreparedIR(BinauralConvolver.prepareIR(...ir(350, .6), 128, 512))
    const pcm = input(2300, true)
    let allocations = 0
    for (const name of ['Float32Array', 'Float64Array'] as const) {
      vi.stubGlobal(name, new Proxy(globalThis[name], { construct(target, args) {
        allocations++
        return Reflect.construct(target, args)
      } }))
    }
    // 长调用在内部跨越多个计算分区和输出延迟环；prepared 已提供独立耳历史。
    convolver.processStereo(...pcm)
    expect(allocations).toBe(0)
    expect(pcm.every(channel => channel.every(Number.isFinite))).toBe(true)
  })
})
