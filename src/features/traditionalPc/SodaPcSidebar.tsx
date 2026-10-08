// 汽水音乐 PC 客户端左栏复刻。
//
// 版式与量度严格对齐客户端 src/renderer/layouts/Sidebar.vue：
//   容器 200px；logo 区 44px；分组间距 24px；条目高 40px / 圆角 8px / 内边距 0 10px；
//   图标 16px 右距 8px；标签 14px/500；分组标题 13px/500/行高 26px/白 50%。
//   选中态底色 rgba(255,255,255,.1)，悬停 rgba(255,255,255,.05)（客户端同值）。
//
// 这里是「左侧栏」的替换实现；右侧「正在播放 / 播放列表 / 同步歌词」第三栏由 TraditionalView
// 继续渲染，本组件不涉及。
import { memo, type RefObject } from 'react'
import { Heart, History, ListMusic, Plus, Music2, type LucideIcon } from 'lucide-react'
import { PcCover, pcTheme, type PcTone } from './pcKit'
import {
  SODA_PC_NAV_TOP,
  SODA_PC_SIDEBAR_METRICS as M,
  type SodaPcNavKey,
} from './SodaPcShared'

export interface SodaPcSidebarProps {
  tone: PcTone
  accent: string
  currentKey: SodaPcNavKey | ''
  onNavigate: (key: SodaPcNavKey) => void
  /** 尚未具备数据源的入口（如 听歌模式）：保留客户端入口形态，但标注不可用，不放假数据 */
  unsupportedKeys?: ReadonlySet<SodaPcNavKey>
  /** 我喜欢的音乐 / 抖音收藏的音乐的虚拟歌单（用于真实跳转；缺省时只切页） */
  likedPlaylist?: any
  douyinPlaylist?: any
  onOpenPlaylist: (playlist: any) => void
  onPlaylistMenu: (payload: { show: boolean; x: number; y: number; playlist: any | null }) => void
  /** 创建的歌单（客户端左栏只有这一组，没有「收藏的歌单」分页） */
  minePlaylists: any[]
  playlistsLoading: boolean
  /** 新建歌单：客户端歌单区标题右侧的 + */
  canCreatePlaylist: boolean
  creatingPlaylist: boolean
  newPlaylistName: string
  onNewPlaylistName: (value: string) => void
  onToggleCreate: () => void
  onConfirmCreate: () => void
  onCancelCreate: () => void
  creatingBusy: boolean
  playlistScrollRef: RefObject<HTMLDivElement | null>
}

function SodaPcSidebar({
  tone, accent, currentKey, onNavigate, unsupportedKeys,
  likedPlaylist, douyinPlaylist, onOpenPlaylist, onPlaylistMenu,
  minePlaylists, playlistsLoading,
  canCreatePlaylist, creatingPlaylist, newPlaylistName, onNewPlaylistName,
  onToggleCreate, onConfirmCreate, onCancelCreate, creatingBusy, playlistScrollRef,
}: SodaPcSidebarProps) {
  const theme = pcTheme(tone)
  const dark = tone === 'dark'
  // 客户端是深色面板叠在专辑色背景上，这里同样用「白字 + 低透明底色」的同一套语言
  const activeBg = dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.055)'
  const hoverBg = dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.035)'
  const itemColor = dark ? 'rgba(255,255,255,.85)' : 'rgba(15,23,42,.85)'
  const sectionColor = dark ? 'rgba(255,255,255,.50)' : 'rgba(15,23,42,.50)'

  const renderItem = (
    key: SodaPcNavKey,
    label: string,
    Icon: LucideIcon,
    onClick?: () => void,
  ) => {
    const active = currentKey === key
    const unsupported = Boolean(unsupportedKeys?.has(key))
    return (
      <button
        key={key}
        type="button"
        onClick={onClick || (() => onNavigate(key))}
        title={unsupported ? '该功能暂无数据源' : undefined}
        className="flex w-full items-center transition-colors"
        style={{
          height: M.itemHeight,
          borderRadius: M.itemRadius,
          padding: `0 ${M.itemPaddingX}px`,
          background: active ? activeBg : undefined,
          color: itemColor,
          opacity: unsupported ? .55 : 1,
        }}
        onMouseEnter={event => { if (!active) event.currentTarget.style.background = hoverBg }}
        onMouseLeave={event => { if (!active) event.currentTarget.style.background = '' }}
      >
        <Icon className="shrink-0" style={{ width: M.iconSize, height: M.iconSize, marginRight: M.iconGap }} />
        <span className="min-w-0 flex-1 truncate text-left" style={{ fontSize: M.labelSize, fontWeight: 500 }}>{label}</span>
        {unsupported && <span className="shrink-0 text-[10px]" style={{ color: sectionColor }}>暂不支持</span>}
      </button>
    )
  }

  const sectionTitle = (text: string, extra?: React.ReactNode) => (
    <div className="flex items-center justify-between" style={{ color: sectionColor, fontSize: M.sectionTitleSize, fontWeight: 500, lineHeight: `${M.sectionTitleLineHeight}px`, padding: '0 10px' }}>
      <span>{text}</span>
      {extra}
    </div>
  )

  return (
    <aside
      data-soda-pc-sidebar=""
      className={`hidden min-h-0 flex-col border-r lg:flex ${theme.divider}`}
      style={{ width: M.width, flex: `0 0 ${M.width}px` }}
    >
      {/* logo 区：客户端是 44px 的「汽水音乐」字标 */}
      <div className="flex shrink-0 items-center gap-2 px-6" style={{ height: M.logoHeight }}>
        <span className="flex h-5 w-5 items-center justify-center rounded" style={{ background: accent }}>
          <Music2 className="h-3 w-3 text-white" />
        </span>
        <span className={`text-[15px] font-semibold ${theme.text}`}>汽水音乐</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ paddingBottom: 100 }}>
        <div className="flex flex-col" style={{ gap: M.menuGap, margin: `0 ${M.menuMarginX}px` }}>
          {SODA_PC_NAV_TOP.map(item => renderItem(item.key, item.label, item.icon))}
        </div>

        <div className="flex flex-col" style={{ gap: M.menuGap, margin: `0 ${M.menuMarginX}px`, marginTop: M.groupGap }}>
          {sectionTitle('我的音乐')}
          {renderItem('liked', '我喜欢的音乐', Heart, likedPlaylist ? () => onOpenPlaylist(likedPlaylist) : undefined)}
          {renderItem('douyin', '抖音收藏的音乐', Music2, douyinPlaylist ? () => onOpenPlaylist(douyinPlaylist) : undefined)}
          {renderItem('history', '历史播放', History)}
        </div>

        {/* 创建的歌单（客户端：标题右侧 +，下面是自建歌单） */}
        <div className="flex flex-col" style={{ gap: M.menuGap, margin: `0 ${M.menuMarginX}px`, marginTop: M.groupGap }}>
          {sectionTitle('创建的歌单', (
            <button
              type="button"
              onClick={() => { if (!canCreatePlaylist) return; onToggleCreate() }}
              disabled={!canCreatePlaylist}
              title={canCreatePlaylist ? '创建歌单' : '该平台不支持创建歌单'}
              className="flex h-5 w-5 items-center justify-center rounded disabled:opacity-30"
              style={{ color: sectionColor }}
            >
              <Plus className="h-3 w-3" />
            </button>
          ))}
          {creatingPlaylist && (
            <div className="mt-1 px-1">
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
          <div ref={playlistScrollRef} data-testid="soda-pc-playlist-scroll" className="mt-1 space-y-0.5">
            {minePlaylists.map((playlist: any) => (
              <button
                key={`${playlist.platform || 'soda'}:${playlist.id}`}
                type="button"
                onClick={() => onOpenPlaylist(playlist)}
                onContextMenu={event => { event.preventDefault(); onPlaylistMenu({ show: true, x: event.clientX, y: event.clientY, playlist }) }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors"
                onMouseEnter={event => { event.currentTarget.style.background = hoverBg }}
                onMouseLeave={event => { event.currentTarget.style.background = '' }}
              >
                {playlist.coverUrl || playlist.coverImgUrl
                  ? <PcCover src={playlist.coverUrl || playlist.coverImgUrl} alt={`${playlist.name}封面`} className="h-8 w-8 shrink-0" rounded="rounded-md" />
                  : <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: `${accent}22` }}><ListMusic className="h-3.5 w-3.5 opacity-40" /></span>}
                <span className={`min-w-0 flex-1 truncate text-[13px] ${theme.text}`}>{playlist.name}</span>
              </button>
            ))}
            {!playlistsLoading && minePlaylists.length === 0 && (
              <p className={`px-2 py-3 text-center text-[11px] ${theme.faint}`}>还没有创建歌单</p>
            )}
            {playlistsLoading && <p className={`px-2 py-3 text-center text-[11px] ${theme.faint}`}>正在加载歌单…</p>}
          </div>
        </div>
        {/* 客户端左栏到此为止：搜索在顶栏、账号卡与设置入口在右上/头像菜单，
            这里不再重复渲染（产品明确要求）。 */}
      </div>
    </aside>
  )
}

export default memo(SodaPcSidebar)
