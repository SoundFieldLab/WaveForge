import { debugLog } from '../../utils/debugLog'
import { SoundTouchNode } from '@soundtouchjs/audio-worklet'
import processorUrl from '@soundtouchjs/audio-worklet/processor?url'

// ============ 设置类型 ============

export type EqMode = 'simple' | 'pro'

export interface CloudEffectsSettings {
  hall: { enabled: boolean; level: number; reverb: number } // 全景声厅：声场 1-10 + 混响 0-10
  surround3d: { enabled: boolean; distance: number; speed: number; angle: number; direction: 1 | -1 } // 3D 环绕
  bassBoost: { enabled: boolean; depth: number; intensity: number } // 低音增强
  vocalBoost: { enabled: boolean; intensity: number } // 人声加强
  accompanimentBoost: { enabled: boolean; intensity: number } // 伴奏加强
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

const SETTINGS_KEY = 'waveforge:audio-effects-settings'

function defaultSettings(): AudioEffectsSettings {
  return {
    effects: {
      hall: { enabled: false, level: 5, reverb: 5 },
      surround3d: { enabled: false, distance: 5, speed: 1, angle: 0, direction: 1 },
      bassBoost: { enabled: false, depth: 100, intensity: 6 },
      vocalBoost: { enabled: false, intensity: 4 },
      accompanimentBoost: { enabled: false, intensity: 4 },
    },
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
    }
  } catch {
    return defaults
  }
}

// ============ 工具函数 ============

// 生成一个接近真实大厅的立体声脉冲响应：
// - 预延迟（pre-delay）
// - 早期反射（若干离散回声，营造房间轮廓）
// - 晚期反射（左右去相关的噪声，经一阶低通让高频随尾音自然衰减）
function generateHallImpulseResponse(context: BaseAudioContext, seconds = 3.6, decay = 2.2): AudioBuffer {
  const sampleRate = context.sampleRate
  const length = Math.max(1, Math.floor(sampleRate * seconds))
  const buffer = context.createBuffer(2, length, sampleRate)
  const preDelaySamples = Math.floor(sampleRate * 0.018)

  // 早期反射：不同延迟与衰减的离散回声（左右略有差异，增加空间感）
  const earlyReflections = [
    { delay: 0.010, gain: 0.55 },
    { delay: 0.022, gain: 0.42 },
    { delay: 0.035, gain: 0.34 },
    { delay: 0.051, gain: 0.26 },
    { delay: 0.068, gain: 0.2 },
    { delay: 0.087, gain: 0.15 },
    { delay: 0.108, gain: 0.11 },
  ]

  for (let ch = 0; ch < 2; ch += 1) {
    const data = buffer.getChannelData(ch)
    const sideScale = ch === 0 ? 1 : 0.92 // 左右早期反射略有差异

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
      lp += 0.16 * (white - lp)
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
function createMsMatrix(context: AudioContext): MsMatrix {
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

// ============ 引擎 ============

export class AudioEffectsEngine {
  private context: AudioContext | null = null
  private masterGain: GainNode | null = null
  private analyser: AnalyserNode | null = null

  // 附着代次：每次 attach/dispose 递增，供异步 initSoundtouch 在 await 之后回查自身是否仍有效
  private attachSeq = 0

  private input: GainNode | null = null
  private output: GainNode | null = null

  // 变调/变速（SoundTouch AudioWorklet，异步注册）
  private soundtouchNode: SoundTouchNode | null = null

  // 人声/伴奏比例（M/S 矩阵）
  private voiceMatrix: MsMatrix | null = null

  // 全景声厅：M/S 加宽 + 卷积混响
  private hallMatrix: MsMatrix | null = null
  private hallConvolver: ConvolverNode | null = null
  private hallWetGain: GainNode | null = null

  // 3D 环绕
  private panner: PannerNode | null = null
  private pannerWetGain: GainNode | null = null
  private pannerDryGain: GainNode | null = null
  private surroundAnimationFrame = 0
  private surroundAngle = 0
  private surroundLastTime = 0

  // 低音/人声/伴奏（滤波类，串行，关掉时增益归零即透明）
  private bassFilter: BiquadFilterNode | null = null
  private bassPunchFilter: BiquadFilterNode | null = null
  private vocalFilter: BiquadFilterNode | null = null
  private accompFilter: BiquadFilterNode | null = null

  // 人声/伴奏增强的 M/S 矩阵（人声=中置声道，伴奏=侧声道）
  private presenceMatrix: MsMatrix | null = null

  // 均衡器
  private eqFilters: BiquadFilterNode[] = []

  // 输出保护
  private limiter: DynamicsCompressorNode | null = null

  private settings: AudioEffectsSettings = loadSettings()

  getSettings(): AudioEffectsSettings {
    return this.settings
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings))
    } catch {
      // 忽略存储失败
    }
  }

  // 供 UI 一次性导入完整设置（预设导入/恢复）
  applySettings(next: AudioEffectsSettings): void {
    this.settings = next
    this.saveSettings()
    this.rebuildFromSettings()
  }

  updateSettings(patch: DeepPartial<AudioEffectsSettings>): void {
    this.settings = {
      ...this.settings,
      effects: { ...this.settings.effects, ...(patch.effects || {}) } as CloudEffectsSettings,
      eq: { ...this.settings.eq, ...(patch.eq || {}) } as EqSettings,
      pitch: { ...this.settings.pitch, ...(patch.pitch || {}) } as PitchSettings,
    }
    this.saveSettings()
    this.rebuildFromSettings()
  }

  // 激活某个音效（互斥：同时只能开一个），传 null 关闭全部
  activateEffect(key: keyof CloudEffectsSettings | null): void {
    const effects: CloudEffectsSettings = {
      hall: { ...this.settings.effects.hall, enabled: key === 'hall' },
      surround3d: { ...this.settings.effects.surround3d, enabled: key === 'surround3d' },
      bassBoost: { ...this.settings.effects.bassBoost, enabled: key === 'bassBoost' },
      vocalBoost: { ...this.settings.effects.vocalBoost, enabled: key === 'vocalBoost' },
      accompanimentBoost: { ...this.settings.effects.accompanimentBoost, enabled: key === 'accompanimentBoost' },
    }
    this.updateSettings({ effects })
  }

  // 音频图就绪后由 useAudioPlayer 调用：在 masterGain 与 analyser 之间插入效果链
  attach(handle: { audioContext: AudioContext; masterGain: GainNode; analyser: AnalyserNode }): void {
    // 幂等守卫：仅在 context 仍有效（未关闭）时提前返回。useAudioPlayer 卸载会 close() 旧 AudioContext
    // 而引擎实例常驻（App.tsx），音频图重建后再次 attach 时必须用传入的新 context 完整重建链；
    // 若此处仍以「this.context 存在」为判断，会命中已关闭的旧上下文而永远接不上新图。
    if (this.context && this.context.state !== 'closed') return // 已附加（且上下文有效）
    this.attachSeq += 1
    const { audioContext: context, masterGain, analyser } = handle
    this.context = context
    this.masterGain = masterGain
    this.analyser = analyser

    const input = context.createGain()
    const output = context.createGain()
    input.gain.value = 1
    output.gain.value = 1
    this.input = input
    this.output = output

    // 人声/伴奏比例 M/S 矩阵
    this.voiceMatrix = createMsMatrix(context)

    // 人声/伴奏增强 M/S 矩阵（人声=中置、伴奏=侧置）
    this.presenceMatrix = createMsMatrix(context)

    // 全景声厅
    this.hallMatrix = createMsMatrix(context)
    this.hallConvolver = context.createConvolver()
    this.hallConvolver.buffer = generateHallImpulseResponse(context)
    this.hallWetGain = context.createGain()
    this.hallWetGain.gain.value = 0

    // 3D 环绕
    this.panner = context.createPanner()
    this.panner.panningModel = 'HRTF'
    this.panner.distanceModel = 'inverse'
    this.pannerWetGain = context.createGain()
    this.pannerWetGain.gain.value = 0
    this.pannerDryGain = context.createGain()
    this.pannerDryGain.gain.value = 1

    // 音色类效果
    this.bassFilter = context.createBiquadFilter()
    this.bassFilter.type = 'lowshelf'
    this.bassFilter.gain.value = 0
    this.bassPunchFilter = context.createBiquadFilter()
    this.bassPunchFilter.type = 'peaking'
    this.bassPunchFilter.frequency.value = 55
    this.bassPunchFilter.Q.value = 0.9
    this.bassPunchFilter.gain.value = 0
    this.vocalFilter = context.createBiquadFilter()
    this.vocalFilter.type = 'peaking'
    this.vocalFilter.frequency.value = 3000
    this.vocalFilter.Q.value = 2.4
    this.vocalFilter.gain.value = 0
    this.accompFilter = context.createBiquadFilter()
    this.accompFilter.type = 'peaking'
    this.accompFilter.frequency.value = 2800
    this.accompFilter.Q.value = 1.6
    this.accompFilter.gain.value = 0

    // 均衡器：简约 5 段 / 专业 10 段都基于同一组 biquad，按 mode 重建
    this.eqFilters = []

    // 输出保护
    this.limiter = context.createDynamicsCompressor()
    this.limiter.threshold.value = -6
    this.limiter.knee.value = 12
    this.limiter.ratio.value = 12
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.25

    // 串起固定骨架：
    // input → voiceMatrix → bass → vocal → accomp → hallDry(hallMatrix) → 3D dry → output
    //                                     → hallWet(convolver) ─┐
    //                                     → 3D wet(panner) ─────┴→ output
    input.connect(this.voiceMatrix.input)
    this.voiceMatrix.output.connect(this.presenceMatrix.input)
    this.presenceMatrix.output.connect(this.bassFilter)
    this.bassFilter.connect(this.bassPunchFilter)
    this.bassPunchFilter.connect(this.vocalFilter)
    this.vocalFilter.connect(this.accompFilter)

    // 全景声厅干湿两路（从 accompFilter 之后分叉）
    this.accompFilter.connect(this.hallMatrix.input) // 干路（内部做加宽）
    this.hallMatrix.output.connect(this.pannerDryGain)
    this.accompFilter.connect(this.hallConvolver) // 湿路（混响）
    this.hallConvolver.connect(this.hallWetGain)
    this.hallWetGain.connect(this.pannerDryGain)

    // 3D 环绕干湿
    this.pannerDryGain.connect(output)
    // 湿路（HRTF 环绕）必须从干路信号源直接分叉，不能挂在 pannerDryGain 上——
    // 否则 3D 环绕启用时 pannerDryGain 增益降到 0，panner 的输入同样为 0，
    // 干湿两路全部静音，音乐会完全无声。
    this.hallMatrix.output.connect(this.panner)
    this.panner.connect(this.pannerWetGain)
    this.pannerWetGain.connect(output)

    output.connect(this.limiter)
    this.limiter.connect(analyser)

    // 重连：masterGain → 引擎 input（analyser 已由引擎 output 接入；先全断，切换引擎时幂等安全）
    masterGain.disconnect()
    masterGain.connect(input)

    // 异步注册 SoundTouch（变调/变速），成功后插入到 masterGain 与 input 之间
    void this.initSoundtouch(context, masterGain, input)

    // 应用当前设置
    this.rebuildFromSettings()

    debugLog('[AudioEffects] 效果链已插入 masterGain 与 analyser 之间')
  }

  private async initSoundtouch(context: AudioContext, masterGain: GainNode, input: GainNode): Promise<void> {
    const seq = this.attachSeq // 记录本次附着的代次，await 之后校验
    try {
      await SoundTouchNode.register(context, processorUrl)
      // 异步注册期间可能已 dispose / 已切换引擎（甚至切换后又重新 attach 到同一张图）：
      // 用「上下文引用 + 附着代次」双重校验，不过即放弃接线——否则旧链的 soundtouch 会
      // 插回 masterGain，与当前效果链并联打架，或把声音路由进已拆除的死节点导致整段无声。
      if (this.context !== context || this.masterGain !== masterGain || this.attachSeq !== seq) {
        this.soundtouchNode = null
        return
      }
      const node = new SoundTouchNode({ context, outputChannelCount: 2 })
      this.soundtouchNode = node
      masterGain.disconnect()
      masterGain.connect(node)
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
    this.attachSeq += 1 // 作废在途的异步 initSoundtouch，防止其晚到重新接线
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
    // 释放全部节点字段引用（先断链再置空），让旧效果链可被 GC 回收——
    // 含大 IR AudioBuffer 的 hallConvolver、panner、各 M/S 矩阵与滤波器。
    for (const filter of this.eqFilters) {
      try { filter.disconnect() } catch { /* noop */ }
    }
    this.eqFilters = []
    this.soundtouchNode = null
    this.voiceMatrix = null
    this.hallMatrix = null
    this.hallConvolver = null
    this.hallWetGain = null
    this.panner = null
    this.pannerWetGain = null
    this.pannerDryGain = null
    this.bassFilter = null
    this.bassPunchFilter = null
    this.vocalFilter = null
    this.accompFilter = null
    this.presenceMatrix = null
    this.limiter = null
    this.context = null
    this.input = null
    this.output = null
    this.masterGain = null
    this.analyser = null
  }

  // 依据 settings 重建所有可调参数（幂等，安全重复调用）
  private rebuildFromSettings(): void {
    if (!this.context) return
    const t = this.context.currentTime
    const { effects, eq, pitch } = this.settings

    // 人声/伴奏比例：center=人声(中)，side=伴奏(侧)
    if (this.voiceMatrix) {
      const v = Math.max(-1, Math.min(1, pitch.voiceBalance))
      const center = v >= 0 ? 1 : 1 + v // v<0 时削弱人声
      const side = v <= 0 ? 1 : 1 - v // v>0 时削弱伴奏
      this.voiceMatrix.centerGain.gain.setTargetAtTime(center, t, 0.02)
      this.voiceMatrix.sideGain.gain.setTargetAtTime(side, t, 0.02)
    }

    // 人声/伴奏增强（M/S：人声=中置、伴奏=侧置）
    if (this.presenceMatrix) {
      // 人声加强：中置声道适度增强（避免连带把吉他/低频一起放大），配合窄带存在感
      const vocalCenter = effects.vocalBoost.enabled ? 1 + effects.vocalBoost.intensity * 0.08 : 1
      // 伴奏加强：侧置声道明显增强（真正放大伴奏），同时压低中置
      const accompSide = effects.accompanimentBoost.enabled ? 1 + effects.accompanimentBoost.intensity * 0.22 : 1
      const accompCenter = effects.accompanimentBoost.enabled ? 1 - effects.accompanimentBoost.intensity * 0.1 : 1
      this.presenceMatrix.centerGain.gain.setTargetAtTime(Math.max(0.25, vocalCenter * accompCenter), t, 0.03)
      this.presenceMatrix.sideGain.gain.setTargetAtTime(accompSide, t, 0.03)
    }

    // 低音增强（lowshelf + 次低频 punch 共振）
    if (this.bassFilter && this.bassPunchFilter) {
      this.bassFilter.frequency.setTargetAtTime(effects.bassBoost.depth, t, 0.02)
      this.bassFilter.gain.setTargetAtTime(effects.bassBoost.enabled ? effects.bassBoost.intensity * 1.3 : 0, t, 0.02)
      this.bassPunchFilter.gain.setTargetAtTime(effects.bassBoost.enabled ? effects.bassBoost.intensity * 0.55 : 0, t, 0.02)
    }

    // 人声加强：窄带 3kHz 存在感提升（Q=2.4，聚焦人声、不误伤吉他），增益克制避免破音
    if (this.vocalFilter) {
      this.vocalFilter.gain.setTargetAtTime(effects.vocalBoost.enabled ? effects.vocalBoost.intensity * 0.7 : 0, t, 0.02)
    }

    // 伴奏加强：削减人声频段（更窄、更克制），主要靠侧声道增强放大伴奏
    if (this.accompFilter) {
      this.accompFilter.gain.setTargetAtTime(effects.accompanimentBoost.enabled ? -effects.accompanimentBoost.intensity * 0.7 : 0, t, 0.02)
    }

    // 全景声厅：声场加宽（1-10 级）+ 独立混响（0-10）
    if (this.hallMatrix && this.hallWetGain) {
      const level = effects.hall.enabled ? effects.hall.level : 0 // 0-10
      const reverb = effects.hall.enabled ? effects.hall.reverb : 0 // 0-10
      // 加宽：侧声道增益随级别增加（10 级≈强烈）
      const sideGain = 1 + (level / 10) * 2.2 // 1 → 3.2
      const centerGain = 1 - (level / 10) * 0.42 // 1 → 0.58
      this.hallMatrix.sideGain.gain.setTargetAtTime(sideGain, t, 0.03)
      this.hallMatrix.centerGain.gain.setTargetAtTime(Math.max(0.4, centerGain), t, 0.03)
      // 混响湿电平（独立可调）
      this.hallWetGain.gain.setTargetAtTime(Math.min(1, reverb / 10) * 0.95, t, 0.05)
    }

    // 3D 环绕
    if (this.panner && this.pannerWetGain && this.pannerDryGain) {
      this.pannerWetGain.gain.setTargetAtTime(effects.surround3d.enabled ? 1 : 0, t, 0.03)
      this.pannerDryGain.gain.setTargetAtTime(effects.surround3d.enabled ? 0 : 1, t, 0.03)
    }
    this.syncSurroundRotation()

    // 变调/变速
    this.applyPitchSettings()

    // 均衡器
    this.rebuildEq()
  }

  private rebuildEq(): void {
    if (!this.context || !this.input || !this.presenceMatrix) return
    const { eq } = this.settings

    // 清理旧滤波器
    for (const f of this.eqFilters) {
      try { f.disconnect() } catch { /* noop */ }
    }
    this.eqFilters = []

    if (!eq.enabled) {
      // EQ 关闭：presenceMatrix 直接接到 bassFilter
      this.presenceMatrix.output.disconnect()
      this.presenceMatrix.output.connect(this.bassFilter!)
      return
    }

    const bands = eq.mode === 'simple'
      ? SIMPLE_EQ_BANDS.map((band, i) => ({ frequency: band.frequency, gain: eq.simpleBands[i] || 0, q: 1.0 }))
      : eq.proBands

    this.presenceMatrix.output.disconnect()
    let prev: AudioNode = this.presenceMatrix.output
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
    prev.connect(this.bassFilter!)
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
      if (!this.panner || !this.settings.effects.surround3d.enabled) {
        this.surroundAnimationFrame = 0
        return
      }
      const dt = Math.min(0.1, (now - this.surroundLastTime) / 1000)
      this.surroundLastTime = now
      const speed = this.settings.effects.surround3d.speed // 速度
      const direction = this.settings.effects.surround3d.direction // 1=正转 / -1=反转
      const baseAngle = this.settings.effects.surround3d.angle * Math.PI / 180 // 用户设定的旋转角度
      // 半径更大、旋转更快，让耳机内的环绕轨迹更明显
      const radius = 0.6 + this.settings.effects.surround3d.distance * 0.95
      this.surroundAngle += dt * speed * 2.6 * direction
      const a = this.surroundAngle + baseAngle
      const x = Math.sin(a) * radius
      const z = Math.cos(a) * radius
      const p = this.panner
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

  // 把当前音效（EQ + 低音/人声/伴奏 + 全景声厅混响）离线渲染成 WAV 并下载。
  // 说明：这是个人处理用途，涉及版权曲目请勿分发。
  async exportToWav(sourceUrl: string, durationSeconds: number): Promise<void> {
    if (!this.context) throw new Error('音频引擎尚未就绪')
    const sampleRate = this.context.sampleRate

    // 1. 拉取并解码源音频
    const response = await fetch(sourceUrl)
    if (!response.ok) throw new Error(`拉取音频失败：${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    const decoded = await this.context.decodeAudioData(arrayBuffer)

    // 2. 离线渲染长度（至少 1 秒，最长不超过源长度）
    const length = Math.max(1, Math.min(Math.floor(durationSeconds * sampleRate), decoded.length))

    const offline = new OfflineAudioContext(2, length, sampleRate)
    const source = offline.createBufferSource()
    source.buffer = decoded
    // 3. 搭建与实时链一致的核心效果：EQ → 低音 → 人声 → 伴奏 → 全景声厅（干湿）
    const { eq, effects } = this.settings
    let prev: AudioNode = source

    if (eq.enabled) {
      const bands = eq.mode === 'simple'
        ? SIMPLE_EQ_BANDS.map((band, i) => ({ frequency: band.frequency, gain: eq.simpleBands[i] || 0, q: 1.0 }))
        : eq.proBands
      for (const band of bands) {
        const f = offline.createBiquadFilter()
        f.type = 'peaking'
        f.frequency.value = band.frequency
        f.gain.value = band.gain
        f.Q.value = band.q
        prev.connect(f)
        prev = f
      }
    }

    if (effects.bassBoost.enabled) {
      const f = offline.createBiquadFilter()
      f.type = 'lowshelf'
      f.frequency.value = effects.bassBoost.depth
      f.gain.value = effects.bassBoost.intensity
      prev.connect(f)
      prev = f
    }
    if (effects.vocalBoost.enabled) {
      const f = offline.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = 2500
      f.Q.value = 1.1
      f.gain.value = effects.vocalBoost.intensity
      prev.connect(f)
      prev = f
    }
    if (effects.accompanimentBoost.enabled) {
      const f = offline.createBiquadFilter()
      f.type = 'peaking'
      f.frequency.value = 2500
      f.Q.value = 1.4
      f.gain.value = -effects.accompanimentBoost.intensity
      prev.connect(f)
      prev = f
    }

    // 全景声厅：干路 + 卷积混响湿路
    const dry = offline.createGain()
    dry.gain.value = 1
    prev.connect(dry)
    dry.connect(offline.destination)

    if (effects.hall.enabled) {
      const convolver = offline.createConvolver()
      convolver.buffer = generateHallImpulseResponse(offline, 3.6, 2.2)
      const wet = offline.createGain()
      wet.gain.value = Math.min(1, effects.hall.reverb / 10) * 0.95
      prev.connect(convolver)
      convolver.connect(wet)
      wet.connect(offline.destination)
    }

    // 显式限定源播放区间为导出时长：即使 OfflineAudioContext 长度已经截断，
    // 也避免解码后的整曲 buffer 在渲染循环中被无谓读取/混音。
    source.start(0, 0, length / sampleRate)
    const rendered = await offline.startRendering()

    // 4. 编码为 WAV 并下载
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
