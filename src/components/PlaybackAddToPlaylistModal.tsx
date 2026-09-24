import { AnimatePresence, motion } from 'framer-motion'
import { useTvBack } from '../tv/tvCore'
import { Check, ListMusic, LoaderCircle, Music2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Song } from '../services/musicApi'
import { getProxiedImageUrl } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { platformLabel } from '../services/platforms'
import { getAddablePlaylists, getPlaylistMutationId } from '../services/addablePlaylists'
import type { PlaylistOwnershipContext } from '../services/playlistOwnership'
import CachedImage from './CachedImage'

interface Props {
  show: boolean
  song: Song
  playlists: any[]
  loading: boolean
  accentColor: string
  playerTheme?: 'light' | 'dark'
  onClose: () => void
  onAdd: (song: Song, playlistId: string) => void
}

function getOwners(): PlaylistOwnershipContext {
  return {
    neteaseUserId: localStorage.getItem('netease_user_id') || undefined,
    qqUserId: localStorage.getItem('qq_user_id') || undefined,
    spotifyUserId: localStorage.getItem('spotify_user_id') || undefined,
    kugouUserId: localStorage.getItem('kugou_user_id') || undefined,
    sodaUserId: localStorage.getItem('soda_user_id') || undefined,
  }
}

export default function PlaybackAddToPlaylistModal({ show, song, playlists, loading, accentColor, playerTheme = 'dark', onClose, onAdd }: Props) {
  // TV 遥控：BACK 关闭本弹窗
  useTvBack(() => {
    if (!show) return false
    onClose()
    return true
  }, [show, onClose])
  const [addingId, setAddingId] = useState<string | null>(null)
  const platform = (song.platform || 'netease') as MusicPlatform
  const isDark = playerTheme === 'dark'
  const addable = useMemo(() => getAddablePlaylists(playlists, platform, getOwners()), [playlists, platform])

  useEffect(() => {
    if (!show) setAddingId(null)
  }, [show])

  return (
    <AnimatePresence>
      {show && (
        <motion.div data-playback-radial-block="true" className="fixed inset-0 z-[10035] flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <button type="button" aria-label="关闭添加到歌单" className="absolute inset-0 bg-black/55 backdrop-blur-md" onClick={onClose} />
          <motion.div role="dialog" aria-modal="true" aria-label="添加到歌单" className={`relative flex max-h-[72vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border shadow-2xl ${isDark ? 'border-white/15 bg-slate-950/95 text-white' : 'border-black/10 bg-white/95 text-black'}`} initial={{ y: 18, scale: 0.96 }} animate={{ y: 0, scale: 1 }} exit={{ y: 18, scale: 0.96 }}>
            <header className={`flex items-center gap-3 border-b p-4 ${isDark ? 'border-white/10' : 'border-black/10'}`}>
              <div className="h-12 w-12 overflow-hidden rounded-lg bg-black/10">
                {song.album?.picUrl ? <CachedImage src={getProxiedImageUrl(song.album.picUrl, 96)} alt="" className="h-full w-full object-cover" /> : <Music2 className="m-3 h-6 w-6 opacity-45" />}
              </div>
              <div className="min-w-0 flex-1"><h2 className="font-semibold">添加到歌单</h2><p className={`truncate text-xs ${isDark ? 'text-white/50' : 'text-black/50'}`}>{song.name} · {platformLabel(platform)}</p></div>
              <button type="button" aria-label="关闭" onClick={onClose} className="rounded-lg p-2 transition hover:bg-black/10"><X className="h-5 w-5" /></button>
            </header>
            <div className="overflow-y-auto p-3">
              {loading ? (
                <div className="flex h-36 flex-col items-center justify-center gap-2 opacity-55"><LoaderCircle className="h-6 w-6 animate-spin" style={{ color: accentColor }} /><span className="text-sm">正在加载可加入的歌单</span></div>
              ) : addable.length === 0 ? (
                <div className="flex h-36 flex-col items-center justify-center gap-2 text-center opacity-55"><ListMusic className="h-7 w-7" /><span className="text-sm">没有可加入的自建歌单</span><span className="text-xs">收藏、喜欢和虚拟歌单不会显示</span></div>
              ) : addable.map(playlist => {
                const id = getPlaylistMutationId(playlist)
                const adding = addingId === id
                return <button key={id} type="button" disabled={addingId !== null} onClick={() => { setAddingId(id); onAdd(song, id); window.setTimeout(onClose, 180) }} className={`flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'} disabled:opacity-55`}>
                  <div className={`h-11 w-11 overflow-hidden rounded-lg ${isDark ? 'bg-white/10' : 'bg-black/5'}`}>{playlist.coverImgUrl ? <CachedImage src={getProxiedImageUrl(playlist.coverImgUrl, 88)} alt="" className="h-full w-full object-cover" /> : <ListMusic className="m-3 h-5 w-5 opacity-45" />}</div>
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{playlist.name || '未命名歌单'}</div><div className={`mt-0.5 text-xs ${isDark ? 'text-white/45' : 'text-black/45'}`}>{Number(playlist.trackCount || 0)} 首歌曲</div></div>
                  {adding ? <LoaderCircle className="h-4 w-4 animate-spin" style={{ color: accentColor }} /> : <Check className="h-4 w-4 opacity-0" />}
                </button>
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
