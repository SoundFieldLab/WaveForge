import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  BarChart3,
  ChevronRight,
  Clock3,
  Disc3,
  Footprints,
  Library,
  Loader2,
  Music2,
  Palette,
  Play,
  RefreshCw,
  X,
} from 'lucide-react'
import type { Song } from '../services/musicApi'
import {
  fetchNeteaseJourneyOverview,
  type NeteaseJourneyOverview,
  type NeteaseJourneySong,
} from '../services/neteaseMusicJourney'

type JourneyTab = 'rank' | 'report' | 'preference' | 'archive'

interface NeteaseMusicJourneyProps {
  uid: string
  cookie: string
  accent: string
  showDescription: boolean
  onPlaySongs: (song: Song, songs: Song[]) => void
  onSongContextMenu: (event: MouseEvent, song: Song, songs: Song[]) => void
}

const LABELS: Record<string, string> = {
  listenTime: '收听时长',
  totalListenTime: '累计时长',
  playTime: '播放时长',
  playCount: '播放次数',
  songCount: '歌曲数',
  count: '次数',
  days: '听歌天数',
  listenDays: '听歌天数',
  activeDays: '活跃天数',
  level: '音乐等级',
  progress: '升级进度',
  nowPlayCount: '当前听歌量',
  nextPlayCount: '下级所需听歌量',
  createdPlaylistCount: '创建歌单',
  subPlaylistCount: '收藏歌单',
  artistCount: '收藏歌手',
  albumCount: '收藏专辑',
  mvCount: '收藏 MV',
  djRadioCount: '收藏播客',
  newProgramCount: '新增节目',
}

const TIME_KEYS = new Set(['listenTime', 'totalListenTime', 'playTime', 'duration', 'totalTime'])

function unwrap(value: any): any {
  let current = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) break
    if (current.data && typeof current.data === 'object') current = current.data
    else break
  }
  return current || {}
}

function findNumber(value: any, keys: string[]): number | null {
  if (!value || typeof value !== 'object') return null
  for (const key of keys) {
    const candidate = value[key]
    if (candidate !== '' && Number.isFinite(Number(candidate))) return Number(candidate)
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const found = findNumber(child, keys)
      if (found !== null) return found
    }
  }
  return null
}

function formatDuration(value: number): string {
  const seconds = value > 100_000 ? Math.round(value / 1000) : Math.round(value)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.max(1, Math.round((seconds % 3600) / 60))
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`
}

function formatMetric(key: string, value: number): string {
  if (TIME_KEYS.has(key)) return formatDuration(value)
  if (key === 'progress' && value <= 1) return `${Math.round(value * 100)}%`
  return new Intl.NumberFormat('zh-CN').format(value)
}

function collectMetrics(value: any, limit = 8): Array<{ key: string; label: string; value: string }> {
  const result: Array<{ key: string; label: string; value: string }> = []
  const seen = new Set<string>()
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 4 || result.length >= limit) return
    for (const [key, raw] of Object.entries(node)) {
      if (result.length >= limit) break
      if (LABELS[key] && raw !== '' && Number.isFinite(Number(raw)) && !seen.has(key)) {
        seen.add(key)
        result.push({ key, label: LABELS[key], value: formatMetric(key, Number(raw)) })
      }
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === 'object' && !Array.isArray(child)) visit(child, depth + 1)
    }
  }
  visit(value, 0)
  return result
}

interface PreferenceItem { name: string; value?: number; description?: string }

function collectPreferences(value: any): PreferenceItem[] {
  const result: PreferenceItem[] = []
  const seen = new Set<string>()
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 5 || result.length >= 24) return
    if (Array.isArray(node)) {
      for (const item of node) {
        if (!item || typeof item !== 'object') continue
        const name = String(item.tagName || item.name || item.styleName || item.title || item.label || '').trim()
        if (name && name.length <= 30 && !seen.has(name)) {
          seen.add(name)
          const numeric = item.ratio ?? item.score ?? item.value ?? item.preference ?? item.weight
          result.push({
            name,
            value: Number.isFinite(Number(numeric)) ? Number(numeric) : undefined,
            description: String(item.desc || item.description || item.subTitle || '').trim() || undefined,
          })
        }
        visit(item, depth + 1)
      }
      return
    }
    for (const child of Object.values(node)) visit(child, depth + 1)
  }
  visit(value, 0)
  return result
}

function SongList({
  songs,
  empty,
  onPlaySongs,
  onSongContextMenu,
}: {
  songs: NeteaseJourneySong[]
  empty: string
  onPlaySongs: NeteaseMusicJourneyProps['onPlaySongs']
  onSongContextMenu: NeteaseMusicJourneyProps['onSongContextMenu']
}) {
  if (songs.length === 0) return <EmptyState text={empty} />
  return (
    <div className="overflow-hidden rounded-[24px] border border-white/[0.08] bg-white/[0.035]">
      {songs.map((song, index) => (
        <button
          key={`${song.id}-${index}`}
          type="button"
          onClick={() => onPlaySongs(song, songs)}
          onContextMenu={event => onSongContextMenu(event, song, songs)}
          className="group flex w-full items-center gap-3 border-b border-white/[0.06] px-4 py-3 text-left transition last:border-0 hover:bg-white/[0.06]"
        >
          <span className="w-7 shrink-0 text-center text-xs font-semibold text-white/30">{song.rank || index + 1}</span>
          <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-white/[0.06]">
            {song.album.picUrl ? <img src={song.album.picUrl} alt="" className="h-full w-full object-cover" loading="lazy" /> : <Music2 className="m-3 h-5 w-5 text-white/30" />}
            <span className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100"><Play className="h-4 w-4 fill-current" /></span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-white/86">{song.name}</div>
            <div className="mt-0.5 truncate text-xs text-white/38">{song.artists.map(artist => artist.name).join(' / ')}</div>
          </div>
          {song.playCount ? <span className="shrink-0 text-xs text-white/34">{song.playCount} 次</span> : null}
        </button>
      ))}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-[24px] border border-white/[0.08] bg-white/[0.035] px-6 py-12 text-center text-sm text-white/42">{text}</div>
}

function Metrics({ items }: { items: Array<{ key: string; label: string; value: string }> }) {
  if (items.length === 0) return null
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(item => (
        <div key={item.key} className="rounded-2xl border border-white/[0.08] bg-white/[0.035] p-4">
          <div className="text-xs text-white/38">{item.label}</div>
          <div className="mt-2 text-lg font-semibold text-white/88">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

export default function NeteaseMusicJourney({
  uid,
  cookie,
  accent,
  showDescription,
  onPlaySongs,
  onSongContextMenu,
}: NeteaseMusicJourneyProps) {
  const [overview, setOverview] = useState<NeteaseJourneyOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<JourneyTab | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void fetchNeteaseJourneyOverview(uid, cookie, controller.signal)
      .then(setOverview)
      .catch(requestError => {
        if ((requestError as Error).name !== 'AbortError') setError(requestError instanceof Error ? requestError.message : '网易云音乐旅程加载失败')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [uid, cookie, revision])

  const preferences = useMemo(() => collectPreferences(overview?.preference?.data), [overview?.preference?.data])
  const reportMetrics = useMemo(() => collectMetrics({ total: overview?.report?.total, period: overview?.report?.period }), [overview?.report])
  const archiveMetrics = useMemo(() => collectMetrics({ level: overview?.archive?.level, subcount: overview?.archive?.subcount }, 12), [overview?.archive])
  const totalDuration = findNumber(overview?.report?.total, ['totalListenTime', 'listenTime', 'playTime', 'duration'])
  const level = findNumber(overview?.archive?.level, ['level'])

  const cards = [
    { id: 'rank' as const, title: '累计听歌排行', copy: overview?.rank.songs[0] ? `最常听：${overview.rank.songs[0].name}` : '全部时间最常听的歌曲', icon: BarChart3 },
    { id: 'report' as const, title: '听歌足迹', copy: totalDuration !== null ? `累计收听 ${formatDuration(totalDuration)}` : '收听时长、次数与阶段排行', icon: Footprints },
    { id: 'preference' as const, title: '曲风偏好', copy: preferences.length ? preferences.slice(0, 3).map(item => item.name).join(' · ') : '查看账号真实音乐风格标签', icon: Palette },
    { id: 'archive' as const, title: '音乐档案', copy: level !== null ? `网易云音乐等级 Lv.${level}` : '等级、歌单与收藏统计', icon: Library },
  ]

  const activeError = tab
    ? overview?.[tab === 'preference' ? 'preference' : tab]?.error
    : ''

  return (
    <>
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <Disc3 className="h-5 w-5" style={{ color: accent }} />
            <h2 className="text-xl font-semibold tracking-tight md:text-2xl">网易云音乐旅程</h2>
          </div>
          {showDescription && <p className="mt-1.5 text-sm text-white/45">累计听歌排行、真实足迹、曲风偏好与账号音乐档案</p>}
        </div>
        <button type="button" onClick={() => setRevision(value => value + 1)} disabled={loading} className="rounded-full border border-white/[0.08] bg-white/[0.04] p-2 text-white/42 transition hover:bg-white/[0.09] hover:text-white disabled:opacity-40" aria-label="刷新网易云音乐旅程">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && !overview ? (
        <div className="rounded-[24px] border border-rose-300/15 bg-rose-300/[0.06] p-5 text-sm text-rose-100/72">{error}</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map(({ id, title, copy, icon: Icon }) => (
            <motion.button key={id} type="button" whileHover={{ y: -3 }} onClick={() => setTab(id)} className="group flex min-h-32 flex-col rounded-[22px] border border-white/[0.08] bg-white/[0.04] p-5 text-left transition hover:bg-white/[0.07]">
              <div className="flex items-center justify-between">
                {loading ? <Loader2 className="h-5 w-5 animate-spin" style={{ color: accent }} /> : <Icon className="h-5 w-5" style={{ color: accent }} />}
                <ChevronRight className="h-4 w-4 text-white/24 transition group-hover:translate-x-0.5 group-hover:text-white/65" />
              </div>
              <strong className="mt-auto text-sm font-semibold">{title}</strong>
              <span className="mt-1 line-clamp-1 text-xs text-white/38">{loading ? '正在读取账号数据…' : copy}</span>
            </motion.button>
          ))}
        </div>
      )}

      <AnimatePresence>
        {tab && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[205] bg-[#080b11]/98 text-white backdrop-blur-2xl">
            <div className="flex h-full flex-col pt-8">
              <div className="flex items-center gap-3 border-b border-white/[0.08] px-5 py-4 md:px-8">
                <Disc3 className="h-5 w-5" style={{ color: accent }} />
                <h2 className="text-xl font-semibold">网易云音乐旅程</h2>
                <div className="ml-4 hidden rounded-xl bg-white/[0.045] p-1 md:flex">
                  {cards.map(card => <button key={card.id} type="button" onClick={() => setTab(card.id)} className={`rounded-lg px-3 py-1.5 text-xs transition ${tab === card.id ? 'bg-white/[0.12] text-white' : 'text-white/42 hover:text-white/70'}`}>{card.title}</button>)}
                </div>
                <button type="button" onClick={() => setTab(null)} className="ml-auto rounded-xl bg-white/[0.05] p-2 text-white/50 hover:text-white" aria-label="关闭网易云音乐旅程"><X className="h-5 w-5" /></button>
              </div>
              <div className="explore-scrollbar flex-1 overflow-y-auto px-5 py-6 md:px-8">
                <div className="mx-auto max-w-5xl space-y-5">
                  <div className="flex items-center gap-3 md:hidden">
                    {cards.map(card => <button key={card.id} type="button" onClick={() => setTab(card.id)} className={`rounded-full px-3 py-1.5 text-xs ${tab === card.id ? 'text-[#071018]' : 'border border-white/[0.08] text-white/48'}`} style={tab === card.id ? { background: accent } : undefined}>{card.title}</button>)}
                  </div>
                  {loading ? <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-white/42"><Loader2 className="h-4 w-4 animate-spin" />正在读取网易云账号旅程…</div> : null}
                  {!loading && activeError ? <div className="rounded-2xl bg-amber-300/[0.08] p-4 text-sm text-amber-100/70">部分官方数据暂不可用：{activeError}</div> : null}
                  {!loading && tab === 'rank' ? <SongList songs={overview?.rank.songs || []} empty="网易云暂未返回累计听歌排行，可能是听歌量不足或隐私设置限制。" onPlaySongs={onPlaySongs} onSongContextMenu={onSongContextMenu} /> : null}
                  {!loading && tab === 'report' ? (
                    <>
                      <Metrics items={reportMetrics} />
                      <section>
                        <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><Clock3 className="h-4 w-4" style={{ color: accent }} />本月常听</div>
                        <SongList songs={(overview?.report.monthlySongs || []).slice(0, 20)} empty="本月还没有可展示的歌曲排行。" onPlaySongs={onPlaySongs} onSongContextMenu={onSongContextMenu} />
                      </section>
                    </>
                  ) : null}
                  {!loading && tab === 'preference' ? (
                    preferences.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{preferences.map((item, index) => <div key={`${item.name}-${index}`} className="rounded-[22px] border border-white/[0.08] bg-white/[0.035] p-5"><div className="flex items-center justify-between gap-3"><strong className="text-white/86">{item.name}</strong>{item.value !== undefined ? <span className="text-xs" style={{ color: accent }}>{item.value <= 1 ? `${Math.round(item.value * 100)}%` : Math.round(item.value)}</span> : null}</div>{item.description ? <p className="mt-2 text-xs leading-relaxed text-white/38">{item.description}</p> : null}</div>)}</div> : <EmptyState text="网易云暂未返回曲风偏好标签，积累更多听歌记录后再来看看。" />
                  ) : null}
                  {!loading && tab === 'archive' ? <>{archiveMetrics.length ? <Metrics items={archiveMetrics} /> : <EmptyState text="网易云暂未返回账号音乐档案。" />}</> : null}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
