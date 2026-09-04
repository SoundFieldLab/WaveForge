export const TRACK_STEMS = ['vocals', 'drums', 'bass', 'other'] as const

export type TrackStemName = typeof TRACK_STEMS[number]
export type TrackStemGains = Record<TrackStemName, number>

export interface TrackStemDescriptor {
  id: string
  duration: number
  /** Duration represented by one provider chunk, in seconds. */
  chunkDuration?: number
}

export interface StemChunkRequest {
  track: TrackStemDescriptor
  stem: TrackStemName
  chunkIndex: number
  startTime: number
  duration: number
  generation: number
  signal: AbortSignal
}

export type StemChunkProvider = (request: StemChunkRequest) => Promise<AudioBuffer | null>

export interface TrackStemMixerOptions {
  context: AudioContext
  provider: StemChunkProvider
  /** Existing player master node. Takes precedence over destination. */
  master?: AudioNode
  destination?: AudioNode
  /** Gain owned by the host's original, non-stem playback path. */
  originalGain?: GainNode
  /** Authoritative media-deck clock, sampled after asynchronous separation finishes. */
  positionProvider?: () => number
  /** Called when all scheduled sources end before a following chunk is ready. */
  onBufferUnderrun?: (position: number) => void
  chunkDuration?: number
  prepareDuration?: number
  maxBufferedChunks?: number
  gainRampSeconds?: number
  crossfadeSeconds?: number
}

export interface PreparedStemWindow {
  generation: number
  requestedChunks: number
  bufferedChunks: number
}

export interface TrackStemMixerSnapshot {
  trackId: string | null
  position: number
  playing: boolean
  generation: number
  gains: TrackStemGains
  busGain: number
  bufferedChunks: number
}

/**
 * Reconstruction contract: when all four source stems are unity gain, their sum
 * is routed at unity bus gain. Headroom is introduced only for user boosts.
 */
export const UNITY_RECONSTRUCTION_GAINS: Readonly<TrackStemGains> = Object.freeze({
  vocals: 1,
  drums: 1,
  bass: 1,
  other: 1,
})

const DEFAULT_CHUNK_DURATION = 5
const DEFAULT_PREPARE_DURATION = 15
const DEFAULT_MAX_BUFFERED_CHUNKS = 24
const DEFAULT_GAIN_RAMP_SECONDS = 0.03
const DEFAULT_CROSSFADE_SECONDS = 0.05
const MIN_GAIN_RAMP_SECONDS = 0.02
const MAX_GAIN_RAMP_SECONDS = 0.05
const MIN_CROSSFADE_SECONDS = 0.03
const MAX_CROSSFADE_SECONDS = 0.08
const MAX_STEM_GAIN = 1.2

const clamp = (value: number, low: number, high: number): number => (
  Math.max(low, Math.min(high, value))
)

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function setParamRamp(param: AudioParam, value: number, now: number, duration: number): void {
  param.cancelScheduledValues(now)
  param.setValueAtTime(param.value, now)
  param.linearRampToValueAtTime(value, now + duration)
}

export class TrackStemMixer {
  private readonly context: AudioContext
  private readonly provider: StemChunkProvider
  private readonly originalGain?: GainNode
  private readonly positionProvider?: () => number
  private readonly onBufferUnderrun?: (position: number) => void
  private readonly stemGains: Record<TrackStemName, GainNode>
  private readonly busGain: GainNode
  private readonly protection: DynamicsCompressorNode | null
  private readonly directGain: GainNode | null
  private readonly protectedGain: GainNode | null
  private readonly defaultChunkDuration: number
  private readonly prepareDuration: number
  private readonly maxBufferedChunks: number
  private readonly gainRampSeconds: number
  private readonly crossfadeSeconds: number

  private track: TrackStemDescriptor | null = null
  private gains: TrackStemGains = { ...UNITY_RECONSTRUCTION_GAINS }
  private generation = 0
  private position = 0
  private playing = false
  private disposed = false
  private stemsAudible = false
  private timelineContextStart = 0
  private timelineTrackStart = 0

  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly activeSources = new Set<AudioBufferSourceNode>()
  private readonly scheduledChunks = new Set<string>()
  private readonly smoothedBoundaries = new Set<string>()
  private readonly pendingLoads = new Map<string, Promise<void>>()
  private readonly pendingControllers = new Set<AbortController>()

  constructor(options: TrackStemMixerOptions) {
    this.context = options.context
    this.provider = options.provider
    this.originalGain = options.originalGain
    this.positionProvider = options.positionProvider
    this.onBufferUnderrun = options.onBufferUnderrun
    this.defaultChunkDuration = Math.max(0.05, finiteOr(options.chunkDuration, DEFAULT_CHUNK_DURATION))
    this.prepareDuration = Math.max(0.05, finiteOr(options.prepareDuration, DEFAULT_PREPARE_DURATION))
    this.maxBufferedChunks = Math.max(TRACK_STEMS.length, Math.floor(finiteOr(
      options.maxBufferedChunks,
      DEFAULT_MAX_BUFFERED_CHUNKS,
    )))
    this.gainRampSeconds = clamp(
      finiteOr(options.gainRampSeconds, DEFAULT_GAIN_RAMP_SECONDS),
      MIN_GAIN_RAMP_SECONDS,
      MAX_GAIN_RAMP_SECONDS,
    )
    this.crossfadeSeconds = clamp(
      finiteOr(options.crossfadeSeconds, DEFAULT_CROSSFADE_SECONDS),
      MIN_CROSSFADE_SECONDS,
      MAX_CROSSFADE_SECONDS,
    )

    this.busGain = this.context.createGain()
    this.busGain.gain.value = this.originalGain ? 0 : 1
    this.stemGains = Object.fromEntries(TRACK_STEMS.map(stem => {
      const gain = this.context.createGain()
      gain.gain.value = 1
      gain.connect(this.busGain)
      return [stem, gain]
    })) as Record<TrackStemName, GainNode>

    const output = options.master ?? options.destination ?? this.context.destination
    if (typeof this.context.createDynamicsCompressor === 'function') {
      const protection = this.context.createDynamicsCompressor()
      protection.threshold.value = -3
      protection.knee.value = 6
      protection.ratio.value = 12
      protection.attack.value = 0.003
      protection.release.value = 0.08
      const directGain = this.context.createGain()
      const protectedGain = this.context.createGain()
      directGain.gain.value = 1
      protectedGain.gain.value = 0
      this.busGain.connect(directGain)
      directGain.connect(output)
      this.busGain.connect(protection)
      protection.connect(protectedGain)
      protectedGain.connect(output)
      this.protection = protection
      this.directGain = directGain
      this.protectedGain = protectedGain
    } else {
      this.busGain.connect(output)
      this.protection = null
      this.directGain = null
      this.protectedGain = null
    }
  }

  loadTrack(track: TrackStemDescriptor): void {
    this.assertUsable()
    if (!track.id.trim()) throw new Error('TrackStemMixer requires a non-empty track id')
    if (!Number.isFinite(track.duration) || track.duration <= 0) {
      throw new Error('TrackStemMixer requires a positive track duration')
    }
    if (track.chunkDuration !== undefined && (!Number.isFinite(track.chunkDuration) || track.chunkDuration <= 0)) {
      throw new Error('TrackStemMixer requires a positive chunk duration')
    }

    this.resetGeneration()
    this.stopSources()
    this.buffers.clear()
    this.scheduledChunks.clear()
    this.smoothedBoundaries.clear()
    this.track = { ...track }
    this.position = 0
    this.playing = false
  }

  async prepareWindow(startTime = this.currentPosition(), duration = this.prepareDuration): Promise<PreparedStemWindow> {
    this.assertUsable()
    const track = this.requireTrack()
    const generation = this.generation
    const chunkDuration = this.chunkDuration(track)
    const start = clamp(finiteOr(startTime, 0), 0, track.duration)
    if (start >= track.duration) {
      return { generation, requestedChunks: 0, bufferedChunks: this.buffers.size }
    }
    const end = clamp(start + Math.max(0.05, finiteOr(duration, this.prepareDuration)), start, track.duration)
    const firstIndex = Math.floor(start / chunkDuration)
    const lastIndex = Math.max(firstIndex, Math.ceil(end / chunkDuration) - 1)
    const requested: Promise<void>[] = []

    for (let chunkIndex = firstIndex; chunkIndex <= lastIndex; chunkIndex += 1) {
      for (const stem of TRACK_STEMS) requested.push(this.loadChunk(track, stem, chunkIndex, generation))
    }
    await Promise.all(requested)
    this.smoothLoadedBoundaries(firstIndex, lastIndex)

    if (generation === this.generation && this.playing) this.scheduleBufferedChunks()
    return {
      generation,
      requestedChunks: requested.length,
      bufferedChunks: generation === this.generation ? this.buffers.size : 0,
    }
  }

  async play(startTime = this.position): Promise<boolean> {
    this.assertUsable()
    const track = this.requireTrack()
    const start = clamp(finiteOr(startTime, this.position), 0, track.duration)
    if (start !== this.position || this.playing) this.seek(start)
    const generation = this.generation
    await this.prepareWindow(start, this.prepareDuration)
    if (generation !== this.generation || this.disposed) return false
    let liveStart = clamp(finiteOr(this.positionProvider?.(), start), 0, track.duration)
    for (let attempt = 0; attempt < 3 && !this.hasCompleteChunkAt(liveStart); attempt += 1) {
      await this.prepareWindow(liveStart, this.prepareDuration)
      if (generation !== this.generation || this.disposed) return false
      liveStart = clamp(finiteOr(this.positionProvider?.(), liveStart), 0, track.duration)
    }
    if (!this.hasCompleteChunkAt(liveStart)) return false

    this.stopSources()
    this.scheduledChunks.clear()
    this.position = liveStart
    this.timelineTrackStart = liveStart
    this.timelineContextStart = this.context.currentTime
    this.playing = true
    this.scheduleBufferedChunks()
    if (this.activeSources.size === 0) {
      this.playing = false
      return false
    }
    this.crossfadeToStems()
    return true
  }

  seek(position: number): void {
    this.assertUsable()
    const track = this.requireTrack()
    this.position = clamp(finiteOr(position, 0), 0, track.duration)
    this.playing = false
    this.resetGeneration()
    this.stopSources()
    this.buffers.clear()
    this.scheduledChunks.clear()
    this.smoothedBoundaries.clear()
  }

  pause(): void {
    if (this.disposed || !this.track) return
    this.position = this.currentPosition()
    this.playing = false
    this.resetGeneration()
    this.stopSources()
    this.scheduledChunks.clear()
  }

  setStemGains(gains: Partial<TrackStemGains>): TrackStemGains {
    this.assertUsable()
    const now = this.context.currentTime
    for (const stem of TRACK_STEMS) {
      if (gains[stem] === undefined) continue
      const next = clamp(finiteOr(gains[stem], this.gains[stem]), 0, MAX_STEM_GAIN)
      this.gains[stem] = next
      setParamRamp(this.stemGains[stem].gain, next, now, this.gainRampSeconds)
    }
    if (this.stemsAudible) setParamRamp(this.busGain.gain, this.headroomGain(), now, this.gainRampSeconds)
    this.updateProtectionRoute(now)
    return { ...this.gains }
  }

  setVocalLevel(level: number): number {
    return this.setStemGains({ vocals: level }).vocals
  }

  returnToOriginal(): void {
    if (this.disposed) return
    const position = this.currentPosition()
    const now = this.context.currentTime
    this.stemsAudible = false
    if (this.originalGain) {
      this.applyEqualPowerCrossfade(this.busGain.gain, this.originalGain.gain, now)
    } else {
      setParamRamp(this.busGain.gain, 0, now, this.gainRampSeconds)
    }
    this.playing = false
    this.position = position
    this.resetGeneration()
    this.stopSources(now + this.crossfadeSeconds, false)
    this.scheduledChunks.clear()
  }

  getSnapshot(): TrackStemMixerSnapshot {
    return {
      trackId: this.track?.id ?? null,
      position: this.currentPosition(),
      playing: this.playing,
      generation: this.generation,
      gains: { ...this.gains },
      busGain: this.headroomGain(),
      bufferedChunks: this.buffers.size,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.playing = false
    this.resetGeneration()
    this.stopSources()
    this.buffers.clear()
    this.scheduledChunks.clear()
    this.smoothedBoundaries.clear()
    for (const gain of Object.values(this.stemGains)) gain.disconnect()
    this.busGain.disconnect()
    this.directGain?.disconnect()
    this.protectedGain?.disconnect()
    this.protection?.disconnect()
    this.track = null
  }

  private async loadChunk(
    track: TrackStemDescriptor,
    stem: TrackStemName,
    chunkIndex: number,
    generation: number,
  ): Promise<void> {
    const cacheKey = this.chunkKey(stem, chunkIndex)
    if (this.buffers.has(cacheKey)) {
      this.touchBuffer(cacheKey)
      return
    }
    const pendingKey = `${generation}:${cacheKey}`
    const existing = this.pendingLoads.get(pendingKey)
    if (existing) return existing

    const controller = new AbortController()
    this.pendingControllers.add(controller)
    const chunkDuration = this.chunkDuration(track)
    const startTime = chunkIndex * chunkDuration
    let request: Promise<void>
    request = this.provider({
      track,
      stem,
      chunkIndex,
      startTime,
      duration: Math.min(chunkDuration, Math.max(0, track.duration - startTime)),
      generation,
      signal: controller.signal,
    }).then(buffer => {
      if (!buffer || controller.signal.aborted || generation !== this.generation || this.track?.id !== track.id) return
      this.buffers.set(cacheKey, buffer)
      this.evictBuffers()
    }).catch(error => {
      if (!controller.signal.aborted && generation === this.generation) throw error
    }).finally(() => {
      this.pendingControllers.delete(controller)
      if (this.pendingLoads.get(pendingKey) === request) this.pendingLoads.delete(pendingKey)
    })
    this.pendingLoads.set(pendingKey, request)
    return request
  }

  private hasCompleteChunkAt(position: number): boolean {
    if (!this.track) return false
    const index = Math.floor(clamp(position, 0, Math.max(0, this.track.duration - 1e-6)) / this.chunkDuration(this.track))
    return TRACK_STEMS.every(stem => this.buffers.has(this.chunkKey(stem, index)))
  }

  private smoothLoadedBoundaries(firstIndex: number, lastIndex: number): void {
    for (const stem of TRACK_STEMS) {
      for (let index = Math.max(1, firstIndex); index <= lastIndex; index += 1) {
        const boundaryKey = `${stem}:${index}`
        if (this.smoothedBoundaries.has(boundaryKey)) continue
        const previous = this.buffers.get(this.chunkKey(stem, index - 1))
        const next = this.buffers.get(this.chunkKey(stem, index))
        if (!previous || !next || previous.numberOfChannels !== next.numberOfChannels) continue
        const frames = Math.min(128, previous.length, next.length)
        if (frames <= 1) continue
        for (let channel = 0; channel < next.numberOfChannels; channel += 1) {
          const previousData = previous.getChannelData(channel)
          const nextData = next.getChannelData(channel)
          if (!previousData || !nextData || previousData.length === 0 || nextData.length === 0) continue
          const boundarySample = previousData[previousData.length - 1] || 0
          for (let frame = 0; frame < frames; frame += 1) {
            const amount = frame / (frames - 1)
            nextData[frame] = boundarySample * (1 - amount) + nextData[frame] * amount
          }
        }
        this.smoothedBoundaries.add(boundaryKey)
      }
    }
  }

  private scheduleBufferedChunks(): void {
    if (!this.playing || !this.track) return
    const now = this.context.currentTime
    const trackNow = this.timelineTrackStart + Math.max(0, now - this.timelineContextStart)
    const chunkDuration = this.chunkDuration(this.track)
    for (const [key, buffer] of this.buffers) {
      if (this.scheduledChunks.has(key)) continue
      const [stem, rawIndex] = key.split(':') as [TrackStemName, string]
      const chunkStart = Number(rawIndex) * chunkDuration
      const chunkEnd = chunkStart + buffer.duration
      if (chunkEnd <= trackNow) continue

      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.connect(this.stemGains[stem])
      const offset = Math.max(0, trackNow - chunkStart)
      const when = now + Math.max(0, chunkStart - trackNow)
      source.addEventListener('ended', () => {
        this.activeSources.delete(source)
        source.buffer = null
        source.disconnect()
        if (this.playing && this.stemsAudible && this.activeSources.size === 0) {
          this.onBufferUnderrun?.(this.currentPosition())
        }
      }, { once: true })
      source.start(when, offset)
      this.activeSources.add(source)
      this.scheduledChunks.add(key)
    }
  }

  private crossfadeToStems(): void {
    const now = this.context.currentTime
    this.stemsAudible = true
    if (this.originalGain) {
      this.applyEqualPowerCrossfade(this.originalGain.gain, this.busGain.gain, now)
    } else {
      setParamRamp(this.busGain.gain, this.headroomGain(), now, this.gainRampSeconds)
    }
  }

  private applyEqualPowerCrossfade(outgoing: AudioParam, incoming: AudioParam, now: number): void {
    const points = 17
    const outgoingCurve = new Float32Array(points)
    const incomingCurve = new Float32Array(points)
    const incomingScale = incoming === this.busGain.gain ? this.headroomGain() : 1
    for (let index = 0; index < points; index += 1) {
      const phase = (index / (points - 1)) * Math.PI / 2
      outgoingCurve[index] = Math.cos(phase)
      incomingCurve[index] = Math.sin(phase) * incomingScale
    }
    outgoing.cancelScheduledValues(now)
    incoming.cancelScheduledValues(now)
    outgoing.setValueAtTime(outgoing.value, now)
    incoming.setValueAtTime(incoming.value, now)
    outgoing.setValueCurveAtTime(outgoingCurve, now, this.crossfadeSeconds)
    incoming.setValueCurveAtTime(incomingCurve, now, this.crossfadeSeconds)
  }

  private updateProtectionRoute(now: number): void {
    if (!this.directGain || !this.protectedGain) return
    const boosted = Object.values(this.gains).some(gain => gain > 1 + 1e-6)
    setParamRamp(this.directGain.gain, boosted ? 0 : 1, now, this.gainRampSeconds)
    setParamRamp(this.protectedGain.gain, boosted ? 1 : 0, now, this.gainRampSeconds)
  }

  private headroomGain(): number {
    // 100% all stems must reconstruct the original PCM exactly. Values above 100% are intentional
    // user boosts (up to +20%); keep unity bus gain and let the shared soft protection catch peaks.
    return 1
  }

  private currentPosition(): number {
    if (!this.track) return 0
    if (!this.playing) return this.position
    return clamp(
      this.timelineTrackStart + Math.max(0, this.context.currentTime - this.timelineContextStart),
      0,
      this.track.duration,
    )
  }

  private resetGeneration(): void {
    this.generation += 1
    for (const controller of this.pendingControllers) controller.abort()
    this.pendingControllers.clear()
    this.pendingLoads.clear()
  }

  private stopSources(when?: number, releaseBuffer = true): void {
    for (const source of this.activeSources) {
      try {
        source.stop(when)
      } catch {
        // A source may already have naturally ended.
      }
      if (releaseBuffer) {
        source.buffer = null
        source.disconnect()
        this.activeSources.delete(source)
      }
    }
  }

  private touchBuffer(key: string): void {
    const buffer = this.buffers.get(key)
    if (!buffer) return
    this.buffers.delete(key)
    this.buffers.set(key, buffer)
  }

  private evictBuffers(): void {
    while (this.buffers.size > this.maxBufferedChunks) {
      const oldest = this.buffers.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.buffers.delete(oldest)
      this.smoothedBoundaries.delete(oldest)
      const [stem, rawIndex] = oldest.split(':') as [TrackStemName, string]
      this.smoothedBoundaries.delete(`${stem}:${Number(rawIndex) + 1}`)
    }
  }

  private chunkDuration(track: TrackStemDescriptor): number {
    return track.chunkDuration ?? this.defaultChunkDuration
  }

  private chunkKey(stem: TrackStemName, chunkIndex: number): string {
    return `${stem}:${chunkIndex}`
  }

  private requireTrack(): TrackStemDescriptor {
    if (!this.track) throw new Error('TrackStemMixer has no loaded track')
    return this.track
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('TrackStemMixer has been disposed')
  }
}
