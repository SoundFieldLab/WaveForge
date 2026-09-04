import type { AudioFeatureFrame } from './rgbTypes'

export const RGB_SPECTRUM_BAND_COUNT = 24
export const RGB_SPECTRUM_MIN_HZ = 20
export const RGB_SPECTRUM_MAX_HZ = 12_000

export function createLogBandEdges(
  count = RGB_SPECTRUM_BAND_COUNT,
  minHz = RGB_SPECTRUM_MIN_HZ,
  maxHz = RGB_SPECTRUM_MAX_HZ,
): Float64Array {
  if (!Number.isInteger(count) || count < 1) throw new RangeError('count must be a positive integer')
  if (!(minHz > 0) || !(maxHz > minHz)) throw new RangeError('frequency range must be positive and increasing')
  const edges = new Float64Array(count + 1)
  const ratio = maxHz / minHz
  for (let index = 0; index <= count; index += 1) {
    edges[index] = minHz * ratio ** (index / count)
  }
  edges[0] = minHz
  edges[count] = maxHz
  return edges
}

export const RGB_SPECTRUM_BAND_EDGES = createLogBandEdges()

/**
 * Redistribute per-band power using overlap on the logarithmic frequency axis.
 * Each source band's power is conserved across all destination columns.
 */
export function rebinSpectrumPower(
  sourcePower: ArrayLike<number>,
  columnCount: number,
  sourceEdges: ArrayLike<number> = RGB_SPECTRUM_BAND_EDGES,
): Float32Array {
  if (!Number.isInteger(columnCount) || columnCount < 1) {
    throw new RangeError('columnCount must be a positive integer')
  }
  if (sourceEdges.length !== sourcePower.length + 1 || sourcePower.length < 1) {
    throw new RangeError('sourceEdges must contain one more value than sourcePower')
  }

  const first = sourceEdges[0]
  const last = sourceEdges[sourceEdges.length - 1]
  if (!(first > 0) || !(last > first)) throw new RangeError('sourceEdges must be positive and increasing')
  const logMin = Math.log(first)
  const logSpan = Math.log(last) - logMin
  const destination = new Float64Array(columnCount)

  for (let sourceIndex = 0; sourceIndex < sourcePower.length; sourceIndex += 1) {
    const low = Math.log(sourceEdges[sourceIndex])
    const high = Math.log(sourceEdges[sourceIndex + 1])
    if (!(high > low)) throw new RangeError('sourceEdges must be strictly increasing')
    const power = Math.max(0, Number(sourcePower[sourceIndex]) || 0)
    if (power === 0) continue

    const firstColumn = Math.max(0, Math.floor(((low - logMin) / logSpan) * columnCount))
    const lastColumn = Math.min(columnCount - 1, Math.ceil(((high - logMin) / logSpan) * columnCount) - 1)
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const columnLow = logMin + (column / columnCount) * logSpan
      const columnHigh = logMin + ((column + 1) / columnCount) * logSpan
      const overlap = Math.max(0, Math.min(high, columnHigh) - Math.max(low, columnLow))
      if (overlap > 0) destination[column] += power * overlap / (high - low)
    }
  }

  return Float32Array.from(destination)
}

export function rebinSpectrumMeanPower(
  sourcePower: ArrayLike<number>,
  columnCount: number,
  sourceEdges: ArrayLike<number> = RGB_SPECTRUM_BAND_EDGES,
): Float32Array {
  if (!Number.isInteger(columnCount) || columnCount < 1) {
    throw new RangeError('columnCount must be a positive integer')
  }
  if (sourceEdges.length !== sourcePower.length + 1 || sourcePower.length < 1) {
    throw new RangeError('sourceEdges must contain one more value than sourcePower')
  }

  const first = sourceEdges[0]
  const last = sourceEdges[sourceEdges.length - 1]
  if (!(first > 0) || !(last > first)) throw new RangeError('sourceEdges must be positive and increasing')
  const logMin = Math.log(first)
  const logSpan = Math.log(last) - logMin
  const destination = new Float64Array(columnCount)

  for (let column = 0; column < columnCount; column += 1) {
    const columnLow = logMin + (column / columnCount) * logSpan
    const columnHigh = logMin + ((column + 1) / columnCount) * logSpan
    let weightedPower = 0
    let coveredWidth = 0
    for (let sourceIndex = 0; sourceIndex < sourcePower.length; sourceIndex += 1) {
      const sourceLow = Math.log(sourceEdges[sourceIndex])
      const sourceHigh = Math.log(sourceEdges[sourceIndex + 1])
      if (!(sourceHigh > sourceLow)) throw new RangeError('sourceEdges must be strictly increasing')
      const overlap = Math.max(0, Math.min(sourceHigh, columnHigh) - Math.max(sourceLow, columnLow))
      if (overlap === 0) continue
      weightedPower += Math.max(0, Number(sourcePower[sourceIndex]) || 0) * overlap
      coveredWidth += overlap
    }
    destination[column] = coveredWidth > 0 ? weightedPower / coveredWidth : 0
  }

  return Float32Array.from(destination)
}

export interface SpectrumDynamicsOptions {
  attackMs?: number
  releaseMs?: number
  noiseFloor?: number
  noiseRiseMs?: number
  noiseFallMs?: number
  agcTarget?: number
  agcMinGain?: number
  agcMaxGain?: number
  agcAttackMs?: number
  agcReleaseMs?: number
  silenceThreshold?: number
  gateAttackMs?: number
  gateReleaseMs?: number
  peakHoldMs?: number
  peakReleaseMs?: number
}

export interface SpectrumDynamicsResult {
  bands: Float32Array
  peaks: Float32Array
  noiseFloor: Float32Array
  gain: number
  gate: number
  silent: boolean
}

const coefficient = (dtSeconds: number, timeMs: number) => {
  if (timeMs <= 0) return 1
  return 1 - Math.exp(-Math.max(0, dtSeconds) * 1000 / timeMs)
}

export class SpectrumDynamics {
  private readonly options: Required<SpectrumDynamicsOptions>
  private smoothed = new Float32Array(0)
  private peaks = new Float32Array(0)
  private noise = new Float32Array(0)
  private peakAgeMs = new Float64Array(0)
  private gainValue = 1
  private gateValue = 0

  constructor(options: SpectrumDynamicsOptions = {}) {
    this.options = {
      attackMs: options.attackMs ?? 35,
      releaseMs: options.releaseMs ?? 220,
      noiseFloor: options.noiseFloor ?? 0.002,
      noiseRiseMs: options.noiseRiseMs ?? 4000,
      noiseFallMs: options.noiseFallMs ?? 250,
      agcTarget: options.agcTarget ?? 0.65,
      agcMinGain: options.agcMinGain ?? 0.5,
      agcMaxGain: options.agcMaxGain ?? 4,
      agcAttackMs: options.agcAttackMs ?? 600,
      agcReleaseMs: options.agcReleaseMs ?? 1800,
      silenceThreshold: options.silenceThreshold ?? 0.008,
      gateAttackMs: options.gateAttackMs ?? 25,
      gateReleaseMs: options.gateReleaseMs ?? 180,
      peakHoldMs: options.peakHoldMs ?? 180,
      peakReleaseMs: options.peakReleaseMs ?? 500,
    }
  }

  reset(): void {
    this.smoothed = new Float32Array(0)
    this.peaks = new Float32Array(0)
    this.noise = new Float32Array(0)
    this.peakAgeMs = new Float64Array(0)
    this.gainValue = 1
    this.gateValue = 0
  }

  process(input: ArrayLike<number>, dtSeconds: number): SpectrumDynamicsResult {
    const dt = Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds : 0)
    this.ensureSize(input.length)
    let maxSignal = 0
    const cleaned = new Float32Array(input.length)

    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(0, Number(input[index]) || 0)
      const floorTarget = Math.max(this.options.noiseFloor, Math.min(sample, this.options.silenceThreshold))
      const noiseMs = floorTarget > this.noise[index] ? this.options.noiseRiseMs : this.options.noiseFallMs
      this.noise[index] += (floorTarget - this.noise[index]) * coefficient(dt, noiseMs)
      cleaned[index] = Math.max(0, sample - this.noise[index])
      maxSignal = Math.max(maxSignal, cleaned[index])
    }

    const desiredGain = maxSignal > 0
      ? Math.min(this.options.agcMaxGain, Math.max(this.options.agcMinGain, this.options.agcTarget / maxSignal))
      : this.options.agcMaxGain
    const gainMs = desiredGain < this.gainValue ? this.options.agcAttackMs : this.options.agcReleaseMs
    this.gainValue += (desiredGain - this.gainValue) * coefficient(dt, gainMs)

    const shouldOpen = maxSignal * this.gainValue >= this.options.silenceThreshold
    const targetGate = shouldOpen ? 1 : 0
    const gateMs = shouldOpen ? this.options.gateAttackMs : this.options.gateReleaseMs
    this.gateValue += (targetGate - this.gateValue) * coefficient(dt, gateMs)
    if (this.gateValue < 1e-4) this.gateValue = 0

    for (let index = 0; index < cleaned.length; index += 1) {
      const target = Math.min(1, cleaned[index] * this.gainValue) * this.gateValue
      const smoothMs = target > this.smoothed[index] ? this.options.attackMs : this.options.releaseMs
      this.smoothed[index] += (target - this.smoothed[index]) * coefficient(dt, smoothMs)

      if (this.smoothed[index] >= this.peaks[index]) {
        this.peaks[index] = this.smoothed[index]
        this.peakAgeMs[index] = 0
      } else {
        this.peakAgeMs[index] += dt * 1000
        if (this.peakAgeMs[index] > this.options.peakHoldMs) {
          this.peaks[index] += (this.smoothed[index] - this.peaks[index]) * coefficient(dt, this.options.peakReleaseMs)
        }
      }
    }

    return {
      bands: this.smoothed.slice(),
      peaks: this.peaks.slice(),
      noiseFloor: this.noise.slice(),
      gain: this.gainValue,
      gate: this.gateValue,
      silent: !shouldOpen && this.gateValue < 0.01,
    }
  }

  processFrame(frame: AudioFeatureFrame): SpectrumDynamicsResult {
    return this.process(frame.bands, frame.dt)
  }

  private ensureSize(size: number): void {
    if (this.smoothed.length === size) return
    this.smoothed = new Float32Array(size)
    this.peaks = new Float32Array(size)
    this.noise = new Float32Array(size).fill(this.options.noiseFloor)
    this.peakAgeMs = new Float64Array(size)
  }
}
