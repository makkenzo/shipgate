import { createAes256GcmGitHubTokenCipher, GitHubTokenEncryptionError } from '@shipgate/github'
import { describe, expect, it } from 'vitest'

describe('GitHub token cipher', () => {
  it('binds ciphertext to the user and token purpose', () => {
    const cipher = createAes256GcmGitHubTokenCipher({
      key: Buffer.alloc(32, 3).toString('base64url'),
      keyId: '2026-07',
    })
    const encryptedToken = cipher.encrypt({
      userId: 42,
      purpose: 'refresh',
      token: 'refresh-token',
    })

    expect(
      cipher.decrypt({
        userId: 42,
        purpose: 'refresh',
        encryptedToken,
      }),
    ).toBe('refresh-token')

    expect(() =>
      cipher.decrypt({
        userId: 41,
        purpose: 'refresh',
        encryptedToken,
      }),
    ).toThrow(GitHubTokenEncryptionError)

    expect(() =>
      cipher.decrypt({
        userId: 42,
        purpose: 'access',
        encryptedToken,
      }),
    ).toThrow(GitHubTokenEncryptionError)
  })

  it('rejects encryption keys that are not exactly 256 bits', () => {
    expect(() =>
      createAes256GcmGitHubTokenCipher({
        key: Buffer.alloc(31).toString('base64url'),
      }),
    ).toThrow('exactly 32 bytes')
  })
})
