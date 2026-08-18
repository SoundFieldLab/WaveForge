/**
 * WaveForge 音频引擎 v3 —— 引擎总成（EngineV3）
 *
 * 出处/许可：
 *  - 链式架构与参数模型：本项目《音频算法设计文档.md》§2 总体架构（自研）；
 *  - 链内各 DSP 模块（EqChain/MidSide/Deesser/Compressor/Limiter/BassEnhancer/
 *    Convolver/ReverbSimple/LufsMeter/LoudnessComp/Stretch/FFT/features）
 *    的概念来源与许可见各自源文件头部注释（RBJ Cookbook / DSPFilters(MIT) /
 *    kissfft(BSD-3) / stk FreeVerb(MIT) / ITU-R BS.1770 / ISO 226 等）；
 *  - 智能均衡 IEQ（Post）为本文件内置实现，思路参考技术文档 §1.4（自研）；
 *  - 夜间模式（压缩增强 + 6kHz 高频衰减）为 v2 兼容语义（本项目历史功能，自研）。
 *
 * 处理链（顺序固定，见 API_SPEC 辅助模块 A）：
 *   输入 → 响度归一化增益 → 3D 环绕(轻量立体声旋转) → M/S(width + voiceBalance)
 *   → Pre-EQ(用户 EQ) → Deesser → Compressor → NightMode
 *   → 混响(卷积|算法|off 三路路由) → BassEnhancer → LoudnessComp
 *   → IEQ(Post) → [LUFS 采样点] → Limiter → 输出
 *
 * 说明：
 *  - LUFS 采样点严格位于 Limiter 之前（API_SPEC 要求），测的是压限前的节目响度；
 *  - getAnalysis 的内部 2048 点 FFT 取样于 LoudnessComp 之后（即 IEQ 输入处，
 *    等价地也位于 Limiter 之前），每累计 2048 样本更新一次；
 *  - Stretch（变速/变调）不内联进主链，仅经 getStretch() 供 gapless/过渡场景调用；
 *  - process() 内零分配：工作缓冲按需惰性扩容，稳态无分配；分析路径复用预分配缓冲；
 *  - 确定性：同输入同参数必同输出（无随机、无 Date、无 console）。
 */

import type {
  V3EngineParams,
  EngineStats,
  EngineAnalysis,
  EqBand,
  SpectralFeatures,
  CompressorSettings,
  ReverbSettings,
  IeqTargetCurve,
} from '../types'
import { SIMPLE_EQ_FREQUENCIES, createDefaultParams } from '../types'
import { EqChain } from '../dsp/EqChain'
import { MidSide } from '../dsp/MidSide'
import { Deesser } from '../dsp/Deesser'
import { Compressor } from '../dsp/Compressor'
import { Limiter } from '../dsp/Limiter'
import { BassEnhancer } from '../dsp/BassEnhancer'
import { Convolver } from '../dsp/Convolver'
import { ReverbSimple } from '../dsp/ReverbSimple'
import { LufsMeter } from '../dsp/LufsMeter'
import { LoudnessComp } from '../dsp/LoudnessComp'
import { Biquad } from '../dsp/biquad'
import { Stretch } from '../dsp/Stretch'
import { fft, hannWindow, frequencyBins } from '../dsp/fft'
import {
  computeRms,
  computeZcr,
  spectralCentroid,
  spectralRolloff,
  spectralFlatness,
  spectralCrest,
} from '../dsp/features'

/** 引擎内部 FFT 分析窗长（2 的幂，N/2+1 = 1025 个 bin） */
const ANALYSIS_WINDOW = 2048
/** Pre-EQ 级联最大段数（EqChain 默认 20 段） */
const MAX_PRE_EQ_BANDS = 20
/** IEQ（Post）内部参数 EQ 段数（1 倍频程 10 段） */
const IEQ_BAND_COUNT = 10
/** IEQ 控制频率（1 倍频程，与 v2 专业 10 段一致） */
const IEQ_FREQS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
/** 响度归一化实时增益平滑时间常数（秒），防抽吸（技术文档 §7.2 慢速 AGC） */
const NORM_SMOOTH_SEC = 3.0
/** 手动音量（调音室音量滑块 externalGainDb）平滑时间常数（秒）：
 *  跟手（~80ms 到位）又不产生咔哒声；自动归一化仍走 NORM_SMOOTH_SEC 慢速防抽吸 */
const MANUAL_GAIN_SMOOTH_SEC = 0.08

/** 深拷贝参数快照：数组逐元素复制，避免外部可变对象影响引擎；引擎本身不修改传入参数。 */
function cloneParams(p: V3EngineParams): V3EngineParams {
  return {
    ...p,
    eq: {
      ...p.eq,
      simpleBands: p.eq.simpleBands.slice(),
      proBands: p.eq.proBands.map((b) => ({ frequency: b.frequency, gain: b.gain, q: b.q })),
    },
    deesser: { ...p.deesser },
    compressor: { ...p.compressor },
    nightMode: { ...p.nightMode },
    bassEnhancer: { ...p.bassEnhancer },
    reverb: {
      ...p.reverb,
      algorithmic: { ...p.reverb.algorithmic },
      convolution: { ...p.reverb.convolution },
    },
    surround3d: { ...p.surround3d },
    loudnessCompensation: {
      ...p.loudnessCompensation,
      bands: p.loudnessCompensation.bands.map((b) => ({ frequency: b.frequency, gain: b.gain })),
    },
    loudnessNormalization: { ...p.loudnessNormalization },
    limiter: { ...p.limiter },
    ieq: { ...p.ieq },
    pitch: { ...p.pitch },
    hearing: { ...p.hearing },
  }
}

export class EngineV3 {
  private readonly _fs: number
  private readonly _channels: number
  private _params: V3EngineParams

  // —— 链上 DSP 模块（构造时固定采样率，setParams 只重算系数） ——
  private readonly _eqChain: EqChain
  private readonly _midSide: MidSide
  private readonly _deesser: Deesser
  private readonly _compressor: Compressor
  private readonly _limiter: Limiter
  private readonly _bass: BassEnhancer
  private _convolver: Convolver // 非 readonly：dePeriodize 选项变化时重建（死参数修复）
  private _convolverDePeriodize = true
  private readonly _reverbSimple: ReverbSimple
  private readonly _lufs: LufsMeter
  private readonly _loudnessComp: LoudnessComp
  private readonly _stretch: Stretch

  // —— 夜间模式（压缩增强 + 6kHz 高频 shelf，v2 兼容语义） ——
  private readonly _nightCompressor: Compressor
  private readonly _nightShelfL: Biquad
  private readonly _nightShelfR: Biquad
  private _nightActive = false

  // —— IEQ（Post）：内部实现，参考技术文档 §1.4 ——
  private readonly _ieqChain: EqChain
  private _ieqActive = false
  private _ieqStrength = 0.5
  private _ieqSmooth = 0.01
  private readonly _ieqGains = new Float32Array(IEQ_BAND_COUNT)
  private readonly _ieqLevels = new Float32Array(IEQ_BAND_COUNT)
  private readonly _ieqBands: EqBand[] = []
  private readonly _ieqZeroBands: EqBand[] = []
  private _ieqTargets: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  private readonly _ieqBinRanges: Array<[number, number]> = []

  // —— 分析路径（2048 点 FFT，每累计一窗更新一次） ——
  private readonly _ring: Float32Array
  private _ringPos = 0
  private _analysisPos = 0
  private _analysisReady = false
  private readonly _timeBuf: Float32Array
  private readonly _real: Float32Array
  private readonly _imag: Float32Array
  private readonly _magBuf: Float32Array
  private readonly _hann: Float32Array
  private readonly _binFreqs: Float32Array
  private readonly _featCache: SpectralFeatures

  // —— 工作缓冲（惰性扩容，稳态零分配） ——
  private _workL = new Float32Array(0)
  private _workR = new Float32Array(0)

  // —— 运行时状态 ——
  private _preEqActive = false
  private _useConvolver = false
  private _loadedIr: Float32Array | null = null
  private _normGain = 1
  private _surroundPhase = 0

  constructor(sampleRate: number, channelCount = 2) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error('invalid sample rate')
    }
    this._fs = sampleRate
    this._channels = channelCount > 0 ? channelCount : 2

    this._eqChain = new EqChain(sampleRate, MAX_PRE_EQ_BANDS)
    this._midSide = new MidSide()
    this._deesser = new Deesser(sampleRate)
    this._compressor = new Compressor(sampleRate)
    this._limiter = new Limiter(sampleRate)
    this._bass = new BassEnhancer(sampleRate)
    this._convolver = new Convolver(sampleRate)
    this._reverbSimple = new ReverbSimple(sampleRate)
    this._lufs = new LufsMeter(sampleRate)
    this._loudnessComp = new LoudnessComp(sampleRate)
    this._stretch = new Stretch(sampleRate, 2)

    this._nightCompressor = new Compressor(sampleRate)
    this._nightShelfL = new Biquad('highshelf', 6000, 0.707, 0, sampleRate)
    this._nightShelfR = new Biquad('highshelf', 6000, 0.707, 0, sampleRate)

    this._ieqChain = new EqChain(sampleRate, IEQ_BAND_COUNT)
    for (let i = 0; i < IEQ_BAND_COUNT; i++) {
      this._ieqBands.push({ frequency: IEQ_FREQS[i], gain: 0, q: 1.1 })
      this._ieqZeroBands.push({ frequency: IEQ_FREQS[i], gain: 0, q: 1.1 })
    }
    // 预计算各频段的 bin 范围（相邻中心频率几何中点作为边界）
    const binHz = sampleRate / ANALYSIS_WINDOW
    for (let i = 0; i < IEQ_BAND_COUNT; i++) {
      const loEdge = i === 0 ? 20 : Math.sqrt(IEQ_FREQS[i - 1] * IEQ_FREQS[i])
      const hiEdge =
        i === IEQ_BAND_COUNT - 1 ? sampleRate / 2 : Math.sqrt(IEQ_FREQS[i] * IEQ_FREQS[i + 1])
      const lo = Math.max(0, Math.floor(loEdge / binHz))
      const hi = Math.min(ANALYSIS_WINDOW / 2, Math.ceil(hiEdge / binHz))
      this._ieqBinRanges.push([lo, hi])
    }

    this._ring = new Float32Array(ANALYSIS_WINDOW)
    this._timeBuf = new Float32Array(ANALYSIS_WINDOW)
    this._real = new Float32Array(ANALYSIS_WINDOW)
    this._imag = new Float32Array(ANALYSIS_WINDOW)
    this._magBuf = new Float32Array(ANALYSIS_WINDOW / 2 + 1)
    this._hann = hannWindow(ANALYSIS_WINDOW)
    this._binFreqs = frequencyBins(ANALYSIS_WINDOW, sampleRate)
    this._featCache = { rms: 0, zcr: 0, centroidHz: 0, rolloffHz: 0, flatness: 0, crest: 0 }

    // 初始快照：默认参数
    this._params = createDefaultParams(sampleRate)
    this.setParams(this._params)
  }

  /** 参数更新：重算所有模块系数（即时生效）。不修改传入的 p。 */
  setParams(p: V3EngineParams): void {
    this._params = cloneParams(p)
    const p2 = this._params

    // —— Pre-EQ：用户 EQ（simple/pro）——
    const bands = this.buildPreEqBands(p2)
    this._eqChain.setBands(bands)
    this._eqChain.setQCompensation(p2.eq.qCompensation)
    // Pre-EQ 仅由用户 EQ 开关控制（设备档案已并入 LoudnessComp 音量补偿）
    this._preEqActive = p2.eq.enabled

    // —— Deesser / Compressor ——
    this._deesser.setParams(p2.deesser)
    this._compressor.setParams(p2.compressor)

    // —— NightMode：压缩增强(ratio×1.5, threshold−6dB) + 6kHz 高频 shelf 衰减(amount×1.5dB) ——
    const nm = p2.nightMode
    this._nightActive = nm.enabled && nm.amount > 0
    if (this._nightActive) {
      const k = nm.amount / 10 // 强度 0..1
      const base = p2.compressor
      const night: CompressorSettings = {
        enabled: true,
        thresholdDb: base.thresholdDb - 6 * k,
        ratio: Math.max(1, base.ratio * (1 + 0.5 * k)), // 满强度时 ratio×1.5
        kneeDb: base.kneeDb,
        attackMs: base.attackMs,
        releaseMs: base.releaseMs,
        makeupDb: base.makeupDb,
        outputGain: 1,
      }
      this._nightCompressor.setParams(night)
      const shelfGainDb = -1.5 * nm.amount // 衰减 amount×1.5 dB
      this._nightShelfL.setParams('highshelf', 6000, 0.707, shelfGainDb)
      this._nightShelfR.setParams('highshelf', 6000, 0.707, shelfGainDb)
    }

    // —— 混响三路路由：convolution | algorithmic | off ——
    this.configureReverb(p2.reverb)

    // —— BassEnhancer / LoudnessComp / Limiter ——
    this._bass.setParams(p2.bassEnhancer)
    this._loudnessComp.setParams(p2.loudnessCompensation)
    this._limiter.setParams(p2.limiter)

    // —— IEQ（Post）配置 ——
    this._ieqActive = p2.ieq.enabled
    this._ieqStrength = p2.ieq.strength
    this._ieqTargets = this.ieqTargetCurve(p2.ieq.targetCurve)
    // 增益平滑系数：α = 1 − exp(−分析间隔/时间常数)，时间常数默认 3s 防抽吸
    const intervalSec = ANALYSIS_WINDOW / this._fs
    this._ieqSmooth = 1 - Math.exp(-intervalSec / Math.max(0.1, p2.ieq.timeConstantSec))
    if (!this._ieqActive) {
      this._ieqGains.fill(0)
      this._ieqChain.setBands(this._ieqZeroBands)
    }

    // —— 响度归一化 ——
    if (!p2.loudnessNormalization.enabled) {
      this._normGain = 1
    }
  }

  /** 就地处理：outputs[i] 写入处理结果（长度 = inputs[i] 长度）。process 内零分配。 */
  process(inputs: Float32Array[], outputs: Float32Array[]): void {
    let n = Infinity
    for (const ch of inputs) {
      if (ch) n = Math.min(n, ch.length)
    }
    if (n === Infinity || n <= 0) return
    this.ensureCapacity(n)
    const L = this._workL
    const R = this._workR
    const inL = inputs[0]
    // 单声道引擎（channelCount=1）忽略第二输入声道
    const inR = this._channels > 1 && inputs.length > 1 ? inputs[1] : undefined
    for (let i = 0; i < n; i++) L[i] = inL ? inL[i] : 0
    for (let i = 0; i < n; i++) R[i] = inR ? inR[i] : 0

    // 1) 响度归一化增益（v2 兼容目标 LUFS + v3 引擎内实时测量驱动）
    const ln = this._params.loudnessNormalization
    if (ln.enabled) {
      if (ln.useRealtimeMeter) {
        const integrated = this._lufs.getIntegratedLufs()
        const measured = Number.isFinite(integrated) ? integrated : this._lufs.getMomentaryLufs()
        // 无测量期不放大（ref=-70 会导致启动瞬间 +9dB 膨胀——审计修复）
        const gainDb = Number.isFinite(measured)
          ? Math.min(ln.maxGainDb, Math.max(ln.minGainDb, ln.targetLufs - measured))
          : 0
        const targetLin = Math.pow(10, gainDb / 20)
        const alpha = 1 - Math.exp(-(n / this._fs) / NORM_SMOOTH_SEC)
        this._normGain += alpha * (targetLin - this._normGain)
      } else {
        // 外部给定增益（调音室音量滑块）：快时间常数平滑——滑块跟手、无阶跃咔哒
        // （原与自动归一化共用 3s 慢平滑，拖滑块声音几秒才到位，不跟手）
        const targetLin = Math.pow(10, Math.min(ln.maxGainDb, Math.max(ln.minGainDb, ln.externalGainDb)) / 20)
        const alpha = 1 - Math.exp(-(n / this._fs) / MANUAL_GAIN_SMOOTH_SEC)
        this._normGain += alpha * (targetLin - this._normGain)
      }
      const g = this._normGain
      for (let i = 0; i < n; i++) {
        L[i] *= g
        R[i] *= g
      }
    }

    // 2) 3D 环绕：轻量立体声旋转（v3 语义，angle 静态旋转 + speed 随时间缓慢旋转）
    const s3 = this._params.surround3d
    if (s3.enabled) {
      const dt = n / this._fs
      this._surroundPhase += 2 * Math.PI * s3.speed * dt * 0.125 // speed=1 → 0.125 圈/秒
      const theta = (s3.angle * Math.PI) / 180 + s3.direction * this._surroundPhase
      const c = Math.cos(theta)
      const s = Math.sin(theta)
      const scale = 0.5 + 0.5 * s3.distance // 距离 0..1 映射为电平 0.5..1
      for (let i = 0; i < n; i++) {
        const l = L[i]
        const r = R[i]
        L[i] = (l * c - r * s) * scale
        R[i] = (l * s + r * c) * scale
      }
    }

    // 3) M/S：立体声宽度 + 人声比例（v2 兼容 voiceBalance 走 M/S；
    //    voiceBalance 仅在 pitch.enabled 时生效——审计修复）
    const vb = this._params.pitch.enabled ? this._params.pitch.voiceBalance : 0
    this._midSide.setParams(this._params.stereoWidth, vb)
    this._midSide.processStereo(L, R)

    // 4) Pre-EQ（用户 EQ）
    if (this._preEqActive) this._eqChain.processStereo(L, R)

    // 5) Deesser
    if (this._params.deesser.enabled) this._deesser.processStereo(L, R)

    // 6) Compressor
    if (this._params.compressor.enabled) this._compressor.processStereo(L, R)

    // 7) NightMode：压缩增强 + 6kHz 高频衰减
    if (this._nightActive) {
      this._nightCompressor.processStereo(L, R)
      this._nightShelfL.processBlock(L, L)
      this._nightShelfR.processBlock(R, R)
    }

    // 8) 混响（三路路由：卷积 / 算法 / off；mode='off' 时完全直通——审计修复）
    if (this._params.reverb.enabled && this._params.reverb.mode !== 'off') {
      if (this._useConvolver) this._convolver.processStereo(L, R)
      else this._reverbSimple.processStereo(L, R)
    }

    // 9) BassEnhancer
    if (this._params.bassEnhancer.enabled) this._bass.processStereo(L, R)

    // 10) LoudnessComp（等响度补偿）
    if (this._params.loudnessCompensation.enabled) this._loudnessComp.processStereo(L, R)

    // 12) IEQ（Post）
    if (this._ieqActive) this._ieqChain.processStereo(L, R)

    // 11) 分析取样（IEQ 处理后——闭环修正）：取样点在 IEQ 之后，
    //    IEQ 抬高/压低频段后分析能看到修正结果，增益随修正收敛到目标曲线
    //    （原取样点在 IEQ 之前为开环：增益只增不减，一路推到 ±12 clamp 过冲）
    this.feedAnalysis(L, R, n)

    // 13) LUFS 采样点（Limiter 之前，API_SPEC 要求）
    this._lufs.processStereo(L, R)

    // 14) Limiter（保护）
    if (this._params.limiter.enabled) this._limiter.processStereo(L, R)

    // 写出
    const outL = outputs[0]
    if (outL) for (let i = 0; i < n; i++) outL[i] = L[i]
    if (outputs.length > 1 && outputs[1]) {
      const outR = outputs[1]
      for (let i = 0; i < n; i++) outR[i] = R[i]
    }
  }

  getStats(): EngineStats {
    return {
      lufsIntegrated: this._lufs.getIntegratedLufs(),
      lufsMomentary: this._lufs.getMomentaryLufs(),
      lra: this._lufs.getLra(),
      peakDb: this._lufs.getPeakDb(),
      truePeakDb: this._lufs.getTruePeakDb(),
      limiterReductionDb: this._limiter.getReductionDb(),
      engineLatencySamples: this.getLatencySamples(),
    }
  }

  /** 最近一帧频谱 + 特征（内部 2048 点 FFT + Hann 窗）。未测到返回 null。 */
  getAnalysis(): EngineAnalysis {
    if (!this._analysisReady) return { spectrum: null, features: null }
    const spectrum = new Float32Array(this._magBuf)
    const features: SpectralFeatures = { ...this._featCache }
    return { spectrum, features }
  }

  /** 引擎引入的延迟（样本数）= 限幅器前瞻 + 混响延迟。 */
  getLatencySamples(): number {
    let lat = 0
    const p = this._params
    if (p.limiter.enabled) lat += this._limiter.getLatencySamples()
    if (p.reverb.enabled) {
      if (this._useConvolver) lat += this._convolver.getLatencySamples()
      else if (p.reverb.mode === 'algorithmic') {
        lat += Math.round((p.reverb.algorithmic.preDelayMs / 1000) * this._fs)
      }
    }
    return lat
  }

  /** 变速/变调处理器（不内联进主链，供 gapless/过渡场景调用）。 */
  getStretch(): Stretch {
    return this._stretch
  }

  /** 复位所有模块与内部状态。 */
  reset(): void {
    this._eqChain.reset()
    this._midSide.reset()
    this._deesser.reset()
    this._compressor.reset()
    this._limiter.reset()
    this._bass.reset()
    this._convolver.reset()
    this._reverbSimple.reset()
    this._lufs.reset()
    this._loudnessComp.reset()
    this._nightCompressor.reset()
    this._nightShelfL.reset()
    this._nightShelfR.reset()
    this._ieqChain.reset()
    this._stretch.reset()
    this._normGain = 1
    this._surroundPhase = 0
    this._ringPos = 0
    this._analysisPos = 0
    this._analysisReady = false
    this._ring.fill(0)
    this._magBuf.fill(0)
    this._ieqGains.fill(0)
    const f = this._featCache
    f.rms = 0
    f.zcr = 0
    f.centroidHz = 0
    f.rolloffHz = 0
    f.flatness = 0
    f.crest = 0
  }

  // ==================== 内部实现 ====================

  private ensureCapacity(n: number): void {
    if (this._workL.length < n) {
      this._workL = new Float32Array(n)
      this._workR = new Float32Array(n)
    }
  }

  /** 收集用户 EQ（simple/pro）bands，上限 20 段。 */
  private buildPreEqBands(p: V3EngineParams): EqBand[] {
    const out: EqBand[] = []
    // 用户 EQ 仅在 eq.enabled 时并入（eq 关闭时不得泄漏——审计修复）；
    // 机型补偿已移除（由 LoudnessComp 音量曲线承担）
    if (!p.eq.enabled) return out
    if (p.eq.mode === 'simple') {
      for (let i = 0; i < SIMPLE_EQ_FREQUENCIES.length; i++) {
        out.push({ frequency: SIMPLE_EQ_FREQUENCIES[i], gain: p.eq.simpleBands[i] ?? 0, q: 1.1 })
      }
    } else {
      const count = Math.min(p.eq.bandCount, p.eq.proBands.length)
      for (let i = 0; i < count; i++) {
        const b = p.eq.proBands[i]
        out.push({ frequency: b.frequency, gain: b.gain, q: b.q })
      }
    }
    return out.slice(0, MAX_PRE_EQ_BANDS)
  }

  /** 混响路由配置：convolution 且 IR 有效 → 卷积；否则算法混响（含自动回退）。 */
  private configureReverb(rv: ReverbSettings): void {
    this._reverbSimple.setParams({ ...rv.algorithmic })
    this._useConvolver = false
    // dePeriodize 参数化（死参数修复）：选项变化时重建 Convolver 并强制重载 IR
    const wantDeP = rv.convolution.dePeriodize
    if (wantDeP !== this._convolverDePeriodize) {
      this._convolver = new Convolver(this._fs, { dePeriodize: wantDeP })
      this._convolverDePeriodize = wantDeP
      this._loadedIr = null // 新实例无 IR，强制重载
    }
    if (rv.enabled && rv.mode === 'convolution') {
      const ir = rv.convolution.ir
      if (ir && ir.length > 0) {
        try {
          if (ir !== this._loadedIr) {
            // 复制 IR 再载入：避免模块就地改写调用方数组
            this._convolver.loadIR(new Float32Array(ir), rv.convolution.irName ?? undefined)
            this._loadedIr = ir
          }
          this._convolver.setMix(rv.convolution.mix)
          this._convolver.setPreDelayMs(rv.convolution.preDelayMs)
          this._useConvolver = true
        } catch {
          // 空/非法 IR（模块抛错）：自动回退算法混响
          this._useConvolver = false
        }
      }
    }
  }

  /** 把单声道下混写入环形分析缓冲；累计满一窗后执行 FFT + 特征 + IEQ 更新。 */
  private feedAnalysis(l: Float32Array, r: Float32Array, n: number): void {
    const W = ANALYSIS_WINDOW
    for (let i = 0; i < n; i++) {
      this._ring[this._ringPos] = 0.5 * (l[i] + r[i])
      this._ringPos = (this._ringPos + 1) % W
    }
    this._analysisPos += n
    // 循环触发：一次 process 可能喂入任意长度（离线导出/大块测试会一次数十万样本），
    // 若只取模触发一次会丢掉所有中间窗（IEQ 增益/频谱/特征只更新一小步——审计实测
    // 4s 大块只跑 1 次分析、增益收敛到目标的 1/7）。逐窗递减保证每个完整窗都分析。
    while (this._analysisPos >= W) {
      this._analysisPos -= W
      this.runAnalysis()
    }
  }

  /** 对最近一窗做 2048 点 FFT（Hann 窗），计算幅度谱与特征，并更新 IEQ。 */
  private runAnalysis(): void {
    const W = ANALYSIS_WINDOW
    for (let i = 0; i < W; i++) {
      const src = this._ring[(this._ringPos + i) % W]
      this._timeBuf[i] = src
      this._real[i] = src * this._hann[i]
      this._imag[i] = 0
    }
    fft(this._real, this._imag, false)
    // 手动幅度谱（复用预分配缓冲，避免 magnitudeSpectrum 的分配）
    const half = W / 2
    const mag = this._magBuf
    for (let k = 0; k <= half; k++) {
      const re = this._real[k]
      const im = this._imag[k]
      mag[k] = Math.sqrt(re * re + im * im)
    }
    const f = this._featCache
    f.rms = computeRms(this._timeBuf)
    f.zcr = computeZcr(this._timeBuf)
    f.centroidHz = spectralCentroid(mag, this._binFreqs)
    f.rolloffHz = spectralRolloff(mag, this._binFreqs)
    f.flatness = spectralFlatness(mag)
    f.crest = spectralCrest(mag)
    this._analysisReady = true
    if (this._ieqActive) this.updateIeq(mag)
  }

  /** IEQ：长时频谱与目标曲线之差 → 平滑增益 → 写入内部参数 EQ。 */
  private updateIeq(mag: Float32Array): void {
    const levels = this._ieqLevels
    let overall = 0
    for (let i = 0; i < IEQ_BAND_COUNT; i++) {
      const [lo, hi] = this._ieqBinRanges[i]
      // 频段电平用 RMS（能量平均）而非线性幅度平均：稀疏频谱（纯音/稀疏乐器）下
      // 线性平均会把少数尖峰稀释到接近噪声底（实测 4kHz 单 bin 频段被摊到 -80dB），
      // 驱动 IEQ 增益在两个 ±12dB 极端 clamp 间振荡、输出过度整形；RMS 对尖峰
      // 敏感（平方项），稀释效应小约一个量级。噪声底 clamp 防 -126dB 极端值。
      let sumSq = 0
      for (let k = lo; k <= hi; k++) sumSq += mag[k] * mag[k]
      const rms = Math.sqrt(sumSq / (hi - lo + 1))
      levels[i] = 20 * Math.log10(Math.max(rms, 1e-4)) // -80dB 噪声底
      overall += levels[i]
    }
    overall /= IEQ_BAND_COUNT
    const alpha = this._ieqSmooth
    const strength = this._ieqStrength
    for (let i = 0; i < IEQ_BAND_COUNT; i++) {
      const relative = levels[i] - overall // 相对频谱形状（去掉整体电平偏移）
      const desired = strength * (this._ieqTargets[i] - relative)
      let g = this._ieqGains[i] + alpha * (desired - this._ieqGains[i])
      if (g > 12) g = 12
      else if (g < -12) g = -12
      this._ieqGains[i] = g
      this._ieqBands[i].gain = g
    }
    this._ieqChain.setBands(this._ieqBands)
  }

  /** IEQ 目标曲线（dB，按 1 倍频程 10 段）。 */
  private ieqTargetCurve(curve: IeqTargetCurve): number[] {
    switch (curve) {
      case 'flat':
        return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      case 'warm':
        return [4, 3.5, 2.5, 1.5, 0.5, 0, -0.5, -1.5, -2.5, -3.5]
      case 'bright':
        return [-3.5, -2.5, -1.5, -0.5, 0, 0.5, 1.5, 2.5, 3.5, 4]
      case 'vocal':
        return [-1.5, -1, 0, 1, 2, 2.5, 2, 1, 0, -0.5]
    }
  }
}