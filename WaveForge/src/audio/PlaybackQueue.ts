import type { PlaybackMode } from './types'

export function stableTrackKey(track: {
  id?: number | string
  mid?: string
  platform?: string
  name?: string
  url?: string
}): string {
  const platform = track.platform?.trim() || 'netease'
  const identity = String(track.mid ?? track.id ?? track.url ?? track.name ?? '').trim()
  if (!identity) throw new Error('Cannot create a playback key for a track without identity')
  return `${platform}-${identity}`
}

function hashString(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededShuffleIndex(trackKeys: string[], currentIndex: number, revision: number): number | undefined {
  if (trackKeys.length <= 1) return undefined
  const currentKey = trackKeys[currentIndex] || String(currentIndex)
  const available = trackKeys.map((_, index) => index).filter(index => index !== currentIndex)
  if (available.length === 0) return undefined
  const seed = hashString(`${revision}:${currentKey}:${trackKeys.join('|')}`)
  return available[seed % available.length]
}

export function getDeterministicNextIndex(
  trackKeys: string[],
  currentIndex: number,
  mode: PlaybackMode,
  revision = 0
): number | undefined {
  if (trackKeys.length <= 1 || currentIndex < 0 || currentIndex >= trackKeys.length) return undefined
  if (mode === 'repeat') return undefined
  if (mode === 'shuffle') return seededShuffleIndex(trackKeys, currentIndex, revision)
  return (currentIndex + 1) % trackKeys.length
}

export function getUpcomingIndices(
  trackKeys: string[],
  currentIndex: number,
  mode: PlaybackMode,
  revision = 0,
  count = 2
): number[] {
  if (trackKeys.length <= 1 || count <= 0 || mode === 'repeat') return []
  const result: number[] = []
  const visited = new Set<number>([currentIndex])
  let cursor = currentIndex
  let localRevision = revision

  while (result.length < Math.min(count, trackKeys.length - 1)) {
    let next: number | undefined
    let attempts = 0
    while (attempts < trackKeys.length * 2) {
      const candidate = getDeterministicNextIndex(trackKeys, cursor, mode, localRevision + attempts)
      if (candidate !== undefined && !visited.has(candidate)) {
        next = candidate
        break
      }
      attempts += 1
    }
    if (next === undefined) break
    result.push(next)
    visited.add(next)
    cursor = next
    localRevision += attempts + 1
  }
  return result
}
