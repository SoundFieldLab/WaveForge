import { describe, expect, it } from 'vitest'
import { isAuthorizedLocalRequest } from '../server/local-service-auth.mjs'

describe('local service authentication', () => {
  it('keeps standalone browser development compatible when no token is configured', () => {
    expect(isAuthorizedLocalRequest({ configuredToken: '', suppliedToken: '' })).toBe(true)
  })

  it('requires the token for health probes in token mode', () => {
    expect(isAuthorizedLocalRequest({ configuredToken: 'secret', suppliedToken: '' })).toBe(false)
    expect(isAuthorizedLocalRequest({ configuredToken: 'secret', suppliedToken: 'secret' })).toBe(true)
  })

  it('rejects missing and incorrect tokens for business routes', () => {
    expect(isAuthorizedLocalRequest({ configuredToken: 'secret', suppliedToken: '' })).toBe(false)
    expect(isAuthorizedLocalRequest({ configuredToken: 'secret', suppliedToken: 'wrong' })).toBe(false)
    expect(isAuthorizedLocalRequest({ configuredToken: 'secret', suppliedToken: 'secret' })).toBe(true)
  })
})
