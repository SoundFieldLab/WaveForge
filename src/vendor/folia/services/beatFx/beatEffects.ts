// WaveForge 移植（对齐上游 services/beatFx/beatEffects.ts）：
// 智能动感模式的节拍效果登记表——每个效果是一个"画面跟着音乐做的事"，由可视化器
// entry 声明（beatEffects），设置面板逐个开关/调强度，运行时经 getBeatEffectStrength 读强度。
//
// 与上游的差异：上游的设置类型在 src/types 的 zustand store 里（SmartBeatSettings 带
// mode: 'off' | 'cached' | 'on'）；WaveForge 的设置在 visualizer/smartBeatSettings.ts
// （{ enabled, effects }，0.7.21 形状），这里直接对齐 WaveForge 的形状。

export type BeatEffectSource = 'beats' | 'drums';

export interface BeatEffectDef {
    /** Stable, stored in settings and exported configs: `<mode>.<name>`. */
    id: string;
    /** 面板显示名（WaveForge 直接给中文，无 i18n 键）。 */
    label: string;
    /** 一句话说明它做什么。 */
    description: string;
    source: BeatEffectSource;
}

/** The strength range of every effect; 1 is the look it was tuned to, the middle of the slider. */
export const BEAT_EFFECT_STRENGTH_MAX = 2;
export const BEAT_EFFECT_DEFAULT: SmartBeatEffectSettingShape = { on: true, strength: 1 };

export interface SmartBeatEffectSettingShape {
    on: boolean;
    strength: number;
}

/** Every effect id in the app, so code that plays one names it rather than spelling it. */
export const BEAT_EFFECT_IDS = {
    sonnetLensTear: 'sonnet.lensTear',
    dioramaRipple: 'diorama.ripple',
    pendoloDrumhead: 'pendolo.drumhead',
    latentPulse: 'latent.pulse',
    hanabiBeatBursts: 'hanabi.beatBursts',
    hanabiBeatPulse: 'hanabi.beatPulse',
} as const;

/** The effect's setting, or the default for one never touched. */
export const resolveBeatEffectSetting = (
    settings: { enabled: boolean; effects: Record<string, SmartBeatEffectSettingShape> },
    id: string,
): SmartBeatEffectSettingShape => settings.effects[id] ?? BEAT_EFFECT_DEFAULT;

/** Whether the effects play at all: 智能动感模式 on. */
export const smartBeatActive = (settings: { enabled: boolean }): boolean => settings.enabled;

/** Whether the effect plays: 智能动感模式 active and the effect switched on itself. */
export const isBeatEffectLive = (
    settings: { enabled: boolean; effects: Record<string, SmartBeatEffectSettingShape> },
    effect: Pick<BeatEffectDef, 'id'>,
): boolean => smartBeatActive(settings) && resolveBeatEffectSetting(settings, effect.id).on;
