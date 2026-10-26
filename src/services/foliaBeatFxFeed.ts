/**
 * Folia 智能动感（beat FX）的 WaveForge 侧数据源。
 *
 * 上游 folia 的节拍表来自随安装包分发的 beat_this 模型（GPU worker / CPU），经
 * `setBeatFxEvents` 安装进全局节拍时钟（vendor/folia/services/beatFx/beatFxLive）。
 * WaveForge 的拍点来自本地 beat-this Python 服务（autoMixAnalysisService，与自动
 * 混音共用一份分析缓存——同一首歌不二次解码），这里把它归一成 BeatFxEvent 表：
 *   - beats/downbeats 直接用 TrackAnalysis 的两列时间；
 *   - impact 由 beatFeatures[].energy 按全曲范围归一（folia 的 accents.impact 同义）；
 *   - 每拍 rhythmic/pulse = 1（我们不做无节奏小节判定）、tone 三频段均分（当前没有
 *     逐拍频段数据，beatFx 的增益只看 impact，tone 仅是占位）。
 *
 * 宿主（FoliaLyricsPage）只管三件事：曲目变化时 `beginBeatFxTrack` + 异步
 * `ensureAnalysis` + `setBeatFxEvents`；活跃期间一个 rAF 调 `tickBeatFxStore` 步进。
 */
import {
    beginBeatFxTrack,
    setBeatFxEvents,
    setBeatFxIntensities,
    setBeatFxLiveEffects,
    stopBeatFx,
    tickBeatFxStore,
} from '../vendor/folia/services/beatFx/beatFxLive'
import { mergeBeatFxEvents, type BeatFxEvent } from '../vendor/folia/services/beatFx/clock'
import { resolveBeatEffectSetting, type BeatEffectDef } from '../vendor/folia/services/beatFx/beatEffects'
import type { TrackAnalysis } from '../audio/types'
import { autoMixAnalysisService } from './autoMixAnalysisService'
import type { SmartBeatSettings } from '../vendor/folia/components/visualizer/smartBeatSettings'

export interface BeatFxTrackInput {
    /** 稳定曲目键（getSongKey），节拍时钟用它丢弃跨曲迟到的分析结果 */
    key: string
    /** 可被 Python 服务抓取的音频地址（与自动混音 analyze 同源） */
    url: string
    /** 秒 */
    duration: number
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

/** TrackAnalysis → 每拍事件表（含 impact accents）。 */
export function buildBeatFxEvents(analysis: TrackAnalysis): BeatFxEvent[] {
    const energies = analysis.beatFeatures?.length
        ? analysis.beats.map((_, index) => {
            const feature = analysis.beatFeatures[index]
            return feature && Number.isFinite(feature.energy) ? feature.energy : 0
        })
        : analysis.beats.map(() => 0.5)
    const finite = energies.filter(value => Number.isFinite(value))
    const lo = finite.length ? Math.min(...finite) : 0
    const hi = finite.length ? Math.max(...finite) : 1
    const span = Math.max(0.05, hi - lo)
    const accents = {
        v: 1,
        impact: energies.map(value => clamp01((value - lo) / span)),
        low: energies.map(() => 1 / 3),
        mid: energies.map(() => 1 / 3),
        high: energies.map(() => 1 / 3),
        rhythmic: energies.map(() => 1),
        pulse: energies.map(() => 1),
        trackScale: 1,
    }
    return mergeBeatFxEvents(analysis.beats, analysis.downbeats, accents)
}

/** 把效果设置换算成 live strength 表（off 的效果为 0）。 */
export function resolveBeatFxLiveStrengths(
    settings: SmartBeatSettings,
    effects: readonly BeatEffectDef[],
): Record<string, number> {
    const strengths: Record<string, number> = {}
    for (const effect of effects) {
        const setting = resolveBeatEffectSetting(settings, effect.id)
        strengths[effect.id] = settings.enabled && setting.on ? setting.strength : 0
    }
    return strengths
}

export interface FoliaBeatFxFeedHandle {
    /** 曲目切换：换 key、重装事件表（异步分析）。 */
    syncTrack(track: BeatFxTrackInput | null, settings: SmartBeatSettings, effects: readonly BeatEffectDef[]): void
    /** 每帧步进（宿主 rAF；isPlaying=false 时传 null 让包络自然衰减）。 */
    tick(currentTime: number | null): void
    /** 设置变化：重算 live strengths 与轻拍/重拍强度。 */
    syncSettings(settings: SmartBeatSettings, effects: readonly BeatEffectDef[]): void
    /** 卸载：停时钟、清包络。 */
    dispose(): void
}

export function createFoliaBeatFxFeed(): FoliaBeatFxFeedHandle {
    let trackKey: string | null = null
    let generation = 0

    return {
        syncTrack(track, settings, effects) {
            this.syncSettings(settings, effects)
            if (!track?.key || !track.url) {
                generation += 1
                trackKey = null
                stopBeatFx()
                return
            }
            if (track.key === trackKey) return
            trackKey = track.key
            const currentGeneration = ++generation
            // 换曲即持 ready（beatFxLive 的 READY_HOLD_MS 会保住上一曲的帧一小会儿），
            // 分析回来再安装事件表；内存缓存命中时是同步级延迟。
            beginBeatFxTrack(track.key)
            void autoMixAnalysisService
                .analyze({ trackKey: track.key, url: track.url, duration: track.duration })
                .then(analysis => {
                    if (generation !== currentGeneration || trackKey !== track.key) return
                    if (!analysis || !Array.isArray(analysis.beats) || analysis.beats.length < 2) return
                    setBeatFxEvents(track.key, buildBeatFxEvents(analysis), 'beat-this-cpu', 'waveforge beat-this (python)', 1)
                })
                .catch(() => {
                    // 分析失败：时钟保持空表 → isBeatFxReady() 为 false，画面回落到无节拍帧
                })
        },
        tick(currentTime) {
            tickBeatFxStore(currentTime)
        },
        syncSettings(settings, effects) {
            setBeatFxLiveEffects(resolveBeatFxLiveStrengths(settings, effects))
            setBeatFxIntensities(1, 1)
        },
        dispose() {
            generation += 1
            trackKey = null
            stopBeatFx()
        },
    }
}
