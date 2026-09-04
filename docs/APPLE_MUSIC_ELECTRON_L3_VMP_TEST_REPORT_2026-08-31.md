# Apple Music Electron 原生 CENC / VMP 严格验证报告

> 测试日期：2026-08-31
> 项目：WaveForge 澜音工坊
> 平台：Windows 11 x64
> ECS：castLabs Electron 42.8.0 / Chromium 148
> Widevine Browser CDM：4.10.3050.0
> 结论：**Apple Music 可以通过 Electron 内的 Widevine Browser CDM（软件 L3）播放完整 CENC 音源；关键门槛是 EVS production streaming VMP，而不是 Media Foundation CDM。**

## 1. 背景与历史更正

早期调查曾把 Apple license 的 `status=-1021 / errorCode=-42605` 归因于：

> Apple Music 只接受 Windows Media Foundation Widevine CDM，拒绝 Electron 的 Browser CDM L3。

castLabs 在公开 issue [castlabs/electron-releases#234](https://github.com/castlabs/electron-releases/issues/234) 中明确更正：

- Windows MF CDM/L1 只是历史实验；
- 该路径从未支持 VMP，且已在近期 Chromium/ECS 中废弃；
- 正确路线是 ECS 默认的 Widevine Browser CDM L3；
- 商业服务可能要求生产 VMP 身份。

随后对旧实验进行审计，发现旧探针混入了以下变量，无法证明 MF-vs-L3：

- 56-byte PSSH v1 kid-list，而非 MusicKit 使用的 52-byte PSSH v0 + protobuf KID；
- 旧 `license-requests[]` 请求体，而非生产 flat body；
- Cookie/session/token 来源不同；
- 保存后重放旧 challenge，而非实时 challenge；
- challenge 没有更新回创建它的同一个 `MediaKeySession`。

因此重新设计了严格 A/B。

## 2. 严格实验约束

探针：`scripts/probe-apple-widevine-license.cjs`

两组实验固定以下条件不变：

- 同一个 `electron.exe`；
- 同一个 Widevine Browser CDM 4.10.3050.0；
- 同一首 Apple catalog 歌曲；
- 同一组 Developer Token / Media User Token / Apple 网页 Cookie；
- 同一份 CENC rphq HLS 资产；
- 同一 16-byte KID；
- 52-byte Widevine PSSH v0：`08 01 12 10 <KID>`；
- flat Apple license body：

```json
{
  "challenge": "<base64>",
  "uri": "<original CENC key data URI>",
  "key-system": "com.widevine.alpha",
  "adamId": "<catalog id>",
  "isLibrary": false,
  "user-initiated": true
}
```

- 每组均实时 `generateRequest('cenc', pssh)`；
- challenge 立即提交；
- license 更新回产生 challenge 的同一个 session；
- 不输出或落盘任何 token/cookie 值，只记录 hash、长度、HTTP/Apple status 和 key status。

唯一变化：`electron.exe.sig` 的 VMP身份。

## 3. A/B 结果

### A. castLabs development VMP

官方 ECS 包自带的 `.sig` 密码学验证有效，但证书仅允许 development/UAT client。

结果：

```text
PSSH bytes:       52
CDM challenge:    5106 bytes
server cert:      accepted
HTTP:             200
Apple status:     -1021
Apple errorCode:  -42605
license:          none
```

### B. EVS production streaming VMP

EVS 工具：`castlabs-evs 1.3.2`

```text
EVS mode:         streaming
signature:        valid
remaining:        1417 days
```

在同一 EXE 上仅替换相邻 `.sig` 后重跑：

```text
PSSH bytes:       52
CDM challenge:    5058 bytes
server cert:      accepted
HTTP:             200
license:          648 bytes
session.update:   success
keyStatuses:      usable
```

严格 A/B 证明：

> Apple Music 的 Electron 原生 CENC 路线可用；此前的 -1021 是 development VMP 身份被拒，而不是 Browser CDM L3 不受支持。

## 4. 产品代码中同步修复的问题

除了 VMP 身份，还修复了两个会独立造成 `0:00`/license失败的产品问题：

1. **Media User Token 在本地代理边界丢失**
   - renderer 历史上发送 `X-Apple-Music-User-Token`；
   - license代理只读取 `Media-User-Token`；
   - 现在兼容两种入站头，并统一转发为 Apple 私有接口需要的 `Media-User-Token`。

2. **hls.js 过早报告成功**
   - 旧代码在 `MANIFEST_PARSED/LEVEL_LOADED` 时 resolve；
   - 此时 license/首个加密分片可能尚未成功；
   - 现在等待 `FRAG_BUFFERED` / `canplay` / `loadeddata`，避免 UI 假播放 0:00。

最终播放路由：

```text
Apple 歌曲
  → Electron ECS Browser CDM L3 + CENC HLS（主路径）
  → WebView2 播放面（仅 CENC/EME 失败时兼容兜底）
  → 网易云/QQ 同款载体（最后兜底）
```

正常原生路径进入 WaveForge 本地 audio deck / Web Audio graph，因此保留：

- 进度、歌词；
- 本地频谱与波形；
- MV背景同步；
- 播放/暂停/seek/音量；
- 输出设备、音效、响度；
- Gapless / Crossfade / AutoMix 能力。

## 5. 开发态与发布态边界

### 日常开发：不需要每次生成 EXE/安装包

开发仍使用：

```bash
npm run dev:electron
```

或项目既有的 Vite + ECS Electron 开发启动方式。

注意：

- 官方 ECS 下载包只带 development VMP；
- 若要在开发态真实测试 Apple原生 license，需要对 `node_modules/electron/dist` 做一次 EVS production streaming签名；
- 只有重装/升级 ECS、或 EXE发生变化时才需要重签，不是每次前端热更新都签。

命令：

```bash
npm run vmp:sign:dev
npm run vmp:verify:dev
```

### 正式发布：构建机签名一次，最终用户不做任何签名

发布流程采用明确两阶段：

```text
electron-builder --win dir
→ EVS sign-pkg --streaming release/win-unpacked
→ EVS verify-pkg release/win-unpacked
→ electron-builder --prepackaged release/win-unpacked --win nsis
```

最终安装目录必须包含：

```text
WaveForge 澜音工坊.exe
WaveForge 澜音工坊.exe.sig
```

最终用户：

- 不安装 EVS；
- 不注册 castLabs；
- 不配置签名；
- 不安装系统 Python；
- 只需在 WaveForge 内登录 Apple Music，并且账号有有效订阅，即可播放完整版 Apple原生音源。

EVS账号/密码仅存在于开发者构建机或 CI secrets，不能打包进应用。

## 6. 构建与 CI 约束

生产 VMP签名失败时必须阻断Windows发布，不能上传“能安装但Apple原生播放必失败”的包。

CI secrets：

```text
EVS_ACCOUNT_NAME
EVS_PASSWD
```

构建前需安装：

```bash
py -3 -m pip install --upgrade castlabs-evs
```

VMP必须在所有EXE修改/Authenticode之后执行；VMP签名后不能再修改主EXE。

## 7. 可复现实验命令

严格探针需要：

- 本机WaveForge Apple登录态；
- Vite 3000；
- local-server 3001；
- 不同时运行另一个占用同一 Electron profile 的 WaveForge实例。

```bash
node_modules/.bin/electron scripts/probe-apple-widevine-license.cjs <catalogSongId>
```

成功标志：

```text
ok: true
licenseBytes: 648
keyStatuses: usable
```

## 8. 相关公开记录

- castLabs issue：<https://github.com/castlabs/electron-releases/issues/234>
- 最终 A/B 结果评论：<https://github.com/castlabs/electron-releases/issues/234#issuecomment-5474927467>

本报告不包含任何 Apple token、Cookie、EVS密码或私钥。
