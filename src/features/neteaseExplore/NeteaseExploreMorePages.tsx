import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, Headphones, Loader2, Plus, UserPlus } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { getApiBase } from '../../services/apiConfig'
import { getUserRecordRank } from '../../services/musicApi'
import { getPlatformCookie } from '../../services/platforms'
import { cookieHeaders } from '../../services/cookieRequest'
import { NeteaseNativeBlockView, type ResourceCallbacks } from './NeteaseResourceView'
import type { NeteaseNativeBlock, NeteaseNativeResource } from './model'
import { normalizeNeteaseResource } from './model'
import CachedImage from '../../components/CachedImage'

// 二级页通用骨架（返回 + 标题 + tabs）
function PageFrame({ title, onBack, children, tabs }: { title: string; onBack: () => void; children: React.ReactNode; tabs?: React.ReactNode }) {
  return (
    <div className="space-y-5 pb-32">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition hover:bg-white/[0.12] hover:text-white"
          aria-label="返回"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h3 className="text-lg font-semibold text-white">{title}</h3>
      </div>
      {tabs}
      {children}
    </div>
  )
}

// src/features/neteaseExplore/NeteaseExploreMorePages.tsx
// 网易云「发现-音乐-精选」底部的「探索更多」三个二级页（App 官方同款入口）：
//  - 按歌手浏览：地区 × 性别 双排分类 + 热门歌手列表（可关注）
//  - 音乐专区：新歌速递（可直接播放）+ 新碟上架（跳专辑详情）
//  - 宝藏曲库：精品歌单墙（按分类，带播放量角标）

interface PageShellProps {
  accent: string
  title: string
  loading: boolean
  error: string
  onBack: () => void
  children: React.ReactNode
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
}

function PageShell({ accent, title, loading, error, onBack, children, hasMore, loadingMore, onLoadMore }: PageShellProps) {
  return (
    <div className="space-y-4 pb-32">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition hover:bg-white/[0.12] hover:text-white"
          aria-label="返回"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h3 className="text-lg font-semibold text-white">{title}</h3>
      </div>
      {error && (
        <div role="alert" className="flex items-center gap-3 rounded-md border border-rose-500/25 bg-rose-500/[0.08] px-4 py-3 text-sm">
          {error}
        </div>
      )}
      {loading ? LOADING_HINT : children}
      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] px-5 text-sm text-white/65 transition hover:bg-white/[0.08] disabled:opacity-50"
          >
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}加载更多
          </button>
        </div>
      )}
    </div>
  )
}

const LOADING_HINT = (
  <div className="flex items-center gap-3 py-10 text-sm text-white/45">
    <Loader2 className="h-4 w-4 animate-spin" />加载中…
  </div>
)

// ─────────────────────────── 按歌手浏览 ───────────────────────────

const ARTIST_AREAS: Array<{ label: string; id: number }> = [
  { label: '华语', id: 7 },
  { label: '欧美', id: 96 },
  { label: '日本', id: 8 },
  { label: '韩国', id: 16 },
  { label: '其他', id: 0 },
]
const ARTIST_TYPES: Array<{ label: string; id: number }> = [
  { label: '男', id: 1 },
  { label: '女', id: 2 },
  { label: '乐队/组合', id: 3 },
]

interface NeteaseArtistItem { id: number; name: string; picUrl: string; followed?: boolean }

export function NeteaseArtistBrowsePage({ accent, callbacks, onBack }: { accent: string; callbacks: ResourceCallbacks; onBack: () => void }) {
  const [area, setArea] = useState(ARTIST_AREAS[0].id)
  const [gender, setGender] = useState(ARTIST_TYPES[0].id)
  const [artists, setArtists] = useState<NeteaseArtistItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [followedIds, setFollowedIds] = useState<Set<number>>(new Set())
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set())
  const offsetRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // 已关注的歌手：用于点亮「已关注」状态（失败静默，不影响浏览）
    const controller = new AbortController()
    fetch(getApiBase() + '/netease/artist/sublist?limit=100', { signal: controller.signal, headers: cookieHeaders(getPlatformCookie('netease')) })
      .then(res => res.json())
      .then(data => {
        const list = data?.data?.data || data?.data?.artists || data?.artists || []
        const ids = (Array.isArray(list) ? list : []).map((item: any) => Number(item?.id)).filter(Boolean)
        if (ids.length) setFollowedIds(new Set(ids))
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  const load = useCallback(async (reset: boolean) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (reset) { setLoading(true); offsetRef.current = 0 } else { setLoadingMore(true) }
    setError('')
    try {
      const offset = reset ? 0 : offsetRef.current
      const res = await fetch(`${getApiBase()}/netease/artist/list?type=${gender}&area=${area}&limit=30&offset=${offset}`, { signal: controller.signal })
      const data = await res.json()
      if (controller.signal.aborted) return
      const list: NeteaseArtistItem[] = (data?.artists || []).map((item: any) => ({ id: Number(item.id), name: String(item.name || ''), picUrl: String(item.picUrl || '') }))
      setArtists(previous => {
        if (reset) return list
        const seen = new Set(previous.map((item: NeteaseArtistItem) => item.id))
        return [...previous, ...list.filter(item => !seen.has(item.id))]
      })
      offsetRef.current = offset + list.length
      setHasMore(list.length >= 30)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '歌手列表加载失败')
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false) }
    }
  }, [area, gender])

  useEffect(() => { void load(true) }, [load])

  const toggleFollow = async (artist: NeteaseArtistItem) => {
    if (pendingIds.has(artist.id)) return
    const followed = followedIds.has(artist.id)
    setPendingIds(previous => new Set(previous).add(artist.id))
    // 乐观更新，失败回滚
    setFollowedIds(previous => {
      const next = new Set(previous)
      if (followed) next.delete(artist.id)
      else next.add(artist.id)
      return next
    })
    try {
      const res = await fetch(getApiBase() + '/netease/artist/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookieHeaders(getPlatformCookie('netease')) },
        body: JSON.stringify({ id: artist.id, t: followed ? 0 : 1 }),
      })
      const data = await res.json()
      if (data?.body?.code !== 200 && data?.code !== 200) throw new Error(data?.body?.message || data?.error || '操作失败')
    } catch (error) {
      setFollowedIds(previous => {
        const next = new Set(previous)
        if (followed) next.add(artist.id)
        else next.delete(artist.id)
        return next
      })
    } finally {
      setPendingIds(previous => {
        const next = new Set(previous)
        next.delete(artist.id)
        return next
      })
    }
  }

  const artistResource = (artist: NeteaseArtistItem, index: number): NeteaseNativeResource | null => {
    if (!artist.id) return null
    return normalizeNeteaseResource({
      resourceId: artist.id,
      resourceType: 'artist',
      action: `orpheus://artist/${artist.id}`,
      title: artist.name,
      coverImg: artist.picUrl,
      subTitle: '歌手',
    }, index)
  }

  return (
    <PageShell accent={accent} title="歌手分类" loading={false} error={error} onBack={onBack} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => void load(false)}>
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-2">
          {ARTIST_AREAS.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setArea(item.id)}
              className={`h-8 rounded-full px-4 text-sm transition ${area === item.id ? 'bg-[var(--explore-accent)]/25 text-white ring-1 ring-[var(--explore-accent)]/60' : 'text-white/55 hover:bg-white/[0.08] hover:text-white/85'}`}
              aria-pressed={area === item.id}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {ARTIST_TYPES.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => setGender(item.id)}
              className={`h-8 rounded-full px-4 text-sm transition ${gender === item.id ? 'bg-[var(--explore-accent)]/25 text-white ring-1 ring-[var(--explore-accent)]/60' : 'text-white/55 hover:bg-white/[0.08] hover:text-white/85'}`}
              aria-pressed={gender === item.id}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.07] bg-white/[0.03]">
        <p className="border-b border-white/[0.06] px-4 py-2 text-xs text-white/45">热门歌手</p>
        {artists.map(artist => {
          const followed = followedIds.has(artist.id)
          const pending = pendingIds.has(artist.id)
          return (
            <div key={artist.id} className="flex items-center gap-3 border-b border-white/[0.05] px-4 py-2.5 last:border-b-0">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={() => {
                  const resource = artistResource(artist, 0)
                  if (resource) callbacks.onExecute(resource, [resource])
                }}
              >
                {artist.picUrl
                  ? <img src={artist.picUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" loading="lazy" />
                  : <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.08]"><UserPlus className="h-4 w-4 text-white/40" /></span>}
                <span className="min-w-0 flex-1 truncate text-sm text-white/88">{artist.name}</span>
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => void toggleFollow(artist)}
                className={`flex h-7 shrink-0 items-center gap-1 rounded-full border px-3 text-xs transition disabled:opacity-50 ${followed ? 'border-white/20 text-white/55' : ''}`}
                style={followed ? undefined : { borderColor: accent, color: accent }}
                aria-pressed={followed}
              >
                {followed ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                {followed ? '已关注' : '+ 关注'}
              </button>
            </div>
          )
        })}
        {!loading && artists.length === 0 && <p className="px-4 py-8 text-center text-sm text-white/40">该分类暂无歌手</p>}
      </div>
    </PageShell>
  )
}

// ─────────────────────────── 音乐专区 ───────────────────────────

interface NeteaseAlbumItem { id: number; name: string; picUrl: string; artistName: string }
interface NeteaseTrackItem { id: number; name: string; picUrl: string; artistName: string; duration: number }

export function NeteaseMusicZonePage({ accent, callbacks, onBack }: { accent: string; callbacks: ResourceCallbacks; onBack: () => void }) {
  const [albums, setAlbums] = useState<NeteaseAlbumItem[]>([])
  const [tracks, setTracks] = useState<NeteaseTrackItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      fetch(getApiBase() + '/netease/top/album?limit=30', { signal: controller.signal }).then(res => res.json()),
      fetch(getApiBase() + '/netease/top/song?type=0', { signal: controller.signal }).then(res => res.json()),
    ]).then(([albumPayload, songPayload]) => {
      if (controller.signal.aborted) return
      const albumList: NeteaseAlbumItem[] = (albumPayload?.albums || []).map((item: any) => ({
        id: Number(item.id),
        name: String(item.name || ''),
        picUrl: String(item.picUrl || ''),
        artistName: String(item.artist?.name || item?.artists?.[0]?.name || ''),
      })).filter((item: NeteaseAlbumItem) => item.id)
      const trackList: NeteaseTrackItem[] = (songPayload?.data || []).slice(0, 30).map((item: any) => ({
        id: Number(item.id),
        name: String(item.name || ''),
        picUrl: String(item.al?.picUrl || item.album?.picUrl || ''),
        artistName: (item.ar || item.artists || []).map((artist: any) => artist?.name).filter(Boolean).join(' / '),
        duration: Number(item.duration || item.dt || 0),
      })).filter((item: NeteaseTrackItem) => item.id)
      setAlbums(albumList)
      setTracks(trackList)
      setLoading(false)
    }).catch(error => {
      if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : '音乐专区加载失败'); setLoading(false) }
    })
    return () => controller.abort()
  }, [])

  const blocks = useMemo<NeteaseNativeBlock[]>(() => {
    const out: NeteaseNativeBlock[] = []
    if (tracks.length > 0) {
      const resources = tracks.map((track, index) => {
        const song = {
          id: track.id,
          name: track.name,
          artists: track.artistName ? track.artistName.split(' / ').map(name => ({ name })) : [],
          album: { name: '', picUrl: track.picUrl },
          duration: track.duration,
          platform: 'netease',
        } as unknown as Song
        return normalizeNeteaseResource({ resourceId: track.id, resourceType: 'song', songData: song, title: track.name, coverImg: track.picUrl, subTitle: track.artistName }, index)
      }).filter((item): item is NeteaseNativeResource => Boolean(item))
      if (resources.length) out.push({ id: 'music-zone-new-songs', blockCode: 'MUSIC_ZONE_NEW_SONGS', showType: 'HOMEPAGE_SLIDE_SONGLIST_ALIGN', title: '新歌速递', subtitle: '', resources, raw: {} })
    }
    if (albums.length > 0) {
      const resources = albums.map((album, index) => normalizeNeteaseResource({
        resourceId: album.id,
        resourceType: 'album',
        action: `orpheus://album/${album.id}`,
        title: album.name,
        coverImg: album.picUrl,
        subTitle: album.artistName,
      }, index)).filter((item): item is NeteaseNativeResource => Boolean(item))
      if (resources.length) out.push({ id: 'music-zone-new-albums', blockCode: 'MUSIC_ZONE_NEW_ALBUMS', showType: 'HOMEPAGE_SLIDE_PLAYLIST', title: '新碟上架', subtitle: '', resources, raw: {} })
    }
    return out
  }, [tracks, albums])

  return (
    <PageShell accent={accent} title="音乐专区" loading={loading} error={error} onBack={onBack}>
      {loading ? LOADING_HINT : blocks.length === 0
        ? <p className="py-10 text-center text-sm text-white/40">暂无内容</p>
        : (
          <div className="space-y-12">
            {blocks.map((block, index) => <NeteaseNativeBlockView key={`${block.blockCode}-${index}`} block={block} callbacks={callbacks} />)}
          </div>
        )}
    </PageShell>
  )
}

// ─────────────────────────── 宝藏曲库（精品歌单墙） ───────────────────────────

const TREASURE_CATS = ['华语', '流行', '摇滚', '民谣', '电子', '说唱', '古风', '轻音乐', '爵士', 'R&B/Soul', '嘻哈/Rap', '古典', 'ACG', '金属', '后摇', 'Bossa Nova']

export function NeteaseTreasureLibraryPage({ accent, callbacks, onBack }: { accent: string; callbacks: ResourceCallbacks; onBack: () => void }) {
  const [cat, setCat] = useState(TREASURE_CATS[0])
  const [playlists, setPlaylists] = useState<NeteaseNativeResource[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const beforeRef = useRef<number | null>(null)
  const hasMoreRef = useRef(false)
  const [hasMore, setHasMore] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async (reset: boolean) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (reset) { setLoading(true); beforeRef.current = null } else { setLoadingMore(true) }
    setError('')
    try {
      const beforeParam = reset ? '' : (beforeRef.current != null ? `&before=${beforeRef.current}` : '')
      const res = await fetch(`${getApiBase()}/netease/playlist/highquality?cat=${encodeURIComponent(cat)}&limit=30${beforeParam}`, { signal: controller.signal })
      const data = await res.json()
      if (controller.signal.aborted) return
      const list = data?.playlists || []
      const resources = list.map((item: any, index: number) => normalizeNeteaseResource({
        resourceId: item.id,
        resourceType: 'playlist',
        action: `orpheus://playlist/${item.id}`,
        title: item.name,
        coverImg: item.coverImgUrl,
        subTitle: item.copywriter || `by ${item.creator?.nickname || ''}`,
        playCount: item.playCount,
      }, index)).filter((item: NeteaseNativeResource | null): item is NeteaseNativeResource => Boolean(item))
      setPlaylists(previous => {
        if (reset) return resources
        const seen = new Set(previous.map((item: NeteaseNativeResource) => item.id))
        return [...previous, ...resources.filter((item: NeteaseNativeResource) => !seen.has(item.id))]
      })
      const last = list[list.length - 1]
      beforeRef.current = last?.specialType ?? null
      hasMoreRef.current = list.length >= 30
      setHasMore(hasMoreRef.current)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '宝藏曲库加载失败')
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false) }
    }
  }, [cat])

  useEffect(() => { void load(true) }, [load])

  const block = useMemo<NeteaseNativeBlock | null>(() => {
    if (playlists.length === 0) return null
    return {
      id: 'treasure-library-playlists',
      blockCode: 'TREASURE_LIBRARY_PLAYLISTS',
      showType: 'HOMEPAGE_SLIDE_PLAYLIST',
      title: '精品歌单',
      subtitle: '',
      resources: playlists,
      raw: {},
    }
  }, [playlists])

  return (
    <PageShell accent={accent} title="宝藏曲库" loading={loading} error={error} onBack={onBack} hasMore={hasMore} loadingMore={loadingMore} onLoadMore={() => void load(false)}>
      <div className="flex flex-wrap gap-2">
        {TREASURE_CATS.map(item => (
          <button
            key={item}
            type="button"
            onClick={() => setCat(item)}
            className={`h-8 rounded-full px-4 text-sm transition ${cat === item ? 'bg-[var(--explore-accent)]/25 text-white ring-1 ring-[var(--explore-accent)]/60' : 'text-white/55 hover:bg-white/[0.08] hover:text-white/85'}`}
            aria-pressed={cat === item}
          >
            {item}
          </button>
        ))}
      </div>
      {block && <NeteaseNativeBlockView block={block} callbacks={callbacks} />}
      {!loading && !block && <p className="py-10 text-center text-sm text-white/40">该分类暂无精品歌单</p>}
      {loading && LOADING_HINT}
    </PageShell>
  )
}

// 「N 次播放」小徽标（宝藏曲库/新碟等复用）
export function PlayCountHint({ count }: { count?: number }) {
  if (!count || count <= 0) return null
  return (
    <span className="flex items-center gap-1 text-xs text-white/45">
      <Headphones className="h-3 w-3" />
      {count >= 100000000 ? `${(count / 100000000).toFixed(1)}亿` : count >= 10000 ? `${(count / 10000).toFixed(1)}万` : count}
    </span>
  )
}

// ─────────────────────────── 网易云听歌报告（官方账号数据：听歌排行） ───────────────────────────

interface RankSong { id: number; name: string; artist: string; coverUrl: string; playCount: number }

export function NeteaseReportPanel({ accent, accountUserId, onBack }: { accent: string; accountUserId?: string; onBack: () => void }) {
  const [range, setRange] = useState<'week' | 'all'>('week')
  const [songs, setSongs] = useState<RankSong[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!accountUserId) { setError('需要登录网易云音乐并获取到账号信息'); setLoading(false); return }
    const controller = new AbortController()
    setLoading(true)
    setError('')
    getUserRecordRank(accountUserId, range === 'week' ? 1 : 0)
      .then((data: any) => {
        if (controller.signal.aborted) return
        const raw = range === 'week' ? data?.weekData : data?.allData
        const list: RankSong[] = (Array.isArray(raw) ? raw : []).map((item: any) => {
          const track = item?.song && typeof item.song === 'object' ? item.song : item
          const arList = Array.isArray(track?.ar) ? track.ar : Array.isArray(track?.artists) ? track.artists : []
          return {
            id: Number(track?.id ?? item?.id ?? 0),
            name: String(track?.name || ''),
            artist: arList.map((a: any) => a?.name).filter(Boolean).join(' / '),
            coverUrl: String(track?.al?.picUrl || track?.al?.pic || track?.album?.picUrl || ''),
            playCount: Number(track?.playCount ?? item?.playCount ?? 0),
          }
        }).filter((song: RankSong) => song.id && song.name)
        setSongs(list)
        setLoading(false)
      })
      .catch(() => {
        if (!controller.signal.aborted) { setError('听歌报告获取失败，请确认已登录网易云'); setLoading(false) }
      })
    return () => controller.abort()
  }, [accountUserId, range])

  const totalPlays = songs.reduce((sum, song) => sum + song.playCount, 0)
  const favorite = songs[0]

  return (
    <PageFrame title="听歌报告" onBack={onBack}
      tabs={(
        <div className="flex gap-2">
          {([['week', '本周'], ['all', '所有时间']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setRange(key)}
              aria-pressed={range === key}
              className={`h-8 rounded-full px-4 text-sm transition ${range === key ? 'bg-[var(--explore-accent)]/25 text-white ring-1 ring-[var(--explore-accent)]/60' : 'text-white/55 hover:bg-white/[0.08] hover:text-white/85'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    >
      {error && <p className="text-sm text-rose-300/80">{error}</p>}
      {loading ? (
        <div className="flex items-center gap-3 py-10 text-sm text-white/45"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
      ) : songs.length === 0 ? (
        <p className="py-10 text-center text-sm text-white/40">暂无听歌数据</p>
      ) : (
        <div className="space-y-5">
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-4">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs text-white/40">{range === 'week' ? '本周已听' : '累计听过'}</p>
                <p className="text-3xl font-bold text-white">{songs.length}<span className="ml-1 text-sm font-normal text-white/45">首</span></p>
              </div>
              <p className="text-xs text-white/40">总播放 {totalPlays.toLocaleString()} 次</p>
            </div>
            {favorite && (
              <p className="mt-3 text-sm text-white/70">
                最爱《<span style={{ color: accent }}>{favorite.name}</span>》· {favorite.artist || '未知歌手'} · 听了 {favorite.playCount.toLocaleString()} 次
              </p>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold text-white/85">听歌排行 TOP30</h4>
            <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03]">
              {songs.slice(0, 30).map((song, index) => (
                <div key={`${song.id}-${index}`} className="flex items-center gap-3 border-b border-white/[0.05] px-4 py-2.5 last:border-b-0">
                  <span className="w-5 shrink-0 text-center text-sm font-semibold" style={{ color: index < 3 ? accent : 'rgba(255,255,255,0.35)' }}>{index + 1}</span>
                  {song.coverUrl
                    ? <CachedImage src={song.coverUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" role="row" size={80} />
                    : <span className="h-9 w-9 shrink-0 rounded bg-white/[0.06]" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-white/88">{song.name}</span>
                    <span className="block truncate text-xs text-white/38">{song.artist}</span>
                  </span>
                  <span className="shrink-0 text-xs text-white/45">{song.playCount.toLocaleString()} 次</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-white/30">数据来自网易云音乐账号「听歌排行」（官方接口）</p>
          </div>
        </div>
      )}
    </PageFrame>
  )
}
