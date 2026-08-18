import { useCallback, useSyncExternalStore } from 'react'
import {
  DESKTOP_FOCUS_TIMER_EVENT,
  type DesktopFocusTimerState,
  getFocusTimerRemainingMs,
  loadDesktopFocusTimer,
  markDesktopFocusTimerRinging,
  pauseDesktopFocusTimer,
  resumeDesktopFocusTimer,
  startDesktopFocusTimer,
  stopDesktopFocusTimer,
} from '../services/desktopFocusTimer'

type Listener = () => void

const timerListeners = new Set<Listener>()
const remainingListeners = new Set<Listener>()
let timerSnapshot: DesktopFocusTimerState | null = null
let remainingSnapshot = 0
let scheduler: number | null = null
let listening = false

const ensureSnapshot = () => {
  if (!timerSnapshot) {
    timerSnapshot = loadDesktopFocusTimer()
    remainingSnapshot = getFocusTimerRemainingMs(timerSnapshot)
  }
  return timerSnapshot
}

const notify = (listeners: Set<Listener>) => listeners.forEach(listener => listener())

const clearScheduler = () => {
  if (scheduler !== null) {
    window.clearTimeout(scheduler)
    scheduler = null
  }
}

const scheduleNextTick = () => {
  clearScheduler()
  const timer = ensureSnapshot()
  if (timer.status !== 'running' || (timerListeners.size === 0 && remainingListeners.size === 0)) return

  const remaining = getFocusTimerRemainingMs(timer)
  if (remaining <= 0) {
    markDesktopFocusTimerRinging(timer)
    return
  }

  // Align updates to the next visible second instead of running a timer in every hook instance.
  // The countdown stays smooth while idle CPU usage drops substantially.
  const untilNextSecond = remaining - Math.max(0, Math.ceil(remaining / 1000) - 1) * 1000
  const delay = document.visibilityState === 'hidden'
    ? Math.min(1000, remaining)
    : Math.min(1000, Math.max(40, untilNextSecond + 12))

  scheduler = window.setTimeout(() => {
    scheduler = null
    const current = ensureSnapshot()
    const nextRemaining = getFocusTimerRemainingMs(current)
    if (nextRemaining <= 0) {
      markDesktopFocusTimerRinging(current)
      return
    }

    if (Math.ceil(nextRemaining / 1000) !== Math.ceil(remainingSnapshot / 1000)) {
      remainingSnapshot = nextRemaining
      notify(remainingListeners)
    }
    scheduleNextTick()
  }, delay)
}

const handleTimerChange = (event: Event) => {
  timerSnapshot = (event as CustomEvent<DesktopFocusTimerState>).detail || loadDesktopFocusTimer()
  remainingSnapshot = getFocusTimerRemainingMs(timerSnapshot)
  notify(timerListeners)
  notify(remainingListeners)
  scheduleNextTick()
}

const handleVisibilityChange = () => {
  const timer = ensureSnapshot()
  const nextRemaining = getFocusTimerRemainingMs(timer)
  if (nextRemaining <= 0 && timer.status === 'running') {
    markDesktopFocusTimerRinging(timer)
    return
  }
  if (Math.ceil(nextRemaining / 1000) !== Math.ceil(remainingSnapshot / 1000)) {
    remainingSnapshot = nextRemaining
    notify(remainingListeners)
  }
  scheduleNextTick()
}

const startListening = () => {
  if (listening) return
  listening = true
  window.addEventListener(DESKTOP_FOCUS_TIMER_EVENT, handleTimerChange)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  ensureSnapshot()
  scheduleNextTick()
}

const stopListeningIfIdle = () => {
  if (timerListeners.size > 0 || remainingListeners.size > 0 || !listening) return
  listening = false
  clearScheduler()
  window.removeEventListener(DESKTOP_FOCUS_TIMER_EVENT, handleTimerChange)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
}

const subscribeTimer = (listener: Listener) => {
  timerListeners.add(listener)
  startListening()
  return () => {
    timerListeners.delete(listener)
    stopListeningIfIdle()
  }
}

const subscribeRemaining = (listener: Listener) => {
  remainingListeners.add(listener)
  startListening()
  return () => {
    remainingListeners.delete(listener)
    stopListeningIfIdle()
  }
}

const emptySubscribe = () => () => undefined
const getTimerSnapshot = () => ensureSnapshot()
const getRemainingSnapshot = () => {
  ensureSnapshot()
  return remainingSnapshot
}

export function useDesktopFocusTimer(trackRemaining = true) {
  const timer = useSyncExternalStore(subscribeTimer, getTimerSnapshot, getTimerSnapshot)
  const remainingMs = useSyncExternalStore(
    trackRemaining ? subscribeRemaining : emptySubscribe,
    trackRemaining ? getRemainingSnapshot : () => timer.remainingMs,
    trackRemaining ? getRemainingSnapshot : () => timer.remainingMs,
  )

  return {
    timer,
    remainingMs,
    start: useCallback((durationMs: number, options?: Parameters<typeof startDesktopFocusTimer>[1]) => startDesktopFocusTimer(durationMs, options), []),
    pause: useCallback(() => pauseDesktopFocusTimer(), []),
    resume: useCallback(() => resumeDesktopFocusTimer(), []),
    stop: useCallback(() => stopDesktopFocusTimer(), []),
    repeat: useCallback(() => startDesktopFocusTimer(loadDesktopFocusTimer().durationMs), []),
  }
}
