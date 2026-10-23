import { describe, expect, it } from 'vitest'
import { SmartBeatPulse, applySmartBeatToCamera } from '../src/vendor/folia/components/visualizer/sonnet/smartBeat'
import { readSmartBeatSettings, normalizeSmartBeatSettings } from '../src/vendor/folia/components/visualizer/smartBeatSettings'

describe('Smart Beat 拍脉冲状态机', () => {
  it('每拍产出 zoom 脉冲，随相位衰减', () => {
    const pulse = new SmartBeatPulse()
    let now = 1000
    const frames: number[] = []
    // 模拟真实 beat 快照序列：onset 后从 0.9 衰减到基线（useAudioAnalyzer 的
    // beatPulse *= 0.72 同款形状），下一拍再跃起——onset 检测依赖这个"跃起"
    let level = 0
    for (let i = 0; i < 6; i += 1) {
      level = 0.9
      now += 500
      frames.push(pulse.update(now, { beat: level, accent: 0.3, bass: 0.6 }, {}).zoom)
      now += 250
      pulse.update(now, { beat: level * 0.4, accent: 0.12, bass: 0.6 }, {})
    }
    expect(frames[1]).toBeGreaterThan(0)
    expect(frames[2]).toBeGreaterThan(0)
  })

  it('音乐停止（beat=0 持续）后效果归零', () => {
    const pulse = new SmartBeatPulse()
    let now = 1000
    pulse.update(now, { beat: 0.8, accent: 0.3, bass: 0.5 }, {})
    now += 500
    pulse.update(now, { beat: 0.8, accent: 0.3, bass: 0.5 }, {})
    now += 3000 // 长静默
    const frame = pulse.update(now, { beat: 0, accent: 0, bass: 0 }, {})
    expect(frame.zoom).toBe(0)
    expect(frame.tear).toBe(0)
  })

  it('强拍触发裂光（tear > 0）', () => {
    const pulse = new SmartBeatPulse()
    let now = 1000
    pulse.update(now, { beat: 0.2, accent: 0.1, bass: 0.4 }, {})
    now += 500
    const frame = pulse.update(now + 50, { beat: 0.9, accent: 0.8, bass: 0.7 }, {})
    expect(frame.tear).toBeGreaterThan(0)
  })

  it('applySmartBeatToCamera 按 X 常量表缩放', () => {
    const camera = { scale: 1, rotation: 0 }
    applySmartBeatToCamera({ zoom: 1, downbeatZoom: 0, rotation: 0, tear: 0, flare: 0, iconPop: 0 }, camera)
    expect(camera.scale).toBeCloseTo(1.06, 5) // zoomPercent 6%
    const camera2 = { scale: 1, rotation: 0 }
    applySmartBeatToCamera({ zoom: 0, downbeatZoom: 1, rotation: 1, tear: 0, flare: 0, iconPop: 0 }, camera2)
    expect(camera2.scale).toBeCloseTo(1.05, 5) // downbeatZoomPercent 5%
    expect(camera2.rotation).toBeCloseTo(0.6 * Math.PI / 180, 5)
  })

  it('strength=0 的效果被关掉', () => {
    const pulse = new SmartBeatPulse()
    let now = 1000
    pulse.update(now, { beat: 0.2, accent: 0.1, bass: 0.4 }, {})
    now += 500
    const frame = pulse.update(now, { beat: 0.9, accent: 0.3, bass: 0.6 }, {
      'sonnet.beatZoom': { on: true, strength: 0 },
    })
    expect(frame.zoom).toBe(0)
  })
})

describe('Smart Beat 设置存储', () => {
  it('旧格式（顶层 beatIntensity 均值）迁移到逐效果 strength', () => {
    const normalized = normalizeSmartBeatSettings(
      { beatIntensity: 1.5, downbeatIntensity: 0.5, enabled: true },
      { enabled: false, effects: { 'sonnet.beatZoom': { on: true, strength: 1 } } },
    )
    expect(normalized.enabled).toBe(true)
    expect(normalized.effects['sonnet.beatZoom'].strength).toBe(1) // (1.5+0.5)/2
  })

  it('非法 effectId（不符合 <32串>.<32串>）被拒', () => {
    const normalized = normalizeSmartBeatSettings(
      { enabled: true, effects: { 'bad id with spaces': { on: true, strength: 2 } } },
      { enabled: false, effects: {} },
    )
    expect(Object.keys(normalized.effects)).toHaveLength(0)
  })

  it('strength 钳制到 0..2', () => {
    const normalized = normalizeSmartBeatSettings(
      { enabled: true, effects: { 'sonnet.beatZoom': { on: true, strength: 99 } } },
      { enabled: false, effects: {} },
    )
    expect(normalized.effects['sonnet.beatZoom'].strength).toBe(2)
  })
})
