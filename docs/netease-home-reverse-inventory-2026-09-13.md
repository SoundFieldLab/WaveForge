# 网易云推荐首页逆向清单（MuMu 9.5.90）

采样设备：`adb -s 127.0.0.1:16384`。`127.0.0.1:5555` 与 `16384` 指向同一 MuMu 实例，未并行使用。

## 顶部入口

实机 UI XML 确认的入口顺序：

1. 每日推荐：今日限定好歌推荐
2. 心动模式：红心歌曲和相似推荐
3. 雷达歌单：反复聆听你爱的歌
4. 漫游：多样频道无限畅听
5. 相似歌曲：从你喜欢的歌听起
6. 相似艺人：从你喜欢的艺人听起

每日播客位于后续入口，当前按需求不接入顶部六张。

原生入口图片来自服务端 `uiElement.image.imageUrl`；`purePicture=true` 时优先 `purePictureUrl`。入口主体图片不是任意专辑封面拼图。

## 已采样内容区块

- 推荐歌单
- 你喜欢的日语
- 【Key Song BEST TEN】Key最受欢迎的歌曲
- 你可能感兴趣
- 新歌首发
- 猜你喜欢的「日文」好歌
- 最近常听
- 我喜欢的音乐
- 根据你喜爱的歌曲推荐
- YoshinoRinne的雷达歌单
  - 私人：今天从《Saya's song》听起
  - 会员：今天免费听《Thank You (feat. 정소연)》
  - 宝藏：从《A Promise》开启宝藏音乐环游
  - 时光：听你爱的《花,太阳,彩虹,你》
- LiSA等艺人热门金曲
  - 听·LiSA热门精选|ADAMAS (TV Size)
  - 听·米津玄師热门精选|打上花火
  - 听·The Score热门精选|Better Than One
  - 听·南征北战NZBZ热门精选|不凡歌
- 从你喜欢的艺人开始漫游
  - Two Steps From Hell
  - АДЛИН
  - Vicetone
  - Avicii
- 场景歌单
- 心情氛围
- 你的专属推荐歌单
  - 2000年代专属
  - 2010年代专属
  - 嘻哈说唱专属
  - 国语专属
- 影视原声
- 从你喜欢的音乐听播客

原始截图和 UI XML 保存在 `.tmp-netease-reverse/full-home2/`，仅用于本地验收，不包含账号 cookie。

## 已实现

- native/DSL 多根资源合并：`creatives`、`resources`、`resourceInfoList`、`dslData`、`nativeData`、`rnData`、`crossPlatformConfig`。
- 父级标题、action、封面字段向 `resourceInfoList` 子资源继承。
- 图片对象递归提取真实 URL，并统一 `http` 到 `https`，避免出现 `[object Object]` 或空封面。
- `showType`/`blockCode` 的歌曲、歌单、排行榜、艺人、场景、心情、影视和播客类渲染 fallback。
- 桌面端顶部六张卡自适应六列，窄屏降为三列/两列。
- 每日推荐主体打开日推弹窗；右下角播放按钮直接播放日推第一首。
- 雷达歌单和漫游播放按钮执行对应播放动作。
- 相似歌曲按当前网易云歌曲请求并直接播放；相似艺人打开相似推荐结果。
- 顶部卡标题/副标题固定，不被普通推荐资源覆盖。

## 验证

- `test/neteaseNativeExplore.test.ts`：19 tests passed
- `test/neteaseExploreArtwork.test.ts`：2 tests passed
- `test/neteaseResourceView.test.tsx`：3 tests passed
- TypeScript `tsc --noEmit`：通过
