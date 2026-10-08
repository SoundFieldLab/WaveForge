import { memo, useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import { motion } from 'framer-motion'
import { X, Music, Play, ListPlus } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getSimilarSongs, getProxiedImageUrl } from '../services/musicApi'
import { platformLabel } from '../services/platforms'
import { createTtlCache } from '../utils/ttlCache'
import { useTvBack } from '../tv/tvCore'
import { createPortal } from 'react-dom'
import SongContextMenu, { type SongMenuBindings } from './SongContextMenu'

// 相似歌曲短 TTL 缓存：同一首歌反复开关面板不再重发请求 / 重放加载态。
// 空结果与错误不入缓存（否则「确实没有」会被钉死）。仅内存、不落盘；登录态变化时清空。
const similarSongsCache = createTtlCache<Song[]>({ ttlMs: 5 * 60 * 1000, maxEntries: 30 })
if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', () => similarSongsCache.clear())
}
const similarCacheKey = (song: Song) => `${song.platform || 'netease'}:${song.mid ?? song.id}`

/**
 * 相似歌曲响应归一化（QQ/网易云两种包装 → Song[]）。
 * 响应形状按平台不同：网易云 `{ songs: [...] }`；QQ `{ result, data: [...] }`（data 直接是
 * 数组，实测 387433441 返回数组——App 的快捷「切到相似歌曲」曾因直接 `.find` 整个响应
 * 崩溃 `V.find is not a function`）。面板与快捷切歌共用此解析，避免两处形状漂移。
 */
export function extractSimilarSongItems(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return []
  const raw = data as { songs?: unknown; data?: unknown }
  if (Array.isArray(raw.songs)) return raw.songs
  if (Array.isArray(data)) return data
  const inner = raw.data as { list?: unknown; songs?: unknown } | unknown[] | undefined
  if (Array.isArray(inner)) return inner
  if (inner && typeof inner === 'object') {
    if (Array.isArray((inner as { list?: unknown }).list)) return (inner as { list: unknown[] }).list
    if (Array.isArray((inner as { songs?: unknown }).songs)) return (inner as { songs: unknown[] }).songs
  }
  return []
}

export function normalizeSimilarSongItems(raw: unknown[], platform: string): Song[] {
  return raw.map((entry: any) => {
    const track = entry?.songInfo || entry?.song || entry || {}
    const albumPic = track.album?.picUrl || track.album?.picurl || track.album?.cover || track.album?.coverUrl
      || entry?.album?.picUrl || entry?.album?.picurl
      || track.picUrl || track.picurl || track.albumpic
      || ''
    const albumMid = track.album?.mid || track.albummid || entry?.album?.mid || ''
    const coverUrl = albumPic || (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid.replace(/_\d+$/, '')}.jpg` : '')
    return {
      id: track.id || entry?.id || 0,
      mid: track.mid || entry?.mid,
      name: track.name || track.title || track.songname || entry?.name || '',
      artists: Array.isArray(track.singer || track.artists || entry?.artists)
        ? (track.singer || track.artists || entry?.artists).map((a: any) => ({ name: a.name || a.title || '' }))
        : [],
      album: { picUrl: coverUrl },
      duration: (track.interval || track.dt || 0) * 1000 || track.duration || entry?.dt || 0,
      platform
    } as Song
  })
}

interface SimilarSongsPanelProps {
  song: Song
  /** 右键菜单回调包（与播放页同一套）。2026-09-27 审计 C4：相似歌曲行原本只有两个按钮。 */
  songMenu?: SongMenuBindings
  onClose: () => void
  onPlayNow?: (song: Song) => void
  onPlayNext?: (song: Song) => void
  playerTheme: 'dark' | 'light'
  /** 冻结：由 App 保持挂载但当前不可见（关闭弹窗）。隐藏时不可聚焦、不可点击。 */
  suspended?: boolean
}

function SimilarSongsPanel({ song, onClose, onPlayNow, onPlayNext, playerTheme, suspended = false, songMenu }: SimilarSongsPanelProps) {
  // TV 遥控器 BACK：关闭相似歌曲面板（冻结隐藏时不消费返回键，交给上层）
  useTvBack(() => {
    if (suspended) return false
    onClose()
    return true
  }, [onClose, suspended])
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const cachedInitialSongs = similarSongsCache.get(similarCacheKey(song))
  const [songs, setSongs] = useState<Song[]>(() => cachedInitialSongs || [])
  const [loading, setLoading] = useState(() => !cachedInitialSongs?.length)
  // 行右键菜单（回调包放 ref 保持 openMenu 稳定）
  const [menu, setMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>(
    { show: false, x: 0, y: 0, song: null })
  const songMenuRef = useRef(songMenu)
  songMenuRef.current = songMenu
  const openMenu = useCallback((event: MouseEvent, target: Song) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ show: true, x: event.clientX, y: event.clientY, song: target })
  }, [])
  const closeMenu = useCallback(() => setMenu(previous => ({ ...previous, show: false })), [])

  useEffect(() => {
    const handleAccent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setAccentColor(detail)
    }
    window.addEventListener('accentColorChanged', handleAccent)
    return () => window.removeEventListener('accentColorChanged', handleAccent)
  }, [])

  useEffect(() => {
    let cancelled = false
    // 命中缓存：直接展示，不发请求、不转圈。
    const cacheKey = similarCacheKey(song)
    const cached = similarSongsCache.get(cacheKey)
    if (cached?.length) {
      setSongs(cached)
      setLoading(false)
      return () => { cancelled = true }
    }
    const fetchSimilar = async () => {
      // Apple 无相似歌曲接口（入口已按能力表隐藏，此处兜底）
      if (song.platform === 'apple') return
      // 汽水：无相似歌曲接口，用「同歌手热门 + 每日推荐」组合做相关探索
      if (song.platform === 'soda') {
        const fetchSimilarSoda = async () => {
          try {
            const soda = await import('../services/sodaService')
            const artistName = song.artists?.[0]?.name || ''
            const [artistSongs, daily] = await Promise.all([
              artistName ? soda.fetchSodaArtistSongs(artistName, 20) : Promise.resolve([] as Song[]),
              soda.fetchSodaDaily().catch(() => ({ songs: [] as Song[], personalized: false })),
            ])
            const seen = new Set([String(song.mid || song.id)])
            const merged: Song[] = []
            for (const candidate of [...artistSongs, ...daily.songs]) {
              const key = String(candidate.mid || candidate.id)
              if (!key || seen.has(key)) continue
              seen.add(key)
              merged.push(candidate)
              if (merged.length >= 30) break
            }
            if (!cancelled && merged.length) { setSongs(merged); similarSongsCache.set(cacheKey, merged) }
          } catch { /* ignore */ }
          if (!cancelled) setLoading(false)
        }
        void fetchSimilarSoda()
        return
      }
      // 酷狗：官方客户端的「相似歌曲」本身就是弹窗列表——直接走客户端同源接口
      // （标准版 /v3/album_audio/related，入参是 mixsongid）。此前用「同歌手热门 + TOP500」
      // 拼凑，既不是官方相似度、也不是客户端行为。
      if (song.platform === 'kugou') {
        const fetchSimilarKugou = async () => {
          try {
            const kugou = await import('../services/kugouService')
            const tracks = await kugou.fetchKugouSimilarSongs(song as { kugouMixSongId?: number }, { pagesize: 30 })
            const merged = tracks.map(kugou.kugouTrackToSong)
              .filter(candidate => String(candidate.mid || candidate.id) !== String(song.mid || song.id))
            if (!cancelled && merged.length) { setSongs(merged); similarSongsCache.set(cacheKey, merged) }
          } catch { /* ignore */ }
          if (!cancelled) setLoading(false)
        }
        void fetchSimilarKugou()
        return
      }
      try {
        const id = song.platform === 'qq' ? String(song.id || song.mid) : String(song.id)
        const data = await getSimilarSongs(id, (song.platform || 'netease') as 'netease' | 'qq')
        if (!cancelled && data) {
          const normalized = normalizeSimilarSongItems(extractSimilarSongItems(data), song.platform || 'netease')
          if (!cancelled) { setSongs(normalized); if (normalized.length) similarSongsCache.set(cacheKey, normalized) }
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false)
    }
    fetchSimilar()
    return () => { cancelled = true }
  }, [song])

  if (suspended) return null

  return (
    <motion.div
      data-tv-scope
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[85] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.94, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0, y: 12 }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden rounded-3xl shadow-2xl relative"
      >
        {/* 液态玻璃背景 - 使用歌曲封面 */}
        <div className="absolute inset-0 rounded-3xl overflow-hidden">
          {song.album?.picUrl && (
            <div
              className="absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: `url(${getProxiedImageUrl(song.album.picUrl)})`, filter: 'blur(40px) brightness(0.6)' }}
            />
          )}
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.5) 50%, rgba(0,0,0,0.4) 100%)',
              backdropFilter: 'blur(80px) saturate(200%)',
              WebkitBackdropFilter: 'blur(80px) saturate(200%)',
            }}
          />
          <div
            className="absolute inset-0 rounded-3xl"
            style={{ border: '1px solid rgba(255,255,255,0.2)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15)', pointerEvents: 'none' }}
          />
        </div>

        <div className="relative z-10 flex flex-col h-full min-h-0">
          {/* 头部横向：歌曲信息 */}
          <div className="p-5 border-b flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accentColor}26`, color: accentColor }}>
                  <Music className="w-4.5 h-4.5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white">相似歌曲</h2>
                  {/* 平台署名按歌曲实际平台走：以前只有 QQ/网易云两分支，酷狗会被错标成网易云 */}
                  <div className="text-white/50 text-[11px] -mt-0.5">{platformLabel(song.platform || 'netease')}</div>
                </div>
              </div>
              <button onClick={onClose} className="p-2 rounded-full transition-colors hover:bg-white/15">
                <X className="w-5 h-5 text-white/60" />
              </button>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0" style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)' }}>
                {song.album?.picUrl ? <img src={getProxiedImageUrl(song.album.picUrl, 100)} alt={song.name} className="w-full h-full object-cover" /> : <Music className="w-5 h-5 m-auto mt-3.5 text-white/30" />}
              </div>
              <div className="min-w-0">
                <p className="text-white text-sm font-medium truncate">{song.name}</p>
                <p className="text-white/50 text-xs truncate">{(song.artists || []).map(a => a.name).join(' / ')}</p>
              </div>
            </div>
          </div>

          {/* 相似歌曲列表 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {loading ? (
              <div className="text-center py-10 text-white/60 text-sm">加载中...</div>
            ) : songs.length === 0 ? (
              <div className="text-center py-10 text-white/50 text-sm">暂无相似歌曲</div>
            ) : (
              songs.map((s, i) => (
                <div
                  key={s.mid || s.id || i}
                  onContextMenu={songMenuRef.current ? event => openMenu(event, s) : undefined}
                  className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-white/5 transition-colors group"
                >
                  <span className="w-5 text-center text-xs text-white/35">{i + 1}</span>
                  <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
                    {s.album?.picUrl ? <img src={getProxiedImageUrl(s.album.picUrl, 100)} alt="" className="w-full h-full object-cover" /> : <Music className="w-5 h-5 m-auto text-white/40" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate text-white">{s.name}</p>
                    <p className="text-xs truncate text-white/60">{Array.isArray(s.artists) ? s.artists.map(a => a.name).join(' / ') : ''}</p>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {onPlayNext && <button onClick={() => { onPlayNext(s); onClose() }} className="p-2 rounded-full hover:bg-white/10 transition-colors" title="下一首播放"><ListPlus className="w-4 h-4 text-white/60" /></button>}
                    {onPlayNow && <button onClick={() => { onPlayNow(s); onClose() }} className="p-2 rounded-full hover:bg-white/10 transition-colors" title="立即播放"><Play className="w-4 h-4 text-white/60" fill="currentColor" /></button>}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </motion.div>
      {/* portal 到 body：菜单必须落在背景层（onClick=onClose）的 DOM 子树之外，
          否则点菜单项会冒泡触发关闭整个面板（复查 2026-09-27） */}
      {songMenuRef.current && typeof document !== 'undefined' && createPortal(
        <SongContextMenu
          show={menu.show}
          x={menu.x}
          y={menu.y}
          song={menu.song}
          onClose={closeMenu}
          {...songMenuRef.current}
          platform={menu.song?.platform || song.platform || 'netease'}
          playerTheme={playerTheme}
        />,
        document.body,
      )}
    </motion.div>
  )
}

// 弹窗在 App 全局挂载点常驻渲染，播放中 App 约 1Hz 重渲染时 props 稳定则跳过整棵弹窗子树重渲染
export default memo(SimilarSongsPanel)