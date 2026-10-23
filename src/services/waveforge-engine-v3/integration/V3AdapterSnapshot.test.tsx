import { beforeEach, describe, expect, it, vi } from 'vitest'
import { V3AdapterSnapshot } from './V3AdapterSnapshot'

const fusion = vi.hoisted(() => ({
  attachV3Engine: vi.fn(async () => undefined), detachV3Engine: vi.fn(),
  exportV3Mp3: vi.fn(async () => undefined), exportV3Wav: vi.fn(async () => undefined),
  getV3Bridge: vi.fn(() => ({})), isV3Attached: vi.fn(() => true),
  scanV3TrackReplayGain: vi.fn(async (_url: string, _signal?: AbortSignal) => null), setV3SystemVolume: vi.fn(),
  setV3TrackReplayGainTags: vi.fn(),
}))
vi.mock('../attachV3Engine', () => fusion)

describe('HSE 快照适配层', () => {
  beforeEach(() => vi.clearAllMocks())

  it('曲目 URL 变化取消旧扫描；已有标签直接应用，清空源清除增益', () => {
    const adapter = new V3AdapterSnapshot()
    adapter.setPlaybackSource('song-a.flac')
    const firstSignal = fusion.scanV3TrackReplayGain.mock.calls[0][1] as AbortSignal
    adapter.setPlaybackSource('song-a.flac')
    expect(fusion.scanV3TrackReplayGain).toHaveBeenCalledTimes(1)
    adapter.setPlaybackSource('song-b.flac')
    expect(firstSignal.aborted).toBe(true)
    expect(fusion.scanV3TrackReplayGain).toHaveBeenCalledTimes(2)
    adapter.setPlaybackSource('song-c.flac', { replayGainTrackGain: -4 })
    expect(fusion.setV3TrackReplayGainTags).toHaveBeenLastCalledWith({ replayGainTrackGain: -4 })
    adapter.setPlaybackSource(null)
    expect(fusion.setV3TrackReplayGainTags).toHaveBeenLastCalledWith(null)
    adapter.dispose()
  })

  it('调音室收到 WAV 和 MP3 导出回调，并发布导出状态', async () => {
    const adapter = new V3AdapterSnapshot()
    const states: boolean[] = []
    adapter.onExportingChange((state) => states.push(state))
    const element = adapter.renderStudio({ onClose: () => undefined, playerTheme: 'dark',
      sourceUrl: 'song.flac', sourceDuration: 12, exportFileName: 'Song' }) as { props: {
        exportWav: () => Promise<void>; exportMp3: () => Promise<void>
      } }
    await element.props.exportWav()
    await element.props.exportMp3()
    expect(fusion.exportV3Wav).toHaveBeenCalledWith('song.flac', 12, { fileName: 'Song' })
    expect(fusion.exportV3Mp3).toHaveBeenCalledWith('song.flac', 12, { fileName: 'Song' })
    expect(states).toEqual([true, false, true, false])
  })
})
