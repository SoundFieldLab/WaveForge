/**
 * Gapless 切换的 60ms 等功率淡入淡出
 * 从 useAudioPlayer.ts 的 startTransition gapless 分支抽出：
 * standby 先 0 增益启动，切换瞬间对双 deck 做极短等功率交叉（消除数字硬切爆音），
 * Web Audio 增益图不可用时回退元素 volume 动画。
 */

import { GAPLESS_DECK_FADE_MS } from './gaplessConstants'

export interface GaplessDeckFadeDeps {
  context: AudioContext | null
  sourceGain: GainNode | null
  targetGain: GainNode | null
  source: HTMLAudioElement
  target: HTMLAudioElement
  /** 执行版本校验：过期（被新过渡取代）时跳过收尾 */
  isCurrentRevision: () => boolean
  equalPowerCurve: (fadeIn: boolean) => Float32Array
  /** Web Audio 不可用时的元素 volume 等功率动画 */
  runFallbackFade: (source: HTMLAudioElement, target: HTMLAudioElement, duration: number, onDone: () => void) => void
}

/** 执行 60ms 双 deck 淡入淡出；完成后停掉 source（原曲已完整播完） */
export function runGaplessDeckFade(deps: GaplessDeckFadeDeps): void {
  const { context, sourceGain, targetGain, source, target, isCurrentRevision, equalPowerCurve, runFallbackFade } = deps
  const fadeDone = () => {
    if (!isCurrentRevision()) return
    source.pause()
    source.currentTime = 0
  }

  if (context && sourceGain && targetGain) {
    const now = context.currentTime
    sourceGain.gain.cancelScheduledValues(now)
    targetGain.gain.cancelScheduledValues(now)
    sourceGain.gain.setValueAtTime(Math.max(0.0001, sourceGain.gain.value), now)
    targetGain.gain.setValueAtTime(Math.max(0.0001, targetGain.gain.value), now)
    sourceGain.gain.setValueCurveAtTime(equalPowerCurve(false), now, GAPLESS_DECK_FADE_MS / 1000)
    targetGain.gain.setValueCurveAtTime(equalPowerCurve(true), now, GAPLESS_DECK_FADE_MS / 1000)
    window.setTimeout(fadeDone, GAPLESS_DECK_FADE_MS)
  } else {
    // Web Audio 增益图不可用时，用元素 volume 做同样的等功率短淡入淡出
    runFallbackFade(source, target, GAPLESS_DECK_FADE_MS / 1000, fadeDone)
  }
}
