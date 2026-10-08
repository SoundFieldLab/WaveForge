# AGENTS.md — WaveForge 澜音工坊

Desktop music player (Windows/Electron) for QQ Music + NetEase Cloud Music. Frontend React 19 + TypeScript + Tailwind CSS 4 + Vite 6, backend Node/Express, Python beat-analysis service for DJ-style gapless playback. UI text and code comments are predominantly **Chinese** — keep new user-facing strings consistent with the existing language. 仓库同时含 **Android TV**（`android/` + `src/tv/`，构建脚本 `build:android`）与 **Apple 歌词/探索分支**（`src/components/Apple*`）——改桌面端时勿破坏多平台分支。

## Commands

```bash
npm run dev:electron     # Full dev: Vite (3000) + API server (3001) + Electron window
npm run dev              # Vite dev server only (port 3000; Weather Lab: http://127.0.0.1:3000/weather-debug.html)
npm run dev:api          # Express backend only (local-server.mjs, port 3001)
npm run lint             # Typecheck: tsc --noEmit (covers src/ only; no ESLint in repo)
npm run test             # vitest 单测 (test/ + src/services/waveforge-engine-v3/, 2026-08-26 实测：64 文件 829 用例 = 824 过 + 5 跳过；跳过的 5 项是 v3 LGPL 可选依赖未装自动跳过)
npm run build:v3-worklet # 重生成 v3 AudioWorklet 单文件 -> public/v3-worklet.js（predev/prebuild 已自动执行）
npm run build            # vite build -> dist/ (multi-entry: every *.html in repo root)
npm run build:electron   # build + electron-builder NSIS -> release/
npm run build:full       # bundle-python + build:electron (完整发布流水线)
npm run build:electron:dir  # build + electron-builder --win dir (未打包目录, 便于调试)
npm run build:android    # 生成 Android TV 前端资产 (scripts/build-android-assets.mjs)
npm run fetch:nodejs-mobile  # 拉取 nodejs-mobile 运行时（Android 用）
npm run publish:release  # 一键发布脚本 (scripts/publish-release.mjs)
npm run bundle-python    # Rebuild embedded Python runtime (3.13.15) -> resources/python-embed/
npm run test:license     # 设备授权自测 (scripts/test-device-license.cjs)
npm run sync:sponsors    # 从爱发电 API 刷新 src/data/afdianSponsors.generated.json
npm run version:patch|minor|major|pre  # 版本号更迭 (scripts/bump-version.mjs, 自动 commit/tag/push)
npm run version:dry      # 预览版本更迭 (不落地)
launchers/start-full.bat          # One-click: Python beat (3002) + loudness (3003) + compensation (3004) + app
launchers/test-python-service.bat # Health-check Python service on port 3002
launchers/start-dglab-debug.bat   # DG-LAB 调试平台（真机测试；前端 3100 / API 3101 / 中继 31082）
```

启动脚本统一放在 `launchers/`（因此脚本内 `PROJECT_ROOT=%~dp0..\` 回退一级到项目根）；
一次性探针脚本在 `scripts/probes/`。

注意：`prebuild` 钩子会在每次 `build`/`build:electron` 前自动运行 `sync:sponsors --optional`（需 `WaveForge-Afdian.env` 爱发电密钥文件，缺失时 `--optional` 软失败，不影响构建）。

Python beat service runs on **port 3002** (not 5001 — historical docs are stale). Offline wheel cache in `python-beat-service/packages/` is cp313 and matches the embedded 3.13 runtime; `start.bat` installs from it with `--no-index --find-links=packages`.

## Independent debug pages

Before creating or using a standalone debug webpage, read [`DEBUG_PAGES.md`](./DEBUG_PAGES.md). It registers developer-only visual tools, their launch command, local URL, data/network constraints, and production-build status.

- **Weather Lab**: run the existing `npm run dev`, then open `http://127.0.0.1:3000/weather-debug.html`. Use it to compare all Apple weather scenes and desktop `full`/`simple` cards with local mock data. Do not add `weather-debug.html` to production Vite inputs.


**响度测量服务**：`python-beat-service/loudness_server.py`（独立于节拍服务，**端口 3003**，`/lufs` 端点返回 ITU-R BS.1770 积分响度）。响度归一化（调音室开关）按曲目调用它；该服务未运行/失败时归一化自动回退原声，不影响播放。启动入口：dev 模式 `dev-electron.mjs` 自动拉起；打包版 `main.cjs` startLocalBackend() 用嵌入式 Python spawn；手动 `launchers/start-full.bat` 同起。

**频响补偿设计服务**：`python-beat-service/compensation_server.py`（独立于节拍/响度服务，**端口 3004**，`/compensation` 端点）。按简化等响度模型（ISO 226 理论 + 音量→SPL 线性映射，非逐点查表）把目标补偿曲线离散为多段 Biquad 滤波器参数（lowshelf / peaking / highshelf）：auto 模式 = LowShelf(120Hz, Q0.707, 0-12dB) + HighShelf(12000Hz, Q0.707, 0-6dB)，增益按系统音量线性（低频系数 0.35、高频 0.15，100%→0/0、50%→约+5/+2、10%→约+9/+4），只提升不衰减、中频保持 0dB；preset 模式 = 6 预设（监听平直/低频补偿/人声突出/温暖/通透/夜间温和，低频 shelf + 0-2 温和中频 peaking + 高频 shelf）；custom 模式 = 5 独立频段 peaking（±8dB）。前端 `src/services/audio-effects-v2/compensationService.ts` 调 `http://localhost:3004/compensation`，用 Web Audio BiquadFilterNode 构建补偿链。启动入口与 3003 相同：dev 模式 `dev-electron.mjs` 自动拉起；打包版 `main.cjs` startLocalBackend() 用嵌入式 Python spawn；手动 `launchers/start-full.bat` 同起。服务未运行/失败时引擎回退到内置近似补偿，不影响播放。

**打包规则（electron-builder）**：`python-beat-service/packages/`（102MB 离线 wheels）**必须排除出打包**（package.json `build.files` 中的 `!python-beat-service/packages/**/*`）——打包版直接用嵌入式 Python（`resources/python-embed/`，依赖已预装）spawn 运行 `beat_analyzer.py`，从不执行 pip 安装；wheels 仅服务源码分发/开发环境的离线安装。若嵌入式运行时升级或依赖缺失需要重装，重新生成 wheel 集而不是改打包配置。

**发布策略（releases）**：**GitHub Releases 只发 NSIS 安装版**（`npm run build:electron` → `release/WaveForge-<version>-Setup.exe`），**不发便携版**（`release/win-unpacked/` 是本地调试产物，不随 releases 分发）。发布时：打 `v<version>` tag → push tag → `gh release create v<version> release/WaveForge-<version>-Setup.exe`（附 changelog）。安装版为每用户安装（`nsis.perMachine: false`），**不携带任何用户数据/配置**——用户配置生成于各机 `%APPDATA%\WaveForge 澜音工坊\`，安装后自动适配当前用户。

**版本号更迭机制**：版本号唯一事实来源是 `package.json` 的 `version`（设置→关于页显示 `v{version} Beta`，"检查新版本"功能对比 GitHub tag 与本地 version）。使用 `scripts/bump-version.mjs` 自动更迭：

```bash
npm run version:patch   # 0.1.0 -> 0.1.1（修复）
npm run version:minor   # 0.1.0 -> 0.2.0（新功能）
npm run version:major   # 0.1.0 -> 1.0.0（破坏性）
npm run version:pre     # 0.1.0 -> 0.1.1-beta.0（预发布）
npm run version:dry     # 预览将要执行的操作（不落地）
```

脚本默认流程：更新 `package.json` + `package-lock.json` 版本 → commit `chore: bump version to vX.Y.Z` → 打 `vX.Y.Z` tag → push 分支与 tag。选项：`--no-commit` / `--no-tag` / `--no-push` / `--force`（工作区有未提交改动时默认拒绝，避免污染版本提交）。bump 后走发布流程：`npm run build:electron` → `gh release create`。

**打包三大约束（破坏任一条便携版就会黑屏/缺资源）**：
1. `vite.config.ts` 的 **`base` 必须保持 `'./'`**（顶层配置，不要移进 `build` 子对象）——打包版用 `loadFile()`（file://）加载 `dist/index.html`，若 base 是 `'/'`，资源以 `/assets/...` 绝对路径引用全部 404，React 不挂载 → 整窗黑屏（症状：启动日志 `Renderer resources: 0`）。
2. `package.json` `build.files` 必须包含 **`logo.png` 与 `build/**/*`**——`desktop/splash.html` 引用 `../logo.png`，主窗口/登录窗口 icon 用 `../build/icon.ico`，漏打包则启动 logo 丢失。
3. `package.json` `build.electronDist` 保持 `node_modules/electron/dist`——本机网络无法下载 electron zip，electron-builder 离线构建全靠这个本地副本。

## ⚠️ 设置镜像机制（往设置里加功能前必读）

WaveForge 共 **4 个界面模式**（简约 minimal / 传统 traditional / 探索 explore / 桌面 desktop，后续可能更多）。**简约模式的设置（`src/components/SettingsPanel.tsx`）是整软件的"总设置"**，其中的全局功能性设置通过设置注册表自动镜像到其他模式：

- `src/services/globalSettingsRegistry.ts` — 声明式设置注册表。每条 `read/write` 与 SettingsPanel **同 localStorage 键、同自定义事件**，任意一端改动全软件同步；`components/MirroredGlobalSettings.tsx` 按各模式自己的设计语言渲染这张表（classic=传统模式 QQ 式布局 / panel=探索抽屉+桌面弹窗卡片式）。
- **在简约模式设置里新增功能开关时（播放/歌词/性能/桌面集成/网络等全局生效的设置）**：除了写 SettingsPanel 的简约 UI，**必须同步在 globalSettingsRegistry.ts 登记一条**，否则传统/探索/桌面模式的用户永远看不到该功能。自定义控件（如字体选择器 `components/FontPicker.tsx`）在 MirroredGlobalSettings.tsx 为新的 `control.kind` 加渲染分支。
- **简约模式专属的自定义/外观设置**（只影响简约模式自身，如"自定义首页显示内容"）不需要登记。
- 桌面集成类设置用 `available: hasXxxBridge` 门控（Web/TV 无 Electron 桥时自动隐藏对应条目与标签页）。
- 桌面歌词是**独立透明窗口**（`desktop-lyrics.html` 入口 + `desktop/main.cjs` IPC 持久化），设置经 `window.electron.desktopLyrics.updateSettings` 下发，**纯 Web 页面测不了**（无桥接），需 `npm run dev:electron` 实测。

## Layout & boundaries

- `src/` — React frontend. `components/` (App.tsx lazy-loads nearly everything), `services/` (API clients, cache, gapless/AutoMix logic), `audio/` (playback engine: `PlaybackQueue.ts`, `transitionPlanner.ts`, `TransitionRenderer.ts`, `playbackTimeStore.ts`), `hooks/`, `api/`, `utils/`.
- `src/services/gapless/` — **无缝衔接独立模块**（从 `useAudioPlayer.ts` 抽离）：`gaplessConstants.ts`（设置/常量）、`seamlessJoinController.ts`（首选拼接控制器：预热缓存/静音预启动/ended 拼接/边界调度/兜底，依赖注入）、`gaplessTransition.ts`（60ms 等功率双 deck 淡入淡出）。`useAudioPlayer.ts` 只保留调用接口（注入依赖 + 事件接线），改动无缝逻辑优先改此处。
- `src/services/audioEffects/` — **音效引擎 v1**（远程原版，5 效果互斥 + 老式调音室 UI）。**默认引擎**。
- `src/services/audio-effects-v2/` — **音效引擎 v2**（本地增强版）：可叠加效果 + 场景方案（快照式，内置 7 + 我的场景）+ 混响类型（5 种）+ 动态压缩 + 夜间模式（**动态压缩 + 高频衰减**，深夜语义，非波形整形）+ 频响补偿（**等响度动态补偿**：低频 0-12dB / 高频 0-6dB，shelf 结构防中频污染；auto 按系统音量线性提升低频/高频，preset 场景预设，custom 自定义频段；设计结果由独立服务 3004 `/compensation` 下发，`compensationService.ts` 按 mode+preset+volume 档位缓存；与 EQ、响度归一化互斥，ADR-0002）+ 响度归一化（`loudnessNormalization.ts` 调 3003 `/lufs`）。效果链 `input → 人声伴奏比例(M/S) → [EQ|频响补偿] → 增强(M/S) → 低音 → punch → 人声 → 伴奏 → 压缩 → 夜间压缩+高频衰减 → 全景声厅(干湿) → 3D环绕 → 限幅器`；`buildEffectChain` 被实时链与导出 WAV 离线链共享（ADR-0003）。调音室 v2 UI：场景区 + v1 式「使用/已启用」效果卡片 + 3D 环绕开启展开子设置（速度/近远/角度）+ 频响补偿/响度归一化独立卡片 + 恢复默认/清空均衡器按钮。**切歌时右上角弹 gapless 方案提示**（`GaplessModeToast.tsx`：直接拼接/60ms 淡入淡出/albumGapless 交叉淡化，`App.tsx` 按 transitionCommit.strategy + 专辑归属判定）。
- **第三引擎 = HyperSoundEngine（品牌名 HSE，外部独立项目融入）**：由作者 IceFire_Icer 在独立仓库开发后整体融入本项目（`temp/waveforge-engine-v3` 是其独立仓副本），**不是 WaveForge 内部自研**。许可证有特殊约束——模块目录自带 [LICENSE](src/services/waveforge-engine-v3/LICENSE)（**CC BY-NC-ND 4.0**）+ [授权补充说明.md](src/services/waveforge-engine-v3/授权补充说明.md)（IceFire_Icer 对 WaveForge 项目的专项授权：允许在本仓库范围内使用、集成、修改、分发，含 `public/v3-worklet.js` 打包产物；授权日 2026-08-18）。**红线**：勿删改模块内的 LICENSE/授权补充说明/版权声明；第三方在 WaveForge 之外取用该代码仍受 CC BY-NC-ND（署名/非商业/禁止演绎）约束。**命名**：文档/UI/用户可见文案一律叫 **HSE**；但代码标识符保持不动（目录 `waveforge-engine-v3`、类名 `EngineV3`/`EngineV3Host`、localStorage `waveforge:v3-params`、脚本 `build:v3-worklet`），勿做全局重命名。
- `src/services/waveforge-engine-v3/` — **音效引擎 HSE**（纯 TS DSP 内核，与 v1/v2 完全独立、无兼容层）：`src/`（16 个 DSP 模块 + `EngineV3.ts` 14 级链 + 11 场景 + 分享串 + 集成宿主）、`ui/`（**HSE 调音室**——左侧导航 8 页（主页/音效场景/均衡器/空间音效/动态调音/分析/调音器/关于）+ 深色琥珀金主题 + framer-motion 动效）、`test/`（324 用例）、`vendor/soundtouchjs`（LGPL 原包副本，**未安装未链接**，适配层无调用方，变速变调默认自研相位声码器）、`attachV3Engine.ts`（**WaveForge 融合层**：EngineV3Host 单例 + 参数持久化 `waveforge:v3-params` + UI 桥包装（worklet 模式参数双下发/统计回传）+ 系统音量→等响度补偿 + 听力测试纯音（`v3HearingPlay` 事件）+ 离线 WAV 导出）。**BassEnhancer 含低音下潜 `lowBoostDb`（-6..+12dB）**：低通提取的低频带按增益混回（lowshelf 语义，真实低频能量提升；谐波路径只提供心理声学感知），分享串编解码同步支持。**分析页**：实时频谱 32 条对数频率轴（20Hz-20kHz，FFT 幅度已归一化 dBFS）+ LUFS/GR/特征 + 听力测试，100ms 轮询 + EMA 平滑。**调音室音量滑块**：经 `loudnessNormalization.externalGainDb` 通道（0-100% → -60..0dB），**80ms 快平滑跟手**（自动响度归一化仍 3s 慢速防抽吸）；**音量独立于场景预设/组合**——`applyScene` 保留 loudnessNormalization 状态，内置场景与我的场景均不覆盖用户音量。**开发者模式（内置场景微调）**：关于页开关（`waveforge:hse-dev-mode`）→ 音效场景页出现编辑入口，可实时试听修改内置 11 场景并保存为**参数覆盖层**（`ui/sceneStore.ts`，localStorage `waveforge:v3-scene-overrides`；入库快照剥离音量通道+IR）；支持单场景还原出厂、场景库 JSON 导出/导入；桥接口对应 `updateBuiltinScene` / `resetBuiltinScene` / `exportSceneLibrary` / `importSceneLibrary`。**发布种子**：`src/engine/builtinSceneSeed.ts`（随包分发的官方默认层）——场景页「写回发布种子」在开发模式经 IPC `hse-write-scene-seed`（preload `writeHseSceneSeed`，main.cjs 限 `!app.isPackaged`+内容标记校验）直写该文件后 commit/push 即全员生效；revision 每次 +1，本机 rev 低于种子时个人旧微调自动让位官方新值（升级覆盖语义）。Worklet 处理器经 `npm run build:v3-worklet`（`scripts/build-v3-worklet.mjs`，esbuild 单文件 55KB）打入 `public/v3-worklet.js`，predev/prebuild 自动执行；`EngineV3Host` mode 'auto'：worklet 优先、失败回退 script 兜底。改引擎算法前先跑 `npx vitest run src/services/waveforge-engine-v3`（324+9 用例）。融合文档在模块 `docs/FUSION_GUIDE.md` / `docs/UI_GUIDE.md` / `架构书.md`。
- **引擎版本切换**：`src/services/audioEngineVersion.ts`（localStorage `waveforge:audio-engine-version`，默认 v1）。**统一适配层** `src/services/audio-engine/`（`IAudioEngineAdapter` 接口 + V1/V2/V3Adapter + 工厂 `getEngineAdapter(version)` + 注册表）：App.tsx 持有 `engineAdapterRef`，所有版本分支收敛为 `engineAdapterRef.current.xxx()` 单一调用（attach/dispose/setSystemVolume/applyLoudnessNormalization/exportWav/renderStudio），按 `adapter.capabilities` 判断能力而非写版本分支。调音室头部 v1/v2/HSE 切换按钮 → App `switchAudioEngine`：热切换（暂停音乐 → adapter.dispose 旧 → 重建新 adapter → attach 新链 → 恢复播放）或冷切换（音频图未就绪时仅存配置，下次启动生效），右上角弹 2s 切换提示。调音室渲染统一走 `adapter.renderStudio(commonProps)`：custom 模式返回引擎自带调音室（v1=`MixingStudio.tsx`，v2=`MixingStudioV2.tsx`，HSE=`V3MixingStudio.tsx`），generic 模式返回 `GenericMixingStudio.tsx`（未来无 UI 引擎用）。**三引擎 dispose 都会全断 masterGain 再恢复直连，避免并联打架**。HSE 响度归一化/频响补偿都在引擎内实时实现（不走 3003/3004 服务），系统音量经 adapter.setSystemVolume 注入。**接入新引擎**：写 `XxxAdapter.ts` 实现 `IAudioEngineAdapter` + 在 `index.ts` 注册表加一行，App.tsx 零改动。
- `desktop/` — Electron main process, **CommonJS** (`main.cjs`, `preload.cjs`, `config-manager.cjs`, `device-license.cjs`). Not covered by `tsc --noEmit`.
- `src/desktop-lyrics/` + `src/desktop-player/` — standalone renderer entries for `desktop-lyrics.html` / `desktop-player.html`.
- `local-server.mjs` — single-file Express backend (~10k lines, port 3001). Extra route modules in `server/` are registered here. QQ cookie state must flow through the single `qqMusicCookie` source of truth. **cookie 单事实源规则**：全局 `qqMusicCookie` 只在显式登录/设置接口（`/api/qq/cookie`、`/api/qq/user/setCookie`）更新；播放/读取路由一律用 `resolveRequestCookie(cookie)`（请求 cookie 仅本次使用，绝不回写全局），写操作按请求级 cookie 传递——并发播放/写操作不得互相冲掉登录态。
- `android/` + `src/tv/` — **Android TV 平台**（Gradle 工程 + TV 键盘/媒体键桥 `src/tv/tvCore.ts`、`mediaKeyBridge.ts`、`TvKeyboard.tsx`），前端资产经 `npm run build:android`（`scripts/build-android-assets.mjs`，`vite.android.config.ts`）。桌面端改动注意保持跨平台兼容（`src/platform.ts`、`src/electronShim.ts`）。
- `src/components/Apple*` — **Apple 歌词/探索分支**：`AppleCoverFx.tsx`（Apple 逐字歌词特效）、`AppleExploreView.tsx`、`AppleLoginPanel.tsx`；配套服务 `src/services/appleAuth.ts` / `appleCatalog.ts` / `appleMusic.ts`。与桌面歌词模式（LyricsDisplay 内 `apple` 模式）严格隔离，改桌面端勿破坏。
- `src/features/traditionalPc/` — **传统模式「官方 PC 客户端复刻」**（QQ 音乐 / 网易云两个平台）。传统模式的三栏里，**左栏与中栏按官方 PC 客户端 1:1 复刻，右栏保持 WaveForge 自有样式**；其余平台（Apple/Spotify/酷狗/汽水）仍走通用左栏与通用页面。分层：
  - `pcKit.tsx` — 客户端风基件（`pcTheme(tone)` 主题 token、`PcCover`/`PcCountBadge`、`PcSectionTitle`/`PcTabs`/`PcChips`/`PcPrimaryButton`/`PcGhostButton`、`PcSongTable`、`PcCardGrid`、`PcDetailHeader`、`PcEmpty`/`PcNoticeBar`、`pcCount`/`pcDuration`/`pcDateTime`/`pcSongKey`）。两平台页面同构部分一律走这里，避免两套表格样式漂移。**`pcDuration` 入参是毫秒**（全项目 `Song.duration` 均为毫秒，函数内对 <10000 的值兼容当秒）。
  - `types.ts` — 页面公共契约：`PcActions`（播放/右键菜单/跳转/红心全部回传 TraditionalView，页面不自己造播放链路）、`PcNavTarget`、`PcAccount`、`PcChrome`。
  - 左栏：`QQPcSidebar.tsx`（头像+昵称 → 推荐/我的两个方形位 → 展开/新建虚线位 → 喜欢/最近播放/本地和下载/已购音乐/试听列表（带计数）→ 自建歌单|收藏歌单 + 列表）、`NeteasePcSidebar.tsx`（品牌头 → 推荐/精选/播客/漫游/关注 → 我的分组（我喜欢的音乐/最近播放/我的播客/我的收藏/下载管理/本地音乐/我的音乐云盘/收起）→ 创建的歌单/收藏的歌单 + 列表）。**两个左栏是同步 import**（跟首页同帧出现，切平台不闪空），中栏页面按需懒加载。
  - 中栏：QQ = `QQPcHome`（Hi xx 今日为你推荐：**两格宽猜你喜欢大卡 + 四张一格彩色功能卡（整行等高，卡下两行小字「歌曲 - 歌手 / 栏目标签」，与官方一致）** + 你的歌单宝藏库 + **推荐流其余货架**——bootstrap 之后再后台补两页 feed，按卡片 style 分红：208 单曲卡走 `qqHomeSections.tsx` 的 `PcSongShelf`（官方三列歌曲架，9 首/架），301/302/304 走封面卡网格；听书/节目/直播类整块不渲染）、`QQPcHall`（乐馆：**精选/排行/歌手/分类歌单/视频/频道 六个页签**，精选=轮播+`musicHall` 货架，排行按官方分组渲染富榜单卡，歌手=地区/性别/字母筛选，分类歌单=分类胶囊+歌单网格，视频=`mv/category`+`mv/list`，频道=`/api/qq/radio/channels`+`/api/qq/radio/songs`）、`QQPcProfile`（个人中心：大头像 + 粉丝/关注 + 我喜欢/创建的歌单）、`QQPcCollection`（喜欢/最近播放）；网易云 = `NeteasePcHome`（7 张快捷卡 + 推荐歌单 + 精选活动）、`NeteasePcFeatured`（频道条 + 官方歌单 + 最新音乐 + 排行榜/歌单广场/歌手/VIP）、`NeteasePcPodcast`、`NeteasePcRoam`、`NeteasePcFollow`、`NeteasePcCollection`（我喜欢的音乐/最近播放/我的播客/我的收藏/我的音乐云盘）；共用二级页 `PcPlaylistDetail`、`PcSearch`。
  - **QQ 的数据必须走 PC 侧接口，不能用探索页的聚合数据**（用户实测过：聚合数据来自手机端模块，首页卡片与 PC 客户端对不上）：
    - 首页 Hero 卡 + 每日 30 首 = `features/qqExplore/api.ts` 的 `fetchQQExploreBootstrap()` → `feed.modules[0]`（上游 `music.recommend.RecommendFeed/get_recommend_feed`，模块标题就是「Hi <昵称>  今日为你推荐」，卡片 style：201/203 = 主推大卡、202 = 彩色功能卡、209 = 自定义位；点击按 `card.action.type` 分发：play-radio / play-radar / play-songs / open-playlist / open-preferences）。`daily30` 是「<昵称>的今日私享」，subtype 510 的卡走它打开。
    - 乐馆 = 同一个 bootstrap 的 `musicHall`（10 个货架：编辑甄选/今日尖货/排行榜/数字专辑/明星空降/墙裂推荐/精选视频/更多…），用 `isHiddenQQMusicHallShelf` 过滤掉听书/直播/数字专辑等无关货架。
    - 你的歌单宝藏库 = `/api/qq/songlist/list?id=10000000&pageSize=18`（歌单广场「推荐」分类，卡片形态与客户端一致：标题|副标题）；失败时退回聚合 payload 的歌单。
    - **首页的其余货架（听「X」的也在听 / 「昵称」的专属乐流 / 歌单遨游指南…）也来自同一个 feed**：bootstrap 只给第一页，`QQPcHome` 拿到 cursor 后再串行补两页（`fetchQQExploreFeed`，服务端 `v_cache/v_uniq` 去重），模块按卡片 style 分行渲染（208=三列歌曲架 → `PcSongShelf`；301/302/304=封面卡）。听书/节目/直播（5122/1700/1100/217/85）整块不渲染。
    - **猜你喜欢（电台 99）在首页挂载时就预取一批**（`qqHomeSections.tsx` 的 `prefetchQQGuessYouLike`，按账号隔离 + 5 分钟 TTL），点击直接用缓存开播——官方是秒出声音，之前每次现拉电台再解析歌曲 URL 要 6~7 秒。歌曲架的歌手/曲目在悬停时预取（`prefetchQQModuleSongs`），点整架/播放全部时一次性补全 36 首详情。
    - **乐馆「频道」= 官方音乐电台广场**：`/api/qq/radio/channels` 读官方网页版 `https://y.qq.com/n/ryqq_v2/radio` 的 SSR 数据（`window.__INITIAL_DATA__.radio_list`，10 个分类 118 个频道位，无登录可用，服务端 10 分钟缓存）；点频道走 `/api/qq/radio/songs?id=` 拉该频道歌曲（`mb_track_radio_svr/get_radio_track`，需登录 cookie）。
    - **乐馆「视频」= 三个二级页签（官方：推荐/排行榜/视频库）**：推荐 = 榜单入口卡 + 精选视频货架（musicHall）+ 最新（`/api/qq/mv/list`，pubdate 倒序）+ 热门（MV 榜前 10）；排行榜 = `/api/qq/mv/chart`（**反编译取到的客户端私有模块** `musicToplist.ToplistInfoServer/GetDetail` topId=201，「巅峰榜.MV」，条目带 `vid`，封面按 `T015R640x360M101<vid>.jpg` 规律拼——库的 h5 top 路由对这个榜 502，只有原生调用能出数据；官方页的地区子榜上游无对应参数/topId，未做也未编）；视频库 = `mv/category` 类型+地区筛选 + `mv/list` 网格 + 分页。全部点击走全局 MV 播放器。
    - **乐馆不做「数字专辑」（付费商城）、「音质专区」（反编译：`music.vip.ExcSoundBenefitSvr` 的 VIP 试用/权益页）、「边听边玩」（反编译：`music.gameCenter.MiniGameSvr` 小游戏）**——用户 2026-10-07 明确要求不做购买类内容、不做游戏模块，这三类整页移除且**禁止以后加回来**；musicHall 里的「数字专辑」货架由 `isHiddenQQMusicHallShelf` 照旧隐藏。
    - 「喜欢」页的「歌单」页签 = **收藏的歌单**（`getUserPlaylists` 里 `isCollected`/`subscribed` 的那部分，客户端实测 58 = 我们的收藏数），自建歌单只出现在左栏「自建歌单」列表里。
  - QQ 左栏顶部是**功能位四宫格**：固定「推荐 / 乐馆」+ 用户自加的位（上限 8 个，不含这两个）+ 尾格「+」。点「+」弹「常用功能 / 常听艺人 / 最近常听」面板（官方同款三段式），配置存 localStorage `waveforge:traditional-qq-tiles:v1`。官方面板里的听书 / AI 唱等在本软件没有数据源，不提供。左栏歌单区默认停在「收藏歌单」。
  - **QQ 歌手头像 URL 不要剥掉 `.webp` 后缀**（y.gtimg.cn 去后缀直接 404，历史代码里那处 `replace(/\.webp$/, '')` 是坑）。
  - 后端 `/api/qq/songlist/list` 的参数名必须映射成上游库认的 `category` / `pageNo` / `num`（曾经传 `id`/`page`/`pageSize`，分类与翻页被静默忽略，任何分类都返回「全部」第一页）；该修复在 `local-server.mjs`，**要重启后端进程才生效**。
  - 个人中心在 QQ 平台走 `QQPcProfile`；右栏顶部的账号资料卡在 QQ/网易云下不再渲染（与左栏顶部账号区重复，用户明确要求去掉）。
  - 接线在 `components/TraditionalView.tsx`：`{ name: 'pc'; page: PcPageId }` 页面类型 + `renderPcPage()` 分发；`qq`/`netease` 下 `home`/`search`/`recent`/`playlist` 也路由到复刻页（同一平台只保留一套实现），`currentPage.name === 'pc'` 的来源语义映射到 `traditional-search`/`traditional-library`/… 供播放器返回定位。
  - **没有数据源的能力一律整体下线，不留空壳 UI**（2026-09 需求）：本地音乐、下载管理、已购音乐、试听列表、有声节目/视频、云盘「正在上传」、MV 收藏/已购专辑、歌单级评论与收藏者页签、以及下载/批量/上传/收藏全部这类无功能按钮，都已经从**左栏入口、页签、操作条**三处一起删掉（保留在大括号里的说明性注释，避免以后有人又加回来）。`PcPageId` / `PcNavTarget` / `QQPcCollectionKind` / `NeteaseCollectionKind` / `NeteasePcNavKey` / `QQPcNavKey` 这些联合类型同步收窄——新增页面时先问自己「有没有真实数据源」，没有就别加类型、别加入口。
  - **⚠️ 传统模式验收标准（2026-10-07 用户要求，长期有效）**：**「官方客户端长什么样，我们传统模式就得是什么样；功能要齐全，不许猜、不许编，所有呈现出来的东西都必须是可用的」**。推论：① 官方有的页签/二级三级菜单/卡片形态，我们要有（并覆盖交互逻辑）；② 数据必须来自真实接口，拿不到就先把数据源逆向出来，**绝不用假数据或近似数据充数**；③ 渲染出来的每个按钮/卡片点下去都要有真实行为（`onPlaySongs`/`onOpenPlaylist`/`onOpenAlbum`/`onOpenMv`/跳页签/开 H5），不留死按钮；④ 官方那两页目前确实没有网关数据源的（乐馆「音质专区」「边听边玩」——客户端专有营销/互动页，扫过 220 个货架 id 都没有对应 shelf），**要么继续逆向出接口再做，要么明确向用户报备不做，不许自己编内容顶上**。
  - 红心状态走 `services/favoriteStatusService`（`peekSongFavoriteStatus` + `loadFavoriteIdentifiers`）；它没有事件总线，所以 `TraditionalView` 在喜欢/取消喜欢后 bump `favoriteRevision` 让表格重算。**「喜欢/我喜欢的音乐」的歌曲列表只能走 `isLike` 歌单 + `fetchExplorePlaylist`**——`getLikedSongs` 仅返回 id/mid 标识符列表，不含歌曲对象。
  - **Apple Music 客户端复刻（2026-10-08 用户要求）**：官方 Windows 客户端（`AppleInc.AppleMusicWin`，WinUI 3 + 内容层 WebView2）的左栏与中栏照客户端复刻，**右侧第三栏保留**（用户明确：客户端顶栏的播放控件不复刻，播放控件用本软件第三栏）。文件：`ApplePcSidebar.tsx`（左栏：搜索框 272×32 / 主页 / 广播 / 可折叠「资料库」四项 / 可折叠「播放列表」两项 / 底部账号；行高 36、子项缩进 31px、选中胶囊 #eaeaea + 左缘 3px 品牌红——尺寸与配色取客户端 UIA 树与截图实测，浅色底 #f3f3f3 / 内容 #eeeeee / 表格行 #f9f9f9 隔行 / 文字 #252525 / 次级 #7a7a7a）、`applePcKit.tsx`（客户端基件 + 歌曲表：标题/时长/艺人/专辑/类型/★/播放次数，行高 40、隔行、行内「⋯」接全局歌曲右键菜单、表头点击排序、工具条「过滤/显示选项」都是真功能）、页面 `ApplePcHome.tsx`（含**未订阅时的订阅广告页**）/ `ApplePcRadio.tsx`（广播：大电台卡 +「风格电台」方卡货架）/ `ApplePcLibrary.tsx`（最近添加/艺人/专辑/歌曲）/ `ApplePcPlaylists.tsx`（所有播放列表/喜爱歌曲）。另有 `ApplePcSearch.tsx`：**点搜索框先进「类别浏览」**（与客户端/官网一致）——复用探索模式的 `AppleMusicSearchPage` + `BrowseCategoriesLanding`，只外面套客户端版式；搜索落地（`/v1/recommendations/{sf}?name=search-landing`）在无会员下也正常（实测 48 个类别）。数据一律走探索页同一批 Apple 接口（`appleWebService` / `appleCatalog`），不新增数据通道；**主页兜底歌单封面**：RSS 的 `artworkUrl100` 对部分歌单只有低清母版（实拍发虚），`getAppleEditorialPlaylists` 已按 `pl.` id 批量补一次目录（`/v1/catalog/{sf}/playlists?ids=`，**该端点不许带 limit**，实测 400）取 `{w}x{h}` 模板；**电台大卡（`ApplePcStationShelf`）是响应式网格、不是固定像素宽**：客户端那排 500px 大卡是「窗口 1904px 下的内容区 1/3」，我们中栏更窄，固定宽度会变成一屏 1~2 张的巨图——所以用 `xl:grid-cols-3` 等分（`columns={2}` 给推荐单集宽幅卡），比例仍 500/324。**Apple 广播/编辑封面按源图比例取图**：电台类源图是 4320×1080 宽幅合成图（字标烤在画面里），方裁（600×600cc）会把字裁掉——`extractEditorialArtworkUrl`/`artworkUrlForCard` 对宽高比 < 0.6 的源图按 16:9（960×540）请求，`[385]→[394]` 节目卡优先用 394 元素自带的 artwork（contents 里的 radio-shows 无图）。****封面尺寸类必须挂在 `ApplePcCover` 的最外层容器**（图片层 absolute 铺满）——挂图片上时图片一失败卡片就塌成 alt 文本；`CachedImage` 在 `retainPrevious` 下失败且无旧图可显示时会清空 `imageSrc` 走 fallback（别改回去，否则浏览器破图会常驻）。**本机 `/api/cover` 等 3001 路由需要 `X-WaveForge-Local-Token`（只有 Electron 信任窗口由主进程注入）——在浏览器里看本 UI 时 CDN 封面会全 403，排查封面问题时先确认是在应用窗口里看的。**「类型/播放次数/添加日期」三列只在 resource 真带这些字段时显示（`mapAppleLibraryTrack` 透传，缺则不摆空列）。**订阅广告**文案用客户端自带本地化串（`FUSE.Upsell.Generic.Headline.FreeTrial`「尽是你爱听的音乐。」+ `FUSE.Upsell.Generic.Body.FreeTrial` + `FUSE.Upsell.SignUpOptimization.Generic.Trial.CTA`「免费试用」），**不要改写**；点「免费试用」调 `services/appleSubscribe.ts` → Electron IPC `apple-subscribe` 打开站内购买窗口（地址 = 客户端购买窗口真实地址 `finance-app.itunes.apple.com/subscribe`，取证自客户端 WebView2 会话缓存；Web/TV 回落系统浏览器）。资料库/歌单/专辑/歌手详情沿用 PC 复刻详情页（`PcSkin` 新增 `'apple'`：红色强调、无 QQ/网易云角标、头图 200px）；Apple 的 ★ 判定走 `getAppleFavoriteSongIds`（`favoriteStatusService` 只覆盖 QQ/网易云），在 `TraditionalView` 里预取成 `appleLovedKeys` 并随 `favoriteRevision` 刷新。
  - **广播页与主页的内容区直接嵌入探索面板**（`<AppleExplorePanel initialTab="radio|home" chrome="none" …/>`，2026-10-08 用户要求「把探索页的布局搬过来，别自己画」）：面板新增 `initialTab`/`chrome` 两个开关；传统页与探索页的卡片/货架/抽屉/动态封面因此共用同一实现，**不要再自绘货架**（原先自绘的 Station/Card shelf 已删除）。播放/右键菜单回 `pcActions`，歌单/专辑/艺人详情走传统页既有页面。
  - 验证：`test/TraditionalView.test.tsx` 覆盖复刻外壳（左栏分组、复刻页渲染、客户端搜索页、历史导航、来源语义）；改这里先跑它。Apple 复刻另见 `test/ApplePcTraditional.test.tsx`（左栏结构 / 订阅广告 + 购买窗口 / 广播版式 / 歌曲表列与过滤 / 订阅失效续订态 / 主页广告卡+兜底货架）。**动态封面**：`src/components/apple-explore/MotionArtwork.tsx`（`MotionArtworkCover` / `DynamicCover` / `MotionSuspendContext`，从 `AppleExplorePanel` 于 2026-10-08 抽出后两边共用）——`applePcKit` 的 `ApplePcCover` 传 `motion`（用 `motionSpecOf(item, storefront)` 生成：要求目录 id，`i./l./p./ra.` 前缀会被服务层挡掉）即可给卡片/Hero 加 HLS 动画封面；四个 Apple 页都包了 `MotionSuspendContext.Provider`（`suspended` 时回收媒体）。**电台（stations）没有动态封面且探索页同样没有**（服务层 `APPLE_LIBRARY_ID_PATTERN` 把 `ra.` 前缀一并早退，而目录电台 id 也是 `ra.`；Apple 对这批 station 资源也不返回 editorialVideo）——要动就得同时改服务层与探索页，别只改一边造成两边不一致。逐页视觉核对可用根目录 `.tmp-pcshots.mjs`（CDP 驱动，`node .tmp-pcshots.mjs qq|netease <tag>`，产物写 `D:\opencode\pcs-<tag>-*.png`）；Apple 复刻页用 `.tmp-appleshots.mjs`（`node .tmp-appleshots.mjs <tag> [cdpPort]`，跑完恢复原 viewMode/平台），要「有数据 + 浅色 + 动态封面」版式时用 `.tmp-appleshots-data.mjs <cdpPort> [tag]`（注入 amp-api fetch 桩，含 `editorialVideo` 动态封面响应，仅验证版式），要在真机账号上端到端核对用 `.tmp-applelivedrive.mjs`（在运行中的应用里临时切平台 → 逐页截图 → 切回原平台）。对 Apple 客户端自身的零干扰取证脚本在 `.tmp-zoom/applectl.py`（PrintWindow 截图）/ `apple_uia2.py` / `apple_nav.py`（UIA 只读遍历）；注意客户端侧栏导航只认真实指针输入（PostMessage 与 UIA Select/DoDefaultAction 都不触发 ItemClick），要点击得用 `applectl.py` 同族的置顶 + SendInput 点击（`apple_click3.py`，点到后立刻恢复 z 序与前景窗口）。
  - **⚠️ Apple 账号内容在「会员过期」下的边界（2026-10-08 实测，别再重复踩）**：`/v1/me/library/*`（**含 `recently-added`**：资料库/最近添加/专辑/艺人/歌曲/歌单）与 `/v1/me/recent/played`（听歌历史）对**会员失效**的账号返回 `400 / 40015 Insufficient Privileges: CloudLibrary / ListeningHistory`——**Web 侧（media-user-token）无解，换参数也没用**；`/v1/me/recent/radio-stations`（最近收听的电台）与 `/v1/me/account` 仍 200 ✓。公开内容不受影响：`editorial/{sf}/groupings?name=radio|browse`（广播 13 个货架、新发现）、`catalog/{sf}/charts` 都能拿到真实数据，主页在订阅失效时也会返回 **2 个公开兜底货架**（今日热选 / 编辑精选歌单）+ `subscriptionExpired`。官方 Windows 客户端的资料库走的是**另一条通路**：iTunes iCloud Library（DAAP / `MZDaap`，服务地址见 `init.itunes.apple.com/bag.xml?ix=6` 的 `library-daap`/`iap-daap`），用的是**客户端级 Apple ID 认证**（DSID/guid/passwordToken，`radio.itunes.apple.com/libraryauth/token` 要 dsid+guid；客户端包里 `AMPLibraryAgent.exe` 有 `passwordToken`/`X-Apple-Store-Front`/`session-id`）。我们登录窗抓到的是 Web 会话（media-user-token + itunes 网域 cookie，`buy.itunes…accountSummary` 对它返回 `AccountSummaryLoginRequired`），**没有 CloudLibrary 权限也没有 DSID**。客户端本地库 `%USERPROFILE%\Music\Apple Music\Apple Music Library.musiclibrary\Library.musicdb` 是私有格式（非 SQLite），不要试图读它当数据源。因此资料库页在无会员时**必须**渲染 `ApplePcSubscriptionNotice`（标题 + 客户端官方说明「当你的会员资格暂停后…但不能播放或修改」+ 服务层具体原因 + 「免费试用」进购买窗口 + 重试），**不许**退化成「空空如也」或编造内容；主页则必须是「订阅广告（有兜底内容时收成卡片）+ 兜底货架」。失败原因统一由 `appleCatalog.getLastAppleMeFailureMessage()`（内部走 `describeAppleApiFailure`，非 strict 分支也会记录）透出给页面。
  - **⚠️ 「为什么不能复用客户端的登录」——结论已定，别再试（2026-10-08 用户提问后核实）**：客户端（Apple Music Windows 应用）自己的凭据存在**它私有的加密仓库**里：`LocalCache\Local\Apple\SC Info\`（一堆 600 字节高熵加密块）、`LocalState\Apple\CS\AppleMusic\mspr.hds` / `..._....msprhw.hds`（MB 级加密资料库/凭据数据，用户的「最近添加」内容就在其中但已加密）。它的资料库通道（iCloud Library / DAAP）绑定的是 **Apple 自己的客户端身份**（AppleMediaServicesKit + Apple 签名客户端）。所以「复用客户端登录」= 从另一个应用的私有凭据库里提取/解密用户的 Apple 账号密钥去冒充 Apple 自家客户端——**不做**：① 这正是杀软/EDR 定义的凭据窃取行为，会被查杀且违背本仓库合规口径；② 令牌由 Apple 轮换，轮换后静默失效且无受支持刷新路径；③ 绕过的是 Apple 授权的客户端身份。而**复用我们自己的 Web 登录**已经做到了（所有请求都带同一个 media-user-token），Apple 的回答是 40015「订阅档位无 CloudLibrary 权限」——**卡在账号订阅档位，不是登录方式**，再登录一次也没用。
  - **⚠️ 「客户端同级登录 + iCloud 资料库(DAAP)」可行性已验：不可行，别再投（2026-10-08，用户点选后执行）**：① 客户端二进制里**没有 DAAP 主机/路径字面量**（`MZDaap` 只出现在 bag 操作名数组：`defaultDaap/databases/items/containers/edit/update/cloudArtworkInfo/cloudLyricsInfo`…），地址只在**账号个性化 bag** 里；`init.itunes.apple.com/bag.xml?ix=6` 只给了购买 DAAP（`pd.itunes.apple.com/WebObjects/MZPurchaseDaap.woa/iap|purchase`），`library-daap` 只有 database-id/name；② 客户端请求带 **AMS 签名头**：`X-Apple-ActionSignature` / `X-Apple-FPDISignature` / `X-Apple-MD*` / `X-Apple-AMD*` / `X-Apple-ADSID` / `X-Apple-Client-Application`（由 Apple 客户端代码 + FairPlay 设备身份生成）；③ 用现有 Web 会话打 `pd.itunes.apple.com` / `p14-buy.itunes.apple.com` 的 `/WebObjects/MZDaap.woa/wa/*` 全是 404，`p57-itunes.apple.com` 等主机不存在；④ Apple 给第三方的官方接口（我们用的 amp-api）本就把 `/v1/me/library/*` 对失效订阅判 40015——「无订阅读资料库」是 **Apple 客户端专属能力**。复刻要么冒充 Apple 客户端/伪造其签名（越界 + 需收集 Apple ID 密码），要么猜地址（无目标可猜）。**维护 Apple 资料库相关功能时不要再走这条路**；证据与完整步骤见 `HANDOVER.md` 27.2，扫描脚本 `.tmp-appledaap-strings.py`。
  - **⚠️ 诊断 Apple 接口时别被本机 3001 的令牌门骗了**：应用内浏览器回退路径会先打 `http://localhost:3001/api/apple/amp`，那里有令牌校验 → 返回 **403「Apple Music 登录已过期」**，这是**本地服务**的失败而不是 Apple 的。判断 Apple 真实返回要么走主进程 IPC（`window.electron.appleApi`），要么直连 `https://amp-api.music.apple.com`（Node/Service 层直连无 CORS；`.tmp-appleprobe3.mjs` 逐端点探测、`.tmp-appletrue.mjs` 浏览器端重写 fetch 直连）。
- `src/components/foliaDiorama/` — **多维歌词 Diorama 模式**（`MultidimensionalLyrics.tsx` 入口，适配 MV 背景设置：Canvas 透明 + 内置背景退场）：`DioramaScene.tsx`（3D 场景）、`FoliaDioramaLyrics.tsx`、`dioramaSpectrum.tsx`（频谱）、`dioramaTextRaster.ts`（文字光栅化）、`useDioramaSequencer.ts`（序列编排）。性能关键：React Three Fiber 用 `frameloop="always"`（勿改回 `demand`——会导致画面几乎不更新；也无需手动限 120fps）。设计文档 `docs/DIORAMA_UPDATE_20260826.md`。
- `build/` 打包资源 — 不止 icon：**自定义 NSIS 安装器 UI 资产**（`installer.nsh` + `installerHeader/Sidebar.bmp` 等主题图 + `ui/`、`ui-clone/` 中文按钮/页面 bmp），由 `scripts/generate-installer-art.mjs` / `generate-installer-ui.mjs` / `generate-installer-clone.mjs` 生成；预览用 `node scripts/preview-setup.mjs`（独立 NSI 在 `scripts/setup-preview/preview.nsi`）。改安装器视觉先跑生成脚本再构建。
- **汽水音乐平台（Soda/Qishui）**：从独立项目 `temp/SodaMusic_Qishui_Code` 移植的第三音源（字节系汽水音乐），**仍在适配中**。后端：`server/qishui-api.mjs`（`registerSodaRoutes(app)`，全部 `/api/soda/*` 路由 + `sodaRequestCookie` 请求级 cookie 约定）、`server/qishui-audio-decryptor.mjs`（加密音频解密代理）；登录：`desktop/qishui-auth-v6.cjs` + `desktop/main.cjs` 汽水登录窗 + `src/components/SodaLoginPanel.tsx`；前端：`src/services/sodaService.ts`、`platforms.ts` 里 `MusicPlatform` 含 `'soda'`。**登出全链清理**走 IPC `soda-clear-login`（preload `clearSodaLogin`：清 auth 分区 + 凭据文件会话字段）；TV/非 Electron 端支持手动粘贴 Cookie 登录（SodaLoginPanel 折叠区）。**移植来源快照在 `temp/`（只读参考，勿 import、勿运行）**：`temp/SodaMusic_Qishui_Code`（原项目全量代码，对照适配缺口用）、`temp/hypersoundengine`（HSE UI 设计参考稿）、`temp/waveforge-engine-v3`（引擎独立仓副本）。改汽水业务前先对照 temp 原版实现核对上游接口细节。
- `desktop/main.cjs` 还含 **QQ音乐 QMK API Key 领取窗口**（`QMK_OFFICIAL_KEY_URL` y.qq.com；独立 session partition `waveforge-qq-skill-key`，每次打开前清空避免复用登录态）——编辑时保留隔离分区与导航守卫逻辑。
- `scripts/` — dev 启动器（`dev-electron.mjs`、`start-api.mjs`、debug/hidden VBS）、`bundle-python.mjs`（重建嵌入式 Python）、`build-android-assets.mjs` / `fetch-nodejs-mobile.mjs` / `publish-release.mjs`（Android 与发布）、`sync-afdian-sponsors.mjs`、`test-device-license.cjs`。
- `python-beat-service/` — Flask beat analysis (port 3002) for Smart AutoMix; app degrades to Fixed Crossfade when down. `loudness_server.py`（port 3003）为独立响度测量服务（`/lufs`，响度归一化用）；`compensation_server.py`（port 3004）为独立频响补偿设计服务（`/compensation`，ISO 226 简化等响度模型 + 场景预设 + 自定义频段 → 多段 Biquad 参数）。三服务完全解耦、三入口（dev-electron.mjs / main.cjs / launchers/start-full.bat）同模式拉起。三服务均已做性能优化：beat 缓存清理 60s 节流、loudness 分段积分向量化 + 测量磁盘缓存（256MB/30 天）、线程并发（threaded=True）。
- **开发 profile 迁移**：旧开发版可能把设置和登录态写在 `%APPDATA%/Electron/`。`desktop/user-data-profile.cjs` 会在 Windows 开发启动前将明确属于 WaveForge 的持久化数据一次性迁到 `%APPDATA%/WaveForge 澜音工坊/`；旧目录始终保留，目标冲突数据备份到稳定目录内的版本化 migration backup。迁移必须在 `dev-electron.mjs` 读取配置、启动后端以及 `main.cjs` 调用 `app.setPath('userData')` 之前完成。不要改回直接使用通用 Electron profile，也不要无过滤复制 Cache、日志、运行锁或任意站点数据。
- **Git repo** (has history — use `git log`/`git blame`; rollback via `git reset`). 根目录 `/data/`、`/cache/`、`/logs/`、`/dist/`、`/release/` 是被忽略的运行时产物（规则已锚定根目录，含义见下方 Conventions 的 .gitignore 约定）。

## Workspace and repository roots

WaveForge is developed by multiple people, AI agents, and computers. Local directory layouts are intentionally not uniform:

- **Direct-root layout:** the developer's working directory is the WaveForge repository root.
- **Multi-project layout:** an AI or developer workspace contains several projects, and its direct `WaveForge/` child is the repository root.
- The remote repository always stores project files at its repository root. A clone into a local `WaveForge/` directory naturally maps that remote root into the local child directory; do not change the remote layout to mirror a parent workspace.

Before any Git operation, edit, test, build, launch, synchronization, merge, release, or version change:

1. Check only two root candidates, in order: the current directory, then its direct `WaveForge/` child.
2. A candidate is WaveForge only when it contains all three markers: `package.json`, `scripts/dev-electron.mjs`, and `desktop/main.cjs`. When Git metadata is present, also run `git rev-parse --show-toplevel` inside that candidate and keep every operation inside the returned root.
3. Never recursively search for a directory named WaveForge or select similarly named copies such as `WaveForge-clean-check`, `WaveForge-master-hotfix`, temporary exports, or build output.
4. If neither candidate is valid, or if nested `.git` directories or multiple plausible repositories are found, report the candidates and stop for explicit user confirmation. Do not infer a root from the shell directory, parent directory name, or a machine-specific absolute path.
5. Never move, copy, delete, stash, reset, merge, commit, or restore one repository's files into another repository merely to reconcile different local layouts.

For multi-developer, multi-computer, and multi-worktree collaboration, uncommitted changes belong to their current working tree unless explicitly handed off. Before synchronization or publishing, verify the selected root's `git status --short --branch`, branch, remotes, and `git worktree list`. Commands documented as bare `npm run ...` assume the terminal is already inside the verified WaveForge root; external automation should prefer `npm --prefix "<verified-root>" run ...`.

## Conventions

- **⚠️ .gitignore 目录规则必须锚定根目录（全部电脑统一执行的约定）**：忽略根目录产物写 `/data/`、`/cache/`、`/tmp/`、`/logs/`、`/dist`、`/release`，**禁止写裸 `data/` 这类不锚定规则**——它会匹配任意层级的同名目录。2026-09 事故：裸 `data/` 把 `src/data/bilibiliMvDeclarations.ts` 连坐忽略，5a6cc58 后文件只存在于提交者本地，master 全新 clone 构建失败。例外：Python 运行时产物（`__pycache__/`、`venv/`、`*.py[cod]`）确实出现在任意层级，保持不锚定。`src/data/` 内手写源码必须入库，仅 `src/data/*.generated.json`（prebuild 再生成）忽略。
- **守卫（防同类事故，三层防线）**：① `npm run check:git`（`scripts/check-ignored-source.mjs`：src/ test/ scripts/ server/ desktop/ shared/ resources/ python-beat-service/ python-apple-bridge/ 内不允许存在「被 .gitignore 忽略的源码」或「未 git add 的源码」；可再生产物 src/generated/、*.generated.json、python-beat-service/packages/、resources/python-embed/ 白名单放行）；② pre-push 钩子自动跑同一检查（首次 clone 后执行一次 `npm install` 自动启用，等价 `git config core.hooksPath .githooks`）；③ CI 快速检查 job 的「守卫检查」步骤（npm ci 前先跑，失败立现红叉）。**其他电脑拉取本仓库后务必跑一次 `npm install`** 以启用 pre-push 钩子；CI 与 .gitignore 修复随 git pull 自动统一。

- **Relative imports everywhere** — `@/` alias is configured but unused; match the `./`/`../` style.
- **No ESLint** — `npm run lint` is typecheck only. Strict TS in `src/`.
- **Use `debugLog()` (src/utils/debugLog.ts) instead of `console.log` in hot paths** — gated behind `localStorage['waveforge:verbose-log']` to avoid console memory growth.
- **Files must be UTF-8** — Windows encoding issues previously broke Chinese UI text（曾出现 GBK 误读乱码，含正则字符类损坏）。
- **性能基线（已完成的优化，勿回退）**：三视图/弹窗/列表行组件 memo + latest-ref 稳定回调（`viewCallbacks`/`stableDialogCallbacks`）；过渡进度 30fps 节流；评论/艺人列表 react-window 虚拟化；封面代理流式转发；`/api/cover`、`/api/proxy-image` 经 `streamProxyImage()` 流式（不整读进内存）；后端 gzip（compression 中间件，filter 排除 image/video/audio）；axios keepAlive；Python 服务缓存清理节流/向量化。
- Ports: 3000 Vite / 3001 backend (127.0.0.1, CORS allows only localhost:3000, file://, null origins) / 3002 Python beat / 3003 Python loudness / 3004 Python compensation.

## Backend security invariants (do not break when editing)

- **Electron 主进程**：所有窗口（主窗口/桌面播放器/歌词窗）都挂 `guardAgainstExternalNavigation()`（will-navigate 拦截外部跳转）；QQ QMK 领取窗口是唯一被允许打开 `y.qq.com` 的窗口——不要为其他窗口放宽守卫。
- `/api/cover` and `/api/proxy-image` have an SSRF guard blocking private/loopback/link-local IPs and DNS names resolving to them. **The internal proxy chain `proxy-image → cover` is legitimate**: guard must keep allowing `localhost:3001` (the app's own origin) — inner `/api/cover` still validates the final CDN target, so blocking localhost:3001 would break comment/playlist avatars.
- `/api/wallpaper-engine/preview` & `/media` enforce path containment under the WE base dir (resolve + startsWith(base+sep)).
- **Netease xeapi**: `initNeteaseAPI()` in local-server.mjs calls the lib's `generateConfig()` at startup to register an anonymous token and fetch the xeapi public key (cached in `os.tmpdir()/xeapi_public_key`). If `/api/netease/song/url` starts returning `xeapi public key is missing`, the tmp cache was cleared — restart the server.
- **QQ 播放/写操作 cookie**：播放类路由（song/url、mv/url、mv/detail、comment、user/detail 等）用 `resolveRequestCookie(cookie)` 只读不写全局；写操作（like、playlist/tracks、subscribe、artist/subscribe）一律传请求级 cookie 并 `cookie || qqMusicCookie` 回退。改 cookie 逻辑时保持此单事实源约束。

## Read before touching

- `README.md` — feature map (seamless gapless modes, lyrics, visualizers, desktop/wallpaper mode).
- `HANDOVER.md` — 交接文档：项目状态、环境、已知问题、未决事项、历史决策（每次大改后更新）。
- `CONTEXT.md` — 音效域词汇表（效果/场景方案/自定义状态/频响补偿等术语定义）。
- `LICENSE_SYSTEM.md` — device licensing (Ed25519; generator is a **separate** project, never rotate keys casually).
- `CACHE_SYSTEM.md` — IndexedDB cache design; `CachedImage` double-buffering.
- `AFDIAN_SPONSORS.md` — 爱发电赞助配置/流程（`sync:sponsors` 的数据源说明）。
- `CODEX_RECENT_PLAYBACK_CHECKPOINT.md` — 近期播放/恢复相关的开发检查点记录。
- `PROJECT_HISTORY.md` — historical dev milestones / Phase 2 planning (archive; don't treat as current spec).
- `WALLPAPER_GUIDE.md` / `DESKTOP_MODE.md` — wallpaper & desktop-mode feature docs.
- `PYTHON_EMBEDDING_GUIDE.md` — embedded Python build/rebuild process.
- `docs/歌词对比-LyricsBlossom.md` — Apple Music 歌词逆向对比分析（Apple 逐字模式参考）。
- `DEVELOPMENT-CONSENSUS.md` — ⚠️ **TV/平板/手机端开发共识（必读）**：功能随 PC 大版本发布、"设置→检查更新"正常；Dev 阶段前端改动用内置无线调试（:3002）热更新快速验证（`node scripts/push-hot-update.mjs <设备IP> --rebuild`），无需重装 APK；后端/原生改动需重装 APK。
