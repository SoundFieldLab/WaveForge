import { describe, expect, it } from 'vitest'
import type { TrackAnalysis } from '../src/audio/types'
import { buildBeatFxEvents, resolveBeatFxLiveStrengths } from '../src/services/foliaBeatFxFeed'
import { BEAT_EFFECT_IDS } from '../src/vendor/folia/services/beatFx/beatEffects'
import type { BeatFxEvent } from '../src/vendor/folia/services/beatFx/clock'

const makeAnalysis = (beats: number[], downbeats: number[], energies: number[]): TrackAnalysis => ({
    schemaVersion: 1,
    trackKey: 'test',
    duration: beats[beats.length - 1] ?? 10,
    provider: 'beat_this',
    beats,
    downbeats,
    beatConfidence: [],
    downbeatConfidence: [],
    estimatedBpm: 120,
    confidence: 0.9,
    sections: [],
    beatFeatures: energies.map((energy, index) => ({
        beatIndex: index,
        time: beats[index] ?? 0,
        loudness: 0,
        rms: 0,
        chroma: [],
        timbre: [],
        vocalness: 0,
        energy,
    })),
    introSilence: 0,
    outroSilence: 0,
})

describe('foliaBeatFxFeed', () => {
    it('merges beats and downbeats into one sorted event table with normalized impact', () => {
        // 8 拍，downbeat 在第 0/4 拍；能量从 0.1 线性到 0.9
        const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]
        const downbeats = [0, 2]
        const energies = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9]
        const events = buildBeatFxEvents(makeAnalysis(beats, downbeats, energies))

        expect(events).toHaveLength(beats.length)
        // 全表按时间升序
        for (let index = 1; index < events.length; index += 1) {
            expect(events[index].t).toBeGreaterThan(events[index - 1].t)
        }
        // downbeat 替换所在拍的 kind
        expect(events[0].kind).toBe('downbeat')
        expect(events[4].kind).toBe('downbeat')
        expect(events[1].kind).toBe('beat')
        // impact 按全曲范围归一到 0..1：最弱 0，最强 1
        expect(events[0].impact).toBeCloseTo(0, 5)
        expect(events[7].impact).toBeCloseTo(1, 5)
        // barPos 从 downbeat 重新计数
        expect(events[0].barPos).toBe(0)
        expect(events[4].barPos).toBe(0)
        expect(events[6].barPos).toBe(2)
    })

    it('keeps every beat rhythmic so accent gain never zeroes out', () => {
        const events = buildBeatFxEvents(makeAnalysis([0, 0.5, 1], [0], [0.2, 0.5, 0.8]))
        for (const event of events as BeatFxEvent[]) {
            expect(event.rhythmic).toBe(true)
        }
    })

    it('resolves live strengths: disabled or off effects are 0, enabled scale by strength', () => {
        const settings = {
            enabled: true,
            effects: {
                [BEAT_EFFECT_IDS.hanabiBeatBursts]: { on: true, strength: 1.6 },
                [BEAT_EFFECT_IDS.hanabiBeatPulse]: { on: false, strength: 1 },
            },
        }
        const effects = [
            { id: BEAT_EFFECT_IDS.hanabiBeatBursts, label: '随拍开花', description: '', source: 'beats' as const },
            { id: BEAT_EFFECT_IDS.hanabiBeatPulse, label: '随拍推镜', description: '', source: 'beats' as const },
        ]
        const strengths = resolveBeatFxLiveStrengths(settings, effects)
        expect(strengths[BEAT_EFFECT_IDS.hanabiBeatBursts]).toBe(1.6)
        expect(strengths[BEAT_EFFECT_IDS.hanabiBeatPulse]).toBe(0)

        // 智能动感总开关关掉 → 全部为 0（画面回落到无节拍帧）
        const off = resolveBeatFxLiveStrengths({ ...settings, enabled: false }, effects)
        expect(off[BEAT_EFFECT_IDS.hanabiBeatBursts]).toBe(0)
        expect(off[BEAT_EFFECT_IDS.hanabiBeatPulse]).toBe(0)
    })
})
