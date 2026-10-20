import { describe, expect, it } from 'vitest'
import { PropagationDelay } from '../PropagationDelay'

describe('PropagationDelay', () => {
  it('细小位移时不产生样本级跳变，分块处理结果一致', () => {
    const fs = 48000
    const signal = Float32Array.from({ length: 8192 }, (_, i) =>
      0.2 * Math.sin(2 * Math.PI * 440 * i / fs))
    const whole = new PropagationDelay(fs)
    const chunks = new PropagationDelay(fs)
    whole.setDistance(2)
    chunks.setDistance(2)
    const a = Float32Array.from(signal)
    const b = Float32Array.from(signal)
    whole.process(a.subarray(0, 4096))
    chunks.process(b.subarray(0, 4096))
    whole.setDistance(2.01)
    chunks.setDistance(2.01)
    whole.process(a.subarray(4096))
    for (let i = 4096; i < b.length; i += 128) chunks.process(b.subarray(i, i + 128))
    expect(a).toEqual(b)
    let maxStep = 0
    for (let i = 4096; i < 5000; i++) maxStep = Math.max(maxStep, Math.abs(a[i] - a[i - 1]))
    expect(maxStep).toBeLessThan(0.02)
  })

  it('大幅移动时交叉淡变并在新距离稳定后到达，reset 清理旧内容', () => {
    const fs = 48000
    const delay = new PropagationDelay(fs)
    delay.setDistance(1)
    const seed = new Float32Array(4096)
    seed[0] = 0.5
    delay.process(seed)
    delay.setDistance(20)
    const afterMove = new Float32Array(4096)
    delay.process(afterMove)
    expect(afterMove.every(Number.isFinite)).toBe(true)
    delay.reset()
    const silent = new Float32Array(4096)
    delay.process(silent)
    expect(silent.every(value => value === 0)).toBe(true)
    const impulse = new Float32Array(4096)
    impulse[0] = 0.5
    delay.process(impulse)
    const peak = Math.ceil(20 * fs / 343)
    expect(Math.max(Math.abs(impulse[peak - 1]), Math.abs(impulse[peak]))).toBeGreaterThan(0.1)
  })

  it('远距离声源使用完整传播时间，不截断为短延迟', () => {
    const fs = 48000
    const delay = new PropagationDelay(fs)
    delay.setDistance(150)
    const signal = new Float32Array(24000)
    signal[0] = 1
    delay.process(signal)
    const arrival = 150 * fs / 343
    const peak = signal.findIndex(value => Math.abs(value) > 0.1)
    expect(Math.abs(peak - arrival)).toBeLessThanOrEqual(1)
  })
})
