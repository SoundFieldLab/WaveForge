import { describe, expect, it } from 'vitest'
import { normalizeChromaSettings } from '../src/plugins/clients/ChromaClient'

describe('Chroma persistent output state', () => {
  it('keeps output enabled for legacy settings without the field', () => {
    expect(normalizeChromaSettings({ fps: 15 }).outputEnabled).toBe(true)
  })

  it('migrates legacy bars and its old size meaning to the new neutral spectrum scale', () => {
    const migrated = normalizeChromaSettings({
      size: 3,
      keyboard: { style: 'bars' },
    })
    expect(migrated.schemaVersion).toBe(3)
    expect(migrated.spectrumScaleVersion).toBe(2)
    expect(migrated.size).toBe(5)
    expect(migrated.keyboard.style).toBe('spectrum-gradient')

    const current = normalizeChromaSettings({
      schemaVersion: 3,
      spectrumScaleVersion: 2,
      size: 3,
      keyboard: { style: 'spectrum-gradient' },
    })
    expect(current.size).toBe(3)
  })

  it('migrates foreground and background independently and clamps brightness', () => {
    const migrated = normalizeChromaSettings({
      brightness: 2,
      backgroundEffect: 'static',
      backgroundBrightness: 2,
      keyboard: {
        theme: 'custom',
        customColors: ['#AABBCC', '#112233'],
        background: '#445566',
        direction: 'mirror',
      },
    })
    expect(migrated.brightness).toBe(1)
    expect(migrated.backgroundBrightness).toBe(1)
    expect(migrated.foregroundGradient).toEqual(['#aabbcc', '#112233'])
    expect(migrated.foregroundDirection).toBe('mirror')
    expect(migrated.backgroundStaticColor).toBe('#445566')
    expect(migrated.backgroundEffect).toBe('static')
  })

  it('sanitizes v3 colors, directions, and legacy pulse aliases', () => {
    const normalized = normalizeChromaSettings({
      schemaVersion: 3,
      brightness: 9,
      foregroundStaticColor: 'not-a-color',
      foregroundGradient: ['#ABCDEF', 'bad'],
      foregroundDirection: 'diagonal',
      backgroundStaticColor: '#123456',
      backgroundGradient: ['#654321', '#FEDCBA'],
      backgroundDirection: 'center',
      keyboard: { style: 'pulse' },
    } as any)
    expect(normalized.brightness).toBe(1)
    expect(normalized.foregroundStaticColor).toBe('#00ff66')
    expect(normalized.foregroundGradient).toEqual(['#abcdef', '#00aaff'])
    expect(normalized.foregroundDirection).toBe('ltr')
    expect(normalized.backgroundStaticColor).toBe('#123456')
    expect(normalized.backgroundGradient).toEqual(['#654321', '#fedcba'])
    expect(normalized.backgroundDirection).toBe('center')
    expect(normalized.keyboard.style).toBe('radial-pulse')
  })

  it('preserves an explicit stopped output across reload normalization', () => {
    const stopped = normalizeChromaSettings({
      outputEnabled: false,
      keyboard: { enabled: false, style: 'fire' },
    })
    const reloaded = normalizeChromaSettings(JSON.parse(JSON.stringify(stopped)))
    expect(reloaded.outputEnabled).toBe(false)
    expect(reloaded.keyboard.enabled).toBe(false)
    expect(reloaded.keyboard.style).toBe('fire')
  })
})
