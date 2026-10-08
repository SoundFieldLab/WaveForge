// 传统模式「Apple Music 客户端」主页（客户端侧栏「主页」）。
//
// 两种形态（与客户端一致）：
//  1) 未登录 → 整页**订阅广告**：Apple Music 图标 + 标题 + 说明 + 红色「免费试用」按钮，
//     点击与客户端一样直接打开购买窗口（finance-app.itunes.apple.com/subscribe，取证自客户端会话缓存）。
//     文案用 Apple 自带本地化串（客户端 i18n：FUSE.Upsell.Generic.*），不自行编造。
//  2) 已登录 → **把探索页的 Apple 面板嵌进中栏**（`AppleExplorePanel initialTab="home" chrome="none"`）：
//     订阅有效时是个性化主页（listen-now），订阅失效时 Apple 返回公开兜底内容 + 面板自带的
//     「订阅已失效…已显示公开内容 / 前往续订」提示条；订阅失效时广告再以一张卡片的形式出现在页首。
//     内容布局与探索页**完全同一份实现**（用户 2026-10-08 要求：别自己画一套）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Song } from '../../services/musicApi'
import {
  AppleMusicAppIcon,
  ApplePcNotice,
  ApplePcPillButton,
  ApplePcTitle,
  APPLE_PC_PAD,
  applePcTheme,
  type ApplePcTone,
} from './applePcKit'
import type { PcActions } from './types'
import { fetchAppleHomePage, type AppleWebPage } from '../../services/appleWebService'
import { getAppleCredentials } from '../../services/appleAuth'
import { openAppleSubscribeWindow } from '../../services/appleSubscribe'
import { AppleExplorePanel } from '../../components/AppleExplorePanel'
import type { PlaybackOrigin } from '../../types/playbackNavigation'

export interface ApplePcHomeProps {
  tone: ApplePcTone
  accent: string
  loggedIn: boolean
  username: string
  avatar?: string
  storefront: string
  actions: PcActions
  active: boolean
  currentSong: Song | null
  isPlaying: boolean
  /** 本面被播放页覆盖/隐藏保活：动态封面暂停取流并回收媒体 */
  suspended?: boolean
  playbackOrigin: PlaybackOrigin
  onLoginClick?: () => void
}

/** Apple 官方订阅页文案（客户端本地化串，勿改写成自造营销语）。 */
const AD_COPY = {
  headline: '尽是你爱听的音乐。',
  body: '加入 Apple Music，播放和下载数千万首歌曲，优先聆听新音乐，获得精选推荐项目以及更多内容。还可收听最佳 DJ 的节目以及广播节目点播。',
  cta: '免费试用',
}

/** 订阅广告（客户端未订阅态的主页）。standalone = 整页居中（未登录时）。 */
function SubscribeAd({ theme, accent, onSubscribe, standalone = true }: { theme: ReturnType<typeof applePcTheme>; accent: string; onSubscribe: () => void; standalone?: boolean }) {
  if (!standalone) {
    return (
      <section
        className="mb-8 flex flex-wrap items-center gap-6 rounded-xl px-7 py-6"
        style={{ background: theme.panel, border: `1px solid ${theme.divider}` }}
        data-testid="apple-pc-subscribe-ad"
      >
        <AppleMusicAppIcon className="h-14 w-14" radius={12} />
        <div className="min-w-[240px] flex-1">
          <h2 className="text-[20px] font-semibold" style={{ color: theme.text }}>{AD_COPY.headline}</h2>
          <p className="mt-1.5 max-w-[560px] text-[13px] leading-relaxed" style={{ color: theme.secondary }}>{AD_COPY.body}</p>
        </div>
        <ApplePcPillButton label={AD_COPY.cta} onClick={onSubscribe} accent={accent} className="shrink-0 min-w-[140px]" />
      </section>
    )
  }
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-10 py-16 text-center" data-testid="apple-pc-subscribe-ad">
      <AppleMusicAppIcon className="h-[84px] w-[84px]" radius={19} />
      <h1 className="mt-7 max-w-[520px] text-[28px] font-semibold leading-snug" style={{ color: theme.text }}>{AD_COPY.headline}</h1>
      <p className="mt-4 max-w-[460px] text-[14px] leading-relaxed" style={{ color: theme.secondary }}>{AD_COPY.body}</p>
      <ApplePcPillButton label={AD_COPY.cta} onClick={onSubscribe} accent={accent} className="mt-7 min-w-[168px]" />
    </div>
  )
}

export default function ApplePcHome({
  tone, accent, loggedIn, username, storefront, actions, active, suspended = false,
  playbackOrigin, onLoginClick,
}: ApplePcHomeProps) {
  const theme = useMemo(() => applePcTheme(tone), [tone])
  // 只用于判断「订阅是否失效」以决定页首要不要放订阅广告卡（内容本身由面板渲染）
  const [subscriptionExpired, setSubscriptionExpired] = useState(false)
  const [checkError, setCheckError] = useState('')
  const requestRef = useRef(0)
  const loadedRef = useRef(false)

  const load = useCallback(() => {
    if (!loggedIn) return
    const request = ++requestRef.current
    setCheckError('')
    void fetchAppleHomePage(storefront)
      .then((page: AppleWebPage) => {
        if (request !== requestRef.current) return
        setSubscriptionExpired(Boolean(page.subscriptionExpired))
      })
      .catch(reason => {
        if (request !== requestRef.current) return
        setCheckError(reason instanceof Error ? reason.message : '')
      })
  }, [loggedIn, storefront])

  useEffect(() => {
    if (!active || !loggedIn || loadedRef.current) return
    const credentials = getAppleCredentials()
    if (!credentials.mediaUserToken) return
    loadedRef.current = true
    load()
  }, [active, loggedIn, load])

  const subscribe = useCallback(() => { openAppleSubscribeWindow() }, [])

  if (!loggedIn) {
    return (
      <div className="min-h-full" style={{ background: theme.content }}>
        <SubscribeAd theme={theme} accent={accent} onSubscribe={subscribe} />
      </div>
    )
  }

  return (
    <div className="min-h-full pb-10" style={{ background: theme.content, padding: `${APPLE_PC_PAD}px ${APPLE_PC_PAD}px 0` }} data-testid="apple-pc-home">
      <ApplePcTitle theme={theme} className="mb-6">主页</ApplePcTitle>
      {subscriptionExpired && <SubscribeAd theme={theme} accent={accent} onSubscribe={subscribe} standalone={false} />}
      {checkError ? (
        <div className="mb-6">
          <ApplePcNotice theme={theme} title="主页加载失败" description={checkError} tone="warning" action={<ApplePcPillButton label="重试" onClick={load} accent={accent} />} />
        </div>
      ) : null}
      {/* 探索页「主页」页签的完整内容（个性化货架 / 公开兜底货架 + 失效提示条，全在面板内） */}
      <AppleExplorePanel
        appleLoggedIn={loggedIn}
        appleUsername={username}
        defaultStorefront={storefront}
        accentColor={accent}
        playerTheme={tone}
        initialTab="home"
        chrome="none"
        motionSuspended={suspended}
        restorePlaybackOrigin={null}
        onSongSelect={(song, songs) => {
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
