# 音频链路健康审计 —— 总结报告

> 审计方式：主代理基线探测 + 3 个并行审计子代理（链路/注入 A、DSP 边界/稳定性 B、组合/场景/双路径 C）
> 审计测试：`test/audit-chain.test.ts`（15 项）、`test/audit-dsp.test.ts`（82 项）、`test/audit-combo.test.ts`（27 项）
> 结论：**发现并修复 12 类问题（含 4 个高严重度）**；修复后全绿（当时 29 文件 / 320 用例）。设备档案移除后现为 **28 文件 / 313 用例，tsc 0 错误**（见文末追加）。

---

## 一、审计发现与修复清单

### 🔴 高严重度（阻断级：实时混响不可用 / 全链 NaN）

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| H-1 | **Convolver 流式长流必出 NaN**（约 32–85ms 后；@8k 10s 长跑 77440 个 NaN；引擎卷积混响 128 块在样本 3584 整链 NaN） | pending 队列指针线性增长不环绕 → 越界读 undefined；且旧测试被 `NaN > maxDiff` 恒假掩盖 | pending 改为**滑动窗口**（写前队尾越界即 copyWithin 压缩回头部）；convolver.test.ts 补显式 NaN 检测 |
| H-2 | **Convolver 流式分区 1..P 贡献丢失**（IR 长于分区时湿路只剩前 512 tap；delta@1000 流式湿路全 0） | ① `processWetBlock` 每块 `outAccum.fill(0)` 清空 Gardner overlap-add 累加器；② L/R 共用 outAccum、各左移一次 → 历史被后处理通道提前消耗 | ① 移除块内 fill(0)（仅 loadIR 清零一次）；② **每通道独立 outAccum**（outAccumL/outAccumR）；验证：delta@1000 → 位置 1512 峰值 1.0 ✓ |
| M-1 | **LoudnessComp fs=8k 输出 31811/32000 NaN**（auto 低音量/bright/warm/night 预设触发） | 内部 `designPeaking/designShelf` 无 fs/2 clamp：12kHz/6.3kHz 频点在 8k（Nyquist 4k）下 sin(w0)<0 → 极点出圆 | f0 clamp 到 `[1, fs·0.45]`；另补 `clamp` 拒绝 NaN（L-1 一并修复） |
| — | **Stretch 参数突变输出膨胀 14 倍**（rate/semitones 热切换后峰值 14.57，炸音级） | 合成 hop 突变 → 旧帧相位状态不匹配；且 WOLA 归一化阈值 1e-4 太苛刻，**部分帧（补零帧）IDFT 重建的窗边缘误差被除法放大**（实测 out/sArr = −14.4） | ① setParams 检测参数变化 → reset 内部状态；② 归一化阈值 1e-4 → **0.01**（窗边缘自然淡出）；修复后峰值 14.57 → 2.65 |

### 🟡 中严重度（听感/语义错误）

| # | 问题 | 修复 |
|---|---|---|
| M-2 | **MidSide vb=-1 "仅伴奏"失效**（midGain 恒 1，中信号未移除；vb=+1 去 S、vb=-1 不去 M 不对称） | 对称公式：midGain = 1+min(0,vb)、sideGain = width·(1−max(0,vb))；+1 仅人声、−1 仅伴奏；同步更新 API_SPEC + 新增 vb=-1 测试 |
| M-3 | **混响 mode='off' 路由失效**（enabled=true + mode=off 仍走算法混响，冲激 1.498 泄漏） | process 条件加 `mode !== 'off'` |
| M-4 | **eq.enabled=false 旁路不彻底**（profileId 非空时用户 EQ bands 泄漏 +12dB；无效档案 id 也激活链） | buildPreEqBands 在 eq 关闭时跳过用户 bands；_preEqActive 用 getProfileById 判空 |
| M-5 | **pitch.enabled 语义失效**（voiceBalance 无视开关被 M/S 无条件应用，diff≈0.4） | M/S 级 vb 门控：pitch.enabled=false → vb=0 |
| M-6 | **响度归一化启动 +9dB 膨胀**（无测量期 ref=-70 → gainDb=+56 → clamp +9dB，启动 3s 响度膨胀） | 无测量期 gainDb=0（不加增益）；externalGain 模式改平滑过渡（不再瞬时阶跃） |
| M-7 | **night-bass 场景高频过暗**（10–15kHz −33.5dB 越出 ±24dB 契约界） | 四轮调平收敛：EQ 16k −3→0、nightMode 8→1、deesser −28→−36/ratio 6、补偿预设 night→warm；实测 −33.5→**−22.4dB（回到 ±24dB 契约界内）**，特性化断言转正 |

### 🟢 低严重度

| # | 问题 | 修复 |
|---|---|---|
| L-2 | biquad f0≤0 clamp 1e-6 → lowpass 系数退化 DC≈0（"杀静音"） | 下限 1Hz→**10Hz**（与 Deesser 一致） |
| L-3 | PitchYin minHz>maxHz 未校验 | 非法参数返回 -1 |
| L-5 | biquad/EqChain 静态滤波 ±24dB 切换电平瞬变 ≈1.03 | 有界、非发散；建议 UI 层短斜坡（记录备查） |

## 二、确认正常（审计子代理验证通过）

- 默认参数全链直通：1kHz 0.5 正弦增益差 **0.000dB**；默认 limiter 不压正常信号
- 逐效果 enabled=false 旁路（11 组 diff=0）；零值参数直通（8 组 ≤1.19e-8）
- 11 场景 128 块长跑无 NaN、输出有界；场景 A→B→A 热切换无爆音
- 分享串：往返一致；越界/NaN/Infinity 解码全部 clamp/拒绝，应用后无 NaN
- 组合（Q 补偿+设备档案+LoudnessComp）频响 ±24dB 内有界；LUFS 读数 −3.05（理论 −3）
- 无自激：默认链 6s 零输入 <1e-9；混响尾单调衰减；stats/analysis 正常
- fft/biquad/EqChain/Deesser/Compressor/Limiter/BassEnhancer/ReverbSimple/LufsMeter/Resampler 的边界 clamp、10s 长跑、零输入衰减全部通过

## 二.5 补充说明（验收报告③缺失项收尾）

- **响度归一化无测量期行为**：实时表在未测得整合/短时响度时增益保持 0dB（不放大不衰减），
  测量就绪后按 3s 时间常数平滑趋近目标（修复 M-6 的一部分）；externalGain 模式同样平滑过渡。
- **已知备查项（低严重度，不阻塞融合）**：
  ① 卷积混响流式"末块尾截断"——最后未满块的湿输出需后续输入冲刷（流式固有语义，文档已注）；
  ② 3D 环绕级未收录于 API_SPEC 模块 A（实现为链内轻量立体声旋转，与 API_SPEC 的差异已注释）；
  ③ Limiter lookahead 变化重建缓冲时 gain 复位台阶（热切换边界跳变 0.33 @0.5 幅度，有界）；
  ④ 部分场景 ~1e-3（-60dBFS）级微小 DC 残余（偶次谐波整流+压缩包络调制，无累积、低于可闻阈值）。

## 三、验证方式

1. 修复前：3 子代理审计测试（it.fails 锁定缺陷）→ 全部复现
2. 修复后：审计测试断言反转（it.fails → it）+ 缺陷快照移除 → 全绿
3. 关键修复专项验证：Convolver delta@1000 → 延迟 1512 峰值 1.0；Stretch 突变峰值 14.57→2.65；LoudnessComp 8k NaN→0
4. 最终：**29 文件 / 320 用例全绿、tsc 0 错误、git 干净**（2026-08 设备档案移除后：**28 文件 / 313 用例**，见文末追加）

---

## 追加（2026-08 需求变更）：设备档案移除与计数更新

- **变更内容**：按用户要求不引入真实设备档案；`deviceProfile` 参数、`src/device/DeviceProfile.ts`
  （6 示例档案 + fitParametricEq）已删除；"机型频响补偿"改为 **LoudnessComp auto 按音量通用曲线**
  （音量越低 → 低频 0-12dB / 高频 0-6dB 提升，120Hz+12kHz shelf）。
- **测试调整**：`test/device.test.ts` 删除；audit-chain/audit-combo/codec 中 deviceProfile 引用清理，
  组合用例改为「EQ Q 补偿 + LoudnessComp」。
- **文档同步**：API_SPEC 模块 G、FEATURES #15、FUSION_GUIDE 映射表、统计文档、THIRD_PARTY_NOTICES 已更新。
---

## 追加（2026-08-18）：融合后计数更新

- **现状**：模块已融合进 WaveForge（`src/services/waveforge-engine-v3/`，经 `attachV3Engine.ts` + 统一适配层接入）；调音室 UI 为 HSE 风格 8 页导航。
- **测试基线**：29 文件 / **324 用例（319 过 + 5 LGPL 跳过）**、tsc 0 错误；2026-08-18 新增 BassEnhancer `lowBoostDb` 电平提升/越界钳制 2 用例、UI 冒烟 +1（场景保留音量断言，10 项）。
