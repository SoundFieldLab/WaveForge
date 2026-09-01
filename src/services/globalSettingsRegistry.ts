/**
 * 全局设置注册表（设置镜像机制的核心）
 *
 * 背景 WaveForge 的功能开关一直只在简约模式的 SettingsPanel 里开发，
 * 传统/探索/桌面模式的设置页只有"当前模式个性化"，用户常用的功能开关在其他模式里无处可调。
 *
 * 本模块把"整软件真正全局的设置"（源自 SettingsPanel 的存储键 / 服务 / 事件）
 * 声明式地登记成一张注册表：
 * 1. 每个条目的 read/write 与 SettingsPanel 完全同源（同一 localStorage 键、同一自定义事件、同一互斥逻辑），
 *    所以在任何模式里改动，简约模式与其他模式读到的是同一份状态 —— 设置天然同步；
 * 2. 各模式的设置 UI（components/MirroredGlobalSettings.tsx）按各自的设计语言渲染这张表，
 *    不照搬简约模式的 UI。后续在简约模式新增的全局功能，只要在这里登记一条，
 *    所有模式的设置界面会自动出现该开关，无需重复开发。
 *
 * 模式私有设置（如传统模式的布局/背景、探索页板块排序、桌面组件）不进注册表，
 * 仍由各自的偏好存储管理；简约模式专属的"自定义首页显示内容"也不镜像。
 */
import { useEffect, useMemo, useState } from 'react'
import { parseStoredBoolean } from '../utils/storage'
import {
  loadPlaybackShortcutSettings,
  savePlaybackShortcutSettings,
  PLAYBACK_SHORTCUT_SETTINGS_EVENT,
  type PlaybackShortcutSettings,
} from './playbackShortcutSettings'
import { getVersionDisplay } from './versionInfo'
import packageInfo from '../../package.json'
import type { DesktopLyricsColorMode, DesktopLyricsSettings, TaskbarWidgetSettings } from '../electron'

// ─────────────────────────── 类型 ───────────────────────────

export type SettingValue = boolean | string | number

export type GlobalSettingsGroupId =
  | 'general'      // 常规（主题 / 主题色 / 更新）
  | 'playback'     // 播放与过渡
  | 'lyrics'       // 歌词
  | 'shortcuts'    // 快捷键与播放提示
  | 'desktop'      // 桌面集成（桌面歌词 / 播放器 / 任务栏 / 窗口）
  | 'performance'  // 性能
  | 'network'      // 网络与代理
  | 'advanced'     // 高级
  | 'about'        // 关于

export type MirrorActionId =
  | 'audio-quality'   // 打开"各平台播放音质"弹窗（各模式自备弹窗挂载）
  | 'cache-clear'     // 打开缓存清理弹窗
  | 'remote-settings' // 打开遥控器个性化弹窗
  | 'check-update'    // 检查更新（注册表内实现）
  | 'proxy-rescan'    // 重新扫描代理（注册表内实现）

export type SettingControl =
  | { kind: 'toggle' }
  | { kind: 'choice'; options: Array<{ value: string; label: string; hint?: string }> }
  | { kind: 'slider'; min: number; max: number; step: number; unit?: string }
  | { kind: 'action'; actionId: MirrorActionId }
  /** 字体选择器：推荐字体 + 内置字体 + 本机字体（下拉面板由渲染器绘制） */
  | { kind: 'font-picker' }

export interface GlobalSettingEntry {
  id: string
  label: string
  description?: string
  control: SettingControl
  /** 同步读取当前值（异步来源走注册表内部缓存） */
  read: () => SettingValue
  /** 写入：必须与 SettingsPanel 同键同事件，保证双端同步 */
  write?: (value: SettingValue) => void
  /** 环境不满足时整个条目隐藏（如无 Electron 桥接的桌面功能） */
  available?: () => boolean
  /** 依赖其他开关时隐藏（如 crossfade 时长仅在开启渐入渐出后显示） */
  visibleIf?: () => boolean
}

export interface GlobalSettingsGroup {
  id: GlobalSettingsGroupId
  label: string
  description?: string
  entries: GlobalSettingEntry[]
}

// ─────────────────────────── 基础工具 ───────────────────────────

export const GLOBAL_SETTING_CHANGED_EVENT = 'waveforge:global-setting-changed'

/** 通知所有镜像界面重读注册表（镜像 UI 互相同步；简约模式在挂载时重读，同样生效） */
export function notifyGlobalSettingChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(GLOBAL_SETTING_CHANGED_EVENT))
}

export function toast(message: string, type: 'success' | 'error' | 'info' = 'success'): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type } }))
}

const readBool = (key: string, fallback: boolean) =>
  parseStoredBoolean(typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null, fallback)

const readStr = (key: string, fallback: string) =>
  (typeof localStorage !== 'undefined' && localStorage.getItem(key)) || fallback

const readNum = (key: string, fallback: number) => {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  const parsed = raw !== null ? Number(raw) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

const writeBool = (key: string, value: boolean) => localStorage.setItem(key, JSON.stringify(value))

// ─────────────────────────── Electron 依赖设置的内存缓存 ───────────────────────────
// 桌面歌词/桌面播放器/任务栏/Wallpaper 等设置真身在主进程，读数是异步的。
// 注册表维护一份缓存：镜像界面挂载时 ensureDesktopBridgeSettings() 拉取并触发重渲染，
// 之后 read() 同步返回缓存值，write() 乐观更新 + 调 IPC（与 SettingsPanel 行为一致）。

interface DesktopBridgeCache {
  loaded: boolean
  desktopLyrics: DesktopLyricsSettings
  desktopPlayer: { enabled: boolean; form: 'card' | 'bar' }
  taskbarWidget: TaskbarWidgetSettings
  gpu: { acceleration: boolean; preference: 'auto' | 'discrete' | 'integrated' }
  highRefresh: { enabled: boolean; hz: number | null }
  proxy: { enabled: boolean; scanning: boolean; target: string | null }
}

const electron = () => (typeof window !== 'undefined' ? (window as any).electron : undefined)

const desktopCache: DesktopBridgeCache = {
  loaded: false,
  desktopLyrics: {
    enabled: false, fontSize: 58, fontFamily: '', colorMode: 'auto', orientation: 'horizontal',
    doubleLine: false, translationEnabled: false, romajiEnabled: false, traditionalEnabled: false, locked: false,
  },
  desktopPlayer: { enabled: false, form: 'card' },
  taskbarWidget: {
    enabled: false, position: 'right', width: 340, mode: 'normal', darken: false, darkenLevel: 0.5, hideControls: false,
  },
  gpu: { acceleration: readBool('gpuAcceleration', true), preference: 'auto' },
  highRefresh: { enabled: false, hz: null },
  proxy: { enabled: false, scanning: false, target: null },
}

let desktopBridgeLoading = false

/** 拉取 Electron 侧设置到缓存（幂等，可安全地在挂载 effect 里调用） */
export function ensureDesktopBridgeSettings(): void {
  if (desktopBridgeLoading || typeof window === 'undefined') return
  const api = electron()
  if (!api) return
  desktopBridgeLoading = true
  const jobs: Array<Promise<unknown>> = []
  if (api.desktopLyrics?.getSettings) {
    jobs.push(api.desktopLyrics.getSettings().then((s: DesktopLyricsSettings) => {
      if (s) desktopCache.desktopLyrics = s
    }).catch(() => undefined))
  }
  if (api.desktopPlayer?.getInitialState) {
    jobs.push(api.desktopPlayer.getInitialState().then((s: any) => {
      desktopCache.desktopPlayer = { enabled: Boolean(s?.enabled), form: s?.form === 'bar' ? 'bar' : 'card' }
    }).catch(() => undefined))
  }
  if (api.taskbarWidget?.getSettings) {
    jobs.push(api.taskbarWidget.getSettings().then((s: TaskbarWidgetSettings) => {
      if (s) desktopCache.taskbarWidget = s
    }).catch(() => undefined))
  }
  if (api.system?.getHardwareAcceleration) {
    jobs.push(api.system.getHardwareAcceleration().then((r: any) => {
      if (r) {
        desktopCache.gpu = { acceleration: Boolean(r.enabled), preference: r.gpuPreference || 'auto' }
        localStorage.setItem('gpuAcceleration', JSON.stringify(Boolean(r.enabled)))
      }
    }).catch(() => undefined))
  }
  if (api.display?.getInfo) {
    jobs.push(api.display.getInfo().then((info: any) => {
      if (info) desktopCache.highRefresh = { enabled: Boolean(info.highRefreshEnabled), hz: info.highRefreshHz ?? null }
    }).catch(() => undefined))
  }
  if (api.proxyManager?.getState) {
    jobs.push(api.proxyManager.getState().then((s: any) => {
      if (s) desktopCache.proxy = { ...desktopCache.proxy, enabled: Boolean(s.enabled), target: s.proxy ? `127.0.0.1:${s.proxy.port}` : null }
    }).catch(() => undefined))
  }
  void Promise.all(jobs).then(() => {
    desktopCache.loaded = true
    desktopBridgeLoading = false
    notifyGlobalSettingChanged()
  })
}

// 桌面播放器/桌面歌词被小窗关闭时，主进程会广播事件 → 同步缓存
if (typeof window !== 'undefined') {
  window.addEventListener('desktopPlayerEnabledChanged', (event) => {
    desktopCache.desktopPlayer.enabled = Boolean((event as CustomEvent<boolean>).detail)
    notifyGlobalSettingChanged()
  })
  window.addEventListener('desktopLyricsEnabledChanged', (event) => {
    desktopCache.desktopLyrics = { ...desktopCache.desktopLyrics, enabled: Boolean((event as CustomEvent<boolean>).detail) }
    notifyGlobalSettingChanged()
  })
}

const hasDesktopLyricsBridge = () => typeof window !== 'undefined' && typeof electron()?.desktopLyrics?.getSettings === 'function'
const hasDesktopPlayerBridge = () => typeof window !== 'undefined' && typeof electron()?.desktopPlayer?.getInitialState === 'function'
const hasTaskbarBridge = () => typeof window !== 'undefined' && !!electron()?.taskbarWidget
const hasSystemBridge = () => typeof window !== 'undefined' && !!electron()?.system?.getHardwareAcceleration
const hasDisplayBridge = () => typeof window !== 'undefined' && !!electron()?.display?.getInfo
const hasProxyBridge = () => typeof window !== 'undefined' && !!electron()?.proxyManager

// ─────────────────────────── 各域写入逻辑（与 SettingsPanel 逐一对齐） ───────────────────────────

// 播放过渡三开关互斥：开启其一则关闭另外两个
const setTransitionModeExclusive = (target: 'crossfade' | 'gapless' | 'autoMix', value: boolean) => {
  const keys = {
    crossfade: 'crossfadeEnabled',
    gapless: 'gaplessEnabled',
    autoMix: 'autoMixEnabled',
  } as const
  const events = {
    crossfade: 'crossfadeSettingsChanged',
    gapless: 'gaplessSettingsChanged',
    autoMix: 'autoMixSettingsChanged',
  } as const
  if (value) {
    for (const mode of ['crossfade', 'gapless', 'autoMix'] as const) {
      if (mode === target) continue
      writeBool(keys[mode], false)
      window.dispatchEvent(new Event(events[mode]))
    }
  }
  writeBool(keys[target], value)
  window.dispatchEvent(new Event(events[target]))
  notifyGlobalSettingChanged()
}

// 快捷键（服务自带存储 + 事件）
let playbackShortcuts: PlaybackShortcutSettings | null = null
const shortcutSettings = () => {
  if (!playbackShortcuts) playbackShortcuts = loadPlaybackShortcutSettings()
  return playbackShortcuts
}
const writeShortcuts = (patch: Partial<PlaybackShortcutSettings>) => {
  playbackShortcuts = savePlaybackShortcutSettings(patch)
  notifyGlobalSettingChanged()
}

// 桌面歌词
const updateDesktopLyrics = (partial: Partial<DesktopLyricsSettings>) => {
  desktopCache.desktopLyrics = { ...desktopCache.desktopLyrics, ...partial }
  void electron()?.desktopLyrics?.updateSettings?.(partial)
    .then((result: DesktopLyricsSettings | undefined) => {
      if (result) desktopCache.desktopLyrics = result
      notifyGlobalSettingChanged()
    })
    .catch(() => notifyGlobalSettingChanged())
}

// 任务栏迷你播控
const updateTaskbarWidget = (partial: Partial<TaskbarWidgetSettings>) => {
  desktopCache.taskbarWidget = { ...desktopCache.taskbarWidget, ...partial }
  void electron()?.taskbarWidget?.updateSettings?.(partial)
    .then((result: TaskbarWidgetSettings | undefined) => {
      if (result) desktopCache.taskbarWidget = result
      notifyGlobalSettingChanged()
    })
    .catch(() => notifyGlobalSettingChanged())
}

// 代理自动配置（扫描本地端口 → 自动选最优）
const proxyScanAndEnable = (rescan: boolean) => {
  desktopCache.proxy.scanning = true
  notifyGlobalSettingChanged()
  void (async () => {
    try {
      const list = await electron()?.proxyManager?.scan?.()
      const found = list || []
      if (found.length > 0) {
        const best = found[0]
        const state = await electron()?.proxyManager?.enable?.(best.port)
        desktopCache.proxy = {
          enabled: true,
          scanning: false,
          target: state?.proxy ? `127.0.0.1:${state.proxy.port}` : `127.0.0.1:${best.port}`,
        }
        toast(rescan ? `已切换代理 ${desktopCache.proxy.target}（延迟 ${best.latency}ms）` : `已自动配置代理 ${desktopCache.proxy.target}（延迟 ${best.latency}ms）`)
      } else {
        desktopCache.proxy = { enabled: rescan ? desktopCache.proxy.enabled : false, scanning: false, target: null }
        toast(rescan ? '未检测到可用的本地代理' : '未检测到可用的本地代理，请确认代理软件已开启', 'error')
      }
    } catch {
      desktopCache.proxy = { ...desktopCache.proxy, scanning: false }
      toast('代理扫描失败', 'error')
    }
    notifyGlobalSettingChanged()
  })()
}

// 检查更新：多源清单 → 比版本 → 有更新交给全局 UpdateManager 弹详情
const checkForUpdate = () => {
  void (async () => {
    try {
      const nativeBridge = (window as any).WaveForgeNative
      if (nativeBridge?.checkForUpdates) {
        nativeBridge.checkForUpdates()
        toast('已开始检查，如有新版本将弹出提示', 'info')
        return
      }
      const { UPDATE_MANIFEST_URLS, withDownloadProxies } = await import('./updateConstants')
      let manifest: { version?: string; notes?: string; artifacts?: Record<string, { urls?: string[]; sha256?: string }> } | null = null
      for (const url of UPDATE_MANIFEST_URLS) {
        try {
          const res = await fetch(url, { cache: 'no-store' })
          if (res.ok) { manifest = await res.json(); break }
        } catch { /* 换下一个源 */ }
      }
      const remoteVersion = String(manifest?.version || '')
      if (!remoteVersion) { toast('更新清单不可用，请检查网络', 'error'); return }
      const parse = (value: string) => value.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(part => Number(part) || 0)
      const cmp = (a: string, b: string) => {
        const pa = parse(a); const pb = parse(b)
        for (let i = 0; i < 3; i += 1) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1 }
        return 0
      }
      if (cmp(remoteVersion, packageInfo.version) <= 0) {
        toast(`当前版本 ${getVersionDisplay(packageInfo.version)} 已是最新`)
        return
      }
      const winArtifact = manifest?.artifacts?.['win-x64']
      const hotArtifact = manifest?.artifacts?.['win-x64-hot']
      window.dispatchEvent(new CustomEvent('waveforge:update-open-details', {
        detail: {
          version: remoteVersion,
          notes: manifest?.notes || '',
          hotUrls: hotArtifact?.urls?.[0] ? withDownloadProxies(hotArtifact.urls[0]) : undefined,
          hotSha: hotArtifact?.sha256 || '',
          installUrls: winArtifact?.urls?.[0] ? withDownloadProxies(winArtifact.urls[0]) : undefined,
          installSha: winArtifact?.sha256 || '',
        },
      }))
    } catch {
      toast('检查更新失败，请检查网络', 'error')
    }
  })()
}

// ─────────────────────────── 注册表 ───────────────────────────

const presetAccentColors = [
  { value: '#3B82F6', label: '天空蓝' },
  { value: '#10B981', label: '翡翠绿' },
  { value: '#8B5CF6', label: '紫罗兰' },
  { value: '#EC4899', label: '玫瑰红' },
  { value: '#F59E0B', label: '橙黄色' },
  { value: '#EF4444', label: '珊瑚红' },
  { value: '#06B6D4', label: '青色' },
  { value: '#64748B', label: '石板灰' },
]

export const GLOBAL_SETTINGS_GROUPS: GlobalSettingsGroup[] = [
  {
    id: 'general',
    label: '常规',
    description: '外观主题与强调色，对所有模式生效',
    entries: [
      {
        id: 'playerTheme',
        label: '外观主题',
        description: '深色 / 浅色全局主题，与播放页快捷设置实时同步',
        control: {
          kind: 'choice',
          options: [
            { value: 'dark', label: '深色' },
            { value: 'light', label: '浅色' },
          ],
        },
        read: () => readStr('playerTheme', 'dark'),
        write: (value) => {
          localStorage.setItem('playerTheme', String(value))
          window.dispatchEvent(new CustomEvent('playerThemeChanged', { detail: value }))
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'accentColor',
        label: '主题色',
        description: '全局强调色，按钮 / 开关 / 高亮统一跟随',
        control: { kind: 'choice', options: presetAccentColors },
        read: () => readStr('accentColor', '#3B82F6'),
        write: (value) => {
          localStorage.setItem('accentColor', String(value))
          window.dispatchEvent(new CustomEvent('accentColorChanged', { detail: value }))
          notifyGlobalSettingChanged()
        },
      },
    ],
  },
  {
    id: 'playback',
    label: '播放',
    description: '歌曲衔接与视频行为，对所有模式的播放生效',
    entries: [
      {
        id: 'crossfadeEnabled',
        label: '渐入渐出 (Crossfade)',
        description: '两首歌之间交叉淡入淡出，与无缝衔接 / AutoMix 互斥',
        control: { kind: 'toggle' },
        read: () => readBool('crossfadeEnabled', false),
        write: (value) => setTransitionModeExclusive('crossfade', Boolean(value)),
      },
      {
        id: 'crossfadeDuration',
        label: '渐入渐出时长',
        control: { kind: 'slider', min: 1, max: 12, step: 0.5, unit: '秒' },
        read: () => readNum('crossfadeDuration', 4),
        write: (value) => {
          const duration = Math.max(1, Math.min(12, Number(value)))
          localStorage.setItem('crossfadeDuration', duration.toString())
          window.dispatchEvent(new Event('crossfadeSettingsChanged'))
          notifyGlobalSettingChanged()
        },
        visibleIf: () => readBool('crossfadeEnabled', false),
      },
      {
        id: 'gaplessEnabled',
        label: '无缝衔接 (Gapless)',
        description: '取消歌曲间过渡空隙，与渐入渐出 / AutoMix 互斥',
        control: { kind: 'toggle' },
        read: () => readBool('gaplessEnabled', false),
        write: (value) => setTransitionModeExclusive('gapless', Boolean(value)),
      },
      {
        id: 'albumGaplessEnabled',
        label: '专辑融合',
        description: '同一专辑内的歌曲以无缝方式衔接',
        control: { kind: 'toggle' },
        read: () => readBool('albumGaplessEnabled', true),
        write: (value) => {
          writeBool('albumGaplessEnabled', Boolean(value))
          window.dispatchEvent(new Event('albumGaplessSettingsChanged'))
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'autoMixEnabled',
        label: 'AutoMix 智能混音',
        description: '按歌曲节奏自动混音过渡，与渐入渐出 / 无缝衔接互斥',
        control: { kind: 'toggle' },
        read: () => readBool('autoMixEnabled', false),
        write: (value) => setTransitionModeExclusive('autoMix', Boolean(value)),
      },
      {
        id: 'autoMixBeatMatching',
        label: '节拍匹配',
        description: '对齐两首歌的 BPM 再做过渡',
        control: { kind: 'toggle' },
        read: () => readBool('autoMixBeatMatching', true),
        write: (value) => { writeBool('autoMixBeatMatching', Boolean(value)); window.dispatchEvent(new Event('autoMixSettingsChanged')); notifyGlobalSettingChanged() },
        visibleIf: () => readBool('autoMixEnabled', false),
      },
      {
        id: 'autoMixSkipSilence',
        label: '跳过首尾静音',
        control: { kind: 'toggle' },
        read: () => readBool('autoMixSkipSilence', true),
        write: (value) => { writeBool('autoMixSkipSilence', Boolean(value)); window.dispatchEvent(new Event('autoMixSettingsChanged')); notifyGlobalSettingChanged() },
        visibleIf: () => readBool('autoMixEnabled', false),
      },
      {
        id: 'autoMixTransitionIntensity',
        label: '过渡强度',
        control: {
          kind: 'choice',
          options: [
            { value: 'subtle', label: '轻柔' },
            { value: 'standard', label: '标准' },
            { value: 'strong', label: '强烈' },
          ],
        },
        read: () => readStr('autoMixTransitionIntensity', 'standard'),
        write: (value) => {
          localStorage.setItem('autoMixTransitionIntensity', String(value))
          window.dispatchEvent(new Event('autoMixSettingsChanged'))
          electron()?.automixLog?.('settings-toggle', `autoMixTransitionIntensity=${value}`).catch?.(() => undefined)
          notifyGlobalSettingChanged()
        },
        visibleIf: () => readBool('autoMixEnabled', false),
      },
      {
        id: 'autoMixEnhanced',
        label: 'AutoMix 增强版',
        description: '使用分轨混音（HTDemucs 可选）与增强 DSP；模型未安装时自动使用 DSP 兼容模式',
        control: { kind: 'toggle' },
        read: () => readBool('autoMixEnhanced', false),
        write: (value) => {
          writeBool('autoMixEnhanced', Boolean(value))
          window.dispatchEvent(new Event('autoMixSettingsChanged'))
          electron()?.automixLog?.('settings-toggle', `autoMixEnhanced=${value}`).catch?.(() => undefined)
          notifyGlobalSettingChanged()
        },
        visibleIf: () => readBool('autoMixEnabled', false),
      },
      {
        id: 'autoMixAiMix',
        label: 'DJTransGAN 实验扩展',
        description: '可选学习式推子/EQ与60秒长混音；关闭时不会启动 Torch，AutoMix 增强版仍正常工作',
        control: { kind: 'toggle' },
        read: () => readBool('autoMixAiMix', false),
        write: (value) => {
          writeBool('autoMixAiMix', Boolean(value))
          window.dispatchEvent(new Event('autoMixSettingsChanged'))
          electron()?.automixLog?.('settings-toggle', `autoMixAiMix=${value}`).catch?.(() => undefined)
          notifyGlobalSettingChanged()
        },
        visibleIf: () => readBool('autoMixEnabled', false) && readBool('autoMixEnhanced', false),
      },
      {
        id: 'videoEndBehavior',
        label: '视频播放完毕行为',
        description: 'MV 播放结束后的动作',
        control: {
          kind: 'choice',
          options: [
            { value: 'close', label: '不重播', hint: '显示重播按钮' },
            { value: 'replay', label: '自动重播', hint: '自动回到开头' },
            { value: 'next', label: '自动续播', hint: '播放下一个视频' },
          ],
        },
        read: () => readStr('videoEndBehavior', 'close'),
        write: (value) => {
          localStorage.setItem('videoEndBehavior', String(value))
          window.dispatchEvent(new CustomEvent('videoEndBehaviorChanged', { detail: value }))
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'audioQuality',
        label: '各平台播放音质',
        description: '按平台设置默认 / 最高音质偏好',
        control: { kind: 'action', actionId: 'audio-quality' },
        read: () => true,
      },
    ],
  },
  {
    id: 'lyrics',
    label: '歌词',
    description: '逐字 / 翻译 / 歌词来源，播放页与桌面歌词共用',
    entries: [
      {
        id: 'wordByWordLyrics',
        label: '逐字歌词',
        description: '优先使用逐字进度歌词（卡拉OK效果）',
        control: { kind: 'toggle' },
        read: () => readBool('wordByWordLyrics', true),
        write: (value) => {
          writeBool('wordByWordLyrics', Boolean(value))
          window.dispatchEvent(new Event('wordByWordLyricsChanged'))
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'translationEnabled',
        label: '歌词翻译',
        description: '在播放界面显示翻译',
        control: { kind: 'toggle' },
        read: () => readBool('translationEnabled', false),
        write: (value) => {
          writeBool('translationEnabled', Boolean(value))
          window.dispatchEvent(new Event('translationSettingsChanged'))
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'translationPosition',
        label: '翻译显示位置',
        control: {
          kind: 'choice',
          options: [
            { value: 'traditional', label: '传统', hint: '显示于歌词下方' },
            { value: 'bottom-right', label: '现代', hint: '右下角浮动显示' },
          ],
        },
        read: () => readStr('translationPosition', 'traditional'),
        write: (value) => {
          localStorage.setItem('translationPosition', String(value))
          window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: value }))
          window.dispatchEvent(new Event('translationSettingsChanged'))
          notifyGlobalSettingChanged()
        },
        visibleIf: () => readBool('translationEnabled', false),
      },
      {
        id: 'thirdPartyLyricsEnabled',
        label: '第三方歌词源',
        description: '从社区歌词库匹配歌词，提升逐字覆盖率',
        control: { kind: 'toggle' },
        read: () => readBool('thirdPartyLyricsEnabled', true),
        write: (value) => { writeBool('thirdPartyLyricsEnabled', Boolean(value)); notifyGlobalSettingChanged() },
      },
      {
        id: 'adaptiveLyrics',
        label: '自适应最佳歌词',
        description: '自动在多个来源间选择质量最好的歌词',
        control: { kind: 'toggle' },
        read: () => readBool('adaptiveLyrics', true),
        write: (value) => { writeBool('adaptiveLyrics', Boolean(value)); notifyGlobalSettingChanged() },
      },
      {
        id: 'primaryLyricsSource',
        label: '首要歌词库',
        description: '优先请求的歌词来源，失败时自动回退',
        control: {
          kind: 'choice',
          options: [
            { value: 'AMLL', label: 'AMLL TTML DB' },
            { value: 'Apple Music', label: 'Apple Music' },
            { value: 'NetEase', label: '网易云音乐' },
            { value: 'QQMusic', label: 'QQ音乐' },
            { value: 'Platform', label: '当前平台' },
          ],
        },
        read: () => readStr('primaryLyricsSource', 'AMLL'),
        write: (value) => { localStorage.setItem('primaryLyricsSource', String(value)); notifyGlobalSettingChanged() },
        visibleIf: () => readBool('thirdPartyLyricsEnabled', true) && readBool('adaptiveLyrics', true),
      },
      {
        id: 'appleMusicLyrics',
        label: '启用 Apple Music 歌词',
        description: '需先登录 Apple Music 账号后才可启用',
        control: { kind: 'toggle' },
        read: () => readBool('appleMusicEnabled', false),
        write: (value) => {
          writeBool('appleMusicEnabled', Boolean(value))
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'appleNativeStream',
        label: 'Apple 原生音源',
        description: 'Cider 式直连 Apple 播放（默认开启）',
        control: { kind: 'toggle' },
        read: () => readStr('appleNativeStream', '') !== 'false',
        write: (value) => {
          localStorage.setItem('appleNativeStream', value ? 'true' : 'false')
          notifyGlobalSettingChanged()
        },
      },
    ],
  },
  {
    id: 'shortcuts',
    label: '快捷键',
    description: '键盘控制与"即将播放"提示',
    entries: [
      {
        id: 'playbackPageEnabled',
        label: '播放页快捷键',
        description: '在播放页使用键盘快捷键控制播放',
        control: { kind: 'toggle' },
        read: () => shortcutSettings().playbackPageEnabled,
        write: (value) => writeShortcuts({ playbackPageEnabled: Boolean(value) }),
      },
      {
        id: 'spacePlayPauseEnabled',
        label: '空格键播放 / 暂停',
        control: { kind: 'toggle' },
        read: () => shortcutSettings().spacePlayPauseEnabled,
        write: (value) => writeShortcuts({ spacePlayPauseEnabled: Boolean(value) }),
        visibleIf: () => shortcutSettings().playbackPageEnabled,
      },
      {
        id: 'seekForwardSeconds',
        label: '快进秒数',
        control: { kind: 'slider', min: 1, max: 15, step: 1, unit: '秒' },
        read: () => shortcutSettings().seekForwardSeconds,
        write: (value) => writeShortcuts({ seekForwardSeconds: Math.round(Number(value)) }),
        visibleIf: () => shortcutSettings().playbackPageEnabled,
      },
      {
        id: 'seekBackwardSeconds',
        label: '快退秒数',
        control: { kind: 'slider', min: 1, max: 15, step: 1, unit: '秒' },
        read: () => shortcutSettings().seekBackwardSeconds,
        write: (value) => writeShortcuts({ seekBackwardSeconds: Math.round(Number(value)) }),
        visibleIf: () => shortcutSettings().playbackPageEnabled,
      },
      {
        id: 'mediaKeysEnabled',
        label: '键盘多媒体键支持',
        description: '响应键盘上的播放 / 暂停等多媒体键',
        control: { kind: 'toggle' },
        read: () => shortcutSettings().mediaKeysEnabled,
        write: (value) => writeShortcuts({ mediaKeysEnabled: Boolean(value) }),
      },
      {
        id: 'upNextEnabled',
        label: '即将播放提示',
        description: '歌曲将结束时提示下一首歌',
        control: { kind: 'toggle' },
        read: () => readBool('upNextEnabled', true),
        write: (value) => {
          writeBool('upNextEnabled', Boolean(value))
          window.dispatchEvent(new Event('upNextEnabledChanged'))
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'showUpNextOutsidePlayer',
        label: '在播放页外显示播放提示',
        control: { kind: 'toggle' },
        read: () => readBool('showUpNextOutsidePlayer', false),
        write: (value) => {
          writeBool('showUpNextOutsidePlayer', Boolean(value))
          window.dispatchEvent(new Event('showUpNextOutsidePlayerChanged'))
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'upNextSeconds',
        label: '提前显示时间',
        control: { kind: 'slider', min: 5, max: 30, step: 1, unit: '秒' },
        read: () => readNum('upNextSeconds', 10),
        write: (value) => {
          const seconds = Math.max(5, Math.min(30, Math.round(Number(value))))
          localStorage.setItem('upNextSeconds', seconds.toString())
          window.dispatchEvent(new CustomEvent('upNextSecondsChanged', { detail: seconds }))
          notifyGlobalSettingChanged()
        },
        visibleIf: () => readBool('showUpNextOutsidePlayer', false),
      },
    ],
  },
  {
    id: 'desktop',
    label: '桌面集成',
    description: '桌面歌词 / 桌面播放器 / 任务栏播控 / 窗口模式（仅桌面端）',
    entries: [
      {
        id: 'desktopLyricsEnabled',
        label: '桌面歌词',
        description: '将当前歌词显示在桌面上，可拖动、缩放',
        control: { kind: 'toggle' },
        read: () => desktopCache.desktopLyrics.enabled,
        write: (value) => updateDesktopLyrics({ enabled: Boolean(value) }),
        available: hasDesktopLyricsBridge,
      },
      {
        id: 'desktopLyricsFontSize',
        label: '桌面歌词字号',
        control: { kind: 'slider', min: 26, max: 120, step: 2, unit: 'px' },
        read: () => desktopCache.desktopLyrics.fontSize,
        write: (value) => updateDesktopLyrics({ fontSize: Math.round(Number(value)) }),
        available: hasDesktopLyricsBridge,
        visibleIf: () => desktopCache.desktopLyrics.enabled,
      },
      {
        id: 'desktopLyricsFontFamily',
        label: '桌面歌词字体',
        description: '内置霞鹜文楷 / 得意黑（开源可商用），也可选择本机安装的字体',
        control: { kind: 'font-picker' },
        read: () => desktopCache.desktopLyrics.fontFamily || '',
        write: (value) => updateDesktopLyrics({ fontFamily: String(value) }),
        available: hasDesktopLyricsBridge,
        visibleIf: () => desktopCache.desktopLyrics.enabled,
      },
      {
        id: 'desktopLyricsColorMode',
        label: '桌面歌词颜色',
        control: {
          kind: 'choice',
          options: [
            { value: 'auto', label: '随歌曲' },
            { value: 'rose', label: '樱粉' },
            { value: 'sky', label: '晴蓝' },
            { value: 'gold', label: '暖金' },
            { value: 'mint', label: '薄荷' },
            { value: 'white', label: '月白' },
          ],
        },
        read: () => desktopCache.desktopLyrics.colorMode,
        write: (value) => updateDesktopLyrics({ colorMode: value as DesktopLyricsColorMode }),
        available: hasDesktopLyricsBridge,
        visibleIf: () => desktopCache.desktopLyrics.enabled,
      },
      {
        id: 'desktopPlayerEnabled',
        label: '桌面播放器',
        description: '在桌面上悬浮一个小型播放控制窗',
        control: { kind: 'toggle' },
        read: () => desktopCache.desktopPlayer.enabled,
        write: (value) => {
          desktopCache.desktopPlayer.enabled = Boolean(value)
          void electron()?.desktopPlayer?.setEnabled?.(Boolean(value))
            .then((result: any) => {
              desktopCache.desktopPlayer.enabled = Boolean(result?.enabled ?? value)
              notifyGlobalSettingChanged()
            })
            .catch(() => { desktopCache.desktopPlayer.enabled = false; notifyGlobalSettingChanged() })
          notifyGlobalSettingChanged()
        },
        available: hasDesktopPlayerBridge,
      },
      {
        id: 'desktopPlayerForm',
        label: '桌面播放器形态',
        control: {
          kind: 'choice',
          options: [
            { value: 'card', label: '悬浮卡片', hint: '带封面与控制按钮' },
            { value: 'bar', label: '紧凑条状', hint: '贴边单行显示' },
          ],
        },
        read: () => desktopCache.desktopPlayer.form,
        write: (value) => {
          desktopCache.desktopPlayer.form = value === 'bar' ? 'bar' : 'card'
          void electron()?.desktopPlayer?.setForm?.(value)
          notifyGlobalSettingChanged()
        },
        available: hasDesktopPlayerBridge,
        visibleIf: () => desktopCache.desktopPlayer.enabled,
      },
      {
        id: 'taskbarWidgetEnabled',
        label: '任务栏迷你播控',
        description: '在任务栏上显示正在播放的封面与控制',
        control: { kind: 'toggle' },
        read: () => desktopCache.taskbarWidget.enabled,
        write: (value) => {
          desktopCache.taskbarWidget = { ...desktopCache.taskbarWidget, enabled: Boolean(value) }
          void electron()?.taskbarWidget?.setEnabled?.(Boolean(value))
            .then((result: any) => {
              if (result?.success) desktopCache.taskbarWidget = { ...desktopCache.taskbarWidget, enabled: Boolean(result.enabled) }
              notifyGlobalSettingChanged()
            })
            .catch(() => { desktopCache.taskbarWidget = { ...desktopCache.taskbarWidget, enabled: false }; notifyGlobalSettingChanged() })
          notifyGlobalSettingChanged()
        },
        available: hasTaskbarBridge,
      },
      {
        id: 'taskbarPosition',
        label: '任务栏播控位置',
        control: {
          kind: 'choice',
          options: [
            { value: 'right', label: '右侧', hint: '靠近系统托盘' },
            { value: 'center', label: '居中', hint: '任务栏水平居中' },
          ],
        },
        read: () => desktopCache.taskbarWidget.position,
        write: (value) => updateTaskbarWidget({ position: value as TaskbarWidgetSettings['position'] }),
        available: hasTaskbarBridge,
        visibleIf: () => desktopCache.taskbarWidget.enabled,
      },
      {
        id: 'taskbarMode',
        label: '任务栏播控显示模式',
        control: {
          kind: 'choice',
          options: [
            { value: 'normal', label: '常规', hint: '封面 + 控制 + 歌词' },
            { value: 'pure', label: '纯享', hint: '只显示当前歌词' },
          ],
        },
        read: () => desktopCache.taskbarWidget.mode || 'normal',
        write: (value) => updateTaskbarWidget({ mode: value as TaskbarWidgetSettings['mode'] }),
        available: hasTaskbarBridge,
        visibleIf: () => desktopCache.taskbarWidget.enabled,
      },
      {
        id: 'taskbarHideControls',
        label: '隐藏任务栏播控控件',
        description: '只保留封面与歌词，鼠标悬停时显示控制',
        control: { kind: 'toggle' },
        read: () => Boolean(desktopCache.taskbarWidget.hideControls),
        write: (value) => updateTaskbarWidget({ hideControls: Boolean(value) }),
        available: hasTaskbarBridge,
        visibleIf: () => desktopCache.taskbarWidget.enabled,
      },
      {
        id: 'fullscreenMode',
        label: '全屏化窗口模式',
        description: '全屏 = 覆盖任务栏；全屏无边框 = 保留任务栏',
        control: {
          kind: 'choice',
          options: [
            { value: 'kiosk', label: '全屏', hint: '覆盖任务栏' },
            { value: 'normal', label: '全屏无边框', hint: '保留任务栏' },
          ],
        },
        read: () => readStr('fullscreenMode', 'kiosk'),
        write: (value) => {
          localStorage.setItem('fullscreenMode', String(value))
          window.dispatchEvent(new CustomEvent('fullscreenModeChanged', { detail: value }))
          void (async () => {
            try {
              const status = await electron()?.system?.isFullscreen?.()
              if (status?.fullscreen || status?.kiosk) {
                await electron()?.system?.setFullscreen?.(false, false)
                await electron()?.system?.setFullscreen?.(true, value === 'kiosk')
                toast(value === 'kiosk' ? '已切换到全屏模式（覆盖任务栏）' : '已切换到全屏无边框模式（保留任务栏）')
              }
            } catch { /* 桥接不可用时仅保存偏好 */ }
          })()
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'remoteSettings',
        label: '遥控器个性化',
        description: '外观 · 右上角按钮 · 触摸板手势',
        control: { kind: 'action', actionId: 'remote-settings' },
        read: () => true,
      },
    ],
  },
  {
    id: 'performance',
    label: '性能',
    description: 'GPU / 高刷 / 频谱等渲染性能选项（仅桌面端）',
    entries: [
      {
        id: 'gpuAcceleration',
        label: 'GPU 硬件加速',
        description: '关闭后使用软件渲染，重启软件生效',
        control: { kind: 'toggle' },
        read: () => desktopCache.gpu.acceleration,
        write: (value) => {
          void electron()?.system?.setHardwareAcceleration?.(Boolean(value))
            .then((result: any) => {
              if (result?.success) {
                desktopCache.gpu.acceleration = Boolean(result.enabled)
                localStorage.setItem('gpuAcceleration', JSON.stringify(Boolean(result.enabled)))
                toast(result.enabled ? 'GPU 加速已打开，重启软件后生效' : 'GPU 加速已关闭，重启软件后生效', 'info')
              } else {
                toast('硬件加速设置保存失败', 'error')
              }
              notifyGlobalSettingChanged()
            })
            .catch(() => { toast('硬件加速设置保存失败', 'error'); notifyGlobalSettingChanged() })
        },
        available: hasSystemBridge,
      },
      {
        id: 'gpuPreference',
        label: '显卡选择',
        description: '优先使用独立显卡或核显渲染，重启生效',
        control: {
          kind: 'choice',
          options: [
            { value: 'auto', label: '自动' },
            { value: 'discrete', label: '独立显卡' },
            { value: 'integrated', label: '核显' },
          ],
        },
        read: () => desktopCache.gpu.preference,
        write: (value) => {
          void electron()?.system?.setGpuPreference?.(value)
            .then((result: any) => {
              if (result?.success) {
                desktopCache.gpu.preference = result.gpuPreference || 'auto'
                const labels: Record<string, string> = { auto: '自动', discrete: '独立显卡', integrated: '核显' }
                toast(`已切换为${labels[result.gpuPreference]}，重启软件后生效`, 'info')
              }
              notifyGlobalSettingChanged()
            })
            .catch(() => notifyGlobalSettingChanged())
        },
        available: () => hasSystemBridge() && typeof electron()?.system?.setGpuPreference === 'function',
      },
      {
        id: 'highRefreshEnabled',
        label: '全局高刷',
        description: '解除渲染帧率限制，跟随显示器最高刷新率',
        control: { kind: 'toggle' },
        read: () => desktopCache.highRefresh.enabled,
        write: (value) => {
          desktopCache.highRefresh.enabled = Boolean(value)
          void electron()?.display?.setHighRefresh?.(Boolean(value), value ? desktopCache.highRefresh.hz : null)
            .then((result: any) => {
              if (result) desktopCache.highRefresh = { enabled: Boolean(result.enabled), hz: result.hz ?? desktopCache.highRefresh.hz }
              toast(result ? (result.enabled ? `全局高刷已开启（${result.hz || '跟随显示器'}Hz）` : '已关闭全局高刷') : '切换全局高刷失败，请重试', result ? 'info' : 'error')
              notifyGlobalSettingChanged()
            })
            .catch(() => { desktopCache.highRefresh.enabled = !value; toast('切换全局高刷失败，请重试', 'error'); notifyGlobalSettingChanged() })
        },
        available: hasDisplayBridge,
      },
      {
        id: 'highRefreshHz',
        label: '刷新率档位',
        control: {
          kind: 'choice',
          options: [
            { value: 'auto', label: '跟随显示器' },
            { value: '60', label: '60Hz' },
            { value: '120', label: '120Hz' },
            { value: '144', label: '144Hz' },
            { value: '240', label: '240Hz' },
          ],
        },
        read: () => (desktopCache.highRefresh.hz == null ? 'auto' : String(desktopCache.highRefresh.hz)),
        write: (value) => {
          const hz = value === 'auto' ? null : Number(value)
          desktopCache.highRefresh.hz = hz
          if (!desktopCache.highRefresh.enabled) { notifyGlobalSettingChanged(); return }
          void electron()?.display?.setHighRefresh?.(true, hz)
            .then(() => notifyGlobalSettingChanged())
            .catch(() => notifyGlobalSettingChanged())
        },
        available: hasDisplayBridge,
        visibleIf: () => desktopCache.highRefresh.enabled,
      },
      {
        id: 'audioAnalyzerEnabled',
        label: '音频频谱分析',
        description: '关闭后播放页波形 / 频谱停用（性能模式）',
        control: { kind: 'toggle' },
        read: () => readBool('audioAnalyzerEnabled', true),
        write: (value) => {
          writeBool('audioAnalyzerEnabled', Boolean(value))
          window.dispatchEvent(new CustomEvent('audioAnalyzerEnabledChanged', { detail: Boolean(value) }))
          toast(Boolean(value) ? '音频频谱分析已启用' : '音频频谱分析已禁用（性能模式）')
          notifyGlobalSettingChanged()
        },
      },
    ],
  },
  {
    id: 'network',
    label: '网络',
    description: '代理自动配置（仅桌面端）：扫描本地代理端口，下载 / 更新走代理',
    entries: [
      {
        id: 'proxyEnabled',
        label: '代理自动配置',
        description: '开启后自动扫描本地代理端口并选择最快节点',
        control: { kind: 'toggle' },
        read: () => desktopCache.proxy.enabled,
        write: (value) => {
          if (!value) {
            desktopCache.proxy = { ...desktopCache.proxy, enabled: false, target: null }
            void electron()?.proxyManager?.disable?.().then((state: any) => {
              if (state) desktopCache.proxy = { ...desktopCache.proxy, enabled: Boolean(state.enabled) }
              notifyGlobalSettingChanged()
            }).catch(() => notifyGlobalSettingChanged())
            notifyGlobalSettingChanged()
            return
          }
          desktopCache.proxy = { ...desktopCache.proxy, enabled: true }
          notifyGlobalSettingChanged()
          proxyScanAndEnable(false)
        },
        available: hasProxyBridge,
      },
      {
        id: 'proxyRescan',
        label: '重新扫描代理节点',
        description: '重新扫描本地代理端口并切换到最快节点',
        control: { kind: 'action', actionId: 'proxy-rescan' },
        read: () => true,
        available: hasProxyBridge,
        visibleIf: () => desktopCache.proxy.enabled,
      },
    ],
  },
  {
    id: 'advanced',
    label: '高级',
    description: '跨平台回退 / 开发者选项 / 缓存管理',
    entries: [
      {
        id: 'crossPlatformFallbackEnabled',
        label: '网易云可用性增强',
        description: '灰色歌曲自动跨平台匹配音源（可能存在版权风险）',
        control: { kind: 'toggle' },
        read: () => readBool('crossPlatformFallbackEnabled', false),
        write: (value) => { writeBool('crossPlatformFallbackEnabled', Boolean(value)); notifyGlobalSettingChanged() },
      },
      {
        id: 'developerMode',
        label: '开发者模式',
        description: '显示调试入口与详细日志',
        control: { kind: 'toggle' },
        read: () => readBool('developerMode', false),
        write: (value) => {
          writeBool('developerMode', Boolean(value))
          window.dispatchEvent(new CustomEvent('developerModeChanged', { detail: Boolean(value) }))
          electron()?.developerMode?.set?.(Boolean(value))?.catch?.(() => undefined)
          toast(Boolean(value) ? '开发者模式已启用' : '开发者模式已禁用', 'info')
          notifyGlobalSettingChanged()
        },
      },
      {
        id: 'transitionDebugEnabled',
        label: '过渡调试提示',
        description: '切歌时右上角显示引擎 / 策略 / DJ 效果清单',
        control: { kind: 'toggle' },
        read: () => readStr('waveforge:transition-debug', '0') === '1',
        write: (value) => {
          localStorage.setItem('waveforge:transition-debug', value ? '1' : '0')
          notifyGlobalSettingChanged()
        },
        visibleIf: () => readBool('developerMode', false),
      },
      {
        id: 'cacheClear',
        label: '缓存清理',
        description: '清理歌曲缓存 / 图片缓存 / 歌词缓存',
        control: { kind: 'action', actionId: 'cache-clear' },
        read: () => true,
      },
    ],
  },
  {
    id: 'about',
    label: '关于',
    description: '版本信息与软件更新',
    entries: [
      {
        id: 'autoCheckUpdate',
        label: '自动检查更新',
        description: '启动时自动检测新版本',
        control: { kind: 'toggle' },
        read: () => readBool('autoCheckUpdate', true),
        write: (value) => { writeBool('autoCheckUpdate', Boolean(value)); notifyGlobalSettingChanged() },
      },
      {
        id: 'checkUpdate',
        label: '检查更新',
        description: '拉取更新清单，有新版本时弹出更新详情',
        control: { kind: 'action', actionId: 'check-update' },
        read: () => true,
      },
    ],
  },
]

export function getGroup(groupId: GlobalSettingsGroupId): GlobalSettingsGroup | undefined {
  return GLOBAL_SETTINGS_GROUPS.find(group => group.id === groupId)
}

/** 条目在当前环境下是否可见（available + visibleIf 都满足） */
export function isEntryVisible(entry: GlobalSettingEntry): boolean {
  if (entry.available && !entry.available()) return false
  if (entry.visibleIf && !entry.visibleIf()) return false
  return true
}

// ─────────────────────────── React 绑定 ───────────────────────────

// 事件名集中列出（写侧 dispatch 的自定义事件 + 镜像自身的通用事件）
const REGISTRY_WATCHED_EVENTS = [
  GLOBAL_SETTING_CHANGED_EVENT,
  'crossfadeSettingsChanged', 'gaplessSettingsChanged', 'albumGaplessSettingsChanged', 'autoMixSettingsChanged',
  'videoEndBehaviorChanged', 'wordByWordLyricsChanged', 'translationSettingsChanged', 'translationPositionChanged',
  'upNextEnabledChanged', 'showUpNextOutsidePlayerChanged', 'upNextSecondsChanged',
  'playerThemeChanged', 'accentColorChanged', 'developerModeChanged', 'audioAnalyzerEnabledChanged',
  'fullscreenModeChanged', 'desktopPlayerEnabledChanged', 'desktopLyricsEnabledChanged',
  PLAYBACK_SHORTCUT_SETTINGS_EVENT,
]

/**
 * 镜像设置界面的数据钩子：挂载时拉取 Electron 缓存 + 订阅全部变化事件，
 * 返回带版本的读取器（值变化时 version 自增触发重渲染）。
 */
export function useGlobalSettings() {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    ensureDesktopBridgeSettings()
    const bump = () => setVersion(value => value + 1)
    for (const eventName of REGISTRY_WATCHED_EVENTS) window.addEventListener(eventName, bump)
    return () => {
      for (const eventName of REGISTRY_WATCHED_EVENTS) window.removeEventListener(eventName, bump)
    }
  }, [])

  return useMemo(() => ({
    version,
    getValue: (entryId: string): SettingValue | undefined => {
      for (const group of GLOBAL_SETTINGS_GROUPS) {
        const entry = group.entries.find(item => item.id === entryId)
        if (entry) return entry.read()
      }
      return undefined
    },
    setValue: (entryId: string, value: SettingValue) => {
      for (const group of GLOBAL_SETTINGS_GROUPS) {
        const entry = group.entries.find(item => item.id === entryId)
        if (entry?.write) { entry.write(value); return }
      }
    },
    runAction: (actionId: MirrorActionId) => {
      if (actionId === 'check-update') checkForUpdate()
      if (actionId === 'proxy-rescan') proxyScanAndEnable(true)
      // audio-quality / cache-clear / remote-settings 由各模式的渲染器打开自己的弹窗
    },
  }), [version])
}

/** 关于信息（各模式"关于"分组渲染用） */
export function getAboutVersion(): string {
  return getVersionDisplay(packageInfo.version)
}
