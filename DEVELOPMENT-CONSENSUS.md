# 开发共识：TV/平板/手机端开发迭代用无线调试热更新（正式版本更新照常）

> 本共识面向所有参与 WaveForge 开发的 AI 与开发者。
> **核心**：TV/平板/手机端与 PC 共用同一套前端功能，版本跟随 PC 大版本一起发布，
> "设置 → 检查更新"是**正常正式发布通道，绝不禁止**。
> 无线调试热更新只用于 **Dev 阶段的功能迭代验证**（改完代码快速在真机上看效果），
> 不替代、也不影响正式版本更新。

## 一、为什么

- WaveForge 是 PC（Electron）+ Android（TV/平板/手机）多端应用，功能公用。
- **正式版本**：功能跟随 PC 大版本走，TV/安卓端与 PC 一起通过"检查更新"发布（正常流程，保持）。
- **Dev 阶段**：每改一个小功能就发一次版本不现实（安装繁琐、版本碎片化）。
  因此内置**局域网无线调试 + 热更新**：改完前端代码 → 一条命令推送到设备 → 页面自动刷新。
- 热更新是**开发工具**，与版本发布并行：开发中用它迭代验证，功能成熟后随版本一起正式发布。

## 二、机制（原理）

| 组件 | 说明 |
|---|---|
| 开发者模式 | TV 端**默认关闭**（正式包不带公开调试攻击面）；在设置面板打开后持久化（`localStorage.developerMode` + 后端 `tv-debug-state.json`），重启保持。 |
| 调试服务 `:3008` | node 后端启动时按持久化的开发者模式状态启停，绑定 `0.0.0.0`（局域网可达）。`:3002-3004` 是 PC 端 Python 服务（beat/loudness/compensation），与 TV 调试无关。 |
| 配对令牌 | 调试服务开启时随机生成，打印进设备后端日志；`/update`、`/logs`、`/crash`、`/ws` 均要求令牌（URL `?token=` 或 `X-WaveForge-Debug-Token` 头）。 |
| 热更新端点 | `POST http://<设备IP>:3008/update?token=<令牌>`，body `{ files: [{ path, data(base64) }] }`（`path` 相对 `dist/`）→ 设备替换文件 → 广播 `reload` → 前端自动刷新。 |
| 调试台 | `http://<设备IP>:3008/?token=<令牌>`：后端日志（2s 自动刷新）、node 崩溃堆栈、前端 console 日志/JS 错误、遥控 App（播放/方向键/OK/返回/主页/搜索/设置）、热更新上传 UI（网页选文件）。 |
| 崩溃定位 | node 未捕获异常写 `filesDir/tv-crash.log`（超 1MB 轮转），前端错误上报同文件（限流）；重启后 `:3008/crash?token=` 仍可查。 |

## 三、如何操作（改完代码后推送）

```bash
# USB 直推（手机/平板/Fold 推荐，免 IP 免令牌）：设备开发者模式开启后一条命令
node scripts/push-hot-update.mjs --adb --rebuild

# 局域网无线推送（需配对令牌：设备 设置→外观→开发者模式 打开后页面显示）
node scripts/push-hot-update.mjs <设备IP> --token=<配对令牌> --rebuild

# 只推送（不重新构建，用现有 dist）
node scripts/push-hot-update.mjs --adb
```

推送脚本读取 `android/app/src/main/assets/nodejs-project/dist/`（vite android 构建产物），
把全部文件 base64 打包上传 → 设备替换 → 页面自动刷新，改动即刻生效。

**前提**：设备已开启开发者模式。开关位置——手机/平板：**设置 → 外观 → 开发者模式**
（开启后同页显示配对令牌供局域网直推）；TV：设置面板。`--adb` 模式自动 `adb forward
tcp:13008 → 设备 3008`，后端对回环来源豁免配对令牌（能 adb 即设备主人）；局域网来源仍须令牌。

## 四、边界与注意

- **热更新只覆盖前端资源（dist/）**，且仅用于 Dev 迭代验证。后端（`main.cjs`，含
  android-server/tv-extensions/local-server）与原生层改动需要**重新构建并重装 APK**。
- **正式版本发布不受影响**：功能随 PC 大版本一起发布，TV/安卓端照常走
  "设置 → 检查更新"获取新版本（版本号/更新清单流程不变）。
- 热更新不是发布通道：开发中迭代用热更新快速看效果，成熟后随版本正式发布。

## 五、给其他 AI 的协作约定

1. 判断是否 TV/平板/手机端：`html.tv-mode` 类 / `isTvModeActive()`（浏览器 `?tv=1` 可模拟）；
   触摸移动端看 `html.mobile-mode` / `isMobileModeActive()`（浏览器 `?ui=phone|tablet` 模拟，
   `data-form` 为 phone/tablet；Fold 真机开合运行时自动切换，无需重载）。
2. **开发迭代**：改完 TV/平板/手机相关前端代码，用
   `node scripts/push-hot-update.mjs <设备IP> --rebuild` 推送到真机/模拟器快速验证。
3. **正式发布**：功能随大版本走，通过"设置 → 检查更新"发布，不要因为热更新改变发布流程。
4. 设备局域网 IP 以实际为准（投影仪常见 `192.168.88.x`；MuMu 模拟器可用
   `adb forward tcp:13002 tcp:3002` 后访问 `http://localhost:13002`）。
5. 改完推送后，通过 `:3002/logs`（后端+前端日志）与 `:3002/crash`（崩溃）确认效果，
   必要时用调试台遥控设备操作验证。
6. 后端/原生改动请明确告知"需重装 APK"，不要混在热更新里。
7. 本共识与 HANDOVER-AI-COLLAB.md（双 AI 协作交接）配合使用：工作区共享时先看交接文档。
