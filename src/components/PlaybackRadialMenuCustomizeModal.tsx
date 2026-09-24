import { AnimatePresence, motion } from 'framer-motion'
import { useTvBack } from '../tv/tvCore'
import { Check, Copy, Disc3, Heart, Info, ListMusic, MessageCircle, Minus, Plus, Repeat2, RotateCcw, Search, UserRound, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_PLAYBACK_RADIAL_ACTIONS,
  getAvailablePlaybackRadialActions,
  getPlaybackRadialActions,
  MAX_PLAYBACK_RADIAL_ACTIONS,
  PLAYBACK_RADIAL_ACTIONS,
  setPlaybackRadialActions,
  type PlaybackRadialActionId,
} from '../services/playbackRadialMenuSettings'
import { getRadialIndex, getRadialPoint, moveRadialItem } from '../services/radialLayout'
import PlaybackRadialWheel from './PlaybackRadialWheel'
import type { MusicPlatform } from '../services/platforms'
import { getPlatformFavoriteLabels } from '../services/platforms'

interface Props {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
  accentColor?: string
  platform?: MusicPlatform
}

interface DragSession {
  id: PlaybackRadialActionId
  source: 'wheel' | 'available'
  baseOrder: PlaybackRadialActionId[]
  x: number
  y: number
  overWheel: boolean
}

const WHEEL_SIZE = 360
const SLOT_RADIUS = 126
const INNER_DROP_RADIUS = 52
const OUTER_DROP_RADIUS = 175

const ICONS: Record<PlaybackRadialActionId, LucideIcon> = {
  'play-next': Repeat2,
  favorite: Heart,
  comments: MessageCircle,
  album: Disc3,
  artist: UserRound,
  details: Info,
  'add-to-playlist': ListMusic,
  'copy-info': Copy,
  similar: Search,
}

export default function PlaybackRadialMenuCustomizeModal({ show, onClose, playerTheme = 'dark', accentColor = '#3B82F6', platform = 'netease' }: Props) {
  // TV 遥控：BACK 关闭本弹窗
  useTvBack(() => {
    if (!show) return false
    onClose()
    return true
  }, [show, onClose])
  const [selected, setSelected] = useState<PlaybackRadialActionId[]>(() => getPlaybackRadialActions())
  const [drag, setDrag] = useState<DragSession | null>(null)
  const wheelRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef(selected)
  const dragRef = useRef(drag)
  selectedRef.current = selected
  dragRef.current = drag

  const isDark = playerTheme === 'dark'
  const available = useMemo(() => getAvailablePlaybackRadialActions(platform), [platform])
  const availableIds = new Set(available.map(action => action.id))
  const visibleSelected = selected.filter(id => availableIds.has(id)).slice(0, MAX_PLAYBACK_RADIAL_ACTIONS)
  const availableToAdd = available.filter(action => !selected.includes(action.id))
  const metaById = new Map(PLAYBACK_RADIAL_ACTIONS.map(action => [action.id, action]))
  const favoriteLabels = getPlatformFavoriteLabels(platform)

  useEffect(() => {
    if (show) setSelected(getPlaybackRadialActions())
  }, [show])

  useEffect(() => {
    if (!drag) return
    const handlePointerMove = (event: PointerEvent) => {
      const session = dragRef.current
      const wheel = wheelRef.current
      if (!session || !wheel) return
      const rect = wheel.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const distance = Math.hypot(event.clientX - centerX, event.clientY - centerY)
      const overWheel = distance >= INNER_DROP_RADIUS && distance <= OUTER_DROP_RADIUS
      let next = selectedRef.current

      if (session.source === 'available') {
        if (!overWheel) {
          next = session.baseOrder
        } else {
          const withoutDragged = next.filter(id => id !== session.id)
          const target = getRadialIndex(event.clientX, event.clientY, centerX, centerY, withoutDragged.length + 1)
          next = [...withoutDragged]
          next.splice(target, 0, session.id)
        }
      } else if (overWheel) {
        const from = next.indexOf(session.id)
        const target = getRadialIndex(event.clientX, event.clientY, centerX, centerY, next.length)
        next = moveRadialItem(next, from, target)
      }

      if (next.join('|') !== selectedRef.current.join('|')) setSelected(next)
      setDrag({ ...session, x: event.clientX, y: event.clientY, overWheel })
    }
    const finish = () => {
      const session = dragRef.current
      if (!session) return
      if (session.overWheel) setPlaybackRadialActions(selectedRef.current)
      else setSelected(session.baseOrder)
      setDrag(null)
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [drag?.id, drag?.source])

  const persist = (next: PlaybackRadialActionId[]) => {
    setSelected(next)
    setPlaybackRadialActions(next)
  }
  const remove = (id: PlaybackRadialActionId) => persist(selected.filter(item => item !== id))
  const add = (id: PlaybackRadialActionId) => {
    if (!selected.includes(id) && selected.length < MAX_PLAYBACK_RADIAL_ACTIONS) persist([...selected, id])
  }
  const labelFor = (id: PlaybackRadialActionId) => id === 'favorite' ? favoriteLabels.add : metaById.get(id)?.label || id
  const beginDrag = (event: ReactPointerEvent, id: PlaybackRadialActionId, source: DragSession['source']) => {
    if (source === 'available' && selected.length >= MAX_PLAYBACK_RADIAL_ACTIONS) return
    event.preventDefault()
    setDrag({ id, source, baseOrder: [...selected], x: event.clientX, y: event.clientY, overWheel: source === 'wheel' })
  }

  const renderNode = (id: PlaybackRadialActionId, dragging = false) => {
    const Icon = ICONS[id]
    return (
      <div className={`relative flex h-[62px] w-[72px] flex-col items-center justify-center gap-1 text-center ${dragging ? 'scale-110' : ''}`}>
        <Icon className="h-6 w-6" style={{ color: accentColor }} />
        <span className="max-w-[70px] truncate text-[11px] font-semibold">{labelFor(id)}</span>
      </div>
    )
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div className="fixed inset-0 z-[10040] flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <button type="button" aria-label="关闭右键轮盘设置" className="absolute inset-0 bg-black/55 backdrop-blur-md" onClick={onClose} />
          <motion.div role="dialog" aria-modal="true" aria-label="右键轮盘设置" className={`relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border shadow-2xl ${isDark ? 'border-white/15 bg-slate-950/95 text-white' : 'border-black/10 bg-white/95 text-black'}`} initial={{ y: 18, scale: 0.97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 18, scale: 0.97 }}>
            <header className={`flex items-center justify-between border-b px-5 py-4 ${isDark ? 'border-white/10' : 'border-black/10'}`}>
              <div><h2 className="text-lg font-semibold">右键轮盘</h2><p className={`mt-1 text-xs ${isDark ? 'text-white/55' : 'text-black/55'}`}>直接拖动轮盘功能调整顺序，最多显示 {MAX_PLAYBACK_RADIAL_ACTIONS} 个</p></div>
              <button type="button" aria-label="关闭" onClick={onClose} className="rounded-lg p-2 transition hover:bg-black/10"><X className="h-5 w-5" /></button>
            </header>

            <div className="overflow-y-auto p-5">
              <section className={`relative flex min-h-[430px] items-center justify-center overflow-hidden rounded-xl border ${isDark ? 'border-white/10 bg-black/15' : 'border-black/10 bg-black/[0.02]'}`}>
                <div ref={wheelRef} className="relative h-[360px] w-[360px] touch-none">
                  <PlaybackRadialWheel
                    items={visibleSelected.map(id => ({ id, label: labelFor(id), Icon: ICONS[id] }))}
                    selectedIndex={null}
                    accentColor={accentColor}
                    isDark={isDark}
                    size={WHEEL_SIZE}
                    showContent={false}
                    centerLabel="拖动调整"
                  />
                  {visibleSelected.map((id, index) => {
                    const point = getRadialPoint(index, visibleSelected.length, SLOT_RADIUS)
                    const isDragging = drag?.id === id
                    return (
                      <motion.div key={id} className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none ${isDragging ? 'opacity-20' : 'cursor-grab'}`} animate={{ x: point.x, y: point.y }} transition={{ type: 'spring', stiffness: 430, damping: 34 }} onPointerDown={event => beginDrag(event, id, 'wheel')}>
                        {renderNode(id)}
                        <button type="button" aria-label={`移除${labelFor(id)}`} onPointerDown={event => event.stopPropagation()} onClick={() => remove(id)} className="absolute -right-1 -top-1 rounded-full bg-black/70 p-0.5 text-white/80"><Minus className="h-3 w-3" /></button>
                      </motion.div>
                    )
                  })}
                </div>
                <span className={`absolute bottom-4 right-5 text-xs ${isDark ? 'text-white/45' : 'text-black/45'}`}>{visibleSelected.length}/{MAX_PLAYBACK_RADIAL_ACTIONS}</span>
                <button type="button" onClick={() => persist([...DEFAULT_PLAYBACK_RADIAL_ACTIONS])} className="absolute left-4 top-4 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition hover:bg-black/10"><RotateCcw className="h-3.5 w-3.5" />恢复默认</button>
              </section>

              <div className="mb-2 mt-5 flex items-center justify-between"><h3 className="text-sm font-semibold">可添加功能</h3><span className={`text-xs ${isDark ? 'text-white/45' : 'text-black/45'}`}>拖到轮盘对应位置</span></div>
              <div className="grid gap-2 sm:grid-cols-2">
                {availableToAdd.map(action => (
                  <div key={action.id} onPointerDown={event => beginDrag(event, action.id, 'available')} className={`flex touch-none select-none items-center gap-3 rounded-xl border px-3 py-2.5 ${isDark ? 'border-white/10 bg-white/[0.03]' : 'border-black/10 bg-black/[0.02]'} ${selected.length >= MAX_PLAYBACK_RADIAL_ACTIONS ? 'opacity-45' : 'cursor-grab'}`}>
                    {renderNode(action.id)}
                    <span className={`min-w-0 flex-1 text-xs ${isDark ? 'text-white/45' : 'text-black/45'}`}>{action.description}</span>
                    <button type="button" disabled={selected.length >= MAX_PLAYBACK_RADIAL_ACTIONS} aria-label={`添加${action.label}`} onPointerDown={event => event.stopPropagation()} onClick={() => add(action.id)} className="rounded-lg p-1.5 transition hover:bg-black/10 disabled:opacity-30"><Plus className="h-4 w-4" /></button>
                  </div>
                ))}
                {availableToAdd.length === 0 && <div className={`rounded-xl border border-dashed p-5 text-center text-xs ${isDark ? 'border-white/15 text-white/45' : 'border-black/15 text-black/45'}`}><Check className="mx-auto mb-1 h-4 w-4" style={{ color: accentColor }} />所有可用功能都已加入轮盘</div>}
              </div>
            </div>
          </motion.div>

          {drag && (
            <motion.div className={`pointer-events-none fixed z-[10070] -translate-x-1/2 -translate-y-1/2 rounded-2xl border shadow-2xl backdrop-blur-xl ${isDark ? 'border-white/20 bg-slate-900/95 text-white' : 'border-black/10 bg-white/95 text-black'}`} style={{ left: drag.x, top: drag.y, boxShadow: `0 12px 40px ${accentColor}55` }} initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1.08, opacity: 1 }}>
              {renderNode(drag.id, true)}
            </motion.div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
