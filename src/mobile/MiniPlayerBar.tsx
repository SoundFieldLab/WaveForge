/**
 * 移动端迷你播放条：位于底部导航之上，点击展开全屏播放页。
 */
import { memo } from 'react'
import { useMobilePlayer, useMobileTime } from './mobilePlayer'
import { IconNext, IconPause, IconPlay, songCoverUrl, songArtists } from './ui'

export default memo(function MiniPlayerBar({ onOpen }: { onOpen: () => void }) {
  const player = useMobilePlayer()
  const { currentTime, isBuffering } = useMobileTime()
  const song = player.currentSong
  if (!song) return null
  const progress = player.duration > 0 ? Math.min(1, currentTime / player.duration) : 0

  return (
    <div className="wf-m-mini">
      <div className="wf-m-mini-progress" style={{ width: `${progress * 100}%` }} />
      <button type="button" className="wf-m-mini-main" onClick={onOpen}>
        <span className={`wf-m-mini-cover ${player.isPlaying ? 'is-playing' : ''}`}>
          <img src={songCoverUrl(song, 120)} alt="" loading="lazy" draggable={false} />
        </span>
        <span className="wf-m-mini-meta">
          <span className="wf-m-mini-title">{song.name}</span>
          <span className="wf-m-mini-sub">{songArtists(song)}</span>
        </span>
      </button>
      <button
        type="button"
        className="wf-m-iconbtn wf-m-mini-btn"
        aria-label={player.isPlaying ? '暂停' : '播放'}
        onClick={() => player.toggle()}
      >
        {isBuffering && !player.isPlaying
          ? <span className="wf-m-spinner wf-m-spinner-sm" />
          : player.isPlaying ? <IconPause size={22} /> : <IconPlay size={22} />}
      </button>
      <button
        type="button"
        className="wf-m-iconbtn wf-m-mini-btn"
        aria-label="下一首"
        onClick={() => player.next()}
      >
        <IconNext size={20} />
      </button>
    </div>
  )
})
