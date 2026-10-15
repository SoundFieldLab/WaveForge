import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModeParked } from '../utils/modeLayer'
import { Moon as MoonIcon, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import type { WeatherSnapshot } from '../services/weatherService'
import { moonInfoAt, moonRiseSet, daysToFullMoon } from '../services/moonPhase'
import { APPLE_MOON_PHASES, getAppleMoonPhaseFrames } from './weatherScene/appleMoonPhases'

// 月亮卡片 + 全屏月相页：真实满月照片 + SVG 相位阴影实时渲染；
// 刻度尺可在 ±7 天内拖动，月亮与信息随之实时变化（PC 版对应手机端"滑动实时月相"）。

interface MoonPhaseExperienceProps {
  weather: WeatherSnapshot | null
  open: boolean
  onOpen: () => void
  onClose: () => void
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Apple Weather 原始 28 帧月相，相邻帧交叉淡化以保持时间尺拖动连续。 */
export function MoonDisc({ phase, className = '' }: { phase: number; className?: string; soft?: boolean }) {
  const { lower, upper, mix } = getAppleMoonPhaseFrames(phase)
  return (
    <div className={`relative aspect-square ${className}`}>
      <img src={APPLE_MOON_PHASES[lower]} alt="" className="absolute inset-0 h-full w-full object-contain" style={{ opacity: 1 - mix }} draggable={false} />
      {mix > 0.001 && <img src={APPLE_MOON_PHASES[upper]} alt="" className="absolute inset-0 h-full w-full object-contain" style={{ opacity: mix }} draggable={false} />}
    </div>
  )
}

const RANGE_DAYS = 30
const TICKS_PER_DAY = 4 // 每 6 小时一刻度（±30 天跨度下 12/天 过密）

/** 月相日历（Apple 式）：scrubDate 所在月为基准，每格显示日期 + 当日月相小图。
 *  月份可前后翻页；点击日期把刻度尺拨到那天。 */
function MoonPhaseCalendar({ scrubDate, onSelect }: { scrubDate: Date; onSelect: (date: Date) => void }) {
  const [monthOffset, setMonthOffset] = useState(0)
  const cells = useMemo(() => {
    const anchor = new Date(scrubDate)
    const view = new Date(anchor.getFullYear(), anchor.getMonth() + monthOffset, 1)
    const year = view.getFullYear()
    const month = view.getMonth()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const firstWeekday = new Date(year, month, 1).getDay()
    const leading = Array.from({ length: firstWeekday }, (_, index) => ({ key: `lead-${index}`, day: null as number | null, date: null as Date | null, phase: 0 }))
    const dayCells = Array.from({ length: daysInMonth }, (_, index) => {
      const date = new Date(year, month, index + 1, 12, 0, 0, 0)
      return { key: `day-${index}`, day: index + 1, date, phase: moonInfoAt(date).phase }
    })
    return { year, month, cells: [...leading, ...dayCells] }
  }, [scrubDate, monthOffset])
  const monthLabel = `${cells.year} 年 ${cells.month + 1} 月`
  const isCurrentView = cells.year === scrubDate.getFullYear() && cells.month === scrubDate.getMonth()
  return (
    <div className="mt-4 w-full rounded-3xl border border-white/10 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white/82">月相日历</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMonthOffset(v => v - 1)}
            aria-label="上一月"
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >‹</button>
          <span className="min-w-[96px] text-center text-[13px] tabular-nums text-white/72">{monthLabel}</span>
          <button
            type="button"
            onClick={() => setMonthOffset(v => v + 1)}
            aria-label="下一月"
            className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >›</button>
        </span>
      </div>
      <div className="mt-3 grid grid-cols-7 gap-y-2 text-center text-[11px] text-white/40">
        {WEEKDAYS.map(w => <span key={w}>{w[0]}</span>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-y-2.5">
        {cells.cells.map(cell => (
          <div key={cell.key} className="flex flex-col items-center">
            {cell.day !== null && cell.date ? (
              <button
                type="button"
                onClick={() => onSelect(cell.date!)}
                className={`group flex flex-col items-center gap-0.5 rounded-xl px-1.5 py-1 transition-colors hover:bg-white/10 ${isCurrentView && cell.date.toDateString() === new Date().toDateString() ? 'ring-1 ring-sky-400/60' : ''}`}
                title={`${cell.date.getMonth() + 1}月${cell.day}日`}
              >
                <span className={`text-[12px] tabular-nums ${cell.date.toDateString() === new Date().toDateString() ? 'font-semibold text-sky-300' : 'text-white/78'}`}>{cell.day}</span>
                <MoonDisc phase={cell.phase} className="w-6" />
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/** 预热全部 28 帧月相图：拖动时相邻帧交叉淡化依赖两张图即时就绪，
 *  未预热的图在加载间隙会让月亮闪烁（拖快时一闪一闪）。 */
let moonFramesPreloaded = false
function preloadMoonFrames() {
  if (moonFramesPreloaded || typeof window === 'undefined') return
  moonFramesPreloaded = true
  for (const src of APPLE_MOON_PHASES) {
    const image = new Image()
    image.src = src
  }
}

export default function MoonPhaseExperience({ weather, open, onOpen, onClose }: MoonPhaseExperienceProps) {
  // 挂起（所属模式层被切走）时不渲染这个 portal：portal 挂在 body 上，不受挂起层
  // visibility:hidden 约束，留着会盖住当前模式。只隐藏不卸载，切回来状态原样。
  const parked = useModeParked()
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
    return moonRiseSet(scrubDate, loc.latitude, loc.longitude, weather?.timezone)
  }, [scrubDate, weather?.location.latitude, weather?.location.longitude, weather?.timezone])

  const scrubLabel = useMemo(() => {
    const d = scrubDate
    const h = d.getHours()
    const m = String(d.getMinutes()).padStart(2, '0')
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${String(h).padStart(2, '0')}:${m}`
  }, [scrubDate])

  // 打开时预热全部帧图：消除拖动中相邻帧切换的加载闪烁
  useEffect(() => {
    if (open) preloadMoonFrames()
  }, [open])

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
        if (isToday) {
          label = '今天'
        } else {
          const daysAway = Math.round(dayFrac)
          // 近端（±7 天）显示周几（Apple 同款），远端显示日期——跨度大了周几没有信息量
          label = Math.abs(daysAway) <= 7
            ? WEEKDAYS[date.getDay()]
            : `${date.getMonth() + 1}/${date.getDate()}`
        }
      }
      list.push({ x, major, label, highlight })
    }
    return list
  }, [now])

  const markerX = (offsetDays / (RANGE_DAYS * 2) + 0.5) * 100

  if (parked) return null

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

            <MoonDisc phase={info.phase} className="mt-6 w-[min(74vw,380px)] drop-shadow-[0_0_44px_rgba(190,205,255,0.3)]" />

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

            <div className="mt-4 text-xs text-white/35">拖动刻度尺查看前后 30 天的月相变化 · 天文数据为近似值</div>

            <MoonPhaseCalendar scrubDate={scrubDate} onSelect={date => {
              // 点选日历日期：把刻度尺拨到那天 12:00（正午月相代表全天）
              const target = new Date(date)
              target.setHours(12, 0, 0, 0)
              setOffsetDays((target.getTime() - now) / 86400000)
            }} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
