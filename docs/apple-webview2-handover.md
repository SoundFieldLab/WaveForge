# Apple Music 原生源方案 — Electron L3 主路径 + WebView2 兼容兜底

> 创建：2026-08-30；最终更新：2026-08-30
> 状态：**Electron 原生 CENC/Widevine L3 + EVS production streaming VMP 已打通并完成产品化；WebView2 仅作兼容兜底。**

## 一、最终架构（已落地）

```
Apple 歌曲
  ↓
① Electron / castLabs ECS Browser CDM (L3)
   webPlayback → CENC HLS → hls.js EME → Apple license → 本地 Web Audio 音频图
   └─ 原生支持：进度/歌词/MV/频谱/音效/Automix/输出设备
  ↓ 仅失败时
② WebView2 播放面（兼容兜底，独立 MusicKit/WebView2）
  ↓ 仍失败
③ 网易云/QQ 同款载体
```

Electron 原生路径成立的必要条件：最终 EXE 必须有 **EVS production streaming VMP** 签名；castLabs 自带 development VMP 会被 Apple 返回 `-1021/-42605`。

## 二、DRM 调查更正（2026-08-30，castLabs 官方回复后）

> **重要更正：此前“Apple 只接受 Windows MF Widevine、拒绝 Browser L3”并未被严格证明，且与 castLabs 官方结论冲突。**

castLabs 在 issue #234 明确回复：Windows MF Widevine CDM/L1 只是历史实验，已在近期 Chromium/ECS 中废弃并移除，且从未支持 VMP；Apple Music 等商业流媒体应使用 ECS 默认的 **Widevine Browser CDM（软件 L3）**。可能的额外门槛是 VMP，但 Apple 的执行强度尚未确认。

本地审计进一步发现：
- 当前 dev 使用的 `node_modules/electron/dist/electron.exe` 带有效的 castLabs **开发 VMP 签名**（Google Widevine codesign root，证书有效至 2028-11-06），但它仅保证 UAT/接受 development client 的服务；
- 当前最终 Windows 目录与安装包已通过 EVS `streaming` VMP 验证（剩余 1417 天），安装后的主 EXE/`.sig` 与构建目录哈希完全一致
- 构建采用明确两阶段：`electron-builder --win dir` → EVS `sign-pkg/verify-pkg` → `electron-builder --prepackaged ... nsis`；不依赖无 Authenticode 时会被跳过的 `afterSign`
- 正确生产路线：ECS Browser CDM L3 + EVS `streaming` 生产 VMP 签名（Windows 顺序：所有 EXE 修改 → Authenticode → EVS VMP → installer）；
- 旧对照探针使用了错误的 PSSH v1 与旧 `license-requests[]` body，且混入 Cookie/session/challenge 重放变量，不能证明 MF-vs-L3 身份归因；
- `-1021` 也不是 VMP 专用错误码（Cider 公开记录中它还可由时序/限流触发）。

决定性实验已完成：同一 ECS Browser L3、同一生产协议和新鲜 session 下，开发 VMP 返回 `-1021/-42605`，EVS production streaming VMP 返回 648-byte license 且 `keyStatuses=usable`。MF CDM 实验注入已从 main.cjs 移除；WebView2 只保留为 CENC 异常时的兼容兜底。

## 三、各模块现状

### 原生 Apple CENC（主路径）
- `src/services/applePlayback.ts`：webPlayback 选 CENC rphq/rpsl、PSSH v0 + protobuf KID、生产 flat license body
- `src/services/appleHlsPlayer.ts`：hls.js EME；等待首个 `FRAG_BUFFERED`/`canplay` 后才报告成功，避免 license 尚未完成时假播放
- 本地 license 代理同时透传 `Media-User-Token`、Cookie、Authorization；已修复历史 `X-Apple-Music-User-Token` 入站头丢失问题
- 严格探针 `scripts/probe-apple-widevine-license.cjs` 实测：开发 VMP → `-1021/-42605`；EVS production streaming VMP → HTTP 200、648-byte license、`keyStatuses=usable`

### WebView2 播放面（兼容兜底）
- 窗口隐藏启动（`--show` 可见），profile 持久化（`--profile <dir>`，登录一次长期有效）
- 协议：`/play /pause /resume /stop /seek /volume /show /hide /state /spectrum /ping`
- `/play` 失败可感知（解析 setQueue/play 的 JS 异常 → `{ok:false, error}`）
- `/state` 含 `ended`（MusicKit playbackStatus===5）
- `/spectrum`：WASAPI loopback 采集 + numpy FFT → 64 对数 bin（40Hz~16kHz，0-255）
- HTTP 换 ThreadingHTTPServer（轮询并发）；内部状态采样 0.3s

### 渲染端桥客户端 `src/services/appleWebViewBridge.ts`
- `bridgePlay` 解析结果，失败返回 false → 上层静默回退
- spawn 负缓存（失败 60s 内不重试）；轮询连续失败 3 次标记 ready=false
- `ApplePlaybackState` 含 `ended`；`fetchBridgeSpectrum()`；`bridgeShow/HideWindow()`

### 播放器 hook `src/hooks/useAudioPlayer.ts` — 外部播放源模式
- `enableExternalPlayback({duration})` / `disableExternalPlayback()`（disable 时 best-effort `bridgeStopPlayback()`）
- 订阅 bridge 状态 → `emit({currentTime, duration, isPlaying})` → App onStateChange / playbackTimeStore 全部消费点自动工作
- ended → `setTransitionState('idle', {ended:true})` → App.tsx 现有逻辑处理单曲循环/队列推进
- `togglePlay/seek/setVolume` 外部模式分流到 bridge + 乐观 emit

### 分析器 `src/hooks/useAudioAnalyzer.ts`
- 第 5 参 `ExternalAnalyzerSource {active, getBins}`：外部源管线把 64 对数 bin 映射为
  AudioAnalyzerData（bass/mid/high/overall/beat/flux/24 段频谱/单声道 L/R），30fps rAF，与本地管线同口径

### App.tsx
- loadAndPlaySong：Apple 先尝试 Electron L3 CENC；CENC license/分片失败时再启动 WebView2；WebView2 失败后才走载体
- 原生 CENC 模式直接进入本地 audio deck，所有普通播放能力（进度/歌词/MV/频谱/暂停/seek/音量/Automix）沿用既有引擎
- WebView2 外部源模式只作为兼容兜底，限制与桥协议仍见下方

### 主进程 `desktop/main.cjs` + `desktop/preload.cjs`
- IPC `apple-bridge:spawn`：ping 优先（幂等）→ 找 Python（`WAVEFORGE_APPLE_BRIDGE_PYTHON` 环境变量 →
  嵌入式 python-embed → `%LOCALAPPDATA%/Programs/Python`、`C:/D:\Python*`、PATH；逐个 `import webview` 校验）→ spawn
- `spawnAppleBridge()` 已暴露到 preload（`window.electron.spawnAppleBridge`），端口固定为 18790
- bridge 不在应用启动阶段预热；仅在原生 CENC 失败或设置页手动打开时按需启动
- 主进程为每个 bridge 进程生成随机会话令牌，所有 HTTP 请求必须携带；IPC 仅接受主窗口调用
- `will-quit` kill bridge；孤儿清扫端口加入 18790（并修复了命令执行 helper 的作用域问题）
- dev-electron.mjs 残留清扫正则加入 apple_bridge.py

### 设置入口 `src/components/SettingsPanel.tsx`
- 「Apple Music 播放面」卡片：打开/隐藏播放面窗口 + 登录状态显示（首次登录用，非弹窗）

### 打包
- `python-apple-bridge/**` 已进 package.json `files` + `asarUnpack`
- requirements.txt 增加 pywebview / pyaudiowpatch（bundle-python 走 pip，pythonnet 随 pywebview 自动装）

## 四、命令协议（v2）

```
GET  /ping                  → {ok, ready}
GET  /state                 → {ready, authorized, playing, position, duration, title, artist, ended}
GET  /spectrum              → {bins:[0..255]×64, ts, enabled}
POST /play   {catalogId}    → {ok, error}     # setQueue 单曲队列 + play
POST /pause /resume /stop  → {ok}
POST /seek   {position}     → {ok}
POST /volume {volume}       → {ok}
POST /show /hide           → {ok}            # 播放面窗口显示/隐藏
```

## 五、基础交叉淡化（Apple 歌曲的过渡降级方案）

EME 限制下无法采样级拼接，Apple 歌曲的过渡统一走 **MusicKit 音量斜坡**（bridge `/fade`，
python 线程 50ms 步进；绝对音量/seek/换歌/stop 自动撞销在途斜坡）：

- **触发**：固定淡入淡出 / 无缝衔接 / AutoMix 三模式任一启用即生效（"同套基础交叉"）；
  固定淡入淡出档用其配置时长，其余 6s 缺省，clamp 2-12s；三模式全关 → 硬切
- **淡出尾**：位置进入 `duration - fadeDur` 窗口 → MusicKit 音量线性降到 0（暂停恢复/seek/拖音量均按剩余时间重启斜坡）
- **淡入头**：带淡出尾自然结束后，下一首 Apple 歌曲从 0 渐起（enableExternalPlayback）；
  下一首是非 Apple 时本地 deck 增益 0→音量渐起（loadAndPlay）
- **边界**：Apple→Apple 无重叠（单 MusicKit 实例），为顺序「淡出→淡入」；seek 触发重淡出；
  暂停时取消斜坡并恢复音量

## 六、已知限制

- **Automix/无缝拼接**：WebView2 模式无本地音频流，Apple 歌曲间不参与 automix（歌曲结束硬切下一首）；
  混合队列（Apple + 其他平台）正常工作
- **AirPlay / 音频输出设备切换**：对 Apple 歌曲无效（声音在 WebView2 进程走系统默认设备）
- **频谱**：来自系统混音 loopback，其他应用同时出声会混入；loopback 为单声道（DG-LAB L/R 同相）
- **登录边界**：WebView2 兼容窗口维护独立的 MusicKit 会话，不能注入 WaveForge 保存的 MusicUserToken。正常 Electron CENC 路径只需 WaveForge 的 Apple 登录；仅当兼容兜底实际启用且未授权时，用户才需在设置里的播放窗口登录一次。

## 七、验证清单（用户端到端）

1. 完全重启 WaveForge（不手动启动 Python）→ 点 Apple 歌曲（热歌榜/喜爱歌曲）
2. 验证：完整版播放、进度条/歌词走动、暂停/恢复/拖动/音量、播完自动下一首、单曲循环、
   切网易云歌无双重播放、频谱跳动、系统托盘无新弹窗
3. 设置 →「Apple Music 播放面」打开窗口登录一次 → 重启验证免登录

## 八、环境备注

- Python 探测顺序见 main.cjs `findAppleBridgePython`；本机开发可用 `D:/Python/python.exe`（已装 pywebview 6.2.1 + pyaudiowpatch）
- **dev 路径注意**：dev-electron 以 `electron desktop/main.cjs` 直接启动，`app.getAppPath()` 返回 `desktop/` 而非项目根——主进程里 dev 模式的资源路径一律用 `path.join(__dirname, '..', ...)`（apple_bridge.py / python-embed 均踩过此坑）
- 嵌入式 python-embed 需重新跑 `build:full`（bundle-python）才会装上 pywebview
- 手动启动调试：先生成随机令牌，再运行 `python python-apple-bridge/apple_bridge.py 18790 --token <token> --show`
- castlabs CDN 全球不可达；系统代理曾指向 10808（已还原关闭）
- **历史 MF CDM 调查（已终止）**：曾确认 ECS 二进制含实验扩展点，但 castLabs 官方已明确该 Windows L1 路径废弃且从未支持 VMP；相关 MF 注册/探针脚本已删除。最终方案以本报告中的 Browser L3 + EVS production VMP A/B 为准。
- **已知限制：Win11 通行密钥系统弹窗**——Apple 登录页在邮箱/电话输入框聚焦时触发 WebAuthn 条件填充，弹「Windows 安全中心 → 选择通行密钥」系统对话框。JS 层多级拦截（全 frame stub + autocomplete 剥离 + MutationObserver + CDP 预注入，代码在 createAppleLoginWindow）无法完全阻止（疑似 Chromium 原生自动填充管线，不经页面 JS）。**产品决策：接受现状**，最终用户点「取消」继续密码登录即可。诊断工具：scripts/probe-webauthn-frames.cjs（逐 frame 真值探针）
