/**
 * V3Adapter —— v3 音效引擎适配器（studioMode: 'custom'）
 *
 * 转发 waveforge-engine-v3/attachV3Engine 的自由函数（模块单例模式）。
 * v3 是纯 TS DSP 内核引擎，响度归一化/频响补偿都在引擎内实时实现（不走外部服务）。
 * 导出状态（exporting）上提到 adapter，通过 onExportingChange 事件通知 App 重渲染。
 */

import { lazy } from 'react'
import {
  attachV3Engine,
  detachV3Engine,
  getV3Bridge,
  setV3SystemVolume,
  exportV3Mp3,
  isV3Attached,
} from '../waveforge-engine-v3/attachV3Engine'
import type { AudioEngineVersion } from '../audioEngineVersion'
import type {
  IAudioEngineAdapter,
  AudioGraphHandle,
  EngineCapabilities,
  RenderStudioProps,
  IAudioEngineUiBridge,
} from './types'

const LazyMixingStudioV3 = lazy(() =>
  import('../waveforge-engine-v3/ui').then((m) => ({ default: m.V3MixingStudio })),
)

export class V3Adapter implements IAudioEngineAdapter {
  private exporting = false
  private exportingCallbacks = new Set<(exporting: boolean) => void>()

  readonly version: AudioEngineVersion = 'v3'
  readonly capabilities: EngineCapabilities = {
    supportsSystemVolume: true,
    supportsLoudnessNormalization: false, // v3 引擎内实时实现，不走外部服务
    supportsLowVolumeHint: false,
  }
  readonly studioMode = 'custom' as const

  async attach(handle: AudioGraphHandle): Promise<void> {
    return attachV3Engine(handle)
  }

  dispose(): void {
    detachV3Engine()
  }

  isAttached(): boolean {
    return isV3Attached()
  }

  setSystemVolume(volume: number): void {
    setV3SystemVolume(volume)
  }

  applyLoudnessNormalization(): void {
    // v3 响度归一化在引擎内实时实现（LufsMeter DSP 模块），无需外部服务调用，no-op
  }

  resetLoudnessNormalization(): void {
    // v3 响度归一化引擎内自治，no-op
  }

  async exportMp3(sourceUrl: string, durationSeconds: number, options?: { fileName?: string }): Promise<void> {
    this.setExporting(true)
    try {
      await exportV3Mp3(sourceUrl, durationSeconds, options)
    } finally {
      this.setExporting(false)
    }
  }

  renderStudio(props: RenderStudioProps): React.ReactNode {
    const { sourceUrl, sourceDuration, exportFileName, ...commonProps } = props
    // v3 调音室需要 bridge + exportMp3 闭包 + exporting 状态
    // exportMp3 闭包：包装 adapter.exportMp3，错误时弹 toast
    const exportMp3 = sourceUrl
      ? async () => {
          try {
            await this.exportMp3(sourceUrl, sourceDuration || 0, { fileName: exportFileName })
          } catch (err) {
            window.dispatchEvent(new CustomEvent('showToast', {
              detail: { message: `导出失败：${err instanceof Error ? err.message : String(err)}`, type: 'error' },
            }))
          }
        }
      : null
    return (
      <LazyMixingStudioV3
        bridge={getV3Bridge()}
        exportMp3={exportMp3}
        exporting={this.exporting}
        {...commonProps}
      />
    )
  }

  getUiBridge(): IAudioEngineUiBridge | null {
    return null
  }

  isExporting(): boolean {
    return this.exporting
  }

  onExportingChange(cb: (exporting: boolean) => void): () => void {
    this.exportingCallbacks.add(cb)
    return () => {
      this.exportingCallbacks.delete(cb)
    }
  }

  private setExporting(value: boolean): void {
    this.exporting = value
    for (const cb of this.exportingCallbacks) cb(value)
  }
}
