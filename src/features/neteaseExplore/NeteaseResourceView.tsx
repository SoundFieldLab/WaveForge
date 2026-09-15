import { Ban, ChevronRight, Crown, Disc3, ExternalLink, Film, Heart, MessageSquareText, Play, Radio, UserRound } from 'lucide-react'
import { HorizontalShelf } from '../../components/apple-explore/HorizontalShelf'
import CachedImage from '../../components/CachedImage'
import type { ExplorePlaylist } from '../../services/exploreApi'
import type { Song } from '../../services/musicApi'
import { getSongRequiredTier, shouldShowEntitlementBadge, type EntitlementTier } from '../../utils/musicEntitlements'
import type { NeteaseNativeBlock, NeteaseNativeResource } from './model'
import { neteaseResourceArtwork } from './model'

export interface ResourceCallbacks {
  onExecute: (resource: NeteaseNativeResource, queue: NeteaseNativeResource[]) => void
  onSongContextMenu: (event: React.MouseEvent, song: Song, songs: Song[], continuous?: boolean) => void
  onPlaylistContextMenu: (event: React.MouseEvent, playlist: ExplorePlaylist) => void
  isSongFavorite: (resource: NeteaseNativeResource) => boolean
  isFavoritePending: (song: Song) => boolean
  onToggleFavorite: (event: React.MouseEvent, resource: NeteaseNativeResource) => void
  favoriteCount: (resource: NeteaseNativeResource) => number | undefined
  entitlement: EntitlementTier
  /** 区块标题右侧的「更多」入口；由调用方决定跳转到哪个发现频道 */
  onBlockMore?: (block: NeteaseNativeBlock) => void
}

const CARD_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--explore-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d1118]'

export function SongRestrictionBadges({ song, entitlement }: { song: Song; entitlement: EntitlementTier }) {
  const showEntitlement = shouldShowEntitlementBadge(song, entitlement)
  if (!song.noCopyright && !showEntitlement) return null
  const requiredTier = getSongRequiredTier(song)
  return (
    <span className="flex shrink-0 items-center gap-1" aria-label="歌曲限制">
      {song.noCopyright && <span title="暂无版权" aria-label="暂无版权"><Ban className="h-3.5 w-3.5 text-rose-300/75" /></span>}
      {showEntitlement && <span title={`需要 ${requiredTier.toUpperCase()}`} aria-label={`需要 ${requiredTier.toUpperCase()}`}><Crown className="h-3.5 w-3.5 text-amber-300/75" /></span>}
    </span>
  )
}

export function formatNeteaseCount(value?: number) {
  const count = Number(value || 0)
  if (!count) return ''
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(count >= 1_000_000_000 ? 0 : 1)}亿+`
  if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 1_000_000 ? 0 : 1)}万+`
  return String(count)
}

export function groupSongResources(resources: NeteaseNativeResource[], rows = 3) {
  const groups: NeteaseNativeResource[][] = []
  for (let index = 0; index < resources.length; index += rows) groups.push(resources.slice(index, index + rows))
  return groups
}

function actionIcon(resource: NeteaseNativeResource) {
  switch (resource.action.type) {
    case 'mv': return Film
    case 'comments': return MessageSquareText
    case 'radio':
    case 'program': return Radio
    case 'artist':
    case 'user': return UserRound
    case 'web':
    case 'podcast-section': return ExternalLink
    default: return Play
  }
}

function resourceKindLabel(resource: NeteaseNativeResource) {
  switch (resource.action.type) {
    case 'playlist': return '歌单'
    case 'album': return '专辑'
    case 'radio': return '播客'
    case 'program': return '节目'
    case 'artist': return '艺人'
    case 'user': return '用户'
    case 'mv': return '视频'
    case 'comments': return '热评'
    default: return ''
  }
}

function ResourceImage({ resource, className = '' }: { resource: NeteaseNativeResource; className?: string }) {
  const imageUrl = neteaseResourceArtwork(resource)
  const fallback = <span className="flex h-full w-full items-center justify-center bg-[linear-gradient(145deg,#2c3441,#171c25)]"><Disc3 className="h-6 w-6 text-white/28" /></span>
  return (
    <span className={`relative block overflow-hidden bg-white/[0.06] ${className}`}>
      {imageUrl ? <CachedImage src={imageUrl} alt="" platform="netease" retainPrevious lazy className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.025]" fallback={fallback} /> : fallback}
    </span>
  )
}

function SongRow({ resource, resources, songs, callbacks }: { resource: NeteaseNativeResource; resources: NeteaseNativeResource[]; songs: Song[]; callbacks: ResourceCallbacks }) {
  const song = resource.song
  if (!song) return null
  const favorite = callbacks.isSongFavorite(resource)
  const pending = callbacks.isFavoritePending(song)
  const count = formatNeteaseCount(callbacks.favoriteCount(resource))
  return (
    <div
      role="button"
      tabIndex={0}
      data-resource-id={`${resource.type}:${resource.id}`}
      data-song-id={song.id}
      onClick={() => callbacks.onExecute(resource, resources)}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          callbacks.onExecute(resource, resources)
        }
      }}
      onContextMenu={event => callbacks.onSongContextMenu(event, song, songs)}
      className={`group flex h-[72px] min-w-0 cursor-pointer items-center gap-3 border-b border-white/[0.055] px-1 text-left transition hover:bg-white/[0.035] ${CARD_FOCUS}`}
    >
      <ResourceImage resource={resource} className="h-14 w-14 shrink-0 rounded-md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-white/86">{resource.title}</span>
        <span className="mt-1 block truncate text-xs text-white/40">{resource.subtitle || resourceKindLabel(resource)}</span>
      </span>
      <SongRestrictionBadges song={song} entitlement={callbacks.entitlement} />
      <button
        type="button"
        aria-label={favorite ? `取消喜欢 ${resource.title}` : `喜欢 ${resource.title}`}
        aria-pressed={favorite}
        disabled={pending}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          callbacks.onToggleFavorite(event, resource)
        }}
        className={`flex h-10 min-w-10 shrink-0 items-center justify-center gap-1 rounded-full transition disabled:opacity-45 ${favorite ? 'text-[#ff4d67]' : 'text-white/30 hover:text-white/75'} ${CARD_FOCUS}`}
      >
        <Heart className={`h-4 w-4 ${favorite ? 'fill-current' : ''}`} />
        {count && <span className="max-w-14 truncate text-[10px] tabular-nums text-current/80">{count}</span>}
      </button>
    </div>
  )
}

function SongShelf({ resources, callbacks, title }: { resources: NeteaseNativeResource[]; callbacks: ResourceCallbacks; title: string }) {
  const songs = resources.map(resource => resource.song).filter((song): song is Song => Boolean(song))
  const groups = groupSongResources(resources)
  return (
    <HorizontalShelf ariaLabel={`${title || '歌曲推荐'}歌曲`} itemClassName="w-[min(82vw,27rem)] md:w-[25rem] xl:w-[27rem]">
      {groups.map((group, columnIndex) => (
        <div key={columnIndex} data-song-column={columnIndex} className="grid h-[216px] grid-rows-3">
          {group.map(resource => <SongRow key={`${resource.type}-${resource.id}`} resource={resource} resources={resources} songs={songs} callbacks={callbacks} />)}
        </div>
      ))}
    </HorizontalShelf>
  )
}

function CoverShelf({ resources, callbacks, title }: { resources: NeteaseNativeResource[]; callbacks: ResourceCallbacks; title: string }) {
  const songs = resources.map(resource => resource.song).filter((song): song is Song => Boolean(song))
  return (
    <HorizontalShelf ariaLabel={`${title || '推荐内容'}封面`} itemClassName="w-44 md:w-48">
      {resources.map((resource, index) => {
        const Icon = actionIcon(resource)
        return (
          <button
            key={`${resource.action.type}-${resource.id}-${index}`}
            data-resource-id={`${resource.type}:${resource.id}`}
            type="button"
            disabled={resource.action.type === 'none'}
            onClick={() => callbacks.onExecute(resource, resources)}
            onContextMenu={event => {
              if (resource.playlist) callbacks.onPlaylistContextMenu(event, resource.playlist)
              else if (resource.song) callbacks.onSongContextMenu(event, resource.song, songs)
            }}
            className={`group w-full text-left disabled:cursor-not-allowed disabled:opacity-50 ${CARD_FOCUS}`}
          >
            <span className="relative block">
              <ResourceImage resource={resource} className="aspect-square rounded-md" />
              {resource.action.type !== 'none' && <span className="absolute bottom-3 right-3 flex h-9 w-9 translate-y-1 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100"><Icon className="h-4 w-4" /></span>}
            </span>
            <span className="mt-2 flex min-w-0 items-start gap-1.5"><span className="min-w-0 flex-1 line-clamp-2 text-sm font-medium leading-snug text-white/86">{resource.title}</span>{resource.song && <SongRestrictionBadges song={resource.song} entitlement={callbacks.entitlement} />}</span>
            <span className="mt-1 block truncate text-xs text-white/38">{resource.subtitle || resourceKindLabel(resource)}</span>
          </button>
        )
      })}
    </HorizontalShelf>
  )
}

function MixedGrid({ resources, callbacks }: { resources: NeteaseNativeResource[]; callbacks: ResourceCallbacks }) {
  const songs = resources.map(resource => resource.song).filter((song): song is Song => Boolean(song))
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {resources.map((resource, index) => {
        const Icon = actionIcon(resource)
        return (
          <button key={`${resource.action.type}-${resource.id}-${index}`} data-resource-id={`${resource.type}:${resource.id}`} type="button" disabled={resource.action.type === 'none'} onClick={() => callbacks.onExecute(resource, resources)} onContextMenu={event => {
            if (resource.playlist) callbacks.onPlaylistContextMenu(event, resource.playlist)
            else if (resource.song) callbacks.onSongContextMenu(event, resource.song, songs)
          }} className={`group flex h-[108px] min-w-0 items-center gap-3 overflow-hidden rounded-md border border-white/[0.075] bg-white/[0.035] p-3 text-left transition hover:bg-white/[0.075] disabled:cursor-not-allowed disabled:opacity-50 ${CARD_FOCUS}`}>
            <ResourceImage resource={resource} className="h-16 w-16 shrink-0 rounded-md" />
            <span className="min-w-0 flex-1"><span className="flex min-w-0 items-start gap-1.5"><span className="min-w-0 flex-1 line-clamp-2 text-sm font-medium text-white/86">{resource.title}</span>{resource.song && <SongRestrictionBadges song={resource.song} entitlement={callbacks.entitlement} />}</span><span className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/38">{resource.subtitle || resourceKindLabel(resource)}</span></span>
            {resource.action.type !== 'none' && <Icon className="h-4 w-4 shrink-0 text-white/25 transition group-hover:text-white/70" />}
          </button>
        )
      })}
    </div>
  )
}

export function classifyNeteaseBlock(block: Pick<NeteaseNativeBlock, 'blockCode' | 'showType' | 'title' | 'subtitle'> & { resources?: NeteaseNativeResource[] }): 'songs' | 'cover-shelf' | 'mixed' {
  const semantic = `${block.blockCode} ${block.showType} ${block.title} ${block.subtitle} ${(block.resources || []).map(resource => `${resource.title} ${resource.subtitle}`).join(' ')}`.toUpperCase()
  if (/SONGLIST|PLAYABLE_RESOURCE|SINGLE_SONG|NEW_SONG|VIP_SONG|STYLE_RCMD|SONG_RCMD/.test(semantic)) return 'songs'
  if (/ARTIST_HOT|ARTIST_RCMD|SCENE|MOOD|PERSONAL|MOVIE|PODCAST|PLAYLIST|TOPLIST|VOICE|ALBUM|DRAGON|RADAR/.test(semantic)) return 'cover-shelf'
  return 'mixed'
}

export function NeteaseNativeBlockView({ block, callbacks }: { block: NeteaseNativeBlock; callbacks: ResourceCallbacks }) {
  const semantic = `${block.blockCode} ${block.showType} ${block.title} ${block.subtitle} ${block.resources.map(resource => `${resource.title} ${resource.subtitle}`).join(' ')}`
  const title = block.title || block.subtitle || (/LISA|艺人热门|热门金曲/.test(semantic) ? '艺人热门金曲' : /喜欢的艺人|艺人开始漫游/.test(semantic) ? '从你喜欢的艺人开始漫游' : /场景歌单|场景/.test(semantic) ? '场景歌单' : /心情氛围|心情/.test(semantic) ? '心情氛围' : /专属推荐歌单|年代专属|国语专属|嘻哈说唱专属/.test(semantic) ? '你的专属推荐歌单' : /影视原声|动漫影视/.test(semantic) ? '影视原声' : /喜欢的音乐听播客/.test(semantic) ? '从你喜欢的音乐听播客' : ({
    HOMEPAGE_BLOCK_PLAYLIST_RCMD: '推荐歌单',
    HOMEPAGE_SLIDE_PLAYLIST: '推荐歌单',
    HOMEPAGE_BLOCK_STYLE_RCMD: '猜你喜欢的好歌',
    HOMEPAGE_SLIDE_SONGLIST_ALIGN: '根据你喜爱的歌曲推荐',
    HOMEPAGE_BLOCK_NEW_ALBUM_NEW_SONG: '新歌新碟',
    HOMEPAGE_BLOCK_NEW_SONG_AND_ALBUM: '新歌新碟',
    HOMEPAGE_SLIDE_TOPLIST: '排行榜',
    HOMEPAGE_SLIDE_TAB_TOPLIST: '排行榜',
    HOMPAGE_BLOCK_VIP_RCMD: 'VIP 专属好歌',
    HOMEPAGE_BLOCK_USER_PLAYLIST: '你的雷达歌单',
    HOMEPAGE_SLIDE_PLAYABLE_RESOURCE_SQUARE: '场景歌单',
    HOMEPAGE_BLOCK_SCENE_PLAYLIST: '场景歌单',
    HOMEPAGE_BLOCK_MOOD_PLAYLIST: '心情氛围',
    HOMEPAGE_BLOCK_PERSONAL_PLAYLIST: '你的专属推荐歌单',
    HOMEPAGE_BLOCK_MOVIE_MUSIC: '影视原声',
    HOMEPAGE_BLOCK_PODCAST_RCMD: '从你喜欢的音乐听播客',
    HOMEPAGE_BLOCK_ARTIST_HOT: '艺人热门金曲',
    HOMEPAGE_BLOCK_ARTIST_RCMD: '从你喜欢的艺人开始漫游',
    HOMEPAGE_BLOCK_RADAR_PLAYLIST: '你的雷达歌单',
  } as Record<string, string>)[block.blockCode] || '')
  const songCount = block.resources.filter(resource => resource.song).length
  const shelfCount = block.resources.filter(resource => ['playlist', 'album', 'radio', 'program', 'artist', 'user', 'mv'].includes(resource.action.type)).length
  const layout = block.layout === 'grid' ? 'mixed' : block.layout === 'shelf' ? 'cover-shelf' : block.layout === 'songs' ? 'songs' : classifyNeteaseBlock(block)
  const useSongs = layout === 'songs' || (layout === 'mixed' && songCount >= Math.max(2, block.resources.length / 2))
  const useShelf = block.layout !== 'grid' && (layout === 'cover-shelf' || (layout === 'mixed' && shelfCount >= Math.max(1, block.resources.length / 2)))
  if (block.resources.length === 0) return null
  const more = callbacks.onBlockMore && title ? callbacks.onBlockMore : undefined
  return <section data-block-code={block.blockCode} data-show-type={block.showType}>{title && <div className="mb-4 flex min-w-0 items-center gap-3"><h3 className="truncate text-xl font-semibold text-white/86">{title}</h3>{block.subtitle && block.subtitle !== title && <span className="truncate text-xs text-white/35">{block.subtitle}</span>}<span className="flex-1" />{more && <button type="button" onClick={() => more(block)} className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-white/[0.1] px-3 text-xs text-white/55 transition hover:bg-white/[0.08] hover:text-white/90">更多<ChevronRight className="h-3.5 w-3.5" /></button>}</div>}{useSongs ? <SongShelf resources={block.resources} callbacks={callbacks} title={title} /> : useShelf ? <CoverShelf resources={block.resources} callbacks={callbacks} title={title} /> : <MixedGrid resources={block.resources} callbacks={callbacks} />}</section>
}

export function NeteaseFlowGrid({ resources, callbacks }: { resources: NeteaseNativeResource[]; callbacks: ResourceCallbacks }) {
  return <MixedGrid resources={resources} callbacks={callbacks} />
}
