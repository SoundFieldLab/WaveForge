import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronUp, Compass, Headphones, Loader2, RefreshCw } from 'lucide-react'
import type { NeteaseNativeBlock, NeteaseNativeResource } from './model'
import { normalizeNeteaseLinkPage, normalizeNeteaseResource } from './model'
import type { Song } from '../../services/musicApi'
import { NeteaseNativeBlockView, type ResourceCallbacks } from './NeteaseResourceView'
import {
  fetchNeteaseCubePage,
  fetchNeteaseLinkPage,
  fetchNeteaseMusicChannels,
  fetchNeteasePlaylistSquare,
  fetchNeteasePodcastInfinite,
  fetchNeteaseVipPage,
  fetchNeteaseToplist,
  fillNeteaseCubeCovers,
  normalizeNeteaseCubePage,
  normalizeNeteasePodcastHome,
  normalizeNeteaseSquareBlocks,
  normalizeNeteaseToplistBlocks,
  type NeteaseCubeTab,
  type NeteaseMusicChannel,
  type NeteaseVipPage,
} from './discover'
import { fetchNeteaseRoam } from './api'
import NeteasePodcastPages, { type NeteasePodcastView } from './NeteasePodcastPages'
import NeteaseCubePageView from './NeteaseCubePageView'
import NeteaseVipView from './NeteaseVipView'

// src/features/neteaseExplore/NeteaseDiscoverView.tsx
// 网易云「发现」页：音乐 / 播客 两个一级 Tab。
//  - 音乐：频道 chips（精选/排行榜/歌单/曲风…）；曲风频道带页内子 Tab；歌单广场支持翻页
//  - 播客：播客首页（固定入口 + 9 个区块）
// 接口与页面语义见 docs/netease-discover-reverse-2026-09-13.md；听书按需求不接入。

export type NeteaseDiscoverTab = 'music' | 'podcast'

interface NeteaseDiscoverViewProps {
  accent: string
  callbacks: ResourceCallbacks
  /** 由推荐页「更多」跳转过来时指定频道 */
  initialChannelCode?: string
  /** 账号 id：用于「我的播客」 */
  accountUserId?: string
  /** 一级 Tab（音乐/播客）由上层顶部导航控制 */
  tab: NeteaseDiscoverTab
  onTabChange: (tab: NeteaseDiscoverTab) => void
  /** 外部跳转（推荐页「更多」/跨 Tab 导航），token 变化时生效 */
  jump?: { tab: NeteaseDiscoverTab; channelCode?: string; token: number }
  /** 站内打开单个 cube 页（如「宝藏音乐人」） */
  cubePage?: { pageId: string; title: string; token: number }
}

interface ChannelContent {
  loading: boolean
  error: string
  blocks: NeteaseNativeBlock[]
  cubeTabs: NeteaseCubeTab[]
  squareOffset: number
  hasMore: boolean
  loadingMore: boolean
  vip: NeteaseVipPage | null
}

const EMPTY_CONTENT: ChannelContent = { loading: true, error: '', blocks: [], cubeTabs: [], squareOffset: 0, hasMore: false, loadingMore: false, vip: null }

const MUSIC_TAB = 'music'
const PODCAST_TAB = 'podcast'
const FEATURE_CHANNEL = 'feature'
const CHART_CHANNEL = 'chart'
const PLAYLIST_CHANNEL = 'playlist'
const VIP_CHANNEL = 'vip'
const SQUARE_PAGE_SIZE = 20

export default function NeteaseDiscoverView({ accent, callbacks, initialChannelCode, accountUserId, tab, onTabChange, jump, cubePage }: NeteaseDiscoverViewProps) {
  const [channels, setChannels] = useState<NeteaseMusicChannel[]>([])
  const [channelsError, setChannelsError] = useState('')
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [channelsExpanded, setChannelsExpanded] = useState(false)
  const [activeCode, setActiveCode] = useState(initialChannelCode || FEATURE_CHANNEL)
  const activeCodeRef = useRef(activeCode)
  const [contents, setContents] = useState<Record<string, ChannelContent>>({})
  // 供 loadChannel（依赖为空数组）读取「已经加载过的频道」，避免闭包拿到旧值
  const contentsRef = useRef(contents)
  contentsRef.current = contents
  const [activeCubeTab, setActiveCubeTab] = useState(0)
  const [podcast, setPodcast] = useState<{ loading: boolean; error: string; blocks: NeteaseNativeBlock[]; quickEntries: NeteaseNativeResource[]; cursor: string; hasMore: boolean; loadingMore: boolean }>({ loading: true, error: '', blocks: [], quickEntries: [], cursor: '', hasMore: false, loadingMore: false })
  // 曲风频道底部的「猜你喜欢」无限流（App 内可持续下拉刷新）
  const [fmExtra, setFmExtra] = useState<Record<string, { songs: Song[]; loading: boolean; mode: string; subMode: string }>>({})
  const [refreshRevision, setRefreshRevision] = useState(0)
  // 记录已经按哪一版 revision 拉过数据：只有用户主动刷新（revision 变了）才强制重拉。
  const loadedRevisionRef = useRef(refreshRevision)
  const [podcastView, setPodcastView] = useState<NeteasePodcastView | null>(null)
  const [podcastViewVisible, setPodcastViewVisible] = useState(false)
  const [openCube, setOpenCube] = useState<{ pageId: string; title: string } | null>(null)
  const [openCubeVisible, setOpenCubeVisible] = useState(false)
  // 层级导航：进入下一级回到顶部，返回时还原上一级的滚动位置，并触发过渡动画
  const [navKey, setNavKey] = useState(0)
  const scrollStackRef = useRef<number[]>([])
  const pendingScrollRef = useRef<number | null>(0)
  const scrollContainer = () => document.querySelector<HTMLElement>('.explore-scrollbar')
  const navigate = useCallback((mode: 'push' | 'restore' | 'restore-home' | 'top') => {
    const container = scrollContainer()
    if (container) {
      if (mode === 'push') scrollStackRef.current.push(container.scrollTop)
      if (mode === 'restore') pendingScrollRef.current = scrollStackRef.current.pop() ?? 0
      if (mode === 'restore-home') {
        // 分类详情/全部分类的返回直接回到最外层播客首页，并还原首页滚动位置
        pendingScrollRef.current = scrollStackRef.current[0] ?? 0
        scrollStackRef.current = []
      }
      if (mode === 'top') { pendingScrollRef.current = 0; scrollStackRef.current = [] }
    }
    setNavKey(key => key + 1)
  }, [])

  useLayoutEffect(() => {
    const container = scrollContainer()
    if (!container) return
    const target = pendingScrollRef.current
    pendingScrollRef.current = null
    container.scrollTo({ top: target ?? 0, behavior: 'auto' })
  }, [navKey])
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => { activeCodeRef.current = activeCode }, [activeCode])
  const activeChannel = useMemo(() => channels.find(channel => channel.code === activeCode) || null, [channels, activeCode])

  useEffect(() => {
    if (!cubePage) return
    navigate('push')
    setPodcastViewVisible(false)
    setOpenCube({ pageId: cubePage.pageId, title: cubePage.title })
    setOpenCubeVisible(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cubePage?.token])

  // 推荐页「更多」/跨 Tab 跳转
  useEffect(() => {
    if (!jump) return
    onTabChange(jump.tab)
    if (jump.channelCode) {
      setActiveCode(jump.channelCode)
      setActiveCubeTab(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump?.token])

  useEffect(() => {
    const controller = new AbortController()
    controllerRef.current?.abort()
    controllerRef.current = controller
    setChannelsLoading(true)
    setChannelsError('')
    void fetchNeteaseMusicChannels(controller.signal)
      .then(list => {
        if (controller.signal.aborted) return
        // 「精选」在 App 中固定为第一个 Tab，服务端 nowChannelItems 顺序不保证，这里强制置顶
        const feature = list.find(channel => channel.code === FEATURE_CHANNEL)
          || { code: FEATURE_CHANNEL, title: '精选', url: '', urlType: 'native', pageId: '' }
        const withFeature = [feature, ...list.filter(channel => channel.code !== FEATURE_CHANNEL)]
        setChannels(withFeature)
        setActiveCode(previous => (withFeature.some(channel => channel.code === previous) ? previous : withFeature[0]?.code || FEATURE_CHANNEL))
      })
      .catch(error => {
        if (!controller.signal.aborted) setChannelsError(error instanceof Error ? error.message : '频道列表加载失败')
      })
      .finally(() => { if (!controller.signal.aborted) setChannelsLoading(false) })
    return () => controller.abort()
  }, [refreshRevision])

  const loadChannel = useCallback(async (channel: NeteaseMusicChannel, signal: AbortSignal, force = false) => {
    // 已经加载好的频道直接复用：在频道 chip 之间来回点（A→B→A）不该每次都清空重拉一遍。
    const cached = contentsRef.current[channel.code]
    if (!force && cached && !cached.error && !cached.loading) return
    const setContent = (content: ChannelContent) => setContents(previous => ({ ...previous, [channel.code]: content }))
    setContent(EMPTY_CONTENT)
    setActiveCubeTab(0)
    try {
      if (channel.code === FEATURE_CHANNEL) {
        const blocks = normalizeNeteaseLinkPage(await fetchNeteaseLinkPage('HOME_DISCOVERY_PAGE', '0', force, signal)).blocks
          .filter(block => block.resources.length > 0)
        if (!signal.aborted) setContent({ ...EMPTY_CONTENT, loading: false, blocks })
      } else if (channel.code === CHART_CHANNEL) {
        const blocks = normalizeNeteaseToplistBlocks(await fetchNeteaseToplist(signal))
        if (!signal.aborted) setContent({ ...EMPTY_CONTENT, loading: false, blocks })
      } else if (channel.code === PLAYLIST_CHANNEL) {
        const payload = await fetchNeteasePlaylistSquare('推荐', 0, SQUARE_PAGE_SIZE, signal)
        const blocks = normalizeNeteaseSquareBlocks(payload)
        if (!signal.aborted) setContent({ ...EMPTY_CONTENT, loading: false, blocks, squareOffset: SQUARE_PAGE_SIZE, hasMore: payload?.data?.hasMore !== false })
      } else if (channel.pageId) {
        const page = normalizeNeteaseCubePage(await fetchNeteaseCubePage(channel.pageId, signal, force))
        if (signal.aborted) return
        // 先渲染已有内容，再异步回填缺封面：封面请求不受本页 abort 影响（严格模式下 effect 会双调用），
        // 并且只在频道仍然激活时回填，避免用旧结果覆盖新频道内容。
        setContent({ ...EMPTY_CONTENT, loading: false, blocks: page.blocks, cubeTabs: page.tabs })
        void fillNeteaseCubeCovers(page).then(filled => {
          if (activeCodeRef.current !== channel.code) return
          setContent({ ...EMPTY_CONTENT, loading: false, blocks: filled.blocks, cubeTabs: filled.tabs })
        }).catch(() => undefined)
      } else if (channel.code === VIP_CHANNEL) {
        const vip = await fetchNeteaseVipPage(false, signal)
        if (!signal.aborted) setContent({ ...EMPTY_CONTENT, loading: false, vip })
      }
    } catch (error) {
      if (!signal.aborted) setContent({ ...EMPTY_CONTENT, loading: false, error: error instanceof Error ? error.message : '频道内容加载失败' })
    }
  }, [])

  useEffect(() => {
    if (tab !== MUSIC_TAB || !activeChannel) return
    // 只有用户主动刷新（revision 变化）才强制重拉；普通切频道命中缓存直接复用。
    const force = loadedRevisionRef.current !== refreshRevision
    loadedRevisionRef.current = refreshRevision
    const controller = new AbortController()
    void loadChannel(activeChannel, controller.signal, force)
    return () => controller.abort()
  }, [activeChannel, loadChannel, tab, refreshRevision])

  // 曲风频道底部「猜你喜欢」：用频道内的 FM 入口参数（mode/subMode）拉场景漫游歌曲

  // 播客首页：成功加载过（且不是用户主动刷新）就直接复用。音乐/播客 Tab 来回切时不再重拉整页。
  // 失败时 revision 不落账，切回来仍会重试，保留原有重试路径。
  const podcastRevisionRef = useRef(-1)
  useEffect(() => {
    if (tab !== PODCAST_TAB) return
    if (podcastRevisionRef.current === refreshRevision && !podcast.error) return
    const controller = new AbortController()
    setPodcast({ loading: true, error: '', blocks: [], quickEntries: [], cursor: '', hasMore: false, loadingMore: false })
    // 播客 Tab 的真实数据源是无限流接口（DRAGONBALL 固定入口 + 内容区块），
    // 不是 podcast/home/tab/v2（那是另一套页面结构）。见 docs/netease-discover-reverse-2026-09-13.md
    void fetchNeteasePodcastInfinite('', true, controller.signal)
      .then(payload => {
        if (controller.signal.aborted) return
        const home = normalizeNeteasePodcastHome(payload)
        const cursorRaw = payload?.data?.cursor
        const cursor = cursorRaw ? (typeof cursorRaw === 'string' ? cursorRaw : JSON.stringify(cursorRaw)) : ''
        podcastRevisionRef.current = refreshRevision
        setPodcast({ loading: false, error: '', blocks: home.blocks, quickEntries: home.quickEntries, cursor, hasMore: payload?.data?.hasMore !== false && Boolean(cursor), loadingMore: false })
      })
      .catch(error => {
        if (!controller.signal.aborted) setPodcast({ loading: false, error: error instanceof Error ? error.message : '播客加载失败', blocks: [], quickEntries: [], cursor: '', hasMore: false, loadingMore: false })
      })
    return () => controller.abort()
  }, [tab, refreshRevision])

  const loadMorePodcast = useCallback(async () => {
    if (!podcast.cursor || podcast.loadingMore) return
    setPodcast(previous => ({ ...previous, loadingMore: true }))
    try {
      const payload = await fetchNeteasePodcastInfinite(podcast.cursor)
      const home = normalizeNeteasePodcastHome(payload)
      const cursorRaw = payload?.data?.cursor
      const cursor = cursorRaw ? (typeof cursorRaw === 'string' ? cursorRaw : JSON.stringify(cursorRaw)) : ''
      setPodcast(previous => {
        const seen = new Set(previous.blocks.map(block => block.blockCode))
        const additions = home.blocks.filter(block => {
          if (seen.has(block.blockCode)) return false
          seen.add(block.blockCode)
          return true
        })
        return { ...previous, blocks: [...previous.blocks, ...additions], cursor, hasMore: payload?.data?.hasMore !== false && Boolean(cursor) && additions.length > 0, loadingMore: false }
      })
    } catch (error) {
      setPodcast(previous => ({ ...previous, loadingMore: false, error: error instanceof Error ? error.message : '加载更多播客失败' }))
    }
  }, [podcast.cursor, podcast.loadingMore])

  const loadMoreSquare = useCallback(async () => {
    const current = contents[PLAYLIST_CHANNEL]
    if (!current || current.loadingMore || !current.hasMore) return
    setContents(previous => ({ ...previous, [PLAYLIST_CHANNEL]: { ...current, loadingMore: true } }))
    try {
      const payload = await fetchNeteasePlaylistSquare('推荐', current.squareOffset, SQUARE_PAGE_SIZE)
      const additions = normalizeNeteaseSquareBlocks(payload)
      setContents(previous => {
        const base = previous[PLAYLIST_CHANNEL] || EMPTY_CONTENT
        const seen = new Set(base.blocks.map(block => `${block.blockCode}:${block.resources[0]?.id || ''}`))
        const merged = [...base.blocks]
        for (const block of additions) {
          const key = `${block.blockCode}:${block.resources[0]?.id || ''}`
          if (seen.has(key)) continue
          seen.add(key)
          merged.push(block)
        }
        return { ...previous, [PLAYLIST_CHANNEL]: { ...base, blocks: merged, squareOffset: base.squareOffset + SQUARE_PAGE_SIZE, hasMore: payload?.data?.hasMore !== false, loadingMore: false } }
      })
    } catch (error) {
      setContents(previous => ({ ...previous, [PLAYLIST_CHANNEL]: { ...(previous[PLAYLIST_CHANNEL] || EMPTY_CONTENT), loadingMore: false, error: error instanceof Error ? error.message : '加载更多失败' } }))
    }
  }, [contents])

  const musicContent = contents[activeCode] || EMPTY_CONTENT
  const cubeTabs = musicContent.cubeTabs
  const showCubeTabs = cubeTabs.length > 1
  const visibleBlocks = showCubeTabs ? (cubeTabs[activeCubeTab]?.blocks || []) : musicContent.blocks

  const fmRequestedRef = useRef(new Set<string>())
  useEffect(() => {
    if (tab !== MUSIC_TAB || !activeChannel) return
    if (musicContent.cubeTabs.length === 0) return
    const code = activeChannel.code
    if (fmRequestedRef.current.has(code)) return
    fmRequestedRef.current.add(code)
    const fmResource = musicContent.cubeTabs.flatMap(cubeTab => cubeTab.blocks).flatMap(block => block.resources)
      .find(resource => resource.action.type === 'fm')
    const mode = fmResource && fmResource.action.type === 'fm' ? fmResource.action.fmMode : 'DEFAULT'
    const subMode = fmResource && fmResource.action.type === 'fm' ? fmResource.action.subMode : ''
    const controller = new AbortController()
    setFmExtra(previous => ({ ...previous, [code]: { songs: [], loading: true, mode, subMode } }))
    void fetchNeteaseRoam(controller.signal, { mode, subMode, limit: 30 })
      .then(songs => { if (!controller.signal.aborted) setFmExtra(previous => ({ ...previous, [code]: { songs, loading: false, mode, subMode } })) })
      .catch(() => { if (!controller.signal.aborted) setFmExtra(previous => ({ ...previous, [code]: { songs: [], loading: false, mode, subMode } })) })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeChannel, musicContent.cubeTabs])

  // 一级 Tab 切换回到顶部（不重挂载子树）
  useEffect(() => {
    scrollContainer()?.scrollTo({ top: 0, behavior: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const loadMoreFm = useCallback(async () => {
    if (!activeChannel) return
    const code = activeChannel.code
    const current = fmExtra[code]
    if (!current || current.loading) return
    setFmExtra(previous => ({ ...previous, [code]: { ...current, loading: true } }))
    try {
      const songs = await fetchNeteaseRoam(undefined, { mode: current.mode, subMode: current.subMode, limit: 30, unplaySongIds: current.songs.map(song => song.id) })
      setFmExtra(previous => {
        const base = previous[code] || { songs: [], loading: false, mode: current.mode, subMode: current.subMode }
        const seen = new Set(base.songs.map(song => song.id))
        const additions = songs.filter(song => !seen.has(song.id))
        return { ...previous, [code]: { ...base, songs: [...base.songs, ...additions], loading: false } }
      })
    } catch {
      setFmExtra(previous => ({ ...previous, [code]: { ...current, loading: false } }))
    }
  }, [activeChannel, fmExtra])

  // 音乐 / 播客两个半边都常驻挂载，Tab 切换只切显示（display:none），不再卸载重建、也不重拉数据
  const musicHalfVisible = tab === MUSIC_TAB && !openCubeVisible
  const podcastHomeVisible = tab === PODCAST_TAB && !openCubeVisible && !podcastViewVisible
  const podcastPageVisible = tab === PODCAST_TAB && !openCubeVisible && podcastViewVisible

  const activeFm = activeChannel ? fmExtra[activeChannel.code] : undefined
  const fmBlock = activeFm && activeFm.songs.length > 0
    ? {
      id: 'netease-fm-liked',
      blockCode: 'NETEASE_FM_LIKED',
      showType: 'HOMEPAGE_SLIDE_SONGLIST_ALIGN',
      title: '猜你喜欢',
      subtitle: '',
      resources: activeFm.songs.map((song, index) => normalizeNeteaseResource({ resourceId: song.id, resourceType: 'song', songData: song }, index)).filter((item): item is NeteaseNativeResource => Boolean(item)),
      raw: {},
    } as NeteaseNativeBlock
    : null

  return (
    <div key={navKey} className="space-y-5 pb-40 [animation:netease-level-in_.22s_ease-out]">
      {/* 音乐半边：切到播客只隐藏、不卸载（卡片与横向滚动位置都保留，也不会重建 DOM） */}
      <div className={musicHalfVisible ? 'contents' : 'hidden'} aria-hidden={!musicHalfVisible}>
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 text-xs font-medium text-white/40"><Compass className="h-4 w-4" style={{ color: accent }} />网易云音乐频道</span>
            <button
              type="button"
              onClick={() => { setContents({}); fmRequestedRef.current.clear(); setFmExtra({}); setRefreshRevision(revision => revision + 1) }}
              className="ml-auto flex h-8 items-center gap-2 rounded-full border border-white/[0.1] px-3 text-xs text-white/55 transition hover:text-white/85"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${musicContent.loading ? 'animate-spin' : ''}`} />刷新
            </button>
          </div>
          {channelsLoading && channels.length === 0
            ? <div className="flex gap-2 overflow-hidden">{Array.from({ length: 10 }).map((_, index) => <span key={index} className="h-8 w-16 shrink-0 animate-pulse rounded-full bg-white/[0.06]" />)}</div>
            : channelsError && channels.length === 0
              ? <p className="text-sm text-rose-200/80">{channelsError}</p>
              : (
                <div className="flex items-center gap-2">
                  <div className={`flex gap-2 ${channelsExpanded ? 'flex-wrap' : 'overflow-x-auto'} pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`}>
                    {(channelsExpanded ? channels : channels.slice(0, 14)).map(channel => (
                      <button
                        key={channel.code}
                        type="button"
                        onClick={() => { setActiveCode(channel.code); navigate('top') }}
                        className={`h-8 shrink-0 rounded-full px-4 text-sm transition ${activeCode === channel.code ? 'bg-white text-black' : 'bg-white/[0.06] text-white/60 hover:bg-white/[0.12] hover:text-white/90'}`}
                        aria-pressed={activeCode === channel.code}
                      >
                        {channel.title}
                      </button>
                    ))}
                    {channelsError && <span className="shrink-0 self-center text-xs text-amber-200/70">{channelsError}</span>}
                  </div>
                  {channels.length > 14 && (
                    <button
                      type="button"
                      onClick={() => setChannelsExpanded(expanded => !expanded)}
                      aria-label={channelsExpanded ? '收起频道' : '展开全部频道'}
                      aria-expanded={channelsExpanded}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/45 transition hover:bg-white/[0.08] hover:text-white/85"
                    >
                      {channelsExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  )}
                </div>
              )}
        </div>

        {musicContent.vip && (
          <NeteaseVipView data={musicContent.vip} callbacks={callbacks} />
        )}

        {showCubeTabs && (
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="频道分区">
            {cubeTabs.map((cubeTab, index) => (
              <button
                key={cubeTab.key}
                type="button"
                onClick={() => setActiveCubeTab(index)}
                className={`h-8 shrink-0 rounded-full px-4 text-sm transition ${activeCubeTab === index ? 'bg-[var(--explore-accent)]/20 text-white ring-1 ring-[var(--explore-accent)]/50' : 'text-white/50 hover:bg-white/[0.08] hover:text-white/85'}`}
                aria-pressed={activeCubeTab === index}
              >
                {cubeTab.title}
              </button>
            ))}
          </div>
        )}

        {musicContent.error && (
          <div role="alert" className="flex items-center gap-3 rounded-md border border-rose-500/25 bg-rose-500/[0.08] px-4 py-3 text-sm">
            <AlertCircle className="h-4 w-4 text-rose-400" />{musicContent.error}
          </div>
        )}

        {musicContent.loading && visibleBlocks.length === 0
          ? <div className="space-y-8"><div className="h-6 w-40 animate-pulse rounded bg-white/[0.06]" /><div className="flex gap-4 overflow-hidden">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="aspect-square w-44 shrink-0 animate-pulse rounded-md bg-white/[0.055]" />)}</div></div>
          : (
            <div className="space-y-12">
              {visibleBlocks.map((block, index) => (
                <NeteaseNativeBlockView key={`${block.blockCode}-${block.id}-${index}`} block={block} callbacks={callbacks} />
              ))}
              {!musicContent.error && visibleBlocks.length === 0 && (
                <p className="py-10 text-center text-sm text-white/38">
                  {showCubeTabs
                    ? `「${cubeTabs[activeCubeTab]?.title || ''}」分区内容需在网易云 App 内加载`
                    : (activeChannel?.title ? `「${activeChannel.title}」暂无内容` : '暂无内容')}
                </p>
              )}
              {activeCode === PLAYLIST_CHANNEL && musicContent.hasMore && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    disabled={musicContent.loadingMore}
                    onClick={() => void loadMoreSquare()}
                    className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] px-5 text-sm text-white/65 transition hover:bg-white/[0.08] disabled:opacity-50"
                  >
                    {musicContent.loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}加载更多歌单
                  </button>
                </div>
              )}
              {fmBlock && (
                <div className="space-y-6">
                  <NeteaseNativeBlockView block={fmBlock} callbacks={callbacks} />
                  <div className="flex justify-center">
                    <button
                      type="button"
                      disabled={activeFm?.loading}
                      onClick={() => void loadMoreFm()}
                      className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] px-5 text-sm text-white/65 transition hover:bg-white/[0.08] disabled:opacity-50"
                    >
                      {activeFm?.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}换一批猜你喜欢
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
      </div>

      {/* 播客半边：同理保持挂载，切回音乐不卸载 */}
      <div className={podcastHomeVisible ? 'contents' : 'hidden'} aria-hidden={!podcastHomeVisible}>
        {podcast.quickEntries.length > 0 && (
          <div className="flex flex-wrap items-center gap-2" aria-label="播客快捷入口">
            <button
              type="button"
              onClick={() => { setContents({}); setRefreshRevision(revision => revision + 1) }}
              className="ml-auto order-last flex h-8 items-center gap-2 rounded-full border border-white/[0.1] px-3 text-xs text-white/55 transition hover:text-white/85"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${podcast.loading ? 'animate-spin' : ''}`} />刷新
            </button>
            {podcast.quickEntries.map((entry, index) => {
              // 「我的播客」等入口依赖 App 内 RN 页面，WaveForge 无法直达，禁用而不是静默失败
              const usable = entry.action.type !== 'none'
              return (
                <button
                  key={`${entry.id}-${index}`}
                  type="button"
                  disabled={!usable}
                  title={usable ? entry.title : `${entry.title}（需在网易云 App 内打开）`}
                  onClick={() => {
                    if (entry.action.type === 'podcast-categories') { navigate('push'); setPodcastView(previous => previous?.kind === 'categories' ? previous : { kind: 'categories' }); setPodcastViewVisible(true); return }
                    if (entry.action.type === 'podcast-mine') { navigate('push'); setPodcastView(previous => previous?.kind === 'mine' ? previous : { kind: 'mine' }); setPodcastViewVisible(true); return }
                    callbacks.onExecute(entry, podcast.quickEntries)
                  }}
                  className={`flex h-9 items-center gap-2 rounded-full border border-white/[0.09] bg-white/[0.04] pl-1.5 pr-4 text-sm transition ${usable ? 'text-white/70 hover:bg-white/[0.1] hover:text-white/95' : 'cursor-not-allowed text-white/30'}`}
                >
                  {entry.coverUrl
                    ? <img src={entry.coverUrl} alt="" className="h-6 w-6 rounded-full object-cover" loading="lazy" />
                    : <Headphones className="h-4 w-4" />}
                  <span className="max-w-32 truncate">{entry.title}</span>
                </button>
              )
            })}
          </div>
        )}

        {podcast.error && (
          <div role="alert" className="flex items-center gap-3 rounded-md border border-rose-500/25 bg-rose-500/[0.08] px-4 py-3 text-sm">
            <AlertCircle className="h-4 w-4 text-rose-400" />{podcast.error}
          </div>
        )}

        {podcast.loading && podcast.blocks.length === 0
          ? <div className="space-y-8"><div className="h-6 w-40 animate-pulse rounded bg-white/[0.06]" /><div className="flex gap-4 overflow-hidden">{Array.from({ length: 6 }).map((_, index) => <div key={index} className="aspect-square w-44 shrink-0 animate-pulse rounded-md bg-white/[0.055]" />)}</div></div>
          : (
            <div className="space-y-12">
              {podcast.blocks.map((block, index) => (
                <NeteaseNativeBlockView key={`${block.blockCode}-${block.id}-${index}`} block={block} callbacks={callbacks} />
              ))}
              {!podcast.error && podcast.blocks.length === 0 && <p className="py-10 text-center text-sm text-white/38">暂无播客推荐</p>}
              {podcast.hasMore && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    disabled={podcast.loadingMore}
                    onClick={() => void loadMorePodcast()}
                    className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] px-5 text-sm text-white/65 transition hover:bg-white/[0.08] disabled:opacity-50"
                  >
                    {podcast.loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}加载更多播客
                  </button>
                </div>
              )}
            </div>
          )}
      </div>

      {openCube && (
        <div className={openCubeVisible ? 'contents' : 'hidden'} aria-hidden={!openCubeVisible}>
          <NeteaseCubePageView pageId={openCube.pageId} title={openCube.title} callbacks={callbacks} onBack={() => { navigate('restore'); setOpenCubeVisible(false) }} />
        </div>
      )}

      {podcastView && (
        <div className={podcastPageVisible ? 'contents' : 'hidden'} aria-hidden={!podcastPageVisible}>
          <NeteasePodcastPages
            view={podcastView}
            accountUserId={accountUserId}
            callbacks={callbacks}
            onBack={() => { navigate('restore-home'); setPodcastViewVisible(false) }}
            onOpenCategory={(id, name) => { navigate('push'); setPodcastView(previous => previous && previous.kind === 'category' && previous.id === id ? previous : { kind: 'category', id, name }); setPodcastViewVisible(true) }}
          />
        </div>
      )}
    </div>
  )
}
