/**
 * 插件系统全局挂载层：在 App 中只渲染一次。
 * - 导入内置 DG_LAB 插件（模块副作用注册）；
 * - 按宿主状态渲染：使用须知 / 插件中心 / 详情 / 导入 / DG_LAB 控制台；
 * - 启动「启用状态 → 生命周期回调」桥接（导入插件的 onEnable/onDisable）。
 */

import { useEffect } from 'react'
import '../plugins/DGLabPlugin'
import '../plugins/ChromaPlugin'
import '../plugins/SignalRgbPlugin'
import { getAllPluginManifests, getPluginRuntime, buildPluginContext } from '../plugins/registry'
import { getGlobalAudioAnalyzerStore } from '../plugins/clients/DGLabClient'
import {
  resolveNotice,
  usePluginHostState,
  isPluginEnabled,
  PLUGIN_STATE_EVENT,
  closePluginConsole,
} from '../services/pluginStore'
import PluginNoticeModal from './PluginNoticeModal'
import PluginCenterModal from './PluginCenterModal'
import PluginDetailModal from './PluginDetailModal'
import PluginImportModal from './PluginImportModal'
import DGLabConsoleModal from './DGLabConsoleModal'
import ChromaConsoleModal from './ChromaConsoleModal'
import SignalRgbConsoleModal from './SignalRgbConsoleModal'
import DGLabWidget from './DGLabWidget'
import DglabSystemCaptureBridge from './DglabSystemCaptureBridge'

// 启用状态 → 生命周期桥接：监听 wf_plugins 变更，按需调用 onEnable/onDisable
function useRuntimeBridge() {
  useEffect(() => {
    const previous = new Map<string, boolean>()
    const generations = new Map<string, number>()
    const queues = new Map<string, Promise<void>>()
    const enqueue = (pluginId: string, task: () => void | Promise<void>) => {
      const previousTask = queues.get(pluginId) ?? Promise.resolve()
      const nextTask = previousTask.catch(() => undefined).then(task).catch(error => {
        console.error(`[插件:${pluginId}] 生命周期执行失败:`, error)
      })
      queues.set(pluginId, nextTask)
    }
    const sync = () => {
      for (const manifest of getAllPluginManifests()) {
        const enabled = isPluginEnabled(manifest.id)
        const wasEnabled = previous.get(manifest.id) ?? false
        if (enabled === wasEnabled) continue
        previous.set(manifest.id, enabled)
        const runtime = getPluginRuntime(manifest.id)
        if (!runtime) continue
        const generation = (generations.get(manifest.id) ?? 0) + 1
        generations.set(manifest.id, generation)
        const context = buildPluginContext({
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
        })
        enqueue(manifest.id, async () => {
          if (generations.get(manifest.id) !== generation) return
          if (enabled) await runtime.onEnable?.(context)
          else await runtime.onDisable?.()
        })
      }
    }
    sync()
    window.addEventListener(PLUGIN_STATE_EVENT, sync)
    return () => {
      window.removeEventListener(PLUGIN_STATE_EVENT, sync)
      for (const manifest of getAllPluginManifests()) {
        if (!previous.get(manifest.id)) continue
        const runtime = getPluginRuntime(manifest.id)
        if (!runtime?.onDisable) continue
        const generation = (generations.get(manifest.id) ?? 0) + 1
        generations.set(manifest.id, generation)
        enqueue(manifest.id, () => runtime.onDisable?.())
      }
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
      <ChromaConsoleModal />
      <SignalRgbConsoleModal
        open={host.activeConsolePluginId === 'signalrgb'}
        onClose={() => closePluginConsole('signalrgb')}
      />
      {/* 常驻悬浮小组件（自管理显示条件：插件启用 + 常驻开关） */}
      <DGLabWidget />
      {/* 整机监听全局桥（监听系统扬声器；失败自动回退 + 监听中浮标） */}
      <DglabSystemCaptureBridge />
    </>
  )
}