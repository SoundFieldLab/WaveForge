// 酷狗音乐 PC 客户端「最近播放」页。
//
// 对齐官方截图（D:\opencode\.tmp-kg-tab-zuijin.png）：大标题 + 页签（带真实计数）+
// 播放工具条 + 曲目行（波形图标 / 封面 / 曲名+MV角标 / 歌手 / 「听过N次」/ 时长 / 红心 / 更多）。
// 数据源 = 概念版真实播放历史 /playhistory/v1/get_songs（含每首播放次数 pc 与播放时间 ot），
// 不是旧的「每日推荐历史」接口；上拉按上游 bp 游标翻页。
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Headphones, Heart, ListPlus, Play } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { fetchKugouPlayRecords, kugouTrackToSong } from '../../services/kugouService'
import { PcCover, PcEmpty, PcIconButton, PcListFooter, PcTabs, type PcTabItem } from './pcKit'
import { kugouDuration, type KugouPcPageContext } from './KugouPcShared'

export interface KugouPcRecentProps {
  ctx: KugouPcPageContext
  /** 登录态/播放历史变化时重取（与 authRevision 同源） */
  authRevision?: number
}

interface RecentRow {
  song: Song
  /** 播放次数（上游 pc） */
  playCount: number
  /** 最近一次播放时间（上游 ot，秒） */
  playedAt: number
}

/** 集合页缓存：切走再回来不重打接口（登录态变化时由 authRevision 失效）。 */
const recentCache = new Map<string, { rows: RecentRow[]; bp: string; hasMore: boolean }>()

function KugouPcRecent({ ctx, authRevision = 0 }: KugouPcRecentProps) {
  const theme = ctx.theme
  const accent = ctx.accent
  const loggedIn = ctx.account.loggedIn
  const userId = ctx.account.userId || ''
  const [tab, setTab] = useState('songs')
  const [rows, setRows] = useState<RecentRow[]>([])
  const [bp, setBp] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const cacheKey = `${userId}:${authRevision}`

  useEffect(() => {
    if (!ctx.active) return
    if (!loggedIn) { setRows([]); setError(''); setLoading(false); return }
    const cached = recentCache.get(cacheKey)
    if (cached) {
      setRows(cached.rows); setBp(cached.bp); setHasMore(cached.hasMore); setLoading(false); setError('')
      return
    }
    const requestId = ++requestRef.current
    let cancelled = false
    setLoading(true)
    setError('')
    void fetchKugouPlayRecords()
      .then(result => {
        if (cancelled || requestId !== requestRef.current) return
        const next = result.records.map(record => ({
          song: kugouTrackToSong(record.track),
          playCount: record.pc,
          playedAt: record.ot,
        }))
        recentCache.set(cacheKey, { rows: next, bp: result.bp, hasMore: result.hasMore })
        setRows(next)
        setBp(result.bp)
        setHasMore(result.hasMore)
        setLoading(false)
      })
      .catch((loadError: unknown) => {
        if (cancelled || requestId !== requestRef.current) return
        setRows([])
        setLoading(false)
        setError(loadError instanceof Error ? loadError.message : '最近播放加载失败')
      })
    return () => { cancelled = true }
  }, [ctx.active, loggedIn, cacheKey])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !bp) return
    setLoadingMore(true)
    try {
      const result = await fetchKugouPlayRecords(bp)
      const next = result.records.map(record => ({
        song: kugouTrackToSong(record.track),
        playCount: record.pc,
        playedAt: record.ot,
      }))
      setRows(prev => {
        const seen = new Set(prev.map(row => row.song.mid || String(row.song.id)))
        const merged = [...prev, ...next.filter(row => !seen.has(row.song.mid || String(row.song.id)))]
        recentCache.set(cacheKey, { rows: merged, bp: result.bp, hasMore: result.hasMore })
        return merged
      })
      setBp(result.bp)
      setHasMore(result.hasMore)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载更多失败')
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, hasMore, bp, cacheKey])

  const songs = rows.map(row => row.song)

  const tabs: PcTabItem[] = [{ key: 'songs', label: '单曲', count: rows.length || undefined }]

  if (!loggedIn) {
    return (
      <div data-kugou-pc-page="recent">
        <h1 className={`mb-4 text-[26px] font-semibold leading-tight ${theme.text}`}>最近播放</h1>
        <PcEmpty theme={theme} title="登录后同步最近播放记录" description="登录酷狗（概念版扫码）后即可看到云端播放历史" />
      </div>
    )
  }

  return (
    <div className="pb-8" data-kugou-pc-page="recent">
      <h1 className={`mb-4 text-[26px] font-semibold leading-tight ${theme.text}`}>最近播放</h1>

      <div className={`mb-4 border-b ${theme.divider}`}>
        <PcTabs items={tabs} value={tab} onChange={setTab} accent={accent} theme={theme} />
      </div>

      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          disabled={!songs.length}
          onClick={() => { if (songs[0]) ctx.actions.onPlaySongs(songs[0], songs, 0) }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-4 text-[13px] font-medium text-white transition disabled:opacity-40"
          style={{ background: accent }}
        >
          <Play className="h-3.5 w-3.5 fill-current" /> 播放
        </button>
        <PcIconButton theme={theme} title="加入播放列表" onClick={() => { if (songs[0]) ctx.actions.onPlaySongs(songs[0], songs, 0) }}>
          <ListPlus className="h-4 w-4" />
        </PcIconButton>
        <span className={`ml-auto text-[12px] ${theme.faint}`}>官方的歌单/视频/频道页签在上游没有对应播放历史接口，这里只提供单曲</span>
      </div>

      {loading && rows.length === 0 ? (
        <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>
      ) : rows.length === 0 ? (
        <PcEmpty theme={theme} title="暂无最近播放记录" description={error || '客户端播放过的歌曲会同步到这里'} />
      ) : (
        <div className="w-full">
          {rows.map((row, index) => {
            const active = Boolean(ctx.actions.currentSongKey) && ctx.actions.currentSongKey === `${row.song.platform}:${row.song.id || row.song.mid}`
            return (
              <div
                key={`${row.song.mid || row.song.id}:${index}`}
                onDoubleClick={() => ctx.actions.onPlaySongs(row.song, songs, index)}
                onContextMenu={event => { event.preventDefault(); ctx.actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song: row.song, songs }) }}
                className={`group flex items-center gap-3 rounded-md px-2 py-[7px] text-[13px] transition ${theme.hover} ${index % 2 === 1 ? theme.surface : ''}`}
              >
                <span className="flex w-5 shrink-0 items-center justify-center text-[11px] tabular-nums" style={active ? { color: accent } : undefined}>
                  {active
                    ? <Headphones className="h-3.5 w-3.5" />
                    : (
                      <>
                        <span className={`${theme.faint} group-hover:hidden`}>{String(index + 1).padStart(2, '0')}</span>
                        <button
                          type="button"
                          onClick={() => ctx.actions.onPlaySongs(row.song, songs, index)}
                          className="hidden group-hover:flex"
                          aria-label={`播放 ${row.song.name}`}
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                        </button>
                      </>
                    )}
                </span>
                <PcCover src={row.song.album?.picUrl} alt={row.song.name} className="h-10 w-10 shrink-0" rounded="rounded-md" />
                <span className="min-w-0 flex-1">
                  <span className={`flex items-center gap-1.5 ${active ? 'font-medium' : ''}`} style={active ? { color: accent } : undefined}>
                    <span className={`truncate ${active ? '' : theme.text}`}>{row.song.name}</span>
                  </span>
                  <span className={`mt-[2px] block truncate text-[12px] ${theme.subtle}`}>{row.song.artists?.map(artist => artist.name).join(' / ')}</span>
                </span>
                <span className={`hidden w-[90px] shrink-0 text-right text-[12px] md:block ${theme.faint}`}>
                  {row.playCount > 0 ? `听过${row.playCount}次` : ''}
                </span>
                <span className={`w-[52px] shrink-0 text-right text-[12px] tabular-nums ${theme.faint}`}>{kugouDuration(row.song.duration ? row.song.duration / 1000 : 0)}</span>
                <span className="w-6 shrink-0 text-center">
                  <button
                    type="button"
                    onClick={() => ctx.actions.onToggleLike?.(row.song, !(ctx.actions.isLiked?.(row.song) ?? false))}
                    aria-label={ctx.actions.isLiked?.(row.song) ? '取消喜欢' : '喜欢'}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100"
                    style={{ opacity: ctx.actions.isLiked?.(row.song) ? 1 : undefined }}
                  >
                    <Heart
                      className={`h-3.5 w-3.5 ${ctx.actions.isLiked?.(row.song) ? '' : theme.faint}`}
                      style={ctx.actions.isLiked?.(row.song) ? { color: accent, fill: accent } : undefined}
                    />
                  </button>
                </span>
              </div>
            )
          })}
          {hasMore ? (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
                className={`rounded-full px-5 py-2 text-[13px] transition disabled:opacity-50 ${theme.solidBtn}`}
              >
                {loadingMore ? '正在加载…' : '加载更多'}
              </button>
            </div>
          ) : (
            <PcListFooter theme={theme} label={`已同步 ${rows.length} 首播放记录`} />
          )}
        </div>
      )}
    </div>
  )
}

export default memo(KugouPcRecent)
