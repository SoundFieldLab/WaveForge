// 酷狗音乐 PC 客户端风格左栏：账号卡 → 一级导航（音乐/听书/刷歌/收藏/最近/本地/我的听书/云盘/已购）
// → 自建歌单|收藏歌单 + 歌单列表（含「我喜欢」）→ 新建入口。
//
// 布局对齐官方客户端截图（D:\opencode\.tmp-kg-tab-yinyue.png）：去掉了官方的直播入口，
// 其余项与官方一致；每一项都是真实落点，没有数据源的项在页面里给空态说明而不是假数据。
import { memo, useState, type RefObject } from 'react'
import {
  BookAudio, ChevronDown, Clock, Cloud, Disc3, Download, Heart, Library,
  Music2, Plus, User,
} from 'lucide-react'
import { PcCover, pcTheme, type PcTone } from './pcKit'

export type KugouPcNavKey =
  | 'music'
  | 'longaudio'
  | 'shuffle'
  | 'favorites'
  | 'recent'
  | 'local'
  | 'mylongaudio'
  | 'cloud'
  | 'purchased'

export interface KugouPcNavItem {
  key: KugouPcNavKey
  label: string
  icon: typeof Music2
}

/** 一级导航（官方顺序：音乐/听书/直播/刷歌 → 我的收藏/最近播放/本地与下载/我的听书/音乐云盘/已购音乐）。
 *  按产品决策去掉：直播、刷歌（上游动态流恒空）、本地与下载（不做下载功能）、音乐云盘。
 *  保留 'local'/'cloud' 于联合类型仅为兼容既有 switch 分支，导航不再渲染。 */
export const KUGOU_PC_NAV: KugouPcNavItem[] = [
  { key: 'music', label: '音乐', icon: Music2 },
  { key: 'longaudio', label: '听书', icon: BookAudio },
  { key: 'favorites', label: '我的收藏', icon: Heart },
  { key: 'recent', label: '最近播放', icon: Clock },
  { key: 'mylongaudio', label: '我的听书', icon: Library },
  { key: 'purchased', label: '已购音乐', icon: Disc3 },
]

export interface KugouPcSidebarProps {
  tone: PcTone
  accent: string
  loggedIn: boolean
  username: string
  avatar?: string
  currentKey: KugouPcNavKey
  onNavigate: (key: KugouPcNavKey) => void
  onLoginClick: () => void
  /** 歌单列表：自建 / 收藏（含「我喜欢」） */
  minePlaylists: any[]
  collectedPlaylists: any[]
  playlistsLoading: boolean
  onOpenPlaylist: (playlist: any) => void
  onPlaylistMenu: (payload: { show: boolean; x: number; y: number; playlist: any | null }) => void
  creatingPlaylist: boolean
  newPlaylistName: string
  onNewPlaylistName: (value: string) => void
  onToggleCreate: () => void
  onConfirmCreate: () => void
  onCancelCreate: () => void
  creatingBusy: boolean
  playlistScrollRef: RefObject<HTMLDivElement | null>
}

function KugouPcSidebar({
  tone, accent, loggedIn, username, avatar, currentKey, onNavigate, onLoginClick,
  minePlaylists, collectedPlaylists, playlistsLoading, onOpenPlaylist, onPlaylistMenu,
  creatingPlaylist, newPlaylistName, onNewPlaylistName, onToggleCreate, onConfirmCreate, onCancelCreate,
  creatingBusy, playlistScrollRef,
}: KugouPcSidebarProps) {
  const theme = pcTheme(tone)
  const dark = tone === 'dark'
  const activePill = dark ? 'bg-white/[0.12]' : 'bg-black/[0.055]'
  const idleText = dark ? 'text-white/62' : 'text-slate-600'
  const hoverBg = dark ? 'hover:bg-white/[0.06]' : 'hover:bg-black/[0.04]'
  // 「收起」是官方客户端的真实行为：折叠歌单区，只留一级导航
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<'mine' | 'collected'>('mine')
  // 「我喜欢」在官方客户端属于自建歌单区第一项（默认歌单），不随 tab 切换而消失
  const likedPlaylist = minePlaylists.find(item => item?.isLike)
  const restMine = minePlaylists.filter(item => item !== likedPlaylist)
  const list = tab === 'mine' ? restMine : collectedPlaylists

  return (
    <aside className={`relative hidden min-h-0 flex-col border-r lg:flex ${theme.divider}`} data-kugou-pc-sidebar="">
      <div className="shrink-0 px-4 pt-4">
        <button type="button" onClick={onLoginClick} className="flex w-full items-center gap-2.5 text-left">
          {avatar
            ? <PcCover src={avatar} alt={`${username || '用户'}头像`} className="h-9 w-9 shrink-0" rounded="rounded-full" eager />
            : <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${dark ? 'bg-white/[0.08]' : 'bg-black/[0.05]'}`}><User className={`h-4 w-4 ${theme.faint}`} /></span>}
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-[14px] font-medium ${theme.text}`}>{loggedIn ? (username || '我的账户') : '未登录'}</span>
            <span className={`mt-0.5 block text-[11px] ${theme.faint}`}>{loggedIn ? '酷狗概念版' : '点击登录酷狗'}</span>
          </span>
        </button>
      </div>

      <nav className="mt-3 shrink-0 space-y-0.5 px-2">
        {KUGOU_PC_NAV.map(({ key, label, icon: Icon }) => {
          const active = currentKey === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => onNavigate(key)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-[9px] text-[13px] transition ${active ? `${activePill} font-medium` : `${idleText} ${hoverBg}`}`}
              style={active ? { color: accent } : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{label}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-4 flex shrink-0 items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => setTab('mine')}
          className={`text-[13px] transition ${tab === 'mine' ? 'font-medium' : idleText}`}
          style={tab === 'mine' ? { color: dark ? '#fff' : '#111' } : undefined}
        >
          自建歌单
        </button>
        <span className={`text-[12px] ${theme.faint}`}>|</span>
        <button
          type="button"
          onClick={() => setTab('collected')}
          className={`text-[13px] transition ${tab === 'collected' ? 'font-medium' : idleText}`}
          style={tab === 'collected' ? { color: dark ? '#fff' : '#111' } : undefined}
        >
          收藏歌单
        </button>
        <button type="button" onClick={onToggleCreate} className={`ml-auto rounded p-1 ${theme.faint} hover:opacity-80`} aria-label="新建歌单" title="新建歌单">
          <Plus className="h-3.5 w-3.5" />
        </button>
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
            placeholder={loggedIn ? '歌单名称' : '登录后可新建歌单'}
            className={`h-8 w-full rounded-lg border bg-transparent px-2 text-[12px] outline-none ${dark ? 'border-white/20' : 'border-black/15'} ${theme.text}`}
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button type="button" disabled={creatingBusy || !newPlaylistName.trim()} onClick={() => void onConfirmCreate()} className="rounded-md px-2.5 py-1 text-[12px] text-white disabled:opacity-40" style={{ background: accent }}>创建</button>
            <button type="button" onClick={onCancelCreate} className={`rounded-md px-2 py-1 text-[12px] ${theme.faint}`}>取消</button>
          </div>
        </div>
      )}

      <div ref={playlistScrollRef} data-testid="kugou-pc-playlist-scroll" className={`mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 pb-2 ${collapsed ? 'hidden' : ''}`}>
        {likedPlaylist && (
          <button
            type="button"
            onClick={() => onOpenPlaylist(likedPlaylist)}
            onContextMenu={event => { event.preventDefault(); onPlaylistMenu({ show: true, x: event.clientX, y: event.clientY, playlist: likedPlaylist }) }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-[6px] text-left transition ${hoverBg}`}
          >
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${dark ? 'bg-white/[0.07]' : 'bg-black/[0.045]'}`}>
              <Heart className="h-4 w-4" style={{ color: accent }} />
            </span>
            <span className={`min-w-0 flex-1 truncate text-[12px] ${theme.text}`}>{likedPlaylist.name || '我喜欢'}</span>
          </button>
        )}
        {list.map((playlist: any) => (
          <button
            key={`${playlist.platform || 'kugou'}:${playlist.id || playlist.listid}`}
            type="button"
            onClick={() => onOpenPlaylist(playlist)}
            onContextMenu={event => { event.preventDefault(); onPlaylistMenu({ show: true, x: event.clientX, y: event.clientY, playlist }) }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-[6px] text-left transition ${hoverBg}`}
          >
            <PcCover src={playlist.coverImgUrl || playlist.coverUrl} alt={`${playlist.name}封面`} className="h-9 w-9 shrink-0" rounded="rounded-md" />
            <span className={`min-w-0 flex-1 truncate text-[12px] ${theme.text}`}>{playlist.name}</span>
          </button>
        ))}
        {!playlistsLoading && !likedPlaylist && list.length === 0 && (
          <p className={`px-2 py-4 text-center text-[11px] ${theme.faint}`}>
            {!loggedIn ? '登录后同步酷狗歌单' : tab === 'mine' ? '还没有创建歌单，点 + 新建' : '还没有收藏歌单'}
          </p>
        )}
        {playlistsLoading && <p className={`px-2 py-4 text-center text-[11px] ${theme.faint}`}>正在加载歌单…</p>}
      </div>

      <div className={`flex shrink-0 items-center gap-2 border-t px-4 py-2 ${theme.divider}`}>
        <button type="button" onClick={() => setCollapsed(value => !value)} className={`flex items-center gap-1 text-[11px] ${theme.faint} hover:opacity-80`}>
          <ChevronDown className={`h-3 w-3 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
          {collapsed ? '展开' : '收起'}
        </button>
      </div>
    </aside>
  )
}

export default memo(KugouPcSidebar)
