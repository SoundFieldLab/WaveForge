import { Activity, AudioLines, BarChart3, Check, ChevronRight, Headphones, Settings2, SlidersHorizontal } from 'lucide-react'
import { RangeStyle, Toggle } from '../components/Primitives'
import { WaveformPanel } from '../components/WaveformPanel'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'

interface HomePageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
  onNavigate?: (page: string) => void
}

const QUICK_SCENES = [
  { id: 'studio', name: 'Hi-Fi', desc: '原声还原，保留细节' },
  { id: 'enhanced', name: '增强', desc: '现场感与低频冲击' },
  { id: 'dts', name: '影院', desc: '沉浸环绕，开阔声场' },
] as const

const AMBIENCE_OPTIONS = [
  { key: 'off', label: '无混响', type: null },
  { key: 'hall', label: '音乐厅', type: 'hall' },
  { key: 'plate', label: '录音室', type: 'plate' },
  { key: 'stage', label: '演唱会', type: 'stage' },
  { key: 'room', label: '地下室', type: 'room' },
  { key: 'custom', label: '自定义', type: 'custom' },
] as const

const QUICK_TOOLS = [
  {
    page: 'eq',
    label: '均衡器',
    description: '频段、增益与 Q 值',
    icon: SlidersHorizontal,
  },
  {
    page: 'spatial',
    label: '空间音效',
    description: '混响、3D 环绕与声场',
    icon: AudioLines,
  },
  {
    page: 'spatial-audio',
    label: '空间音频',
    description: '双耳声场、世界与舞台',
    icon: Headphones,
  },
  {
    page: 'dynamics',
    label: '动态调音',
    description: '压缩、齿音与夜间模式',
    icon: Activity,
  },
  {
    page: 'analysis',
    label: '分析',
    description: '频谱、响度与动态范围',
    icon: BarChart3,
  },
] as const

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function gainDbForVolume(volume: number): number {
  return (volume - 100) * 0.6
}

function volumeForGainDb(gainDb: number): number {
  return clamp(Math.round(100 + gainDb / 0.6), 0, 100)
}

function manualGainDb(params: ReturnType<V3UiBridge['getParams']>): number {
  const loudness = params.loudnessNormalization
  if (!loudness.enabled || loudness.useRealtimeMeter) return 0
  return clamp(loudness.externalGainDb, loudness.minGainDb, loudness.maxGainDb)
}

function modeDescription(params: ReturnType<V3UiBridge['getParams']>): string {
  if (params.loudnessNormalization.enabled && params.loudnessNormalization.useRealtimeMeter) {
    return `自动响度 · 目标 ${params.loudnessNormalization.targetLufs.toFixed(0)} LUFS`
  }
  if (params.loudnessNormalization.enabled) {
    const gain = manualGainDb(params)
    return `手动输出增益 · ${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`
  }
  return '响度归一化关闭'
}

function isAmbienceActive(
  params: ReturnType<V3UiBridge['getParams']>,
  option: (typeof AMBIENCE_OPTIONS)[number],
): boolean {
  if (option.key === 'off') return !params.reverb.enabled
  if (!params.reverb.enabled) return false
  if (option.key === 'custom') {
    return params.reverb.mode === 'convolution' || params.reverb.algorithmic.type === 'spring'
  }
  return params.reverb.mode === 'algorithmic' && params.reverb.algorithmic.type === option.type
}

function quickToolStatus(page: (typeof QUICK_TOOLS)[number]['page'], params: ReturnType<V3UiBridge['getParams']>): string {
  switch (page) {
    case 'eq':
      return params.eq.enabled ? `${params.eq.mode === 'pro' ? params.eq.bandCount : params.eq.simpleBands.length} 段已启用` : '均衡器已旁路'
    case 'spatial':
      return (params.reverb.enabled && params.reverb.mode !== 'off') || params.surround3d.enabled ? '空间效果已启用' : '空间效果未启用'
    case 'spatial-audio':
      return params.spatial && params.spatial.mode !== 'off' ? '空间渲染已启用' : '空间渲染未启用'
    case 'dynamics': {
      const enabled = [params.compressor.enabled, params.deesser.enabled, params.nightMode.enabled, params.limiter.enabled, params.ieq.enabled, params.pitch.enabled].filter(Boolean).length
      return enabled > 0 ? `${enabled} 项动态处理启用` : '动态处理未启用'
    }
    case 'analysis':
      return '查看实时读数'
  }
}

export default function HomePage({ bridge, controller, theme, onOpenEffect, onNavigate }: HomePageProps) {
  const { params, patch, replace, masterEnabled, setMasterEnabled } = controller
  const loudness = params.loudnessNormalization
  const automaticNormalization = loudness.enabled && loudness.useRealtimeMeter
  const actualGainDb = manualGainDb(params)
  const volume = volumeForGainDb(actualGainDb)
  const gainOutsideVolumeRange = actualGainDb > 0 || actualGainDb < -60
  const gainLabel = `${actualGainDb > 0 ? '+' : ''}${actualGainDb.toFixed(1)} dB`
  const activeScene = params.customized
    ? '自定义'
    : bridge.getScenes().find((scene) => scene.id === params.sceneId)?.name ?? '自定义'

  const setManualVolume = (value: number) => {
    const externalGainDb = gainDbForVolume(value)
    patch({
      loudnessNormalization: {
        enabled: true,
        useRealtimeMeter: false,
        externalGainDb,
        minGainDb: -60,
        maxGainDb: 12,
      },
    }, { markCustomized: false })
  }

  const switchToManual = () => {
    patch({
      loudnessNormalization: {
        enabled: true,
        useRealtimeMeter: false,
        externalGainDb: 0,
        minGainDb: -60,
        maxGainDb: 12,
      },
    }, { markCustomized: false })
  }

  const setAmbience = (key: (typeof AMBIENCE_OPTIONS)[number]['key']) => {
    if (key === 'custom') {
      onOpenEffect('reverb')
      return
    }

    if (key === 'off') {
      patch({ reverb: { enabled: false } })
      return
    }

    const option = AMBIENCE_OPTIONS.find((entry) => entry.key === key)
    if (!option || !option.type) return
    patch({
      reverb: {
        enabled: true,
        mode: 'algorithmic',
        algorithmic: { type: option.type as 'hall' | 'room' | 'plate' | 'spring' | 'stage' },
      },
    })
  }

  return (
    <div className="@container space-y-6">
      <RangeStyle theme={theme} />

      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className={`${theme.textPrimary} text-2xl font-semibold`}>声音工作台</h1>
            <div className="inline-flex items-center gap-2.5 rounded-full px-3 py-1.5" style={{ background: masterEnabled ? '#E2F5ED' : '#EAF0ED' }}>
              <span className={`${theme.textPrimary} text-xs font-medium`}>系统音效</span>
              <span className={`${theme.textSecondary} text-xs`} aria-live="polite">{masterEnabled ? '已开启' : '已关闭'}</span>
              <Toggle checked={masterEnabled} onChange={setMasterEnabled} theme={theme} label="系统音效" />
            </div>
          </div>
          <p className={`${theme.textSecondary} mt-1 text-sm`}>当前场景 · {activeScene}</p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate?.('scenes')}
          className="hse-glass-button inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-sm font-medium transition-colors hover:bg-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ color: theme.accentColor, outlineColor: theme.accentColor }}
          title="打开音效场景"
        >
          <Settings2 aria-hidden="true" className="h-4 w-4" />
          管理场景
          <ChevronRight aria-hidden="true" className="h-4 w-4" />
        </button>
      </header>

      <div className="grid gap-6 @min-[48rem]:grid-cols-[minmax(0,1fr)_minmax(280px,34%)]">
        <WaveformPanel bridge={bridge} theme={theme} />

        <aside className="rounded-2xl p-5 sm:p-6" style={{ background: '#E9F6F2' }} aria-label="输出控制">
          <section aria-labelledby="output-volume-heading">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="output-volume-heading" className={`${theme.textPrimary} text-base font-semibold`}>输出音量</h2>
                {automaticNormalization ? (
                  <p className={`${theme.textSecondary} mt-0.5 text-xs`}>{modeDescription(params)}</p>
                ) : (
                  <p className={`${theme.textSecondary} mt-0.5 text-xs`}>{loudness.enabled ? '手动输出电平' : '直通输出电平'}</p>
                )}
              </div>
              <output htmlFor="hse-output-volume" className="hse-mono text-4xl font-bold" style={{ color: theme.accentColor }}>
                {automaticNormalization ? '自动' : gainOutsideVolumeRange ? (
                  <>{actualGainDb > 0 ? '+' : ''}{actualGainDb.toFixed(1)}<span className="ml-1 text-base">dB</span></>
                ) : `${volume}%`}
              </output>
            </div>
            <input
              id="hse-output-volume"
              type="range"
              min={0}
              max={100}
              step={1}
              value={volume}
              disabled={automaticNormalization}
              aria-label="输出音量"
              aria-valuetext={automaticNormalization ? modeDescription(params) : gainOutsideVolumeRange ? `当前输出增益 ${gainLabel}，百分比滑块范围为 -60 至 0 dB` : `${volume}%，增益 ${gainLabel}`}
              onChange={(event) => setManualVolume(Number(event.currentTarget.value))}
              className="wf-hse-range mt-4 h-2 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-55"
              style={{ background: theme.sliderTrack(volume, 0, 100) }}
            />
            <div className={`hse-mono ${theme.textSecondary} mt-1.5 flex justify-between text-xs`} aria-hidden="true">
              <span>0</span><span>50</span><span>100</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className={`${theme.textSecondary} hse-mono text-xs`}>
                {automaticNormalization ? '音量由实时响度目标自动调整' : `输出增益 ${gainLabel}`}
              </p>
              {automaticNormalization && (
                <button
                  type="button"
                  onClick={switchToManual}
                  className="hse-glass-button min-h-9 rounded-md px-2 text-xs font-medium transition-colors hover:bg-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{ color: theme.accentColor, outlineColor: theme.accentColor }}
                >
                  切换到手动音量
                </button>
              )}
            </div>
            {!automaticNormalization && actualGainDb === -60 && (
              <p className="mt-1 text-xs" style={{ color: '#536B66' }}>0% 对应 -60 dB 最小输出电平，不是静音。</p>
            )}
            {!automaticNormalization && gainOutsideVolumeRange && (
              <p className={`${theme.textSecondary} mt-1 text-xs`}>当前增益超出百分比滑块范围；拖动滑块将切换到 -60 至 0 dB。</p>
            )}
          </section>

          <section className="mt-7" aria-labelledby="listening-mode-heading">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 id="listening-mode-heading" className={`${theme.textPrimary} text-base font-semibold`}>听感模式</h2>
              <span className={`${theme.textSecondary} text-xs`}>{params.customized ? '自定义配置' : '场景快捷应用'}</span>
            </div>
            <div className="hse-glass-group grid grid-cols-3 gap-1 rounded-full p-1" role="group" aria-label="听感模式">
              {QUICK_SCENES.map((scene) => {
                const active = params.sceneId === scene.id && !params.customized
                return (
                  <button
                    key={scene.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      bridge.applyScene(scene.id)
                      replace(bridge.getParams())
                    }}
                    title={scene.desc}
                    className={`hse-glass-choice min-h-11 rounded-full px-2 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 `}
                    style={{
                      color: active ? theme.accentColor : '#536B66',
                      outlineColor: theme.accentColor,
                    }}
                  >
                    {active && <Check aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />}
                    <span>{scene.name}</span>
                    <span className="sr-only">模式</span>
                  </button>
                )
              })}
            </div>
            <p className={`${theme.textSecondary} mt-2 min-h-5 text-sm`}>
              {QUICK_SCENES.find((scene) => scene.id === params.sceneId && !params.customized)?.desc ?? '当前参数与快捷场景不同'}
            </p>
            <button
              type="button"
              onClick={() => onNavigate?.('eq')}
              className="hse-glass-button mt-2 inline-flex min-h-10 items-center gap-1 rounded-md px-1 text-sm font-medium transition-colors hover:bg-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ color: theme.accentColor, outlineColor: theme.accentColor }}
            >
              详细调节 <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
            </button>
          </section>
        </aside>
      </div>

      <section className="border-t pt-4" style={{ borderColor: '#DCEAE5' }} aria-labelledby="ambience-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[165px]">
            <h2 id="ambience-heading" className={`${theme.textPrimary} text-base font-semibold`}>空间氛围</h2>
            <p className={`${theme.textSecondary} mt-0.5 text-sm`}>选择声音的空间感</p>
          </div>
          <div className="flex flex-1 flex-wrap gap-2" role="group" aria-label="环境混响">
            {AMBIENCE_OPTIONS.map((option) => {
              const active = isAmbienceActive(params, option)
              return (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setAmbience(option.key)}
                  className="hse-glass-choice min-h-10 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  style={{
                    color: active ? theme.accentColor : '#536B66',
                    outlineColor: theme.accentColor,
                  }}
                >
                  {active && <Check aria-hidden="true" className="mr-1 inline h-3.5 w-3.5" />}
                  {option.label}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => onOpenEffect('reverb')}
            className="hse-glass-button inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-sm font-medium transition-colors hover:bg-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ color: theme.accentColor, outlineColor: theme.accentColor }}
          >
            调整环境 <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </section>

      {onNavigate && (
        <section className="border-t pt-5" style={{ borderColor: '#DCEAE5' }} aria-labelledby="fine-tuning-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="fine-tuning-heading" className={`${theme.textPrimary} text-base font-semibold`}>精细调节</h2>
            <p className={`${theme.textSecondary} text-xs`}>进入对应页面，独立启停与调整参数</p>
          </div>
          <div className="grid gap-2 @min-[36rem]:grid-cols-2 @min-[48rem]:grid-cols-3 @min-[60rem]:grid-cols-5">
            {QUICK_TOOLS.map((tool) => {
              const Icon = tool.icon
              return (
                <button
                  key={tool.page}
                  type="button"
                  aria-label={`打开${tool.label}`}
                  onClick={() => onNavigate(tool.page)}
                  className="hse-glass-choice flex min-h-24 min-w-0 items-center gap-2.5 rounded-xl px-3 py-3 text-left"
                  style={{ color: theme.accentColor }}
                >
                  <Icon aria-hidden="true" className="h-5 w-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className={`${theme.textPrimary} block text-sm font-semibold`}>{tool.label}</span>
                    <span className={`${theme.textSecondary} mt-1 block text-xs leading-relaxed`}>{tool.description}</span>
                    <span className="mt-1 block text-xs">{quickToolStatus(tool.page, params)}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 opacity-70" />
                </button>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
