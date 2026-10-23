import { describe, expect, it } from 'vitest'
import { calibrateSpeakerGeometry, calibrateSpeakerMeasurement } from '../SpeakerCalibration'

const fs = 48000
function impulse(delay: number, gain = 1, cutoff?: number): Float64Array {
  const ir = new Float64Array(2048)
  if (!cutoff) { ir[delay] = gain; return ir }
  const pole = Math.exp(-2 * Math.PI * cutoff / fs)
  for (let i = delay; i < ir.length; i++) ir[i] = gain * (1 - pole) * pole ** (i - delay)
  return ir
}
const measurement = () => ({
  sampleRate: fs,
  leftSpeakerToLeftEar: impulse(120, 0.8),
  leftSpeakerToRightEar: impulse(132, 0.8 * 0.5, 1800),
  rightSpeakerToRightEar: impulse(120, 0.6),
  rightSpeakerToLeftEar: impulse(132, 0.6 * 0.5, 1800),
})

describe('双音箱校准', () => {
  it('对称摆位产生对称路径，平移整个场景不改变校准值', () => {
    const geometry = {
      leftSpeaker: { x: -0.8, y: 1.5, z: 1.2 },
      rightSpeaker: { x: 0.8, y: 1.5, z: 1.2 },
      listener: { x: 0, y: 0, z: 1.2 },
    }
    const a = calibrateSpeakerGeometry(geometry)
    const shift = (p: { x: number; y: number; z: number }) => ({ x: p.x + 3, y: p.y - 5, z: p.z + 1 })
    const b = calibrateSpeakerGeometry({
      leftSpeaker: shift(geometry.leftSpeaker), rightSpeaker: shift(geometry.rightSpeaker), listener: shift(geometry.listener),
    })
    expect(a.leftSpeaker.relativeDelayMs).toBeCloseTo(a.rightSpeaker.relativeDelayMs, 10)
    expect(a.asymmetry.exceedsSymmetricModel).toBe(false)
    expect(a.settings.enabled).toBe(true)
    expect(a.settings.amount).toBe(1)
    expect(a.limitations.some(text => text.includes('0.65'))).toBe(true)
    expect(b.settings.delayMs).toBeCloseTo(a.settings.delayMs, 10)
    expect(b.settings.cutoffHz).toBeCloseTo(a.settings.cutoffHz, 10)
  })

  it('侧移听者或转头会报告现有对称滤波器的限制', () => {
    const a = calibrateSpeakerGeometry({
      leftSpeaker: { x: -1, y: 1, z: 0 }, rightSpeaker: { x: 1, y: 1, z: 0 },
      listener: { x: 0.7, y: 0, z: 0 }, listenerYawDeg: 30,
    })
    expect(a.asymmetry.exceedsSymmetricModel).toBe(true)
    expect(a.limitations.some(text => text.includes('不对称'))).toBe(true)
  })

  it('从四路合成实测格式 IR 恢复相对时差、幅度比和低通上限', () => {
    const a = calibrateSpeakerMeasurement(measurement())
    expect(a.method).toBe('measured-ir')
    expect(a.settings.delayMs).toBeCloseTo(0.25, 8)
    expect(a.settings.amount).toBeCloseTo(0.5 / 0.65, 2)
    expect(a.settings.cutoffHz).toBeGreaterThan(1700)
    expect(a.settings.cutoffHz).toBeLessThan(1900)
    expect(a.asymmetry.exceedsSymmetricModel).toBe(false)
    expect(a.settings.enabled).toBe(true)
  })

  it('左右不对称的 IR 明确报告，并使用较保守的频率上限', () => {
    const input = measurement()
    input.rightSpeakerToLeftEar = impulse(140, 0.6 * 0.3, 900)
    const a = calibrateSpeakerMeasurement(input)
    expect(a.asymmetry.exceedsSymmetricModel).toBe(true)
    expect(a.asymmetry.gainDifferenceDb).toBeGreaterThan(4)
    expect(a.settings.cutoffHz).toBeLessThan(1000)
    expect(a.limitations.some(text => text.includes('不对称'))).toBe(true)
  })

  it('交叉路径提前时返回停用设置，禁止把非因果摆位默认为可校正', () => {
    const input = measurement()
    input.leftSpeakerToRightEar = impulse(110, 0.4, 1800)
    const a = calibrateSpeakerMeasurement(input)
    expect(a.settings.enabled).toBe(false)
    expect(a.limitations.some(text => text.includes('因果'))).toBe(true)
  })

  it('拒绝静音、非法、记录不足测量及非法几何值', () => {
    expect(() => calibrateSpeakerMeasurement({ ...measurement(), leftSpeakerToLeftEar: new Float64Array(2048) })).toThrow()
    expect(() => calibrateSpeakerMeasurement({ ...measurement(), sampleRate: NaN })).toThrow()
    expect(() => calibrateSpeakerMeasurement({ ...measurement(), leftSpeakerToRightEar: new Float64Array(2) })).toThrow()
    const invalid = measurement()
    invalid.rightSpeakerToLeftEar[10] = NaN
    expect(() => calibrateSpeakerMeasurement(invalid)).toThrow()
    expect(() => calibrateSpeakerGeometry({
      leftSpeaker: { x: NaN, y: 0, z: 0 }, rightSpeaker: { x: 1, y: 1, z: 0 },
      listener: { x: 0, y: 0, z: 0 },
    })).toThrow()
  })
})
