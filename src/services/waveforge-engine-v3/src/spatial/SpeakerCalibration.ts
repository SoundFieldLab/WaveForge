import type { SpeakerCancellationSettings } from './CrosstalkCancellation'

/** 世界坐标：x 向右、y 向前、z 向上，单位米。 */
export interface CalibrationPoint { x: number; y: number; z: number }

export interface SpeakerGeometry {
  leftSpeaker: CalibrationPoint
  rightSpeaker: CalibrationPoint
  listener: CalibrationPoint
  /** 向右转头为正；0 度面对 +y。 */
  listenerYawDeg?: number
  earSpacingM?: number
  speedOfSoundMps?: number
  sampleRate?: number
}

/** 分别播放左右测试信号并反卷积所得的四条 IR，四者必须共享采样时钟和时间零点。 */
export interface BinauralSpeakerMeasurement {
  sampleRate: number
  leftSpeakerToLeftEar: Float32Array | Float64Array
  leftSpeakerToRightEar: Float32Array | Float64Array
  rightSpeakerToRightEar: Float32Array | Float64Array
  rightSpeakerToLeftEar: Float32Array | Float64Array
  /** 仅分析直达声后的短窗，默认 5ms；不把晚期混响拟合进递归逆滤波。 */
  directWindowMs?: number
}

export interface SpeakerPathEstimate {
  directArrivalMs: number
  crossArrivalMs: number
  relativeDelayMs: number
  crossGain: number
  cutoffHz: number
}

export interface SpeakerCalibrationResult {
  method: 'geometry' | 'measured-ir'
  settings: SpeakerCancellationSettings
  leftSpeaker: SpeakerPathEstimate
  rightSpeaker: SpeakerPathEstimate
  asymmetry: {
    delayDifferenceMs: number
    gainDifferenceDb: number
    cutoffRatio: number
    exceedsSymmetricModel: boolean
  }
  /** 近似、钳位或无法表示的摆位不对称都会明确列出。 */
  limitations: string[]
}

const finite = (value: number, label: string, min: number, max: number): number => {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${label} 超出有效范围`)
  return value
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function result(method: SpeakerCalibrationResult['method'], leftSpeaker: SpeakerPathEstimate,
  rightSpeaker: SpeakerPathEstimate, sampleRate: number, limitations: string[]): SpeakerCalibrationResult {
  const delayDifferenceMs = Math.abs(leftSpeaker.relativeDelayMs - rightSpeaker.relativeDelayMs)
  const gainDifferenceDb = Math.abs(20 * Math.log10(leftSpeaker.crossGain / rightSpeaker.crossGain))
  const cutoffRatio = Math.max(leftSpeaker.cutoffHz, rightSpeaker.cutoffHz) /
    Math.min(leftSpeaker.cutoffHz, rightSpeaker.cutoffHz)
  const exceedsSymmetricModel = delayDifferenceMs > 0.05 || gainDifferenceDb > 1 || cutoffRatio > 1.5
  if (exceedsSymmetricModel) limitations.push('左右声路不对称超出单组参数的近似范围；建议重新居中摆位或分别测量后使用非对称滤波器。')
  const delay = (leftSpeaker.relativeDelayMs + rightSpeaker.relativeDelayMs) / 2
  const gain = Math.sqrt(leftSpeaker.crossGain * rightSpeaker.crossGain)
  const cutoff = Math.min(leftSpeaker.cutoffHz, rightSpeaker.cutoffHz)
  if (gain > 0.65) limitations.push('交叉路径增益超过稳定性上限 0.65，amount 已限制为 1，不能完全反演该声路。')
  if (delay < 0.02 || delay > 1.5) limitations.push('交叉声路时差超出现有节点 0.02–1.5ms 范围，参数已钳位。')
  if (leftSpeaker.relativeDelayMs <= 0 || rightSpeaker.relativeDelayMs <= 0)
    limitations.push('至少一侧交叉声路没有晚于同侧声路，现有因果对称模型不适用，返回停用设置。')
  return {
    method, leftSpeaker, rightSpeaker,
    settings: {
      enabled: leftSpeaker.relativeDelayMs > 0 && rightSpeaker.relativeDelayMs > 0,
      amount: clamp(gain / 0.65, 0, 1),
      delayMs: clamp(delay, 0.02, 1.5),
      cutoffHz: clamp(cutoff, 200, Math.min(5000, sampleRate * 0.4)),
    },
    asymmetry: { delayDifferenceMs, gainDifferenceDb, cutoffRatio, exceedsSymmetricModel },
    limitations,
  }
}

/**
 * 摆位估算仅采用自由场 1/r 衰减及简化头部遮挡低通，不是麦克风实测校准。
 * 实际房间反射、扬声器频响和个人头部差异不在此模型内。
 */
export function calibrateSpeakerGeometry(input: SpeakerGeometry): SpeakerCalibrationResult {
  const sampleRate = finite(input.sampleRate ?? 48000, '采样率', 8000, 384000)
  const spacing = finite(input.earSpacingM ?? 0.175, '双耳间距', 0.08, 0.3)
  const speed = finite(input.speedOfSoundMps ?? 343, '声速', 300, 380)
  const yaw = finite(input.listenerYawDeg ?? 0, '朝向', -36000, 36000) * Math.PI / 180
  for (const point of [input.leftSpeaker, input.rightSpeaker, input.listener])
    for (const key of ['x', 'y', 'z'] as const) finite(point[key], '坐标', -1000, 1000)
  const offsetX = Math.cos(yaw) * spacing / 2, offsetY = -Math.sin(yaw) * spacing / 2
  const leftEar = { x: input.listener.x - offsetX, y: input.listener.y - offsetY, z: input.listener.z }
  const rightEar = { x: input.listener.x + offsetX, y: input.listener.y + offsetY, z: input.listener.z }
  const path = (speaker: CalibrationPoint, ownEar: CalibrationPoint, otherEar: CalibrationPoint): SpeakerPathEstimate => {
    const distance = (ear: CalibrationPoint) => Math.hypot(speaker.x - ear.x, speaker.y - ear.y, speaker.z - ear.z)
    const direct = finite(distance(ownEar), '同侧距离', 0.05, 2000)
    const cross = finite(distance(otherEar), '交叉距离', 0.05, 2000)
    const lateral = Math.abs((speaker.x - input.listener.x) * Math.cos(yaw) -
      (speaker.y - input.listener.y) * Math.sin(yaw)) / Math.max(direct, cross)
    // 头部遮挡随侧向角增强；正前方声源不凭空制造强低通。
    const cutoffHz = clamp(speed / (Math.PI * spacing * Math.max(lateral, 0.15)), 200, 5000)
    return {
      directArrivalMs: direct / speed * 1000,
      crossArrivalMs: cross / speed * 1000,
      relativeDelayMs: (cross - direct) / speed * 1000,
      crossGain: direct / cross,
      cutoffHz,
    }
  }
  return result('geometry', path(input.leftSpeaker, leftEar, rightEar), path(input.rightSpeaker, rightEar, leftEar),
    sampleRate, ['几何结果是自由场与简化头部遮挡估算；未测量真实房间、音箱频响或个人 HRTF。'])
}

interface IrWindow { samples: Float64Array; arrival: number }

function directWindow(ir: Float32Array | Float64Array, sampleRate: number, durationMs: number): IrWindow {
  if (!(ir instanceof Float32Array || ir instanceof Float64Array) || ir.length < 16 || ir.length > 2_000_000)
    throw new RangeError('IR 必须为有效且长度合理的浮点数组')
  let peak = 0
  for (const value of ir) {
    if (!Number.isFinite(value)) throw new RangeError('IR 包含非有限样本')
    peak = Math.max(peak, Math.abs(value))
  }
  if (peak < 1e-8) throw new RangeError('IR 静音或测量电平过低')
  // 相对峰值阈值避免把数值噪声当作直达声；真实有噪测量仍应先去噪和反卷积。
  let arrival = 0
  while (arrival < ir.length && Math.abs(ir[arrival]) < peak * 0.03) arrival++
  const count = Math.min(ir.length - arrival, Math.ceil(durationMs * sampleRate / 1000))
  if (count < 8) throw new RangeError('IR 直达声后的记录不足')
  return { arrival, samples: Float64Array.from(ir.subarray(arrival, arrival + count)) }
}

function responseMagnitude(samples: Float64Array, frequency: number, sampleRate: number): number {
  const step = 2 * Math.PI * frequency / sampleRate
  let re = 0, im = 0
  for (let i = 0; i < samples.length; i++) {
    re += samples[i] * Math.cos(step * i)
    im -= samples[i] * Math.sin(step * i)
  }
  return Math.hypot(re, im)
}

function measuredPath(direct: IrWindow, cross: IrWindow, sampleRate: number): SpeakerPathEstimate {
  const ratio = (frequency: number) => {
    const own = responseMagnitude(direct.samples, frequency, sampleRate)
    if (own < 1e-8) throw new RangeError('同侧 IR 在分析频段存在零点或能量不足')
    return responseMagnitude(cross.samples, frequency, sampleRate) / own
  }
  const crossGain = (ratio(40) + ratio(80) + ratio(120)) / 3
  if (!Number.isFinite(crossGain) || crossGain < 1e-5 || crossGain > 100)
    throw new RangeError('IR 交叉增益不可信')
  const upper = Math.min(5000, sampleRate * 0.4)
  const threshold = crossGain / Math.SQRT2
  let cutoffHz = upper, previousFrequency = 120, previousRatio = crossGain
  for (let i = 0; i <= 80; i++) {
    const frequency = 150 * (upper / 150) ** (i / 80)
    const value = ratio(frequency)
    if (value < threshold) {
      cutoffHz = previousFrequency + (frequency - previousFrequency) *
        clamp((previousRatio - threshold) / Math.max(previousRatio - value, 1e-12), 0, 1)
      break
    }
    previousFrequency = frequency; previousRatio = value
  }
  return {
    directArrivalMs: direct.arrival / sampleRate * 1000,
    crossArrivalMs: cross.arrival / sampleRate * 1000,
    relativeDelayMs: (cross.arrival - direct.arrival) / sampleRate * 1000,
    crossGain, cutoffHz,
  }
}

/**
 * 分析已反卷积的四路 IR。该函数不播放测试声、不访问麦克风，也不宣称完成硬件测量。
 * 时差分辨率为一个样本；频率上限取交叉/同侧幅频比首次下降 3dB 的频率。
 */
export function calibrateSpeakerMeasurement(input: BinauralSpeakerMeasurement): SpeakerCalibrationResult {
  const sampleRate = finite(input.sampleRate, '采样率', 8000, 384000)
  const windowMs = finite(input.directWindowMs ?? 5, '直达声窗口', 1, 30)
  const ll = directWindow(input.leftSpeakerToLeftEar, sampleRate, windowMs)
  const lr = directWindow(input.leftSpeakerToRightEar, sampleRate, windowMs)
  const rr = directWindow(input.rightSpeakerToRightEar, sampleRate, windowMs)
  const rl = directWindow(input.rightSpeakerToLeftEar, sampleRate, windowMs)
  return result('measured-ir', measuredPath(ll, lr, sampleRate), measuredPath(rr, rl, sampleRate), sampleRate,
    ['仅拟合直达声短窗的时差、低频幅度比和首个 -3dB 频率；不反演房间混响、频响零点或任意相位。',
      '四路 IR 必须由同一时钟和时间零点的实测测试信号反卷积得到；当前函数不执行硬件采集。'])
}
