/**
 * 移动端迷你播放条：位于底部导航之上，点击展开全屏播放页。
 * v2（2026-11-05）：+ 喜欢按钮（红心状态实时）+ 进度条点按 seek。
 */
import { memo } from 'react'
import { useMobilePlayer, useMobileTime } from './mobilePlayer'
import { IconHeart, IconHeartFilled, IconNext, IconPause, IconPlay, IconPrev, songCoverUrl, songArtists } from './ui'

export default memo(function MiniPlayerBar({ onOpen }: { onOpen: () => void }) {
  const player = useMobilePlayer()
  const { currentTime, isBuffering } = useMobileTime()
  const song = player.currentSong
  if (!song) return null
  const progress = player.duration > 0 ? Math.min(1, currentTime / player.duration) : 0
  const seekFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    if (player.duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    player.seekTo(ratio * player.duration)
  }

  return (
    <div className="wf-m-mini">
      {/* 进度线可点按 seek：热区外扩到整条轨道（透明底），视觉仍是细线填充 */}
      <div
        className="wf-m-mini-track"
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.floor(player.duration)}
        aria-valuenow={Math.floor(currentTime)}
        onClick={seekFromEvent}
      >
        <div className="wf-m-mini-progress" style={{ width: `${progress * 100}%` }} />
      </div>
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
        className={`wf-m-iconbtn wf-m-mini-btn ${player.favorite ? 'is-on' : ''}`}
        aria-label={player.favorite ? '取消喜欢' : '喜欢'}
        onClick={() => void player.toggleFavorite()}
      >
        {player.favorite ? <IconHeartFilled size={18} /> : <IconHeart size={18} />}
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
