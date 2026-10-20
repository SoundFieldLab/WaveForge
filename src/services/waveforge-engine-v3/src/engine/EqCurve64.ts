/**
 * EqCurve64 —— 64 段图形 EQ 曲线生成（内置场景预设与预设库共用）
 *
 * 设计（2026-10-20 重新设计）：
 *  - 锚点改为「音乐内容频点」而非旧 10 段网格：底鼓 50–80Hz / 2–4kHz beater，
 *    军鼓 200–240Hz 厚度 + 5kHz crack，贝斯 60–80Hz 下潜 + 700–1000Hz attack，
 *    人声 120Hz 厚度 + 1–4kHz presence + 5kHz / 7–10kHz sibilance，
 *    镲片 7.5–10kHz，空气感 12–16kHz（参考 Bobby Owsinski / SoundGadget EQ 频点表）；
 *  - 64 个频点本身落在 20Hz–16kHz（可听 / 音乐内容频段），不再分配 16kHz 以上的超声频段；
 *    这样每一段都有人耳可听的内容，不会出现「拉满也没声音」的空段；
 *  - 锚点在对数频率轴上线性插值，增益保留 0.1dB；Q=8.9（约 1/6 倍频程临界 Q），
 *    由 EqChain 的级联 Q 补偿把实际响应压回目标曲线。
 */

import { PRO_EQ_64_BANDS, type EqBand } from '../types'

/** 64 段（约 1/6 倍频程）图形 EQ 的默认 Q；与 EqChain 级联 Q 补偿配合。 */
export const EQ_64_Q = 9.4

/** 可听 / 音乐内容频段；64 段频点全部落在此区间内。 */
export const EQ_TRIM_LOW_HZ = 20
export const EQ_TRIM_HIGH_HZ = 16000

export type EqCurveAnchor = readonly [frequency: number, gainDb: number]

function interpolateLogDb(anchors: ReadonlyArray<EqCurveAnchor>, frequency: number): number {
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

/**
 * 用音乐频点锚点生成完整 64 段 EQ 数据。
 * @param anchors 频点锚点（Hz, dB），内部按频率排序；建议覆盖 30Hz–16kHz
 */
export function buildEq64Curve(anchors: ReadonlyArray<EqCurveAnchor>): EqBand[] {
  if (anchors.length === 0) return PRO_EQ_64_BANDS.map((frequency) => ({ frequency, gain: 0, q: EQ_64_Q }))
  const sorted = [...anchors].sort((a, b) => a[0] - b[0])
  return PRO_EQ_64_BANDS.map((frequency) => {
    // 可听区之外不做任何微调；UI 仍保留对应频段供手动调整。
    if (frequency < EQ_TRIM_LOW_HZ || frequency > EQ_TRIM_HIGH_HZ) return { frequency, gain: 0, q: EQ_64_Q }
    const gain = Number(interpolateLogDb(sorted, frequency).toFixed(1))
    // 归一化 -0：分享串往返用 Object.is 比较，-0 与 0 会被判为不等。
    return { frequency, gain: gain === 0 ? 0 : gain, q: EQ_64_Q }
  })
}
