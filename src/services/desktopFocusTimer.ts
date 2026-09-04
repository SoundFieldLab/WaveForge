export type DesktopFocusTimerStatus = 'idle' | 'running' | 'paused' | 'ringing'

export interface DesktopFocusTimerState {
  status: DesktopFocusTimerStatus
  durationMs: number
  remainingMs: number
  endAt: number | null
  label: string
  phase: 'focus' | 'shortBreak' | 'longBreak'
  completedSessions: number
  sessionGoal: number
}

export const DESKTOP_FOCUS_TIMER_EVENT = 'desktopFocusTimerChanged'
const STORAGE_KEY = 'desktopFocusTimer'

const DEFAULT_TIMER: DesktopFocusTimerState = {
  status: 'idle',
  durationMs: 25 * 60 * 1000,
  remainingMs: 25 * 60 * 1000,
  endAt: null,
  label: '',
  phase: 'focus',
  completedSessions: 0,
  sessionGoal: 4,
}

const clampDuration = (durationMs: number) => Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, durationMs))

export const getFocusTimerRemainingMs = (timer: DesktopFocusTimerState, now = Date.now()) => {
  if (timer.status === 'running' && timer.endAt) return Math.max(0, timer.endAt - now)
  if (timer.status === 'ringing') return 0
  return Math.max(0, timer.remainingMs)
}

export const loadDesktopFocusTimer = (): DesktopFocusTimerState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_TIMER }
    const parsed = JSON.parse(raw) as Partial<DesktopFocusTimerState>
    const durationMs = clampDuration(Number(parsed.durationMs) || DEFAULT_TIMER.durationMs)
    const status: DesktopFocusTimerStatus = ['idle', 'running', 'paused', 'ringing'].includes(String(parsed.status))
      ? parsed.status as DesktopFocusTimerStatus
      : 'idle'
    const timer: DesktopFocusTimerState = {
      status,
      durationMs,
      remainingMs: Math.min(durationMs, Math.max(0, Number(parsed.remainingMs) || durationMs)),
      endAt: typeof parsed.endAt === 'number' ? parsed.endAt : null,
      label: typeof parsed.label === 'string' ? parsed.label : '',
      phase: parsed.phase === 'shortBreak' || parsed.phase === 'longBreak' ? parsed.phase : 'focus',
      completedSessions: Math.max(0, Math.round(Number(parsed.completedSessions) || 0)),
      sessionGoal: Math.max(1, Math.min(12, Math.round(Number(parsed.sessionGoal) || 4))),
    }
    if (timer.status === 'running' && timer.endAt && timer.endAt <= Date.now()) {
      return { ...timer, status: 'ringing', remainingMs: 0, endAt: null }
    }
    return timer
  } catch {
    return { ...DEFAULT_TIMER }
  }
}

export const saveDesktopFocusTimer = (timer: DesktopFocusTimerState) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(timer))
  window.dispatchEvent(new CustomEvent(DESKTOP_FOCUS_TIMER_EVENT, { detail: timer }))
  return timer
}

export const startDesktopFocusTimer = (durationMs: number, options: Partial<Pick<DesktopFocusTimerState, 'label' | 'phase' | 'sessionGoal'>> = {}) => {
  const safeDuration = clampDuration(durationMs)
  const previous = loadDesktopFocusTimer()
  return saveDesktopFocusTimer({
    status: 'running',
    durationMs: safeDuration,
    remainingMs: safeDuration,
    endAt: Date.now() + safeDuration,
    label: options.label ?? previous.label,
    phase: options.phase ?? previous.phase,
    completedSessions: previous.completedSessions,
    sessionGoal: options.sessionGoal ?? previous.sessionGoal,
  })
}

export const pauseDesktopFocusTimer = (timer = loadDesktopFocusTimer()) => {
  if (timer.status !== 'running') return timer
  const remainingMs = getFocusTimerRemainingMs(timer)
  return saveDesktopFocusTimer({ ...timer, status: 'paused', remainingMs, endAt: null })
}

export const resumeDesktopFocusTimer = (timer = loadDesktopFocusTimer()) => {
  if (timer.status !== 'paused') return timer
  const remainingMs = Math.max(1000, timer.remainingMs)
  return saveDesktopFocusTimer({ ...timer, status: 'running', remainingMs, endAt: Date.now() + remainingMs })
}

export const stopDesktopFocusTimer = (timer = loadDesktopFocusTimer()) => saveDesktopFocusTimer({
  ...timer,
  status: 'idle',
  durationMs: timer.durationMs,
  remainingMs: timer.durationMs,
  endAt: null,
})

export const markDesktopFocusTimerRinging = (timer = loadDesktopFocusTimer()) => {
  if (timer.status !== 'running' || getFocusTimerRemainingMs(timer) > 0) return timer
  return saveDesktopFocusTimer({ ...timer, status: 'ringing', remainingMs: 0, endAt: null, completedSessions: timer.phase === 'focus' ? timer.completedSessions + 1 : timer.completedSessions })
}
