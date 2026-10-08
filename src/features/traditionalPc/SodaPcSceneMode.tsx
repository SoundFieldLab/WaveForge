// 汽水音乐 PC 客户端「听歌模式」（/scene-mode）复刻。
//
// 版式取自客户端 src/renderer/pages/SceneMode.vue + FeedModeItem.vue + DiscoverMixItem.vue：
//   页标题「听歌模式」
//   ├ 常用模式：48px 高横向胶囊（图标 16 + 文案 14px），列宽约 187px 自适应，卡片间距 16
//   │           当前正在播的模式把图标换成声波；悬停浮出播放三角
//   └ 探索更多新模式：封面 3:2 卡片，底部渐隐蒙层压标题（16px 粗体）+ 描述，底色取上游给的 rgb，
//                     悬停压暗并浮播放键；支持「加载更多」
//
// 数据来自 /api/soda/feed-mode（FeedMode）与 /api/soda/discover/mix（DiscoverView + DiscoverMix），
// 点模式后的拉流由调用方（TraditionalView）走 fetchSodaSceneTracks（FeedSongTab + feed_preference）。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Music2, Pause, Play, Radio, Waves } from 'lucide-react'
import { getProxiedImageUrl } from '../../services/musicApi'
import {
  fetchSodaDiscoverMix,
  fetchSodaFeedModes,
  type SodaDiscoverMixItem,
  type SodaSceneMode,
} from '../../services/sodaService'
import type { PcTone } from './pcKit'

export interface SodaPcSceneModeProps {
  tone: PcTone
  accent: string
  loggedIn: boolean
  /** 当前正在播的场景 sub_queue_type（高亮 + 声波） */
  activeSubQueueType?: string
  /** 当前正在播的探索卡片 resource_id */
  activeResourceId?: string
  isPlaying?: boolean
  onPlayScene: (mode: SodaSceneMode) => void
  onToggleScenePlayback?: () => void
  onOpenDiscoverItem: (item: SodaDiscoverMixItem) => void
  onLoginClick?: () => void
}

function SodaPcSceneMode({
  tone, accent, loggedIn, activeSubQueueType, activeResourceId, isPlaying,
  onPlayScene, onToggleScenePlayback, onOpenDiscoverItem, onLoginClick,
}: SodaPcSceneModeProps) {
  const dark = tone === 'dark'
  const [modes, setModes] = useState<SodaSceneMode[]>([])
  const [modesLoading, setModesLoading] = useState(true)
  const [items, setItems] = useState<SodaDiscoverMixItem[]>([])
  const [itemsLoading, setItemsLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [error, setError] = useState('')
  const gridRef = useRef<HTMLDivElement>(null)
  // 列宽约 187px（客户端 SceneMode.vue 的 resizeHandler 同款算法：floor((width-48)/187)）
  const [columns, setColumns] = useState(4)

  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const measure = () => {
      const width = el.clientWidth
      if (width) setColumns(Math.max(2, Math.floor((width - 48) / 187)))
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(el)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    if (!loggedIn) { setModesLoading(false); setItemsLoading(false); return }
    let cancelled = false
    void fetchSodaFeedModes()
      .then(result => { if (!cancelled) setModes(result.modes) })
      .catch(() => { if (!cancelled) setError('听歌模式加载失败') })
      .finally(() => { if (!cancelled) setModesLoading(false) })
    void fetchSodaDiscoverMix()
      .then(result => {
        if (cancelled) return
        setItems(result.items)
        setHasMore(result.hasMore)
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setItemsLoading(false) })
    return () => { cancelled = true }
  }, [loggedIn])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const exposure = items.map(item => item.innerBlockId).filter(Boolean)
      const result = await fetchSodaDiscoverMix({ exposure })
      setItems(prev => {
        const seen = new Set(prev.map(item => item.innerBlockId))
        return prev.concat(result.items.filter(item => !seen.has(item.innerBlockId)))
      })
      setHasMore(result.hasMore)
    } catch {
      setHasMore(false)
    } finally {
      setLoadingMore(false)
    }
  }, [hasMore, items, loadingMore])

  const muted = dark ? 'text-white/50' : 'text-slate-500'
  const text = dark ? 'text-white' : 'text-slate-900'
  const sectionTitle = dark ? 'rgba(255,255,255,.5)' : 'rgba(15,23,42,.5)'
  const pillBg = dark ? 'rgba(255,255,255,.07)' : 'rgba(15,23,42,.05)'
  const pillActiveBg = dark ? '#fff' : '#111'
  const pillActiveText = dark ? '#111' : '#fff'

  const modeGridStyle = useMemo(
    () => ({ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 16 }),
    [columns],
  )
  const cardGridStyle = useMemo(
    () => ({ display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 16 }),
    [columns],
  )

  if (!loggedIn) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Waves className={`h-8 w-8 opacity-30 ${text}`} />
        <p className={`text-sm ${muted}`}>登录汽水音乐后使用听歌模式</p>
        {onLoginClick && (
          <button type="button" onClick={onLoginClick} className="rounded-full px-5 py-2 text-sm font-medium text-white" style={{ background: accent }}>
            立即登录
          </button>
        )}
      </div>
    )
  }

  return (
    <div ref={gridRef} data-soda-pc-scene="" className="min-h-0 overflow-y-auto">
      <div className={`text-2xl font-semibold ${text}`}>听歌模式</div>

      {/* 常用模式 */}
      <div className="mt-6">
        <div className="mb-3 text-[13px] font-medium" style={{ color: sectionTitle }}>常用模式</div>
        {modesLoading ? (
          <div style={modeGridStyle}>
            {Array.from({ length: columns * 2 }, (_, i) => (
              <div key={i} className="h-12 animate-pulse rounded-xl" style={{ background: pillBg }} />
            ))}
          </div>
        ) : (
          <div style={modeGridStyle}>
            {modes.map(mode => {
              const active = !!activeSubQueueType && activeSubQueueType === mode.subQueueType
              return (
                <button
                  key={mode.subQueueType || mode.text}
                  type="button"
                  onClick={() => { if (active && onToggleScenePlayback) onToggleScenePlayback(); else onPlayScene(mode) }}
                  className="group flex h-12 items-center gap-2 rounded-xl px-3 text-left transition"
                  style={{ background: active ? pillActiveBg : pillBg, color: active ? pillActiveText : undefined }}
                  onMouseEnter={event => { if (!active) event.currentTarget.style.background = dark ? 'rgba(255,255,255,.12)' : 'rgba(15,23,42,.09)' }}
                  onMouseLeave={event => { if (!active) event.currentTarget.style.background = pillBg }}
                >
                  {/* 正在播的模式显示声波；悬停显示播放/暂停；其余显示场景图标 */}
                  {active ? (
                    <Waves className="h-4 w-4 shrink-0" style={{ color: active ? pillActiveText : accent }} />
                  ) : (
                    <>
                      <span className="group-hover:hidden">
                        {mode.iconUrl
                          ? <img src={getProxiedImageUrl(mode.iconUrl, 40)} alt="" className="h-4 w-4 shrink-0" />
                          : <Music2 className="h-4 w-4 shrink-0 opacity-70" />}
                      </span>
                      <span className="hidden group-hover:block">
                        {active && isPlaying ? <Pause className="h-4 w-4 shrink-0" /> : <Play className="h-4 w-4 shrink-0" />}
                      </span>
                    </>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{mode.text}</span>
                </button>
              )
            })}
          </div>
        )}
        {error && <p className={`mt-2 text-xs ${muted}`}>{error}</p>}
      </div>

      {/* 探索更多新模式 */}
      <div className="mt-8">
        <div className="mb-3 text-[13px] font-medium" style={{ color: sectionTitle }}>探索更多新模式</div>
        {itemsLoading ? (
          <div style={cardGridStyle}>
            {Array.from({ length: columns }, (_, i) => (
              <div key={i} className="animate-pulse rounded-xl" style={{ aspectRatio: '3 / 2', background: pillBg }} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className={`py-6 text-center text-xs ${muted}`}>暂时没有更多场景</p>
        ) : (
          <div style={cardGridStyle}>
            {items.map(item => {
              const active = !!activeResourceId && activeResourceId === item.resourceId
              return (
                <button
                  key={item.innerBlockId || item.resourceId}
                  type="button"
                  onClick={() => onOpenDiscoverItem(item)}
                  className="group relative overflow-hidden rounded-xl text-left transition"
                  style={{ aspectRatio: '3 / 2', background: item.backgroundColor || pillBg }}
                >
                  {item.coverUrl && (
                    <img
                      src={getProxiedImageUrl(item.coverUrl, 400)}
                      alt={`${item.title}封面`}
                      className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.03]"
                    />
                  )}
                  {/* 底部渐隐，保证标题在浅色封面上也读得清（客户端 DiscoverMixItem 同款） */}
                  <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(0,0,0,0) 35%, rgba(0,0,0,.62) 100%)' }} />
                  <span className="absolute inset-x-0 bottom-0 p-3">
                    <span className="block truncate text-[16px] font-bold text-white">{item.title}</span>
                    {item.desc && <span className="mt-0.5 block truncate text-[12px] text-white/75">{item.desc}</span>}
                  </span>
                  <span className="absolute left-2 top-2 flex items-center gap-1">
                    {item.type === 'radio' && <Radio className="h-3.5 w-3.5 text-white/85" />}
                    {active && <Waves className="h-3.5 w-3.5 text-white" />}
                  </span>
                  <span className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-900 opacity-0 shadow-lg transition group-hover:opacity-100">
                    <Play className="h-4 w-4 fill-current" />
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {hasMore && items.length > 0 && (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => { void loadMore() }}
              disabled={loadingMore}
              className={`flex items-center gap-2 rounded-full px-5 py-2 text-xs disabled:opacity-50 ${muted}`}
              style={{ background: pillBg }}
            >
              {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {loadingMore ? '加载中…' : '加载更多'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default memo(SodaPcSceneMode)
