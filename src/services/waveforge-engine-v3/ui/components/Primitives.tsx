/** HSE 公共控件：主程序玻璃材质、明确选中状态与原生键盘操作。 */
import { useId, useRef, type ReactNode, type CSSProperties } from 'react'
import type { HSETheme } from '../hse-theme'
import { useStateFeedback } from '../feedback'
import '../hse-glass.css'

export function GlassCard({ children, theme, className, style }: {
  children: ReactNode; theme: HSETheme; className?: string; style?: CSSProperties
}) {
  return <div className={`hse-glass-card relative min-w-0 rounded-[20px] p-5 ${className ?? ''}`}
    style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, ...style }}>{children}</div>
}

export function Toggle({ checked, onChange, theme, label = '启用效果', disabled }: {
  checked: boolean; onChange: (v: boolean) => void; theme: HSETheme; label?: string; disabled?: boolean
}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
    className="hse-glass-switch relative h-7 w-12 shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-50"
    style={{ outlineColor: theme.accentColor, '--md-sys-color-primary': theme.accentColor } as CSSProperties}>
    <span aria-hidden="true" className="hse-glass-thumb absolute left-[3px] top-1/2 h-5 w-5 rounded-full"
      style={{ transform: `translate(${checked ? 20 : 0}px, -50%)` }} />
  </button>
}

export function Slider({ label, value, min, max, step, onChange, display, theme, disabled }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
  display?: string; theme: HSETheme; disabled?: boolean
}) {
  const id = useId()
  const feedbackRef = useRef<HTMLOutputElement>(null)
  useStateFeedback(value === 0 ? 'zero' : value === min ? 'min' : value === max ? 'max' : 'normal', feedbackRef)
  return <div className={`mb-4 ${disabled ? 'opacity-60' : ''}`}>
    <div className="mb-2 flex items-center justify-between gap-3">
      <label htmlFor={id} className={`${theme.textSecondary} text-xs`}>{label}</label>
      <output ref={feedbackRef} htmlFor={id} className={`hse-mono ${theme.textPrimary} text-xs font-medium`}>{display ?? value}</output>
    </div>
    <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      aria-valuetext={display ?? String(value)} onChange={(e) => onChange(parseFloat(e.target.value))}
      className="wf-hse-range h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed"
      style={{ background: theme.sliderTrack(value, min, max), accentColor: theme.accentColor }} />
  </div>
}

export function Segmented<T extends string | boolean | number>({ options, value, onChange, theme, small, label = '选择模式' }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; theme: HSETheme; small?: boolean; label?: string
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
          const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
          buttons?.[next]?.focus()
        }}
        className={`hse-glass-choice min-h-9 flex-1 whitespace-nowrap rounded-xl px-3 py-2 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 ${active ? `${theme.textPrimary} font-semibold` : theme.textSecondary}`}
        style={{ outlineColor: theme.accentColor, '--md-sys-color-primary': theme.accentColor } as CSSProperties}>
        <span aria-hidden="true" className={`hse-choice-mark ${active ? 'is-selected' : ''}`}>✓</span>{opt.label}
      </button>
    })}
  </div>
}

export function ActionBtn({ onClick, children, theme, disabled, ghost }: {
  onClick: () => void; children: ReactNode; theme: HSETheme; disabled?: boolean; ghost?: boolean
}) {
  return <button type="button" onClick={onClick} disabled={disabled}
    className={`hse-glass-button ${ghost ? '' : 'hse-glass-primary'} inline-flex min-h-9 items-center justify-center gap-2 rounded-xl px-4 py-2 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-4 disabled:cursor-not-allowed disabled:opacity-50 ${ghost ? theme.textSecondary : ''}`}
    style={{ outlineColor: theme.accentColor, '--md-sys-color-primary': theme.accentColor } as CSSProperties}>{children}</button>
}

export function InfoLine({ children, theme }: { children: ReactNode; theme: HSETheme }) {
  return <div className={`${theme.textTertiary} mt-3 flex items-start gap-2 text-xs leading-relaxed`}>
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 12 12" fill="none" className="mt-0.5 shrink-0">
      <circle cx="6" cy="6" r="5.5" stroke="currentColor" /><path d="M6 5v4M6 3v.5" stroke="currentColor" />
    </svg>{children}
  </div>
}

export function RangeStyle({ theme }: { theme: HSETheme }) {
  return <style>{`
    .wf-hse-range { --hse-control-accent: ${theme.accentColor}; }
  `}</style>
}
