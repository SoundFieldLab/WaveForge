/**
 * 移动端「搜索」页：热词 + 单曲/歌单双结果。防抖 300ms，回车/按钮立即搜索。
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  searchSongs, searchPlaylists, searchHot, type SearchResult, type PlaylistSearchResult,
} from '../../services/musicApi'
import type { Song } from '../../services/musicApi'
import { useMobilePlayer } from '../mobilePlayer'
import { useMobileNav } from '../nav'
import {
  Cover, IconSearch, IconClose, IconClock, IconSearchDel, Spinner, fmtCount, songArtists, useLazyList,
} from '../ui'

type ResultTab = 'songs' | 'playlists'
const HISTORY_KEY = 'waveforge:mobile-search-history'

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, 10) : []
  } catch {
    return []
  }
}

function pushHistory(q: string) {
  try {
    const next = [q, ...readHistory().filter(x => x !== q)].slice(0, 10)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch { /* ignore */ }
}

function extractHotWords(data: unknown): string[] {
  if (!data) return []
  const arr = (data as any)?.result?.hots || (data as any)?.data?.hots || (data as any)?.hots || (data as any)?.data || []
  if (!Array.isArray(arr)) return []
  return arr
    .map((item: any) => item?.first || item?.searchWord || item?.name || (typeof item === 'string' ? item : ''))
    .filter(Boolean)
    .slice(0, 10)
}

export default memo(function MobileSearch() {
  const nav = useMobileNav()
  const player = useMobilePlayer()
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [tab, setTab] = useState<ResultTab>('songs')
  const [songResult, setSongResult] = useState<SearchResult | null>(null)
  const [plResult, setPlResult] = useState<PlaylistSearchResult | null>(null)
  const [hotWords, setHotWords] = useState<string[]>([])
  const [history, setHistory] = useState<string[]>(readHistory)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    searchHot(nav.platform).then(extractHotWords).then(setHotWords).catch(() => undefined)
  }, [nav.platform])

  const doSearch = useCallback((text: string) => {
    const q = text.trim()
    if (!q) return
    setSubmitted(q)
    pushHistory(q)
    setHistory(readHistory())
    setLoading(true)
    setSongResult(null)
    setPlResult(null)
    const jobs = [
      searchSongs(q, 40, nav.platform).then(setSongResult).catch(() => undefined),
      searchPlaylists(q, nav.platform, 20).then(setPlResult).catch(() => undefined),
    ]
    Promise.all(jobs).finally(() => setLoading(false))
    try { inputRef.current?.blur() } catch { /* ignore */ }
  }, [nav.platform])

  const songs = songResult?.songs || []
  const playlists = plResult?.playlists || []

  return (
    <div className="wf-m-page">
      <header className="wf-m-header wf-m-header-sticky">
        <div className="wf-m-searchbar">
          <IconSearch size={18} />
          <input
            ref={inputRef}
            className="wf-m-search-input"
            type="search"
            enterKeyHint="search"
            placeholder={`搜索歌曲、歌手、歌单`}
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') doSearch(keyword) }}
          />
          {keyword && (
            <button type="button" className="wf-m-search-clear" onClick={() => { setKeyword(''); setSubmitted('') }}>
              <IconClose size={15} />
            </button>
          )}
          <button type="button" className="wf-m-search-btn" onClick={() => doSearch(keyword)}>搜索</button>
        </div>
      </header>

      {!submitted && (
        <>
          {history.length > 0 && (
            <div className="wf-m-section">
              <div className="wf-m-sec-head">
                <h3 className="wf-m-sec-title"><IconClock size={15} /> 搜索历史</h3>
                <button
                  type="button"
                  className="wf-m-sec-more"
                  onClick={() => { try { localStorage.removeItem(HISTORY_KEY) } catch { /* ignore */ } setHistory([]) }}
                >
                  <IconSearchDel size={15} />
                </button>
              </div>
              <div className="wf-m-hotwords">
                {history.map(w => (
                  <button key={`h-${w}`} type="button" className="wf-m-chip" onClick={() => { setKeyword(w); doSearch(w) }}>
                    {w}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="wf-m-section">
            <div className="wf-m-sec-head">
              <h3 className="wf-m-sec-title">热门搜索</h3>
            </div>
            <div className="wf-m-hotwords">
              {hotWords.map((w, i) => (
                <button key={w} type="button" className="wf-m-chip" onClick={() => { setKeyword(w); doSearch(w) }}>
                  <span className={`wf-m-hot-rank ${i < 3 ? 'is-top' : ''}`}>{i + 1}</span>
                  {w}
                </button>
              ))}
              {!hotWords.length && <p className="wf-m-hint">输入关键词开始搜索</p>}
            </div>
          </div>
        </>
      )}

      {submitted && (
        <>
          <div className="wf-m-tabs">
            <button type="button" className={`wf-m-tab ${tab === 'songs' ? 'is-on' : ''}`} onClick={() => setTab('songs')}>
              单曲{songs.length ? ` ${songs.length}` : ''}
            </button>
            <button type="button" className={`wf-m-tab ${tab === 'playlists' ? 'is-on' : ''}`} onClick={() => setTab('playlists')}>
              歌单{playlists.length ? ` ${playlists.length}` : ''}
            </button>
          </div>
          {loading && <Spinner label="搜索中…" />}
          {!loading && tab === 'songs' && (
            <SongResults songs={songs} submitted={submitted} onPlay={(i) => player.playSongs(songs, i, `搜索：${submitted}`)}
              activeSong={player.currentSong} />
          )}
          {!loading && tab === 'playlists' && (
            <ul className="wf-m-pl-list">
              {playlists.map(pl => (
                <li key={pl.id}>
                  <button type="button" className="wf-m-pl-row" onClick={() => nav.openPlaylist({
                    id: pl.id, name: pl.name, coverUrl: pl.coverImgUrl || '', platform: nav.platform,
                    trackCount: pl.trackCount, creator: pl.creator,
                  })}>
                    <Cover url={pl.coverImgUrl} size={180} rounded={10} />
                    <span className="wf-m-pl-row-meta">
                      <span className="wf-m-pl-row-name">{pl.name}</span>
                      <span className="wf-m-pl-row-sub">
                        {pl.trackCount ? `${pl.trackCount}首` : ''}{pl.creator ? ` · by ${pl.creator}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!loading && !songs.length && !playlists.length && <p className="wf-m-hint">没有找到「{submitted}」的相关内容</p>}
        </>
      )}
    </div>
  )
})

const SongResults = memo(function SongResults({
  songs, onPlay, activeSong, submitted,
}: { songs: Song[]; onPlay: (index: number) => void; activeSong: Song | null; submitted: string }) {
  const nav = useMobileNav()
  const { visible, sentinelRef } = useLazyList(songs.length, 40)
  if (!songs.length) return <p className="wf-m-hint">没有匹配的歌曲</p>
  return (
    <>
      <ul className="wf-m-song-list">
        {songs.slice(0, visible).map((song, i) => (
          <li key={`${song.platform || ''}-${song.id ?? song.mid}-${i}`}>
            <button
              type="button"
              className={`wf-m-song-mini ${activeSong?.id === song.id && activeSong?.platform === song.platform ? 'is-active' : ''}`}
              onClick={() => onPlay(i)}
              onContextMenu={e => { e.preventDefault(); nav.openSongActions({ song, list: songs, listLabel: `搜索：${submitted}` }) }}
            >
              <span className="wf-m-song-index">{i + 1}</span>
              <span className="wf-m-song-meta">
                <span className="wf-m-song-name">{song.name}</span>
                <span className="wf-m-song-sub">{songArtists(song)}</span>
              </span>
              <Cover song={song} size={72} rounded={6} />
            </button>
          </li>
        ))}
      </ul>
      <div ref={sentinelRef} />
    </>
  )
})
