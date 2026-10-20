import type { AudioBuffer } from './audioBuffer'
/**
 * ReverbSimple —— 算法混响（Freeverb 类，模块 10）
 *
 * 出处/许可：
 *  - 结构（8 立体声梳状 + 4 全通、damping 反馈低通、wet/dry/width 混音）源自
 *    Jezar 的 Freeverb（公有领域，https://freeverb3vst.osdn.jp/ 及
 *    musicdsp.org 上的原始实现），并参考 Perry Cook 的 stk FreeVerb（MIT）
 *    思路。本实现为按公开结构独立编写的 TS 代码。
 *  - type 房间参数表为本项目自行定义并注释（hall/room/plate/spring/stage），
 *    表中 (roomSize, damping) 为各类型的基准特性，与用户参数按 50% 权重混合。
 *
 * 实现要点：
 *  - 8 个立体声梳状滤波器（左右各 4，延迟互质防共振）+ 4 个全通滤波器
 *    （反馈系数 0.5，级联于梳状和之后）。
 *  - 梳状反馈 = effRoomSize（clamp 0..0.98，保证稳定不发散）；
 *    反馈回路一阶低通系数 = effDamping。
 *  - 湿路宽度 width：wet1 = wet·(width/2+0.5)，wet2 = wet·((1-width)/2)，
 *    立体声交叉混合（width=1 无交叉，width=0 单声道化）。
 *  - preDelay 用独立延迟线实现。
 *  - 延迟长度按 fs/44100 缩放，type 提供 delayScale（spring 特短、stage 特长）。
 *
 * 确定性：同输入同参数必同输出；无随机、无 Date、无 console。
 */

import type { ReverbType } from '../types'

/** 算法混响参数（v2 兼容 5 种 type） */
export interface ReverbSimpleParams {
  roomSize: number
  damping: number
  wet: number
  dry: number
  preDelayMs: number
  width: number
  type: ReverbType
}

interface ReverbTypeTable {
  /** 基准 roomSize（0..1） */
  roomSize: number
  /** 基准 damping（0..1） */
  damping: number
  /** 延迟长度缩放（1.0=标准 Freeverb 调音） */
  delayScale: number
}

/** type → 房间参数表（自行定义，注释见各条目） */
const TYPE_TABLE: Record<ReverbType, ReverbTypeTable> = {
  // hall：大空间长尾，反馈较强、阻尼适中，标准延迟
  hall: { roomSize: 0.7, damping: 0.4, delayScale: 1.0 },
  // room：小房间短尾，反馈弱、阻尼高（偏闷）
  room: { roomSize: 0.4, damping: 0.6, delayScale: 0.8 },
  // plate：金属板混响，反馈中等、阻尼很低（明亮），延迟偏短密度高
  plate: { roomSize: 0.6, damping: 0.2, delayScale: 0.7 },
  // spring：弹簧混响，反馈弱、阻尼极高（独特"弹簧"音色），延迟特短
  spring: { roomSize: 0.3, damping: 0.8, delayScale: 0.5 },
  // stage：舞台/厅堂，反馈中等、阻尼适中，延迟拉长获得更宽声场
  stage: { roomSize: 0.5, damping: 0.5, delayScale: 1.2 },
}

// 标准 Freeverb 梳状延迟（左右各 4，@44.1kHz，互质）
const COMB_DELAYS_L = [1116, 1188, 1277, 1356]
const COMB_DELAYS_R = [1101, 1173, 1256, 1344]
// 标准 Freeverb 全通延迟（@44.1kHz，左右共用）
const ALLPASS_DELAYS = [556, 441, 341, 225]
const PARAM_RAMP_MS = 20

export class ReverbSimple {
  private readonly fs: number

  // 梳状滤波器状态（8 组）
  private combBufL: Float32Array[] = []
  private combBufR: Float32Array[] = []
  private combPosL: Int32Array = new Int32Array(4)
  private combPosR: Int32Array = new Int32Array(4)
  private combLenL: Float64Array = new Float64Array(4)
  private combLenR: Float64Array = new Float64Array(4)
  private targetCombLenL: Float64Array = new Float64Array(4)
  private targetCombLenR: Float64Array = new Float64Array(4)
  private combLenStepL: Float64Array = new Float64Array(4)
  private combLenStepR: Float64Array = new Float64Array(4)
  private combStoreL: Float32Array = new Float32Array(4)
  private combStoreR: Float32Array = new Float32Array(4)

  // 全通滤波器状态（左右各 4）
  private apBufL: Float32Array[] = []
  private apBufR: Float32Array[] = []
  private apPosL: Int32Array = new Int32Array(4)
  private apPosR: Int32Array = new Int32Array(4)
  private apLen: Float64Array = new Float64Array(4)
  private targetApLen: Float64Array = new Float64Array(4)
  private apLenStep: Float64Array = new Float64Array(4)

  // preDelay 延迟线（左右各一）
  private preDelayL: Float32Array
  private preDelayR: Float32Array
  private preDelayPos = 0
  private preDelayLen = 0
  private targetPreDelayLen = 0
  private preDelayLenStep = 0

  // 参数
  private feedback = 0
  private damp1 = 0
  private damp2 = 1
  private wet1 = 0
  private wet2 = 0
  private dry = 0
  private targetFeedback = 0
  private targetDamp1 = 0
  private targetWet1 = 0
  private targetWet2 = 0
  private targetDry = 0
  private feedbackStep = 0
  private dampStep = 0
  private wet1Step = 0
  private wet2Step = 0
  private dryStep = 0
  private rampRemaining = 0
  private hasRendered = false

  constructor(fs: number) {
    if (fs <= 0 || !Number.isFinite(fs)) {
      throw new Error('invalid sample rate')
    }
    this.fs = fs

    // 预分配最大延迟缓冲：最长梳状 1356·1.2（stage）@fs
    const maxCombLen = Math.ceil((1356 * 1.2 * fs) / 44100) + 2
    const maxApLen = Math.ceil((556 * 1.2 * fs) / 44100) + 2
    for (let c = 0; c < 4; c++) {
      this.combBufL.push(new Float32Array(maxCombLen))
      this.combBufR.push(new Float32Array(maxCombLen))
      this.apBufL.push(new Float32Array(maxApLen))
      this.apBufR.push(new Float32Array(maxApLen))
    }
    // preDelay 上限 1000ms
    this.preDelayL = new Float32Array(Math.ceil(fs) + 1)
    this.preDelayR = new Float32Array(Math.ceil(fs) + 1)
  }

  setParams(p: ReverbSimpleParams): void {
    const t = TYPE_TABLE[p.type] || TYPE_TABLE.hall

    // type 提供基准，用户参数在基准附近 ±0.25 范围内微调（中性参数 0.5 时即类型本身）
    const effRoom = Math.min(0.98, Math.max(0, t.roomSize + (clamp01(p.roomSize) - 0.5) * 0.5))
    const effDamp = Math.min(0.99, Math.max(0.01, t.damping + (clamp01(p.damping) - 0.5) * 0.5))

    const wet = clamp(p.wet, 0, 4)
    const width = clamp(p.width, 0, 2)
    this.targetFeedback = effRoom
    this.targetDamp1 = effDamp
    this.targetWet1 = wet * (width / 2 + 0.5)
    this.targetWet2 = wet * ((1 - width) / 2)
    this.targetDry = clamp(p.dry, 0, 4)

    if (!this.hasRendered) {
      this.feedback = this.targetFeedback
      this.damp1 = this.targetDamp1
      this.damp2 = 1 - this.targetDamp1
      this.wet1 = this.targetWet1
      this.wet2 = this.targetWet2
      this.dry = this.targetDry
      this.rampRemaining = 0
    } else {
      this.rampRemaining = Math.max(1, Math.round((PARAM_RAMP_MS * this.fs) / 1000))
      this.feedbackStep = (this.targetFeedback - this.feedback) / this.rampRemaining
      this.dampStep = (this.targetDamp1 - this.damp1) / this.rampRemaining
      this.wet1Step = (this.targetWet1 - this.wet1) / this.rampRemaining
      this.wet2Step = (this.targetWet2 - this.wet2) / this.rampRemaining
      this.dryStep = (this.targetDry - this.dry) / this.rampRemaining
    }

    // preDelay：目标读点随其他参数同样平滑移动，保留环形缓冲中的在途尾音。
    const pdMs = clamp(p.preDelayMs, 0, 1000)
    const nextDelayLen = Math.round((pdMs * this.fs) / 1000)
    this.targetPreDelayLen = nextDelayLen
    if (!this.hasRendered) this.preDelayLen = nextDelayLen
    else this.preDelayLenStep = (nextDelayLen - this.preDelayLen) / this.rampRemaining

    // 延迟长度：标准调音 × type.delayScale × fs/44100
    const scale = (t.delayScale * this.fs) / 44100
    for (let c = 0; c < 4; c++) {
      this.targetCombLenL[c] = Math.max(1, Math.round(COMB_DELAYS_L[c] * scale))
      this.targetCombLenR[c] = Math.max(1, Math.round(COMB_DELAYS_R[c] * scale))
      this.targetApLen[c] = Math.max(1, Math.round(ALLPASS_DELAYS[c] * scale))
      if (!this.hasRendered) {
        this.combLenL[c] = this.targetCombLenL[c]
        this.combLenR[c] = this.targetCombLenR[c]
        this.apLen[c] = this.targetApLen[c]
      } else {
        this.combLenStepL[c] = (this.targetCombLenL[c] - this.combLenL[c]) / this.rampRemaining
        this.combLenStepR[c] = (this.targetCombLenR[c] - this.combLenR[c]) / this.rampRemaining
        this.apLenStep[c] = (this.targetApLen[c] - this.apLen[c]) / this.rampRemaining
      }
    }
  }

  /** 就地处理立体声；out = dry·in + wet 混音（Freeverb 结构） */
  processStereo(l: AudioBuffer, r: AudioBuffer): void {
    const B = Math.min(l.length, r.length)
    // 湿路增益补偿（0.25 = 4 comb 平均）：无补偿时 4 路梳状求和的宽带稳态幅度
    // 可达输入 ~2-3 倍，wet 0.3 + dry 0.7 场景下总峰值超 1 → 削波炸音（用户实测）。
    const WET_GAIN = 0.25
    for (let i = 0; i < B; i++) {
      const xl = l[i]
      const xr = r[i]

      // preDelay fractional read permits a click-free delay-time morph without clearing its tail.
      const dl = readDelay(this.preDelayL, this.preDelayPos, this.preDelayLen, xl)
      const dr = readDelay(this.preDelayR, this.preDelayPos, this.preDelayLen, xr)
      this.preDelayL[this.preDelayPos] = xl
      this.preDelayR[this.preDelayPos] = xr
      if (++this.preDelayPos >= this.preDelayL.length) this.preDelayPos = 0

      // 8 梳状并联
      let accL = 0
      let accR = 0
      for (let c = 0; c < 4; c++) {
        accL += this.combProcess(this.combBufL[c], this.combPosL, this.combLenL, this.combStoreL, c, dl)
        accR += this.combProcess(this.combBufR[c], this.combPosR, this.combLenR, this.combStoreR, c, dr)
      }
      // 4 全通串联
      for (let a = 0; a < 4; a++) {
        accL = this.allpassProcess(this.apBufL[a], this.apPosL, a, accL)
        accR = this.allpassProcess(this.apBufR[a], this.apPosR, a, accR)
      }
      accL *= WET_GAIN
      accR *= WET_GAIN

      // wet/dry + width 交叉混合
      l[i] = xl * this.dry + accL * this.wet1 + accR * this.wet2
      r[i] = xr * this.dry + accR * this.wet1 + accL * this.wet2
      this.advanceParameters()
    }
    if (B > 0) this.hasRendered = true
  }

  reset(): void {
    for (let c = 0; c < 4; c++) {
      this.combBufL[c].fill(0)
      this.combBufR[c].fill(0)
      this.apBufL[c].fill(0)
      this.apBufR[c].fill(0)
      this.combPosL[c] = 0
      this.combPosR[c] = 0
      this.apPosL[c] = 0
      this.apPosR[c] = 0
      this.combStoreL[c] = 0
      this.combStoreR[c] = 0
      this.combLenL[c] = this.targetCombLenL[c]
      this.combLenR[c] = this.targetCombLenR[c]
      this.apLen[c] = this.targetApLen[c]
    }
    this.preDelayL.fill(0)
    this.preDelayR.fill(0)
    this.preDelayPos = 0
    this.preDelayLen = this.targetPreDelayLen
    this.feedback = this.targetFeedback
    this.damp1 = this.targetDamp1
    this.damp2 = 1 - this.targetDamp1
    this.wet1 = this.targetWet1
    this.wet2 = this.targetWet2
    this.dry = this.targetDry
    this.rampRemaining = 0
  }

  // ---------------------------------------------------------------- 内部

  private advanceParameters(): void {
    if (this.rampRemaining <= 0) return
    this.feedback += this.feedbackStep
    this.damp1 += this.dampStep
    this.damp2 = 1 - this.damp1
    this.wet1 += this.wet1Step
    this.wet2 += this.wet2Step
    this.dry += this.dryStep
    this.preDelayLen += this.preDelayLenStep
    for (let c = 0; c < 4; c++) {
      this.combLenL[c] += this.combLenStepL[c]
      this.combLenR[c] += this.combLenStepR[c]
      this.apLen[c] += this.apLenStep[c]
    }
    if (--this.rampRemaining === 0) {
      this.feedback = this.targetFeedback
      this.damp1 = this.targetDamp1
      this.damp2 = 1 - this.targetDamp1
      this.wet1 = this.targetWet1
      this.wet2 = this.targetWet2
      this.dry = this.targetDry
      this.preDelayLen = this.targetPreDelayLen
      for (let c = 0; c < 4; c++) {
        this.combLenL[c] = this.targetCombLenL[c]
        this.combLenR[c] = this.targetCombLenR[c]
        this.apLen[c] = this.targetApLen[c]
      }
    }
  }

  /** 梳状滤波器：延迟 + 反馈低通（Jezar Freeverb 结构），返回延迟样本 */
  private combProcess(
    buf: Float32Array,
    pos: Int32Array,
    delaySamples: Float64Array,
    store: Float32Array,
    idx: number,
    input: number,
  ): number {
    const p = pos[idx]
    const output = readDelay(buf, p, delaySamples[idx])
    // 反馈回路一阶低通
    const filt = output * this.damp2 + store[idx] * this.damp1
    store[idx] = filt
    buf[p] = input + filt * this.feedback
    let np = p + 1
    if (np >= buf.length) np = 0
    pos[idx] = np
    return output
  }

  /** 全通滤波器（反馈系数 0.5） */
  private allpassProcess(buf: Float32Array, pos: Int32Array, idx: number, input: number): number {
    const p = pos[idx]
    const bufout = readDelay(buf, p, this.apLen[idx])
    const output = -input + bufout
    buf[p] = input + bufout * 0.5
    let np = p + 1
    if (np >= buf.length) np = 0
    pos[idx] = np
    return output
  }

}

/** Read x[n-delay] from a fixed ring; supports fractional delay and a zero-latency current sample. */
function readDelay(buffer: Float32Array, position: number, delaySamples: number, currentInput?: number): number {
  if (delaySamples <= 0) return currentInput ?? buffer[position]
  const whole = Math.floor(delaySamples)
  const fraction = delaySamples - whole
  const newer = whole === 0
    ? currentInput ?? buffer[position]
    : buffer[wrapIndex(position - whole, buffer.length)]
  if (fraction === 0) return newer
  const older = buffer[wrapIndex(position - whole - 1, buffer.length)]
  return newer + fraction * (older - newer)
}

function wrapIndex(index: number, length: number): number {
  return index < 0 ? index + length : index
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

function clamp01(v: number): number {
  return clamp(v, 0, 1)
}
