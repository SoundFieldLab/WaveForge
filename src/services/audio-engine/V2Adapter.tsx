/**
 * V2Adapter —— v2 音效引擎适配器（studioMode: 'custom'）
 *
 * 包住 audio-effects-v2/AudioEffectsEngine 实例 + loudnessNormalizationService。
 * v2 是本地增强版（可叠加效果 + 场景方案 + 频响补偿 + 响度归一化）。
 * 响度归一化的外部服务调用从 App.tsx 剥离到此（apply/reset 转发 service）。
 * 低音量提示 toast 从 App.tsx 的系统音量 effect 剥离到此（setSystemVolume 内触发）。
 */

import { lazy } from 'react'
import {
  AudioEffectsEngine,
  LOUDNESS_COMPENSATION_THRESHOLD,
} from '../audio-effects-v2/AudioEffectsEngine'
import { loudnessNormalizationService } from '../audio-effects-v2/loudnessNormalization'
import type { AudioEngineVersion } from '../audioEngineVersion'
import type {
  IAudioEngineAdapter,
  AudioGraphHandle,
  EngineCapabilities,
  RenderStudioProps,
  IAudioEngineUiBridge,
  EngineAdapterOptions,
} from './types'

const LazyMixingStudioV2 = lazy(() => import('../../components/MixingStudioV2'))

export class V2Adapter implements IAudioEngineAdapter {
  private readonly engine: AudioEffectsEngine
  private readonly onLowVolumeHint?: (message: string) => void
  private hinted = false // 低音量一次性提示（localStorage 防重复，与原 App effect 一致）

  constructor(opts?: EngineAdapterOptions) {
    this.engine = new AudioEffectsEngine()
    this.onLowVolumeHint = opts?.onLowVolumeHint
  }

  readonly version: AudioEngineVersion = 'v2'
  readonly capabilities: EngineCapabilities = {
    supportsSystemVolume: true,
    supportsLoudnessNormalization: true,
    supportsLowVolumeHint: true,
  }
  readonly studioMode = 'custom' as const

  async attach(handle: AudioGraphHandle): Promise<void> {
    this.engine.attach(handle)
  }

  dispose(): void {
    this.engine.dispose()
  }

  isAttached(): boolean {
    return (this.engine as unknown as { context: AudioContext | null }).context !== null
  }

  setSystemVolume(volume: number): void {
    this.engine.setSystemVolume(volume)
    // 低音量提示（从 App.tsx effect 剥离）：补偿未开启 + 音量 < 阈值时弹一次 toast
    if (this.onLowVolumeHint && volume >= 0 && volume < LOUDNESS_COMPENSATION_THRESHOLD) {
      const compEnabled = this.engine.getSettings().effects.loudnessCompensation.enabled
      if (!compEnabled) {
        const key = 'waveforge:loudness-comp-hinted'
        if (!localStorage.getItem(key) && !this.hinted) {
          this.hinted = true
          localStorage.setItem(key, '1')
          this.onLowVolumeHint(`系统音量较低（${volume}%），可在调音室开启频响补偿改善低音量听感`)
        }
      }
    }
  }

  applyLoudnessNormalization(trackKey: string, url: string): void {
    // 响度归一化外部服务调用（从 App.tsx 剥离）：调 Python 3003 测量 LUFS + 施加增益
    void loudnessNormalizationService.apply(this.engine, trackKey, url)
  }

  resetLoudnessNormalization(): void {
    loudnessNormalizationService.reset(this.engine)
  }

  async exportMp3(sourceUrl: string, durationSeconds: number): Promise<void> {
    return this.engine.exportToWav(sourceUrl, durationSeconds)
  }

  renderStudio(props: RenderStudioProps): React.ReactNode {
    const { sourceUrl, sourceDuration, ...commonProps } = props
    return (
      <LazyMixingStudioV2
        engine={this.engine}
        sourceUrl={sourceUrl}
        sourceDuration={sourceDuration}
        {...commonProps}
      />
    )
  }

  getUiBridge(): IAudioEngineUiBridge | null {
    return null
  }

  isExporting(): boolean {
    return false
  }
}
