/**
 * 内置插件：共振（多人一起听）。
 *
 * 定位：把「一起听」做成本软件的一个模式（ViewMode='resonance'），而不是一个悬浮面板。
 * 房间由房主进程内的局域网中转承载（只转发端到端加密信封），我们不运营任何服务器。
 *
 * 三条硬承诺（与插件使用须知、免责声明一致）：
 *   1. 不传音频：各成员用自己的账号与音源播放，房间只同步「哪首歌、播到哪一秒」；
 *   2. 不绕会员：任何人的会员权益都不共享，播放不了就明示原因并走投票跳过；
 *   3. 不经服务器：房间内容端到端加密，中转只看到密文，无统计、无上报。
 */
import { registerBuiltinPlugin } from './registry'
import type { PluginManifest } from './types'
import { RESONANCE_NOTICE_POINTS, RESONANCE_NOTICE_TITLE } from '../features/resonance/ResonanceNotice'

export const RESONANCE_PLUGIN_ID = 'resonance'

/** 使用须知条目（与共振模式内的 5 秒免责声明同一份文案） */
const noticePoints = RESONANCE_NOTICE_POINTS.map((point, index) => `${index + 1}. ${point.title}：${point.text}`)

export const resonanceManifest: PluginManifest = {
  id: RESONANCE_PLUGIN_ID,
  name: '共振 · 一起听',
  version: '1.0.0',
  developer: 'WaveForge 内置',
  description: '和朋友一起听同一份队列：各自用自己的平台与会员音源播放，房间内容端到端加密、不经任何服务器。最多 15 人。',
  updated: '2026-09-16',
  icon: '/resonance-logo.svg',
  iconColor: '#ff5a70',
  requireNotice: true,
  notice: {
    entry: [RESONANCE_NOTICE_TITLE, '', ...noticePoints],
    consent: [
      '共振不会共享任何人的会员权益：你听不了的歌就是听不了，房间会提示原因并可发起跳过投票。',
      '房间只同步「放哪首歌、播到哪一秒」，音频永远来自你自己的账号与设备，成员之间不传输音频。',
      '房间内容端到端加密、不经任何服务器；但房间密钥由房主生成，房主在技术上可以解密房间内容。',
      '房间内可见的只有你的昵称与平台徽章；请勿把房间用于公开传播或商业用途。',
    ],
  },
  detail: [
    '## 这是什么',
    '把「一起听」做成本软件的一个独立模式：打开「共振」后你可以创建房间（共享歌单 / Party / 我推荐），或粘贴房主的邀请串加入。',
    '',
    '## 三种房间模式',
    '- **共享歌单**：房主把自己的歌单整单推入，其他人加入就能跟着听；房主退出即结束。',
    '- **Party**：任何人都能从自己的歌单或搜索里加歌。',
    '- **我推荐**：房主先推第一首，之后按入房顺序轮流推荐，每人 1–3 首（房主可设）。',
    '',
    '## 怎么保证每个人的声音都对',
    '房间只同步「放哪首歌、播到哪一秒」。每个人在自己的账号下解析出可播放的版本（跨平台匹配 + 会员校验），因此',
    'A 用 Apple Music、B 用 QQ、C 用网易云也能一起听；**播不了的成员会静音跟随并看到原因**，房间可以发起跳过投票（当前在线人数 8 成同意）。',
    '',
    '## 隐私与安全',
    '- 房间内容用 XChaCha20-Poly1305 端到端加密，密钥由邀请串里的种子派生（HKDF），**中转只看到密文**。',
    '- 房间内可见的只有昵称与「已登录平台 / 会员档位」徽章；平台账号、Cookie、音源地址永不外发。',
    '- 没有任何遥测与上报；房间人数上限 15 人。',
    '- 房间密钥由房主生成，因此房主在技术上可以解密房间内容（与群聊主持人相同）。房间指纹可用于当面核对。',
    '',
    '## 已知边界',
    '- 不提供试听兜底（30 秒片段）：听不了就是听不了，我们会明确告诉你并支持跳过。',
    '- 局域网之外的成员需要 WebRTC 通道（本期先支持局域网直连；异地连接为后续增强）。',
  ],
  source: 'builtin',
}

registerBuiltinPlugin(resonanceManifest, {
  onEnable() {
    // 开启插件本身不做任何联网动作：真正的房间在你创建/加入时才建立。
  },
  onDisable() {
    // 关闭插件 = 退出当前房间（避免留下无人管理的房间中转）。
    void import('../features/resonance/session').then(({ clearResonanceSession }) => clearResonanceSession())
  },
})
