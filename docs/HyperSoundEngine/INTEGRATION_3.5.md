# HSE 3.5 主程序接入摘要

更新：2026-10-20　分支：`codex/hse-35-main-integration`　仓库：WaveForge 澜音工坊

> 本文是 **HSE 3.5 接入的摘要与索引**，不是验收报告。接入范围、文件映射、证据索引、测试基线与未完成边界如下；逐项对照原文、能力清单与已取消项见同目录归档副本 [MAIN_APP_INTEGRATION_HANDOVER.md](./MAIN_APP_INTEGRATION_HANDOVER.md) 与 [UPDATE_3.5.md](./UPDATE_3.5.md)。
>
> 交接原文位于 `temp/hse-optimise/MAIN_APP_INTEGRATION_HANDOVER.md`，但 **`temp/` 已被 git 忽略（`.gitignore` 中 `/temp/`）**，不随仓库分发，也禁止在运行时 import/依赖；入库版本是本目录的归档副本。快照本身仅作只读参考，接入完成后按用户要求保留到确认无误。
>
> **2026-10-20 验收结论**：源码/构建/测试/真实 Electron/打包 file:// 五个门禁全部通过，最终计数与本轮验收发现/修复见 §4、§5；完整验收报告为工作区 `.verification/hse35-integration/ACCEPTANCE.md`（`.verification/` 已 gitignore）。

## 1. 接入摘要

HSE 3.5 = `temp/hse-optimise` 独立快照（2026-10-17 起在 `temp/` 内打磨）整快照回流主程序：DSP 内核、空间后端、Worklet、宿主、九页 UI、融合层、ReplayGain 曲目生命周期、多声道输入、WAV+MP3 导出、头追桥 IPC 与测试收集一次接入，不改 v1/v2 引擎、Android TV 与 Apple 分支。

| 范围 | 接入结果 |
| --- | --- |
| DSP 内核 | `EngineV3` 改为引擎自有快照结构化 `setParams`（删除深拷贝与 `JSON.stringify` 比较，22 个逐模块变更标志）；新增 14 个 DSP 模块：动态均衡、Crossfeed、多段压缩模式、ReplayGain、`PcmQuantizer`/`PcmWav`、`audioBuffer`、`ChannelDownmix`、`ConvolutionIrLibrary`、`EffectTransition`/`SampleRamp`、低频管理/次声高通，以及 `vectorKernel`/`wasmSimdKernel`；既有 9 个音色/动态模块的 `processingOrder` 保留，整链固定边界；内部逐位旁路（bit-perfect bypass）保留 |
| WASM SIMD | `src/dsp/wasmSimdKernel.ts` 运行时自研生成约 370 字节 WASM 模块（f32x4/f64x2 复数乘法），无第三方工具链、不 fetch 外部 `.wasm`；`vectorKernel.ts` 为门面（f32 阈值 256 / f64 阈值 512，低于阈值或环境不支持静默回退纯 TS）；f64 与 double 逐位一致，f32 输出改为逐步 `Math.fround`（可能 ≤1 ulp 差异） |
| 全链路 Float64 | `setPrecision('float32' / 'float64')` / `getPrecision()` 下发到卷积、多段压缩、双耳/时域卷积、传播延迟、房间、氛围提取、上混、Ambisonics 解码；prepared IR/双耳/谱反射负载带精度自描述与校验；默认 float32，仅 HRIR/FIR 系数、源 IR 副本、HRTF 网格等非信号路径保留 Float32 |
| 空间后端 | 实测 KEMAR HRTF（MIT compact，8–192 kHz 重采样）+ 球谐插值、双耳卷积与 prepared 跨线程接管、镜像反射/谱反射/FDN/房间氛围、AmbiX 一至三阶与 FOA FuMa 解码、5.1/7.1 上混与双声道折叠、传播延迟/Doppler、world/stage/headLocked 路由、SOFA 导入（h5wasm）、串扰消除与音箱校准工具、头追姿态输入 |
| Worklet | 模块 `src/worklet/AudioEffectsProcessor.ts` 整套迁移；主程序根 `node scripts/build-v3-worklet.mjs --force` 重建 `public/v3-worklet.js`：**512,198 bytes（500.2 KiB），sha256 `7b5bea51…ebaefed5`**，旧的 95,518 bytes 包不可再用；`npm run verify:worklet` 全过；帧边界零分配（128/64 帧稳态无 typed-array/Array 构造）、参数消息就地修改 structured clone、Host/Worklet 同版协议与 `EngineConfigWork` 遥测字段 |
| 宿主 | `EngineV3Host` 支持最多 32 声道离散输入（`channelCountMode='max'` / `channelInterpretation='discrete'`）、prepared IR/房间线索控制线程准备 + Transferable 接管、worklet 优先/失败回退 script；遥测仅诊断用途，不作验收指标 |
| 九页 UI | 主页 / 音效场景 / 均衡器 / 空间音效 / **空间音频** / 动态调音 / 分析 / 调音器 / 关于；保持主程序**亮色薄荷玻璃**风格（主色 `#006A63`），不引入深色/AFG/M3 风格，不恢复 Atmos/360RA/个性化 HRTF 入口；空间 3D 世界编辑（`SpatialWorldScene`，懒加载浅色房间/地面/音箱，相机独立于音频） |
| 融合层 | `attachV3Engine` 的 `createV3UiBridge(engine, fs, { submit })` 为**唯一提交路径**（`setParams`/`applyScene`/外部替换同路，`applyScene` 不再绕过宿主下发与持久化）；补齐 `subscribeParams` 让系统音量/ReplayGain/总开关等外部更新刷新已打开 UI；IR 去重改为 `WeakMap<Float32Array, token>` 引用身份（不按内容 hash、不进分享串） |
| ReplayGain 生命周期 | `IAudioEngineAdapter` 新增可选 `setPlaybackSource`；`V3Adapter` 按 `trackKey/url/isLive/标签` 接收当前曲目：有标签直传 `setV3TrackReplayGainTags`，否则 `scanV3TrackReplayGain` 有限头/尾区间扫描（每段 1 MiB）；切歌/切走/直播/失败均 abort 旧扫描并先清空旧增益；增益不持久化为下一首默认值，App 在真实源切换与引擎热切换后重新注入 |
| 多声道输入 | `src/services/waveforge-engine-v3/src/integration/SpatialAudioSource.ts`（PCM/float/extensible WAV、mask/显式标签重排、≤32 输入声道、未知顺序显式报告）+ 主程序 `src/audio/spatialPlaybackInput.ts`（双 deck 各自实例、元素仍是唯一播放时钟、热切换解码成功后原子切 PCM、切 v1/v2 时显式立体声折叠）；实时输出仍为双声道，4 声道普通音频不自动猜 FOA |
| WAV+MP3 导出 | `exportV3Wav`/`exportV3Mp3` 经 `V3Adapter.exportWav/exportMp3` 注入调音室（`exporting` 状态上提、并发保护、失败 toast）；离线渲染输入上限 8→32 声道、导出前同步当前 SOFA HRTF（不可用回退内置 KEMAR 不中断）；WAV 与 MP3 共用同一离线 DSP；**导出容器仍为双声道**，pitch+多声道为近似时基 |
| 头追桥 IPC | `desktop/hse-head-tracking.cjs` + preload `window.electron.hseHeadTracking`（IPC `hse-head-tracking:state/start/stop`，仅可信窗口、用户显式启动、退出清理）；`npm run head-tracking:bridge` 启动本机 OSC 桥（UDP 9000 → `ws://127.0.0.1:8989/pose`）；串口/蓝牙走受控用户授权；UI 经 `hse:head-pose` 事件接收姿态 |
| 测试收集 | `vitest.config.ts` 增加模块 `ui/**/*.test.{ts,tsx}`、`integration/**/*.test.tsx` 与 `src/spatial/test/**`（原有 `test/`、模块 `test/` 不变）；主程序新增 `test/spatialPlaybackInput.test.ts`（验收轮扩到 9 项）、`test/v3AdapterLifecycle.test.tsx`、`test/hseSpatialInputLifecycle.test.ts`（3 项）、`test/hse-desktop.test.cjs`（已纳入 `npm run test:desktop`） |
| 依赖/配置 | `h5wasm@0.10.3` 补为直接依赖、`@types/ws`；`index.html` CSP：`script-src` 含 `'wasm-unsafe-eval'`（HDF5/SOFA 与 WASM SIMD，file:// 实测 basic+SIMD 均 true）、`connect-src` 含 `data: waveforge-media:`（HSE 导出/空间输入 fetch 必需），favicon 改 `./vite.svg`（public 无该文件，图标仍 404 既有）；`package.json` 增加 npm script `verify:worklet`（`node scripts/verify-worklet.mjs`）/`head-tracking:bridge`，把 `test/hse-desktop.test.cjs` 纳入 `test:desktop`，并删除 `build.files` 的 `!node_modules/@noble/**/*`（打包版启动崩溃）与 `!node_modules/dotenv/**/*`（打包版网易云 API MODULE_NOT_FOUND，**仅改配置未再复验**）；模块许可证、`vendor/h5wasm/LICENSE.txt`、`vendor/kemar`、头追桥脚本加入打包说明 |
| 回滚单位 | 分支 `codex/hse-35-main-integration`；接入前备份 `.verification/hse35-integration/main-before.zip`（1,036,876 bytes，2026-10-20 00:51）+ `migration-before.json` + `before/scripts/build-v3-worklet.mjs`；回退需覆盖源码/类型/适配器/依赖锁/资源/Worklet 并重建 Worklet，不能只换 JS bundle |

## 2. 文件映射

源路径相对快照 `temp/hse-optimise`，目标路径相对主程序根目录（快照 2026-10-20 相对接入前主程序：新增 105 / 修改 107 / 相同 60，文本行 60,257 / 36,812）。

| 区域 | 目标路径与处理 |
| --- | --- |
| DSP 内核 | `src/services/waveforge-engine-v3/src/dsp/**`：同路径合并；新增 `audioBuffer/ChannelDownmix/ConvolutionIrLibrary/Crossfeed/DynamicEq/EffectTransition/LowFrequency/MultibandCompressor/PcmQuantizer/PcmWav/ReplayGain/SampleRamp/vectorKernel/wasmSimdKernel`，修改 `BassEnhancer/Compressor/Convolver/Deesser/EqChain/Limiter/LoudnessComp/LufsMeter/MidSide/PitchYin/Resampler/ReverbSimple/Stretch/biquad/features/fft/API_SPEC.md` |
| 空间后端 | `src/services/waveforge-engine-v3/src/spatial/**`：新增 14 个模块（`AmbisonicDecoder/BinauralConvolver/CrosstalkCancellation/HeadPose/HrtfDataset/kemarData/measuredHrtf/measuredHrtfInterp/normalizeSpatial/PropagationDelay/SpeakerCalibration/StereoAmbienceExtractor/StereoUpmixer/worldRouting`）与 `src/spatial/test/**`，修改 `SpatialBackend/TimeConvolver/TsConvolverBackend/ambisonics/controller/layouts/roomSim/scenes/types` |
| 宿主/Worklet | `src/services/waveforge-engine-v3/src/integration/EngineV3Host.ts`、`ProcessingNode.ts`、`SpatialAudioSource.ts`；`src/worklet/AudioEffectsProcessor.ts`；`public/v3-worklet.js`（从主程序源码重建，不拷贝快照产物） |
| 融合层 | `src/services/waveforge-engine-v3/attachV3Engine.ts`、`ui/bridge.ts`（必须配套合并：submit 唯一提交路径 + `subscribeParams` + IR WeakMap token + ReplayGain 注入） |
| UI | `src/services/waveforge-engine-v3/ui/**`：九页、共享控件、三维组件、IR/SOFA/头追面板、`hse-main-controls.css`/`spatial-world-view.css`/`spatial-workbench.css`、场景存储与开发者模式、UI 测试 |
| 主程序接线 | `src/services/audio-engine/V3Adapter.tsx`（setPlaybackSource + exportWav/exportMp3）、`types.ts`（`EnginePlaybackSource`、可选能力）、`engines/v3.ts`；`src/App.tsx`（源切换/热切换注入）、`src/hooks/useAudioPlayer.ts`（离散输入与左右分析器透传）、`src/audio/types.ts`、`src/audio/spatialPlaybackInput.ts`（新增）、`src/electron.d.ts` |
| Electron 主进程 | `desktop/main.cjs`（头追 IPC/权限/退出清理、导出落盘）、`desktop/preload.cjs`（`hseHeadTracking` 桥）、`desktop/hse-head-tracking.cjs`（新增）、`test/hse-desktop.test.cjs`（新增） |
| 脚本 | `scripts/build-v3-worklet.mjs`（`--force` 支持）、`scripts/verify-worklet.mjs`（新增，显式复制子树的修正版）、`scripts/head-tracking-bridge.cjs` + `scripts/lib/head-tracking-osc.cjs`（新增）、`scripts/probes/**`（空间/IR/IR 持久化/WASM 能力探针）、`scripts/generate-kemar-hrtf.py`（开发数据再生成，非运行时服务） |
| 数据/声明 | `vendor/kemar/**`、`vendor/h5wasm/LICENSE.txt`、模块 `LICENSE`/`授权补充说明.md`/`THIRD_PARTY_NOTICES.md`、模块 `docs/PROCESSING_NODES.md` 与既有融合文档；运行时 HRTF 数据已内嵌 `src/spatial/kemarData.ts`，不是启动时下载/读 ZIP |
| 测试 | 模块 `test/**`、`ui/**/*.test.{ts,tsx}`、`integration/**`、`src/spatial/test/**`；主程序 `test/spatialPlaybackInput.test.ts`、`test/v3AdapterLifecycle.test.tsx`、`test/hse-desktop.test.cjs` |
| 配置/文档 | `package.json`/`package-lock.json`（h5wasm、@types/ws、脚本、打包说明；验收轮删除 @noble/dotenv 排除）、`index.html`（CSP `script-src 'wasm-unsafe-eval'` + `connect-src data: waveforge-media:`、favicon `./vite.svg`）、`vitest.config.ts`（收集范围）；`HANDOVER.md` §30、`AGENTS.md` HSE 段、`.gitignore`（`/.verification/`）、本目录归档副本 |

**未迁入/只读参考**：`temp/hse-optimise` 的 `.verification/`、ZIP/`MANIFEST*.json`、独立 `package.json`/`vitest.config.mjs`/`tsconfig.dsp.json`/`tsconfig.ui.json`（主程序用自己的配置）；`spatial-debug.html`/`src/spatial-debug/**` 预览入口未加入主程序生产入口（如后续需要，按交接 §3 登记 `DEBUG_PAGES.md`，不加入 vite 生产输入）。

## 3. 证据索引（`.verification/hse35-integration/`）

`.verification/` 已在 `.gitignore` 中按根锚定忽略（`/.verification/`），证据不进版本库；以下路径均为工作区实测产物。

| 证据 | 路径 | 说明 |
| --- | --- | --- |
| 接入前备份 | `main-before.zip` | 接入前主程序模块/脚本备份，1,036,876 bytes，2026-10-20 00:51 |
| 迁移前清单 | `migration-before.json`、`support-files.json`、`before/scripts/build-v3-worklet.mjs` | 接入前文件/哈希与外围支持文件清单、旧构建脚本副本 |
| 类型检查 | `typecheck.log`、`typecheck-2.log`、`typecheck-desktop-fix.log`、`typecheck-resume.log` | 接入过程分阶段 `tsc --noEmit` 日志（含 desktop 修复收敛记录） |
| HSE 模块最终测试 | `tests-final-hse-run1.log`、`tests-final-hse-run2.log`、`tests-final-review-fixes.log` | 修复轮后 113 文件 / 1156 用例 = **1140 passed + 16 skipped + 0 failed**（修复前 1155/1139） |
| 全仓最终测试 | `tests-final-full-maxworkers8.log`、`tests-final-full-after-ui-fix.log`、`tests-final-review-fixes.log` | 修复轮后 325 文件 / 3169 用例 = **3152 passed + 17 skipped + 0 failed**（修复前 3165/3148） |
| 逐文件隔离复跑 | `tests-final-isolated.log` | 11 个可疑文件单独跑 205 项全过，证明默认 31 worker 下的 5s 超时是 15.2GB 机器换页抖动 |
| 验收总报告 | `ACCEPTANCE.md` | 五个门禁结论、最终计数、修复清单、证据索引与残余边界 |
| 真实 Electron UI | `electron-ui/SUMMARY.md`、`11-page-*.png`、`34-final-*.png`、`audit-final-9pages.json` | 九页导航/亮色薄荷风格/窄窗 390px/导出/引擎往返实测 |
| 真实音频图 | `audio-graph/README.md`、`verify-spatial-playback.json`、`completion-48000-summary.json`、`completion-96000-summary.json`、`wasm-kernel-capability.json` | 多声道空间接管 10/10、WASM 能力探针、44.1/48/96 kHz 图探针 |
| 打包 file:// | `packaged/FINAL-REPORT.md`、`stage-b3-results.json`、`asar-fix-verification.json`、`exported-WaveForge-HSE-Modified.wav` | exit 0、file:// PASS、79 请求 0 失败、WAV 294,956B 落盘、@noble/CSP 复验 |
| Worklet | `worklet-build.log`、`worklet-verify.log` | 重建输出 512,198 bytes / 500.2 KiB（sha256 `7b5bea51…ebaefed5`；虚拟扬声器上混前为 507,839B）与 `verify:worklet` 全过记录 |
| 生产构建 | `build-first.log`、`packaged/build.log` | 接入后首次构建与打包重构建日志 |
| 早期接入日志 | `merged-tests.log`、`tests-resume.log`、`bridge-tests.log`、`lifecycle-tests.log`、`tests-stability-*.log` | 接入过程测试记录与 5s 抖动定位过程（最终口径以 tests-final-* 为准） |
| 其他 | `types-ws-8.18.2.tgz`、`fix-test-types.cjs` | 仅类型补丁包与一次性测试类型修复脚本，均非运行时依赖 |

五个门禁均已在 2026-10-20 实际执行并通过，结论与证据见 `ACCEPTANCE.md`；`HANDOVER.md` §30.2 为同一结果的摘要。

## 4. 测试基线

| 基线 | 结果 |
| --- | --- |
| HSE 快照基线（交接 §7） | 109 文件通过 + 3 跳过；1134 项通过 + 16 跳过（16 = 5 项可选 LGPL SoundTouch 适配 + 11 项显式诊断微基准） |
| HSE 模块最终实测（2026-10-20 评审修复轮，`tests-final-review-fixes.log`） | **117 文件（114 passed + 3 skipped）/ 1171 用例 = 1155 passed + 16 skipped + 0 failed**（修复前 1155/1139） |
| 全仓最终实测（2026-10-20 评审修复轮，`tests-final-review-fixes.log`） | **329 文件（325 passed + 4 skipped）/ 3184 用例 = 3167 passed + 17 skipped + 0 failed**（修复前 3165/3148；`--maxWorkers=4`；跳过 17 = 16 项 HSE 可选 LGPL/诊断微基准 + 1 项主程序可选依赖） |
| 桌面测试（`npm run test:desktop`） | **117 passed / 0 failed**（含新增 `test/hse-desktop.test.cjs` 6 项） |
| 历史数字 | 858 / 881 / 1017 / 1057 / 1069 等均为旧文档计数，**不能当当前结果** |

**并发口径**：默认 31 worker 在 15.2GB 机器上并发 325 文件会因换页出现多个与功能无关的 5s 超时抖动；11 个可疑文件逐个单跑 205 项全部通过（`tests-final-isolated.log`）。**最终回归固定 `npx vitest run --maxWorkers=4`**（8 worker 在构建/Defender 负载下仍会出现假超时；4 worker 全绿），不做 skip/retry。

跑法与命令：

```powershell
Set-Location -LiteralPath 'D:\Code\ZCode\WaveForge'
npm run lint
npx vitest run src/services/waveforge-engine-v3
npx vitest run --maxWorkers=8
npm run test:desktop
node scripts/build-v3-worklet.mjs --force
npm run verify:worklet
npm run build
```

## 5. 验收发现与修复（2026-10-20 验收轮）

验收在真实代码上又发现并修复了以下问题（均有源码/配置改动，完整清单见 `.verification/hse35-integration/ACCEPTANCE.md` §3）：

- **打包配置**：删除 `package.json` `build.files` 的 `!node_modules/@noble/**/*`（AirPlay 发送端运行时依赖，缺它打包版启动即 `Cannot find module '@noble/ed25519'`；复验 asar 含 @noble 114 条目、正常启动）与 `!node_modules/dotenv/**/*`（打包版网易云 API `MODULE_NOT_FOUND`；**仅改配置、未再打包复验**，下次打包生效）。
- **CSP / 资源**：`index.html` `connect-src *` → `connect-src * data: waveforge-media:`（`*` 不匹配 `data:`/自定义协议，是 HSE 导出与空间输入 fetch 被 CSP 拒绝的直接原因；修复后打包页内 `fetch(data:audio/wav)` 200/88,244B）；favicon `/vite.svg` → `./vite.svg`（public 无 vite.svg，图标仍 404，既有小事）。
- **多声道输入真实缺陷**：`src/audio/spatialPlaybackInput.ts` ① 元素时钟冻结（`MediaElementAudioSourceNode` 断开后 Chromium 停止拉动 `HTMLMediaElement` → 进度/seek/ended 停摆），改为 `media → 0 增益 mediaClockGain → deck` 静音支路并保留元素时钟，`clear()/dispose()` 恢复直连；② 非 WAV + 显式 AmbiX/FuMa 旧实现按 WAV 解码抛错导致逐曲中断，改为按原 URL 普通立体声播放 + 每格式一次 `onSourceWarning`；③ `clear()` 发 `onSourceDecoded(null)` 让上层回滚多声道参数。
- **融合层/接管回滚**：`attachV3Engine.acceptPlaybackInput(null)` 回滚 `multichannelAuto/multichannelLayout`（注入前备份用户取值）、`setSpatialInputChannelCount(2)`、按 2 声道重接 SoundTouch 前置链并刷新 UI；detach 清理备份；非 WAV 提示接 info toast。
- **导出源**：`App.tsx` 导出源优先 `audioPlayer.getPlaybackSource()?.url`——多声道接管时元素 `src` 被换成静音时钟 WAV，旧逻辑会把静音时钟当源导出无声文件。
- **UI**：`ui/hse-glass.css` ≤700px 头部允许换行 + 行高 56px→auto（修 390px 下引擎切换组被裁、关闭键溢出）；`ui/eqPanel.tsx` 补「均衡器已旁路」说明卡（均衡器旁路时整页空白）；`SpatialRingEditor.tsx` canvas dpr 每次 resize 重读（修 `canvasDprAndResize` 守卫）。
- **测试**：`test/spatialPlaybackInput.test.ts` 7→9（时钟静音支路、多声道→立体声 null 通知）；新增 `test/hseSpatialInputLifecycle.test.ts`（3 项：多声道参数注入/回滚、非 WAV info toast、pitch+多声道仅前 L/R 进 SoundTouch）；`test/modeIntegrationWiring.test.ts` 同步导出源断言；`attachV3Engine.persistence.test.ts` 10 个用例声明 `IMPORT_TIMEOUT=20_000`（断言未改）；`test/hse-desktop.test.cjs` 纳入 `npm run test:desktop`。
- **打包验收边界**：验收期间临时使用过的 resources/node_modules 解析垫片已全部删除，最终 release/win-unpacked 无临时文件。
- **代码评审修复（第二轮）**：engines/v3.ts 用户可见描述改 “HSE 3.5”（含 V3MixingStudio 兜底）；index.html CSP 注释写明两处最窄例外理由；spatialPlaybackInput 对 WAV 损坏/无 mask/声道数与声明格式不符统一回落普通立体声 + 单次提示、configure 失败不再暂停播放；新增 sourceChannelLabels/targetChannelLabels（类型 + normalizeSpatial 清洗 + syncDiscreteInput 下发 + 空间页输入）；DEBUG_PAGES.md 登记 HSE 探针，AGENTS.md 补头追权限边界与新目录说明；新增/更新对应测试（spatialPlaybackInput 9→11 项、hseSpatialInputLifecycle 3→4 项、spatial-completion 标签清洗断言）。
- **系统音效总开关（64 段预设轮回归）**：全旁路状态开启默认应用「增强」场景（64 段 EQ）并提示；关闭前真实配置按快照恢复；平直 EQ 与限幅不计入已开启状态。
- **内置 EQ 预设重设计（音乐频点锚点）**：场景 + 预设库按底鼓 60–80 / 军鼓 200–240 / 贝斯 700–1k / 人声 1–4k / 齿音 5–10k / 空气感 12–16k 锚点生成 64 段曲线；64 段全部落在 20Hz–16kHz 可听/音乐频段（不再分配 16kHz 以上超声段）；允许 ±5dB 听感级调整，Q=9.4 + 级联 Q 补偿；实测 40Hz–5kHz 目标/实测误差 ≤0.5dB，12kHz 约 −0.5dB。
- **空间音频可验证性与版本标签**：UI 版本标签统一改为 **HSE 1.5**（引擎目录/类名/3.5 代号不变）；空间音频页新增「试听空间效果」按钮，派发 `v3SpatialAudition`，attachV3Engine 把「左→右→双耳」测试音注入 `masterGain` 经 HSE 链真实 HRTF 处理（与直连 destination 的听力测试纯音区分）；开启空间音频时若强度为 0 自动补 0.7，避免「UI 已启用但引擎旁路」。验证：worklet 内左声道单频测试音，空间关闭时右耳 RMS=0，开启 natural 后 0.016、focused 后 0.065（真实跨耳串扰）；实时 A/B 实测输出相关度 0.69→0.93。
- **空间音频虚拟声源静音（轮 3）**：头锁定/世界/舞台模式下，虚源 muted 或音量 0 时，进入空间后端前对相应节目声道加干声闸门（20ms 平滑），全部虚源静音时 dry+wet 一起消失，仍保留其它声道经 HRTF 的交叉声；受控引擎测试覆盖右源静音/全静音/音量 0；打包应用双虚源静音后输出 RMS=0（未静音 0.28/0.27）。
- **空间音频强度增强（轮 4）**：自然外化湿声映射改为 `amount·(0.5+0.5·amount)`（70% 时 0.595，旧 0.28；100% 全湿），stereoPreservation 0.2、音乐床分频 3500Hz；默认强度 0.8 / 展开 90° / 房间 0.2（仅新建/重置生效）。受控 worklet 左声道单频右耳串音：关闭 0%、70% 22.9%、100% 42.8%、focused 70% 42.6%；打包应用实时链路正常。
- **虚拟扬声器上混（轮 5）**：headLocked 51/514/71/714 + 普通立体声（≤2 声道、inputFormat=channels）由 EngineV3 内部 StereoUpmixer 上混为 5.1（6ch）/7.1（8ch）/5.1.4（10ch）/7.1.4（12ch），再 processMulti 逐只 HRTF；custom 保持 L/R，真实多声道输入不二次上混；discrete/full wet（musicBed=0、stereoPreservation=0）。StereoUpmixer 新增 5.1.4/7.1.4 顶置层（3kHz 高通 mid/side，TFL/TFR=0.35·HP(L/R)、TRL/TRR=±0.4·HP((L-R)/2)，下混扣回）。实测 5.1 后端 6ch：FC RMS .1772、SL/SR .0400；5.1.4 顶置 .0145/.0149/.0107/.0107；180Hz 时顶置 .00027/0；5.1.4 与 5.1 双耳输出最大差 .0662。UI「一键虚拟 5.1 环绕」（focused/100%），不改 inputFormat。

## 6. 边界与残余未完成项（不得把边界写成已完成）

1. **打包 file:// 已 PASS（未签名调试目录）**：`build:electron:dir:unsigned` exit 0，HSE/Worklet/WASM/HDF5/SOFA/WAV 导出在真实 file:// 窗口通过；但 **exe 未签名**（EVS/VMP 需交互式密码）、打包 profile 无在线源（**联网播放未验证**）、`dotenv` 打包修复**未再复验**、favicon 仍 404。
2. **主观听感**：真实耳机/音箱、真实多声道与 HOA 曲库、HRTF 前后/高度定位、音箱校准真实房间均未主观验收；两声道无法唯一还原真实三维环境场。
3. **真实硬件头追**：只有本机 OSC 桥协议与模拟输入验证；Web Serial/BLE/DeviceOrientation 的真机权限、设备选择与延迟未验收，不能写成硬件已可用。
4. **严格实时期限未通过**：44.1/48/96 kHz 初始化/切换阶段仍有少量超预算（用户 2026-10-20 已要求不再继续性能测试/优化，作为已知边界记录）；192 kHz 仅压力/参考，不是门槛。
5. **音频线程并非绝对零分配**：帧边界已零分配，控制线程每条参数消息仍有 1 个 Array（payload 随后 transfer/detach）、空间配置推导与会话返回对象仍有已记录的小分配。
6. **导出容器仍双声道**：≤32 声道只作用于输入解码与空间/下混路径，不能宣称多声道文件导出；pitch+多声道为近似时基。
7. **接入改动已本地提交（`de7c881`，未 push）**：回滚点即该提交，回退到父提交 `8b90d34`；回滚需分支 + `main-before.zip` + 重建 Worklet，不要清用户数据或 `git reset --hard`。

## 7. 相关文档

- 交接原文归档（除来源说明外内容未改）：[MAIN_APP_INTEGRATION_HANDOVER.md](./MAIN_APP_INTEGRATION_HANDOVER.md)、[UPDATE_3.5.md](./UPDATE_3.5.md)
- 工作区原文（git 忽略，不随仓库分发）：[temp/hse-optimise/MAIN_APP_INTEGRATION_HANDOVER.md](../../temp/hse-optimise/MAIN_APP_INTEGRATION_HANDOVER.md)
- 主程序交接总文档：[HANDOVER.md](../../HANDOVER.md) §30；仓库约定：[AGENTS.md](../../AGENTS.md) HSE 段
- 模块内文档：`src/services/waveforge-engine-v3/docs/FUSION_GUIDE.md`、`UI_GUIDE.md`、`PROCESSING_NODES.md`、`FEATURES_VERIFICATION.md`
- 同目录既有参考：`HyperSoundEngine修改建议.md`、`HyperSoundEngine-声场透镜-全新UI图片提示词.txt`、`UI-reference.png`
