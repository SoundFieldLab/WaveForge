import { describe, expect, it } from 'vitest'
import { isAuthorizedLocalRequest } from '../server/local-service-auth.mjs'

describe('local service authentication', () => {
  it('keeps standalone browser development compatible when no token is configured', () => {
    expect(isAuthorizedLocalRequest({ configuredToken: '', suppliedToken: '', path: '/api/search' })).toBe(true)
  })

  it('keeps health probes available in token mode', () => {
    expect(isAuthorizedLocalRequest({ configuredToken: 'secret', suppliedToken: '', path: '/health' })).toBe(true)
  })

  it('rejects missing and incorrect tokens for business routes', () => {
    expect(isAuthorizedLocalRequest({ configuredToken: 'secret', suppliedToken: '', path: '/api/search' })).toBe(false)
    expect(isAuthorizedLocalRequest({ configuredToken: 'secret', suppliedToken: 'wrong', path: '/api/search' })).toBe(false)
    expect(isAuthorizedLocalRequest({ configuredToken: 'secret', suppliedToken: 'secret', path: '/api/search' })).toBe(true)
  })
})
