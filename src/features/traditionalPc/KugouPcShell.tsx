// 传统模式「酷狗音乐 PC 客户端」外壳：左导航 + 内容区（含官方页签）+ 右侧播放列表 + 底部播放条。
//
// 布局对齐官方客户端截图（D:\opencode\.tmp-kg-tab-yinyue.png / tuijian / shoucang / zuijin）：
// 去掉官方的广告位、直播、AI 帮唱、赚钱、游戏入口；右上是搜索，底部是播放条。
// 播放、右键菜单、喜欢、打开歌单/歌手/专辑一律回传 TraditionalView 的既有链路
// （actions 与 QQPc*/NeteasePc* 同源），听书走 src/features/kugouLongaudio 的独立 store + Overlay，
// 这里不新造任何播放器。
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import type { ExplorePayload } from '../../services/exploreApi'
import { fetchKugouUserPlaylists } from '../../services/kugouService'
import { PcEmpty, pcTheme, type PcTone } from './pcKit'
import type { PcActions, PcAccount } from './types'
import KugouPcSidebar, { type KugouPcNavKey } from './KugouPcSidebar'
import KugouPcHome from './KugouPcHome'
import KugouPcLibrary from './KugouPcLibrary'
import KugouPcChannels from './KugouPcChannels'
import KugouPcPlaylists, { KugouPcCategories } from './KugouPcPlaylists'
import KugouPcFavorites from './KugouPcFavorites'
import KugouPcRecent from './KugouPcRecent'
import KugouPcLongaudio from './KugouPcLongaudio'
import { KugouPcPurchased } from './KugouPcPersonal'
import { KUGOU_PC_MUSIC_TABS, type KugouPcMusicTab, type KugouPcPageContext } from './KugouPcShared'
import { kugouLongaudioStore } from '../kugouLongaudio/store'
import KugouLongaudioOverlay from '../kugouLongaudio/KugouLongaudioOverlay'

export interface KugouPcShellProps {
  chrome: { tone: PcTone; accent: string; skin?: string }
  account: PcAccount
  actions: PcActions
  payload: ExplorePayload | null
  authRevision?: number
  active?: boolean
  /** 播放状态透传（播放控制/队列 UI 在 TraditionalView 的统一右栏，外壳不再自绘底栏） */
  currentSong: Song | null
  queue: Song[]
  isPlaying: boolean
  liked?: boolean
  onPlayPause: () => void
  onNext: () => void
  onPrevious: () => void
  onToggleFavorite?: () => void
  onOpenMixingStudio?: () => void
  onOpenComments?: (song: Song) => void
  onSearchSubmit?: (keyword: string) => void
  onLoginClick?: () => void
  onToggleMode?: () => void
  /** 重新拉取探索 payload（频道空态的「重新加载」用；酷狗目录数据都在 payload 里） */
  onReloadData?: () => void
}

function KugouPcShell({
  chrome, account, actions, payload, authRevision = 0, active = true,
  currentSong, queue, isPlaying, liked = false,
  onPlayPause, onNext, onPrevious, onToggleFavorite,
  onOpenMixingStudio, onOpenComments, onSearchSubmit, onLoginClick,
  onReloadData,
}: KugouPcShellProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const dark = chrome.tone === 'dark'
  const [navKey, setNavKey] = useState<KugouPcNavKey>('music')
  const [musicTab, setMusicTab] = useState<KugouPcMusicTab>('discover')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [playlistTab, setPlaylistTab] = useState<'mine' | 'collected'>('mine')
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [creatingBusy, setCreatingBusy] = useState(false)
  const [playlists, setPlaylists] = useState<any[]>([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const playlistScrollRef = useRef<HTMLDivElement>(null)
  const playlistRequestRef = useRef(0)

  const loggedIn = Boolean(account?.loggedIn)

  /* ── 用户歌单（概念版通道；写操作后靠 playlist-content-changed 事件刷新，与其它平台一致） ── */
  const loadPlaylists = useCallback(async () => {
    const requestId = ++playlistRequestRef.current
    setPlaylistsLoading(true)
    try {
      const items = await fetchKugouUserPlaylists()
      if (requestId !== playlistRequestRef.current) return
      setPlaylists(items.map(item => ({
        id: item.specialid,
        listid: item.listid,
        name: item.name,
        coverImgUrl: item.coverUrl || '',
        coverUrl: item.coverUrl || '',
        trackCount: item.songcount || 0,
        playCount: item.playcount || 0,
        platform: 'kugou',
        isMine: item.isMine,
        // 「我喜欢」是系统默认歌单：上游 listid=2，名字固定为「我喜欢」
        isLike: item.listid === '2' || /我喜欢/.test(item.name || ''),
      })))
    } catch {
      if (requestId === playlistRequestRef.current) setPlaylists([])
    } finally {
      if (requestId === playlistRequestRef.current) setPlaylistsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void loadPlaylists()
  }, [active, loggedIn, authRevision, loadPlaylists])

  useEffect(() => {
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail || {}
      if (detail.platform && detail.platform !== 'kugou') return
      void loadPlaylists()
    }
    window.addEventListener('playlist-content-changed', onChanged)
    return () => window.removeEventListener('playlist-content-changed', onChanged)
  }, [loadPlaylists])

  const likedPlaylist = playlists.find(item => item.isLike) || null
  const minePlaylists = playlists.filter(item => item.isLike || item.isMine)
  const collectedPlaylists = playlists.filter(item => !item.isLike && !item.isMine)

  const handleCreatePlaylist = useCallback(async () => {
    const name = newPlaylistName.trim()
    if (!name || creatingBusy) return
    if (!loggedIn) { onLoginClick?.(); return }
    setCreatingBusy(true)
    try {
      const { createKugouUserPlaylist } = await import('../../services/kugouService')
      const result = await createKugouUserPlaylist(name)
      if (result.error) throw new Error(result.error)
      setCreatingPlaylist(false)
      setNewPlaylistName('')
      await loadPlaylists()
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '歌单已创建', type: 'success' } }))
    } catch (error) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: error instanceof Error ? error.message : '创建歌单失败', type: 'error' } }))
    } finally {
      setCreatingBusy(false)
    }
  }, [newPlaylistName, creatingBusy, loggedIn, onLoginClick, loadPlaylists])

  const ctx: KugouPcPageContext = useMemo(() => ({
    theme,
    accent,
    account,
    actions,
    active,
    openPlaylist: playlist => actions.onOpenPlaylist(playlist),
    openArtist: artistId => actions.onOpenArtist?.(artistId, 'kugou'),
    openAlbum: albumId => actions.onOpenAlbum?.(albumId, 'kugou'),
  }), [theme, accent, account, actions, active])

  const goMusic = useCallback((tab: KugouPcMusicTab) => {
    setNavKey('music')
    setMusicTab(tab)
  }, [])

  /** 分类页点标签：切到歌单页签并选中该标签（与探索页分类板块一致） */
  const pickTag = useCallback((tag: string | null) => {
    setSelectedTag(tag)
    setNavKey('music')
    setMusicTab('playlists')
  }, [])

  const handleNavigate = useCallback((key: KugouPcNavKey) => {
    if (key === 'mylongaudio') {
      // 「我的听书」是听书的独立界面（Overlay 的 library 视图），不是内容区页面
      kugouLongaudioStore.openLibrary()
      return
    }
    setNavKey(key)
  }, [])

  const openPlaylist = useCallback((playlist: any) => { actions.onOpenPlaylist(playlist) }, [actions])

  const content = (() => {
    if (navKey === 'music') {
      if (musicTab === 'discover') return <KugouPcHome ctx={ctx} payload={payload} onOpenTab={goMusic} />
      if (musicTab === 'library') return <KugouPcLibrary ctx={ctx} payload={payload} />
      if (musicTab === 'playlists') return <KugouPcPlaylists ctx={ctx} payload={payload} selectedTag={selectedTag} onSelectTag={setSelectedTag} />
      if (musicTab === 'channels') return <KugouPcChannels ctx={ctx} payload={payload} onSearch={onSearchSubmit} onRetry={onReloadData} />
      return <KugouPcCategories ctx={ctx} payload={payload} selectedTag={selectedTag} onSelectTag={pickTag} />
    }
    if (navKey === 'longaudio') return <KugouPcLongaudio ctx={ctx} />
    if (navKey === 'favorites') return <KugouPcFavorites ctx={ctx} likedPlaylist={likedPlaylist} minePlaylists={minePlaylists} collectedPlaylists={collectedPlaylists} onRefreshPlaylists={() => void loadPlaylists()} />
    if (navKey === 'recent') return <KugouPcRecent ctx={ctx} authRevision={authRevision} />
    if (navKey === 'purchased') return <KugouPcPurchased ctx={ctx} />
    // 兜底：导航表里没有的 key（官方的 直播/刷歌 已下线；本地与下载/音乐云盘 按产品决策不做）
    return (
      <PcEmpty
        theme={theme}
        title="该页面暂未提供"
        description="官方的直播 / AI 帮唱 / 赚钱 / 游戏入口按产品规范不提供。"
      />
    )
  })()

  const showTabs = navKey === 'music'

  return (
    <div className={`flex h-full min-h-0 ${dark ? 'bg-[#141419]' : 'bg-white'}`} data-kugou-pc-shell="">
      <KugouPcSidebar
        tone={chrome.tone}
        accent={accent}
        loggedIn={loggedIn}
        username={account?.username || ''}
        avatar={account?.avatar}
        currentKey={navKey}
        onNavigate={handleNavigate}
        onLoginClick={() => onLoginClick?.()}
        minePlaylists={minePlaylists}
        collectedPlaylists={collectedPlaylists}
        playlistsLoading={playlistsLoading}
        onOpenPlaylist={openPlaylist}
        onPlaylistMenu={payload => actions.onPlaylistMenu?.(payload)}
        creatingPlaylist={creatingPlaylist}
        newPlaylistName={newPlaylistName}
        onNewPlaylistName={setNewPlaylistName}
        onToggleCreate={() => { if (!loggedIn) { onLoginClick?.(); return } setCreatingPlaylist(value => !value) }}
        onConfirmCreate={() => void handleCreatePlaylist()}
        onCancelCreate={() => { setCreatingPlaylist(false); setNewPlaylistName('') }}
        creatingBusy={creatingBusy}
        playlistScrollRef={playlistScrollRef}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 顶行：官方页签 + 搜索（搜索走传统模式的搜索页，酷狗搜索已就绪） */}
          <div className={`flex shrink-0 flex-wrap items-center gap-2 border-b px-5 pb-0 pt-3 ${theme.divider}`}>
            {showTabs && (
              <div className="flex items-end gap-6">
                {KUGOU_PC_MUSIC_TABS.map(tab => {
                  const isActive = musicTab === tab.key
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setMusicTab(tab.key)}
                      className={`relative -mb-px pb-2 text-[15px] transition ${isActive ? 'font-semibold' : theme.tabIdle}`}
                      style={isActive ? { color: accent } : undefined}
                    >
                      {tab.label}
                      {isActive && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full" style={{ background: accent }} />}
                    </button>
                  )
                })}
              </div>
            )}
            {!showTabs && <span className={`pb-2 text-[15px] font-semibold ${theme.text}`}>{navKey === 'longaudio' ? '听书' : '酷狗音乐'}</span>}
            <label className={`ml-auto mb-1.5 flex h-8 w-56 items-center gap-1.5 rounded-full px-3 text-[12px] ${theme.surface}`}>
              <Search className={`h-3.5 w-3.5 ${theme.faint}`} />
              <input
                value={searchValue}
                onChange={event => setSearchValue(event.target.value)}
                onKeyDown={event => {
                  if (event.key !== 'Enter') return
                  const keyword = searchValue.trim()
                  if (keyword) onSearchSubmit?.(keyword)
                }}
                placeholder="搜索歌曲、歌手、歌单"
                aria-label="搜索歌曲、歌手、歌单"
                className={`min-w-0 flex-1 bg-transparent outline-none placeholder:opacity-70 ${theme.text}`}
              />
            </label>
          </div>

          <div className="flex min-h-0 flex-1">
            <div className="kugou-pc-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4">{content}</div>
          </div>
        </div>

      </div>

      {/* 听书独立播放器（portal，挂在 body；store 与本外壳共享） */}
      <KugouLongaudioOverlay />
    </div>
  )
}

export default memo(KugouPcShell)
