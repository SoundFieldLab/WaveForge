# WaveForge「现代」歌词模式 × LyricsBlossom(Apple Music) 对比分析

> 日期：2026-08-16
> 目的：把 WaveForge「现代」模式做成与 LyricsBlossom（Apple Music 1:1 还原）一致的逐字歌词动画
> 依据：WaveForge `src/components/LyricsDisplay.tsx`、`src/desktop-lyrics/DesktopLyricsApp.tsx`、`src/utils/lyricWordTiming.ts`；LyricsBlossom 二进制逆向（RTTI + 反汇编 + 字符串证据）

---

## 一、两边的实现方式对比（架构层）

| 维度 | WaveForge「现代」 | LyricsBlossom（Apple Music 还原） |
|---|---|---|
| 渲染技术 | React DOM + CSS + framer-motion | 原生 C++ + Skia GPU（Vulkan）直接绘制 |
| 逐字高亮实现 | 每个词/字 = 一个 `<span>`，双层绘制：底层未激活色 + 绝对定位填充层（`width%` 裁剪 + CSS `mask-image` 渐变羽化） | Skia：`TextRenderer::getGlyphRects()` 取字形矩形 → 已唱部分用高亮色重绘/分段绘制 |
| 时间驱动 | `playbackTimeStore` + `SmoothPlaybackTime`（rAF 平滑）；桌面歌词 30fps 定时器 + 线性插值 | 帧同步 + SMTC 进度 + WASAPI 音频捕获校准 |
| 词级时间来源 | QQ YRC / 网易云逐词数据 → `lyricWordTiming.ts` 归一化（绝对/相对时间、顺序修复、空格恢复）→ 词内字符均分时长 | TTML（Apple Music `/syllable-lyrics`）**逐音节**时间轴，词由音节组成 |
| 当前行呈现 | 播放页：**单行大歌词**（`displayMode="single"`，居中，字号 `lyricSize*1.3~1.65`）+ 现代频谱可视化；桌面：单行/双行 + 超长行横向 marquee | **多行列表**：当前行居中放大（`setupLyricsExpandingHook` 展开动画），上下行缩小、变暗、模糊，滚动按需裁剪只画可视行 |
| 律动背景 | `ModernAudioVisualizer` 频谱条 + `backgroundEffect`（封面模糊 scale 1.15 / blur / transparent） | 封面模糊层 + **SkSL RuntimeEffect 球体光晕**（uniform `uInvRadius/invRange/uHoldRatio/startY`），跟随节拍律动 + 液态玻璃 shader |

**关键差异（实现方式）**：WaveForge 是"每个词一个 DOM 节点 + CSS mask 填充"；LyricsBlossom 是"字形级 Skia 绘制"。视觉上 WaveForge 完全可行，但有两处结构性不同会影响"像不像 Apple Music"：① 单行 vs 多行列表；② 频谱 vs 律动光晕背景。

---

## 二、逐字歌词动画逐点对比（视觉层）

WaveForge「现代」= 播放页 `displayMode="single"` + 逐字效果（默认 `clear`，桌面/设置可选 `soft`）；逐字实现集中在 `LyricsDisplay.tsx` 的 `renderLyricLine`（L1059-1356）与 `DesktopLyricsApp.tsx` 的 `LyricText`。

| # | 动画点 | WaveForge 现状 | Apple Music / LyricsBlossom 行为 | 差异程度 |
|---|---|---|---|---|
| 1 | 词填充推进 | 词内 `fillWidth` 按词时间线性推进；**soft 模式 `fillExtension=42%`**：高亮延伸到下一个词 42% 处 + mask 羽化 | 词内独立渐变填充，**不跨词延伸**（词与词之间干净分隔） | ⚠️ 明显：soft 的 42% 延伸是"连续扫描"感，Apple Music 是"逐词点亮"感 |
| 2 | 词亮起曲线 | `activeProgress = sin(entry × (1-release) × π/2)`（仅用于辉光）；fill 为线性 | 词亮起平滑亮度过渡（先快后慢 ease-out） | 中：辉光有曲线但主填充是线性 |
| 3 | 已唱词状态 | `fullyFilled → activeLyricColor`（保持高亮直到行结束） | 已唱词保持高亮直到行结束 | ✅ 一致 |
| 4 | 当前词辉光 | soft：`activeTextShadow`（0 0 14px 白 25% + 阴影）+ sustainGlow | 词有轻微辉光，亮度峰值在词中段 | 中：可调参数 |
| 5 | 词上浮 | soft：`softLift = -0.075em`（easeOutCubic 520ms） | Apple Music 词亮起有极轻微上浮/放大 | ✅ 接近 |
| 6 | 当前行放大 | 单行模式无行对比；滚动模式 `scale 1.006`（几乎不可见）+ 字号 100% vs 63% | 当前行明显放大（展开动画），上下行缩小+模糊+变暗 | ⚠️ 结构性差异（单行 vs 多行） |
| 7 | 行切换动画 | soft-focus：旧行 `blur(24px) brightness(0.78) scale1.05 y-8` 退出，新行 `blur(28px) brightness(0.72) scale0.9` 进入，0.72s | 行间平滑过渡，新行从下浮入放大 | 中：方向一致，参数需微调 |
| 8 | 行常驻呼吸 | soft-focus ambient：`y ±3px / scale 1.014 / brightness 1.1`，4.8s 循环 | Apple Music 无此呼吸（静止感更强） | ⚠️ 多余：Apple Music 歌词不动 |
| 9 | 时间偏移 | `lyricOffset` 全局秒级偏移 | `±50ms` 步长精确补偿 + 播放/暂停重同步 | 低：WaveForge 步长更粗（秒级） |
| 10 | 无逐词数据回退 | `buildProgressiveLyricGlyphs`：行时长按字符数均分（渐进式） | `no_syllable` 回退整行高亮 | 低 |
| 11 | 语言处理 | 中文逐字、英文**按字母拆分逐字**、日文假名注音（`<ruby>`） | 逐音节（TTML），词级 | 中：英文按字母拆比 Apple Music 更细 |

**逐字"手感"核心差异**：Apple Music 是**词级"点亮"**（每个词在自己的时间窗口内从暗到亮），词间有节奏停顿感；WaveForge soft 的 `fillExtension=42%` 制造了"高亮拖着尾巴跑"的连续感——这是最可能让用户觉得"不像 Apple Music"的点。clear 模式反而更接近（词内精确填充），但没有羽化渐变、没有词亮起的柔和过渡。

---

## 三、结论：要做到"一模一样"需要动的点

按影响排序：

1. **逐字填充方式**：soft 的 fillExtension 由 42 → 0（或提供配置），保留词内 mask 羽化但**限制在词边界内**；词亮起曲线改成 ease-out；词与词之间干净分隔。
2. **当前行呈现**：决策点——保留单行大歌词（只调动画），还是改成"多行列表、当前行放大"（更接近 LyricsBlossom 播放页）。
3. **去掉/减弱常驻呼吸**：Apple Music 歌词静止，只有行切换和逐字动。
4. **行切换动画参数**：soft-focus 的 blur/scale/y 微调。
5. **律动背景**：是否把 ModernAudioVisualizer 频谱换成"封面模糊 + 节拍光晕"（Apple Music 风格），或保留频谱作为可选。
6. **时间偏移精度**：lyricOffset 从秒级改 ms 级（对齐 LyricsBlossom 的 ±50ms）。

---

## 四、实施计划（最终版 · 已确认决策）

> 已确认：① 现代模式改为**多行列表 + 当前行放大**；② 新增独立「Apple」逐字模式（不动 soft/clear）；③ 做**封面模糊 + 节拍光晕**背景，与频谱并存；④ 播放页 + 桌面歌词一起改。

### Phase 0 — 观测基线
- `npm run dev:electron` 录「现代」模式当前动画，与 Apple Music / LyricsBlossom 逐帧对比，量化参数（当前行放大倍率、行切换时长、词点亮时长）。

### Phase 1 — 多行列表 + 当前行放大（LyricsDisplay.tsx 滚动模式）
- 现代模式歌词显示由 `displayMode="single"` 改为滚动列表（多行、当前行居中）。
- 当前行"展开"动画（对应 LyricsBlossom `setupLyricsExpandingHook`）：行切换时旧行平滑缩小变暗、新行放大变亮，过渡 ~0.4-0.6s ease。
- 视觉参数对齐 Apple Music：当前行 700 粗体 / 白；上下相邻行 ~70% 字号、变暗；再远行继续缩小 + 轻微模糊；顶部 spacer 46% 保持居中（已有）。
- 行上下渐隐 mask（已有）保留。

### Phase 2 — 新增「Apple」逐字模式（wordByWordEffectMode = 'apple'）
- 新增 `getWordEffectConfig('apple')`，与 soft/clear 并列，设置里可选。
- 关键参数：`fillExtension: 0`（词间干净分隔，去掉 42% 跨词延伸）、词内渐变填充 + 轻羽化（收进词内）、词亮起 ease-out 曲线、已唱词稳定高亮、当前词轻微辉光 + 极轻上浮（~0.04em）。
- 无逐词数据时整行高亮（对应 LyricsBlossom `no_syllable`）。
- 桌面歌词 `DesktopLyricsApp.tsx` 的 `SOFT_FILL_EXTENSION` 同步支持 apple 参数。

### Phase 3 — 封面模糊 + 节拍光晕背景（与频谱并存）
- 复用 `AudioPulseStore`（beat/accent/bass 包络，已在 `useAudioPulse.ts` 提供）驱动背景光晕：封面模糊层上叠加径向渐变光晕（blur + 透明度/半径随节拍脉动，类似 LyricsBlossom 的 `uInvRadius/uHoldRatio` 球体光晕）。
- 现代音频频谱（ModernAudioVisualizer）保留，两者由设置开关控制。

### Phase 4 — 桌面歌词同步
- `DesktopView.tsx` 现代样式：逐字效果切到 apple 模式；桌面歌词窗可选节拍光晕背景。

### Phase 5 — 设置项
- 新增设置：逐字模式选项目前只有 soft/clear → 加 `apple`；「现代」行呈现（单行/多行，默认多行）；律动光晕开关。涉及 `SettingsPanel.tsx` / `QuickSettings.tsx` / `DesktopCustomizationEditor.tsx`。
- `lyricOffset` 支持 ms 级步长（对齐 LyricsBlossom ±50ms）。

### Phase 6 — 回归
- `npm run lint` + `npm run test`；播放页/桌面歌词/浅深色/长行 marquee/竖排/双行回归验证。

### 涉及文件
`src/components/LyricsDisplay.tsx`（核心）、`src/utils/lyricWordTiming.ts`、`src/desktop-lyrics/DesktopLyricsApp.tsx`、`src/components/DesktopView.tsx`、`src/components/ModernAudioVisualizer.tsx`、`src/hooks/useAudioPulse.ts`（如需暴露 beat/bass）、`src/App.tsx`、`src/components/SettingsPanel.tsx`、`src/components/QuickSettings.tsx`、`src/components/DesktopCustomizationEditor.tsx`

---

## 六、实施状态（2026-08-16 已完成）

| Phase | 内容 | 状态 |
|---|---|---|
| P1 | 行字号对齐 Apple Music：**所有行字号一致**（当前行靠颜色/高亮区分，不做字号放大）——修复"行切换时换行个数跳动"；移除 fontSize/fontWeight 动画 | ✅ `LyricsDisplay.tsx` |
| P2 | 新增 `apple` 逐字模式：**词/字整体渐亮**（未唱灰 → 正在唱 ease-out 渐亮 → 已唱纯白，颜色插值，无 mask 裁剪）——对齐 Apple Music 逐词点亮观感；中文逐字/英文整词；桌面歌词浮窗同步 | ✅ `LyricsDisplay.tsx` / `DesktopLyricsApp.tsx` / `DesktopView.tsx` |
| P2.1 | **修复"填充完毕黑闪"**：词唱完瞬间填充层（overlay）改为 140ms 淡出而非瞬间卸载，基础层 color/text-shadow/filter 加 140ms 过渡（soft/clear/apple 全部生效） | ✅ `LyricsDisplay.tsx` |
| P3 | 封面模糊 + 节拍光晕：现代模式播放时**强制激活 audioPulseStore**（不依赖"封面脉动"开关）；光晕层独立为 `BeatGlowOverlay`，置于渐变遮罩之上（不被压暗），随节拍脉动 | ✅ `App.tsx` |
| P5 | 设置：逐字模式三选一（清晰/柔和/Apple）、律动光晕开关、lyricOffset 步长 ±50ms | ✅ `QuickSettings.tsx` / `App.tsx` |
| P6 | `npm run lint`（tsc --noEmit）✅、`npm run test`（152 用例）✅ | ✅ |

### 如何查看效果
```bash
cd D:\opencode\WaveForge
npm run dev:electron
```
播放一首带逐词数据的歌 → 默认「现代」模式即为 Apple 风格：所有行同字号、当前行逐词点亮（无闪烁）、封面节拍光晕 + 频谱并存；QuickSettings 可切换逐字效果（清晰/柔和/Apple）与律动光晕。

---

## 五、需要你确认的决策点

1. **「现代」模式最终形态**：A. 保持单行大歌词（调动画即可）；B. 改成多行列表、当前行放大（更像 Apple Music 播放页 / LyricsBlossom）；C. 两者都提供（设置里切换"单行/多行"）。
2. **逐字效果**：是否新增一个独立「Apple Music」逐字模式（不动现有 soft/clear），还是直接改造 soft 为 Apple Music 风格？
3. **律动背景**：要不要做"封面模糊 + 节拍光晕"？频谱可视化保留还是替换？
4. **改动范围**：只改播放页「现代」，还是播放页 + 桌面歌词现代样式一起改？
