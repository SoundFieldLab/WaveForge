import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ListMusic, MoreHorizontal, Pause, Play, SlidersHorizontal } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import CachedImage from '../../components/CachedImage'

export type QQRadarContinuation = {
  mode: 'radar'
  page: number
  reqType: number
  entranceSongs: number[]
}

type QQRadarPlayerProps = {
  songs: Song[]
  initialIndex?: number
  continuation: QQRadarContinuation
  playing: boolean
  onClose: () => void
  onPlaySong: (song: Song, songs: Song[], continuation: QQRadarContinuation) => void
  onRequestMore: (continuation: QQRadarContinuation) => Promise<{ songs: Song[]; page: number; hasMore?: boolean }>
  onTogglePlay: () => void
}

const SWIPE_THRESHOLD = 72

function songKey(song: Song) {
  return String(song.mid || song.id || `${song.name}:${song.artists.map(artist => artist.name).join('/')}`)
}

export default function QQRadarPlayer({ songs: initialSongs, initialIndex = 0, continuation: initialContinuation, playing, onClose, onPlaySong, onRequestMore, onTogglePlay }: QQRadarPlayerProps) {
  const [songs, setSongs] = useState(initialSongs)
  const [index, setIndex] = useState(Math.min(Math.max(initialIndex, 0), Math.max(0, initialSongs.length - 1)))
  const [continuation, setContinuation] = useState(initialContinuation)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState('')
  const pointerRef = useRef<{ id: number; startY: number; moved: boolean } | null>(null)
  const requestRef = useRef(false)
  const songsRef = useRef(songs)
  songsRef.current = songs

  const current = songs[index]
  const moveTo = (nextIndex: number) => {
    if (!songs[nextIndex]) return
    setIndex(nextIndex)
    setError('')
    onPlaySong(songs[nextIndex], songs, continuation)
  }

  useEffect(() => {
    if (index < songs.length - 5 || loadingMore || !continuation || !hasMore) return
    if (requestRef.current) return
    requestRef.current = true
    setLoadingMore(true)
    void onRequestMore(continuation).then(result => {
      const seen = new Set(songsRef.current.map(songKey))
      const additions = result.songs.filter(song => {
        const key = songKey(song)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (additions.length) {
        setSongs(previous => [...previous, ...additions])
        setContinuation(previous => ({ ...previous, page: result.page }))
      } else {
        setHasMore(false)
      }
      if (result.hasMore === false) setHasMore(false)
    }).catch(errorValue => {
      setError(errorValue instanceof Error ? errorValue.message : '刷歌下一批加载失败')
    }).finally(() => {
      requestRef.current = false
      setLoadingMore(false)
    })
  }, [continuation, hasMore, index, loadingMore, onRequestMore])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerRef.current = { id: event.pointerId, startY: event.clientY, moved: false }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = pointerRef.current
    pointerRef.current = null
    if (!pointer || pointer.id !== event.pointerId) return
    const distance = event.clientY - pointer.startY
    if (Math.abs(distance) < SWIPE_THRESHOLD) return
    if (distance < 0) moveTo(index + 1)
    else moveTo(index - 1)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  if (!current) return null
  const artist = current.artists.map(item => item.name).join(' / ')
  return (
    <div className="fixed inset-0 z-[320] flex min-h-screen flex-col overflow-hidden bg-[#111419] text-white" role="dialog" aria-modal="true" aria-label="QQ 刷歌模式">
      <div className="absolute inset-0 bg-black/35" />
      <div className="relative z-10 flex items-center justify-between px-6 py-5">
        <button type="button" onClick={onClose} aria-label="退出刷歌模式" className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.08] hover:bg-white/[0.15]"><ChevronDown className="h-6 w-6" /></button>
        <div className="flex items-center gap-2"><button type="button" aria-label="刷歌偏好" className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.08]"><SlidersHorizontal className="h-5 w-5" /></button><button type="button" aria-label="刷歌更多操作" className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.08]"><MoreHorizontal className="h-5 w-5" /></button></div>
      </div>
      <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-6" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={event => { pointerRef.current = null; event.currentTarget.releasePointerCapture?.(event.pointerId) }}>
        <div className="w-full max-w-[720px] select-none text-center">
          <div className="mx-auto aspect-square w-[min(78vw,620px)] overflow-hidden rounded-xl shadow-2xl shadow-black/50"><CachedImage src={current.album.picUrl} alt="" className="h-full w-full object-cover" role="hero" priority="critical" lazy={false} platform="qq" retainPrevious /></div>
          <div className="mt-7 text-left"><div className="truncate text-3xl font-semibold">{current.name}</div><div className="mt-2 truncate text-lg text-white/60">{artist}</div></div>
          <div className="mt-5 flex items-center justify-between text-sm text-white/45"><span>{index + 1} / {songs.length}</span>{loadingMore && <span>正在准备下一批</span>}{error && <span className="text-rose-200/80">{error}</span>}</div>
        </div>
      </div>
      <div className="relative z-10 flex items-center justify-center gap-10 px-6 pb-10"><button type="button" aria-label="上一曲" onClick={() => moveTo(index - 1)} disabled={index <= 0} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.08] disabled:opacity-30"><ChevronLeft className="h-7 w-7" /></button><button type="button" aria-label={playing ? '暂停' : '播放'} onClick={onTogglePlay} className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-black shadow-xl">{playing ? <Pause className="h-8 w-8 fill-current" /> : <Play className="h-8 w-8 fill-current" />}</button><button type="button" aria-label="下一曲" onClick={() => moveTo(index + 1)} disabled={index >= songs.length - 1} className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.08] disabled:opacity-30"><ChevronRight className="h-7 w-7" /></button><button type="button" aria-label="歌曲队列" className="flex h-14 w-14 items-center justify-center rounded-full bg-white/[0.08]"><ListMusic className="h-6 w-6" /></button></div>
    </div>
  )
}
