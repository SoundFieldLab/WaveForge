// QQ 音乐 PC 客户端「个人中心」页（官方个人主页版式的复刻）。
//
// 版式：大头像 + 昵称 + 会员牌 + 「粉丝：N 关注：M」→ 页签「我喜欢 / 创建的歌单」→ 内容区。
// 官方的「上传的视频」在本软件没有数据源（既没有上传链路也没有视频列表接口），整个页签不做，不留空壳。
//
// 数据诚实性：
//   · 粉丝/关注两个数字按「父层已给的 → 用户主页接口 → 关注/粉丝列表接口」三级降级，
//     任何一级都拿不到就整段不渲染（宁可没有，也不把首页 30 条说成总数、更不写死 0）；
//   · 接口失败一律静默降级成空态，不抛错、不白屏。
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Crown, User } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { getQQFans, getQQFollows, getQQUserProfile } from '../../services/musicApi'
import { fetchExplorePlaylist } from '../../services/exploreApi'
import { getUserPlaylists } from '../../services/playlistService'
import {
  PcCardGrid, PcCover, PcEmpty, PcGhostButton, PcListFooter, PcPrimaryButton, PcSongTable,
  PcTableSearch, PcTabs, pcSongKey, pcTheme, type PcTabItem,
} from './pcKit'
import type { PcAccount, PcActions } from './types'
import { accountTierBadgeClass, getAccountTierBadge } from '../../services/accountTier'

export interface QQPcProfileProps {
  chrome: { tone: 'light' | 'dark'; skin: 'qq'; accent: string }
  account: PcAccount
  actions: PcActions
  /** 登录态变化时用来触发重取 */
  authRevision?: number
  /** 页面是否可见（隐藏保活页为 false，用于跳过请求） */
  active?: boolean
  /** 父层已拿到的关注/粉丝数（没有就自己取） */
  follows?: number
  fans?: number
}

/** 父层未接线时的兜底：页面必须能独立渲染，不许因缺回调抛错。 */
const FALLBACK_ACTIONS: PcActions = {
  onPlaySongs: () => {},
  onSongMenu: () => {},
  onOpenPlaylist: () => {},
  onNavigate: () => {},
}

/** 计数只接受有效非负数字；空串/NaN/负数一律当成「接口没给」。 */
function toCount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function QQPcProfile({
  chrome, account, actions, authRevision = 0, active = true, follows, fans,
}: QQPcProfileProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const act = actions || FALLBACK_ACTIONS
  const loggedIn = Boolean(account?.loggedIn)
  const userId = account?.userId || ''

  const [tab, setTab] = useState('liked')
  const [query, setQuery] = useState('')
  /** 手动重试令牌：失败后点「重新加载」时 +1，让下面的 effect 重新发请求 */
  const [reload, setReload] = useState(0)
  const [songs, setSongs] = useState<Song[]>([])
  const [createdPlaylists, setCreatedPlaylists] = useState<any[]>([])
  const [listsState, setListsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [counts, setCounts] = useState<{ fans?: number; follows?: number }>({})
  const listsKeyRef = useRef('')
  const countsKeyRef = useRef('')

  /* ── 粉丝 / 关注数字 ── */
  const countsKey = `${userId}:${authRevision}`
  useEffect(() => {
    // 父层两个数都给了就不用发请求
    if (fans !== undefined && follows !== undefined) return
    if (!active || !loggedIn) return
    if (countsKeyRef.current === countsKey) return
    countsKeyRef.current = countsKey
    let cancelled = false
    void (async () => {
      const next: { fans?: number; follows?: number } = {}
      // 1) 用户主页接口一次同时给 followNum / fansNum（精确值）。
      //    注意：上游查询失败时它也会回 0，所以这里只接受 >0 的值，
      //    否则「查不到」会被显示成「你有 0 个粉丝」。
      if (userId) {
        const profile = await getQQUserProfile(userId).catch(() => null)
        const data = profile?.data
        const profileFans = toCount(data?.fansNum)
        const profileFollows = toCount(data?.followNum)
        if (profileFans && profileFans > 0) next.fans = profileFans
        if (profileFollows && profileFollows > 0) next.follows = profileFollows
      }
      // 2) 列表接口兜底：只有服务端明确「没有更多」时，这一页的条数才等于总数
      //    （还有下一页时把 30 条当总数就是编数字，宁可不显示）。
      if (next.fans === undefined || next.follows === undefined) {
        const [fansPayload, followsPayload] = await Promise.all([
          next.fans === undefined ? getQQFans({}).catch(() => null) : Promise.resolve(null),
          next.follows === undefined ? getQQFollows({}).catch(() => null) : Promise.resolve(null),
        ])
        if (next.fans === undefined && fansPayload?.data?.hasMore === false) next.fans = toCount((fansPayload.data?.list || []).length)
        if (next.follows === undefined && followsPayload?.data?.hasMore === false) next.follows = toCount((followsPayload.data?.list || []).length)
      }
      if (!cancelled) setCounts(next)
    })()
    return () => {
      cancelled = true
      // 中断后允许下次可见时重来，否则数字会永远空着
      if (countsKeyRef.current === countsKey) countsKeyRef.current = ''
    }
  }, [fans, follows, active, loggedIn, userId, countsKey])

  const shownFans = fans ?? counts.fans
  const shownFollows = follows ?? counts.follows

  /* ── 歌单：我喜欢（系统歌单详情）+ 创建的歌单 ── */
  const listsKey = `${userId}:${authRevision}:${reload}`
  useEffect(() => {
    if (!active || !loggedIn || !userId) {
      setSongs([])
      setCreatedPlaylists([])
      setListsState('idle')
      return
    }
    if (listsKeyRef.current === listsKey) return
    listsKeyRef.current = listsKey
    let cancelled = false
    setListsState('loading')
    void (async () => {
      try {
        const raw = await getUserPlaylists('qq', userId, account?.username || undefined).catch(() => [] as any[])
        if (cancelled) return
        const lists = Array.isArray(raw) ? raw : []
        const liked = lists.find((item: any) => item?.isLike)
        // 「创建的歌单」只放自建：收藏的他人歌单带 isCollected 标记，不属于「我创建的」
        setCreatedPlaylists(lists.filter((item: any) => !item?.isLike && !item?.isCollected))
        if (!liked) {
          if (!cancelled) { setSongs([]); setListsState('ready') }
          return
        }
        // 列表接口只给标识与元信息，曲目必须走歌单详情（网关返回归一化 Song，时长已是毫秒）
        const detail = await fetchExplorePlaylist({
          id: String(liked.id || liked.dirId || ''),
          name: liked.name || '我喜欢',
          coverUrl: liked.coverImgUrl || liked.coverUrl || '',
          trackCount: Number(liked.trackCount || 0),
          platform: 'qq',
        }).catch(() => null)
        if (cancelled) return
        setSongs(Array.isArray(detail?.songs) ? detail.songs : [])
        setListsState('ready')
      } catch {
        if (cancelled) return
        setSongs([])
        setCreatedPlaylists([])
        setListsState('error')
      }
    })()
    return () => {
      cancelled = true
      if (listsKeyRef.current === listsKey) listsKeyRef.current = ''
    }
  }, [active, loggedIn, userId, account?.username, listsKey])

  /* ── 表格数据 ── */

  // 本地过滤（官方表头右侧的搜索框就是过滤当前列表，不重新请求）
  const visibleSongs = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return songs
    return songs.filter(song => [
      song.name,
      (song.artists || []).map(artist => artist.name).join(' '),
      song.album?.name || '',
    ].join(' ').toLowerCase().includes(keyword))
  }, [songs, query])

  // 「我喜欢」歌单里的曲目天然已喜欢：红心必须实心（父层快照可能还没同步到这几首）
  const likedKeys = useMemo(() => {
    const keys = new Set<string>(act.likedKeys || [])
    for (const song of songs) keys.add(pcSongKey(song))
    return keys
  }, [act.likedKeys, songs])

  const tabs = useMemo<PcTabItem[]>(() => ([
    { key: 'liked', label: '我喜欢', count: songs.length || undefined },
    { key: 'created', label: '创建的歌单', count: createdPlaylists.length || undefined },
  ]), [songs.length, createdPlaylists.length])

  if (!loggedIn) {
    return (
      <PcEmpty
        theme={theme}
        title="登录后查看个人中心"
        description="同步你的我喜欢与创建的歌单"
        action={act.onLogin ? <PcPrimaryButton label="立即登录" icon={<User className="h-3.5 w-3.5" />} onClick={act.onLogin} accent={accent} /> : undefined}
      />
    )
  }

  return (
    <div className="pb-8">
      {/* ── 头部：大头像 + 昵称 + 会员牌 + 粉丝/关注 ── */}
      <div className="mb-5 flex items-center gap-5">
        <PcCover
          src={account.avatar}
          alt={`${account.username || '用户'}头像`}
          className="h-24 w-24 shrink-0"
          rounded="rounded-full"
          eager
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className={`truncate text-[24px] font-semibold leading-tight ${theme.text}`}>{account.username || 'QQ 音乐用户'}</h1>
            {(() => {
              // 会员级别区分：超级会员（杜比/臻品母带/臻品音质门槛）与绿钻 VIP 分开标注
              const tierBadge = getAccountTierBadge('qq', account.vip)
              if (!tierBadge) return null
              return (
                <span className={`flex shrink-0 items-center gap-0.5 rounded-[4px] px-1.5 text-[11px] font-medium leading-[17px] ${accountTierBadgeClass(tierBadge.tone)}`}>
                  <Crown className="h-3 w-3" />
                  {tierBadge.label}
                </span>
              )
            })()}
          </div>
          {/* 两个数字都拿不到时整段不渲染（不写死 0） */}
          {shownFans !== undefined || shownFollows !== undefined ? (
            <p className={`mt-2 flex items-center gap-4 text-[12px] ${theme.subtle}`}>
              {shownFans !== undefined ? <span>粉丝：{shownFans}</span> : null}
              {shownFollows !== undefined ? <span>关注：{shownFollows}</span> : null}
            </p>
          ) : null}
        </div>
      </div>

      {/* ── 页签 ── */}
      <div className={`mb-5 border-b ${theme.divider}`}>
        <PcTabs items={tabs} value={tab} onChange={setTab} accent={accent} theme={theme} />
      </div>

      {tab === 'liked' ? (
        !userId ? (
          <PcEmpty theme={theme} title="登录信息不完整" description="缺少账号 id，请重新登录 QQ 音乐后再试" />
        ) : (
          <>
            {/* 操作条：左「播放全部」，右搜索（官方表格右上的搜索入口） */}
            <div className="mb-3 flex items-center gap-2">
              <PcPrimaryButton
                label="播放全部"
                accent={accent}
                disabled={!visibleSongs.length}
                onClick={() => { if (visibleSongs.length) act.onPlaySongs(visibleSongs[0], visibleSongs, 0) }}
              />
              <div className="ml-auto">
                <PcTableSearch
                  value={query}
                  onChange={setQuery}
                  placeholder="搜索我喜欢的音乐"
                  accent={accent}
                  theme={theme}
                />
              </div>
            </div>
            <PcSongTable
              songs={visibleSongs}
              skin="qq"
              theme={theme}
              accent={accent}
              columns={{ index: true, like: true, album: true, duration: true }}
              loading={listsState === 'loading' && !songs.length}
              playingKey={act.currentSongKey}
              isPlaying={act.isPlaying}
              likedKeys={likedKeys}
              onPlay={(song, index) => act.onPlaySongs(song, visibleSongs, index)}
              onMenu={(event, song) => {
                event.preventDefault()
                act.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: visibleSongs })
              }}
              onToggleLike={(song, next) => act.onToggleLike?.(song, next)}
              empty={(
                <PcEmpty
                  theme={theme}
                  title={query ? '没有匹配的歌曲' : '暂无喜欢的歌曲'}
                  description={query ? '换个关键词试试' : (listsState === 'error' ? '我喜欢加载失败，稍后重试' : '在歌曲上点红心就会出现在这里')}
                  action={!query && listsState === 'error'
                    ? <PcGhostButton label="重新加载" theme={theme} onClick={() => setReload(value => value + 1)} />
                    : undefined}
                />
              )}
            />
            {songs.length ? <PcListFooter theme={theme} label={`共 ${songs.length} 首`} /> : null}
          </>
        )
      ) : (
        <div>
          {listsState === 'loading' && !createdPlaylists.length ? (
            <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>
          ) : createdPlaylists.length ? (
            <PcCardGrid
              items={createdPlaylists.map(playlist => ({
                key: `qq-created:${playlist.id || playlist.dirId || playlist.name}`,
                coverUrl: playlist.coverImgUrl || playlist.coverUrl,
                title: playlist.name || '歌单',
                subtitle: playlist.trackCount ? `${playlist.trackCount} 首` : undefined,
                playCount: playlist.playCount,
                onClick: () => act.onOpenPlaylist(playlist),
                onContextMenu: (event: ReactMouseEvent) => {
                  event.preventDefault()
                  act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist })
                },
              }))}
              theme={theme}
              accent={accent}
              columns={6}
            />
          ) : (
            <PcEmpty
              theme={theme}
              title="还没有创建歌单"
              description={listsState === 'error' ? '歌单加载失败，稍后重试' : '在客户端新建的歌单会出现在这里'}
              action={listsState === 'error' ? <PcGhostButton label="重新加载" theme={theme} onClick={() => setReload(value => value + 1)} /> : undefined}
            />
          )}
        </div>
      )}
    </div>
  )
}

export default memo(QQPcProfile)
