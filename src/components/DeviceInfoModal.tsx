/**
 * TV 端设备配置检查 + 性能模式选择（设置 → 高级 → 顶部「配置检查」）。
 *
 * 上半部分列出设备真实信息（原生桥 getDeviceInfo：内存/存储/CPU/型号；
 * 浏览器调试时用 navigator 兜底），下半部分为三档性能模式选择（效能/普通/增强）。
 */
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTvBack } from '../tv/tvCore'
import { X, Cpu, MemoryStick, HardDrive, MonitorSmartphone, Gauge } from 'lucide-react'
import { getPerfMode, setPerfMode, type PerfMode } from '../tv/perfMode'

interface DeviceInfo {
  model?: string
  manufacturer?: string
  androidVersion?: string
  buildDisplay?: string
  apiLevel?: number
  screenPx?: string
  density?: string
  densityDpi?: number
  webViewVersion?: string
  totalMem?: number
  availMem?: number
  heapMax?: number
  storageTotal?: number
  storageFree?: number
  cpuCores?: number
  cpuTempC?: number
  batteryPercent?: number
  batteryCharging?: boolean
}

function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '—'
  const gb = n / 1024 / 1024 / 1024
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  return `${Math.round(n / 1024 / 1024)} MB`
}

const MODES: Array<{ value: PerfMode; label: string; desc: string }> = [
  {
    value: 'efficiency',
    label: '效能模式',
    desc: 'TV 弱机首选：停掉昂贵的动态背景动画，隐藏桌面模式，缓存最小档，关闭音频可视化',
  },
  {
    value: 'normal',
    label: '普通模式',
    desc: '平衡之选：保留基础过渡，停掉最贵的无限背景动画，桌面模式显示，缓存中档',
  },
  {
    value: 'enhanced',
    label: '增强模式',
    desc: '接近 PC 全开：动画全开，桌面模式显示，缓存高档（内存/存储占用更大）',
  },
]

interface DeviceInfoModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'dark' | 'light'
}

export default function DeviceInfoModal({ show, onClose, playerTheme = 'dark' }: DeviceInfoModalProps) {
  const isDark = playerTheme === 'dark'
  const textPrimary = isDark ? 'text-white' : 'text-black'
  const textSecondary = isDark ? 'text-white/60' : 'text-black/60'
  const textTertiary = isDark ? 'text-white/40' : 'text-black/40'
  const bgCard = isDark ? 'bg-white/5' : 'bg-black/5'
  const borderColor = isDark ? 'border-white/10' : 'border-black/10'
  const accent = localStorage.getItem('accentColor') || '#3B82F6'

  // TV 遥控器 BACK 关闭弹窗（带 show 守卫：本组件经 SettingsPanel 常驻挂载，无守卫会吞掉全场景 BACK 键）
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  })

  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const [perfMode, setPerfModeState] = useState<PerfMode>(getPerfMode())

  useEffect(() => {
    if (!show) return
    setPerfModeState(getPerfMode())
    const native = (window as any).WaveForgeNative
    if (native?.getDeviceInfo) {
      try {
        setInfo(JSON.parse(String(native.getDeviceInfo())))
      } catch {
        setInfo(null)
      }
    } else {
      // 浏览器调试：navigator 兜底
      const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory
      const mem = (performance as unknown as { memory?: { jsHeapSizeLimit?: number } }).memory
      setInfo({
        model: navigator.platform || '浏览器',
        apiLevel: 0,
        totalMem: dm ? dm * 1024 * 1024 * 1024 : undefined,
        heapMax: mem?.jsHeapSizeLimit,
        cpuCores: navigator.hardwareConcurrency,
      })
    }
  }, [show])

  const rows: Array<[string, string]> = [
    ['设备', info?.model ? `${info.manufacturer || ''} ${info.model}`.trim() : '检测中…'],
    ['Android 版本', info?.androidVersion ? `Android ${info.androidVersion}（API ${info.apiLevel ?? '?'}）` : info?.apiLevel ? `API ${info.apiLevel}` : '—'],
    ['系统版本', info?.buildDisplay || '—'],
    ['屏幕分辨率', info?.screenPx || '—'],
    ['屏幕密度', info?.density ? `${info.density}（${info.densityDpi ?? '?'} dpi）` : '—'],
    ['WebView 版本', info?.webViewVersion || '—'],
    ['页面视口', `${window.innerWidth}×${window.innerHeight}（DPR ${window.devicePixelRatio}）`],
    ['页面缩放', `${(document.documentElement.style as unknown as { zoom?: string }).zoom || '1'}`],
    ['内存总量', fmtBytes(info?.totalMem)],
    ['可用内存', fmtBytes(info?.availMem)],
    ['应用堆上限', fmtBytes(info?.heapMax)],
    ['存储总量', fmtBytes(info?.storageTotal)],
    ['可用存储', fmtBytes(info?.storageFree)],
    ['CPU 核心', info?.cpuCores ? `${info.cpuCores} 核` : '—'],
    ['CPU 温度', info?.cpuTempC && info.cpuTempC > 0 ? `${info.cpuTempC.toFixed(1)} ℃` : '—'],
    ['电池', info?.batteryPercent != null ? `${info.batteryPercent}%${info.batteryCharging ? '（充电中）' : ''}` : '—'],
  ]

  const handleMode = (m: PerfMode) => {
    setPerfMode(m)
    setPerfModeState(m)
    window.dispatchEvent(
      new CustomEvent('showToast', { detail: { message: `已切换到${MODES.find((x) => x.value === m)?.label || ''}`, type: 'success' } })
    )
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          data-tv-scope
          className="fixed inset-0 z-[9990] flex items-center justify-center p-4"
          style={{ backgroundColor: isDark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)' }}
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md max-h-[88vh] overflow-y-auto rounded-3xl border p-6 shadow-2xl"
            style={{
              background: isDark ? 'rgba(14,17,24,0.94)' : 'rgba(255,255,255,0.95)',
              borderColor: borderColor,
            }}
          >
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ backgroundColor: `${accent}26`, color: accent }}>
                  <Gauge className="h-5 w-5" />
                </div>
                <h2 className={`text-lg font-bold ${textPrimary}`}>设备配置检查</h2>
              </div>
              <button onClick={onClose} className={`p-2 rounded-full transition-colors ${isDark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>

            {/* 设备信息 */}
            <div className={`rounded-2xl border ${borderColor} p-4 mb-5`}>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                {rows.map(([label, value]) => (
                  <div key={label}>
                    <div className={`text-xs ${textTertiary}`}>{label}</div>
                    <div className={`text-sm font-medium ${textPrimary} truncate`}>{value}</div>
                  </div>
                ))}
              </div>
              <p className={`text-xs ${textTertiary} mt-3 leading-5`}>
                TV 内存/存储/性能普遍弱于手机，建议根据本机配置选择下方模式（默认按内存自动选：&lt;3GB 效能，否则普通）。
              </p>
            </div>

            {/* 三档模式 */}
            <div className="space-y-3">
              {MODES.map((m) => {
                const active = perfMode === m.value
                return (
                  <button
                    key={m.value}
                    onClick={() => handleMode(m.value)}
                    className={`w-full rounded-2xl border p-4 text-left transition-all ${
                      active ? 'border-transparent' : `${borderColor} ${isDark ? 'hover:bg-white/5' : 'hover:bg-black/5'}`
                    }`}
                    style={
                      active
                        ? { backgroundColor: `${accent}1f`, borderColor: accent, boxShadow: `0 0 0 1px ${accent}66` }
                        : { backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)' }
                    }
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className={`text-sm font-bold ${textPrimary}`}>{m.label}</span>
                      {active && (
                        <span className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-white" style={{ backgroundColor: accent }}>
                          当前
                        </span>
                      )}
                    </div>
                    <p className={`text-xs leading-5 ${textSecondary}`}>{m.desc}</p>
                  </button>
                )
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
