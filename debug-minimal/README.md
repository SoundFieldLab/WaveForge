# DG-LAB 最小化调试平台（debug-minimal）

> 开发调试用的独立平台，**只存在于仓库，不随软件打包**。
> 用于在没有实体郊狼设备、也不用启动整个 WaveForge 的情况下，完整验证
> DG-LAB 插件的「音乐 → 音频特征 → 映射引擎 → 下发波形帧」全链路与 UI。

## 为什么需要它

在完整软件里调 DG-LAB 插件，每改一行都要走一遍：
重启 Electron → 等启动 → 搜歌 → 打开插件中心 → 过须知 → 启用 → 扫码 → 播歌。
调试波形（改映射曲线、调 UI）时这个循环太慢。

这个平台把这个循环压到「改完存盘 → 浏览器自动热更新」，
并且用**虚拟郊狼设备**替掉手机 App，让整条链路在无硬件时也能观测。

## 关键设计：不复制代码，只换宿主

| 部分 | 来源 | 说明 |
|---|---|---|
| 插件 UI / 客户端 | 主仓库 `src/`（`@` 别名直接指向） | 在调试平台改的就是主程序那份文件 |
| 中继 + 映射引擎 | 主仓库 `server/dglab-relay.cjs`（`require` 进来） | 验证的是发布版本会用到的同一条映射逻辑 |
| 虚拟设备 | 本目录 `server/virtual-device.cjs` | 仅走公开 WS 协议，不改中继代码 |
| 调试后端 / 观测台 | 本目录 | 端口、日志、波形可视化 |

因此**不存在「调试桩和真机不一致」**：这里调好的波形，就是主程序里的波形。
反过来，这里改了 `src/` 下的插件代码，主程序也立刻同步——不需要「改回去」。

## 快速开始

```bash
# 一键启动：调试后端(3101/31082) + 调试前端(3100)
npm run dglab:debug:all
```

浏览器打开 <http://127.0.0.1:3100>。

也可以分开启动（便于各自看日志）：

```bash
npm run dglab:debug      # 只起调试后端（API 3101 / 中继 31082）
npm run dglab:debug:ui   # 只起调试前端（vite 3100）
```

### 端口分配（与主程序错开，可同时运行）

| 用途 | 调试平台 | 主程序 |
|---|---|---|
| 前端 | 3100 | 3000 |
| 本地 API | 3101 | 3001 |
| DGLAB 中继 WS | 31082 | 30082 |

前端与主程序不同源，`localStorage` 天然隔离 —— 在调试平台改插件设置
不会污染你日常使用的 WaveForge 配置。

## 界面说明

- **调试 HUD**（左上浮动面板，可拖动 / 折叠）：
  - **音乐**：自动扫描测试曲目（默认 `~/Music`），播放 / 暂停、±10s、音量；
    以及虚拟设备的接入 / 断开 / 重启中继。
  - **设备**：核心观测台。强度轨迹（A/B 实收）、脉冲波形帧条带、
    引擎内部电平、以及每一条下发指令的事件流。
  - **中继**：`dglab-relay.cjs` 的原始日志（扫码地址、绑定、音频接入首帧、
    安全归零、风格诊断等）。
- **DG-LAB 控制台**：主仓库的真实组件，全屏弹出，UI 与主程序完全一致。
- **悬浮小组件 / 整机监听浮标**：同样是主仓库真实组件。

### 测试音乐

默认扫描 `~/Music`（可用环境变量覆盖）：

```bash
DGLAB_DEBUG_MUSIC_DIR="D:/我的测试曲" npm run dglab:debug:all
```

也支持放在本目录 `music/` 下。支持 ogg / mp3 / flac / wav / m4a / opus。

## 虚拟郊狼设备

`server/virtual-device.cjs` 以「手机 App」的身份连入中继，做两件事：

1. 完成官方握手（V3 `bind` / V4 `hello` + 设备列表），让中继进入 `bound`、
   映射引擎开始输出；
2. 解码中继真正下发的每一帧并记录下来：

| 指令 | 含义 |
|---|---|
| `strength-<ch>+<op>+<v>` | 通道强度设定（0-200） |
| `clear-<ch>` | 通道归零 |
| `pulse-<ch>:["HEX"...]` | 波形帧序列（8 字节 = 4×freq + 4×strength） |

观测台显示的强度轨迹与波形条带就是这些原始帧，未经美化，可直接用来验收映射效果。

V4 协议同样支持（后端启动时用 `DGLAB_DEBUG_VERSION=v4` 切换），
虚拟设备会按 V4 的 `devices.get` / `device.op` RPC 应答。

## 调试桥（浏览器 DevTools）

页面把插件用到的真实单例挂到了 `window.__dglabDebug`：

```js
__dglabDebug.client.getSnapshot()        // 中继/连接/输出全量状态
__dglabDebug.client.isActive()           // 插件是否真的激活
__dglabDebug.client.activate()           // 手动激活（排查启用链路）
__dglabDebug.audio()                     // 音频 store：是否有订阅者、当前特征
__dglabDebug.settings()                  // 当前持久化设置
__dglabDebug.sampleAudio(3000)           // 采样 3s 的音频特征
__dglabDebug.trace(5000)                 // 打印 5s 内状态变化（定位状态异常）
__dglabDebug.store.setPluginEnabled('dglab', false)
```

`audio()` 返回的 `hasListeners` 很关键：分析器只在有订阅者时才跑采样循环，
为 `false` 时快照恒为 0（「音乐在播但波形不动」最常见的原因之一）。

## 已知环境限制

**后台标签页的 rAF 限流。** 插件的分析循环由 `requestAnimationFrame` 驱动，
浏览器在「窗口被完全遮挡 / 标签页不可见」时会暂停 rAF。
此时分析器有数据但循环不跑，表现为「音乐在播、波形不动」。

主程序（Electron）设置了 `backgroundThrottling: false`，不受影响。
调试平台检测到 rAF 被限流时会自动切换为 30fps 定时器并打印提示，
所以正常使用不需要处理；若手动需要，可调用：

```js
__dglabDebug.installRafFallback(30)
```

## 目录结构

```
debug-minimal/
├── index.html            调试页入口（注入 __DGLAB_DEBUG__ 端口配置）
├── vite.config.ts        @ → ../src，端口 3100
├── package.json          本平台的脚本与说明
├── tsconfig.json         独立类型检查（npm run dglab:debug:typecheck）
├── README.md
├── server/
│   ├── index.cjs         调试后端：真实中继 + 虚拟设备 + 音乐流 + 观测 API
│   └── virtual-device.cjs 虚拟郊狼设备（解码下发帧）
└── src/
    ├── main.tsx          预置插件状态、安装 rAF 兜底、挂载
    ├── Harness.tsx       主界面（浮动 HUD + 真实控制台）
    ├── useDebugAudioEngine.ts  音频接入（对齐主程序分析器参数）
    ├── DeviceMonitor.tsx 设备观测台（强度轨迹 / 波形帧 / 事件流）
    ├── RelayActivity.tsx 中继日志
    ├── devBridge.ts      window.__dglabDebug
    └── harness.css       Tailwind + 少量必要自定义类
```

## 打包与入库

- **不会进安装包**：`package.json` 的 electron-builder `files` 是白名单，
  只包含 `desktop/ dist/ server/ shared/ ...`，本目录不在其中；
  Vite 的 `rollupOptions.input` 也只列了三个正式入口。
- **会进仓库**：供开发组共同调试、换设备复现问题。
  `.gitignore` 未忽略本目录。

改动 `src/` 下插件代码后，两处都会生效，无需同步两份。
只有本目录内的调试代码（观测台、虚拟设备）是调试平台专用。

## 常用命令

```bash
npm run dglab:debug:all         # 启动全部
npm run dglab:debug:typecheck   # 类型检查（本平台）
npm run lint                    # 类型检查（主程序）
npm run test:desktop            # 含 dglab-relay-lifecycle 测试
```
