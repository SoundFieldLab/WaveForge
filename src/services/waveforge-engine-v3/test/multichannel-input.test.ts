import { describe, expect, it, vi } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams } from '../src/types'

describe('多声道输入与高采样率', () => {
  it.each([['quad', 4], ['51', 6], ['71', 8], ['714', 12]] as const)(
    '一键空间化将原始 %s 声道逐块传入 HRTF 后端', (layout, channelCount) => {
      const engine = new EngineV3(48000)
      const params = createDefaultParams(48000)
      params.eq.enabled = false
      params.limiter.enabled = false
      params.spatial.mode = 'instant'
      params.spatial.instant.multichannelAuto = true
      params.spatial.instant.multichannelLayout = layout
      params.spatial.instant.room = 'off'
      engine.setParams(params)
      const backend = (engine as unknown as { _spatialBackend: { processMulti: (...args: unknown[]) => void } })._spatialBackend
      const processMulti = vi.spyOn(backend, 'processMulti')
      const channels = Array.from({ length: channelCount }, (_, channel) => new Float32Array(256).fill((channel + 1) / 100))
      const original = channels.map((channel) => channel.slice())
      const left = new Float32Array(256), right = new Float32Array(256)
      engine.process(channels, [left, right])
      expect(processMulti).toHaveBeenCalledTimes(2)
      for (const [block] of processMulti.mock.calls) {
        expect((block as Float32Array[]).map((channel) => channel.length)).toEqual(Array(channelCount).fill(128))
        ;(block as Float32Array[]).forEach((channel, index) => expect(channel[0]).toBeCloseTo((index + 1) / 100, 6))
      }
      expect(channels).toEqual(original)
      expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true)
    },
  )

  it.each([false, true])('四声道同侧折叠，不把环绕误当中心或 LFE（旁路=%s）', (bitPerfectBypass) => {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.eq.enabled = false
    params.limiter.enabled = false
    params.bitPerfectBypass = bitPerfectBypass
    engine.setParams(params)
    // 跨过 128 帧边界，确认每块读取的是对应偏移而非首块。
    const channels = Array.from({ length: 4 }, () => new Float32Array(257))
    channels[2][0] = 1
    channels[3][128] = 1
    channels[0][256] = 0.4
    const left = new Float32Array(257), right = new Float32Array(257)
    engine.process(channels, [left, right])
    expect(left[0]).toBeCloseTo(0.5, 6)
    expect(right[0]).toBe(0)
    expect(left[128]).toBe(0)
    expect(right[128]).toBeCloseTo(0.5, 6)
    expect(left[256]).toBeCloseTo(0.2, 6)
    expect(right[256]).toBe(0)
  })

  it('5.1 输入按中心、低频和环绕声道折叠为双声道', () => {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.eq.enabled = false
    params.limiter.enabled = false
    engine.setParams(params)
    const input = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((value) => new Float32Array(128).fill(value))
    const left = new Float32Array(128)
    const right = new Float32Array(128)
    engine.process(input, [left, right])
    const common = 0.3 * Math.SQRT1_2 + 0.4 * 0.25
    expect(left[127]).toBeCloseTo(0.1 + common + 0.5 * Math.SQRT1_2, 5)
    expect(right[127]).toBeCloseTo(0.2 + common + 0.6 * Math.SQRT1_2, 5)
  })

  it.each([96000, 192000])('%i Hz 立体声处理输出有限', (sampleRate) => {
    const engine = new EngineV3(sampleRate)
    const params = createDefaultParams(sampleRate)
    params.compressor.enabled = true
    params.compressor.mode = 'multiband'
    engine.setParams(params)
    const input = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i * 0.2) * 0.2)
    const left = new Float32Array(input.length)
    const right = new Float32Array(input.length)
    engine.process([input, input], [left, right])
    expect(left.every(Number.isFinite)).toBe(true)
    expect(right.every(Number.isFinite)).toBe(true)
  })
})


describe('自动输入布局与反射预算', () => {
  it('连续切换标准声道数时只更新空间级，并使用对应输入映射', () => {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.eq.enabled = false; params.limiter.enabled = false
    params.spatial.mode = 'instant'
    params.spatial.instant.multichannelAuto = true
    params.spatial.instant.multichannelLayout = 'auto'
    params.spatial.instant.room = 'off'
    engine.setParams(params)
    const backend = (engine as unknown as { _spatialBackend: { setConfig: (...args: any[]) => void } })._spatialBackend
    const setConfig = vi.spyOn(backend, 'setConfig')
    const resetParams = vi.spyOn(engine, 'setParams')
    for (const channelCount of [4, 12, 6, 8, 2, 6, 1]) {
      const channels = Array.from({ length: channelCount }, (_, channel) => new Float32Array(2048).fill(0.01 * (channel + 1)))
      const left = new Float32Array(2048), right = new Float32Array(2048)
      engine.process(channels, [left, right])
      const config = setConfig.mock.calls.at(-1)![0]
      expect(config.speakers).toHaveLength(channelCount <= 2 ? 2 : channelCount)
      if (channelCount > 4) expect(config.speakers[3].gain).toBe(0)
      expect(config.speakers[0].channel).toBe(0)
      expect(config.speakers[1].channel).toBe(1)
      expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true)
    }
    expect(resetParams).not.toHaveBeenCalled()
    const count = setConfig.mock.calls.length
    engine.process([new Float32Array(128)], [new Float32Array(128), new Float32Array(128)])
    expect(setConfig).toHaveBeenCalledTimes(count)
  })

  it.each([
    [48000, 'quality', 2], [96000, 'quality', 2], [48000, 'auto', 2],
    [96000, 'auto', 1], [192000, 'auto', 1], [96000, 'lowLatency', 0],
  ] as const)('%i Hz %s 策略实际配置 %i 阶反射并保留晚混响', (fs, mode, orders) => {
    const engine = new EngineV3(fs)
    const params = createDefaultParams(fs)
    params.spatial.mode = 'headLocked'
    params.spatial.headLocked.layout = '714'
    params.spatial.instant.room = 'hall'
    params.spatial.instant.roomAmount = 0.5
    params.spatial.budgetMode = mode
    const backend = (engine as unknown as { _spatialBackend: {
      setConfig: (...args: any[]) => void; roomEarlyOrders: number; room: { fdn: unknown; states: { taps: unknown[] }[] } | null
    } })._spatialBackend
    const setConfig = vi.spyOn(backend, 'setConfig')
    engine.setParams(params)
    expect(setConfig).toHaveBeenLastCalledWith(expect.objectContaining({ earlyReflectionOrders: orders }))
    expect(backend.roomEarlyOrders).toBe(orders)
    expect(backend.room).not.toBeNull()
    expect(backend.room!.fdn).not.toBeNull()
    const signal = Float32Array.from({ length: 512 }, (_, i) => 0.1 * Math.sin(i * 0.11))
    const left = new Float32Array(512), right = new Float32Array(512)
    engine.process([signal, signal], [left, right])
    expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true)
  })
})
