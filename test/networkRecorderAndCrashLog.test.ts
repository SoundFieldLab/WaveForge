import { describe, expect, it, vi, beforeEach } from 'vitest'

// desktop/*.cjs 的纯逻辑单测（vitest 能直接 import cjs）

describe('networkRecorder（连接层记录）', () => {
  // vitest 对动态 require 的 CJS 解构要放在用例外一次性完成
  const { createNetworkRecorder } = require('../desktop/networkRecorder.cjs')

  const setup = ({ now } = {}) => {
    const handlers = new Map()
    const recorder = createNetworkRecorder({
      providerHosts: { qq: ['qq.com'], netease: ['163.com'] },
      channels: {
        subscribe: (n, f) => handlers.set(n, f),
        unsubscribe: (n) => handlers.delete(n),
      },
      now: now ?? (() => { let t = 1000; return () => { t += 10; return t } })(),
    })
    recorder.start()
    return { handlers, recorder }
  }

  const makeRequest = (host, path = '/x') => {
    const listeners = {}
    return {
      host, method: 'POST', path, protocol: 'https:', reusedSocket: false,
      once(n, f) { listeners[n] = f },
      __listeners: listeners,
    }
  }

  const makeSocket = () => {
    const l = {}
    return {
      connecting: true,
      get remoteAddress() { return this.connecting ? null : '203.205.255.1' },
      get remoteFamily() { return this.connecting ? null : 'IPv4' },
      on(n, f) { l[n] = f; return this },
      once(n, f) { l[n] = f; return this },
      __l: l,
    }
  }

  it('记录白名单域名的请求与连接过程（DNS/尝试/远端/TLS）', () => {
    const { handlers, recorder } = setup()
    const req = makeRequest('u.y.qq.com', '/cgi-bin/musicu')
    handlers.get('http.client.request.created')({ request: req })
    const sock = makeSocket()
    req.__listeners.socket(sock)
    sock.__l.lookup(null, '203.205.255.1', 4)
    sock.__l.connectionAttempt('203.205.255.1', 443, 4)
    sock.connecting = false
    sock.__l.connect()
    sock.__l.secureConnect()
    req.__listeners.close()
    handlers.get('http.client.response.finish')({ request: req, response: { statusCode: 200 } })

    const entry = recorder.snapshot('qq')[0]
    expect(entry.host).toBe('u.y.qq.com')
    expect(entry.path).toBe('/cgi-bin/musicu')
    expect(entry.connectMs).toBe(10)
    expect(entry.tlsMs).toBe(20)
    expect(entry.totalMs).toBe(30)
    expect(entry.status).toBe(200)
    expect(entry.remote.address).toBe('203.205.255.1')
    expect(entry.attempts[0].outcome).toBe('connected')
    expect(entry.settled).toBe('response')
  })

  it('白名单外的域名不记录', () => {
    const { handlers, recorder } = setup()
    handlers.get('http.client.request.created')({ request: makeRequest('example.com') })
    expect(recorder.snapshot('qq')).toHaveLength(0)
    expect(recorder.snapshot('netease')).toHaveLength(0)
  })

  it('按 provider 分桶：一个 provider 的请求不挤掉另一个', () => {
    const { handlers, recorder } = setup()
    handlers.get('http.client.request.created')({ request: makeRequest('music.163.com') })
    handlers.get('http.client.request.created')({ request: makeRequest('u.y.qq.com') })
    expect(recorder.snapshot('netease')).toHaveLength(1)
    expect(recorder.snapshot('qq')).toHaveLength(1)
  })

  it('错误发生在哪一层：DNS 成功但连接失败 → tcp', () => {
    const { handlers, recorder } = setup()
    const req = makeRequest('mu.y.qq.com', '/')
    handlers.get('http.client.request.created')({ request: req })
    const sock = makeSocket()
    req.__listeners.socket(sock)
    sock.__l.lookup(null, '203.205.255.1', 4)
    sock.__l.connectionAttempt('203.205.255.1', 443, 4)
    sock.__l.connectionAttemptFailed('203.205.255.1', 443, 4, Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }))
    handlers.get('http.client.request.error')({ request: req, error: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }) })

    const entry = recorder.snapshot('qq')[0]
    expect(entry.error.code).toBe('ETIMEDOUT')
    expect(entry.error.phase).toBe('tcp')
    expect(entry.attempts[0].outcome).toBe('failed')
    expect(entry.settled).toBe('error')
  })

  it('TLS 握手前被断 → phase tls', () => {
    const { handlers, recorder } = setup()
    const req = makeRequest('u.y.qq.com', '/')
    handlers.get('http.client.request.created')({ request: req })
    const sock = makeSocket()
    req.__listeners.socket(sock)
    sock.__l.lookup(null, '1.2.3.4', 4)
    sock.__l.connect()          // TCP 通了
    sock.connecting = false
    handlers.get('http.client.request.error')({ request: req, error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })

    expect(recorder.snapshot('qq')[0].error.phase).toBe('tls')
  })

  it('DNS 失败 → phase dns 且记 dnsError', () => {
    const { handlers, recorder } = setup()
    const req = makeRequest('u.y.qq.com', '/')
    handlers.get('http.client.request.created')({ request: req })
    const sock = makeSocket()
    req.__listeners.socket(sock)
    sock.__l.lookup(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), undefined, undefined)
    handlers.get('http.client.request.error')({ request: req, error: Object.assign(new Error('getaddrinfo ENOTFOUND u.y.qq.com'), { code: 'ENOTFOUND' }) })

    const entry = recorder.snapshot('qq')[0]
    expect(entry.dnsError.code).toBe('ENOTFOUND')
    expect(entry.error.phase).toBe('dns')
  })

  it('stop 之后不再订阅', () => {
    const { handlers, recorder } = setup()
    recorder.stop()
    expect(handlers.size).toBe(0)
  })

  it('环形缓冲：超过 maxEntries 丢最旧', () => {
    const { handlers, recorder } = setup()
    for (let i = 0; i < 70; i += 1) {
      handlers.get('http.client.request.created')({ request: makeRequest('u.y.qq.com', `/${i}`) })
    }
    const all = recorder.snapshot('qq')
    expect(all).toHaveLength(60)
    expect(all[0].path).toBe('/10')
  })
})

describe('crashLog（崩溃日志）', () => {
  const { writeCrashLog } = require('../desktop/crashLog.cjs')
  let dir

  beforeEach(() => {
    dir = `${__dirname}/.tmp-crash-test`
  })

  it('写崩溃文件并修剪旧文件（保留 20 份）', () => {
    // 造 25 份旧文件
    for (let i = 0; i < 25; i += 1) {
      writeCrashLog({ crashDir: dir, kind: 'test', error: new Error(`old-${i}`) })
    }
    const file = writeCrashLog({ crashDir: dir, kind: 'uncaughtException', error: new Error('boom'), extra: { note: 'test' } })
    expect(file).toBeTruthy()
    const fs = require('node:fs')
    const files = fs.readdirSync(dir).filter(n => n.startsWith('crash-'))
    expect(files.length).toBeLessThanOrEqual(20)
    const content = fs.readFileSync(file, 'utf8')
    expect(content).toContain('uncaughtException')
    expect(content).toContain('Error: boom')
    expect(content).toContain('note: test')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('目录不可写时返回 null 而不抛（崩溃路径上不能顶掉原始异常）', () => {
    const result = writeCrashLog({ crashDir: '', kind: 'test', error: new Error('x') })
    expect(result).toBeNull()
  })
})
