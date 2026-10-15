/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 动态封面 Hook：切歌时查询当前歌曲的动态封面（非阻塞，失败回退静态）。
 * 结果带过期保护（切歌后丢弃旧结果），设置变化实时生效。
 */
import { useEffect, useState } from 'react'
import { getAppleDynamicCover, isAppleDynamicCoverEnabled, type AppleDynamicCoverData } from '../services/appleDynamicCover'

export interface AppleDynamicCoverState {
  /** 查询结果（null = 无/未开启/失败，界面回退静态封面） */
  cover: AppleDynamicCoverData | null
  /** 是否正在查询 */
  loading: boolean
}

export function useAppleDynamicCover(query: {
  title: string
  artist: string
  album?: string
  duration?: number
  /** 曲目唯一键（切歌判旧用） */
  trackKey: string | number
}): AppleDynamicCoverState {
  const { title, artist, album, duration, trackKey } = query
  const [state, setState] = useState<AppleDynamicCoverState>({ cover: null, loading: false })
  // 记录当前生效封面的 trackKey：切歌瞬间（commit）标题等参数已更新，但新曲查询要
  // 300ms 延迟+网络往返——期间 prev.cover 还挂着**上一首的动画**，歌词/歌名已是新曲
  // 而封面卡旧曲 5-6s（用户实测）。coverTrackKey 与 trackKey 不一致时立即清空。
  const [coverTrackKey, setCoverTrackKey] = useState<string | number>('')

  useEffect(() => {
    // 未开启时零请求（与 AM 静态封面的摩登隔离规则一致）
    if (!isAppleDynamicCoverEnabled() || !title) {
      setState({ cover: null, loading: false })
      setCoverTrackKey('')
      return
    }
    const controller = new AbortController()
    setState((prev) => ({ cover: null, loading: true }))
    setCoverTrackKey('')
    // 延迟 300ms：封面首屏永远先用平台静态图，动态图层就绪后再淡入
    const timer = window.setTimeout(() => {
      void getAppleDynamicCover({ title, artist, album, duration, signal: controller.signal })
        .then((cover) => {
          if (!controller.signal.aborted) {
            setState({ cover, loading: false })
            setCoverTrackKey(trackKey)
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setState({ cover: null, loading: false })
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [title, artist, album, duration, trackKey])

  // trackKey 已变但 cover 还是旧曲的（查询在途/失败）→ 立即清空，静态封面即时接管
  useEffect(() => {
    if (coverTrackKey && coverTrackKey !== trackKey) {
      setState({ cover: null, loading: false })
      setCoverTrackKey('')
    }
  }, [trackKey, coverTrackKey])

  // 设置开关变化时立即清空（关闭 → 视频层卸载，静态封面露出）
  useEffect(() => {
    const onSettingChanged = () => {
      if (!isAppleDynamicCoverEnabled()) setState({ cover: null, loading: false })
    }
    window.addEventListener('appleDynamicCoverSettingChanged', onSettingChanged)
    return () => window.removeEventListener('appleDynamicCoverSettingChanged', onSettingChanged)
  }, [])

  return state
}
