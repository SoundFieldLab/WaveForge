// 传统模式「Apple Music 客户端」播放列表页（客户端侧栏：所有播放列表 / 喜爱歌曲）。
//
// 所有播放列表：资料库歌单封面网格（名称 + 曲目数），点击进歌单详情（沿用传统模式歌单页）。
// 喜爱歌曲：Apple 的「喜爱歌曲」= 账号收藏歌单，按客户端表格排版展示（★ 列全亮，取消喜爱即移除）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Song } from '../../services/musicApi'
import {
  ApplePcCardGrid,
  ApplePcColumnMenu,
  ApplePcEmpty,
  ApplePcFilterField,
  ApplePcIconButton,
  ApplePcNotice,
  ApplePcPillButton,
  ApplePcSongsTable,
  ApplePcSubscriptionNotice,
  ApplePcToolbar,
  APPLE_PC_PAD,
  applePcTheme,
  type ApplePcSongRow,
  type ApplePcTone,
} from './applePcKit'
import { Filter, SlidersHorizontal } from 'lucide-react'
import type { PcActions } from './types'
import { MotionSuspendContext } from '../../components/apple-explore/MotionArtwork'
import { openAppleSubscribeWindow } from '../../services/appleSubscribe'
import {
  appleSongToSong,
  getAppleFavoriteSongs,
  getAppleLibraryPlaylists,
  getLastAppleMeFailureMessage,
  type AppleLibraryPlaylist,
} from '../../services/appleCatalog'

export type ApplePcPlaylistsKind = 'playlists' | 'favorites'

export interface ApplePcPlaylistsProps {
  kind: ApplePcPlaylistsKind
  tone: ApplePcTone
  accent: string
  loggedIn: boolean
  actions: PcActions
  active: boolean
  currentSong: Song | null
  isPlaying: boolean
  onLoginClick?: () => void
  refreshSignal?: number
  /** 商店（动态封面按目录 id + storefront 拉取） */
  storefront: string
  /** 本面被播放页覆盖/隐藏保活：动态封面暂停取流并回收媒体 */
  suspended?: boolean
  /** 本地版本号：喜欢/取消喜欢后 +1，让「喜爱歌曲」重拉（收藏链路没有事件总线） */
  favoriteRevision?: number
}

export default function ApplePcPlaylists({
  kind, tone, accent, loggedIn, actions, active, currentSong, isPlaying,
  onLoginClick, refreshSignal = 0, favoriteRevision = 0, storefront, suspended = false,
}: ApplePcPlaylistsProps) {
  const theme = useMemo(() => applePcTheme(tone), [tone])
  const [playlists, setPlaylists] = useState<AppleLibraryPlaylist[]>([])
  const [favorites, setFavorites] = useState<ApplePcSongRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 空结果 + 服务层失败原因（多为订阅失效 40015 CloudLibrary 权限） */
  const [blockedReason, setBlockedReason] = useState('')
  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [columnMenu, setColumnMenu] = useState(false)
  const [showGenre, setShowGenre] = useState(true)
  const [showPlayCount, setShowPlayCount] = useState(true)
  const loadedRef = useRef('')
  const requestRef = useRef(0)

  const load = useCallback(() => {
    if (!loggedIn) return
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    setBlockedReason('')
    /** 空结果 + 服务层失败原因（订阅失效 40015）：渲染续订入口而不是空态 */
    const captureEmptyReason = (count: number) => {
      if (count > 0) return
      const reason = getLastAppleMeFailureMessage()
      if (request === requestRef.current && reason) setBlockedReason(reason)
    }
    const task = kind === 'playlists'
      ? getAppleLibraryPlaylists(200).then(list => {
        if (request !== requestRef.current) return
        setPlaylists(list)
        captureEmptyReason(list.length)
      })
      : getAppleFavoriteSongs(5000).then(list => {
        if (request !== requestRef.current) return
        setFavorites(list.map(song => ({
          song: appleSongToSong(song),
          catalogId: song.id,
        })))
        captureEmptyReason(list.length)
      })
    void task
      .catch(reason => { if (request === requestRef.current) setError(reason instanceof Error ? reason.message : '加载失败') })
      .finally(() => { if (request === requestRef.current) setLoading(false) })
  }, [kind, loggedIn])

  useEffect(() => {
    if (!active || !loggedIn) return
    const key = `${kind}:${refreshSignal}:${favoriteRevision}`
    if (loadedRef.current === key) return
    loadedRef.current = key
    load()
  }, [active, loggedIn, kind, load, refreshSignal, favoriteRevision])

  const lovedAll = useMemo(() => new Set(favorites.map(row => row.catalogId).filter((id): id is string => Boolean(id))), [favorites])

  const toggleLoved = useCallback((row: ApplePcSongRow, next: boolean) => {
    const id = row.catalogId
    if (!id) return
    // 「喜爱歌曲」里取消 ★ = 取消喜爱：乐观移除该行，失败由 App 级提示兜底
    if (!next) setFavorites(prev => prev.filter(item => item.catalogId !== id))
    // 收藏链路只走 App（apple 包 setAppleSongLoved）
    actions.onToggleLike?.(row.song, next)
  }, [actions])

  if (!loggedIn) {
    return (
      <div className="min-h-full" style={{ background: theme.content }}>
        <ApplePcEmpty
          theme={theme}
          title={kind === 'favorites' ? '登录 Apple Music 后可查看「喜爱歌曲」' : '登录 Apple Music 后可查看播放列表'}
          action={onLoginClick ? <ApplePcPillButton label="登录 Apple Music" onClick={onLoginClick} accent={accent} /> : undefined}
        />
      </div>
    )
  }

  if (kind === 'playlists') {
    const cards = playlists.map((playlist, index) => ({
      key: `${playlist.id}:${index}`,
      coverUrl: playlist.artworkUrl,
      title: playlist.name,
      subtitle: playlist.trackCount ? `${playlist.trackCount} 首` : '',
      // 动态封面：库内歌单要有目录 id 才能拉
      motion: playlist.catalogId ? { id: playlist.id, resourceId: playlist.catalogId, type: 'playlists' as const, name: playlist.name, storefront, artworkUrl: playlist.artworkUrl } : null,
      onClick: () => actions.onOpenPlaylist?.({
        id: playlist.id,
        name: playlist.name,
        coverImgUrl: playlist.artworkUrl,
        platform: 'apple',
        trackCount: playlist.trackCount,
        ownedByMe: playlist.ownedByMe,
        description: playlist.description,
      }),
      onContextMenu: (event: React.MouseEvent) => {
        event.preventDefault()
        actions.onPlaylistMenu?.({
          show: true, x: event.clientX, y: event.clientY,
          playlist: { id: playlist.id, name: playlist.name, coverImgUrl: playlist.artworkUrl, platform: 'apple', trackCount: playlist.trackCount, ownedByMe: playlist.ownedByMe },
        })
      },
    }))
    return (
      <MotionSuspendContext.Provider value={Boolean(suspended)}>
      <div className="min-h-full pb-10" style={{ background: theme.content, padding: `${APPLE_PC_PAD}px ${APPLE_PC_PAD}px 0` }}>
        <h1 className="mb-7 text-[34px] font-bold leading-tight" style={{ color: theme.text }}>所有播放列表</h1>
        {loading && !cards.length ? (
          <ApplePcNotice theme={theme} title="正在载入播放列表…" />
        ) : error && !cards.length ? (
          <ApplePcNotice theme={theme} title="播放列表加载失败" description={error} tone="warning" action={<ApplePcPillButton label="重试" onClick={load} accent={accent} />} />
        ) : cards.length === 0 && blockedReason ? (
          <ApplePcSubscriptionNotice theme={theme} accent={accent} detail={blockedReason} onRetry={load} onSubscribe={() => openAppleSubscribeWindow()} />
        ) : cards.length === 0 ? (
          <ApplePcEmpty theme={theme} title="资料库中暂无播放列表" description="在 Apple Music 客户端新建的播放列表会同步到这里" />
        ) : (
          <ApplePcCardGrid items={cards} theme={theme} columns={5} showPlayOnHover={false} />
        )}
      </div>
      </MotionSuspendContext.Provider>
    )
  }

  const hasGenre = favorites.some(row => row.genre)
  const hasPlayCount = favorites.some(row => row.playCount)

  return (
    <MotionSuspendContext.Provider value={Boolean(suspended)}>
    <div className="flex h-full min-h-0 flex-col" style={{ background: theme.content }}>
      <ApplePcSongsTable
        rows={favorites}
        theme={theme}
        lovedIds={lovedAll}
        onToggleLoved={toggleLoved}
        onPlay={(row, index) => {
          const queue = favorites.map(item => item.song)
          actions.onPlaySongs?.(row.song, queue, index)
        }}
        onMenu={(event, song) => actions.onSongMenu?.({ show: true, x: event.clientX, y: event.clientY, song })}
        playingKey={currentSong?.appleId || ''}
        isPlaying={isPlaying}
        loading={loading && !favorites.length}
        showGenre={showGenre && hasGenre}
        showPlayCount={showPlayCount && hasPlayCount}
        filter={filter}
        empty={error
          ? <ApplePcNotice theme={theme} title="喜爱歌曲加载失败" description={error} tone="warning" action={<ApplePcPillButton label="重试" onClick={load} accent={accent} />} />
          : blockedReason
            ? <ApplePcSubscriptionNotice theme={theme} accent={accent} detail={blockedReason} onRetry={load} onSubscribe={() => openAppleSubscribeWindow()} />
            : <ApplePcEmpty theme={theme} title="还没有喜爱的歌曲" description="在客户端给歌曲点亮 ★ 后会出现在这里" />}
        toolbar={(
          <ApplePcToolbar
            title="喜爱歌曲"
            theme={theme}
            actions={
              <>
                {filterOpen && <ApplePcFilterField value={filter} onChange={setFilter} theme={theme} placeholder="过滤" />}
                <ApplePcIconButton title="过滤" theme={theme} active={filterOpen} onClick={() => { setFilterOpen(value => !value); if (filterOpen) setFilter('') }}>
                  <Filter className="h-3.5 w-3.5" />
                </ApplePcIconButton>
                <div className="relative">
                  <ApplePcIconButton title="显示选项" theme={theme} active={columnMenu} onClick={() => setColumnMenu(value => !value)}>
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                  </ApplePcIconButton>
                  {columnMenu && (
                    <ApplePcColumnMenu
                      theme={theme}
                      showGenre={showGenre && hasGenre}
                      showPlayCount={showPlayCount && hasPlayCount}
                      onToggleGenre={setShowGenre}
                      onTogglePlayCount={setShowPlayCount}
                      onClose={() => setColumnMenu(false)}
                    />
                  )}
                </div>
              </>
            }
          />
        )}
      />
    </div>
    </MotionSuspendContext.Provider>
  )
}
