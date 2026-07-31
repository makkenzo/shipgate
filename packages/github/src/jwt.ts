import { createPrivateKey, type KeyObject, sign } from 'node:crypto'

export class GitHubPrivateKeyError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, {
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })

    this.name = 'GitHubPrivateKeyError'
  }
}

export function loadGitHubAppPrivateKey(value: string): KeyObject {
  const normalizedValue = normalizePrivateKey(value)

  let key: KeyObject

  try {
    key = createPrivateKey(normalizedValue)
  } catch (cause) {
    throw new GitHubPrivateKeyError('GITHUB_APP_PRIVATE_KEY is not a valid PEM private key', {
      cause,
    })
  }

  if (key.type !== 'private') {
    throw new GitHubPrivateKeyError('GITHUB_APP_PRIVATE_KEY does not contain a private key')
  }

  if (key.asymmetricKeyType !== 'rsa') {
    throw new GitHubPrivateKeyError(
      'GITHUB_APP_PRIVATE_KEY must contain a standard RSA private key for RS256',
    )
  }

  return key
}

export interface GitHubAppJwtCredential {
  readonly token: string
  readonly issuedAt: Date
  readonly expiresAt: Date
}

export function createGitHubAppJwt(options: {
  readonly appId: number
  readonly privateKey: KeyObject
  readonly now?: Date
}): string {
  return createGitHubAppJwtCredential(options).token
}

export function createGitHubAppJwtCredential(options: {
  readonly appId: number
  readonly privateKey: KeyObject
  readonly now?: Date
}): GitHubAppJwtCredential {
  const now = options.now ?? new Date()
  const nowSeconds = Math.floor(now.getTime() / 1_000)

  const header = encodeJson({
    alg: 'RS256',
    typ: 'JWT',
  })

  const payload = encodeJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: String(options.appId),
  })

  const unsignedToken = `${header}.${payload}`

  let signature: Buffer

  try {
    signature = sign('RSA-SHA256', Buffer.from(unsignedToken), options.privateKey)
  } catch (cause) {
    throw new GitHubPrivateKeyError('Unable to sign a GitHub App JWT with the private key', {
      cause,
    })
  }

  return {
    token: `${unsignedToken}.${signature.toString('base64url')}`,
    issuedAt: new Date((nowSeconds - 60) * 1_000),
    expiresAt: new Date((nowSeconds + 9 * 60) * 1_000),
  }
}

function normalizePrivateKey(value: string): string {
  const trimmed = value.trim()

  /*
   * Docker/CI secrets are often supplied as a single line with escaped
   * newlines. Only expand those escapes when no real newline is present.
   */
  return trimmed.includes('\n') ? trimmed : trimmed.replaceAll('\\n', '\n')
}

function encodeJson(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
