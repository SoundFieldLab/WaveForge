import { describe, expect, it } from 'vitest'
import { resolvePairTransitionStrategy } from '../src/hooks/useAudioPlayer'
import type { AppleNativeStream } from '../src/services/applePlayback'

const appleHls = { url: 'blob:apple#apple-hls.m3u8' } as AppleNativeStream
const normal = { url: 'https://audio.example/song.mp3' }
const apple = { url: appleHls.url, appleHls }

const strategy = (current: typeof normal | typeof apple, next: typeof normal | typeof apple, settings: Partial<{ autoMix: boolean; crossfade: boolean; gapless: boolean }>) =>
  resolvePairTransitionStrategy(current, next, { autoMix: false, crossfade: false, gapless: false, ...settings })

describe('Apple pair transition strategy', () => {
  it('keeps full AutoMix for non-Apple pairs', () => {
    expect(strategy(normal, normal, { autoMix: true })).toBe('automix')
  })

  it.each([
    [apple, apple],
    [apple, normal],
    [normal, apple],
  ])('downgrades AutoMix only when either side is Apple CENC', (current, next) => {
    expect(strategy(current, next, { autoMix: true })).toBe('gapless')
  })

  it('honors explicit crossfade and gapless for Apple pairs', () => {
    expect(strategy(apple, normal, { crossfade: true })).toBe('fixed-crossfade')
    expect(strategy(normal, apple, { gapless: true })).toBe('gapless')
    expect(strategy(apple, apple, {})).toBe('none')
  })
})
