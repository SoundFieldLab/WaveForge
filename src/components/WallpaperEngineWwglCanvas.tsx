/**
 * WebWallGL 场景渲染画布（主渲染器）
 *
 * webwallgl（MIT，github.com/oneincase/webwallgl）——第三方完整复刻 WE 场景：
 * 效果链（多 pass + FBO）/粒子/puppet 骨骼/SceneScript 沙箱/文字挂件/
 * 场景灯光 PBR/音频响应/鼠标视差，全部开箱即用（2026-11-03 集成验证：
 * 千咲/雪境/GAS/芙莉莲 4 难例一次通过，含雪境对象级链与 GAS godrays）。
 *
 * 壁纸源走本地服务静态路由 /api/wallpaper-engine/scene/wwgl/<id>/，
 * httpSource 自行拉取 scene.pkg（自动尝试 scene.pkg / scenes/ / gifscene.pkg）。
 * 挂载失败回调 onFail（SceneHost 回退 legacy 自研渲染器）。
 */

import { useEffect, useRef } from 'react'
import { mount, httpSource, type SceneInstance } from 'webwallgl'
import { subscribeWeSpectrum } from '../services/wallpaperEngineScene/spectrumBus'
import type { WallpaperEnginePlaybackSettings } from '../services/wallpaperEnginePlayback'
import {
  loadWallpaperEngineUserProps,
  subscribeWallpaperEngineUserProps,
  type WEUserPropertyValues,
} from '../services/wallpaperEngineUserProperties'
import { getApiOrigin } from '../services/apiConfig'

interface Props {
  wallpaperId: string
  onFail?: (reason: string) => void
  /** 场景冻结（桌面模式被其它模式遮挡时 true）：pause 渲染循环，恢复后不重播入场动画 */
  paused?: boolean
  /** 播放参数（音量/帧率/视差/音频响应），来自桌面设置 */
  playback?: WallpaperEnginePlaybackSettings
}

/**
 * 壁纸 id 两种形态对应两种 URL 通道：
 * - workshop 数字 id / 官方 defaultprojects/<名> → 直接进路径（服务端前缀试探解析）
 * - 同步联动传入的 Windows 绝对路径（含盘符冒号与反斜杠）→ 无法直接进 URL
 *   （反斜杠会被浏览器规范化成斜杠、盘符冒号会被服务端路径校验拒绝）→ base64url 编码，
 *   服务端 b64 模式解出目录（与 web 壁纸路由同一模式）。
 */
function buildWwglBaseUrl(wallpaperId: string): string {
  const origin = getApiOrigin()
  const apiRoot = `${origin}/api/wallpaper-engine/scene/wwgl`
  if (/^[a-zA-Z]:[\\/]/.test(wallpaperId) || wallpaperId.includes('\\')) {
    const bytes = new TextEncoder().encode(wallpaperId)
    let binary = ''
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
    const b64dir = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${apiRoot}/b64/${b64dir}`
  }
  return `${apiRoot}/${wallpaperId}`
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export function WallpaperEngineWwglCanvas({ wallpaperId, onFail, paused = false, playback }: Props) {
  // webwallgl 要求挂到空容器（库自建画布，不能传自己的 canvas）
  const containerRef = useRef<HTMLDivElement | null>(null)
  const failRef = useRef(onFail)
  failRef.current = onFail
  // mount 是异步的：paused 初值先入 ref，mount 完成后按它对齐
  const instanceRef = useRef<SceneInstance | null>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  // 播放参数：ref 供挂载闭包（audio.snapshot）读取，避免挂载 effect 依赖整个 playback 对象
  const playbackRef = useRef(playback)
  playbackRef.current = playback

  // 用户属性热更：设置弹窗改属性 → 事件 → setProperties（库就地改属性表/效果常量/
  // 脚本沙箱，不重拉 scene.pkg）。挂在 wallpaperId 前的 mount 期间变更由挂载闭包末尾
  // 的对齐逻辑兜底（userPropsRef 恒存最新值）。
  const userPropsRef = useRef<WEUserPropertyValues>(loadWallpaperEngineUserProps(wallpaperId))
  useEffect(() => {
    userPropsRef.current = loadWallpaperEngineUserProps(wallpaperId)
    return subscribeWallpaperEngineUserProps((detail) => {
      if (detail.wallpaperId !== wallpaperId) return
      userPropsRef.current = detail.values
      instanceRef.current?.setProperties(detail.values)
    })
  }, [wallpaperId])

  // suspended 切换：pause/resume 场景实例（实例不销毁 → 场景时间不回卷、过场动画不重播）
  useEffect(() => {
    const inst = instanceRef.current
    if (!inst) return
    if (paused && !inst.paused) inst.pause()
    if (!paused && inst.paused) inst.resume()
  }, [paused])

  // 音量：挂载选项默认静音起步（浏览器自动播放策略），挂载完成后按设置应用
  useEffect(() => {
    const inst = instanceRef.current
    if (!inst || !playback) return
    inst.setVolume(clamp01(playback.volume / 100))
  }, [playback])

  // 帧率上限：运行时热调（库默认 60）
  useEffect(() => {
    const inst = instanceRef.current
    if (!inst || !playback) return
    inst.setFps(playback.fpsLimit)
  }, [playback])

  // 鼠标视差：WWGL 的 PointerSource 未接线，需外部 pushPointer 喂入；
  // 监听 window pointermove，归一化到容器矩形（与 legacy bindPointer 同语义）
  useEffect(() => {
    if (!playback?.parallaxEnabled) {
      // 关闭视差：指针回中（视差层回到静止位）
      instanceRef.current?.pushPointer(0.5, 0.5)
      return
    }
    const handler = (event: PointerEvent) => {
      const inst = instanceRef.current
      const container = containerRef.current
      if (!inst || !container) return
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      inst.pushPointer(
        clamp01((event.clientX - rect.left) / rect.width),
        clamp01((event.clientY - rect.top) / rect.height),
      )
    }
    window.addEventListener('pointermove', handler, { passive: true })
    return () => window.removeEventListener('pointermove', handler)
  }, [playback?.parallaxEnabled])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false

    // 频谱缓冲：spectrumBus 每帧 64 bin（0..1）。左右声道共用同一份数据
    // （WE 场景音频响应多为左右镜像；静音时总线自身衰减到 0，与 WE 静置语义一致）。
    // 音频响应关闭时 snapshot 返回全零缓冲（不订阅停喂会影响总线自动停表语义，
    // 且实例热调 setAudio 需要 snapshot 通道稳定存在）。
    const spectrum = new Float32Array(64)
    const silence = new Float32Array(64)
    const unsubscribeSpectrum = subscribeWeSpectrum((data) => {
      spectrum.set(data.subarray(0, Math.min(64, data.length)))
    })

    const initialPlayback = playbackRef.current
    const boot = async () => {
      try {
        const inst = await mount(container, {
          // ⚠️ 必须用绝对 API 源（getApiOrigin）：dev 的 vite 没有 /api 代理，
          // 相对路径会落到 vite spa-fallback 返回 index.html → parsePkg 魔数
          // "<!do" 报错；且 Electron token 注入只认 3001 直连 URL（鉴权必需）。
          source: httpSource(buildWwglBaseUrl(wallpaperId)),
          autoplay: true,
          // 帧率上限（库默认 60）：挂载即按当前设置
          fps: initialPlayback?.fpsLimit,
          // 用户属性初始覆盖（设置弹窗保存的值；空对象无害）
          properties: userPropsRef.current,
          // 音量 0..1：挂载选项默认静音起步（自动播放策略），挂载完成后由 effect 应用
          audio: {
            snapshot: () => {
              const reactive = playbackRef.current?.audioReactiveEnabled ?? true
              const buffer = reactive ? spectrum : silence
              return { left: buffer, right: buffer }
            },
          },
          onError: (err) => {
            // 运行期致命错误（GL 上下文丢失等）只记日志——挂载已成功，
            // 不走 onFail 回退链，避免播放中突然退回静态图
            console.warn('[WEWwgl] 场景运行期错误:', err)
          },
        })
        if (cancelled) {
          inst.destroy({ releasePkgCache: true })
          return
        }
        instanceRef.current = inst
        // 挂载完成时若已处于冻结态（挂载发生在 suspended 期间），立即对齐暂停
        if (pausedRef.current) inst.pause()
        // 挂载期间 playback 可能已变化：按最新值应用音量/帧率/视差回中
        const current = playbackRef.current
        if (current) {
          inst.setVolume(clamp01(current.volume / 100))
          inst.setFps(current.fpsLimit)
          if (!current.parallaxEnabled) inst.pushPointer(0.5, 0.5)
        }
        // 挂载期间用户属性可能已变更（事件在 instanceRef 就绪前到达）：对齐最新覆盖
        if (Object.keys(userPropsRef.current).length > 0) {
          inst.setProperties(userPropsRef.current)
        }
      } catch (error) {
        if (!cancelled) {
          failRef.current?.(error instanceof Error ? error.message : String(error))
        }
      }
    }
    void boot()

    return () => {
      cancelled = true
      unsubscribeSpectrum()
      // releasePkgCache：桌面壁纸切换即放弃语义，旧包不压缓存占内存
      instanceRef.current?.destroy({ releasePkgCache: true })
      instanceRef.current = null
    }
  }, [wallpaperId])

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden"
    />
  )
}
