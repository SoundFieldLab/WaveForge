import type { PluginManifest, PluginRuntime } from "./types";
import { registerBuiltinPlugin } from "./registry";
import { closePluginConsole } from "../services/pluginStore";
import { signalRgbClient } from "./clients/SignalRgbClient";

const SIGNALRGB_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%2319d3c5'/%3E%3Cstop offset='.5' stop-color='%23ff4f79'/%3E%3Cstop offset='1' stop-color='%23ffd166'/%3E%3C/linearGradient%3E%3C/defs%3E%3Ccircle cx='32' cy='32' r='22' fill='none' stroke='url(%23g)' stroke-width='8'/%3E%3Ccircle cx='32' cy='32' r='7' fill='%23fff' fill-opacity='.9'/%3E%3C/svg%3E";

const manifest: PluginManifest = {
  id: "signalrgb",
  name: "SignalRGB",
  version: "1.0.0",
  developer: "WaveForge 团队",
  description: "让 SignalRGB 原生音频引擎驱动全部品牌与布局，并接收播放、节拍和主题语义事件",
  updated: "2026-08-31",
  icon: SIGNALRGB_ICON,
  iconColor: "#19d3c5",
  detail: [
    "WaveForge Effect 运行在 SignalRGB 内部，直接读取其原生 engine.audio 数据并渲染当前 SignalRGB 布局中的全部受支持品牌设备。",
    "提供 12 种原创灯光风格；WaveForge 只发送播放、节拍、重音、风格与主题等低频语义事件，不向 SignalRGB 传输频谱帧。",
    "Effect 文件可由控制台安装或更新，安装后需要重启 SignalRGB，并在 SignalRGB 中手动选择 WaveForge Effect。",
    "SignalRGB Pro Local API 可用于自动应用与恢复效果；没有 Pro 时仍可手动选择效果并使用 Canvas Event 增强。",
  ],
  source: "builtin",
  needsAudio: true,
};

const runtime: PluginRuntime = {
  onEnable: async () => {
    await signalRgbClient.activate();
  },
  onDisable: async () => {
    closePluginConsole("signalrgb");
    await signalRgbClient.deactivate();
  },
};

registerBuiltinPlugin(manifest, runtime);

export default manifest;
