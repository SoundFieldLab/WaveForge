# WaveForge 私有模块许可（Private Module License）

**版权所有（c）2026 WaveForge 澜音工坊（Kirito666233）· 保留所有权利。**

本许可适用于本仓库中**明确标注为私有模块**的代码与资产——标注方式包括：
文件头部注释、所在目录的 `LICENSE.private`、以及下方「适用范围」清单。
**无论仓库主体采用何种开源协议，以下模块一律以本许可为准。**

## 适用范围

| 模块 | 文件 / 目录 |
|---|---|
| 无缝衔接（Smart Gapless） | `src/services/gapless/**` |
| 智能混音（AutoMix，含节拍分析 / 过渡编排 / AI 渲染） | `src/services/autoMixAnalysisService.ts`、`src/audio/transitionPlanner.ts`、`src/audio/TransitionRenderer.ts`、`server/analysis_worker.py`、`python-beat-service/beat_analyzer.py`、`desktop/workers/render_worker.py`、`desktop/workers/djtransgan_worker.py`、`desktop/analysis-runtime.cjs`、`desktop/ai-model-manager.cjs` |
| 看歌 / MV 背景（Bilibili） | `src/services/bilibiliApi.ts`、`src/services/mvAlignment.ts`、`src/components/BilibiliMvPlayer.tsx`、`src/components/BilibiliMvBackground.tsx`、`src/components/BilibiliVideoPlayerOverlay.tsx`、`src/components/BilibiliWatchSettingsModal.tsx`、`server/bilibili-api.mjs` |
| 桌面模式（Desktop 小组件 / 壁纸 / 独立播放小窗） | `src/components/Desktop*.tsx`（DesktopView / WidgetZone / MiniPlayer / ExtraWidgets / CustomizationEditor / SettingsModal / ProductivityWidgets / TimeCenter / FocusAlarmOverlay）、`src/components/WallpaperLyrics.tsx`、`src/desktop-player/**` |
| 探索模式（Explore） | `src/components/ExploreView.tsx`、`src/components/ExploreSettingsPanel.tsx` |
| Apple Music 平台接入（认证 / 目录 / 歌词 TTML / 动态封面 / 原生 HLS 播放 / 探索 / 登录窗） | `src/services/apple*.ts`、`src/hooks/useAppleDynamicCover.ts`、`src/utils/ttmlParser.ts`、`src/components/Apple*.tsx`、`server/apple-artwork-api.mjs` |
| 汽水音乐平台接入（Soda：API / 音频解密代理 / 客户端与登录 UI） | `src/services/soda*.ts`、`src/components/SodaLoginPanel.tsx`、`server/qishui-api.mjs`、`server/qishui-audio-decryptor.mjs`（**例外**：`desktop/qishui-auth-v6.cjs` 为 GPL-3.0 移植，不适用本许可） |

## 允许（无需额外授权）

1. 在本仓库（WaveForge 澜音工坊）范围内使用、构建，并随 WaveForge 主发行物一起
   分发，前提是保留本许可声明、版权与归属标注（不得移除/模糊化）。
2. 个人学习、研究目的阅读源码。
3. 对本仓库的 Issue / PR 讨论中引用模块行为、提交修正，视为本仓库内使用。

## 禁止（未经 WaveForge 澜音工坊书面授权）

1. 将本模块**全部或部分**（含算法流程、数据结构、界面设计、逆向成果）复制、移植、
   改编后用于**任何其他项目、产品或服务**。
2. 以本模块为基础创作的**衍生作品**（包括更名 / 隐藏来源后的再发布、二次封装）。
3. 任何形式的**商业使用**：售卖、内置于收费产品、SaaS / 托管服务中集成本模块能力。
4. 从本模块中提取签名 / 加密 / 对齐等关键算法用于非 WaveForge 环境。

## 说明

- 本许可不构成对仓库内**第三方代码**（如 MIT/ISC/BSD 依赖、vendored 第三方库）的
  权利主张；第三方代码仍按其各自许可证约束。
- 若本许可与仓库主体开源协议冲突，以本许可为准（多许可仓库的常见形态）。
- 授权事宜请联系 WaveForge 澜音工坊（开源仓库的维护者）。
- **汽水登录例外**：`desktop/qishui-auth-v6.cjs` 系 Wx2yZx/Mineradio-Qishui-QR-Login 的
  GPL-3.0-only 移植，**不属于私有模块**，必须保持 GPL-3.0，分发时保留其来源与许可标注。
- **来源待核实**：汽水 API / 解密代理（`qishui-api.mjs`、`qishui-audio-decryptor.mjs`）
  移植自 `temp/SodaMusic_Qishui_Code` 快照（该快照当前不在本仓库，协议未能核实）；
  **若源项目为 copyleft 许可，则以源项目许可为准**，本许可仅在源可自由使用的前提下适用。
- **Apple Music 接入**为自有逆向成果（依据本项目 LyricsBlossom 逆向资材与对 Apple
  web/MusicKit 端点的黑盒分析），不包含第三方开源实现的逐行复制；若未来引入外部实现
  片段，按片段来源许可处理。

## 免责声明

本软件按「原样」提供，不附带任何明示或暗示的保证，包括但不限于适销性与特定用途
适用性。在任何情况下，版权持有人不对使用本软件产生的任何损害承担责任。