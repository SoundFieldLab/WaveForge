import { describe, expect, it } from 'vitest'
import { EngineV3 } from '../../engine/EngineV3'
import { createDefaultParams } from '../../types'

describe('EngineV3 最终限幅', () => {
  it('空间叠加之后仍遵守用户设置的限幅阈值', () => {
    const fs = 48000
    const input = Float32Array.from({ length: 8192 }, (_, i) =>
      0.85 * Math.sin(2 * Math.PI * 1000 * i / fs))
    const run = (enabled: boolean): number => {
      const engine = new EngineV3(fs)
      const params = createDefaultParams(fs)
      params.spatial!.mode = 'instant'
      params.spatial!.instant.amount = 1
      params.limiter.enabled = enabled
      params.limiter.thresholdDb = -18
      engine.setParams(params)
      const left = new Float32Array(input.length)
      const right = new Float32Array(input.length)
      engine.process([input, input], [left, right])
      let peak = 0
      for (let i = 2048; i < input.length; i++) {
        peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
      }
      expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true)
      return peak
    }
    const threshold = Math.pow(10, -18 / 20)
    expect(run(false)).toBeGreaterThan(threshold * 1.5)
    expect(run(true)).toBeLessThanOrEqual(threshold * 1.02)
  })
})

describe('EngineV3 空间音频切换', () => {
  it('启用和关闭时保持波形连续，不吐出卷积起播静音', () => {
    const fs = 48000
    const engine = new EngineV3(fs)
    const params = createDefaultParams(fs)
    params.eq.enabled = false
    params.limiter.enabled = false
    params.spatial!.instant.room = 'off'
    params.spatial!.instant.roomAmount = 0
    engine.setParams(params)
    const rendered = new Float32Array(128 * 96)
    for (let block = 0; block < 96; block++) {
      if (block === 32) {
        params.spatial!.mode = 'instant'
        engine.setParams(params)
      }
      if (block === 64) {
        params.spatial!.mode = 'off'
        engine.setParams(params)
      }
      const input = Float32Array.from({ length: 128 }, (_, i) =>
        0.2 * Math.sin(2 * Math.PI * 1000 * (block * 128 + i) / fs))
      const left = new Float32Array(128)
      const right = new Float32Array(128)
      engine.process([input, input], [left, right])
      rendered.set(left, block * 128)
    }
    for (const boundary of [32 * 128, 64 * 128]) {
      let maxStep = 0
      for (let i = boundary - 8; i < boundary + 8; i++) {
        maxStep = Math.max(maxStep, Math.abs(rendered[i] - rendered[i - 1]))
      }
      expect(maxStep).toBeLessThan(0.05)
    }
  })
})
