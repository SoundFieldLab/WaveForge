// 网易云音乐 PC 客户端「播客」页复刻（传统模式中栏）。
//
// 官方播客 Tab 结构（podcast/home/tab/v2/get 的 blockVOS）：
//   顶部固定入口（FINITE_DRAGONBALL：我的播客/全部分类/音乐播客/排行榜…）
//   → 上新佳作（NEWCOMER_HOT_PODCAST）→ 为你推荐（RCMD_FOR_YOU）→ 热门播客（HOTTEST_VOICELIST_BLOCK）
//   → 音乐播客榜（FINITE_CHARTS_BLOCK，带名次）→ 探索更多（DISCOVER_MORE_VOICE_BLOCK）
//   → 分类 chips（真实分类接口，19 个一级分类）→ 选中分类出该分类电台，未选中出「猜你喜欢」（无限流）。
// 区块标题官方走客户端模板（服务端不下发 DSL 标题），这里按 blockCode 映射实机文案。
// 播客电台在 WaveForge 内走歌单通道打开（电台详情由歌单页渲染），节目则直接播放。
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Play } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import {
  fetchNeteaseProgramSong,
} from '../neteaseExplore/api'
import {
  fetchNeteasePodcastCategories, fetchNeteasePodcastCategoryRadios, fetchNeteasePodcastHome,
  fetchNeteasePodcastInfinite, normalizeNeteasePodcastBlocks, normalizeNeteasePodcastHome,
  type NeteasePodcastCategory,
} from '../neteaseExplore/discover'
import {
  neteaseResourceArtwork, neteaseResourceKey, type NeteaseNativeBlock, type NeteaseNativeResource,
} from '../neteaseExplore/model'
import {
  PcCountBadge, PcCover, PcEmpty, PcNoticeBar, PcSectionTitle, pcTheme,
  type PcCardItem, type PcTheme, type PcTone,
} from './pcKit'
import type { PcAccount, PcActions } from './types'

export interface NeteasePcPageProps {
  chrome: { tone: PcTone; skin: 'netease'; accent: string }
  account: PcAccount
  actions: PcActions
  authRevision?: number
  active?: boolean
  currentSongKey?: string
  currentSong?: Song | null
}

/** 播客首页 blockCode → 官方实机标题（服务端不下发，按 9.5.90 实机映射）。 */
const PODCAST_BLOCK_TITLES: Record<string, string> = {
  NEWCOMER_HOT_PODCAST: '上新佳作',
  RCMD_FOR_YOU: '为你推荐',
  HOTTEST_VOICELIST_BLOCK: '热门播客',
  FINITE_CHARTS_BLOCK: '音乐播客榜',
  DISCOVER_MORE_VOICE_BLOCK: '探索更多',
  GUESS_LIKE: '猜你喜欢',
}

/** 面板封面卡：封面 + 序号 + 1~2 行标题（官方播客面板同款）。 */
function PodcastPanel({ theme, accent, title, resources, loading, onOpen, ranked = false }: {
  theme: PcTheme
  accent: string
  title: string
  resources: NeteaseNativeResource[]
  loading: boolean
  onOpen: (resource: NeteaseNativeResource) => void
  ranked?: boolean
}) {
  return (
    <section className="mb-8">
      <PcSectionTitle title={title} theme={theme} />
      {loading ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => <span key={`panel-skeleton:${title}:${index}`} className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />)}
        </div>
      ) : resources.length > 0 ? (
        <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-4 lg:grid-cols-6">
          {resources.map((resource, index) => (
            <button
              key={`panel:${neteaseResourceKey(resource)}:${index}`}
              type="button"
              onClick={() => onOpen(resource)}
              onContextMenu={event => event.preventDefault()}
              className="group block text-left"
            >
              <PcCover
                src={neteaseResourceArtwork(resource)}
                alt={resource.title || '播客'}
                eager={index < 4}
                className="aspect-square w-full"
                rounded="rounded-lg"
                overlay={(
                  <>
                    <PcCountBadge value={resource.playCount} />
                    {ranked && (
                      <span className="pointer-events-none absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/45 text-[12px] font-semibold text-white/95 backdrop-blur-sm">
                        {index + 1}
                      </span>
                    )}
                    <span className="absolute bottom-2 right-2 flex h-7 w-7 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                      <Play className="h-3 w-3 fill-current" style={{ color: accent }} />
                    </span>
                  </>
                )}
              />
              <span className="mt-2 flex gap-1 text-[11px] leading-snug">
                {ranked && <span className={`shrink-0 tabular-nums ${theme.faint}`}>{index + 1}</span>}
                <span className={`line-clamp-2 ${theme.text}`}>{resource.title || '播客'}</span>
              </span>
              {resource.subtitle ? <span className={`mt-0.5 line-clamp-1 text-[11px] ${theme.faint}`}>{resource.subtitle}</span> : null}
            </button>
          ))}
        </div>
      ) : (
        <p className={`py-8 text-center text-[12px] ${theme.faint}`}>暂无内容</p>
      )}
    </section>
  )
}

function NeteasePcPodcast({ chrome, actions, active = true, authRevision = 0 }: NeteasePcPageProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent

  const [blocks, setBlocks] = useState<NeteaseNativeBlock[]>([])
  const [quickEntries, setQuickEntries] = useState<NeteaseNativeResource[]>([])
  const [homeLoading, setHomeLoading] = useState(true)
  const [guess, setGuess] = useState<NeteaseNativeResource[]>([])
  const [guessLoading, setGuessLoading] = useState(true)
  const [categories, setCategories] = useState<NeteasePodcastCategory[]>([])
  const [categoryRadios, setCategoryRadios] = useState<NeteaseNativeResource[]>([])
  const [categoryLoading, setCategoryLoading] = useState(false)
  const [activeCategory, setActiveCategory] = useState<{ id: string; label: string } | null>(null)
  /** 选中的二级分类（仅影响标题展示：上游电台接口只吃一级 id，二级无独立数据） */
  const [activeSubCategory, setActiveSubCategory] = useState<{ id: string; name: string } | null>(null)
  const [showAllChips, setShowAllChips] = useState(false)
  const [notice, setNotice] = useState('')

  // 播客主页（blockVOS：上新佳作 / 龙珠入口 / 为你推荐 / 热门播客 / 音乐播客榜 / 探索更多）
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setHomeLoading(true)
    fetchNeteasePodcastHome(controller.signal)
      .then(payload => {
        if (controller.signal.aborted) return
        // discover 的 fetch 返回原始 payload：blockVOS → 区块 + 龙珠入口要在这里归一化
        const home = normalizeNeteasePodcastHome(payload)
        setBlocks(home.blocks)
        setQuickEntries(home.quickEntries)
      })
      .catch(() => { if (!controller.signal.aborted) { setBlocks([]); setQuickEntries([]) } })
      .finally(() => { if (!controller.signal.aborted) setHomeLoading(false) })
    return () => controller.abort()
  }, [active, authRevision])

  // 播客无限流：「猜你喜欢」的数据源（GUESS_LIKE 块优先，否则全量兜底）
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    setGuessLoading(true)
    fetchNeteasePodcastInfinite('', true, controller.signal)
      .then(payload => {
        if (controller.signal.aborted) return
        const flowBlocks = normalizeNeteasePodcastBlocks(payload)
        const guessBlock = flowBlocks.find(block => /GUESS_LIKE/i.test(block.blockCode))
        const list = (guessBlock?.resources.length ? guessBlock.resources : flowBlocks.flatMap(block => block.resources))
        const seen = new Set<string>()
        setGuess(list.filter(resource => {
          const key = neteaseResourceKey(resource)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        }).slice(0, 24))
      })
      .catch(() => { if (!controller.signal.aborted) setGuess([]) })
      .finally(() => { if (!controller.signal.aborted) setGuessLoading(false) })
    return () => controller.abort()
  }, [active, authRevision])

  // 播客分类（chips 数据源，一级分类 19 个）
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    fetchNeteasePodcastCategories(controller.signal)
      .then(list => { if (!controller.signal.aborted) setCategories(list) })
      .catch(() => { if (!controller.signal.aborted) setCategories([]) })
    return () => controller.abort()
  }, [active, authRevision])

  // 选中的分类 chips：取该分类下的热门电台（一级分类 id 才有数据）
  useEffect(() => {
    if (!active || !activeCategory?.id) { setCategoryRadios([]); return }
    const controller = new AbortController()
    setCategoryLoading(true)
    fetchNeteasePodcastCategoryRadios(activeCategory.id, 0, 24, controller.signal)
      .then(list => { if (!controller.signal.aborted) setCategoryRadios(list) })
      .catch(() => { if (!controller.signal.aborted) setCategoryRadios([]) })
      .finally(() => { if (!controller.signal.aborted) setCategoryLoading(false) })
    return () => controller.abort()
  }, [active, activeCategory])

  // 电台在 WaveForge 里走歌单通道打开；节目直接播放；两者都没有则提示，不静默失败
  const openResource = useCallback((resource: NeteaseNativeResource) => {
    setNotice('')
    if (resource.playlist?.id) {
      actions.onOpenPlaylist({ ...resource.playlist, coverUrl: resource.playlist.coverUrl || neteaseResourceArtwork(resource), source: 'netease-podcast' })
      return
    }
    if (resource.song?.id) { actions.onPlaySongs(resource.song, [resource.song], 0); return }
    const action = resource.action
    if (action.type === 'program') {
      void fetchNeteaseProgramSong(action.id)
        .then(song => { if (song) actions.onPlaySongs(song, [song], 0); else setNotice('该节目暂无法播放') })
        .catch(() => setNotice('该节目暂无法播放'))
      return
    }
    if (action.type === 'podcast-mine') { actions.onNavigate({ kind: 'netease', page: 'mypodcast' }); return }
    if (action.type === 'podcast-categories' || action.type === 'podcast-section') {
      setActiveCategory(null)
      setShowAllChips(true)
      return
    }
    const radioId = action.type === 'radio' ? action.channel.id : resource.id
    if (radioId) {
      actions.onOpenPlaylist({
        id: String(radioId),
        name: resource.title || '播客',
        coverUrl: neteaseResourceArtwork(resource) || resource.coverUrl,
        description: resource.subtitle || undefined,
        playCount: resource.playCount,
        platform: 'netease',
        source: 'netease-podcast-radio',
      })
      return
    }
    setNotice(`${resource.title || '该内容'}暂不支持在 WaveForge 内打开`)
  }, [actions])

  /** 内容区块：按官方顺序渲染（排除入口块）。 */
  const contentBlocks = useMemo(
    () => blocks.filter(block => !/DRAGONBALL/i.test(block.blockCode) && block.resources.length > 0),
    [blocks],
  )
  const blockTitle = (block: NeteaseNativeBlock) => PODCAST_BLOCK_TITLES[block.blockCode.toUpperCase()] || block.title || ''

  const gridResources = activeCategory ? categoryRadios : guess
  const gridLoading = activeCategory ? categoryLoading : guessLoading
  const cards: PcCardItem[] = useMemo(() => gridResources.map((resource, index) => ({
    key: `${neteaseResourceKey(resource)}:${index}`,
    coverUrl: neteaseResourceArtwork(resource),
    title: resource.title || '播客',
    subtitle: (resource.subtitle || '').trim().slice(0, 40) || undefined,
    playCount: resource.playCount,
    onClick: () => openResource(resource),
  })), [gridResources, openResource])

  // chips：官方播客页一级分类顺序（默认一行 8 个 + 更多∨）
  const visibleChips = showAllChips ? categories : categories.slice(0, 8)
  const hasMoreChips = categories.length > 8
  // 选中分类的二级分类（官方点一级后展开二级列表；二级 id 电台接口无数据，选中二级仍按一级取数）
  const activeSubCategories = useMemo(
    () => categories.find(item => item.id === activeCategory?.id)?.children || [],
    [categories, activeCategory],
  )

  const renderChips = (items: NeteasePodcastCategory[]) => items.map(item => {
    const selected = activeCategory?.id === item.id
    return (
      <button
        key={`chip:${item.id}:${item.name}`}
        type="button"
        onClick={() => {
          if (selected) { setActiveCategory(null); setActiveSubCategory(null); return }
          setActiveCategory({ id: item.id, label: item.name })
          setActiveSubCategory(null)
        }}
        className={`rounded-full px-3.5 py-1.5 text-[13px] transition ${selected ? 'font-medium text-white' : theme.chipIdle}`}
        style={selected ? { background: accent } : undefined}
      >
        {item.name}
      </button>
    )
  })

  /** 二级分类行（官方样式：一级下方的小字页签，选中加强调色；点它只影响标题，数据仍按一级拉）。 */
  const renderSubChips = () => {
    if (!activeCategory || activeSubCategories.length === 0) return null
    return (
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          key="sub:all"
          type="button"
          onClick={() => setActiveSubCategory(null)}
          className={`pb-0.5 text-[13px] transition ${!activeSubCategory ? 'font-semibold' : theme.tabIdle}`}
          style={!activeSubCategory ? { color: accent } : undefined}
        >
          全部
        </button>
        {activeSubCategories.map(child => {
          const selected = activeSubCategory?.id === child.id
          return (
            <button
              key={`sub:${child.id}:${child.name}`}
              type="button"
              onClick={() => setActiveSubCategory({ id: child.id, name: child.name })}
              className={`pb-0.5 text-[13px] transition ${selected ? 'font-semibold' : theme.tabIdle}`}
              style={selected ? { color: accent } : undefined}
            >
              {child.name}
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="pb-6">
      {notice && <PcNoticeBar theme={theme} onClose={() => setNotice('')}>{notice}</PcNoticeBar>}

      {/* 顶部固定入口（龙珠位：我的播客 / 全部分类 / 音乐播客 / 排行榜…官方同款横排卡） */}
      {quickEntries.length > 0 && (
        <section className="mb-8 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {quickEntries.map((entry, index) => (
            <button
              key={`entry:${neteaseResourceKey(entry)}:${index}`}
              type="button"
              onClick={() => openResource(entry)}
              className="group flex flex-col items-center justify-center gap-2 rounded-xl px-2 py-4 transition hover:-translate-y-0.5"
              style={{ background: theme.tone === 'dark' ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.035)' }}
            >
              <PcCover
                src={neteaseResourceArtwork(entry)}
                alt={entry.title || '入口'}
                className="h-10 w-10"
                rounded="rounded-lg"
              />
              <span className={`truncate text-[12px] ${theme.text}`}>{entry.title || '入口'}</span>
            </button>
          ))}
        </section>
      )}

      {/* 官方区块流：上新佳作 → 为你推荐 → 热门播客 → 音乐播客榜（带名次）→ 探索更多 */}
      {contentBlocks.map(block => {
        const title = blockTitle(block)
        const ranked = /CHARTS/i.test(block.blockCode)
        if (!title) return null
        return (
          <PodcastPanel
            key={`podcast-block:${block.id}`}
            theme={theme}
            accent={accent}
            title={title}
            resources={block.resources}
            loading={homeLoading}
            onOpen={openResource}
            ranked={ranked}
          />
        )
      })}

      {/* 分类 chips：官方一级分类 + 更多∨；选中后下方展开二级分类行 */}
      <section className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          {renderChips(visibleChips)}
          {hasMoreChips && (
            <button
              type="button"
              onClick={() => setShowAllChips(value => !value)}
              className={`flex items-center gap-0.5 rounded-full px-3 py-1.5 text-[13px] transition ${theme.chipIdle}`}
            >
              {showAllChips ? '收起' : '更多'}<ChevronDown className={`h-3.5 w-3.5 transition ${showAllChips ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
        {renderSubChips()}
        {categories.length === 0 && !activeCategory && (
          <p className={`mt-2 text-[12px] ${theme.faint}`}>分类加载中，可先看下方推荐</p>
        )}
      </section>

      {/* 选中分类 → 该分类热门电台；未选中 → 猜你喜欢（无限流） */}
      <section>
        <PcSectionTitle title={activeCategory ? `「${activeSubCategory?.name || activeCategory.label}」热门播客` : '猜你喜欢'} theme={theme} />
        {gridLoading ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={`grid-skeleton:${index}`}>
                <span className={`block aspect-square w-full animate-pulse rounded-lg ${theme.surface}`} />
                <span className={`mt-2 block h-3 w-3/4 animate-pulse rounded ${theme.surface}`} />
              </div>
            ))}
          </div>
        ) : cards.length > 0 ? (
          <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
            {cards.map(card => (
              <button key={card.key} type="button" onClick={card.onClick} className="group block text-left">
                <PcCover
                  src={card.coverUrl}
                  alt={card.title}
                  className="aspect-square w-full"
                  rounded="rounded-lg"
                  overlay={(
                    <>
                      <PcCountBadge value={card.playCount} />
                      <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                        <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                      </span>
                    </>
                  )}
                />
                <span className={`mt-2 line-clamp-2 text-[12px] leading-snug ${theme.text}`}>{card.title}</span>
                {card.subtitle ? <span className={`mt-0.5 line-clamp-1 text-[11px] ${theme.faint}`}>{card.subtitle}</span> : null}
              </button>
            ))}
          </div>
        ) : (
          <PcEmpty theme={theme} title={activeCategory ? '该分类暂无播客' : '暂无播客推荐'} description={activeCategory ? '换个分类试试' : undefined} />
        )}
      </section>
    </div>
  )
}

export default memo(NeteasePcPodcast)
