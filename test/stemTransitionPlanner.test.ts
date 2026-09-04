import { describe, expect, it } from 'vitest'
import {
  planStemTransition,
  type CoarseV2StemPlan,
  type StemEvidence,
  type StemTrackEvidence,
} from '../src/audio/stemTransitionPlanner'

function envelope(
  start: number,
  values: Array<[relativeTime: number, db: number]>,
  activity?: Array<[relativeTime: number, value: number]>,
  confidence = 0.9,
): StemEvidence {
  return {
    envelope: values.map(([time, db]) => ({ time: start + time, db })),
    activity: activity?.map(([time, value]) => ({ time: start + time, value })),
    confidence,
  }
}

function flatStem(start: number, db: number, activity = 0.4): StemEvidence {
  return envelope(start, [[0, db], [10, db]], [[0, activity], [10, activity]])
}

function track(start: number, overrides: Partial<StemTrackEvidence> = {}): StemTrackEvidence {
  return {
    vocals: envelope(start, [[0, -10], [6.9, -10], [7, -60], [10, -60]]),
    drums: flatStem(start, -12, 0.45),
    bass: flatStem(start, -14, 0.5),
    other: flatStem(start, -16, 0.45),
    ...overrides,
  }
}

function coarse(overrides: Partial<CoarseV2StemPlan> = {}): CoarseV2StemPlan {
  return {
    sourceStartTime: 90,
    sourceEndTime: 100,
    targetStartTime: 10,
    targetEndTime: 20,
    sourceBpm: 120,
    targetBpm: 124,
    sourceBeatTimes: Array.from({ length: 21 }, (_, index) => 90 + index * 0.5),
    targetBeatTimes: Array.from({ length: 21 }, (_, index) => 10 + index * 0.5),
    sourceDownbeats: [90, 92, 94, 96, 98, 100],
    targetDownbeats: [10, 12, 14, 16, 18, 20],
    keyCompatibility: 0.8,
    confidence: 0.9,
    ...overrides,
  }
}

function input(options: {
  source?: StemTrackEvidence
  target?: StemTrackEvidence
  coarsePlan?: CoarseV2StemPlan
} = {}) {
  return {
    source: options.source ?? track(90),
    target: options.target ?? track(10, {
      vocals: envelope(10, [[0, -60], [0.75, -60], [1, -10], [10, -10]]),
    }),
    coarsePlan: options.coarsePlan ?? coarse(),
  }
}

describe('planStemTransition', () => {
  it('uses beatCut for a starts-hot target and swaps drums on a downbeat in about 6ms', () => {
    const target = track(10, {
      vocals: envelope(10, [[0, -60], [0.75, -60], [1, -10], [10, -10]]),
      drums: envelope(10, [[0, -5], [10, -5]], [[0, 0.95], [0.5, 0.95], [10, 0.4]]),
    })
    const result = planStemTransition(input({ target }))

    expect(result.style).toBe('beatCut')
    expect(result.drumSwap).toEqual({ time: 4, duration: 0.006, alignment: 'downbeat' })
    expect(result.bassSwap.time).toBeGreaterThan(result.drumSwap.time)
    expect(result.drums.source.at(-1)?.time - result.drums.source.at(-2)?.time).toBeCloseTo(0.006)
    expect(result.drums.target[2].time - result.drums.target[1].time).toBeCloseTo(0.006)
  })

  it('finds a 0.5s vocal window at 30dB below the combined background and waits for release', () => {
    const result = planStemTransition(input())

    expect(result.vocalOut.quietWindow?.end - result.vocalOut.quietWindow?.start).toBeCloseTo(0.5)
    expect(result.vocalOut.start).toBeGreaterThanOrEqual(6.9)
    expect(result.vocalOut.start).toBeLessThan(7.1)
    expect(result.vocalIn.quietWindow).toEqual({ start: 0, end: 0.5 })
  })

  it('uses bassSwap when stems are reliable, target drums are not hot, and no natural tail exists', () => {
    const result = planStemTransition(input())

    expect(result.style).toBe('bassSwap')
    expect(result.bassSwap.time).toBeGreaterThan(result.drumSwap.time)
    expect(result.reason).toContain('bass')
  })

  it('uses tailRide when the source accompaniment decays naturally', () => {
    const decaying = (db: number) => envelope(90, [[0, db], [5, db - 8], [9.5, db - 20], [10, db - 22]])
    const source = track(90, {
      drums: decaying(-10),
      bass: decaying(-12),
      other: decaying(-14),
    })
    const result = planStemTransition(input({ source }))

    expect(result.style).toBe('tailRide')
    expect(result.other.source.at(-1)).toEqual({ time: 10, gain: 0 })
    expect(result.reason).toContain('decays naturally')
  })

  it('uses plainBlend when stem or coarse-plan evidence is insufficient', () => {
    const weakSource = track(90, { vocals: envelope(90, [[0, -10], [10, -10]], undefined, 0.2) })
    const result = planStemTransition(input({ source: weakSource }))

    expect(result.style).toBe('plainBlend')
    for (const stem of ['vocals', 'drums', 'bass', 'other'] as const) {
      expect(result[stem].source).toEqual([{ time: 0, gain: 1 }, { time: 10, gain: 0 }])
      expect(result[stem].target).toEqual([{ time: 0, gain: 0 }, { time: 10, gain: 1 }])
    }
  })

  it('removes vocal overlap for a harmonic conflict', () => {
    const compatible = planStemTransition(input({ coarsePlan: coarse({ keyCompatibility: 0.8 }) }))
    const conflicting = planStemTransition(input({ coarsePlan: coarse({ keyCompatibility: 0.2 }) }))

    expect(compatible.overlap).toBeGreaterThan(0)
    expect(conflicting.overlap).toBe(0)
    expect(conflicting.vocalIn.start).toBeGreaterThanOrEqual(conflicting.vocalOut.end)
    expect(conflicting.vocalIn.end).toBeGreaterThanOrEqual(conflicting.vocalIn.start)
    expect(conflicting.reason).toContain('harmonic conflict')
  })

  it('clamps duration to 0.8..25 seconds', () => {
    const short = planStemTransition(input({ coarsePlan: coarse({ sourceEndTime: 90.1, targetEndTime: 10.1 }) }))
    const long = planStemTransition(input({ coarsePlan: coarse({ sourceEndTime: 130, targetEndTime: 50 }) }))

    expect(short.duration).toBe(0.8)
    expect(long.duration).toBe(25)
  })

  it('allows stretch only within +/-12% after half/double-time normalization', () => {
    const boundary = planStemTransition(input({ coarsePlan: coarse({ sourceBpm: 100, targetBpm: 112 }) }))
    const outside = planStemTransition(input({ coarsePlan: coarse({ sourceBpm: 100, targetBpm: 112.1 }) }))
    const halfTime = planStemTransition(input({ coarsePlan: coarse({ sourceBpm: 140, targetBpm: 70 }) }))

    expect(boundary.tempoStretch).toEqual({ allowed: true, normalizedRatio: 1.12 })
    expect(outside.tempoStretch.allowed).toBe(false)
    expect(halfTime.tempoStretch).toEqual({ allowed: true, normalizedRatio: 1 })
  })

  it('falls back from downbeat to beat and then to a free cut', () => {
    const beat = planStemTransition(input({ coarsePlan: coarse({ sourceDownbeats: [], targetDownbeats: [] }) }))
    const free = planStemTransition(input({ coarsePlan: coarse({
      sourceDownbeats: [],
      targetDownbeats: [],
      sourceBeatTimes: [],
      targetBeatTimes: [],
    }) }))

    expect(beat.drumSwap.alignment).toBe('beat')
    expect(free.drumSwap.alignment).toBe('free')
  })

  it('is deterministic and does not mutate its input', () => {
    const value = input()
    const before = structuredClone(value)
    const first = planStemTransition(value)
    const second = planStemTransition(value)

    expect(second).toEqual(first)
    expect(value).toEqual(before)
  })
})
