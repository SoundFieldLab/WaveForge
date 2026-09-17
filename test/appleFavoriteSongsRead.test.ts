import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「喜爱歌曲」读取路径回归。
 *
 * 背景（真实登录态实测，storefront=cn，经主进程 appleApi 代理）：
 *   GET  /v1/me/favorites              → 404 {"title":"Path Not Found","code":"40401"}
 *   GET  /v1/me/favorites/songs        → 404 同上
 *   GET  /v1/me/favorites?ids[songs]=… → 404 同上
 *   GET  /v1/me/library/playlists      → 200（含 name=「喜爱歌曲」的资料库歌单）
 *   GET  /v1/me/library/playlists/{id}/tracks → 200 返回曲目
 *   POST /v1/me/favorites?ids[songs]=X → 202（写入有效，与 GET 不对称）
 *
 * 旧实现读取时打的是 favorites/songs（恒 404），所以侧栏「喜爱歌曲」永远为空。
 * 这里锁死两件事：① 读取不得再打 favorites；② 必须经由资料库歌单的 tracks 接口。
 */

const apiRequest = vi.fn()

vi.mock('../src/services/appleApiBridge', () => ({ appleApiRequest: apiRequest }))
vi.mock('../src/services/appleAuth', () => ({
  getAppleCredentials: () => ({ developerToken: 'dev', mediaUserToken: 'mut', storefront: 'cn' }),
}))
vi.mock('../src/services/appleMusic', () => ({ toHighResArtwork: (v: string) => v }))

const { getAppleFavoriteSongIds } = await import('../src/services/appleCatalog')

/** 依据请求路径回放响应，模拟真实服务端 */
function mockServer() {
  const calls: string[] = []
  apiRequest.mockImplementation(async (path: string) => {
    calls.push(path)
    if (path.startsWith('/v1/me/favorites')) {
      return { ok: false, status: 404, error: 'Path Not Found', data: null }
    }
    if (path.startsWith('/v1/me/library/playlists?')) {
      return {
        ok: true,
        status: 200,
        data: {
          data: [{ id: 'p.LOVED', type: 'library-playlists', attributes: { name: '喜爱歌曲' } }],
        },
      }
    }
    if (path.startsWith('/v1/me/library/playlists/p.LOVED/tracks')) {
      return {
        ok: true,
        status: 200,
        data: {
          data: [
            { id: 'i.aaa', type: 'library-songs', attributes: { name: 'A' }, relationships: { catalog: { data: [{ id: '111', type: 'songs' }] } } },
            { id: 'i.bbb', type: 'library-songs', attributes: { name: 'B' }, relationships: { catalog: { data: [{ id: '222', type: 'songs' }] } } },
            // 同一首重复出现：必须去重
            { id: 'i.ccc', type: 'library-songs', attributes: { name: 'A2' }, relationships: { catalog: { data: [{ id: '111', type: 'songs' }] } } },
          ],
        },
      }
    }
    return { ok: false, status: 500, error: 'unexpected ' + path, data: null }
  })
  return calls
}

describe('Apple「喜爱歌曲」读取路径', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('经资料库歌单读取喜爱曲目，且不再请求已废弃的 favorites 端点', async () => {
    const calls = mockServer()
    const ids = await getAppleFavoriteSongIds(50)

    expect(ids).toEqual(['111', '222'])
    // 关键：不得出现 favorites 读取请求
    expect(calls.some(p => p.startsWith('/v1/me/favorites'))).toBe(false)
    expect(calls.some(p => p.includes('/v1/me/library/playlists/'))).toBe(true)
  })

  it('资料库里没有「喜爱歌曲」歌单时返回 null（表示不可用，而非空收藏）', async () => {
    apiRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/me/library/playlists?')) {
        return { ok: true, status: 200, data: { data: [{ id: 'p.OTHER', type: 'library-playlists', attributes: { name: '我的歌单' } }] } }
      }
      return { ok: false, status: 404, error: 'not found', data: null }
    })
    await expect(getAppleFavoriteSongIds(50)).resolves.toBeNull()
  })

  it('英文名 Loved Songs 也能识别', async () => {
    apiRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/v1/me/library/playlists?')) {
        return { ok: true, status: 200, data: { data: [{ id: 'p.L', type: 'library-playlists', attributes: { name: 'Loved Songs' } }] } }
      }
      if (path.includes('/p.L/tracks')) {
        return { ok: true, status: 200, data: { data: [{ id: 'i.x', type: 'library-songs', attributes: { name: 'X' }, relationships: { catalog: { data: [{ id: '999', type: 'songs' }] } } }] } }
      }
      return { ok: false, status: 404, error: 'x', data: null }
    })
    await expect(getAppleFavoriteSongIds(50)).resolves.toEqual(['999'])
  })
})
