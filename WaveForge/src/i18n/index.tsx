/**
 * WaveForge 轻量 i18n 基础设施
 * 语言：简体中文（中国）、繁体中文（中国香港/台湾/澳门）、English、日本語、한국어
 * 目前服务于：OOBE 1（首次引导）与《法律声明与用户协议》弹窗。
 * 其余软件界面暂不接入（后续如需全站多语言可在此扩展）。
 */
import { useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Globe, Check, ChevronDown } from 'lucide-react'

export type LocaleCode = 'zh-CN' | 'zh-HK' | 'zh-TW' | 'zh-MO' | 'en' | 'ja' | 'ko'

export interface LocaleMeta {
  code: LocaleCode
  /** 语言本地名（下拉框显示） */
  label: string
  /** 切换按钮短标签 */
  short: string
}

export const LOCALES: LocaleMeta[] = [
  { code: 'zh-CN', label: '简体中文（中国）', short: '简' },
  { code: 'zh-TW', label: '繁體中文（中國臺灣）', short: '台' },
  { code: 'zh-HK', label: '繁體中文（中國香港）', short: '港' },
  { code: 'zh-MO', label: '繁體中文（中國澳門）', short: '澳' },
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'ja', label: '日本語', short: '日' },
  { code: 'ko', label: '한국어', short: '한' },
]

export const DEFAULT_LOCALE: LocaleCode = 'zh-CN'

export function isLocale(value: string | null | undefined): value is LocaleCode {
  return LOCALES.some(locale => locale.code === value)
}

/** 倒计时模板填充：确认（{n}） → 确认（10） */
export function fillCountdown(template: string, seconds: number): string {
  return template.replace('{n}', String(seconds))
}

/** 倒计时按钮标签：倒计时中显示"确认（5）"，结束后去掉占位括号显示"确认" */
export function countdownLabel(template: string, seconds: number): string {
  if (seconds > 0) return template.replace('{n}', String(seconds))
  return template.replace(/[（(]\{n\}[）)]/, '')
}

/** 渲染带 **加粗** 标记的富文本（免责声明 / 法律正文的重点强调） */
export function renderRich(text: string, theme: 'dark' | 'light'): ReactNode {
  if (!text.includes('**')) return text
  const parts = text.split('**')
  return parts.map((part, index) =>
    index % 2 === 1
      ? <strong key={index} className={theme === 'dark' ? 'text-white' : 'text-black'}>{part}</strong>
      : part
  )
}

/**
 * 地区繁体微调：以台湾繁体为基底，按香港/澳门习惯替换关键用词。
 * 三地繁体仅在少量词汇上有差异，其余完全一致。
 */
const REGIONAL_TWEAKS: Record<'zh-HK' | 'zh-MO', Array<[string, string]>> = {
  'zh-HK': [
    ['隱私', '私隱'],
    ['使用者', '用戶'],
    ['資訊', '資料'],
    ['帳號', '賬戶'],
    ['軟體', '軟件'],
    ['簡報', '簡報'], // 占位保证非空
  ],
  'zh-MO': [
    ['隱私', '私隱'],
    ['使用者', '用戶'],
    ['資訊', '資料'],
    ['帳號', '賬戶'],
    ['軟體', '軟件'],
  ],
}

/** 由繁体（台湾）派生香港/澳门版本 */
export function deriveTraditional(traditional: string, region: 'zh-HK' | 'zh-MO'): string {
  let output = traditional
  for (const [from, to] of REGIONAL_TWEAKS[region]) {
    output = output.split(from).join(to)
  }
  return output
}

interface LocaleSwitcherProps {
  locale: LocaleCode
  onChange: (locale: LocaleCode) => void
  theme: 'dark' | 'light'
  accentColor: string
  /** 下拉框对齐方式：right=对齐按钮右缘（默认，用于弹窗头部）；center=居中于按钮（用于顶部居中的切换器） */
  align?: 'left' | 'center' | 'right'
}

/**
 * 语言切换器（按钮 + 下拉）。位置由父级控制（absolute/fixed 定位），
 * 供 OOBE 顶部居中与《法律声明与用户协议》弹窗右上角复用。
 */
export function LocaleSwitcher({ locale, onChange, theme, accentColor, align = 'right' }: LocaleSwitcherProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handle = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', handle)
    return () => window.removeEventListener('mousedown', handle)
  }, [open])

  const current = LOCALES.find(item => item.code === locale) || LOCALES[0]
  const isDark = theme === 'dark'

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(previous => !previous)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
          isDark ? 'border-white/15 bg-white/5 text-white/80 hover:bg-white/10' : 'border-black/10 bg-black/5 text-black/70 hover:bg-black/10'
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Globe className="w-3.5 h-3.5" style={{ color: accentColor }} />
        <span>{current.short}</span>
        <ChevronDown className={`w-3 h-3 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className={`absolute mt-2 w-56 rounded-xl border p-1.5 shadow-2xl backdrop-blur-xl z-50 ${
            align === 'center' ? 'left-1/2 -translate-x-1/2' : align === 'left' ? 'left-0' : 'right-0'
          } ${isDark ? 'bg-[#15151c]/95 border-white/10' : 'bg-white/95 border-black/10'}`}
          style={{ boxShadow: isDark ? '0 18px 50px rgba(0,0,0,0.5)' : '0 18px 50px rgba(0,0,0,0.15)' }}
        >
          {LOCALES.map(item => {
            const active = item.code === locale
            return (
              <button
                key={item.code}
                type="button"
                onClick={() => { onChange(item.code); setOpen(false) }}
                className={`w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
                  active
                    ? 'text-white'
                    : isDark ? 'text-white/70 hover:bg-white/10' : 'text-black/70 hover:bg-black/5'
                }`}
                style={active ? { backgroundColor: `${accentColor}26`, color: accentColor } : undefined}
              >
                <span className="whitespace-nowrap">{item.label}</span>
                {active && <Check className="w-4 h-4 shrink-0" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
