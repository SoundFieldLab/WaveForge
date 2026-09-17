import type { Song } from '../../services/musicApi'
import type { ExploreChannel, ExplorePlaylist } from '../../services/exploreApi'

// src/features/neteaseExplore/model.ts

export type NeteaseResourceAction =
  | { type: 'song'; song: Song }
  | { type: 'comments'; song: Song }
  | { type: 'playlist'; playlist: ExplorePlaylist; autoplay: boolean }
  | { type: 'album'; id: string }
  | { type: 'radio'; channel: ExploreChannel }
  | { type: 'program'; id: string }
  | { type: 'artist'; id: string }
  | { type: 'user'; id: string }
  | { type: 'mv'; id: string }
  | { type: 'fm'; fmMode: string; subMode: string; entranceType: string; title: string }
  | { type: 'similar-songs'; seedIds: string[] }
  | { type: 'similar-artists'; artistIds: string[] }
  | { type: 'daily-rcmd'; tab: 'default' | 'style'; categoryId: string; tagId: string; songId: string }
  | { type: 'podcast-mine' }
  | { type: 'podcast-categories' }
  | { type: 'song-id'; id: string }
  | { type: 'cube-page'; pageId: string; title: string }
  | { type: 'semantic'; text: string }
  | { type: 'web'; url: string }
  | { type: 'podcast-section'; section: 'mine' | 'categories' }
  | { type: 'none' }

export interface NeteaseNativeResource {
  id: string
  type: string
  title: string
  subtitle: string
  coverUrl: string
  purePictureUrl: string
  purePicture: boolean
  purePicName: string
  recommendationShowType: string
  actionUrl: string
  action: NeteaseResourceAction
  alg: string
  playCount?: number
  favoriteCount?: number
  isFavorite?: boolean
  song?: Song
  playlist?: ExplorePlaylist
  /** 推荐理由徽标，如「超76%人播放」「十万红心」「昨日上万播放」 */
  reason?: string
  /** 资源角标，如 VIP / SQ / Hi-Res */
  badge?: string
  /** 单曲卡自带的整栏播放队列（App 点一张卡播整栏） */
  playQueue?: { ids: string[]; start: number }
  /** 封面左上角的角标文字，如雷达歌单的 ['私人','雷达'] / ['云村','高分雷达']（App 逐行显示） */
  coverLabel?: string[]
  raw: Record<string, any>
}

export interface NeteaseNativeBlock {
  id: string
  /** 显式布局提示：grid=换行铺开的网格（播客/电台列表用），覆盖按类型推断的结果 */
  layout?: 'songs' | 'shelf' | 'grid'
  blockCode: string
  showType: string
  title: string
  subtitle: string
  /** 区块标题右侧「更多」的目标（服务端 showMore.action 原样带下来，优先于按 blockCode 猜的频道） */
  moreActionUrl?: string
  resources: NeteaseNativeResource[]
  raw: Record<string, any>
}

export interface NeteaseNativeHome {
  accountScoped: boolean
  generatedAt: number
  cursor: string
  hasMore: boolean
  blockCodeOrderList: string[]
  exposedResource: string
  blocks: NeteaseNativeBlock[]
  rawBlocks: Record<string, any>[]
}

export interface NeteaseNativeFlow {
  hasMore: boolean
  resources: NeteaseNativeResource[]
}

export type NeteaseShortcutKind = 'daily' | 'heart-mode' | 'radar' | 'roam' | 'similar' | 'similar-user' | 'podcast' | null

export function neteaseShortcutKind(resource: NeteaseNativeResource): NeteaseShortcutKind {
  const semantic = `${resource.title}${resource.purePicName}${resource.subtitle}${resource.actionUrl}`
  if (/每日推荐|日推/.test(semantic)) return 'daily'
  if (/心动/.test(semantic)) return 'heart-mode'
  if (resource.action.type === 'playlist' && /雷达|反复聆听你爱的歌/.test(semantic)) return 'radar'
  if (/漫游|私人漫游|私人FM|私人 FM/.test(semantic)) return 'roam'
  if (/相似歌曲|相似推荐/.test(semantic)) return 'similar'
  if (/相似用户|相似艺人/.test(semantic)) return 'similar-user'
  if (/每日播客|播客/.test(semantic)) return 'podcast'
  return null
}

function textOf(value: any): string {
  if (typeof value === 'string') return value
  return String(value?.title || value?.text || value?.name || '')
}

function firstText(...values: any[]): string {
  for (const value of values) {
    const text = textOf(value)
    if (text.trim()) return text.trim()
  }
  return ''
}

function imageOf(value: any): string {
  if (typeof value === 'string') return value.trim().replace(/^http:/, 'https:')
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = imageOf(item)
      if (nested) return nested
    }
    return ''
  }
  for (const key of ['purePictureUrl', 'imageUrl', 'backupImageUrl', 'picUrl', 'picurl', 'blurPicUrl', 'coverUrl', 'coverImgUrl', 'coverImageUrl', 'coverImg', 'iconUrl', 'tagImgUrl', 'imgUrl', 'pictureUrl', 'background', 'bgUrl', 'url']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().replace(/^http:/, 'https:')
    if (candidate && typeof candidate === 'object') {
      const nested = imageOf(candidate)
      if (nested) return nested
    }
  }
  for (const key of ['image', 'images', 'uiElement', 'resourceUiElement', 'picture', 'artwork', 'cover', 'customView', 'resource', 'resourceInfo', 'resourceExtInfo', 'creativeExtInfoVO', 'crossPlatformConfig']) {
    const nested = imageOf(value[key])
    if (nested) return nested
  }
  return ''
}

function firstImage(...values: any[]): string {
  for (const value of values) {
    const image = imageOf(value)
    if (image) return image
    if (value && typeof value === 'object') {
      for (const nested of [value.image, value.backgroundImage, value.cover, value.album, value.radio, value.djProgram]) {
        const nestedImage = imageOf(nested)
        if (nestedImage) return nestedImage
      }
    }
  }
  return ''
}

function songOf(value: any): Song | undefined {
  const source = value?.songData || value?.song || value?.mainSong || value?.resourceExtInfo?.songData || value?.resourceExtInfo?.song || value?.creativeExtInfoVO?.songData || value?.creativeExtInfoVO?.song || value?.creativeExtInfoVO?.djProgram?.mainSong
  if (!source) return undefined
  // 播客节目（djProgram/radio）出来的音频没有歌词与 MV：打标后播放页自动纯音乐样式
  const isPodcastSong = Boolean(
    source === value?.creativeExtInfoVO?.djProgram?.mainSong
    || source === value?.resourceExtInfo?.djProgram?.mainSong
    || value?.djProgram || value?.radio || source?.radio
    || value?.resourceExtInfo?.djProgram || value?.creativeExtInfoVO?.djProgram,
  )
  const track = source?.simpleSong || source
  const id = Number(track?.id || 0)
  if (!id || !track?.name) return undefined
  const album = track.al || track.album || {}
  const artists = track.ar || track.artists || []
  return {
    id,
    name: String(track.name),
    artists: (Array.isArray(artists) ? artists : []).map((artist: any) => ({ id: Number(artist?.id) || undefined, name: String(artist?.name || '未知歌手') })),
    album: { id: Number(album?.id) || undefined, name: String(album?.name || ''), picUrl: imageOf(album) || imageOf(value?.uiElement?.image) || imageOf(value) },
    duration: Number(track.dt || track.duration || 0),
    platform: 'netease',
    fee: Number(track.fee || 0),
    vip: Number(track.fee) === 1,
    requiredTier: Number(track.fee) === 1 ? 'vip' : 'free',
    noCopyright: Number(track.privilege?.st) < 0,
    isPodcast: isPodcastSong || undefined,
    commentCount: Number(track.commentCount || value?.resourceInteractInfo?.commentCount || 0) || undefined,
  }
}

/** 字段可能是对象，也可能是 JSON 字符串（App 对部分模板把 playBtn/clickAction 序列化成字符串下发） */
function objectOf(value: any): any {
  if (!value) return undefined
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/** 「根据你喜爱的歌曲推荐」这类区块的单曲卡不带内嵌 song 对象，也常常没有 action/orpheus：
 *  播放信息只落在 playBtn.playAction.songIds 与 clickAction.msg.params.songIds 里（整栏队列）。
 *  这里把队列抽出来，供 actionOf 生成可播放动作。 */
export function playQueueOf(value: any): string[] {
  const playBtn = objectOf(value?.playBtn) || objectOf(value?.playBtnData)
  const clickAction = objectOf(value?.clickAction)
  const candidates = [
    playBtn?.playAction?.songIds,
    objectOf(playBtn?.playAction)?.songIds,
    clickAction?.msg?.params?.songIds,
    objectOf(value?.action)?.msg?.params?.songIds,
    Array.isArray(playBtn?.songIds) ? playBtn.songIds : undefined,
  ]
  for (const list of candidates) {
    if (Array.isArray(list) && list.length > 0) {
      const ids = list.map((item: any) => String(item)).filter((item: string) => /^\d+$/.test(item))
      if (ids.length > 0) return ids
    }
  }
  return []
}

/** 单曲卡的播放起始下标（App 按点击项在该栏中的位置起播） */
function playStartIndexOf(value: any): number {
  const playBtn = objectOf(value?.playBtn) || objectOf(value?.playBtnData)
  const clickAction = objectOf(value?.clickAction)
  const raw = playBtn?.playAction?.songIndex ?? objectOf(playBtn?.playAction)?.songIndex ?? clickAction?.msg?.params?.songIndex
  const index = Number(raw)
  return Number.isInteger(index) && index >= 0 ? index : 0
}

/** 只有标题/歌手/封面 + 播放队列、没有内嵌 song 对象的卡片，用卡片自身字段拼一个最小 Song，
 *  让 SongRow 能渲染、收藏能工作、播放页有名字与封面。 */
function songFromCardFields(value: any, resourceId: string): Song | undefined {
  const id = Number(resourceId)
  const name = textOf(value?.title) || textOf(value?.songName)
  if (!id || !name) return undefined
  const artistName = textOf(value?.artistName) || textOf(value?.subTitle) || textOf(value?.artist)
  return {
    id,
    name,
    artists: artistName ? artistName.split(/\s*\/\s*|\s*、\s*/).filter(Boolean).map(artist => ({ name: artist })) : [],
    album: { name: '', picUrl: imageOf(value?.coverUrl) || imageOf(value?.coverImg) || imageOf(value?.uiElement?.image) || imageOf(value) },
    duration: Number(value?.duration || value?.dt || 0),
    platform: 'netease',
    fee: Number(value?.fee || 0),
    vip: Number(value?.fee) === 1,
    requiredTier: Number(value?.fee) === 1 ? 'vip' : 'free',
    noCopyright: false,
  }
}

function recursiveCandidates(value: any, output: Record<string, any>[], seen: Set<any>, depth = 0, inherited: Record<string, any> = {}) {
  if (!value || typeof value !== 'object' || depth > 10 || seen.has(value)) return
  seen.add(value)
  const inheritedUi = inherited.uiElement || inherited.resourceUiElement || {}
  const ownUi = value.uiElement || value.resourceUiElement || {}
  const mergedUi = {
    ...inheritedUi,
    ...ownUi,
    image: ownUi.image || inheritedUi.image,
    backgroundImage: ownUi.backgroundImage || inheritedUi.backgroundImage,
    mainTitle: value.mainTitle || ownUi.mainTitle || inheritedUi.mainTitle,
    subTitle: value.subTitle || ownUi.subTitle || inheritedUi.subTitle,
    purePictureUrl: ownUi.purePictureUrl || inheritedUi.purePictureUrl,
    purePicture: ownUi.purePicture ?? inheritedUi.purePicture,
    purePicName: ownUi.purePicName || inheritedUi.purePicName,
    rcmdShowType: ownUi.rcmdShowType || inheritedUi.rcmdShowType,
  }
  const merged = Object.keys(inherited).length > 0
    ? { ...inherited, ...value, uiElement: mergedUi, mainTitle: value.mainTitle || inherited.mainTitle, subTitle: value.subTitle || inherited.subTitle }
    : value
  const hasNestedResources = (Array.isArray(value.resources) && value.resources.length > 0) || (Array.isArray(value.resourceInfoList) && value.resourceInfoList.length > 0)
  const hasEmbeddedSong = Boolean(value.song || value.songData || value.resourceExtInfo?.song || value.resourceExtInfo?.songData || value.creativeExtInfoVO?.song || value.creativeExtInfoVO?.songData)
  const isProgramObject = Boolean(value.id && value.mainSong && value.radio)
  const isCreative = value.creativeId != null
  const isResource = value.resourceId != null
  // 模块的 header 节点（`{showMore:true, action, title}`）只是分区标题，不是卡片。
  // 它自带 action+title，会被下面的 isActionResource 当成资源产出，渲染成一张灰色空卡
  // （实测「听精品有声书」12 本有声书上面多出一张同名空卡）。
  // 只认「带 showMore 标志、无任何图片、也没有子资源列表」的纯标题节点，避免误伤区块容器/快捷卡。
  const isModuleHeader = value.showMore === true
    && value.resourceId == null && value.creativeId == null
    && !hasEmbeddedSong && !hasNestedResources
    && !value.uiElement && !value.imageUrl && !value.coverUrl && !value.coverImg && !value.image
  if (isModuleHeader) return
  const isActionResource = Boolean(value.action || value.orpheus || value.targetUrl || value.uiElement?.button?.action)
    && Boolean(value.uiElement || value.mainTitle || value.coverImageUrl || value.imageUrl || value.purePictureUrl || value.coverImg || value.coverImgUrl || value.title)
  // 创意卡自身带 uiElement 图片与 action；其 resources 只是同一条内容的补充字段。
  // 这里合并资源 id 后直接产出，避免只取到无图的子资源导致封面丢失（实测「音乐新发现」正是如此）。
  if (isCreative) {
    const first = [
      ...(Array.isArray(value.resources) ? value.resources : []),
      ...(Array.isArray(value.resourceInfoList) ? value.resourceInfoList : []),
    ].find((item: any) => item?.resourceId != null)
    const mergedCreative = first && value.resourceId == null
      ? {
        ...value,
        resourceId: first.resourceId,
        resourceType: /^(voice|program|song|playlist|album|djradio|voicelist|mv|toplist)$/i.test(String(first.resourceType || ''))
          ? first.resourceType
          : (value.resourceType || first.resourceType),
        resourceExtInfo: first.resourceExtInfo ?? value.resourceExtInfo,
        resourceExt: first.resourceExt ?? value.resourceExt,
        action: value.action ?? first.action,
        orpheus: value.orpheus ?? first.orpheus,
        targetUrl: value.targetUrl ?? first.targetUrl,
      }
      : value
    output.push(mergedCreative)
    return
  }
  if (isResource || isProgramObject || hasEmbeddedSong || isActionResource) output.push(merged)
  if ((isCreative && !hasNestedResources) || isProgramObject) return
  const nextInherited = {
    ...inherited,
    ...(value.uiElement ? { uiElement: value.uiElement } : {}),
    ...(value.resourceUiElement ? { resourceUiElement: value.resourceUiElement } : {}),
    ...(value.coverImageUrl ? { coverImageUrl: value.coverImageUrl } : {}),
    ...(value.imageUrl ? { imageUrl: value.imageUrl } : {}),
    ...(value.purePictureUrl ? { purePictureUrl: value.purePictureUrl } : {}),
    ...(value.mainTitle ? { mainTitle: value.mainTitle } : {}),
    ...(value.subTitle ? { subTitle: value.subTitle } : {}),
    ...(value.action ? { action: value.action } : {}),
    ...(value.targetUrl ? { targetUrl: value.targetUrl } : {}),
    ...(value.imageUrl ? { imageUrl: value.imageUrl } : {}),
    ...(value.resourceExtInfo?.coverImageUrl ? { coverImageUrl: value.resourceExtInfo.coverImageUrl } : {}),
    ...(value.resourceExtInfo?.imageUrl ? { imageUrl: value.resourceExtInfo.imageUrl } : {}),
    ...(value.creativeExtInfoVO?.coverImageUrl ? { coverImageUrl: value.creativeExtInfoVO.coverImageUrl } : {}),
    ...(value.creativeExtInfoVO?.imageUrl ? { imageUrl: value.creativeExtInfoVO.imageUrl } : {}),
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => recursiveCandidates(item, output, seen, depth + 1, nextInherited))
    else recursiveCandidates(child, output, seen, depth + 1, nextInherited)
  }
}

function numericIdFromAction(action: string, kind: string): string {
  const direct = action.match(new RegExp(`orpheus:\\/\\/(?:nm\\/)?${kind}\\/(\\d+)`, 'i'))
  if (direct?.[1]) return direct[1]
  try {
    const parsed = new URL(action)
    const specific = parsed.searchParams.get(`${kind}Id`)
    if (specific) return specific
    // 裸 id 只在路径段匹配该 kind 时才采用：`orpheus://nm/voicelist/detail?id=123` 属于 voicelist，
    // 不能因为带个 id 就被当成 playlist（实测「听精品有声书」的有声书卡片正是被这样误判）。
    const id = parsed.searchParams.get('id') || ''
    if (!id) return ''
    const path = `${parsed.hostname}${parsed.pathname}`.toLowerCase()
    return path.includes(kind.toLowerCase()) ? id : ''
  } catch {
    return ''
  }
}

function safeWebUrl(action: string): string {
  if (/^https:\/\//i.test(action)) return action
  if (!/^orpheus:\/\/(?:openurl|rnpage|miniProgram|activity)/i.test(action)) return ''
  try {
    const parsed = new URL(action)
    for (const key of ['url', 'fallbackURL', 'fallbackUrl']) {
      const candidate = parsed.searchParams.get(key)
      if (candidate && /^https:\/\//i.test(candidate)) return candidate
    }
  } catch {
    return ''
  }
  return ''
}

function channelOf(value: any, id: string, title: string, subtitle: string, coverUrl: string): ExploreChannel {
  return {
    id,
    name: title || value?.radio?.name || '网易云播客',
    group: String(value?.category || value?.radio?.category || '播客'),
    description: subtitle || String(value?.description || value?.radio?.desc || ''),
    coverUrl,
    playCount: Number(value?.playCount || value?.listenerCount || value?.subCount || 0) || undefined,
    platform: 'netease',
  }
}

function parseSimilarFmSeeds(actionUrl: string): { seeds: string[]; isArtist: boolean } {
  const isArtist = /sourceType=artist/i.test(actionUrl)
  const match = actionUrl.match(/sourceId=\[([^\]]*)\]/)
  if (!match) return { seeds: [], isArtist }
  const seeds = match[1]
    .replace(/["\\\s]/g, '')
    .split(',')
    .map(value => value.trim())
    .filter(value => /^\d+$/.test(value))
  return { seeds, isArtist }
}

function actionOf(value: any, type: string, id: string, actionUrl: string, title: string, subtitle: string, coverUrl: string, song?: Song): NeteaseResourceAction {
  const normalizedType = type.toLowerCase()
  // 日推/风格日推：orpheus://songrcmd?tab=default|style&categoryId=..&tagId=..&songId=..
  if (/orpheus:\/\/songrcmd/i.test(actionUrl)) {
    try {
      const parsed = new URL(actionUrl)
      const tab = parsed.searchParams.get('tab') === 'style' ? 'style' : 'default'
      return {
        type: 'daily-rcmd',
        tab,
        categoryId: parsed.searchParams.get('categoryId') || '',
        tagId: parsed.searchParams.get('tagId') || '',
        songId: parsed.searchParams.get('songId') || '',
      }
    } catch {
      return { type: 'daily-rcmd', tab: 'default', categoryId: '', tagId: '', songId: '' }
    }
  }
  // rnpage 承载的 cube 页（如「宝藏音乐人」）：用同一套 cube 渲染器在站内打开
  if (/component=cube-renderer-rn/i.test(actionUrl)) {
    const pageMatch = actionUrl.match(/[?&]page=([a-z0-9]{8,64})/i)
    if (pageMatch) return { type: 'cube-page', pageId: pageMatch[1], title }
  }
  // 云村出品：内容是编辑歌单，落到「发现-歌单」
  if (/resId=xrn|xrn/i.test(actionUrl)) return { type: 'semantic', text: '云村出品' }
  // 首页里的排行榜入口 / 新歌新碟页：交给上层跳到「发现」对应频道
  if (/rn-ranklist-homepage/i.test(actionUrl)) return { type: 'semantic', text: '排行榜' }
  if (/nm\/discovery\/newsongalbum/i.test(actionUrl)) return { type: 'semantic', text: '新歌新碟' }
  // 榜单内歌曲：裸动作 + 数字 id，按歌曲详情播放
  if (/^play_top_list/i.test(actionUrl) && /^\d+$/.test(id)) return { type: 'song-id', id }
  // 新歌新碟等直接给歌曲链接的卡片：拉一次详情再播放
  const songLinkMatch = actionUrl.match(/^orpheus:\/\/song\/(\d+)/i)
  if (songLinkMatch) return { type: 'song-id', id: songLinkMatch[1] }
  // 播客固定入口（App 内 RN 页 → 站内原生页面）
  if (/component=rn-podcast-my|rn-podcast-my\b/i.test(actionUrl)) return { type: 'podcast-mine' }
  if (/nm\/voice\/category|component=rn-podcast-category|component=rn-podcast-rank/i.test(actionUrl)) return { type: 'podcast-categories' }
  // 小程序入口（广播电台等）：带 fallbackURL 的用站内网页面板直接打开真实页面
  // （实测「广播」的电台卡带 mp.music.163.com 的 H5），没有 H5 的才落到站内「全部分类」按名字找。
  if (/orpheus:\/\/miniProgram/i.test(actionUrl)) {
    const miniWebUrl = safeWebUrl(actionUrl)
    if (miniWebUrl) return { type: 'web', url: miniWebUrl }
    return { type: 'podcast-categories' }
  }
  // 推荐页「相似歌曲 / 相似艺人」走 play/similarFM，种子来自卡片自带 sourceId，不依赖当前播放
  if (/play\/similarFM/i.test(actionUrl)) {
    const { seeds, isArtist } = parseSimilarFmSeeds(actionUrl)
    return isArtist ? { type: 'similar-artists', artistIds: seeds } : { type: 'similar-songs', seedIds: seeds }
  }
  // 曲风页「一键播放/漫游」入口：type=fm，携带 mode/subMode（如 SCENE_RCMD + ACG）
  if (normalizedType === 'fm' || (value?.mode === 'SCENE_RCMD' && value?.subMode)) {
    return {
      type: 'fm',
      fmMode: String(value?.mode || 'SCENE_RCMD'),
      subMode: String(value?.subMode || ''),
      entranceType: String(value?.entranceType || ''),
      title,
    }
  }
  const playlistId = /^(list|playlist|toplist|songlist_homepage)$/i.test(type)
    ? String(value.resourceId || numericIdFromAction(actionUrl, 'playlist') || id)
    : numericIdFromAction(actionUrl, 'playlist')
  if (playlistId) {
    const playlist: ExplorePlaylist = {
      id: playlistId,
      name: title || '网易云歌单',
      coverUrl,
      description: subtitle,
      playCount: Number(value.playCount || value.playcount || 0) || undefined,
      trackCount: Number(value.trackCount || value.resourceExtInfo?.trackCount || 0) || undefined,
      creator: value.creator?.nickname || value.userName || undefined,
      userId: value.userId || value.creator?.userId || value.resourceExtInfo?.userId,
      isCollected: Boolean(value.isCollected || value.subscribed || value.resourceInteractInfo?.collect),
      subscribed: Boolean(value.isCollected || value.subscribed || value.resourceInteractInfo?.collect),
      platform: 'netease',
      source: /toplist/i.test(type) ? 'netease-native-toplist' : 'netease-native-feed',
    } as ExplorePlaylist
    return { type: 'playlist', playlist, autoplay: /[?&]autoplay=1/.test(actionUrl) }
  }

  const albumId = /album/i.test(normalizedType) ? String(value.resourceId || numericIdFromAction(actionUrl, 'album') || id) : numericIdFromAction(actionUrl, 'album')
  if (albumId) return { type: 'album', id: albumId }

  const programSource = value?.creativeExtInfoVO?.djProgram || value
  const programId = /^(voice|program)$/i.test(type) || (programSource?.id && programSource?.mainSong && programSource?.radio)
    ? String(programSource?.id || value.resourceId || numericIdFromAction(actionUrl, 'program') || id)
    : numericIdFromAction(actionUrl, 'program')
  if (programId) return { type: 'program', id: programId }

  const radioId = /^(voicelist|djradio|broadcast)$/i.test(type)
    ? String(value.resourceId || value.radio?.id || id)
    : numericIdFromAction(actionUrl, 'djradio') || numericIdFromAction(actionUrl, 'voicelist')
  if (radioId) return { type: 'radio', channel: channelOf(value, radioId, title, subtitle, coverUrl) }

  const artistId = numericIdFromAction(actionUrl, 'artist') || (/artist/i.test(normalizedType) ? String(value.resourceId || value.artist?.id || id) : '')
  if (artistId) return { type: 'artist', id: artistId }

  const userId = numericIdFromAction(actionUrl, 'user') || (/^(user|profile)$/i.test(type) ? String(value.resourceId || value.userId || value.profile?.userId || id) : '')
  if (userId) return { type: 'user', id: userId }

  const nestedMvId = value.resourceInfoList?.find((item: any) => item?.resourceId)?.resourceId || value.songData?.mv || value.song?.mv || value.songData?.mvid || value.song?.mvid
  const mvId = /^mv$/i.test(type) ? String(nestedMvId || numericIdFromAction(actionUrl, 'mv') || '') : numericIdFromAction(actionUrl, 'mv')
  if (mvId && mvId !== '0') return { type: 'mv', id: mvId }

  if (song && /^comment$/i.test(type)) return { type: 'comments', song }
  if (song) return { type: 'song', song }

  const webUrl = safeWebUrl(actionUrl)
  if (webUrl) return { type: 'web', url: webUrl }
  if (type === 'mypodcast' || /component=rn-podcast-my/i.test(actionUrl)) return { type: 'podcast-section', section: 'mine' }
  if (type === 'category' || /component=rn-podcast-category/i.test(actionUrl)) return { type: 'podcast-section', section: 'categories' }
  // 服务端偶发下发裸文案动作（如「心动模式」），交给上层按语义执行
  if (actionUrl && actionUrl.length <= 24 && !/[/:\\]/.test(actionUrl)) return { type: 'semantic', text: actionUrl }
  return { type: 'none' }
}

export function normalizeNeteaseResource(value: Record<string, any>, index: number): NeteaseNativeResource | null {
  const ui = value.uiElement || value.resourceUiElement || {}
  const ext = value.resourceExtInfo || value.creativeExtInfoVO || value.extInfo || {}
  // 「根据你喜爱的歌曲推荐」「VIP专属好歌」这类单曲卡没有内嵌 song 对象，只有卡片自带字段 +
  // playBtn/clickAction 里的播放队列；用卡片字段补一个最小 Song，否则整块会因无可用动作被丢弃。
  const queue = playQueueOf(value)
  const song = songOf(value) || (queue.length > 0 ? songFromCardFields(value, String(value.resourceId ?? value.id ?? queue[0])) : undefined)
  const type = String(value.resourceType || value.creativeType || (song ? 'song' : '')).toLowerCase()
  const actionUrl = String(value.action || value.orpheus || value.targetUrl || ui?.button?.action || '')
  const actionResourceId = actionUrl.match(/(?:playlist|album|song|mv|artist|user|program)(?:\/|\?|:)(?:id=)?(\d+)/i)?.[1] || ''
  const id = String(value.resourceId ?? value.creativeId ?? value.programId ?? value.id ?? song?.id ?? actionResourceId ?? '')
  const title = textOf(ui.mainTitle) || textOf(value.mainTitle) || textOf(value) || song?.name || ''
  const subtitle = textOf(ui.subTitle) || textOf(value.subTitle) || textOf(ext?.artist) || song?.artists.map(artist => artist.name).join(' / ') || ''
  // 组卡（榜单/创意组）自身常无封面：回退首个子资源封面，避免出现无图灰卡（实测「音乐播客榜」）
  const nestedCover = [
    ...(Array.isArray(value.resources) ? value.resources : []),
    ...(Array.isArray(value.resourceInfoList) ? value.resourceInfoList : []),
  ].find((item: any) => item && (item.uiElement?.image || item.coverImageUrl || item.resourceExtInfo?.djProgram?.coverUrl))
  const coverUrl = firstImage(
    ui.image,
    ui.backgroundImage,
    value.coverImageUrl,
    value.imageUrl,
    value.coverUrl,
    value.coverImg,
    nestedCover?.uiElement?.image,
    nestedCover?.coverImageUrl,
    nestedCover?.resourceExtInfo?.djProgram?.coverUrl,
    value,
    value.resourceExtInfo?.coverImageUrl,
    value.creativeExtInfoVO?.coverImageUrl,
    value.extInfo?.coverImageUrl,
    value.extInfo?.imageUrl,
    ext,
    song?.album.picUrl,
  )
  const purePictureValue = ui.purePicture?.purePicture ?? ui.purePicture ?? value.purePicture?.purePicture ?? value.purePicture
  const purePictureUrl = imageOf(ui.purePictureUrl?.purePictureUrl || ui.purePictureUrl || value.purePictureUrl?.purePictureUrl || value.purePictureUrl)
  const interact = value.resourceInteractInfo || ext.resourceInteractInfo || {}
  const sourceSong = value?.songData || value?.song || value?.mainSong || value?.resourceExtInfo?.songData || value?.resourceExtInfo?.song || value?.creativeExtInfoVO?.songData || value?.creativeExtInfoVO?.song
  const favoriteCount = Number(
    sourceSong?.starCount || sourceSong?.starredNum || sourceSong?.redCount
      || value.starCount || value.starredNum || value.redCount || value.redCountValue
      || interact.redCount || interact.collectCount || 0,
  ) || undefined
  const isSongFavorite = song
    ? Boolean(interact.collect ?? sourceSong?.starred ?? sourceSong?.starStatus ?? value.starred ?? value.starStatus ?? ext.starred)
    : undefined
  if (!id && !title && !coverUrl && !purePictureUrl) return null
  const action = actionOf(value, type, id, actionUrl, title, subtitle, coverUrl, song)
  return {
    id: id || `${type || 'resource'}-${index}`,
    type: type || 'unknown',
    title: title || '推荐内容',
    subtitle,
    coverUrl,
    purePictureUrl,
    purePicture: purePictureValue === true || String(purePictureValue) === '1' || String(purePictureValue).toLowerCase() === 'true',
    purePicName: textOf(ui.purePicName?.purePicName || ui.purePicName || value.purePicName?.purePicName || value.purePicName),
    recommendationShowType: textOf(ui.rcmdShowType?.rcmdShowType || ui.rcmdShowType || value.rcmdShowType?.rcmdShowType || value.rcmdShowType),
    actionUrl,
    action,
    alg: String(value.alg || value.track?.s_calg || ''),
    playCount: Number(value.playCount || value.playcount || ext.playCount || interact.playCount || 0) || undefined,
    favoriteCount,
    isFavorite: isSongFavorite,
    song,
    playlist: action.type === 'playlist' ? action.playlist : undefined,
    // 单曲卡右上角的推荐理由徽标（「超76%人播放」「十万红心」「VIP」等）与搜索/榜单角标
    reason: textOf(value.recReason) || textOf(value.reasonText) || textOf(value.tagText),
    badge: textOf(value.tag) || textOf(value.tagText),
    /** playBtn/clickAction 自带的整栏播放队列（含起始下标），单曲卡用它连播整栏 */
    playQueue: queue.length > 0 ? { ids: queue, start: Math.min(playStartIndexOf(value), queue.length - 1) } : undefined,
    coverLabel: coverLabelOf(value),
    raw: value,
  }
}

/** 封面左上角的角标：雷达歌单每张卡带 `resourceExtInfo.coverText`，实测为 ['私人','雷达'] 这类 1~2 行短词。 */
function coverLabelOf(value: any): string[] | undefined {
  const raw = value?.resourceExtInfo?.coverText ?? value?.coverText ?? value?.creativeExtInfoVO?.coverText
  const list = (Array.isArray(raw) ? raw : [raw]).map((item: any) => String(item ?? '').trim()).filter(Boolean)
  return list.length > 0 ? list.slice(0, 2) : undefined
}

export function neteaseResourceArtwork(resource: NeteaseNativeResource): string {
  const pure = resource.purePicture === true || String(resource.raw?.purePicture?.purePicture ?? resource.raw?.purePicture ?? '').toLowerCase() === 'true' || String(resource.raw?.purePicture?.purePicture ?? resource.raw?.purePicture ?? '') === '1'
  return firstImage(
    ...(pure ? [resource.purePictureUrl, resource.raw?.purePictureUrl] : []),
    resource.coverUrl,
    resource.raw?.coverImageUrl,
    resource.raw?.coverUrl,
    resource.raw?.imageUrl,
    resource.raw?.uiElement?.image,
    resource.raw?.resourceUiElement?.image,
    resource.raw?.resourceInfoList,
    resource.raw,
  )
}

export function neteaseResourceKey(resource: NeteaseNativeResource): string {
  if (resource.song?.id) return `song:${resource.song.id}`
  if (resource.action.type === 'playlist') return `playlist:${resource.action.playlist.id}`
  if (resource.action.type === 'album' || resource.action.type === 'program' || resource.action.type === 'artist' || resource.action.type === 'user' || resource.action.type === 'mv') return `${resource.action.type}:${resource.action.id}`
  return `${resource.type}:${resource.id || resource.actionUrl || resource.title}`
}

/** 去掉既无跳转目标、也无歌曲/歌单内容的纯装饰卡，避免出现点不动的灰卡 */
export function filterNeteaseActionable(resources: NeteaseNativeResource[]): NeteaseNativeResource[] {
  return resources.filter(resource => {
    // 无封面、无歌曲/歌单的纯跳转卡（如区块自带的「新歌新碟」入口）视觉上是空卡，直接不产出
    if (resource.action.type === 'semantic' && !resource.coverUrl && !resource.song && !resource.playlist) return false
    if (resource.action.type !== 'none') return true
    if (resource.actionUrl) return true
    if (resource.song || resource.playlist) return true
    return false
  })
}

/** 同一内容的所有形态键：播客节目会同时以 voice 卡、djProgram 对象、mainSong 出现，
 *  只按主键去重会漏掉（实测「音乐播客榜」每条节目渲染两次），按别名并集去重。 */
function neteaseResourceAliases(resource: NeteaseNativeResource): string[] {
  const aliases = new Set<string>([neteaseResourceKey(resource)])
  if (resource.song?.id) aliases.add(String.raw`song:${resource.song.id}`)
  const action = resource.action
  if (action.type === 'program' && 'id' in action && action.id) aliases.add(String.raw`program:${action.id}`)
  if (resource.id && /^[0-9]+$/.test(resource.id)) aliases.add(String.raw`${resource.type}:${resource.id}`)
  return [...aliases]
}
export function dedupeNeteaseResources(resources: NeteaseNativeResource[]): NeteaseNativeResource[] {
  const seen = new Set<string>()
  return resources.filter(resource => {
    const aliases = neteaseResourceAliases(resource)
    if (aliases.some(key => seen.has(key))) return false
    aliases.forEach(key => seen.add(key))
    return true
  })
}

/** Link Platform 的分区标题散落在 dslData 的多层模板节点里，位置随模板而变。实测 9.5.90 有五种：
 *  `dslData.blockResource.title`、`dslData.<模块key>.blockResource.title`、`dslData.<模块key>.header.title`、
 *  `dslData.<模块key>.title`、`dslData.<模块key>.blockTitle`（另有 dslData.data.title / dslData.header.title）。
 *  只在「模板节点自身」找标题——不下钻 items/resources，避免把卡片标题当成区块标题。 */
function blockTitleFromDsl(dslData: any): string {
  if (!dslData || typeof dslData !== 'object') return ''
  const own = (node: any): string => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return ''
    // 模板节点里承载标题的子对象，按优先级取第一个非空
    for (const key of ['blockResource', 'header', 'commonTitle', 'track']) {
      const nested = node[key]
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const text = textOf(nested)
        if (text.trim()) return text.trim()
      }
    }
    for (const key of ['blockTitle', 'title']) {
      const text = typeof node[key] === 'string' ? node[key] : textOf(node[key])
      if (text.trim()) return text.trim()
    }
    return ''
  }
  // dslData 自身可能直接挂 blockResource / header / data
  const top = own(dslData)
  if (top) return top
  if (dslData.data && typeof dslData.data === 'object') {
    const text = own(dslData.data)
    if (text) return text
  }
  // 否则遍历各模板节点（key 形如 home_xxx_module_yyy），取第一个带标题的
  for (const [key, node] of Object.entries(dslData)) {
    if (key === 'dslShowTitle' || key === 'code' || key === 'responseFrom') continue
    const text = own(node)
    if (text) return text
  }
  return ''
}

/** 区块级「更多」入口的目标：服务端把它挂在带 showMore 的模板节点上（如排行榜块 → 发现-音乐-排行榜）。 */
function blockMoreActionOf(value: any): string {
  const roots = [value?.dslData, value?.nativeData, value?.crossPlatformConfig?.dslContent]
  const found: string[] = []
  const walk = (node: any, depth: number) => {
    if (found.length > 0 || !node || typeof node !== 'object' || depth > 8) return
    if (Array.isArray(node)) { node.forEach(item => walk(item, depth + 1)); return }
    if (node.showMore === true && typeof node.action === 'string' && node.action.trim()) {
      found.push(node.action.trim())
      return
    }
    for (const child of Object.values(node)) walk(child, depth + 1)
  }
  roots.forEach(root => walk(root, 0))
  return found[0] || ''
}

export type NeteaseBlockMoreTarget =
  | { kind: 'discover'; tab: 'music' | 'podcast'; channelCode?: string }
  | { kind: 'artist'; artistId: string }

/** 解析区块「更多」的站内落点。优先用服务端 showMore 动作，其次按 blockCode 语义推断。
 *  返回 null 表示该块没有更多入口（此时不渲染「更多」按钮，避免点了没反应）。 */
export function neteaseBlockMoreTarget(block: Pick<NeteaseNativeBlock, 'blockCode' | 'moreActionUrl'>): NeteaseBlockMoreTarget | null {
  const url = block.moreActionUrl || ''
  if (url) {
    // 排行榜的落点在 subParams 里：...exploreTabCode=music&subParams={"tabCode":"chart"}，
    // 必须比 exploreTabCode=music 先判，否则会被当成「精选」。
    if (/tabCode["':=\s]*chart/i.test(url) || /rn-ranklist-homepage/i.test(url)) return { kind: 'discover', tab: 'music', channelCode: 'chart' }
    if (/tabCode["':=\s]*vip/i.test(url)) return { kind: 'discover', tab: 'music', channelCode: 'vip' }
    if (/exploreTabCode=podcast|component=rn-podcast-rank/i.test(url)) return { kind: 'discover', tab: 'podcast' }
    if (/exploreTabCode=(music|feature)/i.test(url)) return { kind: 'discover', tab: 'music', channelCode: 'feature' }
    const artistId = url.match(/nm\/artist\/home\?id=(\d+)/i)?.[1]
    if (artistId) return { kind: 'artist', artistId }
  }
  const code = String(block.blockCode || '').toUpperCase()
  if (/PODCAST|VOICE|AUDIO_BOOK|BROADCAST|FM_CHANNEL/.test(code)) return { kind: 'discover', tab: 'podcast' }
  if (/RANK|TOPLIST/.test(code)) return { kind: 'discover', tab: 'music', channelCode: 'chart' }
  if (/NEW_SONG|NEW_ALBUM|NEWSONG/.test(code)) return { kind: 'discover', tab: 'music', channelCode: 'feature' }
  if (/PLAYLIST|SHEET|STYLE|SCENE|COMBINATION|RADAR|CLOUD_VILLAGE|MIXED_ARTIST|QUALITY_SONG_LIST|TREASURE/.test(code)) return { kind: 'discover', tab: 'music', channelCode: 'playlist' }
  return null
}

export function normalizeNeteaseBlock(value: Record<string, any>, index: number): NeteaseNativeBlock {
  const ui = value.uiElement || {}
  const directRoots = [
    ...(Array.isArray(value.creatives) ? value.creatives : []),
    ...(Array.isArray(value.resources) ? value.resources : []),
    ...(Array.isArray(value.resourceInfoList) ? value.resourceInfoList : []),
    value.dslData,
    value.nativeData,
    value.rnData,
    value.crossPlatformConfig?.dslContent,
    value.crossPlatformConfig?.rnContent,
  ].filter(Boolean)
  const candidates: Record<string, any>[] = []
  const candidateSeen = new Set<any>()
  const inherited = {
    ...(value.uiElement ? { uiElement: value.uiElement } : {}),
    ...(value.resourceUiElement ? { resourceUiElement: value.resourceUiElement } : {}),
    ...(value.coverImageUrl ? { coverImageUrl: value.coverImageUrl } : {}),
    ...(value.imageUrl ? { imageUrl: value.imageUrl } : {}),
    ...(value.purePictureUrl ? { purePictureUrl: value.purePictureUrl } : {}),
    ...(value.mainTitle ? { mainTitle: value.mainTitle } : {}),
    ...(value.subTitle ? { subTitle: value.subTitle } : {}),
  }
  directRoots.forEach((root: any) => recursiveCandidates(root, candidates, candidateSeen, 0, inherited))
  const resources = filterNeteaseActionable(dedupeNeteaseResources(candidates
    .map(normalizeNeteaseResource)
    .filter((item): item is NeteaseNativeResource => Boolean(item))))
  return {
    id: String(value.blockId || value.blockUUID || value.constructLogId || value.blockCode || `block-${index}`),
    blockCode: String(value.blockCode || value.positionCode || value.bizCode || ''),
    showType: String(value.showType || value.frontShowType || value.moduleType || ''),
    title: firstText(
      ui.mainTitle,
      value.mainTitle,
      value.blockTitle,
      value.title,
      value.blockName,
      value.name,
      value.dslData?.blockResource?.title,
      value.dslData?.data?.title,
      value.nativeData?.title,
      value.dslData?.header,
      blockTitleFromDsl(value.dslData),
    ),    subtitle: firstText(ui.subTitle, value.subTitle, value.blockSubTitle, value.description),
    moreActionUrl: blockMoreActionOf(value),
    resources,
    raw: value,
  }
}

function stringArray(value: any): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    } catch { /* 逗号分隔兜底 */ }
    return value.split(',').map(item => item.trim()).filter(Boolean)
  }
  return []
}

export function normalizeNeteaseHome(payload: any): NeteaseNativeHome {
  const data = payload?.data || {}
  const rawBlocks: Record<string, any>[] = Array.isArray(data.blocks)
    ? data.blocks
    : Array.isArray(data.blockVOS)
      ? data.blockVOS
      : Array.isArray(data.blockVos)
        ? data.blockVos
        : Array.isArray(payload?.blocks)
          ? payload.blocks
          : []
  const blocks: NeteaseNativeBlock[] = rawBlocks.map(normalizeNeteaseBlock).filter((block: NeteaseNativeBlock) => block.resources.length > 0 || block.title)
  const order: string[] = stringArray(data.blockCodeOrderList)
  if (order.length > 0) blocks.sort((a, b) => {
    const ai = order.indexOf(a.blockCode)
    const bi = order.indexOf(b.blockCode)
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
  })
  return {
    accountScoped: payload?.accountScoped === true,
    generatedAt: Number(payload?.generatedAt || Date.now()),
    cursor: String(data.cursor || ''),
    hasMore: data.hasMore === true,
    blockCodeOrderList: order,
    exposedResource: String(data.exposedResource || ''),
    blocks,
    rawBlocks,
  }
}

export function normalizeNeteaseDailyPodcast(value: any, index: number): ExploreChannel | null {
  const id = String(value?.voiceListId || value?.radioId || value?.id || '')
  const name = String(value?.voiceListName || value?.name || value?.title || '')
  if (!id || !name) return null
  return {
    id,
    name,
    group: String(value?.category || value?.categoryName || '每日播客'),
    description: String(value?.description || value?.desc || value?.rcmdText || ''),
    coverUrl: imageOf(value?.coverUrl || value?.coverImgUrl || value?.picUrl || value?.image || {}),
    playCount: Number(value?.playCount || value?.listenerCount || value?.subCount || 0) || undefined,
    platform: 'netease',
  }
}

export function normalizeNeteaseFlow(payload: any): NeteaseNativeFlow {
  const data = payload?.data || {}
  const resources: Record<string, any>[] = Array.isArray(data.resources) ? data.resources : []
  return { hasMore: data.hasMore === true, resources: dedupeNeteaseResources(resources.map(normalizeNeteaseResource).filter((item): item is NeteaseNativeResource => Boolean(item))) }
}

// 用户明确不要的模块：精品有声书、听书整条链路
/**
 * 真正需要排除的 positionCode。
 * 注意：「听精品有声书」(PAGE_RECOMMEND_PODCAST_AUDIO_BOOK) 与「广播」(PAGE_RECOMMEND_BROADCAST)
 * 是 App 推荐页**真实存在**的分区（实测 ADB 走查第 10 / 14 屏可见），内容也拿得到
 * （有声书 = 12 个 djradio 可站内打开；广播 = 电台 + 分类卡），因此**不再排除**。
 * 这里只留确实不接入的听书 Tab 页面。
 */
export const NETEASE_EXCLUDED_POSITIONS = new Set([
  'INFINITE_PODCAST_HOMEPAGE_VOICEBOOK_TAB',
])

export function isNeteaseExcludedPosition(code: string): boolean {
  return NETEASE_EXCLUDED_POSITIONS.has(String(code || '').toUpperCase())
}

// 商业推广/广告插卡：按投放标记与「鲍比」主题关键字双重过滤
const AD_TITLE_PATTERN = /鲍比|BOBBY|跨时空对话/
export function isNeteaseAdResource(resource: NeteaseNativeResource): boolean {
  const raw = resource.raw || {}
  const semantic = `${resource.title} ${resource.subtitle} ${raw.typeTitle || ''} ${raw.bannerBizType || ''} ${resource.actionUrl}`
  if (AD_TITLE_PATTERN.test(semantic)) return true
  const adInfo = raw.adInfo || raw.extInfo?.adInfo || raw.bannerInfo?.adInfo
  if (adInfo && (adInfo.adId || adInfo.creativeId || adInfo.bidType)) return true
  if (raw.fromAd === true || raw.bindAd === true) return true
  return false
}

export function filterNeteaseAdResources(resources: NeteaseNativeResource[]): NeteaseNativeResource[] {
  return resources.filter(resource => !isNeteaseAdResource(resource))
}

/**
 * Link Platform 页面（推荐页 / 发现-音乐-精选）响应 -> 统一区块模型。
 * 与旧版 homepage 的差异：区块以 positionCode/bizCode 标识，资源分散在
 * dslData.blockResource / dslData.data / nativeData / crossPlatformConfig.dslContent 内。
 */
export function normalizeNeteaseLinkPage(payload: any): NeteaseNativeHome {
  const data = payload?.data || {}
  const rawBlocks: Record<string, any>[] = Array.isArray(data.blocks) ? data.blocks : []
  const blocks: NeteaseNativeBlock[] = rawBlocks
    .map(normalizeNeteaseBlock)
    .map((block: NeteaseNativeBlock) => ({ ...block, resources: filterNeteaseAdResources(block.resources) }))
    .filter((block: NeteaseNativeBlock) => !isNeteaseExcludedPosition(block.blockCode))
    .filter((block: NeteaseNativeBlock) => block.resources.length > 0 || block.title)
  const order: string[] = stringArray(data.blockCodeOrderList)
  if (order.length > 0) blocks.sort((a, b) => {
    const ai = order.indexOf(a.blockCode)
    const bi = order.indexOf(b.blockCode)
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
  })
  return {
    accountScoped: payload?.accountScoped === true,
    generatedAt: Number(payload?.generatedAt || Date.now()),
    cursor: String(data.cursor ?? ''),
    hasMore: data.hasMore === true,
    blockCodeOrderList: order,
    exposedResource: '',
    blocks,
    rawBlocks,
  }
}

/** 从 Link Platform 响应中提取顶部快捷入口卡片（每日推荐/心动模式/雷达歌单/漫游/相似歌曲/相似艺人）。
 * 9.5.90 实测：服务端会把 SHORTCUT 区块按日去重，这些卡片改从 DAILY_RECOMMEND 等区块下发，
 * 因此这里按语义 kind 跨区块收集，优先取 SHORTCUT 区块。 */
export function normalizeNeteaseShortcuts(payload: any): NeteaseNativeResource[] {
  const data = payload?.data || {}
  const rawBlocks: Record<string, any>[] = Array.isArray(data.blocks) ? data.blocks : []
  const ordered = [
    ...rawBlocks.filter(block => /SHORTCUT/i.test(String(block?.positionCode || block?.bizCode || ''))),
    ...rawBlocks.filter(block => !/SHORTCUT/i.test(String(block?.positionCode || block?.bizCode || ''))),
  ]
  const byKind = new Map<string, NeteaseNativeResource>()
  ordered.forEach((block, index) => {
    const normalized = normalizeNeteaseBlock(block, index)
    for (const resource of filterNeteaseAdResources(normalized.resources)) {
      const kind = neteaseShortcutKind(resource)
      if (kind && !byKind.has(kind)) byKind.set(kind, resource)
    }
  })
  return [...byKind.values()]
}
