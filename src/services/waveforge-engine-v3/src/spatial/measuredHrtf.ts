/** MIT KEMAR 实测 HRIR：原采样方向保真，负方位由左右耳镜像得到。 */
import { Resampler } from '../dsp/Resampler'
import { KEMAR_PCM_BASE64, KEMAR_RINGS } from './kemarData'
import type { HrtfGrid } from './types'

const SOURCE_RATE = 44100
const SOURCE_LENGTH = 128
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_INDEX = new Int16Array(128).fill(-1)
for (let i = 0; i < BASE64_ALPHABET.length; i++) BASE64_INDEX[BASE64_ALPHABET.charCodeAt(i)] = i

let cachedRate = 0
let cachedGrid: HrtfGrid | null = null

function decodePcm16(encoded: string): DataView {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array((encoded.length / 4) * 3 - padding)
  let at = 0
  for (let i = 0; i < encoded.length; i += 4) {
    const a = BASE64_INDEX[encoded.charCodeAt(i)]
    const b = BASE64_INDEX[encoded.charCodeAt(i + 1)]
    const c = encoded[i + 2] === '=' ? 0 : BASE64_INDEX[encoded.charCodeAt(i + 2)]
    const d = encoded[i + 3] === '=' ? 0 : BASE64_INDEX[encoded.charCodeAt(i + 3)]
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('KEMAR 数据编码损坏')
    bytes[at++] = (a << 2) | (b >> 4)
    if (at < bytes.length) bytes[at++] = (b << 4) | (c >> 2)
    if (at < bytes.length) bytes[at++] = (c << 6) | d
  }
  return new DataView(bytes.buffer)
}

/** 按原始不等距测量环建立网格；重采样仅在构造时进行，渲染热路径不解码。 */
export function createMeasuredHrtfGrid(sampleRate: number): HrtfGrid {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error('KEMAR HRTF 采样率必须在 8–192 kHz')
  }
  if (cachedGrid && cachedRate === sampleRate) return cachedGrid

  const pcm = decodePcm16(KEMAR_PCM_BASE64)
  const resampler = sampleRate === SOURCE_RATE ? null : new Resampler(SOURCE_RATE, sampleRate, 2)
  const hrirLength = Math.round(SOURCE_LENGTH * sampleRate / SOURCE_RATE)
  const source: Float32Array[] = []
  for (let direction = 0; direction < 368; direction++) {
    const input = new Float32Array(SOURCE_LENGTH * 2)
    for (let i = 0; i < input.length; i++) {
      input[i] = pcm.getInt16((direction * input.length + i) * 2, true) / 32768
    }
    source.push(resampler ? resampler.process(input) : input)
  }

  const rings: NonNullable<HrtfGrid['rings']> = []
  let directionCount = 0
  let sourceIndex = 0
  const mapped = KEMAR_RINGS.map(ring => {
    const entries: { azimuth: number; index: number; swap: boolean }[] = []
    for (const azimuth of ring.azimuths) {
      if (azimuth > 0) entries.push({ azimuth: -azimuth, index: sourceIndex, swap: azimuth < 180 })
      if (azimuth < 180) entries.push({ azimuth, index: sourceIndex, swap: false })
      sourceIndex++
    }
    entries.sort((a, b) => a.azimuth - b.azimuth)
    rings.push({ elevation: ring.elevation, azimuths: entries.map(entry => entry.azimuth), offset: directionCount })
    directionCount += entries.length
    return entries
  })
  if (sourceIndex !== source.length) throw new Error('KEMAR 方向表长度不匹配')

  const left = new Float32Array(directionCount * hrirLength)
  const right = new Float32Array(directionCount * hrirLength)
  // HRIR 是滤波器系数：波形重采样后需保持积分/频率增益，而非保持样本峰值。
  const coefficientScale = SOURCE_RATE / sampleRate
  let at = 0
  for (const ring of mapped) {
    for (const { index, swap } of ring) {
      const hrir = source[index]
      for (let i = 0; i < hrirLength; i++) {
        left[at] = hrir[i * 2 + (swap ? 1 : 0)] * coefficientScale
        right[at] = hrir[i * 2 + (swap ? 0 : 1)] * coefficientScale
        at++
      }
    }
  }
  const grid: HrtfGrid = {
    sampleRate,
    azimuths: [], // 实测环各有不同的方位列表，方向索引由 rings 给出。
    elevations: rings.map(ring => ring.elevation),
    hrirLength,
    left,
    right,
    rings,
    source: 'MIT KEMAR compact, Gardner/Martin (1994)',
    referenceDelaySamples: Math.round(18 * sampleRate / 48000),
  }
  cachedRate = sampleRate
  cachedGrid = grid
  return grid
}
