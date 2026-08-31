import { timingSafeEqual } from 'node:crypto'

export const LOCAL_SERVICE_HEADER = 'x-waveforge-local-token'

export function isAuthorizedLocalRequest({ configuredToken, suppliedToken, path }) {
  if (path === '/health' || !configuredToken) return true
  const expected = Buffer.from(String(configuredToken))
  const supplied = Buffer.from(String(suppliedToken || ''))
  return expected.length === supplied.length && timingSafeEqual(expected, supplied)
}
