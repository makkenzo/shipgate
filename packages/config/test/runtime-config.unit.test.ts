import { EnvironmentValidationError, loadRuntimeConfig } from '@shipgate/config'
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
