/**
 * 调试桥：把插件用到的真实单例挂到 window，供控制台直接操作与观察。
 *
 * 为什么需要：调试平台里「插件是否真的激活」「引擎有没有收到音频」这类问题，
 * 只看 UI 判断不了（UI 显示的是快照，可能是旧值）。有了这个桥，在 DevTools 里就能：
 *   __dglabDebug.client.getSnapshot()        // 中继/连接/输出全量状态
 *   __dglabDebug.client.activate()           // 手动激活（排查启用链路）
 *   __dglabDebug.client.isActive()
 *   __dglabDebug.store.setPluginEnabled('dglab', false)
 *   __dglabDebug.settings()                  // 当前持久化设置
 *   __dglabDebug.audio()                     // 全局音频 store 是否已注册
 *   __dglabDebug.trace(5000)                 // 打印 5s 内的快照变化
 *
 * 它只是转发既有 API，不改变任何行为，因此排查结论对主程序同样成立。
 */

import { getDGLabClient, loadDGLabSettings, getGlobalAudioAnalyzerStore } from '@/plugins/clients/DGLabClient'
import { isPluginEnabled, setPluginEnabled, setDGLabWidgetVisible, openDGLabConsole, closeDGLabConsole } from '@/services/pluginStore'

export interface DGLabDebugBridge {
  client: ReturnType<typeof getDGLabClient>
  settings: () => ReturnType<typeof loadDGLabSettings>
  audio: () => {
    registered: boolean
    /** 是否有订阅者（无订阅者时分析器 rAF 不会运行 → 快照恒为 0）。 */
    hasListeners: boolean | null
    hasBackground: boolean | null
    snapshot: { overall: number; bass: number; beat: number; flux: number } | null
  }
  store: {
    isPluginEnabled: (id: string) => boolean
    setPluginEnabled: (id: string, on: boolean) => void
    openConsole: () => void
    closeConsole: () => void
    widget: (on: boolean) => void
  }
  trace: (ms?: number) => Promise<unknown[]>
  /**
   * rAF 兜底：把 requestAnimationFrame 换成定时器（30fps）。
   *
   * 为什么需要：插件的分析循环由 rAF 驱动。浏览器在「标签页不可见 / 窗口被完全遮挡」
   * 时会暂停 rAF（Chromium 的 occluded 限流），此时分析器仍有数据但循环不跑，
   * 表现为「音乐在播、波形却一直不动」。主程序（Electron）设了
   * backgroundThrottling:false 不受影响，但调试页可能被遮在后面。
   * 该兜底只影响调试页，用于在这种环境下继续验证链路；正常前台使用无需调用。
   */
  installRafFallback: (fps?: number) => string
  /** 订阅真实音频 store 一段时间，返回特征采样（判断「分析流到底有没有产出」）。 */
  sampleAudio: (ms?: number) => Promise<{ overall: number; bass: number; beat: number; flux: number }[]>
}

/**
 * 把 requestAnimationFrame 换成定时器（默认 30fps）。
 *
 * 为什么需要：插件的分析循环由 rAF 驱动。浏览器在「标签页不可见 / 窗口被完全遮挡」
 * 时会暂停 rAF（Chromium 的 occluded 限流），此时分析器仍有数据但循环不跑，
 * 表现为「音乐在播、波形却一直不动」。主程序（Electron）设了
 * backgroundThrottling:false 不受影响，但调试页可能被遮在后面。
 * 该兜底只影响调试页，用于在这种环境下继续验证链路；前台正常运行不会触发。
 */
export function installDevBridgeRafFallback(fps = 30): string {
  const interval = Math.max(4, Math.round(1000 / fps))
  const g = window as unknown as {
    requestAnimationFrame: (cb: (t: number) => void) => number
    cancelAnimationFrame: (id: number) => void
    __rafFallbackInstalled?: boolean
  }
  g.requestAnimationFrame = (cb: (t: number) => void) => window.setTimeout(() => cb(performance.now()), interval)
  g.cancelAnimationFrame = (id: number) => window.clearTimeout(id)
  g.__rafFallbackInstalled = true
  return `rAF 已替换为 ${fps}fps 定时器（仅当前页面，刷新后失效）`
}

export function installDevBridge() {
  const client = getDGLabClient()

  const bridge: DGLabDebugBridge = {
    client,
    settings: () => loadDGLabSettings(),
    audio: () => {
      const store = getGlobalAudioAnalyzerStore() as (ReturnType<typeof getGlobalAudioAnalyzerStore> & {
        hasListeners?: () => boolean
        hasBackgroundConsumers?: () => boolean
      }) | null
      const snap = store?.getSnapshot()
      return {
        registered: Boolean(store),
        // 无订阅者时分析器不跑 rAF，快照会一直是 0——这是排查「音乐在播但波形不动」的关键信号
        hasListeners: store?.hasListeners ? store.hasListeners() : null,
        hasBackground: store?.hasBackgroundConsumers ? store.hasBackgroundConsumers() : null,
        snapshot: snap
          ? { overall: Number(snap.overall.toFixed(4)), bass: Number(snap.bass.toFixed(4)), beat: Number(snap.beat.toFixed(3)), flux: Number(snap.flux.toFixed(4)) }
          : null,
      }
    },
    store: {
      isPluginEnabled,
      setPluginEnabled,
      openConsole: openDGLabConsole,
      closeConsole: closeDGLabConsole,
      widget: setDGLabWidgetVisible,
    },
    /** 采样一段时间内的快照变化，返回变化序列（定位「状态为何不对」很直接）。 */
    trace: async (ms = 5000) => {
      const samples: { at: number; active: boolean; state: string; running: boolean; connected: boolean; out: unknown; lastError: string | null }[] = []
      const start = performance.now()
      let lastKey = ''
      while (performance.now() - start < ms) {
        const s = client.getSnapshot()
        const key = `${s.state}|${s.running}|${s.connected}|${s.out?.A}|${s.out?.B}|${s.lastError}`
        if (key !== lastKey) {
          lastKey = key
          samples.push({
            at: Math.round(performance.now() - start),
            active: client.isActive(),
            state: s.state,
            running: s.running,
            connected: s.connected,
            out: s.out,
            lastError: s.lastError,
          })
        }
        await new Promise(r => setTimeout(r, 80))
      }
      // 同时打印到控制台，方便直接看
      console.table(samples)
      return samples
    },
    installRafFallback: (fps = 30) => installDevBridgeRafFallback(fps),
    sampleAudio: async (ms = 3000) => {
      const store = getGlobalAudioAnalyzerStore()
      if (!store) return []
      const out: { overall: number; bass: number; beat: number; flux: number }[] = []
      const release = store.subscribe(() => {
        const s = store.getSnapshot()
        out.push({ overall: Number(s.overall.toFixed(4)), bass: Number(s.bass.toFixed(4)), beat: Number(s.beat.toFixed(3)), flux: Number(s.flux.toFixed(4)) })
      })
      await new Promise(r => setTimeout(r, ms))
      release()
      return out
    },
  }

  ;(window as unknown as { __dglabDebug?: DGLabDebugBridge }).__dglabDebug = bridge
  console.log('[调试平台] __dglabDebug 已就绪：client / settings() / audio() / store / trace()')
  return bridge
}
