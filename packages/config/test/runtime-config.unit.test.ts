import {
  EnvironmentValidationError,
  loadGitHubRuntimeConfig,
  loadGitHubSecrets,
  loadRuntimeConfig,
} from '@shipgate/config'
import { describe, expect, it } from 'vitest'

describe('loadRuntimeConfig', () => {
  it('loads typed defaults', () => {
    const config = loadRuntimeConfig({
      NODE_ENV: 'test',
    })

    expect(config.environment).toBe('test')
    expect(config.api.bodyLimitBytes).toBe(65_536)
    expect(config.api.diagnosticsEnabled).toBe(true)
    expect(config.api.metricsEnabled).toBe(true)
    expect(config.database.poolMax).toBe(10)
    expect(config.jobs.concurrency).toBe(4)
    expect(config.auth.sessionTtlSeconds).toBe(604_800)
    expect(config.auth.oauthAttemptTtlSeconds).toBe(600)
  })

  it('uses secure production defaults for internal HTTP endpoints', () => {
    const config = loadRuntimeConfig({
      NODE_ENV: 'production',
    })

    expect(config.api.docsEnabled).toBe(false)
    expect(config.api.diagnosticsEnabled).toBe(false)
    expect(config.api.metricsEnabled).toBe(false)
  })

  it('accepts explicit internal endpoint configuration', () => {
    const config = loadRuntimeConfig({
      NODE_ENV: 'production',
      API_DIAGNOSTICS_ENABLED: 'true',
      API_METRICS_ENABLED: 'true',
    })

    expect(config.api.diagnosticsEnabled).toBe(true)
    expect(config.api.metricsEnabled).toBe(true)
  })

  it('enables GitHub App startup validation in production', () => {
    const config = loadRuntimeConfig({
      NODE_ENV: 'production',
    })

    expect(config.githubApp.startupValidationEnabled).toBe(true)
    expect(config.githubApp.apiUrl).toBe('https://api.github.com')
    expect(config.githubApp.apiVersion).toBe('2026-03-10')
    expect(config.githubApp.oauthUrl).toBe('https://github.com')
    expect(config.githubApp.tokenEarlyRefreshMs).toBe(300_000)
    expect(config.githubApp.refreshLeaseMs).toBe(60_000)
  })

  it('loads GitHub doctor configuration without database secrets', () => {
    const config = loadGitHubRuntimeConfig({
      APP_ORIGIN: 'https://shipgate.example',
      GITHUB_APP_ID: '123456',
      GITHUB_APP_CLIENT_ID: 'Iv1.shipgate',
      GITHUB_APP_SLUG: 'shipgate-release',
      GITHUB_APP_USER_TOKENS_EXPIRE: 'true',
    })

    expect(config).toMatchObject({
      appOrigin: 'https://shipgate.example',
      appId: 123456,
      clientId: 'Iv1.shipgate',
      slug: 'shipgate-release',
      userTokensExpire: true,
    })
  })

  it('loads GitHub secrets without requiring DATABASE_URL', () => {
    expect(
      loadGitHubSecrets({
        GITHUB_APP_PRIVATE_KEY: 'private-key',
        GITHUB_APP_CLIENT_SECRET: 'client-secret',
        GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret',
        GITHUB_TOKEN_ENCRYPTION_KEY: 'encryption-key',
      }),
    ).toEqual({
      privateKey: 'private-key',
      clientSecret: 'client-secret',
      webhookSecret: 'webhook-secret',
      tokenEncryptionKey: 'encryption-key',
    })
  })

  it('rejects APP_ORIGIN values that are not exact HTTPS origins', () => {
    expect(() =>
      loadGitHubRuntimeConfig({
        APP_ORIGIN: 'https://shipgate.example/path',
      }),
    ).toThrow(EnvironmentValidationError)

    expect(() =>
      loadGitHubRuntimeConfig({
        APP_ORIGIN: 'http://shipgate.example',
      }),
    ).toThrow(EnvironmentValidationError)
  })

  it('rejects an invalid GitHub token encryption key ID', () => {
    expect(() =>
      loadGitHubRuntimeConfig({
        GITHUB_TOKEN_ENCRYPTION_KEY_ID: 'invalid key id',
      }),
    ).toThrow(EnvironmentValidationError)
  })

  it('rejects a refresh lease shorter than three API timeouts', () => {
    expect(() =>
      loadRuntimeConfig({
        GITHUB_API_REQUEST_TIMEOUT_MS: '10000',
        GITHUB_REFRESH_LEASE_MS: '29999',
      }),
    ).toThrow(EnvironmentValidationError)
  })

  it('rejects unsafe auth lifetimes', () => {
    expect(() =>
      loadRuntimeConfig({
        AUTH_SESSION_TTL_SECONDS: '60',
      }),
    ).toThrow(EnvironmentValidationError)

    expect(() =>
      loadRuntimeConfig({
        AUTH_OAUTH_ATTEMPT_TTL_SECONDS: '3600',
      }),
    ).toThrow(EnvironmentValidationError)
  })

  it('rejects invalid pool boundaries', () => {
    expect(() =>
      loadRuntimeConfig({
        DATABASE_POOL_MIN: '10',
        DATABASE_POOL_MAX: '2',
      }),
    ).toThrow(EnvironmentValidationError)
  })

  it('rejects CORS values that are not exact HTTP origins', () => {
    expect(() =>
      loadRuntimeConfig({
        API_CORS_ORIGINS: 'https://shipgate.example/path',
      }),
    ).toThrow(EnvironmentValidationError)
  })
})
