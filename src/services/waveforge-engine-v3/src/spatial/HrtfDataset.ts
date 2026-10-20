import { Resampler } from '../dsp/Resampler'
import type { HrtfGrid } from './types'

/** 控制线程校验及重采样；数据不进入参数 JSON 或分享串。 */
export function prepareHrtfGrid(grid: HrtfGrid, sampleRate: number): HrtfGrid {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
    !Number.isFinite(grid.sampleRate) || grid.sampleRate < 8000 || grid.sampleRate > 192000 ||
    !Number.isInteger(grid.hrirLength) || grid.hrirLength < 1 || grid.hrirLength > 4096 ||
    grid.left.length !== grid.right.length || grid.left.length > 8_000_000) throw new Error('HRTF 数据或采样率无效')
  const count = grid.left.length / grid.hrirLength
  if (!Number.isInteger(count) || count < 1 || count > 4096) throw new Error('HRTF 方向数量无效')
  const length = Math.round(grid.hrirLength * sampleRate / grid.sampleRate)
  if (length > 4096 || length * count > 8_000_000) throw new Error('HRTF 重采样结果超过实时渲染容量')
  const left = new Float32Array(count * length), right = new Float32Array(count * length)
  const resampler = sampleRate === grid.sampleRate ? null : new Resampler(grid.sampleRate, sampleRate, 2)
  const coefficientScale = grid.sampleRate / sampleRate
  // 同采样率只需校验与独占复制；不再为每方向分配交错输入、拆回原来的左右平面。
  if (!resampler) {
    for (let direction = 0; direction < count; direction++) {
      let energy = 0
      const end = (direction + 1) * grid.hrirLength
      for (let i = direction * grid.hrirLength; i < end; i++) {
        const l = grid.left[i], r = grid.right[i]
        if (!Number.isFinite(l) || !Number.isFinite(r)) throw new Error('HRTF 数据或采样率无效')
        energy += l ** 2 + r ** 2
      }
      if (energy === 0) throw new Error('HRTF 含全静音方向')
    }
    left.set(grid.left); right.set(grid.right)
  } else {
    for (let direction = 0; direction < count; direction++) {
      const input = new Float32Array(grid.hrirLength * 2)
      let energy = 0
      for (let i = 0; i < grid.hrirLength; i++) {
        input[2 * i] = grid.left[direction * grid.hrirLength + i]
        input[2 * i + 1] = grid.right[direction * grid.hrirLength + i]
        if (!Number.isFinite(input[2 * i]) || !Number.isFinite(input[2 * i + 1])) throw new Error('HRTF 数据或采样率无效')
        energy += input[2 * i] ** 2 + input[2 * i + 1] ** 2
      }
      if (energy === 0) throw new Error('HRTF 含全静音方向')
      const output = resampler.process(input)
      for (let i = 0; i < length; i++) { left[direction * length + i] = (output[2 * i] ?? 0) * coefficientScale; right[direction * length + i] = (output[2 * i + 1] ?? 0) * coefficientScale }
    }
  }
  return { ...grid, sampleRate, hrirLength: length, left, right, azimuths: [...grid.azimuths], elevations: [...grid.elevations],
    rings: grid.rings?.map(ring => ({ ...ring, azimuths: [...ring.azimuths] })),
    referenceDelaySamples: Math.round((grid.referenceDelaySamples ?? 0) * sampleRate / grid.sampleRate) }
}

export interface SofaHrirData {
  convention: string; rate: number; measurements: number; samples: number
  positions: ArrayLike<number>; ir: ArrayLike<number>; delays?: ArrayLike<number>
  receiverLeft: number; sourceType: string; sourceUnits: string; name: string
}

/** SimpleFreeFieldHRIR：SOFA 前/左/上 → HSE 右正方位；Delay 按原采样率的样本计。 */
export function sofaDataToGrid(data: SofaHrirData, sampleRate: number): HrtfGrid {
  const { measurements: count, samples, rate } = data
  if (data.convention !== 'SimpleFreeFieldHRIR' || !Number.isInteger(count) || count < 1 || count > 4096 ||
    !Number.isInteger(samples) || samples < 1 || samples > 2048 || data.ir.length !== count * 2 * samples ||
    data.positions.length !== count * 3 || !Number.isFinite(rate) || rate < 8000 || rate > 192000) throw new Error('仅支持双耳 SimpleFreeFieldHRIR SOFA（每方向 1–2048 样本）')
  if (data.sourceType !== 'spherical' && data.sourceType !== 'cartesian') throw new Error('SOFA 声源坐标类型不受支持')
  const rows: { index: number; azimuth: number; elevation: number }[] = []
  let maxDelay = 0
  for (let i = 0; i < count; i++) {
    let a = Number(data.positions[i * 3]), b = Number(data.positions[i * 3 + 1]), c = Number(data.positions[i * 3 + 2])
    if (![a, b, c].every(Number.isFinite)) throw new Error('SOFA 声源坐标包含非法数值')
    if (data.sourceType === 'cartesian') { const az = Math.atan2(b, a); b = Math.atan2(c, Math.hypot(a, b)); a = az; a *= 180 / Math.PI; b *= 180 / Math.PI }
    else if (data.sourceUnits.startsWith('radian')) { a *= 180 / Math.PI; b *= 180 / Math.PI }
    else if (!data.sourceUnits.startsWith('degree')) throw new Error('SOFA 球坐标必须使用 degree 或 radian')
    rows.push({ index: i, azimuth: ((-a + 540) % 360 + 360) % 360 - 180, elevation: Math.round(b * 1000) / 1000 })
    for (let ear = 0; ear < 2; ear++) {
      const delay = data.delays?.[data.delays.length === 2 ? ear : i * 2 + ear] ?? 0
      if (!Number.isFinite(delay) || delay < 0 || delay > 2048) throw new Error('SOFA 延迟超过支持范围')
      maxDelay = Math.max(maxDelay, delay)
    }
  }
  const length = samples + Math.ceil(maxDelay) + (maxDelay % 1 ? 1 : 0)
  if (count * length > 8_000_000) throw new Error('SOFA 数据超过支持容量')
  rows.sort((a, b) => a.elevation - b.elevation || a.azimuth - b.azimuth)
  const left = new Float32Array(count * length), right = new Float32Array(count * length)
  const rings: NonNullable<HrtfGrid['rings']> = []
  for (let row = 0; row < rows.length; row++) {
    const direction = rows[row]
    let ring = rings.at(-1)
    if (!ring || ring.elevation !== direction.elevation) { ring = { elevation: direction.elevation, azimuths: [], offset: row }; rings.push(ring) }
    if (ring.azimuths.includes(direction.azimuth)) throw new Error('SOFA 含同一方向的多距离测量，请先选择单一测量距离')
    ring.azimuths.push(direction.azimuth)
    for (let ear = 0; ear < 2; ear++) {
      const receiver = ear === 0 ? data.receiverLeft : 1 - data.receiverLeft
      const delay = data.delays?.[data.delays.length === 2 ? receiver : direction.index * 2 + receiver] ?? 0
      const integer = Math.floor(delay), fraction = delay - integer, output = ear === 0 ? left : right
      for (let i = 0; i < samples; i++) {
        const value = Number(data.ir[(direction.index * 2 + receiver) * samples + i])
        if (!Number.isFinite(value)) throw new Error('SOFA 脉冲响应包含非法数值')
        output[row * length + i + integer] += value * (1 - fraction)
        if (fraction) output[row * length + i + integer + 1] += value * fraction
      }
    }
  }
  let earliest = Infinity
  for (let row = 0; row < count; row++) for (const ear of [left, right]) {
    let peak = 0
    for (let i = 1; i < length; i++) if (Math.abs(ear[row * length + i]) > Math.abs(ear[row * length + peak])) peak = i
    earliest = Math.min(earliest, peak)
  }
  return prepareHrtfGrid({ sampleRate: rate, hrirLength: length, left, right, rings,
    azimuths: [], elevations: rings.map(ring => ring.elevation), source: data.name.slice(0, 180), referenceDelaySamples: earliest }, sampleRate)
}
