import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

const tokenEnvelopeVersion = 'v1'
const initializationVectorLength = 12
const authenticationTagLength = 16

export type GitHubTokenPurpose = 'access' | 'refresh'

export interface GitHubTokenCipher {
  encrypt(input: {
    readonly userId: number
    readonly purpose: GitHubTokenPurpose
    readonly token: string
  }): string

  decrypt(input: {
    readonly userId: number
    readonly purpose: GitHubTokenPurpose
    readonly encryptedToken: string
  }): string
}

export class GitHubTokenEncryptionError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, {
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })

    this.name = 'GitHubTokenEncryptionError'
  }
}

export function createAes256GcmGitHubTokenCipher(options: {
  readonly key: string | Buffer
  readonly keyId?: string
}): GitHubTokenCipher {
  const key = normalizeEncryptionKey(options.key)
  const keyId = options.keyId ?? 'primary'

  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new GitHubTokenEncryptionError(
      'GitHub token encryption key ID must contain only letters, numbers, dot, underscore, or dash',
    )
  }

  return {
    encrypt(input) {
      assertUserId(input.userId)

      if (input.token.length === 0) {
        throw new GitHubTokenEncryptionError('GitHub token must not be empty')
      }

      const initializationVector = randomBytes(initializationVectorLength)
      const cipher = createCipheriv('aes-256-gcm', key, initializationVector, {
        authTagLength: authenticationTagLength,
      })

      cipher.setAAD(createAdditionalAuthenticatedData(input.userId, input.purpose))

      const ciphertext = Buffer.concat([cipher.update(input.token, 'utf8'), cipher.final()])
      const authenticationTag = cipher.getAuthTag()

      return [
        tokenEnvelopeVersion,
        keyId,
        initializationVector.toString('base64url'),
        authenticationTag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.')
    },

    decrypt(input) {
      assertUserId(input.userId)

      const envelope = parseEnvelope(input.encryptedToken)

      if (!constantTimeEqual(envelope.keyId, keyId)) {
        throw new GitHubTokenEncryptionError(
          `GitHub token was encrypted with unknown key ID ${envelope.keyId}`,
        )
      }

      try {
        const decipher = createDecipheriv('aes-256-gcm', key, envelope.initializationVector, {
          authTagLength: authenticationTagLength,
        })

        decipher.setAAD(createAdditionalAuthenticatedData(input.userId, input.purpose))
        decipher.setAuthTag(envelope.authenticationTag)

        return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString(
          'utf8',
        )
      } catch (cause) {
        throw new GitHubTokenEncryptionError('GitHub token ciphertext failed authentication', {
          cause,
        })
      }
    },
  }
}

function normalizeEncryptionKey(value: string | Buffer): Buffer {
  let key: Buffer

  if (Buffer.isBuffer(value)) {
    key = Buffer.from(value)
  } else {
    const encodedKey = value.replace(/^base64:/, '').trim()

    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encodedKey)) {
      throw new GitHubTokenEncryptionError('GITHUB_TOKEN_ENCRYPTION_KEY must be base64url encoded')
    }

    key = Buffer.from(encodedKey, 'base64url')
  }

  if (key.length !== 32) {
    throw new GitHubTokenEncryptionError(
      'GITHUB_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes',
    )
  }

  return key
}

function createAdditionalAuthenticatedData(userId: number, purpose: GitHubTokenPurpose): Buffer {
  return Buffer.from(`shipgate:github-user-token:${userId}:${purpose}`, 'utf8')
}

function parseEnvelope(value: string): {
  readonly keyId: string
  readonly initializationVector: Buffer
  readonly authenticationTag: Buffer
  readonly ciphertext: Buffer
} {
  const segments = value.split('.')

  if (segments.length !== 5) {
    throw new GitHubTokenEncryptionError('GitHub token ciphertext has an invalid envelope')
  }

  const [version, keyId, encodedInitializationVector, encodedAuthenticationTag, encodedCiphertext] =
    segments

  if (
    version !== tokenEnvelopeVersion ||
    !keyId ||
    !encodedInitializationVector ||
    !encodedAuthenticationTag ||
    !encodedCiphertext
  ) {
    throw new GitHubTokenEncryptionError('GitHub token ciphertext has an invalid envelope')
  }

  const initializationVector = Buffer.from(encodedInitializationVector, 'base64url')
  const authenticationTag = Buffer.from(encodedAuthenticationTag, 'base64url')
  const ciphertext = Buffer.from(encodedCiphertext, 'base64url')

  if (
    initializationVector.length !== initializationVectorLength ||
    authenticationTag.length !== authenticationTagLength ||
    ciphertext.length === 0
  ) {
    throw new GitHubTokenEncryptionError('GitHub token ciphertext has invalid binary fields')
  }

  return {
    keyId,
    initializationVector,
    authenticationTag,
    ciphertext,
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)

  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }

  return timingSafeEqual(leftBuffer, rightBuffer)
}

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new GitHubTokenEncryptionError('GitHub user ID must be a positive safe integer')
  }
}
