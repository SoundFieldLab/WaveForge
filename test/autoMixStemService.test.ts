import { afterEach, describe, expect, it, vi } from 'vitest'
import { refineTransitionWithStems } from '../src/services/autoMixStemService'
import type { TransitionPlan } from '../src/audio/types'
import type { StemArtifact } from '../src/electron'

function artifact(side: 'source' | 'target'): StemArtifact {
  const start = side === 'source' ? 90 : 10
  const samples = (values: number[]) => values.map((db, index) => ({
    time: start + index * 0.5,
    db,
    activity: Math.max(0, Math.min(1, (db + 60) / 48)),
  }))
  return {
    version: 1,
    engine: 'htdemucs-test',
    cacheKey: `${side}-cache`,
    cached: false,
    requestId: side,
    startSeconds: start,
    duration: 10,
    sampleRate: 44100,
    channels: 2,
    frames: 441000,
    files: { drums: `${side}-drums.wav`, bass: `${side}-bass.wav`, vocals: `${side}-vocals.wav`, other: `${side}-other.wav` },
    evidence: {
      drums: samples(Array(21).fill(side === 'target' ? -14 : -12)),
      bass: samples(Array(21).fill(-16)),
      vocals: samples(side === 'source' ? [...Array(14).fill(-10), ...Array(7).fill(-60)] : [...Array(2).fill(-60), ...Array(19).fill(-10)]),
      other: samples(Array(21).fill(-18)),
    },
    manifestPath: `${side}-manifest.json`,
  }
}

function plan(): TransitionPlan {
  return {
    id: 'src->tgt:v2', sourceTrackKey: 'src', targetTrackKey: 'tgt',
    sourceStartTime: 90, sourceEndTime: 100, targetStartTime: 10, targetEndTime: 20,
    beatCount: 20, sourceBpm: 120, targetBpm: 124, tempoRamp: [],
    sourceDownbeatIndex: 0, targetDownbeatIndex: 0,
    sourceBeatTimes: Array.from({ length: 21 }, (_, i) => 90 + i * 0.5),
    targetBeatTimes: Array.from({ length: 21 }, (_, i) => 10 + i * 0.5),
    gainCurve: { source: [1, 0], target: [0, 1] }, confidence: 0.9,
    strategy: 'smart-rendered-v2', analysisVersion: 'test', rendererVersion: 'v2',
    v2: {
      aiMix: false,
      stemRequirement: {
        source: { role: 'tail', startTime: 70, duration: 30 },
        target: { role: 'head', startTime: 10, duration: 30 },
        model: 'htdemucs', modelVersion: 'test-v1',
      },
    },
  }
}

const previousWindow = (globalThis as { window?: unknown }).window
afterEach(() => { (globalThis as { window?: unknown }).window = previousWindow })

describe('refineTransitionWithStems', () => {
  it('模型不可用时返回 null，保持原 v2 DSP fallback', async () => {
    ;(globalThis as { window?: unknown }).window = { electron: { stems: { status: vi.fn().mockResolvedValue({ available: false }) } } }
    expect(await refineTransitionWithStems({ plan: plan(), sourceAudioPath: 's.wav', targetAudioPath: 't.wav', requestPrefix: 'x' })).toBeNull()
  })

  it('模型可用时并行分离两侧并生成 stem choreography 和稳定指纹', async () => {
    const separate = vi.fn(async (request: { mode: string }) => request.mode === 'tail' ? artifact('source') : artifact('target'))
    ;(globalThis as { window?: unknown }).window = { electron: { stems: { status: vi.fn().mockResolvedValue({ available: true }), separate, cancel: vi.fn() } } }
    const result = await refineTransitionWithStems({ plan: plan(), sourceAudioPath: 's.wav', targetAudioPath: 't.wav', requestPrefix: 'pair' })
    expect(separate).toHaveBeenCalledTimes(2)
    expect(result?.plan.id).toBe('src->tgt:v2')
    expect(result?.plan.v2?.stemChoreography).toBeDefined()
    expect(result?.plan.v2?.stemFingerprint).toContain('source-cache:target-cache')
    expect(result?.plan.v2?.stemArtifacts?.source.files.vocals).toBe('source-vocals.wav')
  })

  it('结果返回时计划已 stale 则丢弃并取消两侧请求', async () => {
    const cancel = vi.fn()
    const separate = vi.fn(async (request: { mode: string }) => request.mode === 'tail' ? artifact('source') : artifact('target'))
    let calls = 0
    ;(globalThis as { window?: unknown }).window = { electron: { stems: { status: vi.fn().mockResolvedValue({ available: true }), separate, cancel } } }
    const result = await refineTransitionWithStems({
      plan: plan(), sourceAudioPath: 's.wav', targetAudioPath: 't.wav', requestPrefix: 'stale',
      isStale: () => ++calls >= 2,
    })
    expect(result).toBeNull()
    expect(cancel).toHaveBeenCalledTimes(2)
  })
})
