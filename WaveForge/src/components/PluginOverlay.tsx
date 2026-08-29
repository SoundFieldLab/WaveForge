/**
 * 插件系统全局挂载层：在 App 中只渲染一次。
 * - 导入内置 DG_LAB 插件（模块副作用注册）；
 * - 按宿主状态渲染：使用须知 / 插件中心 / 详情 / 导入 / DG_LAB 控制台；
 * - 启动「启用状态 → 生命周期回调」桥接（导入插件的 onEnable/onDisable）。
 */

import { useEffect } from 'react'
import '../plugins/DGLabPlugin'
import { getAllPluginManifests, getPluginRuntime, buildPluginContext } from '../plugins/registry'
import { getGlobalAudioAnalyzerStore } from '../plugins/clients/DGLabClient'
import {
  resolveNotice,
  usePluginHostState,
  isPluginEnabled,
  PLUGIN_STATE_EVENT,
} from '../services/pluginStore'
import PluginNoticeModal from './PluginNoticeModal'
import PluginCenterModal from './PluginCenterModal'
import PluginDetailModal from './PluginDetailModal'
import PluginImportModal from './PluginImportModal'
import DGLabConsoleModal from './DGLabConsoleModal'
import DGLabWidget from './DGLabWidget'
import DglabSystemCaptureBridge from './DglabSystemCaptureBridge'

// 启用状态 → 生命周期桥接：监听 wf_plugins 变更，按需调用 onEnable/onDisable
function useRuntimeBridge() {
  useEffect(() => {
    const previous = new Map<string, boolean>()
    const sync = () => {
      for (const manifest of getAllPluginManifests()) {
        const enabled = isPluginEnabled(manifest.id)
        const wasEnabled = previous.get(manifest.id) ?? false
        if (enabled === wasEnabled) continue
        previous.set(manifest.id, enabled)
        const runtime = getPluginRuntime(manifest.id)
        if (!runtime) continue
        if (enabled) {
          void runtime.onEnable?.(buildPluginContext({
            audio: {
              subscribe: (listener) => {
                const store = getGlobalAudioAnalyzerStore()
                if (!store) return () => undefined
                return store.subscribe(() => listener(store.getSnapshot()))
              },
            },
            storage: {
              get: (key) => localStorage.getItem(key),
              set: (key, value) => localStorage.setItem(key, value),
            },
            toast: (message, type) => {
              window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type: type ?? 'info' } }))
            },
            log: (...args) => console.log('[插件]', ...args),
          }))
        } else {
          void runtime.onDisable?.()
        }
      }
    }
    sync()
    window.addEventListener(PLUGIN_STATE_EVENT, sync)
    return () => {
      window.removeEventListener(PLUGIN_STATE_EVENT, sync)
      // 卸载时复位缓存
      previous.clear()
    }
  }, [])
}

export default function PluginOverlay() {
  const host = usePluginHostState()
  useRuntimeBridge()

  return (
    <>
      <PluginNoticeModal
        open={Boolean(host.notice)}
        pluginId={host.notice?.pluginId ?? ''}
        kind={host.notice?.kind ?? 'view'}
        onResolve={resolveNotice}
      />
      <PluginCenterModal />
      <PluginDetailModal />
      <PluginImportModal />
      <DGLabConsoleModal />
      {/* 常驻悬浮小组件（自管理显示条件：插件启用 + 常驻开关） */}
      <DGLabWidget />
      {/* 整机监听全局桥（监听系统扬声器；失败自动回退 + 监听中浮标） */}
      <DglabSystemCaptureBridge />
    </>
  )
}