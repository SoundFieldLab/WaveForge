import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, AudioLines, SlidersHorizontal, Music2, Music, Mic2, Headphones, Save, Copy, ClipboardPaste, Trash2, Info, FileAudio, Moon, Activity, Volume2, Sparkles, RotateCcw } from 'lucide-react'
import {
  AudioEffectsEngine,
  type AudioEffectsSettings,
  type DeepPartial,
  type EqMode,
  type SceneSnapshot,
  type ReverbType,
  SIMPLE_EQ_BANDS,
  PRO_EQ_FREQUENCIES,
  REVERB_TYPES,
} from '../services/audio-effects-v2/AudioEffectsEngine'
import { COMPENSATION_PRESETS } from '../services/audio-effects-v2/compensationService'
import { useTvBack } from '../tv/tvCore'

interface MixingStudioProps {
  engine: AudioEffectsEngine
  onClose: () => void
  playerTheme: 'dark' | 'light'
  sourceUrl?: string
  sourceDuration?: number
  /** 打开按钮的锚点位置（弹窗从按钮侧弹出/关闭时收缩回按钮） */
  anchorRect?: { x: number; y: number; width: number; height: number } | null
  /** 当前引擎版本 id（切换入口高亮当前按钮） */
  engineVersion?: string
  /** 请求切换引擎（App 负责热/冷切换与弹窗） */
  onSwitchEngine?: (version: string) => void
  /** 可用引擎列表（由适配层注册表动态提供，据此动态渲染版本按钮） */
  availableEngines?: Array<{ id: string; displayName: string; description: string }>
}

type Tab = 'effects' | 'eq' | 'tuner'

const PRESETS_KEY = 'waveforge:eq-presets'

interface EqPreset {
  id: string
  name: string
  mode: EqMode
  simpleBands: number[]
  proBands: { frequency: number; gain: number; q: number }[]
}

function loadPresets(): EqPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    return raw ? (JSON.parse(raw) as EqPreset[]) : []
  } catch {
    return []
  }
}

function savePresets(presets: EqPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets))
  } catch {
    // 忽略
  }
}

// 自定义频段：固定频率控制点（gain 可调），bands 缺失/为空时回退默认 5 段全 0
const CUSTOM_BAND_FREQUENCIES = [80, 250, 1000, 4000, 12000]
const defaultCustomBands = () => CUSTOM_BAND_FREQUENCIES.map(frequency => ({ frequency, gain: 0 }))
const resolveCustomBands = (bands?: { frequency: number; gain: number }[]): { frequency: number; gain: number }[] =>
  Array.isArray(bands) && bands.length > 0 ? bands : defaultCustomBands()

// 全部效果（可叠加，互斥时代已废弃；频响补偿与 EQ 的互斥由引擎强制）
const EFFECT_KEYS = ['hall', 'surround3d', 'bassBoost', 'vocalBoost', 'accompanimentBoost', 'compressor', 'nightMode'] as const
type EffectKey = (typeof EFFECT_KEYS)[number]

const EFFECT_META: Record<EffectKey, { name: string; desc: string; intro: string; icon: typeof Music2 }> = {
  hall: { name: '全景声厅', desc: '声场加宽 + 混响', intro: '通过中/侧声道加宽声场，并叠加卷积混响（支持大厅/房间/板式/弹簧/舞台五种类型），营造有纵深感的空间听感。', icon: AudioLines },
  surround3d: { name: '3D 环绕', desc: '耳机内环绕旋转', intro: '用 HRTF 双耳算法让声音在耳机内绕头旋转。可在圆形图上拖动圆点调整旋转角度与环绕距离，并设置旋转方向与速度。', icon: Headphones },
  bassBoost: { name: '低音增强', desc: '增强低频厚度与力度', intro: '通过低频搁架 + 次低频共振峰增强鼓点与贝斯的冲击力。深度控制起始频率，强度控制增强幅度。', icon: Music2 },
  vocalBoost: { name: '人声加强', desc: '提升人声存在感', intro: '聚焦 3kHz 人声存在感频段做窄带提升，并用中/侧分离适度增强中置人声，不会连带放大吉他等乐器。', icon: Mic2 },
  accompanimentBoost: { name: '伴奏加强', desc: '突出伴奏、削弱人声', intro: '通过中/侧分离增强侧声道（乐器/伴奏）并压低中置人声，让伴奏真正更突出，而不只是减弱人声。', icon: Music },
  compressor: { name: '动态压缩', desc: '让响度更平稳', intro: '压缩器压平音量起伏，让轻的部分更清晰、重的部分不爆。阈值越低压缩越狠，比率越大效果越强，输出增益补偿压缩损失的电平。', icon: Activity },
  nightMode: { name: '夜间模式', desc: '软限幅不吵人', intro: '用软限幅把整体响度压到舒适范围，深夜低音量听感不刺耳。强度越高压得越狠。', icon: Moon },
}

export default function MixingStudio({ engine, onClose, playerTheme, sourceUrl, sourceDuration, anchorRect, engineVersion = 'v2', onSwitchEngine, availableEngines }: MixingStudioProps) {
  // TV 遥控器 BACK：关闭调音室
  useTvBack(() => {
    onClose()
    return true
  }, [onClose])
  const [activeTab, setActiveTab] = useState<Tab>('effects')
  const [settings, setSettings] = useState<AudioEffectsSettings>(engine.getSettings())
  const [presets, setPresets] = useState<EqPreset[]>(loadPresets)
  const [presetName, setPresetName] = useState('')
  const [importText, setImportText] = useState('')
  const [exportText, setExportText] = useState('')
  const [exporting, setExporting] = useState(false)
  const [effectModal, setEffectModal] = useState<EffectKey | null>(null)
  // 频响补偿独立弹窗（与音效卡片分离：它是响度相关设置，与响度归一化并列）
  const [compensationModal, setCompensationModal] = useState(false)
  // 场景应用确认弹窗：customized 时点击场景弹出（覆盖 / 保存并应用 / 取消）
  const [sceneConfirm, setSceneConfirm] = useState<SceneSnapshot | null>(null)
  const [sceneName, setSceneName] = useState('')
  const [myScenes, setMyScenes] = useState<SceneSnapshot[]>(engine.getMyScenes())

  const dark = playerTheme === 'dark'

  // 跟随全局主题色（accentColorChanged 事件实时联动，同其他面板一致）
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#8b5cf6'
  })
  useEffect(() => {
    const handleAccentChange = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail) setAccentColor(customEvent.detail)
    }
    window.addEventListener('accentColorChanged', handleAccentChange)
    return () => window.removeEventListener('accentColorChanged', handleAccentChange)
  }, [])

  // ── liquid glass 视觉变量（暗色 / 亮色双主题）──
  const glassPanel = dark
    ? 'rgba(10, 12, 20, 0.38)'
    : 'rgba(255, 255, 255, 0.45)'
  const glassPanelHighlight = dark
    ? 'linear-gradient(160deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.03) 45%, rgba(255,255,255,0.06) 100%)'
    : 'linear-gradient(160deg, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.35) 45%, rgba(255,255,255,0.55) 100%)'
  const glassCard = dark
    ? 'linear-gradient(150deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.025) 100%)'
    : 'linear-gradient(150deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0.30) 100%)'
  const glassBorder = dark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.55)'
  const glassBlur = 'blur(30px) saturate(185%)'
  const glassCardBlur = 'blur(18px) saturate(160%)'
  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/65' : 'text-black/65'
  const textTertiary = dark ? 'text-white/40' : 'text-black/45'
  const inputBg = dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.5)'

  const update = useCallback((patch: DeepPartial<AudioEffectsSettings>) => {
    engine.updateSettings(patch)
    setSettings(engine.getSettings())
  }, [engine])

  const patchEffects = useCallback((patch: DeepPartial<AudioEffectsSettings['effects']>) => {
    update({ effects: patch })
  }, [update])

  const patchEq = useCallback((patch: DeepPartial<AudioEffectsSettings['eq']>) => {
    update({ eq: patch })
  }, [update])

  const patchPitch = useCallback((patch: DeepPartial<AudioEffectsSettings['pitch']>) => {
    update({ pitch: patch })
  }, [update])

  // 切换单个效果开关（可叠加）
  const toggleEffect = useCallback((key: EffectKey) => {
    const current = settings.effects[key]
    if (!current || typeof current !== 'object') return
    update({ effects: { [key]: { ...current, enabled: !('enabled' in current ? current.enabled : false) } } } as unknown as DeepPartial<AudioEffectsSettings>)
  }, [update, settings.effects])

  // ---- 场景方案（快照式，ADR-0001） ----
  const builtinScenes = engine.getBuiltinScenes()
  const allScenes = [...builtinScenes, ...myScenes]
  const activeSceneName = useMemo(() => {
    if (settings.customized) return '自定义'
    if (!settings.activeScene) return '无'
    return allScenes.find(s => s.id === settings.activeScene)?.name || '无'
  }, [settings.activeScene, settings.customized, allScenes])

  // 点击场景：处于自定义状态时先弹确认（覆盖 / 保存并应用 / 取消）
  const handleSceneClick = useCallback((scene: SceneSnapshot) => {
    if (settings.customized) {
      setSceneConfirm(scene)
    } else {
      engine.applyScene(scene)
      setSettings(engine.getSettings())
    }
  }, [engine, settings.customized])

  const handleSceneOverwrite = useCallback(() => {
    if (!sceneConfirm) return
    engine.applyScene(sceneConfirm)
    setSettings(engine.getSettings())
    setSceneName('')
    setSceneConfirm(null)
  }, [engine, sceneConfirm])

  // 恢复默认：应用「原声监听」内置场景（关闭全部音效与 EQ）
  const handleResetScene = useCallback(() => {
    const flat = engine.getBuiltinScenes().find(s => s.id === 'scene-flat')
    if (!flat) return
    engine.applyScene(flat)
    setSettings(engine.getSettings())
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已恢复默认（原声监听）', type: 'info' } }))
  }, [engine])

  const handleSceneSaveAndApply = useCallback(() => {
    if (!sceneConfirm) return
    const name = sceneName.trim() || `我的场景 ${myScenes.length + 1}`
    if (engine.saveAsMyScene(name)) {
      setMyScenes(engine.getMyScenes())
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已保存场景「${name}」`, type: 'info' } }))
    } else {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '我的场景已达上限（8 个），未保存当前设置', type: 'error' } }))
    }
    engine.applyScene(sceneConfirm)
    setSettings(engine.getSettings())
    setSceneName('')
    setSceneConfirm(null)
  }, [engine, sceneConfirm, sceneName, myScenes.length])

  const handleSaveCurrentScene = useCallback(() => {
    const name = sceneName.trim() || `我的场景 ${myScenes.length + 1}`
    if (engine.saveAsMyScene(name)) {
      setMyScenes(engine.getMyScenes())
      setSceneName('')
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已保存场景「${name}」`, type: 'info' } }))
    } else {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '我的场景已达上限（8 个）', type: 'error' } }))
    }
  }, [engine, sceneName, myScenes.length])

  const handleDeleteMyScene = useCallback((id: string) => {
    engine.deleteMyScene(id)
    setMyScenes(engine.getMyScenes())
  }, [engine])

  // ---- EQ 预设 ----
  const currentPresetJson = useMemo(() => {
    const { mode, simpleBands, proBands } = settings.eq
    return JSON.stringify({ mode, simpleBands, proBands })
  }, [settings.eq])

  const handleSavePreset = () => {
    const name = presetName.trim() || `均衡器 ${presets.length + 1}`
    if (presets.length >= 8) return
    const next: EqPreset[] = [...presets, {
      id: `${Date.now()}`,
      name,
      mode: settings.eq.mode,
      simpleBands: [...settings.eq.simpleBands],
      proBands: settings.eq.proBands.map(b => ({ ...b })),
    }]
    setPresets(next)
    savePresets(next)
    setPresetName('')
  }

  const handleApplyPreset = (preset: EqPreset) => {
    patchEq({ mode: preset.mode, simpleBands: [...preset.simpleBands], proBands: preset.proBands.map(b => ({ ...b })) })
  }

  const handleDeletePreset = (id: string) => {
    const next = presets.filter(p => p.id !== id)
    setPresets(next)
    savePresets(next)
  }

  // 清空均衡器：全部频段增益归零（恢复默认曲线）
  const handleResetEq = useCallback(() => {
    patchEq({
      simpleBands: [0, 0, 0, 0, 0],
      proBands: PRO_EQ_FREQUENCIES.map(frequency => ({ frequency, gain: 0, q: 1.1 })),
    })
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '均衡器已全部归零', type: 'info' } }))
  }, [patchEq])

  const handleExport = () => {
    setExportText(currentPresetJson)
  }

  const handleCopyExport = async () => {
    try {
      await navigator.clipboard.writeText(currentPresetJson)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '均衡器设置已复制到剪贴板', type: 'info' } }))
    } catch {
      setExportText(currentPresetJson)
    }
  }

  const handleImport = () => {
    try {
      const parsed = JSON.parse(importText) as { mode?: EqMode; simpleBands?: number[]; proBands?: { frequency: number; gain: number; q: number }[] }
      if (parsed.mode && Array.isArray(parsed.simpleBands) && parsed.simpleBands.length === 5 && Array.isArray(parsed.proBands)) {
        patchEq({
          mode: parsed.mode,
          simpleBands: parsed.simpleBands,
          proBands: parsed.proBands,
        })
        setImportText('')
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '均衡器设置已导入', type: 'info' } }))
      } else {
        throw new Error('格式无效')
      }
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '导入失败：JSON 格式无效', type: 'error' } }))
    }
  }

  const handleExportWav = async () => {
    if (!sourceUrl) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '当前没有正在播放的歌曲', type: 'error' } }))
      return
    }
    setExporting(true)
    try {
      await engine.exportToWav(sourceUrl, sourceDuration || 0)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已导出处理后的音频（WAV）', type: 'info' } }))
    } catch (error) {
      console.error('[MixingStudio] 导出失败:', error)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '导出失败：' + (error instanceof Error ? error.message : '未知错误'), type: 'error' } }))
    } finally {
      setExporting(false)
    }
  }

  const sliderTrack = (value: number, min: number, max: number) =>
    `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((value - min) / (max - min)) * 100}%, ${dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)'} ${((value - min) / (max - min)) * 100}%, ${dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)'} 100%)`

  // 全景声厅：声场可视化拖拽（横向位置 → 宽度级别 1-10）
  const hallSpread = (settings.effects.hall.level / 10) * 70
  const setHallLevelFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    patchEffects({ hall: { ...settings.effects.hall, level: Math.round(1 + x * 9) } })
  }

  // 3D 环绕：圆形可视化拖拽（角度 → 旋转角度，半径 → 近远 1-10）
  const surroundAngleRad = settings.effects.surround3d.angle * Math.PI / 180
  const surroundDistRatio = (settings.effects.surround3d.distance - 1) / 9
  const surroundDotX = 50 + Math.cos(surroundAngleRad) * surroundDistRatio * 40
  const surroundDotY = 50 + Math.sin(surroundAngleRad) * surroundDistRatio * 40
  const setSurroundFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dx = e.clientX - cx
    const dy = e.clientY - cy
    const angle = Math.round((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360)
    const dist = Math.min(1, Math.hypot(dx, dy) / (Math.min(rect.width, rect.height) / 2))
    patchEffects({ surround3d: { ...settings.effects.surround3d, angle, distance: Math.round(1 + dist * 9) } })
  }

  const renderToggle = (checked: boolean, onChange: (v: boolean) => void) => (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onChange(!checked) }}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? '' : dark ? 'bg-white/20' : 'bg-black/15'}`}
      style={checked ? { backgroundColor: accentColor, boxShadow: `0 0 12px ${accentColor}55` } : undefined}
    >
      <span
        className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-transform"
        style={{ transform: checked ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </button>
  )

  const renderRange = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    display?: string,
  ) => (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className={`${textSecondary} text-xs`}>{label}</span>
        <span className={`${textPrimary} text-xs font-medium`}>{display ?? value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer"
        style={{ background: sliderTrack(value, min, max) }}
      />
    </div>
  )

  // glass 卡片包装（面板内通用）
  const glassCardShell = (children: React.ReactNode) => (
    <div
      className="relative rounded-2xl p-4 overflow-hidden"
      style={{
        background: glassCard,
        backdropFilter: glassCardBlur,
        WebkitBackdropFilter: glassCardBlur,
        border: `1px solid ${glassBorder}`,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.18)',
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px" style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.5), transparent)' }} />
      {children}
    </div>
  )

  // 效果卡片（网格，可叠加）
  const renderEffectCard = (key: EffectKey) => {
    const meta = EFFECT_META[key]
    const effect = settings.effects[key]
    const enabled = !!effect?.enabled
    const Icon = meta.icon
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        onClick={() => setEffectModal(key)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) setEffectModal(key) }}
        className="relative cursor-pointer rounded-2xl p-3 flex flex-col items-center gap-2 transition-all hover:brightness-110"
        style={{
          background: enabled ? `${accentColor}26` : glassCard,
          backdropFilter: glassCardBlur,
          WebkitBackdropFilter: glassCardBlur,
          border: `1px solid ${enabled ? accentColor : glassBorder}`,
          boxShadow: enabled ? `0 0 16px ${accentColor}44` : '0 4px 14px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.12)',
        }}
      >
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${accentColor}22`, color: accentColor }}>
          <Icon className="w-4.5 h-4.5" />
        </div>
        <div className={`text-xs font-medium ${textPrimary} text-center leading-tight`}>{meta.name}</div>
        {/* v1 式大按钮：点卡片本体开配置弹窗，点按钮切换开关（可叠加） */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); toggleEffect(key) }}
          className="w-full py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={enabled
            ? { backgroundColor: accentColor, color: '#fff', boxShadow: `0 0 10px ${accentColor}55` }
            : { backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)' }}
        >
          {enabled ? '已启用' : '使用'}
        </button>
      </div>
    )
  }

  return (
    <>
      {/* 玻璃滑块 thumb 全局样式（双主题） */}
      <style>
        {`
          .wf-glass-range::-webkit-slider-thumb {
            appearance: none;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.92);
            border: 2px solid rgba(255, 255, 255, 0.6);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), 0 0 0 3px ${accentColor}44, inset 0 1px 2px rgba(255, 255, 255, 0.8);
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
          }
          .wf-glass-range::-webkit-slider-thumb:hover {
            transform: scale(1.2);
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3), 0 0 0 5px ${accentColor}55, inset 0 1px 2px rgba(255, 255, 255, 0.8);
          }
          .wf-glass-range::-webkit-slider-thumb:active {
            transform: scale(1.05);
            box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25), 0 0 0 4px ${accentColor}66, inset 0 1px 2px rgba(255, 255, 255, 0.8);
          }
          .wf-glass-range::-moz-range-thumb {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.92);
            border: 2px solid rgba(255, 255, 255, 0.6);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), 0 0 0 3px ${accentColor}44, inset 0 1px 2px rgba(255, 255, 255, 0.8);
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
          }
          .wf-glass-range::-moz-range-thumb:hover {
            transform: scale(1.2);
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3), 0 0 0 5px ${accentColor}55, inset 0 1px 2px rgba(255, 255, 255, 0.8);
          }
        `}
      </style>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-8"
        style={{
          backgroundColor: dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
          backdropFilter: 'blur(6px) saturate(140%)',
          WebkitBackdropFilter: 'blur(6px) saturate(140%)',
        }}
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.5, opacity: 0, x: anchorRect ? anchorRect.x - (window.innerWidth / 2) : 0, y: anchorRect ? anchorRect.y - (window.innerHeight / 2) : 0 }}
          animate={{ scale: 1, opacity: 1, x: 0, y: 0 }}
          exit={{ scale: 0.5, opacity: 0, x: anchorRect ? anchorRect.x - (window.innerWidth / 2) : 0, y: anchorRect ? anchorRect.y - (window.innerHeight / 2) : 0 }}
          transition={{ type: 'spring', damping: 26, stiffness: 300, mass: 0.9 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden rounded-3xl shadow-2xl"
          style={{
            background: glassPanel,
            backdropFilter: glassBlur,
            WebkitBackdropFilter: glassBlur,
            border: `1px solid ${glassBorder}`,
            boxShadow: '0 24px 64px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.2)',
          }}
        >
          {/* 面板顶部渐变高光 */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24" style={{ background: glassPanelHighlight, borderRadius: '1.5rem 1.5rem 0 0' }} />

          {/* 头部 */}
          <div className="relative flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${glassBorder}` }}>
            <div className="flex items-center gap-2.5">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: `${accentColor}2e`, border: `1px solid ${accentColor}55`, boxShadow: `0 4px 14px ${accentColor}33` }}
              >
                <AudioLines className="w-4.5 h-4.5" style={{ color: accentColor }} />
              </div>
              <div>
                <h2 className={`text-lg font-semibold ${textPrimary}`}>调音室</h2>
                <div className={`${textTertiary} text-[11px] -mt-0.5`}>场景方案 · 云澜音效 · 均衡器 · 调音器 · WAV 导出</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* 引擎版本切换（动态渲染：根据适配层注册表检测到的引擎列表） */}
              {onSwitchEngine && (
                <div
                  className="flex items-center rounded-full p-0.5"
                  style={{ background: inputBg, border: `1px solid ${glassBorder}`, backdropFilter: 'blur(8px)' }}
                >
                  {(availableEngines || [{ id: 'v2', displayName: 'v2', description: '' }]).map((eng) => (
                    <button
                      key={eng.id}
                      type="button"
                      onClick={() => onSwitchEngine(eng.id)}
                      title={eng.description}
                      className="px-2.5 py-1 rounded-full text-[11px] font-medium transition-all"
                      style={engineVersion === eng.id
                        ? { backgroundColor: accentColor, color: '#fff', boxShadow: `0 0 10px ${accentColor}55` }
                        : { color: textSecondary }}
                    >
                      {eng.displayName}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={onClose}
                className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}
              >
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>
          </div>

          {/* Tab 栏 */}
          <div className="relative flex px-3 pt-2 gap-1" style={{ borderBottom: `1px solid ${glassBorder}` }}>
            {([
              { key: 'effects', label: '音效场景', icon: Sparkles },
              { key: 'eq', label: '均衡器', icon: SlidersHorizontal },
              { key: 'tuner', label: '调音器', icon: AudioLines },
            ] as const).map((tab) => {
              const active = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2.5 flex items-center justify-center gap-1.5 text-sm rounded-t-xl transition-all ${
                    active
                      ? `${textPrimary} font-medium`
                      : `${textSecondary} hover:${textPrimary}`
                  }`}
                  style={active ? {
                    background: dark ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.5)',
                    border: `1px solid ${glassBorder}`,
                    borderBottom: 'none',
                    color: accentColor,
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.15)',
                  } : undefined}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                  {active && <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: accentColor }} />}
                </button>
              )
            })}
          </div>

          {/* 内容 */}
          <div className="relative p-4 sm:p-5 overflow-y-auto" style={{ height: 'calc(88vh - 140px)' }}>
            <AnimatePresence mode="wait">
              {activeTab === 'effects' && (
                <motion.div key="effects" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-3">
                  {/* 当前场景 + 场景方案区 */}
                  {glassCardShell(
                    <>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className={`${textPrimary} font-medium flex items-center gap-2`}>
                            <Sparkles className="w-4 h-4" style={{ color: accentColor }} />
                            场景方案
                          </div>
                          <div className={`${textSecondary} text-xs mt-0.5`}>当前：<span className="font-medium" style={{ color: accentColor }}>{activeSceneName}</span> {settings.customized && '（已手动调整）'}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            value={sceneName}
                            onChange={(e) => setSceneName(e.target.value)}
                            placeholder="场景名称"
                            className={`w-28 px-2.5 py-1.5 rounded-lg text-xs outline-none ${textPrimary}`}
                            style={{ background: inputBg, border: `1px solid ${glassBorder}` }}
                          />
                          <button
                            type="button"
                            onClick={handleResetScene}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all hover:brightness-110 active:scale-95"
                            style={{ background: inputBg, border: `1px solid ${glassBorder}`, color: textSecondary }}
                            title="清空全部音效与均衡器，恢复原声监听"
                          >
                            <RotateCcw className="w-3.5 h-3.5" /> 恢复默认
                          </button>
                          <button
                            type="button"
                            onClick={handleSaveCurrentScene}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white transition-all hover:brightness-110 active:scale-95"
                            style={{ backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` }}
                          >
                            <Save className="w-3.5 h-3.5" /> 保存为场景
                          </button>
                        </div>
                      </div>
                      <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
                        {allScenes.map(scene => {
                          const active = !settings.customized && settings.activeScene === scene.id
                          return (
                            <div key={scene.id} className="relative shrink-0">
                              <button
                                type="button"
                                onClick={() => handleSceneClick(scene)}
                                className="rounded-xl px-3 py-2 text-left transition-all hover:brightness-110 active:scale-[0.97]"
                                style={{
                                  background: active ? `${accentColor}26` : inputBg,
                                  border: `1px solid ${active ? accentColor : glassBorder}`,
                                  boxShadow: active ? `0 0 14px ${accentColor}44` : 'none',
                                  backdropFilter: 'blur(8px)',
                                  minWidth: '96px',
                                }}
                              >
                                <div className={`text-xs font-medium ${active ? '' : textPrimary}`} style={active ? { color: accentColor } : undefined}>
                                  {scene.builtin ? '' : '★ '}{scene.name}
                                </div>
                                {scene.description && <div className={`${textTertiary} text-[10px] mt-0.5 max-w-[130px] leading-snug line-clamp-2`}>{scene.description}</div>}
                              </button>
                              {!scene.builtin && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); handleDeleteMyScene(scene.id) }}
                                  className={`absolute -top-1.5 -right-1.5 p-1 rounded-full ${dark ? 'bg-black/70' : 'bg-white/80'} shadow-md`}
                                  title="删除场景"
                                >
                                  <Trash2 className="w-3 h-3" style={{ color: textSecondary }} />
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                      <div className={`${textTertiary} text-[11px] mt-2 flex items-center gap-1`}>
                        <Info className="w-3 h-3" /> 点击场景一键应用整套听感；手动调整过参数后再次点击会询问是否覆盖或先保存当前设置。
                      </div>
                    </>
                  )}

                  {/* 效果开关（可叠加） */}
                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-3`}>音效（可叠加）</div>
                      <div className="grid grid-cols-4 gap-2.5">
                        {EFFECT_KEYS.map(renderEffectCard)}
                      </div>

                      {/* 3D 环绕开启时展开子设置横条（关闭自动收缩，AnimatePresence 渐隐） */}
                      <AnimatePresence>
                        {!!settings.effects.surround3d.enabled && (
                          <motion.div
                            key="surround3d-sub-settings"
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0 }}
                            transition={{ duration: 0.25, ease: 'easeOut' }}
                            className="overflow-hidden mt-3"
                          >
                            <div
                              className="rounded-2xl p-3.5"
                              style={{ background: `${accentColor}12`, border: `1px solid ${accentColor}44` }}
                            >
                              <div className="flex items-center justify-between mb-2">
                                <div className={`${textSecondary} text-xs flex items-center gap-1.5`}>
                                  <Headphones className="w-3.5 h-3.5" style={{ color: accentColor }} />
                                  3D 环绕子设置
                                </div>
                                <span className={`${textTertiary} text-[11px]`}>关闭「3D 环绕」后自动收起</span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4">
                                {renderRange('环绕速度', settings.effects.surround3d.speed ?? 1, 0.2, 3, 0.1, (v) => patchEffects({ surround3d: { ...settings.effects.surround3d, speed: v } }), `${(settings.effects.surround3d.speed ?? 1).toFixed(1)}x`)}
                                {renderRange('环绕近远', settings.effects.surround3d.distance ?? 5, 1, 10, 1, (v) => patchEffects({ surround3d: { ...settings.effects.surround3d, distance: v } }))}
                                {renderRange('旋转角度', settings.effects.surround3d.angle ?? 0, 0, 360, 1, (v) => patchEffects({ surround3d: { ...settings.effects.surround3d, angle: v } }), `${settings.effects.surround3d.angle ?? 0}°`)}
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </>
                  )}

                  {/* 频响补偿（响度相关，独立于音效卡片；点击打开配置弹窗） */}
                  {glassCardShell(
                    <>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium flex items-center gap-2`}>
                            <Volume2 className="w-4 h-4" style={{ color: accentColor }} />
                            频响补偿
                          </div>
                          <div className={`${textSecondary} text-xs mt-0.5`}>低音量自适应提频 · 场景预设 · 自定义曲线（与均衡器、响度归一化互斥）</div>
                        </div>
                        <div className="flex items-center gap-2">
                          {renderToggle(settings.effects.loudnessCompensation.enabled, (v) => {
                            patchEffects({ loudnessCompensation: { ...settings.effects.loudnessCompensation, enabled: v } })
                          })}
                          <button
                            type="button"
                            onClick={() => setCompensationModal(true)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-white transition-all hover:brightness-110 active:scale-95"
                            style={{ backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` }}
                          >
                            配置
                          </button>
                        </div>
                      </div>
                      <div className={`${textTertiary} text-[11px] mt-2 flex items-center gap-1`}>
                        <Info className="w-3 h-3 shrink-0" /> 由独立补偿服务（3004）生成 ISO 226 / 预设 / 自定义补偿曲线；服务不可用时回退内置近似，不影响播放。
                      </div>
                    </>
                  )}

                  {/* 响度归一化（独立于效果，逐曲自动对齐） */}
                  {glassCardShell(
                    <>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium flex items-center gap-2`}>
                            <Volume2 className="w-4 h-4" style={{ color: accentColor }} />
                            响度归一化
                          </div>
                          <div className={`${textSecondary} text-xs mt-0.5`}>逐曲测量响度并对齐（目标 -14 LUFS），切换歌曲音量一致（与频响补偿互斥）</div>
                        </div>
                        {renderToggle(settings.normalizationEnabled, (v) => {
                          update({ normalizationEnabled: v })
                          window.dispatchEvent(new CustomEvent('normalizationEnabledChanged', { detail: v }))
                        })}
                      </div>
                      <div className={`${textTertiary} text-[11px] mt-2 flex items-center gap-1`}>
                        <Info className="w-3 h-3 shrink-0" /> 需要本地响度服务（3003）；测量失败自动回退原声，不影响播放。
                      </div>
                    </>
                  )}
                </motion.div>
              )}

              {activeTab === 'eq' && (
                <motion.div key="eq" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-4">
                  {/* 开关 + 模式 */}
                  {glassCardShell(
                    <>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium`}>均衡器</div>
                          <div className={`${textSecondary} text-xs`}>调整各频段的增益</div>
                        </div>
                        {renderToggle(settings.eq.enabled, (v) => patchEq({ enabled: v }))}
                      </div>
                      {settings.eq.enabled && (
                        <div className="flex gap-2 mt-3">
                          <button
                            type="button"
                            onClick={() => patchEq({ mode: 'simple' })}
                            className={`flex-1 py-2 rounded-lg text-sm transition-all ${settings.eq.mode === 'simple' ? 'text-white font-medium' : `${textSecondary} ${dark ? 'bg-white/5' : 'bg-black/5'}`}`}
                            style={settings.eq.mode === 'simple' ? { backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` } : undefined}
                          >
                            简约
                          </button>
                          <button
                            type="button"
                            onClick={() => patchEq({ mode: 'pro' })}
                            className={`flex-1 py-2 rounded-lg text-sm transition-all ${settings.eq.mode === 'pro' ? 'text-white font-medium' : `${textSecondary} ${dark ? 'bg-white/5' : 'bg-black/5'}`}`}
                            style={settings.eq.mode === 'pro' ? { backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` } : undefined}
                          >
                            专业
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {/* 频段滑杆 */}
                  {settings.eq.enabled && (
                    glassCardShell(
                      <div className="space-y-3">
                        {settings.eq.mode === 'simple' ? (
                          <>
                            <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                              <Info className="w-3.5 h-3.5" /> 使用说明：往上加重该频段、往下减弱；建议从 0 开始微调。
                            </div>
                            {SIMPLE_EQ_BANDS.map((band, i) => (
                              <div key={band.frequency}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className={`${textSecondary} text-xs`}>{band.label}（{band.frequency}Hz）</span>
                                  <span className={`${textPrimary} text-xs font-medium`}>{settings.eq.simpleBands[i] > 0 ? '+' : ''}{settings.eq.simpleBands[i].toFixed(1)}dB</span>
                                </div>
                                <input
                                  type="range"
                                  min={-12}
                                  max={12}
                                  step={0.5}
                                  value={settings.eq.simpleBands[i]}
                                  onChange={(e) => {
                                    const next = [...settings.eq.simpleBands]
                                    next[i] = parseFloat(e.target.value)
                                    patchEq({ simpleBands: next })
                                  }}
                                  className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer"
                                  style={{ background: sliderTrack(settings.eq.simpleBands[i], -12, 12) }}
                                />
                                <div className={`${textTertiary} text-xs mt-0.5`}>{band.hint}</div>
                              </div>
                            ))}
                          </>
                        ) : (
                          <>
                            <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                              <Info className="w-3.5 h-3.5" /> 专业版：10 段倍频程均衡，每段独立调节增益，双击滑杆归零。
                            </div>
                            {settings.eq.proBands.map((band, i) => (
                              <div key={band.frequency}>
                                <div className="flex items-center justify-between mb-1">
                                  <span className={`${textSecondary} text-xs`}>{band.frequency >= 1000 ? `${band.frequency / 1000}k` : band.frequency}Hz</span>
                                  <span className={`${textPrimary} text-xs font-medium`}>{band.gain > 0 ? '+' : ''}{band.gain.toFixed(1)}dB</span>
                                </div>
                                <input
                                  type="range"
                                  min={-12}
                                  max={12}
                                  step={0.5}
                                  value={band.gain}
                                  onChange={(e) => {
                                    const next = settings.eq.proBands.map(b => ({ ...b }))
                                    next[i].gain = parseFloat(e.target.value)
                                    patchEq({ proBands: next })
                                  }}
                                  onDoubleClick={() => {
                                    const next = settings.eq.proBands.map(b => ({ ...b }))
                                    next[i].gain = 0
                                    patchEq({ proBands: next })
                                  }}
                                  className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer"
                                  style={{ background: sliderTrack(band.gain, -12, 12) }}
                                />
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    )
                  )}

                  {/* 预设 */}
                  {glassCardShell(
                    <>
                      <div className="flex items-center justify-between mb-2">
                        <div className={`${textPrimary} font-medium`}>预设（{presets.length}/8）</div>
                        <button
                          type="button"
                          onClick={handleResetEq}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] transition-all hover:brightness-110 active:scale-95"
                          style={{ background: inputBg, border: `1px solid ${glassBorder}`, color: textSecondary }}
                          title="所有频段增益归零，恢复平坦曲线"
                        >
                          <RotateCcw className="w-3 h-3" /> 清空均衡器
                        </button>
                      </div>
                      <div className="flex gap-2 mb-3">
                        <input
                          value={presetName}
                          onChange={(e) => setPresetName(e.target.value)}
                          placeholder="预设名称"
                          className={`flex-1 px-3 py-2 rounded-lg text-sm outline-none transition-shadow ${textPrimary}`}
                          style={{ background: inputBg, border: `1px solid ${glassBorder}`, backdropFilter: 'blur(8px)' }}
                        />
                        <button
                          type="button"
                          onClick={handleSavePreset}
                          disabled={presets.length >= 8}
                          className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-white disabled:opacity-40 transition-all hover:brightness-110 active:scale-95`}
                          style={{ backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` }}
                        >
                          <Save className="w-4 h-4" /> 保存
                        </button>
                      </div>
                      {presets.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {presets.map(preset => (
                            <div key={preset.id} className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleApplyPreset(preset)}
                                className={`px-3 py-1.5 rounded-lg text-xs transition-opacity hover:opacity-80 ${textPrimary}`}
                                style={{ background: inputBg, border: `1px solid ${glassBorder}`, backdropFilter: 'blur(8px)' }}
                              >
                                {preset.name}
                              </button>
                              <button type="button" onClick={() => handleDeletePreset(preset.id)} className={`p-1 ${textTertiary} hover:${textPrimary}`}>
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* 导入导出 */}
                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-2`}>导入 / 导出</div>
                      <div className="flex gap-2 mb-2">
                        <button type="button" onClick={handleCopyExport} className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-white transition-all hover:brightness-110 active:scale-95`} style={{ backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` }}>
                          <Copy className="w-4 h-4" /> 复制我的设置
                        </button>
                        <button type="button" onClick={handleExport} className={`px-3 py-2 rounded-lg text-sm transition-opacity hover:opacity-80 ${textPrimary}`} style={{ background: inputBg, border: `1px solid ${glassBorder}` }}>
                          显示导出文本
                        </button>
                      </div>
                      {exportText && (
                        <textarea
                          readOnly
                          value={exportText}
                          className={`w-full h-20 px-3 py-2 rounded-lg text-xs outline-none ${textPrimary}`}
                          style={{ background: inputBg, border: `1px solid ${glassBorder}` }}
                        />
                      )}
                      <div className="flex gap-2 mt-2">
                        <textarea
                          value={importText}
                          onChange={(e) => setImportText(e.target.value)}
                          placeholder="粘贴别人分享的均衡器 JSON 到这里"
                          className={`flex-1 h-16 px-3 py-2 rounded-lg text-xs outline-none ${textPrimary}`}
                          style={{ background: inputBg, border: `1px solid ${glassBorder}` }}
                        />
                        <button type="button" onClick={handleImport} className={`flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-white transition-all hover:brightness-110 active:scale-95`} style={{ backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` }}>
                          <ClipboardPaste className="w-4 h-4" /> 导入
                        </button>
                      </div>
                    </>
                  )}
                </motion.div>
              )}

              {activeTab === 'tuner' && (
                <motion.div key="tuner" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-3">
                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-3`}>人声 / 伴奏比例</div>
                      {renderRange('人声 ↔ 伴奏', settings.pitch.voiceBalance, -1, 1, 0.05, (v) => patchPitch({ voiceBalance: v }), settings.pitch.voiceBalance === 0 ? '原声' : settings.pitch.voiceBalance > 0 ? `人声 +${Math.round(settings.pitch.voiceBalance * 100)}%` : `伴奏 +${Math.round(-settings.pitch.voiceBalance * 100)}%`)}
                      <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                        <Info className="w-3.5 h-3.5" /> 基于中/侧声道分离，会同时影响居中的低频，效果为卡拉OK级。
                      </div>
                    </>
                  )}

                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-3`}>变调 / 变速</div>
                      {renderRange('变调', settings.pitch.semitones, -10, 10, 0.5, (v) => patchPitch({ semitones: v }), `${settings.pitch.semitones > 0 ? '+' : ''}${settings.pitch.semitones} 半音`)}
                      {renderRange('倍速', settings.pitch.rate, 0.25, 3, 0.05, (v) => patchPitch({ rate: v }), `${settings.pitch.rate.toFixed(2)}x`)}
                      <div className={`${textTertiary} text-xs flex items-center gap-1`}>
                        <Info className="w-3.5 h-3.5" /> 基于 SoundTouch 实时处理，变调与变速互相独立。
                      </div>
                    </>
                  )}

                  {glassCardShell(
                    <>
                      <div className={`${textPrimary} font-medium mb-1`}>导出处理后的音乐</div>
                      <div className={`${textSecondary} text-xs mb-3`}>把当前音效与均衡器离线渲染成 WAV 文件下载（个人处理用途，涉及版权曲目请勿分发）</div>
                      <button
                        type="button"
                        onClick={() => void handleExportWav()}
                        disabled={exporting || !sourceUrl}
                        className="w-full py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-40 transition-all hover:brightness-110 active:scale-[0.98] flex items-center justify-center gap-2"
                        style={{ backgroundColor: accentColor, boxShadow: `0 6px 18px ${accentColor}44` }}
                      >
                        <FileAudio className="w-4 h-4" />
                        {exporting ? '导出中…' : '导出 WAV'}
                      </button>
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.div>

      {/* 效果配置弹窗（点击卡片打开，独立层级避免点击冒泡关闭整个调音室） */}
      <AnimatePresence>
        {effectModal && (() => {
          const key = effectModal
          const meta = EFFECT_META[key]
          const effect = settings.effects[key]
          const enabled = !!effect?.enabled
          const Icon = meta.icon
          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[90] flex items-center justify-center p-4"
              style={{ backgroundColor: dark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.2)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
              onClick={() => setEffectModal(null)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 12 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 12 }}
                transition={{ type: 'spring', damping: 26, stiffness: 320 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-sm overflow-hidden rounded-3xl"
                style={{
                  background: glassPanel,
                  backdropFilter: glassBlur,
                  WebkitBackdropFilter: glassBlur,
                  border: `1px solid ${glassBorder}`,
                  boxShadow: '0 24px 64px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.2)',
                }}
              >
                <div className="p-5">
                  {/* 头部 */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${accentColor}22`, color: accentColor, border: `1px solid ${accentColor}55` }}>
                        <Icon className="w-4.5 h-4.5" />
                      </div>
                      <div className={`${textPrimary} font-semibold`}>{meta.name}</div>
                    </div>
                    <button type="button" onClick={() => setEffectModal(null)} className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
                      <X className={`w-4.5 h-4.5 ${textSecondary}`} />
                    </button>
                  </div>

                  <p className={`${textSecondary} text-xs leading-relaxed mb-4`}>{meta.intro}</p>

                  {/* 效果开关 */}
                  <div className="flex items-center justify-between mb-4">
                    <span className={`${textPrimary} text-sm font-medium`}>启用 {meta.name}</span>
                    {renderToggle(enabled, (v) => toggleEffect(key))}
                  </div>

                  {key === 'hall' && (
                    <>
                      {/* 混响类型 */}
                      <div className="mb-3">
                        <div className={`${textSecondary} text-xs mb-1.5`}>混响类型</div>
                        <div className="grid grid-cols-5 gap-1.5">
                          {REVERB_TYPES.map(rt => {
                            const activeType = settings.effects.hall.type === rt.value
                            return (
                              <button
                                key={rt.value}
                                type="button"
                                title={rt.hint}
                                onClick={() => patchEffects({ hall: { ...settings.effects.hall, type: rt.value as ReverbType } })}
                                className="py-1.5 rounded-lg text-[11px] transition-all"
                                style={activeType
                                  ? { backgroundColor: accentColor, color: '#fff', boxShadow: `0 0 10px ${accentColor}55` }
                                  : { background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: textSecondary }}
                              >
                                {rt.label}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      {/* 声场可视化 */}
                      <div
                        className="relative h-24 rounded-xl mb-3 cursor-ew-resize touch-none overflow-hidden select-none"
                        style={{
                          background: dark
                            ? `radial-gradient(ellipse at center, ${accentColor}1f, transparent 72%), rgba(255,255,255,0.03)`
                            : `radial-gradient(ellipse at center, ${accentColor}1a, transparent 72%), rgba(0,0,0,0.03)`,
                          border: `1px solid ${glassBorder}`,
                        }}
                        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setHallLevelFromPointer(e) }}
                        onPointerMove={(e) => { if (e.buttons === 1) setHallLevelFromPointer(e) }}
                      >
                        <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ background: dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.16)' }} />
                        <div className="absolute left-1/2 top-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: accentColor }} />
                        <div className="absolute top-1/2 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${50 - hallSpread / 2}%`, background: accentColor, boxShadow: `0 0 12px ${accentColor}aa` }} />
                        <div className="absolute top-1/2 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${50 + hallSpread / 2}%`, background: accentColor, boxShadow: `0 0 12px ${accentColor}aa` }} />
                        <span className="absolute top-1.5 left-2 text-[10px]" style={{ color: dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }}>声场宽度</span>
                        <span className="absolute top-1.5 right-2 text-[10px] font-semibold" style={{ color: accentColor }}>{settings.effects.hall.level} 级</span>
                        <span className="absolute bottom-1 inset-x-0 text-center text-[10px]" style={{ color: dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)' }}>← 左右拖动调整声场宽度 →</span>
                      </div>
                      {renderRange('混响量', settings.effects.hall.reverb, 0, 10, 1, (v) => patchEffects({ hall: { ...settings.effects.hall, reverb: v } }), `${settings.effects.hall.reverb}`)}
                      {renderRange('预延迟', settings.effects.hall.preDelay, 0, 200, 1, (v) => patchEffects({ hall: { ...settings.effects.hall, preDelay: v } }), `${settings.effects.hall.preDelay}ms`)}
                      {renderRange('衰减时间', settings.effects.hall.decay, 0.5, 6, 0.1, (v) => patchEffects({ hall: { ...settings.effects.hall, decay: v } }), `${settings.effects.hall.decay.toFixed(1)}s`)}
                    </>
                  )}

                  {key === 'surround3d' && (
                    <>
                      {/* 环绕可视化（优化：同心环 + 十字线 + 角度/距离读数） */}
                      <div
                        className="relative h-48 rounded-xl mb-3 touch-none overflow-hidden select-none"
                        style={{ background: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)', border: `1px solid ${glassBorder}` }}
                      >
                        <span className="absolute top-1.5 left-2 text-[10px]" style={{ color: dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }}>角度 {settings.effects.surround3d.angle}°</span>
                        <span className="absolute top-1.5 right-2 text-[10px] font-semibold" style={{ color: accentColor }}>距离 {settings.effects.surround3d.distance}</span>
                        <div
                          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-36 h-36 cursor-pointer touch-none"
                          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setSurroundFromPointer(e) }}
                          onPointerMove={(e) => { if (e.buttons === 1) setSurroundFromPointer(e) }}
                        >
                          {[0.33, 0.66, 1].map(r => (
                            <div key={r} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border" style={{ width: `${r * 100}%`, height: `${r * 100}%`, borderColor: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)' }} />
                          ))}
                          <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ background: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }} />
                          <div className="absolute top-1/2 left-0 right-0 h-px" style={{ background: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }} />
                          <div className="absolute left-1/2 top-1/2 w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)' }} />
                          <div className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${surroundDotX}%`, top: `${surroundDotY}%`, background: accentColor, boxShadow: `0 0 14px ${accentColor}aa` }} />
                        </div>
                        <span className="absolute bottom-1 inset-x-0 text-center text-[10px]" style={{ color: dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)' }}>拖动圆点调整角度与距离</span>
                      </div>
                      {renderRange('环绕近远', settings.effects.surround3d.distance, 1, 10, 1, (v) => patchEffects({ surround3d: { ...settings.effects.surround3d, distance: v } }))}
                      {renderRange('旋转角度', settings.effects.surround3d.angle, 0, 360, 1, (v) => patchEffects({ surround3d: { ...settings.effects.surround3d, angle: v } }), `${settings.effects.surround3d.angle}°`)}
                      {renderRange('环绕速度', settings.effects.surround3d.speed, 0.2, 3, 0.1, (v) => patchEffects({ surround3d: { ...settings.effects.surround3d, speed: v } }), `${settings.effects.surround3d.speed.toFixed(1)}x`)}
                      <div className="flex gap-2">
                        <button type="button" onClick={() => patchEffects({ surround3d: { ...settings.effects.surround3d, direction: 1 } })} className={`flex-1 py-2 rounded-xl text-sm transition-colors ${settings.effects.surround3d.direction === 1 ? 'text-white' : dark ? 'text-white/70' : 'text-black/70'}`} style={settings.effects.surround3d.direction === 1 ? { backgroundColor: accentColor } : { backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>正转 ↻</button>
                        <button type="button" onClick={() => patchEffects({ surround3d: { ...settings.effects.surround3d, direction: -1 } })} className={`flex-1 py-2 rounded-xl text-sm transition-colors ${settings.effects.surround3d.direction === -1 ? 'text-white' : dark ? 'text-white/70' : 'text-black/70'}`} style={settings.effects.surround3d.direction === -1 ? { backgroundColor: accentColor } : { backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>反转 ↺</button>
                      </div>
                    </>
                  )}

                  {key === 'bassBoost' && (
                    <>
                      {renderRange('深度（起始频率）', settings.effects.bassBoost.depth, 40, 250, 5, (v) => patchEffects({ bassBoost: { ...settings.effects.bassBoost, depth: v } }), `${settings.effects.bassBoost.depth}Hz`)}
                      {renderRange('强度', settings.effects.bassBoost.intensity, 0, 12, 0.5, (v) => patchEffects({ bassBoost: { ...settings.effects.bassBoost, intensity: v } }), `+${settings.effects.bassBoost.intensity.toFixed(1)}dB`)}
                    </>
                  )}

                  {key === 'vocalBoost' && (
                    renderRange('强度', settings.effects.vocalBoost.intensity, 0, 9, 0.5, (v) => patchEffects({ vocalBoost: { ...settings.effects.vocalBoost, intensity: v } }), `+${settings.effects.vocalBoost.intensity.toFixed(1)}dB`)
                  )}

                  {key === 'accompanimentBoost' && (
                    renderRange('强度', settings.effects.accompanimentBoost.intensity, 0, 9, 0.5, (v) => patchEffects({ accompanimentBoost: { ...settings.effects.accompanimentBoost, intensity: v } }), `+${settings.effects.accompanimentBoost.intensity.toFixed(1)}dB`)
                  )}

                  {key === 'compressor' && (
                    <>
                      {renderRange('阈值', settings.effects.compressor.threshold, -60, 0, 1, (v) => patchEffects({ compressor: { ...settings.effects.compressor, threshold: v } }), `${settings.effects.compressor.threshold}dB`)}
                      {renderRange('比率', settings.effects.compressor.ratio, 1, 20, 0.5, (v) => patchEffects({ compressor: { ...settings.effects.compressor, ratio: v } }), `${settings.effects.compressor.ratio.toFixed(1)}:1`)}
                      {renderRange('起始时间', settings.effects.compressor.attack, 0, 0.5, 0.005, (v) => patchEffects({ compressor: { ...settings.effects.compressor, attack: v } }), `${settings.effects.compressor.attack.toFixed(3)}s`)}
                      {renderRange('释放时间', settings.effects.compressor.release, 0, 1, 0.01, (v) => patchEffects({ compressor: { ...settings.effects.compressor, release: v } }), `${settings.effects.compressor.release.toFixed(2)}s`)}
                      {renderRange('输出增益', settings.effects.compressor.outputGain, 0, 12, 0.5, (v) => patchEffects({ compressor: { ...settings.effects.compressor, outputGain: v } }), `+${settings.effects.compressor.outputGain.toFixed(1)}dB`)}
                    </>
                  )}

                  {key === 'nightMode' && (
                    renderRange('强度', settings.effects.nightMode.amount, 0, 10, 1, (v) => patchEffects({ nightMode: { ...settings.effects.nightMode, amount: v } }), `${settings.effects.nightMode.amount} 级`)
                  )}
                </div>
              </motion.div>
            </motion.div>
          )
        })()}
      </AnimatePresence>

      {/* 频响补偿配置弹窗（独立于音效卡片，与响度归一化同属响度相关设置） */}
      <AnimatePresence>
        {compensationModal && (() => {
          const comp = settings.effects.loudnessCompensation
          const compMode = comp.mode || 'auto'
          const compPreset = comp.preset || 'flat'
          return (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[90] flex items-center justify-center p-4"
              style={{ backgroundColor: dark ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.2)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
              onClick={() => setCompensationModal(false)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 12 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 12 }}
                transition={{ type: 'spring', damping: 26, stiffness: 320 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-sm overflow-hidden rounded-3xl"
                style={{
                  background: glassPanel,
                  backdropFilter: glassBlur,
                  WebkitBackdropFilter: glassBlur,
                  border: `1px solid ${glassBorder}`,
                  boxShadow: '0 24px 64px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.2)',
                }}
              >
                <div className="p-5">
                  {/* 头部 */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${accentColor}22`, color: accentColor, border: `1px solid ${accentColor}55` }}>
                        <Volume2 className="w-4.5 h-4.5" />
                      </div>
                      <div className={`${textPrimary} font-semibold`}>频响补偿</div>
                    </div>
                    <button type="button" onClick={() => setCompensationModal(false)} className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
                      <X className={`w-4.5 h-4.5 ${textSecondary}`} />
                    </button>
                  </div>

                  <p className={`${textSecondary} text-xs leading-relaxed mb-4`}>低音量下人耳对低频/高频不敏感。按系统音量动态补偿低频/高频（等响度模型）、场景预设曲线或自定义频段增益，让低音量听感更平衡。与均衡器、响度归一化互斥。</p>

                  {/* 启用开关 */}
                  <div className="flex items-center justify-between mb-4">
                    <span className={`${textPrimary} text-sm font-medium`}>启用 频响补偿</span>
                    {renderToggle(comp.enabled, (v) => patchEffects({ loudnessCompensation: { ...comp, enabled: v } }))}
                  </div>

                  {/* 模式选择 */}
                  <div className="flex gap-1.5 mb-4">
                    {([
                      { value: 'auto' as const, label: '自适应（等响度）' },
                      { value: 'preset' as const, label: '场景预设' },
                      { value: 'custom' as const, label: '自定义频段' },
                    ]).map((m) => {
                      const active = compMode === m.value
                      return (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => patchEffects({ loudnessCompensation: { ...comp, mode: m.value } })}
                          className={`flex-1 py-2 rounded-lg text-xs transition-all ${active ? 'text-white font-medium' : `${textSecondary} ${dark ? 'bg-white/5' : 'bg-black/5'}`}`}
                          style={active ? { backgroundColor: accentColor, boxShadow: `0 4px 14px ${accentColor}44` } : undefined}
                        >
                          {m.label}
                        </button>
                      )
                    })}
                  </div>

                  {compMode === 'auto' && (
                    <div className={`${textTertiary} text-xs leading-relaxed flex items-start gap-1.5`}>
                      <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <span>按系统音量动态补偿低频/高频：音量越低补偿越强（等响度模型，线性跟随），低频最高 +12dB、高频最高 +6dB，音量恢复后自动回平。</span>
                    </div>
                  )}

                  {compMode === 'preset' && (
                    <>
                      <div className={`${textSecondary} text-xs mb-1.5`}>选择目标听感曲线</div>
                      <div className="flex flex-wrap gap-1.5 mb-1.5">
                        {COMPENSATION_PRESETS.map(p => {
                          const active = compPreset === p.id
                          return (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => patchEffects({ loudnessCompensation: { ...comp, mode: 'preset', preset: p.id } })}
                              className="px-3 py-1.5 rounded-lg text-xs transition-all"
                              style={active
                                ? { backgroundColor: accentColor, color: '#fff', boxShadow: `0 0 10px ${accentColor}55` }
                                : { background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: textSecondary }}
                            >
                              {p.name}
                            </button>
                          )
                        })}
                      </div>
                      <div className={`${textTertiary} text-xs leading-relaxed flex items-start gap-1.5`}>
                        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>预设按固定等响度曲线补偿，不随系统音量变化；适合固定听音习惯。</span>
                      </div>
                    </>
                  )}

                  {compMode === 'custom' && (
                    <>
                      <div className={`${textTertiary} text-xs leading-relaxed flex items-start gap-1.5 mb-3`}>
                        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>自定义目标补偿曲线：拖动各频段增益（-8 ~ +8dB）。点击保存后按此曲线补偿。</span>
                      </div>
                      {resolveCustomBands(comp.bands).map((band, i) => {
                        const freqs = CUSTOM_BAND_FREQUENCIES
                        const bandFreq = freqs[i] ?? band.frequency
                        const bandGain = band.gain || 0
                        return (
                          <div key={bandFreq}>
                            <div className="flex items-center justify-between mb-1">
                              <span className={`${textSecondary} text-xs`}>{bandFreq >= 1000 ? `${bandFreq / 1000}k` : bandFreq}Hz</span>
                              <span className={`${textPrimary} text-xs font-medium`}>{bandGain > 0 ? '+' : ''}{bandGain.toFixed(1)}dB</span>
                            </div>
                            <input
                              type="range"
                              min={-8}
                              max={8}
                              step={0.5}
                              value={bandGain}
                              onChange={(e) => {
                                const current = resolveCustomBands(comp.bands)
                                const next = current.map(b => ({ ...b }))
                                if (next[i]) next[i].gain = parseFloat(e.target.value)
                                patchEffects({ loudnessCompensation: { ...comp, mode: 'custom', bands: next } })
                              }}
                              className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer"
                              style={{ background: sliderTrack(bandGain, -8, 8) }}
                            />
                          </div>
                        )
                      })}
                    </>
                  )}

                  {/* 互斥说明 */}
                  <div className={`${textTertiary} text-xs leading-relaxed flex items-start gap-1.5 mt-3`}>
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>开启后均衡器与响度归一化会自动关闭（互斥）。</span>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )
        })()}
      </AnimatePresence>

      {/* 场景应用确认弹窗（自定义状态下点击场景） */}
      <AnimatePresence>
        {sceneConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[95] flex items-center justify-center p-4"
            style={{ backgroundColor: dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.25)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)' }}
            onClick={() => { setSceneConfirm(null); setSceneName('') }}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 12 }}
              transition={{ type: 'spring', damping: 26, stiffness: 320 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm overflow-hidden rounded-3xl"
              style={{
                background: glassPanel,
                backdropFilter: glassBlur,
                WebkitBackdropFilter: glassBlur,
                border: `1px solid ${glassBorder}`,
                boxShadow: '0 24px 64px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.2)',
              }}
            >
              <div className="p-5">
                <div className="flex items-center gap-2.5 mb-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${accentColor}22`, color: accentColor, border: `1px solid ${accentColor}55` }}>
                    <Sparkles className="w-4.5 h-4.5" />
                  </div>
                  <div className={`${textPrimary} font-semibold`}>应用场景「{sceneConfirm.name}」</div>
                </div>
                <p className={`${textSecondary} text-xs leading-relaxed mb-4`}>
                  你当前有手动调整的听感参数（自定义状态），应用该场景会覆盖它们。可以选择先保存当前设置为「我的场景」，或直接覆盖。
                </p>
                <div className="flex items-center gap-2 mb-4">
                  <input
                    value={sceneName}
                    onChange={(e) => setSceneName(e.target.value)}
                    placeholder={`保存为：我的场景 ${myScenes.length + 1}`}
                    className={`flex-1 px-3 py-2 rounded-lg text-xs outline-none ${textPrimary}`}
                    style={{ background: inputBg, border: `1px solid ${glassBorder}` }}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={handleSceneSaveAndApply}
                    className="w-full py-2.5 rounded-xl text-sm font-medium text-white transition-all hover:brightness-110 active:scale-[0.98] flex items-center justify-center gap-1.5"
                    style={{ backgroundColor: accentColor, boxShadow: `0 6px 18px ${accentColor}44` }}
                  >
                    <Save className="w-4 h-4" /> 保存当前设置并应用场景
                  </button>
                  <button
                    type="button"
                    onClick={handleSceneOverwrite}
                    className={`w-full py-2.5 rounded-xl text-sm font-medium transition-all active:scale-[0.98] ${dark ? 'text-white/85' : 'text-black/80'}`}
                    style={{ background: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }}
                  >
                    直接覆盖
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSceneConfirm(null); setSceneName('') }}
                    className={`w-full py-2 rounded-xl text-xs transition-opacity hover:opacity-70 ${textTertiary}`}
                  >
                    取消
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
