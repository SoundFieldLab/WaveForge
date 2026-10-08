// 传统模式「Apple Music 客户端」资料库页（客户端侧栏：最近添加 / 艺人 / 专辑 / 歌曲）。
//
// 版式依据客户端截图（资料库-歌曲）：内容区工具条（居中小标题 + 右侧「过滤 / 显示选项」）
// + 歌曲表格（标题 / 时长 / 艺人 / 专辑 / 类型 / ★ / 播放次数），行高 40、隔行浅底、
// 行悬停出现「⋯」（接全局歌曲右键菜单）、双击播放、表头点击排序。
// 类型 / 播放次数 / 添加日期三列来自 /me/library/songs 的资源字段，
// 资源没带时该列整体隐藏（不显示空列、不编数据）。
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
  ApplePcTitle,
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
  appleLibraryTrackToSong,
  getAppleLibraryAlbums,
  getAppleLibraryArtists,
  getAppleLibrarySongs,
  getAppleLovedSongIds,
  getLastAppleMeFailureMessage,
  type AppleLibraryAlbum,
  type AppleLibraryArtist,
  type AppleLibraryTrack,
} from '../../services/appleCatalog'

export type ApplePcLibraryKind = 'added' | 'artists' | 'albums' | 'songs'

export interface ApplePcLibraryProps {
  kind: ApplePcLibraryKind
  tone: ApplePcTone
  accent: string
  loggedIn: boolean
  actions: PcActions
  active: boolean
  currentSong: Song | null
  isPlaying: boolean
  onLoginClick?: () => void
  /** 资料库刷新信号（侧栏「更多 → 重新载入资料库」） */
  refreshSignal?: number
  /** 商店（动态封面按目录 id + storefront 拉取） */
  storefront: string
  /** 本面被播放页覆盖/隐藏保活：动态封面暂停取流并回收媒体 */
  suspended?: boolean
}

const PAGE_TITLE: Record<ApplePcLibraryKind, string> = {
  added: '最近添加',
  artists: '艺人',
  albums: '专辑',
  songs: '歌曲',
}

function toRow(track: AppleLibraryTrack): ApplePcSongRow {
  return {
    song: appleLibraryTrackToSong(track),
    libraryId: track.id,
    catalogId: track.catalogId,
    genre: track.genreName,
    playCount: track.playCount,
    dateAdded: track.dateAdded,
  }
}

export default function ApplePcLibrary({ kind, tone, accent, loggedIn, actions, active, currentSong, isPlaying, onLoginClick, refreshSignal = 0, storefront, suspended = false }: ApplePcLibraryProps) {
  const theme = useMemo(() => applePcTheme(tone), [tone])
  const [tracks, setTracks] = useState<AppleLibraryTrack[]>([])
  const [albums, setAlbums] = useState<AppleLibraryAlbum[]>([])
  const [artists, setArtists] = useState<AppleLibraryArtist[]>([])
  const [lovedIds, setLovedIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  /** 空结果 + 服务层失败原因：多为「订阅失效（40015 CloudLibrary 权限）」——这时不能显示成「空空如也」 */
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
    /** 空列表时把服务层的失败原因留档（订阅失效 40015 / 登录失效），页面据此渲染续订入口 */
    const captureEmptyReason = (count: number) => {
      if (count > 0) return
      const reason = getLastAppleMeFailureMessage()
      if (request === requestRef.current && reason) setBlockedReason(reason)
    }
    const task = kind === 'albums'
      ? getAppleLibraryAlbums(500).then(list => {
        if (request !== requestRef.current) return
        setAlbums(list)
        captureEmptyReason(list.length)
      })
      : kind === 'artists'
        ? getAppleLibraryArtists(500).then(list => {
          if (request !== requestRef.current) return
          setArtists(list)
          captureEmptyReason(list.length)
        })
        : getAppleLibrarySongs(5000).then(list => {
          if (request !== requestRef.current) return
          setTracks(list)
          captureEmptyReason(list.length)
          // ★ 状态：与资料库歌曲同批（catalogId）查一次「喜爱」，缺目录 id 的行无法判定就不显示
          const catalogIds = list.map(track => track.catalogId).filter((id): id is string => Boolean(id))
          if (!catalogIds.length) return
          void getAppleLovedSongIds(catalogIds)
            .then(ids => { if (request === requestRef.current) setLovedIds(new Set(ids)) })
            .catch(() => undefined)
        })
    void task
      .catch(reason => { if (request === requestRef.current) setError(reason instanceof Error ? reason.message : '资料库加载失败') })
      .finally(() => { if (request === requestRef.current) setLoading(false) })
  }, [kind, loggedIn])

  useEffect(() => {
    if (!active || !loggedIn) return
    const key = `${kind}:${refreshSignal}`
    if (loadedRef.current === key) return
    loadedRef.current = key
    load()
  }, [active, loggedIn, kind, load, refreshSignal])

  const rows = useMemo(() => tracks.map(toRow), [tracks])
  const hasGenre = rows.some(row => row.genre)
  const hasPlayCount = rows.some(row => row.playCount)
  const hasAdded = rows.some(row => row.dateAdded)

  const toggleLoved = useCallback((row: ApplePcSongRow, next: boolean) => {
    const id = row.catalogId
    if (!id) return
    setLovedIds(prev => {
      const copy = new Set(prev)
      if (next) copy.add(id); else copy.delete(id)
      return copy
    })
    // 收藏链路只走 App（apple 包 setAppleSongLoved + 全局提示）；这里只做乐观 UI
    actions.onToggleLike?.(row.song, next)
  }, [actions])

  if (!loggedIn) {
    return (
      <div className="min-h-full" style={{ background: theme.content }}>
        <ApplePcEmpty
          theme={theme}
          title={`登录 Apple Music 后可查看「${PAGE_TITLE[kind]}」`}
          action={onLoginClick ? <ApplePcPillButton label="登录 Apple Music" onClick={onLoginClick} accent={accent} /> : undefined}
        />
      </div>
    )
  }

  const renderTable = (initialSort?: { key: 'added'; dir: 'desc' }) => (
    <ApplePcSongsTable
      rows={rows}
      theme={theme}
      lovedIds={lovedIds}
      onToggleLoved={toggleLoved}
      onPlay={(row, index) => {
        const queue = rows.map(item => item.song)
        actions.onPlaySongs?.(row.song, queue, index)
      }}
      onMenu={(event, song) => actions.onSongMenu?.({ show: true, x: event.clientX, y: event.clientY, song })}
      playingKey={currentSong?.appleId || ''}
      isPlaying={isPlaying}
      loading={loading && !rows.length}
      showGenre={showGenre && hasGenre}
      showPlayCount={showPlayCount && hasPlayCount}
      showAdded={kind === 'added' && hasAdded}
      initialSort={initialSort}
      filter={filter}
      empty={error
        ? <ApplePcNotice theme={theme} title="资料库加载失败" description={error} tone="warning" action={<ApplePcPillButton label="重试" onClick={load} accent={accent} />} />
        : blockedReason
          ? <ApplePcSubscriptionNotice theme={theme} accent={accent} detail={blockedReason} onRetry={load} onSubscribe={() => openAppleSubscribeWindow()} />
          : <ApplePcEmpty theme={theme} title="没有找到歌曲" description="资料库为空，或 Apple Music 尚未同步" />}
      toolbar={(
        <ApplePcToolbar
          title={PAGE_TITLE[kind]}
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
  )

  if (kind === 'songs' || kind === 'added') {
    return (
      <MotionSuspendContext.Provider value={Boolean(suspended)}>
        <div className="flex h-full min-h-0 flex-col" style={{ background: theme.content }}>
          {renderTable(kind === 'added' ? { key: 'added', dir: 'desc' } : undefined)}
        </div>
      </MotionSuspendContext.Provider>
    )
  }

  const cards = kind === 'albums'
    ? albums.map((album, index) => ({
      key: `${album.id}:${index}`,
      coverUrl: album.artworkUrl,
      title: album.name,
      subtitle: album.artistName,
      // 动态封面：库内专辑要有目录 id 才能拉（l. 前缀的库 id 拉不到，不请求）
      motion: album.catalogId ? { id: album.id, resourceId: album.catalogId, type: 'albums' as const, name: album.name, storefront, artworkUrl: album.artworkUrl } : null,
      onClick: () => actions.onOpenAlbum?.(album.catalogId || album.id, 'apple'),
    }))
    : artists.map((artist, index) => ({
      key: `${artist.id}:${index}`,
      coverUrl: artist.artworkUrl,
      title: artist.name,
      subtitle: artist.genreName || '',
      round: true,
      onClick: () => actions.onOpenArtist?.(artist.catalogId || artist.id, 'apple'),
    }))

  return (
    <MotionSuspendContext.Provider value={Boolean(suspended)}>
    <div className="min-h-full pb-10" style={{ background: theme.content, padding: `${APPLE_PC_PAD}px ${APPLE_PC_PAD}px 0` }}>
      <ApplePcTitle theme={theme} className="mb-7">{PAGE_TITLE[kind]}</ApplePcTitle>
      {loading && !cards.length ? (
        <ApplePcNotice theme={theme} title="正在载入资料库…" />
      ) : error && !cards.length ? (
        <ApplePcNotice theme={theme} title="资料库加载失败" description={error} tone="warning" action={<ApplePcPillButton label="重试" onClick={load} accent={accent} />} />
      ) : cards.length === 0 && blockedReason ? (
        <ApplePcSubscriptionNotice theme={theme} accent={accent} detail={blockedReason} onRetry={load} onSubscribe={() => openAppleSubscribeWindow()} />
      ) : cards.length === 0 ? (
        <ApplePcEmpty theme={theme} title={`资料库中暂无${PAGE_TITLE[kind]}`} />
      ) : (
        <ApplePcCardGrid items={cards} theme={theme} columns={5} />
      )}
    </div>
    </MotionSuspendContext.Provider>
  )
}
