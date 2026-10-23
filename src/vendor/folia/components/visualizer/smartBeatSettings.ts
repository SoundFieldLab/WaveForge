// src/vendor/folia/components/visualizer/smartBeatSettings.ts
// 智能动感模式（Smart Beat）设置存储：对齐 folia 0.7.21 的
// `visualizer_smart_beat` localStorage 形状（{ enabled, effects: {<id>: {on, strength}} }）。
//
// WaveForge 差异：folia 的拍点来自离线鼓点分离模型（随安装器分发）；我们的拍点
// 来自 AudioAnalyzerStore 的实时 onset 脉冲（beat/accent 字段），零等待且无模型
// 下载。效果参数常量表（X）与 strength 钳制（0..2，默认 1）与 folia 一致。

export interface SmartBeatEffectSetting {
    on: boolean;
    strength: number;
}

export interface SmartBeatSettings {
    enabled: boolean;
    effects: Record<string, SmartBeatEffectSetting>;
}

export const SMART_BEAT_STORAGE_KEY = 'visualizer_smart_beat';

/** 效果上限（folia 同款）：防止脏数据无限膨胀 */
const MAX_EFFECTS = 64;
/** effectId 白名单形状：<32位串>.<32位串> */
const EFFECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{1,32}$/;

const clampStrength = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.min(2, Math.max(0, value))
        : fallback;

/**
 * 读取并归一化设置。兼容 folia 的旧格式（顶层 beatIntensity/downbeatIntensity
 * 均值展开到每个 effect 的 strength）；无效输入回 defaults。
 */
export function normalizeSmartBeatSettings(raw: unknown, defaults: SmartBeatSettings): SmartBeatSettings {
    if (!raw || typeof raw !== 'object') return { ...defaults, effects: { ...defaults.effects } };
    const input = raw as Record<string, unknown>;
    const effects: Record<string, SmartBeatEffectSetting> = { ...defaults.effects };

    // 旧格式：顶层均值展开
    const legacy = [input.beatIntensity, input.downbeatIntensity].filter(
        v => typeof v === 'number' && Number.isFinite(v),
    ) as number[];
    if (legacy.length > 0 && !input.effects) {
        const mean = legacy.reduce((a, b) => a + b, 0) / legacy.length;
        const strength = clampStrength(mean, 1);
        for (const key of Object.keys(effects)) {
            effects[key] = { on: effects[key]?.on ?? true, strength };
        }
    }

    // 新格式：逐 effect 覆盖
    if (input.effects && typeof input.effects === 'object') {
        for (const [id, value] of Object.entries(input.effects as Record<string, unknown>)) {
            if (!EFFECT_ID_PATTERN.test(id) || !value || typeof value !== 'object') continue;
            if (!(id in effects) && Object.keys(effects).length >= MAX_EFFECTS) continue;
            const v = value as Record<string, unknown>;
            const current = effects[id] ?? { on: true, strength: 1 };
            effects[id] = {
                on: typeof v.on === 'boolean' ? v.on : current.on,
                strength: clampStrength(v.strength, current.strength),
            };
        }
    }

    return {
        enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
        effects,
    };
}

export function readSmartBeatSettings(defaults: SmartBeatSettings): SmartBeatSettings {
    try {
        const raw = localStorage.getItem(SMART_BEAT_STORAGE_KEY);
        if (!raw) return { ...defaults, effects: { ...defaults.effects } };
        return normalizeSmartBeatSettings(JSON.parse(raw), defaults);
    } catch {
        return { ...defaults, effects: { ...defaults.effects } };
    }
}

export function writeSmartBeatSettings(settings: SmartBeatSettings): void {
    try {
        localStorage.setItem(SMART_BEAT_STORAGE_KEY, JSON.stringify(settings));
    } catch { /* 存储不可用时仅本次运行有效 */ }
}

/** 派发到 window 的事件：设置面板改动后通知挂载中的 runtime（无需 React 重挂载） */
export const SMART_BEAT_SETTINGS_EVENT = 'waveforge-smart-beat-changed';

export function notifySmartBeatChanged(): void {
    try { window.dispatchEvent(new CustomEvent(SMART_BEAT_SETTINGS_EVENT)); } catch { /* ignore */ }
}
