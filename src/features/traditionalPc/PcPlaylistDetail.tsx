// 官方 PC 客户端风格歌单详情（两个平台共用外壳，skin 决定页签与细节）。
//
// 与旧版 TraditionalPlaylistDetail 的差别：这里完全按客户端排版（大封面头部 + 页签 +
// 提示条 + 表格），并复用 pcKit 的表格，保证与列表页一致的行高/列宽/角标。
// 列表很长时用「滚动到底自动追加」分批渲染 —— 客户端本身是虚拟列表，这里用更轻的做法
// 避免为了一个二级页引入虚拟化依赖。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListPlus, Share2 } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { isSameSong } from '../../services/musicApi'
import { getPlatformCapabilities, platformLabel, type MusicPlatform } from '../../services/platforms'
import { subscribePlaylist } from '../../services/playlistService'
import { getApiBase } from '../../services/apiConfig'
import { fetchExploreChart } from '../../services/exploreApi'
import {
  PcCover, PcDetailHeader, PcGhostButton, PcNoticeBar, PcPrimaryButton, PcSongTable, PcTabs, PcTableSearch,
  PcEmpty, pcTheme, type PcSkin, type PcTone,
} from './pcKit'
import PcComments from './PcComments'
import type { PcActions, PcAccount } from './types'

const PAGE_SIZE = 200

/** 收藏者行（网易云 /netease/playlist/subscribers）。 */
interface SubscriberItem {
  userId: number
  nickname: string
  avatarUrl: string
  signature: string
}

/** 歌单收藏者面板（官方「收藏者」页签：头像网格 + 昵称/签名，分页加载，点进对方主页）。 */
function PlaylistSubscribers({ playlistId, chrome, actions }: {
  playlistId: string
  chrome: { tone: PcTone; skin: PcSkin; accent: string }
  actions: PcActions
}) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const [items, setItems] = useState<SubscriberItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (offset: number, replace: boolean) => {
    if (replace) setLoading(true)
    else setLoadingMore(true)
    try {
      const response = await fetch(`${getApiBase()}/netease/playlist/subscribers?id=${encodeURIComponent(playlistId)}&limit=30&offset=${offset}`, { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok || data?.error) throw new Error(data?.error || `收藏者加载失败 (${response.status})`)
      const list: SubscriberItem[] = Array.isArray(data?.subscribers) ? data.subscribers : []
      setItems(previous => {
        if (replace) return list
        const seen = new Set(previous.map(item => item.userId))
        return [...previous, ...list.filter(item => !seen.has(item.userId))]
      })
      setHasMore(Boolean(data?.hasMore) && list.length > 0)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '收藏者加载失败')
      if (replace) setItems([])
      setHasMore(false)
    } finally {
      if (replace) setLoading(false)
      else setLoadingMore(false)
    }
  }, [playlistId])

  useEffect(() => {
    if (!playlistId) return
    void load(0, true)
  }, [playlistId, load])

  if (!playlistId) return <PcEmpty theme={theme} title="歌单信息不完整" />

  return (
    <div>
      {error && !items.length ? (
        <PcEmpty theme={theme} title="收藏者加载失败" description={error} />
      ) : items.length ? (
        <>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 xl:grid-cols-4">
            {items.map(user => (
              <button
                key={`subscriber:${user.userId}`}
                type="button"
                onClick={() => actions.onOpenUserProfile?.(String(user.userId), user.nickname, user.avatarUrl)}
                className={`flex items-center gap-3 rounded-md px-2 py-2 text-left transition ${theme.hover}`}
              >
                <PcCover src={user.avatarUrl} alt={user.nickname} className="h-10 w-10 shrink-0" rounded="rounded-full" />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[13px] ${theme.text}`}>{user.nickname}</span>
                  {user.signature ? <span className={`mt-[2px] block truncate text-[12px] ${theme.faint}`}>{user.signature}</span> : null}
                </span>
              </button>
            ))}
          </div>
          {hasMore && (
            <div className="flex justify-center pt-4">
              <PcGhostButton
                theme={theme}
                label={loadingMore ? '正在加载…' : '加载更多'}
                onClick={() => { void load(items.length, false) }}
                disabled={loadingMore}
              />
            </div>
          )}
        </>
      ) : (
        <PcEmpty theme={theme} title={loading ? '正在加载收藏者…' : '还没有收藏者'} description={loading ? undefined : '收藏这个歌单的用户会出现在这里'} />
      )}
    </div>
  )
}

type PlaylistLike = {
  id: number | string
  dirId?: number | string
  name: string
  coverImgUrl?: string
  coverUrl?: string
  trackCount?: number
  description?: string
  desc?: string
  creator?: { userId?: number | string; nickname?: string; avatarUrl?: string }
  tags?: string[]
  platform?: MusicPlatform
  isCollected?: boolean
  isLike?: boolean
  playCount?: number
  createTime?: number
} | null

export interface PcPlaylistDetailProps {
  playlist: PlaylistLike
  songs: Song[]
  loading: boolean
  error?: string
  onRetry?: () => void
  chrome: { tone: PcTone; skin: PcSkin; accent: string }
  actions: PcActions
  account: PcAccount
  /** 本人创建的歌单：隐藏「收藏」入口，显示编辑/投稿 */
  isOwner?: boolean
  /** 从父层带入的收藏态（订阅后回写由父层负责） */
  onSubscribeToggle?: () => void
}

function PcPlaylistDetail({
  playlist, songs: propSongs, loading, error = '', onRetry, chrome, actions, account, isOwner = false, onSubscribeToggle,
}: PcPlaylistDetailProps) {
  const theme = pcTheme(chrome.tone)
  const skin = chrome.skin
  const accent = chrome.accent
  const [tab, setTab] = useState('songs')
  const [keyword, setKeyword] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [noticeHidden, setNoticeHidden] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  // 「榜单页」周期选择器（官方榜单页标题旁的 年份 / 第 N 周）：周期变了这里自己重取该期榜单，
  // 并用取回的歌替换页面上那批（propSongs 是进入页面时的当期快照）。
  const isChartPage = Boolean((playlist as { isChart?: boolean } | null)?.isChart)
  const [chartPeriod, setChartPeriod] = useState('')
  const [chartPeriodYears, setChartPeriodYears] = useState<Array<{ year: number; periods: number[] }>>([])
  const [chartPeriodSongs, setChartPeriodSongs] = useState<Song[]>([])
  const [chartPeriodBusy, setChartPeriodBusy] = useState(false)
  const chartPeriodId = isChartPage ? String((playlist as { id?: string | number } | null)?.id || '') : ''
  useEffect(() => {
    if (!chartPeriodId) return
    let cancelled = false
    void fetch(getApiBase() + '/qq/chart/periods?id=' + encodeURIComponent(chartPeriodId), { cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (cancelled) return
        setChartPeriodYears(Array.isArray(payload?.years) ? payload.years : [])
        setChartPeriod(previous => previous || String(payload?.current || ''))
        setChartPeriodSongs([])
      })
      .catch(() => { if (!cancelled) { setChartPeriodYears([]); setChartPeriod('') } })
    return () => { cancelled = true }
  }, [chartPeriodId])
  const switchChartPeriod = useCallback((next: string) => {
    if (!next) return
    setChartPeriod(next)
    setChartPeriodBusy(true)
    const chartLike = {
      id: chartPeriodId,
      name: String((playlist as { name?: string } | null)?.name || 'QQ 音乐榜单'),
      coverUrl: '',
      description: '',
      platform: (playlist?.platform || (skin === 'qq' ? 'qq' : 'netease')) as MusicPlatform,
      songs: [],
    } as unknown as Parameters<typeof fetchExploreChart>[0]
    void fetchExploreChart(chartLike, undefined, next)
      .then(detail => { if (Array.isArray(detail?.songs) && detail.songs.length) setChartPeriodSongs(detail.songs) })
      .catch(() => {})
      .finally(() => setChartPeriodBusy(false))
  }, [chartPeriodId, playlist, skin])
  // 周期选完就把 songs 换成那一期（下游逻辑一行不用改）
  const songs = chartPeriodSongs.length ? chartPeriodSongs : propSongs

  useEffect(() => { setTab('songs'); setVisibleCount(PAGE_SIZE) }, [playlist?.id, skin])

  // 长歌单分批渲染：滚到底部哨兵进入视口就追加下一批
  useEffect(() => {
    const node = sentinelRef.current
    if (!node) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(count => (count < songs.length ? Math.min(songs.length, count + PAGE_SIZE) : count))
      }
    }, { rootMargin: '320px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [songs.length])

  const platform = (playlist?.platform || songs[0]?.platform || (skin === 'qq' ? 'qq' : 'netease')) as MusicPlatform
  const capabilities = getPlatformCapabilities(platform)
  const coverUrl = playlist?.coverImgUrl || playlist?.coverUrl || songs[0]?.album?.picUrl
  const description = playlist?.description || playlist?.desc || ''
  const filtered = useMemo(() => {
    const trimmed = keyword.trim().toLowerCase()
    if (!trimmed) return songs
    return songs.filter(song =>
      song.name.toLowerCase().includes(trimmed)
      || (song.artists || []).some(artist => (artist.name || '').toLowerCase().includes(trimmed))
      || (song.album?.name || '').toLowerCase().includes(trimmed))
  }, [songs, keyword])
  const visibleSongs = filtered.slice(0, visibleCount)
  const trackCount = songs.length || playlist?.trackCount || 0

  const playAll = useCallback(() => {
    if (!songs.length) return
    actions.onPlaySongs(songs[0], songs, 0)
  }, [songs, actions])

  const handleSubscribe = useCallback(() => {
    if (!playlist) return
    const targetId = String(playlist.id || (playlist as { dirId?: string | number }).dirId || '')
    if (!targetId) return
    void subscribePlaylist(targetId, true, platform).then(() => onSubscribeToggle?.()).catch(() => undefined)
  }, [playlist, platform, onSubscribeToggle])

  const creatorName = playlist?.creator?.nickname || (playlist?.isLike && account.username) || (isOwner ? account.username : '')
  const creatorAvatar = playlist?.creator?.avatarUrl || (isOwner || playlist?.isLike ? account.avatar : undefined)
  const meta = [
    platformLabel(platform),
    playlist?.createTime ? `创建于 ${new Date(playlist.createTime).toLocaleDateString('zh-CN')}` : '',
    (playlist?.tags || []).length ? (playlist?.tags || []).map(tag => `#${tag}`).join(' ') : '',
  ].filter(Boolean).join(' · ')

  // 榜单页（playlist.isChart）：官方榜单页没有「评论」页签，也不显示榜单接口没有的专辑列，
  // 所以这里按榜单口径收窄页签与表格列（不摆空列/假页签）。
  const isChart = Boolean((playlist as { isChart?: boolean } | null)?.isChart)
  // 歌单级评论两平台都有接口（网易云 type=2、QQ biztype=3，见 PcComments），
  // 挂「评论」页签内嵌只读评论面板；「收藏者」是网易云专属（/api/playlist/subscribers 分页）。
  const playlistId = String(playlist?.id || (playlist as { dirId?: string | number } | null)?.dirId || '')
  const canShowSubscribers = platform === 'netease' && !isChart && /^\d+$/.test(playlistId)
  const tabItems = [
    { key: 'songs', label: '歌曲', count: trackCount },
    ...(isChart ? [] : [{ key: 'comments', label: '评论' }]),
    ...(canShowSubscribers ? [{ key: 'subscribers', label: '收藏者' }] : []),
  ]

  return (
    <div className="pb-8">
      <PcDetailHeader
        theme={theme}
        skin={skin}
        coverUrl={coverUrl}
        title={playlist?.name || '歌单'}
        playCount={playlist?.playCount}
        description={description}
        meta={meta}
        creator={creatorName ? { name: creatorName, avatar: creatorAvatar } : undefined}
        titleExtra={isChartPage && chartPeriodYears.length ? (
          <span className="inline-flex items-center gap-2">
            <select
              value={chartPeriod}
              onChange={event => switchChartPeriod(event.target.value)}
              disabled={chartPeriodBusy}
              aria-label="选择榜单周期"
              className="rounded-md border border-black/10 bg-black/[0.04] px-2 py-1 text-[12px] dark:border-white/15 dark:bg-white/[0.08]"
            >
              {chartPeriodYears.map(group => (
                <optgroup key={group.year} label={String(group.year)}>
                  {group.periods.map(period => (
                    <option key={String(group.year) + "_" + String(period)} value={String(group.year) + "_" + String(period)}>{"第 " + String(period) + " 周"}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            {chartPeriodBusy ? <span className="text-[12px] opacity-60">切换中…</span> : null}
          </span>
        ) : undefined}
        actions={(
          <>
            <PcPrimaryButton label="播放" accent={accent} onClick={playAll} disabled={!songs.length} />
            {/* 「我喜欢的音乐」是系统歌单：官方没有收藏入口，也不该出现收藏按钮 */}
            {!isOwner && !playlist?.isLike && (
              <PcGhostButton
                label={playlist?.isCollected ? '已收藏' : '收藏'}
                icon={<ListPlus className="h-3.5 w-3.5" />}
                theme={theme}
                onClick={handleSubscribe}
                disabled={!capabilities.subscribePlaylist}
              />
            )}
            {/* 下载/批量在本软件没有链路，更多菜单由行右键承担：都不渲染假入口 */}
            {actions.onSharePlaylist && playlist ? (
              <PcGhostButton label="分享" icon={<Share2 className="h-3.5 w-3.5" />} theme={theme} onClick={() => actions.onSharePlaylist?.(playlist)} />
            ) : null}
          </>
        )}
      />

      {/* 页签 + 右端搜索 */}
      <div className={`mb-3 flex items-end justify-between gap-4 border-b ${theme.divider}`}>
        <PcTabs items={tabItems} value={tab} onChange={setTab} accent={accent} theme={theme} />
        <div className="pb-1.5">
          <PcTableSearch value={keyword} onChange={setKeyword} theme={theme} accent={accent} placeholder="搜索" />
        </div>
      </div>

      {skin === 'netease' && !noticeHidden && !isOwner && (
        <PcNoticeBar theme={theme} onClose={() => setNoticeHidden(true)}>
          <span className="truncate">会员可畅听本歌单内的高音质与 VIP 歌曲</span>
        </PcNoticeBar>
      )}

      {error ? (
        <div className={`rounded-lg px-3 py-2 text-[12px] ${theme.surface} ${theme.subtle}`}>
          {error}
          {onRetry ? <button type="button" onClick={onRetry} className="ml-2 underline">重试</button> : null}
        </div>
      ) : null}

      {tab === 'songs' && (
        <>
          <PcSongTable
            songs={visibleSongs}
            skin={skin}
            theme={theme}
            accent={accent}
            loading={loading && !songs.length}
            // 榜单页按数据决定列：榜单接口本来就带专辑/时长（实测美国公告牌 108 都有），有就显示、
            // 没有才不摆空列；榜单页也不挂评论页签（官方榜单页没有）。
            columns={{
              index: true,
              like: true,
              album: isChart ? filtered.some(song => Boolean(song.album?.name)) : true,
              duration: isChart ? filtered.some(song => Boolean(song.duration)) : true,
            }}
            playingKey={actions.currentSongKey}
            isPlaying={actions.isPlaying}
            onPlay={(song, index) => actions.onPlaySongs(song, filtered, index)}
            onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: filtered }) }}
            likedKeys={actions.likedKeys}
            onToggleLike={actions.onToggleLike}
            empty={<PcEmpty theme={theme} title="这个歌单还没有可播放的歌曲" />}
            rowActions={(song) => (
              <>
                <button type="button" className={`text-[11px] ${theme.faint} hover:opacity-80`} onClick={event => { event.stopPropagation(); actions.onOpenComments?.(song) }}>评论</button>
              </>
            )}
          />
          <div ref={sentinelRef} />
          {visibleCount < filtered.length && (
            <div className={`py-4 text-center text-[12px] ${theme.faint}`}>正在载入更多…（已显示 {visibleSongs.length}/{filtered.length}）</div>
          )}
        </>
      )}

      {tab === 'comments' && playlist ? (
        <PcComments
          platform={platform}
          resourceId={playlistId}
          resourceIdKind="playlist"
          chrome={chrome}
          actions={actions}
        />
      ) : null}

      {tab === 'subscribers' && canShowSubscribers ? (
        <PlaylistSubscribers playlistId={playlistId} chrome={chrome} actions={actions} />
      ) : null}
    </div>
  )
}

export default memo(PcPlaylistDetail)
export { isSameSong }
