import { Buffer } from 'node:buffer'

import { createGitHubOAuthClient, type GitHubOAuthRequestError } from '@shipgate/github/testing'
import { describe, expect, it, vi } from 'vitest'

const now = new Date('2026-07-31T20:00:00.000Z')

function createClient(fetchImplementation: typeof fetch) {
  return createGitHubOAuthClient({
    clientId: 'Iv1.shipgate',
    clientSecret: 'client-secret',
    apiBaseUrl: 'https://api.github.com',
    oauthBaseUrl: 'https://github.com',
    apiVersion: '2026-03-10',
    requestTimeoutMs: 10_000,
    userAgent: 'shipgate/test',
    fetchImplementation,
    now: () => new Date(now),
  })
}

describe('GitHub OAuth client', () => {
  it('exchanges and refreshes expiring token pairs', async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = []
    const fetchImplementation = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({
          url: String(input),
          init: init ?? {},
        })

        return new Response(
          JSON.stringify({
            access_token: 'access-token',
            expires_in: 28_800,
            refresh_token: 'refresh-token',
            refresh_token_expires_in: 15_897_600,
            token_type: 'bearer',
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        )
      },
    ) as typeof fetch
    const client = createClient(fetchImplementation)

    const exchanged = await client.exchangeAuthorizationCode({
      code: 'authorization-code',
      redirectUri: 'https://shipgate.example/api/v1/auth/github/callback',
      codeVerifier: 'a'.repeat(64),
    })
    const refreshed = await client.refreshUserToken('old-refresh-token')

    expect(exchanged).toEqual(refreshed)
    expect(exchanged).toMatchObject({
      accessToken: 'access-token',
      accessTokenExpiresAt: new Date(now.getTime() + 28_800_000),
      refreshToken: 'refresh-token',
      refreshTokenExpiresAt: new Date(now.getTime() + 15_897_600_000),
      tokenType: 'bearer',
    })
    expect(requests.map((request) => request.url)).toEqual([
      'https://github.com/login/oauth/access_token',
      'https://github.com/login/oauth/access_token',
    ])

    const exchangeBody = requests[0]?.init.body
    const refreshBody = requests[1]?.init.body

    expect(exchangeBody).toBeInstanceOf(URLSearchParams)
    expect(String(exchangeBody)).toContain('code=authorization-code')
    expect(String(exchangeBody)).toContain(
      'redirect_uri=https%3A%2F%2Fshipgate.example%2Fapi%2Fv1%2Fauth%2Fgithub%2Fcallback',
    )
    expect(String(exchangeBody)).toContain(`code_verifier=${'a'.repeat(64)}`)
    expect(refreshBody).toBeInstanceOf(URLSearchParams)
    expect(String(refreshBody)).toContain('grant_type=refresh_token')
    expect(String(refreshBody)).toContain('refresh_token=old-refresh-token')
    expect(requests[0]?.init.headers).toMatchObject({
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'shipgate/test',
    })
  })

  it('revokes the GitHub App authorization with client credentials', async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = []
    const fetchImplementation = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({
          url: String(input),
          init: init ?? {},
        })

        return new Response(null, {
          status: 204,
        })
      },
    ) as typeof fetch
    const client = createClient(fetchImplementation)

    await client.revokeUserAuthorization('access-token')

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.github.com/applications/Iv1.shipgate/grant')
    expect(requests[0]?.init).toMatchObject({
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${Buffer.from('Iv1.shipgate:client-secret', 'utf8').toString(
          'base64',
        )}`,
        'content-type': 'application/json',
        'user-agent': 'shipgate/test',
        'x-github-api-version': '2026-03-10',
      },
      body: JSON.stringify({ access_token: 'access-token' }),
    })
  })

  it('preserves GitHub OAuth error details', async () => {
    const client = createClient(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'bad_refresh_token',
              error_description: 'The refresh token is invalid.',
            }),
            {
              status: 400,
              headers: {
                'content-type': 'application/json',
                'x-github-request-id': 'oauth-request-id',
              },
            },
          ),
      ) as typeof fetch,
    )

    await expect(client.refreshUserToken('revoked-token')).rejects.toMatchObject({
      name: 'GitHubOAuthRequestError',
      code: 'bad_refresh_token',
      status: 400,
      requestId: 'oauth-request-id',
    } satisfies Partial<GitHubOAuthRequestError>)
  })

  it('rejects non-expiring or malformed responses', async () => {
    const missingExpiry = createClient(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: 'access-token',
              token_type: 'bearer',
            }),
            {
              status: 200,
            },
          ),
      ) as typeof fetch,
    )

    await expect(
      missingExpiry.exchangeAuthorizationCode({ code: 'authorization-code' }),
    ).rejects.toThrow('missing expiring access-token fields')

    const invalidJson = createClient(
      vi.fn(
        async () =>
          new Response('<html>upstream failure</html>', {
            status: 502,
            headers: {
              'x-github-request-id': 'upstream-request-id',
            },
          }),
      ) as typeof fetch,
    )

    await expect(
      invalidJson.exchangeAuthorizationCode({ code: 'authorization-code' }),
    ).rejects.toMatchObject({
      name: 'GitHubOAuthRequestError',
      status: 502,
      requestId: 'upstream-request-id',
    })
  })
})
