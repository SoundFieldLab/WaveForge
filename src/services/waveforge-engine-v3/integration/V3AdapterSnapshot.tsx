/** WaveForge V3Adapter 的独立快照接线；主程序回流前仅在本目录使用。 */
import { lazy } from 'react'
import type { ReactNode } from 'react'
import {
  attachV3Engine, detachV3Engine, exportV3Mp3, exportV3Wav, getV3Bridge,
  isV3Attached, scanV3TrackReplayGain, setV3SystemVolume, setV3TrackReplayGainTags,
} from '../attachV3Engine'
import type { V3GraphHandle } from '../attachV3Engine'
import type { V3MixingStudioProps } from '../ui/V3MixingStudio'

const LazyMixingStudio = lazy(() => import('../ui').then((module) => ({ default: module.V3MixingStudio })))

type StudioProps = Omit<V3MixingStudioProps, 'bridge' | 'exportMp3' | 'exportWav' | 'exporting'> & {
  sourceUrl?: string | null
  sourceDuration?: number
  exportFileName?: string
}

export class V3AdapterSnapshot {
  private sourceUrl: string | null = null
  private scanController: AbortController | null = null
  private exporting = false
  private readonly exportListeners = new Set<(exporting: boolean) => void>()

  attach(handle: V3GraphHandle): Promise<void> { return attachV3Engine(handle) }
  isAttached(): boolean { return isV3Attached() }
  setSystemVolume(volume: number): void { setV3SystemVolume(volume) }

  /** 由播放队列在每次曲目提交时调用；已有服务端标签可直接传入。 */
  setPlaybackSource(url: string | null, tags?: Record<string, unknown> | null): void {
    if (url === this.sourceUrl && tags === undefined) return
    this.scanController?.abort()
    this.sourceUrl = url
    if (tags !== undefined) { setV3TrackReplayGainTags(tags); return }
    if (!url) { setV3TrackReplayGainTags(null); return }
    const controller = new AbortController()
    this.scanController = controller
    void scanV3TrackReplayGain(url, controller.signal)
  }

  dispose(): void {
    this.scanController?.abort()
    this.scanController = null
    this.sourceUrl = null
    setV3TrackReplayGainTags(null)
    detachV3Engine()
  }

  private async export(sourceUrl: string, duration: number, fileName: string | undefined, format: 'mp3' | 'wav'): Promise<void> {
    this.exporting = true
    this.exportListeners.forEach((listener) => listener(true))
    try {
      if (format === 'mp3') await exportV3Mp3(sourceUrl, duration, { fileName })
      else await exportV3Wav(sourceUrl, duration, { fileName })
    } finally {
      this.exporting = false
      this.exportListeners.forEach((listener) => listener(false))
    }
  }

  renderStudio({ sourceUrl, sourceDuration, exportFileName, ...common }: StudioProps): ReactNode {
    const exportAudio = (format: 'mp3' | 'wav') => sourceUrl
      ? () => this.export(sourceUrl, sourceDuration ?? 0, exportFileName, format)
      : null
    return <LazyMixingStudio {...common} bridge={getV3Bridge()}
      exportMp3={exportAudio('mp3')} exportWav={exportAudio('wav')} exporting={this.exporting} />
  }

  onExportingChange(listener: (exporting: boolean) => void): () => void {
    this.exportListeners.add(listener)
    return () => { this.exportListeners.delete(listener) }
  }
}
