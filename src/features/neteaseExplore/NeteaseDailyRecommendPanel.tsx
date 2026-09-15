import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, History, Loader2, Play, SlidersHorizontal, X } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { fetchNeteaseDailyHistory, fetchNeteaseDailyStyleConfig, fetchNeteaseDailyStyleSongs, type NeteaseDailyStyleCategory } from './api'
import { SongRestrictionBadges } from './NeteaseResourceView'
import CachedImage from '../../components/CachedImage'
import type { EntitlementTier } from '../../utils/musicEntitlements'

// src/features/neteaseExplore/NeteaseDailyRecommendPanel.tsx

type Tab = 'today' | 'history' | 'style'

interface Props {
  initialSongs: Song[]
  entitlement: EntitlementTier
  onClose: () => void
  onPlaySongs: (song: Song, songs: Song[]) => void
  onSongContextMenu: (event: React.MouseEvent, song: Song, songs: Song[]) => void
}

export default function NeteaseDailyRecommendPanel({ initialSongs, entitlement, onClose, onPlaySongs, onSongContextMenu }: Props) {
  const [tab, setTab] = useState<Tab>('today')
  const [songs, setSongs] = useState(initialSongs)
  const [dates, setDates] = useState<string[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [categories, setCategories] = useState<NeteaseDailyStyleCategory[]>([])
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedTag, setSelectedTag] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const activeCategory = useMemo(() => categories.find(category => category.categoryId === selectedCategory) || categories[0], [categories, selectedCategory])

  useEffect(() => {
    if (tab !== 'history' || dates.length > 0) return
    setLoading(true)
    void fetchNeteaseDailyHistory().then(result => {
      setDates(result.dates)
      if (result.songs.length > 0) setSongs(result.songs)
    }).catch(requestError => setError(requestError instanceof Error ? requestError.message : '历史日推加载失败')).finally(() => setLoading(false))
  }, [dates.length, tab])

  useEffect(() => {
    if (tab !== 'style' || categories.length > 0) return
    setLoading(true)
    void fetchNeteaseDailyStyleConfig().then(result => {
      setCategories(result)
      setSelectedCategory(result[0]?.categoryId || '')
      setSelectedTag(result[0]?.tags[0]?.tagId || '')
    }).catch(requestError => setError(requestError instanceof Error ? requestError.message : '风格日推加载失败')).finally(() => setLoading(false))
  }, [categories.length, tab])

  const loadHistory = async (date: string) => {
    setSelectedDate(date)
    setLoading(true)
    setError('')
    try { setSongs((await fetchNeteaseDailyHistory(date)).songs) } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '历史日推加载失败') } finally { setLoading(false) }
  }

  const loadStyle = async (categoryId: string, tagId: string) => {
    setSelectedCategory(categoryId)
    setSelectedTag(tagId)
    setLoading(true)
    setError('')
    try { setSongs(await fetchNeteaseDailyStyleSongs(categoryId, tagId, initialSongs[0]?.id || 0)) } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '风格日推加载失败') } finally { setLoading(false) }
  }

  return (
    <div className="fixed inset-0 z-[178] flex items-center justify-center bg-black/65 p-5 text-white backdrop-blur-xl" onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-md border border-white/[0.1] bg-[#0d1118]" onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <div className="flex items-center gap-3"><button type="button" onClick={onClose} aria-label="返回推荐页"><ChevronLeft className="h-5 w-5" /></button><div><h3 className="font-semibold">每日推荐</h3><p className="mt-0.5 text-xs text-white/38">根据你的音乐口味生成，每日 6:00 更新</p></div></div>
          <div className="flex items-center gap-2">{songs[0] && <button type="button" onClick={() => onPlaySongs(songs[0], songs)} className="flex h-9 items-center gap-2 rounded-full bg-white px-4 text-xs font-semibold text-black"><Play className="h-3.5 w-3.5 fill-current" />播放全部</button>}<button type="button" onClick={onClose} aria-label="关闭每日推荐"><X className="h-5 w-5" /></button></div>
        </header>
        <div className="flex items-center gap-1 border-b border-white/[0.07] px-5 py-3">
          {([{ id: 'today', label: '今日推荐', icon: CalendarDays }, { id: 'history', label: '历史日推', icon: History }, { id: 'style', label: '风格推荐', icon: SlidersHorizontal }] as const).map(item => <button key={item.id} type="button" onClick={() => { setTab(item.id); if (item.id === 'today') setSongs(initialSongs) }} className={`flex h-9 items-center gap-2 rounded-md px-3 text-xs ${tab === item.id ? 'bg-white text-black' : 'text-white/55 hover:bg-white/[0.07]'}`}><item.icon className="h-3.5 w-3.5" />{item.label}</button>)}
        </div>
        {tab === 'history' && dates.length > 0 && <div className="explore-scrollbar flex gap-2 overflow-x-auto border-b border-white/[0.06] px-5 py-3">{dates.map(date => <button key={date} type="button" onClick={() => void loadHistory(date)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${selectedDate === date ? 'bg-white text-black' : 'bg-white/[0.05] text-white/55'}`}>{date}</button>)}</div>}
        {tab === 'style' && categories.length > 0 && <div className="border-b border-white/[0.06] px-5 py-3"><div className="flex flex-wrap gap-2">{categories.map(category => <button key={category.categoryId} type="button" onClick={() => { const tag = category.tags[0]; if (tag) void loadStyle(category.categoryId, tag.tagId) }} className={`rounded-full px-3 py-1.5 text-xs ${activeCategory?.categoryId === category.categoryId ? 'bg-white text-black' : 'bg-white/[0.05] text-white/55'}`}>{category.categoryName}</button>)}</div>{activeCategory && <div className="mt-3 flex flex-wrap gap-2">{activeCategory.tags.map(tag => <button key={tag.tagId} type="button" onClick={() => void loadStyle(activeCategory.categoryId, tag.tagId)} className={`rounded-full border px-3 py-1.5 text-xs ${selectedTag === tag.tagId ? 'border-red-400/50 text-red-300' : 'border-white/[0.08] text-white/45'}`}>{tag.tagName}</button>)}</div>}</div>}
        <div className="flex-1 overflow-y-auto p-5">
          {error && <div role="alert" className="mb-4 rounded-md border border-rose-500/25 bg-rose-500/[0.08] px-4 py-3 text-sm">{error}</div>}
          {loading ? <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div> : songs.length > 0 ? <div className="grid gap-x-6 md:grid-cols-2">{songs.map((song, index) => <button key={`${song.id}-${index}`} type="button" onClick={() => onPlaySongs(song, songs)} onContextMenu={event => onSongContextMenu(event, song, songs)} className="group flex min-w-0 items-center gap-3 border-b border-white/[0.055] p-2 text-left hover:bg-white/[0.035]"><span className="w-7 text-center text-xs text-white/25">{String(index + 1).padStart(2, '0')}</span><CachedImage src={song.album.picUrl} alt="" className="h-12 w-12 rounded-md object-cover" role="row" priority="visible" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{song.name}</span><span className="block truncate text-xs text-white/38">{song.artists.map(artist => artist.name).join(' / ')}</span></span><SongRestrictionBadges song={song} entitlement={entitlement} /><Play className="h-4 w-4 text-white/25 opacity-0 group-hover:opacity-100" /></button>)}</div> : <p className="py-20 text-center text-sm text-white/40">这一分类暂时没有推荐歌曲</p>}
        </div>
      </div>
    </div>
  )
}
