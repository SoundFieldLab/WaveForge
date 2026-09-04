# Vendored: Project Folia 可视化器（歌词视觉）

本目录是从开源项目 **folia-major**（Project Folia）vendored 的歌词可视化器子树。

- 上游仓库: https://github.com/chthollyphile/folia-major
- 引用版本: 0.6.21（commit 67b8766a8cce4393006432dd8a906bf0d77cd172）
- 上游协议: **GNU Affero General Public License v3.0**（见下方链接，完整文本见上游仓库 LICENSE）

包含内容：
- `components/visualizer/` —— 12 个歌词视觉样式（classic/cadenza/partita/fume/cappella/
  tilt/claddagh/diorama/monet/pendolo/sonnet/tempera）+ 注册表/运行时/设置面板
- `types.ts`、`utils/lyrics/`、`utils/fontStacks.ts` 等上游工具
- `locales_zh-CN.ts` —— 上游中文语言包
- `stores/useSettingsUiStore.ts`、`services/visualizerImageAsset.ts` —— **桩实现**
  （上游版本依赖 folia 应用外壳的 IndexedDB/zustand 体系，桩替换为最小实现）

WaveForge 侧的桥接层在 `src/components/FoliaLyricsPage.tsx`（歌词行格式转换、
播放时间线、频谱 MotionValue、主题映射）。

> AGPL-3.0 声明：本目录为 AGPL-3.0 衍生代码。分发 WaveForge 时需遵守 AGPL-3.0
> （提供对应源码），并在关于页/NOTICE 中保留对 Project Folia 的署名。
