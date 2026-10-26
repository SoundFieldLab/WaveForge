import { defineVisualizerTuning } from '../tuningRegistry';
import { normalizeHanabiTuning } from './hanabiTuning';
import { DEFAULT_HANABI_TUNING } from './types';

// WaveForge 移植：上游 hanabi/tuning.ts 用 folia 0.7.22 的 tuningDefinition（自带
// localStorage 存储 + store action 生成）。WaveForge 的调参走 foliaTunings.ts 的
// per-mode bundle（visualizerTunings 注入），这里按 WaveForge 适配器形状注册：
// apply 把归一化后的 tuning 挂到渲染 props 的 hanabiTuning 上（面板经
// onHanabiTuningChange 改，App 落盘 bundle）。
export default defineVisualizerTuning({
    mode: 'hanabi',
    settingsKey: 'hanabiTuning',
    settingsSetterKey: 'handleSetHanabiTuning',
    apply: (props, tuning) => ({ ...props, hanabiTuning: normalizeHanabiTuning({ ...DEFAULT_HANABI_TUNING, ...(tuning as object) }) }),
});
