/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 酷狗「刷歌」全屏竖滑页（3.E）：与 QQ 刷歌同粒度（QQRadarPlayer）但**不共用组件与状态**——
 * 自己一套 store/手势/渲染，数据走 /youth/v3/user/get_dynamic，播放交给主播放器。
 *
 * 上游实测本账号动态恒为空（is_end=1），所以空态是一等公民：
 * 空流显示「当前账号暂无动态」+ 刷新 + 最近动态；卡片字段识别不出时原样展示 raw，不静默丢。
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AlertCircle, ChevronDown, ChevronLeft, ChevronRight, Loader2, Music2, Pause, Play, RefreshCw } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import CachedImage from '../../components/CachedImage'
import { kugouYouthStore, selectYouthSongs, type KugouYouthState } from './store'

/** 与 QQRadarPlayer 相同的滑动阈值语义：小于阈值不切歌，避免误触 */
const SWIPE_THRESHOLD = 72

export interface KugouYouthFeedOverlayProps {
  playing: boolean
  onTogglePlay: () => void
  /** 起播：卡片曲目 → 主播放器队列（continuous=true 让播放引擎按探索/传统模式续取） */
  onPlaySongs: (song: Song, songs: Song[], continuous?: boolean) => void
  /** 卡片右键：复用宿主页的歌曲菜单（酷狗下不提供音乐偏好入口） */
  onSongContextMenu?: (event: React.MouseEvent, song: Song, songs: Song[]) => void
}

/** raw 摘要：字段未识别时给用户看的原样内容（截断，避免超长 JSON 撑爆卡片） */
function rawSummary(raw: unknown): string {
  try {
    const text = JSON.stringify(raw)
    if (!text) return ''
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return ''
  }
}

export default function KugouYouthFeedOverlay({ playing, onTogglePlay, onPlaySongs, onSongContextMenu }: KugouYouthFeedOverlayProps) {
  const [state, setState] = useState<KugouYouthState>(() => kugouYouthStore.getState())
  const pointerRef = useRef<{ id: number; startY: number } | null>(null)
  const lastPlayedRef = useRef('')

  useEffect(() => kugouYouthStore.subscribe(() => setState(kugouYouthStore.getState())), [])

  const { open, cards, index, loading, loadingMore, error, empty, recentCards } = state
  const songs = useMemo(() => selectYouthSongs(cards), [cards])
  const current = index >= 0 ? cards[index] : undefined
  const currentSong = current?.song || null

  // 打开 / 切卡时起播当前曲目（与 QQRadarPlayer 的 moveTo→onPlaySong 同语义，播放交给主播放器）
  useEffect(() => {
    if (!open) { lastPlayedRef.current = ''; return }
    const card = cards[index]
    if (!card?.song) return
    const key = `${index}:${card.song.mid || card.song.id}`
    if (lastPlayedRef.current === key) return
    lastPlayedRef.current = key
    onPlaySongs(card.song, songs, true)
  }, [open, index, cards, songs, onPlaySongs])

  // 滑到末尾附近自动续取（is_end / 无 last_cid 时 store 内部直接返回）
  useEffect(() => {
    if (!open || loading || loadingMore) return
    if (index >= cards.length - 3) void kugouYouthStore.loadMore()
  }, [open, index, cards.length, loading, loadingMore])

  // 键盘上下切歌 / Esc 退出：桌面端刷歌的主要操作方式之一
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') kugouYouthStore.close()
      if (event.key === 'ArrowDown' && index < cards.length - 1) kugouYouthStore.select(index + 1)
      if (event.key === 'ArrowUp' && index > 0) kugouYouthStore.select(index - 1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, index, cards.length])

  if (!open) return null

  const moveTo = (next: number) => {
    if (next < 0 || next >= cards.length) return
    kugouYouthStore.select(next)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerRef.current = { id: event.pointerId, startY: event.clientY }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current
    pointerRef.current = null
    if (!pointer || pointer.id !== event.pointerId) return
    const distance = event.clientY - pointer.startY
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    if (Math.abs(distance) < SWIPE_THRESHOLD) return
    moveTo(distance < 0 ? index + 1 : index - 1)
  }

  const artist = currentSong?.artists.map(item => item.name).join(' / ') || current?.artist || ''

  return (
    <div
      className="fixed inset-0 z-[320] flex min-h-screen flex-col overflow-hidden bg-[#12100d] text-white"
      role="dialog"
      aria-modal="true"
      aria-label="酷狗刷歌"
      data-kugou-youth="overlay"
      onContextMenu={event => {
        if (!onSongContextMenu || !currentSong) return
        event.preventDefault()
        onSongContextMenu(event, currentSong, songs)
      }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_0%,rgba(255,122,0,0.18),transparent_60%)]" />
      <div className="relative z-10 flex items-center justify-between px-6 py-5">
        <button
          type="button"
          onClick={() => kugouYouthStore.close()}
          aria-label="退出刷歌模式"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.08] hover:bg-white/[0.15]"
        >
          <ChevronDown className="h-6 w-6" />
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void kugouYouthStore.refresh()}
            aria-label="刷新刷歌动态"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.08] hover:bg-white/[0.15]"
          >
            <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div
        className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-6"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={event => { pointerRef.current = null; event.currentTarget.releasePointerCapture?.(event.pointerId) }}
      >
        {loading ? (
          <div className="flex flex-col items-center gap-3 text-white/60">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">正在加载刷歌动态…</p>
          </div>
        ) : error ? (
          <div className="w-full max-w-[560px] rounded-2xl border border-rose-300/20 bg-rose-500/[0.08] px-6 py-8 text-center">
            <AlertCircle className="mx-auto mb-3 h-7 w-7 text-rose-200/80" />
            <p className="text-sm text-rose-100/90">{error}</p>
            <button
              type="button"
              onClick={() => void kugouYouthStore.refresh()}
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
            >
              <RefreshCw className="h-4 w-4" /> 重试
            </button>
          </div>
        ) : empty || !current ? (
          <div className="w-full max-w-[620px] text-center">
            <Music2 className="mx-auto mb-4 h-10 w-10 text-white/25" />
            <p className="text-lg font-medium text-white/80">当前账号暂无动态</p>
            <p className="mx-auto mt-2 max-w-[440px] text-sm leading-relaxed text-white/45">
              酷狗 concept /youth/v3/user/get_dynamic 对当前账号返回空列表（is_end=1），
              刷歌卡片暂无可展示内容；换账号或稍后再试，也可以先看下面的最近动态。
            </p>
            <button
              type="button"
              onClick={() => void kugouYouthStore.refresh()}
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> 刷新
            </button>
            {recentCards.length > 0 && (
              <div className="mt-8 text-left">
                <p className="mb-3 text-sm text-white/60">最近刷到</p>
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {recentCards.slice(0, 8).map((card, cardIndex) => (
                    <button
                      key={`${cardIndex}-${card.title || 'card'}`}
                      type="button"
                      onClick={() => { if (card.song) onPlaySongs(card.song, selectYouthSongs(recentCards), true) }}
                      className="w-24 shrink-0 text-left"
                    >
                      <span className="block h-24 w-24 overflow-hidden rounded-xl bg-white/5">
                        {card.coverUrl ? (
                          <CachedImage src={card.coverUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center"><Music2 className="h-5 w-5 text-white/30" /></span>
                        )}
                      </span>
                      <span className="mt-1.5 block truncate text-xs text-white/70">{card.title || '未识别卡片'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="w-full max-w-[720px] select-none text-center">
            <div className="mx-auto flex aspect-square w-[min(78vw,560px)] items-center justify-center overflow-hidden rounded-2xl bg-white/[0.04] shadow-2xl shadow-black/50">
              {current.coverUrl ? (
                <CachedImage src={current.coverUrl} alt="" className="h-full w-full object-cover" role="hero" priority="critical" lazy={false} platform="kugou" retainPrevious />
              ) : (
                <Music2 className="h-14 w-14 text-white/25" />
              )}
            </div>
            <div className="mt-6 text-left">
              <div className="truncate text-3xl font-semibold">{currentSong?.name || current.title || '未识别动态卡片'}</div>
              <div className="mt-2 truncate text-lg text-white/60">{artist}</div>
              {!currentSong && (
                <div className="mt-3 rounded-xl border border-amber-200/15 bg-amber-300/[0.06] px-3 py-2">
                  <p className="text-xs text-amber-100/80">该动态卡片未识别出曲目字段，已按原始数据透传（不猜测播放）：</p>
                  <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-white/45">{rawSummary(current.raw) || '（空对象）'}</p>
                </div>
              )}
            </div>
            <div className="mt-5 flex items-center justify-between text-sm text-white/45">
              <span>{index + 1} / {cards.length}</span>
              {loadingMore && <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在准备下一批</span>}
            </div>
          </div>
        )}
      </div>

      {!error && !empty && current && (
        <div className="relative z-10 flex items-center justify-center gap-8 px-6 pb-10">
          <button type="button" aria-label="上一曲" onClick={() => moveTo(index - 1)} disabled={index <= 0} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.08] disabled:opacity-30">
            <ChevronLeft className="h-7 w-7" />
          </button>
          <button type="button" aria-label={playing ? '暂停' : '播放'} onClick={onTogglePlay} className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-black shadow-xl">
            {playing ? <Pause className="h-8 w-8 fill-current" /> : <Play className="h-8 w-8 fill-current" />}
          </button>
          <button type="button" aria-label="下一曲" onClick={() => moveTo(index + 1)} disabled={index >= cards.length - 1} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.08] disabled:opacity-30">
            <ChevronRight className="h-7 w-7" />
          </button>
        </div>
      )}
    </div>
  )
}
