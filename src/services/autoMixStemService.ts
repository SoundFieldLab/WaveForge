import type { StemArtifact, StemEvidenceSample } from '../electron'
import type { TransitionPlan } from '../audio/types'
import {
  planStemTransition,
  type StemEvidence,
  type StemTrackEvidence,
} from '../audio/stemTransitionPlanner'

const STEMS = ['vocals', 'drums', 'bass', 'other'] as const

type StemName = typeof STEMS[number]

function toEvidence(samples: StemEvidenceSample[] | undefined): StemEvidence {
  const safe = Array.isArray(samples) ? samples : []
  return {
    envelope: safe.map(sample => ({ time: sample.time, db: sample.db })),
    activity: safe.map(sample => ({ time: sample.time, value: sample.activity })),
    confidence: safe.length >= 4 ? 0.95 : 0,
  }
}

function artifactEvidence(artifact: StemArtifact): StemTrackEvidence {
  return Object.fromEntries(STEMS.map(stem => [stem, toEvidence(artifact.evidence?.[stem])])) as StemTrackEvidence
}

function harmonicCompatibility(plan: TransitionPlan): number | undefined {
  const source = plan.v2?.key?.source
  const target = plan.v2?.key?.target
  if (!source || !target || source.confidence < 0.25 || target.confidence < 0.25) return undefined
  if (source.camelot === target.camelot && source.mode === target.mode) return 1
  if (source.camelot === target.camelot) return 0.85
  const distance = Math.min(Math.abs(source.tonic - target.tonic), 12 - Math.abs(source.tonic - target.tonic))
  return distance <= 2 ? 0.7 : distance >= 5 ? 0.3 : 0.5
}

export interface StemRefinementResult {
  plan: TransitionPlan
  sourceArtifact: StemArtifact
  targetArtifact: StemArtifact
}

/**
 * Run the optional HTDemucs refinement for a v2 plan.
 * Missing models and runtime errors are normal: null means keep the existing full-mix v2 DSP path.
 */
export async function refineTransitionWithStems(input: {
  plan: TransitionPlan
  sourceAudioPath: string
  targetAudioPath: string
  requestPrefix: string
  isStale?: () => boolean
}): Promise<StemRefinementResult | null> {
  const { plan, sourceAudioPath, targetAudioPath, requestPrefix, isStale } = input
  const requirement = plan.v2?.stemRequirement
  const bridge = window.electron?.stems
  if (plan.strategy !== 'smart-rendered-v2' || !requirement || !bridge?.separate) return null
  const status = await bridge.status().catch(() => null)
  if (!status?.available || isStale?.()) return null

  const sourceRequestId = `${requestPrefix}:source`
  const targetRequestId = `${requestPrefix}:target`
  let staleCancelled = false
  const cancelBoth = () => {
    if (staleCancelled) return
    staleCancelled = true
    void bridge.cancel(sourceRequestId)
    void bridge.cancel(targetRequestId)
  }
  const staleTimer = isStale
    ? globalThis.setInterval(() => { if (isStale()) cancelBoth() }, 100)
    : null
  try {
    const [sourceArtifact, targetArtifact] = await Promise.all([
      bridge.separate({
        inputPath: sourceAudioPath,
        mode: 'tail',
        startTime: requirement.source.startTime,
        duration: requirement.source.duration,
        requestId: sourceRequestId,
      }),
      bridge.separate({
        inputPath: targetAudioPath,
        mode: 'head',
        startTime: requirement.target.startTime,
        duration: requirement.target.duration,
        requestId: targetRequestId,
      }),
    ])
    if (isStale?.()) {
      cancelBoth()
      return null
    }
    if (!sourceArtifact || !targetArtifact) return null

    const stemChoreography = planStemTransition({
      source: artifactEvidence(sourceArtifact),
      target: artifactEvidence(targetArtifact),
      coarsePlan: {
        sourceStartTime: plan.sourceStartTime,
        sourceEndTime: plan.sourceEndTime,
        targetStartTime: plan.targetStartTime,
        targetEndTime: plan.targetEndTime,
        sourceBpm: plan.sourceBpm,
        targetBpm: plan.targetBpm,
        sourceBeatTimes: plan.sourceBeatTimes,
        targetBeatTimes: plan.targetBeatTimes,
        sourceDownbeats: plan.sourceBeatTimes?.filter((_, index) => index % 4 === 0),
        targetDownbeats: plan.targetBeatTimes?.filter((_, index) => index % 4 === 0),
        keyCompatibility: harmonicCompatibility(plan),
        confidence: plan.confidence,
      },
    })
    const stemFingerprint = `${requirement.modelVersion}:${sourceArtifact.cacheKey}:${targetArtifact.cacheKey}`
    return {
      sourceArtifact,
      targetArtifact,
      plan: {
        ...plan,
        rendererVersion: `${plan.rendererVersion}+stems-v1`,
        v2: {
          ...plan.v2,
          stemChoreography,
          stemFingerprint,
          stemArtifacts: {
            source: sourceArtifact,
            target: targetArtifact,
          },
        },
      },
    }
  } catch (error) {
    console.warn('[AutoMix] HTDemucs stem refinement failed; keeping full-mix v2 DSP:', error)
    return null
  } finally {
    if (staleTimer !== null) globalThis.clearInterval(staleTimer)
  }
}
