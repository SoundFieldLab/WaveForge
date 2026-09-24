# AutoMix 三版对比与外部平台逆向报告

日期：2026-09-20
设备：MuMu 模拟器（已 adb root）
被测：QQ音乐 20.8.5.8（versionCode 7408）／网易云音乐 9.5.95（versionCode 9005095）

本报告回答三个问题：
1. 现有「标准版」「增强版」各自的实际行为与已知缺陷（用户听感在代码上的对应）。
2. QQ音乐与网易云的智能过渡分别怎么实现，哪些可借鉴、哪些不可用。
3. 新增 AutoMix Beta 应做一版还是两版。

---

## 第一部分：现有两版的实际行为

### 1.1 分派结构

`desktop/render-runtime.cjs:435-437` 决定走哪个 worker：

```
plan.strategy === 'smart-rendered-v2'
  ├─ plan.v2.backend === 'folia-htdemucs'  → 'render_folia' → render_transition_folia
  └─ else                                  → 'render_v2'    → render_transition_v2
否则                                        → 'render'       → render_transition   (v1)
```

第四条路径（DJTransGAN）不经 render_worker.py，走独立进程 `desktop/workers/djtransgan_worker.py`，
由 `render-runtime.cjs:1076` 的 `render:transitionAiMix` 独立 IPC 触发。

### 1.2 标准版（v1）

| 项 | 值 |
|---|---|
| strategy | `smart-rendered` |
| 规划函数 | `planTransition()` — `src/audio/transitionPlanner.ts:289` |
| 版本号 | `pitch-preserving-beatgrid-djfx-v4` |
| 渲染函数 | `render_transition()` — `desktop/workers/render_worker.py:514` |

切歌点由六项加权代价在 beat grid 候选窗中选出（`transitionPlanner.ts:365-370`）：
timbre 0.23 / chroma 0.15 / loudness 0.14 / vocal 0.20 / section 0.24 / confidence 0.04。

**用户听感「有一点点无缝味道」的来源**：等功率 cos/sin 增益曲线（`transitionPlanner.ts:180-186`），
逐采样 `np.interp` 插值（`render_worker.py:496-500`），曲线 C∞ 连续且无块边界 zipper。这部分是扎实的。

**用户听感「损失歌曲后半段 + 第二曲前端」的机制（已确认）**：

```
transitionPlanner.ts:312-327
  sourceEndCap    = duration - outroSilence        (skipSilence 默认 true)
  sourceEndFilter = min(duration * 0.75, sourceEndCap - 1)
  sourceWindows   = 候选点.filter(w => w.endTime >= sourceEndFilter)
  targetStartMin  = target.introSilence
transitionPlanner.ts:377-381  → 赋值 sourceStartTime / sourceEndTime / targetStartTime
render_worker.py:566-580      → 只加载 [sourceStartTime, sourceEndTime] 与 [targetStartTime, targetEndTime]
useAudioPlayer.ts:2088-2095   → currentTime >= sourceStartTime 即启动过渡
```

三个叠加因素：

1. **候选窗只要求结束于 75% 之后，不要求结束于真正曲尾**。规划器选的是「成本最低的乐句边界」，
   section 权重 0.24 且 drop/chorus 成本最低，因此倾向在某段落边界就切入——听感即「歌没唱完就切了」。
2. **outroSilence 误判会大幅放大丢失量**。`sourceEndFilter` 随 `sourceEndCap` 前移；
   若安静尾奏被判为静音（-45dBFS 绝对阈值，`autoMixAnalysisService.ts:575-588`），
   200s 的歌可能从 ~85s 就开始过渡。代码自身在 `autoMixAnalysisService.ts:576-578` 承认此风险。
3. **第二曲前端不独立播放**。`targetStartTime` 可达 `target.duration * 0.2`（`transitionPlanner.ts:324`），
   `[0, targetStartTime]` 段永不作独立开头。

「对 BPM」的感觉确有来源：`progressive_beat_stretch` 在 v1 确被调用（`render_worker.py:622-635`），
把已加载窗口内每一拍拉伸到共享输出网格。拉伸率硬限 `0.85..1.15`（`render_worker.py:190, 232-235`），
**任一拍越界即 `raise ValueError` → 整段渲染失败 → 上层降级为 `fixed-crossfade`**
（`useAudioPlayer.ts:1755-1800`）。但注意：拉伸不会静默丢弃后半段，丢弃完全由上文的窗口截断决定。

死代码：`TransitionRenderer.renderCrossfade`（`src/audio/TransitionRenderer.ts:512`）不可达
（`renderTransition` 与 `preRender` 均不传 sourceBuffer/targetBuffer，见 `:161/169` 与 `:119`）。
其内部用最近邻取曲线点（`:550-552`），若日后接上会引入 zipper noise。

### 1.3 增强版（v2）

| 项 | 值 |
|---|---|
| strategy | `smart-rendered-v2` |
| 规划函数 | `planTransitionV2()` — `src/audio/transitionPlanner.ts:720` |
| 版本号 | `automix-v2-dsp-r1` |
| 默认后端 | `folia-htdemucs`（可选 `djtransgan`） |

**规划层质量很高**（这部分没有问题）：Krumhansl-Schmuckler 调性检测 + Camelot 兼容度
（`:484-539`）、乐句对齐（`:551-558`）、能量匹配、整数倍部分同步
（`:137-164`）、谐波变调（`:697-713`）、`buildV2Choreography` 特效编排（`:593-689`）。

**但用户听感「效果很不好」，根因在渲染层被逐条确认**：

**(a) 默认路径把规划层的一切都丢了。**

```
render_worker.py:1162-1211  render_transition_folia()
  → 直接调 _render_stem_mix 并返回
  → 从不调用 apply_gain_curve
  → 返回 djEffectsApplied: False        (:1203)
  → 返回 v2ChoreographyApplied: False   (:1207)
render_worker.py:1143/1148  _render_stem_mix 内因 is_folia_backend 跳过 filterSweep / reverbDip
render_worker.py:1223-1224  render_transition_v2 拒绝 folia 计划
```

净结果：**默认路径 = 四轨线性增益包络 + 逐拍相位声码器拉伸，无 EQ、无滤波、无 riser、无鼓点填充**。
`transitionPlanner.ts` 里精心计算的 gainCurve（含 energy midShift、atmospheric 凹陷）在默认路径不生效。

**(b) stem 包络是线性的，交叉中点塌陷约 -3dB**（`src/audio/stemTransitionPlanner.ts:262-275`，
`fadeOut`/`fadeIn` 仅三个关键点，`plainBlend` 兜底为 [1→0]/[0→1] 全程线性）。
两路不相关时中点功率 = 0.25+0.25 = 0.5。full-mix 路径用等功率避免了这点，默认路径没有。

**(c) 完全没有响度对齐。** `computeGainOffsetDb`（`transitionPlanner.ts:282-287`）依赖
`TrackAnalysis.integratedLufs`（`src/audio/types.ts:153`），而该字段**全仓无写入点**
（唯一写入者 `loudnessNormalizationService` 作用于播放引擎，见 `App.tsx:2220/2595/5207`）。
故 `gainOffsetDb ≡ 0`，`render_worker.py:1391-1393` 补偿分支永不执行，
`render_worker.py:1116` `target_compensation ≡ 1.0`。交接点音量跳变是必然结果。

**(d) 时间拉伸用 `librosa.effects.time_stretch`（纯相位声码器）**
（`render_worker.py:130/136/173/181/244`），变调用 `librosa.effects.pitch_shift`（`:1122/1275`）。
对比见第二部分：两家外部平台都用成熟引擎。

**(e) 拍接缝缝合是死代码。** `render_worker.py:255` 的 8ms 缝合被 `quality_stretch and` 门控，
而 `quality_stretch` 在全部四个调用点均为 `False`（`:1129/1133/1337/1342`），全仓 0 个 `True`。
后果：`_quality_stretch`（HPSS + 谐波 PV + 打击乐 WSOLA，`:166-181`）与 `_wsola_stretch`（`:119-163`）
整体死代码，**无任何瞬态保持机制**；16 拍过渡 = 15 个潜在相位不连续点。
关闭原因见 `:1332-1337` 注释：手写 WSOLA 在稀疏打击乐上相关性搜索错位，
overlap-add 归一化 `out/acc` 在 `acc` 极小时爆炸，作者实测最大样本跳变 2209。
**即：问题从「爆音」变成了「糊」，但未真正解决。**

**(f) 其他确认的质量损耗**：

- bassSwap 用 2 阶 Butterworth @180Hz 分频（`render_worker.py:336-339`），12dB/oct 过缓，
  200–700Hz 严重泄漏；且交换点固定 `beat_count/2`（`:321`），未使用 planner 选出的 downbeat。
- 全部滤波用 `sosfilt` 而非 `sosfiltfilt`（`:309`），因果 IIR 相位延迟涂抹瞬态。
- `filterSweep` 是三段固定截止阶梯（120/360/900Hz，`:343-377`），非连续扫频，相位失真逐段累积。
- 后处理是全文件静态压缩 + 全文件 `tanh`（`:1469-1478`），非 lookahead limiter；
  峰值 >0.98 时 `tanh` 作用于全部样本。
- `fx_echo_boost = 2.0` / `fx_boost = 2.0`（`:1424/1455`）为经验性增益。
- `_band_split` 频段重叠 bug（`:933`）：`mid_high` 为「高通5k + 低通5k」≈ 全通，与 `high` 重叠，
  4 段求和高频双计。仅影响未接线的 `apply_learned_automation` 路径。
- stem 输入被降为 16-bit（`TransitionRenderer.ts:308-309` `forceWav=true` → `encodeWav`，
  截断而非舍入、无 dither，`:31-64`）。
- `htdemucs_runner.py:131-143` `resample_linear` 用 `np.interp` 线性插值（无抗混叠），
  在 `:293` 用于 48k→44.1k，混叠进入 HTDemucs 输入。
- DJTransGAN 全程单声道（`djtransgan_worker.py:288` `librosa.load(..., mono=True)`），
  全仓无 mono→stereo 上混；`:423` 在 1-D 输入时会把样本数当通道数传给 `_create_riser`，
  异常被吞 → riser/sweep/drumfill 静默失败。
- `render_worker.py:1059-1060` 图割失败时 `return source + target`（最差情况）。
- 渲染产物回到 `decodeAudioData` 后被 Chromium 再次重采样到设备采样率
  （`TransitionRenderer.ts:502`，`useAudioPlayer.ts:451`）。

**唯一正确的混音思路被限制在最窄分支**：`spectral_seam_mix`（`render_worker.py:989-1060`）
做逐频段图割式切换 + ±3 帧接缝交叉，是防相位抵消的正确做法，但仅在
`withoutBeatGrid && stem_output is None && len(automation) != 2` 时启用（`:1425-1428`）。
且它用单声道幅度谱算切点（`:1000-1003`）并对左右声道套用同一 cuts（`:1040-1053`），会破坏立体声像。

### 1.4 用户反馈的三项分轨/DJ 问题（全部确认）

**(1) 分轨「似乎没正常工作」— 存在多重静默降级链。**

```
autoMixStemService.ts:145-148   任何异常 → console.warn + return null
TransitionRenderer.ts:338-343   → buildDspFallbackPlan('Folia HTDemucs unavailable; using v2 DSP')
TransitionRenderer.ts:289-303   清空 backend / stemArtifacts / stemChoreography → 静默退回 v2 DSP
useAudioPlayer.ts:599-603/728-736  播放页落到 'unavailable'/'failed'，仅用户主动点开滑块可见
```

可判断真实状态的日志：`render_worker.py:1158`（`HTDemucs stem choreography applied`）、
`:1420`（`[folia] Beat This + HTDemucs stem transition applied`）、`:1207`（`stemMixApplied: True`）。
但 `render-runtime.cjs:461` 的 `automixLog.render:ok` **只记 duration，不记 `stemMixApplied`**，
需读 meta 文件才能判断——这是一个可核查性缺口。
另有 `TransitionRenderer.ts:335` 的 `HTDemucs stem refinement ready` 受 verbose 开关门控（默认不输出）。

worker 内部「声明 folia 却不用 stem」不可能（`render_transition_folia:1168-1173` 强制校验，
成功路径必然走 `:1188`）。唯一可能是 TS 在 dispatch 前降级，使消息变成 `render_v2`。

**(2) 播放页人声/伴奏滑块失效 — 与 AutoMix 分轨是两套独立数据。**

```
播放页：window.electron.trackStems (preload.cjs:168) → track-stem-runtime.cjs:61 → analysis-cache/track-stems
AutoMix：window.electron.stems      (preload.cjs:149) → stem-runtime.cjs:92      → analysis-cache/stems
```

两套 runtime、两套 runner、两套缓存，**完全不共享**。所以完全可能一份有数据另一份没有。
滑块本身是实时 Web Audio（`src/audio/trackStemMixer.ts:290-302` → 四个 GainNode，`:155-160`，
ramp ~30ms），与渲染无关。静默失效点：

```
useAudioPlayer.ts:739-748
  if (!mixer || transitionStateRef.current === 'running-transition') return   ← 静默 return
```

`mixer == null`（分轨未启用/失败）或过渡进行中时改值不报错、不生效。
进入过渡时还会 `locked: true` + `returnToOriginal()`（`:397-412`），把 busGain 拉到 0。

**(3) 「选了分轨就不能选 DJ」— UI 层无互斥，运行时后端二选一。**

UI 上：DJ 开关禁用条件是 `aiMixAvailable !== true`（`SettingsPanel.tsx:3609`），只取决于模型是否安装；
stem 下载按钮禁用条件是 `stemModelStatus?.supported === false`（`:3576`），与 DJ 无关。
两个 write handler 互不干涉（`SettingsPanel.tsx:1790-1809`；`globalSettingsRegistry.ts:504-533`）。

运行时确实互斥（`TransitionRenderer.ts:255-269`）：

```
// DJTransGAN long mix and HTDemucs separation are mutually exclusive so enabling
// the optional legacy AI does not run two models serially.
:338   if (strategy === 'smart-rendered-v2' && !djAvailable) { await prepareStemPlan() }
:396   if (useAiMix) { transitionAiMix(...) }        // DJ 直接接管
:352-357  DJ 可用但 sourceEndTime < 40 → 改走 folia stem
```

**开启 DJ 后同一次过渡不会跑 HTDemucs 分轨；想用分轨就必须关 DJ。**
用户感知与设计意图存在偏差，属确认的机制耦合。

相关设置项：分轨生效靠 `autoMixEnhanced`（`SettingsPanel.tsx:1399-1402`，registry `:499-511`）；
DJ 靠 `autoMixAiMix`（`SettingsPanel.tsx:1407-1410`，registry `:512-536`）。

**60s 硬编码确认**：`useAudioPlayer.ts:1852-1854`

```ts
const animationStartTime = plan.v2?.aiMix === true
  ? plan.sourceStartTime + 60 - 20      // ← 写死 60
  : Math.max(plan.sourceStartTime, plan.sourceEndTime - ANIMATION_LEAD_SECONDS)
```

60s 本身来自模型（`djtransgan_worker.py:8/15` 自述固定 ~60s，`:87-90` 读 `settings.N_TIME`，
外部 DJTransGAN 仓库 `D:/opencode/DJTransGAN` 不存在，无法核实数值），
但前端把它复制成了字面量，模型窗口一变动画时机即错。

**(4) v1/v2/folia 代码污染的确认证据**：

```
render_worker.py:1225   render_transition_v2 内写死 is_folia_backend = False  ← 死代码
                        （而同函数遍布 not is_folia_backend 分支 :1399/1456/1462/1464）
render_worker.py:1411   无条件调用 _render_stem_mix（该函数不看 backend，只看 stemArtifacts+choreography）
render_worker.py:1496   三元表达式永远返回 'v2-dsp'，即便实际应用了 stem → 元数据失真
TransitionRenderer.ts:447-454  专门处理「有 stemArtifacts 但 backend 非 folia」的 legacy 计划
```

即：同一份逻辑被多条路径共享，判定依据与调用上下文脱节。

---

## 第二部分：外部平台逆向

### 2.1 QQ音乐 20.8.5.8

界面（`AudioSettingActivity`）实为四档，不止两档：

| UI 文案 | 副标题 | 内部标识 |
|---|---|---|
| 智能混音·进阶交融 | 切歌点更智能 适配段落节奏特征 | `cue2_*` |
| 智能混音·基础渐变 | 更多保留原曲片段的丝滑衔接 | `cue_*` |
| 淡入淡出 | 前曲渐弱 后曲渐强 | crossfade |
| 无缝播放 | 自动跳过首尾静音片段 | gapless |

**云端层**（`classes8.dex`，包 `com.tencent.qqmusicplayerprocess.audio.supersound.automix`）：

```
automix/o.f(List, cb)          → music.mir.MirProxy   + cmd GetMIRByTrackIds
automix/k.n(JsonRequest, sub)  → music.mir.MixPlanSvr  + cmd Build
supersound/dj/e.f(List, cb)    → music.mir.MirInfoServer
```

请求参数（逐条指令验证）：`trackMIds`、`bid`、`options{songMids}`；MixPlan 用 `songMids`。
均经 `ModuleRequestArgs` → `ModuleRequestArgs.q(listener)`，走标准 `musicu.fcg` 模块化 CGI 通道。

响应解析（`o$b.onSuccess(ModuleResp)`）键名：

```
mid2MirDataGsonMap              以 songmid 为键
  cue_cuts / cue_entrys         基础渐变
  cue2_cuts / cue2_entrys       进阶交融
autoMixPlanInfo / autoMixType
curAutoMixMirInfo / nextAutoMixMirInfo
```

MIR 特征结构（`supersound/dj/gson/`）：

```
MirDataGson.DataGson { AbsPeakGson absPeaksGson; BeatsGson beatsGson;
                       BpmGson bpmGson; ChordsGson chordsGson; TimeSignGson timeSignGson; }
BeatsGson    { int[] beatNums; float[] beatStartTimes; String version; }
BpmGson      { float[] values; String version; }
ChordsGson   { String[] chordTypes; float[] startTimes; String version; }
TimeSignGson { int beatPerSection; int partNotePerBeat; String version; }
AbsPeakGson  { float[] absPeaks; String version; }
QQMusicCuePointInfoGson         { float[] cueCutList; float[] cueEntryList; long trackId; long timestamp; }
QQMusicCueAdvancedPointInfoGson { float[] cueCutList; float[] cueEntryList; long trackId; long timestamp; }
```

**关键事实：两档的 Gson 字段定义完全一致**。「进阶交融」不是另一套算法，
而是云端为同一首歌多算/精选了一组 cue 点，再由本地决定如何拼接。

**本地渲染层**：`libSuperSound3.so`（6,685,048 字节）导出符号中确认存在两套完整引擎：

```
SoundTouch  244 次引用：TDStretch（WSOLA）、RateTransposer、AAFilter（窗函数 FIR）、
                        BPMDetect（自相关 + updateBeatPos/getBpm）、FIFOSampleBuffer
RubberBand  808 次引用：RubberBandPitchShifter::processIn/processOut/processfIn/processfOut、
                        setPitchParameters、flushOut
AVAudioEngine 侧另有 MTrackMixer / ss_multi_track_mixing（多轨并行混音）
```

**没有任何自研相位声码器**。本地 so 内只有执行原语（`AutoMix`、`AutoMixInst`、
`SUPERSOUND214OneButtonRemix`、`RemixFadeInFadeOut`、`destroyRemixInstance`、`updatebpm`、
`vocal_accomp_mix_process_in/out`）。

**结论**：QQ音乐 = 云端给「切点/特征」+ 本地用成熟引擎渲染。
它的「好」来自引擎质量，不是来自云端数据。

### 2.2 网易云音乐 9.5.95

界面（`PlayerActivity` → 播放与显示设置）：两个独立开关，均默认「关闭」：

| UI 文案 | 副标题 | 资源 id |
|---|---|---|
| 智能过渡 | 智能分析音乐，让歌曲丝滑衔接，让听感更流畅 | `pfPlayAutoMix` |
| 淡入淡出 | 切换歌曲时交叉过渡，上一首声音渐弱，下一首声音渐强 | `pfPlayCrossFade` |
| 音量均衡 | 平衡不同音频内容之间的音量大小 | `playerLoudnessTitle` |

**类型枚举**（`module/player/automix/model/AutoMixType`）：
`NONE` / `CROSSFADE` / `ORIGINAL_CROSSFADE` / `SKIP_SILENCE` / `SMART_TRANSITION`

**核心方案结构 `MusicMixInfo`**（`module/player/automix/model/`）——这是最值得注意的部分：

```
bpm                          int
beatTimes / beatValues       List    节拍网格
volumeTimes / volumeValues   List    音量自动化曲线
tempoTimes  / tempoValues    List    速度自动化曲线
eqTimes / eqValues / eqItems / eqType / eqLeft / eqRight     EQ 自动化曲线
crossfadeStartTime / crossfadeEndTime
mixStartTime / mixEndTime
uiStartTime / uiEndTime
silenceTime
sid
```

配套结构：

```
AutoMixParams     { beatSyncEnabled; tempoSyncEnabled; mixBeginTime; mixPrepareTime; fakeChangeMusicTime }
TransitionParams  { aTransitionStartMs; aTransitionEndMs; bTransitionStartMs; bTransitionEndMs }   ← 双路 A/B
AnalyseParams     { mixTime; mixSkip; isMixed; mixType; transitionType }
AutoMixAnalyse    { inAnalyseParams; outAnalyseParams }
FeatureMixResult  { downbeatTimesA[]; downbeatTimesB[]; featureMap; mixInfoMap; featureFetchMs; jskCalcMs }
MixDetailInfo     { mixType; mixStrategy; mixParams; inMusicMixInfo; outMusicMixInfo;
                    customMixedResult; diagnostics; originResultStr; localUseMixDetailInfoId }
EqItem            { eqStartTime; eqEndTime; eqDuration; eqInterval; eqType; eqValues }
```

**这是「三重自动化曲线」模型**（volume / tempo / EQ 各带 times+values），
与 QQ音乐的「离散切点」模型思路不同——曲线表达力更强。

**特征存储**（关键设计）：

```
SongFeatureParam  { id; v }
SongFeatureDetail { id; sid; detail; version; createdTime }   ← 位于 .../songfeature/db/ 包
```

特征写入**本地数据库**（`songfeature/db/`），带 version 与 createdTime，可离线复用。

**计算内核**：

```
[FeatureMixExtractor] JSK
[FeatureMixExtractor] JSK extraInfo =
FeatureMixResult.jskCalcMs        与 featureFetchMs 分开计时
JSKernel = com.facebook.react.bridge.JSKernel   ← React Native bridge
```

即：网易云的混音方案计算跑在 **JS 内核**（RN bridge）里，本地计算，并分别计量
「特征获取耗时」与「JS 计算耗时」。这解释了 `jskCalcMs` 字段的存在。

**本地 DSP 层**：`libneaudioeffects.so`（1,442,832 字节）中确认：

```
RubberBandStretcher::Impl::Impl: rate = , options =
  → setTimeRatio / setPitchScale / setKeyFrameMap / setFormantScale
  → OptionWindowLong / OptionWindowShort / OptionWindowStandard
  → 完整 RubberBand 实现（含 RT / non-RT 模式判定）
多阶段交叉淡化状态机：
  'switch from stage %i to %i, x2 from %i to %i'
  'xfade level %i, inc?=%i'
  '%-3i preload=%i'
NCAudioEffectsProcessor::GetDefaultEffectChainOrder
audiofx::AudioEffects::Create
DynamicEQ（setDynamicEQBandParams / setDynamicEQDryWetMix / setDynamicEQOutputGain）
FIR（setFIRImpulse / setFIRON）、GraphEQ、ExParametricEQ、BassTreble、Compressor、Chorus、Flanger、Delay
```

**播放器层** `libncmaudioplayer.so`：

```
CNCMAudioPlayer::SetCrossFadeTime mCrossFadeTime %d
CNCMAudioPlayer::SetStartFadeTime mStartFadeTime %d
CNCMAudioPlayer::SetPauseFadeTime mPauseFadeTime %d
CNCMAudioPlayer::doCrossFadeSource start status %d
CNCMAudioPlayer::doCrossFadeSource audioformat is same nSamplerate %d, channel %d, wavF...
CNCMAudioPlayer::doGaplessSource Gapless audio format is different
```

**过渡状态机** `AutoMixTransition`（A/B 双路，classes20）：

```
AutoMixTransition/init, mixPrepareTime=
AutoMixTransition/checkPrepareB, posA=
AutoMixTransition/checkBDominant, posA=
AutoMixTransition/enterBDominant, bHandedOff=true
AutoMixTransition/checkStartMixing, posA=
AutoMixTransition/checkCompleted, both done
AutoMixTransition/aCrossfadeDone, posA=
AutoMixTransition/bCrossfadeDone, posB=
AutoMixTransition/setPhase,
AutoMixTransition/handleError, errorCode=
```

**PCM 提取链**（`playermanager/automix/editdata/`）：

```
SongPathExtractor$SongPathResult
PCMExtractorProvider
SongAudioSource$FragmentCache / SongAudioSource$FullFile
SongFeatureDetail（本地 DB）
```

**云端成分**（对比 QQ音乐，网易云的云端更轻）：

```
/api/song/enhance/player/url/v1    歌曲增强/特征相关
MixInfoDataManager/setMixDetailInfoByCMD   CMD 下发 mixDetail
getMixDetail / getMixDetailInfo_1 / getMixDetailInfo_2
```

**结论**：网易云 = 本地 JS 内核算三重自动化曲线 + 特征存本地 DB + 本地 RubberBand 渲染 +
A/B 双路播放器状态机。云端只做轻量补充分发。

### 2.3 两家横向对比

| 维度 | QQ音乐 | 网易云 |
|---|---|---|
| 方案形态 | 离散切点 `cue_cuts`/`cue_entrys` | 连续曲线 `volumeTimes/Values`、`tempoTimes/Values`、`eqTimes/Values` |
| 方案来源 | 云端 `MixPlanSvr` / `MirProxy` 主导 | 本地 JS 内核主导，云端轻量补充 |
| 特征缓存 | 播放器进程内存（`mid2MirDataGsonMap`） | **本地数据库**（`SongFeatureDetail`，带 version） |
| 时间拉伸引擎 | SoundTouch `TDStretch`（WSOLA） | **RubberBand** `RubberBandStretcher` |
| 变调引擎 | RubberBand `RubberBandPitchShifter` | RubberBand `setPitchScale` / `setFormantScale` |
| EQ | 本地 so 内 DSP | 独立 `libneaudioeffects.so`：DynamicEQ / GraphEQ / FIR / ExParametricEQ |
| 过渡状态机 | 单路 + cue 拼接 | **A/B 双路** `AutoMixTransition`，多阶段 `xfade` |
| 档位设计 | 四档（cue / cue2 / crossfade / gapless），数据字段相同 | 5 个 `AutoMixType` 枚举，非档位 |
| 自研声码器 | 无 | 无 |

**最重要的共同点：两家都没有自研时间拉伸算法，都直接集成 SoundTouch 或 RubberBand。**

---

## 第三部分：AutoMix Beta 的结论

### 3.1 Beta 应做一版还是两版：**一版**

证据支持三点：

1. **QQ音乐那两档在数据结构上是同一套字段的两个副本**。`QQMusicCuePointInfoGson` 与
   `QQMusicCueAdvancedPointInfoGson` 的字段定义逐字段相同（均为 `cueCutList`/`cueEntryList`/
   `trackId`/`timestamp`）。差别只在云端返回哪一组 cue 点（`cue_*` vs `cue2_*`）。
2. **网易云的 `AutoMixType` 是模式枚举而非档位**。`NONE`/`CROSSFADE`/`ORIGINAL_CROSSFADE`/
   `SKIP_SILENCE`/`SMART_TRANSITION` 中，只有 `SMART_TRANSITION` 是智能过渡，
   其余是「关闭」「普通交叉」「跳静音」。**智能过渡本身只有一个**。
3. **两家的多档本质是「同一引擎 + 不同参数 / 不同切点来源」**，不是两套算法。

因此 Beta 做成**一个引擎 + 可调参数**（强度、切点来源策略）比堆两个版本更合理，
也避免了现有 v1/v2 那种「两套路径互相排他、各缺一半」的问题。

### 3.2 Beta 应独立成第三档，不共享 v1/v2 代码路径

依据 1.4(4) 确认的污染问题：现有 `render_transition_v2` 内 `is_folia_backend` 死代码、
`_render_stem_mix` 绕过 backend 判定、元数据失真——这些都是「多路径共享同一函数」的产物。
Beta 若再插入现有分派，会加剧同类问题。

### 3.3 技术落点（按证据优先级）

1. **换时间拉伸引擎**。当前 `librosa.effects.time_stretch`（纯相位声码器）是
   「糊」与拍边界相位跳变的首要技术原因。两家外部平台都用成熟引擎。
   注意授权：SoundTouch 为 LGPL v2.1（动态链接 + 可替换即合规）；
   RubberBand 为 GPL 或需商业授权，**WaveForge 为私有许可，此处有合规风险，需先确认**。
2. **采用曲线模型而非仅切点**。网易云的 volume/tempo/EQ 三重 times+values 表达力强于
   QQ音乐的离散 cue 点，且我们已有 beat grid 可直接产出。
3. **接入响度对齐**。`TrackAnalysis.integratedLufs` 已有类型定义但无写入点，
   接通即可让 `computeGainOffsetDb` 生效（见 1.3c）。
4. **stem 包络改等功率**，消除交叉中点 -3dB 塌陷（`stemTransitionPlanner.ts:262-275`）。
5. **恢复拍接缝缝合**，把 `render_worker.py:255` 的 `quality_stretch and` 门控
   改为独立的 `seam_smooth` 开关。
6. **分频换 4 阶或线性相位**，并用 `sosfiltfilt` 替代 `sosfilt`（离线渲染负担得起）。
7. **A/B 双路状态机**参考网易云 `AutoMixTransition` 的相位划分
   （prepare → B dominant → start mixing → crossfade done → completed）。

### 3.4 不建议的方向（已评估并排除）

让 Beta 直接请求 QQ音乐的 `music.mir.MirProxy` / `music.mir.MixPlanSvr`：

- 接口挂登录态下的 `musicu.fcg` 签名链路，需复现
  `libTMEMars`/`libtmesec`/`libtmeshield`/`libckeygeneratorV2` 整套，属绕过请求签名保护。
- MIR 数据以 QQ音乐 `songmid` 为键，与网易云/Apple Music/B站/本地的 id 体系不互通。
- 云端只覆盖 QQ音乐有版权且已分析过的曲目，冷门歌/本地导入/live 版大面积退化。
- 商业竞品私有分析数据接入自有产品，存在不正当竞争风险。

且由 2.1 结论可知，**QQ音乐的好听来自本地引擎质量，不来自云端数据**，
因此这条路在技术上也不是达成目标的必要路径。

---

## 附：本次分析产物

| 路径 | 内容 |
|---|---|
| `.tmp-m/qqmusic-20.8.5.8.apk` | QQ音乐原始 APK（201,331,622 字节） |
| `.tmp-m/apk/classes*.dex` | QQ音乐 26 个 dex（协议分析用） |
| `.tmp-m/so/libSuperSound3.so` | QQ音乐 DSP 库（6,685,048 字节） |
| `.tmp-m/netease-9.5.95.apk` | 网易云原始 APK（188,782,744 字节） |
| `.tmp-m/neapk/classes*.dex` | 网易云 21 个 dex |
| `.tmp-m/ne/` | 网易云 6 个音频库（含 `libneaudioeffects.so`） |
| `.tmp-m/*.py` | androguard 分析脚本 |

均为临时产物，可随时删除。
