import { describe, expect, it } from 'vitest'
import {
  createLogBandEdges,
  rebinSpectrumPower,
  RGB_SPECTRUM_BAND_COUNT,
  RGB_SPECTRUM_MAX_HZ,
  RGB_SPECTRUM_MIN_HZ,
  SpectrumDynamics,
} from '../src/plugins/rgb/rgbSpectrum'

const sum = (values: ArrayLike<number>) => Array.from(values).reduce((total, value) => total + value, 0)

describe('RGB spectrum band mapping', () => {
  it('builds exactly 24 logarithmic bands spanning 20 Hz through 12 kHz', () => {
    const edges = createLogBandEdges()
    expect(edges).toHaveLength(RGB_SPECTRUM_BAND_COUNT + 1)
    expect(edges[0]).toBe(RGB_SPECTRUM_MIN_HZ)
    expect(edges[RGB_SPECTRUM_BAND_COUNT]).toBe(RGB_SPECTRUM_MAX_HZ)
    for (let index = 1; index < edges.length; index += 1) {
      expect(edges[index]).toBeGreaterThan(edges[index - 1])
    }
  })

  it('maps sweep endpoints into the first and last columns', () => {
    const low = new Float32Array(24)
    const high = new Float32Array(24)
    low[0] = 1
    high[23] = 1
    const lowColumns = rebinSpectrumPower(low, 7)
    const highColumns = rebinSpectrumPower(high, 7)
    expect(lowColumns[0]).toBeGreaterThan(0)
    expect(Array.from(lowColumns.slice(1)).every(value => value === 0)).toBe(true)
    expect(highColumns[6]).toBeGreaterThan(0)
    expect(Array.from(highColumns.slice(0, 6)).every(value => value === 0)).toBe(true)
  })

  it('conserves power while redistributing overlap into arbitrary columns', () => {
    const source = Float32Array.from({ length: 24 }, (_, index) => (index + 1) / 24)
    for (const columns of [1, 5, 17, 24, 37]) {
      expect(sum(rebinSpectrumPower(source, columns))).toBeCloseTo(sum(source), 5)
    }
  })
})

describe('SpectrumDynamics', () => {
  it('keeps the silence gate closed below the configured noise threshold', () => {
    const dynamics = new SpectrumDynamics({ silenceThreshold: 0.02, gateReleaseMs: 20 })
    let result = dynamics.process(new Float32Array(24).fill(0.005), 0.1)
    for (let index = 0; index < 10; index += 1) {
      result = dynamics.process(new Float32Array(24).fill(0.005), 0.1)
    }
    expect(result.silent).toBe(true)
    expect(result.gate).toBe(0)
    expect(Math.max(...result.bands)).toBe(0)
  })

  it('limits AGC gain and responds according to elapsed time', () => {
    const options = {
      noiseFloor: 0,
      silenceThreshold: 0.0001,
      agcTarget: 0.8,
      agcMaxGain: 2,
      agcReleaseMs: 100,
      gateAttackMs: 0,
      attackMs: 0,
    }
    const oneStep = new SpectrumDynamics(options).process([0.1], 0.2)
    const twoStepsDynamics = new SpectrumDynamics(options)
    twoStepsDynamics.process([0.1], 0.1)
    const twoSteps = twoStepsDynamics.process([0.1], 0.1)
    expect(oneStep.gain).toBeLessThanOrEqual(2)
    expect(twoSteps.gain).toBeCloseTo(oneStep.gain, 6)
  })

  it('holds a peak before releasing it', () => {
    const dynamics = new SpectrumDynamics({
      noiseFloor: 0,
      silenceThreshold: 0,
      agcMinGain: 1,
      agcMaxGain: 1,
      gateAttackMs: 0,
      gateReleaseMs: 0,
      attackMs: 0,
      releaseMs: 0,
      peakHoldMs: 100,
      peakReleaseMs: 100,
    })
    const loud = dynamics.process([1], 0.01)
    const held = dynamics.process([0], 0.05)
    const released = dynamics.process([0], 0.1)
    expect(loud.peaks[0]).toBeCloseTo(1)
    expect(held.peaks[0]).toBeCloseTo(1)
    expect(released.peaks[0]).toBeLessThan(1)
  })
})
