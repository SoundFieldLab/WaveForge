/**
 * Resampler —— 多相窗口化 sinc 重采样（自研，零运行时依赖）
 *
 * 出处/许可：
 *  - 概念来源：speexdsp 多相 FIR 重采样（BSD-3）—— 窗口化 sinc 内核 + 分数相位累加，
 *    以 libsamplerate（BSD-2）的 sinc 模式为质量参照；本文件为独立实现，无代码复制。
 *  - Kaiser 窗 / Bessel I0 / sinc 均为公开数学函数（标准幂级数与三角函数展开）。
 *
 * 设计说明：
 *  1. 内核：h(u) = cutoff · sinc(cutoff·u) · kaiser(u/L)（理想低通 h(t)=c·sinc(c·t) 加 Kaiser 窗，
 *     因子 c=cutoff 保证单位直流增益）；cutoff = min(1, outRate/inRate)，归一化到输入采样率：
 *     降采样时截止到输出 Nyquist，升采样时保留输入全带宽。
 *     抽头数 taps = 2L 随 quality 分级（8→64、10→128）。
 *  2. 多相表：把内核按分数相位 f∈[0,1) 离散为 PH=256 个相位，两相邻相位线性插值
 *     得到任意相位 f 的抽头系数；相位 f=0 的内核在整数偏移处 sinc 采样值精确为 0，
 *     因此 inRate==outRate 时逐样本恒等（±1e-6 级，供测试验证）。
 *  3. process()：一次性处理整段输入；头部越界样本按静音（与流式语义一致），
 *     尾部越界样本做"边界保持"（clamp 到末样本）避免截断爆音；输出长度 ≈ round(N·outRate/inRate)。
 *  4. processStreaming()：输入侧使用环形缓冲（容量 taps+16，> 内核窗口宽），采用"喂入/产出
 *     交错"——仅当内核窗口完全落在已接收样本内时才产出，环形占用恒有界、旧样本回绕自动丢弃；
 *     尾部样本留给后续输入，因此流式输出与一次性输出在公共区间逐样本一致（确定性）。
 *  5. 确定性：全部系数在构造/首用时预计算，无 Math.random / Date / console。
 */
export class Resampler {
  private readonly inRate: number
  private readonly outRate: number
  private readonly channels: number
  private readonly taps: number
  private readonly half: number // L = taps/2
  private readonly ratio: number // 输入样本数 / 输出样本数（每个输出样本对应的输入相位步进）
  private readonly cutoff: number
  private readonly table: Float32Array // 多相表：(PH+1) 行 × taps 列
  private readonly ph: number // 相位数
  // ---- 流式状态（环形缓冲） ----
  private ring: Float32Array // 容量 (taps+16)×ch 的环形缓冲（交错）
  private inTotal = 0 // 累计已接收输入帧数（每声道）
  private outPos = 0 // 已产生的输出帧数（每声道）

  /** quality 0..10（默认 8）：控制抽头数（4 << (quality>>1)）与 Kaiser β。 */
  constructor(inRate: number, outRate: number, channels = 1, quality = 8) {
    if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || inRate <= 0 || outRate <= 0) {
      throw new Error('invalid sample rate')
    }
    if (!Number.isInteger(channels) || channels < 1) throw new Error('invalid channel count')
    const q = Math.min(10, Math.max(0, Math.floor(quality)))
    this.inRate = inRate
    this.outRate = outRate
    this.channels = channels
    this.taps = 4 << (q >> 1)
    this.half = this.taps / 2
    this.ratio = inRate / outRate
    this.cutoff = Math.min(1, outRate / inRate) // 归一化截止（输入采样率单位）
    this.ph = 256
    this.table = this.buildTable(6 + q * 0.35)
    this.ring = new Float32Array((this.taps + 16) * channels) // 环形缓冲：内核窗口宽 + 安全余量
  }

  /** 构建多相表：行 = 相位 p/PH（p=0..PH，PH 行与 0 行相同用于环绕插值），列 = taps 个抽头。 */
  private buildTable(beta: number): Float32Array {
    const rows = this.ph + 1
    const t = new Float32Array(rows * this.taps)
    const i0b = besselI0(beta)
    const L = this.half
    for (let p = 0; p < rows; p++) {
      const f = p / this.ph // 分数相位
      const base = p * this.taps
      for (let k = 0; k < this.taps; k++) {
        const u = k - (L - 1) - f // 内核偏移（中心在 k = L-1 处，对应输入样本 x[i]）
        let h = 0
        if (u > -L && u < L) {
          // 窗口化 sinc：理想低通 h(t)=c·sinc(c·t)，c=cutoff 既定截止又保证单位直流增益
          // （Σ_k h(k-f) ≈ 1，缺 c 因子时直流增益会变成 1/c，降采样时幅度被放大 1/c 倍）
          const s = u === 0 ? 1 : Math.sin(Math.PI * this.cutoff * u) / (Math.PI * this.cutoff * u)
          const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - (u / L) * (u / L)))) / i0b
          h = this.cutoff * s * w
        }
        t[base + k] = h
      }
    }
    return t
  }

  /**
   * 一次性重采样：返回新 Float32Array（长度 ≈ round(N·outRate/inRate)，每声道计）。
   * input 为（可选）多声道交错数据：长度必须是 channels 的整数倍。
   */
  process(input: Float32Array): Float32Array {
    const ch = this.channels
    if (input.length % ch !== 0) throw new Error('input length must be a multiple of channels')
    const nFrames = input.length / ch
    const outFrames = Math.round(nFrames * (this.outRate / this.inRate))
    const out = new Float32Array(outFrames * ch)
    const L = this.half
    const ph = this.ph
    const taps = this.taps
    const table = this.table
    const ratio = this.ratio
    const last = nFrames - 1
    for (let m = 0; m < outFrames; m++) {
      const pos = m * ratio
      const i = Math.floor(pos)
      const f = pos - i
      const phReal = f * ph
      const p0 = Math.floor(phReal)
      const fr = phReal - p0
      const row0 = p0 * taps
      const row1 = (p0 + 1) * taps
      for (let c = 0; c < ch; c++) {
        let acc = 0
        for (let k = 0; k < taps; k++) {
          const j = i + k - (L - 1)
          // 头：流起始前的样本按静音处理（与 processStreaming 一致）；
          // 尾：边界保持（clamp 到末样本）避免截断爆音
          const xv = j < 0 ? 0 : j > last ? input[last * ch + c] : input[j * ch + c]
          const kk = table[row0 + k] + (table[row1 + k] - table[row0 + k]) * fr
          acc += xv * kk
        }
        out[m * ch + c] = acc
      }
    }
    return out
  }

  /**
   * 流式重采样：把 input 追加到内部环形缓冲，把当前可产生的输出写入 out。
   * 返回本次写入的每声道样本数（帧数）；out 空间不足时仅写入可用部分，
   * 剩余输出保留在内部状态，下次调用继续。
   *
   * 环形缓冲管理（自洽设计）：
   *  - 容量 cap = taps + 16（> 内核窗口宽度 2L，含安全余量）；
   *  - 采用"喂入/产出交错"：仅当下一输出 m 的内核窗口尾部 i(m)+L 已落入已接收样本
   *    （i+L < inTotal）时才产出，否则只喂入"恰好使其可产出"的样本量（≤ ceil(ratio)+1）；
   *  - 由此在产出过程中 i(m) 与 inTotal 保持同步（i ≈ inTotal−L），环形占用恒 ≤ 2L+16，
   *    旧样本在回绕时自然被覆盖，读 j%cap 恒为 x[j]；
   *  - j<0（流起始前）按静音补零，与 process() 头部语义一致。
   */
  processStreaming(input: Float32Array, out: Float32Array): number {
    const ch = this.channels
    if (input.length % ch !== 0) throw new Error('input length must be a multiple of channels')
    const inFrames = input.length / ch
    const ring = this.ring
    const cap = this.ring.length / ch
    const L = this.half
    const taps = this.taps
    const ph = this.ph
    const ratio = this.ratio
    const table = this.table
    const maxOut = Math.floor(out.length / ch)
    let pos = 0
    let written = 0
    while (pos < inFrames && written < maxOut) {
      const m = this.outPos
      const i = Math.floor(m * ratio)
      if (i + L >= this.inTotal) {
        // 窗口尾部未覆盖：只喂入满足该输出所需的样本量（保持环形占用有界）
        const take = Math.min(inFrames - pos, i + L + 1 - this.inTotal)
        for (let j = 0; j < take; j++) {
          const slot = ((this.inTotal + j) % cap) * ch
          for (let c = 0; c < ch; c++) ring[slot + c] = input[(pos + j) * ch + c]
        }
        this.inTotal += take
        pos += take
      } else {
        // 产出输出 m（窗口完全覆盖已接收样本）
        const f = m * ratio - i
        const phReal = f * ph
        const p0 = Math.floor(phReal)
        const fr = phReal - p0
        const row0 = p0 * taps
        const row1 = (p0 + 1) * taps
        for (let c = 0; c < ch; c++) {
          let acc = 0
          for (let k = 0; k < taps; k++) {
            const j = i + k - (L - 1)
            const xv = j < 0 ? 0 : ring[(j % cap) * ch + c] // j<0：流起始前的静音
            const kk = table[row0 + k] + (table[row1 + k] - table[row0 + k]) * fr
            acc += xv * kk
          }
          out[written * ch + c] = acc
        }
        this.outPos++
        written++
      }
    }
    return written
  }

  /** 清空流式状态（环形缓冲 / 输出计数）；多相表与系数不变。 */
  reset(): void {
    this.ring.fill(0)
    this.inTotal = 0
    this.outPos = 0
  }
}

/** 一阶修正 Bessel 函数 I0(x)：标准幂级数 Σ ((x/2)^k / k!)²。x ≤ ~10 时 ~20 项收敛。 */
function besselI0(x: number): number {
  if (x < 0) x = -x
  let sum = 1
  let term = 1
  const x2 = (x / 2) * (x / 2)
  for (let k = 1; k <= 40; k++) {
    term *= x2 / (k * k)
    sum += term
    if (term < 1e-16 * sum) break
  }
  return sum
}