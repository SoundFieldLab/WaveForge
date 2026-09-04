# AGENTS.md — WaveForge 澜音工坊

Desktop music player (Windows/Electron) for QQ Music + NetEase Cloud Music. Frontend React 19 + TypeScript + Tailwind CSS 4 + Vite 6, backend Node/Express, Python beat-analysis service for DJ-style gapless playback. UI text and code comments are predominantly **Chinese** — keep new user-facing strings consistent with the existing language. 仓库同时含 **Android TV**（`android/` + `src/tv/`，构建脚本 `build:android`）与 **Apple 歌词/探索分支**（`src/components/Apple*`）——改桌面端时勿破坏多平台分支。

## Commands

```bash
npm run dev:electron     # Full dev: Vite (3000) + API server (3001) + Electron window
npm run dev              # Vite dev server only (port 3000)
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
start-full.bat           # One-click: Python beat (3002) + loudness (3003) + compensation (3004) + app
test-python-service.bat  # Health-check Python service on port 3002
```

注意：`prebuild` 钩子会在每次 `build`/`build:electron` 前自动运行 `sync:sponsors --optional`（需 `WaveForge-Afdian.env` 爱发电密钥文件，缺失时 `--optional` 软失败，不影响构建）。

Python beat service runs on **port 3002** (not 5001 — historical docs are stale). Offline wheel cache in `python-beat-service/packages/` is cp313 and matches the embedded 3.13 runtime; `start.bat` installs from it with `--no-index --find-links=packages`.

**响度测量服务**：`python-beat-service/loudness_server.py`（独立于节拍服务，**端口 3003**，`/lufs` 端点返回 ITU-R BS.1770 积分响度）。响度归一化（调音室开关）按曲目调用它；该服务未运行/失败时归一化自动回退原声，不影响播放。启动入口：dev 模式 `dev-electron.mjs` 自动拉起；打包版 `main.cjs` startLocalBackend() 用嵌入式 Python spawn；手动 `start-full.bat` 同起。

**频响补偿设计服务**：`python-beat-service/compensation_server.py`（独立于节拍/响度服务，**端口 3004**，`/compensation` 端点）。按简化等响度模型（ISO 226 理论 + 音量→SPL 线性映射，非逐点查表）把目标补偿曲线离散为多段 Biquad 滤波器参数（lowshelf / peaking / highshelf）：auto 模式 = LowShelf(120Hz, Q0.707, 0-12dB) + HighShelf(12000Hz, Q0.707, 0-6dB)，增益按系统音量线性（低频系数 0.35、高频 0.15，100%→0/0、50%→约+5/+2、10%→约+9/+4），只提升不衰减、中频保持 0dB；preset 模式 = 6 预设（监听平直/低频补偿/人声突出/温暖/通透/夜间温和，低频 shelf + 0-2 温和中频 peaking + 高频 shelf）；custom 模式 = 5 独立频段 peaking（±8dB）。前端 `src/services/audio-effects-v2/compensationService.ts` 调 `http://localhost:3004/compensation`，用 Web Audio BiquadFilterNode 构建补偿链。启动入口与 3003 相同：dev 模式 `dev-electron.mjs` 自动拉起；打包版 `main.cjs` startLocalBackend() 用嵌入式 Python spawn；手动 `start-full.bat` 同起。服务未运行/失败时引擎回退到内置近似补偿，不影响播放。

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
- `src/components/foliaDiorama/` — **多维歌词 Diorama 模式**（`MultidimensionalLyrics.tsx` 入口，适配 MV 背景设置：Canvas 透明 + 内置背景退场）：`DioramaScene.tsx`（3D 场景）、`FoliaDioramaLyrics.tsx`、`dioramaSpectrum.tsx`（频谱）、`dioramaTextRaster.ts`（文字光栅化）、`useDioramaSequencer.ts`（序列编排）。性能关键：React Three Fiber 用 `frameloop="always"`（勿改回 `demand`——会导致画面几乎不更新；也无需手动限 120fps）。设计文档 `docs/DIORAMA_UPDATE_20260826.md`。
- `build/` 打包资源 — 不止 icon：**自定义 NSIS 安装器 UI 资产**（`installer.nsh` + `installerHeader/Sidebar.bmp` 等主题图 + `ui/`、`ui-clone/` 中文按钮/页面 bmp），由 `scripts/generate-installer-art.mjs` / `generate-installer-ui.mjs` / `generate-installer-clone.mjs` 生成；预览用 `node scripts/preview-setup.mjs`（独立 NSI 在 `scripts/setup-preview/preview.nsi`）。改安装器视觉先跑生成脚本再构建。
- **汽水音乐平台（Soda/Qishui）**：从独立项目 `temp/SodaMusic_Qishui_Code` 移植的第三音源（字节系汽水音乐），**仍在适配中**。后端：`server/qishui-api.mjs`（`registerSodaRoutes(app)`，全部 `/api/soda/*` 路由 + `sodaRequestCookie` 请求级 cookie 约定）、`server/qishui-audio-decryptor.mjs`（加密音频解密代理）；登录：`desktop/qishui-auth-v6.cjs` + `desktop/main.cjs` 汽水登录窗 + `src/components/SodaLoginPanel.tsx`；前端：`src/services/sodaService.ts`、`platforms.ts` 里 `MusicPlatform` 含 `'soda'`。**登出全链清理**走 IPC `soda-clear-login`（preload `clearSodaLogin`：清 auth 分区 + 凭据文件会话字段）；TV/非 Electron 端支持手动粘贴 Cookie 登录（SodaLoginPanel 折叠区）。**移植来源快照在 `temp/`（只读参考，勿 import、勿运行）**：`temp/SodaMusic_Qishui_Code`（原项目全量代码，对照适配缺口用）、`temp/hypersoundengine`（HSE UI 设计参考稿）、`temp/waveforge-engine-v3`（引擎独立仓副本）。改汽水业务前先对照 temp 原版实现核对上游接口细节。
- `desktop/main.cjs` 还含 **QQ音乐 QMK API Key 领取窗口**（`QMK_OFFICIAL_KEY_URL` y.qq.com；独立 session partition `waveforge-qq-skill-key`，每次打开前清空避免复用登录态）——编辑时保留隔离分区与导航守卫逻辑。
- `scripts/` — dev 启动器（`dev-electron.mjs`、`start-api.mjs`、debug/hidden VBS）、`bundle-python.mjs`（重建嵌入式 Python）、`build-android-assets.mjs` / `fetch-nodejs-mobile.mjs` / `publish-release.mjs`（Android 与发布）、`sync-afdian-sponsors.mjs`、`test-device-license.cjs`。
- `python-beat-service/` — Flask beat analysis (port 3002) for Smart AutoMix; app degrades to Fixed Crossfade when down. `loudness_server.py`（port 3003）为独立响度测量服务（`/lufs`，响度归一化用）；`compensation_server.py`（port 3004）为独立频响补偿设计服务（`/compensation`，ISO 226 简化等响度模型 + 场景预设 + 自定义频段 → 多段 Biquad 参数）。三服务完全解耦、三入口（dev-electron.mjs / main.cjs / start-full.bat）同模式拉起。三服务均已做性能优化：beat 缓存清理 60s 节流、loudness 分段积分向量化 + 测量磁盘缓存（256MB/30 天）、线程并发（threaded=True）。
- **Git repo** (has history — use `git log`/`git blame`; rollback via `git reset`). `data/`, `cache/`, `logs/`, `dist/`, `release/` are ignored runtime artifacts.

## Conventions

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
