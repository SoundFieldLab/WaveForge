// 官方 PC 客户端风格搜索页（两个平台共用）。
//
// 客户端搜索页 = 顶部大搜索框（带联想下拉）+ 热搜榜/历史 + 结果区（单曲/歌手/专辑/歌单/用户 页签），
// 结果区单曲用客户端表格、其余用卡片网格。
// 热搜榜与联想：网易云走 searchHot / searchSuggest（官方接口），QQ 沿用 searchHot、
// 联想走 searchQuick；用户页签仅网易云提供（searchUsers = search type=1002）。
// 数据沿用既有 search* 服务，不再自造接口。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Flame, Search as SearchIcon, TrendingDown, TrendingUp, X } from 'lucide-react'
import type { Album, Artist, Song } from '../../services/musicApi'
import { searchAlbums, searchArtists, searchPlaylists, searchQuick, searchSongs, searchSuggest, searchUsers, type SearchSuggestion } from '../../services/musicApi'
import { getPlatformCapabilities, platformLabel, type MusicPlatform } from '../../services/platforms'
import {
  PcCardGrid, PcCover, PcEmpty, PcSongTable, PcTabs, pcTheme, type PcSkin, type PcTone,
} from './pcKit'
import type { PcActions, PcAccount } from './types'

const HISTORY_KEY = 'waveforge:traditional-search-history:v1'
const HISTORY_LIMIT = 10

function readHistory(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string').slice(0, HISTORY_LIMIT) : []
  } catch { return [] }
}

interface HotItem { keyword: string; score?: number; iconType?: number; iconUrl?: string }
interface FoundUser { userId: number; nickname: string; signature: string; avatarUrl: string }

export interface PcSearchProps {
  initialKeyword?: string
  platform: MusicPlatform
  chrome: { tone: PcTone; skin: PcSkin; accent: string }
  account: PcAccount
  actions: PcActions
  /** 隐藏保活页为 false：不重复发请求 */
  active?: boolean
}

function PcSearch({ initialKeyword, platform, chrome, account, actions, active = true }: PcSearchProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const skin = chrome.skin
  const [keyword, setKeyword] = useState(initialKeyword || '')
  const [submitted, setSubmitted] = useState(initialKeyword || '')
  const [tab, setTab] = useState('songs')
  const [songs, setSongs] = useState<Song[]>([])
  const [songCount, setSongCount] = useState(0)
  const [artists, setArtists] = useState<Artist[]>([])
  const [albums, setAlbums] = useState<Album[]>([])
  const [playlists, setPlaylists] = useState<any[]>([])
  const [users, setUsers] = useState<FoundUser[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<string[]>(readHistory)
  // 热搜榜（未搜索时展示；客户端搜索页必有的默认态）
  const [hotList, setHotList] = useState<HotItem[]>([])
  // 输入联想（网易云 suggest / QQ quick），有候选时显示在下拉里
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const suggestSeqRef = useRef(0)
  const suggestBoxRef = useRef<HTMLDivElement | null>(null)
  const requestRef = useRef(0)
  const capabilities = getPlatformCapabilities(platform)
  // 官方搜索页的用户分类只有网易云有
  const canSearchUsers = platform === 'netease'

  const runSearch = useCallback(async (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const requestId = ++requestRef.current
    setLoading(true)
    setError('')
    setSubmitted(trimmed)
    setTab('songs')
    setSuggestOpen(false)
    setHistory(prev => {
      const next = [trimmed, ...prev.filter(item => item !== trimmed)].slice(0, HISTORY_LIMIT)
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch { /* 忽略隐私模式下的写入失败 */ }
      return next
    })
    try {
      const [songResult, artistResult, albumResult, playlistResult, userResult] = await Promise.all([
        searchSongs(trimmed, 50, platform).catch(() => ({ songs: [], songCount: 0 }) as never),
        searchArtists(trimmed, platform).catch(() => [] as Artist[]),
        searchAlbums(trimmed, platform).catch(() => [] as Album[]),
        capabilities.searchPlaylists ? searchPlaylists(trimmed, platform).catch(() => ({ playlists: [] }) as never) : Promise.resolve({ playlists: [] } as never),
        canSearchUsers ? searchUsers(trimmed, 20).catch(() => [] as FoundUser[]) : Promise.resolve([] as FoundUser[]),
      ])
      if (requestId !== requestRef.current) return
      setSongs(songResult?.songs || [])
      setSongCount(songResult?.songCount || songResult?.songs?.length || 0)
      setArtists(Array.isArray(artistResult) ? artistResult : [])
      setAlbums(Array.isArray(albumResult) ? albumResult : [])
      setPlaylists((playlistResult as { playlists?: any[] })?.playlists || [])
      setUsers(Array.isArray(userResult) ? userResult : [])
    } catch (searchError) {
      if (requestId !== requestRef.current) return
      setError(searchError instanceof Error ? searchError.message : '搜索失败')
      setSongs([]); setArtists([]); setAlbums([]); setPlaylists([]); setUsers([])
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [platform, capabilities.searchPlaylists, canSearchUsers])

  // 外部（顶栏/歌单页搜索框）带关键词进入时自动搜一次
  useEffect(() => {
    if (!active) return
    if (initialKeyword && initialKeyword !== submitted) void runSearch(initialKeyword)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKeyword, active])

  // 热搜榜：未搜索的默认态（网易云 result.hots[{first,second,iconType,iconUrl}] / QQ data[{k,n}]）
  useEffect(() => {
    if (!active || submitted) return
    let cancelled = false
    void (async () => {
      const { searchHot } = await import('../../services/musicApi')
      const data = await searchHot(platform).catch(() => null)
      if (cancelled || !data) return
      const neteaseList = (data.result?.hots || data.hots || []) as any[]
      const qqList = Array.isArray(data.data) ? (data.data as any[]) : []
      const list: HotItem[] = (neteaseList.length > 0 ? neteaseList : qqList)
        .map(item => ({
          keyword: String(item?.first || item?.k || item?.searchWord || ''),
          score: Number(item?.second ?? item?.n ?? item?.score ?? 0) || undefined,
          iconType: Number(item?.iconType ?? 0) || undefined,
          iconUrl: String(item?.iconUrl || '') || undefined,
        }))
        .filter(item => item.keyword)
        .slice(0, 18)
      if (!cancelled) setHotList(list)
    })()
    return () => { cancelled = true }
  }, [active, submitted, platform])

  // 输入联想：300ms 防抖；QQ 走 searchQuick，网易云走 searchSuggest
  useEffect(() => {
    const trimmed = keyword.trim()
    if (!trimmed || trimmed === submitted) { setSuggestions([]); setSuggestOpen(false); return }
    const timer = window.setTimeout(() => {
      const seq = ++suggestSeqRef.current
      void (async () => {
        try {
          if (platform === 'qq') {
            const data = await searchQuick(trimmed)
            if (seq !== suggestSeqRef.current) return
            const list: SearchSuggestion[] = Array.isArray(data?.data?.list)
              ? (data.data.list as any[]).slice(0, 10).map(item => ({ keyword: String(item?.keyword || item?.k || ''), type: 'song' as const }))
              : []
            setSuggestions(list.filter(item => item.keyword))
            setSuggestOpen(list.length > 0)
          } else if (platform === 'netease') {
            const list = await searchSuggest(trimmed, 'netease')
            if (seq !== suggestSeqRef.current) return
            setSuggestions(list.slice(0, 10))
            setSuggestOpen(list.length > 0)
          }
        } catch { /* 联想失败静默：不影响手动回车搜索 */ }
      })()
    }, 300)
    return () => window.clearTimeout(timer)
  }, [keyword, submitted, platform])

  // 点击页面其它位置收起联想下拉
  useEffect(() => {
    if (!suggestOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (suggestBoxRef.current && !suggestBoxRef.current.contains(event.target as Node)) setSuggestOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [suggestOpen])

  const tabs = useMemo(() => ([
    { key: 'songs', label: '单曲', count: songCount },
    { key: 'artists', label: '歌手', count: artists.length },
    { key: 'albums', label: '专辑', count: albums.length },
    ...(capabilities.searchPlaylists ? [{ key: 'playlists', label: '歌单', count: playlists.length }] : []),
    ...(canSearchUsers ? [{ key: 'users', label: '用户', count: users.length }] : []),
  ]), [songCount, artists.length, albums.length, playlists.length, users.length, capabilities.searchPlaylists, canSearchUsers])

  const resultEmpty = !loading && !songs.length && !artists.length && !albums.length && !playlists.length && (!canSearchUsers || !users.length)

  // 官方热搜榜的排位图标：iconType 1=上升 2=下降（接口实测 0/1 为热度档），有 iconUrl 用官方图
  const renderHotIcon = (item: HotItem) => {
    if (item.iconUrl) return <img src={item.iconUrl} alt="" className="h-3 w-3 shrink-0" loading="lazy" />
    if (item.iconType === 1) return <TrendingUp className="h-3 w-3 shrink-0 text-[#e0513f]" />
    if (item.iconType === 2) return <TrendingDown className="h-3 w-3 shrink-0 text-[#5aabf5]" />
    return null
  }

  return (
    <div className="pb-8">
      {/* 顶部大搜索框（带联想下拉） */}
      <div ref={suggestBoxRef} className="relative mb-5 flex items-center gap-3">
        <label className={`flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border px-4 ${theme.divider} ${theme.surface}`}>
          <SearchIcon className={`h-4 w-4 shrink-0 ${theme.faint}`} />
          <input
            autoFocus
            value={keyword}
            onChange={event => { setKeyword(event.target.value); setSuggestOpen(true) }}
            onKeyDown={event => { if (event.key === 'Enter') void runSearch(keyword) }}
            onFocus={() => { if (suggestions.length > 0) setSuggestOpen(true) }}
            placeholder={`在${platformLabel(platform)}中搜索歌曲、歌手、专辑`}
            className={`min-w-0 flex-1 bg-transparent text-[13px] outline-none ${theme.text}`}
          />
          {keyword && (
            <button type="button" onClick={() => { setKeyword(''); setSuggestions([]); setSuggestOpen(false) }} aria-label="清空" className={`shrink-0 ${theme.faint}`}><X className="h-4 w-4" /></button>
          )}
        </label>
        <button type="button" onClick={() => void runSearch(keyword)} className="h-10 shrink-0 rounded-full px-6 text-[13px] font-medium text-white" style={{ background: accent }}>搜索</button>
        {/* 联想下拉（官方输入时逐条候选：类型小图标 + 高亮词） */}
        {suggestOpen && suggestions.length > 0 && (
          <div className={`absolute left-0 right-[88px] top-11 z-40 overflow-hidden rounded-xl border shadow-2xl ${theme.divider} ${theme.tone === 'dark' ? 'bg-[#1b1b1f]' : 'bg-white'}`}>
            {suggestions.map((item, index) => (
              <button
                key={`suggest:${item.keyword}:${index}`}
                type="button"
                onClick={() => { setKeyword(item.keyword); void runSearch(item.keyword) }}
                className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px] transition ${theme.hover} ${theme.text}`}
              >
                <SearchIcon className={`h-3.5 w-3.5 shrink-0 ${theme.faint}`} />
                <span className="min-w-0 flex-1 truncate">{item.keyword}</span>
                {item.type === 'artist' && <span className={`shrink-0 text-[11px] ${theme.faint}`}>歌手</span>}
                {item.type === 'album' && <span className={`shrink-0 text-[11px] ${theme.faint}`}>专辑</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 未搜索时：热搜榜 + 历史记录（官方搜索页默认态） */}
      {!submitted && (
        <div>
          {hotList.length > 0 && (
            <div className="mb-6">
              <div className={`mb-2 flex items-center gap-1.5 text-[13px] ${theme.subtle}`}>
                <Flame className="h-4 w-4" style={{ color: accent }} />
                <span>热搜榜</span>
              </div>
              {/* 官方两列排位：序号 + 词 + 热度图标 */}
              <div className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
                {hotList.map((item, index) => (
                  <button
                    key={`hot:${item.keyword}`}
                    type="button"
                    onClick={() => { setKeyword(item.keyword); void runSearch(item.keyword) }}
                    className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition ${theme.hover} ${theme.text}`}
                  >
                    <span className={`w-5 shrink-0 text-center text-[12px] tabular-nums ${index < 3 ? 'font-semibold' : theme.faint}`} style={index < 3 ? { color: accent } : undefined}>{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{item.keyword}</span>
                    {renderHotIcon(item)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {history.length > 0 && (
            <div className="mb-6">
              <div className={`mb-2 flex items-center justify-between text-[13px] ${theme.subtle}`}>
                <span>搜索历史</span>
                <button type="button" onClick={() => { setHistory([]); try { localStorage.removeItem(HISTORY_KEY) } catch { /* 忽略 */ } }} className={`text-[12px] ${theme.faint} hover:underline`}>清空</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {history.map(item => (
                  <button key={item} type="button" onClick={() => { setKeyword(item); void runSearch(item) }} className={`rounded-full px-3 py-1.5 text-[12px] ${theme.chipIdle}`}>{item}</button>
                ))}
              </div>
            </div>
          )}
          {hotList.length === 0 && (
            <PcEmpty theme={theme} title="搜索音乐" description={`支持单曲、歌手、专辑${capabilities.searchPlaylists ? '、歌单' : ''}${canSearchUsers ? '、用户' : ''}`} />
          )}
        </div>
      )}

      {submitted && (
        <>
          <div className={`mb-3 flex items-end justify-between gap-4 border-b ${theme.divider}`}>
            <PcTabs items={tabs} value={tab} onChange={setTab} accent={accent} theme={theme} />
            <span className={`pb-2 text-[12px] ${theme.faint}`}>“{submitted}” 的搜索结果</span>
          </div>

          {error ? <div className={`mb-3 rounded-lg px-3 py-2 text-[12px] ${theme.surface} ${theme.subtle}`}>{error}</div> : null}

          {tab === 'songs' && (
            <PcSongTable
              songs={songs}
              skin={skin}
              theme={theme}
              accent={accent}
              loading={loading}
              columns={{ index: true, like: true, album: true, duration: true }}
              playingKey={actions.currentSongKey}
              isPlaying={actions.isPlaying}
              onPlay={(song, index) => actions.onPlaySongs(song, songs, index)}
              onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs }) }}
              likedKeys={actions.likedKeys}
              onToggleLike={actions.onToggleLike}
              empty={resultEmpty ? <PcEmpty theme={theme} title="没有找到相关内容" description="换个关键词试试" /> : <PcEmpty theme={theme} title="暂无单曲结果" />}
            />
          )}

          {tab === 'artists' && (
            artists.length
              ? <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                  {artists.map(artist => (
                    <button key={`${artist.id || artist.mid}:${artist.name}`} type="button" onClick={() => actions.onOpenArtist?.(String(artist.mid || artist.id), platform)} className="group text-center">
                      <PcCover src={artist.picUrl || artist.avatarUrl} alt={artist.name} className="aspect-square w-full" rounded="rounded-full" />
                      <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{artist.name}</span>
                      <span className={`block truncate text-[11px] ${theme.faint}`}>{artist.albumSize ? `${artist.albumSize} 张专辑` : '歌手'}</span>
                    </button>
                  ))}
                </div>
              : <PcEmpty theme={theme} title={loading ? '正在搜索…' : '暂无歌手结果'} />
          )}

          {tab === 'albums' && (
            albums.length
              ? <PcCardGrid
                  items={albums.map(album => ({
                    key: `${album.id || album.mid}:${album.name}`,
                    coverUrl: album.picUrl,
                    title: album.name,
                    subtitle: album.artist?.name || '',
                    onClick: () => actions.onOpenAlbum?.(String(album.mid || album.id), platform),
                  }))}
                  theme={theme}
                  accent={accent}
                  columns={6}
                />
              : <PcEmpty theme={theme} title={loading ? '正在搜索…' : '暂无专辑结果'} />
          )}

          {tab === 'playlists' && (
            playlists.length
              ? <PcCardGrid
                  items={playlists.map(playlist => ({
                    key: `${playlist.platform || platform}:${playlist.id}`,
                    coverUrl: playlist.coverImgUrl || playlist.coverUrl,
                    title: playlist.name,
                    subtitle: playlist.creator?.nickname || '',
                    playCount: playlist.playCount,
                    onClick: () => actions.onOpenPlaylist(playlist),
                    onContextMenu: event => { event.preventDefault(); actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist }) },
                  }))}
                  theme={theme}
                  accent={accent}
                  columns={6}
                />
              : <PcEmpty theme={theme} title={loading ? '正在搜索…' : '暂无歌单结果'} />
          )}

          {tab === 'users' && canSearchUsers && (
            users.length
              ? <div className="grid grid-cols-1 gap-x-8 gap-y-2 md:grid-cols-2">
                  {users.map(user => (
                    <button
                      key={`search-user:${user.userId}`}
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
              : <PcEmpty theme={theme} title={loading ? '正在搜索…' : '暂无用户结果'} />
          )}
        </>
      )}

      {!account.loggedIn && submitted && (
        <p className={`mt-6 text-center text-[12px] ${theme.faint}`}>登录后可获得更完整的搜索结果</p>
      )}
    </div>
  )
}

export default memo(PcSearch)
