/**
 * 共振「加歌」面板（重做版）。
 *
 * 设计要点（按用户反馈）：
 * - **可挑挑拣拣**：搜索 / 歌单 / 我喜欢 三个入口都进到同一套「曲目多选列表」，勾选后统一「加入所选」。
 *   只有「共享歌单」模式的房主才有整单推送；其它模式下每人能加几首由房间配额决定（默认 3 首）。
 * - **分平台、分类别**：顶部平台筛选（登录了几个平台就有几个 chip）；歌单按「我创建的 / 我收藏的」分组，
 *   不把多平台歌单糅成一锅；「我喜欢」按平台各列一条。
 * - **每一步都有反馈**：读取中显示 loading；失败、超配额都给出明确文案，绝不静默。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, Check, Disc3, Heart, ListMusic, Loader2, Search, X } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { platformLabel, type MusicPlatform } from '../../services/platforms'
import { searchSongs, type Song } from '../../services/musicApi'
import { getUserPlaylists } from '../../services/playlistService'
import { playlistDetailSongs } from '../../utils/playlistSongs'
import { entitlementSatisfies, getSongRequiredTier } from '../../utils/musicEntitlements'
import { canonicalTrackKey, type ResonancePlatformBadge, type ResonanceTrack } from './model'
import { songToResonanceTrack } from './push'

export interface ResonanceAddPanelProps {
  playerTheme?: 'dark' | 'light'
  platforms: ResonancePlatformBadge[]
  userIds: Partial<Record<MusicPlatform, string>>
  usernames: Partial<Record<MusicPlatform, string>>
  /** 单次整单推送上限（仅共享歌单房主用） */
  pushLimit: number
  /** 我此刻还能加几首（Infinity = 共享歌单房主不限） */
  remainingQuota: number
  /** 是否允许整单推送（只有共享歌单的房主为 true） */
  allowBulkPush: boolean
  accent: string
  busy: boolean
  onClose: () => void
  onAdd: (tracks: Array<Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'>>, label: string) => { ok: boolean; added?: number; truncated?: number; reason?: string }
}

type Tab = 'search' | 'playlists' | 'liked'

interface PlaylistEntry {
  id: string
  name: string
  coverUrl: string
  trackCount?: number
  platform: MusicPlatform
  isLike: boolean
  isCollected: boolean
}

interface SongView {
  title: string
  platform: MusicPlatform
  songs: Song[]
  playlistId: string
  isLike: boolean
}

/** 曲目列表首屏渲染条数（大歌单不一次性铺满 DOM；需要时再放量） */
const PICKER_PAGE_SIZE = 300

const REASON_TEXT: Record<string, string> = {
  'quota-exceeded': '你的加歌额度已用完（除共享歌单外，每人可加的歌数由房主设定）',
  'not-your-turn': '还没轮到你推荐',
  'not-host': '共享歌单模式下只有房主能推送整单',
  'queue-full': '房间队列已满',
  empty: '这些歌已经在队列里了',
  'room-closed': '房间已结束',
}

export default function ResonanceAddPanel(props: ResonanceAddPanelProps) {
  const {
    playerTheme = 'dark', platforms, userIds, usernames, pushLimit, remainingQuota,
    allowBulkPush, accent, busy, onClose, onAdd,
  } = props
  const dark = playerTheme === 'dark'
  const border = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)'
  const sub = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'
  const chip = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'

  const loggedIn = useMemo(() => platforms.filter(item => item.loggedIn), [platforms])
  const [tab, setTab] = useState<Tab>('search')
  const [platformFilter, setPlatformFilter] = useState<MusicPlatform | 'all'>('all')
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [playlists, setPlaylists] = useState<PlaylistEntry[]>([])
  const [loadingPlaylists, setLoadingPlaylists] = useState(false)
  const [view, setView] = useState<SongView | null>(null)
  const [loadingSongs, setLoadingSongs] = useState(false)
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [songFilter, setSongFilter] = useState('')
  const [visibleCount, setVisibleCount] = useState(PICKER_PAGE_SIZE)

  const quotaLeft = remainingQuota
  const unlimited = !Number.isFinite(quotaLeft)
  const tierOf = useCallback((platform: MusicPlatform) => platforms.find(item => item.platform === platform)?.tier ?? 'unknown', [platforms])
  const visiblePlatforms = loggedIn.length > 0 ? loggedIn.map(item => item.platform) : (['netease'] as MusicPlatform[])
  const activePlatforms = platformFilter === 'all' ? visiblePlatforms : [platformFilter]

  const keyOf = (song: Song) => `${song.platform || 'netease'}-${song.mid || song.appleId || song.id}`
  const canSelectMore = unlimited || selected.size < quotaLeft

  const toggleSong = useCallback((song: Song) => {
    setSelected(previous => {
      const next = new Set(previous)
      const key = keyOf(song)
      if (next.has(key)) { next.delete(key); return next }
      if (!unlimited && next.size >= quotaLeft) {
        setNotice(`最多还能加 ${quotaLeft} 首（房主设定的每人额度）`)
        return previous
      }
      setNotice('')
      next.add(key)
      return next
    })
  }, [quotaLeft, unlimited])

  const resetSelection = useCallback(() => { setSelected(new Set()); setNotice('') }, [])

  /** 提交所选：统一入口，保证有反馈 */
  const submitSelection = useCallback((songs: Song[], label: string) => {
    const picked = songs.filter(song => selected.has(keyOf(song)))
    if (picked.length === 0) { setNotice('先勾选要加入的歌曲'); return }
    const result = onAdd(picked.map(songToResonanceTrack), label)
    if (!result.ok) { setNotice(REASON_TEXT[result.reason || ''] || '加入失败，请稍后再试'); return }
    setNotice(`已加入 ${result.added ?? picked.length} 首${result.truncated ? `（超出房间上限，截断 ${result.truncated} 首）` : ''}`)
    resetSelection()
  }, [onAdd, resetSelection, selected])

  /** 共享歌单房主的整单推送（只有这个模式才有） */
  const pushWholePlaylist = useCallback(async (entry: { id: string; name: string; platform: MusicPlatform }) => {
    setNotice('')
    setLoadingSongs(true)
    try {
      const { getPlaylistDetail } = await import('../../services/playlistService')
      const detail = await getPlaylistDetail(entry.id, entry.platform)
      const songs = playlistDetailSongs(detail, entry.platform)
      if (songs.length === 0) { setNotice(`《${entry.name}》没有读到曲目，推送已取消`); return }
      const result = onAdd(songs.slice(0, pushLimit).map(songToResonanceTrack), `整单：${entry.name}`)
      if (!result.ok) { setNotice(REASON_TEXT[result.reason || ''] || '推送失败'); return }
      setNotice(`已推送《${entry.name}》${result.added ?? 0} 首${songs.length > pushLimit ? `（按上限截断，歌单共 ${songs.length} 首）` : ''}`)
    } catch {
      setNotice(`读取《${entry.name}》失败`)
    } finally {
      setLoadingSongs(false)
    }
  }, [onAdd, pushLimit])

  const openPlaylist = useCallback(async (entry: PlaylistEntry) => {
    setNotice('')
    setSelected(new Set())
    setSongFilter('')
    setLoadingSongs(true)
    setView({ title: entry.name, platform: entry.platform, songs: [], playlistId: entry.id, isLike: entry.isLike })
    try {
      const { getPlaylistDetail } = await import('../../services/playlistService')
      const detail = await getPlaylistDetail(entry.id, entry.platform)
      const songs = playlistDetailSongs(detail, entry.platform)
      setView({ title: entry.name, platform: entry.platform, songs, playlistId: entry.id, isLike: entry.isLike })
      if (songs.length === 0) {
        setNotice(entry.trackCount === 0 ? `《${entry.name}》里还没有歌` : '这个歌单没有读到曲目')
      }
    } catch {
      setNotice(`读取《${entry.name}》失败`)
    } finally {
      setLoadingSongs(false)
    }
  }, [])

  const runSearch = useCallback(async () => {
    const query = keyword.trim()
    if (!query) return
    setSearching(true)
    setNotice('')
    setSelected(new Set())
    try {
      const settled = await Promise.allSettled(activePlatforms.map(platform => searchSongs(query, 12, platform)))
      const merged = new Map<string, Song>()
      for (const item of settled) {
        if (item.status !== 'fulfilled') continue
        for (const song of item.value.songs || []) {
          const key = canonicalTrackKey({ title: song.name, artists: (song.artists || []).map(artist => artist.name) })
          const existing = merged.get(key)
          if (!existing) { merged.set(key, song); continue }
          const existingOk = entitlementSatisfies(tierOf((existing.platform || 'netease') as MusicPlatform), getSongRequiredTier(existing))
          const candidateOk = entitlementSatisfies(tierOf((song.platform || 'netease') as MusicPlatform), getSongRequiredTier(song))
          if (candidateOk && !existingOk) merged.set(key, song)
        }
      }
      const list = [...merged.values()]
      setView({ title: `搜索：${query}`, platform: (activePlatforms[0] || 'netease') as MusicPlatform, songs: list, playlistId: '', isLike: false })
      if (list.length === 0) setNotice('没搜到结果，换个关键词试试')
    } catch {
      setNotice('搜索失败，请稍后重试')
    } finally {
      setSearching(false)
    }
  }, [activePlatforms, keyword, tierOf])

  const loadPlaylists = useCallback(async () => {
    setLoadingPlaylists(true)
    setNotice('')
    try {
      const collected: PlaylistEntry[] = []
      for (const platform of activePlatforms) {
        try {
          const list = await getUserPlaylists(platform, userIds[platform] || '', usernames[platform])
          for (const item of list || []) {
            const id = String(item?.id ?? item?.playlistId ?? '')
            if (!id) continue
            const isLike = Boolean(item?.isLike) || /我喜欢|喜欢的音乐/.test(String(item?.name || ''))
            const isCollected = !isLike && Boolean(item?.isCollected ?? item?.subscribed)
            collected.push({
              id,
              platform,
              isLike,
              isCollected,
              name: String(item?.name || '未命名歌单'),
              coverUrl: String(item?.coverUrl || item?.coverImgUrl || item?.picUrl || ''),
              trackCount: Number(item?.trackCount) || undefined,
            })
          }
        } catch { /* 单个平台失败不影响其它平台 */ }
      }
      collected.sort((left, right) => Number(right.isLike) - Number(left.isLike))
      setPlaylists(collected)
      if (collected.length === 0) setNotice('没有读到歌单：确认平台已登录，或用「搜索」加歌')
    } finally {
      setLoadingPlaylists(false)
    }
  }, [activePlatforms, userIds, usernames])

  useEffect(() => {
    if (view) return
    if (tab === 'playlists' || tab === 'liked') void loadPlaylists()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, platformFilter])

  const likedPlaylists = playlists.filter(entry => entry.isLike)
  const createdPlaylists = playlists.filter(entry => !entry.isLike && !entry.isCollected)
  const collectedPlaylists = playlists.filter(entry => entry.isCollected)

  const filteredSongs = useMemo(() => {
    if (!view) return []
    const query = songFilter.trim().toLowerCase()
    if (!query) return view.songs
    return view.songs.filter(song => (
      song.name.toLowerCase().includes(query)
      || (song.artists || []).some(artist => artist.name.toLowerCase().includes(query))
    ))
  }, [songFilter, view])

  // 几千首的大歌单不能一次性铺满 DOM（用户明确担心「共享个几千首直接卡爆」）：
  // 先渲染一屏，需要再放量；过滤框/tab 变化时回到第一屏。
  const visibleSongs = useMemo(() => filteredSongs.slice(0, visibleCount), [filteredSongs, visibleCount])
  useEffect(() => { setVisibleCount(PICKER_PAGE_SIZE) }, [view?.playlistId, view?.isLike, songFilter, tab])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-[70] flex items-center justify-center p-6"
      style={{ background: 'rgba(3,5,9,0.72)', backdropFilter: 'blur(14px)' }}
      onClick={onClose}
      data-tv-scope
    >
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', damping: 26, stiffness: 300 }}
        className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-[20px] border"
        style={{
          borderColor: border,
          background: dark ? 'linear-gradient(155deg, rgba(20,24,34,0.99), rgba(9,12,18,0.99))' : '#fff',
          color: dark ? '#fff' : '#101318',
        }}
        onClick={event => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b px-5 py-4" style={{ borderColor: border }}>
          {view ? (
            <button type="button" onClick={() => { setView(null); resetSelection() }} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs" style={{ background: chip }}>
              <ArrowLeft className="h-3.5 w-3.5" />返回
            </button>
          ) : (
            <ListMusic className="h-4 w-4" style={{ color: accent }} />
          )}
          <h2 className="truncate text-base font-semibold">{view ? view.title : '加歌到房间'}</h2>
          <span className="ml-auto shrink-0 rounded-full px-2.5 py-1 text-[11px]" style={{ background: chip, color: unlimited ? sub : accent }}>
            {unlimited ? '房主可整单推送' : `还能加 ${quotaLeft} 首`}
          </span>
          <button type="button" onClick={onClose} aria-label="关闭" className="shrink-0 rounded-lg p-1.5" style={{ background: chip }}><X className="h-4 w-4" /></button>
        </header>

        {/* 平台切换：只列我登录了的平台，不把多平台歌单糅在一起 */}
        <div className="flex flex-wrap items-center gap-1.5 border-b px-5 py-2.5" style={{ borderColor: border }}>
          <span className="mr-1 text-[11px]" style={{ color: sub }}>平台</span>
          {([['all', '全部']] as Array<[string, string]>).concat(visiblePlatforms.map(platform => [platform as string, platformLabel(platform)])).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => { setPlatformFilter(value as MusicPlatform | 'all'); setView(null); resetSelection() }}
              className="rounded-full px-2.5 py-1 text-[11px] transition"
              style={{
                background: platformFilter === value ? `${accent}22` : chip,
                color: platformFilter === value ? accent : sub,
                border: `1px solid ${platformFilter === value ? `${accent}66` : 'transparent'}`,
              }}
              aria-pressed={platformFilter === value}
            >
              {label}
            </button>
          ))}
          {loggedIn.length === 0 && <span className="text-[11px]" style={{ color: '#ffb45a' }}>未登录任何平台：加入的歌只有别人能播</span>}
        </div>

        {!view && (
          <nav className="flex items-center gap-1 border-b px-4 py-2" style={{ borderColor: border }}>
            {([['search', '搜索'], ['playlists', '我的歌单'], ['liked', '我喜欢']] as Array<[Tab, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className="rounded-full px-3 py-1.5 text-xs transition"
                style={{ background: tab === value ? `${accent}22` : 'transparent', color: tab === value ? accent : sub }}
                aria-pressed={tab === value}
              >
                {label}
              </button>
            ))}
          </nav>
        )}

        {notice && <p className="px-5 pt-3 text-xs" style={{ color: '#ffcf9a' }} role="status">{notice}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {view ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="flex h-9 min-w-[160px] flex-1 items-center gap-2 rounded-xl border px-3" style={{ borderColor: border }}>
                  <Search className="h-3.5 w-3.5" style={{ color: sub }} />
                  <input
                    value={songFilter}
                    onChange={event => setSongFilter(event.target.value)}
                    placeholder="在列表里过滤歌名 / 歌手"
                    className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none"
                    aria-label="过滤歌曲"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (unlimited) { setSelected(new Set(filteredSongs.map(keyOf))); return }
                    setSelected(new Set(filteredSongs.slice(0, quotaLeft).map(keyOf)))
                    if (filteredSongs.length > quotaLeft) setNotice(`已按额度勾选前 ${quotaLeft} 首`)
                  }}
                  className="h-9 shrink-0 rounded-xl px-3 text-xs"
                  style={{ background: chip, color: sub }}
                >
                  全选
                </button>
                <button type="button" onClick={resetSelection} className="h-9 shrink-0 rounded-xl px-3 text-xs" style={{ background: chip, color: sub }}>清空</button>
                {allowBulkPush && view.playlistId && (
                  <button
                    type="button"
                    disabled={busy || loadingSongs}
                    onClick={() => void pushWholePlaylist({ id: view.playlistId, name: view.title, platform: view.platform })}
                    className="h-9 shrink-0 rounded-xl px-3 text-xs disabled:opacity-50"
                    style={{ background: chip, color: sub }}
                    title={`共享歌单模式：整单推送（最多 ${pushLimit} 首）`}
                  >
                    整单推送
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy || selected.size === 0}
                  onClick={() => submitSelection(view.songs, view.title)}
                  className="h-9 shrink-0 rounded-xl px-4 text-xs font-medium text-white disabled:opacity-45"
                  style={{ background: accent }}
                >
                  加入所选（{selected.size}）
                </button>
              </div>

              {!unlimited && selected.size >= quotaLeft && (
                <p className="mb-2 text-[11px]" style={{ color: sub }}>
                  已经勾满房主设定的额度（{quotaLeft} 首），灰掉的歌先取消勾选才能再选；已经加进队列的歌可以在队列里移除。
                </p>
              )}

              {loadingSongs ? (
                <p className="flex items-center gap-2 py-8 text-xs" style={{ color: sub }}><Loader2 className="h-4 w-4 animate-spin" />正在读取曲目…</p>
              ) : (
                <div className="space-y-1">
                  {visibleSongs.map(song => {
                    const platform = (song.platform || 'netease') as MusicPlatform
                    const required = getSongRequiredTier(song)
                    const playable = entitlementSatisfies(tierOf(platform), required)
                    const key = keyOf(song)
                    const picked = selected.has(key)
                    const locked = !picked && !canSelectMore
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleSong(song)}
                        disabled={locked}
                        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition disabled:opacity-40"
                        style={{ background: picked ? `${accent}1f` : 'transparent', border: `1px solid ${picked ? `${accent}55` : 'transparent'}` }}
                        aria-pressed={picked}
                      >
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border" style={{ borderColor: picked ? accent : border, background: picked ? accent : 'transparent' }}>
                          {picked && <Check className="h-3.5 w-3.5 text-white" />}
                        </span>
                        <span className="h-9 w-9 shrink-0 overflow-hidden rounded-lg" style={{ background: chip }}>
                          {song.album?.picUrl && <CachedImage src={song.album.picUrl} alt="" className="h-full w-full object-cover" role="row" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{song.name}</span>
                          <span className="block truncate text-[11px]" style={{ color: sub }}>{(song.artists || []).map(artist => artist.name).join(' / ')}</span>
                        </span>
                        {/*
                          标签只在「确定播不了」时才报警：档位未知（酷狗没有会员信息、平台没登录）
                          不能当成「需要 VIP」——那会把免费歌也标红，让人以为处处要会员。
                        */}
                        <span className="shrink-0 text-[11px]" style={{ color: playable || required === 'free' ? sub : required === 'unknown' ? '#ffd98a' : '#ffb45a' }}>
                          {playable || required === 'free'
                            ? platformLabel(platform)
                            : required === 'unknown'
                              ? `${platformLabel(platform)} · 未知`
                              : `需要 ${required.toUpperCase()}`}
                        </span>
                      </button>
                    )
                  })}
                  {filteredSongs.length === 0 && <p className="py-8 text-center text-xs" style={{ color: sub }}>没有可选的曲目</p>}
                  {filteredSongs.length > visibleSongs.length && (
                    <button
                      type="button"
                      onClick={() => setVisibleCount(count => count + PICKER_PAGE_SIZE)}
                      className="mt-1 w-full rounded-xl py-2 text-xs"
                      style={{ background: chip, color: sub }}
                    >
                      还有 {filteredSongs.length - visibleSongs.length} 首没显示 · 显示更多（也可用上面的过滤框缩小范围）
                    </button>
                  )}
                </div>
              )}
            </>
          ) : tab === 'search' ? (
            <>
              <div className="mb-3 flex items-center gap-2">
                <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-xl border px-3" style={{ borderColor: border }}>
                  <Search className="h-4 w-4" style={{ color: sub }} />
                  <input
                    value={keyword}
                    onChange={event => setKeyword(event.target.value)}
                    onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void runSearch() }}
                    placeholder="搜歌名 / 歌手，回车搜索"
                    className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
                    aria-label="搜索歌曲"
                  />
                </div>
                <button type="button" disabled={searching || !keyword.trim()} onClick={() => void runSearch()} className="flex h-10 items-center gap-2 rounded-xl px-4 text-sm disabled:opacity-50" style={{ background: `${accent}22`, color: accent }}>
                  {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}搜索
                </button>
              </div>
              <p className="text-xs leading-relaxed" style={{ color: sub }}>
                搜索按当前平台筛选合并结果；勾选后点「加入所选」。标「需要 VIP」的歌你自己可能播不了，但其他成员能播就没问题。
              </p>
            </>
          ) : tab === 'playlists' ? (
            <>
              {loadingPlaylists && <p className="flex items-center gap-2 text-xs" style={{ color: sub }}><Loader2 className="h-4 w-4 animate-spin" />正在读取歌单…</p>}
              <PlaylistGroup title="我创建的" hint="点进去挑歌" entries={createdPlaylists} border={border} sub={sub} chip={chip} accent={accent} allowBulkPush={allowBulkPush} onOpen={openPlaylist} onPush={pushWholePlaylist} />
              <PlaylistGroup title="我收藏的" hint="收藏自音乐平台" entries={collectedPlaylists} border={border} sub={sub} chip={chip} accent={accent} allowBulkPush={allowBulkPush} onOpen={openPlaylist} onPush={pushWholePlaylist} />
              {!loadingPlaylists && playlists.length === 0 && (
                <p className="py-8 text-center text-xs" style={{ color: sub }}>没有读到歌单。可以换平台筛选、确认已登录，或直接用「搜索」加歌。</p>
              )}
            </>
          ) : (
            <>
              {loadingPlaylists && <p className="flex items-center gap-2 text-xs" style={{ color: sub }}><Loader2 className="h-4 w-4 animate-spin" />正在读取…</p>}
              <PlaylistGroup title="我喜欢" hint="点进去挑歌（不是一键全塞）" entries={likedPlaylists} border={border} sub={sub} chip={chip} accent={accent} allowBulkPush={false} onOpen={openPlaylist} onPush={pushWholePlaylist} />
              {!loadingPlaylists && likedPlaylists.length === 0 && (
                <p className="py-8 text-center text-xs" style={{ color: sub }}>没有读到「我喜欢」：确认对应平台已登录。</p>
              )}
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

function PlaylistGroup(props: {
  title: string
  hint: string
  entries: PlaylistEntry[]
  border: string
  sub: string
  chip: string
  accent: string
  allowBulkPush: boolean
  onOpen: (entry: PlaylistEntry) => void
  onPush: (entry: { id: string; name: string; platform: MusicPlatform }) => void
}) {
  const { title, hint, entries, border, sub, chip, accent, allowBulkPush, onOpen, onPush } = props
  if (entries.length === 0) return null
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-[11px]" style={{ color: sub }}>{hint}</span>
        <span className="ml-auto text-[11px]" style={{ color: sub }}>{entries.length} 个</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {entries.map(entry => (
          <div key={`${entry.platform}-${entry.id}`} className="flex items-center gap-3 rounded-xl border p-2" style={{ borderColor: border }}>
            <button type="button" onClick={() => onOpen(entry)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <span className="h-11 w-11 shrink-0 overflow-hidden rounded-lg" style={{ background: chip }}>
                {entry.coverUrl
                  ? <CachedImage src={entry.coverUrl} alt="" className="h-full w-full object-cover" role="compact" />
                  : <span className="flex h-full w-full items-center justify-center"><Disc3 className="h-4 w-4 text-white/30" /></span>}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1">
                  {entry.isLike && <Heart className="h-3 w-3 shrink-0" style={{ color: accent }} />}
                  <span className="truncate text-sm">{entry.name}</span>
                </span>
                <span className="block text-[11px]" style={{ color: sub }}>
                  {platformLabel(entry.platform)}{entry.trackCount ? ` · ${entry.trackCount} 首` : ''}
                </span>
              </span>
            </button>
            {allowBulkPush && (
              <button
                type="button"
                onClick={() => onPush(entry)}
                className="shrink-0 rounded-full px-2.5 py-1 text-[11px]"
                style={{ background: chip, color: sub }}
                title="共享歌单模式：整单推送"
              >
                整单
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
