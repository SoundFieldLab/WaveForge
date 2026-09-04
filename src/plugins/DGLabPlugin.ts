/**
 * 内置插件：DG_LAB（郊狼电击器联动）。
 *
 * 启用后：激活渲染端 DGLabClient（连接本地中继 → 灰度特征 → V3/V4 指令），
 * 音乐波形实时转换为郊狼 A/B 双通道电流。停用后中继侧自动 clear 归零。
 */

import type { PluginManifest, PluginRuntime } from './types'
import { registerBuiltinPlugin } from './registry'
import { dglabClient } from './clients/DGLabClient'

const DGLAB_LOGO = 'https://www.dungeon-lab.cn/img/logo-new.png'

const manifest: PluginManifest = {
  id: 'dglab',
  name: 'DG-LAB',
  version: '0.2.0',
  developer: 'WaveForge 团队',
  description: '把音乐变成身体的感受：内置 7 种体感风格，支持真立体声左右声道，让每一首歌都有不一样的「触感」',
  updated: '2026-08-26',
  icon: DGLAB_LOGO,
  iconColor: '#FFE89C',
  requireNotice: true,
  notice: {
    entry: [
      '此插件是为部分特定人群准备，如果您不知道此功能是什么就不用了解。',
      '未满 18 周岁禁止进入与了解此插件。',
    ],
    consent: [
      '请确认您的年龄已满 18 周岁，有自主的行为能力。',
      '使用本插件造成的一切后果由您自己承担。',
      '严禁将贴片或其他配件用于上半身的任何地方（耻骨区之上），造成不可挽回的事故后果自负。',
      '使用中注意控制强度与时长，如有不适立即停止。',
      '本插件仅供娱乐，一切风险与后果需自行承担；请在确保自身安全的前提下享受。',
    ],
  },
  detail: [
    'DG-LAB 插件把正在播放的音乐变成身体的「触感」——不需要理解波形细节，选择一种风格就能感受到完全不同的体感：',
    '· 立体声：A=左声道、B=右声道，跟随歌曲真实的左右声像（贴在大腿左右区分最明显）；',
    '· 心跳：每一拍一次「咚-哒」双脉冲律动；呼吸：缓慢起伏、两腿交替；潮汐：波浪横滚；敲击：鼓点短促交替；流动：连绵平缓；重拳：低音重击。',
    '· 强度自动适配歌曲轻重：轻歌放大、重歌收敛，升降快慢跟随歌曲节奏；',
    '· 「强度差（体质档）」与「恢复适应时间」让你按自己的身体耐受度设置，暂停后续播、重新启用都会缓慢过渡，绝不突跳；',
    '· 连接后控制台自动检查 App 硬上限，超出会自动下调并提示。',
  ],
  source: 'builtin',
  needsAudio: true,
}

const runtime: PluginRuntime = {
  onEnable: () => {
    dglabClient.activate()
  },
  onDisable: () => {
    dglabClient.deactivate()
  },
}

registerBuiltinPlugin(manifest, runtime)

export default manifest