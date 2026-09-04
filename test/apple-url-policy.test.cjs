'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { isAllowedApplePageUrl, readTextWithLimit, fetchAllowedApplePage } = require('../desktop/apple-url-policy.cjs')

test('Apple profile URL policy rejects non-Apple and non-HTTPS targets', () => {
  assert.equal(isAllowedApplePageUrl('https://music.apple.com/cn/profile/test'), true)
  assert.equal(isAllowedApplePageUrl('https://beta.music.apple.com/profile/test'), true)
  assert.equal(isAllowedApplePageUrl('https://account.apple.com/account/manage'), true)
  assert.equal(isAllowedApplePageUrl('http://music.apple.com/profile'), false)
  assert.equal(isAllowedApplePageUrl('https://music.apple.com.evil.example/profile'), false)
  assert.equal(isAllowedApplePageUrl('https://127.0.0.1/profile'), false)
})

test('Apple profile redirects are validated at every hop', async () => {
  const fetchImpl = async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })
  await assert.rejects(() => fetchAllowedApplePage(fetchImpl, 'https://music.apple.com/profile'), /not allowed/)
})

test('Apple profile response reader enforces a byte limit', async () => {
  const response = new Response('x'.repeat(20), { headers: { 'content-length': '20' } })
  await assert.rejects(() => readTextWithLimit(response, 10), /byte limit/)
})
