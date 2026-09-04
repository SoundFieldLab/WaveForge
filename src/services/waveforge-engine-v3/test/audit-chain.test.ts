/**
 * audit-chain.test.ts —— 链路与注入审计（任务 A，修复后重写版）
 *
 * 覆盖（对应 docs/audit/chain-audit.md 的审计意图，缺陷修复后转为正断言）：
 *  ① 默认参数全链直通（基准）；② 逐效果 enabled=false 真正旁路（含修复项：
 *     reverb mode='off'、eq 旁路不泄漏用户 bands、无效档案 id、pitch.enabled 门控 voiceBalance）；
 *  ③ 零值参数直通；⑤ 尾块/自激（含卷积混响长流无 NaN）；⑥ 场景与组合链路；
 *  ⑦ 响度归一化启动不膨胀。
 * 原"⑦ 已知异常行为快照"（锁定缺陷行为）已随缺陷修复移除。
 */
import { describe, it, expect } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { SCENE_PRESETS } from '../src/engine/ScenePresets'
import { createDefaultParams, type V3EngineParams } from '../src/types'

const FS = 48000

function sine(n: number, f: number, a: number, fs: number): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = a * Math.sin((2 * Math.PI * f * i) / fs)
  return x
}
function zeros(n: number): Float32Array {
  return new Float32Array(n)
}
function maxAbs(x: Float32Array): number {
  let m = 0
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]))
  return m
}
/** 全效果关闭的基础参数（旁路基座） */
function allOffParams(): V3EngineParams {
  const p = createDefaultParams(FS)
  p.eq.enabled = false
  p.deesser.enabled = false
  p.compressor.enabled = false
  p.nightMode.enabled = false
  p.bassEnhancer.enabled = false
  p.reverb.enabled = false
  p.surround3d.enabled = false
  p.loudnessCompensation.enabled = false
  p.loudnessNormalization.enabled = false
  p.limiter.enabled = false
  p.ieq.enabled = false
  p.pitch.enabled = false
  return p
}
function runChain(engine: EngineV3, l: Float32Array, r: Float32Array, blocks = 1): { outL: Float32Array; outR: Float32Array } {
  const B = l.length
  const outL = new Float32Array(B * blocks)
  const outR = new Float32Array(B * blocks)
  for (let b = 0; b < blocks; b++) {
    engine.process([l, r], [outL.subarray(b * B, (b + 1) * B), outR.subarray(b * B, (b + 1) * B)])
  }
  return { outL, outR }
}

describe('① 默认参数全链直通（基准）', () => {
  it('默认参数：1kHz 0.5 正弦增益差 <0.3dB；默认 limiter(-1dBFS) 不压 0.5 信号', () => {
    const e = new EngineV3(FS, 2)
    e.setParams(createDefaultParams(FS))
    const B = 4800
    const l = sine(B, 1000, 0.5, FS)
    const r = sine(B, 1000, 0.4, FS)
    const { outL } = runChain(e, l, r)
    let sumIn = 0
    let sumOut = 0
    for (let i = B / 2; i < B; i++) {
      sumIn += l[i] * l[i]
      sumOut += outL[i] * outL[i]
    }
    const gainDb = 10 * Math.log10(sumOut / sumIn)
    expect(Math.abs(gainDb)).toBeLessThan(0.3)
    expect(maxAbs(outL)).toBeLessThan(0.51) // limiter 不压正常信号
  })

  it('全效果关闭后输出与输入逐样本一致（≤1e-12，浮点容差）', () => {
    const e = new EngineV3(FS, 2)
    e.setParams(allOffParams())
    const B = 4800
    const l = sine(B, 330, 0.5, FS)
    const r = sine(B, 330, 0.3, FS)
    const l0 = l.slice()
    const r0 = r.slice()
    const { outL, outR } = runChain(e, l, r)
    let maxD = 0
    for (let i = 0; i < B; i++) maxD = Math.max(maxD, Math.abs(outL[i] - l0[i]), Math.abs(outR[i] - r0[i]))
    expect(maxD).toBeLessThan(1e-12)
  })

  it('默认冲激延迟 = getLatencySamples() = 240（限幅器 lookahead 5ms）', () => {
    const e = new EngineV3(FS, 2)
    e.setParams(createDefaultParams(FS))
    expect(e.getLatencySamples()).toBe(240)
  })
})

describe('② 逐效果 enabled=false 真正旁路', () => {
  it('eq(无档案)/deesser/compressor/nightMode/reverb/bass/loudnessComp/ieq/surround3d/limiter/loudNorm 全部直通（diff ≤1e-9）', () => {
    const cases: Array<[string, (p: V3EngineParams) => void]> = [
      ['eq.enabled=false(无档案)', (p) => { p.eq.enabled = false }],
      ['deesser.enabled=false', (p) => { p.deesser.enabled = false }],
      ['compressor.enabled=false', (p) => { p.compressor.enabled = false }],
      ['nightMode.enabled=false', (p) => { p.nightMode.enabled = false }],
      ['reverb.enabled=false', (p) => { p.reverb.enabled = false }],
      ['bass.enabled=false', (p) => { p.bassEnhancer.enabled = false }],
      ['loudnessComp.enabled=false', (p) => { p.loudnessCompensation.enabled = false }],
      ['ieq.enabled=false', (p) => { p.ieq.enabled = false }],
      ['surround3d.enabled=false', (p) => { p.surround3d.enabled = false }],
      ['limiter.enabled=false', (p) => { p.limiter.enabled = false }],
      ['loudNorm.enabled=false', (p) => { p.loudnessNormalization.enabled = false }],
    ]
    const B = 4800
    const l = sine(B, 500, 0.5, FS)
    const r = sine(B, 500, 0.35, FS)
    for (const [name, fn] of cases) {
      const p = allOffParams()
      fn(p)
      const e = new EngineV3(FS, 2)
      e.setParams(p)
      const l0 = l.slice()
      const r0 = r.slice()
      const { outL, outR } = runChain(e, l, r)
      let maxD = 0
      for (let i = 0; i < B; i++) maxD = Math.max(maxD, Math.abs(outL[i] - l0[i]), Math.abs(outR[i] - r0[i]))
      expect(maxD, name).toBeLessThan(1e-9)
    }
  })

  it('混响 mode=off 完全直通（修复：enabled=true 但 mode=off 不再走算法混响）', () => {
    const p = allOffParams()
    p.reverb.enabled = true
    p.reverb.mode = 'off'
    const e = new EngineV3(FS, 2)
    e.setParams(p)
    const B = 4800
    const l = sine(B, 440, 0.5, FS)
    const r = sine(B, 440, 0.5, FS)
    const l0 = l.slice()
    const { outL } = runChain(e, l, r)
    let maxD = 0
    for (let i = 0; i < B; i++) maxD = Math.max(maxD, Math.abs(outL[i] - l0[i]))
    expect(maxD).toBeLessThan(1e-9)
  })

  it('eq.enabled=false：用户 EQ 不泄漏（修复，+12dB 曲线被旁路）', () => {
    const p = allOffParams()
    p.eq.enabled = false
    p.eq.proBands = [{ frequency: 1000, gain: 12, q: 1 }] // 用户 EQ 有 +12dB
    const e = new EngineV3(FS, 2)
    e.setParams(p)
    const B = 4800
    const l = sine(B, 1000, 0.4, FS)
    const r = sine(B, 1000, 0.4, FS)
    const l0 = l.slice()
    const { outL } = runChain(e, l, r)
    let maxD = 0
    for (let i = B / 2; i < B; i++) maxD = Math.max(maxD, Math.abs(outL[i] - l0[i]))
    expect(maxD).toBeLessThan(1e-9)
  })

  it('pitch.enabled=false 时 voiceBalance 不生效（修复：M/S 级 vb 被门控）', () => {
    const p = allOffParams()
    p.pitch.enabled = false
    p.pitch.voiceBalance = 1 // 若生效会去除侧信号
    const e = new EngineV3(FS, 2)
    e.setParams(p)
    const B = 4800
    const l = sine(B, 440, 0.5, FS)
    const r = sine(B, 440, 0.25, FS)
    const l0 = l.slice()
    const r0 = r.slice()
    const { outL, outR } = runChain(e, l, r)
    let maxD = 0
    for (let i = 0; i < B; i++) maxD = Math.max(maxD, Math.abs(outL[i] - l0[i]), Math.abs(outR[i] - r0[i]))
    expect(maxD).toBeLessThan(1e-9)
  })
})

describe('③ 零值参数直通（enabled=true 但语义应为直通）', () => {
  it('mix=0 / gain=0 / width=1 / strength=0 / volumePercent=100 / amount=0 / wet=0 / ratio=1 / extGain=0 全部直通（≤1e-8）', () => {
    const cases: Array<[string, (p: V3EngineParams) => void]> = [
      ['bass mix=0', (p) => { p.bassEnhancer.enabled = true; p.bassEnhancer.mix = 0; p.bassEnhancer.harmonicGain = 1; p.bassEnhancer.levelDb = 6 }],
      ['bass harmonicGain=0', (p) => { p.bassEnhancer.enabled = true; p.bassEnhancer.harmonicGain = 0; p.bassEnhancer.mix = 1 }],
      ['loudComp auto vol=100', (p) => { p.loudnessCompensation.enabled = true; p.loudnessCompensation.mode = 'auto'; p.loudnessCompensation.volumePercent = 100; p.loudnessCompensation.maxBoostDb = 12 }],
      ['loudComp preset=flat', (p) => { p.loudnessCompensation.enabled = true; p.loudnessCompensation.mode = 'preset'; p.loudnessCompensation.preset = 'flat' }],
      ['ieq strength=0', (p) => { p.ieq.enabled = true; p.ieq.strength = 0; p.ieq.targetCurve = 'bright'; p.ieq.timeConstantSec = 0.1 }],
      ['surround3d 直通参数', (p) => { p.surround3d.enabled = true; p.surround3d.distance = 1; p.surround3d.angle = 0; p.surround3d.speed = 0 }],
      ['M/S width=1 vb=0', (p) => { p.stereoWidth = 1; p.pitch.voiceBalance = 0 }],
      ['loudNorm extGain=0', (p) => { p.loudnessNormalization.enabled = true; p.loudnessNormalization.useRealtimeMeter = false; p.loudnessNormalization.externalGainDb = 0 }],
    ]
    const B = 4800
    const l = sine(B, 800, 0.4, FS)
    const r = sine(B, 800, 0.3, FS)
    for (const [name, fn] of cases) {
      const p = allOffParams()
      fn(p)
      const e = new EngineV3(FS, 2)
      e.setParams(p)
      const l0 = l.slice()
      const r0 = r.slice()
      const { outL, outR } = runChain(e, l, r)
      let maxD = 0
      for (let i = 0; i < B; i++) maxD = Math.max(maxD, Math.abs(outL[i] - l0[i]), Math.abs(outR[i] - r0[i]))
      expect(maxD, name).toBeLessThan(1e-8)
    }
  })
})

describe('⑤ 尾块/自激检查（输入停止后有界、衰减、非自激）', () => {
  it('引擎默认链：长时间零输入无自激/DC 泄漏（<1e-9）', () => {
    const e = new EngineV3(FS, 2)
    e.setParams(createDefaultParams(FS))
    const B = 480
    const sig = sine(B, 440, 0.7, FS)
    const z = zeros(B)
    const out = new Float32Array(B)
    for (let b = 0; b < 100; b++) e.process([sig, sig], [out, out])
    // 零输入：允许限幅器 lookahead（240 样本）窗口内残余，随后必须静音
    e.process([z, z], [out, out])
    for (let i = 240; i < B; i++) expect(Math.abs(out[i])).toBeLessThan(1e-6)
    let latePeak = 0
    for (let b = 0; b < 60; b++) {
      e.process([z, z], [out, out])
      for (let i = 0; i < B; i++) latePeak = Math.max(latePeak, Math.abs(out[i]))
    }
    expect(latePeak).toBeLessThan(1e-9)
  })

  it('引擎算法混响：输入停止后尾块有界且继续衰减（无自激）', () => {
    const p = createDefaultParams(FS)
    p.reverb.enabled = true
    p.reverb.mode = 'algorithmic'
    p.reverb.algorithmic.type = 'hall'
    p.reverb.algorithmic.roomSize = 0.5
    p.reverb.algorithmic.damping = 0.5
    p.reverb.algorithmic.wet = 0.3
    p.reverb.algorithmic.dry = 0.7
    const e = new EngineV3(FS, 2)
    e.setParams(p)
    const B = 480
    const sig = sine(B, 440, 0.7, FS)
    const z = zeros(B)
    const out = new Float32Array(B)
    for (let b = 0; b < 50; b++) e.process([sig, sig], [out, out])
    // 停止输入后：尾能量应单调下降（1s 内明显衰减，无增长）
    const tails: number[] = []
    for (let b = 0; b < 100; b++) {
      e.process([z, z], [out, out])
      if (b % 10 === 0) {
        let peak = 0
        for (let i = 0; i < B; i++) peak = Math.max(peak, Math.abs(out[i]))
        tails.push(peak)
      }
    }
    // 停输入瞬间 Freeverb 内部延迟线（~30-45ms）仍含 wet 内容（≈输入电平），
    // 只要求有界且随后单调衰减到 <1e-3（无自激）
    expect(tails[0]).toBeLessThan(1.0)
    expect(tails[tails.length - 1]).toBeLessThan(tails[0] * 0.5) // 2s 后至少再衰减一半
    expect(tails[tails.length - 1]).toBeLessThan(1e-3)
  })

  it('卷积混响（引擎级）：128 样本块长流无 NaN（修复 H-1）', () => {
    const p = createDefaultParams(FS)
    p.reverb.enabled = true
    p.reverb.mode = 'convolution'
    const M = Math.round(0.3 * FS)
    const ir = new Float32Array(M)
    for (let i = 0; i < M; i++) ir[i] = Math.exp(-i / (0.1 * FS))
    p.reverb.convolution.ir = ir
    p.reverb.convolution.mix = 0.3
    const e = new EngineV3(FS, 2)
    e.setParams(p)
    const B = 128 // AudioWorklet 典型块长
    const l = sine(B, 220, 0.5, FS)
    const r = zeros(B)
    const out = new Float32Array(B)
    let peak = 0
    for (let b = 0; b < 600; b++) {
      e.process([l, r], [out, out])
      for (let i = 0; i < B; i++) {
        expect(Number.isFinite(out[i])).toBe(true)
        peak = Math.max(peak, Math.abs(out[i]))
      }
    }
    expect(peak).toBeLessThan(3)
  })
})

describe('⑥ 场景与组合链路', () => {
  it('全部 11 个场景：128 样本块长跑 2s 无 NaN、输出有界（≤3）', () => {
    // WaveForge 侧 vitest 4 对同步长测试也强制默认 5s 超时（本机实测 ~8s），显式放宽
    const B = 128
    const l = sine(B, 330, 0.5, FS)
    const r = zeros(B)
    for (const sc of SCENE_PRESETS) {
      const e = new EngineV3(FS, 2)
      e.setParams(sc.params)
      const out = new Float32Array(B)
      let peak = 0
      for (let b = 0; b < 750; b++) {
        e.process([l, r], [out, out])
        for (let i = 0; i < B; i++) {
          expect(Number.isFinite(out[i]), sc.id).toBe(true)
          peak = Math.max(peak, Math.abs(out[i]))
        }
      }
      expect(peak, sc.id).toBeLessThan(3)
    }
  }, 30_000)

  it('场景 A→B→A 热切换无 NaN、无爆音（边界跳变 << 稳态）', () => {
    const e = new EngineV3(FS, 2)
    const B = 128
    const l = sine(B, 440, 0.4, FS)
    const r = zeros(B)
    const out = new Float32Array(B)
    let prev = 0
    let maxJump = 0
    for (let round = 0; round < 3; round++) {
      for (const sc of SCENE_PRESETS) {
        e.setParams(sc.params)
        e.process([l, r], [out, out])
        for (let i = 0; i < B; i++) {
          expect(Number.isFinite(out[i])).toBe(true)
          maxJump = Math.max(maxJump, Math.abs(out[i] - prev))
          prev = out[i]
        }
      }
    }
    expect(maxJump).toBeLessThan(1.0)
  })
})

describe('⑦ 响度归一化：启动不膨胀', () => {
  it('实时表无测量期：增益不按 +maxGainDb 提升（修复），输出 ≤ 输入幅度', () => {
    const p = createDefaultParams(FS)
    p.loudnessNormalization.enabled = true
    p.loudnessNormalization.useRealtimeMeter = true
    p.loudnessNormalization.targetLufs = -14
    p.loudnessNormalization.maxGainDb = 9
    const e = new EngineV3(FS, 2)
    e.setParams(p)
    const B = 480
    const l = sine(B, 440, 0.5, FS)
    const r = zeros(B)
    const out = new Float32Array(B)
    let peak = 0
    for (let b = 0; b < 10; b++) {
      e.process([l, r], [out, out])
      for (let i = 0; i < B; i++) peak = Math.max(peak, Math.abs(out[i]))
    }
    // 无测量期增益 = 0dB：输出 ≤ 输入峰值 + 平滑过渡余量
    expect(peak).toBeLessThan(0.52)
  })

  it('外部增益模式热切换平滑（修复）：不再瞬时阶跃', () => {
    const p = createDefaultParams(FS)
    p.loudnessNormalization.enabled = true
    p.loudnessNormalization.useRealtimeMeter = false
    p.loudnessNormalization.externalGainDb = 0
    const e = new EngineV3(FS, 2)
    e.setParams(p)
    const B = 480
    const l = sine(B, 440, 0.5, FS)
    const r = zeros(B)
    const out = new Float32Array(B)
    e.process([l, r], [out, out]) // 增益 0dB
    // 突变 externalGainDb = 6dB：下一块输出不应瞬间 +6dB（有平滑）
    p.loudnessNormalization.externalGainDb = 6
    e.setParams(p)
    e.process([l, r], [out, out])
    let peak1 = 0
    for (let i = 0; i < B; i++) peak1 = Math.max(peak1, Math.abs(out[i]))
    // 第一块只走部分增益（80ms 快平滑 → 单块 480 样本 ≈ 11.7% 步进，仍非瞬时阶跃）
    expect(peak1).toBeLessThan(0.6)
  })
})