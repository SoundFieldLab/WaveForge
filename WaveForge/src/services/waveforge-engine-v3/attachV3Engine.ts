/**
 * v3 引擎接线（WaveForge 融合层，依据模块 docs/FUSION_GUIDE.md 步骤 2b/4/5 与 docs/UI_GUIDE.md §4）
 *
 * 职责：
 *  - EngineV3Host 单例管理（worklet 优先 / script 兜底，masterGain 全断重连防双链并联）；
 *  - 参数快照持久化（localStorage 'waveforge:v3-params'，卷积 IR 数组不入库）；
 *  - UI 桥包装：worklet 模式下参数需同时下发主线程引擎与 worklet 处理器（host.setParams），
 *    统计优先取 worklet 周期回传值；script 模式下两者同源；
 *  - 系统音量 → 等响度补偿（loudnessCompensation.volumePercent）；
 *  - 听力测试纯音播放（监听 UI 的 'v3HearingPlay' 事件，用音频图上下文合成正弦）；
 *  - 离线 WAV 导出（解码 PCM → EngineV3.process 分块 → 16-bit PCM WAV 下载）。
 *
 * 与 v1/v2 完全独立：不做参数迁移；切换只保证音频正常切到 v3 处理。
 */

import { EngineV3Host, createDefaultParams } from './src/index'
import { EngineV3 } from './src/engine/EngineV3'
import type { V3EngineParams } from './src/types'
import { createV3UiBridge, deepMerge } from './ui'
import type { V3UiBridge, DeepPartial } from './ui'
// 变速变调：v3 引擎链内 Stretch 为离线语义（不内联实时主链），实时变速变调
// 复用 WaveForge 既有 SoundTouch AudioWorklet 方案（与 v1/v2 同款），串接在
// masterGain 与 v3 处理节点之间（masterGain → SoundTouch → v3 → analyser）。
import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import processorUrl from '@soundtouchjs/audio-worklet/processor?url'

/** 参数持久化键（v3 独立命名空间） */
const PARAMS_KEY = 'waveforge:v3-params'
/** 听力测试纯音时长（UI_GUIDE §4：约 0.6s） */
const HEARING_TONE_SECONDS = 0.6

/** 音频图句柄（与 src/hooks/useAudioPlayer.ts 的 AudioGraphHandle 结构一致；鸭子类型传入 EngineV3Host） */
export interface V3GraphHandle {
  audioContext: AudioContext
  masterGain: GainNode
  analyser: AnalyserNode
}

let host: EngineV3Host | null = null
let wrappedBridge: V3UiBridge | null = null
let bridgedEngine: EngineV3 | null = null
let currentParams: V3EngineParams | null = null
let lastHandle: V3GraphHandle | null = null
let hearingTone: { osc: OscillatorNode; gain: GainNode } | null = null
let onHearingPlay: ((e: Event) => void) | null = null
let persistTimer: number | null = null

/** 快照入库前去除不可序列化数据（卷积 IR 数组 → 仅保留 irName 引用，与 ui/bridge.ts 语义一致） */
function sanitizeForStorage(p: V3EngineParams): V3EngineParams {
  const clone = JSON.parse(JSON.stringify(p)) as V3EngineParams
  if (clone.reverb?.convolution) clone.reverb.convolution.ir = null
  return clone
}

function persistParams(p: V3EngineParams): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    persistTimer = null
    try {
      localStorage.setItem(PARAMS_KEY, JSON.stringify(sanitizeForStorage(p)))
    } catch {
      // 存储不可用时静默（不影响播放）
    }
  }, 400)
}

/** 恢复持久化参数：结构与默认值深合并（容错坏数据/旧版本缺字段），失败回默认 */
function restoreParams(sampleRate: number): V3EngineParams {
  const base = createDefaultParams(sampleRate)
  try {
    const raw = localStorage.getItem(PARAMS_KEY)
    if (!raw) return base
    const saved = JSON.parse(raw) as DeepPartial<V3EngineParams>
    if (!saved || typeof saved !== 'object') return base
    // 深合并（saved 覆盖 base），保证新增字段有默认值；采样率以当前上下文为准
    const merged = deepMerge(base, saved)
    merged.sampleRate = sampleRate
    return merged
  } catch {
    return base
  }
}

/** 听力测试纯音：用主音频上下文合成正弦（电平按 dBFS 换算），下一次触发前先停上一颗 */
function startHearingTone(ctx: AudioContext, freqHz: number, levelDb: number): void {
  stopHearingTone()
  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = freqHz
    osc.type = 'sine'
    const amp = Math.pow(10, levelDb / 20)
    gain.gain.value = Math.max(0, Math.min(1, amp))
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + HEARING_TONE_SECONDS)
    hearingTone = { osc, gain }
    osc.onended = () => {
      try { gain.disconnect() } catch { /* noop */ }
      if (hearingTone?.osc === osc) hearingTone = null
    }
  } catch {
    // 上下文不可用时静默（UI 流程仍可走完，只是不发声）
  }
}

function stopHearingTone(): void {
  if (!hearingTone) return
  try {
    hearingTone.osc.stop()
    hearingTone.gain.disconnect()
  } catch {
    /* noop */
  }
  hearingTone = null
}

// ==================== 变速变调（SoundTouch 前置链，与 v1/v2 同款） ====================

let soundtouchNode: SoundTouchNode | null = null
let soundtouchWired = false
let soundtouchRegister: Promise<boolean> | null = null
let soundtouchCtx: AudioContext | null = null
let pitchSeq = 0

/** 变速变调是否处于激活状态（开关开启且 semitones/rate 非默认） */
function pitchActive(p: V3EngineParams | null): boolean {
  if (!p || !p.pitch?.enabled) return false
  return Math.abs(p.pitch.semitones) > 1e-9 || Math.abs(p.pitch.rate - 1) > 1e-9
}

/** 把 pitch 参数写到 SoundTouch 节点（AudioParam 平滑过渡，与 v2 applyPitchSettings 一致） */
function applySoundTouchParams(node: SoundTouchNode, ctx: AudioContext, pitch: V3EngineParams['pitch']): void {
  try {
    const t = ctx.currentTime
    node.pitchSemitones.setTargetAtTime(pitch.semitones, t, 0.02)
    node.playbackRate.setTargetAtTime(pitch.rate, t, 0.02)
  } catch {
    /* noop */
  }
}

/** 撤除 SoundTouch 前置链，恢复 masterGain → v3 处理节点直连 */
function unwireSoundTouch(): void {
  if (soundtouchNode) {
    try { soundtouchNode.disconnect() } catch { /* noop */ }
    soundtouchNode = null
  }
  if (soundtouchWired && host && lastHandle) {
    const v3Node = host.getAudioNode()
    try {
      lastHandle.masterGain.disconnect()
      if (v3Node) lastHandle.masterGain.connect(v3Node as unknown as AudioNode)
    } catch { /* noop */ }
  }
  soundtouchWired = false
}

/**
 * 按当前参数同步 SoundTouch 前置链（masterGain → SoundTouch → v3 节点 → analyser）。
 * 激活时按需接线（注册异步、竞态防护）；关闭时撤除恢复直连；未激活不占链（零额外延迟）。
 */
async function syncPitchChain(): Promise<void> {
  if (!host || !lastHandle) return
  const seq = ++pitchSeq
  const active = pitchActive(currentParams)

  if (!active) {
    if (soundtouchWired) unwireSoundTouch()
    return
  }

  const ctx = lastHandle.audioContext
  // 上下文变化（重建音频图）：旧注册/接线作废
  if (soundtouchCtx !== ctx) {
    if (soundtouchNode) { try { soundtouchNode.disconnect() } catch { /* noop */ } soundtouchNode = null }
    soundtouchWired = false
    soundtouchRegister = null
    soundtouchCtx = ctx
  }

  const v3Node = host.getAudioNode()
  if (!v3Node) return // 引擎未接入音频图（冷启动仅存参数，下次 attach 生效）

  if (soundtouchWired && soundtouchNode) {
    applySoundTouchParams(soundtouchNode, ctx, currentParams!.pitch)
    return
  }

  // 注册处理器（每上下文一次，失败静默——变速变调不可用不影响其余效果）
  if (!soundtouchRegister) {
    soundtouchRegister = SoundTouchNode.register(ctx, processorUrl)
      .then(() => true)
      .catch(() => false)
  }
  const ok = await soundtouchRegister
  // 竞态防护：await 期间可能被切走/重接线，过期请求放弃
  if (!ok || seq !== pitchSeq || !host || !lastHandle || host.getMode() === null) return
  const nodeNow = host.getAudioNode()
  if (!nodeNow) return
  try {
    const node = new SoundTouchNode({ context: ctx, outputChannelCount: 2 })
    applySoundTouchParams(node, ctx, currentParams!.pitch)
    lastHandle.masterGain.disconnect()
    lastHandle.masterGain.connect(node)
    node.connect(nodeNow as unknown as AudioNode)
    soundtouchNode = node
    soundtouchWired = true
  } catch {
    // 接线失败：保持 masterGain → v3 直连（音频不中断）
    soundtouchNode = null
    soundtouchWired = false
  }
}

/**
 * 把 v3 引擎接入音频图（幂等：同一 handle 重复调用直接复用）。
 * 语义与 v1/v2 attach 一致：masterGain 全断 → v3 处理节点 → analyser。
 */
export async function attachV3Engine(handle: V3GraphHandle): Promise<void> {
  if (!host) host = new EngineV3Host({ mode: 'auto', workletUrl: './v3-worklet.js' })
  lastHandle = handle
  const fs = handle.audioContext.sampleRate

  // 参数：首次接入恢复持久化快照，重复接入沿用当前值（切走再切回不丢调音）
  if (!currentParams) currentParams = restoreParams(fs)
  await host.attach(handle as never, currentParams)

  // UI 桥按引擎实例缓存；attach 可能因采样率变化重建引擎，故在 attach 后构建
  ensureBridge(fs)

  // 变速变调：host.attach 重建了 v3 处理节点，旧 SoundTouch 接线指向失联节点，
  // 先丢弃再按当前参数重新同步（pitch 激活时接入，否则保持直连）
  if (soundtouchNode) { try { soundtouchNode.disconnect() } catch { /* noop */ } soundtouchNode = null }
  soundtouchWired = false
  void syncPitchChain()

  // 听力测试纯音接线（重复监听前先摘旧）
  if (!onHearingPlay) {
    onHearingPlay = (e: Event) => {
      const detail = (e as CustomEvent<{ freqHz: number; levelDb: number }>).detail
      if (!detail || typeof detail.freqHz !== 'number') return
      if (lastHandle) startHearingTone(lastHandle.audioContext, detail.freqHz, detail.levelDb ?? -20)
    }
    window.addEventListener('v3HearingPlay', onHearingPlay)
  }
}

/** 构建或复用 UI 桥（包装 worklet 模式下参数/统计的同步下发与回传） */
function ensureBridge(fs: number): V3UiBridge {
  if (!host) host = new EngineV3Host({ mode: 'auto', workletUrl: './v3-worklet.js' })
  if (wrappedBridge === null || bridgedEngine !== host.engine) {
    const raw = createV3UiBridge(host.engine, fs)
    wrappedBridge = {
      ...raw,
      setParams: (p: V3EngineParams) => {
        raw.setParams(p)          // 桥内部快照 + 主线程引擎
        host!.setParams(p)        // worklet 处理器同步下发（script 模式下与上一行同源）
        currentParams = p
        persistParams(p)
        void syncPitchChain()     // 变速变调参数变化 → SoundTouch 前置链同步
      },
      getStats: () => host!.getLastStats() ?? raw.getStats(), // worklet 回传值优先
      getAnalysis: () => host!.getLastAnalysis() ?? raw.getAnalysis(), // worklet 回传频谱优先（script 模式主线程引擎自分析）
    }
    bridgedEngine = host.engine
    if (!currentParams) currentParams = restoreParams(fs)
    // createV3UiBridge 构造时会重置为默认参数，这里立即同步为当前快照
    wrappedBridge.setParams(currentParams)
  }
  return wrappedBridge
}

/** 切走/关闭：恢复 masterGain→analyser 直连（与 v2 dispose 同款语义） */
export function detachV3Engine(): void {
  stopHearingTone()
  if (onHearingPlay) {
    window.removeEventListener('v3HearingPlay', onHearingPlay)
    onHearingPlay = null
  }
  // 变速变调前置链先摘除（masterGain 的断开重连交给 host.dispose）
  pitchSeq++
  if (soundtouchNode) { try { soundtouchNode.disconnect() } catch { /* noop */ } soundtouchNode = null }
  soundtouchWired = false
  soundtouchRegister = null
  soundtouchCtx = null
  host?.dispose()
}

/**
 * 当前 UI 桥（调音室渲染用）。
 * 音频图未接入时以默认引擎实例兜底创建（fs 按宿主惯例取 48000）；
 * 真实接入后若采样率不同，host 会重建引擎实例，桥随之重建并回放当前参数快照。
 */
export function getV3Bridge(): V3UiBridge {
  return ensureBridge(48000)
}

/** 是否已接入音频图 */
export function isV3Attached(): boolean {
  return host !== null && host.getMode() !== null
}

/**
 * 系统音量 → 等响度补偿（0-100）：LoudnessComp auto 模式按音量提升低/高频。
 * 无音量源时引擎默认 80；此函数仅更新 volumePercent 字段，是否生效由 mode 决定。
 */
export function setV3SystemVolume(volumePercent: number): void {
  if (!wrappedBridge || !currentParams) return
  const v = Math.max(0, Math.min(100, Math.round(volumePercent)))
  if (currentParams.loudnessCompensation?.volumePercent === v) return
  const next = JSON.parse(JSON.stringify(currentParams)) as V3EngineParams
  next.loudnessCompensation.volumePercent = v
  wrappedBridge.setParams(next)
}

/** 16-bit PCM WAV 编码（与 v2 引擎导出同规格） */
function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const numChannels = channels.length
  const frames = channels[0].length
  const bytesPerSample = 2
  const dataBytes = frames * numChannels * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)            // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true)
  view.setUint16(32, numChannels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = 44
  for (let i = 0; i < frames; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

/**
 * 离线导出：解码源音频 → 独立 EngineV3 分块处理（与实时链同一内核，逐样本一致）
 * → 16-bit WAV 下载。尾部以 1s 静音冲刷卷积混响/限幅器 lookahead 余量。
 */
export async function exportV3Wav(sourceUrl: string, durationSeconds: number): Promise<void> {
  const ctx = lastHandle?.audioContext
  if (!ctx) throw new Error('音频引擎尚未就绪')
  if (!currentParams) currentParams = restoreParams(ctx.sampleRate)

  const response = await fetch(sourceUrl)
  if (!response.ok) throw new Error(`拉取音频失败：${response.status}`)
  const arrayBuffer = await response.arrayBuffer()
  const decoded = await ctx.decodeAudioData(arrayBuffer)

  const fs = ctx.sampleRate
  const minLen = Math.min(fs, decoded.length)
  const totalFrames = Math.max(minLen, Math.min(Math.floor(durationSeconds * fs), decoded.length))

  const engine = new EngineV3(fs, 2)
  engine.setParams(currentParams)

  const srcL = decoded.getChannelData(0)
  const srcR = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : srcL

  // 输出总量在变速（pitch.rate ≠ 1）时会偏离输入量：按块收集，长度动态增长
  const outChunksL: Float32Array[] = []
  const outChunksR: Float32Array[] = []
  const BLOCK = 4096
  const inL = new Float32Array(BLOCK)
  const inR = new Float32Array(BLOCK)
  const outL = new Float32Array(BLOCK)
  const outR = new Float32Array(BLOCK)
  const TAIL_BLOCKS = Math.ceil(fs / BLOCK) // 1s 静音冲刷

  const pushOutputs = () => {
    outChunksL.push(outL.slice())
    outChunksR.push(outR.slice())
  }

  let pos = 0
  while (pos < totalFrames) {
    const n = Math.min(BLOCK, totalFrames - pos)
    inL.set(srcL.subarray(pos, pos + n))
    inR.set(srcR.subarray(pos, pos + n))
    if (n < BLOCK) {
      inL.fill(0, n)
      inR.fill(0, n)
    }
    engine.process([inL, inR], [outL, outR])
    pushOutputs()
    pos += n
  }
  for (let t = 0; t < TAIL_BLOCKS; t += 1) {
    inL.fill(0)
    inR.fill(0)
    engine.process([inL, inR], [outL, outR])
    pushOutputs()
  }

  const asL = new Float32Array(outChunksL.length * BLOCK)
  const asR = new Float32Array(outChunksR.length * BLOCK)
  for (let i = 0; i < outChunksL.length; i += 1) {
    asL.set(outChunksL[i], i * BLOCK)
    asR.set(outChunksR[i], i * BLOCK)
  }

  // 变速变调（离线与实时同效果）：实时链由 SoundTouch 前置承担，导出走引擎自带
  // Stretch（同一参数语义）对整段输出做一次性处理，保证导出与实时听感一致
  let finalL = asL
  let finalR = asR
  if (pitchActive(currentParams)) {
    const st = engine.getStretch()
    st.setParams({ semitones: currentParams!.pitch.semitones, rate: currentParams!.pitch.rate })
    const res = st.processStereo(asL, asR)
    finalL = res.l
    finalR = res.r
  }

  const wavBlob = encodeWav([finalL, finalR], fs)
  const url = URL.createObjectURL(wavBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = `waveforge-v3-${Date.now()}.wav`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
