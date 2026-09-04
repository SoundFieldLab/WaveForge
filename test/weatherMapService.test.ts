import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const forecastPayload = {
  hourly: {
    time: ['2026-08-30T00:00'],
    temperature_2m: [21],
  },
}

const successResponse = () => new Response(JSON.stringify(forecastPayload), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

describe('weather map point forecast cache', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T00:00:00Z'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('deduplicates concurrent requests and reuses a successful point', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    const first = fetchWeatherMapPointValue('temperature', 31.23, 121.47, 0)
    const second = fetchWeatherMapPointValue('humidity', 31.231, 121.469, 0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveFetch?.(successResponse())
    await Promise.all([first, second])
    await fetchWeatherMapPointValue('temperature', 31.23, 121.47, 0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries the same key after a failed pending request', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValue(successResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    const fallback = await fetchWeatherMapPointValue('temperature', 10, 20, 0)
    expect(fallback.source).toBe('estimate')
    const recovered = await fetchWeatherMapPointValue('temperature', 10, 20, 0)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(recovered.source).toBe('forecast')
  })

  it('removes an aborted pending request so the key can retry', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }))
      .mockResolvedValue(successResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    const controller = new AbortController()
    const aborted = fetchWeatherMapPointValue('temperature', 11, 22, 0, controller.signal)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })

    const recovered = await fetchWeatherMapPointValue('temperature', 11, 22, 0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(recovered.source).toBe('forecast')
  })

  it('expires old entries and removes them when inserting fresh data', async () => {
    const fetchMock = vi.fn(async () => successResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    await fetchWeatherMapPointValue('temperature', 1, 1, 0)
    vi.advanceTimersByTime(10 * 60 * 1000)
    await fetchWeatherMapPointValue('temperature', 2, 2, 0)
    await fetchWeatherMapPointValue('temperature', 1, 1, 0)

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('keeps the most recently used points within the capacity limit', async () => {
    const fetchMock = vi.fn(async () => successResponse())
    vi.stubGlobal('fetch', fetchMock)
    const { fetchWeatherMapPointValue } = await import('../src/services/weatherMapService')

    for (let index = 0; index < 64; index += 1) {
      await fetchWeatherMapPointValue('temperature', index, 0, 0)
    }
    await fetchWeatherMapPointValue('temperature', 0, 0, 0)
    await fetchWeatherMapPointValue('temperature', 64, 0, 0)
    await fetchWeatherMapPointValue('temperature', 0, 0, 0)
    await fetchWeatherMapPointValue('temperature', 1, 0, 0)

    expect(fetchMock).toHaveBeenCalledTimes(66)
  })
})
