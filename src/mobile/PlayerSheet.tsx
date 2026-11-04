/**
 * 移动端全屏播放页：封面/歌词双视图 + 进度拖动 + 播放控制 + 队列抽屉。
 * 手势：整体下滑关闭；封面区左右滑切歌。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getLyrics, type LyricLine } from '../services/musicApi'
import { useColorThief } from '../hooks/useColorThief'
import { useMobilePlayer, useMobileTime } from './mobilePlayer'
import { getMobileAudioQuality, setMobileAudioQuality } from './mobilePlayer'
import { getQualityOptions } from '../services/audioQualitySettings'
import { getMobileEffectsScene, setMobileEffectsScene, getMobileScenes } from './mobileEffects'
import MobileCommentsSheet from './MobileCommentsSheet'
import MobileSongDetailSheet from './MobileSongDetailSheet'
import MobileLyricSettingsSheet, { readLyricViewSettings, type LyricViewSettings } from './MobileLyricSettingsSheet'
import { useMobileBack } from './mobileBack'
import {
  Cover, IconArrowDown, IconArrowUp, IconChevronDown, IconClose, IconHeart, IconHeartFilled, IconMore, IconNext, IconPause, IconPlay,
  IconPlayCircle, IconPrev, IconQueue, IconRepeat, IconRepeatOne, IconSettings2, IconShuffle, IconVolume, Spinner, fmtTime, songArtists, songCoverUrl,
  mobileToast,
} from './ui'
import { useMobileNav } from './nav'
import type { Song } from '../services/musicApi'

export default memo(function PlayerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const player = useMobilePlayer()
  const nav = useMobileNav()
  const { currentTime: playTime, isBuffering } = useMobileTime()
  const song = player.currentSong
  const [mvLoading, setMvLoading] = useState(false)
  const [view, setView] = useState<'cover' | 'lyrics'>('cover')
  const [queueOpen, setQueueOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [lyricSettingsOpen, setLyricSettingsOpen] = useState(false)
  const [lyricView, setLyricView] = useState<LyricViewSettings>(readLyricViewSettings)
  useEffect(() => {
    const sync = () => setLyricView(readLyricViewSettings())
    window.addEventListener('waveforge:mobile-lyric-view-changed', sync)
    return () => window.removeEventListener('waveforge:mobile-lyric-view-changed', sync)
  }, [])
  const [dragY, setDragY] = useState(0)
  const dragStartRef = useRef<{ x: number; y: number; mode: '' | 'vertical' | 'horizontal' } | null>(null)

  // ── 音质面板状态（按当前平台档位选项）──
  const songPlatform = (song?.platform || 'netease') as Parameters<typeof getQualityOptions>[0]
  const qualityOptions = useMemo(() => getQualityOptions(songPlatform), [songPlatform])
  const [qualityValue, setQualityValue] = useState<string>(() => String(getMobileAudioQuality(songPlatform)))
  useEffect(() => {
    const sync = () => setQualityValue(String(getMobileAudioQuality(songPlatform)))
    sync()
    window.addEventListener('waveforge:mobile-quality-changed', sync)
    return () => window.removeEventListener('waveforge:mobile-quality-changed', sync)
  }, [songPlatform])

  // ── 音效场景状态 ──
  const [effectScene, setEffectScene] = useState<string>(() => getMobileEffectsScene())
  const mobileScenes = useMemo(() => getMobileScenes(), [])

  // ── 相似歌曲（getSimilarSongs 同 PC 服务）：面板内点播 ──
  const [similarOpen, setSimilarOpen] = useState(false)
  const [similarLoading, setSimilarLoading] = useState(false)
  const [similarSongs, setSimilarSongs] = useState<Song[]>([])
  const loadSimilar = useCallback(async () => {
    if (!song || similarLoading) return
    setSimilarLoading(true)
    try {
      const { getSimilarSongs } = await import('../services/musicApi')
      const raw = await getSimilarSongs(String(song.platform === 'qq' ? (song.mid || song.id) : song.id), (song.platform || 'netease') as 'netease' | 'qq')
      // 上游返回 { songs } 或裸数组（两代接口形状都兼容）
      const list: Song[] = Array.isArray(raw) ? raw : (raw?.songs || raw?.songlist || [])
      setSimilarSongs(list.slice(0, 12))
      setSimilarOpen(list.length > 0)
      if (!list.length) mobileToast('没有找到相似歌曲', 'info')
    } catch {
      mobileToast('相似歌曲获取失败', 'error')
    } finally {
      setSimilarLoading(false)
    }
  }, [song, similarLoading])

  // ── 倍速 ──
  const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2]
  const [speed, setSpeed] = useState(1)
  useEffect(() => {
    // 当前曲变化/切歌后 playbackRate 可能被引擎归位：面板打开时读取真实值
    if (moreOpen) setSpeed(player.audioRate ?? 1)
  }, [moreOpen, player.audioRate])
  const changeSpeed = useCallback((v: number) => {
    setSpeed(v)
    player.setAudioRate(v)
  }, [player])

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
  // 用户滚动让位：手动滚动歌词后暂停自动跟随，2.5s 无操作（或点「回到当前行」）
  // 恢复跟随。没有这个机制，长歌词页手动浏览会被 0.4s 一跳的自动滚动顶回去。
  // programmatic 标记：自动跟随自己的 smooth scrollTo 也会触发 onScroll ——
  // 不排除的话自动跟随会自我抑制（跟随刚启动就被关掉 2.5s，「当前行」按钮闪烁）。
  const [userScrolling, setUserScrolling] = useState(false)
  const userScrollTimerRef = useRef<number | null>(null)
  const programmaticScrollUntilRef = useRef(0)
  const lastAutoScrollLineRef = useRef(-1)
  const markUserScrolling = useCallback(() => {
    // 程序化滚动窗口内的 scroll 事件不算用户意图
    if (performance.now() < programmaticScrollUntilRef.current) return
    setUserScrolling(true)
    if (userScrollTimerRef.current !== null) window.clearTimeout(userScrollTimerRef.current)
    userScrollTimerRef.current = window.setTimeout(() => setUserScrolling(false), 2500)
  }, [])
  useEffect(() => () => {
    if (userScrollTimerRef.current !== null) window.clearTimeout(userScrollTimerRef.current)
  }, [])
  useEffect(() => {
    if (view !== 'lyrics' || activeLyricIndex < 0) return
    // 用户滚动期间不自动跟（回到当前行按钮可恢复）；行没变也不重复滚
    if (userScrolling) return
    if (lastAutoScrollLineRef.current === activeLyricIndex) return
    lastAutoScrollLineRef.current = activeLyricIndex
    const box = lyricsBoxRef.current
    const el = box?.querySelector(`[data-line="${activeLyricIndex}"]`) as HTMLElement | null
    if (box && el) {
      // smooth 滚动期间的 scroll 事件带时间窗豁免（见 markUserScrolling）
      programmaticScrollUntilRef.current = performance.now() + 900
      box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' })
    }
  }, [view, activeLyricIndex, userScrolling])

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

  // BACK：子弹层（评论/详情/歌词设置）→ 队列抽屉/更多面板 → 歌词回封面 → 关闭
  useMobileBack(() => {
    if (!open) return false
    if (commentsOpen) { setCommentsOpen(false); return true }
    if (detailOpen) { setDetailOpen(false); return true }
    if (lyricSettingsOpen) { setLyricSettingsOpen(false); return true }
    if (queueOpen) { setQueueOpen(false); return true }
    if (moreOpen) { setMoreOpen(false); return true }
    if (view === 'lyrics') { setView('cover'); return true }
    onClose()
    return true
  }, [open, queueOpen, moreOpen, commentsOpen, detailOpen, lyricSettingsOpen, view, onClose])

  if (!open || !song) return null

  const bigCover = songCoverUrl(song, 640)
  const ModeIcon = player.playMode === 'single' ? IconRepeatOne : IconRepeat

  return (
    <div
      className={`wf-m-sheet ${dragY ? 'is-dragging' : ''}`}
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
        <button type="button" className="wf-m-iconbtn" aria-label="更多设置" onClick={() => setMoreOpen(v => !v)}>
          <IconMore size={20} />
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
          <>
          <div
            className={`wf-m-lyrics ${userScrolling ? 'is-user-scrolling' : ''}`}
            ref={lyricsBoxRef}
            // 用户滚动意图只认 touchmove（程序化 smooth 滚动也发 scroll 事件，
            // 时间窗豁免是双保险；touchmove 只可能是真实手指）
            onTouchMove={markUserScrolling}
            onClick={e => {
              // 点在歌词行上 = 跳转该行；点在行间空白 = 回封面视图
              // （此前歌词页没有任何返回封面的入口，只能退出整个播放页）
              if ((e.target as HTMLElement).closest('[data-line]')) return
              e.stopPropagation()
              setView('cover')
            }}
          >
            <button
              type="button"
              className="wf-m-lyric-settings-btn"
              aria-label="歌词设置"
              onClick={e => { e.stopPropagation(); setLyricSettingsOpen(true) }}
            >
              <IconSettings2 size={18} />
            </button>
            <LyricsList
              lyrics={lyrics}
              activeIndex={activeLyricIndex}
              playTime={playTime}
              onSeekLine={onSeekLyricLine}
              showTranslation={lyricView.showTranslation}
              showRoman={lyricView.showRoman}
              fontScale={lyricView.fontScale}
              karaoke={lyricView.wordByWord}
            />
            {lyricsLoading && <Spinner />}
            {!lyricsLoading && !lyrics.length && <p className="wf-m-sheet-hint">暂无歌词 · 点按空白处返回封面</p>}
          </div>
          {/* 用户滚动让位后的「回到当前行」悬浮按钮 */}
          {view === 'lyrics' && userScrolling && activeLyricIndex >= 0 && (
            <button
              type="button"
              className="wf-m-lyric-recenter"
              aria-label="回到当前歌词"
              onClick={e => {
                e.stopPropagation()
                setUserScrolling(false)
                lastAutoScrollLineRef.current = -1
                const box = lyricsBoxRef.current
                const el = box?.querySelector(`[data-line="${activeLyricIndex}"]`) as HTMLElement | null
                if (box && el) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' })
              }}
            >
              <IconChevronDown size={15} />
              <span>当前行</span>
            </button>
          )}
          </>
          )}
      </div>

      <div className="wf-m-sheet-meta">
        <div onClick={() => setDetailOpen(true)} role="button" aria-label="查看歌曲详情" className="wf-m-sheet-meta-text">
          <div className="wf-m-sheet-title">{song.name}</div>
          {/* 歌手可点直达歌手页（首位有 id 时）；无 id 退化为歌曲详情 */}
          <div
            className="wf-m-sheet-artist wf-m-sheet-artist-link"
            role="button"
            aria-label={`查看歌手 ${songArtists(song)}`}
            onClick={e => {
              e.stopPropagation()
              const first = song.artists?.[0]
              if (first?.id != null) {
                nav.openArtist({ id: String(first.id), name: first.name, platform: (song.platform || 'netease') as import('../services/platforms').MusicPlatform })
              } else {
                setDetailOpen(true)
              }
            }}
          >
            {songArtists(song)} ›
          </div>
        </div>
        {/* MV 快捷入口：与长按菜单同一条解析链（mv/mvid → getMVPlaybackInfo） */}
        {(song.mv ?? (song as { mvid?: number | string }).mvid) && (
          <button
            type="button"
            className="wf-m-iconbtn wf-m-mvbtn"
            aria-label="观看 MV"
            disabled={mvLoading}
            onClick={async () => {
              const mvId = song.mv ?? (song as { mvid?: number | string }).mvid
              if (!mvId || mvLoading) return
              setMvLoading(true)
              try {
                const { getMVPlaybackInfo } = await import('../services/musicApi')
                const info = await getMVPlaybackInfo(mvId, 1080, (song.platform || 'netease') as import('../../src/services/platforms').MusicPlatform)
                if (info.url) nav.openMv({ url: info.url, title: song.name, artist: songArtists(song) })
                else mobileToast(info.error || info.needCookie ? 'MV 需要登录或版权受限' : 'MV 获取失败', 'error')
              } catch { mobileToast('MV 获取失败', 'error') } finally { setMvLoading(false) }
            }}
          >
            {mvLoading ? <span className="wf-m-spinner wf-m-spinner-sm" /> : <IconPlayCircle size={20} />}
          </button>
        )}
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
                    <span className="wf-m-queue-actions" onClick={e => e.stopPropagation()}>
                      {/* 上移（首行隐藏）；当前曲也可移动（索引随动，mobilePlayer.moveAt 处理） */}
                      {i > 0 && (
                        <span
                          role="button"
                          aria-label="上移"
                          className="wf-m-queue-move"
                          onClick={() => player.moveAt(i, i - 1)}
                        >
                          <IconArrowUp size={14} />
                        </span>
                      )}
                      {i < player.queue.length - 1 && (
                        <span
                          role="button"
                          aria-label="下移"
                          className="wf-m-queue-move"
                          onClick={() => player.moveAt(i, i + 1)}
                        >
                          <IconArrowDown size={14} />
                        </span>
                      )}
                      <span
                        role="button"
                        className="wf-m-queue-remove"
                        onClick={e => { e.stopPropagation(); player.removeAt(i) }}
                      >
                        <IconClose size={14} />
                      </span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="wf-m-queue-foot">
            <button type="button" className="wf-m-queue-clear" onClick={() => player.clearQueue()}>清空队列</button>
          </div>
        </div>
      )}

      {/* 更多面板：音质 / 音效 / 倍速 / 睡眠定时 */}
      {moreOpen && (
        <div className="wf-m-queue wf-m-more" onClick={e => e.stopPropagation()}>
          <div className="wf-m-queue-head">
            <span>播放设置</span>
            <button type="button" className="wf-m-iconbtn" onClick={() => setMoreOpen(false)}><IconClose size={18} /></button>
          </div>
          <div className="wf-m-more-body">
            {/* 音质 */}
            <div className="wf-m-more-group">
              <div className="wf-m-more-label">音质（下一首生效）</div>
              <div className="wf-m-hotwords">
                {qualityOptions.map(opt => (
                  <button
                    key={String(opt.value)}
                    type="button"
                    className={`wf-m-chip ${qualityValue === String(opt.value) ? 'is-on' : ''}`}
                    onClick={() => { setMobileAudioQuality(songPlatform, opt.value as never); setQualityValue(String(opt.value)) }}
                  >
                    {opt.shortLabel || opt.label}
                  </button>
                ))}
              </div>
            </div>
            {/* 音效场景 */}
            <div className="wf-m-more-group">
              <div className="wf-m-more-label">音效场景</div>
              <div className="wf-m-hotwords">
                {[{ id: 'off', name: '关闭' }, ...mobileScenes].map(scene => (
                  <button
                    key={scene.id}
                    type="button"
                    className={`wf-m-chip ${effectScene === scene.id ? 'is-on' : ''}`}
                    onClick={() => { setMobileEffectsScene(scene.id); setEffectScene(scene.id) }}
                  >
                    {scene.name}
                  </button>
                ))}
              </div>
            </div>
            {/* 倍速 */}
            <div className="wf-m-more-group">
              <div className="wf-m-more-label">倍速</div>
              <div className="wf-m-hotwords">
                {PLAYBACK_SPEEDS.map(v => (
                  <button
                    key={v}
                    type="button"
                    className={`wf-m-chip ${speed === v ? 'is-on' : ''}`}
                    onClick={() => changeSpeed(v)}
                  >
                    {v === 1 ? '原速' : `${v}x`}
                  </button>
                ))}
              </div>
            </div>
            {/* 睡眠定时 */}
            <div className="wf-m-more-group">
              <div className="wf-m-more-label">
                睡眠定时
                {player.sleepTimerEndsAt != null && (
                  <span className="wf-m-more-timer">剩 {Math.max(0, Math.ceil((player.sleepTimerEndsAt - Date.now()) / 60000))} 分钟</span>
                )}
              </div>
              <div className="wf-m-hotwords">
                {[15, 30, 60, 90].map(m => (
                  <button key={m} type="button" className="wf-m-chip" onClick={() => player.setSleepTimer(m)}>
                    {m} 分钟
                  </button>
                ))}
                {player.sleepTimerEndsAt != null && (
                  <button type="button" className="wf-m-chip is-on" onClick={() => player.setSleepTimer(0)}>取消</button>
                )}
              </div>
            </div>
            {/* 评论 / 歌曲详情 / 相似歌曲 */}
            <div className="wf-m-more-group wf-m-more-row">
              <button type="button" className="wf-m-btn wf-m-btn-primary" onClick={() => { setMoreOpen(false); setCommentsOpen(true) }}>
                查看热门评论
              </button>
              <button type="button" className="wf-m-btn wf-m-btn-ghost" onClick={() => { setMoreOpen(false); setDetailOpen(true) }}>
                歌曲详情
              </button>
            </div>
            <div className="wf-m-more-group wf-m-more-row">
              <button type="button" className="wf-m-btn wf-m-btn-ghost" onClick={() => { setMoreOpen(false); void loadSimilar() }} disabled={similarLoading}>
                {similarLoading ? '匹配中…' : '找相似歌曲'}
              </button>
            </div>
            {similarOpen && similarSongs.length > 0 && (
              <div className="wf-m-more-group">
                <div className="wf-m-more-label">相似歌曲（点播）</div>
                <div className="wf-m-more-similar">
                  {similarSongs.map((s, i) => (
                    <button
                      key={`${s.platform || ''}-${s.id ?? s.mid}-${i}`}
                      type="button"
                      className="wf-m-song-mini"
                      onClick={() => player.playSongs(similarSongs, i, `相似：${song.name}`)}
                    >
                      <Cover song={s} size={64} rounded={6} />
                      <span className="wf-m-song-meta">
                        <span className="wf-m-song-name">{s.name}</span>
                        <span className="wf-m-song-sub">{songArtists(s)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 热评面板 */}
      <MobileCommentsSheet song={commentsOpen ? song : null} onClose={() => setCommentsOpen(false)} />
      {/* 歌曲详情面板 */}
      <MobileSongDetailSheet song={detailOpen ? song : null} onClose={() => setDetailOpen(false)} />
      {/* 歌词设置面板 */}
      <MobileLyricSettingsSheet
        open={lyricSettingsOpen}
        settings={lyricView}
        onChange={setLyricView}
        onClose={() => setLyricSettingsOpen(false)}
      />
    </div>
  )
})

/** 歌词列表（移动播放页专属 karaoke 版）：
 *  - 行级高亮 + 活跃行逐字填充（LyricWord{start,duration} 相对行内毫秒，
 *    用 playTime 实时算每个字的填充比例，Apple Music 同款扫字效果）；
 *  - 无逐字数据的行退化为整行高亮（与旧版一致）；
 *  - 按「活跃行号 + 逐字开关」memo：播放 tick 只重渲染活跃行附近的 DOM，
 *    活跃行内部用 CSS 变量 --fill 驱动渐变（行内 span 每帧改一个变量，
 *    不触发 React 渲染——该 span 由 KaraokeWord 组件内部 rAF 自己管）。 */
const LyricsList = memo(function LyricsList({ lyrics, activeIndex, playTime, onSeekLine, showTranslation, showRoman, fontScale, karaoke }: {
  lyrics: LyricLine[]
  activeIndex: number
  playTime: number
  onSeekLine: (time: number) => void
  showTranslation: boolean
  showRoman: boolean
  fontScale: number
  karaoke: boolean
}) {
  const activeLine = activeIndex >= 0 && activeIndex < lyrics.length ? lyrics[activeIndex] : null
  const activeHasWords = karaoke && Boolean(activeLine?.words?.length)
  return (
    <div style={{ fontSize: `calc(1rem * ${fontScale})` }}>
      {lyrics.map((line, i) => {
        const isActive = i === activeIndex
        const useWords = isActive && activeHasWords
        return (
          <p
            key={i}
            data-line={i}
            className={`wf-m-lyric-line ${isActive ? 'is-active' : ''} ${useWords ? 'is-karaoke' : ''}`}
            onClick={() => onSeekLine(line.time)}
          >
            {useWords && line.words!.length ? (
              <KaraokeLine
                key={`k-${activeIndex}-${lyrics.length}`}
                line={line}
                lineTime={line.time}
                playTime={playTime}
              />
            ) : (
              line.text || '♪'
            )}
            {showTranslation && line.translation && <span className="wf-m-lyric-trans">{line.translation}</span>}
            {showRoman && line.roman && <span className="wf-m-lyric-trans">{line.roman}</span>}
          </p>
        )
      })}
    </div>
  )
})

/** 活跃行逐字渲染：字间用渐变填充比例动画。rAF 本地驱动每个字的 --fill
 *  CSS 变量（0→1），React 零重渲染（fill 是 style 直写），切行时整组件重建。 */
const KaraokeLine = memo(function KaraokeLine({ line, lineTime, playTime }: {
  line: LyricLine
  lineTime: number
  playTime: number
}) {
  const spanRefs = useRef<Array<HTMLSpanElement | null>>([])
  const words = line.words!
  const rafRef = useRef<number | null>(null)
  useEffect(() => {
    let disposed = false
    const tick = () => {
      if (disposed) return
      const elapsed = (playTimeRef.current - lineTime) * 1000
      for (let i = 0; i < words.length; i += 1) {
        const span = spanRefs.current[i]
        if (!span) continue
        const word = words[i]
        const start = Number(word.startTime) || 0
        const duration = Math.max(1, Number(word.duration) || 1)
        const ratio = Math.max(0, Math.min(1, (elapsed - start) / duration))
        span.style.setProperty('--fill', String(ratio))
      }
      rafRef.current = window.requestAnimationFrame(tick)
    }
    rafRef.current = window.requestAnimationFrame(tick)
    return () => {
      disposed = true
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current)
    }
  }, [words, lineTime])
  const playTimeRef = useRef(playTime)
  playTimeRef.current = playTime
  return (
    <>
      {words.map((word, i) => (
        <span
          key={i}
          ref={el => { spanRefs.current[i] = el }}
          className="wf-m-karaoke-word"
        >
          {word.word}
        </span>
      ))}
    </>
  )
})
