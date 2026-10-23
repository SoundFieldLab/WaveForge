import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModeParked } from '../utils/modeLayer'
import { Moon as MoonIcon, X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import type { WeatherSnapshot } from '../services/weatherService'
import { moonInfoAt, moonRiseSet, daysToFullMoon } from '../services/moonPhase'
import { APPLE_MOON_PHASES, getAppleMoonPhaseFrames } from './weatherScene/appleMoonPhases'

// 月亮卡片 + 全屏月相页：真实满月照片 + SVG 相位阴影实时渲染；
// 刻度尺只窗口化显示 ±3.5 天（一周），拖到边缘继续拖动会平移窗口露出更远的历史/未来
// （Apple 天气同款交互），月相日历负责跨月跳转。

interface MoonPhaseExperienceProps {
  weather: WeatherSnapshot | null
  open: boolean
  onOpen: () => void
  onClose: () => void
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Apple Weather 原始 28 帧月相，相邻帧交叉淡化以保持时间尺拖动连续。
 *  两层图常驻 DOM（都渲染、只切 opacity），上层帧未解码完成时回退全显下层——
 *  否则拖快时上层先透明后加载，月亮会一闪一闪（用户实测的高光闪烁）。 */
export function MoonDisc({ phase, className = '' }: { phase: number; className?: string; soft?: boolean }) {
  const { lower, upper, mix } = getAppleMoonPhaseFrames(phase)
  // mix≈0 时上层不需要渲染；mix>0 但图未就绪时也只用下层，避免半帧空白
  const upperReady = mix > 0.001 && typeof window !== 'undefined' && APPLE_MOON_PHASES[upper] !== undefined
  const upperLoaded = useImageReady(upperReady ? APPLE_MOON_PHASES[upper] : null)
  const showUpper = upperReady && upperLoaded
  return (
    <div className={`relative aspect-square ${className}`}>
      <img src={APPLE_MOON_PHASES[lower]} alt="" className="absolute inset-0 h-full w-full object-contain" style={{ opacity: showUpper ? 1 - mix : 1 }} draggable={false} />
      {upperReady && (
        <img
          src={APPLE_MOON_PHASES[upper]}
          alt=""
          className="absolute inset-0 h-full w-full object-contain"
          style={{ opacity: showUpper ? mix : 0 }}
          onLoad={markImageReady(APPLE_MOON_PHASES[upper])}
          draggable={false}
        />
      )}
    </div>
  )
}

// 帧图就绪登记表：同一帧只需等待一次，之后所有 MoonDisc 实例立即认为它已加载
const moonFrameReadySet = new Set<string>()
const markImageReady = (src: string) => () => { moonFrameReadySet.add(src) }
function useImageReady(src: string | null): boolean {
  const [ready, setReady] = useState(() => (src ? moonFrameReadySet.has(src) || isImageCached(src) : true))
  useEffect(() => {
    if (!src || moonFrameReadySet.has(src) || isImageCached(src)) { if (src) moonFrameReadySet.add(src); return }
    setReady(false)
    const image = new Image()
    image.onload = () => { moonFrameReadySet.add(src); setReady(true) }
    image.src = src
  }, [src])
  return ready || !src
}
const isImageCached = (src: string) => {
  try {
    const image = new Image()
    image.src = src
    return image.complete
  } catch { return false }
}

const RANGE_DAYS = 30 // 可拖动的总体范围（±30 天，更远的日期用月相日历跳转）
const VISIBLE_DAYS = 7 // 整把刻度尺宽度对应的天数：一屏只显示 7 天，防止刻度挤成一坨
const TICKS_PER_DAY = 4 // 每 6 小时一刻度

/** 月相日历（Apple 式）：scrubDate 所在月为基准，大格子显示日期 + 当日月相小图。
 *  月份可前后翻页；选中日有圆角高亮框，底部展示本月新月/满月日期。 */
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
    // 本月内的新月/满月日期（相位 0 附近=新月，0.5 附近=满月；当月找不到时用相位推算下一次）
    const findPhaseDay = (target: number) => {
      let best: { day: number; diff: number } | null = null
      for (const cell of dayCells) {
        const diff = Math.min(Math.abs(cell.phase - target), 1 - Math.abs(cell.phase - target))
        if (!best || diff < best.diff) best = { day: cell.day, diff }
      }
      return best
    }
    const newMoonDay = findPhaseDay(0)
    const fullMoonDay = findPhaseDay(0.5)
    const fmt = (date: Date) => `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`
    // 新月：本月相位 0 附近的天，否则回退"相位退回 0 的时刻"（当月中旬后新月已过 → 下月月初）
    const nextNewDate = (day: { day: number; diff: number } | null) => {
      if (day && day.diff < 0.08) return new Date(year, month, day.day)
      const midPhase = moonInfoAt(new Date(year, month, 15, 12, 0, 0, 0)).phase
      return new Date(new Date(year, month, 15, 12, 0, 0, 0).getTime() + (1 - midPhase) * 29.5306 * 86400000)
    }
    // 满月：本月相位 0.5 附近的天，否则用 nextFullMoonDays 从月内中点推算
    const nextFullDate = (day: { day: number; diff: number } | null) => {
      if (day && day.diff < 0.08) return new Date(year, month, day.day)
      const mid = new Date(year, month, 15, 12, 0, 0, 0)
      return new Date(mid.getTime() + moonInfoAt(mid).nextFullMoonDays * 86400000)
    }
    return {
      year,
      month,
      cells: [...leading, ...dayCells],
      newMoonLabel: fmt(nextNewDate(newMoonDay)),
      fullMoonLabel: fmt(nextFullDate(fullMoonDay)),
    }
  }, [scrubDate, monthOffset])
  const monthLabel = `${cells.year} 年 ${cells.month + 1} 月`
  const todayString = new Date().toDateString()
  const selectedString = scrubDate.toDateString()
  return (
    <div className="mt-4 w-full rounded-3xl border border-white/10 p-5">
      <div className="flex items-center justify-between">
        <span className="text-base font-semibold text-white/88">日历</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMonthOffset(v => v - 1)}
            aria-label="上一月"
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >‹</button>
          <span className="min-w-[110px] text-center text-[15px] font-medium tabular-nums text-white/85">{monthLabel}</span>
          <button
            type="button"
            onClick={() => setMonthOffset(v => v + 1)}
            aria-label="下一月"
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >›</button>
        </span>
      </div>
      <div className="mt-4 grid grid-cols-7 gap-y-3 text-center text-[12px] font-medium text-white/45">
        {WEEKDAYS.map(w => <span key={w}>{w}</span>)}
      </div>
      <div className="mt-2 grid grid-cols-7 gap-y-3">
        {cells.cells.map(cell => (
          <div key={cell.key} className="flex flex-col items-center">
            {cell.day !== null && cell.date ? (
              <button
                type="button"
                onClick={() => onSelect(cell.date!)}
                className={`flex w-[44px] flex-col items-center gap-1 rounded-2xl px-1 py-1.5 transition-colors ${
                  selectedString === cell.date.toDateString()
                    ? 'bg-sky-500/25 ring-1 ring-sky-300/80'
                    : cell.date.toDateString() === todayString ? 'bg-white/[0.06] hover:bg-white/12' : 'hover:bg-white/10'
                }`}
                title={`${cell.date.getMonth() + 1}月${cell.day}日`}
              >
                <span className={`text-[13px] tabular-nums ${selectedString === cell.date.toDateString() ? 'font-semibold text-sky-200' : cell.date.toDateString() === todayString ? 'font-semibold text-sky-300' : 'text-white/78'}`}>{cell.day}</span>
                <MoonDisc phase={cell.phase} className="w-[30px]" />
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 border-t border-white/10">
        {[['新月', cells.newMoonLabel], ['满月', cells.fullMoonLabel]].map(([label, value], index) => (
          <div key={label} className={`flex items-center justify-between px-1 py-3 text-sm ${index > 0 ? 'border-t border-white/8' : ''}`}>
            <span className="text-white/82 font-medium">{label}</span>
            <span className="tabular-nums text-white/62">{value}</span>
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
  const dragStartRef = useRef({ pointerX: 0, offsetDays: 0 })
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

  // Apple 天气同款交互：指针固定在刻度尺正中，按住后**水平拖动 1:1 滚动日期**
  //（向左拖=未来，向右拖=历史），松手立刻停住——没有边缘平移、没有惯性，
  // 不存在"按住不放就一直跑"。刻度尺整体宽度恰好对应 VISIBLE_DAYS 天。
  const handleRulerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true
    dragStartRef.current = { pointerX: event.clientX, offsetDays }
    ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  }

  const handleRulerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const ruler = rulerRef.current
    if (!ruler) return
    const rect = ruler.getBoundingClientRect()
    const deltaDays = (event.clientX - dragStartRef.current.pointerX) / Math.max(1, rect.width) * VISIBLE_DAYS
    // 向右拖（正位移）→ 回看历史（负偏移），与"日期从右往左滚过中央指针"一致
    let next = dragStartRef.current.offsetDays - deltaDays
    next = Math.max(-RANGE_DAYS, Math.min(RANGE_DAYS, next))
    // 落在当前时刻 ±0.06 天（约 90 分钟）内吸附回"现在"，方便快速归位
    if (Math.abs(next) < 0.06) next = 0
    setOffsetDays(next)
  }

  const endRulerDrag = () => { draggingRef.current = false }

  // 刻度渲染：以 offsetDays 为窗口中心，只画窗口内（7 天）的刻度——
  // 中央刻度 = 当前查看时刻，左右自然露出前后日期
  const ticks = useMemo(() => {
    const list: Array<{ x: number; major: boolean; label?: string; highlight?: boolean }> = []
    const windowStart = offsetDays - VISIBLE_DAYS / 2
    const firstTick = Math.ceil(windowStart * TICKS_PER_DAY) / TICKS_PER_DAY
    const lastTick = windowStart + VISIBLE_DAYS
    for (let dayFrac = firstTick; dayFrac <= lastTick + 1e-9; dayFrac += 1 / TICKS_PER_DAY) {
      const x = ((dayFrac - windowStart) / VISIBLE_DAYS) * 100
      const isWholeDay = Math.abs(dayFrac - Math.round(dayFrac)) < 1e-6
      let label: string | undefined
      let highlight = false
      if (isWholeDay) {
        const date = new Date(now + dayFrac * 86400000)
        const isToday = new Date(now).toDateString() === date.toDateString()
        highlight = isToday
        label = isToday ? '今天' : WEEKDAYS[date.getDay()]
      }
      list.push({ x, major: isWholeDay, label, highlight })
    }
    return list
  }, [now, offsetDays])

  if (parked) return null

  return createPortal(
    <AnimatePresence>
      {open && (
        // 居中弹窗（与详情卡二级弹窗一致），不再是全屏页。
        // 注意：flex items-center 与 overflow-y-auto 同用时内容超高会把顶部裁掉滚不上去
        // （flex 居中经典坑），必须用 items-start + my-auto 才能既居中又可完整滚动。
        // 遮罩只压暗不模糊背景；文字继承 text-white。
        <motion.div
          className="wf-no-scrollbar fixed inset-0 z-[420] flex items-start justify-center overflow-y-auto bg-slate-950/72 p-4 text-white sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="wf-no-scrollbar my-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-[600px] shrink-0 flex-col items-center overflow-y-auto rounded-[32px] border border-white/14 bg-slate-950/88 p-6 text-white shadow-[0_24px_80px_rgba(0,0,0,0.5)] sm:p-7"
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 18, opacity: 0, scale: 0.98 }}
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

            {/* 刻度尺：指针固定正中，按住水平拖动滚动日期（1:1 跟手，松手即停） */}
            <div
              ref={rulerRef}
              className="mt-7 w-full cursor-ew-resize touch-none select-none px-1"
              onPointerDown={handleRulerPointerDown}
              onPointerMove={handleRulerPointerMove}
              onPointerUp={endRulerDrag}
              onPointerCancel={endRulerDrag}
              role="slider"
              aria-label="时间刻度尺：左右拖动查看前后 30 天的月相"
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
                {/* 中央指针：固定在 50%，当前查看时刻永远对准它 */}
                <span
                  className="absolute top-[-6px] h-0 w-0 border-x-[7px] border-t-[10px] border-x-transparent border-t-sky-300"
                  style={{ left: 'calc(50% - 7px)' }}
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

            <div className="mt-4 text-xs text-white/35">按住刻度尺左右拖动查看前后 30 天的月相 · 天文数据为近似值</div>

            <MoonPhaseCalendar scrubDate={scrubDate} onSelect={date => {
              // 点选日历日期：把刻度尺拨到那天 12:00（正午月相代表全天）
              const target = new Date(date)
              target.setHours(12, 0, 0, 0)
              setOffsetDays((target.getTime() - now) / 86400000)
            }} />

            {/* 图 1062 底部：关于照射范围 */}
            <div className="mt-4 w-full">
              <div className="mb-2 px-1 text-[19px] font-semibold tracking-tight">关于照射范围</div>
              <div className="rounded-3xl bg-white/[0.05] px-5 py-4 text-sm leading-6 text-white/62">
                照射范围是月球被太阳照亮的部分所占比例。月相随月球绕地球公转而变化，一个完整的相位周期（朔望月）约为 29.5 天。照射范围 0% 为新月，100% 为满月。
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
