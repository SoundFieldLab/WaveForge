/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { useTvBack } from '../tv/tvCore'
import { AnimatePresence, motion } from 'framer-motion'
import {
  CalendarDays,
  CalendarClock,
  Captions,
  Check,
  Clock3,
  CloudSun,
  GripVertical,
  Hourglass,
  LayoutDashboard,
  ListTodo,
  LocateFixed,
  MapPin,
  MousePointer2,
  NotebookPen,
  RotateCcw,
  Search,
  LoaderCircle,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Target,
  History,
  WandSparkles,
  ListMusic,
  Heart,
  Library,
  ChartNoAxesColumnIncreasing,
  CalendarRange,
  Radio,
  AudioLines,
  Rocket,
  Cpu,
  Volume2,
  X,
} from 'lucide-react'
import {
  DesktopCustomizationSettings,
  DesktopWidgetSide,
  DesktopWidgetType,
  getDesktopWidgetEstimatedUsage,
  saveDesktopCustomization,
} from '../services/desktopCustomization'
import {
  getCachedWeather,
  getWeatherLocationAddress,
  searchWeatherLocations,
  type WeatherLocationSearchResult,
} from '../services/weatherService'

interface DesktopCustomizationEditorProps {
  open: boolean
  settings: DesktopCustomizationSettings
  onClose: () => void
}

const DRAG_TYPE = 'application/x-waveforge-desktop-widget'

const WIDGET_OPTIONS: Array<{
  type: DesktopWidgetType
  label: string
  description: string
  icon: typeof Clock3
}> = [
  { type: 'datetime', label: '时间日期', description: '精确时间、世界时钟与专注计时', icon: Clock3 },
  { type: 'calendar', label: '完整日历', description: '月历、农历与特殊节日', icon: CalendarDays },
  { type: 'weather', label: '天气', description: '实时天气、小时与十日预报', icon: CloudSun },
  { type: 'dayProgress', label: '今日进度', description: '今日与今年的进度读数', icon: Hourglass },
  { type: 'notes', label: '便签清单', description: '待办、完成状态与优先级', icon: ListTodo },
  { type: 'memo', label: '备忘录', description: '独立记录灵感与提醒', icon: NotebookPen },
  { type: 'habits', label: '习惯打卡', description: '记录每天坚持的小习惯', icon: Target },
  { type: 'countdown', label: '重要日倒数', description: '纪念日与截止日期提醒', icon: CalendarClock },
  { type: 'recentlyPlayed', label: '最近播放', description: '回到最近听过的歌曲', icon: History },
  { type: 'dailyRecommendations', label: '每日推荐', description: '账号推荐与一键换一批', icon: WandSparkles },
  { type: 'playQueue', label: '当前播放队列', description: '查看并管理接下来播放的歌曲', icon: ListMusic },
  { type: 'favoriteSongs', label: '收藏歌曲速览', description: '从我喜欢的音乐快速播放', icon: Heart },
  { type: 'playlistShortcuts', label: '歌单快捷入口', description: '固定常用歌单到桌面', icon: Library },
  { type: 'listeningStats', label: '听歌统计', description: '今日、本周与常听歌手', icon: ChartNoAxesColumnIncreasing },
  { type: 'musicCalendar', label: '音乐日历', description: '每日听歌热力图', icon: CalendarRange },
  { type: 'artistUpdates', label: '歌手动态', description: '最近收听歌手与新歌线索', icon: Radio },
  { type: 'spectrum', label: '音频频谱', description: '跟随当前音乐实时律动', icon: AudioLines },
  { type: 'quickLauncher', label: '快捷启动器', description: '打开常用软件、文件夹和网页', icon: Rocket },
  { type: 'systemStatus', label: '系统状态', description: 'CPU、内存、磁盘与运行时间', icon: Cpu },
  { type: 'volumeControl', label: '音量控制', description: '快速调整播放器音量与静音', icon: Volume2 },
]

const getWidgetLabel = (type: DesktopWidgetType) => WIDGET_OPTIONS.find(item => item.type === type)?.label || type

const formatLocationLabel = (settings: DesktopCustomizationSettings) => {
  const cached = getCachedWeather(settings, true)
  const location = cached?.location
  if (!location) return '等待天气组件完成一次定位'
  return getWeatherLocationAddress(location)
}

const formatLyricSize = (value: number) => `${value.toFixed(2)}rem`

export default function DesktopCustomizationEditor({ open, settings, onClose }: DesktopCustomizationEditorProps) {
  const [draft, setDraft] = useState(settings)
  const [dragging, setDragging] = useState<DesktopWidgetType | null>(null)
  const [dropSide, setDropSide] = useState<DesktopWidgetSide | null>(null)
  const [showOptions, setShowOptions] = useState(false)
  const [locationQuery, setLocationQuery] = useState('')
  const [locationResults, setLocationResults] = useState<WeatherLocationSearchResult[]>([])
  const [locationSearching, setLocationSearching] = useState(false)
  const [locationSearchError, setLocationSearchError] = useState<string | null>(null)
  const [activeLocationResult, setActiveLocationResult] = useState(0)
  const autoLocationLabel = useMemo(() => formatLocationLabel(draft), [draft])

  useTvBack(() => {
    if (!open) return false
    if (showOptions) setShowOptions(false)
    else onClose()
    return true
  }, [open, showOptions, onClose])

  useEffect(() => {
    if (open) {
      setDraft(settings)
      if (settings.weatherLocationMode === 'manual' && !locationQuery) {
        setLocationQuery([settings.weatherCountry, settings.weatherProvince, settings.weatherCity, settings.weatherDistrict].filter(Boolean).join(' · '))
      }
    }
  }, [open, settings])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => event.key === 'Escape' && (showOptions ? setShowOptions(false) : onClose())
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, open, showOptions])

  useEffect(() => {
    if (!open || !showOptions || draft.weatherLocationMode !== 'manual') {
      setLocationResults([])
      setLocationSearching(false)
      return
    }

    const query = locationQuery.trim()
    if (query.length < 2) {
      setLocationResults([])
      setLocationSearchError(null)
      setLocationSearching(false)
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLocationSearching(true)
      setLocationSearchError(null)
      try {
        const results = await searchWeatherLocations(query, controller.signal)
        if (controller.signal.aborted) return
        setLocationResults(results)
        setActiveLocationResult(0)
        if (results.length === 0) setLocationSearchError('没有找到匹配地区，请尝试输入城市全名或区县名')
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setLocationResults([])
          setLocationSearchError('地区搜索暂时不可用，请稍后重试')
        }
      } finally {
        if (!controller.signal.aborted) setLocationSearching(false)
      }
    }, 350)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [draft.weatherLocationMode, locationQuery, open, showOptions])

  const update = (next: DesktopCustomizationSettings) => {
    setDraft(next)
    saveDesktopCustomization(next)
  }

  const applyLocationResult = (result: WeatherLocationSearchResult) => {
    update({
      ...draft,
      weatherLocationMode: 'manual',
      weatherCountryCode: result.countryCode || 'CN',
      weatherCountry: result.country || (result.countryCode === 'CN' ? '中国' : ''),
      weatherProvinceCode: '',
      weatherProvince: result.province,
      weatherCityCode: '',
      weatherCity: result.city,
      weatherDistrictCode: '',
      weatherDistrict: result.district || result.name || result.city,
      weatherLatitude: result.latitude,
      weatherLongitude: result.longitude,
    })
    setLocationQuery(result.label)
    setLocationResults([])
    setLocationSearchError(null)
  }

  const handleLocationSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && locationResults.length > 0) {
      event.preventDefault()
      setActiveLocationResult(index => (index + 1) % locationResults.length)
    } else if (event.key === 'ArrowUp' && locationResults.length > 0) {
      event.preventDefault()
      setActiveLocationResult(index => (index - 1 + locationResults.length) % locationResults.length)
    } else if (event.key === 'Enter' && locationResults[activeLocationResult]) {
      event.preventDefault()
      applyLocationResult(locationResults[activeLocationResult])
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      setLocationResults([])
    }
  }

  const widgetSide = useMemo(() => {
    const result = new Map<DesktopWidgetType, DesktopWidgetSide>()
    draft.left.forEach(widget => result.set(widget, 'left'))
    draft.right.forEach(widget => result.set(widget, 'right'))
    return result
  }, [draft])

  const placeWidget = (widget: DesktopWidgetType, side: DesktopWidgetSide) => {
    const left = draft.left.filter(item => item !== widget)
    const right = draft.right.filter(item => item !== widget)
    const target = side === 'left' ? left : right
    update({ ...draft, left: side === 'left' ? [...target, widget] : left, right: side === 'right' ? [...target, widget] : right })
  }

  const removeWidget = (widget: DesktopWidgetType) => update({
    ...draft,
    left: draft.left.filter(item => item !== widget),
    right: draft.right.filter(item => item !== widget),
  })

  const placeWidgetAutomatically = (widget: DesktopWidgetType) => {
    const left = draft.left.filter(item => item !== widget)
    const right = draft.right.filter(item => item !== widget)
    placeWidget(widget, getDesktopWidgetEstimatedUsage(left) <= getDesktopWidgetEstimatedUsage(right) ? 'left' : 'right')
  }

  const handleDragStart = (event: DragEvent, widget: DesktopWidgetType) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(DRAG_TYPE, widget)
    setDragging(widget)
  }

  const handleDrop = (event: DragEvent, side: DesktopWidgetSide) => {
    event.preventDefault()
    const widget = event.dataTransfer.getData(DRAG_TYPE) as DesktopWidgetType
    if (WIDGET_OPTIONS.some(item => item.type === widget)) placeWidget(widget, side)
    setDragging(null)
    setDropSide(null)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[240]">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-slate-950/18" />

          <motion.header initial={{ y: -24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -24, opacity: 0 }} className="pointer-events-auto absolute left-1/2 top-2 flex max-h-[calc(100vh-1rem)] w-[min(920px,calc(100vw-16px))] -translate-x-1/2 flex-wrap items-center justify-between gap-2 overflow-y-auto rounded-[24px] border border-white/15 bg-slate-950/72 px-3 py-3 text-white shadow-2xl backdrop-blur-2xl sm:top-5 sm:w-[min(920px,calc(100vw-40px))] sm:flex-nowrap sm:gap-5 sm:px-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-cyan-400/16"><LayoutDashboard className="h-5 w-5 text-cyan-200" /></div>
              <div className="min-w-0"><div className="font-semibold">编辑桌面布局</div><div className="mt-0.5 truncate text-xs text-white/42">从底部拖动元素，放进桌面两侧发光区域</div></div>
            </div>
            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:flex-nowrap">
              <button type="button" onClick={() => update({ ...draft, left: [], right: [] })} className="flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 text-xs text-white/60 transition hover:bg-white/10"><RotateCcw className="h-3.5 w-3.5" />清空布局</button>
              <button type="button" onClick={() => setShowOptions(true)} className="flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 text-xs text-white/70 transition hover:bg-white/10"><Settings2 className="h-3.5 w-3.5" />桌面选项</button>
              <button type="button" onClick={onClose} className="flex h-10 items-center gap-2 rounded-full bg-white px-5 text-xs font-semibold text-slate-950 transition hover:bg-cyan-100"><Check className="h-4 w-4" />完成</button>
            </div>
          </motion.header>

          {(['left', 'right'] as DesktopWidgetSide[]).map(side => {
            const active = dropSide === side
            return (
              <motion.div
                key={side}
                initial={{ opacity: 0, x: side === 'left' ? -20 : 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: side === 'left' ? -20 : 20 }}
                onDragEnter={event => { event.preventDefault(); setDropSide(side) }}
                onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropSide(side) }}
                onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropSide(null) }}
                onDrop={event => handleDrop(event, side)}
                className={`pointer-events-auto absolute top-[92px] z-10 flex min-h-[330px] flex-col rounded-[30px] border-2 border-dashed p-3 transition-all ${side === 'left' ? 'left-5' : 'right-5'}`}
                style={{
                  bottom: '270px',
                  width: 'clamp(220px, 22vw, 300px)',
                  borderColor: active ? '#67e8f9' : dragging ? 'rgba(103,232,249,.46)' : 'rgba(255,255,255,.16)',
                  background: active ? 'rgba(6,182,212,.16)' : 'rgba(2,6,23,.06)',
                  boxShadow: active ? '0 0 60px rgba(34,211,238,.25), inset 0 0 45px rgba(34,211,238,.08)' : 'inset 0 0 45px rgba(2,6,23,.08)',
                }}
              >
                <div className="pointer-events-none flex items-center justify-between rounded-2xl bg-slate-950/68 px-3 py-2 text-xs text-white/65 backdrop-blur-xl"><span>{side === 'left' ? '左侧组件区' : '右侧组件区'}</span><span className="text-white/30">{draft[side].length} 个元素</span></div>
                <div className="mt-2 space-y-2">
                  {draft[side].map(widget => (
                    <div key={widget} draggable onDragStart={event => handleDragStart(event, widget)} onDragEnd={() => { setDragging(null); setDropSide(null) }} className="group flex cursor-grab items-center gap-2 rounded-2xl border border-cyan-200/20 bg-slate-950/72 px-3 py-2.5 text-xs text-white/75 shadow-lg backdrop-blur-xl active:cursor-grabbing"><GripVertical className="h-4 w-4 text-white/28" /><span className="flex-1">{getWidgetLabel(widget)}</span><button type="button" aria-label={`移除${getWidgetLabel(widget)}`} onClick={() => removeWidget(widget)} className="flex h-6 w-6 items-center justify-center rounded-full text-white/30 transition hover:bg-white/10 hover:text-white"><X className="h-3.5 w-3.5" /></button></div>
                  ))}
                </div>
                {draft[side].length === 0 && <div className="pointer-events-none flex flex-1 flex-col items-center justify-center text-center"><MousePointer2 className="h-7 w-7 text-cyan-100/45" /><div className="mt-3 text-sm font-medium text-white/55">拖到这里添加</div><div className="mt-1 text-xs text-white/28">元素会显示在这个位置</div></div>}
              </motion.div>
            )
          })}

          <motion.div initial={{ y: 36, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 36, opacity: 0 }} className="pointer-events-auto absolute bottom-2 left-1/2 max-h-[42vh] w-[min(980px,calc(100vw-16px))] -translate-x-1/2 overflow-y-auto rounded-[28px] border border-white/15 bg-slate-950/78 p-3 text-white shadow-[0_24px_80px_rgba(0,0,0,.5)] backdrop-blur-2xl sm:bottom-5 sm:w-[min(980px,calc(100vw-40px))]">
            <div className="mb-2 flex items-center justify-between px-2"><div><span className="text-sm font-medium">支持的桌面元素</span><span className="ml-3 text-xs text-white/35">可自由添加；内容超出屏幕后可在左右区域滚动</span></div><div className="flex items-center gap-3 text-[10px] text-white/35"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-cyan-300" />已添加</span><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-white/30" />可添加</span></div></div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {WIDGET_OPTIONS.map(option => {
                const Icon = option.icon
                const side = widgetSide.get(option.type)
                return (
                  <div key={option.type} draggable onDragStart={event => handleDragStart(event, option.type)} onDragEnd={() => { setDragging(null); setDropSide(null) }} onClick={() => !side && placeWidgetAutomatically(option.type)} className="group relative flex min-w-0 cursor-grab items-center gap-3 rounded-[20px] border p-3 transition active:cursor-grabbing" style={{ borderColor: side ? 'rgba(103,232,249,.48)' : 'rgba(255,255,255,.08)', background: side ? 'rgba(34,211,238,.12)' : 'rgba(255,255,255,.035)' }}>
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl" style={{ background: side ? 'rgba(103,232,249,.16)' : 'rgba(255,255,255,.06)' }}><Icon className="h-4.5 w-4.5" style={{ color: side ? '#a5f3fc' : 'rgba(255,255,255,.65)' }} /></div>
                    <div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-sm font-medium"><span className="truncate">{option.label}</span>{side && <span className="rounded-full bg-cyan-200/12 px-1.5 py-0.5 text-[9px] text-cyan-100">{side === 'left' ? '左侧' : '右侧'}</span>}</div><div className="mt-1 truncate text-[10px] text-white/32">{option.description}</div></div>
                    {side && <button type="button" aria-label={`移除${option.label}`} onClick={event => { event.stopPropagation(); removeWidget(option.type) }} className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/20 text-white/30 opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"><X className="h-3.5 w-3.5" /></button>}
                  </div>
                )
              })}
            </div>
          </motion.div>

          <AnimatePresence>
            {showOptions && (
              <>
                <motion.button type="button" aria-label="关闭桌面选项" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setShowOptions(false)} className="pointer-events-auto absolute inset-0 z-20 bg-black/5" />
                <motion.aside initial={{ x: 420 }} animate={{ x: 0 }} exit={{ x: 420 }} transition={{ type: 'spring', damping: 30, stiffness: 330 }} className="pointer-events-auto absolute bottom-2 right-2 top-2 z-30 w-[min(390px,calc(100vw-16px))] overflow-y-auto rounded-[30px] border border-white/12 bg-slate-950/94 p-4 text-white shadow-2xl custom-scrollbar sm:bottom-4 sm:right-4 sm:top-4 sm:p-5">
                  <div className="flex items-center justify-between"><div><div className="text-lg font-semibold">桌面选项</div><div className="mt-1 text-xs text-white/38">设置歌词、背景效果和天气位置</div></div><button type="button" onClick={() => setShowOptions(false)} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/7 text-white/60"><X className="h-4 w-4" /></button></div>
                  <section className="mt-6 rounded-[24px] border border-white/10 bg-white/[0.04] p-4">
                    <div className="flex items-center gap-2 text-sm font-medium"><Captions className="h-4 w-4 text-violet-300" />桌面歌词样式</div>
                    <div className="mt-3 grid grid-cols-2 gap-2">{([{ value: 'traditional' as const, label: '传统', icon: Captions }, { value: 'modern' as const, label: '现代', icon: Sparkles }]).map(option => { const Icon = option.icon; const selected = draft.desktopLyricStyle === option.value; return <button key={option.value} type="button" onClick={() => update({ ...draft, desktopLyricStyle: option.value })} className="rounded-2xl border p-3 text-left" style={{ borderColor: selected ? 'rgba(196,181,253,.55)' : 'rgba(255,255,255,.08)', background: selected ? 'rgba(139,92,246,.18)' : 'rgba(255,255,255,.025)' }}><Icon className="h-4 w-4 text-violet-200" /><div className="mt-2 text-sm">{option.label}</div></button> })}</div>
                    <div className="mt-4 space-y-3 rounded-2xl border border-white/8 bg-black/15 p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-white/55"><SlidersHorizontal className="h-3.5 w-3.5 text-violet-200" />歌词大小</div>
                      <label className="block">
                        <div className="mb-1.5 flex items-center justify-between text-[11px] text-white/45"><span>传统</span><span className="tabular-nums text-white/65">{formatLyricSize(draft.traditionalLyricSize)}</span></div>
                        <input type="range" min="1.2" max="3.2" step="0.05" value={draft.traditionalLyricSize} onChange={event => update({ ...draft, traditionalLyricSize: Number(event.target.value) })} className="w-full accent-violet-300" />
                      </label>
                      <label className="block">
                        <div className="mb-1.5 flex items-center justify-between text-[11px] text-white/45"><span>现代</span><span className="tabular-nums text-white/65">{formatLyricSize(draft.modernLyricSize)}</span></div>
                        <input type="range" min="1.4" max="4.2" step="0.05" value={draft.modernLyricSize} onChange={event => update({ ...draft, modernLyricSize: Number(event.target.value) })} className="w-full accent-violet-300" />
                      </label>
                    </div>
                  </section>
                  <section className="mt-3 rounded-[24px] border border-white/10 bg-white/[0.04] p-4">
                    <div className="flex items-center gap-2 text-sm font-medium"><SlidersHorizontal className="h-4 w-4 text-fuchsia-300" />背景效果</div>
                    <div className="mt-3 space-y-4">
                      <label className="block">
                        <div className="mb-2 flex items-center justify-between text-[11px] text-white/45"><span>背景暗化度</span><span className="tabular-nums text-white/70">{draft.backgroundDim}%</span></div>
                        <input type="range" min="0" max="70" step="1" value={draft.backgroundDim} onChange={event => update({ ...draft, backgroundDim: Number(event.target.value) })} className="w-full accent-fuchsia-300" />
                        <div className="mt-1.5 text-[10px] text-white/30">降低壁纸亮度，让歌词和桌面卡片更清晰。</div>
                      </label>
                      <label className="block">
                        <div className="mb-2 flex items-center justify-between text-[11px] text-white/45"><span>背景模糊度</span><span className="tabular-nums text-white/70">{draft.backgroundBlur}px</span></div>
                        <input type="range" min="0" max="20" step="1" value={draft.backgroundBlur} onChange={event => update({ ...draft, backgroundBlur: Number(event.target.value) })} className="w-full accent-fuchsia-300" />
                        <div className="mt-1.5 text-[10px] text-white/30">只模糊桌面背景，不影响歌词与组件内容。</div>
                      </label>
                    </div>
                  </section>

                  <section className="mt-3 rounded-[24px] border border-white/10 bg-white/[0.04] p-4">
                    <div className="flex items-center gap-2 text-sm font-medium"><CloudSun className="h-4 w-4 text-cyan-300" />天气位置</div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => update({ ...draft, weatherLocationMode: 'auto' })} className="rounded-2xl border p-3 text-left text-sm" style={{ borderColor: draft.weatherLocationMode === 'auto' ? 'rgba(103,232,249,.55)' : 'rgba(255,255,255,.08)', background: draft.weatherLocationMode === 'auto' ? 'rgba(34,211,238,.14)' : 'rgba(255,255,255,.025)' }}>自动定位<div className="mt-1 text-[10px] text-white/35">依据当前网络位置</div></button>
                      <button type="button" onClick={() => update({ ...draft, weatherLocationMode: 'manual' })} className="rounded-2xl border p-3 text-left text-sm" style={{ borderColor: draft.weatherLocationMode === 'manual' ? 'rgba(103,232,249,.55)' : 'rgba(255,255,255,.08)', background: draft.weatherLocationMode === 'manual' ? 'rgba(34,211,238,.14)' : 'rgba(255,255,255,.025)' }}>搜索地区<div className="mt-1 text-[10px] text-white/35">输入城市或区县自动匹配</div></button>
                    </div>
                    <div className="mt-4">
                      <div className="mb-2 text-[11px] text-white/40">天气卡片样式</div>
                      <div className="grid grid-cols-2 gap-2">
                        <button type="button" onClick={() => update({ ...draft, weatherCardMode: 'full' })} className="rounded-2xl border p-3 text-left text-sm" style={{ borderColor: draft.weatherCardMode !== 'simple' ? 'rgba(103,232,249,.55)' : 'rgba(255,255,255,.08)', background: draft.weatherCardMode !== 'simple' ? 'rgba(34,211,238,.14)' : 'rgba(255,255,255,.025)' }}>完整模式<div className="mt-1 text-[10px] text-white/35">动态天空场景 · 当前样式</div></button>
                        <button type="button" onClick={() => update({ ...draft, weatherCardMode: 'simple' })} className="rounded-2xl border p-3 text-left text-sm" style={{ borderColor: draft.weatherCardMode === 'simple' ? 'rgba(103,232,249,.55)' : 'rgba(255,255,255,.08)', background: draft.weatherCardMode === 'simple' ? 'rgba(34,211,238,.14)' : 'rgba(255,255,255,.025)' }}>简约模式<div className="mt-1 text-[10px] text-white/35">苹果小组件风格 · 大温度与逐小时</div></button>
                      </div>
                    </div>
                    {draft.weatherLocationMode === 'auto' && <div className="mt-3 flex items-start gap-2 rounded-2xl border border-cyan-200/12 bg-cyan-300/[0.06] p-3 text-[11px] leading-5 text-white/55"><LocateFixed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" /><span>当前自动定位：{autoLocationLabel}</span></div>}
                    {draft.weatherLocationMode === 'manual' && (
                      <div className="mt-3">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                          <input
                            value={locationQuery}
                            onChange={event => { setLocationQuery(event.target.value); setLocationSearchError(null) }}
                            onKeyDown={handleLocationSearchKeyDown}
                            className="h-11 w-full rounded-xl border border-white/10 bg-black/25 pl-10 pr-10 text-sm text-white outline-none placeholder:text-white/28 focus:border-cyan-300/50"
                            placeholder="搜索城市、区县，例如“张家港”"
                            autoComplete="off"
                          />
                          {locationSearching && <LoaderCircle className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-cyan-300" />}
                        </div>

                        {locationResults.length > 0 && (
                          <div className="mt-2 max-h-52 overflow-y-auto rounded-2xl border border-white/10 bg-slate-950/95 p-1.5 shadow-2xl backdrop-blur-2xl">
                            {locationResults.map((result, index) => (
                              <button
                                key={result.id}
                                type="button"
                                onMouseEnter={() => setActiveLocationResult(index)}
                                onClick={() => applyLocationResult(result)}
                                className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition ${activeLocationResult === index ? 'bg-cyan-300/12' : 'hover:bg-white/6'}`}
                              >
                                <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                                <span className="min-w-0">
                                  <span className="block truncate text-xs text-white/85">{result.label}</span>
                                  <span className="mt-1 block text-[10px] tabular-nums text-white/30">{result.latitude.toFixed(4)}, {result.longitude.toFixed(4)}</span>
                                </span>
                              </button>
                            ))}
                          </div>
                        )}

                        {locationSearchError && <div className="mt-2 rounded-xl border border-amber-300/12 bg-amber-300/[0.06] px-3 py-2 text-[11px] leading-5 text-amber-100/70">{locationSearchError}</div>}
                        {draft.weatherLatitude !== null && draft.weatherLongitude !== null && (
                          <div className="mt-2 flex items-start gap-2 rounded-2xl border border-cyan-200/12 bg-cyan-300/[0.06] p-3 text-[11px] leading-5 text-white/55">
                            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" />
                            <span>已应用：{[draft.weatherCountry, draft.weatherProvince, draft.weatherCity, draft.weatherDistrict].filter(Boolean).join(' · ')}</span>
                          </div>
                        )}
                        <div className="mt-2 flex items-start gap-2 rounded-2xl bg-white/[0.025] p-3 text-[11px] leading-5 text-white/38"><MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300" />选择搜索结果后会直接保存精确坐标并刷新天气，无需逐级选择地区。</div>
                      </div>
                    )}
                  </section>
                </motion.aside>
              </>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

