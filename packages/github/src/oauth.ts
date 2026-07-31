export interface GitHubOAuthToken {
  readonly accessToken: string
  readonly accessTokenExpiresAt: Date
  readonly refreshToken: string
  readonly refreshTokenExpiresAt: Date
  readonly tokenType: 'bearer'
}

export interface GitHubOAuthClient {
  exchangeAuthorizationCode(input: {
    readonly code: string
    readonly redirectUri?: string
  }): Promise<GitHubOAuthToken>

  refreshUserToken(refreshToken: string): Promise<GitHubOAuthToken>
}

export class GitHubOAuthRequestError extends Error {
  readonly code: string | undefined
  readonly status: number | undefined
  readonly requestId: string | undefined

  constructor(
    message: string,
    options: {
      readonly code?: string
      readonly status?: number
      readonly requestId?: string
      readonly cause?: unknown
    } = {},
  ) {
    super(message, {
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    })

    this.name = 'GitHubOAuthRequestError'
    this.code = options.code
    this.status = options.status
    this.requestId = options.requestId
  }
}

export function createGitHubOAuthClient(options: {
  readonly clientId: string
  readonly clientSecret: string
  readonly oauthBaseUrl: string
  readonly requestTimeoutMs: number
  readonly userAgent: string
  readonly fetchImplementation?: typeof fetch
  readonly now?: () => Date
}): GitHubOAuthClient {
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch
  const now = options.now ?? (() => new Date())
  const tokenUrl = new URL('/login/oauth/access_token', options.oauthBaseUrl)

  const requestToken = async (parameters: URLSearchParams): Promise<GitHubOAuthToken> => {
    let response: Response

    try {
      response = await fetchImplementation(tokenUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': options.userAgent,
        },
        body: parameters,
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      })
    } catch (cause) {
      throw new GitHubOAuthRequestError('Unable to reach GitHub OAuth token endpoint', {
        cause,
      })
    }

    const requestId = response.headers.get('x-github-request-id') ?? undefined
    let body: unknown

    try {
      body = parseJson(await response.text())
    } catch (cause) {
      throw new GitHubOAuthRequestError(
        `GitHub OAuth endpoint returned HTTP ${response.status} with invalid JSON`,
        {
          status: response.status,
          ...(requestId !== undefined ? { requestId } : {}),
          cause,
        },
      )
    }

    const errorCode = getStringProperty(body, 'error')
    const errorDescription = getStringProperty(body, 'error_description')

    if (!response.ok || errorCode !== undefined) {
      throw new GitHubOAuthRequestError(
        errorDescription ?? errorCode ?? `GitHub OAuth endpoint returned HTTP ${response.status}`,
        {
          ...(errorCode !== undefined ? { code: errorCode } : {}),
          status: response.status,
          ...(requestId !== undefined ? { requestId } : {}),
        },
      )
    }

    return parseTokenResponse(body, now())
  }

  return {
    async exchangeAuthorizationCode(input) {
      if (input.code.trim().length === 0) {
        throw new GitHubOAuthRequestError('GitHub authorization code must not be empty')
      }

      const parameters = new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code: input.code,
      })

      if (input.redirectUri !== undefined) {
        parameters.set('redirect_uri', input.redirectUri)
      }

      return requestToken(parameters)
    },

    async refreshUserToken(refreshToken) {
      if (refreshToken.length === 0) {
        throw new GitHubOAuthRequestError('GitHub refresh token must not be empty')
      }

      return requestToken(
        new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      )
    },
  }
}

function parseTokenResponse(value: unknown, issuedAt: Date): GitHubOAuthToken {
  if (!isRecord(value)) {
    throw new GitHubOAuthRequestError('GitHub OAuth endpoint returned an invalid response body')
  }

  const accessToken = getStringProperty(value, 'access_token')
  const refreshToken = getStringProperty(value, 'refresh_token')
  const expiresIn = getPositiveIntegerProperty(value, 'expires_in')
  const refreshTokenExpiresIn = getPositiveIntegerProperty(value, 'refresh_token_expires_in')
  const tokenType = getStringProperty(value, 'token_type')

  if (
    !accessToken ||
    !refreshToken ||
    expiresIn === undefined ||
    refreshTokenExpiresIn === undefined ||
    tokenType?.toLowerCase() !== 'bearer'
  ) {
    throw new GitHubOAuthRequestError(
      'GitHub OAuth response is missing expiring access-token fields',
    )
  }

  return {
    accessToken,
    accessTokenExpiresAt: new Date(issuedAt.getTime() + expiresIn * 1_000),
    refreshToken,
    refreshTokenExpiresAt: new Date(issuedAt.getTime() + refreshTokenExpiresIn * 1_000),
    tokenType: 'bearer',
  }
}

function parseJson(value: string): unknown {
  if (value.length === 0) {
    return undefined
  }

  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new GitHubOAuthRequestError('GitHub OAuth endpoint returned invalid JSON', {
      cause,
    })
  }
}

function getStringProperty(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined
}

function getPositiveIntegerProperty(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const property = value[key]

  return Number.isSafeInteger(property) && Number(property) > 0 ? Number(property) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
