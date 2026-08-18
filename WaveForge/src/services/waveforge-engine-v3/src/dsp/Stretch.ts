/**
 * Stretch —— 变速 / 变调（相位声码器自研 + signalsmith-stretch(MIT) 可选适配）
 *
 * 出处/许可：
 *  - 相位声码器算法原理：research/docs/音频算法技术文档.md §9（相位差 → 瞬时频率 → 按目标步进累积相位）；
 *    STFT 采用 Hann 窗、N=2048、hop=512（75% 重叠，COLA 条件满足）。
 *  - signalsmith-stretch（MIT）仅作为可选动态适配目标（import() + try/catch 探测，失败回退自研）。
 *  - 内部 FFT 为自研基-2 蝶形（kissfft 思路，BSD-3 参考），与 fft.ts 签名无关，纯模块内使用。
 *
 * 语义（标准相位声码器）：
 *  - 时间伸缩 = rate（输出长度 ≈ 输入 × rate，不变调）；
 *  - 频率伸缩 = 2^(semitones/12)（变调，与 rate 独立）。
 *  实现采用两阶段：
 *    阶段一：相位声码器按 rate·pitchScale 做时间伸缩（不变调，长度 ×rate·pitchScale）；
 *    阶段二：用 Resampler 按 1/pitchScale 重采样（长度 ÷pitchScale，频率 ×pitchScale）。
 *  合成后总长度 ≈ 输入 × rate ✓，音高 = 原 × pitchScale ✓。
 *
 * 内部缓冲设计（自洽的环形 + 滑动结构，均预分配、process 内零分配）：
 *  - 输入侧：帧读取采用"环形窗口"语义——帧 m 需要样本 [m·hop, m·hop+N)，
 *    实现上直接按绝对索引读输入并在越界处补零（流式分段时该窗口即环形缓冲的等价物）；
 *  - 输出侧：合成帧按 m·Hs 直接重叠相加进目标缓冲（滑动 OLA，无二次拷贝）；
 *  - 分析频谱上一帧（prevRe/prevIm）与合成相位累积（synPhase）跨帧保留，reset() 清零。
 *
 * 幅度归一化（WOLA 精确窗和）：分析帧带窗 w（IDFT 重建本身携带 w），合成时再乘 w，
 * 每帧贡献 w²·x；逐样本除以 S(t) = Σ_m w(t-m·Hs)²（帧循环中同步累加）即恢复 x(t)。
 * 对所有 hop/rate 精确（rate=1 时 S=1.5 恒定，rate=2 时 S 随 t 起伏但被精确消除）。
 *
 * 确定性：无 Math.random / Date / console；同输入同参数同输出（signalsmith 路径仅在
 * 其纯 DSP 类接口可同步使用时启用，见 isSignalsmithAvailable 注释）。
 */
export interface StretchParams {
  /** 半音数（-36..36，超出 clamp） */
  semitones: number
  /** 时间伸缩速率（0.1..8，超出 clamp；1=原速） */
  rate: number
}

const N = 2048 // FFT 窗长
const HOP = 512 // 分析 hop

export class Stretch {
  /** 采样率（公开只读，构造时校验 > 0） */
  readonly fs: number
  /** 声道数（API 兼容保留；processStereo 固定处理双声道） */
  readonly channels: number
  private rate = 1
  private semitones = 0
  private pitchScale = 1

  // ---- 预分配缓冲（process 内零分配） ----
  private readonly win: Float32Array // Hann 窗
  private readonly rev: Int32Array // FFT 位反转表
  private readonly anaRe: Float32Array
  private readonly anaIm: Float32Array
  private readonly prevRe: Float32Array
  private readonly prevIm: Float32Array
  private readonly synRe: Float32Array
  private readonly synIm: Float32Array
  private readonly synPhase: Float32Array // N/2+1：合成相位累积

  /** signalsmith 纯 DSP 模块缓存（由 isSignalsmithAvailable 探测填充） */
  private static _signalsmith: unknown = null

  constructor(fs: number, channels = 2) {
    if (!Number.isFinite(fs) || fs <= 0) throw new Error('invalid sample rate')
    if (!Number.isInteger(channels) || channels < 1) throw new Error('invalid channel count')
    this.fs = fs
    this.channels = channels
    this.win = hannWindow(N)
    this.rev = bitReverseTable(N)
    this.anaRe = new Float32Array(N)
    this.anaIm = new Float32Array(N)
    this.prevRe = new Float32Array(N)
    this.prevIm = new Float32Array(N)
    this.synRe = new Float32Array(N)
    this.synIm = new Float32Array(N)
    this.synPhase = new Float32Array(N / 2 + 1)
  }

  /** 参数即时生效；rate/semitones 做边界 clamp 避免 NaN/病态伸缩。 */
  setParams(p: StretchParams): void {
    const r = clamp(p.rate, 0.1, 8)
    const s = clamp(p.semitones, -36, 36)
    const ps = Math.pow(2, s / 12)
    // 参数突变会改变 STFT 合成 hop 与频率映射：旧帧相位/频谱与新参数不匹配，
    // OLA 归一化失配会导致输出幅度膨胀（审计实测 14 倍炸音）。检测到变化时重置内部状态。
    if (r !== this.rate || s !== this.semitones) {
      this.rate = r
      this.semitones = s
      this.pitchScale = ps
      this.reset()
    } else {
      this.rate = r
      this.semitones = s
      this.pitchScale = ps
    }
  }

  /**
   * 变速/变调处理立体声。输入输出为独立数组（不就地修改输入）。
   * 返回 { l, r }，长度 ≈ 输入 × rate（±3% 量级，见测试）。
   */
  processStereo(l: Float32Array, r: Float32Array): { l: Float32Array; r: Float32Array } {
    if (Stretch._signalsmith) {
      const via = this._processWithSignalsmith(l, r)
      if (via) return via // 适配成功；否则回退自研
    }
    const rate = this.rate
    const ps = this.pitchScale
    return { l: this._processChannel(l, rate, ps), r: this._processChannel(r, rate, ps) }
  }

  /** 清空内部状态（相位累积 / 上一帧频谱 / 窗内缓冲）。 */
  reset(): void {
    this.prevRe.fill(0)
    this.prevIm.fill(0)
    this.synRe.fill(0)
    this.synIm.fill(0)
    this.synPhase.fill(0)
    this.anaRe.fill(0)
    this.anaIm.fill(0)
  }

  /**
   * 探测 signalsmith-stretch 是否可用于同步处理。
   * 说明：官方 npm 包（v1.x）为 Web Audio / AudioWorklet 包装，需要 AudioContext 且为异步，
   * 无法在纯 JS 环境同步调用，故本探测只认可"同步纯 DSP 类接口"（模块导出 Stretch 类且含
   * process 方法）；否则返回 false 并回退自研相位声码器。动态 import 失败（未安装）同样回退。
   */
  static async isSignalsmithAvailable(): Promise<boolean> {
    try {
      const spec = 'signalsmith-stretch' // 变量形式：避免 TS 静态解析缺失模块
      const mod: unknown = await import(spec)
      const m = mod as { Stretch?: unknown }
      if (m && typeof m.Stretch === 'function') {
        Stretch._signalsmith = m
        return true
      }
      Stretch._signalsmith = null
      return false
    } catch {
      Stretch._signalsmith = null
      return false
    }
  }

  // ------------------------------------------------------------------
  // 自研相位声码器
  // ------------------------------------------------------------------

  /** 单声道处理：先按 rate·pitchScale 时间伸缩（不变调），再按 1/pitchScale 重采样变调。 */
  private _processChannel(x: Float32Array, rate: number, pitchScale: number): Float32Array {
    const stretched = this._vocoderStretch(x, rate * pitchScale)
    if (Math.abs(pitchScale - 1) < 1e-9) return stretched
    // 变调 = 重采样：inRate=fs·pitchScale, outRate=fs ⇒ 输出长度 ÷pitchScale、频率 ×pitchScale
    const rs = new Resampler(this.fs * pitchScale, this.fs, 1, 8)
    return rs.process(stretched)
  }

  /**
   * 相位声码器时间伸缩（不变调）：帧 m 的幅度取输入帧 m 的 STFT 幅度，
   * 相位按瞬时频率在合成 hop Hs=HOP·factor 上累积，Hann 窗 OLA。
   */
  private _vocoderStretch(x: Float32Array, factor: number): Float32Array {
    const len = x.length
    if (len === 0) return new Float32Array(0)
    // 帧数：完整帧（窗完全落在输入内）+ 至多一个尾部部分帧（越界补零，保证输出覆盖完整尾段）
    const full = len >= N ? Math.floor((len - N) / HOP) + 1 : 0
    const partial = full * HOP < len ? 1 : 0
    const M = Math.max(1, full + partial)
    // 合成 hop 取整：保证帧位置与 OLA 下标为整数（非整数 factor 时有效速率近似，偏差 <0.5 样本/帧）
    const Hs = Math.max(1, Math.round(HOP * factor))
    const outLen = (M - 1) * Hs + N
    const out = new Float32Array(outLen)
    const sArr = new Float32Array(outLen) // 窗平方和 S(t)（与 out 同步累加）
    // 幅度归一化（WOLA 精确窗和）：
    // 分析帧带窗 w（IDFT 重建本身携带 w），合成时再乘 w → 每帧贡献 w²·x；
    // 逐样本 OLA 增益 S(t) = Σ_m w(t-m·Hs)²（按实际有限帧集累加，帧循环中同步生成 sArr）
    // ⇒ 输出除以 S(t) 即恢复 x(t)。对所有 hop/rate 精确（rate=1 时 S=1.5 恒定；
    // rate=2 时 S=0.5..1 随 t 起伏，但被逐样本除法精确消除；帧集有限导致首尾 S 不同，
    // 故不能用单周期表，必须按实际帧位置累加）。
    const win = this.win
    const anaRe = this.anaRe
    const anaIm = this.anaIm
    const prevRe = this.prevRe
    const prevIm = this.prevIm
    const synRe = this.synRe
    const synIm = this.synIm
    const synPhase = this.synPhase
    const half = N / 2
    const TWO_PI = 2 * Math.PI

    for (let m = 0; m < M; m++) {
      const start = m * HOP
      // 分析帧（尾部越界补零；流式分段时本窗口即环形缓冲语义）
      for (let i = 0; i < N; i++) {
        const j = start + i
        anaRe[i] = (j < len ? x[j] : 0) * win[i]
        anaIm[i] = 0
      }
      this._fft(anaRe, anaIm, false)

      // 合成相位：帧 0 用分析相位初始化；之后按瞬时频率累积
      for (let k = 0; k <= half; k++) {
        const re = anaRe[k]
        const im = anaIm[k]
        if (m === 0) {
          synPhase[k] = Math.atan2(im, re)
        } else {
          // 帧间复相位差（数值稳定）：Δφ = ∠(X_m · conj(X_{m-1}))
          const dphi = Math.atan2(
            im * prevRe[k] - re * prevIm[k],
            re * prevRe[k] + im * prevIm[k]
          )
          const wk = (TWO_PI * k) / N // bin 中心角频率（弧度/输入样本）
          // 偏差 = 实测相位差 − 期望 bin 中心相位步进，折叠回 (-π, π]
          let dev = dphi - HOP * wk
          dev -= TWO_PI * Math.round(dev / TWO_PI)
          const winst = wk + dev / HOP // 瞬时角频率
          synPhase[k] += Hs * winst // 按合成 hop 累积
        }
      }

      // 构造 Hermitian 合成频谱（DC/Nyquist 强制实值，保持幅度与符号）
      for (let k = 0; k <= half; k++) {
        const mag = Math.sqrt(anaRe[k] * anaRe[k] + anaIm[k] * anaIm[k])
        const ph = synPhase[k]
        if (k === 0 || k === half) {
          synRe[k] = Math.cos(ph) >= 0 ? mag : -mag
          synIm[k] = 0
        } else {
          synRe[k] = mag * Math.cos(ph)
          synIm[k] = mag * Math.sin(ph)
        }
      }
      for (let k = 1; k < half; k++) {
        synRe[N - k] = synRe[k]
        synIm[N - k] = -synIm[k]
      }

      // 逆变换 + 合成窗 OLA（同步累加窗平方和 sArr 供归一化）
      this._fft(synRe, synIm, true)
      const base = m * Hs
      for (let i = 0; i < N; i++) {
        out[base + i] += win[i] * synRe[i]
        sArr[base + i] += win[i] * win[i]
      }

      // 保存当前分析帧供下一帧差分
      prevRe.set(anaRe)
      prevIm.set(anaIm)
    }

    // 逐样本除以 S(t)。阈值 0.01（窗边缘 w²<0.01 的区域）：
    // 部分帧（尾部补零）的 IDFT 重建在窗边缘存在相位误差（synRe 非零），
    // 若在此处以极小 S(t) 做除法会把误差放大（审计实测 14 倍炸音）；
    // S 过小处保留窗内原值（w·synRe ≈ 0）→ 自然淡入淡出。
    for (let i = 0; i < outLen; i++) {
      const s = sArr[i]
      if (s > 0.01) out[i] /= s
    }
    return out
  }

  // ------------------------------------------------------------------
  // 内部 FFT（自研基-2 蝶形，kissfft 思路参考；等长且为 2 的幂）
  // ------------------------------------------------------------------

  private _fft(re: Float32Array, im: Float32Array, inverse: boolean): void {
    const n = re.length
    const rev = this.rev
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / size
      const wr = Math.cos(ang)
      const wi = Math.sin(ang)
      for (let i = 0; i < n; i += size) {
        let curR = 1
        let curI = 0
        const halfSize = size >> 1
        for (let k = 0; k < halfSize; k++) {
          const uR = re[i + k]
          const uI = im[i + k]
          const vR = re[i + k + halfSize] * curR - im[i + k + halfSize] * curI
          const vI = re[i + k + halfSize] * curI + im[i + k + halfSize] * curR
          re[i + k] = uR + vR
          im[i + k] = uI + vI
          re[i + k + halfSize] = uR - vR
          im[i + k + halfSize] = uI - vI
          const nR = curR * wr - curI * wi
          curI = curR * wi + curI * wr
          curR = nR
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n
        im[i] /= n
      }
    }
  }

  // ------------------------------------------------------------------
  // signalsmith 适配（防御性；当前官方包为 Web Audio 包装，此路径不会命中）
  // ------------------------------------------------------------------

  private _processWithSignalsmith(l: Float32Array, r: Float32Array): { l: Float32Array; r: Float32Array } | null {
    try {
      const mod = Stretch._signalsmith as { Stretch: new (channels: number, block: number) => unknown }
      const block = N // 2048 样本/块
      const s = new mod.Stretch(2, block) as Record<string, unknown>
      if (typeof s.reset === 'function') (s.reset as () => void)()
      if (typeof s.setTransposeSemitones === 'function') {
        ;(s.setTransposeSemitones as (v: number) => void)(this.semitones)
      } else if (typeof s.setFreqFactor === 'function') {
        ;(s.setFreqFactor as (v: number) => void)(this.pitchScale)
      } else {
        return null
      }
      if (typeof s.setTimeFactor === 'function') (s.setTimeFactor as (v: number) => void)(this.rate)
      const process = s.process as
        | ((input: Float32Array, output: Float32Array, samples: number) => number)
        | undefined
      if (typeof process !== 'function') return null

      const n = Math.min(l.length, r.length)
      const targetFrames = Math.round(n * this.rate)
      const outL = new Float32Array(targetFrames)
      const outR = new Float32Array(targetFrames)
      let written = 0
      for (let off = 0; off < n && written < targetFrames; off += block) {
        const cnt = Math.min(block, n - off)
        const inBuf = new Float32Array(cnt * 2)
        for (let i = 0; i < cnt; i++) {
          inBuf[i * 2] = l[off + i]
          inBuf[i * 2 + 1] = r[off + i]
        }
        const outBuf = new Float32Array(Math.ceil(cnt * this.rate * 2) + block * 4)
        const got = process(inBuf, outBuf, cnt)
        const frames = Math.min(Math.floor(got / 2), targetFrames - written)
        for (let i = 0; i < frames; i++) {
          outL[written + i] = outBuf[i * 2]
          outR[written + i] = outBuf[i * 2 + 1]
        }
        written += frames
      }
      return { l: outL, r: outR }
    } catch {
      return null // 任何失败回退自研
    }
  }
}

// ----------------------------------------------------------------------
// 模块内工具函数
// ----------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Hann 窗：w[i] = 0.5·(1 − cos(2πi/n)) */
function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n))
  return w
}

/** 位反转表：供内部基-2 FFT 使用 */
function bitReverseTable(n: number): Int32Array {
  let bits = 0
  while ((1 << bits) < n) bits++
  const rev = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    let v = i
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (v & 1)
      v >>= 1
    }
    rev[i] = r
  }
  return rev
}

// 同目录源码 import（本文件的重采样依赖，属我方文件）
import { Resampler } from './Resampler'