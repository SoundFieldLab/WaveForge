import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ensureToken = vi.fn()
const prepareToken = vi.fn()
const shouldRefresh = vi.fn()
const appleApi = vi.fn()
const applePlayback = vi.fn()
const applePlayAssets = vi.fn()
const appleFetchUrl = vi.fn()

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

const electron = { appleApi, applePlayback, applePlayAssets, appleFetchUrl }
;(globalThis as typeof globalThis & { window: any }).window = {
  electron,
  setTimeout,
  clearTimeout,
}

const { appleApiRequest } = await import('../src/services/appleApiBridge')
const { markCencRejected, resetAppleCencRejectionForTests, resolveAppleNativeStream, resolveAppleRadioStream, getAppleRadioFailReason } = await import('../src/services/applePlayback')

describe('Apple Developer Token request policy', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.useRealTimers()
    resetAppleCencRejectionForTests()
    prepareToken.mockImplementation(async (token: string) => token)
    shouldRefresh.mockReturnValue(false)
    appleFetchUrl.mockResolvedValue({ ok: false, status: 0 })
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

  it('automatically retries CENC after the ten minute rejection cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'))
    applePlayback.mockResolvedValue({ ok: true, status: 200, data: { songList: [{}] } })
    markCencRejected()

    await resolveAppleNativeStream('song-1')
    expect(applePlayback).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10 * 60 * 1000)
    await resolveAppleNativeStream('song-1')
    expect(applePlayback).toHaveBeenCalledOnce()
  })

  it.each([
    ['live', '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.aac', true],
    ['vod', '#EXTM3U\n#EXTINF:6,\nsegment.aac\n#EXT-X-ENDLIST', false],
    ['unknown', null, undefined],
  ] as const)('preserves %s radio timeline from the HLS manifest', async (_label, manifest, expectedLive) => {
    applePlayAssets.mockResolvedValue({
      ok: true,
      status: 200,
      data: { results: { assets: [{
        url: 'manifest://radio.example/master.m3u8',
        keyServerUrl: 'https://license.example/key',
        widevineKeyCertificateUrl: 'https://license.example/cert',
        adamId: 'license-id',
      }] } },
    })
    appleFetchUrl.mockResolvedValue(manifest === null
      ? { ok: false, status: 503 }
      : { ok: true, status: 200, text: manifest })

    const stream = await resolveAppleRadioStream('station-1', {
      id: 'asset-1', kind: 'radioStation', stationHash: 'hash', customFlag: true,
    })

    expect(stream).toMatchObject({
      url: 'https://radio.example/master.m3u8',
      hlsKeyServerUrl: 'https://license.example/key',
      widevineCertUrl: 'https://license.example/cert',
      licenseAdamId: 'license-id',
      live: expectedLive,
    })
    const query = new URLSearchParams(applePlayAssets.mock.calls[0][0])
    expect(Object.fromEntries(query)).toMatchObject({
      keyFormat: 'web', id: 'asset-1', kind: 'radioStation', stationHash: 'hash', customFlag: 'true',
    })
  })

  it('prefers a DRM-capable radio asset over an earlier unprotected candidate', async () => {
    applePlayAssets.mockResolvedValue({
      ok: true,
      status: 200,
      data: { results: { assets: [
        { url: 'https://radio.example/fallback.m3u8', hasDrm: false },
        { url: 'https://radio.example/widevine.m3u8', keyServerUrl: 'https://license.example/key', widevineKeyCertificateUrl: 'https://license.example/cert' },
      ] } },
    })
    appleFetchUrl.mockResolvedValue({ ok: true, status: 200, text: '#EXTM3U\n#EXT-X-TARGETDURATION:6' })

    const stream = await resolveAppleRadioStream('station-1')
    expect(stream?.url).toBe('https://radio.example/widevine.m3u8')
    expect(stream?.hlsKeyServerUrl).toBe('https://license.example/key')
  })

  it('keeps the full ra. id as the radio license adamId (MusicKit catalogId semantics)', async () => {
    applePlayAssets.mockResolvedValue({
      ok: true,
      status: 200,
      data: { results: { assets: [{
        url: 'https://linear.tv.apple.com/v1/radio/index.m3u8',
        keyServerUrl: 'https://linear.tv.apple.com/v1/radio/streaming-key-delivery',
        widevineKeyCertificateUrl: 'https://cert.example/widevine',
      }] } },
    })
    appleFetchUrl.mockResolvedValue({ ok: true, status: 200, text: '#EXTM3U\n#EXT-X-TARGETDURATION:6' })

    const stream = await resolveAppleRadioStream('ra.6801240640', { id: 'ra.6801240640', kind: 'radioStation' })

    expect(stream?.licenseAdamId).toBe('ra.6801240640')
    expect(stream?.hlsKeyServerUrl).toBe('https://linear.tv.apple.com/v1/radio/streaming-key-delivery')
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

  // 回归：用户报「选 K-pop 电台提示地区问题，换一个又好了」。
  // 真实原因是 play/assets 返回 404，但失败后代码继续往下走，把精确原因覆盖成了
  // 「订阅态异常 / 地区限制 / 电台不可用」这句泛化文案——把请求失败误报成地区问题。
  it('reports the precise play/assets failure instead of a generic region message', async () => {
    applePlayAssets.mockResolvedValue({ ok: false, status: 404, error: 'play/assets HTTP 404' })

    const stream = await resolveAppleRadioStream('ra.6801240433', { id: 'ra.6801240433', kind: 'radioStation' })

    expect(stream).toBeNull()
    const reason = getAppleRadioFailReason()
    expect(reason).toBe('play/assets HTTP 404')
    // 不得出现泛化文案里的「地区」字样
    expect(reason).not.toContain('地区')
    expect(reason).not.toContain('订阅态异常')
    // 失败时不应继续请求 HLS 清单
    expect(appleFetchUrl).not.toHaveBeenCalled()
  })

  // 回归：实测 /v1/catalog/{sf}/stations/{id} 有两类电台，且走**完全不同的端点**
  // （真实登录态实测）：
  //   · format="stream" → 直播流：play/assets 返回 itsliveradio HLS + Widevine keyServer
  //   · format="tracks" → 曲目型：play/assets **恒 404**（A/B/C/D 四种参数组合全 404，
  //       与 stationHash / streamingKind / 是否覆写 format 都无关）；
  //       其曲目来自 POST /v1/me/stations/next-tracks/{id}（实测 200，返回 5 首目录歌曲）。
  // 所以曲目型电台**根本不该调用 play/assets**——调用即产生一次必然失败的请求，
  // 并被上层记成"取流失败"。这里锁死这一点：必须提前返回且不打网络。
  it('does not call play/assets for tracks-type stations (they have no HLS stream)', async () => {
    const stream = await resolveAppleRadioStream('ra.1055202918', {
      format: 'tracks', hasDrm: false, id: 'ra.1055202918', kind: 'radioStation', mediaType: 0, stationHash: 'CgkIBBoF5ryU9wMQAg',
    })

    expect(stream).toBeNull()
    // 关键：不该发出任何 play/assets 请求
    expect(applePlayAssets).not.toHaveBeenCalled()
    // 失败原因要能指出"曲目型电台"，供上层改走 next-tracks 队列
    expect(getAppleRadioFailReason()).toContain('曲目型电台')
  })

  it('keeps the official stream parameters for stream-type stations', async () => {
    applePlayAssets.mockResolvedValue({ ok: true, status: 200, data: { results: { assets: [{
      url: 'https://radio.example/master.m3u8',
      keyServerUrl: 'https://license.example/key',
      widevineKeyCertificateUrl: 'https://license.example/cert',
    }] } } })
    appleFetchUrl.mockResolvedValue({ ok: true, status: 200, text: '#EXTM3U\n#EXT-X-TARGETDURATION:6' })

    await resolveAppleRadioStream('ra.6804822499', {
      format: 'stream', hasDrm: true, id: 'ra.6804822499', kind: 'radioStation', mediaType: 0, stationHash: 'CgkIBRoF47PlrBkQBA', streamingKind: 1,
    })

    const query = Object.fromEntries(new URLSearchParams(applePlayAssets.mock.calls[0][0]))
    expect(query).toMatchObject({ format: 'stream', hasDrm: 'true', mediaType: '0', streamingKind: '1', keyFormat: 'web' })
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
