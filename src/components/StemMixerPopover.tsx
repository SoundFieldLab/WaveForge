import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { AudioLines, Drum, MicVocal, Music2, RotateCcw, SlidersHorizontal, Waves } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TrackStemGains, TrackStemName } from '../audio/trackStemMixer'

export type StemControlStatus = 'unavailable' | 'idle' | 'separating' | 'partial' | 'ready' | 'failed'

export interface TrackStemControlModel {
  status: StemControlStatus
  gains: TrackStemGains
  availableStems: TrackStemName[]
  progress?: number
  active: boolean
  locked?: boolean
  reason?: string
  onEnable: () => void | Promise<boolean | void>
  onVocalChange: (gain: number) => void
  onStemChange: (stem: TrackStemName, gain: number) => void
  onReturnOriginal: () => void
}

interface StemMixerPopoverProps {
  control: TrackStemControlModel
  accentColor: string
  theme: 'light' | 'dark'
  variant?: 'compact' | 'immersive'
  placement?: 'above' | 'left'
  size?: 'default' | 'compact'
}

const STEM_META: Record<TrackStemName, { label: string; Icon: typeof MicVocal }> = {
  vocals: { label: '人声', Icon: MicVocal },
  drums: { label: '鼓组', Icon: Drum },
  bass: { label: '贝斯', Icon: Waves },
  other: { label: '其他乐器', Icon: Music2 },
}

const clamp = (value: number, min = 0, max = 1.2) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : 1))

export function StemMixerPopover({
  control,
  accentColor,
  theme,
  variant = 'compact',
  placement = 'above',
  size = 'default',
}: StemMixerPopoverProps) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  const dark = theme === 'dark'
  const immersive = variant === 'immersive'
  const disabled = Boolean(control.locked)
  const vocalPercent = Math.round(clamp(control.gains.vocals, 0, 1) * 100)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const openOrEnable = () => {
    if (control.locked) return
    setOpen(value => !value)
  }
  const enableThen = (action: () => void) => {
    if (control.active) {
      action()
      return
    }
    void Promise.resolve(control.onEnable()).then(result => {
      if (result !== false) action()
    })
  }

  const surface = dark ? 'rgba(17,19,27,.88)' : 'rgba(255,255,255,.9)'
  const text = dark ? '#f5f6fa' : '#202126'
  const muted = dark ? 'rgba(255,255,255,.55)' : 'rgba(20,21,26,.55)'
  const track = dark ? 'rgba(255,255,255,.13)' : 'rgba(10,12,18,.11)'

  return (
    <div ref={rootRef} className="relative flex items-center" data-stem-mixer-variant={variant}>
      <motion.button
        type="button"
        whileHover={disabled ? undefined : { scale: 1.08 }}
        whileTap={disabled ? undefined : { scale: 0.95 }}
        onClick={openOrEnable}
        disabled={disabled}
        className={`relative rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${immersive ? `border backdrop-blur-md ${size === 'compact' ? 'p-2.5' : 'p-3'}` : 'p-2'} ${dark ? immersive ? 'border-white/20 bg-black/40 hover:bg-black/60' : 'hover:bg-white/10' : immersive ? 'border-black/20 bg-white/50 hover:bg-white/70' : 'hover:bg-black/10'}`}
        style={immersive ? {
          backgroundColor: control.active ? accentColor : undefined,
          borderColor: control.active ? `${accentColor}66` : undefined,
          boxShadow: control.active ? `0 0 20px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.3)` : '0 4px 12px rgba(0,0,0,0.15)',
        } : undefined}
        title={control.locked ? 'AutoMix 过渡期间暂不可调整分轨' : control.reason || '人声与乐器调节'}
        aria-label="人声与乐器调节"
      >
        <AudioLines className={immersive ? size === 'compact' ? 'h-5 w-5' : 'h-6 w-6' : 'h-4 w-4'} style={{ color: immersive && control.active ? '#fff' : control.active ? accentColor : muted }} />
        {control.status === 'separating' && <span className="absolute right-0 top-0 h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: accentColor }} />}
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            data-testid="stem-mixer-popover"
            initial={reducedMotion ? { opacity: 0 } : placement === 'left' ? { opacity: 0, x: 8, scale: 0.96 } : { opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : placement === 'left' ? { opacity: 0, x: 8, scale: 0.96 } : { opacity: 0, y: 8, scale: 0.96 }}
            transition={{ duration: reducedMotion ? 0.1 : 0.18 }}
            className={`absolute z-[190] w-[300px] rounded-2xl border p-3 shadow-2xl ${placement === 'left' ? 'right-full top-1/2 mr-3 -translate-y-1/2' : 'bottom-full right-0 mb-3'}`}
            style={{ background: surface, color: text, borderColor: dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.12)', backdropFilter: 'blur(36px) saturate(170%)' }}
          >
            <style>{`
              .stem-mixer-range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:20px; height:20px; border-radius:50%; background:${dark ? '#f7f7fa' : '#ffffff'}; border:1px solid ${dark ? 'rgba(255,255,255,.65)' : 'rgba(0,0,0,.12)'}; box-shadow:0 3px 10px rgba(0,0,0,.28); }
              .stem-mixer-range::-moz-range-thumb { width:20px; height:20px; border-radius:50%; background:${dark ? '#f7f7fa' : '#ffffff'}; border:1px solid ${dark ? 'rgba(255,255,255,.65)' : 'rgba(0,0,0,.12)'}; box-shadow:0 3px 10px rgba(0,0,0,.28); }
            `}</style>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">人声分离</div>
                <div className="text-[10px]" style={{ color: muted }}>
                  {control.status === 'separating' ? `正在准备分轨 ${Math.round((control.progress || 0) * 100)}%` : control.status === 'unavailable' ? (control.reason || '当前音源暂不支持分轨') : control.status === 'failed' ? '分轨失败，当前保持原声' : control.locked ? '过渡进行中，已冻结当前增益' : '拖动时保持乐器不变，仅调节人声'}
                </div>
              </div>
              <button type="button" onClick={() => setCustom(value => !value)} className="rounded-lg px-2 py-1 text-xs font-medium" style={{ color: accentColor, background: `${accentColor}18` }}>
                {custom ? '简洁' : '自定义'}
              </button>
            </div>

            {(control.status === 'unavailable' || control.status === 'failed') && (
              <button type="button" onClick={() => { void control.onEnable() }} className="mb-3 w-full rounded-lg py-1.5 text-xs font-medium" style={{ color: accentColor, background: `${accentColor}18` }}>
                重新检测并准备分轨
              </button>
            )}

            {!custom ? (
              <div>
                <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: muted }}><span>伴奏</span><span>原声</span></div>
                <input
                  aria-label="人声音量"
                  type="range" min="0" max="100" step="1" value={vocalPercent}
                  disabled={control.locked || control.status === 'separating' || control.status === 'unavailable' || control.status === 'failed'}
                  onChange={event => enableThen(() => control.onVocalChange(Number(event.target.value) / 100))}
                  className="stem-mixer-range h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${vocalPercent}%, ${track} ${vocalPercent}%, ${track} 100%)` }}
                />
                <div className="mt-2 text-center text-xs font-semibold tabular-nums">人声 {vocalPercent}%</div>
              </div>
            ) : (
              <div className="space-y-3">
                {control.availableStems.length === 0 && (
                  <div className="rounded-lg py-3 text-center text-xs" style={{ color: muted, background: track }}>
                    当前窗口尚未检测到可调音轨
                  </div>
                )}
                {control.availableStems.map(stem => {
                  const meta = STEM_META[stem]
                  const value = Math.round(clamp(control.gains[stem]) * 100)
                  return (
                    <label key={stem} className="grid grid-cols-[82px_1fr_42px] items-center gap-2">
                      <span className="flex items-center gap-1.5 text-xs"><meta.Icon className="h-3.5 w-3.5" style={{ color: accentColor }} />{meta.label}</span>
                      <input
                        aria-label={`${meta.label}增益`}
                        type="range" min="0" max="120" step="1" value={value}
                        disabled={control.locked || control.status === 'separating' || control.status === 'unavailable' || control.status === 'failed'}
                        onChange={event => enableThen(() => control.onStemChange(stem, Number(event.target.value) / 100))}
                        className="stem-mixer-range h-1.5 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${value / 1.2}%, ${track} ${value / 1.2}%, ${track} 100%)` }}
                      />
                      <span className="text-right text-[11px] font-semibold tabular-nums" style={{ color: value > 100 ? accentColor : text }}>{value}%</span>
                    </label>
                  )
                })}
              </div>
            )}

            <button type="button" onClick={control.onReturnOriginal} className="mt-3 flex w-full items-center justify-center gap-1 rounded-lg py-1.5 text-[11px] font-medium" style={{ color: muted, background: track }}>
              <RotateCcw className="h-3 w-3" />恢复原声
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default StemMixerPopover
