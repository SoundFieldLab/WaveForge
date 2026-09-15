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
    commentCount: Number(track.commentCount || value?.resourceInteractInfo?.commentCount || 0) || undefined,
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
    return parsed.searchParams.get('id') || parsed.searchParams.get(`${kind}Id`) || ''
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
  // 小程序入口（助眠解压 / 广播电台等）没有可直接打开的 H5，落到站内「全部分类」按名字找
  if (/orpheus:\/\/miniProgram/i.test(actionUrl)) return { type: 'podcast-categories' }
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
  const song = songOf(value)
  const type = String(value.resourceType || value.creativeType || (song ? 'song' : '')).toLowerCase()
  const actionUrl = String(value.action || value.orpheus || value.targetUrl || ui?.button?.action || '')
  const actionResourceId = actionUrl.match(/(?:playlist|album|song|mv|artist|user|program)(?:\/|\?|:)(?:id=)?(\d+)/i)?.[1] || ''
  const id = String(value.resourceId ?? value.creativeId ?? value.programId ?? value.id ?? song?.id ?? actionResourceId ?? '')
  const title = textOf(ui.mainTitle) || textOf(value.mainTitle) || textOf(value) || song?.name || ''
  const subtitle = textOf(ui.subTitle) || textOf(value.subTitle) || textOf(ext?.artist) || song?.artists.map(artist => artist.name).join(' / ') || ''
  const coverUrl = firstImage(
    ui.image,
    ui.backgroundImage,
    value.coverImageUrl,
    value.imageUrl,
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
    raw: value,
  }
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

export function dedupeNeteaseResources(resources: NeteaseNativeResource[]): NeteaseNativeResource[] {
  const seen = new Set<string>()
  return resources.filter(resource => {
    const key = neteaseResourceKey(resource)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
    ),    subtitle: firstText(ui.subTitle, value.subTitle, value.blockSubTitle, value.description),
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
export const NETEASE_EXCLUDED_POSITIONS = new Set([
  'PAGE_RECOMMEND_PODCAST_AUDIO_BOOK',
  'PAGE_RECOMMEND_BROADCAST',
  'PAGE_DISCOVERY_AUDIO_BOOK',
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
