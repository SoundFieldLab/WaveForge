import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseAppleNativeStream, type AppleNativeStream } from '../src/services/applePlayback'

const stream = (objectUrl: string): AppleNativeStream => ({
  url: `${objectUrl}#apple-hls.m3u8`,
  masterUrl: 'https://example.test/master.m3u8',
  songId: objectUrl,
  manifestObjectUrl: objectUrl,
})

afterEach(() => vi.restoreAllMocks())

describe('Apple native stream ownership', () => {
  it('releases each manifest independently and only once', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const first = stream('blob:first')
    const second = stream('blob:second')

    releaseAppleNativeStream(first)
    releaseAppleNativeStream(first)
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:first')
    expect(first.manifestObjectUrl).toBeUndefined()
    expect(second.manifestObjectUrl).toBe('blob:second')

    releaseAppleNativeStream(second)
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(revoke).toHaveBeenLastCalledWith('blob:second')
  })
})
