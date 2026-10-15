/**
 * 学歌插件纯逻辑单测：音高检测（YIN）、音名换算、音分误差、行评分与汇总。
 */
import { describe, expect, it } from 'vitest'
import {
  aggregateLineScores,
  centsBetween,
  centsToScore,
  detectPitchYin,
  frequencyToMidi,
  frequencyToNoteName,
  midiToNoteName,
  scoreLine,
  scoreLabel,
} from '../src/plugins/clients/singalong/pitch'

const SR = 44100

/** 生成正弦帧。 */
function sineFrame(frequency: number, length = 2048, sampleRate = SR, amplitude = 0.4): Float32Array {
  const frame = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    frame[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate)
  }
  return frame
}

describe('detectPitchYin', () => {
  it('检测标准音 A4 = 440Hz（±2Hz）', () => {
    const pitch = detectPitchYin(sineFrame(440), SR)
    expect(pitch).not.toBeNull()
    expect(Math.abs(pitch! - 440)).toBeLessThan(2)
  })

  it('检测男声低音区 E2 ≈ 82.4Hz', () => {
    const pitch = detectPitchYin(sineFrame(82.41), SR)
    expect(pitch).not.toBeNull()
    expect(Math.abs(pitch! - 82.41)).toBeLessThan(2)
  })

  it('检测女声高音区 G5 ≈ 784Hz', () => {
    const pitch = detectPitchYin(sineFrame(783.99), SR)
    expect(pitch).not.toBeNull()
    expect(Math.abs(pitch! - 783.99)).toBeLessThan(4)
  })

  it('静音帧返回 null', () => {
    expect(detectPitchYin(new Float32Array(2048), SR)).toBeNull()
  })

  it('白噪声返回 null', () => {
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x3fffffff - 1
    }
    const noise = new Float32Array(2048)
    for (let i = 0; i < noise.length; i += 1) noise[i] = random() * 0.5
    expect(detectPitchYin(noise, SR)).toBeNull()
  })

  it('带谐波的复合音（基频+2次+3次谐波）仍锁定基频', () => {
    const base = sineFrame(220)
    const harmonic2 = sineFrame(440, 2048, SR, 0.15)
    const harmonic3 = sineFrame(660, 2048, SR, 0.1)
    const composite = new Float32Array(2048)
    for (let i = 0; i < 2048; i += 1) composite[i] = base[i] + harmonic2[i] + harmonic3[i]
    const pitch = detectPitchYin(composite, SR)
    expect(pitch).not.toBeNull()
    expect(Math.abs(pitch! - 220)).toBeLessThan(3)
  })
})

describe('音名换算', () => {
  it('frequencyToMidi：440Hz = 69', () => {
    expect(frequencyToMidi(440)).toBe(69)
    expect(frequencyToMidi(261.63)).toBe(60)
  })

  it('midiToNoteName', () => {
    expect(midiToNoteName(69)).toBe('A4')
    expect(midiToNoteName(60)).toBe('C4')
    expect(midiToNoteName(61)).toBe('C#4')
    expect(midiToNoteName(58)).toBe('A#3')
  })

  it('frequencyToNoteName：无效值返回 null', () => {
    expect(frequencyToNoteName(0)).toBeNull()
    expect(frequencyToNoteName(Number.NaN)).toBeNull()
    expect(frequencyToNoteName(-440)).toBeNull()
    expect(frequencyToNoteName(440)).toBe('A4')
  })
})

describe('音分误差', () => {
  it('centsBetween：同频为 0，高八度 +1200', () => {
    expect(centsBetween(440, 440)).toBeCloseTo(0, 6)
    expect(centsBetween(880, 440)).toBeCloseTo(1200, 4)
    expect(centsBetween(440, 880)).toBeCloseTo(-1200, 4)
  })

  it('centsBetween：半音 ≈ 100 音分', () => {
    expect(Math.abs(centsBetween(466.16, 440))).toBeCloseTo(100, 1)
  })

  it('centsToScore：±30 音分内满分，100 音分为零分，中间线性', () => {
    expect(centsToScore(0)).toBe(1)
    expect(centsToScore(30)).toBe(1)
    expect(centsToScore(-30)).toBe(1)
    expect(centsToScore(100)).toBe(0)
    expect(centsToScore(-100)).toBe(0)
    expect(centsToScore(65)).toBeCloseTo(0.5, 9)
    expect(centsToScore(0)).toBeGreaterThan(centsToScore(65))
  })
})

describe('scoreLine', () => {
  it('完美跟唱（用户=参照，全开口）接近满分', () => {
    const n = 20
    const result = scoreLine({
      userPitches: Array(n).fill(440),
      targetPitches: Array(n).fill(440),
      voicedMask: Array(n).fill(true),
    })
    expect(result.total).toBeGreaterThanOrEqual(95)
    expect(result.pitch).toBe(100)
    expect(result.rhythm).toBe(100)
  })

  it('低了约半个音（100 音分）音准分为 0', () => {
    const n = 20
    const result = scoreLine({
      userPitches: Array(n).fill(415.3),
      targetPitches: Array(n).fill(440),
      voicedMask: Array(n).fill(true),
    })
    expect(result.pitch).toBe(0)
    expect(result.total).toBeLessThan(40)
  })

  it('没开口（全闭口）节奏分为 0，无音准帧总分=节奏分', () => {
    const n = 20
    const result = scoreLine({
      userPitches: Array(n).fill(null),
      targetPitches: Array(n).fill(440),
      voicedMask: Array(n).fill(false),
    })
    expect(result.pitch).toBe(0)
    expect(result.rhythm).toBe(0)
    expect(result.total).toBe(0)
  })

  it('只唱一半时间：节奏分 ≈ 50', () => {
    const n = 20
    const voiced = Array(n).fill(false)
    for (let i = 0; i < 10; i += 1) voiced[i] = true
    const result = scoreLine({
      userPitches: Array(n).fill(null),
      targetPitches: Array(n).fill(440),
      voicedMask: voiced,
    })
    expect(result.rhythm).toBe(50)
  })

  it('无参照音高（纯节奏模式）：总分退化为节奏分', () => {
    const n = 20
    const userPitches: (number | null)[] = Array(n).fill(null)
    userPitches[0] = 440
    userPitches[5] = 442
    const voicedMask = userPitches.map(p => p != null)
    const result = scoreLine({ userPitches, targetPitches: Array(n).fill(null), voicedMask })
    // 参照全空：应唱窗口 = 整行全部槽（20 槽），用户只开口 2 槽 → 节奏 10。
    // （旧逻辑用「用户唱了的槽」当应唱窗口，唱一句就恒 100，漏唱不扣分。）
    expect(result.rhythm).toBe(10)
    expect(result.total).toBe(10)
    expect(result.pitch).toBe(0)
  })

  it('无参照音高且唱满整行：节奏 100', () => {
    const n = 20
    const result = scoreLine({
      userPitches: Array(n).fill(null),
      targetPitches: Array(n).fill(null),
      voicedMask: Array(n).fill(true),
    })
    expect(result.rhythm).toBe(100)
    expect(result.total).toBe(100)
    expect(result.pitch).toBe(0)
  })

  it('八分音（50 音分偏差）音准分约为 0.71', () => {
    const quarterTone = 440 * Math.pow(2, 50 / 1200)
    const result = scoreLine({
      userPitches: Array(10).fill(quarterTone),
      targetPitches: Array(10).fill(440),
      voicedMask: Array(10).fill(true),
    })
    expect(result.pitch).toBeGreaterThanOrEqual(70)
    expect(result.pitch).toBeLessThanOrEqual(73)
  })
})

describe('aggregateLineScores', () => {
  it('空列表返回全零', () => {
    expect(aggregateLineScores([])).toEqual({ total: 0, pitch: 0, rhythm: 0 })
  })

  it('等权平均', () => {
    const lines = [
      { total: 80, pitch: 90, rhythm: 60, voicedFrames: 10, targetFrames: 10 },
      { total: 60, pitch: 50, rhythm: 80, voicedFrames: 10, targetFrames: 10 },
    ]
    const summary = aggregateLineScores(lines)
    expect(summary.total).toBe(70)
    expect(summary.pitch).toBe(70)
    expect(summary.rhythm).toBe(70)
  })

  it('带权重平均', () => {
    const lines = [
      { total: 90, pitch: 90, rhythm: 90, voicedFrames: 10, targetFrames: 10 },
      { total: 50, pitch: 50, rhythm: 50, voicedFrames: 10, targetFrames: 10 },
    ]
    const summary = aggregateLineScores(lines, [3, 1])
    expect(summary.total).toBe(80)
  })
})

describe('scoreLabel', () => {
  it('分数档位文案', () => {
    expect(scoreLabel(98)).toBe('歌神降临')
    expect(scoreLabel(88)).toBe('麦霸水准')
    expect(scoreLabel(75)).toBe('渐入佳境')
    expect(scoreLabel(55)).toBe('继续加油')
    expect(scoreLabel(20)).toBe('多练几遍')
  })
})
