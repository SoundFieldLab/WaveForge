# 双 AI 协作交接文档（TV 审计修复 × Apple 播放支持）

本文件记录两个并行 AI 在同一工作区（master）的改动边界、冲突分析与待办，便于双方（或人工）追溯与后续开发。

> **提交范围说明**：本 AI（TV 审计修复）只提交**纯自己的改动**（见 A 节），
> 另一个 AI 的 Apple 播放支持改动**保留在工作区未提交**（见 B 节），由它（或人工）自行提交。
> 混合文件（HomeView.tsx、SettingsPanel.tsx）中本 AI 的小改动因与 Apple 改动同文件，
> 暂留工作区，待 Apple 工作提交后随之下一次提交。

---

## A. 本 AI 的改动：TV 端完整审计 + 修复

### 审计范围（4 维度，发现 20+ 问题）
- 空间导航/软键盘/BACK 栈（src/tv/tvCore.ts、TvKeyboard.tsx）
- 手机遥控链路（remote-server.cjs、remote-ui.html、remoteBridge.ts、RemoteCursor.tsx）
- 兼容性/原生桥（MainActivity.kt、electronShim.ts、SplashView.kt、vite.android.config.ts）
- 功能缺失/性能降级（perfMode、AutoMix、播放器/设置面板 TV 分支）

### 已提交（`7ad3a45`，不依赖 Apple 重构）
- `desktop/remote-server.cjs`：cursor 命令补 broadcast（TV 触摸板此前全灭）
- `android/.../MainActivity.kt`：BACK 键派发 DOM + `reportBackConsumed` 上报（此前 BACK 直接退应用）；`nodeStarted` 改进程级 static（此前重复启动泄漏）
- `local-server.mjs`：CORS 白名单放行 `localhost:3001`（TV POST 此前全 403）
- `vite.android.config.ts`：`build.target: 'es2017'`（老 WebView 白屏）

### 本次提交（与 Apple 改动混合，见提交信息）
- `src/tv/tvCore.ts`：`useTvBack` ref 模式稳定 BACK 栈；横向列表导航（overflowX + 左右裁剪项保留）；容器首尾滚动余量校验；焦点环跟随动画/卸载清理/scopes 惰性剔除；焦点环尺寸按屏幕缩放（4K 可见）；`ResizeObserver` 守卫；`setKeyboardActive` 断连兜底；BACK 消费后 `reportBackConsumed`
- `src/tv/TvKeyboard.tsx`：useTvBack 按 target 提升优先级
- `src/services/autoMixAnalysisService.ts`：TV 端跳过浏览器整曲解码（数百 MB 开销），直接元数据回退
- `src/components/PlaylistPanel.tsx`：智能重排按钮 TV 隐藏（TV 必失败）
- `src/components/HomeView.tsx`：`showHeavyVisuals = !isTvModeActive() || perfMode==='enhanced'`（修复 PC 动态背景回归）
- `src/electronShim.ts`：`getSystemVolume` 返回 `success:true`（此前 TV 音量补偿短路）
- `src/components/RemoteCursor.tsx`：合成 click 命中输入框时手动 `focus()`（远程输入链）
- `src/components/RemoteControlModal.tsx`：轮询路径也做"新设备连入自动收起"
- `src/components/RemoteControlSettingsModal.tsx`：TV 下过滤"桌面歌词"动作
- `src/components/SettingsPanel.tsx`：About tab 设备授权（桌面兑换码）TV 隐藏
- 其余（ExploreView/ExploreSettingsPanel 封面墙自定义等）为前几轮已提交内容

### 待办/建议
- 真机验证：BACK 键转发、触摸板光标、POST（登录/兑换码）不再 403
- 老 WebView 降级后需在低版本真机回归（`build.target` 生效后 bundle 是否仍正常）
- 状态回显（手机页播放状态）、TV 遥控个性化持久化（P1 未做，需后端 + SPA 状态推送）

---

## B. 另一 AI 的改动：Apple Music 播放支持（进行到可编译阶段）

### 改动主题
- 新增平台类型 `src/services/platforms.ts`（`MusicPlatform` 含 'apple'）
- Apple 曲目统一转换为可播放载体：`src/services/appleCatalog.ts`（+463 行）、App.tsx 的 `resolvePlayableSong` 路径（匹配失败提示并跳下一首）
- Apple 探索独立服务 `src/services/appleExploreService.ts`（新增）、删除 `src/components/AppleExploreView.tsx`
- Apple 登录态 `appleAuth.ts` / `appleMusicToken.ts`（新增）
- 波及：musicApi/exploreApi/playlistService/homeModules/fusedSearch/cacheManager/indexedDBCache 等类型与调用适配；HomeView/ProfileView/SearchPanel/ModuleCustomizeModal/DesktopView 等组件适配 `MusicPlatform`
- `desktop/main.cjs`、`desktop/preload.cjs`、`public/v3-worklet.js` 有配套改动

### 冲突分析（已确认）
- 与本 AI 的 TV 修复**区域不重叠**：Apple 改动集中在服务层/平台类型/Apple 组件；TV 改动集中在 tvCore/TvKeyboard/遥控链路/设置面板 TV 分支
- 全量 `tsc --noEmit` 通过
- 双方共同触碰的文件（App.tsx、SettingsPanel.tsx、electronShim.ts、autoMixAnalysisService.ts、ExploreView 等）改动位置不同，无逻辑冲突

### 待办/建议（另一 AI 接手时）
- 复核 `MusicPlatform` 在 TV 端（apple 平台探索/播放）的 UI 与降级
- Apple 播放实际链路真机/浏览器验证（resolvePlayableSong 匹配逻辑、失败跳下一首）
- 确认 `v3-worklet.js` 与 `desktop/main.cjs` 的配套改动与本次提交一致
- 如后续继续改，建议基于当前 master 重新拉取（本次已整体 push）
