import { describe, expect, it } from 'vitest'
import { EffectTransition } from '../src/dsp/EffectTransition'
import { SampleRamp } from '../src/dsp/SampleRamp'
import { Convolver } from '../src/dsp/Convolver'
import { Limiter } from '../src/dsp/Limiter'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams, type V3EngineParams } from '../src/types'

const fs = 48000
const clone = <T>(value: T): T => structuredClone(value)
function signal(length: number, offset = 0) {
  return Float32Array.from({ length }, (_, i) => 0.15 * Math.sin((i + offset) * 0.131) + 0.05 * Math.cos((i + offset) * 0.017))
}
function feed(engine: EngineV3, frames: number, offset = 0) {
  const input = signal(frames, offset)
  const left = new Float32Array(frames), right = new Float32Array(frames)
  engine.process([input, Float32Array.from(input, x => -x * 0.6)], [left, right])
  return [left, right]
}

describe('通用效果参数过渡', () => {
  it('首样本沿用旧输出，零湿声提交新配置，20ms 后达到新效果', () => {
    const gate = new EffectTransition(fs)
    let gain = 0.2, commits = 0
    const render = (l: Float32Array | Float64Array, r: Float32Array | Float64Array) => {
      for (let i = 0; i < l.length; i++) { l[i] *= gain; r[i] *= gain }
    }
    gate.configure(true, () => {})
    gate.process(new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5), render)
    gate.configure(true, () => { gain = 0.8; commits++ })
    const output: number[] = []
    for (let offset = 0; offset < 1152; offset += 128) {
      const l = new Float32Array(128).fill(0.5), r = l.slice()
      gate.process(l, r, render); output.push(...l)
    }
    expect(output[0]).toBeCloseTo(0.1, 6)
    expect(output[480]).toBeCloseTo(0.5, 6)
    expect(output[960]).toBeCloseTo(0.4, 6)
    expect(commits).toBe(1)
    expect(Math.max(...output.slice(1).map((v, i) => Math.abs(v - output[i])))).toBeLessThan(0.001)
  })

  it('快速重定向只提交最新目标，不重启退场；任意分块保持逐样本一致', () => {
    const run = (chunks: number[]) => {
      const gate = new EffectTransition(fs)
      let gain = 0.2
      const applied: number[] = []
      const render = (l: Float32Array | Float64Array, r: Float32Array | Float64Array) => {
        for (let i = 0; i < l.length; i++) { l[i] *= gain; r[i] *= gain }
      }
      gate.configure(true, () => {})
      gate.process(new Float32Array(1), new Float32Array(1), render)
      const output = new Float32Array(1536)
      let offset = 0, next = 0
      for (const end of [128, 256, 384, 1536]) {
        gate.configure(true, () => { gain = end / 2000; applied.push(end) })
        while (offset < end) {
          const count = Math.min(chunks[next++ % chunks.length], end - offset)
          const l = new Float32Array(count).fill(0.5), r = l.slice()
          gate.process(l, r, render); output.set(l, offset); offset += count
        }
      }
      return { output, applied }
    }
    const whole = run([128]), split = run([1, 7, 19, 64, 127])
    expect(split.output).toEqual(whole.output)
    expect(whole.applied).toEqual([1536])
    expect(whole.output[1535]).toBeCloseTo(0.384, 6)
  })

  it('启停、预热与 reset 均不提交过期配置', () => {
    const gate = new EffectTransition(1000)
    let gain = 0, applied = 0
    const render = (l: Float32Array | Float64Array, r: Float32Array | Float64Array) => { l.fill(gain); r.fill(gain) }
    gate.configure(false, () => {})
    gate.process(new Float32Array(1).fill(1), new Float32Array(1).fill(1), render)
    gate.configure(true, () => { gain = 0.5 }, () => 4)
    const l = new Float32Array(12).fill(1), r = l.slice()
    gate.process(l, r, render)
    expect(Array.from(l.slice(0, 5))).toEqual([1, 1, 1, 1, 1])
    gate.configure(true, () => { gain = 0.1; applied++ })
    gate.configure(false, () => { gain = 0.9; applied += 10 })
    gate.reset()
    const dry = new Float32Array(16).fill(1)
    gate.process(dry, dry.slice(), render)
    expect(applied).toBe(10)
    expect(dry.every(x => x === 1)).toBe(true)
  })

  it('逐样本数值斜坡可从当前值重定向，复位收敛到最新目标', () => {
    const ramp = new SampleRamp(1000, 1)
    expect(ramp.next()).toBe(1)
    ramp.set(0)
    expect(ramp.next()).toBe(1)
    for (let i = 0; i < 9; i++) ramp.next()
    ramp.set(0.8)
    expect(ramp.next()).toBeCloseTo(0.5, 12)
    ramp.reset()
    expect(ramp.next()).toBe(0.8)
  })
})

type Case = [string, (params: V3EngineParams) => void, (params: V3EngineParams) => void]
const cases: Case[] = [
  ['PEQ 频率/Q/增益/类型/段数/补偿', p => { p.eq.enabled = true; p.eq.qCompensation = false; p.eq.proBands[3].gain = 9 }, p => {
    p.eq.bandCount = 1; p.eq.proBands = [{ frequency: 2000, gain: -12, q: 2, type: 'highpass' }]; p.eq.qCompensation = true
  }],
  ['动态均衡全部标量及多段拓扑', p => { p.dynamicEq!.enabled = true; p.dynamicEq!.thresholdDb = -60 }, p => {
    Object.assign(p.dynamicEq!, { frequency: 3000, q: 3, thresholdDb: -50, ratio: 9, maxReductionDb: 20, attackMs: 1, releaseMs: 20 })
    p.dynamicEq!.bands = [clone(p.dynamicEq!), { ...clone(p.dynamicEq!), frequency: 5000 }]
  }],
  ['齿音频率/Q/阈值/比率/时间/分带/混合', p => { p.deesser.enabled = true; p.deesser.thresholdDb = -60 }, p => {
    Object.assign(p.deesser, { centerHz: 2000, q: 3, thresholdDb: -40, ratio: 20, attackMs: 2, releaseMs: 20, splitBand: false, mix: 0.4 })
  }],
  ['压缩全部标量与向上模式', p => { p.compressor.enabled = true; p.compressor.thresholdDb = -50 }, p => {
    Object.assign(p.compressor, { thresholdDb: -30, ratio: 10, kneeDb: 12, attackMs: 1, releaseMs: 30, makeupDb: -4,
      outputGain: 0.5, mode: 'upward', upwardMaxGainDb: 12, transientPreserve: 1 })
  }],
  ['多段压缩交叉频率/各段参数/模式', p => { p.compressor.enabled = true; p.compressor.mode = 'multiband' }, p => {
    p.compressor.multiband!.lowMidHz = 400; p.compressor.multiband!.midHighHz = 2500
    for (const band of ['low', 'mid', 'high'] as const) Object.assign(p.compressor.multiband![band], {
      thresholdDb: -45, ratio: 8, kneeDb: 2, attackMs: 1, releaseMs: 50, makeupDb: -3,
    })
    p.compressor.outputGain = 0.4; p.compressor.makeupDb = -2
  }],
  ['压缩单段/多段切换', p => { p.compressor.enabled = true; p.compressor.thresholdDb = -50 }, p => { p.compressor.mode = 'multiband' }],
  ['夜间强度', p => { p.nightMode.enabled = true; p.nightMode.amount = 9 }, p => { p.nightMode.amount = 2 }],
  ['低音全部参数/非线性类型', p => { p.bassEnhancer.enabled = true; p.bassEnhancer.lowBoostDb = 8 }, p => {
    Object.assign(p.bassEnhancer, { cutoffHz: 250, q: 2, harmonicType: 'even', harmonicGain: 1, mix: 1, levelDb: -5, lowBoostDb: -6 })
  }],
  ['算法混响全部参数', p => { p.reverb.enabled = true }, p => {
    Object.assign(p.reverb.algorithmic, { type: 'spring', roomSize: 0.8, damping: 0.9, wet: 0.8, dry: 0.2, preDelayMs: 12, width: 0.2 })
  }],
  ['卷积 IR/分区/用途/去周期化/混合/预延迟', p => {
    p.reverb.enabled = true; p.reverb.mode = 'convolution'; p.reverb.convolution.ir = new Float32Array([1, 0.4]); p.reverb.convolution.dePeriodize = false
  }, p => { Object.assign(p.reverb.convolution, { ir: new Float32Array([0.2, 0.8]), partitionSize: 128,
    purpose: 'roomCorrection', dePeriodize: true, mix: 0.9, preDelayMs: 2 }) }],
  ['算法/卷积模式切换', p => { p.reverb.enabled = true }, p => { p.reverb.mode = 'convolution'; p.reverb.convolution.ir = new Float32Array([1]) }],
  ['等响度模式/曲线/频率/时间/音量', p => { p.loudnessCompensation.enabled = true }, p => {
    Object.assign(p.loudnessCompensation, { mode: 'custom', preset: 'bright', bands: [{ frequency: 3000, gain: -10 }],
      smoothingSeconds: 0.01, volumePercent: 10, maxBoostDb: 20 })
  }],
  ['IEQ 强度/目标曲线/时间', p => { p.ieq.enabled = true }, p => { Object.assign(p.ieq, { strength: 1, targetCurve: 'bright', timeConstantSec: 0.1 }) }],
  ['Crossfeed 全部参数', p => { p.crossfeed!.enabled = true }, p => { Object.assign(p.crossfeed!, { amount: 1, cutoffHz: 2500, delayMs: 1 }) }],
  ['环绕距离/速度/角度/方向', p => { p.surround3d.enabled = true }, p => { Object.assign(p.surround3d, { distance: 1, speed: 4, angle: 140, direction: -1 }) }],
  ['M/S 宽度/人声比例/低频截止及量', p => { p.stereoWidth = 0.2; p.pitch.enabled = true; p.pitch.voiceBalance = 0.5 }, p => {
    p.stereoWidth = 2; p.pitch.voiceBalance = -1; p.lowMonoAmount = 1; p.lowMonoCutoffHz = 220
  }],
  ['次声高通截止', p => { p.subsonicEnabled = true }, p => { p.subsonicCutoffHz = 40 }],
  ['空间模式/房间/输入布局/插值/距离模型/声源参数', p => { p.spatial!.mode = 'instant'; p.spatial!.instant.room = 'hall' }, p => {
    p.spatial!.mode = 'headLocked'; p.spatial!.headLocked.layout = '714'; p.spatial!.masterGain = 0.5
    p.spatial!.instant.amount = 1; p.spatial!.instant.room = 'studio'; p.spatial!.instant.roomAmount = 0.9
    p.spatial!.hrtfInterp = 'spherical'; p.spatial!.distanceModel = 'linear'; p.spatial!.refDistance = 2; p.spatial!.maxDistance = 10
    p.spatial!.convolution = 'time'; p.spatial!.budgetMode = 'lowLatency'
  }],
]

describe('EngineV3 所有效果实时改参边界', () => {
  it.each(['algorithmic', 'convolution'] as const)('%s 重新启用不回放停用前冻结的尾音', mode => {
    const p = createDefaultParams(fs); p.eq.enabled = false; p.limiter.enabled = false
    p.reverb.enabled = true; p.reverb.mode = mode
    p.reverb.algorithmic.wet = 1; p.reverb.algorithmic.dry = 0
    const ir = new Float32Array(4096); ir[0] = 1; ir[2000] = 0.5
    p.reverb.convolution.ir = ir; p.reverb.convolution.dePeriodize = false; p.reverb.convolution.mix = 1
    const engine = new EngineV3(fs); engine.setParams(p); feed(engine, 8192)
    const off = clone(p); off.reverb.enabled = false; engine.setParams(off)
    const silent = (frames: number) => {
      const l = new Float32Array(frames), r = new Float32Array(frames)
      engine.process([new Float32Array(frames), new Float32Array(frames)], [l, r])
      return [l, r]
    }
    silent(2048)
    // 保留同一 IR 引用以验证复用的卷积实例，而不是靠换 IR 间接清空历史。
    engine.setParams({ ...off, reverb: { ...off.reverb, enabled: true } })
    const output = silent(8192)
    expect(output.every(channel => channel.every(value => value === 0))).toBe(true)
  })

  it.each(cases)('%s：首样本连续、完成过渡后有限，reset 提交最新目标', (_name, setup, change) => {
    const params = createDefaultParams(fs); params.eq.enabled = false; params.limiter.enabled = false
    setup(params)
    const changed = clone(params); change(changed)
    const engine = new EngineV3(fs), reference = new EngineV3(fs)
    engine.setParams(params); reference.setParams(params)
    feed(engine, 8192); feed(reference, 8192)
    engine.setParams(changed)
    const actual = feed(engine, 128, 8192), expected = feed(reference, 128, 8192)
    expect(actual[0][0]).toBeCloseTo(expected[0][0], 6)
    expect(actual[1][0]).toBeCloseTo(expected[1][0], 6)
    const tail = feed(engine, 4096, 8320)
    expect(tail.every(channel => channel.every(Number.isFinite))).toBe(true)
    engine.reset()
    const restart = feed(engine, 2048)
    expect(restart.every(channel => channel.every(Number.isFinite))).toBe(true)
  })

  it.each(['eq', 'dynamicEq', 'deesser', 'compressor', 'nightMode', 'reverb', 'bassEnhancer',
    'loudnessCompensation', 'ieq', 'crossfeed', 'surround3d'] as const)('%s 启停不硬切', key => {
    const p = createDefaultParams(fs); p.eq.enabled = false; p.limiter.enabled = false
    p[key]!.enabled = true
    if (key === 'nightMode') p.nightMode.amount = 10
    if (key === 'eq') p.eq.proBands[3].gain = -18
    if (key === 'compressor') p.compressor.outputGain = 0.2
    const engine = new EngineV3(fs), reference = new EngineV3(fs)
    engine.setParams(p); reference.setParams(p); feed(engine, 8192); feed(reference, 8192)
    const off = clone(p); off[key]!.enabled = false
    engine.setParams(off)
    const actual = feed(engine, 128, 8192), expected = feed(reference, 128, 8192)
    expect(actual[0][0]).toBeCloseTo(expected[0][0], 6)
    const dry = feed(engine, 4096, 8320)
    expect(dry[0][4095]).toBe(signal(1, 8320 + 4095)[0])
    engine.setParams(p)
    const on = feed(engine, 128, 12416)
    expect(on[0][0]).toBe(signal(1, 12416)[0])
  })
})

describe('最终限幅器参数连续性', () => {
  it('前瞻读点移动保留常量音频历史，阈值与开关逐样本渐变', () => {
    const limiter = new Limiter(fs)
    const p = { enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true }
    limiter.setParams(p)
    const run = (frames: number) => {
      const l = new Float32Array(frames).fill(0.2), r = l.slice()
      limiter.processStereo(l, r); return l
    }
    run(8192)
    limiter.setParams({ ...p, lookaheadMs: 20 })
    const moving = run(2048)
    expect(moving.every(x => Math.abs(x - 0.2) < 1e-6)).toBe(true)
    limiter.setParams({ ...p, lookaheadMs: 20, thresholdDb: -24 })
    const lower = run(2048)
    expect(lower[0]).toBeCloseTo(0.2, 6)
    expect(Math.max(...lower.slice(1).map((x, i) => Math.abs(x - lower[i])))).toBeLessThan(0.002)
    expect(lower[2047]).toBeLessThanOrEqual(Math.pow(10, -24 / 20) + 1e-6)
    limiter.setParams({ ...p, enabled: false, thresholdDb: -24, lookaheadMs: 20 })
    const off = run(2048)
    expect(off[0]).toBeCloseTo(lower[2047], 6)
    expect(off[2047]).toBeCloseTo(0.2, 6)
  })
})


describe('附加平滑链路回归', () => {
  it('关闭响度归一化、改变 ReplayGain 与声道校准均连续回到目标', () => {
    const p = createDefaultParams(fs); p.eq.enabled = false; p.limiter.enabled = false
    p.loudnessNormalization = { ...p.loudnessNormalization, enabled: true, useRealtimeMeter: false,
      externalGainDb: -12, minGainDb: -60, replayGainMode: 'track', replayGainDb: -6 }
    p.channelCalibration = { enabled: true, leftDb: -6, rightDb: 3 }
    const engine = new EngineV3(fs)
    engine.setParams(p)
    const render = (frames: number) => {
      const l = new Float32Array(frames), r = l.slice()
      engine.process([new Float32Array(frames).fill(0.1), new Float32Array(frames).fill(0.1)], [l, r])
      return [l, r]
    }
    const old = render(fs)
    const next = clone(p); next.loudnessNormalization.enabled = false; next.channelCalibration!.enabled = false
    engine.setParams(next)
    const changed = render(fs)
    expect(Math.abs(changed[0][0] - old[0][fs - 1])).toBeLessThan(0.0001)
    expect(changed[0][fs - 1]).toBeCloseTo(0.1, 6)
    expect(changed[1][fs - 1]).toBeCloseTo(0.1, 6)
  })

  it('卷积混合与预延迟逐样本渐变，常量历史在移动读点时不会断音', () => {
    const c = new Convolver(fs, { partitionSize: 128, dePeriodize: false })
    c.loadIR(new Float32Array([0.5])); c.setMix(1)
    const run = (count: number) => {
      const l = new Float32Array(count).fill(0.2), r = l.slice()
      c.processStereo(l, r); return l
    }
    run(8192)
    c.setPreDelayMs(20)
    expect(run(2048).every(x => Math.abs(x - 0.1) < 1e-6)).toBe(true)
    c.setMix(0)
    const out = run(2048)
    expect(out[0]).toBeCloseTo(0.1, 6)
    expect(out[2047]).toBeCloseTo(0.2, 6)
    expect(Math.max(...out.slice(1).map((x, i) => Math.abs(x - out[i])))).toBeLessThan(0.0002)
  })

  it.each(['float32', 'float64'] as const)('%s 整引擎过渡不随任意块长改变结果', precision => {
    const run = (sizes: number[]) => {
      const p = createDefaultParams(fs); p.precision = precision; p.eq.enabled = false; p.limiter.enabled = false
      p.compressor.enabled = true; p.bassEnhancer.enabled = true; p.spatial!.mode = 'instant'; p.spatial!.instant.room = 'off'
      const engine = new EngineV3(fs); engine.setParams(p); feed(engine, 8192)
      const next = clone(p); next.compressor.outputGain = 0.2; next.bassEnhancer.harmonicType = 'even'
      next.stereoWidth = 2; next.spatial!.mode = 'headLocked'; next.spatial!.headLocked.layout = '51'
      engine.setParams(next)
      const input = signal(3072, 8192), right = Float32Array.from(input, x => -x * 0.6)
      const l = new Float32Array(input.length), r = l.slice()
      let offset = 0, index = 0
      while (offset < input.length) {
        const n = Math.min(sizes[index++ % sizes.length], input.length - offset)
        engine.process([input.subarray(offset, offset + n), right.subarray(offset, offset + n)],
          [l.subarray(offset, offset + n), r.subarray(offset, offset + n)])
        offset += n
      }
      return [l, r]
    }
    const whole = run([128]), split = run([1, 3, 17, 65, 127])
    for (let channel = 0; channel < 2; channel++) {
      let error = 0
      for (let i = 0; i < whole[channel].length; i++) error = Math.max(error, Math.abs(whole[channel][i] - split[channel][i]))
      expect(error).toBeLessThan(1e-6)
    }
  })

  it('短于过渡周期的连续组合改参仍有限，最终限幅保护不被通用旁路过渡绕开', () => {
    const engine = new EngineV3(fs)
    let p = createDefaultParams(fs)
    p.compressor.enabled = p.bassEnhancer.enabled = p.deesser.enabled = true
    engine.setParams(p)
    let offset = 0
    for (let tick = 0; tick < 80; tick++) {
      p = clone(p)
      p.compressor.makeupDb = tick % 2 ? 20 : -10
      p.compressor.mode = tick % 3 ? 'upward' : 'multiband'
      p.compressor.thresholdDb = -45 + tick % 20
      p.bassEnhancer.harmonicType = tick % 2 ? 'even' : 'atan'
      p.bassEnhancer.lowBoostDb = tick % 2 ? 12 : -6
      p.deesser.centerHz = tick % 2 ? 1500 : 7000
      p.stereoWidth = tick % 2 ? 2 : 0
      p.limiter.thresholdDb = tick % 2 ? -20 : -1
      p.limiter.lookaheadMs = tick % 2 ? 8 : 2
      p.limiter.truePeak = tick % 2 === 0
      engine.setParams(p)
      const out = feed(engine, 127, offset); offset += 127
      expect(out.every(ch => ch.every(x => Number.isFinite(x) && Math.abs(x) <= 1))).toBe(true)
    }
    expect(feed(engine, 8192, offset).every(ch => ch.every(x => Number.isFinite(x) && Math.abs(x) <= 1))).toBe(true)
  })
})
