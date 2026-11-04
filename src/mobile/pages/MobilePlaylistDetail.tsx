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
import { mobileToast } from '../ui'
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
      </header>

      {loading && <Spinner label="加载内容…" />}
      {!loading && error && <ErrorRetry text={error} onRetry={load} />}
      {!loading && !error && !songs.length && <p className="wf-m-hint">内容为空或暂无版权</p>}

      {!loading && !error && songs.length > 0 && (
        <>
          <ul className="wf-m-song-list">
            {songs.slice(0, visible).map((song, i) => (
              removedKeys.has(activeKey(song)) ? null : (
                <DetailSongRow
                  key={`${song.platform || ''}-${song.id ?? song.mid}-${i}`}
                  song={song}
                  index={i}
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
