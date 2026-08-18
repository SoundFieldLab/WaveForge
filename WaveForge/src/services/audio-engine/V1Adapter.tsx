/**
 * V1Adapter —— v1 音效引擎适配器（studioMode: 'custom'）
 *
 * 包住 audioEffects/AudioEffectsEngine 实例，实现 IAudioEngineAdapter。
 * v1 是远程原版引擎（5 效果互斥 + 老式调音室 UI），无系统音量/响度归一化能力。
 */

import { lazy } from 'react'
import { AudioEffectsEngine } from '../audioEffects/AudioEffectsEngine'
import type { AudioEngineVersion } from '../audioEngineVersion'
import type {
  IAudioEngineAdapter,
  AudioGraphHandle,
  EngineCapabilities,
  RenderStudioProps,
  IAudioEngineUiBridge,
} from './types'

const LazyMixingStudio = lazy(() => import('../../components/MixingStudio'))

export class V1Adapter implements IAudioEngineAdapter {
  private readonly engine: AudioEffectsEngine

  constructor() {
    this.engine = new AudioEffectsEngine()
  }

  readonly version: AudioEngineVersion = 'v1'
  readonly capabilities: EngineCapabilities = {
    supportsSystemVolume: false,
    supportsLoudnessNormalization: false,
    supportsLowVolumeHint: false,
  }
  readonly studioMode = 'custom' as const

  async attach(handle: AudioGraphHandle): Promise<void> {
    // v1 attach 是同步 void，包成 Promise 统一接口
    this.engine.attach(handle)
  }

  dispose(): void {
    this.engine.dispose()
  }

  isAttached(): boolean {
    // v1 引擎无 isAttached 方法，用 context 是否存在判断
    return (this.engine as unknown as { context: AudioContext | null }).context !== null
  }

  setSystemVolume(): void {
    // v1 无系统音量能力，no-op
  }

  applyLoudnessNormalization(): void {
    // v1 无响度归一化能力，no-op
  }

  resetLoudnessNormalization(): void {
    // v1 无响度归一化能力，no-op
  }

  async exportWav(sourceUrl: string, durationSeconds: number): Promise<void> {
    return this.engine.exportToWav(sourceUrl, durationSeconds)
  }

  renderStudio(props: RenderStudioProps): React.ReactNode {
    const { sourceUrl, sourceDuration, ...commonProps } = props
    return (
      <LazyMixingStudio
        engine={this.engine}
        sourceUrl={sourceUrl}
        sourceDuration={sourceDuration}
        {...commonProps}
      />
    )
  }

  getUiBridge(): IAudioEngineUiBridge | null {
    // custom 模式不需要通用 UI 桥
    return null
  }

  isExporting(): boolean {
    // v1 导出在调音室组件内部管理状态，adapter 不跟踪
    return false
  }
}
