import { GitHubAuthenticationError } from '@shipgate/github'
import { prepareGitHubRestRequest } from '@shipgate/github/testing'
import { describe, expect, it } from 'vitest'

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
          retries: 2,
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
})
