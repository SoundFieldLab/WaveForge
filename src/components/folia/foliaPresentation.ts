export interface FoliaPresentationInput {
  isPlaybackPage: boolean
  lyricMode: string
  upNextEnabled: boolean
  hasNext: boolean
  playMode: string
  showUpNext: boolean
  autoMixRunning: boolean
  transitionDuration: number
}

export interface FoliaPresentation {
  active: boolean
  cardVisible: boolean
  transitionBorderVisible: boolean
  overlayVisible: boolean
  useLegacyUpNext: boolean
}

/** Pure display-only routing. Audio/queue state remains owned by App/useAudioPlayer. */
export function resolveFoliaPresentation(input: FoliaPresentationInput): FoliaPresentation {
  const active = input.isPlaybackPage && input.lyricMode === 'folia'
  const eligibleNext = input.upNextEnabled && input.hasNext && input.playMode !== 'repeat'
  const cardVisible = active && eligibleNext && (input.showUpNext || input.autoMixRunning)
  const transitionBorderVisible = cardVisible && input.autoMixRunning
  return {
    active,
    cardVisible,
    transitionBorderVisible,
    overlayVisible: active && input.autoMixRunning && input.transitionDuration >= 5 && !transitionBorderVisible,
    useLegacyUpNext: !active,
  }
}
