import { useSyncExternalStore } from 'react'
import type { DesktopPlayerSnapshot } from './electron'

export interface DesktopRealtimeSnapshot {
  progress: number
  progressUpdatedAt: number
  spectrum: readonly number[]
}

const ZERO_SPECTRUM = Object.freeze([0, 0, 0, 0, 0])
let snapshot: DesktopRealtimeSnapshot = Object.freeze({
  progress: 0,
  progressUpdatedAt: performance.now(),
  spectrum: ZERO_SPECTRUM,
})
const listeners = new Set<() => void>()

export function publishDesktopRealtime(partial: Partial<Pick<DesktopPlayerSnapshot, 'progress' | 'spectrum'>>) {
  const hasProgress = typeof partial.progress === 'number' && Number.isFinite(partial.progress)
  const hasSpectrum = Array.isArray(partial.spectrum)
  if (!hasProgress && !hasSpectrum) return

  const nextSpectrum = hasSpectrum
    ? Object.freeze([0, 1, 2, 3, 4].map(index => Math.max(0, Math.min(1, Number(partial.spectrum?.[index]) || 0))))
    : snapshot.spectrum
  snapshot = Object.freeze({
    progress: hasProgress ? partial.progress! : snapshot.progress,
    progressUpdatedAt: hasProgress ? performance.now() : snapshot.progressUpdatedAt,
    spectrum: nextSpectrum,
  })
  listeners.forEach(listener => listener())
}

export function getDesktopRealtimeSnapshot() {
  return snapshot
}

export function useDesktopRealtimeSnapshot() {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getDesktopRealtimeSnapshot,
    getDesktopRealtimeSnapshot,
  )
}

export function getInterpolatedDesktopProgress(realtime: DesktopRealtimeSnapshot, playing: boolean) {
  if (!playing) return realtime.progress
  return realtime.progress + Math.max(0, performance.now() - realtime.progressUpdatedAt) / 1000
}
