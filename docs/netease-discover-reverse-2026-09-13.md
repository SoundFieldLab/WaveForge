# 网易云「推荐 / 发现」逆向记录（Android 9.5.90，2026-09-13）

设备：MuMu 模拟器 `127.0.0.1:16384`（`emulator-5554` 同一实例），横屏 Pad 布局。
方法：`adb root` + OkHttp/SystemCA 中间人抓包（mitmproxy），eapi 响应为 `AES-128-ECB(key=e82ckenh8dichen8)`，解密后为 JSON；`/api/*` 明文。
逆向对照用的 APK/dex、RN Hermes bundle 与抓包样本只保存在本地临时目录，验收后已删除，账号 cookie 未写入仓库。

## 结论：现代首页使用 Link Platform，而非旧的 `/api/homepage/block/page`

App 内所有主页面（推荐、发现-音乐、发现-播客、听书）由 **link platform** 下发：
`scene → position → page`。旧的 `/api/homepage/block/page` 只返回 `HOMEPAGE_SLIDE_*` 旧版块，
与 App 实际内容不一致——这正是 WaveForge 推荐页封面缺失、内容对不上的根因。

## 一、顶部导航（发现页）

- 位置：`POST /api/link/position/show/resource`，`positionCode=music_top_tab_full`。
- 返回：`data.generalizedSceneShow.generalizedMap.nowChannelItems[]`。
- 每项：`{ code, title, url, urlType, s_ctrp, canDrag, canDelete, minAndroidClientVersion }`。
- 实测 44 个频道（顺序即 App 顺序）：
  精选(feature) / 排行榜(chart) / 歌单(playlist) / 二次元(music_top_tab_acg) / 日语(music_top_tab_jpop) / VIP /
  欧美(euro) / 情歌(qingge) / OST(yingshi) / 摇滚(rock) / 全球(music_top_tab_world) / 游戏(music_top_tab_game) /
  放松(music_top_tab_tipsy) / 跑步(paobu) / 电音(djR) / 国风(china) / 经典(old_hat) / 粤语(yueyu) / 驾车(music_tab_drive) /
  舞蹈(music_top_tab_dance) / K-Pop(hFlow) / 法语(music_top_tab_french) / 慢摇DJ(music_top_tab_dj) / 助眠(sleep) /
  轻音乐(music_top_tab_light_music) / 说唱(rap) / 古典(classic) / 儿歌(music_top_tab_children) / 爵士(sir) / 民谣(ballad) /
  拉丁(music_top_tab_latin) / 先锋(music_tab_pioneer) / AI(music_top_tab_sunoai) / R&B(rnb) / 高音质(HiFi) /
  乡村乐(xiangcun) / 放克(funk) / 蓝调(landiao) / 乐器(yueqi) / 出行(chuxing) / 华语(huayu) / 专注(study) /
  音乐剧(yinyueju) / 运动(music_top_tab_sport)

`url` 两种：`native`（精选）与 `rn`（其余，含 `component=` / `page=`）。

## 二、按频道取内容

### 推荐页分页（重要）
- 首次 `cursor=0`；翻页必须回传上一页响应里的 **`blockCodeOrderList` 原始 JSON 字符串**。
  - 传数组 → 服务端 500；不带该字段 → 500（实测 9.5.90）。
  - 实测 cursor 0 → 6 → 11 …，第 2 页新增 `PAGE_RECOMMEND_MY_SHEET / RADAR / RANK` 等区块。
- 首页 4 块（GREETING / 每日推荐 / 推荐歌单 / PRIVATE_RCMD_SONG），第 2 页起补 雷达歌单、相似歌曲、心情氛围、
  艺人热门金曲、场景歌单、从你喜欢的艺人开始漫游、排行榜、固定歌单等。

### 精选（feature）/ 推荐（rcmd）
- `POST /api/link/page/rcmd/resource/show`，**eapi**。
- 参数：`pageCode`、`cursor`（首页 `"0"`）、`isFirstScreen`、`refresh`、`extJson`、`header`。
  - 推荐页：`pageCode=HOME_RECOMMEND_PAGE`
  - 发现-音乐-精选：`pageCode=HOME_DISCOVERY_PAGE`
- 返回：`data.{blocks[], blockCodeOrderList, cursor, hasMore, ...}`。
- 精选块（实测）：`PAGE_DISCOVERY_BANNER`、`PAGE_DISCOVERY_QUALITY_SONG_LIST`(甄选歌单)、
  `PAGE_DISCOVERY_NEWSONG_NEWALBUM`(新歌新碟)、`PAGE_DISCOVERY_RANKLIST`(排行榜)、
  `PAGE_DISCOVERY_DIGITAL_ALBUM_CARD`、`PAGE_DISCOVERY_STYLE_SONG_LIST`、`PAGE_DISCOVERY_SCENE_SONG_LIST`、
  `PAGE_DISCOVERY_CLOUD_VILLAGE_PUBLISH_LOCATION`、`PAGE_DISCOVERY_TREASURE_MUSICAN_LIST`。
- 推荐块顺序（order list）含：`PAGE_RECOMMEND_MUSIC_FM_LIST`、`MY_SHEET`、`RADAR`、`ARTIST_FM_LIST`、`RANK`、
  `SURVEY`、`COMBINATION`、`NEW_SONG_AND_ALBUM`、`PODCAST_AUDIO_BOOK`、`LBS`、`PODCAST_RADIO_PROGRAM` …
- **块内容不在 `nativeData`**：快捷入口在 `crossPlatformConfig.dslContent.dslData.data.resources[]`
  （字段 `coverImg` / `customView.source` / `title` / `action` / `resourceId` / `resourceInteractInfo.playCount`）。
  其余块在 `nativeData.banners[]` / `nativeData.songs` / `nativeData.playlists` / `dslData` 等，需按块类型递归提取。

### 排行榜（chart）
- `POST /api/toplist/detail/v2`，eapi。无参 → `data[]` 官方榜单（实测 7 个：飙升榜/新歌榜/热歌榜…），
  每项含 `id / name / coverImgUrl / updateFrequency / tracks[] / trackNumberUpdateTime`。

### 歌单（playlist，rn-playlistsquare）
- `POST /api/playlist/square/block/page`，**weapi**。参数 `categoryName`（如 `推荐`）、`offset`、`limit`。
- 返回 `data.{cursor, blocks[], hasMore, pageConfig, pageCodeContext}`；块 `showType` 实测
  `PLAYLIST_SQUARE_MULTI_THREE_GRID`、`PLAYLIST_SQUARE_SINGLE_SLID`，内容在 `creatives[]`；
  `cursor` 内含后续 `blockCodes`（EXCLUSIVE/BANNER/EXPERT/OFFICIAL_PLAYLIST/CHART/COMMON_RECOMMEND）。
- 配套：`/api/playlist/highquality/list`、`/api/playlist/highquality/tags`（33 个）、`/api/playlist/catalogue`。

### 曲风频道（二次元/日语/欧美…，cube-renderer-rn）
- `GET /api/cube/render/page/protocol?pageCode=<页面id>&scene=music`（**明文 GET，无需加密**）。
- `pageCode` 来自频道 `url` 的 `page=` 参数（如二次元 `1c67ef48645f48098a4196efd27f8b7f`）。
- 返回 `data.{pageProtocol, blockData}`；`pageProtocol.pages[0]` 是完整组件树，**内容已内联**。
- **页内子 Tab 数据一次下发，切换是纯客户端行为**（实测点 Tab 不产生新请求）。两种模板：
  - `StickyTabs → TabHeader + TabItem×N`（曲风编年/歌单广场入口页，`TabItem.props.title` 即页签名，
    内部 `Text.props.content` 是分段标题，`Grid → Entrance` 是卡片；Entrance 可能是 `action.type=link`
    的外链，也可能是 `action.params.{query,resourceType}` 的歌单）。
  - `MusicGenreSongList → MusicGenreSongListItem×N`（二次元/日语等，`props.title` 即页签名，
    内部为 `Grid/Scroll/Card → Playlist/Entrance/Album`，`props.songList` 为歌曲）。
- 因此一个通用树遍历即可取出全部页签与卡片，无需再调 `/eapi/tag/tab/*`。
- 详情补充接口（App 实际也调）：`/eapi/tag/tab/playlists` `{ids}`、`/eapi/tag/tab/dj/djlists` `{ids}`、
  `/eapi/tag/tab/alg/recommends` `{ruleId:"27002",ruleType:"1",limit,offset,...}`、
  `/eapi/tag/tab/tags` `{ruleId:"27002",ruleType:"1",tabTagId:""}`。

### 排行榜二级页
- 榜单卡片点击后进入 `PlayListActivity`，即**标准歌单详情**（`/api/v6/playlist/detail` 一系）。
  WaveForge 直接复用既有歌单详情弹窗，无需新建页面。

### 播客（发现 → 播客）
> 修正：播客 Tab 的**正确数据源是无限流接口**，`podcast/home/tab/v2/get` 是另一套页面结构，两者区块完全不同。
- `POST /api/podcast/rcmd/tab/infinite/blocks/get`，eapi，`pageCode=INFINITE_PODCAST_HOMEPAGE_PODCAST_TAB`。
- 首页返回 `DRAGONBALL`（7 个固定入口：我的播客 / 全部分类 / **排行榜** / 音乐播客 / 对话现场 / 助眠解压 / 广播电台）、
  `FM_CHANNEL_NORMAL`（副标题「收藏播客更新」，内容列表）、`GUESS_LIKE`（猜你喜欢）。
- `data.cursor` 是一个 JSON 字符串（含 `cursor`、`fixedBlockOrder` 等），原样回传用于继续加载；
  磁盘缓存位于 `files/podcast/homepage/data.*`（清掉即可强制重新拉取）。
- 另有 `podcast/home/tab/v2/get`（9 个 blockVOS：编辑精选/龙珠/为你推荐/音乐播客榜/上新佳作/音乐大咖说/热门播客/分类/探索更多），
  WaveForge 作为备用路由保留但未作为播客 Tab 主源。
- 听书同构 `..._VOICEBOOK_TAB`（**不接入**）。

### 歌单广场（playlist）翻页
- `POST /api/playlist/square/block/page`（weapi）用 `offset` 递增翻页，每页 20；`hasMore` 始终为 true，
  实测 offset=0/20/40 返回不同区块，可无限追加。

## 三、推荐页顶部六张卡的真实来源（封面修复）

`PAGE_RECOMMEND_SHORTCUT` 块的 `crossPlatformConfig.dslContent.dslData.data.resources[]`：
每张卡 `{ resourceId, title, coverImg, customView:{source,...}, action, iconDesc, resourceInteractInfo }`。
旧实现只读 `uiElement.image.imageUrl`（旧协议字段，link page 下不存在）→ 导致六张卡无封面。

## 四、需要排除的内容（按用户要求）

- `PAGE_RECOMMEND_PODCAST_AUDIO_BOOK`（听精品有声书）：按 positionCode 过滤。
- 鲍比/BOBBY「跨时空对话」主题推广 Banner：属 `force_banner` 广告位（`showAdTag:true`），
  按 `fromAd` / `showAdTag` 与标题关键字 `/鲍比|BOBBY|跨时空/` 双重过滤。
- 听书 tab（`VOICEBOOK_*`）整体不接入。

## 五、WaveForge 落地约定

1. 后端新增 link-page / music-channels / cube-page / toplist / playlist-square / podcast-infinite 六条路由，
   全部走账号 cookie 指纹隔离缓存，不持久化 cookie。
2. 推荐页数据源从 `/api/homepage/block/page` 切到 `HOME_RECOMMEND_PAGE` link page；
   保留旧接口作为降级。
3. 发现页 = 音乐（频道 chips + 精选/排行榜/歌单/曲风）+ 播客；无听书。
4. 网络基址用统一 `getApiBase()`；图片经统一代理并 `http→https`。

## 六、真机逐屏对照结果（2026-09-14 ADB 审计）

方法：root + 中间人抓包，冷启动后按屏走查；再用同一批响应跑 WaveForge 归一化，逐项 diff。

### 已确认并已修复
| 缺口 | 证据 | 修复 |
|---|---|---|
| 推荐页只有第 1 页 | App 依次请求 cursor=0/7/12，第 2 页起有雷达歌单、相似歌曲、心情氛围、艺人热门金曲、场景歌单、艺人漫游、排行榜、固定歌单 | 后端接受 `order`（原始 JSON 字符串）并翻页；前端「加载更多推荐」 |
| 播客 Tab 数据源用错 | App 用无限流接口（DRAGONBALL 7 入口 + FM_CHANNEL_NORMAL + GUESS_LIKE），此前用了 `podcast/home/tab/v2`（区块完全不同） | 改用无限流接口 + 继续加载 |
| 播客固定入口少「排行榜」 | App 7 个，此前 6 个 | 随数据源修正恢复为 7 个 |
| 曲风页少第 6 个子 Tab「时空隧道」 | App ACG 页签为 全部/动漫空间/次元职人/术曲精选/游戏狂欢/时空隧道 | 不再丢弃空内容页签 |
| 曲风页缺 Banner 轮播 | App ACG 顶部「上海迪士尼 9月达菲月」等 | 图片取 `background`，放宽「无标题卡片」判定 |
| `blockCodeOrderList` 类型 | 服务端返回的是 JSON **字符串** | 归一化层解析字符串数组 |

### 尚未接入（受服务端或 App 专有能力限制）
- **精选 `PAGE_DISCOVERY_BANNER`（新歌首发轮播）**：page 与 position 两种请求都不下发该区块，仅客户端缓存里有。
- **歌单广场 `PLAYLIST_SQUARE_BANNER`（曲风编年/曲风安利大 Banner）**：`playlist/square/block/page` 各参数组合均不返回；
  该区块只在 App 客户端可见。
- **曲风页中由客户端运行时再拉取的横向模块**（如「时空隧道」的 RecommendHorizontal，`props` 只有
  `recommendModule/moduleName/url`，无内联数据）：页签已展示，内容待逐模块接入。
- **频道管理弹层**（「∨」展开 + 拖动排序频道）：WaveForge 已提供展开/收起，未做拖动排序。
- **App 专有页面入口**（我的播客、全部分类、电台等 RN 页）：在 WaveForge 内明确置灰并提示，不静默失败。

## 七、第三轮补齐（2026-09-14，新模拟器 16416）

### 推荐页「相似歌曲 / 相似艺人」不是基于当前播放
- 卡片 action 实测：
  - 相似歌曲 `orpheus://nm/play/similarFM?sourceId=["448596416",...]`（**卡片自带种子歌曲 id 列表**）
  - 相似艺人 `orpheus://nm/play/similarFM?sourceId=[14713120,510882,55888875]&sourceType=artist&sourceName=相似艺人`
- 即种子来自账号画像/关注，不依赖「当前播放歌曲」。WaveForge 落地：
  - 相似歌曲：`/api/v1/discovery/simiSong`（`songid`，每次约 5 首）× 卡片自带种子，聚合后连播；
  - 相似艺人：`/api/v1/artist/top/song`（`id`）× 卡片自带艺人 id，聚合后连播；
  - 无种子时才回退到「当前播放歌曲」的旧逻辑。

### 曲风频道「全部」页的分区数据是内联的
`MusicGenreSongListItem(type=mixedContainer) → MusicGenreSongListHeader` 内依次是：
`RecommendTabCarousel`(轮播) / `RecommendHorizontal`(ACG主打·ACG热播·ACG专属·次元陪伴·术曲精选·番剧大赏) /
`ZoneGuide` / `Card(次元职人 → Scroll → Entrance×20)` / `MusiclibraryRank(热门排行)`。
- `RecommendHorizontal.props.recommendModule[].modules[]` 两种卡片：
  - 歌单卡 `{cover, resource:<playlistId>, type:"song_list", title}`（**部分卡片不带 cover**）
  - FM 卡 `{cover, type:"fm", mode:"SCENE_RCMD", subMode:"ACG", title:"24h不间断ACG频道 一键播放"}`
- `MusiclibraryRank` 的 `playlistIds` / `titles` / `playlistTitleTpls` 是**逗号分隔字符串**，需拆分。
- 只下发 id 的卡片，封面由 `POST /api/tag/tab/playlists {ids}`（eapi，返回 `{id,name,cover,songCount,playCount}`）批量回填。
- 实测二次元「全部」= ACG主打 / ACG热播 / ACG专属 / 次元陪伴 / 术曲精选 / 次元职人 / 番剧大赏 / 热门排行 + 底部「猜你喜欢」无限流（用频道 FM 卡自带的 mode/subMode 调 `/v1/radio/get`）。

### 歌单广场「音乐新发现」六张卡无封面
- 根因：创意卡 `{creativeId, uiElement.images[...], resources:[{resourceId,...}]}` 同时有 `creativeId` 与嵌套 `resources`，
  旧逻辑判为「创意卡且含子资源」→ 不产出创意卡本身，只递归到**无图**的子资源，导致封面丢失。
- 修法：创意卡优先产出（并把 `resources[0]` 的资源 id/类型合并进来），不再下钻其子资源。

## 八、查漏补缺：把"点不动"和"跳外部浏览器"的条目全部站内化（2026-09-14）

对推荐页 2 页 + 精选 + 歌单广场 + 排行榜 + 播客 + 8 个曲风频道做了一次全量动作统计，修复前 `none`（灰卡）67 个、`web`（跳系统浏览器）10 个。

### 服务端下发但没有可用动作的条目
| 原始动作 | 处理方式 |
|---|---|
| `orpheus://songrcmd?tab=default` | 打开 WaveForge 每日推荐面板 |
| `orpheus://songrcmd?tab=style&categoryId=..&tagId=..&songId=..` | 拉风格日推并连播（`/homepage/category/daily/song/list`） |
| 裸文案动作（如 `心动模式`、`add_to_list_and_play`） | 按语义执行；心动/漫游/日推各自落到已有能力 |
| `orpheus://song/<id>`、榜单内 `play_top_list_*` | 取 `/api/v3/song/detail` 后播放 |
| `orpheus://nm/discovery/newsongalbum` | 跳「发现-音乐-精选」 |
| `orpheus://rnpage?component=rn-ranklist-homepage` | 跳「发现-音乐-排行榜」 |
| `orpheus://rnpage?component=cube-renderer-rn&page=<id>`（宝藏音乐人） | 用同一套 cube 渲染器**站内打开该页** |
| `resId=xrn`（云村出品） | 跳「发现-音乐-歌单」 |
| **纯装饰卡**（无 id、无动作、无歌曲） | 不再渲染成灰卡，直接不产出 |

### 跳外部浏览器的条目
- 新增**站内网页面板**（`NeteaseWebPanel`）：Electron 主窗口开启 `webviewTag`，用 `<webview>` 内嵌
  （不受 X-Frame-Options 限制），纯浏览器环境退回 `iframe`，并且始终保留「在浏览器打开」兜底。
- `orpheus://activity?url=<https>` 里的 https 也纳入站内面板。
- 覆盖：数字专辑商城、编辑部专题（yida）、`sg.music.163.com` 活动页、`st.music.163.com/classic-song`（音乐播客）等。

### 播客固定入口（原为灰色）
- 新增站内原生页面 `NeteasePodcastPages`：
  - **全部分类** ← `/api/voicelist/all/category/get`（19 个一级分类 + 二级分类）
  - **分类播客** ← `/api/djradio/hot?cateId=<一级分类id>`（子分类沿用一级 id 查询）
  - **我的播客** ← `/api/djradio/get/byuser/v1?userId=`
- 小程序入口（助眠解压 / 广播电台）没有可直接打开的 H5，落到「全部分类」按名字自取。
- 实测播客快捷入口 7 个全部可点，`disabled` 数量为 0。

### 结果
- 全量统计里 `none` 归零，灰卡消失；所有 `web` 改为站内面板。
- 相关回归测试 28 个（新增 song-id / cube-page / activity / 语义动作 / 装饰卡过滤等）。

## 九、交互与布局修正（2026-09-14）

- **移除「龙珠」区块**：推荐页播客区过滤 `DRAGONBALL`（它只是播客固定入口，不是内容）。
- **频道行上移**：「网易云音乐频道」标题与「刷新」并到同一行，去掉原来右对齐刷新造成的整片空白。
- **封面加载**：曲风频道改为**先渲染再异步回填封面**（原来要等 `/tag/tab/playlists` 回来才有画面，感知很慢）。
- **VIP 频道接入**：App 里是 RN 会员门户（`rn-vip-portal`），WaveForge 用同一批接口站内渲染：
  `vipnewcenter/app/level/myvip`（等级/成长值）+ `vipnewcenter/app/position/rights/suite/list`（32 个权益）+
  `vipcenter/rec/pendant/list`（28 个推荐）。此前该频道是空白。
- **层级导航**（二级/三级）：
  - 进入下一级 → 滚动回到顶部；返回 → 还原上一级的滚动位置；切换一级 Tab / 频道 → 回到顶部。
  - 层级切换带 `netease-level-in` 过渡动画。
  - 播客「全部分类 → 分类详情」的返回**直接回到最外层播客首页**（用户要求），并还原首页位置。
- **播客/电台列表改铺开网格**：`NeteaseNativeBlock` 新增显式 `layout:'grid'` 提示，数量不多的分类列表按 2–5 列换行铺开，不再挤成一排横向拖动。
- **空导航卡过滤**：无封面、无歌曲/歌单的纯跳转卡（如区块自带的「新歌新碟」入口）不再产出，避免出现空白卡片。

## 十、按 App 实际界面重做 VIP + 修复封面加载（2026-09-14，Android 15 抓包）

### 抓包环境（Android 15 的关键差异）
- 旧模拟器是 Android 12/13，CA 装到 `/system/etc/security/cacerts` 即可；
  **Android 15（SDK 35）的信任锚在 APEX**：`/apex/com.android.conscrypt/cacerts`。
- 且必须挂进 **zygote 的 mount namespace**（App 由 zygote fork，挂 init 命名空间无效）：
  `nsenter --mount=/proc/$(pidof zygote64)/ns/mnt -- mount --bind /data/local/tmp/cacerts2 /apex/com.android.conscrypt/cacerts`
- 完成后 `/eapi` 全部可解，流量从个位数涨到上百。

### VIP 频道（发现-音乐-VIP）真实结构
App 里不是「权益套餐列表」，而是：
1. 左侧 VIP 歌曲/专辑推荐卡（由 `delivery/deliver` 下发，未下发时隐藏）
2. 右侧续费卡：等级图 + 轮播文案 + 续费按钮 + 权益图标
3. 「每天免费听VIP歌曲」歌曲列表（带「十万红心 / 昨日百万播放」等理由标签）

对应接口：
| 用途 | 接口 | 关键参数 |
|---|---|---|
| 续费卡文案/等级图/轮播 | `/api/vipnewcenter/app/resource/newaccountpage` | `groupName=t2` |
| 会员等级与成长值 | `/api/vipnewcenter/app/level/myvip` | - |
| 权益图标（5 个） | `/api/music-vip-configuration/config/query` | **`configName=vip.tab.rights`**（缺参数会 400） |
| 每天免费听VIP歌曲 | `/api/vipnewcenter/app/viptab/recommend/song/list` | - |

> 之前用的 `position/rights/suite/list`（32 个联名装扮）与 `vipcenter/rec/pendant/list`（周边挂件）**不是** VIP 频道内容，已移除。

### 封面加载不出来的根因（影响所有频道）
`src/services/artwork.ts` 的 `resizeArtworkSource` 对网易云封面用 `new URL()` 往返重编码：
- `enlarge=1|imageView=1` 里的 `=` 被编码成 `%3D`
- 无值参数 `watermark` 被写成 `watermark=`
上游因此直接返回 **400**，表现为「封面加载不了 / 很慢」。实测同一 URL 走代理 400、原样拼接后 200。
修法：网易云封面改为**纯字符串追加 `param=<n>y<n>`**，不再重编码。修复后 OST/ACG 等频道封面正常显示。

### 走查结论
逐个走查「发现-音乐」频道并抓包对照：各频道的频道行、分区、封面与 App 一致；
`排行榜/歌单/精选` 分别走 toplist / playlist-square / link-page，其余曲风频道走 cube 协议 + `/tag/tab/playlists` 补封面。

## 乐流（推荐页「继续探索」）修复 2026-09-14

现场用 `--remote-debugging-port` 附加渲染进程 + 读取 React fiber 状态定位，全部结论均有运行时证据。

### 1. 乐流里点开歌单没有封面（详情面板整块空白）
现象：卡片封面正常，点开后歌单详情右上封面是空占位符。

根因：`src/services/artwork.ts` 的 `resolveArtworkUrl` **不幂等**。
同一张图会被解析两次——`CachedImage` 先解析出渲染地址（`/cover?url=<封面>?param=256y256`），
`preloadArtwork` 再对**这个已经解析过的地址**解析一次，`unwrapArtworkSource` 取回内层
`<封面>?param=256y256` 后，网易云分支又追加一个 `param`，得到
`?param=256y256&param=256y256`（实测 fiber 状态：`imageSrc` 158 字符 ≠ `normalizedSrc` 140 字符）。
`displaySrc` 的一致性判断因此不通过，回落到 `cached`（未命中为 null），组件永远停在 `bg-white/10` 空占位符。
只有 IndexedDB 命中时才会返回 `blob:` 而侥幸显示，所以表现为「有的封面正常、有的空白」。

修法：网易云分支已存在 `param=NyN` 时**替换数值**而不是追加，使 `resolve(resolve(x)) === resolve(x)`。

### 2. 超长简介把整张卡片撑高
现象：乐流里个别卡片简介极长（实测 208 字符），卡片被撑到约 230px，整行随之变高。

根因：简介用 `block line-clamp-2`。Tailwind v4 产物里 `.block`(byte 25176) 排在
`.line-clamp-2`(byte 24846) **之后**，`display:block` 覆盖了 `line-clamp` 需要的
`display:-webkit-box`，截断完全失效（构建产物实测字节位置）。

修法：去掉多余的 `block`（`-webkit-box` 本身就是块级），并把卡片改为固定高 `h-[108px]` + `overflow-hidden`，
标题/简介各最多 2 行（`text-sm 20px*2 + 4 + text-xs leading-relaxed 19.5px*2 = 83px ≤ 108-24`）。
修复后实测：最长简介 208 字符仍只占 2 行 39px，所有卡片高度一致（108px）。

### 3. 最后一行缺角
现象：乐流第 4 行只有 1 张，缺 3 张。

根因：服务端每批返回约 10 条且与上一批重叠，前端按资源 key 去重后数量不是 4 的倍数。

修法：渲染时裁到 4 的整行（多余的最多 3 条留到下次），并且「加载更多乐流」在数量不是整行时
继续取批（最多 4 次）直到刚好填满。实测：加载更多后 12 张（12 % 4 = 0），最后一行完整。

### 4. 乐流里的 MV 先打开 MV 专区再播放
现象：点 MV 先进入 MV 专区列表，再自动播放。

修法：`MVExploreModal` 增加 `directPlay`，为真时只渲染播放器；乐流的 `onOpenMV` 置为 true，
`onOpenMVs`（主动打开专区）置为 false。实测：点击乐流 MV 卡片后直接出现 `<video>` 且
`paused === false`，DOM 中没有专区搜索框。
