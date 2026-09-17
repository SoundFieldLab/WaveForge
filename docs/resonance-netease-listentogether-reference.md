# 网易云「一起听」逆向对照（9.5.90）— 共振插件参考

> 目标：为 WaveForge 的「共振」插件（P2P 多人一起听）确定功能范围与协议取舍。
> 证据等级：**已证实（运行）** = ADB 实机界面 / logcat；**已证实（APK）** = base.apk 静态提取。

## 0. 证据与方法

- 设备：MuMu 模拟器 `adb -s 127.0.0.1:16416`，网易云 `com.netease.cloudmusic` 9.5.90。
- 运行证据：`input tap` 逐屏走查 + `uiautomator dump` + `screencap` + `logcat`（`cr_request` 行会打印真实请求 URL）。
- 静态证据：`adb pull` 得到 `base.apk`（234 MB），本地解包后用自写脚本读取
  `AndroidManifest.xml` 字符串池、`classes*.dex` 字符串池（`\u0000` 分隔的 MUTF-8）、
  `resources.arsc`（UTF-8 中文串）。脚本为一次性分析工具，不入库。

## 1. 入口与界面（实机）

播放页「⋯」菜单 → **一起听** → `LTInviteActivity`（一起听邀请页）：

- 顶部：「一起听」｜「查看记录」｜「匹配设置」
- 两个陌生人匹配入口：**匹配双人听** / **匹配多人听**
- **邀请 AI 搭子**（`查看全部`，共 4 个轮播人设，如云宝/方岑/秦宇，带人设标签与状态文案）
- **邀请听友**：微信 / 朋友圈 / QQ / **复制链接**；下方好友列表（多选圆圈）

「一起听记录」页（`LTChatRecordActivity` 一系）：

- 「和Ta最常一起听」：双人头像 + 「陪伴彼此 *分钟」「一起听过 *首歌」+ 「**缘分报告**」
- 「一起听历史」：按日期分组 + 「整理」
- 底部：「**开通会员**」+「查看全部一起听记录，找回失踪的 TA」→ **完整记录是会员功能**

「匹配设置」页（双人匹配偏好）：

- 音乐偏好（多选）：不限/流行/欧美/日本/韩国/粤语/电子/嘻哈/民谣/摇滚/原声/古典/爵士/轻音乐/其它
- 性别偏好：不限/男/女
- 自动匹配：不开启 / 5 分钟 / 30 分钟 / 60 分钟（「30分钟内对方退出将自动匹配下一位」）

**会员门槛（实测）**：点 AI 搭子的「一起听」会拉起收银台
（`CashierRNActivity`，同时请求 `vipnewcenter/*`、`vipproduct/cashier/package/list`），
随后退回邀请页 —— **AI 搭子一起听是会员功能**，因此本机无法进入房间实测房间内部 UI。

## 2. 组件（AndroidManifest）

```
module.listentogether.ListenTogetherTestActivity                 # 内部测试页
module.listentogether.invite.LTInviteActivity                    # 邀请页（实机入口）
module.listentogether.invite.ListenTogetherInviteActivity
module.listentogether.chat.LTChatRecordActivity                  # 一起听记录
module.listentogether.screenshot.LTScreenShotShareActivity       # 一起听截图分享
module.listentogether.playpage.chat.message.ui.ListenTogetherMessageHistoryActivity  # 消息历史
```

## 3. 模块结构（dex 包名，classes18/19/20）

```
playpage                       # 房间主体
playpage.multi                 # 多人一起听
playpage.followlisten (+api/rpc/intercept)  # 「跟听」：被动跟随别人的播放，独立房间与接口
playpage.newframe              # 新版框架
playpage.chat.message (+view/translation/repositories/ui)  # 聊天与消息翻译
playpage.streak                # 连听天数
playpage.pendant               # 头像挂饰
playpage.follow.vh             # 关注/一起听用户视图
rpc / meta / utils
```

## 4. 服务端接口（dex 字符串池提取，按功能分组）

> 全部走网易云自己的服务器（`interface3.music.163.com/xeapi/listen/together/*`）。
> 实测创建房间：`_listentogether_start` → `xeapi/listen/together/room/create`。

**房间生命周期**
`room/create`、`room/check`、`end/v2`、`end/check`、`query/exit/info`、`restore/reconnect/info`、
`device/reconnect/notice`、`heartbeat`、`status/get`、`common/liked/song/report`

**邀请与匹配**
`invitation-info/get`、`invitation/reject`、`invite/message/send`、`play/invitation/accept`、
`multi/invite`、`multi/match`(+`/ack` `/cancel` `/exit` `/heartbeat` `/status/get` `/msg/history`
`/msg/translate/retry` `/song/operate`)、`multi/room/create`、`multi/start/msg`、
`multi/special/msg/history`、`multi/special/song/operate`、`change-multi/check`、
`listening/invite/remind/today/close`、`friend/online/guide/v2`、`mutual/follows/get(/v2)`

**权限与隐私**
`privilege/get`、`privilege/change/report`、`listening/privacy/get`、`listening/privacy/update`、
`user/state/config`、`user/state/get`、`user/state/set`

**播放与队列同步**
`play/command/report`、`sync/notice`、`sync/playlist/get`、`sync/list/command/report`、
`room/songs/list`、`playlist/create/notify`、`playlist/experiment/group`、
`song/match`(+`/ack` `/cancel` `/start` `/info/list` `/read/report` `/identity/unlock`)、
`heart/rcmd/change`

**互动**
`emoticon/get`、`emoticon/report`、`avatar/pendant/batch/get`、`avatar/pendant/show/get|set`、
`streak/info`、`streak/checkin`、`distance/get`、`relation/statistics/get/v2`、
**`agora/token/get`（实时语音，第三方 Agora RTC）**、`float/activity/get`、`notice/popup`

**商业化 / 定位**
`ask/for/vip`、`vip/gift/report`、`user/gps/report`（距离功能用的定位上报）

**跟听（另一套房间模型）**
`follow/listen/create/room`、`follow/listen/join/room`、`follow/listen/room/exit`

## 5. 关键语义（dex/arsc 中文文案，直接引用）

- **双人**：「一起听时，双方的切歌、暂停、快进等操作都会同步。」
- **多人**：「一起听时，**房主的**切歌、暂停、快进等操作会同步。」
- 「正在一起听，**仅房主可以推荐歌曲**。」
- 「可额外添加歌曲到当前一起听列表」（被授权后）。
- 「设置成功，**下次一起听开始生效**哦」→ 权限变更不立即生效。
- 「很抱歉，您的一起听连线异常断开…**再次连线后一起听时长将继续累积统计**。」
- 「你离开一起听**超过2个小时**了，已自动退出。」
- 「检测到存在**你管理的一起听房间，是否恢复**。」
- 「对方邀请了新伙伴，**转换为多人一起听**。」→ 双人房可升多人。
- 「一起听**30秒点亮星星**后，可查看详情。」→ 时长解锁详情。
- 「当前未在播放歌曲，**无法发起一起听**。」
- 「由于您**频繁退出**一起听，暂时无法继续匹配。」→ 匹配惩罚。
- 「你的一起听/**听友版本过低**，不支持多人一起听。」
- 「**正在一起听跟听**，该操作暂不能使用哦」→ 跟听与一起听互斥。
- 「当前为**车载**一起听，请在车载端调节音量。」
- 「已**揭面**，关注TA方便下次一起听。」→ 陌生人匹配先匿名后揭面。

## 6. 与「共振」的对照

| 能力 | 网易云 | 共振（我们的取舍） |
|---|---|---|
| 房间承载 | 自家服务器（room/create…） | **房主即 Hub**（局域网 WS / 异地 WebRTC），零自建服务器 |
| 同步权威 | 双人双向；多人**房主独控** | **房主权威时钟** + 三种房间模式；房主可交接（含 term 防双权威） |
| 谁能点歌 | 默认**仅房主**，可授权 | 共享歌单=房主推整单；Party=人人可加；我推荐=按入房顺序轮流、每人 1–3 首 |
| 音频 | 平台统一下发 + 会员体系 | **各人用自己平台音源**，绝不传音频；不可绕过会员；播不了就明示 |
| 权限模型 | `privilege/get|change`，下次生效 | 房主/成员 + 可传控制权（即时生效，带 term 序号） |
| 断线恢复 | `restore/reconnect/info`、2 小时自动退出、时长累计 | 心跳 2s / 3 次丢失标记离线；房间状态可重放；房主退出→交接或结束 |
| 时长/关系运营 | `streak/info|checkin`、`distance/get`、`relation/statistics`、缘分报告（会员） | 本期做**房间内共同收听时长 + 一起听歌曲数**（本地统计，不上报） |
| 语音 | **Agora RTC**（`agora/token/get`） | 预留：WebRTC 音频轨（纯 P2P，可选开关），本期不做 |
| 聊天 | 消息 + 表情 + **翻译** + 历史 | 文字 + 表情（同一加密通道）；翻译不做 |
| 截图分享 | `LTScreenShotShareActivity` | 预留（本地生成房间卡片） |
| 陌生人匹配 / AI 搭子 | `multi/match/*`、AI 搭子（会员） | **不做**（必须有服务器，且与隐私承诺冲突） |
| 跟听（被动跟随） | 独立房间与接口 | **不做**（与房主权威模型重叠，价值较低） |
| 商业化 | 求会员 / 送会员礼物 / 记录会员 | **不做** |

## 7. 限制与未验证项

1. **房间内部 UI 未能实测**：AI 搭子需会员；邀请真人会打扰第三方，未执行；陌生人匹配属对外社交行为，未执行。
   因此房间内部的布局/交互细节来自 dex 文案 + 接口语义反推，而非截图。
2. 中文文案取自 `resources.arsc` 与 dex 字符串池的静态提取，可能包含历史版本或未启用的分支文案。
3. 语音（Agora）仅确认存在 `agora/token/get` 与依赖，未验证其房间内表现形式。
4. 「跟听」与「一起听」的区别只从接口与文案推断（跟听=被动跟随播放），未逐屏验证。
