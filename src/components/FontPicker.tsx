/**
 * 桌面歌词字体选择器（四模式设置界面共用）
 *
 * 结构：
 * - 推荐字体：默认字体栈 + 内置的霞鹜文楷 / 得意黑（OFL 1.1，随软件分发）+ 常见系统字体
 * - 本机字体：通过 Chromium Local Font Access（queryLocalFonts）枚举用户安装的字体；
 *   首次展开时才请求（API 要求用户手势），拒绝/不可用时给出提示并可重试
 *
 * 防遮挡：下拉面板用 createPortal 渲染到 body、position:fixed 定位，
 * 不受设置抽屉 / 弹窗的 overflow 裁剪影响；空间不足时自动向上翻转，
 * 高度按可视空间钳制，滚动条始终完整可见。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react'

// queryLocalFonts 的类型尚未进入项目使用的 TS DOM lib，这里补声明
interface LocalFontData { family: string; fullName: string; postscriptName: string; style: string }
declare global {
  interface Window {
    queryLocalFonts?: () => Promise<LocalFontData[]>
  }
}

export const BUNDLED_FONTS = [
  { value: 'LXGW WenKai', label: '霞鹜文楷', hint: '开源楷体 · 内置' },
  { value: 'Smiley Sans', label: '得意黑', hint: '开源斜体黑体 · 内置' },
] as const

/** 各模式设置界面里展示的推荐系统字体（未安装时浏览器自动回退，不影响选择） */
export const RECOMMENDED_FONTS = [
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'PingFang SC', label: '苹方' },
  { value: 'DengXian', label: '等线' },
  { value: 'KaiTi', label: '楷体' },
  { value: 'SimSun', label: '宋体' },
  { value: 'SimHei', label: '黑体' },
] as const

export const DEFAULT_FONT_LABEL = '默认字体'

/** 预览 / 应用时的字体栈：指定字体优先，逐级回退，与歌词窗口的 lyricFontStack 保持一致 */
export function fontStack(family: string): string {
  const name = (family || '').trim()
  const fallback = '"Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif'
  if (!name) return fallback
  if (/^['"]/.test(name)) return `${name}, ${fallback}`
  return `"${name}", ${fallback}`
}

export interface FontPickerProps {
  /** 当前字体族名；空字符串 = 默认字体 */
  value: string
  onChange: (family: string) => void
  dark: boolean
  accent: string
  /** 触发按钮宽度（px），默认自适应容器 */
  buttonWidth?: number
  disabled?: boolean
}

interface FontOption { value: string; label: string; hint?: string; builtin?: boolean }

export default function FontPicker({ value, onChange, dark, accent, buttonWidth, disabled }: FontPickerProps) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [deviceFonts, setDeviceFonts] = useState<{ status: 'idle' | 'loading' | 'ready' | 'denied' | 'unsupported'; families: string[] }>({ status: 'idle', families: [] })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)

  const currentLabel = useMemo(() => {
    if (!value) return DEFAULT_FONT_LABEL
    const bundled = BUNDLED_FONTS.find(f => f.value === value)
    if (bundled) return bundled.label
    const recommended = RECOMMENDED_FONTS.find(f => f.value === value)
    return recommended ? recommended.label : value
  }, [value])

  const requestDeviceFonts = useCallback(async () => {
    if (typeof window === 'undefined') return
    if (!window.queryLocalFonts) {
      setDeviceFonts({ status: 'unsupported', families: [] })
      return
    }
    setDeviceFonts(prev => ({ ...prev, status: 'loading' }))
    try {
      const fonts = await window.queryLocalFonts()
      const families = Array.from(new Set(fonts.map(font => font.family))).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
      setDeviceFonts({ status: 'ready', families })
    } catch {
      setDeviceFonts({ status: 'denied', families: [] })
    }
  }, [])

  const place = useCallback(() => {
    const button = buttonRef.current
    if (!button) return
    const rect0 = button.getBoundingClientRect()
    const width = Math.max(rect0.width, 272)
    const desiredHeight = 336
    const spaceBelow = window.innerHeight - rect0.bottom - 12
    const spaceAbove = rect0.top - 12
    const openUp = spaceBelow < 220 && spaceAbove > spaceBelow
    const maxHeight = Math.max(180, Math.min(desiredHeight, openUp ? spaceAbove : spaceBelow))
    setRect({
      left: Math.min(Math.max(8, rect0.left), window.innerWidth - width - 8),
      top: openUp ? Math.max(8, rect0.top - maxHeight - 8) : rect0.bottom + 8,
      width,
      maxHeight,
    })
  }, [])

  // 打开时定位 + 监听外部点击 / ESC / 窗口滚动
  useLayoutEffect(() => {
    if (!open) return
    place()
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    const onScroll = (event: Event) => {
      // 面板内部滚动不关闭；页面/抽屉滚动时重新定位（跟随按钮）
      if (panelRef.current && event.target instanceof Node && panelRef.current.contains(event.target)) return
      place()
    }
    const onResize = () => place()
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onScroll, true)
    // 聚焦搜索框，方便直接输入过滤
    const timer = window.setTimeout(() => searchRef.current?.focus(), 30)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
      window.clearTimeout(timer)
    }
  }, [open, place])

  // 首次展开时枚举本机字体（queryLocalFonts 要求用户手势）
  useEffect(() => {
    if (open && deviceFonts.status === 'idle') void requestDeviceFonts()
  }, [open, deviceFonts.status, requestDeviceFonts])

  const closeAndPick = (family: string) => {
    onChange(family)
    setOpen(false)
    setFilter('')
  }

  const recommendedOptions: FontOption[] = useMemo(() => ([
    { value: '', label: DEFAULT_FONT_LABEL, hint: '当前默认字体栈' },
    ...BUNDLED_FONTS.map(f => ({ value: f.value, label: f.label, hint: f.hint, builtin: true })),
    ...RECOMMENDED_FONTS.map(f => ({ value: f.value, label: f.label, hint: '系统字体' })),
  ]), [])

  const filterText = filter.trim().toLowerCase()
  const filteredRecommended = recommendedOptions.filter(option =>
    !filterText || option.label.toLowerCase().includes(filterText) || option.value.toLowerCase().includes(filterText) || (option.hint || '').toLowerCase().includes(filterText))
  const filteredDevice = deviceFonts.families.filter(family =>
    !filterText || family.toLowerCase().includes(filterText))

  const bg = dark ? 'rgba(18,20,30,0.97)' : 'rgba(255,255,255,0.99)'
  const borderColor = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'
  const textMain = dark ? 'rgba(255,255,255,0.92)' : 'rgba(15,23,42,0.92)'
  const textSub = dark ? 'rgba(255,255,255,0.45)' : 'rgba(15,23,42,0.5)'
  const hoverBg = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)'
  const controlBg = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)'

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen(prev => !prev)}
        className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-50"
        style={{
          width: buttonWidth,
          borderColor: open ? accent : borderColor,
          background: controlBg,
          color: textMain,
        }}
      >
        <span className="min-w-0 flex-1 truncate text-left" style={{ fontFamily: fontStack(value) }}>
          {currentLabel}
        </span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" style={{ color: textSub, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .18s' }} />
      </button>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          className="waveforge-font-picker"
          style={{
            position: 'fixed',
            left: rect.left,
            top: rect.top,
            width: rect.width,
            maxHeight: rect.maxHeight,
            zIndex: 10060,
            display: 'flex',
            flexDirection: 'column',
            background: bg,
            border: `1px solid ${borderColor}`,
            borderRadius: 14,
            boxShadow: '0 18px 48px rgba(0,0,0,0.32)',
            overflow: 'hidden',
          }}
        >
          {/* 搜索过滤 */}
          <div className="p-2.5 pb-1.5" style={{ borderBottom: `1px solid ${borderColor}` }}>
            <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ background: controlBg }}>
              <Search className="h-3.5 w-3.5 flex-shrink-0" style={{ color: textSub }} />
              <input
                ref={searchRef}
                value={filter}
                onChange={event => setFilter(event.target.value)}
                placeholder="搜索字体…"
                className="w-full bg-transparent text-xs outline-none"
                style={{ color: textMain }}
              />
            </div>
          </div>

          {/* 选项列表（自定义滚动条见 .waveforge-font-picker-list 样式） */}
          <div className="waveforge-font-picker-list flex-1 overflow-y-auto px-1.5 py-1.5">
            {filteredRecommended.length > 0 && (
              <>
                <div className="px-2 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-wider" style={{ color: textSub }}>推荐字体</div>
                {filteredRecommended.map(option => (
                  <FontOptionRow
                    key={`r:${option.value}`}
                    option={option}
                    selected={value === option.value}
                    accent={accent}
                    dark={dark}
                    textMain={textMain}
                    textSub={textSub}
                    hoverBg={hoverBg}
                    onPick={closeAndPick}
                  />
                ))}
              </>
            )}

            <div className="mt-1 flex items-center justify-between px-2 pb-1 pt-1.5">
              <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: textSub }}>本机字体</span>
              <button
                type="button"
                onClick={() => void requestDeviceFonts()}
                className="flex items-center gap-1 text-[10px] transition-opacity hover:opacity-80"
                style={{ color: accent }}
                title="重新读取本机字体"
              >
                <RefreshCw className="h-3 w-3" />
                刷新
              </button>
            </div>

            {deviceFonts.status === 'loading' && (
              <div className="px-2.5 py-2 text-[11px]" style={{ color: textSub }}>正在读取本机字体…</div>
            )}
            {deviceFonts.status === 'denied' && (
              <div className="px-2.5 py-2 text-[11px] leading-4" style={{ color: textSub }}>
                未获得本机字体读取授权。点击右上角「刷新」重试，或使用上面的推荐字体。
              </div>
            )}
            {deviceFonts.status === 'unsupported' && (
              <div className="px-2.5 py-2 text-[11px] leading-4" style={{ color: textSub }}>
                当前环境不支持枚举本机字体，可使用推荐字体与内置字体。
              </div>
            )}
            {deviceFonts.status === 'ready' && filteredDevice.length === 0 && (
              <div className="px-2.5 py-2 text-[11px]" style={{ color: textSub }}>没有匹配的本机字体</div>
            )}
            {deviceFonts.status === 'ready' && filteredDevice.map(family => (
              <FontOptionRow
                key={`d:${family}`}
                option={{ value: family, label: family }}
                selected={value === family}
                accent={accent}
                dark={dark}
                textMain={textMain}
                textSub={textSub}
                hoverBg={hoverBg}
                onPick={closeAndPick}
              />
            ))}
          </div>

          {/* 组件内滚动条 + 选项样式（作用域限定，避免污染全局） */}
          <style>{`
            .waveforge-font-picker-list { scrollbar-width: thin; scrollbar-color: ${dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.2)'} transparent; }
            .waveforge-font-picker-list::-webkit-scrollbar { width: 8px; }
            .waveforge-font-picker-list::-webkit-scrollbar-track { background: transparent; }
            .waveforge-font-picker-list::-webkit-scrollbar-thumb { background: ${dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.18)'}; border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
            .waveforge-font-picker-list::-webkit-scrollbar-thumb:hover { background: ${accent}; background-clip: padding-box; }
          `}</style>
        </div>,
        document.body,
      )}
    </>
  )
}

function FontOptionRow({ option, selected, accent, dark, textMain, textSub, hoverBg, onPick }: {
  option: FontOption
  selected: boolean
  accent: string
  dark: boolean
  textMain: string
  textSub: string
  hoverBg: string
  onPick: (family: string) => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      onClick={() => onPick(option.value)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors"
      style={{ background: selected ? `${accent}22` : hovered ? hoverBg : 'transparent' }}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-5" style={{ color: selected ? accent : textMain, fontFamily: fontStack(option.value), fontWeight: selected ? 600 : 400 }}>
            {option.label}
          </span>
          {option.hint && (
            <span className="block truncate text-[10px] leading-4" style={{ color: textSub }}>{option.hint}</span>
          )}
        </span>
        {option.builtin && (
          <span
            className="flex-shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium"
            style={{ background: `${accent}1f`, color: accent }}
          >
            内置
          </span>
        )}
      </span>
      {selected && <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color: accent }} strokeWidth={3} />}
    </button>
  )
}
