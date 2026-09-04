/**
 * TsConvolverBackend 单元测试（TS 参考后端，兼 Rust/WASM 数值对拍 ground truth）
 *
 * 测试网格：全方向 delta 冲激 HRIR（h[0]=1，其余 0）——卷积即"延迟 1 分区长"，
 * 可精确断言延迟对齐、距离增益与干湿混合。
 * 测试信号：低频正弦（10Hz，空气吸收 fc=4000/(1+d) Hz 在 10Hz 处幅度≈1、相移≈0.36°），
 * 避免空气吸收低通污染"≈ 延迟后缩放"的断言。
 * 物理预期：
 *  - 湿路延迟 = 分区长 512（Convolver 块缓冲延迟），干路延迟线同样 512 → 干湿对齐；
 *  - 0° 单扬声器（inverse，d=1.5m）：增益 = min(1, 1/1.5) = 2/3；
 *  - amount=0 纯干、amount=1 纯湿；块长 128 与 4096 输出一致（逐样本确定性）。
 *
 * 契约函数 getHrir（规划书 §3.2）追加：
 *   - nearest：返回与网格该方向 HRIR 逐位一致（与 setConfig 装载分支同路径）；
 *   - spherical：与 hrtfInterp.sphericalHrtf 输出逐位一致（同一函数同一路径）；
 *   - 与 WasmHrtfBackend.getHrir 对拍（同一 KEMAR 网格/模式：nearest 逐位、
 *     spherical ≤ 1e-5——Rust 侧 spatial_get_hrir 与 build_speaker 装载分支同源）。
 */
import { describe, it, expect } from 'vitest'
import { TsConvolverBackend, nearestGridIndex, dopplerRate } from '../TsConvolverBackend'
import { sphericalHrtf } from '../hrtfInterp'
import type { HrtfGrid, RoomPreset, SpatialRenderConfig, VirtualSpeaker } from '../types'

const FS = 48000
const PART = 512 // 分区长（后端延迟）


/** 全方向 delta HRIR 网格（hrirLen 小，卷积即延迟） */
function deltaGrid(fs = FS, hrirLen = 4): HrtfGrid {
  const azimuths: number[] = []
  for (let a = -180; a < 180; a += 5) azimuths.push(a)
  const elevations: number[] = []
  for (let e = -40; e <= 90; e += 10) elevations.push(e)
  const n = elevations.length * azimuths.length
  const left = new Float32Array(n * hrirLen)
  const right = new Float32Array(n * hrirLen)
  for (let i = 0; i < n; i++) {
    left[i * hrirLen] = 1
    right[i * hrirLen] = 1
  }
  return { sampleRate: fs, azimuths, elevations, hrirLength: hrirLen, left, right }
}

function makeConfig(speakers: VirtualSpeaker[], overrides?: Partial<SpatialRenderConfig>): SpatialRenderConfig {
  return {
    speakers,
    room: 'off',
    roomAmount: 0,
    amount: 1,
    distanceModel: 'inverse',
    hrtfInterp: 'nearest',
    convolution: 'partitioned',
    masterGain: 1,
    ...overrides,
  }
}

/** 低频正弦（10Hz，幅度 0.4），空气吸收低通在 10Hz 处近透明 */
function lowFreqSine(n: number, freqHz = 10, amp = 0.4): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / FS)
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

describe('TsConvolverBackend：直通与延迟', () => {
  it('speakers 为空 → 直通（无额外延迟）', () => {
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    b.setConfig(makeConfig([]))
    const inL = lowFreqSine(1024)
    const inR = lowFreqSine(1024, 13)
    const outL = new Float32Array(1024)
    const outR = new Float32Array(1024)
    b.processStereo(inL, inR, outL, outR)
    expect(outL).toEqual(inL)
    expect(outR).toEqual(inR)
    expect(b.getLatencySamples()).toBe(0)
  })

  it('getLatencySamples：有扬声器 = 512，无扬声器 = 0', () => {
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    expect(b.getLatencySamples()).toBe(0)
    b.setConfig(makeConfig([{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0 }]))
    expect(b.getLatencySamples()).toBe(PART)
    b.setConfig(makeConfig([]))
    expect(b.getLatencySamples()).toBe(0)
  })
})

describe('TsConvolverBackend：0° 单扬声器（delta 网格，inverse d=1.5m）', () => {
  const speaker: VirtualSpeaker = { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }

  it('amount=1 纯湿：输出 ≈ 输入延迟 512 后按 1/1.5 缩放（两耳同源）', () => {
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    b.setConfig(makeConfig([speaker]))
    const N = 4096
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    b.processStereo(inL, inR, outL, outR)

    const gain = 1 / 1.5 // min(1, ref/max(d, ref))，ref=1m
    // 前 512 样本：湿路（卷积延迟）+ 干路（对齐延迟）均为空白
    for (let i = 0; i < PART; i++) {
      expect(Math.abs(outL[i])).toBeLessThan(1e-9)
      expect(Math.abs(outR[i])).toBeLessThan(1e-9)
    }
    // 稳态区（512 放行重建 + 128 滤波暂态 + 256 首装淡入余量）：左耳 = 左声道信号延迟 512 后缩放
    const SKIP = PART + 128 + 256
    expect(maxAbsDiff(outL.subarray(SKIP), inL.subarray(SKIP - PART).map((v) => v * gain))).toBeLessThan(0.01)
    // 右耳听到的是同一只扬声器（channel=0 路由左声道）
    expect(maxAbsDiff(outR.subarray(SKIP), inL.subarray(SKIP - PART).map((v) => v * gain))).toBeLessThan(0.01)
  })

  it('amount=0 纯干：输出 = 输入延迟 512（干湿对齐，无缩放）', () => {
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    b.setConfig(makeConfig([speaker], { amount: 0 }))
    const N = 2048
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    b.processStereo(inL, inR, outL, outR)
    expect(maxAbsDiff(outL.subarray(PART), inL.subarray(0, N - PART))).toBeLessThan(1e-6)
    expect(maxAbsDiff(outR.subarray(PART), inR.subarray(0, N - PART))).toBeLessThan(1e-6)
    // 前 512 样本为延迟空白
    for (let i = 0; i < PART; i++) {
      expect(Math.abs(outL[i])).toBeLessThan(1e-9)
    }
  })

  it('块长 128 与 4096 输出一致（逐样本确定性）', () => {
    const mk = () => {
      const b = new TsConvolverBackend()
      b.loadHrtf(deltaGrid())
      b.setConfig(makeConfig([speaker]))
      return b
    }
    const N = 4096
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)

    const b1 = mk()
    const out1L = new Float32Array(N)
    const out1R = new Float32Array(N)
    b1.processStereo(inL, inR, out1L, out1R)

    const b2 = mk()
    const out2L = new Float32Array(N)
    const out2R = new Float32Array(N)
    for (let i = 0; i < N; i += 128) {
      b2.processStereo(
        inL.subarray(i, i + 128),
        inR.subarray(i, i + 128),
        out2L.subarray(i, i + 128),
        out2R.subarray(i, i + 128),
      )
    }
    expect(maxAbsDiff(out1L, out2L)).toBeLessThan(1e-6)
    expect(maxAbsDiff(out1R, out2R)).toBeLessThan(1e-6)
  })

  it('reset() 后流式状态清空（再喂入输出从头开始）', () => {
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    b.setConfig(makeConfig([speaker]))
    const N = 1024
    const inL = lowFreqSine(N)
    const inR = new Float32Array(N)
    const out1 = new Float32Array(N)
    const out2 = new Float32Array(N)
    b.processStereo(inL, inR, out1, out2)
    b.reset()
    const outA = new Float32Array(N)
    const outB = new Float32Array(N)
    b.processStereo(inL, inR, outA, outB)
    // reset 后与"从头开始"等价：前 512 样本为空
    for (let i = 0; i < PART; i++) {
      expect(Math.abs(outA[i])).toBeLessThan(1e-9)
    }
    expect(outA[PART + 100]).toBeGreaterThan(0)
  })
})

describe('nearestGridIndex 最近邻查表', () => {
  const grid = deltaGrid()

  it('精确命中与跨 180° 环绕', () => {
    expect(nearestGridIndex(grid, 30, 0)).toEqual({ azIdx: grid.azimuths.indexOf(30), elIdx: grid.elevations.indexOf(0) })
    expect(nearestGridIndex(grid, 0, 0)).toEqual({ azIdx: grid.azimuths.indexOf(0), elIdx: grid.elevations.indexOf(0) })
    // az=179 → 网格 -180（角距 1°）优先于 175（角距 4°）
    expect(nearestGridIndex(grid, 179, 0).azIdx).toBe(grid.azimuths.indexOf(-180))
  })

  it('仰角越界钳制', () => {
    expect(nearestGridIndex(grid, 0, 100).elIdx).toBe(grid.elevations.length - 1) // 钳到 90
    expect(nearestGridIndex(grid, 0, -100).elIdx).toBe(0) // 钳到 -40
  })
})

// ---------------------------------------------------------------------------
// 球谐插值（spherical）分支（规划书 §4.1；真实 KEMAR 网格）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 多普勒（§4.6，模式 C）：config.dopplerVelocity → 每扬声器 playback_rate 重采样
// ---------------------------------------------------------------------------
describe('TsConvolverBackend：多普勒（§4.6，模式 C）', () => {
  /** 正前方单扬声器（az=0 → dir=(0,0,1)），delta 网格（卷积即延迟 512） */
  const frontSpeaker: VirtualSpeaker = { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0 }

  it('dopplerRate 公式：c/(c−v·dir) 与 0.5..2.0 钳位、f32 量化', () => {
    // 正前方 dir=(0,0,1)：沿 +Z 速度 u → rate = c/(c−u)
    expect(dopplerRate({ x: 0, y: 0, z: 171.5 }, 0, 0, 1)).toBe(2) // c/(c−171.5) = 2.0 精确
    expect(dopplerRate({ x: 0, y: 0, z: -343 }, 0, 0, 1)).toBe(0.5) // c/(c+343) = 0.5 精确
    expect(dopplerRate({ x: 0, y: 0, z: 0 }, 0, 0, 1)).toBe(1)
    // 垂直方向（v·dir = 0）→ rate = 1
    expect(dopplerRate({ x: 343, y: 0, z: 0 }, 0, 0, 1)).toBe(1)
    // 超速钳位到 [0.5, 2.0]
    expect(dopplerRate({ x: 0, y: 0, z: 300 }, 0, 0, 1)).toBe(2) // c/(c−300) ≈ 7.98 → 钳 2
    expect(dopplerRate({ x: 0, y: 0, z: -500 }, 0, 0, 1)).toBe(0.5)
    // 斜向：v=(0,0,10)、dir=(0.5,0,√3/2) → m = −10·(√3/2)，factor = 343/(343−8.660)
    const r = dopplerRate({ x: 0, y: 0, z: 10 }, 0.5, 0, Math.sqrt(3) / 2)
    expect(r).toBeCloseTo(343 / (343 - 10 * (Math.sqrt(3) / 2)), 12)
    // f32 量化（Rust ABI 参数为 f32）：非精确 f32 的输入先量化
    const q = dopplerRate({ x: Math.fround(3.7), y: 0, z: 0 }, 0, 0, 1)
    expect(q).toBe(1) // 垂直方向仍为 1（量化不影响符号）
    expect(dopplerRate({ x: 3.7, y: 0, z: 0 }, 1, 0, 0)).toBeCloseTo(343 / (343 - Math.fround(3.7)), 12)
  })

  it('velocity=0（或垂直方向）与无 doppler 输出逐位相等（rate==1 直通）', () => {
    const N = 2048
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)
    const render = (vel: { x: number; y: number; z: number } | undefined): { outL: Float32Array; outR: Float32Array } => {
      const b = new TsConvolverBackend()
      b.loadHrtf(deltaGrid())
      b.setConfig(makeConfig([frontSpeaker], vel ? { dopplerVelocity: vel } : {}))
      const outL = new Float32Array(N)
      const outR = new Float32Array(N)
      b.processStereo(inL, inR, outL, outR)
      return { outL, outR }
    }
    const none = render(undefined)
    // 静止：rate = c/(c−0) = 1.0 精确 → 直通分支 → 逐位相等
    const zero = render({ x: 0, y: 0, z: 0 })
    expect(maxAbsDiff(none.outL, zero.outL)).toBe(0)
    expect(maxAbsDiff(none.outR, zero.outR)).toBe(0)
    // 垂直方向速度（speaker 正前方 dir=(0,0,1)，v=(5,0,0) → dot=0 → rate=1）同样直通
    const perp = render({ x: 5, y: 0, z: 0 })
    expect(maxAbsDiff(none.outL, perp.outL)).toBe(0)
    expect(maxAbsDiff(none.outR, perp.outR)).toBe(0)
  })

  it('多普勒激活时 128 分块与整块输出一致（重采样状态跨块连续、确定性）', () => {
    const vel = { x: 3.7, y: -1.2, z: 2.5 }
    const mk = (): TsConvolverBackend => {
      const b = new TsConvolverBackend()
      b.loadHrtf(deltaGrid())
      b.setConfig(makeConfig([frontSpeaker], { dopplerVelocity: vel }))
      return b
    }
    const N = 4096
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)
    const b1 = mk()
    const out1L = new Float32Array(N)
    const out1R = new Float32Array(N)
    b1.processStereo(inL, inR, out1L, out1R)
    const b2 = mk()
    const out2L = new Float32Array(N)
    const out2R = new Float32Array(N)
    for (let i = 0; i < N; i += 128) {
      b2.processStereo(
        inL.subarray(i, i + 128),
        inR.subarray(i, i + 128),
        out2L.subarray(i, i + 128),
        out2R.subarray(i, i + 128),
      )
    }
    expect(maxAbsDiff(out1L, out2L)).toBeLessThan(1e-6)
    expect(maxAbsDiff(out1R, out2R)).toBeLessThan(1e-6)
  })

  it('脉冲扫测：rate>1 时间压缩/输出提前（相对 rate<1），脉冲间距按 rate 压缩', () => {
    // speaker 正前方（dir=(0,0,1)）：沿 +Z 速度 u → rate = c/(c−u)——
    //   u=+171.5 → rate=2.0（接近：压缩/提前）；u=−343 → rate=0.5（远离：拉伸）。
    // 重采样初始延迟 START=512：rate=2 时输入脉冲 p 于输出 (p+512)/2−1 处读出
    // （512 样本瞬态窗内）；rate=0.5 时延迟线饱和后固定延迟 1021（p+1021 处读出）。
    // 再经 delta HRIR 分区卷积（延迟 512），输出峰值 = 读出位置 + 512。
    const N = 4096
    const inL = new Float32Array(N)
    const inR = new Float32Array(N)
    inL[200] = 1
    inL[400] = 1 // 两个脉冲，输入间距 200 样本
    const run = (vel: { x: number; y: number; z: number }): Float32Array => {
      const b = new TsConvolverBackend()
      b.loadHrtf(deltaGrid())
      b.setConfig(makeConfig([frontSpeaker], { dopplerVelocity: vel, amount: 1 }))
      const outL = new Float32Array(N)
      const outR = new Float32Array(N)
      b.processStereo(inL, inR, outL, outR)
      return outL
    }
    const peakAt = (out: Float32Array, from: number, to: number): number => {
      let best = from
      let bestV = -1
      for (let i = from; i < to; i++) {
        const v = Math.abs(out[i])
        if (v > bestV) {
          bestV = v
          best = i
        }
      }
      return best
    }
    const fast = run({ x: 0, y: 0, z: 171.5 }) // rate = 2.0
    const slow = run({ x: 0, y: 0, z: -343 }) // rate = 0.5
    // rate=2：脉冲 200/400 → 输出 (200+512)/2−1+512 = 867 / (400+512)/2−1+512 = 967
    const f1 = peakAt(fast, 800, 930)
    const f2 = peakAt(fast, 930, 1030)
    expect(Math.abs(f1 - 867)).toBeLessThanOrEqual(2)
    expect(Math.abs(f2 - 967)).toBeLessThanOrEqual(2)
    expect(f2 - f1).toBeCloseTo(100, 0) // 输入间距 200 → 输出 100：按 rate=2 压缩
    // rate=0.5：脉冲 200/400 → 输出 200+1021+512 = 1733 / 400+1021+512 = 1933
    const s1 = peakAt(slow, 1650, 1850)
    const s2 = peakAt(slow, 1850, 2050)
    expect(Math.abs(s1 - 1733)).toBeLessThanOrEqual(2)
    expect(Math.abs(s2 - 1933)).toBeLessThanOrEqual(2)
    expect(s2 - s1).toBeCloseTo(200, 0) // 饱和后无压缩（间距保持 200）
    // rate>1 输出提前（相对 rate<1：867 < 1733）
    expect(f1).toBeLessThan(s1)
  })

  it('reset() 后多普勒重采样状态清零（再喂入从初始延迟起播）', () => {
    const vel = { x: 0, y: 0, z: 171.5 } // rate = 2.0
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    b.setConfig(makeConfig([frontSpeaker], { dopplerVelocity: vel, amount: 1 }))
    const N = 2048
    const inL = new Float32Array(N)
    const inR = new Float32Array(N)
    inL[200] = 1
    b.processStereo(inL, inR, new Float32Array(N), new Float32Array(N))
    b.reset()
    const outL = new Float32Array(N)
    b.processStereo(inL, inR, outL, new Float32Array(N))
    // reset 后与从头开始等价：rate=2 下脉冲 200 → 输出 867（而非 512 后直通的 712）
    let best = 0
    let bestV = -1
    for (let i = 600; i < 1200; i++) {
      if (Math.abs(outL[i]) > bestV) {
        bestV = Math.abs(outL[i])
        best = i
      }
    }
    expect(Math.abs(best - 867)).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 房间模拟（§4.5 完整版：镜像声源法早期反射 1-3 阶 + FDN 晚期混响）
// 房间位于后端湿路内部（roomSim.ts，与 Rust 侧逐位对拍）：
//   out = ((1−amount)·dry + amount·(wetSum + roomAmount·(earlyBus + fdnOut)))·masterGain
// ---------------------------------------------------------------------------
describe('TsConvolverBackend：房间模拟（§4.5）', () => {
  const speaker: VirtualSpeaker = { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 }
  // 682ms @48kHz：远尾区相对响应早期已显著衰减（FDN 每秒幅度衰减 10^(-3/rt60)）
  const N = 32768

  /** 单冲激输入 + 房间配置渲染（amount=1 纯湿：房间位于湿路内部） */
  function render(room: RoomPreset, roomAmount: number, orders?: number): { outL: Float32Array; outR: Float32Array } {
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    if (orders !== undefined) b.setRoomEarlyOrders(orders)
    b.setConfig(makeConfig([speaker], { room, roomAmount, amount: 1 }))
    const inL = new Float32Array(N)
    inL[100] = 1 // 单冲激：delta 网格下卷积输出 = 延迟 512 的冲激（位置 612），房间尾音可测
    const inR = new Float32Array(N)
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    b.processStereo(inL, inR, outL, outR)
    return { outL, outR }
  }

  function energy(x: Float32Array, from: number, to: number): number {
    let e = 0
    for (let i = from; i < to; i++) e += x[i] * x[i]
    return e
  }

  it('room=off（或 roomAmount=0）与无房间输出逐位一致（回归：后端旁路，不引入任何算术）', () => {
    const base = render('off', 0)
    // room='off' 但 roomAmount>0：仍全旁路
    const offWithAmount = render('off', 0.8)
    expect(maxAbsDiff(base.outL, offWithAmount.outL)).toBe(0)
    expect(maxAbsDiff(base.outR, offWithAmount.outR)).toBe(0)
    // 非 off 预设但 roomAmount=0：同样旁路
    const zeroAmount = render('hall', 0)
    expect(maxAbsDiff(base.outL, zeroAmount.outL)).toBe(0)
    expect(maxAbsDiff(base.outR, zeroAmount.outR)).toBe(0)
  })

  it('room=studio/hall：房间贡献非零、尾部能量衰减（前 512 样本能量 > 后 512）、无 NaN', () => {
    for (const preset of ['studio', 'hall'] as const) {
      const withRoom = render(preset, 0.5)
      const without = render('off', 0)
      // 房间确实生效（与无房间输出不同，非空转）
      expect(maxAbsDiff(withRoom.outL, without.outL)).toBeGreaterThan(1e-4)
      expect(maxAbsDiff(withRoom.outR, without.outR)).toBeGreaterThan(1e-4)
      // 输出非零且全程无 NaN/Inf
      let m = 0
      for (let i = 0; i < N; i++) {
        if (!Number.isFinite(withRoom.outL[i]) || !Number.isFinite(withRoom.outR[i])) {
          throw new Error(`${preset}: NaN/Inf 出现于样本 ${i}`)
        }
        m = Math.max(m, Math.abs(withRoom.outL[i]), Math.abs(withRoom.outR[i]))
      }
      expect(m).toBeGreaterThan(1e-3)
      // 尾部能量衰减：响应早期区（直接湿路 612 + 早期反射/FDN 起点后）能量
      // > 远尾区（FDN 尾音）。早期区 [1536, 2048)：早期反射密集 + FDN 起振；
      // 远尾区 [N-512, N)：hall 2.2s → 682ms 处幅度衰减至 ~12%，studio 0.45s → ~0。
      const early = energy(withRoom.outL, 1536, 2048) + energy(withRoom.outR, 1536, 2048)
      const tail = energy(withRoom.outL, N - 512, N) + energy(withRoom.outR, N - 512, N)
      expect(early).toBeGreaterThan(tail * 10)
    }
  })

  it('early_orders=0 关闭早期反射：与 orders=2 输出不同且能量更低（只保留 FDN）', () => {
    const orders2 = render('hall', 0.5) // 默认 2
    const orders0 = render('hall', 0.5, 0)
    expect(maxAbsDiff(orders2.outL, orders0.outL)).toBeGreaterThan(1e-4)
    expect(maxAbsDiff(orders2.outR, orders0.outR)).toBeGreaterThan(1e-4)
    // 冲激输入下早期反射为纯正增益贡献（与直接湿路/FDN 的交叉项非负），
    // 开启早期反射的总能量严格更高
    const e2 = energy(orders2.outL, 1024, N) + energy(orders2.outR, 1024, N)
    const e0 = energy(orders0.outL, 1024, N) + energy(orders0.outR, 1024, N)
    expect(e0).toBeGreaterThan(0)
    expect(e2).toBeGreaterThan(e0)
  })

  it('房间 128 分块与整块输出一致（跨块确定性：历史环/FDN 状态跨块连续）', () => {
    const run = (chunked: boolean): { outL: Float32Array; outR: Float32Array } => {
      const b = new TsConvolverBackend()
      b.loadHrtf(deltaGrid())
      b.setConfig(makeConfig([speaker], { room: 'studio', roomAmount: 0.5, amount: 1 }))
      const inL = new Float32Array(N)
      inL[100] = 1
      const inR = new Float32Array(N)
      const outL = new Float32Array(N)
      const outR = new Float32Array(N)
      if (chunked) {
        for (let i = 0; i < N; i += 128) {
          b.processStereo(
            inL.subarray(i, i + 128),
            inR.subarray(i, i + 128),
            outL.subarray(i, i + 128),
            outR.subarray(i, i + 128),
          )
        }
      } else {
        b.processStereo(inL, inR, outL, outR)
      }
      return { outL, outR }
    }
    const a = run(true)
    const c = run(false)
    expect(maxAbsDiff(a.outL, c.outL)).toBeLessThan(1e-6)
    expect(maxAbsDiff(a.outR, c.outR)).toBeLessThan(1e-6)
  })
})

// ---------------------------------------------------------------------------
// 声源大小 size（§4.7 扩散声源，0..1）：方向模糊 + 双耳去相关
//   方向模糊：size>0 → HRIR 对 = az ± size·30° 两方向 50/50 混合（每耳）
//     （size=0 → 原方向单 HRIR，与现状逐位一致）；
//   双耳去相关：右耳源额外小数延迟 size·6 样本（一阶线性插值延迟线）。
// ---------------------------------------------------------------------------
describe('TsConvolverBackend：声源大小 size（扩散声源）', () => {
  /**
   * 方向相关网格：HRIR = δ·amp(az)，amp(az) = 1 + 0.05·(az/90)²（L=R 对称）。
   * az=0 → 1.0；az=±30 → 1.005556——size=1 模糊混合后 amp = 1.005556，
   * 能量比 ≈ 1.005556² ≈ 1.011（落在 0.9..1.1 内且与 size=0 输出明显不同）。
   */
  const blurGrid = (): HrtfGrid => {
    const azimuths: number[] = []
    for (let a = -90; a <= 90; a += 30) azimuths.push(a)
    const elevations = [0]
    const hrirLength = 4
    const n = elevations.length * azimuths.length
    const left = new Float32Array(n * hrirLength)
    const right = new Float32Array(n * hrirLength)
    for (let i = 0; i < n; i++) {
      const amp = 1 + 0.05 * Math.pow(azimuths[i] / 90, 2)
      left[i * hrirLength] = amp
      right[i * hrirLength] = amp
    }
    return { sampleRate: FS, azimuths, elevations, hrirLength, left, right }
  }

  const spk = (size: number): VirtualSpeaker => ({
    channel: 0,
    azimuthDeg: 0,
    elevationDeg: 0,
    distance: 1,
    gain: 1,
    size,
  })

  it('size=0 逐位回归：size 0→1→0 配置周期 + reset 后与全新 size=0 后端输出逐位相同（模糊/去相关状态不残留）', () => {
    const grid = blurGrid()
    const N = 2048
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)
    const fresh = new TsConvolverBackend()
    fresh.loadHrtf(grid)
    fresh.setConfig(makeConfig([spk(0)]))
    const refL = new Float32Array(N)
    const refR = new Float32Array(N)
    fresh.processStereo(inL, inR, refL, refR)

    const b = new TsConvolverBackend()
    b.loadHrtf(grid)
    b.setConfig(makeConfig([spk(1)]))
    b.processStereo(inL, inR, new Float32Array(N), new Float32Array(N))
    b.setConfig(makeConfig([spk(0)])) // size 变化 → 重载原方向单 HRIR（非模糊版）
    b.reset() // 清干路/滤波/去相关状态（loadIR 已重置卷积器）
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    b.processStereo(inL, inR, outL, outR)
    expect(maxAbsDiff(refL, outL)).toBe(0)
    expect(maxAbsDiff(refR, outR)).toBe(0)
  })

  it('size>0：右耳去相关生效——右耳脉冲峰值较左耳晚 size·6 样本（delta 网格，脉冲输入）', () => {
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    b.setConfig(makeConfig([spk(1)]))
    const N = 4096
    const inL = new Float32Array(N)
    inL[200] = 1
    const inR = new Float32Array(N)
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    b.processStereo(inL, inR, outL, outR)
    // delta 网格下方向模糊对输出无影响（两方向 HRIR 相同），湿路 = 延迟 512 的
    // 缩放脉冲：左耳峰值 200+512=712；右耳源额外延迟 size·6=6 → 峰值 718
    let lPeak = 0
    let rPeak = 0
    let lV = -1
    let rV = -1
    for (let i = 700; i < 740; i++) {
      if (Math.abs(outL[i]) > lV) {
        lV = Math.abs(outL[i])
        lPeak = i
      }
      if (Math.abs(outR[i]) > rV) {
        rV = Math.abs(outR[i])
        rPeak = i
      }
    }
    expect(lPeak).toBe(712)
    expect(rPeak).toBe(718)
  })

  it('size=1 方向模糊：与 size=0 输出不同（az±30° 混合 IR 生效）且能量比 0.9..1.1', () => {
    const grid = blurGrid()
    const N = 4096
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)
    const render = (size: number): { outL: Float32Array; outR: Float32Array } => {
      const b = new TsConvolverBackend()
      b.loadHrtf(grid)
      b.setConfig(makeConfig([spk(size)]))
      const outL = new Float32Array(N)
      const outR = new Float32Array(N)
      b.processStereo(inL, inR, outL, outR)
      return { outL, outR }
    }
    const s0 = render(0)
    const s1 = render(1)
    const START = PART + 128
    let e0 = 0
    let e1 = 0
    let md = 0
    for (let i = START; i < N; i++) {
      e0 += s0.outL[i] * s0.outL[i] + s0.outR[i] * s0.outR[i]
      e1 += s1.outL[i] * s1.outL[i] + s1.outR[i] * s1.outR[i]
      md = Math.max(md, Math.abs(s1.outL[i] - s0.outL[i]), Math.abs(s1.outR[i] - s0.outR[i]))
    }
    expect(md).toBeGreaterThan(1e-4) // 方向模糊确实生效（amp 1.005556 vs 1.0）
    expect(e1 / e0).toBeGreaterThan(0.9)
    expect(e1 / e0).toBeLessThan(1.1)
  })
})

// ---------------------------------------------------------------------------
// 时域卷积（契约 spatial_set_convolution_mode=time）：与分区模式同块调度同放行
//   （wet[t] = (x*h)[t−512]）——干湿对齐一致、脉冲位置一致，仅差 FFT 圆整（≤1e-4）
// ---------------------------------------------------------------------------
describe('TsConvolverBackend：时域卷积（convolution: time）', () => {
  const speaker: VirtualSpeaker = { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0 }

  it('脉冲位置与 partitioned 一致（±1）且输出差 ≤ 1e-4（FFT 圆整差异，非逐位）', () => {
    const grid = deltaGrid()
    const N = 4096
    const inL = new Float32Array(N)
    inL[200] = 1
    const inR = new Float32Array(N)
    const run = (convolution: 'partitioned' | 'time'): { outL: Float32Array; outR: Float32Array } => {
      const b = new TsConvolverBackend()
      b.loadHrtf(grid)
      b.setConfig(makeConfig([speaker], { convolution }))
      const outL = new Float32Array(N)
      const outR = new Float32Array(N)
      b.processStereo(inL, inR, outL, outR)
      return { outL, outR }
    }
    const p = run('partitioned')
    const t = run('time')
    const peakAt = (out: Float32Array): number => {
      let best = 700
      let bestV = -1
      for (let i = 700; i < 760; i++) {
        if (Math.abs(out[i]) > bestV) {
          bestV = Math.abs(out[i])
          best = i
        }
      }
      return best
    }
    expect(Math.abs(peakAt(t.outL) - peakAt(p.outL))).toBeLessThanOrEqual(1)
    expect(Math.abs(peakAt(t.outR) - peakAt(p.outR))).toBeLessThanOrEqual(1)
    expect(maxAbsDiff(p.outL, t.outL)).toBeLessThanOrEqual(1e-4)
    expect(maxAbsDiff(p.outR, t.outR)).toBeLessThanOrEqual(1e-4)
    // 两模式 getLatencySamples 均为 512（对齐设计保证）
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    b.setConfig(makeConfig([speaker], { convolution: 'time' }))
    expect(b.getLatencySamples()).toBe(PART)
  })

  it('time 模式块连续性：128 分块与整块输出一致（逐样本 ≤ 1e-6）', () => {
    const grid = deltaGrid()
    const N = 4096
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)
    const mk = (): TsConvolverBackend => {
      const b = new TsConvolverBackend()
      b.loadHrtf(grid)
      b.setConfig(makeConfig([speaker], { convolution: 'time' }))
      return b
    }
    const b1 = mk()
    const out1L = new Float32Array(N)
    const out1R = new Float32Array(N)
    b1.processStereo(inL, inR, out1L, out1R)
    const b2 = mk()
    const out2L = new Float32Array(N)
    const out2R = new Float32Array(N)
    for (let i = 0; i < N; i += 128) {
      b2.processStereo(
        inL.subarray(i, i + 128),
        inR.subarray(i, i + 128),
        out2L.subarray(i, i + 128),
        out2R.subarray(i, i + 128),
      )
    }
    expect(maxAbsDiff(out1L, out2L)).toBeLessThan(1e-6)
    expect(maxAbsDiff(out1R, out2R)).toBeLessThan(1e-6)
  })
})

// ---------------------------------------------------------------------------
// 遮挡/衍射简化（§4.7，契约 spatial_set_occlusion）：config.occlusionAmount
//   每 speaker 增益衰减 gain·(1 − 0.8·occlusion) + 空气式低通
//   fc = 12000·(1−occlusion) Hz（钳位 ≥1Hz；occlusion=0 全旁路）
// ---------------------------------------------------------------------------
describe('TsConvolverBackend：遮挡（occlusionAmount）', () => {
  const speaker: VirtualSpeaker = { channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0 }

  it('occlusion=0 回归：occlusionAmount:0 与缺省输出逐位相同（旁路，不引入任何算术）', () => {
    const N = 2048
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)
    const run = (occ?: number): { outL: Float32Array; outR: Float32Array } => {
      const b = new TsConvolverBackend()
      b.loadHrtf(deltaGrid())
      b.setConfig(makeConfig([speaker], occ !== undefined ? { occlusionAmount: occ } : {}))
      const outL = new Float32Array(N)
      const outR = new Float32Array(N)
      b.processStereo(inL, inR, outL, outR)
      return { outL, outR }
    }
    const none = run()
    const zero = run(0)
    expect(maxAbsDiff(none.outL, zero.outL)).toBe(0)
    expect(maxAbsDiff(none.outR, zero.outR)).toBe(0)
  })

  it('occlusion=1：低频（DC）稳态增益 ≈ 0.2；高频（8kHz）被强烈低通（< 0.05×）', () => {
    // N=1s：遮挡低通 fc=1Hz（钳位下界）一阶 τ≈0.16s，末段 0.83s 起已稳态
    const N = 48000
    const run = (occ: number, signal: (i: number) => number): Float32Array => {
      const b = new TsConvolverBackend()
      b.loadHrtf(deltaGrid())
      b.setConfig(makeConfig([speaker], { occlusionAmount: occ }))
      const inL = new Float32Array(N)
      const inR = new Float32Array(N)
      for (let i = 0; i < N; i++) {
        inL[i] = signal(i)
        inR[i] = signal(i)
      }
      const outL = new Float32Array(N)
      b.processStereo(inL, inR, outL, new Float32Array(N))
      return outL
    }
    // DC 稳态：out = 0.5·distGain(1)·(1−0.8·occ)——occ=0 → 0.5；occ=1 → 0.1
    const dc0 = run(0, () => 0.5)
    const dc1 = run(1, () => 0.5)
    let avg0 = 0
    let avg1 = 0
    for (let i = 40000; i < N; i++) {
      avg0 += dc0[i]
      avg1 += dc1[i]
    }
    avg0 /= 8000
    avg1 /= 8000
    expect(avg0).toBeCloseTo(0.5, 2)
    expect(avg1).toBeCloseTo(0.1, 2)
    expect(avg1 / avg0).toBeCloseTo(0.2, 2) // 增益衰减 ≈ 0.2
    // 8kHz：occ=1 时 fc=1Hz 低通强烈衰减（远低于 0.05× 无遮挡）
    const hi0 = run(0, (i) => 0.4 * Math.sin((2 * Math.PI * 8000 * i) / FS))
    const hi1 = run(1, (i) => 0.4 * Math.sin((2 * Math.PI * 8000 * i) / FS))
    let amp0 = 0
    let amp1 = 0
    for (let i = 40000; i < N; i++) {
      amp0 = Math.max(amp0, Math.abs(hi0[i]))
      amp1 = Math.max(amp1, Math.abs(hi1[i]))
    }
    expect(amp1).toBeLessThan(0.05 * amp0)
  })
})

// ---------------------------------------------------------------------------
// 多声道输入 processMulti（② 多声道输入/输出）：N 路单声道输入 → 双耳
//   - 与 processStereo 同算法仅输入侧扩展：speaker.channel < inputs.length 取对应
//     输入，越界取 0 号；干路 = 0/1 号输入；
//   - 相同 speaker 配置下 2 路输入与 processStereo 输出逐位一致（回归）；
//   - 6 路输入各声道独立（脉冲只进 channel 3 → 只有 channel 3 扬声器出声）。
// ---------------------------------------------------------------------------
describe('TsConvolverBackend：多声道输入 processMulti（②）', () => {
  it('2 路输入与 processStereo 逐位一致（相同 speaker 配置：含房间/多普勒/大小，全链路回归）', () => {
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    // instant 标准布局（channel 0/1）+ 完整渲染链（房间 + 多普勒 + 声源大小）
    const config = makeConfig(
      [
        { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0.4 },
        { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 0.9, size: 0 },
      ],
      { amount: 0.7, room: 'studio', roomAmount: 0.3, dopplerVelocity: { x: 3.7, y: -1.2, z: 2.5 } },
    )
    b.setConfig(config)
    const N = 4096
    const inL = lowFreqSine(N)
    const inR = lowFreqSine(N, 7)
    const outA = [new Float32Array(N), new Float32Array(N)]
    const outB = [new Float32Array(N), new Float32Array(N)]
    b.processStereo(inL, inR, outA[0], outA[1])
    b.reset()
    b.processMulti([inL, inR], outB[0], outB[1])
    expect(maxAbsDiff(outA[0], outB[0])).toBe(0) // 逐位一致
    expect(maxAbsDiff(outA[1], outB[1])).toBe(0)
  })

  it('6 路输入各声道独立：脉冲只进 channel 3 → 输出 = 仅 channel 3 扬声器的响应（其余静音）', () => {
    // 6 只全增益扬声器（channel 0..5 各占一路；multichannelLayout 的 LFE 占位
    // 静音语义见 fusion 测试——此处验证「逐声道路由」的独立性本身）
    const speakers: VirtualSpeaker[] = [0, 1, 2, 3, 4, 5].map((ch) => ({
      channel: ch,
      azimuthDeg: ch === 2 ? 0 : ch * 30,
      elevationDeg: 0,
      distance: 1.5,
      gain: 1,
      size: 0,
    }))
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    b.setConfig(makeConfig(speakers, { amount: 1 })) // 纯湿：干路（0/1 号输入为静音）无贡献
    const N = 2048
    const inputs: Float32Array[] = []
    for (let i = 0; i < 6; i++) inputs.push(new Float32Array(N))
    inputs[3][200] = 1 // 脉冲只进 channel 3
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    b.processMulti(inputs, outL, outR)
    // 期望输出 = channel 3 扬声器（delta 网格：卷积延迟 512）的空气吸收脉冲响应：
    //   y[i] = fade(i)·g·(1−a)·a^(i−712)，i ≥ 712；g = distGain(1.5m, inverse) = 2/3，
    //   a = exp(−2π·fc/fs)，fc = 4000/(1+d) = 4000/2.5 = 1600 Hz；
    //   fade(i) = 首次装载淡入（放行恢复 512 起 256 样本线性到 1，爆音修复）；
    //   其余样本（含前 512 延迟空白）为 0
    const g = 2 / 3
    const a = Math.exp((-2 * Math.PI * 1600) / FS)
    const fade = (i: number): number => (i < 512 ? 0 : Math.min(1, (i - 511) / 256))
    for (let i = 0; i < N; i++) {
      const expected = i < 712 ? 0 : fade(i) * g * (1 - a) * Math.pow(a, i - 712)
      expect(Math.abs(outL[i] - expected)).toBeLessThan(1e-6)
      expect(Math.abs(outR[i] - expected)).toBeLessThan(1e-6)
    }
    // 声道独立性反向验证：脉冲进 channel 1 → channel 1 扬声器出声、其余静音
    // （输出与上述同形——距离/增益相同，仅路由声道不同）
    const b2 = new TsConvolverBackend()
    b2.loadHrtf(deltaGrid())
    b2.setConfig(makeConfig(speakers, { amount: 1 }))
    const inputs2: Float32Array[] = []
    for (let i = 0; i < 6; i++) inputs2.push(new Float32Array(N))
    inputs2[1][200] = 1
    const out2 = [new Float32Array(N), new Float32Array(N)]
    b2.processMulti(inputs2, out2[0], out2[1])
    for (let i = 0; i < N; i++) {
      const expected = i < 712 ? 0 : fade(i) * g * (1 - a) * Math.pow(a, i - 712)
      expect(Math.abs(out2[0][i] - expected)).toBeLessThan(1e-6)
      expect(Math.abs(out2[1][i] - expected)).toBeLessThan(1e-6)
    }
    // LFE 静音占位（multichannelLayout 语义）：channel 3 扬声器 gain=0 → 脉冲进
    // channel 3 时输出全静音（LFE 信号忽略，不渲染）
    const b3 = new TsConvolverBackend()
    b3.loadHrtf(deltaGrid())
    b3.setConfig(
      makeConfig(
        [
          { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 2, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 3, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 0, size: 0 }, // LFE 占位
          { channel: 4, azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
          { channel: 5, azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
        ],
        { amount: 1 },
      ),
    )
    const inputs3: Float32Array[] = []
    for (let i = 0; i < 6; i++) inputs3.push(new Float32Array(N))
    inputs3[3][200] = 1
    const out3 = [new Float32Array(N), new Float32Array(N)]
    b3.processMulti(inputs3, out3[0], out3[1])
    for (let i = 0; i < N; i++) {
      expect(Math.abs(out3[0][i])).toBeLessThan(1e-9) // LFE 占位静音：全输出为 0
      expect(Math.abs(out3[1][i])).toBeLessThan(1e-9)
    }
  })

  it('越界 channel 取 0 号输入：4 路输入下 channel 4/5 扬声器路由到输入 0（脉冲进输入 0 三只同响）', () => {
    const speakers: VirtualSpeaker[] = [
      { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 2, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 3, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 0, size: 0 }, // LFE 占位
      { channel: 4, azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 5, azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    ]
    const b = new TsConvolverBackend()
    b.loadHrtf(deltaGrid())
    b.setConfig(makeConfig(speakers, { amount: 1 }))
    const N = 2048
    const inputs: Float32Array[] = []
    for (let i = 0; i < 4; i++) inputs.push(new Float32Array(N))
    inputs[0][200] = 1 // 脉冲只进输入 0
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    b.processMulti(inputs, outL, outR)
    // channel 0（FL）、4（SL）、5（SR）均路由到输入 0 → 三只同源相干求和。湿总线
    // 能量归一化（爆音修复）：组内 1/√(Σ g²) 缩放——三只各 2/3 → 组和
    // 3·(2/3)·(1/√(3·(2/3)²)) = √3（能量守恒，替代旧的无归一化和 2.0 超幅）；
    // 输出另乘首次装载淡入 fade(i)（放行恢复 512 起 256 样本线性到 1）；
    // fc = 4000/(1+1.5) = 1600 Hz
    const g = Math.sqrt(3)
    const a = Math.exp((-2 * Math.PI * 1600) / FS)
    const fade = (i: number): number => (i < 512 ? 0 : Math.min(1, (i - 511) / 256))
    for (let i = 0; i < N; i++) {
      const expected = i < 712 ? 0 : fade(i) * g * (1 - a) * Math.pow(a, i - 712)
      expect(Math.abs(outL[i] - expected)).toBeLessThan(1e-6)
      expect(Math.abs(outR[i] - expected)).toBeLessThan(1e-6)
    }
  })

  it('块连续性：6 路输入 128 分块与整块输出一致（逐样本 ≤ 1e-6）', () => {
    const speakers: VirtualSpeaker[] = [
      { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 2, azimuthDeg: 0, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 4, azimuthDeg: -110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
      { channel: 5, azimuthDeg: 110, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
    ]
    const N = 4096
    const inputs: Float32Array[] = []
    for (let i = 0; i < 6; i++) inputs.push(lowFreqSine(N, 10 + i * 3))
    const mk = () => {
      const b = new TsConvolverBackend()
      b.loadHrtf(deltaGrid())
      b.setConfig(makeConfig(speakers, { amount: 1 }))
      return b
    }
    const b1 = mk()
    const out1 = [new Float32Array(N), new Float32Array(N)]
    b1.processMulti(inputs, out1[0], out1[1])
    const b2 = mk()
    const out2 = [new Float32Array(N), new Float32Array(N)]
    for (let i = 0; i < N; i += 128) {
      b2.processMulti(
        inputs.map((x) => x.subarray(i, i + 128)),
        out2[0].subarray(i, i + 128),
        out2[1].subarray(i, i + 128),
      )
    }
    expect(maxAbsDiff(out1[0], out2[0])).toBeLessThan(1e-6)
    expect(maxAbsDiff(out1[1], out2[1])).toBeLessThan(1e-6)
  })
})

// ---------------------------------------------------------------------------
// 契约函数 getHrir（规划书 §3.2）：查询指定方向 HRIR 对
//   - nearest：返回与网格该方向 HRIR 逐位一致（与 setConfig 装载分支同路径）；
//   - spherical：与 hrtfInterp.sphericalHrtf 输出逐位一致（同一函数同一路径）；
//   - 与 WasmHrtfBackend.getHrir 对拍（同一 KEMAR 网格/模式：nearest 逐位、
//     spherical ≤ 1e-5——Rust 侧 spatial_get_hrir 与 build_speaker 装载分支同源）。
// ---------------------------------------------------------------------------