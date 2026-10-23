// 传统模式 Spotify：官方「分类」页（浏览全部磁贴点击进入）。
// 顶部大标题（官方紫色渐变头图）+ 分类歌单网格（全部为官方真实歌单：fetchPlaylist 拉名/封面/描述）。
// 分类→官方歌单池映射（ID 全部经 fetchPlaylist 实测可用，2026-10-23）。
import { useEffect, useMemo, useState } from 'react'
import { Music2 } from 'lucide-react'
import { spotifyPcTheme } from './spotifyPcKit'
import { fetchPartnerPlaylistDetail } from '../../services/spotifyPartnerData'
import type { SpotifyPlaylist } from '../../services/spotifyService'

export interface SpotifyPcCategoryProps {
  tone: 'dark' | 'light'
  categoryTitle: string
  categoryBg: string
  categoryAccent: string
  active: boolean
  onOpenPlaylist: (playlistId: string) => void
}

/** 分类 → 官方歌单池（ID 实测可用） */
export const CATEGORY_PLAYLISTS: Record<string, Array<string>> = {
  '音乐': ['37i9dQZF1DXcBWIGoYBM5M', '37i9dQZF1DX0XUsuxWHRQd', '37i9dQZF1DX4JAvHpjipBk', '37i9dQZF1DX4dyzvuaRJ0n', '37i9dQZF1DWTwnEm1IYyoj'],
  '播客': ['37i9dQZF1DX4sWSpwq3LiO'],
  '为你打造': ['37i9dQZF1DXcBWIGoYBM5M', '37i9dQZF1DX0XUsuxWHRQd', '37i9dQZF1DX4JAvHpjipBk'],
  '新歌热播': ['37i9dQZF1DX4JAvHpjipBk', '37i9dQZF1DXcBWIGoYBM5M', '37i9dQZF1DX4dyzvuaRJ0n'],
  '日文歌曲': ['37i9dQZF1DXcBWIGoYBM5M', '37i9dQZF1DX4JAvHpjipBk'],
  '流行': ['37i9dQZF1DWTwnEm1IYyoj', '37i9dQZF1DX4dyzvuaRJ0n', '37i9dQZF1DXcBWIGoYBM5M'],
  '排行榜': ['37i9dQZF1DX0XUsuxWHRQd', '37i9dQZF1DXcBWIGoYBM5M'],
  '嘻哈': ['37i9dQZF1DX0XUsuxWHRQd', '37i9dQZF1DX10zKzsJ2jva'],
  'RADAR': ['37i9dQZF1DX4JAvHpjipBk', '37i9dQZF1DX4dyzvuaRJ0n'],
  '情绪': ['37i9dQZF1DX4sWSpwq3LiO', '37i9dQZF1DWTwnEm1IYyoj'],
  '发现': ['37i9dQZF1DX4JAvHpjipBk', '37i9dQZF1DX4dyzvuaRJ0n'],
  '拉丁': ['37i9dQZF1DX10zKzsJ2jva'],
  '摇滚': ['37i9dQZF1DWXRqgorJj26U'],
  '驾车': ['37i9dQZF1DWWMOmoXKqHTD'],
  '年代': ['37i9dQZF1DX4o1oenSJRJd'],
  '舞曲/电子': ['37i9dQZF1DX0XUsuxWHRQd', '37i9dQZF1DWTwnEm1IYyoj'],
}

export default function SpotifyPcCategory({ tone, categoryTitle, categoryBg, categoryAccent, active, onOpenPlaylist }: SpotifyPcCategoryProps) {
  const theme = useMemo(() => spotifyPcTheme(tone), [tone])
  const ids = CATEGORY_PLAYLISTS[categoryTitle] ?? CATEGORY_PLAYLISTS['音乐']
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      const results = await Promise.all(ids.map(id => fetchPartnerPlaylistDetail(id).catch(() => null)))
      if (cancelled) return
      setPlaylists(results.map(r => r?.playlist).filter((p): p is SpotifyPlaylist => Boolean(p)))
      setLoading(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryTitle])

  return (
    <div className="h-full overflow-y-auto" style={{ background: theme.background }} data-active={active}>
      {/* 官方分类头图（大色块 + 类目大字） */}
      <div className="flex h-64 items-end px-8 pb-8" style={{ background: `linear-gradient(180deg, ${categoryBg}, ${categoryBg}cc 55%, rgba(18,18,18,0)), linear-gradient(0deg, ${theme.background}, ${theme.background})` }}>
        <h1 className="text-6xl font-black text-white drop-shadow-lg">{categoryTitle}</h1>
      </div>
      <div className="px-8 pb-12">
        <h2 className="mb-5 mt-2 text-2xl font-bold" style={{ color: theme.text }}>歌单</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
          {playlists.map(p => (
            <button key={p.id} type="button" onClick={() => onOpenPlaylist(p.id)} className="group text-left">
              <span className="relative mb-3 block aspect-square w-full overflow-hidden rounded-md shadow-lg" style={{ background: theme.panel }}>
                {p.coverUrl
                  ? <img src={p.coverUrl} alt="" className="h-full w-full object-cover transition group-hover:brightness-110" />
                  : <span className="flex h-full w-full items-center justify-center"><Music2 className="h-10 w-10" style={{ color: theme.secondary }} /></span>}
                <span className="absolute bottom-2 right-2 flex h-12 w-12 translate-y-2 items-center justify-center rounded-full opacity-0 shadow-xl transition-all group-hover:translate-y-0 group-hover:opacity-100"
                  style={{ background: theme.accent }}>
                  <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="#000"><path d="M8 5v14l11-7z" /></svg>
                </span>
              </span>
              <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{p.name}</span>
              <span className="mt-1 block truncate text-xs" style={{ color: theme.secondary }}>{p.description || 'Spotify 官方歌单'}</span>
            </button>
          ))}
          {loading && <p className="col-span-full py-10 text-center text-sm" style={{ color: theme.secondary }}>加载中…</p>}
        </div>
      </div>
    </div>
  )
}
