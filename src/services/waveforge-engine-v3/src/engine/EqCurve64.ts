/**
 * EqCurve64 —— 64 段图形 EQ 曲线生成（内置场景预设与预设库共用）
 *
 * 设计：
 *  - 历史 10 段锚点（PRO_EQ_DEFAULT_BANDS）继续承担主体听感目标；
 *  - trims 是场景/预设专属的窄带微调锚点（相对主体曲线的 ±dB 增量），
 *    让 64 段数据不是简单插值，而是带特征的细调；
 *  - 全频点在对数频率轴线性插值，增益保留 0.1dB；Q 取约 1/6 倍频程的临界 Q，
 *    由 EqChain 的级联 Q 补偿把实际响应压回目标曲线。
 */

import { PRO_EQ_64_BANDS, PRO_EQ_DEFAULT_BANDS, type EqBand } from '../types'

/** 64 段（约 1/6 倍频程）图形 EQ 的默认 Q；与 EqChain 级联 Q 补偿配合。 */
export const EQ_64_Q = 8.9

function interpolateLogDb(anchors: ReadonlyArray<readonly [number, number]>, frequency: number): number {
  if (frequency <= anchors[0][0]) return anchors[0][1]
  const last = anchors[anchors.length - 1]
  if (frequency >= last[0]) return last[1]
  for (let i = 1; i < anchors.length; i++) {
    const [f0, g0] = anchors[i - 1]
    const [f1, g1] = anchors[i]
    if (frequency > f1) continue
    const t = Math.log(frequency / f0) / Math.log(f1 / f0)
    return g0 + (g1 - g0) * t
  }
  return last[1]
}

/** 以 10 个旧锚点 + 可选窄带 trims 生成完整 64 段 EQ 数据。 */
export function buildEq64Curve(
  gains10: readonly number[],
  trims: ReadonlyArray<readonly [number, number]> = [],
): EqBand[] {
  const baseAnchors = PRO_EQ_DEFAULT_BANDS.map((frequency, index) =>
    [frequency, gains10[index] ?? 0] as [number, number])
  const trimAnchors = trims.map(([frequency, delta]) =>
    [frequency, interpolateLogDb(baseAnchors, frequency) + delta] as [number, number])
  const anchors = [...baseAnchors, ...trimAnchors].sort((a, b) => a[0] - b[0])
  return PRO_EQ_64_BANDS.map((frequency) => {
    const gain = Number(interpolateLogDb(anchors, frequency).toFixed(1))
    // 归一化 -0：分享串往返用 Object.is 比较，-0 与 0 会被判为不等。
    return { frequency, gain: gain === 0 ? 0 : gain, q: EQ_64_Q }
  })
}
