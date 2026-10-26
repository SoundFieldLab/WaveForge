/**
 * 移动端全屏播放页：封面/歌词双视图 + 进度拖动 + 播放控制 + 队列抽屉。
 * 手势：整体下滑关闭；封面区左右滑切歌。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getLyrics, type LyricLine } from '../services/musicApi'
import { useColorThief } from '../hooks/useColorThief'
import { useMobilePlayer, useMobileTime } from './mobilePlayer'
import { useMobileBack } from './mobileBack'
import {
  Cover, IconChevronDown, IconClose, IconHeart, IconHeartFilled, IconNext, IconPause, IconPlay,
  IconPrev, IconQueue, IconRepeat, IconRepeatOne, IconShuffle, IconVolume, Spinner, fmtTime, songArtists, songCoverUrl,
} from './ui'

export default memo(function PlayerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const player = useMobilePlayer()
  const { currentTime: playTime, isBuffering } = useMobileTime()
  const song = player.currentSong
  const [view, setView] = useState<'cover' | 'lyrics'>('cover')
  const [queueOpen, setQueueOpen] = useState(false)
  const [dragY, setDragY] = useState(0)
  const dragStartRef = useRef<{ x: number; y: number; mode: '' | 'vertical' | 'horizontal' } | null>(null)

  // 封面取色 → 播放页沉浸式渐变背景（官方手机播放页质感）
  const coverUrl = song ? songCoverUrl(song, 300) : ''
  const colorResult = useColorThief(coverUrl)
  const ambientColor = colorResult.status === 'ready' && colorResult.dominantColor ? colorResult.dominantColor : '#1d2736'

  // ── 歌词 ──
  const [lyrics, setLyrics] = useState<LyricLine[]>([])
  const [lyricsLoading, setLyricsLoading] = useState(false)
  useEffect(() => {
    setLyrics([])
    if (!song) return
    const platform = song.platform || 'netease'
    const id = platform === 'qq' ? (song.mid || song.id) : song.id
    let alive = true
    setLyricsLoading(true)
    getLyrics(id, platform, song.name, songArtists(song), Number(song.duration) / 1000 || undefined)
      .then(lines => { if (alive) setLyrics(lines || []) })
      .catch(() => undefined)
      .finally(() => { if (alive) setLyricsLoading(false) })
    return () => { alive = false }
  }, [song])

  const activeLyricIndex = useMemo(() => {
    if (!lyrics.length) return -1
    let found = -1
    for (let i = lyrics.length - 1; i >= 0; i -= 1) {
      if (lyrics[i].time <= playTime + 0.4) { found = i; break }
    }
    return found
  }, [lyrics, playTime])

  const lyricsBoxRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (view !== 'lyrics' || activeLyricIndex < 0) return
    const box = lyricsBoxRef.current
    const el = box?.querySelector(`[data-line="${activeLyricIndex}"]`) as HTMLElement | null
    if (box && el) {
      box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' })
    }
  }, [view, activeLyricIndex])

  // ── 进度条拖动（受控：拖动态显示本地值，松手 seek）──
  const [seeking, setSeeking] = useState<number | null>(null)
  const onSeekChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSeeking(Number(e.target.value))
  }, [])
  const onSeekCommit = useCallback(() => {
    if (seeking != null) player.seekTo(seeking)
    setSeeking(null)
  }, [player, seeking])
  const displayTime = seeking ?? playTime

  // ── 手势：下滑关闭 / 封面区横滑切歌 ──
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return
    dragStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, mode: '' }
  }, [])
  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const start = dragStartRef.current
    if (!start || e.touches.length !== 1) return
    const dx = e.touches[0].clientX - start.x
    const dy = e.touches[0].clientY - start.y
    if (!start.mode) {
      if (Math.abs(dy) > 18 && dy > 0) start.mode = 'vertical'
      else if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy)) start.mode = 'horizontal'
    }
    if (start.mode === 'vertical') setDragY(Math.max(0, dy))
  }, [])
  const onTouchEnd = useCallback(() => {
    const start = dragStartRef.current
    dragStartRef.current = null
    if (start?.mode === 'vertical') {
      if (dragY > 110) {
        setDragY(0)
        onClose()
        return
      }
      // 回弹
      setDragY(0)
    }
  }, [dragY, onClose])

  // 封面横滑切歌（在封面/歌词容器上）
  const swipeRef = useRef<{ x: number; fired: boolean } | null>(null)
  const onCoverTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) swipeRef.current = { x: e.touches[0].clientX, fired: false }
  }, [])
  const onCoverTouchMove = useCallback((e: React.TouchEvent) => {
    const s = swipeRef.current
    if (!s || s.fired || e.touches.length !== 1) return
    const dx = e.touches[0].clientX - s.x
    if (Math.abs(dx) > 60) {
      s.fired = true
      if (dx < 0) player.next()
      else player.prev()
    }
  }, [player])
  const onCoverTouchEnd = useCallback(() => { swipeRef.current = null }, [])

  // 歌词行跳转（稳定身份：LyricsList 按 activeIndex memo，不随进度 tick 重挂）
  const onSeekLyricLine = useCallback((time: number) => {
    player.seekTo(Math.max(0, time - 0.2))
  }, [player])

  // BACK：队列抽屉 → 播放页 → 关闭
  useMobileBack(() => {
    if (!open) return false
    if (queueOpen) { setQueueOpen(false); return true }
    onClose()
    return true
  }, [open, queueOpen, onClose])

  if (!open || !song) return null

  const bigCover = songCoverUrl(song, 640)
  const ModeIcon = player.playMode === 'single' ? IconRepeatOne : IconRepeat

  return (
    <div
      className="wf-m-sheet"
      style={{ transform: dragY ? `translateY(${dragY}px)` : undefined, transition: dragY ? 'none' : undefined }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* 沉浸式背景：封面取色主导的垂直渐变 + 封面微糊层（官方手机播放页质感） */}
      <div
        className="wf-m-sheet-ambient"
        style={{ background: `linear-gradient(175deg, ${ambientColor} -30%, #0a0d13 72%)` }}
      />
      <div className="wf-m-sheet-bg" style={bigCover ? { backgroundImage: `url(${bigCover})` } : undefined} />
      <div className="wf-m-sheet-shade" />

      <header className="wf-m-sheet-head">
        <button type="button" className="wf-m-iconbtn" aria-label="收起" onClick={onClose}>
          <IconChevronDown size={22} />
        </button>
        <div className="wf-m-sheet-headmeta">
          <span className="wf-m-sheet-ctx">{player.contextLabel || '正在播放'}</span>
        </div>
        <button type="button" className="wf-m-iconbtn" aria-label="播放队列" onClick={() => setQueueOpen(v => !v)}>
          <IconQueue size={20} />
        </button>
      </header>

      <div
        className={`wf-m-sheet-body ${view === 'lyrics' ? 'is-lyrics' : 'is-cover'}`}
        onTouchStart={onCoverTouchStart}
        onTouchMove={onCoverTouchMove}
        onTouchEnd={onCoverTouchEnd}
        onClick={() => setView(v => (v === 'cover' ? 'lyrics' : 'cover'))}
      >
        {view === 'cover' ? (
          <div className="wf-m-sheet-coverwrap">
            <Cover url={bigCover} size={640} rounded={18} className={`wf-m-sheet-cover ${player.isPlaying ? 'is-playing' : ''}`} />
            <p className="wf-m-sheet-hint">左右滑切歌 · 点按看歌词</p>
          </div>
        ) : (
          <div
            className="wf-m-lyrics"
            ref={lyricsBoxRef}
            onClick={e => {
              // 点在歌词行上 = 跳转该行；点在行间空白 = 回封面视图
              // （此前歌词页没有任何返回封面的入口，只能退出整个播放页）
              if ((e.target as HTMLElement).closest('[data-line]')) return
              e.stopPropagation()
              setView('cover')
            }}
          >
            <LyricsList
              lyrics={lyrics}
              activeIndex={activeLyricIndex}
              onSeekLine={onSeekLyricLine}
            />
            {lyricsLoading && <Spinner />}
            {!lyricsLoading && !lyrics.length && <p className="wf-m-sheet-hint">暂无歌词 · 点按空白处返回封面</p>}
          </div>
        )}
      </div>

      <div className="wf-m-sheet-meta">
        <div className="wf-m-sheet-title">{song.name}</div>
        <div className="wf-m-sheet-artist">{songArtists(song)}</div>
      </div>

      <div className="wf-m-sheet-seek">
        <span className="wf-m-time">{fmtTime(displayTime)}</span>
        <input
          className="wf-m-slider wf-m-slider-seek"
          type="range" min={0} max={Math.max(1, Math.floor(player.duration))} step={1}
          value={Math.floor(displayTime)}
          disabled={player.duration <= 0}
          onChange={onSeekChange}
          onPointerUp={onSeekCommit}
          onTouchEnd={onSeekCommit}
          onMouseUp={onSeekCommit}
          onKeyUp={onSeekCommit}
        />
        <span className="wf-m-time">{player.duration > 0 ? fmtTime(player.duration) : '--:--'}</span>
      </div>

      <div className="wf-m-sheet-controls">
        <button type="button" className={`wf-m-iconbtn wf-m-ctl-side ${player.playMode !== 'list' ? 'is-on' : ''}`} onClick={player.cyclePlayMode} aria-label="播放模式">
          {player.playMode === 'random' ? <IconShuffle size={20} /> : <ModeIcon size={20} />}
        </button>
        <button type="button" className="wf-m-iconbtn wf-m-ctl" aria-label="上一首" onClick={() => player.prev()}>
          <IconPrev size={30} />
        </button>
        <button type="button" className="wf-m-iconbtn wf-m-ctl wf-m-ctl-main" aria-label={player.isPlaying ? '暂停' : '播放'} onClick={() => player.toggle()}>
          {isBuffering && !player.isPlaying
            ? <span className="wf-m-spinner wf-m-spinner-lg" />
            : player.isPlaying ? <IconPause size={34} /> : <IconPlay size={34} />}
        </button>
        <button type="button" className="wf-m-iconbtn wf-m-ctl" aria-label="下一首" onClick={() => player.next()}>
          <IconNext size={30} />
        </button>
        <button
          type="button"
          className={`wf-m-iconbtn wf-m-ctl-side ${player.favorite ? 'is-on' : ''}`}
          aria-label="喜欢"
          onClick={() => void player.toggleFavorite()}
        >
          {player.favorite ? <IconHeartFilled size={20} /> : <IconHeart size={20} />}
        </button>
      </div>

      <div className="wf-m-sheet-volume">
        <IconVolume size={16} />
        <input
          className="wf-m-slider"
          type="range" min={0} max={100} step={1}
          value={Math.round(player.volume * 100)}
          onChange={e => player.changeVolume(Number(e.target.value) / 100)}
        />
      </div>

      {/* 队列抽屉 */}
      {queueOpen && (
        <div className="wf-m-queue">
          <div className="wf-m-queue-head">
            <span>播放队列（{player.queue.length}）</span>
            <button type="button" className="wf-m-iconbtn" onClick={() => setQueueOpen(false)}><IconClose size={18} /></button>
          </div>
          <ul className="wf-m-queue-list">
            {player.queue.map((q, i) => (
              <li key={`${q.platform || ''}-${q.id ?? q.mid}-${i}`}>
                <button
                  type="button"
                  className={`wf-m-queue-row ${i === player.index ? 'is-active' : ''}`}
                  onClick={() => player.playAt(i)}
                >
                  <span className="wf-m-queue-meta">
                    <span className="wf-m-queue-name">{q.name}</span>
                    <span className="wf-m-queue-sub">{songArtists(q)}</span>
                  </span>
                  {player.queue.length > 1 && (
                    <span
                      role="button"
                      className="wf-m-queue-remove"
                      onClick={e => { e.stopPropagation(); player.removeAt(i) }}
                    >
                      <IconClose size={14} />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
})

/** 歌词列表：按高亮行号 memo——播放进度每 tick 只需要改一个行的 class，
 *  不再整列表重新 reconcile（几百行歌词时每秒 4 次全量 diff 是白烧的电）。 */
const LyricsList = memo(function LyricsList({ lyrics, activeIndex, onSeekLine }: {
  lyrics: LyricLine[]
  activeIndex: number
  onSeekLine: (time: number) => void
}) {
  return (
    <>
      {lyrics.map((line, i) => (
        <p
          key={i}
          data-line={i}
          className={`wf-m-lyric-line ${i === activeIndex ? 'is-active' : ''}`}
          onClick={() => onSeekLine(line.time)}
        >
          {line.text || '♪'}
          {line.translation && <span className="wf-m-lyric-trans">{line.translation}</span>}
        </p>
      ))}
    </>
  )
})
