import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BellRing, RotateCcw } from 'lucide-react'

interface DesktopFocusAlarmOverlayProps {
  open: boolean
  accentColor: string
  onStop: () => void
  onRepeat: () => void
  title?: string
  detail?: string
}

export default function DesktopFocusAlarmOverlay({ open, accentColor, onStop, onRepeat, title = '专注时间结束', detail = '' }: DesktopFocusAlarmOverlayProps) {
  const [now, setNow] = useState(() => new Date())
  const [slideValue, setSlideValue] = useState(0)

  useEffect(() => {
    if (!open) return
    setSlideValue(0)
    const interval = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(interval)
  }, [open])

  const finishSlide = () => {
    if (slideValue >= 94) onStop()
    else setSlideValue(0)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[12000] flex flex-col items-center justify-center overflow-hidden bg-[#03050a] text-white">
          <div aria-hidden="true" className="absolute inset-0" style={{ background: `radial-gradient(circle at 50% 40%, ${accentColor}26, transparent 35%), radial-gradient(circle at 50% 120%, ${accentColor}18, transparent 45%)` }} />
          <motion.div aria-hidden="true" className="absolute h-[520px] w-[520px] rounded-full border" style={{ borderColor: `${accentColor}22` }} animate={{ scale: [0.82, 1.22], opacity: [0.7, 0] }} transition={{ duration: 2.1, repeat: Infinity, ease: 'easeOut' }} />
          <motion.div aria-hidden="true" className="absolute h-[360px] w-[360px] rounded-full border" style={{ borderColor: `${accentColor}30` }} animate={{ scale: [0.82, 1.32], opacity: [0.65, 0] }} transition={{ duration: 2.1, delay: .55, repeat: Infinity, ease: 'easeOut' }} />

          <div className="relative z-10 flex flex-col items-center px-6 text-center">
            <motion.div animate={{ rotate: [-7, 7, -5, 5, 0] }} transition={{ duration: .65, repeat: Infinity, repeatDelay: .55 }} className="flex h-16 w-16 items-center justify-center rounded-full border border-white/12 bg-white/7 shadow-2xl"><BellRing className="h-7 w-7" style={{ color: accentColor }} /></motion.div>
            <div className="mt-7 text-sm font-medium uppercase tracking-[0.32em] text-white/45">{title}</div>
            {detail && <div className="mt-3 text-sm text-white/35">{detail}</div>}
            <div className="mt-5 text-[clamp(5rem,13vw,11rem)] font-semibold leading-none tracking-[-0.075em] tabular-nums drop-shadow-2xl">{now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
            <div className="mt-5 text-base tracking-[0.16em] text-white/52">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(now)}</div>
            <button type="button" onClick={onRepeat} className="mt-10 flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.055] px-6 py-3 text-sm text-white/72 backdrop-blur-xl transition hover:bg-white/10"><RotateCcw className="h-4 w-4" />重复计时</button>

            <div className="relative mt-8 h-16 w-[min(390px,80vw)] overflow-hidden rounded-full border border-white/12 bg-white/[0.06] p-1.5 shadow-[inset_0_2px_18px_rgba(0,0,0,.35)] backdrop-blur-xl">
              <div className="pointer-events-none absolute inset-y-1.5 left-1.5 rounded-full transition-[width] duration-100" style={{ width: `calc(${slideValue}% - ${slideValue * .06}px)`, background: `linear-gradient(90deg, ${accentColor}88, ${accentColor}22)` }} />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-medium tracking-[0.12em] text-white/52" style={{ opacity: 1 - slideValue / 90 }}>滑动以停止</div>
              <motion.div className="pointer-events-none absolute left-2 top-2 flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-950 shadow-xl" style={{ x: `calc(${slideValue * 3.22}px)` }}><span className="text-lg">›</span></motion.div>
              <input aria-label="滑动以停止提醒" type="range" min="0" max="100" value={slideValue} onChange={event => setSlideValue(Number(event.target.value))} onPointerUp={finishSlide} onKeyUp={event => (event.key === 'Enter' || event.key === ' ') && finishSlide()} className="absolute inset-0 h-full w-full cursor-grab opacity-0 active:cursor-grabbing" />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
