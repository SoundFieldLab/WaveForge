// 频谱分析工具：dB 映射（地板/天花板）、逐频段 attack/decay 平滑、频段压缩。
// 借鉴 Echo 的做法：PCM 管线内联 FFT 输出 32 个对数频段（20Hz~12kHz），
// 用 -72dB 地板 / -12dB 天花板做 dB 映射，并做能量/瞬态平滑，最后压缩成少量柱条。

/** 对数频谱下限（Hz）。Echo 从 20Hz 起；旧实现从 45Hz 起，低频不足。 */
export const SPECTRUM_MIN_FREQ = 20
export const SPECTRUM_MAX_FREQ = 12000

/** dB 地板（低于此视为静音）与天花板（高于此视为满格） */
export const SPECTRUM_DB_FLOOR = -72
export const SPECTRUM_DB_CEILING = -12

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/**
 * 将 AnalyserNode/bridge 的 0..255 byte 频谱能量映射为稳定的视觉强度。
 * byte 值本身已经由 AnalyserNode.min/maxDecibels 映射，不能再次按线性幅度转 dB。
 * 固定噪声门和 gamma 曲线保留整体响度差异，避免每帧最大频段总是满格。
 */
export function mapAnalyserByteEnergy(value01: number, noiseGate = 0.035, gamma = 1.35): number {
  const normalized = (clamp01(value01) - noiseGate) / Math.max(1e-6, 1 - noiseGate)
  if (normalized <= 0) return 0
  return clamp01(Math.pow(normalized, gamma))
}

/** 基于真实经过时间的逐频段 attack/release，帧率变化不会改变响应速度。
 *  可传入 out 复用缓冲（30Hz 可视化热路径避免每帧新建 Float32Array 的 GC churn）；
 *  不传时行为与之前一致（新建返回）。 */
export function applyTimedAttackRelease(
  previous: Float32Array | number[],
  current: Float32Array | number[],
  deltaMs: number,
  attackMs = 55,
  releaseMs = 220,
  out?: Float32Array,
): Float32Array {
  const length = Math.min(previous.length, current.length)
  const result = out && out.length >= length ? out : new Float32Array(length)
  const dt = Math.max(0, Math.min(100, Number.isFinite(deltaMs) ? deltaMs : 0))
  for (let index = 0; index < length; index += 1) {
    const prev = clamp01(previous[index] || 0)
    const next = clamp01(current[index] || 0)
    const timeConstant = next >= prev ? Math.max(1, attackMs) : Math.max(1, releaseMs)
    const alpha = 1 - Math.exp(-dt / timeConstant)
    result[index] = prev + (next - prev) * alpha
  }
  return result
}

/**
 * 把 0..1 的线性幅度映射为 dB 刻度下的 0..1。
 * 线性幅度->dB：20*log10(v)。低于地板归 0，高于天花板归 1，中间线性映射。
 * 相比线性/对数压缩，dB 映射让低音量时柱条仍有可见动态，高音量时不会瞬间顶满。
 */
export function spectrumDbMap(value01: number, floorDb = SPECTRUM_DB_FLOOR, ceilingDb = SPECTRUM_DB_CEILING): number {
  const v = clamp01(value01)
  if (v <= 1e-6) return 0
  const db = 20 * Math.log10(v)
  if (db <= floorDb) return 0
  if (db >= ceilingDb) return 1
  return (db - floorDb) / (ceilingDb - floorDb)
}

/**
 * 逐频段 attack/decay 平滑：上升快（attack）、回落慢（decay），
 * 让柱条跟随瞬态有"冲击感"，回落时像能量衰减一样缓缓下降（Echo 的能量/瞬态平滑）。
 */
export function applyAttackDecay(
  previous: Float32Array | number[],
  current: Float32Array | number[],
  attack = 0.1,
  decay = 0.35,
): Float32Array {
  const length = Math.min(previous.length, current.length)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const prev = previous[i] || 0
    const next = current[i] || 0
    const alpha = next >= prev ? attack : decay
    out[i] = prev + (next - prev) * alpha
  }
  return out
}

/**
 * 把 N 段对数频谱压缩为 count 段（Echo 32->12）。按频段边界加权归组，
 * 低频段包含的原始段更少、权重更重，保证压缩后低频仍有可见柱条。
 */
export function compressSpectrumBands(input: Float32Array | number[], count: number): Float32Array {
  const sourceLength = input.length
  const out = new Float32Array(Math.max(1, Math.round(count)))
  if (sourceLength === 0) return out
  const per = sourceLength / out.length
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * per)
    const end = Math.max(start + 1, Math.ceil((i + 1) * per))
    let sum = 0
    for (let k = start; k < end; k += 1) sum += input[k] || 0
    out[i] = sum / (end - start)
  }
  return out
}

/**
 * 按对数频率构建频段边界（Hz）。用于把 AnalyserNode 的 FFT bin 映射到对数频段。
 */
export function buildLogBandEdges(bandCount: number, minFreq = SPECTRUM_MIN_FREQ, maxFreq = SPECTRUM_MAX_FREQ): number[] {
  const edges: number[] = []
  const ratio = Math.log(maxFreq / minFreq)
  for (let k = 0; k <= bandCount; k += 1) {
    edges.push(minFreq * Math.exp((k / bandCount) * ratio))
  }
  return edges
}
