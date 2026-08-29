/**
 * 版本历史（关于 → 更新 → 版本历史）。
 *
 * 内容维护约定：与 GitHub Releases（YoshinoRinn/WaveForge）及 git 版本节点保持同步。
 * 每次发布新版本时，把上一版条目挪到这里（保留完整说明），并在顶部加入
 * 「当前版本」条目——更新日志（update.json 的 notes）与该处文案保持一致。
 *
 * notes 写法约定（与发布脚本 --notes 一致）：
 *   按「新功能 / 改进 / 修复」分组，面向用户描述，避免内部代号与提交号；
 *   单条一行、以 - 开头；没有的分组可以省略。
 */
export interface VersionHistoryEntry {
  version: string
  date: string
  /** true = 当前已安装版本（列表顶部高亮） */
  current?: boolean
  notes: string
}

export const VERSION_HISTORY: VersionHistoryEntry[] = [
  {
    version: '0.1.4',
    date: '2026-08-21',
    current: true,
    notes: `✨ 新功能
- AutoMix v2：AI 混音（DJTransGAN 60s 长混音）与增强版 DSP 短过渡
- AirPlay 投送：mDNS 设备发现 + RAOP/AirPlay2 会话
- 空间音频预设与 DSP 增强
- 任务栏歌词小组件
- Bilibili 观看模式
- Apple 账号登录
- 代理自动配置：网络不佳时模型下载/更新走本地代理
- 应用热更新：小版本更新免安装向导，下载后重启即生效

⚡ 改进
- 桌面融合窗口与最大化修复
- 纯音乐（无歌词）识别
- 设置页弹窗与播放页修复
- TV 端遥控调试与 DPI 修复
- 内置 Python 3.13，一键安装 AI 混音运行环境`,
  },
  {
    version: '0.1.3',
    date: '2026-08-17',
    notes: `✨ 新功能
- 多端统一更新机制：TV + PC 共用多源更新清单（Gitee 主源 + ghproxy 加速 GitHub），PC 端真实下载安装
- 更新提示 UI：全局顶部卡片（分客户端）+ 更新成功弹窗（可折叠更新内容）
- TV/Android 端初始移植：WebView 壳 + 设备内置 Node + 遥控器交互层
- TV 端 QQ 音乐登录：应用内扫码登录
- TV 性能模式系统：配置检查 + 三档模式（效能/普通/增强）
- 遥控器增强：TV 光标模式 + 多设备切换
- Apple Music 歌词/封面/对唱功能 + 探索页 Apple 平台偏好

⚡ 改进
- 融合音效引擎 v3（纯 TS DSP 内核）并修复多轮试用反馈
- 探索页设置重构 / 封面墙背景 / 歌曲详情增强 / 双平台 API 补齐
- A 方案版本代号（日文标注）落库

🐛 修复
- 网易云歌词只剩「作词/作曲」、封面换错（Apple Music 集成回归，Win+TV 通用）
- 歌词缓存 v2→v3：作废修复前的旧缓存
- TV 设置页焦点到开关白屏、遥控导航与调试面板修复
- 移除「摩登」播放页模式（按用户要求删除）`,
  },
  {
    version: '0.1.2',
    date: '2026-08-16',
    notes: `🐛 修复
- 回归修复：队列裁剪闪白、音频 NotAllowedError 静默处理、MV / 关注歌手 cookie 问题`,
  },
  {
    version: '0.1.1',
    date: '2026-08-16',
    notes: `✨ 新功能
- 融合音频引擎 v3：机型预设 + 设备频响库 + 20 段 EQ + 64 阶 IIR + 内置混响 + 听力分析
- 调音室 v3 UI：6 套综合场景预设 + 「总览」默认选项卡
- QQ / 网易云 API 全面补齐 + 社交与个人中心重构
- 歌曲详情横向 UI + 歌词弹窗（复制/翻译/罗马音）+ 双平台推荐
- Apple 逐字歌词模式（独立模式，词内从左到右填充推进、SF Pro 字体链）

⚡ 改进
- 全面性能优化：首屏瘦身、评论/艺人列表虚拟化、组件 memo、gzip 与 keep-alive、启动延迟初始化
- 导航栈重构 + 深浅色过渡 + 相似歌曲面板

🐛 修复
- 歌词逐字渲染修复（唱完不再「砸一下」、辉光平滑过渡）
- 浅色模式 UI 可读性修复`,
  },
  {
    version: '0.1.0',
    date: '2026-06-27',
    notes: `✨ 首个正式版：沉浸式桌面音乐播放器（QQ 音乐 + 网易云）
- 无缝播放：专辑曲目直切拼接，非专辑曲目 60ms 等功率淡入淡出
- 调音室：Liquid Glass 界面 + 3D 环绕声修复
- 动画设置页标签
- 启动稳定性修复
- per-user 安装（无需管理员权限）
- 内置 Python 3.13`,
  },
]
