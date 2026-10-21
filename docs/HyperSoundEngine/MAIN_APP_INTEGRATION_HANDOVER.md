> **归档副本（2026-10-20）**：源文件 `temp/hse-optimise/MAIN_APP_INTEGRATION_HANDOVER.md`（原文更新 2026-10-20，独立快照只读参考）。`temp/` 被 git 忽略，故原文归档于此；**除本说明外内容与原文一致，未改动**。接入摘要与证据索引见 [INTEGRATION_3.5.md](./INTEGRATION_3.5.md)。

# HSE 独立快照 → WaveForge 主程序：完整接入交接

更新：2026-10-20（round-1/round-2 并行补全后重写）。接收方：负责 `D:\Code\ZCode\WaveForge` 主程序开发的对话。

本文件交接的是**整个 HSE 快照**，包含 DSP 内核、空间后端、Worklet、宿主、应用融合层、调音室、持久化、离线导出、数据与测试，不是只迁移空间音频 UI。文档结构保持初版：目录基准 → 产品要求 → 文件映射 → 接入顺序与回滚 → 正式接线待办 → 依赖/构建/CSP → 测试合入 → 验收 → 证据与边界 → 可复制提示词。

**本轮仍只整理文档，没有向主程序回写任何代码。** 接收对话在用户明确要求接入后执行本文流程；本文不表示主程序集成、硬件听感或发布验收已经完成。主程序若已存在后续改动，应按当时内容合并。

## 1. 目录、基准与必读材料

| 项目 | 路径或状态 |
| --- | --- |
| 独立快照根目录 | `D:\Code\ZCode\WaveForge\temp\hse-optimise` |
| 主程序根目录 | `D:\Code\ZCode\WaveForge` |
| 双方模块相对路径 | `src/services/waveforge-engine-v3/` |
| 主程序实际入口 | `src/services/audio-engine/V3Adapter.tsx` → `waveforge-engine-v3/attachV3Engine.ts` → `src/integration/EngineV3Host.ts` → `src/engine/EngineV3.ts` |
| 当前 Worklet 入口 | 模块内 `src/worklet/AudioEffectsProcessor.ts` |
| Worklet 输出 | 项目根目录 `public/v3-worklet.js`，生产构建后进入 `dist/v3-worklet.js` |
| Git 边界 | 快照没有独立 `.git`，位于父仓库忽略的 `temp/` 中；快照文件不会自动随父仓库提交 |

**2026-10-20 只读比较（当前内容，接入时必须重新比较）**：模块内快照 **272 文件**，主程序 **167 文件**；相对主程序**新增 105、修改 107、相同 60、主程序独有 0**。文本行数（`.ts/.tsx/.css/.md`，编辑器口径）：快照 **60,257**，主程序 **36,812**。`.ts/.tsx` 文件数：快照 `src`=99、`test`=63、`ui`=77、`integration`=2；主程序 `src`=50、`test`=30、`ui`=60、`integration`=0。Worklet 产物：快照 `public/v3-worklet.js` **507,004 bytes**，主程序 **95,518 bytes**（后者是接入前的旧包，接入后必须重建，见 6.2）。比较时主程序工作区干净（`git status` 仅分支名）。**当前检出** `master` @ `8b90d34e9c83a36aaea402bd586271f6efe4b47a`（2026-10-17）；历史交接分支 `codex/hse-dsp-integration` @ `cd9f5d4e4d2b1d98a6cc8d313570b28d1e2c1ce5` 与当前 master 在 HSE 模块仅 `ui/components/SpatialRingEditor.tsx` 有 4 行差异、`public/v3-worklet.js` 相同。接入时以当时工作区内容与 HEAD 为准。

上述计数是 2026-10-20 的内容比较，**不是以后可以盲目覆盖的依据**。快照 round-1/round-2 又新增了 WASM SIMD 内核、帧边界零分配、`EngineV3.setParams` 结构化同步、全链路 Float64、融合桥提交路径、导出 32 声道/HRTF 同步与诊断埋点，接入时按文件逐项核对。

先读以下快照文件：

1. `AGENTS.md`、`HANDOVER.md` 第 14–20 节：工作边界、空间补全、性能、当前 UI 与 round-1/round-2 并行补全（**第 20 节是本轮能力的权威摘要**）。
2. `DSP_FEATURE_GAPS.md`：全部 DSP 条目的实现状态、2026-10-20 验收范围调整与“已取消”项。
3. `DSP_Spatial_Audio_ReDesign.md`、`SPATIAL_AUDIO_IMPLEMENTATION.md`：用户空间方案与当前实现；不要删除用户方案。
4. `UI_Reference_Doc.md`、`UI_IMPLEMENTATION.md`：**最新风格以主程序现有亮色 HSE 为基准**。
5. 模块内 `docs/PROCESSING_NODES.md`：扩展节点协议；`docs/FUSION_GUIDE.md` 的历史测试数不要当现状。
6. `DEBUG_PAGES.md`：诊断入口和网络/数据边界。
7. `.verification/round-final/SUMMARY.md`、`.verification/task9/`：round-1/2 统一门禁与 `EngineConfigWork` 配置耗时归因证据。

旧 `MANIFEST.json`、`OPTIMIZED_MANIFEST.json`、`RELOCATION_MANIFEST.json` 和根目录 ZIP 均是历史材料，不是最新源码，也不能用它们的文件列表推断当前迁移完整性。

## 2. 必须保持的产品要求

- 用户可见名称为 **HSE**。保留代码目录、类名 `EngineV3/EngineV3Host`、事件和 `waveforge:v3-*` 存储命名，不做全局重命名。
- 只做亮色；视觉与主程序当前 HSE 调音室一致。不要恢复上一轮独立的实色 M3-AFG 方案，也不要另做品牌风格。
- 当前快照 `ui/hse-main-controls.css` 原样复制主程序 `ui/hse-glass.css`；玻璃按钮、圆形滑块、渐变卡片、导航和弹窗采用同一语言。`ui/hse-glass.css` 保留快照新增布局与可访问性适配。
- 主色固定薄荷 `#006A63`；快照已取消独立动态强调色。辅助小字有同色系可读性修正，不能为了逐字复制主题把这些修正回退。
- 保留空间功能、A/B、静音/独奏、二维编号避让与真实拖动、三维相机独立、实际 Host 参数下发和中文术语。
- channel 为“声道”；M/S 为“中央信号 / 差分信号”。虚拟声源不冒充已经分离的人声、乐器。
- 保留多声道输入到耳机双耳、通用 SOFA、AmbiX 一至三阶与 FOA FuMa、房间/环境、上混、头追输入和校准工具。
- **排除** Atmos、Sony 360RA、真实多声道设备输出、个性化 HRTF 测量/生成/校准；也不在本次扩展 AI 源分离、人声消除、VST2/VST3 宿主。
- 不恢复主程序旧头部的 Atmos 等未支持格式/认证徽章。沿用视觉风格不等于恢复这些声明。
- 保留模块 `LICENSE`、`授权补充说明.md`、第三方版权及数据说明。不以“回写”名义改写许可证。

### 2.1 已取消/不做（2026-10-20 用户决定，不要当待办）

接入与后续对话**不要**把这些重新列为实现目标：

1. **宿主级零拷贝直通取消**：不做“断开 Worklet、`masterGain` 直连 `analyser`”的端到端零拷贝。内部逐位旁路（bit-perfect bypass）已满足比特完美；该功能音质收益为 0、CPU/延迟收益可忽略，却要维护 masterGain/worklet/SoundTouch/analyser/channelSplitter 重连状态机，风险高。接入时保留内部逐位旁路契约即可。
2. **192 kHz 不再是硬实时期限目标**：真实音频文件通常不会使用该采样率。192 kHz 只保留为压力/参考测量，不作为验收门槛；严格期限按 **44.1/48/96 kHz** 评估。不要为 192 kHz 单独开性能任务。
3. **“整条信号链自由排序”取消**：信号链按固定边界设计（输入解码/下混 → 空间解码 → 分析 → 最终限幅）；九个音色/动态模块的既有 `processingOrder` 排序能力保留，不扩展为整链任意重排。
4. **不再继续性能测试与优化**（用户 2026-10-20 要求）：44.1/48/96 kHz 初始化/切换阶段的少量超预算作为已知边界记录；接入验收只核对既有基线，不新增性能目标。
5. 继续不做：Atmos/360RA/真实多声道设备输出/个性化 HRTF、AI 源分离/人声消除、VST2/VST3 宿主、完整音频线程“绝对零分配”宣称（帧边界已零分配，控制线程仍有已记录的小分配）。

## 3. 文件迁移映射

以下源路径相对于快照，目标路径相对于主程序。

| 源 | 目标与处理 |
| --- | --- |
| `src/services/waveforge-engine-v3/src/**` | 同路径合并完整内核、空间后端、宿主、Worklet 协议、类型、场景、编解码、离线与分析代码。**本轮新增** `src/dsp/wasmSimdKernel.ts`（运行时生成 WASM SIMD128 内核，无第三方工具链） |
| `src/services/waveforge-engine-v3/ui/**` | 同路径合并完整九页 UI、共享控件、三维组件、IR/SOFA/头追、状态与测试，包含新增 CSS |
| `src/services/waveforge-engine-v3/attachV3Engine.ts` | 同路径合并应用融合层；**必须与新版 `ui/bridge.ts` 一起合并**（提交钩子依赖两者配套），见 5.1 |
| 模块内 `test/**`、`src/spatial/test/**` | 同路径迁入并更新主程序 Vitest 收集范围。本轮新增 `test/vector-kernel-wasm.test.ts`、`test/worklet-allocation.test.ts`、`test/engine-params-allocation.test.ts`、`test/precision-full-chain.test.ts` 等 |
| 模块内 `integration/V3AdapterSnapshot.tsx` 与测试 | 保留为接线参考；将行为合并到正式 `src/services/audio-engine/V3Adapter.tsx`，不要注册第二个 HSE 适配器 |
| 模块内 `docs/**`、许可证、版权、资源与其他支持文件 | 一起合并。每个保留/跳过项说明理由，不只拷贝 `.ts/.tsx` |
| `vendor/kemar/README`、`vendor/kemar/compact.zip` | 主程序根目录同路径或明确记录的开发数据目录；保留原始数据/出处。运行时数据已嵌在模块 `src/spatial/kemarData.ts`，不是启动时下载 ZIP |
| `vendor/h5wasm/LICENSE.txt` | 保留到主程序第三方声明材料中，更新分发通知 |
| `scripts/generate-kemar-hrtf.py` | 开发数据再生成工具，合并到同路径；不是运行时必须启动的 Python 服务 |
| `scripts/build-v3-worklet.mjs` | 对照合并强制构建支持（`--force`），保留主程序现有 predev/prebuild 等流程 |
| `scripts/verify-worklet.mjs` | 合并为主程序 Worklet 验证工具，读取主程序输出。**必须用本轮修正后的版本**：旧脚本直接改写 `engine._params` 再回发同一对象，在 `setParams` 结构化比较下会被正确判为无变化，见 5.0/6.2 |
| `scripts/head-tracking-bridge.cjs`、`scripts/lib/head-tracking-osc.cjs` | 同路径合并本机 OSC 桥；Node `ws` 依赖见第 6 节 |
| `scripts/probes/**`、`scripts/benchmark-dsp.mjs` 等诊断脚本 | 作为开发工具按需完整保留依赖文件；保持相对目录关系，不整目录覆盖主程序 `scripts/`。本轮新增 `scripts/probes/wasm-kernel-capability.cjs` |
| `spatial-debug.html`、`src/spatial-debug/**`、`scripts/spatial-preview.mjs` | 可保留开发入口；路径/允许目录按主程序根适配，登记主程序 `DEBUG_PAGES.md`；不加入生产入口。注意其桥包装是**旧的 `Object.assign` 写法**，只服务预览，不要照抄到正式融合层 |
| `public/v3-worklet.js` | 源码合入后从主程序根重新生成；当前快照产物 507,004 bytes 不是主程序旧包（95,518 bytes），也不能直接当最终产物 |
| 根目录交接、实现与设计文档 | 归档到主程序 `docs/hse/` 等明确位置并更新链接，不覆盖主程序根的同名文档 |

**不要整体覆盖：**

- 主程序 `package.json`、`package-lock.json`、Vite/Vitest/TypeScript 配置、`AGENTS.md`、根 `HANDOVER.md`。
- 快照 `src/audio/playbackTimeStore.d.ts`：这是快照类型镜像；主程序已有真实 `src/audio/playbackTimeStore.ts`。
- `.verification/**`、`node_modules/**`、旧 ZIP、历史冻结 bundle、Electron profile、截图和临时音频：是证据或缓存，不是生产资源。
- 快照 `test/setup.ts` 仅作为差异参考合并，不能覆盖主程序其他测试设置。

`src/engine/builtinSceneSeed.ts` 在 2026-10-19 核对时双方哈希相同。接入时若主程序已发布新 revision，保留其新种子及 revision，再兼容新增参数；不要用快照旧种子覆盖作者后续调优。

## 4. 推荐接入顺序与回滚准备

1. 在主程序读取最新 `AGENTS.md`、工作区状态和其他开发对话的修改。记录 HEAD、相关文件 diff、未跟踪文件及当前依赖锁文件。
2. 为本轮接入建立可回滚的专用提交/分支或经用户认可的隔离工作区。不要把无关修改混进接入提交。
3. 重新比较双方模块（当前基准：快照 272 / 主程序 167，新增 105 / 修改 107 / 相同 60 / 主程序独有 0；文本行 60,257 / 36,812），列出新增、修改和主程序独有文件；先确认差异，再迁入完整模块与外围数据。
4. 合并依赖、构建脚本和测试收集配置（含本轮新增的 WASM 内核与分配/精度测试）。
5. 修复正式融合层、适配器、播放源通知、多声道图和导出接线，见第 5 节。
6. 验证旧参数、场景、IR/SOFA 恢复及主程序 UI 风格。
7. 主程序根强制生成 Worklet（`--force`），完成源码测试、生产构建、真实 Electron 与打包目录验收；**记录重建后的实际 bytes 与 `verify:worklet` 基线**。
8. 更新主程序文档，记录仍未通过的边界。用户没有要求时不自动发版、推送、清理独立快照。

回滚单位必须覆盖同一批源码、类型、适配器、依赖锁文件、资源和 Worklet（快照当前产物 507,004 bytes；round-1 收尾为 489.0 KiB，round-2 诊断埋点后 495.1 KiB 文本包体）。出现问题时回退本轮明确修改并重新构建旧 Worklet；不要只换 JS bundle，也不要通过删除用户整个 localStorage/IndexedDB 或 `git reset --hard` 处理。

## 5. 正式应用接线：复制后必须补齐

### 5.0 参数契约变化（接入前必须知道）

round-2 修改了 `EngineV3.setParams` 与 Worklet 参数消息的契约，接入时三处会互相影响：

- `EngineV3.setParams` 不再整份深拷贝、不再 `JSON.stringify` 比较，改为引擎自有快照逐字段结构化同步 + 22 个逐模块变更标志；契约保持“不修改传入参数、调用方事后改 `p` 不影响引擎”。不要在主程序侧依赖“引擎持有传入对象引用”。
- 传给 `setParams` 的必须是**新快照或不可变写法**。旧 `verify-worklet.mjs` 那种“直接改 `engine._params` 再回发同一对象”的写法会被正确判为无变化——已改为显式复制子树，接入时用本轮版本，不要放宽断言。
- 全链路 Float64 通过 `setPrecision('float32'|'float64')`/`getPrecision()` 下发（`Convolver`、`MultibandCompressor`、`TsConvolverBackend`、`BinauralConvolver`、`TimeConvolver`、`PropagationDelay`、`RoomSim`、`StereoAmbienceExtractor`、`StereoUpmixer`、`AmbisonicDecoder`）；精度切换会重建并 reset 后端，prepared IR/双耳/谱反射负载带精度自描述与校验，**混用不同精度/采样率的 prepared 负载会被拒绝**。默认仍为 float32，保留 Float32 的只有 HRIR/FIR 系数、源 IR 副本、HRTF 网格与 prepared 时域 HRIR（非信号路径）。

### 5.1 UI 桥：统一提交路径、场景应用与外部参数订阅

**快照已在 round-2 修复原交接中的桥缺陷，接入时按新结构合并，不要复用旧写法：**

- `ui/bridge.ts` 的 `createV3UiBridge(engine, sampleRate, options?)` 新增可选提交钩子 `options.submit(p)`；内部唯一提交路径是 `commitParams`：`current = cloneRuntimeParams(p)` → `engine.setParams(current)` → `options?.submit?.(current)`。`setParams` 与 `applyScene()` 都经此路径。
- `attachV3Engine.ensureBridge` 已删除旧的 `{ ...raw, setParams: ... }` 新对象包装，改为 `createV3UiBridge(host.engine, fs, { submit })`，由 submit 统一承载：曲目 ReplayGain 注入、值相等短路、`host.setParams()`（主线程引擎 + Worklet 同步下发）、`currentParams` 持久化、`syncPitchChain()`。`applyScene` 因此不再绕过宿主下发与保存。
- **注意不要照搬预览**：`src/spatial-debug/main.tsx` 仍用 `Object.assign(raw, {...})` 包装同一桥对象并自带 `subscribeParams`，那是独立预览的历史写法；正式融合层现在只靠 submit 钩子，二者不要混用。
- **仍需主程序补齐：`subscribeParams` 尚未实现**。当前宿主侧的外部参数更新（系统音量 `setV3SystemVolume`、`setV3TrackReplayGainTags`/`scanV3TrackReplayGain`、总开关快照切换）不会主动通知已打开的调音室 UI；UI 只在自身 `patch/replace` 提交后刷新。正式适配层应实现 `subscribeParams`（提交成功或外部更新后通知，订阅者只读、不重复提交），或在外部更新后触发一次 UI 刷新，避免界面显示滞后。
- `setParams` 是**完整快照替换**；局部编辑先 deepMerge。不要把 `{ spatial: ... }` 直接当完整参数下发。
- IR 去重已改为**引用标识**：`attachV3Engine` 用 `WeakMap<Float32Array, number>` 给 IR 分配稳定 token，key = 剥离 IR 的 JSON + `|ir:<token>`。同一引用短路、同参数换另一份 IR（即使样本内容相同）必定重新下发；**不要**改回“有 IR/无 IR”或按内容 hash。IR 数组仍不进 localStorage/分享串。
- ReplayGain 注入语义：submit 收到的是桥内快照（`getParams()` 读到的就是它），钩子在 `engine.setParams` 之后就地把 `loudnessNormalization.replayGainDb` 写回快照，再由 `host.setParams` 下发；`EngineV3.setParams` 已改为结构化同步（值复制进引擎自有对象），不会受后续修改影响。

必须测试主程序真实桥，不能只沿用 `spatialPreview` 的通过结论：点击内置/我的场景后 Worklet PCM、Host 参数、保存状态和重开页面一致，音量不被场景重置；外部音量/ReplayGain 更新后已打开的 UI 能刷新。

### 5.2 ReplayGain 与切歌生命周期

正式 `V3Adapter.tsx` 目前没有 `setPlaybackSource()`；现有统一接口也未声明此能力。参考快照 `integration/V3AdapterSnapshot.tsx`：

- 正式适配器保存当前源和 `AbortController`，切歌立即取消旧扫描。
- 已有标签调用 `setV3TrackReplayGainTags(tags)`；否则调用 `scanV3TrackReplayGain(url, signal)`。
- 无源、非可扫描直播、退出/切走 HSE 时清除上一首增益。
- 给 `IAudioEngineAdapter` 增加可选播放源通知，或等价的通用能力接口；保持 App 依赖接口，不新增散落的 v3 判断。
- 在**真实曲目提交/源切换**处调用，不放在 `renderStudio()` 或仅打开弹窗时调用。
- 覆盖普通切歌、无缝双 deck 提交、预热转正、失败/取消和引擎热切换后当前曲目的重新注入。不要把预加载曲目当当前正在播放的曲目。
- 同 URL 不一定是同一首曲目；正式入口最好传曲目标识，防止 URL 复用导致短路。直播/不支持 Range 的源安全回退，不阻塞播放。

快照解析器按头/尾有限区间扫描，每段最多 1 MiB；主程序要复用正常播放 URL/代理和取消机制，不新增绕过已有登录与 URL 解析的网络通道。**该接线仍属主程序待办，需要用户明确授权后另起流程；本快照未回流。**

### 5.3 WAV/MP3 导出及状态

快照 round-2 已把离线导出的输入与空间一致性补到以下状态（正式适配器仍只有 MP3 回调，需要接 WAV）：

- 声道上限：`renderV3Pcm()` 输入从 `Math.min(8, …)` 提升为 `Math.max(1, Math.min(32, decoded.numberOfChannels))`，保持离散声道顺序，mono 仍补成双声道；7.1.4（12）与一/二/三阶 Ambisonics（4/9/16）不再被截断到 8。
- SOFA 同步：处理前 `await readActiveHrtf()`（实际实现位于 `ui/hrtfStore.ts`，不是 `ui/irStore.ts`），有网格时 `engine.setSpatialHrtf(grid)`，与实时 attach 使用同一数据集来源；数据库不可用/数据损坏时只回退内置 KEMAR，**导出不会因此失败**。
- pitch + 多声道：pitch 激活且源 >2 声道时，只有前 L/R 走 `Stretch`，其余声道原样保留并按拉伸后长度对齐（rate>1 尾部补零、rate<1 截断）后一起送入引擎，不再整段下混成立体声丢失布局。这是**近似路径**：其余声道不做时间伸缩，rate≠1 时与前置立体声存在时基差异（代码注释已写明）；实时链 SoundTouch 前置同样只处理双声道。
- **导出容器仍是双声道 WAV/MP3**（引擎输出即双耳立体声）。≤32 声道只作用于输入解码与空间/下混路径，**不要**宣称多声道文件导出。
- 仍依赖浏览器 `decodeAudioData()` 得到声道顺序，不解析 WAV mask/AmbiX 标签；需要严格顺序时在主程序接 `SpatialAudioSource` 的解码/重排入口，不要改 UI 下拉框当作重排。
- 1s 尾音冲刷、pitch 总长度、MP3/WAV 共用同一段离线渲染链的行为保持不变；量化仍支持 `plain/tpdf/noiseShaped`（默认 TPDF）。

正式适配器接线要求：

- 在正式 `renderStudio()` 同时注入 `exportMp3`、`exportWav`、`exporting`。
- 保留正式适配器 `setExporting()`、`onExportingChange()` 与 App 的订阅；快照参考类不能直接替换完整 `IAudioEngineAdapter`。
- 两种导出均使用 try/finally 清理状态，错误提示走正式 toast，避免未捕获 rejection；防止重复并发导出。
- `sourceDuration` 单位是**秒**，不是 `Song.duration` 的毫秒。
- 保留已有 `saveHseRenderedAudio` / `hse-save-rendered-audio` IPC，核对 `.wav` 后缀与文件头、重名不覆盖、300 MiB 上限。现主进程实现按扩展名写文件，不应再新增一条无约束落盘 IPC。
- 离线声码器与实时 SoundTouch 属于不同算法，不能按“共用 DSP”直接宣称逐样本相同。

### 5.4 音频图、分析器、多声道输入

主程序 `useAudioPlayer.ts` 已提供左右分析器与 splitter；回调实际发送 `leftAnalyserNode/rightAnalyserNode`，但统一 `AudioGraphHandle` 类型尚未完整包含这两项。合并类型后把原句柄透传到 `attachV3Engine()`：

- 波形取效果链后、最终试听/投送静音前的左右分析器；不能借用预览生成的测试波形。
- 保留 `masterGain → [SoundTouch] → HSE → analyser → outputGain → destination` 的原图语义及 AirPlay/分析采集支路。
- attach/dispose 不得同时留下旧直连和新链；双 deck、系统音量、投送本机静音不能失效。
- `EngineV3Host` 支持最多 32 声道离散输入容量与观测（`AudioWorkletNode` 用 `channelCountMode='max'`、`channelInterpretation='discrete'`），但主程序 `source → deckGain → masterGain` 上游节点的默认行为可能已经把输入收窄或按扬声器规则混音。只给 Worklet 配置 32 输入不能恢复被上游丢掉的声道。
- 检查实际节点的 `channelCount/channelCountMode/channelInterpretation`，仅在 HSE 所需路径调整，并回归 v1/v2、双 deck、AirPlay 和输出设备切换。**仍然只输出双声道。**
- 4 声道普通音频不能自动猜为 FOA；AmbiX 4/9/16 与 FuMa 4 必须显式声明格式。
- `src/integration/SpatialAudioSource.ts` 已支持 PCM/float/extensible WAV、mask 和显式标签重排，但当前只接入独立预览与测试。正式播放要把文件/目录元数据、声道顺序、格式及重排接到实际源上；改 UI 下拉框不等于重排输入 PCM。
- 无有效 mask/标签的多声道输入不能猜顺序；7.1 必须区分侧环绕与后环绕。解码能力上限与实时 Host 容量不是同一个上限。
- 多声道输入不受“宿主级零拷贝直通取消”影响：内部逐位旁路仍在，多声道输入配双声道输出时执行 5.1/7.1 折叠，此时不宣称比特完美（见 2.1）。

### 5.5 采样率、热切换和 UI 桥身份

`getV3Bridge()` 当前调用 `ensureBridge(48000)`，桥按引擎实例缓存；宿主引擎因采样率变化重建时，`ensureBridge` 会重建桥并立即用当前快照走一次提交（submit 因此始终绑定当前 `host`）。接入时仍要检查“未播放先开调音室，再接入非 48kHz 音频图”的情况：桥的 `getSampleRate()`、当前参数、HRTF、IR 和 UI 必须切到真实上下文采样率。不能让默认 48kHz 兜底覆盖正在运行的宿主采样率。

保留现有统一适配层的热/冷切换流程；不要用快照独立预览替代主播放器生命周期。切到 HSE 后重新注入系统音量、当前播放源、时钟；切走后取消扫描、停止听力纯音、摘除 SoundTouch/旧节点并清理姿态。

### 5.6 HRTF、IR、场景和参数持久化

保持存储命名与迁移兼容（round-2 未改变任何键）：

| 内容 | 当前位置 |
| --- | --- |
| 引擎参数/总开关恢复快照 | localStorage `waveforge:v3-params`，其中 `__masterSnapshot` |
| 我的场景 | `waveforge:v3-my-scenes` |
| 内置微调 | `waveforge:v3-scene-overrides`，版本语义见 `ui/sceneStore.ts` |
| 开发者开关 | `waveforge:hse-dev-mode` |
| IR 数据 | IndexedDB `waveforge:hse-ir-library` / `impulses`，最多 32 条 |
| 通用 SOFA 网格 | IndexedDB `hse-spatial-hrtf-v1` / `profiles` / `active` |

IR 数组不要放回 localStorage/分享串；恢复时通过 `irId` 查库并按采样率准备。IR 去重 token 只是进程内 WeakMap 身份，不持久化、不进入分享串。每首曲目的 ReplayGain 不应跨重启持久化为下一首默认增益。旧参数缺省字段深合并并归一化，坏数据安全回退，不通过清空全部用户设置“修复”。

开发预览 3018/3019 与主程序开发 3000、打包 file:// 的存储来源不同。不要迁入测试 profile，不把预览数据未自动出现在主程序当成算法失败。

### 5.7 头部追踪与音箱校准

头追输入组件已包含 WebSocket、Web Serial、BLE 和 DeviceOrientation，但真实 Electron 的权限/设备选择要使用主程序可信会话策略接入；不能把模拟协议通过写成硬件已可用。

OSC 桥为 `scripts/head-tracking-bridge.cjs`，默认 `127.0.0.1:9000 UDP → ws://127.0.0.1:8989/pose`。独立预览测试会临时启动桥，正式应用不会因此自动拥有常驻桥。若产品要内置启动，需合并受控启动/停止、端口冲突、错误反馈、打包入口和退出清理；仍只监听本机，不自动连接设备。

音箱校准是几何估算与已反卷积 IR JSON 分析/应用工具，当前没有麦克风采集。不要在接入时把它改称自动测量整套房间。

## 6. 依赖、资源、CSP 与构建

### 6.1 依赖核对

2026-10-19 本机读取结果（round-2 未新增 npm 依赖）：

| 依赖 | 已安装版本 | 主程序清单状态/处理 |
| --- | --- | --- |
| `h5wasm` | `0.10.3` | **已存在于父 node_modules，但未声明在主程序 dependencies**；必须补入主程序 package.json 与锁文件，不能依赖本机残留包 |
| `three` | `0.184.0` | 主程序已声明，保留并验证兼容 |
| `@react-three/fiber` / `drei` | `9.6.1` / `10.7.7` | 主程序已声明 |
| `@soundtouchjs/audio-worklet` | `2.1.1` | 既有正式运行依赖；保留独立处理器资源与版权 |
| `lamejs` | `1.2.1` | 既有导出依赖，保留融合层深导入兼容补丁及类型声明 |
| `ws` | `8.21.3` | 主程序已声明；OSC Node 桥使用 |

**WASM SIMD 内核不需要新增依赖**：`src/dsp/wasmSimdKernel.ts` 在运行时用自研 LEB128 编码器生成约 370 字节的 WASM 模块（f32x4 + f64x2 复数乘法；f64 路径即 `processDouble`，若内核/精度不可用回退双精度标量），不依赖 wabt/binaryen/Rust，不 fetch 外部 `.wasm`，也不用 relaxed-simd。对外经 `vectorKernel.ts` 的 `createComplexProductKernel()`/`processDouble()` 门面暴露，`UnrolledComplexProduct` 保持兼容签名。选择策略：f32 阈值 256 样本、f64 阈值 512 样本（低于阈值回退纯 TS 以免拷贝成本超过收益）；输入/输出子视图按源数组与偏移缓存（WeakMap + Map，WASM memory grow 时重建输出视图），预热后 0 视图分配；无 WebAssembly/SIMD 的环境静默回退纯 TS。**不要**因为原方案提到外部库而添加原生模块或新的 WASM 工具链。

HDF5/WASM 在用户导入 SOFA 时惰性加载，不能打进 AudioWorklet；Three 也只在 UI。快照 Worklet 仍是 TS 单文件，没有新增 SAF/libspatialaudio DLL 或 Rust DSP 后端。

### 6.2 Worklet 与资源路径

快照构建脚本增加了 `--force`，主程序当前脚本仅按 mtime 判断。迁入新源码后要合并强制构建支持，从**主程序根目录**执行：

```powershell
Set-Location -LiteralPath 'D:\Code\ZCode\WaveForge'
node scripts/build-v3-worklet.mjs --force
node scripts/verify-worklet.mjs
```

此命令只供用户授权接入后的主程序对话执行，本轮编写交接时未执行。**体积基线**：快照当前产物 507,004 bytes（文本包体约 495.1 KiB；round-1 收尾 489.0 KiB，round-2 诊断埋点后 495.1 KiB）；主程序旧包 95,518 bytes。接入后主程序重建产物应同源、同量级，记录实际 bytes 与构建日志，不能继续使用 95,518 bytes 旧包。

保持处理器注册名 `waveforge-v3-effects`、主线程 Host 与 Worklet 消息协议同版本。参数双缓冲、prepared IR/HRIR、HRTF 和扩展节点必须整套迁移，不能混用旧 bundle。**本轮 Worklet 协议新增**：帧边界预分配（待处理房间线索 256/256/512，超限丢最旧并计入 `timing.droppedRoomHrir`）、参数消息就地修改 structured clone 副本、`process()` 无数组字面量/闭包分配；Host 侧 `postWorkletParams` 缓存消息骨架、`ir=null` 副本与 transfer 列表（内容未变时重发同一消息对象）；另加 `EngineConfigWork` 遥测字段（见 6.4）。接入后 Host 与 Worklet 必须同版，否则统计字段缺失或参数语义不一致。

正式融合层用 `./v3-worklet.js`；预览用 `/v3-worklet.js`，不要把后者直接抄到 file:// 主程序。检查 SoundTouch 的 `processor?url`、Three 懒加载 chunk、HDF5/SOFA chunk 在打包后均能以相对资源地址加载。

### 6.3 生产配置与权限

- 保持主程序 Vite `base: './'` 与生产 HTML 白名单；不把 `spatial-debug.html` 加进生产输入。
- 主程序 `index.html` 当前 CSP 的 `script-src` 为 `'self'`。**两类 WebAssembly 都要在打包后实测**：① 用户导入 SOFA 时的 HDF5/h5wasm 初始化；② 本轮新增的 WASM SIMD 复数乘法内核。WebAssembly 编译受 `script-src` 约束，若被拒绝，SOFA 导入会失败；SIMD 内核则会**静默回退纯 TS（音频仍正确但更慢）**——所以“能出声”不等于 WASM 可用，必须看能力探针或日志。若确需放开，按必要且最窄范围调整（例如 `'wasm-unsafe-eval'`），不要全面关闭 CSP 或放开 `'unsafe-eval'`。
- 保留原 Electron IPC 信任校验、preload 边界和权限选择机制。不要照搬诊断窗口参数作为生产设置。
- 当前 electron-builder 排除了原始 Three/React/SoundTouch 等 node_modules，但包含 `dist/**/*`；这要求 Vite 正确输出运行 chunk，不要盲目取消所有排除来掩盖资源路径问题。
- 检查 KEMAR、h5wasm、SoundTouch 等数据/依赖声明如何随分发物保留；根目录 vendor 的存在不代表 builder 已打包这些说明。
- 主程序还有 Python、签名和发行前置流程。按当前 package.json 执行，不用旧文档里的精简命令替代；没有签名条件时明确记录失败阶段和可用的调试产物。
- 不改动无关 Android TV、Apple、其他引擎或播放器界面；共用类型变动需通过全仓类型检查。

### 6.4 诊断埋点与遥测（接入时保留）

round-2 为性能归因加入了 `EngineConfigWork`（`src/engine/EngineV3.ts` 导出类型 + `getConfigWork(target)`）并汇总到 Worklet `timing`：`paramsApplied`、`poseUpdates`、`roomHrirItems`、`hrtfLoads`、`spatialConfigs`、`preparedIrLoads`、`localIrLoads`、`spatialConfigMs`、`reverbConfigMs`、`directPreparedHits/Misses`、`preparedSpeakerIrs`、`localSpeakerIrs`、`roomPreparedHits/Misses`、`roomRebuilds`、`convolverInstances`、`preparedPrimes`、`preparedEntries`，另有 `timing.droppedRoomHrir`。主程序可继续在遥测面板消费这些字段，但**不要把它们当验收指标**；接入后应保持消息形状一致，否则旧 Host 会丢掉字段。归因结论见 `.verification/task9/diag-48000-{hint,nohint}.json`：48 kHz 超预算集中在初次/切换配置阶段（`spatialConfigs`/`roomRebuilds` 计数与 `maxConfigMs` 同步升高），稳态无超预算；这只用于说明边界，不作为放宽门槛的依据。

## 7. 测试、诊断工具如何合入

主程序 Vitest 当前收集 `test/**/*.test.ts(x)`、模块 `test/**/*.test.ts`、模块 `ui/**/*.test.tsx` 与 `src/spatial/test/**/*.test.ts`；快照还有模块 `ui/**/*.test.ts`（非 tsx）和 `integration/**/*.test.tsx`。接收方要合并：

```text
src/services/waveforge-engine-v3/test/**/*.test.ts
src/services/waveforge-engine-v3/src/spatial/test/**/*.test.ts
src/services/waveforge-engine-v3/ui/**/*.test.{ts,tsx}
src/services/waveforge-engine-v3/integration/**/*.test.tsx
```

**基线（2026-10-20 快照实测）**：**109 文件通过 + 3 跳过；1134 项通过 + 16 跳过**（16 跳过 = 5 项可选 LGPL SoundTouch 适配 + 11 项需显式启用的诊断微基准）。接入后主程序计数应≥此基线；不要用旧文档的 858/881/1069/1057 等历史数字当当前结果。

本轮新增/关键测试文件：`test/vector-kernel-wasm.test.ts`（WASM/TS 对拍、f64 逐位）、`test/worklet-allocation.test.ts`（帧边界零分配）、`test/engine-params-allocation.test.ts`（`setParams` 无分配）、`test/precision-full-chain.test.ts`（Float64 全链路）、`test/attachV3Engine.persistence.test.ts`（场景应用经宿主下发/持久化、IR 引用去重、切歌注入）、`test/multichannel-export.test.ts`（32 声道输入、SOFA 同步、pitch+多声道）。主程序原有 `test/**/*.test.*` 和 setup 保持。快照适配参考测试只验证参考类；必须另测正式 `V3Adapter`、统一接口与 App 调用方，避免“例子通过、产品没接”。

诊断脚本往往按自身 `__dirname/../..` 定位项目根，迁移时保持目录结构。`spatial-preview.mjs` 的 fs allow 包含快照向上的父依赖路径，搬到主程序要相应调整；不要指向不相关目录。本轮新增 `scripts/probes/wasm-kernel-capability.cjs`（真实 AudioWorklet 内能力/对拍/分配探针），接入后从主程序根运行并记录 `wasmAvailable/simdCompiled/kernelMatches/doublePath.ok`。`verify-worklet.mjs` 必须用本轮“显式复制子树”的版本，保留原断言强度。

`electron-ui-afg.cjs --main-style` 才是当前 UI 风格检查；未带参数的旧 AFG 检查要求无控件模糊、动态强调色，与最新用户要求不同。三份 UI 探针访问构建预览 3019；它们验证独立 Host/预览，**不能代替主播放器实际调音室验收**。

从主程序运行迁入后的脚本时，它们可能仍输出到名称带旧日期的 `.verification` 子目录。记录实际来源、Worklet 路径、构建版本和时间；不要把输出路径中的日期当成本轮执行日期。

## 8. 验收顺序与交付标准

### 8.1 源码与构建门禁

接入后从主程序运行：

```powershell
Set-Location -LiteralPath 'D:\Code\ZCode\WaveForge'
npm run lint
npx vitest run src/services/waveforge-engine-v3
node scripts/build-v3-worklet.mjs --force
node scripts/verify-worklet.mjs
npm run build
```

主程序没有独立的 `typecheck:ui` 脚本，用 `npm run lint`（`tsc --noEmit`，覆盖 `src/`）即可覆盖迁入模块；快照自身的 `typecheck`/`typecheck:ui` 是两套 tsconfig，若接入时保留独立 UI tsconfig 再相应调用。对照基线（快照 2026-10-20）：`typecheck` 与 `typecheck:ui` 均 0 error；全量 109 文件/1134 项通过；Worklet 构建产物 507,004 bytes 量级；`verify:worklet` 的装载、空间/房间、多声道 HRTF 路由、IR 复用、帧边界参数/reset、扩展节点、5.1 折叠、第三方 TS 模块断言全部通过。主程序实际数字以本轮运行结果为准，记录日志。构建失败要区分本轮问题、依赖/签名前置条件和已有问题，但不能跳过本轮文件的检查。

真实图探针**串行**运行，避免测试负载污染性能结论：

```powershell
node scripts/probes/electron-spatial-completion.cjs --rate=48000
node scripts/probes/electron-spatial-completion.cjs --rate=96000
node scripts/probes/electron-spatial-completion.cjs --rate=48000 --script-only
```

**192 kHz 只作为压力/参考**（例如 `--rate=192000` 手动运行并保存记录），不作为验收门槛。需要 IR/参数准备专项时运行迁入后的 `electron-ir-persistence.cjs`、`electron-spatial-graph.cjs` 和 `verify-worklet.mjs`；WASM 能力用 `scripts/probes/wasm-kernel-capability.cjs`。启动参数以当前脚本为准。`--require-deadline` 是严格门槛，已知初始化/切换阶段有超预算，不要删掉此门槛或隐藏计数来制造通过；如实记录 44.1/48/96 的总计数与稳态计数。

### 8.2 主程序真实 Electron

| 项目 | 必须看到的结果 |
| --- | --- |
| 实际加载路径 | 使用主程序新 Host、新 Worklet（重建后的 507,004 bytes 量级产物）、新 UI，不引用 temp 或 3019 预览 |
| 默认/原声 | 无效设置安全回退；音量/静音正确；内部原样旁路按对应契约对拍 |
| 切换引擎 | v1/v2/HSE 热切换、暂停/恢复、反复开关调音室无叠加双链、断流或状态泄漏 |
| 参数与场景 | 改参、内置场景、我的场景、总开关、保存/重启一致，实际 PCM 改变，音量独立；场景点击后 Host 参数与 Worklet PCM 同时变化 |
| 参数同步性能 | 滑杆拖动不重复全量下发；值相等短路生效（宿主日志/诊断计数可核对）；连续切歌 ReplayGain 注入不吞 |
| 立体声空间 | 四种模式、原声 A/B、房间、路由、距离、高度、反射/环境可实际试听 |
| 多声道/HOA | 真实文件经过正式播放图；核对 Worklet 实收声道、源顺序、中心/LFE/侧后/高度及 HOA 最高阶分量，非仅改配置 |
| 精度切换 | `float32/float64` 切换、分享串往返、prepared IR/双耳负载不被错配；默认 float32 |
| WASM 能力 | 打包 CSP 下 `wasmAvailable/simdCompiled/kernelMatches/doublePath.ok` 为 true（或明确记录被 CSP 拒绝并回退 TS）；`WebAssembly` 与 SIMD 路径实际生效 |
| 波形与时钟 | 实际播放左右波形、暂停/继续、双 deck 提交及随曲目轨迹正确 |
| SOFA / IR | 导入、应用、切换、删除、重启、采样率变化、损坏/超容量回退；生产 CSP 下成功 |
| ReplayGain | 标签直传/扫描、快速切歌、无标签/直播回退、切走取消，不沿用上一首增益 |
| 导出 | MP3/WAV 文件可播放、格式/位深/时长/增益/空间参数正确；>8 声道源与自选 SOFA 下导出不丢声道、不退回默认 HRTF；状态/错误/重名/无源处理正确 |
| 头部追踪 | 本机桥连接/重置/断开/失联回退；选择真实设备的权限与生命周期正确 |
| 三维/二维 | 水平/高度拖动即时更新，隐藏轴保持、编号不挡、左右方向正确、相机不改音频 |
| UI 风格 | 主程序薄荷玻璃风格，亮色九页、弹窗和窄窗口一致，焦点可见、减少动态效果有效 |
| 其他模块 | AirPlay、输出设备、本机静音、DG-LAB 分析、v1/v2 和跨平台构建不被破坏 |

### 8.3 打包验收

按主程序当前构建脚本生成 Windows 调试可执行产物，在**真实 file:// 窗口**验证 HSE 首次打开、Three 懒加载、SOFA/WASM（HDF5 与 SIMD 内核）、SoundTouch、保存、重启和导出。确认所有资源来自安装目录，未借用开发服务器或 snapshot。

安装包/发布仅在用户要求时执行。交付记录必须给出实际 exe/安装包路径、版本、运行结果、未通过项；网页预览通过不能替代桌面产物通过。

## 9. 已有证据与仍未完成的边界

以下是快照历史验证，接入后要重跑对应项：

- **round-1/2 统一门禁**：`.verification/round-final-full-tests.log`（round-1 全量）、`.verification/round-final-worklet-build.log`、`.verification/round-final-worklet-verify.log`；`.verification/final-round2-full-tests.log`（本轮移除宿主直通试验后的最终全量）、`.verification/final-round2-worklet-build.log`、`.verification/final-round2-worklet-verify.log`。`.verification/round-final/` 目录内另有：`SUMMARY.md`、`probe-{44100,48000,96000}.json/.log`、`wasm-kernel-capability.log`、`probe-ir.log`、`probe-192000.log`。
- **完整更新/优化对照**：另见快照根目录 `UPDATE_3.5.md`（相对主程序的完整更新/优化对照，含文件级差异、能力清单与已取消项；与本交接的接入步骤互补）。
- **其他专项证据**：`setParams` 无分配证据在 `.verification/engine-setparams-20261019/`；帧边界零分配证据在 `.verification/worklet-alloc-20261019/`；Float64 边界说明在 `.verification/float64-chain-note.md`；配置耗时归因在 `.verification/task9/`。
- **测试基线**：109 文件通过 + 3 跳过；1134 项通过 + 16 跳过（16 = 5 可选 LGPL + 11 显式诊断微基准）。所有历史计数（858/881/1017/1057/1069）都不能当当前结果。
- **WASM 内核**：真实 AudioWorklet 探针 `wasmAvailable/simdCompiled/kernelMatches/doublePath.ok` 全 true；count=8192 单块 SIMD 0.0065ms vs TS 0.0275ms（约 4.23×），预热后视图分配 0。边界：f32 输出改为逐步 `Math.fround`，与旧版本可能有 ≤1 ulp 差异；f64 与 double 逐位一致；NaN 位模式不作契约。
- **零分配边界**：帧边界已零分配（128/64 帧、单声道、块长切换各 100 帧 0 次 typed-array/Array 构造）；`EngineV3.setParams` 连续 100 次相同快照 0 次构造、对象引用不变；但控制线程每条参数消息仍有 `takePreparedRoomHrir` 的 1 个 Array（payload 随后被 transfer/detach），空间配置推导在改参/姿态路径仍创建 config/speakers 对象，`getStats/getAnalysis` 省略 target 时仍分配返回对象。不要宣称“整个音频线程绝对零分配”。
- **真实图（44.1/48/96 kHz）**：功能断言零失败、非有限 PCM 为零；超预算 3/4770、4/5370、9/10500；稳态（>500ms）1/2460、0/2820、0/5640。计时为 Date 1ms、含初始化/预热，不能当设备期限证明。**用户已要求不再继续性能测试/优化**：初始化/切换阶段的少量超预算作为已知边界记录。
- **192 kHz**：仅压力/参考（completion 探针 ambix3 56/1260、spectral-early 67/2520、same-tick 99/1260；`budget=auto` 补测 ambix3 54/1260、same-tick 37/1260）。不作为验收门槛，不与 44.1/48/96 数据直接对比。
- **已取消项**：宿主级零拷贝直通（内部逐位旁路仍保留）、整链自由排序、192k 硬实时期限、后续性能优化目标——见 2.1，不要再列为待办。
- **主程序回流仍待办（需用户明确授权）**：正式桥 `subscribeParams`/外部更新刷新、ReplayGain 曲目生命周期、WAV/MP3 导出回调、完整多声道源与 `SpatialAudioSource` 重排接入、生产 CSP 下 HDF5/SIMD 实测、`h5wasm` 直接依赖与锁文件、主程序 Worklet 重建与 `verify:worklet` 基线。
- 主观耳机/音箱听感、真实硬件头追、系统设备端比特完美、完整播放器和安装包均不能由合成 PCM 或独立 UI 测试推导。

接收方最后应交付：当前文件差异与依赖锁、正式调用链说明、Worklet 生成/路径与体积证据、测试与实机截图、打包产物（如本轮要求）、未通过边界、可按提交回滚的记录。快照留存到用户确认主程序接入正确之后。

## 10. 可直接复制给主程序开发对话

> 请将 `D:\Code\ZCode\WaveForge\temp\hse-optimise` 的整个 HSE 独立快照接入 `D:\Code\ZCode\WaveForge` 主程序。先读快照 `MAIN_APP_INTEGRATION_HANDOVER.md`、`HANDOVER.md` 第 14–20 节（第 20 节为 round-1/2 能力摘要）、`DSP_FEATURE_GAPS.md` 与主程序当前 `AGENTS.md`，重新核对当前文件差异（2026-10-20 基准：模块快照 272 / 主程序 167，新增 105 / 修改 107 / 相同 60 / 主程序独有 0；文本行 60,257 / 36,812），保留其他开发改动。迁入完整内核（含 `src/dsp/wasmSimdKernel.ts` WASM SIMD128 内核）、Worklet 协议、宿主、UI、融合层、数据、声明与测试，不能只复制空间页。
>
> 关键契约：① 融合层 `createV3UiBridge(engine, fs, { submit })` 的 submit 是唯一提交出口，`applyScene` 不再绕过宿主下发/持久化，IR 去重用 WeakMap 引用 token，不要改回“有 IR/无 IR”；仍需补 `subscribeParams`，让系统音量/ReplayGain/总开关等外部更新能刷新已打开的 UI。② `EngineV3.setParams` 已改结构化同步（无深拷贝/无 JSON.stringify），`verify-worklet.mjs` 用本轮“显式复制子树”版本；全链路 Float64 通过 `setPrecision` 下发，prepared 负载带精度校验。③ 离线导出已支持 ≤32 输入声道并同步当前 SOFA 网格，pitch+多声道不再下混丢布局，但导出容器仍是双声道，不要宣称多声道文件输出。
>
> 接入待办：ReplayGain 曲目生命周期、WAV/MP3 导出回调、完整多声道源与 `SpatialAudioSource` 重排仍需用户明确授权后接线；补 `h5wasm@0.10.3` 直接依赖与锁文件；主程序根强制重建 Worklet（当前快照产物 507,004 bytes，主程序旧包 95,518 bytes），跑 `verify:worklet` 并记录实际体积；打包后实测 HDF5 与 WASM SIMD 在 CSP 下可用（被拒时 SIMD 会静默回退 TS，需看能力探针，不可只看“能出声”）。测试基线：109 文件/1134 项通过（16 跳过 = 5 可选 LGPL + 11 显式诊断基准）。
>
> 范围：192 kHz 仅压力/参考、宿主级零拷贝直通与整链自由排序已取消、不再继续性能优化，不要新增这些任务。UI 保持主程序现有亮色薄荷玻璃风格；保留新空间功能和正确声道术语，不恢复 Atmos/360RA/真实多声道设备输出/个性化 HRTF 入口。不要覆盖主程序根配置或播放时钟实现，不把预览页面/profile 当生产资源，不依赖 temp 运行。记录未通过项和回滚方式；本任务不包含发版、推送或删除快照。
