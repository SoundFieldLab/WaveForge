// 传统模式音乐库：推荐歌曲 + 个性化推荐（不是用户歌单列表）。
// 用户歌单/收藏在左栏与个人中心管理；这里聚合每日推荐、私人电台、新歌与推荐歌单。
import { memo } from 'react'
import { Play, Sparkles } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getProxiedImageUrl } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { platformLabel } from '../services/platforms'
import type { ExplorePayload } from '../services/exploreApi'
import type { PlaybackOrigin } from '../types/playbackNavigation'

const songKey = (song: Song) => `${song.platform}:${song.id || song.mid || song.name}`
const coverOf = (song?: Song | null) => song?.album?.picUrl ? getProxiedImageUrl(song.album.picUrl) : ''

interface TraditionalLibraryProps {
  platform: MusicPlatform
  accent: string
  isDark: boolean
  loggedIn: boolean
  username: string
  loading: boolean
  payload: ExplorePayload | null
  recommendationSongs: Song[]
  onBack: () => void
  onSongSelect: (song: Song, songs: Song[], origin: PlaybackOrigin) => void
  onOpenPlaylist: (playlist: any) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
  userPlaylists?: any[]
}

function TraditionalLibrary({
  platform, accent, isDark, loggedIn, username, loading, payload, recommendationSongs, onSongSelect,
}: TraditionalLibraryProps) {
  const muted = isDark ? 'text-white/50' : 'text-slate-500'
  const surface = isDark ? 'bg-white/[0.055] border-white/10' : 'bg-white/75 border-black/10'
  // 音乐库 = 个性化（每日推荐 + 私人电台）；新歌/排行榜/推荐歌单属于「发现」
  const sections = [
    { key: 'daily', label: '每日推荐', songs: payload?.dailySongs || [] },
    { key: 'radio', label: '私人电台', songs: payload?.radioSongs || [] },
  ].filter(section => section.songs.length > 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-5 flex items-center gap-3">
        
        <div><h1 className="text-xl font-semibold">音乐库</h1><p className={`text-xs ${muted}`}>{platformLabel(platform)}{loggedIn && username ? ` · ${username}` : ''} · 个性化推荐</p></div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 个性化推荐横幅 */}
        <section className="relative mb-6 overflow-hidden rounded-3xl border p-6" style={{ borderColor: `${accent}55`, background: `linear-gradient(125deg, ${accent}28, rgba(255,255,255,.05))` }}>
          <div className="relative z-10 flex items-center justify-between gap-4">
            <div>
              <span className="rounded-full border px-2.5 py-1 text-[10px]" style={{ borderColor: `${accent}66`, color: accent }}>PERSONALIZED</span>
              <h2 className="mt-3 text-2xl font-semibold">{loggedIn ? `${username} 的专属音乐库` : '为你量身推荐'}</h2>
              <p className={`mt-2 max-w-md text-sm ${muted}`}>每日推荐、私人电台与最新发行，都为你整理在这里。</p>
              {recommendationSongs[0] && <button type="button" onClick={() => onSongSelect(recommendationSongs[0], recommendationSongs, { mode: 'traditional', surface: 'traditional-library', platform })} className="mt-4 flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white" style={{ background: accent }}><Play className="h-4 w-4 fill-current" />播放推荐</button>}
            </div>
            <div className="hidden items-center gap-3 sm:flex">
              {recommendationSongs.slice(0, 3).map((song, index) => (
                <img key={songKey(song)} src={coverOf(song)} alt="" className="h-20 w-20 rounded-2xl object-cover shadow-2xl" style={{ transform: `rotate(${(index - 1) * 6}deg)` }} />
              ))}
            </div>
          </div>
        </section>

        {loading ? (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4"><div className="h-44 animate-pulse rounded-2xl bg-white/10" /><div className="h-44 animate-pulse rounded-2xl bg-white/10" /><div className="h-44 animate-pulse rounded-2xl bg-white/10" /><div className="h-44 animate-pulse rounded-2xl bg-white/10" /></div>
          </div>
        ) : sections.length === 0 ? (
          <div className={`flex h-56 flex-col items-center justify-center gap-3 rounded-3xl border ${surface}`}>
            <Sparkles className="h-10 w-10 opacity-30" />
            <p className={`text-sm ${muted}`}>暂无推荐内容，稍后再来看看</p>
          </div>
        ) : (
          sections.map(section => (
            <section key={section.key} className="mb-7">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-semibold">{section.label}</h2>
                <span className={`text-xs ${muted}`}>{section.songs.length} 首</span>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {section.songs.slice(0, 8).map(song => (
                  <button
                    key={songKey(song)}
                    type="button"
                    onClick={() => onSongSelect(song, section.songs, { mode: 'traditional', surface: 'traditional-library', platform: song.platform || platform })}
                    className={`group overflow-hidden rounded-2xl border p-2 text-left transition hover:-translate-y-1 ${surface}`}
                  >
                    <div className="relative aspect-square overflow-hidden rounded-xl">
                      <img src={coverOf(song)} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
                      <span className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-900 opacity-0 shadow-lg transition group-hover:opacity-100"><Play className="h-4 w-4 fill-current" /></span>
                    </div>
                    <div className="mt-2 truncate text-sm">{song.name}</div>
                    <div className={`truncate text-xs ${muted}`}>{song.artists?.map(a => a.name).join(' / ')}</div>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

export default memo(TraditionalLibrary)
