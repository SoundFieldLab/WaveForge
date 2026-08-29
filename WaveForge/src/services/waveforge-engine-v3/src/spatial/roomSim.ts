/**
 * roomSim —— 完整房间模拟（规划书 §4.5：镜像声源法早期反射 1-3 阶 + FDN 晚期混响）
 *
 * 与 Rust 侧 rust/hrtf-core/src/lib.rs 的 RoomState 逐位对拍（对拍容差 1e-5）：
 *   - 预设参数表 ROOM_PRESETS 与 Rust 侧 ROOM_PRESETS 完全一致（改一处必须同步另一处）；
 *   - 镜像声源枚举顺序一致（逐轴逐阶嵌套、轴内选项顺序相同）、延迟取整一致
 *     （round(dist·fs/c)）、增益一致（反射系数^阶/距离²，显式累乘）、
 *     低通系数一致（fc = 8000/(1+阶)）；
 *   - FDN 一致：8 条质数延迟线（按 fs 缩放）、Hadamard 8×8/√8 正交反馈矩阵、
 *     每线 4000Hz 阻尼一阶低通、反馈增益 g = 10^(-3·delay_sec/rt60)（Schroeder 公式）；
 *   - 全程 f64 中间量 + f32 存储（Math.fround 显式舍入），与 Rust 侧 f32 写回语义一致。
 *
 * 信号流（设计决策）：房间只处理"空间化后的信号"——
 *   每 speaker：输入 → 吸收/距离 → HRTF 卷积 → [早期反射（镜像源抽头）] → 湿总线；
 *   湿总线（N 个 speaker 湿路和）→ FDN 输入（/N 归一化）→ FDN 输出混回湿总线；
 *   wet = wetSum + roomAmount·(earlyBus + fdnOut)，最终干湿混合
 *   out = ((1−amount)·dry + amount·wet)·masterGain。
 * room=off 或 roomAmount≤0 或无扬声器时全旁路（输出与无房间逐位一致）。
 *
 * 热路径（early/lateAndMix）：稳态零分配（scratch 按需扩容）。
 * 确定性：同输入同配置必同输出（无随机、无时间依赖）。
 */

import type { RoomPreset, VirtualSpeaker } from './types'

/** 声速（m/s；与 Rust 侧 DOPPLER_C 一致） */
const SPEED_OF_SOUND = 343
/** 度 → 弧度（f64） */
const DEG2RAD = Math.PI / 180
/** 早期反射一阶低通截止基准（Hz）：fc = 8000/(1+阶)，高频吸收随反射次数（与 Rust 侧一致） */
const EARLY_LP_FC_BASE = 8000
/** FDN 阻尼低通截止（Hz，每线相同；与 Rust 侧 FDN_LP_FC 一致） */
const FDN_LP_FC = 4000
/** FDN 质数延迟（样本 @48kHz；按 fs 缩放后四舍五入；与 Rust 侧 FDN_PRIMES 一致） */
const FDN_PRIMES = [179, 211, 251, 307, 359, 419, 467, 521]

/** 房间预设参数（与 Rust 侧 ROOM_PRESETS 元组同值——改一处必须同步另一处） */
export interface RoomPresetParams {
  width: number
  height: number
  depth: number
  /** 反射系数（0..1，逐次反射乘一次） */
  reflectivity: number
  /** 混响时间（秒，FDN 反馈增益基准） */
  rt60: number
}

/** 预设参数表（studio/hall/stage/church/outdoor/bathroom/corridor；与 Rust 侧 ROOM_PRESETS 完全一致） */
export const ROOM_PRESETS: Record<Exclude<RoomPreset, 'off'>, RoomPresetParams> = {
  studio: { width: 5, height: 3, depth: 4, reflectivity: 0.25, rt60: 0.45 }, // 录音棚：小空间短尾
  hall: { width: 25, height: 12, depth: 18, reflectivity: 0.6, rt60: 2.2 }, // 音乐厅：大空间长尾
  stage: { width: 18, height: 8, depth: 14, reflectivity: 0.5, rt60: 1.4 }, // 舞台：纵深宽声场
  church: { width: 30, height: 18, depth: 40, reflectivity: 0.75, rt60: 4.5 }, // 教堂：超长尾
  outdoor: { width: 80, height: 30, depth: 60, reflectivity: 0.15, rt60: 1.2 }, // 户外：弱反射、长延迟
  bathroom: { width: 2.5, height: 2.6, depth: 2.2, reflectivity: 0.9, rt60: 1.8 }, // 浴室：瓷砖高反射
  corridor: { width: 2.2, height: 2.8, depth: 18, reflectivity: 0.5, rt60: 1.6 }, // 走廊：窄长通道
}

/** 房间几何/混响参数（null = 旁路） */
export interface RoomSimParams {
  width: number
  height: number
  depth: number
  reflectivity: number
  /** 早期反射阶数（0..3；0 = 关闭早期反射，只保留 FDN） */
  earlyOrders: number
  rt60: number
}

/** 预设 → 房间参数（off → null；earlyOrders 为早期反射阶数，预设默认 2） */
export function roomParamsFromPreset(preset: RoomPreset, earlyOrders: number): RoomSimParams | null {
  if (preset === 'off') return null
  const p = ROOM_PRESETS[preset]
  return { width: p.width, height: p.height, depth: p.depth, reflectivity: p.reflectivity, earlyOrders, rt60: p.rt60 }
}

/** 镜像声源早期反射抽头（双耳共用延迟/增益；低通状态每耳独立，f32 存储） */
interface EarlyTap {
  /** 延迟（采样，≥1；round(dist·fs/c)） */
  delay: number
  /** 增益 = 反射系数^阶/距离²（1/d² 衰减 × 逐次反射损耗，f32 存储） */
  gain: number
  /** 一阶低通系数 a = exp(-2π·fc/fs)，fc = 8000/(1+阶)（f32 存储） */
  lpCoef: number
  lpStateL: number
  lpStateR: number
}

/**
 * 每扬声器早期反射状态（setConfig 时重建，fresh 零状态）。
 * 双耳**各用独立写指针**（histPosL/histPosR）——若共享指针，两耳 pass 在
 * 块边界交错会导致各自历史环出现永久空洞（某些位置从未被本耳写过，读到陈旧
 * 零值），早期总线输出将与块长相关；独立指针下每耳环随时间连续覆盖，
 * 延迟读与块长无关（与 Rust 侧 SpeakerRoomState 一致）。
 */
interface SpeakerRoomState {
  histL: Float32Array
  histR: Float32Array
  histPosL: number
  histPosR: number
  taps: EarlyTap[]
}

/** FDN 晚期混响状态（每耳 8 条质数延迟线；setConfig 时重建，fresh 零状态） */
class FdnState {
  readonly delays: number[]
  readonly gains: Float32Array
  readonly lpCoefs: Float32Array
  readonly linesL: Float32Array[] = []
  readonly linesR: Float32Array[] = []
  readonly posL: Int32Array
  readonly posR: Int32Array
  readonly lpStateL: Float32Array
  readonly lpStateR: Float32Array
  /** 正交反馈矩阵 H8/√8（Sylvester Hadamard，f64；与 Rust 侧同构造） */
  readonly matrix: number[][] = []
  /** 矩阵乘 scratch（每样本 8 个阻尼后线输出，f64） */
  private readonly v = new Float64Array(8)

  constructor(fs: number, rt60: number) {
    const scale = fs / 48000
    this.delays = FDN_PRIMES.map((p) => Math.max(1, Math.round(p * scale)))
    this.gains = new Float32Array(8)
    this.lpCoefs = new Float32Array(8)
    for (let i = 0; i < 8; i++) {
      const d = this.delays[i]
      // 反馈增益（Schroeder 公式，注释公式）：g = 10^(-3·delay_sec/rt60)
      this.gains[i] = Math.pow(10, (-3 * (d / fs)) / rt60)
      // 阻尼一阶低通：fc = 4000Hz（每线相同）
      this.lpCoefs[i] = Math.exp((-2 * Math.PI * FDN_LP_FC) / fs)
      this.linesL.push(new Float32Array(d))
      this.linesR.push(new Float32Array(d))
    }
    this.posL = new Int32Array(8)
    this.posR = new Int32Array(8)
    this.lpStateL = new Float32Array(8)
    this.lpStateR = new Float32Array(8)
    // Hadamard 8×8 / √8：H[i][k] = (-1)^popcount(i&k)，正交归一（能量不爆炸）
    const inv = 1 / Math.sqrt(8)
    for (let i = 0; i < 8; i++) {
      const row: number[] = []
      for (let k = 0; k < 8; k++) {
        let parity = 0
        let m = i & k
        while (m > 0) {
          parity ^= m & 1
          m >>>= 1
        }
        row.push(parity === 0 ? inv : -inv)
      }
      this.matrix.push(row)
    }
  }

  /**
   * 处理单样本（ear=0 左 / 1 右；input 为已除扬声器数的湿总线样本，f64）。
   * 每样本：①读各线输出 + 阻尼低通 ②矩阵混合 + 反馈写回（input 馈入全部 8 线）
   * ③输出 = Σ 阻尼后线输出。与 Rust 侧 process_sample 逐位对齐（同运算顺序）。
   */
  processSample(ear: number, input: number): number {
    const lines = ear === 0 ? this.linesL : this.linesR
    const pos = ear === 0 ? this.posL : this.posR
    const lpStates = ear === 0 ? this.lpStateL : this.lpStateR
    const v = this.v
    // ① 读 + 阻尼
    for (let i = 0; i < 8; i++) {
      const p = pos[i]
      const read = lines[i][p]
      const a = this.lpCoefs[i]
      const lp = (1 - a) * read + a * lpStates[i]
      lpStates[i] = lp
      v[i] = lp
    }
    // ② 矩阵 + 反馈写回
    for (let i = 0; i < 8; i++) {
      let acc = 0
      const row = this.matrix[i]
      for (let k = 0; k < 8; k++) acc += row[k] * v[k]
      const p = pos[i]
      lines[i][p] = input + this.gains[i] * acc
      const np = p + 1
      pos[i] = np >= this.delays[i] ? 0 : np
    }
    // ③ 输出
    let out = 0
    for (let i = 0; i < 8; i++) out += v[i]
    return out
  }
}

/**
 * 某轴的镜像声源坐标（含该轴反射阶数）：轴上镜像坐标 = 2k·dim ± coord，
 * 按阶分组（顺序与 Rust 侧 axis_images 完全一致）：
 *   0 阶：[coord]（声源自身）；1 阶：[-coord, 2·dim−coord]（两壁各一次）；
 *   2 阶：[2·dim+coord, coord−2·dim]；3 阶：[4·dim−coord, −2·dim−coord]
 */
function axisImages(coord: number, dim: number, order: number): Array<[number, number]> {
  switch (order) {
    case 0:
      return [[coord, 0]]
    case 1:
      return [
        [-coord, 1],
        [2 * dim - coord, 1],
      ]
    case 2:
      return [
        [2 * dim + coord, 2],
        [coord - 2 * dim, 2],
      ]
    default:
      return [
        [4 * dim - coord, 3],
        [-2 * dim - coord, 3],
      ]
  }
}

/** 完整房间模拟（§4.5）：早期反射 + FDN。由后端 setConfig 时创建/重建（fresh 状态）。 */
export class RoomSim {
  private readonly fs: number
  /** 房间混合量（config.roomAmount；≤0 或 off 时旁路）——可变：签名不变复用实例时经
   *  setAmount 热更新（避免重建截断 FDN 混响尾），构造后由后端按配置维护 */
  private roomAmount: number
  private readonly active: boolean
  private readonly speakerCount: number
  private readonly states: SpeakerRoomState[] = []
  private readonly fdn: FdnState | null
  /** 早期反射累加总线（每块零化，双耳；按需扩容） */
  private earlyL: Float32Array = new Float32Array(0)
  private earlyR: Float32Array = new Float32Array(0)

  constructor(fs: number, speakers: VirtualSpeaker[], params: RoomSimParams | null, roomAmount: number) {
    this.fs = fs
    this.roomAmount = roomAmount
    this.speakerCount = speakers.length
    // room=off（params null）/ roomAmount≤0 / 无扬声器 → 全旁路（输出与无房间逐位一致）
    const active = params !== null && roomAmount > 0 && speakers.length > 0
    this.active = active
    if (!active) {
      this.fdn = null
      return
    }
    // 每扬声器镜像声源抽头：听者位于房间中心；声源位置 = 中心 + 距离·方位单位向量
    // （dir 与多普勒 dopplerRate 同构：f32 方位角量化后 f64 计算，显式归一化）
    const cx = params.width / 2
    const cy = params.height / 2
    const cz = params.depth / 2
    const orders = params.earlyOrders
    for (const sp of speakers) {
      const azRad = Math.fround(sp.azimuthDeg) * DEG2RAD
      const elRad = Math.fround(sp.elevationDeg) * DEG2RAD
      const d0 = Math.cos(elRad) * Math.sin(azRad)
      const d1 = Math.sin(elRad)
      const d2 = Math.cos(elRad) * Math.cos(azRad)
      const dlen = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2)
      const sx = cx + sp.distance * (d0 / dlen)
      const sy = cy + sp.distance * (d1 / dlen)
      const sz = cz + sp.distance * (d2 / dlen)
      const taps: EarlyTap[] = []
      let maxDelay = 1
      // 逐轴逐阶嵌套枚举（顺序与 Rust 侧 build_speaker_room 完全一致）
      for (let ox = 0; ox <= orders; ox++) {
        const xs = axisImages(sx, params.width, ox)
        for (let xi = 0; xi < xs.length; xi++) {
          for (let oy = 0; oy <= orders; oy++) {
            const ys = axisImages(sy, params.height, oy)
            for (let yi = 0; yi < ys.length; yi++) {
              for (let oz = 0; oz <= orders; oz++) {
                const zs = axisImages(sz, params.depth, oz)
                for (let zi = 0; zi < zs.length; zi++) {
                  const o = xs[xi][1] + ys[yi][1] + zs[zi][1]
                  if (o < 1 || o > orders) continue
                  const dx = xs[xi][0] - cx
                  const dy = ys[yi][0] - cy
                  const dz = zs[zi][0] - cz
                  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
                  // 延迟（采样）= round(dist·fs/c)，≥1 钳位（与 Rust 侧一致）
                  let delay = Math.floor((dist * fs) / SPEED_OF_SOUND + 0.5)
                  if (delay < 1) delay = 1
                  if (delay > maxDelay) maxDelay = delay
                  // 增益 = 反射系数^阶/距离²（显式累乘 f64，与 Rust 侧逐位一致）
                  let rp = 1
                  for (let k = 0; k < o; k++) rp *= params.reflectivity
                  const gain = rp / (dist * dist)
                  // 高频吸收随反射次数：fc = 8000/(1+阶) Hz
                  const fc = EARLY_LP_FC_BASE / (1 + o)
                  const lpCoef = Math.exp((-2 * Math.PI * fc) / fs)
                  taps.push({ delay, gain: Math.fround(gain), lpCoef: Math.fround(lpCoef), lpStateL: 0, lpStateR: 0 })
                }
              }
            }
          }
        }
      }
      // 历史环长度 = 最大抽头延迟（预分配；双耳独立写指针，见 SpeakerRoomState 注释）
      this.states.push({
        histL: new Float32Array(maxDelay),
        histR: new Float32Array(maxDelay),
        histPosL: 0,
        histPosR: 0,
        taps,
      })
    }
    this.fdn = new FdnState(fs, params.rt60)
  }

  /**
   * 热更新房间混合量（0..1 钳位）：房间签名（预设+扬声器几何+阶数）不变时由后端
   * 复用实例调用——重建会瞬间截断 FDN 混响尾与早期反射历史（可听突变）。
   * active 判定（构造时）不随 amount 热更新：off↔on 切换由后端重建实例表达。
   */
  setAmount(v: number): void {
    this.roomAmount = Math.min(1, Math.max(0, v))
  }

  /** 每块开始时零化早期总线（须早于任何 early() 调用；热路径零分配） */
  beginBlock(n: number): void {
    if (this.earlyL.length < n) {
      this.earlyL = new Float32Array(n)
      this.earlyR = new Float32Array(n)
    }
    this.earlyL.fill(0, 0, n)
    this.earlyR.fill(0, 0, n)
  }

  /**
   * 处理一个扬声器的早期反射（si = 扬声器索引；wetL/wetR = 该扬声器本块湿路，
   * 只读不修改）。每耳整块处理（各自独立写指针）：写历史环 → 逐抽头延迟读/
   * 低通/累加进早期总线。与 Rust 侧 process_block 的早期反射段逐位对齐
   * （同样本顺序、同 f32 舍入；独立指针下输出与块长无关）。
   */
  early(si: number, wetL: Float32Array, wetR: Float32Array, n: number): void {
    if (!this.active) return
    const st = this.states[si]
    const maxD = st.histL.length
    const taps = st.taps
    const earlyL = this.earlyL
    // 左耳整块（独立写指针 histPosL）
    let wp = st.histPosL
    const histL = st.histL
    for (let j = 0; j < n; j++) {
      const w = wetL[j]
      histL[wp] = w
      for (let t = 0; t < taps.length; t++) {
        const tap = taps[t]
        // 延迟读（历史环：写当前样本后回读 delay 前的样本）
        const read = histL[(wp + maxD - tap.delay) % maxD]
        // 一阶低通（高频吸收随反射次数）：y = (1-a)·x + a·y[n-1]
        const a = tap.lpCoef
        const lp = (1 - a) * read + a * tap.lpStateL
        tap.lpStateL = Math.fround(lp)
        // 累加进早期总线（f32 存储，与 Rust 侧一致）
        earlyL[j] += tap.gain * lp
      }
      wp++
      if (wp >= maxD) wp = 0
    }
    st.histPosL = wp
    // 右耳整块（独立写指针 histPosR）
    const histR = st.histR
    const earlyR = this.earlyR
    wp = st.histPosR
    for (let j = 0; j < n; j++) {
      const w = wetR[j]
      histR[wp] = w
      for (let t = 0; t < taps.length; t++) {
        const tap = taps[t]
        const read = histR[(wp + maxD - tap.delay) % maxD]
        const a = tap.lpCoef
        const lp = (1 - a) * read + a * tap.lpStateR
        tap.lpStateR = Math.fround(lp)
        earlyR[j] += tap.gain * lp
      }
      wp++
      if (wp >= maxD) wp = 0
    }
    st.histPosR = wp
  }

  /**
   * FDN 晚期混响 + 混合（就地改写 wetL/wetR，须在所有 speaker 的 early() 之后调用）：
   *   wet += roomAmount·(earlyBus + fdnOut)，fdn 输入 = 湿总线/N（N = 扬声器数）。
   * 与 Rust 侧 process_block 的 FDN 段逐位对齐（每耳整块顺序处理）。
   */
  lateAndMix(wetL: Float32Array, wetR: Float32Array, n: number): void {
    if (!this.active || !this.fdn) return
    const roomAmount = this.roomAmount
    const ns = this.speakerCount
    const earlyL = this.earlyL
    const earlyR = this.earlyR
    for (let j = 0; j < n; j++) {
      const x = wetL[j]
      const fdnOut = this.fdn.processSample(0, x / ns)
      wetL[j] = x + roomAmount * (earlyL[j] + fdnOut)
    }
    for (let j = 0; j < n; j++) {
      const x = wetR[j]
      const fdnOut = this.fdn.processSample(1, x / ns)
      wetR[j] = x + roomAmount * (earlyR[j] + fdnOut)
    }
  }

  /** 清零流式状态（历史环/低通状态/FDN 延迟线与指针；参数保留） */
  reset(): void {
    for (const st of this.states) {
      st.histL.fill(0)
      st.histR.fill(0)
      st.histPosL = 0
      st.histPosR = 0
      for (const t of st.taps) {
        t.lpStateL = 0
        t.lpStateR = 0
      }
    }
    if (this.fdn) {
      for (let i = 0; i < 8; i++) {
        this.fdn.linesL[i].fill(0)
        this.fdn.linesR[i].fill(0)
      }
      this.fdn.posL.fill(0)
      this.fdn.posR.fill(0)
      this.fdn.lpStateL.fill(0)
      this.fdn.lpStateR.fill(0)
    }
  }
}
