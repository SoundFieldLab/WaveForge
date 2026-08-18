import { AnimatePresence, motion } from 'framer-motion'
import type { ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import type { ExplorePlatform } from '../services/exploreApi'

export type ExploreSectionId = 'discover' | 'journey' | 'playlists' | 'charts' | 'newSongs' | 'albums' | 'channels'
export type ExploreDensity = 'comfortable' | 'compact'
export type ExploreContentAmount = 'curated' | 'expanded'
export type ExploreBackgroundIntensity = 'calm' | 'vivid'
export type ExploreBackgroundMode = 'gradient' | 'coverWall'
export type ExploreCoverWallStyle = 'tilted' | 'grid'
export type ExploreCardOpacity = 'solid' | 'frosted' | 'glass' | 'custom'

export interface ExplorePlatformPreferences {
  order: ExploreSectionId[]
  hidden: ExploreSectionId[]
  density: ExploreDensity
  contentAmount: ExploreContentAmount
  showDescriptions: boolean
  backgroundIntensity: ExploreBackgroundIntensity
  // 背景模式：gradient=渐变 / coverWall=歌曲封面墙
  backgroundMode: ExploreBackgroundMode
  // 封面墙样式：tilted=错落倾斜 / grid=规整网格
  coverWallStyle: ExploreCoverWallStyle
  // 封面墙动画（缓慢漂移）开关
  coverWallAnimated: boolean
  // 封面墙模糊遮罩强度（custom=自定义，用 coverWallBlurCustom 的像素值）
  coverWallBlur: 'soft' | 'medium' | 'strong' | 'custom'
  // 封面墙自定义模糊像素（0-80），coverWallBlur === 'custom' 时生效
  coverWallBlurCustom: number
  // 卡片玻璃化程度（custom=自定义，用 cardOpacityCustom 的百分比）
  cardOpacity: ExploreCardOpacity
  // 卡片自定义不透明度（0-100），cardOpacity === 'custom' 时生效
  cardOpacityCustom: number
  // 排行榜/新歌列表显示序号
  showRankNumbers: boolean
  // 启用平台增强 API（QQ 的 Skills 个性化推荐 / 网易云 VIP 音质等）
  enhancedApi: boolean
}

export interface ExplorePreferences {
  netease: ExplorePlatformPreferences
  qq: ExplorePlatformPreferences
  apple: ExplorePlatformPreferences
  spotify: ExplorePlatformPreferences
  kugou: ExplorePlatformPreferences
  soda: ExplorePlatformPreferences
}

export const EXPLORE_SECTION_LABELS: Record<ExploreSectionId, string> = {
  discover: '为你发现',
  journey: '音乐旅程',
  playlists: '推荐歌单',
  charts: '排行榜速览',
  newSongs: '最新音乐',
  albums: '新碟上架',
  channels: '声音与频道',
}

const BASE_ORDER: ExploreSectionId[] = ['discover', 'journey', 'playlists', 'charts', 'newSongs', 'channels']
const APPLE_ORDER: ExploreSectionId[] = ['discover', 'playlists', 'charts', 'newSongs', 'albums']
const THIRD_PARTY_ORDER: ExploreSectionId[] = ['discover', 'playlists', 'charts', 'newSongs', 'albums']
const PLATFORM_ORDER: Record<ExplorePlatform, ExploreSectionId[]> = {
  netease: BASE_ORDER,
  qq: BASE_ORDER,
  // Apple 与网易云/QQ 共享探索 UI，按能力表提供可用区块（无旅程/频道）
  apple: APPLE_ORDER,
  spotify: THIRD_PARTY_ORDER,
  kugou: THIRD_PARTY_ORDER,
  soda: THIRD_PARTY_ORDER,
}

const DEFAULT_PLATFORM_PREFS = {
  density: 'comfortable' as const,
  contentAmount: 'curated' as const,
  showDescriptions: true,
  backgroundIntensity: 'vivid' as const,
  backgroundMode: 'gradient' as const,
  coverWallStyle: 'tilted' as const,
  coverWallAnimated: true,
  coverWallBlur: 'medium' as const,
  coverWallBlurCustom: 40,
  cardOpacity: 'frosted' as const,
  cardOpacityCustom: 40,
  showRankNumbers: true,
  enhancedApi: true,
}

export const createDefaultExplorePreferences = (): ExplorePreferences => {
  const all = {} as ExplorePreferences
  for (const platform of Object.keys(PLATFORM_ORDER) as ExplorePlatform[]) {
    all[platform] = {
      order: [...PLATFORM_ORDER[platform]],
      hidden: [],
      ...DEFAULT_PLATFORM_PREFS,
    }
  }
  return all
}

export function normalizeExplorePreferences(input: unknown): ExplorePreferences {
  const defaults = createDefaultExplorePreferences()
  const raw = input && typeof input === 'object' ? input as Partial<Record<ExplorePlatform, Partial<ExplorePlatformPreferences>>> : {}

  for (const platform of Object.keys(PLATFORM_ORDER) as ExplorePlatform[]) {
    const source = raw[platform] || {}
    const defaultOrder = PLATFORM_ORDER[platform]
    const validOrder = Array.isArray(source.order)
      ? source.order.filter((item): item is ExploreSectionId => defaultOrder.includes(item as ExploreSectionId))
      : []
    const missing = defaultOrder.filter(item => !validOrder.includes(item))
    const hidden = Array.isArray(source.hidden)
      ? source.hidden.filter((item): item is ExploreSectionId => defaultOrder.includes(item as ExploreSectionId))
      : []
    let normalizedOrder = [...validOrder, ...missing]
    // 旧版本网易云没有旅程板块，QQ 旧偏好也可能缺失；升级后统一放在“为你发现”之后。
    // （Apple 等不支持旅程，不做此迁移）
    if (defaultOrder.includes('journey') && !validOrder.includes('journey')) {
      normalizedOrder = normalizedOrder.filter(item => item !== 'journey')
      normalizedOrder.splice(Math.max(0, normalizedOrder.indexOf('discover') + 1), 0, 'journey')
    }
    defaults[platform] = {
      order: normalizedOrder,
      hidden,
      density: source.density === 'compact' ? 'compact' : 'comfortable',
      contentAmount: source.contentAmount === 'expanded' ? 'expanded' : 'curated',
      showDescriptions: source.showDescriptions !== false,
      backgroundIntensity: source.backgroundIntensity === 'calm' ? 'calm' : 'vivid',
      backgroundMode: source.backgroundMode === 'coverWall' ? 'coverWall' : 'gradient',
      coverWallStyle: source.coverWallStyle === 'grid' ? 'grid' : 'tilted',
      coverWallAnimated: source.coverWallAnimated !== false,
      coverWallBlur:
        source.coverWallBlur === 'soft' || source.coverWallBlur === 'strong' || source.coverWallBlur === 'custom'
          ? source.coverWallBlur
          : 'medium',
      coverWallBlurCustom: Math.max(0, Math.min(80, Number(source.coverWallBlurCustom) || 40)),
      cardOpacity:
        source.cardOpacity === 'solid' || source.cardOpacity === 'glass' || source.cardOpacity === 'custom'
          ? source.cardOpacity
          : 'frosted',
      cardOpacityCustom: Math.max(0, Math.min(100, Number(source.cardOpacityCustom) || 40)),
      showRankNumbers: source.showRankNumbers !== false,
      enhancedApi: source.enhancedApi !== false,
    }
  }

  return defaults
}

interface ExploreSettingsPanelProps {
  show: boolean
  platform: ExplorePlatform
  preferences: ExplorePreferences
  accent: string
  playerTheme?: 'light' | 'dark'
  onClose: () => void
  onPlatformChange: (platform: ExplorePlatform) => void
  onChange: (preferences: ExplorePreferences) => void
}

export default function ExploreSettingsPanel({
  show,
  platform,
  preferences,
  accent,
  playerTheme = 'dark',
  onClose,
  onPlatformChange,
  onChange,
}: ExploreSettingsPanelProps) {
  const isDark = playerTheme === 'dark'
  // 主题配色：面板与卡片在浅色模式下换成浅色底 + 深色文字
  const panelBg = isDark ? 'bg-[#0b0e15]/92' : 'bg-white/[0.97]'
  const panelBorder = isDark ? 'border-white/[0.12]' : 'border-black/10'
  const borderSoft = isDark ? 'border-white/[0.08]' : 'border-black/[0.08]'
  const borderFaint = isDark ? 'border-white/[0.04]' : 'border-black/[0.06]'
  const textPrimary = isDark ? 'text-white' : 'text-black/90'
  const textSecondary = isDark ? 'text-white/60' : 'text-black/70'
  const textMuted = isDark ? 'text-white/42' : 'text-black/50'
  const chipBg = isDark ? 'bg-white/[0.06]' : 'bg-black/[0.06]'
  const cardBg = isDark ? 'bg-white/[0.035]' : 'bg-black/[0.04]'
  const rowBg = isDark ? 'bg-white/[0.045]' : 'bg-black/[0.05]'
  const rowBgFaint = isDark ? 'bg-white/[0.02]' : 'bg-black/[0.03]'
  const hoverBgSoft = isDark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.06]'
  const hoverBg = isDark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.08]'
  const hoverBgStrong = isDark ? 'hover:bg-white/[0.1]' : 'hover:bg-black/[0.1]'
  const hoverTextStrong = isDark ? 'hover:text-white' : 'hover:text-black'
  const hoverTextSoft = isDark ? 'hover:text-white/78' : 'hover:text-black/80'
  const hoverTextMid = isDark ? 'hover:text-white/72' : 'hover:text-black/75'
  const current = preferences[platform]
  const sectionLabel = (section: ExploreSectionId) => section === 'journey'
    ? (platform === 'netease' ? '网易云音乐旅程' : 'QQ 音乐旅程')
    : EXPLORE_SECTION_LABELS[section]

  const updateCurrent = (patch: Partial<ExplorePlatformPreferences>) => {
    onChange({ ...preferences, [platform]: { ...current, ...patch } })
  }

  const moveSection = (section: ExploreSectionId, direction: -1 | 1) => {
    const index = current.order.indexOf(section)
    const target = index + direction
    if (index < 0 || target < 0 || target >= current.order.length) return
    const next = [...current.order]
    ;[next[index], next[target]] = [next[target], next[index]]
    updateCurrent({ order: next })
  }

  const toggleSection = (section: ExploreSectionId) => {
    updateCurrent({
      hidden: current.hidden.includes(section)
        ? current.hidden.filter(item => item !== section)
        : [...current.hidden, section],
    })
  }

  const resetCurrent = () => {
    const defaults = createDefaultExplorePreferences()
    onChange({ ...preferences, [platform]: defaults[platform] })
  }

  return (
    <AnimatePresence>
      {show && (
        <div className="pointer-events-none fixed inset-0 z-[180]">
          <motion.button
            type="button"
            aria-label="关闭探索设置"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            onWheel={event => {
              // 遮罩拦截了滚轮：转发给探索页滚动容器，让用户边设置边滚动看实时效果
              event.stopPropagation()
              const container = document.querySelector<HTMLElement>('.explore-scrollbar')
              if (container) container.scrollBy(0, event.deltaY)
            }}
            className="pointer-events-auto absolute inset-0 bg-transparent"
          />
          <motion.aside
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 280 }}
            className={`pointer-events-auto absolute bottom-4 right-4 top-8 flex w-[calc(100%_-_32px)] max-w-[480px] flex-col overflow-hidden rounded-[28px] border backdrop-blur-2xl ${panelBg} ${panelBorder} shadow-[0_28px_90px_rgba(0,0,0,0.55)]`}
          >
            <div className={`flex items-center justify-between border-b px-6 py-4 ${borderSoft}`}>
              <div>
                <div className={`flex items-center gap-2 text-lg font-semibold ${textPrimary}`}>
                  <SlidersHorizontal className="h-5 w-5" style={{ color: accent }} />
                  探索页设置
                </div>
                <p className={`mt-1 text-xs ${textMuted}`}>调整会立即同步到面板背后的真实探索页</p>
              </div>
              <button type="button" onClick={onClose} className={`rounded-xl p-2 transition ${chipBg} ${textSecondary} ${hoverBgStrong} ${hoverTextStrong}`}>
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="explore-scrollbar flex-1 overflow-y-auto px-6 py-5">
              <div className={`mb-6 grid grid-cols-2 rounded-2xl border p-1 ${borderSoft} ${cardBg}`}>
                {(['netease', 'qq'] as ExplorePlatform[]).map(item => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => onPlatformChange(item)}
                    className={`rounded-xl px-4 py-2.5 text-sm transition ${item === platform ? 'text-[#071018]' : `${textMuted} ${hoverTextSoft}`}`}
                    style={{ background: item === platform ? accent : 'transparent' }}
                  >
                    {item === 'netease' ? '网易云布局' : 'QQ 音乐布局'}
                  </button>
                ))}
              </div>

              <section className="mb-7">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h3 className={`text-sm font-semibold ${textPrimary}`}>板块排序与显隐</h3>
                    <p className={`mt-1 text-xs ${textMuted}`}>使用箭头调整首页顺序，眼睛按钮控制显示。</p>
                  </div>
                  <button type="button" onClick={resetCurrent} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition ${textMuted} ${hoverBgSoft} ${hoverTextMid}`}>
                    <RotateCcw className="h-3.5 w-3.5" /> 重置
                  </button>
                </div>
                <div className="space-y-2">
                  {current.order.map((section, index) => {
                    const visible = !current.hidden.includes(section)
                    return (
                      <div key={section} className={`flex items-center gap-3 rounded-2xl border p-3 transition ${visible ? `${borderSoft} ${rowBg}` : `${borderFaint} ${rowBgFaint} opacity-55`}`}>
                        <span className={`flex h-8 w-8 items-center justify-center rounded-xl text-xs ${chipBg} ${textMuted}`}>{index + 1}</span>
                        <span className={`min-w-0 flex-1 text-sm font-medium ${textPrimary}`}>{sectionLabel(section)}</span>
                        <button type="button" onClick={() => moveSection(section, -1)} disabled={index === 0} className={`rounded-lg p-1.5 transition ${textMuted} ${hoverBg} ${hoverTextStrong} disabled:opacity-20`} aria-label={`上移${sectionLabel(section)}`}>
                          <ArrowUp className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => moveSection(section, 1)} disabled={index === current.order.length - 1} className={`rounded-lg p-1.5 transition ${textMuted} ${hoverBg} ${hoverTextStrong} disabled:opacity-20`} aria-label={`下移${sectionLabel(section)}`}>
                          <ArrowDown className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => toggleSection(section)} className={`rounded-lg p-1.5 transition ${textSecondary} ${hoverBg} ${hoverTextStrong}`} aria-label={`${visible ? '隐藏' : '显示'}${sectionLabel(section)}`}>
                          {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>

              <section className="mb-7 space-y-4">
                <h3 className={`text-sm font-semibold ${textPrimary}`}>背景与氛围</h3>
                <SettingChoice
                  label="背景模式"
                  description="渐变=当前平台主题色；封面墙=用每日推荐/猜你喜欢的歌曲封面拼成动态海报墙。"
                  value={current.backgroundMode}
                  options={[['gradient', '渐变'], ['coverWall', '封面墙']]}
                  accent={accent}
                  isDark={isDark}
                  onChange={value => updateCurrent({ backgroundMode: value as ExploreBackgroundMode })}
                />
                {current.backgroundMode === 'coverWall' && (
                  <>
                    <SettingChoice
                      label="封面墙样式"
                      description="错落倾斜更像实体海报墙；规整网格更清爽。"
                      value={current.coverWallStyle}
                      options={[['tilted', '错落倾斜'], ['grid', '规整网格']]}
                      accent={accent}
                      isDark={isDark}
                      onChange={value => updateCurrent({ coverWallStyle: value as ExploreCoverWallStyle })}
                    />
                    <SettingChoice
                      label="封面墙模糊"
                      description="遮罩越强，前景内容越清晰；选择「自定义」可精确调节像素。"
                      value={current.coverWallBlur}
                      options={[['soft', '轻微'], ['medium', '适中'], ['strong', '强烈'], ['custom', '自定义']]}
                      accent={accent}
                      isDark={isDark}
                      onChange={value => updateCurrent({ coverWallBlur: value as 'soft' | 'medium' | 'strong' | 'custom' })}
                    >
                      {current.coverWallBlur === 'custom' && (
                        <div className={`mt-3 flex items-center gap-3 rounded-2xl border p-3 ${borderSoft}`}>
                          <input
                            type="range"
                            min={0}
                            max={80}
                            value={current.coverWallBlurCustom}
                            onChange={e => updateCurrent({ coverWallBlurCustom: Number(e.target.value) })}
                            className="flex-1 accent-[#4fc3f7]"
                            aria-label="封面墙自定义模糊"
                          />
                          <span className={`w-12 shrink-0 text-right text-xs font-semibold ${textPrimary}`}>
                            {current.coverWallBlurCustom}px
                          </span>
                        </div>
                      )}
                    </SettingChoice>
                    <ToggleRow
                      label="封面墙动画"
                      description="封面缓慢漂移，营造呼吸感。"
                      checked={current.coverWallAnimated}
                      accent={accent}
                      isDark={isDark}
                      onChange={value => updateCurrent({ coverWallAnimated: value })}
                    />
                  </>
                )}
                {current.backgroundMode !== 'coverWall' && (
                  <SettingChoice
                    label="背景氛围"
                    description="控制平台主题色在背景中的强度（封面墙模式使用封面墙背景，无需此选项）。"
                    value={current.backgroundIntensity}
                    options={[['calm', '柔和'], ['vivid', '鲜明']]}
                    accent={accent}
                    isDark={isDark}
                    onChange={value => updateCurrent({ backgroundIntensity: value as ExploreBackgroundIntensity })}
                  />
                )}
              </section>

              <section className="mb-7 space-y-4">
                <h3 className={`text-sm font-semibold ${textPrimary}`}>内容与视觉</h3>
                <SettingChoice
                  label="首页内容量"
                  description="扩展模式会直接在首页展示更多卡片。"
                  value={current.contentAmount}
                  options={[['curated', '精选'], ['expanded', '扩展']]}
                  accent={accent}
                  isDark={isDark}
                  onChange={value => updateCurrent({ contentAmount: value as ExploreContentAmount })}
                />
                <SettingChoice
                  label="卡片密度"
                  description="紧凑模式适合较小窗口或一次浏览更多内容。"
                  value={current.density}
                  options={[['comfortable', '舒适'], ['compact', '紧凑']]}
                  accent={accent}
                  isDark={isDark}
                  onChange={value => updateCurrent({ density: value as ExploreDensity })}
                />
                <SettingChoice
                  label="卡片质感"
                  description="毛玻璃=半透明磨砂；高透=更通透；实心=更厚重；选择「自定义」可精确调节不透明度。"
                  value={current.cardOpacity}
                  options={[['frosted', '毛玻璃'], ['glass', '高透'], ['solid', '实心'], ['custom', '自定义']]}
                  accent={accent}
                  isDark={isDark}
                  onChange={value => updateCurrent({ cardOpacity: value as ExploreCardOpacity })}
                >
                  {current.cardOpacity === 'custom' && (
                    <div className={`mt-3 flex items-center gap-3 rounded-2xl border p-3 ${borderSoft}`}>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={current.cardOpacityCustom}
                        onChange={e => updateCurrent({ cardOpacityCustom: Number(e.target.value) })}
                        className="flex-1 accent-[#4fc3f7]"
                        aria-label="卡片质感自定义不透明度"
                      />
                      <span className={`w-12 shrink-0 text-right text-xs font-semibold ${textPrimary}`}>
                        {current.cardOpacityCustom}%
                      </span>
                    </div>
                  )}
                </SettingChoice>
                <ToggleRow
                  label="显示板块说明"
                  description="保留标题下方的推荐逻辑和内容说明。"
                  checked={current.showDescriptions}
                  accent={accent}
                  isDark={isDark}
                  onChange={value => updateCurrent({ showDescriptions: value })}
                />
                <ToggleRow
                  label="显示排行序号"
                  description="排行榜与最新音乐列表左侧显示 1/2/3 序号。"
                  checked={current.showRankNumbers}
                  accent={accent}
                  isDark={isDark}
                  onChange={value => updateCurrent({ showRankNumbers: value })}
                />
              </section>

              <section className="mb-7 space-y-4">
                <h3 className={`text-sm font-semibold ${textPrimary}`}>平台增强</h3>
                <ToggleRow
                  label={platform === 'qq' ? 'QQ 个性化推荐（Skills）' : platform === 'apple' ? 'Apple 目录增强' : '网易云个性化推荐'}
                  description={platform === 'qq'
                    ? '启用登录后的每日 30 首 / 猜你喜欢 / AI 歌单等增强推荐；关闭则只使用公开榜单与热门。'
                    : platform === 'apple'
                      ? '使用已配置的 Developer Token 获取更丰富的目录数据；未配置时使用公开 RSS 榜单。'
                      : '启用登录后的每日推荐 / 私人漫游等个性化内容。'}
                  checked={current.enhancedApi}
                  accent={accent}
                  isDark={isDark}
                  onChange={value => updateCurrent({ enhancedApi: value })}
                />
              </section>

              <p className={`rounded-2xl border px-4 py-3 text-xs leading-relaxed ${borderSoft} ${cardBg} ${textMuted}`}>
                当前就是实时预览。移动、隐藏板块或切换密度后，左侧真实页面会立即更新；关闭设置即可继续浏览。
              </p>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  )
}

function SettingChoice({
  label,
  description,
  value,
  options,
  accent,
  isDark,
  onChange,
  children,
}: {
  label: string
  description: string
  value: string
  options: Array<[string, string]>
  accent: string
  isDark: boolean
  onChange: (value: string) => void
  children?: ReactNode
}) {
  const borderSoft = isDark ? 'border-white/[0.08]' : 'border-black/[0.08]'
  const cardBg = isDark ? 'bg-white/[0.035]' : 'bg-black/[0.04]'
  const textPrimary = isDark ? 'text-white' : 'text-black/90'
  const textMuted = isDark ? 'text-white/42' : 'text-black/50'
  const hoverTextSoft = isDark ? 'hover:text-white/75' : 'hover:text-black/75'
  return (
    <div className={`rounded-2xl border p-4 ${borderSoft} ${cardBg}`}>
      <div className="mb-3">
        <span className={`block text-sm font-medium ${textPrimary}`}>{label}</span>
        <span className={`mt-1 block text-xs ${textMuted}`}>{description}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {options.map(([option, text]) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`rounded-xl border px-3 py-2 text-xs transition ${value === option ? 'text-[#071018]' : `${borderSoft} ${cardBg} ${textMuted} ${hoverTextSoft}`}`}
            style={value === option ? { background: accent, borderColor: accent } : undefined}
          >
            {text}
          </button>
        ))}
      </div>
      {children}
    </div>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  accent,
  isDark,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  accent: string
  isDark: boolean
  onChange: (value: boolean) => void
}) {
  const borderSoft = isDark ? 'border-white/[0.08]' : 'border-black/[0.08]'
  const cardBg = isDark ? 'bg-white/[0.035]' : 'bg-black/[0.04]'
  const textPrimary = isDark ? 'text-white' : 'text-black/90'
  const textMuted = isDark ? 'text-white/42' : 'text-black/50'
  return (
    <label className={`flex cursor-pointer items-center justify-between rounded-2xl border p-4 ${borderSoft} ${cardBg}`}>
      <span className="pr-3">
        <span className={`block text-sm font-medium ${textPrimary}`}>{label}</span>
        <span className={`mt-1 block text-xs ${textMuted}`}>{description}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative h-6 w-11 shrink-0 rounded-full transition"
        style={{ background: checked ? accent : isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.14)' }}
      >
        <span
          className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all"
          style={{ left: checked ? 22 : 2 }}
        />
      </button>
    </label>
  )
}
