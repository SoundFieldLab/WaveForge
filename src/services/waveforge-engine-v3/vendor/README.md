# vendor/ —— 随模块自带的第三方库（离线可用）

> 目的：**下一个 AI（融合方）不需要联网找库**，本目录已随模块携带 LGPL 库的原始副本；
> 同时 `package.json` 的 optionalDependencies 已声明全部可选依赖，`npm install` 即可安装。

## 目录内容

| 目录 | 库 | 许可证 | 用途 | 使用方式 |
|---|---|---|---|---|
| `soundtouchjs/` | soundtouchjs v0.3.0（SoundTouch 核心，cutterbl/SoundTouchJS） | **LGPL-2.1** | 变速/变调（`src/dsp/StretchLgplAdapter.ts` 动态链接调用） | ① `npm install`（package.json 已声明）；② 或把本目录复制进 node_modules（离线环境） |

## LGPL 合规（用户策略：不修改源码、动态/静态链接调用）

- 本 vendor 副本为 **npm 原包原样拷贝**（dist/LICENSE/package.json/README 均未修改）；
- 使用方式：`StretchLgplAdapter.ts` 运行时 `import('soundtouchjs')` 只调公开 API；
- 分发时随附其 `LICENSE`（本目录内）并满足"可重新链接"（源码即 npm 包）；
- 未安装/不可用时适配器返回 null，自动回退自研相位声码器，功能不中断。

## 安装指引（给融合方 AI）

```bash
cd waveforge-engine-v3
npm install          # 自动安装 devDeps + optionalDeps（meyda/signalsmith-stretch MIT、soundtouchjs LGPL-2.1）
npm test             # 322 用例（29 文件，含 LGPL 适配器 5 项与 UI 冒烟 9 项）
```