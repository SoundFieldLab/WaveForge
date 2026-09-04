import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Moon as MoonIcon, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import type { WeatherSnapshot } from '../services/weatherService'
import { moonInfoAt, moonRiseSet, daysToFullMoon } from '../services/moonPhase'
import moonUrl from '../assets/weather/moon.webp'

// 月亮卡片 + 全屏月相页：真实满月照片 + SVG 相位阴影实时渲染；
// 刻度尺可在 ±7 天内拖动，月亮与信息随之实时变化（PC 版对应手机端"滑动实时月相"）。

interface MoonPhaseExperienceProps {
  weather: WeatherSnapshot | null
  open: boolean
  onOpen: () => void
  onClose: () => void
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 相位阴影路径：phase 0 新月 → 0.5 满月 → 1 新月；北半球盈月右侧亮，阴影始终盖住暗面 */
function moonShadowPath(phase: number): string {
  const c = 50
  const r = 49
  const k = Math.cos(2 * Math.PI * phase)
  const waxing = phase <= 0.5
  const rx = Math.max(0.01, r * Math.abs(k))
  // SVG y 轴向下：T→B sweep=0 走左侧、sweep=1 走右侧；B→T 相反。
  // 盈月暗面在左：左缘弧 + 明暗界线椭圆（crescent 凸向右 / gibbous 凸向左）
  if (waxing) {
    const returnSweep = k > 0 ? 0 : 1
    return `M ${c} ${c - r} A ${r} ${r} 0 0 0 ${c} ${c + r} A ${rx} ${r} 0 0 ${returnSweep} ${c} ${c - r} Z`
  }
  // 亏月暗面在右
  const returnSweep = k > 0 ? 1 : 0
  return `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${rx} ${r} 0 0 ${returnSweep} ${c} ${c - r} Z`
}

export function MoonDisc({ phase, className = '', soft = true }: { phase: number; className?: string; soft?: boolean }) {
  return (
    <div className={`relative aspect-square ${className}`}>
      <img src={moonUrl} alt="" className="absolute inset-0 h-full w-full rounded-full object-cover" style={{ filter: 'brightness(1.32) contrast(1.06)' }} draggable={false} />
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full">
        <defs>
          <filter id="moon-terminator-blur">
            <feGaussianBlur stdDeviation={soft ? 1.2 : 0.7} />
          </filter>
          <clipPath id="moon-disc-clip">
            <circle cx="50" cy="50" r="49.4" />
          </clipPath>
        </defs>
        <g clipPath="url(#moon-disc-clip)">
          <path d={moonShadowPath(phase)} fill="#04060c" opacity="0.92" filter="url(#moon-terminator-blur)" />
        </g>
      </svg>
    </div>
  )
}

const RANGE_DAYS = 7
const TICKS_PER_DAY = 12 // 每 2 小时一刻度

export default function MoonPhaseExperience({ weather, open, onOpen, onClose }: MoonPhaseExperienceProps) {
  const [offsetDays, setOffsetDays] = useState(0)
  const rulerRef = useRef<HTMLDivElement | null>(null)
  const draggingRef = useRef(false)
  if (typeof document === 'undefined') return null

  const now = Date.now()
  const scrubDate = useMemo(() => new Date(now + offsetDays * 86400000), [now, offsetDays])
  const info = useMemo(() => moonInfoAt(scrubDate), [scrubDate])
  const riseSet = useMemo(() => {
    const loc = weather?.location
    if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') return null
    return moonRiseSet(new Date(), loc.latitude, loc.longitude)
  }, [weather])

  const scrubLabel = useMemo(() => {
    const d = scrubDate
    const h = d.getHours()
    const m = String(d.getMinutes()).padStart(2, '0')
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${String(h).padStart(2, '0')}:${m}`
  }, [scrubDate])

  const handleRulerPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const ruler = rulerRef.current
    if (!ruler) return
    const rect = ruler.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    let next = (ratio * 2 - 1) * RANGE_DAYS
    if (Math.abs(next) < 0.06) next = 0
    setOffsetDays(next)
  }

  const ticks = useMemo(() => {
    const list: Array<{ x: number; major: boolean; label?: string; highlight?: boolean }> = []
    const total = RANGE_DAYS * 2
    for (let i = 0; i <= total * TICKS_PER_DAY; i++) {
      const dayFrac = i / TICKS_PER_DAY - RANGE_DAYS
      const x = ((dayFrac / total) + 0.5) * 100
      const major = i % TICKS_PER_DAY === 0
      let label: string | undefined
      let highlight = false
      if (major) {
        const date = new Date(now + dayFrac * 86400000)
        const isToday = new Date(now).toDateString() === date.toDateString()
        highlight = isToday
        label = isToday ? '今天' : WEEKDAYS[date.getDay()]
      }
      list.push({ x, major, label, highlight })
    }
    return list
  }, [now])

  const markerX = (offsetDays / (RANGE_DAYS * 2) + 0.5) * 100

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[420] flex flex-col items-center overflow-y-auto bg-slate-950/78 px-6 py-10 text-white backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="flex w-full max-w-[560px] flex-col items-center"
            initial={{ y: 22, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex w-full items-center justify-between">
              <div className="flex items-center gap-2 text-lg font-semibold"><MoonIcon className="h-5 w-5" />月亮</div>
              <button
                type="button"
                onClick={onClose}
                title="关闭月相"
                aria-label="关闭月相"
                className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 transition-colors hover:bg-white/20"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <MoonDisc phase={info.phase} className="mt-8 w-[min(62vw,300px)] drop-shadow-[0_0_50px_rgba(190,205,255,0.22)]" />

            <div className="mt-6 text-center">
              <div className="text-2xl font-semibold">{info.phaseName}</div>
              <div className="mt-1 text-sm text-white/60">{scrubLabel}</div>
            </div>

            {/* 刻度尺拖动：实时改变月相 */}
            <div
              ref={rulerRef}
              className="mt-7 w-full cursor-ew-resize touch-none select-none px-1"
              onPointerDown={event => {
                draggingRef.current = true
                ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
                handleRulerPointer(event)
              }}
              onPointerMove={event => { if (draggingRef.current) handleRulerPointer(event) }}
              onPointerUp={() => { draggingRef.current = false }}
              onPointerCancel={() => { draggingRef.current = false }}
              role="slider"
              aria-label="时间刻度尺：拖动查看不同日期的月相"
              aria-valuemin={-RANGE_DAYS}
              aria-valuemax={RANGE_DAYS}
              aria-valuenow={Number(offsetDays.toFixed(2))}
              tabIndex={0}
              onKeyDown={event => {
                if (event.key === 'ArrowLeft') setOffsetDays(v => Math.max(-RANGE_DAYS, v - 0.25))
                if (event.key === 'ArrowRight') setOffsetDays(v => Math.min(RANGE_DAYS, v + 0.25))
                if (event.key === 'Escape') onClose()
              }}
            >
              <div className="relative h-14">
                <div className="absolute inset-x-0 top-1 h-7">
                  {ticks.map((tick, index) => (
                    <span
                      key={index}
                      className="absolute top-0 rounded-full"
                      style={{
                        left: `${tick.x}%`,
                        width: tick.major ? 2 : 1,
                        height: tick.major ? 22 : 10,
                        top: tick.major ? 0 : 6,
                        background: tick.highlight ? '#7cb8ff' : 'rgba(255,255,255,0.42)',
                      }}
                    />
                  ))}
                </div>
                <span
                  className="absolute top-[-6px] h-0 w-0 border-x-[7px] border-t-[10px] border-x-transparent border-t-sky-300"
                  style={{ left: `calc(${markerX}% - 7px)` }}
                />
                <div className="absolute inset-x-0 top-9 flex justify-between text-[11px] leading-4 text-white/55">
                  {ticks.filter(t => t.major && t.label).map((tick, index) => (
                    <span
                      key={index}
                      className={tick.highlight ? 'font-semibold text-sky-300' : ''}
                      style={{ position: 'absolute', left: `${tick.x}%`, transform: 'translateX(-50%)' }}
                    >
                      {tick.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4 w-full overflow-hidden rounded-3xl border border-white/10">
              {[
                ['照射范围', `${Math.round(info.illumination * 100)}%`],
                ['月龄', `${info.ageDays.toFixed(1)} 天`],
                ['下次满月', `${daysToFullMoon(scrubDate)} 天`],
                ['地心距离', `${info.distanceKm.toLocaleString('zh-CN')} 公里`],
                ['月出', riseSet?.rise ?? '--:--'],
                ['月落', riseSet?.set ?? '--:--'],
              ].map(([label, value], index) => (
                <div key={label} className={`flex items-center justify-between px-5 py-3.5 text-sm ${index > 0 ? 'border-t border-white/8' : ''} ${index % 2 === 1 ? 'bg-white/[0.03]' : ''}`}>
                  <span className="text-white/72">{label}</span>
                  <span className="font-medium tabular-nums">{value}</span>
                </div>
              ))}
            </div>

            <div className="mt-4 text-xs text-white/35">拖动刻度尺查看前后 7 天的月相变化 · 天文数据为近似值</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
