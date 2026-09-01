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
    expect(new Set(signatures).size).toBe(styles.length)
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

  it('maps bars from the bottom and applies ltr/mirror/center directions', () => {
    const spectrum = new Float32Array(24)
    spectrum[0] = 1
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
    const ltr = keyboardFor({ ...base, keyboard: { ...base.keyboard, direction: 'ltr' } }, { spectrum }, 0)
    expect(ltr[5 * 22]).toBeGreaterThan(0)
    expect(ltr[0]).toBeGreaterThan(0)
    expect(ltr[5 * 22 + 21]).toBe(0)

    const mirror = keyboardFor({ ...base, keyboard: { ...base.keyboard, direction: 'mirror' } }, { spectrum }, 0)
    expect(mirror[5 * 22 + 10]).toBeGreaterThan(mirror[5 * 22])
    expect(mirror[5 * 22 + 11]).toBeGreaterThan(mirror[5 * 22 + 21])

    const center = keyboardFor({ ...base, keyboard: { ...base.keyboard, direction: 'center' } }, { spectrum }, 0)
    expect(center[5 * 22]).toBeGreaterThan(center[5 * 22 + 10])
    expect(center[5 * 22 + 21]).toBeGreaterThan(center[5 * 22 + 11])
  })

  it('applies brightness, sensitivity, and beat flash', () => {
    const base = settings({
      smoothing: 0,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'bars', theme: 'white', beatFlash: false },
    })
    const dark = keyboardFor({ ...base, brightness: 0.4 }, audio, 0)
    const bright = keyboardFor({ ...base, brightness: 2 }, audio, 0)
    expect(frameLight(bright)).toBeGreaterThan(frameLight(dark))

    const low = keyboardFor({ ...base, sensitivity: 0.25 }, audio, 0)
    const high = keyboardFor({ ...base, sensitivity: 2 }, audio, 0)
    expect(frameLight(high)).toBeGreaterThan(frameLight(low))

    const noFlash = keyboardFor(base, { ...audio, beat: 1 }, 0)
    const flash = keyboardFor({ ...base, keyboard: { ...base.keyboard, beatFlash: true } }, { ...audio, beat: 1 }, 0)
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

  it('changes spectrum grouping and wave width with size', () => {
    const narrow = settings({
      smoothing: 0,
      size: 1,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-gradient', beatFlash: false },
    })
    const wide = { ...narrow, size: 10 }
    expect(signature(keyboardFor(wide, audio, 700))).not.toBe(signature(keyboardFor(narrow, audio, 700)))
  })

  it('layers static and reactive backgrounds only into unlit regions', () => {
    const silence: ChromaAudioData = { spectrum: new Float32Array(24) }
    const base = settings({
      smoothing: 0,
      keyboard: { ...DEFAULT_CHROMA_SETTINGS.keyboard, style: 'spectrum-static', background: '#102030', beatFlash: false },
    })
    const off = keyboardFor({ ...base, backgroundEffect: 'off', reactiveBackground: false }, silence, 0)
    const staticBackground = keyboardFor({ ...base, backgroundEffect: 'static', backgroundBrightness: 0.5 }, silence, 0)
    const reactive = keyboardFor({ ...base, backgroundEffect: 'off', reactiveBackground: true }, audio, 0)
    expect(frameLight(off)).toBe(0)
    expect(frameLight(staticBackground)).toBeGreaterThan(0)
    expect(frameLight(reactive)).toBeGreaterThan(0)
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

    const staticFrame = createChromaStyleEngine().render(audio, settings({ idleMode: 'static' }), { paused: true, now: 0 })
    expect(frameSum(staticFrame.frames.keyboard)).toBeGreaterThan(0)
    expect(new Set(staticFrame.frames.keyboard!).size).toBe(1)

    const breathingEngine = createChromaStyleEngine()
    const breathingA = breathingEngine.render(audio, settings({ idleMode: 'breathing' }), { paused: true, now: 0 })
    const breathingB = breathingEngine.render(audio, settings({ idleMode: 'breathing' }), { paused: true, now: 1400 })
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
