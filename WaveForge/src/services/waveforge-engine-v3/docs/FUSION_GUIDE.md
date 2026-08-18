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