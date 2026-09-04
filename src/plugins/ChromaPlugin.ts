import type { PluginManifest, PluginRuntime } from './types'
import { registerBuiltinPlugin } from './registry'
import { closeChromaConsole } from '../services/pluginStore'
import { chromaClient } from './clients/ChromaClient'

const manifest: PluginManifest = {
  id: 'chroma',
  name: 'Razer Chroma',
  version: '0.1.0',
  developer: 'WaveForge 团队',
  description: '把 24 段音乐频谱实时映射到雷蛇键盘与整套 Chroma 设备，提供 12 种可视化风格和真实硬件识别',
  updated: '2026-08-31',
  iconColor: '#44D62C',
  detail: [
    'Razer Chroma 插件提供独立灯光工作台，将 WaveForge 的 24 段对数频谱转换为逐键、逐区域 RGB 灯效。',
    '键盘内置光谱循环、单色/渐变频谱、波浪、径向脉冲、涟漪、呼吸、星光、火焰、雨滴、VU 电平和静态主题；同时支持背景灯效与响应式背景。',
    '亮度、灵敏度、衰减、尺寸、平滑度、方向、刷新率、色彩循环速度和自定义色板均可实时调节。',
    'Windows 设备扫描会识别真实 Razer 型号与 VID/PID；键盘、鼠标、鼠标垫、耳机、小键盘和 Chroma Link 输出通道可分别配置。',
    '内置断线重连、心跳、设备失败隔离和退出清理；即使未检测到雷云，控制台实时预览和全部设置仍然可用。',
  ],
  source: 'builtin',
  needsAudio: true,
}

const runtime: PluginRuntime = {
  onEnable: () => chromaClient.activate(),
  onDisable: () => {
    closeChromaConsole()
    return chromaClient.deactivate()
  },
}

registerBuiltinPlugin(manifest, runtime)

export default manifest
