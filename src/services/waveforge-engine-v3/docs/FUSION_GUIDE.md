# FUSION_GUIDE —— 把 waveforge-engine-v3 融合进 WaveForge（手把手版）

> 本文件写给**执行融合的另一个 AI**：按步骤操作即可完成融合与验证。
> ✅ **融合已完成（2026-08-16/17）**：模块现位于 `WaveForge/src/services/waveforge-engine-v3/`，
> 经 `attachV3Engine.ts` 融合层 + 统一适配层（`src/services/audio-engine/V3Adapter.tsx`）接入，
> 调音室 UI 为 HSE 风格 8 页导航。以下步骤保留作操作记录。
> 本模块是**为 WaveForge 设计的下一代音频引擎 v3**（非 HXAudio 原版引擎），独立开发、
> 已通过全量验证：**29 测试文件 / 324 用例（319 过 + 5 LGPL 跳过）、tsc 0 错误、两轮深度审计（12 类问题已修复）**。
> v2 与 v3 是完全独立的两个引擎：**不做 API 兼容层、不做字段级迁移**——切换只保证
> "音频能正常切到 v3 处理"（用现成的 `EngineV3Host` 接线模块）。

> 依据文档（融合前请通读）：
> - `docs/v2-analysis.md`（WaveForge v2 模块深读：API 面、链顺序、集成点）
> - `docs/FEATURES_VERIFICATION.md`（功能核验：26 项有效功能 / 324 用例 / MIT·LGPL 统计）
> - `docs/audit/SUMMARY.md`（审计总结：修复的 12 类问题与确认正常的项）
> - `src/dsp/API_SPEC.md`（模块契约）；`../research/docs/`（算法原理与设计）

---

## 0. 先决条件：先验货，再动手

在 `waveforge-engine-v3/` 目录内执行：

```bash
npm install          # 自动安装 devDeps + optionalDeps（含 vendor 里的 soundtouchjs LGPL-2.1）
npm run typecheck    # 必须 0 错误
npm test             # 必须全绿：29 文件 / 324 用例（319 过 + 5 LGPL 跳过）
```

预期输出（节选）：`Test Files  29 passed (29)`、`Tests  319 passed | 5 skipped (324)`、`TSC_EXIT= 0`。
若未全绿：**停止融合**，先修 v3 侧问题（或回退到本模块的上一提交），不要带病融合。

目录速览（融合只动 WaveForge 侧 4 处：见步骤 1-4）：

```
waveforge-engine-v3/
├── src/
│   ├── types.ts                  # 参数模型 V3EngineParams（含默认值 createDefaultParams）
│   ├── dsp/                      # 16 个纯 DSP 模块 + LGPL 适配层（零依赖）
│   ├── engine/EngineV3.ts        # 引擎总成（14 级链，实时/离线共用）
│   ├── engine/ScenePresets.ts    # 11 组合场景（SCENE_PRESETS）
│   ├── engine/ShareCodec.ts      # 分享串（encodeShareCode/decodeShareCode）
│   ├── integration/EngineV3Host.ts  # ★ 切换接线模块（见步骤 2）
│   ├── worklet/AudioEffectsProcessor.ts  # AudioWorklet 处理器（需打包，见步骤 3）
│   ├── analysis/ offline/ index.ts
├── vendor/soundtouchjs/          # LGPL-2.1 原包副本（含 LICENSE，离线可用）
├── test/ + ui/uiSmoke.test.tsx        # 324 用例（融合时迁入 WaveForge/test/ 或加 include）
└── docs/                         # FUSION_GUIDE / FEATURES_VERIFICATION / v2-analysis / audit/
```

---

## 1. 安全边界（融合时必须遵守）

1. **不要读**：`decompiled/`、`business-code/`、`apktool-out/`、`docs/`（逆向分析产物，另一对话的工作区）。
2. **v1 引擎**（`WaveForge/src/services/audioEffects/`）与 **v2 引擎**（`WaveForge/src/services/audio-effects-v2/`）
   在 v3 验证通过前**保持原样**；切换走现有 `src/services/audioEngineVersion.ts` 机制加 'v3' 分支。
3. **WaveForge/src/services/audio-effects-v3/** 是另一个对话正在进行的旧 v3 实现——
   融合前先与该对话协调：**并存 → 验证 → 替换**（推荐），或确认后直接替换。
4. v3 内部算法**不要改动**（如需修改先跑 `npm test` + `npm run typecheck`）；融合只做接线。
5. **v2 与 v3 相互独立**：不做兼容层、不做字段迁移；v3 用自有 `V3EngineParams` 模型。

---

## 2. 融合步骤

### 步骤 1：落位源码

**方案 A（并存，推荐）**：把 `waveforge-engine-v3/src` 与 `vendor` 整体复制为
`WaveForge/src/services/waveforge-engine-v3/`：

```bash
# 在 WaveForge 仓库根目录执行
mkdir -p src/services/waveforge-engine-v3
cp -r <v3路径>/src/* src/services/waveforge-engine-v3/
cp -r <v3路径>/vendor src/services/waveforge-engine-v3/
```

测试迁入（二选一，避免与 WaveForge 既有测试重名）：
- 把 `test/` 复制为 `WaveForge/test/v3/`（vitest include 已含 test/ 时直接生效），或
- 在 `WaveForge/vite.config.ts` 的 test.include 追加 `test/v3/**/*.test.ts`。

**方案 B（替换）**：与另一对话确认后，用本模块替换 `WaveForge/src/services/audio-effects-v3/`。

### 步骤 2：引擎切换接线（核心，只改 WaveForge 侧 2 个文件）

**2a. `WaveForge/src/services/audioEngineVersion.ts`** —— 加 'v3' 分支：

```ts
// 改动点：版本联合类型加 'v3'；默认值保持 'v1'（验证通过后再考虑默认切 v3）
export type AudioEngineVersion = 'v1' | 'v2' | 'v3'
// getAudioEngineVersion()/setAudioEngineVersion() 的读写逻辑不变
// （localStorage 'waveforge:audio-engine-version'，默认 'v1'）
```

**2b. 新建 `WaveForge/src/services/waveforge-engine-v3/attachV3Engine.ts`** —— 直接使用现成接线模块：

```ts
/**
 * v3 引擎接线：切换流程与 WaveForge 现有 v1→v2 热切换同款
 * （暂停 → dispose 旧 → attach 新 → 恢复播放）。
 * EngineV3Host 已内置：masterGain 全断重连（防双链并联）、worklet/script 双模式与自动回退、
 * 幂等、异步注册期间被 dispose 的竞态防护、dispose 恢复 masterGain→analyser 直连。
 */
import { EngineV3Host, createDefaultParams } from './index'
import type { V3EngineParams } from './index'

export interface AudioGraphHandleLike {
  audioContext: { sampleRate: number; audioWorklet?: { addModule(url: string): Promise<void> }; createScriptProcessor?(b: number, i: number, o: number): unknown }
  masterGain: { connect(n: unknown): unknown; disconnect(): unknown }
  analyser: { connect(n: unknown): unknown }
}

/** 模块级单例（与 v2 的 engineRef 模式一致） */
let host: EngineV3Host | null = null

/** 音频图就绪回调：把 v3 接入 masterGain → v3节点 → analyser */
export async function attachV3Engine(handle: AudioGraphHandleLike, settingsToV3Params: () => V3EngineParams): Promise<void> {
  if (!host) host = new EngineV3Host({ mode: 'auto', workletUrl: '/v3-worklet.js' })
  await host.attach(handle as never)            // handle 符合 V3HostHandle 鸭子类型
  host.setParams(settingsToV3Params())          // 由 WaveForge 设置对象构造 V3EngineParams（见步骤 4 映射）
}

/** 切走/关闭：恢复 masterGain→analyser 直连 */
export function detachV3Engine(): void {
  host?.dispose()
}

/** 参数变更（调音室操作时调用） */
export function updateV3Params(p: V3EngineParams): void {
  host?.setParams(p)
}
```

**2c. 热切换接入点**（与现有 v1→v2 切换同构，参考 `src/App.tsx` 的 `switchAudioEngine`）：
暂停播放 → `detachV3Engine()`（旧）→ `await attachV3Engine(handle, ...)`（新）→ 恢复播放。
音频图未就绪（handle=null）时仅保存版本配置，下次启动生效（与冷切换语义一致）。

### 步骤 3：AudioWorklet 打包（worklet 路径需要；script 兜底可跳过）

```bash
cd WaveForge
npx esbuild src/services/waveforge-engine-v3/worklet/AudioEffectsProcessor.ts \
  --bundle --format=iife --outfile=public/v3-worklet.js
```

- 产物 `public/v3-worklet.js`（含全部 DSP，约几十 KB）；处理器注册名 `waveforge-v3-effects`。
- `EngineV3Host` 的 `mode: 'auto'` 会**优先 worklet、失败自动回退 script**（无需打包也能出声，便于先联调后打包）。
- 注意：worklet 内 `sampleRate` 为全局变量；参数经 `port.postMessage({type:'params'})` 下发。

### 步骤 4：参数对接（v3 自有模型，不做 v2 字段迁移）

- WaveForge 侧构造 `V3EngineParams`（`src/services/waveforge-engine-v3/types.ts`），
  推荐从 `createDefaultParams(ctx.sampleRate)` 派生，按 UI 设置覆盖字段；
  11 个场景直接用 `SCENE_PRESETS`（含完整参数快照）。
- 分享串：`encodeShareCode/decodeShareCode`（版本+校验+白名单，防注入）。
- v2→v3 语义对照（字段不同、语义近似）：

| 主题 | v2 | v3 |
|---|---|---|
| 引擎形态 | Web Audio 节点图 | 纯 TS DSP 内核 + EngineV3Host 接线 |
| 参数模型 | AudioEffectsSettings | V3EngineParams（自有快照） |
| 响度归一化 | 3003 服务整曲测量 + 静态增益（-14 LUFS） | 引擎内实时 BS.1770（targetLufs 可配置 -14/-16/-23） |
| 频响补偿 | 3004 服务 + BiquadFilterNode 链 | 内置 LoudnessComp（v2 同款公式） |
| 变速/变调 | SoundTouch worklet（LGPL） | 三选一：自研相位声码器（默认）/ soundtouchjs 链接 / signalsmith(MIT) |
| 混响 | 程序化随机 IR 卷积 | 确定性分区卷积（可导入 IR）+ 算法混响 |
| 限幅 | DynamicsCompressorNode（-6dB） | 前瞻+真峰值（-1dB 可配） |
| 场景 | 内置 7 场景（effects+eq） | 11 组合场景（全参数快照） |
| 新增 | — | 20 段 EQ+Q 补偿、de-esser、虚拟低频、IEQ、音量自适应补偿（LoudnessComp）、听力分析、分享串、分离队列、YIN、重采样、频谱特征 |

### 步骤 5：离线导出（WAV）

v3 双路径共用同一内核：解码后 PCM → `EngineV3.process` 分块处理 → 写 WAV
（可复用 WaveForge 现有 `exportToWav` 的编码部分，替换效果链执行为 v3 引擎）。

### 步骤 6：UI

调音室（MixingStudioV2 或新面板）按 `types.ts` 字段绑定：EQ(10/20 段+Q 补偿)、齿音、压缩、
夜间、卷积/算法混响（IR 导入+去周期化）、虚拟低频、等响度（含按音量自适应补偿）、智能 EQ、听力分析、分离队列。

---

## 3. 验证清单（融合后逐项勾选）

| # | 验证项 | 方法与预期 |
|---|---|---|
| 1 | v3 单测迁移 | `npx vitest run test/v3 ui/` → 324 全绿（319 过 + 5 LGPL 跳过） |
| 2 | WaveForge 回归 | `npm run lint` 0 错误；`npm test` 既有用例不回归 |
| 3 | 切换冒烟 | 切 v3 → 播放 → 无爆音/无声；v1↔v2↔v3 反复热切换无双链并联 |
| 4 | 逐效果开关 | EQ/齿音/压缩/夜间/混响/低音/补偿/IEQ/限幅 逐一开启关闭，听感变化符合预期 |
| 5 | 场景切换 | 11 场景 A→B→A，无 NaN、无爆音（v3 测试已覆盖逻辑，融合后人工复核） |
| 6 | 分享串 | 编码→解码往返一致；非法串被拒绝 |
| 7 | 一致性 | 实时链与离线导出 WAV 逐样本误差 <1e-6（同参数同输入） |
| 8 | 性能 | 48kHz 128 帧量子处理 <2ms；低端设备混响切算法、EQ 20→10 段 |
| 9 | 合规 | THIRD_PARTY_NOTICES.md 随分发物；LGPL 依赖按"不修改+链接"方式（随附 LICENSE） |
| 10 | 响度 | 响度计数值合理（1kHz 满刻度 ≈-3 LUFS）；限幅器削波灯正常 |

---

## 4. 常见问题排查

| 症状 | 原因与处理 |
|---|---|
| 切 v3 后无声 | ① 检查 masterGain 接线（v3 节点须在 masterGain 与 analyser 之间）；② worklet 未打包时确认走了 script 兜底（无 `createScriptProcessor` 的宿主需先打包）；③ dispose 后应恢复 masterGain→analyser 直连 |
| `v3-worklet.js` 404 | 打包输出路径与 `workletUrl` 不一致；或未先 build（开发模式用 `public/` 静态目录） |
| 切换爆音/双击声 | 热切换必须"暂停 → dispose 旧 → attach 新 → 恢复"（不能两个引擎同时挂 masterGain） |
| 输出 NaN | 极低概率：参数含 NaN（分享串解码已防注入）；若复现，检查输入 PCM 是否合法 |
| LGPL 合规疑问 | soundtouchjs 为"不修改+动态链接"（vendor 原包随附 LICENSE）；@soundtouchjs/audio-worklet 若保留同理 |
| 需要调响度目标 | `loudnessNormalization.targetLufs`：-14（流媒体）/ -16（Apple）/ -23（EBU 广播） |

---

## 5. 完成标准

- [x] 步骤 0 预检全绿（324 用例：319 过 + 5 LGPL 跳过 / tsc 0）
- [x] v3 落位 `WaveForge/src/services/waveforge-engine-v3/`（含 vendor/）
- [x] `audioEngineVersion.ts` 支持 'v3'；attachV3Engine.ts 接线完成
- [x] worklet 打包（或确认 script 兜底可用）
- [x] 验证清单 10 项全部通过
- [x] THIRD_PARTY_NOTICES.md / vendor/README.md 随分发物

---

## 6. 空间音频（Spatial Audio）融合（已全量落地）

> 空间音频经 7 波实施**全量落地**（四模式 + HRTF 数据集 + 房间模拟 + 多声道 + 性能后端），
> 本节是**已实现事实的融合指南**（非计划）：参数模型以 `src/spatial/types.ts` 为准，
> 公共 API 以 `src/spatial/fusion.ts` 与 `attachV3Engine.ts` re-export 为准，
> WASM 契约以 `rust/hrtf-core/src/lib.rs` 为准。改实现时保持本节与代码同步。

### 6.1 架构：兄弟 AudioWorklet 节点

拓扑（与 SoundTouch 变速变调同款的"兄弟节点"先例——**EngineV3 零改动**）：

```
masterGain → [soundtouch?] → v3Node → [spatial?] → analyser
```

- 空间节点是 v3 处理节点**之后**的独立 AudioWorklet 节点（处理器注册名 `waveforge-spatial`，
  打包产物 `public/spatial-worklet.js`）；只做双耳渲染，不碰引擎参数。
- **与 SoundTouch 先例的类比**：SoundTouch 挂在 v3 之前（`masterGain → SoundTouch → v3`），
  空间挂在 v3 之后（`v3 → spatial → analyser`）——两者都是"引擎外接线节点"：
  激活时按需接线、关闭时恢复直连、**任一环节失败静默**（保持 `v3 → analyser` 直连，
  音频不中断）；都由 `attachV3Engine` 的 sync 函数管理（`syncPitchChain` / `syncSpatialChain`，
  镜像范式：seq 竞态防护 + 上下文变化重置 + 节点身份检测自动摘旧重接）。
  差异：SoundTouch 参数走 AudioParam 平滑（`applySoundTouchParams`），空间参数走
  **全量替换 config 消息**（`postConfig`），另加 HRTF 网格热更新（`postGrid`）。
- **EngineV3 零改动约束**：空间化不进 `EngineV3.ts` 14 级链、不在 `V3EngineParams` 加字段、
  不进场景快照（`SCENE_PRESETS` 无空间字段）——空间参数是全局设置（同音量语义），
  持久化于 localStorage `waveforge:spatial-params`。
- **融合层接线点**（`attachV3Engine.ts`）：`attachV3Engine` 的 attach 流程在
  `host.attach` 后调用 `syncSpatialChain(getV3Node, handle)` + `restoreHrtfDataset()`；
  `detachV3Engine` 调用 `unwireSpatial()`（恢复 v3 → analyser 直连）后再 `host.dispose()`；
  离线导出 `exportV3Mp3` 用 `createExportBackend(fs)`（wasm 优先 / TS 兜底,
  房间模拟已由后端内置，无需叠加）。
- **离线 MP3 导出**（`exportV3Mp3`）：解码源 PCM → `EngineV3.process` 分块
  → pitch 前置（`Stretch`）→ 空间后端包裹 → 1s 静音冲刷卷积/限幅 tail
  → Float32→Int16 → `lamejs.Mp3Encoder(2, sampleRate, 128)` 编码 → `.mp3` 下载。

### 6.2 文件地图

`src/spatial/`（相对 `src/services/waveforge-engine-v3/`）：

| 文件 | 职责 |
|---|---|
| `src/spatial/types.ts` | **参数模型事实源**：SpatialParams / 各模式设置 / HrtfGrid / SpatialRenderConfig / 默认值 `createDefaultSpatialParams` |
| `src/spatial/fusion.ts` | **融合层公共 API**：参数读写/订阅、配置推导（`spatialConfigFromParams`）、实时链同步（`syncSpatialChain`）、HRTF 数据集（`setHrtfDataset`/`restoreHrtfDataset`/`resampleGrid`）、离线后端工厂（`createExportBackend`） |
| `src/spatial/SpatialBackend.ts` | 后端接口（接口先行、实现可替换，仿 `offline/Separator.ts` 先例）；热路径约束：稳态零分配、每块一次、outL/outR 完整写入 |
| `src/spatial/TsConvolverBackend.ts` | **TS 参考后端**（复用 `dsp/Convolver.ts` 分区 FFT 卷积），兼作 Rust/WASM 数值对拍 ground truth |
| `src/spatial/WasmHrtfBackend.ts` | **Rust/WASM 性能后端**（纯 C ABI、同步实例化、热路径零分配；wasm 线性内存视图重建要点见文件头注释） |
| `src/spatial/SpatialProcessor.ts` | AudioWorklet 处理器（`waveforge-spatial`：双耳渲染 / 多声道输入 `processMulti` / 输出 >2 声道物理映射 / stats 回传） |
| `src/spatial/SpatialNode.ts` | 节点主线程包装（`register` 每上下文缓存、`onStats` 转发 `spatial-stats`、`postConfig`/`postGrid`） |
| `src/spatial/TimeConvolver.ts` | 时域直接卷积（契约 `spatial_set_convolution_mode=time`；与分区模式同块调度同放行，干湿对齐一致） |
| `src/spatial/roomSim.ts` | 完整房间模拟 TS 参考（镜像声源法早期反射 + FDN 晚期混响，与 Rust `RoomState` 逐位对拍） |
| `src/spatial/hrtfInterp.ts` | 球谐 HRTF 插值（实 SH L=3 最小二乘拟合，与 Rust 逐位对拍） |
| `src/spatial/ambisonics.ts` | Ambisonics FOA（一阶实 SH）编解码 + 环境上混（`AMBIENCE_SPEAKERS` 45/135/225/315° 四方向扩散扬声器） |
| `src/spatial/controller.ts` | 模式 C 纯函数：听者→声源相对方向（`computeRelativeDirection`）、移动/旋转（`moveListener`/`rotateListener`）、轨迹插值（`computeTrajectoryPosition`） |
| `src/spatial/layouts.ts` | 模式 B 布局预设**单事实源**（stereo/51/714 表 + `createLayoutSpeakers`/`headLockedSpeakers` 解析） |
| `src/spatial/scenes.ts` | 模式 D 场景预设**单事实源**（stage/cinema/piano/nature 表 + `stageSpeakers`/`stageRoom`，座位/房间缩放） |
| `src/spatial/analyticHrtf.ts` | 当前 HRTF 数据源：合成解析网格（简化球头模型，Woodworth ITD + 球头阴影 ILD，全确定性） |
| `src/spatial/hrtfStore.ts` | HRTF 数据集 IndexedDB 持久化（db `waveforge-hrtf` / store `datasets`，手写 Promise 封装） |
| `src/spatial/persistence.ts` | 参数持久化（`waveforge:spatial-params`，400ms 防抖 + 深合并容错，存储可注入） |
| `src/spatial/analyticHrtf.ts` | 合成 HRTF 网格兜底（简化球头模型：Woodworth ITD + 球头阴影 ILD，全确定性） |
| `src/spatial/gridSource.ts` | 网格装载：`data/grid.ts` base64 解码 → HrtfGrid；解码失败回退合成网格 |
| `src/spatial/room.ts` | 轻量 Freeverb 兜底（**历史实现**——后端已内置完整房间模拟，仅保留回退/对比测试） |
| `src/spatial/data/grid.ts` | **自动生成**：HRTF 网格 base64 内嵌（`npm run build:spatial-worklet` 产物，勿手改） |
| `src/spatial/data/datasets.ts` | **自动生成**：内置数据集表（kemar 引用 grid.ts + cipic base64 或 null；构建脚本第②b 步产物，勿手改） |
| `src/spatial/backendIndex.generated.ts` | **自动生成**：后端索引（wasm 变体：`createWorkletBackend` 优先 Wasm、构造失败降级 TS；或纯 TS 变体），勿手改 |
| `src/spatial/test/` | 14 个测试文件：fusion/layouts/scenes/controller/ambisonics/hrtfInterp/sofa/hrtfStore/analyticHrtf/tsBackend/wasmBackend（Rust vs TS 对拍）/spatialProcessor/perf-bench/datasets |
| `rust/hrtf-core/` | Rust HRTF 渲染核心（target wasm32-unknown-unknown；**无任何外部依赖**、纯 std 可构建、离线安全） |
| `rust/hrtf-core/src/lib.rs` | 16 个 `spatial_*` 契约函数 + 房间模拟 / SH 插值 / 多普勒 / 遮挡 / 声源大小实现（头注释即契约文档） |
| `hrtf-data/grid.bin` | MIT KEMAR 实测网格数据（构建脚本内嵌源；缺失时合成网格兜底） |
| `scripts/build-spatial-worklet.mjs` | 打包脚本（四步，见 §6.6；产物均"自动生成，勿手改"） |
| `ui/pages/SpatialPage.tsx` | 空间音效页：标准视图（卡片流）/ 专业视图（四象限工作室布局 `SpatialStudioLayout`，窄窗 <900px 自动回退）+ 四模式面板 |
| `ui/components/SpatialRingEditor.tsx` 等 | 环形拖拽编辑器 / `SpatialWorldView`（3D 世界视图）/ `WorldPanel` / `StagePanel` / `SpatialSettingsModal`（输出/卷积模式等设置弹窗）/ `SpatialModeVisual` |

### 6.3 参数模型（SpatialParams，`types.ts` 事实源）

顶层层级全字段（默认值见 `createDefaultSpatialParams`）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `'off' \| 'instant' \| 'headLocked' \| 'world' \| 'stage'` | `'off'` | 空间模式开关（`isSpatialActive()` = mode ≠ off） |
| `output` | `'binaural' \| 'stereo' \| 'multichannel'` | `'binaural'` | 输出模式：stereo = 干声直通（speakers=[] 走处理器直通路径）；multichannel = 物理声道映射（渲染配置同 binaural，输出声道数由 `SpatialNode` 重建承担，2 声道设备退化为双耳） |
| `convolution` | `'partitioned' \| 'time'` | `'partitioned'` | 卷积模式（契约 `spatial_set_convolution_mode`；time 时域直接卷积，干湿对齐/脉冲位置与分区一致） |
| `masterGain` | number | `0.9` | 双耳输出主增益（0.5..1，防削波预留） |
| `instant` | `InstantSpatialSettings` | 见下 | 模式 A |
| `headLocked` | `HeadLockedSettings` | 见下 | 模式 B |
| `world` | `WorldSettings` | 见下 | 模式 C |
| `stage` | `StageSettings` | 见下 | 模式 D |
| `ambience` | `AmbienceSettings` | `{ enabled: false, amount: 0.3 }` | 环境声 Ambisonics 上混（叠加到各模式主渲染；stereo 输出下旁路） |
| `multichannelChannels` | `6 \| 8`（可选） | 缺省按布局推导 | 物理输出声道数：7.1.4 布局 → 8、5.1/其它 → 6；显式设置优先于推导 |

各模式子设置：

- **instant（模式 A）**：`spreadDeg`（20..120，虚拟扬声器 ±spreadDeg/2）、`amount`（0..1 干湿混合）、`room`（`RoomPreset`：off/studio/hall/stage/church/outdoor/bathroom/corridor）、`roomAmount`（0..1 房间混响叠加量）、`multichannelAuto`（多声道输入自动映射开关，默认 false）。
- **headLocked（模式 B）**：`layout`（`'stereo' | '51' | '714' | 'custom'`）、`speakers`（`VirtualSpeakerCfg[]`：azimuthDeg/elevationDeg/distance/gain/size，custom 时生效）、`heightLayer`（7.1.4 顶置层开关）、`routes`（`SpeakerRoute[]` 与 speakers 等长：`'l' | 'r' | 'both'` 逐扬声器声源路由；空/长度不足回退按方位角就近——az≤0→L、az>0→R；`'both'` 展开为两只半增益扬声器）。
- **world（模式 C）**：`moveSpeed`（0.5..5 m/s）、`listener`（`ListenerState`：position + yaw/pitch/roll）、`sources`（`AudioObject[]`，默认 4 演示源：人声/吉他/鼓组/环境声）、`playhead`（秒）、`trajectories`（`TrajectoryKeyframes[]`：sourceId + t/position 关键帧，按 playhead 线性插值，无轨迹者用静态 position）、`occlusion`（0..1 遮挡/衍射量）。
- **stage（模式 D）**：`preset`（`'stage' | 'cinema' | 'piano' | 'nature'`）、`seat`（`'front' | 'middle' | 'back'`，距离 ×0.8/1.0/1.35）、`roomSize`（0.5..2，钳位 0.5..10m）、`reverbAmount`（0..1 氛围混响，覆盖融合层全局 roomAmount）。

**持久化键**：

| 键 | 内容 | 说明 |
|---|---|---|
| `waveforge:spatial-params` | SpatialParams 快照 | 400ms 防抖 + 与默认值深合并（数组整段替换），坏数据回默认 |
| `waveforge:hrtf-active-dataset` | 活动 HRTF 数据集 id | `setHrtfDataset` 写入 / `restoreHrtfDataset` 读取（跨重启自动恢复锚点） |
| IndexedDB `waveforge-hrtf` / `datasets` | 网格本体（结构化克隆） | key = 日期戳 id（字典序=时间序） |

### 6.4 公共 API

**`attachV3Engine.ts` re-export**（调音室 UI 经此读写，`V3Adapter` 不直接碰空间 API）：

```ts
getSpatialParams(): SpatialParams                          // 惰性恢复持久化快照
setSpatialParams(p: SpatialParams): void                   // 整包替换（快照语义）：持久化 → 通知订阅 → 同步实时链
patchSpatialParams(partial: DeepPartial<SpatialParams>): void  // 深合并局部修改（数组/Float32Array 整段替换）
subscribeSpatialParams(cb: (p: SpatialParams) => void): () => void  // 订阅，返回退订函数
isSpatialActive(): boolean                                // mode !== 'off'
getSpatialStats(): SpatialStats | null                     // 最近一次处理器统计（~80ms 回传一次）
```

**`fusion.ts` 其余导出**（attachV3Engine 内部使用，UI/离线导出按需直连）：

```ts
spatialConfigFromParams(p: SpatialParams): SpatialRenderConfig   // 参数 → 渲染配置（全量替换语义）
syncSpatialChain(getV3Node: () => AudioNode | null, handle: { audioContext; analyser } | null): Promise<void>  // 实时链同步（attach 流程调用）
unwireSpatial(): void                                       // 摘除空间链，恢复 v3 → analyser 直连（detachV3Engine 调用）
multichannelLayout(channels: number, settings?): VirtualSpeaker[]  // 输入声道数 → 5.1/7.1 布局（multichannelAuto 用）
setHrtfDataset(grid: HrtfGrid | null): void                 // 设 HRTF 数据集：校验 → 采样率适配（重采样）→ IDB 持久化 → 活动记录 → postGrid 热更新；null = 恢复内置网格
restoreHrtfDataset(): Promise<boolean>                      // 跨重启恢复活动数据集（attach 流程调用；无记录/损坏 → false 不抛）
resampleGrid(grid: HrtfGrid, targetFs: number): HrtfGrid    // 网格整体重采样（多相 Kaiser-sinc；fs 一致原样返回）
createExportBackend(sampleRate: number): SpatialBackend | null  // 离线导出后端工厂（wasm 优先 / TS 兜底 + 网格装载）
HRTF_ACTIVE_DATASET_KEY: string                             // 'waveforge:hrtf-active-dataset'
```

辅助类型：`SpatialStats = { latencySamples: number; backend: string; inputChannels?: number; avgProcessMs?: number }`（`avgProcessMs` = 处理器侧 process() 墙钟均值，经 `estimateCpuPercent` 换算 CPU%）；
`SpatialBackend` 接口方法：`loadHrtf / setConfig / setListener / processStereo / processMulti?（可选，多声道输入，缺失时处理器回退 2 路下混）/ getLatencySamples / reset`。

### 6.5 WASM 契约（`rust/hrtf-core` 的 16 个 `spatial_*` 函数）

全部 `#[no_mangle] pub extern "C"`（无 wasm-bindgen、无导入导出依赖、同步实例化）。
`VirtualSpeakerRaw` 为 24 字节 `repr(C)`（u32 channel + 5×f32：azimuth/elevation/distance/gain/size），
与 JS 侧 `VirtualSpeakerRaw` 对齐。语义一行 + 返回码：

| # | 函数 | 签名要点 | 语义 |
|---|---|---|---|
| 1 | `spatial_load_hrtf` | `(sample_rate, az_count, el_count, hrir_len: u32, az_ptr, el_ptr, left_ptr, right_ptr: *const f32) -> i32` | 载入 HRTF 网格（拷贝入内部静态存储，可重复调用换数据集）；0 成功 / -1 维度非法 / -2 空指针 / -3 尺寸溢出 |
| 2 | `spatial_set_config` | `(speakers: *const VirtualSpeakerRaw, speaker_count: u32, room: u32, room_amount, amount, distance_model: u32, master_gain: f32) -> i32` | 渲染配置**全量替换**（预计算每 speaker 分区谱与增益、重建房间与流式状态）；`room` 索引保留 ABI 兼容但忽略（房间由 `set_room*` 设置）；0 / -1 未 load_hrtf / -2 超限 / -3 空指针 / -4 距离模型非法 |
| 3 | `spatial_set_room` | `(width, height, depth, reflectivity: f32, early_orders: u32, rt60_sec: f32) -> i32` | 自定义房间几何（§3.2 契约；本轮 JS 侧不调用，ABI 就绪）；0 / -1 参数非法 / -2 未 load_hrtf |
| 4 | `spatial_set_room_preset` | `(preset: u32) -> i32` | 房间预设 0=off 1=studio 2=hall 3=stage 4=church 5=outdoor 6=bathroom 7=corridor（参数表与 TS `roomSim.ts` 一致，改一处必须同步另一处）；0=off 全旁路；0 / -1 非法 / -2 未 load_hrtf |
| 5 | `spatial_set_hrtf_interp_mode` | `(mode: u32) -> i32` | HRTF 插值 0=nearest（最近邻查表）/ 1=spherical（球谐插值，与 TS `hrtfInterp.ts` 逐位对齐）；配置语义，`spatial_reset` 不重置；-1 非法 |
| 6 | `spatial_set_doppler` | `(velocity_x, velocity_y, velocity_z: f32, enabled: u32) -> i32` | 多普勒（模式 C）：听者速度 m/s + 开关；rate=clamp(c/(c−v·dir), 0.5, 2.0)，rate==1 直通（逐位回归）；0 / -1 未 load_hrtf |
| 7 | `spatial_set_convolution_mode` | `(mode: u32) -> i32` | 卷积 0=partitioned（FFT 分区，默认）/ 1=time（时域直接卷积；同块调度同放行、干湿对齐/脉冲位置一致、输出仅差 FFT 圆整 ≤1e-4）；-1 非法 |
| 8 | `spatial_set_occlusion` | `(amount: f32) -> i32` | 遮挡/衍射简化（§4.7）：0..1 钳位 → 每 speaker 增益衰减 gain·(1−0.8·occ) + 空气式低通 fc=12000·(1−occ) Hz；0=全旁路（逐位回归）；0 / -1 未 load_hrtf |
| 9 | `spatial_render_objects` | `(in_l, in_r, out_l, out_r: *mut f32, frame_size: usize) -> i32` | 双耳渲染热路径（每 speaker 卷积求和 + 干湿混合 + 房间；**稳态零分配**，每块一次） |
| 10 | `spatial_render_multi` | `(input_ptrs: *mut *const f32, frame_size: usize, out_l, out_r: *mut f32) -> i32` | 多声道输入渲染：N 路单声道 → 双耳（按 `speaker.channel` 取源、越界取 0 号；输入路数 = max(2, 最大 channel+1)，JS 侧指针数组长度与此一致） |
| 11 | `spatial_get_latency_samples` | `() -> u32` | 系统总延迟，**恒返回 512**（分区长 L；时域模式相同） |
| 12 | `spatial_reset` | `()` | 重置流式状态（房间几何/插值模式/卷积模式等配置语义不重置） |
| 13 | `spatial_alloc` | `(size: usize) -> *mut u8` | wasm 线性内存分配（alloc 后 `memory.buffer` 可能更换身份——JS 侧所有 Float32Array 视图在每次 alloc 之后重建，不跨 alloc 存活） |
| 14 | `spatial_free` | `(ptr: *mut u8, size: usize)` | 释放 wasm 内存 |
| 15 | `spatial_set_distance_model` | `(model: u32) -> i32` | 距离衰减模型 0=inverse 1=linear 2=exponential（与 `set_config` 的 `distance_model` 参数同一内部字段、后调者生效；`dist_gain_for` 共用公式重算每 speaker）；0 / -1 非法 / -2 未 load_hrtf |
| 16 | `spatial_get_hrir` | `(azimuth_deg, elevation_deg: f32, out_l, out_r: *mut f32, len: u32) -> i32` | 查询指定方向 HRIR 对（按当前插值模式 nearest/spherical，与 `build_speaker` 同源路径；不含 size 模糊）；0 / -1 未 load_hrtf / -2 len 不足或空指针 |

### 6.6 后端对拍机制与构建流程

**双后端对拍**（正确性保证，`wasmBackend.test.ts`）：

- TS 参考（`TsConvolverBackend`，复用 `dsp/Convolver.ts` 分区 FFT 卷积）与 Rust 内核算法结构完全对齐：
  分区长 L=512、FFT 1024（nextPow2(2L)）、湿路均匀分区卷积（overlap-add，Gardner 1995）、
  干路 512 样本延迟线对齐（系统总延迟 = L）、混合 `out = ((1−amount)·dry + amount·wetSum) · master_gain`。
- FFT 内核为自研基-2 蝶形（镜像 `src/dsp/fft.ts`：f64 twiddle / f64 累加 / f32 写回），与 TS 参考**逐位对齐**，
  保证 **1e-5 对拍容差有最大余量**；房间模拟（同预设表/同镜像枚举顺序/同延迟取整/同运算顺序）、
  球谐插值（同阶 L=3/同基函数/同伪逆）、多普勒重采样、声源大小扩散、遮挡低通均与 TS 侧
  （`roomSim.ts` / `hrtfInterp.ts` / `resampleSpeaker`）逐位对齐。
- **逐位回归门控**：直通路径（size=0、occlusion=0、多普勒关闭、rate==1、room=off）要求与
  无该特性的输出**逐位一致**（回归不改变既有行为）。
- **性能基准**（`perf-bench.test.ts`，64 对象、room=off、256 样本块）：WASM 看门狗 <5ms/块
  （规划书目标 <3ms，CI 波动余量；本机实测 ≈1.7ms/块 ≈3.1x 实时率）；TS 参考 <15ms/块
  （非性能目标，实测 ≈5.4ms/块 ≈1.0x 实时率）。

**构建流程**（`scripts/build-spatial-worklet.mjs`，四步，全部对缺失源优雅降级）：

1. **cargo**：`cargo build --release --target wasm32-unknown-unknown`（rust/hrtf-core）→ 产物复制到 `rust/hrtf-core/pkg/hrtf_core.wasm`（失败仅告警不中断）；
2. **网格内嵌**：`hrtf-data/grid.bin` 存在 → base64 内嵌生成 `src/spatial/data/grid.ts`；缺失 → null 变体（运行时合成网格兜底）；
3. **后端索引**：`WasmHrtfBackend.ts` 与 pkg wasm 都在 → 生成 wasm 变体（`backendIndex.generated.ts`，WASM_BASE64 内嵌，
   `createWorkletBackend` 优先 Wasm、构造失败降级纯 TS）；否则纯 TS 变体；
4. **esbuild**：entry `SpatialProcessor.ts` → bundle → `public/spatial-worklet.js`（iife + minify；
   AudioWorklet 全局作用域不支持裸 import/export，base64 解码用自实现纯函数）。

命令：`npm run build:spatial-worklet`；`predev` / `predev:electron` / `prebuild` 自动执行。
产物（`data/grid.ts`、`backendIndex.generated.ts`、`public/spatial-worklet.js`）均为"自动生成，勿手改"，
开发时先跑本脚本再提交生成文件。

### 6.7 扩展指南

- **加新模式**：① `types.ts` 加 `SpatialMode` 值 + `XxxSettings` 接口 + `createDefaultSpatialParams` 默认值；
  ② `fusion.ts` 的 `speakersFromParams`（扬声器推导）与 `spatialConfigFromParams`（房间/混合等 config 字段）加分支；
  ③ `SpatialPage.tsx` 加模式按钮与面板（标准视图卡片 + 专业视图共用面板组件）；④ 后端**一般无需改**——
  渲染只消费 `VirtualSpeaker[]` + `SpatialRenderConfig`（新增能力字段按"可选字段 + 后端缺省旁路"约定，保证回归逐位）。
- **加新后端**：实现 `SpatialBackend` 接口（`loadHrtf / setConfig / processStereo / processMulti? / reset / getLatencySamples`），
  在 `backendIndex.generated.ts` 的 `createWorkletBackend` 工厂加候选（注意该文件是生成产物——改生成脚本
  `build-spatial-worklet.mjs` 第③步而非手改文件）；遵守热路径约束（稳态零分配、不阻塞、每块一次、outL/outR 完整写入）；
  数值实现与 TS 参考对拍（1e-5 容差 + 直通路径逐位回归门控）。
- **加新数据集**：当前版本只使用 `analyticHrtf.ts` 的合成解析 HRTF。若后续引入外部数据集，需先实现并测试解析、采样率转换、持久化、格式/体积校验和 `postGrid` 热更新，再开放 UI；不要只增加无效入口。
  网格必须遵守 `HrtfGrid` 布局（`[elIdx·azCount + azIdx]` 行主序）。
- **约束提醒**：`fusion.ts` 仅主线程（渲染进程）使用——**worklet 处理器绝不 import 本模块**；
  localStorage / IndexedDB 键名勿改（跨版本兼容）；改 `ROOM_PRESETS`/布局表等单事实源时，TS 与 Rust 两侧必须同步（注释已标注）。