# Apple Music 原生音源调查与下一步（2026-08-30）

> 背景：用户反馈「已支持 Apple Music 登录与播放，但后台实际用的是 QQ/网易云兜底音源」。
> 本文是完整调查结论与后续路线，接手者从这里继续。

## 一、已修复的 Bug（全部实测验证）

| # | 问题 | 修复位置 |
|---|---|---|
| 1 | Apple 热歌榜歌曲丢失目录 id（用榜单排名当 id），原生取流被静默跳过 | `appleCatalog.ts getAppleChartGroups`（保留 RSS id）、`appleExploreService.ts`（透传 appleId）、`exploreApi.ts fetchExploreChart`（Song 带 appleId）；`EXPLORE_CACHE_KEY` 升级 v3 |
| 2 | 资料库/喜爱歌曲歌单用错转换器（资料库 id `i.xxx` 当目录 id，license 必败） | `HomeView`×2、`ProfileView`×2、`DesktopView`×1 改用 `appleLibraryTrackToSong`（取 catalog 关联 id） |
| 3 | license 协议错误（`license-requests` 数组 + `adam-id` 是 offers 分支格式）+ hls.js 1.7 回调签名错误 + `drmSystems` 短键名导致证书加载失败 | `applePlayback.ts createAppleHlsConfig`：平铺协议（challenge/uri/key-system/adamId/isLibrary/user-initiated）、`licenseXhrSetup(xhr,url,keyContext,challenge)` 4 参签名、`drmSystems['com.widevine.alpha']` 完整键名 |
| 4 | PSSH 构造与 MusicKit 不同（v1 kid-list 56 字节 → Apple 拒收） | `buildWidevinePssh` 改为 52 字节 v0 + protobuf `08 01 12 10 <KID>`（Chrome 抓包逐字节同构） |
| 5 | 榜单探索缓存按天缓存坏数据 | `EXPLORE_CACHE_KEY` v2→v3 |
| 6 | 经典 CDM 组件播种抢占 castlabs CUS 注册位 | `main.cjs seedEcsOfflineCdm`：先给 CUS 15s 下载窗口，失败才播种兜底；支持版本升级 |
| 7 | license 请求走本地代理（`POST /api/apple/license`）补 `music.apple.com` Origin/Referer（渲染进程直连会被来源校验拒绝） | `local-server.mjs` |
| 8 | Apple web 登录会话 Cookie 持久化（license 接口需要会话 Cookie） | `main.cjs` 登录收尾写 `userData/apple-web-cookies.json`，代理读取附带 |

## 二、最终结论（2026-08-30）

早期将 -1021 归因于“Apple 只接受 Windows MF CDM、拒绝 Browser L3”是错误假设。castLabs 官方在 issue #234 确认 MF CDM/L1 是已废弃的历史实验，从未支持 VMP；正确生产路径是 ECS 默认 Browser CDM（软件 L3）+ production VMP。

严格重做的实时 E2E 实验使用生产 PSSH/body/session：52-byte PSSH v0 + protobuf KID、flat license body、同一开发者令牌/用户令牌/网页 Cookie、实时 generateRequest，并把 license 更新回同一个 MediaKeySession。

| VMP 身份 | Apple 响应 | 结果 |
|---|---|---|
| castLabs development VMP | HTTP 200，status=-1021，errorCode=-42605 | 拒绝 |
| EVS production streaming VMP | HTTP 200，license=648 bytes | session.update 成功，keyStatuses=usable |

结论：**WaveForge 已通过 Electron ECS Browser CDM L3 播放 Apple Music 原生 CENC 音源。** WebView2 仅作为 L3/CENC 异常时的兼容兜底，不是主路径。

## 三、生产构建要求

- 当前 Electron 42.8.0 Browser CDM 4.10.3050.0 可用；ECS v42 使用 `streaming` VMP，不使用已移除的 persistent-license 路径。
- Windows 发布采用明确两阶段：`electron-builder --win dir` → EVS `sign-pkg --streaming` / `verify-pkg` → `electron-builder --prepackaged ... nsis`。不依赖无 Authenticode 时可能跳过的 `afterSign`。
- 最终安装后的主 EXE 与 `.sig` 和签名目录哈希完全一致，官方 verify 为 streaming，剩余 1417 天。
- 发布环境必须设置 `EVS_ACCOUNT_NAME`、`EVS_PASSWD`；签名失败会直接阻断 Windows 发布。
- Windows 正确顺序：electron-builder 修改 EXE → Authenticode（若有）→ EVS VMP → 制作安装包；VMP 后不能再修改 EXE。
- Apple license 本地代理必须透传 `Media-User-Token`、Authorization、网页 Cookie；旧 `X-Apple-Music-User-Token` 入站头也兼容。

## 四、本次新增的有用资产

- `scripts/probe-apple-playback.cjs`：webPlayback+清单自检
- `scripts/probe-apple-widevine-license.cjs` + `scripts/probe-apple-l3-preload.cjs`：Electron CDM license E2E 探针
- license 代理：`POST localhost:3001/api/apple/license`（附带 Cookie，日志不输出凭据）

## 五、运行边界

- WebView2 只在原生 CENC 失败或用户从设置页手动打开时启动，不在应用启动时预热。
- WebView2 使用独立持久化会话；首次启用兼容兜底时可能需要在播放窗口内登录一次。
- 本地 bridge 固定绑定 `127.0.0.1:18790`，所有请求必须携带主进程生成的随机会话令牌。
- 用户侧探索缓存升级后首次进入会重新拉取，这是预期行为。
