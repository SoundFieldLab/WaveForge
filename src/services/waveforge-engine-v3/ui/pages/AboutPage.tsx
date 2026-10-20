/**
 * 关于页 —— HSE 品牌、版权授权与场景开发者模式
 */

import { useEffect, useState } from 'react'
import { Terminal } from 'lucide-react'
import { Toggle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import { isDevMode, setDevMode, HSE_DEV_MODE_EVENT } from '../sceneStore'

interface AboutPageProps {
  theme: HSETheme
}

export default function AboutPage({ theme }: AboutPageProps) {
  const [dev, setDev] = useState(isDevMode)

  useEffect(() => {
    const sync = () => setDev(isDevMode())
    window.addEventListener(HSE_DEV_MODE_EVENT, sync)
    return () => window.removeEventListener(HSE_DEV_MODE_EVENT, sync)
  }, [])

  return (
    <div className="@container w-full space-y-5 py-2">
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: theme.accentDim, color: theme.accentColor }}>
          <Terminal className="h-7 w-7" aria-hidden="true" />
        </div>
        <div>
          <h1 className={`${theme.textPrimary} text-2xl font-semibold`}>HSE 1.5</h1>
          <p className={`${theme.textSecondary} mt-1 text-sm`}>HyperSoundEngine · WaveForge 特供版</p>
        </div>
      </div>
      <div className="rounded-2xl border p-4" style={{ background: theme.cardBg, borderColor: theme.cardBorder }}>
        <h2 className={`${theme.textPrimary} text-sm font-medium`}>声音处理与空间渲染</h2>
        <p className={`${theme.textSecondary} mt-2 text-xs leading-relaxed`}>动态均衡、三段压缩、卷积 IR、耳机交叉馈送与双精度处理可在各页面独立调整。空间音频支持多声道输入、AmbiX 一至三阶、FOA FuMa 和通用 SOFA，最终渲染为双声道，适合耳机试听。</p>
        <p className={`${theme.textSecondary} mt-2 text-xs leading-relaxed`}>中央信号 / 差分信号来自原曲左右声道的组合。头部追踪需要连接兼容设备或本机姿态桥；扬声器校准使用几何估算与导入的 IR 分析结果。</p>
      </div>
      <div className="grid items-stretch gap-3 @min-[36rem]:grid-cols-2 @min-[52rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(18rem,1.2fr)]">
        <div className="rounded-2xl border p-4" style={{ background: theme.cardBg, borderColor: theme.cardBorder }}>
          <div className={`${theme.textTertiary} text-xs`}>版权</div>
          <div className={`${theme.textPrimary} mt-2 text-sm`}>2026 © IceFire_Icer All Right Reserved</div>
        </div>
        <div className="rounded-2xl border p-4" style={{ background: theme.cardBg, borderColor: theme.cardBorder }}>
          <div className={`${theme.textTertiary} text-xs`}>授权</div>
          <div className={`${theme.textPrimary} mt-2 text-sm`}>HyperSoundEngine 已授权 WaveForge 项目使用</div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-4 @min-[36rem]:col-span-2 @min-[52rem]:col-span-1" style={{ background: theme.cardBg, borderColor: theme.cardBorder }}>
          <div className="flex items-start gap-3">
            <Terminal className="mt-0.5 h-4 w-4 shrink-0" style={{ color: dev ? theme.accentColor : '#536b66' }} />
            <div>
              <div className={`${theme.textPrimary} text-sm font-medium`}>开发者模式</div>
              <div className={`${theme.textSecondary} mt-1 text-xs leading-relaxed`}>开启后可在「音效场景」页编辑内置场景参数并保存</div>
            </div>
          </div>
          <Toggle label="开发者模式" checked={dev} onChange={(v) => { setDevMode(v); setDev(v) }} theme={theme} />
        </div>
      </div>
    </div>
  )
}
