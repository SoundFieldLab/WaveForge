import React from 'react';
import { defineVisualizer } from '../definition';
import HanabiSettingsPanel from './HanabiSettingsPanel';
import { DEFAULT_HANABI_TUNING } from './types';

// 16k 行的 Pixi 包按上游一样懒加载：registry 的 Suspense 边界已就位。
const VisualizerHanabi = React.lazy(() => import('./VisualizerHanabi'));

// WaveForge 移植（上游 src/components/visualizer/hanabi/entry.tsx，v0.7.22）：
// 注册花火——日式歌词 PV：色块字逐字出场、烟花与装饰件沿字开花、镜头间整个世界
// 持续上升旋转，副歌全屏辉光。上游 entry 的 glyph/command/beatEffects/quickControls
// 是 folia 外壳（命令面板/模组）的字段，WaveForge 的 registry 不消费，裁掉；
// tuning 经同目录 tuning.ts 的适配器注入 hanabiTuning prop，渲染器不再读 bundle。
export default defineVisualizer({
    mode: 'hanabi',
    order: 26,
    labelKey: 'ui.visualizerHanabi',
    labelFallback: '花火',
    previewSeed: 'hanabi',
    previewStartOffset: 0,
    tuningKind: 'hanabi',
    // 花火的文字排版按整词分词断行（text/layout → wordSegmentation），用户保存的分词会改变画面。
    usesWordSegmentation: true,
    // Deliberately unkeyed on the seed, like lumiere: the runtime hands a track change over in
    // place (songHandover.ts / pixiRuntimeHost.ts) instead of throwing the WebGL context away.
    // adapter 必注入 hanabiTuning；兜底默认值仅为类型闭合（面板/切样式竞态帧）。
    render: props => <VisualizerHanabi {...props} hanabiTuning={props.hanabiTuning ?? DEFAULT_HANABI_TUNING} />,
    renderSettingsPanel: props => <HanabiSettingsPanel {...props} />,
});
