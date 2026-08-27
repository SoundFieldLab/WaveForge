/**
 * DG-LAB 控制台（金黑 #FFE89C、官方 Logo、波形主导、顶栏收纳次要入口）。
 * 顶栏：Logo + 标题｜调试日志 · 使用说明 · 状态徽章 · 关闭
 * 连接成功后「连接设置」默认折叠成状态条，把空间让给实时波形与设置。
 */

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Copy, Check, QrCode, Power, Zap, TriangleAlert, Trash2, FileUp, Download, ScrollText,
  Plug, PlugZap, Wifi, ChevronDown, AudioWaveform, BookOpen, ChevronRight, Link2, RadioTower,
} from 'lucide-react'
import { useTvBack } from '../tv/tvCore'
import {
  useDGLabStatus,
  getDGLabClient,
  loadDGLabSettings,
  saveDGLabSettings,
  DEFAULT_DGLAB_SETTINGS,
  type DGLabSettings,
  type DGLabNetIf,
  type FeelStyleId,
  type StepPreset,
  type RampPreset,
  DGLAB_SETTINGS_EVENT,
} from '../plugins/clients/DGLabClient'
import {
  getWaveLibrary, removeWave, exportWavesAsTxt, DGLAB_WAVES_EVENT, usePluginHostState, closeDGLabConsole,
  isDGLabWidgetVisible, setDGLabWidgetVisible, DGLAB_WIDGET_EVENT,
} from '../services/pluginStore'
import { parseCombinedTxt, parsePulseFile, resampleDesignerWave, importWaves } from '../plugins/clients/waveImport'
import { OFFICIAL_BUILTIN_WAVES } from '../plugins/clients/officialWaves'
import { showToast } from '../plugins/toggle'
import type { WaveDef } from '../plugins/types'
import DGLabVizCanvas, { type DGLabVizModeId } from './DGLabVizCanvas'
import DGLabGuideModal from './DGLabGuideModal'
import { HelpInfo } from './DGLabHelp'

const DGLAB_LOGO = 'https://www.dungeon-lab.cn/img/logo-new.png'
const GOLD = '#FFE89C'
const GOLD_DEEP = '#d9bd6e'
const BLACK = '#0b0b0e'
const PANEL = 'rgba(255,255,255,0.045)'
const BORDER = 'rgba(255,255,255,0.08)'

const STYLE_OPTIONS: { value: FeelStyleId; label: string; desc: string }[] = [
  { value: 'stock', label: '原厂', desc: '复刻官方实时' },
  { value: 'stereo', label: '立体声', desc: '左右声像' },
  { value: 'heartbeat', label: '心跳', desc: '咚-哒律动' },
  { value: 'breath', label: '呼吸', desc: '缓起伏交替' },
  { value: 'wave', label: '潮汐', desc: '波浪横滚' },
  { value: 'tap', label: '敲击', desc: '鼓点短促' },
  { value: 'ride', label: '流动', desc: '连绵平缓' },
  { value: 'rumble', label: '重拳', desc: '低音重击' },
]

const STEP_OPTIONS: { value: StepPreset; label: string; desc: string }[] = [
  { value: 'strong', label: '强', desc: '耐电跟手(30)' },
  { value: 'medium', label: '中', desc: '平衡(12)' },
  { value: 'weak', label: '弱', desc: '最柔(5)' },
  { value: 'custom', label: '自定义', desc: '自填 1-60' },
]

const RAMP_OPTIONS: { value: RampPreset; label: string; desc: string }[] = [
  { value: 'fast', label: '快', desc: '1s' },
  { value: 'medium', label: '中', desc: '2.5s' },
  { value: 'slow', label: '慢', desc: '5s' },
]

function Segmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string; hint?: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          title={opt.hint}
          className={`rounded-lg px-2 py-1.5 text-center text-xs font-medium transition-colors border ${
            value === opt.value
              ? 'text-black border-transparent'
              : 'bg-white/[0.06] border-white/10 text-white/55 hover:bg-white/[0.12] hover:text-white/85'
          }`}
          style={value === opt.value ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

function ToggleRow({ label, desc, checked, onChange }: { label: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <div className="text-sm font-medium text-white/85">{label}</div>
        <div className="text-[11px] mt-0.5 text-white/40">{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200 ${checked ? '' : 'bg-white/15'}`}
        style={checked ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}
      >
        <span className={`pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  )
}

function SliderRow({ label, value, min, max, step, suffix, onChange, helpId }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (v: number) => void
  helpId?: string
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/45 flex items-center gap-1">
          {label}
          {helpId && <HelpInfo id={helpId} />}
        </span>
        <span className="text-xs font-semibold" style={{ color: GOLD }}>{value}{suffix ?? ''}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full h-1 rounded-full appearance-none cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#FFE89C] [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(255,232,156,0.7)]"
        style={{ background: `linear-gradient(to right, ${GOLD} ${pct}%, rgba(255,255,255,0.15) ${pct}%)` }}
      />
    </div>
  )
}

/* ------------------------------ 网卡选择（美化下拉） ------------------------------ */

function IpSelect({ ips, selected, onSelect }: {
  ips: DGLabNetIf[]
  selected: string
  onSelect: (address: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = selected || ips[0]?.address || '自动选择'
  const currentName = ips.find(i => i.address === selected)?.name

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 rounded-lg bg-black/40 border border-white/10 px-2.5 py-1.5 text-xs text-white/80 hover:border-amber-200/40 transition-colors"
      >
        <Wifi className="w-3.5 h-3.5 shrink-0" style={{ color: GOLD }} />
        <span className="flex-1 min-w-0 truncate">
          {currentName ? `${currentName} · ${current}` : current}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-white/50 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="absolute left-0 right-0 z-30 mt-1.5 rounded-xl overflow-hidden shadow-2xl"
            style={{ background: 'rgba(21,18,12,0.98)', border: `1px solid ${BORDER}` }}
          >
            <div className="px-3 py-2 text-[10px] border-b" style={{ color: `${GOLD}77`, borderColor: 'rgba(255,232,156,0.12)' }}>
              扫码地址网卡（多宽带/多网卡可切换）
            </div>
            <div className="py-1">
              <button
                type="button"
                onClick={() => { onSelect(''); setOpen(false) }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.06]"
                style={{ background: !selected ? 'rgba(255,232,156,0.08)' : 'transparent' }}
              >
                <span className="min-w-0">
                  <span className={`block text-xs ${!selected ? 'font-medium' : 'text-white/80'}`} style={!selected ? { color: GOLD } : undefined}>自动选择</span>
                  <span className="block text-[10px] text-white/40 truncate">优先私网段</span>
                </span>
                {!selected && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: GOLD }} />}
              </button>
              {ips.map(ip => {
                const active = ip.address === selected
                return (
                  <button
                    key={ip.address}
                    type="button"
                    onClick={() => { onSelect(ip.address); setOpen(false) }}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.06]"
                    style={{ background: active ? 'rgba(255,232,156,0.08)' : 'transparent' }}
                  >
                    <span className="min-w-0">
                      <span className={`block text-xs truncate ${active ? 'font-medium' : 'text-white/85'}`} style={active ? { color: GOLD } : undefined}>{ip.address}</span>
                      <span className="block text-[10px] text-white/40 truncate">{ip.name || '未知网卡'}</span>
                    </span>
                    {active && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: GOLD }} />}
                  </button>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------ 脉冲波形选择（平铺卡片） ------------------------------ */

function WavePicker({ waves, officialWaves = [], selected, onSelect }: {
  waves: WaveDef[]
  officialWaves?: WaveDef[]
  selected: string
  onSelect: (id: string) => void
}) {
  const items: { id: string; label: string; tag: string; custom?: boolean }[] = [
    ...[
      { id: 'continuous', label: '连续' },
      { id: 'breath', label: '呼吸' },
      { id: 'tide', label: '潮汐' },
      { id: 'beat', label: '节拍' },
      { id: 'dglab-sweep', label: '官方实时' },
    ]
      .map(w => ({ id: w.id, label: w.label, tag: '内置波形' })),
    ...officialWaves.map(w => ({ id: w.id, label: w.name, tag: '官方预设' })),
    ...waves.map(w => ({ id: w.id, label: w.name, tag: w.source === 'combined' ? '设计器' : '脉冲帧', custom: true })),
  ]
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map(item => {
        const active = item.id === selected
        return (
          <motion.button
            key={item.id}
            type="button"
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onSelect(item.id)}
            className={`relative rounded-xl px-3 py-2.5 text-left border transition-all ${active ? '' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.08]'}`}
            style={active ? {
              borderColor: `${GOLD}99`,
              background: 'rgba(255,232,156,0.1)',
              boxShadow: `0 0 0 1px ${GOLD}55, 0 6px 18px rgba(255,232,156,0.12)`,
            } : undefined}
          >
            <span className="block text-[13px] font-medium text-white/85 truncate pr-4">{item.label}</span>
            <span className={`block text-[10px] mt-0.5 ${active ? 'text-amber-100/80' : 'text-white/35'}`}>
              {item.custom ? '自定义 · ' : '内置 · '}{item.tag}
            </span>
            {active && <Check className="absolute right-2 top-2 w-3.5 h-3.5" style={{ color: GOLD }} />}
          </motion.button>
        )
      })}
    </div>
  )
}

/* ------------------------------ 波形库 ------------------------------ */

function WaveLibrary({ waves, onChanged }: { waves: WaveDef[]; onChanged: () => void }) {
  const txtRef = useRef<HTMLInputElement>(null)
  const pulseRef = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ source: 'combined' | 'pulse'; waves: WaveDef[] } | null>(null)

  const handleTxt = async (file: File) => {
    const text = await file.text()
    const result = parseCombinedTxt(text, file.name)
    if (result.waves.length === 0) {
      showToast(`导入失败：${result.errors[0] ?? '无法解析'}`, 'error')
      return
    }
    if (result.errors.length) showToast(`部分波形解析失败（${result.errors.length} 个）`, 'info')
    setPending({ source: 'combined', waves: result.waves })
  }

  const handlePulse = async (file: File) => {
    const text = await file.text()
    const result = parsePulseFile(text, file.name)
    if (result.waves.length === 0) {
      showToast(`导入失败：${result.errors[0] ?? '无法解析'}`, 'error')
      return
    }
    setPending({ source: 'pulse', waves: result.waves })
  }

  const confirmImport = () => {
    if (!pending) return
    const count = importWaves(pending.waves)
    showToast(`波形导入成功（${count} 个）`, 'success', 3600)
    setPending(null)
    onChanged()
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <button
          onClick={() => txtRef.current?.click()}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium transition-colors"
          style={{ borderColor: `${GOLD}55`, background: 'rgba(255,232,156,0.1)', color: GOLD }}
        >
          <FileUp className="w-3.5 h-3.5" />
          导入整合波形(.txt)
        </button>
        <button
          onClick={() => pulseRef.current?.click()}
          className="flex-1 flex items-center justify-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.06] px-2 py-2 text-xs font-medium text-white/70 hover:bg-white/[0.12] transition-colors"
        >
          <FileUp className="w-3.5 h-3.5" />
          导入单波形(.pulse)
        </button>
      </div>
      <input ref={txtRef} type="file" accept=".txt,text/plain,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleTxt(f); e.target.value = '' }} />
      <input ref={pulseRef} type="file" accept=".pulse,.txt,text/plain" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handlePulse(f); e.target.value = '' }} />

      <AnimatePresence>
        {pending && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="rounded-xl border p-3" style={{ borderColor: `${GOLD}44`, background: 'rgba(255,232,156,0.06)' }}>
              <p className="text-xs font-semibold" style={{ color: GOLD }}>
                解析到 {pending.waves.length} 个波形（{pending.source === 'combined' ? '设计器曲线' : '脉冲帧'}），确认导入？
              </p>
              <div className="mt-2 max-h-24 overflow-y-auto space-y-1">
                {pending.waves.slice(0, 40).map(w => (
                  <div key={w.id} className="flex items-center justify-between text-[11px] text-white/55">
                    <span className="truncate">{w.name}{w.nameEn ? ` / ${w.nameEn}` : ''}</span>
                    <span className="text-white/30 shrink-0 ml-2">{w.frames ? `${w.frames.length}帧` : `${w.points?.p1?.length ?? 0}点`}</span>
                  </div>
                ))}
                {pending.waves.length > 40 && <p className="text-[10px] text-white/35">…等 {pending.waves.length} 个</p>}
              </div>
              <div className="mt-2.5 flex items-center justify-end gap-2">
                <button onClick={() => setPending(null)} className="rounded-lg bg-white/10 hover:bg-white/15 px-3 py-1.5 text-xs text-white/70">取消</button>
                <button
                  onClick={confirmImport}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold text-black"
                  style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}
                >
                  确认导入
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {waves.length === 0 ? (
        <p className="text-[11px] text-white/30 py-1 text-center">波形库为空 · 导入后可直接在上方「脉冲波形」选择</p>
      ) : (
        <div className="max-h-40 overflow-y-auto space-y-1.5">
          {waves.map(w => (
            <div key={w.id} className="flex items-center gap-2 rounded-lg bg-white/[0.04] border border-white/[0.06] px-2.5 py-1.5">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: w.source === 'combined' ? GOLD : '#60a5fa' }} />
              <span className="text-xs text-white/75 truncate min-w-0 flex-1">{w.name}</span>
              <span className="text-[10px] text-white/35 shrink-0">{w.source === 'combined' ? '设计器' : `${w.frames?.length ?? 0}帧`}</span>
              <button onClick={() => { removeWave(w.id); onChanged(); showToast(`已删除波形「${w.name}」`, 'info') }} className="p-1 rounded hover:bg-white/10 text-white/35 hover:text-red-400 transition-colors shrink-0" title="删除">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {waves.length > 0 && (
        <button
          onClick={() => {
            const txt = exportWavesAsTxt(waves.filter(w => w.source === 'combined'))
            const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `waveforge-waves-${Date.now()}.txt`
            a.click()
            URL.revokeObjectURL(url)
            showToast('已导出整合波形 txt（可在 DG-Lab App 波形导入中使用）', 'success')
          }}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/50 hover:bg-white/[0.1] transition-colors w-full"
        >
          <Download className="w-3 h-3" />
          导出全部设计器波形（回导 App）
        </button>
      )}
    </div>
  )
}

/* ------------------------------ 复制工具 ------------------------------ */

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (error) {
    console.warn('[DG-LAB 复制] navigator.clipboard 失败，走回退:', error)
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch (error) {
    console.warn('[DG-LAB 复制] execCommand 失败:', error)
    return false
  }
}

/* ------------------------------ 控制台主体 ------------------------------ */

/** 上限过高警告：以当前客户端一次启动为生命周期（弹过一次本实例不再弹，重启软件可再次触发）。 */
let capWarningShownThisSession = false

export default function DGLabConsoleModal() {
  const { dglabConsoleOpen } = usePluginHostState()
  const status = useDGLabStatus()
  const client = getDGLabClient()
  const [settings, setSettings] = useState<DGLabSettings>(() => loadDGLabSettings())
  const [waves, setWaves] = useState<WaveDef[]>(() => getWaveLibrary())
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [qrZoomOpen, setQrZoomOpen] = useState(false)
  const [logModalOpen, setLogModalOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [connExpanded, setConnExpanded] = useState(false)
  const [wavePanelOpen, setWavePanelOpen] = useState(false)
  const [lockCaps, setLockCaps] = useState(false)
  const [widgetVisible, setWidgetVisible] = useState(() => isDGLabWidgetVisible())
  const [capWarnOpen, setCapWarnOpen] = useState(false)
  const [vizMode, setVizMode] = useState<DGLabVizModeId>('envelope')

  useTvBack(() => {
    if (capWarnOpen) { setCapWarnOpen(false); return true }
    if (guideOpen) { setGuideOpen(false); return true }
    if (qrZoomOpen) { setQrZoomOpen(false); return true }
    if (logModalOpen) { setLogModalOpen(false); return true }
    if (dglabConsoleOpen) { closeDGLabConsole(); return true }
    return false
  }, [dglabConsoleOpen, qrZoomOpen, logModalOpen, guideOpen, capWarnOpen])

  // 波形库变化刷新
  useEffect(() => {
    const handler = () => setWaves(getWaveLibrary())
    window.addEventListener(DGLAB_WAVES_EVENT, handler)
    return () => window.removeEventListener(DGLAB_WAVES_EVENT, handler)
  }, [])

  // 常驻开关变化（小组件内 × 关闭后按钮同步）
  useEffect(() => {
    const onWidget = () => setWidgetVisible(isDGLabWidgetVisible())
    window.addEventListener(DGLAB_WIDGET_EVENT, onWidget)
    return () => window.removeEventListener(DGLAB_WIDGET_EVENT, onWidget)
  }, [])

  // 设置变更（自动钳位/外部修改）→ 重读
  useEffect(() => {
    const onSettings = () => setSettings(loadDGLabSettings())
    window.addEventListener(DGLAB_SETTINGS_EVENT, onSettings)
    return () => window.removeEventListener(DGLAB_SETTINGS_EVENT, onSettings)
  }, [])

  // 设置变化 → 持久化 + 通知中继
  const update = (patch: Partial<DGLabSettings>) => {
    const next = saveDGLabSettings(patch)
    setSettings(next)
    client.setSettings(patch)
    // 上限 >100 警告（当前软件一次启动仅弹一次）
    if ((next.caps.A > 100 || next.caps.B > 100) && !capWarningShownThisSession) {
      capWarningShownThisSession = true
      setCapWarnOpen(true)
    }
  }

  const updateCaps = (channel: 'A' | 'B', value: number) => {
    if (lockCaps) {
      // 🔗 联动：调 A 时 B 一起设置同一上限
      update({ caps: { A: value, B: value } })
    } else {
      update({ caps: { ...settings.caps, [channel]: value } })
    }
  }

  // 二维码
  useEffect(() => {
    let cancelled = false
    const qrContent = settings.version === 'v3' ? status.qrV3 : status.qrV4
    if (!qrContent) {
      setQrDataUrl(null)
      return
    }
    void client.getQR(qrContent).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.version, status.qrV3, status.qrV4, status.ips])

  // 扫码连接成功后自动关闭放大的二维码，更人性化
  useEffect(() => {
    if (status.state === 'bound' && qrZoomOpen) setQrZoomOpen(false)
  }, [status.state, qrZoomOpen])

  // 选中波形 → 解析为设备帧随设置下发（瞬时字段）；官方内置波形同样走帧下发
  useEffect(() => {
    const waveId = settings.waveId
    const builtin = ['continuous', 'breath', 'tide', 'beat', 'dglab-sweep'].includes(waveId)
    if (builtin) {
      client.sendWaveFrames(null)
      return
    }
    const allWaves = [...OFFICIAL_BUILTIN_WAVES, ...waves]
    const wave = allWaves.find(w => w.id === waveId)
    if (!wave) return
    const frames = wave.source === 'pulse' ? wave.frames : resampleDesignerWave(wave, settings.waveFreq)
    client.sendWaveFrames(frames ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.waveId, settings.waveFreq, waves])

  // 打开控制台时把记住的设置同步给中继
  useEffect(() => {
    if (dglabConsoleOpen) client.updateSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dglabConsoleOpen])

  if (!dglabConsoleOpen) return null

  const address = settings.version === 'v3' ? status.urlV3 : status.urlV4
  const badge = {
    idle: { text: '待启动', color: '#64748b' },
    waiting: { text: '等待扫码', color: GOLD },
    bound: { text: `已连接${status.deviceName ? ` · ${status.deviceName}` : ''}`, color: '#34d399' },
    unavailable: { text: '服务不可用（请用桌面版）', color: '#ef4444' },
  }[status.state] ?? { text: status.state, color: '#94a3b8' }

  const isBuiltinWave = ['continuous', 'breath', 'tide', 'beat', 'dglab-sweep'].includes(settings.waveId)
  const stepPresetValue = settings.stepPreset === 'custom' ? settings.stepLimit : ({ strong: 30, medium: 12, weak: 5 }[settings.stepPreset] ?? 5)

  const copyAddress = async () => {
    const ok = await copyText(address)
    if (ok) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
      showToast('地址已复制至剪贴板', 'success')
    } else {
      showToast('复制失败，请长按地址手动复制', 'error', 4000)
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[95] flex items-center justify-center p-6"
        style={{ backgroundColor: 'rgba(2,2,4,0.82)', backdropFilter: 'blur(16px)' }}
        data-tv-scope
        onClick={closeDGLabConsole}
      >
        <motion.div
          initial={{ scale: 0.94, y: 16, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.94, y: 16, opacity: 0 }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-7xl h-[min(92vh,780px)] rounded-[28px] overflow-hidden flex flex-col border shadow-2xl"
          style={{
            background: `linear-gradient(160deg, ${BLACK} 0%, #0d0c09 55%, #17120a 100%)`,
            borderColor: 'rgba(255,232,156,0.25)',
            boxShadow: '0 30px 90px rgba(0,0,0,0.7), 0 0 60px rgba(255,232,156,0.07)',
          }}
        >
          {/* 顶栏：Logo+标题｜日志·说明·状态·关闭（次要入口全部收纳在这里） */}
          <div className="flex items-center justify-between px-6 pt-4 pb-3 border-b shrink-0" style={{ borderColor: 'rgba(255,232,156,0.12)' }}>
            <div className="flex items-center gap-3">
              <img src={DGLAB_LOGO} alt="DG-LAB" className="w-9 h-9 rounded-xl object-contain bg-white/90 p-0.5" draggable={false} />
              <div>
                <h2 className="text-lg font-bold text-white tracking-tight">DG-LAB</h2>
                <p className="text-[11px]" style={{ color: `${GOLD}88` }}>音乐体感 · 7 种风格 · 左右立体声</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(settings.systemCapture)}
                onClick={() => update({ systemCapture: !settings.systemCapture })}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium border transition-colors ${
                  settings.systemCapture
                    ? 'text-black border-transparent'
                    : 'bg-white/[0.06] border-white/10 text-white/60 hover:bg-white/[0.12]'
                }`}
                style={settings.systemCapture ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}
                title="整机监听：监听系统扬声器（不限本软件）。桌面版直抓系统音频；浏览器需在共享框勾选系统音频。"
              >
                <RadioTower className="w-3.5 h-3.5" />
                整机
                <span className={`w-1.5 h-1.5 rounded-full ${settings.systemCapture ? 'bg-black/70' : 'bg-white/35'}`} />
              </button>
              <button
                onClick={() => setLogModalOpen(true)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-white/60 hover:bg-white/10 transition-colors"
                title="调试日志"
              >
                <ScrollText className="w-3.5 h-3.5" />日志
              </button>
              <button
                onClick={() => setGuideOpen(true)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-white/60 hover:bg-white/10 transition-colors"
                title="使用说明"
              >
                <BookOpen className="w-3.5 h-3.5" />说明
              </button>
              <span className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium border"
                style={{ color: badge.color, borderColor: `${badge.color}44`, background: `${badge.color}14` }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: badge.color, boxShadow: status.state === 'bound' ? `0 0 8px ${badge.color}` : 'none' }} />
                {badge.text}
              </span>
              <button onClick={closeDGLabConsole} className="p-2 rounded-xl hover:bg-white/10 transition-colors" aria-label="关闭">
                <X className="w-5 h-5 text-white/70" />
              </button>
            </div>
          </div>

          {/* 主体三栏：实时波形+脉冲（左）｜连接+风格（中）｜映射控制（右） */}
          <div className="flex-1 overflow-y-auto plugin-center-scroll">
            <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr_1.1fr] gap-5 p-5">
              {/* 左栏：实时波形（主导）+ 脉冲波形（可选·折叠） */}
              <div className="space-y-4">
                {/* 实时波形主导（加高 + 可视化模式：包络/频谱） */}
                <section className="rounded-2xl p-4 border" style={{ background: PANEL, borderColor: BORDER }}>
                  <div className="flex items-center justify-between mb-3 gap-2">
                    <h3 className="text-sm font-bold text-white/85 flex items-center gap-2 shrink-0">
                      <span className="w-3.5 h-3.5 rounded-full" style={{ background: GOLD, boxShadow: `0 0 10px ${GOLD}88` }} />
                      实时波形（A/B）
                    </h3>
                    <div className="flex items-center gap-2">
                      <Segmented
                        options={[{ value: 'envelope', label: '包络' }, { value: 'spectrum', label: '频谱' }]}
                        value={vizMode}
                        onChange={(v) => setVizMode(v as DGLabVizModeId)}
                      />
                      <button
                        type="button"
                        onClick={() => setDGLabWidgetVisible(!widgetVisible)}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium border transition-colors ${
                          widgetVisible ? 'text-black border-transparent' : 'bg-white/[0.06] border-white/10 text-white/55 hover:bg-white/[0.12]'
                        }`}
                        style={widgetVisible ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}
                        title="左上角常驻悬浮小组件"
                      >
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: widgetVisible ? '#000' : 'rgba(255,255,255,0.4)' }} />
                        波形常驻
                        <HelpInfo id="widget" />
                      </button>
                    </div>
                  </div>
                  <DGLabVizCanvas status={status} height={300} mode={vizMode} />
                  {status.deviceStrength && (
                    <p className="mt-2 text-[10px] text-white/40">
                      App 实际强度：A <b style={{ color: GOLD }}>{status.deviceStrength.A}</b> · B <b style={{ color: GOLD }}>{status.deviceStrength.B}</b>
                      {status.softLimit && <span> · App 硬上限 A {status.softLimit.A} / B {status.softLimit.B}</span>}
                    </p>
                  )}
                </section>

                {/* 脉冲波形 & 波形库（官方 App 波形预设的形态 · 可选；主机制是「体感风格」实时映射） */}
                <section className="rounded-2xl border" style={{ background: PANEL, borderColor: BORDER }}>
                  <button
                    type="button"
                    onClick={() => setWavePanelOpen(v => !v)}
                    className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left hover:bg-white/[0.04] transition-colors rounded-2xl"
                  >
                    <Zap className="w-4 h-4" style={{ color: GOLD }} />
                    <span className="text-sm font-medium text-white/75">脉冲波形 & 波形库</span>
                    <span className="text-[10px] text-white/30">（官方 App 波形预设 · 节拍脉冲用）</span>
                    <ChevronDown className={`w-4 h-4 ml-auto text-white/45 transition-transform ${wavePanelOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {wavePanelOpen && (
                    <div className="px-4 pb-4 space-y-4">
                      <div className="pt-1">
                        <WavePicker waves={waves} officialWaves={OFFICIAL_BUILTIN_WAVES} selected={settings.waveId} onSelect={(id) => update({ waveId: id })} />
                        {isBuiltinWave && (
                          <div className="mt-3 border-t pt-3" style={{ borderColor: 'rgba(255,232,156,0.12)' }}>
                            <p className="text-[10px] leading-relaxed text-white/35 mb-2">
                              下面两个只是「内置基波」的目标值：频率 = 每拍敲击的基础频率（Hz），强度 = 目标强度。实际脉冲每拍只叠加一小段并逐帧衰减，且最终 <b className="text-amber-100/70">不会超过你的 A/B 强度上限</b>（调再高也按上限截断）。
                            </p>
                            <div className="grid grid-cols-2 gap-3">
                              <SliderRow label="基础频率 Hz" value={settings.waveFreq} min={1} max={120} step={1} onChange={(v) => update({ waveFreq: v })} helpId="waveFreq" />
                              <SliderRow label="目标强度" value={settings.waveStrength} min={20} max={200} step={1} onChange={(v) => update({ waveStrength: v })} helpId="waveStrength" />
                            </div>
                          </div>
                        )}
                      </div>
                      <WaveLibrary waves={waves} onChanged={() => setWaves(getWaveLibrary())} />
                    </div>
                  )}
                </section>
              </div>

              {/* 中栏：连接设置（顶部）+ 体感风格 */}
              <div className="space-y-4">
                {/* 连接设置（放到体感风格上面；已连接时折叠为状态条） */}
                <section className="rounded-2xl border" style={{ background: PANEL, borderColor: BORDER }}>
                  {status.state === 'bound' && !connExpanded ? (
                    <button
                      type="button"
                      onClick={() => setConnExpanded(true)}
                      className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-white/[0.04] transition-colors rounded-2xl"
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: '#34d399', boxShadow: '0 0 8px #34d399' }} />
                      <span className="text-sm font-medium text-white/90">已连接 · {status.deviceName ?? 'DG-Lab'}</span>
                      <span className="ml-auto text-[11px] text-white/45 flex items-center gap-1">
                        连接设置
                        <ChevronRight className="w-3.5 h-3.5" />
                      </span>
                    </button>
                  ) : (
                    <div className="p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-bold text-white/85 flex items-center gap-2">
                          <Plug className="w-4 h-4" style={{ color: GOLD }} />
                          连接设置
                        </h3>
                        <div className="flex items-center gap-2">
                          <Segmented
                            options={[{ value: 'v3', label: '3.0' }, { value: 'v4', label: '4.0' }]}
                            value={settings.version}
                            onChange={(v) => update({ version: v })}
                          />
                          {status.state === 'bound' && (
                            <button onClick={() => setConnExpanded(false)} className="p-1.5 rounded-lg hover:bg-white/10 text-white/50 transition-colors" title="收起连接设置">
                              <ChevronDown className="w-4 h-4 rotate-180" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="shrink-0 flex flex-col items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setQrZoomOpen(true)}
                            className="w-[124px] h-[124px] rounded-xl border flex items-center justify-center overflow-hidden cursor-zoom-in transition-transform hover:scale-[1.03]"
                            style={{ background: '#fff', borderColor: BORDER }}
                            title="点击放大二维码"
                          >
                            {qrDataUrl ? (
                              <img src={qrDataUrl} alt="DG-LAB 连接二维码" className="w-full h-full object-contain" />
                            ) : (
                              <div className="text-center px-2">
                                <QrCode className="w-6 h-6 text-black/40 mx-auto" />
                                <p className="mt-1 text-[9px] text-black/50">App 内<br />Socket 控制扫码</p>
                              </div>
                            )}
                          </button>
                          <button
                            onClick={() => void client.control(status.running ? 'stop' : 'start')}
                            className="w-full flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium border transition-colors"
                            style={{
                              background: status.running ? 'rgba(239,68,68,0.12)' : 'rgba(255,232,156,0.12)',
                              borderColor: status.running ? 'rgba(239,68,68,0.35)' : 'rgba(255,232,156,0.35)',
                              color: status.running ? '#f87171' : GOLD,
                            }}
                          >
                            {status.running ? <Power className="w-3 h-3" /> : <PlugZap className="w-3 h-3" />}
                            {status.running ? '停止中继' : '启动中继'}
                          </button>
                        </div>
                        <div className="flex-1 min-w-0 space-y-2.5">
                          <button
                            onClick={() => void copyAddress()}
                            className="w-full flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors border"
                            style={{ background: 'rgba(255,232,156,0.08)', borderColor: 'rgba(255,232,156,0.3)', color: '#FFEEDD' }}
                            title={address || '—'}
                          >
                            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                            {copied ? '已复制' : '复制二维码地址'}
                          </button>
                          <div>
                            <span className="text-xs text-white/50 block mb-1">网卡 <HelpInfo id="address" /></span>
                            <IpSelect ips={status.ips} selected={settings.address} onSelect={(addr) => update({ address: addr })} />
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-white/50 w-12 shrink-0">端口 <HelpInfo id="port" /></span>
                            <input
                              type="number"
                              min={1024}
                              max={65535}
                              value={settings.port}
                              onChange={(e) => update({ port: Number(e.target.value) || DEFAULT_DGLAB_SETTINGS.port })}
                              className="no-spinner flex-1 rounded-lg bg-black/40 border border-white/10 px-2.5 py-1.5 text-xs text-white/80 focus:outline-none"
                              style={{ borderColor: 'rgba(255,232,156,0.25)' }}
                            />
                          </div>
                          <p className="text-[10px] text-white/30 leading-snug">① 手机 App 蓝牙连好设备、连同一 WiFi<br />② App「Socket 控制/扫码连接」扫上方码</p>
                        </div>
                      </div>
                    </div>
                  )}
                </section>

                <section className="rounded-2xl p-4 border" style={{ background: PANEL, borderColor: BORDER }}>
                  <h3 className="text-sm font-bold text-white/85 flex items-center gap-2 mb-2.5">
                    <AudioWaveform className="w-4 h-4" style={{ color: GOLD }} />
                    体感风格
                    <HelpInfo id="feelStyle" />
                  </h3>
                  <div className="grid grid-cols-2 gap-1.5">
                    {STYLE_OPTIONS.map(opt => {
                      const active = settings.feelStyle === opt.value
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => update({ feelStyle: opt.value })}
                          className={`rounded-xl px-2.5 py-2 text-left border transition-all ${active ? '' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.08]'}`}
                          style={active ? { borderColor: `${GOLD}99`, background: 'rgba(255,232,156,0.1)', boxShadow: `0 0 0 1px ${GOLD}44` } : undefined}
                        >
                          <span className="block text-[13px] font-medium text-white/85">{opt.label}</span>
                          <span className={`block text-[10px] mt-0.5 ${active ? 'text-amber-100/80' : 'text-white/35'}`}>{opt.desc}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>

                </div>

              {/* 右栏：映射控制（放到原本「脉冲波形卡片」那边，核心设置一屏可见、无需滚动） */}
              <div className="space-y-4">
                <section className="rounded-2xl p-4 border space-y-3.5" style={{ background: PANEL, borderColor: BORDER }}>
                  <h3 className="text-sm font-bold text-white/85">映射控制</h3>
                  <SliderRow label="灵敏度" value={settings.sensitivity} min={0.1} max={3} step={0.1} onChange={(v) => update({ sensitivity: v })} helpId="sensitivity" />
                  <SliderRow label="平滑" value={settings.smoothing} min={0} max={1} step={0.05} onChange={(v) => update({ smoothing: v })} helpId="smoothing" />
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/45 flex items-center gap-1">强度差（体质档）<HelpInfo id="stepPreset" /></span>
                      <span className="text-xs font-semibold" style={{ color: GOLD }}>{stepPresetValue}</span>
                    </div>
                    <div className="mt-1.5">
                      <Segmented options={STEP_OPTIONS} value={settings.stepPreset} onChange={(v) => update({ stepPreset: v })} />
                    </div>
                  </div>
                  {settings.stepPreset === 'custom' && (
                    <SliderRow label="自定义强度差" value={settings.stepLimit} min={1} max={60} step={1} onChange={(v) => update({ stepLimit: v })} />
                  )}
                  <div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/45 flex items-center gap-1">恢复适应时间<HelpInfo id="rampPreset" /></span>
                    </div>
                    <div className="mt-1.5">
                      <Segmented options={RAMP_OPTIONS} value={settings.rampPreset} onChange={(v) => update({ rampPreset: v })} />
                    </div>
                  </div>
                  <ToggleRow label="自动适配轻响" desc="根据歌曲轻重自动分配强度" checked={settings.dynamicRange} onChange={(v) => update({ dynamicRange: v })} />

                  {/* 实时映射（官方实时音频参数体系） */}
                  <div className="border-t pt-3 space-y-3" style={{ borderColor: 'rgba(255,232,156,0.1)' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white/80 flex items-center gap-1">实时映射（官方实时）<HelpInfo id="rtMode" /></span>
                      <Segmented
                        options={[{ value: 'auto', label: '自适应' }, { value: 'manual', label: '自定义' }]}
                        value={settings.rtMode}
                        onChange={(v) => update({ rtMode: v })}
                      />
                    </div>
                    {/* 自适应也显示 范围/高/低适应系数；数据增益/迟滞仅自定义 */}
                    {settings.rtMode === 'manual' && (
                      <SliderRow label="数据增益" value={settings.rtGain} min={0.1} max={3} step={0.05} onChange={(v) => update({ rtGain: v })} helpId="rtGain" />
                    )}
                    <SliderRow label="范围" value={settings.rtRange} min={0.05} max={1.5} step={0.05} onChange={(v) => update({ rtRange: v })} helpId="rtRange" />
                    <SliderRow label="高适应系数" value={settings.rtHigh} min={0.01} max={1} step={0.01} onChange={(v) => update({ rtHigh: v })} helpId="rtHigh" />
                    <SliderRow label="低适应系数" value={settings.rtLow} min={0.01} max={1} step={0.01} onChange={(v) => update({ rtLow: v })} helpId="rtLow" />
                    {settings.rtMode === 'manual' && (
                      <SliderRow label="迟滞系数" value={settings.rtHys} min={0} max={0.3} step={0.01} onChange={(v) => update({ rtHys: v })} helpId="rtHys" />
                    )}
                    <div>
                      <span className="text-xs text-white/45 flex items-center gap-1">观察频段 <HelpInfo id="rtBand" /></span>
                      <div className="mt-1.5">
                        <Segmented
                          options={[{ value: 'all', label: '全部' }, { value: 'low', label: '低频' }, { value: 'mid', label: '中频' }, { value: 'high', label: '高频' }, { value: 'stereo', label: '左右' }]}
                          value={settings.rtBand}
                          onChange={(v) => update({ rtBand: v })}
                        />
                      </div>
                    </div>
                    <div>
                      <span className="text-xs text-white/45 flex items-center gap-1">频率映射 <HelpInfo id="rtFreqMap" /></span>
                      <div className="mt-1.5">
                        <Segmented
                          options={[{ value: 'linear', label: '线性' }, { value: 'log', label: '对数' }, { value: 'deep', label: '深沉' }, { value: 'bright', label: '明亮' }]}
                          value={settings.rtFreqMap}
                          onChange={(v) => update({ rtFreqMap: v })}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-xs text-white/45">强度上限（0-200，App 硬上限会自动钳位）</span>
                    <button
                      type="button"
                      onClick={() => setLockCaps(v => !v)}
                      title={lockCaps ? '联动已开启：调 A 时 B 同步设置' : '点击开启联动：调 A 时 B 同步设置'}
                      className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] border transition-colors ${
                        lockCaps ? 'text-black border-transparent' : 'bg-white/[0.06] border-white/10 text-white/55 hover:bg-white/[0.12]'
                      }`}
                      style={lockCaps ? { background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` } : undefined}
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      {lockCaps ? '已联动' : '联动设置'}
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <SliderRow label="A 上限" value={settings.caps.A} min={0} max={200} step={1} onChange={(v) => updateCaps('A', v)} helpId="capsA" />
                    <SliderRow label="B 上限" value={settings.caps.B} min={0} max={200} step={1} onChange={(v) => updateCaps('B', v)} helpId="capsB" />
                  </div>
                  <ToggleRow label="节拍脉冲" desc="重音/鼓点叠加短促脉冲" checked={settings.pulseEnabled} onChange={(v) => update({ pulseEnabled: v })} />
                  <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2 text-[11px] leading-relaxed text-white/45">
                    生效上限：A ≤ {Math.min(settings.caps.A, status.softLimit?.A ?? 200)} · B ≤ {Math.min(settings.caps.B, status.softLimit?.B ?? 200)}
                    {status.softLimit && <span style={{ color: `${GOLD}AA` }}>（含 App 硬上限）</span>}
                  </div>
                </section>
              </div>
            </div>
          </div>

          {/* 底部安全警示 */}
          <div className="shrink-0 px-6 py-3 border-t flex items-start gap-2.5" style={{ borderColor: 'rgba(255,232,156,0.12)', background: 'rgba(255,232,156,0.04)' }}>
            <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" style={{ color: GOLD }} />
            <p className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,238,221,0.75)' }}>
              <b style={{ color: GOLD }}>严禁</b>将贴片或其他配件用于上半身的任何地方（耻骨区之上）。谨慎设置强度上限；如有不适立即暂停（播放页「波形输出」按钮可一键停）。本插件仅供娱乐，一切风险与后果需自行承担。
            </p>
          </div>
        </motion.div>

        {/* 二维码放大 */}
        <AnimatePresence>
          {qrZoomOpen && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[97] flex items-center justify-center p-6"
              style={{ backgroundColor: 'rgba(2,2,4,0.85)' }}
              data-tv-scope
              onClick={(e) => { e.stopPropagation(); setQrZoomOpen(false) }}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.9, opacity: 0 }}
                transition={{ type: 'spring', damping: 24, stiffness: 320 }}
                onClick={(e) => e.stopPropagation()}
                className="relative rounded-3xl p-5 shadow-2xl" style={{ background: '#fff' }}
              >
                <button
                  onClick={() => setQrZoomOpen(false)}
                  className="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-black/85 text-white flex items-center justify-center shadow-lg hover:bg-black transition-colors"
                  aria-label="关闭放大二维码"
                >
                  <X className="w-4 h-4" />
                </button>
                {qrDataUrl ? <img src={qrDataUrl} alt="DG-LAB 连接二维码（放大）" className="w-72 h-72 object-contain" draggable={false} /> : (
                  <div className="w-72 h-72 flex items-center justify-center text-black/45 text-sm">二维码生成中…</div>
                )}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 调试日志弹窗 */}
        <AnimatePresence>
          {logModalOpen && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[97] flex items-center justify-center p-6"
              style={{ backgroundColor: 'rgba(2,2,4,0.8)', backdropFilter: 'blur(8px)' }}
              data-tv-scope
              onClick={(e) => { e.stopPropagation(); setLogModalOpen(false) }}
            >
              <motion.div
                initial={{ scale: 0.94, y: 12, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.94, y: 12, opacity: 0 }}
                transition={{ type: 'spring', damping: 26, stiffness: 320 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-xl h-[min(80vh,560px)] rounded-3xl border flex flex-col overflow-hidden shadow-2xl"
                style={{ background: 'linear-gradient(160deg, #0d0d10 0%, #14110a 100%)', borderColor: 'rgba(255,232,156,0.22)' }}
              >
                <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: 'rgba(255,232,156,0.12)' }}>
                  <div className="flex items-center gap-2.5">
                    <ScrollText className="w-4 h-4" style={{ color: GOLD }} />
                    <h3 className="text-sm font-bold text-white">调试日志</h3>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/[0.07] text-white/45">{status.logs.length} 条</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => {
                        void copyText(status.logs.join('\n')).then((ok) => {
                          showToast(ok ? '全部日志已复制至剪贴板' : '复制失败，请手动选择复制', ok ? 'success' : 'error')
                        })
                      }}
                      className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] transition-colors hover:bg-white/10"
                      style={{ color: `${GOLD}DD` }}
                      title="复制全部日志"
                    >
                      <Copy className="w-3 h-3" />复制全部
                    </button>
                    <button onClick={() => setLogModalOpen(false)} className="p-2 rounded-lg hover:bg-white/10 transition-colors" aria-label="关闭调试日志">
                      <X className="w-4 h-4 text-white/60" />
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-1 bg-black/40 plugin-log-select">
                  {status.logs.slice().reverse().map((line, index) => (
                    <p key={index} className="text-[11px] font-mono leading-snug break-all" style={{ color: 'rgba(110,231,183,0.7)' }}>{line}</p>
                  ))}
                  {status.logs.length === 0 && <p className="text-[11px] text-white/30">暂无日志（中继启动后输出；设置「开发者模式」可看详细帧日志）</p>}
                </div>
                <div className="px-6 py-3 border-t shrink-0 text-[10px] text-white/35" style={{ borderColor: 'rgba(255,232,156,0.1)' }}>
                  最新在最上 · 设置页开启「开发者模式」后显示详细帧/下发日志
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 使用说明 */}
        <DGLabGuideModal open={guideOpen} onClose={() => setGuideOpen(false)} />

        {/* 上限过高警告（当前软件启动一次） */}
        <AnimatePresence>
          {capWarnOpen && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[98] flex items-center justify-center p-6"
              style={{ backgroundColor: 'rgba(2,2,4,0.86)', backdropFilter: 'blur(8px)' }}
              data-tv-scope
              onClick={(e) => { e.stopPropagation(); setCapWarnOpen(false) }}
            >
              <motion.div
                initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.92, opacity: 0 }}
                transition={{ type: 'spring', damping: 24, stiffness: 320 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md rounded-3xl border p-6 shadow-2xl"
                style={{ background: 'linear-gradient(160deg, #12100a 0%, #0d0d10 100%)', borderColor: 'rgba(255,232,156,0.35)' }}
              >
                <div className="flex items-center gap-2.5 mb-3">
                  <TriangleAlert className="w-5 h-5 shrink-0" style={{ color: GOLD }} />
                  <h3 className="text-base font-bold text-white">上限过高提醒</h3>
                </div>
                <p className="text-[13px] leading-relaxed text-white/75">
                  上限调至 <b style={{ color: GOLD }}>100 以上</b>时，强度可能过高，<b className="text-white">可能会导致意外</b>。
                </p>
                <p className="mt-2.5 text-[13px] leading-relaxed text-white/65">
                  请根据<b className="text-white">自身体质</b>进行调整（「强度差」选弱体质更柔和），<b style={{ color: GOLD }}>切勿拉满至上限</b>。
                </p>
                <p className="mt-2 text-[11px] text-white/40">本提醒在当前软件启动期间只提示一次，重启软件后可再次提示。</p>
                <div className="mt-5 flex items-center justify-end gap-3">
                  <button onClick={() => setCapWarnOpen(false)} className="rounded-xl px-5 py-2 text-sm font-semibold text-black" style={{ background: `linear-gradient(135deg,${GOLD},${GOLD_DEEP})` }}>
                    我知道了
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </AnimatePresence>
  )
}