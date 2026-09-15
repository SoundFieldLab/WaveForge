import { describe, expect, it } from 'vitest'
import {
  clampMediaTime,
  mvTimeToSongTime,
  nextPlayableCandidateIndex,
  resolveWatchSongTime,
  songTimeToMvTime,
  syncWatchVideoOnSurfaceRestore,
} from '../src/components/BilibiliMvPlayer'

describe('BilibiliMvPlayer signed watch timeline', () => {
  it('maps positive MV intro offsets in both directions', () => {
    expect(songTimeToMvTime(30, 4)).toBe(34)
    expect(mvTimeToSongTime(34, 4)).toBe(30)
  })

  it('preserves negative offsets instead of clamping their sign', () => {
    expect(songTimeToMvTime(30, -3)).toBe(27)
    expect(mvTimeToSongTime(27, -3)).toBe(30)
  })

  it('round-trips arbitrary signed offsets', () => {
    for (const offset of [-19.89, -0.5, 0, 0.5, 19.89]) {
      expect(mvTimeToSongTime(songTimeToMvTime(42.25, offset), offset)).toBeCloseTo(42.25, 10)
    }
  })

  it('performs one clamped video sync when the watch surface is restored', () => {
    const video = { duration: 60, currentTime: 0 } as HTMLVideoElement
    const audio = { currentTime: 75 } as HTMLAudioElement

    expect(syncWatchVideoOnSurfaceRestore(video, audio)).toBe(true)
    expect(video.currentTime).toBe(59.5)
  })

  it('does not seek without a usable audio clock', () => {
    const video = { duration: 60, currentTime: 12 } as HTMLVideoElement

    expect(syncWatchVideoOnSurfaceRestore(video, null)).toBe(false)
    expect(video.currentTime).toBe(12)
  })

  it('advances past failed candidates for request and media errors', () => {
    const chain = [
      { video: { bvid: 'first' } },
      { video: { bvid: 'second' } },
      { video: { bvid: 'third' } },
    ] as any

    expect(nextPlayableCandidateIndex(chain, new Set(['first']))).toBe(1)
    expect(nextPlayableCandidateIndex(chain, new Set(['first', 'second']), 0)).toBe(2)
    expect(nextPlayableCandidateIndex(chain, new Set(['first', 'second', 'third']))).toBe(-1)
  })

  it('preserves current watch song time when late alignment replaces the offset', () => {
    const songTime = resolveWatchSongTime({ entryFloor: 60, engineTime: 60, watchTime: 66, appliedOffset: 0, watchReady: true })
    expect(songTime).toBe(66)
    expect(songTimeToMvTime(songTime, 10)).toBe(76)
    expect(songTimeToMvTime(songTime, -4)).toBe(62)
  })

  it('never resolves startup before the captured entry floor', () => {
    expect(resolveWatchSongTime({ entryFloor: 73, engineTime: 0, watchTime: 1, appliedOffset: 0, watchReady: true })).toBe(73)
  })

  it('keeps the last valid handoff when the engine briefly reports NaN', () => {
    expect(resolveWatchSongTime({ entryFloor: 42, engineTime: Number.NaN, watchTime: 0, appliedOffset: 0, watchReady: false })).toBe(42)
  })
  it('keeps the latest watch position when the audio handoff finishes later', () => {
    const resumeTime = resolveWatchSongTime({
      entryFloor: 72.8,
      engineTime: 72.8,
      watchTime: 80.9,
      appliedOffset: 3.715,
      watchReady: true,
    })
    expect(resumeTime).toBeCloseTo(77.185, 3)
    expect(resumeTime).toBeGreaterThan(72.8)
  })

  it('maps a Villain-style late-entry target onto a short MV and clamps negative results', () => {
    // 歌曲 66.1s + 缓存偏移 9.86s → 视频目标 75.96s；两个媒体轨都必须消费同一目标，
    // 音频 metadata 晚到时不得回退到 0 再触发大幅回拉。
    const target = songTimeToMvTime(66.1, 9.86)
    expect(target).toBeCloseTo(75.96, 2)
    expect(clampMediaTime(target, 191, 8)).toBeCloseTo(75.96, 2)
    // 视频较短时钳制到保留结尾的安全位，而不是负数或 0
    expect(clampMediaTime(songTimeToMvTime(0, 9.86), 8, 8)).toBeGreaterThanOrEqual(0)
  })
})
