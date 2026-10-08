// 酷狗音乐 PC 客户端「音乐 → 歌单 / 分类」页。
//
// 歌单页 = 分类标签条（上游 6 组标签树）+ 分类歌单网格 + 加载更多；
// 分类页 = 同一标签维度的分组入口（官方「分类」页签本质是标签导航，点进去就是歌单列表，
// 因此点标签后切到歌单页签并选中该标签，与探索页分类板块的处理一致）。
// 上游 /concept/playlist/by-tag 不支持按 tag 过滤（返回推荐池），筛选在客户端按 item.tags 做。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Baby, Car, Clapperboard, Disc3, Drama, Earth, Flame, Flower2, Guitar, Headphones, Heart, Landmark,
  Loader2, Mic2, Music2, Piano, Radio, RefreshCw, Rocket, Smartphone, Star, Users, Wifi, Zap,
  type LucideIcon,
} from 'lucide-react'
import type { ExplorePlaylist, ExplorePayload } from '../../services/exploreApi'
import { fetchKugouPlaylistsByTag } from '../../services/kugouService'
import { PcCover, PcEmpty } from './pcKit'
import { kugouCount, type KugouPcPageContext } from './KugouPcShared'
import KugouPcChannelDetail from './KugouPcChannelDetail'

export interface KugouPcPlaylistsProps {
  ctx: KugouPcPageContext
  payload: ExplorePayload | null
  selectedTag: string | null
  onSelectTag: (tag: string | null) => void
}

/** 官方「热门分类」的图标映射（官方是圆形线性图标 + 名称；名字对不上的用音符兜底）。 */
const HOT_TAG_ICONS: Record<string, LucideIcon> = {
  dj: Disc3,
  经典: Landmark,
  儿童: Baby,
  车载: Car,
  网络: Wifi,
  短视频热歌: Smartphone,
  纯音乐: Piano,
  欧美: Earth,
  情歌: Heart,
  国风: Flower2,
  电音: Zap,
  韩流: Star,
  戏曲: Drama,
  广场舞: Users,
  影视: Clapperboard,
  首发: Rocket,
  流行: Flame,
  摇滚: Guitar,
  民谣: Guitar,
  逛唱: Mic2,
  翻唱: Mic2,
  怀旧: Radio,
}

function hotTagIcon(name: string): LucideIcon {
  return HOT_TAG_ICONS[name.toLowerCase()] || HOT_TAG_ICONS[name] || Music2
}

/** 官方「热门分类」16 项（顺序按官方截图）→ IP 专区名。
 *  官方这组入口点进去是频道内容页（实测：情歌 → 频道页「情歌」单曲 9418/视频 40；DJ → DJ 频道页），
 *  所以映射到 /v1/zone/index 的专区、按 IP 打开页内频道详情，而不是按标签筛歌单。
 *  官方名与专区名不完全一致：经典 ↔ 经典老歌、短视频热歌 ↔ 抖音、首发 ↔ 首发专区。 */
const HOT_CATEGORY_ZONES: Array<{ label: string; zone: string }> = [
  { label: 'DJ', zone: 'DJ' },
  { label: '经典', zone: '经典老歌' },
  { label: '儿童', zone: '儿童' },
  { label: '车载', zone: '车载' },
  { label: '网络', zone: '网络' },
  { label: '短视频热歌', zone: '抖音' },
  { label: '纯音乐', zone: '纯音乐' },
  { label: '欧美', zone: '欧美' },
  { label: '情歌', zone: '情歌' },
  { label: '国风', zone: '国风' },
  { label: '电音', zone: '电音' },
  { label: '韩流', zone: '韩流' },
  { label: '戏曲', zone: '戏曲' },
  { label: '广场舞', zone: '广场舞' },
  { label: '影视', zone: '影视' },
  { label: '首发', zone: '首发专区' },
]

interface KugouZone { id: string; name: string; icon: string; summary?: string; ipId: string; link?: string }

/** 分类页：官方同款「热门分类」16 入口（进频道页）+ 标签树分组入口（进歌单页签） */
export function KugouPcCategories({ ctx, payload, onSelectTag }: KugouPcPlaylistsProps) {
  const theme = ctx.theme
  const accent = ctx.accent
  const groups = payload?.kugou?.tagGroups || []
  const [activeGroup, setActiveGroup] = useState<string>(groups[0]?.id || '')
  const [zones, setZones] = useState<KugouZone[]>([])
  const [openedChannel, setOpenedChannel] = useState('')

  useEffect(() => {
    if (groups.length && !groups.some(group => group.id === activeGroup)) setActiveGroup(groups[0].id)
  }, [groups, activeGroup])

  // 热门分类的落点是频道专区，独立拉取（公开数据源、无需登录）
  useEffect(() => {
    let cancelled = false
    void import('../../services/kugouService')
      .then(m => m.fetchKugouChannelZones())
      .then(list => { if (!cancelled) setZones(list as KugouZone[]) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  const current = groups.find(group => group.id === activeGroup) || groups[0]

  const hotCategories = useMemo(() => {
    if (!zones.length) return []
    const byName = new Map(zones.map(zone => [zone.name, zone]))
    return HOT_CATEGORY_ZONES
      .map(item => {
        const zone = byName.get(item.zone)
        return zone ? { label: item.label, ipId: String(zone.ipId || zone.id) } : null
      })
      .filter((item): item is { label: string; ipId: string } => Boolean(item && item.ipId))
  }, [zones])

  // 官方「热门分类」是固定 16 项；专区接口不可用时退回标签树里真实存在的同名标签，不伪造
  const HOT_TAG_NAMES = ['DJ', '经典', '儿童', '车载', '网络', '短视频热歌', '纯音乐', '欧美', '情歌', '国风', '电音', '韩流', '影视', '流行', '怀旧', '翻唱']
  const hotTags = useMemo(() => {
    if (hotCategories.length) return []
    const seen = new Set<string>()
    const flat = groups.flatMap(group => group.tags)
    return HOT_TAG_NAMES
      .map(name => flat.find(tag => tag.name === name))
      .filter((tag): tag is NonNullable<typeof tag> => {
        if (!tag || seen.has(tag.name)) return false
        seen.add(tag.name)
        return true
      })
      .slice(0, 16)
  }, [groups, hotCategories.length])

  if (openedChannel) {
    return (
      <div data-kugou-pc-page="categories">
        <KugouPcChannelDetail
          ctx={ctx}
          ipId={openedChannel}
          onBack={() => setOpenedChannel('')}
          onOpenChannel={next => setOpenedChannel(next)}
        />
      </div>
    )
  }

  if (groups.length === 0 && hotCategories.length === 0) {
    return (
      <div data-kugou-pc-page="categories">
        <PcEmpty theme={theme} title="分类标签暂时不可用" description={payload?.kugou?.tagError || '稍后重试，或检查本地服务是否可用'} />
      </div>
    )
  }

  return (
    <div data-kugou-pc-page="categories">
      {/* 官方分类页第一屏：热门分类圆形图标网格（2 行 × 8），点击进入对应频道 */}
      {hotCategories.length > 0 ? (
        <div className="mb-7">
          <h2 className={`mb-4 text-[17px] font-semibold ${theme.text}`}>热门分类</h2>
          <div className="grid grid-cols-4 gap-y-4 sm:grid-cols-6 lg:grid-cols-8">
            {hotCategories.map(item => {
              const Icon = hotTagIcon(item.label)
              return (
                <button
                  key={item.ipId}
                  type="button"
                  onClick={() => setOpenedChannel(item.ipId)}
                  className="group flex flex-col items-center gap-2"
                >
                  <span className={`flex h-[52px] w-[52px] items-center justify-center rounded-full border border-transparent transition group-hover:-translate-y-0.5 ${theme.chipIdle}`}>
                    <Icon className="h-5 w-5" style={{ color: accent }} />
                  </span>
                  <span className={`text-[12px] ${theme.text}`}>{item.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : hotTags.length > 0 ? (
        <div className="mb-7">
          <h2 className={`mb-4 text-[17px] font-semibold ${theme.text}`}>热门分类</h2>
          <div className="grid grid-cols-4 gap-y-4 sm:grid-cols-6 lg:grid-cols-8">
            {hotTags.map(tag => {
              const Icon = hotTagIcon(tag.name)
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => onSelectTag(tag.name)}
                  className="group flex flex-col items-center gap-2"
                >
                  <span className={`flex h-[52px] w-[52px] items-center justify-center rounded-full border border-transparent transition group-hover:-translate-y-0.5 ${theme.chipIdle}`}>
                    <Icon className="h-5 w-5" style={{ color: accent }} />
                  </span>
                  <span className={`text-[12px] ${theme.text}`}>{tag.name}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {groups.map(group => {
          const active = group.id === (current?.id || '')
          return (
            <button
              key={group.id}
              type="button"
              onClick={() => setActiveGroup(group.id)}
              className={`rounded-full px-3.5 py-1.5 text-[13px] transition ${active ? 'font-medium text-white' : theme.chipIdle}`}
              style={active ? { background: accent } : undefined}
            >
              {group.name}
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {groups.map(group => (
          <button
            key={group.id}
            type="button"
            onClick={() => setActiveGroup(group.id)}
            className={`rounded-xl p-4 text-left transition hover:-translate-y-0.5 ${theme.surface}`}
          >
            <p className={`flex items-center gap-2 text-[15px] font-semibold ${theme.text}`}>
              <Headphones className="h-4 w-4" style={{ color: accent }} /> {group.name}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {group.tags.slice(0, 10).map(tag => (
                <span
                  key={tag.id}
                  role="button"
                  tabIndex={0}
                  onClick={event => { event.stopPropagation(); onSelectTag(tag.name) }}
                  onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); onSelectTag(tag.name) } }}
                  className={`rounded-full px-2.5 py-1 text-[12px] ${theme.chipIdle}`}
                >
                  {tag.name}
                </span>
              ))}
              {group.tags.length > 10 && <span className={`px-1 py-1 text-[12px] ${theme.faint}`}>等 {group.tags.length} 个标签</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/** 歌单页：标签筛选 + 歌单网格 + 加载更多 */
function KugouPcPlaylists({ ctx, payload, selectedTag, onSelectTag }: KugouPcPlaylistsProps) {
  const theme = ctx.theme
  const accent = ctx.accent
  const tagGroups = payload?.kugou?.tagGroups || []
  const [extra, setExtra] = useState<ExplorePlaylist[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(Boolean(payload?.kugou?.tagPlaylistsHasNext))
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const requestRef = useRef(0)

  // 换标签时清掉「加载更多」补进来的页，避免不同标签的歌单混在一屏
  useEffect(() => {
    setExtra([])
    setPage(1)
    setMoreError('')
    setHasMore(Boolean(payload?.kugou?.tagPlaylistsHasNext))
    // payload 是平台级缓存，切标签不重新拉第一页（第一页始终来自 payload）
  }, [selectedTag, payload?.kugou?.tagPlaylistsHasNext])

  const pool = useMemo(() => {
    const merged = [...(payload?.kugou?.tagPlaylists || []), ...extra]
    const seen = new Set<string>()
    return merged.filter(playlist => {
      if (!playlist.id || seen.has(playlist.id)) return false
      seen.add(playlist.id)
      return true
    })
  }, [payload?.kugou?.tagPlaylists, extra])

  const visible = useMemo(() => {
    if (!selectedTag) return pool
    const filtered = pool.filter(playlist => (playlist.tags || []).includes(selectedTag))
    // 官方点某个标签必然有内容；上游池子按标签筛空时退回全量并保留提示，不做假数据
    return filtered
  }, [pool, selectedTag])

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return
    const nextPage = page + 1
    const requestId = ++requestRef.current
    setLoadingMore(true)
    setMoreError('')
    const result = await fetchKugouPlaylistsByTag(0, nextPage, 100)
    if (requestId !== requestRef.current) return
    setLoadingMore(false)
    if (result.error) { setMoreError(result.error); return }
    const mapped: ExplorePlaylist[] = result.playlists.map(item => ({
      id: item.specialid,
      conceptId: item.globalSpecialId,
      name: item.name,
      coverUrl: item.coverUrl,
      playCount: item.playCount,
      trackCount: item.trackCount,
      creator: item.creator,
      description: item.intro,
      tags: item.tags,
      platform: 'kugou',
      source: 'kugou-tag-playlist',
    }))
    setExtra(prev => {
      const seen = new Set([...(payload?.kugou?.tagPlaylists || []).map(item => item.id), ...prev.map(item => item.id)])
      return [...prev, ...mapped.filter(item => !seen.has(item.id))]
    })
    setPage(nextPage)
    setHasMore(result.hasNext)
  }, [loadingMore, hasMore, page, payload?.kugou?.tagPlaylists])

  const openPlaylist = (playlist: ExplorePlaylist) => {
    ctx.openPlaylist({
      id: playlist.conceptId || playlist.id,
      name: playlist.name,
      coverImgUrl: playlist.coverUrl,
      coverUrl: playlist.coverUrl,
      trackCount: playlist.trackCount || 0,
      platform: 'kugou',
      conceptId: playlist.conceptId,
    })
  }

  const flatTags = useMemo(() => tagGroups.flatMap(group => group.tags.map(tag => ({ ...tag, group: group.name }))), [tagGroups])

  return (
    <div className="pb-8" data-kugou-pc-page="playlists">
      {flatTags.length > 0 && (
        <div className="mb-5 space-y-2">
          {/* 官方标签条是浅底矩形宽块（5 列排布），不是小圆胶囊 */}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
            <button
              type="button"
              onClick={() => onSelectTag(null)}
              className={`rounded-[4px] px-3 py-2 text-[13px] transition ${selectedTag === null ? 'font-medium text-white' : theme.chipIdle}`}
              style={selectedTag === null ? { background: accent } : undefined}
            >
              全部
            </button>
            {flatTags.slice(0, 29).map(tag => (
              <button
                key={`${tag.group}:${tag.id}`}
                type="button"
                onClick={() => onSelectTag(tag.name)}
                className={`truncate rounded-[4px] px-3 py-2 text-center text-[13px] transition ${selectedTag === tag.name ? 'font-medium text-white' : theme.chipIdle}`}
                style={selectedTag === tag.name ? { background: accent } : undefined}
                title={tag.name}
              >
                {tag.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <PcEmpty
          theme={theme}
          title={selectedTag ? `「${selectedTag}」下暂时没有歌单` : '歌单广场暂时没有返回内容'}
          description={payload?.kugou?.tagPlaylistsError || '上游分类歌单池为空，换个标签或稍后再试'}
        />
      ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {visible.map((playlist, index) => (
            <button key={`${playlist.id}:${index}`} type="button" onClick={() => openPlaylist(playlist)} className="group min-w-0 text-left">
              <span className="relative block">
                <PcCover src={playlist.coverUrl} alt={playlist.name} className="aspect-square w-full" rounded="rounded-[8px]" />
                {playlist.tags?.[0] ? (
                  <span className="absolute left-1.5 top-1.5 rounded-[4px] bg-black/45 px-1.5 py-[2px] text-[11px] leading-none text-white backdrop-blur-sm">{playlist.tags[0]}</span>
                ) : null}
                {kugouCount(playlist.playCount) ? (
                  <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-[2px] text-[11px] leading-none text-white backdrop-blur-sm">
                    <Headphones className="h-3 w-3" /> {kugouCount(playlist.playCount)}
                  </span>
                ) : null}
              </span>
              <span className={`mt-2 line-clamp-2 text-[13px] leading-snug ${theme.text}`}>{playlist.name}</span>
              <span className={`mt-0.5 line-clamp-1 block text-[11px] ${theme.faint}`}>
                {playlist.creator || (playlist.trackCount ? `${playlist.trackCount} 首` : '精选歌单')}
              </span>
            </button>
          ))}
        </div>
      )}

      {visible.length > 0 && (
        <div className="mt-6 flex flex-col items-center gap-2">
          {moreError ? <p className={`text-[12px] ${theme.faint}`}>{moreError}</p> : null}
          {hasMore ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              className={`flex items-center gap-2 rounded-full px-5 py-2 text-[13px] transition disabled:opacity-50 ${theme.solidBtn}`}
            >
              {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              加载更多
            </button>
          ) : (
            <p className={`text-[12px] ${theme.faint}`}>已加载全部歌单</p>
          )}
        </div>
      )}
    </div>
  )
}

export default memo(KugouPcPlaylists)
