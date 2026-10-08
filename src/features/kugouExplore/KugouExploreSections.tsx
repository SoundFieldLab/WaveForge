/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 酷狗探索页官方五板块：推荐 / 乐库 / 歌单 / 频道 / 分类。
 * 仅 kugou 平台渲染（ExploreView 里按平台分支挂载），布局对齐酷狗官方客户端
 * （见 D:\opencode\.tmp-kg-tab-tuijian.png、.tmp-kg-tab-yueku.png）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  ChevronRight,
  Disc3,
  Headphones,
  Loader2,
  Mic2,
  Music2,
  Play,
  Radio,
  RefreshCw,
  Sparkles,
  Trophy,
} from 'lucide-react'
import type { ExploreChart, ExplorePayload, ExplorePlaylist } from '../../services/exploreApi'
import type { ExploreSectionId } from '../../components/ExploreSettingsPanel'
import { fetchKugouTagPlaylists } from '../../services/exploreApi'
import type { Song } from '../../services/musicApi'
import CachedImage from '../../components/CachedImage'
import type { ExplorePlatform } from '../../services/exploreApi'

const formatCount = (value?: number) => {
  const count = Number(value || 0)
  if (!count) return ''
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(count >= 1_000_000_000 ? 0 : 1)}亿`
  if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 1_000_000 ? 0 : 1)}万`
  return String(count)
}

const KgCover = memo(function KgCover({ src, alt, className = '', iconClassName = 'h-5 w-5' }: { src?: string; alt: string; className?: string; iconClassName?: string }) {
  return (
    <CachedImage
      src={src || ''}
      alt={alt}
      className={className}
      draggable={false}
      lazy
      role="card"
      priority="visible"
      fallback={<div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,rgba(255,122,0,0.85),rgba(20,184,166,0.6))] text-white/80"><Music2 className={iconClassName} /></div>}
    />
  )
})

function KgSectionHeading({ icon, title, subtitle, action }: { icon: ReactNode; title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <div className="flex items-center gap-2.5 text-white">
          <span className="text-white/70">{icon}</span>
          <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
        </div>
        {subtitle && <p className="mt-1.5 text-sm text-white/45">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

function KgMoreButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-white/48 transition hover:bg-white/[0.09] hover:text-white"
      aria-label={`查看更多${label}`}
    >
      更多 <ChevronRight className="h-3.5 w-3.5" />
    </button>
  )
}

function KgBoardState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[24px] border border-white/[0.07] bg-white/[0.03] px-6 py-10 text-center">
      <span className="mb-3 text-white/25">{icon}</span>
      <p className="text-sm font-medium text-white/70">{title}</p>
      {hint && <p className="mt-1.5 max-w-md text-xs leading-relaxed text-white/38">{hint}</p>}
      {action}
    </div>
  )
}

export interface KugouExploreHandlers {
  onPlaySongs: (song: Song, songs: Song[], continuous?: boolean) => void
  onSongSelect: (song: Song, songs: Song[]) => void
  onOpenPlaylist: (playlist: ExplorePlaylist, autoplay?: boolean) => void
  onOpenAlbum?: (albumId: string, platform: ExplorePlatform) => void
  onOpenArtist?: (artistId: string, platform: ExplorePlatform) => void
  onSongContextMenu: (event: React.MouseEvent, song: Song, songs: Song[]) => void
  onOpenMoreSection: (section: ExploreSectionId) => void
  /** 频道条目没有可解析的曲目接口：点击后用频道名发起酷狗搜索（真实可用动作） */
  onOpenSearch?: (keyword: string) => void
  onRetry: () => void
}

interface KugouBoardProps extends KugouExploreHandlers {
  payload: ExplorePayload
  accent: string
  accentRgb: string
  compactCards: boolean
  showDescriptions: boolean
  expandedHome: boolean
  exploreCardBg: string
  /** 说明文字（在酷狗官方截图里对应卡片副标题）；关闭时只留主标题 */
  showSubtitles: boolean
  sectionStyle: (section: ExploreSectionId) => CSSProperties
  /** 复用探索页的区块显隐判定（用户偏好 + 平台能力 + 数据可用性）：隐藏的板块不渲染 */
  sectionVisible: (section: ExploreSectionId) => boolean
}

// ─────────────────────────── 推荐（官方五张大卡 + 今日专属推荐） ───────────────────────────

function BigCard({
  label,
  badge,
  title,
  subtitle,
  cover,
  accent,
  accentRgb,
  onClick,
  onPlay,
}: {
  label: string
  badge: string
  title: string
  subtitle?: string
  cover?: string
  accent: string
  accentRgb: string
  onClick: () => void
  onPlay?: () => void
}) {
  return (
    <motion.div
      whileHover={{ y: -4 }}
      className="group relative min-h-52 cursor-pointer overflow-hidden rounded-[24px] border border-white/[0.08] bg-white/[0.045] text-left"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') onClick()
      }}
    >
      <KgCover src={cover} alt={title} className="absolute inset-0 h-full w-full object-cover opacity-72 transition duration-500 group-hover:scale-105" />
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(0deg, rgba(6,8,13,0.96) 0%, rgba(6,8,13,0.36) 68%), linear-gradient(135deg, rgba(${accentRgb}, 0.16), transparent)` }}
      />
      <div className="relative flex h-full flex-col p-4">
        <div className="flex items-center justify-between">
          <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold text-[#081017]" style={{ background: accent }}>{label}</span>
          <span className="rounded-full border border-white/[0.16] bg-black/30 px-2 py-0.5 text-[10px] text-white/62">{badge}</span>
        </div>
        <div className="mt-auto">
          <h3 className="line-clamp-2 text-base font-semibold leading-snug">{title}</h3>
          {subtitle && <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-white/48">{subtitle}</p>}
        </div>
        {onPlay && (
          <button
            type="button"
            onClick={event => {
              event.stopPropagation()
              onPlay()
            }}
            className="absolute bottom-3 right-3 flex h-9 w-9 translate-y-1 items-center justify-center rounded-full text-[#081017] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"
            style={{ background: accent }}
            aria-label={`播放${title}`}
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
        )}
      </div>
    </motion.div>
  )
}

export function KugouDiscoverBoard(props: KugouBoardProps) {
  const { payload, accent, accentRgb, showSubtitles, onPlaySongs, onOpenPlaylist, onOpenMoreSection } = props
  const kugou = payload.kugou
  const dailySongs = kugou?.dailySongs.length ? kugou.dailySongs : payload.dailySongs
  const charts: ExploreChart[] = payload.charts
  const guessPlaylists = useMemo(() => {
    const merged = [...(kugou?.yueku?.recommendPlaylists || []), ...payload.playlists]
    const seen = new Set<string>()
    return merged.filter(playlist => {
      if (!playlist.id || seen.has(playlist.id)) return false
      seen.add(playlist.id)
      return true
    })
  }, [kugou?.yueku?.recommendPlaylists, payload.playlists])
  const singers = kugou?.singers || []
  const tagPlaylists = kugou?.tagPlaylists || []
  const dailyGrid = tagPlaylists.length ? tagPlaylists : guessPlaylists

  const scrollToSingers = useCallback(() => {
    const target = document.getElementById('kugou-library-singers')
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const cards = [
    {
      key: 'guess',
      label: '猜你喜欢',
      badge: '歌单',
      title: guessPlaylists[0]?.name || '根据你的听歌口味推荐',
      subtitle: guessPlaylists[0] ? `${guessPlaylists.length} 个精选歌单持续更新` : '登录酷狗概念版后更贴近你的口味',
      cover: guessPlaylists[0]?.coverUrl || dailySongs[0]?.album.picUrl,
      onClick: () => { if (guessPlaylists[0]) onOpenPlaylist(guessPlaylists[0]) },
      onPlay: guessPlaylists[0] ? () => onOpenPlaylist(guessPlaylists[0], true) : undefined,
    },
    {
      key: 'daily',
      label: '每日推荐',
      badge: '歌曲',
      title: dailySongs[0]?.name ? `强推！${dailySongs[0].name}` : '今日专属日推',
      subtitle: kugou?.dailyDate ? `每日更新 · ${kugou.dailyDate.slice(0, 4)}-${kugou.dailyDate.slice(4, 6)}-${kugou.dailyDate.slice(6, 8)}` : `${dailySongs.length} 首按口味挑选`,
      cover: dailySongs[0]?.album.picUrl || kugou?.yueku?.headlineCoverUrl,
      onClick: () => { if (dailySongs[0]) onPlaySongs(dailySongs[0], dailySongs, true) },
      onPlay: dailySongs[0] ? () => onPlaySongs(dailySongs[0], dailySongs, true) : undefined,
    },
    {
      key: 'charts',
      label: '排行榜',
      badge: '榜单',
      title: charts[0]?.name || '热门之选',
      subtitle: charts[0]?.songs.slice(0, 2).map(song => song.name).join(' · ') || '潮流必备，实时更新',
      cover: charts[0]?.coverUrl,
      // 榜单歌曲在 payload 里是 ExploreChartSong（非 Song）：点击统一进入排行榜板块，不在此直接起播
      onClick: () => onOpenMoreSection('charts'),
    },
    {
      key: 'playlists',
      label: '歌单广场',
      badge: '歌单',
      title: `${Math.max(tagPlaylists.length, guessPlaylists.length)} 个精选歌单`,
      subtitle: '歌单潮音，一键畅享',
      cover: tagPlaylists[1]?.coverUrl || guessPlaylists[1]?.coverUrl,
      onClick: () => onOpenMoreSection('playlists'),
      onPlay: guessPlaylists[0] ? () => onOpenPlaylist(guessPlaylists[0], true) : undefined,
    },
    {
      key: 'singers',
      label: '歌手',
      badge: '目录',
      title: singers.length ? `${singers.length} 位热门歌手` : '歌手精选',
      subtitle: singers.slice(0, 3).map(singer => singer.singername).filter(Boolean).join(' · ') || '歌手精选，一键播放',
      cover: singers[0]?.coverUrl,
      onClick: scrollToSingers,
    },
  ]

  // 用户在设置里隐藏「为你发现」时，酷狗推荐板块同样不渲染（与其它平台一致）
  if (!props.sectionVisible('discover')) return null

  return (
    <>
      <section style={props.sectionStyle('discover')} data-kugou-board="discover">
        <KgSectionHeading
          icon={<Sparkles className="h-5 w-5" />}
          title="为你推荐"
          subtitle={showSubtitles ? '猜你喜欢 / 每日推荐 / 排行榜 / 歌单广场 / 歌手' : undefined}
        />
        <div className={`grid gap-4 ${props.compactCards ? 'grid-cols-2 md:grid-cols-3 xl:grid-cols-5' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-5'}`}>
          {cards.map(card => (
            <BigCard
              key={card.key}
              label={card.label}
              badge={card.badge}
              title={card.title}
              subtitle={showSubtitles ? card.subtitle : undefined}
              cover={card.cover}
              accent={accent}
              accentRgb={accentRgb}
              onClick={card.onClick}
              onPlay={card.onPlay}
            />
          ))}
        </div>

        <div className="mt-10">
          <div className="mb-4 flex items-end justify-between gap-4">
            <h3 className="text-lg font-semibold tracking-tight">今日专属推荐</h3>
            <KgMoreButton label="歌单广场" onClick={() => onOpenMoreSection('playlists')} />
          </div>
          {dailyGrid.length > 0 ? (
            <div className={`grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 ${props.compactCards ? 'xl:grid-cols-7 min-[2400px]:grid-cols-8' : 'xl:grid-cols-6 min-[1900px]:grid-cols-7 min-[2400px]:grid-cols-8'}`}>
              {dailyGrid.slice(0, props.expandedHome ? 18 : 12).map((playlist, index) => (
                <motion.div
                  key={`${playlist.platform}-${playlist.id}-${index}`}
                  whileHover={{ y: -5 }}
                  className="group min-w-0 cursor-pointer"
                  onClick={() => onOpenPlaylist(playlist)}
                >
                  <div className="relative aspect-square overflow-hidden rounded-[20px] border border-white/[0.08] shadow-xl shadow-black/10" style={{ backgroundColor: props.exploreCardBg }}>
                    <KgCover src={playlist.coverUrl} alt={playlist.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                    {playlist.tags?.[0] && (
                      <span className="absolute left-2.5 top-2.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white/78">{playlist.tags[0]}</span>
                    )}
                    {formatCount(playlist.playCount) && (
                      <span className="absolute bottom-2.5 left-2.5 flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white/78">
                        <Headphones className="h-3 w-3" /> {formatCount(playlist.playCount)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={event => {
                        event.stopPropagation()
                        onOpenPlaylist(playlist, true)
                      }}
                      className="absolute bottom-2.5 right-2.5 flex h-10 w-10 translate-y-2 items-center justify-center rounded-full text-[#081017] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"
                      style={{ background: accent }}
                      aria-label={`播放 ${playlist.name}`}
                    >
                      <Play className="h-4 w-4 fill-current" />
                    </button>
                  </div>
                  <h3 className="mt-2.5 line-clamp-2 text-sm font-medium leading-snug text-white/86">{playlist.name}</h3>
                  <p className="mt-1 truncate text-xs text-white/38">{playlist.creator || `${playlist.trackCount || '精选'} 首歌曲`}</p>
                </motion.div>
              ))}
            </div>
          ) : (
            <KgBoardState
              icon={<Headphones className="h-7 w-7" />}
              title="歌单广场暂时没有返回内容"
              hint={kugou?.tagPlaylistsError || '稍后重试，或检查本地服务是否可用。'}
              action={(
                <button type="button" onClick={props.onRetry} className="mt-4 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[#081017]" style={{ background: accent }}>
                  <RefreshCw className="h-3.5 w-3.5" /> 重新加载
                </button>
              )}
            />
          )}
        </div>
      </section>
    </>
  )
}

// ─────────────────────────── 乐库（新歌速递 + 新碟速递 + 歌手） ───────────────────────────

function KugouLibraryBoard(props: KugouBoardProps) {
  const { payload, accent, showSubtitles, onPlaySongs, onSongSelect, onSongContextMenu, onOpenAlbum, onOpenArtist } = props
  const kugou = payload.kugou
  const newSongs = (kugou?.newSongs || []).map(item => item.song)
  const newSpots = useMemo(() => {
    const albums = [...(kugou?.yueku?.newAlbums || []), ...payload.albums]
    const seen = new Set<string>()
    return albums.filter(album => {
      const key = String(album.mid || album.id)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [kugou?.yueku?.newAlbums, payload.albums])
  const singers = (kugou?.singers || []).slice(0, 12)

  if (!props.sectionVisible('kugouLibrary')) return null

  return (
    <section style={props.sectionStyle('kugouLibrary')} data-kugou-board="library">
      <KgSectionHeading
        icon={<Disc3 className="h-5 w-5" />}
        title="乐库"
        subtitle={showSubtitles ? '新歌速递 / 新碟上架 / 歌手目录' : undefined}
        action={(
          <button
            type="button"
            disabled={!newSongs.length}
            onClick={() => newSongs[0] && onPlaySongs(newSongs[0], newSongs, false)}
            className="flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.055] px-4 py-1.5 text-xs text-white/62 transition hover:bg-white/[0.1] hover:text-white disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5 fill-current" /> 播放新歌
          </button>
        )}
      />

      <div className="rounded-[26px] border border-white/[0.07] bg-white/[0.028] p-4 md:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-white/88">新歌速递</h3>
          {showSubtitles && <span className="text-xs text-white/36">酷狗官方新歌首发（{newSongs.length} 首）</span>}
        </div>
        {newSongs.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {newSongs.slice(0, props.expandedHome ? 18 : 9).map((song, index) => (
              <motion.button
                key={`${song.mid || song.id}-${index}`}
                type="button"
                whileHover={{ x: 3 }}
                onClick={() => onSongSelect(song, newSongs)}
                onContextMenu={event => onSongContextMenu(event, song, newSongs)}
                className="group flex min-w-0 items-center gap-3 rounded-2xl border border-transparent p-2 text-left transition hover:border-white/[0.07] hover:bg-white/[0.055]"
              >
                <KgCover src={song.album.picUrl} alt={song.name} className="h-12 w-12 shrink-0 rounded-xl object-cover" iconClassName="h-4 w-4" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-white/84">{song.name}</span>
                  <span className="mt-1 block truncate text-xs text-white/36">{song.artists.map(artist => artist.name).join(' / ')}</span>
                </span>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/40 opacity-0 transition group-hover:opacity-100">
                  <Play className="h-3.5 w-3.5 fill-current" />
                </span>
              </motion.button>
            ))}
          </div>
        ) : (
          <KgBoardState
            icon={<Music2 className="h-6 w-6" />}
            title="新歌速递暂时没有返回内容"
            hint={kugou?.newSongsError || '稍后重试，或检查本地服务是否可用。'}
          />
        )}
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-white/88">新碟速递</h3>
          {showSubtitles && <span className="text-xs text-white/36">最新专辑</span>}
        </div>
        {newSpots.length > 0 ? (
          <div className={`grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 md:grid-cols-4 ${props.compactCards ? 'xl:grid-cols-7' : 'xl:grid-cols-6 min-[1900px]:grid-cols-7'}`}>
            {newSpots.slice(0, props.expandedHome ? 12 : 6).map((album, index) => (
              <motion.div
                key={`${album.mid || album.id}-${index}`}
                whileHover={{ y: -5 }}
                className="group min-w-0 cursor-pointer"
                onClick={() => onOpenAlbum?.(String(album.mid || album.id), album.platform)}
              >
                <div className="relative aspect-square overflow-hidden rounded-[20px] border border-white/[0.08] shadow-xl shadow-black/10" style={{ backgroundColor: props.exploreCardBg }}>
                  <KgCover src={album.coverUrl} alt={album.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                </div>
                <h3 className="mt-2.5 line-clamp-1 text-sm font-medium leading-snug text-white/86">{album.name}</h3>
                <p className="mt-1 line-clamp-1 text-xs text-white/40">{album.artist}</p>
              </motion.div>
            ))}
          </div>
        ) : (
          <KgBoardState icon={<Disc3 className="h-6 w-6" />} title="暂时没有新碟数据" hint="稍后重试即可。" />
        )}
      </div>

      <div className="mt-6" id="kugou-library-singers">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-base font-semibold text-white/88"><Mic2 className="h-4 w-4 text-white/50" /> 歌手</h3>
          {showSubtitles && <span className="text-xs text-white/36">热门歌手目录</span>}
        </div>
        {singers.length > 0 ? (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8 min-[1900px]:grid-cols-10">
            {singers.map(singer => (
              <motion.button
                key={singer.singerid}
                type="button"
                whileHover={{ y: -4 }}
                onClick={() => onOpenArtist?.(singer.singerid, 'kugou')}
                className="group min-w-0 text-center"
              >
                <span className="relative block aspect-square overflow-hidden rounded-full border border-white/[0.08]" style={{ backgroundColor: props.exploreCardBg }}>
                  <KgCover src={singer.coverUrl} alt={singer.singername} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                </span>
                <span className="mt-2 block truncate text-sm font-medium text-white/84">{singer.singername}</span>
                {formatCount(singer.fansCount) && <span className="mt-0.5 block truncate text-[11px] text-white/32">{formatCount(singer.fansCount)} 粉丝</span>}
              </motion.button>
            ))}
          </div>
        ) : (
          <KgBoardState icon={<Mic2 className="h-6 w-6" />} title="歌手目录暂时没有返回内容" hint={kugou?.singersError || '稍后重试即可。'} />
        )}
      </div>
    </section>
  )
}

// ─────────────────────────── 歌单（分类标签 + 分类歌单列表，分页） ───────────────────────────

function KugouPlaylistTagsBoard(props: KugouBoardProps & {
  selectedTag: string | null
  onSelectTag: (tag: string | null) => void
}) {
  const { payload, accent, showSubtitles, onOpenPlaylist, selectedTag, onSelectTag } = props
  const kugou = payload.kugou
  const groups = kugou?.tagGroups || []
  const [items, setItems] = useState<ExplorePlaylist[]>(kugou?.tagPlaylists || [])
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(Boolean(kugou?.tagPlaylistsHasNext))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const load = useCallback(async (tag: string | null, nextPage: number, append: boolean) => {
    const requestId = ++requestRef.current
    setLoading(true)
    setError('')
    try {
      const result = await fetchKugouTagPlaylists(tag, nextPage)
      if (requestId !== requestRef.current) return
      setItems(previous => append ? [...previous, ...result.playlists.filter(item => !previous.some(existing => existing.id === item.id))] : result.playlists)
      setPage(nextPage)
      setHasNext(result.hasNext)
    } catch (loadError) {
      if (requestId !== requestRef.current) return
      setError(loadError instanceof Error ? loadError.message : '分类歌单加载失败')
      if (!append) setItems([])
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [])

  // 标签切换（或探索页重新加载、payload 换代）时重置列表：
  // 「全部」直接用 payload 里的首页数据，其余标签按需拉取
  useEffect(() => {
    if (selectedTag === null) {
      setItems(kugou?.tagPlaylists || [])
      setPage(1)
      setHasNext(Boolean(kugou?.tagPlaylistsHasNext))
      setError(kugou?.tagPlaylistsError || '')
      return
    }
    void load(selectedTag, 1, false)
  }, [selectedTag, payload.meta.updatedAt, kugou?.tagPlaylists, kugou?.tagPlaylistsError, kugou?.tagPlaylistsHasNext, load])

  if (!props.sectionVisible('kugouPlaylistTags')) return null

  return (
    <section style={props.sectionStyle('kugouPlaylistTags')} data-kugou-board="playlist-tags" id="kugou-playlist-tags-board">
      <KgSectionHeading
        icon={<Headphones className="h-5 w-5" />}
        title="歌单"
        subtitle={showSubtitles ? '按酷狗官方分类标签浏览歌单' : undefined}
        action={<KgMoreButton label="歌单广场" onClick={() => props.onOpenMoreSection('playlists')} />}
      />
      {groups.length > 0 ? (
        <div className="mb-5 space-y-2.5">
          {groups.map(group => (
            <div key={group.id} className="flex flex-wrap items-center gap-2">
              <span className="w-12 shrink-0 text-xs text-white/36">{group.name}</span>
              <button
                type="button"
                onClick={() => onSelectTag(null)}
                className="rounded-full border px-3 py-1 text-xs transition"
                style={selectedTag === null
                  ? { background: accent, borderColor: accent, color: '#081017' }
                  : { borderColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.55)' }}
              >
                全部
              </button>
              {group.tags.map(tag => (
                <button
                  key={`${group.id}-${tag.id}`}
                  type="button"
                  onClick={() => onSelectTag(tag.name)}
                  className="rounded-full border px-3 py-1 text-xs transition hover:bg-white/[0.08] hover:text-white"
                  style={selectedTag === tag.name
                    ? { background: accent, borderColor: accent, color: '#081017' }
                    : { borderColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.55)' }}
                >
                  {tag.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-4 text-xs text-white/36">{kugou?.tagError || '分类标签不可用，下面展示推荐歌单。'}</p>
      )}

      {loading && items.length === 0 ? (
        <div className="flex min-h-32 items-center justify-center gap-2 rounded-[24px] border border-white/[0.07] bg-white/[0.03] text-sm text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在加载分类歌单…
        </div>
      ) : error && items.length === 0 ? (
        <KgBoardState
          icon={<AlertCircle className="h-6 w-6" />}
          title="分类歌单加载失败"
          hint={error}
          action={(
            <button type="button" onClick={() => void load(selectedTag, 1, false)} className="mt-4 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[#081017]" style={{ background: accent }}>
              <RefreshCw className="h-3.5 w-3.5" /> 重试
            </button>
          )}
        />
      ) : items.length === 0 ? (
        <KgBoardState
          icon={<Headphones className="h-6 w-6" />}
          title={selectedTag ? `「${selectedTag}」下暂时没有歌单` : '暂时没有分类歌单'}
          hint="上游推荐池按标签筛选后为空，换个标签或稍后再试。"
        />
      ) : (
        <>
          <div className={`grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 ${props.compactCards ? 'xl:grid-cols-7' : 'xl:grid-cols-6 min-[1900px]:grid-cols-7'}`}>
            {items.slice(0, props.expandedHome ? 24 : 12).map((playlist, index) => (
              <motion.div
                key={`${playlist.id}-${index}`}
                whileHover={{ y: -5 }}
                className="group min-w-0 cursor-pointer"
                onClick={() => onOpenPlaylist(playlist)}
              >
                <div className="relative aspect-square overflow-hidden rounded-[20px] border border-white/[0.08] shadow-xl shadow-black/10" style={{ backgroundColor: props.exploreCardBg }}>
                  <KgCover src={playlist.coverUrl} alt={playlist.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                  {playlist.tags?.[0] && (
                    <span className="absolute left-2.5 top-2.5 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white/78">{playlist.tags[0]}</span>
                  )}
                  {formatCount(playlist.playCount) && (
                    <span className="absolute bottom-2.5 left-2.5 flex items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white/78">
                      <Headphones className="h-3 w-3" /> {formatCount(playlist.playCount)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      onOpenPlaylist(playlist, true)
                    }}
                    className="absolute bottom-2.5 right-2.5 flex h-10 w-10 translate-y-2 items-center justify-center rounded-full text-[#081017] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"
                    style={{ background: accent }}
                    aria-label={`播放 ${playlist.name}`}
                  >
                    <Play className="h-4 w-4 fill-current" />
                  </button>
                </div>
                <h3 className="mt-2.5 line-clamp-2 text-sm font-medium leading-snug text-white/86">{playlist.name}</h3>
                <p className="mt-1 truncate text-xs text-white/38">{playlist.creator || `${playlist.trackCount || '精选'} 首歌曲`}</p>
              </motion.div>
            ))}
          </div>
          {hasNext && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                disabled={loading}
                onClick={() => void load(selectedTag, page + 1, true)}
                className="flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.055] px-5 py-2 text-sm text-white/62 transition hover:bg-white/[0.1] hover:text-white disabled:cursor-wait disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                加载更多
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

// ─────────────────────────── 频道（空列表要有像样的空态） ───────────────────────────

function KugouChannelsBoard(props: KugouBoardProps) {
  const { payload, accent, showSubtitles, onOpenSearch, onPlaySongs } = props
  const channels = payload.kugou?.channels || []
  // 官方「频道」页签 = 电台：14 个分类 × 每类 20~70 个电台（公开数据，无需登录）
  const [radioClasses, setRadioClasses] = useState<Array<{ classid: string; name: string; stations: Array<{ fmid: string; name: string; coverUrl: string; fmtype: number; currentSong: { name: string } | null }> }>>([])
  const [radioClassId, setRadioClassId] = useState('')
  const [radioPlaying, setRadioPlaying] = useState('')
  const radioVisible = props.sectionVisible('channels')
  useEffect(() => {
    if (!radioVisible) return
    let cancelled = false
    void import('../../services/kugouService')
      .then(m => m.fetchKugouRadioClasses())
      .then(list => {
        if (cancelled || !list.length) return
        setRadioClasses(list)
        setRadioClassId(current => current || list[0].classid)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [radioVisible])
  const playRadio = async (station: { fmid: string; fmtype: number }) => {
    if (radioPlaying) return
    setRadioPlaying(station.fmid)
    try {
      const svc = await import('../../services/kugouService')
      const tracks = await svc.fetchKugouRadioSongs(station.fmid, station.fmtype, 20)
      if (tracks.length) {
        const songs = tracks.map(svc.kugouTrackToSong)
        onPlaySongs(songs[0], songs, true)
      }
    } finally {
      setRadioPlaying('')
    }
  }
  if (!radioVisible) return null
  const activeClass = radioClasses.find(cls => cls.classid === radioClassId) || radioClasses[0]
  return (
    <section style={props.sectionStyle('channels')} data-kugou-board="channels">
      <KgSectionHeading
        icon={<Radio className="h-5 w-5" />}
        title="频道"
        subtitle={showSubtitles ? '电台直播 · 分类切换（来自酷狗概念版）' : undefined}
      />
      {radioClasses.length > 0 ? (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {radioClasses.map(cls => (
              <button
                key={cls.classid}
                type="button"
                onClick={() => setRadioClassId(cls.classid)}
                className={`rounded-full px-4 py-1.5 text-[13px] transition ${radioClassId === cls.classid ? 'font-medium text-[#081017]' : 'border border-white/[0.1] bg-white/[0.055] text-white/62 hover:bg-white/[0.1] hover:text-white'}`}
                style={radioClassId === cls.classid ? { background: accent } : undefined}
              >
                {cls.name}
              </button>
            ))}
          </div>
          <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 ${props.compactCards ? 'xl:grid-cols-8' : 'xl:grid-cols-6 min-[1900px]:grid-cols-7'}`}>
            {(activeClass?.stations || []).map(station => (
              <motion.button
                key={station.fmid}
                type="button"
                whileHover={{ y: -4 }}
                onClick={() => void playRadio(station)}
                disabled={radioPlaying === station.fmid}
                className="group min-w-0 text-left disabled:opacity-60"
                title={`播放电台：${station.name}`}
              >
                <div className="relative aspect-square overflow-hidden rounded-[18px] border border-white/[0.08]">
                  <KgCover src={station.coverUrl} alt={station.name} className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                </div>
                <div className="mt-2 truncate text-sm font-medium">{station.name}</div>
                <div className="mt-0.5 line-clamp-1 text-[11px] text-white/42">
                  {radioPlaying === station.fmid ? '正在开播…' : (station.currentSong?.name || '电台直播中')}
                </div>
              </motion.button>
            ))}
          </div>
        </>
      ) : null}
      {channels.length > 0 ? (
        <div className="mt-6">
          <div className="mb-3 text-[13px] font-medium text-white/55">我订阅的频道</div>
          <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 ${props.compactCards ? 'xl:grid-cols-8' : 'xl:grid-cols-6 min-[1900px]:grid-cols-7'}`}>
            {channels.map((channel, index) => (
              <motion.button
                key={`${channel.id}-${index}`}
                type="button"
                whileHover={{ y: -4 }}
                onClick={() => onOpenSearch?.(channel.name)}
                className="group relative min-h-32 overflow-hidden rounded-[22px] border border-white/[0.08] bg-white/[0.045] text-left"
              >
                <KgCover src={channel.coverUrl} alt={channel.name} className="absolute inset-0 h-full w-full object-cover opacity-55 transition duration-500 group-hover:scale-105 group-hover:opacity-70" />
                <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(5,7,11,0.94),rgba(5,7,11,0.08))]" />
                <div className="relative flex h-full flex-col justify-end p-4">
                  <span className="mb-auto text-[10px] font-medium text-white/48">{channel.group || '频道'}</span>
                  <span className="line-clamp-2 text-sm font-semibold leading-snug">{channel.name}</span>
                  {channel.description && <span className="mt-1 line-clamp-1 text-[10px] text-white/38">{channel.description}</span>}
                </div>
              </motion.button>
            ))}
          </div>
        </div>
      ) : null}
      {radioClasses.length === 0 && channels.length === 0 ? (
        <KgBoardState
          icon={<Radio className="h-7 w-7" />}
          title="电台列表暂时不可用"
          hint="需要本地服务在线才能拉取电台分类（公开数据，无需登录）。稍后重新加载即可。"
          action={(
            <button type="button" onClick={props.onRetry} className="mt-4 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[#081017]" style={{ background: accent }}>
              <RefreshCw className="h-3.5 w-3.5" /> 重新加载
            </button>
          )}
        />
      ) : null}
    </section>
  )
}

// ─────────────────────────── 分类（标签维度独立入口） ───────────────────────────

function KugouCategoriesBoard(props: KugouBoardProps & { onSelectTag: (tag: string | null) => void }) {
  const { payload, accent, showSubtitles, onSelectTag } = props
  const groups = payload.kugou?.tagGroups || []
  if (!props.sectionVisible('kugouCategories')) return null
  return (
    <section style={props.sectionStyle('kugouCategories')} data-kugou-board="categories">
      <KgSectionHeading
        icon={<Trophy className="h-5 w-5" />}
        title="分类"
        subtitle={showSubtitles ? '按官方分类标签直达歌单（与「歌单」板块共用一套标签）' : undefined}
      />
      {groups.length > 0 ? (
        <div className={`grid gap-4 ${props.compactCards ? 'md:grid-cols-3 xl:grid-cols-5' : 'md:grid-cols-2 xl:grid-cols-4'}`}>
          {groups.map(group => (
            <div key={group.id} className="rounded-[22px] border border-white/[0.07] bg-white/[0.03] p-4">
              <h3 className="mb-3 text-sm font-semibold text-white/86">{group.name}</h3>
              <div className="flex flex-wrap gap-1.5">
                {group.tags.map(tag => (
                  <button
                    key={`${group.id}-${tag.id}`}
                    type="button"
                    onClick={() => {
                      onSelectTag(tag.name)
                      document.getElementById('kugou-playlist-tags-board')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }}
                    className="rounded-full border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[11px] text-white/58 transition hover:bg-white/[0.1] hover:text-white"
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <KgBoardState
          icon={<Trophy className="h-6 w-6" />}
          title="分类标签暂时不可用"
          hint={payload.kugou?.tagError || '概念版分类标签接口没有返回内容，稍后重试。'}
          action={(
            <button type="button" onClick={props.onRetry} className="mt-4 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[#081017]" style={{ background: accent }}>
              <RefreshCw className="h-3.5 w-3.5" /> 重新加载
            </button>
          )}
        />
      )}
    </section>
  )
}

// ─────────────────────────── 汇总挂载（乐库/歌单/频道/分类） ───────────────────────────

export default function KugouExploreSections(props: KugouBoardProps) {
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  return (
    <>
      <KugouLibraryBoard {...props} />
      <KugouPlaylistTagsBoard {...props} selectedTag={selectedTag} onSelectTag={setSelectedTag} />
      <KugouChannelsBoard {...props} />
      <KugouCategoriesBoard {...props} onSelectTag={setSelectedTag} />
    </>
  )
}
