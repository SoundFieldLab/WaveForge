/**
 * 移动端榜单详情页：榜单头图 + 完整曲目列表（数据来自发现页已预取的 ExploreChart.songs，
 * 无需二次请求）。支持整榜播放/单曲点播/长按动作面板。
 */
import { memo, useMemo } from 'react'
import type { Song } from '../../services/musicApi'
import { useMobilePlayer } from '../mobilePlayer'
import { triggerMobileBack } from '../mobileBack'
import { Cover, IconChevronLeft, IconPlay, songArtists } from '../ui'
import { useMobileNav } from '../nav'

export default memo(function MobileChartDetail({ chart }: { chart: import('../nav').MobileChartTarget }) {
  const player = useMobilePlayer()
  const nav = useMobileNav()

  // chart.songs 由 MobileHome 的 explore payload 预取（30 首）；nav 目标里可能只有兜底几首
  const songs = useMemo(() => (chart.songs || []) as Song[], [chart])

  return (
    <div className="wf-m-page">
      <header className="wf-m-header wf-m-chartdetail-head" style={chart.coverUrl ? { backgroundImage: `url(${chart.coverUrl})` } : undefined}>
        <button type="button" className="wf-m-iconbtn wf-m-chartdetail-back" aria-label="返回" onClick={() => triggerMobileBack()}>
          <IconChevronLeft size={22} />
        </button>
        <div className="wf-m-chartdetail-shade" />
        <div className="wf-m-chartdetail-meta">
          <div className="wf-m-chartdetail-title">{chart.name}</div>
          <div className="wf-m-chartdetail-sub">{songs.length} 首 · 更新于发现页缓存</div>
          <button
            type="button"
            className="wf-m-btn wf-m-btn-primary wf-m-chartdetail-playall"
            disabled={!songs.length}
            onClick={() => player.playSongs(songs, 0, chart.name)}
          >
            <IconPlay size={16} /> 播放全部
          </button>
        </div>
      </header>

      <ul className="wf-m-song-list">
        {songs.map((song, i) => (
          <li key={`${song.id ?? song.mid}-${i}`}>
            <button
              type="button"
              className={`wf-m-song-mini ${player.currentSong?.name === song.name && player.currentSong?.platform === song.platform ? 'is-active' : ''}`}
              onClick={() => player.playSongs(songs, i, chart.name)}
              onContextMenu={e => { e.preventDefault(); nav.openSongActions({ song, list: songs, listLabel: chart.name }) }}
            >
              <span className="wf-m-song-index">{i + 1}</span>
              <span className="wf-m-song-meta">
                <span className="wf-m-song-name">{song.name}</span>
                <span className="wf-m-song-sub">{songArtists(song)}</span>
              </span>
              <Cover song={song} size={72} rounded={6} />
            </button>
          </li>
        ))}
      </ul>
      {!songs.length && <p className="wf-m-hint">榜单曲目加载失败，请返回发现页重试</p>}
    </div>
  )
})

