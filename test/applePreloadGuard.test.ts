import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('Apple queue preload guard', () => {
  it('does not resolve a carrier while native Apple playback is enabled', () => {
    const source = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8')
    const preloadStart = source.indexOf('const preloadUpcomingSongs = useCallback')
    const preloadEnd = source.indexOf('const handleSmartReorder', preloadStart)
    const preloadSource = source.slice(preloadStart, preloadEnd)
    const guard = preloadSource.indexOf("platform === 'apple' && (isAppleNativeStreamEnabled() || isBridgeReady())")
    const carrierResolution = preloadSource.indexOf('? resolvePlayableSong(song)', guard)

    expect(preloadStart).toBeGreaterThan(-1)
    expect(preloadEnd).toBeGreaterThan(preloadStart)
    expect(guard).toBeGreaterThan(-1)
    expect(carrierResolution).toBeGreaterThan(guard)
    expect(preloadSource.slice(guard, carrierResolution)).toContain('return')
  })
})
