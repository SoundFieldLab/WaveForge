# Folia 对标研究：全平台登录机制 + Spotify 方案 + 跨平台匹配审计

> 2026-10-20（第二版，覆盖第一版）。来源：本机安装的 Folia（`D:\folia\resources\app.asar`），
> 解包研究代码在 `D:\opencode\wf_folia_study\`。第一版（登录诊断体系）见文末附录。
>
> 本版新增：① folia 六个平台的登录机制逐个拆解；② Spotify 采用 folia 方案（librespot）
> + 非 Premium 自动降级的完整设计；③ WaveForge 跨平台匹配机制（resolvePlayableSong）
> 与「平台可用性增强」开关的审计结论。

---

## 一、Folia 六个平台的登录机制

| 平台 | 登录方式 | 凭据存放 | 特殊处理 |
|---|---|---|---|
| **酷狗** | 扫码（`register_dev` 设备注册 → `login_qr_key/create/check`），走内嵌 KuGouMusicApi | cookie map（token/userid/dfid）safeStorage 加密，V2 信封版本化 | Linux 拒绝 `basic_text` 后端（等于明文）；响应给渲染层前剥掉 token/dfid/cookie（`sanitizeRendererBody`）；设备校验失败自动重注册重试 |
| **网易云** | 内嵌 `@neteasecloudmusicapienhanced/api` 起本地服务（工作线程，127.0.0.1），扫码 | cookie 在主进程侧 | ①**替换上游 `login_qr_check`**（上游出错会把网易真实风控码吞成 404，folia 直连 `/api/login/qrcode/client/login` 拿真实码）；②扫码请求网络层失败自动重试一次（逐连接偶发重置）；③**连接被重置后轮换身份**：deviceId + MUSIC_A 匿名 token 标记「待轮换」，到下次要码才真正换——同一轮扫码身份始终一致；④断网时后端标记 `offline`，下一个请求到来时隔 10s 重拉 |
| **QQ 音乐** | 扫码（内嵌 `@yakult-green-tea/qq-music-api`，MQTT 推送通道）+ 微信扫码 | 主进程加密凭据仓库 | 给包挂只读钩子抓真实失败原因（failSession/failBootstrap + qq-auth.* 日志）；upstreamCode 20279 → device-limit 分类；扫码渠道动态探测（login_channels），`qqmusic` 渠道被 seal 时隐藏 |
| **波点（bodian）** | `bodian-music-api` 包（uid + token），包自带登录协议 | safeStorage 加密（BODIAN_SESSION_V2，校验 uid 为 1-20 位数字） | 随机 deviceId 持久化；加密不可用时仅本次运行有效 |
| **YT Music** | **系统浏览器登录**：Google 拒绝 Electron 窗口内的登录，folia 启动用户自己浏览器（独立 profile 文件夹）让人登录，之后同一浏览器 headless 重启同 profile，经调试管道读 cookie | Cookie 整体 safeStorage 加密（YTM_WEB_SESSION_V1） | 最讲究的一个：①开窗与读 cookie 是两次独立浏览器运行（带调试开关的窗口会被页面识别为程序驱动）；②账号头（Cookie/Authorization/X-Goog-*）只允许发往 youtube.com 两个域，重定向直接 error 不跟；③UA 精确到本 app 的 Chrome 主版本；④profile 文件夹含整个 Google 会话，删除时有进程清理与重试；⑤10 分钟登录窗口超时后读已落盘 cookie（人登录完没关窗也算数） |
| **Spotify** | OAuth 2.0 + PKCE，**用户自己的浏览器**，回调 127.0.0.1:5588/login（本地起 HTTP listener） | token 存主进程 + safeStorage，渲染层只见账号 id 的 sha256 摘要 | client_id `65b708073fc0480ea92a077233ca87bd`（librespot 系播放器共用）；scope 为 librespot 的 26 项；10 分钟尝试窗；state 校验防旧标签页串扰；回跳页本地 HTML 提示"已登录可回到 Folia" |

**共同设计原则**（WaveForge 可整体借鉴）：

1. **凭据永不进渲染层**：全部平台 token/cookie 收敛在主进程 + safeStorage（Linux 上明确拒绝
   `basic_text` 明文后端），渲染层只拿显示用摘要（用户名/头像/id 摘要）。酷狗甚至把登录响应里的
   token/dfid 在出主进程前剥掉。
2. **真实错误透传**：每个上游包外面都包一层「错误翻译」，不让包的白名单失败类别遮蔽真实原因。
3. **凭据加密不可用 ≠ 登录失败**：降级为"本次运行有效"，警告但不阻断。
4. **自检域名表跟随登录链路**：每个后端带 `selfCheckHosts`（如网易三个 interface 域、QQ 四个上游域）。

---

## 二、Spotify 落地方案（采用 folia 路线 + 非 Premium 降级）

### 2.1 整体结构

```
登录    OAuth 2.0 + PKCE（改造现有 desktop/main.cjs 的授权码流程）
        - client_id 不变（65b7…87bd）
        - 加 PKCE：code_verifier(64B)/code_challenge(S256)，token 请求带 code_verifier
        - redirect 端口：folia 实测值 5588；若坚持 8000 必须先实测 Spotify 是否认
          （它在用户登录之后才校验 redirect）。默认跟随 folia 用 5588，8000 留作自定义
        - scope 换成 librespot 的 26 项（现在缺 streaming/user-modify-playback-state 等）
        - state 校验保留（已有），10 分钟尝试窗

会话    token 收敛主进程 + safeStorage（对齐 folia；渲染层 secureTokenStore 保留兼容读取，
        新链路写主进程仓库）。刷新：过期前 60s，单飞；invalid_grant → 清会话

数据面  保留现有 spotifyService.ts（官方 Web API 读搜索/歌单/收藏——已工作）。
        ⚠️ 但播放所需曲目元数据（可播性、音频格式）以 librespot 的
        resolveAudioFileAsync 为准，Web API 的 availability 不作数

音频面  新增 desktop/spotify/（对齐 folia）：
        - @lox-audioserver/node-librespot（optionalDependencies，win32-x64 有 prebuilt
          .node；加载失败 → 播放能力降级，其余功能不受影响）
        - librespot.createSession({ accessToken, clientId, deviceName })，
          session.resolveAudioFileAsync({ uri, bitrate }) → { cdnUrl, keyHex, format }
        - 自定义协议 waveforge-spotify://audio/<trackId>?k=<key>：
          Range 取 CDN 加密字节 → AES-128-CTR（IV 72e0…0d93，counter=offset/16）
          在线解密流给 <audio>；Ogg 有 0xa7 前置页要 skip；密钥只在内存
        - getSongUrl('spotify') 返回该协议 URL（主进程经 IPC 把 key 交给协议 handler）
```

### 2.2 非 Premium 自动降级（用户要求的口径）

登录成功后从 `/me` 读 `product`（现有链路已读，见 App.tsx:8830-8845，已映射
`entitlementTierFromSpotifyProduct`：`premium→vip`、`free/open→free`）。分档行为：

| 档位 | 播放行为 |
|---|---|
| `premium` | librespot 直连播放（folia 同款） |
| `free` / `open` | **自动降级为现有载体匹配**（resolvePlayableSong → 网易云/QQ 同款），UI 上登录态正常、平台标记"免费版·借源播放" |
| `unknown`（/me 未返回或刷新失败） | 按 free 处理（保守），后台重试读取 |

实现要点：

1. **降级开关挂在现有 `playAsCarrier` 能力位上**：`getPlatformCapabilities('spotify').playAsCarrier`
   从写死的 `false` 改为动态计算 —— `product === 'premium' && librespot 可用 ? false : true`。
   `needsCarrier`（App.tsx:6453）已是能力驱动的写法，无需大改。
2. **Premium 但 librespot 加载失败**（非 win-x64 / prebuilt 缺失）：同样降级 + 提示
   "Spotify 播放组件在该系统不可用，已借网易云/QQ 出声"。
3. **Premium 播放中途被拒**（账号降级、family 限制、曲目仅付费可听）：
   `resolveAudioFileAsync` 报 not-playable/subscription-required → 单曲即时降级走载体匹配，
   同时触发一次 profile 重读更新 product。复用现有 kugou/soda 的"播放失败 → 匹配兜底"分支
   （App.tsx:6619 的 crossPlatformFallback 逻辑，见 2.4 开关问题）。
4. **降级提示口径**：对齐现有汽水的 toast 文案风格（"Spotify 免费版·正在播放网易云同款"），
   歌单行尾"补"标记复用 crossFillRegistry。

### 2.3 pathfinder 内部 API（可选，第二阶段）

folia 不用 `api.spotify.com`（对它这类登录恒 429），改走 Spotify 自家客户端的两个内部服务：
pathfinder（`api-partner.spotify.com/pathfinder/v2/query`，14 个固定 sha256 查询 + 6 个变更）
和 spclient。**查询 hash 会随 Spotify 版本漂移**（folia 是 2026-10-08 手抓的），引入即背上
"定期更新 hash"的维护义务。建议：第一阶段不做，官方 Web API 的搜索/歌单够用；
若发现 Web API 对我们的登录也开始 429，再引入 pathfinder 常量表。

### 2.4 ⚠️ 现有 OAuth 的两个真 bug（顺手修）

1. **token 交换请求没有 PKCE 也没错**：现在 token 端点请求不带 `code_verifier`
   （main.cjs:5360 一带），authorize 时也没有 `code_challenge`。对 spotifyd 这个 client
   属于"碰巧能用"（该 client 未强制 PKCE），但换任何自定义 Client ID 就会失败——
   而设置面板恰好在引导用户配自己的 Client ID。上 PKCE 后两边都覆盖。
2. **token 明文经 IPC 回渲染层**：`finish(result)` 把 access/refresh token 发给渲染层再写
   secureTokenStore。改造后 token 留主进程仓库，IPC 只回 username/avatar/product/id。

---

## 三、跨平台匹配机制审计（resolvePlayableSong + 开关）

### 3.1 开关现状：**Spotify 播放不受开关控制，与文案矛盾**

「平台可用性增强」（`crossPlatformFallbackEnabled`，默认 **false**，开启需 20s 倒计时免责声明）
注释写"酷狗/汽水无论开关如何都会匹配、QQ 完全不匹配，与设置文案不符；现在统一受开关控制"
（App.tsx:6617）。但实际上**spotify/apple 两条路径仍然绕过开关**：

- `needsCarrier`（App.tsx:6453）：apple/spotify 无条件 `resolvePlayableSong`，
  **不读 crossPlatformFallbackEnabled** → 开关关闭时 Spotify 歌照样借网易云/QQ 出声。
- `analyzeSongForSequencing`（App.tsx:5991）：`platform === 'apple'` 无条件解析，同样不看开关。
- 预载路径（App.tsx:5766）：apple 无条件解析。
- WebView2 回退（App.tsx:6793）：无条件解析。

这正好和用户的要求冲突：**Spotify 载体匹配应受「平台可用性增强」开关约束**——
开关关 → Spotify 免费版直接提示"未找到可播放版本"（或引导开启开关），静默借源等于
功能虚设。落法：`needsCarrier` 分支进入前先读开关；关闭时 apple 保持现状（apple 的
注释口径是"无法直接播放"，历史行为保留）**还是一并约束，需要你定**；spotify 按开关走。

### 3.2 匹配算法本身：正确，但有三个具体问题

`findPlayableAppleSong`（appleCatalog.ts:175）评分：标题精确 100 / 包含 35、艺人精确 40 /
包含 15、时长 ±2s 15 / ±6s 6、门槛 60、VIP 候选对非会员载体 -30。方向正确、注释显示已修过
一轮误命中。问题：

1. **`vip` 标志覆盖不全，VIP 降权部分失效**。`consider()` 只看 `song.vip`，但：
   - 网易云搜索结果映射了 `vip: song.vip`（musicApi.ts:683）✓；QQ 搜索 ✓（656）；
   - 酷狗 `kugouTrackToSong` 需确认（kugouService.ts:3080 附近的 `vip: item.pay?.payplay === 1`
     是另一条路径）；汽水结果没有可见的 vip 映射。
   - 更结构性的：Song 上已有更精确的 `requiredTier`（musicApi.ts:354，'free'|'vip'|'svip'），
     但 `consider()` 完全没用它。**建议统一改为读 requiredTier**（svip -30、vip -30、free 0），
     旧数据按 vip 处理（字段注释已有此约定）。
2. **isCarrierVip 读的 localStorage 键会过期**：`netease_vip`/`qq_vip` 是登录链路落盘的快照，
   会员过期但没重新登录时键值不更新 → 会把"载体会员可用"判成 false，给 VIP 候选 -30，
   优先选了免费候选但免费候选实际播不了（或反过来）。低频发生，但和 spotifyEntitlement 的
   维护方式（登录/过期事件即时更新）不一致，值得统一。
3. **sources 集合硬编码两平台**：`resolvePlayableSong` 里 apple/spotify 来源固定
   `['netease','qq']`（QQ 曲目补源是 `['netease','kugou']`）。酷狗/汽水登录且可用时
   不参与载体候选——加进来能提高命中率，但每次匹配多一路搜索请求。建议跟随
   "该平台已登录 + 开关开"动态扩展，搜索并行发出（现有 Promise.allSettled 结构直接支持）。

### 3.3 匹配链路的两个小问题

- **匹配时不知道载体平台是否已登录**：网易云载体 URL 请求带 cookie，未登录时免费歌
  能播但 VIP 候选 -30 后选中的免费版本可能在未登录网易云上也是灰的。匹配前按
  `getPlatformCookie(platform)` 过滤 sources 更稳。
- **QQ 曲目匹配失败时返回原曲**（`matched ?? (platform === 'qq' ? song : null)`），
  apple/spotify 返回 null——语义上 OK（QQ 有原生播放，只是取流失败），但上层
  `needsCarrier` 分支拿到 resolved 后不再区分"匹配到的"和"原样返回的"，若未来
  spotify 也走这条路径要防止把原曲当"匹配成功"（判 `resolved !== song`，现有代码
  6647 行已这么做 ✓）。

### 3.4 结论

匹配算法核心逻辑正确（评分、门槛、防翻唱都有据可查），**真正要修的是开关穿透问题
（3.1）和 requiredTier 统一（3.2.1）**，这两个直接决定 Spotify 降级方案的用户观感。

---

## 四、落地顺序（更新：2026-10-20 第三版，已实现部分标注 ✅）

| 步骤 | 内容 | 状态 |
|---|---|---|
| 1 | 修 OAuth：PKCE（authorize 带 code_challenge S256 + token 带 code_verifier）+ /me 的 product 透传 | ✅ 已实现（desktop/main.cjs） |
| 2 | 登录失败分类 + 自检 + 诊断报告（第一版方案 A） | 待做（可并行） |
| 3 | librespot 音频通道 + `waveforge-spotify://` 协议 | 待做（依赖 1 ✅） |
| 4 | Premium/免费分档 + playAsCarrier 动态化 | ✅ 已实现（platforms.ts 动态 playAsCarrier；librespot 就绪前统一 true=借源，代码注释写明 premium→false 的切换点） |
| 5 | 多平台载体选择算法 + 开关穿透 | ✅ 已实现（见下） |
| 6 | （可选第二阶段）pathfinder 内部 API | 观察期决定 |

### 5 步的实现明细（2026-10-20）

**多平台载体选择算法**（新增 `src/services/carrierSelection.ts` + `src/services/carrierResolver.ts`）：

- 载体候选源从写死 `['netease','qq']` 改为动态：白名单（netease/qq/kugou）中**已登录**的平台
  并行搜索（每源 top15，与老口径一致）；全部未登录 = 无可借源，如实提示。
- 每个候选评分（与 findPlayableAppleSong 完全同一 normalizeMatch/评分口径，60 分门槛），
  档位要求来自 `requiredTier`（旧数据退 `vip` 布尔）。
- `selectCarrier` 决策：**能完整播是门槛不是加分**（候选要 vip 而载体 free → 直接淘汰，
  unknown 档放行实测）；音质分（会员档 × 用户音质偏好折算，0-30）；匹配精度余量（0-10）；
  原平台偏好 +6（平票决定，逆转不了音质档差）。ranking 全量返回供日志/界面解释。
- 档案由 App 组装（`carrierProfiles` useMemo：登录态 + platformEntitlements 档位 +
  audioQualitySettings 偏好折算分），登录/登出/会员/音质变化即时生效。

**开关穿透（平台可用性增强管住所有平台）**——四个此前绕过开关的调用点全部受控：

1. `needsCarrier`（apple/spotify 主播放路径，App.tsx ~6453）
2. Apple 预载（~5766）
3. 队列分析 analyzeSongForSequencing（~5997）
4. WebView2 失败后的最后回退（~6828，关闭时提示"可在设置中开启"）

开关关闭时不再静默借源，toast 明确说"可在设置中开启「平台可用性增强」"。

**Spotify**：PKCE 修复让自定义 Client ID 可用（此前没 verifier，Spotify 新应用一律强制
PKCE 必失败）；`product` 从登录链路透传（App.tsx 已有 `spotify_product`/档位映射）。
免费号验证路径：登录 → product=free → playAsCarrier=true → needsCarrier（开关开）→
载体匹配 → 借网易云/QQ 出声 +「补」标记。

### 身份数据归属（审计结论，无需修改）

收藏（favoriteStatusService：每平台独立归属键，注释明确"绝不回落其它平台的归属键"）、
评论（CommentModal 按 `song.platform` 路由到对应平台接口）、歌词（跨平台补源有
`from+carrierId` 登记表，取词按登记的载体平台对时间轴）——都已是"身份跟原平台、
音频跟供源平台"的正确形态。唯一刻意例外：歌词跟音源（时间轴必须对齐实际音频），是设计而非 bug。

### 遗留（后续迭代）

- `isCarrierVip` 的 localStorage 快照会过期（会员过期未重登时判错），统一到 entitlement 事件流；
- 汽水/Apple 曲目进入 needsCarrier 时 `getSongUrl` 不传 `song` 参数（override 分流靠 audioSong），
  已核对无回归；
- 登录诊断体系（步骤 2）按第一版方案实施。

---

## 附录：登录诊断体系（第一版结论，未变）

folia 截图背后的四层机制：主进程主动自检（`loginSelfCheck.cjs`：本地后端→代理/fake-ip→
DNS→v4/v6 TCP+TLS 分开握手→HTTPS+时钟偏差）、登录请求环形记录（cookie 只记有无）、
错误分类（upstreamCode 20279→device-limit 等 + failureHint）、一键诊断报告
（Markdown + 隐私声明 + GitHub issue 预填）。WaveForge 缺口：QQ 扫码 code 800 一律
当"已过期"（LoginView.tsx:177），upstreamCode 已透传（qqMusicQrLogin.cjs:331）只差分类表；
自检/报告需新建（约 400 行主进程 + 300 行渲染层，零新依赖）。

研究材料：`D:\opencode\wf_folia_study\`（electron/ 全部 + shared/ + dist/ 两个 bundle）；
解包工具 `D:\opencode\.tmp-folia-asar\asar-extract.cjs`。
