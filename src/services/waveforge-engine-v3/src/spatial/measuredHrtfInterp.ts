/**
 * 不等距实测 HRTF 插值。先对齐各耳主到达时间，再在相邻测量方向混合脉冲，
 * 避免直接相加不同时延的 HRIR 产生梳状滤波。网格点保持原测量逐样本不变。
 * 查询仅在配置变化时运行，不进入 PCM 逐样本热路径。
 */
import type { HrtfGrid } from './types'

const peaks = new WeakMap<HrtfGrid, { left: Int16Array; right: Int16Array }>()

function wrapAzimuth(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180
}

function ringAt(grid: HrtfGrid, elevation: number): number {
  const rings = grid.rings!
  let closest = 0
  let distance = Infinity
  for (let i = 0; i < rings.length; i++) {
    const d = Math.abs(elevation - rings[i].elevation)
    if (d < distance) { distance = d; closest = i }
  }
  return closest
}

function nearestInRing(azimuths: number[], azimuth: number): number {
  let closest = 0
  let distance = Infinity
  for (let i = 0; i < azimuths.length; i++) {
    const delta = Math.abs(azimuth - azimuths[i])
    const d = Math.min(delta, 360 - delta)
    if (d < distance) { distance = d; closest = i }
  }
  return closest
}

/** 返回扁平 HRIR 方向索引，供后端 nearest 模式直接加载测量段。 */
export function nearestMeasuredIndex(grid: HrtfGrid, azimuthDeg: number, elevationDeg: number): number {
  if (!grid.rings?.length) throw new Error('实测 HRTF 缺少采样环')
  const ring = grid.rings[ringAt(grid, elevationDeg)]
  return ring.offset + nearestInRing(ring.azimuths, wrapAzimuth(azimuthDeg))
}

function angularBracket(angles: number[], angle: number): { a: number; b: number; t: number } {
  if (angles.length === 1) return { a: 0, b: 0, t: 0 }
  const last = angles.length - 1
  if (angle < angles[0]) {
    const lo = angles[last] - 360
    return { a: last, b: 0, t: (angle - lo) / (angles[0] - lo) }
  }
  for (let i = 0; i < last; i++) {
    if (angle <= angles[i + 1]) {
      return { a: i, b: i + 1, t: (angle - angles[i]) / (angles[i + 1] - angles[i]) }
    }
  }
  return { a: last, b: 0, t: (angle - angles[last]) / (angles[0] + 360 - angles[last]) }
}

function getPeaks(grid: HrtfGrid): { left: Int16Array; right: Int16Array } {
  const cached = peaks.get(grid)
  if (cached) return cached
  const count = grid.left.length / grid.hrirLength
  const result = { left: new Int16Array(count), right: new Int16Array(count) }
  const length = grid.hrirLength
  for (let direction = 0; direction < count; direction++) {
    let maxL = -1
    let maxR = -1
    for (let i = 0; i < length; i++) {
      const l = Math.abs(grid.left[direction * length + i])
      const r = Math.abs(grid.right[direction * length + i])
      if (l > maxL) { maxL = l; result.left[direction] = i }
      if (r > maxR) { maxR = r; result.right[direction] = i }
    }
  }
  peaks.set(grid, result)
  return result
}

function sample(plane: Float32Array, offset: number, length: number, index: number): number {
  const lo = Math.floor(index)
  const frac = index - lo
  const x0 = lo < 0 || lo >= length ? 0 : plane[offset + lo]
  if (frac === 0) return x0
  const x1 = lo + 1 < 0 || lo + 1 >= length ? 0 : plane[offset + lo + 1]
  return x0 + (x1 - x0) * frac
}

export function interpolateMeasuredHrtf(
  grid: HrtfGrid, azimuthDeg: number, elevationDeg: number,
  outL: Float32Array, outR: Float32Array,
): void {
  const rings = grid.rings
  if (!rings?.length || outL.length !== grid.hrirLength || outR.length !== grid.hrirLength) {
    throw new Error('实测 HRTF 网格或输出长度无效')
  }
  const azimuth = wrapAzimuth(azimuthDeg)
  const elevation = Math.max(rings[0].elevation, Math.min(rings[rings.length - 1].elevation, elevationDeg))
  let upper = 0
  while (upper < rings.length - 1 && rings[upper].elevation < elevation) upper++
  const lower = upper > 0 ? upper - 1 : upper
  const elT = lower === upper ? 0 : (elevation - rings[lower].elevation) /
    (rings[upper].elevation - rings[lower].elevation)
  const indices = new Int32Array(4)
  const weights = new Float64Array(4)
  for (let i = 0; i < 2; i++) {
    const ring = rings[i ? upper : lower]
    const { a, b, t } = angularBracket(ring.azimuths, azimuth)
    const elWeight = i ? elT : 1 - elT
    indices[i * 2] = ring.offset + a
    indices[i * 2 + 1] = ring.offset + b
    weights[i * 2] = elWeight * (1 - t)
    weights[i * 2 + 1] = elWeight * t
  }
  const arrival = getPeaks(grid)
  const length = grid.hrirLength
  const interpolateEar = (plane: Float32Array, peak: Int16Array, out: Float32Array): void => {
    let targetPeak = 0
    for (let k = 0; k < 4; k++) targetPeak += weights[k] * peak[indices[k]]
    for (let t = 0; t < length; t++) {
      let value = 0
      for (let k = 0; k < 4; k++) {
        const weight = weights[k]
        if (weight === 0) continue
        const index = indices[k]
        value += weight * sample(plane, index * length, length, t + peak[index] - targetPeak)
      }
      out[t] = value
    }
  }
  interpolateEar(grid.left, arrival.left, outL)
  interpolateEar(grid.right, arrival.right, outR)
}
