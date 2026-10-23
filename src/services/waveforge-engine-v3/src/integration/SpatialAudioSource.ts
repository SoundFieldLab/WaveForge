import type { SpatialInputFormat } from '../spatial/AmbisonicDecoder'

export type SpatialAudioLayout = 'mono' | 'stereo' | 'quad' | '51' | '71' | '714' | 'custom' | 'ambisonics' | 'unknown'
export interface SpatialAudioDecodeOptions {
  inputFormat?: SpatialInputFormat
  /** 源文件物理声道顺序；显式指定时覆盖 mask 解释。 */
  sourceChannelLabels?: readonly string[]
  /** 输出重排目标；必须与源标签构成同一集合，禁止遗漏或重复。 */
  targetChannelLabels?: readonly string[]
}
export interface SpatialAudioSource {
  sampleRate: number
  channels: Float32Array[]
  frames: number
  duration: number
  channelLabels: string[]
  sourceChannelLabels: string[]
  /** 输出平面 -> 原始文件物理声道索引。 */
  channelMap: number[]
  inputFormat: SpatialInputFormat
  layout: SpatialAudioLayout
  warnings: string[]
  encoding: 'pcm' | 'float' | 'browser'
  bitsPerSample?: number
  validBitsPerSample?: number
  channelMask?: number
}
export interface BrowserAudioBufferLike {
  sampleRate: number
  numberOfChannels: number
  length: number
  getChannelData(channel: number): Float32Array
}
export interface SpatialAudioDecoderLike {
  decodeAudioData(data: ArrayBuffer): Promise<BrowserAudioBufferLike>
}

const STANDARD_LAYOUTS: ReadonlyArray<readonly [SpatialAudioLayout, readonly string[]]> = [
  ['mono', ['FC']], ['stereo', ['FL', 'FR']], ['quad', ['FL', 'FR', 'SL', 'SR']],
  ['51', ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']],
  ['71', ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'BL', 'BR']],
  ['714', ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'BL', 'BR', 'topFL', 'topFR', 'topBL', 'topBR']],
]
const MASK_LABELS = ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'BC', 'SL', 'SR',
  'topC', 'topFL', 'topFC', 'topFR', 'topBL', 'topBC', 'topBR'] as const
const readId = (bytes: Uint8Array, at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
const fail = (message: string): never => { throw new Error(`WAV: ${message}`) }
function validateLabels(labels: readonly string[], count: number): string[] {
  if (labels.length !== count || labels.some(label => !label.trim()) || new Set(labels).size !== count) {
    throw new RangeError('声道标签必须覆盖全部物理声道，且每个标签非空并唯一')
  }
  return Array.from(labels)
}
function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(label => b.includes(label))
}
function route(channels: Float32Array[], options: SpatialAudioDecodeOptions,
  mask: number | undefined, allowUnknown: boolean): Pick<SpatialAudioSource,
  'channels' | 'channelLabels' | 'sourceChannelLabels' | 'channelMap' | 'inputFormat' | 'layout' | 'warnings'> {
  const count = channels.length, format = options.inputFormat ?? 'channels'
  if (format !== 'channels') {
    const expected = format === 'ambix2' ? 9 : format === 'ambix3' ? 16 : ['ambix', 'ambix1', 'fuma'].includes(format) ? 4 : 0
    if (count !== expected) throw new RangeError(`${format} 要求 ${expected} 声道，实际为 ${count}`)
    if (options.sourceChannelLabels || options.targetChannelLabels) throw new Error('Ambisonics 使用声明的原始顺序，不接受离散扬声器重排')
    const labels = format === 'fuma' ? ['W', 'X', 'Y', 'Z'] : Array.from({ length: count }, (_, i) => `ACN${i}`)
    return { channels, channelLabels: labels, sourceChannelLabels: labels.slice(), channelMap: labels.map((_, i) => i),
      inputFormat: format, layout: 'ambisonics', warnings: [] }
  }
  let labels: string[] = [], warnings: string[] = []
  if (options.sourceChannelLabels) labels = validateLabels(options.sourceChannelLabels, count)
  else if (mask) {
    if ((mask >>> MASK_LABELS.length) !== 0) fail('声道 mask 含未知扬声器位；请显式提供 sourceChannelLabels')
    labels = MASK_LABELS.filter((_, bit) => (mask & 2 ** bit) !== 0)
    if (labels.length !== count) fail('声道 mask 中的置位数量与声道数不一致')
  } else if (count === 1) labels = ['FC']
  else if (count === 2) labels = ['FL', 'FR']
  else if (allowUnknown) {
    labels = Array.from({ length: count }, (_, i) => `channel${i + 1}`)
    warnings = ['浏览器解码未提供可验证的声道标签；已保留全部 PCM 平面，需显式指定源声道标签后用于空间渲染。']
  } else fail('多声道 WAV 没有有效的声道 mask；请显式指定 sourceChannelLabels，不能根据声道数猜测顺序')
  const sourceLabels = labels.slice()
  // 传统 Quad/5.1 后环绕命名与 HSE 侧环绕位置兼容；7.1 同时存在两组，不得折叠。
  if (!options.sourceChannelLabels && (count === 4 || count === 6) && labels.includes('BL') && !labels.includes('SL')) {
    labels = labels.map(label => label === 'BL' ? 'SL' : label === 'BR' ? 'SR' : label)
  }
  const preset = STANDARD_LAYOUTS.find(([, expected]) => sameLabels(labels, expected))
  const target = options.targetChannelLabels ? validateLabels(options.targetChannelLabels, count) : preset ? Array.from(preset[1]) : labels.slice()
  if (!sameLabels(labels, target)) throw new RangeError('目标声道标签必须与源标签一一对应，不能添加、遗漏或重复')
  const channelMap = target.map(label => labels.indexOf(label))
  const layout = preset && target.every((label, index) => label === preset[1][index]) ? preset[0]
    : allowUnknown && warnings.length ? 'unknown' : 'custom'
  return { channels: channelMap.map(index => channels[index]), channelLabels: target, sourceChannelLabels: sourceLabels,
    channelMap, inputFormat: 'channels', layout, warnings }
}

/** 手工读取 RIFF/WAVE，保留多声道 PCM，不经过浏览器的隐式重采样或混音。 */
export function decodeSpatialWav(data: ArrayBuffer | Uint8Array, options: SpatialAudioDecodeOptions = {}): SpatialAudioSource {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 12 || readId(bytes, 0) !== 'RIFF' || readId(bytes, 8) !== 'WAVE') fail('不是受支持的 RIFF/WAVE 文件')
  const end = view.getUint32(4, true) + 8
  if (end > bytes.length || end < 12) fail('RIFF 长度超出实际文件')
  let fmtAt = -1, fmtSize = 0, dataAt = -1, dataSize = 0
  for (let at = 12; at < end;) {
    if (at + 8 > end) fail('截断的 chunk 头')
    const id = readId(bytes, at), size = view.getUint32(at + 4, true), payload = at + 8
    if (payload + size > end) fail(`截断的 ${id} chunk`)
    if (id === 'fmt ') {
      if (fmtAt >= 0) fail('重复的 fmt chunk')
      fmtAt = payload; fmtSize = size
    } else if (id === 'data') {
      if (dataAt >= 0) fail('多个 data chunk 尚不支持')
      dataAt = payload; dataSize = size
    }
    const next = payload + size + size % 2
    if (next > end) fail('缺失奇数字节 chunk 的填充字节')
    at = next
  }
  if (fmtAt < 0 || fmtSize < 16 || dataAt < 0) fail('缺少完整 fmt 或 data chunk')
  let encoding = view.getUint16(fmtAt, true)
  const channelCount = view.getUint16(fmtAt + 2, true), sampleRate = view.getUint32(fmtAt + 4, true)
  const byteRate = view.getUint32(fmtAt + 8, true), blockAlign = view.getUint16(fmtAt + 12, true)
  const bits = view.getUint16(fmtAt + 14, true)
  let validBits = bits, mask: number | undefined
  if (encoding === 0xfffe) {
    if (fmtSize < 40 || view.getUint16(fmtAt + 16, true) < 22 || view.getUint16(fmtAt + 16, true) + 18 > fmtSize) fail('WAVEFORMATEXTENSIBLE 扩展截断')
    validBits = view.getUint16(fmtAt + 18, true)
    mask = view.getUint32(fmtAt + 20, true)
    const guidTail = [0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]
    if (!guidTail.every((value, index) => view.getUint8(fmtAt + 28 + index) === value)) fail('未知的扩展 SubFormat GUID')
    encoding = view.getUint32(fmtAt + 24, true)
  }
  if (encoding !== 1 && encoding !== 3) fail('不支持压缩 WAV；仅支持 PCM 与 IEEE float')
  if (!channelCount || channelCount > 64 || !sampleRate || sampleRate > 768000) fail('非法的声道数或采样率')
  if ((encoding === 1 && ![8, 16, 24, 32].includes(bits)) || (encoding === 3 && ![32, 64].includes(bits))) fail('不支持的采样容器位数')
  if (!validBits || validBits > bits || (encoding === 3 && validBits !== bits)) fail('有效采样位数非法')
  const bytesPerSample = bits / 8
  if (blockAlign !== channelCount * bytesPerSample || byteRate !== sampleRate * blockAlign || dataSize % blockAlign !== 0) fail('blockAlign、byteRate 或数据帧长度不一致')
  const frames = dataSize / blockAlign
  if (frames * channelCount > 100_000_000) fail('解码后的 PCM 超过安全内存上限')
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))
  let nonfinite = false
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const at = dataAt + frame * blockAlign + channel * bytesPerSample
      let sample: number
      if (encoding === 3) {
        sample = bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true)
        if (!Number.isFinite(sample) || Math.abs(sample) > 3.4028234663852886e38) { sample = 0; nonfinite = true }
      } else {
        let raw: number
        if (bits === 8) raw = view.getUint8(at) - 128
        else if (bits === 16) raw = view.getInt16(at, true)
        else if (bits === 24) {
          raw = view.getUint8(at) | view.getUint8(at + 1) << 8 | view.getUint8(at + 2) << 16
          if (raw & 0x800000) raw -= 0x1000000
        } else raw = view.getInt32(at, true)
        // 有效位在容器高位左对齐，丢弃低位填充后按有效位数归一化。
        sample = Math.floor(raw / 2 ** (bits - validBits)) / 2 ** (validBits - 1)
      }
      channels[channel][frame] = sample
    }
  }
  const routing = route(channels, options, mask, false)
  if (nonfinite) routing.warnings.push('非有限或超出 Float32 范围的浮点采样已替换为静音。')
  return { ...routing, sampleRate, frames, duration: frames / sampleRate,
    encoding: encoding === 1 ? 'pcm' : 'float', bitsPerSample: bits, validBitsPerSample: validBits, channelMask: mask }
}

/** 只读取调用方选取的本地文件；WAV 始终优先手工解码，错误不回退浏览器。 */
export async function decodeSpatialAudioFile(file: { arrayBuffer(): Promise<ArrayBuffer>; name?: string },
  decoder?: SpatialAudioDecoderLike, options: SpatialAudioDecodeOptions = {}): Promise<SpatialAudioSource> {
  const data = await file.arrayBuffer(), bytes = new Uint8Array(data)
  if (['RIFF', 'RIFX', 'RF64'].includes(readId(bytes, 0)) || /\.wav(?:e)?$/i.test(file.name ?? '')) {
    return decodeSpatialWav(data, options)
  }
  if (!decoder) throw new Error('该格式需要浏览器 decodeAudioData 解码器')
  const audio = await decoder.decodeAudioData(data)
  if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0 || !Number.isInteger(audio.numberOfChannels) || audio.numberOfChannels < 1 || audio.numberOfChannels > 64 || !Number.isInteger(audio.length) || audio.length < 0 || audio.length * audio.numberOfChannels > 100_000_000) {
    throw new Error('浏览器返回了非法的音频缓冲')
  }
  const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => Float32Array.from(audio.getChannelData(channel), sample => Number.isFinite(sample) ? sample : 0))
  if (channels.some(channel => channel.length !== audio.length)) throw new Error('浏览器音频缓冲的声道长度不一致')
  return { ...route(channels, options, undefined, true), sampleRate: audio.sampleRate,
    frames: audio.length, duration: audio.length / audio.sampleRate, encoding: 'browser' }
}
