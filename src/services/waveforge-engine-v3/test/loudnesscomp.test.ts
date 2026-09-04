/**
 * LoudnessComp 单元测试（模块 12：等响度补偿）
 *
 * 物理意义注记：
 *  - volumePercent=100（满音量）→ 补偿量 0，全频带增益 ≈ 0dB；
 *  - volumePercent=20 → 低频（120Hz）补偿提升 >3dB、1kHz 参考点 ≈0dB（±0.3dB），
 *    对应 ISO 226 简化近似（v2 兼容）的"低频 0–12dB / 高频 0–6dB"曲线；
 *  - 平滑：参数突变时增益按 smoothingSeconds 一阶缓变，无采样跳变（无爆音）；
 *  - preset/custom 模式：固定曲线与用户自定义曲线均被拟合为 biquad 链。
 */
import { describe, it, expect } from 'vitest'
import { LoudnessComp, type LoudnessCompParams } from '../src/dsp/LoudnessComp'

const FS = 48000

function params(over: Partial<LoudnessCompParams> = {}): LoudnessCompParams {
  return {
    volumePercent: 100,
    maxBoostDb: 12,
    preset: 'flat',
    bands: [],
    mode: 'auto',
    smoothingSeconds: 0.1,
    ...over,
  }
}

/** 测量正弦经过处理链后的增益（dB）：流式处理 duration 秒，取末段稳态 RMS 比 */
function measureGain(comp: LoudnessComp, freq: number, durationSec = 3): number {
  const B = 480
  const n = Math.round(FS * durationSec)
  const steadyStart = Math.round(FS * (durationSec - 0.5))
  let inSq = 0
  let outSq = 0
  let inCount = 0
  let outCount = 0
  const blk = new Float32Array(B)
  const blkOut = new Float32Array(B)
  for (let off = 0; off < n; off += B) {
    const len = Math.min(B, n - off)
    for (let i = 0; i < len; i++) {
      blk[i] = Math.sin((2 * Math.PI * freq * (off + i)) / FS)
    }
    blkOut.set(blk)
    comp.processStereo(blkOut, new Float32Array(len))
    for (let i = 0; i < len; i++) {
      const absIdx = off + i
      if (absIdx >= steadyStart) {
        inSq += blk[i] * blk[i]
        outSq += blkOut[i] * blkOut[i]
        inCount++
        outCount++
      }
    }
  }
  if (inCount === 0 || outCount === 0) return NaN
  return 10 * Math.log10(outSq / inSq)
}

describe('LoudnessComp', () => {
  it('volumePercent=100 → 全频增益 ≈ 0dB（±0.3dB）', () => {
    const comp = new LoudnessComp(FS)
    comp.setParams(params({ volumePercent: 100, mode: 'auto' }))
    for (const f of [120, 1000, 10000]) {
      const g = measureGain(comp, f)
      expect(Math.abs(g)).toBeLessThan(0.3)
    }
  })

  it('volumePercent=20 → 120Hz 提升 >3dB、1kHz ≈0dB（±0.3dB）', () => {
    const comp = new LoudnessComp(FS)
    comp.setParams(params({ volumePercent: 20, mode: 'auto', smoothingSeconds: 0.1 }))
    const g120 = measureGain(comp, 120)
    const g1k = measureGain(comp, 1000)
    // 低频等响度补偿：120Hz 明显提升（>3dB）
    expect(g120).toBeGreaterThan(3)
    // 中频参考点：1kHz 保持 0dB（±0.3dB）
    expect(Math.abs(g1k)).toBeLessThan(0.3)
  })

  it('高频补偿：volumePercent=20 → 10kHz 提升 >1.5dB（高频 0–6dB 曲线）', () => {
    const comp = new LoudnessComp(FS)
    comp.setParams(params({ volumePercent: 20, mode: 'auto', smoothingSeconds: 0.1 }))
    const g10k = measureGain(comp, 10000)
    expect(g10k).toBeGreaterThan(1.5)
    expect(g10k).toBeLessThan(7)
  })

  it('平滑：参数突变后增益缓变，无采样跳变（最大样本差 < 3× 输入最大样本差）', () => {
    const comp = new LoudnessComp(FS)
    comp.setParams(params({ volumePercent: 100, mode: 'auto', smoothingSeconds: 0.2 }))
    const B = 128
    const total = Math.round(FS * 2.5)
    // 前 1s 用满音量（0 补偿），随后切到 20% 音量触发大幅提升
    const switchAt = Math.round(FS * 1.0)
    let maxInDelta = 0
    let maxOutDelta = 0
    let prevIn = 0
    let prevOut = 0
    for (let off = 0; off < total; off += B) {
      if (off === switchAt) {
        comp.setParams(params({ volumePercent: 20, mode: 'auto', smoothingSeconds: 0.2 }))
      }
      const len = Math.min(B, total - off)
      const l = new Float32Array(len)
      const r = new Float32Array(len)
      for (let i = 0; i < len; i++) {
        const v = Math.sin((2 * Math.PI * 200 * (off + i)) / FS)
        l[i] = v
        r[i] = v
      }
      const outL = new Float32Array(l)
      const outR = new Float32Array(r)
      comp.processStereo(outL, outR)
      for (let i = 0; i < len; i++) {
        const dIn = Math.abs(l[i] - prevIn)
        const dOut = Math.abs(outL[i] - prevOut)
        if (dIn > maxInDelta) maxInDelta = dIn
        if (dOut > maxOutDelta) maxOutDelta = dOut
        prevIn = l[i]
        prevOut = outL[i]
      }
    }
    // 增益按 τ=0.2s 缓变：输出跳变应不超过输入的 3 倍（无爆音/跳变）
    expect(maxOutDelta).toBeLessThan(3 * maxInDelta)
  })

  it('preset 模式：bass 提升低频（80Hz > 3dB），flat 全平（≈0dB）', () => {
    const bass = new LoudnessComp(FS)
    bass.setParams(params({ mode: 'preset', preset: 'bass', volumePercent: 100 }))
    const g80 = measureGain(bass, 80)
    expect(g80).toBeGreaterThan(3)

    const flat = new LoudnessComp(FS)
    flat.setParams(params({ mode: 'preset', preset: 'flat' }))
    for (const f of [80, 1000, 8000]) {
      expect(Math.abs(measureGain(flat, f))).toBeLessThan(0.3)
    }
  })

  it('custom 模式：bands=[{1000Hz, +6dB}] → 1kHz 响应提升 >3dB', () => {
    const comp = new LoudnessComp(FS)
    comp.setParams(params({ mode: 'custom', bands: [{ frequency: 1000, gain: 6 }] }))
    const g1k = measureGain(comp, 1000)
    expect(g1k).toBeGreaterThan(3)
    // 1kHz 附近的响应不应泄漏到 120Hz 低频（<1.5dB）
    const g120 = measureGain(comp, 120)
    expect(g120).toBeLessThan(1.5)
  })

  it('非法采样率抛错', () => {
    expect(() => new LoudnessComp(0)).toThrow()
    expect(() => new LoudnessComp(-48000)).toThrow()
  })
});
