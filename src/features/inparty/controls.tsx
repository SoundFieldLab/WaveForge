/**
 * In Party 共享 UI 控件：金黑风下拉 / 头像图选择 / 快捷键捕获。
 * 三个控件都是纯展示+回调，状态由调用方持有。
 */
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown } from 'lucide-react'

const GOLD = '#FFE89C'
const GOLD_DEEP = '#d9bd6e'
const BORDER = 'rgba(255,232,156,0.14)'
const PANEL = 'rgba(255,255,255,0.045)'

/** 自定义下拉（替代原生 select：金黑主题、无系统蓝、圆角阴影一致） */
export function FancySelect<T extends string | number>({ value, options, onChange, disabled, width }: {
  value: T
  options: Array<{ value: T; label: string; hint?: string }>
  onChange: (value: T) => void
  disabled?: boolean
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = options.find(option => option.value === value)

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative shrink-0" style={{ width }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-xs text-white/85 outline-none transition-colors disabled:opacity-40"
        style={{ borderColor: open ? GOLD + '66' : BORDER, background: 'rgba(0,0,0,0.5)' }}
      >
        <span className="truncate">{current?.label ?? '—'}</span>
        <ChevronDown className={'h-3.5 w-3.5 shrink-0 text-white/45 transition-transform ' + (open ? 'rotate-180' : '')} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute right-0 z-50 mt-1.5 max-h-64 overflow-y-auto rounded-xl border p-1 shadow-2xl"
            style={{ borderColor: GOLD + '44', background: 'linear-gradient(160deg,#17130a,#0b0b0e)', minWidth: '100%' }}
          >
            {options.map(option => {
              const active = option.value === value
              return (
                <button
                  key={String(option.value)} type="button"
                  onClick={() => { onChange(option.value); setOpen(false) }}
                  className={'flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ' + (active ? 'font-bold' : 'text-white/70 hover:bg-white/[0.07] hover:text-white/95')}
                  style={active ? { background: 'rgba(255,232,156,0.12)', color: GOLD } : undefined}
                >
                  <span className="truncate">{option.label}</span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** 压缩图片文件到 dataURL（最长边 maxEdge，JPEG quality） */
export async function compressImageFile(file: File, maxEdge = 512, quality = 0.85): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataUrl
  })
  const longest = Math.max(image.width, image.height)
  const scale = longest > maxEdge ? maxEdge / longest : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', quality)
}

/** 头像图选择（上传→压缩→≤512KB 校验；有图显示图，无图显示占位） */
export function AvatarImagePicker({ image, onChange, size = 64 }: {
  image?: string
  onChange: (dataUrl: string | null) => void
  size?: number
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')

  const pick = async (file: File) => {
    setError('')
    try {
      const dataUrl = await compressImageFile(file, 512, 0.85)
      if (dataUrl.length > 512 * 1024) {
        setError('图片压缩后仍超过 512KB，请换一张更简单的')
        return
      }
      onChange(dataUrl)
    } catch {
      setError('图片读取失败')
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        onContextMenu={e => { if (image) { e.preventDefault(); onChange(null) } }}
        className="group relative overflow-hidden rounded-full transition-transform hover:scale-[1.03]"
        style={{ width: size, height: size, border: '2px solid ' + GOLD, background: 'linear-gradient(135deg,#3a3222,#1a1710)' }}
        title={image ? '点击更换 · 右键恢复 emoji 头像' : '点击上传自定义头像'}
      >
        {image
          ? <img src={image} alt="自定义头像" className="h-full w-full object-cover" />
          : <span className="flex h-full w-full items-center justify-center text-[10px] text-white/40">上传<br />头像</span>}
      </button>
      <input
        ref={fileRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const file = e.target.files?.[0]; if (file) void pick(file); e.target.value = '' }}
      />
      {error && <span className="max-w-[140px] text-center text-[9px] leading-tight text-red-300">{error}</span>}
    </div>
  )
}

/** 快捷键捕获器：点击「录制」进入捕获，按 1-3 个键位自动完成 */
export function HotkeyCapture({ value, onChange }: { value: string[]; onChange: (keys: string[]) => void }) {
  const [recording, setRecording] = useState(false)
  const [tick, setStateTick] = useState(0)
  const keysRef = useRef<string[]>([])

  useEffect(() => {
    if (!recording) return
    // 修饰键计入组合（Ctrl/Shift/Alt/Meta），普通键作为"最后一位"按下时立即完成——
    // 这样 Ctrl+Shift+X 这类组合一次按键序列就能录完（modifier 累积 + 终键触发）。
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') { setRecording(false); keysRef.current = []; return }
      const key = event.key.length === 1 ? event.key.toUpperCase() : event.key
      if (!key) return
      // 修饰键：加入组合（去重）
      if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') {
        const label = key === 'Control' ? 'Ctrl' : key === 'Meta' ? 'Cmd' : key
        if (!keysRef.current.includes(label)) keysRef.current = [...keysRef.current, label]
        setStateTick(t => t + 1)
        return
      }
      // 普通键：作为组合最后一位，立即完成（含组合键去重）
      const combo = keysRef.current.includes(key) ? keysRef.current : [...keysRef.current, key]
      onChange(combo.slice(0, 3))
      setRecording(false)
    }
    // 用捕获阶段，避免被应用其它快捷键抢走
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onChange, recording])

  const label = value.length ? value.join(' + ') : '未设置'

  return (
    <button
      type="button"
      onClick={() => { keysRef.current = []; setRecording(true) }}
      className={'flex min-w-[130px] items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs transition-colors'}
      style={recording
        ? { borderColor: GOLD, background: 'rgba(255,232,156,0.1)', color: GOLD }
        : { borderColor: BORDER, background: PANEL, color: value.length ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)' }}
      title={recording ? '按下想要组合的按键（最多 3 个）… Esc 取消' : '点击录制新快捷键'}
    >
      {recording ? <span className="animate-pulse" data-tick={tick}>{keysRef.current.length ? keysRef.current.join(' + ') + ' …（再按或 Esc 结束）' : '按下按键…（最多 3 个）'}</span> : label}
    </button>
  )
}
