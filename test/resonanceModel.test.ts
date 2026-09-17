import { describe, expect, it } from 'vitest'
import {
  RESONANCE_MAX_MEMBERS,
  addTracks,
  advanceQueue,
  applyPlayback,
  canonicalTrackKey,
  castSkipVote,
  trackDurationCompatible,
  clampQuota,
  clampPartyQuota,
  remainingAddQuota,
  tracksAddedByPeer,
  createRoomState,
  currentTurnPeerId,
  dissolveRoom,
  heartbeat,
  hostForceSkip,
  joinRoom,
  leaveRoom,
  updateMemberProfile,
  addPendingTracks,
  dismissPending,
  promotePending,
  hasNameConflict,
  markOffline,
  reportCannotPlay,
  roomSummary,
  skipVoteThreshold,
  tracksAddedThisTurn,
  type ResonanceIdentity,
  type ResonanceRoomState,
  type ResonanceTrack,
} from '../src/features/resonance/model'

const identity = (peerId: string, nickname = peerId): ResonanceIdentity => ({
  peerId,
  nickname,
  platforms: [{ platform: 'netease', loggedIn: true, tier: 'vip' }],
  joinedAt: 0,
})

const track = (title: string, artists: string[], durationMs = 200000): Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'> => ({
  title,
  artists,
  durationMs,
  sources: [{ platform: 'netease', id: Number(String(title.length) + String(durationMs).length) }],
})

function room(mode: ResonanceRoomState['mode'], quota = 2) {
  return createRoomState({ roomId: 'room-1', host: identity('host'), mode, quota, now: 0 })
}

describe('共振房间模型', () => {
  describe('跨平台规范键', () => {
    it('同一首歌在不同平台/写法下得到同一个键', () => {
      const a = canonicalTrackKey({ title: 'Lemon', artists: ['米津玄師'], durationMs: 255000 })
      const b = canonicalTrackKey({ title: 'ｌｅｍｏｎ', artists: ['米津玄師'], durationMs: 256000 })
      const c = canonicalTrackKey({ title: 'Lemon', artists: ['米津玄師'], durationMs: 257100 })
      expect(b).toBe(a)
      expect(c).toBe(a)
    })

    it('歌手顺序不影响键', () => {
      expect(canonicalTrackKey({ title: 'X', artists: ['A', 'B'] }))
        .toBe(canonicalTrackKey({ title: 'X', artists: ['B', 'A'] }))
    })

    it('时长只作为匹配护栏，不参与规范键', () => {
      const studio = { title: 'Song', artists: ['A'], durationMs: 200000 }
      const live = { title: 'Song', artists: ['A'], durationMs: 260000 }
      // 键相同（标题+歌手），但时长护栏判定为不同录音，匹配阶段据此排除
      expect(canonicalTrackKey(live)).toBe(canonicalTrackKey(studio))
      expect(trackDurationCompatible(studio.durationMs, live.durationMs)).toBe(false)
      expect(trackDurationCompatible(255000, 257100)).toBe(true)
      expect(trackDurationCompatible(0, 260000)).toBe(true)
    })
  })

  describe('入房与座位', () => {
    it('按入房顺序分配座位号', () => {
      const base = room('party')
      const one = joinRoom(base, identity('b'), 10)
      expect(one.ok && one.member.seat).toBe(2)
      const two = one.ok ? joinRoom(one.state, identity('c'), 20) : null
      expect(two && two.ok && two.member.seat).toBe(3)
    })

    it('超过 15 人拒绝加入', () => {
      let state = room('party')
      for (let index = 2; index <= RESONANCE_MAX_MEMBERS; index += 1) {
        const result = joinRoom(state, identity(`p${index}`), index)
        expect(result.ok).toBe(true)
        if (result.ok) state = result.state
      }
      const overflow = joinRoom(state, identity('p16'), 99)
      expect(overflow.ok).toBe(false)
      expect(!overflow.ok && overflow.reason).toBe('room-full')
    })

    it('房间里改昵称/头像会更新名册，但席位与入房时间不变；无变化时返回 null', () => {
      const state = room('party')
      const before = state.members[0]

      const renamed = updateMemberProfile(state, { ...identity('host'), nickname: '新名字', avatarUrl: 'https://a/x.png' })
      expect(renamed).not.toBeNull()
      expect(renamed!.members[0].nickname).toBe('新名字')
      expect(renamed!.members[0].avatarUrl).toBe('https://a/x.png')
      // 席位与入房时间不能因为改名而变（不是重新入房）
      expect(renamed!.members[0].seat).toBe(before.seat)
      expect(renamed!.members[0].joinedAt).toBe(before.joinedAt)

      // 同名同头像 → 无需广播
      expect(updateMemberProfile(renamed!, { ...identity('host'), nickname: '新名字', avatarUrl: 'https://a/x.png' })).toBeNull()
      // 不在房间里的人不动名册
      expect(updateMemberProfile(state, { ...identity('outsider'), nickname: 'x' })).toBeNull()
      // 空昵称不覆盖
      expect(updateMemberProfile(state, { ...identity('host'), nickname: '   ' })).toBeNull()
      // 平台徽章也算变化
      const badges = updateMemberProfile(state, { ...identity('host'), platforms: [] })
      expect(badges!.members[0].platforms).toEqual([])
    })

    it('自定义用户名重名会标记后进者，平台昵称同名不误报', () => {
      const state = room('party')
      const customHost = { ...identity('host', '夜测'), nicknameFrom: undefined }
      const customMember = { ...identity('member', '夜测'), nicknameFrom: undefined }
      const joined = joinRoom({ ...state, members: [state.members[0] = { ...state.members[0], ...customHost }] }, customMember, 2)
      expect(joined.ok).toBe(true)
      expect(joined.ok && joined.member.nicknameConflict).toBe(true)
      expect(hasNameConflict(state, { ...identity('other', 'Yoshino'), nicknameFrom: 'netease' })).toBe(false)
    })

    it('重复加入是幂等的，昵称必填，已结束房间不能加入', () => {
      const state = room('party')
      const again = joinRoom(state, identity('host'), 5)
      expect(again.ok).toBe(true)
      expect(again.state.members).toHaveLength(1)

      const noName = joinRoom(state, { ...identity('x'), nickname: '  ' }, 5)
      expect(!noName.ok && noName.reason).toBe('nickname-required')

      const closed = dissolveRoom(state)
      const rejected = joinRoom(closed, identity('y'), 5)
      expect(!rejected.ok && rejected.reason).toBe('room-closed')
    })
  })

  describe('房主交接', () => {
    it('共享歌单模式房主退出即结束房间', () => {
      let state = room('shared-playlist')
      const joined = joinRoom(state, identity('b'), 10)
      state = joined.ok ? joined.state : state
      const outcome = leaveRoom(state, 'host')
      expect(outcome.kind).toBe('closed')
      expect(outcome.state.closed?.reason).toBe('host-left')
    })

    it('其他模式房主退出交接给最早入房者并递增任期', () => {
      let state = room('party')
      for (const [index, peer] of ['b', 'c'].entries()) {
        const joined = joinRoom(state, identity(peer), 10 + index)
        state = joined.ok ? joined.state : state
      }
      const outcome = leaveRoom(state, 'host')
      expect(outcome.kind).toBe('host-changed')
      expect(outcome.kind === 'host-changed' && outcome.newHostId).toBe('b')
      expect(outcome.state.hostId).toBe('b')
      expect(outcome.state.term).toBe(2)
    })

    it('最后一人退出房间结束，普通成员退出不影响房主', () => {
      let state = room('party')
      const joined = joinRoom(state, identity('b'), 10)
      state = joined.ok ? joined.state : state
      const memberLeaves = leaveRoom(state, 'b')
      expect(memberLeaves.kind).toBe('left')
      expect(memberLeaves.state.hostId).toBe('host')
      const hostLeaves = leaveRoom(memberLeaves.state, 'host')
      expect(hostLeaves.kind).toBe('closed')
      expect(hostLeaves.state.closed?.reason).toBe('empty')
    })
  })

  describe('三种房间模式的加歌规则', () => {
    it('共享歌单：只有房主能推歌单，成员加歌被拒', () => {
      let state = room('shared-playlist')
      const joined = joinRoom(state, identity('b'), 10)
      state = joined.ok ? joined.state : state
      const byMember = addTracks(state, 'b', [track('A', ['x'])], 11)
      expect(!byMember.ok && byMember.reason).toBe('not-host')
      const byHost = addTracks(state, 'host', [track('A', ['x']), track('B', ['y'])], 12, { playlistPush: true })
      expect(byHost.ok).toBe(true)
      expect(byHost.state.queue).toHaveLength(2)
    })

    it('Party：任何人都能加歌，同一首歌不会重复入队', () => {
      let state = room('party')
      const joined = joinRoom(state, identity('b'), 10)
      state = joined.ok ? joined.state : state
      const first = addTracks(state, 'b', [track('A', ['x']), track('A', ['X'])], 11)
      expect(first.ok).toBe(true)
      expect(first.state.queue).toHaveLength(1)
      const second = addTracks(first.state, 'host', [track('A', ['x'])], 12)
      expect(second.ok).toBe(false)
      expect(!second.ok && second.reason).toBe('empty')
    })

    it('我推荐：房主先推第一首，每人一次可加 quota 首，然后按座位轮流', () => {
      let state = room('round-robin', 2)
      for (const [index, peer] of ['b', 'c'].entries()) {
        const joined = joinRoom(state, identity(peer), 10 + index)
        state = joined.ok ? joined.state : state
      }
      // 房主先推一首 → 仍是房主的回合（配额未用完）
      const seed = addTracks(state, 'host', [track('seed', ['h'])], 20)
      expect(seed.ok).toBe(true)
      state = seed.ok ? seed.state : state
      expect(currentTurnPeerId(state)).toBe('host')
      // 用完剩余配额 → 轮到 b
      const second = addTracks(state, 'host', [track('h2', ['h'])], 21)
      expect(second.ok).toBe(true)
      state = second.ok ? second.state : state
      expect(tracksAddedThisTurn(state, 'host')).toBe(2)
      expect(currentTurnPeerId(state)).toBe('b')
      // b 没轮到别人时不能抢（此时轮到 b，c 加歌被拒）
      const byC = addTracks(state, 'c', [track('c1', ['c'])], 22)
      expect(!byC.ok && byC.reason).toBe('not-your-turn')
      const byB = addTracks(state, 'b', [track('b1', ['b']), track('b2', ['b'])], 23)
      expect(byB.ok).toBe(true)
      state = byB.ok ? byB.state : state
      expect(currentTurnPeerId(state)).toBe('c')
    })

    it('我推荐：超出配额的加歌被拒', () => {
      let state = room('round-robin', 1)
      const joined = joinRoom(state, identity('b'), 10)
      state = joined.ok ? joined.state : state
      const first = addTracks(state, 'host', [track('s', ['h'])], 20)
      state = first.ok ? first.state : state
      expect(currentTurnPeerId(state)).toBe('b')
      const b1 = addTracks(state, 'b', [track('b1', ['b'])], 21)
      expect(b1.ok).toBe(true)
      const b2 = addTracks(b1.state, 'b', [track('b2', ['b'])], 22)
      expect(!b2.ok && b2.reason).toBe('not-your-turn')
    })

    it('队列有上限', () => {
      let state = room('party')
      const tracks = Array.from({ length: 400 }, (_, index) => track(`t${index}`, ['a']))
      const result = addTracks(state, 'host', tracks, 10)
      expect(result.ok).toBe(true)
      expect(result.state.queue.length).toBeLessThanOrEqual(300)
    })
  })

  describe('每人加歌配额（除共享歌单外不能一口气塞一堆）', () => {
    it('Party 模式：每人整场默认只能加 3 首，超出被拒', () => {
      let state = room('party')
      expect(state.partyQuota).toBe(3)
      const joined = joinRoom(state, identity('b'), 10)
      state = joined.ok ? joined.state : state
      const first = addTracks(state, 'b', [track('a1', ['x']), track('a2', ['x']), track('a3', ['x'])], 11)
      expect(first.ok).toBe(true)
      expect(first.state.queue).toHaveLength(3)
      expect(tracksAddedByPeer(first.state, 'b')).toBe(3)
      expect(remainingAddQuota(first.state, 'b')).toBe(0)
      const more = addTracks(first.state, 'b', [track('a4', ['x'])], 12)
      expect(!more.ok && more.reason).toBe('quota-exceeded')
      // 房主自己的额度不受影响
      expect(remainingAddQuota(first.state, 'host')).toBe(3)
    })
    it('Party 模式：一次提交超过剩余额度时只收下剩余部分', () => {
      const state = room('party')
      const result = addTracks(state, 'host', [track('b1', ['y']), track('b2', ['y']), track('b3', ['y']), track('b4', ['y'])], 10)
      expect(result.ok).toBe(true)
      expect(result.state.queue).toHaveLength(3)
    })
    it('共享歌单模式：房主不受配额限制（整单推送），成员不能加', () => {
      let state = room('shared-playlist')
      const joined = joinRoom(state, identity('b'), 10)
      state = joined.ok ? joined.state : state
      expect(remainingAddQuota(state, 'host')).toBe(Number.POSITIVE_INFINITY)
      expect(remainingAddQuota(state, 'b')).toBe(0)
      const byMember = addTracks(state, 'b', [track('c1', ['z'])], 11)
      expect(!byMember.ok && byMember.reason).toBe('not-host')
    })
    it('我推荐模式：每轮按 quota 计算剩余额度', () => {
      const state = room('round-robin', 2)
      expect(remainingAddQuota(state, 'host')).toBe(2)
      const seed = addTracks(state, 'host', [track('d1', ['w'])], 10)
      expect(remainingAddQuota(seed.state, 'host')).toBe(1)
    })
    it('配额夹在 1–10', () => {
      expect(clampPartyQuota(0)).toBe(3)
      expect(clampPartyQuota(1)).toBe(1)
      expect(clampPartyQuota(99)).toBe(10)
    })
  })

  describe('投票跳过', () => {
    it('阈值按当前在线人数的 8 成向上取整', () => {
      expect(skipVoteThreshold(1)).toBe(1)
      expect(skipVoteThreshold(2)).toBe(2)
      expect(skipVoteThreshold(3)).toBe(3)
      expect(skipVoteThreshold(5)).toBe(4)
      expect(skipVoteThreshold(10)).toBe(8)
      expect(skipVoteThreshold(15)).toBe(12)
    })

    it('达到阈值即通过，离线成员不计入人数', () => {
      let state = room('party')
      for (const [index, peer] of ['b', 'c', 'd', 'e'].entries()) {
        const joined = joinRoom(state, identity(peer), 10 + index)
        state = joined.ok ? joined.state : state
      }
      const first = castSkipVote(state, 'host', 'k1')
      expect(first.ok && !first.passed).toBe(true)
      state = first.state
      const second = castSkipVote(state, 'b', 'k1')
      expect(second.ok && !second.passed).toBe(true)
      state = second.state
      const third = castSkipVote(state, 'c', 'k1')
      expect(third.ok && !third.passed).toBe(true)
      state = third.state
      const fourth = castSkipVote(state, 'd', 'k1')
      expect(fourth.ok && fourth.passed).toBe(true)

      // 掉线三人后，人数按在线数算：2 人 → 阈值 2
      let dropped = heartbeat(state, 'host', 18_000).state
      dropped = heartbeat(dropped, 'b', 18_000).state
      for (const peer of ['c', 'd', 'e']) dropped = markOffline(dropped, 20_000)
      expect(dropped.members.filter(member => member.online)).toHaveLength(2)
      const passWithTwo = castSkipVote({ ...dropped, vote: null }, 'host', 'k2')
      expect(passWithTwo.ok && passWithTwo.passed).toBe(false)
      const passWithTwoB = castSkipVote(passWithTwo.state, 'b', 'k2')
      expect(passWithTwoB.ok && passWithTwoB.passed).toBe(true)
    })

    it('房主可强制跳过，成员不行', () => {
      const state = room('party')
      expect(hostForceSkip(state, 'host').ok).toBe(true)
      expect(hostForceSkip(state, 'b').ok).toBe(false)
    })
  })

  describe('播放权威', () => {
    it('只接受房主且任期不倒退的播放状态', () => {
      let state = room('party')
      const seeded = addTracks(state, 'host', [track('A', ['x'])], 10)
      state = seeded.ok ? seeded.state : state
      const key = state.queue[0].key
      const playback = { trackKey: key, positionMs: 0, playing: true, atHostClock: 100, term: 1, seq: 1 }

      const fromMember = applyPlayback(state, playback, 'b')
      expect(fromMember.ok).toBe(false)

      const first = applyPlayback(state, playback, 'host')
      expect(first.ok).toBe(true)
      expect(first.hard).toBe(true)
      expect(first.state.cursor).toBe(0)

      const stale = applyPlayback(first.state, { ...playback, seq: 2, term: 0 }, 'host')
      expect(stale.ok).toBe(false)

      const next = applyPlayback(first.state, { ...playback, seq: 2, positionMs: 100, atHostClock: 200 }, 'host')
      expect(next.ok).toBe(true)
      expect(next.hard).toBe(false)

      // 房主拖了进度 → 硬同步
      const seeked = applyPlayback(next.state, { ...playback, seq: 3, positionMs: 60_000, atHostClock: 300 }, 'host')
      expect(seeked.ok && seeked.hard).toBe(true)

      const replay = applyPlayback(next.state, { ...playback, seq: 2 }, 'host')
      expect(replay.ok).toBe(false)
    })

    it('交接后旧房主的权威消息被丢弃', () => {
      let state = room('party')
      const joined = joinRoom(state, identity('b'), 10)
      state = joined.ok ? joined.state : state
      const handover = leaveRoom(state, 'host')
      const after = handover.state
      const fromOldHost = applyPlayback(after, { trackKey: null, positionMs: 0, playing: false, atHostClock: 1, term: 1, seq: 9 }, 'host')
      expect(fromOldHost.ok).toBe(false)
      const fromNewHost = applyPlayback(after, { trackKey: null, positionMs: 0, playing: false, atHostClock: 1, term: 2, seq: 10 }, 'b')
      expect(fromNewHost.ok).toBe(true)
    })

    it('推进队列到末尾后停在下标 -1', () => {
      let state = room('party')
      const seeded = addTracks(state, 'host', [track('A', ['x'])], 10)
      state = seeded.ok ? seeded.state : state
      const advanced = advanceQueue({ ...state, cursor: 0 })
      expect(advanced.cursor).toBe(-1)
    })
  })

  describe('状态上报', () => {
    it('成员上报无法播放时记录档位', () => {
      const state = room('party')
      const next = reportCannotPlay(state, 'host', 'k1', 'vip')
      expect(next.members[0].unableToPlay).toBe('k1')
      expect(next.members[0].unableToPlayTier).toBe('vip')
    })

    it('心跳与超时离线', () => {
      let state = room('party')
      const joined = joinRoom(state, identity('b'), 0)
      state = joined.ok ? joined.state : state
      const offline = markOffline(state, 20_000)
      expect(offline.members[1].online).toBe(false)
      const resumed = heartbeat(offline, 'b', 20_100)
      expect(resumed.state.members[1].online).toBe(true)
    })

    it('房间摘要统计人数/在线/时长/曲目数', () => {
      let state = room('party')
      const joined = joinRoom(state, identity('b'), 1000)
      state = joined.ok ? joined.state : state
      const seeded = addTracks(state, 'host', [track('A', ['x'])], 2000)
      state = seeded.ok ? seeded.state : state
      const summary = roomSummary(state, 61_000)
      expect(summary.memberCount).toBe(2)
      expect(summary.online).toBe(2)
      expect(summary.queueLength).toBe(1)
      expect(summary.listeningMinutes).toBe(1)
    })

    it('配额限制在 1-3 首', () => {
      expect(clampQuota(0)).toBe(1)
      expect(clampQuota(2)).toBe(2)
      expect(clampQuota(9)).toBe(3)
      expect(clampQuota(undefined)).toBe(1)
    })

    it('右键推送的 next 插入当前曲目之后，连推多首保持推送顺序', () => {
      // Party 整场累计配额默认 3，这里放宽到 10 以便连推多首
      let state = { ...room('party'), partyQuota: 10 }
      const first = addTracks(state, 'host', [track('第一首', ['a']), track('原下一首', ['b'])], 1)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      state = { ...first.state, cursor: 0, playback: { trackKey: first.added[0].key, positionMs: 0, playing: true, atHostClock: 1, term: 1, seq: 1 } }
      // 连推两首：都接在「上一首 next 推送」之后，得到 A→B 而不是 B→A
      const nextA = addTracks(state, 'host', [track('推送A', ['c'])], 2, { position: 'next' })
      expect(nextA.ok).toBe(true)
      if (!nextA.ok) return
      const nextB = addTracks(nextA.state, 'host', [track('推送B', ['d'])], 3, { position: 'next', anchorKey: nextA.added[0].key })
      expect(nextB.ok).toBe(true)
      if (!nextB.ok) return
      expect(nextB.state.queue.map(item => item.title)).toEqual(['第一首', '推送A', '推送B', '原下一首'])
      // 锚点失效（已被播掉）时回落到当前曲目之后
      const stale = addTracks(nextB.state, 'host', [track('推送C', ['e'])], 4, { position: 'next', anchorKey: 'no-such-key' })
      expect(stale.ok).toBe(true)
      if (!stale.ok) return
      expect(stale.state.queue.map(item => item.title)).toEqual(['第一首', '推送C', '推送A', '推送B', '原下一首'])
    })

    it('没有资格直接加歌时可以预排；房主可放行或忽略', () => {
      let state = room('party')
      const joined = joinRoom(state, identity('member'), 2)
      expect(joined.ok).toBe(true)
      if (!joined.ok) return
      state = joined.state
      const filled = addTracks(state, 'member', [track('已用1', ['a']), track('已用2', ['a']), track('已用3', ['a'])], 3)
      expect(filled.ok).toBe(true)
      if (!filled.ok) return
      state = filled.state
      const pending = addPendingTracks(state, 'member', [track('等资格', ['b'])], 4)
      expect(pending.ok).toBe(true)
      if (!pending.ok) return
      expect(pending.state.pending).toHaveLength(1)
      const promoted = promotePending(pending.state, 5, pending.added[0].key)
      expect(promoted.pending).toHaveLength(0)
      expect(promoted.queue.some(item => item.title === '等资格')).toBe(true)

      const pendingAgain = addPendingTracks(state, 'member', [track('稍后丢掉', ['c'])], 6)
      expect(pendingAgain.ok).toBe(true)
      if (!pendingAgain.ok) return
      expect(dismissPending(pendingAgain.state, pendingAgain.added[0].key).pending).toHaveLength(0)
    })
  })
})
