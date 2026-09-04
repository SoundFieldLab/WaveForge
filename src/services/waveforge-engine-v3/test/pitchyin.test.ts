/**
 * test/pitchyin.test.ts —— YIN 基频检测单测
 * 物理含义：窗长 2048@48kHz 覆盖约 18.8 个 440Hz 周期、9.4 个 220Hz 周期，
 * YIN 差分/CMND/抛物线插值后应恢复基频到 ±1Hz（0.23%）。
 */
import { describe, it, expect } from 'vitest'
import { yinPitch } from '../src/dsp/PitchYin'

const FS = 48000

function sine(fs: number, freq: number, n: number, amp = 1): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs)
  return x
}

/** 确定性白噪声（LCG，固定种子）——避免测试依赖随机性 */
function whiteNoise(n: number, seed = 12345): Float32Array {
  const x = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    x[i] = ((s >>> 8) / 0xffffff) * 2 - 1
  }
  return x
}

describe('yinPitch', () => {
  it('440Hz 正弦（2048 窗@48k）→ 440±1Hz', () => {
    const x = sine(FS, 440, 2048)
    const f = yinPitch(x, FS)
    expect(f).toBeGreaterThan(439)
    expect(f).toBeLessThan(441)
  })

  it('220Hz 正弦 → 220±1Hz', () => {
    const x = sine(FS, 220, 2048)
    const f = yinPitch(x, FS)
    expect(f).toBeGreaterThan(219)
    expect(f).toBeLessThan(221)
  })

  it('带谐波信号仍检出基频（440Hz 基波 + 二次/三次谐波）', () => {
    const n = 2048
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      x[i] =
        0.6 * Math.sin((2 * Math.PI * 440 * i) / FS) +
        0.3 * Math.sin((2 * Math.PI * 880 * i) / FS) +
        0.15 * Math.sin((2 * Math.PI * 1320 * i) / FS)
    }
    const f = yinPitch(x, FS)
    expect(f).toBeGreaterThan(439)
    expect(f).toBeLessThan(441)
  })

  it('minHz/maxHz 约束搜索区间（220Hz，100..300Hz）', () => {
    const x = sine(FS, 220, 2048)
    const f = yinPitch(x, FS, { minHz: 100, maxHz: 300 })
    expect(f).toBeGreaterThan(219)
    expect(f).toBeLessThan(221)
  })

  it('纯噪声 → -1 或明显偏离（不崩溃、无 NaN）', () => {
    const x = whiteNoise(2048)
    const f = yinPitch(x, FS)
    expect(Number.isFinite(f)).toBe(true)
    // 噪声无周期成分：要么未检出(-1)，要么频率远离 440Hz（"明显偏离"）
    expect(f === -1 || Math.abs(f - 440) > 10).toBe(true)
  })

  it('静音 → -1（避免 0/0 → NaN）', () => {
    const x = new Float32Array(2048)
    expect(yinPitch(x, FS)).toBe(-1)
  })

  it('窗长过短 / 采样率非法：不崩溃', () => {
    expect(yinPitch(new Float32Array(16), FS)).toBe(-1)
    expect(() => yinPitch(new Float32Array(2048), 0)).toThrow('invalid sample rate')
  })

  it('确定性：同一输入多次调用结果一致', () => {
    const x = sine(FS, 440, 2048)
    expect(yinPitch(x, FS)).toBe(yinPitch(x, FS))
  })
})
