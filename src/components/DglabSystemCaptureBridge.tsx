/**
 * DG-LAB 整机监听全局桥（挂载在 PluginOverlay 中，插件启用才活跃）。
 * - 设置「整机监听」开启且插件启用时，直接捕获系统扬声器声音（桌面版直抓 / 浏览器共享屏幕）；
 * - 捕获失败：自动回退开关 + toast 说明（避免反复拉起系统授权框）；
 * - 捕获成功：右下角浮现金色徽标「整机监听 · 系统声音」，点击打开控制台。
 */

import { useEffect, useState } from 'react'
import { AudioWaveform } from 'lucide-react'
import { useSystemAudioCapture } from '../hooks/useSystemAudioCapture'
import { loadDGLabSettings, saveDGLabSettings, DGLAB_SETTINGS_EVENT } from '../plugins/clients/DGLabClient'
import { isPluginEnabled, PLUGIN_STATE_EVENT, openDGLabConsole } from '../services/pluginStore'

const GOLD = '#FFE89C'

export default function DglabSystemCaptureBridge() {
  const [captureOn, setCaptureOn] = useState(() => Boolean(loadDGLabSettings().systemCapture))
  const [pluginActive, setPluginActive] = useState(() => isPluginEnabled('dglab'))
  const capture = useSystemAudioCapture(captureOn && pluginActive)

  useEffect(() => {
    const onSettings = () => setCaptureOn(Boolean(loadDGLabSettings().systemCapture))
    const onPlugin = () => setPluginActive(isPluginEnabled('dglab'))
    window.addEventListener(DGLAB_SETTINGS_EVENT, onSettings)
    window.addEventListener(PLUGIN_STATE_EVENT, onPlugin)
    return () => {
      window.removeEventListener(DGLAB_SETTINGS_EVENT, onSettings)
      window.removeEventListener(PLUGIN_STATE_EVENT, onPlugin)
    }
  }, [])

  // 捕获失败：自动回退开关（避免循环拉起授权）并提示
  useEffect(() => {
    if (!capture.error) return
    saveDGLabSettings({ systemCapture: false })
    window.dispatchEvent(new CustomEvent('showToast', {
      detail: { message: `整机监听未生效：${capture.error}`, type: 'error', duration: 5000 },
    }))
  }, [capture.error])

  if (!capture.captured) return null
  return (
    <button
      type="button"
      onClick={() => openDGLabConsole()}
      title="整机监听：正在监听系统扬声器（本软件之外的声音也会映射成波形）。点击打开 DG-LAB 控制台。"
      className="fixed bottom-4 right-4 z-[9999] flex items-center gap-2 rounded-full px-3.5 py-2 text-[11px] font-medium shadow-lg transition-transform hover:scale-105"
      style={{ background: 'rgba(11,11,14,0.92)', color: GOLD, border: `1px solid ${GOLD}55` }}
    >
      <span className="relative flex w-2 h-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: GOLD }} />
        <span className="relative inline-flex rounded-full w-2 h-2" style={{ background: GOLD }} />
      </span>
      <AudioWaveform className="w-3.5 h-3.5" />
      整机监听 · 系统声音
    </button>
  )
}