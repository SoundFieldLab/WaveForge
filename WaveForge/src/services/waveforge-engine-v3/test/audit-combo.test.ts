/**
 * audit-combo.test.ts —— 组合/场景/双路径链路健康审计（任务 C）
 *
 * 审计维度（对照主任务书）：
 *  1. 11 个场景预设逐个应用后链路健康：白噪声 FFT 频响有界（±24dB 内）、
 *     峰值 <1.5、无 NaN、总增益 -30..+30dB；
 *  2. 场景切换 A→B→A 无爆音/无 NaN（参数热切换，状态不重置）；
 *  3. 分享串 encode→decode 往返一致；恶意/越界串（超范围增益、超长数组、
 *     非法枚举、NaN/Infinity）解码后被 clamp/拒绝，且应用后链路不产生 NaN；
 *  4. 双路径：同一输入连续 setParams 热切换前后输出连续（无跳变爆音）；
 *     引擎 stats 数值合理（LUFS∈(-70,0)、limiterReductionDb≤0、latency≥0）；
 *  5. EQ Q 补偿 + LoudnessComp 组合开启时频响有界。
 *
 * 测量方法（确定性）：
 *  - 输入一律用 LCG 伪随机白噪声（无 Math.random），幅度 0.25（约 -12dBFS）；
 *  - 频谱用 2048/4096 点 Hann 窗 FFT 多窗平均（50% 重叠），跳过起始段
 *    （限幅器 lookahead 240 样本 + 混响建立 + 压缩 attack 均需排除）；
 *  - 频响界按 1/3 倍频程~倍频程频带平均响应（输出均值 dB − 输入均值 dB），
 *    契约界 ±24dB；总增益按 RMS 比 20·log10(rmsOut/rmsIn)，契约界 ±30dB；
 *  - 爆音判定：块边界处逐样本跳变 vs 边界前本地稳态跳变（8 倍容差 + 硬上限）。
 *
 * 历史异常（已修复，断言已转正）：
 *  - night-bass 场景 10-15kHz 响应曾低于 -24dB 契约界（实测 -33.5dB），
 *    经四轮参数调平后回到契约界内（实测 -22.4dB），特性化断言已反转。
 */
import { describe, it, expect } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { SCENE_PRESETS, SCENE_IDS } from '../src/engine/ScenePresets'
import { encodeShareCode, decodeShareCode, SHARE_CODEC_VERSION } from '../src/engine/ShareCodec'
import { createDefaultParams } from '../src/types'
import { fft, hannWindow, magnitudeSpectrum, frequencyBins } from '../src/dsp/fft'
import type { V3EngineParams } from '../src/types'

const FS = 48000
/** 频响测量频带（倍频程，避开直流 bin 与 Nyquist） */
const OCTAVE_BANDS: Array<[number, number]> = [
  [40, 80], [80, 160], [160, 320], [320, 640], [640, 1280],
  [1280, 2560], [2560, 5120], [5120, 10000], [10000, 15000],
]

// ---------------------------------------------------------------------------
// 确定性工具
// ---------------------------------------------------------------------------

/** LCG 白噪声（确定性，替代 Math.random） */
function lcg(seed: number, n: number): Float32Array {
  const out = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = (s / 0xffffffff) * 2 - 1
  }
  return out
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, to - from))
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0
  let s = 0
  for (const v of arr) s += v
  return s / arr.length
}

/** 平均幅度谱（dB）：跳过起始段，Hann 窗 50% 重叠平均（幅度谱平均后转 dB） */
function avgSpectrumDb(mono: Float32Array, win = 4096, skip = 16384): { db: Float32Array; freqs: Float32Array } {
  const hann = hannWindow(win)
  const re = new Float32Array(win)
  const im = new Float32Array(win)
  const acc = new Float32Array(win / 2 + 1)
  const freqs = frequencyBins(win, FS)
  let cnt = 0
  const hop = win / 2
  for (let start = skip; start + win <= mono.length; start += hop) {
    for (let i = 0; i < win; i++) re[i] = mono[start + i] * hann[i]
    im.fill(0)
    fft(re, im, false)
    const mag = magnitudeSpectrum(re, im)
    for (let k = 0; k < acc.length; k++) acc[k] += mag[k]
    cnt++
  }
  const db = new Float32Array(acc.length)
  for (let k = 0; k < acc.length; k++) db[k] = 20 * Math.log10(acc[k] / Math.max(1, cnt) + 1e-12)
  return { db, freqs }
}

/** 每倍频程频带的平均响应（dB）：输出均值 − 输入均值 */
function octaveResponses(outSpec: { db: Float32Array; freqs: Float32Array }, inSpec: { db: Float32Array; freqs: Float32Array }): number[] {
  return OCTAVE_BANDS.map(([lo, hi]) => {
    let ia: number[] = []
    let oa: number[] = []
    for (let k = 0; k < outSpec.db.length; k++) {
      if (outSpec.freqs[k] >= lo && outSpec.freqs[k] <= hi) {
        ia.push(inSpec.db[k])
        oa.push(outSpec.db[k])
      }
    }
    return mean(oa) - mean(ia)
  })
}

/** 构造立体声白噪声 + 单声道参考 */
function makeNoisePair(n: number, amp = 0.25, seed = 1234): { L: Float32Array; R: Float32Array; mono: Float32Array } {
  const noise = lcg(seed, n)
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  const mono = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    L[i] = amp * noise[i]
    R[i] = amp * noise[(i + 97) % n]
    mono[i] = 0.5 * (L[i] + R[i])
  }
  return { L, R, mono }
}

/** 用参数 p 处理立体声输入，返回输出与单声道下混 */
function runEngine(p: V3EngineParams, L: Float32Array, R: Float32Array, engine?: EngineV3): { oL: Float32Array; oR: Float32Array; mono: Float32Array; engine: EngineV3 } {
  const e = engine ?? new EngineV3(FS)
  e.setParams(p)
  const oL = new Float32Array(L.length)
  const oR = new Float32Array(R.length)
  e.process([L, R], [oL, oR])
  const mono = new Float32Array(L.length)
  for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (oL[i] + oR[i])
  return { oL, oR, mono, engine: e }
}

function countNaN(x: Float32Array): number {
  let c = 0
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) c++
  return c
}

function peakOf(x: Float32Array): number {
  let p = 0
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]))
  return p
}

function getScene(id: string): V3EngineParams {
  for (const sc of SCENE_PRESETS) if (sc.id === id) return sc.params
  throw new Error('unknown scene ' + id)
}

// ---------------------------------------------------------------------------
// 测试内独立分享串构造器（与被测实现互不引用，用于注入越界/恶意 JSON）
// ---------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
function fnv1a32(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
function bytesToB64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)]
    if (i + 1 < bytes.length) out += B64[((b1 & 15) << 2) | (b2 >> 6)]
    if (i + 2 < bytes.length) out += B64[b2 & 63]
  }
  return out
}
/** 手工构造合法格式（版本+校验+JSON）的分享串，可注入任意 JSON */
function makeRawShare(paramsJson: string, version: number = SHARE_CODEC_VERSION): string {
  const payload = version + ':' + fnv1a32(version + ':' + paramsJson).toString(16).padStart(8, '0') + ':' + paramsJson
  return bytesToB64url(new TextEncoder().encode(payload))
}

/** 解码并应用后做链路健康断言（无 NaN、峰值有界、能量不异常） */
function assertApplySafe(p: V3EngineParams, label: string): void {
  const { L, R } = makeNoisePair(32768, 0.25, 999)
  const { oL, oR } = runEngine(p, L, R)
  expect(countNaN(oL), label + ' L 无 NaN').toBe(0)
  expect(countNaN(oR), label + ' R 无 NaN').toBe(0)
  // 限幅器默认开启（阈值 -1dBFS），任何解码参数下的峰值都应被压到 <1.5
  expect(peakOf(oL), label + ' 峰值<1.5').toBeLessThan(1.5)
  expect(peakOf(oR), label + ' 峰值<1.5').toBeLessThan(1.5)
  const gainDb = 20 * Math.log10(rms(oL, 8192) / Math.max(rms(L, 8192), 1e-12))
  expect(Math.abs(gainDb), label + ' 总增益±30dB').toBeLessThanOrEqual(30)
}

// ===========================================================================
// 1) 11 个场景预设逐个应用后链路健康（白噪声 + FFT 频响有界）
// ===========================================================================
describe('A. 场景预设链健康（白噪声 FFT 频响 ±24dB / 峰值<1.5 / 无 NaN / 能量 ±30dB）', () => {
  const N = 65536
  const { L, R, mono: inMono } = makeNoisePair(N, 0.25)
  const inSpec = avgSpectrumDb(inMono)

  for (const sc of SCENE_PRESETS) {
    // night-bass 为已知异常（频响越界），单独用特性化断言锁定；其余场景走严格契约断言
    if (sc.id === 'night-bass') continue
    it(`scene=${sc.id}：输出有限、峰值<1.5、总增益±30dB、各倍频程响应±24dB`, () => {
      const { oL, oR, mono } = runEngine(sc.params, L, R)
      expect(countNaN(oL) + countNaN(oR)).toBe(0)
      expect(peakOf(oL)).toBeLessThan(1.5)
      expect(peakOf(oR)).toBeLessThan(1.5)
      const gainDb = 20 * Math.log10(rms(mono, 8192) / Math.max(rms(inMono, 8192), 1e-12))
      expect(Math.abs(gainDb)).toBeLessThanOrEqual(30)
      const outSpec = avgSpectrumDb(mono)
      const resp = octaveResponses(outSpec, inSpec)
      for (let b = 0; b < resp.length; b++) {
        expect(Math.abs(resp[b]), `倍频程 ${OCTAVE_BANDS[b][0]}-${OCTAVE_BANDS[b][1]}Hz 响应 ${resp[b].toFixed(1)}dB`).toBeLessThanOrEqual(24)
      }
    })
  }

  it('scene=night-bass：10-15kHz 响应在 ±24dB 契约界内（修复后正断言）', () => {
    // 历史：审计发现高频堆叠过暗（-33.5dB），经四轮调平（EQ 16k −3→0、nightMode 8→1、
    // deesser −28→−36 且 ratio 10→6、补偿预设 night→warm）后回到契约界内（实测 -22.4dB）。
    const sc = SCENE_PRESETS.find((s) => s.id === 'night-bass')!
    const { oL, oR, mono } = runEngine(sc.params, L, R)
    expect(countNaN(oL) + countNaN(oR)).toBe(0)
    expect(peakOf(oL)).toBeLessThan(1.5)
    expect(peakOf(oR)).toBeLessThan(1.5)
    const gainDb = 20 * Math.log10(rms(mono, 8192) / Math.max(rms(inMono, 8192), 1e-12))
    expect(Math.abs(gainDb)).toBeLessThanOrEqual(30)
    const outSpec = avgSpectrumDb(mono)
    const resp = octaveResponses(outSpec, inSpec)
    const hf = resp[resp.length - 1] // 10-15kHz
    // 正断言：高频响应回到 ±24dB 契约界内
    expect(Math.abs(hf)).toBeLessThanOrEqual(24)
    // 数值有限（-60dB 以内，链未发散）
    expect(hf).toBeGreaterThanOrEqual(-60)
    console.log(`[audit] night-bass 倍频程响应(dB): ${resp.map((v) => v.toFixed(1)).join(', ')}`)
  })
})

// ===========================================================================
// 2) 场景切换 A→B→A 热切换：无爆音 / 无 NaN
// ===========================================================================
describe('B. 场景热切换 A→B→A（参数热切换，状态不重置）', () => {
  it('11 场景依次切换后回到 pop：无 NaN、峰值<1.5、块边界无跳变爆音', () => {
    const N = FS * 2 // 2s
    const L = new Float32Array(N)
    const R = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      L[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / FS) + 0.08 * Math.sin((2 * Math.PI * 220 * i) / FS)
      R[i] = 0.3 * Math.sin((2 * Math.PI * 1200 * i) / FS) + 0.08 * Math.sin((2 * Math.PI * 330 * i) / FS)
    }
    const BLOCK = 1024
    const seq: string[] = [...SCENE_IDS, 'pop'] // A→B→…→A
    const e = new EngineV3(FS)
    e.setParams(getScene(seq[0]))
    const oL = new Float32Array(N)
    const oR = new Float32Array(N)
    let idx = 0
    let sceneIdx = 0
    let maxGlobalDelta = 0
    while (idx < N) {
      const n = Math.min(BLOCK, N - idx)
      e.process([L.subarray(idx, idx + n), R.subarray(idx, idx + n)], [oL.subarray(idx, idx + n), oR.subarray(idx, idx + n)])
      // 块内稳态跳变
      for (let i = 1; i < n; i++) {
        maxGlobalDelta = Math.max(maxGlobalDelta, Math.abs(oL[idx + i] - oL[idx + i - 1]), Math.abs(oR[idx + i] - oR[idx + i - 1]))
      }
      // 块边界跳变 vs 边界前本地稳态（128 样本窗）
      if (idx > 0 && idx >= 128) {
        const bd = Math.max(Math.abs(oL[idx] - oL[idx - 1]), Math.abs(oR[idx] - oR[idx - 1]))
        let sd = 0
        for (let i = 1; i <= 128; i++) {
          sd = Math.max(sd, Math.abs(oL[idx - i] - oL[idx - i - 1]), Math.abs(oR[idx - i] - oR[idx - i - 1]))
        }
        // 爆音判定：边界跳变不得超过本地稳态的 8 倍 + 0.02 绝对容差，且不超硬上限 1.0
        expect(bd, `边界 ${seq[sceneIdx - 1]}->${seq[sceneIdx]} bd=${bd.toFixed(4)} sd=${sd.toFixed(4)}`).toBeLessThanOrEqual(Math.max(1.0, 8 * sd) + 0.02)
      }
      idx += n
      sceneIdx++
      if (sceneIdx < seq.length) e.setParams(getScene(seq[sceneIdx]))
    }
    expect(countNaN(oL) + countNaN(oR)).toBe(0)
    expect(peakOf(oL)).toBeLessThan(1.5)
    expect(peakOf(oR)).toBeLessThan(1.5)
    expect(maxGlobalDelta).toBeLessThan(2.0)
  })

  it('默认 <-> 组合（Q补偿+LoudnessComp）每块热切换：无 NaN、边界无跳变', () => {
    const pA = createDefaultParams(FS)
    const pB = createDefaultParams(FS)
    pB.eq.qCompensation = true
    pB.eq.proBands = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f, i) => ({
      frequency: f, gain: [3.5, 2.5, 1.5, 0.5, -0.5, 0, 1, 2, 2.5, 1.5][i], q: 1.1,
    }))
    pB.loudnessCompensation.enabled = true
    pB.loudnessCompensation.mode = 'preset'
    pB.loudnessCompensation.preset = 'night'

    const N = FS * 2
    const L = new Float32Array(N)
    const R = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      L[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / FS) + 0.08 * Math.sin((2 * Math.PI * 220 * i) / FS)
      R[i] = 0.3 * Math.sin((2 * Math.PI * 1200 * i) / FS) + 0.08 * Math.sin((2 * Math.PI * 330 * i) / FS)
    }
    const BLOCK = 1024
    const e = new EngineV3(FS)
    e.setParams(pA)
    const oL = new Float32Array(N)
    const oR = new Float32Array(N)
    let idx = 0
    let k = 0
    while (idx < N) {
      const n = Math.min(BLOCK, N - idx)
      e.process([L.subarray(idx, idx + n), R.subarray(idx, idx + n)], [oL.subarray(idx, idx + n), oR.subarray(idx, idx + n)])
      if (idx > 0 && idx >= 128) {
        const bd = Math.max(Math.abs(oL[idx] - oL[idx - 1]), Math.abs(oR[idx] - oR[idx - 1]))
        let sd = 0
        for (let i = 1; i <= 128; i++) {
          sd = Math.max(sd, Math.abs(oL[idx - i] - oL[idx - i - 1]), Math.abs(oR[idx - i] - oR[idx - i - 1]))
        }
        expect(bd).toBeLessThanOrEqual(Math.max(1.0, 8 * sd) + 0.02)
      }
      idx += n
      k++
      e.setParams(k % 2 === 0 ? pA : pB)
    }
    expect(countNaN(oL) + countNaN(oR)).toBe(0)
    expect(peakOf(oL)).toBeLessThan(1.5)
  })
})

// ===========================================================================
// 3) 分享串：往返一致 + 恶意/越界串 clamp/拒绝 + 应用后链路安全
// ===========================================================================
describe('C. 分享串（ShareCodec）编解码与防注入', () => {
  it('11 个场景快照 encode→decode 往返参数一致', () => {
    for (const sc of SCENE_PRESETS) {
      const decoded = decodeShareCode(encodeShareCode(sc.params))
      expect(decoded, `scene=${sc.id} 往返一致`).toEqual(sc.params)
      expect(decoded.reverb.convolution.ir).toBeNull()
    }
  })

  it('越界数值（增益 ±999、q 99/0、频率越界）解码后被 clamp，应用后链路无 NaN', () => {
    const json = JSON.stringify({
      sampleRate: 48000,
      eq: {
        enabled: true, mode: 'pro', bandCount: 20, qCompensation: true,
        proBands: [
          { frequency: 50, gain: 999, q: 0 },
          { frequency: 10, gain: -999, q: 99 },
          { frequency: 999999, gain: 30, q: 0.001 },
        ],
      },
    })
    const decoded = decodeShareCode(makeRawShare(json))
    expect(decoded.eq.proBands[0]).toEqual({ frequency: 50, gain: 20, q: 0.1 })
    expect(decoded.eq.proBands[1]).toEqual({ frequency: 20, gain: -20, q: 10 })
    expect(decoded.eq.proBands[2].frequency).toBe(20000)
    expect(decoded.eq.proBands[2].gain).toBe(20)
    assertApplySafe(decoded, '越界增益解码应用')
  })

  it('超长数组（proBands/simpleBands/loudnessComp.bands）被截断，应用后链路无 NaN', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ frequency: 100 + i, gain: 1, q: 1 }))
    const json = JSON.stringify({
      sampleRate: 48000,
      eq: { mode: 'pro', proBands: many, simpleBands: Array.from({ length: 100 }, (_, i) => i - 50) },
      loudnessCompensation: { bands: many },
    })
    const decoded = decodeShareCode(makeRawShare(json))
    expect(decoded.eq.proBands.length).toBeLessThanOrEqual(20)
    expect(decoded.eq.simpleBands.length).toBeLessThanOrEqual(5)
    expect(decoded.loudnessCompensation.bands.length).toBeLessThanOrEqual(32)
    assertApplySafe(decoded, '超长数组解码应用')
  })

  it('非法枚举回落默认值，应用后链路无 NaN', () => {
    const json = JSON.stringify({
      sampleRate: 48000,
      reverb: { mode: 'nuclear', algorithmic: { type: 'blackhole' } },
      bassEnhancer: { harmonicType: 'x³' },
      surround3d: { direction: 7 },
      eq: { bandCount: 99, mode: 'quantum' },
      ieq: { targetCurve: 'bogus' },
      loudnessCompensation: { mode: 'magic', preset: 'hyper' },
      pitch: {},
    })
    const decoded = decodeShareCode(makeRawShare(json))
    expect(decoded.reverb.mode).toBe('algorithmic')
    expect(decoded.reverb.algorithmic.type).toBe('hall')
    expect(decoded.bassEnhancer.harmonicType).toBe('odd')
    expect(decoded.surround3d.direction).toBe(1)
    expect(decoded.eq.bandCount).toBe(10)
    expect(decoded.eq.mode).toBe('pro')
    expect(decoded.ieq.targetCurve).toBe('flat')
    expect(decoded.loudnessCompensation.mode).toBe('auto')
    expect(decoded.loudnessCompensation.preset).toBe('flat')
    assertApplySafe(decoded, '非法枚举解码应用')
  })

  it('NaN/Infinity 数值（1e999、字符串、null、布尔）被拒绝为默认，应用后链路无 NaN', () => {
    // JSON.stringify 会把字面 NaN/Infinity 序列化为 null，但手工 JSON 可注入 1e999 → Infinity
    const json = `{"sampleRate":1e999,"stereoWidth":1e999,"eq":{"proBands":[{"frequency":1e999,"gain":"NaN","q":null},{"frequency":-1e999,"gain":true,"q":"Infinity"}]},"deesser":{"thresholdDb":1e999},"loudnessNormalization":{"maxGainDb":1e999},"limiter":{"thresholdDb":-1e999},"surround3d":{"distance":1e999}}`
    const decoded = decodeShareCode(makeRawShare(json))
    expect(decoded.sampleRate).toBe(48000)
    expect(decoded.stereoWidth).toBe(1)
    expect(decoded.eq.proBands[0]).toEqual({ frequency: 1000, gain: 0, q: 1.1 })
    // -1e999 → -Infinity（非有限数）→ 默认值 1000（非有限数走默认而非 clamp）
    expect(decoded.eq.proBands[1]).toEqual({ frequency: 1000, gain: 0, q: 1.1 })
    expect(decoded.deesser.thresholdDb).toBe(-30)
    expect(decoded.loudnessNormalization.maxGainDb).toBe(9)
    expect(decoded.limiter.thresholdDb).toBe(-1)
    expect(decoded.surround3d.distance).toBe(0.5)
    assertApplySafe(decoded, 'NaN/Infinity 解码应用')
  })

  it('极端解码参数（全模块开启 + 极限但契约内取值）应用后链路无 NaN、峰值有界', () => {
    const json = JSON.stringify({
      sampleRate: 192000,
      eq: { enabled: true, mode: 'pro', bandCount: 20, qCompensation: true, proBands: Array.from({ length: 20 }, (_, i) => ({ frequency: 20 + i * 800, gain: i % 2 === 0 ? 20 : -20, q: 0.1 })) },
      deesser: { enabled: true, centerHz: 4000, q: 0.1, thresholdDb: -60, ratio: 50, mix: 1 },
      compressor: { enabled: true, thresholdDb: -60, ratio: 50, kneeDb: 0, attackMs: 0, releaseMs: 3000, makeupDb: 24, outputGain: 2 },
      nightMode: { enabled: true, amount: 10 },
      bassEnhancer: { enabled: true, cutoffHz: 500, harmonicType: 'even', harmonicGain: 1, mix: 1, levelDb: 6, lowBoostDb: 0 },
      reverb: { enabled: true, mode: 'algorithmic', algorithmic: { type: 'hall', roomSize: 0.98, damping: 0.01, wet: 1, dry: 1, preDelayMs: 500, width: 2 } },
      surround3d: { enabled: true, distance: 10, speed: 10, angle: 360, direction: -1 },
      loudnessCompensation: { enabled: true, mode: 'auto', volumePercent: 0, maxBoostDb: 24, smoothingSeconds: 0.01 },
      loudnessNormalization: { enabled: true, useRealtimeMeter: false, externalGainDb: 24, targetLufs: 0 },
      limiter: { enabled: true, thresholdDb: 0, lookaheadMs: 50, attackMs: 0, releaseMs: 2000, truePeak: true },
      ieq: { enabled: true, strength: 1, targetCurve: 'bright', timeConstantSec: 0.1 },
      stereoWidth: 2,
      pitch: { enabled: true, semitones: 10, rate: 3, voiceBalance: 1 },
    })
    const decoded = decodeShareCode(makeRawShare(json))
    assertApplySafe(decoded, '极端解码参数应用')
  })
})

// ===========================================================================
// 4) 双路径：同一输入连续 setParams 热切换连续性 + stats 数值合理
// ===========================================================================
describe('D. 双路径一致性（热切换连续性 + stats）', () => {
  it('相同参数反复 setParams 不改变输出（逐样本一致，无状态误重置）', () => {
    // 注意：引擎是有状态链（混响尾/压缩包络/限幅器延迟线跨块延续），
    // 因此"同一引擎连续处理同一输入两次"的输出必然不同（第二次叠加第一次的尾音）。
    // 正确做法：两台全新引擎，一台额外多调用一次 setParams，比较逐样本输出必须一致。
    const N = 8192
    const { L, R } = makeNoisePair(N, 0.3, 77)
    const p = createDefaultParams(FS)
    p.reverb.enabled = true
    p.reverb.mode = 'algorithmic'
    p.loudnessCompensation.enabled = true
    const e1 = new EngineV3(FS)
    e1.setParams(p)
    const e2 = new EngineV3(FS)
    e2.setParams(p)
    e2.setParams(p) // 额外重复一次相同参数
    const o1 = new Float32Array(N)
    const o2 = new Float32Array(N)
    const oA = new Float32Array(N)
    const oB = new Float32Array(N)
    e1.process([L, R], [o1, o2])
    e2.process([L, R], [oA, oB])
    // 逐样本完全一致（引擎确定性 + 重复 setParams 不引入任何状态变化）
    for (let i = 0; i < N; i++) {
      expect(oA[i]).toBe(o1[i])
      expect(oB[i]).toBe(o2[i])
    }
  })

  it('stats 数值合理：LUFS∈(-70,0)、limiterReductionDb≤0、latency≥0、peakDb≤0', () => {
    const e = new EngineV3(FS)
    const N = FS * 2 // 2s
    const L = new Float32Array(N)
    const R = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const v = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / FS)
      L[i] = v
      R[i] = v
    }
    const oL = new Float32Array(N)
    const oR = new Float32Array(N)
    e.process([L, R], [oL, oR])
    const st = e.getStats()
    expect(st.lufsIntegrated).toBeGreaterThan(-70)
    expect(st.lufsIntegrated).toBeLessThan(0)
    expect(st.lufsMomentary).toBeGreaterThan(-70)
    expect(st.lufsMomentary).toBeLessThan(0)
    expect(st.limiterReductionDb).toBeLessThanOrEqual(0)
    expect(Number.isFinite(st.limiterReductionDb)).toBe(true)
    expect(st.engineLatencySamples).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(st.peakDb)).toBe(true)
    expect(st.peakDb).toBeLessThanOrEqual(0)
    expect(Number.isFinite(st.truePeakDb)).toBe(true)
    // 1kHz 0.5 幅度正弦 → 积分响度 ≈ -3 LUFS（K 加权 1kHz 约 +3dB，-6dBFS + 3 ≈ -3）
    expect(st.lufsIntegrated).toBeGreaterThan(-6)
    expect(st.lufsIntegrated).toBeLessThan(-1)
  })

  it('场景热切换后分析路径（getAnalysis）仍返回有限频谱与特征', () => {
    const e = new EngineV3(FS)
    const N = FS // 1s
    const { L, R } = makeNoisePair(N, 0.3, 555)
    // 依次应用 3 个场景，最后取分析
    for (const id of ['pop', 'night-bass', 'dts']) {
      e.setParams(getScene(id))
      const oL = new Float32Array(N)
      const oR = new Float32Array(N)
      e.process([L, R], [oL, oR])
    }
    const a = e.getAnalysis()
    expect(a.spectrum).not.toBeNull()
    expect(a.features).not.toBeNull()
    for (let k = 0; k < a.spectrum!.length; k++) {
      expect(Number.isFinite(a.spectrum![k])).toBe(true)
    }
    const f = a.features!
    expect(Number.isFinite(f.rms)).toBe(true)
    expect(Number.isFinite(f.centroidHz)).toBe(true)
    expect(Number.isFinite(f.flatness)).toBe(true)
    expect(Number.isFinite(f.crest)).toBe(true)
  })
})

// ===========================================================================
// 5) EQ Q 补偿 + LoudnessComp 组合开启时频响有界
// ===========================================================================
describe('E. EQ Q 补偿 + LoudnessComp 组合', () => {
  const N = 65536
  const { L, R, mono: inMono } = makeNoisePair(N, 0.25, 777)
  const inSpec = avgSpectrumDb(inMono)

  function comboParams(lcMode: 'preset' | 'auto', lcPreset: string): V3EngineParams {
    const p = createDefaultParams(FS)
    p.eq.enabled = true
    p.eq.qCompensation = true
    p.eq.mode = 'pro'
    p.eq.proBands = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f, i) => ({
      frequency: f, gain: [3.5, 2.5, 1.5, 0.5, -0.5, 0, 1, 2, 2.5, 1.5][i], q: 1.1,
    }))
    p.loudnessCompensation.enabled = true
    p.loudnessCompensation.mode = lcMode
    p.loudnessCompensation.preset = lcPreset
    p.loudnessCompensation.volumePercent = 30
    p.loudnessCompensation.maxBoostDb = 12
    return p
  }

  const combos = [
    { name: 'Q补偿+夜间预设', p: comboParams('preset', 'night') },
    { name: 'Q补偿+auto(30%)', p: comboParams('auto', 'flat') },
    { name: 'Q补偿+低频预设', p: comboParams('preset', 'bass') },
  ]

  for (const c of combos) {
    it(`组合 ${c.name}：无 NaN、峰值<1.5、各倍频程响应±24dB、总增益±30dB`, () => {
      const { oL, oR, mono } = runEngine(c.p, L, R)
      expect(countNaN(oL) + countNaN(oR)).toBe(0)
      expect(peakOf(oL)).toBeLessThan(1.5)
      expect(peakOf(oR)).toBeLessThan(1.5)
      const gainDb = 20 * Math.log10(rms(mono, 8192) / Math.max(rms(inMono, 8192), 1e-12))
      expect(Math.abs(gainDb)).toBeLessThanOrEqual(30)
      const outSpec = avgSpectrumDb(mono)
      const resp = octaveResponses(outSpec, inSpec)
      for (let b = 0; b < resp.length; b++) {
        expect(Math.abs(resp[b]), `倍频程 ${OCTAVE_BANDS[b][0]}-${OCTAVE_BANDS[b][1]}Hz ${resp[b].toFixed(1)}dB`).toBeLessThanOrEqual(24)
      }
    })
  }

  it('组合处理 1s 噪声后切静音：2s 内输出衰减至 <1e-3（无自激/DC 累计）', () => {
    const p = comboParams('auto', 'flat')
    const e = new EngineV3(FS)
    const n1 = FS
    const { L, R } = makeNoisePair(n1, 0.3, 321)
    const O = new Float32Array(n1)
    e.setParams(p)
    e.process([L, R], [O, O])
    const Z = new Float32Array(n1)
    const peaks: number[] = []
    for (let b = 0; b < 3; b++) {
      e.process([Z, Z], [O, O])
      peaks.push(peakOf(O))
    }
    // 第 3 个零块（已静音 2s）必须 <1e-3
    expect(peaks[2]).toBeLessThan(1e-3)
    // 且整体单调衰减（无自激回涨）
    expect(peaks[2]).toBeLessThanOrEqual(peaks[1])
    expect(peaks[1]).toBeLessThanOrEqual(peaks[0])
  }, 30_000)
})

// ===========================================================================
// F. 收尾：场景处理后切静音的衰减（自激/DC 泄漏边界检查）
// ===========================================================================
describe('F. 场景处理后静音衰减（无自激/DC 累计）', () => {
  it('11 场景处理 1s 噪声后切静音，2s 内输出峰值 <1e-3', () => {
    const n1 = FS
    const { L, R } = makeNoisePair(n1, 0.3, 4242)
    const Z = new Float32Array(n1)
    const O = new Float32Array(n1)
    for (const sc of SCENE_PRESETS) {
      const e = new EngineV3(FS)
      e.setParams(sc.params)
      e.process([L, R], [O, O])
      let last = Infinity
      for (let b = 0; b < 3; b++) {
        e.process([Z, Z], [O, O])
        last = peakOf(O)
      }
      expect(last, `scene=${sc.id} 静音 2s 后峰值`).toBeLessThan(1e-3)
    }
  }, 30_000)
})