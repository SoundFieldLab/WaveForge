// 网易云音乐 PC 客户端「个人主页」页（官方个人主页版式的复刻）。
//
// 版式：大头像 + 昵称 + 会员牌 + 「动态 N 关注 M 粉丝 K」+ 签名 → 页签「我喜欢的音乐 / 创建的歌单 / 收藏的歌单」→ 内容区。
// 官方主页还有「动态 / 客户端扫码登录记录」等区块，本软件没有对应数据源，整体不做，不留空壳。
//
// 数据诚实性：
//   · 动态/关注/粉丝三个数字只接受用户详情接口给出的 >0 值，
//     接口失败或上游回 0 时对应数字不渲染（宁可没有，也不把查不到写成 0）；
//   · 接口失败一律静默降级成空态，不抛错、不白屏。
//
// profileUserId 有值时是「看别人的主页」（用户详情/用户歌单都是公开接口，无需登录态）；
// 为空时是自己的主页，走登录态账号 + getUserPlaylists（与「我喜欢的音乐」页同一条链路）。
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Crown, User } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { getUserDetail, getUserPlaylistList, getUserRecordRank } from '../../services/musicApi'
import { fetchExplorePlaylist } from '../../services/exploreApi'
import { getUserPlaylists } from '../../services/playlistService'
import {
  PcCardGrid, PcCover, PcEmpty, PcGhostButton, PcListFooter, PcPrimaryButton, PcSongTable,
  PcTableSearch, PcTabs, pcSongKey, pcTheme, type PcTabItem,
} from './pcKit'
import type { PcAccount, PcActions, PcChrome } from './types'

export interface NeteasePcProfileProps {
  chrome: PcChrome
  account: PcAccount
  actions: PcActions
  /** 登录态变化时用来触发重取 */
  authRevision?: number
  /** 页面是否可见（隐藏保活页为 false，用于跳过请求） */
  active?: boolean
  /** 要查看的用户 id；为空表示自己的主页（用账号 userId） */
  profileUserId?: string
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

/** 用户歌单行的创建者 id：user/playlist 行带 userId，也有 creator.userId 兜底。 */
function rowOwnerId(row: any): string {
  return String(row?.userId ?? row?.creator?.userId ?? '')
}

function NeteasePcProfile({
  chrome, account, actions, authRevision = 0, active = true, profileUserId = '',
}: NeteasePcProfileProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const act = actions || FALLBACK_ACTIONS
  const loggedIn = Boolean(account?.loggedIn)
  const accountUserId = String(account?.userId || '')
  // 看别人 = profileUserId 有值（公开接口，未登录也能看）；否则是自己的主页
  const targetUid = profileUserId || accountUserId

  const [tab, setTab] = useState('liked')
  const [query, setQuery] = useState('')
  /** 手动重试令牌：失败后点「重新加载」时 +1，让下面的 effect 重新发请求 */
  const [reload, setReload] = useState(0)
  const [songs, setSongs] = useState<Song[]>([])
  const [createdPlaylists, setCreatedPlaylists] = useState<any[]>([])
  const [subscribedPlaylists, setSubscribedPlaylists] = useState<any[]>([])
  const [listsState, setListsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [profileMeta, setProfileMeta] = useState<{ nickname?: string; avatar?: string; signature?: string; vip?: boolean }>({})
  const [counts, setCounts] = useState<{ events?: number; follows?: number; followeds?: number }>({})
  // 听歌排行（官方个人主页的「听歌排行」区块：周榜/累计 两档）
  const [rankRange, setRankRange] = useState<'week' | 'all'>('week')
  const [rankSongs, setRankSongs] = useState<Array<{ id: number; name: string; artist: string; coverUrl: string; playCount: number }>>([])
  const [rankState, setRankState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const listsKeyRef = useRef('')
  const metaKeyRef = useRef('')
  const rankKeyRef = useRef('')

  /* ── 头部：昵称 / 头像 / 签名 / 动态·关注·粉丝 ── */
  const metaKey = `${targetUid}:${authRevision}`
  useEffect(() => {
    if (!active || !targetUid) return
    if (metaKeyRef.current === metaKey) return
    metaKeyRef.current = metaKey
    let cancelled = false
    void (async () => {
      // 用户详情是公开接口（看别人也要用它取签名与三个计数）；失败就退回账号信息，不阻塞页签
      const detail = await getUserDetail(targetUid).catch(() => null)
      if (cancelled) return
      const profile = detail?.profile || {}
      setProfileMeta({
        nickname: String(profile?.nickname || '') || undefined,
        avatar: String(profile?.avatarUrl || '') || undefined,
        signature: String(profile?.signature || '') || undefined,
        // 自己的会员态以账号快照为准；看别人时用 vipType（10=VIP 11=SVIP）判定
        vip: profileUserId ? Number(profile?.vipType) >= 10 : Boolean(account?.vip),
      })
      // 上游查询失败时也会回 0，这里只接受 >0 的值，否则「查不到」会被显示成「你有 0 个粉丝」
      const events = toCount(profile?.eventCount)
      const follows = toCount(profile?.follows)
      const followeds = toCount(profile?.followeds)
      setCounts({
        events: events && events > 0 ? events : undefined,
        follows: follows && follows > 0 ? follows : undefined,
        followeds: followeds && followeds > 0 ? followeds : undefined,
      })
    })()
    return () => {
      cancelled = true
      // 中断后允许下次可见时重来，否则数字会永远空着
      if (metaKeyRef.current === metaKey) metaKeyRef.current = ''
    }
  }, [active, targetUid, metaKey, profileUserId, account?.vip])

  /* ── 歌单：我喜欢的音乐（系统歌单详情）+ 创建的歌单 + 收藏的歌单 ── */
  const listsKey = `${targetUid}:${authRevision}:${reload}`
  useEffect(() => {
    if (!active || !targetUid || (!loggedIn && !profileUserId)) {
      setSongs([])
      setCreatedPlaylists([])
      setSubscribedPlaylists([])
      setListsState('idle')
      return
    }
    if (listsKeyRef.current === listsKey) return
    listsKeyRef.current = listsKey
    let cancelled = false
    setListsState('loading')
    void (async () => {
      try {
        // 自己的歌单走 playlistService（有缓存与 isLike/isCollected 归一化）；
        // 看别人走公开的用户歌单接口（同样的原始行结构，归一化逻辑共用）。
        const raw = profileUserId
          ? await getUserPlaylistList(targetUid).catch(() => null)
          : await getUserPlaylists('netease', targetUid, account?.username || undefined).catch(() => [] as any[])
        if (cancelled) return
        const lists = Array.isArray(raw) ? raw : Array.isArray(raw?.playlist) ? raw.playlist : []
        // 「我喜欢的音乐」= 系统歌单（specialType 5）；映射层已给 isLike，看别人的原始行按 specialType/名称兜底
        const liked = lists.find((item: any) => item?.isLike === true || Number(item?.specialType) === 5)
          || lists.find((item: any) => rowOwnerId(item) === targetUid && /我喜欢的音乐/.test(String(item?.name || '')))
        // 「创建的歌单」只放自建；收藏的他人歌单（creator 不是本人）归「收藏的歌单」
        const isOwner = (item: any) => rowOwnerId(item) === targetUid
        setCreatedPlaylists(lists.filter((item: any) => item !== liked && isOwner(item)))
        setSubscribedPlaylists(lists.filter((item: any) => !isOwner(item)))
        if (!liked) {
          if (!cancelled) { setSongs([]); setListsState('ready') }
          return
        }
        // 列表接口只给标识与元信息，曲目必须走歌单详情（网关返回归一化 Song，时长已是毫秒）
        const detail = await fetchExplorePlaylist({
          id: String(liked.id || ''),
          name: liked.name || '我喜欢的音乐',
          coverUrl: liked.coverImgUrl || liked.coverUrl || '',
          trackCount: Number(liked.trackCount || 0),
          platform: 'netease',
        }).catch(() => null)
        if (cancelled) return
        setSongs(Array.isArray(detail?.songs) ? detail.songs : [])
        setListsState('ready')
      } catch {
        if (cancelled) return
        setSongs([])
        setCreatedPlaylists([])
        setSubscribedPlaylists([])
        setListsState('error')
      }
    })()
    return () => {
      cancelled = true
      if (listsKeyRef.current === listsKey) listsKeyRef.current = ''
    }
  }, [active, loggedIn, targetUid, account?.username, profileUserId, listsKey])

  /* ── 听歌排行（仅自己的主页：官方接口是账号态数据）── */
  const rankKey = `${targetUid}:${rankRange}:${authRevision}:${reload}`
  useEffect(() => {
    if (!active || profileUserId || !loggedIn || !targetUid) {
      if (!profileUserId) setRankState(previous => (previous === 'idle' ? previous : 'idle'))
      return
    }
    if (rankKeyRef.current === rankKey) return
    rankKeyRef.current = rankKey
    let cancelled = false
    setRankState('loading')
    void (async () => {
      try {
        const data = await getUserRecordRank(targetUid, rankRange === 'week' ? 1 : 0)
        if (cancelled) return
        const raw = rankRange === 'week' ? data?.weekData : data?.allData
        const list = (Array.isArray(raw) ? raw : []).map((item: any) => {
          const track = item?.song && typeof item.song === 'object' ? item.song : item
          const artists = Array.isArray(track?.ar) ? track.ar : Array.isArray(track?.artists) ? track.artists : []
          return {
            id: Number(track?.id ?? item?.id ?? 0),
            name: String(track?.name || ''),
            artist: artists.map((artist: any) => artist?.name).filter(Boolean).join(' / '),
            coverUrl: String(track?.al?.picUrl || track?.al?.pic || track?.album?.picUrl || '').replace(/^http:/, 'https:'),
            playCount: Number(track?.playCount ?? item?.playCount ?? 0),
          }
        }).filter((song: { id: number; name: string }) => song.id && song.name)
        setRankSongs(list)
        setRankState('ready')
      } catch {
        if (cancelled) return
        setRankSongs([])
        setRankState('error')
      }
    })()
    return () => {
      cancelled = true
      if (rankKeyRef.current === rankKey) rankKeyRef.current = ''
    }
  }, [active, loggedIn, targetUid, profileUserId, rankRange, rankKey, authRevision, reload])

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

  // 「我喜欢的音乐」歌单里的曲目天然已喜欢：红心必须实心（父层快照可能还没同步到这几首）。
  // 仅限自己的主页：看别人的主页时，红心应该反映**观看者自己的**喜欢状态（官方同款语义），
  // 不能把对方的喜欢列表套到自己头上，更不能点一下就向自己的账号发「取消喜欢」。
  const likedKeys = useMemo(() => {
    const keys = new Set<string>(act.likedKeys || [])
    if (!profileUserId) for (const song of songs) keys.add(pcSongKey(song))
    return keys
  }, [act.likedKeys, songs, profileUserId])

  const tabs = useMemo<PcTabItem[]>(() => ([
    { key: 'liked', label: '我喜欢的音乐', count: songs.length || undefined },
    { key: 'created', label: '创建的歌单', count: createdPlaylists.length || undefined },
    { key: 'subscribed', label: '收藏的歌单', count: subscribedPlaylists.length || undefined },
    // 听歌排行是账号态数据，看别人的主页不提供（官方同款语义）
    ...(!profileUserId ? [{ key: 'rank', label: '听歌排行' } as PcTabItem] : []),
  ]), [songs.length, createdPlaylists.length, subscribedPlaylists.length, profileUserId])

  // 未登录且没有可看的公开主页时才拦成登录态（看别人不需要登录）
  if (!loggedIn && !profileUserId) {
    return (
      <PcEmpty
        theme={theme}
        title="登录后查看个人主页"
        description="同步你的我喜欢的音乐与创建的歌单"
        action={act.onLogin ? <PcPrimaryButton label="立即登录" icon={<User className="h-3.5 w-3.5" />} onClick={act.onLogin} accent={accent} /> : undefined}
      />
    )
  }

  const shownNickname = profileMeta.nickname || (profileUserId ? '' : (account.username || '网易云用户'))
  const shownAvatar = profileMeta.avatar || (profileUserId ? '' : account.avatar)
  const shownVip = profileUserId ? profileMeta.vip : Boolean(account.vip)
  const shownEvents = counts.events
  const shownFollows = counts.follows
  const shownFolloweds = counts.followeds

  const playlistCards = (lists: any[], scope: 'created' | 'subscribed') => (
    <PcCardGrid
      items={lists.map(playlist => ({
        key: `netease-${scope}:${playlist.id || playlist.name}`,
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
  )

  return (
    <div className="pb-8">
      {/* ── 头部：大头像 + 昵称 + 会员牌 + 动态/关注/粉丝 + 签名 ── */}
      <div className="mb-5 flex items-center gap-5">
        <PcCover
          src={shownAvatar}
          alt={`${shownNickname || '用户'}头像`}
          className="h-24 w-24 shrink-0"
          rounded="rounded-full"
          eager
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className={`truncate text-[24px] font-semibold leading-tight ${theme.text}`}>{shownNickname || '网易云用户'}</h1>
            {shownVip ? (
              <span className="flex shrink-0 items-center gap-0.5 rounded-[4px] bg-gradient-to-r from-amber-400 to-yellow-500 px-1.5 text-[11px] font-medium leading-[17px] text-white">
                <Crown className="h-3 w-3" />
                VIP
              </span>
            ) : null}
          </div>
          {/* 三个数字都拿不到时整段不渲染（不写死 0） */}
          {shownEvents !== undefined || shownFollows !== undefined || shownFolloweds !== undefined ? (
            <p className={`mt-2 flex items-center gap-4 text-[12px] ${theme.subtle}`}>
              {shownEvents !== undefined ? <span>动态：{shownEvents}</span> : null}
              {shownFollows !== undefined ? <span>关注：{shownFollows}</span> : null}
              {shownFolloweds !== undefined ? <span>粉丝：{shownFolloweds}</span> : null}
            </p>
          ) : null}
          {profileMeta.signature ? (
            <p className={`mt-2 line-clamp-2 text-[12px] leading-relaxed ${theme.subtle}`}>{profileMeta.signature}</p>
          ) : null}
        </div>
      </div>

      {/* ── 页签 ── */}
      <div className={`mb-5 border-b ${theme.divider}`}>
        <PcTabs items={tabs} value={tab} onChange={setTab} accent={accent} theme={theme} />
      </div>

      {tab === 'liked' ? (
        !targetUid ? (
          <PcEmpty theme={theme} title="登录信息不完整" description="缺少账号 id，请重新登录网易云音乐后再试" />
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
              skin="netease"
              theme={theme}
              accent={accent}
              columns={{ index: true, like: true, album: true, duration: true }}
              loading={listsState === 'loading' && !songs.length}
              playingKey={act.currentSongKey}
              isPlaying={act.isPlaying}
              likedKeys={likedKeys}
              isLiked={profileUserId ? act.isLiked : undefined}
              onPlay={(song, index) => act.onPlaySongs(song, visibleSongs, index)}
              onMenu={(event, song) => {
                event.preventDefault()
                act.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: visibleSongs })
              }}
              onToggleLike={profileUserId ? undefined : (song, next) => act.onToggleLike?.(song, next)}
              empty={(
                <PcEmpty
                  theme={theme}
                  title={query ? '没有匹配的歌曲' : '暂无喜欢的歌曲'}
                  description={query ? '换个关键词试试' : (listsState === 'error' ? '我喜欢的音乐加载失败，稍后重试' : '在歌曲上点红心就会出现在这里')}
                  action={!query && listsState === 'error'
                    ? <PcGhostButton label="重新加载" theme={theme} onClick={() => setReload(value => value + 1)} />
                    : undefined}
                />
              )}
            />
            {songs.length ? <PcListFooter theme={theme} label={`共 ${songs.length} 首`} /> : null}
          </>
        )
      ) : tab === 'created' ? (
        listsState === 'loading' && !createdPlaylists.length ? (
          <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>
        ) : createdPlaylists.length ? (
          playlistCards(createdPlaylists, 'created')
        ) : (
          <PcEmpty
            theme={theme}
            title="还没有创建歌单"
            description={listsState === 'error' ? '歌单加载失败，稍后重试' : '在客户端新建的歌单会出现在这里'}
            action={listsState === 'error' ? <PcGhostButton label="重新加载" theme={theme} onClick={() => setReload(value => value + 1)} /> : undefined}
          />
        )
      ) : tab === 'rank' ? (
        /* ── 听歌排行：官方个人主页同款（周榜/累计 + 播放次数列）── */
        <>
          <div className="mb-3 flex items-center gap-2">
            {([['week', '最近一周'], ['all', '所有时间']] as const).map(([key, label]) => (
              <button
                key={`rank-range:${key}`}
                type="button"
                onClick={() => setRankRange(key)}
                className={`rounded-full px-3.5 py-1.5 text-[12px] transition ${rankRange === key ? 'font-medium text-white' : theme.chipIdle}`}
                style={rankRange === key ? { background: accent } : undefined}
              >
                {label}
              </button>
            ))}
          </div>
          {rankState === 'loading' && !rankSongs.length ? (
            <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载听歌排行…</div>
          ) : rankState === 'error' && !rankSongs.length ? (
            <PcEmpty
              theme={theme}
              title="听歌排行加载失败"
              description="需要登录网易云音乐并已有播放记录"
              action={<PcGhostButton label="重新加载" theme={theme} onClick={() => setReload(value => value + 1)} />}
            />
          ) : rankSongs.length ? (
            <>
              <PcSongTable
                songs={rankSongs.map(song => ({
                  id: song.id,
                  name: song.name,
                  artists: [{ name: song.artist || '未知歌手' }],
                  album: { name: '', picUrl: song.coverUrl },
                  duration: 0,
                  platform: 'netease' as const,
                }))}
                skin="netease"
                theme={theme}
                accent={accent}
                columns={{ index: true, like: false, album: false, duration: false }}
                playingKey={act.currentSongKey}
                isPlaying={act.isPlaying}
                onPlay={(song, index) => act.onPlaySongs(song, rankSongs.map(item => ({
                  id: item.id,
                  name: item.name,
                  artists: [{ name: item.artist || '未知歌手' }],
                  album: { name: '', picUrl: item.coverUrl },
                  duration: 0,
                  platform: 'netease' as const,
                })), index)}
                onMenu={(event, song) => {
                  event.preventDefault()
                  act.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song })
                }}
                empty={<PcEmpty theme={theme} title="暂无听歌数据" />}
                rowActions={(song) => {
                  const rank = rankSongs.find(item => item.id === song.id)
                  if (!rank?.playCount) return null
                  return <span className={`text-[11px] ${theme.faint}`}>播放 {rank.playCount.toLocaleString()} 次</span>
                }}
              />
              <PcListFooter theme={theme} label={`共 ${rankSongs.length} 首 · 数据来自网易云账号「听歌排行」`} />
            </>
          ) : (
            <PcEmpty theme={theme} title="暂无听歌数据" description="播放几首歌曲后这里会统计出你的排行" />
          )}
        </>
      ) : (
        listsState === 'loading' && !subscribedPlaylists.length ? (
          <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>
        ) : subscribedPlaylists.length ? (
          playlistCards(subscribedPlaylists, 'subscribed')
        ) : (
          <PcEmpty
            theme={theme}
            title="还没有收藏歌单"
            description={listsState === 'error' ? '歌单加载失败，稍后重试' : '收藏他人的歌单后，这里会显示它们'}
            action={listsState === 'error' ? <PcGhostButton label="重新加载" theme={theme} onClick={() => setReload(value => value + 1)} /> : undefined}
          />
        )
      )}
    </div>
  )
}

export default memo(NeteasePcProfile)
