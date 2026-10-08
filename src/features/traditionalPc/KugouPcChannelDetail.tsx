// 酷狗音乐 PC 客户端「音乐 → 频道 → 频道详情」页（对齐官方：封面/名称/类型/简介/人气 + 主页·单曲·歌单·视频页签）。
//
// 数据源（实测与官方 H5 小程序同源，游客可读）：
//   /openapi/v1/ip（频道信息）+ /openapi/kmr/v2/ip（人气）+ /listkmrp3/v2/ip/rec（子频道）
//   /fm.service/v2/ip_song_list_page（单曲）/ /ocean/v6/pubsongs/list_info_for_ip（歌单）/ /openapi/v1/ip/videos（视频）
import { memo, useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Check, Flame, Music2, Play, Plus, Users, Video } from 'lucide-react'
import { PcCover, PcEmpty } from './pcKit'
import { kugouCount, kugouDuration, type KugouPcPageContext } from './KugouPcShared'
import type { KugouChannelCollectState, KugouChannelDetail, KugouChannelSub, KugouChannelVideo } from '../../services/kugouService'
import { kugouTrackToSong } from '../../services/kugouService'

type Tab = 'home' | 'songs' | 'playlists' | 'videos'

export interface KugouPcChannelDetailProps {
  ctx: KugouPcPageContext
  ipId: string
  onBack: () => void
  /** 子频道点击：进入另一个频道详情 */
  onOpenChannel: (ipId: string) => void
}

function KugouPcChannelDetail({ ctx, ipId, onBack, onOpenChannel }: KugouPcChannelDetailProps) {
  const theme = ctx.theme
  const accent = ctx.accent
  const [detail, setDetail] = useState<KugouChannelDetail | null>(null)
  const [subs, setSubs] = useState<KugouChannelSub[]>([])
  const [songs, setSongs] = useState<Array<{ song: ReturnType<typeof kugouTrackToSong>; track: any }>>([])
  const [songsTotal, setSongsTotal] = useState(0)
  const [songsPage, setSongsPage] = useState(1)
  const [playlists, setPlaylists] = useState<any[]>([])
  const [videos, setVideos] = useState<KugouChannelVideo[]>([])
  const [videosTotal, setVideosTotal] = useState(0)
  const [tab, setTab] = useState<Tab>('home')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // 关注状态：collectlist 读回（未登录时为 null，只展示总关注数）
  const [collect, setCollect] = useState<KugouChannelCollectState | null>(null)
  const [collectBusy, setCollectBusy] = useState(false)

  const loadSongs = useCallback(async (page: number) => {
    const svc = await import('../../services/kugouService')
    const result = await svc.fetchKugouChannelSongs(ipId, page, 30)
    setSongsTotal(result.total)
    setSongs(previous => {
      const rows = result.tracks.map(track => ({ song: kugouTrackToSong(track), track }))
      return page === 1 ? rows : [...previous, ...rows.filter(row => !previous.some(p => p.track.hash === row.track.hash))]
    })
  }, [ipId])

  useEffect(() => {
    if (!ctx.active) return
    let cancelled = false
    setLoading(true)
    setTab('home')
    setSongs([])
    setPlaylists([])
    setVideos([])
    setCollect(null)
    void (async () => {
      const svc = await import('../../services/kugouService')
      const [info, subList] = await Promise.all([
        svc.fetchKugouChannelDetail(ipId),
        svc.fetchKugouChannelSubChannels(ipId).catch(() => [] as KugouChannelSub[]),
      ])
      if (cancelled) return
      setDetail(info)
      setSubs(subList)
      setLoading(false)
      void loadSongs(1)
      // 关注状态独立读：未登录时上游只回总关注数，登录后带回 collected_listid（取消关注要用）
      void svc.fetchKugouChannelCollectState(ipId).then(state => { if (!cancelled && state) setCollect(state) }).catch(() => undefined)
    })()
    return () => { cancelled = true }
  }, [ipId, ctx.active, loadSongs, ctx.account.loggedIn])

  const toggleCollect = useCallback(async () => {
    if (!ctx.account.loggedIn) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '登录酷狗（概念版扫码）后即可关注频道', type: 'info' } }))
      ctx.actions.onLogin?.()
      return
    }
    if (!detail || collectBusy) return
    setCollectBusy(true)
    try {
      const svc = await import('../../services/kugouService')
      const ok = collect?.collected && collect.collectedListId
        ? await svc.uncollectKugouChannel(collect.collectedListId)
        : await svc.collectKugouChannel(ipId, detail.name)
      // 写接口只回受理结果，真实状态一律回读（上游为准，不乐观更新）
      const next = await svc.fetchKugouChannelCollectState(ipId)
      if (next) setCollect(next)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: ok ? (next?.collected ? '已关注该频道' : '已取消关注') : '关注操作未生效，请稍后重试', type: ok ? 'success' : 'error' },
      }))
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '关注操作失败，请稍后重试', type: 'error' } }))
    } finally {
      setCollectBusy(false)
    }
  }, [collect, collectBusy, ctx.account.loggedIn, ctx.actions, detail, ipId])

  // 页签首次打开时再拉各自的数据（官方也是分页签加载）
  useEffect(() => {
    if (tab === 'playlists' && playlists.length === 0 && detail) {
      void import('../../services/kugouService').then(svc => svc.fetchKugouChannelPlaylists(ipId, 1, 12)).then(setPlaylists).catch(() => undefined)
    }
    if (tab === 'videos' && videos.length === 0 && detail) {
      void import('../../services/kugouService').then(svc => svc.fetchKugouChannelVideos(ipId, 1, 12)).then(result => {
        setVideos(result.videos)
        setVideosTotal(result.total)
      }).catch(() => undefined)
    }
  }, [tab, playlists.length, videos.length, detail, ipId])

  const songList = songs.map(row => row.song)
  const playFrom = (index: number) => {
    const song = songList[index]
    if (song) ctx.actions.onPlaySongs(song, songList, index)
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'home', label: '主页' },
    { key: 'songs', label: `单曲 ${detail?.audioTotal ? kugouCount(detail.audioTotal) : ''}`.trim() },
    { key: 'playlists', label: `歌单 ${detail?.playlistTotal ? kugouCount(detail.playlistTotal) : ''}`.trim() },
    { key: 'videos', label: `视频 ${detail?.videoTotal || videosTotal || ''}`.trim() },
  ]

  if (loading && !detail) {
    return <div data-kugou-pc-page="channel-detail" className={`py-16 text-center text-[13px] ${theme.subtle}`}>频道加载中…</div>
  }
  if (!detail) {
    return (
      <div data-kugou-pc-page="channel-detail">
        <button type="button" onClick={onBack} className={`mb-4 inline-flex items-center gap-1.5 text-[13px] ${theme.subtle} hover:opacity-80`}>
          <ArrowLeft className="h-4 w-4" /> 返回频道
        </button>
        <PcEmpty theme={theme} title="频道内容加载失败" description="上游未返回该频道的数据，请稍后重试。" />
      </div>
    )
  }

  return (
    <div className="pb-8" data-kugou-pc-page="channel-detail">
      <button type="button" onClick={onBack} className={`mb-4 inline-flex items-center gap-1.5 text-[13px] ${theme.subtle} hover:opacity-80`}>
        <ArrowLeft className="h-4 w-4" /> 返回频道
      </button>

      {/* 头部：封面 + 名称/类型/简介/人气（官方形态） */}
      <section className="flex items-start gap-5">
        <PcCover src={detail.cover} alt={detail.name} className="h-[148px] w-[148px] shrink-0" rounded="rounded-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {detail.type ? (
              <span className="rounded px-1.5 py-0.5 text-[11px] font-medium text-white" style={{ background: accent }}>{detail.type}</span>
            ) : null}
            <h1 className={`truncate text-[26px] font-bold ${theme.text}`}>{detail.name}</h1>
            {/* 关注：官方频道页头部同位置（名称右侧）；已关注为描边态，点击取消 */}
            <button
              type="button"
              disabled={collectBusy}
              onClick={() => void toggleCollect()}
              className={`ml-1 inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium transition disabled:opacity-50 ${collect?.collected ? 'border border-white/25 hover:bg-white/5' : 'text-white'}`}
              style={collect?.collected ? undefined : { background: accent }}
              title={ctx.account.loggedIn ? (collect?.collected ? '点击取消关注' : '关注该频道') : '登录后可关注'}
            >
              {collect?.collected ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
              {collect?.collected ? '已关注' : '关注'}
            </button>
          </div>
          {detail.intro ? <p className={`mt-2 line-clamp-2 text-[13px] ${theme.subtle}`}>{detail.intro}</p> : null}
          <div className={`mt-3 flex items-center gap-4 text-[12px] ${theme.faint}`}>
            {collect?.collectedCount ? (
              <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {kugouCount(collect.collectedCount)} 人关注</span>
            ) : null}
            {detail.heat ? (
              <span className="inline-flex items-center gap-1"><Flame className="h-3.5 w-3.5" /> {kugouCount(detail.heat)} 人气</span>
            ) : null}
            {detail.audioTotal ? <span className="inline-flex items-center gap-1"><Music2 className="h-3.5 w-3.5" /> {kugouCount(detail.audioTotal)} 首单曲</span> : null}
            {detail.videoTotal ? <span className="inline-flex items-center gap-1"><Video className="h-3.5 w-3.5" /> {kugouCount(detail.videoTotal)} 个视频</span> : null}
          </div>
          <button
            type="button"
            disabled={!songList.length}
            onClick={() => playFrom(0)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-full px-5 py-2 text-[13px] font-medium text-white transition disabled:opacity-40"
            style={{ background: accent }}
          >
            <Play className="h-3.5 w-3.5 fill-current" /> 播放全部
          </button>
        </div>
      </section>

      {/* 页签（官方：主页 / 单曲 / 歌单 / 视频） */}
      <div className="mt-6 flex items-center gap-6 border-b border-white/10 pb-2">
        {tabs.map(item => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={`relative pb-1 text-[15px] transition ${tab === item.key ? 'font-semibold' : 'opacity-70 hover:opacity-100'}`}
            style={{ color: tab === item.key ? accent : undefined }}
          >
            {item.label}
            {tab === item.key ? <span className="absolute inset-x-0 -bottom-[9px] h-[2px] rounded" style={{ background: accent }} /> : null}
          </button>
        ))}
      </div>

      {/* 主页：子频道 + 单曲前 10 */}
      {tab === 'home' ? (
        <div className="pt-5">
          {subs.length > 0 ? (
            <section>
              <h2 className={`mb-3 text-[17px] font-semibold ${theme.text}`}>{detail.name}频道</h2>
              <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
                {subs.map(sub => (
                  <button key={sub.id} type="button" onClick={() => onOpenChannel(sub.id)} className="group flex min-w-0 flex-col items-center gap-2" title={sub.name}>
                    <PcCover src={sub.coverUrl} alt={sub.name} className="h-[92px] w-[92px] transition group-hover:-translate-y-0.5" rounded="rounded-full" />
                    <span className={`max-w-full truncate text-[12px] ${theme.text}`}>{sub.name}</span>
                    {sub.type ? <span className={`text-[11px] ${theme.faint}`}>{sub.type}</span> : null}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <section className="mt-8">
            <h2 className={`mb-2 text-[17px] font-semibold ${theme.text}`}>热门单曲</h2>
            <SongRows ctx={ctx} rows={songs.slice(0, 10)} onPlay={playFrom} />
            {songsTotal > 10 ? (
              <button type="button" onClick={() => setTab('songs')} className={`mt-2 text-[12px] ${theme.faint} hover:opacity-80`}>
                查看全部 {kugouCount(songsTotal)} 首 ›
              </button>
            ) : null}
          </section>
        </div>
      ) : null}

      {/* 单曲 */}
      {tab === 'songs' ? (
        <div className="pt-5">
          <SongRows ctx={ctx} rows={songs} onPlay={playFrom} />
          {songs.length < songsTotal ? (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true)
                  const next = songsPage + 1
                  void loadSongs(next).finally(() => { setSongsPage(next); setLoadingMore(false) })
                }}
                className="rounded-full border border-white/15 px-5 py-2 text-[12px] transition hover:bg-white/5"
              >
                {loadingMore ? '加载中…' : `加载更多（已 ${songs.length}/${kugouCount(songsTotal)}）`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 歌单 */}
      {tab === 'playlists' ? (
        <div className="grid grid-cols-2 gap-4 pt-5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {playlists.map(playlist => (
            <button
              key={playlist.specialid}
              type="button"
              onClick={() => ctx.openPlaylist({ id: playlist.specialid, name: playlist.name, coverImgUrl: playlist.coverUrl, trackCount: playlist.songcount, platform: 'kugou' })}
              className="group min-w-0 text-left"
              title={playlist.name}
            >
              <PcCover src={playlist.coverUrl} alt={playlist.name} className="aspect-square w-full transition group-hover:-translate-y-0.5" rounded="rounded-lg" />
              <p className={`mt-2 line-clamp-2 text-[13px] ${theme.text}`}>{playlist.name}</p>
              <p className={`mt-0.5 text-[11px] ${theme.faint}`}>
                {playlist.creator ? `${playlist.creator} · ` : ''}{playlist.songcount ? `${playlist.songcount} 首` : ''}
              </p>
            </button>
          ))}
          {playlists.length === 0 ? <p className={`col-span-full py-10 text-center text-[12px] ${theme.faint}`}>加载中…</p> : null}
        </div>
      ) : null}

      {/* 视频（官方同款卡片；点击走全局 MV 播放器，若宿主未提供则仅展示） */}
      {tab === 'videos' ? (
        <div className="grid grid-cols-2 gap-4 pt-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {videos.map(video => (
            <button
              key={video.id}
              type="button"
              onClick={() => (ctx.actions as any).onOpenMv?.(video)}
              className="group min-w-0 text-left"
              title={video.name}
            >
              <PcCover src={video.coverUrl} alt={video.name} className="aspect-video w-full transition group-hover:-translate-y-0.5" rounded="rounded-lg" />
              <p className={`mt-2 line-clamp-2 text-[13px] ${theme.text}`}>{video.name}</p>
              <p className={`mt-0.5 text-[11px] ${theme.faint}`}>{video.singer}{video.duration ? ` · ${kugouDuration(video.duration)}` : ''}</p>
            </button>
          ))}
          {videos.length === 0 ? <p className={`col-span-full py-10 text-center text-[12px] ${theme.faint}`}>加载中…</p> : null}
        </div>
      ) : null}
    </div>
  )
}

/** 单曲行（封面 + 歌名/歌手 + 时长 + 播放/右键菜单） */
function SongRows({ ctx, rows, onPlay }: { ctx: KugouPcPageContext; rows: Array<{ song: any; track: any }>; onPlay: (index: number) => void }) {
  const theme = ctx.theme
  const accent = ctx.accent
  if (!rows.length) return <p className={`py-8 text-center text-[12px] ${theme.faint}`}>暂无单曲</p>
  return (
    <div className="space-y-1">
      {rows.map((row, index) => (
        <div
          key={`${row.track.hash}-${index}`}
          onDoubleClick={() => onPlay(index)}
          onContextMenu={event => { event.preventDefault(); ctx.actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song: row.song, songs: rows.map(r => r.song) }) }}
          className={`group flex min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 transition ${theme.hover}`}
        >
          <span className={`w-6 shrink-0 text-right text-[12px] tabular-nums ${theme.faint}`}>{index + 1}</span>
          <PcCover src={row.song.album?.picUrl} alt={row.song.name} className="h-10 w-10 shrink-0" rounded="rounded-md" />
          <div className="min-w-0 flex-1">
            <p className={`truncate text-[13px] ${theme.text}`}>{row.song.name}</p>
            <p className={`mt-0.5 truncate text-[11px] ${theme.subtle}`}>{row.song.artists?.map((a: any) => a.name).join(' / ')}</p>
          </div>
          <span className={`hidden shrink-0 text-[11px] tabular-nums sm:block ${theme.faint}`}>{kugouDuration((row.song.duration || 0) / 1000)}</span>
          <button
            type="button"
            onClick={() => onPlay(index)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100"
            style={{ color: accent }}
            aria-label={`播放 ${row.song.name}`}
          >
            <Play className="h-3.5 w-3.5 fill-current" />
          </button>
        </div>
      ))}
    </div>
  )
}

export default memo(KugouPcChannelDetail)
