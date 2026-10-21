import { describe, expect, it } from 'vitest'
import { AmbisonicDecoder, FOA_SPEAKERS, getAmbisonicSpeakers, MAX_AMBISONIC_ORDER } from '../AmbisonicDecoder'

const planes = (count: number, length = 8): Float32Array[] =>
  Array.from({ length: count }, () => new Float32Array(length))

describe('AmbisonicDecoder HOA', () => {
  it('declares the supported order ceiling and keeps eight stable virtual-speaker outputs', () => {
    const decoder = new AmbisonicDecoder()
    expect(MAX_AMBISONIC_ORDER).toBe(3)
    expect(decoder.channels).toHaveLength(8)
    expect(decoder.channels.map(channel => channel.length)).toEqual(Array(8).fill(128))
    expect(FOA_SPEAKERS.map(speaker => speaker.channel)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it.each([
    ['ambix', 4], ['ambix1', 4], ['ambix2', 9], ['ambix3', 16],
  ] as const)('%s accepts exactly %i ACN/SN3D channel planes', (format, inputChannels) => {
    const input = planes(inputChannels)
    input[inputChannels - 1][3] = 0.75
    const decoder = new AmbisonicDecoder()
    expect(() => decoder.decode(input, 3, 1, format)).not.toThrow()
    expect(decoder.channels.every(channel => Number.isFinite(channel[0]))).toBe(true)
    expect(decoder.channels.some(channel => channel[0] !== 0)).toBe(true)
  })

  it('rejects channel-count mismatches instead of inferring another order or format', () => {
    const decoder = new AmbisonicDecoder()
    expect(() => decoder.decode(planes(9), 0, 1, 'ambix1')).toThrow(/requires exactly 4 channels/)
    expect(() => decoder.decode(planes(4), 0, 1, 'ambix2')).toThrow(/requires exactly 9 channels/)
    expect(() => decoder.decode(planes(16), 0, 1, 'ambix2')).toThrow(/requires exactly 9 channels/)
    expect(() => decoder.decode(planes(9), 0, 1, 'channels')).toThrow(/explicit ambix/)
    expect(() => decoder.decode(planes(9), 0, 1, 'fuma')).toThrow(/requires exactly 4/)
  })

  it('retains legacy FOA stereo and virtual-speaker results for AmbiX and FuMa', () => {
    const acn = planes(4)
    const fuma = planes(4)
    const values = [0.2, -0.08, 0.04, 0.12] // ACN W,Y,Z,X
    values.forEach((value, channel) => { acn[channel][0] = value })
    fuma[0][0] = values[0] / Math.SQRT2
    fuma[1][0] = values[3]
    fuma[2][0] = values[1]
    fuma[3][0] = values[2]
    const a = new AmbisonicDecoder(), b = new AmbisonicDecoder()
    a.decode(acn, 0, 1, 'ambix')
    b.decode(fuma, 0, 1, 'fuma')
    expect(a.left[0]).toBeCloseTo(values[0] * Math.SQRT1_2 + values[3] * 0.5 + values[1] * 0.5, 7)
    expect(a.right[0]).toBeCloseTo(values[0] * Math.SQRT1_2 + values[3] * 0.5 - values[1] * 0.5, 7)
    expect(Array.from(a.left.subarray(0, 1))).toEqual(Array.from(b.left.subarray(0, 1)))
    expect(Array.from(a.right.subarray(0, 1))).toEqual(Array.from(b.right.subarray(0, 1)))
    for (let speaker = 0; speaker < 8; speaker++) {
      expect(a.channels[speaker][0]).toBeCloseTo(b.channels[speaker][0], 7)
    }
  })

  it('routes HOA-only harmonics into direction-dependent speaker and stereo outputs', () => {
    const input = planes(16)
    input[9][2] = 1
    const decoder = new AmbisonicDecoder()
    decoder.decode(input, 2, 1, 'ambix3')
    const samples = decoder.channels.map(channel => channel[0])
    expect(samples.some(sample => Math.abs(sample) > 1e-4)).toBe(true)
    expect(new Set(samples.map(sample => sample.toFixed(5))).size).toBeGreaterThan(1)
    expect(decoder.left[0]).not.toBe(decoder.right[0])
    expect(decoder.channels.every(channel => channel.slice(1).every(value => value === 0))).toBe(true)
  })

  it('validates block bounds and every explicitly declared channel plane', () => {
    const decoder = new AmbisonicDecoder()
    expect(() => decoder.decode(planes(9), -1, 1, 'ambix2')).toThrow(/integer offset\/count/)
    expect(() => decoder.decode(planes(9), 0, 129, 'ambix2')).toThrow(/within 0\.\.128/)
    const short = planes(9)
    short[8] = new Float32Array(2)
    expect(() => decoder.decode(short, 2, 1, 'ambix2')).toThrow(/channel 8 is shorter/)
  })

  it('uses enough distinct directions for every harmonic and recovers all HOA channel planes', () => {
    const decoder = new AmbisonicDecoder()
    for (const [format, inputChannels, outputChannels] of [['ambix2', 9, 18], ['ambix3', 16, 32]] as const) {
      const input = planes(inputChannels, inputChannels)
      for (let channel = 0; channel < inputChannels; channel++) input[channel][channel] = 1
      decoder.decode(input, 0, inputChannels, format)
      expect(decoder.channels).toHaveLength(outputChannels)
      expect(getAmbisonicSpeakers(format)).toHaveLength(outputChannels)
      const matrix = decoder.channels.map(channel => Array.from(channel.slice(0, inputChannels)))
      for (let target = 0; target < inputChannels; target++) {
        expect(matrix.some(row => Math.abs(row[target]) > 1e-7)).toBe(true)
      }
      // Gaussian elimination verifies rank independently of the decoder's basis formulas.
      let rank = 0
      for (let column = 0; column < inputChannels; column++) {
        const pivot = matrix.findIndex((row, rowIndex) => rowIndex >= rank && Math.abs(row[column]) > 1e-7)
        expect(pivot).toBeGreaterThanOrEqual(rank)
        ;[matrix[rank], matrix[pivot]] = [matrix[pivot], matrix[rank]]
        const scale = matrix[rank][column]
        for (let c = column; c < inputChannels; c++) matrix[rank][c] /= scale
        for (let row = rank + 1; row < matrix.length; row++) {
          const factor = matrix[row][column]
          for (let c = column; c < inputChannels; c++) matrix[row][c] -= factor * matrix[rank][c]
        }
        rank++
      }
      expect(rank).toBe(inputChannels)
    }
  })

  it('preserves the normalized SH Gram matrix before and after a full 3-axis rotation', () => {
    const decoder = new AmbisonicDecoder()
    for (const transform of [{}, { yawDeg: 67, pitchDeg: -31, rollDeg: 22 }]) {
      decoder.reset()
      decoder.setTransform(transform)
      for (const [format, count] of [['ambix2', 9], ['ambix3', 16]] as const) {
        const input = planes(count, count)
        for (let channel = 0; channel < count; channel++) input[channel][channel] = 1
        decoder.decode(input, 0, count, format)
        for (let a = 0; a < count; a++) {
          for (let b = 0; b < count; b++) {
            let gram = 0
            for (const row of decoder.channels) gram += row[a] * row[b] / row[0]
            expect(gram).toBeCloseTo(a === b ? 2 * Math.floor(Math.sqrt(a)) + 1 : 0, 5)
          }
        }
      }
    }
  })

  it('rotates HOA left/right cues in the matrix while retaining the same HRTF directions', () => {
    const input = planes(16)
    input[0][0] = 1; input[3][0] = 1; input[8][0] = Math.sqrt(3) / 2
    input[13][0] = -Math.sqrt(3 / 8); input[15][0] = Math.sqrt(5 / 8)
    const decoder = new AmbisonicDecoder()
    decoder.setTransform({ yawDeg: 90 })
    decoder.decode(input, 0, 1, 'ambix3')
    expect(decoder.right[0]).toBeGreaterThan(decoder.left[0])
    const rotatedRight = decoder.right[0], rotatedLeft = decoder.left[0]
    decoder.reset()
    decoder.setTransform({ yawDeg: -90 })
    decoder.decode(input, 0, 1, 'ambix3')
    expect(decoder.left[0]).toBeCloseTo(rotatedRight, 6)
    expect(decoder.right[0]).toBeCloseTo(rotatedLeft, 6)
    expect(getAmbisonicSpeakers('ambix3')).toHaveLength(32)
  })

  it('supports separate order scaling, including an isotropic zero-directionality field', () => {
    const input = planes(16)
    for (let channel = 0; channel < 16; channel++) input[channel][0] = 0.1
    const decoder = new AmbisonicDecoder()
    decoder.setTransform({ orderGains: [1, 0, 0, 0] })
    decoder.decode(input, 0, 1, 'ambix3')
    expect(decoder.left[0]).toBeCloseTo(0.1 * Math.SQRT1_2, 7)
    expect(decoder.right[0]).toBe(decoder.left[0])
    decoder.reset()
    decoder.setTransform({ orderGains: [0, 0, 0, 1] })
    decoder.decode(input, 0, 1, 'ambix3')
    expect(decoder.channels.some(channel => channel[0] !== 0)).toBe(true)
    expect(() => decoder.setTransform({ yawDeg: NaN })).toThrow(/finite/)
    expect(() => decoder.setTransform({ orderGains: [1, 5] })).toThrow(/-4\.\.4/)
  })

  it('rotates a first-order front cue up for positive pitch with the fixed HOA3 layout', () => {
    const input = planes(16)
    input[0][0] = 1; input[3][0] = 1
    const decoder = new AmbisonicDecoder()
    decoder.setTransform({ pitchDeg: 90 })
    decoder.decode(input, 0, 1, 'ambix3')
    const weightsInput = planes(16)
    weightsInput[0][0] = 1
    const isotropic = new AmbisonicDecoder()
    isotropic.decode(weightsInput, 0, 1, 'ambix3')
    for (const [index, speaker] of getAmbisonicSpeakers('ambix3').entries()) {
      const expected = isotropic.channels[index][0] * (1 + 3 * Math.sin(speaker.elevationDeg * Math.PI / 180))
      expect(decoder.channels[index][0]).toBeCloseTo(expected, 6)
    }
  })

  it('replaces nonfinite PCM with silence and reuses the same buffers across order changes', () => {
    const decoder = new AmbisonicDecoder(), initial = decoder.channels
    const input = planes(16)
    input[6][0] = NaN; input[10][0] = Infinity
    decoder.decode(input, 0, 1, 'ambix3')
    const thirdOrder = decoder.channels
    expect(thirdOrder.every(channel => channel[0] === 0)).toBe(true)
    decoder.decode(planes(4), 0, 1, 'ambix')
    expect(decoder.channels).toBe(initial)
    decoder.decode(input, 0, 1, 'ambix3')
    expect(decoder.channels).toBe(thirdOrder)
  })

  it('crossfades live transforms over 20ms without a first-sample matrix jump', () => {
    const decoder = new AmbisonicDecoder(48000)
    const input = planes(16, 1200)
    input[3].fill(1); input[15].fill(0.25)
    decoder.decode(input, 0, 1, 'ambix3')
    const oldLeft = decoder.left[0], oldSpeakers = decoder.channels.map(channel => channel[0])
    decoder.setTransform({ yawDeg: 120, pitchDeg: 30, orderGains: [1, 0.5, 1, 0.3] })
    decoder.decode(input, 0, 1, 'ambix3')
    expect(decoder.left[0]).toBe(oldLeft)
    expect(decoder.channels.map(channel => channel[0])).toEqual(oldSpeakers)
    for (let at = 1; at <= 960; at += 128) decoder.decode(input, at, Math.min(128, 961 - at), 'ambix3')
    const target = new AmbisonicDecoder()
    target.setTransform({ yawDeg: 120, pitchDeg: 30, orderGains: [1, 0.5, 1, 0.3] })
    target.decode(input, 0, 1, 'ambix3')
    expect(decoder.left[63]).toBe(target.left[0])
    expect(decoder.channels.map(channel => channel[63])).toEqual(target.channels.map(channel => channel[0]))
  })

  it('handles rapid retargeting from the current matrix and is invariant to arbitrary blocks', () => {
    const input = planes(16, 1600)
    input[0].fill(0.1); input[3].fill(0.2); input[11].fill(0.05); input[15].fill(0.1)
    const render = (maxBlock: number): number[][] => {
      const decoder = new AmbisonicDecoder(48000)
      decoder.decode(input, 0, 1, 'ambix3')
      const values = Array.from({ length: 34 }, () => [] as number[])
      let lastLeft = decoder.left[0], lastRight = decoder.right[0]
      let lastSpeaker = decoder.channels.map(channel => channel[0])
      const changes = [0, 93, 177, 301, 1600]
      for (let segment = 0; segment < changes.length - 1; segment++) {
        decoder.setTransform({ yawDeg: [90, -120, 30, 180][segment], pitchDeg: segment * 7,
          orderGains: [1, 1 - segment * 0.1, 0.5, 1] })
        let first = true
        for (let at = changes[segment]; at < changes[segment + 1]; at += maxBlock) {
          const count = Math.min(maxBlock, changes[segment + 1] - at)
          decoder.decode(input, at, count, 'ambix3')
          if (first) {
            expect(decoder.left[0]).toBe(lastLeft)
            expect(decoder.right[0]).toBe(lastRight)
            expect(decoder.channels.map(channel => channel[0])).toEqual(lastSpeaker)
            first = false
          }
          values[0].push(...decoder.left.slice(0, count)); values[1].push(...decoder.right.slice(0, count))
          decoder.channels.forEach((channel, i) => values[i + 2].push(...channel.slice(0, count)))
          lastLeft = decoder.left[count - 1]; lastRight = decoder.right[count - 1]
          lastSpeaker = decoder.channels.map(channel => channel[count - 1])
        }
      }
      return values
    }
    expect(render(73)).toEqual(render(128))
    expect(render(1)).toEqual(render(128))
  })

  it('reset commits the target immediately and order switching retains existing buffer views', () => {
    const decoder = new AmbisonicDecoder(96000), reference = new AmbisonicDecoder(96000)
    const input = planes(16)
    input[3].fill(0.2)
    decoder.decode(input, 0, 1, 'ambix3')
    const view = decoder.channels
    decoder.setTransform({ yawDeg: 135 })
    decoder.decode(input, 0, 1, 'ambix3')
    decoder.reset()
    decoder.decode(input, 0, 1, 'ambix3')
    reference.setTransform({ yawDeg: 135 })
    reference.decode(input, 0, 1, 'ambix3')
    expect(decoder.left[0]).toBe(reference.left[0])
    decoder.decode(planes(4), 0, 1, 'ambix')
    decoder.decode(input, 0, 1, 'ambix3')
    expect(decoder.channels).toBe(view)
    expect(() => new AmbisonicDecoder(NaN)).toThrow(/sample rate/)
  })
})
