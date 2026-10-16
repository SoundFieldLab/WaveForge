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
          <h1 className={`${theme.textPrimary} text-2xl font-semibold`}>HSE</h1>
          <p className={`${theme.textSecondary} mt-1 text-sm`}>HyperSoundEngine · WaveForge 特供版</p>
        </div>
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
            <Terminal className="mt-0.5 h-4 w-4 shrink-0" style={{ color: dev ? theme.accentColor : '#71817b' }} />
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
