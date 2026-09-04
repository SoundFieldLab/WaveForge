/**
 * ambisonics —— Ambisonics B-format（FOA）编解码单元测试
 *
 * 覆盖：encode 方向正交性、归一化（W=1/√2）、decode 矩阵方向选择（45° 源 → 45°
 * 扬声器增益最大）、stereoToFoa 环境提取（反相/同相）、能量守恒量级（正则 4 方向
 * 布局解码能量 = 2×输入 FOA 能量，恒定因子）、foaAmbienceGains（FOA 动态增益调制：
 * 同相/反相/静音/确定性——stereoToFoa + decode 一步，处理器平滑/去相关的目标增益）。
 */
import { describe, it, expect } from 'vitest'
import { encodeSource, decodeFoaToSpeakers, stereoToFoa, AMBIENCE_SPEAKERS } from '../ambisonics'
import { foaAmbienceGains } from '../ambienceMixer'
import type { FoaSignal } from '../ambisonics'

describe('ambisonics：encodeSource（SH 编码）', () => {
  it('方向正交性：正前(0,0) X 最大、正右(90,0) Y 最大、天顶(0,90) Z 最大', () => {
    const front = encodeSource(0, 0, 1)
    expect(front[1]).toBeCloseTo(1, 10) // X = cos(el)·cos(az) = 1
    expect(front[1]).toBeGreaterThan(front[2])
    expect(front[1]).toBeGreaterThan(front[3])
    expect(front[1]).toBeGreaterThan(front[0]) // X=1 > W=1/√2

    const right = encodeSource(90, 0, 1)
    expect(right[2]).toBeCloseTo(1, 10) // Y = cos(el)·sin(az) = 1
    expect(right[2]).toBeGreaterThan(right[1])
    expect(right[2]).toBeGreaterThan(right[0])

    const zenith = encodeSource(0, 90, 1)
    expect(zenith[3]).toBeCloseTo(1, 10) // Z = sin(el) = 1
    expect(zenith[3]).toBeGreaterThan(zenith[1])
    expect(zenith[3]).toBeGreaterThan(zenith[2])
    expect(zenith[3]).toBeGreaterThan(zenith[0])

    // 符号约定（az>0 右、el>0 上）：正前 X 正、正右 Y 正、天顶 Z 正、正左 Y 负
    expect(front[1]).toBeGreaterThan(0)
    expect(right[2]).toBeGreaterThan(0)
    expect(zenith[3]).toBeGreaterThan(0)
    expect(encodeSource(-90, 0, 1)[2]).toBeLessThan(0)
    expect(encodeSource(0, -90, 1)[3]).toBeLessThan(0)
  })

  it('归一化：gain=1 → W=1/√2（任意方向）；方向余弦单位能量', () => {
    for (const [az, el] of [
      [0, 0],
      [45, 30],
      [180, -20],
      [90, 90],
      [-135, 60],
    ] as const) {
      const f = encodeSource(az, el, 1)
      expect(f[0]).toBeCloseTo(1 / Math.SQRT2, 12)
      // 方向分量能量 = cos²(el)(cos²+sin²) + sin²(el) = 1（与方向无关）
      const dir = f[1] * f[1] + f[2] * f[2] + f[3] * f[3]
      expect(dir).toBeCloseTo(1, 10)
    }
    // gain 线性缩放
    const g = encodeSource(0, 0, 0.5)
    expect(g[0]).toBeCloseTo(0.5 / Math.SQRT2, 12)
    expect(g[1]).toBeCloseTo(0.5, 12)
  })
})

describe('ambisonics：decodeFoaToSpeakers（SH→虚拟扬声器解码）', () => {
  it('解码矩阵：单方向声源在对应扬声器增益最大（45° 源 → 45° 扬声器）', () => {
    const azs = AMBIENCE_SPEAKERS.map((s) => s.azimuthDeg)
    const g = decodeFoaToSpeakers(encodeSource(45, 0, 1), azs)
    expect(g[0]).toBeGreaterThan(g[1]) // 45° 扬声器 > 135°
    expect(g[0]).toBeGreaterThan(g[2]) // > 225°
    expect(g[0]).toBeGreaterThan(g[3]) // > 315°
    expect(g[0]).toBeGreaterThan(0)
    // 正前源：45°/315° 对称最大（两侧等距）
    const g2 = decodeFoaToSpeakers(encodeSource(0, 0, 1), azs)
    expect(g2[0]).toBeCloseTo(g2[3], 10)
    expect(g2[0]).toBeGreaterThan(g2[1])
    expect(g2[0]).toBeGreaterThan(g2[2])
    // Z 通道对水平解码无贡献（扬声器 el=0 处 sin(el_k)=0，无 Z 投影）
    const g3 = decodeFoaToSpeakers([0, 0, 0, 1] as FoaSignal, azs)
    expect(g3.every((x) => x === 0)).toBe(true)
  })

  it('能量守恒量级：水平解码总能量 = 2×输入 FOA 能量（正则 4 方向布局恒定因子）', () => {
    const azs = AMBIENCE_SPEAKERS.map((s) => s.azimuthDeg)
    for (const az of [0, 45, 90, 135, 180, 225, 315, -60, 30]) {
      const f = encodeSource(az, 0, 1)
      const g = decodeFoaToSpeakers(f, azs)
      const outE = g.reduce((s, x) => s + x * x, 0)
      // 水平面（Z=0）：Σ_k g_k² = 2·(W²+X²+Y²) = 2·inE（Σcos=Σsin=0、Σcos²=Σsin²=2）
      const inE = f[0] * f[0] + f[1] * f[1] + f[2] * f[2]
      expect(outE).toBeCloseTo(2 * inE, 8)
      // 量级守恒：能量不放大/不湮灭（同量级宽松界）
      expect(outE).toBeGreaterThan(0.5 * inE)
      expect(outE).toBeLessThan(4 * inE)
    }
  })
})

describe('ambisonics：stereoToFoa（环境提取，块 RMS）', () => {
  // 375Hz/48k = 每周期 128 样本，1024 样本 = 整 8 周期 → 正弦 RMS 精确 = 1/√2
  const N = 1024
  const sinBuf = (freq: number, phase = 0): Float32Array => {
    const b = new Float32Array(N)
    for (let i = 0; i < N; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / 48000 + phase)
    return b
  }

  it('纯反相输入 (L=-R)：side 大 mid 小（W≈0、Y≈√2·rms）', () => {
    const s = sinBuf(375)
    const l = s
    const r = new Float32Array(N)
    for (let i = 0; i < N; i++) r[i] = -s[i]
    const f = stereoToFoa(l, r, 256)
    expect(f[0]).toBeCloseTo(0, 10) // mid=(s-s)/2=0 → W=0（mid 小）
    expect(f[2]).toBeCloseTo(1, 8) // Y = √2·rms(s) = √2·(1/√2) = 1（side 大）
    expect(f[2]).toBeGreaterThan(f[0])
    expect(f[1]).toBe(0) // X 恒 0（无前后信息）
    expect(f[3]).toBe(0) // Z 恒 0（无上下信息）
  })

  it('纯同相输入 (L=R)：side≈0（Y=0）、W=√2·rms', () => {
    const s = sinBuf(375)
    const f = stereoToFoa(s, s, 512)
    expect(f[2]).toBeCloseTo(0, 10) // side=(s-s)/2=0 → Y≈0
    expect(f[0]).toBeCloseTo(1, 8) // W = √2·rms(s) = 1
    expect(f[0]).toBeGreaterThan(f[2])
  })

  it('块长鲁棒：整体 RMS 与切片方式无关（block 只是名义契约）', () => {
    const l = sinBuf(375, 0.3)
    const r = sinBuf(375, 0.9)
    const f128 = stereoToFoa(l, r, 128)
    const f1024 = stereoToFoa(l, r, 1024)
    const f999 = stereoToFoa(l, r, 999) // 非整块长
    // 整块整体 RMS：块长/划分任意 → 输出逐位一致（能量级稳定，不随切片跳变）
    expect(f128[0]).toBeCloseTo(f1024[0], 12)
    expect(f128[2]).toBeCloseTo(f1024[2], 12)
    expect(f999[0]).toBeCloseTo(f1024[0], 12)
    expect(f999[2]).toBeCloseTo(f1024[2], 12)
    // 非法参数：空缓冲 / 非正块长 → 全零（静音环境）
    expect(stereoToFoa(new Float32Array(0), new Float32Array(0), 256)).toEqual([0, 0, 0, 0])
    expect(stereoToFoa(l, r, 0)).toEqual([0, 0, 0, 0])
  })
})

describe('ambisonics：AMBIENCE_SPEAKERS 布局', () => {
  it('标准 4 方向水平等角布局 [45,135,225,315]，仰角全 0', () => {
    expect(AMBIENCE_SPEAKERS.map((s) => s.azimuthDeg)).toEqual([45, 135, 225, 315])
    expect(AMBIENCE_SPEAKERS.every((s) => s.elevationDeg === 0)).toBe(true)
    expect(AMBIENCE_SPEAKERS).toHaveLength(4)
  })
})

describe('ambisonics：foaAmbienceGains（FOA 动态增益调制——stereoToFoa + decode 一步）', () => {
  // 375Hz/48k = 每周期 128 样本，1024 样本 = 整 8 周期 → 正弦 RMS 精确 = 1/√2
  // （与 stereoToFoa 用例同信号族：W = √2·rms = 1、Y = √2·rms = 1）
  const N = 1024
  const sinBuf = (freq: number, phase = 0): Float32Array => {
    const b = new Float32Array(N)
    for (let i = 0; i < N; i++) b[i] = Math.sin((2 * Math.PI * freq * i) / 48000 + phase)
    return b
  }

  it('纯同相输入 (L=R) → W 大 → 4 增益近似相等（对称布局对 W 增益 = 1/√2·W 相同）', () => {
    const s = sinBuf(375)
    const g = foaAmbienceGains(s, s, 256)
    // W = √2·rms(s) = 1、X=Y=0 → g_k = W/√2（4 方向对全向分量等权，与方位无关）
    expect(g).toHaveLength(4)
    expect(g[0]).toBeCloseTo(1 / Math.SQRT2, 8)
    expect(g[0]).toBeGreaterThan(0)
    for (let k = 1; k < 4; k++) expect(g[k]).toBeCloseTo(g[0], 10)
  })

  it('纯反相输入 (L=-R) → Y 大 → 增益正负交替（45°+、135°+、225°−、315°−）', () => {
    const s = sinBuf(375)
    const r = new Float32Array(N)
    for (let i = 0; i < N; i++) r[i] = -s[i]
    const g = foaAmbienceGains(s, r, 256)
    // Y = √2·rms(s) = 1、W=X=0 → g_k = sin(az_k)·Y = ±1/√2：45°/135°（右半场，
    // az∈(0°,180°) 内 sin>0）为正、225°/315°（左半场，sin<0）为负——两正两负
    // 正负交替（Ambisonics 相位抵消语义；stereoToFoa 的 M/S 矩阵只给左右轴 Y，
    // 无前后 X——45°+、135°−、225°−、315°+ 的 cos 模式需 X 能量，本路径不产生）
    expect(g[0]).toBeCloseTo(1 / Math.SQRT2, 8) // 45°  sin=+0.707
    expect(g[1]).toBeCloseTo(1 / Math.SQRT2, 8) // 135° sin=+0.707
    expect(g[2]).toBeCloseTo(-1 / Math.SQRT2, 8) // 225° sin=−0.707
    expect(g[3]).toBeCloseTo(-1 / Math.SQRT2, 8) // 315° sin=−0.707
    expect(g[0]).toBeGreaterThan(0)
    expect(g[1]).toBeGreaterThan(0)
    expect(g[2]).toBeLessThan(0)
    expect(g[3]).toBeLessThan(0)
  })

  it('静音输入 → 全 0；空缓冲/非法块长 → 回退静音', () => {
    const s = new Float32Array(N)
    expect(foaAmbienceGains(s, s, 256)).toEqual([0, 0, 0, 0])
    expect(foaAmbienceGains(new Float32Array(0), new Float32Array(0), 256)).toEqual([0, 0, 0, 0])
    expect(foaAmbienceGains(s, s, 0)).toEqual([0, 0, 0, 0])
  })

  it('确定性：同输入两次调用逐位一致；块长鲁棒（整体 RMS 与切片无关，stereoToFoa 语义透传）', () => {
    const l = sinBuf(375, 0.3)
    const r = sinBuf(375, 0.9)
    const a = foaAmbienceGains(l, r, 128)
    expect(a).toEqual(foaAmbienceGains(l, r, 128)) // 确定性（无随机源）
    expect(a).toEqual(foaAmbienceGains(l, r, 1024)) // block 只是名义契约，输出不变
  })
})
