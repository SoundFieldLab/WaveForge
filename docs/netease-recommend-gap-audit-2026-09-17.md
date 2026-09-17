# 网易云推荐页 内容清单对照（2026-09-17）

设备：MuMu 模拟器 `127.0.0.1:5557`（与 16416/7555/emulator-5556 同一实例），Android 15 / SDK 35，网易云 9.5.90，账号 `YoshinoRinne`(449703085)。

抓包环境：`adb root` + mitmproxy 中间人（CA 装入 `/apex/com.android.conscrypt/cacerts`，并 bind 进 zygote mount namespace）。
**9.5.90 的 eapi 响应体是「裸 AES-128-ECB 二进制 + gzip」**（不是十六进制串），key 仍为 `e82ckenh8dichen8`。
本次共解出 283 个响应，其中推荐页 `link/page/rcmd/resource/show` 6 页（cursor 7/12/17/22/27/30）。

> 方法：冷启动 App → 逐屏滚动 18 屏（直到页面底部）→ 每屏 dump UI XML → 与抓包区块逐项对照。
> 之后把同一批真实响应喂给 WaveForge 的归一化 + 渲染函数（vitest + jsdom），得到「当前源码实际会产出什么」。

---

## 一、App 推荐页一共有哪些区块

推荐页由 **Link Platform** 下发（`pageCode=HOME_RECOMMEND_PAGE`），区块身份是 `positionCode`。

服务端 `blockCodeOrderList` 给出 23 个翻页区块；首页第 1 屏另有 6 个自带区块。合计 **29 个已知区块，本次实际下发 25 个**。

| # | positionCode | App 分区标题 | 条目 |
|---|---|---|---|
| 1 | `PAGE_RECOMMEND_GREETING` | （问候语「晚上好」，无标题） | 0 |
| 2 | `PAGE_RECOMMEND_DAILY_RECOMMEND` | 每日推荐（顶部 6 张入口卡） | 7 |
| 3 | `PAGE_RECOMMEND_SPECIAL_CLOUD_VILLAGE_PLAYLIST` | 推荐歌单 | 7 |
| 4 | `PAGE_RECOMMEND_BANNER_1` | （bilibili 推广，广告位） | 0 |
| 5 | `PAGE_RECOMMEND_RADAR` | **YoshinoRinne的雷达歌单** | 7 |
| 6 | `PAGE_RECOMMEND_SHORTCUT` | **最近常听** | 24 |
| 7 | `PAGE_RECOMMEND_RED_SIMILAR_SONG` | **根据你喜爱的歌曲推荐** | 18 |
| 8 | `PAGE_RECOMMEND_ARTIST_FM_LIST` | 从你喜欢的艺人开始漫游 | 6 |
| 9 | `PAGE_RECOMMEND_REAL_TIME_INTEREST_RCMD` | 试试这些？你可能感兴趣的 | 6 |
| 10 | `PAGE_RECOMMEND_PRIVATE_RCMD_SONG` | **循环不止的「宝藏佳作」** | 12 |
| 11 | `PAGE_RECOMMEND_MONTH_YEAR_PLAYLIST` | —（服务端本次未下发） | — |
| 12 | `PAGE_RECOMMEND_SURVEY` | —（问卷位，未下发） | — |
| 13 | `PAGE_RECOMMEND_MIXED_ARTIST_PLAYLIST` | 女王蜂等艺人热门金曲 | 7 |
| 14 | `PAGE_RECOMMEND_MUSIC_FM_LIST` | 从你喜欢的歌曲开始漫游 | 6 |
| 15 | `PAGE_RECOMMEND_STYLE_PLAYLIST_1` | —（未下发） | — |
| 16 | `PAGE_RECOMMEND_FEELING_PLAYLIST_LOCATION` | 心情氛围 | 6 |
| 17 | `PAGE_RECOMMEND_FIRM_PLAYLIST` | **影视原声** | 6 |
| 18 | `PAGE_RECOMMEND_COMBINATION` | 你的专属推荐歌单 | 6 |
| 19 | `PAGE_RECOMMEND_SCENE_PLAYLIST_LOCATION` | **场景歌单** | 6 |
| 20 | `PAGE_RECOMMEND_PODCAST_MUSIC_RADIO` | 从你喜欢的音乐听播客 | 13 |
| 21 | `PAGE_RECOMMEND_STYLE_PLAYLIST_2` | —（未下发） | — |
| 22 | `PAGE_RECOMMEND_PODCAST_AUDIO_BOOK` | 听精品有声书 | 14 |
| 23 | `PAGE_RECOMMEND_ARTIST_TREND` | **你关注的艺人新动向** | 10 |
| 24 | `PAGE_RECOMMEND_RANK` | **排行榜** | 7 |
| 25 | `PAGE_RECOMMEND_NEW_SONG_AND_ALBUM` | **每周新热趋势** | 13 |
| 26 | `PAGE_RECOMMEND_VIP_CARD` | **VIP专属好歌限时免费听** | 13 |
| 27 | `PAGE_RECOMMEND_PODCAST_RADIO_PROGRAM` | **根据你听过的热门节目推荐** | 14 |
| 28 | `PAGE_RECOMMEND_SPECIAL_ORIGIN_SONG_LOCATION` | **为你精选的原创歌曲** | 6 |
| 29 | `PAGE_RECOMMEND_BROADCAST` | 广播 | 12 |

**翻页机制（重要）**：客户端每次翻页必须回传两个字段——
- `blockCodeOrderList`：上一页响应里那个**原始 JSON 字符串**
- `loadedPositionCodes`：**本会话已经展示过的 positionCode 列表**（App 实测形状：`["PAGE_RECOMMEND_GREETING",...]`）

App 实测 5 次翻页：cursor `0 → 7 → 12 → 17 → 22 → 27 → 30`，每次增量下发 3~5 个区块。

---

## 二、WaveForge 当前有哪些内容

把**同一批真实响应**喂给当前源码的 `normalizeNeteaseLinkPage` + `NeteaseNativeBlockView`：

| # | blockCode | WaveForge 渲染标题 | 卡片 | 问题 |
|---|---|---|---|---|
| 1 | `SPECIAL_CLOUD_VILLAGE_PLAYLIST` | **（无标题）** | 7 | 少了「推荐歌单」 |
| 2 | `RADAR` | **（无标题）** | 7 | 少了「YoshinoRinne的雷达歌单」 |
| 3 | `SHORTCUT` | 最近常听 | 12 | ✅ |
| 4 | `ARTIST_FM_LIST` | 从你喜欢的艺人开始漫游 | 6 | ✅ |
| 5 | `REAL_TIME_INTEREST_RCMD` | **（无标题）** | 6 | 少了「试试这些？你可能感兴趣的」 |
| 6 | `MIXED_ARTIST_PLAYLIST` | 女王蜂等艺人热门金曲 | 7 | ✅ |
| 7 | `MUSIC_FM_LIST` | 从你喜欢的歌曲开始漫游 | 6 | ✅ |
| 8 | `FEELING_PLAYLIST_LOCATION` | 心情氛围 | 6 | ✅ |
| 9 | `FIRM_PLAYLIST` | **（无标题）** | 6 | 少了「影视原声」 |
| 10 | `COMBINATION` | 你的专属推荐歌单 | 6 | ✅（靠硬编码兜底） |
| 11 | `SCENE_PLAYLIST_LOCATION` | **（无标题）** | 6 | 少了「场景歌单」 |
| 12 | `PODCAST_MUSIC_RADIO` | 从你喜欢的音乐听播客 | 13 | ✅ |
| 13 | `ARTIST_TREND` | **（无标题）** | **2/10** | 少 8 条 + 少标题 |
| 14 | `RANK` | **（无标题）** | 7 | 少了「排行榜」 |
| 15 | `NEW_SONG_AND_ALBUM` | **影视原声**（错） | **0/12** | 标题错 + 整块渲染成空 |
| 16 | `VIP_CARD` | **（无标题）** | **1/13** | 丢 12 条 + 少标题 |
| 17 | `PODCAST_RADIO_PROGRAM` | **（无标题）** | 14 | 少了「根据你听过的热门节目推荐」 |
| 18 | `SPECIAL_ORIGIN_SONG_LOCATION` | **心情氛围**（错） | 6 | 标题错 |
| — | `RED_SIMILAR_SONG` | **整块缺失** | **0/18** | 18 首全丢 |
| — | `PRIVATE_RCMD_SONG` | **整块缺失** | **0/12** | 12 首全丢 |
| — | `PODCAST_AUDIO_BOOK` | **被误排除** | — | App 第 10 屏明明有「听精品有声书」；见第六节 #10 |
| — | `BROADCAST` | **被误排除** | — | App 第 14 屏明明有「广播」；见第六节 #10 |
| — | `GREETING` | 过滤 | — | 无内容 |
| — | `BANNER_1` | 过滤 | — | 广告 |
| — | `DAILY_RECOMMEND` | 顶部 6 张入口卡 | 6 | ✅（走 SHORTCUT 语义） |

**小结（修复前）：18 个区块渲染出来，其中 9 个没有标题、2 个标题张冠李戴；另有 2 个区块（共 30 首歌）完全没渲染；
「听精品有声书」「广播」被我方误排除。**

---

## 三、对比表

### A. 两边都有（11 项）

| 内容 | App | WaveForge | 差异 |
|---|---|---|---|
| 顶部 6 张入口卡（每日推荐/心动模式/雷达歌单/漫游/相似歌曲/相似艺人） | ✅ | ✅ | 一致 |
| 推荐歌单 | ✅ 7 | ✅ 7 | 缺标题 |
| 最近常听 | ✅ 24 | ✅ 12 | App 含隐藏项，卡片数一致 |
| 从你喜欢的艺人开始漫游 | ✅ 6 | ✅ 6 | 一致 |
| 女王蜂等艺人热门金曲 | ✅ 7 | ✅ 7 | 一致 |
| 从你喜欢的歌曲开始漫游 | ✅ 6 | ✅ 6 | 一致 |
| 心情氛围 | ✅ 6 | ✅ 6 | 一致 |
| 你的专属推荐歌单 | ✅ 6 | ✅ 6 | 一致 |
| 从你喜欢的音乐听播客 | ✅ 13 | ✅ 13 | 一致 |
| 排行榜 | ✅ 7 | ✅ 7 | 缺标题 |
| 每周新热趋势 | ✅ 13 | ❌ 0 | 标题错 + 渲染为空 |

### B. 我们多了（App 推荐页没有）

| 内容 | 来源 | 说明 |
|---|---|---|
| **继续探索（乐流）** | `/api/homepage/block/page/unlimited/flow` | **App 推荐页从不调用此接口**（抓包全程 0 命中）。这是我们独有的能力，用户要求保留。 |
| 底部「播客推荐」整段 | `/api/podcast/home/tab/v2/get` | 这是 App **播客 Tab** 的数据源，不是推荐页。含 `NEWCOMER_HOT_PODCAST / RCMD_FOR_YOU / RELATED_TO_ME_PODCAST_FOR_V3 / HOTTEST_VOICELIST_BLOCK / FINITE_CHARTS_BLOCK / DISCOVER_MORE_VOICE_BLOCK`。 |

### C. 我们有、App 这次没下发（画像/AB 差异）

| 内容 | 说明 |
|---|---|
| `PAGE_RECOMMEND_MY_SHEET` | 实时运行时出现（旧 `homepage/block/page` 协议），App 推荐页链路里没有 |
| `PAGE_RECOMMEND_LBS` | 同上 |
| `MONTH_YEAR_PLAYLIST` / `SURVEY` / `STYLE_PLAYLIST_1/2` | 在服务端顺序清单里，本次未下发（需特定画像或 AB 命中） |

### D. App 有、我们没有（缺口）

| # | 缺口 | 严重度 | 证据 |
|---|---|---|---|
| 1 | **「根据你喜爱的歌曲推荐」整块丢失（18 首）** | 高 | 该块条目用 `clickAction.msg.method=playSongs` 下发，**没有 `action`/`orpheus` 字段**，`normalizeNeteaseResource` 归为 `action=none`，再被 `filterNeteaseActionable` 丢掉 → 区块 `resources=0` → 不渲染。即用户图 2 上半部分。 |
| 2 | **「循环不止的『宝藏佳作』」整块丢失（12 首）** | 高 | 与 #1 同一根因（同一个 `home_common_rcmd_songs_module_in_test` 模板） |
| 3 | **「每周新热趋势」渲染为 0 张卡** | 高 | `classifyNeteaseBlock` 见到 blockCode 含 `NEW_SONG` → 判定为 `songs` 密集列表 → 交给 `SongShelf`；但该块 12 条资源全是 `playlist`（`song` 数 = 0）→ 渲染出 0 张卡 |
| 4 | **9 个分区没有标题** | 中高 | 标题提取只认 `dslData.blockResource.title` 和 `dslData.data.title`；实测标题散落在 `dslData.<模块key>.blockResource.title`、`.header.title`、`.title`、`dslData.header.title`、`.blockTitle` 五处 |
| 5 | **2 个分区标题张冠李戴** | 中 | `NeteaseResourceView` 的语义正则兜底把资源标题一起参与匹配：`每周新热趋势` 块内有一条「影视热歌趋势…影视原声」→ 命中 `/影视原声/` → 显示「影视原声」；`为你精选的原创歌曲` 块内有「硬地心情丨…」→ 命中 `/心情/` → 显示「心情氛围」 |
| 6 | **「你关注的艺人新动向」丢 8/10 条** | 中 | 10 条里只有 2 条（专辑卡）带 `targetUrl`，其余 8 条是 `playBtn` 形态的单曲（无 `action`）→ `action=none` → 被过滤 |
| 7 | **「VIP专属好歌限时免费听」丢 12/13 条** | 中 | 同一原因：12 首 `playSongs` 形态单曲 → `action=none` → 被过滤，只剩标题卡 |
| 8 | **雷达歌单缺角落标签** | 低 | App 在封面左上显示 `coverText`：私人/怀念/时光/会员/宝藏/云村高分雷达；我们未读取渲染 |
| 9 | **翻页未回传 `loadedPositionCodes`** | 中 | 服务端代码只传了 `blockCodeOrderList`。App 每次都传 `loadedPositionCodes`，缺它可能导致服务端去重/推进逻辑不一致 |
| 10 | **推荐页加载期间少调 3 个 App 实际调用的位置接口** | 低 | App 还会调 `link/position/show/resource` 的 `homepage_second_floor_entrance` 等 |

**单个根因影响面**：缺口 #1/#2/#6/#7 是**同一个根因**——只认 `action`/`orpheus`/`targetUrl` 形态，不认 `clickAction.msg.method=playSongs` 与 `playBtn.playAction.songIds` 形态。修这一处可一次性找回 **18+12+8+12 = 50 张卡片**。

### 该根因的精确机制（实测打印）

```
### PAGE_RECOMMEND_RED_SIMILAR_SONG
   resourceType=song  title="散花"
   有 action? N   有 orpheus? N   有 targetUrl? N     ← 三个 action 字段全无
   有 clickAction? Y   有 playBtn? Y                  ← 动作只在这里
   normalize -> type=song id=26131697 action=none song=null   ← song 也没构造出来
   filterNeteaseActionable 保留? NO → 被丢弃
```

条目字段只有 `resourceId / resourceType=song / title / coverUrl / artistName / recReason / tag / clickAction / playBtn`，
**既没有 `action` 也没有内嵌 `song` 对象**。于是：

1. `normalizeNeteaseResource` 因为找不到 `songData`/`song`/`resourceExtInfo.song`，`resource.song` 保持 `null`，动作类型落到 `none`；
2. `filterNeteaseActionable` 对 `action.type==='none'` 的判定是「有 `actionUrl` 或 `song` 或 `playlist` 才留」，三者皆无 → 丢弃；
3. 区块 `resources` 归零 → `NeteaseNativeBlockView` 开头 `if (block.resources.length === 0) return null` → 整块不渲染。

`clickAction.msg.params.songIds` 里其实带着**整栏 18 首的播放队列**（如 `["26131697","419596411",…]`），
`playBtn.playAction.songIds` 同样是完整队列——数据是齐的，只是没被识别。


---

## 四、复现方式

证据与脚本保留在 `D:\opencode\.tmp-netease-reverse\`（未入库）：

- `captures/` — 283 个解密响应 + `capture.jsonl` 索引 + `bodies/` 正文
- `capture_addon.py` — mitmproxy 抓包插件（裸 AES-ECB + gzip 解密）
- `install_ca.sh` — Android 15 APEX cacerts 安装脚本
- `ui/u1..u18.xml` — 逐屏 UI dump
- `audit_report.txt` / `render_report.txt` / `app_inventory.json` — 逐区块对照原始输出
- `evidence/.tmp-*.test.ts(x)` — 跑真实响应的对照测试（拷回 `WaveForge/test/` 后 `npx vitest run` 即可复现）

## 五、结论

1. App 推荐页 **29 个区块**，本次下发 25 个。
2. 我们**渲染出 18 个**，其中 **11 个内容基本对上**，**9 个缺标题**，**2 个标题错**。
3. **2 个区块（30 首歌）完全没渲染**，这正是用户在图 2 看到的「根据你喜爱的歌曲推荐」缺失。
4. 另有两个区块**有数据但渲染成空**（每周新热趋势 12 条）或**只出 1 条**（VIP 13→1）。
5. 我们额外多了「继续探索/乐流」与「底部播客推荐」两段——前者是 App 推荐页没有的能力（按要求保留），后者其实属于 App 的播客 Tab。

---

## 六、修复记录（2026-09-17）

原则：**现有能力全部保留不重复**，只补齐缺口。

### 修复前 → 修复后（同一批真实抓包，跑归一化 + 渲染）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 渲染区块数 | 18 | **20** |
| 无标题区块 | 9 | **0** |
| 标题错误区块 | 2 | **0** |
| 整块丢失（有数据但 0 卡） | 2 块 / 30 首 | **0** |
| 渲染出 0 张卡的区块 | 1（每周新热趋势） | **0** |
| 只出 1 条的区块 | 1（VIP 13→1） | **0**（13/13） |
| 找回卡片总数 | — | **约 50 张** |
| **后端实际能拿到的区块** | **12（4 页就 hasMore=false）** | **19（6 页）** |
| **页面自动加载的推荐流区块** | 6（要手点「加载更多」） | **14（自动续拉）** |

### 逐项

1. **`playSongs` 形态单曲卡被丢（根因，找回约 50 张）** — `model.ts`
   新增 `playQueueOf()` / `songFromCardFields()` / `objectOf()`：从 `playBtn.playAction.songIds`、
   `clickAction.msg.params.songIds` 抽出整栏队列（兼容服务端把 `playBtn` 序列化成 JSON 字符串的情况），
   并用卡片字段补一个最小 `Song`。受影响：「根据你喜爱的歌曲推荐」18 首、「循环不止的宝藏佳作」12 首、
   「你关注的艺人新动向」8 条、「VIP专属好歌」12 首。
   顺带补上 `coverUrl`/`coverImg` 两个封面字段（旧逻辑漏读）。
2. **单曲卡点一张播整栏** — `NeteaseExplorePage.tsx`
   App 语义：点单曲卡把该栏全部加入播放列表并从点击项起播。实测点一次 → `song-detail?ids=` 带 12 个 id。
3. **区块标题解析（9 个区块）** — `model.ts` 新增 `blockTitleFromDsl()`
   覆盖 `dslData.blockResource.title`、`dslData.<模块key>.blockResource.title|header.title|title|blockTitle`、
   `dslData.data.title` 五种落点；且**不下钻 items/resources**，避免把卡片标题当区块标题。
4. **布局判定改为以内容为准** — `NeteaseResourceView.tsx` `classifyNeteaseBlock()`
   「每周新热趋势」blockCode 含 `NEW_SONG` 但 12 条全是歌单，旧逻辑判成 `songs` → 渲染 0 卡；
   现在有资源时先看资源构成，无资源（旧 homepage 协议）才退回语义判断。
5. **标题语义串不再包含资源标题** — `NeteaseResourceView.tsx`
   旧逻辑把块内卡片标题拼进正则，导致「每周新热趋势」块内有「…影视原声」→ 整块显示「影视原声」，
   「为你精选的原创歌曲」块内有「硬地心情」→ 显示「心情氛围」。现在只用区块自身字段。
6. **区块「更多」落点** — `model.ts` 新增 `neteaseBlockMoreTarget()`，`normalizeNeteaseBlock` 带出 `moreActionUrl`
   优先用服务端 `showMore.action`（排行榜 → 发现-音乐-排行榜；艺人热门金曲 → 站内艺人页），
   其次按 blockCode 语义；**没有落点就不渲染「更多」按钮**（避免点了没反应）。
7. **翻页补齐 `loadedPositionCodes` + `pageStyleType`** — `server/netease-native-explore.mjs` / `discover.ts`
   App 每次翻页都回传本会话已展示的区块，服务端据此推进；缺它会拿到与 App 不一致的区块。
8. **推荐理由 / 角标** — `model.ts` 带出 `reason`（超76%人播放、十万红心）与 `badge`（VIP/SQ/Hi-Res），
   `NeteaseResourceView.tsx` 新增 `ResourceMetaChips` 渲染到歌名下方，与 App 单曲行一致。
9. **雷达歌单封面角标** — `model.ts` 带出 `coverLabel`（`resourceExtInfo.coverText`），
   `ResourceImage` 在封面左上角逐行渲染（私人 / 宝藏 / 会员 / 时光 / 云村高分 radar / 新歌），
   对齐 App 图 1。
10. **「听精品有声书」与「广播」不再排除**（**此前是我方误排除，不是拿不到**）
    ADB 走查确认这两块就在 App 推荐页第 10 / 14 屏；数据也都在：
    - 有声书 = 12 张 `djradio` 卡（`orpheus://nm/voicelist/detail?id=…`），点开实测返回 **320 集**真实节目；
    - 广播 = 2 个融媒体电台（带 `mp.music.163.com` H5 兜底）+ 4 个分类卡。
    `NETEASE_EXCLUDED_POSITIONS` 从 4 项收敛到只剩 `INFINITE_PODCAST_HOMEPAGE_VOICEBOOK_TAB`。
11. **`numericIdFromAction` 裸 id 误判**（有声书曾变成歌单的根因）— `model.ts`
    旧实现把 URL 里任何 `id=` 都当目标 id，导致 `orpheus://nm/voicelist/detail?id=982187334`
    被解析成 **playlist**。改为「裸 id 只在路径段匹配该 kind 时才采用」，
    有声书因此正确落到 `radio`（站内电台页），可打开真实节目列表。
12. **小程序卡带 H5 时走站内网页面板** — `model.ts`
    `orpheus://miniProgram` 里有 `fallbackURL=https://…` 的（广播电台）改为 `web` 动作，
    用既有 `NeteaseWebPanel` 站内打开；没有 H5 的仍退回站内「全部分类」，不产生死卡。
13. **模块 header 不再变成幽灵卡** — `model.ts` `recursiveCandidates()`
    模块的 `header` 节点（`{showMore:true, action, title}`）自带 action+title，会被当成资源产出一张
    灰色空卡（实测「听精品有声书」在 12 本书上方多一张同名空卡）。新增 `isModuleHeader` 判定后不再产出，
    且限制条件很窄（无 resourceId/creativeId/子资源/任何图片），不影响区块容器与顶部快捷卡。

14. **★ 最重要：`link-page` 改走自建 eapi 直连** — `server/netease-native-explore.mjs` 新增 `callEapiRaw()`
    **这是「区块拿不全」的真正根因，而且和 App 无关——是 SDK 的缺陷。**
    证据链：
    - 用 SDK（`API.api({crypto:'eapi'})`）请求首页 → **4 个区块**；
    - 把 SDK 自己生成的同一份 `params` 原样重放到网易云 → **5 个区块**（含 RADAR）。
      即同一份请求字节，SDK 拿回来的是残缺结果。差别在**响应解密**。
    - 读 `@neteasecloudmusicapienhanced/api/util/request.js` 第 345 行：
      `// headers['x-aeapi'] = true // 服务器会使用gzip压缩返回值` —— **被注释掉了**。
      服务端对 eapi 响应默认 gzip，SDK 于是走「非压缩」分支，gzip 数据解出来是坏的
      （实测抛 `Malformed UTF-8 data`，或静默少给区块）。
      第 347 行 `data.header = header` 还会用内置 **PC 设备头**覆盖调用方传入的 header。
    - 自建实现按 **gzip 魔数** (`0x1f 0x8b`) 自适应解压，并完全掌控 header 与请求体。

    修复效果（同一账号、同一时刻实测）：

    | | 页数 | 区块数 | 覆盖 |
    |---|---|---|---|
    | 修复前（经 SDK） | 4 | 12 | 缺 RADAR / SHORTCUT / VIP_CARD / 有声书 / 广播 … |
    | 修复后（自建 eapi） | 6 | **19** | 上述全部回来 |

    这也解释了之前「有的块怎么都拿不到」——不是服务端不给，是**响应用 SDK 解坏了**。

15. **推荐页自动续拉** — `NeteaseExplorePage.tsx`
    App 是无限滚动，每屏到底自动续页；我们原来要手动点「加载更多推荐」，用户只能看到第 1 页。
    现在在后台串行把剩余页补满（保持 `blockCodeOrderList` 链顺序，单飞防止并发打乱），
    失败静默并保留按钮兜底。

### 修复后与 App 逐项对照（23 个区块全覆盖）

| 分区 | App | 现在 | 可点性 |
|---|---|---|---|
| 每日推荐 / 心动模式 / 雷达歌单 / 漫游 / 相似歌曲 / 相似艺人 | 6 | 6 | 全部可执行 |
| 推荐歌单 | ✅ | ✅ 7 | 歌单详情 |
| YoshinoRinne的雷达歌单 | ✅ | ✅ 7 | 歌单详情 + 封面角标 |
| 最近常听 | ✅ | ✅ 12 | 歌单详情 |
| 根据你喜爱的歌曲推荐 | 18 | **18** | 整栏 18 首入队 |
| 从你喜欢的艺人开始漫游 | 6 | 6 | 艺人相似连播 |
| 试试这些？你可能感兴趣的 | 6 | 6 | 歌单详情 |
| 循环不止的「宝藏佳作」 | 12 | **12** | 整栏入队 |
| 女王蜂等艺人热门金曲 | 7 | 7 | 歌单详情 |
| 从你喜欢的歌曲开始漫游 | 6 | 6 | 相似连播 |
| 心情氛围 / 影视原声 / 你的专属推荐歌单 / 场景歌单 | 6×4 | 6×4 | 歌单详情 |
| 从你喜欢的音乐听播客 | 12 | 12 | 整栏节目入队 |
| **听精品有声书** | 12 | **12** | 站内电台页（实测 320 集） |
| 你关注的艺人新动向 | 10 | **10** | 专辑/单曲 |
| 排行榜 | 7 | 7 | 榜单详情 |
| 每周新热趋势 | 12 | **12** | 歌单详情 |
| VIP专属好歌限时免费听 | 13 | **13** | 整栏入队 |
| 根据你听过的热门节目推荐 | 12 | 12 | 整栏节目入队 |
| 为你精选的原创歌曲 | 6 | 6 | 歌单详情 |
| **广播** | 12 | **12** | 站内 webview / 分类 |

实测汇总（真实抓包跑归一化）：**23 个区块、209 张卡，全部有标题、全部渲染出卡片。**

---

## 七、二级 / 三级入口审计（2026-09-17 第二轮）

「区块补齐」和「点得进去」是两件事。这一轮逐个动作类型 + 逐个区块「更多」入口做了实测。

### 内容规模（自建 eapi 抓到的完整 feed）

| 动作类型 | 数量 | 点开后去哪 |
|---|---|---|
| `playlist` 歌单卡 | 75 | 歌单详情面板（歌曲列表） |
| `song` 单曲卡 | 43 | 整栏入队播放 |
| `program` 播客节目卡 | 24 | 整栏节目入队播放 |
| `radio` 有声书/电台卡 | 12 | 站内电台页（实测 320 集） |
| `daily-rcmd` / `similar-songs` / `similar-artists` / `fm` / `semantic` | 各 1 | 日推面板 / 相似连播 / 漫游 |
| 区块「更多」按钮 | 12 | 发现页对应频道 / 艺人页 |

### 本轮修掉的二级入口缺口

14. **歌单详情里的歌手名、专辑名不可点（只能右键）** — `PlaylistDetailPanel.tsx:973-1012`
    `onOpenArtist` / `onOpenAlbum` 早就有 prop，但**只有右键菜单**「查看歌手/查看专辑」能触发，
    左键点文字毫无反应 —— 这是最影响「体验完整度」的一条。
    改为歌手名（逐个艺人独立可点）、专辑名渲染成按钮，`stopPropagation` 保证不误触发播放。
    实测：一个歌单里可点入口 36 个（18 歌手 + 18 专辑），点击后艺人弹层正常打开，
    带 6 个 tab（精选/专辑/视频/全部歌曲/相似歌手/歌手详情）；专辑弹层带 歌曲/专辑信息 两个 tab。
15. **专辑详情的歌手名不可点 + `onOpenAlbum` 是死 prop** — `AlbumDetailModal.tsx`
    头部的歌手名改为可点（走 `onOpenArtist`）。`onOpenAlbum` 声明了却全文件未被引用，
    属死 prop（暂留，避免动无关调用方）。
16. **用户资料弹窗是个硬死胡同** — `NeteaseExplorePage.tsx`
    原来只有头像/昵称/等级/签名，没有任何下一层。现在并行拉 `getUserPlaylistList`（该函数早已存在
    但**全仓库无人调用**），展示 TA 的歌单网格（最多 24 个）并可点进歌单详情。
    实测该接口对真实账号返回 48 个歌单。
17. **MV 浏览模式不会自动下一首** — `MVExploreModal.tsx:257`
    `mvListForPlayer` 硬编码成 `[playingMV]`，`VideoPlayer` 的 auto-next 永远找不到下一项。
    改为把浏览列表交给播放器（`directPlay` 乐流直达仍保持单曲）。

### 明确「不是缺口」的两项（App 行为一致）

- **播客节目卡没有"节目详情页"**：App 的节目卡动作是
  `orpheus://nm/voice/playRcmd?programId=...`，语义就是**直接播放**。我们现在的行为一致。
- **有声书点开是电台页而不是"书籍详情页"**：`djradio` 的 App 原生落点就是 voicelist 详情（节目列表）。

### 仍未做（诚实清单）

| 项 | 现状 | 原因 |
|---|---|---|
| 歌单详情的创建者/用户链接 | 未渲染 | `PlaylistDetailPanel` 没有 `onOpenUserProfile` prop，接通需要改 `ExploreView`/`App` 调用链 |
| 歌单详情顶部「详情」按钮 | 打开的是**评论弹窗**，非资料页 | 与 App 的"详情"语义不同，属既有设计 |
| 专辑页 → 其他专辑 | 不支持 | `onOpenAlbum` 死 prop（专辑本身没有再下钻场景） |
| MV → 艺人 / MV 评论 | 不支持 | `MVExploreModal` 无相关 prop |
| 电台页 → 节目级详情 | 不支持 | 服务端 `/explore/radio` 只回 `playlist.id`，节目 id 未透传；且 App 本身也是直接播放 |

### 验证

- `test/neteaseDrillDown.test.tsx` 新增 **4 个测试**：歌手/专辑左键可点、参数正确、不误触发播放、
  无时不渲染假按钮。
- 实测（重建 dist 后附加渲染进程）：歌单 → 歌手 → 艺人弹层 6 tab 全在；歌单 → 专辑 → 专辑弹层 2 tab 全在。



### 验证

- `test/neteaseRecommendGaps.test.ts` 新增 **17 个回归测试**，全部针对上面每一项（用的是抓包真实结构）。
- NetEase 相关 6 个测试文件 **79 passed**；`tsc --noEmit` 通过。
- 全量 `vitest run test/`：1655 passed；另有 6 个失败属**改动前就存在**（已用 `git stash` 对照确认，
  涉及 desktopLiveProtocol / ImmersiveControls / modeIntegrationWiring / exploreModeWiring，与网易云探索页无关）。
- 实机走查（重建 dist 后附加渲染进程验证）：
  - `PAGE_RECOMMEND_PRIVATE_RCMD_SONG` 由 **0 卡 → 12 卡**，歌名下方显示 VIP / 超70%人播放 / 收藏数。
  - `PAGE_RECOMMEND_NEW_SONG_AND_ALBUM` 由 **0 卡 → 12 卡**，标题由「艺人热门金曲」→「每周新热趋势」。
  - `PAGE_RECOMMEND_RANK` 标题由「(无)」→「排行榜」，点「更多」正确跳到 发现-音乐-排行榜。
  - 点单曲卡实测发出 `song-detail?ids=` 带 **12 个 id**（整栏入队），与 App 行为一致。

