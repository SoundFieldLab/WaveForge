# 链路与注入审计报告（任务 A：chain-audit）

> 审计对象：`waveforge-engine-v3/src/engine/EngineV3.ts` 全处理链（含链上 DSP 模块）
> 审计测试：`test/audit-chain.test.ts`（15 项，全部通过）
> 审计日期：本报告随审计完成时生成；测试运行命令：`npx vitest run test/audit-chain.test.ts`

---

## ① 审计范围与文件

| 文件 | 角色 |
|---|---|
| `src/engine/EngineV3.ts` | 引擎总成：链顺序、级开关路由、响度归一化、3D 环绕、M/S、Pre-EQ、Deesser、Compressor、NightMode、混响路由、BassEnhancer、LoudnessComp、IEQ(Post)、LUFS 采样、Limiter |
| `src/dsp/Convolver.ts` | 分区卷积混响（流式 `processStereo` 路径） |
| `src/dsp/ReverbSimple.ts` | 算法混响（Freeverb 类） |
| `src/dsp/Limiter.ts` | 前瞻限幅器 |
| `src/dsp/Deesser.ts` / `Compressor.ts` / `BassEnhancer.ts` / `LoudnessComp.ts` / `EqChain.ts` / `MidSide.ts` / `biquad.ts` | 链上各级 |
| `src/types.ts`（`createDefaultParams`） | 默认参数模型 |
| `src/dsp/API_SPEC.md`（辅助模块 A） | 链顺序契约（唯一实现契约） |
| `research/docs/音频算法设计文档.md` §2 | 设计文档总体架构 |
| `src/engine/ScenePresets.ts` | 11 个组合场景快照 |
| 审计测试 | `test/audit-chain.test.ts`（15 项全通过） |

审计方法：代码路径逐级确认（不止看测试）+ 确定性复现测试（正弦/冲激/复合信号 + 容差断言）+ 128 样本块（AudioWorklet 典型块长）长跑。

---

## ② 发现的异常（按严重度排序）

### 异常 1 【高】Convolver 流式路径记账 bug → 输出 NaN，引擎卷积混响约 75ms 内整链死亡

- **位置**：`src/dsp/Convolver.ts` `processStereo()` / `processWetBlock()` 的 pending 队列记账（`pendingPos`/`pendingLen`/约束 `totalWetOut < totalIn - L`）。
- **现象**：
  - 直接使用 Convolver：`processStereo` 持续输入（512 样本块）→ 第 4 块（样本 2048）起输出 NaN；128 样本块同样在样本 2048 起 NaN。
  - 经 EngineV3（`reverb.mode='convolution'` + IR + 128 样本块）→ 样本 3584（约 75ms）输出 NaN（NaN 传播到整条链输出）。
  - 在 NaN 出现前，`writeAt = pendingPos + pendingLen` 已超出 `pendingWetL` 容量（`(P+2)·L`），越界写被 JS 静默丢弃 → 湿路尾部同时被截断。
- **复现测试**：`audit-chain.test.ts` ⑦「缺陷快照#1a / #1b」（锁定当前缺陷行为，修复后应反转）。
- **根因推测**：`pendingPos` 只在 `pendingLen === 0` 时归零；流式输入下 `pendingLen` 几乎不会归零（128 样本块时每 4 块产出 L=512、每块只排空 128 → 稳态 `pendingLen≈512` 永不归零），于是 `pendingPos` 单调递增，越过缓冲容量后 `pendingWetL[pendingPos]` 读到 `undefined` → `undefined` 参与运算 → NaN。队列没有做环形（取模）寻址，是流式记账的根本缺陷。
- **影响**：AudioWorklet 渲染线程默认 128 帧/回调 —— 任何启用卷积混响（`mode='convolution'` 且 IR 非空）的会话都会在数十毫秒内整链静音/失真。属"链上致命"级。

### 异常 2 【中】混响 `mode='off'` 路由失效：`enabled=true` 时仍走算法混响

- **位置**：`src/engine/EngineV3.ts` `configureReverb()` 与 `process()` 第 8 级；`ReverbMode` 类型含 `'off'`。
- **现象**：`reverb.enabled=true` + `mode='off'` + `wet=1,dry=0` → 冲激输出峰值 1.498（混响尾），本应为 0（off=静音）。同时 `getLatencySamples()` 对 `mode='off'` 返回 0，而实际混响处理仍在进行（含 `preDelayMs` 引入的延迟）——延迟口径与实际处理不一致。
- **复现测试**：⑦「缺陷快照#2」。
- **根因推测**：`configureReverb` 只对 `mode==='convolution'` 特殊处理；`'algorithmic'` 与 `'off'` 都落到 `_reverbSimple`。`process()` 的开关只查 `reverb.enabled`。默认参数 `enabled=false` 掩盖了该问题，但任何 UI 组合（`enabled=true` 且路由 `off`）都会意外出声。
- **影响**：听感异常（本应关闭的混响出现），且延迟报告失真（下游对齐/补偿错误）。

### 异常 3 【中】`eq.enabled=false` 旁路不彻底：设备档案激活时用户 EQ 曲线泄漏；无效档案无回退

- **位置**：`EngineV3.ts` `setParams()`：`this._preEqActive = p2.eq.enabled || p2.deviceProfile.profileId !== null`；`buildPreEqBands()` 无条件合并用户 `simpleBands/proBands` 与档案 bands。
- **现象**：
  - `eq.enabled=false` + `deviceProfile.profileId='no-such-profile'`（无效 id）→ EQ 链激活且用户 bands（+12dB@1kHz）被施加（1kHz 0.5 正弦 maxDiff≈0.56）。
  - `eq.enabled=false` + 有效档案（example-headphone-a）→ 用户 bands 同样被施加（maxDiff≈0.37）——即"关 EQ"后设备档案场景下用户 EQ 曲线仍然生效。
- **复现测试**：⑦「缺陷快照#3」。
- **根因推测**：`eq.enabled` 只决定"无档案时是否处理"；一旦 `profileId` 非 null 就整链激活，且不区分用户 EQ 与设备补偿 EQ。无效 profileId（`getProfileById` 返回 null）也照样激活链并只施加用户 bands，无校验/回退。
- **影响**：听感异常（用户以为 EQ 已关，曲线仍作用；且档案 id 输错时静默施加用户曲线）。

### 异常 4 【中】`pitch.enabled` 语义失效：`voiceBalance` 无视开关被 M/S 级无条件应用；`semitones/rate` 在主链完全无效果

- **位置**：`EngineV3.ts` `process()` 第 3 级：`this._midSide.setParams(this._params.stereoWidth, this._params.pitch.voiceBalance)` 无条件执行；`pitch` 的 `semitones/rate` 仅通过 `getStretch()` 暴露（不内联进主链）。
- **现象**：`pitch.enabled=false` + `voiceBalance=0.8` → 输出与输入 maxDiff≈0.4（人声/伴奏比例仍作用）；反之 `pitch.enabled=true` + `semitones=+12` 在主链输出完全不变。
- **复现测试**：⑦「缺陷快照#4」；另见 `audit-chain.test.ts` ②（voiceBalance 被排除在旁路清单外，因它不由 pitch.enabled 控制）。
- **根因推测**：参数分组把 `voiceBalance` 放在 `PitchSettings` 下，但引擎把它并入 M/S 级且不检查 `pitch.enabled`；而 Stretch 按设计（API_SPEC/EngineV3 头注释）不内联主链。结果是 pitch 组参数语义自相矛盾：唯一的"生效参数"不受开关控制，受开关控制的参数不生效。
- **影响**：UI 层 `pitch.enabled` 开关对 `voiceBalance` 无效（用户关闭 pitch 仍被人声比例改变音色）。

### 异常 5 【低】`voiceBalance=-1` 语义与"仅伴奏"字面不符（中信号保留，仅增强侧信号）

- **位置**：`MidSide.ts setParams()`：`vb<0` 时 `midGain=1`、`sideGain=1+|vb|`。
- **现象**：`voiceBalance=-1` 期望"仅伴奏（去掉中信号/人声）"，实际只把侧信号增益到 2×，中信号保持 1× 原样输出——单声道输入（L=R）时输出≈输入（峰值 0.5，非 0）。对立体声输入，人声（中信号）并未被移除。
- **根因推测**：与 `MidSide.ts` 头注释"vb<0：midGain=1, sideGain=1+|vb|（增强侧信号 → 伴奏）"一致，属语义定义问题（"增强"而非"仅保留"）；API_SPEC 模块 4 测试要点只约束了 vb=+1 方向。
- **影响**：UI 上"仅伴奏"档位实际是人声保留 + 伴奏增强，听感与字面不符（低）。注：DSP 维度审计（audit-dsp.test.ts）亦发现此点（其断言"vb=-1 输出≈0"失败）。

### 异常 6 【低】卷积混响流式短块/末块尾截断（与异常 1 同源的次要表现）

- **位置**：`Convolver.ts processStereo()`：只有 `inputPos` 填满分区长 L（512）才执行 `processWetBlock`。
- **现象**：输入不足一块（如 128 样本冲激）且流随后停止时，该块（含 IR 尾）的湿路贡献永远不会产出 → 卷积混响尾被截断最多 L 样本；流结束前最后一个未满块同样丢尾。（探针：128 样本冲激 + mix=1 → 湿路恒为 0，而一次性 `process()` 正确输出 [1,0.5,0.25]。）
- **根因推测**：流式路径没有"flush/补零收尾"语义；块边界记账（异常 1）也导致写越界丢块。
- **影响**：短输入片段混响缺失；会话结尾混响尾被硬切（咔哒风险）。

### 异常 7 【低】响度归一化（实时表）无测量期按 +maxGainDb 提升，启动 3s 响度膨胀

- **位置**：`EngineV3.ts` `process()` 第 1 级：`ref = Number.isFinite(measured) ? measured : -70`。
- **现象**：`loudnessNormalization.enabled=true` + `useRealtimeMeter=true` 时，首个 400ms 块之前（`getIntegratedLufs()`/`getMomentaryLufs()` 均为 NaN）`ref=-70` → `gainDb=+maxGainDb(9dB)`，并以 3s 时间常数缓慢爬升；若输入实际很响（如 -6dBFS），会出现数秒的 +9dB 响度膨胀再回落（限幅器会参与压限 → 抽吸感）。静音输入无听感影响（0×增益）。
- **复现测试**：⑦「缺陷快照#5」（3s 内输出峰值仍 > 输入峰值 0.5）。
- **根因推测**：无测量时把响度假定为 -70 LUFS（静音）→ 目标增益取最大。更稳妥的回退是首测前保持 0dB。
- **影响**：启用实时响度归一化时启动段听感异常。

### 异常 8 【低】链顺序与设计文档 §2 偏差（文档级，听感影响极小）

- **位置**：`EngineV3.ts` 链顺序 vs `research/docs/音频算法设计文档.md` §2。
- **现象/差异**：
  1. 设计 §2：… → 低频增强 → **Post-EQ → 等响度/响度** → 限幅器；实际（含 API_SPEC 辅助模块 A）：… → BassEnhancer → **LoudnessComp(等响度) → IEQ(Post)** → [LUFS] → Limiter。即"等响度"与"Post-EQ(IEQ)"顺序互换（两者均为线性滤波器，交换听感差异极小）。
  2. 实际链在 M/S 前插入 **3D 环绕** 级（API_SPEC 模块 A 未列出；EngineV3 头注释有说明）——契约漂移。
  3. 设计 §2 的"M/S 解码 … → M/S 编码"在引擎中折叠为单级 M/S（解码-处理-编码一次完成），链主体运行在 L/R 域而非 M/S 域——功能等价。
  4. 响度归一化增益（输入级）与 NightMode 为设计 §2 未明确列出的级（EngineV3 注释为 v2 兼容语义）。
- **复现测试**：代码审查（无失败测试；链顺序正确性由 `process()` 逐级比对 API_SPEC 模块 A 确认——除 3D 环绕外与 API_SPEC 完全一致）。
- **根因推测**：设计文档 §2 为粗粒度示意图，实际以 API_SPEC 模块 A 为契约；`3D 环绕` 为后加功能未回写契约。
- **影响**：文档与实现不一致；对听感影响极小（LTI 顺序交换）。

### 异常 9 【低】死参数：`ReverbSettings.convolution.dePeriodize` 从未生效

- **位置**：`EngineV3.ts configureReverb()` 构造 `new Convolver(sampleRate)` 未传 `ConvolverOptions`；`Convolver` 恒 `dePeriodize=true`。
- **现象**：类型中 `dePeriodize: boolean` 参数被忽略——用户无法关闭 IR 去周期化（对自然长尾 IR 会强制施加指数衰减窗）。
- **复现测试**：代码审查。
- **影响**：参数与行为不符（低）。

### 异常 10 【低】热切换时 Limiter 管线复位可能造成增益台阶（潜在咔哒）

- **位置**：`Limiter.ts applyParams()`：lookahead 变化 → 缓冲重建 + `gain=1` 复位；从 enabled 切回时清空延迟线。
- **现象**：21 组参数热切换实测无 NaN、样本跳变最大 0.33（0.5 幅度信号）——若此前处于压限（gain<1）状态，切换瞬间增益跳回 1 会造成电平台阶。
- **复现测试**：④ 热切换测试（断言有界 <1.0，通过）。
- **影响**：切换参数瞬间可能听到轻微咔哒（低）。

---

## ③ 确认正常的项

1. **默认参数全链直通**：1kHz 0.5 正弦增益差 = 0.000dB（<0.3dB 契约）；默认开启的 EQ（全 0 增益恒等）与 Limiter（-1dBFS 阈值不压 0.5 信号）在正常信号下不改变听感；默认链冲激延迟 = `getLatencySamples()` = 240 样本（lookahead 5ms），实测首个非零索引 240。
2. **逐效果 `enabled=false` 旁路**：eq（无档案时）/ deesser / compressor / nightMode / reverb（algorithmic 与 convolution 两路）/ bassEnhancer / loudnessCompensation / ieq / surround3d / limiter / loudnessNormalization —— 均输出 == 全关基准（maxDiff=0）。
3. **零值参数直通**（`enabled=true` 但参数语义直通）：eq 全 0 增益、deesser mix=0、deesser 宽带未触发（g=1）、compressor ratio=1/makeup=0/outputGain=1、nightMode amount=0、reverb wet=0/dry=1、bass mix=0 / harmonicGain=0、loudnessComp auto vol=100 / preset flat / custom 全 0、ieq strength=0、surround3d 直通参数、M/S width=1 vb=0、limiter 阈值 0 小信号、loudNorm externalGainDb=0 —— 全部 ≤1.19e-8（float32 舍入级）。
   - 注意（低）：deesser **分带式** 在 g=1（未触发）时输出为 LR-4 交叉全通——幅度不变（RMS 比 1.000126 ≈ 0.0011dB）但相位旋转（1kHz 0.6 正弦 maxDiff≈0.46）——非逐样本恒等；与模块注释"LP2+HP2 恰为全通（幅度不变）"一致，听感无影响，仅"未触发=严格直通"的直觉不符。
4. **尾块/自激**：Limiter 冲激延迟=lookahead，静音后尾=0；ReverbSimple 冲激尾随静音单调衰减（1s ≈8e-3、3s ≈4e-6，无自激/发散——注意：探针阶段曾因"把就地输出当输入再反馈"误报发散，修正后确认稳定）；引擎算法混响输入停止后尾峰 1.4e-3 且继续衰减至 <1e-6；引擎默认链 6s 零输入无 DC/自激（<1e-9）。
5. **场景/组合**：11 个场景快照（含 night-bass 多效果组合）128 样本块长跑 1.5s 无 NaN、输出有界（峰值 <3）。
6. **热切换**：21 组参数（默认↔极端↔场景）无 NaN、输出有界、样本跳变 <1.0；`getStats()`/`getAnalysis()` 全程不抛错并返回有限值；LUFS 采样点位于 Limiter 之前（符合 API_SPEC）。
7. **引擎内部**：`process()` 零分配；`setParams` 深拷贝不修改传入参数（现有 engine.test.ts 已覆盖）；单声道/双声道处理正常。

---

## ④ 建议修复方案

1. **【高】Convolver 流式队列环形化**（修复异常 1/5）：
   - `pendingPos`/`pendingLen` 改为环形寻址：`writeAt = (pendingPos + pendingLen) % cap`，读取 `pendingWetL[pendingPos % cap]`；或引入真正可增长的 FIFO（上限防护）。
   - 重审放行约束 `totalWetOut < totalIn - L`：当前实现使 `pendingLen` 永不归零导致 `pendingPos` 单调增长——要么允许 `pendingLen` 周期性归零并复位 `pendingPos`，要么环形读写。
   - 增加"flush/收尾"语义：流结束时把最后一个未满块补零处理，避免混响尾截断（异常 5）。
   - 回归：`audit-chain.test.ts` ⑦#1a/#1b 反转断言（改为全程无 NaN）。
2. **【中】混响三路路由显式化**（修复异常 2）：`configureReverb` 增加 `mode==='off'` 分支（`_useConvolver=false` 且标记 `_reverbActive=false`），`process()` 以"enabled && mode!=='off'"为处理条件；`getLatencySamples()` 与 `_reverbActive` 一致。回归：⑦#2 反转断言（off 时输出=0）。
3. **【中】Pre-EQ 激活条件细化**（修复异常 3）：`_preEqActive = eq.enabled || (profileId 有效且档案 bands 非空)`；`buildPreEqBands` 中用户 bands 仅在 `eq.enabled` 时加入；无效 `profileId`（`getProfileById` 返回 null）不激活链。回归：⑦#3 反转断言。
4. **【中】pitch 参数语义理顺**（修复异常 4）：`voiceBalance` 的应用以 `pitch.enabled` 为条件（或把 voiceBalance 移出 PitchSettings 归入 M/S 级参数）；明确 `semitones/rate` 主链不生效的 UI 语义（或按产品需求内联 Stretch）。回归：⑦#4 反转断言。
5. **【低】响度归一化首测回退**（修复异常 6）：无测量（NaN）时 `targetLin=1`（保持 0dB），首个 400ms 块后才启用增益；或把 -70 回退改为 0dB 回退。回归：⑦#5 反转断言。
6. **【低】契约同步**（修复异常 7/8）：把 3D 环绕级补写进 API_SPEC 模块 A；`configureReverb` 把 `convolution.dePeriodize` 传入 `ConvolverOptions`。
7. **【低】Limiter 复位平滑**（修复异常 9）：lookahead 变化时不清空 `gain`（保留当前平滑增益）或对复位做短渐变，避免增益台阶。

---

## 附：审计测试统计

- 测试文件：`test/audit-chain.test.ts`
- 测试数：15 项，全部通过（`npx vitest run test/audit-chain.test.ts`）
- 说明：⑦ 为"已知缺陷行为快照"，断言当前缺陷行为以保证确定性；修复上述异常后需将对应断言反转（改为契约断言）。

---

## 追加（2026-08 需求变更）：设备档案整体移除

> 按用户新需求（"不用加真实设备档案，机型频响补偿改为按音量实施补偿的通用曲线"），
> `src/device/DeviceProfile.ts`（含 getProfileById / 6 示例档案 / fitParametricEq）与
> `V3EngineParams.deviceProfile` 字段已**整体删除**。本审计的「异常 3：eq 旁路不彻底（档案场景）」
> 所依赖的档案机制已不存在，该缺陷以"代码移除"方式彻底消除；
> `audit-chain.test.ts` 对应用例已改为纯 `eq.enabled=false` 旁路断言（+12dB 用户 EQ 不泄漏）。
> 机型频响补偿由 `dsp/LoudnessComp.ts` auto 模式承担（按音量通用曲线，测试 loudnesscomp 覆盖）。
