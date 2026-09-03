import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ensureToken = vi.fn()
const prepareToken = vi.fn()
const shouldRefresh = vi.fn()
const appleApi = vi.fn()
const applePlayback = vi.fn()
const applePlayAssets = vi.fn()

vi.mock('../src/services/appleMusicToken', () => ({
  ensureAppleWebDevToken: ensureToken,
  prepareAppleDeveloperToken: prepareToken,
  shouldRefreshAppleDeveloperToken: shouldRefresh,
}))

vi.mock('../src/services/appleAuth', () => ({
  getAppleCredentials: () => ({
    developerToken: 'stored-token',
    mediaUserToken: 'media-token',
    storefront: 'cn',
  }),
}))

const electron = { appleApi, applePlayback, applePlayAssets }
;(globalThis as typeof globalThis & { window: any }).window = {
  electron,
  setTimeout,
  clearTimeout,
}

const { appleApiRequest } = await import('../src/services/appleApiBridge')
const { resolveAppleNativeStream, resolveAppleRadioStream } = await import('../src/services/applePlayback')

describe('Apple Developer Token request policy', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    prepareToken.mockImplementation(async (token: string) => token)
    shouldRefresh.mockReturnValue(false)
  })

  it('uses the request-time refreshed token before the first amp-api request', async () => {
    prepareToken.mockResolvedValue('fresh-token')
    appleApi.mockResolvedValue({ ok: true, status: 200, data: { data: [] } })

    await appleApiRequest('/v1/catalog/cn/songs', { developerToken: 'expiring-token' })

    expect(appleApi).toHaveBeenCalledTimes(1)
    expect(appleApi.mock.calls[0][1]).toBe('fresh-token')
  })

  it('does not refresh a valid Developer Token for a MUT or subscription 403', async () => {
    appleApi.mockResolvedValue({ ok: false, status: 403, data: {} })

    const result = await appleApiRequest('/v1/me/library/songs', {
      developerToken: 'valid-token',
      mediaUserToken: 'expired-media-token',
    })

    expect(result.status).toBe(403)
    expect(ensureToken).not.toHaveBeenCalled()
    expect(appleApi).toHaveBeenCalledTimes(1)
  })

  it('retries amp-api once when the sent Developer Token is expiring', async () => {
    shouldRefresh.mockReturnValue(true)
    ensureToken.mockResolvedValue('replacement-token')
    appleApi
      .mockResolvedValueOnce({ ok: false, status: 401, data: {} })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: [] } })

    const result = await appleApiRequest('/v1/catalog/cn/songs', { developerToken: 'expiring-token' })

    expect(result.ok).toBe(true)
    expect(appleApi).toHaveBeenCalledTimes(2)
    expect(appleApi.mock.calls[1][1]).toBe('replacement-token')
    expect(localStorage.getItem('appleDeveloperToken')).toBe('replacement-token')
  })

  it('prepares tokens before webPlayback and play/assets requests', async () => {
    prepareToken.mockResolvedValue('fresh-playback-token')
    applePlayback.mockResolvedValue({ ok: true, status: 200, data: { songList: [{}] } })
    applePlayAssets.mockResolvedValue({ ok: true, status: 200, data: { results: { assets: [] } } })

    await resolveAppleNativeStream('song-1')
    await resolveAppleRadioStream('station-1')

    expect(applePlayback).toHaveBeenCalledWith('song-1', 'fresh-playback-token', 'media-token')
    expect(applePlayAssets.mock.calls[0][1]).toBe('fresh-playback-token')
  })

  it('retries webPlayback and play/assets once for an expiring Developer Token', async () => {
    shouldRefresh.mockReturnValue(true)
    ensureToken.mockResolvedValue('replacement-token')
    applePlayback
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { songList: [{}] } })
    applePlayAssets
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { results: { assets: [] } } })

    await resolveAppleNativeStream('song-1')
    await resolveAppleRadioStream('station-1')

    expect(applePlayback).toHaveBeenCalledTimes(2)
    expect(applePlayback.mock.calls[1][1]).toBe('replacement-token')
    expect(applePlayAssets).toHaveBeenCalledTimes(2)
    expect(applePlayAssets.mock.calls[1][1]).toBe('replacement-token')
  })

  it('does not retry playback 403 responses while the Developer Token is valid', async () => {
    applePlayback.mockResolvedValue({ ok: false, status: 403, error: 'subscription denied' })
    applePlayAssets.mockResolvedValue({ ok: false, status: 403, error: 'subscription denied' })

    await resolveAppleNativeStream('song-1')
    await resolveAppleRadioStream('station-1')

    expect(ensureToken).not.toHaveBeenCalled()
    expect(applePlayback).toHaveBeenCalledTimes(1)
    expect(applePlayAssets).toHaveBeenCalledTimes(1)
  })
})

describe('Apple logout IPC wiring', () => {
  it('exposes a trusted logout bridge that clears the isolated session and cookie file', () => {
    const preload = fs.readFileSync(path.resolve('desktop/preload.cjs'), 'utf8')
    const main = fs.readFileSync(path.resolve('desktop/main.cjs'), 'utf8')
    const start = main.indexOf("ipcMain.handle('apple-logout'")
    const end = main.indexOf('// ── Apple 网页开发者令牌', start)
    const handler = main.slice(start, end)

    expect(preload).toContain("appleLogout: () => ipcRenderer.invoke('apple-logout')")
    expect(start).toBeGreaterThan(-1)
    expect(handler).toContain("guardTrustedIpc('privileged'")
    expect(handler).toContain('loginWindow.close()')
    expect(handler).toContain('appleSession.clearStorageData()')
    expect(handler).toContain("appleSession.clearStorageData({ storages: ['cookies'] })")
    expect(handler).toContain('appleSession.clearCache()')
    expect(handler).toContain("'apple-web-cookies.json'")
  })
})
