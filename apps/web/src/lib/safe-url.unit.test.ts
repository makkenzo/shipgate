import { describe, expect, it } from 'vitest'

import { toSafeHttpUrl, toSafeSameOriginPath } from './safe-url'

describe('safe URL handling', () => {
  it('allows HTTPS external links and loopback HTTP only', () => {
    expect(toSafeHttpUrl('https://github.com/shipgate')).toBe('https://github.com/shipgate')
    expect(toSafeHttpUrl('http://127.0.0.1:3000/setup')).toBe('http://127.0.0.1:3000/setup')
    expect(toSafeHttpUrl('http://github.com/shipgate')).toBeUndefined()
    expect(toSafeHttpUrl('javascript:alert(1)')).toBeUndefined()
    expect(toSafeHttpUrl('/relative')).toBeUndefined()
  })

  it('keeps browser navigation on the current origin', () => {
    const origin = 'https://shipgate.example'

    expect(toSafeSameOriginPath('/api/v1/auth/github?returnTo=%2Fsetup', origin, '/')).toBe(
      '/api/v1/auth/github?returnTo=%2Fsetup',
    )
    expect(toSafeSameOriginPath('https://evil.example/login', origin, '/login')).toBe('/login')
    expect(toSafeSameOriginPath('//evil.example/login', origin, '/login')).toBe('/login')
    expect(toSafeSameOriginPath('javascript:alert(1)', origin, '/login')).toBe('/login')
  })
})
