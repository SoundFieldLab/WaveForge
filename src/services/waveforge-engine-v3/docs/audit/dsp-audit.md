# DSP 边界与稳定性审计报告（任务 B）

> 审计对象：`waveforge-engine-v3/src/dsp/` 下 16 个模块
> 契约依据：`src/dsp/API_SPEC.md`（模块 1–16 签名与语义）
> 交付：`test/audit-dsp.test.ts`（82 项）+ 本报告
> 审计维度：① 参数无效/边界直通性 ② 零输入零输出（IIR 衰减/无 DC 泄漏/自激）③ 边界 clamp（fs 8k/96k/192k、频率 20Hz–20kHz/Nyquist、Q 0.05/30、增益 ±24dB/±60dB）④ 10s 长跑稳定性 ⑤ 参数突变（setParams 后立即处理，逐样本差值有界）⑥ 模块专项（Convolver 分区边界、Resampler 0.1x/8x、Stretch 极端 rate）
>
> 测试运行：`npx vitest run test/audit-dsp.test.ts` → **87/87 通过**（其中 修复后 0 项 it.fails（全部转正断言）——契约行为断言当前实现未满足，修复后应改回普通 `it()`）。
> 全量回归：`npx vitest run` → **29 文件 / 320 测试全部通过**（与并行子代理的 audit-chain/audit-combo 等共存）。

---

## ① 审计范围与文件

| # | 模块 | 源码 | 审计要点 |
|---|------|------|----------|
| 1 | fft | src/dsp/fft.ts | 冲激→全 1、正弦峰值 bin、往返误差、nextPow2/hann 边界 |
| 2 | biquad | src/dsp/biquad.ts | 0dB 直通、零输入衰减、fs/频率/Q/增益极值、10s、参数突变 |
| 3 | EqChain | src/dsp/EqChain.ts | 全 0dB 平直、零输入衰减、fs=8k 20 段极值、10s、参数突变 |
| 4 | MidSide | src/dsp/MidSide.ts | width/vb 恒等、width=0 单声道、vb=±1 语义、越界 clamp |
| 5 | Deesser | src/dsp/Deesser.ts | enabled=false/mix=0 恒等、低阈值重建、fs 极值、10s、零输入衰减 |
| 6 | Compressor | src/dsp/Compressor.ts | enabled=false 恒等、ratio=1/outputGain=0 语义、稳态压缩、参数突变平滑 |
| 7 | Limiter | src/dsp/Limiter.ts | enabled=false 恒等、lookahead=0/100ms、threshold -60、10s 限幅、延迟线冲洗 |
| 8 | BassEnhancer | src/dsp/BassEnhancer.ts | 三恒等、零输入零输出、四非线性、谐波存在性、零输入衰减 |
| 9 | Convolver | src/dsp/Convolver.ts | IR 1/512/10s、分区 32/8192、干湿混合、10s 长跑（一次性+流式双路径） |
| 10 | ReverbSimple | src/dsp/ReverbSimple.ts | wet=0/dry=1 恒等、冲激包络单调、反馈<1 稳定、零输入 10s 衰减 |
| 11 | LufsMeter | src/dsp/LufsMeter.ts | 1kHz ≈-3.01 LUFS、静音 NaN、fs 8k/192k、10s、LRA |
| 12 | LoudnessComp | src/dsp/LoudnessComp.ts | volumePercent=100 恒等、低频提升、零输入衰减、参数突变平滑、fs=8k |
| 13 | Resampler | src/dsp/Resampler.ts | 恒等 1e-6、44.1↔48k、0.1x/8x、10s、流式一致性 |
| 14 | Stretch | src/dsp/Stretch.ts | rate=2 长度、semitones=+12→880Hz、rate=8/0.1、10s、参数突变 |
| 15 | PitchYin | src/dsp/PitchYin.ts | 440/220Hz±1、噪声/静音/短窗 -1、fs=8k、非法 fs 抛错 |
| 16 | features | src/dsp/features.ts | 平坦谱/单音 flatness、质心、rolloff、zcr、空输入安全 |

辅助阅读：src/types.ts（参数模型）、src/dsp/StretchLgplAdapter.ts（适配层，未列入 16 模块，未深审）。

---

## ② 发现的异常（按严重度排序）

### 高严重度

#### H-1. Convolver.processStereo 流式路径：pending 队列指针越界 → 长流必然产出 NaN
- **位置**：src/dsp/Convolver.ts `processStereo` / `processWetBlock`（`pendingPos`/`pendingLen`/`writeAt` 记账；缓冲容量 `(P+2)·L`）。
- **现象**：连续流式输入超过约 `(P+2)·L` 样本后（@48k、分区 512、P=1 时 ≈32–85ms），输出出现 **NaN**：
  - IR=[1]、n=4096（TOTAL 4608）流式 → 输出在 index 2048 起全 NaN；
  - fs=8k、IR=0.1s（P=2）10s 长跑 → **77440 个 NaN**。
- **复现测试**（it.fails 锁定）：
  - `[ANOMALY-高] IR=[1]（P=1）长流（n=4096）流式：输出不产生 NaN（实测 ~2048 样本后 NaN）`
  - `[ANOMALY-高] 10s 长跑（@8k，IR=0.1s，P=2）流式无 NaN（实测 77440 个 NaN）`
- **根因推测**：pending 缓冲被当作**线性队列**使用——`writeAt = pendingPos + pendingLen` 单调递增，`pendingPos` 仅在 `pendingLen===0` 时重置，而放行约束 `totalWetOut < totalIn - L` 使队列**永不排空** → 写越界被 JS TypedArray 静默忽略（数据丢失），读越界返回 `undefined` → `l[i] = dryGain·l[i] + wetGain·undefined = NaN`。
- **附带发现**：现有 `test/convolver.test.ts` 的 `maxDiff` 比较对 NaN 不敏感（`NaN > maxDiff` 恒为 false，NaN 样本被静默跳过），因此**该缺陷未被现有测试发现**——测试应改为显式 NaN 检测。

#### H-2. Convolver.processStereo 流式路径：IR 分区 1..P 的贡献全部丢失（长 IR 湿声缺失）
- **位置**：`processWetBlock` 中每次块处理前 `this.outAccum.fill(0)`。
- **现象**：IR 长于一个分区（P≥2）时，湿路只保留**分区 0（IR 前 L 个 tap）** 的贡献：
  - IR=延迟冲激 D=1000（分区 512，D 落在分区 1）→ 流式湿路输出**全 0**（应出现延迟 1512 处的冲激）；
  - 对比：一次性 `process()` 路径（out 跨块累加、不清理）**正确**输出延迟 1000 的冲激。
- **复现测试**（it.fails 锁定）：`[ANOMALY-高] IR 长度 > 分区长（P≥2）流式：分区 1..P 的贡献必须保留（IR=延迟冲激 D=1000，实测湿路≈0）`
- **根因推测**：Gardner 分区卷积要求 outAccum 在块间**保留上一次移位后的残留**（overlap-add 跨块累加），`fill(0)` 将其清空 → 每个输出块只剩"当前输入块 × 分区 0"的首半段。与 H-1 同属流式状态机缺陷。
- **影响**：引擎实时路径（processStereo）的卷积混响**不可用**——短流 NaN、长 IR 湿声缺失；一次性 process() 路径不受影响。

### 中严重度

#### M-1. LoudnessComp 在 fs=8000 下系数失稳 → 输出 NaN
- **位置**：src/dsp/LoudnessComp.ts `designPeaking`/`designShelf`（拟合频点**无 fs/2 clamp**）。
- **现象**：fs=8000（Nyquist 4000Hz）下：
  - `mode:'auto', volumePercent:20` → 输出 **31811/32000 NaN**（auto 候选最高 6300Hz > Nyquist）；
  - `mode:'preset', preset:'bright'` → 同样 31811 NaN（bright 预设含 6300Hz 段）；warm/night 同理；
  - fs=48000 下全部正常（所有拟合频点 < 24k）。
- **复现测试**（it.fails 锁定）：`[ANOMALY-中] fs=8k、auto、volumePercent=20：输出不产生 NaN（…）`、`[ANOMALY-中] fs=8k、preset bright：输出不产生 NaN（…）`
- **根因推测**：f0 > fs/2 ⇒ w0 > π ⇒ sin(w0) < 0 ⇒ alpha < 0 ⇒ `a2=(1−alpha/a)/(1+alpha/a)` 超出单位圆 ⇒ 极点出圆 ⇒ 输出指数发散至 Inf/NaN。对照：biquad.ts/EqChain/Deesser/BassEnhancer 均有 `fs·0.45 / Nyquist` 级 clamp，唯独 LoudnessComp 未做。

#### M-2. MidSide voiceBalance=-1 未移除中信号（"仅伴奏"契约语义偏差）
- **位置**：src/dsp/MidSide.ts `setParams`（vb<0 分支 `midGain` 恒为 1）。
- **现象**：vb=-1 时纯中信号（L=R，0.5 幅度正弦）输出峰值 **0.5**（≈输入原样通过），中信号并未被移除；实测 vb=+1 时侧信号≈0（该方向符合契约）。
- **复现测试**（it.fails 锁定）：`[ANOMALY-中] vb=-1 → 中信号应≈0（契约"仅伴奏"：M 分量应被移除），实测未移除`
- **根因推测**：源码按"M 增、S 减"线性混合实现（vb<0 时 sideGain=1+|vb| 而 midGain=1，即"增强侧信号"而非"仅侧信号"），与 API_SPEC 标签"−1=仅伴奏(侧信号)"冲突。卡拉OK/去人声场景下与契约行为不一致（不对称：+1 完全去 S，-1 不去 M）。

### 低严重度

#### L-1. LoudnessComp NaN 参数（smoothingSeconds=NaN）→ 全 NaN 输出
- **位置**：LoudnessComp 的 clamp 工具不拒绝 NaN（`clamp(NaN,lo,hi)` 返回 NaN）。
- **现象**：`smoothingSeconds:NaN` → `alpha = 1−exp(−B/(NaN·fs)) = NaN` → 平滑增益 NaN → 系数 NaN → 输出 **4800/4800 NaN**。
- **复现测试**（it.fails 锁定）：`[ANOMALY-低] smoothingSeconds=NaN 参数：输出不产生 NaN（…实测 4800/4800）`
- **附注**：`volumePercent=NaN` 被 ≥0.25 选段阈值滤掉（无害）；biquad 的 `!Number.isFinite(a0)` 兜底可把 NaN 系数吸收为恒等直通（无害）——各模块对 NaN 的防御不一致。

#### L-2. biquad designBiquad f0≤0 clamp 到 1e-6 → 数值退化（lowpass DC 增益≈0，"杀静音"）
- **位置**：src/dsp/biquad.ts `designBiquad` 的 `f = clamp(f0, 1e-6, nyq·(1−1e-9))`。
- **现象**：`lowpass f0=0`（被 clamp 到 1e-6）时 b0/b1/b2≈0 → **任何输入（含 DC）输出≈0**（理论 DC 增益应为 1）；极点趋近 z=1（边缘稳定），但状态恒 0 不构成实际泄漏。
- **复现测试**（it.fails 锁定）：`[ANOMALY-低] lowpass f0<=0（clamp 到 1e-6）：DC 增益应为 1，实测 ≈0（…）`
- **根因**：clamp 下限 1e-6 过低，BLT 系数在 w0→0 时退化为 b≈0 / 极点贴单位圆。建议下限 ≥1Hz（Deesser/BassEnhancer 内联实现用 10Hz 即无此问题）。

#### L-3. 静态滤波器（biquad/EqChain）参数突变：系数阶跃 → 电平瞬变（有界、非发散）
- **位置**：Biquad.setParams / EqChain.setBands（状态保留 + 系数即时替换）。
- **现象**：±24dB 增益切换瞬间输出跳变 ≈1.03（输入幅度 0.5，24dB 阶跃本身）；**等响度切换**（+12dB@500Hz → +12dB@2kHz）跳变 = 信号自然斜率（比值 ≈1.0，无爆音）。逐样本差值有界，无 NaN/发散。
- **结论**：不构成数值爆音；±24dB 级切换是电平阶跃（听感为音量骤变），建议引擎/UI 层做数 ms 短斜坡。
- 动态模块（Deesser/Compressor/Limiter/BassEnhancer/LoudnessComp/ReverbSimple）参数突变均平滑（包络/分块增益平滑），测试通过。

#### L-4. Stretch 极端 rate 下输出长度偏差（固定 N 尾放大）
- **现象**：rate=0.1、10s 输入 → 输出长度 ≈ 期望 **+3.5%**（固定 N=2048 尾 + 尾部部分帧补零占比放大）；rate=8、短输入（0.5s）偏差可达 −7%（5s 输入时 ±0.7% 正常）。无 NaN/发散。
- **说明**：属相位声码器固定窗尾特性，引擎变速用例 rate 0.25..3 且输入较长时影响可忽略。

#### L-5. 其他信息级观察（非缺陷，记录备查）
- ReverbSimple wet/dry clamp 至 [0,4]（API_SPEC 语义 0..1，UI 应自行约束）。
- LufsMeter 非 44.1/48k 采样率按 48k 系数近似（已注释，fs=8k/192k 读数有限但量级合理）。
- EqChain.processStereo 双声道共享同一滤波器状态（L/R 逐样本串行），稳态一致、瞬态略耦合，属实现选择。
- Convolver.dePeriodizeIR 为 O(M·W)（10s IR @48k ≈2.3e8 次乘加），仅 loadIR 路径，可接受。

---

## ③ 确认正常的项（逐模块）

- **fft**：冲激→幅度谱全 1（1e-4）；440Hz@N=1024 峰值 bin 正确；逆变换往返 <1e-6；nextPow2(0/1/1000)、非 2 幂抛错、hannWindow 对称边界 0 —— **全部通过**。
- **biquad**：peaking 0dB 全频直通（1e-4）；零输入尾段衰减 <1e-4（无 DC 泄漏/自激，早期失败系测试取全块 max 所致，尾段正确）；fs 8k/96k/192k × 频率 20Hz–Nyquist × Q 0.05/30 × 增益 ±60dB 共 8 类型 64 组合无 NaN/有界；10s 长跑无 NaN（max|y|<20）；参数突变有界（除 L-3 电平阶跃）—— **通过**。
- **EqChain**：全 0dB 响应平直 ±0.02dB；零输入尾段衰减 <1e-4；fs=8k 20 段 ±24dB Q18 无 NaN（max|y|=1.77）；10s 长跑（随机增益+补偿）无 NaN —— **通过**。
- **MidSide**：width=1/vb=0 逐样本恒等（1e-7）；width=0 → L==R；vb=+1 侧信号≈0；width/vb 越界 clamp 行为一致；零输入零输出 —— **通过**（仅 vb=-1 见 M-2）。
- **Deesser**：enabled=false / mix=0 恒等；低阈值（-80dB）g≈1 时 LP2+HP2 重建幅度 ±0.05；fs 8k/192k、centerHz/ratio 极值无 NaN；10s 超阈值长跑无 NaN；零输入 1s 衰减 <1e-3 —— **通过**。
- **Compressor**：enabled=false 恒等且 reductionDb=0；ratio=1 无压缩、outputGain=0 静音；makeup ±24dB/knee 40/fs 8k/192k 无 NaN；0dBFS 正弦稳态压缩 ≈−14.1dBFS（契约 −15dBFS 量级）；参数突变（threshold/makeup 跳变）平滑 —— **通过**。
- **Limiter**：enabled=false 恒等；lookahead=0 正常；threshold −60/lookahead 100ms/fs 8k/192k 无 NaN 且输出 ≤−58.9dBFS；10s 长跑峰值不越阈；零输入延迟线冲洗为 0；参数突变块内连续差有界 —— **通过**。
- **BassEnhancer**：enabled=false / harmonicGain=0 / mix=0 恒等；零输入零输出；odd/even/atan/soft 四型无 NaN；fs 8k/192k、cutoff 极值、levelDb ±6 无 NaN；10s 长跑无 NaN；odd 型 60Hz → 180Hz 三次谐波存在（FFT 验证）；even 型零输入 1s 衰减 <1e-3（HPF 去除整流 DC）—— **通过**。
- **Convolver（一次性 process() 路径）**：IR=[1] 恒等；延迟冲激 D=1000 定位正确；分区 32 + IR 256（P=8）输出=冲激响应（1e-3）；IR=10s@8k 去周期化能量衰减（尾 RMS < 头 RMS/1000）无 NaN —— **通过**（流式路径异常见 H-1/H-2）。
- **ReverbSimple**：wet=0/dry=1 恒等（1e-9）；冲激输出 100ms 窗包络峰值后单调下降、尾端衰减 >50%；fs 8k/192k、roomSize 0.98/damping 0.99/wet·dry 4/preDelay 1000ms 无 NaN；10s 长跑无 NaN 且首末 1s RMS 比 1.015（无自激）；冲激后 10s 零输入衰减 <1e-3；参数突变无 NaN —— **通过**。
- **LufsMeter**：1kHz 满刻度单声道 ≈−3.01±0.5 LUFS（48k/44.1k）；静音 → NaN/-Infinity；fs 8k/192k 长处理读数有限且量级合理；10s 长跑读数稳定（0.5 幅度正弦 ≈−9.0 LUFS、peak −6.02dBFS）；LRA 两电平节目 ≈20±2.5 —— **通过**。
- **LoudnessComp**：volumePercent=100 全频恒等（±0.3dB，auto/preset/custom 三模式）；volumePercent=20 → 120Hz 提升 >3dB、1kHz ≈0dB（±0.3dB）；fs=48k 零输入 2s 衰减 <1e-3；参数突变分块平滑（跳变 <0.3）—— **通过**（fs=8k 见 M-1、NaN 参数见 L-1）。
- **Resampler**：44.1k→44.1k 恒等（1e-6）；44.1↔48k 频率 ±0.5Hz、RMS 误差 <1%；0.1x（48k→4.8k）与 8x（8k→64k）无 NaN、长度/频率/能量正确；10s 长跑无 NaN；processStreaming 与 process 公共区间一致（1e-6）—— **通过**。
- **Stretch**：rate=2 长度 ±3%；rate=1、semitones=+12 → 880±1%；RMS 功率保持 <3dB；极端 rate=8（5s）/0.1（10s）无 NaN、长度在容差内；10s 长跑无 NaN；参数突变（rate 1→2、semitones 0→12）无 NaN；rate/semitones 越界 clamp（100→8/+36）无 NaN —— **通过**。
- **PitchYin**：440Hz→440±1、220Hz→220±1（48k）；纯噪声/静音/短窗 → -1；fs=8k 440Hz 检出 ±3Hz；非法 fs 抛 Error、minHz>maxHz → -1 —— **通过**。
- **features**：理想平坦谱 flatness>0.99；单音 flatness<0.1、质心≈音高（±15Hz，整周期窗）；白噪声 flatness ∈[0.75,0.92]（Rayleigh 分布幅度谱渐近 ≈0.845，非 1）；rolloff 单调且 ≤Nyquist；zcr 噪声>正弦；空输入返回 0/安全默认（无 NaN/不抛）—— **通过**。

---

## ④ 建议修复方案

1. **Convolver.processStereo（高优先，H-1/H-2 同源）**
   - pending 队列改为**真正环形**（writeAt/pendingPos 对容量取模），或按"已产出 − 已消费"线性记账并把容量扩到最大在途块数·L（≥ (P+1)·L + 2L）；
   - `processWetBlock` **移除 `outAccum.fill(0)`**，恢复 Gardner 累加器语义（每次调用在上一次左移后的残留上累加当前块贡献；一次性 process() 路径可作正确性对照）；
   - 回归测试：流式输入 > 2·(P+2)·L 样本 + P≥2 IR（如延迟冲激落在分区 1）必须无 NaN 且湿路=延迟卷积；现有测试的 maxDiff 比较对 NaN 不敏感，应增加显式 `Number.isFinite` 检测。
2. **LoudnessComp（M-1）**：designPeaking/designShelf 的 f0 统一 `clamp(f0, 20, fs·0.45)`（或跳过 f0≥fs/2 的拟合段）；fs=8k 下 auto 候选 6300Hz 自然被排除，bright/warm/night 预设不再失稳。
3. **MidSide（M-2）**：vb<0 分支按契约"仅伴奏"改为与 vb>0 对称——`midGain=1−|vb|`（vb=−1 时 midGain=0、sideGain=2），并同步更新源码注释与 API_SPEC 说明，消除语义冲突。
4. **数值防御（L-1/L-2）**：所有 clamp 前加 `Number.isFinite` 校验（NaN → 采用默认值或跳过，至少不产生 NaN 输出）；biquad f0 clamp 下限从 1e-6 提升到 ≥1Hz。
5. **参数平滑（L-3）**：引擎层对静态滤波器（EQ 等）增益类参数突变施加数 ms 短斜坡，消除 ±24dB 级切换的电平阶跃听感。
6. **Stretch（L-4，可选）**：若需严格满足 rate=0.1 的 ±3% 长度契约，可在输出后做精确长度裁剪/补零（当前引擎用例 rate 0.25..3 不受影响）。

---

## 测试统计与复现命令

- 审计测试：`npx vitest run test/audit-dsp.test.ts` → **87/87 通过**（8 项 it.fails 锁定缺陷，见 ②）。
- 全量回归：`npx vitest run` → **29 文件 / 320 测试通过**。
- 缺陷复现的最小确定性样例（均在 test/audit-dsp.test.ts 中）：
  - H-1：IR=[1]、分区 512、流式 4096 样本 → index 2048 起 NaN；
  - H-2：IR=delta(1000)、分区 512、流式冲激输入 → 湿路全 0（一次性 process() 正确）；
  - M-1：fs=8000、auto volumePercent=20（或 preset bright）冲激 → 31811 NaN；
  - M-2：vb=−1、L=R 正弦 → 输出≈输入 0.5（应≈0）。
