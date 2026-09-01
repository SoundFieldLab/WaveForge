# WaveForge 插件开发文档

> 本文档面向希望为 WaveForge（澜音工坊）开发插件的开发者与 AI 助手。
> 插件系统用于承载「小功能 / 不够普适的功能」，通过插件商店式 UI 安装、开关与卸载。
> 本文档随仓库 Git 提交（标记待上传 GitHub，公开可读）。

## 目录

- [1. 什么是插件](#1-什么是插件)
- [2. 插件清单（manifest）格式](#2-插件清单manifest格式)
- [3. 插件生命周期与运行时 API](#3-插件生命周期与运行时-api)
- [4. 导入与安装规范](#4-导入与安装规范)
- [5. 使用须知门控（可选）](#5-使用须知门控可选)
- [6. 内置插件示例：DG_LAB（郊狼）](#6-内置插件示例dg_lab郊狼)
- [7. 安全边界与限制](#7-安全边界与限制)
- [8. 完整示例](#8-完整示例)

---

## 1. 什么是插件

插件 = 一份 **manifest（JSON 元信息 + 可选运行时代码）**。WaveForge 提供：

- **入口**：简约模式底部药丸、桌面模式底部弹出栏、探索模式右上角，均有「插件系统」按钮；
- **插件中心**：横向 App Store 式弹窗，卡片展示 Logo / 名称 / 简介 / 开关；
- **详情弹窗**：版本、开发者、更新日期、详细介绍、运行截图、卸载；
- **开关记忆**：插件默认全部关闭，用户手动开启后状态持久化（localStorage，`wf_plugins`）。

内置插件（如 DG_LAB）随应用发布、不可卸载；第三方插件通过「导入插件」安装，可卸载。

## 2. 插件清单（manifest）格式

导入时选择 `.json` / `.wfplugin.json` 文件，内容为单个 JSON 对象：

```jsonc
{
  "id": "my-plugin",                 // 必填：唯一标识，小写字母/数字/短横线
  "name": "我的插件",                 // 必填：显示名（卡片/详情）
  "version": "1.0.0",                // 必填：版本号
  "developer": "作者名",              // 必填：开发者
  "description": "一句话简介",         // 必填：卡片上显示
  "updated": "2026-08-26",           // 必填：更新日期（建议 YYYY-MM-DD）

  // 可选
  "icon": "https://.../logo.png",    // Logo 图片 URL；缺省用 iconColor 渐变 + 首字母
  "iconColor": "#f0b429",            // 主题色（Logo / 开关 / 高亮）
  "screenshots": ["https://.../1.png"], // 运行截图（详情页展示）
  "detail": ["详细介绍段落1", "段落2"],  // 详情页多段介绍
  "code": "…JS 源码字符串…",          // 运行时代码（见第 3、7 节）
  "requireNotice": true,             // 需要「使用须知」门控（见第 5 节）
  "notice": {
    "entry": ["首次查看详情须知"],      // 进详情前弹窗（3 秒倒计时）
    "consent": ["首次开启功能确认"]     // 首次开电确认（3 秒倒计时）
  }
}
```

必填字段：`id` / `name` / `version` / `developer` / `description` / `updated`。
`id` 规则：`^[a-z0-9-]+$`（忽略大小写）。

## 3. 插件生命周期与运行时 API

插件启用/停用时，WaveForge 会调用注册表的生命周期回调。运行时代码支持两种写法：

**写法 A（推荐）——返回生命周期对象：**

```js
// code 字符串内容
function (ctx) {
  return {
    onEnable() { ctx.log('已启用'); ctx.toast('插件已启用', 'success') },
    onDisable() { ctx.log('已停用') },
  }
}
```

**写法 B —— `module.exports` 风格：**

```js
function (ctx) {
  return { onEnable: () => {}, onDisable: () => {} } // 同 A
}
```

### 注入的上下文 `ctx`

```ts
interface PluginContext {
  /** 订阅实时音频分析（30fps），返回退订函数。 */
  audio: {
    subscribe(listener: (data: {
      bass: number; mid: number; high: number; overall: number;
      beat: number; accent: number; flux: number;
      spectrum: Float32Array; // 24 段对数频谱（20Hz~12kHz）
    }) => void): () => void
  }
  storage: {
    get(key: string): string | null   // 你自己的 localStorage
    set(key: string, value: string): void
  }
  toast(message: string, type?: 'success' | 'error' | 'info'): void
  log(...args: unknown[]): void       // 输出到控制台
}
```

⚠️ 音频分析流仅在**播放中且窗口可见**时有效；插件停用 / 静音 / 断链时由系统侧自动归零（安全兜底）。

## 4. 导入与安装规范

1. 在插件中心点击右上角「导入插件」；
2. 选择 `.json` / `.wfplugin.json`（必填字段校验失败会提示具体缺失项）；
3. 预览卡片展示名称 / 版本 / 开发者 / 简介 / 是否含运行时代码；
4. 点击「确认安装」→ 全屏美化弹窗（金勾动画「插件安装成功」）+ 成功 toast；同一 `id` 重复安装会被拒绝；
5. 安装后可在插件中心看到新卡片；「详情」里可卸载（卸载弹红色确认弹窗）。

**建议打包约定**：单文件 manifest 直接分发，文件名任意；若后续引入多个静态资源（图标/截图），
建议把 manifest 命名为 `manifest.json` 并随资源一起分发。

## 5. 使用须知门控（可选）

面向部分特殊人群 / 成人向插件可使用 `requireNotice` + `notice` 字段：

- 未查看详情的卡片**开关禁用**（显示锁图标，提示「请先查看插件详情」）；
- **首次点击卡片**弹出 entry 须知（3 秒倒计时后才可点「我已知晓」，取消则下次再弹）；
- **首次开启功能**（无论详情内/外开关）再次弹出 consent 确认（同样 3 秒倒计时），确认后 toast「插件[名称]已启用 请在主页使用此功能」；此后开关自由切换不再弹。

开启状态与各门控标记均持久化（`wf_plugins` / `wf_plugin_flags`）。

## 6. 内置插件示例：DG_LAB（郊狼）

内置插件 `dglab` 是完整参考实现（源码 `src/plugins/DGLabPlugin.ts`）：

- 功能：把音乐波形（低频鼓点 / 中频旋律 / 高频细节）实时转换为郊狼 A/B 双通道电流强度；
- 链路：WaveForge 渲染端采样 → 本地中继（`server/dglab-relay.cjs`）→ WebSocket → 手机 DG-Lab App（BLE 持有设备）→ 郊狼 3.0(V3) / 4.0(V4)；
- 中继：默认监听 `127.0.0.1:30082`，路径 `/dglab/v3`、`/dglab/v4`（App 扫码连入）、`/dglab/ctrl`（渲染端控制）；
- 扫码：App 娱乐模式扫二维码（内容为官方 socket URL）；
- 强度标尺：0-200，输出 `min(用户上限, App softLimit)`，断链/停止/静音自动 `clear` 归零；
- 波形：内置 连续 / 呼吸 / 潮汐 / 节拍 + 支持导入 DG-Lab 波形文件（整合 txt 多波形、pulse 单波形，存本机）。

第三方插件不必涉足设备协议；如需类似能力，可通过 `ctx.audio` 订阅分析流自行实现。

## 7. 安全边界与限制

导入插件的运行时代码当前与 WaveForge renderer **同权限执行，不是安全沙箱**：

- 不提供 CommonJS `require`，但代码仍可访问 `window`、`document`、`fetch` 和页面存储；
- 仅安装来源可信、可审计的插件文件；安装界面会明确标记含运行时代码的插件；
- 插件停用或卸载时，宿主会调用同一 lifecycle 的 `onDisable`，并强制释放通过 `ctx.audio.subscribe` 建立的订阅；
- 单个 manifest 的运行时代码上限为 256 KB，避免超大输入阻塞 renderer；
- 插件状态应优先使用 `ctx.storage`，网络和敏感数据访问应在插件说明中明确披露。

未来若要运行不受信代码，必须迁移到独立进程或具备真实隔离边界的执行环境。

## 8. 完整示例

一个「节拍闪烁通知」插件：监听鼓点，闪 toast。

```json
{
  "id": "beat-flash",
  "name": "节拍闪烁",
  "version": "1.0.0",
  "developer": "你的名字",
  "description": "每个鼓点弹一次提示",
  "updated": "2026-08-26",
  "iconColor": "#10b981",
  "detail": ["监听音乐鼓点，每次打击弹出提示。", "仅演示插件开发。"],
  "code": "function(ctx){ var last=0; return { onEnable: function(){ ctx.toast('节拍闪烁已启用','success'); this.un = ctx.audio.subscribe(function(d){ var now=Date.now(); if(d.beat>0.3 && now-last>800){ last=now; ctx.toast('咚！','info'); } }); }, onDisable: function(){ if(this.un) this.un(); } }; }"
}
```

把上述内容保存为 `beat-flash.json` → 插件中心 → 导入插件 → 选择该文件 → 确认安装。
## 附录：DG-LAB 插件体感架构契约（开发者须知）

- **分析点 = 最终听感点**：DG-LAB 的音频特征采集固定在「效果链之后、masterGain 混合输出」处（含左/右声道 splitter）。无论无缝衔接 / AutoMix / 增强版未来如何优化转场算法，只要最终进耳的信号经过该点，体感自动跟随听感，插件无需随引擎改动。
- **体感风格引擎**（`server/dglab-relay.cjs` STYLES）：7 套风格（立体声/心跳/呼吸/潮汐/敲击/流动/重拳），每套 = 特征→AB 强度映射 + 自研脉冲包络（不依赖原厂波形）+ 通道角色；切换走安全链（强度差/上限/恢复淡入/死区/Duty）。
- 强度差三档体质（强30/中12/弱5/自定义）与恢复适应时间三档（快1s/中2.5s/慢5s）为最轻度的安全默认；音乐升降速度由乐速因子（节拍间隔+flux 速率）动态适配。
- 播放暂停立即归零、续播按恢复档缓升；波形输出可一键启禁（仅停输出、不断连）。

## 附录：Razer Chroma 插件架构契约

- **设备边界**：Chroma REST API 只能可靠控制 `keyboard`、`mouse`、`mousepad`、`headset`、`keypad`、`chromalink` 六类广播端点，不能枚举具体硬件型号。`desktop/razer-device-discovery.cjs` 通过 Windows PnP 与 VID/PID 独立补充真实型号；UI 必须区分物理设备与 SDK 输出通道。
- **区域协商**：内部鼠标垫预览采用 REST v4 的 20 区布局；发送端若收到旧服务的 `expecting an array of 15 elements`，自动降采样并锁定本会话 15 区能力。
- **会话归属**：注册、心跳、设备效果和会话注销全部由 Electron 主进程的 `desktop/chroma-ipc.cjs` 管理。渲染端只能通过受限 IPC 提交白名单设备的定长灯效帧。
- **所见即所得**：`src/plugins/clients/chroma/chromaStyles.ts` 是真机输出与控制台预览共用的唯一灯效引擎，避免预览和硬件行为分叉。
- **后台门控**：插件仅在启用且用户打开后台联动时持有音频分析器后台租约。插件关闭后必须释放租约和 Chroma 会话，将灯光控制权交还雷云。
- **兼容策略**：REST 传输封装必须保持独立。若未来迁移到 Wyvrn ChromaRGB SDK，只替换主进程传输层，不改灯效引擎与控制台。

## 附录：SignalRGB 插件架构契约

- **官方扩展模型**：SignalRGB 没有稳定的外部逐 LED 写入 API。WaveForge 安装自主编写的 `WaveForge.html` Dynamic Effect，由 Effect 直接读取 `engine.audio` 并绘制 320×200 灯光画布，SignalRGB 负责映射到用户布局与全部受支持设备。
- **低频通信**：WaveForge 只通过 Canvas Event 发送播放、暂停、重拍、主题、风格和段落等白名单语义事件，不发送频谱或 LED 帧。
- **Pro 降级**：Local API 只用于自动应用/恢复效果和读取布局。HTTP 403 表示没有 Pro 或未授权，必须降级为用户在 SignalRGB 中手动选择 Effect，不作为插件故障。
- **安全安装**：Effect 仅在用户于控制台明确确认后写入 SignalRGB 最新版本的 `Effects/Dynamic` 目录。更新和卸载必须校验 WaveForge sidecar 与 SHA-256；无法证明所有权时拒绝覆盖或删除。
- **版本迁移**：SignalRGB 的 `app-*` 目录会随更新变化。检测到 Effect 仅存在于旧版本目录时，提示用户重新确认安装并重启 SignalRGB。
- **能力边界**：Local API 不公开物理设备型号、LED 拓扑和电量，SignalRGB 控制台不得伪造这些数据。
