export type StemName = 'vocals' | 'drums' | 'bass' | 'other'

export interface StemEnvelopePoint {
  /** Seconds from the beginning of the analyzed track. */
  time: number
  /** Stem level in dBFS. Values at or below -100 are treated as silence. */
  db: number
}

export interface StemActivityPoint {
  /** Seconds from the beginning of the analyzed track. */
  time: number
  /** Normalized presence/attack evidence in the range 0..1. */
  value: number
}

export interface StemEvidence {
  envelope: StemEnvelopePoint[]
  activity?: StemActivityPoint[]
  confidence?: number
}

export interface StemTrackEvidence {
  vocals?: StemEvidence
  drums?: StemEvidence
  bass?: StemEvidence
  other?: StemEvidence
}

export interface CoarseV2StemPlan {
  sourceStartTime: number
  sourceEndTime: number
  targetStartTime: number
  targetEndTime: number
  sourceBpm: number
  targetBpm: number
  /** Track-absolute beat positions. */
  sourceBeatTimes?: number[]
  /** Track-absolute beat positions. */
  targetBeatTimes?: number[]
  /** Track-absolute downbeat positions. */
  sourceDownbeats?: number[]
  /** Track-absolute downbeat positions. */
  targetDownbeats?: number[]
  /** 0..1 harmonic compatibility from the coarse v2 planner. */
  keyCompatibility?: number
  /** 0..1 confidence of the coarse transition plan. */
  confidence?: number
}

export interface StemTransitionPlannerInput {
  source: StemTrackEvidence
  target: StemTrackEvidence
  coarsePlan: CoarseV2StemPlan
}

export interface GainPoint {
  /** Seconds from the beginning of the transition. */
  time: number
  /** Linear gain. */
  gain: number
}

export interface StemGainEnvelope {
  source: GainPoint[]
  target: GainPoint[]
}

export interface StemSwap {
  time: number
  duration: number
  alignment: 'downbeat' | 'beat' | 'free'
}

export interface VocalMove {
  start: number
  end: number
  quietWindow?: { start: number; end: number }
}

export interface StemChoreography {
  style: 'beatCut' | 'bassSwap' | 'tailRide' | 'plainBlend'
  duration: number
  vocals: StemGainEnvelope
  drums: StemGainEnvelope
  bass: StemGainEnvelope
  other: StemGainEnvelope
  drumSwap: StemSwap
  bassSwap: StemSwap
  vocalOut: VocalMove
  vocalIn: VocalMove
  /** Time for which audible source and target vocals can coexist. */
  overlap: number
  tempoStretch: {
    allowed: boolean
    /** Target tempo divided by source tempo after half/double-time normalization. */
    normalizedRatio: number
  }
  reason: string
}

const STEMS: StemName[] = ['vocals', 'drums', 'bass', 'other']
const MIN_DURATION = 0.8
const MAX_DURATION = 25
const QUIET_WINDOW_SECONDS = 0.5
const DRUM_CUT_SECONDS = 0.006
const MIN_EVIDENCE_CONFIDENCE = 0.55
const EPSILON = 1e-6

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000

function sortedEnvelope(stem: StemEvidence | undefined): StemEnvelopePoint[] {
  if (!stem) return []
  return stem.envelope
    .filter(point => Number.isFinite(point.time) && Number.isFinite(point.db))
    .map(point => ({ time: point.time, db: clamp(point.db, -120, 24) }))
    .sort((left, right) => left.time - right.time)
}

function sortedActivity(stem: StemEvidence | undefined): StemActivityPoint[] {
  if (!stem?.activity) return []
  return stem.activity
    .filter(point => Number.isFinite(point.time) && Number.isFinite(point.value))
    .map(point => ({ time: point.time, value: clamp(point.value, 0, 1) }))
    .sort((left, right) => left.time - right.time)
}

function interpolate<T extends { time: number }>(
  points: T[],
  time: number,
  read: (point: T) => number,
  fallback: number,
): number {
  if (!points.length) return fallback
  if (time <= points[0].time) return read(points[0])
  const last = points[points.length - 1]
  if (time >= last.time) return read(last)
  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle].time <= time) low = middle
    else high = middle
  }
  const span = points[high].time - points[low].time
  const progress = span > EPSILON ? (time - points[low].time) / span : 0
  return read(points[low]) * (1 - progress) + read(points[high]) * progress
}

function stemDb(track: StemTrackEvidence, stem: StemName, absoluteTime: number): number {
  return interpolate(sortedEnvelope(track[stem]), absoluteTime, point => point.db, -120)
}

function stemActivity(track: StemTrackEvidence, stem: StemName, absoluteTime: number): number {
  const activity = sortedActivity(track[stem])
  if (activity.length) return interpolate(activity, absoluteTime, point => point.value, 0)
  return clamp((stemDb(track, stem, absoluteTime) + 60) / 48, 0, 1)
}

function backgroundDb(track: StemTrackEvidence, absoluteTime: number): number {
  const power = (['drums', 'bass', 'other'] as StemName[]).reduce((sum, stem) => {
    const db = stemDb(track, stem, absoluteTime)
    return sum + Math.pow(10, db / 10)
  }, 0)
  return power > 1e-12 ? 10 * Math.log10(power) : -120
}

function hasUsableEvidence(track: StemTrackEvidence): boolean {
  const available = STEMS.filter(stem => sortedEnvelope(track[stem]).length >= 2)
  if (!available.includes('vocals') || available.filter(stem => stem !== 'vocals').length < 2) return false
  return available.every(stem => finite(track[stem]?.confidence ?? 1, 0) >= MIN_EVIDENCE_CONFIDENCE)
}

function findQuietWindow(
  track: StemTrackEvidence,
  absoluteStart: number,
  absoluteEnd: number,
  searchFrom: number,
): { start: number; end: number } | undefined {
  const start = clamp(searchFrom, absoluteStart, absoluteEnd)
  const step = 0.025
  let runStart: number | undefined
  for (let time = start; time <= absoluteEnd + EPSILON; time += step) {
    const quiet = stemDb(track, 'vocals', time) <= backgroundDb(track, time) - 30
    if (quiet && runStart === undefined) runStart = time
    if (!quiet) runStart = undefined
    if (runStart !== undefined && time - runStart + step >= QUIET_WINDOW_SECONDS) {
      return { start: round(runStart - absoluteStart), end: round(runStart - absoluteStart + QUIET_WINDOW_SECONDS) }
    }
  }
  return undefined
}

function normalizeTempoRatio(sourceBpm: number, targetBpm: number): number {
  const source = finite(sourceBpm, 0)
  const target = finite(targetBpm, 0)
  if (source <= 0 || target <= 0) return 0
  let ratio = target / source
  while (ratio < 0.75) ratio *= 2
  while (ratio > 1.5) ratio /= 2
  return ratio
}

function toRelativeGrid(points: number[] | undefined, offset: number, duration: number): number[] {
  return (points ?? [])
    .filter(Number.isFinite)
    .map(time => round(time - offset))
    .filter(time => time >= 0 && time <= duration)
    .sort((left, right) => left - right)
}

function nearestGridPoint(
  preferredTime: number,
  duration: number,
  downbeats: number[],
  beats: number[],
): { time: number; alignment: StemSwap['alignment'] } {
  const choose = (points: number[]) => points.reduce((best, point) => {
    const distance = Math.abs(point - preferredTime)
    return distance < best.distance ? { point, distance } : best
  }, { point: preferredTime, distance: Number.POSITIVE_INFINITY })
  const maxSnap = 1.25
  const downbeat = choose(downbeats)
  if (downbeat.distance <= maxSnap) return { time: clamp(downbeat.point, 0, duration), alignment: 'downbeat' }
  const beat = choose(beats)
  if (beat.distance <= maxSnap) return { time: clamp(beat.point, 0, duration), alignment: 'beat' }
  return { time: clamp(preferredTime, 0, duration), alignment: 'free' }
}

function averageActivity(
  track: StemTrackEvidence,
  stem: StemName,
  absoluteStart: number,
  absoluteEnd: number,
): number {
  const samples = 12
  let total = 0
  for (let index = 0; index < samples; index += 1) {
    const progress = index / (samples - 1)
    total += stemActivity(track, stem, absoluteStart + (absoluteEnd - absoluteStart) * progress)
  }
  return total / samples
}

function hasNaturalTail(track: StemTrackEvidence, start: number, end: number): boolean {
  if (end - start < MIN_DURATION) return false
  const averageDb = (time: number) => (
    stemDb(track, 'drums', time) + stemDb(track, 'bass', time) + stemDb(track, 'other', time)
  ) / 3
  const early = averageDb(start)
  const middle = averageDb((start + end) / 2)
  const late = averageDb(Math.max(start, end - QUIET_WINDOW_SECONDS))
  return early - late >= 12 && middle <= early + 3 && late <= middle + 3
}

function gainPoint(time: number, gain: number): GainPoint {
  return { time: round(Math.max(0, time)), gain: round(clamp(gain, 0, 1)) }
}

function fadeOut(end: number, width: number): GainPoint[] {
  return [gainPoint(0, 1), gainPoint(Math.max(0, end - width), 1), gainPoint(end, 0)]
}

function fadeIn(start: number, width: number, duration: number): GainPoint[] {
  return [gainPoint(0, 0), gainPoint(start, 0), gainPoint(Math.min(duration, start + width), 1), gainPoint(duration, 1)]
}

function plainGains(duration: number): Record<StemName, StemGainEnvelope> {
  return Object.fromEntries(STEMS.map(stem => [stem, {
    source: [gainPoint(0, 1), gainPoint(duration, 0)],
    target: [gainPoint(0, 0), gainPoint(duration, 1)],
  }])) as Record<StemName, StemGainEnvelope>
}

/**
 * Plans stem-level gain automation without I/O, mutation, randomness, or renderer dependencies.
 * All returned times are seconds relative to the start of the transition.
 */
export function planStemTransition(input: StemTransitionPlannerInput): StemChoreography {
  const { source, target, coarsePlan } = input
  const rawDuration = Math.min(
    finite(coarsePlan.sourceEndTime - coarsePlan.sourceStartTime, MIN_DURATION),
    finite(coarsePlan.targetEndTime - coarsePlan.targetStartTime, MIN_DURATION),
  )
  const duration = round(clamp(rawDuration, MIN_DURATION, MAX_DURATION))
  const tempoRatio = normalizeTempoRatio(coarsePlan.sourceBpm, coarsePlan.targetBpm)
  const tempoStretch = {
    allowed: tempoRatio > 0 && Math.abs(tempoRatio - 1) <= 0.12 + EPSILON,
    normalizedRatio: round(tempoRatio),
  }
  const evidenceSufficient = hasUsableEvidence(source)
    && hasUsableEvidence(target)
    && finite(coarsePlan.confidence ?? 1, 0) >= MIN_EVIDENCE_CONFIDENCE

  const sourceDownbeats = toRelativeGrid(coarsePlan.sourceDownbeats, coarsePlan.sourceStartTime, duration)
  const sourceBeats = toRelativeGrid(coarsePlan.sourceBeatTimes, coarsePlan.sourceStartTime, duration)
  const targetDownbeats = toRelativeGrid(coarsePlan.targetDownbeats, coarsePlan.targetStartTime, duration)
  const targetBeats = toRelativeGrid(coarsePlan.targetBeatTimes, coarsePlan.targetStartTime, duration)
  const preferredDrumTime = duration * 0.46
  const sourceGrid = nearestGridPoint(preferredDrumTime, duration, sourceDownbeats, sourceBeats)
  const targetGrid = nearestGridPoint(preferredDrumTime, duration, targetDownbeats, targetBeats)
  const grid = sourceGrid.alignment === 'downbeat' ? sourceGrid : targetGrid.alignment === 'downbeat' ? targetGrid : sourceGrid
  const drumTime = round(grid.time)
  const bassTime = round(clamp(drumTime + clamp(duration * 0.08, 0.12, 0.75), 0, duration))

  const sourceQuiet = evidenceSufficient
    ? findQuietWindow(source, coarsePlan.sourceStartTime, coarsePlan.sourceStartTime + duration, coarsePlan.sourceStartTime + drumTime)
    : undefined
  const targetQuiet = evidenceSufficient
    ? findQuietWindow(target, coarsePlan.targetStartTime, coarsePlan.targetStartTime + duration, coarsePlan.targetStartTime)
    : undefined
  const vocalOutStart = sourceQuiet?.start ?? Math.max(0, drumTime - Math.min(0.6, duration * 0.08))
  const vocalOutEnd = clamp(vocalOutStart + Math.min(0.35, duration * 0.08), 0, duration)
  const vocalInEnd = targetQuiet ? clamp(targetQuiet.end, 0, duration) : clamp(drumTime + 0.4, 0, duration)
  const vocalFadeWidth = Math.min(0.35, duration * 0.08)
  const vocalInStart = clamp(vocalInEnd - vocalFadeWidth, 0, duration)
  const harmonicConflict = Number.isFinite(coarsePlan.keyCompatibility) && coarsePlan.keyCompatibility! < 0.45
  const adjustedVocalInStart = harmonicConflict ? Math.max(vocalInStart, vocalOutEnd) : vocalInStart
  const adjustedVocalInEnd = clamp(Math.max(vocalInEnd, adjustedVocalInStart + vocalFadeWidth), 0, duration)
  const overlap = round(Math.max(0, vocalOutEnd - adjustedVocalInStart))

  const startsHot = evidenceSufficient && averageActivity(
    target,
    'drums',
    coarsePlan.targetStartTime,
    coarsePlan.targetStartTime + Math.min(0.5, duration),
  ) >= 0.72
  const naturalTail = evidenceSufficient && hasNaturalTail(
    source,
    coarsePlan.sourceStartTime,
    coarsePlan.sourceStartTime + duration,
  )
  const style: StemChoreography['style'] = !evidenceSufficient
    ? 'plainBlend'
    : startsHot
      ? 'beatCut'
      : naturalTail
        ? 'tailRide'
        : 'bassSwap'

  const drumSwap: StemSwap = { time: drumTime, duration: DRUM_CUT_SECONDS, alignment: grid.alignment }
  const bassSwap: StemSwap = { time: bassTime, duration: round(Math.min(0.18, duration * 0.04)), alignment: 'free' }
  let gains = plainGains(duration)
  if (style !== 'plainBlend') {
    const otherWidth = style === 'tailRide' ? Math.min(1.2, duration * 0.18) : Math.min(0.6, duration * 0.1)
    const otherTime = style === 'tailRide' ? duration : clamp((drumTime + bassTime) / 2, 0, duration)
    gains = {
      vocals: {
        source: fadeOut(vocalOutEnd, Math.max(EPSILON, vocalOutEnd - vocalOutStart)),
        target: fadeIn(adjustedVocalInStart, Math.max(EPSILON, adjustedVocalInEnd - adjustedVocalInStart), duration),
      },
      drums: {
        source: fadeOut(drumTime + DRUM_CUT_SECONDS / 2, DRUM_CUT_SECONDS),
        target: fadeIn(Math.max(0, drumTime - DRUM_CUT_SECONDS / 2), DRUM_CUT_SECONDS, duration),
      },
      bass: {
        source: fadeOut(bassTime + bassSwap.duration / 2, bassSwap.duration),
        target: fadeIn(Math.max(0, bassTime - bassSwap.duration / 2), bassSwap.duration, duration),
      },
      other: {
        source: fadeOut(otherTime, otherWidth),
        target: fadeIn(Math.max(0, otherTime - otherWidth), otherWidth, duration),
      },
    }
  }

  const reason = style === 'plainBlend'
    ? 'Insufficient stem or coarse-plan evidence; using a conservative full-band blend.'
    : style === 'beatCut'
      ? 'The target starts with strong drum activity; cut drums on the nearest beat boundary.'
      : style === 'tailRide'
        ? 'The source accompaniment decays naturally; preserve its tail while the target enters.'
        : harmonicConflict
          ? 'Stable stems support a staggered bass swap; vocal overlap is removed for harmonic conflict.'
          : 'Stable stems support a drum-led transition with a later bass handoff.'

  return {
    style,
    duration,
    vocals: gains.vocals,
    drums: gains.drums,
    bass: gains.bass,
    other: gains.other,
    drumSwap,
    bassSwap,
    vocalOut: { start: round(vocalOutStart), end: round(vocalOutEnd), quietWindow: sourceQuiet },
    vocalIn: { start: round(adjustedVocalInStart), end: round(adjustedVocalInEnd), quietWindow: targetQuiet },
    overlap,
    tempoStretch,
    reason,
  }
}
