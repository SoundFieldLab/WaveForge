/**
 * 移动端「发现」页 —— 对齐官方手机客户端（网易云/QQ 手机版）的结构与质感：
 * 问候头部 + 榜单横滑大卡 + 3:4 双列歌单 + 榜单/新歌货架，全骨架屏加载态。
 * 数据层与桌面探索/TV 同源（fetchExploreHome）。
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { fetchExploreHome, type ExplorePayload, type ExploreChart, type ExplorePlaylist, type ExploreAlbum } from '../../services/exploreApi'
import type { Song } from '../../services/musicApi'
import { getVisiblePlatforms, platformLabel, type MusicPlatform } from '../../services/platforms'
import { isMobilePlayablePlatform, useMobilePlayer } from '../mobilePlayer'
import { useMobileNav } from '../nav'
import {
  Cover, EmptyState, ErrorRetry, IconPlay, IconPause, IconPlayCircle, IconSearch,
  PLATFORM_ACCENT, PlayCountBadge, SectionHeader, SkeletonGrid, SkeletonRows,
  songArtists, useLazyList, mobileToast,
} from '../ui'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 12) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

export default memo(function MobileHome() {
  const nav = useMobileNav()
  const player = useMobilePlayer()
  const [payload, setPayload] = useState<ExplorePayload | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const platform = nav.platform

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    fetchExploreHome(platform).then(data => {
      setPayload(data)
    }).catch(err => {
      setError(err instanceof Error ? err.message : '加载失败')
    }).finally(() => setLoading(false))
  }, [platform])

  useEffect(() => { load() }, [load])

  const playSongs = useCallback((songs: Song[], label: string, startIndex = 0) => {
    player.playSongs(songs, startIndex, label)
  }, [player])

  const charts = payload?.charts || []
  const playlists = (payload?.playlists || []).slice(0, 12)
  const albums = (payload?.albums || []).slice(0, 12)
  const dailySongs = payload?.dailySongs || []
  const newSongs = payload?.newSongs || []
  const radioSongs = payload?.radioSongs || []

  return (
    <div className="wf-m-page">
      <header className="wf-m-hero">
        <div className="wf-m-hero-top">
          <div className="wf-m-hero-text">
            <p className="wf-m-hero-greet">{greeting()}</p>
            <h1 className="wf-m-hero-title">发现</h1>
          </div>
          <button type="button" className="wf-m-hero-search" aria-label="搜索" onClick={() => nav.switchTab('search')}>
            <IconSearch size={19} />
          </button>
        </div>
        <div className="wf-m-chipbar">
          {getVisiblePlatforms().map(p => (
            <button
              key={p}
              type="button"
              className={`wf-m-chip ${p === platform ? 'is-on' : ''}`}
              style={p === platform
                ? { background: PLATFORM_ACCENT[p], borderColor: PLATFORM_ACCENT[p], color: '#fff' }
                : undefined}
              onClick={() => nav.setPlatform(p)}
            >
              {platformLabel(p)}
              {!isMobilePlayablePlatform(p) && <span className="wf-m-chip-note">浏览</span>}
            </button>
          ))}
        </div>
      </header>

      {loading && (
        <>
          <SkeletonRows count={2} />
          <SkeletonGrid count={4} />
        </>
      )}
      {!loading && error && <ErrorRetry text={error} onRetry={load} />}

      {!loading && !error && (
        <>
          {/* 榜单横滑大卡（官方「排行榜」入口位） */}
          {charts.length > 0 && (
            <section className="wf-m-section">
              <SectionHeader title="排行榜" />
              <div className="wf-m-hscroll wf-m-chart-scroll">
                {charts.slice(0, 8).map(chart => (
                  <ChartBannerCard key={chart.id} chart={chart} />
                ))}
              </div>
            </section>
          )}

          {/* 精选歌单：3:4 双列大卡（官方推荐歌单样式） */}
          {playlists.length > 0 && (
            <section className="wf-m-section">
              <SectionHeader title="精选歌单" />
              <div className="wf-m-grid-playlists">
                {playlists.map(pl => (
                  <PlaylistCard key={`${pl.platform}-${pl.id}`} playlist={pl} />
                ))}
              </div>
            </section>
          )}

          {/* 新碟上架：横滑专辑卡（官方「新碟首发」位），点进专辑详情 */}
          {albums.length > 0 && (
            <section className="wf-m-section">
              <SectionHeader title="新碟上架" />
              <div className="wf-m-hscroll">
                {albums.map(al => (
                  <AlbumTile key={`${al.platform}-${al.id ?? al.mid}`} album={al} />
                ))}
              </div>
            </section>
          )}

          {/* 每日推荐 / 新歌速递：横滑封面小卡（官方新歌速递样式） */}
          {dailySongs.length > 0 && (
            <section className="wf-m-section">
              <SectionHeader title="每日推荐" onMore={() => playSongs(dailySongs, '每日推荐', 0)} />
              <div className="wf-m-hscroll">
                {dailySongs.slice(0, 12).map((song, i) => (
                  <SongTile key={`${song.id ?? song.mid}-${i}`} song={song} onPlay={() => playSongs(dailySongs, '每日推荐', i)} />
                ))}
              </div>
            </section>
          )}

          {newSongs.length > 0 && (
            <section className="wf-m-section">
              <SectionHeader title="新歌速递" />
              <div className="wf-m-hscroll">
                {newSongs.slice(0, 12).map((song, i) => (
                  <SongTile key={`${song.id ?? song.mid}-${i}`} song={song} onPlay={() => playSongs(newSongs, '新歌速递', i)} />
                ))}
              </div>
            </section>
          )}

          {/* 猜你喜欢：紧凑行列表 */}
          {radioSongs.length > 0 && (
            <section className="wf-m-section">
              <SectionHeader title="猜你喜欢" />
              <SongRows songs={radioSongs} label="猜你喜欢" onPlay={playSongs} activeSong={player.currentSong} />
            </section>
          )}

          {!hasAnyContent(payload) && (
            <EmptyState text="暂无推荐内容，试试切换平台或登录账号" />
          )}
        </>
      )}
    </div>
  )
})

function hasAnyContent(payload: ExplorePayload | null): boolean {
  return Boolean(
    payload && (payload.playlists?.length || payload.charts?.length || payload.dailySongs?.length
      || payload.newSongs?.length || payload.radioSongs?.length || payload.albums?.length),
  )
}

/** 榜单大卡：封面做底 + 渐变遮罩 + 前三名预览（官方排行榜入口卡）。 */
const ChartBannerCard = memo(function ChartBannerCard({ chart }: { chart: ExploreChart }) {
  const player = useMobilePlayer()
  const nav = useMobileNav()
  const [imgOk, setImgOk] = useState(true)
  return (
    <button
      type="button"
      className="wf-m-chart-banner"
      style={imgOk && chart.coverUrl ? { backgroundImage: `url(${chart.coverUrl})` } : undefined}
      onClick={() => {
        if (chart.songs?.length) {
          player.playSongs(chart.songs.map(s => ({
            id: s.id ?? 0, mid: s.mid, appleId: s.appleId, name: s.name,
            artists: s.artist ? [{ name: s.artist }] : [],
            album: { name: '', picUrl: s.coverUrl || '' },
            duration: (s.duration || 0) * 1000, platform: chart.platform,
          })), 0, chart.name)
        } else {
          nav.openPlaylist({ id: chart.id, name: chart.name, coverUrl: chart.coverUrl, platform: chart.platform })
        }
      }}
    >
      <span className="wf-m-chart-banner-mask" />
      <span className="wf-m-chart-banner-body">
        <span className="wf-m-chart-banner-name">{chart.name}</span>
        <span className="wf-m-chart-banner-songs">
          {(chart.songs || []).slice(0, 3).map((s, i) => (
            <i key={i}>{i + 1}. {s.name}<em> · {s.artist}</em></i>
          ))}
        </span>
        <span className="wf-m-chart-banner-play"><IconPlayCircle size={30} /></span>
      </span>
      <img src={chart.coverUrl} alt="" className="wf-m-chart-banner-img" onError={() => setImgOk(false)} />
    </button>
  )
})

/** 歌单大卡：3:4 封面 + 播放量角标 + 两行标题（官方推荐歌单卡）。 */
const PlaylistCard = memo(function PlaylistCard({ playlist }: { playlist: ExplorePlaylist }) {
  const nav = useMobileNav()
  return (
    <button type="button" className="wf-m-pl-card" onClick={() => nav.openPlaylist(playlist)}>
      <span className="wf-m-pl-coverwrap">
        <Cover url={playlist.coverUrl} size={360} rounded={12} className="wf-m-pl-cover" />
        <PlayCountBadge count={playlist.playCount} />
      </span>
      <span className="wf-m-pl-name">{playlist.name}</span>
    </button>
  )
})

/** 新碟横滑小卡：方封面 + 专辑名 + 歌手（点进专辑详情页）。 */
const AlbumTile = memo(function AlbumTile({ album }: { album: ExploreAlbum }) {
  const nav = useMobileNav()
  const target = String(album.id ?? album.mid ?? '')
  return (
    <button
      type="button"
      className="wf-m-song-tile"
      onClick={() => {
        if (!target || target === '0') { mobileToast('该专辑暂无详情') ; return }
        nav.openAlbum({ id: target, name: album.name, coverUrl: album.coverUrl, platform: album.platform as MusicPlatform })
      }}
    >
      <Cover url={album.coverUrl} size={200} rounded={10} className="wf-m-song-tile-cover" />
      <span className="wf-m-song-tile-name">{album.name}</span>
      <span className="wf-m-song-tile-artist">{album.artist || ''}</span>
    </button>
  )
})

/** 新歌横滑小卡：方封面 + 歌名 + 歌手（官方新歌速递卡）。 */
const SongTile = memo(function SongTile({ song, onPlay }: { song: Song; onPlay: () => void }) {
  return (
    <button type="button" className="wf-m-song-tile" onClick={onPlay}>
      <Cover song={song} size={200} rounded={10} className="wf-m-song-tile-cover" />
      <span className="wf-m-song-tile-name">{song.name}</span>
      <span className="wf-m-song-tile-artist">{songArtists(song)}</span>
    </button>
  )
})

/** 紧凑歌曲行（猜你喜欢）。 */
const SongRows = memo(function SongRows({
  songs, label, onPlay, activeSong,
}: {
  songs: Song[]
  label: string
  onPlay: (songs: Song[], label: string, startIndex?: number) => void
  activeSong: Song | null
}) {
  const nav = useMobileNav()
  const { visible, sentinelRef } = useLazyList(songs.length, 30)
  return (
    <>
      <ul className="wf-m-song-list">
        {songs.slice(0, Math.min(visible, 30)).map((song, i) => (
          <li key={`${song.platform || ''}-${song.id ?? song.mid}-${i}`}>
            <button
              type="button"
              className={`wf-m-song-mini ${activeSong?.id === song.id && activeSong?.platform === song.platform ? 'is-active' : ''}`}
              onClick={() => onPlay(songs, label, i)}
              onContextMenu={e => { e.preventDefault(); nav.openSongActions({ song, list: songs, listLabel: label }) }}
            >
              <Cover song={song} size={72} rounded={8} />
              <span className="wf-m-song-meta">
                <span className="wf-m-song-name">
                  {song.name}
                  {song.vip && <span className="wf-m-badge-vip">VIP</span>}
                </span>
                <span className="wf-m-song-sub">{songArtists(song)}</span>
              </span>
              <span className="wf-m-song-playbtn"><IconPlay size={16} /></span>
            </button>
          </li>
        ))}
      </ul>
      <div ref={sentinelRef} />
    </>
  )
})

// 保留暂停图标引用（榜单卡播放态切换用）
void IconPause
