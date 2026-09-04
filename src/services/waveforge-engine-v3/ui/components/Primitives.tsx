/**
 * 基础 UI 组件 —— HyperSoundEngine 风格（framer-motion 微交互）
 */

import type { ReactNode, CSSProperties } from 'react'
import { motion } from 'framer-motion'
import type { HSETheme } from '../hse-theme'

/* ───────── 点击音效反馈（规划书 C；默认开启，localStorage 'waveforge:ui-click'='0' 关闭） ───────── */
let clickCtx: AudioContext | null = null
function uiClick(): void {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('waveforge:ui-click') === '0') return
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctor = w.AudioContext ?? w.webkitAudioContext
    if (!Ctor) return
    if (!clickCtx) clickCtx = new Ctor()
    const ctx = clickCtx
    if (ctx.state === 'suspended') void ctx.resume()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.value = 1320
    const t = ctx.currentTime
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
    o.connect(g); g.connect(ctx.destination)
    o.start(t); o.stop(t + 0.06)
  } catch { /* 静默：无 AudioContext 或被策略拦截 */ }
}

/* ───────── 玻璃卡片（hover 上浮 + 边框亮起） ───────── */
export function GlassCard({ children, theme, className, style }: {
  children: ReactNode
  theme: HSETheme
  className?: string
  style?: CSSProperties
}) {
  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      className={`relative rounded-2xl p-4 overflow-hidden ${className ?? ''}`}
      style={{
        background: theme.cardBg,
        backdropFilter: theme.glassCardBlur,
        WebkitBackdropFilter: theme.glassCardBlur,
        border: `1px solid ${theme.cardBorder}`,
        boxShadow: theme.cardGlow,
        ...style,
      }}
    >
      {/* 顶部渐变高光线 */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.45), transparent)' }} />
      {/* 左上角柔光 */}
      <div className="pointer-events-none absolute -top-8 -left-8 w-24 h-24 rounded-full opacity-60" style={{ background: `radial-gradient(circle, ${theme.accentColor}14 0%, transparent 70%)` }} />
      {children}
    </motion.div>
  )
}

/* ───────── 胶囊开关（按压微缩） ───────── */
export function Toggle({ checked, onChange, theme }: {
  checked: boolean
  onChange: (v: boolean) => void
  theme: HSETheme
}) {
  return (
    <motion.button
      type="button"
      aria-pressed={checked}
      whileTap={{ scale: 0.9 }}
      onClick={(e) => { e.stopPropagation(); uiClick(); onChange(!checked) }}
      className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
      style={checked
        ? { background: theme.accentGradient, boxShadow: `0 0 12px ${theme.accentColor}55` }
        : { backgroundColor: 'rgba(255,255,255,0.15)' }}
    >
      <span
        className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform"
        style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </motion.button>
  )
}

/* ───────── 滑块 ───────── */
export function Slider({ label, value, min, max, step, onChange, display, theme, disabled }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  display?: string
  theme: HSETheme
  disabled?: boolean
}) {
  return (
    <div className={`mb-3 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
      <div className="flex items-center justify-between mb-1">
        <span className={`${theme.textSecondary} text-xs`}>{label}</span>
        <span className={`hse-mono ${theme.textPrimary} text-xs font-medium`}>{display ?? value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="wf-hse-range w-full h-2 rounded-full appearance-none cursor-pointer"
        style={{ background: theme.sliderTrack(value, min, max) }}
      />
    </div>
  )
}

/* ───────── 分段选择 ───────── */
export function Segmented<T extends string | boolean | number>({ options, value, onChange, theme, small }: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  theme: HSETheme
  small?: boolean
}) {
  return (
    <div className={`flex gap-1.5 ${small ? '' : 'mb-4'}`}>
      {options.map((opt) => {
        const active = value === opt.value
        return (
          <motion.button
            key={String(opt.value)}
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={() => { uiClick(); onChange(opt.value) }}
            className={`flex-1 ${small ? 'py-1.5 rounded-lg text-[11px]' : 'py-2 rounded-lg text-xs'} transition-all ${active ? 'text-white font-medium' : theme.textSecondary}`}
            style={active
              ? { background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }
              : { backgroundColor: 'rgba(255,255,255,0.06)' }}
          >
            {opt.label}
          </motion.button>
        )
      })}
    </div>
  )
}

/* ───────── 动作按钮 ───────── */
export function ActionBtn({ onClick, children, theme, disabled, ghost }: {
  onClick: () => void
  children: ReactNode
  theme: HSETheme
  disabled?: boolean
  ghost?: boolean
}) {
  if (ghost) {
    return (
      <motion.button
        type="button"
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => { uiClick(); onClick() }}
        disabled={disabled}
        className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all hover:brightness-110 disabled:opacity-40 ${theme.textSecondary}`}
        style={{ backgroundColor: theme.inputBg, border: `1px solid ${theme.cardBorder}` }}
      >
        {children}
      </motion.button>
    )
  }
  return (
    <motion.button
      type="button"
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.95 }}
      onClick={() => { uiClick(); onClick() }}
      disabled={disabled}
      className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white transition-all hover:brightness-110 disabled:opacity-40"
      style={{ background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }}
    >
      {children}
    </motion.button>
  )
}

/* ───────── 信息行 ───────── */
export function InfoLine({ children, theme }: { children: ReactNode; theme: HSETheme }) {
  return (
    <div className={`${theme.textTertiary} text-[11px] mt-2 flex items-center gap-1`}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5.5" stroke="currentColor" strokeWidth="1"/><text x="6" y="8.5" textAnchor="middle" fill="currentColor" fontSize="7" fontFamily="sans-serif">i</text></svg>
      {children}
    </div>
  )
}

/* ───────── 滑块样式注入（含等宽数字类） ───────── */
export function RangeStyle({ theme }: { theme: HSETheme }) {
  return (
    <style>{`
      .hse-mono { font-family: ui-monospace, 'JetBrains Mono', 'Roboto Mono', SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
      .wf-hse-range::-webkit-slider-thumb {
        appearance: none; width: 16px; height: 16px; border-radius: 50%;
        background: rgba(255,255,255,0.92); border: 2px solid rgba(255,255,255,0.6);
        box-shadow: 0 2px 8px rgba(0,0,0,0.25), 0 0 0 3px ${theme.accentColor}44, inset 0 1px 2px rgba(255,255,255,0.8);
        cursor: pointer; transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .wf-hse-range::-webkit-slider-thumb:hover { transform: scale(1.2); box-shadow: 0 4px 14px rgba(0,0,0,0.3), 0 0 0 5px ${theme.accentColor}55, inset 0 1px 2px rgba(255,255,255,0.8); }
      .wf-hse-range::-webkit-slider-thumb:active { transform: scale(1.05); }
      .wf-hse-range::-moz-range-thumb {
        width: 16px; height: 16px; border-radius: 50%; background: rgba(255,255,255,0.92); border: 2px solid rgba(255,255,255,0.6);
        box-shadow: 0 2px 8px rgba(0,0,0,0.25), 0 0 0 3px ${theme.accentColor}44, inset 0 1px 2px rgba(255,255,255,0.8);
        cursor: pointer; transition: transform 0.15s ease, box-shadow 0.15s ease;
      }
      .wf-hse-range::-moz-range-thumb:hover { transform: scale(1.2); }
    `}</style>
  )
}
