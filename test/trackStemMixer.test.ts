import { describe, expect, it, vi } from 'vitest'
import {
  TRACK_STEMS,
  TrackStemMixer,
  UNITY_RECONSTRUCTION_GAINS,
  type StemChunkProvider,
} from '../src/audio/trackStemMixer'

type FakeParam = AudioParam & {
  setValueAtTime: ReturnType<typeof vi.fn>
  linearRampToValueAtTime: ReturnType<typeof vi.fn>
  setValueCurveAtTime: ReturnType<typeof vi.fn>
  cancelScheduledValues: ReturnType<typeof vi.fn>
}

type FakeGain = GainNode & {
  gain: FakeParam
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

type FakeSource = AudioBufferSourceNode & {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  addEventListener: ReturnType<typeof vi.fn>
}

function param(value = 1): FakeParam {
  return {
    value,
    defaultValue: value,
    minValue: 0,
    maxValue: 1,
    automationRate: 'a-rate',
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
  } as unknown as FakeParam
}

function gain(value = 1): FakeGain {
  return {
    gain: param(value),
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'speakers',
    context: {} as BaseAudioContext,
    numberOfInputs: 1,
    numberOfOutputs: 1,
    connect: vi.fn(),
    disconnect: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as FakeGain
}

function buffer(duration = 5): AudioBuffer {
  return {
    duration,
    length: duration * 48_000,
    numberOfChannels: 2,
    sampleRate: 48_000,
    getChannelData: vi.fn(),
    copyFromChannel: vi.fn(),
    copyToChannel: vi.fn(),
  } as unknown as AudioBuffer
}

function context() {
  const gains: FakeGain[] = []
  const sources: FakeSource[] = []
  const compressor = {
    threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
    connect: vi.fn(), disconnect: vi.fn(),
  } as unknown as DynamicsCompressorNode
  const value = {
    currentTime: 10,
    destination: { id: 'destination' },
    createGain: vi.fn(() => {
      const node = gain()
      gains.push(node)
      return node
    }),
    createDynamicsCompressor: vi.fn(() => compressor),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null,
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        addEventListener: vi.fn(),
      } as unknown as FakeSource
      sources.push(source)
      return source
    }),
  } as unknown as AudioContext
  return { value, gains, sources, compressor }
}

function setup(options: {
  provider?: StemChunkProvider
  originalGain?: FakeGain
  maxBufferedChunks?: number
  gainRampSeconds?: number
  crossfadeSeconds?: number
  positionProvider?: () => number
  onBufferUnderrun?: (position: number) => void
} = {}) {
  const audio = context()
  const provider = options.provider ?? vi.fn(async () => buffer())
  const mixer = new TrackStemMixer({
    context: audio.value,
    provider,
    originalGain: options.originalGain,
    positionProvider: options.positionProvider,
    onBufferUnderrun: options.onBufferUnderrun,
    chunkDuration: 5,
    prepareDuration: 5,
    maxBufferedChunks: options.maxBufferedChunks,
    gainRampSeconds: options.gainRampSeconds,
    crossfadeSeconds: options.crossfadeSeconds,
  })
  mixer.loadTrack({ id: 'track-a', duration: 60, chunkDuration: 5 })
  return { audio, mixer, provider }
}

describe('TrackStemMixer gains', () => {
  it('defaults every stem to 100% and preserves the unity reconstruction contract', () => {
    const { mixer, audio } = setup()

    expect(UNITY_RECONSTRUCTION_GAINS).toEqual({ vocals: 1, drums: 1, bass: 1, other: 1 })
    expect(mixer.getSnapshot().gains).toEqual(UNITY_RECONSTRUCTION_GAINS)
    expect(mixer.getSnapshot().busGain).toBe(1)
    expect(audio.gains.slice(1, 5).map(node => node.gain.value)).toEqual([1, 1, 1, 1])
  })

  it('clamps stem values to 0..1.2 and ignores non-finite input', () => {
    const { mixer } = setup()

    expect(mixer.setStemGains({ vocals: -1, drums: 1.7, bass: Number.NaN })).toEqual({
      vocals: 0,
      drums: 1.2,
      bass: 1,
      other: 1,
    })
  })

  it('applies the vocal macro without changing the other stems', () => {
    const { mixer } = setup()

    expect(mixer.setVocalLevel(0.35)).toBe(0.35)
    expect(mixer.getSnapshot().gains).toEqual({ vocals: 0.35, drums: 1, bass: 1, other: 1 })
  })

  it('keeps a real 120% boost and configures soft protection', async () => {
    const { mixer, audio } = setup()
    await mixer.play()

    mixer.setStemGains({ vocals: 1.2 })

    expect(mixer.getSnapshot().gains.vocals).toBe(1.2)
    expect(mixer.getSnapshot().busGain).toBe(1)
    expect(audio.gains[0].gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 10.03)
    expect(audio.gains[5].gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 10.03)
    expect(audio.gains[6].gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, 10.03)
    expect(audio.compressor.threshold.value).toBe(-3)
    expect(audio.compressor.ratio.value).toBe(12)
  })

  it('uses a clamped 20-50ms AudioParam ramp', () => {
    const short = setup({ gainRampSeconds: 0.001 })
    short.mixer.setStemGains({ bass: 0.5 })
    expect(short.audio.gains[3].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.5, 10.02)

    const long = setup({ gainRampSeconds: 1 })
    long.mixer.setStemGains({ other: 0.5 })
    expect(long.audio.gains[4].gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.5, 10.05)
  })
})

describe('TrackStemMixer scheduling lifecycle', () => {
  it('schedules all stems on one context timeline and crossfades equal-power in 30-80ms', async () => {
    const originalGain = gain(1)
    const { mixer, audio } = setup({ originalGain, crossfadeSeconds: 0.001 })

    expect(await mixer.play(1)).toBe(true)
    expect(audio.sources).toHaveLength(8)
    for (const source of audio.sources.slice(0, 4)) expect(source.start).toHaveBeenCalledWith(10, 1)
    for (const source of audio.sources.slice(4)) expect(source.start).toHaveBeenCalledWith(14, 0)

    const stemBus = audio.gains[0]
    const originalCurve = originalGain.gain.setValueCurveAtTime.mock.calls[0][0] as Float32Array
    const stemCurve = stemBus.gain.setValueCurveAtTime.mock.calls[0][0] as Float32Array
    expect(originalGain.gain.setValueCurveAtTime).toHaveBeenCalledWith(originalCurve, 10, 0.03)
    expect(stemBus.gain.setValueCurveAtTime).toHaveBeenCalledWith(stemCurve, 10, 0.03)
    expect(originalCurve[0]).toBeCloseTo(1)
    expect(originalCurve[originalCurve.length - 1]).toBeCloseTo(0)
    expect(stemCurve[0]).toBeCloseTo(0)
    expect(stemCurve[stemCurve.length - 1]).toBeCloseTo(1)
  })

  it('re-samples the authoritative deck clock after asynchronous preparation', async () => {
    let livePosition = 1
    const provider = vi.fn(async () => {
      livePosition = 3.2
      return buffer()
    })
    const { mixer, audio } = setup({ provider, positionProvider: () => livePosition })

    expect(await mixer.play(1)).toBe(true)
    expect(mixer.getSnapshot().position).toBeCloseTo(3.2)
    // Chunk zero starts from the current offset instead of replaying the 2.2s spent separating.
    expect(audio.sources[0].start).toHaveBeenCalledWith(10, 3.2)
  })

  it('reports an underrun when the last scheduled stem ends without a following chunk', async () => {
    const onBufferUnderrun = vi.fn()
    const { mixer, audio } = setup({ onBufferUnderrun })
    await mixer.play(0)
    for (const source of audio.sources.slice(0, 4)) {
      const ended = source.addEventListener.mock.calls.find(([name]: [string]) => name === 'ended')?.[1] as (() => void) | undefined
      ended?.()
    }
    expect(onBufferUnderrun).toHaveBeenCalledTimes(1)
  })

  it('drops late chunks after generation changes', async () => {
    const resolvers: Array<(value: AudioBuffer) => void> = []
    const provider = vi.fn(() => new Promise<AudioBuffer>(resolve => resolvers.push(resolve)))
    const { mixer } = setup({ provider })

    const pending = mixer.prepareWindow(0, 5)
    expect(resolvers).toHaveLength(4)
    mixer.seek(20)
    resolvers.forEach(resolve => resolve(buffer()))
    await pending

    expect(mixer.getSnapshot().position).toBe(20)
    expect(mixer.getSnapshot().bufferedChunks).toBe(0)
  })

  it('seek stops sources, clears buffers, and resets scheduling generation', async () => {
    const { mixer, audio } = setup()
    await mixer.play()
    const generation = mixer.getSnapshot().generation

    mixer.seek(17)

    expect(mixer.getSnapshot()).toMatchObject({ position: 17, playing: false, bufferedChunks: 0 })
    expect(mixer.getSnapshot().generation).toBe(generation + 1)
    for (const source of audio.sources) {
      expect(source.stop).toHaveBeenCalled()
      expect(source.buffer).toBeNull()
      expect(source.disconnect).toHaveBeenCalled()
    }
  })

  it('keeps only the configured finite chunk buffer', async () => {
    const { mixer } = setup({ maxBufferedChunks: 4 })

    await mixer.prepareWindow(0, 15)

    expect(mixer.getSnapshot().bufferedChunks).toBe(4)
  })

  it('returns to original with an equal-power fade and disposes all owned nodes', async () => {
    const originalGain = gain(1)
    const { mixer, audio } = setup({ originalGain, crossfadeSeconds: 0.08 })
    await mixer.play()

    mixer.returnToOriginal()
    const originalCalls = originalGain.gain.setValueCurveAtTime.mock.calls
    const lastOriginalCall = originalCalls[originalCalls.length - 1]
    expect(lastOriginalCall?.[2]).toBe(0.08)
    expect(audio.sources.every(source => {
      const stopCalls = source.stop.mock.calls
      return stopCalls[stopCalls.length - 1]?.[0] === 10.08
    })).toBe(true)

    mixer.dispose()
    expect(mixer.getSnapshot().trackId).toBeNull()
    expect(audio.gains.every(node => node.disconnect.mock.calls.length > 0)).toBe(true)
    expect(audio.compressor.disconnect).toHaveBeenCalled()
    expect(() => mixer.setStemGains({ vocals: 1 })).toThrow('disposed')
  })

  it('requests all four canonical stems from the provider', async () => {
    const { mixer, provider } = setup()

    await mixer.prepareWindow(0, 5)

    expect(vi.mocked(provider).mock.calls.map(([request]) => request.stem)).toEqual(TRACK_STEMS)
  })

  it('does not request a zero-length chunk at the exact track end', async () => {
    const { mixer, provider } = setup()

    const result = await mixer.prepareWindow(60, 5)

    expect(result.requestedChunks).toBe(0)
    expect(provider).not.toHaveBeenCalled()
  })
})
