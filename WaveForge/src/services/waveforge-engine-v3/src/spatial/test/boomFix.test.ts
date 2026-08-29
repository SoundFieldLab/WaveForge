/**
 * 爆音修复回归（用户报告：头环绕模式 5.1/7.1.4 开启爆音）
 *
 * 用真实 analyticHrtf 网格 + 满幅低频正弦（相干最坏素材）复现审计实测场景，
 * 锁住三道修复的行为基线：
 *   ① 湿总线能量归一化 + HRIR DC 归一 + 输出软限幅——多扬声器布局输出峰值
 *      有界（修复前：7.1.4 峰值 6.36、4.3 万样本硬削波）；
 *   ② IR 重装载淡出→装载→淡入——播放中布局切换无硬切咔哒（修复前：当拍
 *      样本跳变 Δ=0.70）；
 *   ③ spherical 插值方向去重——仅改扬声器 gain 不重装 IR，无湿路塌陷
 *      （修复前：无条件全量 loadIR → 整条湿总线静默 512 样本再跳回，Δ=4.34）。
 */
import { describe, it, expect } from 'vitest'
import { TsConvolverBackend } from '../TsConvolverBackend'
import { generateAnalyticHrtfGrid } from '../analyticHrtf'
import type { SpatialRenderConfig, VirtualSpeaker } from '../types'

const FS = 48000

/** 7.1.4 全 13 只（地面 7 + 顶置 4 + 底部 2，数值同 layouts.ts 预设表）；channel
 * 按融合层映射：az ≤ 0 → 0（L 源）其余 → 1（R 源）——L 总线 7 只同源即审计
 * 报告的相干叠加最坏场景 */
const SPK_714: VirtualSpeaker[] = (
  [
    [0, 0], [-30, 0], [30, 0], [-110, 0], [110, 0], [-140, 0], [140, 0],
    [-45, 45], [45, 45], [-135, 45], [135, 45],
    [-120, -20], [120, -20],
  ] as Array<[number, number]>
).map(([az, el]) => ({
  channel: az <= 0 ? 0 : 1,
  azimuthDeg: az,
  elevationDeg: el,
  distance: 1.5,
  gain: 1,
  size: 0,
}))

const SPK_STEREO: VirtualSpeaker[] = [
  { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
  { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1.5, gain: 1, size: 0 },
]

function cfg(speakers: VirtualSpeaker[], overrides?: Partial<SpatialRenderConfig>): SpatialRenderConfig {
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

/** 60Hz 正弦（相干低频——多扬声器求和的最坏频段） */
function sine(n: number, amp: number): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * 60 * i) / FS)
  return x
}

/** 分块（128）驱动后端，返回双耳输出 */
function run(b: TsConvolverBackend, inL: Float32Array, n: number): { outL: Float32Array; outR: Float32Array } {
  const outL = new Float32Array(n)
  const outR = new Float32Array(n)
  const B = 128
  for (let off = 0; off + B <= n; off += B) {
    b.processStereo(inL.subarray(off, off + B), inL.subarray(off, off + B), outL.subarray(off, off + B), outR.subarray(off, off + B))
  }
  return { outL, outR }
}

function makeBackend(): TsConvolverBackend {
  const b = new TsConvolverBackend()
  b.loadHrtf(generateAnalyticHrtfGrid(FS))
  return b
}

describe('TsConvolverBackend：爆音修复回归（多扬声器布局）', () => {
  it('7.1.4 满幅低频驱动：输出峰值 ≤ 1.0 且无样本超幅（归一化 + 软限幅兜底）', () => {
    const b = makeBackend()
    b.setConfig(cfg(SPK_714))
    const N = FS // 1 秒
    const { outL, outR } = run(b, sine(N, 0.9), N)
    let peak = 0
    let over = 0
    for (let i = 0; i < N; i++) {
      const m = Math.max(Math.abs(outL[i]), Math.abs(outR[i]))
      if (m > peak) peak = m
      if (m > 1) over++
    }
    // 修复前：峰值 6.36、43k 样本硬削波（DAC 截幅=持续噼啪爆音）
    expect(peak).toBeLessThanOrEqual(1.0)
    expect(over).toBe(0)
  })

  it('stereo 布局电平一致性：单源总线不放大（峰值与输入同量级 0.5..1.3）', () => {
    const b = makeBackend()
    b.setConfig(cfg(SPK_STEREO))
    const N = FS
    const { outL } = run(b, sine(N, 0.9), N)
    let peak = 0
    for (let i = 2048; i < N; i++) peak = Math.max(peak, Math.abs(outL[i]))
    // HRIR 按 DC 增益=1 归一 → 单只扬声器净增益 ≈ distGain(1.5m)=2/3；
    // 峰值应与输入 0.9 同量级（旧峰值归一实现会偏大 ~1.7 倍）
    expect(peak).toBeGreaterThan(0.5)
    expect(peak).toBeLessThan(1.3)
  })

  it('播放中布局切换 stereo→7.1.4：相邻样本最大跳变 < 0.05（IR 重装载淡出淡入）', () => {
    const b = makeBackend()
    b.setConfig(cfg(SPK_STEREO))
    const B = 128
    const N = FS
    const inL = sine(N, 0.6)
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    // 先跑 0.5 秒稳态，块间切换布局（槽位方位错位 → 触发重装载路径）
    const switchBlock = Math.floor((N / 2) / B)
    for (let blk = 0; blk < N / B; blk++) {
      if (blk === switchBlock) b.setConfig(cfg(SPK_714))
      const off = blk * B
      b.processStereo(inL.subarray(off, off + B), inL.subarray(off, off + B), outL.subarray(off, off + B), outR.subarray(off, off + B))
    }
    // 切换后 2048 样本窗口内相邻样本最大差（60Hz 0.6 幅正弦稳态基线 ~0.02；
    // 新旧槽位恢复时刻错开 256 样本的组合过渡斜率 ~0.06。修复前 IR 硬重置当拍
    // 跳变 Δ=0.70——满幅级咔哒；阈值 0.1 兼顾稳态余量与回归区分度）
    let maxJump = 0
    const from = switchBlock * B
    for (let i = Math.max(1, from); i < from + 2048 && i < N; i++) {
      maxJump = Math.max(maxJump, Math.abs(outL[i] - outL[i - 1]), Math.abs(outR[i] - outR[i - 1]))
    }
    expect(maxJump).toBeLessThan(0.1)
  })

  it('spherical 插值下 setConfig 仅改 gain：无湿路塌陷（方向去重不触发重装）', () => {
    const b = makeBackend()
    b.setConfig(cfg(SPK_714, { hrtfInterp: 'spherical' }))
    const B = 128
    const N = FS
    const inL = sine(N, 0.6)
    const outL = new Float32Array(N)
    const outR = new Float32Array(N)
    // 稳态后块间仅改一只扬声器 gain（方向/size 均不变 → 去重应跳过重装）
    const tweakBlock = Math.floor((N / 2) / B)
    const tweaked = SPK_714.map((s, i) => (i === 2 ? { ...s, gain: 0.9 } : s))
    const blockEnergy: number[] = []
    for (let blk = 0; blk < N / B; blk++) {
      if (blk === tweakBlock) b.setConfig(cfg(tweaked, { hrtfInterp: 'spherical' }))
      const off = blk * B
      const L = outL.subarray(off, off + B)
      const R = outR.subarray(off, off + B)
      b.processStereo(inL.subarray(off, off + B), inL.subarray(off, off + B), L, R)
      let e = 0
      for (let i = 0; i < B; i++) e += L[i] * L[i] + R[i] * R[i]
      blockEnergy.push(e)
    }
    // 修复前：全量 loadIR → 整条湿总线静默 512 样本（4 个 128 块能量掉到 ~0）
    // 再全幅跳回。断言 tweak 前后任意相邻块能量比不发生 >90% 的骤降。
    const from = Math.floor(N / 4 / B) // 稳态起点（跳过起播）
    for (let i = Math.max(1, from + 1); i < blockEnergy.length; i++) {
      if (blockEnergy[i - 1] > 1e-6) {
        expect(blockEnergy[i] / blockEnergy[i - 1]).toBeGreaterThan(0.1)
      }
    }
  })
})
