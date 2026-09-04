import { debugLog } from '../../utils/debugLog'
import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import processorUrl from '@soundtouchjs/audio-worklet/processor?url'
import { compensationService, type CompensationDesign, type CompensationSegment } from './compensationService'

// ============ 设置类型 ============

export type EqMode = 'simple' | 'pro'

/** 卷积混响类型：大厅 / 房间 / 板式 / 弹簧 / 舞台 */
export type ReverbType = 'hall' | 'room' | 'plate' | 'spring' | 'stage'

/** 频响补偿模式：auto=ISO 226 等响度自适应（按系统音量）/ preset=场景预设 / custom=自定义频段 */
export type CompensationMode = 'auto' | 'preset' | 'custom'

export interface CloudEffectsSettings {
  hall: { enabled: boolean; level: number; reverb: number; type: ReverbType; preDelay: number; decay: number } // 全景声厅：声场 1-10 + 混响量 0-10 + 混响类型/预延迟(ms)/衰减(s)
  surround3d: { enabled: boolean; distance: number; speed: number; angle: number; direction: 1 | -1 } // 3D 环绕
  bassBoost: { enabled: boolean; depth: number; intensity: number } // 低音增强
  vocalBoost: { enabled: boolean; intensity: number } // 人声加强
  accompanimentBoost: { enabled: boolean; intensity: number } // 伴奏加强
  compressor: { enabled: boolean; threshold: number; ratio: number; attack: number; release: number; outputGain: number } // 动态压缩
  nightMode: { enabled: boolean; amount: number } // 夜间模式：软限幅强度 0-10
  // 频响补偿：多段 Biquad 链应用目标补偿曲线（ISO 226 等响度 / 预设 / 自定义），与 EQ、响度归一化互斥
  loudnessCompensation: {
    enabled: boolean
    mode: CompensationMode
    preset: string
    bands: { frequency: number; gain: number }[] // custom 模式的目标曲线控制点
  }
}

export interface EqBand {
  frequency: number
  gain: number // dB
  q: number
}

export interface EqSettings {
  enabled: boolean
  mode: EqMode
  // 简约版 5 段：[低音, 中低, 中音, 中高, 高音] 增益 dB
  simpleBands: number[]
  // 专业版 10 段（octave）
  proBands: EqBand[]
}

export interface PitchSettings {
  enabled: boolean
  semitones: number // -10 ~ +10
  rate: number // 0.25 ~ 3.0
  voiceBalance: number // -1(仅伴奏) ~ 0(原声) ~ +1(仅人声)
}

export interface AudioEffectsSettings {
  effects: CloudEffectsSettings
  eq: EqSettings
  pitch: PitchSettings
  /** 当前场景方案 id；null = 无场景（自定义或初始） */
  activeScene: string | null
  /** 用户是否手动修改过参数（脱离场景快照） */
  customized: boolean
  /** 响度归一化总开关 */
  normalizationEnabled: boolean
}

/** 场景方案快照：一组完整听感参数（effects + eq），不包含变调/变速 */
export interface SceneSnapshot {
  id: string
  name: string
  description?: string
  builtin?: boolean
  effects: CloudEffectsSettings
  eq: EqSettings
}

// 深层的可选类型，用于局部更新设置
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

// ============ 常量 ============

export const SIMPLE_EQ_BANDS = [
  { label: '低音', frequency: 80, hint: '管鼓点/贝斯的厚度，往上更沉、往下更干净' },
  { label: '中低', frequency: 250, hint: '管温暖感和饱满度，过量会发闷' },
  { label: '中音', frequency: 1000, hint: '管人声和主乐器的主体，最影响清晰度' },
  { label: '中高', frequency: 4000, hint: '管人声齿音和乐器的通透/明亮' },
  { label: '高音', frequency: 12000, hint: '管空气感和细节，过量会刺耳' },
]

export const PRO_EQ_FREQUENCIES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

export const REVERB_TYPES: Array<{ value: ReverbType; label: string; hint: string }> = [
  { value: 'hall', label: '大厅', hint: '长尾音、空间开阔，适合古典/人声' },
  { value: 'room', label: '房间', hint: '短促、贴耳，适合流行/播客' },
  { value: 'plate', label: '板式', hint: '明亮、有光泽，适合人声/鼓' },
  { value: 'spring', label: '弹簧', hint: '复古颤抖感，适合吉他/摇滚' },
  { value: 'stage', label: '舞台', hint: '中等尾音、有现场感' },
]

const SETTINGS_KEY = 'waveforge:audio-effects-settings'
const MY_SCENES_KEY = 'waveforge:my-scenes'

// 频响补偿的滑条与低音量阈值：系统音量低于该值提示用户开启补偿
export const LOUDNESS_COMPENSATION_THRESHOLD = 50

// 频响补偿：音量档位（0-100 刻度，±10%），档位内微调不重新请求设计
const COMPENSATION_VOLUME_RESYNC = 10

// 补偿增益动态平滑时间常数（秒）：081402 §6.3 建议 tau 100-500ms，取 200ms，
// 音量变化时补偿增益平滑过渡，避免「频响跳动」（仅补偿段使用，其他效果不跟随）
const COMPENSATION_SMOOTHING_SECONDS = 0.2

// 内置近似补偿段：Python 设计服务不可用时的等响度近似，与 Python design_equal_loudness 对齐
// （低架 120Hz Q0.707 + 高架 12kHz Q0.707，081402 §4.3），增益由 builtinCompensationGains 按系统音量线性计算
const BUILTIN_COMP_SEGMENTS: CompensationSegment[] = [
  { type: 'lowshelf', frequency: 120, q: 0.707, gain: 0 },
  { type: 'highshelf', frequency: 12000, q: 0.707, gain: 0 },
]

// 内置近似增益：等响度线性，与 Python design_equal_loudness 同式——
// SPL 亏欠 deficit = 30 - 0.3*volume（100%→0dB、0%→30dB，081402 §6.1 映射），
// 低频系数 0.35 / 高频系数 0.15，上限 12/6dB；volume=-1 视为满音量（不补偿）
function builtinCompensationGains(volume: number): { low: number; high: number } {
  const vol = volume >= 0 ? volume : 100
  const deficit = 30 - 0.3 * vol
  const lowBoost = Math.max(0, Math.min(12, deficit * 0.35))
  const highBoost = Math.max(0, Math.min(6, deficit * 0.15))
  return { low: lowBoost, high: highBoost }
}

function defaultEffects(): CloudEffectsSettings {
  return {
    hall: { enabled: false, level: 5, reverb: 5, type: 'hall', preDelay: 18, decay: 2.2 },
    surround3d: { enabled: false, distance: 5, speed: 1, angle: 0, direction: 1 },
    bassBoost: { enabled: false, depth: 100, intensity: 6 },
    vocalBoost: { enabled: false, intensity: 4 },
    accompanimentBoost: { enabled: false, intensity: 4 },
    compressor: { enabled: false, threshold: -18, ratio: 3, attack: 0.02, release: 0.2, outputGain: 3 },
    nightMode: { enabled: false, amount: 6 },
    loudnessCompensation: { enabled: false, mode: 'auto', preset: 'flat', bands: [] },
  }
}

function defaultSettings(): AudioEffectsSettings {
  return {
    effects: defaultEffects(),
    eq: {
      enabled: false,
      mode: 'simple',
      simpleBands: [0, 0, 0, 0, 0],
      proBands: PRO_EQ_FREQUENCIES.map(frequency => ({ frequency, gain: 0, q: 1.1 })),
    },
    pitch: {
      enabled: false,
      semitones: 0,
      rate: 1,
      voiceBalance: 0,
    },
    activeScene: null,
    customized: false,
    normalizationEnabled: false,
  }
}

// 内置场景方案（快照式：应用即写入参数）
const BUILTIN_SCENES: SceneSnapshot[] = [
  {
    id: 'scene-heavy-bass',
    name: '重低音',
    description: '低音增强 + 轻压缩，鼓点与贝斯更有冲击力，中高频更干净',
    builtin: true,
    effects: {
      ...defaultEffects(),
      // 全景声厅关闭：重低音+全景声+其他全开时中高频被砍没、听感差；保留低音增强与压缩
      hall: { enabled: false, level: 6, reverb: 3, type: 'hall', preDelay: 18, decay: 2.2 },
      bassBoost: { enabled: true, depth: 90, intensity: 9 },
      compressor: { enabled: true, threshold: -16, ratio: 3.5, attack: 0.02, release: 0.2, outputGain: 3 },
    },
    eq: {
      ...defaultSettings().eq,
      // 场景 EQ 统一专业模式（10 段）：即使 EQ 关闭（enabled:false），
      // 用户切到均衡器 Tab 也是专业 10 段滑条，而非简约 5 段（用户要求）
      mode: 'pro',
    },
  },
  {
    id: 'scene-pop',
    name: '流行',
    description: '人声靠前 + 轻混响，通透清晰',
    builtin: true,
    effects: {
      ...defaultEffects(),
      hall: { enabled: true, level: 4, reverb: 4, type: 'room', preDelay: 12, decay: 1.4 },
      vocalBoost: { enabled: true, intensity: 4 },
    },
    eq: {
      ...defaultSettings().eq,
      enabled: true,
      mode: 'pro',
      simpleBands: [2, 1, 1.5, 2, 1],
      // 专业 10 段近似：低音 2 → 31.5/63/125 均分、中低 1 → 250、中音 1.5 → 500/1000、
      // 中高 2 → 2000/4000、高音 1 → 8000/16000（0.5 步进）
      proBands: [
        { frequency: 31.5, gain: 0.5, q: 1.1 },
        { frequency: 63, gain: 0.5, q: 1.1 },
        { frequency: 125, gain: 1, q: 1.1 },
        { frequency: 250, gain: 1, q: 1.1 },
        { frequency: 500, gain: 0.5, q: 1.1 },
        { frequency: 1000, gain: 1, q: 1.1 },
        { frequency: 2000, gain: 1, q: 1.1 },
        { frequency: 4000, gain: 1, q: 1.1 },
        { frequency: 8000, gain: 0.5, q: 1.1 },
        { frequency: 16000, gain: 0.5, q: 1.1 },
      ],
    },
  },
  {
    id: 'scene-rock',
    name: '摇滚',
    description: '重压缩 + 低音增强，能量感强',
    builtin: true,
    effects: {
      ...defaultEffects(),
      bassBoost: { enabled: true, depth: 95, intensity: 8 },
      compressor: { enabled: true, threshold: -14, ratio: 5, attack: 0.01, release: 0.15, outputGain: 4 },
    },
    eq: {
      ...defaultSettings().eq,
      enabled: true,
      mode: 'pro',
      simpleBands: [3, 1, 0.5, 2, 3],
      // 专业 10 段近似：低音 3 → 31.5/63/125 均分、中低 1 → 250、中音 0.5 → 500/1000、
      // 中高 2 → 2000/4000、高音 3 → 8000/16000（0.5 步进）
      proBands: [
        { frequency: 31.5, gain: 1, q: 1.1 },
        { frequency: 63, gain: 1, q: 1.1 },
        { frequency: 125, gain: 1, q: 1.1 },
        { frequency: 250, gain: 1, q: 1.1 },
        { frequency: 500, gain: 0, q: 1.1 },
        { frequency: 1000, gain: 0.5, q: 1.1 },
        { frequency: 2000, gain: 1, q: 1.1 },
        { frequency: 4000, gain: 1, q: 1.1 },
        { frequency: 8000, gain: 1.5, q: 1.1 },
        { frequency: 16000, gain: 1.5, q: 1.1 },
      ],
    },
  },
  {
    id: 'scene-classical',
    name: '古典',
    description: '舞台混响 + 平坦 EQ，保留动态与细节',
    builtin: true,
    effects: {
      ...defaultEffects(),
      hall: { enabled: true, level: 5, reverb: 7, type: 'stage', preDelay: 22, decay: 2.8 },
    },
    eq: defaultSettings().eq,
  },
  {
    id: 'scene-vocal',
    name: '人声突出',
    description: '中频提升 + 人声加强，人声更清晰',
    builtin: true,
    effects: {
      ...defaultEffects(),
      vocalBoost: { enabled: true, intensity: 6 },
      hall: { enabled: true, level: 3, reverb: 3, type: 'plate', preDelay: 14, decay: 2.0 },
    },
    eq: {
      ...defaultSettings().eq,
      enabled: true,
      mode: 'pro',
      simpleBands: [0, -1, 3, 2, 0],
      // 专业 10 段近似：低音 0 → 31.5/63/125 均分、中低 -1 → 250、中音 3 → 500/1000、
      // 中高 2 → 2000/4000、高音 0 → 8000/16000（0.5 步进）
      proBands: [
        { frequency: 31.5, gain: 0, q: 1.1 },
        { frequency: 63, gain: 0, q: 1.1 },
        { frequency: 125, gain: 0, q: 1.1 },
        { frequency: 250, gain: -1, q: 1.1 },
        { frequency: 500, gain: 1.5, q: 1.1 },
        { frequency: 1000, gain: 1.5, q: 1.1 },
        { frequency: 2000, gain: 1, q: 1.1 },
        { frequency: 4000, gain: 1, q: 1.1 },
        { frequency: 8000, gain: 0, q: 1.1 },
        { frequency: 16000, gain: 0, q: 1.1 },
      ],
    },
  },
  {
    id: 'scene-night',
    name: '夜间',
    description: '软限幅 + 高音微降，深夜不吵',
    builtin: true,
    effects: {
      ...defaultEffects(),
      nightMode: { enabled: true, amount: 7 },
      bassBoost: { enabled: true, depth: 90, intensity: 3 },
    },
    eq: {
      ...defaultSettings().eq,
      enabled: true,
      mode: 'pro',
      simpleBands: [0, 0, 0, -2, -3],
      // 专业 10 段近似：低音 0 → 31.5/63/125、中低 0 → 250、中音 0 → 500/1000、
      // 中高 -2 → 2000/4000、高音 -3 → 8000/16000（0.5 步进，高音衰减助眠不吵）
      proBands: [
        { frequency: 31.5, gain: 0, q: 1.1 },
        { frequency: 63, gain: 0, q: 1.1 },
        { frequency: 125, gain: 0, q: 1.1 },
        { frequency: 250, gain: 0, q: 1.1 },
        { frequency: 500, gain: 0, q: 1.1 },
        { frequency: 1000, gain: 0, q: 1.1 },
        { frequency: 2000, gain: -1, q: 1.1 },
        { frequency: 4000, gain: -1, q: 1.1 },
        { frequency: 8000, gain: -1.5, q: 1.1 },
        { frequency: 16000, gain: -1.5, q: 1.1 },
      ],
    },
  },
  {
    id: 'scene-flat',
    name: '原声监听',
    description: '关闭全部音效与 EQ，还原原始声音',
    builtin: true,
    effects: defaultEffects(),
    eq: {
      ...defaultSettings().eq,
      // 场景 EQ 统一专业模式（10 段）
      mode: 'pro',
    },
  },
]

function loadMyScenes(): SceneSnapshot[] {
  try {
    const raw = localStorage.getItem(MY_SCENES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(s => s && typeof s.id === 'string' && s.effects && s.eq) : []
  } catch {
    return []
  }
}

function saveMyScenes(scenes: SceneSnapshot[]): void {
  try {
    localStorage.setItem(MY_SCENES_KEY, JSON.stringify(scenes))
  } catch {
    // 忽略存储失败
  }
}

function loadSettings(): AudioEffectsSettings {
  const defaults = defaultSettings()
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<AudioEffectsSettings>
    const de = defaults.effects
    const pe = (parsed.effects || {}) as DeepPartial<CloudEffectsSettings>
    return {
      effects: {
        hall: { ...de.hall, ...(pe.hall || {}) },
        surround3d: { ...de.surround3d, ...(pe.surround3d || {}) },
        bassBoost: { ...de.bassBoost, ...(pe.bassBoost || {}) },
        vocalBoost: { ...de.vocalBoost, ...(pe.vocalBoost || {}) },
        accompanimentBoost: { ...de.accompanimentBoost, ...(pe.accompanimentBoost || {}) },
        compressor: { ...de.compressor, ...(pe.compressor || {}) },
        nightMode: { ...de.nightMode, ...(pe.nightMode || {}) },
        // bands 是数组：deep partial 无法合并数组，直接用旧值或默认值（仅在未修改模式时保留旧 bands）
        loudnessCompensation: {
          ...de.loudnessCompensation,
          ...(pe.loudnessCompensation || {}),
          bands: Array.isArray(pe.loudnessCompensation?.bands)
            ? (pe.loudnessCompensation!.bands as { frequency: number; gain: number }[])
            : de.loudnessCompensation.bands,
        },
      },
      eq: {
        ...defaults.eq,
        ...(parsed.eq || {}),
        simpleBands: Array.isArray(parsed.eq?.simpleBands) && parsed.eq!.simpleBands!.length === 5
          ? parsed.eq!.simpleBands!
          : defaults.eq.simpleBands,
        proBands: Array.isArray(parsed.eq?.proBands) && parsed.eq!.proBands!.length === PRO_EQ_FREQUENCIES.length
          ? parsed.eq!.proBands!
          : defaults.eq.proBands,
      },
      pitch: { ...defaults.pitch, ...(parsed.pitch || {}) },
      activeScene: typeof parsed.activeScene === 'string' ? parsed.activeScene : null,
      customized: !!parsed.customized,
      normalizationEnabled: !!parsed.normalizationEnabled,
    }
  } catch {
    return defaults
  }
}

// ============ 工具函数 ============

// Chrome 的 DynamicsCompressorNode 扩展了 makeupGain（TS lib 未收录）
function compressorMakeupGain(comp: DynamicsCompressorNode): AudioParam | null {
  return (comp as unknown as { makeupGain?: AudioParam }).makeupGain || null
}

interface ReverbPreset {
  seconds: number
  decay: number
  preDelay: number // 秒
  early: Array<{ delay: number; gain: number }>
  lowpass: number // 晚期反射低通系数（越大越亮）
  decorrelation: number // 左右去相关强度
}

const REVERB_PRESETS: Record<ReverbType, ReverbPreset> = {
  hall: {
    seconds: 3.6, decay: 2.2, preDelay: 0.018,
    early: [
      { delay: 0.010, gain: 0.55 }, { delay: 0.022, gain: 0.42 }, { delay: 0.035, gain: 0.34 },
      { delay: 0.051, gain: 0.26 }, { delay: 0.068, gain: 0.2 }, { delay: 0.087, gain: 0.15 }, { delay: 0.108, gain: 0.11 },
    ],
    lowpass: 0.16, decorrelation: 0.92,
  },
  room: {
    seconds: 1.2, decay: 3.6, preDelay: 0.006,
    early: [
      { delay: 0.004, gain: 0.6 }, { delay: 0.009, gain: 0.48 }, { delay: 0.015, gain: 0.38 },
      { delay: 0.022, gain: 0.3 }, { delay: 0.03, gain: 0.24 }, { delay: 0.039, gain: 0.18 },
    ],
    lowpass: 0.28, decorrelation: 0.95,
  },
  plate: {
    seconds: 2.5, decay: 2.6, preDelay: 0.004,
    early: [],
    lowpass: 0.08, decorrelation: 0.85,
  },
  spring: {
    seconds: 2.0, decay: 3.0, preDelay: 0.003,
    early: [
      { delay: 0.002, gain: 0.5 }, { delay: 0.008, gain: 0.35 }, { delay: 0.015, gain: 0.3 },
    ],
    lowpass: 0.2, decorrelation: 0.75,
  },
  stage: {
    seconds: 2.8, decay: 2.4, preDelay: 0.02,
    early: [
      { delay: 0.008, gain: 0.5 }, { delay: 0.019, gain: 0.4 }, { delay: 0.033, gain: 0.3 },
      { delay: 0.05, gain: 0.24 }, { delay: 0.07, gain: 0.18 }, { delay: 0.093, gain: 0.13 },
    ],
    lowpass: 0.14, decorrelation: 0.9,
  },
}

// 生成指定混响类型的立体声脉冲响应（可被用户参数覆盖：预延迟 / 衰减时间）
function generateReverbImpulseResponse(context: BaseAudioContext, type: ReverbType, preDelayMs: number, decaySec: number): AudioBuffer {
  const preset = REVERB_PRESETS[type] || REVERB_PRESETS.hall
  const seconds = Math.min(6, preset.seconds + Math.max(0, decaySec - preset.decay) * 0.35)
  const sampleRate = context.sampleRate
  const length = Math.max(1, Math.floor(sampleRate * seconds))
  const buffer = context.createBuffer(2, length, sampleRate)
  // 防御性检查：设置损坏/缺字段（NaN、字符串）时回退预设值，避免 createBuffer(NaN) 抛错
  const preDelay = Number.isFinite(preDelayMs) ? Math.max(0, Math.min(0.25, preDelayMs / 1000)) : preset.preDelay
  const decay = Number.isFinite(decaySec) ? Math.max(0.4, Math.min(6, decaySec)) : preset.decay
  const preDelaySamples = Math.floor(sampleRate * preDelay)
  const lpCoeff = preset.lowpass

  // 早期反射：不同延迟与衰减的离散回声（左右略有差异，增加空间感）
  const earlyReflections = preset.early

  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch)
    const sideScale = ch === 0 ? 1 : preset.decorrelation

    for (const er of earlyReflections) {
      const idx = Math.floor(sampleRate * er.delay)
      if (idx < length) data[idx] = er.gain * sideScale
    }

    // 晚期反射：去相关噪声 + 一阶低通（模拟空气对高频的吸收）
    let lp = 0
    for (let i = preDelaySamples; i < length; i += 1) {
      const t = (i - preDelaySamples) / sampleRate
      const envelope = Math.exp(-decay * t)
      const white = Math.random() * 2 - 1
      lp += lpCoeff * (white - lp)
      data[i] += lp * envelope * 0.7
    }
  }

  return buffer
}

interface MsMatrix {
  input: ChannelSplitterNode
  output: ChannelMergerNode
  centerGain: GainNode
  sideGain: GainNode
}

// 构建中/侧（M/S）矩阵：输入立体声 → [M, S] → 分别加增益 → 重组回立体声
// centerGain/sideGain 默认都为 1（完全透明，L'=L, R'=R）
function createMsMatrix(context: BaseAudioContext): MsMatrix {
  const splitter = context.createChannelSplitter(2)

  const mL = context.createGain()
  const mR = context.createGain()
  const mSum = context.createGain()
  mL.gain.value = 0.5
  mR.gain.value = 0.5
  const sL = context.createGain()
  const sR = context.createGain()
  const sSum = context.createGain()
  sL.gain.value = 0.5
  sR.gain.value = -0.5

  splitter.connect(mL, 0)
  splitter.connect(mR, 1)
  mL.connect(mSum)
  mR.connect(mSum)
  splitter.connect(sL, 0)
  splitter.connect(sR, 1)
  sL.connect(sSum)
  sR.connect(sSum)

  const centerGain = context.createGain()
  const sideGain = context.createGain()
  centerGain.gain.value = 1
  sideGain.gain.value = 1
  mSum.connect(centerGain)
  sSum.connect(sideGain)

  const outL = context.createGain()
  const outR = context.createGain()
  const sideNeg = context.createGain()
  sideNeg.gain.value = -1
  centerGain.connect(outL)
  sideGain.connect(outL)
  centerGain.connect(outR)
  sideGain.connect(sideNeg)
  sideNeg.connect(outR)

  const merger = context.createChannelMerger(2)
  outL.connect(merger, 0, 0)
  outR.connect(merger, 0, 1)

  return { input: splitter, output: merger, centerGain, sideGain }
}

// 依据设置构建完整效果链（实时 / 离线渲染共用，见 ADR-0003）。
// 返回链的 input 与 output；动态参数（增益等）在构建后由调用方按需设置。
interface BuiltEffectChain {
  input: GainNode
  output: GainNode
  voiceMatrix: MsMatrix
  presenceMatrix: MsMatrix
  bassFilter: BiquadFilterNode
  bassPunchFilter: BiquadFilterNode
  vocalFilter: BiquadFilterNode
  accompFilter: BiquadFilterNode
  compressor: DynamicsCompressorNode
  nightShaper: WaveShaperNode
  nightGain: GainNode
  nightCompressor: DynamicsCompressorNode
  nightTreble: BiquadFilterNode
  hallMatrix: MsMatrix
  hallConvolver: ConvolverNode
  hallWetGain: GainNode
  panner: PannerNode
  pannerWetGain: GainNode
  pannerDryGain: GainNode
}

function buildEffectChain(context: BaseAudioContext, settings: AudioEffectsSettings): BuiltEffectChain {
  const input = context.createGain()
  const output = context.createGain()
  input.gain.value = 1
  output.gain.value = 1

  const voiceMatrix = createMsMatrix(context)
  const presenceMatrix = createMsMatrix(context)

  // 全景声厅：M/S 加宽 + 卷积混响（类型化 IR）
  const hallMatrix = createMsMatrix(context)
  const hallConvolver = context.createConvolver()
  hallConvolver.buffer = generateReverbImpulseResponse(context, settings.effects.hall.type, settings.effects.hall.preDelay, settings.effects.hall.decay)
  const hallWetGain = context.createGain()
  hallWetGain.gain.value = 0

  // 3D 环绕
  const panner = context.createPanner()
  panner.panningModel = 'HRTF'
  panner.distanceModel = 'inverse'
  const pannerWetGain = context.createGain()
  pannerWetGain.gain.value = 0
  const pannerDryGain = context.createGain()
  pannerDryGain.gain.value = 1

  // 音色类效果
  const bassFilter = context.createBiquadFilter()
  bassFilter.type = 'lowshelf'
  bassFilter.gain.value = 0
  const bassPunchFilter = context.createBiquadFilter()
  bassPunchFilter.type = 'peaking'
  bassPunchFilter.frequency.value = 55
  bassPunchFilter.Q.value = 0.9
  bassPunchFilter.gain.value = 0
  const vocalFilter = context.createBiquadFilter()
  vocalFilter.type = 'peaking'
  vocalFilter.frequency.value = 3000
  vocalFilter.Q.value = 2.4
  vocalFilter.gain.value = 0
  const accompFilter = context.createBiquadFilter()
  accompFilter.type = 'peaking'
  accompFilter.frequency.value = 2800
  accompFilter.Q.value = 1.6
  accompFilter.gain.value = 0

  // 动态处理：压缩器 + 夜间模式
  const compressor = context.createDynamicsCompressor()
  compressor.threshold.value = settings.effects.compressor.threshold
  compressor.ratio.value = settings.effects.compressor.ratio
  compressor.attack.value = settings.effects.compressor.attack
  compressor.release.value = settings.effects.compressor.release
  compressor.knee.value = 6

  // 夜间模式（重设计 2026-08-15）：夜间 = 深夜低音量舒适听感。
  // 旧实现用 WaveShaper tanh 波形整形（k 最高 6.5）→ 强非线性产生大量谐波失真 = 炸音，
  // 且补偿增益反而抬响度，语义不符。改为：
  //   ① 温和动态压缩（DynamicsCompressor，压缩起伏不产生谐波，深夜响度平稳）
  //   ② highshelf 高频衰减（夜间高频刺耳，-2~-6dB 随强度）
  //   ③ 不额外抬增益（压缩损失由压缩器自身 makeup 补偿，克制）
  // WaveShaper 节点保留为直通占位（curve=null），不参与信号。
  const nightShaper = context.createWaveShaper()
  nightShaper.oversample = '2x'
  nightShaper.curve = null
  const nightGain = context.createGain()
  nightGain.gain.value = 1
  const nightCompressor = context.createDynamicsCompressor()
  nightCompressor.threshold.value = -24
  nightCompressor.ratio.value = 2.5
  nightCompressor.attack.value = 0.01
  nightCompressor.release.value = 0.35
  nightCompressor.knee.value = 12
  const nightMakeup = compressorMakeupGain(nightCompressor)
  if (nightMakeup) nightMakeup.value = 1
  const nightTreble = context.createBiquadFilter()
  nightTreble.type = 'highshelf'
  nightTreble.frequency.value = 6500
  nightTreble.gain.value = 0

  // 骨架：
  // input → voiceMatrix → [EQ | 频响补偿] → presenceMatrix → bass → punch → vocal → accomp
  //   → compressor → nightShaper(直通) → nightGain → nightCompressor → nightTreble
  //   → hallMatrix(干) → pannerDryGain → output
  //   → hallConvolver(湿) → hallWetGain → pannerDryGain
  //   → panner(湿) → pannerWetGain → output
  input.connect(voiceMatrix.input)
  voiceMatrix.output.connect(presenceMatrix.input)
  presenceMatrix.output.connect(bassFilter)
  bassFilter.connect(bassPunchFilter)
  bassPunchFilter.connect(vocalFilter)
  vocalFilter.connect(accompFilter)
  accompFilter.connect(compressor)
  compressor.connect(nightShaper)
  nightShaper.connect(nightGain)
  nightGain.connect(nightCompressor)
  nightCompressor.connect(nightTreble)
  nightTreble.connect(hallMatrix.input)
  hallMatrix.output.connect(pannerDryGain)
  nightTreble.connect(hallConvolver)
  hallConvolver.connect(hallWetGain)
  hallWetGain.connect(pannerDryGain)
  pannerDryGain.connect(output)
  // 湿路（HRTF 环绕）必须从干路信号源直接分叉，不能挂在 pannerDryGain 上——
  // 否则 3D 环绕启用时 pannerDryGain 增益降到 0，panner 的输入同样为 0，音乐会完全无声。
  hallMatrix.output.connect(panner)
  panner.connect(pannerWetGain)
  pannerWetGain.connect(output)

  return {
    input, output,
    voiceMatrix, presenceMatrix,
    bassFilter, bassPunchFilter, vocalFilter, accompFilter,
    compressor, nightShaper, nightGain, nightCompressor, nightTreble,
    hallMatrix, hallConvolver, hallWetGain,
    panner, pannerWetGain, pannerDryGain,
  }
}

// 把 AudioBuffer 编码为 16-bit PCM WAV
function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, buffer.numberOfChannels)
  const sampleRate = buffer.sampleRate
  const length = buffer.length * numChannels * 2
  const arrayBuffer = new ArrayBuffer(44 + length)
  const view = new DataView(arrayBuffer)

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + length, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * numChannels * 2, true)
  view.setUint16(32, numChannels * 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, length, true)

  let offset = 44
  for (let i = 0; i < buffer.length; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' })
}

// ============ 引擎 ============

export class AudioEffectsEngine {
  private context: AudioContext | null = null
  private masterGain: GainNode | null = null
  private analyser: AnalyserNode | null = null

  private input: GainNode | null = null
  private output: GainNode | null = null

  // 响度归一化增益（per-song，由播放器按歌曲 LUFS 设置）
  private normGain: GainNode | null = null

  // 变调/变速（SoundTouch AudioWorklet，异步注册）
  private soundtouchNode: SoundTouchNode | null = null

  // 效果链（attach 时构建；EQ/频响补偿为动态插入段）
  private chain: BuiltEffectChain | null = null

  // 混响 IR 参数指纹（type|preDelay|decay）；仅参数变化才重建，
  // 避免拖动滑杆等热路径每次都重分配数 MB 脉冲缓冲区并引发可闻咔哒声
  private lastIrKey = ''

  // 均衡器 / 频响补偿（二选一插入 voiceMatrix → presenceMatrix 之间）
  private eqFilters: BiquadFilterNode[] = []
  private compFilters: BiquadFilterNode[] = []

  // 输出保护
  private limiter: DynamicsCompressorNode | null = null

  // 3D 环绕旋转
  private surroundAnimationFrame = 0
  private surroundAngle = 0
  private surroundLastTime = 0

  // 频响补偿：最近一次系统音量（0-100），-1 = 未知
  private systemVolume = -1
  // 当前生效的补偿设计（异步设计结果；null = 未获取/服务不可用 → 内置近似）
  private compDesign: CompensationDesign | null = null
  // 引擎内设计缓存 key（mode + preset + 音量档位 + custom bands）：相同则复用不重复请求
  private lastCompDesignKey = ''
  // 上次发起设计请求时的系统音量（0-100）；-1 = 尚未请求
  private lastDesignedVolume = -1
  // 设计失败时间戳（0 = 未失败）：失败后进入重试窗口，避免重复请求；窗口过后自动重试恢复
  private compDesignFailedAt = 0
  // 在途设计请求序号：模式/音量变化或 dispose 时自增，作废旧请求结果（防竞态）
  private compDesignSeq = 0

  private settings: AudioEffectsSettings = loadSettings()
  private myScenes: SceneSnapshot[] = loadMyScenes()

  getSettings(): AudioEffectsSettings {
    return this.settings
  }

  getMyScenes(): SceneSnapshot[] {
    return this.myScenes
  }

  getBuiltinScenes(): SceneSnapshot[] {
    return BUILTIN_SCENES
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings))
    } catch {
      // 忽略存储失败
    }
    // 通知外部监听者（如看歌视频音效引擎）实时同步设置
    try {
      window.dispatchEvent(new CustomEvent('waveforge:audio-effects-changed', { detail: this.settings }))
    } catch {
      // 忽略
    }
  }

  // 供 UI 一次性导入完整设置（预设导入/恢复）
  applySettings(next: AudioEffectsSettings): void {
    this.settings = next
    this.saveSettings()
    // 设置整体替换可能改变补偿参数：作废在途请求并重新设计（补偿启用时）
    this.compDesignSeq++
    this.lastCompDesignKey = ''
    this.applyCompensationDesign()
    this.rebuildFromSettings()
  }

  /** 更新设置；任何手动修改都会把当前状态标记为「自定义」（脱离场景快照） */
  updateSettings(patch: DeepPartial<AudioEffectsSettings>): void {
    // 记录各互斥开关的旧值（必须在合并 patch 之前读取）
    const prevComp = this.settings.effects.loudnessCompensation.enabled
    const prevEq = this.settings.eq.enabled
    const prevNorm = this.settings.normalizationEnabled
    // 7 个音效开关的旧值：频响补偿与任一音效互斥（ADR-0002 扩展），同样须在合并前读取
    const prevEffects = {
      hall: this.settings.effects.hall.enabled,
      surround3d: this.settings.effects.surround3d.enabled,
      bassBoost: this.settings.effects.bassBoost.enabled,
      vocalBoost: this.settings.effects.vocalBoost.enabled,
      accompanimentBoost: this.settings.effects.accompanimentBoost.enabled,
      compressor: this.settings.effects.compressor.enabled,
      nightMode: this.settings.effects.nightMode.enabled,
    }
    // 频响补偿设计参数旧值：mode/preset/bands 变化时需重新设计
    const prevCompMode = this.settings.effects.loudnessCompensation.mode
    const prevCompPreset = this.settings.effects.loudnessCompensation.preset
    const prevCompBands = this.settings.effects.loudnessCompensation.bands

    // 逐个 effects 子对象深合并：DeepPartial 允许只传部分字段（如仅 hall.level），
    // 若顶层整体覆盖会把 type/preDelay/decay 等未传字段抹成 undefined →
    // generateReverbImpulseResponse 里 Math.min(6, undefined)=NaN → createBuffer 抛错。
    const pe = patch.effects || {}
    const ce = this.settings.effects
    this.settings = {
      ...this.settings,
      effects: {
        hall: { ...ce.hall, ...(pe.hall || {}) },
        surround3d: { ...ce.surround3d, ...(pe.surround3d || {}) },
        bassBoost: { ...ce.bassBoost, ...(pe.bassBoost || {}) },
        vocalBoost: { ...ce.vocalBoost, ...(pe.vocalBoost || {}) },
        accompanimentBoost: { ...ce.accompanimentBoost, ...(pe.accompanimentBoost || {}) },
        compressor: { ...ce.compressor, ...(pe.compressor || {}) },
        nightMode: { ...ce.nightMode, ...(pe.nightMode || {}) },
        loudnessCompensation: { ...ce.loudnessCompensation, ...(pe.loudnessCompensation || {}) },
      } as CloudEffectsSettings,
      eq: { ...this.settings.eq, ...(patch.eq || {}) } as EqSettings,
      pitch: { ...this.settings.pitch, ...(patch.pitch || {}) } as PitchSettings,
      ...(patch.activeScene !== undefined ? { activeScene: patch.activeScene } : {}),
      ...(patch.customized !== undefined ? { customized: patch.customized } : {}),
      ...(patch.normalizationEnabled !== undefined ? { normalizationEnabled: patch.normalizationEnabled } : {}),
    }

    // 频响补偿 与 EQ 互斥（ADR-0002）、与响度归一化互斥、并与全部 7 个音效互斥：
    // 归一化按整曲对齐响度（目标 -14 LUFS），补偿按系统音量等响度提频——两者目标冲突，
    // 一首歌不可能既"低音量下好听"又"与其他歌频响一致"，不能同开。
    // 补偿曲线本质是「按音量改频响」的动态 EQ，与音效叠加会互相抵消/染色，故一并互斥。
    // else-if 结构：同一次 patch 同时开启补偿与音效/EQ/归一化时补偿优先（至少保留一个生效）。
    const nowComp = this.settings.effects.loudnessCompensation.enabled
    const nowEq = this.settings.eq.enabled
    const nowNorm = this.settings.normalizationEnabled
    // 任一音效本 patch 由关变开（互斥判定；只关心 enabled 变化，参数变化不触发）
    const anyEffectNewlyOn =
      (this.settings.effects.hall.enabled && !prevEffects.hall) ||
      (this.settings.effects.surround3d.enabled && !prevEffects.surround3d) ||
      (this.settings.effects.bassBoost.enabled && !prevEffects.bassBoost) ||
      (this.settings.effects.vocalBoost.enabled && !prevEffects.vocalBoost) ||
      (this.settings.effects.accompanimentBoost.enabled && !prevEffects.accompanimentBoost) ||
      (this.settings.effects.compressor.enabled && !prevEffects.compressor) ||
      (this.settings.effects.nightMode.enabled && !prevEffects.nightMode)
    if (nowComp && !prevComp) {
      this.settings.eq.enabled = false
      this.settings.normalizationEnabled = false
      // 只关 enabled 标志，各音效参数保持不变（互斥不动参数，随时可切回）
      this.settings.effects.hall.enabled = false
      this.settings.effects.surround3d.enabled = false
      this.settings.effects.bassBoost.enabled = false
      this.settings.effects.vocalBoost.enabled = false
      this.settings.effects.accompanimentBoost.enabled = false
      this.settings.effects.compressor.enabled = false
      this.settings.effects.nightMode.enabled = false
    } else {
      if (nowEq && !prevEq) this.settings.effects.loudnessCompensation.enabled = false
      if (nowNorm && !prevNorm) this.settings.effects.loudnessCompensation.enabled = false
      if (anyEffectNewlyOn) this.settings.effects.loudnessCompensation.enabled = false
    }

    // 手动修改 → 脱离场景快照
    if (patch.activeScene === undefined) this.settings.customized = true

    // 频响补偿设计参数（enabled/mode/preset/bands）变化时重新设计（补偿启用时）。
    // 先作废在途请求（旧结果不得覆盖新参数的设计），再触发新设计。
    // enabled 变化也触发：否则开关打开时 compDesign 为 null（走内置回退，而系统音量
    // 100% 时内置回退增益为 0/0）→ 开关毫无听感变化。
    const lc = this.settings.effects.loudnessCompensation
    if (lc.enabled !== prevComp && lc.enabled) {
      // 打开：作废旧设计并重新设计（此刻 compDesign 可能为 null 或旧模式的）
      this.compDesignSeq++
      this.lastCompDesignKey = ''
      this.applyCompensationDesign()
    } else if (lc.enabled && (lc.mode !== prevCompMode || lc.preset !== prevCompPreset || lc.bands !== prevCompBands)) {
      this.compDesignSeq++
      this.lastCompDesignKey = ''
      this.applyCompensationDesign()
    } else if (!lc.enabled) {
      // 关闭：清掉已应用的设计，回退内置（rebuildFromSettings 会经 rebuildEq 重建补偿段）
      this.compDesignSeq++
      this.compDesign = null
      this.lastCompDesignKey = ''
    }

    this.saveSettings()
    this.rebuildFromSettings()
  }

  /** 切换单个音效的开关（可叠加，不再互斥）；传 key 为空则不变 */
  toggleEffect(key: keyof CloudEffectsSettings | null): void {
    if (!key) return
    const current = this.settings.effects[key]
    if (!current || typeof current !== 'object') return
    const enabled = !('enabled' in current ? current.enabled : false)
    this.updateSettings({ effects: { [key]: { ...current, enabled } } } as unknown as DeepPartial<AudioEffectsSettings>)
  }

  // ============ 场景方案（快照式，见 ADR-0001） ============

  /** 应用场景快照：写入参数并清除自定义标记 */
  applyScene(scene: SceneSnapshot): void {
    const current = this.settings
    this.settings = {
      ...current,
      effects: JSON.parse(JSON.stringify(scene.effects)) as CloudEffectsSettings,
      eq: JSON.parse(JSON.stringify(scene.eq)) as EqSettings,
      activeScene: scene.id,
      customized: false,
    }
    this.saveSettings()
    // 场景切换可能改变补偿参数：作废在途请求并重新设计（补偿启用时）
    this.compDesignSeq++
    this.lastCompDesignKey = ''
    this.applyCompensationDesign()
    this.rebuildFromSettings()
  }

  /** 把当前听感保存为「我的场景」；超过上限返回 false */
  saveAsMyScene(name: string): boolean {
    const trimmed = name.trim()
    if (!trimmed) return false
    if (this.myScenes.length >= 8) return false
    const scene: SceneSnapshot = {
      id: `my-${Date.now()}`,
      name: trimmed,
      effects: JSON.parse(JSON.stringify(this.settings.effects)) as CloudEffectsSettings,
      eq: JSON.parse(JSON.stringify(this.settings.eq)) as EqSettings,
    }
    this.myScenes = [...this.myScenes, scene]
    saveMyScenes(this.myScenes)
    return true
  }

  deleteMyScene(id: string): void {
    this.myScenes = this.myScenes.filter(s => s.id !== id)
    saveMyScenes(this.myScenes)
  }

  // ============ 响度归一化 & 频响补偿 ============

  /** 设置当前歌曲的归一化增益（dB，-9 ~ +9）；null = 关 */
  setNormalizationGain(db: number | null): void {
    if (!this.normGain) return
    if (db === null || !this.settings.normalizationEnabled) {
      this.normGain.gain.setTargetAtTime(1, this.context!.currentTime, 0.02)
      return
    }
    const clamped = Math.max(-9, Math.min(9, db))
    this.normGain.gain.setTargetAtTime(Math.pow(10, clamped / 20), this.context!.currentTime, 0.02)
  }

  /** 播放器把系统音量（0-100）告知引擎；-1 = 未知。频响补偿据此自适应 */
  setSystemVolume(volume: number): void {
    this.systemVolume = volume
    this.applyCompensationGains() // 立即按当前设计/内置近似更新增益（含低音量提示路径）
    // 补偿启用时按音量档位触发重新设计：跨越 ±10% 档位才重新请求，避免拖动音量时频繁请求
    if (this.settings.effects.loudnessCompensation.enabled) {
      const bucket = volume >= 0 ? Math.round(volume / COMPENSATION_VOLUME_RESYNC) * COMPENSATION_VOLUME_RESYNC : 100
      if (this.lastDesignedVolume < 0 || Math.abs(bucket - this.lastDesignedVolume) >= COMPENSATION_VOLUME_RESYNC) {
        this.applyCompensationDesign()
      }
    }
  }

  // ============ 频响补偿：异步设计与内置回退 ============

  /** 设计请求的缓存 key（mode + preset + 音量档位 + custom bands 指纹），同 key 复用不重复请求 */
  private compensationDesignKey(): string {
    const lc = this.settings.effects.loudnessCompensation
    const mode = lc.mode || 'auto'
    const preset = lc.preset || 'flat'
    const bucket = this.systemVolume >= 0
      ? Math.round(this.systemVolume / COMPENSATION_VOLUME_RESYNC) * COMPENSATION_VOLUME_RESYNC
      : 100
    if (mode === 'custom') {
      // custom 模式下音量不参与 key（曲线由 bands 决定）
      return `custom:${JSON.stringify(lc.bands || [])}`
    }
    if (mode === 'preset') return `preset:${preset}`
    return `auto:${Math.max(0, Math.min(100, bucket))}`
  }

  /**
   * 异步设计频响补偿段（补偿启用时才调用）：
   * 向 Python 设计服务请求目标曲线 → 成功后重建 N 段 Biquad 链并应用；
   * 失败/返回 null → 回退内置近似（低架 + 高架按音量算增益）。
   * 幂等 + 防竞态：同 key 不重复请求；请求序号（generation）校验保证
   * 模式/音量变化后旧请求结果不会覆盖新状态。设计结果缓存在引擎内。
   */
  private async applyCompensationDesign(): Promise<void> {
    // 补偿未启用或引擎未就绪时不设计（未启用时不做网络请求）
    if (!this.settings.effects.loudnessCompensation.enabled || !this.context || !this.chain) return
    const key = this.compensationDesignKey()
    if (key === this.lastCompDesignKey) return // 幂等：key 未变化不重复请求
    // 失败重试窗口（30s）：服务不可用时避免反复请求，窗口过后自动重试恢复
    if (this.compDesignFailedAt > 0 && Date.now() - this.compDesignFailedAt < 30_000) return

    const seq = ++this.compDesignSeq // 作废旧请求（模式/音量变化或 dispose 后结果不得应用）
    this.lastCompDesignKey = key
    this.lastDesignedVolume = this.systemVolume >= 0
      ? Math.round(this.systemVolume / COMPENSATION_VOLUME_RESYNC) * COMPENSATION_VOLUME_RESYNC
      : 100
    const lc = this.settings.effects.loudnessCompensation

    try {
      const design = await compensationService.design(lc.mode, lc.preset, this.systemVolume, lc.bands)
      if (seq !== this.compDesignSeq) return // 竞态：已有更新的请求，丢弃旧结果
      if (design && design.segments.length > 0) {
        this.compDesign = design
        this.compDesignFailedAt = 0
      } else {
        // 服务不可用/空设计 → 清除缓存设计，回退内置近似（下次触发时窗口过后重试）
        this.compDesign = null
        this.compDesignFailedAt = Date.now()
      }
      // 按当前设计（或内置近似）重建补偿段并应用增益；补偿此时必然仍启用
      if (this.settings.effects.loudnessCompensation.enabled && this.context && this.chain) {
        this.rebuildEq()
        this.applyCompensationGains()
      }
    } catch {
      if (seq !== this.compDesignSeq) return
      this.compDesign = null
      this.compDesignFailedAt = Date.now()
      if (this.settings.effects.loudnessCompensation.enabled && this.context && this.chain) {
        this.rebuildEq()
        this.applyCompensationGains()
      }
    }
  }

  /** 依据系统音量计算频响补偿增益（等响度近似：音量越低越补低频/高频） */
  private applyCompensationGains(): void {
    if (this.compFilters.length === 0 || !this.context) return
    const t = this.context.currentTime
    // 补偿增益动态平滑：tau=200ms（081402 §6.3 建议 100-500ms），音量/设计变化时平滑过渡
    const tau = COMPENSATION_SMOOTHING_SECONDS
    // 设计结果不可用 → 内置近似：沿用 2 段（低架 120Hz + 高架 12kHz）按音量算增益
    if (!this.compDesign || this.compDesign.segments.length === 0) {
      const { low, high } = builtinCompensationGains(this.systemVolume)
      // 回退链由 rebuildEq 用 BUILTIN_COMP_SEGMENTS（恒 2 段）构建：compFilters[0] 由上面的空长检查保证存在，
      // [1] 用可选链防越界（防御性，正常恒有）
      this.compFilters[0].gain.setTargetAtTime(low, t, tau)
      this.compFilters[1]?.gain.setTargetAtTime(high, t, tau)
      return
    }
    // 应用设计段：段数不匹配时按位置取（重建时 compFilters 已按设计段重建，正常相等）
    for (let i = 0; i < this.compFilters.length && i < this.compDesign.segments.length; i += 1) {
      this.compFilters[i].gain.setTargetAtTime(this.compDesign.segments[i].gain, t, tau)
    }
  }

  // ============ 音频图 ============

  // 音频图就绪后由 useAudioPlayer 调用：在 masterGain 与 analyser 之间插入效果链
  attach(handle: { audioContext: AudioContext; masterGain: GainNode; analyser: AnalyserNode }): void {
    // 幂等守卫：仅在 context 仍有效（未关闭）时提前返回。useAudioPlayer 卸载会 close() 旧 AudioContext
    // 而引擎实例常驻（App.tsx），音频图重建后再次 attach 时必须用传入的新 context 完整重建链；
    // 若此处仍以「this.context 存在」为判断，会命中已关闭的旧上下文而永远接不上新图。
    if (this.context && this.context.state !== 'closed') return // 已附加（且上下文有效）
    const { audioContext: context, masterGain, analyser } = handle
    this.context = context
    this.masterGain = masterGain
    this.analyser = analyser

    // 响度归一化增益（链首：masterGain → normGain → [SoundTouch] → input）
    // 注意：先全断 masterGain 再连接 normGain——若先 connect(normGain) 再 disconnect()，
    // 会把刚连的 normGain 一起断开且不再重连，masterGain 输出为空 → 热切换后无声。
    const normGain = context.createGain()
    normGain.gain.value = 1
    this.normGain = normGain
    masterGain.disconnect()
    masterGain.connect(normGain)

    // 效果链
    const chain = buildEffectChain(context, this.settings)
    this.chain = chain
    this.input = chain.input
    this.output = chain.output
    // IR 已由 buildEffectChain 按当前设置生成，先记录指纹，避免随后 rebuildFromSettings 重复重建
    this.lastIrKey = `${this.settings.effects.hall.type}|${this.settings.effects.hall.preDelay}|${this.settings.effects.hall.decay}`

    // 输出保护
    this.limiter = context.createDynamicsCompressor()
    this.limiter.threshold.value = -6
    this.limiter.knee.value = 12
    this.limiter.ratio.value = 12
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.25

    chain.output.connect(this.limiter)
    this.limiter.connect(analyser)

    // 重连 normGain → 引擎 input（masterGain → normGain 已在链首 connect，勿再 disconnect）
    normGain.connect(this.input)

    // 异步注册 SoundTouch（变调/变速），成功后插入到 normGain 与 input 之间
    void this.initSoundtouch(context, normGain, this.input)

    // 应用当前设置
    this.rebuildFromSettings()

    // 补偿已启用时异步设计补偿段（N 段 Biquad 链）；重建发生在恢复音量之后，
    // 避免音量恢复（设置满音量）到补偿启用这一小窗口内设计请求叠加
    this.applyCompensationDesign()

    debugLog('[AudioEffects] 效果链已插入 masterGain 与 analyser 之间')
  }

  private async initSoundtouch(context: AudioContext, prevNode: AudioNode, input: GainNode): Promise<void> {
    try {
      await SoundTouchNode.register(context, processorUrl)
      // 竞态防护：await 期间引擎可能已被 dispose 或重新 attach（热切换 v1/v2、重启音频图）。
      // 此时必须放弃接线，否则会把旧节点插进已废弃的图，且 this.soundtouchNode 指向失联节点
      // （后完成的旧注册会覆盖新注册，导致变调/变速对实时音频无效）。
      if (this.context !== context) return
      const node = new SoundTouchNode({ context, outputChannelCount: 2 })
      this.soundtouchNode = node
      prevNode.disconnect()
      prevNode.connect(node)
      node.connect(input)
      this.applyPitchSettings()
      debugLog('[AudioEffects] SoundTouch 已就绪（变调/变速可用）')
    } catch (error) {
      console.warn('[AudioEffects] SoundTouch 注册失败，变调/变速不可用:', error)
      this.soundtouchNode = null
    }
  }

  private applyPitchSettings(): void {
    if (!this.soundtouchNode || !this.context) return
    const t = this.context.currentTime
    this.soundtouchNode.pitchSemitones.setTargetAtTime(this.settings.pitch.semitones, t, 0.02)
    this.soundtouchNode.playbackRate.setTargetAtTime(this.settings.pitch.rate, t, 0.02)
  }

  dispose(): void {
    this.stopSurroundRotation()
    if (this.context && this.masterGain && this.analyser) {
      try {
        // 全断 + 摘除本引擎插过的节点（soundtouch / limiter），再恢复 masterGain→analyser 直连。
        // 切换引擎时旧链必须彻底拆除，否则两套效果链并联打架。
        this.masterGain.disconnect()
        try { this.soundtouchNode?.disconnect() } catch { /* noop */ }
        try { this.limiter?.disconnect() } catch { /* noop */ }
        this.masterGain.connect(this.analyser)
      } catch {
        // 忽略重连失败
      }
    }
    this.context = null
    this.input = null
    this.output = null
    this.masterGain = null
    this.analyser = null
    this.normGain = null
    this.chain = null
    // 清空异步注册的 SoundTouch 引用与 IR 指纹，避免 dispose 后旧节点残留
    this.soundtouchNode = null
    this.limiter = null
    this.lastIrKey = ''
    // EQ / 频响补偿的动态滤波器组独立于 chain 字段持有：先断链再清空，让节点可被 GC 回收
    for (const f of this.eqFilters) {
      try { f.disconnect() } catch { /* noop */ }
    }
    this.eqFilters = []
    for (const f of this.compFilters) {
      try { f.disconnect() } catch { /* noop */ }
    }
    this.compFilters = []
    // 作废在途补偿设计请求：dispose 后旧结果不得应用（await 竞态防护）
    this.compDesignSeq++
    this.compDesign = null
    this.lastCompDesignKey = ''
    this.lastDesignedVolume = -1
    this.compDesignFailedAt = 0
  }

  // 依据 settings 重建所有可调参数（幂等，安全重复调用）
  private rebuildFromSettings(): void {
    if (!this.context || !this.chain) return
    const t = this.context.currentTime
    const { effects, eq, pitch } = this.settings

    // 人声/伴奏比例：center=人声(中)，side=伴奏(侧)
    const voiceMatrix = this.chain.voiceMatrix
    const v = Math.max(-1, Math.min(1, pitch.voiceBalance))
    const center = v >= 0 ? 1 : 1 + v // v<0 时削弱人声
    const side = v <= 0 ? 1 : 1 - v // v>0 时削弱伴奏
    voiceMatrix.centerGain.gain.setTargetAtTime(center, t, 0.02)
    voiceMatrix.sideGain.gain.setTargetAtTime(side, t, 0.02)

    // 人声/伴奏增强（M/S：人声=中置、伴奏=侧置）
    const presenceMatrix = this.chain.presenceMatrix
    const vocalCenter = effects.vocalBoost.enabled ? 1 + effects.vocalBoost.intensity * 0.08 : 1
    const accompSide = effects.accompanimentBoost.enabled ? 1 + effects.accompanimentBoost.intensity * 0.22 : 1
    const accompCenter = effects.accompanimentBoost.enabled ? 1 - effects.accompanimentBoost.intensity * 0.1 : 1
    presenceMatrix.centerGain.gain.setTargetAtTime(Math.max(0.25, vocalCenter * accompCenter), t, 0.03)
    presenceMatrix.sideGain.gain.setTargetAtTime(accompSide, t, 0.03)

    // 低音增强（lowshelf + 次低频 punch 共振）
    this.chain.bassFilter.frequency.setTargetAtTime(effects.bassBoost.depth, t, 0.02)
    this.chain.bassFilter.gain.setTargetAtTime(effects.bassBoost.enabled ? effects.bassBoost.intensity * 1.3 : 0, t, 0.02)
    this.chain.bassPunchFilter.gain.setTargetAtTime(effects.bassBoost.enabled ? effects.bassBoost.intensity * 0.55 : 0, t, 0.02)

    // 人声加强：窄带 3kHz 存在感提升（Q=2.4，聚焦人声、不误伤吉他），增益克制避免破音
    this.chain.vocalFilter.gain.setTargetAtTime(effects.vocalBoost.enabled ? effects.vocalBoost.intensity * 0.7 : 0, t, 0.02)

    // 伴奏加强：削减人声频段（更窄、更克制），主要靠侧声道增强放大伴奏
    this.chain.accompFilter.gain.setTargetAtTime(effects.accompanimentBoost.enabled ? -effects.accompanimentBoost.intensity * 0.7 : 0, t, 0.02)

    // 动态压缩
    const comp = this.chain.compressor
    comp.threshold.setTargetAtTime(effects.compressor.enabled ? effects.compressor.threshold : 0, t, 0.02)
    comp.ratio.setTargetAtTime(effects.compressor.enabled ? effects.compressor.ratio : 1, t, 0.02)
    comp.attack.setTargetAtTime(effects.compressor.attack, t, 0.02)
    comp.release.setTargetAtTime(effects.compressor.release, t, 0.02)
    // 输出增益（makeup）：压缩会压低电平，补偿回来
    const compMakeup = effects.compressor.enabled ? effects.compressor.outputGain : 0
    compressorMakeupGain(comp)?.setTargetAtTime(Math.pow(10, compMakeup / 20), t, 0.02)

    // 夜间模式：软限幅曲线 + 输出增益
    // 夜间模式（重设计）：温和动态压缩 + 高频衰减，深夜低音量舒适不炸音
    const nightOn = effects.nightMode.enabled && effects.nightMode.amount > 0
    const amount = effects.nightMode.enabled ? effects.nightMode.amount : 0
    // 压缩强度随 amount（1-10）线性：threshold -24→-32、ratio 2.5→5
    const nightComp = this.chain.nightCompressor
    nightComp.threshold.setTargetAtTime(nightOn ? -24 - amount * 0.8 : 0, t, 0.05)
    nightComp.ratio.setTargetAtTime(nightOn ? 2.5 + amount * 0.25 : 1, t, 0.05)
    // 高频衰减：-2 ~ -6dB 随强度（夜间刺耳高频收敛）
    this.chain.nightTreble.gain.setTargetAtTime(nightOn ? -(1.5 + amount * 0.45) : 0, t, 0.05)
    // 夜间 shapler 恒直通（不再做波形整形，避免谐波失真炸音）
    this.chain.nightShaper.curve = null
    // 压缩会损失响度，给少量克制补偿（最高 ~1.12x），不抬过载
    const nightBoost = nightOn ? 1 + amount * 0.012 : 1
    this.chain.nightGain.gain.setTargetAtTime(nightBoost, t, 0.05)

    // 全景声厅：声场加宽（1-10 级）+ 混响（0-10）+ 类型化 IR
    const hall = this.chain.hallMatrix
    const level = effects.hall.enabled ? effects.hall.level : 0
    const reverb = effects.hall.enabled ? effects.hall.reverb : 0
    const sideGain = 1 + (level / 10) * 2.2
    const centerGain = 1 - (level / 10) * 0.42
    hall.sideGain.gain.setTargetAtTime(sideGain, t, 0.03)
    hall.centerGain.gain.setTargetAtTime(Math.max(0.4, centerGain), t, 0.03)
    this.chain.hallWetGain.gain.setTargetAtTime(Math.min(1, reverb / 10) * 0.95, t, 0.05)
    // 混响类型/预延迟/衰减变化时重建 IR；参数未变则复用现有 buffer
    const irKey = `${effects.hall.type}|${effects.hall.preDelay}|${effects.hall.decay}`
    if (irKey !== this.lastIrKey) {
      this.chain.hallConvolver.buffer = generateReverbImpulseResponse(this.context, effects.hall.type, effects.hall.preDelay, effects.hall.decay)
      this.lastIrKey = irKey
    }

    // 3D 环绕
    this.chain.pannerWetGain.gain.setTargetAtTime(effects.surround3d.enabled ? 1 : 0, t, 0.03)
    this.chain.pannerDryGain.gain.setTargetAtTime(effects.surround3d.enabled ? 0 : 1, t, 0.03)
    this.syncSurroundRotation()

    // 变调/变速
    this.applyPitchSettings()

    // 均衡器 / 频响补偿（二选一）
    this.rebuildEq()

    // 响度归一化增益：开启时完全由 setNormalizationGain 按曲目 LUFS 控制，
    // 这里不再重复写入——原实现对开启分支把目标重设为「当前瞬时值」，
    // 会截断 setNormalizationGain 正在进行的增益过渡（如切歌后 60s 测量完成时恰逢设置变更）。
    // 仅关闭时平滑回落到原声（1）。
    if (this.normGain && !this.settings.normalizationEnabled) {
      this.normGain.gain.setTargetAtTime(1, t, 0.02)
    }
  }

  /** 重建 EQ 段；频响补偿启用时替换为补偿滤波器组（互斥，见 ADR-0002） */
  private rebuildEq(): void {
    if (!this.context || !this.chain) return
    const { eq, effects } = this.settings

    // 清理旧滤波器
    for (const f of this.eqFilters) {
      try { f.disconnect() } catch { /* noop */ }
    }
    this.eqFilters = []
    for (const f of this.compFilters) {
      try { f.disconnect() } catch { /* noop */ }
    }
    this.compFilters = []

    const presenceMatrix = this.chain.presenceMatrix
    presenceMatrix.output.disconnect()

    // 频响补偿优先：与 EQ 互斥
    if (effects.loudnessCompensation.enabled) {
      // 设计结果可用 → 按设计段构建 N 段 Biquad 链；否则内置近似 2 段
      const segments = this.compDesign && this.compDesign.segments.length > 0
        ? this.compDesign.segments
        : BUILTIN_COMP_SEGMENTS
      let prev: AudioNode = presenceMatrix.output
      for (const seg of segments) {
        const filter = this.context.createBiquadFilter()
        filter.type = seg.type
        filter.frequency.value = seg.frequency
        filter.Q.value = seg.q
        filter.gain.value = seg.gain
        prev.connect(filter)
        this.compFilters.push(filter)
        prev = filter
      }
      // 空设计段（理论不会走到：内置近似恒有 2 段）→ 直连
      if (this.compFilters.length === 0) {
        presenceMatrix.output.connect(this.chain.bassFilter)
      } else {
        prev.connect(this.chain.bassFilter)
      }
      this.applyCompensationGains()
      return
    }

    if (!eq.enabled) {
      presenceMatrix.output.connect(this.chain.bassFilter)
      return
    }

    const bands = eq.mode === 'simple'
      ? SIMPLE_EQ_BANDS.map((band, i) => ({ frequency: band.frequency, gain: eq.simpleBands[i] || 0, q: 1.0 }))
      : eq.proBands

    let prev: AudioNode = presenceMatrix.output
    for (const band of bands) {
      const filter = this.context.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = band.frequency
      filter.gain.value = band.gain
      filter.Q.value = band.q
      prev.connect(filter)
      this.eqFilters.push(filter)
      prev = filter
    }
    prev.connect(this.chain.bassFilter)
  }

  private syncSurroundRotation(): void {
    const enabled = this.settings.effects.surround3d.enabled
    if (enabled) {
      this.startSurroundRotation()
    } else {
      this.stopSurroundRotation()
    }
  }

  private startSurroundRotation(): void {
    if (this.surroundAnimationFrame) return
    this.surroundLastTime = performance.now()
    const tick = (now: number) => {
      if (!this.chain?.panner || !this.settings.effects.surround3d.enabled) {
        this.surroundAnimationFrame = 0
        return
      }
      // 限 60fps：环绕旋转缓慢且 setTargetAtTime 带 30ms 平滑，高刷屏无需逐帧驱动
      if (now - this.surroundLastTime < 1000 / 60) {
        this.surroundAnimationFrame = requestAnimationFrame(tick)
        return
      }
      const dt = Math.min(0.1, (now - this.surroundLastTime) / 1000)
      this.surroundLastTime = now
      const speed = this.settings.effects.surround3d.speed
      const direction = this.settings.effects.surround3d.direction
      const baseAngle = this.settings.effects.surround3d.angle * Math.PI / 180
      const radius = 0.6 + this.settings.effects.surround3d.distance * 0.95
      this.surroundAngle += dt * speed * 2.6 * direction
      const a = this.surroundAngle + baseAngle
      const x = Math.sin(a) * radius
      const z = Math.cos(a) * radius
      const p = this.chain.panner
      if (p.positionX) {
        p.positionX.setTargetAtTime(x, this.context!.currentTime, 0.03)
        p.positionZ.setTargetAtTime(z, this.context!.currentTime, 0.03)
        p.positionY.setTargetAtTime(0, this.context!.currentTime, 0.03)
      }
      this.surroundAnimationFrame = requestAnimationFrame(tick)
    }
    this.surroundAnimationFrame = requestAnimationFrame(tick)
  }

  private stopSurroundRotation(): void {
    if (this.surroundAnimationFrame) {
      cancelAnimationFrame(this.surroundAnimationFrame)
      this.surroundAnimationFrame = 0
    }
  }

  /**
   * 把当前音效（效果链 + EQ）离线渲染成 WAV 并下载。
   * 离线链与实时链共享 buildEffectChain（ADR-0003），不再漂移。
   * 说明：这是个人处理用途，涉及版权曲目请勿分发。
   */
  async exportToWav(sourceUrl: string, durationSeconds: number): Promise<void> {
    if (!this.context) throw new Error('音频引擎尚未就绪')
    const sampleRate = this.context.sampleRate

    // 1. 拉取并解码源音频
    const response = await fetch(sourceUrl)
    if (!response.ok) throw new Error(`拉取音频失败：${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    const decoded = await this.context.decodeAudioData(arrayBuffer)

    // 2. 离线渲染长度（至少 1 秒，最长不超过源长度）。
    // 下限用 min(1s, 源长度)，避免 durationSeconds 缺失/为 0 时导出近乎空的 1 采样 WAV。
    const minLen = Math.min(sampleRate, decoded.length)
    const length = Math.max(minLen, Math.min(Math.floor(durationSeconds * sampleRate), decoded.length))

    const offline = new OfflineAudioContext(2, length, sampleRate)
    const source = offline.createBufferSource()
    source.buffer = decoded

    // 3. 共享构建效果链（与实时链同一实现，参数来自当前设置）
    const chain = buildEffectChain(offline, this.settings)
    source.connect(chain.input)
    chain.output.connect(offline.destination)

    // 4. 与实时链一致的动态参数（幂等，与 rebuildFromSettings 同步）
    const { effects } = this.settings
    chain.bassFilter.frequency.value = effects.bassBoost.depth // 低音起始频率与实时链同步（缺此导出停留在默认 350Hz）
    chain.bassFilter.gain.value = effects.bassBoost.enabled ? effects.bassBoost.intensity * 1.3 : 0
    chain.bassPunchFilter.gain.value = effects.bassBoost.enabled ? effects.bassBoost.intensity * 0.55 : 0
    chain.vocalFilter.gain.value = effects.vocalBoost.enabled ? effects.vocalBoost.intensity * 0.7 : 0
    chain.accompFilter.gain.value = effects.accompanimentBoost.enabled ? -effects.accompanimentBoost.intensity * 0.7 : 0

    const voiceMatrix = chain.voiceMatrix
    const v = Math.max(-1, Math.min(1, this.settings.pitch.voiceBalance))
    voiceMatrix.centerGain.gain.value = v >= 0 ? 1 : 1 + v
    voiceMatrix.sideGain.gain.value = v <= 0 ? 1 : 1 - v

    const presenceMatrix = chain.presenceMatrix
    presenceMatrix.centerGain.gain.value = Math.max(0.25,
      (effects.vocalBoost.enabled ? 1 + effects.vocalBoost.intensity * 0.08 : 1)
      * (effects.accompanimentBoost.enabled ? 1 - effects.accompanimentBoost.intensity * 0.1 : 1))
    presenceMatrix.sideGain.gain.value = effects.accompanimentBoost.enabled ? 1 + effects.accompanimentBoost.intensity * 0.22 : 1

    const comp = chain.compressor
    comp.threshold.value = effects.compressor.enabled ? effects.compressor.threshold : 0
    comp.ratio.value = effects.compressor.enabled ? effects.compressor.ratio : 1
    const makeup = compressorMakeupGain(comp)
    if (makeup) makeup.value = Math.pow(10, (effects.compressor.enabled ? effects.compressor.outputGain : 0) / 20)

    // 夜间模式（与实时链一致）：动态压缩 + 高频衰减，shapler 恒直通
    const nightOn = effects.nightMode.enabled && effects.nightMode.amount > 0
    const nightAmount = effects.nightMode.enabled ? effects.nightMode.amount : 0
    chain.nightShaper.curve = null
    chain.nightCompressor.threshold.value = nightOn ? -24 - nightAmount * 0.8 : 0
    chain.nightCompressor.ratio.value = nightOn ? 2.5 + nightAmount * 0.25 : 1
    chain.nightTreble.gain.value = nightOn ? -(1.5 + nightAmount * 0.45) : 0
    chain.nightGain.gain.value = nightOn ? 1 + nightAmount * 0.012 : 1

    chain.hallWetGain.gain.value = effects.hall.enabled ? Math.min(1, effects.hall.reverb / 10) * 0.95 : 0
    chain.hallMatrix.sideGain.gain.value = effects.hall.enabled ? 1 + (effects.hall.level / 10) * 2.2 : 1
    chain.hallMatrix.centerGain.gain.value = effects.hall.enabled ? Math.max(0.4, 1 - (effects.hall.level / 10) * 0.42) : 1

    // 3D 环绕（与 rebuildFromSettings 同步：干/湿增益 + 初始环绕位置）
    chain.pannerWetGain.gain.value = effects.surround3d.enabled ? 1 : 0
    chain.pannerDryGain.gain.value = effects.surround3d.enabled ? 0 : 1
    const radius = 0.6 + effects.surround3d.distance * 0.95
    const baseAngle = effects.surround3d.angle * Math.PI / 180
    if (chain.panner.positionX) {
      chain.panner.positionX.value = Math.sin(baseAngle) * radius
      chain.panner.positionZ.value = Math.cos(baseAngle) * radius
      chain.panner.positionY.value = 0
    }

    // 5. EQ / 频响补偿（与 rebuildEq 相同的二选一）
    const eq = this.settings.eq
    if (effects.loudnessCompensation.enabled) {
      // 离线渲染是同步流程：应用引擎内已缓存的设计（不重新请求网络）；
      // 无设计结果时回退内置近似（低架 + 高架按音量算增益）
      const segments = this.compDesign && this.compDesign.segments.length > 0
        ? this.compDesign.segments
        : BUILTIN_COMP_SEGMENTS
      // 内置近似段的增益按系统音量估算（离线导出时音量不可知，沿用实时链逻辑）
      const gains = segments === BUILTIN_COMP_SEGMENTS ? builtinCompensationGains(this.systemVolume) : null
      presenceMatrix.output.disconnect()
      let prev: AudioNode = presenceMatrix.output
      for (let i = 0; i < segments.length; i += 1) {
        const seg = segments[i]
        const f = offline.createBiquadFilter()
        f.type = seg.type
        f.frequency.value = seg.frequency
        f.gain.value = gains ? (i === 0 ? gains.low : i === 1 ? gains.high : seg.gain) : seg.gain
        f.Q.value = seg.q
        prev.connect(f)
        prev = f
      }
      prev.connect(chain.bassFilter)
    } else if (eq.enabled) {
      const bands = eq.mode === 'simple'
        ? SIMPLE_EQ_BANDS.map((band, i) => ({ frequency: band.frequency, gain: eq.simpleBands[i] || 0, q: 1.0 }))
        : eq.proBands
      presenceMatrix.output.disconnect()
      let prev: AudioNode = presenceMatrix.output
      for (const band of bands) {
        const f = offline.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = band.frequency
        f.gain.value = band.gain
        f.Q.value = band.q
        prev.connect(f)
        prev = f
      }
      prev.connect(chain.bassFilter)
    }

    // 显式限定源播放区间为导出时长：即使 OfflineAudioContext 长度已经截断，
    // 也避免解码后的整曲 buffer 在渲染循环中被无谓读取/混音。
    source.start(0, 0, length / sampleRate)
    const rendered = await offline.startRendering()

    // 6. 编码为 WAV 并下载
    const wavBlob = encodeWav(rendered)
    const url = URL.createObjectURL(wavBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = `waveforge-mix-${Date.now()}.wav`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}
