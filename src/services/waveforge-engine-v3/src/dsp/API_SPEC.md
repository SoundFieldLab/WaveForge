# v3 DSP 模块 API 契约（子代理实现规范）

> 本文件是 waveforge-engine-v3 各 DSP 模块的**唯一实现契约**。所有子代理严格按此签名实现，
> 不得自行改签名；类型一律从 `../types` 导入（`import type { ... } from '../types'`）。

## 通用约定

1. **纯 TS、零运行时依赖**：只允许 import 类型；不 import 任何 npm 包（meyda/signalsmith-stretch 为可选，由适配层决定）。
2. 每个文件头必须写许可证/出处注释（见各模块要求）；注释与中文说明为主，UTF-8 编码。
3. 确定性：同输入同参数必同输出；不得使用 Math.random、Date、console。
4. 采样缓冲一律 Float32Array；单声道模块处理单声道，立体声模块签名 `(l: Float32Array, r: Float32Array)`。
5. 类接口统一：`constructor(fs: number)`、`setParams(p: XxxSettings)`、`reset(): void`、`process*(): ...`。
6. 参数更新即时生效（系数重算），处理过程中禁止分配新对象（预分配缓冲）。
7. 边界安全：频率/增益/Q 做 clamp；避免 NaN/Infinity；fs<=0 时抛 `Error('invalid sample rate')`。
8. 测试：每个模块配 `test/<module>.test.ts`，用 vitest；断言数值用容差（1e-3 级），注释说明物理意义。
9. 边界（严格遵守）：
   - **允许读取**：`src/types.ts`、`src/dsp/API_SPEC.md`（本文件）、`research/docs/*.md`（算法参考：技术文档/设计文档/决策表）、`research/notes/`；
   - **禁止读取**：`docs/`（逆向分析文档，另一个对话的产物）、`decompiled/`、`business-code/`、`apktool-out/`、`reference/`、`WaveForge/src/services/audio-effects-v3/`（另一个对话正在做的工作）；
   - **禁止写入**：除自己负责的文件外的一切文件；WaveForge/、research/、docs/ 一律只读；
   - **禁止修改**：`src/types.ts`、`src/dsp/API_SPEC.md`、其他子代理的文件。

---

## 模块 1：src/dsp/fft.ts —— 复 FFT + 窗函数（自研，参考 kissfft 蝶形思路，BSD-3）

```ts
/** 原位基-2 复 FFT。real/imag 等长且为 2 的幂；inverse=true 时做逆变换并除以 N。长度非 2 的幂抛错。 */
export function fft(real: Float32Array, imag: Float32Array, inverse: boolean): void
/** 大于等于 n 的最小 2 的幂 */
export function nextPow2(n: number): number
/** Hann 窗 */
export function hannWindow(n: number): Float32Array
/** 由实信号实数 FFT 幅度谱（N/2+1 个 bin，含直流与 Nyquist） */
export function magnitudeSpectrum(real: Float32Array, imag: Float32Array): Float32Array
/** 频率轴：N 点 FFT、采样率 fs，返回 N/2+1 个 bin 的中心频率 Hz */
export function frequencyBins(n: number, fs: number): Float32Array
```

测试要点：脉冲 → 幅度谱全 1；正弦 440Hz@N=1024,fs=48000 → 峰值 bin 在 440Hz 附近；逆变换往返误差 <1e-6。

---

## 模块 2：src/dsp/biquad.ts —— RBJ 双二阶（概念源自 RBJ Audio EQ Cookbook 公开公式 + DSPFilters(MIT) TDF2 思路）

```ts
export type BiquadType = 'peaking' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass' | 'bandpass' | 'notch' | 'allpass'
export interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number }
/** RBJ 系数设计（BLT 预畸变内置）。f0 必须 0<f0<fs/2；q>0；gainDb 仅 peaking/shelf 使用 */
export function designBiquad(type: BiquadType, f0: number, q: number, gainDb: number, fs: number): BiquadCoeffs
export class Biquad {
  constructor(type?: BiquadType, f0?: number, q?: number, gainDb?: number, fs?: number)
  setCoeffs(c: BiquadCoeffs): void
  setParams(type: BiquadType, f0: number, q: number, gainDb: number): void
  /** TDF2 处理单样本，返回 y */
  process(x: number): number
  processBlock(input: Float32Array, output: Float32Array): void
  reset(): void
  /** 在给定频率处求 |H(e^jw)|（单位增益），用于级联响应测量 */
  magnitudeAt(freqHz: number, fs: number): number
}
```

测试要点：peaking 0dB 增益 → 全频带增益≈1；peaking +6dB@1kHz Q1 在 1kHz 处幅度≈2（±2%）；lowpass 截止 1kHz 在 10kHz 明显衰减（>20dB）；lowshelf 与 highshelf 公式对称性（同增益抵消后≈0dB）；TDF2 处理正弦无发散（10000 样本幅度稳定）。

---

## 模块 3：src/dsp/EqChain.ts —— 多段 EQ 级联 + Q 补偿（20 段，v3 核心，技术文档 §1.3）

```ts
export interface EqBandParam { frequency: number; gain: number; q: number }
export class EqChain {
  constructor(fs: number, bandCount?: number) // 默认 20
  setBands(bands: EqBandParam[]): void          // 重算系数；若 qCompensation=true 则先做补偿迭代
  setQCompensation(enabled: boolean): void
  /** 级联幅频响应测量：返回各控制频率处的线性幅度（对应传入频率点） */
  responseAt(freqs: number[]): Float32Array
  process(x: number): number
  processBlock(input: Float32Array, output: Float32Array): void
  processStereo(l: Float32Array, r: Float32Array): void // 就地处理
  reset(): void
}
```

Q 补偿算法（自研）：① 用当前 bands 在各自中心频率处测级联响应；② 误差 e_i=目标(线性 10^(gain/20))−实测；
③ gain_i ← gain_i + 0.8·20·log10(e_i 修正)，迭代 2–3 次直到最大误差 <0.05dB 或达 5 次；
④ 补偿只在 qCompensation 开启时进行，结果仍存回内部系数。
测试要点：相邻 peaking 同时 +6dB（Q 1.5，间隔 1/2 octave）时，级联响应在控制点误差 <0.1dB；
全 0dB → 响应平直 ±0.02dB；20 段级联白噪声处理不产生 NaN。

---

## 模块 4：src/dsp/MidSide.ts —— M/S 编解码 + 宽度/人声比例（自研，技术文档 §8）

```ts
export class MidSide {
  constructor()
  /** width 0..2（1=原始），voiceBalance -1..1（-1=仅伴奏(侧信号) / +1=仅人声(中信号)） */
  setParams(width: number, voiceBalance: number): void
  /** 就地编解码：输入立体声，输出处理后的立体声（M/S 域处理 → 反变换） */
  processStereo(l: Float32Array, r: Float32Array): void
  reset(): void
}
```

实现：M=(L+R)*0.5, S=(L-R)*0.5；逆变换 L'=M·midGain+S·sideGain、R'=M·midGain−S·sideGain。
人声比例（对称衰减语义，审计修复 M-2）：midGain = 1+min(0,vb)、sideGain = width·(1−max(0,vb))——
vb=+1 → 仅人声（侧信号 0）；vb=−1 → 仅伴奏（中信号 0）；vb=0,width=1 恒等（逐样本一致 ±1e-7）。
测试要点：pass-through 恒等；width=0 → L==R；vb=+1 → S 分量≈0（L≈R 输入时）。

---

## 模块 5：src/dsp/Deesser.ts —— 动态齿音抑制（自研，技术文档 §4）

```ts
export class Deesser {
  constructor(fs: number)
  setParams(p: DeesserSettings): void
  processStereo(l: Float32Array, r: Float32Array): void
  reset(): void
}
```

实现：侧链带通(centerHz,q) 提取齿音频段 → 包络（平方+一阶平滑，attack 1ms/release 80ms）→
dB 域阈值压缩（超过 thresholdDb 的部分按 ratio 衰减）→ 分带式：只把增益作用到高频带信号再与原信号混合；
宽带式：直接作用整体。mix 混合干湿。
测试要点：8kHz 正弦（齿音频段）超阈值时输出明显衰减（>3dB）；200Hz 正弦不受影响（<0.1dB 变化）；
enabled=false 时输出=输入。

---

## 模块 6：src/dsp/Compressor.ts —— 动态压缩（v2 兼容 + knee，技术文档 §3）

```ts
export class Compressor {
  constructor(fs: number)
  setParams(p: CompressorSettings): void
  processStereo(l: Float32Array, r: Float32Array): void
  reset(): void
  /** 当前增益衰减 dB（<=0） */
  getReductionDb(): number
}
```

实现：立体声联合包络（max(|L|,|R|)）→ 平滑（attack/release，一阶或双时间常数）→ dB 域软拐点曲线 →
makeup 补偿 → outputGain。测试：恒定 0dBFS 正弦、threshold -20dB ratio 4 → 稳态输出 ≈ -20dBFS 之上
每 +4dB 输入只 +1dB 输出；attack/release 时域平滑无跳变。

---

## 模块 7：src/dsp/Limiter.ts —— 前瞻限幅器 + 真峰值（自研，技术文档 §3.3）

```ts
export class Limiter {
  constructor(fs: number)
  setParams(p: LimiterSettings): void
  processStereo(l: Float32Array, r: Float32Array): void
  reset(): void
  getReductionDb(): number
  /** 引入的延迟（样本数）= lookahead 样本 */
  getLatencySamples(): number
}
```

实现：输入延迟 lookaheadMs 后输出；检测窗峰值（truePeak 时对窗做 4× 过采样窗口 sinc 插值取峰）；
g=min(1, 10^(thresholdDb/20)/peak)；对 g 做 attack/release 一阶平滑后施加。
测试要点：3kHz 正弦 0dBFS、threshold -1dBFS → 输出峰值 ≤ -0.95dBFS（±0.1dB）；
enabled=false 通过；突然方波无过冲超阈值（lookahead 生效）。

---

## 模块 8：src/dsp/BassEnhancer.ts —— 虚拟低频（自研，技术文档 §5）

```ts
export class BassEnhancer {
  constructor(fs: number)
  setParams(p: BassEnhancerSettings): void
  processStereo(l: Float32Array, r: Float32Array): void
  reset(): void
}
```

实现：LPF(cutoffHz,q) 提取低频 → 非线性（odd: x³ / even: 全波整流 / atan: atan(√|x|)·sign / soft: tanh(g·x)）→
HPF(≥150Hz 或 cutoffHz*1.5，取较大) 整形 → harmonicGain×mix 混回。
测试要点：60Hz 正弦 + 小音箱场景 → 输出含 120/180Hz 谐波分量（FFT 验证峰值存在）；
无输入无输出；enabled=false 恒等。

---

## 模块 9：src/dsp/Convolver.ts —— 分区卷积混响 + IR 去周期化（自研，技术文档 §2.1）

```ts
export interface ConvolverOptions { partitionSize?: number; dePeriodize?: boolean }
export class Convolver {
  constructor(fs: number, opts?: ConvolverOptions)
  /** 载入单声道 IR；dePeriodize=true 时先做去周期化（尾部指数衰减窗）；空/非法 IR 抛错 */
  loadIR(ir: Float32Array, irName?: string): void
  setMix(mix: number): void
  setPreDelayMs(ms: number): void
  /** wet+preDelay 处理单声道，返回新数组或就地？——返回新 Float32Array（长度=input 长度+IR 尾） */
  process(x: Float32Array): Float32Array
  processStereo(l: Float32Array, r: Float32Array): void // 就地 wet/dry 混合输出
  getLatencySamples(): number
  reset(): void
}
```

实现：均匀分区卷积（分区长默认 512）：IR 分成 P 块，每块 FFT 预计算；输入分块与各分区频域相乘、
按分区索引延迟累加、overlap-add。FFT 用自研 fft.ts（N=nextPow2(2*partitionSize)）。
去周期化：从 IR 能量包络峰值后 -60dB 点开始乘 exp 衰减（τ≈50ms），保证循环无周期伪影。
测试要点：IR=[1] → 输出≈输入（+preDelay 延迟）；IR=delta 延迟 D → 输出为延迟 D 的输入；
指数衰减 IR 的湿输出能量随时间单调衰减（无周期回升）。

---

## 模块 10：src/dsp/ReverbSimple.ts —— 算法混响（Freeverb 类，结构源自 Jezar 公有域实现 / stk FreeVerb(MIT) 思路）

```ts
export interface ReverbSimpleParams {
  roomSize: number; damping: number; wet: number; dry: number; preDelayMs: number; width: number; type: ReverbType
}
export class ReverbSimple {
  constructor(fs: number)
  setParams(p: ReverbSimpleParams): void
  processStereo(l: Float32Array, r: Float32Array): void
  reset(): void
}
```

实现：8 立体声梳状 + 4 全通（Freeverb 结构），type 映射房间参数表（hall 长尾 0.7/0.4、room 短 0.4/0.6、
plate 亮 0.6/0.2、spring 特殊 0.3/0.8 等，自行定义合理表并注释）；preDelay 用延迟线。
测试要点：impulse 输入 → 输出能量衰减包络单调下降（无发散）；wet=0 → 输出=干声；
干湿功率比接近设定（±10%）。

---

## 模块 11：src/dsp/LufsMeter.ts —— ITU-R BS.1770 响度测量（自研，标准公开公式，技术文档 §7）

```ts
export class LufsMeter {
  constructor(fs: number) // 支持 44100/48000（其余采样率按 48k 系数近似并注释说明）
  processStereo(l: Float32Array, r: Float32Array): void
  /** 整合响度 LUFS（门限后），未测到则 NaN */
  getIntegratedLufs(): number
  /** 短时(3s)/瞬时(400ms)响度 */
  getMomentaryLufs(): number
  getShortTermLufs(): number
  getLra(): number
  getPeakDb(): number
  /** 真峰值 dB（4× 过采样） */
  getTruePeakDb(): number
  reset(): void
}
```

实现：K 加权两级滤波（RLB 高通 + 高频 shelf，48k 标准系数表内置）→ 400ms 窗/100ms 步进 →
绝对门限 -70 LUFS → 相对门限 (均值-10LU) → 整合 LUFS；LRA=直方图 10/95 百分位差。
测试要点：1kHz 满刻度正弦 → 积分响度 ≈ -3.01 LUFS（±0.5，纯音能量）；静音 → NaN；
门限逻辑：长静音段不拉低整合值。

---

## 模块 12：src/dsp/LoudnessComp.ts —— 等响度补偿（ISO 226 思路，自研，技术文档 §6）

```ts
export interface LoudnessCompParams {
  volumePercent: number; maxBoostDb: number; preset: string; bands: { frequency: number; gain: number }[];
  mode: CompensationMode; smoothingSeconds: number
}
export class LoudnessComp {
  constructor(fs: number)
  setParams(p: LoudnessCompParams): void
  processStereo(l: Float32Array, r: Float32Array): void
  reset(): void
}
```

实现：内置 1/3 倍频程"等响度近似"增益表（低频 0–12dB、高频 0–6dB，随 volumePercent 线性，v2 语义：
低频系数 0.35、高频 0.15，100%→0dB；mid 保持 0dB）→ 拟合为 2–6 段 biquad（low shelf 120Hz Q0.707、
high shelf 12kHz Q0.707 + custom 段 peaking）→ 增益平滑（smoothingSeconds，一阶）。
注意：表数据在注释中标注"ISO 226 简化近似（v2 兼容），正式发布前可与官方表核对"。
测试要点：volumePercent=100 → 增益≈0dB（全频）；volumePercent=20 → 低频 120Hz 处响应提升 >3dB、
1kHz 处 ≈0dB（±0.3dB）；平滑切换不产生跳变。

---

## 模块 13：src/dsp/Resampler.ts —— 多相重采样（自研，speexdsp 多相 FIR 思路，BSD-3 参考）

```ts
export class Resampler {
  constructor(inRate: number, outRate: number, channels?: number, quality?: number) // quality 0..10 默认 8
  /** 返回重采样后数据（长度=输入长度*outRate/inRate，约等） */
  process(input: Float32Array): Float32Array
  /** 清空内部状态（流式分段处理时用） */
  reset(): void
  /** 保持内部缓冲区，返回当前可用输出（流式） */
  processStreaming(input: Float32Array, out: Float32Array): number
}
```

实现：窗口化 sinc（Kaiser 窗，taps 随 quality：8→64、10→128）多相插值，分数相位累加；
首尾做边缘处理避免爆音。测试要点：440Hz 正弦 44.1k→48k → 输出频率 440±0.5Hz；
能量守恒（RMS 误差 <1%）；44.1k→44.1k 恒等（±1e-6）。

---

## 模块 14：src/dsp/Stretch.ts —— 变速/变调（相位声码器自研 + signalsmith-stretch(MIT) 可选适配，技术文档 §9）

```ts
export interface StretchParams { semitones: number; rate: number }
export class Stretch {
  constructor(fs: number, channels?: number) // 默认 2
  setParams(p: StretchParams): void
  /** 变速不变调处理立体声（输出长度≈输入*rate） */
  processStereo(l: Float32Array, r: Float32Array): { l: Float32Array; r: Float32Array }
  reset(): void
  /** 若安装了 signalsmith-stretch 则用其 WASM 实现（动态 import，失败回退自研相位声码器） */
  static isSignalsmithAvailable(): Promise<boolean>
}
```

实现（自研）：STFT（Hann，N=2048，hop 512）→ 相位声码器（相位差→瞬时频率→按 rate 累积相位）→
ISTFT overlap-add；semitones 通过频谱频率搬移（或与 rate 组合：pitchScale=2^(semitones/12)，
时间伸缩=rate，频率缩放=pitchScale*rate?——按标准相位声码器语义：时间伸缩=rate，
频率伸缩=2^(semitones/12)，两者独立）。
测试要点：rate=2 时输出长度≈2×输入（±3%）；440Hz 正弦 rate=1, semitones=+12 → 输出 ≈880Hz（±1%）；
信号功率量级保持（±3dB）。

---

## 模块 15：src/dsp/PitchYin.ts —— YIN 音高检测（自研，公开算法，技术文档 §10.1）

```ts
export interface YinOptions { threshold?: number; minHz?: number; maxHz?: number; usePrevious?: boolean }
/** 返回基频 Hz；未检出返回 -1 */
export function yinPitch(mono: Float32Array, fs: number, opts?: YinOptions): number
```

实现：差分函数 → CMND 归一化 → 绝对阈值(0.1)找谷 → 抛物线插值 → (可选)上一帧邻域约束。
测试要点：440Hz 正弦（窗长 2048@48k）→ 440±1Hz；220Hz → 220±1；纯噪声 → -1 或明显偏离（不崩）。

---

## 模块 16：src/dsp/features.ts —— 频谱特征（meyda 式概念自研，MIT 参考，技术文档 §12）

```ts
export interface FeatureInput { magnitudes: Float32Array; binFreqs: Float32Array; rms?: number }
export function computeFeatures(input: FeatureInput): SpectralFeatures
export function computeRms(x: Float32Array): number
export function computeZcr(x: Float32Array): number
export function spectralCentroid(mags: Float32Array, freqs: Float32Array): number
export function spectralRolloff(mags: Float32Array, freqs: Float32Array, percentile?: number): number
export function spectralFlatness(mags: Float32Array): number
export function spectralCrest(mags: Float32Array): number
```

测试要点：白噪声（幅度谱平坦）→ flatness≈1（>0.9）、centroid 居中；单音 → flatness≈0（<0.1）、
centroid≈音高频率；zcr 白噪声 > 正弦。

---

## 辅助模块契约（engine / worklet / analysis / device / offline / codec）

### A. src/engine/EngineV3.ts —— 引擎总成（F1 负责）
```ts
import type { V3EngineParams, EngineStats, EngineAnalysis } from '../types'
import { Stretch } from '../dsp/Stretch'
export class EngineV3 {
  constructor(sampleRate: number, channelCount?: number) // 默认 2
  setParams(p: V3EngineParams): void
  /** 就地处理：outputs[i] 写入处理结果（长度=inputs[i].length） */
  process(inputs: Float32Array[], outputs: Float32Array[]): void
  getStats(): EngineStats
  getAnalysis(): EngineAnalysis // 内部 FFT(2048, Hann) 频谱 + 特征；每 N 帧更新一次
  getLatencySamples(): number
  /** 变速/变调处理器（不内联进主链；供 gapless/过渡场景调用） */
  getStretch(): Stretch
  reset(): void
}
```
链顺序（设计文档 §2）：输入 → 响度归一化增益 → M/S(voiceBalance+width) → **Pre-EQ**(EqChain) → Deesser → Compressor → NightMode → 混响(convolution|algorithmic|off) → BassEnhancer → LoudnessComp → IEQ(Post) → Limiter → 输出；LUFS 计在 Limiter 之前取样。
实现要点：所有系数在 setParams 中预计算；process 内零分配；NightMode=压缩增强(ratio×1.5,threshold-6dB)+6kHz 高频 shelf 衰减(amount×1.5dB)。

### B. src/engine/ScenePresets.ts —— 11 个组合场景（F1 负责）
```ts
import type { ScenePreset } from '../types'
export const SCENE_PRESETS: ScenePreset[]
export function getSceneById(id: string | null): ScenePreset | null
export const SCENE_IDS: string[] // 11 个 id：pop/rock/jazz/dance/classical/livehouse/studio/warm/dts/vocal-stage/night-bass
```
11 场景（流行/摇滚/爵士/舞曲/古典/LiveHouse/录音棚/温暖/DTS浩渺/悠扬舞台/深夜低音），每个为完整参数快照
（EQ 曲线 + 混响类型/干湿 + 压缩 + 低音 + 齿音等），用 createDefaultParams 派生后覆盖。

### C. src/engine/ShareCodec.ts —— 分享串（F2 负责）
```ts
import type { V3EngineParams } from '../types'
export const SHARE_CODEC_VERSION = 1
/** 序列化：版本 + JSON(去 IR 数组→irName) + FNV-1a 校验 → base64url */
export function encodeShareCode(p: V3EngineParams): string
/** 反序列化：校验 + 白名单字段 + 数值 clamp；非法输入抛 Error */
export function decodeShareCode(s: string): V3EngineParams
```

### D. src/worklet/AudioEffectsProcessor.ts —— AudioWorklet 处理器（F2 负责）
```ts
import { EngineV3 } from '../engine/EngineV3'
export const WORKLET_PROCESSOR_NAME = 'waveforge-v3-effects'
export class AudioEffectsProcessor extends AudioWorkletProcessor {
  constructor() // 用全局 sampleRate 创建 EngineV3；port.onmessage 接 {type:'params'|'reset'}
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean
}
// 文件末尾：typeof registerProcessor !== 'undefined' && registerProcessor(WORKLET_PROCESSOR_NAME, AudioEffectsProcessor)
// 注意注释：AudioWorklet 运行时不支持裸 import，融合时需打包为单文件（esbuild/vite worklet 插件）。
```

### E. src/analysis/Spectrum.ts —— 频谱分析器（F2 负责）
```ts
import type { SpectralFeatures } from '../types'
export class SpectrumAnalyzer {
  constructor(fftSize: number, fs: number) // fftSize 默认 2048
  processStereo(l: Float32Array, r: Float32Array): void // 就地分析（取 L 通道，Hann 窗）
  getMagnitudes(): Float32Array // N/2+1 bins
  getFeatures(): SpectralFeatures
  reset(): void
}
```

### F. src/analysis/HearingTest.ts —— 听力分析流程（F2 负责）
```ts
export interface AudiogramPoint { freqHz: number; thresholdDb: number }
export class HearingTest {
  constructor(fs: number)
  begin(): void
  /** 返回当前测试步骤（频率 + 播放电平 dB）；全部完成返回 null */
  nextStep(): { freqHz: number; levelDb: number } | null
  /** 用户回答是否听到（二分逼近阈值） */
  answer(heard: boolean): void
  getAudiogram(): AudiogramPoint[]
  reset(): void
}
```
频点：125/250/500/1000/2000/4000/8000 Hz；电平 -60..0 dB 二分 5 轮。

### G.（已移除）设备频响档案 DeviceProfile

> **2026-08 需求变更：机型频响补偿不再使用真实设备档案**，改为**按音量大小实施补偿的通用曲线**——
> 由 `dsp/LoudnessComp.ts` 的 `auto` 模式承担（音量越低 → 低频 0-12dB / 高频 0-6dB 提升，
> 120Hz/12kHz shelf，v2 兼容公式 0.35/0.15）。原 `src/device/DeviceProfile.ts`（6 示例档案 +
> fitParametricEq 拟合）与 `V3EngineParams.deviceProfile` 字段已整体删除（编号不回填，后续模块保持原编号）。

### H. src/offline/Separator.ts —— 声源分离任务队列（F2 负责，spleeter/demucs 适配层）
```ts
export type SeparationStem = 'vocals' | 'drums' | 'bass' | 'other'
export interface StemSeparatorAdapter {
  separate(input: Float32Array, stems: SeparationStem[], onProgress?: (p: number) => void): Promise<Record<string, Float32Array>>
}
export interface SeparationTask { id: number; state: 'queued' | 'running' | 'done' | 'cancelled' | 'failed'; stems: SeparationStem[]; error?: string }
export class SeparationQueue {
  constructor(adapter: StemSeparatorAdapter)
  enqueue(input: Float32Array, stems?: SeparationStem[]): SeparationTask
  cancel(taskId: number): void
  getTasks(): SeparationTask[]
  onProgress?: (taskId: number, p: number) => void
  onComplete?: (taskId: number, stems: Record<string, Float32Array>) => void
}
export class OnnxStemSeparator implements StemSeparatorAdapter { /* 占位：接 ONNX Runtime Web 后实现；当前 separate() 抛 Error('ONNX adapter not implemented') */ }
export const DEFAULT_STEMS: SeparationStem[] = ['vocals', 'drums', 'bass', 'other']
```