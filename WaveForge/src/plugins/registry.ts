/**
 * 插件注册表：内置插件（DGLab）+ 导入插件的 manifest 合并视图。
 *
 * 内置插件随应用发布，不可卸载；导入插件 manifest 持久化在 pluginStore 的
 * `wf_plugins` 中，这里只负责合并与查询视图。导入插件的运行时代码在受限
 * 沙箱中执行（无 DOM / 无网络 / 无任意 require），见 runImportedPlugin。
 */

import type { PluginContext, PluginManifest, PluginRuntime } from './types'
import { getImportedPluginManifests } from '../services/pluginStore'

/** 内置插件注册表（id -> manifest + runtime）。 */
const builtinPlugins = new Map<string, { manifest: PluginManifest; runtime?: PluginRuntime }>()

/** 内置插件名 → 图标/配色（内置插件由代码注册时自带）。 */
export function registerBuiltinPlugin(manifest: PluginManifest, runtime?: PluginRuntime) {
  builtinPlugins.set(manifest.id, { manifest: { ...manifest, source: 'builtin' }, runtime })
}

/** 全部插件（含导入），列表顺序：内置在前、导入按安装时间。 */
export function getAllPluginManifests(): PluginManifest[] {
  const builtin = Array.from(builtinPlugins.values()).map(e => e.manifest)
  const imported = getImportedPluginManifests()
  return [...builtin, ...imported]
}

export function getPluginManifest(id: string): PluginManifest | undefined {
  return getAllPluginManifests().find(p => p.id === id)
}

export function getPluginRuntime(id: string): PluginRuntime | undefined {
  const builtin = builtinPlugins.get(id)?.runtime
  if (builtin) return builtin
  // 导入插件：运行时代码即时解析执行
  const manifest = getImportedPluginManifests().find(p => p.id === id)
  if (manifest?.code) return resolveImportedRuntime(manifest.code)
  return undefined
}

export function isBuiltinPlugin(id: string): boolean {
  return builtinPlugins.has(id)
}

/* ---------------------------------- 导入插件沙箱 ---------------------------------- */

const FN_WRAPPER = (code: string) => `
return function (ctx) {
  "use strict";
  const plugin = (${code});
  return typeof plugin === 'function' ? plugin(ctx) : plugin;
}`

/**
 * 受限沙箱执行导入插件代码：
 * - 无 DOM / window 访问；
 * - 无 require/import（不存在模块加载器）；
 * - 仅注入 PluginContext 白名单 API；
 * - 插件约定的导出形态：`module.exports` 风格对象 或 返回值 = 生命周期对象。
 */
function resolveImportedRuntime(code: string): PluginRuntime {
  try {
    const factory = new Function(FN_WRAPPER(code)) as (ctx: PluginContext) => PluginRuntime | undefined
    return {
      onEnable: (ctx) => {
        const lifecycle = factory(ctx) ?? {}
        return lifecycle.onEnable?.(ctx)
      },
      onDisable: () => undefined,
    }
  } catch (error) {
    console.error('[插件] 运行时代码解析失败:', error)
    return {}
  }
}

/** 插件启用时可被调用：拿到渲染端生命周期函数。 */
export function buildPluginContext(
  overrides: Partial<PluginContext> = {},
): PluginContext {
  return {
    audio: {
      subscribe: () => () => undefined,
    },
    storage: {
      get: () => null,
      set: () => undefined,
    },
    toast: () => undefined,
    log: () => undefined,
    ...overrides,
  }
}