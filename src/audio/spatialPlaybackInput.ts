import { decodeSpatialWav, type SpatialAudioSource, type SpatialAudioDecodeOptions } from '../services/waveforge-engine-v3/src/integration/SpatialAudioSource'

export interface SpatialPlaybackSourceInfo {
  sampleRate: number
  channels: number
  inputFormat: SpatialAudioSource['inputFormat']
  layout: SpatialAudioSource['layout']
  channelLabels: string[]
  sourceChannelLabels: string[]
  channelMap: number[]
  warnings: string[]
}

export interface SpatialPlaybackInputOptions extends SpatialAudioDecodeOptions {
  /** 多声道 PCM 已接管该 deck；null 表示回到普通立体声（切歌/退出空间输入）。 */
  onSourceDecoded?: (source: SpatialPlaybackSourceInfo | null) => void
  /** 一次性提示（例如非 WAV 源无法验证声道顺序）；不中断播放。 */
  onSourceWarning?: (message: string) => void
  onSourceError?: (error: Error) => void
}

/** 只认文件扩展名（包括本机代理的 url 参数），不按声道数猜 Ambisonics。 */
export function isSpatialWavUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'http://localhost')
    const original = parsed.searchParams.get('url')
    return original && original !== url ? isSpatialWavUrl(original) : /\.wav(?:e)?$/i.test(decodeURIComponent(parsed.pathname))
  } catch { return /\.wav(?:e)?(?:[?#]|$)/i.test(url) }
}

/** 静音媒体只负责原播放器的时钟/ended；真实 PCM 从受控 BufferSource 进入同一 deck。 */
export function createSpatialClockWav(duration: number): Uint8Array {
  const rate = 8000
  const frames = Math.max(1, Math.ceil(duration * rate))
  if (!Number.isFinite(frames) || frames > 100_000_000) throw new RangeError('多声道播放时长超过安全上限')
  const bytes = new Uint8Array(44 + frames + frames % 2)
  const view = new DataView(bytes.buffer)
  const id = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) }
  id(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); id(8, 'WAVE'); id(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true)
  id(36, 'data'); view.setUint32(40, frames, true); bytes.fill(128, 44, 44 + frames)
  return bytes
}

/** 切去 v1/v2 时显式折叠，避免浏览器对 >8 声道执行不可验证的隐式混音。 */
export function foldSpatialPlaybackStereo(source: SpatialAudioSource): [Float32Array, Float32Array] {
  const left = new Float32Array(source.frames), right = new Float32Array(source.frames)
  if (source.inputFormat !== 'channels') {
    // W 是全向分量；AmbiX SN3D 的 W 与 FuMa W 的归一化不同。
    const scale = source.inputFormat === 'fuma' ? Math.SQRT2 : 1
    for (let i = 0; i < source.frames; i++) left[i] = right[i] = source.channels[0][i] * scale
    return [left, right]
  }
  source.channels.forEach((channel, index) => {
    const label = source.channelLabels[index]
    const l = label === 'FL' ? 1 : label === 'FR' ? 0 : /L$/.test(label) ? Math.SQRT1_2 : /R$/.test(label) ? 0 : label === 'LFE' ? 0.5 : Math.SQRT1_2
    const r = label === 'FR' ? 1 : label === 'FL' ? 0 : /R$/.test(label) ? Math.SQRT1_2 : /L$/.test(label) ? 0 : label === 'LFE' ? 0.5 : Math.SQRT1_2
    for (let i = 0; i < source.frames; i++) { left[i] += channel[i] * l; right[i] += channel[i] * r }
  })
  return [left, right]
}

/**
 * 双 deck 各自持有一个实例。元素仍是唯一播放时钟，BufferSource 跟随
 * playing/pause/seek/ratechange；不修改播放器的 currentTime store 或过渡增益。
 * 仅 WAV 能验证文件物理顺序；非 WAV 源（含显式 HOA/标签选择）按普通立体声播放，
 * 只提示一次，绝不因空间解码失败中断当前歌曲。
 */
export class SpatialPlaybackInput {
  private enabled = false
  private options: SpatialPlaybackInputOptions = {}
  private source: SpatialAudioSource | null = null
  private buffer: AudioBuffer | null = null
  private stereoBuffer: AudioBuffer | null = null
  private node: AudioBufferSourceNode | null = null
  private sourceGain: GainNode
  private originalUrl = ''
  private clockUrl = ''
  private revision = 0
  private abort: AbortController | null = null
  private sourceTime = 0
  private contextTime = 0
  private rate = 1
  private key = ''
  private disposed = false
  /** 空间 PCM 接管期间承载 MediaElement 的静音支路：元素时钟必须继续被音频图拉动。 */
  private mediaClockGain: GainNode
  private clockRouted = false
  private notified = false
  private warnedKey = ''

  constructor(private context: AudioContext, private element: HTMLAudioElement,
    private media: MediaElementAudioSourceNode, private destination: GainNode) {
    this.sourceGain = context.createGain()
    this.sourceGain.channelCountMode = 'max'
    this.sourceGain.channelInterpretation = 'discrete'
    this.sourceGain.connect(destination)
    this.mediaClockGain = context.createGain()
    this.mediaClockGain.gain.value = 0
    for (const event of ['playing', 'seeked', 'ratechange']) element.addEventListener(event, this.sync)
    for (const event of ['pause', 'ended', 'seeking', 'waiting']) element.addEventListener(event, this.stop)
    element.addEventListener('emptied', this.handleEmpty)
    element.addEventListener('timeupdate', this.correctDrift)
    element.addEventListener('volumechange', this.syncVolume)
  }

  configure(enabled: boolean, options: SpatialPlaybackInputOptions = {}): void {
    const key = JSON.stringify([options.inputFormat ?? 'channels', options.sourceChannelLabels, options.targetChannelLabels])
    const changed = this.key !== key
    const wasEnabled = this.enabled
    this.enabled = enabled; this.options = options; this.key = key
    if (this.source && !changed) { if (wasEnabled !== enabled) this.sync(); this.notify(); return }
    const url = this.originalUrl || this.element.currentSrc || this.element.getAttribute('src') || ''
    if (!enabled || !url || (!changed && wasEnabled)) return
    // 热切换到 HSE：原元素先继续发声，解码成功后才原子切到受控 PCM。
    void this.prepare(url).then(clock => {
      if (this.disposed || !this.enabled || clock === url) return
      const position = this.element.currentTime, playing = !this.element.paused
      this.element.src = clock
      this.element.addEventListener('loadedmetadata', () => {
        if (this.disposed || this.element.getAttribute('src') !== clock) return
        this.element.currentTime = position
        if (playing) void this.element.play().catch(() => undefined)
      }, { once: true })
      this.element.load()
    }).catch(error => { this.element.pause(); this.options.onSourceError?.(error instanceof Error ? error : new Error(String(error))) })
  }

  notify(): void {
    if (!this.enabled || !this.source) { this.emitSource(null); return }
    const s = this.source
    this.emitSource({ sampleRate: s.sampleRate, channels: s.channels.length, inputFormat: s.inputFormat,
      layout: s.layout, channelLabels: s.channelLabels.slice(), sourceChannelLabels: s.sourceChannelLabels.slice(),
      channelMap: s.channelMap.slice(), warnings: s.warnings.slice() })
  }

  /** 「已解码 → 未解码」只在上层已经收到过多声道源时通知一次，避免每首歌重复下发参数。 */
  private emitSource(source: SpatialPlaybackSourceInfo | null): void {
    if (source) { this.notified = true; this.options.onSourceDecoded?.(source); return }
    if (!this.notified) return
    this.notified = false
    this.options.onSourceDecoded?.(null)
  }

  /** 非 WAV 源只提示一次（每次切换输入格式），不中断播放、不逐曲弹错。 */
  private warnUnsupportedSource(): void {
    if (this.warnedKey === this.key) return
    this.warnedKey = this.key
    this.options.onSourceWarning?.('该音源不是 WAV，无法验证声道顺序：已按普通立体声播放（空间重排仅支持多声道 WAV）')
  }

  /**
   * 空间 PCM 接管期间保持 MediaElement 与音频图的连接（0 增益静音支路）：
   * 元素时钟由音频图拉动，断开则 element.currentTime 冻结，进度/seek/ended 全部停摆。
   */
  private attachElementClock(): void {
    if (this.clockRouted) return
    try { this.media.disconnect() } catch { /* 尚未接线 */ }
    this.media.connect(this.mediaClockGain)
    this.mediaClockGain.connect(this.destination)
    this.clockRouted = true
  }

  /** 恢复 MediaElement 直连 deck（普通立体声播放）。 */
  private detachElementClock(): void {
    if (!this.clockRouted) return
    try { this.mediaClockGain.disconnect() } catch { /* noop */ }
    try { this.media.disconnect() } catch { /* noop */ }
    this.media.connect(this.destination)
    this.clockRouted = false
  }

  matches(url: string): boolean { return this.originalUrl === url && Boolean(this.source) }
  get controlled(): boolean { return Boolean(this.source) }
  reset(): void { this.clear() }

  async prepare(url: string): Promise<string> {
    const explicit = (this.options.inputFormat && this.options.inputFormat !== 'channels') || this.options.sourceChannelLabels
    // 播放路径只对手工可验证的 WAV 做空间解码/重排。非 WAV 源（QQ/网易云 MP3/FLAC 等）经浏览器解码
    // 后无法验证物理声道顺序；即使 UI 显式选了 AmbiX/FuMa 也不能拿它当 WAV 手工解码——否则会抛
    // 「不是受支持的 RIFF/WAVE 文件」，中断当前播放并逐曲弹错误。这里直接按原 URL 走普通立体声。
    if (!url || !this.enabled || !isSpatialWavUrl(url)) {
      if (url && this.enabled && explicit) this.warnUnsupportedSource()
      this.clear(); this.originalUrl = url; return url
    }
    const revision = ++this.revision
    this.abort?.abort()
    const abort = new AbortController(); this.abort = abort
    const timer = setTimeout(() => abort.abort(), 30_000)
    try {
      const response = await fetch(url, { signal: abort.signal })
      if (!response.ok) throw new Error(`多声道源读取失败：HTTP ${response.status}`)
      if (Number(response.headers.get('content-length')) > 400_000_000) throw new Error('多声道源文件超过 400 MB 安全上限')
      const data = await response.arrayBuffer()
      if (data.byteLength > 400_000_000) throw new Error('多声道源文件超过 400 MB 安全上限')
      const decoded = decodeSpatialWav(data, this.options)
      if (decoded.channels.length > 32) throw new Error('HSE 实时播放最多支持 32 个输入声道')
      if (!decoded.frames) throw new Error('多声道源不含音频帧')
      if (revision !== this.revision || this.disposed) throw new DOMException('播放源已变化', 'AbortError')
      // 普通单/双声道维持原 MediaElement 路径，不额外占用整曲 PCM。
      if (decoded.channels.length <= 2 && !explicit) { this.clear(); this.originalUrl = url; return url }
      const buffer = this.context.createBuffer(decoded.channels.length, decoded.frames, decoded.sampleRate)
      decoded.channels.forEach((channel, index) => buffer.getChannelData(index).set(channel))
      const stereo = this.context.createBuffer(2, decoded.frames, decoded.sampleRate)
      foldSpatialPlaybackStereo(decoded).forEach((channel, index) => stereo.getChannelData(index).set(channel))
      const clock = createSpatialClockWav(decoded.duration)
      const clockUrl = URL.createObjectURL(new Blob([clock as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }))
      this.stop()
      if (this.clockUrl) URL.revokeObjectURL(this.clockUrl)
      this.originalUrl = url; this.clockUrl = clockUrl; this.source = decoded; this.buffer = buffer; this.stereoBuffer = stereo
      // 不能直接断开 MediaElementAudioSourceNode：Chromium 会把 HTMLMediaElement 的时钟交给音频图
      // 拉动，断开后 element.currentTime 冻结（进度/seek/ended 全部停摆）。改为经 0 增益静音支路
      // 保持连接，元素时钟继续前进，真实 PCM 走 sourceGain。
      this.attachElementClock()
      this.notify()
      return clockUrl
    } finally { clearTimeout(timer); if (this.abort === abort) this.abort = null }
  }

  private syncVolume = (): void => {
    this.sourceGain.gain.setValueAtTime(this.element.muted ? 0 : this.element.volume, this.context.currentTime)
  }

  private stop = (): void => {
    if (!this.node) return
    try { this.node.stop() } catch { /* 已结束 */ }
    this.node.disconnect(); this.node = null
  }

  private handleEmpty = (): void => { this.stop(); if (!this.element.getAttribute('src')) this.clear() }

  private sync = (): void => {
    this.stop()
    if (!this.source || this.element.paused || this.element.ended || this.element.seeking || this.element.readyState < 3 || this.disposed) return
    const buffer = this.enabled ? this.buffer : this.stereoBuffer
    if (!buffer || this.element.currentTime >= buffer.duration) return
    const node = this.context.createBufferSource()
    node.buffer = buffer; node.channelInterpretation = 'discrete'
    this.rate = Math.max(0.0625, this.element.playbackRate || 1)
    node.playbackRate.value = this.rate
    this.sourceTime = Math.max(0, this.element.currentTime); this.contextTime = this.context.currentTime
    this.syncVolume(); node.connect(this.sourceGain); node.start(0, this.sourceTime); this.node = node
    this.notify()
  }

  private correctDrift = (): void => {
    if (!this.node) return
    const expected = this.sourceTime + (this.context.currentTime - this.contextTime) * this.rate
    if (Math.abs(expected - this.element.currentTime) > 0.12) this.sync()
  }

  private clear(): void {
    this.revision++; this.abort?.abort(); this.abort = null; this.stop()
    // 受控多声道源 → 普通立体声：恢复元素直连，并通知上层回滚多声道自动布局参数（不能静默残留）。
    this.detachElementClock()
    this.source = null; this.buffer = null; this.stereoBuffer = null
    if (this.clockUrl) URL.revokeObjectURL(this.clockUrl)
    this.clockUrl = ''; this.originalUrl = ''
    this.emitSource(null)
  }

  dispose(): void {
    this.disposed = true; this.clear(); this.sourceGain.disconnect(); this.mediaClockGain.disconnect()
    for (const event of ['playing', 'seeked', 'ratechange']) this.element.removeEventListener(event, this.sync)
    for (const event of ['pause', 'ended', 'seeking', 'waiting']) this.element.removeEventListener(event, this.stop)
    this.element.removeEventListener('emptied', this.handleEmpty)
    this.element.removeEventListener('timeupdate', this.correctDrift)
    this.element.removeEventListener('volumechange', this.syncVolume)
  }
}
