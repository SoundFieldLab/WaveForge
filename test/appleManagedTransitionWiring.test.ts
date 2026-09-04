import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const playerSource = fs.readFileSync(path.resolve('src/hooks/useAudioPlayer.ts'), 'utf8')

describe('Apple managed transition wiring', () => {
  it('attaches Apple HLS to the standby deck instead of skipping m3u8', () => {
    const preload = playerSource.slice(
      playerSource.indexOf('const preloadNext = useCallback'),
      playerSource.indexOf('const loadAndPlay = useCallback'),
    )
    expect(preload).toContain('attachAppleHls(standby, appleHls!, () => {')
    expect(preload).toContain('resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current')
    expect(preload).not.toContain('HLS 音源跳过待机预载（切歌时直连）')
  })

  it('allows active Apple HLS decks through transition and ended handling', () => {
    const start = playerSource.slice(
      playerSource.indexOf('const startTransition = useCallback'),
      playerSource.indexOf('const prepareAutoMix = useCallback'),
    )
    const ended = playerSource.slice(
      playerSource.indexOf('const handleEnded = (event: Event)'),
      playerSource.indexOf('const handleError = (event: Event)'),
    )
    expect(start).not.toContain('跳过过渡，切歌时直连加载')
    expect(ended).not.toContain('当前曲目为 Apple 原生 HLS：置空过渡态')
    expect(ended).toContain("resolvePairTransitionStrategy(currentMetadataRef.current, nextMetadataRef.current")
  })

  it('routes fatal current and standby HLS failures through playback recovery', () => {
    const loadAndPlay = playerSource.slice(
      playerSource.indexOf('const loadAndPlay = useCallback'),
      playerSource.indexOf('// ── 外部播放源开关'),
    )
    const preload = playerSource.slice(
      playerSource.indexOf('const preloadNext = useCallback'),
      playerSource.indexOf('const loadAndPlay = useCallback'),
    )
    expect(loadAndPlay).toContain("cancelScheduledTransition('current Apple HLS failed', false, false)")
    expect(loadAndPlay).toContain('ended: true')
    expect(preload).toContain("cancelScheduledTransition('next Apple HLS failed', false, false)")
    expect(preload).toContain('setDeckGain(getActiveGain(), active, 1)')
  })

  it('detaches retired or abandoned HLS decks', () => {
    const detachCalls = playerSource.match(/detachAppleHls\(/g) || []
    expect(detachCalls.length).toBeGreaterThanOrEqual(6)
    expect(playerSource).toContain('detachAppleHls(standby)')
    expect(playerSource).toContain('detachAppleHls(source)')
    expect(playerSource).toContain('detachAppleHls(target)')
    expect(playerSource).toContain('detachAppleHls(active)')
  })
})
