import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpatialPlaybackInput, createSpatialClockWav, isSpatialWavUrl } from '../src/audio/spatialPlaybackInput'
import { decodeSpatialWav } from '../src/services/waveforge-engine-v3/src/integration/SpatialAudioSource'

function wav(channels: number, mask = 0): ArrayBuffer {
  const frames = 16, bytes = new Uint8Array(68 + frames * channels * 4), view = new DataView(bytes.buffer)
  const id = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) }
  id(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); id(8, 'WAVE'); id(12, 'fmt ')
  view.setUint32(16, 40, true); view.setUint16(20, 0xfffe, true); view.setUint16(22, channels, true)
  view.setUint32(24, 48000, true); view.setUint32(28, 48000 * channels * 4, true)
  view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); view.setUint16(36, 22, true)
  view.setUint16(38, 32, true); view.setUint32(40, mask, true); view.setUint32(44, 3, true)
  bytes.set([0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 48)
  id(60, 'data'); view.setUint32(64, frames * channels * 4, true)
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) view.setFloat32(68 + (f * channels + c) * 4, (c + 1) / 100, true)
  return bytes.buffer
}

class Media extends EventTarget {
  src = ''; currentSrc = ''; currentTime = 0; playbackRate = 1; volume = 1; muted = false
  paused = true; ended = false; seeking = false; readyState = 4
  getAttribute(name: string) { return name === 'src' ? this.src : null }
  load = vi.fn()
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  async play() { this.paused = false; this.dispatchEvent(new Event('playing')) }
}

function graph() {
  const nodes: Array<{ buffer: ReturnType<typeof buffer> | null; playbackRate: { value: number }; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; channelInterpretation?: string }> = []
  function buffer(channels: number, frames: number, rate: number) {
    const pcm = Array.from({ length: channels }, () => new Float32Array(frames))
    return { numberOfChannels: channels, duration: frames / rate, getChannelData: (index: number) => pcm[index] }
  }
  const gains: Array<{ channelCountMode: string; channelInterpretation: string; gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn> }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = []
  const context = {
    currentTime: 0, createBuffer: buffer,
    createGain: () => {
      const node = { channelCountMode: 'max', channelInterpretation: 'discrete',
        gain: { value: 1, setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() }
      gains.push(node); return node
    },
    createBufferSource: () => {
      const node = { buffer: null, playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }
      nodes.push(node); return node
    },
  }
  const media = { connect: vi.fn(), disconnect: vi.fn() }
  const element = new Media()
  const destination = {} as GainNode
  const input = new SpatialPlaybackInput(context as unknown as AudioContext, element as unknown as HTMLAudioElement,
    media as unknown as MediaElementAudioSourceNode, destination)
  return { context, element, media, input, nodes, gains, destination }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function serve(data: ArrayBuffer) { vi.stubGlobal('fetch', vi.fn(async () => new Response(data, { status: 200 }))) }

describe('正式多声道播放源', () => {
  it('识别本机媒体协议和代理的 WAV，不误抓普通 FLAC', () => {
    expect(isSpatialWavUrl('waveforge-media://local/D%3A%5CMusic%5Ctest.wav')).toBe(true)
    expect(isSpatialWavUrl('http://localhost:3001/audio?url=https%3A%2F%2Fsite%2Fx.WAV%3Fkey%3D1')).toBe(true)
    expect(isSpatialWavUrl('https://site/song.flac')).toBe(false)
  })

  it('静音时钟的时长与 PCM 相符，奇数数据有正确 padding', () => {
    const decoded = decodeSpatialWav(createSpatialClockWav(1.000125))
    expect(decoded.duration).toBe(1.000125)
    expect(decoded.channels[0].every(value => value === 0)).toBe(true)
  })

  it('WAV mask 的 7.1 后/侧声道真正重排后才进入 AudioBufferSource', async () => {
    serve(wav(8, 0x63f))
    const g = graph(), info = vi.fn()
    g.input.configure(true, { onSourceDecoded: info })
    const clock = await g.input.prepare('https://site/71.wav')
    g.element.src = clock
    await g.element.play()
    expect(g.media.disconnect).toHaveBeenCalled()
    expect(g.nodes.at(-1)?.buffer?.numberOfChannels).toBe(8)
    // WAV 顺序 FL FR FC LFE BL BR SL SR -> HSE FL FR FC LFE SL SR BL BR。
    expect(g.nodes.at(-1)?.buffer?.getChannelData(4)[0]).toBeCloseTo(0.07)
    expect(g.nodes.at(-1)?.buffer?.getChannelData(6)[0]).toBeCloseTo(0.05)
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ channels: 8, layout: '71', channelMap: [0, 1, 2, 3, 6, 7, 4, 5] }))
    g.input.dispose()
  })

  it('32 声道显式标签保留到音频图，切走 HSE 后只折叠一次到双声道', async () => {
    serve(wav(32))
    const g = graph(), labels = Array.from({ length: 32 }, (_, i) => `source${i}`)
    g.input.configure(true, { sourceChannelLabels: labels })
    g.element.src = await g.input.prepare('https://site/32.wav'); await g.element.play()
    expect(g.nodes.at(-1)?.buffer?.numberOfChannels).toBe(32)
    expect(g.nodes.at(-1)?.buffer?.getChannelData(31)[0]).toBeCloseTo(0.32)
    const clock = g.element.src
    g.input.configure(false, { sourceChannelLabels: labels })
    expect(g.nodes.at(-1)?.buffer?.numberOfChannels).toBe(2)
    expect(g.element.src).toBe(clock)
    g.input.configure(true, { sourceChannelLabels: labels })
    expect(g.nodes.at(-1)?.buffer?.numberOfChannels).toBe(32)
    g.input.dispose()
  })

  it('暂停/seek/倍速与元素时钟联动，seek 不残留第二个 PCM source', async () => {
    serve(wav(8, 0x63f)); const g = graph()
    g.input.configure(true); g.element.src = await g.input.prepare('https://site/71.wav')
    await g.element.play(); const first = g.nodes.at(-1)!
    g.element.pause(); expect(first.stop).toHaveBeenCalledOnce()
    g.element.currentTime = 0.0001; g.element.playbackRate = 1.5
    await g.element.play()
    expect(g.nodes.at(-1)?.start).toHaveBeenCalledWith(0, 0.0001)
    expect(g.nodes.at(-1)?.playbackRate.value).toBe(1.5)
    const previous = g.nodes.at(-1)!
    g.element.seeking = true; g.element.dispatchEvent(new Event('seeking'))
    expect(previous.stop).toHaveBeenCalledOnce()
    g.element.seeking = false; g.element.currentTime = 0.0002; g.element.dispatchEvent(new Event('seeked'))
    expect(g.nodes.at(-1)?.start).toHaveBeenCalledWith(0, 0.0002)
    g.input.dispose()
  })

  it('四声道不自动猜 FOA，无 mask 拒绝；显式 AmbiX 保留最高阶平面', async () => {
    serve(wav(4)); const g = graph(); g.input.configure(true)
    await expect(g.input.prepare('https://site/no-mask.wav')).rejects.toThrow('不能根据声道数猜测')
    serve(wav(16)); g.input.configure(true, { inputFormat: 'ambix3' })
    g.element.src = await g.input.prepare('https://site/hoa.wav'); await g.element.play()
    expect(g.nodes.at(-1)?.buffer?.getChannelData(15)[0]).toBeCloseTo(0.16)
    g.input.dispose()
  })

  // 真实缺陷回归：UI 显式选 AmbiX/FuMa 后播放普通流媒音乐，旧实现会 fetch 后按 WAV 解码抛
  // 「不是受支持的 RIFF/WAVE」并中断播放；现在必须回落到普通立体声，只提示一次且不抓取。
  it('非 WAV 显式 HOA 不中断播放：按普通立体声播放且只提示一次；普通流不重复 fetch', async () => {
    const g = graph()
    g.input.configure(true)
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])))
    vi.stubGlobal('fetch', fetcher)
    expect(await g.input.prepare('https://site/music.flac')).toBe('https://site/music.flac')
    expect(fetcher).not.toHaveBeenCalled()
    g.input.reset()
    const warn = vi.fn()
    g.input.configure(true, { inputFormat: 'fuma', onSourceWarning: warn })
    expect(await g.input.prepare('https://site/hoa.flac')).toBe('https://site/hoa.flac')
    expect(await g.input.prepare('https://site/hoa2.flac')).toBe('https://site/hoa2.flac')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
    g.input.dispose()
  })

  // 真实缺陷回归：MediaElementAudioSourceNode 一旦存在，Chromium 仅在它连到音频图时拉动
  // HTMLMediaElement 时钟；旧实现 prepare() 直接 disconnect 会让 element.currentTime 冻结。
  it('多声道接管期间保持 MediaElement 连接（0 增益时钟支路），退出后恢复直连并通知 null', async () => {
    serve(wav(8, 0x63f))
    const g = graph(), info = vi.fn()
    g.input.configure(true, { onSourceDecoded: info })
    await g.input.prepare('https://site/71.wav')
    const clockSink = g.gains[1]
    expect(clockSink.gain.value).toBe(0)
    expect(g.media.connect).toHaveBeenLastCalledWith(clockSink)
    expect(clockSink.connect).toHaveBeenCalledWith(g.destination)
    g.input.reset()
    expect(g.media.connect).toHaveBeenLastCalledWith(g.destination)
    expect(info).toHaveBeenLastCalledWith(null)
    g.input.dispose()
  })

  // 真实缺陷回归：多声道 WAV 播完切普通立体声时，上层必须收到 null 才能回滚 multichannelAuto/layout。
  it('多声道 WAV 播完后切普通立体声歌曲会通知 null（上层回滚多声道参数）', async () => {
    serve(wav(8, 0x63f))
    const g = graph(), info = vi.fn()
    g.input.configure(true, { onSourceDecoded: info })
    await g.input.prepare('https://site/71.wav')
    expect(info.mock.lastCall?.[0]?.channels).toBe(8)
    expect(await g.input.prepare('https://site/stereo.mp3')).toBe('https://site/stereo.mp3')
    expect(info.mock.calls.at(-1)?.[0]).toBe(null)
    g.input.dispose()
  })
})
