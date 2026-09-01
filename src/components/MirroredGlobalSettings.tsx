/**
 * 全局设置镜像渲染器（配合 services/globalSettingsRegistry.ts）
 *
 * 同一张注册表，两种渲染风格：
 * - classic：传统模式设置页的 QQ 音乐式布局 —— 分组标题 + 左侧类目 + 右侧圆形勾选项；
 * - panel：探索模式抽屉 / 桌面模式弹窗的卡片行式布局 —— 左文案右控件。
 *
 * 各模式只提供一套皮肤色板（MirrorSkin），不照搬简约模式的 UI；
 * 注册表新增条目后这里零改动自动出现，实现"简约模式设置 = 总设置，其他模式镜像"。
 */
import { useCallback, useEffect, useState } from 'react'
import { Reorder } from 'framer-motion'
import { Check, ChevronRight, Eye, EyeOff, GripVertical, Loader2, Music, RefreshCw } from 'lucide-react'
import FontPicker, { DEFAULT_FONT_LABEL, BUNDLED_FONTS, RECOMMENDED_FONTS } from './FontPicker'
import {
  GLOBAL_SETTINGS_GROUPS,
  getAboutVersion,
  isEntryVisible,
  toast,
  useGlobalSettings,
  type GlobalSettingsGroupId,
  type GlobalSettingEntry,
  type MirrorActionId,
  type SettingValue,
} from '../services/globalSettingsRegistry'
import {
  MUSIC_PLATFORMS,
  PLATFORM_LABELS,
  PLATFORM_ORDER_EVENT,
  PLATFORM_VISIBILITY_EVENT,
  getHiddenPlatforms,
  getPlatformOrder,
  setPlatformHidden,
  setPlatformOrder,
  type MusicPlatform,
} from '../services/platforms'

// ─────────────────────────── 皮肤 ───────────────────────────

export interface MirrorSkin {
  dark: boolean
  accent: string
  /** 分组卡片背景（panel 用；classic 里作为悬浮底色） */
  cardBg: string
  cardBorder: string
  /** 控件（选项块/输入）底色 */
  controlBg: string
  text: string
  sub: string
  muted: string
  /** 圆角（px），探索 16 / 桌面 12 / 传统 12 由调用方定 */
  radius: number
}

export function makeSkin(partial: Partial<MirrorSkin> & { dark: boolean; accent: string }): MirrorSkin {
  const { dark, accent } = partial
  return {
    dark,
    accent,
    cardBg: partial.cardBg ?? (dark ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.72)'),
    cardBorder: partial.cardBorder ?? (dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.08)'),
    controlBg: partial.controlBg ?? (dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'),
    text: partial.text ?? (dark ? 'rgba(255,255,255,0.92)' : 'rgba(15,23,42,0.92)'),
    sub: partial.sub ?? (dark ? 'rgba(255,255,255,0.55)' : 'rgba(15,23,42,0.6)'),
    muted: partial.muted ?? (dark ? 'rgba(255,255,255,0.38)' : 'rgba(15,23,42,0.42)'),
    radius: partial.radius ?? 12,
  }
}

// ─────────────────────────── 基础控件 ───────────────────────────

function RoundCheck({ checked, accent, dark }: { checked: boolean; accent: string; dark: boolean }) {
  return (
    <span
      className="mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-2 transition-all"
      style={{
        borderColor: checked ? accent : dark ? 'rgba(255,255,255,0.28)' : 'rgba(15,23,42,0.3)',
        background: checked ? accent : 'transparent',
      }}
    >
      {checked && <Check className="h-3 w-3 text-white" strokeWidth={3.5} />}
    </span>
  )
}

function PanelSwitch({ checked, accent, dark }: { checked: boolean; accent: string; dark: boolean }) {
  return (
    <span
      className="relative inline-block h-6 w-11 flex-shrink-0 rounded-full transition-colors"
      style={{ background: checked ? accent : dark ? 'rgba(255,255,255,0.14)' : 'rgba(15,23,42,0.16)' }}
    >
      <span
        className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all"
        style={{ left: checked ? 22 : 2 }}
      />
    </span>
  )
}

// ─────────────────────────── 行渲染 ───────────────────────────

/** 字体族名 → 展示名（与 FontPicker 的标签保持一致） */
function fontLabel(family: string): string {
  const name = (family || '').trim()
  if (!name) return DEFAULT_FONT_LABEL
  const bundled = BUNDLED_FONTS.find(f => f.value === name)
  if (bundled) return bundled.label
  const recommended = RECOMMENDED_FONTS.find(f => f.value === name)
  return recommended ? recommended.label : name
}

type RowProps = {
  entry: GlobalSettingEntry
  value: SettingValue | undefined
  skin: MirrorSkin
  onToggle: (entry: GlobalSettingEntry, value: boolean) => void
  onChoice: (entry: GlobalSettingEntry, value: string) => void
  onSlide: (entry: GlobalSettingEntry, value: number) => void
  onAction: (entry: GlobalSettingEntry) => void
  onFont?: (entry: GlobalSettingEntry, family: string) => void
  busyActions?: Record<string, boolean>
}

function ClassicEntryRow({ entry, value, skin, onToggle, onChoice, onSlide, onAction, onFont, busyActions }: RowProps) {
  const { control } = entry

  if (control.kind === 'toggle') {
    const checked = value === true
    return (
      <button
        type="button"
        onClick={() => onToggle(entry, !checked)}
        className="flex items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
      >
        <RoundCheck checked={checked} accent={skin.accent} dark={skin.dark} />
        <span className="min-w-0">
          <span className="block text-[13px] leading-5" style={{ color: skin.text }}>{entry.label}</span>
          {entry.description && (
            <span className="mt-0.5 block text-[11px] leading-4" style={{ color: skin.muted }}>{entry.description}</span>
          )}
        </span>
      </button>
    )
  }

  if (control.kind === 'font-picker') {
    const family = String(value ?? '')
    return (
      <div className="px-2.5 py-2">
        <div className="text-[13px] leading-5" style={{ color: skin.text }}>{entry.label}</div>
        {entry.description && <div className="mt-0.5 text-[11px] leading-4" style={{ color: skin.muted }}>{entry.description}</div>}
        <div className="mt-2">
          <FontPicker
            value={family}
            onChange={family => onFont?.(entry, family)}
            dark={skin.dark}
            accent={skin.accent}
            buttonWidth={236}
          />
        </div>
      </div>
    )
  }

  if (control.kind === 'choice') {
    const isColor = entry.id === 'accentColor'
    return (
      <div className="px-2.5 py-2">
        <div className="text-[13px] leading-5" style={{ color: skin.text }}>{entry.label}</div>
        {entry.description && <div className="mt-0.5 text-[11px] leading-4" style={{ color: skin.muted }}>{entry.description}</div>}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {control.options.map(option => {
            const active = String(value) === option.value
            return (
              <button
                key={option.value}
                type="button"
                title={option.hint}
                onClick={() => onChoice(entry, option.value)}
                className="flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs transition-all"
                style={{
                  borderColor: active ? skin.accent : skin.cardBorder,
                  background: active ? `${skin.accent}1f` : 'transparent',
                  color: active ? skin.accent : skin.sub,
                  fontWeight: active ? 600 : 400,
                }}
              >
                {isColor && (
                  <span className="h-3 w-3 rounded-full border border-white/40" style={{ background: option.value }} />
                )}
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (control.kind === 'slider') {
    const numeric = Number(value ?? control.min)
    return (
      <div className="px-2.5 py-2">
        <div className="flex items-center justify-between">
          <span className="text-[13px] leading-5" style={{ color: skin.text }}>{entry.label}</span>
          <span className="text-xs tabular-nums" style={{ color: skin.sub }}>
            {numeric}{control.unit || ''}
          </span>
        </div>
        {entry.description && <div className="mt-0.5 text-[11px] leading-4" style={{ color: skin.muted }}>{entry.description}</div>}
        <input
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={numeric}
          onChange={event => onSlide(entry, Number(event.target.value))}
          className="mt-2 w-full cursor-pointer"
          style={{ accentColor: skin.accent, background: skin.controlBg }}
        />
      </div>
    )
  }

  // action
  const busy = busyActions?.[control.actionId]
  return (
    <button
      type="button"
      onClick={() => onAction(entry)}
      className="group flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <span className="min-w-0">
        <span className="block text-[13px] leading-5" style={{ color: skin.text }}>{entry.label}</span>
        {entry.description && (
          <span className="mt-0.5 block text-[11px] leading-4" style={{ color: skin.muted }}>{entry.description}</span>
        )}
      </span>
      {busy ? (
        <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" style={{ color: skin.accent }} />
      ) : (
        <ChevronRight className="h-4 w-4 flex-shrink-0 transition-transform group-hover:translate-x-0.5" style={{ color: skin.muted }} />
      )}
    </button>
  )
}

function PanelEntryRow({ entry, value, skin, onToggle, onChoice, onSlide, onAction, onFont, busyActions }: RowProps) {
  const { control } = entry

  if (control.kind === 'toggle') {
    const checked = value === true
    return (
      <button
        type="button"
        onClick={() => onToggle(entry, !checked)}
        className="flex w-full items-center justify-between gap-4 rounded-xl px-3 py-2.5 text-left transition-colors"
        style={{ background: 'transparent' }}
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-medium leading-5" style={{ color: skin.text }}>{entry.label}</span>
          {entry.description && (
            <span className="mt-0.5 block text-[11px] leading-4" style={{ color: skin.muted }}>{entry.description}</span>
          )}
        </span>
        <PanelSwitch checked={checked} accent={skin.accent} dark={skin.dark} />
      </button>
    )
  }

  if (control.kind === 'font-picker') {
    const family = String(value ?? '')
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <span className="min-w-0">
          <span className="block text-[13px] font-medium leading-5" style={{ color: skin.text }}>{entry.label}</span>
          {entry.description && (
            <span className="mt-0.5 block text-[11px] leading-4" style={{ color: skin.muted }}>{entry.description}</span>
          )}
        </span>
        <FontPicker
          value={family}
          onChange={family => onFont?.(entry, family)}
          dark={skin.dark}
          accent={skin.accent}
          buttonWidth={188}
        />
      </div>
    )
  }

  if (control.kind === 'choice') {
    const isColor = entry.id === 'accentColor'
    return (
      <div className="px-3 py-2.5">
        <div className="text-[13px] font-medium leading-5" style={{ color: skin.text }}>{entry.label}</div>
        {entry.description && <div className="mt-0.5 text-[11px] leading-4" style={{ color: skin.muted }}>{entry.description}</div>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          {control.options.map(option => {
            const active = String(value) === option.value
            return (
              <button
                key={option.value}
                type="button"
                title={option.hint}
                onClick={() => onChoice(entry, option.value)}
                className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition-all"
                style={{
                  borderColor: active ? skin.accent : 'transparent',
                  background: active ? `${skin.accent}22` : skin.controlBg,
                  color: active ? skin.accent : skin.sub,
                  fontWeight: active ? 600 : 400,
                }}
              >
                {isColor && (
                  <span className="h-2.5 w-2.5 rounded-full border border-white/40" style={{ background: option.value }} />
                )}
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  if (control.kind === 'slider') {
    const numeric = Number(value ?? control.min)
    return (
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium leading-5" style={{ color: skin.text }}>{entry.label}</span>
          <span className="text-xs tabular-nums" style={{ color: skin.sub }}>{numeric}{control.unit || ''}</span>
        </div>
        <input
          type="range"
          min={control.min}
          max={control.max}
          step={control.step}
          value={numeric}
          onChange={event => onSlide(entry, Number(event.target.value))}
          className="mt-2 w-full cursor-pointer"
          style={{ accentColor: skin.accent, background: skin.controlBg }}
        />
      </div>
    )
  }

  const busy = busyActions?.[control.actionId]
  return (
    <button
      type="button"
      onClick={() => onAction(entry)}
      className="group flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors"
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-5" style={{ color: skin.text }}>{entry.label}</span>
        {entry.description && (
          <span className="mt-0.5 block text-[11px] leading-4" style={{ color: skin.muted }}>{entry.description}</span>
        )}
      </span>
      {busy ? (
        <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" style={{ color: skin.accent }} />
      ) : (
        <ChevronRight className="h-4 w-4 flex-shrink-0 transition-transform group-hover:translate-x-0.5" style={{ color: skin.muted }} />
      )}
    </button>
  )
}

// ─────────────────────────── 主组件 ───────────────────────────

export interface MirroredGlobalSettingsProps {
  skin: MirrorSkin
  variant: 'classic' | 'panel'
  /** 只渲染某个分组（传统模式按标签页渲染）；不传 = 渲染全部 */
  groupId?: GlobalSettingsGroupId
  /** 打开各模式自备的弹窗（音质设置 / 缓存清理 / 遥控器个性化） */
  onOpenModal?: (actionId: MirrorActionId) => void
  className?: string
}

export function MirroredGlobalSettings({ skin, variant, groupId, onOpenModal, className }: MirroredGlobalSettingsProps) {
  const { getValue, setValue, runAction } = useGlobalSettings()
  const [busyActions, setBusyActions] = useState<Record<string, boolean>>({})

  const groups = groupId ? GLOBAL_SETTINGS_GROUPS.filter(group => group.id === groupId) : GLOBAL_SETTINGS_GROUPS

  const handleToggle = useCallback((entry: GlobalSettingEntry, value: boolean) => setValue(entry.id, value), [setValue])
  const handleChoice = useCallback((entry: GlobalSettingEntry, value: string) => setValue(entry.id, value), [setValue])
  const handleSlide = useCallback((entry: GlobalSettingEntry, value: number) => setValue(entry.id, value), [setValue])
  const handleFont = useCallback((entry: GlobalSettingEntry, family: string) => setValue(entry.id, family), [setValue])
  const handleAction = useCallback((entry: GlobalSettingEntry) => {
    const actionId = entry.control.kind === 'action' ? entry.control.actionId : null
    if (!actionId) return
    if (actionId === 'audio-quality' || actionId === 'cache-clear' || actionId === 'remote-settings') {
      onOpenModal?.(actionId)
      return
    }
    if (actionId === 'check-update') setBusyActions(prev => ({ ...prev, [actionId]: true }))
    runAction(actionId)
    window.setTimeout(() => setBusyActions(prev => ({ ...prev, [actionId]: false })), 2500)
  }, [onOpenModal, runAction])

  const Row = variant === 'classic' ? ClassicEntryRow : PanelEntryRow

  return (
    <div className={className}>
      {groups.map(group => {
        const entries = group.entries.filter(isEntryVisible)
        const isAbout = group.id === 'about'
        if (!isAbout && entries.length === 0) return null
        if (variant === 'classic') {
          return (
            <section key={group.id} className="mb-2">
              <h3 className="text-[15px] font-semibold" style={{ color: skin.text }}>{group.label}</h3>
              {group.description && (
                <p className="mt-0.5 text-[11px]" style={{ color: skin.muted }}>{group.description}</p>
              )}
              <div
                className="mt-3 border-t pt-3"
                style={{ borderColor: skin.cardBorder }}
              >
                {isAbout && (
                  <div className="mb-1 flex items-center justify-between rounded-xl px-2.5 py-2">
                    <span className="text-[13px] leading-5" style={{ color: skin.text }}>当前版本</span>
                    <span className="text-xs tabular-nums" style={{ color: skin.sub }}>{getAboutVersion()}</span>
                  </div>
                )}
                <div className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                  {entries.map(entry => (
                    <Row
                      key={entry.id}
                      entry={entry}
                      value={getValue(entry.id)}
                      skin={skin}
                      onToggle={handleToggle}
                      onChoice={handleChoice}
                      onSlide={handleSlide}
                      onFont={handleFont}
                      onAction={handleAction}
                      busyActions={busyActions}
                    />
                  ))}
                </div>
              </div>
            </section>
          )
        }
        return (
          <section
            key={group.id}
            className="mb-3 rounded-2xl border p-3"
            style={{ background: skin.cardBg, borderColor: skin.cardBorder }}
          >
            <div className="mb-1 px-1">
              <div className="text-sm font-semibold" style={{ color: skin.text }}>{group.label}</div>
              {group.description && (
                <div className="mt-0.5 text-[11px]" style={{ color: skin.muted }}>{group.description}</div>
              )}
            </div>
            {isAbout && (
              <div className="flex items-center justify-between rounded-xl px-3 py-2.5">
                <span className="text-[13px] font-medium" style={{ color: skin.text }}>当前版本</span>
                <span className="text-xs tabular-nums" style={{ color: skin.sub }}>{getAboutVersion()}</span>
              </div>
            )}
            {entries.map(entry => (
              <Row
                key={entry.id}
                entry={entry}
                value={getValue(entry.id)}
                skin={skin}
                onToggle={handleToggle}
                onChoice={handleChoice}
                onSlide={handleSlide}
                onFont={handleFont}
                onAction={handleAction}
                busyActions={busyActions}
              />
            ))}
          </section>
        )
      })}
    </div>
  )
}

// ─────────────────────────── 平台排序 / 显隐同步编辑器 ───────────────────────────
// 与简约模式账号页共用 platforms 服务的同一存储与事件：在这里拖拽 / 隐藏，
// 简约、传统、探索、桌面各处的平台列表立即同步。

const PLATFORM_ICONS: Partial<Record<MusicPlatform, { src: string; fallback: string; bg: string }>> = {
  netease: { src: 'https://s1.music.126.net/style/favicon.ico', fallback: '网', bg: '#dd001b' },
  qq: { src: 'https://y.qq.com/favicon.ico', fallback: 'QQ', bg: '#31c27c' },
  apple: { src: 'https://www.apple.com/favicon.ico', fallback: '苹', bg: '#fa2d48' },
  spotify: { src: '', fallback: 'S', bg: '#1DB954' },
  kugou: { src: '', fallback: 'K', bg: '#FF7A00' },
  soda: { src: '', fallback: '汽', bg: '#38BDF8' },
}

export function PlatformOrderEditor({ skin, className }: { skin: MirrorSkin; className?: string }) {
  const [order, setOrder] = useState<MusicPlatform[]>(() => getPlatformOrder())
  const [hidden, setHidden] = useState<MusicPlatform[]>(() => getHiddenPlatforms())

  useEffect(() => {
    const sync = () => { setOrder(getPlatformOrder()); setHidden(getHiddenPlatforms()) }
    window.addEventListener(PLATFORM_ORDER_EVENT, sync)
    window.addEventListener(PLATFORM_VISIBILITY_EVENT, sync)
    return () => {
      window.removeEventListener(PLATFORM_ORDER_EVENT, sync)
      window.removeEventListener(PLATFORM_VISIBILITY_EVENT, sync)
    }
  }, [])

  const toggleVisibility = (platform: MusicPlatform) => {
    const isHidden = hidden.includes(platform)
    if (!isHidden) {
      const visibleCount = MUSIC_PLATFORMS.filter(p => !hidden.includes(p)).length
      if (visibleCount <= 1) {
        toast('您至少需要保留一个平台以正常使用本软件', 'info')
        return
      }
    }
    setPlatformHidden(platform, !isHidden)
  }

  return (
    <div className={className}>
      <Reorder.Group axis="y" values={order} onReorder={setPlatformOrder} className="space-y-2">
        {order.map(platform => {
          const isHidden = hidden.includes(platform)
          const icon = PLATFORM_ICONS[platform]
          return (
            <Reorder.Item
              key={platform}
              value={platform}
              className="flex cursor-grab items-center gap-3 border px-3 py-2.5 transition-all active:cursor-grabbing"
              style={{
                background: skin.cardBg,
                borderColor: skin.cardBorder,
                borderRadius: skin.radius,
                opacity: isHidden ? 0.45 : 1,
              }}
              whileDrag={{ scale: 1.02, boxShadow: '0 12px 32px rgba(0,0,0,0.25)' }}
            >
              <GripVertical className="h-4 w-4 flex-shrink-0" style={{ color: skin.muted }} />
              <span
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg"
                style={{ background: icon?.bg || 'rgba(127,127,127,0.3)' }}
              >
                {icon?.src ? (
                  <img
                    src={icon.src}
                    alt=""
                    className="h-5 w-5"
                    draggable={false}
                    onError={event => {
                      event.currentTarget.outerHTML = `<span style="color:#fff;font-size:11px;font-weight:700">${icon.fallback}</span>`
                    }}
                  />
                ) : (
                  <span className="text-[11px] font-bold text-white">{icon?.fallback || <Music className="h-4 w-4" />}</span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium" style={{ color: skin.text }}>
                  {PLATFORM_LABELS[platform]}
                </span>
                <span className="block text-[11px]" style={{ color: skin.muted }}>
                  {isHidden ? '已隐藏 · 其他模式同样不可见' : '按住拖动调整各模式的平台顺序'}
                </span>
              </span>
              <button
                type="button"
                onClick={() => toggleVisibility(platform)}
                className="rounded-lg p-1.5 transition-colors hover:bg-white/10"
                aria-label={isHidden ? `显示${PLATFORM_LABELS[platform]}` : `隐藏${PLATFORM_LABELS[platform]}`}
                title={isHidden ? '显示平台' : '隐藏平台'}
              >
                {isHidden
                  ? <EyeOff className="h-4 w-4" style={{ color: skin.muted }} />
                  : <Eye className="h-4 w-4" style={{ color: skin.sub }} />}
              </button>
            </Reorder.Item>
          )
        })}
      </Reorder.Group>
      <button
        type="button"
        onClick={() => {
          // 清空隐藏列表：逐个恢复可见（服务内部广播可见性事件），再恢复默认顺序
          for (const platform of getHiddenPlatforms()) setPlatformHidden(platform, false)
          setPlatformOrder([...MUSIC_PLATFORMS])
        }}
        className="mt-2 flex items-center gap-1.5 text-[11px] transition-colors"
        style={{ color: skin.muted }}
      >
        <RefreshCw className="h-3 w-3" />
        恢复默认排序与显隐
      </button>
    </div>
  )
}
