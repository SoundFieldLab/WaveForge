/**
 * 移动端歌手页：资料头（头像/名字）+ 热门歌曲列表（长按 → 动作面板）。
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { getArtistDetail, getArtistTopSongs, type Artist, type Song } from '../../services/musicApi'
import { useMobileNav, type MobileNavApi, type MobileArtistTarget } from '../nav'
import { triggerMobileBack } from '../mobileBack'
import { useMobilePlayer } from '../mobilePlayer'
import { useLongPress } from '../MobileActionSheet'
import { Cover, ErrorRetry, IconChevronLeft, IconPause, IconPlay, Spinner, songArtists, useLazyList } from '../ui'

export default memo(function MobileArtistPage({ target }: { target: MobileArtistTarget }) {
  const nav = useMobileNav()
  const player = useMobilePlayer()
  const [artist, setArtist] = useState<Artist | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    getArtistDetail(target.id, target.platform, target.name).then(a => {
      setArtist(a)
      return getArtistTopSongs(target.id, target.platform, target.name)
    }).then(list => {
      setSongs(list || [])
    }).catch(err => {
      setError(err instanceof Error ? err.message : '歌手信息加载失败')
    }).finally(() => setLoading(false))
  }, [target.id, target.platform, target.name])

  useEffect(() => { load() }, [load])
  const { visible, sentinelRef } = useLazyList(songs.length, 40)
  const label = `${target.name}的热门歌曲`

  return (
    <div className="wf-m-page">
      <header className="wf-m-pl-hero">
        <button type="button" className="wf-m-backbtn" aria-label="返回" onClick={() => triggerMobileBack()}>
          <IconChevronLeft size={20} />
        </button>
        <div className="wf-m-pl-hero-blur" style={artist?.picUrl ? { backgroundImage: `url(${artist?.picUrl})` } : undefined} />
        <div className="wf-m-pl-hero-mask" />
        <div className="wf-m-pl-hero-row">
          <Cover url={artist?.picUrl} size={360} rounded={999} className="wf-m-artist-avatar" />
          <div className="wf-m-pl-info">
            <h2 className="wf-m-pl-title">{artist?.name || target.name}</h2>
            <p className="wf-m-pl-sub">
              {artist?.alias?.length ? `${artist.alias.slice(0, 2).join(' / ')} · ` : ''}
              {songs.length ? `${songs.length} 首热门歌曲` : '歌手'}
            </p>
            {Boolean(artist?.briefDesc) && <p className="wf-m-pl-desc">{artist?.briefDesc}</p>}
          </div>
        </div>
        <div className="wf-m-pl-actions">
          <button
            type="button"
            className="wf-m-btn wf-m-btn-playall"
            disabled={!songs.length}
            onClick={() => player.playSongs(songs, 0, label)}
          >
            <IconPlay size={16} /> 播放热门 {songs.length ? `(${songs.length})` : ''}
          </button>
        </div>
      </header>

      {loading && <Spinner label="加载歌手信息…" />}
      {!loading && error && <ErrorRetry text={error} onRetry={load} />}
      {!loading && !error && !songs.length && <p className="wf-m-hint">暂无热门歌曲</p>}
      {!loading && !error && songs.length > 0 && (
        <>
          <ul className="wf-m-song-list">
            {songs.slice(0, visible).map((song, i) => (
              <ArtistSongRow
                key={`${song.platform || ''}-${song.id ?? song.mid}-${i}`}
                song={song}
                index={i}
                songs={songs}
                label={label}
                nav={nav}
              />
            ))}
          </ul>
          <div ref={sentinelRef} />
        </>
      )}
    </div>
  )
})

const ArtistSongRow = memo(function ArtistSongRow({
  song, index, songs, label, nav,
}: {
  song: Song
  index: number
  songs: Song[]
  label: string
  nav: MobileNavApi
}) {
  const player = useMobilePlayer()
  const isActive = player.currentSong?.id === song.id && player.currentSong?.platform === song.platform
  const longPress = useLongPress(() => nav.openSongActions({ song, list: songs, listLabel: label }))
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
          <span className="wf-m-song-name">{song.name}{song.vip && <span className="wf-m-badge-vip">VIP</span>}</span>
          <span className="wf-m-song-sub">{songArtists(song)}</span>
        </span>
        <span className="wf-m-song-playbtn">
          {isActive && player.isPlaying ? <IconPause size={15} /> : <span className="wf-m-song-index">{index + 1}</span>}
        </span>
      </button>
    </li>
  )
})
