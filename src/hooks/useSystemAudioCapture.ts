import { useEffect, useState } from 'react'
import { isDesktop } from '../platform'
import { getDGLabClient } from '../plugins/clients/DGLabClient'

const hasMediaCapture = typeof navigator !== 'undefined' && 'mediaDevices' in navigator

export interface SystemCaptureState {
  /** 是否真正捕获到系统音频并已接入 DG-LAB 分析源。 */
  captured: boolean
  /** 请求使用的状态（true = 用户打开了整机监听，等待/捕获中或失败）。 */
  enabled: boolean
  /** 捕获失败原因（null = 无错误）。 */
  error: string | null
}

const EMPTY_STATE: SystemCaptureState = { captured: false, enabled: false, error: null }

/**
 * 整机监听：直接把系统扬声器（loopback）声音接入 DG-LAB 分析源——
 * 无论本软件是否在播放，电脑里任何声音都能映射成波形。
 *
 * - 桌面版（Electron）：getUserMedia chromeMediaSource=desktop 直接抓整个系统音频，无选择框；
 * - 浏览器：回退 getDisplayMedia 共享「整个屏幕」，需在系统弹窗勾选「共享系统音频」。
 *
 * 捕获流只分析不发声（零增益入 destination，保证 Analyser 被渲染），
 * 避免系统原声（如正在放视频/其他播放器）被二次输出造成回声。
 */
export function useSystemAudioCapture(enabled: boolean): SystemCaptureState {
  const [state, setState] = useState<SystemCaptureState>(EMPTY_STATE)

  useEffect(() => {
    if (!enabled) {
      getDGLabClient().setSystemCaptureAnalysers(null, null)
      setState(EMPTY_STATE)
      return
    }
    if (!hasMediaCapture) {
      setState({ captured: false, enabled: true, error: '当前环境不支持媒体捕获（请使用桌面版或新版 Chrome）' })
      return
    }

    let disposed = false
    let ctx: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let stream: MediaStream | null = null

    const tearDown = () => {
      if (stream) stream.getTracks().forEach(track => track.stop())
      stream = null
      if (source) {
        try {
          source.disconnect()
        } catch { /* ignore */ }
        source = null
      }
      if (ctx) {
        try {
          void ctx.close()
        } catch { /* ignore */ }
        ctx = null
      }
    }

    const setup = async () => {
      try {
        // 桌面版：先尝试桌面循环回送直抓（不弹选择框）；若被新版 Chromium 禁用则回退
        // 到 getDisplayMedia（弹框共享「整个屏幕」并勾选系统音频）。浏览器直接用后者。
        let mediaStream: MediaStream | null = null
        if (isDesktop()) {
          try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
              audio: { mandatory: { chromeMediaSource: 'desktop' } },
              video: { mandatory: { chromeMediaSource: 'desktop' }, optional: [{ maxWidth: 2 }, { maxHeight: 2 }] },
            } as unknown as MediaStreamConstraints)
          } catch {
            mediaStream = null
          }
        }
        if (!mediaStream) {
          mediaStream = await navigator.mediaDevices.getDisplayMedia({
            video: true, // 部分浏览器要求 video 非空，捕获后立即停用视频轨
            audio: true,
          })
        }
        if (disposed) {
          mediaStream.getTracks().forEach(track => track.stop())
          return
        }
        const audioTrack = mediaStream.getAudioTracks()[0]
        if (!audioTrack) {
          mediaStream.getTracks().forEach(track => track.stop())
          throw new Error(isDesktop() ? '未捕获到系统音频轨' : '未捕获到系统音频轨——请在系统弹窗勾选「共享系统音频」')
        }
        // 只要音频：视频轨（浏览器共享屏幕）立即停用
        mediaStream.getVideoTracks().forEach(track => track.stop())
        stream = new MediaStream([audioTrack])

        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        ctx = new Ctor()
        void ctx.resume().catch(() => undefined)
        source = ctx.createMediaStreamSource(stream)
        const splitter = ctx.createChannelSplitter(2)
        const left = ctx.createAnalyser()
        const right = ctx.createAnalyser()
        const zeroGain = ctx.createGain()
        zeroGain.gain.value = 0 // 只分析不发声
        for (const node of [left, right]) {
          node.fftSize = 1024
          node.smoothingTimeConstant = 0.72
        }
        source.connect(splitter)
        splitter.connect(left, 0)
        splitter.connect(right, 1)
        // Analyser 必须有下游才会被渲染（悬空尾不处理）——零增益旁路到 destination
        left.connect(zeroGain)
        right.connect(zeroGain)
        zeroGain.connect(ctx.destination)

        if (disposed) {
          tearDown()
          return
        }
        getDGLabClient().setSystemCaptureAnalysers(left, right)
        setState({ captured: true, enabled: true, error: null })
      } catch (err) {
        if (disposed) return
        const name = err instanceof DOMException ? err.name : ''
        const message = name === 'NotAllowedError'
          ? '已取消共享——需选「整个屏幕」并勾选「共享系统音频」才能监听整机声音（桌面版若被系统拦截，请检查媒体权限）'
          : (err instanceof Error ? err.message : String(err))
        tearDown()
        setState({ captured: false, enabled: true, error: message })
      }
    }

    void setup()
    return () => {
      disposed = true
      tearDown()
      getDGLabClient().setSystemCaptureAnalysers(null, null)
    }
  }, [enabled])

  return state
}