/**
 * StretchLgplAdapter —— 以"不修改、仅链接调用"方式接入 LGPL-2.1 的 soundtouchjs（SoundTouch 核心）
 *
 * LGPL-2.1 合规（用户策略：动态/静态链接、不修改 LGPL 源码即可使用打包）：
 *  - 本文件不含任何 LGPL 代码副本；soundtouchjs 为独立 npm 依赖（optionalDependencies），
 *    运行时通过动态 import() 加载其原包并调用公开 API（SoundTouch 类），未修改其源码；
 *  - 分发时随附其 LICENSE（LGPL-2.1）与源码获取方式（npm 包即源码，可重新链接/替换）；
 *  - 未安装该依赖时本适配器返回 null，调用方回退到自研相位声码器（Stretch.ts）。
 *
 * 参数语义（SoundTouch 经典约定）：
 *  - tempo = 播放速度倍数（SoundTouch 语义：tempo=2 表示"快一倍"，输出时长 = 输入/tempo）。
 *    因此时长伸缩 rate（输出时长 = 输入×rate）映射为 tempo = 1/rate；
 *  - pitch（音高因子）= 2^(semitones/12)；pitch 与 tempo 独立（pitch 内部用
 *    "变速 + 重采样"组合实现时长不变的变调）；
 *  - 帧 = 采样对（立体声交错 L,R,L,R...）；FifoSampleBuffer.putSamples/extract 的
 *    position/numFrames 均以"帧"为单位。
 */

export interface StretchLgplAdapter {
  /** 是否成功加载 LGPL 库（未安装时 false） */
  readonly available: boolean
  /** semitones -10..+10；rate 0.25..3.0（与 v2 PitchSettings 范围一致） */
  setParams(semitones: number, rate: number): void
  /**
   * 喂入一个立体声块并返回本轮新产出的输出。
   * 注意：SoundTouch 内部有约 100ms 处理延迟，流式调用早期输出较少、
   * 结尾需继续喂入零样本（约 0.8s）才能把尾部冲出来（与 Convolver 尾块语义一致）。
   * 输出长度不定；稳态下总量 ≈ 输入总量 × rate。
   */
  processStereo(l: Float32Array, r: Float32Array): { l: Float32Array; r: Float32Array }
  reset(): void
}

/** 模块级缓存：避免重复动态 import（确定性） */
let cachedModule: unknown = undefined

async function loadSoundTouchModule(): Promise<unknown> {
  if (cachedModule !== undefined) return cachedModule
  try {
    const mod = await import('soundtouchjs')
    cachedModule = mod
  } catch {
    cachedModule = null
  }
  return cachedModule
}

/** 创建 LGPL 适配器；soundtouchjs 不可用时返回 null（回退自研相位声码器） */
export async function createStretchLgplAdapter(): Promise<StretchLgplAdapter | null> {
  const mod = (await loadSoundTouchModule()) as { SoundTouch?: new () => LgplSoundTouch } | null
  if (!mod || typeof mod.SoundTouch !== 'function') return null
  const factory = () => new (mod as { SoundTouch: new () => LgplSoundTouch }).SoundTouch()
  const touch = factory()
  return new SoundTouchAdapter(touch, factory)
}

/** soundtouchjs 公开 API 的最小类型描述（仅声明用到的成员；库本体未修改） */
interface LgplSoundTouch {
  tempo: number
  pitch: number
  process(): void
  clear(): void
  inputBuffer: LgplBuffer
  outputBuffer: LgplBuffer
}
interface LgplBuffer {
  frameCount: number
  putSamples(samples: Float32Array, position: number, numFrames: number): void
  receiveSamples(output: Float32Array, numFrames: number): void
  clear(): void
}

class SoundTouchAdapter implements StretchLgplAdapter {
  readonly available = true
  private touch: LgplSoundTouch
  private readonly factory: () => LgplSoundTouch
  private semitones = 0
  private rate = 1

  // 交错工作缓冲（复用，processStereo 内零分配；长度不足时惰性扩容）
  private interleaveBuf: Float32Array = new Float32Array(0)
  private deinterleaveBuf: Float32Array = new Float32Array(0)

  constructor(touch: LgplSoundTouch, factory: () => LgplSoundTouch) {
    this.touch = touch
    this.factory = factory
    this.touch.tempo = 1
    this.touch.pitch = 1
  }

  setParams(semitones: number, rate: number): void {
    const s = Math.min(10, Math.max(-10, semitones))
    const r = Math.min(3, Math.max(0.25, rate))
    if (s === this.semitones && r === this.rate) return
    this.semitones = s
    this.rate = r
    // SoundTouch tempo 是播放速度：输出时长 = 输入 × (1/tempo) → tempo = 1/rate
    this.touch.tempo = 1 / r
    this.touch.pitch = Math.pow(2, s / 12)
  }

  processStereo(l: Float32Array, r: Float32Array): { l: Float32Array; r: Float32Array } {
    const B = Math.min(l.length, r.length)
    if (B === 0) return { l: new Float32Array(0), r: new Float32Array(0) }
    // 交错后送入（未修改库：只调公开 API）
    if (this.interleaveBuf.length < B * 2) this.interleaveBuf = new Float32Array(B * 2)
    const ib = this.interleaveBuf
    for (let i = 0; i < B; i++) {
      ib[2 * i] = l[i]
      ib[2 * i + 1] = r[i]
    }
    this.touch.inputBuffer.putSamples(ib, 0, B)
    this.touch.process()
    // 排出本轮全部可用输出帧
    const frames = this.touch.outputBuffer.frameCount
    if (frames === 0) return { l: new Float32Array(0), r: new Float32Array(0) }
    if (this.deinterleaveBuf.length < frames * 2) this.deinterleaveBuf = new Float32Array(frames * 2)
    const ob = this.deinterleaveBuf
    this.touch.outputBuffer.receiveSamples(ob, frames)
    const outL = new Float32Array(frames)
    const outR = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      outL[i] = ob[2 * i]
      outR[i] = ob[2 * i + 1]
    }
    return { l: outL, r: outR }
  }

  reset(): void {
    // 重建全新 SoundTouch 实例：clear() 无法清掉 RateTransposer 内部滤波器状态，
    // 只有重建才能保证"reset 后与全新实例一致"
    this.touch = this.factory()
    this.touch.tempo = this.rate === 0 ? 1 : 1 / this.rate
    this.touch.pitch = Math.pow(2, this.semitones / 12)
  }
}
