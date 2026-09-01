import { describe, expect, it } from 'vitest'
import { normalizeChromaSettings } from '../src/plugins/clients/ChromaClient'

describe('Chroma persistent output state', () => {
  it('keeps output enabled for legacy settings without the field', () => {
    expect(normalizeChromaSettings({ fps: 15 }).outputEnabled).toBe(true)
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
