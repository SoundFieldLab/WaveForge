# WaveForge v2 音效引擎深读分析（Task A 交付）

> 分析对象：`WaveForge/src/services/audio-effects-v2/`（v2 本地增强版音效引擎）
> 依据源码：`AudioEffectsEngine.ts`（1536 行）、`compensationService.ts`（178 行）、`loudnessNormalization.ts`（188 行）、
> `src/services/audioEngineVersion.ts`、`src/App.tsx`（switchAudioEngine / attach / 响度归一化接线）、
> `src/hooks/useAudioPlayer.ts`（AudioGraphHandle）、`src/components/MixingStudioV2.tsx`（1429 行 UI）、
> `python-beat-service/compensation_server.py`（3004）、`python-beat-service/loudness_server.py`（3003）、
> `WaveForge/test/audioEffects.test.ts`、`WaveForge/test/compensation.test.ts`。
> 结论对应 v3 目标契约：`waveforge-engine-v3/src/dsp/API_SPEC.md` 与 `research/docs/音频算法设计文档.md`。

---

## 1. v2 公开 API 面

### 1.1 类型（AudioEffectsEngine.ts 导出）

| 类型 | 定义 | 作用 |
|---|---|---|
| `EqMode` | `'simple' | 'pro'` | 均衡器模式：简约 5 段 / 专业 10 段（octave） |
| `ReverbType` | `'hall' | 'room' | 'plate' | 'spring' | 'stage'` | 混响类型（大厅/房间/板式/弹簧/舞台） |
| `CompensationMode` | `'auto' | 'preset' | 'custom'` | 频响补偿模式：等响度自适应 / 场景预设 / 自定义频段 |
| `EqBand` | `{ frequency: number; gain: number; q: number }` | EQ 频段（gain 单位 dB） |
| `EqSettings` | `{ enabled, mode, simpleBands: number[], proBands: EqBand[] }` | 均衡器设置（simpleBands 恒 5 元素、proBands 恒 10 元素） |
| `PitchSettings` | `{ enabled, semitones, rate, voiceBalance }` | 变调/变速/人声伴奏比例 |
| `CloudEffectsSettings` | 8 个效果子设置（见 §3） | 全部可叠加音效参数 |
| `AudioEffectsSettings` | `{ effects, eq, pitch, activeScene, customized, normalizationEnabled }` | 引擎顶层设置（持久化对象） |
| `SceneSnapshot` | `{ id, name, description?, builtin?, effects, eq }` | 场景方案快照（不含 pitch） |
| `DeepPartial<T>` | 递归可选 | 局部更新补丁类型 |

### 1.2 常量

- `SIMPLE_EQ_BANDS`：5 段 `{label, frequency, hint}`，频率 80 / 250 / 1000 / 4000 / 12000 Hz。
- `PRO_EQ_FREQUENCIES`：`[31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]`。
- `REVERB_TYPES`：5 种混响 `{value, label, hint}`。
- `LOUDNESS_COMPENSATION_THRESHOLD = 50`：系统音量低于该值提示开启补偿。
- 私有常量：`SETTINGS_KEY='waveforge:audio-effects-settings'`、`MY_SCENES_KEY='waveforge:my-scenes'`、
  `COMPENSATION_VOLUME_RESYNC=10`（音量档位 ±10%）、`COMPENSATION_SMOOTHING_SECONDS=0.2`（增益平滑 tau）。

### 1.3 类 `AudioEffectsEngine`（实例由 App 持有，UI 直接操作）

| 方法 | 签名 | 作用 |
|---|---|---|
| `getSettings` | `(): AudioEffectsSettings` | 返回当前设置（引用） |
| `getMyScenes` / `getBuiltinScenes` | `(): SceneSnapshot[]` | 我的场景（localStorage）/ 内置 7 场景 |
| `applySettings` | `(next: AudioEffectsSettings): void` | 整体替换设置（预设导入/恢复） |
| `updateSettings` | `(patch: DeepPartial<AudioEffectsSettings>): void` | 局部更新；手动修改置 `customized=true`；含互斥裁决（ADR-0002） |
| `toggleEffect` | `(key: keyof CloudEffectsSettings | null): void` | 切换单个音效开关（可叠加） |
| `applyScene` | `(scene: SceneSnapshot): void` | 应用场景快照（深拷贝写入 + 清 customized + 记录 activeScene） |
| `saveAsMyScene` | `(name: string): boolean` | 保存当前听感为我的场景（上限 8，空名拒绝） |
| `deleteMyScene` | `(id: string): void` | 删除我的场景 |
| `setNormalizationGain` | `(db: number | null): void` | 按曲目 LUFS 设置链首归一化增益（±9dB，null=关） |
| `setSystemVolume` | `(volume: number): void` | 告知系统音量（0-100，-1=未知），驱动频响补偿自适应 |
| `attach` | `(handle: { audioContext, masterGain, analyser }): void` | 把效果链插入 masterGain 与 analyser 之间（幂等） |
| `dispose` | `(): void` | 拆除效果链，恢复 masterGain→analyser 直连 |
| `exportToWav` | `(sourceUrl: string, durationSeconds: number): Promise<void>` | 离线渲染当前设置到 16-bit WAV 并下载 |

私有方法：`rebuildFromSettings`（幂等应用全部动态参数）、`rebuildEq`（EQ/补偿二选一重建）、
`applyCompensationDesign`（异步设计补偿段）、`applyCompensationGains`、`compensationDesignKey`、
`initSoundtouch`、`applyPitchSettings`、`syncSurroundRotation` / `startSurroundRotation` / `stopSurroundRotation`、`saveSettings`。

### 1.4 两个独立服务模块

- `compensationService.ts`：`CompensationService`（`design(mode, preset, volume, customBands?): Promise<CompensationDesign|null>`、
  `invalidate()`）+ 单例 `compensationService`；类型 `CompensationSegment`、`CompensationDesign`；常量 `COMPENSATION_PRESETS`（6 预设）。
- `loudnessNormalization.ts`：`LoudnessNormalizationService`（`getCachedLufs`、`measure`、`apply`、`reset`）+ 单例 `loudnessNormalizationService`；
  纯函数 `gainDbForLufs(lufs)`；常量 `TARGET_LUFS=-14`、`MAX_GAIN_DB=9`、`MIN_GAIN_DB=-9`。
---

## 2. 效果链顺序（buildEffectChain 节点顺序与 Web Audio 节点类型）

### 2.1 顶层路由（attach 建立）

`masterGain → normGain(链首归一化) → [SoundTouch(AudioWorkletNode, 异步插入)] → input → …效果链… → output → limiter → analyser`

- 链首：`masterGain.disconnect()` 全断后重连 `normGain`（先断后连，避免热切换后无声的经典 bug），
  `normGain → input` 再连。SoundTouch 注册成功后插入 `normGain` 与 `input` 之间（`prevNode.disconnect() → prevNode.connect(node) → node.connect(input)`）。
- 链尾：`output → limiter(DynamicsCompressor, threshold -6dB / knee 12 / ratio 12 / attack 0.003 / release 0.25) → analyser`。

### 2.2 效果链内部（严格顺序）

```
input
 → voiceMatrix (M/S 人声伴奏比例)
 → [EQ 段 | 频响补偿段]（二选一，动态插入，rebuildEq 管理）
 → presenceMatrix (M/S 人声/伴奏增强)
 → bassFilter  (BiquadFilterNode lowshelf, freq=effects.bassBoost.depth, gain=intensity×1.3)
 → bassPunchFilter (peaking, 55Hz, Q0.9, gain=intensity×0.55)
 → vocalFilter  (peaking, 3kHz, Q2.4, gain=vocalBoost.intensity×0.7)
 → accompFilter (peaking, 2.8kHz, Q1.6, gain=-accompanimentBoost.intensity×0.7)
 → compressor  (DynamicsCompressor, knee 6, 启用时 threshold/ratio 生效, makeup=outputGain)
 → nightShaper (WaveShaper, curve=null 直通占位——旧 tanh 波形整形已废弃，防谐波失真炸音)
 → nightGain   (GainNode, boost=1+amount×0.012)
 → nightCompressor (DynamicsCompressor, knee 12, threshold -24-amount×0.8, ratio 2.5+amount×0.25)
 → nightTreble (highshelf, 6.5kHz, gain=-(1.5+amount×0.45))
 → hallMatrix  (M/S 声场加宽: side=1+(level/10)×2.2, center=max(0.4, 1-(level/10)×0.42))
    ├─ 干路: hallMatrix.output → pannerDryGain → output
    ├─ 湿路: nightTreble → hallConvolver(ConvolverNode, 程序生成 IR) → hallWetGain(min(1,reverb/10)×0.95) → pannerDryGain
    └─ 3D 湿路: hallMatrix.output → panner(PannerNode, HRTF, inverse) → pannerWetGain → output
```

要点：
- **湿路从 nightTreble 分叉**（不经 hallMatrix 加宽），干路才过 M/S 加宽；3D 环绕路从 hallMatrix.output 分叉，
  不能挂在 pannerDryGain 上（否则环绕启用时干增益降 0 会把 panner 输入也变 0 → 完全无声）。
- **M/S 矩阵**（createMsMatrix）：ChannelSplitter(2) → 4 个增益（M=0.5/0.5、S=0.5/-0.5）求和 → centerGain/sideGain → 重组 ChannelMerger(2)。
  两个矩阵语义：voiceMatrix 由 voiceBalance 控制（center=人声/中、side=伴奏/侧）；presenceMatrix 由 vocal/accompanimentBoost 控制。
- **EQ 与频响补偿** 二选一插入 presenceMatrix.output 与 bassFilter 之间（rebuildEq 断开重连）；EQ 用 peaking 级联（simple Q=1.0 / pro Q=1.1），
  补偿用设计段（lowshelf/peaking/highshelf 任意组合）或内置 2 段近似。
- **IR 指纹缓存**：`type|preDelay|decay` 未变则复用卷积 buffer，避免拖动滑杆重分配数 MB 脉冲缓冲与可闻咔哒声。
- 变调/变速 SoundTouch 节点默认直通（pitchSemitones=0、playbackRate=1），不参与主链语义。

### 2.3 Web Audio 节点类型清单

| 节点类型 | 用途 |
|---|---|
| GainNode | input/output/normGain/nightGain/hallWetGain/pannerDryGain/pannerWetGain + M/S 矩阵内部 8 个 |
| ChannelSplitterNode / ChannelMergerNode | 3 个 M/S 矩阵（voice/presence/hall） |
| BiquadFilterNode | bassFilter(lowshelf)/bassPunch(peaking)/vocal(peaking)/accomp(peaking)/nightTreble(highshelf)/EQ 段(peaking)/补偿段(按设计) |
| DynamicsCompressorNode | compressor(knee 6)/nightCompressor(knee 12)/limiter(-6dB, knee 12, ratio 12) |
| WaveShaperNode | nightShaper（curve=null 直通占位） |
| ConvolverNode | hallConvolver（程序化立体声 IR，5 类型参数化） |
| PannerNode | 3D 环绕（HRTF panningModel、inverse distanceModel） |
| AudioWorkletNode | SoundTouch（变调/变速） |
| AnalyserNode | 链尾分析（播放器频谱） |

---

## 3. 参数模型

### 3.1 设置字段、默认值与取值范围

| 分组 | 字段 | 默认 | 取值范围/说明 |
|---|---|---|---|
| hall（全景声厅） | enabled / level / reverb / type / preDelay / decay | false / 5 / 5 / 'hall' / 18 / 2.2 | level 声场 1-10；reverb 混响量 0-10；preDelay ms（clamp 0-250ms）；decay s（clamp 0.4-6） |
| surround3d（3D 环绕） | enabled / distance / speed / angle / direction | false / 5 / 1 / 0 / 1 | distance 近远 1-10；speed 旋转速度；angle 0-360°；direction 1 或 -1 |
| bassBoost（低音） | enabled / depth / intensity | false / 100 / 6 | depth→lowshelf 起始频率；intensity 0-10 → 增益 ×1.3、punch ×0.55 |
| vocalBoost（人声） | enabled / intensity | false / 4 | intensity → 3kHz peaking ×0.7 + M/S 中置 ×0.08 |
| accompanimentBoost（伴奏） | enabled / intensity | false / 4 | intensity → 2.8kHz peaking ×(-0.7) + 侧声道 ×0.22、中置 ×(-0.1) |
| compressor（压缩） | enabled / threshold / ratio / attack / release / outputGain | false / -18 / 3 / 0.02 / 0.2 / 3 | 阈值 dB / 比率 / 起音 s / 释放 s / makeup dB |
| nightMode（夜间） | enabled / amount | false / 6 | amount 0-10：压缩 threshold -24-amount×0.8、ratio 2.5+amount×0.25、6.5kHz 高频 -(1.5+amount×0.45) dB、增益 1+amount×0.012 |
| loudnessCompensation（频响补偿） | enabled / mode / preset / bands | false / 'auto' / 'flat' / [] | mode auto/preset/custom；bands=[{frequency,gain}] custom 控制点（UI 固定 80/250/1000/4000/12000） |
| eq | enabled / mode / simpleBands / proBands | false / 'simple' / [0×5] / 10×{gain:0,q:1.1} | simple 5 段增益 dB；pro 10 段 EqBand |
| pitch | enabled / semitones / rate / voiceBalance | false / 0 / 1 / 0 | semitones -10~+10；rate 0.25~3.0；voiceBalance -1(仅伴奏)~+1(仅人声) |
| 顶层 | activeScene / customized / normalizationEnabled | null / false / false | 场景 id；是否脱离快照；响度归一化总开关 |

### 3.2 互斥规则（ADR-0002）

- **频响补偿 ⇄ EQ / 响度归一化 / 全部 7 个音效**：同开时补偿优先（else-if 结构，同一 patch 内补偿开启则关闭其他；EQ/归一化/任一音效新开则关补偿）。只动 `enabled` 标志，参数保留，随时可切回。
- 归一化按整曲对齐 -14 LUFS、补偿按系统音量改频响，目标冲突不可同开。

### 3.3 localStorage 键

| 键 | 归属 | 内容 |
|---|---|---|
| `waveforge:audio-effects-settings` | 引擎 | AudioEffectsSettings JSON（深合并加载，旧字段自动补默认） |
| `waveforge:my-scenes` | 引擎 | SceneSnapshot[]（上限 8） |
| `waveforge:audio-engine-version` | audioEngineVersion.ts | 'v1' 或 'v2'（默认 v1） |
| `waveforge:compensation-cache` | compensationService | 补偿设计缓存（上限 60，LRU） |
| `waveforge:lufs-cache` | loudnessNormalization | 按 trackKey 的 LUFS 缓存（上限 300，LRU） |
| `waveforge:eq-presets` | MixingStudioV2 | EQ 预设（上限 8） |
| `waveforge:loudness-comp-hinted` | App.tsx | 低音量提示一次性标记 |
| `waveforge:service-3004-toasted` / `waveforge:service-3003-toasted` | App.tsx | 服务健康 toast 一次性标记 |
---

## 4. 场景快照语义（SceneSnapshot）

### 4.1 快照模型（ADR-0001）

- `SceneSnapshot = { id, name, description?, builtin?, effects: CloudEffectsSettings, eq: EqSettings }` —— 不含 pitch（变调/变速不入场景）。
- **快照式**：应用场景 = 整组 `effects+eq` 深拷贝（JSON.parse(JSON.stringify)）写入 settings，并置 `activeScene=scene.id`、`customized=false`。
- **脱离快照**：任何手动 `updateSettings`（patch 不含 `activeScene` 字段）自动置 `customized=true`；UI 据此显示"自定义"并弹出场景覆盖确认。
- 场景 EQ 一律 `mode:'pro'`（10 段滑条），即使 enabled=false 也保证 UI 切到 EQ Tab 时是专业模式（用户要求）。

### 4.2 内置 7 场景

| id | 名称 | 效果要点 |
|---|---|---|
| scene-heavy-bass | 重低音 | bassBoost(90/9) + compressor(-16/3.5)，全景声厅显式关闭（重低音+全景声全开会把中高频砍没） |
| scene-pop | 流行 | hall(room, level4/reverb4/preDelay12/decay1.4) + vocalBoost(4) + EQ 微提升（+0.5~+1dB 各段） |
| scene-rock | 摇滚 | bassBoost(95/8) + compressor(-14/5)，EQ 低音 3/高音 3 |
| scene-classical | 古典 | hall(stage, 5/7/22/2.8)，EQ 平直 |
| scene-vocal | 人声突出 | vocalBoost(6) + hall(plate, 3/3/14/2.0) + EQ 中频 +3 |
| scene-night | 夜间 | nightMode(7) + bassBoost(90/3) + EQ 高频 -1.5~-2 |
| scene-flat | 原声监听 | 全部关闭，EQ 平直（恢复默认入口） |

### 4.3 我的场景

- 保存：`saveAsMyScene(name)`，id=`my-<时间戳>`，上限 **8**，空名/空白名拒绝；写入 localStorage `waveforge:my-scenes`。
- 删除：`deleteMyScene(id)` 过滤后回写。
- UI 流程：自定义状态下点击场景 → 弹确认（覆盖 / 保存并应用 / 取消）；"恢复默认"= 应用 scene-flat。

---

## 5. 服务契约：compensationService（3004）与 loudnessNormalization（3003）

### 5.1 频响补偿设计服务（3004 /compensation）

**请求**（POST JSON，15s 超时）：
```json
{ "mode": "auto", "volume": 60 }
{ "mode": "preset", "preset": "bass" }
{ "mode": "custom", "bands": [{ "frequency": 80, "gain": 3 }, ...] }
```

**响应**：
```json
{ "segments": [{"type":"lowshelf|peaking|highshelf","frequency":120,"q":0.707,"gain":5.25}],
  "label": "等响度补偿（音量 60%）", "mode": "auto", "volume": 60, "estimatedSpl": 68.0 }
```
（preset/custom 响应含 `preset` / 无 `volume`；错误返回 `{error}` + 4xx/5xx。）

**服务端算法**（compensation_server.py，与前端测试复刻公式逐值比对一致）：
- auto：`spl = 50 + 30×(vol/100)`（100%→80dB）；`deficit = 80 - spl`；低增益 = clamp(deficit×0.35, 0, 12)、高增益 = clamp(deficit×0.15, 0, 6)，round 2 位；≥0.5dB 才生成段；段结构 = LowShelf(120Hz,Q0.707) + HighShelf(12000Hz,Q0.707)，只提升不衰减、中频 0dB（实测 1kHz 残留 <0.1dB、8kHz <1dB）。
- preset：6 预设（flat 监听平直 / bass 低频补偿 / vocal 人声突出 / warm 温暖 / bright 通透 / night 夜间温和）= 低 shelf + 0-2 个中频 peaking（≤±3dB）+ 高 shelf（Q0.6）。
- custom：5 独立 peaking（Q1.2），增益 ±8dB，频率校验 30-16000Hz。

**前端缓存与降级**（compensationService.ts）：
- 缓存 key：preset→`preset:{preset}`；custom→`custom:manual`（固定）；auto→`auto:{round(vol/5)×5}`（±5% 档位共享）。
- 双层缓存：内存 Map + localStorage `waveforge:compensation-cache`（上限 60，按时间 LRU 淘汰）。
- 健康状态机：`pythonHealthyAt`（成功 +30s 不再请求）、`pythonUnavailableUntil`（失败 +5s 退避）；`inflight` Map 并发去重；`requestSeq` 使 in-flight 结果失效（invalidate）。
- **引擎侧再包一层**（AudioEffectsEngine）：设计 key 用 ±10% 档位（custom 用 bands JSON 指纹）；30s 失败窗口；请求序号防竞态。
- **降级链**：服务不可用/空设计 → `compDesign=null` → 引擎内置近似（恒 2 段 BUILTIN_COMP_SEGMENTS，增益由 `builtinCompensationGains` 按系统音量线性：`deficit=30-0.3×vol`，low=clamp(deficit×0.35,0,12)、high=clamp(deficit×0.15,0,6)；volume=-1 视为满音量不补偿）；补偿段增益平滑 tau=200ms（setTargetAtTime）。

### 5.2 响度测量服务（3003 /lufs）

**请求**（POST JSON，60s 超时）：`{ "trackKey": string, "audioPath": string }`
- audioPath 解析：http(s) URL 经 `window.electron.audioDownload.prepare(url, trackKey)` 落地为本地文件（Electron 能力），本地路径直通；失败返回 null。
- 服务端校验：扩展名白名单 `.mp3/.flac/.wav/.ogg`（libsndfile 不支持 m4a/aac/opus/webm）、文件 ≤300MB。

**响应**：`{ "trackKey": string, "integratedLufs": number }`（-70~0，round 2；空/全静音返回 0.0，其余异常 500——不能把真实错误当静音，否则前端会误判为极低响度大幅衰减）。

**服务端算法**（loudness_server.py）：librosa 载入 22050Hz 单声道 → BS.1770-4 K 加权（38.135Hz 二阶 HP + 1681.45Hz +4dB shelf，RBJ 系数按采样率自适应）→ 400ms 块响度（含 -0.691 校准）→ 相对门限（峰值 -10LU）→ 积分 LUFS。

**前端换算与降级**（loudnessNormalization.ts）：
- `gainDbForLufs`：`gain = -14 - lufs`，clamp ±9dB；非有限数返回 0。
- 缓存：内存 + localStorage `waveforge:lufs-cache`（上限 300，LRU），按 trackKey。
- 应用：`apply(engine, trackKey, url)` —— 引擎关闭归一化直接 0dB；measure 失败 → 0dB 原声（不影响播放）；序号（applySeq）防护迟到的测量结果覆盖新歌增益。
- 健康状态机与补偿服务同构（healthy +30s / unavailable +5s / inflight 去重 / 60s 超时）。
---

## 6. 集成点

### 6.1 文件与职责

| 文件 | 集成方式 |
|---|---|
| `src/hooks/useAudioPlayer.ts` | 音频图就绪时回调 `onAudioGraphReady(handle: AudioGraphHandle)`（`{audioContext, masterGain, analyser}`）；对外暴露 `AudioGraphHandle` 类型 |
| `src/App.tsx` | 双实例 `v1EngineRef`/`v2EngineRef`（模块内 new，按版本激活）；`handleAudioGraphReady` 按版本 attach；`switchAudioEngine` 热/冷切换；系统音量轮询（每 10 分钟 IPC `window.electron.audio.getSystemVolume` → `setSystemVolume`，低音量一次性 toast）；服务健康检测（3003/3004 启动 3s 后 toast）；`normalizationEnabledChanged` 事件监听 → `loudnessNormalizationService.apply/reset`；切歌路径也调 apply；渲染 MixingStudio/MixingStudioV2 时传入 `engine={v2EngineRef.current!}` |
| `src/services/audioEngineVersion.ts` | `getAudioEngineVersion()`/`setAudioEngineVersion()`，localStorage `waveforge:audio-engine-version`，默认 v1 |
| `src/components/MixingStudioV2.tsx` | 唯一 UI 使用方：`update` 包装 `engine.updateSettings(patch)` + `setSettings(engine.getSettings())`；场景/EQ 预设/导入导出/导出 WAV（`engine.exportToWav(sourceUrl, sourceDuration||0)`） |
| `src/components/MixingStudio.tsx`（v1） | 同样 `engine.exportToWav`，v1 引擎同款导出路径 |

### 6.2 attach / detach / 热切换 / dispose 语义

- **attach**（幂等，重复调用直接 return）：`masterGain.disconnect()` 全断 → `masterGain.connect(normGain)` → `normGain.connect(chain.input)`；链尾 `chain.output → limiter → analyser`；异步注册 SoundTouch（await 期间若 `this.context !== context` 则放弃接线，防竞态）；最后 `rebuildFromSettings()` + 异步 `applyCompensationDesign()`。
- **热切换**（switchAudioEngine）：读 `audioGraphHandleRef`；用 `getAudioElement()`（读 activePrimaryRef，非 state 的 audioElement——双 deck 静默转正路径下 state 是陈旧引用）判断是否在播 → 暂停 → `dispose()` 旧引擎 → 换版本 → `attach(handle)` 新引擎 → 80ms 后恢复播放（同一 deck）；切到 v2 时补挂响度归一化；右上角 2s 弹窗；关闭调音室。版本读写走 ref 防同帧连点竞态。
- **冷切换**：音频图未就绪（handle=null）时仅保存版本配置，下次启动生效，提示"下次启动生效"。
- **dispose**：`stopSurroundRotation` → 全断 `masterGain.disconnect()`，摘除 `soundtouchNode`/`limiter`（try/catch 包裹），恢复 `masterGain.connect(analyser)` 直连；清空全部引用；`compDesignSeq++` 作废在途设计请求。**关键约束**：两引擎 dispose 都会"全断 masterGain 再恢复直连"，避免新旧两套链并联打架。

### 6.3 离线导出路径

`exportToWav`：`fetch(sourceUrl)` → `decodeAudioData` → 长度 = clamp(durationSeconds, [min(1s, 源长), 源长]) → 新建 `OfflineAudioContext(2, length, sampleRate)` → `buildEffectChain(offline, settings)`（**与实时链同一实现，ADR-0003，不漂移**）→ 手工应用与 `rebuildFromSettings` 一致的动态参数（bass/vocal/accomp 增益、voiceMatrix/presenceMatrix 增益、compressor、夜间、hall 干湿、3D 干湿与初始位置、EQ/补偿段二选一；补偿段用引擎内已缓存设计，无则内置近似按 `systemVolume` 估算）→ `startRendering()` → `encodeWav`（16-bit PCM，44 字节头 + 逐样本 clamp ±1 后 ×0x8000/0x7fff）→ Blob 下载 `waveforge-mix-<时间戳>.wav`，10s 后 revokeObjectURL。

---

## 7. SoundTouch 使用方式（LGPL 风险点）

### 7.1 使用方式

- 依赖：`@soundtouchjs/audio-worklet@^2.1.1`（npm，封装 SoundTouch 核心为 AudioWorklet 处理器）。
- 流程：`await SoundTouchNode.register(context, processorUrl)`（异步注册 worklet，`processor?url` Vite 资源）→ `new SoundTouchNode({ context, outputChannelCount: 2 })` → 插入 `normGain` 与 `chain.input` 之间；参数经 AudioParam：`pitchSemitones`（-10~+10）、`playbackRate`（0.25~3.0），`setTargetAtTime(..., 0.02)` 平滑。
- 竞态防护：注册 await 期间引擎可能被 dispose/重 attach（热切换），完成时校验 `this.context !== context` 则放弃接线，防止旧节点插进废弃图、旧注册覆盖新注册。
- 失败降级：注册/实例化失败 → `soundtouchNode=null`，变调/变速不可用（console.warn），其余功能不受影响。

### 7.2 LGPL 风险点（对应 research 设计文档 §8 的明确提示）

1. **SoundTouch 本体是 LGPL-2.1**：`@soundtouchjs/*` 是围绕它的 TS 封装；Electron 渲染进程内以 worklet 处理器形式分发，商业闭源分发需评估 LGPL 合规（提供可重新链接的对象文件/动态链接，或放弃）。
2. research 设计已给出替代：`Stretch.ts`（API_SPEC 模块 14）用 **signalsmith-stretch（MIT，WASM）** 作首选实现，自研相位声码器回退，彻底规避 LGPL 连带。
3. v3 集成建议：变调/变速不应内联进主链（API_SPEC EngineV3.getStretch() 供 gapless/过渡场景调用），与 v2 的"插在链首"定位不同——这是语义层面的迁移差异。
4. 移植建议：保留 `semitones`/`rate` 参数名与范围（-10~+10 / 0.25~3.0），pitchScale=2^(semitones/12) 与 rate 独立（API_SPEC §9 语义）。
---

## 8. v2→v3 移植建议

### 8.1 应保留兼容的 API / 参数命名（UI 数据迁移成本最低）

1. **顶层设置结构**：`effects / eq / pitch / activeScene / customized / normalizationEnabled` 六字段组织方式值得沿用（V3EngineParams 可扩展现有字段而非推倒）。
2. **参数命名与范围**：`pitch.semitones(-10~+10)`、`pitch.rate(0.25~3.0)`、`pitch.voiceBalance(-1~+1)`（M/S 语义：-1 仅伴奏 / +1 仅人声）、`bassBoost.depth/intensity`、`vocalBoost.intensity`、`compressor.threshold/ratio/attack/release/outputGain`、`nightMode.amount(0-10)`、`hall.type/preDelay/decay`（5 种 ReverbType 名称 hall/room/plate/spring/stage 直接复用）。
3. **响度归一化语义**：目标 -14 LUFS、增益 clamp ±9dB、失败回退 0dB 原声——v3 的 LufsMeter 与归一化逻辑应保持同一目标值与回退语义。
4. **频响补偿参数**：auto 模式公式（低频系数 0.35 / 高频 0.15、上限 12/6dB、120Hz+12kHz Q0.707 shelf 结构）已被 v3 LoudnessComp 采用（API_SPEC 模块 12 明确"v2 兼容"）；`mode/preset/bands` 三段式与 6 预设 id（flat/bass/vocal/warm/bright/night）可直接映射。
5. **互斥语义（ADR-0002）**：频响补偿与 EQ 二选一、与响度归一化互斥——设计文档 §4.7 仍要求"设备档案与手动 EQ 互斥+锁定"，说明互斥思想在 v3 延续（只是对象换为设备档案）。

### 8.2 应由 research 设计替换的部分

| v2 实现 | v3 替换（API_SPEC / 设计文档） | 理由 |
|---|---|---|
| EQ 5/10 段 peaking 级联（无补偿） | EqChain 20 段 + Q 补偿迭代（模块 3） | 级联响应误差 ≤0.05-0.1dB，v2 相邻段叠增益会偏离目标 |
| 程序化生成 IR（早期反射+去相关噪声） | Convolver 分区 FFT 卷积 + IR 去周期化（模块 9） | 确定性、可载入真实 IR、循环无周期伪影；v2 的随机数生成 IR 不可复现 |
| DynamicsCompressorNode 作输出限幅（threshold -6/ratio 12） | Limiter 前瞻 + 真峰值（模块 7） | 保护能力更强、可测延迟、无 pumping |
| 夜间 = 压缩 + 高频衰减（无谐波） | NightMode = 压缩增强 + 6kHz shelf（EngineV3 链） | 语义一致，参数更明确（amount×1.5dB） |
| 低音 = lowshelf + 55Hz peaking | BassEnhancer 虚拟低频（LP + 非线性谐波 + HP 整形，模块 8） | 真正补足小音箱缺失的低频谐波，而非简单增益 |
| 外部 Python 服务测 LUFS（3003） | LufsMeter 内置（模块 11） | 离线/实时一致、无网络依赖、可测 |
| 外部 Python 服务设计补偿曲线（3004） | LoudnessComp 内置 1/3 倍频程 ISO 226 表（模块 12） | 同上；服务端 0.35/0.15 公式保留为 v2 兼容近似 |
| 响度归一化增益 = 播放器按曲目调用服务 | 引擎链内归一化增益 + LufsMeter 反馈 | 与实时链解耦、可 gapless 化 |
| SoundTouch（LGPL） | Stretch 相位声码器 / signalsmith-stretch(MIT)（模块 14） | 许可合规（见 §7） |
| Web Audio 节点图（Biquad/Dynamics/Convolver/Panner 组装） | 纯 TS DSP 类 + AudioWorklet 消息管道（设计文档 §2、§5） | 实时/离线双路径共用同一算法类、零分配、可单测 |
| 3D 环绕 HRTF Panner + requestAnimationFrame 旋转 | （v3 未列入核心链；如保留需自研双耳旋转或标注降级） | v2 依赖浏览器 PannerNode HRTF，v3 无 WebAudio 依赖原则下需另行设计 |

### 8.3 v2 缺失而 research 要求的新功能清单（v2 完全没有的）

1. **20 段 EQ + Q 补偿**（Pre-EQ 与 Post-IEQ 两段）。
2. **Deesser 动态齿音抑制**（模块 5，侧链带通 + dB 域阈值压缩）。
3. **真峰值前瞻限幅器**（模块 7，4× 过采样 true-peak 检测）。
4. **虚拟低频 BassEnhancer**（模块 8，谐波生成，非简单 shelf）。
5. **设备频响档案 DeviceProfile**（44 台机型 + AutoEq 拟合，模块 G）。
6. **听力分析 HearingTest**（模块 F，125Hz-8kHz 二分测听 → 个人听力曲线）。
7. **分享串 ShareCodec**（模块 C，版本 + 白名单 + FNV-1a 校验 + base64url）。
8. **11 组合场景 ScenePresets**（模块 B，v2 仅 7 内置；含 jazz/dance/livehouse/studio/warm/dts/vocal-stage/night-bass 等）。
9. **声源分离 SeparationQueue**（模块 H，spleeter/demucs ONNX 适配 + 任务队列）。
10. **音高检测 YIN**（模块 15，实时）+ CREPE-ONNX 离线。
11. **多相重采样 Resampler**（模块 13，speexdsp 思路）。
12. **引擎内 IEQ 智能均衡**（设计文档 §4.6，长时频谱 → 目标曲线差 → EQ 拟合，3s 平滑）。
13. **频谱特征分析 SpectrumAnalyzer**（模块 E，质心/滚降/平坦度/峰值等 meyda 式）。
14. **gapless 变速接入**：EngineV3.getStretch() 供过渡场景（v2 的 SoundTouch 只服务调音室 UI）。
15. **确定性 IR / 无随机**：v2 混响 IR 用随机数生成（每次 attach 不同），v3 要求同输入同输出。
---

## 9. 测试模式总结（断言风格）

参考 `WaveForge/test/audioEffects.test.ts`（131 行）与 `test/compensation.test.ts`（469 行）：

1. **框架与夹具**：vitest `describe/it`；`beforeEach` 清 `localStorage`（test/setup.ts 注入 stub）；`vi.stubGlobal('window', {setTimeout, clearTimeout})` 补 window 定时器（node 环境）；`afterEach` 恢复 `vi.useRealTimers()`/`vi.unstubAllGlobals()`。
2. **纯逻辑精确断言**：服务端公式在 JS 复刻（常量与 Python 端逐值对齐：REF_SPL_DB=80、MIN_SPL_DB=50、0.35/0.15、12/6、120/12000Hz、Q0.707），用 `expect(...).toBe(5.25)` 这类精确值（已与服务端实跑比对）；clamp/边界（-10/150 音量、NaN/Infinity 输入）逐一断言。
3. **物理意义断言**：`toBeCloseTo` + 注释说明物理意义（如 50% 音量 → 低频 +5.25dB ≈ 5.2）；"中频零污染"用 RBJ biquad 系数解析求幅频响应（magnitudeAt 思路），级联 dB 相加验证 1kHz ≈ 0dB（±1）、8kHz ≤ 1dB。
4. **状态机断言**：缓存命中/不命中（fetch 调用次数 `toHaveBeenCalledTimes`）、退避窗口（fake timers `advanceTimersByTime(5000)` 后恢复请求）、并发去重（共享同一 Promise 只发一次）、in-flight 失效（延迟 resolve + invalidate → null）。
5. **设置迁移断言**：写入"旧版本"localStorage JSON（缺新字段）→ new 引擎 → 断言新字段补默认、旧字段保留——v3 的 settings 加载器应同样做深合并迁移测试。
6. **请求体断言**：`JSON.parse(fetchMock.mock.calls[i][1].body)` toMatchObject 精确校验 mode/volume/preset/bands 字段与 URL。
7. **互斥/快照语义断言**：applyScene 写入参数 + 清 customized；updateSettings 置 customized；补偿开→EQ 关（双向）；归一化与补偿互斥；多效果可叠加。
8. **关键启示**（供 v3 测试采用）：算法正确性用"复刻公式 + 精确断言"，而非模糊容差；频响用解析 biquad 计算而非整链 FFT（可单模块验证）；降级行为（服务不可用）必须有独立用例；迁移（旧数据）必须有独立用例。

