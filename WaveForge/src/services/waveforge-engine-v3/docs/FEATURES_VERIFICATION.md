# WaveForge 音频引擎 v3 —— 功能核验报告

> 目的：① 列出本模块实现的功能与代码位置；② 核验代码与效果的正常性（测试证据）；
> ③ 统计 MIT/LGPL 库使用情况；④ 二次调研 GitHub 上的 MIT/LGPL 候选库（避免造轮子）。
> 最终验证：**29 个测试文件 / 324 用例（319 过 + 5 LGPL 跳过，含 UI 冒烟 10 项），tsc 0 错误**（2026-08 实测；2026-08-18 更新：+2 lowBoostDb 用例、UI 冒烟 +1 场景保留音量断言）。

---

## 1. 功能清单与核验（对照《音频算法设计文档》§3 映射表）

| # | 功能 | 实现文件 | 算法依据（技术文档章节） | 测试覆盖 | 核验结果 |
|---|---|---|---|---|---|
| 1 | 10/20 段参数 EQ + **级联 Q 补偿** | `src/dsp/EqChain.ts`、`biquad.ts` | §1（RBJ 公式 + Q 补偿迭代） | eqchain(7)+biquad(9) | ✅ 补偿后控制点误差 <0.02dB；全 0dB 平直 ±0.02dB；无 NaN |
| 2 | 智能均衡 IEQ（Post） | `src/engine/EngineV3.ts` 内部 | §1.4 | engine(12) | ✅ 链内实现，3s 慢速平滑防抽吸 |
| 3 | 齿音抑制 De-esser（分带/宽带） | `src/dsp/Deesser.ts` | §4（侧链带通+LR-4 交叉） | deesser(5) | ✅ 8kHz 衰减 >3dB（理论 -24dB）、200Hz 不受影响 |
| 4 | 动态压缩（软拐点） | `src/dsp/Compressor.ts` | §3 | compressor(6) | ✅ 1/4 斜率 ±0.1；0dBFS→≈-15dBFS；makeup 生效 |
| 5 | 夜间模式（压缩增强+高频衰减） | `EngineV3.ts` 内部 | v2 语义 | engine(12) | ✅ 参数语义与 v2 一致 |
| 6 | 前瞻限幅器 + **真峰值** | `src/dsp/Limiter.ts` | §3.3（4× 过采样 sinc） | limiter(6) | ✅ 峰值 ≤-0.95dBFS；方波零过冲；latency=lookahead |
| 7 | 虚拟低频增强（4 种谐波非线性） | `src/dsp/BassEnhancer.ts` | §5 | bassenhancer(6) | ✅ even→120Hz/odd→180Hz 谐波 DFT 验证；四类型无 NaN |
| 8 | 分区卷积混响 + **IR 去周期化** | `src/dsp/Convolver.ts` | §2.1 | convolver(6) | ✅ 恒等/延迟/能量单调/去周期全通过；流式延迟=分区长 |
| 9 | 算法混响（Freeverb 类，5 类型） | `src/dsp/ReverbSimple.ts` | §2.2 | reverbsimple(5) | ✅ 能量衰减单调、干湿比、preDelay |
| 10 | 等响度补偿（auto/preset/custom） | `src/dsp/LoudnessComp.ts` | §6（v2 兼容公式） | loudnesscomp(7) | ✅ 音量 20%→120Hz 提升 >3dB、1kHz≈0dB；bass/flat/custom 全过 |
| 11 | 响度测量 **BS.1770 LUFS/LRA/真峰值** | `src/dsp/LufsMeter.ts` | §7 | lufsmeter(7) | ✅ 1kHz 满刻度 ≈-3.01 LUFS（±0.5）；门限/LRA/44.1k/32k 近似 |
| 12 | 响度归一化（实时测量驱动） | `EngineV3.ts` 内部 | §7.2 | engine(12) | ✅ -14 LUFS 目标、±9dB clamp、3s 平滑 |
| 13 | M/S 处理（宽度+人声比例） | `src/dsp/MidSide.ts` | §8 | mside(5) | ✅ 恒等路径误差=0；width=0→单声道 |
| 14 | 3D 环绕（轻量立体声旋转） | `EngineV3.ts` 内部 | v2 语义（降级实现） | engine(12) | ✅ 确定性旋转级 |
| 15 | ~~设备频响补偿（机型档案+拟合）~~ **已移除**（并入 #10） | — | — | — | ✅ 需求变更：改为按音量实施补偿的通用曲线（LoudnessComp auto，见 #10） |
| 16 | 听力分析流程 | `src/analysis/HearingTest.ts` | §12 | hearing(8) | ✅ 7 频点二分 5 轮，阈值收敛 |
| 17 | 频谱特征（质心/滚降/平坦度等） | `src/dsp/features.ts`、`analysis/Spectrum.ts` | §12（meyda 概念） | features(8)+spectrum(7) | ✅ 白噪声 flatness>0.8、单音≈0、质心/滚降正确 |
| 18 | 变速/变调（相位声码器） | `src/dsp/Stretch.ts` | §9 | stretch(8) | ✅ rate=2 长度 ±3%；+12 半音 440→880Hz ±1% |
| 19 | **LGPL 链接**：SoundTouch 变速/变调 | `src/dsp/StretchLgplAdapter.ts` + `vendor/soundtouchjs` | LGPL-2.1 未修改链接 | stretchlgpl(5) | ✅ rate=2 时长 ±8%；+10 半音 440→784Hz；位级确定 |
| 20 | 音高检测 YIN | `src/dsp/PitchYin.ts` | §10.1 | pitchyin(8) | ✅ 440/220 ±1Hz；谐波信号；噪声→-1 |
| 21 | 重采样（多相 Kaiser-sinc） | `src/dsp/Resampler.ts` | §13 | resampler(9) | ✅ 44.1↔48k ±0.5Hz；RMS 守恒 <1%；流式=一次性 |
| 22 | 声源分离任务队列 | `src/offline/Separator.ts` | §11 | separator(10) | ✅ 状态机/取消/失败恢复；ONNX 占位 |
| 23 | 分享串（版本+校验+白名单） | `src/engine/ShareCodec.ts` | 自研 | codec(12) | ✅ 往返一致；非法输入抛错；注入防护 |
| 24 | 11 组合场景预设 | `src/engine/ScenePresets.ts` | 设计文档 §3 | scenes(6) | ✅ id 唯一、参数合法 |
| 25 | 引擎总成（双路径实时/离线） | `src/engine/EngineV3.ts` | 设计文档 §2/§5 | engine(12) | ✅ 确定性、零分配、latency 计算、限幅峰值约束 |
| 26 | AudioWorklet 处理器 | `src/worklet/AudioEffectsProcessor.ts` | 设计文档 §2 | （打包期验证） | ✅ 结构正确；融合时 esbuild 打包单文件 |
| 27 | **引擎宿主/切换接线**（EngineV3Host） | `src/integration/EngineV3Host.ts` | 切换语义同 v2（先断后连/恢复直连/幂等/竞态防护） | integration(9) | ✅ worklet/script 双模式 + 回退；dispose 恢复直连；竞态下不接线；script 通路限幅实测生效 |

**合计 27 项条目（#15 已移除并入 #10，有效 26 项功能）/ 29 测试文件 / 324 用例（319 过 + 5 LGPL 跳过，含 UI 冒烟 10 项）/ tsc 0 错误。**

> **链路健康审计（2026-08）**：3 个并行审计子代理 + 主代理完成全链路排查（`docs/audit/`：
> chain-audit / dsp-audit / combo-audit / SUMMARY），发现并修复 12 类问题（含 Convolver 流式 NaN、
> 分区丢失、LoudnessComp 8k NaN、MidSide 仅伴奏失效、Stretch 突变炸音、响度启动膨胀等 4 高 7 中），
> 修复后全部断言转正、全量回归绿。

---

## 2. MIT / LGPL 使用统计

### 2.1 LGPL（链接使用，用户策略：不修改源码）—— 1 个
| 库 | 许可 | 用途 | 位置 |
|---|---|---|---|
| **soundtouchjs** v0.3.0（SoundTouch 核心） | LGPL-2.1 | 变速/变调可选路径 | `optionalDependencies` + **`vendor/soundtouchjs/`（原包副本，含 LICENSE）** + `StretchLgplAdapter.ts` |

### 2.2 MIT 直接套用（可选依赖）—— 2 个
| 库 | 许可 | 用途 | 状态 |
|---|---|---|---|
| meyda | MIT | 频谱特征（可选，未安装时自研特征照常） | optionalDependency |
| signalsmith-stretch | MIT | 变速/变调 WASM（可选，纯 JS 环境回退） | optionalDependency |

### 2.3 MIT/BSD 概念来源（自研实现，移植/借鉴并保留版权头）—— 8 个
DSPFilters(MIT, biquad TDF2 思路)、kissfft(BSD-3, FFT 蝶形)、stk(MIT 类, Freeverb 混响)、DaisySP(MIT, 压限接口思路)、signalsmith-basics(MIT)、speexdsp(BSD-3, 多相重采样)、meyda(MIT, 特征定义)；另有公开标准 RBJ Cookbook / ITU BS.1770 / ISO 226 / YIN(2002)。

### 2.5 响度归一化目标（-14 LUFS）说明

- **-14 LUFS 是主流流媒体响度目标**：Spotify / YouTube / TIDAL 均以 -14 LUFS 为整曲目标
  （v2 同款 `TARGET_LUFS = -14`），对音乐播放器合理；EBU R128 广播标准为 -23 LUFS、
  Apple Music 为 -16 LUFS。
- v3 的 `loudnessNormalization.targetLufs` 字段**可配置**，融合期可做成用户可调
  （如 -14 流媒体 / -16 Apple / -23 广播三档），EngineV3 链内实时测量驱动（替代 v2 的整曲测量+静态增益）。

### 2.4 GPL/AGPL 回避（本次调研确认）—— 0 引入
- **pitchfinder（GPLv3）**：YIN/AMDF 的 JS 实现，**许可证不符，不采用**——自研 PitchYin 正确避免了 GPL；
- Rubber Band(GPL)、Essentia(AGPL)、Freeverb3(GPL)、Superpowered(商业许可) 均不采用。

> 统计结论：**直接链接使用 LGPL 1 个 + MIT 可选 2 个 + MIT/BSD 概念移植 8 个 + 自研核心（16 DSP 模块 + 引擎）**；
> 全部许可有据可查（LICENSE 原文/源码头声明），GPL 零引入。

---

## 3. 候选库二次调研（2026-08，避免造轮子）

| 候选库 | 许可 | 对应 v3 模块 | 评估结论 |
|---|---|---|---|
| `@domchristie/needles` | MIT | LufsMeter（LUFS） | **不替换**：基于 WebAudio 节点（需 AudioContext），v3 是纯 TS 双路径引擎；可作 UI 侧附加参考 |
| `pitchfinder` | **GPLv3** | PitchYin | **不采用**：GPL 传染，v3 自研 YIN 正确 |
| `@audio/reverb-convolution` | MIT | Convolver | **不替换**：封装 ConvolverNode（非分区卷积 DSP），不满足 worklet 实时/离线一致设计 |
| reverbGen（IR 生成器） | MIT | 卷积 IR 素材 | 可选补充：生成内置 IR 时可用其思路（自研 dePeriodize 已覆盖） |
| Superpowered Web SDK | 商业许可 | 全部 | 不采用（非开源许可） |
| ffmpeg.wasm | LGPL | 解码/转码（非本模块范围） | 可选：WaveForge 侧如需解码增强可评估（未修改链接） |
| tunajs（Web Audio 效果集） | MIT | 效果器参考 | 基于 WebAudio 节点，与 v3 纯 DSP 设计不匹配；仅概念参考 |
| `@discord-player/equalizer` | MIT | EQ | 功能过简（BiquadFilterNode 封装），v3 的 20 段+Q 补偿已超集 |

**结论**：本轮调研未发现需要"替换自研"的库——v3 已正确使用 MIT/LGPL 生态
（soundtouchjs 链接 + meyda/signalsmith 可选），自研部分均有正当理由
（纯 TS 双路径架构 / 许可证规避 / 功能超集）。轮子没有白造，但每个轮子都有出处。

---

## 4. 交付自检清单

- [x] `npm install` 一键完成（vendor 含 LGPL 原包，离线可用）
- [x] `npm test` 319 过 + 5 LGPL 跳过 / 324 用例（29 文件，含 uiSmoke 10 项）
- [x] `npm run typecheck` 0 错误
- [x] 融合文档 `docs/FUSION_GUIDE.md` 完整（含 LGPL 合规指引）
- [x] 许可声明 `THIRD_PARTY_NOTICES.md` + `vendor/README.md`