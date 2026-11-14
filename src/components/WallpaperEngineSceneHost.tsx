/**
 * 场景壁纸渲染宿主：渲染链 = WebWallGL（主）→ legacy 自研渲染器（兜底）→ 静态预览
 *
 * - wwgl：第三方完整复刻引擎，保真度最高（2026-11-03 四难例验证通过）
 * - legacy：自研 renderer.ts，历史验证过的官方场景路径保留兜底
 * - 两者都失败才 onFinalFail（DesktopView 提示并回退静态 preview）
 */

import { useEffect, useState } from 'react'
import { WallpaperEngineSceneCanvas } from './WallpaperEngineSceneCanvas'
import { WallpaperEngineWwglCanvas } from './WallpaperEngineWwglCanvas'
import type { WallpaperEnginePlaybackSettings } from '../services/wallpaperEnginePlayback'

interface Props {
  wallpaperId: string
  onFinalFail?: (reason: string) => void
  /** 场景冻结（桌面模式被其它模式遮挡时 true）：暂停渲染循环，场景时间保持不重播 */
  paused?: boolean
  /** 播放参数（音量/帧率/视差/音频响应），来自桌面设置 */
  playback?: WallpaperEnginePlaybackSettings
}

/**
 * 已知 WWGL 渲染异常、legacy 正常的壁纸（按 workshop id）：
 * - 3589454154 土星 | Saturn - Sykm：3D 相机场景，WWGL 静默不绘制全部 3D model
 *   （天空盒/太阳/土星/环/卫星，2D 文字与图标层正常、控制台零报错）；
 *   2026-11-07 全库回归实锤，legacy 渲染完整正常 → 默认走 legacy。
 * - 3662790108 实时太阳系 Live Solar System - SYKM：同缺陷族（847 对象/72 model，
 *   WWGL 全黑仅两个线框占位框；legacy 应用内首屏验证正常，探针下加载极慢属预期）。
 * - 3615984066 鸣潮 Wuthering Waves | Mornye：WWGL 画面中部出现倾斜白色空带
 *   （疑似某对象贴图/混合失效画成白 quad）+ 左侧整体洗白；2026-11-14 探针 A/B 复现
 *   （WWGL 异常 / legacy 15 对象全部贴图 ok 渲染完整）→ 默认走 legacy。
 * 用户可用 localStorage['weRendererOverrides'] = {"<id>": "wwgl"|"legacy"} 逐张覆盖，
 * 或 localStorage['weRendererDefault'] = "legacy" 全局切回兼容渲染器。
 */
const DEFAULT_LEGACY_IDS = new Set(['3589454154', '3662790108', '3615984066'])

function resolvePreferredRenderer(wallpaperId: string): 'wwgl' | 'legacy' {
  let overrides: Record<string, string> = {}
  try {
    overrides = JSON.parse(localStorage.getItem('weRendererOverrides') || '{}')
  } catch { /* 覆盖表损坏按空处理 */ }
  let globalDefault = 'wwgl'
  try {
    globalDefault = localStorage.getItem('weRendererDefault') || 'wwgl'
  } catch { /* ignore */ }
  // 路径型 id（同步联动传绝对路径）：提取末段 workshop 数字 id 供匹配
  const pathIdMatch = wallpaperId.match(/(\d{6,})[\\/]*$/)
  const candidates = [wallpaperId, pathIdMatch?.[1]].filter(Boolean) as string[]
  for (const id of candidates) {
    const pref = overrides[id] ?? (DEFAULT_LEGACY_IDS.has(id) ? 'legacy' : undefined)
    if (pref === 'legacy') return 'legacy'
    if (pref === 'wwgl') return 'wwgl'
  }
  return globalDefault === 'legacy' ? 'legacy' : 'wwgl'
}

export function WallpaperEngineSceneHost({ wallpaperId, onFinalFail, paused = false, playback }: Props) {
  const [mode, setMode] = useState<'wwgl' | 'legacy'>(() => resolvePreferredRenderer(wallpaperId))

  // 换壁纸时按覆盖表重置渲染链
  useEffect(() => {
    setMode(resolvePreferredRenderer(wallpaperId))
  }, [wallpaperId])

  if (mode === 'legacy') {
    return (
      <WallpaperEngineSceneCanvas
        wallpaperId={wallpaperId}
        paused={paused}
        playback={playback}
        onFail={(reason) => {
          console.warn('[WESceneHost] legacy 渲染器也失败，回退静态预览:', reason)
          onFinalFail?.(reason)
        }}
      />
    )
  }

  return (
    <WallpaperEngineWwglCanvas
      wallpaperId={wallpaperId}
      paused={paused}
      playback={playback}
      onFail={(reason) => {
        console.warn('[WESceneHost] WWGL 渲染失败，回退 legacy 渲染器:', reason)
        setMode('legacy')
      }}
    />
  )
}
