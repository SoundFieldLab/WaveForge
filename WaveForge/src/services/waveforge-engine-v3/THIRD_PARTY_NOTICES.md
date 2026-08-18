# THIRD-PARTY NOTICES（第三方许可声明）

本模块核心代码为**自主实现**（纯 TypeScript，零运行时依赖），但算法概念、公开公式与部分实现思路
来源于以下开源项目与标准。按各自许可条款，这里保留版权声明；移植/参考时已在对应源文件头部注释出处。

## 概念/公式来源（实现为自主代码）

| 来源 | 许可 | 用途 | 本地参考 |
|---|---|---|---|
| RBJ Audio EQ Cookbook（Robert Bristow-Johnson） | 公开文档 | biquad 系数公式 | research/notes/rbj-eq-cookbook.txt |
| DSPFilters（Vinnie Falco） | MIT（源码头声明） | TDF2 状态机思路 | research/audio-libs/DSPFilters |
| kissfft（Mark Borgerding） | BSD-3-Clause | FFT 蝶形分解思路 | research/audio-libs/kissfft |
| Freeverb（Jezar @ Dreampoint） | 公有领域 | 梳状+全通混响结构 | stk FreeVerb(MIT) 对照：research/audio-libs/stk |
| stk（Perry R. Cook & Gary P. Scavone） | MIT 等价宽松许可 | 算法混响参考 | research/audio-libs/stk |
| DaisySP（Electro-Smith） | MIT | 压限/混响接口思路 | research/audio-libs/DaisySP |
| signalsmith-basics（Signalsmith Audio） | MIT | 效果器紧凑实现思路 | research/audio-libs/signalsmith-basics |
| signalsmith-stretch（Signalsmith Audio） | MIT | 变速变调（可选 WASM 依赖） | research/audio-libs/signalsmith-stretch |
| meyda（Hugh Rawlinson 等） | MIT | 频谱特征定义 | research/audio-libs/meyda |
| speexdsp（Xiph.Org） | BSD-3-Clause | 多相重采样思路 | research/audio-libs/speexdsp |
| ITU-R BS.1770-4 / EBU R128 | 标准（公开） | LUFS 测量公式与 K 加权系数 | research/notes（技术文档 §7） |
| ISO 226:2003 | 标准（公开） | 等响度曲线（本模块为 v2 兼容简化近似） | research/docs/音频算法技术文档.md §6 |
| YIN（de Cheveigné & Kawahara, 2002） | 学术公开 | 音高检测算法 | 技术文档 §10.1 |
| spleeter（Deezer） / demucs（Meta） | MIT | 声源分离（离线适配层，模型权重按各仓库声明） | research/audio-libs/spleeter, demucs |
| crepe（Marl/CMU） | MIT | 音高检测（离线可选） | research/audio-libs/crepe |

## 可选 npm 依赖（均 MIT）

- `meyda`：MIT，Copyright (c) 2014 Hugh A. Rawlinson, Nevo Segal, Jakub Fiala
- `signalsmith-stretch`：MIT，Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.

## LGPL 链接使用（用户策略：不修改 LGPL 源码，动态/静态链接调用打包）

| 库 | 许可 | 使用方式（不修改） | 合规要点 |
|---|---|---|---|
| **soundtouchjs**（SoundTouch 核心） | LGPL-2.1 | `src/dsp/StretchLgplAdapter.ts` 动态 import 原包、仅调用公开 API（SoundTouch 类）；未安装时自动回退自研相位声码器 | ① 库作为独立 npm 依赖分发，不并入我方源码；② 随附 LGPL-2.1 LICENSE 全文（node_modules/soundtouchjs/LICENSE）；③ 源码即 npm 包本身，满足"可重新链接"要求；④ 不修改其任何源码 |
| @soundtouchjs/audio-worklet（v2 在用） | LGPL-2.1 | 融合时可按需保留（v2 既有依赖），同样以"未修改、链接调用"方式 | 同上；其核心与 soundtouchjs 同源 |
| FFmpeg 滤波器（f_ebur128 等）/ libsoxr / sox | LGPL | 仅作公式与算法对照；如需引入须保持"未修改、独立链接"，并随附 LICENSE | 同上原则 |
| ebur128（Rust crate）等 | 视具体项目 | 引入前核对 SPDX | — |

> LGPL 合规红线（即便允许链接）：不修改 LGPL 源码、不静态合并其代码进我方文件、
> 分发时随附许可文本与源码获取途径、保留版权声明。

## 明确不引入（GPL/AGPL 类，仅概念对照）

- Rubber Band（GPL）、Essentia（AGPL）、Freeverb3 / zita-rev1 / zita-convolver（GPL）、Audacity（GPL）。
- pitch-time-example-code（无 LICENSE 文件，仅阅读）。

## 合规执行规则

1. 引入可选 npm 依赖时在分发物附本文件。
2. 移植/借鉴代码时保留源文件头版权注释（已在各源文件实现）。
3. 模型权重（spleeter/demucs/crepe）分发时保留各仓库 LICENSE。