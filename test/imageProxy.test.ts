import { describe, expect, it, vi } from 'vitest'
import { canonicalizeImageUrl, createImageProxy, isBlockedIpAddress } from '../server/image-proxy.mjs'

const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }]
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

function imageResponse(body: BodyInit = PNG, init: ResponseInit = {}) {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/png' }, ...init })
}

function mockResponse() {
  const headers = new Map<string, string>()
  const res: any = {
    headersSent: false,
    statusCode: 200,
    body: undefined,
    set: vi.fn((values: Record<string, string>) => {
      for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), String(value))
      return res
    }),
    status: vi.fn((status: number) => {
      res.statusCode = status
      return res
    }),
    send: vi.fn((body: unknown) => {
      res.body = body
      res.headersSent = true
      return res
    }),
    end: vi.fn(() => {
      res.headersSent = true
      return res
    }),
    destroy: vi.fn(),
  }
  return { res, headers }
}

async function request(proxy: ReturnType<typeof createImageProxy>, url: unknown, headers = {}) {
  const response = mockResponse()
  await proxy.handler({ query: { url }, headers }, response.res)
  return response
}

describe('image URL canonicalization and network policy', () => {
  it('precisely unwraps nested local cover URLs into one canonical key', () => {
    const target = 'HTTPS://Example.COM:443/a%2Fb.png?b=2&a=1#fragment'
    const wrapped = `http://localhost:3001/api/cover?devMode=true&url=${encodeURIComponent(target)}`
    const nested = `http://127.0.0.1:3001/api/cover?url=${encodeURIComponent(wrapped)}`
    expect(canonicalizeImageUrl(nested)).toBe('https://example.com/a%2Fb.png?b=2&a=1')
  })

  it('does not unwrap lookalike local URLs or ambiguous wrappers', () => {
    expect(canonicalizeImageUrl('http://localhost:3001/api/covering?url=https://example.com/a.png'))
      .toBe('http://localhost:3001/api/covering?url=https://example.com/a.png')
    expect(() => canonicalizeImageUrl('http://localhost:3001/api/cover?url=https://example.com/a.png&x=1'))
      .toThrow(/Invalid image url/)
  })

  it.each([
    '0.0.0.1', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.31.255.255', '192.0.2.1', '192.168.1.1', '198.18.0.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '::1', 'fc00::1', 'fe80::1', '2001:db8::1',
  ])('blocks non-public address %s', address => {
    expect(isBlockedIpAddress(address)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888'])('allows public address %s', address => {
    expect(isBlockedIpAddress(address)).toBe(false)
  })
})

describe('image proxy pipeline', () => {
  it('shares in-flight work across both compatible handlers', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const fetchImpl = vi.fn(async () => {
      await gate
      return imageResponse()
    })
    const lookup = vi.fn(async () => PUBLIC_IP)
    const proxy = createImageProxy({ fetchImpl, lookup })

    const first = request(proxy, 'https://EXAMPLE.com:443/cover.png#one')
    const second = request(proxy, 'https://example.com/cover.png#two')
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    release()
    const [a, b] = await Promise.all([first, second])

    expect(a.res.statusCode).toBe(200)
    expect(b.res.statusCode).toBe(200)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledOnce()
  })

  it('bounds distinct in-flight requests while preserving same-key deduplication', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const proxy = createImageProxy({
      maxInflight: 1,
      lookup: vi.fn(async () => PUBLIC_IP),
      fetchImpl: vi.fn(async () => {
        await gate
        return imageResponse()
      }),
    })

    const first = request(proxy, 'https://example.com/one.png')
    await vi.waitFor(() => expect(proxy.inFlight.size).toBe(1))
    const duplicate = request(proxy, 'https://example.com/one.png')
    const rejected = await request(proxy, 'https://example.com/two.png')
    expect(rejected.res.statusCode).toBe(503)
    release()
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2)
  })
  it('returns 304 for a matching ETag without refetching', async () => {
    const fetchImpl = vi.fn(async () => imageResponse())
    const lookup = vi.fn(async () => PUBLIC_IP)
    const proxy = createImageProxy({ fetchImpl, lookup })

    const first = await request(proxy, 'https://example.com/cover.png')
    const etag = first.headers.get('etag')
    const second = await request(proxy, 'https://example.com/cover.png', { 'if-none-match': `W/${etag}` })

    expect(first.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(first.headers.get('x-content-type-options')).toBe('nosniff')
    expect(second.res.statusCode).toBe(304)
    expect(second.res.end).toHaveBeenCalledOnce()
    expect(second.headers.has('content-length')).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(lookup).toHaveBeenCalledOnce()
  })


  it('manually validates every redirect hop and blocks private destinations', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    }))
    const lookup = vi.fn(async () => PUBLIC_IP)
    const result = await request(createImageProxy({ fetchImpl, lookup }), 'https://example.com/start')

    expect(result.res.statusCode).toBe(400)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('rejects DNS names if any resolved address is non-public', async () => {
    const lookup = vi.fn(async () => [...PUBLIC_IP, { address: '127.0.0.1', family: 4 }])
    const fetchImpl = vi.fn()
    const result = await request(createImageProxy({ fetchImpl, lookup }), 'https://example.com/image.png')
    expect(result.res.statusCode).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses provider-specific referers for Apple artwork', async () => {
    let headers: HeadersInit | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      headers = init?.headers
      return imageResponse()
    })
    const proxy = createImageProxy({ fetchImpl, lookup: vi.fn(async () => PUBLIC_IP) })
    const result = await request(proxy, 'https://is1-ssl.mzstatic.com/image/thumb/256x256bb.jpg')

    expect(result.res.statusCode).toBe(200)
    expect(headers).toMatchObject({ Referer: 'https://music.apple.com/' })
  })

  it('accepts the image/jpg MIME used by Netease artwork CDN', async () => {
    const proxy = createImageProxy({
      lookup: vi.fn(async () => PUBLIC_IP),
      fetchImpl: vi.fn(async () => imageResponse(PNG, { headers: { 'content-type': 'image/jpg' } })),
    })
    const result = await request(proxy, 'https://p1.music.126.net/cover.jpg?param=64y64')

    expect(result.res.statusCode).toBe(200)
    expect(result.headers.get('content-type')).toBe('image/jpg')
  })

  it('preserves upstream errors instead of returning a 200 placeholder', async () => {
    const proxy = createImageProxy({
      lookup: vi.fn(async () => PUBLIC_IP),
      fetchImpl: vi.fn(async () => new Response('missing', { status: 404 })),
    })
    const result = await request(proxy, 'https://example.com/missing.png')
    expect(result.res.statusCode).toBe(404)
    expect(result.headers.get('content-type')).toContain('text/plain')
    expect(String(result.res.body)).not.toContain('<svg')
  })

  it('enforces MIME and declared/streamed size limits', async () => {
    const lookup = vi.fn(async () => PUBLIC_IP)
    const wrongMime = await request(createImageProxy({
      lookup,
      fetchImpl: vi.fn(async () => new Response('html', { headers: { 'content-type': 'text/html' } })),
    }), 'https://example.com/not-image')
    expect(wrongMime.res.statusCode).toBe(415)

    const svg = await request(createImageProxy({
      lookup,
      fetchImpl: vi.fn(async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'content-type': 'image/svg+xml' } })),
    }), 'https://example.com/vector.svg')
    expect(svg.res.statusCode).toBe(415)

    const tooLarge = await request(createImageProxy({
      lookup,
      maxBytes: 3,
      fetchImpl: vi.fn(async () => imageResponse(PNG, { headers: { 'content-type': 'image/png', 'content-length': '4' } })),
    }), 'https://example.com/large.png')
    expect(tooLarge.res.statusCode).toBe(413)
  })

  it('applies one total timeout to DNS and the response body', async () => {
    const never = () => new Promise<never>(() => {})
    const dnsTimeout = await request(createImageProxy({ lookup: never, fetchImpl: vi.fn(), timeoutMs: 10 }), 'https://example.com/a.png')
    expect(dnsTimeout.res.statusCode).toBe(504)

    const body = new ReadableStream<Uint8Array>({ start() {} })
    const bodyTimeout = await request(createImageProxy({
      lookup: vi.fn(async () => PUBLIC_IP),
      fetchImpl: vi.fn(async () => imageResponse(body)),
      timeoutMs: 10,
    }), 'https://example.com/b.png')
    expect(bodyTimeout.res.statusCode).toBe(504)
  })
})
