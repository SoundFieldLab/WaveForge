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
 *  - 离线 MP3 导出（解码 PCM → EngineV3.process 分块 → Float32→Int16 → lamejs MP3 128kbps 下载）。
 *
 * 与 v1/v2 完全独立：不做参数迁移；切换只保证音频正常切到 v3 处理。
 */

import { EngineV3Host, createDefaultParams } from './src/index'
import { readActiveHrtf } from './ui/hrtfStore'
import { EngineV3 } from './src/engine/EngineV3'
import { Pcm16Quantizer } from './src/dsp/PcmQuantizer'
import { encodePcm16Wav } from './src/dsp/PcmWav'
import { parseReplayGainTags, scanReplayGainUrl, selectReplayGainDb } from './src/dsp/ReplayGain'
import type { ReplayGainTags } from './src/dsp/ReplayGain'
import type { QuantizationMode } from './src/dsp/PcmQuantizer'
import type { SpatialPlaybackInputOptions, SpatialPlaybackSourceInfo } from '../../audio/spatialPlaybackInput'
import type { V3EngineParams } from './src/types'
import { createV3UiBridge, deepMerge } from './ui'
import { loadConvolutionIr } from './ui/irStore'
import type { V3UiBridge, DeepPartial } from './ui'
// 变速变调：v3 引擎链内 Stretch 为离线语义（不内联实时主链），实时变速变调
// 复用 WaveForge 既有 SoundTouch AudioWorklet 方案（与 v1/v2 同款），串接在
// masterGain 与 v3 处理节点之间（masterGain → SoundTouch → v3 → analyser）。
import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import processorUrl from '@soundtouchjs/audio-worklet/processor?url'

/**
 * lamejs 1.2.1 打包器兼容补丁 —— 此前「导出 MP3」必炸的根因。
 * 该包假设以 UMD 全家桶（单 <script>）加载：Lame.js/BitStream.js 内部裸引用
 * `MPEGMode`/`Lame` 等标识符当作全局变量，但被 Vite 按模块打包后这些名字不在
 * 各自模块作用域里，构造 Mp3Encoder 时抛 ReferenceError。
 * 处理：首次编码前把包内三个真实类深导入并挂到 globalThis，再取主入口的
 * Mp3Encoder。惰性执行一次，避免拖慢启动。
 */
type LameMp3EncoderCtor = new (
  channels: 1 | 2,
  sampleRate: number,
  kbps: number,
) => {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array
  flush(): Int8Array
}

let lameEncoderCtor: LameMp3EncoderCtor | null = null

/** 惰性初始化并返回打包器兼容补丁后的 Mp3Encoder 构造器（导出仅供单测冒烟） */
export async function ensureLameEncoder(): Promise<LameMp3EncoderCtor> {
  if (lameEncoderCtor) return lameEncoderCtor
  const g = globalThis as unknown as Record<string, unknown>
  const [{ default: MPEGMode }, { default: Lame }, { default: BitStream }] = await Promise.all([
    import('lamejs/src/js/MPEGMode.js'),
    import('lamejs/src/js/Lame.js'),
    import('lamejs/src/js/BitStream.js'),
  ])
  if (g.MPEGMode === undefined) g.MPEGMode = MPEGMode
  if (g.Lame === undefined) g.Lame = Lame
  if (g.BitStream === undefined) g.BitStream = BitStream
  const main = (await import('lamejs')) as unknown as {
    Mp3Encoder?: LameMp3EncoderCtor
    default?: { Mp3Encoder?: LameMp3EncoderCtor }
  }
  const ctor = main.Mp3Encoder ?? main.default?.Mp3Encoder
  if (!ctor) throw new Error('lamejs 加载异常：未找到 Mp3Encoder')
  lameEncoderCtor = ctor
  return ctor
}

/** 参数持久化键（v3 独立命名空间） */
const PARAMS_KEY = 'waveforge:v3-params'
/** 听力测试纯音时长（UI_GUIDE §4：约 0.6s） */
const HEARING_TONE_SECONDS = 0.6

/** 音频图句柄（与 src/hooks/useAudioPlayer.ts 的 AudioGraphHandle 结构一致；鸭子类型传入 EngineV3Host） */
export interface V3GraphHandle {
  audioContext: AudioContext
  masterGain: GainNode
  analyser: AnalyserNode
  leftAnalyserNode?: AnalyserNode
  rightAnalyserNode?: AnalyserNode
  channelSplitterNode?: ChannelSplitterNode
  configureDiscreteInput?(enabled: boolean, options?: SpatialPlaybackInputOptions): void
}

let host: EngineV3Host | null = null
let wrappedBridge: V3UiBridge | null = null
let bridgedEngine: EngineV3 | null = null
let currentParams: V3EngineParams | null = null
let currentTrackReplayGain: ReplayGainTags | null = null
let replayGainScanSeq = 0
let lastHandle: V3GraphHandle | null = null
let hearingTone: { osc: OscillatorNode; gain: GainNode } | null = null
let onHearingPlay: ((e: Event) => void) | null = null
let persistTimer: number | null = null
let masterSnapshot: V3EngineParams | null = null
let saveState: 'saved' | 'pending' | 'error' = 'saved'
const saveListeners = new Set<() => void>()
const paramListeners = new Set<() => void>()
const notifyParams = () => paramListeners.forEach(listener => listener())
let bridgeSampleRate = 48000
let publicBridge: V3UiBridge | null = null
let fusionAttachSeq = 0
let playbackInputInfo: SpatialPlaybackSourceInfo | null = null
let discreteInputKey = ''
/** 多声道解码前用户自己的自动布局取值；切回立体声时按它回滚，不覆盖用户手选。 */
let multichannelAutoBackup: { multichannelAuto: boolean; multichannelLayout: 'auto' | 'quad' | '51' | '71' | '714' } | null = null

function acceptPlaybackInput(source: SpatialPlaybackSourceInfo | null): void {
  if (!source) {
    // 「已解码 → 未解码」：恢复立体声默认，避免上一条多声道 WAV 的 multichannelAuto/51/71 残留。
    if (playbackInputInfo === null) return
    playbackInputInfo = null
    host?.setSpatialInputChannelCount(2)
    const spatial = currentParams?.spatial
    if (spatial?.instant.multichannelAuto) {
      const backup = multichannelAutoBackup
      getV3Bridge().setParams({ ...currentParams!, spatial: { ...spatial, instant: {
        ...spatial.instant,
        multichannelAuto: backup ? backup.multichannelAuto : false,
        multichannelLayout: backup ? backup.multichannelLayout : 'auto',
      } } })
    }
    multichannelAutoBackup = null
    // 源切换时撤掉上一声道数的前置结构，SoundTouch 只处理L/R，其余平面原样旁通。
    if (soundtouchWired && pitchInputChannels !== 2) unwireSoundTouch()
    void syncPitchChain()
    notifyParams()
    return
  }
  playbackInputInfo = source
  host?.setSpatialInputChannelCount(source.channels)
  if (currentParams?.spatial && source.inputFormat === 'channels') {
    const spatial = currentParams.spatial
    const layout = ['quad', '51', '71', '714'].includes(source.layout) ? source.layout as 'quad' | '51' | '71' | '714' : null
    const multichannelAuto = source.channels > 2
    if (spatial.instant.multichannelAuto !== multichannelAuto || (layout && spatial.instant.multichannelLayout !== layout)) {
      if (multichannelAuto) multichannelAutoBackup = {
        multichannelAuto: spatial.instant.multichannelAuto, multichannelLayout: spatial.instant.multichannelLayout,
      }
      getV3Bridge().setParams({ ...currentParams, spatial: { ...spatial, instant: {
        ...spatial.instant, multichannelAuto, ...(layout ? { multichannelLayout: layout } : {}),
      } } })
    }
  }
  // 源切换时撤掉上一声道数的前置结构，SoundTouch 只处理L/R，其余平面原样旁通。
  if (soundtouchWired && pitchInputChannels !== source.channels) unwireSoundTouch()
  void syncPitchChain()
  notifyParams()
}

function syncDiscreteInput(): void {
  if (!lastHandle?.configureDiscreteInput || !currentParams) return
  const format = currentParams.spatial?.inputFormat
  const inputFormat = format && !['stereo51', 'stereo71'].includes(format) ? format as SpatialPlaybackInputOptions['inputFormat'] : 'channels'
  if (discreteInputKey === inputFormat) return
  discreteInputKey = inputFormat ?? 'channels'
  lastHandle.configureDiscreteInput(true, { inputFormat,
    onSourceDecoded: acceptPlaybackInput,
    // 非 WAV 源无法验证声道顺序：提示一次并继续普通立体声播放，绝不中断。
    onSourceWarning: message => window.dispatchEvent(new CustomEvent('showToast', {
      detail: { message, type: 'info' },
    })),
    onSourceError: error => window.dispatchEvent(new CustomEvent('showToast', {
      detail: { message: `空间音源无法载入：${error.message}`, type: 'error' },
    })),
  })
}

function setSaveState(state: typeof saveState): void {
  if (saveState === state) return
  saveState = state
  saveListeners.forEach((listener) => listener())
}

/** 快照入库前去除不可序列化数据（卷积 IR 数组 → 仅保留 irName 引用，与 ui/bridge.ts 语义一致） */
function sanitizeForStorage(p: V3EngineParams): V3EngineParams {
  // 先手动剥 IR 再 stringify：Float32Array 直接进 JSON.stringify 会被逐索引
  // 枚举成 MB 级巨串（导入 IR 后每次持久化 tick 都是全量序列化）。
  const clone = JSON.parse(JSON.stringify({
    ...p,
    reverb: p.reverb
      ? { ...p.reverb, convolution: { ...p.reverb.convolution, ir: null } }
      : p.reverb,
  })) as V3EngineParams
  // 曲目标签随曲目切换，重启后不能沿用上一首歌的增益。
  clone.loudnessNormalization.replayGainDb = null
  return clone
}

function saveParamsNow(): boolean {
  if (persistTimer !== null) window.clearTimeout(persistTimer)
  persistTimer = null
  if (!currentParams) return false
  try {
    // 同一条记录原子保存旁路参数与恢复快照，旧版仍能读取顶层引擎参数。
    localStorage.setItem(PARAMS_KEY, JSON.stringify({
      ...sanitizeForStorage(currentParams),
      __masterSnapshot: masterSnapshot ? sanitizeForStorage(masterSnapshot) : null,
    }))
    setSaveState('saved')
    return true
  } catch {
    setSaveState('error')
    return false
  }
}

function persistParams(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer)
  setSaveState('pending')
  persistTimer = window.setTimeout(saveParamsNow, 400)
}

/** 恢复持久化参数：结构与默认值深合并（容错坏数据/旧版本缺字段），失败回默认 */
function restoreParams(sampleRate: number): V3EngineParams {
  const base = createDefaultParams(sampleRate)
  try {
    const raw = localStorage.getItem(PARAMS_KEY)
    if (!raw) return base
    const saved = JSON.parse(raw) as DeepPartial<V3EngineParams> & { __masterSnapshot?: DeepPartial<V3EngineParams> | null }
    if (!saved || typeof saved !== 'object') return base
    const { __masterSnapshot, ...storedParams } = saved
    masterSnapshot = __masterSnapshot && typeof __masterSnapshot === 'object'
      ? { ...deepMerge(base, __masterSnapshot), sampleRate } : null
    // 深合并（saved 覆盖 base），保证新增字段有默认值；采样率以当前上下文为准
    const merged = deepMerge(base, storedParams)
    merged.sampleRate = sampleRate
    merged.loudnessNormalization.replayGainDb = null
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
let pitchDryGain: GainNode | null = null
let pitchWetGain: GainNode | null = null
let pitchFadeTimer: ReturnType<typeof setTimeout> | null = null
let pitchReady = false
let pitchReadyListener: EventListener | null = null
let pitchInputChannels = 2
let pitchRoutingNodes: AudioNode[] = []

function clearPitchRouting(): void {
  pitchRoutingNodes.forEach(node => { try { node.disconnect() } catch { /* 已释放 */ } })
  pitchRoutingNodes = []
}

/** 取消旧自动化并从当前值线性过渡；连续启停不会跳回上一目标。 */
function fadePitchGain(param: AudioParam, value: number, ctx: AudioContext, start = ctx.currentTime): void {
  const now = ctx.currentTime
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(now)
  else { param.cancelScheduledValues(now); param.setValueAtTime(param.value, now) }
  if (start > now) param.setValueAtTime(param.value, start)
  param.linearRampToValueAtTime(value, Math.max(now, start) + 0.02)
}
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
  clearPitchRouting()
  if (pitchFadeTimer !== null) { clearTimeout(pitchFadeTimer); pitchFadeTimer = null }
  try { pitchDryGain?.disconnect(); pitchWetGain?.disconnect() } catch { /* noop */ }
  pitchDryGain = pitchWetGain = null
  if (soundtouchNode) {
    if (pitchReadyListener) soundtouchNode.removeEventListener('metrics', pitchReadyListener)
    pitchReadyListener = null; pitchReady = false
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
    if (soundtouchWired && pitchDryGain && pitchWetGain) {
      const ctx = lastHandle.audioContext
      fadePitchGain(pitchDryGain.gain, 1, ctx)
      fadePitchGain(pitchWetGain.gain, 0, ctx)
      if (pitchFadeTimer !== null) clearTimeout(pitchFadeTimer)
      pitchFadeTimer = setTimeout(() => {
        pitchFadeTimer = null
        if (seq === pitchSeq && !pitchActive(currentParams)) unwireSoundTouch()
      }, 40)
    }
    return
  }

  const ctx = lastHandle.audioContext
  // 上下文变化（重建音频图）：旧注册/接线作废
  if (soundtouchCtx !== ctx) {
    if (soundtouchNode) {
    if (pitchReadyListener) soundtouchNode.removeEventListener('metrics', pitchReadyListener)
    try { soundtouchNode.disconnect() } catch { /* noop */ } soundtouchNode = null
  }
  pitchReadyListener = null; pitchReady = false
    soundtouchWired = false
    soundtouchRegister = null
    soundtouchCtx = ctx
  }

  const v3Node = host.getAudioNode()
  if (!v3Node) return // 引擎未接入音频图（冷启动仅存参数，下次 attach 生效）

  if (soundtouchWired && soundtouchNode) {
    const reversing = pitchFadeTimer !== null
    if (pitchFadeTimer !== null) { clearTimeout(pitchFadeTimer); pitchFadeTimer = null }
    if (reversing && pitchReady && pitchDryGain && pitchWetGain) {
      fadePitchGain(pitchDryGain.gain, 0, ctx); fadePitchGain(pitchWetGain.gain, 1, ctx)
    }
    applySoundTouchParams(soundtouchNode, ctx, currentParams!.pitch)
    return
  }

  // 注册处理器（每上下文一次，失败静默——变速变调不可用不影响其余效果）
  if (!soundtouchRegister) {
    soundtouchRegister = SoundTouchNode.register(ctx, processorUrl)
      .then(() => true)
      .catch(() => false)
  }
  const registration = soundtouchRegister
  const ok = await registration
  if (!ok) {
    // 不把一次性加载失败永久缓存为“此上下文永不可用”；后续参数更新或重接线可重试。
    // 身份比较可避免旧上下文的失败结果清除新上下文已开始的注册。
    if (soundtouchRegister === registration) soundtouchRegister = null
    return
  }
  // 竞态防护：await 期间可能被切走/重接线，过期请求放弃
  if (seq !== pitchSeq || !host || !lastHandle || host.getMode() === null) return
  const nodeNow = host.getAudioNode()
  if (!nodeNow) return
  try {
    const node = new SoundTouchNode({ context: ctx, outputChannelCount: 2 })
    soundtouchNode = node
    applySoundTouchParams(node, ctx, currentParams!.pitch)
    const dry = ctx.createGain(), wet = ctx.createGain()
    pitchDryGain = dry; pitchWetGain = wet
    dry.gain.value = 1; wet.gain.value = 0
    lastHandle.masterGain.disconnect()
    lastHandle.masterGain.connect(dry)
    dry.channelCountMode = wet.channelCountMode = 'max'
    dry.channelInterpretation = wet.channelInterpretation = 'discrete'
    dry.connect(nodeNow as unknown as AudioNode)
    pitchInputChannels = playbackInputInfo?.channels ?? 2
    if (pitchInputChannels > 2) {
      // SoundTouch 的契约是双声道。只送前L/R，其他离散平面绕行后合并，
      // 与离线导出的近似路径一致；rate != 1 时其余声道不做时间伸缩。
      const split = ctx.createChannelSplitter(pitchInputChannels)
      const front = ctx.createChannelMerger(2)
      const processedFront = ctx.createChannelSplitter(2)
      const merge = ctx.createChannelMerger(pitchInputChannels)
      pitchRoutingNodes = [split, front, processedFront, merge]
      lastHandle.masterGain.connect(split)
      split.connect(front, 0, 0); split.connect(front, 1, 1)
      front.connect(node); node.connect(processedFront)
      processedFront.connect(merge, 0, 0); processedFront.connect(merge, 1, 1)
      for (let channel = 2; channel < pitchInputChannels; channel++) split.connect(merge, channel, channel)
      merge.connect(wet)
    } else {
      lastHandle.masterGain.connect(node)
      node.connect(wet)
    }
    wet.connect(nodeNow as unknown as AudioNode)
    pitchDryGain = dry; pitchWetGain = wet
    // 等处理器 metrics 确认可提取完整量子后才淡入，干路在等待期间保持原声。
    pitchReady = false
    pitchReadyListener = (event: Event) => {
      const metrics = (event as CustomEvent<{ framesBuffered?: number }>).detail
      if (soundtouchNode !== node || !pitchActive(currentParams) || !(Number(metrics?.framesBuffered) >= 128)) return
      pitchReady = true
      fadePitchGain(dry.gain, 0, ctx); fadePitchGain(wet.gain, 1, ctx)
      if (pitchReadyListener) node.removeEventListener('metrics', pitchReadyListener)
      pitchReadyListener = null
    }
    node.addEventListener('metrics', pitchReadyListener)
    soundtouchNode = node
    soundtouchWired = true
  } catch {
    clearPitchRouting()
    // 接线失败：保持 masterGain → v3 直连（音频不中断）
    try { pitchDryGain?.disconnect(); pitchWetGain?.disconnect() } catch { /* noop */ }
    pitchDryGain = pitchWetGain = null
    if (pitchReadyListener) soundtouchNode?.removeEventListener('metrics', pitchReadyListener)
    pitchReadyListener = null; pitchReady = false
    try { soundtouchNode?.disconnect() } catch { /* noop */ }
    soundtouchNode = null
    soundtouchWired = false
    try { lastHandle.masterGain.disconnect(); lastHandle.masterGain.connect(nodeNow as unknown as AudioNode) } catch { /* noop */ }
  }
}

/**
 * 把 v3 引擎接入音频图（幂等：同一 handle 重复调用直接复用）。
 * 语义与 v1/v2 attach 一致：masterGain 全断 → v3 处理节点 → analyser。
 */
export async function attachV3Engine(handle: V3GraphHandle): Promise<void> {
  const attachSeq = ++fusionAttachSeq
  if (!host) host = new EngineV3Host({ mode: 'auto', workletUrl: './v3-worklet.js' })
  lastHandle = handle
  discreteInputKey = ''
  const fs = handle.audioContext.sampleRate

  // 参数：首次接入恢复持久化快照，重复接入沿用当前值（切走再切回不丢调音）
  if (!currentParams) currentParams = restoreParams(fs)
  syncDiscreteInput()
  const savedIrId = currentParams.reverb.convolution.irId
  if (savedIrId && !currentParams.reverb.convolution.ir) {
    try {
      const savedIr = await loadConvolutionIr(savedIrId, fs)
      if (savedIr) currentParams = { ...currentParams, reverb: { ...currentParams.reverb,
        convolution: { ...currentParams.reverb.convolution, ir: savedIr.ir,
          irName: savedIr.metadata.name } } }
    } catch { /* 数据库不可用时保留算法混响回退 */ }
  }
  if (attachSeq !== fusionAttachSeq) return
  try {
    // 主程序的splitter已经接在analyser之后；不再从Host并联重复喂入。
    await host.attach({ ...handle, channelSplitterNode: undefined } as never, currentParams)
  } catch (error) {
    if (attachSeq === fusionAttachSeq) handle.configureDiscreteInput?.(false)
    throw error
  }
  if (attachSeq !== fusionAttachSeq) return
  try {
    const grid = await readActiveHrtf()
    if (attachSeq !== fusionAttachSeq) return
    if (grid) host.setSpatialHrtf(grid)
  } catch { /* 数据损坏或数据库不可用时使用内置 KEMAR。 */ }

  if (pitchFadeTimer !== null) { clearTimeout(pitchFadeTimer); pitchFadeTimer = null }
  clearPitchRouting()
  try { pitchDryGain?.disconnect(); pitchWetGain?.disconnect() } catch { /* noop */ }
  pitchDryGain = pitchWetGain = null
  // UI 桥按引擎实例缓存；attach 可能因采样率变化重建引擎，故在 attach 后构建
  ensureBridge(fs)

  // 变速变调：host.attach 重建了 v3 处理节点，旧 SoundTouch 接线指向失联节点，
  // 先丢弃再按当前参数重新同步（pitch 激活时接入，否则保持直连）
  if (soundtouchNode) {
    if (pitchReadyListener) soundtouchNode.removeEventListener('metrics', pitchReadyListener)
    try { soundtouchNode.disconnect() } catch { /* noop */ } soundtouchNode = null
  }
  pitchReadyListener = null; pitchReady = false
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
    window.addEventListener('v3HearingStop', stopHearingTone)
  }
}

/**
 * 参数快照的稳定身份 key：剥离 IR 后的 JSON + IR 引用 token。
 *
 * IR（Float32Array，数 MB）不能参与 stringify（逐索引枚举会生成 MB 级巨串），
 * 也绝不对样本内容做 hash（每次提交都是数 MB 的计算成本）。这里用 WeakMap 给
 * IR 引用分配稳定自增 token：
 *  - 同一份引用 → 同一 token ⇒ 重复提交仍被短路；
 *  - 同参数换另一份 IR（哪怕样本内容完全相同）→ token 变化 ⇒ 不会被误判为重复。
 * WeakMap 不阻止 IR 被回收。
 */
const irTokens = new WeakMap<Float32Array, number>()
let nextIrToken = 1

function irToken(ir: unknown): string {
  if (ir == null) return 'none'
  if (!(ir instanceof Float32Array)) return `raw:${String(ir)}`
  const known = irTokens.get(ir)
  if (known !== undefined) return `ir#${known}`
  const token = nextIrToken++
  irTokens.set(ir, token)
  return `ir#${token}`
}

/** 值相等短路用的快照 key（IR 只记引用 token，不序列化样本）。 */
function paramsKey(p: V3EngineParams): string {
  const stripped = {
    ...p,
    reverb: p.reverb
      ? { ...p.reverb, convolution: { ...p.reverb.convolution, ir: null } }
      : p.reverb,
  }
  return `${JSON.stringify(stripped)}|ir:${irToken(p.reverb?.convolution?.ir ?? null)}`
}

/** 构建或复用 UI 桥（参数提交经 submit 钩子统一承载宿主下发/持久化/前置链同步） */
function ensureBridge(fs: number): V3UiBridge {
  if (!host) host = new EngineV3Host({ mode: 'auto', workletUrl: './v3-worklet.js' })
  if (wrappedBridge === null || bridgedEngine !== host.engine) {
    bridgeSampleRate = fs
    // 值相等短路（拖拽/滑块高频路径）：每次 patch 的真实代价是整参数 JSON 深拷贝 +
    // 15 级链全量重配 + worklet postMessage + 持久化 + 全页重渲染。快照未变化时
    // （球形拖拽静止帧、React 双调用等）只做一次 key 对比，宿主下发/持久化/前置链同步全跳过。
    let lastParamsKey = ''
    let leftSamples: Float32Array<ArrayBuffer> | null = null
    let rightSamples: Float32Array<ArrayBuffer> | null = null

    /**
     * 统一提交钩子：桥已更新内部快照并调用 engine.setParams 后触发。
     * 承载全部「提交后」副作用——曲目 ReplayGain 注入、值相等短路、
     * 宿主/worklet 下发、当前快照持久化、SoundTouch 前置链同步。
     */
    const submit = (p: V3EngineParams): void => {
      // 曲目 ReplayGain：按当前 replayGainMode 从上一首歌标签里选曲目/专辑增益。
      // 注入值写回桥快照，UI 读到的 replayGainDb 与宿主实际生效值保持一致。
      const mode = p.loudnessNormalization.replayGainMode ?? 'off'
      const replayGainDb = mode !== 'off' && currentTrackReplayGain
        ? selectReplayGainDb(currentTrackReplayGain, mode) : null
      if (replayGainDb !== p.loudnessNormalization.replayGainDb) {
        p.loudnessNormalization = { ...p.loudnessNormalization, replayGainDb }
      }
      const key = paramsKey(p)
      if (key === lastParamsKey) return
      lastParamsKey = key
      // host 在调用时从模块级变量读取（不是创建桥时的闭包快照）：桥实例被缓存期间
      // 若宿主/引擎重建，本次提交仍下发到当前宿主；ensureBridge 会在 host.engine
      // 变化时重建桥。
      host!.setParams(p)        // worklet 处理器同步下发 + 主线程引擎（script 模式同源）
      currentParams = p
      syncDiscreteInput()
      persistParams()
      void syncPitchChain()     // 变速变调参数变化 → SoundTouch 前置链同步
      notifyParams()
    }

    // 参数路径完全由 submit 钩子承载；这里只补宿主相关的读取/回写能力，
    // 不再覆写 setParams（applyScene / UI patch / 外部 replace 走同一条路径）。
    const raw = createV3UiBridge(host.engine, fs, { submit })
    const rawGetStats = raw.getStats
    const rawGetAnalysis = raw.getAnalysis
    raw.getMasterSnapshot = () => masterSnapshot ? structuredClone(masterSnapshot) : null
    raw.setMasterSnapshot = (p) => {
      masterSnapshot = p ? structuredClone(p) : null
      persistParams()
      notifyParams()
    }
    raw.subscribeParams = listener => {
      paramListeners.add(listener)
      return () => { paramListeners.delete(listener) }
    }
    raw.getSaveState = () => saveState
    raw.subscribeSaveState = (listener) => {
      saveListeners.add(listener)
      return () => { saveListeners.delete(listener) }
    }
    raw.saveNow = saveParamsNow
    raw.getStats = () => host!.getLastStats() ?? rawGetStats() // worklet 回传值优先
    raw.setSpatialHrtf = grid => host!.setSpatialHrtf(grid)
    raw.getSpatialHrtfSource = () => host!.engine.getSpatialHrtfSource()
    raw.setSpatialHeadPose = pose => host!.setSpatialHeadPose(pose)
    raw.getAnalysis = () => host!.getLastAnalysis() ?? rawGetAnalysis() // worklet 回传频谱优先（script 模式主线程引擎自分析）
    raw.getWaveform = () => {
      if (!host?.getMode() || !lastHandle?.leftAnalyserNode) return null
      const leftNode = lastHandle.leftAnalyserNode
      const rightNode = lastHandle.rightAnalyserNode
      if (leftSamples?.length !== leftNode.fftSize) leftSamples = new Float32Array(leftNode.fftSize)
      leftNode.getFloatTimeDomainData(leftSamples)
      if (!rightNode) return { left: leftSamples, right: null }
      if (rightSamples?.length !== rightNode.fftSize) rightSamples = new Float32Array(rightNode.fftSize)
      rightNode.getFloatTimeDomainData(rightSamples)
      return { left: leftSamples, right: rightSamples }
    }
    wrappedBridge = raw
    bridgedEngine = host.engine
    if (!currentParams) currentParams = restoreParams(fs)
    // createV3UiBridge 构造时会以默认参数初始化引擎，这里立即同步为当前快照；
    // 同样经过 submit → 宿主下发 + 持久化 + 前置链同步一次到位。
    wrappedBridge.setParams({ ...currentParams, sampleRate: fs })
  }
  return wrappedBridge
}

/** 切走/关闭：恢复 masterGain→analyser 直连（与 v2 dispose 同款语义） */
export function detachV3Engine(): void {
  fusionAttachSeq++
  stopHearingTone()
  window.removeEventListener('v3HearingStop', stopHearingTone)
  if (onHearingPlay) {
    window.removeEventListener('v3HearingPlay', onHearingPlay)
    onHearingPlay = null
  }
  // 变速变调前置链先摘除（masterGain 的断开重连交给 host.dispose）
  pitchSeq++
  clearPitchRouting()
  if (pitchFadeTimer !== null) { clearTimeout(pitchFadeTimer); pitchFadeTimer = null }
  try { pitchDryGain?.disconnect(); pitchWetGain?.disconnect() } catch { /* noop */ }
  pitchDryGain = pitchWetGain = null
  if (soundtouchNode) {
    if (pitchReadyListener) soundtouchNode.removeEventListener('metrics', pitchReadyListener)
    try { soundtouchNode.disconnect() } catch { /* noop */ } soundtouchNode = null
  }
  pitchReadyListener = null; pitchReady = false
  soundtouchWired = false
  soundtouchRegister = null
  soundtouchCtx = null
  host?.dispose()
  lastHandle?.configureDiscreteInput?.(false)
  lastHandle = null
  discreteInputKey = ''
  playbackInputInfo = null
  multichannelAutoBackup = null
}

/**
 * 当前 UI 桥（调音室渲染用）。
 * 音频图未接入时以默认引擎实例兜底创建（fs 按宿主惯例取 48000）；
 * 真实接入后若采样率不同，host 会重建引擎实例，桥随之重建并回放当前参数快照。
 */
export function getV3Bridge(): V3UiBridge {
  ensureBridge(lastHandle?.audioContext.sampleRate ?? bridgeSampleRate)
  // 调音室可能先于音频图打开。稳定入口始终转发到当前采样率的桥，
  // 已打开页面和头追回调不会继续持有旧引擎。
  publicBridge ??= new Proxy({} as V3UiBridge, {
    get: (_target, key) => {
      const value = Reflect.get(wrappedBridge!, key)
      return typeof value === 'function'
        ? (...args: unknown[]) => Reflect.apply(Reflect.get(wrappedBridge!, key), wrappedBridge, args)
        : value
    },
  })
  return publicBridge
}

/** 是否已接入音频图 */
export function isV3Attached(): boolean {
  return host !== null && host.getMode() !== null
}

/** 播放源已提供标签时调用；null 用于切歌时立即清除上一首的增益。 */
export function setV3TrackReplayGainTags(tags: Record<string, unknown> | null): void {
  replayGainScanSeq++
  currentTrackReplayGain = tags ? parseReplayGainTags(tags) : null
  if (wrappedBridge && currentParams) wrappedBridge.setParams(currentParams)
}

/** 扫描当前播放源的 ID3v2/FLAC 标签，并防止上一首异步结果覆盖新曲目。 */
export async function scanV3TrackReplayGain(sourceUrl: string, signal?: AbortSignal): Promise<ReplayGainTags | null> {
  const seq = ++replayGainScanSeq
  currentTrackReplayGain = null
  if (wrappedBridge && currentParams) wrappedBridge.setParams(currentParams)
  try {
    const tags = await scanReplayGainUrl(sourceUrl, signal)
    if (seq !== replayGainScanSeq) return null
    currentTrackReplayGain = tags
    if (wrappedBridge && currentParams) wrappedBridge.setParams(currentParams)
    return tags
  } catch {
    return null
  }
}

/**
 * 系统音量 → 等响度补偿（0-100）：LoudnessComp auto 模式按音量提升低/高频。
 * 无音量源时引擎默认 80；此函数仅更新 volumePercent 字段，是否生效由 mode 决定。
 */
export function setV3SystemVolume(volumePercent: number): void {
  if (!Number.isFinite(volumePercent)) return
  getV3Bridge()
  if (!currentParams) return
  const v = Math.max(0, Math.min(100, Math.round(volumePercent)))
  if (currentParams.loudnessCompensation?.volumePercent === v) return
  const next: V3EngineParams = {
    ...currentParams,
    loudnessCompensation: { ...currentParams.loudnessCompensation, volumePercent: v },
  }
  if (masterSnapshot) masterSnapshot.loudnessCompensation.volumePercent = v
  getV3Bridge().setParams(next)
}

/**
 * MP3 编码（lamejs 1.2.1，立体声 / 128kbps）。
 * Float32 PCM → Int16 PCM（饱和量化，默认 TPDF 抖动）→ Mp3Encoder 分块编码 → flush 冲刷尾部。
 * lamejs 内部以 1152 样本为帧边界自适应补零，故输入块大小不限（这里取 1152 对齐以减少边界补零）。
 */
async function encodeMp3(channels: Float32Array[], sampleRate: number, quantization: QuantizationMode): Promise<Blob> {
  const Mp3Encoder = await ensureLameEncoder()
  const channelsForEnc = channels.length >= 2 ? 2 : 1
  const encoder = new Mp3Encoder(channelsForEnc, sampleRate, 128)
  const frames = channels[0].length
  // 左/右声道 Int16 scratch（单声道复用左声道）
  const left16 = new Int16Array(frames)
  const right16 = channelsForEnc === 2 ? new Int16Array(frames) : left16
  const quantizeL = new Pcm16Quantizer(quantization, 0x12345678)
  const quantizeR = new Pcm16Quantizer(quantization, 0x87654321)
  for (let i = 0; i < frames; i += 1) {
    left16[i] = quantizeL.process(channels[0][i])
    if (channelsForEnc === 2) {
      right16[i] = quantizeR.process(channels[1][i])
    }
  }
  const BLOCK = 1152
  const chunks: Int8Array[] = []
  // 每 ~64 块（≈1.7s 音频）让出一次主线程：lamejs 的 encodeBuffer 是同步 CPU 密集调用，
  // 整曲连跑会让导出期间 UI 完全冻结；分片 yield 后编码结果不变，仅总耗时长零点几秒。
  let blocksSinceYield = 0
  for (let i = 0; i < frames; i += BLOCK) {
    const n = Math.min(BLOCK, frames - i)
    const lBlk = left16.subarray(i, i + n)
    const rBlk = channelsForEnc === 2 ? right16.subarray(i, i + n) : left16
    const enc = channelsForEnc === 2
      ? encoder.encodeBuffer(lBlk, rBlk)
      : encoder.encodeBuffer(lBlk)
    if (enc.length > 0) chunks.push(enc)
    if (++blocksSinceYield >= 64) {
      blocksSinceYield = 0
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  const tail = encoder.flush()
  if (tail.length > 0) chunks.push(tail)
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' })
}

export interface V3ExportOptions {
  /** 导出文件名基名（默认 WaveForge-HSE）；保存时自动追加 -Modified 后缀 */
  fileName?: string
  /** Float32→Int16 的量化模式；默认 TPDF。 */
  quantization?: QuantizationMode
}

/** 文件名非法字符清洗（Windows 保留字符集） */
function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'WaveForge-HSE'
}

/**
 * 离线导出：解码源音频 → 独立 EngineV3 分块处理（与实时链同一内核，逐样本一致）
 * → Float32→Int16 → lamejs MP3 128kbps。尾部以 1s 静音冲刷卷积混响/限幅器 lookahead 余量。
 * 保存：Electron 下经 IPC 直写桌面（<歌曲名>-Modified.mp3，重名自动 (2) 序号）；
 * 非 Electron（网页/TV）退化为浏览器下载。
 */
async function renderV3Pcm(sourceUrl: string, durationSeconds: number): Promise<{ left: Float32Array; right: Float32Array; sampleRate: number }> {
  const ctx = lastHandle?.audioContext
  if (!ctx) throw new Error('音频引擎尚未就绪')
  if (!currentParams) currentParams = restoreParams(ctx.sampleRate)

  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`拉取音频失败：${response.status}`)
  const arrayBuffer = await response.arrayBuffer()
  const decoded = await ctx.decodeAudioData(arrayBuffer)

  const fs = ctx.sampleRate
  const minLen = Math.min(fs, decoded.length)
  const totalFrames = Math.max(minLen, Math.min(Math.floor(durationSeconds * fs), decoded.length))

  const engine = new EngineV3(fs, 2)
  engine.setParams(currentParams)

  // 与实时链一致地同步当前自定义 SOFA HRTF 数据集（ui/hrtfStore 的 active 项）：
  // 实时 attach 会把该网格下发宿主/Worklet，离线引擎是独立实例，不同步就会退回
  // 内置 KEMAR 网格，导致导出听感与实时试听不同。无自定义数据集时保持内置 KEMAR。
  try {
    const grid = await readActiveHrtf()
    if (grid) engine.setSpatialHrtf(grid)
  } catch { /* 数据库不可用/数据损坏：与实时链一致回退内置 KEMAR */ }

  // 快照导出开始时的参数，处理期间参数变化不影响本次导出。
  // 空间音频已内联进 EngineV3，engine.process 自动包含（无需独立后端包裹）。
  // 离散输入最多 32 声道（与宿主/Worklet 的离散输入容量同一上限），保持原始声道
  // 顺序：7.1.4（12）与一/二/三阶 Ambisonics（4/9/16）都不能被截断到 8 声道。
  const channelCount = Math.max(1, Math.min(32, decoded.numberOfChannels))
  const sourceChannels: Float32Array[] = Array.from({ length: channelCount }, (_, channel) => decoded.getChannelData(channel))
  if (sourceChannels.length === 1) sourceChannels.push(sourceChannels[0]) // mono 补成双声道

  // 输出总量在变速（pitch.rate ≠ 1）时会偏离输入量：按块收集，长度动态增长
  const outChunksL: Float32Array[] = []
  const outChunksR: Float32Array[] = []
  const BLOCK = 4096
  const outL = new Float32Array(BLOCK)
  const outR = new Float32Array(BLOCK)
  const TAIL_BLOCKS = Math.ceil(fs / BLOCK) // 1s 静音冲刷

  const pushOutputs = () => {
    outChunksL.push(outL.slice())
    outChunksR.push(outR.slice())
  }

  // 变速变调前置（与实时链 masterGain → SoundTouch → v3 → analyser 一致）：
  // pitch 活跃时对源先做一次性 pitch（全长，Stretch 输出长度 ≈ 源×rate），
  // 再把 pitched 的结果分块喂 engine；不活跃时直连源（回归原行为）。
  // 注：Stretch 一次性处理整段源（含其自身相位声码器尾部），engine.process
  // 仅作用于 pitched 数据；尾部 1s 静音冲刷仍喂 engine 以排空卷积
  // 混响/限幅器 lookahead 余量（与实时链 SoundTouch 池尽后喂静音语义一致）。
  let feedChannels = sourceChannels
  let feedLen = totalFrames
  if (pitchActive(currentParams)) {
    const st = engine.getStretch()
    st.setParams({ semitones: currentParams!.pitch.semitones, rate: currentParams!.pitch.rate })
    // Stretch 只有整段立体声 API：只让前 L/R 走拉伸，其余离散声道原样保留，
    // 再与拉伸结果一起送入引擎——不再把整段多声道下混成立体声丢掉声道布局。
    // 边界（近似路径）：其余声道不做时间伸缩，rate≠1 时它们与前置立体声存在时基
    // 差异（按拉伸后长度截断/补零对齐）；实时链的 SoundTouch 前置同样只处理双声道，
    // 因此离线导出与实时试听的声道口径一致。
    const frontL = sourceChannels[0].subarray(0, totalFrames)
    const frontR = sourceChannels[1].subarray(0, totalFrames)
    const pitched = st.processStereo(frontL, frontR)
    const pitchedLen = pitched.l.length
    if (sourceChannels.length > 2) {
      const preserved = sourceChannels.slice(2).map((channel) => {
        const aligned = new Float32Array(pitchedLen)
        aligned.set(channel.subarray(0, Math.min(pitchedLen, totalFrames)))
        return aligned
      })
      feedChannels = [pitched.l, pitched.r, ...preserved]
    } else {
      feedChannels = [pitched.l, pitched.r]
    }
    feedLen = pitchedLen
  }

  const inputChannels = feedChannels.map(() => new Float32Array(BLOCK))

  let pos = 0
  while (pos < feedLen) {
    const n = Math.min(BLOCK, feedLen - pos)
    for (let channel = 0; channel < inputChannels.length; channel++) {
      inputChannels[channel].set(feedChannels[channel].subarray(pos, pos + n))
      if (n < BLOCK) inputChannels[channel].fill(0, n)
    }
    engine.process(inputChannels, [outL, outR])
    pushOutputs()
    pos += n
  }
  for (let t = 0; t < TAIL_BLOCKS; t += 1) {
    for (const channel of inputChannels) channel.fill(0)
    engine.process(inputChannels, [outL, outR])
    pushOutputs()
  }

  const asL = new Float32Array(outChunksL.length * BLOCK)
  const asR = new Float32Array(outChunksR.length * BLOCK)
  for (let i = 0; i < outChunksL.length; i += 1) {
    asL.set(outChunksL[i], i * BLOCK)
    asR.set(outChunksR[i], i * BLOCK)
  }

  // pitch 已在 engine 处理前完成（见上方 feed 前置，与实时链顺序一致），此处直出
  return { left: asL, right: asR, sampleRate: fs }
}

async function saveRenderedBlob(blob: Blob, fileName: string): Promise<void> {
  // Electron：直写用户桌面；网页端退化为浏览器下载
  const host = window as unknown as {
    electron?: {
      saveHseRenderedAudio?: (
        data: Uint8Array,
        fileName: string,
      ) => Promise<{ ok: boolean; path?: string; error?: string }>
    }
  }
  if (host.electron?.saveHseRenderedAudio) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const res = await host.electron.saveHseRenderedAudio(bytes, fileName)
    if (!res.ok) throw new Error(res.error || '保存到桌面失败')
    window.dispatchEvent(new CustomEvent('showToast', {
      detail: { message: `已导出到桌面：${fileName}`, type: 'info' },
    }))
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 离线 MP3 导出，与 WAV 共用同一段 HSE PCM 渲染链。 */
export async function exportV3Mp3(sourceUrl: string, durationSeconds: number, options?: V3ExportOptions): Promise<void> {
  const pcm = await renderV3Pcm(sourceUrl, durationSeconds)
  const blob = await encodeMp3([pcm.left, pcm.right], pcm.sampleRate, options?.quantization ?? 'tpdf')
  await saveRenderedBlob(blob, `${sanitizeFileName(options?.fileName || '')}-Modified.mp3`)
}

/** 无损容器中的 16-bit PCM 导出；降位深时可选 TPDF 或一阶噪声整形。 */
export async function exportV3Wav(sourceUrl: string, durationSeconds: number, options?: V3ExportOptions): Promise<void> {
  const pcm = await renderV3Pcm(sourceUrl, durationSeconds)
  const wav = encodePcm16Wav([pcm.left, pcm.right], pcm.sampleRate, options?.quantization ?? 'tpdf')
  await saveRenderedBlob(new Blob([wav as BlobPart], { type: 'audio/wav' }), `${sanitizeFileName(options?.fileName || '')}-Modified.wav`)
}
