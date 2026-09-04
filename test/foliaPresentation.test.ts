import { describe, expect, it } from 'vitest'
import { resolveFoliaPresentation } from '../src/components/folia/foliaPresentation'

const base = {
  isPlaybackPage: true,
  lyricMode: 'folia',
  upNextEnabled: true,
  hasNext: true,
  playMode: 'sequential',
  showUpNext: true,
  autoMixRunning: false,
  transitionDuration: 10,
}

describe('Folia presentation isolation', () => {
  it('uses the Folia card only on the Folia playback surface', () => {
    const folia = resolveFoliaPresentation(base)
    expect(folia.active).toBe(true)
    expect(folia.cardVisible).toBe(true)
    expect(folia.useLegacyUpNext).toBe(false)

    const modern = resolveFoliaPresentation({ ...base, lyricMode: 'modern' })
    expect(modern.active).toBe(false)
    expect(modern.cardVisible).toBe(false)
    expect(modern.useLegacyUpNext).toBe(true)
  })

  it('transition border suppresses the central ring to avoid duplicate animations', () => {
    const state = resolveFoliaPresentation({ ...base, autoMixRunning: true, showUpNext: false })
    expect(state.cardVisible).toBe(true)
    expect(state.transitionBorderVisible).toBe(true)
    expect(state.overlayVisible).toBe(false)
  })

  it('shows the central ring when up-next is disabled and transition lasts at least five seconds', () => {
    const state = resolveFoliaPresentation({ ...base, upNextEnabled: false, showUpNext: false, autoMixRunning: true })
    expect(state.cardVisible).toBe(false)
    expect(state.overlayVisible).toBe(true)
  })

  it('does not show the central transition animation below five seconds', () => {
    const state = resolveFoliaPresentation({ ...base, upNextEnabled: false, showUpNext: false, autoMixRunning: true, transitionDuration: 4.99 })
    expect(state.overlayVisible).toBe(false)
  })

  it('repeat mode suppresses only the Folia card, not other lyric-page routing', () => {
    const state = resolveFoliaPresentation({ ...base, playMode: 'repeat' })
    expect(state.cardVisible).toBe(false)
    expect(state.useLegacyUpNext).toBe(false)
  })
})
