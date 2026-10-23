/**
 * Spotify Partner 客户端（渲染端）
 *
 * 走主进程的 api-partner.spotify.com GraphQL 桥（desktop/spotify-partner-bridge.cjs，
 * 移植自 folia，MIT）。与官方 Web API（spotifyService.ts）的差异：
 *  - 不受 Web API 的 client_id 全局限流影响（429 问题的根治路径）
 *  - 数据形态是 Spotify 桌面客户端内部 GraphQL schema（home/libraryV3/searchTracks…）
 *  - 会话凭据在主进程 safeStorage 加密，渲染层仅持有登录摘要
 *
 * 登录流：loginStart 打开 Spotify 授权页 → 用户授权后浏览器回跳 loopback →
 * loginCheck 轮询拿 user → 桥内部持久化会话。之后 query/lyrics 直接可用。
 */

export interface SpotifyPartnerLoginStatus {
  loggedIn: boolean
  /** username = Spotify 账号原生标识（歌单 ownerV2.username 同源，ownedByMe 判定用） */
  user: { id?: string; username?: string; nickname?: string; avatarUrl?: string } | null
}

export interface SpotifyPartnerRequestResult<T = any> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

const bridge = (): SpotifyPartnerBridgeApi | null => {
  const api = (window as any).electron as { spotifyPartner?: SpotifyPartnerBridgeApi } | undefined
  return api?.spotifyPartner ?? null
}

interface SpotifyPartnerBridgeApi {
  request: (operation: string, params?: Record<string, unknown>) => Promise<SpotifyPartnerRequestResult>
}

/** 登录状态（会话存主进程，每次实时查） */
export async function spotifyPartnerStatus(): Promise<SpotifyPartnerLoginStatus> {
  const b = bridge()
  if (!b) return { loggedIn: false, user: null }
  const result = await b.request('login_status')
  if (!result.ok) return { loggedIn: false, user: null }
  return {
    loggedIn: Boolean((result.data as any)?.loggedIn),
    user: (result.data as any)?.user ?? null,
  }
}

/** 发起登录：打开 Spotify 授权页，返回后由 loginCheck 轮询会话落地 */
export async function spotifyPartnerLoginStart(): Promise<boolean> {
  const b = bridge()
  if (!b) return false
  const result = await b.request('login_start')
  return Boolean(result.ok)
}

/** 轮询登录结果：approved = 会话已落地 */
export async function spotifyPartnerLoginCheck(): Promise<{ state: string; user?: any }> {
  const b = bridge()
  if (!b) return { state: 'expired' }
  const result = await b.request('login_check')
  if (!result.ok) return { state: 'expired' }
  const data = result.data as any
  if (data?.state === 'approved') {
    // 会话在 check 里落地（bridge 内部），再拉一次账号摘要
    const status = await spotifyPartnerStatus()
    return { state: 'approved', user: status.user }
  }
  return { state: data?.state ?? 'waiting' }
}

export async function spotifyPartnerLogout(): Promise<void> {
  const b = bridge()
  if (!b) return
  await b.request('logout')
}

/**
 * 会话播种（2026-10-21）：OAuth 授权窗登录成功后，把拿到的 access/refresh token 直接
 * 播种给主进程桥——OAuth 与桥共用同一 client_id（spotifyd 公开 id），同账号 token 通用，
 * 不再需要用户到系统浏览器点第二次授权（旧"静默同步"依赖用户配合，实测常被忽略，
 * 桥永远未登录 → 首页/探索页/歌单数据全空）。已有桥会话时不覆盖。
 */
export async function spotifyPartnerSeedSession(seed: {
  accessToken: string
  refreshToken: string
  expiresIn?: number
  user?: { nickname?: string }
}): Promise<{ state: string } | null> {
  const b = bridge()
  if (!b) return null
  const result = await b.request('seed_session', {
    accessToken: seed.accessToken,
    refreshToken: seed.refreshToken,
    expiresIn: seed.expiresIn,
    user: seed.user,
  })
  return result.ok ? (result.data as { state: string }) ?? null : null
}

/** 通用 GraphQL query（QUERIES 白名单内：home/libraryV3/searchTracks/fetchPlaylist/getAlbum…） */
export async function spotifyPartnerQuery<T = any>(name: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  const b = bridge()
  if (!b) return null
  const result = await b.request('query', { name, variables })
  return result.ok ? (result.data as T) : null
}

/** 行级歌词（color-lyrics，LINE_SYNCED） */
export async function spotifyPartnerLyrics(trackId: string): Promise<{ timed: boolean; lines: Array<{ startMs: number; words: string }> } | null> {
  const b = bridge()
  if (!b) return null
  const result = await b.request('lyrics', { id: trackId })
  return result.ok ? (result.data as any) ?? null : null
}

// ── 音乐库/歌单写操作（经桥 spclient；不受 Web API 限流影响）──────────────

/** 收藏/取消收藏到音乐库（uri = spotify:track:… | spotify:album:… | spotify:playlist:…） */
export async function spotifyPartnerSetLibrarySaved(uri: string, saved: boolean): Promise<boolean> {
  const b = bridge()
  if (!b) return false
  const result = await b.request('library', { uri, saved })
  return result.ok
}

/** 歌单加/删曲（action = 'add' | 'remove'） */
export async function spotifyPartnerEditPlaylist(playlistId: string, action: 'add' | 'remove', trackIds: string[]): Promise<boolean> {
  const b = bridge()
  if (!b) return false
  const result = await b.request('playlist_edit', { id: playlistId, action, tracks: trackIds })
  return result.ok
}

/** 新建歌单，返回歌单 id（失败 null） */
export async function spotifyPartnerCreatePlaylist(name: string): Promise<string | null> {
  const b = bridge()
  if (!b) return null
  const result = await b.request('playlist_create', { name })
  if (!result.ok) return null
  return String((result.data as any)?.uri ?? '').replace('spotify:playlist:', '') || null
}

/** 批量查询是否已在音乐库（areEntitiesInLibrary；uris = spotify:track:… 等） */
export async function spotifyPartnerAreInLibrary(uris: string[]): Promise<Set<string>> {
  const b = bridge()
  if (!b) return new Set()
  const result = await b.request('query', { name: 'areEntitiesInLibrary', variables: { uris } })
  const data = (result.data as any)?.areEntitiesInLibrary ?? null
  const inLib = new Set<string>()
  if (Array.isArray(data)) {
    data.forEach((entry: any, i: number) => {
      // 上游按请求顺序返回布尔（或嵌套 attribute），命中即收藏
      const saved = entry === true || entry?.attribute === true || entry?.attribute === 'IN_LIBRARY'
      if (saved && uris[i]) inLib.add(uris[i])
    })
  }
  return inLib
}

/** 曲目电台：以一首歌为种子生成歌单，返回歌单 id（失败 null） */
export async function spotifyPartnerRadio(trackId: string): Promise<string | null> {
  const b = bridge()
  if (!b) return null
  const result = await b.request('radio', { id: trackId })
  if (!result.ok) return null
  return String((result.data as any)?.uri ?? '').replace('spotify:playlist:', '') || null
}

/** 登出并清除主进程会话 */
export async function spotifyPartnerCancelLogin(): Promise<void> {
  const b = bridge()
  if (!b) return
  await b.request('login_cancel')
}
