/**
 * Gapless Integration - 集成 Album Gapless
 * 这个模块在"无缝衔接"模式下提供同专辑直接拼接 / 60ms 淡入淡出 / 交叉淡化等方案分流。
 * （Cuefield AutoMix 路径已清理：cuefield 自动触发链路整体不可达。）
 */

import { debugLog } from '../utils/debugLog'
import { AlbumGaplessService } from '../services/albumGapless'

/** 歌曲元信息（跨专辑边界规划时的最小集合） */
export interface GaplessSong {
  key: string
  url: string
  title?: string
  artist?: string
  album?: string
  albumId?: string
  duration?: number
  lyrics?: string
}

export interface GaplessIntegrationOptions {
  enabled: boolean
  albumGaplessEnabled: boolean
  getCurrentAudio: () => HTMLAudioElement | null
  getCurrentTime: () => number
  getCurrentIndex: () => number
  getCurrentTrackKey: () => string
  getTargetVolume: () => number
  setOutputGain: (gain: number) => void
  getOutputGain: () => number
  getPlayQueue: () => any[]
  canAdvance: (index: number) => boolean
  playAt: (index: number, options: any) => Promise<boolean>
  prepareAudioUrl: (song: GaplessSong) => Promise<string>
  onStateChange?: (state: any) => void
  /** 分析期静音边界快查（AutoMix 缓存复用；见 AlbumGaplessService.deps） */
  getTrackAnalysis?: (trackKey: string) => { introSilence: number; outroSilence: number } | null
}

export class GaplessIntegration {
  private albumGapless: AlbumGaplessService
  private currentToken: number = 0
  private transitionProgressFrame = 0

  constructor(private options: GaplessIntegrationOptions) {
    this.albumGapless = new AlbumGaplessService({
      getCurrentAudio: options.getCurrentAudio,
      getCurrentTime: options.getCurrentTime,
      getCurrentIndex: options.getCurrentIndex,
      getCurrentTrackKey: options.getCurrentTrackKey,
      getTargetVolume: options.getTargetVolume,
      setOutputGain: options.setOutputGain,
      getOutputGain: options.getOutputGain,
      getPlayQueue: options.getPlayQueue,
      canAdvance: options.canAdvance,
      playAt: options.playAt,
      onTransitionStart: (targetTrackKey, duration) => {
        this.beginVisualTransition(options.getCurrentTrackKey(), targetTrackKey, duration, false)
      },
      onTransitionProgress: progress => this.emitTransitionProgress(progress),
      onTransitionCancel: () => this.cancelVisualTransition(true),
      getTrackAnalysis: options.getTrackAnalysis,
    })
  }

  private beginVisualTransition(
    sourceTrackKey: string,
    targetTrackKey: string,
    duration: number,
    trackProgress: boolean
  ): void {
    this.cancelVisualTransition()
    const safeDuration = Math.max(0.1, duration)
    const startedAt = performance.now()
    this.options.onStateChange?.({
      transitionState: 'running-transition',
      transitioning: true,
      seamlessTransition: true,
      transitionStrategy: 'gapless',
      transitionProgress: 0,
      transitionDuration: safeDuration,
      transitionFromTrackKey: sourceTrackKey,
      transitionToTrackKey: targetTrackKey,
    })

    if (!trackProgress) return
    // 进度以 30fps 节流发布（保留 rAF 驱动保证暂停/恢复响应），结束帧强制发布 1
    let lastEmitAt = 0
    const tick = () => {
      const progress = Math.min(1, (performance.now() - startedAt) / (safeDuration * 1000))
      const now = performance.now()
      if (progress >= 1 || now - lastEmitAt >= 30) {
        this.emitTransitionProgress(progress)
        lastEmitAt = now
      }
      if (progress < 1) this.transitionProgressFrame = requestAnimationFrame(tick)
      else this.transitionProgressFrame = 0
    }
    this.transitionProgressFrame = requestAnimationFrame(tick)
  }

  private emitTransitionProgress(progress: number): void {
    this.options.onStateChange?.({ transitionProgress: Math.max(0, Math.min(1, progress)) })
  }

  private cancelVisualTransition(announce = false): void {
    if (this.transitionProgressFrame) cancelAnimationFrame(this.transitionProgressFrame)
    this.transitionProgressFrame = 0
    if (announce) {
      this.options.onStateChange?.({
        transitionState: 'playing',
        transitioning: false,
        transitionProgress: 0,
      })
    }
  }

  initAudioContext(audioContext: AudioContext, analyser: AnalyserNode): void {
    this.albumGapless.initAudioContext(audioContext, analyser)
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.albumGapless.setEnabled(false)
    }
  }

  setAlbumGaplessEnabled(enabled: boolean): void {
    // Album Gapless 的启用状态会在需要时动态设置
  }

  updateSettings(settings: { enabled: boolean; albumGapless: boolean }): void {
    this.options.enabled = settings.enabled
    this.options.albumGaplessEnabled = settings.albumGapless
    this.setEnabled(settings.enabled)
  }

  async prepareTransition(ctx: {
    token: number
    currentIndex: number
    nextIndex: number
    currentSong: GaplessSong
    nextSong: GaplessSong
  }): Promise<{ success: boolean; mode: 'album-gapless' | 'disabled' }> {
    if (!this.options.enabled) {
      return { success: false, mode: 'disabled' }
    }

    this.currentToken = ctx.token

    // 检查是否是同专辑（且启用了专辑融合）
    const queue = this.options.getPlayQueue()
    const currentSongData = queue[ctx.currentIndex]
    const nextSongData = queue[ctx.nextIndex]
    
    const currentAlbumId = ctx.currentSong.albumId || currentSongData?.albumId
    const nextAlbumId = ctx.nextSong.albumId || nextSongData?.albumId
    const currentAlbumCover = ctx.currentSong.album || currentSongData?.albumCover
    const nextAlbumCover = ctx.nextSong.album || nextSongData?.albumCover
    const sameAlbum = currentAlbumId &&
                     currentAlbumId === nextAlbumId &&
                     this.options.albumGaplessEnabled

    debugLog('[Gapless] album match:', {
      currentAlbumId: currentAlbumId || null,
      nextAlbumId: nextAlbumId || null,
      albumGaplessEnabled: this.options.albumGaplessEnabled,
      sameAlbum: Boolean(sameAlbum),
    })

    if (sameAlbum) {
      const albumKey = this.albumGapless.getSongAlbumKey({
        key: ctx.currentSong.key,
        url: ctx.currentSong.url,
        albumId: currentAlbumId,
        albumCover: currentAlbumCover,
      })
      this.albumGapless.setDirectJoinPreferred(false)
      const enabled = this.albumGapless.setEnabled(true, null, albumKey)
      const preparedNextUrl = await this.options.prepareAudioUrl(ctx.nextSong)
      if (!preparedNextUrl) throw new Error('Album gapless could not prepare the next audio URL')
      const scheduled = enabled && await this.albumGapless.schedulePreload(ctx.token, ctx.nextIndex, {
        key: ctx.nextSong.key,
        url: preparedNextUrl,
        albumId: nextAlbumId,
        albumCover: nextAlbumCover,
      })
      if (scheduled) {
        debugLog('[Gapless] 同专辑：专辑融合已预载并等待尾部检测')
        return { success: true, mode: 'album-gapless' }
      }
      this.albumGapless.setEnabled(false)
      debugLog('[Gapless] 同专辑融合预载失败，回退直接拼接')
      this.albumGapless.setDirectJoinPreferred(true)
      return { success: false, mode: 'disabled' }
    }

    // Gapless 与 AutoMix 是两套独立系统。跨专辑时只保留普通边界
    // 无缝切换；BPM、节拍和能量规划只由 useAudioPlayer 的 AutoMix 路径负责。
    // 非专辑场景：albumGapless 交叉淡化（第三种）解除直接拼接门控，
    // 由 useAudioPlayer 走第二种（60ms 淡入淡出）。
    debugLog('[Gapless] 跨专辑歌曲使用普通无缝边界切换')
    this.albumGapless.setDirectJoinPreferred(false)
    this.albumGapless.setEnabled(false)
    return { success: false, mode: 'disabled' }
  }

  executeTransition(): { success: boolean; mode: 'album-gapless' | 'none' } {
    const albumState = this.albumGapless.snapshot()
    const albumTransitionActive = albumState.handoff
      || Boolean(albumState.preload?.mixPending)
      || Boolean(albumState.preload?.mixStarted)

    // The outgoing managed deck can emit `ended` a few frames before the
    // album crossfade finishes. Treat that mix as authoritative so the hook
    // does not start a second standby deck for the same target track.
    if (albumTransitionActive) {
      return { success: true, mode: 'album-gapless' }
    }

    return { success: false, mode: 'none' }
  }

  hasActiveTransition(): boolean {
    const albumState = this.albumGapless.snapshot()
    return albumState.handoff
      || Boolean(albumState.preload?.mixPending)
      || Boolean(albumState.preload?.mixStarted)
  }

  reset(preserveAudio?: HTMLAudioElement): void {
    this.albumGapless.clearPreload('reset')
    this.cancelVisualTransition()
    this.options.setOutputGain(this.options.getTargetVolume())
  }

  dispose(): void {
    this.reset()
  }
}
