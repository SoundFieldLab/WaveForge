export interface PlaybackShortcutSettings {
  playbackPageEnabled: boolean
  spacePlayPauseEnabled: boolean
  seekForwardSeconds: number
  seekBackwardSeconds: number
  mediaKeysEnabled: boolean
}

export const PLAYBACK_SHORTCUT_SETTINGS_KEY = 'playbackShortcutSettings'
export const PLAYBACK_SHORTCUT_SETTINGS_EVENT = 'playbackShortcutSettingsChanged'

export const DEFAULT_PLAYBACK_SHORTCUT_SETTINGS: PlaybackShortcutSettings = {
  playbackPageEnabled: true,
  spacePlayPauseEnabled: true,
  seekForwardSeconds: 5,
  seekBackwardSeconds: 5,
  mediaKeysEnabled: true,
}

const clampSeekSeconds = (value: unknown, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(15, Math.max(1, Math.round(parsed))) : fallback
}

export function loadPlaybackShortcutSettings(): PlaybackShortcutSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_PLAYBACK_SHORTCUT_SETTINGS }

  try {
    const parsed = JSON.parse(localStorage.getItem(PLAYBACK_SHORTCUT_SETTINGS_KEY) || '{}')
    return {
      playbackPageEnabled: parsed.playbackPageEnabled !== false,
      spacePlayPauseEnabled: parsed.spacePlayPauseEnabled !== false,
      seekForwardSeconds: clampSeekSeconds(parsed.seekForwardSeconds, 5),
      seekBackwardSeconds: clampSeekSeconds(parsed.seekBackwardSeconds, 5),
      mediaKeysEnabled: parsed.mediaKeysEnabled !== false,
    }
  } catch {
    return { ...DEFAULT_PLAYBACK_SHORTCUT_SETTINGS }
  }
}

export function savePlaybackShortcutSettings(
  patch: Partial<PlaybackShortcutSettings>,
): PlaybackShortcutSettings {
  const next = {
    ...loadPlaybackShortcutSettings(),
    ...patch,
  }
  next.seekForwardSeconds = clampSeekSeconds(next.seekForwardSeconds, 5)
  next.seekBackwardSeconds = clampSeekSeconds(next.seekBackwardSeconds, 5)

  localStorage.setItem(PLAYBACK_SHORTCUT_SETTINGS_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent<PlaybackShortcutSettings>(PLAYBACK_SHORTCUT_SETTINGS_EVENT, {
    detail: next,
  }))
  return next
}
