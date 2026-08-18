import type { TrackAnalysis } from '../audio/types'

export interface SequencingEntry<T> {
  item: T
  analysis: TrackAnalysis
}

export interface SequencingResult<T> {
  items: T[]
  originalCost: number
  reorderedCost: number
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const TIMBRE_DIMENSIONS = 8

function finite(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) ? value! : fallback
}

function meanVector(vectors: number[][], size: number): number[] {
  if (!vectors.length) return new Array(size).fill(0)
  const result = new Array(size).fill(0)
  for (const vector of vectors) {
    for (let index = 0; index < size; index += 1) result[index] += finite(vector[index])
  }
  return result.map(value => value / vectors.length)
}

function keyCorrelation(chroma: number[], profile: number[], root: number): number {
  let score = 0
  for (let pitch = 0; pitch < 12; pitch += 1) {
    score += finite(chroma[pitch]) * profile[(pitch - root + 12) % 12]
  }
  return score
}

function keyModeVector(chroma: number[]): number[] {
  let bestRoot = 0
  let bestMode: 'major' | 'minor' = 'major'
  let bestScore = Number.NEGATIVE_INFINITY
  for (let root = 0; root < 12; root += 1) {
    const majorScore = keyCorrelation(chroma, MAJOR_PROFILE, root)
    if (majorScore > bestScore) {
      bestScore = majorScore
      bestRoot = root
      bestMode = 'major'
    }
    const minorScore = keyCorrelation(chroma, MINOR_PROFILE, root)
    if (minorScore > bestScore) {
      bestScore = minorScore
      bestRoot = root
      bestMode = 'minor'
    }
  }

  // Relative major/minor keys share a location on the circle of fifths. The
  // third coordinate preserves mode, matching the paper's three-dimensional map.
  const relativeMajorRoot = bestMode === 'minor' ? (bestRoot + 3) % 12 : bestRoot
  const fifthPosition = (relativeMajorRoot * 7) % 12
  const angle = fifthPosition / 12 * Math.PI * 2
  return [Math.cos(angle), Math.sin(angle), bestMode === 'major' ? 0.5 : -0.5]
}

function rawFeature(analysis: TrackAnalysis): number[] {
  const usefulFrames = analysis.beatFeatures.filter(frame => frame.timbre.length || frame.chroma.length)
  const timbre = meanVector(usefulFrames.map(frame => frame.timbre), TIMBRE_DIMENSIONS)
  const chroma = meanVector(usefulFrames.map(frame => frame.chroma), 12)
  const bpm = Math.max(40, Math.min(240, finite(analysis.estimatedBpm, 120)))
  const octaveInvariantTempo = Math.log2(bpm)
  const tempoAngle = octaveInvariantTempo * Math.PI * 2
  return [
    ...timbre,
    ...keyModeVector(chroma),
    Math.cos(tempoAngle),
    Math.sin(tempoAngle),
  ]
}

function standardize(features: number[][]): number[][] {
  if (!features.length) return []
  const dimensions = features[0].length
  const means = new Array(dimensions).fill(0)
  const deviations = new Array(dimensions).fill(0)
  for (const feature of features) {
    for (let index = 0; index < dimensions; index += 1) means[index] += feature[index]
  }
  for (let index = 0; index < dimensions; index += 1) means[index] /= features.length
  for (const feature of features) {
    for (let index = 0; index < dimensions; index += 1) {
      const delta = feature[index] - means[index]
      deviations[index] += delta * delta
    }
  }
  for (let index = 0; index < dimensions; index += 1) {
    deviations[index] = Math.sqrt(deviations[index] / Math.max(1, features.length - 1))
  }
  return features.map(feature => feature.map((value, index) => {
    const scale = deviations[index]
    return scale < 1e-6 ? 0 : (value - means[index]) / scale
  }))
}

function euclidean(left: number[], right: number[]): number {
  let total = 0
  const dimensions = Math.min(left.length, right.length)
  for (let index = 0; index < dimensions; index += 1) {
    const delta = left[index] - right[index]
    total += delta * delta
  }
  return Math.sqrt(total)
}

function pathCost(path: number[], distances: number[][]): number {
  let result = 0
  for (let index = 1; index < path.length; index += 1) {
    result += distances[path[index - 1]][path[index]]
  }
  return result
}

/** Nearest-unvisited insertion at either tail (HAM-2 from the supplied paper). */
export function sequenceTracksHam2<T>(entries: SequencingEntry<T>[], anchor?: TrackAnalysis): SequencingResult<T> {
  if (entries.length < 2) {
    return { items: entries.map(entry => entry.item), originalCost: 0, reorderedCost: 0 }
  }

  const standardized = standardize([
    ...(anchor ? [rawFeature(anchor)] : []),
    ...entries.map(entry => rawFeature(entry.analysis)),
  ])
  const anchorFeature = anchor ? standardized[0] : undefined
  const features = anchor ? standardized.slice(1) : standardized
  const distances = features.map((left, leftIndex) => features.map((right, rightIndex) => {
    if (leftIndex === rightIndex) return 0
    return euclidean(left, right)
  }))
  const remaining = new Set(entries.map((_, index) => index).slice(1))
  const path = [0]

  while (remaining.size) {
    let bestCandidate = -1
    let bestSide: 'head' | 'tail' = 'tail'
    let bestDistance = Number.POSITIVE_INFINITY
    const head = path[0]
    const tail = path[path.length - 1]

    for (const candidate of remaining) {
      const headDistance = distances[candidate][head]
      const tailDistance = distances[tail][candidate]
      if (headDistance < bestDistance) {
        bestCandidate = candidate
        bestSide = 'head'
        bestDistance = headDistance
      }
      if (tailDistance < bestDistance) {
        bestCandidate = candidate
        bestSide = 'tail'
        bestDistance = tailDistance
      }
    }

    if (bestCandidate < 0) break
    if (bestSide === 'head') path.unshift(bestCandidate)
    else path.push(bestCandidate)
    remaining.delete(bestCandidate)
  }

  if (
    anchorFeature
    && euclidean(anchorFeature, features[path[path.length - 1]]) < euclidean(anchorFeature, features[path[0]])
  ) {
    path.reverse()
  }

  const originalPath = entries.map((_, index) => index)
  const originalAnchorCost = anchorFeature ? euclidean(anchorFeature, features[originalPath[0]]) : 0
  const reorderedAnchorCost = anchorFeature ? euclidean(anchorFeature, features[path[0]]) : 0
  return {
    items: path.map(index => entries[index].item),
    originalCost: pathCost(originalPath, distances) + originalAnchorCost,
    reorderedCost: pathCost(path, distances) + reorderedAnchorCost,
  }
}
