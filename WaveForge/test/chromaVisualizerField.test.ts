import { describe, expect, it } from 'vitest'
import {
  CHROMA_VISUALIZER_FIELD_TOP,
  CHROMA_VISUALIZER_HEIGHT,
  CHROMA_VISUALIZER_WIDTH,
  createChromaVisualizerField,
  projectVisualizerField,
  projectVisualizerField1D,
  projectVisualizerField2D,
  sampleVisualizerField,
} from '../src/plugins/clients/chroma/chromaVisualizerField'
import { getChromaDeviceTopology } from '../src/plugins/clients/chroma/chromaTopology'

describe('Chroma visualizer field projection', () => {
  it('creates the observed 256 by 64 canonical surface', () => {
    const field = createChromaVisualizerField()
    expect(field.width).toBe(256)
    expect(field.height).toBe(64)
    expect(field.colors).toHaveLength(256 * 64)
    expect(CHROMA_VISUALIZER_FIELD_TOP).toBe(1)
  })

  it('projects one-dimensional devices exclusively from the top strip', () => {
    const field = createChromaVisualizerField()
    for (let column = 0; column < field.width; column += 1) {
      field.colors[column] = column + 1
      field.colors[field.width + column] = 0x00ffffff
    }
    for (const device of ['mousepad', 'headset', 'chromalink'] as const) {
      const topology = getChromaDeviceTopology(device)
      const frame = projectVisualizerField(device, field, topology)
      expect(frame[0]).toBe(1)
      expect(frame.at(-1)).toBe(256)
      expect(Array.from(frame).every(color => color !== 0x00ffffff)).toBe(true)
    }
  })

  it('projects keyboard and keypad from rows below the strip', () => {
    const field = createChromaVisualizerField()
    field.colors.fill(0x00000011, 0, field.width)
    for (let row = 1; row < field.height; row += 1) {
      field.colors.fill(row << 8, row * field.width, (row + 1) * field.width)
    }
    const keyboard = projectVisualizerField2D(field, getChromaDeviceTopology('keyboard'))
    const keypad = projectVisualizerField('keypad', field, getChromaDeviceTopology('keypad'))
    expect(Array.from(keyboard).some(color => color === 0x00000011)).toBe(false)
    expect(Array.from(keypad).some(color => color === 0x00000011)).toBe(false)
    expect(keyboard[1]).toBe(1 << 8)
    expect(keyboard[5 * 22 + 1]).toBe(63 << 8)
    expect(keypad[0]).toBe(1 << 8)
    expect(keypad[3 * 5]).toBe(63 << 8)
  })

  it('maps sparse mouse LEDs into the same two-dimensional field', () => {
    const field = createChromaVisualizerField()
    for (let row = 1; row < field.height; row += 1) {
      for (let column = 0; column < field.width; column += 1) {
        field.colors[row * field.width + column] = (row << 16) | column
      }
    }
    const topology = getChromaDeviceTopology('mouse')
    const mouse = projectVisualizerField2D(field, topology)
    expect(mouse[0]).toBe(0)
    expect(mouse[2 * 7 + 3]).not.toBe(0)
    expect(mouse[8 * 7 + 1]).not.toBe(0)
    expect(Array.from(mouse).every((color, index) => topology.mask[index] === 1 || color === 0)).toBe(true)
  })

  it('clamps direct samples to the canonical bounds', () => {
    const field = createChromaVisualizerField()
    field.colors[0] = 11
    field.colors[field.colors.length - 1] = 22
    expect(sampleVisualizerField(field, -10, -10)).toBe(11)
    expect(sampleVisualizerField(field, 999, 999)).toBe(22)
  })

  it('changes physical height with size without mutating the canonical field', () => {
    const field = createChromaVisualizerField()
    for (let row = 32; row < field.height; row += 1) {
      field.colors.fill(0x0000ff, row * field.width, (row + 1) * field.width)
    }
    const before = Array.from(field.colors)
    const topology = getChromaDeviceTopology('keyboard')
    const small = projectVisualizerField2D(field, topology, 1)
    const neutral = projectVisualizerField2D(field, topology, 5)
    const large = projectVisualizerField2D(field, topology, 10)
    const lit = (frame: Uint32Array) => Array.from(frame).filter(Boolean).length
    expect(lit(small)).toBeLessThan(lit(neutral))
    expect(lit(neutral)).toBeLessThan(lit(large))
    expect(Array.from(field.colors)).toEqual(before)
  })

  it('uses size to change one-dimensional occupancy without changing colors', () => {
    const field = createChromaVisualizerField()
    field.colors.fill(0x00112233, 0, 128)
    const topology = getChromaDeviceTopology('mousepad')
    const small = projectVisualizerField1D(field, topology, 1)
    const neutral = projectVisualizerField1D(field, topology, 5)
    const large = projectVisualizerField1D(field, topology, 10)
    const lit = (frame: Uint32Array) => Array.from(frame).filter(Boolean).length
    expect(lit(small)).toBeLessThan(lit(neutral))
    expect(lit(neutral)).toBeLessThan(lit(large))
    expect([...small, ...neutral, ...large].filter(Boolean).every(color => color === 0x00112233)).toBe(true)
  })

  it('keeps direct one-dimensional projection helper endpoint-complete', () => {
    const field = createChromaVisualizerField()
    field.colors[0] = 0x11
    field.colors[255] = 0x22
    const output = projectVisualizerField1D(field, getChromaDeviceTopology('headset'))
    expect(output[0]).toBe(0x11)
    expect(output.at(-1)).toBe(0x22)
  })
})
