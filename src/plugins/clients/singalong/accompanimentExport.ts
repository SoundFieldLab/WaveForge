/**
 * 学歌 · 伴奏导出：把当前歌的分离分轨（HTDemucs）拼成伴奏 WAV 下载。
 *
 * 流程：复用 useAudioPlayer 同款的 trackStems bridge（ensureWindow 按 20s 核心段
 * 请求人声/伴奏分轨）→ OfflineAudioContext 里「原曲 - 人声」合成伴奏（drums/bass/other
 * 已由分离给出，直接叠加即可，不再用减法避免相位残留）→ encodeWav → <a download>。
 *
 * 版权提示：导出物即歌曲音频的衍生文件，首次使用必须过免责声明（存 localStorage，
 * 用户确认一次后不再重复弹，免责文本见 SINGALONG_EXPORT_DISCLAIMER）。
 */
import { encodeWav } from '../../../audio/TransitionRenderer'

export const SINGALONG_EXPORT_DISCLAIMER_KEY = 'wf_singalong_export_disclaimer'

/** 首次使用伴奏导出的免责声明（版权风险由用户自担）。 */
export const SINGALONG_EXPORT_DISCLAIMER = [
  '伴奏导出功能会把当前歌曲的伴奏音轨保存为本地 WAV 文件。',
  '你很清楚：这本质上是对受版权保护歌曲的下载与衍生使用。伴奏文件仅限个人学习、练习使用，请勿公开传播、二次分发或用于任何商业用途——这些行为可能侵犯录音制作者权与词曲版权，相关法律责任由你自行承担。',
  'WaveForge 只在本机完成音轨分离与合成，不提供、不存储、不分发任何歌曲内容；分轨质量受算法限制，导出结果仅供练习参考。',
  '继续使用即表示你已阅读并同意：导出行为的全部后果由你自己承担。',
]

export function isExportDisclaimerAccepted(): boolean {
  try {
    return localStorage.getItem(SINGALONG_EXPORT_DISCLAIMER_KEY) === '1'
  } catch {
    return false
  }
}

export function acceptExportDisclaimer(): void {
  try {
    localStorage.setItem(SINGALONG_EXPORT_DISCLAIMER_KEY, '1')
  } catch {
    /* ignore */
  }
}

export interface ExportAccompanimentOptions {
  /** 分轨桥（window.electron.trackStems）。 */
  bridge: {
    ensureWindow: (request: {
      inputPath: string
      trackId: string
      generationToken: string
      requestId?: string
      chunkSeconds?: 5 | 10
      start: number
      duration: number
      priority?: number
    }) => Promise<import('../../../electron').TrackStemManifest | null>
    readChunk: (filePath: string) => Promise<ArrayBuffer>
  }
  /** 整曲音频的本地缓存路径（audioDownload.prepare 的产物）。 */
  inputPath: string
  trackId: string
  /** 歌曲时长（秒）。 */
  duration: number
  /** 原曲采样率（合成目标采样率，默认 44100）。 */
  sampleRate?: number
  /** 进度回调（0..1，按核心段计）。 */
  onProgress?: (progress: number) => void
  signal?: AbortSignal
  /** 各轨增益（与界面「自定义分轨」一致；默认全 1 = 纯伴奏。vocals > 0 可把原声按比例混进"伴奏"里）。 */
  gains?: { vocals?: number; drums?: number; bass?: number; other?: number }
}

const CORE_SECONDS = 20

/** 导出格式与音质选项。 */
export type ExportFormat = 'wav' | 'mp3'
export interface ExportQuality {
  /** 合成目标采样率。 */
  sampleRate: number
  /** MP3 比特率（kbps）；WAV 忽略。 */
  kbps: number
  label: string
}

export const EXPORT_QUALITIES: ExportQuality[] = [
  { sampleRate: 44100, kbps: 128, label: '标准 44.1kHz' },
  { sampleRate: 44100, kbps: 320, label: '高品 320kbps' },
  { sampleRate: 48000, kbps: 320, label: '录音室 48kHz' },
]

/** 导出文件名规范：[伴奏]歌手名-歌曲名（含尾缀由调用方按格式加）。 */
export function accompanimentFileName(song: { name?: string; artists?: Array<{ name: string }> }): string {
  const artist = (song.artists || []).map(item => item?.name).filter(Boolean).join('、') || '未知歌手'
  const title = (song.name || '未知歌曲').replace(/[\\/:*?"<>|]/g, '_')
  return `[伴奏]${artist}-${title}`
}

/** 拉取并缓存全部四轨后的产物（供实时重混与导出复用，避免二次拉取）。 */
export interface RenderedStems {
  stems: Map<number, Partial<Record<'vocals' | 'drums' | 'bass' | 'other', AudioBuffer>>>
  sampleRate: number
  totalSeconds: number
  stemNames: readonly ('vocals' | 'drums' | 'bass' | 'other')[]
}

/** 拉取全部四轨分轨并解码缓存（导出与试听共用；重混时不再二次拉取）。 */
export async function fetchAndCacheStems(options: ExportAccompanimentOptions): Promise<RenderedStems> {
  const { bridge, inputPath, trackId, duration, onProgress, signal } = options
  const sampleRate = options.sampleRate || 44100
  const totalSeconds = Math.max(1, Math.min(duration, 60 * 15))
  const generation = `export-${trackId}-${Date.now()}`

  const cores: number[] = []
  for (let start = 0; start < totalSeconds; start += CORE_SECONDS) cores.push(start)
  const totalCores = cores.length

  // 1. 逐核心段拉四轨（gains.vocals > 0 时把人声按增益混入，可做"带轻声提词的练习伴奏"）
  const STEMS = ['drums', 'bass', 'other', 'vocals'] as const
  const decodedCores = new Map<number, Partial<Record<(typeof STEMS)[number], AudioBuffer>>>()
  for (let index = 0; index < cores.length; index += 1) {
    if (signal?.aborted) throw new Error('已取消')
    const coreStart = cores[index]
    const coreDuration = Math.min(CORE_SECONDS, totalSeconds - coreStart)
    const manifest = await bridge.ensureWindow({
      inputPath,
      trackId,
      generationToken: generation,
      requestId: `${trackId}:export:core-${index}`,
      chunkSeconds: 5,
      start: coreStart,
      duration: Math.max(0.05, coreDuration),
      priority: 2_000_000,
    })
    if (!manifest) throw new Error('分轨服务未返回数据（请先在伴奏模式完成一次分离）')
    const core: Partial<Record<(typeof STEMS)[number], AudioBuffer>> = {}
    // OfflineAudioContext 解码（decodeAudioData 在普通 context 上也可用，但为不占用播放引擎图用离线上下文）
    const decodeContext = new OfflineAudioContext(2, 1, sampleRate)
    for (const stem of STEMS) {
      // 人声即使增益为 0 也要拉下来缓存：弹窗里拖动滑杆实时重混要用
      const file = manifest.chunks.flatMap(chunk => chunk.files?.[stem] ? [chunk.files[stem]] : [])[0]
      if (!file) continue
      const buffer = await bridge.readChunk(file)
      core[stem] = await decodeContext.decodeAudioData(buffer.slice(0))
    }
    decodedCores.set(coreStart, core)
    onProgress?.(Math.min(0.9, (index + 1) / totalCores * 0.9))
  }

  onProgress?.(1)
  return { stems: decodedCores, sampleRate, totalSeconds, stemNames: STEMS }
}

/**
 * 用已缓存的分轨做一次增益重混（本地运算，秒级）。
 * 导出弹窗里拖动滑杆时调用：不重新走 ensureWindow。
 */
export async function remixStems(cached: RenderedStems, gains: { vocals?: number; drums?: number; bass?: number; other?: number }): Promise<AudioBuffer> {
  const { stems, sampleRate, totalSeconds, stemNames } = cached
  const frames = Math.ceil(totalSeconds * sampleRate)
  const offline = new OfflineAudioContext(2, frames, sampleRate)
  for (const [coreStart, core] of stems) {
    for (const stem of stemNames) {
      const buffer = core[stem]
      if (!buffer) continue
      const gain = gains[stem]
      if (gain === undefined || gain <= 0) continue
      const source = offline.createBufferSource()
      source.buffer = buffer
      const gainNode = offline.createGain()
      gainNode.gain.value = gain
      source.connect(gainNode)
      gainNode.connect(offline.destination)
      source.start(coreStart)
    }
  }
  return offline.startRendering()
}

/** 一次性合成（拉轨 + 重混），供确认导出走完整流程。 */
export async function renderAccompanimentOnce(options: ExportAccompanimentOptions): Promise<{ buffer: AudioBuffer; cached: RenderedStems }> {
  const cached = await fetchAndCacheStems(options)
  const buffer = await remixStems(cached, options.gains || {})
  return { buffer, cached }
}

/** AudioBuffer → Blob（WAV 或 MP3，MP3 走 lamejs 320kbps）。 */
export async function encodeAudioBlob(buffer: AudioBuffer, format: ExportFormat, kbps: number): Promise<Blob> {
  if (format === 'wav') {
    return new Blob([encodeWav(buffer)], { type: 'audio/wav' })
  }
  const { ensureLameEncoder } = await import('../../../services/waveforge-engine-v3/attachV3Engine')
  const Encoder = await ensureLameEncoder()
  const channels = Math.min(2, buffer.numberOfChannels) as 1 | 2
  const encoder = new Encoder(channels, buffer.sampleRate, kbps)
  const left = buffer.getChannelData(0)
  const right = channels === 2 ? buffer.getChannelData(1) : left
  const toInt16 = (data: Float32Array): Int16Array => {
    const out = new Int16Array(data.length)
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.max(-1, Math.min(1, data[i]))
      out[i] = value < 0 ? value * 0x8000 : value * 0x7fff
    }
    return out
  }
  const leftInt = toInt16(left)
  const rightInt = channels === 2 ? toInt16(right) : undefined
  // 分块编码（lamejs 每 1152 采样一帧，块太大内存峰值高）
  const blockSize = 1152 * 64
  const parts: Int8Array[] = []
  for (let offset = 0; offset < leftInt.length; offset += blockSize) {
    const chunkLeft = leftInt.subarray(offset, Math.min(offset + blockSize, leftInt.length))
    const chunkRight = rightInt?.subarray(offset, Math.min(offset + blockSize, rightInt.length))
    const encoded = channels === 2 ? encoder.encodeBuffer(chunkLeft, chunkRight) : encoder.encodeBuffer(chunkLeft)
    if (encoded.length > 0) parts.push(encoded)
  }
  const flushed = encoder.flush()
  if (flushed.length > 0) parts.push(flushed)
  return new Blob(parts as BlobPart[], { type: 'audio/mpeg' })
}

/**
 * 导出伴奏（触发浏览器下载）。
 * 返回文件名；抛错时由调用方展示。
 */
export async function exportAccompaniment(options: ExportAccompanimentOptions & { format?: ExportFormat; fileName?: string; kbps?: number }): Promise<string> {
  const format = options.format || 'wav'
  const cached = await fetchAndCacheStems(options)
  const rendered = await remixStems(cached, options.gains || {})
  const blob = await encodeAudioBlob(rendered, format, options.kbps ?? 320)
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  // a.download 的文件名在 Electron 里会映射到保存对话框的默认名；blob 顶部地址栏显示
  // 的是浏览器行为，桌面版走主进程保存对话框后不再出现（见 SingAlongView 的导出弹窗）。
  anchor.download = `${options.fileName || '伴奏'}.${format === 'wav' ? 'wav' : 'mp3'}`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 15_000)
  return anchor.download
}
