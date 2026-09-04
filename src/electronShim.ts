/**
 * 非 Electron 环境（Android WebView / 纯浏览器）下给 window.electron 提供最小桩，
 * 保证：
 *  - TransitionRenderer 的智能过渡（smart-rendered）拿到 reject 后自动回退固定交叉淡化；
 *  - 系统窗口/GPU 查询等桌面接口为安全 no-op；
 *  - 桌面小组件/壁纸/遥控/授权等桌面专属桥保持 undefined（业务侧可选链即视为不可用）。
 */
import { isDesktop } from './platform'

export function installElectronShim(): void {
  if (isDesktop()) return
  if ((window as any).electron) return

  const unavailable = (name: string) => async () => {
    throw new Error(`[${name}] 仅桌面版可用（当前环境不支持）`)
  }

  ;(window as any).electron = {
    system: {
      isMaximized: async () => true,
      isFullscreen: async () => false,
      minimize: () => {},
      maximize: () => {},
      close: () => {},
      setFullscreen: () => {},
      getHardwareAcceleration: async () => ({
        enabled: true,
        actualEnabled: true,
        gpuFeatureStatus: { gpu_compositing: 'enabled' },
        gpuList: [],
      }),
      confirmGpuChange: async () => {},
      revertGpuChange: async () => {},
    },
    audio: {
      // TV 无系统音量接口：按 100% 处理（调用方判断 result.success 分支，缺 success 会短路）
      getSystemVolume: async () => ({ success: true, volume: 100, muted: false }),
    },
    audioDownload: {
      prepare: unavailable('audioDownload'),
      clearCache: async () => {},
      getStats: async () => ({ count: 0, size: 0 }),
    },
    render: {
      transition: unavailable('render'),
      getAudioUrl: unavailable('render'),
      readAudioFile: unavailable('render'),
      clearCache: async () => {},
      getCacheStats: async () => ({ count: 0, size: 0 }),
    },
    mediaKeys: {
      setEnabled: async () => {},
      onControl: () => () => {},
    },
    config: {
      getCachePath: async () => '本地存储（浏览器缓存）',
      setCachePath: async () => ({ success: false, error: '当前环境不支持自定义缓存目录' }),
      selectCachePath: async () => null,
      resetCachePath: async () => '本地存储（浏览器缓存）',
    },
    developerMode: {
      set: () => {},
    },
    // 桌面小组件/桌面歌词桥：浏览器环境提供空实现，
    // 避免 App 里 `?.getInitialState?.().then(...)` 在 undefined 上 .then/.catch 崩溃。
    desktopPlayer: {
      getInitialState: async () => ({ enabled: false }),
      onEnabledChanged: () => () => {},
      onControl: () => () => {},
      setEnabled: () => {},
      getSettings: async () => ({}),
      pushState: () => {},
    },
    desktopLyrics: {
      getInitialState: async () => ({ enabled: false }),
      getSettings: async () => ({}),
      onEnabledChanged: () => () => {},
      setEnabled: () => {},
    },
  }
}
