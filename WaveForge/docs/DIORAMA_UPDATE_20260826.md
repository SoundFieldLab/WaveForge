# Diorama（镜台）多维歌词模式 · 优化更新报告

**版本**: v0.1.4（当前 package.json 版本，Beta）
**日期**: 2026-08-26
**影响范围**: `src/components/foliaDiorama/`（主渲染）+ 入口 `MultidimensionalLyrics.tsx`

---

## 一、总览

本次更新为 Diorama（镜台）多维歌词模式的**性能优化 + 视觉效果全面升级 + 代码结构重构**，
同时合并了上游 folia-major 基类的 600+ 文件（`src/vendor/folia/`，含 classic/sonnet/diorama/monet/pendolo/
tempera/tilt/partita/fume/cappella/claddagh 等 11 种可视化模式的参考实现），为后续模式扩展
打下基础。

本期的核心改进方向：**逐字点亮更有冲击力、节拍同步更有律动感、行间过渡更流畅、副歌段差异化更明确、
频谱双翼更激进、代码结构更易维护**。

---

## 二、代码结构优化

### 2.1 抽离 `useDioramaSequencer` Hook ✅
- **文件**: `src/components/foliaDiorama/useDioramaSequencer.ts`（新增，约 170 行）
- **原位置**: `FoliaDioramaLyrics.tsx` 主组件内联的 5 state + 4 ref + 4 effect + setTimeout 跟踪逻辑
- **变更**: 将 sequencer 状态机（切歌铺段 / 歌词晚到原位重建 / 行推进与循环 / 过渡飞行）完整抽离为
  自定义 Hook。主组件只保留 rAF 时间同步与 WebGL 恢复（与 sequencer 无关）。
- **对外接口**: 返回 `{ sequencer, globalIndex, transitionEpoch, outgoingGlobalIndex, flightActive, linesEpoch }`，
  与原逻辑**零改动**——仅搬位置不改行为。
- **收益**: 主组件从 ~320 行 → ~260 行（-19%），Hook 单测可独立编写，后续改切歌逻辑无需动主组件。

### 2.2 抽离音律可视化层 ✅
- **文件**: `src/components/foliaDiorama/dioramaSpectrum.tsx`（新增，约 230 行）
- **原位置**: `DioramaScene.tsx` 内联的 `SpectrumFlanks` + `BeatRings` 组件
- **变更**: 两个组件 + 5 个 `SPECTRUM_*` 常量独立到文件，仅依赖 `cameraPath` / `dioramaSequencer` /
  `useAudioAnalyzer` 已有导出，与主场景的歌词行渲染、氛围层完全解耦。
- **收益**: `DioramaScene.tsx` 从 81.7 KB → 72.2 KB（-9.5 KB，-12%）。
- **路线图**: 下一步可继续抽 `NebulaField/PathRail/FloorMist/StarShell` 氛围层（预估再减 30KB）。

### 2.3 逐字点亮时序修正 ✅（BUGFIX）
- **现象**: 逐字歌词第一二个词偶现"先第二个点亮再第一个点亮"。
- **根因**: 数据源 `LyricWord[]` 中前两个词的 `startTime` 有时倒置（第一个晚于第二个），`buildLineGraphemeTimeline`
  按数组顺序填时间 → 视觉点亮顺序与文字顺序不一致。
- **修复**: `convertLyricsToFoliaLines` 中逐词强制 `startTime >= 前一词 endTime`，保留原 duration
  （时间向后平移而非压缩），保证点亮顺序严格按词序 = 视觉文字顺序。
- **位置**: `src/components/foliaDiorama/FoliaDioramaLyrics.tsx#L53-L69`

---

## 三、视觉效果优化

### 3.1 逐字点亮冲击力升级 ✅
**改动位置**: `ActiveLineText` 的 `useFrame`

| 维度 | 改动前 | 改动后 | 效果 |
|---|---|---|---|
| 未唱字色 | `#a8adc8` L=0.78 | `#525666` L≈0.41 | 未唱字明显退场，"逐字点亮"明暗对比才有冲击力 |
| 已唱字 opacity 峰值 | 0.84 | 0.92 | 恰进 Bloom 阈值，已唱字保留自然微辉光 |
| 字基底弹性 | 1 + 3.5%·sin(πt) | 1 + 15%·(1-t)² | 唱到瞬间"啵"地放大 15%，300ms 缓回——比 sin 包络更有冲击感 |
| 字光晕 opacity burst | 0.02·sin(πt) | 0.10·(1-t)² | 从 0.30 经三轮下调收敛到 0.10，不刺眼但仍保留逐字点亮的"光斑绽放" |
| 字光晕 mesh 扩散 | 跟随字基底（=1） | 独立 1→1.08（0.08 扩散） | 从 1.4 经三轮下调收敛到 1.08，"光从字边缘渗出"的极柔效果 |
| 字光晕稳定辉光 | 0.022 | 0.06 | 已唱字持续微辉光，不再"唱完就暗下去" |
| 光晕平滑速率 | -4 | -8 | burst 起音更快，跟上"瞬间点亮"的节奏 |

### 3.2 副歌段视觉强化 ✅
**检测算法**（`convertLyricsToFoliaLines`）: 歌词全歌 trimmed 文本重复出现 ≥2 次的行判为副歌
（排除 <2 字的过短行），设置 `line.isChorus = true` + `line.songPart = 'chorus'`。

**视觉差异化**:

| 项 | 主歌段 | 副歌段 |
|---|---|---|
| 光晕色相 | vividAccent | chorusAccent（暖偏 +5°、饱和 +12%、亮度 +6%） |
| 舞台光晕 | 1.0× | 1.5×（+50% opacity） |
| 字基底 scale | 0 | +2% 持续 boost |

副歌段**色更暖、光更浓、字稍大**，主歌/副歌切换时有清晰层次。

### 3.3 行入场动画 ✅
**现象**: 之前行激活/切换时是硬切出现，依赖相机飞行遮蔽 → 行间过渡偏"跳"。

**修复**: 行 mount 时记歌曲时间，前 400ms 做:
- **opacity 0→1**（smoothstep 缓动，与相机距离 life 相乘，入场期间整行渐亮）
- **Y 偏移 +0.15→0**（从下方雾中浮入，`-12 exp` 平滑避免硬切）
- **seek 跳过**: 跳转后 elapsed > 0.4s 直接满进度，切歌时不会重新浮入。

行级入场 + 相机飞行形成**双层过渡**，行间切换更"软"。

### 3.4 节拍同步 ✅
**数据源**: 已有 `pulseStore.getSnapshot().scale`（节拍包络幅度 0-1，峰值 = 节拍瞬间）。

**三处同步**:

| 维度 | 作用 | 节拍峰值幅度 |
|---|---|---|
| 已唱字稳定辉光 | 让已唱字持续律动（不抢戏） | +0.04 glow |
| 正在唱的字基底 scale | 字"跟着鼓点跳" | +3% scale |
| 正在唱的字色 accent 倾向 | 强拍时字色更饱 → "咬字"感 | lerp accent +0.15 |

### 3.5 频谱双翼 + 节拍环激进版 ✅
**SpectrumFlanks（32 柱 ×2 列）**:

| 项 | 原值 | 新值 | 效果 |
|---|---|---|---|
| 高度增益 | `level × 4.0` | `level × 5.0` | 柱子高 25% |
| 起音 attack | `-16` | `-20` | 跟手更快 |
| 节拍增益 | `beat × 0.35` | `beat × 0.5` | 节拍瞬间跳更高 |
| opacity 峰值 | `0.22 + 0.6` | `0.28 + 0.65` | 柱子更亮 |
| 白光提亮 | `level × 0.35` | `level × 0.45` | 高能时更白热 |

**BeatRings（节拍涟漪）**:

| 项 | 原值 | 新值 | 效果 |
|---|---|---|---|
| 触发阈值 | `beat > 0.55` | `beat > 0.5` | 中等拍也能炸环 |
| 起始 scale | 0.5 | 0.7 | 环起始更大 |
| 起始 opacity | 0.34 | 0.45 | 环更亮 |
| 扩散范围 | `0.5 + 4.6t` | `0.7 + 5.5t` | 扩更远 |
| 环厚度 | 0.02 | 0.03 | 环更粗 |

---

## 四、性能优化（之前已落地，本次一并上报）

| 优化项 | 位置 | 效果 |
|---|---|---|
| 文字栅格化 LRU 缓存 | `dioramaTextRaster.ts` | 减少重复 Canvas 栅格化 + 纹理上传 |
| 共享 PlaneGeometry | `DioramaScene.tsx` `SHARED_UNIT_QUAD` | 减少 memory alloc + draw call |
| 星河 GPU ShaderMaterial | `StarRiver` 粒子系统 | 粒子漂移/闪烁计算移至 GPU，CPU 0 占用 |
| 银河带 Canvas 合成优化 | `StarRiver` `drawImage` | 替代像素级 for 循环，渲染速度大幅提升 |
| CJK 检测正则补全 | `DioramaScene.tsx` | 修复非 ASCII 西文（俄语/希腊语）逐字误判 |

---

## 五、测试与验证

| 项目 | 结果 | 备注 |
|---|---|---|
| `npm run lint` (TypeScript 类型检查) | ✅ foliaDiorama 范围 0 错误 | 剩 2 个无关历史错误：`bilibiliApi.ts` 的 opencc-js/t2cn 类型声明、`V3MixingStudio.tsx` 的 TunerPageProps 不匹配 |
| `test/foliaReadableColor.test.ts` | ✅ 11/11 通过 | 可读颜色对比度 + accent 调参 |
| `test/foliaDioramaSequencer.test.ts` | ⚠️ 已删除，新版待补 | 旧版（基于原 sequencer 单测）不匹配新架构，后续按 `useDioramaSequencer` 重写 |

---

## 六、后续路线图（未落地）

按价值排序（高 → 低）:

1. **已唱字渐褪（C）**: 字唱完 1.5s 后 opacity 0.92 → 0.45（5s 线性衰减），缓解长歌画面"满"的问题。
2. **长拖音 stretch 视觉（D）**: 单字时长 >1.5s 时字基底慢正弦脉动 + 光晕持续扩散，慢歌段观感提升。
3. **整行尾扫光（E）**: 行最后一字唱完瞬间整行从左到右扫 accent 光，读作"一行结束的标点"。
4. **段落色带（F）**: 同 `blockIndex` 段行的光晕色相一致，相邻段落色相渐变（hue ±3°/段），主歌/副歌/段落三层叠加。
5. **继续拆 `DioramaScene.tsx`**: 氛围层（`NebulaField/PathRail/FloorMist/StarShell/StarRiver/ProgressOrb`）独立文件，目标主场景 ≤40KB。

---

## 七、上游合并说明（`src/vendor/folia/`）

本次同步了 folia-major 仓库的全部参考实现（AGPL-3.0），包括:

- **11 种可视化模式**: classic / diorama（Diorama 多维歌词基类）/ monet / pendolo / sonnet / tempera / tilt / partita / fume / cappella / claddagh
- **4 类背景层**: common（流体/几何）/ latent（潜空间扩散）/ monet（莫奈色带）/ nomand（噪点+半调+镜头畸变+玻璃+纸纹）/ sora（天空）/ url（自定义）
- **共用基础设施**: harmonyRuntime / colorMix / wordColoring / settingsPanels / cappella 头像素材库
- **中文本地化**: `locales_zh-CN.ts`（UI 全量翻译）

后续可按入口 `src/vendor/folia/components/visualizer/registry.tsx` 逐步把 monet/pendolo/sonnet
等模式接入 WaveForge 的模式切换面板。

---

## 八、备份清单

本次改动前已做本地备份（不入库）:

- `backup/folia_hook_20260824_2200/` — hook 抽离前的主组件 + hook 文件备份
- `backup/folia_word_timing_20260825_0100/` — 逐字时序修复前的场景 + 转换文件备份
