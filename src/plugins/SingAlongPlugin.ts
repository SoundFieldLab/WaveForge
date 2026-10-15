/**
 * 内置插件：学歌（SingAlong）。
 *
 * 边放边学的跟唱练习：播放中打开学歌面板，逐句歌词卡拉OK式高亮，
 * 麦克风实时音高检测 + 音准/节奏评分，整曲汇总成绩。纯本机能力，
 * 不上传任何录音与评分数据。
 */

import type { PluginManifest, PluginRuntime } from './types'
import { registerBuiltinPlugin } from './registry'
import { closePluginConsole } from '../services/pluginStore'
import { MicPitchTracker } from './clients/singalong/micPitchTracker'

export const SING_ALONG_PLUGIN_ID = 'sing-along'

/** 全局麦克风追踪器单例：插件启用时创建，面板按需 start/stop。 */
export const singAlongMicTracker = new MicPitchTracker()

const manifest: PluginManifest = {
  id: SING_ALONG_PLUGIN_ID,
  name: '学歌',
  version: '1.0.0',
  developer: 'WaveForge 团队',
  description: '边放边学两种练法：跟唱练习（麦克风实时评分）或自学跟读（逐句拆解、慢速循环、标记学会，免麦克风）',
  updated: '2026-10-12',
  iconColor: '#7c5cff',
  detail: [
    '学歌插件把正在播放的歌曲变成逐句跟学：面板里逐句显示歌词（带翻译），当前句按字卡拉OK式点亮。两种练习模式随你选：',
    '· 跟唱练习（有麦克风时用）：麦克风实时音高检测（YIN 算法），每句唱完立刻结算音准分与节奏分，整曲汇总成绩单；',
    '· 自学跟读（没有麦克风/不方便开麦时用）：不需要任何权限——把歌拆成一句一句，点哪句播哪句，可以单句循环、慢速（0.5x/0.75x）跟读模仿，学会一句就打个勾，逐句进度按歌曲记住，下次接着学；',
    '· 「单句循环」+「慢速跟读」组合是啃硬骨头的用法：一句反复放到会为止，速度练上去再回原速；',
    '· 两种模式随时切换，学同一首歌可以先用自学跟读背熟词，再用跟唱练习测水平。',
  ],
  requireNotice: true,
  notice: {
    caution: '跟唱练习模式需要使用您的麦克风，请留意隐私：',
    entry: [
      '「跟唱练习」模式开启后，打开练习面板时会请求麦克风权限（也可只用「自学跟读」，它不需要任何权限）。',
      '麦克风音频仅在本机实时分析（音高检测），不会录音、不会上传、不会保存。',
    ],
    consent: [
      '使用麦克风功能时，系统指示灯会保持点亮，这是系统行为。',
      '所有音频分析与评分都在本机完成，WaveForge 不上传任何音频数据。',
      '「自学跟读」模式不使用麦克风、不上传任何数据，学会标记只存在本机。',
      '跟唱评分需要歌词带逐字时间轴；部分歌曲只有行级歌词，此时仅评节奏。',
    ],
  },
  source: 'builtin',
}

const runtime: PluginRuntime = {
  onEnable() {
    // 启用插件本身不做任何动作：麦克风在面板打开练习时才申请权限
  },
  onDisable() {
    closePluginConsole(SING_ALONG_PLUGIN_ID)
    void singAlongMicTracker.stop()
  },
}

registerBuiltinPlugin(manifest, runtime)

export default manifest
