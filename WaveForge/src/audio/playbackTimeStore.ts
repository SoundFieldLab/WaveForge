export interface PlaybackTimeSnapshot {
  currentTime: number
  duration: number
  isPlaying: boolean
}

export interface PlaybackTimeStore {
  getSnapshot: () => PlaybackTimeSnapshot
  subscribe: (listener: () => void) => () => void
  publish: (state: Partial<PlaybackTimeSnapshot>) => void
}

export function createPlaybackTimeStore(initial: Partial<PlaybackTimeSnapshot> = {}): PlaybackTimeStore {
  let snapshot: PlaybackTimeSnapshot = {
    currentTime: initial.currentTime ?? 0,
    duration: initial.duration ?? 0,
    isPlaying: initial.isPlaying ?? false,
  }
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (state) => {
      const nextCurrentTime = state.currentTime ?? snapshot.currentTime
      const nextDuration = state.duration ?? snapshot.duration
      const nextIsPlaying = state.isPlaying ?? snapshot.isPlaying

      if (
        nextCurrentTime === snapshot.currentTime
        && nextDuration === snapshot.duration
        && nextIsPlaying === snapshot.isPlaying
      ) return

      snapshot = {
        currentTime: nextCurrentTime,
        duration: nextDuration,
        isPlaying: nextIsPlaying,
      }
      listeners.forEach(listener => listener())
    },
  }
}
