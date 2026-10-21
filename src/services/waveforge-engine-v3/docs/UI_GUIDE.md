# WaveForge v3 调音室 UI —— 融合指南（UI_GUIDE）

> 配套 `docs/FUSION_GUIDE.md`（引擎融合手册）。本文档讲 **UI 部分**：
> `waveforge-engine-v3/ui/` 的现状（HSE 风格）、接线 `V3MixingStudio`、接通系统音量与听力测试播放。
> 本文保留 UI 接线契约，当前重设计仅在独立快照内进行。未经用户明确授权，不复制或同步到主程序。

## 0. UI 定位与设计语言（2026-10-19 修订）

HSE 调音室遵循快照根目录 `UI_Reference_Doc.md` 的 **M3 Audio Functional Glass 亮色规范**。本轮只实现亮色界面，页面、弹窗、图表、空间场景与独立预览入口使用同一套语义令牌。先完成文档和代码，实机测试与截图验收最后进行。

- **主程序亮色风格**：`ui/hse-theme.ts` 与主程序 HSE 的浅色薄荷主题一致，主色固定为 `#006A63`。
  `hse-main-controls.css` 是主程序 `hse-glass.css` 的原样副本；`hse-glass.css` 仅维护快照的响应式、焦点与新增页面适配。
  按钮、开关和分段控件保留玻璃反光与渐变，卡片使用相同圆角和轻阴影，滑块为圆形反光手柄。
- **导航 9 页**：主页 / 音效场景 / 均衡器 / 空间音效 / 空间音频 / 动态调音 / 分析 / 调音器 / 关于
  （`NAV_ITEMS` 数组 + `PageKey` 联合类型，新增页面 = 数组加一项 + 渲染分支加一行）；
- **品牌与状态**：使用 HSE 名称、实际输入/输出信息与真实链路状态。不展示未支持格式或认证徽章。
- **反馈**：归零、极值、旁路、A/B、预设应用与削波等状态变化使用轻微反馈，尊重减少动态效果；页面与导航保持稳定。
- **交互基元**：`components/Primitives.tsx`（Toggle/Slider/GlassCard/Modal/Segmented/Chip/ActionButton/InfoLine），
  滑块轨道用 `theme.sliderTrack()` 显示当前值填充；曲线与数值保持清晰稳定；
- 图标 lucide-react；文案与注释均为中文，与全项目一致。
- **旧主题兼容**：`hse-theme.ts` 的 `toLegacyTheme()` 把 HSE 主题转换为旧 V3Theme 接口，
  供复用既有弹窗/面板（modals 系列、eqPanel）使用。
- **空间音频**：布局、交互与文案允许改善，但视觉风格必须与主程序一致，按“输入与聆听方式 → 声源布置 → 试听 → 进阶参数”组织操作。
  audio channel 使用“声道”，channel layout 使用“声道布局”，channel order 使用“声道顺序”；M/S 说明为中央信号与差分信号，分别是左右声道的平均与差分。
  三维预览可使用真实空间场景，保留帮助定位的地面、方向、听者与声源；使用亮色材质，二维与三维坐标一致。
- **能力边界**：保留多声道输入到耳机双耳、通用 SOFA 数据集加载；排除 Atmos、Sony 360RA、真实多声道设备输出及个性化 HRTF 测量/生成/校准。

## 1. 目录与依赖

```
waveforge-engine-v3/ui/
├── V3MixingStudio.tsx      # 主面板：9 页导航 + 内容区 + 底部状态栏 + 弹窗调度
├── hse-theme.ts            # HSE 主题（useHSETheme / toLegacyTheme）
├── bridge.ts               # V3UiBridge 接口 + createV3UiBridge(engine, sampleRate)
├── hooks.ts                # useV3Params（快照 patch/replace）+ DeepPartial + deepMerge
├── pages/                  # 9 个页面组件（含 SpatialAudioPage 空间音频页）
├── components/             # 共享控件、空间编辑器、三维预览与状态显示
├── effectsPanel.tsx        # 效果卡清单（场景页引用）
├── modalsSpatial.tsx       # 混响（双路由+IR 导入）/ 3D 环绕 / 低音增强（谐波 + 低音下潜 lowBoostDb）
├── modalsDynamics.tsx      # 压缩 / 齿音 / 夜间 / 限幅 / IEQ / 变速变调 / 立体声宽度
├── modalsLoudness.tsx      # 音量自适应补偿（auto 曲线可视化）/ 响度归一化
├── eqCurveEditor.tsx       # SVG 对数频率轴曲线编辑器（拖拽控制点）
├── sharePanel.tsx          # 分享串（v3 编解码）+ MP3 导出 + 引擎信息
└── index.ts                # 公共出口
```

**依赖**：`react`（peer）+ `lucide-react` + `framer-motion`（WaveForge 已有）。本地验证 `npm run typecheck:ui`（tsconfig.ui.json，jsx react-jsx）。

## 2. 用户授权回流后的搬入步骤

以下仅记录未来接线方法；本轮不得执行回流。

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

## 5. 页面与功能对照（HSE 9 页导航）

| 页面 | 内容 | v3 特有 |
|---|---|---|
| 主页 | 系统音效总开关（电源键=恢复默认）、音效模式快捷卡片（Hi-Fi/增强/影院）、音量控制（滑块 0-100% → 引擎增益通道）+ 音量柱可视化、实时统计 | 音量滑块经 `loudnessNormalization.externalGainDb`（80ms 快平滑跟手） |
| 音效场景 | 11 场景 chips + 我的场景（上限 8）+ 效果卡（可叠加）+ 音量自适应补偿/响度归一化独立卡 | 齿音/IEQ/限幅/变速/宽度卡片；混响双路由 |
| 均衡器 | simple 5 段 / pro 10-20 段 + **曲线编辑器拖拽** + 级联 Q 补偿 + 锁定 + 预设 + EQ JSON 导入导出 | 20 段、Q 补偿、锁定 |
| 空间音效 | 混响 / 3D 环绕 / 低音增强 弹窗入口 | 低音增强含**低音下潜 lowBoostDb**（-6..+12dB，真实低频提升） |
| 空间音频 | 输入与声道布局、双耳渲染、声源布置、二维/三维预览、房间与头部追踪、通用 SOFA | 具体能力与验证状态见快照 `SPATIAL_AUDIO_IMPLEMENTATION.md` |
| 动态调音 | 压缩 / 齿音 / 夜间 / 限幅 / IEQ / 变速变调 / 立体声宽度 | 全部 |
| 分析 | LUFS/LRA/峰值/真峰值 + 限幅 GR 条 + **32 条对数频谱**（20Hz-20kHz，dBFS 归一化，100ms 轮询 + EMA 平滑）+ 5 项特征 + 听力测试（7 频点 × 5 轮） | 全部 |
| 调音器 | **v3 分享串**（完整参数，版本+校验+白名单）+ WAV 导出 + 引擎信息（采样率/延迟/LUFS/GR） | 分享串格式 |
| 关于 | HSE 品牌信息、版本与版权、开发者选项 | — |

## 6. 设计说明（供审查）

1. **UI 与引擎解耦**：所有面板只依赖 `V3UiBridge` 接口与参数快照，不 import EngineV3；
   融合侧可替换桥实现（如包一层 Web Audio 适配）。
2. **快照语义**：`useV3Params` 的 patch 做深合并后整包提交（`setParams` 完整快照），符合引擎契约；
   场景/分享串/恢复默认走 replace。
3. **音量独立于场景预设/组合**：`bridge.applyScene` 保留 `loudnessNormalization` 状态
   （内置 11 场景 + 我的场景统一路径），场景快照不得覆盖用户音量——已列入 UI 冒烟断言。
4. **反馈与主题**：有意义的参数/状态事件提供轻微反馈，普通悬停和空闲界面保持静止；主题随
   `accentColorChanged` 事件联动（localStorage `accentColor`），工作台固定使用亮色表面。
5. **可访问性**：文字与数值遵循 WCAG AA，状态不能只靠颜色表达；所有交互控件有可见键盘焦点，弹窗保留焦点约束与返回行为。
6. **验证顺序**：先改文档与代码，再执行必要的类型与功能检查；全部实现后集中进行实机测试和截图验收。
   使用快照 `npm run typecheck:ui` 与相关 UI 测试；实际运行、截图与回归结果记录在 `HANDOVER.md`，不能用历史数量代表当前通过。
