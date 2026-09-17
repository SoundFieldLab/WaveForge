/**
 * 「共振」端到端加密（纯逻辑，可在渲染进程直接跑）。
 *
 * 威胁模型与保证：
 * - 房间内容（歌单、进度、聊天）用**房间密钥**做 XChaCha20-Poly1305 加密，
 *   密钥只随邀请串在成员之间传递，不经任何我们运营的服务器；中继/STUN 只能看到密文。
 * - 信封头（版本/房间/发送者/类别/序号）作为 AAD 参与认证，防篡改与字段置换。
 * - 每条消息带发送方单调 seq，配合 ReplayGuard 防重放。
 * - 房间指纹（房间密钥的短哈希）用于成员之间**带外核对**，防中间人。
 * - 已知边界：房间密钥由房主生成，因此房主在技术上能解密房间内容（与「群主持有群密钥」同理）。
 *   要做到对房主也不可见，需要成员两两 ECDH 会话密钥，见 deriveSessionKey（预留给后续增强）。
 */
import { xchacha20poly1305 } from '@noble/ciphers/chacha'

export const ENVELOPE_VERSION = 1
export const ROOM_KEY_BYTES = 32
export const NONCE_BYTES = 24
/** 指纹用的表情表：24 个互不相似的表情，4 个一组 = 24^4 ≈ 33 万种组合 */
const FINGERPRINT_EMOJI = [
  '🍎', '🍋', '🍇', '🍒', '🥝', '🍑', '🌽', '🥕', '🌶️', '🍄', '🌰', '🥜',
  '🐳', '🦊', '🐼', '🦉', '🐙', '🦋', '🌙', '⭐', '🔥', '❄️', '🌊', '🎧',
]

export interface ResonanceEnvelope {
  v: number
  roomId: string
  from: string
  kind: string
  seq: number
  nonce: string
  cipher: string
}

export interface SealInput {
  roomId: string
  from: string
  kind: string
  seq: number
  payload: unknown
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64')
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  if (typeof atob === 'function') {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  return new Uint8Array(Buffer.from(padded, 'base64'))
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

/** 生成房间密钥（base64url）；仅用于测试/内部。真实房间密钥由邀请串里的种子派生 */
export function generateRoomKey(): string {
  return toBase64Url(randomBytes(ROOM_KEY_BYTES))
}

/** 房间密钥种子（随邀请串传递，仅在成员之间手工/扫码交换，中转看不到） */
export function generateRoomSecret(): string {
  return toBase64Url(randomBytes(ROOM_KEY_BYTES))
}

/**
 * 由种子派生真正的房间密钥：HKDF-SHA256(secret, salt=waveforge-resonance, info=roomId)。
 * 这样邀请串里带的不是密钥本身，删掉/换房间号也不会复用同一把密钥。
 */
export async function deriveRoomKey(secret: string, roomId: string): Promise<string> {
  const base = await globalThis.crypto.subtle.importKey('raw', fromBase64Url(String(secret || '')), 'HKDF', false, ['deriveBits'])
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('waveforge-resonance'), info: new TextEncoder().encode(String(roomId || '')) },
    base,
    256,
  )
  return toBase64Url(new Uint8Array(bits))
}

export function roomKeyToBytes(roomKey: string): Uint8Array {
  const bytes = fromBase64Url(String(roomKey || ''))
  if (bytes.length !== ROOM_KEY_BYTES) throw new Error('房间密钥长度不正确')
  return bytes
}

function aadOf(envelope: Omit<ResonanceEnvelope, 'nonce' | 'cipher'>): Uint8Array {
  const text = `${envelope.v}|${envelope.roomId}|${envelope.from}|${envelope.kind}|${envelope.seq}`
  return new TextEncoder().encode(text)
}

/** 加密一条房间消息 */
export function sealMessage(roomKey: string, input: SealInput): ResonanceEnvelope {
  const key = roomKeyToBytes(roomKey)
  const nonce = randomBytes(NONCE_BYTES)
  const header = { v: ENVELOPE_VERSION, roomId: input.roomId, from: input.from, kind: input.kind, seq: input.seq }
  const cipher = xchacha20poly1305(key, nonce, aadOf(header))
  const plaintext = new TextEncoder().encode(JSON.stringify(input.payload ?? null))
  const sealed = cipher.encrypt(plaintext)
  return { ...header, nonce: toBase64Url(nonce), cipher: toBase64Url(sealed) }
}

export type OpenResult =
  | { ok: true; payload: unknown; envelope: ResonanceEnvelope }
  | { ok: false; reason: 'bad-version' | 'foreign-room' | 'bad-envelope' | 'decrypt-failed' }

/** 解密一条房间消息：房间号不符或认证失败一律拒绝 */
export function openMessage(roomKey: string, envelope: unknown, expectedRoomId?: string): OpenResult {
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'bad-envelope' }
  const value = envelope as ResonanceEnvelope
  if (value.v !== ENVELOPE_VERSION) return { ok: false, reason: 'bad-version' }
  if (expectedRoomId && value.roomId !== expectedRoomId) return { ok: false, reason: 'foreign-room' }
  if (!value.from || !value.kind || !Number.isFinite(value.seq) || !value.nonce || !value.cipher) {
    return { ok: false, reason: 'bad-envelope' }
  }
  let key: Uint8Array
  let nonce: Uint8Array
  let cipherText: Uint8Array
  try {
    key = roomKeyToBytes(roomKey)
    nonce = fromBase64Url(value.nonce)
    cipherText = fromBase64Url(value.cipher)
  } catch {
    return { ok: false, reason: 'bad-envelope' }
  }
  if (nonce.length !== NONCE_BYTES) return { ok: false, reason: 'bad-envelope' }
  try {
    const cipher = xchacha20poly1305(key, nonce, aadOf({
      v: value.v, roomId: value.roomId, from: value.from, kind: value.kind, seq: value.seq,
    }))
    const plaintext = cipher.decrypt(cipherText)
    return { ok: true, payload: JSON.parse(new TextDecoder().decode(plaintext)), envelope: value }
  } catch {
    return { ok: false, reason: 'decrypt-failed' }
  }
}

/** 防重放：每个发送者的序号必须严格递增 */
export class ReplayGuard {
  private readonly lastSeq = new Map<string, number>()

  accept(peerId: string, seq: number): boolean {
    const previous = this.lastSeq.get(peerId)
    if (previous !== undefined && seq <= previous) return false
    this.lastSeq.set(peerId, seq)
    return true
  }

  forget(peerId: string): void {
    this.lastSeq.delete(peerId)
  }

  reset(): void {
    this.lastSeq.clear()
  }
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return new Uint8Array(digest)
}

/** 房间指纹（4 个表情）：成员入房后口头/截图核对一次，用于发现中间人 */
export async function roomFingerprint(roomKey: string): Promise<string> {
  const digest = await sha256(roomKeyToBytes(roomKey))
  return [0, 1, 2, 3].map(index => FINGERPRINT_EMOJI[digest[index] % FINGERPRINT_EMOJI.length]).join(' ')
}

/** 房间指纹的十六进制短码（复制/排查用） */
export async function roomFingerprintHex(roomKey: string): Promise<string> {
  const digest = await sha256(roomKeyToBytes(roomKey))
  return [...digest.slice(0, 3)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 由房间密钥派生两个成员之间的会话密钥（HKDF-SHA256）。
 * 预留给「对房主也保密」的成对加密增强；当前房间消息统一用房间密钥。
 */
export async function deriveSessionKey(roomKey: string, peerA: string, peerB: string): Promise<string> {
  const [first, second] = [peerA, peerB].sort()
  const base = await globalThis.crypto.subtle.importKey('raw', roomKeyToBytes(roomKey), 'HKDF', false, ['deriveBits'])
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('waveforge-resonance-session'), info: new TextEncoder().encode(`${first}|${second}`) },
    base,
    256,
  )
  return toBase64Url(new Uint8Array(bits))
}
