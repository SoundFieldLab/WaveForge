// 传统模式「Apple Music 客户端」左栏复刻。
//
// 依据官方 Windows 客户端（AppleInc.AppleMusicWin）侧栏的 UIA 零干扰取证：
//   · 侧栏宽 290px；顶部搜索框 272×32（圆角 8、#fbfbfb 底 + #e5e5e5 描边、右侧放大镜）；
//   · 导航项行高 36px、行距 4px；顶级项图标 x=13 / 文字 x=47，子项整体再缩进 31px；
//   · 「资料库」「播放列表」是可折叠分组标题行（右侧 更多/新建 + 折叠箭头）；
//   · 底部账号行（头像 20px + 昵称），与导航区之间留白。
// 选中态：整行 #eaeaea 胶囊 + 左缘 3px 品牌红竖条（截图实测）。
// 顶栏（窗口标题栏 / 播放控件）按需求不复刻——播放控件由本软件第三栏承担。
import { memo, useMemo, useState } from 'react'
import {
  Clock, ChevronDown, Disc, House, LayoutGrid, Library, ListMusic, Mic, MoreHorizontal, Music2,
  Plus, Radio, Search, SquarePlay,
} from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { AppleMusicAppIcon, applePcTheme, type ApplePcTone } from './applePcKit'

export type ApplePcNavKey = 'home' | 'radio' | 'added' | 'artists' | 'albums' | 'songs' | 'playlists' | 'favorites'

export interface ApplePcSidebarProps {
  tone: ApplePcTone
  loggedIn: boolean
  username: string
  avatar?: string
  /** 当前高亮项（由当前页面反推；搜索页不高亮任何项） */
  currentKey: ApplePcNavKey | ''
  onNavigate: (key: ApplePcNavKey) => void
  /** 搜索框：回车或点放大镜进入搜索页 */
  onSearch: (keyword: string) => void
  /** 底部账号行：打开账号面板（登录 / 账号信息 / 退出） */
  onAccountClick: () => void
  /** 资源库分组「更多」菜单里的刷新（真实重新拉取） */
  onRefreshLibrary?: () => void
  /** 播放列表分组「+」新建播放列表 */
  onCreatePlaylist?: () => void
  /** 侧栏宽度（默认客户端实测 290px） */
  width?: number
}

const NAV_ICON_SIZE = 'h-[21px] w-[21px]'
const SUB_ICON_SIZE = 'h-[20px] w-[20px]'

function NavRow({ icon, label, active, theme, indent = false, onClick, right }: {
  icon: React.ReactNode
  label: string
  active: boolean
  theme: ReturnType<typeof applePcTheme>
  indent?: boolean
  onClick: () => void
  right?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex w-full items-center rounded-lg text-left transition"
      style={{ height: 36, background: active ? theme.pill : 'transparent' }}
      onMouseEnter={event => { if (!active) event.currentTarget.style.background = theme.tone === 'light' ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.05)' }}
      onMouseLeave={event => { if (!active) event.currentTarget.style.background = 'transparent' }}
    >
      {active && <span className="absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-full" style={{ background: theme.accent }} />}
      <span className={`flex items-center justify-center ${indent ? SUB_ICON_SIZE : NAV_ICON_SIZE}`} style={{ marginLeft: indent ? 44 : 13, color: theme.text }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium" style={{ marginLeft: 13, color: theme.text }}>{label}</span>
      {right}
    </button>
  )
}

/** 分组标题行（资料库 / 播放列表）：图标 + 名称 + 更多/新建 + 折叠箭头，整行可折叠。 */
function SectionRow({ icon, label, theme, expanded, onToggle, actionIcon, actionLabel, onAction, menu }: {
  icon: React.ReactNode
  label: string
  theme: ReturnType<typeof applePcTheme>
  expanded: boolean
  onToggle: () => void
  actionIcon: React.ReactNode
  actionLabel: string
  onAction?: () => void
  menu?: React.ReactNode
}) {
  return (
    <div className="relative flex w-full items-center" style={{ height: 36 }}>
      <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center text-left">
        <span className={`flex items-center justify-center ${NAV_ICON_SIZE}`} style={{ marginLeft: 13, color: theme.text }}>{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium" style={{ marginLeft: 13, color: theme.text }}>{label}</span>
      </button>
      <span className="flex shrink-0 items-center" style={{ marginRight: 12 }}>
        {onAction && (
          <button
            type="button"
            onClick={event => { event.stopPropagation(); onAction() }}
            aria-label={actionLabel}
            title={actionLabel}
            className="flex h-7 w-7 items-center justify-center rounded-md transition"
            style={{ color: theme.secondary }}
            onMouseEnter={event => { event.currentTarget.style.background = theme.hover }}
            onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
          >
            {actionIcon}
          </button>
        )}
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? `收起${label}` : `展开${label}`}
          className="flex h-7 w-7 items-center justify-center rounded-md transition"
          style={{ color: theme.secondary }}
          onMouseEnter={event => { event.currentTarget.style.background = theme.hover }}
          onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
        >
          <ChevronDown className="h-4 w-4 transition-transform" style={{ transform: expanded ? undefined : 'rotate(-90deg)' }} />
        </button>
      </span>
      {menu}
    </div>
  )
}

const ApplePcSidebar = memo(function ApplePcSidebar({
  tone, loggedIn, username, avatar, currentKey, onNavigate, onSearch, onAccountClick,
  onRefreshLibrary, onCreatePlaylist, width = 290,
}: ApplePcSidebarProps) {
  const theme = useMemo(() => applePcTheme(tone), [tone])
  const [keyword, setKeyword] = useState('')
  const [libraryExpanded, setLibraryExpanded] = useState(true)
  const [playlistsExpanded, setPlaylistsExpanded] = useState(true)
  const [libraryMenu, setLibraryMenu] = useState(false)

  return (
    <aside
      className="hidden min-h-0 flex-col lg:flex"
      style={{ width, background: theme.background, borderRight: `1px solid ${theme.divider}` }}
      data-testid="apple-pc-sidebar"
    >
      {/* 搜索框：客户端 272×32、圆角 8、右端放大镜 */}
      <div className="shrink-0" style={{ padding: '9px 9px 0' }}>
        <div className="flex h-8 items-center rounded-lg" style={{ background: theme.fieldBg, border: `1px solid ${theme.fieldBorder}` }}>
          <input
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') onSearch(keyword.trim()) }}
            placeholder="搜索"
            aria-label="搜索"
            className="min-w-0 flex-1 bg-transparent pl-3 text-[15px] outline-none placeholder:opacity-100"
            style={{ color: theme.text }}
          />
          <button
            type="button"
            onClick={() => onSearch(keyword.trim())}
            aria-label="搜索"
            className="flex h-8 w-9 shrink-0 items-center justify-center rounded-r-lg"
            style={{ color: theme.secondary }}
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 导航区（客户端：顶栏下方 9px 起，行距 4px） */}
      <nav className="min-h-0 flex-1 overflow-y-auto apple-pc-scroll" style={{ padding: '14px 9px 8px' }}>
        <div className="space-y-1">
          <NavRow icon={<House className={NAV_ICON_SIZE} strokeWidth={1.6} />} label="主页" active={currentKey === 'home'} theme={theme} onClick={() => onNavigate('home')} />
          <NavRow icon={<Radio className={NAV_ICON_SIZE} strokeWidth={1.6} />} label="广播" active={currentKey === 'radio'} theme={theme} onClick={() => onNavigate('radio')} />

          <SectionRow
            icon={<Library className={NAV_ICON_SIZE} strokeWidth={1.6} />}
            label="资料库"
            theme={theme}
            expanded={libraryExpanded}
            onToggle={() => setLibraryExpanded(value => !value)}
            actionIcon={<MoreHorizontal className="h-4 w-4" />}
            actionLabel="更多"
            onAction={onRefreshLibrary ? () => setLibraryMenu(value => !value) : undefined}
            menu={libraryMenu ? (
              <div className="absolute right-2 top-8 z-30 w-44 rounded-lg p-1 shadow-xl" style={{ background: theme.panel, border: `1px solid ${theme.divider}` }}>
                <button
                  type="button"
                  onClick={() => { setLibraryMenu(false); onRefreshLibrary?.() }}
                  className="w-full rounded-md px-2.5 py-1.5 text-left text-[13px] transition"
                  style={{ color: theme.text }}
                  onMouseEnter={event => { event.currentTarget.style.background = theme.hover }}
                  onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
                >
                  重新载入资料库
                </button>
              </div>
            ) : null}
          />
          {libraryExpanded && (
            <div className="space-y-1">
              <NavRow indent icon={<Clock className={SUB_ICON_SIZE} strokeWidth={1.6} />} label="最近添加" active={currentKey === 'added'} theme={theme} onClick={() => onNavigate('added')} />
              <NavRow indent icon={<Mic className={SUB_ICON_SIZE} strokeWidth={1.6} />} label="艺人" active={currentKey === 'artists'} theme={theme} onClick={() => onNavigate('artists')} />
              <NavRow indent icon={<Disc className={SUB_ICON_SIZE} strokeWidth={1.6} />} label="专辑" active={currentKey === 'albums'} theme={theme} onClick={() => onNavigate('albums')} />
              <NavRow indent icon={<Music2 className={SUB_ICON_SIZE} strokeWidth={1.6} />} label="歌曲" active={currentKey === 'songs'} theme={theme} onClick={() => onNavigate('songs')} />
            </div>
          )}

          <SectionRow
            icon={<ListMusic className={NAV_ICON_SIZE} strokeWidth={1.6} />}
            label="播放列表"
            theme={theme}
            expanded={playlistsExpanded}
            onToggle={() => setPlaylistsExpanded(value => !value)}
            actionIcon={<Plus className="h-4 w-4" />}
            actionLabel="新建播放列表"
            onAction={onCreatePlaylist}
          />
          {playlistsExpanded && (
            <div className="space-y-1">
              <NavRow indent icon={<LayoutGrid className={SUB_ICON_SIZE} strokeWidth={1.6} />} label="所有播放列表" active={currentKey === 'playlists'} theme={theme} onClick={() => onNavigate('playlists')} />
              <NavRow indent icon={<SquarePlay className={SUB_ICON_SIZE} strokeWidth={1.6} />} label="喜爱歌曲" active={currentKey === 'favorites'} theme={theme} onClick={() => onNavigate('favorites')} />
            </div>
          )}
        </div>
      </nav>

      {/* 底部账号行（客户端：头像 + 昵称，点击打开账号面板） */}
      <div className="shrink-0 px-2 pb-2 pt-1">
        <button
          type="button"
          onClick={onAccountClick}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition"
          style={{ height: 36 }}
          onMouseEnter={event => { event.currentTarget.style.background = theme.tone === 'light' ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.05)' }}
          onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
        >
          {loggedIn && avatar
            ? <CachedImage src={avatar} alt={username || '账号'} className="h-5 w-5 shrink-0 rounded-full object-cover" role="compact" priority="visible" fallback={<AppleMusicAppIcon className="h-5 w-5" radius={10} />} />
            : <AppleMusicAppIcon className="h-5 w-5" radius={10} />}
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium" style={{ color: theme.text }}>
            {loggedIn ? (username || 'Apple Music 账号') : '登录 Apple Music'}
          </span>
        </button>
      </div>
    </aside>
  )
})

export default ApplePcSidebar
