// 传统模式「Apple Music 客户端」搜索页。
//
// 依据官方行为（用户实测 + 客户端一致）：**点侧栏搜索框先到「类别浏览」**（apple-curators 网格），
// 输入关键词后才出结果分区——与探索模式的 Apple 搜索页完全同源。
// 因此这里直接复用探索模式的两个组件：
//   · `AppleMusicSearchPage`（搜索框 + 范围切换 + 结果分区）
//   · `BrowseCategoriesLanding`（无关键词时的类别浏览落地页）
// 只外面套一层客户端版式（大标题 + 40px 内边距 + 客户端配色），播放/跳转全部回到传统模式的 pcActions。
import { useCallback, useMemo } from 'react'
import {
  ApplePcTitle,
  APPLE_PC_PAD,
  applePcTheme,
  type ApplePcTone,
} from './applePcKit'
import { MotionSuspendContext } from '../../components/apple-explore/MotionArtwork'
import AppleMusicSearchPage from '../../components/AppleMusicSearchPage'
import BrowseCategoriesLanding from '../../components/AppleSearchBrowse'
import type { PcActions } from './types'
import { appleStationToSong, appleWebItemToSong, type AppleWebItem } from '../../services/appleWebService'
import type { PlaybackOrigin } from '../../types/playbackNavigation'

export interface ApplePcSearchProps {
  tone: ApplePcTone
  accent: string
  storefront: string
  actions: PcActions
  active: boolean
  suspended?: boolean
  initialKeyword?: string
  /** 播放来源（播放器返回时定位回搜索页） */
  playbackOrigin: PlaybackOrigin
  onBack?: () => void
}

export default function ApplePcSearch({ tone, accent: _accent, storefront, actions, active, suspended = false, initialKeyword, playbackOrigin }: ApplePcSearchProps) {
  const theme = useMemo(() => applePcTheme(tone), [tone])

  /** 类别浏览/结果里的条目按真实类型分派（与探索页 activateItem 同规则） */
  const openItem = useCallback((item: AppleWebItem) => {
    if (item.type === 'playlists') {
      actions.onOpenPlaylist?.({
        id: item.playId || item.id,
        name: item.name,
        coverImgUrl: item.artworkUrl,
        platform: 'apple',
        trackCount: item.trackCount,
        creator: item.curatorName,
      })
      return
    }
    if (item.type === 'albums') { actions.onOpenAlbum?.(item.playId || item.id, 'apple'); return }
    if (item.type === 'artists') { actions.onOpenArtist?.(item.playId || item.id, 'apple'); return }
    if (item.type === 'stations') {
      // 电台直接开播（与传统页广播页一致）
      const song = appleStationToSong(item, undefined, storefront)
      actions.onPlaySongs?.(song, [song], 0)
    }
  }, [actions, storefront])

  return (
    <MotionSuspendContext.Provider value={Boolean(suspended)}>
      <div className="min-h-full pb-10" style={{ background: theme.content, padding: `${APPLE_PC_PAD}px ${APPLE_PC_PAD}px 0` }} data-testid="apple-pc-search">
        <ApplePcTitle theme={theme} className="mb-6">搜索</ApplePcTitle>
        <AppleMusicSearchPage
          playerTheme={tone}
          storefront={storefront}
          onSongSelect={(song, songs, origin) => {
            actions.onPlaySongs?.(song, songs?.length ? songs : [song], 0)
            void origin
          }}
          playbackOrigin={playbackOrigin}
          onOpenItem={item => openItem(item)}
          onOpenPlaylist={playlist => actions.onOpenPlaylist?.(playlist)}
          onSongContextMenu={(event, item) => {
            event.preventDefault()
            // 结果行右键 → 全局歌曲菜单（AppleWebItem → Song 走统一转换）
            actions.onSongMenu?.({ show: true, x: event.clientX, y: event.clientY, song: appleWebItemToSong(item, storefront) })
          }}
          renderLanding={() => (
            <BrowseCategoriesLanding
              playerTheme={tone}
              storefront={storefront}
              onSongSelect={song => actions.onPlaySongs?.(song, [song], 0)}
              playbackOrigin={playbackOrigin}
              onOpenItem={item => openItem(item)}
              onOpenPlaylist={playlist => actions.onOpenPlaylist?.(playlist)}
              suspended={!active || suspended}
            />
          )}
        />
      </div>
    </MotionSuspendContext.Provider>
  )
}
