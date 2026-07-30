import { EnvironmentValidationError, loadRuntimeConfig } from '@shipgate/config'
import { describe, expect, it } from 'vitest'

describe('loadRuntimeConfig', () => {
  it('loads typed defaults', () => {
    const config = loadRuntimeConfig({
      NODE_ENV: 'test',
    })

    expect(config.environment).toBe('test')
    expect(config.api.bodyLimitBytes).toBe(65_536)
    expect(config.database.poolMax).toBe(10)
    expect(config.jobs.concurrency).toBe(4)
  })

  it('rejects invalid pool boundaries', () => {
    expect(() =>
      loadRuntimeConfig({
        DATABASE_POOL_MIN: '10',
        DATABASE_POOL_MAX: '2',
      }),
    ).toThrow(EnvironmentValidationError)
  })
})
