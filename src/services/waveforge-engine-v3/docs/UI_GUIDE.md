# WaveForge v3 调音室 UI —— 融合指南（UI_GUIDE）

> 配套 `docs/FUSION_GUIDE.md`（引擎融合手册）。本文档讲 **UI 部分**：
> `waveforge-engine-v3/ui/` 的现状（HSE 风格）、接线 `V3MixingStudio`、接通系统音量与听力测试播放。
> ✅ 融合已完成（2026-08-16/17）；2026-08-18 调音室 UI 被 **HSE（HyperSoundEngine）风格整体替换**。

## 0. UI 定位与设计语言（2026-08-18 重设计）

v3 调音室 UI 为 **HSE（HyperSoundEngine）风格**（替换旧的 liquid-glass 4 页签设计，无并行旧实现）：

- **深色琥珀金主题**：`ui/hse-theme.ts` 的 `useHSETheme()` —— 深黑底 `#0d0d0f` + 琥珀金强调色
  （默认 `#c9a84c`，可随 localStorage `accentColor` 联动，监听 `accentColorChanged` 事件）；
  玻璃拟态卡片 + 内发光边框（`cardBg` 渐变 / `cardGlow` 阴影 / `panelBorder` 1px 白 8% 描边）；
- **左侧导航 8 页**：主页 / 音效场景 / 均衡器 / 空间音效 / 动态调音 / 分析 / 调音器 / 关于
  （`NAV_ITEMS` 数组 + `PageKey` 联合类型，新增页面 = 数组加一项 + 渲染分支加一行）；
- **品牌标志**：顶栏白色圆角衬底上的 Hi-Res / DTS:X / Dolby Atmos 徽章（`components/Badges.tsx`）；
- **动画**：framer-motion（面板锚点滑入 spring、导航项 hover 位移、页面切换淡入上移）；
- **交互基元**：`components/Primitives.tsx`（Toggle/Slider/GlassCard/Modal/Segmented/Chip/ActionButton/InfoLine），
  滑块轨道用 `theme.sliderTrack()` 渐变填充；
- 图标 lucide-react；文案与注释均为中文，与全项目一致。
- **旧主题兼容**：`hse-theme.ts` 的 `toLegacyTheme()` 把 HSE 主题转换为旧 V3Theme 接口，
  供复用既有弹窗/面板（modals 系列、eqPanel）使用。

## 1. 目录与依赖

```
waveforge-engine-v3/ui/
├── V3MixingStudio.tsx      # 主面板：左侧导航 8 页 + 右侧内容区 + 底部状态栏 + 弹窗调度
├── hse-theme.ts            # HSE 主题（useHSETheme / toLegacyTheme）
├── bridge.ts               # V3UiBridge 接口 + createV3UiBridge(engine, sampleRate)
├── hooks.ts                # useV3Params（快照 patch/replace）+ DeepPartial + deepMerge
├── pages/                  # 8 个页面组件（HomePage/ScenesPage/EqPage/SpatialPage/
│                           #   DynamicsPage/AnalysisPage/TunerPage/AboutPage）
├── components/             # Primitives（Toggle/Slider/GlassCard/Modal/...）+ Badges（认证徽章）
├── effectsPanel.tsx        # 效果卡清单（场景页引用）
├── modalsSpatial.tsx       # 混响（双路由+IR 导入）/ 3D 环绕 / 低音增强（谐波 + 低音下潜 lowBoostDb）
├── modalsDynamics.tsx      # 压缩 / 齿音 / 夜间 / 限幅 / IEQ / 变速变调 / 立体声宽度
├── modalsLoudness.tsx      # 音量自适应补偿（auto 曲线可视化）/ 响度归一化
├── eqCurveEditor.tsx       # SVG 对数频率轴曲线编辑器（拖拽控制点）
├── sharePanel.tsx          # 分享串（v3 编解码）+ MP3 导出 + 引擎信息
└── index.ts                # 公共出口
```

**依赖**：`react`（peer）+ `lucide-react` + `framer-motion`（WaveForge 已有）。本地验证 `npm run typecheck:ui`（tsconfig.ui.json，jsx react-jsx）。

## 2. 搬入 WaveForge（两步）

1. 拷贝目录：`waveforge-engine-v3/ui/` → `WaveForge/src/services/waveforge-engine-v3/ui/`；
2. 调整 import：ui/ 内引用引擎的路径为 `../src/types` 等相对路径，拷贝后层级不变（`src/services/waveforge-engine-v3/` 下 ui/ 与 src/ 同级），无需改动。

> 若 WaveForge 侧已有 `src/services/waveforge-engine-v3/`（FUSION_GUIDE 步骤 1 的引擎目录），
> ui/ 放其下与 src/ 并列；`V3MixingStudio` 默认导出已就绪。

## 3. 接线模板（App.tsx）

与 v1/v2 调音室同构（lazy + 版本切换），新增 v3 分支：

```tsx
// 1) lazy 引入（与 MixingStudio/MixingStudioV2 并列）
const loadMixingStudioV3 = () => import('./services/waveforge-engine-v3/ui')
const LazyMixingStudioV3 = lazy(loadMixingStudioV3)

// 2) 切换 v3 引擎后，用 EngineV3Host 的 engine 建桥：
import { createV3UiBridge } from './services/waveforge-engine-v3/ui'
const bridge = createV3UiBridge(host.engine, ctx.sampleRate) // host = EngineV3Host 实例

// 3) 渲染（showMixingStudio && audioEngineVersion === 'v3' 分支）：
<LazyMixingStudioV3
  bridge={bridge}
  onClose={() => setShowMixingStudio(false)}
  playerTheme={playerTheme}
  anchorRect={anchorRect}
  engineVersion={audioEngineVersion}          // 'v1' | 'v2' | 'v3'
  onSwitchEngine={switchAudioEngine}
  exportMp3={exportV3Mp3}                      // 可选：离线导出
/>
```

- `onSwitchEngine`：复用现有 `switchAudioEngine`（热切换语义：暂停 → dispose 旧链 → attach 新链 → 恢复播放），版本枚举扩展为 'v3'；
- `bridge` 需要稳定引用（useMemo/useRef），切换引擎后重建。

## 4. 三处宿主接线（必须）

| 能力 | 事件/接口 | 融合侧实现 |
|---|---|---|
| **听力测试播放** | 监听 `v3HearingPlay` 自定义事件：`{ freqHz, levelDb }` | Web Audio 合成正弦（如 OscillatorNode），电平按 `10^(levelDb/20)` 换算幅度；播放时长约 0.6s 后停止，或由下一次事件/用户作答停止 |
| **系统音量 → 补偿曲线** | 写 `loudnessCompensation.volumePercent`（0-100） | 监听系统音量（Electron：`navigator.mediaDevices` 不可用则用 Windows API / 播放器主音量），变化时 `bridge.setParams` 更新；无音量源时默认 80 |
| **MP3 离线导出** | `exportMp3` prop | 复用 FUSION_GUIDE 步骤 5：解码 → `EngineV3.process` 分块 → Float32→Int16 → lamejs MP3 128kbps |

> 听力测试的"播放"不在 ui/ 内实现（纯 UI 不触碰 Web Audio），事件化解耦；未接线时流程 UI 仍可走完（不发声）。

## 5. 页面与功能对照（HSE 8 页导航）

| 页面 | 内容 | v3 特有 |
|---|---|---|
| 主页 | 系统音效总开关（电源键=恢复默认）、音效模式快捷卡片（Hi-Fi/增强/影院）、音量控制（滑块 0-100% → 引擎增益通道）+ 音量柱可视化、实时统计 | 音量滑块经 `loudnessNormalization.externalGainDb`（80ms 快平滑跟手） |
| 音效场景 | 11 场景 chips + 我的场景（上限 8）+ 效果卡（可叠加）+ 音量自适应补偿/响度归一化独立卡 | 齿音/IEQ/限幅/变速/宽度卡片；混响双路由 |
| 均衡器 | simple 5 段 / pro 10-20 段 + **曲线编辑器拖拽** + 级联 Q 补偿 + 锁定 + 预设 + EQ JSON 导入导出 | 20 段、Q 补偿、锁定 |
| 空间音效 | 混响 / 3D 环绕 / 低音增强 弹窗入口 | 低音增强含**低音下潜 lowBoostDb**（-6..+12dB，真实低频提升） |
| 动态调音 | 压缩 / 齿音 / 夜间 / 限幅 / IEQ / 变速变调 / 立体声宽度 | 全部 |
| 分析 | LUFS/LRA/峰值/真峰值 + 限幅 GR 条 + **32 条对数频谱**（20Hz-20kHz，dBFS 归一化，100ms 轮询 + EMA 平滑）+ 5 项特征 + 听力测试（7 频点 × 5 轮） | 全部 |
| 调音器 | **v3 分享串**（完整参数，版本+校验+白名单）+ WAV 导出 + 引擎信息（采样率/延迟/LUFS/GR） | 分享串格式 |
| 关于 | HyperSoundEngine 品牌三行信息（琥珀金渐变大标题 / WaveForge特供版 / 版权行） | — |

## 6. 设计说明（供审查）

1. **UI 与引擎解耦**：所有面板只依赖 `V3UiBridge` 接口与参数快照，不 import EngineV3；
   融合侧可替换桥实现（如包一层 Web Audio 适配）。
2. **快照语义**：`useV3Params` 的 patch 做深合并后整包提交（`setParams` 完整快照），符合引擎契约；
   场景/分享串/恢复默认走 replace。
3. **音量独立于场景预设/组合**：`bridge.applyScene` 保留 `loudnessNormalization` 状态
   （内置 11 场景 + 我的场景统一路径），场景快照不得覆盖用户音量——已列入 UI 冒烟断言。
4. **动画**：framer-motion（面板入场 spring、页面切换淡入上移、导航 hover 位移）；主题随
   `accentColorChanged` 事件联动（localStorage `accentColor`）。
5. **测试策略**：ui/ 为纯受控组件 + 桥接口，本地保证：`npm run typecheck:ui` 0 错误；
   引擎回归（319）+ UI 冒烟（10）= **324 用例（+5 LGPL 跳过）全绿**。