/**
 * DG_LAB 插件渲染端客户端：与 local-server 内嵌中继（/dglab/ctrl）通信。
 *
 * - 状态经订阅暴露给 React（useSyncExternalStore）；
 * - 激活（activate）：探测中继、建立 ctrl WS、下发设置并启动映射引擎；
 * - 停用（deactivate）：停止引擎（中继侧自动 clear 归零）并断开；
 * - 音频特征流：由 DGLabPlugin 订阅全局音频分析 store 后 30fps 推入。
 */

import { useSyncExternalStore } from 'react'
import type { AudioAnalyzerStore } from '../../hooks/useAudioAnalyzer'

const DGLAB_API = 'http://localhost:3001/api/dglab'
const SETTINGS_KEY = 'wf_dglab_settings'
const DEFAULT_PORT = 30082

export type FeelStyleId = 'stereo' | 'heartbeat' | 'breath' | 'wave' | 'tap' | 'ride' | 'rumble' | 'stock'
export type StepPreset = 'strong' | 'medium' | 'weak' | 'custom'
export type RampPreset = 'fast' | 'medium' | 'slow'

export interface DGLabSettings {
  version: 'v3' | 'v4'
  port: number
  /** 用户选择的网卡 IP（空 = 自动选第一个局域网 IP）。 */
  address: string
  /** 扫码 schema：a = README 官方格式，b = 备选（V3 用 dungeon-lab.cn）。 */
  qrSchema: 'a' | 'b'
  /** 体感风格（7 套），默认「立体声」。 */
  feelStyle: FeelStyleId
  sensitivity: number
  smoothing: number
  /** 强度差档位（体质）：strong/medium/weak/custom。 */
  stepPreset: StepPreset
  /** 自定义强度差（stepPreset=custom 时生效）。 */
  stepLimit: number
  /** 恢复适应时间档位：fast/medium/slow。 */
  rampPreset: RampPreset
  /** 动态适配：根据歌曲轻响自动分配强度（AGC）。 */
  dynamicRange: boolean
  /** 实时映射模式（对齐官方实时音频）：auto=自适应 / manual=自定义。 */
  rtMode: 'auto' | 'manual'
  /** 数据增益：输入信号放大倍数（官方同名参数）。 */
  rtGain: number
  /** 范围：映射窗口宽度（低端固定 0.03，高端 = 0.03 + 范围）。 */
  rtRange: number
  /** 高适应系数：信号强时增益自适应速度（官方同名）。 */
  rtHigh: number
  /** 低适应系数：信号弱时增益自适应速度（官方同名）。 */
  rtLow: number
  /** 迟滞系数：阈值附近的防抖带宽（官方同名）。 */
  rtHys: number
  /** 观察频段：驱动增益与实时波形的频段（全部/低频/中频/高频/左右）。 */
  rtBand: 'all' | 'low' | 'mid' | 'high' | 'stereo'
  /** 频率映射：能量→实时波形频率的映射曲线（线性/对数/深沉/明亮）。 */
  rtFreqMap: 'linear' | 'log' | 'deep' | 'bright'
  /** 波形输出启禁（播放页按钮；仅暂停输出，不断开）。 */
  outputEnabled: boolean
  /** 整机监听：直接捕获系统扬声器声音映射成波形（不局限于本软件播放）。 */
  systemCapture: boolean
  caps: { A: number; B: number }
  driveMode: 'energy' | 'onset'
  pulseEnabled: boolean
  waveId: string
  waveFreq: number
  waveStrength: number
}

export const DEFAULT_DGLAB_SETTINGS: DGLabSettings = {
  version: 'v3',
  port: DEFAULT_PORT,
  address: '',
  qrSchema: 'a',
  feelStyle: 'stereo',
  sensitivity: 1,
  smoothing: 0.5,
  stepPreset: 'weak',
  stepLimit: 5,
  rampPreset: 'slow',
  dynamicRange: true,
  rtMode: 'auto',
  rtGain: 1,
  rtRange: 0.6,
  rtHigh: 0.25,
  rtLow: 0.08,
  rtHys: 0.05,
  rtBand: 'all',
  rtFreqMap: 'linear',
  outputEnabled: true,
  systemCapture: false,
  caps: { A: 60, B: 60 },
  driveMode: 'energy',
  pulseEnabled: true,
  waveId: 'beat',
  waveFreq: 20,
  waveStrength: 100,
}

/** 设置变更事件（控制台滑杆/播放页按钮实时同步）。 */
export const DGLAB_SETTINGS_EVENT = 'dglabSettingsChanged'

/** 强度差档位取值（单次更新最大变化量）。 */
export const STEP_PRESET_VALUES: Record<StepPreset, number> = { strong: 30, medium: 12, weak: 5, custom: 0 }

/** 读取「开发者模式」（设置页开关，localStorage.developerMode）。 */
export function isDeveloperMode(): boolean {
  try {
    return localStorage.getItem('developerMode') === 'true'
  } catch {
    return false
  }
}

export interface DGLabOutput {
  A: number
  B: number
  beat: number
}

export interface DGLabNetIf {
  address: string
  name: string
}

export interface DGLabStatus {
  available: boolean
  running: boolean
  state: 'idle' | 'waiting' | 'bound' | 'unavailable'
  version: 'v3' | 'v4'
  port: number
  lanIps: string[]
  ips: DGLabNetIf[]
  devMode: boolean
  qrSchema: 'a' | 'b'
  urlV3: string
  urlV4: string
  qrV3: string | null
  qrV4: string | null
  deviceName: string | null
  slotIds: string[]
  softLimit: { A: number; B: number } | null
  /** App 反馈的设备当前强度（V3）。 */
  deviceStrength: { A: number; B: number } | null
  bound: boolean
  connected: boolean
  logs: string[]
  out: DGLabOutput | null
  lastError: string | null
}

const EMPTY_STATUS: DGLabStatus = {
  available: false,
  running: false,
  state: 'unavailable',
  version: 'v3',
  port: DEFAULT_PORT,
  lanIps: [],
  ips: [],
  devMode: false,
  qrSchema: 'a',
  urlV3: '',
  urlV4: '',
  qrV3: null,
  qrV4: null,
  deviceName: null,
  slotIds: [],
  softLimit: null,
  deviceStrength: null,
  bound: false,
  connected: false,
  logs: [],
  out: null,
  lastError: null,
}

/* ------------------------------ 设置持久化 ------------------------------ */

export function loadDGLabSettings(): DGLabSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_DGLAB_SETTINGS }
    return { ...DEFAULT_DGLAB_SETTINGS, ...JSON.parse(raw), caps: { ...DEFAULT_DGLAB_SETTINGS.caps, ...JSON.parse(raw).caps } }
  } catch {
    return { ...DEFAULT_DGLAB_SETTINGS }
  }
}

export function saveDGLabSettings(patch: Partial<DGLabSettings>): DGLabSettings {
  const current = loadDGLabSettings()
  const next = { ...current, ...patch, caps: { ...current.caps, ...(patch.caps ?? {}) } }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
  window.dispatchEvent(new CustomEvent(DGLAB_SETTINGS_EVENT))
  return next
}

/* ------------------------------ 全局音频分析 store ------------------------------ */

let globalAnalyzerStore: AudioAnalyzerStore | null = null
/** 播放状态：暂停/停止时停止推送真实频谱（防 analyser 冻结帧导致暂停后仍输出）。 */
let playbackActive = true

/** 全局左右声道分析器（实时波形/示波器用）。 */
let globalLeftAnalyser: AnalyserNode | null = null
let globalRightAnalyser: AnalyserNode | null = null
/** 主图 L/R 分析器快照：整机监听切换分析源后，用于恢复主图连线。 */
let mainLeftAnalyser: AnalyserNode | null = null
let mainRightAnalyser: AnalyserNode | null = null

export function setGlobalAudioAnalysers(left: AnalyserNode | null, right: AnalyserNode | null) {
  globalLeftAnalyser = left
  globalRightAnalyser = right
  mainLeftAnalyser = left
  mainRightAnalyser = right
}

export function getGlobalAudioAnalysers(): { left: AnalyserNode | null; right: AnalyserNode | null } {
  return { left: globalLeftAnalyser, right: globalRightAnalyser }
}

/** 由 App 同步播放状态（isPlaying）：暂停立即归零、续播按恢复档缓慢升起。 */
export function setGlobalPlaybackActive(active: boolean) {
  playbackActive = active
  if (client) client.setPausedLocal(!active)
}

/** 推送的音频特征（含左右声道与 flux）。 */
export interface DGLabAudioFrame {
  kick: number
  bass: number
  mid: number
  lead: number
  hats: number
  high: number
  overall: number
  beat: number
  accent: number
  flux: number
  left: { bass: number; mid: number; high: number; overall: number }
  right: { bass: number; mid: number; high: number; overall: number }
}

/** 暂停时推送的零帧（让中继立即归零）。 */
const ZERO_AUDIO: DGLabAudioFrame = {
  kick: 0, bass: 0, mid: 0, lead: 0, hats: 0, high: 0, overall: 0, beat: 0, accent: 0, flux: 0,
  left: { bass: 0, mid: 0, high: 0, overall: 0 },
  right: { bass: 0, mid: 0, high: 0, overall: 0 },
}

/* ------------------------------ 外部音源（看歌/MV 直出 audio） ------------------------------ */

let externalAnalyser: AnalyserNode | null = null
let externalCtx: AudioContext | null = null
let externalBlendAt = 0
let externalBuf: Uint8Array | null = null

function measureBandsFromAnalyser(node: AnalyserNode, buf: Uint8Array): { bass: number; mid: number; high: number; overall: number } {
  node.getByteFrequencyData(buf)
  const nyquist = node.context.sampleRate / 2
  const band = (f0: number, f1: number) => {
    const start = Math.max(1, Math.floor(f0 / nyquist * buf.length))
    const end = Math.min(buf.length, Math.max(start + 1, Math.ceil(f1 / nyquist * buf.length)))
    let sum = 0
    let squares = 0
    let peak = 0
    for (let i = start; i < end; i += 1) {
      const v = buf[i] / 255
      sum += v
      squares += v * v
      if (v > peak) peak = v
    }
    const count = Math.max(1, end - start)
    return (sum / count) * 0.42 + Math.sqrt(squares / count) * 0.43 + peak * 0.15
  }
  const bass = band(45, 190)
  const mid = band(190, 2600)
  const high = band(2600, 12000)
  return { bass, mid, high, overall: bass * 0.38 + mid * 0.42 + high * 0.2 }
}

/** 读取外部音源（MV audio 元素）特征；未接入返回 null。 */
function readExternalData(): { overall: number; bass: number; mid: number; high: number; left: { bass: number; mid: number; high: number; overall: number }; right: { bass: number; mid: number; high: number; overall: number } } | null {
  if (!externalAnalyser) return null
  if (!externalBuf) externalBuf = new Uint8Array(externalAnalyser.frequencyBinCount)
  const b = measureBandsFromAnalyser(externalAnalyser, externalBuf)
  return { overall: b.overall, bass: b.bass, mid: b.mid, high: b.high, left: b, right: b }
}

/** 切换外部音源（MV 看歌：audio 元素直出，不经效果链但可靠发声）；null = 回到主图。 */
function setExternalMediaSourceInternal(el: HTMLMediaElement | null) {
  externalBlendAt = performance.now()
  if (!el) {
    externalAnalyser = null
    if (externalCtx) {
      void externalCtx.close().catch(() => undefined)
      externalCtx = null
    }
    return
  }
  try {
    if (!externalCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      externalCtx = new Ctor()
    }
    void externalCtx.resume().catch(() => undefined)
    const routed = (el as HTMLMediaElement & { __dgSource?: unknown }).__dgSource
    if (routed) return
    const src = externalCtx.createMediaElementSource(el)
    const gain = externalCtx.createGain()
    gain.gain.value = 1
    const ana = externalCtx.createAnalyser()
    ana.fftSize = 1024
    ana.smoothingTimeConstant = 0.72
    src.connect(gain).connect(ana).connect(externalCtx.destination)
    ;(el as HTMLMediaElement & { __dgSource?: unknown }).__dgSource = src
    externalAnalyser = ana
  } catch (error) {
    console.warn('[DG-LAB] MV 音频接入失败，回退主图分析:', error)
    externalAnalyser = null
  }
}

/** 4 频段边界（Hz）：Kick/Bass/Lead/Hats，复用对数频谱边界计算。 */
const BAND_EDGES = [20, 90, 220, 3000, 12000]

/**
 * 把 24 段对数频谱聚合为 4 音乐频段能量。
 * （对数频段边界：20Hz~12kHz，与 useAudioAnalyzer 的 spectrum 对齐。）
 */
function computeBands(spectrum: Float32Array | undefined) {
  const bands = [0, 0, 0, 0]
  if (!spectrum || spectrum.length === 0) return bands
  const count = spectrum.length
  for (let b = 0; b < 4; b += 1) {
    const f0 = BAND_EDGES[b]
    const f1 = BAND_EDGES[b + 1]
    const start = Math.floor((count * Math.log(f0 / 20)) / Math.log(12000 / 20))
    const end = Math.max(start + 1, Math.ceil((count * Math.log(f1 / 20)) / Math.log(12000 / 20)))
    let sum = 0
    for (let i = Math.min(start, count - 1); i < Math.min(end, count); i += 1) sum += spectrum[i] || 0
    bands[b] = sum / Math.max(1, Math.min(end, count) - Math.min(start, count - 1))
  }
  return bands
}

export function setGlobalAudioAnalyzerStore(store: AudioAnalyzerStore | null) {
  globalAnalyzerStore = store
  // 插件可能在 App 注册音频 store 之前就已激活（React effect 子先于父），
  // 这里补一次订阅，确保启动时启用插件也能拿到音频流
  if (client) client.ensureStream()
}

export function getGlobalAudioAnalyzerStore(): AudioAnalyzerStore | null {
  return globalAnalyzerStore
}

/* ------------------------------ 客户端单例 ------------------------------ */

function createClient() {
  let snapshot: DGLabStatus = { ...EMPTY_STATUS }
  const listeners = new Set<() => void>()
  let ws: WebSocket | null = null
  let active = false
  let fetchSeq = 0
  let unsubStore: (() => void) | null = null
  let reconnectTimer: number | null = null
  let lastPushWarnAt = 0
  /** 瞬时波形帧（自定义波形解析为设备帧后随设置下发，不持久化）。 */
  let transientWaveFrames: { freq: number; strength: number }[] | null = null

  const set = (patch: Partial<DGLabStatus>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(l => l())
  }

  const fetchStatus = async () => {
    const seq = ++fetchSeq
    try {
      const res = await fetch(`${DGLAB_API}/status`, { signal: AbortSignal.timeout(2500) })
      const json = await res.json()
      if (seq !== fetchSeq) return json
      set({
        available: true,
        running: Boolean(json.running),
        state: json.running ? (json.bound ? 'bound' : 'waiting') : 'idle',
        version: json.version ?? snapshot.version,
        port: json.port ?? snapshot.port,
        devMode: Boolean(json.devMode),
        qrSchema: json.qrSchema === 'b' ? 'b' : 'a',
        lanIps: Array.isArray(json.lanIps) ? json.lanIps : [],
        ips: Array.isArray(json.ips) ? json.ips : [],
        urlV3: json.urlV3 ?? '',
        urlV4: json.urlV4 ?? '',
        qrV3: json.qrV3 ?? null,
        qrV4: json.qrV4 ?? null,
        deviceName: json.deviceName ?? null,
        slotIds: Array.isArray(json.slotIds) ? json.slotIds : [],
        softLimit: json.softLimit ?? null,
        deviceStrength: json.deviceStrength ?? null,
        bound: Boolean(json.bound),
        lastError: null,
      })
      // 自动硬上限钳位（连接后即检查，App 改限再反馈持续生效）
      maybeAutoAdjustCaps(json.softLimit ?? null)
      return json
    } catch {
      if (seq !== fetchSeq) return null
      set({ available: false, state: 'unavailable', lastError: '未检测到本地服务（请使用桌面版）' })
      return null
    }
  }

  const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    const settings = loadDGLabSettings()
    const url = `ws://127.0.0.1:${settings.port}/dglab/ctrl`
    try {
      const socket = new WebSocket(url)
      ws = socket
      socket.onopen = () => {
        set({ connected: true })
        sendSettings()
        socket.send(JSON.stringify({ t: 'start' }))
      }
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg.t === 'status') {
            set({
              running: Boolean(msg.running),
              state: msg.state ?? snapshot.state,
              version: msg.version ?? snapshot.version,
              port: msg.port ?? snapshot.port,
              devMode: Boolean(msg.devMode),
              qrSchema: msg.qrSchema === 'b' ? 'b' : 'a',
              lanIps: Array.isArray(msg.lanIps) ? msg.lanIps : [],
              ips: Array.isArray(msg.ips) ? msg.ips : [],
              urlV3: msg.urlV3 ?? snapshot.urlV3,
              urlV4: msg.urlV4 ?? snapshot.urlV4,
              qrV3: msg.qrV3 ?? snapshot.qrV3,
              qrV4: msg.qrV4 ?? snapshot.qrV4,
              deviceName: msg.deviceName ?? snapshot.deviceName,
              slotIds: Array.isArray(msg.slotIds) ? msg.slotIds : snapshot.slotIds,
              softLimit: msg.softLimit ?? snapshot.softLimit,
              deviceStrength: msg.deviceStrength ?? snapshot.deviceStrength,
              bound: Boolean(msg.bound),
              lastError: null,
            })
            // 自动硬上限钳位（App 反馈即检查）
            maybeAutoAdjustCaps(msg.softLimit ?? null)
          } else if (msg.t === 'log') {
            const line = String(msg.line ?? '')
            set({ logs: [...snapshot.logs.slice(-120), line] })
          } else if (msg.t === 'output') {
            set({ out: msg.out ?? null })
          } else if (msg.t === 'pong') {
            /* keep-alive ok */
          }
        } catch {
          /* ignore */
        }
      }
      socket.onerror = () => set({ connected: false, lastError: '连接中继失败' })
      socket.onclose = () => {
        if (ws === socket) {
          ws = null
          set({ connected: false, state: 'idle', out: null })
          // 中继重启（改端口/应用重启）会掐断 ctrl 连接：插件仍激活时自动重连
          scheduleReconnect()
        }
      }
    } catch (error) {
      set({ connected: false, lastError: String(error) })
      scheduleReconnect()
    }
  }

  /** 激活状态下自动重连（限频，1.2s 一次）。 */
  const scheduleReconnect = () => {
    if (!active || reconnectTimer !== null) return
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      if (active) connect()
    }, 1200)
  }

  const disconnect = () => {
    active = false
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (unsubStore) {
      unsubStore()
      unsubStore = null
    }
    if (ws) {
      try {
        ws.send(JSON.stringify({ t: 'stop' }))
        ws.close()
      } catch { /* ignore */ }
      ws = null
    }
    set({ connected: false, out: null, state: snapshot.running ? 'idle' : snapshot.state })
  }

  /** 订阅全局音频分析 store：仅在插件激活、输出开启且使用应用内音源时推送 30fps 特征流。 */
  const ensureStream = () => {
    const settings = loadDGLabSettings()
    if (!active || !settings.outputEnabled || settings.systemCapture) {
      if (unsubStore) {
        unsubStore()
        unsubStore = null
      }
      return
    }
    if (!globalAnalyzerStore) {
      console.log('[DG_LAB] 等待音频分析 store 注册（插件已激活）…')
      return
    }
    if (unsubStore) return
    unsubStore = globalAnalyzerStore.subscribe(() => {
      const data = globalAnalyzerStore?.getSnapshot()
      if (!data || !active) return
      // 暂停/停止：推零帧 → 中继立即归零（暂停归零语义）
      if (!playbackActive) {
        pushAudio(ZERO_AUDIO)
        return
      }
      const [kick, bass, lead, hats] = computeBands(data.spectrum)
      const frame: DGLabAudioFrame = {
        kick,
        bass: Math.max(bass, data.bass * 0.75),
        mid: data.mid,
        lead: Math.max(lead, data.mid * 0.7),
        hats: Math.max(hats, data.high * 0.8),
        high: data.high,
        overall: data.overall,
        beat: data.beat,
        accent: data.accent,
        flux: data.flux,
        left: data.left ?? { bass: 0, mid: 0, high: 0, overall: 0 },
        right: data.right ?? { bass: 0, mid: 0, high: 0, overall: 0 },
      }
      // 看歌/外部音源（MV 直出 audio 元素）：切换期间 1s 交叉淡化，避免波形中断/突跳
      const ext = readExternalData()
      if (ext) {
        const blend = Math.min(1, (performance.now() - externalBlendAt) / 1000)
        frame.overall = Math.max(frame.overall * (1 - blend), ext.overall * blend)
        frame.bass = Math.max(frame.bass * (1 - blend), ext.bass * blend)
        frame.mid = Math.max(frame.mid * (1 - blend), ext.mid * blend)
        frame.high = Math.max(frame.high * (1 - blend), ext.high * blend)
        frame.left = {
          bass: Math.max(frame.left.bass * (1 - blend), ext.left.bass * blend),
          mid: Math.max(frame.left.mid * (1 - blend), ext.left.mid * blend),
          high: Math.max(frame.left.high * (1 - blend), ext.left.high * blend),
          overall: Math.max(frame.left.overall * (1 - blend), ext.left.overall * blend),
        }
        frame.right = {
          bass: Math.max(frame.right.bass * (1 - blend), ext.right.bass * blend),
          mid: Math.max(frame.right.mid * (1 - blend), ext.right.mid * blend),
          high: Math.max(frame.right.high * (1 - blend), ext.right.high * blend),
          overall: Math.max(frame.right.overall * (1 - blend), ext.right.overall * blend),
        }
      }
      pushAudio(frame)
    })
    console.log('[DG_LAB] 音频流已订阅（30fps 特征将推给中继）')
  }

  const sendSettings = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const settings = loadDGLabSettings()
    const payload: Record<string, unknown> = {
      version: settings.version,
      port: settings.port,
      address: settings.address,
      qrSchema: settings.qrSchema,
      feelStyle: settings.feelStyle,
      devMode: isDeveloperMode(),
      sensitivity: settings.sensitivity,
      smoothing: settings.smoothing,
      stepPreset: settings.stepPreset,
      stepLimit: settings.stepLimit,
      rampPreset: settings.rampPreset,
      dynamicRange: settings.dynamicRange,
      rtMode: settings.rtMode,
      rtGain: settings.rtGain,
      rtRange: settings.rtRange,
      rtHigh: settings.rtHigh,
      rtLow: settings.rtLow,
      rtHys: settings.rtHys,
      rtBand: settings.rtBand,
      rtFreqMap: settings.rtFreqMap,
      caps: settings.caps,
      driveMode: settings.driveMode,
      systemCapture: Boolean(settings.systemCapture),
      pulseEnabled: settings.pulseEnabled,
      waveId: settings.waveId,
      waveFreq: settings.waveFreq,
      waveStrength: settings.waveStrength,
      waveFrames: transientWaveFrames,
    }
    ws.send(JSON.stringify({ t: 'settings', settings: payload }))
  }

  /** 31fps 特征流推送（由音频 store 订阅驱动）。 */
  const pushAudio = (data: DGLabAudioFrame) => {
    if (!active) return
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // 中继未连时丢弃帧，限频提示一次，避免刷 console
      const now = Date.now()
      if (now - lastPushWarnAt > 5000) {
        lastPushWarnAt = now
        console.warn('[DG_LAB] 控制通道未连接，音频帧被丢弃（等待自动重连）')
      }
      return
    }
    ws.send(JSON.stringify({ t: 'audio', data }))
  }

  /* ------------------------------ 整机监听（系统扬声器 loopback） ------------------------------ */
  // 捕获流由 useSystemAudioCapture 建立 L/R analyse 并接入：这里负责 30fps 采样特征，
  // 并整体切换「分析源」——开启时停主图 store 订阅、全局波形跟随系统；关闭时恢复主图。
  let systemLeft: AnalyserNode | null = null
  let systemRight: AnalyserNode | null = null
  let systemBufL: Uint8Array | null = null
  let systemBufR: Uint8Array | null = null
  let systemTimer: number | null = null
  let prevSysOverall = 0

  const sysCompress = (value: number, amount = 6) => Math.log1p(amount * Math.min(1, Math.max(0, value))) / Math.log1p(amount)

  const stopSystemTimer = () => {
    if (systemTimer !== null) {
      window.clearInterval(systemTimer)
      systemTimer = null
    }
  }

  const startSystemTimer = () => {
    if (systemTimer !== null) return
    systemTimer = window.setInterval(() => {
      if (!systemLeft || !systemRight || !active) return
      if (!systemBufL || systemBufL.length !== systemLeft.frequencyBinCount) systemBufL = new Uint8Array(systemLeft.frequencyBinCount)
      if (!systemBufR || systemBufR.length !== systemRight.frequencyBinCount) systemBufR = new Uint8Array(systemRight.frequencyBinCount)
      const l = measureBandsFromAnalyser(systemLeft, systemBufL)
      const r = measureBandsFromAnalyser(systemRight, systemBufR)
      const overall = Math.max(l.overall, r.overall)
      const flux = Math.max(0, overall - prevSysOverall)
      prevSysOverall = overall
      const ch = (b: { bass: number; mid: number; high: number; overall: number }): DGLabAudioFrame['left'] => ({
        bass: sysCompress(b.bass * 1.14),
        mid: sysCompress(b.mid * 1.08),
        high: sysCompress(b.high * 1.12),
        overall: sysCompress(b.overall * 1.1),
      })
      const frame: DGLabAudioFrame = {
        kick: sysCompress(Math.max(l.bass, r.bass) * 1.14),
        bass: sysCompress(Math.max(l.bass, r.bass) * 1.14),
        mid: sysCompress(Math.max(l.mid, r.mid) * 1.08),
        lead: sysCompress(Math.max(l.mid, r.mid) * 1.08 * 0.7),
        hats: sysCompress(Math.max(l.high, r.high) * 0.8),
        high: sysCompress(Math.max(l.high, r.high) * 1.12),
        overall: sysCompress(overall * 1.1),
        beat: 0,
        accent: 0,
        flux: sysCompress(flux * 12, 4),
        left: ch(l),
        right: ch(r),
      }
      pushAudio(frame)
    }, 1000 / 30)
  }

  /** 整机监听：系统捕获流就绪时切为分析源；传 null 恢复主图（软件内播放）。 */
  const setSystemCaptureAnalysers = (left: AnalyserNode | null, right: AnalyserNode | null) => {
    if (left && right) {
      systemLeft = left
      systemRight = right
      // 停主图特征流（否则两路争推）
      if (unsubStore) {
        unsubStore()
        unsubStore = null
      }
      // 全局左/右分析器切到系统（不覆盖主图快照）
      globalLeftAnalyser = left
      globalRightAnalyser = right
      // 若本软件当前处于暂停（播放归零态），通知中继续播——
      // relay 端 systemCapture 已豁免暂停门控，恢复档淡入由 resume 兜底
      if (ws && ws.readyState === WebSocket.OPEN && active) {
        ws.send(JSON.stringify({ t: 'resume' }))
      }
      startSystemTimer()
      console.log('[DG_LAB] 整机监听已接入（分析源：系统扬声器）')
    } else {
      systemLeft = null
      systemRight = null
      stopSystemTimer()
      globalLeftAnalyser = mainLeftAnalyser
      globalRightAnalyser = mainRightAnalyser
      ensureStream()
      console.log('[DG_LAB] 整机监听已关闭（分析源：恢复软件内播放）')
    }
  }

  /** 播放暂停/续播：暂停立即归零、续播按恢复档缓慢升起（App 播放状态同步用）。 */
  const setPausedLocal = (paused: boolean) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !active) return
    ws.send(JSON.stringify({ t: paused ? 'pause' : 'resume' }))
  }

  /** 波形输出启禁（播放页按钮）：仅暂停输出，不断开、不关插件。 */
  const setOutputEnabled = (on: boolean) => {
    saveDGLabSettings({ outputEnabled: on })
    ensureStream()
    if (ws && ws.readyState === WebSocket.OPEN && active) {
      ws.send(JSON.stringify({ t: 'output', on }))
    }
  }

  /** 切换外部音源（MV 看歌 audio 元素）；null = 回到主图。 */
  const setExternalMediaSource = (el: HTMLMediaElement | null) => {
    setExternalMediaSourceInternal(el)
  }

  /** 自动硬上限钳位：收到 App 硬上限且用户 caps 超限 → 自动下调 + toast（幂等）。 */
  let lastCapsToastKey = ''
  const maybeAutoAdjustCaps = (limit: { A: number; B: number } | null | undefined) => {
    if (!limit) return
    const s = loadDGLabSettings()
    const caps = { A: s.caps.A, B: s.caps.B }
    const adjust: string[] = []
    if (caps.A > limit.A) { caps.A = limit.A; adjust.push(`A=${limit.A}`) }
    if (caps.B > limit.B) { caps.B = limit.B; adjust.push(`B=${limit.B}`) }
    if (adjust.length) {
      saveDGLabSettings({ caps })
      sendSettings()
      const key = `A${caps.A}B${caps.B}`
      if (lastCapsToastKey !== key) {
        lastCapsToastKey = key
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: `已检测到 App 硬上限（${adjust.join('、')}），通道上限已自动下调（提高需在 App 内调整）`, type: 'success', duration: 4200 },
        }))
      }
    }
  }

  /** 中继控制：启动/停止/重启监听（可附带设置同步；devMode 为运行时透传字段）。 */
  const control = async (action: 'start' | 'stop' | 'restart', settings?: Partial<DGLabSettings> & { devMode?: boolean }) => {
    try {
      await fetch(`${DGLAB_API}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...(settings ? { settings } : {}) }),
      })
      void fetchStatus()
    } catch {
      set({ lastError: '本地服务不可用' })
    }
  }

  // 开发者模式切换 → 中继 devMode 详细日志即时生效
  window.addEventListener('developerModeChanged', () => {
    if (active) sendSettings()
  })

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    activate: () => {
      active = true
      void (async () => {
        const settings = loadDGLabSettings()
        const status = await fetchStatus()
        // 中继未运行或端口/版本与设置不符 → 以当前设置重启
        const needStart = !status?.running || Number(status.port) !== settings.port || status.version !== settings.version
        if (needStart) {
          await control('restart', { port: settings.port, version: settings.version, address: settings.address, devMode: isDeveloperMode() })
        }
        connect()
      })()
      ensureStream()
    },
    deactivate: () => {
      active = false
      disconnect()
      ensureStream()
    },
    isActive: () => active,
    ensureStream,
    refreshStatus: () => void fetchStatus(),
    setPausedLocal,
    setOutputEnabled,
    setExternalMediaSource,
    setSystemCaptureAnalysers,
    pushAudio,
    updateSettings: () => {
      saveDGLabSettings({})
      sendSettings()
      void fetchStatus()
    },
    setSettings: (patch: Partial<DGLabSettings>) => {
      saveDGLabSettings(patch)
      sendSettings()
      void fetchStatus()
    },
    /** 下发瞬时波形帧（自定义波形），不持久化。 */
    sendWaveFrames: (frames: { freq: number; strength: number }[] | null) => {
      transientWaveFrames = frames
      sendSettings()
    },
    /** 生成二维码 dataURL（Node 侧 qrcode）。 */
    getQR: async (content: string): Promise<string | null> => {
      try {
        const res = await fetch(`${DGLAB_API}/qr`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        })
        const json = await res.json()
        return json?.ok ? json.dataUrl : null
      } catch {
        return null
      }
    },
    control,
  }
}

const client = createClient()

export function useDGLabStatus(): DGLabStatus {
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
}

export function getDGLabClient() {
  return client
}

/** 供 React 外部模块（DGLabPlugin）使用。 */
export { client as dglabClient }
