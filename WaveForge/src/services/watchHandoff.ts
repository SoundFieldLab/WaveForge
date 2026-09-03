export interface SongOwnedHandoff<T> {
  songKey: string
  value: T
}

export function createSongOwnedHandoff<T>(songKey: string, value: T): SongOwnedHandoff<T> {
  return { songKey, value }
}

export function readSongOwnedHandoff<T>(
  handoff: SongOwnedHandoff<T> | null,
  songKey: string,
  fallback: T,
): T {
  return handoff?.songKey === songKey ? handoff.value : fallback
}
