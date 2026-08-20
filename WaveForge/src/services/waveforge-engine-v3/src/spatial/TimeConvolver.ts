/**
 * TimeConvolver —— 时域直接卷积混响（契约 spatial_set_convolution_mode = time）
 *
 * 与 dsp/Convolver.ts（分区 FFT 卷积）流式接口同构（loadIR / processStereo /
 * reset / getLatencySamples 签名一致，可在空间后端内互换）：
 *
 * 干湿对齐设计（与分区模式逐位同调度）：
 *   - 输入按 L=512 装配成块，块满时直接时域卷积，输出块进入待放行队列；
 *   - 放行规则与 Convolver.processStereo 完全一致（wetIdx = totalOut − L，
 *     即 wet[t] = y[t−L]，y = 输入与 IR 的线性卷积）——因此两种模式
 *     干湿对齐一致、脉冲响应位置一致（±0 样本），输出仅差 FFT 圆整（≤1e-4）；
 *   - getLatencySamples 恒返回分区长 L=512（与 Convolver / Rust 侧一致）。
 *
 * 块卷积（"卷积尾 + 当前块"）：
 *   每 speaker 每耳一条环形输入历史（长度 M = IR 长度，跨块携带上一块尾部），
 *   每输出样本：x[j] 写入环 → y[j] = Σ_{m=0}^{M−1} h[m]·x[j−m]
 *   （x[j−m] 越界时取环内上一块尾部——即上一块的"卷积尾"与当前块贡献相加；
 *   f64 累加、f32 写回，与 Rust 侧 process_block 时域分支逐位对齐）。
 *
 * IR 去周期化与 Convolver 相同（镜像其私有 dePeriodizeIR 算法——dsp/* 属并行
 * 代理分区，本文件不跨分区引用；实测分析网格上为 no-op，纯一致性保留）。
 * 热路径：稳态零分配（缓冲预分配，队列压缩/扩容策略与 Convolver 相同）。
 */

/** 卷积引擎共用接口（TimeConvolver 与 dsp/Convolver 结构一致，可在后端互换） */
export interface StereoConvEngine {
  loadIR(ir: Float32Array, irName?: string): void
  processStereo(l: Float32Array, r: Float32Array): void
  reset(): void
}

export class TimeConvolver implements StereoConvEngine {
  private readonly fs: number
  private readonly partitionSize: number
  private readonly dePeriodize: boolean

  private irLoaded = false
  /** 去周期化后的 IR（长度 M） */
  private ir: Float32Array = new Float32Array(0)
  private irLength = 0
  private irName: string | null = null

  // ---- 流式状态（与 Convolver 同构；全部预分配） ----
  private inputBlockL: Float32Array = new Float32Array(0)
  private inputBlockR: Float32Array = new Float32Array(0)
  private inputPos = 0
  /** 每通道环形输入历史（长度 M，跨块携带"卷积尾"） */
  private histL: Float32Array = new Float32Array(0)
  private histR: Float32Array = new Float32Array(0)
  private histPosL = 0
  private histPosR = 0
  /** 待放行湿块队列（容量 (1+2)·L = 3L，与 Convolver (P+2)·L 对齐，P=1） */
  private pendingWetL: Float32Array = new Float32Array(0)
  private pendingWetR: Float32Array = new Float32Array(0)
  private pendingLen = 0
  private pendingPos = 0
  /** 已完成的输入块数（块完成时 +1）：湿路放行的"已产出"依据 */
  private completedBlocks = 0
  /** 已输出的样本总数（跨调用累计）：湿路放行的"位置"依据 */
  private totalOut = 0
  /** 已放行的湿路样本总数（严格按序放行依据） */
  private totalWetOut = 0

  constructor(fs: number, opts?: { partitionSize?: number; dePeriodize?: boolean }) {
    if (fs <= 0 || !Number.isFinite(fs)) {
      throw new Error('invalid sample rate')
    }
    this.fs = fs
    let L = opts && opts.partitionSize !== undefined ? Math.round(opts.partitionSize) : 512
    if (!Number.isFinite(L) || L < 1) L = 512
    // 分区长取合理范围 [32, 8192]（与 Convolver 同约束；时域模式下仅决定块长与放行延迟）
    this.partitionSize = Math.min(8192, Math.max(32, L))
    this.dePeriodize = opts ? opts.dePeriodize !== false : true
  }

  /**
   * 载入单声道 IR（校验/去周期化与 Convolver.loadIR 一致）。
   * 空 / 全零 / 非法 IR 抛 Error。
   */
  loadIR(ir: Float32Array, irName?: string): void {
    if (!ir || ir.length === 0) {
      throw new Error('invalid impulse response: empty')
    }
    // 校验：有限值且非全零
    let anyNonZero = false
    for (let i = 0; i < ir.length; i++) {
      const v = ir[i]
      if (!Number.isFinite(v)) {
        throw new Error('invalid impulse response: contains NaN/Infinity')
      }
      if (v !== 0) anyNonZero = true
    }
    if (!anyNonZero) {
      throw new Error('invalid impulse response: all zero')
    }

    const L = this.partitionSize
    const src = this.dePeriodize ? this.dePeriodizeIR(ir) : ir
    const M = src.length

    this.ir = src.slice() // 拷贝（调用方 scratch 可复用）
    this.irLength = M
    this.irName = irName !== undefined ? irName : null

    // （重新）分配流式缓冲（loadIR 非实时路径，允许分配）
    this.inputBlockL = new Float32Array(L)
    this.inputBlockR = new Float32Array(L)
    this.histL = new Float32Array(M)
    this.histR = new Float32Array(M)
    const pendingCap = 3 * L // (P+2)·L，P=1（时域单分区语义）
    this.pendingWetL = new Float32Array(pendingCap)
    this.pendingWetR = new Float32Array(pendingCap)

    this.inputPos = 0
    this.histPosL = 0
    this.histPosR = 0
    this.pendingLen = 0
    this.pendingPos = 0
    this.completedBlocks = 0
    this.totalOut = 0
    this.totalWetOut = 0
    this.irLoaded = true
  }

  /**
   * 流式立体声就地处理（与 Convolver.processStereo 同调度）：
   * 湿路 = 时域直接卷积（块装配 + 待放行队列），out[i] = wet[i]，相对输入延迟 L。
   * 未载入 IR 时抛错。
   */
  processStereo(l: Float32Array, r: Float32Array): void {
    if (!this.irLoaded) {
      throw new Error('no impulse response loaded')
    }
    const B = Math.min(l.length, r.length)
    const L = this.partitionSize

    // 先喂入输入块；块满时直接时域卷积产出湿块（同 Convolver 的块调度与
    // 队列压缩/扩容策略——写前若队尾越界则把未读内容压缩到头部，突发多块
    // 产出超出容量时动态扩容）
    for (let i = 0; i < B; i++) {
      this.inputBlockL[this.inputPos] = l[i]
      this.inputBlockR[this.inputPos] = r[i]
      this.inputPos++
      if (this.inputPos >= L) {
        const cap = this.pendingWetL.length
        if (this.pendingPos + this.pendingLen + L > cap) {
          const remain = this.pendingLen
          if (remain > 0 && this.pendingPos > 0) {
            this.pendingWetL.copyWithin(0, this.pendingPos, this.pendingPos + remain)
            this.pendingWetR.copyWithin(0, this.pendingPos, this.pendingPos + remain)
          }
          this.pendingPos = 0
          if (this.pendingLen + L > this.pendingWetL.length) {
            const newCap = Math.max(cap * 2, this.pendingLen + L)
            const nl = new Float32Array(newCap)
            nl.set(this.pendingWetL.subarray(0, this.pendingLen))
            this.pendingWetL = nl
            const nr = new Float32Array(newCap)
            nr.set(this.pendingWetR.subarray(0, this.pendingLen))
            this.pendingWetR = nr
          }
        }
        const writeAt = this.pendingPos + this.pendingLen
        this.processWetBlock(this.inputBlockL, this.pendingWetL, writeAt, 0)
        this.processWetBlock(this.inputBlockR, this.pendingWetR, writeAt, 1)
        this.pendingLen += L
        this.completedBlocks++
        this.inputPos = 0
      }
    }

    // 再按序取出 B 个湿样本（不足补零）。放行约束与 Convolver 逐样本一致：
    //   wetIdx = totalOut − L（位置 i 的湿输出 = 输入位置 i−L 的卷积）
    //   且 wetIdx < completedBlocks·L（对应输入块已产出）、totalWetOut === wetIdx
    //   （严格按序放行，防止同一次调用内多块提前放行）。
    for (let i = 0; i < B; i++) {
      let wetL = 0
      let wetR = 0
      const wetIdx = this.totalOut - L
      if (
        this.pendingLen > 0 &&
        wetIdx >= 0 &&
        wetIdx < this.completedBlocks * L &&
        this.totalWetOut === wetIdx
      ) {
        wetL = this.pendingWetL[this.pendingPos]
        wetR = this.pendingWetR[this.pendingPos]
        this.pendingPos++
        this.pendingLen--
        this.totalWetOut++
        if (this.pendingLen === 0) this.pendingPos = 0
      }
      this.totalOut++
      l[i] = wetL
      r[i] = wetR
    }
  }

  /** 湿路引入的延迟（样本数）= 一个分区长（与分区模式/干路对齐，两模式一致） */
  getLatencySamples(): number {
    return this.partitionSize
  }

  reset(): void {
    this.inputPos = 0
    this.histPosL = 0
    this.histPosR = 0
    this.pendingLen = 0
    this.pendingPos = 0
    this.completedBlocks = 0
    this.totalOut = 0
    this.totalWetOut = 0
    if (this.inputBlockL.length > 0) {
      this.inputBlockL.fill(0)
      this.inputBlockR.fill(0)
    }
    if (this.histL.length > 0) {
      this.histL.fill(0)
      this.histR.fill(0)
    }
    if (this.pendingWetL.length > 0) {
      this.pendingWetL.fill(0)
      this.pendingWetR.fill(0)
    }
  }

  /** 当前 IR 名称（未载入返回 null） */
  getIrName(): string | null {
    return this.irName
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 处理一个完整输入块：直接时域卷积（环形输入历史）并把输出块写入
   * pending[writeAt..writeAt+L)。ear=0 左 / 1 右（各自独立的环形历史）。
   */
  private processWetBlock(blk: Float32Array, pending: Float32Array, writeAt: number, ear: number): void {
    const L = this.partitionSize
    const M = this.irLength
    const hist = ear === 0 ? this.histL : this.histR
    let hp = ear === 0 ? this.histPosL : this.histPosR
    for (let j = 0; j < L; j++) {
      hist[hp] = blk[j]
      hp = (hp + 1) % M
      const newest = (hp + M - 1) % M // 最新写入样本（= blk[j]）
      // y[j] = Σ_{m=0}^{M−1} h[m]·x[j−m]（x[j−m] 越界取环内上一块尾部；
      // f64 累加、f32 写回——与 Rust 侧时域分支逐位对齐）
      let acc = 0
      for (let m = 0; m < M; m++) {
        acc += this.ir[m] * hist[(newest + M - m) % M]
      }
      pending[writeAt + j] = acc
    }
    if (ear === 0) this.histPosL = hp
    else this.histPosR = hp
  }

  /**
   * IR 去周期化（镜像 dsp/Convolver.ts 的私有 dePeriodizeIR——dsp/* 属并行代理
   * 分区，不跨分区引用；算法一致保证两模式装载同一 IR）：
   * 检测能量包络峰值，从峰值后 −60dB 点起乘 exp 衰减（τ≈50ms）。
   * 返回新数组（不改动调用方传入的 IR）。
   */
  private dePeriodizeIR(ir: Float32Array): Float32Array {
    const M = ir.length
    const out = new Float32Array(M)
    out.set(ir)
    const W = Math.max(4, Math.round(0.01 * this.fs)) // 10ms 包络窗
    const half = W >> 1

    // 能量包络（移动平均 RMS）
    let peakIdx = 0
    let peakVal = -1
    for (let n = 0; n < M; n++) {
      let sum = 0
      const lo = Math.max(0, n - half)
      const hi = Math.min(M, n + half + 1)
      const cnt = hi - lo
      for (let j = lo; j < hi; j++) sum += ir[j] * ir[j]
      const env = Math.sqrt(sum / cnt)
      if (env > peakVal) {
        peakVal = env
        peakIdx = n
      }
    }
    if (peakVal <= 1e-12) return out // 极静 IR（loadIR 已挡全零，防御性分支）

    // −60dB 点：包络最后一次高于峰值−60dB 之后的第一个样本（后缀判定，
    // 避免稀疏 IR 如延迟冲激被误衰减）
    const threshold = peakVal * 1e-3
    let lastAbove = peakIdx
    for (let n = peakIdx; n < M; n++) {
      let sum = 0
      const lo = Math.max(0, n - half)
      const hi = Math.min(M, n + half + 1)
      const cnt = hi - lo
      for (let j = lo; j < hi; j++) sum += ir[j] * ir[j]
      if (Math.sqrt(sum / cnt) > threshold) lastAbove = n
    }
    const n0 = lastAbove + 1
    if (n0 >= M) return out // 尾部未掉到 −60dB 以下，无需处理

    // 从 n0 起乘 exp 衰减，τ≈50ms
    const tau = 0.05 * this.fs
    for (let n = n0; n < M; n++) {
      out[n] *= Math.exp(-(n - n0) / tau)
    }
    return out
  }
}
