/**
 * In Party 派对玩法中心（GameHub）：五个新玩法的纯逻辑状态机。
 *
 * 设计：所有玩法共用一个 hub 快照（同一时刻房间进行一个玩法），
 * 信令走 session 的 E2E 通道，惩罚统一走对方安全层（ctrl-op）。
 *
 * 玩法：
 *  1. truth-dare  真心话大冒险——转盘选人，选中者选「真心话」或「大冒险」，
 *     完成确认后过；拒绝/超时吃小电。
 *  2. beat-echo   节拍模仿——系统给出一段「强-弱-强」节拍谱，发起人用互控
 *     台照谱电自己（作演示），其他人凭体感复述谱子，错最多的人吃电。
 *  3. red-light   红绿灯（一二三木头人）——「绿灯」阶段全员可随意互电，
 *     「红灯」一响必须立刻紧急叫停（pauseMe），最慢归零的人吃电。
 *  4. relay-shock 接力电——按入房顺序轮流「传电」，每人被电后 3 秒内必须点
 *     「传给下一位」，超时断链者吃双倍电。
 *  5. guess-song  猜歌名——听当前正在放的歌（同步听），最快猜出歌名者安全，
 *     其余随机一人吃电。
 *
 * 惩罚统一走 target 自己的安全层（远程上限/跳变/倒计时都生效）。
 */
import type { PartyRemoteOp } from './model'

export type GameKind = 'truth-dare' | 'beat-echo' | 'red-light' | 'relay-shock' | 'guess-song'

export const GAME_LABEL: Record<GameKind, string> = {
  'truth-dare': '真心话大冒险',
  'beat-echo': '节拍模仿',
  'red-light': '红绿灯',
  'relay-shock': '接力电',
  'guess-song': '猜歌名',
}

export const GAME_HINT: Record<GameKind, string> = {
  'truth-dare': '转盘选人：真心话或大冒险，拒绝吃小电',
  'beat-echo': '看谱电自己作演示，别人凭体感复述，错最多吃电',
  'red-light': '绿灯互电，红灯立刻归零，最慢的吃电',
  'relay-shock': '按顺序传电，3 秒内传给下一位，断链吃双倍',
  'guess-song': '听房主正在放的歌，最快猜出歌名者安全',
}

/** 真心话题库 / 大冒险任务（全本地） */
export const TRUTH_QUESTIONS = [
  '房间里你觉得谁的设备上限最高？',
  '你第一次玩电是什么场景？',
  '说出你最喜欢的一种波形和原因',
  '你被电过最狠的一次是多少强度？',
  '如果只能留一个玩法，你留哪个？',
  '你在派对里最想控谁一下？为什么？',
  '说一个你还没试过但想试的玩法',
  '你觉得今晚谁最放得开？',
]

export const DARE_TASKS = [
  '让任意成员用「撩一下」电你，然后说谢谢',
  '把你的 A 通道上限临时调高 10，坚持 30 秒',
  '用最快语速念「我爱被电」五遍',
  '接受任意成员一次「惩罚」档快捷电击',
  '开 10 秒摄像头让大家看到你被电的表情',
  '下一个决斗你主动参加，不管输赢',
  '让房间里随便谁控制你 30 秒（ask 授权）',
  '对房间广播一句土味情话',
]

/** 节拍谱（beat-echo）：数组 = [强,弱,弱,强…] */
export const BEAT_PATTERNS: number[][] = [
  [1, 0, 1, 0, 1, 1],
  [1, 1, 0, 1, 0, 0, 1],
  [1, 0, 0, 1, 0, 1, 1, 1],
  [1, 1, 1, 0, 1, 0],
  [1, 0, 1, 1, 0, 1, 0, 1],
]

/** 统一快照：hub 状态（session 内嵌） */
export interface GameHubState {
  kind: GameKind
  /** 发起人 */
  by: string
  /** 当前被选中/行动中的成员（truth-dare 的目标、relay 的当前持电人） */
  active: string | null
  /** 阶段 */
  phase: 'idle' | 'acting' | 'judging' | 'done'
  /** 玩法载荷 */
  payload: {
    /** truth-dare: 抽到的题目/任务 */
    prompt?: { type: 'truth' | 'dare'; text: string }
    /** beat-echo: 谱子（发起人可见明文；其他人收乱序占位） */
    pattern?: number[]
    /** red-light: true=红灯 */
    redLight?: boolean
    /** guess-song: 提示（歌名字数等） */
    hint?: string
    /** 通用备注 */
    note?: string
  }
  /** 各成员提交（按玩法语义） */
  submits: Record<string, string>
  /** 团队赛 2v2：队伍名单与比分 */
  teams?: { gold: string[]; blue: string[]; loses: { gold: number; blue: number } }
  /** 惩罚骰子：最近一次掷出的格 id */
  dice?: { slot: string; target: string; at: number }
  /** 谁是卧底：我的词（各自私有视图由信封分发；公共区只放状态） */
  undercover?: { ejected: string | null; tie: boolean; votes: Record<string, string>; wordLenHint: string }
  /** 结果 */
  result: { loser: string; note: string } | null
  /** 截止时间戳 */
  endsAt: number
  at: number
}

/** 统一惩罚规格：输家吃电（强度=对方上限 × percent） */
export function punishOp(caps: { A: number; B: number } | null, percent: number, frames: number, freq: number): PartyRemoteOp {
  const cap = Math.min(caps?.A ?? 60, caps?.B ?? 60)
  const value = Math.max(1, Math.round(cap * percent))
  return {
    kind: 'pulse',
    channel: 'A',
    frames: Array.from({ length: frames }, (_, i) => ({
      freq: Math.max(10, freq - i * 2),
      strength: Math.max(1, Math.round(value * (1 - i * (0.8 / Math.max(1, frames))))),
    })),
  }
}

/** 真心话/大冒险抽取（避免连续重复） */
export function pickTruthDare(recent: string[]): { type: 'truth' | 'dare'; text: string } {
  const useDare = Math.random() < 0.5
  const pool = useDare ? DARE_TASKS : TRUTH_QUESTIONS
  const fresh = pool.filter(item => !recent.includes(item))
  const list = fresh.length ? fresh : pool
  return { type: useDare ? 'dare' : 'truth', text: list[Math.floor(Math.random() * list.length)] }
}

/** 随机选人（排除发起人；候选为在线成员） */
export function pickRandomPlayer(candidates: string[]): string | null {
  if (!candidates.length) return null
  return candidates[Math.floor(Math.random() * candidates.length)]
}

/** beat-echo 判分：提交为 "101101" 形式，逐位比对 */
export function scoreBeatEcho(pattern: number[], submit: string): number {
  let wrong = 0
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]
    const got = submit[index] === '1' ? 1 : 0
    if (expected !== got) wrong += 1
  }
  return wrong + Math.abs(pattern.length - submit.length)
}

/* ═══════════════════ 团队赛 2v2 ═══════════════════
 *
 * 把房间在线成员均分成两队（金队/蓝队），随机抽题轮流作答：
 * 每题两队各派一人同答，答错的**全队**每人吃小电；先输 3 题的队伍集体吃大电。
 * 适合 4+ 人。
 */

export const TEAM_MATCH_LOSE_TARGET = 3 // 先输 3 题的队全队大电
export const TEAM_NAMES: [string, string] = ['金队', '蓝队']
export const TEAM_COLORS: [string, string] = ['#d9a13c', '#5aa9e6']

/** 均分队伍（交替分配打乱后的名单） */
export function assignTeams(memberIds: string[]): { gold: string[]; blue: string[] } {
  const shuffled = [...memberIds]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]]
  }
  const gold: string[] = []
  const blue: string[] = []
  shuffled.forEach((id, index) => (index % 2 === 0 ? gold : blue).push(id))
  return { gold, blue }
}

/** 团队赛题库（组队常识，两人可以商量） */
export const TEAM_QUESTIONS = [
  { q: '「二重奏」需要几个人？', options: ['2', '3', '4'], correct: 0 },
  { q: '「二重唱」的英文是？', options: ['Duet', 'Duo', 'Dual'], correct: 0 },
  { q: '足球每队上场几人？', options: ['9', '11', '13'], correct: 1 },
  { q: '「二人转」是哪里的曲艺？', options: ['东北', '四川', '广东'], correct: 0 },
  { q: '双人蹦极一般怎么绑？', options: ['背对背', '面对面', '并排'], correct: 1 },
  { q: '「Beatbox」两人合作最常见的是？', options: ['一鼓一效果', '两鼓', '合唱'], correct: 0 },
  { q: '「Tandem」一词指？', options: ['前后纵列（如双人自行车）', '并排', '对视'], correct: 0 },
  { q: '拔河比赛每队通常几人？', options: ['5', '8', '10'], correct: 1 },
]

/* ═══════════════════ 惩罚骰子 ═══════════════════
 *
 * 六格骰子，每格一个惩罚动作；点「掷骰」随机出结果并立刻对目标执行。
 * 目标可以是自己（自我惩罚）或指定他人（需有控制权或对方同意——
 * 这里做成：掷骰者自担结果，或房主/管理员指定目标）。
 */

export interface DiceSlot {
  id: string
  label: string
  /** 惩罚参数：强度百分比/帧数/频率（percent=0 表示无电，纯整蛊） */
  percent: number
  frames: number
  freq: number
  weight: number
}

export const DICE_SLOTS: DiceSlot[] = [
  { id: 'safe', label: '安全格：无事发生，笑一个', percent: 0, frames: 0, freq: 0, weight: 2 },
  { id: 'tease', label: '轻撩 3 秒（15%）', percent: 0.15, frames: 30, freq: 70, weight: 3 },
  { id: 'pat', label: '拍一拍（30%×2 帧组）', percent: 0.3, frames: 6, freq: 60, weight: 3 },
  { id: 'shock', label: '电一下（55%×4 帧）', percent: 0.55, frames: 4, freq: 40, weight: 2 },
  { id: 'storm', label: '风暴 8 秒（70% 长脉冲）', percent: 0.7, frames: 80, freq: 30, weight: 1 },
  { id: 'roulette', label: '再来一次！重掷', percent: -1, frames: 0, freq: 0, weight: 1 },
]

/** 加权掷骰 */
export function rollDice(): DiceSlot {
  const total = DICE_SLOTS.reduce((sum, slot) => sum + slot.weight, 0)
  let roll = Math.random() * total
  for (const slot of DICE_SLOTS) {
    roll -= slot.weight
    if (roll <= 0) return slot
  }
  return DICE_SLOTS[0]
}

/* ═══════════════════ 谁是卧底 ═══════════════════
 *
 * 经典玩法：全员拿到一个词，只有卧底拿到近义词；轮流描述，投票揪卧底。
 * 卧底被票出 → 平民赢，卧底吃大电；投错人 → 平民吃小电，卧底安全。
 * 需要 4+ 人。
 */

/** 词对（平民词 / 卧底词） */
export const UNDERCOVER_PAIRS = [
  { civilian: '奶茶', undercover: '咖啡' },
  { civilian: '手机', undercover: '平板' },
  { civilian: '地铁', undercover: '公交' },
  { civilian: '蛋糕', undercover: '面包' },
  { civilian: '猫', undercover: '狗' },
  { civilian: '夏天', undercover: '冬天' },
  { civilian: 'KTV', undercover: 'Live House' },
  { civilian: '蹦迪', undercover: '蹦极' },
  { civilian: '辣条', undercover: '薯片' },
  { civilian: '钢琴', undercover: '电子琴' },
]

export const UNDERCOVER_MIN_PLAYERS = 4

/** 发词：随机选词对 + 随机卧底 */
export function dealUndercover(memberIds: string[]): { word: string; undercoverId: string; isCivilianWord: (peerId: string) => boolean; pair: { civilian: string; undercover: string } } | null {
  if (memberIds.length < UNDERCOVER_MIN_PLAYERS) return null
  const pair = UNDERCOVER_PAIRS[Math.floor(Math.random() * UNDERCOVER_PAIRS.length)]
  const undercoverId = memberIds[Math.floor(Math.random() * memberIds.length)]
  return {
    word: pair.civilian,
    undercoverId,
    isCivilianWord: (peerId: string) => peerId !== undercoverId,
    pair,
  }
}

/** 计票：返回被票出的人（平票返回 null → 平民吃小电） */
export function tallyVotes(votes: Record<string, string>): { ejected: string | null; tie: boolean } {
  const counts = new Map<string, number>()
  for (const target of Object.values(votes)) counts.set(target, (counts.get(target) ?? 0) + 1)
  let top: string | null = null
  let topCount = 0
  let tie = false
  for (const [target, count] of counts) {
    if (count > topCount) { top = target; topCount = count; tie = false }
    else if (count === topCount) tie = true
  }
  return { ejected: tie ? null : top, tie }
}
