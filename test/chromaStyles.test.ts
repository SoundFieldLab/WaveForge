import { describe, expect, it } from 'vitest'
import {
  CHROMA_THEMES,
  createChromaStyleEngine,
  interpolateColor,
  packBgr,
  parseColor,
  resampleSpectrum,
  sampleTheme,
} from '../src/plugins/clients/chroma/chromaStyles'
import { normalizeChromaSettings } from '../src/plugins/clients/ChromaClient'
import { getChromaDeviceTopology } from '../src/plugins/clients/chroma/chromaTopology'
import { projectVisualizerField } from '../src/plugins/clients/chroma/chromaVisualizerField'
import {
  CHROMA_DEVICE_METADATA,
  CHROMA_DEVICE_TYPES,
  DEFAULT_CHROMA_SETTINGS,
  type ChromaAudioData,
  type ChromaSettings,
  type KeyboardChromaStyle,
  type PeripheralChromaStyle,
} from '../src/plugins/clients/chroma/chromaTypes'

const audio: ChromaAudioData = {
  spectrum: Float32Array.from({ length: 24 }, (_, index) => (index % 7) / 6),
  bass: 0.72,
  mid: 0.48,
  high: 0.31,
  overall: 0.61,
  beat: 0.36,
  accent: 0.2,
  flux: 0.27,
}

function settings(overrides: Partial<ChromaSettings> = {}): ChromaSettings {
  return {
    ...DEFAULT_CHROMA_SETTINGS,
    ...overrides,
    keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, ...overrides.keyboard },
    mouse: { ...DEFAULT_CHROMA_SETTINGS.mouse, ...overrides.mouse },
    mousepad: { ...DEFAULT_CHROMA_SETTINGS.mousepad, ...overrides.mousepad },
    headset: { ...DEFAULT_CHROMA_SETTINGS.headset, ...overrides.headset },
    keypad: { ...DEFAULT_CHROMA_SETTINGS.keypad, ...overrides.keypad },
    chromalink: { ...DEFAULT_CHROMA_SETTINGS.chromalink, ...overrides.chromalink },
  }
}

function frameSum(frame: Uint32Array | null): number {
  return frame ? frame.reduce((sum, color) => sum + color, 0) : 0
}

function frameLight(frame: Uint32Array | null): number {
  return frame ? frame.reduce((sum, color) => sum + (color & 0xff) + ((color >>> 8) & 0xff) + ((color >>> 16) & 0xff), 0) : 0
}

function signature(frame: Uint32Array): string {
  return Array.from(frame).join(',')
}

function keyboardFor(config: ChromaSettings, data = audio, now = 1234): Uint32Array {
  const frame = createChromaStyleEngine().render(data, config, { now }).frames.keyboard
  if (!frame) throw new Error('Expected keyboard frame')
  return frame
}

describe('Chroma color helpers', () => {
  it('packs RGB as unsigned 0x00BBGGRR and clamps brightness', () => {
    expect(packBgr('#112233')).toBe(0x00332211)
    expect(packBgr('ff0000', 0.5)).toBe(0x00000080)
    expect(packBgr('#ffffff', 2)).toBe(0x00ffffff)
    expect(packBgr('invalid')).toBe(0)
    expect(packBgr('#ffffff', Number.NaN)).toBe(0)
  })

  it('parses, interpolates, and samples themes robustly', () => {
    expect(parseColor('#0f8')).toEqual({ r: 0, g: 255, b: 136 })
    expect(parseColor(null)).toEqual({ r: 0, g: 0, b: 0 })
    expect(interpolateColor('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(interpolateColor('#ff0000', '#0000ff', -1)).toBe('#ff0000')
    expect(sampleTheme('white', 0)).toBe('#ffffff')
    expect(sampleTheme('custom', 0.5, ['#ff0000', '#0000ff'])).toBe('#800080')
    expect(sampleTheme('unknown', Number.POSITIVE_INFINITY)).toMatch(/^#[0-9a-f]{6}$/)
    expect(Object.keys(CHROMA_THEMES)).toEqual(['razer', 'cyber', 'sunset', 'ocean', 'fire', 'aurora', 'white', 'custom'])
  })

  it('resamples 24 spectrum bands to 22 without changing the input', () => {
    const input = Float32Array.from({ length: 24 }, (_, index) => index / 23)
    const before = Array.from(input)
    const output = resampleSpectrum(input)
    expect(output).toHaveLength(22)
    expect(output[0]).toBeGreaterThanOrEqual(0)
    expect(output[21]).toBe(1)
    for (let index = 1; index < output.length; index += 1) {
      expect(output[index]).toBeGreaterThanOrEqual(output[index - 1])
    }
    expect(Array.from(input)).toEqual(before)
    expect(Array.from(resampleSpectrum([Number.NaN, -1, 2], 3))).toEqual([0, 0, 1])
  })
})

describe('Chroma frames', () => {
  it('returns the exact matrix length for every device', () => {
    const result = createChromaStyleEngine().render(audio, settings({ smoothing: 0 }), { now: 1000 })
    expect(result.action).toBe('frame')
    for (const device of CHROMA_DEVICE_TYPES) {
      expect(result.frames[device]).toBeInstanceOf(Uint32Array)
      expect(result.frames[device]).toHaveLength(CHROMA_DEVICE_METADATA[device].rows * CHROMA_DEVICE_METADATA[device].columns)
    }
  })

  it('renders every extended keyboard style as a legal and distinct frame', () => {
    const styles: KeyboardChromaStyle[] = [
      'spectrum-cycle', 'spectrum-static', 'spectrum-gradient', 'wave', 'radial-pulse',
      'ripple', 'breath', 'starlight', 'fire', 'rain', 'vu-meter', 'static', 'bars', 'pulse',
    ]
    const signatures = styles.map(style => {
      const frame = keyboardFor(settings({
        smoothing: 0,
        keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style, beatFlash: false },
      }))
      expect(frame).toHaveLength(132)
      expect(Array.from(frame).every(value => Number.isInteger(value) && value >= 0 && value <= 0x00ffffff)).toBe(true)
      return signature(frame)
    })
    expect(new Set(signatures).size).toBe(styles.length - 1)
    expect(signatures[styles.indexOf('bars')]).toBe(signatures[styles.indexOf('spectrum-gradient')])
  })

  it('keeps starlight deterministic for the same engine state and time', () => {
    const config = settings({ smoothing: 0, keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'starlight' } })
    const engine = createChromaStyleEngine()
    const first = engine.render(audio, config, { now: 1350 }).frames.keyboard
    engine.reset()
    const second = engine.render(audio, config, { now: 1350 }).frames.keyboard
    expect(second).toEqual(first)
  })

  it('renders every peripheral style as a legal frame', () => {
    const styles: PeripheralChromaStyle[] = ['spectrum', 'wave', 'pulse', 'breath', 'static']
    for (const style of styles) {
      const config = settings({ mouse: { ...DEFAULT_CHROMA_SETTINGS.mouse, style } })
      const frame = createChromaStyleEngine().render(audio, config, { now: 900 }).frames.mouse
      expect(frame).toHaveLength(63)
      expect(Array.from(frame!).every(value => value <= 0x00ffffff)).toBe(true)
    }
  })

  it('projects all spectrum devices from one 256 by 64 visualizer field', () => {
    const config = settings({
      smoothing: 0,
      size: 5,
      brightness: 1,
      backgroundEffect: 'off',
      reactiveBackground: false,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-gradient', beatFlash: false, intensity: 1 },
      mouse: { ...DEFAULT_CHROMA_SETTINGS.mouse, enabled: true, intensity: 1 },
      mousepad: { ...DEFAULT_CHROMA_SETTINGS.mousepad, enabled: true, intensity: 1 },
      headset: { ...DEFAULT_CHROMA_SETTINGS.headset, enabled: true, intensity: 1 },
      keypad: { ...DEFAULT_CHROMA_SETTINGS.keypad, enabled: true, intensity: 1 },
      chromalink: { ...DEFAULT_CHROMA_SETTINGS.chromalink, enabled: true, intensity: 1 },
    })
    const result = createChromaStyleEngine().render(
      { spectrum: Float32Array.from({ length: 24 }, (_, index) => 0.15 + index / 30) },
      config,
      { now: 0 },
    )
    const field = result.visualizerField
    expect(field).not.toBeNull()
    expect(field?.width).toBe(256)
    expect(field?.height).toBe(64)
    expect(field?.colors).toHaveLength(256 * 64)

    const strip = field!.colors.subarray(0, 256)
    expect(result.frames.mousepad?.[0]).toBe(strip[0])
    expect(result.frames.mousepad?.at(-1)).toBe(strip[255])
    expect(result.frames.headset?.[0]).toBe(strip[0])
    expect(result.frames.headset?.at(-1)).toBe(strip[255])
    expect(result.frames.chromalink?.[0]).toBe(strip[0])
    expect(result.frames.chromalink?.at(-1)).toBe(strip[255])

    const keyboard = result.frames.keyboard!
    const keyboardColumnOneSource = Math.round((1 / 21) * 255)
    expect(keyboard[1]).toBe(field!.colors[1 * 256 + keyboardColumnOneSource])
    expect(keyboard[5 * 22 + 1]).toBe(field!.colors[63 * 256 + keyboardColumnOneSource])
    const mouseTopology = getChromaDeviceTopology('mouse')
    expect(Array.from(result.frames.mouse!).every((value, index) => mouseTopology.mask[index] === 1 || value === 0)).toBe(true)
  })

  it('creates a canonical field for procedural keyboard styles', () => {
    const result = createChromaStyleEngine().render(
      audio,
      settings({ keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'fire' } }),
      { now: 0 },
    )
    expect(result.visualizerField).not.toBeNull()
    expect(result.visualizerField?.colors).toHaveLength(256 * 64)
  })

  it('keeps foreground and background as independent layers', () => {
    const silence: ChromaAudioData = { spectrum: new Float32Array(24), overall: 0 }
    const base = settings({
      smoothing: 0,
      brightness: 1,
      foregroundStaticColor: '#ff0000',
      backgroundEffect: 'static',
      backgroundStaticColor: '#0000ff',
      backgroundBrightness: 0.5,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-static', beatFlash: false },
    })
    const result = createChromaStyleEngine().render(silence, base, { now: 0 })
    expect(result.foregroundField).not.toBeNull()
    expect(result.backgroundField).not.toBeNull()
    expect(result.visualizerField).not.toBeNull()
    expect(Array.from(result.foregroundField!.coverage).every(coverage => coverage === 0)).toBe(true)
    expect(Array.from(result.backgroundField!.colors).some(color => color !== 0)).toBe(true)
    expect(result.visualizerField!.colors[300]).toBe(packBgr('#0000ff', 0.5))

    const foregroundAudio: ChromaAudioData = { spectrum: new Float32Array(24).fill(0.5), overall: 0.5 }
    const foregroundA = createChromaStyleEngine().render(foregroundAudio, base, { now: 0 })
    const foregroundB = createChromaStyleEngine().render(foregroundAudio, { ...base, foregroundStaticColor: '#00ff00' }, { now: 0 })
    expect(Array.from(foregroundA.backgroundField!.colors)).toEqual(Array.from(foregroundB.backgroundField!.colors))
    expect(Array.from(foregroundA.foregroundField!.colors)).not.toEqual(Array.from(foregroundB.foregroundField!.colors))

    const backgroundB = createChromaStyleEngine().render(foregroundAudio, { ...base, backgroundStaticColor: '#00ffff' }, { now: 0 })
    expect(Array.from(foregroundA.foregroundField!.colors)).toEqual(Array.from(backgroundB.foregroundField!.colors))
    expect(Array.from(foregroundA.backgroundField!.colors)).not.toEqual(Array.from(backgroundB.backgroundField!.colors))
  })

  it('forces background off to black even when reactive is enabled', () => {
    const result = createChromaStyleEngine().render(
      { spectrum: new Float32Array(24), overall: 0 },
      settings({ backgroundEffect: 'off', reactiveBackground: true, keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-static', beatFlash: false } }),
      { now: 0 },
    )
    expect(Array.from(result.backgroundField!.colors).every(color => color === 0)).toBe(true)
    expect(Array.from(result.visualizerField!.colors).every(color => color === 0)).toBe(true)
    expect(CHROMA_DEVICE_TYPES.every(device => Array.from(result.frames[device]!).every(color => color === 0))).toBe(true)
  })

  it('keeps every foreground effect dark during silence when background is off', () => {
    const silence: ChromaAudioData = { spectrum: new Float32Array(24), bass: 0, mid: 0, high: 0, overall: 0, beat: 0, accent: 0, flux: 0 }
    const styles: KeyboardChromaStyle[] = ['spectrum-cycle', 'spectrum-static', 'spectrum-gradient', 'wave', 'radial-pulse', 'ripple', 'breath', 'starlight', 'fire', 'rain', 'vu-meter', 'static']
    for (const style of styles) {
      const result = createChromaStyleEngine().render(silence, settings({
        smoothing: 0,
        backgroundEffect: 'off',
        reactiveBackground: true,
        keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style, beatFlash: false },
      }), { now: 0 })
      expect(Array.from(result.foregroundField!.coverage).every(coverage => coverage === 0)).toBe(true)
      expect(Array.from(result.visualizerField!.colors).every(color => color === 0)).toBe(true)
      expect(CHROMA_DEVICE_TYPES.every(device => Array.from(result.frames[device]!).every(color => color === 0))).toBe(true)
    }
  })

  it('matches neutral hardware projection to the canonical composite', () => {
    const config = settings({
      smoothing: 0,
      brightness: 0.63,
      size: 5,
      foregroundStaticColor: '#ff3010',
      backgroundEffect: 'static',
      backgroundStaticColor: '#1020e0',
      backgroundBrightness: 0.47,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, intensity: 1, style: 'spectrum-static', beatFlash: false },
    })
    const result = createChromaStyleEngine().render(
      { spectrum: new Float32Array(24).fill(0.5), overall: 0.5 },
      config,
      { now: 0 },
    )
    const topology = getChromaDeviceTopology('keyboard')
    const expected = projectVisualizerField('keyboard', result.visualizerField!, topology, 5)
    expect(Array.from(result.frames.keyboard!)).toEqual(Array.from(expected))
  })

  it('caps global and device brightness at one during normalization', () => {
    const normalized = settings({
      brightness: 2,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, intensity: 2 },
    })
    expect(normalized.brightness).toBe(2)
    const migrated = normalizeChromaSettings(normalized)
    expect(migrated.brightness).toBe(1)
    expect(migrated.keyboard.intensity).toBe(1)
  })

  it('renders exact bottom-up spectrum columns with black cells above the height', () => {
    const config = settings({
      smoothing: 0,
      sensitivity: 1,
      size: 5,
      backgroundEffect: 'off',
      reactiveBackground: false,
      keyboard: {
        ...DEFAULT_CHROMA_SETTINGS.keyboard,
        style: 'spectrum-static',
        theme: 'white',
        beatFlash: false,
      },
    })
    const topology = getChromaDeviceTopology('keyboard')
    for (const [level, expectedRows] of [[0, 0], [1 / 6, 1], [0.5, 3], [1, 6]] as const) {
      const frame = keyboardFor(config, { spectrum: new Float32Array(24).fill(level) }, 0)
      for (let column = 1; column < 15; column += 1) {
        const existingRows = Array.from({ length: 6 }, (_, row) => row)
          .filter(row => topology.mask[row * 22 + column] === 1)
        const litRows = existingRows.filter(row => frame[row * 22 + column] !== 0)
        const expectedExisting = existingRows.filter(row => row >= 6 - expectedRows)
        expect(litRows).toEqual(expectedExisting)
      }
    }
  })

  it('uses size as a monotonic vertical scale with five as neutral', () => {
    const base = settings({
      smoothing: 0,
      sensitivity: 1,
      backgroundEffect: 'off',
      keyboard: {
        ...DEFAULT_CHROMA_SETTINGS.keyboard,
        style: 'spectrum-static',
        theme: 'white',
        beatFlash: false,
      },
    })
    const input = { spectrum: new Float32Array(24).fill(0.35) }
    const small = frameLight(keyboardFor({ ...base, size: 1 }, input, 0))
    const neutral = frameLight(keyboardFor({ ...base, size: 5 }, input, 0))
    const large = frameLight(keyboardFor({ ...base, size: 10 }, input, 0))
    expect(small).toBeLessThan(neutral)
    expect(neutral).toBeLessThan(large)
  })

  it('keeps constant spectrum levels unchanged when resampling', () => {
    for (const level of [0.1, 0.5, 1]) {
      const output = resampleSpectrum(new Float32Array(24).fill(level), 22)
      for (const value of output) expect(value).toBeCloseTo(level, 5)
    }
  })

  it('masks logical keyboard and mouse holes using public SDK coordinates', () => {
    const config = settings({
      smoothing: 0,
      size: 10,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-static', theme: 'white', beatFlash: false },
      mouse: { ...DEFAULT_CHROMA_SETTINGS.mouse, style: 'static', theme: 'white', beatFlash: false },
    })
    const result = createChromaStyleEngine().render({ ...audio, spectrum: new Float32Array(24).fill(1) }, config, { now: 0 })
    const keyboardMask = getChromaDeviceTopology('keyboard').mask
    const mouseMask = getChromaDeviceTopology('mouse').mask
    expect(Array.from(result.frames.keyboard!).every((value, index) => keyboardMask[index] === 1 || value === 0)).toBe(true)
    expect(Array.from(result.frames.mouse!).every((value, index) => mouseMask[index] === 1 || value === 0)).toBe(true)
    const huntsman = getChromaDeviceTopology('keyboard', [{ type: 'keyboard', pid: '0266' }])
    expect(huntsman.id).toBe('razer-huntsman-v2-analog')
    expect(huntsman.mask[5 * 22]).toBe(0)
    expect(huntsman.mask[5 * 22 + 1]).toBe(1)
    expect(mouseMask.reduce((sum, value) => sum + value, 0)).toBe(22)
  })

  it('renders keypad spectrum as bottom-up columns', () => {
    const config = settings({
      smoothing: 0,
      size: 5,
      keypad: { ...DEFAULT_CHROMA_SETTINGS.keypad, style: 'spectrum', theme: 'white', beatFlash: false },
    })
    const frame = createChromaStyleEngine().render({ spectrum: new Float32Array(24).fill(0.5) }, config, { now: 0 }).frames.keypad!
    for (let column = 0; column < 5; column += 1) {
      expect(frame[column]).toBe(0)
      expect(frame[5 + column]).toBe(0)
      expect(frame[10 + column]).toBeGreaterThan(0)
      expect(frame[15 + column]).toBeGreaterThan(0)
    }
  })

  it('maps bars from the bottom and applies ltr/mirror/center directions', () => {
    const spectrum = new Float32Array(24)
    spectrum[0] = 1
    spectrum[1] = 1
    const base = settings({
      smoothing: 0,
      keyboard: {
        ...DEFAULT_CHROMA_SETTINGS.keyboard,
        style: 'bars',
        theme: 'white',
        background: '#000000',
        beatFlash: false,
      },
    })
    const ltr = keyboardFor({ ...base, foregroundDirection: 'ltr', keyboard: { ...base.keyboard, direction: 'ltr' } }, { spectrum }, 0)
    expect(ltr[5 * 22]).toBeGreaterThan(0)
    expect(ltr[1 * 22]).toBeGreaterThan(0)
    expect(ltr[5 * 22 + 21]).toBe(0)

    const columnLight = (frame: Uint32Array, column: number) =>
      Array.from({ length: 6 }, (_, row) => frame[row * 22 + column])
        .reduce((sum, color) => sum + (color & 0xff) + ((color >>> 8) & 0xff) + ((color >>> 16) & 0xff), 0)
    const mirror = keyboardFor({ ...base, foregroundDirection: 'mirror', keyboard: { ...base.keyboard, direction: 'mirror' } }, { spectrum }, 0)
    expect(columnLight(mirror, 10)).toBeGreaterThan(columnLight(mirror, 0))
    expect(columnLight(mirror, 11)).toBeGreaterThan(columnLight(mirror, 21))

    const center = keyboardFor({ ...base, foregroundDirection: 'center', keyboard: { ...base.keyboard, direction: 'center' } }, { spectrum }, 0)
    expect(columnLight(center, 0)).toBeGreaterThan(columnLight(center, 10))
    expect(columnLight(center, 21)).toBeGreaterThan(columnLight(center, 11))
  })

  it('applies brightness, sensitivity, and beat flash', () => {
    const base = settings({
      smoothing: 0,
      foregroundBeatFlash: false,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'bars', theme: 'white', beatFlash: false },
    })
    const dark = keyboardFor({ ...base, brightness: 0.4 }, audio, 0)
    const bright = keyboardFor({ ...base, brightness: 2 }, audio, 0)
    expect(frameLight(bright)).toBeGreaterThan(frameLight(dark))

    const low = keyboardFor({ ...base, sensitivity: 0.25 }, audio, 0)
    const high = keyboardFor({ ...base, sensitivity: 2 }, audio, 0)
    expect(frameLight(high)).toBeGreaterThan(frameLight(low))

    const noFlash = keyboardFor(base, { ...audio, beat: 1 }, 0)
    const flash = keyboardFor({ ...base, foregroundBeatFlash: true, keyboard: { ...base.keyboard, beatFlash: true } }, { ...audio, beat: 1 }, 0)
    expect(frameLight(flash)).toBeGreaterThan(frameLight(noFlash))
  })

  it('cycles spectrum hues over time independently of theme gradients', () => {
    const config = settings({
      smoothing: 0,
      colorRotationSpeed: 1,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-cycle', theme: 'white', beatFlash: false },
    })
    const first = keyboardFor(config, audio, 0)
    const second = keyboardFor(config, audio, 1700)
    expect(signature(second)).not.toBe(signature(first))
    expect(new Set(first).size).toBeGreaterThan(3)
  })

  it('uses decay for both attack and release speed', () => {
    const base = settings({
      smoothing: 0.45,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-static', theme: 'white', beatFlash: false },
    })
    const silence: ChromaAudioData = { spectrum: new Float32Array(24) }
    const loud: ChromaAudioData = { ...audio, spectrum: new Float32Array(24).fill(1), overall: 1 }
    const slow = createChromaStyleEngine()
    const fast = createChromaStyleEngine()
    const slowAttack = slow.render(loud, { ...base, decay: 1 }, { now: 0 }).frames.keyboard
    const fastAttack = fast.render(loud, { ...base, decay: 10 }, { now: 0 }).frames.keyboard
    expect(frameLight(fastAttack)).toBeGreaterThan(frameLight(slowAttack))

    const slowReleaseEngine = createChromaStyleEngine()
    const fastReleaseEngine = createChromaStyleEngine()
    slowReleaseEngine.render(loud, { ...base, smoothing: 0 }, { now: 0 })
    fastReleaseEngine.render(loud, { ...base, smoothing: 0 }, { now: 0 })
    const slowRelease = slowReleaseEngine.render(silence, { ...base, decay: 1 }, { now: 33 }).frames.keyboard
    const fastRelease = fastReleaseEngine.render(silence, { ...base, decay: 10 }, { now: 33 }).frames.keyboard
    expect(frameLight(slowRelease)).toBeGreaterThan(frameLight(fastRelease))
  })

  it('keeps decay timing approximately frame-rate independent', () => {
    const config = settings({
      smoothing: 0.45,
      decay: 5,
      backgroundEffect: 'off',
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-static', beatFlash: false },
    })
    const loud: ChromaAudioData = { spectrum: new Float32Array(24).fill(1), overall: 1 }
    const silence: ChromaAudioData = { spectrum: new Float32Array(24) }
    const at15 = createChromaStyleEngine()
    const at30 = createChromaStyleEngine()
    at15.render(loud, config, { now: 0 })
    at30.render(loud, config, { now: 0 })
    let frame15 = at15.render(silence, config, { now: 0 })
    let frame30 = at30.render(silence, config, { now: 0 })
    for (let now = 67; now <= 1000; now += 67) frame15 = at15.render(silence, config, { now })
    for (let now = 33; now <= 1000; now += 33) frame30 = at30.render(silence, config, { now })
    const light15 = frameLight(frame15.frames.keyboard)
    const light30 = frameLight(frame30.frames.keyboard)
    expect(Math.abs(light15 - light30)).toBeLessThan(Math.max(20, Math.max(light15, light30) * 0.12))
  })

  it('keeps the canonical preview independent from hardware mapping size', () => {
    const base = settings({
      smoothing: 0,
      backgroundEffect: 'off',
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-gradient', beatFlash: false },
    })
    const small = createChromaStyleEngine().render(audio, { ...base, size: 1 }, { now: 700 })
    const large = createChromaStyleEngine().render(audio, { ...base, size: 10 }, { now: 700 })
    expect(Array.from(small.visualizerField!.colors)).toEqual(Array.from(large.visualizerField!.colors))
    expect(Array.from(small.foregroundField!.colors)).toEqual(Array.from(large.foregroundField!.colors))
    expect(Array.from(small.backgroundField!.colors)).toEqual(Array.from(large.backgroundField!.colors))
    expect(signature(small.frames.keyboard!)).not.toBe(signature(large.frames.keyboard!))
    expect(signature(small.frames.mousepad!)).not.toBe(signature(large.frames.mousepad!))
  })

  it('layers static and reactive backgrounds only into unlit regions', () => {
    const silence: ChromaAudioData = { spectrum: new Float32Array(24) }
    const base = settings({
      smoothing: 0,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-static', background: '#102030', beatFlash: false },
    })
    const off = keyboardFor({ ...base, backgroundEffect: 'off', reactiveBackground: false }, silence, 0)
    const staticBackground = keyboardFor({ ...base, backgroundEffect: 'static', backgroundBrightness: 0.5 }, silence, 0)
    const reactive = keyboardFor({ ...base, backgroundEffect: 'off', reactiveBackground: true }, { spectrum: new Float32Array(24) }, 0)
    expect(frameLight(off)).toBe(0)
    expect(frameLight(staticBackground)).toBeGreaterThan(0)
    expect(frameLight(reactive)).toBe(0)
  })

  it('renders deterministic and distinct fire, rain, vu-meter, and ripple effects', () => {
    const styles: KeyboardChromaStyle[] = ['fire', 'rain', 'vu-meter', 'ripple']
    const frames = styles.map(style => keyboardFor(settings({
      smoothing: 0,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style, beatFlash: false },
    }), audio, 1420))
    expect(new Set(frames.map(signature)).size).toBe(styles.length)
    for (let index = 0; index < styles.length; index += 1) {
      const repeated = keyboardFor(settings({
        smoothing: 0,
        keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: styles[index], beatFlash: false },
      }), audio, 1420)
      expect(repeated).toEqual(frames[index])
    }
    const fire = frames[0]
    const top = fire.slice(0, 22).reduce((sum, value) => sum + value, 0)
    const bottom = fire.slice(110).reduce((sum, value) => sum + value, 0)
    expect(bottom).toBeGreaterThan(top)
  })

  it('keeps hardware frames identical when previewEnabled changes', () => {
    const enabled = keyboardFor(settings({ previewEnabled: true, smoothing: 0 }), audio, 500)
    const disabled = keyboardFor(settings({ previewEnabled: false, smoothing: 0 }), audio, 500)
    expect(disabled).toEqual(enabled)
  })
})

describe('Chroma idle behavior', () => {
  it('supports off, static, breathing, and release while paused', () => {
    const off = createChromaStyleEngine().render(audio, settings({ idleMode: 'off' }), { paused: true, now: 0 })
    expect(off.action).toBe('frame')
    expect(frameSum(off.frames.keyboard)).toBe(0)

    const staticFrame = createChromaStyleEngine().render(audio, settings({ idleMode: 'static', backgroundEffect: 'static', backgroundStaticColor: '#00ff66' }), { paused: true, now: 0 })
    expect(frameSum(staticFrame.frames.keyboard)).toBeGreaterThan(0)
    expect(new Set(staticFrame.frames.keyboard!).size).toBe(2)
    expect(staticFrame.frames.keyboard![0]).toBe(0)

    const breathingEngine = createChromaStyleEngine()
    const breathingA = breathingEngine.render(audio, settings({ idleMode: 'breathing', backgroundEffect: 'breath', backgroundStaticColor: '#00ff66' }), { paused: true, now: 0 })
    const breathingB = breathingEngine.render(audio, settings({ idleMode: 'breathing', backgroundEffect: 'breath', backgroundStaticColor: '#00ff66' }), { paused: true, now: 1400 })
    expect(frameSum(breathingA.frames.keyboard)).not.toBe(frameSum(breathingB.frames.keyboard))

    const release = createChromaStyleEngine().render(audio, settings({ idleMode: 'release' }), { paused: true })
    expect(release.action).toBe('release')
    expect(CHROMA_DEVICE_TYPES.every(device => release.frames[device] === null)).toBe(true)
  })

  it('only treats a hidden window as idle when background rendering is disabled', () => {
    const stopped = createChromaStyleEngine().render(audio, settings({ runInBackground: false, idleMode: 'off' }), { hidden: true })
    const running = createChromaStyleEngine().render(audio, settings({ runInBackground: true, idleMode: 'off' }), { hidden: true })
    expect(frameSum(stopped.frames.keyboard)).toBe(0)
    expect(frameSum(running.frames.keyboard)).toBeGreaterThan(0)
  })

  it('does not mutate audio or settings inputs', () => {
    const inputSpectrum = Array.from({ length: 24 }, (_, index) => index / 24)
    const input: ChromaAudioData = { ...audio, spectrum: inputSpectrum }
    const config = settings({ smoothing: 0 })
    const spectrumBefore = [...inputSpectrum]
    const settingsBefore = JSON.stringify(config)
    createChromaStyleEngine().render(input, config, { now: 42 })
    expect(inputSpectrum).toEqual(spectrumBefore)
    expect(JSON.stringify(config)).toBe(settingsBefore)
  })
})
