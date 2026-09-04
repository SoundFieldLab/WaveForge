/**
 * WaveForge v3 调音室 UI —— 基础组件（primitives）
 *
 * 与 v1/v2 调音室一致的交互基元：胶囊开关 Toggle、玻璃滑块 Slider、
 * 玻璃卡片 GlassCard、弹窗 Modal（CSS 动画替代 framer-motion，零动画依赖）、
 * 分段选择 Segmented、胶囊按钮 Chip、输入框 TextInput、分区标题 SectionTitle。
 *
 * 所有组件均为纯受控组件（props 驱动），不直接读写引擎/存储。
 */

import { useEffect, type ReactNode, type CSSProperties } from 'react'
import { Info, X } from 'lucide-react'
import type { V3Theme } from './theme'

/* ─────────────────────────── 胶囊开关 ─────────────────────────── */

export function Toggle({ checked, onChange, theme }: {
  checked: boolean
  onChange: (v: boolean) => void
  theme: V3Theme
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? '' : theme.dark ? 'bg-white/20' : 'bg-black/15'}`}
      style={checked ? { background: theme.accentGradient, boxShadow: `0 0 12px ${theme.accentColor}55` } : undefined}
    >
      <span
        className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform"
        style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </button>
  )
}

/* ─────────────────────────── 玻璃滑块 ─────────────────────────── */

export function Slider({ label, value, min, max, step, onChange, display, theme, disabled }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  display?: string
  theme: V3Theme
  disabled?: boolean
}) {
  return (
    <div className={`mb-3 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="flex items-center justify-between mb-1">
        <span className={`${theme.textSecondary} text-xs`}>{label}</span>
        <span className={`${theme.textPrimary} text-xs font-medium`}>{display ?? value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer"
        style={{ background: theme.sliderTrack(value, min, max) }}
      />
    </div>
  )
}

/* ─────────────────────────── 玻璃卡片 ─────────────────────────── */

export function GlassCard({ children, theme, className, style }: {
  children: ReactNode
  theme: V3Theme
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      className={`relative rounded-2xl p-4 overflow-hidden ${className ?? ''}`}
      style={{
        background: theme.glassCard,
        backdropFilter: theme.glassCardBlur,
        WebkitBackdropFilter: theme.glassCardBlur,
        border: `1px solid ${theme.glassBorder}`,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.18)',
        ...style,
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)' }} />
      {children}
    </div>
  )
}

/* ─────────────────────────── 弹窗 ─────────────────────────── */

/** CSS 关键帧（弹窗出现/消失动画，替代 framer-motion，零依赖） */
const MODAL_KEYFRAMES = `
@keyframes v3-modal-backdrop { from { opacity: 0 } to { opacity: 1 } }
@keyframes v3-modal-pop { from { opacity: 0; transform: scale(0.9) translateY(12px) } to { opacity: 1; transform: scale(1) translateY(0) } }
`

/** 居中配置弹窗（点击遮罩关闭；内容由 children 提供，含头部/开关/参数区） */
export function Modal({ title, icon, onClose, theme, children, maxWidth = 'max-w-sm' }: {
  title: string
  icon?: ReactNode
  onClose: () => void
  theme: V3Theme
  children: ReactNode
  maxWidth?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      style={{
        backgroundColor: theme.dark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.2)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        animation: 'v3-modal-backdrop 0.18s ease-out',
      }}
      onClick={onClose}
    >
      <style>{MODAL_KEYFRAMES}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${maxWidth} max-h-[86vh] overflow-y-auto rounded-3xl`}
        style={{
          background: theme.glassPanel,
          backdropFilter: theme.glassBlur,
          WebkitBackdropFilter: theme.glassBlur,
          border: `1px solid ${theme.glassBorder}`,
          boxShadow: '0 24px 64px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.2)',
          animation: 'v3-modal-pop 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2)',
        }}
      >
        <div className="p-5">
          {/* 头部 */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ background: `${theme.accentColor}22`, color: theme.accentColor, border: `1px solid ${theme.accentColor}55` }}
              >
                {icon}
              </div>
              <div className={`${theme.textPrimary} font-semibold`}>{title}</div>
            </div>
            <button type="button" onClick={onClose} aria-label="关闭弹窗" className={`p-2 rounded-full transition-colors ${theme.dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
              <X className={`w-4.5 h-4.5 ${theme.textSecondary}`} />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────── 分段选择 ─────────────────────────── */

export function Segmented<T extends string | boolean>({ options, value, onChange, theme, small }: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  theme: V3Theme
  small?: boolean
}) {
  return (
    <div className={`flex gap-1.5 ${small ? '' : 'mb-4'}`}>
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`flex-1 ${small ? 'py-1.5 rounded-lg text-[11px]' : 'py-2 rounded-lg text-xs'} transition-all ${active ? 'text-white font-medium' : theme.textSecondary + ' ' + (theme.dark ? 'bg-white/5' : 'bg-black/5')}`}
            style={active ? { background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` } : undefined}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

/* ─────────────────────────── 胶囊按钮 ─────────────────────────── */

export function Chip({ active, onClick, children, theme, title, deleteButton }: {
  active?: boolean
  onClick: () => void
  children: ReactNode
  theme: V3Theme
  title?: string
  deleteButton?: ReactNode
}) {
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={onClick}
        title={title}
        className="rounded-xl px-3 py-2 text-left transition-all hover:brightness-110 active:scale-[0.97]"
        style={{
          background: active ? `${theme.accentColor}26` : theme.inputBg,
          border: `1px solid ${active ? theme.accentColor : theme.glassBorder}`,
          boxShadow: active ? `0 0 14px ${theme.accentColor}44` : 'none',
          backdropFilter: 'blur(8px)',
          minWidth: '96px',
        }}
      >
        {children}
      </button>
      {deleteButton}
    </div>
  )
}

/* ─────────────────────────── 文本输入 ─────────────────────────── */

export function TextInput({ value, onChange, placeholder, theme, className }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  theme: V3Theme
  className?: string
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`px-3 py-1.5 rounded-lg text-xs outline-none ${theme.textPrimary} ${className ?? ''}`}
      style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}
    />
  )
}

/* ─────────────────────────── 主按钮 ─────────────────────────── */

export function ActionButton({ onClick, children, theme, disabled, title, ghost }: {
  onClick: () => void
  children: ReactNode
  theme: V3Theme
  disabled?: boolean
  title?: string
  /** 幽灵样式：透明底 + 描边（次要操作） */
  ghost?: boolean
}) {
  if (ghost) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all hover:brightness-110 active:scale-95 disabled:opacity-40 ${theme.textSecondary}`}
        style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}
      >
        {children}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white transition-all hover:brightness-110 active:scale-95 disabled:opacity-40"
      style={{ background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }}
    >
      {children}
    </button>
  )
}

/* ─────────────────────────── 分区标题 ─────────────────────────── */

export function SectionTitle({ icon, children, theme, hint }: {
  icon?: ReactNode
  children: ReactNode
  theme: V3Theme
  hint?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div>
        <div className={`${theme.textPrimary} font-medium flex items-center gap-2`}>
          {icon}
          {children}
        </div>
        {hint && <div className={`${theme.textSecondary} text-xs mt-0.5`}>{hint}</div>}
      </div>
    </div>
  )
}

/* ─────────────────────────── 信息提示行 ─────────────────────────── */

export function InfoLine({ children, theme }: { children: ReactNode; theme: V3Theme }) {
  return (
    <div className={`${theme.textTertiary} text-[11px] mt-2 flex items-center gap-1`}>
      <Info className="w-3 h-3 shrink-0" />
      {children}
    </div>
  )
}

/** wf-glass-range 滑块 thumb 全局样式（注入一次，双主题） */
export function GlassRangeStyle({ theme }: { theme: V3Theme }) {
  return (
    <style>
      {`
        .wf-glass-range::-webkit-slider-thumb {
          appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.92);
          border: 2px solid rgba(255, 255, 255, 0.6);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), 0 0 0 3px ${theme.accentColor}44, inset 0 1px 2px rgba(255, 255, 255, 0.8);
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .wf-glass-range::-webkit-slider-thumb:hover {
          transform: scale(1.2);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3), 0 0 0 5px ${theme.accentColor}55, inset 0 1px 2px rgba(255, 255, 255, 0.8);
        }
        .wf-glass-range::-webkit-slider-thumb:active {
          transform: scale(1.05);
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25), 0 0 0 4px ${theme.accentColor}66, inset 0 1px 2px rgba(255, 255, 255, 0.8);
        }
        .wf-glass-range::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.92);
          border: 2px solid rgba(255, 255, 255, 0.6);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), 0 0 0 3px ${theme.accentColor}44, inset 0 1px 2px rgba(255, 255, 255, 0.8);
          cursor: pointer;
          transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .wf-glass-range::-moz-range-thumb:hover {
          transform: scale(1.2);
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3), 0 0 0 5px ${theme.accentColor}55, inset 0 1px 2px rgba(255, 255, 255, 0.8);
        }
      `}
    </style>
  )
}