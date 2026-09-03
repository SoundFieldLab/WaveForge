# WaveForge 澜音工坊

沉浸式桌面音乐播放器（Windows / Electron），支持 **QQ 音乐 + 网易云音乐**双平台：搜索、播放、歌词、可视化、智能推荐、无缝衔接（DJ 级转场）、桌面模式与壁纸联动。仓库同时含 **Android TV** 与 **Apple 歌词/探索**多平台分支。

## 快速开始

```bash
npm install                    # 安装依赖
npm run dev:electron           # 一键启动：Vite(3000) + API(3001) + Electron 窗口
```

- **高级功能（Smart AutoMix 节拍匹配）**：项目已内置 Python 3.13 运行时（`resources/python-embed/`），直接可用；启动 `start-full.bat` 或先运行 `python-beat-service/start.bat` 启动节拍服务（端口 **3002**）。
- 节拍服务未启动时，应用自动降级为 Fixed Crossfade，不影响基础播放。

## 核心功能

- **双平台搜索与推荐**：QQ 音乐 + 网易云实时搜索、每日推荐、热歌榜/飙升榜、猜你喜欢
- **QQ 音乐 API Key 领取**：内置引导窗口直达 y.qq.com 领取 qmk API Key（独立隔离 session，每次打开清空登录态）
- **无缝衔接播放**：三种模式 —— Smart AutoMix（智能节拍匹配+BPM 同步，需 Python）/ Beat Crossfade（节拍交叉淡化）/ Fixed Crossfade（固定时长，默认）
- **歌词系统**：LRC 解析、逐字歌词（QQ）、实时滚动、点击跳转；逐字特效模式（清晰/柔和/Apple 逆向还原）
- **空间音频（Spatial Audio）**：EngineV3 合成解析 HRTF 双耳渲染——一键空间化 / 头锁定环绕 / 世界漫游 / 舞台影院四模式（详见下方「空间音频」章节）
- **可视化**：频谱柱 / 波形 / 环形 / 3D 可视化
- **桌面模式**：桌面小组件、专注计时、生产力工具、自定义壁纸
- **Wallpaper Engine 联动**：读取本地 WE 配置并同步音频可视化
- **缓存系统**：IndexedDB（封面双缓冲、歌单缓存、免闪切换）
- **插件系统**：App Store 式插件中心（横向圆角弹窗）、卡片/详情/导入/卸载、开关状态持久记忆、使用须知门控；内置 **DG_LAB 郊狼联动插件**（音乐波形→A/B 通道电流，V3/V4 双协议，波形导入与实时可视化）——第三方插件开发见 [docs/plugin-development.md](./docs/plugin-development.md)
- **社交/个人中心**：QQ/网易云关注与粉丝、查看他人主页、QQ MV 浏览、私人 FM、智能播放

## 技术架构

```
前端:    React 19 + TypeScript + Tailwind CSS 4 + Vite 6
桌面:    Electron 42（主进程 CommonJS，preload 桥接）
后端:    Node.js + Express（local-server.mjs，单文件，端口 3001）
音频:    Web Audio API + 节拍分析（Python 3.13 + librosa）
音乐源:  qq-music-api + NeteaseCloudMusicApiEnhanced
可视化:  Three.js + React Three Fiber
多平台:  Android TV（android/ + src/tv/，vite.android.config.ts）
         Apple 歌词/探索分支（src/components/Apple*，src/services/apple*）
```

```
WaveForge/
├── src/                        # React 前端
│   ├── components/            # 组件（App.tsx 懒加载；Apple* 为 Apple 分支）
│   ├── services/              # API 客户端、缓存、无缝衔接逻辑、apple* 服务
│   ├── audio/                 # 播放引擎（队列/转场规划/渲染器）
│   ├── tv/                    # Android TV（TvKeyboard/mediaKeyBridge/tvCore）
│   ├── hooks/  api/  utils/  types/
├── android/                    # Android TV Gradle 工程（build:android 生成资产）
├── desktop/                   # Electron 主进程 + preload（.cjs）
├── server/                    # 后端附加路由（hazard/location/comment）
├── local-server.mjs           # Express 后端（约 10k 行，单文件）
├── python-beat-service/       # 节拍分析服务（Flask，端口 3002）
│   └── packages/              # 离线 wheel 缓存（cp313，对应内置 3.13）
├── resources/python-embed/    # 嵌入式 Python 3.13.15（npm run bundle-python 重建）
└── scripts/                   # dev/build/打包/发布脚本
```

## 开发命令

```bash
npm run dev:electron    # 完整开发（前端+后端+Electron）
npm run dev             # 仅 Vite（3000）
npm run dev:api         # 仅 API（3001）
npm run lint            # TypeScript 类型检查（tsc --noEmit）
npm run test            # vitest 单测（41 文件 477 用例，含 v3 引擎 324）
npm run build           # 仅构建前端 -> dist/（日常开发，不生成 EXE）
npm run build:electron  # 发布：目录构建 → EVS production VMP → NSIS（需 EVS secrets）
npm run build:full      # 完整发布：bundle-python + build:electron
npm run build:electron:dir  # 发布目录包：构建 + EVS production VMP（需 EVS secrets）
npm run build:electron:dir:unsigned  # 仅本地诊断，不能发布/不能用于 Apple 原生验收
npm run build:android   # 生成 Android TV 前端资产
npm run fetch:nodejs-mobile  # 拉取 Android 运行时
npm run publish:release # 一键发布脚本
npm run version:patch|minor|major  # 版本号更迭（自动 commit/tag/push）
npm run bundle-python   # 重建嵌入式 Python 运行时（3.13.15）
npm run test:license    # 设备授权自测
npm run sync:sponsors   # 刷新爱发电赞助名单（构建前会自动以可选模式运行）
test-python-service.bat # 检测节拍服务（3002）
```

`npm run dev:electron` 启动前会快速验证开发 ECS 的 production streaming VMP；签名仍有效时不会重签。只有首次配置、重装或升级 Electron 后才会请求一次 EVS 签名，前端热更新与普通 `npm run build` 不生成 EXE、也不触发签名。开启应用级开发者模式后，可在“开发者选项”查看 VMP 剩余有效天数；剩余不超过 180 天时界面会提示安排续签。

## 发布（GitHub Releases）

**只发 NSIS 安装版**（`release/WaveForge-<version>-Setup.exe`），**不发便携版**（`release/win-unpacked/` 仅本地调试）。安装版为每用户安装、**不携带任何用户数据/配置**——首次运行在该机 `%APPDATA%\WaveForge 澜音工坊\` 自动生成全新配置并适配当前用户。

```bash
npm run build:electron          # 构建安装版（强制 EVS production VMP）
git tag v<version> && git push origin v<version>
gh release create v<version> release/WaveForge-<version>-Setup.exe --title "v<version>" --notes "..."
```

Windows 发布机/CI 必须配置 `EVS_ACCOUNT_NAME`、`EVS_PASSWD` 并安装 `castlabs-evs`。签名发生在构建机，正式构建要求 production streaming VMP 至少剩余 30 天，并将无敏感信息的有效期元数据写入安装包；低于门槛或签名无效会直接阻断发布。最终用户安装后**不需要 EVS、签名工具或任何手动签名步骤**；用户只需在应用内登录具有有效订阅的 Apple Music 账号。

## 端口一览

| 端口 | 服务 | 说明 |
|---|---|---|
| 3000 | Vite / 生产 preview | 前端（后端 CORS 白名单） |
| 3001 | Express API | 后端（绑定 127.0.0.1，仅放行 localhost:3000 / file:// / null） |
| 3002 | Python 节拍服务 | Flask（Smart AutoMix） |
| 3003 | Python 响度测量服务 | Flask（响度归一化 `/lufs`，ITU-R BS.1770） |
| 3004 | Python 频响补偿设计服务 | Flask（`/compensation`，ISO 226 简化等响度模型/预设/自定义 → 多段 Biquad 参数） |

## 音效引擎 v1 / v2 / HSE

调音室头部可切换音效引擎版本（默认 **v1 原版**；v2 为增强版：场景方案 / 可叠加效果 / 混响类型 / 压缩 / 夜间模式（动态压缩 + 高频衰减）/ 频响补偿 / 响度归一化；**v3 为纯 TS DSP 内核引擎**：`src/services/waveforge-engine-v3/`，14 级处理链（响度归一化→3D 环绕→M/S→EQ→齿音→压缩→夜间→卷积/算法混响→虚拟低音→等响度补偿→智能 EQ→限幅）、11 组合场景、10/20 段 EQ + 级联 Q 补偿、分享串（版本+校验+白名单防注入）、LUFS/频谱分析 + 听力测试、WAV 离线导出（与实时链逐样本一致）、AudioWorklet 渲染线程 + script 兜底）。**HSE（HyperSoundEngine）**（左侧 8 页导航：主页/音效场景/均衡器/空间音效/动态调音/分析/调音器/关于，深色琥珀金主题）；**低音增强含「低音下潜」**（-6..+12dB 真实低频能量提升，lowshelf 语义，谐波虚拟低音之上补足对比 v2 的低音下潜）；**分析页**为对数频率轴实时频谱（20Hz-20kHz、dBFS 归一化、10fps 刷新）+ LUFS/GR/特征 + 听力测试；**音量控制跟手**（80ms 平滑）且**独立于场景预设/组合**（应用场景不覆盖用户音量）。HSE响度归一化（实时 BS.1770）与频响补偿（等响度 auto 按系统音量）均在引擎内实现，不依赖 3003/3004 服务；与 v1/v2 完全独立（不做参数迁移），参数快照持久化于 localStorage。v2 频响补偿为**等响度动态补偿**：多段 Biquad 链，auto 按系统音量线性提升低频（0-12dB）/高频（0-6dB，shelf 结构防中频污染）+ 场景预设（flat/bass/vocal/warm/bright/night）+ 自定义频段，设计结果由独立服务 3004 `/compensation` 下发。v2 调音室支持：场景一键应用（自定义状态弹覆盖/保存确认）、恢复默认/清空均衡器按钮、3D 环绕开启展开子设置横条、效果卡片「使用/已启用」、切歌时右上角弹衔接方案提示（直接拼接/60ms 淡入淡出/albumGapless 交叉淡化）。切换为热切换（暂停音乐换链后恢复），音频图未就绪时退化为冷切换（下次启动生效），右上角弹 2s 提示。详见 `AGENTS.md` 与 `CONTEXT.md`。

## 空间音频（Spatial Audio）

空间音频是 HSE 处理节点**之后**的兄弟 AudioWorklet 节点（`masterGain → [soundtouch?] → v3Node → [spatial?] → analyser`），只做双耳渲染、不碰引擎参数——HSE 核心（EngineV3）零改动，参数与 V3EngineParams 完全解耦（全局设置，不进场景快照、不被场景应用覆盖）。四种模式：

- **A 一键空间化**：立体声展开为 ±30°（20..120° 可调）虚拟扬声器，干湿混合强度 / 房间模拟预设 / 房间混响可调
- **B 头锁定环绕**：5.1 / 7.1.4 / 自定义布局预设 + 环形拖拽编辑器（上限 16 只扬声器）+ 逐扬声器声源路由（L / R / both），声场固定于头部朝向（耳机听感）
- **C 世界漫游**：3D 视图 + WASD/QE 移动、鼠标拖拽转头（F 第一人称跟随、R 重置听者），支持多普勒、声源轨迹关键帧（按播放时钟线性插值）、遮挡/衍射（增益衰减 + 高频低通）
- **D 舞台/影院**：4 场景预设（音乐舞台 / 电影院 / 钢琴独奏 / 自然场景）+ 座位选择（前/中/后，距离 ×0.8 / 1.0 / 1.35）+ 房间大小 / 氛围混响调节

**核心能力**：

- **合成解析 HRTF** 双耳渲染：当前使用 EngineV3 内置解析模型，无需外部数据文件；外部 SOFA 数据集导入尚未实现
- **球谐插值**（实球谐 L=3 最小二乘拟合）与最近邻网格查表双 HRTF 插值模式
- **完整房间模拟**：镜像声源法早期反射（1-3 阶）+ FDN 晚期混响（8 条质数延迟线 + Hadamard 8×8 反馈矩阵），7 种预设（录音棚/音乐厅/舞台/教堂/户外/浴室/走廊）
- **Ambisonics 环境上混**（FOA 环境场 → 4 方向扩散虚拟扬声器，叠加到各模式主渲染）
- **多声道输入自动映射**（>2 声道输入 → 5.1/7.1 布局逐声道双耳渲染）与 **Multichannel 物理输出**（6/8 声道映射，2 声道设备退化为双耳）
- **时域 / FFT 分区双卷积模式**（两种模式干湿对齐一致、脉冲位置 ±0 样本）
- **64 对象性能基准**：WASM 后端本机实测 ≈1.7ms/块（≈3.1x 实时率），TS 参考后端 ≈5.4ms/块

**参数持久化**：localStorage `waveforge:spatial-params`（独立于 HSE 场景快照；400ms 防抖 + 深合并容错，坏数据回默认）；HRTF 活动数据集记录 `waveforge:hrtf-active-dataset`。

**构建**：`npm run build:spatial-worklet`（cargo → wasm base64 内联 → esbuild 单文件 `public/spatial-worklet.js`），predev / prebuild 自动执行；缺失源逐级优雅降级（TS 参考后端兜底 / 合成 HRTF 网格兜底）。融合细节见 `src/services/waveforge-engine-v3/docs/FUSION_GUIDE.md` 第 6 章。

## 已知限制

1. 部分歌曲因版权/VIP 无法播放（未登录可播免费曲）
2. Smart AutoMix 依赖节拍服务，未启动时自动降级
3. 歌词第三方源（lrclib / amll-ttml-db）部分歌曲无词，属正常
4. 首次播放网易云高音质需后端启动时联网拉取 xeapi 公钥（已自动化）
5. 响度归一化依赖响度服务（3003），未启动/失败时自动回退原声
6. 频响补偿与均衡器、响度归一化互斥（避免同一频段叠加/双重整形），与低音/人声/伴奏增强可叠加
7. QQ 他人歌单/我喜欢歌曲/评论回复/听歌排行受平台限制；QQ 关注/粉丝接口必须用最新登录的 qm_keyst

## 文档

- [AGENTS.md](./AGENTS.md) — 给 AI 代理的项目指令（必读）
- [HANDOVER.md](./HANDOVER.md) — 交接文档：状态、已知问题、未决事项
- [CONTEXT.md](./CONTEXT.md) — 音效域词汇表（音效/场景方案/自定义状态/频响补偿等术语定义）
- [docs/adr/](./docs/adr/) — 架构决策记录（叠加效果模型/频响补偿互斥/导出链共享构建）
- [CACHE_SYSTEM.md](./CACHE_SYSTEM.md) — 缓存系统设计
- [LICENSE_SYSTEM.md](./LICENSE_SYSTEM.md) — 设备授权机制
- [AFDIAN_SPONSORS.md](./AFDIAN_SPONSORS.md) — 爱发电赞助名单同步说明
- [CODEX_RECENT_PLAYBACK_CHECKPOINT.md](./CODEX_RECENT_PLAYBACK_CHECKPOINT.md) — 最近播放功能检查点
- [WALLPAPER_GUIDE.md](./WALLPAPER_GUIDE.md) / [DESKTOP_MODE.md](./DESKTOP_MODE.md) — 壁纸与桌面模式
- [docs/plugin-development.md](./docs/plugin-development.md) — 插件开发文档（公开，供开发者与 AI 编写 WaveForge 插件，上传 GitHub 时随仓库发布）
- [PYTHON_EMBEDDING_GUIDE.md](./PYTHON_EMBEDDING_GUIDE.md) — 嵌入式 Python 构建
- [docs/歌词对比-LyricsBlossom.md](./docs/歌词对比-LyricsBlossom.md) — Apple Music 歌词逆向对比（Apple 逐字模式）

## 许可证

MIT（第三方依赖见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)）。

**私有模块**：无缝衔接（Smart Gapless）、智能混音（AutoMix）、看歌 / MV 背景（Bilibili）、
桌面模式、探索模式等模块以 **WaveForge 私有模块许可**提供（非 MIT），适用范围与使用限制详见
[PRIVATE-LICENSE.md](./PRIVATE-LICENSE.md)（受保护文件头部 / 目录 `LICENSE.private` 亦标注）。
