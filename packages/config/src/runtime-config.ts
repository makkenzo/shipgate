import { z } from 'zod'

import { EnvironmentValidationError } from './errors.js'

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

const databaseSslModeSchema = z.enum(['disable', 'require', 'verify-full'])

const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
)

const runtimeEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    APP_VERSION: z.string().trim().min(1).default('0.0.0'),

    LOG_LEVEL: logLevelSchema.default('info'),

    HOST: z.string().trim().min(1).default('0.0.0.0'),

    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),

    DATABASE_POOL_MIN: z.coerce.number().int().min(0).max(100).default(0),

    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),

    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

    DATABASE_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(0).default(300),

    DATABASE_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).default(2_000),

    DATABASE_SSL_MODE: databaseSslModeSchema.default('disable'),

    GITHUB_APP_ID: optionalString,
  })
  .superRefine((environment, context) => {
    if (environment.DATABASE_POOL_MIN > environment.DATABASE_POOL_MAX) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_POOL_MIN'],
        message: 'DATABASE_POOL_MIN must not exceed DATABASE_POOL_MAX',
      })
    }
  })

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>['NODE_ENV']

export type LogLevel = z.infer<typeof logLevelSchema>

export type DatabaseSslMode = z.infer<typeof databaseSslModeSchema>

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment
  readonly appVersion: string
  readonly logLevel: LogLevel
  readonly shutdownTimeoutMs: number

  readonly api: {
    readonly host: string
    readonly port: number
  }

  readonly database: {
    readonly poolMin: number
    readonly poolMax: number
    readonly idleTimeoutMs: number
    readonly connectionTimeoutMs: number
    readonly maxLifetimeSeconds: number
    readonly readinessTimeoutMs: number
    readonly sslMode: DatabaseSslMode
  }

  readonly github: {
    readonly appId: string | undefined
  }
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const result = runtimeEnvironmentSchema.safeParse(environment)

  if (!result.success) {
    throw new EnvironmentValidationError('runtime', result.error)
  }

  return {
    environment: result.data.NODE_ENV,
    appVersion: result.data.APP_VERSION,
    logLevel: result.data.LOG_LEVEL,
    shutdownTimeoutMs: result.data.SHUTDOWN_TIMEOUT_MS,

    api: {
      host: result.data.HOST,
      port: result.data.PORT,
    },

    database: {
      poolMin: result.data.DATABASE_POOL_MIN,
      poolMax: result.data.DATABASE_POOL_MAX,
      idleTimeoutMs: result.data.DATABASE_IDLE_TIMEOUT_MS,
      connectionTimeoutMs: result.data.DATABASE_CONNECTION_TIMEOUT_MS,
      maxLifetimeSeconds: result.data.DATABASE_MAX_LIFETIME_SECONDS,
      readinessTimeoutMs: result.data.DATABASE_READINESS_TIMEOUT_MS,
      sslMode: result.data.DATABASE_SSL_MODE,
    },

    github: {
      appId: result.data.GITHUB_APP_ID,
    },
  }
}
