import { motionValue } from 'framer-motion';

// WaveForge 移植（上游 src/stores/motionSignals.ts 的节拍信号切片）：
// 上游这个文件还持有 currentTime / lyricCurrentTime / 音频频段等全屏信号；
// WaveForge 的播放时间走 FoliaLyricsPage 自己的 MotionValue（folia 移植时就定了的边界），
// 这里只补节拍 FX 需要的两个包络（beatFxLive.ts 写、可视化器 rAF 读）。
//
// 这些值每帧变化，绝不能进 React state——MotionValue 的 .get() 在任意 rAF 里读都零开销。

/** 每拍包络（0..1，步进时乘以轻拍强度）。 */
export const beatImpact = motionValue(0);
/** 小节首拍包络（0..1，步进时乘以重拍强度）。 */
export const downbeatImpact = motionValue(0);
