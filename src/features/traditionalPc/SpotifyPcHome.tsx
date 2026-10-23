// 传统模式「Spotify 客户端」主页（对齐官方桌面客户端发现页布局，数据全部来自 partner 桥）。
//
// 与 Apple Music 传统页同一套做法：布局/内容/信息对齐官方客户端，保留 WaveForge 第三栏。
//  - 顶部「欢迎回来，{username}」问候横幅
//  - 你的歌单行（libraryV3 我的歌单网格）
//  - 排行榜（Global Top 50 曲目表）
//  - 新歌速递（Today's Top Hits 曲目表）
// 数据源：spotifyPartnerData（libraryV3/fetchPlaylist），封面/曲目名/创作者全为官方字段。
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Song } from '../../services/musicApi'
import { applePcTheme, ApplePcCardGrid, ApplePcSongsTable, ApplePcTitle, type ApplePcTone, type ApplePcCardItem, type ApplePcSongRow } from './applePcKit'
import type { PcActions } from './types'
import { fetchPartnerMyPlaylists, fetchPartnerPlaylistTracks } from '../../services/spotifyPartnerData'
import type { SpotifyPlaylist, SpotifyTrack } from '../../services/spotifyService'

export interface SpotifyPcHomeProps {
  tone: ApplePcTone
  accent: string
  loggedIn: boolean
  username: string
  avatar?: string
  actions: PcActions
  active: boolean
  currentSong: Song | null
  onLoginClick?: () => void
}

interface ChartPayload {
  id: string
  name: string
  rows: ApplePcSongRow[]
}

const PINNED: Array<{ uri: string; id: string; label: string }> = [
  { uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', id: '37i9dQZF1DXcBWIGoYBM5M', label: "Today's Top Hits" },
  { uri: 'spotify:playlist:37i9dQZF1DX0XUsuxWHRQd', id: '37i9dQZF1DX0XUsuxWHRQd', label: 'Global Top 50' },
]

function spotifyTrackToSong(t: SpotifyTrack): Song {
  return {
    id: Number(parseInt(t.id.slice(0, 12), 36)) || 0,
    mid: t.id,
    name: t.name,
    artists: t.artists.map(a => ({ name: a.name })),
    album: { name: t.album?.name ?? '', picUrl: t.album?.images?.[0]?.url ?? '' },
    duration: t.duration_ms ?? 0,
    platform: 'spotify',
  }
}

export default function SpotifyPcHome({ tone, accent, loggedIn, username, avatar, actions, active, onLoginClick }: SpotifyPcHomeProps) {
  const theme = useMemo(() => applePcTheme(tone), [tone])
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([])
  const [charts, setCharts] = useState<ChartPayload[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [pl, topHits, global50] = await Promise.all([
        fetchPartnerMyPlaylists(30).catch(() => null),
        fetchPartnerPlaylistTracks('37i9dQZF1DXcBWIGoYBM5M').catch(() => null),
        fetchPartnerPlaylistTracks('37i9dQZF1DX0XUsuxWHRQd').catch(() => null),
      ])
      setPlaylists(pl ?? [])
      const toChart = (id: string, name: string, tracks: SpotifyTrack[] | null): ChartPayload => ({
        id,
        name,
        rows: (tracks ?? []).slice(0, 10).map((t, i) => ({
          song: spotifyTrackToSong(t),
          catalogId: t.id,
          genre: undefined,
        })),
      })
      setCharts([
        toChart('37i9dQZF1DXcBWIGoYBM5M', "Today's Top Hits", topHits),
        toChart('37i9dQZF1DX0XUsuxWHRQd', 'Global Top 50', global50),
      ])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败，请重试')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const gridItems: ApplePcCardItem[] = playlists.map(p => ({
    key: p.id,
    title: p.name,
    subtitle: p.tracksTotal ? `${p.tracksTotal} 首歌曲` : '歌单',
    coverUrl: p.coverUrl ?? '',
    onClick: () => actions.onOpenPlaylist?.({ ...p, platform: 'spotify' } as any),
  }))

  const handlePlay = (chart: ChartPayload, index: number) => {
    const songs: Song[] = chart.rows.map(r => r.song)
    actions.onPlaySongs(songs[index], songs, index)
  }

  if (!loggedIn) {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: theme.background }}>
        <button
          type="button"
          onClick={onLoginClick}
          className="rounded-full px-8 py-3 text-sm font-bold text-black transition hover:brightness-110"
          style={{ background: accent }}
        >
          登录 Spotify
        </button>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-8 py-6" style={{ background: theme.background }} data-active={active}>
      {/* 问候横幅（对齐官方「欢迎回来，{name}」） */}
      <h1 className="mb-1 text-3xl font-bold" style={{ color: theme.text }}>欢迎回来，{username}</h1>
      <p className="mb-8 text-sm" style={{ color: theme.secondary }}>发现音乐与播客，从这里开始。</p>

      {loading && <p style={{ color: theme.secondary }}>加载中…</p>}
      {error && <p style={{ color: theme.secondary }}>{error}</p>}

      {/* 你的歌单（官方 pinned 歌单网格 + 我的资料库歌单） */}
      {gridItems.length > 0 && (
        <>
          <ApplePcTitle theme={theme}>你的歌单</ApplePcTitle>
          <div className="mb-8">
            <ApplePcCardGrid items={gridItems} theme={theme} columns={5} />
          </div>
        </>
      )}

      {/* 排行榜：两个官方 pinned 榜的曲目表 */}
      {charts.map(chart => chart.rows.length > 0 && (
        <div key={chart.id} className="mb-8">
          <ApplePcTitle theme={theme}>{chart.name}</ApplePcTitle>
          <div className="rounded-xl p-2" style={{ background: theme.panel }}>
            <ApplePcSongsTable
              rows={chart.rows}
              theme={theme}
              onPlay={(row, index) => handlePlay(chart, index)}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
