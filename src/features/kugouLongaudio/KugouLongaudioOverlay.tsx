/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 独立听书播放器（形态参照 Apple Music 电台/播客）：左侧大封面 + 专辑名/作者/简介，
 * 右侧章节列表（当前章节高亮、点击切章），底部播放/暂停/上一章/下一章/倍速/章节进度。
 *
 * 为什么独立：听书不是歌曲——没有歌词/频谱/MV/自动混音，接进主歌词播放器会把章节塞进
 * 主播放队列与过渡策略。这里只用自己的 HTMLAudioElement，主音乐在起播前通过
 * waveforge:pause-main-playback 事件优雅暂停；退出时也绝不回写主播放器状态。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  AudioLines,
  BookAudio,
  Crown,
  History,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { useModeParked } from '../../utils/modeLayer'
import { kugouLongaudioStore, LONGAUDIO_RATE_STEPS, type LongaudioState } from './store'

const ACCENT = '#FF7A00'

const formatTime = (seconds?: number): string => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}

const formatCount = (value?: number): string => {
  const count = Number(value || 0)
  if (!count) return ''
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)}亿`
  if (count >= 10_000) return `${(count / 10_000).toFixed(1)}万`
  return String(count)
}

const Cover = ({ src, alt, className }: { src?: string; alt: string; className?: string }) => (
  <CachedImage
    src={src || ''}
    alt={alt}
    className={className}
    draggable={false}
    role="hero"
    priority="visible"
    fallback={<div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,rgba(255,122,0,0.85),rgba(20,184,166,0.6))] text-white/80"><BookAudio className="h-10 w-10" /></div>}
  />
)

/** 我的听书：最近收听（本地持久化，跨会话保留） */
function LongaudioLibrary({ onOpenAlbum }: { onOpenAlbum: (albumId: string, autoplay: boolean, summary: LongaudioState['recent'][number]) => void }) {
  const state = useSyncExternalStore(kugouLongaudioStore.subscribe, kugouLongaudioStore.getState)
  const recent = state.recent
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="mb-4 flex items-center gap-2 text-white/86">
        <History className="h-4 w-4 text-white/50" />
        <h2 className="text-lg font-semibold">我的听书</h2>
        <span className="text-xs text-white/36">最近收听（本机记录，最多 12 张）</span>
      </div>
      {recent.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-[24px] border border-white/[0.07] bg-white/[0.03] px-6 py-14 text-center">
          <BookAudio className="mb-3 h-8 w-8 text-white/22" />
          <p className="text-sm font-medium text-white/70">还没有听过听书专辑</p>
          <p className="mt-1.5 text-xs text-white/38">回到探索页的「听书」板块挑一张专辑，播放后会自动出现在这里。</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
          {recent.map(album => (
            <motion.div
              key={album.albumId}
              whileHover={{ y: -4 }}
              className="group min-w-0 cursor-pointer"
              onClick={() => onOpenAlbum(album.albumId, false, album)}
            >
              <div className="relative aspect-square overflow-hidden rounded-[20px] border border-white/[0.08] bg-white/[0.04]">
                <Cover src={album.coverUrl} alt={album.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    onOpenAlbum(album.albumId, true, album)
                  }}
                  className="absolute bottom-2.5 right-2.5 flex h-10 w-10 translate-y-2 items-center justify-center rounded-full text-[#081017] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"
                  style={{ background: ACCENT }}
                  aria-label={`继续收听 ${album.name}`}
                >
                  <Play className="h-4 w-4 fill-current" />
                </button>
              </div>
              <h3 className="mt-2.5 line-clamp-2 text-sm font-medium leading-snug text-white/86">{album.name}</h3>
              <p className="mt-1 truncate text-xs text-white/38">{album.author || '未知主播'}</p>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function KugouLongaudioOverlay() {
  const state = useSyncExternalStore(kugouLongaudioStore.subscribe, kugouLongaudioStore.getState) as LongaudioState
  // 探索层被挂起（切到其它模式）时让位：portal 挂在 body 上，CSS 的 visibility 管不到，
  // 不读挂起态会盖住当前模式（同仓库既有浮层的统一约定，见 src/utils/modeLayer.ts）
  const parked = useModeParked()
  const { player } = state
  const album = player.album
  const current = player.chapters[player.currentIndex]
  const view = state.view

  const close = useCallback(() => kugouLongaudioStore.exit(), [])

  useEffect(() => {
    if (view === 'closed' || parked) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [view, parked, close])

  if (view === 'closed' || parked) return null

  const duration = player.duration || current?.duration || 0
  const progress = duration > 0 ? Math.min(100, (player.currentTime / duration) * 100) : 0
  const statusLabel = player.status === 'loading' ? '解析中…' : player.status === 'playing' ? '播放中' : player.status === 'error' ? '播放失败' : '已就绪'

  const openRecent = (albumId: string, autoplay: boolean, summary: LongaudioState['recent'][number]) => {
    void kugouLongaudioStore.openAlbum(albumId, {
      play: autoplay,
      summary: { albumId: summary.albumId, name: summary.name, coverUrl: summary.coverUrl, author: summary.author, chapterCount: summary.chapterCount },
    })
  }

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[130] flex flex-col bg-[#0a0c11]/97 text-white backdrop-blur-2xl"
      data-kugou-longaudio-player=""
    >
      {/* 顶部：听书独立入口标识 + 视图切换 + 关闭 */}
      <header className="flex shrink-0 items-center gap-3 border-b border-white/[0.07] px-5 py-3.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `linear-gradient(135deg, ${ACCENT}, rgba(255,122,0,0.55))` }}>
          <BookAudio className="h-5 w-5 text-[#081017]" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold">听书</h1>
            <span className="rounded-full border border-white/[0.1] bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/45">独立播放通道</span>
          </div>
          <p className="truncate text-xs text-white/40">{state.activeAlbum ? `${state.activeAlbum.name}${state.activeAlbum.author ? ` · ${state.activeAlbum.author}` : ''}` : '有声小说 / 相声评书 / 助眠解压'}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {view === 'player' ? (
            <button
              type="button"
              onClick={() => kugouLongaudioStore.openLibrary()}
              className="flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 text-xs text-white/62 transition hover:bg-white/[0.1] hover:text-white"
            >
              <History className="h-3.5 w-3.5" /> 我的听书
            </button>
          ) : (
            <button
              type="button"
              onClick={() => kugouLongaudioStore.enter()}
              className="flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 text-xs text-white/62 transition hover:bg-white/[0.1] hover:text-white"
            >
              <AudioLines className="h-3.5 w-3.5" /> 当前收听
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.05] text-white/60 transition hover:bg-white/[0.12] hover:text-white"
            aria-label="退出听书"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {view === 'library' ? (
        <LongaudioLibrary onOpenAlbum={openRecent} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {/* 左：大封面 + 专辑信息 */}
          <aside className="shrink-0 overflow-y-auto border-b border-white/[0.07] p-6 lg:w-[380px] lg:border-b-0 lg:border-r">
            <div className="relative mx-auto aspect-square w-full max-w-[300px] overflow-hidden rounded-[28px] border border-white/[0.09] shadow-2xl shadow-black/45">
              <Cover src={album?.coverUrl || state.activeAlbum?.coverUrl} alt={album?.name || state.activeAlbum?.name || '听书专辑'} className="h-full w-full object-cover" />
              {player.status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                  <Loader2 className="h-7 w-7 animate-spin" style={{ color: ACCENT }} />
                </div>
              )}
            </div>
            <h2 className="mt-5 text-xl font-semibold leading-snug">{album?.name || state.activeAlbum?.name || '听书专辑'}</h2>
            <p className="mt-1.5 text-sm text-white/48">{album?.author || state.activeAlbum?.author || '未知主播'}</p>
            {album && album.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {album.tags.slice(0, 6).map(tag => (
                  <span key={tag} className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-0.5 text-[11px] text-white/55">{tag}</span>
                ))}
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/40">
              {formatCount(album?.playCount) && <span>{formatCount(album?.playCount)} 次播放</span>}
              {(state.activeAlbum?.chapterCount || player.chapters.length) > 0 && (
                <span>{state.activeAlbum?.chapterCount || player.chapters.length} 章</span>
              )}
              {album?.publishCompany && <span>{album.publishCompany}</span>}
            </div>
            {album?.intro && (
              <p className="mt-4 max-h-40 overflow-y-auto whitespace-pre-line pr-1 text-xs leading-relaxed text-white/45">{album.intro}</p>
            )}
            <div className="mt-5 flex items-center gap-2.5">
              <button
                type="button"
                disabled={player.chapters.length === 0}
                onClick={() => {
                  // 已选中章节 → 继续/暂停（保留进度）；未选中 → 从第一章起播
                  if (player.currentIndex >= 0) void kugouLongaudioStore.togglePlay()
                  else void kugouLongaudioStore.startPlaylist()
                }}
                className="flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold text-[#081017] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: ACCENT }}
              >
                {player.status === 'playing' ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
                {player.status === 'playing' ? '暂停' : player.currentIndex >= 0 ? '继续收听' : '从头播放'}
              </button>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-[11px] leading-relaxed text-white/30">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              听书使用独立的音频通道：开始播放时会请求暂停主播放器，退出听书不会改动主播放器队列与进度。
            </p>
          </aside>

          {/* 右：章节列表 */}
          <section className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between px-5 py-3.5">
              <h3 className="text-sm font-semibold text-white/80">章节列表</h3>
              <span className="text-xs text-white/36">
                已加载 {player.chapters.length} 章{player.chapterHasMore ? ' · 还有更多' : ''}
              </span>
            </div>
            {player.albumLoading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-white/45">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在加载专辑与章节…
              </div>
            ) : player.albumError && !album ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <AlertCircle className="h-7 w-7 text-white/25" />
                <p className="text-sm text-white/70">专辑信息加载失败</p>
                <p className="max-w-sm text-xs text-white/38">{player.albumError}</p>
                <button
                  type="button"
                  onClick={() => { if (state.activeAlbum) void kugouLongaudioStore.openAlbum(state.activeAlbum.albumId) }}
                  className="mt-1 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[#081017]"
                  style={{ background: ACCENT }}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> 重试
                </button>
              </div>
            ) : player.chapters.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <BookAudio className="h-7 w-7 text-white/25" />
                <p className="text-sm text-white/70">该专辑暂时没有可播放章节</p>
                {player.chapterError && <p className="max-w-sm text-xs text-white/38">{player.chapterError}</p>}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                {player.chapters.map((chapter, index) => {
                  const active = index === player.currentIndex
                  const restricted = chapter.payType !== 0 || chapter.privilege !== 0
                  return (
                    <button
                      key={`${chapter.hash}-${index}`}
                      type="button"
                      onClick={() => void kugouLongaudioStore.selectChapter(index, true)}
                      className={`group mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${active ? 'bg-white/[0.09]' : 'hover:bg-white/[0.05]'}`}
                    >
                      <span className="flex w-7 shrink-0 items-center justify-center text-xs" style={{ color: active ? ACCENT : 'rgba(255,255,255,0.35)' }}>
                        {active && player.status === 'playing' ? <AudioLines className="h-4 w-4" /> : index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${active ? 'font-medium text-white' : 'text-white/78'}`}>{chapter.name}</span>
                        {chapter.disc > 1 && (
                          <span className="mt-0.5 block truncate text-[11px] text-white/32">第 {chapter.disc} 碟</span>
                        )}
                      </span>
                      {restricted && (
                        <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-[linear-gradient(135deg,#f7c948,#e8960c)] px-1.5 py-0.5 text-[10px] font-semibold text-[#3a2600]">
                          <Crown className="h-2.5 w-2.5" /> VIP
                        </span>
                      )}
                      {typeof chapter.duration === 'number' && (
                        <span className="shrink-0 text-xs tabular-nums text-white/34">{formatTime(chapter.duration)}</span>
                      )}
                    </button>
                  )
                })}
                {player.chapterHasMore && (
                  <div className="flex justify-center py-3">
                    <button
                      type="button"
                      disabled={player.chaptersLoading}
                      onClick={() => void kugouLongaudioStore.loadMoreChapters()}
                      className="flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.05] px-4 py-1.5 text-xs text-white/58 transition hover:bg-white/[0.1] hover:text-white disabled:cursor-wait disabled:opacity-50"
                    >
                      {player.chaptersLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      加载更多章节
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}

      {/* 底部：章节进度 + 播放控制 + 倍速（仅播放器视图） */}
      {view === 'player' && (
        <footer className="shrink-0 border-t border-white/[0.08] bg-black/45 px-4 py-3">
          {player.status === 'error' && player.error && (
            <div className="mb-2 flex items-center justify-center gap-2 rounded-lg bg-red-500/12 px-3 py-1.5 text-xs text-red-300">
              <AlertCircle className="h-3.5 w-3.5" /> {player.error}
              <button
                type="button"
                onClick={() => void kugouLongaudioStore.retryChapter()}
                className="ml-1 rounded-full border border-red-300/35 px-2 py-0.5 transition hover:bg-red-400/15"
              >
                重试
              </button>
            </div>
          )}
          <div className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-right text-xs tabular-nums text-white/45">{formatTime(player.currentTime)}</span>
            <div className="relative h-4 flex-1">
              <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 overflow-hidden rounded-full bg-white/[0.12]">
                <div className="h-full rounded-full" style={{ width: `${progress}%`, background: ACCENT }} />
              </div>
              <input
                type="range"
                min={0}
                max={duration > 0 ? duration : 100}
                step={1}
                value={Math.min(player.currentTime, duration > 0 ? duration : 100)}
                disabled={!current}
                onChange={event => kugouLongaudioStore.seek(Number(event.target.value))}
                className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent"
                style={{ accentColor: ACCENT }}
                aria-label="章节进度"
              />
            </div>
            <span className="w-12 shrink-0 text-xs tabular-nums text-white/45">{formatTime(duration)}</span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-white/62">
                {current ? current.name : '选择右侧章节开始收听'}
              </p>
              <p className="mt-0.5 text-[11px] text-white/30">
                {statusLabel}
                {current && current.disc > 1 ? ` · 第 ${current.disc} 碟` : ''}
                {' · 倍速与进度只作用于听书通道'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void kugouLongaudioStore.playPrev()}
                disabled={player.chapters.length === 0}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.05] text-white/70 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-35"
                aria-label="上一章"
              >
                <SkipBack className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void kugouLongaudioStore.togglePlay()}
                disabled={player.chapters.length === 0}
                className="flex h-11 w-11 items-center justify-center rounded-full text-[#081017] shadow-lg transition hover:brightness-110 disabled:opacity-35"
                style={{ background: ACCENT }}
                aria-label={player.status === 'playing' ? '暂停' : '播放'}
              >
                {player.status === 'loading'
                  ? <Loader2 className="h-5 w-5 animate-spin" />
                  : player.status === 'playing' ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
              </button>
              <button
                type="button"
                onClick={() => void kugouLongaudioStore.playNext()}
                disabled={player.chapters.length === 0}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.05] text-white/70 transition hover:bg-white/[0.12] hover:text-white disabled:opacity-35"
                aria-label="下一章"
              >
                <SkipForward className="h-4 w-4" />
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <span className="text-[11px] text-white/34">倍速</span>
              {LONGAUDIO_RATE_STEPS.map(rate => {
                const active = Math.abs(player.rate - rate) < 0.001
                return (
                  <button
                    key={rate}
                    type="button"
                    onClick={() => kugouLongaudioStore.setRate(rate)}
                    className="rounded-full border px-2 py-1 text-[11px] tabular-nums transition"
                    style={active
                      ? { background: ACCENT, borderColor: ACCENT, color: '#081017', fontWeight: 600 }
                      : { borderColor: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.55)' }}
                  >
                    {rate}x
                  </button>
                )
              })}
            </div>
          </div>
        </footer>
      )}
    </motion.div>,
    document.body,
  )
}
