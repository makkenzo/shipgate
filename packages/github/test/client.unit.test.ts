import { GitHubAuthenticationError } from '@shipgate/github'
import { createGitHubClient, prepareGitHubRestRequest } from '@shipgate/github/testing'
import { describe, expect, it, vi } from 'vitest'

describe('GitHub client request boundary', () => {
  it('enforces the API target, version, user agent boundary and safe retries', () => {
    const signal = new AbortController().signal
    const prepared = prepareGitHubRestRequest({
      route: 'GET /repos/{owner}/{repo}',
      apiBaseUrl: 'https://api.github.com',
      apiVersion: '2026-03-10',
      parameters: {
        owner: 'shipgate',
        repo: 'shipgate',
        baseUrl: 'https://attacker.example',
        method: 'POST',
        url: 'https://attacker.example/token',
        headers: {
          authorization: 'Bearer stolen',
          accept: 'text/plain',
          'User-Agent': 'override',
          'X-GitHub-Api-Version': '2022-11-28',
          'if-none-match': '"etag"',
        },
        request: {
          fetch: () => undefined,
          retries: 99,
          signal,
        },
      },
    })

    expect(prepared).toEqual({
      route: 'GET /repos/{owner}/{repo}',
      parameters: {
        owner: 'shipgate',
        repo: 'shipgate',
        method: 'GET',
        url: '/repos/{owner}/{repo}',
        baseUrl: 'https://api.github.com',
        headers: {
          'if-none-match': '"etag"',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10',
        },
        request: {
          signal,
        },
      },
    })
  })

  it('does not retry mutations and rejects non-relative routes', () => {
    expect(
      prepareGitHubRestRequest({
        route: 'POST /repos/{owner}/{repo}/pulls',
        apiBaseUrl: 'https://api.github.com',
        apiVersion: '2026-03-10',
      }).parameters,
    ).toMatchObject({
      request: {
        retries: 0,
      },
    })

    for (const route of [
      'GET https://attacker.example/token',
      'GET //attacker.example/token',
      String.raw`GET /\attacker.example/token`,
    ]) {
      expect(() =>
        prepareGitHubRestRequest({
          route,
          apiBaseUrl: 'https://api.github.com',
          apiVersion: '2026-03-10',
        }),
      ).toThrow(GitHubAuthenticationError)
    }
  })

  it.each([401, 403] as const)(
    'reports GitHub %s to the access-cache invalidator',
    async (status) => {
      const onUnauthorized = vi.fn()
      const onAccessFailure = vi.fn()
      const client = createGitHubClient({
        auth: 'user-token',
        authentication: {
          type: 'user',
          userId: 42,
        },
        apiBaseUrl: 'https://api.github.com',
        apiVersion: '2026-03-10',
        requestTimeoutMs: 10_000,
        userAgent: 'shipgate/test',
        fetchImplementation: vi.fn(async () =>
          Response.json(
            {
              message: status === 401 ? 'Bad credentials' : 'Forbidden',
            },
            {
              status,
            },
          ),
        ) as unknown as typeof fetch,
        onUnauthorized,
        onAccessFailure,
      })

      await expect(client.request('GET /user')).rejects.toMatchObject({
        status,
      })

      if (status === 401) {
        expect(onUnauthorized).toHaveBeenCalled()
      } else {
        expect(onUnauthorized).not.toHaveBeenCalled()
      }

      expect(onAccessFailure).toHaveBeenCalledWith({
        status,
        authentication: {
          type: 'user',
          userId: 42,
        },
      })
    },
  )
})
