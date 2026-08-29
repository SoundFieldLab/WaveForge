import { memo, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Music, Play, ListPlus } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getSimilarSongs, getProxiedImageUrl } from '../services/musicApi'
import SongContextMenu from './SongContextMenu'
import { useTvBack } from '../tv/tvCore'

interface SimilarSongsPanelProps {
  song: Song
  onClose: () => void
  onPlayNow?: (song: Song) => void
  onPlayNext?: (song: Song) => void
  playerTheme: 'dark' | 'light'
}

function SimilarSongsPanel({ song, onClose, onPlayNow, onPlayNext, playerTheme }: SimilarSongsPanelProps) {
  // TV 遥控器 BACK：关闭相似歌曲面板
  useTvBack(() => {
    onClose()
    return true
  }, [onClose])
  const dark = playerTheme === 'dark'
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(true)
  const [contextMenu, setContextMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({ show: false, x: 0, y: 0, song: null })
  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/60' : 'text-black/60'

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
            if (!cancelled && merged.length) setSongs(merged)
          } catch { /* ignore */ }
          if (!cancelled) setLoading(false)
        }
        void fetchSimilarSoda()
        return
      }
      // 酷狗：无相似歌曲接口，用「同歌手热门 + TOP500 榜单」组合做相关探索
      if (song.platform === 'kugou') {
        const fetchSimilarKugou = async () => {
          try {
            const kugou = await import('../services/kugouService')
            const singerId = String(song.artists?.[0]?.id || '')
            const [singerSongs, rankSongs] = await Promise.all([
              singerId ? kugou.fetchKugouSingerSongs(singerId, 1, 30) : Promise.resolve([] as any[]),
              kugou.fetchKugouRankInfo('8888', 30).catch(() => [] as any[]),
            ])
            const seen = new Set([String(song.mid || song.id)])
            const merged: Song[] = []
            for (const candidate of [...singerSongs.map(kugou.kugouTrackToSong), ...rankSongs.map(kugou.kugouTrackToSong)]) {
              const key = String(candidate.mid || candidate.id)
              if (!key || seen.has(key)) continue
              seen.add(key)
              merged.push(candidate)
              if (merged.length >= 30) break
            }
            if (!cancelled && merged.length) setSongs(merged)
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
          const raw = data.songs || data.data?.list || data.data?.songs || (Array.isArray(data.data) ? data.data : []) || []
          const normalized = raw.map((s: any) => {
            const track = s.songInfo || s.song || s
            const albumPic = track.album?.picUrl || track.album?.picurl || track.album?.cover || track.album?.coverUrl
              || s.album?.picUrl || s.album?.picurl
              || track.picUrl || track.picurl || track.albumpic
              || ''
            const albumMid = track.album?.mid || track.albummid || s.album?.mid || ''
            const coverUrl = albumPic || (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid.replace(/_\d+$/, '')}.jpg` : '')
            return {
              id: track.id || s.id || 0,
              mid: track.mid || s.mid,
              name: track.name || track.title || track.songname || s.name || '',
              artists: Array.isArray(track.singer || track.artists || s.artists)
                ? (track.singer || track.artists || s.artists).map((a: any) => ({ name: a.name || a.title || '' }))
                : [],
              album: { picUrl: coverUrl },
              duration: (track.interval || track.dt || 0) * 1000 || track.duration || s.dt || 0,
              platform: song.platform
            } as Song
          })
          if (!cancelled) setSongs(normalized)
        }
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false)
    }
    fetchSimilar()
    return () => { cancelled = true }
  }, [song])

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
                  <div className="text-white/50 text-[11px] -mt-0.5">{song.platform === 'qq' ? 'QQ音乐' : '网易云音乐'}</div>
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
                <div key={s.mid || s.id || i} className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-white/5 transition-colors group">
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
    </motion.div>
  )
}

// 弹窗在 App 全局挂载点常驻渲染，播放中 App 约 1Hz 重渲染时 props 稳定则跳过整棵弹窗子树重渲染
export default memo(SimilarSongsPanel)