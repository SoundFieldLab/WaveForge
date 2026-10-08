// 网易云音乐 PC 客户端风格左栏（逆向官方 3.x 布局）：
// 「网易云音乐」品牌头 → 推荐/精选/播客/漫游/关注 → 我的（我喜欢的音乐/最近播放/我的播客/
// 我的收藏/我的音乐云盘 + 收起）→ 创建的歌单 N / 收藏的歌单 N + 歌单列表。
// 没有数据源的入口（下载管理 / 本地音乐）按产品决策永久不做——直接不渲染。
// 当前项 = 实心红底白字药丸（官方同款）；底部保留本软件的设置/模式入口。
// 左下角 = 折叠按钮（官方客户端是左箭头；搜索已上移到顶栏，图4红框位置）。
// 折叠态 = 56px 图标轨道（导航 + 我的 + 底部工具 + 右箭头展开），与 QQ 左栏同款。
import { memo, type RefObject } from 'react'
import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, Compass, HardDrive, Heart, Home, ListMusic, Mail,
  Mic2, Plus, Radio, Settings as SettingsIcon, SlidersHorizontal, Star, User,
} from 'lucide-react'
import { PcCover, pcTheme, type PcTone } from './pcKit'

export type NeteasePcNavKey =
  | 'home' | 'featured' | 'podcast' | 'roam' | 'follow'
  | 'liked' | 'recent' | 'mypodcast' | 'collect' | 'cloud'
  | 'search' | 'profile' | 'settings'

export interface NeteasePcSidebarProps {
  tone: PcTone
  accent: string
  loggedIn: boolean
  username: string
  avatar?: string
  currentKey: NeteasePcNavKey | ''
  counts: { liked?: number; recent?: number; mypodcast?: number; collect?: number }
  createdPlaylists: any[]
  collectedPlaylists: any[]
  myExpanded: boolean
  onToggleMy: () => void
  onOpenPlaylist: (playlist: any) => void
  onPlaylistMenu: (menu: { show: boolean; x: number; y: number; playlist: any | null }) => void
  onNavigate: (key: NeteasePcNavKey) => void
  creatingPlaylist: boolean
  newPlaylistName: string
  onNewPlaylistName: (value: string) => void
  onConfirmCreate: () => void
  onCancelCreate: () => void
  creatingBusy: boolean
  onToggleCreate: () => void
  onLoginClick: () => void
  onToggleMode: () => void
  createdScrollRef: RefObject<HTMLDivElement | null>
  /** 折叠成 56px 图标轨道（官方客户端左下角左箭头的行为） */
  collapsed?: boolean
  onToggleCollapse?: () => void
}

function NeteasePcSidebar({
  tone, accent, loggedIn, username, avatar, currentKey, counts, createdPlaylists, collectedPlaylists,
  myExpanded, onToggleMy, onOpenPlaylist, onPlaylistMenu, onNavigate, creatingPlaylist, newPlaylistName,
  onNewPlaylistName, onConfirmCreate, onCancelCreate, creatingBusy, onToggleCreate, onLoginClick, onToggleMode,
  createdScrollRef, collapsed = false, onToggleCollapse,
}: NeteasePcSidebarProps) {
  const theme = pcTheme(tone)
  const dark = tone === 'dark'
  const idleText = dark ? 'text-white/62' : 'text-slate-600'
  const hoverBg = dark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.04]'
  // 官方当前项：实心强调色药丸 + 白色文字/图标
  const activeStyle = { background: accent, color: '#fff' } as const

  const topNav: Array<{ key: NeteasePcNavKey; label: string; Icon: typeof Home; tag?: string }> = [
    { key: 'home', label: '推荐', Icon: Home },
    { key: 'featured', label: '精选', Icon: Compass },
    { key: 'podcast', label: '播客', Icon: Mic2, tag: '最新音乐' },
    { key: 'roam', label: '漫游', Icon: Radio },
    { key: 'follow', label: '关注', Icon: Mail },
  ]

  // 「下载管理 / 本地音乐」为产品决策上永久不支持的能力（无下载链路、无本地扫描），入口直接不渲染
  const myItems: Array<{ key: NeteasePcNavKey; label: string; Icon: typeof Heart; count?: number }> = [
    { key: 'liked', label: '我喜欢的音乐', Icon: Heart, count: counts.liked },
    { key: 'recent', label: '最近播放', Icon: Clock, count: counts.recent },
    { key: 'mypodcast', label: '我的播客', Icon: Mic2, count: counts.mypodcast },
    { key: 'collect', label: '我的收藏', Icon: Star, count: counts.collect },
    { key: 'cloud', label: '我的音乐云盘', Icon: HardDrive },
  ]

  const renderPlaylist = (playlist: any, prefix: string) => (
    <button
      key={`${prefix}:${playlist.platform || 'netease'}:${playlist.id}`}
      type="button"
      onClick={() => onOpenPlaylist(playlist)}
      onContextMenu={event => { event.preventDefault(); onPlaylistMenu({ show: true, x: event.clientX, y: event.clientY, playlist }) }}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-[5px] text-left transition ${hoverBg}`}
    >
      <PcCover src={playlist.coverImgUrl || playlist.coverUrl} alt={`${playlist.name}封面`} className="h-8 w-8 shrink-0" rounded="rounded-md" />
      <span className={`min-w-0 flex-1 truncate text-[12px] ${theme.text}`}>{playlist.name}</span>
    </button>
  )

  // 折叠态：56px 图标轨道（品牌位 / 主导航 / 我的 / 底部工具 + 右箭头展开），与 QQ 左栏同款
  if (collapsed) {
    return (
      <aside className={`hidden min-h-0 flex-col items-center gap-1 overflow-y-auto border-r py-4 lg:flex ${theme.divider}`}>
        <button type="button" onClick={() => (loggedIn ? onNavigate('profile') : onLoginClick())} title={loggedIn ? (username || '我的账户') : '登录'} className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: accent }}>
          <MusicNoteGlyph />
        </button>
        {topNav.map(({ key, label, Icon }) => (
          <button key={key} type="button" title={label} aria-label={label} onClick={() => onNavigate(key)} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${currentKey === key ? 'font-medium' : `${idleText} hover:opacity-80`}`} style={currentKey === key ? activeStyle : undefined}>
            <Icon className="h-[18px] w-[18px]" />
          </button>
        ))}
        <span className={`my-1 h-px w-7 shrink-0 ${dark ? 'bg-white/12' : 'bg-black/10'}`} />
        {myItems.map(({ key, label, Icon }) => (
          <button key={key} type="button" title={label} aria-label={label} onClick={() => onNavigate(key)} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition ${currentKey === key ? 'font-medium' : `${idleText} hover:opacity-80`}`} style={currentKey === key ? activeStyle : undefined}>
            <Icon className="h-4 w-4" />
          </button>
        ))}
        <div className="mt-auto flex shrink-0 flex-col items-center gap-1 pt-2">
          <button type="button" onClick={onToggleCollapse} title="展开左栏" aria-label="展开左栏" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={() => onNavigate('settings')} title="设置" aria-label="设置" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><SettingsIcon className="h-4 w-4" /></button>
          <button type="button" onClick={onToggleMode} title="切换界面模式" aria-label="切换界面模式" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><SlidersHorizontal className="h-4 w-4" /></button>
        </div>
      </aside>
    )
  }

  return (
    <aside className={`hidden min-h-0 flex-col lg:flex ${theme.divider} border-r`}>
      {/* 品牌头 + 账号 */}
      <div className="shrink-0 px-4 pb-1 pt-4">
        <button type="button" onClick={() => (loggedIn ? onNavigate('profile') : onLoginClick())} className="flex w-full items-center gap-2 text-left">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: accent }}>
            <MusicNoteGlyph />
          </span>
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[17px] font-semibold leading-tight ${theme.text}`}>网易云音乐</span>
          </span>
          {avatar
            ? <PcCover src={avatar} alt={`${username || '用户'}头像`} className="h-6 w-6 shrink-0" rounded="rounded-full" eager />
            : <User className={`h-4 w-4 shrink-0 ${theme.faint}`} />}
        </button>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3">
        <nav className="space-y-0.5">
          {topNav.map(({ key, label, Icon, tag }) => {
            const active = currentKey === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => onNavigate(key)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-[7px] text-[13px] transition ${active ? 'font-medium' : `${idleText} ${hoverBg}`}`}
                style={active ? activeStyle : undefined}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                {tag ? <span className={`shrink-0 rounded-[3px] border px-1 text-[10px] leading-[14px] ${active ? 'border-white/60 text-white/90' : `${theme.faint} ${dark ? 'border-white/20' : 'border-black/15'}`}`}>{tag}</span> : null}
              </button>
            )
          })}
        </nav>

        {/* 我的（官方标题旁无操作位，右侧的编辑按钮已按产品决策移除） */}
        <div className="mt-5 px-3">
          <span className={`text-[12px] ${theme.faint}`}>我的</span>
        </div>
        {myExpanded && (
          <nav className="mt-1 space-y-0.5">
            {myItems.map(({ key, label, Icon, count }) => {
              const active = currentKey === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onNavigate(key)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-[7px] text-[13px] transition ${active ? 'font-medium' : `${idleText} ${hoverBg}`}`}
                  style={active ? activeStyle : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left">{label}{typeof count === 'number' && count > 0 ? ` ${count}` : ''}</span>
                </button>
              )
            })}
          </nav>
        )}
        <button
          type="button"
          onClick={onToggleMy}
          className={`mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-[6px] text-[12px] ${theme.faint} ${hoverBg}`}
        >
          {myExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {myExpanded ? '收起' : '展开'}
        </button>

        {/* 创建的歌单 */}
        <div className="mt-4 flex items-center justify-between px-3">
          <span className={`text-[12px] ${theme.faint}`}>创建的歌单 {createdPlaylists.length}</span>
          <button type="button" onClick={onToggleCreate} className={`rounded p-0.5 ${theme.faint} hover:opacity-80`} aria-label="新建歌单"><Plus className="h-3.5 w-3.5" /></button>
        </div>
        {creatingPlaylist && (
          <div className="mt-1.5 px-1">
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
        <div ref={createdScrollRef} data-testid="traditional-playlist-scroll" className="mt-1 space-y-0.5">
          {createdPlaylists.map(playlist => renderPlaylist(playlist, 'created'))}
          {createdPlaylists.length === 0 && <p className={`px-3 py-2 text-[11px] ${theme.faint}`}>暂无创建的歌单</p>}
        </div>

        {/* 收藏的歌单 */}
        {collectedPlaylists.length > 0 && (
          <>
            <div className="mt-4 flex items-center justify-between px-3">
              <span className={`text-[12px] ${theme.faint}`}>收藏的歌单 {collectedPlaylists.length}</span>
              <ListMusic className={`h-3.5 w-3.5 ${theme.faint}`} />
            </div>
            <div className="mt-1 space-y-0.5 pb-2">
              {collectedPlaylists.map(playlist => renderPlaylist(playlist, 'collected'))}
            </div>
          </>
        )}
      </div>

      {/* 底部工具行：左下角 = 折叠左栏（官方客户端是左箭头，不是搜索；搜索已上移到顶栏） */}
      <div className={`flex shrink-0 items-center gap-1 border-t px-3 py-2.5 ${theme.divider}`}>
        <button type="button" onClick={onToggleCollapse} title="折叠左栏" aria-label="折叠左栏" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><ChevronLeft className="h-4 w-4" /></button>
        <button type="button" onClick={() => onNavigate('settings')} title="设置" aria-label="设置" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><SettingsIcon className="h-4 w-4" /></button>
        <button type="button" onClick={() => onNavigate('profile')} title="个人中心" aria-label="个人中心" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><User className="h-4 w-4" /></button>
        <button type="button" onClick={onToggleMode} title="切换界面模式" aria-label="切换界面模式" className={`flex h-8 w-8 items-center justify-center rounded-lg ${theme.subtle} ${dark ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}><SlidersHorizontal className="h-4 w-4" /></button>
      </div>
    </aside>
  )
}

/** 网易云音乐品牌音符图形（红底白音符，替代官方 logo 位）。 */
function MusicNoteGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M10 16V9.2l5-1.2v6.4" />
      <circle cx="8.6" cy="16.4" r="1.6" fill="#fff" stroke="none" />
      <circle cx="13.6" cy="14.8" r="1.6" fill="#fff" stroke="none" />
    </svg>
  )
}

export default memo(NeteasePcSidebar)
