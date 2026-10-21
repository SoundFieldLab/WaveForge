import { describe, expect, it } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams } from '../src/types'
import { BinauralConvolver } from '../src/spatial/BinauralConvolver'

const fs = 48000
function settings() {
  const p = createDefaultParams(fs)
  p.eq.enabled = false; p.limiter.enabled = false
  p.spatial.mode = 'instant'; p.spatial.masterGain = 1
  p.spatial.instant.room = 'off'; p.spatial.instant.roomAmount = 0
  return p
}
function render(p: ReturnType<typeof settings>, count = 2, source = 0) {
  const engine = new EngineV3(fs); engine.setParams(p)
  const inputs = Array.from({ length: count }, (_, ch) => Float32Array.from({ length: fs * 2 }, (_, i) =>
    ch === source ? 0.02 * Math.sin(i * 2 * Math.PI * 431 / fs) : 0))
  const output = [new Float32Array(fs * 2), new Float32Array(fs * 2)]
  engine.process(inputs, output)
  return output
}
function rms(output: Float32Array[]) {
  let energy = 0
  for (const channel of output) for (let i = fs; i < channel.length; i++) energy += channel[i] ** 2
  return Math.sqrt(energy / fs / output.length)
}

describe('空间音频重做：真实输入、旁路和连续控制', () => {
  it('离散六声道空间化后的手动音量仍衰减 40 dB', () => {
    const p = settings(); p.spatial.instant.multichannelAuto = true
    const baseline = rms(render(p, 6))
    p.loudnessNormalization = { ...p.loudnessNormalization, enabled: true, useRealtimeMeter: false,
      minGainDb: -60, maxGainDb: 0, externalGainDb: -40 }
    expect(20 * Math.log10(rms(render(p, 6)) / baseline)).toBeCloseTo(-40, 2)
  })
  it.each([2, 3, 4, 8, 11])('强度零保留 7.1.4 的第 %i 声道并与关闭输出一致', source => {
    const p = settings(); p.spatial.instant.multichannelAuto = true
    p.spatial.instant.multichannelLayout = '714'; p.spatial.instant.amount = 0
    const active = render(p, 12, source)
    p.spatial.mode = 'off'
    const bypassed = render(p, 12, source)
    expect(rms(active)).toBeGreaterThan(1e-4)
    expect(active).toEqual(bypassed)
  })
  it('LFE 在开启空间化时经低频管理进入双耳', () => {
    const p = settings(); p.spatial.instant.multichannelAuto = true
    const engine = new EngineV3(fs); engine.setParams(p)
    const channels = Array.from({ length: 6 }, (_, ch) => Float32Array.from({ length: fs * 2 }, (_, i) =>
      ch === 3 ? 0.04 * Math.sin(i * 2 * Math.PI * 60 / fs) : 0))
    const output = [new Float32Array(fs * 2), new Float32Array(fs * 2)]
    engine.process(channels, output)
    expect(rms(output)).toBeGreaterThan(0.001)
  })
  it('没有轨迹时更新播放时钟不会改变 PCM', () => {
    const p = settings(); p.spatial.mode = 'world'
    const fixed = new EngineV3(fs), ticking = new EngineV3(fs)
    fixed.setParams(p); ticking.setParams(p)
    for (let frame = 0; frame < 40; frame++) {
      if (frame) { p.spatial.world.playhead = frame / 50; ticking.setParams(p) }
      const input = Float32Array.from({ length: 960 }, (_, i) => 0.02 * Math.sin((frame * 960 + i) * 0.12))
      const a = [new Float32Array(960), new Float32Array(960)]
      const b = [new Float32Array(960), new Float32Array(960)]
      fixed.process([input, input], a); ticking.process([input, input], b)
      expect(b).toEqual(a)
    }
  })
  it('同长度 HRIR 更新保留历史，不出现卷积预热静音', () => {
    const convolver = new BinauralConvolver(128, 512)
    const first = new Float32Array(140); first[20] = 1
    convolver.loadIR(first, first)
    convolver.processStereo(new Float32Array(4096).fill(0.1), new Float32Array(4096).fill(0.1))
    const next = new Float32Array(140); next[24] = 0.8
    convolver.updateIR(next, next)
    const l = new Float32Array(2048).fill(0.1), r = l.slice()
    convolver.processStereo(l, r)
    expect(Math.min(...l)).toBeGreaterThan(0.075)
    expect(l.at(-1)).toBeCloseTo(0.08, 5)
  })
})
