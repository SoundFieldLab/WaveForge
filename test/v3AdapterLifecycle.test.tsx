// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { V3Adapter } from '../src/services/audio-engine/V3Adapter'
import type { RenderStudioProps } from '../src/services/audio-engine/types'

const fusion = vi.hoisted(() => ({
  attachV3Engine: vi.fn(async () => undefined), detachV3Engine: vi.fn(),
  exportV3Mp3: vi.fn(async (_url: string, _seconds: number, _options?: unknown) => undefined),
  exportV3Wav: vi.fn(async (_url: string, _seconds: number, _options?: unknown) => undefined),
  getV3Bridge: vi.fn(() => ({})), isV3Attached: vi.fn(() => true),
  scanV3TrackReplayGain: vi.fn(async (_url: string, _signal?: AbortSignal) => null),
  setV3TrackReplayGainTags: vi.fn(), setV3SystemVolume: vi.fn(),
}))
vi.mock('../src/services/waveforge-engine-v3/attachV3Engine', () => fusion)

describe('正式 HSE 适配器生命周期', () => {
  beforeEach(() => vi.clearAllMocks())

  it('相同源幂等，URL复用但曲目标识不同仍取消并重新扫描，直播与dispose清除增益', () => {
    const adapter = new V3Adapter()
    adapter.setPlaybackSource({ trackKey: 'a', url: 'same.flac' })
    const first = fusion.scanV3TrackReplayGain.mock.calls[0][1]!
    adapter.setPlaybackSource({ trackKey: 'a', url: 'same.flac' })
    expect(fusion.scanV3TrackReplayGain).toHaveBeenCalledTimes(1)
    adapter.setPlaybackSource({ trackKey: 'b', url: 'same.flac' })
    expect(first.aborted).toBe(true)
    expect(fusion.scanV3TrackReplayGain).toHaveBeenCalledTimes(2)
    const second = fusion.scanV3TrackReplayGain.mock.calls[1][1]!
    adapter.setPlaybackSource({ trackKey: 'radio', url: 'radio.m3u8', isLive: true })
    expect(second.aborted).toBe(true)
    expect(fusion.setV3TrackReplayGainTags).toHaveBeenLastCalledWith(null)
    adapter.setPlaybackSource({ trackKey: 'tagged', url: 'song.flac', replayGainTags: { REPLAYGAIN_TRACK_GAIN: '-4 dB' } })
    expect(fusion.setV3TrackReplayGainTags).toHaveBeenLastCalledWith({ REPLAYGAIN_TRACK_GAIN: '-4 dB' })
    adapter.dispose()
    expect(fusion.setV3TrackReplayGainTags).toHaveBeenLastCalledWith(null)
    expect(fusion.detachV3Engine).toHaveBeenCalledOnce()
  })

  it('正式调音室同时注入WAV/MP3闭包，传递秒和曲名；失败也复位导出状态', async () => {
    const adapter = new V3Adapter()
    const state = vi.fn()
    adapter.onExportingChange(state)
    const studio = adapter.renderStudio({ sourceUrl: 'song.wav', sourceDuration: 12.5, exportFileName: '测试歌曲',
      onClose: vi.fn(), playerTheme: 'light', anchorRect: null, engineVersion: 'v3', onSwitchEngine: vi.fn(),
      availableEngines: [] } satisfies RenderStudioProps) as React.ReactElement<{
        exportMp3(): Promise<void>; exportWav(): Promise<void>
      }>
    await studio.props.exportWav()
    expect(fusion.exportV3Wav).toHaveBeenCalledWith('song.wav', 12.5, { fileName: '测试歌曲' })
    fusion.exportV3Mp3.mockRejectedValueOnce(new Error('编码失败'))
    const toast = vi.fn()
    window.addEventListener('showToast', toast)
    await studio.props.exportMp3()
    window.removeEventListener('showToast', toast)
    expect(toast).toHaveBeenCalledOnce()
    expect(adapter.isExporting()).toBe(false)
    expect(state.mock.calls.map(call => call[0])).toEqual([true, false, true, false])
  })

  it('阻止跨格式并发导出，取消订阅后不再回调', async () => {
    const adapter = new V3Adapter()
    const state = vi.fn()
    const unsubscribe = adapter.onExportingChange(state)
    let finish!: () => void
    fusion.exportV3Wav.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const pending = adapter.exportWav('song.wav', 1)
    await expect(adapter.exportMp3('song.wav', 1)).rejects.toThrow('已有音频正在导出')
    unsubscribe()
    finish()
    await pending
    expect(adapter.isExporting()).toBe(false)
    expect(state).toHaveBeenCalledTimes(1)
  })
})
