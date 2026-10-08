// 传统模式「Apple Music 客户端」广播页。
//
// 版式**不自己画**：直接把探索页的 Apple 面板（`AppleExplorePanel`）嵌进中栏 ——
// `initialTab="radio"` 指定广播页签、`chrome="none"` 隐藏面板自己的页签条与商店 chip
// （导航由传统模式左栏承担）。这样传统页与探索页的卡片/货架/抽屉/动态封面完全同一份实现，
// 不会出现「两边长得不一样、各自优化」的问题（用户 2026-10-08 明确要求「把探索页的布局搬过来」）。
// 播放/右键菜单仍回传统模式的 pcActions；歌单/专辑/艺人详情走传统模式既有页面。
import { useMemo } from 'react'
import type { Song } from '../../services/musicApi'
import {
  ApplePcTitle,
  APPLE_PC_PAD,
  applePcTheme,
  type ApplePcTone,
} from './applePcKit'
import { AppleExplorePanel } from '../../components/AppleExplorePanel'
import type { PcActions } from './types'
import type { PlaybackOrigin } from '../../types/playbackNavigation'

export interface ApplePcRadioProps {
  tone: ApplePcTone
  accent: string
  storefront: string
  actions: PcActions
  active: boolean
  currentSong: Song | null
  isPlaying: boolean
  motionSuspended?: boolean
  loggedIn: boolean
  username: string
  playbackOrigin: PlaybackOrigin
  onLoginClick?: () => void
}

export default function ApplePcRadio({
  tone, accent, storefront, actions, motionSuspended = false, loggedIn, username,
  onLoginClick, playbackOrigin,
}: ApplePcRadioProps) {
  const theme = useMemo(() => applePcTheme(tone), [tone])

  return (
    <div className="min-h-full pb-10" style={{ background: theme.content, padding: `${APPLE_PC_PAD}px ${APPLE_PC_PAD}px 0` }} data-testid="apple-pc-radio">
      <ApplePcTitle theme={theme} className="mb-6">广播</ApplePcTitle>
      {/* 探索页「广播」页签的完整内容：推荐单集 / 现在就听 / 新近内容 / 热门电台 / 风格电台 / 最近收听… */}
      <AppleExplorePanel
        appleLoggedIn={loggedIn}
        appleUsername={username}
        defaultStorefront={storefront}
        accentColor={accent}
        playerTheme={tone}
        initialTab="radio"
        chrome="none"
        motionSuspended={motionSuspended}
        restorePlaybackOrigin={null}
        onSongSelect={(song, songs) => {
          // 队列语义沿用探索页：整段货架作为队列交给传统模式的播放链路
          actions.onPlaySongs?.(song, songs?.length ? songs : [song], 0)
          void playbackOrigin
        }}
        onLoginClick={() => onLoginClick?.()}
        onSongContextMenu={(event, song, songs) => {
          event.preventDefault()
          actions.onSongMenu?.({ show: true, x: event.clientX, y: event.clientY, song, songs })
        }}
        onOpenPlaylistPanel={playlist => actions.onOpenPlaylist?.({
          id: playlist.id,
          name: playlist.name,
          coverImgUrl: playlist.coverUrl,
          platform: 'apple',
          trackCount: playlist.trackCount,
          creator: playlist.creator,
          description: playlist.description,
        })}
        onOpenAlbum={(albumId, platform) => actions.onOpenAlbum?.(albumId, platform)}
        onOpenArtistPanel={(artistId, platform) => actions.onOpenArtist?.(artistId, platform)}
        onVideoPlaybackStart={() => undefined}
      />
    </div>
  )
}
