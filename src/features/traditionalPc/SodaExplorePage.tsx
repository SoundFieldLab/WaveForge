// 汽水音乐「探索页」——手机端内容 + 桌面版式（独立设计，不用通用探索模板）。
//
// 为什么这么做：传统模式复刻的是**电脑客户端**；探索页承载的是**手机端**的内容
// （手机端功能更全）。所以数据来自手机端发现页/听抖音的通道，排版按桌面宽屏重新编排。
//
// 覆盖的手机端版块（已剔除广告类：福利、活动中心、订单/会员/看视频领时长）：
//   · 今日声场 / 每日推荐        ← /api/soda/daily
//   · 模式探索（整张场景网格）    ← /api/soda/feed-mode?full=1（手机端「模式探索」）
//   · 为你推荐，每天来点新模式    ← /api/soda/discover（手机端发现页卡片网格）
//   · 歌单广场                  ← /api/soda/playlist-square
//   · 适合「听」的视频（听抖音）  ← /api/soda/listen-video
//   · 排行榜                    ← /api/soda/charts
//   · 我的音乐（我喜欢/抖音收藏/历史播放） ← /api/soda/user/playlists
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Disc3, Heart, Loader2, Music2, Play, Radio, RefreshCw, Sparkles, TrendingUp, Video } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { getProxiedImageUrl } from '../../services/musicApi'
import {
  fetchSodaAllSceneModes,
  fetchSodaDaily,
  fetchSodaDiscoverMix,
  fetchSodaCharts,
  fetchSodaExploreSections,
  fetchSodaListenVideos,
  fetchSodaPlaylistSquare,
  fetchSodaRadioTracks,
  fetchSodaRecentSongs,
  fetchSodaPlaylistTracks,
  fetchSodaSceneTracks,
  fetchSodaUserPlaylists,
  type SodaChartGroup,
  type SodaExploreCard,
  type SodaListenVideo,
  type SodaSceneMode,
  type SodaSquarePlaylist,
} from '../../services/sodaService'

export interface SodaExplorePageProps {
  accent: string
  isDark: boolean
  active: boolean
  loggedIn: boolean
  username?: string
  currentSong?: Song | null
  isPlaying?: boolean
  /** 播放一批歌（索引 0 起播，队列=整批） */
  onPlaySongs: (song: Song, songs: Song[]) => void
  onOpenPlaylist: (playlist: any) => void
  onOpenChart?: (chart: any) => void
  onOpenSearch: () => void
  onLoginClick: () => void
  authRevision?: number
}

function SodaExplorePage({
  accent, isDark, active, loggedIn, username, currentSong, isPlaying,
  onPlaySongs, onOpenPlaylist, onOpenChart, onOpenSearch, onLoginClick, authRevision,
}: SodaExplorePageProps) {
  const [daily, setDaily] = useState<{ songs: Song[]; personalized: boolean }>({ songs: [], personalized: false })
  const [modes, setModes] = useState<SodaSceneMode[]>([])
  const [sections, setSections] = useState<Array<{ title: string; cards: SodaExploreCard[] }>>([])
  const [square, setSquare] = useState<SodaSquarePlaylist[]>([])
  const [videos, setVideos] = useState<SodaListenVideo[]>([])
  const [charts, setCharts] = useState<Array<SodaChartGroup & { songs: Song[] }>>([])
  const [mixItems, setMixItems] = useState<SodaExploreCard[]>([])
  const [likedPlaylist, setLikedPlaylist] = useState<any>(null)
  const [douyinPlaylist, setDouyinPlaylist] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [busyKey, setBusyKey] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!active && revision === 0) return
    let cancelled = false
    setLoading(true)
    const jobs: Array<Promise<void>> = [
      fetchSodaDaily().then(r => { if (!cancelled) setDaily(r) }).catch(() => undefined),
      fetchSodaAllSceneModes().then(list => { if (!cancelled) setModes(list) }).catch(() => undefined),
      fetchSodaCharts().then(list => { if (!cancelled) setCharts(list) }).catch(() => undefined),
      fetchSodaDiscoverMix().then(r => { if (!cancelled) setMixItems(r.items) }).catch(() => undefined),
      fetchSodaPlaylistSquare().then(r => { if (!cancelled) setSquare(r.items) }).catch(() => undefined),
    ]
    if (loggedIn) {
      jobs.push(fetchSodaExploreSections().then(list => {
        if (!cancelled) setSections(list.map(s => ({ title: s.title, cards: s.cards })))
      }).catch(() => undefined))
      jobs.push(fetchSodaListenVideos(12).then(list => { if (!cancelled) setVideos(list) }).catch(() => undefined))
      jobs.push(fetchSodaUserPlaylists().then(list => {
        if (cancelled) return
        setLikedPlaylist(list.find(p => p.isLikedLike || Number(p.type) === 1) || null)
        setDouyinPlaylist(list.find(p => Number(p.type) === 4 || /抖音/.test(String(p.name))) || null)
      }).catch(() => undefined))
    }
    void Promise.allSettled(jobs).then(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, loggedIn, authRevision, revision])

  const muted = isDark ? 'text-white/50' : 'text-slate-500'
  const text = isDark ? 'text-white' : 'text-slate-900'
  const cardBg = isDark ? 'rgba(255,255,255,.05)' : 'rgba(15,23,42,.04)'
  const hoverBg = isDark ? 'rgba(255,255,255,.09)' : 'rgba(15,23,42,.07)'

  /** 场景/电台/歌单卡片 → 拉歌起播（复用听歌模式同一套通道） */
  const playCard = useCallback(async (card: SodaExploreCard) => {
    const key = card.resourceId
    setBusyKey(key)
    try {
      const songs = card.type === 'radio'
        ? (await fetchSodaRadioTracks(card.resourceId, { link: card.link })).songs
        : (await fetchSodaPlaylistTracks(card.resourceId, 0, 50)).tracks || []
      if (songs.length) onPlaySongs(songs[0], songs)
      else window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '这个内容暂时没有拉到歌曲', type: 'info' } }))
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '加载失败，请稍后再试', type: 'info' } }))
    } finally {
      setBusyKey('')
    }
  }, [onPlaySongs])

  const playScene = useCallback(async (mode: SodaSceneMode) => {
    setBusyKey(mode.subQueueType)
    try {
      const r = await fetchSodaSceneTracks({ sceneModeId: mode.sceneModeId, preferenceMode: mode.preferenceMode, limit: 20 })
      if (r.songs.length) {
        if (mode.cutoverToast) window.dispatchEvent(new CustomEvent('showToast', { detail: { message: mode.cutoverToast, type: 'success' } }))
        onPlaySongs(r.songs[0], r.songs)
      } else {
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '这个场景暂时没有拉到歌曲', type: 'info' } }))
      }
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '场景加载失败，请稍后再试', type: 'info' } }))
    } finally {
      setBusyKey('')
    }
  }, [onPlaySongs])

  /** 快捷入口：歌单类直接打开；「历史播放」自取最近播放并起播（探索页没有传统页的历史栈，不派发无人接的事件） */
  const openQuickEntry = useCallback(async (entry: { key: string; playlist: any }) => {
    if (entry.playlist) { onOpenPlaylist(entry.playlist); return }
    if (entry.key !== 'recent') return
    setBusyKey('recent')
    try {
      const songs = await fetchSodaRecentSongs(50)
      if (songs.length) onPlaySongs(songs[0], songs)
      else window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '暂无最近播放记录', type: 'info' } }))
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '最近播放加载失败', type: 'info' } }))
    } finally { setBusyKey('') }
  }, [onOpenPlaylist, onPlaySongs])

  const hero = daily.songs[0]
  const heroCover = hero?.album?.picUrl ? getProxiedImageUrl(hero.album.picUrl, 700) : ''
  const quickEntries = useMemo(() => ([
    likedPlaylist ? { key: 'liked', label: '我喜欢的音乐', icon: Heart, count: likedPlaylist.trackCount, playlist: likedPlaylist } : null,
    douyinPlaylist ? { key: 'douyin', label: '抖音收藏的音乐', icon: Music2, count: douyinPlaylist.trackCount, playlist: douyinPlaylist } : null,
    { key: 'recent', label: '历史播放', icon: Clock, count: 0, playlist: null },
  ].filter(Boolean) as Array<{ key: string; label: string; icon: typeof Heart; count?: number; playlist: any }>), [likedPlaylist, douyinPlaylist])

  const sectionTitle = (icon: React.ReactNode, title: string, extra?: React.ReactNode) => (
    <div className="mb-3 flex items-center gap-2">
      <span style={{ color: accent }}>{icon}</span>
      <h2 className={`text-base font-semibold ${text}`}>{title}</h2>
      <div className="ml-auto flex items-center gap-2">{extra}</div>
    </div>
  )

  return (
    <div data-soda-explore="" className="mx-auto w-full max-w-[1500px] px-6 py-6">
      {/* 顶部：标题 + 搜索入口 + 换一批 */}
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <div className={`flex items-center gap-2 text-xs ${muted}`}>
            <Sparkles className="h-3.5 w-3.5" style={{ color: accent }} />
            汽水音乐 · 今日声场
          </div>
          <h1 className={`mt-1 text-2xl font-semibold ${text}`}>
            夜深了，听点轻柔的{username ? `，${username}` : ''}
          </h1>
          <p className={`mt-1 text-xs ${muted}`}>已结合你的口味、近期热度与平台新鲜内容生成。</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenSearch}
            className={`flex h-9 items-center gap-2 rounded-full px-4 text-xs ${text}`}
            style={{ background: cardBg }}
          >
            <Music2 className="h-3.5 w-3.5" />
            搜索歌手、歌曲或专辑
          </button>
          <button
            type="button"
            onClick={() => setRevision(v => v + 1)}
            className={`flex h-9 items-center gap-2 rounded-full px-4 text-xs ${text}`}
            style={{ background: cardBg }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            换一批
          </button>
        </div>
      </div>

      {/* 今日声场 hero：每日推荐第一首 */}
      {hero ? (
        <div className="relative overflow-hidden rounded-3xl" style={{ minHeight: 260 }}>
          {heroCover && <img src={heroCover} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          <div className="absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,.55) 42%, rgba(0,0,0,.18) 100%)' }} />
          <div className="relative flex h-full min-h-[260px] flex-col justify-center gap-3 p-8">
            <span className="w-fit rounded-full px-2.5 py-1 text-[11px] font-medium text-white" style={{ background: 'rgba(255,255,255,.18)' }}>
              {daily.personalized ? '专属 Daily Mix' : 'Daily Mix'}
            </span>
            <div className="text-sm text-white/75">{hero.artists?.map(a => a.name).filter(Boolean).join(' / ')}</div>
            <div className="text-3xl font-bold text-white">{hero.name}</div>
            <p className="max-w-xl text-xs text-white/70">从你的偏好、今日趋势和新鲜发行中，挑出此刻最值得播放的一首。</p>
            <div className="mt-1 flex items-center gap-3">
              <button
                type="button"
                onClick={() => onPlaySongs(hero, daily.songs)}
                className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white"
                style={{ background: accent }}
              >
                <Play className="h-4 w-4 fill-current" />
                立即播放
              </button>
              <button
                type="button"
                onClick={() => onPlaySongs(daily.songs[Math.min(daily.songs.length - 1, 1)] || hero, daily.songs)}
                className="rounded-full px-4 py-2.5 text-xs text-white/85"
                style={{ background: 'rgba(255,255,255,.14)' }}
              >
                {daily.songs.length} 首连续推荐
              </button>
            </div>
          </div>
        </div>
      ) : loading ? (
        <div className="h-[260px] animate-pulse rounded-3xl" style={{ background: cardBg }} />
      ) : null}

      {/* 我的音乐快捷入口（手机端「我的」的歌单入口，去掉福利/会员那些） */}
      {loggedIn && quickEntries.length > 0 && (
        <div className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {quickEntries.map(entry => (
            <button
              key={entry.key}
              type="button"
              onClick={() => { void openQuickEntry(entry) }}
              className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-left transition ${text}`}
              style={{ background: cardBg }}
              onMouseEnter={e => { e.currentTarget.style.background = hoverBg }}
              onMouseLeave={e => { e.currentTarget.style.background = cardBg }}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: `${accent}22` }}>
                <entry.icon className="h-4 w-4" style={{ color: accent }} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm">{entry.label}</span>
                {entry.count ? <span className={`block text-[11px] ${muted}`}>{entry.count} 首</span> : null}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 模式探索：手机端整张场景网格（PC 端「听歌模式」只给 6 个，这里是全量） */}
      {modes.length > 0 && (
        <section className="mt-8">
          {sectionTitle(<Sparkles className="h-4 w-4" />, '模式探索', (
            <span className={`text-xs ${muted}`}>{modes.length} 个场景</span>
          ))}
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
            {modes.map(mode => (
              <button
                key={mode.subQueueType || mode.text}
                type="button"
                onClick={() => { void playScene(mode) }}
                disabled={busyKey === mode.subQueueType}
                className={`group flex h-11 items-center gap-2 rounded-xl px-3 text-left transition disabled:opacity-60 ${text}`}
                style={{ background: cardBg }}
                onMouseEnter={e => { e.currentTarget.style.background = hoverBg }}
                onMouseLeave={e => { e.currentTarget.style.background = cardBg }}
              >
                {busyKey === mode.subQueueType
                  ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  : mode.iconUrl
                    ? <img src={getProxiedImageUrl(mode.iconUrl, 40)} alt="" className="h-4 w-4 shrink-0" />
                    : <Music2 className="h-4 w-4 shrink-0 opacity-60" />}
                <span className="min-w-0 flex-1 truncate text-[13px]">{mode.text}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 为你推荐，每天来点新模式（手机端发现页卡片网格） */}
      {sections.map(section => (
        <section key={section.title} className="mt-8">
          {sectionTitle(<Disc3 className="h-4 w-4" />, section.title || '为你推荐')}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {section.cards.map(card => (
              <button
                key={card.innerBlockId || card.resourceId}
                type="button"
                onClick={() => { void playCard(card) }}
                disabled={busyKey === card.resourceId}
                className="group relative overflow-hidden rounded-2xl text-left transition disabled:opacity-70"
                style={{ aspectRatio: '3 / 2', background: card.backgroundColor || cardBg }}
              >
                {card.coverUrl && (
                  <img
                    src={getProxiedImageUrl(card.coverUrl, 400)}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]"
                  />
                )}
                <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,.66) 100%)' }} />
                <span className="absolute inset-x-0 bottom-0 p-3">
                  <span className="block truncate text-[15px] font-bold text-white">{card.title}</span>
                  {card.desc && <span className="mt-0.5 block truncate text-[11px] text-white/75">{card.desc}</span>}
                </span>
                {card.type === 'radio' && <Radio className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-white/85" />}
                {busyKey === card.resourceId && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <Loader2 className="h-5 w-5 animate-spin text-white" />
                  </span>
                )}
                <span className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-900 opacity-0 shadow-lg transition group-hover:opacity-100">
                  <Play className="h-4 w-4 fill-current" />
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {/* 探索电台（DiscoverMix 翻页源，作为补充栏） */}
      {mixItems.length > 0 && (
        <section className="mt-8">
          {sectionTitle(<Radio className="h-4 w-4" />, '继续探索电台', (
            <span className={`text-xs ${muted}`}>{mixItems.length} 个</span>
          ))}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {mixItems.slice(0, 12).map(card => (
              <button
                key={card.innerBlockId || card.resourceId}
                type="button"
                onClick={() => { void playCard(card) }}
                disabled={busyKey === card.resourceId}
                className="group relative overflow-hidden rounded-2xl text-left transition disabled:opacity-70"
                style={{ aspectRatio: '3 / 2', background: card.backgroundColor || cardBg }}
              >
                {card.coverUrl && (
                  <img src={getProxiedImageUrl(card.coverUrl, 400)} alt="" className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]" />
                )}
                <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,.66) 100%)' }} />
                <span className="absolute inset-x-0 bottom-0 p-3">
                  <span className="block truncate text-[14px] font-bold text-white">{card.title}</span>
                  {card.desc && <span className="mt-0.5 block truncate text-[11px] text-white/75">{card.desc}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 适合「听」的视频（手机端听抖音内容） */}
      {videos.length > 0 && (
        <section className="mt-8">
          {sectionTitle(<Video className="h-4 w-4" />, '适合「听」的视频', (
            <span className={`text-xs ${muted}`}>来自手机端听抖音</span>
          ))}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {videos.map(video => (
              <div key={video.id} className={`overflow-hidden rounded-2xl ${text}`} style={{ background: cardBg }}>
                <div className="relative" style={{ aspectRatio: '3 / 4' }}>
                  {video.coverUrl
                    ? <img src={getProxiedImageUrl(video.coverUrl, 400)} alt="" className="h-full w-full object-cover" />
                    : <div className="flex h-full w-full items-center justify-center"><Video className={`h-6 w-6 ${muted}`} /></div>}
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white tabular-nums">
                    {Math.floor(video.durationMs / 60000)}:{String(Math.floor((video.durationMs % 60000) / 1000)).padStart(2, '0')}
                  </span>
                </div>
                <div className="p-2.5">
                  <div className="line-clamp-2 text-[12px] leading-snug">{video.title}</div>
                  {video.authorName && <div className={`mt-1 truncate text-[11px] ${muted}`}>{video.authorName}</div>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 歌单广场 */}
      {square.length > 0 && (
        <section className="mt-8">
          {sectionTitle(<Disc3 className="h-4 w-4" />, '歌单广场', (
            <span className={`text-xs ${muted}`}>{square.length} 个歌单</span>
          ))}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
            {square.slice(0, 12).map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpenPlaylist({ id: item.id, name: item.title, coverUrl: item.coverUrl, platform: 'soda', trackCount: item.trackCount })}
                className={`group overflow-hidden rounded-2xl text-left transition ${text}`}
                style={{ background: cardBg }}
              >
                <div className="relative" style={{ aspectRatio: '1 / 1' }}>
                  {item.coverUrl && <img src={getProxiedImageUrl(item.coverUrl, 400)} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.04]" />}
                  <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white">
                    {item.collectCount >= 10000 ? `${(item.collectCount / 10000).toFixed(1)}万` : item.collectCount} 收藏
                  </span>
                </div>
                <div className="p-2.5">
                  <div className="line-clamp-2 text-[12px] leading-snug">{item.title}</div>
                  <div className={`mt-1 text-[11px] ${muted}`}>{item.creator || '汽水音乐'} · {item.trackCount} 首</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* 排行榜 */}
      {charts.length > 0 && (
        <section className="mt-8">
          {sectionTitle(<TrendingUp className="h-4 w-4" />, '排行榜')}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {charts.map(chart => {
              const cover = chart.songs?.[0]?.album?.picUrl ? getProxiedImageUrl(chart.songs[0].album.picUrl, 300) : ''
              return (
                <button
                  key={chart.id}
                  type="button"
                  onClick={() => {
                    if (onOpenChart) onOpenChart(chart)
                    else if (chart.songs?.length) onPlaySongs(chart.songs[0], chart.songs)
                  }}
                  className={`group flex items-center gap-3 rounded-2xl p-3 text-left transition ${text}`}
                  style={{ background: cardBg }}
                >
                  <span className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl">
                    {cover ? <img src={cover} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" /> : <span className="flex h-full w-full items-center justify-center" style={{ background: `${accent}22` }}><TrendingUp className="h-5 w-5" style={{ color: accent }} /></span>}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{chart.name}</span>
                    <span className={`block truncate text-[11px] ${muted}`}>{chart.description || `${chart.songs?.length || 0} 首`}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {!loggedIn && (
        <div className={`mt-8 flex items-center justify-between rounded-2xl px-5 py-4 ${text}`} style={{ background: cardBg }}>
          <div>
            <div className="text-sm font-medium">登录后解锁完整探索内容</div>
            <div className={`mt-0.5 text-xs ${muted}`}>模式探索 / 为你推荐 / 适合「听」的视频 / 我的音乐需要汽水账号</div>
          </div>
          <button type="button" onClick={onLoginClick} className="shrink-0 rounded-full px-4 py-2 text-xs font-medium text-white" style={{ background: accent }}>
            登录汽水音乐
          </button>
        </div>
      )}
    </div>
  )
}

export default memo(SodaExplorePage)
