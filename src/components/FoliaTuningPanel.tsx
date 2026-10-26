/**
 * Folia 模式参数面板宿主。
 *
 * 上游把各模式的参数面板挂在 registry entry 的 `renderSettingsPanel` 上，由它自己的
 * 设置界面（VisPlayground / 设置弹窗）渲染；WaveForge 没有那套外壳，所以这些面板
 * 一直躺在 vendor 里没人调用。这里按注册表驱动：谁声明了面板就渲染谁，
 * 新增模式不用改这个文件。
 *
 * 滑块沿用上游的「草稿 / 松手提交」语义：拖动过程中只更新本地草稿（每帧写 localStorage
 * 会卡），松手才落盘。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getVisualizerRegistryEntry } from '../vendor/folia/components/visualizer/registry'
import type { VisualizerSettingsPanelProps } from '../vendor/folia/components/visualizer/definition'
import { buildFoliaPanelStyles, buildFoliaTheme } from './foliaTunings'
import {
  readSmartBeatSettings,
  writeSmartBeatSettings,
  notifySmartBeatChanged,
  type SmartBeatSettings,
} from '../vendor/folia/components/visualizer/smartBeatSettings'
import { SMART_BEAT_EFFECT_IDS } from '../vendor/folia/components/visualizer/sonnet/smartBeat'
import { BEAT_EFFECT_IDS as FOLIA_BEAT_EFFECT_IDS } from '../vendor/folia/services/beatFx/beatEffects'

/** 花火的两个智能动感效果：id 与面板显示名（上游 options.beatEffect_hanabiBeat*）。 */
const HANABI_BEAT_BURSTS_ID = FOLIA_BEAT_EFFECT_IDS.hanabiBeatBursts
const HANABI_BEAT_PULSE_ID = FOLIA_BEAT_EFFECT_IDS.hanabiBeatPulse
const HANABI_BEAT_EFFECT_LABELS: Record<string, string> = {
  [HANABI_BEAT_BURSTS_ID]: '随拍开花',
  [HANABI_BEAT_PULSE_ID]: '随拍推镜',
}

export interface FoliaTuningPanelProps {
  /** 当前 folia 模式 id */
  mode: string
  /** 该模式当前生效的调参（已含上下文推导，例如绘光的 darkField / renderQuality） */
  tuning: Record<string, unknown> | undefined
  /** 落盘：把整份调参写回（仅在选择/开关/松手时调用） */
  onCommit: (next: Record<string, unknown>) => void
  onReset: () => void
  hasOverride: boolean
  playerTheme: 'dark' | 'light'
  accentColor: string
}

/** mode → 上游面板读取的 props 名（`lumiere` → `lumiereTuning` / `onLumiereTuningChange`）。 */
const tuningPropName = (mode: string) => `${mode}Tuning`
const tuningSetterName = (mode: string) => `on${mode.charAt(0).toUpperCase()}${mode.slice(1)}TuningChange`

export function FoliaTuningPanel({
  mode,
  tuning,
  onCommit,
  onReset,
  hasOverride,
  playerTheme,
  accentColor,
}: FoliaTuningPanelProps) {
  const { t } = useTranslation()
  const entry = getVisualizerRegistryEntry(mode as never)
  const renderSettingsPanel = entry?.renderSettingsPanel
  const isDaylight = playerTheme === 'light'
  const theme = useMemo(() => buildFoliaTheme({ playerTheme, accentColor }), [playerTheme, accentColor])
  const styles = useMemo(() => buildFoliaPanelStyles(theme, isDaylight), [theme, isDaylight])

  // 草稿：拖动中只改这里，松手才提交
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null)
  const draggingRef = useRef(false)
  // 换模式时丢弃草稿，否则会把上一个模式的键带进新模式的 tuning
  useEffect(() => { setDraft(null); draggingRef.current = false }, [mode])

  const effective = (draft ?? tuning ?? {}) as Record<string, unknown>

  const handleChange = (patch: Record<string, unknown>) => {
    const next = { ...effective, ...patch }
    setDraft(next)
    if (!draggingRef.current) onCommit(next)
  }
  const handleSliderPointerDown = () => { draggingRef.current = true }
  const handleSliderCommit = () => {
    if (!draggingRef.current) return
    draggingRef.current = false
    if (draft) onCommit(draft)
  }

  if (!renderSettingsPanel) return null

  const panelProps = {
    t,
    isDaylight,
    theme,
    controlCardBg: styles.controlCardBg,
    rangeInputClass: styles.rangeInputClass,
    [tuningPropName(mode)]: effective,
    [tuningSetterName(mode)]: handleChange,
    onSliderPointerDown: handleSliderPointerDown,
    onSliderCommit: handleSliderCommit,
  } as unknown as VisualizerSettingsPanelProps

  return (
    <div className="space-y-2">
      {mode === 'lumiere' && (
        // 上游明确写了绘光的歌词字号由各光位的文字区自动计算，通用字号设置只影响底部字幕。
        // 不提示的话用户会以为「字体大小」这个设置坏了。
        <p className={`rounded-lg px-2.5 py-2 text-[10px] leading-relaxed ${playerTheme === 'dark' ? 'bg-white/[0.06] text-white/55' : 'bg-black/[0.05] text-black/55'}`}>
          {t('options.lumiereFontSizeAutoNotice')}
        </p>
      )}
      {(mode === 'sonnet' || mode === 'diorama' || mode === 'pendolo' || mode === 'hanabi') && (
        // 智能动感模式（Smart Beat，folia 0.7.21）：节拍驱动的镜头推近/裂光/粒子涟漪。
        // 总开关 + 各效果开关与强度；设置存 localStorage 并经事件通知挂载中的 runtime。
        <SmartBeatSection playerTheme={playerTheme} accentColor={accentColor} mode={mode} />
      )}
      {hasOverride && (
        <button
          type="button"
          onClick={onReset}
          className={`w-full rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${playerTheme === 'dark' ? 'text-white/60 hover:bg-white/[0.08] hover:text-white' : 'text-black/55 hover:bg-black/[0.06] hover:text-black'}`}
        >
          {t('ui.resetVisualizerTuning')}
        </button>
      )}
      {renderSettingsPanel(panelProps)}
    </div>
  )
}

export default FoliaTuningPanel

// ── 智能动感模式（Smart Beat）设置区 ──────────────────────────────
// folia 0.7.21 的 Smart Beat：节拍驱动动效（商籁的镜头推近/裂光等），总开关 +
// 各效果独立开关与强度。存储与事件经 smartBeatSettings.ts；效果 id 与文案随模式。

const SMART_BEAT_EFFECT_LABELS: Record<string, string> = {
  ...HANABI_BEAT_EFFECT_LABELS,
  'sonnet.beatZoom': '每拍镜头推近',
  'sonnet.downbeatZoom': '重拍额外推近',
  'sonnet.beatRotation': '每拍旋转',
  'sonnet.tear': '重拍裂光',
  'sonnet.flare': '亮斑',
  'sonnet.iconPop': '图标弹跳',
  'diorama.ripple': '粒子涟漪',
  'diorama.wordHop': '歌词跳动',
  'pendolo.kick': '底鼓起伏',
  'pendolo.snare': '军鼓起伏',
  'pendolo.hihat': '镲片闪烁',
}

interface SmartBeatSectionProps {
  playerTheme: 'dark' | 'light'
  accentColor: string
  mode: string
}

function SmartBeatSection({ playerTheme, accentColor, mode }: SmartBeatSectionProps) {
  const defaults = useMemo<SmartBeatSettings>(() => ({
    enabled: true,
    effects: Object.fromEntries(
      Object.values(SMART_BEAT_EFFECT_IDS).map(id => [id, { on: true, strength: 1 }]),
    ),
  }), [])
  const [settings, setSettings] = useState<SmartBeatSettings>(() => readSmartBeatSettings(defaults))

  const persist = (next: SmartBeatSettings) => {
    setSettings(next)
    writeSmartBeatSettings(next)
    notifySmartBeatChanged()
  }

  const toggleEnabled = () => persist({ ...settings, enabled: !settings.enabled })
  const toggleEffect = (id: string) => {
    const current = settings.effects[id] ?? { on: true, strength: 1 }
    persist({ ...settings, effects: { ...settings.effects, [id]: { ...current, on: !current.on } } })
  }
  const setStrength = (id: string, strength: number) => {
    const current = settings.effects[id] ?? { on: true, strength: 1 }
    persist({ ...settings, effects: { ...settings.effects, [id]: { ...current, strength } } })
  }

  // 本模式的效果清单：sonnet 全集；diorama/pendolo 的效果在各自 runtime 接线时加入；
  // 花火用自己的两个效果（随拍开花/随拍推镜，离线节拍表驱动）。
  const effectIds: string[] = mode === 'hanabi'
    ? [HANABI_BEAT_BURSTS_ID, HANABI_BEAT_PULSE_ID]
    : (Object.values(SMART_BEAT_EFFECT_IDS) as string[])
      .filter(id => mode !== 'sonnet' || !/^(diorama|pendolo)\./.test(id))

  const card = playerTheme === 'dark' ? 'bg-white/[0.05] border-white/10' : 'bg-black/[0.03] border-black/10'
  const textMain = playerTheme === 'dark' ? 'text-white/85' : 'text-black/80'
  const textSub = playerTheme === 'dark' ? 'text-white/50' : 'text-black/50'

  return (
    <div className={`rounded-xl border p-2.5 space-y-2 ${card}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className={`text-[12px] font-medium ${textMain}`}>智能动感模式</p>
          <p className={`text-[10px] leading-relaxed ${textSub}`}>跟拍点与鼓点动起来；需要播放中才有节拍</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          onClick={toggleEnabled}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${settings.enabled ? '' : 'opacity-60'}`}
          style={{ backgroundColor: settings.enabled ? accentColor : (playerTheme === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)') }}
        >
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-200 ${settings.enabled ? 'left-[18px]' : 'left-0.5'}`} />
        </button>
      </div>
      {settings.enabled && (
        <div className="space-y-1.5">
          {effectIds.map(id => {
            const effect = settings.effects[id] ?? { on: true, strength: 1 }
            return (
              <div key={id} className="rounded-lg bg-black/[0.12] px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => toggleEffect(id)}
                    className={`min-w-0 flex-1 text-left text-[11px] transition-colors ${effect.on ? textMain : 'opacity-45 line-through'} ${playerTheme === 'dark' ? 'hover:text-white' : 'hover:text-black'}`}
                  >
                    {SMART_BEAT_EFFECT_LABELS[id] ?? id}
                  </button>
                  <span className="shrink-0 font-mono text-[10px] text-white/40">{effect.strength.toFixed(1)}×</span>
                </div>
                {effect.on && (
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={effect.strength}
                    onChange={event => setStrength(id, Number(event.target.value))}
                    onMouseUp={() => { /* 拖动即落盘（folia 的 strength 无草稿需求） */ }}
                    className="mt-1 w-full accent-current"
                    style={{ accentColor }}
                    aria-label={`${SMART_BEAT_EFFECT_LABELS[id] ?? id} 强度`}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
