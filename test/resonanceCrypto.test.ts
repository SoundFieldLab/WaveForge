/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_VERSION,
  ReplayGuard,
  deriveSessionKey,
  generateRoomKey,
  openMessage,
  roomFingerprint,
  roomFingerprintHex,
  roomKeyToBytes,
  sealMessage,
} from '../src/features/resonance/crypto'

const ROOM = 'room-abc'
const PEER = 'peer-1'

describe('共振端到端加密', () => {
  it('房间密钥为 32 字节且每次不同', () => {
    const first = generateRoomKey()
    const second = generateRoomKey()
    expect(roomKeyToBytes(first)).toHaveLength(32)
    expect(first).not.toBe(second)
  })

  it('加解密往返：载荷与信封字段完整保留', () => {
    const key = generateRoomKey()
    const envelope = sealMessage(key, {
      roomId: ROOM,
      from: PEER,
      kind: 'chat',
      seq: 1,
      payload: { text: '一起听这首', emote: '🎧' },
    })
    expect(envelope.v).toBe(ENVELOPE_VERSION)
    expect(envelope.roomId).toBe(ROOM)
    const opened = openMessage(key, envelope, ROOM)
    expect(opened.ok).toBe(true)
    expect(opened.ok && opened.payload).toEqual({ text: '一起听这首', emote: '🎧' })
  })

  it('密文里看不到明文（中继只能看到密文）', () => {
    const key = generateRoomKey()
    const envelope = sealMessage(key, { roomId: ROOM, from: PEER, kind: 'chat', seq: 1, payload: { text: '秘密消息' } })
    expect(JSON.stringify(envelope)).not.toContain('秘密消息')
  })

  it('换错密钥解不开', () => {
    const envelope = sealMessage(generateRoomKey(), { roomId: ROOM, from: PEER, kind: 'chat', seq: 1, payload: { text: 'hi' } })
    const opened = openMessage(generateRoomKey(), envelope, ROOM)
    expect(opened.ok).toBe(false)
    expect(!opened.ok && opened.reason).toBe('decrypt-failed')
  })

  it('密文被篡改会认证失败', () => {
    const key = generateRoomKey()
    const envelope = sealMessage(key, { roomId: ROOM, from: PEER, kind: 'chat', seq: 1, payload: { text: 'hi' } })
    const tampered = { ...envelope, cipher: envelope.cipher.slice(0, -4) + 'AAAA' }
    expect(openMessage(key, tampered, ROOM).ok).toBe(false)
  })

  it('信封头参与认证：改类别/发送者/序号都会失败', () => {
    const key = generateRoomKey()
    const envelope = sealMessage(key, { roomId: ROOM, from: PEER, kind: 'chat', seq: 5, payload: { text: 'hi' } })
    expect(openMessage(key, { ...envelope, kind: 'playback' }, ROOM).ok).toBe(false)
    expect(openMessage(key, { ...envelope, from: 'peer-2' }, ROOM).ok).toBe(false)
    expect(openMessage(key, { ...envelope, seq: 6 }, ROOM).ok).toBe(false)
  })

  it('拒绝其它房间与错误版本的消息', () => {
    const key = generateRoomKey()
    const envelope = sealMessage(key, { roomId: ROOM, from: PEER, kind: 'chat', seq: 1, payload: {} })
    const foreign = openMessage(key, envelope, 'room-other')
    expect(!foreign.ok && foreign.reason).toBe('foreign-room')
    const badVersion = openMessage(key, { ...envelope, v: 99 }, ROOM)
    expect(!badVersion.ok && badVersion.reason).toBe('bad-version')
  })

  it('缺少字段或密钥长度不对时安全拒绝', () => {
    const key = generateRoomKey()
    expect(!openMessage(key, null, ROOM).ok).toBe(true)
    expect(!openMessage(key, { v: ENVELOPE_VERSION }, ROOM).ok).toBe(true)
    expect(() => roomKeyToBytes('short')).toThrow()
  })

  it('防重放：序号必须严格递增', () => {
    const guard = new ReplayGuard()
    expect(guard.accept('peer-1', 1)).toBe(true)
    expect(guard.accept('peer-1', 1)).toBe(false)
    expect(guard.accept('peer-1', 2)).toBe(true)
    expect(guard.accept('peer-1', 1)).toBe(false)
    expect(guard.accept('peer-2', 1)).toBe(true)
    guard.reset()
    expect(guard.accept('peer-1', 1)).toBe(true)
  })

  it('房间指纹稳定、可读，且不同房间不同', async () => {
    const key = generateRoomKey()
    const first = await roomFingerprint(key)
    expect(first).toBe(await roomFingerprint(key))
    expect(first.split(' ')).toHaveLength(4)
    expect(await roomFingerprint(generateRoomKey())).not.toBe(first)
    expect(await roomFingerprintHex(key)).toMatch(/^[0-9a-f]{6}$/)
  })

  it('成对会话密钥与成员顺序无关', async () => {
    const key = generateRoomKey()
    const left = await deriveSessionKey(key, 'a', 'b')
    const right = await deriveSessionKey(key, 'b', 'a')
    expect(left).toBe(right)
    expect(await deriveSessionKey(key, 'a', 'c')).not.toBe(left)
  })
})
