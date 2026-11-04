/**
 * 移动端歌单/专辑详情页：官方手机版头部（大图模糊铺底 + 封面横排 + 播放全部）+ 曲目列表。
 * 两种模式：playlist（fetchExplorePlaylist）/ album（getAlbumDetail + getAlbumSongs）。
 * 行支持长按 → 底部动作面板（触屏右键菜单）。
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { fetchExplorePlaylist, type ExploreDetail, type ExplorePlaylist } from '../../services/exploreApi'
import { getAlbumDetail, getAlbumSongs, type Album, type Song } from '../../services/musicApi'
import type { MobileAlbumTarget } from '../nav'
import { useMobileNav } from '../nav'
import { triggerMobileBack } from '../mobileBack'
import { useMobilePlayer } from '../mobilePlayer'
import { useLongPress } from '../MobileActionSheet'
import { subscribePlaylist, removeSongFromPlaylist } from '../../services/playlistService'
import { useAccounts } from '../mobileLogin'
import { mobileToast, IconClose, IconShuffle } from '../ui'
import {
  Cover, ErrorRetry, IconChevronLeft, IconHeart, IconHeartFilled, IconPlay, IconPause, Spinner, songArtists, useLazyList,
} from '../ui'

export default memo(function MobilePlaylistDetail({ playlist, album }: {
  playlist?: ExplorePlaylist
  album?: MobileAlbumTarget
}) {
  const nav = useMobileNav()
  const player = useMobilePlayer()
  const [detail, setDetail] = useState<ExploreDetail | null>(null)
  const [albumDetail, setAlbumDetail] = useState<Album | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    if (album) {
      getAlbumDetail(album.id, album.platform)
        .then(a => getAlbumSongs(album.id, album.platform).then(songs => ({ a, songs })))
        .then(({ a, songs }) => {
          setAlbumDetail(a)
          setDetail({
            playlist: {
              id: album.id,
              name: a?.name || album.name,
              coverImgUrl: a?.picUrl || album.coverUrl || '',
              trackCount: songs?.length || 0,
              platform: album.platform,
            },
            songs: songs || [],
          } as ExploreDetail)
        })
        .catch(err => setError(err instanceof Error ? err.message : '专辑加载失败'))
        .finally(() => setLoading(false))
      return
    }
    if (!playlist) return
    fetchExplorePlaylist(playlist)
      .then(setDetail)
      .catch(err => setError(err instanceof Error ? err.message : '歌单加载失败'))
      .finally(() => setLoading(false))
  }, [playlist, album])

  useEffect(() => { load() }, [load])

  const songs: Song[] = detail?.songs || []
  const { visible, sentinelRef } = useLazyList(songs.length, 50)
  // 歌单内搜索：歌名/歌手/专辑模糊匹配（原顺序播放仍按全列表索引）
  const [filterText, setFilterText] = useState('')
  const filteredSongs = filterText.trim()
    ? songs.map((song, index) => ({ song, index })).filter(({ song }) => {
        const kw = filterText.trim().toLowerCase()
        return song.name?.toLowerCase().includes(kw)
          || songArtists(song).toLowerCase().includes(kw)
          || (song.album?.name || '').toLowerCase().includes(kw)
      })
    : songs.map((song, index) => ({ song, index }))
  // 搜索态下重置懒加载窗口（搜索结果通常远小于全量）
  const displaySongs = filterText.trim() ? filteredSongs : filteredSongs.slice(0, visible)
  const title = detail?.playlist.name || album?.name || playlist?.name || ''
  const cover = detail?.playlist.coverImgUrl || album?.coverUrl || playlist?.coverUrl
  const activeKey = (song: { id?: number; mid?: string; platform?: string }) => `${song.platform || ''}:${song.mid || song.id}`
  // 收藏/取消收藏（仅歌单模式；登录态从 useAccounts 取）
  const { accounts } = useAccounts()
  const account = accounts[nav.platform]
  const [subscribed, setSubscribed] = useState<boolean | null>(null)
  useEffect(() => {
    // ExplorePlaylist 未透传 subscribed 状态：仅在有登录态时展示收藏按钮，初始视为未收藏
    setSubscribed(account?.loggedIn && !album ? false : null)
  }, [account?.loggedIn, album])
  const [subBusy, setSubBusy] = useState(false)
  const toggleSubscribe = useCallback(async () => {
    if (!playlist || subBusy || !account?.userId) return
    setSubBusy(true)
    try {
      await subscribePlaylist(String(playlist.id), !subscribed, nav.platform)
      setSubscribed(prev => !prev)
      mobileToast(subscribed ? '已取消收藏' : '已收藏歌单', 'success')
    } catch (err) {
      mobileToast(err instanceof Error ? err.message : '收藏失败', 'error')
    } finally {
      setSubBusy(false)
    }
  }, [playlist, subBusy, account?.userId, subscribed, nav.platform])
  // 从歌单移除（本人歌单内的歌曲行，长按菜单扩展项）——详情页内 songs 全量重载太重，
  // 直接本地移除该行并广播 playlist-content-changed。
  const [removedKeys, setRemovedKeys] = useState<Set<string>>(new Set())
  const removeSong = useCallback(async (song: Song) => {
    if (!playlist || !account?.userId) return
    try {
      await removeSongFromPlaylist(
        String(playlist.id),
        String(song.platform === 'qq' ? (song.mid || song.id) : song.id),
        account.userId,
        nav.platform,
        { songMid: song.mid },
      )
      const key = activeKey(song)
      setRemovedKeys(prev => new Set(prev).add(key))
      window.dispatchEvent(new CustomEvent('playlist-content-changed', {
        detail: { platform: nav.platform, type: 'remove', songId: song.id, songMid: song.mid, playlistId: playlist.id },
      }))
      mobileToast('已从歌单移除', 'success')
    } catch (err) {
      mobileToast(err instanceof Error ? err.message : '移除失败（可能不是本人歌单）', 'error')
    }
  }, [playlist, account?.userId, nav.platform])

  return (
    <div className="wf-m-page wf-m-pl-page">
      {/* 官方手机版歌单头：封面模糊铺底 + 大封面横排信息 + 操作排 */}
      <header className="wf-m-pl-hero">
        <button type="button" className="wf-m-backbtn" aria-label="返回" onClick={() => triggerMobileBack()}>
          <IconChevronLeft size={20} />
        </button>
        <div className="wf-m-pl-hero-blur" style={cover ? { backgroundImage: `url(${cover})` } : undefined} />
        <div className="wf-m-pl-hero-mask" />
        <div className="wf-m-pl-hero-row">
          <Cover url={cover} size={420} rounded={14} className="wf-m-pl-hero-cover" />
          <div className="wf-m-pl-info">
            <h2 className="wf-m-pl-title">{title}</h2>
            <p className="wf-m-pl-sub">
            {album
              ? `${albumDetail?.artist?.name || ''}${songs.length ? ` · ${songs.length}首` : ''}`
              : `${detail?.playlist.creator?.nickname || playlist?.creator || '歌单'}${detail?.playlist.trackCount ? ` · ${detail.playlist.trackCount}首` : ''}`}
            </p>
            {!album && Boolean(detail?.playlist.description) && (
              <p className="wf-m-pl-desc">{detail?.playlist.description}</p>
            )}
            {album && albumDetail?.publishTime ? (
              <p className="wf-m-pl-desc">发行于 {new Date(albumDetail.publishTime).toLocaleDateString('zh-CN')}</p>
            ) : null}
          </div>
        </div>
        <div className="wf-m-pl-actions">
          <button
            type="button"
            className="wf-m-btn wf-m-btn-playall"
            disabled={!songs.length}
            onClick={() => player.playSongs(songs, 0, title)}
          >
            {player.isPlaying && player.contextLabel === title
              ? <IconPause size={16} />
              : <IconPlay size={16} />}
            播放全部{songs.length ? ` (${songs.length})` : ''}
          </button>
          {/* 随机播放：从全列表随机起点开播（顺序模式下游走随机） */}
          <button
            type="button"
            className="wf-m-btn wf-m-btn-sub"
            disabled={!songs.length}
            aria-label="随机播放"
            title="随机播放"
            onClick={() => {
              if (!songs.length) return
              const start = Math.floor(Math.random() * songs.length)
              player.playSongs(songs, start, title)
              mobileToast(`随机从第 ${start + 1} 首开始播放`)
            }}
          >
            <IconShuffle size={16} />
          </button>
          {subscribed !== null && (
            <button
              type="button"
              className={`wf-m-btn wf-m-btn-sub ${subscribed ? 'is-on' : ''}`}
              disabled={subBusy}
              aria-label={subscribed ? '取消收藏' : '收藏歌单'}
              onClick={() => void toggleSubscribe()}
            >
              {subscribed ? <IconHeartFilled size={16} /> : <IconHeart size={16} />}
              {subscribed ? '已收藏' : '收藏'}
            </button>
          )}
        </div>
        {/* 歌单内搜索（大歌单翻不动的痛点；≥8 首才显示入口） */}
        {songs.length >= 8 && (
          <div className="wf-m-pl-searchbar">
            <input
              type="search"
              className="wf-m-pl-search"
              placeholder={`在 ${title.length > 10 ? '本歌单' : `「${title}」`}内搜索…`}
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
            />
            {filterText && (
              <button type="button" className="wf-m-pl-search-clear" aria-label="清除" onClick={() => setFilterText('')}>
                <IconClose size={14} />
              </button>
            )}
          </div>
        )}
      </header>

      {loading && <Spinner label="加载内容…" />}
      {!loading && error && <ErrorRetry text={error} onRetry={load} />}
      {!loading && !error && !songs.length && <p className="wf-m-hint">内容为空或暂无版权</p>}

      {!loading && !error && songs.length > 0 && (
        <>
          {filterText && (
            <p className="wf-m-hint">匹配 {filteredSongs.length} / {songs.length} 首</p>
          )}
          <ul className="wf-m-song-list">
            {displaySongs.slice(0, visible).map(({ song, index }) => (
              removedKeys.has(activeKey(song)) ? null : (
                <DetailSongRow
                  key={`${song.platform || ''}-${song.id ?? song.mid}-${index}`}
                  song={song}
                  index={index}
                  songs={songs}
                  label={title}
                  nav={nav}
                  playlistId={playlist && !album ? String(playlist.id) : undefined}
                  onRemoveFromPlaylist={playlist && !album && account?.userId ? () => void removeSong(song) : undefined}
                />
              )
            ))}
          </ul>
          <div ref={sentinelRef} />
        </>
      )}
    </div>
  )
})

const DetailSongRow = memo(function DetailSongRow({
  song, index, songs, label, nav, playlistId, onRemoveFromPlaylist,
}: {
  song: Song
  index: number
  songs: Song[]
  label: string
  nav: ReturnType<typeof useMobileNav>
  /** 所在歌单 id（提供时打开扩展动作：从歌单移除） */
  playlistId?: string
  onRemoveFromPlaylist?: () => void
}) {
  const player = useMobilePlayer()
  const isActive = player.currentSong && `${player.currentSong.platform || ''}:${player.currentSong.mid || player.currentSong.id}` === `${song.platform || ''}:${song.mid || song.id}`
  // 长按 → 动作面板；歌单模式扩展「从歌单移除」：先开面板，再由面板 toast 确认执行
  const longPress = useLongPress(() => {
    nav.openSongActions({ song, list: songs, listLabel: label })
    if (onRemoveFromPlaylist && playlistId) {
      // 动作面板关闭后延迟弹出确认（避免面板和 confirm 同帧争抢）
      window.setTimeout(() => {
        if (window.confirm(`把「${song.name}」从歌单移除？`)) onRemoveFromPlaylist()
      }, 120)
    }
  })
  return (
    <li>
      <button
        type="button"
        className={`wf-m-song-mini ${isActive ? 'is-active' : ''}`}
        onClick={() => player.playSongs(songs, index, label)}
        {...longPress}
      >
        <Cover song={song} size={72} rounded={8} />
        <span className="wf-m-song-meta">
          <span className="wf-m-song-name">
            {song.name}
            {song.vip && <span className="wf-m-badge-vip">VIP</span>}
          </span>
          <span className="wf-m-song-sub">{songArtists(song)}</span>
        </span>
        <span className="wf-m-song-playbtn">
          {isActive && player.isPlaying ? <IconPause size={15} /> : <span className="wf-m-song-index">{index + 1}</span>}
        </span>
      </button>
    </li>
  )
})
