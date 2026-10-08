// QQ 音乐 PC 客户端风格左栏：头像+昵称 → 功能位四宫格（固定「推荐/乐馆」+ 客户端已选/本机新增位 + 「+」）
// → 喜欢/最近播放 → 自建歌单|收藏歌单 + 列表 → 底部工具行。
//
// 面板（常用功能/常听艺人/最近常听）与功能位数据全部来自客户端自己的入口模块
// （music.recommend.RecommendWidget.GetPCCommonEntryPoint，见 qqPcEntryPoint.ts）：
// 条目名/官方四态图标/已选状态/常听艺人/最近常听的歌单/上限(实测 8) 都用服务端真实值，不用手机端那套。
// 首次进入以客户端的 Selections 为初值，之后本机增删记在 localStorage。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  ChevronDown, ChevronLeft, ChevronRight, Clock, Compass, Download, Heart, Home, Laptop2, ListMusic, Minus, Music2, Plus,
  Search as SearchIcon, Settings as SettingsIcon, ShoppingBag, SlidersHorizontal, Sparkles, User,
} from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { PcCover, pcTheme, type PcTone } from './pcKit'
import { entryLinkParam, fetchQQPcEntryPoint, type QQPcEntryItem, type QQPcEntryPoint } from './qqPcEntryPoint'
import { accountTierBadgeClass, getAccountTierBadge } from '../../services/accountTier'

export type QQPcNavKey = 'home' | 'hall' | 'liked' | 'recent' | 'local' | 'purchased' | 'trial' | 'search' | 'profile' | 'settings'

/** 功能位：直接存客户端条目关键字段（与 Selections 同构），便于离线保存与四态图标。 */
export interface QQPcTile {
  key: string
  title: string
  itemType: number
  itemSubType: number
  link: string
  cover?: string
  iconUrl?: string
  iconSelectedUrl?: string
  iconDarkUrl?: string
  iconDarkSelectedUrl?: string
}

const TILES_KEY = 'waveforge:traditional-qq-tiles:v2'
/** 与官方「已选功能位」对齐的一次性标记：老版本只落了本机条目（如「刷歌」），格子和客户端对不上。 */
const TILES_SYNC_KEY = 'waveforge:traditional-qq-tiles:selections-synced:v1'

function toTile(item: QQPcEntryItem): QQPcTile {
  return {
    key: `${item.itemType}:${item.itemSubType}:${item.id || item.title}`,
    title: item.title,
    itemType: item.itemType,
    itemSubType: item.itemSubType,
    link: item.link,
    cover: item.cover,
    iconUrl: item.iconUrl,
    iconSelectedUrl: item.iconSelectedUrl,
    iconDarkUrl: item.iconDarkUrl,
    iconDarkSelectedUrl: item.iconDarkSelectedUrl,
  }
}

function readTiles(): QQPcTile[] | null {
  try {
    const raw = localStorage.getItem(TILES_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((tile: QQPcTile) => tile?.key && tile?.title).slice(0, 16) : null
  } catch { return null }
}

const FIXED_TILES: Array<{ key: QQPcNavKey; label: string; Icon: typeof Home }> = [
  { key: 'home', label: '推荐', Icon: Home },
  { key: 'hall', label: '乐馆', Icon: Compass },
]

/** 二级导航（展开栏与折叠轨道共用一份清单，避免两处顺序漂移） */
const SIDEBAR_NAV_ITEMS: Array<{ key: QQPcNavKey; label: string; Icon: typeof Home }> = [
  // 官方顺序（客户端实测）：最近播放 → 本地和下载 → 已购音乐 → 试听列表 → 喜欢。
  { key: 'recent', label: '最近播放', Icon: Clock },
  { key: 'local', label: '本地和下载', Icon: Download },
  { key: 'purchased', label: '已购音乐', Icon: ShoppingBag },
  { key: 'trial', label: '试听列表', Icon: ListMusic },
  { key: 'liked', label: '喜欢', Icon: Heart },
]

/** 条目图标四态里挑当前皮肤/选中态该用的那张（客户端就是四张图）。 */
function tileIcon(tile: QQPcTile, dark: boolean, selected = false): string | undefined {
  if (selected) return dark ? (tile.iconDarkSelectedUrl || tile.iconSelectedUrl) : (tile.iconSelectedUrl || tile.iconDarkSelectedUrl)
  return dark ? (tile.iconDarkUrl || tile.iconUrl) : (tile.iconUrl || tile.iconDarkUrl)
}

/** 官方条目类型 → 本软件落点（链接里带 singermid / playlist id 时优先按链接走）。
 *  视频/频道/榜单都落到乐馆的对应页签（客户端这三个功能位就是打开对应页面）。 */
const SUBTYPE_TAB: Record<number, 'charts' | 'videos' | 'channels'> = {
  10011: 'videos',    // 视频（客户端落 mv/recommend 视频推荐页）
  10012: 'channels',  // 频道
  10015: 'charts',    // 飙升榜（客户端打开榜单详情；这里落榜单页签）
}
/** 官方歌单与听书热播榜同为 10013，只能靠标题/链接区分 */
const isOfficialSonglist = (item: { title: string; link: string }) => item.title.includes('官方歌单') || item.link.includes('category_detail')

export interface QQPcSidebarProps {
  tone: PcTone
  accent: string
  loggedIn: boolean
  username: string
  avatar?: string
  vip?: boolean
  currentKey: QQPcNavKey | ''
  counts: { liked?: number; recent?: number }
  playlists: any[]
  playlistTab: 'mine' | 'collected'
  onPlaylistTab: (tab: 'mine' | 'collected') => void
  onOpenPlaylist: (playlist: any) => void
  onPlaylistMenu: (menu: { show: boolean; x: number; y: number; playlist: any | null }) => void
  onNavigate: (key: QQPcNavKey, detail?: string) => void
  onOpenMv: () => void
  onPlayRadio: () => void
  onOpenArtist: (artistId: string) => void
  onPlaySongs: (song: Song, songs: Song[]) => void
  creatingPlaylist: boolean
  newPlaylistName: string
  onNewPlaylistName: (value: string) => void
  onConfirmCreate: () => void
  onCancelCreate: () => void
  creatingBusy: boolean
  onToggleCreate: () => void
  onLoginClick: () => void
  onToggleMode: () => void
  /** 折叠成 56px 图标轨道（官方客户端左下角左箭头的行为） */
  collapsed?: boolean
  onToggleCollapse?: () => void
  playlistScrollRef: RefObject<HTMLDivElement | null>
}

function QQPcSidebar({
  tone, accent, loggedIn, username, avatar, vip = false, currentKey, counts, playlists, playlistTab, onPlaylistTab,
  onOpenPlaylist, onPlaylistMenu, onNavigate, onOpenMv, onPlayRadio, onOpenArtist, onPlaySongs,
  creatingPlaylist, newPlaylistName, onNewPlaylistName, onConfirmCreate,
  onCancelCreate, creatingBusy, onToggleCreate, onLoginClick, onToggleMode, collapsed = false, onToggleCollapse,
  playlistScrollRef,
}: QQPcSidebarProps) {
  const theme = pcTheme(tone)
  const dark = tone === 'dark'
  const activePill = dark ? 'bg-white/[0.12]' : 'bg-black/[0.055]'
  const idleText = dark ? 'text-white/62' : 'text-slate-600'
  const iconBox = dark ? 'bg-white/[0.08] text-white/75' : 'bg-black/[0.05] text-slate-600'
  const dashedBox = `border border-dashed ${dark ? 'border-white/20 text-white/55 hover:text-white/85' : 'border-black/20 text-slate-500 hover:text-slate-800'}`

  const [tiles, setTiles] = useState<QQPcTile[] | null>(readTiles)
  const [panelOpen, setPanelOpen] = useState(false)
  const [entry, setEntry] = useState<QQPcEntryPoint | null>(null)
  const [entryError, setEntryError] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!loggedIn) return
    let cancelled = false
    void fetchQQPcEntryPoint()
      .then(data => {
        if (cancelled) return
        setEntry(data)
        setEntryError('')
        setTiles(prev => {
          const seeded = data.selections.map(toTile).slice(0, data.maxSelect)
          if (prev === null) return seeded
          // 一次性与官方「已选功能位」对齐：早期版本落盘时可能没同步过官方 Selections，
          // 表现为左栏格子比客户端少一截（客户端已选：常听歌手/频道/视频/飙升榜/官方歌单）。
          // 只在从未对齐过时合并一次，之后完全尊重用户自己的增删。
          try {
            if (localStorage.getItem(TILES_SYNC_KEY)) return prev
            localStorage.setItem(TILES_SYNC_KEY, '1')
          } catch { return prev }
          const keys = new Set(prev.map(tile => tile.key))
          return [...prev, ...seeded.filter(tile => !keys.has(tile.key))].slice(0, data.maxSelect)
        })
      })
      .catch(error => { if (!cancelled) setEntryError(error instanceof Error ? error.message : '功能位加载失败') })
    return () => { cancelled = true }
  }, [loggedIn])

  const maxSelect = entry?.maxSelect ?? 8
  const tileList = tiles ?? []

  useEffect(() => {
    if (tiles === null) return
    try { localStorage.setItem(TILES_KEY, JSON.stringify(tiles)) } catch { /* 隐私模式忽略 */ }
  }, [tiles])

  useEffect(() => { setPanelOpen(false) }, [currentKey])

  useEffect(() => {
    if (!panelOpen) return
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setPanelOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPanelOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [panelOpen])

  const addTile = useCallback((tile: QQPcTile) => {
    setTiles(prev => {
      const list = prev ?? []
      if (list.length >= maxSelect || list.some(item => item.key === tile.key)) return list
      return [...list, tile]
    })
  }, [maxSelect])
  const removeTile = useCallback((key: string) => {
    setTiles(prev => (prev ?? []).filter(item => item.key !== key))
  }, [])

  /** 点击分发：先看链接里的真实目标（歌手 mid / 歌单 id），再按条目类型兜底。 */
  const runEntry = useCallback((item: QQPcTile) => {
    // 本机功能位「刷歌」：起播推荐流（客户端这里进雷达/刷歌队列）。此前漏接线，点击只会弹
    // 「暂不支持」——onPlayRadio 定义了却从未被用（2026-10-07 全量走查发现）。
    if (item.key === 'local:radio') { onPlayRadio(); return }
    if (item.itemType === 1002 || item.link.includes('singer_detail')) {
      const mid = entryLinkParam(item as unknown as QQPcEntryItem, 'singermid')
      if (mid) { onOpenArtist(mid); return }
    }
    if (item.itemType === 1003 || item.link.includes('playlist_detail')) {
      const id = entryLinkParam(item as unknown as QQPcEntryItem, 'id')
      if (id) { onOpenPlaylist({ id, name: item.title, platform: 'qq', source: 'qq-pc-entry' }); return }
    }
    const tab = SUBTYPE_TAB[item.itemSubType]
    if (tab) { onNavigate('hall', tab); return }
    if (isOfficialSonglist(item)) { onNavigate('hall', 'playlists'); return }
    // 听书 / AI 唱 / 数字专辑等没有数据源的条目：明确告知，而不是点了没反应（与面板底部说明一致）
    window.dispatchEvent(new CustomEvent('showToast', {
      detail: { message: `「${item.title}」暂不支持在 WaveForge 内打开`, type: 'info' },
    }))
  }, [onNavigate, onOpenArtist, onOpenPlaylist, onPlayRadio])

  // 可添加条目：只留真实落点的官方条目 + 本软件自己的「刷歌」（客户端把它当本地功能，官方入口接口里没有）
  const addable = useMemo<QQPcTile[]>(() => {
    const features = (entry?.features ?? [])
      .filter(item => isOfficialSonglist(item) || Boolean(SUBTYPE_TAB[item.itemSubType]))
      .map(toTile)
    return [...features, { key: 'local:radio', title: '刷歌', itemType: 1001, itemSubType: 0, link: '' }]
  }, [entry])

  // 折叠态：只留图标轨道（账号 / 功能位 / 二级导航 / 底部工具 + 右箭头展开）
  if (collapsed) {
    return (
      <aside className={`relative hidden min-h-0 flex-col items-center gap-1 overflow-y-auto border-r py-4 lg:flex ${dark ? 'border-white/10' : 'border-black/[0.07]'}`}>
        <button type="button" onClick={() => (loggedIn ? onNavigate('profile') : onLoginClick())} title={loggedIn ? (username || '我的账户') : '登录'} className="mb-1 h-9 w-9 shrink-0 overflow-hidden rounded-full">
          {avatar
            ? <PcCover src={avatar} alt="" className="h-9 w-9" rounded="rounded-full" eager />
            : <span className={`flex h-9 w-9 items-center justify-center rounded-full ${iconBox}`}><User className="h-4 w-4" /></span>}
        </button>
        {FIXED_TILES.map(({ key, label, Icon }) => (
          <button key={key} type="button" title={label} aria-label={label} onClick={() => onNavigate(key)} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${currentKey === key ? activePill : `${iconBox} hover:opacity-80`}`}>
            <Icon className="h-[18px] w-[18px]" style={currentKey === key ? { color: accent } : undefined} />
          </button>
        ))}
        {tileList.map(tile => {
          const icon = tileIcon(tile, dark)
          return (
            <button key={tile.key} type="button" title={tile.title} aria-label={tile.title} onClick={() => runEntry(tile)} className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl ${iconBox}`}>
              {icon
                ? <img src={icon} alt="" className="h-[20px] w-[20px] object-contain" loading="lazy" referrerPolicy="no-referrer" />
                : tile.cover
                  ? <PcCover src={tile.cover} alt="" className="h-5 w-5" rounded={tile.itemType === 1002 ? 'rounded-full' : 'rounded-md'} />
                  : <Music2 className="h-[18px] w-[18px]" />}
            </button>
          )
        })}
        <span className={`my-1 h-px w-7 shrink-0 ${dark ? 'bg-white/12' : 'bg-black/10'}`} />
        {SIDEBAR_NAV_ITEMS.map(({ key, label, Icon }) => (
          <button key={key} type="button" title={label} aria-label={label} onClick={() => onNavigate(key)} className={`flex h-8 w-9 shrink-0 items-center justify-center rounded-xl transition ${currentKey === key ? activePill : `${idleText} hover:opacity-80`}`}>
            <Icon className="h-4 w-4" style={currentKey === key ? { color: accent } : undefined} />
          </button>
        ))}
        <div className="mt-auto flex shrink-0 flex-col items-center gap-1 pt-2">
          <button type="button" onClick={onToggleCollapse} title="展开左栏" aria-label="展开左栏" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={() => onNavigate('search')} title="搜索" aria-label="搜索" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><SearchIcon className="h-4 w-4" /></button>
          <button type="button" onClick={() => onNavigate('settings')} title="设置" aria-label="设置" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><SettingsIcon className="h-4 w-4" /></button>
          <button type="button" onClick={onToggleMode} title="切换界面模式" aria-label="切换界面模式" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><Laptop2 className="h-4 w-4" /></button>
        </div>
      </aside>
    )
  }

  return (
    <aside className={`relative hidden min-h-0 flex-col lg:flex ${dark ? 'border-white/10' : 'border-black/[0.07]'} border-r`}>
      {/* 整栏滚动（对齐官方客户端）：账号区/功能位/导航/歌单共用一个滚动容器，底部工具行固定。
          滚动位置仍按 自建/收藏 页签分别记忆（沿用 playlistScrollRef / data-testid 供既有测试使用）。 */}
      <div ref={playlistScrollRef} data-testid="traditional-playlist-scroll" className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-4 pt-5">
        <button type="button" onClick={() => (loggedIn ? onNavigate('profile') : onLoginClick())} className="flex w-full items-center gap-2.5 text-left">
          {avatar
            ? <PcCover src={avatar} alt={`${username || '用户'}头像`} className="h-9 w-9 shrink-0" rounded="rounded-full" eager />
            : <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${iconBox}`}><User className="h-4 w-4" /></span>}
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[14px] font-medium ${theme.text}`}>{loggedIn ? (username || '我的账户') : '未登录'}</span>
            <span className="mt-0.5 flex items-center gap-1">
              {(() => {
                // 会员级别区分：超级会员 > 绿钻 VIP（写死 VIP 会让超级会员用户看到错的等级）
                const tierBadge = loggedIn ? getAccountTierBadge('qq', vip) : null
                if (!tierBadge) return <span className={`text-[11px] ${theme.faint}`}>{loggedIn ? '普通用户' : '点击登录'}</span>
                return (
                  <span className={`rounded-[3px] px-1 text-[10px] leading-[14px] ${accountTierBadgeClass(tierBadge.tone)}`}>
                    {tierBadge.label}
                  </span>
                )
              })()}
            </span>
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 ${theme.faint}`} />
        </button>

        <div className="mt-4 grid grid-cols-2 gap-3">
          {FIXED_TILES.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => onNavigate(key)}
              title={label}
              className={`flex h-[58px] flex-col items-center justify-center gap-1 rounded-xl transition ${currentKey === key ? activePill : iconBox}`}
            >
              <Icon className="h-[18px] w-[18px]" style={currentKey === key ? { color: accent } : undefined} />
              <span className={`text-[11px] leading-none ${currentKey === key ? '' : theme.subtle}`} style={currentKey === key ? { color: accent } : undefined}>{label}</span>
            </button>
          ))}
          {tileList.map(tile => {
            const icon = tileIcon(tile, dark)
            return (
              <div key={tile.key} className="group/tile relative">
                <button
                  type="button"
                  onClick={() => runEntry(tile)}
                  title={tile.title}
                  className={`flex h-[58px] w-full flex-col items-center justify-center gap-1 overflow-hidden rounded-xl transition ${iconBox}`}
                >
                  {icon
                    ? <img src={icon} alt="" className="h-[22px] w-[22px] object-contain" loading="lazy" referrerPolicy="no-referrer" />
                    : tile.cover
                      ? <PcCover src={tile.cover} alt={tile.title} className="h-[22px] w-[22px] shrink-0" rounded={tile.itemType === 1002 ? 'rounded-full' : 'rounded-md'} />
                      : <Music2 className="h-[18px] w-[18px]" />}
                  <span className={`w-full truncate px-1 text-center text-[11px] leading-none ${theme.subtle}`}>{tile.title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`移除 ${tile.title}`}
                  onClick={event => { event.stopPropagation(); removeTile(tile.key) }}
                  className={`absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full opacity-0 transition group-hover/tile:opacity-100 ${dark ? 'bg-white/85 text-black' : 'bg-black/75 text-white'}`}
                >
                  <Minus className="h-2.5 w-2.5" />
                </button>
              </div>
            )
          })}
          {tileList.length < maxSelect && (
            <button
              type="button"
              onClick={() => setPanelOpen(open => !open)}
              title="添加功能位"
              aria-label="添加功能位"
              className={`flex h-[48px] items-center justify-center rounded-xl transition ${dashedBox} ${tileList.length === 0 ? 'col-span-2' : ''}`}
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <nav className="mt-5 shrink-0 space-y-0.5 px-3">
        {([
          // 后三页的数据通道现状见 QQPcExtras.tsx 头部注释（试听列表与官方同为空的空态；
          // 已购/本地下载通道未接入，页面按官方结构如实空态——入口不再缺失）。
          ...SIDEBAR_NAV_ITEMS.map(item => ({ ...item, count: item.key === 'recent' ? counts.recent : item.key === 'liked' ? counts.liked : undefined })),
        ]).map(({ key, label, Icon, count }) => {
          const active = currentKey === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => onNavigate(key)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-[9px] text-[13px] transition ${active ? `${activePill} font-medium` : `${idleText} ${dark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.035]'}`}`}
              style={active ? { color: accent } : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{label}{typeof count === 'number' && count > 0 ? `:${count}` : ''}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-6 flex shrink-0 items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => onPlaylistTab('mine')}
          className={`text-[13px] transition ${playlistTab === 'mine' ? 'font-medium' : idleText}`}
          style={playlistTab === 'mine' ? { color: theme.tone === 'dark' ? '#fff' : '#111' } : undefined}
        >
          自建歌单
        </button>
        <span className={`text-[12px] ${theme.faint}`}>|</span>
        <button
          type="button"
          onClick={() => onPlaylistTab('collected')}
          className={`text-[13px] transition ${playlistTab === 'collected' ? 'font-medium' : idleText}`}
          style={playlistTab === 'collected' ? { color: theme.tone === 'dark' ? '#fff' : '#111' } : undefined}
        >
          收藏歌单
        </button>
        <button type="button" onClick={onToggleCreate} className={`ml-auto rounded p-1 ${theme.faint} hover:opacity-80`} aria-label="新建歌单"><Plus className="h-3.5 w-3.5" /></button>
      </div>

      {creatingPlaylist && (
        <div className="mt-2 shrink-0 px-3">
          <input
            autoFocus
            value={newPlaylistName}
            onChange={event => onNewPlaylistName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void onConfirmCreate()
              if (event.key === 'Escape') onCancelCreate()
            }}
            placeholder="歌单名称"
            className={`h-8 w-full rounded-lg border bg-transparent px-2 text-[12px] outline-none ${dark ? 'border-white/20' : 'border-black/15'} ${theme.text}`}
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button type="button" disabled={creatingBusy || !newPlaylistName.trim()} onClick={() => void onConfirmCreate()} className="rounded-md px-2.5 py-1 text-[12px] text-white disabled:opacity-40" style={{ background: accent }}>创建</button>
            <button type="button" onClick={onCancelCreate} className={`rounded-md px-2 py-1 text-[12px] ${theme.faint}`}>取消</button>
          </div>
        </div>
      )}

        <div className="mt-2 space-y-0.5 px-3 pb-4">
        {playlists.map((playlist: any) => (
          <button
            key={`${playlist.platform || 'qq'}:${playlist.id || playlist.dirId}`}
            type="button"
            onClick={() => onOpenPlaylist(playlist)}
            onContextMenu={event => { event.preventDefault(); onPlaylistMenu({ show: true, x: event.clientX, y: event.clientY, playlist }) }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-[6px] text-left transition ${dark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.04]'}`}
          >
            <PcCover
              src={playlist.coverImgUrl || playlist.coverUrl}
              alt={`${playlist.name}封面`}
              className="h-9 w-9 shrink-0"
              rounded="rounded-md"
            />
            <span className={`min-w-0 flex-1 truncate text-[12px] ${theme.text}`}>{playlist.name}</span>
          </button>
        ))}
        {playlists.length === 0 && (
          <p className={`px-2 py-4 text-center text-[11px] ${theme.faint}`}>
            {playlistTab === 'mine' ? '还没有创建歌单，点 + 新建' : '还没有收藏歌单'}
          </p>
        )}
      </div>

      </div>

      {panelOpen && (
        <div
          ref={panelRef}
          className={`absolute left-full top-0 z-30 ml-3 max-h-[calc(100%-1rem)] w-[440px] overflow-y-auto rounded-2xl border p-4 shadow-2xl backdrop-blur-xl ${dark ? 'border-white/10 bg-[#1b1b22]/95' : 'border-black/10 bg-white/95'}`}
        >
          <div className="flex items-center justify-between">
            <h3 className={`text-[14px] font-medium ${theme.text}`}>常用功能</h3>
            <span className={`text-[11px] ${theme.faint}`}>已添加 {tileList.length}/{maxSelect}</span>
          </div>
          {entryError ? <p className={`mt-2 text-[11px] ${theme.faint}`}>{entryError}</p> : null}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {addable.map(tile => {
              const added = tileList.some(existing => existing.key === tile.key)
              const disabled = !added && tileList.length >= maxSelect
              const icon = tileIcon(tile, dark)
              return (
                <div key={tile.key} className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 ${theme.surface}`}>
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconBox}`}>
                    {icon ? <img src={icon} alt="" className="h-5 w-5 object-contain" loading="lazy" referrerPolicy="no-referrer" /> : <Sparkles className="h-4 w-4" />}
                  </span>
                  <span className={`min-w-0 flex-1 truncate text-[12px] ${theme.text}`}>{tile.title}</span>
                  <button
                    type="button"
                    aria-label={added ? `移除 ${tile.title}` : `添加 ${tile.title}`}
                    disabled={disabled}
                    onClick={() => (added ? removeTile(tile.key) : addTile(tile))}
                    className={`flex h-5 w-5 items-center justify-center rounded-full border transition disabled:opacity-30 ${added ? '' : dark ? 'border-white/25 text-white/70' : 'border-black/20 text-slate-500'}`}
                  >
                    {added ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                  </button>
                </div>
              )
            })}
          </div>

          {(entry?.singers?.length ?? 0) > 0 && (
            <>
              <h3 className={`mt-5 text-[14px] font-medium ${theme.text}`}>常听艺人</h3>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {(entry?.singers || []).slice(0, 9).map(singer => {
                  const tile = toTile(singer)
                  const added = tileList.some(existing => existing.key === tile.key)
                  return (
                    <div key={tile.key} className="relative text-center">
                      <button type="button" onClick={() => runEntry(tile)} className="block w-full">
                        <PcCover src={singer.cover} alt={singer.title} className="aspect-square w-full" rounded="rounded-full" />
                        <span className={`mt-1.5 block truncate text-[11px] ${theme.subtle}`}>{singer.title}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={added ? `移除 ${singer.title}` : `添加 ${singer.title}`}
                        disabled={!added && tileList.length >= maxSelect}
                        onClick={() => (added ? removeTile(tile.key) : addTile(tile))}
                        className={`absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border backdrop-blur transition disabled:opacity-30 ${added ? 'border-transparent text-white' : dark ? 'border-white/30 text-white/80' : 'border-black/20 bg-white/70 text-slate-600'}`}
                        style={added ? { background: accent } : undefined}
                      >
                        {added ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                      </button>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {(entry?.recents?.length ?? 0) > 0 && (
            <>
              <h3 className={`mt-5 text-[14px] font-medium ${theme.text}`}>最近常听</h3>
              <div className="mt-2 space-y-1">
                {(entry?.recents || []).slice(0, 8).map(recent => {
                  const tile = toTile(recent)
                  const added = tileList.some(existing => existing.key === tile.key)
                  return (
                    <div key={tile.key} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
                      <button type="button" onClick={() => runEntry(tile)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                        <PcCover src={recent.cover} alt={recent.title} className="h-8 w-8 shrink-0" rounded="rounded-md" />
                        <span className={`min-w-0 flex-1 truncate text-[12px] ${theme.text}`}>{recent.title}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={added ? `移除 ${recent.title}` : `添加 ${recent.title}`}
                        disabled={!added && tileList.length >= maxSelect}
                        onClick={() => (added ? removeTile(tile.key) : addTile(tile))}
                        className={`flex h-5 w-5 items-center justify-center rounded-full border transition disabled:opacity-30 ${added ? '' : dark ? 'border-white/25 text-white/70' : 'border-black/20 text-slate-500'}`}
                      >
                        {added ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                      </button>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          {!loggedIn && <p className={`mt-4 text-[12px] ${theme.faint}`}>登录后可在这里看到常听艺人与最近常听</p>}
          <p className={`mt-4 flex items-center gap-1 text-[11px] ${theme.faint}`}>
            <Sparkles className="h-3 w-3" />官方条目里的听书 / AI 唱 / 数字专辑在本软件没有数据源，这里不提供
          </p>
        </div>
      )}

      <div className={`flex shrink-0 items-center gap-1 border-t px-3 py-2.5 ${theme.divider}`}>
        {/* 左下角：折叠左栏（官方客户端是左箭头，不是搜索；搜索已上移到顶栏） */}
        <button type="button" onClick={onToggleCollapse} title="折叠左栏" aria-label="折叠左栏" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" onClick={() => onNavigate('settings')} title="设置" aria-label="设置" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><SettingsIcon className="h-4 w-4" /></button>
        <button type="button" onClick={() => onNavigate('profile')} title="个人中心" aria-label="个人中心" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><User className="h-4 w-4" /></button>
        <button type="button" onClick={onToggleMode} title="切换界面模式" aria-label="切换界面模式" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><Laptop2 className="h-4 w-4" /></button>
      </div>
    </aside>
  )
}

export default memo(QQPcSidebar)
