# WaveForge 交接文档

> 给接手本项目的开发者或 AI 代理的交接说明。包含：项目当前状态、环境、已知问题、未决事项、历史决策摘要。
> 面向"接下来要干活的人"，读完本文档 + `AGENTS.md` 即可上手。

---

## 1. 项目状态（2026-08-16）

- **阶段**：功能完整，处于维护/优化阶段。核心功能（双平台搜索/播放/歌词/无缝衔接/桌面模式/壁纸联动）均已实现；**多平台分支**（Android TV、Apple 歌词/探索）已合入。
- **代码基线**：当前 HEAD `050d315`（2026-08-16 远程 lyrics-apple 分支合并：Android TV + Apple 逐字/探索 + 探索页设置重构 + compression 依赖）；本地含 12 个性能 commit（`1c8ef0c`~`6acf49c`）+ 回归修复（`d1b5e5f`）+ 版本更迭（`8b09d60` v0.1.2）。
- **稳定性**：`npm run lint` 0 报错、`npm run test` **41 文件 / 469 过 + 5 跳过（v3 LGPL 可选依赖用例，未装属设计行为）/ 共 474 用例**、`vite build` 成功、便携版（win-unpacked）启动冒烟通过（四服务 3001-3004 全 200、首页推荐/热歌榜数据非空）。
- **代码规模**：前端约 160+ TS/TSX（含 Android TV 与 Apple 分支），后端 `local-server.mjs` 单文件约 10.2k 行，Python 服务约 2.1k 行。

## 2. 环境（重要）

| 组件 | 版本/说明 |
|---|---|
| 嵌入式 Python（生产运行时） | **3.13.15**，位于 `resources/python-embed/`（gitignore，可 `npm run bundle-python` 重建） |
| 关键 Python 依赖 | numpy 2.5.2 / scipy 1.18.0 / librosa 0.11.0 / pedalboard 0.9.24 / numba 0.67.0 |
| 离线 wheel 缓存 | `python-beat-service/packages/`（41 个 cp313 wheel，`start.bat` 离线安装用，**已入库**） |
| 系统 Python | PythonEvm312（3.12.7）、PythonEvm314 —— 仅作回退，生产用嵌入式 |
| Node/前端 | Electron 42、React 19、Vite 6、TS 5.8 |
| 多平台 | Android TV（Gradle + nodejs-mobile，`build:android`）、Apple 分支（`src/services/apple*`） |

> ⚠️ **端口占用坑（2026-08-16 实测）**：本机另一个项目 **ReWaveForge**（`E:\FolderForVibeCoding\dsh\ReWaveForge\backend-go\bin\waveforge-server.exe`）会抢占 **3001/3101** 端口——WaveForge 后端启动失败（日志"端口已被占用"）、前端连到 Go 服务的空数据（首页/榜单全部"没有加载到内容"、`/health` 返回 unauthorized）。**症状 = 前端功能大面积不对时先查 3001 是否被其他进程占用**（`netstat -ano | grep :3001`）。

**运行时升级历史**：2026-08-13 从 3.11.9 升级到 3.13.15（此前 README 宣称 3.13 但实际 bundle 的是 3.11.9，属修复性升级）。离线 wheels 随之重建为 cp313 全集。

## 3. 端口

| 端口 | 服务 |
|---|---|
| 3000 | Vite dev / preview（后端 CORS 白名单仅放行此端口 + file:// + null） |
| 3001 | Express API（127.0.0.1） |
| 3002 | Python 节拍服务（Flask，beat_analyzer.py） |
| 3003 | Python 响度测量服务（Flask，loudness_server.py，`/lufs`） |
| 3004 | Python 频响补偿设计服务（Flask，compensation_server.py，`/compensation`） |

> ⚠️ 历史文档中 5001 均为过时信息；`test-python-service.bat` 已修正为 3002。响度服务 3003、频响补偿服务 3004 均独立于节拍服务：dev 由 `dev-electron.mjs` 拉起、打包版由 `main.cjs` startLocalBackend() 拉起、手动可用 `start-full.bat`。

## 4. 已知问题 / 踩坑记录

1. **网易云 xeapi 公钥**：`/api/netease/song/url` 报 `xeapi public key is missing` 时，说明 `os.tmpdir()/xeapi_public_key` 被系统清理了 —— 重启后端即可（`initNeteaseAPI()` 启动时自动 `generateConfig()` 重新拉取）。此修复已合入远程基线 `f5d59b9`（本地历史已重置，旧提交号 `d367cf9` 不再存在于本地）。
2. **SSRF 守卫与内部代理链**：`proxy-image → cover`（`localhost:3001`）是本应用合法内部代理链，SSRF 守卫必须放行本服务自身端口 3001，否则评论区/歌单封面裂。**不要在守卫中一刀切封 localhost**。见 `local-server.mjs` 中 `isBlockedFetchUrl` 内的放行分支。
3. **wallpaper-engine 路径穿越防护**：`/api/wallpaper-engine/preview|media` 用 `resolve + startsWith(base+sep)` 校验，改动时保持。
4. **Electron will-navigate 守卫**：主/播放器/歌词三窗口已加导航白名单（dev: localhost:3000/127.0.0.1:3000；prod: 三个 file:// 入口）。**QQ 音乐 QMK API Key 领取窗口是唯一被允许打开 `y.qq.com` 的窗口**（`QMK_SESSION_PARTITION = 'waveforge-qq-skill-key'`，独立 session 且每次打开前清空避免复用登录态）——不要为其他窗口放宽守卫。
5. **热路径日志**：播放/动画热路径必须用 `debugLog()`（`src/utils/debugLog.ts`），裸 console.log 会造成内存增长。`PlaylistGrid3D.tsx` 已全部改用。
6. **音频格式白名单**：`beat_analyzer.py` 仅接受 `.mp3/.flac/.wav/.ogg`（运行时 libsndfile 不支持 m4a/aac/opus/webm，且无 ffmpeg）。
7. **离线安装**：`start.bat` 的 `--no-index --find-links=packages` 依赖 `packages/` 里的 cp313 wheels —— 若再升级 Python 主版本，需重建 wheel 集（`pip download --only-binary=:all: -d packages`）。
8. **prebuild 钩子**：`npm run build` 会自动执行 `sync:sponsors --optional`，依赖 `WaveForge-Afdian.env` 中的爱发电 Token；未配置时软失败，不影响构建（详见 `AFDIAN_SPONSORS.md`）。
9. **回归修复记录（2026-08-16 审计，commit `d1b5e5f`）**：
   - 无限推荐队列裁剪：`setCurrentIndex` 原在 `setTimeout(0)` 里、与 `setPlaylist` 不同步 → 中间帧 `currentIndex` 越界导致播放页闪回首页 → 已改为同批次同步提交。
   - `loadAndPlay` 的 `NotAllowedError` 被静默吞掉（浏览器/手势策略拒绝 play 是真实失败）→ 已恢复走失败重试路径，仅 `AbortError` 静默。
   - `/api/qq/mv/url` merge 后 `parseQQCookie` 用了原始 `req.query.cookie` 局部变量，仅依赖全局登录态时解析空 → 改 `resolveRequestCookie(cookie) || qqMusicCookie`。
   - `/api/qq/artist/subscribe` 签名 payload 与请求头写死全局 cookie → 改请求级 cookie（`cookie || qqMusicCookie`）。

## 5. 性能优化记录（2026-08-16 多轮并行，commit `1c8ef0c`~`6acf49c`）

> 全部通过 lint 0 错误 / vitest 152 用例 / build 成功；便携版冒烟验证过。**改动时勿回退这些基线**。

1. **渲染降频**：三视图（HomeView/ExploreView/DesktopView）memo + `viewCallbacks`（30 个 latest-ref 稳定回调）；弹窗（SettingsPanel/SongDetailModal/SimilarSongsPanel/UserProfileModal/UserProfileView/ProfileView/AlbumDetailModal/PlaylistPanel/PlaylistDetailPanel）全部 memo + `stableDialogCallbacks`；过渡进度 rAF 三处 30fps 节流（结束帧强制 emit）；歌词 30fps 平滑时钟门控（无逐字词/无间奏停 rAF 空转）；频谱/脉冲 rAF 双门控（消费者计数 + visibility）；Banner 轮播抽离 memo 组件。
2. **列表虚拟化**：CommentModal（扁平行数组 + `useDynamicRowHeight` 变高行）、ArtistDetailModal 全部歌曲（定高 64px）用 react-window；ProfileView 6 个高成本列表抽 memo 行组件 + latest-ref 回调。
3. **内存治理**：8 处缓存加 LRU 上限（SearchPanel/响度/补偿/推荐等）；v1/v2 引擎 dispose 清空节点引用；无限推荐队列裁剪（保留当前曲前 100 首）；封面 IndexedDB 写幂等 + `enforceLimit` 60s 节流；`cacheManager` 死代码（封面已迁移 IndexedDB）。
4. **传输**：`/api/cover`、`/api/proxy-image` 流式转发（`streamProxyImage()`，不再整读 20MB 进内存）；后端 gzip（compression，filter 排除 image/video/audio 保流式）；axios keepAlive Agent；遥控器广播改增量（不再每 100ms 全量序列化 500 条 playlist）。
5. **首屏/启动**：leaflet 懒加载（WeatherDetailsModal 拆 `weatherVisualTheme.tsx`）；vite manualChunks（vendor-react/motion/leaflet）+ opencc-js `cn2t` 子路径（主入口 -23%）；`createAnalysisRuntime` 同步 statSync 扫描移入 `setImmediate`。
6. **Python 服务**：beat `cleanup_cache` 60s 节流（3000 缓存文件 585ms→即时）+ `threaded=True`；loudness 分段能量积分 numpy 向量化（`np.add.reduceat`）+ K 加权系数缓存 + 测量结果磁盘缓存（256MB/30 天，同文件重测跳过解码）。
7. **cookie 单事实源**（1c8ef0c）：全局 `qqMusicCookie` 只在登录/设置接口更新；播放/读取路由用 `resolveRequestCookie` 只读；写操作按请求级 cookie 传递——修并发播放/写操作互相冲掉登录态。

## 5b. 未决事项（可选做）

> 2026-08-14 已并行处理大部分（见 §6 历史决策）；2026-08-16 完成性能优化与回归审计。剩余：

- [ ] **license 机制未强制执行**：`desktop/device-license.cjs` 计算授权但无功能门控（纯展示）。曾尝试加入"激活后拦截未授权播放"的门控，因会**限制现有功能**而被撤销——正确方向是"激活解锁**新**功能"而非限制已有功能，等付费功能规划时再做。
- [x] ~~**cuefield 时间线执行器为死代码**~~：✅ 已清理（2026-08-14）——删除 `cuefieldAutoMix.ts`/`cuefieldTimelineExecutor.ts`/`cuefieldApi.ts` 三文件 + `gaplessIntegration.ts` 约 400 行不可达代码（三方案分流/albumGapless 完整保留）。**遗留**：后端 `local-server.mjs:8027` 的 `/api/cuefield/transition` 路由无前端调用方，可后续清理。
- [x] ~~**TransitionRenderer 缓存 key**~~：✅ 已修复——`plan.id` 加入实际裁决策略/起止时长/rendererVersion（`RENDERER_VERSION` 常量）。
- [x] ~~**render_worker 声道不一致**~~：✅ 已统一为立体声（server 去掉 mono 折叠 + 修复 librosa 帧布局 bug；desktop 补 mono→stereo 上采样），19 项音频冒烟断言全过。
- [x] ~~**CHUNK 体积警告**~~：✅ 已优化——`locationHierarchy` 8.8MB → 752KB（`city.json` 按国家拆分 + 动态 import），build 无告警。
- [x] ~~**测试覆盖**~~：✅ 已补 vitest 套件（10 文件 / 111 用例全过）——`npm run test`。
- [x] ~~**UpNext「即将播放下一首」弹窗在 gapless 模式不显示**~~：✅ 已修复（2026-08-14）——`src/App.tsx` 的 `eventTime = useTransitionCountdown ? transitionStartTime : duration` 无 fallback，`transitionStartTime` 为 null（preparing-next/加载/取消路径）时弹窗永不触发；改为 `transitionStartTime ?? duration` 回退歌曲剩余时长倒计时。已实测弹窗恢复。
- [x] ~~**license 机制未强制执行**~~：保留——方向为"激活解锁新功能"而非限制旧功能，等付费功能规划时再做。
- [x] ~~**音效模块升级**~~：✅ 已完成（2026-08-14）——效果可叠加、场景方案（内置 7 + 我的场景 8 上限、快照式 + 覆盖/保存确认）、混响类型（大厅/房间/板式/弹簧/舞台 + 预延迟/衰减可调）、动态压缩、夜间模式、频响补偿（等响度动态补偿：低频 0-12dB/高频 0-6dB shelf 结构防中频污染，auto 按系统音量线性提升，与 EQ、响度归一化互斥）、响度归一化（独立服务 3003 + 目标 -14 LUFS）、导出 WAV 与实时链共享构建。详见 CONTEXT.md + docs/adr/。

## 6. 历史决策速览（详见 PROJECT_HISTORY.md）

- 2026-07-10/07-13：两次项目合并（同学版本 + Wave-Forge 桌面版）
- 2026-07-24~25：无缝衔接三模式（Fixed/Beat/Smart AutoMix）落地，Python 服务独立化 + 降级策略
- 2026-07-31：Phase 1（Beat This 集成）完成，Phase 2（智能过渡点）规划在案
- 2026-08-13：代码安全修复（SSRF/路径穿越/IPC 启动通道/will-navigate）→ 运行时升级 3.13.15 → 全链路回归 → 文档整理（29→13 个 md）
- 2026-08-13：合并朋友优化版（WaveForge(4)）—— 安全加固 + 音频/渲染修复 + **QQ 音乐 QMK API Key 领取功能** + 打包修复；本地仓库重置为远程基线（2 条提交）
- 2026-08-14：无缝衔接三方案分流（专辑直接拼接/非专辑 60ms 淡入淡出）、调音室（3D 环绕无声修复 + liquid glass UI + 锚点动画）、设置页 Tab 蓝色滑动指示条、启动 splash 黑/白屏修复（软件合成适配）；确立 **Releases 只发安装版** 的发布策略
- 2026-08-14：并行收尾未决事项 —— vitest 测试套件（111 用例）、cuefield 死代码清理、TransitionRenderer 缓存 key 修复、渲染 worker 声道统一立体声、CHUNK 体积优化（8.8MB→752KB）+ 壁纸前端改进（立即同步/动态壁纸提示/UNC 容错）；license 门控尝试后撤销（避免限制现有功能）
- 2026-08-14：**Gapless 业务代码模块化** —— 从 `useAudioPlayer.ts`（1948 行）抽离到 `src/services/gapless/` 独立模块（`gaplessConstants.ts` / `seamlessJoinController.ts` / `gaplessTransition.ts`，共 413 行），hook 只剩调用接口（净减 254 行）；行为等价（lint 0 / 111 用例 / build 通过）。后续改无缝逻辑优先改 `src/services/gapless/`
- 2026-08-14：**UpNext 弹窗修复** —— gapless 启用时「即将播放下一首」通知不显示（`transitionStartTime` null 无 fallback），改为回退 `duration` 倒计时；**EPIPE 防护**（stdout/stderr 管道关闭时主进程不再崩溃）；**版本号更迭机制**（`npm run version:*`）
- 2026-08-14：**音效模块全面升级** —— 可叠加模型 + 快照式场景方案（覆盖/保存确认）、混响类型切换、动态压缩、夜间模式、频响补偿（与 EQ 互斥）、响度归一化（独立 loudness_server.py 端口 3003）、导出 WAV 与实时链共享 `buildEffectChain`（修漂移）；调音室 UI 改版（场景区 + 独立开关）；单测 111→119
- 2026-08-15：**十项需求修复（用户反馈驱动）** —— ①频响补偿开关触发设计（此前 enabled 变化不重新设计 → 100% 音量回退增益为 0、开关无效）；②夜间模式重设计：tanh 波形整形（谐波炸音）→ 动态压缩 + 高频衰减（深夜语义）；③音效与频响补偿互斥（开补偿关全部 7 音效）；④三入口拉起 3003/3004；⑤重低音场景关闭全景声厅；⑥调音室「恢复默认」+「清空均衡器」按钮；⑦场景 EQ 统一专业 10 段（含 heavy-bass/flat）；⑧3D 环绕开启时展开子设置横条（速度/近远/角度）、关闭自动收缩；⑨v2 效果卡片改 v1 式「使用/已启用」大按钮；⑩gapless 方案弹窗（`GaplessModeToast.tsx`，右上角 top-16 right-6，显示直接拼接/60ms 淡入淡出/albumGapless 交叉淡化）；另：设置关于页新增开发者 IceFire_Icer；服务就绪弹窗（3003/3004 health 检测）
- 2026-08-14：**音效引擎 v1/v2 双版本** —— 本地增强版定为 v2（`src/services/audio-effects-v2/` + `MixingStudioV2.tsx`），远程原版恢复为 v1（`src/services/audioEffects/` + `MixingStudio.tsx`，默认）；`audioEngineVersion.ts` 记录选择（localStorage）；调音室头部 v1/v2 切换 → 热切换（暂停→换链→恢复）或冷切换（未就绪时下次启动生效），右上角 2s 切换弹窗；两引擎 dispose 全断 masterGain + 摘 soundtouch/limiter 防并联打架；响度归一化/频响补偿按 v2 路由
- 2026-08-14：**频响补偿升级** —— 新增独立服务 `compensation_server.py`（端口 3004，`/compensation` 端点）：目标曲线 = ISO 226 等响度自适应（按系统音量）+ 场景预设（flat/bass/vocal/warm/bright/night）+ 自定义频段，离散为多段 Biquad 链（lowshelf/peaking/highshelf）；前端 `compensationService.ts` 调 3004 并按 mode+preset+volume 档位缓存，服务不可用回退内置近似；三启动入口（dev-electron.mjs / main.cjs / start-full.bat）同 3003 模式拉起；**算法重写（081401/081402 方法论）**——修复旧实现 ISO 226 数据表错误（全频段 ±12dB 钳制）与多 peaking 级联过冲（1kHz 被拉到 +5dB），改为简化等响度公式（音量→SPL 线性映射）+ shelf 结构（LowShelf 120Hz / HighShelf 12000Hz，防中频污染），数值验证 1kHz 级联响应 0.00dB；与响度归一化（3003）互斥/解耦
- 2026-08-14：**遥控器 / SongDetail / 模式切换重构 / QQ 音乐修复（远程会话）** —— 合并为提交 `3c2fc6a`：
  - **遥控器**（新增 `desktop/remote-server.cjs`、`desktop/remote-ui.html`、`src/components/RemoteControlModal.tsx`、`RemoteControlSettingsModal.tsx`、`RemoteCursor.tsx`）—— 手机扫码 → 局域网 WebSocket 控制 + 虚拟鼠标 overlay（合成点击/右键/hover、6s 自动隐藏）。
    - 改 `desktop/main.cjs`：遥控 IPC（start/stop/get-status/get-settings/update-settings）+ 控制桥 + 光标事件 + 快照补 `volume`/`muted`；
    - 改 `desktop/preload.cjs`：新增 `window.electron.remote`；`src/electron.d.ts`：补 `remote` 类型；
    - 改 `src/App.tsx`：控制桥扩展（seek/volume/mute/back/home/show-song/show-comment/show-artist）+ 渲染 RemoteControlModal/RemoteCursor/SongDetailModal；
    - 改 `src/components/ExploreView.tsx` / `HomeView.tsx` / `DesktopView.tsx`：三模式各加遥控按钮（搜索按钮左侧）；`SettingsPanel.tsx`：个性化新增「远程遥控器」节；
    - 改 `package.json` + `package-lock.json`：新增 `ws`、`qrcode.react`。
  - **SongDetailModal**（新增 `src/components/SongDetailModal.tsx`）—— 歌曲详情弹窗；改 `SongContextMenu.tsx`（右键「查看歌曲详情」）、`PlaybackRadialMenu.tsx`（8 方向 + 左上「查看详情」）、`App.tsx`（监听 `waveforge:show-song-detail`）。
  - **模式切换重构** —— `App.tsx` 抽 `applyMode()` + `.catch` 兜底，修正事件名 `viewModeChange` → `viewModeChanged`。
  - **desktop 快照扩展** —— `src/desktop-lyrics/DesktopLyricsApp.tsx` / `src/desktop-player/DesktopPlayerApp.tsx` 的 DEFAULT_STATE 补 `volume`/`muted`/`page`。
  - **QQ 音乐**（`local-server.mjs`）—— 收藏歌单旧接口 `fcg_qm_order_diss.fcg` 由 GET 改为 POST + 表单体（实测 `qqmusic_key` 返回 `code 0` 成功）；AI 歌单详情逐首 `qqSongDetail` 补封面/时长；歌曲详情时长毫秒÷1000 + 音质徽章/音质行。
  - **PlaylistDetailPanel** —— 新增「收藏/已收藏」按钮（`subscribePlaylist`）。
- 2026-08-14：**完整浅色模式（远程会话）** —— 播放页/简约首页/探索模式全表面浅色落地（桌面模式不生效）；设置-个性化新增深浅色开关（`localStorage.playerTheme` + `playerThemeChanged` 事件 + `<html data-wf-theme>`）；修复 2 个交互 bug（「即将播放」提示不再关闭用户面板、首页自定义 BlurAdjustModal 因 SettingsPanel 卸载被销毁 → 改为保持挂载）；60+ 探索 token 集中 CSS 映射。
- 2026-08-16：**歌词逐字渲染修复 + 新增「Apple」逐字模式**（提交 `69f1145` / `58a6037` / `96dd182`）：
  - **逐字"灰闪/敲击感"根因修复**：词唱完瞬间 `blur(0.5px)` + 填充层卸载 + 基础层变色叠加导致灰闪；修复 = 移除唱完 blur、辉光 180ms 平滑过渡、**唱完后填充层保留为纯白不再卸载**（基础层转透明+去阴影，避免叠字/显厚）、填充层垂直居中对齐基础层文字（消除叠印错位）。
  - **延音（sustainGlow）收紧**：触发门槛（相对倍数 1.5/1.7→1.7/2.0、超出毫秒 430/480→600/650、绝对下限 1050/1100→1300/1400、每行上限 25%→15%）+ 辉光强度减弱（半径/alpha 降约 30%、brightness/saturate 系数下调）。
  - **新增独立「Apple」逐字模式**（`WordByWordEffectMode` 加 `'apple'`，QuickSettings 三选一：清晰/柔和/Apple）——**严格隔离，不影响 clear/soft 任何渲染路径**：词内从左到右填充推进（逆向 LyricsBlossom「整行高亮重绘」）、行字号/字重统一不缩放（已播/正在播/未播等大）、非当前行常驻模糊 blur(2.2px)（手动滚动时暂时取消、0.45s tween 过渡恢复）、SF Pro 风格字体链、已唱空格连续白、中文逐字/英文整词。
  - **相关逆向工作**：LyricsBlossom（Apple Music 1:1 还原，闭源）二进制逆向完成架构级分析（SDL3+Skia+Vulkan、SMTC 数据管线、TTML 逐音节、SF Pro 字体链、行切换 blur 机制），工具/反汇编/分析文档在 `D:\opencode\LyricsBlossom-re\`，接力交接文档在桌面 `LyricsBlossom逆向交接.md`；对比分析见 `docs/歌词对比-LyricsBlossom.md`。
- 2026-08-16：**QQ/网易云 API 全面补齐 + 社交/个人中心重构（本会话）**：
  - **QQ MV 播放修复**：`/api/qq/mv/url` 弃用 qq-music-api 库版（缺认证字段返回空），改为**直接调 `GetMvUrls`**（完整 comm + tmeLoginType + request_typet，实测返回免费流 URL）；VIP 专属 MV 仍受限（平台限制）。
  - **QQ 关注歌手逆向成功**：网页版 JS 逆向出正确接口 `Concern.ConcernSystemServer/cgi_concern_user_v2`（param: `{ opertype: 1关注/0取关, source: 0, userinfo: { usertype: 1, userid: mid }, encrypt_singerid: 1 }`），后端已按此修正（原用错误的 cgi_add_concern + opertype 2）；**认证必须用最新登录的 qm_keyst**（旧 cookie 返回 1000）。
  - **QQ/网易云关注与粉丝列表**：QQ 用 `music.concern.RelationList`（GetFollowList/GetFansList，param `{ From, Size, HostUin: encUin }`，支持 EncUin 查他人）；网易云 user/follows、user/followeds；关注/回关（QQ `cgi_concern_user_v2` usertype=0 + EncUin；网易云 `follow_user`），按钮三态（已关注/回关/关注，按"TA 是否关注我"判断——加载自己的粉丝集合比对）。
  - **QQ 用户个人中心（查看他人）**：ProfileView 增加 **viewStack 导航栈**——点关注/粉丝里的用户 push 进入对方个人中心（复用 ProfileView，网易云完整歌单/关注/粉丝；QQ 显示关注/粉丝/用户信息，歌单受限）；返回箭头 pop 上一级、小字「点击返回个人中心」（≥2 层显示，hover 红）清栈回自己的粉丝界面、点弹窗外清栈；网易云他人完整可查，**QQ 他人歌单/我喜欢歌曲受限**（EncUin 打码无法解析数字 uin，已穷尽接口）。
  - **QQ 我喜欢（他人）**：`music.favor_system_read/get_favor_list_byid`（EncUin 支持，fav_type=1 作品/专辑）→ `/api/qq/user/favs` + 个人中心「我喜欢」tab。
  - **API 死代码补齐**：网易云关注/回关用户、收藏专辑（`getSubscribedAlbums`）、关注歌手（`getSubscribedArtists`）、QQ 收藏专辑（`/api/qq/album/sublist`）、QQ 关注歌手（RelationList 过滤歌手，`/api/qq/artist/sublist2` 替代需 skey 的 fcg）、网易云热评（CommentModal hotComments 区块）、QQ 搜索联想（smartbox `searchQuick`）、**歌单搜索**（网易云 type=1000 + QQ t=2，SearchPanel「搜歌单」）、**私人 FM**（探索页顶部按钮）、**智能播放**（歌单详情按钮）。
  - **探索页新增**：双平台首页 Banner 轮播（网易云 `/api/netease/banner` + QQ `/api/qq/banner`）、网易云电台（dj/recommend/catelist/hot）、热门歌手/新碟/MV 榜/歌单分类/精品歌单/相似歌单/相似 MV/每日签到/歌曲百科/QQ 歌曲所在歌单/网易云收藏 MV（后端路由全部就绪，前端 Banner/签到/百科/所在歌单/收藏 MV 已接入）。
  - **修复**：QQ 排行榜速览歌曲封面为空（官方榜单 songs `coverUrl` 硬编码空 → 复用 community 数据补封面）；后端 `qqMusicApi.api('playlist/hot')` 死调用（QQ SDK 无此路由）改用 `songlist/list`；歌手详情「播放全部」按钮 `text-slate-950` 硬编码黑字 → `text-white`。
  - **新增后端路由**（一批）：`/api/qq/banner`、`/api/qq/song/playlist`、`/api/qq/songlist/category|list`、`/api/qq/album/sublist`、`/api/qq/artist/sublist2`、`/api/qq/user/favs`、`/api/qq/user/profile`、`/api/qq/user/subscribe`、`/api/netease/banner`、`/api/netease/playlist/hot|catlist|highquality|simi|related`、`/api/netease/top/artists|album|mv`、`/api/netease/artist/list`、`/api/netease/dj/recommend|catelist|hot`、`/api/netease/daily/signin`、`/api/netease/song/wiki`、`/api/netease/simi/mv`、`/api/netease/mv/sublist`。
  - **新建组件**：`MVExploreModal.tsx`（MV 分类浏览+搜索，探索页顶栏 Film 入口）、`UserProfileView.tsx`（查看他人全屏个人中心，后被 ProfileView viewStack 替代为内部切换）、`UserProfileModal.tsx`（临时弹窗，已被 viewStack 取代）。
  - **使用注意**：所有 QQ 关注/粉丝/主页接口**必须用最新登录的 qm_keyst**（应用内重新粘贴 QQ cookie，旧 key 返回 1000/空）；QQ 他人创建歌单/我喜欢歌曲/评论回复/听歌排行为平台限制。
- 2026-08-16：**多轮性能优化（12 个 commit：`1c8ef0c`~`6acf49c`）** —— 详见 §5 性能优化记录：渲染降频（三视图/弹窗/列表行组件 memo + latest-ref 稳定回调、过渡 30fps 节流、歌词/频谱/脉冲 rAF 门控）、react-window 虚拟化（评论变高行/艺人定高行）、内存治理（8 处缓存上限、引擎 dispose 清引用、队列裁剪、IndexedDB 写幂等+修剪节流）、传输（封面流式转发、gzip、keep-alive、遥控器增量广播）、首屏/启动（leaflet 懒加载、vendor 拆分、主入口 -23%、analysis 延迟初始化）、Python 服务（缓存清理节流、向量化、磁盘缓存）、cookie 单事实源（并发播放/写操作不再互相冲登录态）。
- 2026-08-16：**回归审计 + 修复（commit `d1b5e5f`）** —— 用户反馈"功能不对"后系统性语义核对（4 个并行审计代理 + git 对照原实现）：修复队列裁剪闪白、NotAllowedError 静默、MV/关注歌手 cookie 三处回归；环境层根因是 **ReWaveForge Go 后端抢占 3001**（见 §2 端口坑）。修复后 lint 0 / 152 用例 / build 通过，便携版 v0.1.2 冒烟验证（四服务 200、数据非空）。
- 2026-08-16：**融合远程 lyrics-apple 分支（fast-forward 到 `050d315`）** —— Android TV（`android/` + `src/tv/`，`build:android`/`fetch:nodejs-mobile`/`publish:release` 脚本）、Apple 歌词/探索分支（`AppleCoverFx`/`AppleExploreView`/`AppleLoginPanel` + `appleAuth`/`appleCatalog`/`appleMusic`）、探索页设置重构/封面墙背景/歌曲详情增强、compression 依赖。零冲突合并，本地性能优化与回归修复全部保留。
- 2026-08-16：**音效引擎 v3 融合（本会话，外部 AI 产出的独立模块 `temp/waveforge-engine-v3` 已迁入）** —— 落位 `src/services/waveforge-engine-v3/`（src 引擎 / ui 调音室 / test 313 用例 / vendor soundtouchjs LGPL 原包副本 / docs 融合文档）。接线：`audioEngineVersion.ts` 加回 'v3'（旧机型预设版的存储键仍清理，新 v3 用 `waveforge:v3-*` 命名空间）；新建 `attachV3Engine.ts` 融合层（EngineV3Host 单例 mode auto + workletUrl './v3-worklet.js'、参数持久化 `waveforge:v3-params`（深合并容错）、UI 桥包装——worklet 模式下 setParams 双下发主线程引擎与 worklet、getStats 优先 worklet 回传、系统音量 `setV3SystemVolume` 注入等响度补偿、听力测试 'v3HearingPlay' 正弦合成、离线 WAV 导出复用同内核分块处理）；App.tsx（graph-ready/switchAudioEngine 三版本分支、调音室三路 lazy 渲染、v1/v2 调音室头部加 v3 按钮）；worklet 打包 `scripts/build-v3-worklet.mjs` → `public/v3-worklet.js`（55KB，predev/predev:electron/prebuild 自动执行）；vitest include 扩展 + jsdom/@testing-library devDeps（UI 冒烟 9 用例）。**可选依赖（soundtouchjs/signalsmith-stretch/meyda）刻意不装**：零静态 import、运行时无调用方，变速变调默认自研相位声码器，5 个 LGPL 用例 skipIf 自动跳过；如需启用：`npm install ./src/services/waveforge-engine-v3/vendor/soundtouchjs --save-optional`。宿主环境适配两处：integration.test.ts（setup.ts 全局 AudioWorkletNode 桩以 undefined 覆盖）、audit-chain.test.ts（vitest 4 同步长测试 5s 超时 → 30s）。
- 2026-08-16：**v3 试用反馈五项修复（用户实测驱动）** —— ①变速变调失效：v3 引擎链内 Stretch 为离线语义不内联实时主链，融合层 `attachV3Engine.ts` 接入 SoundTouch 前置链（masterGain → SoundTouch → v3 节点，`@soundtouchjs/audio-worklet` 与 v1/v2 同款；pitch 激活时按需接线、关闭即撤除恢复直连、竞态/上下文重建防护；离线 WAV 导出用引擎 getStretch() 同参数一次性处理保证与实时一致）。②混响轻度炸音：ReverbSimple 湿路 4 comb 直接求和（无补偿）峰值可达输入 2-3 倍，wet0.3+dry0.7 即削波——湿路 ×0.25 补偿；保留混响的 5 个场景 wet 上调补偿听感。③场景混响泛滥：11 场景原全带混响，现仅空间类保留（古典/爵士/现场/浩渺/悠扬舞台），流行/摇滚/舞曲/录音棚/温暖/深夜低音改干声（disableReverb），每场景混响参数按空间语义独立设定。④分析页频谱静止：worklet 模式主线程引擎不接触音频流，AudioEffectsProcessor 现随 stats 一并回传 analysis（spectrum+features），EngineV3Host 新增 getLastAnalysis()/getAudioNode()，桥 getAnalysis 优先取 worklet 回传。⑤gapless 方案弹窗改仅开发者调试显示（`isVerboseLogEnabled()`，localStorage 'waveforge:verbose-log'='1'，与详细日志同开关）。另：eqPanel 顶部加场景-EQ 联动说明（场景=含 EQ 的整包快照）。全部改动后 lint 0 错 / 474 用例（469 过 + 5 LGPL 跳过）/ build 通过。
- 2026-08-16：**自动切歌封面不更新——真正根因（`appleCoverUrl` 残留）** —— 先前判断（CrossfadeBackground 动画回调丢失）有误，已纠正：`displayCoverUrl = appleCoverUrl || currentTrack.coverUrl`，Apple 封面优先开启后，三个切歌路径只有 `loadAndPlaySong`（手动/普通）会 `setAppleCoverUrl(null)` + `resolveAppleCover()`；**gapless 自动切歌（`commitPreparedSong`）与 albumGapless handoff（`handlePlayAt`）漏清** → `appleCoverUrl` 残留旧歌封面，自动切歌后 displayCoverUrl 恒为旧图（手动切歌正常、自动切歌失效，即用户"原来好好的"根因）。修复：两处自动切歌路径补齐 `setAppleCoverUrl(null)` + `resolveAppleCover(normalizedSong)` 并加入 deps。CrossfadeBackground 的 1.2s 定时器兜底提升保留（幂等，额外保险）。lint 0 / 469 测试全过。
- 2026-08-16：**场景预设音量下降修复 + 分析页链路核查（本会话）** —— 实测量化：场景压缩器无 makeup 增益，输出 RMS 相对基准（-9dBFS）最多降 **-13dB**（night-bass）/ -10.3dB（rock）。修复：按各场景压缩量补 makeup（pop 5 / rock 13 / jazz 4 / dance 4 / classical 1 / livehouse 3 / studio 4 / warm 5 / dts 2 / vocal-stage 0 / night-bass 15），复测全部回到 Δ-1.6 ~ +2.6dB。**分析页核查结论：链路正常**——引擎侧 process 后 getStats/getAnalysis 数据新鲜（spectrum 1025 bins、features.rms、LUFS 读数合理；双声道同相 1kHz ≈ +3 LUFS 实测 4.1 正确）；EngineV3Host worklet 回传链路单测通过（模拟 worklet 节点回传 stats+analysis，宿主正确暴露）；UI 轮询 300ms / worklet 每 ~80ms 回传。此前"频谱不动"是旧版 worklet 不回传 analysis 的问题，已在五项修复轮解决。lint 0 / 469 测试全过。
- 2026-08-16：**v3 立体声宽度/智能均衡（IEQ）核查与修复（本会话）** —— 实测脚本验证（后删）结论：**立体声宽度（M/S）一直正常**（width=1 逐样本恒等 / width=2 侧信号 ×2 / width=0 单声道，关 limiter 验证），此前的"失效"感来自测试未关 limiter 的干扰；**智能均衡（IEQ）确有两个真实 bug**：①`feedAnalysis` 单次 process 只触发一次分析（`% W` 取模而非循环递减）——大块喂入（离线导出/一次性处理）会丢掉中间窗，IEQ 增益只走一小步（4s 大块仅 1 次分析、收敛到目标的 1/7）；修复为 `while (pos >= W)` 逐窗触发。②频段电平用线性幅度平均（稀疏频谱把尖峰稀释到接近噪声底，驱动增益在 ±12 clamp 间振荡）+ 分析取样点在 IEQ 之前（开环：增益只增不减推到过冲）；修复为 RMS 能量平均 + -80dB 噪声底 clamp，取样点移到 IEQ 处理后形成闭环。验证：双频信号 warm 抬 200Hz/压 4kHz 比 8339、粉红噪声收敛无振荡、白噪声（病态平谱）修正有界无 NaN；M/S 三项 + IEQ 四项共 7 项断言全过。改动后 v3 测试 317 过 / 5 跳过、审计 124 全过、lint 0。
- 2026-08-17：**音频引擎统一适配层重构（本会话）** —— 新建 `src/services/audio-engine/`（`types.ts` 统一接口 `IAudioEngineAdapter` + `GenericMixingStudio.tsx` 通用调音室骨架 + `V1Adapter.tsx`/`V2Adapter.tsx`/`V3Adapter.tsx` 三适配器 + `index.ts` 工厂注册表）。App.tsx 消掉 **7 处版本分支**（import 5 个引擎相关 import→1 个 `getEngineAdapter`；v1EngineRef/v2EngineRef→engineAdapterRef；handleAudioGraphReady 三分支→`adapter.attach`；系统音量 effect v1 守卫+v2/v3 分支→`capabilities.supportsSystemVolume`+`adapter.setSystemVolume`；响度归一化 effect v2 守卫→`capabilities.supportsLoudnessNormalization`；switchAudioEngine 三分支 dispose+attach+v2 补归一化→`adapter.dispose`+重建 adapter+`adapter.attach`+`adapter.applyLoudnessNormalization`；切歌 v2 归一化→`adapter.applyLoudnessNormalization`；调音室三分支渲染→`adapter.renderStudio`）。**UI 双模式**：`studioMode: 'custom'`（引擎自带 UI 连外壳，v1/v2/v3 都是）或 `'generic'`（无 UI 引擎用 GenericMixingStudio，通过 `IAudioEngineUiBridge` 驱动参数读写/导出）。v2 响度归一化外部服务调用 + 低音量提示从 App.tsx 剥离到 V2Adapter（`applyLoudnessNormalization`/`resetLoudnessNormalization`/`setSystemVolume` 内触发 toast）。v3 导出状态上提到 V3Adapter（`onExportingChange` 事件驱动 App 重渲染）。App.tsx 不再直接 import 任何引擎类/自由函数（grep 验证零残留）。**未来接入 v4**：写 `V4Adapter.tsx` 实现 `IAudioEngineAdapter`（custom 模式自带 UI 或 generic 模式用通用调音室）+ `index.ts` 注册表加一行，App.tsx 零改动。验证：lint 0 错误 / 469 测试全过 / build 成功。
- 2026-08-18：**哔哩哔哩「看歌」模式（本会话，计划已批准）** —— 第 7 种歌词显示模式 `'video'`（看歌）：选中歌曲后自动从 B 站搜索匹配 MV/官方视频并播放，视频自带声音与字幕（官方字幕即歌词）。核心点：
  - **登录硬门槛**：未登录 B 站 → 看歌模式完全不可用（整面登录门 + 设置→账号卡片扫码登录），避免低画质试看/频繁弹登录/拿不到视频。登录态 `bilibili_cookie` 存 localStorage（启动自动恢复）+ 后端全局单事实源，SESSDATA 约 30 天有效（`wf_login_expiry_bilibili` 记录）。
  - **匹配算法**（`src/services/bilibiliApi.ts`，16 个单测）：硬淘汰"规范化歌名未完整出现在标题"；打分=歌名完整命中/歌手/官方标记/翻唱教学负向/时长贴近/播放量对数 + TOP-3 复审（view 作者认证 + CC 字幕）；**双重自动播放门槛**（score≥230，或 ≥150 且有官方标记/认证/人工中文字幕），低置信绝不硬放 → 候选确认列表（音频照常播，用户点选即播且按歌记忆）。
  - **后端** `server/bilibili-api.mjs`（local-server.mjs 仅 import+注册 3 行）：WBI 签名搜索、view、playurl（登录解锁 1080p、大会员专享降级/跳过）、**流代理 `/api/bilibili/stream`（按缓存 key 取内部 URL，带 Referer + 透传 Range 支持 seek，无 SSRF 面）**、CC 字幕（`x/player/wbi/v2` + JSON 代理）、扫码登录（qr generate/poll 抓 SESSDATA）。**字幕接口为"实现时验证"项**：实测 `x/player/wbi/v2` 路由可用（对无字幕视频返回空列表属正常），字幕 JSON 代理走同一 fetch 链路；失败时前端静默降级不渲染字幕条。
  - **协调**：视频播放中音频引擎暂停（视频为唯一时间线）、视频 ended → 正常切下一首、未找到/搜索中引擎出声兜底；全局播放/暂停键在有活动视频时经 `watchPlayerRef` 转切视频。已知取舍：看歌中切回歌词模式，引擎从暂停点恢复（≈歌曲开头），位置不完全衔接（换取不改 gapless/无缝链路）。
  - **繁简归一化**：B 站官方标题常用繁体（周杰倫），匹配前经 `opencc-js/t2cn`（vite.config.ts 别名表加了精确命中 `opencc-js/t2cn` 的白名单项，置于 `opencc-js→cn2t` 兜底之前，顺序敏感）。
  - 验证：lint 0（本会话代码；当前工作区另有其他 AI 的 Spotify/Kugou/Soda 并发改动，SettingsPanel 的 3 个 `Music` 未导入错误属对方在途）、485 用例（+16 新）、build 成功、真实 B 站数据端到端验证（稻香→confirm 候选不硬放 ✅ / Rick Astley 官方→auto ✅，playurl 720p 未登录正常）。
- 2026-08-18（续）：**看歌模式「举一反三」扩展轮（本会话）** —— 自定义性 + 匹配机制加强：
  - **看歌设置**（`BilibiliWatchSettingsModal.tsx`，播放器顶栏齿轮进入；`bilibiliApi.ts` 的 `BilibiliWatchSettings` localStorage 持久化 + `bilibili-settings-changed` 事件）：匹配偏好（官方MV/均衡/现场版/歌词字幕/高清）、自动播放门槛（严格/标准/宽松）、视频结束行为（下一首/重播/停在末帧+重播按钮）、目标画质（auto/1080P/720P/480P）、字幕语言偏好（人工中文/中文/任意/关闭）+ 字号滑块、搜索关键词模板（auto 按偏好组合/固定/自定义占位符 `{title}/{artist}`）、记住选择开关、控件自动隐藏开关。
  - **匹配引擎加强**：偏好感知多查询（官方/现场/歌词/4K 补搜，各前 2 页召回）+ **搜索排名加权**（B 站相关度顺序，`max(0,15-rank)*0.8`）+ **相对时长匹配**（比例而非绝对差，长歌不受损）+ **候选类型分类**（官方/现场/翻唱/演奏/字幕/其他，`classifyCandidateType`）+ **偏好加权**（`preferenceAdjustment`，偏好可真实改变排序）+ **官方频道关键词表**（杰威尔/索尼/环球/华纳/滚石…作者命中 +25）+ 复审扩到 TOP-5 + **全局 bvid 复审缓存**（view/字幕跨歌曲复用 1h）+ **播放失败自动回退链**（`fallbackChain`：-404/大会员受限/加载失败自动试下一候选，不卡错误页）+ **黑名单**（顶栏「不喜欢」→ 该歌黑名单该 bvid 并自动换下一个）+ 近重复标题去重（保留播放量最高）+ **缓存键隔离设置指纹**（偏好/门槛/模板不同不串缓存——修复了 live 偏好命中 balanced 缓存的 bug）。
  - 类型徽章 + 候选筛选 chips（全部/官方/现场/翻唱/演奏/字幕/其他）在确认态与更换视频浮层可用。
  - 验证：单测 37（+21 新增，覆盖类型识别/偏好加权/门槛三档/相对时长/排名/频道关键词/模板/去重/黑名单/字幕偏好）、全量 506 过、build 成功、真实 B 站数据 e2e 复测（稻香 balanced→confirm 候选全为稻香相关 ✅、稻香 live 偏好→top-5 含现场类 ✅、NGGYU→auto ✅）。
- 2026-08-18（续二）：**B 站个人主页（个人中心）** —— 登录后进入自己的 B 站主页（收藏夹/观看历史/我的投稿/关注四个 tab），支持从关注列表点入他人主页（viewStack 导航栈，公开资料+投稿可查，未登录/未公开显示提示）：
  - **后端新增路由**（`server/bilibili-api.mjs`）：`/api/bilibili/space/acc`（card 接口，比 space/wbi/acc/info 宽松，未登录可查他人资料）、`/api/bilibili/space/videos`（WBI 投稿列表，-352 风控自动重试一次，buvid3+buvid4 指纹打底）、`/api/bilibili/fav/folders` + `/api/bilibili/fav/list`（收藏夹，B 站现要求登录才返回）、`/api/bilibili/history`（观看历史，含进度续播）、`/api/bilibili/followings`（关注列表，需登录）。注意：收藏夹/历史/关注现为登录接口（B 站侧收紧），**看歌本身要求登录**故本人主页全功能可用；未登录后端返回 401（code:-101）前端显示登录引导。
  - **前端组件**：`BilibiliProfileModal.tsx`（个人主页弹窗：头像/昵称/等级/大会员徽章/认证徽章/签名 + 关注·粉丝·投稿·获赞统计行；四 tab 按需加载；历史项显示观看进度条）、`BilibiliVideoPlayerOverlay.tsx`（全屏 B 站视频播放器：bvid→view→playurl→流代理，带 CC 字幕/续播进度/重播/全屏，支持「设为当前歌曲 MV」写 override）。
  - **入口适配**：看歌界面顶栏登录态头像按钮 + 登录门「进入我的哔哩哔哩」按钮（均携带当前歌曲上下文，播放浮层可一键设为该歌 MV）；设置→账号 Tab B 站卡片「个人中心」按钮。
  - 验证：tsc 0（本会话代码）、全量 509 过、build 成功、后端路由 curl 冒烟（acc/videos 正常、未登录 history/followings 401、fav 空态）。

## 7. 常用操作速查

```bash
# 开发
npm run dev:electron          # 完整开发环境
test-python-service.bat       # 检查节拍服务 3002

# 验证
npm run lint                  # 类型检查
npm run test                  # vitest 单测（12 文件 / 152 用例）
npm run build                 # 生产构建
npm run test:license          # 设备授权自测
./resources/python-embed/python.exe -m pip install --no-index --find-links=python-beat-service/packages --dry-run -r python-beat-service/requirements.txt  # 验证离线安装可解析

# 版本更迭
npm run version:patch         # 0.1.0 -> 0.1.1（自动 commit/tag/push）
npm run version:dry           # 预览更迭（不落地）

# 运行时重建
npm run bundle-python         # 重建嵌入式 3.13.15（需联网）

# Android TV（多平台分支）
npm run fetch:nodejs-mobile   # 拉取 nodejs-mobile 运行时
npm run build:android         # 生成 Android 前端资产（vite.android.config.ts）

# 爱发电赞助名单
npm run sync:sponsors         # 手动刷新 src/data/afdianSponsors.generated.json

# 发布（⚠️ Releases 只发 NSIS 安装版，不发便携版 win-unpacked/）
npm run build:electron        # 构建安装版 release/WaveForge-<version>-Setup.exe
git tag v<version> && git push origin v<version>
gh release create v<version> release/WaveForge-<version>-Setup.exe --title "v<version>" --notes "changelog"
# 安装版每用户安装、不携带用户数据；用户配置生成于各机 %APPDATA%\WaveForge 澜音工坊\

# 回滚
git log --oneline             # 查看历史；git reset --hard <sha> 回退
```
