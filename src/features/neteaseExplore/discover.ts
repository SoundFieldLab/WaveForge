import { getApiBase } from '../../services/apiConfig'
import { getExploreCookie } from '../../services/exploreApi'
import {
  dedupeNeteaseResources,
  filterNeteaseAdResources,
  normalizeNeteaseBlock,
  normalizeNeteaseResource,
  type NeteaseNativeBlock,
  type NeteaseNativeResource,
} from './model'

// src/features/neteaseExplore/discover.ts
// 发现页（音乐 / 播客）数据源，接口来自 9.5.90 实机抓包，详见 docs/netease-discover-reverse-2026-09-13.md

const API_BASE = `${getApiBase()}/netease/native`

export type NeteaseLinkPageCode = 'HOME_RECOMMEND_PAGE' | 'HOME_DISCOVERY_PAGE'

async function request(path: string, params: Record<string, string | undefined>, signal?: AbortSignal) {
  const url = new URL(`${API_BASE}${path}`)
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value)
  const response = await fetch(url, { signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok || Number(data?.code) >= 400) throw new Error(data?.error || data?.message || `网易云请求失败 (${response.status})`)
  return data
}

export interface NeteaseMusicChannel {
  code: string
  title: string
  url: string
  urlType: string
  pageId: string
}

function pageIdFromUrl(url: string): string {
  try {
    return new URL(url).searchParams.get('page') || ''
  } catch {
    return ''
  }
}

export async function fetchNeteaseLinkPage(pageCode: NeteaseLinkPageCode, cursor = '0', refresh = false, signal?: AbortSignal, order?: string[]) {
  return request('/link-page', {
    cookie: getExploreCookie('netease'),
    pageCode,
    cursor,
    refresh: refresh ? '1' : undefined,
    order: order && order.length > 0 ? JSON.stringify(order) : undefined,
  }, signal)
}

export async function fetchNeteaseMusicChannels(signal?: AbortSignal): Promise<NeteaseMusicChannel[]> {
  const payload = await request('/music-channels', { cookie: getExploreCookie('netease') }, signal)
  const channels = Array.isArray(payload?.channels) ? payload.channels : []
  return channels
    .map((channel: any): NeteaseMusicChannel => ({
      code: String(channel?.code || ''),
      title: String(channel?.title || ''),
      url: String(channel?.url || ''),
      urlType: String(channel?.urlType || ''),
      pageId: pageIdFromUrl(String(channel?.url || '')),
    }))
    .filter((channel: NeteaseMusicChannel) => channel.code && channel.title)
}

export async function fetchNeteaseCubePage(pageId: string, signal?: AbortSignal) {
  return request('/cube-page', { cookie: getExploreCookie('netease'), pageId }, signal)
}

/** 批量补歌单详情（封面/标题/播放量）。曲风页里很多卡片只下发 id。 */
export async function fetchNeteaseTagPlaylists(ids: Array<string | number>, signal?: AbortSignal): Promise<Map<string, { name: string; cover: string; playCount: number; songCount: number }>> {
  const unique = [...new Set(ids.map(String).filter(id => /^\d+$/.test(id)))]
  const result = new Map<string, { name: string; cover: string; playCount: number; songCount: number }>()
  if (unique.length === 0) return result
  const chunks: string[][] = []
  for (let index = 0; index < unique.length; index += 50) chunks.push(unique.slice(index, index + 50))
  const payloads = await Promise.all(chunks.map(chunk => request('/tag-playlists', { cookie: getExploreCookie('netease'), ids: chunk.join(',') }, signal)))
  for (const payload of payloads) {
    const list = Array.isArray(payload?.data) ? payload.data : []
    for (const item of list) {
      const id = String(item?.id || '')
      if (!id) continue
      result.set(id, {
        name: String(item?.name || ''),
        cover: String(item?.cover || item?.coverUrl || item?.coverImgUrl || '').replace(/^http:/, 'https:'),
        playCount: Number(item?.playCount || 0),
        songCount: Number(item?.songCount || 0),
      })
    }
  }
  return result
}

/** 用歌单详情回填 cube 页里缺封面/标题的卡片 */
export async function fillNeteaseCubeCovers(page: NeteaseCubePage, signal?: AbortSignal): Promise<NeteaseCubePage> {
  const blocks = [...page.blocks, ...page.tabs.flatMap(tab => tab.blocks)]
  const missing = new Set<string>()
  for (const block of blocks) {
    for (const resource of block.resources) {
      if (resource.action.type !== 'playlist') continue
      const id = resource.action.playlist.id
      if (!id) continue
      if (!resource.coverUrl || !resource.title) missing.add(id)
    }
  }
  if (missing.size === 0) return page
  let details: Map<string, { name: string; cover: string; playCount: number; songCount: number }>
  try {
    details = await fetchNeteaseTagPlaylists([...missing], signal)
  } catch {
    return page
  }
  const patch = (resource: NeteaseNativeResource): NeteaseNativeResource => {
    if (resource.action.type !== 'playlist') return resource
    const detail = details.get(resource.action.playlist.id)
    if (!detail) return resource
    const coverUrl = resource.coverUrl || detail.cover
    const playlist = {
      ...resource.action.playlist,
      name: resource.action.playlist.name || detail.name || resource.title,
      coverUrl: resource.action.playlist.coverUrl || detail.cover,
      playCount: resource.action.playlist.playCount || detail.playCount || undefined,
      trackCount: resource.action.playlist.trackCount || detail.songCount || undefined,
    }
    return {
      ...resource,
      title: resource.title || detail.name,
      coverUrl,
      playCount: resource.playCount || detail.playCount || undefined,
      playlist,
      action: { type: 'playlist', playlist, autoplay: resource.action.autoplay },
    }
  }
  return {
    blocks: page.blocks.map(block => ({ ...block, resources: block.resources.map(patch) })),
    tabs: page.tabs.map(tab => ({ ...tab, blocks: tab.blocks.map(block => ({ ...block, resources: block.resources.map(patch) })) })),
  }
}

export async function fetchNeteaseToplist(signal?: AbortSignal): Promise<any[]> {
  const payload = await request('/toplist', { cookie: getExploreCookie('netease') }, signal)
  const data = payload?.data
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') return Object.values(data)
  return []
}

export async function fetchNeteasePlaylistSquare(categoryName = '推荐', offset = 0, limit = 20, signal?: AbortSignal) {
  return request('/playlist-square', { cookie: getExploreCookie('netease'), categoryName, offset: String(offset), limit: String(limit) }, signal)
}

export async function fetchNeteasePodcastInfinite(cursor = '', refresh = false, signal?: AbortSignal) {
  return request('/podcast-infinite', { cookie: getExploreCookie('netease'), cursor: cursor || undefined, refresh: refresh ? '1' : undefined }, signal)
}

export interface NeteasePodcastCategory { id: string; name: string; children: Array<{ id: string; name: string; description: string }> }

export async function fetchNeteasePodcastCategories(signal?: AbortSignal): Promise<NeteasePodcastCategory[]> {
  const payload = await request('/podcast-categories', { cookie: getExploreCookie('netease') }, signal)
  const list = Array.isArray(payload?.data) ? payload.data : []
  return list.map((item: any) => ({
    id: String(item?.id || ''),
    name: String(item?.name || ''),
    children: (Array.isArray(item?.secondCategoryList) ? item.secondCategoryList : []).map((child: any) => ({
      id: String(child?.id || ''),
      name: String(child?.name || ''),
      description: String(child?.description || ''),
    })).filter((child: { id: string }) => child.id),
  })).filter((category: NeteasePodcastCategory) => category.id && category.name)
}

export async function fetchNeteasePodcastCategoryRadios(categoryId: string, offset = 0, limit = 18, signal?: AbortSignal) {
  return request('/podcast-category-radios', { cookie: getExploreCookie('netease'), categoryId, offset: String(offset), limit: String(limit) }, signal)
}

export interface NeteaseVipPage {
  card: { levelImage: string; level: number; nextLevel: number; percent: number; carousels: string[]; buttonTitle: string; buttonUrl: string }
  level: { levelTitle: string; nextLevelTitle: string; growthPoint: number; nextLevelGrowthPoint: number }
  privileges: Array<{ title: string; icon: string }>
  songs: any[]
}

export async function fetchNeteaseVipPage(refresh = false, signal?: AbortSignal): Promise<NeteaseVipPage> {
  const payload = await request('/vip-page', { cookie: getExploreCookie('netease'), refresh: refresh ? '1' : undefined }, signal)
  return {
    card: {
      levelImage: String(payload?.card?.levelImage || ''),
      level: Number(payload?.card?.level || 0),
      nextLevel: Number(payload?.card?.nextLevel || 0),
      percent: Number(payload?.card?.percent || 0),
      carousels: Array.isArray(payload?.card?.carousels) ? payload.card.carousels.map(String) : [],
      buttonTitle: String(payload?.card?.buttonTitle || ''),
      buttonUrl: String(payload?.card?.buttonUrl || ''),
    },
    level: {
      levelTitle: String(payload?.level?.levelTitle || ''),
      nextLevelTitle: String(payload?.level?.nextLevelTitle || ''),
      growthPoint: Number(payload?.level?.growthPoint || 0),
      nextLevelGrowthPoint: Number(payload?.level?.nextLevelGrowthPoint || 0),
    },
    privileges: Array.isArray(payload?.privileges) ? payload.privileges : [],
    songs: Array.isArray(payload?.songs) ? payload.songs : [],
  }
}

export async function fetchNeteaseMyPodcasts(userId: string, offset = 0, limit = 30, signal?: AbortSignal) {
  return request('/my-podcasts', { cookie: getExploreCookie('netease'), userId, offset: String(offset), limit: String(limit) }, signal)
}

/** 电台列表（djradio/hot、get/byuser）→ 统一资源 */
export function normalizeNeteaseRadioResources(payload: any): NeteaseNativeResource[] {
  const data = payload?.data ?? payload ?? {}
  const list = Array.isArray(data) ? data : (data.djRadios || data.radios || [])
  const resources = (Array.isArray(list) ? list : []).map((item: any, index: number) => {
    const radio = item?.dj ? { ...item, ...item.dj } : item
    const id = String(radio?.id ?? radio?.radioId ?? radio?.voiceListId ?? '')
    const name = String(radio?.name ?? radio?.voiceListName ?? '')
    if (!id || !name) return null
    return normalizeNeteaseResource({
      resourceId: id,
      resourceType: 'voicelist',
      action: `orpheus://djradio/${id}`,
      title: name,
      coverImg: radio?.picUrl || radio?.coverUrl || radio?.coverImgUrl || radio?.avatarUrl || '',
      subTitle: String(radio?.desc || radio?.rcmdText || radio?.category || ''),
      playCount: Number(radio?.playCount || radio?.subCount || 0) || undefined,
      resourceInteractInfo: { playCount: Number(radio?.playCount || radio?.subCount || 0) || undefined },
    }, index)
  }).filter((item): item is NeteaseNativeResource => Boolean(item))
  return dedupeNeteaseResources(filterNeteaseAdResources(resources))
}

/** 播客 Tab 首页（9 个 blockVOS：编辑精选 / 龙珠入口 / 为你推荐 / 音乐播客榜 / 上新佳作 / 音乐大咖说 / 热门播客 / 分类 / 探索更多） */
export async function fetchNeteasePodcastHome(signal?: AbortSignal) {
  return request('/podcast-home', { cookie: getExploreCookie('netease') }, signal)
}

/** 排行榜 data[] -> 区块（每个榜单一张卡）
 * 兼容两种形态：weapi 扁平榜单数组；eapi 分组数组 [{ name, categoryCode, list:[榜单] }]
 */
export function normalizeNeteaseToplistBlocks(list: any[]): NeteaseNativeBlock[] {
  const flat: any[] = []
  const groups: Array<{ title: string; items: any[] }> = []
  for (const item of list) {
    if (item && Array.isArray(item.list)) groups.push({ title: String(item.name || '').trim(), items: item.list })
    else flat.push(item)
  }
  const toResource = (item: any, index: number) => {
    const id = String(item?.id || item?.toplistId || item?.playlistId || '')
    const title = String(item?.name || '')
    if (!id || !title) return null
    const playCount = Number(item?.playCount || 0) || undefined
    return normalizeNeteaseResource({
      resourceId: id,
      resourceType: 'toplist',
      action: item?.targetType === 'PLAYLIST' || !item?.targetType ? `orpheus://playlist/${id}` : `orpheus://${String(item.targetType).toLowerCase()}/${id}`,
      title,
      coverImg: item?.coverUrl || item?.coverImgUrl || '',
      subTitle: item?.updateFrequency || '',
      playCount,
      resourceInteractInfo: { playCount },
      trackCount: Number(item?.trackCount || (Array.isArray(item?.tracks) ? item.tracks.length : 0)) || undefined,
    }, index)
  }
  const toBlock = (title: string, codeSuffix: string, items: any[], index: number): NeteaseNativeBlock | null => {
    const resources = items.map(toResource).filter((item): item is NeteaseNativeResource => Boolean(item))
    if (!resources.length) return null
    return { id: `netease-toplist-${codeSuffix}`, blockCode: `NETEASE_TOPLIST_${codeSuffix}`, showType: 'HOMEPAGE_SLIDE_TOPLIST', title: title || '排行榜', subtitle: '', resources: dedupeNeteaseResources(filterNeteaseAdResources(resources)), raw: {} }
  }
  const blocks: NeteaseNativeBlock[] = []
  const flatBlock = toBlock('排行榜', 'ALL', flat, 0)
  if (flatBlock) blocks.push(flatBlock)
  groups.forEach((group, index) => {
    const block = toBlock(group.title || '排行榜', `GROUP_${index}`, group.items, index * 100)
    if (block) blocks.push(block)
  })
  return blocks
}

/** 歌单广场 blocks/creatives -> 区块 */
export function normalizeNeteaseSquareBlocks(payload: any): NeteaseNativeBlock[] {
  const blocks: Record<string, any>[] = Array.isArray(payload?.data?.blocks) ? payload.data.blocks : []
  return blocks
    .map(normalizeNeteaseBlock)
    .map((block: NeteaseNativeBlock) => ({ ...block, resources: dedupeNeteaseResources(filterNeteaseAdResources(block.resources)) }))
    .filter((block: NeteaseNativeBlock) => block.resources.length > 0)
}

function titleOfCubeNode(props: any): string {
  return String(props?.mainTitle || props?.title || '').trim()
}

const IMAGE_KEYS = ['coverUrl', 'coverImg', 'coverImgUrl', 'coverImageUrl', 'picUrl', 'imageUrl', 'purePictureUrl', 'iconUrl', 'tagImgUrl', 'background', 'bgUrl', 'cover', 'coverImage', 'fmLogoImage']
const TITLE_KEYS = ['title', 'name', 'mainTitle', 'resourceName', 'songName']

function looksLikeResource(item: any): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false
  const hasImage = IMAGE_KEYS.some(key => typeof item[key] === 'string' && item[key])
  const hasTitle = TITLE_KEYS.some(key => typeof item[key] === 'string' && item[key])
  const hasId = item.id != null || item.resourceId != null || item.resource != null || item.songId != null
  const hasAction = Boolean(item.action || item.targetUrl || item.actionUrl)
  const isFm = String(item.type || '') === 'fm'
  const isCoverlessPlaylist = hasId && hasTitle && /song_?list|playlist|album|toplist/.test(String(item.type || item.resourceType || ''))
  // 轮播/入口类卡片可能没有标题，只要有图/跳转就保留；FM 入口可无封面；
  // 歌单类卡片 App 只下发 id，封面由 /eapi/tag/tab/playlists 批量补
  return (hasImage && (hasTitle || hasId || hasAction)) || (isFm && hasTitle) || isCoverlessPlaylist
}

/** cube 里的资源类型：song_list/fm/song/album/playlist */
function cubeTypeOf(item: any, hint: string): string {
  const raw = String(item?.type || item?.resourceType || hint || '').toLowerCase()
  if (raw === 'fm') return 'fm'
  if (/song_?list|playlist/.test(raw)) return 'playlist'
  if (/^song$|track/.test(raw)) return 'song'
  if (/album/.test(raw)) return 'album'
  if (/artist/.test(raw)) return 'artist'
  return raw || 'playlist'
}

function actionUrlFromCubeItem(item: any): string {
  const action = item?.action
  if (typeof action === 'string' && action) return action
  if (action && typeof action === 'object') {
    const params = action.params || {}
    if (params.query) return `orpheus://${params.resourceType || 'playlist'}/${params.query}`
    if (typeof params.url === 'string' && params.url) return params.url
    if (typeof params.orpheus === 'string' && params.orpheus) return params.orpheus
  }
  if (typeof item?.targetUrl === 'string' && item.targetUrl) return item.targetUrl
  if (typeof item?.url === 'string' && item.url) return item.url
  return ''
}

function resourceFromCubeItem(item: any, index: number, hintType = ''): NeteaseNativeResource | null {
  const type = cubeTypeOf(item, hintType)
  const id = String(item?.id ?? item?.resourceId ?? item?.resource ?? item?.songId ?? item?.action?.params?.query ?? '')
  const actionHint = actionUrlFromCubeItem(item)
  if (!id && !actionHint && type !== 'fm') return null
  const actionUrl = actionHint || `orpheus://${type}/${id}`
  return normalizeNeteaseResource({
    resourceId: id,
    resourceType: type,
    action: actionUrl,
    mode: item?.mode,
    subMode: item?.subMode,
    entranceType: item?.entranceType,
    title: String(item?.title || item?.name || item?.mainTitle || ''),
    coverImg: item?.coverUrl || item?.coverImg || item?.coverImgUrl || item?.picUrl || item?.imageUrl || item?.background || item?.bgUrl || item?.cover || item?.coverImage || '',
    subTitle: String(item?.subtitle || item?.subTitle || item?.desc || item?.tagText || ''),
    playCount: Number(item?.playCount || 0) || undefined,
    resourceInteractInfo: { playCount: Number(item?.playCount || 0) || undefined },
    songData: type === 'song' ? item : undefined,
  }, index)
}

/** 从任意组件的 props 里扫描数组型资源（不同 cube 模板字段不统一，做通用兜底） */
function collectPropsResources(props: any, startIndex: number): NeteaseNativeResource[] {
  const out: NeteaseNativeResource[] = []
  if (!props || typeof props !== 'object') return out
  const SKIP = new Set(['style', 'log', 'tabBar', 'theme', 'share', 'settings'])
  let index = startIndex
  const push = (item: any, hintType = '') => {
    if (!looksLikeResource(item)) return
    const resource = resourceFromCubeItem(item, index++, hintType)
    if (resource) out.push(resource)
  }
  // recommendModule 形如 [{ title, modules: [{ cover, resource, type, title }] }]，需要下钻一层
  const pushNode = (item: any, hintType = '') => {
    if (!item || typeof item !== 'object') return
    if (Array.isArray(item.modules)) for (const mod of item.modules) push(mod, hintType)
    else push(item, hintType)
  }
  for (const [key, value] of Object.entries(props)) {
    if (SKIP.has(key) || !Array.isArray(value)) continue
    const hint = /song/i.test(key) ? 'song' : /playlist|resource|module/i.test(key) ? 'playlist' : ''
    for (const item of value) pushNode(item, hint)
  }
  // 单对象字段
  if (looksLikeResource(props.resource)) push(props.resource, /song/i.test(String(props.moduleName || '')) ? 'song' : 'playlist')
  if (looksLikeResource(props.carousel)) push(props.carousel)
  if (Array.isArray(props.carousel)) for (const item of props.carousel) pushNode(item)
  // 榜单：playlistIds / titles 可能是逗号分隔字符串
  const toList = (value: any): string[] => Array.isArray(value) ? value.map(String) : (typeof value === 'string' && value.trim() ? value.split(',').map(s => s.trim()) : [])
  const rankIds = toList(props.playlistIds)
  if (rankIds.length > 0) {
    const rankTitles = toList(props.titles)
    const rankTpls = toList(props.playlistTitleTpls)
    rankIds.forEach((id: any, i: number) => {
      const resource = normalizeNeteaseResource({
        resourceId: String(id), resourceType: 'toplist', action: `orpheus://playlist/${id}`,
        title: rankTitles[i] || rankTpls[i] || props.rankModuleTitle || '排行榜',
        subTitle: props.rankModuleTitle && props.rankModuleTitle !== rankTitles[i] ? String(props.rankModuleTitle) : '',
      }, index++)
      if (resource) out.push(resource)
    })
  }
  return out
}

/**
 * 单个 cube 子树 -> 区块列表。识别 Title/Text/RecommendHorizontal 作为分段标题，
 * Playlist/Album/Entrance 与 props 内的数组资源作为卡片。
 */
function cubeBlocksFromSubtree(root: any, fallbackTitle: string, baseIndex: number): { blocks: NeteaseNativeBlock[]; nextIndex: number } {
  const blocks: NeteaseNativeBlock[] = []
  let current: { title: string; resources: NeteaseNativeResource[] } | null = fallbackTitle ? { title: fallbackTitle, resources: [] } : null
  let index = baseIndex
  const flush = () => {
    if (current && current.resources.length > 0) {
      blocks.push({
        id: `cube-${blocks.length}-${index}`,
        blockCode: `NETEASE_CUBE_${blocks.length}`,
        showType: 'HOMEPAGE_SLIDE_PLAYLIST',
        title: current.title,
        subtitle: '',
        resources: dedupeNeteaseResources(filterNeteaseAdResources(current.resources)).slice(0, 60),
        raw: {},
      })
    }
    current = null
  }
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    const name = String(node.componentName || '')
    const props = node.props || {}
    const sectionTitle = name === 'Text'
      ? String(props.content || '').trim()
      : name === 'Title'
        ? titleOfCubeNode(props)
        : name === 'RecommendHorizontal'
          ? String(props.title || '').trim()
          : name === 'MusiclibraryRank'
            ? String(props.rankModuleTitle || props.title || '').trim()
            : ''
    if (sectionTitle) { flush(); current = { title: sectionTitle, resources: [] } }
    const ensure = () => { if (!current) current = { title: '', resources: [] }; return current }
    if (name === 'Playlist' || name === 'Album') {
      const resource = resourceFromCubeItem({ ...props, id: props.id ?? props.resourceId }, index++, name === 'Album' ? 'album' : 'playlist')
      if (resource) ensure().resources.push(resource)
    } else if (name === 'Entrance') {
      const resource = resourceFromCubeItem({ ...props, id: props.id ?? props.action?.params?.query }, index++, String(props.action?.params?.resourceType || ''))
      if (resource) ensure().resources.push(resource)
    } else {
      const extra = collectPropsResources(props, index)
      if (extra.length) { index += extra.length; ensure().resources.push(...extra) }
    }
    for (const child of node.children || []) walk(child)
  }
  walk(root)
  flush()
  return { blocks, nextIndex: index }
}

export interface NeteaseCubeTab { key: string; title: string; blocks: NeteaseNativeBlock[] }
export interface NeteaseCubePage { tabs: NeteaseCubeTab[]; blocks: NeteaseNativeBlock[] }

const TAB_COMPONENTS = new Set(['TabItem', 'MusicGenreSongListItem'])

function findTabContainer(node: any): any | null {
  if (!node || typeof node !== 'object') return null
  const children = Array.isArray(node.children) ? node.children : []
  if (children.filter((child: any) => TAB_COMPONENTS.has(String(child?.componentName || ''))).length >= 2) return node
  for (const child of children) {
    const found = findTabContainer(child)
    if (found) return found
  }
  return null
}

function tabTitleOf(node: any): string {
  const props = node.props || {}
  const direct = String(props.title || props.mainTitle || '').trim()
  if (direct) return direct
  const textChild = (node.children || []).find((child: any) => String(child?.componentName) === 'Text')
  return String(textChild?.props?.content || '').trim()
}

/**
 * 曲风频道（cube-renderer-rn）页面协议 -> 带页内子 Tab 的区块集合。
 * 实测两种模板：StickyTabs/TabItem（曲风编年）与 MusicGenreSongList/MusicGenreSongListItem（二次元）。
 * 子 Tab 数据在一次响应里全部下发，切换纯客户端行为。
 */
export function normalizeNeteaseCubePage(payload: any): NeteaseCubePage {
  const page = payload?.data?.pageProtocol?.pages?.[0]
  if (!page) return { tabs: [], blocks: [] }
  const container = findTabContainer(page)
  if (!container) {
    return { tabs: [], blocks: cubeBlocksFromSubtree(page, '', 0).blocks }
  }
  const tabs: NeteaseCubeTab[] = []
  const tabNodes = (container.children || []).filter((child: any) => TAB_COMPONENTS.has(String(child?.componentName || '')))
  let index = 0
  for (const tabNode of tabNodes) {
    const title = tabTitleOf(tabNode)
    const built = cubeBlocksFromSubtree(tabNode, '', index)
    index = built.nextIndex
    tabs.push({ key: `${tabNode.componentName}-${tabs.length}`, title: title || `分区 ${tabs.length + 1}`, blocks: built.blocks })
  }
  // Tab 容器之外的内容（页头推荐、导航等）单独成块，避免与子 Tab 内容重复
  const extras: NeteaseNativeBlock[] = []
  for (const child of container.children || []) {
    if (TAB_COMPONENTS.has(String(child?.componentName || ''))) continue
    extras.push(...cubeBlocksFromSubtree(child, '', index).blocks)
  }
  for (const child of page.children || []) {
    if (child === container) continue
    extras.push(...cubeBlocksFromSubtree(child, '', index).blocks)
  }
  // 保留空内容的页签（部分模块由客户端运行时再拉取），避免页签整体消失
  return { tabs: tabs.filter(tab => tab.title), blocks: extras }
}

/** 兼容旧调用：只要扁平区块 */
export function normalizeNeteaseCubeBlocks(payload: any): NeteaseNativeBlock[] {
  const page = normalizeNeteaseCubePage(payload)
  return [...page.blocks, ...page.tabs.flatMap(tab => tab.blocks)]
}

/** 播客无限流 data.blockVOS[] -> 区块 */
export function normalizeNeteasePodcastBlocks(payload: any): NeteaseNativeBlock[] {
  const blocks: Record<string, any>[] = Array.isArray(payload?.data?.blockVOS) ? payload.data.blockVOS : []
  return blocks
    .map(normalizeNeteaseBlock)
    .map((block: NeteaseNativeBlock) => ({ ...block, resources: dedupeNeteaseResources(filterNeteaseAdResources(block.resources)) }))
    .filter((block: NeteaseNativeBlock) => block.resources.length > 0)
}

export interface NeteasePodcastHome {
  blocks: NeteaseNativeBlock[]
  /** FINITE_DRAGONBALL：我的播客 / 全部分类 / 排行榜 / 音乐播客 / 对话现场 等固定入口 */
  quickEntries: NeteaseNativeResource[]
}

/** 播客 Tab 首页（podcast/home/tab/v2/get，9 个 blockVOS） */
export function normalizeNeteasePodcastHome(payload: any): NeteasePodcastHome {
  const blocks: Record<string, any>[] = Array.isArray(payload?.data?.blockVOS) ? payload.data.blockVOS : []
  const quickEntryBlock = blocks.find(block => /DRAGONBALL/i.test(String(block?.blockCode || '')))
  const quickEntries = quickEntryBlock
    ? dedupeNeteaseResources(filterNeteaseAdResources(normalizeNeteaseBlock(quickEntryBlock, 0).resources))
    : []
  const contentBlocks = blocks
    .filter(block => block !== quickEntryBlock)
    .map(normalizeNeteaseBlock)
    .map((block: NeteaseNativeBlock) => ({ ...block, resources: dedupeNeteaseResources(filterNeteaseAdResources(block.resources)) }))
    .filter((block: NeteaseNativeBlock) => block.resources.length > 0)
  return { blocks: contentBlocks, quickEntries }
}
