/**
 * 立体声 → headLocked 虚拟扬声器 5.1 / 7.1 自动上混回归测试。
 *
 * 产品契约（本轮新增能力）：
 * - headLocked 预设布局（51 / 514 / 71 / 714）遇到普通立体声节目（≤2 声道）时，
 *   由 EngineV3 内部先用 StereoUpmixer 矩阵上混出 center / LFE / surround / height，
 *   再作为离散声道送入 HRTF 后端（TsConvolverBackend.processMulti），使中心/环绕
 *   不再只是 L/R 的复制，也不是静音。
 * - 自定义布局（custom）只有用户显式配置的扬声器，不得被强行扩展成 5.1/7.1。
 * - 输入本身就是 5.1 等多声道节目时，不得再被立体声上混器「二次上混」。
 *
 * 断言方式：探针挂在真实后端的 processMulti 上（与 multichannel-input.test.ts /
 * worldRouting.test.ts 相同做法），直接读取后端实际收到的离散输入通道；不 mock DSP。
 * 若某项在此处失败，说明上混/接线契约没有被满足，不要通过放宽断言或跳过用例「修复」。
 */
import { describe, expect, it, vi } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams } from '../src/types'
import type { SpatialSettings } from '../src/types'
import type { SpatialRenderConfig, VirtualSpeaker, VirtualSpeakerCfg } from '../src/spatial/types'

const SAMPLE_RATE = 48_000
const FRAMES = 256

/** 与真实后端一致的最小探针形状（只声明本测试用到的成员）。 */
type SpatialBackendProbe = {
  processMulti: (inputs: Float32Array[], outL: Float32Array, outR: Float32Array,
    dryL?: Float32Array, dryR?: Float32Array) => void
  processStereo: (left: Float32Array, right: Float32Array, outL: Float32Array, outR: Float32Array) => void
  setConfig: (config: SpatialRenderConfig) => void
  speakers: VirtualSpeaker[]
}

type EngineProbe = {
  _spatialBackend: SpatialBackendProbe
  _spatialHeadLockedUpmix: '51' | '514' | '71' | '714' | null
  _spatialMultiChannelCount: number
  _stereoUpmixer51: { process: (left: Float32Array, right: Float32Array, frames?: number) => unknown }
  _stereoUpmixer71: { process: (left: Float32Array, right: Float32Array, frames?: number) => unknown }
}

function probe(engine: EngineV3): EngineProbe {
  return engine as unknown as EngineProbe
}

/** headLocked 预设布局 + 普通立体声节目；关闭 EQ / 限幅，房间关闭，强度 100%。 */
function headLockedParams(layout: SpatialSettings['headLocked']['layout']): ReturnType<typeof createDefaultParams> {
  const params = createDefaultParams(SAMPLE_RATE)
  params.eq.enabled = false
  params.limiter.enabled = false
  params.bitPerfectBypass = false
  params.spatial.mode = 'headLocked'
  params.spatial.inputFormat = 'channels'
  params.spatial.headLocked.layout = layout
  params.spatial.instant.amount = 1
  params.spatial.instant.room = 'off'
  return params
}

/** 左右不同的立体声节目：任何只做 L/R 复制的实现都会在两个声道得到相同结果。 */
function stereoProgram(): { left: Float32Array; right: Float32Array } {
  const left = new Float32Array(FRAMES)
  const right = new Float32Array(FRAMES)
  for (let i = 0; i < FRAMES; i++) {
    left[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE)
    right[i] = 0.5 * Math.sin(2 * Math.PI * 660 * i / SAMPLE_RATE + 0.7)
  }
  return { left, right }
}

/** 真实 5.1 节目：6 路内容各自可辨识，用于证明不会被当成立体声再上混一次。 */
function surroundProgram(): Float32Array[] {
  return Array.from({ length: 6 }, (_, channel) => {
    const signal = new Float32Array(FRAMES)
    for (let i = 0; i < FRAMES; i++) {
      signal[i] = 0.05 * (channel + 1) * Math.sin(2 * Math.PI * (220 + 110 * channel) * i / SAMPLE_RATE)
    }
    return signal
  })
}

function processThrough(engine: EngineV3, inputs: Float32Array[]): { outL: Float32Array; outR: Float32Array } {
  const outL = new Float32Array(inputs[0].length)
  const outR = new Float32Array(inputs[0].length)
  engine.process(inputs, [outL, outR])
  return { outL, outR }
}

function maxAbs(channel: Float32Array): number {
  let peak = 0
  for (let i = 0; i < channel.length; i++) {
    const value = Math.abs(channel[i])
    if (value > peak) peak = value
  }
  return peak
}

/** 取后端最后一次 processMulti 收到的离散输入通道（内部视图复用，必须取最后一次调用）。 */
function lastProcessedMulti(spy: { mock: { calls: unknown[][] } }): Float32Array[] {
  expect(spy.mock.calls.length, '空间后端没有收到 processMulti 调用（上混未接线）').toBeGreaterThan(0)
  return spy.mock.calls.at(-1)![0] as Float32Array[]
}

describe('headLocked 立体声自动上混（虚拟扬声器 5.1/7.1）', () => {
  it('布局 51：立体声节目上混为 6 路离散输入，center/surround 有真实内容', () => {
    const engine = new EngineV3(SAMPLE_RATE, 2)
    const state = probe(engine)
    engine.setParams(headLockedParams('51'))
    expect(state._spatialHeadLockedUpmix,
      '布局 51 + 立体声输入应进入 5.1 上混分支（_spatialHeadLockedUpmix 应为 51）').toBe('51')
    expect(state._spatialMultiChannelCount,
      '5.1 上混应把空间后端多声道容量扩到 6 路（FL/FR/FC/LFE/SL/SR）').toBe(6)

    const processMulti = vi.spyOn(state._spatialBackend, 'processMulti')
    const { left, right } = stereoProgram()
    const { outL, outR } = processThrough(engine, [left, right])

    const block = lastProcessedMulti(processMulti)
    expect(block, '5.1 上混应向后端提供 6 路离散输入').toHaveLength(6)
    const [fl, fr, center, , surroundL, surroundR] = block
    expect(maxAbs(fl), 'FL（第 1 路）应保留左声道节目内容').toBeGreaterThan(0.01)
    expect(maxAbs(fr), 'FR（第 2 路）应保留右声道节目内容').toBeGreaterThan(0.01)
    expect(maxAbs(center), 'center（第 3 路）应由 L/R 上混出真实内容，不能是静音').toBeGreaterThan(0.05)
    expect(maxAbs(surroundL), 'SL（第 5 路）应由声道差上混出环绕内容，不能是静音').toBeGreaterThan(0.02)
    expect(maxAbs(surroundR), 'SR（第 6 路）应由声道差上混出环绕内容，不能是静音').toBeGreaterThan(0.02)
    expect(outL.every(Number.isFinite) && outR.every(Number.isFinite), '上混后输出必须全部有限').toBe(true)
  })

  it('布局 71：立体声节目上混为 8 路离散输入，中心与四只环绕均有内容', () => {
    const engine = new EngineV3(SAMPLE_RATE, 2)
    const state = probe(engine)
    engine.setParams(headLockedParams('71'))
    expect(state._spatialHeadLockedUpmix,
      '布局 71 + 立体声输入应进入 7.1 上混分支（_spatialHeadLockedUpmix 应为 71）').toBe('71')
    expect(state._spatialMultiChannelCount,
      '7.1 上混应把空间后端多声道容量扩到 8 路（FL/FR/FC/LFE/SL/SR/BL/BR）').toBe(8)

    const processMulti = vi.spyOn(state._spatialBackend, 'processMulti')
    const { left, right } = stereoProgram()
    const { outL, outR } = processThrough(engine, [left, right])

    const block = lastProcessedMulti(processMulti)
    expect(block, '7.1 上混应向后端提供 8 路离散输入').toHaveLength(8)
    const [fl, fr, center, , sideL, sideR, rearL, rearR] = block
    expect(maxAbs(fl), 'FL（第 1 路）应保留左声道节目内容').toBeGreaterThan(0.01)
    expect(maxAbs(fr), 'FR（第 2 路）应保留右声道节目内容').toBeGreaterThan(0.01)
    expect(maxAbs(center), 'center（第 3 路）应由 L/R 上混出真实内容，不能是静音').toBeGreaterThan(0.05)
    expect(maxAbs(sideL), 'SL（第 5 路）应由声道差上混出环绕内容，不能是静音').toBeGreaterThan(0.02)
    expect(maxAbs(sideR), 'SR（第 6 路）应由声道差上混出环绕内容，不能是静音').toBeGreaterThan(0.02)
    expect(maxAbs(rearL), 'BL（第 7 路）应由声道差上混出后环绕内容，不能是静音').toBeGreaterThan(0.01)
    expect(maxAbs(rearR), 'BR（第 8 路）应由声道差上混出后环绕内容，不能是静音').toBeGreaterThan(0.01)
    expect(outL.every(Number.isFinite) && outR.every(Number.isFinite), '上混后输出必须全部有限').toBe(true)
  })

  it('布局 custom：两只扬声器时仍只有 L/R，不被强行扩展成 5.1/7.1', () => {
    const engine = new EngineV3(SAMPLE_RATE, 2)
    const state = probe(engine)
    const params = headLockedParams('custom')
    const customSpeakers: VirtualSpeakerCfg[] = [
      { azimuthDeg: -30, elevationDeg: 0, distance: 2, gain: 1, size: 0 },
      { azimuthDeg: 30, elevationDeg: 0, distance: 2, gain: 1, size: 0 },
    ]
    params.spatial.headLocked.speakers = customSpeakers
    params.spatial.headLocked.routes = []

    const setConfig = vi.spyOn(state._spatialBackend, 'setConfig')
    const processMulti = vi.spyOn(state._spatialBackend, 'processMulti')
    engine.setParams(params)
    const processStereo = vi.spyOn(state._spatialBackend, 'processStereo')

    expect(state._spatialHeadLockedUpmix,
      'custom 布局没有标准声道映射，不得启用立体声上混').toBeNull()
    const config = setConfig.mock.calls.at(-1)![0]
    expect(config.speakers, 'custom 两只扬声器的渲染配置必须保持 2 只，不能被扩展成 5.1/7.1')
      .toHaveLength(2)
    expect(config.speakers.map((speaker) => speaker.channel),
      'custom 两只扬声器只允许驱动 L/R 两个节目声道').toEqual([0, 1])

    const { left, right } = stereoProgram()
    const { outL, outR } = processThrough(engine, [left, right])
    expect(processMulti,
      'custom 布局不得走多声道上混路径（processMulti 不应被调用）').not.toHaveBeenCalled()
    expect(processStereo,
      'custom 两只扬声器应按 L/R 立体声路径交给后端（processStereo 应被调用）').toHaveBeenCalled()
    expect(outL.every(Number.isFinite) && outR.every(Number.isFinite), '输出必须全部有限').toBe(true)
    expect(maxAbs(outL) + maxAbs(outR), '输出不能是静音').toBeGreaterThan(0.01)
  })

  it('布局 714：立体声上混为 12 路，顶置虚拟扬声器有真实高频内容', () => {
    const engine = new EngineV3(SAMPLE_RATE, 2)
    const state = probe(engine)
    const params = headLockedParams('714')
    params.spatial.headLocked.heightLayer = true
    engine.setParams(params)
    expect(state._spatialHeadLockedUpmix,
      '布局 714 + 立体声输入应进入 7.1.4 上混分支').toBe('714')
    expect(state._spatialMultiChannelCount,
      '7.1.4 上混应把空间后端多声道容量扩到 12 路').toBe(12)

    const processMulti = vi.spyOn(state._spatialBackend, 'processMulti')
    const left = new Float32Array(FRAMES)
    const right = new Float32Array(FRAMES)
    for (let i = 0; i < FRAMES; i++) {
      left[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE) + 0.08 * Math.sin(2 * Math.PI * 6000 * i / SAMPLE_RATE)
      right[i] = 0.25 * Math.sin(2 * Math.PI * 660 * i / SAMPLE_RATE + 0.7) + 0.08 * Math.cos(2 * Math.PI * 7000 * i / SAMPLE_RATE)
    }
    const { outL, outR } = processThrough(engine, [left, right])
    const block = lastProcessedMulti(processMulti)
    expect(block, '7.1.4 上混应向后端提供 12 路离散输入').toHaveLength(12)
    const heights = block.slice(8, 12)
    expect(heights.every((channel) => maxAbs(channel) > 0.002),
      '4 只顶置虚拟扬声器应由高频 mid/side 派生，不能静音').toBe(true)
    expect(outL.every(Number.isFinite) && outR.every(Number.isFinite)).toBe(true)
  })

  it('环绕去相关：默认关闭单声道环绕静音，开启后环绕声道获得非相干反射能量', () => {
    const render = (decorrelation: number): Float32Array[] => {
      const engine = new EngineV3(SAMPLE_RATE, 2)
      const state = probe(engine)
      const params = headLockedParams('51')
      params.spatial.decorrelation = decorrelation
      params.spatial.instant.amount = 1
      params.spatial.instant.room = 'off'
      engine.setParams(params)
      const processMulti = vi.spyOn(state._spatialBackend, 'processMulti')
      const left = new Float32Array(FRAMES)
      const right = new Float32Array(FRAMES)
      // 单声道节目：矩阵差分环绕为 0，只有去相关能提供后方线索。
      for (let i = 0; i < FRAMES; i++) {
        left[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / SAMPLE_RATE)
        right[i] = left[i]
      }
      for (let block = 0; block < 3; block++) processThrough(engine, [left, right])
      return lastProcessedMulti(processMulti)
    }

    const dry = render(0)
    const wet = render(0.6)
    expect(maxAbs(dry[4]), '默认关闭时 5.1 单声道 SL 必须保持矩阵语义的静音').toBeLessThan(1e-7)
    expect(maxAbs(dry[5]), '默认关闭时 5.1 单声道 SR 必须保持矩阵语义的静音').toBeLessThan(1e-7)
    expect(maxAbs(wet[4]), '开启去相关后 SL 应有早期反射能量').toBeGreaterThan(0.002)
    expect(maxAbs(wet[5]), '开启去相关后 SR 应有早期反射能量').toBeGreaterThan(0.002)
    expect(wet[4].some((value, i) => Math.abs(value - wet[5][i]) > 1e-4),
      '左右环绕延迟不同，不应是同一路复制').toBe(true)
  })

  it('输入本身是 5.1（6 声道）时不再被立体声上混器二次上混', () => {
    const engine = new EngineV3(SAMPLE_RATE, 2)
    const state = probe(engine)
    engine.setParams(headLockedParams('71'))
    // setParams 时引擎仍按 2 声道准备，会先建立 7.1 上混；真实 6 声道输入到达后必须撤掉。
    expect(state._spatialHeadLockedUpmix,
      '前置条件：立体声假设下布局 71 应先建立上混').toBe('71')

    const upmix71 = vi.spyOn(state._stereoUpmixer71, 'process')
    const processMulti = vi.spyOn(state._spatialBackend, 'processMulti')
    const processStereo = vi.spyOn(state._spatialBackend, 'processStereo')
    const { outL, outR } = processThrough(engine, surroundProgram())

    expect(upmix71,
      '真实 5.1 输入不得再经过 StereoUpmixer 二次上混').not.toHaveBeenCalled()
    expect(state._spatialHeadLockedUpmix,
      '真实多声道输入到达后应撤掉立体声上混布局').toBeNull()
    expect(processMulti,
      '真实 5.1 输入被立体声上混后会以 8 路上混声道调用 processMulti；这里不应发生').not.toHaveBeenCalled()
    expect(processStereo,
      '真实 5.1 输入应按真实输入解码后交给立体声后端路径（当前实现为 downmix + processStereo）').toHaveBeenCalled()
    expect(outL.every(Number.isFinite) && outR.every(Number.isFinite), '输出必须全部有限').toBe(true)
    expect(maxAbs(outL) + maxAbs(outR), '输出不能是静音').toBeGreaterThan(0.01)
  })
})
