// Copyright (c) 2026 chthollyphile
// WaveForge 移植（上游 src/components/visualizer/hanabi/HanabiSettingsPanel.tsx）：
// 花火的参数面板——烟花、画面、文字、装饰、配色、性能六组。
// 上游面板用 folia 设置套件（modal/settings/kit 的 Group/Row/Segmented + panelRows 的
// SliderRow/ToggleRow）；WaveForge 没有那套外壳，按 SonnetSettingsPanel 的规格用
// 面板 props（controlCardBg / rangeInputClass）+ 内联控件实现，滑块保持上游
// 「草稿 / 松手提交」语义（onSliderPointerDown / onSliderCommit）。
import React from 'react';
import type { HanabiTuning } from '../../../types';
import type { VisualizerSettingsPanelProps } from '../definition';
import { DEFAULT_HANABI_TUNING } from './types';

type NumberKey = { [K in keyof HanabiTuning]: HanabiTuning[K] extends number ? K : never }[keyof HanabiTuning];
type BooleanKey = { [K in keyof HanabiTuning]: HanabiTuning[K] extends boolean ? K : never }[keyof HanabiTuning];

interface SliderSpec { kind: 'slider'; key: NumberKey; label: string; note?: string; min: number; max: number; step?: number; }
interface ToggleSpec { kind: 'toggle'; key: BooleanKey; label: string; note?: string; }
type ControlSpec = SliderSpec | ToggleSpec;

const slider = (key: NumberKey, label: string, min: number, max: number, extra: Partial<SliderSpec> = {}): SliderSpec => (
    { kind: 'slider', key, label, min, max, ...extra }
);
const toggle = (key: BooleanKey, label: string, note?: string): ToggleSpec => ({ kind: 'toggle', key, label, note });

const FIREWORKS_CONTROLS: ControlSpec[] = [
    slider('sparkAmount', '烟花', 0, 2),
    slider('glow', '烟花辉光', 0, 2),
    slider('chorusBloom', '副歌辉光', 0, 2, { note: '副歌时整个画面亮起一层辉光，副歌开始时慢慢亮起、结束时收回。副歌按歌词判断：歌词自带的标记，或按重复的歌词识别。' }),
    slider('bloom', '整体辉光', 0, 2, { note: '整首歌常驻的全屏辉光，叠在副歌辉光下面。0 时只有副歌亮。' }),
    toggle('launches', '升空尾迹', '每发烟花先从画面底边升空再开花，把一个镜头接到下一个镜头。'),
];

const STAGE_CONTROLS: ControlSpec[] = [
    slider('sky', '夜空', 0, 1, { step: 0.01, note: '烟花底下的一层夜空渐变。调低会透出共享背景；低于一半时配色按主题背景色取。' }),
    slider('riseSpeed', '上升', 0, 2, { note: '镜头之间摄影机往上走多远。0 时每个镜头原地切换。' }),
    slider('spin', '旋转', 0, 2, { note: '镜头之间整个画面随上升一起大角度转过去，段落转场也带着转。0 时不转。' }),
    slider('ambient', '环境火星', 0, 2),
    toggle('overlayFrame', '画框'),
];

const TEXT_CONTROLS: ControlSpec[] = [
    toggle('textOnly', '仅显示歌词文字', '只画歌词和它的字底色块、逐字动画；烟花、贴纸、夜空和画框都不画。'),
    slider('textMotion', '文字动作', 0, 2),
    slider('blockOpacity', '字底色块', 0, 1, { step: 0.01 }),
];

const DECOR_CONTROLS: ControlSpec[] = [
    slider('collage', 'PV 拼贴', 0, 2, { note: '歌词周围的电影胶片、剪切线、蕾丝花边、重复字、贴纸、胶带和主题图标。' }),
    slider('ornamentAmount', 'MG 装饰件', 0, 2),
];

const formatPlain = (value: number) => value.toFixed(2);

const HanabiSettingsPanel: React.FC<VisualizerSettingsPanelProps> = ({
    hanabiTuning = DEFAULT_HANABI_TUNING,
    onHanabiTuningChange,
    onSliderPointerDown,
    onSliderCommit,
    controlCardBg,
    rangeInputClass,
}) => {
    const renderControl = (spec: ControlSpec) => (spec.kind === 'slider' ? (
        <div key={spec.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{spec.label}</span>
                <span className="text-[10px] tabular-nums opacity-45" style={{ color: 'var(--text-secondary)' }}>
                    {formatPlain(hanabiTuning[spec.key])}
                </span>
            </div>
            <input
                type="range"
                className={rangeInputClass}
                min={spec.min}
                max={spec.max}
                step={spec.step ?? 0.05}
                value={hanabiTuning[spec.key]}
                onPointerDown={onSliderPointerDown}
                onPointerUp={onSliderCommit}
                onChange={event => onHanabiTuningChange?.({ [spec.key]: Number(event.target.value) })}
            />
            {spec.note ? (
                <p className="text-[10px] leading-relaxed opacity-40" style={{ color: 'var(--text-secondary)' }}>{spec.note}</p>
            ) : null}
        </div>
    ) : (
        <div key={spec.key} className="flex items-center justify-between gap-3 py-0.5">
            <span className="min-w-0">
                <span className="block text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{spec.label}</span>
                {spec.note ? (
                    <span className="mt-0.5 block text-[10px] leading-relaxed opacity-40" style={{ color: 'var(--text-secondary)' }}>{spec.note}</span>
                ) : null}
            </span>
            <button
                type="button"
                role="switch"
                aria-checked={hanabiTuning[spec.key]}
                onClick={() => onHanabiTuningChange?.({ [spec.key]: !hanabiTuning[spec.key] })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${hanabiTuning[spec.key] ? 'bg-[var(--folia-accent,#7aa2ff)]' : 'bg-white/15'}`}
            >
                <span
                    className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform"
                    style={{ transform: hanabiTuning[spec.key] ? 'translateX(18px)' : 'translateX(2px)' }}
                />
            </button>
        </div>
    ));

    const section = (title: string, controls: ControlSpec[]) => (
        <div className="rounded-2xl border border-white/10 p-3" style={{ backgroundColor: controlCardBg }}>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide opacity-55" style={{ color: 'var(--text-secondary)' }}>{title}</div>
            <div className="space-y-2.5">{controls.map(renderControl)}</div>
        </div>
    );

    return (
        <div className="space-y-3">
            {section('烟花', FIREWORKS_CONTROLS)}
            {section('画面', STAGE_CONTROLS)}
            {section('文字', TEXT_CONTROLS)}
            {section('装饰', DECOR_CONTROLS)}
            <div className="rounded-2xl border border-white/10 p-3" style={{ backgroundColor: controlCardBg }}>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide opacity-55" style={{ color: 'var(--text-secondary)' }}>配色</div>
                <div className="grid grid-cols-3 gap-1.5">
                    {([['mixed', '混合'], ['vivid', '鲜艳'], ['theme', '主题']] as Array<[HanabiTuning['colorMode'], string]>).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => onHanabiTuningChange?.({ colorMode: value })}
                            className={`rounded-lg border px-2 py-1.5 text-[11px] transition-colors ${hanabiTuning.colorMode === value ? 'border-[var(--folia-accent,#7aa2ff)] bg-[var(--folia-accent,#7aa2ff)]/15' : 'border-white/10 hover:bg-white/[0.06]'}`}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed opacity-40" style={{ color: 'var(--text-secondary)' }}>
                    混合会把每个镜头的鲜艳配色往主题强调色偏。
                </p>
            </div>
            <div className="rounded-2xl border border-white/10 p-3" style={{ backgroundColor: controlCardBg }}>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide opacity-55" style={{ color: 'var(--text-secondary)' }}>性能</div>
                <div className="grid grid-cols-3 gap-1.5">
                    {([['full', '全分辨率'], ['balanced', '均衡'], ['low', '省电']] as Array<[HanabiTuning['renderQuality'], string]>).map(([value, label]) => (
                        <button
                            key={value}
                            type="button"
                            onClick={() => onHanabiTuningChange?.({ renderQuality: value })}
                            className={`rounded-lg border px-2 py-1.5 text-[11px] transition-colors ${hanabiTuning.renderQuality === value ? 'border-[var(--folia-accent,#7aa2ff)] bg-[var(--folia-accent,#7aa2ff)]/15' : 'border-white/10 hover:bg-white/[0.06]'}`}
                            style={{ color: 'var(--text-primary)' }}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed opacity-40" style={{ color: 'var(--text-secondary)' }}>
                    均衡 / 省电会降低烟花辉光的分辨率，省电还会少画一些环境火星；歌词和全屏辉光仍是全分辨率。集成显卡上卡顿时可以试试。
                </p>
            </div>
        </div>
    );
};

export default HanabiSettingsPanel;
