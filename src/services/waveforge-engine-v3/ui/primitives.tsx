/** 既有 HSE 效果弹窗的公共控件，与新调音室使用同一套亮色语义令牌。 */
import { useEffect, useId, useRef, type ReactNode, type CSSProperties } from 'react'
import { Info, X } from 'lucide-react'
import type { V3Theme } from './theme'
import { useStateFeedback } from './feedback'
import './hse-glass.css'

export function Toggle({ checked, onChange, theme, label = '启用效果', disabled }: {
  checked: boolean; onChange: (v: boolean) => void; theme: V3Theme; label?: string; disabled?: boolean
}) {
  return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled}
    onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
    className="hse-glass-switch relative h-7 w-12 shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
    style={{ outlineColor: theme.accentColor, '--md-sys-color-primary': theme.accentColor } as CSSProperties}>
    <span aria-hidden="true" className="hse-glass-thumb absolute left-[3px] top-1/2 h-5 w-5 rounded-full"
      style={{ transform: `translate(${checked ? 20 : 0}px, -50%)` }} />
  </button>
}

export function Slider({ label, value, min, max, step, onChange, display, theme, disabled }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
  display?: string; theme: V3Theme; disabled?: boolean
}) {
  const id = useId()
  const feedbackRef = useRef<HTMLOutputElement>(null)
  useStateFeedback(value === 0 ? 'zero' : value === min ? 'min' : value === max ? 'max' : 'normal', feedbackRef)
  return <div className={`mb-4 ${disabled ? 'opacity-60' : ''}`}>
    <div className="mb-2 flex items-center justify-between gap-3">
      <label htmlFor={id} className={`${theme.textSecondary} text-xs`}>{label}</label>
      <output ref={feedbackRef} htmlFor={id} className={`${theme.textPrimary} hse-mono text-xs font-medium`}>{display ?? value}</output>
    </div>
    <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      aria-valuetext={display ?? String(value)} onChange={(e) => onChange(parseFloat(e.target.value))}
      className="wf-glass-range hse-glass-range h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed"
      style={{ background: theme.sliderTrack(value, min, max) }} />
  </div>
}

export function GlassCard({ children, theme, className, style }: {
  children: ReactNode; theme: V3Theme; className?: string; style?: CSSProperties
}) {
  return <div className={`hse-glass-card relative min-w-0 rounded-[20px] p-5 ${className ?? ''}`}
    style={{ background: theme.glassCard, border: `1px solid ${theme.glassBorder}`, ...style }}>{children}</div>
}

export function Modal({ title, icon, onClose, theme, children, maxWidth = 'max-w-sm' }: {
  title: string; icon?: ReactNode; onClose: () => void; theme: V3Theme; children: ReactNode; maxWidth?: string
}) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    dialog?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return }
      if (e.key !== 'Tab' || !dialog) return
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'))
      if (!controls.length) { e.preventDefault(); dialog.focus(); return }
      const first = controls[0], last = controls[controls.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { e.preventDefault(); first.focus() }
    }
    dialog?.addEventListener('keydown', onKey)
    return () => { dialog?.removeEventListener('keydown', onKey); previous?.focus() }
  }, [])
  return <div className="fixed inset-0 z-[90] flex items-center justify-center p-4"
    style={{ background: 'rgba(21,58,55,0.22)' }} onClick={onClose}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      onClick={(e) => e.stopPropagation()} className={`hse-floating-layer w-full ${maxWidth} max-h-[86vh] overflow-y-auto rounded-3xl outline-none`}
      style={{ background: theme.glassPanelHighlight, border: `1px solid ${theme.glassBorder}`, boxShadow: 'inset 0 1px 0 #ffffff, 0 16px 48px #153a3729', '--md-sys-color-primary': theme.accentColor } as CSSProperties}>
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: '#c8ede4', color: theme.accentColor }}>{icon}</div>
            <h2 id={titleId} className={`${theme.textPrimary} font-semibold`}>{title}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭弹窗" className={`hse-glass-button rounded-full p-2 focus-visible:outline-2 ${theme.textSecondary}`}>
            <X className="h-5 w-5" />
          </button>
        </div>{children}
      </div>
    </div>
  </div>
}

export function Segmented<T extends string | boolean | number>({ options, value, onChange, theme, small, label = '选择模式' }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; theme: V3Theme; small?: boolean; label?: string
}) {
  const feedbackRef = useRef<HTMLDivElement>(null)
  useStateFeedback(value, feedbackRef)
  return <div ref={feedbackRef} role="radiogroup" aria-label={label} className={`hse-glass-group flex flex-wrap gap-1 rounded-2xl p-1 ${small ? '' : 'mb-4'}`}>
    {options.map((opt, index) => {
      const active = value === opt.value
      return <button key={String(opt.value)} type="button" role="radio" aria-checked={active} tabIndex={active || (index === 0 && !options.some((option) => option.value === value)) ? 0 : -1}
        onClick={() => onChange(opt.value)}
        onKeyDown={(e) => {
          const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
          if (!delta && e.key !== 'Home' && e.key !== 'End') return
          e.preventDefault()
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (index + delta + options.length) % options.length
          onChange(options[next].value)
          e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
        }}
        className={`hse-glass-choice min-h-9 flex-1 whitespace-nowrap rounded-xl px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 ${active ? `${theme.textPrimary} font-semibold` : theme.textSecondary}`}
        style={{ outlineColor: theme.accentColor, '--md-sys-color-primary': theme.accentColor } as CSSProperties}><span aria-hidden="true" className={`hse-choice-mark ${active ? 'is-selected' : ''}`}>✓</span>{opt.label}</button>
    })}
  </div>
}

export function Chip({ active, onClick, children, theme, title, deleteButton }: {
  active?: boolean; onClick: () => void; children: ReactNode; theme: V3Theme; title?: string; deleteButton?: ReactNode
}) {
  return <div className="relative shrink-0">
    <button type="button" aria-pressed={active} onClick={onClick} title={title}
      className="hse-glass-button hse-glass-choice rounded-full px-4 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ outlineColor: theme.accentColor, '--md-sys-color-primary': theme.accentColor } as CSSProperties}>{children}</button>{deleteButton}
  </div>
}

export function TextInput({ value, onChange, placeholder, theme, className, label }: {
  value: string; onChange: (v: string) => void; placeholder?: string; theme: V3Theme; className?: string; label?: string
}) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label ?? placeholder}
    className={`hse-glass-input rounded-xl px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 ${theme.textPrimary} ${className ?? ''}`}
    style={{ outlineColor: theme.accentColor, '--md-sys-color-primary': theme.accentColor } as CSSProperties} />
}

export function ActionButton({ onClick, children, theme, disabled, title, ghost }: {
  onClick: () => void; children: ReactNode; theme: V3Theme; disabled?: boolean; title?: string; ghost?: boolean
}) {
  return <button type="button" onClick={onClick} disabled={disabled} title={title}
    className={`hse-glass-button ${ghost ? '' : 'hse-glass-primary'} inline-flex min-h-9 items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-50 ${ghost ? theme.textSecondary : ''}`}
    style={{ outlineColor: theme.accentColor, '--md-sys-color-primary': theme.accentColor } as CSSProperties}>{children}</button>
}

export function SectionTitle({ icon, children, theme, hint }: {
  icon?: ReactNode; children: ReactNode; theme: V3Theme; hint?: ReactNode
}) {
  return <div className="mb-4"><div className={`${theme.textPrimary} flex items-center gap-2 font-medium`}>{icon}{children}</div>
    {hint && <div className={`${theme.textSecondary} mt-1 text-xs`}>{hint}</div>}</div>
}

export function InfoLine({ children, theme }: { children: ReactNode; theme: V3Theme }) {
  return <div className={`${theme.textTertiary} mt-3 flex items-start gap-2 text-xs leading-relaxed`}><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />{children}</div>
}

export function GlassRangeStyle({ theme }: { theme: V3Theme }) {
  return <style>{`
    .hse-glass-range { --hse-control-accent: ${theme.accentColor}; }
  `}</style>
}
