/**
 * 移动端应用外壳（手机 + 平板）：
 *  - 手机：底部标签栏（发现/搜索/我的/设置）+ 迷你播放条 + 全屏播放页
 *  - 平板：左侧竖向导航栏 + 内容区 + 迷你播放条 + 全屏播放页
 *  - Fold：展开（≥600dp）自动切平板布局，折叠自动切回手机布局（运行时响应，不重载）
 *  - 两种形态都可在设置里切「PC 版」完整桌面布局（platform.ts pc-touch）
 *
 * 导航为页面栈：tab 根页面 + push/pop 二级页（歌单/专辑/歌手详情）；
 * MV 播放器与歌曲动作面板是覆盖层（各自注册 BACK 处理，后注册先消费）。
 * Android BACK 经 mobileBack 栈逐级返回。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './mobile.css'
import type { MusicPlatform } from '../services/platforms'
import type { ExplorePlaylist } from '../services/exploreApi'
import { getAppliedFormFactor, type FormFactor } from '../platform'
import { MobilePlayerProvider } from './mobilePlayer'
import { MobileNavContext, type MobileTabKey, type MobileAlbumTarget, type MobileArtistTarget, type MobileMvTarget, type MobileSongActionsTarget } from './nav'
import { useMobileBack } from './mobileBack'
import { useAccounts } from './mobileLogin'
import MiniPlayerBar from './MiniPlayerBar'
import PlayerSheet from './PlayerSheet'
import { MobileSongActionSheet } from './MobileActionSheet'
import { MobileToastHost, IconHome, IconLibrary, IconSearch, IconSettings, PLATFORM_ACCENT } from './ui'

const MobileHome = lazy(() => import('./pages/MobileHome'))
const MobileSearch = lazy(() => import('./pages/MobileSearch'))
const MobileLibrary = lazy(() => import('./pages/MobileLibrary'))
const MobileSettings = lazy(() => import('./pages/MobileSettings'))
const MobilePlaylistDetail = lazy(() => import('./pages/MobilePlaylistDetail'))
const MobileArtistPage = lazy(() => import('./pages/MobileArtistPage'))
const MobileMvPlayer = lazy(() => import('./MobileMvPlayer'))

const PLATFORM_KEY = 'waveforge:mobile-platform'

function readPlatform(): MusicPlatform {
  try {
    const v = localStorage.getItem(PLATFORM_KEY)
    if (v === 'netease' || v === 'qq' || v === 'kugou' || v === 'soda' || v === 'apple' || v === 'spotify') return v
  } catch { /* ignore */ }
  return 'netease'
}

type StackItem =
  | { kind: 'tab'; tab: MobileTabKey }
  | { kind: 'playlist'; playlist: ExplorePlaylist; id: number }
  | { kind: 'album'; album: MobileAlbumTarget; id: number }
  | { kind: 'artist'; artist: MobileArtistTarget; id: number }

export default function MobileApp() {
  // 初始/切换都读应用态形态（data-form，含 ?ui 模拟覆盖）：Fold 真机与 PC 模拟口径一致
  const [form, setForm] = useState<FormFactor>(() => getAppliedFormFactor())
  const [platform, setPlatformState] = useState<MusicPlatform>(readPlatform)
  const [stack, setStack] = useState<StackItem[]>([{ kind: 'tab', tab: 'home' }])
  const [playerOpen, setPlayerOpen] = useState(false)
  const [mvTarget, setMvTarget] = useState<MobileMvTarget | null>(null)
  const [songActions, setSongActions] = useState<MobileSongActionsTarget | null>(null)
  const stackSeqRef = useRef(1)
  const { accounts } = useAccounts()

  // Fold 开合 → 布局切换（platform.ts 的 resize 监听派发事件）
  useEffect(() => {
    const onPlatformChanged = () => setForm(getAppliedFormFactor())
    window.addEventListener('waveforge-platform-changed', onPlatformChanged)
    return () => window.removeEventListener('waveforge-platform-changed', onPlatformChanged)
  }, [])

  const switchTab = useCallback((tab: MobileTabKey) => {
    setStack([{ kind: 'tab', tab }])
  }, [])

  const push = useCallback((item:
    | { kind: 'playlist'; playlist: ExplorePlaylist }
    | { kind: 'album'; album: MobileAlbumTarget }
    | { kind: 'artist'; artist: MobileArtistTarget }) => {
    stackSeqRef.current += 1
    const id = stackSeqRef.current
    setStack(prev => [...prev, { ...item, id } as StackItem])
  }, [])

  const openPlaylist = useCallback((playlist: ExplorePlaylist) => {
    push({ kind: 'playlist', playlist })
  }, [push])

  const openAlbum = useCallback((album: MobileAlbumTarget) => {
    push({ kind: 'album', album })
  }, [push])

  const openArtist = useCallback((artist: MobileArtistTarget) => {
    push({ kind: 'artist', artist })
  }, [push])

  const setPlatform = useCallback((p: MusicPlatform) => {
    setPlatformState(p)
    try { localStorage.setItem(PLATFORM_KEY, p) } catch { /* ignore */ }
  }, [])

  // BACK：本处理器注册最晚（父组件 effect 晚于子组件），LIFO 下最先被派发——
  // 因此只负责「无覆盖层时的页面栈 pop」。播放页/MV/动作面板开着时必须让位
  // （return false），由它们各自注册的处理器逐层消费：否则按返回会整层关闭播放页，
  // 跳过「队列抽屉 → 播放页」的中间层级（实测 BACK 关队列却把整个播放页带走了）。
  // 栈底返回 false（原生默认：退出应用）。
  useMobileBack(() => {
    if (playerOpen || mvTarget || songActions) return false
    if (stack.length > 1) { setStack(prev => prev.slice(0, -1)); return true }
    return false
  }, [playerOpen, mvTarget, songActions, stack.length])

  // 覆盖层全部关闭（从播放页/MV/动作面板回到页面）时广播 resume：
  // 「我的」页监听它刷新最近播放（播放页里播过的歌要及时上榜）。
  const overlayWasOpenRef = useRef(false)
  useEffect(() => {
    const anyOpen = playerOpen || Boolean(mvTarget) || Boolean(songActions)
    if (overlayWasOpenRef.current && !anyOpen) {
      window.dispatchEvent(new CustomEvent('waveforge-mobile-resume'))
    }
    overlayWasOpenRef.current = anyOpen
  }, [playerOpen, mvTarget, songActions])

  const currentTab: MobileTabKey = stack[0]?.kind === 'tab' ? stack[0].tab : 'home'

  const nav = useMemo(() => ({
    tab: currentTab,
    switchTab, openPlaylist, openAlbum, openArtist,
    openMv: (mv: MobileMvTarget) => setMvTarget(mv),
    openSongActions: (target: MobileSongActionsTarget) => setSongActions(target),
    openPlayer: () => setPlayerOpen(true),
    platform, setPlatform,
    userId: accounts[platform]?.userId || '',
  }), [currentTab, switchTab, openPlaylist, openAlbum, openArtist, platform, setPlatform, accounts])

  return (
    <MobileNavContext.Provider value={nav}>
      <MobilePlayerProvider>
        <div
          className={`wf-m-root ${form === 'tablet' ? 'is-tablet' : 'is-phone'}`}
          data-form={form}
          style={{ '--wf-accent': PLATFORM_ACCENT[platform] || '#3d8bfd' } as React.CSSProperties}
        >
          {form === 'tablet'
            ? <TabletShell stack={stack} currentTab={currentTab} switchTab={switchTab} onOpenPlayer={() => setPlayerOpen(true)} />
            : <PhoneShell stack={stack} currentTab={currentTab} switchTab={switchTab} onOpenPlayer={() => setPlayerOpen(true)} />}
          <PlayerSheet open={playerOpen} onClose={() => setPlayerOpen(false)} />
          {mvTarget && (
            <Suspense fallback={<div className="wf-m-loading"><span className="wf-m-spinner" /></div>}>
              <MobileMvPlayer target={mvTarget} onClose={() => setMvTarget(null)} />
            </Suspense>
          )}
          <MobileSongActionSheet target={songActions} onClose={() => setSongActions(null)} nav={nav} />
          <MobileToastHost />
        </div>
      </MobilePlayerProvider>
    </MobileNavContext.Provider>
  )
}

/** 页面栈渲染：栈顶最近的详情页优先，否则渲染当前 tab 页。 */
function StackRenderer({ stack, currentTab }: { stack: StackItem[]; currentTab: MobileTabKey }) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const item = stack[i]
    if (item.kind === 'playlist') {
      return <MobilePlaylistDetail key={item.id} playlist={item.playlist} />
    }
    if (item.kind === 'album') {
      return <MobilePlaylistDetail key={item.id} album={item.album} />
    }
    if (item.kind === 'artist') {
      return <MobileArtistPage key={item.id} target={item.artist} />
    }
  }
  return <TabPage tab={currentTab} />
}

function TabPage({ tab }: { tab: MobileTabKey }) {
  return (
    <Suspense fallback={<div className="wf-m-loading"><span className="wf-m-spinner" /></div>}>
      {tab === 'home' && <MobileHome />}
      {tab === 'search' && <MobileSearch />}
      {tab === 'library' && <MobileLibrary />}
      {tab === 'settings' && <MobileSettings />}
    </Suspense>
  )
}

// ── 手机壳：底部标签 + 迷你条 ──
function PhoneShell({ stack, currentTab, switchTab, onOpenPlayer }: {
  stack: StackItem[]
  currentTab: MobileTabKey
  switchTab: (tab: MobileTabKey) => void
  onOpenPlayer: () => void
}) {
  return (
    <div className="wf-m-phone">
      <main className="wf-m-content">
        <StackRenderer stack={stack} currentTab={currentTab} />
      </main>
      <div className="wf-m-bottom-dock">
        <MiniPlayerBar onOpen={onOpenPlayer} />
        <nav className="wf-m-tabbar">
          <TabButton tab="home" current={currentTab} onPick={switchTab} icon={<IconHome size={22} />} label="发现" />
          <TabButton tab="search" current={currentTab} onPick={switchTab} icon={<IconSearch size={22} />} label="搜索" />
          <TabButton tab="library" current={currentTab} onPick={switchTab} icon={<IconLibrary size={22} />} label="我的" />
          <TabButton tab="settings" current={currentTab} onPick={switchTab} icon={<IconSettings size={22} />} label="设置" />
        </nav>
      </div>
    </div>
  )
}

// ── 平板壳：左侧导航栏 + 内容 ──
function TabletShell({ stack, currentTab, switchTab, onOpenPlayer }: {
  stack: StackItem[]
  currentTab: MobileTabKey
  switchTab: (tab: MobileTabKey) => void
  onOpenPlayer: () => void
}) {
  return (
    <div className="wf-m-tablet">
      <aside className="wf-m-rail">
        <div className="wf-m-rail-logo">澜</div>
        <RailButton tab="home" current={currentTab} onPick={switchTab} icon={<IconHome size={22} />} label="发现" />
        <RailButton tab="search" current={currentTab} onPick={switchTab} icon={<IconSearch size={22} />} label="搜索" />
        <RailButton tab="library" current={currentTab} onPick={switchTab} icon={<IconLibrary size={22} />} label="我的" />
        <div className="wf-m-rail-spacer" />
        <RailButton tab="settings" current={currentTab} onPick={switchTab} icon={<IconSettings size={22} />} label="设置" />
      </aside>
      <div className="wf-m-tablet-main">
        <main className="wf-m-content">
          <StackRenderer stack={stack} currentTab={currentTab} />
        </main>
        <MiniPlayerBar onOpen={onOpenPlayer} />
      </div>
    </div>
  )
}

function TabButton({ tab, current, onPick, icon, label }: {
  tab: MobileTabKey
  current: MobileTabKey
  onPick: (tab: MobileTabKey) => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      className={`wf-m-tabbar-btn ${current === tab ? 'is-on' : ''}`}
      onClick={() => onPick(tab)}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function RailButton({ tab, current, onPick, icon, label }: {
  tab: MobileTabKey
  current: MobileTabKey
  onPick: (tab: MobileTabKey) => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      className={`wf-m-rail-btn ${current === tab ? 'is-on' : ''}`}
      onClick={() => onPick(tab)}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}
