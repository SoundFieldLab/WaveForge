// AirPlay 投送控制器（渲染进程）：负责连接状态订阅、播放状态同步、
// 音频采集的启停与 PCM 推送。所有 electron API 访问均做可用性兜底（浏览器模式 no-op）。
import type { AirplayDeviceInfo, AirplayMetadata, AirplayStatus } from '../electron'
import { startAirplayCapture, type AirplayCaptureHandle } from './airplayCapture'
import { AudioResampler, convertToS16Le } from './audioResample'

export interface AirplayPlaybackProbe {
  title: string
  artist: string
  album: string
  coverUrl: string
  durationMs: number
  elapsedMs: number
  isPlaying: boolean
}

type StatusListener = (status: AirplayStatus) => void

const STORAGE_KEYS = {
  enabled: 'airplayEnabled',
  mode: 'airplayMode',
  volume: 'airplayVolume',
  deviceId: 'airplayDeviceId',
  syncVolume: 'airplaySyncVolume',
  restoreVolume: 'airplayRestoreVolume',
  connectSound: 'airplayConnectSound',
} as const

const SYNC_INTERVAL_MS = 800
const PROGRESS_MIN_INTERVAL_MS = 1000

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch { /* 忽略 */ }
}

class AirplayController {
  private status: AirplayStatus | null = null
  private readonly listeners = new Set<StatusListener>()
  private initialized = false
  private unsubStatus: (() => void) | null = null
  private syncTimer: number | null = null
  private probe: (() => AirplayPlaybackProbe) | null = null
  private captureHandle: AirplayCaptureHandle | null = null
  private captureContext: AudioContext | null = null
  private captureSourceNode: AudioNode | null = null
  private outputGainNode: GainNode | null = null
  private resampler: AudioResampler | null = null
  private captureSampleRate = 0
  private lastTrackKey = ''
  private lastProgressSentAt = 0
  private captureActive = false
  private lastEnabledValue: boolean | null = null
  /** 诊断统计：已推送 PCM 块数 */
  private sentChunks = 0
  private lastCaptureDiagAt = 0
  /** 连接提示音：每次连接会话只响一次（切歌/过渡的 phase 抖动不再重复响） */
  private connectSoundPlayedInSession = false

  /** 诊断日志：同时输出到渲染控制台与主进程控制台（electron.log 桥） */
  private diag(message: string): void {
    console.log(`[AirPlay] ${message}`)
    try {
      const bridge = (window as any).electron
      if (bridge?.log) bridge.log(`[AirPlay] ${message}`)
    } catch { /* 忽略 */ }
  }

  // ---------- 生命周期 ----------

  init(): void {
    if (this.initialized) return
    this.initialized = true
    const bridge = (window as any).electron?.airplay
    if (!bridge) return
    this.unsubStatus = bridge.onStatus((status: AirplayStatus) => this.handleStatus(status))
    // 启动时主动拉一次状态（主进程可能在窗口加载前就已发现设备）
    void bridge.getStatus().then((status: AirplayStatus) => this.handleStatus(status)).catch(() => undefined)
    // 默认不开启设备发现：仅当用户之前在设置里开启过 AirPlay 时才恢复浏览
    if (this.getEnabled()) {
      void bridge.setEnabled(true)
    }
    // 同步循环：切歌元数据 / 进度 / 播放暂停与采集联动
    this.syncTimer = window.setInterval(() => this.syncTick(), SYNC_INTERVAL_MS)
  }

  dispose(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    this.unsubStatus?.()
    this.unsubStatus = null
    this.stopCapture()
    this.initialized = false
  }

  // ---------- 订阅与状态 ----------

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener)
    if (this.status) listener(this.status)
    return () => this.listeners.delete(listener)
  }

  getStatus(): AirplayStatus | null {
    return this.status
  }

  getDevices(): AirplayDeviceInfo[] {
    return this.status?.devices || []
  }

  getEnabled(): boolean {
    return readStored<boolean>(STORAGE_KEYS.enabled, false)
  }

  getMode(): 'auto' | 'raop' | 'airplay2' {
    const mode = readStored<string>(STORAGE_KEYS.mode, 'auto')
    return mode === 'raop' || mode === 'airplay2' ? mode : 'auto'
  }

  getVolume(): number {
    const volume = readStored<number>(STORAGE_KEYS.volume, 25)
    return Math.max(0, Math.min(100, volume))
  }

  getSyncVolume(): boolean {
    return readStored<boolean>(STORAGE_KEYS.syncVolume, false)
  }

  /** 断开后应恢复的设备音量（连接前记录，默认 30） */
  getRestoreVolume(): number {
    const v = readStored<number>(STORAGE_KEYS.restoreVolume, 30)
    return Math.max(0, Math.min(100, v))
  }

  /** 设置断开后恢复音量并同步主进程（连接时据此恢复设备音量） */
  async setRestoreVolume(volume: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Number(volume) || 0))
    writeStored(STORAGE_KEYS.restoreVolume, clamped)
    const bridge = (window as any).electron?.airplay
    if (!bridge) return
    await bridge.setRestoreVolume(clamped)
  }

  getLastDeviceId(): string {
    return readStored<string>(STORAGE_KEYS.deviceId, '')
  }

  /** 连接成功提示音开关（默认开） */
  getConnectSound(): boolean {
    return readStored<boolean>(STORAGE_KEYS.connectSound, true)
  }

  setConnectSound(enabled: boolean): void {
    writeStored(STORAGE_KEYS.connectSound, enabled)
  }

  /** 连接成功提示音：主进程合成并推入 AirPlay 发送管道，由音箱播出；
   *  旧版本地 Web Audio 走默认输出设备，已改由音箱出声 */
  private playConnectSound(): void {
    try {
      const bridge = (window as any).electron?.airplay
      if (bridge?.playConnectSound) {
        void bridge.playConnectSound()
      }
    } catch { /* 忽略 */ }
  }

  private handleStatus(status: AirplayStatus): void {
    this.status = status
    this.listeners.forEach((listener) => listener(status))
    const connected = status.phase === 'connected' || status.phase === 'streaming'
    // 提示音只在一次「用户主动连接」会话中响一次：connect() 会重置标记；
    // 切歌/异常导致的自动重连（idle→connected）不重置，因此不响提示音。
    if (connected && !this.connectSoundPlayedInSession && this.getConnectSound()) {
      this.connectSoundPlayedInSession = true
      this.playConnectSound()
    }
    // 采集随连接状态联动
    if (!connected) this.stopCapture()
  }

  // ---------- 操作 ----------

  async setEnabled(enabled: boolean): Promise<void> {
    writeStored(STORAGE_KEYS.enabled, enabled)
    this.lastEnabledValue = enabled
    const bridge = (window as any).electron?.airplay
    if (!bridge) return
    // 主进程侧：默认不开启设备发现（mDNS），开启开关后才开始浏览；关闭则停止并断开
    void bridge.setEnabled(enabled)
    if (!enabled) {
      await this.disconnect()
    }
  }

  async connect(deviceId: string, mode: 'auto' | 'raop' | 'airplay2' = 'auto'): Promise<{ success: boolean; error?: string }> {
    const bridge = (window as any).electron?.airplay
    if (!bridge) return { success: false, error: 'unsupported' }
    // 用户主动连接：本次会话允许响一次连接提示音（切歌自动重连不重置，不响）
    this.connectSoundPlayedInSession = false
    writeStored(STORAGE_KEYS.deviceId, deviceId)
    writeStored(STORAGE_KEYS.mode, mode)
    writeStored(STORAGE_KEYS.enabled, true)
    this.lastEnabledValue = true
    // 同步记忆的投送音量作为本次连接的初始音量（下次连接不用再手动调）
    void bridge.setVolume(this.getVolume())
    // 记录连接前/断开后应恢复的设备音量（断开与异常退出后都会恢复）
    void bridge.setRestoreVolume(this.getRestoreVolume())
    const result = await bridge.connect(deviceId, mode)
    if (result?.success) {
      // 连接成功后立即同步当前曲目元数据与播放状态
      this.lastTrackKey = ''
      this.syncTick(true)
    }
    return result || { success: false, error: 'no-response' }
  }

  async disconnect(): Promise<void> {
    const bridge = (window as any).electron?.airplay
    if (!bridge) return
    await bridge.disconnect()
    this.stopCapture()
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Number(volume) || 0))
    writeStored(STORAGE_KEYS.volume, clamped)
    const bridge = (window as any).electron?.airplay
    if (!bridge) return
    await bridge.setVolume(clamped)
    // 跟随软件音量开启时：AirPlay 音量变化同步软件音量条显示
    if (this.getSyncVolume()) {
      try {
        window.dispatchEvent(new CustomEvent('airplay-volume-changed', { detail: clamped / 100 }))
      } catch { /* 忽略 */ }
    }
  }

  /** 播放器主音量变化时调用；开启音量同步时联动 AirPlay 音箱音量 */
  setPlayerVolume(volume01: number): void {
    if (!this.getSyncVolume()) return
    void this.setVolume(Math.round(Math.max(0, Math.min(1, volume01)) * 100))
  }

  setSyncVolume(enabled: boolean): void {
    writeStored(STORAGE_KEYS.syncVolume, enabled)
  }

  // ---------- 采集源与播放探测 ----------

  /** 播放引擎音频图就绪后注入。sourceNode 为采集点（analyser：取完整混音，含音效）；
   *  outputGain 为本机输出增益节点（analyser 之后、destination 之前），置 0 静音本机但不影响采集。 */
  setCaptureSource(context: AudioContext, sourceNode: AudioNode, outputGain?: GainNode): void {
    this.captureContext = context
    this.captureSourceNode = sourceNode
    this.outputGainNode = outputGain || null
    this.resampler = null
  }

  /** AirPlay 投送时静音/恢复本机输出（只静音输出设备，采集不受影响） */
  setLocalMute(muted: boolean): void {
    if (this.outputGainNode && typeof this.outputGainNode.gain.setValueAtTime === 'function') {
      try {
        const ctx = this.captureContext
        if (ctx) this.outputGainNode.gain.setValueAtTime(muted ? 0 : 1, ctx.currentTime)
        else this.outputGainNode.gain.value = muted ? 0 : 1
      } catch { /* 忽略 */ }
    }
  }

  attachProbe(probe: () => AirplayPlaybackProbe): void {
    this.probe = probe
    this.lastTrackKey = ''
    this.syncTick(true)
  }

  detachProbe(): void {
    this.probe = null
  }

  // ---------- 内部 ----------

  private isConnected(): boolean {
    return this.status !== null && (this.status.phase === 'connected' || this.status.phase === 'streaming')
  }

  private syncTick(force = false): void {
    if (!this.isConnected()) return
    const bridge = (window as any).electron?.airplay
    if (!bridge) return
    const probe = this.probe?.()
    if (!probe) return

    const trackKey = `${probe.title}||${probe.artist}`
    if (trackKey !== this.lastTrackKey) {
      this.lastTrackKey = trackKey
      const metadata: AirplayMetadata = {
        trackKey: trackKey || undefined,
        title: probe.title,
        artist: probe.artist,
        album: probe.album,
        coverUrl: probe.coverUrl,
        durationMs: Math.max(0, probe.durationMs || 0),
        elapsedMs: Math.max(0, probe.elapsedMs || 0),
      }
      void bridge.setMetadata(metadata)
    } else {
      const now = Date.now()
      if (force || now - this.lastProgressSentAt >= PROGRESS_MIN_INTERVAL_MS) {
        this.lastProgressSentAt = now
        void bridge.setProgress(probe.elapsedMs / 1000, probe.durationMs / 1000)
      }
    }

    // 播放中 -> 保持投送；暂停 -> 停发 PCM（保留会话，恢复时续发）
    bridge.setStreaming(probe.isPlaying)
    if (probe.isPlaying) {
      this.ensureCapture()
      // 诊断：播放中但采集迟迟未推送（每 5s 提示一次，暴露断点）
      const now = Date.now()
      if (!this.captureActive && now - (this.lastCaptureDiagAt || 0) > 5000) {
        this.lastCaptureDiagAt = now
        this.diag(`播放中但采集未推送（captureActive:${this.captureActive} context:${Boolean(this.captureContext)} source:${Boolean(this.captureSourceNode)} probe:${Boolean(probe)}）`)
      }
    } else {
      this.stopCapture()
    }
  }

  private ensureCapture(): void {
    if (this.captureActive) return
    if (!this.captureContext || !this.captureSourceNode) {
      this.diag(`采集暂不可用：音频图未就绪（context:${Boolean(this.captureContext)} source:${Boolean(this.captureSourceNode)}）`)
      return
    }
    const bridge = (window as any).electron?.airplay
    if (!bridge) return
    const context = this.captureContext
    this.diag(`启动音频采集（sampleRate ${context.sampleRate}）…`)
    void startAirplayCapture(context, this.captureSourceNode, (chunk, sampleRate) => {
      this.pushPcm(chunk, sampleRate)
    }).then((handle) => {
      this.captureHandle = handle
      this.captureActive = true
      this.diag('音频采集已启动')
    }).catch((error) => {
      this.diag(`音频采集启动失败: ${error instanceof Error ? error.message : String(error)}`)
      this.captureActive = false
    })
  }

  private stopCapture(): void {
    if (this.captureHandle) {
      this.captureHandle.stop()
      this.captureHandle = null
    }
    this.captureActive = false
  }

  private pushPcm(chunk: Float32Array, sampleRate: number): void {
    const bridge = (window as any).electron?.airplay
    if (!bridge) return
    if (!this.captureActive) return
    if (sampleRate !== this.captureSampleRate || !this.resampler) {
      this.resampler = new AudioResampler(sampleRate, 44100, 2)
      this.captureSampleRate = sampleRate
    }
    const s16 = convertToS16Le(this.resampler.needsResample ? this.resampler.process(chunk) : chunk)
    // 诊断统计：每 200 块打一次
    this.sentChunks += 1
    if (this.sentChunks % 200 === 0) this.diag(`渲染侧已推送 ${this.sentChunks} 块 PCM`)
    bridge.sendPcm(s16)
  }
}

export const airplayController = new AirplayController()
