/**
 * Convolver 单元测试（模块 9：均匀分区卷积 + IR 去周期化）
 *
 * 物理意义注记：
 *  - IR=[1]（单位冲激）时卷积应为恒等（输出≈输入），验证分区调度正确性；
 *  - IR=延迟冲激（h[D]=1）时输出应为输入右移 D，验证延迟正确；
 *  - 指数衰减 IR 的湿输出能量应单调衰减（无周期回升/发散）；
 *  - dePeriodize 把尾部被"平底"截断的 IR 强制衰减，消除循环伪影。
 */
import { describe, it, expect } from 'vitest'
import { Convolver } from '../src/dsp/Convolver'

const FS = 48000
const TOL = 1e-3 // 数值容差（卷积 FFT 舍入量级，物理上对应 -60dB 以下误差）

function makeInput(n: number): Float32Array {
  // 确定性的平滑测试信号（斜坡 + 正弦叠加），避免依赖 Math.random
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = 0.02 * i + 0.3 * Math.sin((2 * Math.PI * 440 * i) / FS)
  }
  return x
}

function maxAbsDiff(a: Float32Array, b: Float32Array, offsetB = 0): number {
  let m = 0
  const n = Math.min(a.length, b.length - offsetB)
  for (let i = 0; i < n; i++) {
    const d = Math.abs(a[i] - b[i + offsetB])
    if (d > m) m = d
  }
  return m
}

/** 10ms 窗 RMS 包络（dB），用于能量衰减断言 */
function rmsEnvelopeDb(x: Float32Array, fs: number, winMs = 10): Float32Array {
  const win = Math.max(1, Math.round((winMs / 1000) * fs))
  const nBlocks = Math.floor(x.length / win)
  const env = new Float32Array(nBlocks)
  for (let b = 0; b < nBlocks; b++) {
    let s = 0
    for (let i = b * win; i < (b + 1) * win; i++) s += x[i] * x[i]
    const rms = Math.sqrt(s / win)
    env[b] = rms > 1e-12 ? 20 * Math.log10(rms) : -200
  }
  return env
}

describe('Convolver.process（有限块卷积）', () => {
  it('IR=[1] 时输出≈输入（恒等）', () => {
    const cv = new Convolver(FS, { dePeriodize: true })
    cv.loadIR(new Float32Array([1]), 'unit')
    cv.setMix(1)
    const x = makeInput(2048)
    const y = cv.process(x)
    // 长度 = 输入长度 + IR 尾(0)
    expect(y.length).toBe(x.length)
    expect(maxAbsDiff(y, x)).toBeLessThan(TOL)
  })

  it('IR=延迟冲激 h[D]=1 时输出为输入右移 D', () => {
    const D = 100
    const ir = new Float32Array(D + 1)
    ir[D] = 1
    const cv = new Convolver(FS, { dePeriodize: true })
    cv.loadIR(ir, 'delta100')
    cv.setMix(1)
    const x = makeInput(2048)
    const y = cv.process(x)
    expect(y.length).toBe(x.length + D)
    // 前 D 个样本应为 0（冲激响应尚未开始）
    for (let i = 0; i < D; i++) {
      expect(Math.abs(y[i])).toBeLessThan(TOL)
    }
    // 之后等于输入右移 D：y[i+D] == x[i]（maxAbsDiff(x, y, D) 比较 x[i] 与 y[i+D]）
    expect(maxAbsDiff(x, y, D)).toBeLessThan(TOL)
  })

  it('preDelay 生效：IR=[1] + 10ms 预延迟 → 输出右移 480 样本', () => {
    const cv = new Convolver(FS, { dePeriodize: true })
    cv.loadIR(new Float32Array([1]))
    cv.setMix(1)
    cv.setPreDelayMs(10) // 480 样本 @48k
    const x = makeInput(1024)
    const y = cv.process(x)
    expect(y.length).toBe(x.length + 480)
    for (let i = 0; i < 480; i++) {
      expect(Math.abs(y[i])).toBeLessThan(TOL)
    }
    // y[i+480] == x[i]
    expect(maxAbsDiff(x, y, 480)).toBeLessThan(TOL)
  })

  it('指数衰减 IR 的湿输出能量单调衰减（无周期回升）', () => {
    // IR = exp 衰减（τ=0.15s），长度 1.2s（8 个时间常数 → 69dB，足以支撑 40dB 尾部断言）
    const M = Math.round(1.2 * FS)
    const ir = new Float32Array(M)
    for (let i = 0; i < M; i++) ir[i] = Math.exp(-i / (0.15 * FS))
    const cv = new Convolver(FS, { dePeriodize: false })
    cv.loadIR(ir, 'exp')
    cv.setMix(1)
    // 单样本冲激 → 输出 = IR 本身
    const imp = new Float32Array(1)
    imp[0] = 1
    const y = cv.process(imp)
    const env = rmsEnvelopeDb(y, FS)
    // 找到包络峰值位置后，后续包络应单调不升（允许 ±0.5dB 抖动，无回升）
    let peak = 0
    for (let i = 1; i < env.length; i++) if (env[i] > env[peak]) peak = i
    for (let i = peak + 1; i < env.length - 1; i++) {
      expect(env[i + 1]).toBeLessThanOrEqual(env[i] + 0.5)
    }
    // 尾部应远低于峰值（衰减至少 40dB）
    expect(env[env.length - 1]).toBeLessThan(env[peak] - 40)
  })

  it('dePeriodize 将"平底截断"IR 的尾部强制衰减', () => {
    // IR：指数衰减（τ=0.2s）到 -80dB 以下后保持平底（模拟循环尾）
    const M = Math.round(2.0 * FS)
    const ir = new Float32Array(M)
    const decayTau = 0.2 * FS
    for (let i = 0; i < M; i++) ir[i] = Math.exp(-i / decayTau)
    // 尾部平底：从 1.4s 起钳到 -80dB（1e-4），低于 dePeriodize 的 -60dB 触发阈值，
    // 保证"平底区"真实存在且包络不再高于阈值（否则去周期化不会被触发）
    const floorAmp = 1e-4 // -80dB
    const floorStart = M - Math.round(0.6 * FS) // 1.4s
    for (let i = floorStart; i < M; i++) ir[i] = Math.max(ir[i], floorAmp)

    const withDeP = new Convolver(FS, { dePeriodize: true })
    withDeP.loadIR(new Float32Array(ir), 'flatTail')
    withDeP.setMix(1)
    const noDeP = new Convolver(FS, { dePeriodize: false })
    noDeP.loadIR(new Float32Array(ir), 'flatTail')
    noDeP.setMix(1)
    const imp = new Float32Array(1)
    imp[0] = 1
    const yDep = withDeP.process(imp)
    const yNoDep = noDeP.process(imp)

    const envDep = rmsEnvelopeDb(yDep, FS)
    const envNoDep = rmsEnvelopeDb(yNoDep, FS)
    // 末段（平底区）相对能量：dePeriodize 后应继续衰减（≥6dB），
    // 未 dePeriodize 时平底保持（同区段内几乎不变）
    const n = envDep.length
    const lateDep = envDep[n - 4]
    const midDep = envDep[Math.floor(n * 0.55)]
    expect(lateDep).toBeLessThan(midDep - 6)
    // noDeP：取两个都落在真实平底区的块比较，应几乎不变。
    // 注意：natural 衰减 τ=0.2s 要到 exp(-i/τ)<1e-4 即 i>1.84s 才真正触底，
    // 因此平底区包络索引 ≥ 185（floorStart=1.4s 处 natural 仍有 -62dB，不能作平底基准）
    const lateNoDep = envNoDep[n - 4] // 1.96s
    const floorNoDep = envNoDep[190] // 1.90s
    expect(Math.abs(lateNoDep - floorNoDep)).toBeLessThan(3)
  })

  it('loadIR 对空/全零 IR 抛错', () => {
    const cv = new Convolver(FS)
    expect(() => cv.loadIR(new Float32Array(0))).toThrow()
    expect(() => cv.loadIR(new Float32Array(512))).toThrow() // 全零
  })
})

describe('Convolver.processStereo（流式 + 干湿混合）', () => {
  it('mix=0 时输出=输入（干路恒等）', () => {
    const cv = new Convolver(FS, { partitionSize: 512 })
    cv.loadIR(new Float32Array([1]))
    cv.setMix(0)
    const N = 2000
    const l = new Float32Array(N)
    const r = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      l[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / FS)
      r[i] = 0.3 * Math.sin((2 * Math.PI * 700 * i) / FS)
    }
    const l0 = new Float32Array(l)
    const r0 = new Float32Array(r)
    // 按 128 样本块流式处理
    for (let off = 0; off < N; off += 128) {
      cv.processStereo(l.subarray(off, off + 128), r.subarray(off, off + 128))
    }
    expect(maxAbsDiff(l, l0)).toBeLessThan(TOL)
    expect(maxAbsDiff(r, r0)).toBeLessThan(TOL)
  })

  it('IR=[1]、mix=1 时湿路输出 = 输入延迟一个分区长', () => {
    const L = 512
    const cv = new Convolver(FS, { partitionSize: L, dePeriodize: true })
    cv.loadIR(new Float32Array([1]))
    cv.setMix(1)
    const N = 4096
    // 多喂 L 个样本（尾部补零），使最后一块的湿输出也被放行——
    // 流式分区卷积的湿路"尾块"需后续输入才可输出（block 粒度，天然尾部缓冲）
    const TOTAL = N + L
    const l = new Float32Array(TOTAL)
    const r = new Float32Array(TOTAL)
    for (let i = 0; i < N; i++) {
      const v = Math.sin((2 * Math.PI * 220 * i) / FS)
      l[i] = v
      r[i] = 0.5 * v
    }
    const l0 = new Float32Array(l)
    for (let off = 0; off < TOTAL; off += 128) {
      cv.processStereo(l.subarray(off, off + 128), r.subarray(off, off + 128))
    }
    // 湿路延迟 = 分区长 L；对齐后输出 ≈ 输入（±1e-3）
    expect(cv.getLatencySamples()).toBe(L)
    let maxDiff = 0
    for (let i = L; i < N; i++) {
      const d = Math.abs(l[i] - l0[i - L])
      if (d > maxDiff) maxDiff = d
    }
    expect(maxDiff).toBeLessThan(TOL)
    // 前 L 个样本应为 0（湿路尚未输出）
    for (let i = 0; i < L; i++) {
      expect(Math.abs(l[i])).toBeLessThan(TOL)
    }
  })
})
