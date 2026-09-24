/**
 * 共振设置面板：身份（昵称来源）· 玩法（房间模式 / 加歌配额 / 入房行为 / 成员控制）· 外观（背景 / 模糊 / 暗度 / 强调色）。
 * 与「设置中心 → 网络」镜像同键同事件。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, Image as ImageIcon, Settings2, UserRound, Users, X } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { platformLabel, type MusicPlatform } from '../../services/platforms'
import {
  RESONANCE_MAX_MEMBERS,
  RESONANCE_MODE_LABEL,
  RESONANCE_PARTY_QUOTA_CHOICES,
  RESONANCE_PARTY_QUOTA_RANGE,
  RESONANCE_PUSH_LIMIT_CHOICES,
  RESONANCE_QUOTA_RANGE,
  type ResonanceMode,
} from './model'
import {
  RESONANCE_SETTINGS_EVENT,
  readResonanceSettings,
  setResonanceSetting,
  type ResonanceSettings,
} from './settings'
import type { ResonanceIdentityOption } from './ResonanceLobby'

export interface ResonanceSettingsModalProps {
  playerTheme?: 'dark' | 'light'
  onClose: () => void
  inRoom: boolean
  identityOptions: ResonanceIdentityOption[]
}

const ACCENTS = ['#ff5a70', '#7cc4ff', '#a78bfa', '#34d399', '#fbbf24']

/**
 * 这两个控件必须定义在模块作用域。
 *
 * 之前它们写在组件内部（每次渲染都是新的组件类型），任何一次设置写入都会让 React
 * 卸载并重建整行子树：滚动容器瞬间变矮，浏览器把 scrollTop 夹到顶部——
 * 表现就是「点一下下面的开关，设置面板自己跳回最上面」。
 */
function Row({ title, hint, border, sub, children }: {
  title: string
  hint?: string
  border: string
  sub: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-b py-4" style={{ borderColor: border }}>
      <div className="min-w-[220px] flex-1">
        <div className="text-[15px] font-medium">{title}</div>
        {hint && <div className="mt-0.5 text-[11px] leading-relaxed" style={{ color: sub }}>{hint}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}

function Segmented({ value, options, onChange, ariaLabel, accent, chip, sub }: {
  value: string | number
  options: Array<{ value: string | number; label: string }>
  onChange: (next: string | number) => void
  ariaLabel: string
  accent: string
  chip: string
  sub: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-xl p-0.5" style={{ background: chip }} role="group" aria-label={ariaLabel}>
      {options.map(option => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          className="rounded-[9px] px-2.5 py-1 text-[11px] transition"
          style={{ background: value === option.value ? accent : 'transparent', color: value === option.value ? '#fff' : sub }}
          aria-pressed={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 自绘下拉：原生 select 的下拉列表由系统绘制（浅色底、蓝色高亮），在暗色面板里很突兀 */
function Select({ value, options, onChange, ariaLabel, accent, border, chip, sub, dark }: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (next: string) => void
  ariaLabel: string
  accent: string
  border: string
  chip: string
  sub: string
  dark: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const active = options.find(option => option.value === value) || options[0]

  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-8 min-w-[190px] items-center gap-2 rounded-lg border px-2.5 text-xs transition"
        style={{ borderColor: open ? `${accent}77` : border, background: chip }}
      >
        <span className="min-w-0 flex-1 truncate text-left">{active?.label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform" style={{ color: sub, transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.14 }}
            role="listbox"
            aria-label={ariaLabel}
            className="absolute right-0 top-[36px] z-40 max-h-64 w-full min-w-[190px] overflow-y-auto rounded-xl border p-1 shadow-[0_18px_44px_rgba(0,0,0,0.45)] backdrop-blur-xl"
            style={{ borderColor: border, background: dark ? 'rgba(14,17,26,0.98)' : 'rgba(255,255,255,0.98)' }}
          >
            {options.map(option => {
              const selected = option.value === value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => { onChange(option.value); setOpen(false) }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition"
                  style={{ background: selected ? `${accent}22` : 'transparent', color: selected ? accent : undefined }}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default function ResonanceSettingsModal(props: ResonanceSettingsModalProps) {
  const { playerTheme = 'dark', onClose, inRoom, identityOptions } = props
  const dark = playerTheme === 'dark'
  const [settings, setSettings] = useState<ResonanceSettings>(() => readResonanceSettings())

  useEffect(() => {
    const sync = () => setSettings(readResonanceSettings())
    window.addEventListener(RESONANCE_SETTINGS_EVENT, sync)
    return () => window.removeEventListener(RESONANCE_SETTINGS_EVENT, sync)
  }, [])

  const update = <K extends keyof ResonanceSettings>(key: K, value: ResonanceSettings[K]) => {
    setResonanceSetting(key, value)
    setSettings(previous => ({ ...previous, [key]: value }))
  }

  const border = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'
  const sub = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const chip = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'
  const accent = settings.accent

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-[72] flex items-center justify-center p-6"
      style={{ background: 'rgba(3,5,9,0.72)', backdropFilter: 'blur(14px)' }}
      onClick={onClose}
      data-tv-scope
    >
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-[22px] border"
        style={{ borderColor: border, background: dark ? 'linear-gradient(155deg, rgba(20,24,34,0.99), rgba(9,12,18,0.99))' : '#fff', color: dark ? '#fff' : '#101318' }}
        onClick={event => event.stopPropagation()}
      >
        <header className="flex items-center gap-2.5 border-b px-5 py-4" style={{ borderColor: border }}>
          <img src="/resonance-logo.svg" alt="" className="h-8 w-8 rounded-xl" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold">共振设置</h2>
            <p className="text-[11px]" style={{ color: sub }}>同样出现在「设置 → 网络」</p>
          </div>
          <button type="button" onClick={onClose} className="ml-auto rounded-lg p-1.5" style={{ background: chip }} aria-label="关闭"><X className="h-4 w-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-2">
          <h3 className="mb-1 mt-2 flex items-center gap-1.5 text-xs font-semibold" style={{ color: sub }}><UserRound className="h-3.5 w-3.5" />身份</h3>
          <Row border={border} sub={sub} title="房间里显示为" hint="默认用你已登录平台的昵称；也可以自定义">
            <Select
              value={settings.nicknameSource}
              options={identityOptions.map(option => ({
                value: option.key,
                label: option.key === 'custom'
                  ? '自定义昵称'
                  : `${option.nickname}（${platformLabel(option.platform || '')}）`,
              }))}
              onChange={value => update('nicknameSource', value)}
              ariaLabel="昵称来源"
              accent={accent} border={border} chip={chip} sub={sub} dark={dark}
            />
            {settings.nicknameSource === 'custom' && (
              <input
                value={settings.nickname}
                onChange={event => update('nickname', event.target.value.slice(0, 16))}
                placeholder="自定义昵称"
                maxLength={16}
                className="h-9 w-44 rounded-lg border bg-transparent px-3 text-sm outline-none"
                style={{ borderColor: border }}
                aria-label="自定义昵称"
              />
            )}
          </Row>
          <Row border={border} sub={sub} title="显示成员头像与平台昵称" hint="关掉后房间里只显示昵称首字，不显示平台">
            <button
              type="button" role="switch" aria-checked={settings.showAvatars} aria-label="显示成员头像与平台昵称"
              onClick={() => update('showAvatars', !settings.showAvatars)}
              className="relative h-7 w-12 rounded-full transition"
              style={{ background: settings.showAvatars ? accent : chip }}
            >
              <span className="absolute top-1 h-5 w-5 rounded-full bg-white transition-all" style={{ left: settings.showAvatars ? 24 : 4 }} />
            </button>
          </Row>
          <Row border={border} sub={sub} title="显示我的平台徽章" hint="关掉后不显示你登录了哪些平台与会员档">
            <button
              type="button" role="switch" aria-checked={settings.showBadges} aria-label="显示我的平台徽章"
              onClick={() => update('showBadges', !settings.showBadges)}
              className="relative h-6 w-11 rounded-full transition"
              style={{ background: settings.showBadges ? accent : chip }}
            >
              <span className="absolute top-1 h-5 w-5 rounded-full bg-white transition-all" style={{ left: settings.showBadges ? 24 : 4 }} />
            </button>
          </Row>

          <h3 className="mb-1 mt-5 flex items-center gap-1.5 text-xs font-semibold" style={{ color: sub }}><Users className="h-3.5 w-3.5" />玩法</h3>
          <Row border={border} sub={sub} title="默认房间模式" hint="创建房间时的预选">
            <Select
              value={settings.defaultMode}
              options={(Object.keys(RESONANCE_MODE_LABEL) as ResonanceMode[]).map(mode => ({ value: mode, label: RESONANCE_MODE_LABEL[mode] }))}
              onChange={value => update('defaultMode', value as ResonanceMode)}
              ariaLabel="默认房间模式"
              accent={accent} border={border} chip={chip} sub={sub} dark={dark}
            />
          </Row>
          <Row border={border} sub={sub} title="Party：每人可加歌数" hint="整场累计，默认 3 首（避免有人一口气塞一堆）">
            <Segmented
              accent={accent} chip={chip} sub={sub}
              value={settings.partyQuota}
              options={[...RESONANCE_PARTY_QUOTA_CHOICES].map(value => ({ value, label: `${value}` }))}
              onChange={value => update('partyQuota', Number(value))}
              ariaLabel="Party 每人可加歌数"
            />
          </Row>
          <Row border={border} sub={sub} title="我推荐：每人每轮可推荐" hint={`${RESONANCE_QUOTA_RANGE[0]}–${RESONANCE_QUOTA_RANGE[1]} 首`}>
            <Segmented
              accent={accent} chip={chip} sub={sub}
              value={settings.quota}
              options={Array.from({ length: RESONANCE_QUOTA_RANGE[1] - RESONANCE_QUOTA_RANGE[0] + 1 }, (_, index) => RESONANCE_QUOTA_RANGE[0] + index).map(value => ({ value, label: `${value} 首` }))}
              onChange={value => update('quota', Number(value))}
              ariaLabel="我推荐每人每轮可推荐曲目数"
            />
          </Row>
          <Row border={border} sub={sub} title="共享歌单：单次推送上限" hint="整单推送时截断到这里，避免几千首大歌单卡住房间">
            <Segmented
              accent={accent} chip={chip} sub={sub}
              value={settings.pushLimit}
              options={RESONANCE_PUSH_LIMIT_CHOICES.map(value => ({ value, label: `${value} 首` }))}
              onChange={value => update('pushLimit', Number(value))}
              ariaLabel="单次推送上限"
            />
          </Row>
          <Row border={border} sub={sub} title="入房时" hint="续接=从房主当前进度接着听；等下一首=不打断当前">
            <Segmented
              accent={accent} chip={chip} sub={sub}
              value={settings.joinBehavior}
              options={[{ value: 'resume', label: '续接当前进度' }, { value: 'next', label: '等下一首' }]}
              onChange={value => update('joinBehavior', value === 'next' ? 'next' : 'resume')}
              ariaLabel="入房行为"
            />
          </Row>
          <Row border={border} sub={sub} title="允许所有成员控制播放" hint="默认只有房主；打开后任何成员都能暂停/快进（同一时刻一个控制者）">
            <button
              type="button" role="switch" aria-checked={settings.allowMemberControl} aria-label="允许所有成员控制播放"
              onClick={() => update('allowMemberControl', !settings.allowMemberControl)}
              className="relative h-6 w-11 rounded-full transition"
              style={{ background: settings.allowMemberControl ? accent : chip }}
            >
              <span className="absolute top-1 h-5 w-5 rounded-full bg-white transition-all" style={{ left: settings.allowMemberControl ? 24 : 4 }} />
            </button>
          </Row>
          <Row border={border} sub={sub} title="房间人数上限" hint={inRoom ? '房间进行中不可改' : `含房主，最多 ${RESONANCE_MAX_MEMBERS} 人`}>
            <Segmented
              accent={accent} chip={chip} sub={sub}
              value={settings.maxMembers}
              options={[4, 8, 12, 15].map(value => ({ value, label: `${value} 人` }))}
              onChange={value => update('maxMembers', Number(value))}
              ariaLabel="房间人数上限"
            />
          </Row>

          <h3 className="mb-1 mt-5 flex items-center gap-1.5 text-xs font-semibold" style={{ color: sub }}><ImageIcon className="h-3.5 w-3.5" />外观</h3>
          <Row border={border} sub={sub} title="背景" hint="跟随封面会随当前歌曲变化；自定义图片可填本地文件路径或图片链接">
            <Segmented
              accent={accent} chip={chip} sub={sub}
              value={settings.background}
              options={[{ value: 'cover', label: '跟随封面' }, { value: 'aurora', label: '极光' }, { value: 'light', label: '浅色' }, { value: 'image', label: '自定义图' }]}
              onChange={value => update('background', value as ResonanceSettings['background'])}
              ariaLabel="背景样式"
            />
            {settings.background === 'image' && (
              <>
                <input
                  value={settings.backgroundImage}
                  onChange={event => update('backgroundImage', event.target.value)}
                  placeholder="https://… 或 file:///D:/图片.jpg"
                  className="h-8 w-full min-w-[220px] rounded-lg border bg-transparent px-2 text-[11px] outline-none"
                  style={{ borderColor: border }}
                  aria-label="自定义背景图片地址"
                />
                <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[11px]" style={{ background: chip, color: sub }}>
                  选本地图片
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={event => {
                      const file = event.target.files?.[0]
                      if (!file) return
                      const reader = new FileReader()
                      reader.onload = () => update('backgroundImage', String(reader.result || ''))
                      reader.readAsDataURL(file)
                    }}
                  />
                </label>
                {settings.backgroundImage && (
                  <span className="h-8 w-12 overflow-hidden rounded-lg" style={{ background: chip }}>
                    <CachedImage src={settings.backgroundImage} alt="" className="h-full w-full object-cover" role="compact" />
                  </span>
                )}
              </>
            )}
          </Row>
          <Row border={border} sub={sub} title={`背景模糊 ${settings.backgroundBlur}px`} hint="只在「跟随封面 / 自定义图」时生效">
            <input
              type="range" min={0} max={80} value={settings.backgroundBlur}
              onChange={event => update('backgroundBlur', Number(event.target.value))}
              className="w-40" style={{ accentColor: accent }} aria-label="背景模糊"
            />
          </Row>
          <Row border={border} sub={sub} title={`背景暗度 ${settings.backgroundDim}%`} hint="压暗背景以保证文字对比度">
            <input
              type="range" min={0} max={90} value={settings.backgroundDim}
              onChange={event => update('backgroundDim', Number(event.target.value))}
              className="w-40" style={{ accentColor: accent }} aria-label="背景暗度"
            />
          </Row>
          <Row border={border} sub={sub} title="强调色" hint="房间里的按钮、进度、徽章都用它">
            <div className="flex items-center gap-1.5">
              {ACCENTS.map(color => (
                <button
                  key={color}
                  type="button"
                  onClick={() => update('accent', color)}
                  className="h-7 w-7 rounded-full border-2 transition"
                  style={{ background: color, borderColor: settings.accent === color ? (dark ? '#fff' : '#101318') : 'transparent' }}
                  aria-label={`强调色 ${color}`}
                  aria-pressed={settings.accent === color}
                />
              ))}
            </div>
          </Row>

          <Row border={border} sub={sub} title="允许局域网发现" hint="关掉后别人扫不到你的房间，只能靠邀请串加入">
            <button
              type="button" role="switch" aria-checked={settings.lanDiscovery} aria-label="允许局域网发现"
              onClick={() => update('lanDiscovery', !settings.lanDiscovery)}
              className="relative h-6 w-11 rounded-full transition"
              style={{ background: settings.lanDiscovery ? accent : chip }}
            >
              <span className="absolute top-1 h-5 w-5 rounded-full bg-white transition-all" style={{ left: settings.lanDiscovery ? 24 : 4 }} />
            </button>
          </Row>
          <Row border={border} sub={sub} title="中转端口" hint="房主进程内监听端口；被占用会自动顺延找可用端口">
            <input
              type="number" min={1024} max={65535} value={settings.port} disabled={inRoom}
              onChange={event => update('port', Math.min(65535, Math.max(1024, Number(event.target.value) || 25570)))}
              className="h-8 w-24 rounded-lg border bg-transparent px-2 text-xs outline-none disabled:opacity-50"
              style={{ borderColor: border }}
              aria-label="中转端口"
            />
          </Row>
        </div>
      </motion.div>
    </motion.div>
  )
}
