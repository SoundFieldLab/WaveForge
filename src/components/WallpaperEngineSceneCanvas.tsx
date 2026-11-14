/**
 * Wallpaper Engine 场景实时渲染画布
 * 加载清单 → 预加载纹理 → rAF 渲染循环；任何一步失败回调 onFail（DesktopView 回退静态 preview）。
 */

import { useEffect, useRef } from 'react'
import { WallpaperEngineSceneRenderer } from '../services/wallpaperEngineScene/renderer'
import { subscribeWeSpectrum } from '../services/wallpaperEngineScene/spectrumBus'
import type { WallpaperEnginePlaybackSettings } from '../services/wallpaperEnginePlayback'

interface Props {
  wallpaperId: string
  onFail?: (reason: string) => void
  /** 场景冻结（桌面模式被其它模式遮挡时 true）：渲染循环暂停，恢复后不重播入场动画 */
  paused?: boolean
  /** 播放参数（帧率/视差/音频响应；legacy 无声道，音量仅视频壁纸生效） */
  playback?: WallpaperEnginePlaybackSettings
}

export function WallpaperEngineSceneCanvas({ wallpaperId, onFail, paused = false, playback }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<WallpaperEngineSceneRenderer | null>(null)
  const failRef = useRef(onFail)
  failRef.current = onFail
  // boot 是异步的：paused 初值先入 ref，start() 完成后按它对齐
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const playbackRef = useRef(playback)
  playbackRef.current = playback

  // suspended 切换：冻结/恢复渲染循环（资源不销毁，时间保持）
  useEffect(() => {
    rendererRef.current?.setPaused(paused)
  }, [paused])

  // 帧率上限热调（0/60/30/24）
  useEffect(() => {
    if (!playback) return
    rendererRef.current?.setFpsLimit(playback.fpsLimit)
  }, [playback])

  // 鼠标视差开关（关闭时渲染器忽略输入并回中）
  useEffect(() => {
    if (!playback) return
    rendererRef.current?.setParallaxEnabled(playback.parallaxEnabled)
  }, [playback])

  // 音频响应开关（关闭时渲染器丢弃频谱推送）
  useEffect(() => {
    if (!playback) return
    rendererRef.current?.setAudioReactive(playback.audioReactiveEnabled)
  }, [playback])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let cancelled = false

    if (!WallpaperEngineSceneRenderer.isSupported()) {
      failRef.current?.('浏览器不支持 WebGL2')
      return
    }

    const gl = canvas.getContext('webgl2', { alpha: false, antialias: true })
    if (!gl) {
      failRef.current?.('WebGL2 上下文创建失败')
      return
    }

    const renderer = new WallpaperEngineSceneRenderer(canvas, gl)
    rendererRef.current = renderer

    // 音频响应：订阅频谱总线（总线无订阅者时不跑 rAF；退订自动停表）
    const unsubscribeSpectrum = subscribeWeSpectrum((spectrum) => {
      renderer.setAudioSpectrum(spectrum)
    })

    const boot = async () => {
      try {
        await renderer.load(wallpaperId)
        if (cancelled) return
        if (!renderer.hasRenderableObjects()) {
          failRef.current?.('场景无可实时渲染的图层')
          return
        }
        await renderer.preloadTextures()
        if (cancelled) return
        renderer.start()
        // 挂载完成时若已处于冻结态（挂载发生在 suspended 期间），立即对齐暂停
        if (pausedRef.current) renderer.setPaused(true)
        // 挂载期间 playback 可能已变化：按最新值应用帧率/视差/音频响应
        const current = playbackRef.current
        if (current) {
          renderer.setFpsLimit(current.fpsLimit)
          renderer.setParallaxEnabled(current.parallaxEnabled)
          renderer.setAudioReactive(current.audioReactiveEnabled)
        }
      } catch (error) {
        if (!cancelled) failRef.current?.(error instanceof Error ? error.message : String(error))
      }
    }
    void boot()

    return () => {
      cancelled = true
      unsubscribeSpectrum()
      renderer.stop()
      rendererRef.current = null
    }
  }, [wallpaperId])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      style={{
        display: 'block',
        // WebGL 画布由渲染器按 DPR 自绘，禁用默认拉伸模糊
        imageRendering: 'auto',
      }}
    />
  )
}
