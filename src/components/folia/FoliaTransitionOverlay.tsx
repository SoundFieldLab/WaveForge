import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useState } from 'react'

export interface FoliaTransitionOverlayProps {
  visible: boolean
  suppressed?: boolean
  progress: number
  duration: number
  bpm?: number
  accentColor: string
  theme: 'light' | 'dark'
  onDismiss?: () => void
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/** Clean-room Folia-surface AutoMix indicator. It reads playback state only. */
export function FoliaTransitionOverlay({
  visible,
  suppressed = false,
  progress,
  duration,
  bpm,
  accentColor,
  theme,
  onDismiss,
}: FoliaTransitionOverlayProps) {
  const reducedMotion = useReducedMotion()
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    if (!visible) setDismissed(false)
  }, [visible])
  const show = visible && !suppressed && !dismissed && duration >= 5
  const amount = clamp01(progress)
  const circumference = 2 * Math.PI * 68
  const beatSeconds = bpm && bpm > 30 ? 60 / bpm : 0

  useEffect(() => {
    if (!show) return
    const dismiss = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof MouseEvent && event.button !== 0) return
      onDismiss?.()
      setDismissed(true)
    }
    document.addEventListener('keydown', dismiss)
    document.addEventListener('mousedown', dismiss)
    return () => {
      document.removeEventListener('keydown', dismiss)
      document.removeEventListener('mousedown', dismiss)
    }
  }, [show, onDismiss])

  const foreground = theme === 'dark' ? 'rgba(255,255,255,.94)' : 'rgba(20,22,28,.88)'
  const track = theme === 'dark' ? 'rgba(255,255,255,.13)' : 'rgba(16,18,24,.14)'

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          data-testid="folia-transition-overlay"
          aria-label="AutoMix 过渡进行中"
          className="pointer-events-none fixed inset-0 z-[170] flex items-center justify-center"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.88, filter: 'blur(8px)' }}
          animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 1.06, filter: 'blur(6px)' }}
          transition={{ duration: reducedMotion ? 0.2 : 0.7, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="relative h-44 w-44">
            <motion.div
              className="absolute inset-[-26px] rounded-full"
              style={{ background: `radial-gradient(circle, ${accentColor}3D 0%, ${accentColor}12 42%, transparent 72%)` }}
              animate={reducedMotion ? undefined : { opacity: [0.45, 0.85, 0.45], scale: [0.96, 1.04, 0.96] }}
              transition={{ duration: beatSeconds > 0.2 && beatSeconds < 2 ? beatSeconds : 1.4, repeat: Infinity, ease: 'easeInOut' }}
            />
            <svg viewBox="0 0 176 176" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
              <circle cx="88" cy="88" r="68" fill="none" stroke={track} strokeWidth="5" />
              <motion.circle
                cx="88" cy="88" r="68" fill="none" stroke={accentColor} strokeWidth="5"
                strokeLinecap="round" strokeDasharray={circumference}
                animate={{ strokeDashoffset: circumference * (1 - amount) }}
                transition={{ duration: reducedMotion ? 0 : 0.12, ease: 'linear' }}
                style={{ filter: `drop-shadow(0 0 8px ${accentColor}99)` }}
              />
              <line x1="88" y1="14" x2="88" y2="24" stroke={foreground} strokeWidth="2" strokeLinecap="round" transform="rotate(180 88 88)" opacity="0.75" />
              <circle cx="88" cy="20" r="4.5" fill={foreground} transform={`rotate(${amount * 360} 88 88)`} />
            </svg>
            <div className="absolute inset-[34px] rounded-full border" style={{ borderColor: track, background: theme === 'dark' ? 'rgba(7,9,14,.48)' : 'rgba(255,255,255,.52)', backdropFilter: 'blur(18px)' }}>
              <div className="flex h-full flex-col items-center justify-center">
                <span className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: foreground }}>AutoMix</span>
                <span className="mt-1 text-lg font-semibold tabular-nums" style={{ color: foreground }}>{Math.round(amount * 100)}%</span>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default FoliaTransitionOverlay
