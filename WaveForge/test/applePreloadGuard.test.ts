import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('Apple queue preload', () => {
  it('preloads only the first native Apple successor and never resolves a carrier in that branch', () => {
    const source = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8')
    const preloadStart = source.indexOf('const preloadUpcomingSongs = useCallback')
    const preloadEnd = source.indexOf('const handleSmartReorder', preloadStart)
    const preloadSource = source.slice(preloadStart, preloadEnd)
    const nativeGuard = preloadSource.indexOf("platform === 'apple' && (isAppleNativeStreamEnabled() || isBridgeReady())")
    const carrierResolution = preloadSource.indexOf('? resolvePlayableSong(song)', nativeGuard)
    const nativeBranch = preloadSource.slice(nativeGuard, carrierResolution)

    expect(preloadStart).toBeGreaterThan(-1)
    expect(preloadEnd).toBeGreaterThan(preloadStart)
    expect(nativeGuard).toBeGreaterThan(-1)
    expect(nativeBranch).toContain('position !== 0')
    expect(nativeBranch).toContain('song.appleRadio')
    expect(nativeBranch).toContain('resolveAppleNativeStream(streamId)')
    expect(nativeBranch).toContain('appleHls: stream')
    expect(nativeBranch).toContain('releaseAppleNativeStream(stream)')
    expect(nativeBranch).toContain('onPreloadSettled: settleNativePreload')
    expect(nativeBranch).toContain("appleNativePreloadKeyRef.current = ''")
    expect(nativeBranch).toContain('attempts >= 2')
    expect(nativeBranch).toContain('requestRevision !== queueRevisionRef.current')
    expect(nativeBranch).not.toContain('resolvePlayableSong(song)')
  })
})
