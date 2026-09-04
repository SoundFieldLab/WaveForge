import { describe, expect, it } from 'vitest'
import { shouldRunAudioAnalyzer } from '../src/hooks/useAudioAnalyzer'

describe('audio analyzer background lease gating', () => {
  it('runs while visible when there is a listener', () => {
    expect(shouldRunAudioAnalyzer('visible', true, false)).toBe(true)
  })

  it('stops while hidden without a background consumer', () => {
    expect(shouldRunAudioAnalyzer('hidden', true, false)).toBe(false)
  })

  it('keeps sampling while hidden when a background lease is held', () => {
    expect(shouldRunAudioAnalyzer('hidden', true, true)).toBe(true)
  })

  it('never samples without listeners even if a background lease is held', () => {
    expect(shouldRunAudioAnalyzer('visible', false, true)).toBe(false)
    expect(shouldRunAudioAnalyzer('hidden', false, true)).toBe(false)
  })
})
