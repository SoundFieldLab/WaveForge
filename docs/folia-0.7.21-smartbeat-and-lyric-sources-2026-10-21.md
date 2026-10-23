# Folia 0.7.21 对标研究（第三辑）：智能动感模式 + 歌词源差异结论

> 2026-10-21。基于本机安装的 folia 0.7.21（`D:\folia\resources/app.asar`）全量解包，
> 对比 WaveForge vendor 的 folia 0.5.27-a16525c 基线。前两辑见
> `folia-login-diagnostics-and-spotify-research-2026-10-20.md`。

---

## 一、歌词样式对比结论：样式集合一致，实现在小步更新

**样式名单完全一致**（14 种：classic/cadenza/partita/fume/claddagh/cappella/tilt/monet/
diorama/pendolo/sonnet/tempera/lumiere/still），0.5.27 → 0.7.21 没有新增样式。

跨版本更新的内容（按 0.7.x changelog 逐版核对）：

| 版本 | 歌词相关更新 | 对 WaveForge 的价值 |
|---|---|---|
| 0.7.15 | 本地歌词解析强化（KRC 解密、GBK 编码识别、双语 LRC 错轴检测） | 中（我们有本地歌词路径时值得抄） |
| 0.7.16 | **AMLL 歌词迁移到官方 API**、手动匹配直搜 AMLL | 低（我们已有 amlldb.bikonoo.com 独立源） |
| 0.7.18 | 部分歌词视觉器降低资源占用；本地歌切换更顺滑 | 中 |
| 0.7.19 | 艺人/专辑页 Tempera 风格海报；**Tempera 类逐字样式的中日文分词更自然**；播放失败给真实原因 | 中高 |
| **0.7.21** | **智能动感模式（Smart Beat）**：商籁/镜台（Diorama）/时计（Pendolo）节拍驱动动效；桌面接入 Spotify/YTM；统一登录窗口；探索页 | **本次移植目标** |

## 二、智能动感模式（Smart Beat）实现细节（从 0.7.21 反编译还原）

### 是什么

changelog 原文：「商籁每拍推近镜头、小节第一拍裂光，镜台的粒子随拍泛起涟漪、正在唱的
字跟着跳，时计的表盘跟着分离出的底鼓、军鼓和镲片起伏。每个效果可以单独开关、调强度，
命令面板里也能一键开关。需要支持 WebGPU 的显卡；歌曲第一次播放时会短暂分析并记住。」

### 实现结构（0.7.21 反编译已还原）

1. **前置依赖：节拍/鼓点分离数据**。0.7.21 把分析模型随安装器分发（"The models now ship
   with the installer, so automix no longer needs a separate model download either"）——
   即 folia 的 automix 分离模型（htdemucs 系，MNN 推理，`electron/analysis/`）同时产出
   **鼓点时间轴**（kick/snare/hihat 逐击时间点），smartBeat 从中取拍。
2. **设置存储**（`useVisualizerSettingsStore`，localStorage 键 `visualizer_smart_beat`）：
   ```json
   {
     "enabled": false,
     "effects": {
       "<effectId>": { "on": true, "strength": 1.0 }   // effectId 形如 "xxx.yyy"，≤32 个
     }
   }
   ```
   旧格式迁移：顶层 `beatIntensity`/`downbeatIntensity` 均值会展开到每个 effect 的 strength。
   strength 范围钳 0..2（默认 1）。写入走 `handleSetSmartBeat`。
3. **效果参数（sonnet 硬编码默认，`X` 常量表）**：
   `zoomPercent: 6`（每拍镜头推近 6%）、`rotationDeg: 0.6`、`downbeatZoomPercent: 5`
   （小节第一拍额外 5%）、`tear: 0.6`（裂光强度）、`tearRate: 24`、`flare: 0.7`、
   `iconPop: 0.4`、`iconDecayMs: 300`、`lineBaseAlpha: 0.78`。
   `beatFx` 管线把每拍的 beat/downbeat 归一化值乘用户 strength 叠加进相机变换与撕裂滤镜。
4. **运行时开关**：`setSmartBeatEnabled(bool)` → `rebuildScenes()`（场景缓存按开关重建，
   关闭时完全回到常规动画）；命令面板一键切换；三个样式（sonnet/diorama/pendolo）各自
   实现了自己的 beatFx 消费（diorama=粒子涟漪+歌词跳、pendolo=表盘随底鼓/军鼓/镲起伏）。

### WaveForge 移植方案

**有利条件**：我们已经有完整的节拍数据管线——`python-beat-service`（3002，beat_analyzer.py
产出节拍/重拍时间轴）+ `AudioAnalyzerStore`（实时频谱）。WaveForge vendor 的
sonnet/diorama/pendolo 三个 runtime 与 0.7.21 同源，`X` 常量表与 `beatFx` 管线可以直接
按上表复刻。

移植步骤（预计）：
1. vendor 补丁：`createSonnetPixiRuntime` / diorama / pendolo 三个 runtime 加
   `smartBeatEnabled` + `beatFx`（拍时间轴注入 + `X` 常量表效果）；
2. 设置存储：`visualizer_smart_beat` localStorage 键 + effects 白名单（对齐 folia 形状，
   迁移逻辑照抄）；
3. 节拍数据桥：播放时经 `beat_analyzer` 的节拍轴 → `PlaybackTimeStore` 的当前时刻
   二分查找最近拍/重拍 → 归一化 beat/downbeat 脉冲注入 runtime；
4. UI：歌词样式设置面板加「智能动感模式」开关 + 逐效果强度滑条 + 命令面板切换；
5. 依赖要求：三个样式均为 Pixi WebGL（我们的 unsafe-eval polyfill 修复后已可用），
   不强制 WebGPU（folia 标注 WebGPU 是它 0.7.21 的渲染器选择，我们 vendor 是 WebGL
   版本，效果相同）；首次播放做节拍分析（3002 服务已有，无需新模型）。

### 「降低动态效果」（0.7.8 Per-Surface Motion Controls）——另一个相关功能

用户口中的"智能动感"可能混指两个功能。另一个是 0.7.8 的**逐表面降动效**：
「实验室设置新增『降低动态效果』，可以分别调低队列拼贴、混音过渡、歌单展开转场、
Monet 背景漂移、界面微动效和设置页平滑滚动；需要时也可以开启『跟随系统设置』」。
实现：`:root[data-reduce-motion~=uiMicroMotion]` CSS 属性选择器 + 分项开关。
若需要这一并移植（成本远低于 smartBeat：纯 CSS + 6 个开关）。

## 三、网易云云盘歌词（/cloud/lyric/get）评估：**不值得作为主路径引入**

完整实测链（TIME CYCLE 为例）：

| 源 | 结果 |
|---|---|
| QQ 官方 GetPlayLyricInfo（folia 同款参数，songID 431423659/431423653 两版本都测） | 解密后 = 「此歌曲为没有填词的纯音乐」（QQ 官方判定纯音乐） |
| 网易云官方曲库（3 个版本 id，/api/song/lyric） | 只有 43 字符的作曲署名行（metadata only，我们已有识别规则会拒） |
| 网易云云盘 `/cloud/lyric/get` | 接口存在（`@neteasecloudmusicapienhanced` 已内置 cloud_lyric_get.js），但**前提是用户自己往云盘传过这首歌并挂了歌词**——新歌/小众歌（TIME CYCLE 这类 phonk）绝大多数用户云盘里没有 |
| LRCLIB | 标题+艺人精确搜索 0 结果；仅标题搜索命中 20 条但全是**别的艺人**的同名歌（"The Water Cycle" 等），借来的词是错的 |
| AMLL TTML DB | 404 |

**结论**：
- 云盘歌词链路对「云盘有这首歌的用户」是好东西，但作为通用兜底命中率极低
  （要求用户自己上传过 + 挂过词），且需要 uid+sid 两步查询。**不建议作为主路径引入**；
- folia 在 TIME CYCLE 上显示的英文歌词，**不是来自任何公开源**——QQ/网易/LRCLIB/AMLL
  全部实测为空。唯一成立的解释：**用户 folia 里播的是本地文件**（内嵌歌词或 folia 的
  手动匹配记录），或网易云云盘恰好有该用户自己传的版本。folia 的 provider 机制允许
  同一首"歌"在多个 provider 间切换（本地文件也是 provider），它的歌词匹配窗口
  （Match Online / Manual Online Match）会把选中结果持久化到本地库——这是它"有词"
  的真正机制：**用户手动匹配 + 本地持久化**，不是某个我们缺的线上源；
- 可借鉴的**低成本**部分：我们已有 `fetchCrossPlatformLyricFill`（QQ/网易互备）+
  LRCLIB + AMLL 源。真正缺的是 folia 那套「**手动匹配窗口 + 匹配结果持久化**」：
  对取词失败的歌，给用户一个搜索面板（跨源搜词，试听对齐，选中后按
  `平台:歌曲id` 存进 IndexedDB，30 天/永久有效），下次播放直接用。这个功能
  对纯音乐误判、小众歌、翻译缺失都是终极兜底，成本可控（复用现有搜索 UI +歌词缓存层）。

## 四、行动清单（按优先级）

1. **Smart Beat 移植**（用户点名）：按上文方案，先 sonnet（用户主用），再 diorama/pendolo；
2. **手动歌词匹配 + 持久化**（TIME CYCLE 类问题的真正解）：跨源搜索面板 + IndexedDB 持久化；
3. 0.7.19 的中日文分词改进与 0.7.18 的资源优化：在 vendor 同步时一并带入（低优先）；
4. 「降低动态效果」分项开关：纯 CSS 层面，若用户要一并做（低优先）。
