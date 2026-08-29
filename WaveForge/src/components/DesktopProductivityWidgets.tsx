/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  CalendarClock,
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  ListTodo,
  NotebookPen,
  Plus,
  Target,
  Trash2,
  X,
} from 'lucide-react'

type ProductivityTab = 'notes' | 'memo' | 'habits' | 'countdown'

interface DesktopTask {
  id: string
  title: string
  completed: boolean
}

interface DesktopHabit {
  id: string
  title: string
  target: number
}

interface DesktopMilestone {
  id: string
  title: string
  date: string
}

interface DesktopMemo {
  id: string
  title: string
  content: string
  updatedAt: number
}

interface DesktopProductivityData {
  tasks: DesktopTask[]
  memos: DesktopMemo[]
  habits: DesktopHabit[]
  habitChecks: Record<string, Record<string, number>>
  milestones: DesktopMilestone[]
}

interface ProductivityWidgetProps {
  cardBlurAmount: number
  accentColor: string
  onOverlayOpenChange?: (open: boolean) => void
}

const PRODUCTIVITY_STORAGE_KEY = 'desktopProductivityData'
const PRODUCTIVITY_EVENT = 'desktopProductivityChanged'
const EMPTY_DATA: DesktopProductivityData = { tasks: [], memos: [], habits: [], habitChecks: {}, milestones: [] }

const createId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`

const getTodayKey = () => {
  const today = new Date()
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
}

const normalizeHabitChecks = (value: unknown): Record<string, Record<string, number>> => {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(Object.entries(value).map(([date, checks]) => {
    if (Array.isArray(checks)) {
      return [date, Object.fromEntries(checks.filter(id => typeof id === 'string').map(id => [id, 1]))]
    }
    if (!checks || typeof checks !== 'object') return [date, {}]
    return [date, Object.fromEntries(Object.entries(checks).map(([id, count]) => [id, Math.max(0, Math.round(Number(count) || 0))]))]
  }))
}

const loadProductivityData = (): DesktopProductivityData => {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRODUCTIVITY_STORAGE_KEY) || 'null') as (Partial<DesktopProductivityData> & { memo?: unknown }) | null
    const legacyMemo = typeof parsed?.memo === 'string' ? parsed.memo.trim() : ''
    return {
      tasks: Array.isArray(parsed?.tasks) ? parsed.tasks.filter(task => task && typeof task.id === 'string' && typeof task.title === 'string').map(task => ({ ...task, completed: Boolean(task.completed) })) : [],
      memos: Array.isArray(parsed?.memos)
        ? parsed.memos.filter(memo => memo && typeof memo.id === 'string' && typeof memo.content === 'string').map(memo => ({ ...memo, title: typeof memo.title === 'string' && memo.title.trim() ? memo.title : '未命名备忘', updatedAt: Number(memo.updatedAt) || 0 }))
        : legacyMemo ? [{ id: 'migrated-legacy-memo', title: '我的备忘', content: legacyMemo, updatedAt: 0 }] : [],
      habits: Array.isArray(parsed?.habits) ? parsed.habits.filter(habit => habit && typeof habit.id === 'string' && typeof habit.title === 'string').map(habit => ({ ...habit, target: Math.max(1, Math.min(99, Math.round(Number(habit.target) || 1))) })) : [],
      habitChecks: normalizeHabitChecks(parsed?.habitChecks),
      milestones: Array.isArray(parsed?.milestones) ? parsed.milestones.filter(item => item && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.date === 'string') : [],
    }
  } catch {
    return { ...EMPTY_DATA }
  }
}

function useDesktopProductivity() {
  const [data, setData] = useState(loadProductivityData)
  const dataRef = useRef(data)

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<DesktopProductivityData>).detail
      const next = detail || loadProductivityData()
      dataRef.current = next
      setData(next)
    }
    const syncStorage = (event: StorageEvent) => {
      if (event.key === PRODUCTIVITY_STORAGE_KEY) {
        const next = loadProductivityData()
        dataRef.current = next
        setData(next)
      }
    }
    window.addEventListener(PRODUCTIVITY_EVENT, sync)
    window.addEventListener('storage', syncStorage)
    return () => {
      window.removeEventListener(PRODUCTIVITY_EVENT, sync)
      window.removeEventListener('storage', syncStorage)
    }
  }, [])

  const update = useCallback((updater: (current: DesktopProductivityData) => DesktopProductivityData) => {
    const next = updater(dataRef.current)
    dataRef.current = next
    setData(next)
    localStorage.setItem(PRODUCTIVITY_STORAGE_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(PRODUCTIVITY_EVENT, { detail: next }))
  }, [])

  return { data, update }
}

function ProductivityShell({ children, cardBlurAmount, accentColor, className = '' }: ProductivityWidgetProps & { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`desktop-widget-card relative isolate w-full overflow-hidden rounded-[28px] text-white transition-transform duration-200 hover:scale-[1.018] ${className}`}
      style={{
        background: `linear-gradient(145deg, ${accentColor}35, rgba(7,13,27,.58) 48%, rgba(30,41,59,.42))`,
        backdropFilter: `blur(${Math.max(20, cardBlurAmount + 12)}px) saturate(160%)`,
        WebkitBackdropFilter: `blur(${Math.max(20, cardBlurAmount + 12)}px) saturate(160%)`,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.11), 0 16px 42px rgba(15,23,42,.12)',
      }}
    >
      {children}
    </div>
  )
}

function BeautifulDatePicker({ value, accentColor, onChange }: { value: string; accentColor: string; onChange: (value: string) => void }) {
  const selectedDate = value ? new Date(`${value}T00:00:00`) : null
  const [open, setOpen] = useState(false)
  const [visibleMonth, setVisibleMonth] = useState(() => selectedDate || new Date())
  const monthStart = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1)
  monthStart.setDate(1 - monthStart.getDay())
  const dates = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(monthStart)
    date.setDate(monthStart.getDate() + index)
    return date
  })

  useEffect(() => {
    if (open && selectedDate) setVisibleMonth(selectedDate)
  }, [open, value])

  const selectDate = (date: Date) => {
    onChange(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(current => !current)} className="flex h-11 w-full items-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-3 text-left text-sm text-white/72 outline-none transition hover:border-white/20 hover:bg-white/[.055]">
        <CalendarDays className="h-4 w-4 shrink-0" style={{ color: accentColor }} />
        <span className={value ? 'flex-1' : 'flex-1 text-white/30'}>{value || '选择日期'}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: 8, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: .98 }} className="absolute right-0 top-[calc(100%+10px)] z-30 w-[310px] rounded-[24px] border border-white/12 bg-[#0d1526]/98 p-4 shadow-[0_24px_70px_rgba(0,0,0,.65)] backdrop-blur-2xl">
            <div className="flex items-center justify-between"><div className="font-medium text-white">{visibleMonth.getFullYear()} 年 {visibleMonth.getMonth() + 1} 月</div><div className="flex gap-1"><button type="button" aria-label="上个月" onClick={() => setVisibleMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-white/55 hover:bg-white/10"><ChevronLeft className="h-4 w-4" /></button><button type="button" aria-label="下个月" onClick={() => setVisibleMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-white/55 hover:bg-white/10"><ChevronRight className="h-4 w-4" /></button></div></div>
            <div className="mt-4 grid grid-cols-7 gap-1 text-center text-[10px] text-white/30">{'日一二三四五六'.split('').map(day => <span key={day}>{day}</span>)}</div>
            <div className="mt-2 grid grid-cols-7 gap-1">{dates.map(date => { const inMonth = date.getMonth() === visibleMonth.getMonth(); const selected = selectedDate?.toDateString() === date.toDateString(); const today = new Date().toDateString() === date.toDateString(); return <button key={date.toISOString()} type="button" onClick={() => selectDate(date)} className="flex h-8 items-center justify-center rounded-xl text-xs transition hover:bg-white/10" style={{ color: inMonth ? 'rgba(255,255,255,.78)' : 'rgba(255,255,255,.2)', background: selected ? accentColor : today ? `${accentColor}24` : 'transparent', boxShadow: selected ? `0 6px 18px ${accentColor}35` : 'none' }}>{date.getDate()}</button> })}</div>
            <div className="mt-3 flex items-center justify-between border-t border-white/8 pt-3"><button type="button" onClick={() => { onChange(''); setOpen(false) }} className="text-xs text-white/35 hover:text-white/65">清除</button><button type="button" onClick={() => selectDate(new Date())} className="rounded-full px-3 py-1.5 text-xs font-medium text-slate-950" style={{ background: accentColor }}>今天</button></div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function DesktopProductivityCenter({
  open,
  initialTab,
  accentColor,
  data,
  update,
  onClose,
}: {
  open: boolean
  initialTab: ProductivityTab
  accentColor: string
  data: DesktopProductivityData
  update: (updater: (current: DesktopProductivityData) => DesktopProductivityData) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<ProductivityTab>(initialTab)
  const [taskTitle, setTaskTitle] = useState('')
  const [habitTitle, setHabitTitle] = useState('')
  const [habitTarget, setHabitTarget] = useState(1)
  const [milestoneTitle, setMilestoneTitle] = useState('')
  const [milestoneDate, setMilestoneDate] = useState('')
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null)
  const [selectedMemoId, setSelectedMemoId] = useState<string | null>(null)
  const todayKey = getTodayKey()
  const habitCounts = data.habitChecks[todayKey] || {}
  const selectedMemo = data.memos.find(memo => memo.id === selectedMemoId) || null

  useEffect(() => {
    if (open) setTab(initialTab)
  }, [initialTab, open])

  useEffect(() => {
    if (!open || tab !== 'memo') return
    if (!selectedMemoId || !data.memos.some(memo => memo.id === selectedMemoId)) setSelectedMemoId(data.memos[0]?.id || null)
  }, [data.memos, open, selectedMemoId, tab])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, open])

  const addTask = () => {
    const title = taskTitle.trim()
    if (!title) return
    update(current => ({ ...current, tasks: [...current.tasks, { id: createId(), title, completed: false }] }))
    setTaskTitle('')
  }

  const addHabit = () => {
    const title = habitTitle.trim()
    if (!title) return
    update(current => ({ ...current, habits: [...current.habits, { id: createId(), title, target: Math.max(1, Math.min(99, habitTarget)) }] }))
    setHabitTitle('')
    setHabitTarget(1)
  }

  const reorderTask = (targetId: string) => {
    if (!draggingTaskId || draggingTaskId === targetId) return
    update(current => {
      const tasks = [...current.tasks]
      const fromIndex = tasks.findIndex(task => task.id === draggingTaskId)
      const toIndex = tasks.findIndex(task => task.id === targetId)
      if (fromIndex < 0 || toIndex < 0) return current
      const [moved] = tasks.splice(fromIndex, 1)
      tasks.splice(toIndex, 0, moved)
      return { ...current, tasks }
    })
    setDraggingTaskId(null)
  }

  const updateHabitCount = (habit: DesktopHabit, delta: number) => {
    update(current => {
      const counts = current.habitChecks[todayKey] || {}
      const nextCount = Math.max(0, Math.min(habit.target, (counts[habit.id] || 0) + delta))
      return { ...current, habitChecks: { ...current.habitChecks, [todayKey]: { ...counts, [habit.id]: nextCount } } }
    })
  }

  const addMilestone = () => {
    const title = milestoneTitle.trim()
    if (!title || !milestoneDate) return
    update(current => ({ ...current, milestones: [...current.milestones, { id: createId(), title, date: milestoneDate }] }))
    setMilestoneTitle('')
    setMilestoneDate('')
  }

  const addMemo = () => {
    const memo: DesktopMemo = { id: createId(), title: '新备忘', content: '', updatedAt: Date.now() }
    update(current => ({ ...current, memos: [memo, ...current.memos] }))
    setSelectedMemoId(memo.id)
  }

  const updateSelectedMemo = (changes: Partial<Pick<DesktopMemo, 'title' | 'content'>>) => {
    if (!selectedMemoId) return
    update(current => ({ ...current, memos: current.memos.map(memo => memo.id === selectedMemoId ? { ...memo, ...changes, updatedAt: Date.now() } : memo) }))
  }

  const deleteSelectedMemo = () => {
    if (!selectedMemoId) return
    const remaining = data.memos.filter(memo => memo.id !== selectedMemoId)
    update(current => ({ ...current, memos: current.memos.filter(memo => memo.id !== selectedMemoId) }))
    setSelectedMemoId(remaining[0]?.id || null)
  }

  const tabs: Array<{ id: ProductivityTab; label: string; icon: typeof ListTodo }> = [
    { id: 'notes', label: '便签清单', icon: ListTodo },
    { id: 'memo', label: '备忘录', icon: NotebookPen },
    { id: 'habits', label: '习惯打卡', icon: Target },
    { id: 'countdown', label: '重要日倒数', icon: CalendarClock },
  ]

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[400] flex items-center justify-center bg-black/70 p-6 backdrop-blur-2xl" onMouseDown={event => event.target === event.currentTarget && onClose()}>
          <motion.div initial={{ opacity: 0, y: 22, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 16, scale: .98 }} className="flex h-[min(760px,90vh)] w-[min(920px,92vw)] flex-col overflow-hidden rounded-[34px] border border-white/12 bg-[#09101e]/98 text-white shadow-[0_40px_120px_rgba(0,0,0,.68)]">
            <header className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
              <div className="flex flex-1 items-center gap-2">
                {tabs.map(item => { const Icon = item.icon; const active = tab === item.id; return <button key={item.id} type="button" onClick={() => setTab(item.id)} className="flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm transition hover:bg-white/10" style={{ borderColor: active ? `${accentColor}aa` : 'rgba(255,255,255,.08)', background: active ? `${accentColor}3d` : 'rgba(255,255,255,.035)', color: active ? '#fff' : 'rgba(255,255,255,.5)' }}><Icon className="h-4 w-4" />{item.label}</button> })}
              </div>
              <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/65 hover:bg-white/10"><X className="h-5 w-5" /></button>
            </header>

            <main className="min-h-0 flex-1 overflow-y-auto p-5 custom-scrollbar">
              {tab === 'notes' && (
                <div className="mx-auto min-h-full w-full max-w-3xl">
                  <section className="rounded-[26px] border border-white/10 bg-white/[.04] p-5">
                    <div className="flex gap-2"><input value={taskTitle} onChange={event => setTaskTitle(event.target.value)} onKeyDown={event => event.key === 'Enter' && addTask()} placeholder="添加一项待办" className="h-11 flex-1 rounded-2xl border border-white/10 bg-black/20 px-4 text-sm outline-none placeholder:text-white/25 focus:border-white/25" /><button type="button" onClick={addTask} className="flex h-11 items-center gap-2 rounded-2xl px-4 text-sm font-semibold text-slate-950" style={{ background: accentColor }}><Plus className="h-4 w-4" />添加</button></div>
                    <div className="mt-3 flex items-center gap-2 text-[11px] text-white/30"><GripVertical className="h-3.5 w-3.5" />拖动待办上下调整优先级，越靠上优先级越高</div>
                    <div className="mt-5 space-y-2">
                      {data.tasks.map(task => <div key={task.id} draggable onDragStart={() => setDraggingTaskId(task.id)} onDragEnd={() => setDraggingTaskId(null)} onDragOver={event => event.preventDefault()} onDrop={() => reorderTask(task.id)} className="group flex cursor-grab items-center gap-3 rounded-2xl border bg-white/[.035] p-3 transition active:cursor-grabbing" style={{ borderColor: draggingTaskId === task.id ? `${accentColor}80` : 'rgba(255,255,255,.08)', opacity: draggingTaskId === task.id ? .55 : 1 }}><GripVertical className="h-4 w-4 shrink-0 text-white/20 transition group-hover:text-white/45" /><button type="button" onClick={() => update(current => ({ ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, completed: !item.completed } : item) }))} className="shrink-0" style={{ color: task.completed ? accentColor : 'rgba(255,255,255,.35)' }}>{task.completed ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}</button><span className={`min-w-0 flex-1 text-sm ${task.completed ? 'text-white/35 line-through' : 'text-white/78'}`}>{task.title}</span><button type="button" aria-label="删除待办" onClick={() => update(current => ({ ...current, tasks: current.tasks.filter(item => item.id !== task.id) }))} className="text-white/25 opacity-0 transition hover:text-rose-300 group-hover:opacity-100"><Trash2 className="h-4 w-4" /></button></div>)}
                      {data.tasks.length === 0 && <div className="rounded-2xl border border-dashed border-white/10 py-12 text-center text-sm text-white/30">还没有待办，写下今天最重要的一件事</div>}
                    </div>
                  </section>
                </div>
              )}

              {tab === 'memo' && (
                <div className="grid min-h-full grid-cols-[260px_minmax(0,1fr)] gap-4">
                  <aside className="rounded-[26px] border border-white/10 bg-white/[.04] p-4"><button type="button" onClick={addMemo} className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl text-sm font-semibold text-slate-950" style={{ background: accentColor }}><Plus className="h-4 w-4" />新建备忘</button><div className="mt-4 space-y-2">{[...data.memos].sort((a, b) => b.updatedAt - a.updatedAt).map(memo => { const active = memo.id === selectedMemoId; return <button key={memo.id} type="button" onClick={() => setSelectedMemoId(memo.id)} className="block w-full rounded-2xl border p-3 text-left transition" style={{ borderColor: active ? `${accentColor}80` : 'rgba(255,255,255,.07)', background: active ? `${accentColor}24` : 'rgba(255,255,255,.025)' }}><div className="truncate text-sm font-medium text-white/78">{memo.title || '未命名备忘'}</div><div className="mt-1 line-clamp-2 text-[11px] leading-4 text-white/30">{memo.content || '空白备忘'}</div></button> })}{data.memos.length === 0 && <div className="rounded-2xl border border-dashed border-white/10 py-10 text-center text-xs text-white/28">还没有备忘</div>}</div></aside>
                  <section className="flex min-h-[520px] flex-col rounded-[26px] border border-white/10 bg-white/[.04] p-5">{selectedMemo ? <><div className="flex items-center gap-3"><NotebookPen className="h-4 w-4 shrink-0" style={{ color: accentColor }} /><input value={selectedMemo.title} onChange={event => updateSelectedMemo({ title: event.target.value })} placeholder="备忘标题" className="h-10 min-w-0 flex-1 bg-transparent text-lg font-semibold text-white outline-none placeholder:text-white/25" /><button type="button" onClick={deleteSelectedMemo} aria-label="删除备忘" className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-white/30 transition hover:bg-rose-400/15 hover:text-rose-300"><Trash2 className="h-4 w-4" /></button></div><div className="mt-1 text-[10px] text-white/25">{selectedMemo.updatedAt ? `更新于 ${new Date(selectedMemo.updatedAt).toLocaleString('zh-CN')}` : '从旧版备忘录迁移'}</div><textarea autoFocus value={selectedMemo.content} onChange={event => updateSelectedMemo({ content: event.target.value })} placeholder="随手记下想法、提醒、购物清单或稍后要处理的内容……" className="mt-4 min-h-0 flex-1 resize-none rounded-2xl border border-white/8 bg-black/15 p-5 text-sm leading-7 text-white/78 outline-none placeholder:text-white/22 focus:border-white/20" /></> : <button type="button" onClick={addMemo} className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 text-white/28"><NotebookPen className="h-8 w-8" /><span className="mt-3 text-sm">新建一条备忘开始记录</span></button>}</section>
                </div>
              )}

              {tab === 'habits' && (
                <section className="mx-auto max-w-2xl rounded-[26px] border border-white/10 bg-white/[.04] p-5">
                  <div className="grid grid-cols-[minmax(0,1fr)_110px_auto] gap-2"><input value={habitTitle} onChange={event => setHabitTitle(event.target.value)} onKeyDown={event => event.key === 'Enter' && addHabit()} placeholder="例如：喝水、阅读、拉伸" className="h-11 rounded-2xl border border-white/10 bg-black/20 px-4 text-sm outline-none placeholder:text-white/25 focus:border-white/25" /><label className="flex h-11 items-center gap-2 rounded-2xl border border-white/10 bg-black/20 px-3 text-xs text-white/38">每天<input type="number" min="1" max="99" value={habitTarget} onChange={event => setHabitTarget(Math.max(1, Math.min(99, Number(event.target.value) || 1)))} className="min-w-0 flex-1 bg-transparent text-center text-sm font-semibold text-white outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />次</label><button type="button" onClick={addHabit} className="flex h-11 items-center gap-2 rounded-2xl px-4 text-sm font-semibold text-slate-950" style={{ background: accentColor }}><Plus className="h-4 w-4" />添加习惯</button></div>
                  <div className="mt-5 grid grid-cols-2 gap-3">{data.habits.map(habit => { const count = habitCounts[habit.id] || 0; const completed = count >= habit.target; return <div key={habit.id} className="group flex items-center gap-3 rounded-2xl border p-4" style={{ borderColor: completed ? `${accentColor}70` : 'rgba(255,255,255,.08)', background: completed ? `${accentColor}20` : 'rgba(255,255,255,.035)' }}><div className="min-w-0 flex-1"><div className={completed ? 'truncate text-sm text-white/55 line-through' : 'truncate text-sm text-white/78'}>{habit.title}</div><div className="mt-1 text-[11px] tabular-nums text-white/32">今天 {count} / {habit.target} 次</div></div><div className="flex items-center gap-1"><button type="button" aria-label="减少一次" onClick={() => updateHabitCount(habit, -1)} disabled={count <= 0} className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/5 text-white/50 hover:bg-white/10 disabled:opacity-20">−</button><button type="button" aria-label="增加一次" onClick={() => updateHabitCount(habit, 1)} disabled={completed} className="flex h-8 w-8 items-center justify-center rounded-xl font-semibold text-slate-950 disabled:opacity-30" style={{ background: accentColor }}>+</button><button type="button" aria-label="删除习惯" onClick={() => update(current => ({ ...current, habits: current.habits.filter(item => item.id !== habit.id) }))} className="ml-1 text-white/25 opacity-0 hover:text-rose-300 group-hover:opacity-100"><Trash2 className="h-4 w-4" /></button></div></div> })}</div>
                  {data.habits.length === 0 && <div className="mt-5 rounded-2xl border border-dashed border-white/10 py-16 text-center text-sm text-white/30">添加一个每天想坚持的小习惯</div>}
                </section>
              )}

              {tab === 'countdown' && (
                <section className="mx-auto max-w-2xl rounded-[26px] border border-white/10 bg-white/[.04] p-5">
                  <div className="grid grid-cols-[minmax(0,1fr)_190px_auto] gap-2"><input value={milestoneTitle} onChange={event => setMilestoneTitle(event.target.value)} placeholder="重要日期名称" className="h-11 rounded-2xl border border-white/10 bg-black/20 px-4 text-sm outline-none placeholder:text-white/25 focus:border-white/25" /><BeautifulDatePicker value={milestoneDate} accentColor={accentColor} onChange={setMilestoneDate} /><button type="button" onClick={addMilestone} className="flex h-11 items-center gap-2 rounded-2xl px-4 text-sm font-semibold text-slate-950" style={{ background: accentColor }}><Plus className="h-4 w-4" />添加</button></div>
                  <div className="mt-5 space-y-3">{[...data.milestones].sort((a, b) => a.date.localeCompare(b.date)).map(item => { const days = Math.ceil((new Date(`${item.date}T00:00:00`).getTime() - new Date(`${todayKey}T00:00:00`).getTime()) / 86400000); return <div key={item.id} className="group flex items-center gap-4 rounded-2xl border border-white/8 bg-white/[.035] p-4"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-lg font-semibold" style={{ background: `${accentColor}28`, color: accentColor }}>{days >= 0 ? days : Math.abs(days)}</div><div className="min-w-0 flex-1"><div className="truncate font-medium text-white/82">{item.title}</div><div className="mt-1 text-xs text-white/38">{item.date} · {days > 0 ? `还有 ${days} 天` : days === 0 ? '就是今天' : `已过去 ${Math.abs(days)} 天`}</div></div><button type="button" aria-label="删除重要日期" onClick={() => update(current => ({ ...current, milestones: current.milestones.filter(milestone => milestone.id !== item.id) }))} className="text-white/25 opacity-0 hover:text-rose-300 group-hover:opacity-100"><Trash2 className="h-4 w-4" /></button></div> })}</div>
                  {data.milestones.length === 0 && <div className="mt-5 rounded-2xl border border-dashed border-white/10 py-16 text-center text-sm text-white/30">添加生日、纪念日、考试或项目截止日</div>}
                </section>
              )}
            </main>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function useProductivityWidgetOverlay(initialTab: ProductivityTab, onOverlayOpenChange?: (open: boolean) => void) {
  const [open, setOpen] = useState(false)
  const show = () => { onOverlayOpenChange?.(true); setOpen(true) }
  const close = () => { setOpen(false); onOverlayOpenChange?.(false) }
  return { open, show, close, initialTab }
}

export function NotesWidget(props: ProductivityWidgetProps) {
  const { data, update } = useDesktopProductivity()
  const overlay = useProductivityWidgetOverlay('notes', props.onOverlayOpenChange)
  const [completingTaskIds, setCompletingTaskIds] = useState<Set<string>>(() => new Set())
  const completionTimersRef = useRef<Map<string, number>>(new Map())
  const pending = data.tasks.filter(task => !task.completed)
  const completed = data.tasks.length - pending.length

  useEffect(() => () => {
    completionTimersRef.current.forEach(timer => window.clearTimeout(timer))
  }, [])

  const completeTaskWithAnimation = (taskId: string) => {
    if (completingTaskIds.has(taskId)) return
    setCompletingTaskIds(current => new Set(current).add(taskId))
    const timer = window.setTimeout(() => {
      update(current => ({ ...current, tasks: current.tasks.map(item => item.id === taskId ? { ...item, completed: true } : item) }))
      setCompletingTaskIds(current => { const next = new Set(current); next.delete(taskId); return next })
      completionTimersRef.current.delete(taskId)
    }, 520)
    completionTimersRef.current.set(taskId, timer)
  }

  return <><ProductivityShell {...props} className="p-4"><button type="button" onClick={overlay.show} className="flex w-full items-center justify-between text-left"><span className="flex items-center gap-2 text-sm font-medium text-white/76"><ListTodo className="h-4 w-4" style={{ color: props.accentColor }} />便签清单</span><span className="text-[10px] text-white/35">{pending.length} 待办 · {completed} 完成</span></button><div className="mt-3 space-y-2"><AnimatePresence initial={false} mode="popLayout">{pending.slice(0, 3).map(task => { const completing = completingTaskIds.has(task.id); return <motion.button layout key={task.id} type="button" disabled={completing} onClick={() => completeTaskWithAnimation(task.id)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: completing ? .78 : 1, y: 0, scale: completing ? .97 : 1, backgroundColor: completing ? `${props.accentColor}32` : 'rgba(255,255,255,.045)' }} exit={{ opacity: 0, x: 42, scale: .9, filter: 'blur(5px)' }} transition={{ duration: completing ? .24 : .32, ease: [0.22, 1, 0.36, 1] }} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-white/68"><motion.span animate={{ rotate: completing ? 360 : 0, scale: completing ? [1, 1.35, 1] : 1 }} transition={{ duration: .38 }} className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full" style={{ color: props.accentColor }}>{completing ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-3.5 w-3.5" />}</motion.span><span className={`truncate transition ${completing ? 'text-white/38 line-through' : ''}`}>{task.title}</span>{completing && <motion.span initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className="ml-auto text-[9px] font-medium" style={{ color: props.accentColor }}>已完成</motion.span>}</motion.button> })}</AnimatePresence>{pending.length === 0 && <button type="button" onClick={overlay.show} className="flex w-full items-center justify-center rounded-xl border border-dashed border-white/10 py-4 text-xs text-white/30"><Plus className="mr-1.5 h-3.5 w-3.5" />添加一项待办</button>}</div></ProductivityShell><DesktopProductivityCenter open={overlay.open} initialTab="notes" accentColor={props.accentColor} data={data} update={update} onClose={overlay.close} /></>
}

export function MemoWidget(props: ProductivityWidgetProps) {
  const { data, update } = useDesktopProductivity()
  const overlay = useProductivityWidgetOverlay('memo', props.onOverlayOpenChange)
  const recentMemos = useMemo(() => [...data.memos].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3), [data.memos])
  return <><button type="button" onClick={overlay.show} className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-white/70"><ProductivityShell {...props} className="p-4"><div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm font-medium text-white/76"><NotebookPen className="h-4 w-4" style={{ color: props.accentColor }} />备忘录</span><span className="text-[10px] text-white/32">{data.memos.length} 条</span></div>{recentMemos.length ? <div className="mt-3 space-y-2">{recentMemos.map(memo => <div key={memo.id} className="rounded-xl bg-amber-100/[.055] px-3 py-2"><div className="truncate text-xs font-medium text-white/62">{memo.title || '未命名备忘'}</div><div className="mt-1 truncate text-[10px] text-white/28">{memo.content || '空白备忘'}</div></div>)}</div> : <div className="mt-3 flex items-center justify-center rounded-xl border border-dashed border-white/10 py-5 text-xs text-white/30"><Plus className="mr-1.5 h-3.5 w-3.5" />新建第一条备忘</div>}</ProductivityShell></button><DesktopProductivityCenter open={overlay.open} initialTab="memo" accentColor={props.accentColor} data={data} update={update} onClose={overlay.close} /></>
}

export function HabitsWidget(props: ProductivityWidgetProps) {
  const { data, update } = useDesktopProductivity()
  const overlay = useProductivityWidgetOverlay('habits', props.onOverlayOpenChange)
  const todayKey = getTodayKey()
  const counts = data.habitChecks[todayKey] || {}
  const totalTarget = data.habits.reduce((sum, habit) => sum + habit.target, 0)
  const totalCompleted = data.habits.reduce((sum, habit) => sum + Math.min(habit.target, counts[habit.id] || 0), 0)
  const progress = totalTarget ? Math.round((totalCompleted / totalTarget) * 100) : 0

  return <><ProductivityShell {...props} className="p-4"><button type="button" onClick={overlay.show} className="flex w-full items-center justify-between text-left"><span className="flex items-center gap-2 text-sm font-medium text-white/76"><Target className="h-4 w-4" style={{ color: props.accentColor }} />今日习惯</span><span className="text-xs font-medium tabular-nums text-white/45">{progress}%</span></button><div className="mt-3 grid grid-cols-2 gap-2">{data.habits.slice(0, 4).map(habit => { const count = counts[habit.id] || 0; const done = count >= habit.target; return <button key={habit.id} type="button" disabled={done} onClick={() => update(current => { const currentCounts = current.habitChecks[todayKey] || {}; return { ...current, habitChecks: { ...current.habitChecks, [todayKey]: { ...currentCounts, [habit.id]: Math.min(habit.target, (currentCounts[habit.id] || 0) + 1) } } } })} className="flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[11px] disabled:cursor-default" style={{ background: done ? `${props.accentColor}28` : 'rgba(255,255,255,.045)', color: done ? '#fff' : 'rgba(255,255,255,.55)' }}>{done ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" style={{ color: props.accentColor }} /> : <Circle className="h-3.5 w-3.5 shrink-0" />}<span className="min-w-0 flex-1 truncate">{habit.title}</span><span className="shrink-0 tabular-nums text-white/32">{count}/{habit.target}</span></button> })}</div>{data.habits.length === 0 && <button type="button" onClick={overlay.show} className="mt-3 flex w-full items-center justify-center rounded-xl border border-dashed border-white/10 py-4 text-xs text-white/30"><Plus className="mr-1.5 h-3.5 w-3.5" />添加每日习惯</button>}<div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full transition-[width]" style={{ width: `${progress}%`, background: props.accentColor }} /></div></ProductivityShell><DesktopProductivityCenter open={overlay.open} initialTab="habits" accentColor={props.accentColor} data={data} update={update} onClose={overlay.close} /></>
}

export function CountdownWidget(props: ProductivityWidgetProps) {
  const { data, update } = useDesktopProductivity()
  const overlay = useProductivityWidgetOverlay('countdown', props.onOverlayOpenChange)
  const todayKey = getTodayKey()
  const nearest = useMemo(() => [...data.milestones].filter(item => item.date >= todayKey).sort((a, b) => a.date.localeCompare(b.date))[0] || [...data.milestones].sort((a, b) => b.date.localeCompare(a.date))[0], [data.milestones, todayKey])
  const days = nearest ? Math.ceil((new Date(`${nearest.date}T00:00:00`).getTime() - new Date(`${todayKey}T00:00:00`).getTime()) / 86400000) : 0

  return <><button type="button" onClick={overlay.show} className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-white/70"><ProductivityShell {...props} className="p-4"><div className="flex items-center gap-2 text-sm font-medium text-white/76"><CalendarClock className="h-4 w-4" style={{ color: props.accentColor }} />重要日倒数</div>{nearest ? <div className="mt-4 flex items-end justify-between gap-3"><div className="min-w-0"><div className="truncate text-sm text-white/62">{nearest.title}</div><div className="mt-1 text-[11px] text-white/32">{nearest.date}</div></div><div className="shrink-0 text-right"><span className="text-4xl font-semibold tabular-nums" style={{ color: props.accentColor }}>{Math.abs(days)}</span><span className="ml-1 text-xs text-white/40">天</span><div className="mt-1 text-[10px] text-white/32">{days > 0 ? '距离目标' : days === 0 ? '就是今天' : '已经过去'}</div></div></div> : <div className="mt-4 flex items-center justify-center rounded-xl border border-dashed border-white/10 py-5 text-xs text-white/30"><Plus className="mr-1.5 h-3.5 w-3.5" />添加重要日期</div>}</ProductivityShell></button><DesktopProductivityCenter open={overlay.open} initialTab="countdown" accentColor={props.accentColor} data={data} update={update} onClose={overlay.close} /></>
}
