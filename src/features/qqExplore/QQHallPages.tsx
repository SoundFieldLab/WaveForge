import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, Headphones, Loader2, Play, Plus } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import type { ExploreChart, ExplorePlaylist } from '../../services/exploreApi'
import CachedImage from '../../components/CachedImage'

// src/features/qqExplore/QQHallPages.tsx
// QQ「乐馆」二级页（PC 布局，官方 App 歌手/排行/歌单/专区同款内容）：
//  - QQArtistsPage        歌手分类（地区 × 性别 tags + 歌手列表 + 关注语义的关注量展示，点歌手播热门歌曲）
//  - QQChartsPage         排行榜目录（点击进榜单详情）
//  - QQPlaylistSquarePage 歌单广场（官方分类 chips + 歌单网格 + 翻页，带播放量角标）
//  - QQZonePage           音质/品牌专区（官方专区名 → 官方歌单搜索）

import { getApiBase } from '../../services/apiConfig'

// API 基址走统一网关配置（此前硬编码 3001，网关换端口时本页全部请求失效）
const API = getApiBase()

export function formatQQCount(value?: number | string): string {
  const n = Number(value || 0)
  if (!n) return ''
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`
  if (n >= 10000) return `${Math.round(n / 1000) / 10}万`
  return String(n)
}

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

function Chips({ items, active, onSelect }: { items: Array<{ key: string; label: string }>; active: string; onSelect: (key: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(item => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelect(item.key)}
          aria-pressed={active === item.key}
          className={`h-8 rounded-full px-4 text-sm transition ${active === item.key ? 'bg-[var(--explore-accent)]/25 text-white ring-1 ring-[var(--explore-accent)]/60' : 'text-white/55 hover:bg-white/[0.08] hover:text-white/85'}`}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

// ─────────────────────────── 歌手分类 ───────────────────────────

interface QQSinger { mid: string; id?: number; name: string; picUrl: string }

// QQ 官方歌手分类 tag（与网易云的 id 体系不同：内地=200、男=0）
const SINGER_AREAS: Array<{ label: string; id: number }> = [
  { label: '全部', id: -100 },
  { label: '内地', id: 200 },
  { label: '港台', id: 2 },
  { label: '欧美', id: 5 },
  { label: '日本', id: 4 },
  { label: '韩国', id: 3 },
  { label: '其他', id: 6 },
]
const SINGER_SEXES: Array<{ label: string; id: number }> = [
  { label: '全部', id: -100 },
  { label: '男', id: 0 },
  { label: '女', id: 1 },
  { label: '乐队/组合', id: 2 },
]

export function QQArtistsPage({ accent, onPlaySongs, onBack }: { accent: string; onPlaySongs: (song: Song, songs: Song[]) => void; onBack: () => void }) {
  const [area, setArea] = useState(SINGER_AREAS[0].id)
  const [sex, setSex] = useState(SINGER_SEXES[0].id)
  const [singers, setSingers] = useState<QQSinger[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const pageRef = useRef(1)
  const abortRef = useRef<AbortController | null>(null)
  const [playingMid, setPlayingMid] = useState('')

  const load = useCallback(async (reset: boolean) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (reset) { setLoading(true); pageRef.current = 1 } else { setLoadingMore(true) }
    setError('')
    try {
      const pageNo = reset ? 1 : pageRef.current + 1
      const res = await fetch(`${API}/qq/singer/list?area=${area}&sex=${sex}&pageNo=${pageNo}`, { signal: controller.signal })
      const data = await res.json()
      if (controller.signal.aborted) return
      const raw = data?.data?.list || data?.data?.singers?.singerlist || data?.data?.singerlist || []
      const list: QQSinger[] = (Array.isArray(raw) ? raw : []).map((item: any) => ({
        mid: String(item.singer_mid || item.mid || ''),
        id: item.singer_id ? Number(item.singer_id) : undefined,
        name: String(item.singer_name || item.name || ''),
        // 歌手头像原样保留 .webp 后缀：去掉后缀 y.gtimg.cn 直接 404（与 QQPcHall.parseQQSingers 对齐）
        picUrl: String(item.singer_pic || item.picUrl || ''),
      })).filter((item: QQSinger) => item.mid && item.name)
      setSingers(previous => {
        if (reset) return list
        const seen = new Set(previous.map(item => item.mid))
        return [...previous, ...list.filter(item => !seen.has(item.mid))]
      })
      pageRef.current = pageNo
      setHasMore(list.length >= 30)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '歌手列表加载失败')
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false) }
    }
  }, [area, sex])

  useEffect(() => { void load(true) }, [load])

  const playSinger = async (singer: QQSinger) => {
    if (playingMid === singer.mid) return
    setPlayingMid(singer.mid)
    try {
      // 服务端只有 /qq/artist/songs（此前调用的 /qq/singer/songs 不存在 → 404 且被静默吞掉）
      const res = await fetch(`${API}/qq/artist/songs?singermid=${encodeURIComponent(singer.mid)}&num=30`)
      const data = await res.json()
      if (data?.errMsg) throw new Error(String(data.errMsg))
      const list: Song[] = (data?.songs || []).map((item: any) => item?.song || item).filter(Boolean)
      if (list.length) onPlaySongs(list[0], list)
      else window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '该歌手暂无可播放的歌曲', type: 'info' } }))
    } catch (error) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: error instanceof Error ? error.message : '歌手歌曲播放失败', type: 'error' } }))
    }
    finally { setPlayingMid('') }
  }

  return (
    <PageFrame title="歌手分类" onBack={onBack}
      tabs={(
        <div className="space-y-1.5">
          <Chips items={SINGER_AREAS.map(item => ({ key: String(item.id), label: item.label }))} active={String(area)} onSelect={key => setArea(Number(key))} />
          <Chips items={SINGER_SEXES.map(item => ({ key: String(item.id), label: item.label }))} active={String(sex)} onSelect={key => setSex(Number(key))} />
        </div>
      )}
    >
      {error && <p className="text-sm text-rose-300/80">{error}</p>}
      {loading ? (
        <div className="flex items-center gap-3 py-10 text-sm text-white/45"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 min-[1900px]:grid-cols-6">
          {singers.map(singer => (
            <button
              key={singer.mid}
              type="button"
              onClick={() => void playSinger(singer)}
              className="group w-full text-left"
              title={`播放 ${singer.name} 的热门歌曲`}
            >
              <span className="relative block aspect-square overflow-hidden rounded-lg bg-white/[0.05]">
                {singer.picUrl
                  ? <CachedImage src={singer.picUrl} alt={singer.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]" role="card" size={240} />
                  : <span className="flex h-full w-full items-center justify-center text-white/30 text-2xl font-semibold">{singer.name.slice(0, 1)}</span>}
                <span className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lg transition group-hover:opacity-100">
                  {playingMid === singer.mid ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                </span>
              </span>
              <span className="mt-2 block truncate text-sm font-medium text-white/88">{singer.name}</span>
            </button>
          ))}
        </div>
      )}
      {!loading && singers.length === 0 && !error && <p className="py-10 text-center text-sm text-white/40">该分类暂无歌手</p>}
      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void load(false)}
            className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] px-5 text-sm text-white/65 transition hover:bg-white/[0.08] disabled:opacity-50"
          >
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}加载更多歌手
          </button>
        </div>
      )}
      {accent === '__never__' && <span />}
    </PageFrame>
  )
}

// ─────────────────────────── 排行榜目录 ───────────────────────────

export function QQChartsPage({ charts, accent, onOpenChart, onBack }: { charts: ExploreChart[]; accent: string; onOpenChart: (chart: ExploreChart, autoplay?: boolean) => void; onBack: () => void }) {
  return (
    <PageFrame title="排行榜" onBack={onBack}>
      {charts.length === 0 ? (
        <p className="py-10 text-center text-sm text-white/40">暂无榜单数据</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {charts.map((chart, index) => (
            <button
              key={`${chart.id}-${index}`}
              type="button"
              onClick={() => onOpenChart(chart)}
              className="group flex min-h-28 gap-4 rounded-[20px] border border-white/[0.08] bg-white/[0.035] p-3 text-left transition hover:bg-white/[0.07]"
            >
              <span className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl">
                {chart.coverUrl
                  ? <CachedImage src={chart.coverUrl} alt={chart.name} className="h-full w-full object-cover" role="card" size={200} />
                  : <span className="flex h-full w-full items-center justify-center" style={{ color: accent }}><Headphones className="h-6 w-6" /></span>}
              </span>
              <span className="flex min-w-0 flex-1 flex-col justify-center">
                <span className="truncate text-sm font-semibold text-white/90">{chart.name}</span>
                {chart.group && <span className="mt-1 text-xs text-white/40">{chart.group}</span>}
              </span>
              <span className="flex shrink-0 items-center justify-center rounded-full bg-white text-black opacity-0 transition group-hover:opacity-100 h-9 w-9"><Play className="h-4 w-4 fill-current" /></span>
            </button>
          ))}
        </div>
      )}
    </PageFrame>
  )
}

// ─────────────────────────── 歌单广场 ───────────────────────────

interface QQSquareCategory { id: number; name: string; group: string }
interface QQSquarePlaylist { id: string; name: string; coverUrl: string; playCount: number; trackCount?: number }

export function QQPlaylistSquarePage({ accent, presetCategory, onOpenPlaylist, onBack }: { accent: string; presetCategory?: string; onOpenPlaylist: (playlist: ExplorePlaylist, autoplay?: boolean) => void; onBack: () => void }) {
  const [categories, setCategories] = useState<QQSquareCategory[]>([])
  const [activeCat, setActiveCat] = useState<number | null>(null)
  const [playlists, setPlaylists] = useState<QQSquarePlaylist[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const pageRef = useRef(1)
  const abortRef = useRef<AbortController | null>(null)

  // 分类 chips
  useEffect(() => {
    const controller = new AbortController()
    fetch(`${API}/qq/songlist/category`, { signal: controller.signal })
      .then(res => res.json())
      .then(data => {
        const groups = data?.data || []
        const list: QQSquareCategory[] = []
        for (const group of Array.isArray(groups) ? groups : []) {
          for (const item of group?.list || []) {
            if (item?.id != null) list.push({ id: Number(item.id), name: String(item.name || ''), group: String(group?.type || '') })
          }
        }
        setCategories(list)
        // 预设分类（专区跳转）：按名字匹配
        if (presetCategory) {
          const hit = list.find(item => item.name === presetCategory) || list.find(item => item.name.includes(presetCategory))
          if (hit) { setActiveCat(hit.id); return }
        }
        const all = list.find(item => item.name === '全部')
        setActiveCat(all?.id ?? list[0]?.id ?? null)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [presetCategory])

  const load = useCallback(async (reset: boolean) => {
    if (activeCat == null) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    if (reset) { setLoading(true); pageRef.current = 1 } else { setLoadingMore(true) }
    setError('')
    try {
      const page = reset ? 1 : pageRef.current + 1
      const res = await fetch(`${API}/qq/songlist/list?id=${activeCat}&page=${page}&pageSize=30&sort=5`, { signal: controller.signal })
      const data = await res.json()
      if (controller.signal.aborted) return
      const raw = data?.data?.list || []
      const list: QQSquarePlaylist[] = raw.map((item: any) => ({
        id: String(item.dissid || item.id || ''),
        name: String(item.dissname || item.name || ''),
        coverUrl: String(item.imgurl || item.coverUrl || ''),
        playCount: Number(item.listennum || item.play_count || 0),
        trackCount: Number(item.song_count || 0) || undefined,
      })).filter((item: QQSquarePlaylist) => item.id && item.name)
      setPlaylists(previous => {
        if (reset) return list
        const seen = new Set(previous.map(item => item.id))
        return [...previous, ...list.filter(item => !seen.has(item.id))]
      })
      pageRef.current = page
      setHasMore(list.length >= 30)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '歌单加载失败')
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setLoadingMore(false) }
    }
  }, [activeCat])

  useEffect(() => { void load(true) }, [load])

  const grouped = useMemo(() => {
    // 分组标签顺序保留官方分组（热门/语种/风格/场景/主题/其它），同组内做 chips
    const map = new Map<string, QQSquareCategory[]>()
    for (const item of categories) {
      const arr = map.get(item.group) || []
      arr.push(item)
      map.set(item.group, arr)
    }
    return [...map.entries()]
  }, [categories])
  const activeName = categories.find(item => item.id === activeCat)?.name || '全部'

  return (
    <PageFrame title="歌单广场" onBack={onBack}>
      <div className="space-y-2.5">
        {grouped.map(([group, items]) => (
          <div key={group} className="flex items-start gap-2">
            <span className="mt-1.5 w-10 shrink-0 text-right text-xs text-white/35">{group}</span>
            <div className="flex flex-wrap gap-2">
              {items.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveCat(item.id)}
                  aria-pressed={activeCat === item.id}
                  className={`h-8 rounded-full px-3.5 text-sm transition ${activeCat === item.id ? 'bg-[var(--explore-accent)]/25 text-white ring-1 ring-[var(--explore-accent)]/60' : 'text-white/55 hover:bg-white/[0.08] hover:text-white/85'}`}
                >
                  {item.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="text-sm text-rose-300/80">{error}</p>}
      <p className="text-xs text-white/35">分类「{activeName}」</p>
      {loading ? (
        <div className="flex items-center gap-3 py-10 text-sm text-white/45"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 min-[1900px]:grid-cols-7">
          {playlists.map(playlist => (
            <button
              key={playlist.id}
              type="button"
              onClick={() => onOpenPlaylist({ id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl, platform: 'qq', source: 'qq-playlist-square' })}
              className="group w-full text-left"
            >
              <span className="relative block aspect-square overflow-hidden rounded-lg bg-white/[0.05]">
                <CachedImage src={playlist.coverUrl} alt={playlist.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" role="card" size={240} />
                <span className="absolute left-2 top-2 flex h-6 items-center gap-1 rounded-full bg-black/55 px-2 text-[11px] text-white/92 backdrop-blur">
                  <Headphones className="h-3 w-3" />{formatQQCount(playlist.playCount)}
                </span>
                <span className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lg transition group-hover:opacity-100"><Play className="h-3.5 w-3.5 fill-current" /></span>
              </span>
              <span className="mt-2 block line-clamp-2 text-sm font-medium text-white/88">{playlist.name}</span>
            </button>
          ))}
        </div>
      )}
      {!loading && playlists.length === 0 && !error && <p className="py-10 text-center text-sm text-white/40">该分类暂无歌单</p>}
      {hasMore && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void load(false)}
            className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] px-5 text-sm text-white/65 transition hover:bg-white/[0.08] disabled:opacity-50"
          >
            {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}加载更多歌单
          </button>
        </div>
      )}
      {accent === '__never__' && <span />}
    </PageFrame>
  )
}

// ─────────────────────────── 专区（官方专区名 → 官方歌单搜索） ───────────────────────────

export function QQZonePage({ zoneTitle, accent, onOpenPlaylist, onBack }: { zoneTitle: string; accent: string; onOpenPlaylist: (playlist: ExplorePlaylist, autoplay?: boolean) => void; onBack: () => void }) {
  const [playlists, setPlaylists] = useState<QQSquarePlaylist[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const keyword = zoneTitle.replace(/专区$/, '').trim() || zoneTitle
    setLoading(true)
    fetch(`${API}/qq/search?keywords=${encodeURIComponent(keyword)}&type=playlist&limit=40`, { signal: controller.signal })
      .then(res => res.json())
      .then(data => {
        const list = data?.playlists || []
        setPlaylists(list.map((item: any) => ({
          id: String(item.id || ''),
          name: String(item.name || ''),
          coverUrl: String(item.coverImgUrl || ''),
          playCount: Number(item.playCount || 0),
          trackCount: Number(item.trackCount || 0) || undefined,
        })).filter((item: QQSquarePlaylist) => item.id && item.name))
        setLoading(false)
      })
      .catch(error => { if (!controller.signal.aborted) { setError(error instanceof Error ? error.message : '专区内容加载失败'); setLoading(false) } })
    return () => controller.abort()
  }, [zoneTitle])

  return (
    <PageFrame title={zoneTitle} onBack={onBack}>
      {error && <p className="text-sm text-rose-300/80">{error}</p>}
      {loading ? (
        <div className="flex items-center gap-3 py-10 text-sm text-white/45"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div>
      ) : playlists.length === 0 ? (
        <p className="py-10 text-center text-sm text-white/40">该专区暂无歌单</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6 min-[1900px]:grid-cols-7">
          {playlists.map(playlist => (
            <button
              key={playlist.id}
              type="button"
              onClick={() => onOpenPlaylist({ id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl, platform: 'qq', source: 'qq-hall-zone' })}
              className="group w-full text-left"
            >
              <span className="relative block aspect-square overflow-hidden rounded-lg bg-white/[0.05]">
                <CachedImage src={playlist.coverUrl} alt={playlist.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" role="card" size={240} />
                <span className="absolute left-2 top-2 flex h-6 items-center gap-1 rounded-full bg-black/55 px-2 text-[11px] text-white/92 backdrop-blur">
                  <Headphones className="h-3 w-3" />{formatQQCount(playlist.playCount)}
                </span>
                <span className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lg transition group-hover:opacity-100"><Play className="h-3.5 w-3.5 fill-current" /></span>
              </span>
              <span className="mt-2 block line-clamp-2 text-sm font-medium text-white/88">{playlist.name}</span>
            </button>
          ))}
        </div>
      )}
    </PageFrame>
  )
}

// ─────────────────────────── 听歌报告（本地统计） ───────────────────────────

interface ReportStats {
  uniqueSongs: number
  totalPlays: number
  dayCounts: Array<{ date: string; count: number }>
  top: Array<{ name: string; artist: string; coverUrl: string; count: number }>
}

function ReportCurve({ dayCounts, accent }: { dayCounts: Array<{ date: string; count: number }>; accent: string }) {
  const max = Math.max(1, ...dayCounts.map(item => item.count))
  const width = 100
  const height = 34
  const step = dayCounts.length > 1 ? width / (dayCounts.length - 1) : width
  const points = dayCounts.map((item, index) => `${index * step},${height - (item.count / max) * (height - 4) - 2}`)
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-20 w-full" preserveAspectRatio="none" aria-hidden>
        <polyline points={points.join(' ')} fill="none" stroke={accent} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <polyline points={`0,${height} ${points.join(' ')} ${width},${height}`} fill={`${accent}22`} stroke="none" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-white/30">
        <span>{dayCounts[0]?.date.slice(5)}</span>
        <span>{dayCounts[dayCounts.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  )
}

export function QQListeningReportPanel({ accent, onBack }: { accent: string; onBack: () => void }) {
  const [range, setRange] = useState<'week' | 'month'>('week')
  const [stats, setStats] = useState<ReportStats | null>(null)
  useEffect(() => {
    let cancelled = false
    import('../../services/listeningLog').then(mod => { if (!cancelled) setStats(mod.getListeningStats(range)) })
    return () => { cancelled = true }
  }, [range])
  const hasData = Boolean(stats && stats.totalPlays > 0)
  return (
    <PageFrame title="听歌报告" onBack={onBack}
      tabs={(
        <div className="flex gap-2">
          {([['week', '本周'], ['month', '本月']] as const).map(([key, label]) => (
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
      {!hasData ? (
        <p className="py-10 text-center text-sm text-white/40">本地暂无播放记录，听几首歌曲后这里会生成你的听歌报告</p>
      ) : stats && (
        <div className="space-y-5">
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-4">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xs text-white/40">{range === 'week' ? '本周已听' : '本月已听'}</p>
                <p className="text-3xl font-bold text-white">{stats.uniqueSongs}<span className="ml-1 text-sm font-normal text-white/45">首</span></p>
              </div>
              <p className="text-xs text-white/40">总播放 {stats.totalPlays} 次</p>
            </div>
            <div className="mt-3">
              <ReportCurve dayCounts={stats.dayCounts} accent={accent} />
            </div>
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold text-white/85">最爱歌曲 TOP10</h4>
            <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03]">
              {stats.top.map((item, index) => (
                <div key={`${item.name}-${index}`} className="flex items-center gap-3 border-b border-white/[0.05] px-4 py-2.5 last:border-b-0">
                  <span className="w-5 shrink-0 text-center text-sm font-semibold" style={{ color: index < 3 ? accent : 'rgba(255,255,255,0.35)' }}>{index + 1}</span>
                  {item.coverUrl
                    ? <CachedImage src={item.coverUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" role="row" size={80} />
                    : <span className="h-9 w-9 shrink-0 rounded bg-white/[0.06]" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-white/88">{item.name}</span>
                    <span className="block truncate text-xs text-white/38">{item.artist}</span>
                  </span>
                  <span className="shrink-0 text-xs text-white/45">{item.count} 次</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-white/30">基于 WaveForge 本地播放记录统计（开始记录后累积）</p>
          </div>
        </div>
      )}
    </PageFrame>
  )
}
