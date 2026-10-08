// 酷狗音乐 PC 客户端「音乐 → 推荐」页。
//
// 对齐官方截图（D:\opencode\.tmp-kg-tab-tuijian.png）：
//   ① 五张大卡：猜你喜欢 / 每日推荐 / 排行榜 / 歌单广场 / 歌手；
//   ② 「今日专属推荐」标题 + 「歌单广场 >」链接 + 歌单卡片网格（卡片左上角是歌曲
//      自带标签，左下角是播放量）。
// 数据直接吃传统模式已加载的探索 payload（fetchExploreHome('kugou') 的 kugou 扩展块，
// 内部全部走 kugouService 的概念版薄封装）——不在这里再发一遍请求，避免首屏双倍流量。
import { memo } from 'react'
import { Headphones, Mic2, Play, Sparkles, Trophy } from 'lucide-react'
import type { ExplorePlaylist, ExplorePayload } from '../../services/exploreApi'
import { PcCover } from './pcKit'
import { kugouCount, type KugouPcMusicTab, type KugouPcPageContext } from './KugouPcShared'

export interface KugouPcHomeProps {
  ctx: KugouPcPageContext
  payload: ExplorePayload | null
  /** 大卡「歌单广场 / 歌手」跳到同一「音乐」页下的其它页签 */
  onOpenTab: (tab: KugouPcMusicTab) => void
}

/** 官方大卡的配色（对照官方截图：青绿/紫/橙的整块渐变底，白色大标题）。 */
const BIG_CARD_GRADIENTS: Record<string, string> = {
  guess: 'linear-gradient(135deg, #2fc9b4 0%, #56d8b0 100%)',
  daily: 'linear-gradient(135deg, #8a7bf7 0%, #a98ffb 100%)',
  chart: 'linear-gradient(135deg, #ff9a52 0%, #ff7a3c 100%)',
  playlist: 'linear-gradient(135deg, #ff8a5c 0%, #ff6348 100%)',
  singer: 'linear-gradient(135deg, #ffa14e 0%, #ff8340 100%)',
}

/** 官方大卡：整块渐变底 + 左上角大标题/副标题 + 右下角封面画（官方没有铺满的封面照片）。 */
function BigCard({
  title, subtitle, cover, gradient, onClick,
}: {
  title: string
  subtitle?: string
  cover?: string
  gradient: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative h-[132px] min-w-0 overflow-hidden rounded-xl text-left transition hover:-translate-y-0.5"
      style={{ background: gradient }}
    >
      <span className="relative z-10 flex h-full flex-col p-4">
        <span className="text-[17px] font-bold leading-snug text-white">{title}</span>
        {subtitle ? <span className="mt-1 line-clamp-1 text-[11px] text-white/75">{subtitle}</span> : null}
      </span>
      {/* 右下角封面画：官方卡片同款构图；PcCover 根节点自带 relative，不能直接给它传 absolute（会被覆盖失效） */}
      {cover ? (
        <span className="absolute bottom-3 right-3 h-[72px] w-[72px] overflow-hidden rounded-lg shadow-[0_6px_16px_rgba(0,0,0,0.28)] transition group-hover:scale-105">
          <PcCover src={cover} alt={title} className="h-full w-full" rounded="rounded-lg" />
        </span>
      ) : (
        <Headphones className="absolute bottom-3 right-3 h-10 w-10 text-white/30" />
      )}
    </button>
  )
}

function KugouPcHome({ ctx, payload, onOpenTab }: KugouPcHomeProps) {
  const theme = ctx.theme
  const accent = ctx.accent
  const kugou = payload?.kugou
  const dailySongs = kugou?.dailySongs || []
  const charts = (payload?.charts || []).filter(chart => chart.platform === 'kugou')
  const tagPlaylists = kugou?.tagPlaylists || []
  const guessPlaylists = kugou?.yueku?.recommendPlaylists || []
  const singers = kugou?.singers || []

  // 今日专属推荐：优先用带标签的分类歌单池（官方卡片左上角的标签就来自这里）
  const dailyGrid = (tagPlaylists.length ? tagPlaylists : guessPlaylists).slice(0, 18)
  const headline = dailySongs[0]

  const openPlaylist = (playlist: ExplorePlaylist) => {
    ctx.openPlaylist({
      id: playlist.conceptId || playlist.id,
      name: playlist.name,
      coverImgUrl: playlist.coverUrl,
      coverUrl: playlist.coverUrl,
      trackCount: playlist.trackCount || 0,
      platform: 'kugou',
      conceptId: playlist.conceptId,
    })
  }

  const dailyDate = kugou?.dailyDate
  const dailyDateText = dailyDate && dailyDate.length >= 8 ? `${dailyDate.slice(0, 4)}-${dailyDate.slice(4, 6)}-${dailyDate.slice(6, 8)}` : ''

  return (
    <div className="pb-8" data-kugou-pc-page="discover">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <BigCard
          title="猜你喜欢"
          subtitle={guessPlaylists[0]?.name || '根据你的听歌口味推荐'}
          cover={guessPlaylists[0]?.coverUrl || headline?.album?.picUrl}
          gradient={BIG_CARD_GRADIENTS.guess}
          onClick={() => { if (guessPlaylists[0]) openPlaylist(guessPlaylists[0]) }}
        />
        <BigCard
          title="每日推荐"
          subtitle={headline ? `强推！${headline.name}` : dailyDateText ? `每日更新 · ${dailyDateText}` : `${dailySongs.length} 首按口味挑选`}
          cover={headline?.album?.picUrl || kugou?.yueku?.headlineCoverUrl}
          gradient={BIG_CARD_GRADIENTS.daily}
          onClick={() => { if (headline) ctx.actions.onPlaySongs(headline, dailySongs, 0) }}
        />
        <BigCard
          title="排行榜"
          subtitle={charts[0]?.name || '热门之选，潮流必备'}
          cover={charts[0]?.coverUrl}
          gradient={BIG_CARD_GRADIENTS.chart}
          onClick={() => { if (charts[0]) ctx.actions.onOpenChart?.(charts[0]) }}
        />
        <BigCard
          title="歌单广场"
          subtitle="歌单潮音，一键畅享"
          cover={tagPlaylists[1]?.coverUrl || guessPlaylists[1]?.coverUrl}
          gradient={BIG_CARD_GRADIENTS.playlist}
          onClick={() => onOpenTab('playlists')}
        />
        <BigCard
          title="歌手"
          subtitle={singers.slice(0, 3).map(singer => singer.singername).filter(Boolean).join(' · ') || '歌手精选，一键播放'}
          cover={singers[0]?.coverUrl}
          gradient={BIG_CARD_GRADIENTS.singer}
          onClick={() => onOpenTab('library')}
        />
      </div>

      <div className="mt-8">
        <div className="mb-3 flex items-end justify-between gap-3">
          <h2 className={`text-[17px] font-semibold ${theme.text}`}>今日专属推荐</h2>
          <button type="button" onClick={() => onOpenTab('playlists')} className={`flex items-center gap-1 text-[13px] ${theme.subtle} hover:opacity-80`}>
            歌单广场 <span aria-hidden>›</span>
          </button>
        </div>

        {dailyGrid.length === 0 ? (
          <div className={`flex flex-col items-center justify-center rounded-xl py-16 text-center ${theme.surface}`}>
            <Headphones className={`h-7 w-7 ${theme.faint}`} />
            <p className={`mt-3 text-[13px] ${theme.subtle}`}>歌单广场暂时没有返回内容</p>
            <p className={`mt-1 text-[11px] ${theme.faint}`}>{kugou?.tagPlaylistsError || '稍后重试，或检查本地服务是否可用'}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {dailyGrid.map((playlist, index) => (
              <button key={`${playlist.id}:${index}`} type="button" onClick={() => openPlaylist(playlist)} className="group min-w-0 text-left">
                <span className="relative block">
                  <PcCover src={playlist.coverUrl} alt={playlist.name} className="aspect-square w-full" rounded="rounded-[8px]" />
                  {playlist.tags?.[0] ? (
                    <span className="absolute left-1.5 top-1.5 rounded-[4px] bg-black/45 px-1.5 py-[2px] text-[11px] leading-none text-white backdrop-blur-sm">{playlist.tags[0]}</span>
                  ) : null}
                  {kugouCount(playlist.playCount) ? (
                    <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-[2px] text-[11px] leading-none text-white backdrop-blur-sm">
                      <Headphones className="h-3 w-3" /> {kugouCount(playlist.playCount)}
                    </span>
                  ) : null}
                </span>
                <span className={`mt-2 line-clamp-2 text-[13px] leading-snug ${theme.text}`}>{playlist.name}</span>
                <span className={`mt-0.5 line-clamp-1 block text-[11px] ${theme.faint}`}>
                  {playlist.creator || (playlist.trackCount ? `${playlist.trackCount} 首` : '精选歌单')}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 每日推荐 30 首：官方在推荐页底部有「每日推荐」列表入口，这里给出可播放的一屏列表 */}
      {dailySongs.length > 0 && (
        <div className="mt-8">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4" style={{ color: accent }} />
            <h2 className={`text-[17px] font-semibold ${theme.text}`}>每日推荐</h2>
            <span className={`text-[12px] ${theme.faint}`}>{dailySongs.length} 首{dailyDateText ? ` · ${dailyDateText}` : ''}</span>
            <button
              type="button"
              onClick={() => ctx.actions.onPlaySongs(dailySongs[0], dailySongs, 0)}
              className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium text-white"
              style={{ background: accent }}
            >
              <Play className="h-3 w-3 fill-current" /> 播放全部
            </button>
          </div>
          <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
            {dailySongs.slice(0, 15).map((song, index) => (
              <button
                key={`${song.mid || song.id}:${index}`}
                type="button"
                onDoubleClick={() => ctx.actions.onPlaySongs(song, dailySongs, index)}
                onClick={() => ctx.actions.onPlaySongs(song, dailySongs, index)}
                onContextMenu={event => { event.preventDefault(); ctx.actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: dailySongs }) }}
                className={`group flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition ${theme.hover}`}
              >
                <span className={`w-5 shrink-0 text-center text-[12px] tabular-nums ${theme.faint}`}>{index + 1}</span>
                <PcCover src={song.album?.picUrl} alt={song.name} className="h-9 w-9 shrink-0" rounded="rounded-md" />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[13px] ${theme.text}`}>{song.name}</span>
                  <span className={`block truncate text-[11px] ${theme.subtle}`}>{song.artists?.map(artist => artist.name).join(' / ')}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!payload && (
        <div className={`mt-6 flex items-center justify-center rounded-xl py-16 text-[13px] ${theme.faint} ${theme.surface}`}>正在加载推荐内容…</div>
      )}

      {/* 排行榜的可见入口（五张大卡之外，官方在推荐页有独立的榜单区） */}
      {charts.length > 1 && (
        <div className="mt-8">
          <div className="mb-3 flex items-center gap-2">
            <Trophy className="h-4 w-4" style={{ color: accent }} />
            <h2 className={`text-[17px] font-semibold ${theme.text}`}>排行榜</h2>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {charts.slice(0, 6).map(chart => (
              <button
                key={chart.id}
                type="button"
                onClick={() => ctx.actions.onOpenChart?.(chart)}
                className="group min-w-0 text-left"
              >
                <PcCover src={chart.coverUrl} alt={chart.name} className="aspect-square w-full" rounded="rounded-[8px]" />
                <span className={`mt-2 line-clamp-1 block text-[13px] ${theme.text}`}>{chart.name}</span>
                <span className={`mt-0.5 flex items-center gap-1 text-[11px] ${theme.faint}`}>
                  <Mic2 className="h-3 w-3" /> {chart.songs.length} 首
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(KugouPcHome)
