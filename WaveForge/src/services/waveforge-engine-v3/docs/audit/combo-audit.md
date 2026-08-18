# 组合/场景/双路径链路健康审计报告（任务 C）

> 审计对象：waveforge-engine-v3（EngineV3 / ScenePresets / ShareCodec / DeviceProfile）
> 审计日期：本会话
> 测试文件：`test/audit-combo.test.ts`（27 个测试全部通过）
> 运行方式：`npx vitest run test/audit-combo.test.ts`

---

## ① 审计范围与文件

| 模块 | 文件 | 审计点 |
| --- | --- | --- |
| 引擎总成 | `src/engine/EngineV3.ts` | 链顺序、热切换状态延续、stats、分析路径、nightMode/IEQ/响度归一化 |
| 场景预设 | `src/engine/ScenePresets.ts` | 11 个场景快照逐个应用后的链健康 |
| 分享串 | `src/engine/ShareCodec.ts` | encode/decode 往返、白名单 + clamp 防注入、解码参数应用安全 |
| 设备档案 | `src/device/DeviceProfile.ts` | 内置档案 bands 叠加进 Pre-EQ 后的频响有界性 |
| 契约 | `src/dsp/API_SPEC.md` | 链顺序（LUFS 在 Limiter 前）、模块参数语义对照 |

**审计方法**：确定性输入（LCG 白噪声/正弦，无 `Math.random`）+ 容差断言。
- 频响：2048~4096 点 Hann 窗 FFT 多窗平均（50% 重叠），跳过起始段（限幅器 lookahead 240 样本 +
  混响建立 + 压缩 attack），按倍频程频带计算输出/输入平均电平差（dB）。
- 爆音：块边界逐样本跳变 vs 边界前 128 样本本地稳态跳变（8 倍容差 + 0.02 绝对容差 + 1.0 硬上限）。
- 自激/DC：场景处理 1s 后切静音，2s 内输出峰值 <1e-3。

---

## ② 发现的异常（按严重度排序）

### 异常 1（中）：night-bass 场景链频响超出 ±24dB 契约界

- **位置**：`src/engine/ScenePresets.ts` night-bass 场景定义（EQ / deesser / bassEnhancer /
  loudnessComp 'night' / nightMode 8）+ `src/engine/EngineV3.ts`（nightMode 6kHz shelf -12dB、
  主压缩 6:1 与夜间压缩 8.4:1 串联、deesser 触发）。
- **现象**（0.25 幅度白噪声，-12dBFS 量级）：
  - 10–15kHz 倍频程平均响应 **-33.5dB**（契约下界 -24dB），逐倍频程响应实测：
    `-3.8, -4.8, -6.2, -8.0, -9.7, -11.5, -18.8, -29.6, -33.5` dB；
  - 40Hz–15kHz 全带响应跨度 55.3dB（>48dB）；
  - 输入电平越高越严重：0.05 幅度 → 10–15k 为 -16.7dB（勉强达标）、0.5 幅度 → -43dB、span 60.7dB；
  - 总增益 -18.3dB（仍在 ±30dB 契约界内）；输出峰值 0.24（限幅器压限）；无 NaN、无自激。
- **复现测试**：`audit-combo.test.ts` → `A. 场景预设链健康` →
  `scene=night-bass：10-15kHz 响应低于 -24dB 契约界（异常锁定，特性化断言）`。
- **根因推测**：静态高频衰减堆叠 —— 场景 EQ -3dB@16k + loudnessComp 'night' 预设 -2.5~-3dB@10–16k +
  nightMode 高频 shelf（amount=8 → -12dB@6kHz 以上）在 16kHz 处累计约 -18dB；再叠加动态处理：
  deesser（centerHz 6000、threshold -28dB、ratio 10）在常规电平下持续压高频、bassEnhancer even 谐波
  在低频侧额外加能量、双压缩串联（-24dB/6:1 主 + -28.8dB/8.4:1 夜间）把整体电平再压低 18–33dB，
  使高低频能量差扩大到 55–60dB。
- **影响**：链数值稳定（无 NaN/发散/爆音），但该场景在常规及较大音量下的听感会非常暗/闷
  （高频严重缺失），与 ±24dB 链健康契约冲突；"深夜低音量"设计意图只能部分缓解。

### 异常 2（低）：loudnessNormalization 外部增益模式热切换无平滑（潜在增益阶跃）

- **位置**：`src/engine/EngineV3.ts`（`setParams`/process）——`useRealtimeMeter=false` 时
  `this._normGain = Math.pow(10, ln.externalGainDb / 20)` 直接赋值，无平滑（实时模式有 `NORM_SMOOTH_SEC`
  一阶平滑）。
- **现象**（代码审查 + 实测）：热切换改变 `externalGainDb` 时，下一块输出整块乘以新增益（瞬时阶跃）。
  实测（默认限幅器开启、块长 256、0↔12dB 切换）边界跳变 0.114 vs 本地稳态 0.04，未产生可闻爆音
  ——因为限幅器 lookahead（240 样本）+ attack 平滑吸收了阶跃；但**若限幅器关闭或切换点恰在信号峰值
  附近且增益变化大（0→24dB）**，会产生明显爆音。
- **复现测试**：校准脚本（审计后已删）测得 `loudnessNorm-ext maxBoundary=0.114 vs maxSteady=0.618`；
  审计测试 D 中默认场景未启用 loudnessNorm，此项作为**代码审查发现**记录。
- **根因**：v2 兼容语义"整曲测量换算增益直接施加"，未走 v3 实时测量平滑路径。

### 异常 3（低/观察项）：部分场景存在 ~1e-3（-60dBFS 级）微小直流残余

- **位置**：`dance`（bassEnhancer 'even' 全波整流）、`classical/dts/livehouse/vocal-stage`
  （压缩包络调制 + 宽声场交叉混合）。
- **现象**：精确零均值正弦输入（440Hz+1kHz 整数周期）下，输出均值 ≤1e-3（-60dBFS 级，dts 右声道
  1.04e-3、classical 左声道 8.2e-4 等）。无累积：切静音 2s 内输出衰减至 <1e-3，无 DC 自激。
- **复现测试**：校准脚本（已删）测量；审计测试 F（静音衰减）确认无累计。
- **根因**：偶次谐波整流（DC 分量未被 HPF 完全去除）与压缩/混响建立过程的不对称包络调制。
  低于可闻阈值，属非线性处理正常残余，非泄漏缺陷。

---

## ③ 确认正常的项

1. **10/11 场景链健康**（除 night-bass）：无 NaN；峰值全部 ≤0.89（限幅器 -1dBFS 上限生效，<1.5 契约）；
   总增益 -0.5~+4.2dB（±30dB 契约）；各倍频程响应 worst 16.8dB（pop，±24dB 契约）——契约断言全部通过。
2. **场景热切换 A→B→A**：11 场景依次切换 + 回到 pop（状态不重置），全程无 NaN；
   块边界最大跳变 0.141（livehouse→studio）远小于稳态跳变 0.596，无爆音。
3. **default ↔ 组合（Q 补偿+设备档案+LoudnessComp）每块热切换**：边界跳变 0.050 vs 稳态 0.280，无爆音。
4. **定向热切换**（loudnessNorm 实时模式开关 / IEQ 开关 / LoudnessComp 开关，每 256 样本切换）：
   边界跳变 ≤0.114 均小于对应稳态跳变，无爆音、无 NaN。
5. **分享串往返**：11 个场景快照 encode→decode 逐字段一致（含 sceneId/proBands/q/bands）；
   IR 数组不进入分享串（解码后 ir 恒为 null）。
6. **分享串防注入**：越界增益 ±999→clamp ±20、q 99/0→clamp 10/0.1、频率越界→clamp 20..20000；
   超长数组截断（proBands≤20、simpleBands≤5、lc.bands≤32）；非法枚举回落默认
   （reverb.mode 'nuclear'→'algorithmic'、harmonicType→'odd'、target→'harman'、bandCount 99→10 等）；
   NaN/Infinity（1e999→Infinity、字符串、null、布尔）按"非有限数→默认值"处理；
   全部解码参数应用后链路无 NaN、峰值 <1.5、总增益 ±30dB。
7. **stats 数值合理**：1kHz 0.5 幅度正弦 2s → lufsIntegrated = -3.05 LUFS（K 加权 1kHz 理论 ≈ -3，
   与 -6dBFS 输入吻合）、lufsMomentary = -3.05、peakDb = -6.02、limiterReductionDb = 0（≤0 ✓）、
   latency = 240 样本（5ms lookahead，≥0 ✓）。
8. **组合频响有界**：3 组组合（Q 补偿+示例耳机 A+夜间预设 / 示例耳机 B+auto 30% / 示例入耳 A+低频预设）
   全部无 NaN、峰值<1.5、各倍频程响应 ±24dB（span 39.6~42.2dB）、总增益 ±30dB。
9. **静音衰减（无自激/DC 累计）**：11 场景 + 组合处理 1s 噪声后切静音，2s 内输出峰值 <1e-3
   （最慢 dts 6.6e-5、classical 9.1e-7），衰减单调。
10. **相同参数重复 setParams 不改变输出**：两台全新引擎（一台额外重复一次相同 setParams）
    处理逐样本完全一致 —— 重复 setParams 无状态误重置。
11. **分析路径健康**：场景热切换（pop→night-bass→dts）后 getAnalysis() 仍返回有限频谱/特征。
12. **代码审查**：LUFS 采样点位于 Limiter 之前（API_SPEC 要求）✓；混响三路路由卷积 IR 空时自动回退
    算法混响 ✓；Limiter 禁用时直通且 reductionDb=0 ✓；EqChain Q 补偿在 setBands 时收敛（Gauss-Seidel
    阻尼 0.8）✓。

---

## ④ 建议修复方案

1. **night-bass 频响越界（中）**，任选其一或组合：
   - 降低 nightMode 强度：`amount` 8 → 5~6（shelf 衰减 -12dB → -7.5~-9dB）；
   - 放宽 deesser：threshold -28 → -34~-38dB、ratio 10 → 6，减少常规电平下持续压高频；
   - 场景 EQ 16kHz 段 -3dB → -1.5dB；
   - 或在引擎层对 nightMode 高频 shelf 施加最小电平约束（如高频响应下界 -24dB）。
   目标：0.25 幅度输入下 10–15kHz 响应回到 -24dB 以内（实测需改善约 9.5dB）。
2. **loudnessNormalization 外部增益阶跃（低）**：`setParams` 时若 `externalGainDb` 变化，
   复用 `NORM_SMOOTH_SEC` 的一阶平滑过渡（与实时模式一致），避免整块瞬时增益阶跃。
3. **微小 DC 残余（低/可选）**：bassEnhancer 'even' 整流后增加一阶 DC 阻断（HPF），或混响/压缩链后
   增加直流阻塞；为可选优化（-60dBFS 级，低于可闻阈值）。

---

## 测试通过统计

- `test/audit-combo.test.ts`：**27/27 通过**（A 场景链健康 11、B 热切换 2、C 分享串 6、
  D 双路径/stats 3、E 组合 4、F 静音衰减 1）。
- 全量测试套件中其他文件的失败均来自并行子代理进行中的审计文件
  （audit-dsp/audit-chain/_probe-chain*/_scratch*），不在本任务（任务 C）范围内。

---

## 追加（2026-08 需求变更）：设备档案整体移除

> 按用户新需求，设备档案（DeviceProfile）与 `deviceProfile` 参数已整体移除，
> `audit-combo.test.ts` 中相关组合用例（E 组 profile 参数、分享串 deviceProfile 字段）已同步清理；
> 组合测试保留「EQ Q 补偿 + LoudnessComp」并全绿。审计对象中的 DeviceProfile 项随之关闭。
