// WaveForge 移植占位：folia 的 BeatAccents 由 beat_this 的 mel 频谱算出
// （上游 analysis/beatAccents.ts，705 行，依赖 GPU 分析栈 beatThis/beatThisGpu）。
// WaveForge 的拍点来自本地 beat-this Python 服务的 TrackAnalysis（beats/downbeats/
// beatFeatures[].energy），accents 由 foliaBeatFxFeed 现算成这里的形状。

/** 每拍的听感重音（对齐上游 BeatAccents 的形状，供 beatFx/clock.ts 使用）。 */
export interface BeatAccents {
    v: number;
    /** One entry per beat of the grid, in the grid's order. */
    impact: number[];
    low: number[];
    mid: number[];
    high: number[];
    /** 1 when the beat's bar has rhythm, 0 when it is sustained sound only (no beat FX there). */
    rhythmic: number[];
    /** 1 when the beat is a felt beat, 0 for one the model counted between them (see above). */
    pulse: number[];
    trackScale: number;
}
