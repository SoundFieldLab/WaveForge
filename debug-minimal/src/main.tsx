import { createRoot } from 'react-dom/client'
import './harness.css'
import Harness from './Harness'
import { installDevBridge, installDevBridgeRafFallback } from './devBridge'
import { isPluginEnabled, setPluginEnabled, setPluginConsent, markDetailViewed, setDGLabWidgetVisible } from '@/services/pluginStore'
import { loadDGLabSettings, saveDGLabSettings } from '@/plugins/clients/DGLabClient'

/**
 * 插件状态在 React 挂载**之前**就写好，而不是在组件 effect 里设。
 *
 * 原因：插件启停走的是全局单例（dglabClient）的生命周期。若在 effect 里启用，
 * React StrictMode 的「挂载→卸载→挂载」会让第一次挂载的 onDisable 落在
 * 第二次挂载的 onEnable 之后，最终把刚激活的插件又停掉——表现为
 * 「界面显示已启用，但中继空闲、没有波形」。
 * 预置状态 + 去掉 StrictMode（见下）后，挂载时状态已稳定，不再触发该竞态。
 *
 * 注意：这里写的 localStorage 属于 127.0.0.1:3100，与主程序 3000 端口不同源，
 * 因此不会污染主程序的插件配置。
 */
markDetailViewed('dglab')
setPluginConsent('dglab', true)
if (!isPluginEnabled('dglab')) setPluginEnabled('dglab', true)
setDGLabWidgetVisible(true)

// 调试平台不启用「整机监听」：无 Electron 时会弹屏幕共享选择框，打断主流程。
// 需要测该功能时在控制台手动打开即可。
if (loadDGLabSettings().systemCapture) saveDGLabSettings({ systemCapture: false })

installDevBridge()

// rAF 兜底：插件的分析循环靠 requestAnimationFrame 驱动，而浏览器在「窗口被完全遮挡
// / 标签页不可见」时会暂停 rAF（Chromium occluded 限流）。此时分析器有数据但循环不跑，
// 表现为「音乐在播、波形不动」。主程序（Electron）设了 backgroundThrottling:false 不受影响，
// 但在浏览器里调试时页签常被挤到后面 —— 用定时器兜底，保证链路可验证。
//
// 仅当真的检测不到 rAF 时才替换，前台正常运行时保持原生行为。
const rafHook = window as unknown as { __rafFallbackInstalled?: boolean }
if (!rafHook.__rafFallbackInstalled) {
  let rafTicks = 0
  let rafProbe = 0
  const tick = () => { rafTicks += 1 }
  rafProbe = requestAnimationFrame(tick)
  setTimeout(() => {
    cancelAnimationFrame(rafProbe)
    if (rafTicks === 0) {
      // 从未触发 → 被限流，安装兜底并提示
      installDevBridgeRafFallback(30)
      console.info('[调试平台] 检测到 rAF 被宿主限流，已自动切换为 30fps 定时器驱动分析循环。')
    }
  }, 900)
}

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root 挂载点')

// 刻意不使用 StrictMode：它会对插件单例做双挂载，而 DG-LAB 的启停是有副作用
// 的外部连接（中继/WS），调试平台要观察的是真实的一次性启停行为，不是 React 的
// 开发期重复渲染。主程序自身的 StrictMode 行为不受这里影响。
createRoot(root).render(<Harness />)
