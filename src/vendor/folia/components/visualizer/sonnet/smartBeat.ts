// src/vendor/folia/components/visualizer/sonnet/smartBeat.ts
// 智能动感模式（Smart Beat）：商籁（sonnet）的节拍驱动动效。移植自 folia 0.7.21。
//
// folia 的拍点来自离线鼓点分离模型；WaveForge 的拍点来自 AudioAnalyzerStore 的实时
// onset 脉冲（snapshot.beat ≈ 每拍、snapshot.accent ≈ 强拍/小节首拍）——零等待、
// 无模型下载，听感与"每拍推近镜头、小节第一拍裂光"一致。
//
// 效果与默认参数对齐 folia 的 X 常量表：
//   zoomPercent: 6        每拍镜头推近 6%（随 beat 脉冲衰减）
//   rotationDeg: 0.6      每拍轻微旋转
//   downbeatZoomPercent:5 强拍（小节首拍）额外 5% 推近
//   tear: 0.6             裂光强度（随 accent）
//   flare: 0.7            亮斑
//   iconPop: 0.4          图标弹跳
//   iconDecayMs: 300      弹跳衰减时长
//
// 每个效果可单独开关、调强度（smartBeatSettings.ts 的 effects 表，strength 0..2）。

export interface SmartBeatEffectFrame {
    /** 每拍镜头推近（0..1，随 beat 脉冲包络） */
    zoom: number;
    /** 强拍额外推近（0..1） */
    downbeatZoom: number;
    /** 每拍旋转（-1..1 归一化因子，乘 rotationDeg） */
    rotation: number;
    /** 裂光/撕裂强度（0..1，强拍触发后 150ms 内衰减） */
    tear: number;
    /** 亮斑强度（0..1） */
    flare: number;
    /** 图标弹跳（0..1） */
    iconPop: number;
}

export const SMART_BEAT_EFFECT_IDS = {
    beatZoom: 'sonnet.beatZoom',
    downbeatZoom: 'sonnet.downbeatZoom',
    beatRotation: 'sonnet.beatRotation',
    tear: 'sonnet.tear',
    flare: 'sonnet.flare',
    iconPop: 'sonnet.iconPop',
} as const;

/** folia 的 X 常量表 */
const BEAT = {
    zoomPercent: 6,
    rotationDeg: 0.6,
    downbeatZoomPercent: 5,
    tear: 0.6,
    tearDecayMs: 150,
    flare: 0.7,
    iconPop: 0.4,
    iconDecayMs: 300,
};

export type SmartBeatEffectToggles = Record<string, { on: boolean; strength: number } | undefined>;

/** 单效果是否启用（设置表缺项默认开、强度 1） */
const isEffectOn = (toggles: SmartBeatEffectToggles, id: string): { on: boolean; strength: number } => {
    const entry = toggles[id];
    if (!entry) return { on: true, strength: 1 };
    return { on: entry.on !== false, strength: Number.isFinite(entry.strength) ? entry.strength : 1 };
};

/**
 * 拍脉冲状态机：消费 AudioAnalyzerStore 的实时快照（beat 0..1 衰减脉冲、accent 强拍
 * 标记、bass onset），换算成 SmartBeatEffectFrame。renderFrame 每帧调用。
 */
export class SmartBeatPulse {
    private lastBeatAt = 0;
    private lastDownbeatAt = 0;
    private lastTearAt = 0;
    private lastIconAt = 0;
    /** 拍间周期估计（ms）：用于把"距上一拍的时间"归一化为 0..1 的相位衰减 */
    private beatPeriodMs = 500;

    /** 每帧喂入当前音频快照与时间；返回本帧的效果帧 */
    update(
        now: number,
        snapshot: { beat: number; accent: number; bass: number },
        toggles: SmartBeatEffectToggles,
    ): SmartBeatEffectFrame {
        const empty: SmartBeatEffectFrame = { zoom: 0, downbeatZoom: 0, rotation: 0, tear: 0, flare: 0, iconPop: 0 };
        const beat = Math.min(1, Math.max(0, snapshot.beat));
        const accent = Math.min(1, Math.max(0, snapshot.accent));

        // 拍检测：beat 脉冲从基线（<0.08）跃起视为新一拍；accent 高于 beat 视为强拍。
        const beatOnset = beat > 0.15 && beat >= this.lastBeatLevel + 0.12 && now - this.lastBeatAt > 180;
        const downbeatOnset = beatOnset && accent > 0.45 && now - this.lastDownbeatAt > 500;
        this.lastBeatLevel = beat;

        if (beatOnset) {
            if (this.lastBeatAt > 0) {
                const period = now - this.lastBeatAt;
                // 周期估计限 240..1500ms（40..250 BPM），EMA 平滑
                if (period >= 240 && period <= 1500) this.beatPeriodMs = this.beatPeriodMs * 0.7 + period * 0.3;
            }
            this.lastBeatAt = now;
            // 强拍触发裂光（teal 效果开时）
            const tearOn = isEffectOn(toggles, SMART_BEAT_EFFECT_IDS.tear);
            if (downbeatOnset && tearOn.on) {
                this.lastTearAt = now;
            }
            const iconOn = isEffectOn(toggles, SMART_BEAT_EFFECT_IDS.iconPop);
            if (iconOn.on) this.lastIconAt = now;
        }
        if (downbeatOnset) this.lastDownbeatAt = now;

        if (beat <= 0.001 && now - this.lastBeatAt > this.beatPeriodMs * 2) {
            // 音乐停了/无节拍：整个效果归零，避免静态画面残留形变
            return empty;
        }

        // 距上一拍的相位（0..1，1 = 刚击拍）：用估计周期归一化，比固定衰减更贴节奏
        const sinceBeat = now - this.lastBeatAt;
        const beatPhase = Math.max(0, 1 - sinceBeat / Math.max(200, this.beatPeriodMs));
        // 脉冲包络：击拍瞬间最强，快速衰减（folia 的 iconDecay 同款手感）
        const pulse = beatPhase * beatPhase * Math.min(1, beat * 1.6);

        const zoomOn = isEffectOn(toggles, SMART_BEAT_EFFECT_IDS.beatZoom);
        const downOn = isEffectOn(toggles, SMART_BEAT_EFFECT_IDS.downbeatZoom);
        const rotOn = isEffectOn(toggles, SMART_BEAT_EFFECT_IDS.beatRotation);
        const flareOn = isEffectOn(toggles, SMART_BEAT_EFFECT_IDS.flare);

        const sinceDown = now - this.lastDownbeatAt;
        const downPhase = Math.max(0, 1 - sinceDown / Math.max(240, this.beatPeriodMs * 2));
        const downPulse = downPhase * downPhase;

        const tearAge = now - this.lastTearAt;
        const tearPulse = tearAge >= 0 && tearAge < BEAT.tearDecayMs
            ? (1 - tearAge / BEAT.tearDecayMs)
            : 0;

        const iconAge = now - this.lastIconAt;
        const iconPulse = iconAge >= 0 && iconAge < BEAT.iconDecayMs
            ? (1 - iconAge / BEAT.iconDecayMs) ** 2
            : 0;

        return {
            zoom: zoomOn.on ? pulse * zoomOn.strength : 0,
            downbeatZoom: downOn.on ? downPulse * downOn.strength : 0,
            rotation: rotOn.on ? pulse * rotOn.strength : 0,
            tear: tearPulse * isEffectOn(toggles, SMART_BEAT_EFFECT_IDS.tear).strength,
            flare: flareOn.on ? pulse * BEAT.flare * flareOn.strength : 0,
            iconPop: iconPulse * isEffectOn(toggles, SMART_BEAT_EFFECT_IDS.iconPop).strength,
        };
    }

    private lastBeatLevel = 0;

    /** 音乐暂停/切歌时复位全部状态 */
    reset(): void {
        this.lastBeatAt = 0;
        this.lastDownbeatAt = 0;
        this.lastTearAt = 0;
        this.lastIconAt = 0;
        this.lastBeatLevel = 0;
        this.beatPeriodMs = 500;
    }
}

/** 把效果帧换算成相机增量（对齐 folia Qe 函数的相机合成） */
export function applySmartBeatToCamera(
    frame: SmartBeatEffectFrame,
    result: { scale: number; rotation: number },
): void {
    if (frame.zoom <= 0 && frame.downbeatZoom <= 0 && frame.rotation === 0) return;
    result.scale *= 1 + (BEAT.zoomPercent / 100) * frame.zoom + (BEAT.downbeatZoomPercent / 100) * frame.downbeatZoom;
    result.rotation += (BEAT.rotationDeg * Math.PI / 180) * frame.rotation;
}

/** 裂光是否激活（tear > 0.02 时渲染层开启撕裂滤镜，folia 同阈值） */
export const smartBeatTearActive = (frame: SmartBeatEffectFrame) => frame.tear > 0.02;
