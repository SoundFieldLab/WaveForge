/**
 * 插件系统入口按钮（三模式共用）+ 已启用插件的快捷入口。
 * - 简约模式（PlayerControls 药丸）：小圆钮，与播放模式按钮同款；
 * - 桌面模式（DesktopView 底部弹出栏）：48px 圆钮同款；
 * - 探索模式（ExploreView 右上角）：小方钮同款。
 * 已启用插件（如 DG_LAB）在旁边显示快捷按钮 + 连接状态小灯，点击直达其控制台。
 */

import { motion } from 'framer-motion'
import { Blocks, Lightbulb, RadioTower, Zap } from 'lucide-react'
import { openChromaConsole, openDGLabConsole, openPluginCenter, openPluginConsole } from '../services/pluginStore'
import { isPluginEnabled } from '../services/pluginStore'
import { useDGLabStatus } from '../plugins/clients/DGLabClient'
import { useChromaClient } from '../plugins/clients/ChromaClient'
import { useSignalRgbClient } from '../plugins/clients/SignalRgbClient'

export type PluginShortcutVariant = 'pill' | 'desktop' | 'explore' | 'home'

interface PluginShortcutsProps {
  variant: PluginShortcutVariant
  playerTheme?: 'dark' | 'light'
}

function DGLabStatusDot({ show }: { show: boolean }) {
  const status = useDGLabStatus()
  if (!show) return null
  const color = status.state === 'bound' ? '#34d399' : status.state === 'waiting' ? '#f0b429' : '#64748b'
  return (
    <span
      className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-black/60"
      style={{
        background: color,
        boxShadow: status.state === 'bound' ? `0 0 8px ${color}` : 'none',
        animation: status.state === 'bound' ? 'dglabPulse 1.2s ease-in-out infinite' : 'none',
      }}
    />
  )
}

function ChromaStatusDot({ show }: { show: boolean }) {
  const { status } = useChromaClient()
  if (!show) return null
  const connected = status.registered && Object.values(status.devices).some(device => device.available)
  const color = connected ? '#44D62C' : status.registered ? '#f0b429' : '#64748b'
  return (
    <span
      className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-black/60"
      style={{ background: color, boxShadow: connected ? `0 0 8px ${color}` : 'none' }}
    />
  )
}

function SignalRgbStatusDot({ show }: { show: boolean }) {
  const { status } = useSignalRgbClient()
  if (!show) return null
  const color = status.canvasEventAvailable ? '#22d3ee' : status.running ? '#f0b429' : '#64748b'
  return (
    <span
      className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-black/60"
      style={{ background: color, boxShadow: status.canvasEventAvailable ? `0 0 8px ${color}` : 'none' }}
    />
  )
}

const dglabEnabled = () => isPluginEnabled('dglab')
const chromaEnabled = () => isPluginEnabled('chroma')
const signalRgbEnabled = () => isPluginEnabled('signalrgb')
const openSignalRgbConsole = () => openPluginConsole('signalrgb')

export default function PluginShortcuts({ variant, playerTheme = 'dark' }: PluginShortcutsProps) {
  const showDglab = dglabEnabled()
  const showChroma = chromaEnabled()
  const showSignalRgb = signalRgbEnabled()

  const pillCls = `relative p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`
  const pillIcon = `w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`

  if (variant === 'home') {
    // 主页小药丸：渐变圆钮家族；插件快捷按钮在插件系统按钮左侧
    return (
      <>
        {showSignalRgb && (
          <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }} onClick={openSignalRgbConsole}
            title="SignalRGB 控制台" className="relative p-3 rounded-full bg-gradient-to-r from-cyan-400/90 via-fuchsia-500/90 to-amber-400/90 text-black shadow-lg ring-1 ring-cyan-200/45">
            <RadioTower className="w-5 h-5" /><SignalRgbStatusDot show />
          </motion.button>
        )}
        {showChroma && (
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
            onClick={openChromaConsole}
            title="Razer Chroma 控制台"
            className="relative p-3 rounded-full bg-[#44D62C]/85 hover:bg-[#44D62C] text-black transition-all shadow-lg ring-1 ring-[#8cff72]/50"
          >
            <Lightbulb className="w-5 h-5" />
            <ChromaStatusDot show />
          </motion.button>
        )}
        {showDglab && (
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
            onClick={openDGLabConsole}
            title="DG-LAB 控制台"
            className="relative p-3 rounded-full bg-gradient-to-r from-amber-500/90 to-orange-600/90 hover:from-amber-500 hover:to-orange-600 text-white transition-all shadow-lg ring-1 ring-amber-300/40"
          >
            <Zap className="w-5 h-5" />
            <DGLabStatusDot show />
          </motion.button>
        )}
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          onClick={openPluginCenter}
          title="插件系统"
          className="p-3 rounded-full bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-500 hover:to-orange-600 text-white transition-all shadow-lg"
        >
          <Blocks className="w-5 h-5" />
        </motion.button>
      </>
    )
  }

  if (variant === 'desktop') {
    return (
      <>
        {showSignalRgb && (
          <motion.button whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.95 }} onClick={openSignalRgbConsole}
            title="SignalRGB 控制台" className="relative rounded-full flex items-center justify-center transition-all"
            style={{ width: '48px', height: '48px', background: 'rgba(34,211,238,0.15)', border: '1px solid rgba(217,70,239,0.38)' }}>
            <RadioTower className="w-5 h-5 text-cyan-300" /><SignalRgbStatusDot show />
          </motion.button>
        )}
        {showChroma && (
          <motion.button
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.95 }}
            onClick={openChromaConsole}
            title="Razer Chroma 控制台"
            className="relative rounded-full flex items-center justify-center transition-all"
            style={{ width: '48px', height: '48px', background: 'rgba(68,214,44,0.16)', border: '1px solid rgba(68,214,44,0.4)' }}
          >
            <Lightbulb className="w-5 h-5 text-[#72f05d]" />
            <ChromaStatusDot show />
          </motion.button>
        )}
        {showDglab && (
          <motion.button
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.95 }}
            onClick={openDGLabConsole}
            title="DG-LAB 控制台"
            className="relative rounded-full flex items-center justify-center transition-all"
            style={{
              width: '48px',
              height: '48px',
              background: 'rgba(240,180,41,0.16)',
              border: '1px solid rgba(240,180,41,0.4)',
              boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
            }}
          >
            <Zap className="w-5 h-5 text-amber-300" />
            <DGLabStatusDot show />
          </motion.button>
        )}
        <motion.button
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.95 }}
          onClick={openPluginCenter}
          title="插件系统"
          className="relative rounded-full flex items-center justify-center transition-all"
          style={{
            width: '48px',
            height: '48px',
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.1), inset 0 1px 0 rgba(255,255,255,0.2)',
          }}
        >
          <Blocks className="w-5 h-5 text-white" />
        </motion.button>
      </>
    )
  }

  if (variant === 'explore') {
    return (
      <>
        {showSignalRgb && (
          <button type="button" onClick={openSignalRgbConsole}
            className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan-300/30 bg-cyan-300/10 text-cyan-200 transition hover:bg-fuchsia-400/15"
            aria-label="SignalRGB 控制台" title="SignalRGB 控制台">
            <RadioTower className="h-[18px] w-[18px]" /><SignalRgbStatusDot show />
          </button>
        )}
        {showChroma && (
          <button
            type="button"
            onClick={openChromaConsole}
            className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-[#44D62C]/30 bg-[#44D62C]/10 text-[#72f05d] transition hover:bg-[#44D62C]/20"
            aria-label="Razer Chroma 控制台"
            title="Razer Chroma 控制台"
          >
            <Lightbulb className="h-[18px] w-[18px]" />
            <ChromaStatusDot show />
          </button>
        )}
        {showDglab && (
          <button
            type="button"
            onClick={openDGLabConsole}
            className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-amber-400/30 bg-amber-400/10 text-amber-300/90 transition hover:bg-amber-400/20 hover:text-amber-200"
            aria-label="DG-LAB 控制台"
            title="DG-LAB 控制台"
          >
            <Zap className="h-[18px] w-[18px]" />
            <DGLabStatusDot show />
          </button>
        )}
        <button
          type="button"
          onClick={openPluginCenter}
          className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.045] text-white/58 transition hover:bg-white/[0.1] hover:text-white"
          aria-label="插件系统"
          title="插件系统"
        >
          <Blocks className="h-[18px] w-[18px]" />
        </button>
      </>
    )
  }

  // pill（简约模式底部药丸 / 沉浸药丸右侧簇）
  return (
    <>
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        onClick={openPluginCenter}
        title="插件系统"
        className={pillCls}
      >
        <Blocks className={pillIcon} />
      </motion.button>
      {showSignalRgb && (
        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }} onClick={openSignalRgbConsole}
          title="SignalRGB 控制台" className={`relative p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}>
          <RadioTower className={`${pillIcon} text-cyan-400`} /><SignalRgbStatusDot show />
        </motion.button>
      )}
      {showChroma && (
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          onClick={openChromaConsole}
          title="Razer Chroma 控制台"
          className={`relative p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
        >
          <Lightbulb className={`${pillIcon} text-[#44D62C]`} />
          <ChromaStatusDot show />
        </motion.button>
      )}
      {showDglab && (
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          onClick={openDGLabConsole}
          title="DG-LAB 控制台"
          className={`relative p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
        >
          <Zap className={`${pillIcon} text-amber-400`} />
          <DGLabStatusDot show />
        </motion.button>
      )}
    </>
  )
}