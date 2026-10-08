# WaveForge 交接文档

> 给接手本项目的开发者或 AI 代理的交接说明。包含：项目当前状态、环境、已知问题、未决事项、历史决策摘要。
> 面向"接下来要干活的人"，读完本文档 + `AGENTS.md` 即可上手。

---

## 1. 项目状态（2026-08-18）

- **阶段**：功能完整，处于维护/优化阶段。核心功能（双平台搜索/播放/歌词/无缝衔接/桌面模式/壁纸联动）均已实现；**多平台分支**（Android TV、Apple 歌词/探索）已合入。
- **代码基线**：当前 HEAD `97b6812`（2026-08-18，远程 master 同点）。近三日主线：v3 引擎融合 → 统一适配层 → HSE 调音室 UI 重设计 → 分析页修复 + 低音下潜 + 音量跟手/独立于场景。
- **稳定性**：`npm run lint` 0 报错、`npm run test` **41 文件 / 472 过 + 5 跳过（v3 LGPL 可选依赖用例，未装属设计行为）/ 共 477 用例**、`vite build` 成功、便携版（win-unpacked）启动冒烟通过（四服务 3001-3004 全 200、首页推荐/热歌榜数据非空）。
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

> ⚠️ 历史文档中 5001 均为过时信息；`launchers/test-python-service.bat` 已修正为 3002。响度服务 3003、频响补偿服务 3004 均独立于节拍服务：dev 由 `dev-electron.mjs` 拉起、打包版由 `main.cjs` startLocalBackend() 拉起、手动可用 `launchers/start-full.bat`。

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
- 2026-08-14：**频响补偿升级** —— 新增独立服务 `compensation_server.py`（端口 3004，`/compensation` 端点）：目标曲线 = ISO 226 等响度自适应（按系统音量）+ 场景预设（flat/bass/vocal/warm/bright/night）+ 自定义频段，离散为多段 Biquad 链（lowshelf/peaking/highshelf）；前端 `compensationService.ts` 调 3004 并按 mode+preset+volume 档位缓存，服务不可用回退内置近似；三启动入口（dev-electron.mjs / main.cjs / launchers/start-full.bat）同 3003 模式拉起；**算法重写（081401/081402 方法论）**——修复旧实现 ISO 226 数据表错误（全频段 ±12dB 钳制）与多 peaking 级联过冲（1kHz 被拉到 +5dB），改为简化等响度公式（音量→SPL 线性映射）+ shelf 结构（LowShelf 120Hz / HighShelf 12000Hz，防中频污染），数值验证 1kHz 级联响应 0.00dB；与响度归一化（3003）互斥/解耦
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
- 2026-08-16：**多维（Diorama）歌词模式质感升级（对照 folia 原版，本会话）** —— 用户反馈"展示效果廉价"，按 folia 开源项目的设计语义重做呈现层（镜头/走廊/排版结构不动）：
  - **新增 HDR bloom 后期管线**：`dioramaPostFx.tsx`（three 自带 examples/jsm 的 EffectComposer + RenderPass + UnrealBloomPass + OutputPass，**无新依赖**）；HalfFloat 渲染目标（samples=4 MSAA）让加法混合积累 >1.0 真 HDR，bloom 阈值 0.82 只提白歌词/光晕/星点。Canvas 侧配套 `flat`（NoToneMapping）保证 OutputPass 直出色彩不发灰；useFrame 优先级 1 接管渲染，卸载全量 dispose。
  - **阵型几何换 Fresnel 玻璃着色器**（原哑光 MeshStandardMaterial + 固定灰蓝）：颜色改由封面主色派生（亮/深两档 + 更亮 rim），rim 输出 HDR 供 bloom 提取；几何面数提升（sphere 14×10→26×20、torus 8×20→14×48、cone 12→24）；节拍不再乘整体透明度（闪烁感）改注入 uGlow 呼吸亮边；材质经 `primitive attach` + effect 统一 dispose。
  - **星河粒子**：pointsMaterial 加圆软点 sprite（`dioramaTextures.ts`）+ 加法混合（原为方块点）；**修复粒子域固定世界原点、相机飞远后星河被抛下的 bug**（改粒子域跟随相机位置）；FloorMist 同 bug 同修（地面雾光跟随相机）。
  - **背景天球**：64×512 → 512×1024，渐变加低幅噪声抖动去色带，亮星带径向柔光核。
  - **音频层质感**：节拍环改 billboard 朝相机 + 更细更慢的涟漪衰减（原环平躺世界 XY 面、多数角度只见一条线）；进度光点 → 面向相机的柔光面片（原 0.14 半径实心弹跳小球）；波形河柱更细 + 加法混合；走廊光轨透明度提升。
  - **恢复 folia 原版文字摆放幅度**（cameraPath.ts）：offsetR/U/look 从收敛值 1.0/0.7/0.18 恢复为 folia 原值 1.8/1.2/1.1 —— 找回"空间中的舞台化排版"三分构图（此前收敛成居中提词器观感）；取景安全仍由 frame-fit 缩放 + CameraRig keep-in-frame 保证。
  - **Overlay 去廉价化**（MultidimensionalLyrics.tsx）：移除水印式品牌角标/霓虹菱形/"3D FLYTHROUGH" 标语；编辑式排版头部 + 右下细字重计数；新增电影暗角层。
  - fov 60→55（对齐 CameraRig 注释里的 folia 默认值，更长焦的电影透视）。改动后 lint 0 / 469 测试过（audit-chain 一例为满载并发超时、单独跑通过，与本次无关）/ vite build 通过。
  - **后续微调（用户反馈：字体更立体 + 亮度略降）**：①歌词立体化 = 双层手段——栅格层 bevel（暗底微偏移 + 上亮下暗渐变表面替代纯白平涂，活动行/邻居行同一套语言）+ 3D 深度切片（活动行每个字表面后方叠两层暗色同纹理切片，`TEXT_DEPTH_STEP=0.024`，renderOrder 分层合成，相机环绕/侧视时视差暴露真实字厚；切片透明度随唱读 0.3→1 "生长"）。②亮度收敛 = bloom 0.5/0.82 → 0.35/0.85（radius 0.5）、表面峰值 1.0→0.92、舞台光晕/星云/星河/光轨/地面雾/波形河/节拍环/进度灯全层 -10~20%、背景调色板各档明度 -10%、阵型 rim 1.25→1.1。
  - **短词压扁 bug 修复（用户反馈"扁扁的，in 尤为明显"）**：根因 = 字单元平面用 `advancePx` 建宽、纹理画布实为 `advancePx + 2×pad`（pad=0.7em 光晕留白），UV 整幅映射把字形横向压缩 advance/(advance+180px)——短词压最狠（"in"≈38%、CJK≈42%、长词≈76%），同屏字宽还不一致。修复 = 平面宽度改用 `canvasWidthPx`（活动行 + 邻居行同修）；光晕面片同步去掉 1.15× 放大（与 base 同画布几何，1:1 才能精准套准笔画）。字距不变（cursor 仍按 advance 推进），pad 为透明区仅重叠无副作用；fitScale 按行 advance 测量，修复后 0.72 帧宽占比才真正准确。
  - **逐字点亮辨识度加强（用户反馈"逐字不太明显"）**：未唱色 #dcdce6→**#b8bcd2**、未唱透明度 0.32→**0.22**（压暗），已唱峰值 0.92→**0.96** + **颜色过驱 ×1.12**（越过 bloom 阈值 0.85 → "唱过 = 发光"，与未唱拉开质的差别）；演唱窗口内加 sin 包络亮度强调（×1.12）+ 2.5% 唱读膨胀 + 主题色倾向 0.1→**0.18**（明确"唱到哪"）；逐字光晕 0.008→**0.036**（已唱字一小圈柔光，仍克制）。整体画面亮度不变——只重排歌词自身的对比。
  - **阵型几何整体粒子化（用户反馈"外面飘着的方块不要了，改成粒子效果"）**：`Formation` 网格组件（box/sphere/cone/torus + Fresnel 着色器）删除，替换为 `FormationParticles`——每行歌词一份 Points（geometry + ShaderMaterial）：粒子簇按 `buildFormation` 的形状锚点播种（set-piece 布局/与文字的净空全部继承，积木 → 光尘），每锚点 6-18 粒（按 scale），stretchY 拉长纵向散布；软点 sprite + 加法混合，逐粒闪烁/轨道漂移全在顶点着色器（aSize/aPhase/aMix 属性，CPU 零逐粒工作）；颜色取封面主色两档 rim 色，生命周期透明度沿用 resolveShapeLifeOpacity；geometry/材质命令式创建 + effect 手动 dispose。镜头语言与阵型布局算法（cameraPath.buildFormation）不动——只换渲染呈现。
  - **歌词发光收敛（用户反馈"有的太亮"）**：已唱字过驱 ×1.12→**×1.05**（刚过 bloom 阈值，点亮感保留不炸眼）、演唱窗口 sin 强调 ×1.12→×1.06、逐字光晕 0.036→0.027、舞台光晕 0.05+0.09 → 0.045+0.08 且节拍脉冲系数 3→**2**（修重拍整行光晕炸亮）、bloom 强度 0.35→**0.28**（radius 0.5→0.45）。
  - **歌词亮度三轮下调（用户反馈"还是太高"）——歌词整体退出 bloom 通道**：已唱字**取消过驱**（×1.05→×1.0，峰值亮度 0.78 压到 bloom 阈值 0.85 以下，歌词不再泛光）、已唱峰值透明度 0.96→**0.78**（0.2+0.58）、未唱 0.22→**0.2**、演唱窗口 sin 强调 ×1.06→×1.03、逐字光晕 0.027→**0.022**、舞台光晕 0.045+0.08→**0.04+0.068**。"正在唱"的指示改由主题色倾向（0.18 lerp）+ 唱读膨胀承担，不再靠亮度/辉光。若后续仍嫌亮：改 bevel 渐变顶色 #ffffff → #e9ebf4（dioramaTextRaster.ts），或继续下调 0.58 系数。
  - **走廊两侧光柱改真实频谱（用户反馈"左右的柱子改成频谱，颜色按封面主题色"）**：①`useAudioAnalyzer.ts` 扩展——`AudioAnalyzerData` 新增 `spectrum: Float32Array`（`ANALYZER_SPECTRUM_BANDS=24`，45Hz~12kHz 对数均分，均值 0.62+峰值 0.38 混合后 logCompress；复用既有 30fps 采样的 byte 频谱，EMPTY 为全零）。②`WaveformRiver` 从 bass/mid/high 三档伪频谱改为真频谱：走廊方向 = 频率轴（段首低频 → 段尾高频，相机飞行即"穿过频谱"），柱高快攻慢落（attack 14/s、release 6/s 指数平滑），分析器未启用退化为闲置微光波；颜色 = 封面主色频段渐变（低频深主题色 l0.42 → 高频亮主题色 +0.08 移相 l0.64，能量再推白 ×0.4），加法混合。
  - **封面即天球背景（需求经两轮澄清定稿：用歌曲封面当背景 + 高模糊度）**：coverUrl 从 MultidimensionalLyrics 一路透传到 `BackgroundGradient`；外链封面经 `getProxiedImageUrl`（幂等，/api/cover 代理解决 CORS + 防盗链，画布不被 taint），`crossOrigin='anonymous'` 加载。最终实现：**封面即背景**——天球贴图从 512×1024（1:2）改为标准等距柱状 **1024×512（2:1）**（旧版横向 1.4px/度，封面被球面摊得"看不出轮廓"，此为本轮根因）；封面**铺满画布宽度**（方形封面上下裁切、主体居中），`filter: blur(14px) saturate(1.1)`（软聚焦 + 原亮度，轮廓清晰可辨），封面存在时银河带强度 44→20；封面未加载/失败时封面色系渐变兜底；封面未加载/失败时封面色系渐变兜底；银河带 + 抖动叠加在封面之上保留深空结构；纹理随 palette/coverImage 重建，旧纹理 effect dispose。**教训：首版"低透明度融入"与次版"overlay 调制"均被退回——用户要的是封面本身做背景，只是模糊度拉高**。模糊/亮度旋钮在 BackgroundGradient 封面层 filter 串里。
  - **歌词去描边（用户反馈"不要加描边"）**：`dioramaTextRaster.ts` 两处 `strokeText` 暗描边移除（活动行字单元 + 邻居行整行纹理）——深空背景足够暗，不再需要描边衬底；bevel 暗底偏移与上亮下暗渐变表面保留（那是立体感，不是描边）。
  - **镜头语言去"左右斜"单一化（用户反馈"不是左斜就是右斜太单一了"）**：根因 = CameraRig 阅读对齐**全量继承歌词行的 roll 倾角**（folia 原值 ±11.5°），每行种子倾角被相机照单全收 → 画面退化成左右交替荷兰角。四处联动修复：①CameraRig roll 只转移 **35%**（地平线基本水平，行的舞台倾角留在画面做构图）；②`DIORAMA_TEXT_ROLL` 0.2→**0.09**、YAW 0.16→**0.1**（offsetR/U/look 保留 folia 原值，构图不动）；③shot 幅度整体放大——normal moveScale 1→**1.15**（calm 0.72 / chaotic 1.45），orbit 0.55→0.64、crane ±1.5/2.4→±1.7/2.7、pullBack 升 1.7→2.0、flyby 0.7-1.4e→0.8-1.6e、arc/pendulum/swell/spiral/glide/pushIn/track 同步上调（垂直与纵深镜头更可感）；④选镜权重重平衡——主歌 hold +0.9→**+0.45**、float +0.8→**+0.5**（减少近似静止镜头），crane +0.9→+1.1、新增 pullBack +0.5，副歌 orbit/pushIn/crane 再上调。
  - **字体精美度提升（用户反馈"字体再修一修，更精美一点"）**：①栅格 em 128→**192**（`DIORAMA_RASTER_FONT_PX`，字形更细腻，高分屏/长行缩放不发虚）——**所有世界尺寸换算的 /128 除数已同步改用该常量**（DioramaScene 5 处 + FoliaDioramaLyrics 1 处，grep 验证无残留）；②字体栈重构：拉丁字体前置（SF Pro Display/Text → Segoe UI Variable/UI → Inter），西文歌词用西文字形而非中文字体的西文部分；中文按 PingFang SC → Microsoft YaHei UI/YaHei → HarmonyOS Sans SC → Noto/Source Han 回退（canvas 逐字形 fallback 不影响中文）；③字形表面三档渐变微调（中段提亮 #f3f5fa、底部收敛 #cdd2e2），bevel 偏移/浓度收敛（0.02em/0.52）——立体感更干净不脏；④3D 厚切片配色从固定灰蓝改为**封面主题色压暗系**（side l0.26 / back l0.17，随歌变化）。
  - **频谱双翼替换走廊柱（用户反馈"两边柱子完全改成频谱，不是柱子随频谱动"）**：删除 `WaveformRiver`（沿走廊每 8 单位一根的独立柱子，读作"柱子随频谱动"），新增 **`SpectrumFlanks`**——活动歌词左右两侧各 32 根**紧密排列**（bar 0.09 + 间隙 0.014，无大空隙）的频谱柱阵，内侧低频 → 外侧高频（两侧对称镜像），观感即标准 EQ 频谱分析器；柱高取真实 24 段对数频谱（bandFrac 线性插值上采样到 32 根），快攻慢落（attack 16/s、release 5/s），重拍 beat ×1.35 轻踢；柱阵锚在活动行文字平面之后（depth +0.9、baseline -0.55），随行移动；颜色 = 封面主题色渐变（低频深 l0.42 → 高频亮 +0.08 移相 l0.64），能量推白；闲置时（分析器关）微光波。柱阵随行重建，材质 effect 释放。
  - **星云真实化（用户反馈"背景星云更真实一点"）**：旧"径向渐变+圆 blob 贴片"重写为 **fBM 分形噪声 + 域扭曲**程序纹理——5 倍频 value noise 密度场 × 低频扭曲场（丝状/旋涡结构）+ 阈值对比雕刻（云块与透明空隙）+ 噪声扰动边缘的径向羽化遮罩；448² 白纹理（密度存 alpha，材质色仍随封面主色），4 个变体**模块级缓存跨曲目复用**（旧实现每次切歌重生成）。布局 5→6 层（4 变体复用、大小 46-112、深度 -22~-64、逐层透明度 0.09-0.15）；跟随方式从"钉死相机"改为**滞后 lerp 跟随**（速率 1.1/s）——相机运镜/切歌飞行时云层产生真实视差；逐层 billboard + 慢漂移 + 呼吸透明度。
  - **深空背景二轮真实化（用户反馈"星云的背景不太真实"）**：①贴图星移除，改 **StarShell 3D 星壳**——720 暗星（size 0.62）+ 230 亮星（size 1.35，最亮进 bloom 泛星芒）两层点云，球面均匀分布（cosθ 线性采样）、半径 103-126 刚性跟随相机（无穷远无视差才正确）、无球面极区拉伸、幂分布星等 + 少数暖/蓝星色温、远景星不闪烁。②天球贴图加 **fBM 银河带**（斜贯天球的高斯包络 × 4 倍频团块结构，模块缓存，偏冷白 ×44 亮度），地平线辉光 0.5/0.16→0.38/0.12。③星云纹理烤入**内部冷暖色差**（致密核心暖亮 0.7+0.3w → 边缘冷暗，乘封面染色后仍保留）+ **暗尘埃带**（另一频段扭曲噪声削减密度 ×0.35）。④天空调色板再压暗一档（top 0.15→0.125 等）——深空底色接近黑，星点/星云层次才出得来。
- 2026-08-17：**音频引擎统一适配层重构（本会话）** —— 新建 `src/services/audio-engine/`（`types.ts` 统一接口 `IAudioEngineAdapter` + `GenericMixingStudio.tsx` 通用调音室骨架 + `V1Adapter.tsx`/`V2Adapter.tsx`/`V3Adapter.tsx` 三适配器 + `index.ts` 工厂注册表）。App.tsx 消掉 **7 处版本分支**（import 5 个引擎相关 import→1 个 `getEngineAdapter`；v1EngineRef/v2EngineRef→engineAdapterRef；handleAudioGraphReady 三分支→`adapter.attach`；系统音量 effect v1 守卫+v2/v3 分支→`capabilities.supportsSystemVolume`+`adapter.setSystemVolume`；响度归一化 effect v2 守卫→`capabilities.supportsLoudnessNormalization`；switchAudioEngine 三分支 dispose+attach+v2 补归一化→`adapter.dispose`+重建 adapter+`adapter.attach`+`adapter.applyLoudnessNormalization`；切歌 v2 归一化→`adapter.applyLoudnessNormalization`；调音室三分支渲染→`adapter.renderStudio`）。**UI 双模式**：`studioMode: 'custom'`（引擎自带 UI 连外壳，v1/v2/v3 都是）或 `'generic'`（无 UI 引擎用 GenericMixingStudio，通过 `IAudioEngineUiBridge` 驱动参数读写/导出）。v2 响度归一化外部服务调用 + 低音量提示从 App.tsx 剥离到 V2Adapter（`applyLoudnessNormalization`/`resetLoudnessNormalization`/`setSystemVolume` 内触发 toast）。v3 导出状态上提到 V3Adapter（`onExportingChange` 事件驱动 App 重渲染）。App.tsx 不再直接 import 任何引擎类/自由函数（grep 验证零残留）。**未来接入 v4**：写 `V4Adapter.tsx` 实现 `IAudioEngineAdapter`（custom 模式自带 UI 或 generic 模式用通用调音室）+ `index.ts` 注册表加一行，App.tsx 零改动。验证：lint 0 错误 / 469 测试全过 / build 成功。
- 2026-08-18：**HSE 调音室 UI 重设计（替换非融合，本会话）** —— v3 调音室被 **HyperSoundEngine 风格新 UI 整体替换**：左侧导航 **8 页**（主页/音效场景/均衡器/空间音效/动态调音/分析/调音器/关于）+ 深色琥珀金主题（`hse-theme.ts`，强调色可随 localStorage `accentColor` 联动）+ 真实品牌标志（Hi-Res/DTS:X/Dolby Atmos 徽章白底圆角衬底）+ framer-motion 动效（面板锚点滑入/导航项 hover/页面切换淡入上移）。**关于页**：居中三行（HyperSoundEngine 琥珀金渐变大标题 / WaveForge特供版 / 2026 © IceFire_Icer All Right Reserved）。四轮迭代要点：注册表 displayName 改 HSE（v1/v2 下显示 v3 的根因）、音量滑块改引擎增益通道（v3 无 master volume）、电源键=恢复默认、patch 自动 customized、半透明背景 + logo 白底圆角框。**UI 重设计=覆盖旧组件，勿保留旧实现作并行选项**。
- 2026-08-18：**分析页修复 + 低音下潜 + 音量跟手 + 音量独立于场景（本会话）** ——
  - **分析页三个根因**：①FFT 幅度未归一化（raw bin 值当 dB 用，-47dB 以上信号顶满条、无动态）→ 除 N/4 归一化 dBFS；②线性频率轴（32 条均分 0-24kHz，20-100Hz 低音全挤第一根条）→ 20Hz-20kHz 对数轴 + 标签修正（20Hz/200Hz/2kHz/20kHz）；③UI 300ms 轮询（3.3fps）→ 100ms + EMA 平滑（约 10fps，worklet 每 ~80ms 回传）。读取链路本身正常（worklet 已回传 analysis）。
  - **低音下潜（对比 v2）**：v2 重低音 = lowshelf +11.7dB + 55Hz punch +5dB 真实能量；v3 原只加心理声学谐波（谐波路径 k=0.3，无真实低频）。新增 **`lowBoostDb`（-6..+12dB）**：低通提取低频带按增益混回（lowshelf 语义），场景预设更新（增强 +6 / 舞曲 +6 / 深夜低音 +8 / 温暖 +4 / 流行 +3），分享串编解码同步，调音室弹窗新增滑块；契约测试（白噪声 ±24dB/倍频程）保持全绿。
  - **音量滑块不跟手**：原与自动响度归一化共用 **3s** 平滑常数（防抽吸），手动音量分支改 **80ms**（跟手且无咔哒），自动分支保留 3s。
  - **音量独立于场景预设/组合**：`applyScene` 保留 `loudnessNormalization` 状态（内置 11 场景 + 我的场景统一路径），场景快照不再重置用户音量。
  - 验证：lint 0 / 472 过 + 5 跳过 / worklet 重打包 / 便携版冒烟。
- 2026-08-18：**融合同步 + FusionEntitlements 类型修复（本会话）** —— 远程 4 提交（TV 遥控器/Apple 登录重构/TV UI 缩放）零冲突 rebase；Apple 重构把 `MusicPlatform` 收窄为 `netease|qq|apple` 后 SearchPanel 的 `spotify/kugou/soda` 占位键致 tsc 报错——**按用户要求保留占位键**，改放宽 `FusionEntitlements`（`Record<MusicPlatform, ...> & { [key: string]: ... | undefined }`，已知平台必填 + 开放索引签名）。注意：此前一次"取消"的命令实际已把删占位键的 commit 推上远程（8fb60da），历史保留"先删后恢复"两条，共享仓库不做强推改写。

## 7. 常用操作速查

```bash
# 开发
npm run dev:electron          # 完整开发环境
launchers/test-python-service.bat  # 检查节拍服务 3002

# 验证
npm run lint                  # 类型检查
npm run test                  # vitest 单测（41 文件 / 477 用例：472 过 + 5 LGPL 跳过）
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

## 8. PV 歌词模式（2026-08-27 新增，第 9 种歌词模式 · pv-tool 引擎 + 凝彩式逐字动画 · 全自动）

`lyricDisplayMode: 'pv'`（模式面板显示名「PV」）。**pv-tool 引擎 + 凝彩式逐字动画内核**：保留 pv-tool 模板/特效/节拍体系（不引入 folia tempera），把凝彩的「逐字编排动画」机制做进歌词层，全自动无设置。

**实现**
- `src/components/pvLyrics/PvLyricsPage.tsx`：pv-tool 引擎桥接 + 60fps 编排执行（时钟 seek/暂停精确；ResizeObserver；MV 激活→引擎透明露出 BilibiliMvBackground，无 MV→封面取色铺底）
- 段落编排 `pvDirector.ts`：行间隙中位数×2.5 切段 + sections 定性（intro/breath/passage/chorus/outro），段落级自动换模板（推荐池 + 段落族风格池，相邻不重复）；`engine.fadeToTemplate` 淡出→重载→淡入平滑切换，切换瞬间 glitch/shake 爆发（剪辑切镜）；能量→参数曲线（节拍响应/动画速度/后期滤镜）每帧平滑 + 镜头慢呼吸 + 间奏 bridge 演出
- 凝彩式逐字动画 `effects/wfLyricOverlay.ts`：词级独立对象 + 7 种确定性入场（left/right/above/below/swing/stamp/fade，词内容 seed 派生）+ elastic 弹入（入场窗随句长伸缩）+ 已唱高亮/辉光 + 唱完字距外扩 release + 节拍加成；**无逐字时间戳的歌词用 Intl.Segmenter 分词 + 行时长按字重等分自动合成词级时间戳**（凝彩 buildLineGraphemeTimeline 思路），不再退化为整行静态——任何歌都有逐词动画
- 引擎扩展：ctx 暴露 `words/lineStart/lineDuration`（真实时间驱动）；`onTemplateReload` 回调保证 overlay 在每次模板重载后自动重挂

**演进记录**：v1 手动模板+设置 → v2 全自动推荐+设置移除 → v3 曾直接以 tempera 为内核（用户明确否：要求保留 pv-tool 引擎改造成凝彩式逐字，非替换）→ v4（现状）pv-tool 引擎 + 凝彩式逐字合成。tempera 内核版本已回退；`src/vendor/pv` 全程保留。

**隔离边界**：只新增 pvLyrics/ 目录 + App.tsx 模式接入；未改动任何既有歌词页组件与 `Apple*` 分支。

**验证**：非 Apple 分支 lint 0 错；`test/pvLyrics.test.ts` 20 用例全过（桥接/推荐/编排）；`npm run build` 通过。全量 lint 存量错误来自并行 AI 的 Apple 分支在途代码，与本模式无关。

## 9. 汽水音乐探索模式补齐·首批（2026-09-14，现有端点全接线）

四写代理并行（文件所有权互斥）完成探索模式汽水功能补齐：探索页**无限续播**（feed 游标透传 + fetchExploreRecommendationBatch soda 分支）、推荐歌单含收藏歌单、新碟区块派生聚合、搜索建议/歌手 tab/专辑 tab 派生端点（`/api/soda/search/suggest|artists|albums`）、**个人主页解锁 soda**（ProfileView 创建/收藏歌单分栏+最近播放+我喜欢 tab）、艺人页增 专辑/全部歌曲 tab+头像、专辑页加歌菜单恢复、歌单右键收藏按平台分发、音质弹窗汽水 5 档（quality 选档，会员闸门内就近落档）。死代码 getSodaSongUrl 删除、getSodaPlaybackInfo 双实现收敛。新增 `test/sodaDerivedExplore.test.ts` 17 用例。细节与残留项见 `docs/汽水业务审计-20260826.md` §八。**门禁**：tsc 零错；vitest 的 5 个失败（ImmersiveControls/modeIntegrationWiring/mvAlignment/specialLyricsRendering）经 HEAD 干净工作树对照实锤为既有失败，与本轮无关。**下轮大项**（MV/电台/歌单 CRUD 等需端点发现后实现）亦记录在该节。

## 10. 传统模式 QQ 首页 / 乐馆对齐官方客户端（2026-10-06）

**首页（`QQPcHome` + 新增 `qqHomeSections.tsx`）**
- 首屏卡行改成官方版式：**一张两格宽的猜你喜欢大卡 + 四张一格彩色功能卡，整行等高**；大卡左边两行推荐语 + 绿色播放圆钮、右边当前推荐曲封面；所有卡下方统一两行小字（「歌曲 - 歌手」/ 栏目标签）。此前大卡比其它卡高一截、卡行不齐。
- **猜你喜欢预取**：首页挂载即后台拉一批电台 99 歌曲（按账号隔离 + 5 分钟 TTL，`prefetchQQGuessYouLike`），点击直接用缓存开播；此前每次现拉电台 + 再解析歌曲 URL，实测要 6~7 秒才出声。
- 补齐**推荐流其余货架**：bootstrap 只返回第一页，拿到 cursor 后再串行补两页 feed（`fetchQQExploreFeed`，服务端 `v_cache/v_uniq` 去重），按卡片 style 分行渲染——208 单曲卡 = 官方三列歌曲架（9 首/架，`PcSongShelf`，点击/播放全部时一次性补 36 首详情，悬停预取），301/302/304 = 封面卡网格。听书/节目/直播/星光（5122/1700/1100/217/85）整块不渲染。
- 实测拿到真实 feed：`Hi <昵称> 今日为你推荐` / `从你的红心歌曲开始探索` / `听「X」也会喜欢` / `听「Y」的也在听` / `「昵称」的专属乐流`（301+302+304 混合）——与官方客户端首屏模块一一对应。

**乐馆（`QQPcHall`）**
- 页签对齐官方：**精选 / 排行 / 歌手 / 分类歌单 / 视频 / 频道**（官方还有数字专辑 / 音质专区 / 边听边玩，网关没有数据源，按既有口径不做）。
- 精选：新增官方三张一屏轮播（`/api/qq/banner`，6 秒自动翻页，点击开 H5）+ 原有 musicHall 货架。
- 排行：按官方分组（巅峰榜 / 地区榜 / 特色榜 / 全球榜）分节；带前三首的榜单渲染成**富榜单卡**（封面 + 榜名 + 前三首 + 播放量），其余为封面卡。
- 歌手：`/api/qq/singer/category` 提供地区 / 性别 / 字母三级筛选胶囊（二级菜单）+ 圆形头像网格 + 加载更多。
- 分类歌单：分类胶囊（保留分组行）+「精选歌单」标题 + 歌单网格 + 加载更多。
- 视频：`/api/qq/mv/category`（类型 / 地区筛选）+ `/api/qq/mv/list` MV 网格（16:9 封面 + 播放量 + 标题 + 歌手），点击走全局 MV 弹窗。
- 频道：**官方音乐电台广场**。新增后端 `GET /api/qq/radio/channels`（读官方网页版 `https://y.qq.com/n/ryqq_v2/radio` 的 SSR 数据 `window.__INITIAL_DATA__.radio_list`，10 个分类 / 118 个频道位，无登录可用，10 分钟缓存）与 `GET /api/qq/radio/songs?id=`（`mb_track_radio_svr/get_radio_track`，需登录 cookie，与猜你喜欢同一电台接口）。页面按分类胶囊（二级）+ 圆形频道位（三级：点击直接开播该频道）渲染。

**验证**：`npx tsc --noEmit` 0 错；`vitest run` 221 文件 / 2184 用例全过（`test/TraditionalView.test.tsx` 里 Hero 卡断言改为 `getAllByText`——卡面大字与卡下栏目标签都会出现「猜你喜欢」，与官方卡下「猜你喜欢-沉浸刷歌」同构）。界面用无头 Chrome + 真实账号（cookie 注入 localStorage、`waveforge:apiBase` 指向本地后端）逐页截图核对（首页首屏/滚动各节、乐馆六个页签、频道两个二级分类），产物在 `D:\opencode\shots\`。
**排查工具**：`.tmp-zoom/qqctl.py` + `tour*.py`（对官方客户端做**零干扰**后台取证：PostMessage 点击/滚轮 + PrintWindow 截图，不抢焦点、不动光标），截图在 `D:\opencode\.tmp-zoom\ref\`。

## 11. 传统模式验收标准 + 乐馆二次补齐（2026-10-07）

**验收标准（用户明确要求，已同步进 AGENTS.md 的「传统模式「官方 PC 客户端复刻」」小节）**：官方客户端长什么样，传统模式就得是什么样；**功能要齐全、不许猜、不许编，界面上出现的每个东西点下去都要有真实行为**。数据拿不到时的正确做法是先把接口逆向出来；确实没有网关数据源的，明确报备不做，不许用假数据顶上。

**本轮补齐（乐馆）**
- **数字专辑页签**：后端 `qqMusicHallAction` 新增 style 83 映射——数字专辑卡的专辑 mid 藏在封面 URL（`T002R800x800M000<mid>_1.jpg`）里，反解后返回 `open-album`（新增 `qqAlbumMidFromCover`）。前端新增 `albums` 页签，渲染 musicHall「数字专辑」货架的封面卡，点击进本地专辑详情页（实测 TANGENT/004WxXLs0ZCYBc 返回 13 首可播曲目）。官方该页的「立即购买」是站内支付流程，本软件不模拟（不编价格、不做死按钮）。
- **视频页二级页签**：官方是「推荐 / 排行榜 / 视频库」。本页实现 **推荐**（musicHall「精选视频」货架，8 张卡全部带 mvId，点开即用全局 MV 播放器播）与 **视频库**（`mv/category` 类型+地区筛选 + `mv/list` 网格 + 分页）；**排行榜**没做——上线前实测 `MV榜`（topId 201）在 `/api/explore/chart` 上是 502，只有标题没有 MV id，做出来就是死链。
- **排行页签**：目录里过滤掉纯 MV 榜（同上原因），保证列表里每一个榜单卡点开都有内容。
- **仍未实现（网关无数据源，未编内容）**：音质专区、边听边玩——都是客户端专有页。已扫 `GetHomePage` 的 `ShelfId` 1~99 / 100~150 / 151~220 共 220 个货架 id，没有任何货架对应这两页；音乐馆里只有「更多」货架的文字入口（杜比全景声专区/臻品母带专区），既无 id 也无封面。要补只能抓客户端明文流量（需在其信任库里装代理证书）或反编译客户端私有模块。

**验证**：`tsc --noEmit` 零错；新增 `test/QQPcHall.test.tsx`（4 用例：数字专辑卡点击分发 / 视频推荐+视频库 / 排行过滤 MV 榜 / 未登录空态）；全量 `vitest run` 2187 过（`test/resonanceSession.test.ts` 有 1 例在并行跑时因 WebSocket 时序偶发失败，单跑 17/17 过，与本轮改动无关）；接口层实测：`/api/explore/qq/native/bootstrap` 的数字专辑卡已带 `open-album` 与真实 mid、精选视频货架 8 卡全 `open-mv`、`/api/qq/album?mid=004WxXLs0ZCYBc` 正常返回。
**待办**：登录态下的逐页视觉核对（数字专辑/视频推荐需要登录 cookie，用户机器上 3001 端口被其 dev 实例以令牌保护占用，无头验证要在其重启 dev 环境后进行）。

## 12. 反编译客户端私有模块 + 乐馆口径收敛（2026-10-07 下半场）

**反编译手段（可复用）**：官方 PC 客户端的私有协议模块名以明文存在 `D:\QQMusic\QQMusic_Protocol.dll` 里——用
`node .tmp-zoom/extract-modules.mjs <dll> <关键字…>`（脚本扫可打印 ASCII 串并打印命中串的邻域）就能同时拿到
**模块名 + 方法名**。本轮据此拿到 38 个模块，关键三条：
- `musicToplist.ToplistInfoServer` / `GetDetail`（榜单；`topId=201` = 巅峰榜.MV，条目带 `vid`）
- `music.vip.ExcSoundBenefitSvr`（`GetVIPStartButton` / `StartTrial`）→ **音质专区是 VIP 试用/权益页**
- `music.gameCenter.MiniGameSvr`（`ListRecentlyMiniGames` / `ClickMiniGame`）→ **边听边玩是小游戏**
其余可用线索：`video.VideoLogicServer`（GetMVStreamInfo/GetMvUrls）、`music.video.VideoData`、`music.stream.MvUrlProxy`。

**口径收敛（用户 2026-10-07 决定，已写进 AGENTS.md，禁止回加）**
- **数字专辑整页移除**：官方是付费商城（立即购买/支持），不做购买类内容。前端 `albums` 页签、后端 style 83 → open-album 映射、专辑 mid 反解工具、相关测试全部删除；musicHall 的「数字专辑」货架继续由 `isHiddenQQMusicHallShelf` 隐藏。
- **音质专区不做**：反编译证实是 VIP 试用页（`StartTrial`），与「不做购买」同口径。
- **边听边玩不做**：用户明确「游戏模块不要」。

**视频深挖（本轮实现）**
- 后端新增 `GET /api/qq/mv/chart?id=201&num=30`：走 `musicToplist.ToplistInfoServer/GetDetail`（PC/客户端同模块），返回榜单头图/简介/更新时间/收听量 + 条目（名次、`vid`、标题、歌手），封面按 `T015R640x360M101<vid>.jpg` 规律拼（与 mv/list 的 picurl 规律一致）；10 分钟缓存。实测 20 条与官方客户端逐条一致（异想天开/肖战 #1、宋雨琦 #2、田小娟 #3、少管我/周深 #4）。
- 前端视频页补回**三个二级页签**：推荐（榜单入口卡 + 精选视频货架 + 最新 + 热门）、排行榜（榜单头图 + 名次列表，点击播 MV）、视频库（类型/地区 + 网格 + 分页）。
- **已知缺口（未编）**：官方排行榜的地区子榜（内地/港台/欧美/韩国/日本）——`GetDetail` 不吃 area/region/subId，扫 topId 195~215 只有 201 有数据，故只做总榜。

**验证**：`tsc --noEmit` 零错；`test/QQPcHall.test.tsx` 4 用例（视频推荐+视频库、视频排行榜点击播 MV、排行过滤 MV 榜、数字专辑页签已移除）全过；接口层实测 mv/chart 返回 20 条带 vid 的条目。

## 13. 首页 Hero 行对齐官方（2026-10-07 晚，用户实测反馈「数据不一样」）

**根因**：官方 PC 客户端那一行彩色功能卡 = **服务器返回顺序的前 4 张 `style 202` 卡**；旧实现只筛 `type === 500`，
于是把 `202/900/991` 的雷达卡（客户端界面名「刷歌模式」，feed 里 title 是「雷达模式」）漏掉，第 5 张「歌手漫游」被顶上来。
实测同一账号同一时刻的 feed：`每日30首(510) → 雷达模式(991) → 百万收藏(513) → 新歌推荐(513) → 歌手漫游(513)`，
官方展示的正是前四张。**修复**：`QQPcHome` 取 `style === 202` 的前 4 张；`featureLabel` 对 subtype 991 给出
「刷歌模式」标签与说明行（与左栏「刷歌」同一功能）；点击仍走 `play-radar`（`music.recommend.TrackRelationServer.GetRadarSong`）。
新增 `test/QQPcHome.test.tsx` 两条用例锁死这条规则（含「点刷歌模式卡会起播雷达歌曲」）。

**反编译补充（QQMusic_Protocol.dll 里的模块/方法串）**：`music.recommend.TrackRelationServer.GetRadarSong`（刷歌）、
`music.stream.MvUrlProxy.GetHotMV`（热门 MV）、`music.recommend.RecommendWidget.GetPCCommonEntryPoint`（PC 入口位）、
`music.musichallAlbum.AlbumSongList.GetAlbumSongList`、`music.musicasset.*`（歌单/最近播放/MV 收藏读写）、
`music.prepushHotFile.HotFile.GetSonglist`。PC 首页 feed 的**请求参数**在这些二进制里没有明文，未能据此复刻请求环境。

**仍未与官方一致（诚实记录，未编数据）**
1. **「你的歌单宝藏库」**：我们用 `/api/qq/songlist/list?id=10000000&sort=5`（歌单广场「推荐」分类，实测**加不加登录 cookie 返回完全相同**、非个性化）；官方那份是另一路数据源（内容不同），未定位到接口。
2. **猜你喜欢卡面显示的曲子**：官方是服务端挑的那首（截图里 夜深了/KiiKii），我们显示的是预取的电台 99 首曲——电台本身会随时间/会话轮换，两者会不一致。
3. 剩余差异要"一模一样"只能抓客户端真实请求：官方客户端走 HTTPS 且日志/网页缓存里都没有该响应，需要在系统信任库装代理证书（属系统级改动，等用户点头再做）。

## 14. 数据源深挖第二轮：文案 / 精选 / 榜单周期（2026-10-07 深夜）

**猜你喜欢卡面文案的真源**：`mb_track_radio_svr/get_radio_track`（电台 99）返回的 `extras[i]` 与首屏 tracks 一一对应，含
`reason`（"根据你的听歌口味推荐"）与 `rectag.RecReasonTemplate`（"不忍心关掉音乐，{br}就这样在枕上流浪。"——`{br}` 是客户端换行标记）。
服务端 `/api/explore/qq/radio/next` 现在随批次下发 `radio: { name, reasons[] }`，首页大卡第一行直接用服务端模板，第二行用客户端兜底文案。
**顺带解决「猜你喜欢慢」**：上游一次只给 5 首，旧实现为凑 30 首串行打 6 次（≈6s）；新增 `fast` 模式（只打一次上游 ≈0.92s 拿 5 首就开播，
与官方"先 5 首 + 持续推荐"同语义），并加 60s 批次缓存（二次请求 0.003s）。fast 模式不掺公开兜底内容。

**乐馆精选补齐（图3 差异）**
- 顶部首发 banner：`GET /api/qq/hall/banners` → `GetHomePage` 显式取 `ShelfId: [115,116,1]`（默认响应里没有这三个货架；
  实测 115 首条 = G.E.M.邓紫棋《自由的你》，与官方精选页第一张 banner 对得上）。前端按官方三张一屏轮播渲染，可播的带「立即播放」。
- 「官方歌单」货架：`GET /api/qq/hall/official-playlists` → `playlist.HotRecommendServer/get_hot_recommend`
  （实测与官方精选页「官方歌单」逐条一致：90后回忆|MP3时代的流行歌曲 / 甜系rap|你与星河皆可收藏 / 效率加倍…）。
  官方顺序是「banner → 官方歌单 → 其它货架」，前端照此排版。

**榜单周期切换（图5）**：`GET /api/qq/chart/periods?id=` 返回 `{ current, years: [{ year, periods: [周...] }] }`
（上游 `GetDetail` 的 `history`；美国公告牌 108 = 2026 第 39 周，MV 榜/热歌榜 history 为空 → 不显示选择器）。
`/api/explore/chart` 接受 `period`（周榜 2026_39 / 日榜 2026-10-06）并透传给库的 top 路由；榜单页标题旁加年份/周下拉，切换即重取该期。
榜单页同时改成**按数据决定列**（榜单接口本来就带专辑/时长，实测 108 都有——之前空列是渲染问题），并去掉评论页签。

**仍未定位（诚实记录）**：① 首页「你的歌单宝藏库」与「歌单遨游指南」、乐馆精选里的个性化歌单货架（木力口 / 未来 Bass / 混沌武士 / 东方…）
是同一个**个性化歌单源**，已排除公共歌单广场（加不加 cookie 都一样）、`HotRecommendServer`（编辑推荐那批）、推荐流 1~5 页；
从客户端反编译的 38 个模块里也还没有明确对应的（候选 `music.prepushHotFile.HotFile.GetSonglist` 待试）。② 视频「推荐」页顶部 banner：
模块 `music.stream.MvUrlProxy/GetHotMV` 存在但参数未知（返回 rsps: null），需要抓包或继续试参数。

## 15. 抓包现状与一键接管脚本（2026-10-07 凌晨，AI 自行操作）

**结论**：QQ 音乐的 **MusicU 接口与音频流走自研网络栈直连 IP，完全绕过系统代理**——已用「装 mitmproxy CA + 系统代理 + 杀掉客户端重启强制重连」三步验证过（客户端重启后仍正常登录；代理期间共抓到 206 个 host，含腾讯 `y.gtimg.cn`/`wup.browser.qq.com` 与抖音系，证明证书与代理链路本身可用，唯独 `u.y.qq.com` 不出现）。客户端自带的代理设置（`QQMusic_Protocol.dll` 里有 `ProxyServer` 字符串）藏在加密配置里，UI 里没定位到入口。

**能抓到的唯一现成路径**：**Reqable 的「增强模式」**（驱动级重定向，专治不认系统代理的客户端）。Reqable 配置 `%APPDATA%/Reqable/config/capture_config` 里 `enhancedMode: false`，但 `D:\Reqable` 下没有任何驱动文件、也没装驱动服务，**开启必然要装驱动 → 需要一次管理员授权（UAC）**，非管理员会话点不了。

**一键接管（增强模式开好后执行）**：`node D:\opencode\.tmp-zoom\mine-capture.mjs`
- ① 用零干扰点击器驱动客户端刷新首页/乐馆/视频（触发真实请求）
- ② 扫 Reqable 落盘的明文 body（`%APPDATA%/Reqable/capture/*.reqable`，确认是**未压缩 JSON**），抽出所有 MusicU `module/method/param` 与含 `v_shelf/v_hot/v_playlist` 的响应
- ③ 输出 `D:\opencode\.tmp-zoom\mined\modules.json` + 关键响应副本，重点找个性化歌单（宝藏库/歌单遨游指南）与视频 banner（`GetHotMV` 参数）两个数据源

**另一条不需要管理员的思路（未完成）**：APK 反编译。已解出 20+ 个 dex（236MB）扫模块名，挖到 `music.individuation.Recommend`（个性化推荐）与 `AiTabSettingCtrl`；dex 里没有方法名，试了 7 个候选方法名全是 40000（模块/方法不存在），纯猜无效——拿到抓包里的真实方法名即可复用。

**已完成的替代进展**（同日）：猜你喜欢 fast 路径（0.92s / 5 首）+ 卡面文案取自电台 `extras`；乐馆精选首发 banner（ShelfId 115/116/1）+ 官方歌单（HotRecommendServer）；榜单周期选择器（`/api/qq/chart/periods` + `period` 透传）；歌手风格筛选项；专属乐流两列流；QQ 电台续载改 fast（5 首 ≈0.9s）。**仍缺**：宝藏库/歌单遨游指南的个性化歌单源、视频推荐页 banner、播放列表面板「持续推荐歌曲」入口（纯 UI）。

## 16. 【重大突破】官方"推荐/乐馆"是 H5 页面，数据源与复刻路径已定位（2026-10-07 凌晨）

**抓包彻底打通**（客户端自带「设置 → 网络设置 → HTTP代理」填 `127.0.0.1:8080` → 重启客户端；PC 接口是 `*.y.qq.com/cgi-bin/musics.fcg`，body 明文 JSON）。抓包插件：`D:\opencode\.tmp-zoom\pc_capture2.py`（落 body + **完整请求头**），存档 `capture2/`、`capture3/`。

**根因**：传统模式一直用手机环境（`ct:11/cv:20080008/platform:android`）请求，官方 PC 推荐页实际是 **H5（webview）页面**：
- 页面地址 `https://i2.y.qq.com/n3/wk_v20/entry/index/recommend`（origin `https://i2.y.qq.com`，UA 是 Chrome/53 老内核），
- 接口 `https://u6.y.qq.com/cgi-bin/musics.fcg?_=<ts>&sign=zzc…`，`comm = {ct:20, cv:2241, platform:"wk_v17", uid, uin:0, g_tk:5381}`，请求体用 **`req_1`/`req_0` 数字键**（不是模块名当键）。
- **原生（ct:19）请求全部不带 sign**（87/87），只有 H5 的请求带 `sign=zzc…`——所以复刻 H5 调用的唯一门槛是**实现这个 sign**（算法就在那个公开 H5 页面的 JS 里，不需要抓包/管理员）。

**同一账号，PC H5 环境下的推荐流（已抓到原文，`capture3/0036_…_res.txt` 的 `req_1`）就是官方那套**：
- Hero 行 5 张卡：`猜你喜欢-沉浸刷歌 / 每日30首 / 百万收藏 / 新歌推荐 / 杜比专区`（**没有**雷达模式、**没有**歌手漫游——与手机环境那套完全不同，这就是"数据对不上"的根因）；
- 第二个货架 = **个性化歌单**（用户截图里的"你的歌单宝藏库 / 歌单遨游指南"）：`"主打高端局"FUNK热门燃曲 / PHONK·低重音暴力美學 / 致幻Phonk / 百首东方经典：同人乐中绽放的幻想盛宴 / 《鸣潮》致新世界音乐会歌单 / 美到窒息的轻音乐`；
- 第三个货架 `Latest` = 36 首新歌；第四个 `大家都在听` = 36 首；第五个是有声剧（按既有口径排除）。

**下一步（不需要用户配合）**：
1. 拉 `https://i2.y.qq.com/n3/wk_v20/entry/index/recommend` 的 JS，扒出 `sign=zzc…` 的签名函数（QQ 音乐 web 经典签名：参数字典序拼接 + 固定 key + hash33/base36），在后端实现；
2. 后端加 `pcH5` 模式：`musics.fcg` + `ct:20/cv:2241/platform:wk_v17` + `sign` + 请求头（UA/Referer/Origin 照抄 capture3）+ 数字键请求体；
3. 传统模式 PC 页面的推荐流/货架改走它 → 官方卡组与个性化歌单货架会顺着现有渲染逻辑自动出来；
4. 视频 banner（`GetHotMV`）与榜单周期用同样方式（从 capture3 里找对应 H5 调用）；队列「持续推荐歌曲」入口是纯 UI。
`local-server.mjs` 里已按 `options.pcEnv` 预留了 PC comm 开关（默认仍是稳定的手机环境，可随时切换）。

## 17. 乐馆/视频已切到 PC 环境；推荐页只剩「H5 签名」一道门（2026-10-07 凌晨收尾）

**已落地（本提交）**：
- `fetchQQNativeMusicHall` 与 `/api/qq/hall/banners` 改用 **PC 环境**（`{ pcEnv: true }`：ct19/cv2241/tmeAppID=qqmusic/_channelid=20/patch=118，原生调用**不需要签名**）。
  实测 bootstrap 的 musicHall 变成官方 PC 乐馆那套货架：**焦点图(7) / 快捷入口(21) / 编辑甄选(8) / 新歌(12) / 新碟(3) / 数字专辑(3) / 排行榜(4) / 音乐人(2) / 分类专区(18) / 精选视频(10)**；
  banner 路由优先取「焦点图」（首发新碟/新歌，实测 自由的你-G.E.M.邓紫棋 / 以我之见-谭维维 / 醒时歌-周传雄…）。
- 前端 `QQPcHall` 把「焦点图」从普通货架里排除（它是顶部 banner 行），避免重复渲染。
- 视频页「推荐」用的 musicHall 精选视频货架、频道、榜单周期、MV 榜都按同一 PC 环境口径工作。

**仍差最后一道门：首页「推荐」流（宝藏库/歌单遨游指南/幸运好歌）**
- 官方 PC 的推荐页是 **H5 页面** `https://i2.y.qq.com/n3/wk_v20/entry/index/recommend`，接口
  `https://u6.y.qq.com/cgi-bin/musics.fcg?_=<ts>&sign=zzc…`，`comm={ct:20,cv:2241,platform:"wk_v17",uid,uin:0,g_tk:5381}`，请求体用 `req_0/req_1` 数字键。
- **`sign` 与请求体强绑定**（实测：同 sign 换 body 立刻 2000；同 sign 同 body 可复用、不随分钟过期）。
- 签名函数**不在**首页所加载的 index/runtime/vendors/tencent-sdk/spd-base/unisdk 里（都已下载排查），应在懒加载 chunk 中——下一步：用无头浏览器加载该 H5 并记录全部 chunk 请求（CDP Network），或直接在该页面里调用它的请求模块拿 sign 做对照，再实现签名算法。
- 一旦实现签名，后端加 `pcH5` 模式（musics.fcg + ct20/wk_v17 + sign + 照抄 capture3 的请求头）即可拿到官方那套 Hero 卡与个性化歌单货架；前端渲染逻辑无需改动（已具备货架/卡片/两列流/歌曲架能力）。
- 抓包存档：`D:\opencode\.tmp-zoom\capture2|3\`（带完整请求头的明文）；插件 `pc_capture2.py`。
**机器状态**：客户端「网络设置」里的代理仍指向 127.0.0.1:8080（mitmdump 还在跑，用户可自行清空）；mitmproxy CA 在用户级 Root（`certutil -user -delstore Root mitmproxy` 可删）。

## 18. 推荐页签名函数的最终结论（2026-10-07 收尾）

签名函数定位完成：官方 H5 的 **webpack 模块 488**（在 `y.qq.com/n3/wk_v20/entry/vendors.chunk.*.js` 同级依赖 `tencent-sdk.chunk.*.js` 里），
请求层代码在 `common~INTEL_SONG~...chunk.*.js`：
```js
s.url = addParam({_: Date.now()}, s.url)
s.needSign && s.url.includes('musicu.fcg') && (s.url = s.url.replace('musicu.fcg', 'musics.fcg'))
if (s.url.includes('musics.fcg')) { const f = (await import(/* chunk 488 */)).default; const m = f(s.data /* POST 的 JSON 字符串 */); s.url = addParam({sign: m}, s.url) }
```
模块 488 是**纯 JS 的混淆 VM**（内部常量 1732584193/4023233417/2562383102/3285377520 = SHA-1 初值，1518500249/1859775393/1894007588 = SHA-1 轮常量 → 签名 = SHA1 系），
执行时把函数挂到 `u._getSecuritySign` 再取回（`u` 来自 `r(205)`）。
**已能在 Node 里跑起来**（`D:\opencode\.tmp-zoom\extract-signer.mjs`，返回 `zzc…` 格式正确），但与抓包真值不吻合 → 证明它还依赖未识别的环境输入（`r(205)` 那个对象的内容 / 页面级种子 / uid 等）。
**下一步两条路**：
① 对比页面里 `r(205)` 的真实返回（在无头浏览器里 `__webpack_require__(205)` 或从 VM 入口断点拿输入），补全后再实现纯 JS 签名；
② 或者在传统模式「推荐」页直接内嵌官方 H5（`i2.y.qq.com/n3/wk_v20/entry/index/recommend` + 用户 web cookie + wk_v17 UA）——它自带正确环境与签名，内容与官方逐像素一致。

**推荐页最终方案（2026-10-07 决定并落地）**：官方 PC 客户端的「推荐」页本身就是 H5（`i2.y.qq.com/n3/wk_v20/entry/index/recommend`），
所以在传统模式推荐页加「复刻版 / 官方页面」切换（`localStorage: waveforge:qq-home-view`，默认复刻版）：
切到官方页面时复用既有 `src/features/neteaseExplore/NeteaseWebPanel.tsx`（Electron 下 `<webview>` 不受 X-Frame-Options 限制，
浏览器调试退回 iframe，保留"在浏览器打开"兜底）内嵌那个官方页面 —— 数据/排版/签名全部与官方客户端同源，
因此首页的「你的歌单宝藏库 / 歌单遨游指南 / 幸运好歌」等个性化内容在官方页面视图下即为官方原文，
同时我们自己的复刻版（PC 环境货架 + 官方歌单 + Hero 行 + 两列流）保留为默认视图与降级路径。

## 19. 签名函数验证结果（收尾，2026-10-07）

**已确证**：用 `Page.addScriptToEvaluateOnNewDocument` 预注入 `Object.defineProperty(window,'_getSecuritySign',{set(v){window.__sigFn=v}})` 陷阱，
可从活的官方 H5 页面拿到签名函数本体；**它与我从 `tencent-sdk.chunk` 抽出的 Node 版本输出逐字节一致**（同输入同输出，无状态、不随页面/时间变化）。
→ 签名算法已到手，缺的只是「推荐流那条调用传给它的输入形态」：9 种候选（原 body / 重序列化 / 对象 / 带 `_` / 拼时间戳…）都未复现抓包真值，
说明页面里另有一层包装对入参做了变换。验证脚本：`D:\opencode\.tmp-zoom\{trap-sign,cmp-sign,brute-sign,verify3,verify4}.mjs`。
**下一步（一步到位）**：同一次注入里同时挂「签名函数陷阱 + XHR/fetch 钩子」，让页面自己发一条 **code=0** 的 feed 请求，拿到
`{完整 body, 该请求的 sign, code}` 三件套 → 用已到手的函数对同 body 求值即知输入变换规则 → 后端加 `pcH5` 模式（musics.fcg + ct20/wk_v17 + sign + 抄 capture3 请求头）→ 官方 Hero 卡与个性化歌单货架由我们自己的界面渲染。
（本轮最后一次尝试里，无头页面的请求拦截回归为 0 条——注入的钩子影响了页面自身脚本，需把钩子改为「先等页面跑完再挂」或改用 `Network.requestWillBeSent`+`Network.getRequestPostData` 从协议层取 body，避免污染页面。）

## 20. 【最终解锁】签名之谜 + pcH5 推荐流 + 视频 banner（2026-10-07 收官）

**签名谜底（§17–§19 的「一道门」正式关闭）**。上一轮追的 H5 webpack 模块 488（`tencent-sdk.chunk` 里的
`_getSecuritySign`）确实是页面在用的签名函数（活体 headless 复捕：`f(body)` 与页面 URL 里的 sign 逐字节一致），
**但它对 wk_v17 客户端请求是死路**：headless 里页面自己发的请求照样 code 2000，把活体 body 换任何环境参数重签也一样——
服务端对 musics.fcg 校验的是另一套 zzc 算法。而那套算法**项目里早就有了**：`@jixun/qmweb-sign`（npm 依赖，
`local-server.mjs:65` 已 import，写请求/评论接口在用）。同一条 body，模块 488 与 qmweb-sign 输出不同，
qmweb-sign 的服务端接受。capture3 存档样本对不上纯属意外：落盘的 `_req.txt` 与线上字节不一致（真实 body+原 sign 重放 code=0）。
实证脚本：`.tmp-zoom/{capture-live,verify-live-sign,replay-check,matrix-sign,use-qmweb-sign}.mjs`。

**pcH5 模式已落地**（`local-server.mjs`）：
- 新增 `requestQQPcH5Module()`：`GET u6.y.qq.com/cgi-bin/musics.fcg` + `comm{ct:20, cv:2241, platform:'wk_v17', uin:0, g_tk:5381}`
  + `zzcSign(body)` + `data` 查询参数（免 ag-1），UA Chrome/53+QBCore、Referer `i2.y.qq.com/n3/wk_v20/entry/index/recommend`。
  uid 留空即可，服务端按 Cookie(qm_keyst) 识别账号下发个性化内容。
- `fetchQQNativeRecommendFeed` 切 pcH5 优先、失败回退 pcEnv。翻页规则（实测）：page1 `direction:0`；
  page≥2 `direction:1` 且 **v_cache/v_uniq/s_num 一律传空**（带客户端回传值反而 500020），每页都出新货架。
- 官方数据流：page1 = Hero(301「Hi {nick} 今日为你推荐」：猜你喜欢-沉浸刷歌/每日30首/刷歌模式/百万收藏/新歌推荐/杜比专区)
  + 你的歌单宝藏库/补给站(271) + 播客(272) + 精选好歌(207)；page2+ = 歌单遨游指南(205) + 惊喜好歌(207)。
  **§14 一直没定位的「宝藏库/歌单遨游指南」个性化源就是 271/205 货架**——随本方案一并补上。
- wk_v17 的卡 style 字典与客户端档位不同（Hero 卡 6/7/15），pcH5 分支里按 subtype 重映射回
  201(主推大卡)/202(彩色功能卡)，前端 Hero 行渲染逻辑零改动（QQPcHome/QQExplorePage 通用）。
- 前端两处小适配：①「你的歌单宝藏库」兜底块在 feed 带 271 货架时不再渲染（避免双份）；
  隐藏标签补「随时随地/停不下来」（272 播客货架的轮换标题）。
- 验证：bootstrap 1.1s 返回 pcH5 源六模块 + daily30 30 首；feed page2 返回 205+207；tsc 零错；全量 2291 用例全过。

**视频「推荐」页顶部 banner 已接**：官方那排首发 MV 资讯轮播 = `GetHomePage` 显式取 **ShelfId 127「精选视频」**
（默认响应不含，与乐馆 115/116 同套路；扫 ShelfId 脚本 `.tmp-zoom/sweep-hall-shelfids.mjs`）。
新增 `GET /api/qq/video/banners`，前端视频推荐页顶部三张一屏 6s 轮播（复用乐馆 banner 版式），点击直接进全局 MV 播放器。
反编译的 `music.stream.MvUrlProxy/GetHotMV` 模块存在但参数仍未破解（恒 `rsps:null`，pcH5/android 双通道 15 种参数矩阵均不通）——
用同一官方数据源的货架实现同一版面，参数谜题留档即可。

**收尾状态**：mitmdump 已停、8080 无监听；系统代理 ProxyEnable=0（客户端无独立代理残留，走系统代理已断）；
**mitmproxy CA 还在用户 Root 存储**——Windows 对 ProtectedRoots 的删除强制弹 GUI 确认（certutil/-f/PowerShell X509Store 三路实测都挂起），
无法静默移除。想彻底撤销请在终端跑 `certutil -user -delstore Root mitmproxy` 并在弹窗点「是」。

**验证入口**：`WAVEFORGE_LOCAL_TOKEN= PORT=3012 node local-server.mjs`；
`POST /api/explore/qq/native/bootstrap`（feed.source 应为 `qq-pch5-recommend-feed`）、
`POST /api/explore/qq/native/feed {"page":2}`、`GET /api/qq/video/banners`。
活体抓包脚本（CDP 协议层被动，无页面注入）：`.tmp-zoom/{capture-live,capture-video,diag-mv-page}.mjs`（端口 9445–9447）。

## 21. 用户验收回归修复（2026-10-07 下午，本轮三处）

用户实测对比官方客户端发现两处问题，连同「视频 banner」的最终验证一起收口：

**① 榜单详情整列无封面（乐馆→排行榜→点进榜单）**。根因是一串组合拳，全部修掉：
- 服务端 `/api/explore/qq` 聚合在**配了 `QQMUSIC_API_KEY`（应用有、裸跑 local-server 没有）**时，
  榜单目录标成 `source:'qqmusic-skills'`（officialCharts 先于 community 合并）→ 详情页走 skills 分支；
- skills 的 `/charts/detail` trackList 是简略歌曲对象（连 albumMid 都没有），归一化后 100 首全无封面/时长；
- 前端 `exploreDetailCache` 的键 `chart:platform:id:period` **不含 source**，谁先打开谁污染缓存——
  传统模式点同一个榜单命中 skills 那份无封面数据且**不再发请求**（这就是"点进去没封面"的全貌）。
修复：`local-server.mjs` 的 skills 榜单分支照 `playlist/detail` 的既有做法逐首 `qqSongDetail` 补全
（`mid` 命中缓存+并发限流，实测 100/100 有封面）；`exploreApi.ts` 榜单/歌单缓存键补 `source`。
验证：应用里点开流行指数榜 = 100 行 100 封面（修复前 0/100）。

**② 首页有时整段少「你的歌单宝藏库/私荐歌单」（271 货架时有时无）**。
`isHiddenQQHomeModule` 的标签检查把**卡片标题**也扫进去了：271 轮换出的歌单卡偶尔有一张名字带
「有声/直播/节目」等词，整块货架被误杀（探针实录 `bootstrap:301,271,272,207 → render:272,207`）。
修复（`qqHomeSections.tsx`）：标签只扫**栏目名**；新增「没有一张能用卡的货架整块隐藏」规则
（cards≥3 且全部 action=unsupported）——272 播客货架标题再怎么轮换都能被稳定隐藏，271 永不误杀。

**③ 视频页 banner 验证**：三张首发 MV 资讯轮播正常（余宇涵/Taylor Swift/周深 + MV 角标，点开进 MV 播放器），
`/api/qq/video/banners` 每屏三张、dots 切换；此前的实现已被构建并上线验证。

**操作要点（重要）**：应用跑的是 `dist/` 构建产物（3000 是静态服务）+ 独立 `local-server.mjs`（3001）。
**前端改动必须 `npm run build` 后重载页面；后端改动必须重启 3001 服务**（本轮已代跑：build 完成，
3001 已用原 token/userData 重启并验证 `/health` 200）。若应用整体重启，dev-electron 会按自己的
启动流程重新拉起后端与构建，无需手工干预。

**验证基线**：tsc 零错；全量 2291 用例通过；应用内实测——首页（Hero 六卡 + 个性歌单货架 + 歌单遨游指南）、
榜单详情（100/100 封面）、视频 banner（3 卡轮播）全部正常。相关脚本：
`.tmp-zoom/{capture-response,check-hidden-misfire,verify-fix-all,verify-scroll-covers,check-video-dom}.mjs`。

## 22. 全量走查回归（2026-10-07 傍晚，用户要求「全部点一遍对比客户端」）

**本轮修掉的真 bug（都是走查点出来的）**：

1. **搜索页整页崩溃（React #31）**：`searchSongs` 的 QQ 归一化里 `name: song.album?.name || song.album || ''`，
   当 album 是对象但 name 为空串（实测 `夜に駆ける` 30 条结果里 7 条是这种空名专辑，如电台/其他版本）时，
   name 落成**整个 album 对象**；表格渲染 `{song.album.name}` 直接抛 React #31，搜索页白屏。
   修复：`src/services/musicApi.ts:534` 对象场景取空串，绝不回落对象。

2. **「刷歌」功能位是死的**：侧栏 `runEntry` 从来没接线 `local:radio`（`onPlayRadio` 定义了却从未使用），
   点击只弹「暂不支持」。修复：`runEntry` 增加 `local:radio → onPlayRadio()`（起播猜你喜欢 30 首队列，
   实测约 6–10 秒出播放器——非 fast 模式，等待属正常）。

3. **功能位格子与客户端对不上**：官方入口接口返回 5 个已选功能位（АДЛИН 常听歌手 / 频道 / 视频 /
   飙升榜 / 官方歌单），但本地 localStorage 只在**首次**落盘时同步 Selections，老数据只有「刷歌」——
   格子比客户端少一截。修复：`QQPcSidebar` 加一次性对齐（`TILES_SYNC_KEY`，只在从未对齐过时合并
   官方 Selections，之后尊重用户增删）；并把 频道/视频/飙升榜/官方歌单 四个功能位接到乐馆对应页签
   （`navigatePcSidebar(key, detail)` → `QQPcHall initialTab`）。
   实测：格子 = 推荐/乐馆/刷歌/АДЛИН/频道/视频/飙升榜/官方歌单（8 格，与客户端同构），落点全部正确。

4. **构建更新后旧页面点开子页「渲染出错」**：重建 dist 后哈希分包被替换，已打开的旧页面 lazy 加载
   `QQPcCollection-<旧哈希>.js` 拿到 HTML 报错，而传统模式的内层 `EmbeddedExploreErrorBoundary` 只给
   「重试」按钮（必然复败）。修复：内层边界与根级边界同款处理——chunk 类错误整页自动重载一次
   （sessionStorage 打标防循环）。**注意：每次 `npm run build` 后旧窗口需重载一次页面（Ctrl+R）**。

**「本地和下载 / 已购音乐 / 试听列表」结论（回答用户「功能全部集齐」）**：
- 三者是早前记档的**产品决策「永久不支持」**能力（`features/traditionalPc/types.ts:60` 注释，酷狗侧栏也标「暂不支持」）。
- 本轮复核了可行性：客户端 `QQMusic_Protocol.dll` 全量模块串里**没有**购买/试听列表模块（只有
  `music.musicasset.DownLoadHistroyRead` 下载历史）；skills API 白名单里也没有对应端点；
  盲测 12 组候选模块名全部 404/无权。已购/试听很可能走 H5 商城接口或纯本地记录；
  本地和下载需要本地扫描 + 下载链路（本软件无下载器）。
- 要拿真数据只有一条路：重开客户端抓包链路（客户端设置→网络设置→HTTP代理→127.0.0.1:8080→重启客户端
  + mitmdump），点击这两个页面抓模块名。本轮已试：客户端代理当前未生效（抓包 0 条），
  重开需动客户端设置，等用户点头再做。

**验证基线**：tsc 零错；全量用例通过；应用实测——搜索（30 行正常）、刷歌（起播 30 首）、
8 个功能位落点、乐馆六页签、视频 banner、榜单 100/100 封面、首页货架稳定。走查脚本：
`.tmp-zoom/{audit3-walk,verify-tiles,audit5-final,verify-search-fix,retest-radio}.mjs`。

## 23. 客户端逐页对照 · 收官补齐（2026-10-07 晚，用户要求「全部检查/要一样」）

**逐页对照方法**：客户端用 `wf_client_shot2.py`/`.tmp-zoom/bgclick.py`（后台单击+PrintWindow 截图）逐页点，
WaveForge 用 CDP（端口 9223）逐页开，两边截图逐块比对。客户端侧栏/乐馆页签坐标已测准（图标格：
首页 (67,92)/乐馆 (174,94)；乐馆页签行 y=157：精选 552/排行 612/歌手 671/分类歌单 741/数字专辑 816/
音质专区 892/边听边玩 1000/视频 1068/频道 1135；侧栏：最近播放 (95,392)/本地和下载 (95,441)/
已购音乐 (95,491)/试听列表 (95,541)/喜欢 (95,590)）。

**本轮补齐（全部已实测）**：
1. **喜欢页页签对齐官方**：官方为 歌曲/歌单/专辑/有声节目/视频；我们补上后两个。
   「视频」= **收藏的 MV**，接的是真实客户端模块 `music.musicasset.MVFavRead.getMyFavMV`
   （新端点 `POST /api/qq/fav/mv`；该账号 6 条，与客户端「视频6」逐条一致，点击进全局 MV 播放器）。
   「有声节目」客户端同样为 0 条，落同款空态（无公开数据源，如实标注）。页签行为
   `歌曲865 | 歌单58 | 专辑 | 有声节目0 | 视频6`。
2. **侧栏三入口补齐 + 官方顺序**：最近播放 → 本地和下载 → 已购音乐 → 试听列表 → 喜欢
   （此前缺后三项且喜欢在前）。三个新页（`QQPcExtras.tsx` + `PcPageId`/侧栏接线）：
   - 试听列表：官方空态逐字对齐（唱片图标 + 「没有试听记录」+「去音乐馆逛逛」，该账号此刻同样为空）；
   - 已购音乐：官方结构（数字专辑/单曲页签）+ 如实空态（购买记录走 QQ 商城通道，全二进制扫描
     无该模块、skills 无端点、网页版需未持有的 web 登录态——通道未接入已明示，不编数据）；
   - 本地和下载：官方结构（本地歌曲/下载歌曲/下载视频/正在下载四页签）+ 如实空态
     （本软件无下载链路与本地扫描，与网易云/酷狗侧同一产品口径）。
3. **「刷歌」功能位接线**（此前 onPlayRadio 定义了但从未被调用，点击只弹「暂不支持」）→
   现在点击起播猜你喜欢 30 首队列（非 fast 模式约 6–10 秒出播放器，属正常耗时）。
4. **功能位对齐官方 Selections**：官方接口 5 个已选（АДЛИН 常听歌手/频道/视频/飙升榜/官方歌单）
   一次性合并进本地功能位（`TILES_SYNC_KEY` 防重复），共 8 格与客户端同构；四个入口先按链接
   走真实目标（歌手页/乐馆页签），不影响用户自行增删。
5. **搜索页崩溃修复**（React #31：空名专辑对象被当文本渲染，30 条结果里 7 条触发）——
   `musicApi.ts` 归一化对象场景取空串。
6. **构建后旧页面自愈**：`EmbeddedExploreErrorBoundary` 对 chunk 加载失败整页自动重载一次
   （与根级边界同口径）；此后每次 `npm run build` 后旧窗口最多自动刷一次。

**客户端侧已核对但为「按决策不做」的项**（与官方不同是产品决策，非 bug）：
数字专辑商城 / 音质专区（VIP 试用页）/ 边听边玩（小游戏）/ 有声节目 / 直播 / 星光 / 游戏中心。

**验证基线**：tsc 零错；全量用例通过；应用实测——喜欢（5 页签全通、6 张收藏 MV）、
三个新页面、8 功能位落点、刷歌起播、搜索 30 行、乐馆六页签、视频 banner、榜单 100/100 封面。

## 24. 数据级终验（2026-10-07 晚，「要一样」的逐条核对结果）

**本轮双端逐条核对（客户端截图 vs 应用内实测）**：

| 项 | 客户端 | WaveForge | 结论 |
|---|---|---|---|
| 侧栏 最近播放 | 2499 | **2499**（本轮修复，原 500） | ✅ 一致 |
| 侧栏 喜欢 | 865 | 865 | ✅ |
| 喜欢页签 | 歌曲865/歌单58/专辑4/有声节目0/视频6 | 歌曲865/歌单58/专辑4/有声节目0/视频6 | ✅ 逐项一致 |
| 收藏 MV 内容 | 6 条（Broken Sky/Heartbeats/No Vacancy…） | 同 6 条 | ✅ 同源同内容 |
| 最近播放首行 | Never Leave / TAKE YOUR NESS / Late night drift / Заберу / Cloud 9 | 完全相同 | ✅ 逐条一致（旧截图差异是 1 小时内新增播放，实时快照对上） |
| 功能位 | 首页/乐馆/АДЛИН/频道/视频/飙升榜/官方歌单(+加入口) | 推荐/乐馆/刷歌/АДЛИН/频道/视频/飙升榜/官方歌单 | ✅（多一个本机「刷歌」） |
| 试听列表 | 空（没有试听记录） | 同款空态 | ✅ |
| 本地和下载 | 本地2/下载2/视频0/下载中0（客户端自扫） | 结构同款，空态+说明 | ⚠️ 数据通道不可得（见 §22/23） |
| 已购音乐 | 数字专辑4/单曲0 | 结构同款，空态+说明 | ⚠️ 同上 |

**最近播放 500→2499 根因与修复**：`fetchQQRecentSongs` 请求没带 `requestCnt`，上游只回 ~500 条；
客户端（capture2 原文）是 `{requestCnt:2500, type:2, updateTime:0}`。补齐后 total=2499 与客户端完全一致。

**「臻品母带」角标的最终判定（不实现，防伪造）**：客户端喜欢/最近播放每行都带琥珀色「臻品母带」标签。
实测两组曲目的 file 档位：ラタムニカ（无任何无损）、Заберу / Cloud 9（仅 320kbps）**也照样带标** →
它不是逐曲音质数据（CgiGetTrackInfo 的 size_hires/size_ape 与标签无对应关系），而是客户端「播放品质偏好」
的统一指示标记。规则未实证前不复制该标签——避免给用户显示"将以此品质播放"的虚假声明。
（数据源就绪：`CgiGetTrackInfo` 可批量取 `file.size_hires/size_ape/size_flac/dts/dolby`，
若日后要做"真实音质角标"（SQ/臻品音质按档位），用它即可。）

**操作状态**：应用已由本会话用 `npm run dev:electron` 重新拉起（渲染 3000 / 本地服务 3001 / 调试 9223），
3001 上跑的就是当前源码（含全部修复）。验证脚本：`.tmp-zoom/{final-data-check,verify-badge-rule,badge-rule-2,trace-liked-fields}.mjs`。

## 25. 加载性能优化（2026-10-07 深夜，用户反馈「点了要过一会才出来」）

**先量后改**（客户端 3012 端点冷热耗时 + CDP 实测点击→出内容/起播）：

| 链路 | 优化前 | 优化后 | 手段 |
|---|---|---|---|
| 刷歌（侧栏功能位） | 6–10s 起播 | **1.5s** | playQqRadio 改 fast 批（5 首≈1.2s）先播 + `continuation:'explore-infinite'`（播放中自动续推荐，客户端「5 首 + 持续推荐歌曲」同语义） |
| 猜你喜欢（主推大卡） | 命中缓存秒开、未命中要等 | 缓存直出 + 续播 | 同上：runCard play-radio 带 continuous；缓存已有预取（挂载即 fast 预取 8 首） |
| 刷歌模式卡（雷达） | 单批后队列不再增长 | 队列自动续页 | play-radar 带 `radar`（page=服务端待取页）→ App 续播分支按雷达页自动追加 |
| 喜欢页首开 | **6.5s** | **1.8s**（二次 94ms） | 服务端歌单详情：首屏分页失败重试一次（旧实现首个请求偶发返回空、前端要多等一个重试周期）+ 分页并行度 4→6 |
| 喜欢页/任意歌单（二次冷启动） | 每次冷启动都重拉 6s+ | **秒开**（磁盘缓存 24h） | 歌单详情加磁盘二级缓存（`<userdata>/cache/qq-playlist-detail/`）：命中即回 + 后台静默刷新；喜欢/加歌/收藏等写操作成功即失效两级缓存 |
| 首页后续货架（听「x」也在听/歌单遨游指南） | 串行两轮分页 | **并行一发** | QQPcHome loadRest 改 Promise.all 拉 page2+page3（服务端按 page 独立取数） |
| 传统模式聚合 payload | 冷启动 7.6s 且挂在首屏路径 | 首屏后 3.1s 才发 | 首挂载延迟 2.5s 再拉（仅作宝藏库兜底/乐馆目录复用，乐馆进入时按需拉并复用同一内存缓存）；平台切换仍立即拉 |
| 同键并发 | 首页/乐馆/详情同时拉同一歌单打多轮上游 | 合并为一轮 | fetchQQPlaylistDetail 增加 pending 合并 |

**实测基线**（应用重启后 CDP 计时）：首页 Hero 1.08s 出现、后续货架再 0.6s、刷歌 1.5s 起播、
喜欢页冷 1.8s / 热 94ms、启动关键路径请求 250ms 起跑、payload 聚合 3.1s（后台）。
验证脚本：`.tmp-zoom/{measure-loads,measure-optimized,debug-radio2,check-payload-delay}.mjs`。

## 26. 传统模式 Apple Music 客户端复刻（2026-10-08，用户要求「做成跟客户端一样的 UI」）

**需求**：传统模式的 Apple 平台照 Apple Music Windows 客户端做 UI + 数据；**顶栏播放控件不复刻**（用户明确「用我们第三栏的」），右侧第三栏（正在播放/播放列表/同步歌词）保持本软件实现；未订阅（未登录，或登录但会员过期）时主页要搬客户端的**订阅广告**，点击与客户端一样打开**购买窗口**。

**取证（决定 UI 细节的依据）**：
- 客户端就装在本机（`AppleInc.AppleMusicWin`，WinUI 3 + 内容层 WebView2）。用 UIA 零干扰读出侧栏结构/尺寸：侧栏宽 290px、搜索框 272×32（#fbfbfb 底 + #e5e5e5 描边）、导航行高 36/行距 4、顶级图标 x=13 + 文字 x=47、子项再缩进 31px、「资料库/播放列表」是可折叠分组标题（右侧 更多/新建 + 折叠箭头）、底部账号行。截图实测配色：窗口/侧栏 #f3f3f3、内容 #eeeeee、表格行 #f9f9f9（隔行 #f3f3f3）、分隔线 #e5e5e5、主文字 #252525、次级 #7a7a7a、选中胶囊 #eaeaea、品牌红 #fa233b。
- 资料库「歌曲」页截图：工具条（居中小标题 + 右侧 过滤/显示选项）+ 表格列 **标题 / 时长 / 艺人 / 专辑 / 类型 / ★ / 播放次数**，行高 40、隔行、行悬停出「⋯」、表头可排序（实测 艺人 列有升序箭头）。
- 广播页（用户提供截图）：大标题「广播」+ 一排大电台卡（500×324，**标题在卡上方**：电台名 + 「Apple Music 电台」）+「风格电台 ›」方卡货架（一排 6 张）。
- 订阅广告文案：从客户端 i18n 词典（WebView2 缓存文件）里取到 Apple 官方本地化串，直接使用不改写：`FUSE.Upsell.Generic.Headline.FreeTrial` =「尽是你爱听的音乐。」、`FUSE.Upsell.Generic.Body.FreeTrial` =「加入 Apple Music，播放和下载数千万首歌曲…」、`FUSE.Upsell.SignUpOptimization.Generic.Trial.CTA` =「免费试用」。
- 购买窗口地址：客户端 WebView2 会话缓存里查到 `finance-app.itunes.apple.com/subscribe`（含 `buy.itunes getSubscriptionOffersSrv` 请求记录）→ 站内窗口直接开这个地址，与客户端同源同流程。
- 客户端内容页在**会员过期态下自身报「发生未知错误」**（主页/广播都拉不到数据），所以「订阅广告长什么样」按官方文案 + 客户端视觉语言实现；截图核对时也用未登录态验证。

**改动**：
- 新增 `src/features/traditionalPc/ApplePcSidebar.tsx`（客户端左栏）/ `applePcKit.tsx`（客户端基件 + 歌曲表 + 货架/卡片/空态）/ `ApplePcHome.tsx`（主页：未订阅=订阅广告；已订阅=个性化货架）/ `ApplePcRadio.tsx`（广播）/ `ApplePcLibrary.tsx`（最近添加·艺人·专辑·歌曲）/ `ApplePcPlaylists.tsx`（所有播放列表·喜爱歌曲）；`src/services/appleSubscribe.ts`（购买入口）。
- `TraditionalView.tsx`：`isApplePc` 分支（左栏替换、左栏宽度 290、内容区不吃通用内边距、右栏账号卡隐藏）、`ApplePcNavKey` 导航、`PcPageId` 增 `radio/added/artists/albums/songs/playlists/favorites`、`PcNavTarget` 增 apple 变体、来源语义（资料库/播放列表 → `traditional-library`）、`appleLovedKeys`（Apple ★ 判定，随 `favoriteRevision` 刷新）、`pcChromeApple`。
- `pcKit.tsx`：`PcSkin` 增 `'apple'`（无 QQ/网易云角标、详情头图 200px），歌单/专辑/歌手详情页对 Apple 复用 PC 复刻版。
- `appleCatalog.ts`：`AppleLibraryTrack` 增 `genreName/playCount/dateAdded`，`mapAppleLibraryTrack` 从 resource 透传（缺则界面不显示该列，不编数据）；`appleLibraryTrackToSong` 透传 `playCount`。
- `desktop/main.cjs` + `preload.cjs` + `src/electron.d.ts`：新增 IPC `apple-subscribe`（1080×840 站内窗口，Chrome UA，仅放行 apple.com 域内跳转、window.open 外开浏览器），主窗口守卫不放宽。

**验证**：`npx tsc --noEmit` 0 错；`npx vitest run` 243 文件 / 2334 用例全过（新增 `test/ApplePcTraditional.test.tsx` 4 用例：左栏结构 / 订阅广告 + 购买窗口桥 / 广播版式 / 歌曲表列与过滤；`test/TraditionalView.test.tsx` 里两条 Apple 断言改为「Apple 现在也走复刻页」——非复刻平台改用 Spotify，来源语义用 Apple 客户端资料库页）。界面用临时 Vite(3105) + 无头 Chrome(CDP 9225) 逐页截图核对（浅色 + 深色、空态 + 注入 amp-api 桩的有数据版式），产物 `D:\opencode\apple-*.png`；脚本 `.tmp-appleshots.mjs` / `.tmp-appleshots-data.mjs`。
**未做/待确认**：客户端「类型/播放次数/添加日期」三列依赖 `/me/library/songs` 真带这些字段（客户端界面有这三列，推测一致）；订阅广告页的像素级版式无法与客户端逐像素比对（客户端内容页在会员过期态自身报错），如需更贴可让用户补一张客户端主页截图。

## 27. Apple 资料库「没会员就没数据」的边界摸清 + 状态修正（2026-10-08 下半场，用户追问「数据呢」）

**用户诉求**：登录但会员过期时，AM 客户端仍显示账号内容（资料库→艺人：Aimer / Dua Lipa / Hoshimachi Suisei / Macklemore / TOGENASHI TOGEARI / Umamusume: Pretty Derby / Yusuke Tanaka & TOGENASHI TOGEARI，艺人页含专辑与曲目），要求传统页补上数据；并明确「探索页已验证、和客户端基本一致」的东西可以直接用。

**实测结论（拿用户账号的真实令牌直接打 Apple 接口，evidence）**：
- `/v1/me/library/{artists,songs,albums,playlists}`、`/v1/me/recent/played/tracks` 全部 **HTTP 400 `code 40015`**：`Insufficient Privileges — User's subscription tier does not have access to privilege: CloudLibrary / ListeningHistory`。→ **会员过期后，Apple 的「账号资料库」类接口对 Web 侧（media-user-token）是硬拒绝**，换参数（platform/locale/是否带 include）都不行。
- 公开内容不受影响：`editorial/{sf}/groupings?name=radio|browse`、`catalog/{sf}/charts` 均 200 → 探索页的「广播/新发现/排行榜」和传统页广播页能拿到真实内容。
- 客户端的资料库来自**另一条通路**：客户端包里的 `AMPLibraryAgent.exe` 用的是 iTunes **iCloud Library（DAAP / MZDaap）**，服务地址由 `https://init.itunes.apple.com/bag.xml?ix=6` 的 `library-daap`（database-name「iCloud Library」）/`iap-daap`（`pd.itunes.apple.com/WebObjects/MZPurchaseDaap.woa/iap`）下发，登录态是**客户端级 Apple ID 认证**（AppleMediaServicesKit + DSID/guid；`https://radio.itunes.apple.com/libraryauth/token` 明确要求 `dsid and guid`）。我们登录窗抓到的是 **Web 会话**（media-user-token + itunes 网域 cookie；`buy.itunes…accountSummary` 对该 cookie 返回 `AccountSummaryLoginRequired`），**不具备 CloudLibrary 权限，也没有 DSID**——所以客户端能看、我们看不了。要在本软件里补上这块，只能另做「客户端级 Apple ID 登录 + DAAP 协议」，属独立项目（可行性未验证）。
- 客户端本地库落盘在 `%USERPROFILE%\Music\Apple Music\Apple Music Library.musiclibrary\Library.musicdb`，但**不是 SQLite**（`file is not a database`，私有格式），读不了也不该作为产品数据源。

**改动（不再把权限问题显示成「空空如也」）**：
- `appleCatalog.ts`：`appleMeFetch` 非 strict 分支也走 `describeAppleApiFailure` 并把结论留在 `lastAppleMeFailureMessage`（新导出 `getLastAppleMeFailureMessage()`，成功清空）；订阅失效证据同时被 `hasRecentAppleSubscriptionFailure()` 记录。
- `applePcKit.tsx` 新增 `ApplePcSubscriptionNotice`（标题「Apple Music 订阅已失效」+ **客户端官方说明**「当你的会员资格暂停后，你的 Apple Music 歌曲和播放列表将保留在资料库中，但不能播放或修改。续订后本页会自动恢复。」+ 服务层给出的具体原因 + 「免费试用」→ 站内购买窗口 + 「重试」；另加 `ApplePcGhostButton`）。
- `ApplePcLibrary.tsx`（最近添加/艺人/专辑/歌曲）与 `ApplePcPlaylists.tsx`（所有播放列表/喜爱歌曲）：**空结果 + 有失败原因**时渲染上述续订态；无失败原因时维持普通空态。
- 测试：`test/ApplePcTraditional.test.tsx` 增 1 例（订阅失效 → 续订态 + 「免费试用」调购买桥；注意 `TraditionalView` 平台侧栏也会拉 `getAppleLibrarySongs`，用例里要改 mock 实现而不是 Once）。全量 `vitest run` 241 文件 / 2337 用例全过，`tsc --noEmit` 0 错。

**真机实测（用户正在运行的应用，CDP 9223，跑完已切回原平台 soda）**：传统模式 Apple 广播页**有真实内容**（推荐单集「ROSÉ and Lizzy McAlpine / Apple Music 电台」大卡 + 「现在就听」国语/粤语流行电台方卡，Apple 官方渐变封面）；歌曲/艺人/所有播放列表/喜爱歌曲页显示上述「订阅已失效」态（含 Apple 原话与续订按钮）。截图：`D:\opencode\apple-live-*.png`（真机）、`apple-light6-*.png`（有数据版式）、`apple-light7-ad.png`（订阅广告）。
取证/验证脚本：`.tmp-appleprobe.mjs`（公开端点与 `/me` 端点矩阵探测）、`.tmp-appleprobe2.mjs`、`.tmp-appleprobe3.mjs`（逐个 `/me/*` 端点可用性）、`.tmp-appletrue.mjs`（种子真实凭据的端到端验证）、`.tmp-applelivedrive.mjs`（真机逐页截图 + 恢复平台）、`.tmp-appleexplorecheck.mjs`（真机切探索模式对照 Apple 探索页各页签，跑完恢复 viewMode）。

### 27.1 补充实测（2026-10-08 深夜，用户追问「探索页有数据、你这就没了」）

**用服务层在 Node 里直连 amp-api（绕过本机 3001 的令牌门）跑真实账号，得到干净结论**：

| 页面/数据 | 实测结果 |
|---|---|
| 主页 `fetchAppleHomePage` | `subscriptionExpired=true` + **2 个公开兜底货架**（今日热选 30 首、编辑精选歌单 16 个），fallbackReason =「Apple Music 订阅已失效，个性化推荐暂不可用，已显示公开内容」 |
| 广播 `fetchAppleRadioPage` | **13 个货架全有数据**：推荐单集 / 现在就听 / 新近内容(20) / 艺人接管麦克风(10) / 电台主持人(5) / 艺人主持节目(10) / 艺人分享(20) / 热门电台(12) / 风格电台(14) / **最近收听的电台(11，账号数据！)** / 探索更多(9) |
| 资料库 `fetchAppleLibraryPage` | **0 货架、且没有 fallbackReason**（各 library 调用静默返回空）——探索页「资料库」页签在无会员时本来就是空的 |
| `/v1/me/library/*`（含 `recently-added`）| 全部 400 / 40015 CloudLibrary；`/v1/me/recent/played` 40015 ListeningHistory；`/v1/me/recent/radio-stations` **200 ✓**；`/v1/me/account` **200 ✓** |

**真机对照**（用户应用内截图）：探索页 Apple「广播」页签有数据（推荐单集 + 现在就听 + 新近内容）＝ 传统页广播页同一份数据 ✓；探索页「主页」= 兜底文案 + 骨架（RSS 兜底货架加载慢/失败，应用内同样如此）；客户端「最近添加/艺人」有内容＝它走客户端级 iCloud 资料库通道（见上），Web 侧拿不到。

**改动**：
- `ApplePcHome`：订阅失效但**有公开兜底货架**时，订阅广告收成一张**卡片**（图标 + 标题 + 说明 + 免费试用）放在页首，下面照常渲染兜底货架 + `fallbackReason` 提示条；没有任何兜底内容时仍是整页订阅广告。未登录仍整页广告。
- 诊断注意：在**应用内浏览器路径**下探测会先打到本机 3001（有令牌门）→ 403「登录已过期」，那是假的失败；要判断 Apple 真实返回，用 `window.electron.appleApi`（主进程 IPC）或直连 amp-api（`amp-api.music.apple.com`）——`.tmp-appleprobe3.mjs` / `.tmp-appletrue.mjs` 就是这么做的。

### 27.2 「客户端同级登录 + DAAP」可行性验证：**不可行**（2026-10-08，用户点选方案 ② 后执行）

**验证步骤（全部只读，未改系统设置/未安装证书）**：
1. **客户端二进制的协议线索**（`.tmp-appledaap-strings.py`，扫 `AMPLibraryAgent.exe` / `AMP.Services.dll` / `AppleMediaServicesKit.dll`）：
   - `MZDaap` 只以「服务操作名数组」出现在 bag 解析表里（`defaultDaap` / `databases` / `items` / `containers` / `edit` / `update` / `cloudArtworkInfo` / `cloudLyricsInfo` …），**二进制里没有任何 DAAP 主机/路径字面量** → 地址是运行时按账号解析的。
   - 认证头是 **AMS（Apple Media Services）签名家族**：`X-Apple-ActionSignature`、`X-Apple-FPDISignature`、`X-Apple-MD*` / `X-Apple-AMD*`（`X-Apple-MD-M`/`-S`/`-Data`/`-Action`）、`X-Apple-ADSID`、`X-Apple-Client-Application`、`X-Apple-Store-Front`、`X-Apple-Cuid`、`X-Apple-Issuing-Process` / `X-Apple-Requesting-Process`。这些签名由 Apple 自己的客户端代码 + **FairPlay 设备身份（FPDI）** 生成。
   - DAAP 属性名表（`album-added-date`、`album-liked-state`、`song-*` …）证实客户端就是标准 DAAP 元数据字典。
2. **bag 里找不到 iCloud 资料库的 DAAP 地址**：`init.itunes.apple.com/bag.xml?ix=6` 只给了 *购买* DAAP（`pd.itunes.apple.com/WebObjects/MZPurchaseDaap.woa/iap|purchase`）；`library-daap` 只有 database-id/name（iCloud Library）与轮询频率，**没有 base-url**（对照：`iap-daap`/`purchase-daap` 都有）→ iCloud 资料库的地址只在**账号个性化 bag** 里，而个性化的前提正是第 1 条那套 AMS 认证。
3. **用我们已有的会话实测 DAAP**：拿用户 Web 会话 cookie 打 `pd.itunes.apple.com` / `p14-buy.itunes.apple.com`（客户端缓存里出现过的商店分片主机）的 `/WebObjects/MZDaap.woa/wa/{databases,defaultDaap}` → 全部 **404**（主机/路径都不存在）；`p57-itunes.apple.com`、`p14-itunes.apple.com` 直接 DNS 不存在。
4. **官方第三条路也关闭**：Apple 对第三方的 MusicKit/amp-api 就是我们在用的 Web 接口，`/v1/me/library/*` 对失效订阅一律 40015 —— 「无订阅读资料库」是 **Apple 客户端专属能力**，官方 API 不提供。

**结论与理由**：
- 想复刻，必须做到：① 账号个性化 bag（需 AMS 认证）② 每次请求带 Apple 签名的 `X-Apple-MD*/AMD*/ActionSignature/FPDISignature`（需 Apple 的客户端密钥 + FairPlay 设备身份）③ 或者退到旧版 iTunes 密码登录拿 `passwordToken`/DSID 再**猜** DAAP 主机与路径（第 3 步已证明 404，没有可猜的目标）。
- ① 和 ② 属于**冒充 Apple 自家客户端 / 绕过 Apple 的认证签名**；③ 要在我们 UI 里**收集用户的 Apple ID 密码**（当前设计刻意不接触密码，走 Apple 网页登录），且 2FA 与地址发现都不可控。
- 因此**不做**（与 27.1 里"不复用客户端凭据库"是同一类边界）。资料库在无会员时的正确形态就是现有的「准确原因 + 免费试用/续订」；续订后各页自动恢复（渲染链路已用数据验证）。

### 27.3 传统模式 Apple 复刻页补上**动态封面**（2026-10-08 深夜，用户问「为什么传统里没动态封面」）

**做法（复用探索页那套，不另写一份）**：把 `AppleExplorePanel.tsx` 里的动态封面实现**逐行抽出**到 `src/components/apple-explore/MotionArtwork.tsx`（`MotionSuspendContext` / `DynamicCover` / `motionCache`+`loadResourceMotion` / `isMotionResourceType` / `MotionArtworkCover`），探索页改为 import（行为不变，抽出的都是原注释原逻辑）；`applePcKit.tsx` 新增 `ApplePcMotionSpec` + `motionSpecOf(item, storefront)`，`ApplePcCover` 增 `motion` 参数（静态封面打底 + `MotionArtworkCover` 动画层，同一套三档可见性 400/150/1200 与负缓存）。接入：主页货架卡与 hero、广播页货架卡、资料库「专辑」网格、播放列表「所有播放列表」网格；首页/广播/资料库/播放列表四个页面都包在 `MotionSuspendContext.Provider`（`suspended` 时暂停取流并回收媒体，`TraditionalView` 已把 `suspended` 传进来）。

**实测结论（服务层直连 + 真机 DOM 双层验证）**：
- **专辑/歌单有动态封面** ✓：`fetchAppleResourceMotion('playlists'|'albums', id)` 对目录资源返回真实 HLS（如 `pl.2a0a202d…` → `mvod.itunes.apple.com/…/P1094156679_default.m3u8`）；editorial 页的歌单条目本来就带 `motionArtworkUrl`。
- **电台（stations）没有** ✗，且与探索页**一致**：① `fetchAppleResourceMotion`/`fetchApplePlaylistMotion` 内部有 `APPLE_LIBRARY_ID_PATTERN = /^(i|l|p|ra)\./` 早退，而**目录电台 id 也是 `ra.`** 前缀（实测 `ra.991169024` 等）→ 被整类挡掉；② 即使绕过，editorial 广播页返回的 station 条目 `motionArtworkUrl` 为空、`/v1/catalog/{sf}/stations/{id}?extend=editorialVideo` 也基本无动态图。**要改就得同时动服务层前缀规则 + 探索页**，本轮不动（保持两边一致）。
- 传统页真机/等价环境 DOM 实测：注入真实 HLS 后「资料库-专辑」6 张卡各有一个 `<video>`，视口内的 3 个 `readyState=4`、`paused=false`、`currentTime` 持续推进（视口外的保持 0/暂停＝可见性调度生效）。截图 `D:\opencode\apple-motion-verify-albums.png`；验证脚本 `.tmp-appleshots-data.mjs`（它的 fetch 桩已能返回 `editorialVideo` 动态封面响应）。
- ⚠️ **在用户当前（无会员）状态下传统页看不到动画**：资料库被 40015 拒、主页兜底货架在应用内加载不出来 → 没有专辑/歌单卡可动。续订后资料库的专辑/歌单卡会自动带动画封面。

**验证**：`tsc --noEmit` 0 错；`test/ApplePcTraditional.test.tsx`(6) + `test/TraditionalView.test.tsx`(35) 全过；全量 `vitest run` 2360 例中仅 2 例失败，且都在 `test/audioQualitySettings.test.ts`（QQ 音质档位 `atmos2`/`detectQQMusicSvip`）——该文件 02:36 仍在被并行改动、源码里尚无 `detectQQMusicSvip`，与本轮改动无关。

### 27.4 用户反馈两处（2026-10-08 深夜）：兜底歌单封面低清 + 搜索框要进「类别浏览」

**① 探索页主页「编辑精选歌单」部分封面发虚（新发现里同一歌单是清晰的）**
- 成因：主页兜底走 RSS（`getAppleEditorialPlaylists` → `music/most-played/N/playlists.json` 的 `artworkUrl100`，**部分歌单母版就是低清**），新发现走目录/编辑接口（`{w}x{h}` 模板，清晰）。
- 修法（`appleCatalog.getAppleEditorialPlaylists`）：RSS 结果按 `pl.` id **批量补一次目录**——`/v1/catalog/{sf}/playlists?ids=<逗号分隔>`，优先用目录的 `name/curatorName/artwork.url(模板)/trackCount`，失败/缺项回落 RSS 值。**坑：该端点与 `ids` 同用时不允许带 `limit`**（实测 400 `Limit may not be supplied on this request`）。实测目录返回 `…/thumb/…png/{w}x{h}SC.DN01.jpg?l=zh-Hans` 模板 ✓（artwork 解析会按卡片尺寸换分辨率）。
- 这一条同时惠及传统模式 Apple 主页（同一 `fetchHomeFallback` → 编辑精选歌单货架）。

**② 点搜索框应先进「类别浏览」（客户端与官网都是这样）**
- 新增 `src/features/traditionalPc/ApplePcSearch.tsx`：客户端版式（大标题「搜索」+ 40px 内边距）里**直接复用探索模式的两个组件**——`AppleMusicSearchPage`（搜索框 + Apple Music/你的资料库 范围切换 + 结果分区）+ `BrowseCategoriesLanding`（无关键词时的 apple-curators 类别浏览网格），播放/跳转全部回到 `pcActions`（歌单→`onOpenPlaylist`、专辑→`onOpenAlbum`、艺人→`onOpenArtist`、电台直接开播、行内右键→全局歌曲菜单）。
- 接线：`TraditionalView` 懒加载 `LazyApplePcSearch`；`renderPcPage('search')` 在 Apple 下换成它（`renderPage` 的 `search` 分支对 apple 也走 `renderPcPage`）；Apple 的搜索页也归入「自带版式页面」（不吃通用内边距）。
- 顺带确认：`fetchAppleSearchLanding`（`/v1/recommendations/{sf}?name=search-landing&format[resources]=map`）在**无会员**账号下正常返回 **48 个类别**（含封面）——类别浏览不依赖订阅。
- 验证：`test/ApplePcTraditional.test.tsx` 增 1 例（侧栏搜索 → 复刻搜索页 → 类别浏览网格）；真机实测（临时切 Apple → 点侧栏搜索 → 类别浏览 48 类真实封面 → 切回原平台）截图 `D:\opencodepple-live-search.png`。

### 27.5 用户反馈「广播页封面全破 + 排版塌」（2026-10-08 深夜）

**排查结论：封面地址与链路没问题，破图来自「非应用窗口」访问。**
- 本机封面代理 `GET /api/cover?url=…` **要求 `X-WaveForge-Local-Token`**（`local-server.mjs` 全局守卫：缺头一律 403 `Unauthorized local service request`），令牌只由 Electron 主进程的 `onBeforeSendHeaders`（trusted 窗口集合）注入。实测同一张 mzstatic 图：**应用窗口内 200 / image/jpeg / 127900B**；浏览器（含调试浏览器 3105）与 curl 均 **403**。→ 在浏览器里打开本 UI 时，所有 CDN 封面都会破（文字/版式正常），与用户截图完全一致；应用窗口内封面是好的（探索页正常即此原因）。
- 同时修掉两个真实缺陷（用户"排版什么都没做吗"的观感来源）：
  1. **尺寸类挂错元素**：`ApplePcCover` 的 `aspect-*`/`w-full` 之前挂在图片上，图片一失败卡片就塌成一条 alt 文本 → 现在尺寸类挂在最外层容器，图片层 `absolute inset-0 h-full w-full`（保客户端 500×324 大卡 / 方形卡版式，加载中/失败都不变）。
  2. **失败态留破图**：`CachedImage` 在 `retainPrevious` 模式下失败时不清 `imageSrc`，`fallback` 分支永远走不到 → 浏览器的「破图 + alt 文本」一直挂在页面上。现在失败且当前地址就是刚失败的代理地址时清空（有旧图仍保留），fallback 接管；`MotionArtworkCover` 的静态层也补了中性占位（探索页同受益）。
- 新增 `test/ApplePcCover.test.tsx`（4 例：尺寸类在外层 / 失败走占位且移除破图 img / 电台货架 500×324 / 网格方形保形）；

### 27.6 广播页「雷霆大图」：大卡改为等分容器宽度（2026-10-08 深夜，用户第二轮反馈）

- 问题：`ApplePcStationShelf` 用**固定像素宽**（500/420px）模拟客户端的 500×324 大卡。客户端是 1904px 窗口、内容区 1522px → 3 张 500px ≈ **每张 1/3 内容区**；我们中栏只有 ~1250px（左栏 290 + 右栏 276~320），固定 500px 一下变成"一屏 1~2 张的雷霆大图"。
- 修法：`ApplePcStationShelf` 从「固定宽横向货架」改为**响应式网格**（默认 3 列：`grid-cols-1 sm:grid-cols-2 xl:grid-cols-3`，卡宽 = 列宽、比例仍 500/324），推荐单集/节目卡走 `columns={2}`（宽幅两列）；`cardWidth` 参数移除。调用方（主页货架、广播页）同步更新。
- 验证：`test/ApplePcCover.test.tsx` 的电台卡用例改为断言「网格 + `xl:grid-cols-3` + 无 `overflow-x-auto` + 无固定像素宽 + 卡片保留 500/324 比例」；

### 27.7 广播/主页改为**直接嵌入探索面板**（2026-10-08 深夜，用户：「不能直接把探索页的布局搬到中间一栏吗，非要自己做」）

- 做法：`AppleExplorePanel` 新增两个开关——`initialTab?: AmTab`（初始页签）与 `chrome?: 'full' | 'none'`（`none` 时隐藏面板自己的页签条 + 商店 chip，导航交给传统模式左栏）。传统模式的 **广播页** = `ApplePcTitle('广播') + <AppleExplorePanel initialTab="radio" chrome="none" …/>`；**主页** = 订阅广告（未登录整页 / 订阅失效页首卡片）+ `<AppleExplorePanel initialTab="home" chrome="none" …/>`。播放/右键菜单回 `pcActions`，歌单/专辑/艺人详情走传统模式既有页面（`onOpenPlaylistPanel`/`onOpenAlbum`/`onOpenArtistPanel` 三个回调）。
- 结果：传统页与探索页的卡片、货架、抽屉、动态封面**完全同一份实现**，不再有「两边长得不一样、各自优化」的问题。
- 随之删除自绘的 `ApplePcStationShelf` / `ApplePcCardShelf` / `ApplePcSectionTitle` / `motionSpecOf` / `appleSongKey`（`applePcKit` 只保留封面/网格/表格/空态/按钮/订阅提示等仍被资料库与播放列表页使用的基件），`test/ApplePcCover.test.tsx` 同步去掉电台货架用例。
- 测试提示：页面按需懒加载，全量跑（并行 240+ 文件）时首次动态 import 会超过 testing-library 默认 1s 等待——`test/ApplePcTraditional.test.tsx` 已 `configure({ asyncUtilTimeout: 5000 })`（单跑通过、全量偶发失败就是这个原因）。
- 验证：`tsc` 0 错；全量 `vitest` **244 文件 / 2376 用例全过**；验证环境实测传统广播页渲染出面板内容（「电台精选 / Apple Music 官方频道与电台 + 电台卡货架」，页签条已隐藏）截图 `D:\opencodepple-panel-radio.png`；dist 已重建。

### 27.8 广播页封面两处修正（2026-10-08 下午，用户：「裁切有问题吧/电台主持人这种封面就没了」）

**结论先行：两个都不是会员问题**（编辑内容不依赖订阅；同一账号的探索页/传统页同源取数，会员态只影响 `/me/library`）。实测接口后定位到两处取图缺陷：

1. **「现在就听」大卡标题被裁**：这类电台的封面是 **4320×1080 宽幅合成图**（`{w}x{h}{c}` 或已展开的 `600x600cc`，字标/标题烤在画面里）。此前 `itemize` 走 `extractEditorialArtworkUrl`→`toHighResArtwork` 强制 **600×600 居中方裁**，把字裁掉了（官网按宽卡比例取图）。
   修法：`extractEditorialArtworkUrl` 与新的 `artworkUrlForCard` 对**源图宽高比 < 0.6 的横图**改按 **16:9（960×540）** 请求；数字形态（`600x600cc`）先还原成 `{w}x{h}` 模板再替换。
2. **「Apple Music 电台主持人 / 艺人主持节目」整排无封面**：这两区是 `[385] 容器 → [394] 节目卡` 结构，**394 元素自己带 4320×1080 的 artwork**，而 contents 里的 radio-shows 不带图；此前 385 分支只看 contents → 整排空。修法：385 分支优先用 394 自带图（`artworkAtSize(showAttrs.artwork, 960, 540)`），回落 station 普通封面。

**验证**：服务层探针实测 URL 已变为 `…/960x540cc.jpg`（主持人/艺人主持节目两区每条都有图），两张样图直连 200（48KB / 199KB image/jpeg）；`tsc`（排除并行改动的 ExploreView/musicApi）0 错；Apple 相关测试 49 例全过；dist 已重建。
**环境噪音**（与本轮无关，均因并行改动）：全量 vitest 有 10 例失败全部集中在酷狗（`KugouExplorePage` 「刷歌」分区已被并行下线、测试仍断言三区；`kugouExploreIsolation`/`kugouYouthFeed` 的源码文本断言对不上新源码）；`tsc` 在 `ExploreView.tsx`（accountTierBadge*）与 `musicApi.ts`（soda url 类型）的报错同样是并行在途代码。验证环境（stub harness 喂 6 个电台）截图 `D:\opencodepple-layout-radio.png` 实测 **每行 3 张、每张约内容区 1/3**，标签在卡上方，与客户端一致。`tsc` 排除并行改动的 `ExploreView.tsx` 后 0 错；Apple 相关测试 11 例全过；dist 已重建。`tsc` 0 错；全量 `vitest` 2370 例中仅 1 例失败——`test/kugouExploreIsolation.test.ts` 是对 `ExploreView.tsx` 源码文本的断言，而该文件 03:15 正被并行改动（断言字符串已不在源码里），与本轮无关。dist 已重建。
