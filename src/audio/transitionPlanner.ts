/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import type { BeatFeatureFrame, DJEffectsPlan, KeyDetection, SectionMarker, TrackAnalysis, TransitionIntensity, TransitionPlan, V2Choreography } from './types'

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
const safeBpm = (value: number) => Math.max(40, Math.min(240, value || 120))
const DEFAULT_BEAT_COUNTS = [8, 16, 24, 32]
// v1 智能混音 BPM 差上限：保持历史行为（真实歌单常超此值而降级为交叉淡化）。
const MAX_SMART_MIX_BPM_DIFFERENCE = 5
// v2 增强版 BPM 差上限：逐拍保音高拉伸实际可承受 ±15% 变速（≈±18 BPM@120），
// 放宽到 15 使真实歌单（BPM 差 5~15 常见）不再静默降级成纯交叉淡化。
const MAX_SMART_MIX_BPM_DIFFERENCE_V2 = 15
// v2 大 BPM 差（15~100）：不做节拍对齐拉伸（±15% 外质量崩坏），改为"特效过渡"——
// 等功率交叉 + riser/混响虚化/扫频等氛围层，避免纯交叉淡化的"没有效果"。
const MAX_V2_EFFECTS_BPM_DIFFERENCE = 100
// v1 分析置信度门槛：保持历史行为。
const MIN_ANALYSIS_CONFIDENCE = 0.55
// v2 放宽：节拍/重拍网格本身可靠即可智能渲染（部分分析器置信度标定偏保守，
// 网格质量好而置信度仅 0.35~0.55 的歌曲不应被降级成纯交叉）。
const MIN_ANALYSIS_CONFIDENCE_V2 = 0.35
// 渲染器/算法版本标识：并入 plan.id，避免不同版本渲染结果在缓存中互相碰撞。
const RENDERER_VERSION = 'pitch-preserving-beatgrid-djfx-v4'
// AutoMix 增强版（v2）渲染器版本：独立于 v1，参与 v2 plan.id 与磁盘缓存 key 隔离。
const RENDERER_VERSION_V2 = 'automix-v2-dsp-r1'

interface CandidatePoint {
  time: number
  beatIndex: number
  downbeatIndex: number
  confidence: number
}

interface BeatWindow {
  point: CandidatePoint
  startTime: number
  endTime: number
  beatTimes: number[]
  frames: Array<BeatFeatureFrame | undefined>
}

interface CandidatePair {
  source: BeatWindow
  target: BeatWindow
  sourceSection?: SectionMarker
  targetSection?: SectionMarker
  sourceVocalness: number
  targetVocalness: number
  components: Record<string, number>
  cost: number
}

function cosineDistance(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 1
  const size = Math.min(a.length, b.length)
  let dot = 0
  let lengthA = 0
  let lengthB = 0
  for (let index = 0; index < size; index += 1) {
    const left = a[index] || 0
    const right = b[index] || 0
    dot += left * right
    lengthA += left * left
    lengthB += right * right
  }
  if (lengthA < 1e-12 || lengthB < 1e-12) return 1
  return clamp01(1 - dot / Math.sqrt(lengthA * lengthB))
}

function nearestBeatIndex(beats: number[], time: number): number {
  if (!beats.length) return 0
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < beats.length; index += 1) {
    const nextDistance = Math.abs(beats[index] - time)
    if (nextDistance < bestDistance) {
      bestIndex = index
      bestDistance = nextDistance
    }
  }
  return bestIndex
}

function candidatePoints(analysis: TrackAnalysis, start: number, end: number): CandidatePoint[] {
  const downbeats = analysis.downbeats
    .map((time, downbeatIndex) => {
      const beatIndex = nearestBeatIndex(analysis.beats, time)
      return {
        time: analysis.beats[beatIndex] ?? time,
        beatIndex,
        downbeatIndex,
        confidence: analysis.downbeatConfidence[downbeatIndex] ?? analysis.confidence,
      }
    })
    .filter(point => point.time >= start && point.time <= end)
  if (downbeats.length) return downbeats

  return analysis.beats
    .map((time, beatIndex) => ({
      time,
      beatIndex,
      downbeatIndex: -1,
      confidence: analysis.beatConfidence[beatIndex] ?? analysis.confidence,
    }))
    .filter(point => point.time >= start && point.time <= end)
}

function buildWindow(
  analysis: TrackAnalysis,
  point: CandidatePoint,
  beatCount: number,
  frameByBeat: Map<number, BeatFeatureFrame>,
): BeatWindow | null {
  const beatTimes = analysis.beats.slice(point.beatIndex, point.beatIndex + beatCount + 1)
  if (beatTimes.length !== beatCount + 1) return null
  if (beatTimes.some((time, index) => index > 0 && time <= beatTimes[index - 1])) return null

  return {
    point,
    startTime: beatTimes[0],
    endTime: beatTimes[beatTimes.length - 1],
    beatTimes,
    frames: Array.from({ length: beatCount }, (_, offset) => frameByBeat.get(point.beatIndex + offset)),
  }
}

/**
 * 部分同步（Apple 专利 US8704069B2 的"partial sync"）：BPM 呈整数倍（70↔140 / 60↔120 / 40↔120）
 * 时，把快曲网格按 stride=N 跳拍抽稀成"对齐网格"——每 N 个快拍映射慢曲 1 拍。
 * 对齐网格的拍间隔与慢曲一致，渲染端按 rate≈1.0 自然播放即可实现半速听感对齐，
 * 不需要对快曲做 ±N 倍时间拉伸（那会把打击乐糊成一团）。
 * 抽稀后保留下来的拍（原曲 0, N, 2N, … 拍）就是与慢曲重合的对齐点。
 */
function alignBeatGrid(analysis: TrackAnalysis, stride: number): TrackAnalysis {
  const beatCount = Math.floor(analysis.beats.length / stride)
  if (beatCount < 2) return analysis
  const beats = Array.from({ length: beatCount }, (_, index) => analysis.beats[index * stride])
  const beatConfidence = Array.from(
    { length: beatCount },
    (_, index) => analysis.beatConfidence[index * stride] ?? analysis.confidence,
  )
  const downbeats: number[] = []
  const downbeatConfidence: number[] = []
  analysis.downbeats.forEach((time, index) => {
    if (nearestBeatIndex(analysis.beats, time) % stride === 0) {
      downbeats.push(time)
      downbeatConfidence.push(analysis.downbeatConfidence[index] ?? analysis.confidence)
    }
  })
  const beatFeatures = analysis.beatFeatures
    .filter(frame => frame.beatIndex % stride === 0)
    .map(frame => ({ ...frame, beatIndex: Math.floor(frame.beatIndex / stride) }))
  return {
    ...analysis,
    beats,
    beatConfidence,
    downbeats,
    downbeatConfidence,
    beatFeatures,
  }
}

function nearestSection(sections: SectionMarker[], time: number): SectionMarker | undefined {
  return sections
    .filter(section => Math.abs(section.time - time) <= 2.5)
    .sort((left, right) => Math.abs(left.time - time) - Math.abs(right.time - time))[0]
}

function boundaryCost(section: SectionMarker | undefined): number {
  if (!section) return 0.7
  if (section.type === 'drop') return 0
  if (section.type === 'chorus' || section.type === 'break') return 0.08
  if (section.type === 'intro' || section.type === 'outro') return 0.18
  return 0.4
}

function powerCurve(length: number, fadeIn: boolean): number[] {
  const count = Math.max(2, length)
  return Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1)
    return fadeIn ? Math.sin(progress * Math.PI / 2) : Math.cos(progress * Math.PI / 2)
  })
}

function chooseBeatCount(beatDuration: number, minDuration: number, maxDuration: number): number {
  const viable = DEFAULT_BEAT_COUNTS.filter(count => {
    const duration = count * beatDuration
    return duration >= minDuration && duration <= maxDuration
  })
  if (viable.length) return viable.includes(16) ? 16 : viable.includes(24) ? 24 : viable.includes(32) ? 32 : viable[0]
  const targetDuration = Math.max(minDuration, Math.min(maxDuration, 16 * beatDuration))
  return DEFAULT_BEAT_COUNTS.reduce((best, count) => {
    const nextDistance = Math.abs(count * beatDuration - targetDuration)
    return nextDistance < best.distance ? { count, distance: nextDistance } : best
  }, { count: 16, distance: Number.POSITIVE_INFINITY }).count
}

function loudnessNormalizer(analysis: TrackAnalysis): (frame?: BeatFeatureFrame) => number {
  const values = analysis.beatFeatures.map(frame => frame.loudness).filter(Number.isFinite)
  const min = values.length ? Math.min(...values) : 0
  const max = values.length ? Math.max(...values) : 1
  const range = max - min
  return frame => {
    if (!frame || !Number.isFinite(frame.loudness)) return 0
    return range < 1e-9 ? 0.5 : clamp01((frame.loudness - min) / range)
  }
}

function averageWindowCost(
  source: BeatWindow,
  target: BeatWindow,
  sourceLoudness: (frame?: BeatFeatureFrame) => number,
  targetLoudness: (frame?: BeatFeatureFrame) => number,
) {
  let timbre = 0
  let chroma = 0
  let loudness = 0
  let vocal = 0
  let sourceVocalness = 0
  let targetVocalness = 0
  const count = Math.max(1, Math.min(source.frames.length, target.frames.length))

  for (let index = 0; index < count; index += 1) {
    const sourceFrame = source.frames[index]
    const targetFrame = target.frames[index]
    timbre += cosineDistance(sourceFrame?.timbre || [], targetFrame?.timbre || [])
    chroma += cosineDistance(sourceFrame?.chroma || [], targetFrame?.chroma || [])
    // Prefer regions where both tracks have usable energy, not merely similar silence.
    loudness += 1 - Math.min(sourceLoudness(sourceFrame), targetLoudness(targetFrame))
    const sourceVocal = clamp01(sourceFrame?.vocalness ?? 0.5)
    const targetVocal = clamp01(targetFrame?.vocalness ?? 0.5)
    sourceVocalness += sourceVocal
    targetVocalness += targetVocal
    vocal += sourceVocal * targetVocal
  }

  return {
    timbre: timbre / count,
    chroma: chroma / count,
    loudness: loudness / count,
    vocal: vocal / count,
    sourceVocalness: sourceVocalness / count,
    targetVocalness: targetVocalness / count,
  }
}

function normalizeComponent(pairs: CandidatePair[], component: string) {
  const values = pairs.map(pair => pair.components[component] ?? 0)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min
  for (const pair of pairs) {
    pair.components[component] = range < 1e-6 ? 0 : clamp01((pair.components[component] - min) / range)
  }
}

function fallbackReason(
  settings: { beatMatching: boolean },
  bpmDifference: number,
  reliableGrid: boolean,
  confidence: number,
  maxBpmDifference = MAX_SMART_MIX_BPM_DIFFERENCE,
): string | undefined {
  if (!settings.beatMatching) return 'Beat matching is disabled'
  if (bpmDifference > maxBpmDifference) {
    return `BPM difference ${bpmDifference.toFixed(1)} exceeds the ${maxBpmDifference} BPM smart-mix limit`
  }
  if (!reliableGrid) return 'Reliable beat/downbeat features are unavailable'
  if (confidence < 0.5) return 'Transition confidence is below the smart-render threshold'
  return undefined
}

/**
 * 响度补偿（借鉴 Echo Automix）：用 ITU-R BS.1770 积分响度（LUFS）差计算
 * 过渡段 target 相对 source 的增益补偿。target 更响则压（负），更轻则抬（正）。
 * 无 LUFS 数据时返回 0（不补偿）。clamp ±3.5dB。
 */
function computeGainOffsetDb(source: TrackAnalysis, target: TrackAnalysis): number {
  const sourceLufs = typeof source.integratedLufs === 'number' && Number.isFinite(source.integratedLufs) ? source.integratedLufs : null
  const targetLufs = typeof target.integratedLufs === 'number' && Number.isFinite(target.integratedLufs) ? target.integratedLufs : null
  if (sourceLufs === null || targetLufs === null) return 0
  return Math.max(-3.5, Math.min(3.5, sourceLufs - targetLufs))
}

export function planTransition(
  source: TrackAnalysis,
  target: TrackAnalysis,
  settings: { beatMatching: boolean; skipSilence: boolean; minDuration?: number; maxDuration?: number },
  strategy: 'smart-rendered' | 'beat-crossfade' = 'beat-crossfade',
): TransitionPlan {
  const sourceBpm = safeBpm(source.estimatedBpm)
  const targetBpm = safeBpm(target.estimatedBpm)
  const bpmDifference = Math.abs(sourceBpm - targetBpm)
  const beatDuration = 60 / safeBpm((sourceBpm + targetBpm) / 2)
  const tempoSimilarity = 1 - Math.min(bpmDifference / 40, 1)
  const baseDuration = tempoSimilarity > 0.8 ? 12 : tempoSimilarity > 0.5 ? 10 : 8
  const requestedMin = Number.isFinite(settings.minDuration) ? settings.minDuration! : Math.max(6, baseDuration - 2)
  const requestedMax = Number.isFinite(settings.maxDuration) ? settings.maxDuration! : Math.min(20, baseDuration + 8)
  const minDuration = Math.max(1, Math.min(20, requestedMin))
  const maxDuration = Math.max(minDuration, Math.min(20, requestedMax))
  const beatCount = chooseBeatCount(beatDuration, minDuration, maxDuration)

  const sourceFrameByBeat = new Map(source.beatFeatures.map(frame => [frame.beatIndex, frame]))
  const targetFrameByBeat = new Map(target.beatFeatures.map(frame => [frame.beatIndex, frame]))
  const sourceLoudness = loudnessNormalizer(source)
  const targetLoudness = loudnessNormalizer(target)

  const sourceWindows = candidatePoints(source, 0, source.duration)
    .map(point => buildWindow(source, point, beatCount, sourceFrameByBeat))
    .filter((window): window is BeatWindow => Boolean(window && window.endTime >= source.duration * 0.75))
  const targetStartMin = settings.skipSilence ? Math.max(0, target.introSilence) : 0
  const targetStartMax = Math.max(targetStartMin, target.duration * 0.2)
  const targetWindows = candidatePoints(target, targetStartMin, targetStartMax)
    .map(point => buildWindow(target, point, beatCount, targetFrameByBeat))
    .filter((window): window is BeatWindow => Boolean(window))

  const pairs: CandidatePair[] = []
  for (const sourceWindow of sourceWindows) {
    for (const targetWindow of targetWindows) {
      const sourceSection = nearestSection(source.sections, sourceWindow.endTime)
      const targetSection = nearestSection(target.sections, targetWindow.startTime)
      const windowCosts = averageWindowCost(sourceWindow, targetWindow, sourceLoudness, targetLoudness)
      pairs.push({
        source: sourceWindow,
        target: targetWindow,
        sourceSection,
        targetSection,
        sourceVocalness: windowCosts.sourceVocalness,
        targetVocalness: windowCosts.targetVocalness,
        components: {
          timbre: windowCosts.timbre,
          chroma: windowCosts.chroma,
          loudness: windowCosts.loudness,
          vocal: windowCosts.vocal,
          section: (boundaryCost(sourceSection) + boundaryCost(targetSection)) / 2,
          confidence: 1 - (
            source.confidence
            + target.confidence
            + sourceWindow.point.confidence
            + targetWindow.point.confidence
          ) / 4,
        },
        cost: 0,
      })
    }
  }

  if (pairs.length) {
    for (const component of ['timbre', 'chroma', 'loudness', 'vocal', 'section', 'confidence']) {
      normalizeComponent(pairs, component)
    }
    for (const pair of pairs) {
      pair.cost = pair.components.timbre * 0.23
        + pair.components.chroma * 0.15
        + pair.components.loudness * 0.14
        + pair.components.vocal * 0.20
        + pair.components.section * 0.24
        + pair.components.confidence * 0.04
    }
  }

  const chosen = pairs.length
    ? pairs.reduce((best, pair) => pair.cost < best.cost ? pair : best, pairs[0])
    : undefined
  const approximateDuration = beatCount * beatDuration
  const sourceStartTime = chosen?.source.startTime ?? Math.max(0, source.duration - approximateDuration)
  const sourceEndTime = chosen?.source.endTime ?? source.duration
  const targetStartTime = chosen?.target.startTime ?? targetStartMin
  const targetEndTime = chosen?.target.endTime ?? Math.min(target.duration, targetStartTime + approximateDuration)
  const sourceBeatTimes = chosen?.source.beatTimes ?? []
  const targetBeatTimes = chosen?.target.beatTimes ?? []
  const chosenCost = chosen?.cost ?? 1
  const confidence = clamp01(((source.confidence + target.confidence) / 2) * (1 - chosenCost * 0.35))
  const reliableGrid = Boolean(
    chosen
    && source.confidence >= MIN_ANALYSIS_CONFIDENCE
    && target.confidence >= MIN_ANALYSIS_CONFIDENCE
    && source.downbeats.length >= 2
    && target.downbeats.length >= 2
    && sourceBeatTimes.length === beatCount + 1
    && targetBeatTimes.length === beatCount + 1
  )
  const reason = fallbackReason(settings, bpmDifference, reliableGrid, confidence)
  const smartEligible = !reason
  const finalStrategy = smartEligible
    ? strategy
    : reliableGrid && bpmDifference <= MAX_SMART_MIX_BPM_DIFFERENCE
      ? 'beat-crossfade'
      : 'fixed-crossfade'

  const tempoRamp = Array.from({ length: Math.max(2, beatCount) }, (_, index) => {
    if (sourceBeatTimes.length !== beatCount + 1 || targetBeatTimes.length !== beatCount + 1) {
      const progress = index / Math.max(1, beatCount - 1)
      return sourceBpm * (1 - progress) + targetBpm * progress
    }
    const sourceDuration = sourceBeatTimes[index + 1] - sourceBeatTimes[index]
    const targetDuration = targetBeatTimes[index + 1] - targetBeatTimes[index]
    const progress = index / beatCount
    const outputDuration = (1 - progress) * sourceDuration + progress * targetDuration
    return 60 / Math.max(0.001, outputDuration)
  })
  const energeticBoundary = chosen?.sourceSection?.type === 'drop'
    || chosen?.targetSection?.type === 'drop'
    || chosen?.sourceSection?.type === 'chorus'
  const vocalOverlap = chosen
    ? chosen.sourceVocalness * chosen.targetVocalness
    : 0.5
  const effectIntensity = clamp01(
    (energeticBoundary ? 0.68 : 0.56)
    - vocalOverlap * 0.18
    + confidence * 0.08,
  )
  const djEffects = smartEligible ? {
    enabled: true,
    profile: energeticBoundary ? 'energetic' as const : 'smooth' as const,
    intensity: effectIntensity,
    bassSwap: true,
    filterSweep: true,
    echoOut: (chosen?.sourceVocalness ?? 1) < 0.65,
    sweepFx: true,
    echoDelayBeats: energeticBoundary ? 1 : 0.5,
    echoFeedback: energeticBoundary ? 0.28 : 0.22,
  } : undefined

  const gainOffsetDb = computeGainOffsetDb(source, target)

  return {
    id: `${source.trackKey}->${target.trackKey}:${finalStrategy}:${sourceStartTime.toFixed(3)}-${sourceEndTime.toFixed(3)}:${targetStartTime.toFixed(3)}-${targetEndTime.toFixed(3)}:${beatCount}:${gainOffsetDb.toFixed(1)}:${RENDERER_VERSION}`,
    sourceTrackKey: source.trackKey,
    targetTrackKey: target.trackKey,
    sourceStartTime,
    sourceEndTime,
    targetStartTime,
    targetEndTime,
    beatCount,
    sourceBpm,
    targetBpm,
    tempoRamp,
    sourceDownbeatIndex: chosen?.source.point.downbeatIndex ?? -1,
    targetDownbeatIndex: chosen?.target.point.downbeatIndex ?? -1,
    sourceSection: chosen?.sourceSection,
    targetSection: chosen?.targetSection,
    sourceBeatTimes,
    targetBeatTimes,
    djEffects,
    gainCurve: {
      source: powerCurve(Math.max(32, beatCount * 16), false),
      target: powerCurve(Math.max(32, beatCount * 16), true),
    },
    gainOffsetDb,
    confidence,
    strategy: finalStrategy,
    fallbackReason: reason,
    analysisVersion: source.analysisVersion === target.analysisVersion ? source.analysisVersion : 'mixed-analysis',
    rendererVersion: RENDERER_VERSION,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AutoMix 增强版（v2）计划层
// 与 v1 完全隔离：独立函数、独立策略名、独立版本常量；v1 的 planTransition 零改动。
// v2 在 v1 的候选点/窗口/成本框架之上增加：调性匹配（Krumhansl-Schmuckler）、
// 乐句对齐、能量曲线匹配、特效编排（choreography）与强度档位。
// ─────────────────────────────────────────────────────────────────────────────

// Krumhansl-Kessler 调性轮廓（12 个半音），用于 K-S 调性检测
const KRUMMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KRUMMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const INTENSITY_BASE: Record<TransitionIntensity, number> = { subtle: 0.55, standard: 0.75, strong: 1.0 }

/** 从逐拍 chroma（beatFeatures）聚合检测调性：K-S 相关法。无 chroma 数据时返回 undefined。 */
function detectKey(frames: BeatFeatureFrame[]): KeyDetection | undefined {
  const chromaFrames = frames.filter(frame => Array.isArray(frame.chroma) && frame.chroma.length === 12)
  if (chromaFrames.length < 8) return undefined
  const profile = new Array(12).fill(0)
  for (const frame of chromaFrames) {
    for (let pitch = 0; pitch < 12; pitch += 1) profile[pitch] += frame.chroma[pitch] || 0
  }
  let energy = 0
  for (const value of profile) energy += value * value
  if (energy < 1e-9) return undefined

  let bestTonic = 0
  let bestMode: 'major' | 'minor' = 'major'
  let bestScore = -Infinity
  for (const mode of ['major', 'minor'] as const) {
    const krummhansl = mode === 'major' ? KRUMMHANSL_MAJOR : KRUMMHANSL_MINOR
    for (let tonic = 0; tonic < 12; tonic += 1) {
      let dot = 0
      let lengthK = 0
      let lengthP = 0
      for (let pitch = 0; pitch < 12; pitch += 1) {
        const rotated = krummhansl[(pitch + tonic) % 12]
        const value = profile[pitch]
        dot += rotated * value
        lengthK += rotated * rotated
        lengthP += value * value
      }
      const score = dot / Math.sqrt(lengthK * lengthP)
      if (score > bestScore) {
        bestScore = score
        bestTonic = tonic
        bestMode = mode
      }
    }
  }
  const confidence = clamp01((bestScore - 0.25) / 0.75)
  return { tonic: bestTonic, mode: bestMode, confidence, camelot: camelotNumber(bestTonic, bestMode) }
}

/** Camelot 轮盘编号（1-12）：大调 = (tonic*7+8) mod 12（0→12），小调用关系大调主音。 */
function camelotNumber(tonic: number, mode: 'major' | 'minor'): number {
  const relativeMajorTonic = mode === 'major' ? tonic : (tonic + 3) % 12
  const value = ((relativeMajorTonic * 7 + 8) % 12) || 12
  return value
}

/** 调性兼容度 0-1（harmonic mixing）：同调=1，关系调/同号=0.85，相邻=0.7，纯五度=0.5。 */
function keyCompatibility(a?: KeyDetection, b?: KeyDetection): number {
  if (!a || !b) return 0.5 // 任一缺失 → 中性分
  if (a.camelot === b.camelot) return a.mode === b.mode ? 1.0 : 0.85
  const numberDelta = Math.abs(a.camelot - b.camelot)
  const circularDelta = Math.min(numberDelta, 12 - numberDelta)
  if (circularDelta === 1 && a.mode === b.mode) return 0.7
  if (circularDelta === 7) return 0.5
  return 0.25
}

/** 窗口平均能量（0-1）：无帧数据时返回中性值。 */
function windowEnergy(window: BeatWindow): number {
  const values = window.frames
    .map(frame => frame?.energy)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (!values.length) return 0.5
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 乐句对齐成本：目标窗口起点落在 8 拍乐句边界时最优。 */
function phraseCost(target: BeatWindow): number {
  const downbeatIndex = target.point.downbeatIndex
  if (downbeatIndex < 0) return 0.5
  const remainder = downbeatIndex % 8
  if (remainder === 0) return 0
  if (remainder % 4 === 0) return 0.3
  return 0.6
}

function buildV2GainCurves(
  beatCount: number,
  style: V2Choreography['style'],
  energyBalance = 0,
): { source: number[]; target: number[] } {
  const length = Math.max(32, beatCount * 16)
  // 能量中点偏移：energyBalance>0（target 更响）→ 交叉中点略提前（source 更快让位），
  // 避免 target 进来时响度叠加；最多 ±6%。
  const midShift = clamp01(Math.abs(energyBalance)) * 0.06 * Math.sign(energyBalance)
  const source: number[] = new Array(length)
  const target: number[] = new Array(length)
  for (let index = 0; index < length; index += 1) {
    const progress = index / (length - 1)
    const shifted = clamp01(progress + midShift)
    let sourceValue = Math.cos(shifted * Math.PI / 2)
    let targetValue = Math.sin(shifted * Math.PI / 2)
    if (style === 'atmospheric') {
      // 氛围型：过渡中点让源侧轻轻"沉"一下再交棒，制造呼吸感（虚化的听觉铺垫）
      const dip = 1 - 0.18 * Math.exp(-Math.pow((progress - 0.55) / 0.14, 2))
      sourceValue *= dip
      targetValue *= 0.92 + 0.08 * Math.sin(progress * Math.PI)
    }
    source[index] = clamp01(sourceValue)
    target[index] = clamp01(targetValue)
  }
  return { source, target }
}

interface V2ChoreographyResult {
  choreography: V2Choreography
  djEffects: DJEffectsPlan
}

function buildV2Choreography(options: {
  sourceSection?: SectionMarker
  targetSection?: SectionMarker
  sourceVocalness: number
  bpmDifference: number
  energyDelta: number
  avgEnergy: number
  keyCompat: number
  intensity: TransitionIntensity
}): V2ChoreographyResult {
  const { sourceSection, targetSection, sourceVocalness, bpmDifference, energyDelta, avgEnergy, keyCompat, intensity } = options
  const energeticBoundary = sourceSection?.type === 'drop'
    || sourceSection?.type === 'chorus'
    || targetSection?.type === 'drop'
  // 风格判定基准（修复"真实验证中大多数过渡落入最克制 clean 风格、听不出效果"的问题）：
  // 流行/舞曲常规能量 + BPM 差在智能混音上限内 → energetic（含鼓点/加速/riser）；
  // 极低能量或明确 outro→intro 衔接 → atmospheric；其余才 fallback 到 clean。
  // 过渡型分级（谐波混音视角）：调性兼容度作为关键修正——
  // 高兼容（keyCompat≥0.85）→ 放心做干净/高能量过渡；低兼容（<0.5）→ 氛围化掩盖
  // （回声/混响虚化），避免在和声冲突上做张扬的特效。
  const style: V2Choreography['style'] = energeticBoundary
    || (bpmDifference <= MAX_SMART_MIX_BPM_DIFFERENCE_V2 && energyDelta < 0.4 && avgEnergy >= 0.3)
    ? (keyCompat >= 0.5 ? 'energetic' : 'atmospheric')
    : avgEnergy < 0.25 || keyCompat < 0.45 || (sourceSection?.type === 'outro' && (!targetSection || targetSection.type === 'intro'))
      ? 'atmospheric'
      : 'clean'
  const vocalLow = (sourceVocalness ?? 1) < 0.65

  let choreography: V2Choreography
  if (style === 'energetic') {
    choreography = {
      style,
      intensity,
      riser: true,
      noiseSweep: true,
      drumFill: true,
      tempoRampUp: true,
      reverbDip: false,
      echoOut: vocalLow,
      bassSwap: true,
      filterSweep: true,
      drumFillBeats: 2,
      keyCompat,
      energyDelta,
    }
  } else if (style === 'atmospheric') {
    choreography = {
      style,
      intensity,
      // riser 开启：氛围型过渡同样要有可听的 DJ 收尾（渐强扫频导向 handoff），
      // 与噪声扫频/回声配合，避免"只有压低音量"的听感。
      riser: true,
      noiseSweep: true,
      drumFill: false,
      tempoRampUp: false,
      reverbDip: true,
      echoOut: true,
      bassSwap: true,
      // filterSweep 开启：DJ 式滤波扫频（中段抽低音压暗/尾部提亮），
      // 氛围型同样要有对音乐本身的混音处理，不是只有叠加合成音效
      filterSweep: true,
      drumFillBeats: 0,
      keyCompat,
      energyDelta,
    }
  } else {
    choreography = {
      style,
      intensity,
      riser: false,
      noiseSweep: false,
      drumFill: false,
      tempoRampUp: false,
      reverbDip: false,
      echoOut: false,
      bassSwap: true,
      filterSweep: true,
      drumFillBeats: 0,
      keyCompat,
      energyDelta,
    }
  }

  const intensityBase = INTENSITY_BASE[intensity]
  const djEffects: DJEffectsPlan = {
    enabled: true,
    profile: style === 'energetic' ? 'energetic' : 'smooth',
    intensity: clamp01(0.45 + intensityBase * 0.35),
    bassSwap: choreography.bassSwap,
    filterSweep: choreography.filterSweep,
    echoOut: choreography.echoOut,
    sweepFx: choreography.noiseSweep,
    echoDelayBeats: style === 'energetic' ? 1 : 0.5,
    echoFeedback: style === 'energetic' ? 0.28 : 0.22,
  }
  return { choreography, djEffects }
}

/**
 * 谐波混音（Vande Veire 2018）：过渡窗口内把目标曲变调到源曲主音，
 * 让两曲和声兼容（跨主音对齐）。仅在同调性（同 mode）且 |变调| ≤ 2 半音时启用：
 * 再大的变调会失真；不同 mode 时仅相对大小调（同音集，C 大调↔A 小调）天然兼容。
 * 返回目标窗口需变调的半音数（0 = 不变调）。
 */
function keyPitchShiftSemitones(
  sourceKey: KeyDetection | undefined,
  targetKey: KeyDetection | undefined,
): number {
  if (!sourceKey || !targetKey) return 0
  const confident = (sourceKey.confidence ?? 0) >= MIN_ANALYSIS_CONFIDENCE_V2
    && (targetKey.confidence ?? 0) >= MIN_ANALYSIS_CONFIDENCE_V2
  if (!confident) return 0
  const tonicDiff = (sourceKey.tonic - targetKey.tonic + 12) % 12
  if (sourceKey.mode === targetKey.mode) {
    // 同调性：目标主音对齐源曲主音（±6 内取最短路径）
    const shift = tonicDiff > 6 ? tonicDiff - 12 : tonicDiff
    return Math.abs(shift) <= 2 ? shift : 0
  }
  // 不同调性：相对大小调（同音集）无需移调；其余差异不强行对齐（避免平行调冲突）
  return 0
}

/**
 * AutoMix 增强版（v2）计划生成器。
 * 输出策略为 'smart-rendered-v2'（走 v2 渲染器）或与 v1 相同的降级策略
 * （beat-crossfade / fixed-crossfade），降级路径与 v1 完全一致。
 */
export function planTransitionV2(
  source: TrackAnalysis,
  target: TrackAnalysis,
  settings: {
    beatMatching: boolean
    skipSilence: boolean
    minDuration?: number
    maxDuration?: number
    intensity?: TransitionIntensity
    aiMix?: boolean
  },
  strategy: 'smart-rendered-v2' = 'smart-rendered-v2',
): TransitionPlan {
  const sourceBpm = safeBpm(source.estimatedBpm)
  const targetBpm = safeBpm(target.estimatedBpm)
  const bpmDifference = Math.abs(sourceBpm - targetBpm)
  // 部分同步（Apple 专利）：BPM 差 15~100 且快曲≈慢曲整数倍（±5% 容差）→
  // 快曲跳拍对齐慢曲网格。有效 BPM 差≈0，可走完整智能混音而无需 ±N 倍拉伸。
  let partialSyncN = 0
  if (bpmDifference > MAX_SMART_MIX_BPM_DIFFERENCE_V2 && bpmDifference <= MAX_V2_EFFECTS_BPM_DIFFERENCE) {
    const bpmRatio = Math.max(sourceBpm, targetBpm) / Math.max(1e-6, Math.min(sourceBpm, targetBpm))
    if (bpmRatio >= 1.9 && bpmRatio <= 2.1) partialSyncN = 2
    else if (bpmRatio >= 2.9 && bpmRatio <= 3.1) partialSyncN = 3
    else if (bpmRatio >= 3.9 && bpmRatio <= 4.1) partialSyncN = 4
  }
  if (partialSyncN > 0) {
    // 快曲换成跳拍对齐视图：windows/拍网格/特征全部基于对齐网格（慢拍间隔）。
    const fastAnalysis = sourceBpm > targetBpm ? source : target
    const aligned = alignBeatGrid(fastAnalysis, partialSyncN)
    if (sourceBpm > targetBpm) source = aligned
    else target = aligned
  }
  // 时长定标用有效节奏：部分同步时两曲听感同速（慢曲速度），否则用两曲均值
  const effectiveTempoBpm = partialSyncN > 0 ? Math.min(sourceBpm, targetBpm) : (sourceBpm + targetBpm) / 2
  const beatDuration = 60 / safeBpm(effectiveTempoBpm)
  const tempoSimilarity = 1 - Math.min(bpmDifference / 40, 1)
  const baseDuration = tempoSimilarity > 0.8 ? 12 : tempoSimilarity > 0.5 ? 10 : 8
  // v2 过渡时长由算法根据 BPM 相似度智能决定，不读取用户设置的最短/最长
  // （用户手动调 min/max 会把过渡窗口卡在不合适的长度，破坏混音效果）。
  const minDuration = Math.max(1, Math.min(20, baseDuration - 2))
  const maxDuration = Math.max(minDuration, Math.min(20, baseDuration + 8))
  const beatCount = chooseBeatCount(beatDuration, minDuration, maxDuration)
  const intensity = settings.intensity ?? 'standard'

  const sourceKey = detectKey(source.beatFeatures)
  const targetKey = detectKey(target.beatFeatures)
  const keyCompat = keyCompatibility(sourceKey, targetKey)

  const sourceFrameByBeat = new Map(source.beatFeatures.map(frame => [frame.beatIndex, frame]))
  const targetFrameByBeat = new Map(target.beatFeatures.map(frame => [frame.beatIndex, frame]))
  const sourceLoudness = loudnessNormalizer(source)
  const targetLoudness = loudnessNormalizer(target)

  const sourceWindows = candidatePoints(source, 0, source.duration)
    .map(point => buildWindow(source, point, beatCount, sourceFrameByBeat))
    .filter((window): window is BeatWindow => Boolean(window && window.endTime >= source.duration * 0.75))
  const targetStartMin = settings.skipSilence ? Math.max(0, target.introSilence) : 0
  const targetStartMax = Math.max(targetStartMin, target.duration * 0.2)
  const targetWindows = candidatePoints(target, targetStartMin, targetStartMax)
    .map(point => buildWindow(target, point, beatCount, targetFrameByBeat))
    .filter((window): window is BeatWindow => Boolean(window))

  const pairs: CandidatePair[] = []
  for (const sourceWindow of sourceWindows) {
    for (const targetWindow of targetWindows) {
      const sourceSection = nearestSection(source.sections, sourceWindow.endTime)
      const targetSection = nearestSection(target.sections, targetWindow.startTime)
      const windowCosts = averageWindowCost(sourceWindow, targetWindow, sourceLoudness, targetLoudness)
      const sourceEnergy = windowEnergy(sourceWindow)
      const targetEnergy = windowEnergy(targetWindow)
      const energyDelta = Math.abs(sourceEnergy - targetEnergy)
      pairs.push({
        source: sourceWindow,
        target: targetWindow,
        sourceSection,
        targetSection,
        sourceVocalness: windowCosts.sourceVocalness,
        targetVocalness: windowCosts.targetVocalness,
        components: {
          timbre: windowCosts.timbre,
          chroma: windowCosts.chroma,
          loudness: windowCosts.loudness,
          vocal: windowCosts.vocal,
          section: (boundaryCost(sourceSection) + boundaryCost(targetSection)) / 2,
          confidence: 1 - (
            source.confidence
            + target.confidence
            + sourceWindow.point.confidence
            + targetWindow.point.confidence
          ) / 4,
          key: 1 - keyCompat,
          phrase: phraseCost(targetWindow),
          energy: energyDelta,
        },
        cost: 0,
      })
    }
  }

  if (pairs.length) {
    for (const component of ['timbre', 'chroma', 'loudness', 'vocal', 'section', 'confidence', 'key', 'phrase', 'energy']) {
      normalizeComponent(pairs, component)
    }
    for (const pair of pairs) {
      pair.cost = pair.components.timbre * 0.18
        + pair.components.chroma * 0.10
        + pair.components.loudness * 0.10
        + pair.components.vocal * 0.18
        + pair.components.section * 0.18
        + pair.components.confidence * 0.03
        + pair.components.key * 0.12
        + pair.components.phrase * 0.06
        + pair.components.energy * 0.05
    }
  }

  const chosen = pairs.length
    ? pairs.reduce((best, pair) => pair.cost < best.cost ? pair : best, pairs[0])
    : undefined
  const approximateDuration = beatCount * beatDuration
  const sourceStartTime = chosen?.source.startTime ?? Math.max(0, source.duration - approximateDuration)
  const sourceEndTime = chosen?.source.endTime ?? source.duration
  const targetStartTime = chosen?.target.startTime ?? targetStartMin
  const targetEndTime = chosen?.target.endTime ?? Math.min(target.duration, targetStartTime + approximateDuration)
  const sourceBeatTimes = chosen?.source.beatTimes ?? []
  const targetBeatTimes = chosen?.target.beatTimes ?? []
  const chosenCost = chosen?.cost ?? 1
  const confidence = clamp01(((source.confidence + target.confidence) / 2) * (1 - chosenCost * 0.35))
  const reliableGrid = Boolean(
    chosen
    && source.confidence >= MIN_ANALYSIS_CONFIDENCE_V2
    && target.confidence >= MIN_ANALYSIS_CONFIDENCE_V2
    && source.downbeats.length >= 2
    && target.downbeats.length >= 2
    && sourceBeatTimes.length === beatCount + 1
    && targetBeatTimes.length === beatCount + 1
  )
  // 策略判定：BPM 差 ≤15 → 全节拍对齐智能混音；15<差≤100 → 整数倍 BPM 对走
  // 部分同步（快曲跳拍对齐，仍为智能混音），其余走特效过渡（无节拍对齐，
  // 交叉 + 氛围特效层，保证真实歌单大 BPM 差也有实际效果）；>100 → 降级 fixed-crossfade。
  let reason: string | undefined
  let withoutBeatGrid = false
  if (bpmDifference > MAX_V2_EFFECTS_BPM_DIFFERENCE) {
    reason = `BPM difference ${bpmDifference.toFixed(1)} exceeds the ${MAX_V2_EFFECTS_BPM_DIFFERENCE} BPM smart-mix limit`
  } else if (bpmDifference > MAX_SMART_MIX_BPM_DIFFERENCE_V2) {
    if (partialSyncN > 0 && reliableGrid) {
      // 部分同步：快曲跳拍对齐慢曲网格（有效 BPM 差≈0），走完整智能混音
      reason = undefined
    } else {
      withoutBeatGrid = true
      reason = undefined
    }
  } else {
    reason = fallbackReason(settings, bpmDifference, reliableGrid, confidence, MAX_SMART_MIX_BPM_DIFFERENCE_V2)
  }
  const smartEligible = !reason
  const finalStrategy = smartEligible
    ? strategy
    : reliableGrid && bpmDifference <= MAX_V2_EFFECTS_BPM_DIFFERENCE
      ? 'beat-crossfade'
      : 'fixed-crossfade'

  const tempoRamp = Array.from({ length: Math.max(2, beatCount) }, (_, index) => {
    if (sourceBeatTimes.length !== beatCount + 1 || targetBeatTimes.length !== beatCount + 1) {
      const progress = index / Math.max(1, beatCount - 1)
      return sourceBpm * (1 - progress) + targetBpm * progress
    }
    const sourceDuration = sourceBeatTimes[index + 1] - sourceBeatTimes[index]
    const targetDuration = targetBeatTimes[index + 1] - targetBeatTimes[index]
    const progress = index / beatCount
    const outputDuration = (1 - progress) * sourceDuration + progress * targetDuration
    return 60 / Math.max(0.001, outputDuration)
  })

  const sourceEnergy = chosen ? windowEnergy(chosen.source) : 0.5
  const targetEnergy = chosen ? windowEnergy(chosen.target) : 0.5
  const energyDelta = Math.abs(sourceEnergy - targetEnergy)
  const { choreography, djEffects } = buildV2Choreography({
    sourceSection: chosen?.sourceSection,
    targetSection: chosen?.targetSection,
    sourceVocalness: chosen?.sourceVocalness ?? 1,
    // 部分同步时有效 BPM 差≈0（两曲听感同速），按匹配节拍对待编排
    bpmDifference: partialSyncN > 0 ? 0 : bpmDifference,
    energyDelta,
    avgEnergy: (sourceEnergy + targetEnergy) / 2,
    keyCompat,
    intensity,
  })
  const smartEffects = smartEligible ? djEffects : undefined
  const gainOffsetDb = computeGainOffsetDb(source, target)
  // 大 BPM 差（无节拍对齐）时：编排固定为氛围型并显式开启氛围特效
  // （riser/噪声扫频/混响虚化/回声），关闭依赖节拍网格的特效（鼓点/加速/低音互换/滤波扫频）。
  const finalChoreography = withoutBeatGrid
    ? {
      ...choreography,
      style: 'atmospheric' as const,
      riser: true,
      noiseSweep: true,
      reverbDip: true,
      echoOut: true,
      drumFill: false,
      tempoRampUp: false,
      bassSwap: false,
      filterSweep: false,
      drumFillBeats: 0,
    }
    : choreography

  // ── 乐句锚定：riser 收在 source 的 drop/break/outro 段落，混响虚化从 outro 前开始 ──
  const srcSection = chosen?.sourceSection
  let riserEndBeat: number | undefined
  if (srcSection && (srcSection.type === 'drop' || srcSection.type === 'break' || srcSection.type === 'outro')) {
    const relBeat = srcSection.beatIndex - (chosen?.source.point.beatIndex ?? 0)
    if (relBeat > 3 && relBeat <= beatCount) riserEndBeat = relBeat
  }
  const anchoredChoreography: V2Choreography = {
    ...finalChoreography,
    riserStartBeat: (riserEndBeat ?? beatCount) - 3,
    reverbStartBeat: finalChoreography.reverbDip
      ? Math.round(beatCount * (srcSection?.type === 'outro' ? 0.4 : 0.55))
      : undefined,
    // 调性驱动 riser 终频：target 主音对应频率乘 2^n 落入 2-4kHz（key 置信度≥0.4 才用）
    riserEndFreq: targetKey && targetKey.confidence >= 0.4
      ? tonicToAudibleFreq(targetKey.tonic, targetKey.mode)
      : 2400,
  }
  // 目标窗口逐拍 vocalness：渲染期人声 ducking 用（避免进入曲人声与源曲重叠）
  const targetVocalness = chosen?.target.frames.map(frame => frame?.vocalness ?? 0.5) ?? []
  // 谐波变调：过渡窗口内目标曲变调到源曲主音（≤2 半音），和声兼容
  const pitchShiftSemitones = keyPitchShiftSemitones(sourceKey, targetKey)
  // 能量平衡：target 更响 → 正，交叉中点略提前
  const energyBalance = (targetEnergy - sourceEnergy) / Math.max(0.1, targetEnergy + sourceEnergy)
  const v2 = {
    key: { source: sourceKey, target: targetKey },
    choreography: anchoredChoreography,
    intensity,
    aiMix: settings.aiMix === true,
    withoutBeatGrid,
    ...(partialSyncN > 0 ? { partialSyncN } : {}),
    ...(pitchShiftSemitones !== 0 ? { pitchShiftSemitones } : {}),
    targetVocalness,
  }

  return {
    id: `${source.trackKey}->${target.trackKey}:${finalStrategy}:${sourceStartTime.toFixed(3)}-${sourceEndTime.toFixed(3)}:${targetStartTime.toFixed(3)}-${targetEndTime.toFixed(3)}:${beatCount}:${gainOffsetDb.toFixed(1)}:${intensity}:${settings.aiMix ? 'ai' : 'dsp'}${withoutBeatGrid ? ':nogrid' : ''}${partialSyncN > 0 ? `:ps${partialSyncN}` : ''}${pitchShiftSemitones !== 0 ? `:pshift${pitchShiftSemitones > 0 ? '+' : ''}${pitchShiftSemitones}` : ''}:${RENDERER_VERSION_V2}`,
    sourceTrackKey: source.trackKey,
    targetTrackKey: target.trackKey,
    sourceStartTime,
    sourceEndTime,
    targetStartTime,
    targetEndTime,
    beatCount,
    sourceBpm,
    targetBpm,
    tempoRamp,
    sourceDownbeatIndex: chosen?.source.point.downbeatIndex ?? -1,
    targetDownbeatIndex: chosen?.target.point.downbeatIndex ?? -1,
    sourceSection: chosen?.sourceSection,
    targetSection: chosen?.targetSection,
    sourceBeatTimes,
    targetBeatTimes,
    djEffects: smartEffects,
    v2,
    gainCurve: buildV2GainCurves(beatCount, anchoredChoreography.style, energyBalance),
    gainOffsetDb,
    confidence,
    strategy: finalStrategy,
    fallbackReason: reason,
    analysisVersion: source.analysisVersion === target.analysisVersion ? source.analysisVersion : 'mixed-analysis',
    rendererVersion: RENDERER_VERSION_V2,
  }
}

/** 调性主音 → 可听 riser 终频：以 220Hz(A3)=参考，主音音高乘 2^n 落入 [2000, 4000]Hz。 */
function tonicToAudibleFreq(tonic: number, mode: 'major' | 'minor'): number {
  const a3 = 220
  const f = a3 * Math.pow(2, (tonic - 9) / 12)
  let result = f
  while (result < 2000) result *= 2
  while (result > 4000) result /= 2
  return Math.round(result)
}
