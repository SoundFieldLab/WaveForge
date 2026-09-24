# WaveForge 性能 / 逻辑审计台账（2026-09-24）

> **这份文档的用途**：把两轮全量性能审计 + 一轮全量逻辑审计的**结论与进度**固定在仓库里，换会话、换人、隔几周回来都能接着干，不必重新调研。
> **怎么用**：先看 §3「待修清单」（按优先级，每条带 `file:line` + 症状 + 建议修法 + 验证方法），修完一条就把状态改成 `DONE (commit)`。§5 是「已评估但决定不修」——**不要重复调研**。§6 是人工手验清单（测试覆盖不到的运行时行为）。

---

## 1. 审计范围与方法（含方法论教训）

- 三轮扫描：① 性能（按模块切分）② 性能（补加载/缓存维度）③ 逻辑与隐患（按用户操作序列/账号隔离切分）。
- 规模：1751 个受控文件、`local-server.mjs` 11868 行、`src/App.tsx` 9951 行、`desktop/main.cjs` 8531 行。
- 手段：并行只读审计代理 + 人工核实证据（每轮约 7 个代理分区域、按 `file:line` 取证）。
- **三条教训（下次别再犯）**：
  1. **不要给审计代理设「每区域最多 N 条」的上限**。第一轮我设了 10 条，导致长尾问题从未被报出；取消上限后同一批区域立刻多报出「TV BACK 退应用」「登出/切号串号」这类严重项。
  2. **每换一种切分方式就会捞出上一种看不见的问题**。按模块切会漏掉跨模块的「用户操作序列」和「账号隔离」问题——这两类是本次最严重问题的聚集地。
  3. **静态分析只能给出「路径存在」，给不出「触发概率」**。排序用「影响 × 频率」估计，落地前需要 §6 的手验或真机 profiling。

---

## 2. 已修（基线状态）

以下改动**已提交、未推送**（`git log origin/master..HEAD`，共 20 个提交，2026-09-24）。压缩包体、缓存上限、后台停绘、TV 返回链、账号隔离等都已落地；细节见各提交正文（本仓库提交信息写得较详细）。

| # | 提交 | 一句话 |
|---|---|---|
| 1 | 25bbc35 | 天气/桌面部件复用 Intl 与 Canvas 渐变；修后台恢复后动画不重启 |
| 2 | a6c6c6b | 图片缓存写入摊销、无界缓存加上限、探索页首帧不再重复解析缓存 |
| 3 | 170046a | 着色器预热引擎语料改动态 import → **主入口 chunk 2.03MB → 1.61MB** |
| 4 | eb64472 | 过渡期合成时间量化发布，避免歌词页/控制条 30fps 重渲染 |
| 5 | 8676e92 | 窗口隐藏时停绘（fume/pendolo/monet/sonnet/DGLab/SignalRgb）+ Diorama 纹理随行释放 |
| 6 | 6df63f4 | 过渡渲染 PCM 缓存上限 128MB/10 条 → 48MB/3 条 |
| 7 | ee2daf8 | 大文件哈希/落盘改异步分块；媒体协议加短 TTL 判定缓存 |
| 8 | e766a2d | QQ 歌曲详情加 mid 维 TTL 缓存与 6 并发闸门 |
| 9 | c875c80 | indexedDB 读命中不再回写整条记录 |
| 10 | da60f13 | TV 开发者模式关闭时不通知订阅者；日志时间轻量格式化 |
| 11 | 8137b36 | 风险复核加固：过渡缓存放宽、曲目缓存深拷贝、TV 日志缓冲、sonnet 隐藏态 |
| 12 | b7f4ff6 | cadenza 排序键一次算好、pendolo 尺寸缓存、monet 渐变复用 |
| 13 | 702b7e5 | 网易歌词 TTL 缓存、歌曲详情扩展信息并行取 |
| 14 | ac228bc | tvCore 遥控导航诊断日志与逐候选样式计算受 verbose 开关门控 |
| 15 | 9391ad7 | 清理过期注释与未使用类型 |
| 16 | 0bd8b3b | 预取只做当前核心平台；本机 API 音频不再二次代理 |
| 17 | 95d758c | MV 氛围画布 150ms 定时器、音效设置落盘防抖、Spotify token 刷新单飞 |
| 18 | f165c14 | 酷狗请求补 30s 超时；清理遗留 localStorage 封面缓存层 |
| 19 | 218d92b | CommentModal/SettingsPanel 补 useTvBack；PlayerControls 方向键让路；NaN 落盘；天气崩溃；一起听控制权校验 |
| 20 | ca4dfcb | 5 个弹层补 useTvBack；按平台隔离歌单缓存键；登出/切号清缓存；启动不刷新登录有效期；歌单缓存失效含 IDB |

---

## 3. 待修清单（按优先级）

### P0 — 涉及隐私 / 数据正确性

| 状态 | 项 | 位置 | 症状 | 建议修法 | 验证 |
|---|---|---|---|---|---|
| TODO | 用户主页请求竞态 | `src/components/ProfileView.tsx:1819`（`fetchUserData`）、`:1120`（`handlePlaylistClick`） | 连开两个用户主页 / 连点两个歌单，**旧响应覆盖新数据**（显示"别人的资料 + 上一人的歌单"），loading 提前关闭 | 照抄同文件 `recentRequestRef`（`:584/:1363-1449`）的 revision 守卫：函数入口自增 seq，每个 `await` 之后的 setState 前比对 | 给 `/api/netease/user/detail` 加 3s 延迟，快速点用户 A→B |
| TODO | 假登录真校验 | `src/App.tsx:6698`（netease）、`:6755`（QQ）；`local-server.mjs:8720` | cookie 失效也显示"已登录"，后续静默失败 | **需先定策略**：建议「启动时后台校验一次，仅当上游明确返回未登录才清态并提示；网络错误不动」——直接判未登录会让网络抖动时正常登录失败 | 用一条过期 cookie 启动，应提示"登录已过期" |
| TODO | 明文凭据 | `local-server.mjs:116-150`（`~/.waveforge/qq-cookie.txt`）、各平台 localStorage | 凭据明文落盘 | 安全策略决定：系统凭据库 / 至少文件权限收紧 | — |

### P1 — 越权与安全边界

| 状态 | 项 | 位置 | 症状 | 建议修法 |
|---|---|---|---|---|
| TODO | DG-LAB 中继无鉴权 | `server/dglab-relay.cjs:1425-1429` | `POST /api/dglab/control` 无鉴权、`GET /status` 返回 `controlToken` → **本机任意进程可接管设备** | `/control` 校验令牌；`/status` 不回令牌（令牌只经主进程 IPC 给渲染层） |
| TODO | 灯光类 IPC 无来源校验 | `desktop/chroma-ipc.cjs:524-548`、`desktop/signalrgb-ipc.cjs:18-42` | 既无 `guardTrustedIpc` 也无 `event.sender` 判定（同仓其他 privileged 通道都有），`signalrgb:uninstall-effect` 还会删写文件 | 统一套 `guardTrustedIpc('privileged')` |
| TODO | 一起听越权与健壮性 | `src/features/resonance/session.ts:1170`（chat 昵称回退）、`:380-396`（closed 分支）、`transport.ts:215-243`（`close()` 不清 pending） | 名册外 peer 仍可发言并冒名；成员断网不重连且定时器/`pending` 无界增长 | chat 在 `memberNicknameOf` 为空时丢弃；closed 分支 `stopTimers()` + `transport=null`；`close()` 清 `pending` |
| TODO | 酷狗歌单界面入口 | `PlaybackRadialMenu`（`SongContextMenu.tsx:519` 已隐藏，径向菜单未隐藏） | 酷狗"取消喜欢"服务端只回执不落库 → **假成功** | `likeKugouSong(false)` 明确返回不支持，并隐藏入口 |

### P2 — 明显的功能错误（小改动）

| 状态 | 项 | 位置 | 症状 | 建议修法 |
|---|---|---|---|---|
| TODO | QQ「喜欢的音乐」按名字误判 | `src/services/playlistService.ts:112` | 自建歌单名以「喜欢的音乐」结尾会被**改名、计入"我喜欢"计数、无法编辑** | 只认 `dirId==='201'` 或服务端 `specialType`，删掉 `endsWith` 猜测（netease 侧 `:321` 同理） |
| TODO | Spotify 私密歌单被建成公开 | `src/services/playlistService.ts:1131` | 勾选「私密」无效 | 统一 privacy 取值域，Spotify 分支接受 `'10'/'private'` |
| TODO | HomeView 归属误判 | `src/components/HomeView.tsx:3347` | 汽水/Spotify 用户**自己的歌单没有编辑/删除入口** | 改用文件内已有的 `getPlaylistOwnerUserId(platform)` + `isPlaylistOwner` |
| TODO | TraditionalView 归属兜底过宽 | `src/components/TraditionalView.tsx:1657` | 他人歌单出现编辑/删除入口 | 按 `item.platform` 传对应 userId，去掉无平台兜底放行 |
| TODO | 删歌不校验业务码 | `src/services/playlistService.ts:1102`、`TraditionalView.tsx:924` | HTTP 200 + 业务失败也报「已从歌单移除」 | 补 `code/result` 校验（与 `addSongToPlaylist:1019` 一致） |
| TODO | 渲染期裸 JSON.parse | `src/components/DesktopView.tsx:501`、`LyricsDisplay.tsx:664/1057` | 键被写坏 → **整树白屏**（根 ErrorBoundary 只能鼠标重载） | 改用现成的 `parseStoredBoolean`/`parseStoredArray`（同文件别处已在用） |
| TODO | 缓存弹窗卡死 | `src/components/CacheClearModal.tsx:242-318` | `refreshStats()` 抛错则 `busyTarget` 永不复位 → 所有按钮禁用直到重启 | `setBusyTarget(null)` 放进 `finally` |
| TODO | 日出日落 0 点 | `src/services/weatherTime.ts:53` | 只有日期的 `sunrise/sunset` 被当 00:00 → 昼夜/天空体错乱 | 格式不符返回 `null` 而非 `0` |
| TODO | 详情两栏全空 | `src/components/SongDetailModal.tsx:103`、`ProfileView.tsx:720`、`TraditionalView.tsx:951` | `Promise.all` 任一失败即丢全部结果、无提示 | 改 `Promise.allSettled` 并给出错误态 |
| TODO | 剩余返回链缺口 | `DesktopWidgetZone.tsx:232` 组件详情层 | TV BACK 退应用 | 补 `useTvBack`（注意先确认它的打开状态字段名） |
| TODO | OK 键双触发 | `src/tv/tvCore.ts:570-586` + 6 处 `activateWithKeyboard`（AppleSearchBrowse/AppleExplorePanel/AppleMusicSearchPage/TraditionalView 等） | 焦点在 `data-tv-focus` div 上按 OK **动作执行两次** | `activate()` 里 `stopPropagation()`，或各处理器加 `if (event.defaultPrevented) return` |
| TODO | 手机遥控 BACK 链路不通 | `src/App.tsx:5945-5954` | 遥控 BACK 不调 `dispatchTvBack()` → 模式选择/软键盘关不掉，反而关播放页 | `action==='back'` 先 `if (dispatchTvBack()) return` |
| TODO | TV 焦点域漏监听 | `src/tv/tvCore.ts:800-838` | 运行时才加 `data-tv-scope` 的面板（`ExploreView.tsx:2199`）焦点永远收不进去 | MutationObserver 加 `attributes:true, attributeFilter:['data-tv-scope']` |
| TODO | TV 首启效能档失效 | `src/tv/perfMode.ts:17` | `deviceMemory<3` 分支是死代码（模块求值时 `tv-mode` 类还没打上） | `initPerfMode()` 里在平台类打好后重算 |
| TODO | 焦点不回退 | `src/tv/tvCore.ts:816-828` | 嵌套弹窗关闭后焦点丢失，下一次按键跳到域内第一个候选 | 卸载前记录域内上一个焦点元素并在域变化时恢复 |
| TODO | 切模式遮罩挡住遥控 | `src/components/ModeTransitionOverlay.tsx:66` | 3–12 秒内所有候选被 `elementFromPoint` 判为不可命中 | 遮罩根节点加 `data-tv-skip` + `pointer-events-none`（并让 BACK 可取消过渡） |

### P3 — 播放逻辑（症状明确、改动中等）

| 状态 | 项 | 位置 | 症状 |
|---|---|---|---|
| TODO | 删除已预载的下一首 | `src/App.tsx:6671`（未 `cancelTransition`）+ `:4697`（`commitPreparedSong` 找不到目标时静默 return） | 引擎仍切到被删除的歌，UI/歌词停在上一条 → 音频与 UI 永久错位 |
| TODO | 重复曲目定位 | `src/App.tsx:3819` | 队列里同曲重复时点第二条播第一条；key 未命中被 `Math.max(0,-1)` **兜成第一首别的歌** |
| TODO | 连点丢步 | `src/App.tsx:5310` | `handleNext/handlePrevious` 用 state 而非 `currentIndexRef` → 快速连点只前进一首 |
| TODO | 房间内「下一首」语义不一 | `src/App.tsx:5289` | 播放器按钮不推进房间队列（媒体键/遥控走 `hostNext()`），会把成员拉回 0:00 |
| TODO | 「下一首播放」顺序反转 | `src/App.tsx:3994` | 连点两次顺序反了、且不重新预载 |
| TODO | 拖进度条时换歌 | `src/components/PlayerControls.tsx:449` | 松手把**新歌** seek 到旧歌比例位置 |
| TODO | 网易喜欢无幂等 | `src/App.tsx:4053-4076` | 连点使「我喜欢」计数虚增（服务端未补 `unchanged`、前端无 in-flight 守卫） |

### P4 — 产品行为（需先定预期，不要盲改）

- **MV 短于歌曲时**（`BilibiliMvPlayer.tsx:1686`，默认 `videoEndBehavior='next'`）：TV size/剪辑片段会让歌提前被切掉。需要你定「重播 / 停在末帧 / 仍切下首」。
- **「稍后」更新**（`UpdateManager.tsx:185`、`desktop/update-manager.cjs:279`）：实际行为是**下次启动瞬间 exit+重启**，与 UI 文案不符；且 asar 替换失败只写日志、`finally` 会删掉 pending → **显示成功但版本没换**。
- **歌单/库的跨平台能力差异**（`TraditionalView.tsx:749/850/957` 同一份 5000 首被三处各自拉取映射）——同时是性能问题，见 §5。

---

## 4. 已修但需人工复验的运行时行为

见 §6。

---

## 5. 已评估、决定不修（**别重复调研**）

### 性能类（收益未证实 vs 回归风险）

- **列表窗口化**（`ProfileView` 100 张 `backdrop-filter` 卡、`HomeView` 100 个 framer `layout` 卡）：会破坏 TV 焦点导航（`tvCore.candidates()` 按 DOM 查）与「滚动到当前歌曲」定位；`HomeView` 的大头是 `layout` 投影，去掉逐卡 `layout` 即可，不必窗口化。工具链已有（`@tanstack/react-virtual`、`react-window` 均在使用中）。
- **`preloadOnIdle` 预热全部视图与弹窗**（`App.tsx:812`，+1.9MB/113 chunk；歌词模式再 +2.44MB）：这是**为切换瞬时响应故意做的**，砍掉等于用切换速度换启动流量，必须真机量化首屏再定。
- **`LyricsDisplay` 4Hz 全表重渲染**（2801 行、每行 framer-motion）：需抽行级 memo + 行级订阅，结构性重构。
- **EQ 链每次设置变更整条重建**（`audio-effects-v2/AudioEffectsEngine.ts:1307`）：无「仅更新参数」路径，属音频 DSP 改动，需听感 A/B。
- **`/api/{netease,qq}/song/url` 串行候选链**（最坏 18–20s）：首候选通常命中；改并行会显著增加上游请求（限流风险）。
- **汽水音频整包解密后发首字节**（`qishui-audio-decryptor.mjs:685`）：需流式/分片解密，架构级。
- **同专辑无缝重复整曲下载**（`albumGapless.ts:677` + `gaplessIntegration.ts:179`）：需让分析与无缝共用同一份已下载流。
- **国家城市数据 12.89MB**：**已确认懒加载、不在首屏链**（只有选中该国才拉 0.7–1.8MB），裁 Top-N 属数据侧决策。
- **字体 8.28MB / 首屏 CSS 332KB / `logo.png` 1.06MB**：需要 fonttools 子集化与图片转码工具链。
- **`lucide-react` 全量 barrel（1.55MB，仅在懒加载的 Folia 页）**：图标名来自 AI/主题编辑器的**动态解析**，改白名单会让未列入的图标渲染不出来。
- **`vite.config` 的 `chunkSizeWarningLimit:2000`**：无运行时收益，仅告警卫生。
- **`airplayController` 每 800ms 一次 `setStreaming`**（≈1.25 IPC/s）、**Chroma 状态小圆点被 30Hz 快照带动重渲染**：量级可忽略。

### 逻辑类（已确认非问题或已有意为之）

- **任务栏 widget 120ms 光标轮询**：点击穿透窗口拿不到 mouseenter/leave，只能轮询，属设计。
- **任务栏设置每 5s 重载**：已有 `TASKBAR_WIDGET_SETTINGS_RELOAD_MS` 节流且文件仅几百字节。
- **`/api/explore/qq` 的 `sleep(80)`/串行补全**、**bilibili 弹幕 30 段串行**：看着像有意对抗上游限流，改并发可能触发限流。
- **`bilibili-api.mjs:360` 流缓存键含时间戳**：B 站 playurl 带签名有效期，去掉时间戳可能送出过期 URL——先确认签名机制再动。
- **`useAudioAnalyzer`/`ensureAudioGraph`**：已有幂等卫兵，不会每首重建 AudioContext。
- **歌词与取流在 App 中是并行的**（`App.tsx:4970` 起 `lyricsPromise` 不 await）。

---

## 6. 人工复验清单（测试覆盖不到，各 1 分钟）

**本次改动（20 个提交）相关：**
1. **TV 返回链**：tv-mode 下依次打开 设置 / 评论 / 遥控配对 / 播放设备 / 轮盘自定义 / 添加到歌单 / 共振退出询问 → 按 BACK 应**逐层关闭**而非退出应用。
2. **方向键**：播放页（含歌曲详情弹窗）按方向键切焦点，**不应改变音量或进度**。
3. **账号隔离**：登出 Spotify / 汽水后右键歌曲「添加到歌单」，**不应再列出上一个账号的歌单**；切换网易云/QQ 账号后歌单应重新拉取（不闪出旧账号内容）。
4. **登出后**：喜欢（红心）状态不应残留上一个账号的。
5. **登录有效期**：cookie 失效 30 天后应出现「登录已过期」提示（此前永不出现）。
6. **桌面模式**：删/改名/新建歌单后列表**应立即正确**（不再回退旧数据）。
7. **可视化后台停绘**：各可视化切后台再切回，画面应正常恢复（不冻住、不黑屏）。
8. **AI 长过渡**：进度条/时间显示应顺畅（过渡期合成时间已量化到 250ms）。
9. **一起听**：房间内点播放器「下一首」按钮的行为（见 P3，尚未修）。
10. **最小化时 CPU/GPU** 应明显低于改动前（频谱与 Chroma 联动仍会跑，属预期）。

---

## 7. 续作约定

- 每修完一条：把 §3 表格里的状态改成 `DONE (<commit>)`，**不要删除行**——它们是"已调研过"的证据。
- 提交信息沿用本仓库风格（中文 conventional commits，正文写清症状/原因/取舍），便于 `git log` 代替文档。
- 改完必须过 `npx tsc --noEmit` + `npx vite build` + `npm run test:desktop`；涉及共振/音效/缓存时再跑对应 vitest。
